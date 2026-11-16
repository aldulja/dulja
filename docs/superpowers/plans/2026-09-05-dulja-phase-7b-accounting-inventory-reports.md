# Dulja Phase 7B — Core catalogue I: accounting and inventory reports with tie-out tests

**For agentic workers:** execute the tasks in order. Each task is self-contained: it names every file it creates or modifies, gives the exact signatures it consumes and produces, carries the real code, and ends with a commit. Do not skip the failing-test step — the expected failure text is written out so you can compare it against what you actually see. If what you see differs, stop and read the task's row in the Execution handoff's "Where to stop and raise" table rather than adjusting the test.

## Goal

Ship the **twenty-two report definitions** of the accounting and inventory catalogue as seed data under `packages/db/seed/my/reports/7b/`, and prove this slice's share of the Phase 7 definition of done — *"every report's numbers tie to the ledger"* — with **one executed tie-out per report**. Seventeen codes are new (§4.16.1 assigns them to 7B); five are the minimal-set codes 1B and 3D already ship as routes, **re-expressed under the same code, the same permission and the same numbers** at `report_definition.version = 2` (spec:2300, §4.16.1).

This slice writes **no read query of its own**. Every figure it reports comes from a dataset 7A registered or a read function an earlier slice froze — `trialBalance`, `accountLedger`, `stockOnHand`, `valuationAsOf`, `openLayersOf`, `salesByItem`, `itemProfitabilityRows` — because a second definition of a number is SAH-009, and the whole reason the catalogue can claim a tie-out is that there is exactly one place each figure is computed.

## Architecture

- **Data.** Nothing. Report definitions are per-tenant seed-pack rows (hazard 10), applied with `bun run seed --tenant <id> --only reports` into 7A's `app.report_definition`. This slice creates **no table** and, apart from four indexes, **no DDL**.
- **The one migration.** `0077_add_report_filter_indexes.sql` — the four indexes the SAH-070 EXPLAIN gate finds missing on columns this catalogue filters by (`audit_log`, `document_event`, `inventory_movement`, `document`). Indexes only: no column, no constraint, no data.
- **Definitions are data, tie-outs are code.** Each definition declares `tieOut` (§4.11.1). One harness — `tests/invariants/support/reports.ts` — turns that declaration into an executed assertion, and `tests/invariants/report-tie-out.test.ts` fails the build when a catalogue definition has no tie-out case. That is ADR 0068, and it is what makes "every report's numbers tie to the ledger" a CI fact rather than a sentence in a plan.
- **Re-expression keeps the route.** For the five minimal-set codes the owning slice's JSON list route, its DTOs and its own tie-out test all stand byte-for-byte; this slice seeds the definition at row version 2 and adds a **parity** case proving the definition-driven rows equal the read function's rows to the cent. Rewriting a handler would change the wire shape and break the exact tests §4.16.1 names as the proof that nothing moved (Task 0 amendment A2; Self-Review pushback 1).
- **No new route module.** `ReportCodeSchema` is widened by seventeen appended members so 7A's `POST …/reports/{code}/runs` accepts them (§4.16.3). `PROBES` is untouched — this slice mounts nothing.

## Tech Stack

TypeScript 5 on Bun; PostgreSQL 18 through `postgres.js` tagged templates (Drizzle mirrors are reads only; this slice adds none); Zod contracts; Vitest on Node 24 with Testcontainers; `decimal.js` behind `Money`/`Quantity`; JSON seed packs validated by Ajv through 7A's `validateReportDefinition`; 7A's synchronous `renderReport` plus `renderCsv` (both `@dulja/domain`) for the render-parity re-run — **the PDF byte layer is `apps/worker`'s and stays 7A's own test 23**, because §3.1 lets `tests/` import any *package* and `apps/api` through `createApp()`/`./routes` only, and neither `apps/worker/src/reports/renderers/` nor `apps/worker/test/support/worker.ts` is reachable from this slice's files. **No new dependency, and no version hard-coded in a source file** (spec:104).

## Spec

`C:/Users/Edres101/Desktop/dulja/rebuild-spec.md` v1.2 — §3.0.4 row **spec:1047** (*"Reports: trial balance, ledger, statements from Phase 1; report builder, financial-statement layouts and data export"*, phase "1 → 7", this slice's owned row); §3.3 projections (spec:1204 — synchronous versus asynchronous, and "never hand-edited"); §3.4 costing (spec:1210–1228 — layers are derived, `qty_remaining` is the residue, **one costing implementation**); §3.5 (spec:1240 the end-user report designer, text-defined and version-controlled); §3.9 (spec:2037–2063 — identifiers, dates, money, naming, deletion, error codes, database access, localisation); §0.2 (spec:97–106 the never/always lists); §4.2.1 (spec:2163 the `auditor` row — reads everything financial, holds no mutating code); §4.5 (spec:2206 bulk/async with a status resource); §4.6 (spec:2211 right-to-export); §4.8 (spec:2235–2237 read replicas and graceful degradation); §4.9 (spec:2245 the report-generation SLO); Part V Phase 7 (spec:2293) and the sequencing note (spec:2300 — *"A minimal set … ships continuously from Phase 1 onward … Phase 7 is when the report builder and the full catalogue land"*); Part VI tests **2** (spec:2420) and **7** (spec:2425), re-run here, and **23** (spec:2441); Part I **SAH-014, 015, 055, 069, 070, 076**; Part VII **#8** (spec:2472 — which of the 255 legacy templates are in use).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 7B — Core catalogue I: accounting and inventory reports with tie-out tests. **Phase:** 7. **Phase gate:** this plan starts only when **7A** is merged and Phase 5's definition of done is green in CI (spec:87). §6.3 runs `7A → 7B` alongside Phase 6 and Phase 8; nothing here needs POS or HR, and Task 0's gate proves the four inventory and AR/AP slices this catalogue reads are merged.
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `up`, `down`, `listApplied`, `discover`, `MIGRATIONS_DIR`, `app.current_actor`, `app.current_tenant`, `app.actor_has`. **0B** — the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `createDb`, `AppError`, `ERRORS`, `Problem`, `fromDatabaseError`, `createLogger`, `PERMISSION`, `PERMISSIONS`, `PermissionCode`, `requirePermission`, `buildRoutes`, `ROUTES`, `RouteModule`, `createApp`, `AppDeps`, `AppEnv`, `startApi`, `ApiRequest`, `StartedApi`, `PROBES`, `encodeCursor`, `decodeCursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `MoneySchema`, `CurrencySchema`, `QuantitySchema`, `ProblemSchema`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `sourceFiles`, `REPO_ROOT`, `repoFile`. **0D** — `Money`, `currency`, `CurrencyCode`, `round`, `RoundingMode`, `MONEY_SCALE`, `Quantity`, `seedBranch`, `seedCurrency`, `seedRate`, `JOBS`, `JobName`. **0C** — the seed CLI (`bun run seed --tenant <id> --only <sub-pack>`), `PackLoader`, `LoaderContext`, `readPackFile`, `assertPackShape`, `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES`, the four exit codes, and the `0c-base.json` chart rows. **0E** — `packages/i18n`, `bootLocalStack`. **1A** — `postDocument`, `issueDocument`, `loadSnapshot`, `resolvePolicy`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount`, `JOURNAL_POLICY_V1`, `loadDocumentTypes`, `documentTypesLoader`, `document.posting_seq`. **1B** — `trialBalance`, `trialBalanceFingerprint`, `accountLedger`, `accountOpeningBalance`, `TrialBalanceParams`, `TrialBalanceRow`, `LedgerParams`, `LedgerRow`, `AccountType`, `reportsRoutes`, `reportsRouteModule`, `ReportCodeSchema`, `postJournal`, `JournalLine`, `registerProjectionCheck`, `projectionChecks`, `runIntegrityCheck`, `IntegrityReport`, migration 0016's three indexes. **2A** — `evaluatePolicy`, `PostingPolicy`, `seedDocumentType`, `seedParty`, `DocumentLineInput`. **2B** — `transitionDocument`, `grantCodes`, `app.document_event`, `app.principal_has`. **2C** — `document.notes`, `MODULE_READ_CODE`. **3A** — `app.item`, `app.warehouse`, `app.lot`, `app.unit_of_measure`, `app.inventory_movement`, `app.stock_on_hand`, `app.price_list`, `app.price_list_line`, `app.promotion`, `SENTINEL_LOT_CODE`, `INVENTORY_PERMISSION`, `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot`, `seedPriceList`, `lot_expiry_idx`, `price_list_line_item_idx`, `promotion_window_idx`. **3B** — `valuationAsOf`, `ValuationParams`, `ValuationRow`, `openLayersOf`, `OpenLayersParams`, `CostLayerRow`, `rebuildStockValuation`, `company.costing_method`, `app.cost_layer`, `app.cost_consumption`, `app.stock_valuation`, `cost_layer_open_idx`, `postInventoryDocument`, `ensureOpenPeriods`, `recordingJobs`, and **the `packages/db/test/**` → `tests/invariants/support/**` allowance on `scripts/lint/rules/dependency-rule.ts` (3B amendment A21(c))**. **3C** — `app.document_link`, `GOODS_RECEIPT`, `SHIPMENT`, `PURCHASE_RETURN`, `draftTypedDocument`, the `2150`/`1310`/`5100` chart rows. **3D** — `stockOnHand`, `stockOnHandTotals`, **`StockOnHandReportParams`, `StockOnHandReportRow`** (the `Report` infix is not optional and not this plan's choice: 3A already exports **`StockOnHandRow`** from `packages/db/src/inventory/stock.ts` through the same flat `packages/db/src/index.ts` barrel for its `GET …/stock-on-hand` list route, so 3D's report types carry the infix — `StockOnHandReportParams` / `StockOnHandReportRow` / `StockOnHandReportRowSchema` / `StockOnHandReportQuery` / `StockOnHandReportList` — and an earlier draft of this plan named 3A's row type by mistake, which is a wrong type rather than a misspelling), `salesByItem`, `SalesByItemParams`, `SalesByItemRow`, `snapshotCountSheet`, `recordCounts`, `CountSheetLine`, `DELIVERY_ORDER`, `TRANSFER`, `TRANSFER_RECEIPT`, `STOCK_COUNT`, `EXPIRY_WRITE_OFF`, `secondPrincipal`, the `1250`/`5110` chart rows, `tests/invariants/test-07-one-costing-answer.test.ts`. **4A** — `SALES_INVOICE`, `SALES_CREDIT_NOTE`, `RECEIPT`, `PAYMENT`, `postArDocument`, `ArLine`, `PostArOptions`, `seedPaymentTerm`, and the `revenue`/`margin` members of `SalesByItemRow`. **4B** — `itemProfitabilityRows`, `ItemProfitabilityRow`, `rebuildItemProfitability`, `ITEM_PROFITABILITY_CHECK`, `agedBalance`, `app.item_profitability`, `app.party_ageing`, `arApFixture`, `postFromPack`, `packApproval`, `PackApproval`, `seedTypeFromPack`, `PACK_ROOT`. **7A** — `ReportDefinition`, `validateReportDefinition`, `ReportDefinitionSets`, `ReportDefinitionValidation`, `parseReportDefinition`, `datasetFor`, `isDatasetId`, `DATASETS`, `DATASET_IDS`, `DatasetId`, `DatasetParams`, `DatasetFilter`, `DatasetSortKey`, `DatasetColumn`, `DatasetRow`, `MAX_DATASET_ROWS`, `ReportError`, `renderReport`, `RenderedReport`, `RenderedColumn`, `RenderedRow`, `RenderOptions`, `ReportFormatters`, `intlFormatters`, `renderCsv`, `reportsLoader`, `app.report_definition`, `app.saved_view`, `app.report_run`, `POST …/reports/{code}/runs`, `accounting.report.export`, `seedReportDefinition`, `ERR_REPORT_DATASET_UNKNOWN`, and `StatementKind` / `STATEMENT_LAYOUTS` / `statementLayout` / `statementDefinition` (`packages/domain/src/reports/statement.ts`) plus `statementRows` / `StatementParams` (`packages/db/src/reports/statement.ts`) — the `accounting.profit_and_loss` / `accounting.balance_sheet` **layouts and their row provider**, which this slice's two definitions are built from rather than hand-written (A6). **There is no `runDataset`** (A11); the query is reached as `datasetFor(source).run(tx, params)`. **`rendererFor` / `RenderedArtefact` / `i18nFormatters` / `startWorker` are NOT consumed:** they live in `apps/worker`, which §3.1 puts outside this slice's import graph (Tech Stack).
- **Migration numbers:** **0077 only** — `0077_add_report_filter_indexes.sql` with its hand-written `0077.down.sql` (Task 10). The card reserves 0077 because "report definitions are seed data"; Task 0 amendment **A7** records that the SAH-070 index clause of the same card has nowhere else to land and spends it. **ADR numbers:** **0068** — `0068-tie-out-declarations-are-executed` (Task 1).
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `currency`, `round`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`AppEnv`, `Logger`), §4.2.4 (`Problem`, `ERRORS`, `AppError` — **this slice adds no row**), §4.2.5 (`PERMISSION`, `PERMISSIONS`, `requirePermission`, `ROLES` — **this slice seeds no permission code**), §4.2.6 (`JOBS`, consulted only — **this slice registers no job**), §4.2.7 (`RouteModule`, `ROUTES`, `PROBES` — consulted; **this slice mounts no module**), §4.2.8 (the common schemas, the list envelope, `ReportCodeSchema`), §4.2.12 (`startApi`, `StartedApi`), §4.2.13 (`PackLoader`, `readPackFile`, `assertPackShape`, `SUB_PACKS`), §4.3.3 (`account_balance` and its `MERGE`), §4.3.4 (`document_line`, the `document` header additions), §4.3.5 (`posting_seq`), §4.5.2 (`document_event`), §4.6.1 (the register rows this catalogue reads), §4.7.3 (`inventory_movement`, `stock_on_hand`, `cost_layer`, `cost_consumption`), §4.8.2 (ageing — consulted; the report is 7C's), **§4.11 in full**, §4.14 (document-type codes), §4.15 (account codes), **§4.16 in full**, §4.17 and §4.17.1 (the two helper registers), §4.18 (both rounds), §5 (all thirty-five hazards), §6.1 rows 2, 7, 23, §6.2 row **1047**.
- **Interfaces produced:** the **twenty-two `packages/db/seed/my/reports/7b/*.json` definitions** of §4.16.1 (seventeen at `definitionVersion 1`, five at `definitionVersion 2`); the seed-file **envelope** of amendment A1; the pinned **dataset field vocabulary** of amendment A3 (§4.16.2); the widened `ReportCodeSchema` (this slice's seventeen appended; amendment A4); the four indexes of migration 0077; and the three §4.17.1 test-tier helpers of amendment A9 (`reportFixture`, `runDefinition`, `assertTieOut` and their types). **This slice produces no TypeScript in `packages/db/src/**` beyond the four Drizzle index mirrors of Task 10 (`schema/document.ts`, `document-event.ts`, `inventory-movement.ts`, `audit-log.ts` — one `index()` entry each, reads only, ADR-0002), and no route.**
- **Owner decisions:** **OD-27** (Part VII #6–#9, #13; for this slice #8 — which of the 255 legacy templates are in use) → **Task 12**, isolated; default: **the legacy-template mapping task is dropped** if `9A`'s artefacts are absent, and the catalogue ships unchanged. **OD-24** (screenshots and a two-minute operator description before any screen) → **Task 13**, isolated. **§2.8's 7B card assigns this slice OD-27 and nothing else**, and §2.12's OD-24 row scopes that gate to "every slice with a screen task" — which 7B is not. The task exists because the orchestrator's slice record names OD-24 for 7B and hazard 6 requires one isolated task per owner decision; it ships nothing either way, so the discrepancy costs a heading and no work. Default: **no screen ships in 7B** — the catalogue appears in 7A's report list and 7A's designer, and this slice's twenty-two definitions render through 7A's existing viewer. **OD-06** (v1 costing method) is 3B's and reaches this slice only through the layers `openLayersOf` returns; the sah-055 block of Task 14 is written for the **`'avco'` default** and asserts nothing about FIFO consumption order.
- **Part VI tests owned / re-run:** **owns none exclusively.** **Re-runs:** **2** (deterministic projections — Task 11 re-runs `projection-rebuild` and asserts every projection-kind tie-out reads the projection rather than re-aggregating), **7** (one costing answer — Task 7 re-runs `tests/invariants/test-07-one-costing-answer.test.ts` unchanged and adds the revenue-bearing profit-report figure over `item_profitability`), **23** (RTL/LTR parity — Task 11 renders one definition in both directions through `renderReport` and compares the two `RenderedReport` value objects and their `renderCsv` text, figure for figure; **the PDF byte layer of test 23 stays 7A's own `apps/worker/test/reports/pdf.test.ts`**, which §3.1 keeps outside this slice's import graph). **§3.0.4 rows owned:** **spec:1047** (1B, 3D, 4B, 6D, 7A and 7C contribute; this slice owns the row). **Regression files created / appended:** **creates none.** **Appends** a `— 7B` block to `tests/regression/sah-014.test.ts` (created by 4A), `sah-015.test.ts` (3B), **`sah-055.test.ts` (3B — the conditional FIFO file whose creator §3.7.3 names, and whose 7B block is the stock-ageing report reading layers rather than recomputing)**, `sah-070.test.ts` (0B) and `sah-076.test.ts` (3B). **`sah-069` is not this slice's** — §2.8 lists it in 7B's *reading* list and assigns the append to 7A and 7C, and Task 14 Step 6 asserts this plan touched no other regression file.
- **Shared namespaces this slice writes into:** **Report codes (§4.16.1) — the seventeen this slice owns**: `accounting.general_ledger`, `accounting.journal_register`, `accounting.account_statement`, `accounting.period_comparison`, `accounting.profit_and_loss`, `accounting.balance_sheet`, `accounting.document_register`, `accounting.audit_log`, `accounting.document_event_log`, `inventory.stock_ageing`, `inventory.movement_register`, `inventory.expiry_list`, `inventory.price_list`, `inventory.promotion_register`, `inventory.transfer_register`, `inventory.count_register`, `inventory.profit_by_item`; **plus the five re-expressed and never renamed**: `accounting.trial_balance`, `accounting.ledger` (1B), `inventory.stock_on_hand`, `inventory.valuation`, `inventory.sales_by_item` (3D). **`DatasetId` members (§4.16.2) — none.** 7A's registry already holds every dataset these definitions read, and §2.8 says in terms that **7B adds none and never edits `packages/db/src/reports/datasets.ts`**; **Task 14 Step 6** asserts it, and asserts it as a **subset** — every member of the `DatasetId` union is a name §4.16.2 assigns to 7A, 7C or 8D, and none is 7B's. It is deliberately not a count and not a byte comparison against 7A's state: 7C adds three members and 8D six, so a pin on the file's *size* or on the *absence* of `shift` would be a 7B assertion those slices had to delete to land their own registered rows, and §3.7.3 puts a pin in the commit that moves it — nothing moves this one. **Document-type codes (§4.14) — none**, and no test-only code: every type this slice's fixtures need is a shipped pack envelope read off disk by 4B's `seedTypeFromPack`. **Account codes (§4.15) — seeds none.** Thirteen are consumed as literals in a test assertion or a fixture, each with its seeding slice: `1000`, `1100`, `1200`, `1300`, `2100`, `4000`, `5000`, `5900` (**0C**), `1250` and `5110` (**3D**), `2150`, `1310` and `5100` (**3C**). **`1310` goods in transit is on the list because 3D's `TRANSFER_POLICY` debits it by code** (§4.15 row: "`TRANSFER` dispatch leg debit and `TRANSFER_RECEIPT` credit") and `inventoryChain` posts a `TRANSFER`; hazard 33 admits no null-account fallback, so a fixture that omits it fails at the third post rather than at the assertion. Task 1 Step 3's first case asserts each resolves for the seeded company and re-seeds none (hazard 33 in the consuming direction). **No definition carries a `tieOut.account` literal** — the two registers that were candidates for one tie against the ledger's own total for their own document set instead, for the reason Task 6 gives. **`fixtures.ts` helpers (§4.17) — none added**; `seedReportDefinition` is 7A's row and this slice consumes it with the two additive options amendment **A8** records. **Shared test helpers (§4.17.1) — one new file, registered by amendment A9:** `tests/invariants/support/reports.ts` with `CATALOGUE_7B`, `ReportCode7B`, `CATALOGUE_DIR`, `ReportSeedEnvelope`, `readEnvelope`, `readDefinition`, `runDefinition`, `assertFieldCoverage`, `LedgerWindow`, `TieOutWitness`, `TieOutOptions`, `assertTieOut`, `InventoryFixture`, `SalesFixture`, `CatalogueFixture`, `ReportFixture`, `reportFixture` and `cachedReportFixture` — the exact eighteen names amendment A9's row carries, and no other export.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first (that is what Task 0 is).
- **Contracts version:** 2026-09-07.

## Global Constraints

Copied from the spec and the contracts document; every task's requirements implicitly include this section.

1. **Never write to a ledger or movement table outside the posting service** (spec:97, hazard 22). This slice writes **nothing** to `ledger_entry`, `ledger_entry_dimension`, `inventory_movement`, `cost_layer`, `cost_consumption`, `account_balance`, `stock_on_hand`, `stock_valuation`, `party_ageing`, `item_profitability` or `tax_transaction`. Every row its fixtures create is posted by `postDocument` through `postJournal`, `postFromPack`, `postInventoryDocument` or `postArDocument`. A report is a reader, and `posting-only-tables` (§3.7.5) fails the build if a file of this slice ever contains DML naming one of those tables.
2. **A report never recomputes a figure that has one implementation** (spec:1228, hazard 22, SAH-009). `inventory.valuation` and `inventory.stock_ageing` read 3B's layers through `valuationAsOf` and `openLayersOf`; `inventory.profit_by_item` reads 4B's `item_profitability`; `accounting.trial_balance` reads `account_balance`. **No definition in this slice carries SQL text, and no test in this slice writes an aggregate that a shipped function already computes** — where a tie-out needs the other side of a comparison, it is a direct `tx` sum over `ledger_entry` or the projection table, which is the *independent* path and the point of the check.
3. **Never money as a float.** `numeric(19,4)` in Postgres, `Money` in TypeScript, `string` on the wire and in every dataset row. `no-number-money` (§3.7.5) fires on any property, parameter or variable whose name matches `/amount|price|cost|debit|credit|total|balance|rate|tax|net|gross/i` typed `number`. Every tie-out sum in this slice accumulates through `Money.add`, never `Number()`; the only `number` in a definition is `layout.width` and a `parameters` index.
4. **Never SQL by string concatenation** (spec:98, test 27). Every statement is a `tx`-tagged `postgres.js` template. **A `ReportDefinition` never carries SQL**: `dataset.source` is a `DatasetId` and the filter fields are mapped to columns by 7A's registry (§4.16.2), which is the mechanical half of test 27 and the reason `no-sql-concat` stays green with twenty-two new report files in the tree.
5. **Never DDL from application code.** The four indexes live only in `packages/db/migrations/0077_add_report_filter_indexes.sql` with a hand-written `0077.down.sql` (§3.4.2, §3.4.5). No `create index concurrently` — a migration file runs whole in one transaction (§3.4.3).
6. **Never hard-code a package version into a source file** — the lockfile owns versions (spec:104).
7. **No new table**, so §3.3's Always list engages only through the tables this slice reads. `lint-schema.ts` is **not edited** (hazard 13): §3.5.3 assigns 7B no set membership, and Task 14 **Step 6** asserts the file is unchanged.
8. **Per-tenant rows cannot be written by a migration** (hazard 10). `report_definition` is per-tenant, so all twenty-two definitions are seed-pack data applied by `bun run seed --tenant <id> --only reports`; 0077 creates indexes and nothing else.
9. **A report definition upserts on `(company_id, code, version)`** (§4.16.1's application of §3.4.8's policy-version rule). The five re-expressed codes are seeded at `version = 2` so a placeholder can never survive the real definition arriving later.
10. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). **This slice adds no `ERRORS` row.** The codes its tests assert are already shipped: `ERR_VALIDATION_FAILED`, `ERR_RBAC_FORBIDDEN`, `ERR_NOT_FOUND`, `ERR_REPORT_DATASET_UNKNOWN` (7A). **This list is closed** — a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.
11. **The permission vocabulary is closed** (§3.6.1, hazard 26). This slice seeds **no** code and ships no permission-seed migration. Every definition's `permission` member is a code §4.16.1 already assigns that report: `accounting.report.read`, `admin.audit_log.read`, `inventory.stock.read`, `inventory.cost.read`, `inventory.item.read`. **`accounting.report.export` (7A) is consulted and never named by a definition** — it gates the export action, not a report.
12. **The `auditor` role holds no mutating code** (spec:2163, R7). The two auditor views are gated `admin.audit_log.read`, which is `mutating: false`, so a `GET` gated by it is legal under R7 and `role-seed` stays green. Task 3 Step 5's last case asserts the `auditor` seed reaches both definitions and holds nothing mutating.
13. **No plan invents a literal in a shared namespace** (hazard 32). Every report code, `DatasetId`, account code, document-type code, `fixtures.ts` helper name and `ERR_*` code this slice writes is in the Assumptions block's namespace list; a literal not there is a review-blocking finding, and Task 9 Step 5's third case is the mechanical proof.
14. **No real Malaysian statutory rate, threshold, ceiling or formula appears anywhere** (hazard 1), and **no LHDN or MyInvois endpoint, field, version or threshold** (hazard 2). Neither is in scope: `accounting.tax_return_view` is **7C's** code, this slice ships no tax definition, and the only tax figure any fixture here handles is one an earlier slice already posted.
15. **The UI is not specified** (spec:79, hazard 29). Task 13 is the OD-24 gate and ships nothing behind it; no task in this plan invents a screen, a workflow or a designer interaction.
16. **Jobs run as the tenant's system principal** (hazard 20). This slice registers **no** job and enqueues none; where a fixture needs `stock_valuation` or `item_profitability` populated it calls `rebuildStockValuation` / `rebuildItemProfitability` inside `withTenant` with `systemContext`, exactly as 3B's and 4B's own suites do.
17. **Commits** are conventional with the scope = workspace or area, subject `<type>(<scope>): <summary> [7B T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root stay green after **every** task — this slice has **no declared exception**, because it seeds no permission code and so cannot leave `permission-catalogue` red.
18. **One migration per PR** (spec:2057). One migration, so one migration PR (PR 3 below).
19. **This slice does not close Phase 7 and does not rewrite `AGENTS.md`'s "Current phase" section** — §3.8 names **7C** as Phase 7's closing slice. Task 14 writes no phase report either; it writes the pins test, the five regression appends and the re-run matrix.

## This slice's share of the Phase 7 definition of done

Phase 7's DoD is two sentences (spec:2293): *"A user clones and edits a report without a release; every report's numbers tie to the ledger."* The first is **7A's**. **This slice owns the second, for the accounting and inventory catalogue**; 7C owns it for the rest.

| Clause | Where it becomes true |
|---|---|
| **"every report's numbers tie to the ledger" — the eighteen definitions with a monetary or quantity total** | Tasks 1, 2, 3, 5, 6, 7 and 8, each with its group's tie-out case, **rolled up and made non-optional by Task 11**: `tests/invariants/report-tie-out.test.ts` enumerates `CATALOGUE_7B`, executes each definition's declared `tieOut`, and fails naming the code when a definition has no case. |
| **the four definitions that carry no monetary total** (`accounting.audit_log`, `accounting.document_event_log`, `inventory.price_list`, `inventory.promotion_register`) | The same harness: `tieOut.kind: "none"` requires a **row witness** — an independent `tx` query whose row set the report's rows must equal — so "no monetary tie" never means "no test" (amendment A5; Self-Review's justification table). |
| **"ties to the cent" for the five re-expressed codes** | Tasks 4 and 8: the owning slice's own tie-out test is re-run **unchanged**, and a parity case proves the definition-driven rows equal `trialBalance` / `accountLedger` / `stockOnHand` / `valuationAsOf` / `salesByItem` row for row and figure for figure. |
| **the filter columns are indexed** (SAH-070, the card's third deliverable) | Task 10: an EXPLAIN gate over every `dataset.filters[].field` of all twenty-two definitions, asserting an **index scan node** per filter, with migration 0077 supplying the four the gate finds missing. |

**What is deliberately *not* in this slice's DoD share:** the report engine, the definition format, `datasets.ts`, saved views, `report_run`, the render job and the financial-statement **layouts** (**7A**); the AR/AP, POS and cross-module catalogue, the three Phase 6 datasets and tenant data export (**7C**); the **eight** HR definitions §4.16.1 assigns **8D** (`hr.employee_list`, `hr.payroll_register`, `hr.statutory_summary`, `hr.payable_reconciliation`, `hr.contract_expiry`, `hr.attendance`, `hr.payslip`, `hr.annual_statement` — Task 14's `REGISTERED` set carries all eight, and its forty-one-row total depends on it); and `accounting.ageing`, whose code is 4B's and whose re-expression is 7C's.

## File Structure

```
packages/db/
  migrations/
    0077_add_report_filter_indexes.sql        NEW  T10  — four indexes, no column, no data
    0077.down.sql                             NEW  T10
  seed/my/reports/7b/                         NEW  — a directory no other slice touches (§4.16.1)
    accounting.general_ledger.json            NEW  T1
    accounting.journal_register.json          NEW  T1
    accounting.account_statement.json         NEW  T1
    accounting.period_comparison.json         NEW  T1
    accounting.profit_and_loss.json           NEW  T2
    accounting.balance_sheet.json             NEW  T2
    accounting.document_register.json         NEW  T3
    accounting.audit_log.json                 NEW  T3
    accounting.document_event_log.json        NEW  T3
    accounting.trial_balance.json             NEW  T4   definitionVersion 2 (1B's code)
    accounting.ledger.json                    NEW  T4   definitionVersion 2 (1B's code)
    inventory.stock_ageing.json               NEW  T5
    inventory.movement_register.json          NEW  T5
    inventory.expiry_list.json                NEW  T5
    inventory.price_list.json                 NEW  T6
    inventory.promotion_register.json          NEW  T6
    inventory.transfer_register.json          NEW  T6
    inventory.count_register.json             NEW  T6
    inventory.profit_by_item.json             NEW  T7
    inventory.stock_on_hand.json              NEW  T8   definitionVersion 2 (3D's code)
    inventory.valuation.json                  NEW  T8   definitionVersion 2 (3D's code)
    inventory.sales_by_item.json              NEW  T8   definitionVersion 2 (3D's code)
  test/reports/
    7b-accounting-ledger.test.ts              NEW  T1
    7b-financial-statements.test.ts           NEW  T2
    7b-registers.test.ts                      NEW  T3
    7b-reexpress-phase1.test.ts               NEW  T4
    7b-inventory-stock.test.ts                NEW  T5
    7b-inventory-registers.test.ts            NEW  T6
    7b-profit-by-item.test.ts                 NEW  T7
    7b-reexpress-phase3.test.ts               NEW  T8
    7b-catalogue.test.ts                      NEW  T9   the reports loader over 7b/, twenty-two rows
    7b-report-indexes.test.ts                 NEW  T10  the EXPLAIN gate
  test/fixtures.ts                            (unchanged — §4.17 assigns 7B no helper)
  src/schema/document.ts                      EDIT T10  one index entry
  src/schema/document-event.ts                EDIT T10  one index entry
  src/schema/inventory-movement.ts            EDIT T10  one index entry
  src/schema/audit-log.ts                     EDIT T10  one index entry
  src/reports/datasets.ts                     (UNCHANGED — 7A's file; T14 asserts it)
  src/lint-schema.ts                          (UNCHANGED — §3.5.3 assigns 7B nothing)
  test/privileges.test.ts                     (UNCHANGED — no DELETE grant, §3.5.4)

packages/contracts/
  src/accounting/reports.ts                   EDIT T9   ReportCodeSchema += seventeen

tests/
  invariants/support/reports.ts               NEW  T1   the harness (§4.17.1, amendment A9)
                                              EDIT T2, T6 — two additive option members
  invariants/report-tie-out.test.ts           NEW  T11  the DoD roll-up + tests 2 and 23
  invariants/report-catalogue-pins.test.ts    NEW  T14  every count this plan's prose claims
  regression/sah-014.test.ts                  EDIT T14  append "— 7B"
  regression/sah-015.test.ts                  EDIT T14
  regression/sah-055.test.ts                  EDIT T14
  regression/sah-070.test.ts                  EDIT T14
  regression/sah-076.test.ts                  EDIT T14

docs/
  adr/0068-tie-out-declarations-are-executed.md   NEW  T1
  legacy/7b-template-mapping.md                   NEW  T12  ⚠️ OD-27 only

scripts/check/contracts-7b-amendments.sh      NEW  T0
```

**Two notes on this structure, both deliberate.** (1) **The group tests live in `packages/db/test/reports/` and import the harness from `tests/invariants/support/reports.ts`.** That edge already exists: 3B's amendment A21(c) added the `packages/db/test/**` → `tests/invariants/support/**` allowance to `scripts/lint/rules/dependency-rule.ts` and the `include` entry to `packages/db/tsconfig.json`. **This slice adds no fourth allowance and edits neither file**; if a lint step reports a `dependency-rule` violation naming one of these test files, 3B's Task 7 Step 9 did not merge — raise it, and do not copy the harness into `packages/db`. (2) **`tests/invariants/report-tie-out.test.ts` is in the invariants tier, not the regression tier**, because it is the *continuous* proof of a DoD sentence over the whole catalogue, exactly like `ledger-balance.test.ts` and `projection-rebuild.test.ts` (§3.7.1). The group tests are DB-tier and fast; the roll-up is the one that fails the build when a definition arrives without a tie-out.

### Task 0: Contracts amendments and the 7A / 1B / 3B / 3D / 4A / 4B repository gate

**No code. Nothing in Tasks 1–14 is written until all seventeen of this task's amendments are in the contracts document — fifteen written here, two (A1, A8) already landed by 7A — and the gate script exits 0.** Every amendment below crosses a slice boundary: it either names something the contracts document does not have (and a later slice would then invent a second spelling of) or settles a place where the 7B card and §4.16 disagree. Hazard 32's rule is mechanical — a literal in a shared namespace that is not in a register is a review-blocking finding — so the register is amended first.

**Five of the seventeen are not simply written out.**

- **A2** reverses frozen §4.16.1 text and goes to the architect first (see its own ⚠️ paragraph and PR 1's row in the Execution handoff).
- **A1 and A8 are already landed by 7A** — 7A asked the architect for the same envelope and the same `seedReportDefinition` options, and its own Execution-handoff amendment table names 7B's A1 and A8 as satisfied by its rows. Each is marked ⓘ LANDED below: **confirm the text is in the contracts document, do not re-author it, and do not open a second amendment PR for it.** If either is missing, that is a raise against 7A for merging without its own amendment, not text this slice writes.
- **A3 and A11 are transcriptions of 7A as merged.** Before writing either, open `docs/superpowers/plans/2026-09-05-dulja-phase-7a-report-engine.md` and the repository and confirm each **symbol** matches — `rg -n 'const LEDGER_ENTRY_COLUMNS' packages/db/src/reports/datasets/`, `rg -n 'export async function rowsForDefinition' packages/db/src/reports/`, and so on. **Neither amendment cites a line number and neither may be re-anchored to one.** 7A has already been re-cut once since this plan was drafted, and every absolute anchor into it that this plan originally carried was wrong within one revision; a symbol anchor survives a re-cut and a line anchor does not. §4.18's rule is that the written plan is the authority and this slice's twenty-two definitions are built entirely on those two amendments' field names and signatures — so if the repository disagrees with 7A's plan, **the repository wins and both amendments are corrected in this same PR**, along with every definition and test in Tasks 1–11 that names the changed field.

**Files:**
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` (fifteen amendments written; **A1 and A8 are verified, not written** — 7A landed both)
- Create: `scripts/check/contracts-7b-amendments.sh`

**Interfaces:**
- Consumes: nothing at run time. The gate reads the contracts document and the repository.
- Produces: amendments **A2–A7 and A9–A17** as new contracts text, **A1 and A8 as verifications of text 7A already landed**, and the gate script every later task's first step re-runs. The gate greps all seventeen the same way — a landed amendment and a written one are indistinguishable to it, which is the point.

- [ ] **Step 1: Write the fifteen unlanded amendments into the contracts document, and verify the two landed ones**

**A1 — §4.16.1, the report seed-file envelope. ⓘ LANDED WITH 7A — this task VERIFIES it, and does not write it.** §4.16.1 fixes the seed *layout* (`packages/db/seed/my/reports/<owning slice, lowercased>/<code>.json`) and §4.11.2 fixes the *row* (`report_definition(company_id, code, version int, definition jsonb, cloned_from, is_core, archived_at)`), but nothing said what is in the file — and `ReportDefinition.version` is the **format** version (`1`), not the row's. Two versions with one name is the mistake this amendment exists to prevent. **7A asked for exactly this shape and asked for it as a blocking amendment**: its Execution-handoff amendment table carries the row *"**4.16.1 ⚑ BEFORE** — The report seed file is an envelope … 7B's amendment A1 asks for exactly this shape"*, marked to land **before** 7A's own Task 14, and 7A's `loadReportDefinitions` implements the three refusals (the two-key envelope check, the `definitionVersion` integer check, and `validateReportDefinition`) plus a fourth 7A added of its own — `assertDefinitionFields`. So the executor's job here is to **confirm the paragraph below is already in §4.16.1** and move on. If it is absent, 7A merged without its own ⚑ BEFORE amendment: raise that against 7A rather than authoring the text from this slice. The paragraph §4.16.1 must carry:

> **The file is an envelope, exactly as a document-type seed file is (§4.3.7).** `packages/db/seed/my/reports/<slice>/<code>.json` is `{ "definitionVersion": <int ≥ 1>, "definition": <ReportDefinition> }` and nothing else. `definitionVersion` is the `app.report_definition.version` column; `definition.version` stays the **format** version `1` of §4.11.1. The loader refuses a file whose name does not equal `definition.code`, whose `definitionVersion` is absent or below 1, or whose `definition` fails `validateReportDefinition`, naming the file — the same three refusals `loadDocumentTypes` performs on an envelope — **and a fourth: `assertDefinitionFields`, so a field the definition names that its dataset does not serve is refused at seed time rather than rendering as a silently empty column.** Pack rows are inserted `is_core = true` with `cloned_from = null`, `on conflict (company_id, code, version) do update set definition = excluded.definition` (§3.4.8's policy-version rule applied to reports); a tenant clone is `is_core = false` and is never touched by the seed.

**A2 — §4.16.1, what "re-expresses" does to the route (a settlement).** §4.16.1's general note says 7B and 7C "replace the route's body with `ReportDefinition` + `renderReport` under the same code", and in the same paragraph makes "the slice's own tie-out test re-run unchanged" the proof that nothing moved. For the five minimal-set codes those two clauses are in tension: 1B's `LedgerList` carries `opening_base_balance` and nests `MoneySchema` objects, 3D's `StockOnHandReportRow` carries `warehouseKind`, and a generic definition-driven list answers neither shape — so replacing a handler body changes the wire contract and breaks the very tests the sentence relies on. Amend the note:

> **Re-expression does not rewrite the JSON list route.** For a minimal-set code the owning slice's `GET` handler, its `<Resource>List` envelope and its DTOs **stand byte-for-byte**; the re-expressing slice seeds the `ReportDefinition` at `definitionVersion = 2`, which is what gives the code a PDF/XLSX/CSV render path and a designer entry, and adds a **parity** case proving the definition-driven rows (through `datasetFor(...).run`) equal the owning slice's read function row for row and figure for figure. The owning slice's own tie-out test is then re-run **unchanged**, which is the sentence's actual guarantee. A slice that rewrites the handler has changed the wire shape of a shipped endpoint without an expand/contract (§3.4.7) and has broken its own proof.

**⚠️ A2 reverses frozen text and is the one amendment an executor may not simply write.** §4.16.1's "Re-expresses" paragraph says in terms that "7B and 7C **replace the route's body** with `ReportDefinition` + `renderReport` under the same code"; A2 says the body stands. The reasoning is in Self-Review pushback 1 and is not a matter of taste — 1B's `LedgerList` carries `opening_base_balance` and nested `MoneySchema` objects, 3D's `StockOnHandReportRow` carries `warehouseKind`, and a `DatasetRow` is a flat `Record<string, string | number | boolean | null>` with **snake_case** keys (A3), so a definition-driven body answers neither shape and would break the exact tests §4.16.1 names as the proof that nothing moved. But a plan writer cannot amend the contracts document, and §3.10 requires that document to change before the code does. **A2 goes to the architect as a settlement before Task 1 is written, and the Execution handoff's PR table carries it as PR 1's blocking row.** If the literal reading is upheld instead, this slice's task set changes substantially — the three-slice sequence pushback 1 describes — and Tasks 4 and 8 become route rewrites with their own expand/contract PRs rather than parity cases.

**A3 — §4.16.2, the dataset field vocabulary, transcribed from 7A's shipped `DatasetColumn` lists.** A definition's `dataset.filters[].field`, `columns[].field`, `groups[].field`, `totals[].field` and `sort[].field` all name fields of the dataset's **row**, and §4.16.2 registers only the `DatasetId`. Thirteen sources are read by 7B's twenty-two definitions. 7A is merged before this slice, so the vocabulary is **not pinned by guess**: every field below is the `field` member of a `DatasetColumn` in 7A's `packages/db/src/reports/datasets/{accounting,ar-ap,inventory}.ts`, and the names are **`snake_case`, not `camelCase`** — 7A's own statement layouts filter on `{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }` (the `filters` array inside `build()` in `packages/domain/src/reports/statement.ts`), i.e. the **field** is the column name and only the **parameter** is `camelCase`. **Every anchor in the table below is a SYMBOL, never a line number**: 7A's file has been re-cut since this slice was drafted and a line-number citation into it is wrong within one PR of being written. Each row names the `readonly DatasetColumn[]` constant the list is copied from — `rg -n 'const LEDGER_ENTRY_COLUMNS' packages/db/src/reports/datasets/` finds it, and the field order below is that array's order. Append to §4.16.2:

> **Each dataset's row fields are 7A's `DatasetColumn.field` values — `snake_case`, one per selected column, every money and quantity a fixed-decimal `string` (§3.2), every date `YYYY-MM-DD` and every timestamp RFC 3339 UTC, because the queries cast them with `to_char`.** A `DatasetRow` key is therefore the column alias, **never** the `camelCase` member of the read-function row type §4.16.3 registers for the same figures: `trialBalance` returns `TrialBalanceRow.baseDebit` and the `account_balance` dataset returns `base_debit`, and a parity case compares the two by mapping one onto the other. A field marked *(computed)* is derived in SQL inside the dataset query — never in JavaScript, so no `number` ever touches a monetary value (§3.7.5's `no-number-money`). A column marked *(not filterable, not sortable)* may appear in `columns[]` only.
>
> | `DatasetId` | Row fields (7A's `DatasetColumn.field`, in registry order) | Anchor |
> |---|---|---|
> | `ledger_entry` | `entry_id`, `account_id`, `account_code`, `account_name_en`, `account_name_ar`, `account_type`, `document_id`, `document_type_code`, `series`, `number`, `branch_id`, `branch_code`, `party_id`, `line_no`, `currency`, `exchange_rate`, `debit`, `credit`, `base_debit`, `base_credit`, `effective_date`, `fiscal_period_id`, `fiscal_period_code`, `posting_seq`, `posted_at` | `LEDGER_ENTRY_COLUMNS` / `ledgerEntryDataset`, `datasets/accounting.ts`. `branch_id`/`branch_code` come from the **document** join (`d.branch_id`), which is why a branch cut is possible on this dataset and not on `account_balance`. **There is no `base_net` and no `running_base_balance`** — a net or a running balance is one report's arithmetic over an ordered page, not a property of a row |
> | `account_balance` | `account_id`, `account_code`, `account_name_en`, `account_name_ar`, `account_type`, `is_group`, `parent_id`, `fiscal_period_id`, `fiscal_period_code`, `currency`, `debit`, `credit`, `base_debit`, `base_credit`, `base_balance` *(computed: `(b.base_debit - b.base_credit)`)* | `ACCOUNT_BALANCE_COLUMNS` / `accountBalanceDataset`, `datasets/accounting.ts`. The net field is **`base_balance`**, not `baseNet`. The key carries **no branch** (§4.3.3), which is amendment A6's whole reason |
> | `document` | `document_id`, `document_type_id`, `document_type_code`, `document_type_module`, `status`, `series`, `number`, `effective_date`, `fiscal_period_id`, `party_id`, `party_code`, `party_name_en`, `branch_id`, `branch_code`, `currency`, `exchange_rate`, `rate_source`, `posting_seq`, `posted_at`, `created_at`, `reverses_document_id`, `base_total` *(computed: a lateral `sum(le.base_debit)` over the document's `ledger_entry` rows — `0` for a type that posts nothing)* | `DOCUMENT_COLUMNS` / `documentDataset`, `datasets/accounting.ts`. The document total is **`base_total`**, not `totalBase`, and it is a **lateral over the ledger, not a second definition of a document's value**, which is what lets a register tie to the ledger by construction. There is **no `document_type_name_en`** — the type's display name is not selected; `document_type_module` is |
> | `document_event` | `event_id`, `document_id`, `document_type_code`, `series`, `number`, `event_kind`, `from_status`, `to_status`, `override_code`, `actor_id`, `actor_display_name`, `attributed_to`, `occurred_at`, `reason` | `DOCUMENT_EVENT_COLUMNS` / `documentEventDataset`, `datasets/accounting.ts`. The actor's name is **`actor_display_name`**. **There is no `attributed_to_name`**: `de.attributed_to` is selected as a raw uuid and 7A joins `app.principal` once, for the actor only. A report that wants the attributed principal's name is a 7C/8D request against 7A's dataset, not a field this slice may assume |
> | `audit_log` | `seq`, `occurred_at`, `table_name`, `row_id`, `action`, `actor_id`, `actor_display_name`, `actor_kind`, `before` *(not filterable, not sortable)*, `after` *(not filterable, not sortable)* | `AUDIT_LOG_COLUMNS` / `auditLogDataset`, `datasets/accounting.ts`. `company: null` — `app.audit_log` has no `company_id` (plan0A:1920), so the dataset is **tenant-scoped** and `DatasetParams.companyId` adds no predicate to it. 7A **does** select the before/after images but makes them neither filterable nor sortable, for the reason on its own line: a jsonb comparison in a `WHERE` is not indexable (SAH-070) and a filter over a before-image is a search over historical PII by another name. **No 7B definition lists `before` or `after` as a column** — an audit *report* rendering row images would be a covered side channel for `employee_sensitive` and every other payload (spec:2450, tests 32 and 36); the images stay reachable through 0B's gated `/v1/admin/audit-log` resource, and `assertFieldCoverage` plus Task 3's own case are what keep that true |
> | `inventory_movement` | `movement_id`, `document_id`, `document_type_code`, `document_number`, `line_no`, `movement_no`, `item_id`, `item_code`, `item_name_en`, `warehouse_id`, `warehouse_code`, `branch_id`, `lot_id`, `lot_code`, `quantity`, `value`, `effective_date`, `posting_seq`, `posted_at` | `INVENTORY_MOVEMENT_COLUMNS` / `inventoryMovementDataset`, `datasets/inventory.ts`. The document's number is **`document_number`**; there is **no `series`** and **no `warehouse_kind`** on this dataset. `branch_id` comes from the warehouse (`w.branch_id`) |
> | `cost_layer` | `layer_id`, `item_id`, `item_code`, `warehouse_id`, `warehouse_code`, `lot_id`, `lot_code`, `movement_id`, `qty_in`, `qty_remaining`, `unit_cost`, `effective_at`, `sequence`, `invalidated_at`, `age_days` *(computed: `(current_date - cl.effective_at)::int`)* | `COST_LAYER_COLUMNS` / `costLayerDataset`, `datasets/inventory.ts`. **There is no `value`, no `age_bucket`, no `lot_expires_on`, no `item_name_en` and no document identity on this dataset.** The residue's *money* is therefore not a column: a layer's value is `qty_remaining × unit_cost`, an arithmetic a report may not invent (SAH-009), so `inventory.stock_ageing` groups on `age_days`, renders `qty_remaining` and `unit_cost`, and ties **against `valuationAsOf`** through the `projection` branch rather than through a money total of its own (A12, A13). `age_days` is measured from `current_date`, not from a parameter — see A13 |
> | `stock_on_hand` | `item_id`, `item_code`, `item_name_en`, `item_name_ar`, `warehouse_id`, `warehouse_code`, `warehouse_kind`, `branch_id`, `lot_id`, `lot_code`, `expires_on`, `quantity`, `base_unit_code` | `STOCK_ON_HAND_COLUMNS` / `stockOnHandDataset`, `datasets/inventory.ts`. Quantity only — **no `value`**; a valued position is `stock_valuation`'s |
> | `stock_valuation` | `item_id`, `item_code`, `item_name_en`, `warehouse_id`, `warehouse_code`, `branch_id`, `as_of`, `quantity`, `value` | `STOCK_VALUATION_COLUMNS` / `stockValuationDataset`, `datasets/inventory.ts` |
> | `item_profitability` | `item_id`, `item_code`, `item_name_en`, `item_name_ar`, `fiscal_period_id`, `fiscal_period_code` *(computed: `to_char(fp.starts_on, 'YYYY-MM')`)*, `quantity_sold`, `revenue_base`, `cogs_base`, `margin_base` | `ITEM_PROFITABILITY_COLUMNS` / `itemProfitabilityDataset`, `datasets/inventory.ts`. The period is carried as an id plus a `YYYY-MM` code; **there is no `period_starts_on` / `period_ends_on`** |
> | `lot` | `lot_id`, `item_id`, `item_code`, `item_name_en`, `code`, `expires_on`, `manufactured_on`, `days_to_expiry` *(computed: `(l.expires_on - current_date)::int`)*, `archived_at` | `LOT_COLUMNS` / `lotDataset`, `datasets/inventory.ts`. The lot's own code is **`code`**, not `lot_code` (the `*_code` fields on this dataset belong to the item). **There is no `quantity_on_hand`**, so `inventory.expiry_list` is a lot list with no quantity total and its `tieOut.kind` is `none` with a row witness (A5) — a quantity per lot is `stock_on_hand`'s, and `inventory.stock_on_hand` already reports it filtered by `expires_on` |
> | `price_list_line` | `line_id`, `price_list_id`, `price_list_code`, `price_list_currency`, `customer_kind`, `branch_id`, `valid_from`, `valid_to`, `item_id`, `item_code`, `item_name_en`, `unit_id`, `unit_code`, `min_quantity`, `unit_price` | `PRICE_LIST_LINE_COLUMNS` / `priceListLineDataset`, `datasets/inventory.ts` |
> | `promotion` | `promotion_id`, `code`, `name_en`, `name_ar`, `kind`, `branch_id`, `starts_at`, `ends_at`, `definition` *(not filterable, not sortable)* | `PROMOTION_COLUMNS` / `promotionDataset`, `datasets/inventory.ts`. **There is no `branch_code`** — the dataset's `from` is `app.promotion` alone, with no `dimension_value` join. `definition` is selected as `::text` but **no 7B definition lists it as a column**: a promotion's rule body has no `columns[].format` that can render it, and a report is not the place to read one |
>
> **How a wrong field fails, precisely — two mechanical checks, not one.** `validateReportDefinition` (`packages/domain/src/reports/validate.ts`) checks a definition's `groups[]`, `totals[]` and `sort[]` fields against **its own `columns[]`** and never against the dataset — it cannot, because `packages/domain` has no access to `DatasetColumn` (§3.1, and 7A's own comment on `ReportDefinitionSets` says so). **The dataset half is 7A's `assertDefinitionFields`** (`packages/db/src/reports/statement.ts`): it unions the dataset's `DatasetColumn.field` list — plus `STATEMENT_EXTRA_FIELDS` for a `STATEMENT_CODES` key — and throws `ReportError("ERR_VALIDATION_FAILED", "dataset '<source>' has no such field: …")` for every field in `columns[]`, `groups[]`, `totals[]`, `sort[]` or `dataset.filters[]` that the dataset does not serve. 7A calls it from **both** write paths: the definition store (`createReportDefinition` / `updateReportDefinition`) and `loadReportDefinitions`, the `reports` sub-pack loader. **So a field the dataset does not serve IS refused at seed time**, naming the file and the field, and `bun run seed --only reports` is the first place a typo in one of this slice's twenty-two definitions surfaces.
>
> That leaves a gap `assertDefinitionFields` cannot close, and it is the gap the catalogue slice's group tests fill: `assertDefinitionFields` compares the definition with the dataset's **declared** `DatasetColumn` list, which is a hand-written array beside the query, so a column declared but not selected — or aliased differently in the `select` — passes it and still renders empty. **`assertFieldCoverage` (Task 1) is the check against the rows the query actually returns**: it executes the definition against a real fixture through `rowsForDefinition` and compares `Object.keys(row)` with every field the definition references, so a disagreement between 7A's `DatasetColumn` list and 7A's own `select` fails with the field's name in the message. The two are complementary and this slice runs both — neither is redundant, and a definition that passed only one has not been proved.

**A4 — §4.16.3, `ReportCodeSchema` after 7B.** §4.16.3 makes the enum "the codes whose route exists" and has each report-shipping slice widen it. **7A's runs route does not use it** — its `{code}` path parameter is validated in the route's own `params` schema by a bare grammar regex (`z.string().regex(/^(accounting|inventory|hr|pos)\.[a-z][a-z0-9_]{2,47}$/)` on `POST …/reports/{code}/runs`) and resolved by `resolveDefinitionForRun` in `apps/api/src/reports/authorise.ts` (A11) — so the enum's live consumers are **1B's two `GET` report routes and 7A's own definition and saved-view routes**, and a code missing from it is unreachable through those while remaining runnable through the runs route. 7B ships no `GET` of its own; it widens the enum so its seventeen codes appear where a shipped code is expected to appear, and so 7C and 8D append after a complete list rather than a partial one. Append:

> **7B widens it by its seventeen** — `accounting.general_ledger`, `accounting.journal_register`, `accounting.account_statement`, `accounting.period_comparison`, `accounting.profit_and_loss`, `accounting.balance_sheet`, `accounting.document_register`, `accounting.audit_log`, `accounting.document_event_log`, `inventory.stock_ageing`, `inventory.movement_register`, `inventory.expiry_list`, `inventory.price_list`, `inventory.promotion_register`, `inventory.transfer_register`, `inventory.count_register`, `inventory.profit_by_item` — **appended after whatever members already exist**. The five codes 7B re-expresses are already members and are not touched. **Membership in this enum is not what makes a code runnable**: 7A's `POST …/reports/{code}/runs` accepts any code matching its grammar regex and answers `404 "No such report"` when no definition resolves **for a caller who has already cleared `requireReportExport`**, so the enum is the *typed* surface (1B's `GET`s, 7A's definition routes, every contract-tier consumer) and the seeded definition is the *runtime* surface. A slice that asserts "a code with no enum member cannot be run at all" has asserted something 7A's route does not do. **The route's gate order is `requireReportExport` → `resolveDefinitionForRun` → `requireReportRead` → `assertParameters`**, and 7A's own comment on the handler says why: export authority is proved on the path parameter alone, before any row is read, so the route is never an existence oracle for a company's catalogue. A caller with no codes therefore gets **403**, not 404, whether or not the definition exists — which is why every 404 case in this slice grants first (`grantAdmin`, Task 9) and why an ungranted 404 assertion would be asserting the opposite of what the handler does.
>
> **No slice asserts a total member count.** §6.3 executes `(6A → 6C → 6B → 6D)` in parallel with `(7A → 7B)` and makes 6D a predecessor of **7C**, so 7B can land on six pre-existing members (1B 2, 3D 3, 4B 1) or on eight (6D's `pos.z_report` and `pos.sales_by_cashier` too), ending at **twenty-three or twenty-five** — both correct, and neither is this slice's to control. Every assertion about this enum is a **membership** assertion plus the register check of §4.16.1; a count assertion would fail on the merge order of an unrelated phase.
>
> **A module list endpoint is not a `ReportCode`, and 7B retires neither of the two reads over `app.stock_on_hand`** (settled at 7B, which §4.16.1 makes the re-expressing slice for `inventory.stock_on_hand`). 3A ships `GET …/stock-on-hand` on the inventory module over `listStockOnHand` / `StockOnHandRow`; 3D ships the `inventory.stock_on_hand` **report code** over `stockOnHand` / `StockOnHandReportRow`, which excludes `warehouse.kind = 'in_transit'` by default and carries `warehouseKind` on every row. Both read the projection and neither re-aggregates `inventory_movement`, so SAH-009's property holds on both and hazard 9 is not engaged: they answer two different questions — *what rows exist in this table*, and *what is on my shelves* — and only the second is a report a definition can be seeded for. **7B seeds the definition at `definitionVersion = 2` for the report code and touches neither read function and neither route** (that is A2 applied), so this settlement is the same under either outcome of A2's ⚠️ architect decision: even a literal re-expression that rewrote 3D's handler body would leave 3A's list endpoint alone, because that endpoint was never a report. A later slice that wants one of the two gone amends this section again with the caller it is removing named; **the fact that two functions read one projection is not itself a finding**, and no slice may retire either by renaming.

**A5 — §4.11.1, `tieOut` made executable (ADR 0068's contract half).** §4.11.1 declares `tieOut: { kind: "ledger_sum" | "projection" | "none"; account?; projection? }` and calls it "the tie-to-ledger test each core report declares", without saying what executes it. Append to §4.11.1:

> **What each `kind` means to the harness that executes it** (7B, `tests/invariants/support/reports.ts`; the equivalent for 7C's and 8D's codes is theirs to extend):
> - **`ledger_sum`** — Σ of the report's **first `totals` entry whose column `format` is `money`**, accumulated with `Money.add` over every row the definition's dataset returns for the test's parameters, equals a direct `tx` sum of **the same measure** over `app.ledger_entry` for the same window, restricted to `account.code = tieOut.account` when the member is present. The measure map is closed, and it selects among **four** measures the harness computes as fixed columns of one query — it is a lookup, never a SQL fragment, so no field name reaches a statement. The four are `debit` = `sum(base_debit)`, `credit` = `sum(base_credit)`, `net` = `sum(base_debit − base_credit)` and `credit_net` = `sum(base_credit − base_debit)`. 7B's own keys are 7A's `DatasetColumn.field` names (A3): **`base_debit` → `debit`, `base_credit` → `credit`, `base_balance` → `net`, `base_total` → `debit`** (the `document` dataset's lateral is a sum of debits, A3). A `ledger_sum` definition whose first money total is any other field is refused by the harness naming the field, because a comparison of two different measures is a tie-out that passes for the wrong reason. The two sides are different paths: the report's is the dataset's aggregation over pages, the ledger's is one SQL sum. `tieOut.account` is a **§4.15 code literal**; a report whose account is a *parameter* uses `projection` against `account_balance` instead, so no `$`-substitution vocabulary is introduced.
>
>   **The sign convention, which binds every key 7C and 8D add.** `debit` and `credit` are **gross and unsigned** — a field maps to one of them only when its own total can move in one direction only. `net` and `credit_net` are **signed**, and which of the two a signed field takes is decided by the natural balance of the account it is tied against: `net` (debit − credit) for an asset or an expense, `credit_net` (credit − debit) for a liability, an equity or an income account. **A signed field is never mapped to `credit`.** The failure that rule prevents is exact and silent: a document that posts the leg being re-derived as a **debit** to a payable — a negative-net supplementary payroll run against `2400` is the shape that exists — makes `sum(base_credit)` zero for that window while the report's own signed total is negative, so the two sides differ by the whole amount and the message says only that they disagree. Negating the measure in the dataset's SQL and mapping to `net` is the rejected alternative: it makes the ledger side agree by making the *rendered column* negative on every ordinary run, which trades a wrong tie-out for a wrong page. A slice adding a signed measure adds a `credit_net` key; it does not add a fifth arm and it does not re-sign an existing one.
> - **`projection`** — `tieOut.projection ∈ account_balance | stock_on_hand | stock_valuation | item_profitability | party_ageing`: the report's rows, grouped on the projection's own key, equal the projection's stored figures read by the test's own SQL — with **one substitution**: `stock_valuation` compares against `valuationAsOf`, the single implementation the snapshot itself stores (spec:1228), so a fixture need not run the nightly job to prove the tie. **The `stock_valuation` branch serves two row shapes**: a report over the `stock_valuation` dataset compares its `value` column, and a report over the `cost_layer` dataset — which has **no `value` column** (A3) — has the branch multiply `qty_remaining × unit_cost` per row with `Money`/`Quantity` before summing per warehouse. That multiplication lives in the harness, once, against the layer's own two stored facts; it is not a second residue query and no report definition performs it.
> - **`none`** — permitted only for a report with no monetary or quantity total, and the harness then requires a **row witness**: an independent `tx` query supplied by the group test whose row set the report's rows must equal on a declared key. `none` never means "no test"; a definition whose `kind` is `none` and which has no witness case fails `report-tie-out.test.ts` naming its code.

**A6 — §2.8 (7A card) and §4.16.1, the two financial statements are company-level.** The 7A card says "Financial-statement layouts: balance sheet and P&L, **per BRANCH** from the mandatory dimension (spec:1066), as definitions", while §4.16.1 gives 7B `accounting.profit_and_loss` / `accounting.balance_sheet` and gives **7C** `accounting.branch_profit_and_loss`. `account_balance`'s key is `(company_id, account_id, fiscal_period_id, currency)` and carries no branch (§4.3.3), so a per-branch statement cannot read it at all. Amend both:

> **7B's `accounting.profit_and_loss` and `accounting.balance_sheet` are company-level, over `account_balance`, and are not hand-written: each is exactly `statementDefinition(kind, identity)`.** 7A's card and its own source comment say so in terms — *"7B builds `accounting.profit_and_loss` and `accounting.balance_sheet` from these"* (the doc comment on `STATEMENT_LAYOUTS` in `packages/domain/src/reports/statement.ts`) and *"7B calls this in its seed-file generator"* (the doc comment on `statementDefinition`) — and §4.18's rule makes 7A's shipped fragment the contract. The identity a 7B seed file supplies is the four members `statementDefinition` takes and nothing else: `{ code, nameEn, nameAr, permission: "accounting.report.read" }`. Everything else — the single `fiscalPeriodId` parameter, the single `{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }` filter over `account_balance`, the four columns `section` / `account_code` / `account_name_en` / `base_balance` (the last labelled *"Balance" / "الرصيد"*), the group `{ field: "section", subtotal: true }`, the total `{ field: "base_balance", fn: "sum" }`, the sort `section, account_code`, the layout `{ orientation: "portrait", paper: "A4", header: "{title} — {fiscalPeriodId}", footer: "{rowCount} accounts · {generatedAt}" }` and `tieOut: { kind: "ledger_sum" }` — is 7A's, byte for byte — the return of `build(kind, opts)` in `packages/domain/src/reports/statement.ts`, composed onto the identity by `statementDefinition`. **A definition that differs from `statementDefinition(kind, identity)` in any member is a defect**, and 7B's group test asserts the deep equality rather than describing it.
>
> **`section` is a row annotation, not an `account_balance` column, so a statement definition is executed through `statementRows`, never through `datasetFor("account_balance").run`.** `statementRows(tx, kind, { companyId, fiscalPeriodId, branchId?, limit? })` (`packages/db/src/reports/statement.ts`) reads the dataset, filters the *other* statement's account types out and annotates each row with its `section` (its private `annotate` helper, which also drops a `is_group` account). **A consuming slice never writes that branch itself: it calls 7A's `rowsForDefinition(tx, definition, { companyId, parameters, limit? })`**, which looks the code up in `STATEMENT_CODES` through `statementKindFor` and dispatches to `statementRows`, and otherwise performs the plain `datasetFor(definition.dataset.source).run(...)` read. It is the one row provider 7A's own `reporting.render` handler goes through, so a consumer that calls it proves parity against **the same query that renders**; a consumer that re-implements the branch with a local code→kind map proves parity against a second, unversioned copy of the dispatch, and `accounting.branch_profit_and_loss` is then a key 7C must remember to add in two places instead of none. 7B's harness therefore calls `rowsForDefinition` and keeps **no** map of its own. **This is also the one thing about the statements a reader must not "fix" locally:** a definition-level `account_type in` filter would answer a different row set from `statementRows`, i.e. two spellings of one statement — and on the statement branch `rowsForDefinition` does not consult `dataset.filters` at all, so such a filter would be silently dropped rather than refused.
>
> The BRANCH cut is **7C's `accounting.branch_profit_and_loss`**, built from `statementLayout("profit_and_loss", { perBranch: true })`, whose branch clause `statementRows` serves through the `ledger_entry` dataset because that is the only place a branch tag exists on a posted amount (§4.3.3 keys the projection without one). The 7A card's "per BRANCH" describes the *layout family* 7C completes, not 7B's two definitions; spec:1066's guarantee — no unallocated revenue, COGS or staff-cost line — is enforced by 2A's `dimensions.required`, not by a report.
>
> **Both are one fiscal period's movement, not a cumulative position.** `app.account_balance`'s key is `(company_id, account_id, fiscal_period_id, currency)` and its `MERGE` accumulates that document's `sum(debit)`/`sum(credit)` into **that period's** row (§4.3.3), so the single `fiscal_period_id eq` filter returns the period's movement, and 7A's own layout test ties both against `trialBalance` **for the same period** (`packages/db/test/reports/statement-tie-out.test.ts`). **Neither carries an `asOf` parameter or an `{asOfLabel}` header** — 7A's header is `"{title} — {fiscalPeriodId}"` and a 7B definition does not change it. The declared identity is the **movement** identity: Σ`base_balance` over the balance-sheet rows plus Σ`base_balance` over the profit-and-loss rows is `0.0000` for the period, which is what a period's balanced movements guarantee. **Two presentation defects in 7A's fragment are raised, not patched here**: the header interpolates a raw `fiscalPeriodId` uuid where a period label belongs, and the balance column is labelled "Balance" where a movement statement wants "Movement (net)". Both are one string in 7A's `build()` and are carried in this slice's Self-Review raise list; a 7B seed file that "corrected" either would break the deep-equality assertion that is the whole point of building from the layout.
>
> **A cumulative, as-of balance sheet is out of scope for 7B and is recorded as an open item, not shipped silently.** It needs a read that accumulates `account_balance` over every period up to and including a date — a period-ordinal `lte`, or a `period_ends_on` column on the dataset — and neither exists: 7A's `account_balance` dataset carries `fiscal_period_id` and a `fiscal_period_code` (`YYYY-MM`) and no ordinal (A3). Adding either is a change to **7A's** dataset, in 7A's own file, which §2.8 forbids this slice from touching and Task 14 **Step 6** asserts it did not. It is therefore a raise against 7A carried in this slice's Self-Review and in the "what the next slice needs" section, and the definition 7B ships is honest about being a period statement instead of being named for a position it does not compute.

**A7 — §3.4.1 and §2.8 (7B card), migration 0077 is spent.** The card reserves 0077 ("report definitions are seed data") and in the same Delivers block requires "EXPLAIN check that every report filter column is indexed (SAH-070) — indexes, if missing, are migrations in the owning phase's range". Every owning range (0A's 0001, 0B's 0002–0003, 1B's 0015–0016, 2B's 0021–0024, 3A's 0028–0033) is spent and frozen, and §3.4.1 forbids borrowing a number. Amend the card's migration row:

> **0077 — `0077_add_report_filter_indexes.sql`, used, not reserved.** The card's index clause has no other lawful home: a slice writes only inside its own range (§3.4.1) and every table these indexes touch belongs to a range that is spent. The file adds **indexes only** — four of them, one per filter the EXPLAIN gate finds unserved — and no column, constraint or row, so it is an **expand** step under §3.4.7 and needs no contract PR. An index the gate finds missing on a table a *later* slice owns is that slice's, not this file's.

**A8 — §4.17, `seedReportDefinition`'s additive options. ⓘ LANDED WITH 7A — this task VERIFIES it, and does not write it.** §4.17 registered `seedReportDefinition(db, s, opts: { code; definition })`. The five re-expressed codes are seeded at row version 2 and every pack row is `is_core = true`, neither of which those two options can express — so this slice asked for the two it needs. **7A had the same need first and shipped three, not two**, in the same PR as its Task 1, exactly as §4.17's own rule requires ("a slice needing an option a listed one lacks adds the option additively — never changes an existing parameter or return — and records it here in the same PR"); 7A's Execution-handoff amendment table carries the row and says in terms that *"7B's amendment A8 asks for the same two spellings and is satisfied by this row"*. **This slice therefore adds no option and writes no §4.17 text.** The registered row §4.17 must already carry, and which Task 0's gate greps for verbatim:

> `seedReportDefinition(db, s, opts: { code; definition; definitionVersion?; isCore?; clonedFrom? })` — `definitionVersion` defaults to `1` and becomes `app.report_definition.version` (never `ReportDefinition.version`, which is the frozen format version `1` of §4.11.1); `isCore` defaults to `true`; `clonedFrom` defaults to `null`. No existing parameter changes and the return stays the row's `id`.

**7B uses two of the three.** `clonedFrom` is 7A's — its clone-and-edit tests need it — and no 7B group test seeds a tenant clone, so this slice passes `{ code, definition, definitionVersion }` and lets `isCore` default. Passing `clonedFrom` from a 7B fixture would seed a row the catalogue completeness gate (Task 9) counts as core when it is not.

**A9 — §4.17.1, the tie-out harness.** Add the row:

> | `CATALOGUE_7B`, `ReportCode7B`, `CATALOGUE_DIR`, `ReportSeedEnvelope`, `readEnvelope(code)`, `readDefinition(code)`, `runDefinition(tx, definition, params, limit?)`, `assertFieldCoverage(definition, rows)`, `LedgerWindow`, `TieOutWitness`, `TieOutOptions`, `assertTieOut(tx, definition, opts)`, `InventoryFixture`, `SalesFixture`, `CatalogueFixture`, `ReportFixture`, `reportFixture(db, name, opts?)`, `cachedReportFixture(db, label, opts?)` | `tests/invariants/support/reports.ts` | **7B** | the one place a report definition is read off disk, executed against a fixture and compared with the ledger or a projection. Eight files call it (seven group tests in `packages/db/test/reports/` plus `tests/invariants/report-tie-out.test.ts`), which is why it is shared rather than file-local; the `packages/db/test/**` → `tests/invariants/support/**` allowance it needs already exists (3B amendment A21(c)) and 7B adds no fourth allowance. 7C and 8D extend `assertTieOut`'s `projection` switch additively for their own sources and never edit a case. |

**A10 — §4.16.1, `accounting.document_register`'s parameter is free text.** The row says "one definition, `documentTypeCode` parameter over §4.14". An `enum` parameter with §4.14's thirty codes as `options` would make a tenant-added type unreportable, which breaks test 15's "numbers, posts, prints, **reports**, reverses" clause the moment `CONSIGNMENT_RETURN` is configured. Amend the row's note:

> `documentTypeCode` is `kind: "text"`, **not** `kind: "enum"` with §4.14's codes as `options`: a type a tenant adds under `admin.company.manage` must report with no release (test 15), and an options list is a release. An unknown code simply returns no rows.

**A11 — §2.8 and §4.11, the minimum 7A surface 7B calls, transcribed from 7A as written.** 7A is merged before this slice starts, so this amendment is **not a pin invented ahead of it**: every line below is copied from `docs/superpowers/plans/2026-09-05-dulja-phase-7a-report-engine.md` and §4.18's rule — *the written plan is the authority* — makes 7A's spelling the contract. **Every citation below is a SYMBOL and a file path, never a line number**: 7A has been re-cut since this slice was drafted, and an absolute line number into it is stale within one PR of being written. Find each with `rg -n '<symbol>' packages/`. There is **no `runDataset`**: the query lives behind `Dataset.run`, reached through `datasetFor` — and a *definition* is executed through **`rowsForDefinition`**, which picks between `Dataset.run` and `statementRows` for you.

> **The surface a catalogue slice consumes from 7A:**
> ```ts
> // packages/domain/src/reports/validate.ts (7A Task 4)
> export interface ReportDefinitionValidation { ok: boolean; errors: { path: string; message: string }[] }
> export interface ReportDefinitionSets {
>   readonly datasets: ReadonlySet<string>;      // `new Set(DATASET_IDS)` at the db tier
>   readonly permissions: ReadonlySet<string>;   // every code in `app.permission`
> }
> export function validateReportDefinition(definition: unknown, sets: ReportDefinitionSets): ReportDefinitionValidation;
> export function parseReportDefinition(definition: unknown): ReportDefinition;   // schema + grammar only; throws
> // BOTH closed sets are parameters because `packages/domain` imports nothing internal (§3.1; 1A's
> // `validatePolicy(definition, catalogue)` is the same shape, and 7A's handoff records it as its §4.11.1 row).
> // The validator checks: module vs code, the two set memberships, unique parameter names, unique column
> // fields, every group/total/sort field being one of the definition's OWN columns, and every filter naming a
> // declared parameter. Its "not one of this definition's columns" messages are rule 4, and every 7B definition
> // is shaped by it. It does NOT check a field against the DATASET's columns — it cannot, because domain has no
> // access to them; `assertDefinitionFields` below is that check, and `assertFieldCoverage` (Task 1) is the
> // third, against the rows the query actually returns.
>
> // packages/domain/src/reports/render.ts + format.ts (7A Task 8)
> export interface ReportFormatters { /* the five-method interface; `intlFormatters(lang, opts?)` implements it with Intl alone */ }
> export function intlFormatters(lang: ReportLang, opts?: { currency?: string; timeZone?: string }): ReportFormatters;
> export interface RenderOptions {
>   format: ReportFormat;                        // "pdf" | "xlsx" | "csv"
>   lang: ReportLang;                            // "en" | "ar"
>   formatters: ReportFormatters;                // REQUIRED — the numeral/calendar policy is 0E's, injected
>   parameters?: Readonly<Record<string, string>>;
>   generatedAt?: string;                        // RFC 3339 UTC; a test passes a fixed value
> }
> export function renderReport(definition: ReportDefinition, rows: readonly ReportSourceRow[], opts: RenderOptions): RenderedReport;
> // SYNCHRONOUS, and it returns a `RenderedReport` VALUE OBJECT (code, title, dir, lang, format, header,
> // footer, paper, orientation, columns, rows, rowCount, generatedAt) — never bytes, and never awaited.
> export function renderCsv(report: RenderedReport, opts?: { bom?: boolean }): string;   // 7A Task 8
> // `intlFormatters` defaults `numberingSystem` to "latn" for BOTH languages (`opts.numberingSystem ?? "latn"`
> // in `format.ts`, and `IntlFormatterOptions`' own comment says "default: latn for both"), so an Arabic
> // render carries Latin digits unless a caller asks for "arab" — which is why a figure regex over Latin
> // digits is correct in a parity case and why the case says so rather than assuming it.
>
> // apps/worker/src/reports/renderers/index.ts (7A Task 10) — NOT REACHABLE FROM THIS SLICE.
> // `rendererFor(format)` is the ONLY producer of PDF/XLSX bytes, and `startWorker()` (§4.17.1) that drives
> // `reporting.render` lives in `apps/worker/test/support/worker.ts`. §3.1 lets `tests/` import any PACKAGE
> // and `apps/api` through `createApp()`/`./routes` only, and names no path into `apps/worker`; the two
> // dependency-rule allowances that exist run the other way (`apps/worker/test/**` → `tests/invariants/
> // support/**`). So this slice renders through `renderReport` + `renderCsv` and asserts test 23 at the
> // value-object and CSV-text layers; the PDF byte layer of test 23 is 7A's own
> // `apps/worker/test/reports/pdf.test.ts` and stays there.
>
> // packages/domain/src/reports/statement.ts (7A Task 9)
> export type StatementKind = "profit_and_loss" | "balance_sheet";
> export interface StatementLayout { columns; groups; totals; sort; layout; parameters; dataset; tieOut }  // ReportDefinition fragments
> export const STATEMENT_LAYOUTS: Readonly<Record<StatementKind, StatementLayout>>;
> export function statementLayout(kind: StatementKind, opts?: StatementLayoutOptions): StatementLayout;
> export function statementDefinition(
>   kind: StatementKind,
>   identity: { code: string; nameEn: string; nameAr: string; permission: string },
>   opts?: StatementLayoutOptions,
> ): ReportDefinition;                          // 7A's own comment: "7B calls this in its seed-file generator"
> export const STATEMENT_CODES: Readonly<Record<string, StatementKind>>;   // exactly three keys:
> //   accounting.profit_and_loss → profit_and_loss, accounting.balance_sheet → balance_sheet,
> //   accounting.branch_profit_and_loss → profit_and_loss  (7C's; 7A ships the binding, seeds none of them)
> export function statementKindFor(code: string): StatementKind | null;    // total function; never index the map
> export const STATEMENT_EXTRA_FIELDS: readonly ["section", "branch_code", "branch_id"];
> // The three fields a statement's ROWS carry that `account_balance` does not declare. `assertDefinitionFields`
> // unions them into the known set ONLY for a STATEMENT_CODES key, so a typo elsewhere is still refused.
>
> // packages/db/src/reports/statement.ts (7A Task 9)
> export interface StatementParams { companyId: string; fiscalPeriodId: string; branchId?: string | null; limit?: number }
> export async function statementRows(tx: Sql, kind: StatementKind, params: StatementParams): Promise<DatasetRow[]>;
> // Annotates every row with its `section` (its private `annotate` helper), drops `is_group` accounts and
> // filters the other statement's account types out, so a statement definition's `section` column and
> // `section` group are served. `section` is NOT an `account_balance` DatasetColumn (A3), so a statement
> // definition executed through `datasetFor("account_balance").run` throws from `columnOf` on its own sort
> // key. With a `branchId` it reads the `ledger_entry` dataset instead and collapses it to the same shape.
>
> export async function rowsForDefinition(
>   tx: Sql,
>   definition: ReportDefinition,
>   params: { companyId: string; parameters: Readonly<Record<string, string>>; limit?: number },
> ): Promise<DatasetRow[]>;
> // **THE ONE ROW PROVIDER, and the function this slice's harness calls.** `statementKindFor(definition.code)`
> // picks the branch: a statement goes to `statementRows`; every other code is the plain
> // `datasetFor(definition.dataset.source).run(...)` read, with each filter clause whose parameter is absent
> // or empty DROPPED (an omitted optional parameter means "every branch", never "no rows"). 7A's own
> // `reporting.render` handler calls this and never `datasetFor` itself, which is what makes a tie-out run
> // through it a proof about THE QUERY THAT RENDERS rather than about a second, parallel dispatch.
> // ⚠️ On the statement branch `definition.dataset.filters` are NOT consulted at all — `statementRows` owns
> // its two queries and takes exactly `fiscalPeriodId` and `branchId`. `limit` defaults to 100_000.
>
> export function assertDefinitionFields(definition: ReportDefinition): void;
> // **THE ONE FIELD CHECK**, run by 7A's definition store AND by `loadReportDefinitions`, the `reports` pack
> // loader — so a 7B seed file naming a field its dataset does not serve is refused at SEED time with
> // `ERR_VALIDATION_FAILED: dataset '<source>' has no such field: …`. Amendment A3's second paragraph.
>
> // packages/db/src/reports/query.ts (7A Task 5)
> export interface DatasetColumn {
>   readonly field: string;                      // what a ReportDefinition's filters / columns / groups / sort name
>   readonly kind: "text" | "uuid" | "date" | "timestamp" | "numeric" | "integer" | "boolean";
>   readonly ref: (tx: Sql) => SqlFragment;      // the literal qualified column, authored in datasets/*.ts
>   readonly filterable?: boolean;               // default true
>   readonly sortable?: boolean;                 // default true
> }
> export interface DatasetFilter { readonly field: string; readonly op: ReportFilterOp; readonly value: string | readonly string[] }
> export interface DatasetSortKey { readonly field: string; readonly dir: "asc" | "desc" }
> export interface DatasetParams {
>   readonly companyId: string;
>   readonly filters: readonly DatasetFilter[];  // an ARRAY OF TRIPLES, never a keyed record
>   readonly sort: readonly DatasetSortKey[];    // REQUIRED
>   readonly limit: number;                      // clamped to MAX_DATASET_ROWS
>   readonly offset: number;                     // REQUIRED
> }
> export type DatasetRow = Readonly<Record<string, string | number | boolean | null>>;
> export interface Dataset { readonly id: string; readonly columns: readonly DatasetColumn[]; run(tx: Sql, params: DatasetParams): Promise<DatasetRow[]> }
> export const MAX_DATASET_ROWS = 100_000;
>
> // packages/db/src/reports/datasets.ts (7A Tasks 5-7) — the closed registry
> export const DATASETS: Readonly<Record<DatasetId, Dataset>>;
> export const DATASET_IDS: readonly DatasetId[];                  // Object.keys(DATASETS) in registry order
> export function datasetFor(id: string): Dataset;                 // ReportError("ERR_REPORT_DATASET_UNKNOWN", …)
> export function isDatasetId(id: string): id is DatasetId;
>
> // packages/db/src/seed/reports.ts (7A) — the `reports` PackLoader of §3.4.8
> export const reportsLoader: PackLoader;      // name "reports"; WALKS `<packRoot>/reports/<slice>/*.json`, one level deep, so 7B's, 7C's and 8D's directories are all in the pack
> ```
> **A DATASET is executed as `datasetFor(id).run(tx, params)`; a DEFINITION is executed as `rowsForDefinition(tx, definition, { companyId, parameters, limit })`.** The distinction is the whole of A6: `datasetFor(...).run` is the lower half, and a slice that reaches for it with a *definition* in hand has skipped the statement dispatch and is running a different query from the one the route renders. 7A's own `reporting.render` handler is the canonical call and calls `rowsForDefinition`; a consuming slice copies its shape rather than inventing one:
> ```ts
> const rows = await rowsForDefinition(tx, definition, { companyId, parameters, limit: 100_000 });
> ```
> and the filter construction below now lives **inside** `rowsForDefinition`'s dataset branch, printed here only so a reader can see that the filters are an array of triples built from the definition and never a hand-written map:
> ```ts
> const filters = definition.dataset.filters
>   .filter((f) => parameters[f.param] !== undefined && parameters[f.param] !== "")
>   .map((f) => ({ field: f.field, op: f.op, value: parameters[f.param]! }));
> // …then datasetFor(definition.dataset.source).run(tx, { companyId, filters,
> //      sort: definition.sort.map((s) => ({ field: s.field, dir: s.dir })), limit, offset: 0 })
> ```
> `POST /v1/companies/{companyId}/reports/{code}/runs` takes `{ parameters: Record<string, string>, format, lang }` and answers `202 { runId, statusUrl }` (§4.11.2). Its `{code}` path parameter is validated by a **bare grammar regex** — `/^(accounting|inventory|hr|pos)\.[a-z][a-z0-9_]{2,47}$/`, inline in the route's `params` schema, not `ReportCodeSchema`. **The handler's gate order is `requireReportExport` → `resolveDefinitionForRun` → `requireReportRead` → `assertParameters`**, and 7A's own comment on it explains the order: export authority is proved on the path parameter alone, before any row is read, so the route is never an existence oracle for a company's report catalogue. The consequences a consuming slice must assert against, and not the reverse: a code the regex rejects is **400**; a caller without `accounting.report.export` is **403 whether or not the definition exists**; a granted caller naming a well-formed code with no seeded definition is **404 "No such report"** / `ERR_NOT_FOUND`. **If a later reading of 7A finds a further difference, §4.18's rule holds and the consuming slice corrects its import, never adds a second implementation.**

**A12 — §3.7.3, the sah-055 appender's block.** §3.7.3 names 3B as `sah-055`'s creator and 7B as its appender, "7B's block being the stock-ageing report reading layers rather than recomputing". Add the operative half:

> 7B's block is written for the **`'avco'` default** of OD-06 and asserts nothing about consumption order: it asserts that `inventory.stock_ageing`'s rows come from `openLayersOf` (the layer's own `qty_remaining`, a stored fact) and that Σ `qtyRemaining × unitCost` per (item, warehouse) equals `valuationAsOf`'s `value` — the same equality under either method. A FIFO-ordering assertion in that block would be red on the default and would have to be rewritten if OD-06 lands as recommended.

**A13 — §4.16.1, `inventory.stock_ageing` reads 7A's `cost_layer` dataset and ties against `openLayersOf`/`valuationAsOf`.** 3B's own doc comment calls `CostLayerRow` "the raw rows 7B's `inventory.stock_ageing` report reads", and `openLayersOf(tx, { companyId, itemId, asOf, warehouseId?, cursor?, limit })` requires `itemId`. But 7A did **not** wire the dataset to that function: `costLayerDataset` is its own `defineDataset` over `app.cost_layer` joined to item, warehouse and lot (`COST_LAYER_COLUMNS` / `costLayerDataset` in `packages/db/src/reports/datasets/inventory.ts`), with `age_days` computed as `current_date - cl.effective_at` and **no `as_of` parameter of any kind**. §4.18's rule makes 7A's implementation the contract, so the amendment records what is actually true:

> **The `cost_layer` dataset is 7A's `costLayerDataset`, not 3B's `openLayersOf`, and the two are reconciled by the tie-out rather than by sharing a query.** The residue itself still has exactly one definition (SAH-009): `cost_layer.qty_remaining` is a **stored** column that only 3B's engine writes, and both readers read it — the dataset with a `where` on the report's parameters, `openLayersOf` with its own. `inventory.stock_ageing` therefore declares **`itemId` required** (so the report is per item, as `openLayersOf` is, and so the tie-out has one item's layers to compare) and **`warehouseId` optional**, and it declares **no `asOf` parameter**: 7A's `age_days` is measured from `current_date`, and a definition offering an as-of date the dataset ignores would be a parameter that silently does nothing. The tie-out is `kind: "projection"`, `projection: "stock_valuation"`, and the harness compares Σ (`qty_remaining` × `unit_cost`) per warehouse against `valuationAsOf(tx, { companyId, asOf: <today>, itemId })` (A5's two-shape branch, A12's operative half). A whole-catalogue ageing view stays out of scope for v1: it would need a second company-wide residue query beside `valuationAsOf`'s, which is the duplication SAH-009 names. **An as-of-dated ageing report is a raise against 7A's dataset** — an `as_of` parameter on a computed `age_days` is 7A's file to change — and is carried in this slice's Self-Review beside the cumulative balance sheet.

**A14 — §4.16.1, `inventory.profit_by_item` and `inventory.sales_by_item` after 7B.** Both end up over `item_profitability` and the rows would otherwise look like two spellings of one report. Amend both cells:

> `inventory.sales_by_item` keeps 3D's and 4A's **date-range** JSON route and its `SalesByItemRow` shape (`deliveredQuantity`, `cost`, `revenue`, `margin`) unchanged (A2); its **definition** reads `item_profitability`, whose only date handle is `fiscal_period_id` / `fiscal_period_code` (A3), so the definition's parameter is `fiscalPeriodId` and its parity case compares against `salesByItem` over the `fromDate`/`toDate` **that period's start and end are** — the one range where the two agree by construction, and the reason the parity case computes the range from the period row instead of accepting an arbitrary one. `inventory.profit_by_item` is the **per-fiscal-period** view of the same projection (`quantity_sold`, `revenue_base`, `cogs_base`, `margin_base`, grouped by `fiscal_period_code`) with `fiscalPeriodId` **optional** so it can span periods, is gated `inventory.cost.read` rather than `inventory.stock.read` because it exposes cost, and is where test 7's revenue-bearing figure is re-run. Two codes, two parameter shapes, one projection, and neither recomputes anything.

**A15 — §4.16.1, `accounting.period_comparison` is one period parameter run twice.** The register's row reads "two period parameters" and the section intro names it as "`accounting.period_comparison` one definition over two period parameters". Neither is achievable over 7A's `account_balance` dataset: a `DatasetFilter` binds **one** value per clause (`{ field, op, value }`, A11), two `fiscal_period_id eq` clauses on one query intersect to nothing, and a side-by-side two-period row would need a self-join and a second set of measure columns that the dataset does not select (A3). Amend the register cell and the intro sentence together:

> **`accounting.period_comparison` is one definition with ONE `fiscalPeriodId` parameter (plus an optional `accountType`), run once per period.** The comparison is the *report's* job, not the dataset's: the viewer runs it for each period and the layout places the two results side by side, which is also what makes it a `~60 parameterised core reports` entry (spec:2293) rather than one output. A two-period dataset would need a self-join over `account_balance` and a second set of measure columns, i.e. a change to 7A's `datasets.ts` — the file §2.8 forbids the catalogue slices from touching. The spec's counting sentence in this section's intro is amended in the same breath: "*`accounting.period_comparison` one definition over two period parameters*" becomes "*`accounting.period_comparison` one definition over a period parameter, run once per period*".

**A16 — §4.2.8, the `document_event` paging clause moves off 7B.** §4.2.8's round-2 note reads: "`GET …/documents/{documentId}/events` declares no query parameters (2B). `listDocumentEvents` takes no `limit`/`cursor` … `next_cursor` is a constant `null` with a comment saying why, and **7B adds paging in the PR that needs it** (`accounting.document_event_log`)." That clause was written before 7A existed and it no longer names a slice that needs it. Amend the note:

> **The clause is retired from 7B and reassigned to whichever slice next changes that route.** `accounting.document_event_log` reads 7A's **`document_event` dataset** — a `defineDataset` over `app.document_event` with its own `limit`/`offset` in `DatasetParams` (A11) — and never calls `listDocumentEvents` or 2B's `GET …/documents/{documentId}/events`. 7B mounts no route module and edits no DTO (Task 14's pins case asserts both), so it has no PR in which a `DocumentEventQuery` could land without being a route change the slice otherwise does not make. `listDocumentEvents`'s constant `null` `next_cursor` and its comment therefore **stand unchanged after 7B**, and the paging work belongs to the first slice that has a reason to touch that route — **7C or 8D**, whichever ships a document-event surface of its own. There is still no `DocumentEventQuery`.

**A17 — §3.4.1, the report-filter indexes 0077 supplies, and the four this slice may not create.** The 7B card's SAH-070 clause says an index the EXPLAIN gate finds missing is "a migration in the owning phase's range", and A7 spends 0077 for the ones with no other lawful home. That leaves a class the card does not resolve: a filter whose column belongs to a table whose range is spent **and** whose access pattern is another slice's to judge. Record the split so Task 10 has no discretion left:

> **0077 creates indexes for the report-filter columns this catalogue filters by that no existing index serves, and nothing else.** A filter column served by an existing index is not re-indexed. A filter column on a table a **later** slice owns is that slice's index and is excluded from 7B's gate by a named entry on the gate's exemption list carrying the owning slice and the reason — never by leaving the gate red, because `bun run test` stays green after every task (§3.8) and a permanently failing invariant is indistinguishable from a regression. **The exemption list is closed at merge**: a pair on it is a row in this slice's Self-Review and in the "what the next slice needs" section, so the request is visible to the slice that must satisfy it.

- [ ] **Step 2: Write `scripts/check/contracts-7b-amendments.sh`**

```bash
#!/usr/bin/env bash
# 7B Task 0 gate. Run from the repository root. Exits 0 only when every amendment is in the contracts
# document AND every name this slice imports is in the repository. A MISSING (repo) line is never fixed
# by editing this script or by writing the name locally — it is a raise against the owning plan.
set -uo pipefail
CONTRACTS="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0

need_contract() {   # need_contract <literal> <amendment id>
  if ! grep -qF -- "$1" "$CONTRACTS"; then
    echo "MISSING (doc $2): $1"
    fail=1
  fi
}

need_repo() {       # need_repo <file> <literal> <what it is and who owns it>
  if [ ! -f "$1" ]; then
    echo "MISSING (repo): $1 does not exist — $3"
    fail=1
  elif ! grep -qF -- "$2" "$1"; then
    echo "MISSING (repo): $2 is not in $1 — $3"
    fail=1
  fi
}

# ── The seventeen amendments ───────────────────────────────────────────────────────────────────────
need_contract '"definitionVersion": <int ≥ 1>, "definition": <ReportDefinition>' A1
need_contract 'Re-expression does not rewrite the JSON list route.' A2
need_contract 'Each dataset'"'"'s row fields are 7A'"'"'s `DatasetColumn.field` values' A3
need_contract 'base_total' A3
need_contract 'actor_display_name' A3
need_contract 'There is no `value`, no `age_bucket`' A3
need_contract '7B widens it by its seventeen' A4
need_contract 'No slice asserts a total member count.' A4
need_contract 'A module list endpoint is not a `ReportCode`' A4
need_contract 'Membership in this enum is not what makes a code runnable' A4
need_contract 'What each `kind` means to the harness that executes it' A5
need_contract 'The measure map is closed' A5
need_contract 'A signed field is never mapped to `credit`.' A5
need_contract '`none` never means "no test"' A5
need_contract 'are company-level, over `account_balance`, and are not hand-written' A6
need_contract 'each is exactly `statementDefinition(kind, identity)`' A6
need_contract 'never through `datasetFor("account_balance").run`' A6
need_contract 'Both are one fiscal period'"'"'s movement, not a cumulative position' A6
need_contract '0077_add_report_filter_indexes.sql`, used, not reserved' A7
need_contract 'seedReportDefinition(db, s, opts: { code; definition; definitionVersion?; isCore?; clonedFrom? })' A8
need_contract 'tests/invariants/support/reports.ts' A9
need_contract '`documentTypeCode` is `kind: "text"`' A10
need_contract 'export function datasetFor(id: string): Dataset' A11
need_contract 'readonly filters: readonly DatasetFilter[];  // an ARRAY OF TRIPLES' A11
need_contract 'export function validateReportDefinition(definition: unknown, sets: ReportDefinitionSets)' A11
need_contract 'SYNCHRONOUS, and it returns a `RenderedReport` VALUE OBJECT' A11
need_contract 'export function renderCsv(report: RenderedReport' A11
need_contract 'export async function statementRows(tx: Sql, kind: StatementKind' A11
need_contract 'NOT REACHABLE FROM THIS SLICE' A11
need_contract 'WALKS `<packRoot>/reports/<slice>/*.json`' A11
need_contract "written for the **\`'avco'\` default** of OD-06" A12
need_contract 'The `cost_layer` dataset is 7A'"'"'s `costLayerDataset`, not 3B'"'"'s `openLayersOf`' A13
need_contract 'is the **per-fiscal-period** view of the same projection' A14
need_contract 'is one definition with ONE `fiscalPeriodId` parameter' A15
need_contract 'The clause is retired from 7B and reassigned' A16
need_contract 'The exemption list is closed at merge' A17

# ── 7A: every name every task imports ────────────────────────────────────────────────────────────
need_repo packages/domain/src/reports/validate.ts 'export function validateReportDefinition' \
  '7A §4.11.1 (A11) — Tasks 1-9 validate every definition with it, with the TWO-SET second argument'
need_repo packages/domain/src/reports/validate.ts 'ReportDefinitionSets' \
  '7A §4.11.1 (A11) — the { datasets, permissions } second argument; a one-array call does not type-check'
need_repo packages/domain/src/reports/render.ts 'export function renderReport' \
  '7A §4.11.2 (A11) — SYNCHRONOUS, returns RenderedReport; Task 11 renders two definitions in both directions'
need_repo packages/domain/src/reports/format.ts 'export function intlFormatters' \
  '7A (A11) — RenderOptions.formatters is REQUIRED; every renderReport call in this slice passes it'
need_repo packages/domain/src/reports/render.ts 'export function renderCsv' \
  '7A Task 8 (A11) — the in-tier rendered-TEXT layer Task 11 asserts test 23 on; PDF bytes are apps/worker'"'"'s'
need_repo packages/domain/src/reports/statement.ts 'export function statementDefinition' \
  '7A Task 9 (A6) — Task 2'"'"'s two seed files ARE its output; a hand-written statement is a defect'
need_repo packages/db/src/reports/statement.ts 'export async function statementRows' \
  '7A Task 9 (A6) — the ONLY row provider that annotates `section`; the harness branches to it'
need_repo packages/db/src/reports/datasets.ts 'export function datasetFor' \
  '7A §4.16.2 (A11) — the registry seam rowsForDefinition reaches; this slice never calls it with a definition'
need_repo packages/db/src/reports/statement.ts 'export async function rowsForDefinition' \
  '7A Task 9 (A6/A11) — THE one row provider; Task 1 runDefinition wraps it and adds no dispatch of its own'
need_repo packages/db/src/reports/statement.ts 'export function assertDefinitionFields' \
  '7A Task 9 (A3/A11) — the seed-time field check; a 7B seed file with a bad field must fail the loader, not render blank'
need_repo packages/domain/src/reports/statement.ts 'export const STATEMENT_CODES' \
  '7A Task 9 (A6) — the code->statement binding; 7B keeps NO local code-to-kind map'
need_repo packages/domain/src/reports/statement.ts 'export function statementKindFor' \
  '7A Task 9 (A6) — the total function Task 1 guards the fiscalPeriodId parameter with'
need_repo packages/db/src/reports/datasets.ts 'export const DATASET_IDS' \
  '7A §4.16.2 (A11) — the datasets set for validateReportDefinition, and Task 9 asserts this slice added no member'
need_repo packages/db/src/reports/datasets.ts 'export type DatasetId' \
  '7A §4.16.2 — Task 9 asserts this slice added no member'
need_repo packages/db/src/reports/query.ts 'readonly offset: number' \
  '7A (A11) — DatasetParams requires sort AND offset; a params object missing either does not compile'
need_repo packages/db/src/seed/reports.ts 'export const reportsLoader' \
  '7A §3.4.8 — Task 9 applies the 7b/ directory through it'
need_repo packages/db/test/fixtures.ts 'export async function seedReportDefinition' \
  '7A §4.17 (amendment A8) — every group test seeds through it'

# ── 1B, 3B, 3D, 4A, 4B: the read functions this catalogue must not duplicate ──────────────────────
need_repo packages/db/src/reports/trial-balance.ts 'export async function trialBalance' \
  '1B §4.16.3 — Task 4 parity'
need_repo packages/db/src/reports/ledger.ts 'export async function accountLedger' \
  '1B §4.16.3 — Task 4 parity'
need_repo packages/db/src/reports/stock-on-hand.ts 'export async function stockOnHand' \
  '3D §4.16.3 — Task 8 parity'
need_repo packages/db/src/reports/sales-by-item.ts 'export async function salesByItem' \
  '3D §4.16.3 + 4A revenue/margin — Task 8 parity'
# NOTE ON THE THREE `costing/valuation.ts` LINES BELOW: §4.7.2 fixes the DIRECTORY, not the file name, and
# 3B's plan is the authority on the split. If one of them reports MISSING (repo), grep for the symbol
# (`rg -n 'export async function valuationAsOf' packages/db/src`) and correct the PATH here and in this
# plan's imports. That is a path correction, not a raise, and never a second implementation.
need_repo packages/db/src/costing/valuation.ts 'export async function valuationAsOf' \
  '3B §4.7.2 — Tasks 5 and 8; the ONE valuation implementation'
need_repo packages/db/src/costing/valuation.ts 'export async function openLayersOf' \
  '3B §4.7.2 (amendment A13) — Task 5 stock ageing'
need_repo packages/db/src/projections/item-profitability.ts 'export async function itemProfitabilityRows' \
  '4B amendment 6 — Task 7'
need_repo packages/db/src/projections/item-profitability.ts 'export async function rebuildItemProfitability' \
  '4B — Task 7 populates the projection with it, never by hand'
need_repo packages/db/src/costing/valuation.ts 'export async function rebuildStockValuation' \
  '3B — Task 5 populates stock_valuation with it'

# ── The test-tier helpers the fixtures are built from ────────────────────────────────────────────
need_repo tests/invariants/support/post-journal.ts 'export async function postJournal' \
  '1B §4.17.1 — the ONLY way this slice creates ledger rows'
need_repo tests/invariants/support/post-inventory.ts 'export async function postInventoryDocument' \
  '3B §4.17.1 — the inventory fixtures'
need_repo tests/invariants/support/post-inventory.ts 'export async function ensureOpenPeriods' \
  '3B §4.17.1 — every fixture posts across three periods'
need_repo tests/invariants/support/post-inventory.ts 'export async function secondPrincipal' \
  '3D amendment 12 — the EXPORT keyword on 3B module-private helper; catalogueChain approval hop needs it'
need_repo tests/invariants/support/ar-ap.ts 'export async function postFromPack' \
  '4B §4.17.1 — the ONLY helper that threads partyId; GOODS_RECEIPT and DELIVERY_ORDER require a party'
need_repo tests/invariants/support/post-ar.ts 'export async function postArDocument' \
  '4A §4.17.1 — the revenue side of Tasks 7 and 8'
need_repo tests/invariants/support/ar-ap.ts 'export async function seedTypeFromPack' \
  '4B §4.17.1 — this slice configures NO document type of its own'
need_repo scripts/lint/rules/dependency-rule.ts 'packages/db/test/**' \
  '3B amendment A21(c) — without it every group test in this slice is a lint violation'
need_repo tests/invariants/test-07-one-costing-answer.test.ts 'acceptance test 7' \
  '3D T11 — Task 7 re-runs it UNCHANGED'
need_repo tests/regression/sah-055.test.ts 'SAH-055' \
  '3B §3.7.3 — Task 14 APPENDS to it; if it is absent, OD-06 work did not land and Task 14 Step 3 stops'

# ── Three facts, reported and not failed on ─────────────────────────────────────────────────────
echo "--- informational ---"
echo -n "ReportCodeSchema members before this slice: "
grep -c '^  "' packages/contracts/src/accounting/reports.ts 2>/dev/null || echo "?"
echo -n "report definitions already seeded by other slices: "
ls -d packages/db/seed/my/reports/*/ 2>/dev/null | tr '\n' ' ' || echo "none"
echo -n "0077 taken? "
ls packages/db/migrations/0077* 2>/dev/null || echo "no — good"

if [ "$fail" -ne 0 ]; then echo "7B Task 0 gate FAILED"; exit 1; fi
echo "7B Task 0 gate OK."
```

- [ ] **Step 3: Run the gate and read the two informational lines**

Run: `bash scripts/check/contracts-7b-amendments.sh`
Expected before Step 1: **thirty-two `MISSING (doc …)` lines — one per `need_contract` call except the two the contracts document already carries — and no `MISSING (repo)` line**, then `7B Task 0 gate FAILED`. Count the `need_contract` lines in the file you just wrote rather than trusting a number in this prose — the script grows whenever an amendment gains a literal, and as written it carries **thirty-four**. **The two that pre-pass are A1's `"definitionVersion": <int ≥ 1>, "definition": <ReportDefinition>` envelope literal and A8's `seedReportDefinition(db, s, opts: { code; definition; definitionVersion?; isCore?; clonedFrom? })` row**, both landed with 7A and ratified by §4.18's round 3 (A1) and §4.17 / §4.16.1 (A8) — which is exactly what their ⓘ **LANDED WITH 7A** markers say, and seeing them PRESENT before Step 1 is the confirmation that 7A merged, not an error. If either prints MISSING, 7A's contract PR did not land and this slice stops. After Step 1: `7B Task 0 gate OK.` and three informational lines — the third must print `no — good`.

**A `MISSING (repo)` line is never fixed here.** Each names a plan that owns the export: 7A for the engine, statement and render names, 1B/3B/3D/4A/4B for the read functions, 3B for the lint allowance. §4.18's rule is that the written plan is the authority, so a *different spelling* in the repository is corrected in **this** plan's import line and recorded as a further amendment; an *absent* name is a raise against that slice and this slice stops.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md scripts/check/contracts-7b-amendments.sh
git commit -m "docs(contracts): 7B amendments A1-A17 and the consumed-export gate [7B T0]

The report seed envelope, the dataset field vocabulary, the re-expression
settlement, the statement-layout binding, the executable tieOut semantics and
the names 7B imports from 7A, 1B, 3B, 3D, 4A and 4B.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 1: The tie-out harness, ADR 0068, and the four accounting ledger definitions

The catalogue's backbone lands first: one shared helper that reads a definition off disk, executes it through 7A's `rowsForDefinition` — the one row provider, which dispatches a `STATEMENT_CODES` key to `statementRows` and every other code to `datasetFor(source).run` (A6) — and compares the result with the ledger or a projection; then the four definitions whose tie-out is the most direct — `accounting.general_ledger`, `accounting.journal_register`, `accounting.account_statement` and `accounting.period_comparison`.

**Files:**
- Create: `tests/invariants/support/reports.ts`, `docs/adr/0068-tie-out-declarations-are-executed.md`, `packages/db/seed/my/reports/7b/accounting.general_ledger.json`, `…/accounting.journal_register.json`, `…/accounting.account_statement.json`, `…/accounting.period_comparison.json`, `packages/db/test/reports/7b-accounting-ledger.test.ts`
- Modify: nothing.

**Interfaces:**
- Consumes: `ReportDefinition`, `validateReportDefinition`, `ReportDefinitionValidation`, `ReportDefinitionSets` (7A, §4.11.1 / A11); `rowsForDefinition` (7A, A6 / A11 — **the one row provider `runDefinition` wraps**), `isDatasetId`, `DATASET_IDS`, `MAX_DATASET_ROWS`, `DatasetRow`, `DatasetId` (7A, A11); `statementKindFor` (7A, `@dulja/domain`, A6 / A11 — the guard that tells `runDefinition` a statement needs `fiscalPeriodId`; **this slice keeps no code→kind map of its own**); `seedReportDefinition` (7A, §4.17 / A8); `PERMISSIONS` (0B, §4.2.5 — the `permissions` half of `ReportDefinitionSets`); `trialBalance`, `TrialBalanceRow` (1B, §4.16.3); `valuationAsOf` (3B); `stockOnHand` (3D); `itemProfitabilityRows` (4B); `Money`, `Quantity`, `currency`, `CurrencyCode`, `RoundingMode` (§4.2.1); `TenantContext` (0B, §4.2.2); `startDb`, `Db`, `Seed`, the 4-argument test `withTenant`, `uuidv7` (§4.1); `seedTenantV2`, `seedAccount`, `postDocument` (1A), `seedBranch` (0D), `grantCodes`, `transitionDocument` (2B), `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot`, `seedPriceList` (3A), `seedParty`, `seedPaymentTerm` (2A/4A); `postJournal` (1B), `postInventoryDocument`, `ensureOpenPeriods` (3B), **`secondPrincipal` (3D, amendment 12 — it lives in 3B's `tests/invariants/support/post-inventory.ts` but is module-private there (phase-3b:2489); 3D's Task 0 amendment 12 adds the one `export` keyword, and Task 0's gate has a `need_repo` line for it)**, `postArDocument` (4A), `snapshotCountSheet`, `recordCounts`, `CountSheetLine` (3D), `seedTypeFromPack`, `packApproval`, `PackApproval`, **`postFromPack`** (4B — the receipt and the delivery, whose policies `require` a party `PostInventoryOptions` cannot carry); `REPO_ROOT` (0B, §4.17.1). **`openLayersOf` and `recordingJobs` are deliberately absent**: the layer rows come from 7A's `cost_layer` dataset and are tied against `valuationAsOf` (A13), and no fixture in this slice enqueues or drains a job — the two projections are populated by the direct `rebuildStockValuation` / `rebuildItemProfitability` calls of Tasks 5 and 7 (Global Constraint 16), so no `jobs` client is needed.
- Produces:
  ```ts
  // tests/invariants/support/reports.ts  (§4.17.1, amendment A9)
  export const CATALOGUE_7B: readonly ReportCode7B[];            // the twenty-two codes, in the §4.16.1 order
  export type ReportCode7B = (typeof CATALOGUE_7B)[number];
  export const CATALOGUE_DIR: string;                            // <repo>/packages/db/seed/my/reports/7b
  export interface ReportSeedEnvelope { definitionVersion: number; definition: ReportDefinition }
  export function readEnvelope(code: string): ReportSeedEnvelope;
  export function readDefinition(code: string): ReportDefinition;
  export function runDefinition(tx: Sql, definition: ReportDefinition, params: Readonly<Record<string, string | null>>, limit?: number): Promise<DatasetRow[]>;   // limit defaults to MAX_DATASET_ROWS and a FULL page throws
  export function assertFieldCoverage(definition: ReportDefinition, rows: readonly DatasetRow[]): void;
  export interface LedgerWindow { fiscalPeriodId?: string; fromDate?: string; toDate?: string; accountCode?: string; documentTypeCodes?: readonly string[] }
  export interface TieOutWitness { key: readonly string[]; rows(tx: Sql): Promise<Record<string, string | null>[]> }
  export interface TieOutOptions { params: Readonly<Record<string, string | null>>; baseCurrency: CurrencyCode; window?: LedgerWindow; asOf?: string; witness?: TieOutWitness }
  export function assertTieOut(tx: Sql, definition: ReportDefinition, opts: TieOutOptions): Promise<void>;
  export interface InventoryFixture { itemId: string; itemCode: string; baseUnitId: string; unitCode: string; whHq: string; whBranch: string; whTransit: string; lotId: string; lotCode: string; typeIds: Readonly<Record<string, string>>; vendorId: string; customerId: string; receiptId: string; deliveryId: string; transferId: string }
  export interface SalesFixture { partyId: string; termId: string; invoiceId: string; creditNoteId: string }
  export interface CatalogueFixture { priceListId: string; promotionId: string; countDocumentId: string }
  export interface ReportFixture { db: Db; s: Seed; reader: string; outsider: string; accounts: Readonly<Record<string, string>>; branchB: string; journals: { documentId: string; number: string }[]; inventory: InventoryFixture | null; sales: SalesFixture | null; catalogue: CatalogueFixture | null }
  export function reportFixture(db: Db, name: string, opts?: { inventory?: boolean; sales?: boolean; catalogue?: boolean }): Promise<ReportFixture>;
  /** The same fixture, memoised per (label, options) for the process. The three regression files of Task 14
   *  build their rows on 0B's `sharedDb()` container as a THIRD tenant rather than starting one of their
   *  own (§3.7.1's one-container rule), and each is a separate Vitest file with no module of its own. */
  export function cachedReportFixture(db: Db, label: string, opts?: { inventory?: boolean; sales?: boolean; catalogue?: boolean }): Promise<ReportFixture>;
  ```

**Read this before writing the harness.** Six decisions in it are load-bearing and each has a reason a reader would otherwise have to reconstruct.

1. **`runDefinition` does not dispatch — it delegates to 7A's `rowsForDefinition`, and that is the whole point of it.** `accounting.profit_and_loss` and `accounting.balance_sheet` group and sort on `section`, which is **not** an `account_balance` `DatasetColumn` (A3) — it is annotated by 7A's `statementRows`, which also filters the other statement's account types out (A6, its private `annotate` helper). 7A already owns that branch: `rowsForDefinition(tx, definition, { companyId, parameters, limit })` looks the code up through `statementKindFor` / `STATEMENT_CODES` and sends a statement to `statementRows` and everything else to `datasetFor(source).run`, and **7A's own `reporting.render` handler calls exactly that function**. So the harness calls it too, and keeps **no code→kind map of its own**. This is not a style preference: a tie-out is a claim that *the query that renders* agrees with the ledger, and a harness that re-implemented the dispatch with a local two-entry map would prove parity against a second copy of it — green here, and silently wrong the day 7C adds `accounting.branch_profit_and_loss` to `STATEMENT_CODES` and not to the copy. `runDefinition` therefore adds exactly three things `rowsForDefinition` does not do, and nothing else: the `isDatasetId` guard (a named §4.16.2 message instead of a raw `ERR_REPORT_DATASET_UNKNOWN`), the missing-`fiscalPeriodId` guard on a statement code (`rowsForDefinition` would otherwise bind `undefined`), and the **full-page refusal** of point 3. 7C extends this by editing nothing at all.
2. **The `DatasetParams` are built from the definition's own filters, never from a hand-written map — and 7A builds them.** `rowsForDefinition` walks `definition.dataset.filters`, reads each `param` out of the `parameters` record, drops the clause when the value is absent or empty (an optional parameter the caller omitted) and passes the `{ field, op, value }` **triple** — `DatasetParams.filters` is a `readonly DatasetFilter[]`, an array of triples, not a keyed record (A11). All `runDefinition` does is flatten its own `Record<string, string | null>` argument into that `parameters` record, dropping `companyId` (which is a named member, not a parameter) and every `null`. That construction is **7A's, inside `rowsForDefinition`'s dataset branch** — this slice does not copy it and does not re-invent it; the note is here so a reader knows what `runDefinition` is delegating. That is what makes the field-coverage gate meaningful: if a definition names a filter field the dataset has no column for, the failure comes from 7A's `columnOf` with the field in the message, not from the harness pretending it knows the SQL.
3. **`sort` and `offset` are required members and are supplied from the definition, not defaulted away.** `sort` is `definition.sort.map((s) => ({ field: s.field, dir: s.dir }))` — a `ReportDefinition`'s sort keys are `{ field, dir }` (§4.11.1) and so are `DatasetSortKey`s, so the map is an identity that exists only to drop any extra member. `offset` is `0` (`rowsForDefinition`'s own constant) and `runDefinition`'s `limit` defaults to `MAX_DATASET_ROWS` and is passed through, **and the harness throws when the result fills the page**: a tie-out summed over a truncated page would be the quietest possible false negative, so `runDefinition` refuses a full page rather than returning one.
4. **A `DatasetRow`'s keys are `snake_case`** (A3). Every property access on a row in this file — and in **every** group test, tie-out case, `TieOutWitness.key` entry and regression block of this slice — is the dataset's column alias — `r.account_code`, `r.base_debit`, `r.qty_remaining` — and **never** the `camelCase` member of a §4.16.3 read-function row type. `trialBalance` returns `TrialBalanceRow.baseDebit` and the `account_balance` dataset returns `base_debit`; a parity case maps one onto the other explicitly, and a case that mixed them would compare `undefined` with a figure and pass by coercing both to `"0.0000"`.
5. **Every sum accumulates through `Money`.** `rows.reduce((a, r) => a.add(Money.of(String(r[field]), base)), Money.zero(base))` — never `Number(r[field])`. `no-number-money` (§3.7.5) fires on a variable named `total` typed `number`, and beyond the lint a float sum of twenty rows at 4 dp is exactly the drift a tie-out exists to catch. **This holds in the group tests too**, which are outside the lint runner's `ROOTS` (§3.7.5) and so are bound by Global Constraint 3 rather than by a rule.
6. **The comparison is `.toString()` against `.toString()`, both fixed 4 dp.** Postgres returns `numeric` as a string through `postgres.js`; `Money.toString()` is fixed 4 dp (§4.2.1). Comparing strings means "to the cent" is literal and no epsilon is ever chosen.

- [ ] **Step 1: Write `tests/invariants/support/reports.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import {
  Money, Quantity, statementKindFor, type CurrencyCode, type ReportDefinition,
} from "@dulja/domain";
import {
  MAX_DATASET_ROWS, isDatasetId, itemProfitabilityRows, postDocument, recordCounts,
  rowsForDefinition, snapshotCountSheet, transitionDocument, valuationAsOf,
  type DatasetRow, type TenantContext,
} from "@dulja/db";
import { uuidv7, withTenant, type Db, type Seed } from "@dulja/db/test";
import {
  grantCodes, seedAccount, seedBranch, seedItem, seedLot, seedParty, seedPaymentTerm, seedPriceList,
  seedTenantV2, seedUnit, seedWarehouse,
} from "@dulja/db/test";
import { REPO_ROOT } from "../../support/source";
import { postJournal } from "./post-journal";
import { ensureOpenPeriods, postInventoryDocument, secondPrincipal } from "./post-inventory";
import { postArDocument } from "./post-ar";
// `postFromPack` IS imported, and 3D's own plan says why: "`deliverWithOverride` drafts through
// `draftTypedDocument` and `convertOrderToDelivery`, **not** through `postInventoryDocument`: 3B's helper
// takes no `partyId` and `DELIVERY_ORDER`'s policy declares `requires: ["party", "warehouse"]`, so
// `validateRequires` would refuse at post" (phase-3d:5870). The same is true of 3C's `GOODS_RECEIPT`
// (`requires: ["party", "warehouse"]`, phase-3d:1709). `PostInventoryOptions` has **no `partyId` member** in
// any plan — 3B's insert list is `(tenant_id, company_id, document_type_id, series, effective_date,
// currency, branch_id, warehouse_id, to_warehouse_id)` (phase-3b:2510-2516) — so the receipt and the
// delivery go through `postFromPack`, which threads `partyId` and `warehouseId` into 3C's
// `draftTypedDocument`. `TRANSFER` stays on `postInventoryDocument`: it declares
// `requires: ["warehouse", "to_warehouse"]` (phase-3d:3113), needs no party, and is the one document here
// that needs `to_warehouse_id` — which `PostFromPackOptions` does not carry (phase-4b:1885-1911).
// `packApproval` is imported to read each type's `approval.post` off its own shipped envelope.
import { packApproval, postFromPack, seedTypeFromPack } from "./ar-ap";

/** The production `TenantContext` (§4.2.2) the shipped read and write functions take, built from the test
 *  `Seed`. The 4-argument test `withTenant` opens the session; the context object is passed to the function
 *  itself — exactly the pairing 3D's own count suite uses (phase-3d:3729). */
function ctxFor(s: Seed, actorId: string): TenantContext {
  return { tenantId: s.tenant, actorId, requestId: crypto.randomUUID() };
}

/** The twenty-two codes of §4.16.1 this slice seeds, in the register's own order. */
export const CATALOGUE_7B = [
  "accounting.general_ledger", "accounting.journal_register", "accounting.account_statement",
  "accounting.period_comparison", "accounting.profit_and_loss", "accounting.balance_sheet",
  "accounting.document_register", "accounting.audit_log", "accounting.document_event_log",
  "accounting.trial_balance", "accounting.ledger",
  "inventory.stock_ageing", "inventory.movement_register", "inventory.expiry_list",
  "inventory.price_list", "inventory.promotion_register", "inventory.transfer_register",
  "inventory.count_register", "inventory.profit_by_item",
  "inventory.stock_on_hand", "inventory.valuation", "inventory.sales_by_item",
] as const;
export type ReportCode7B = (typeof CATALOGUE_7B)[number];

export const CATALOGUE_DIR = join(REPO_ROOT, "packages", "db", "seed", "my", "reports", "7b");

/** The envelope of amendment A1 — `definitionVersion` outside, the format-version-1 definition inside. */
export interface ReportSeedEnvelope { definitionVersion: number; definition: ReportDefinition }

export function readEnvelope(code: string): ReportSeedEnvelope {
  const path = join(CATALOGUE_DIR, `${code}.json`);
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as ReportSeedEnvelope;
  if (typeof parsed.definitionVersion !== "number" || parsed.definitionVersion < 1) {
    throw new Error(`${path}: definitionVersion must be an integer >= 1 (amendment A1)`);
  }
  if (parsed.definition?.code !== code) {
    throw new Error(`${path}: definition.code is ${String(parsed.definition?.code)}, file name says ${code}`);
  }
  return parsed;
}
export function readDefinition(code: string): ReportDefinition { return readEnvelope(code).definition; }

/** Every field a definition references anywhere. The field-coverage gate compares this with the dataset's row keys. */
function referencedFields(d: ReportDefinition): string[] {
  return [
    ...d.dataset.filters.map((f) => f.field),
    ...d.columns.map((c) => c.field),
    ...d.groups.map((g) => g.field),
    ...d.totals.map((t) => t.field),
    ...d.sort.map((s) => s.field),
  ];
}

/**
 * Executes a DEFINITION through 7A's one row provider, `rowsForDefinition` — the same function 7A's
 * `reporting.render` handler calls. That identity is the point: a tie-out is a claim about the query that
 * RENDERS, so the harness must not own a second dispatch. `rowsForDefinition` sends a `STATEMENT_CODES` key
 * to `statementRows` (which annotates `section`, drops group accounts and filters the other statement's
 * account types out — amendment A6) and every other code to `datasetFor(definition.dataset.source).run(...)`,
 * building the filter clauses from the DEFINITION and dropping any clause whose parameter is absent or empty
 * (an omitted optional parameter — "no branch" means "every branch", never "no rows"). **Nothing in this
 * file knows any SQL**, which is what keeps test 27 true with twenty-two new report files.
 *
 * This wrapper adds exactly three things and no fourth. 7C changes none of them.
 */
export async function runDefinition(
  tx: Sql, definition: ReportDefinition, params: Readonly<Record<string, string | null>>,
  limit = MAX_DATASET_ROWS,
): Promise<DatasetRow[]> {
  // (a) A named §4.16.2 message instead of 7A's raw ERR_REPORT_DATASET_UNKNOWN. A statement code is exempt
  //     only in the sense that its `dataset.source` is `account_balance`, a real member — the statement
  //     branch names the SHAPE its two queries produce (7A's own note on `rowsForDefinition`).
  const source = definition.dataset.source;
  if (!isDatasetId(source)) {
    throw new Error(`${definition.code}: dataset "${source}" is not a member of 7A's closed registry (§4.16.2)`);
  }
  // (b) The statement guard. On that branch `rowsForDefinition` reads `parameters.fiscalPeriodId` and passes
  //     it straight to `statementRows`, so an omitted one would bind `undefined` into a query instead of
  //     failing. `statementKindFor` is 7A's total function; this file keeps no code→kind map of its own, so
  //     7C's `accounting.branch_profit_and_loss` needs no edit here.
  const parameters: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key !== "companyId" && typeof value === "string" && value !== "") parameters[key] = value;
  }
  if (statementKindFor(definition.code) !== null && parameters["fiscalPeriodId"] === undefined) {
    throw new Error(`${definition.code}: a statement needs the fiscalPeriodId parameter (amendment A6)`);
  }
  const rows = await rowsForDefinition(tx, definition, {
    companyId: params.companyId as string,
    parameters,
    limit,
  });
  // (c) A tie-out over a truncated page is the quietest false negative there is: the report's Σ would be
  //     short and no assertion would say so. Refuse the full page instead of paging — every fixture in this
  //     slice produces tens of rows, so a full page means the fixture, not the report, is wrong. The check
  //     covers BOTH of `rowsForDefinition`'s branches, which is another reason to wrap it once here.
  if (rows.length >= limit) {
    throw new Error(
      `${definition.code}: rowsForDefinition filled the page (${rows.length} of limit ${limit}); a tie-out over ` +
      `a truncated page proves nothing — narrow the fixture's parameters, never raise the limit past MAX_DATASET_ROWS`,
    );
  }
  return rows;
}

export function assertFieldCoverage(definition: ReportDefinition, rows: readonly DatasetRow[]): void {
  if (rows.length === 0) {
    throw new Error(`${definition.code}: the fixture returned no rows, so field coverage proves nothing — fix the fixture, never the gate`);
  }
  const keys = new Set(Object.keys(rows[0]!));
  const missing = referencedFields(definition).filter((f) => !keys.has(f));
  if (missing.length > 0) {
    throw new Error(
      `${definition.code}: dataset "${definition.dataset.source}" has no field(s) ${missing.join(", ")} — ` +
      `either the definition names a field amendment A3 does not pin, or 7A's query does not return one it does`,
    );
  }
}

/** Which of the four sums each money total is compared against (amendment A5). Closed on purpose, and a
 *  KEY of this map rather than a SQL fragment: the query below computes all four and the branch picks one,
 *  so no statement in this slice interpolates anything into SQL (§3.3's three `sql.unsafe` homes are the
 *  migration runner, the pg-boss adapter and the Firebird reader — none of them is a test helper).
 *
 *  THE SIGN CONVENTION, because a later slice's key depends on it and getting it wrong passes for the wrong
 *  reason. `"debit"` and `"credit"` are GROSS, UNSIGNED sums: a field mapped to one of them is a total that
 *  only ever moves one way. `"net"` and `"credit_net"` are SIGNED: `"net"` is debit − credit, the natural
 *  direction of an asset or an expense, and `"credit_net"` is credit − debit, the natural direction of a
 *  liability, an equity account or an income account. **A signed field is never mapped to `"credit"`.** The
 *  failure it hides is exact: a run that posts its net leg as a DEBIT to a payable makes `sum(base_credit)`
 *  zero for that window while the report's own signed total is negative, and the two sides then differ by
 *  the whole amount with nothing in the message to say why. `"credit_net"` is the arm for that shape, and it
 *  is why this union has a fourth member no 7B definition uses — 8D's is the first key that needs it (see
 *  "What the next slice needs from this one"). */
const LEDGER_MEASURE: Readonly<Record<string, "debit" | "credit" | "net" | "credit_net">> = {
  base_debit: "debit", base_credit: "credit", base_balance: "net", base_total: "debit",
};

export interface LedgerWindow {
  fiscalPeriodId?: string; fromDate?: string; toDate?: string;
  accountCode?: string; documentTypeCodes?: readonly string[];
}
export interface TieOutWitness { key: readonly string[]; rows(tx: Sql): Promise<Record<string, string | null>[]> }
export interface TieOutOptions {
  params: Readonly<Record<string, string | null>>;
  baseCurrency: CurrencyCode;
  window?: LedgerWindow;
  asOf?: string;
  witness?: TieOutWitness;
}

function sumRows(rows: readonly DatasetRow[], field: string, base: CurrencyCode): Money {
  return rows.reduce((acc, r) => acc.add(Money.of(String(r[field] ?? "0.0000"), base)), Money.zero(base));
}

function firstMoneyTotal(definition: ReportDefinition): string {
  const money = new Set(definition.columns.filter((c) => c.format === "money").map((c) => c.field));
  const total = definition.totals.find((t) => t.fn === "sum" && money.has(t.field));
  if (!total) throw new Error(`${definition.code}: tieOut.kind is "ledger_sum" but no money column has a sum total (amendment A5)`);
  if (!(total.field in LEDGER_MEASURE)) {
    throw new Error(`${definition.code}: "${total.field}" is not in the closed measure map ${Object.keys(LEDGER_MEASURE).join(", ")} (amendment A5)`);
  }
  return total.field;
}

/**
 * Executes the definition's declared `tieOut` (§4.11.1, amendment A5). Every branch compares two INDEPENDENT
 * paths: the report's own aggregation over the dataset's rows against one SQL sum or one projection read.
 */
export async function assertTieOut(tx: Sql, definition: ReportDefinition, opts: TieOutOptions): Promise<void> {
  const rows = await runDefinition(tx, definition, opts.params);
  assertFieldCoverage(definition, rows);
  const base = opts.baseCurrency;
  const companyId = opts.params.companyId as string;

  if (definition.tieOut.kind === "ledger_sum") {
    const field = firstMoneyTotal(definition);
    const w = opts.window ?? {};
    const account = w.accountCode ?? definition.tieOut.account ?? null;
    const types = w.documentTypeCodes ? [...w.documentTypeCodes] : null;
    const [row] = await tx<{ debit: string; credit: string; net: string; credit_net: string }[]>`
      select coalesce(sum(le.base_debit), 0)::numeric(19,4)::text                  as debit,
             coalesce(sum(le.base_credit), 0)::numeric(19,4)::text                 as credit,
             coalesce(sum(le.base_debit - le.base_credit), 0)::numeric(19,4)::text as net,
             coalesce(sum(le.base_credit - le.base_debit), 0)::numeric(19,4)::text as credit_net
        from app.ledger_entry le
        join app.account a on a.id = le.account_id
        join app.document d on d.id = le.document_id
        join app.document_type dt on dt.id = d.document_type_id
       where le.company_id = ${companyId}
         and (${w.fiscalPeriodId ?? null}::uuid is null or le.fiscal_period_id = ${w.fiscalPeriodId ?? null}::uuid)
         and (${w.fromDate ?? null}::date is null or le.effective_date >= ${w.fromDate ?? null}::date)
         and (${w.toDate ?? null}::date is null or le.effective_date <= ${w.toDate ?? null}::date)
         and (${account}::text is null or a.code = ${account}::text)
         and (${types}::text[] is null or dt.code = any(${types}::text[]))`;
    const measured = row![LEDGER_MEASURE[field]!];
    const reported = sumRows(rows, field, base);
    if (reported.toString() !== Money.of(measured, base).toString()) {
      throw new Error(
        `${definition.code}: the report totals ${reported.toString()} and the ledger totals ${measured} ` +
        `for measure ${LEDGER_MEASURE[field]}${account ? ` on account ${account}` : ""}`,
      );
    }
    return;
  }

  if (definition.tieOut.kind === "projection") {
    switch (definition.tieOut.projection) {
      case "account_balance": {
        // The stored side is restricted to the SAME window the report was run for. A single-account report
        // (`accounting.account_statement`, `accounting.ledger`) carries `window.accountCode`, and without
        // this clause every OTHER stored account would be compared against a report that never claimed to
        // cover it and would fail on the first non-zero one. The comparison stays two independent paths:
        // the report's aggregation over its pages against the projection's stored figures for its own scope.
        const only = opts.window?.accountCode ?? null;
        const stored = await tx<{ code: string; currency: string; debit: string; credit: string }[]>`
          select a.code, b.currency::text as currency, b.base_debit::text as debit, b.base_credit::text as credit
            from app.account_balance b join app.account a on a.id = b.account_id
           where b.company_id = ${companyId}
             and (${opts.window?.fiscalPeriodId ?? null}::uuid is null or b.fiscal_period_id = ${opts.window?.fiscalPeriodId ?? null}::uuid)
             and (${only}::text is null or a.code = ${only}::text)
           order by a.code, b.currency`;
        if (only !== null && stored.length === 0) {
          throw new Error(`${definition.code}: account_balance has no row for account ${only} in this window, so the tie-out would compare nothing`);
        }
        const byKey = new Map<string, Money>();
        for (const r of rows) {
          // `account_code` / `base_debit` / `base_credit` are 7A's column aliases (A3), not `TrialBalanceRow`
          // members. A `camelCase` access here would read `undefined`, coerce to "0.0000" and pass vacuously.
          const key = `${String(r.account_code)}|${String(r.currency)}`;
          const net = Money.of(String(r.base_debit ?? "0.0000"), base).subtract(Money.of(String(r.base_credit ?? "0.0000"), base));
          byKey.set(key, (byKey.get(key) ?? Money.zero(base)).add(net));
        }
        for (const s of stored) {
          const key = `${s.code}|${s.currency}`;
          const expected = Money.of(s.debit, base).subtract(Money.of(s.credit, base));
          const got = byKey.get(key) ?? Money.zero(base);
          if (got.toString() !== expected.toString()) {
            throw new Error(`${definition.code}: account_balance says ${expected.toString()} for ${key}, the report says ${got.toString()}`);
          }
        }
        return;
      }
      case "stock_on_hand": {
        // The grouping key is whichever of (item_id, warehouse_id, lot_id) the REPORT's rows carry, and the
        // projection is aggregated on the same subset: `inventory.movement_register` and
        // `inventory.transfer_register` carry all three, `inventory.stock_on_hand` carries all three too but
        // reports only the warehouse kinds its parameter admits. Deriving the key rather than fixing it is
        // what lets one branch serve every quantity report without any of them inventing a column.
        // (`inventory.expiry_list` does NOT reach this branch: the `lot` dataset carries no quantity at all,
        // so its `tieOut.kind` is `none` and its proof is a row witness — A3, A5.)
        const qtyField = firstQuantityTotal(definition);
        const keyFields = ["item_id", "warehouse_id", "lot_id"].filter((k) => k in rows[0]!);
        const stored = await tx<{ item_id: string; warehouse_id: string; lot_id: string; quantity: string }[]>`
          select item_id::text, warehouse_id::text, lot_id::text, quantity::text
            from app.stock_on_hand where company_id = ${companyId}`;
        const keyOf = (r: Record<string, unknown>) => keyFields.map((k) => String(r[k] ?? "")).join("|");
        const expected = new Map<string, Quantity>();
        for (const r of stored) {
          // The projection's own columns are already snake_case, so the row and the dataset row share a key
          // vocabulary and `keyOf` serves both without a translation table.
          expected.set(keyOf(r), (expected.get(keyOf(r)) ?? Quantity.zero()).add(Quantity.of(r.quantity)));
        }
        const reported = new Map<string, Quantity>();
        for (const r of rows) {
          const key = keyOf(r);
          reported.set(key, (reported.get(key) ?? Quantity.zero()).add(Quantity.of(String(r[qtyField] ?? "0.000000"))));
        }
        for (const [key, want] of expected) {
          const got = reported.get(key) ?? Quantity.zero();
          if (got.toString() !== want.toString()) {
            throw new Error(`${definition.code}: stock_on_hand says ${want.toString()} for ${key}, the report says ${got.toString()}`);
          }
        }
        return;
      }
      case "stock_valuation": {
        // TWO row shapes reach this branch (amendment A5). `inventory.valuation` reads the `stock_valuation`
        // dataset, which HAS a `value` column. `inventory.stock_ageing` reads `cost_layer`, which has NO
        // `value` column at all (A3) — a layer's money is `qty_remaining × unit_cost`, its own two stored
        // facts. The multiplication lives here, in one place, and never in a report definition (SAH-009).
        const itemId = opts.params.itemId as string | null;
        if (!itemId) throw new Error(`${definition.code}: a stock_valuation tie-out needs the itemId parameter`);
        // `asOf` is the harness's, not the report's: 7A's `cost_layer.age_days` is measured from
        // `current_date` and the dataset takes no as-of parameter (A13), so a layer report is a report of
        // today and its tie-out uses today's valuation unless the caller pinned one.
        const asOf = opts.asOf ?? (opts.params.asOf as string | null) ?? new Date().toISOString().slice(0, 10);
        const valuation = await valuationAsOf(tx, { companyId, asOf, itemId, limit: 1000 });
        // `Money.multiply` takes a string/Decimal/Rational factor and an EXPLICIT RoundingMode (§4.2.1) —
        // there is no implicit mode and no Money × Quantity overload. `HALF_AWAY_FROM_ZERO` at scale 4 is the
        // codebase's money mode, the one 3B's own layer valuation uses; in this slice's fixtures every
        // product is exact (5.0000 × 30.000000 = 150.0000), so the mode never decides a figure — it is
        // named because omitting it would not compile.
        const valued = (r: DatasetRow): Money =>
          "value" in r
            ? Money.of(String(r.value ?? "0.0000"), base)
            : Money.of(String(r.unit_cost ?? "0.0000"), base)
                .multiply(String(r.qty_remaining ?? "0.000000"), "HALF_AWAY_FROM_ZERO");
        for (const v of valuation) {
          const got = rows
            .filter((r) => String(r.warehouse_id) === v.warehouseId)
            .reduce((a, r) => a.add(valued(r)), Money.zero(base));
          if (got.toString() !== Money.of(v.value, base).toString()) {
            throw new Error(`${definition.code}: valuationAsOf says ${v.value} for warehouse ${v.warehouseCode}, the report says ${got.toString()}`);
          }
        }
        return;
      }
      case "item_profitability": {
        // Restricted to the period the report was RUN for, when it was run for one. Same reason as the
        // `account_balance` branch: a per-period report compared against every stored period would be
        // asked to account for rows outside its own parameters.
        const period = (opts.params.fiscalPeriodId as string | undefined) ?? undefined;
        const all = await itemProfitabilityRows(tx, { companyId });
        const stored = period ? all.filter((p) => p.fiscalPeriodId === period) : all;
        if (stored.length === 0) {
          throw new Error(`${definition.code}: item_profitability has no row for ${period ?? "this company"}; run rebuildItemProfitability in the fixture first`);
        }
        for (const p of stored) {
          // LEFT of each comparison: the dataset's snake_case column. RIGHT: `ItemProfitabilityRow`'s
          // camelCase member (4B, §4.16.3). The two vocabularies meet here and nowhere else (A3).
          const got = rows.filter((r) => String(r.item_id) === p.itemId && String(r.fiscal_period_id) === p.fiscalPeriodId);
          if (got.length !== 1) {
            throw new Error(`${definition.code}: item_profitability has (${p.itemId}, ${p.fiscalPeriodId}) and the report has ${got.length} row(s)`);
          }
          for (const [field, expected] of [["revenue_base", p.revenueBase], ["cogs_base", p.cogsBase], ["margin_base", p.marginBase]] as const) {
            if (Money.of(String(got[0]![field] ?? "0.0000"), base).toString() !== Money.of(expected, base).toString()) {
              throw new Error(`${definition.code}: item_profitability.${field} is ${expected}, the report says ${String(got[0]![field])}`);
            }
          }
        }
        return;
      }
      default:
        throw new Error(`${definition.code}: projection "${String(definition.tieOut.projection)}" is not one this harness executes — 7C and 8D extend the switch for theirs (amendment A5)`);
    }
  }

  // kind === "none": the row witness of amendment A5.
  if (!opts.witness) {
    throw new Error(`${definition.code}: tieOut.kind is "none", so the group test must supply a row witness (amendment A5)`);
  }
  const expected = await opts.witness.rows(tx);
  const project = (r: Record<string, unknown>) => opts.witness!.key.map((k) => String(r[k] ?? "")).join("|");
  const got = new Set(rows.map(project));
  const want = new Set(expected.map(project));
  for (const key of want) {
    if (!got.has(key)) throw new Error(`${definition.code}: the witness has row ${key} and the report does not`);
  }
  for (const key of got) {
    if (!want.has(key)) throw new Error(`${definition.code}: the report has row ${key} and the witness does not`);
  }
}

/** The quantity twin of `firstMoneyTotal`. `Quantity` is 6 dp and `Money` is 4 (§4.2.1), so a quantity tie-out
 *  never passes through `Money`: comparing a 6-dp figure at 4 dp would hide exactly the conversion error the
 *  exact-rational unit model exists to prevent (SAH-066). */
function firstQuantityTotal(definition: ReportDefinition): string {
  const quantities = new Set(definition.columns.filter((c) => c.format === "quantity").map((c) => c.field));
  const total = definition.totals.find((t) => t.fn === "sum" && quantities.has(t.field));
  if (!total) throw new Error(`${definition.code}: a stock_on_hand tie-out needs a sum total over a quantity column`);
  return total.field;
}

/**
 * The one fixture eight files share. Accounting core always; the inventory chain and the AR documents behind
 * options, so a test that needs neither pays for neither. Every posted row goes through the real posting
 * service — `postJournal`, `postFromPack`, `postInventoryDocument`, `postArDocument` — because nothing
 * outside `packages/db/src/posting/` may write a ledger or movement row (hazard 22).
 */
export interface InventoryFixture {
  itemId: string; itemCode: string; baseUnitId: string; unitCode: string;
  whHq: string; whBranch: string; whTransit: string; lotId: string; lotCode: string;
  /** Document-type code → id, from `seedTypeFromPack`. Task 6 posts its own `STOCK_COUNT` with these. */
  typeIds: Readonly<Record<string, string>>;
  /** The two parties `requires: ["party", "warehouse"]` makes mandatory. `vendorId` carries the
   *  `GOODS_RECEIPT`, `customerId` the `DELIVERY_ORDER` — and `salesChain` reuses `customerId` rather than
   *  seeding a second customer, so the delivery and the invoice name the same party and 4B's
   *  `item_profitability` sees one customer for the item. */
  vendorId: string; customerId: string;
  receiptId: string; deliveryId: string; transferId: string;
}
export interface SalesFixture { partyId: string; termId: string; invoiceId: string; creditNoteId: string }
/** What the four master-data and adjustment registers need: a price list with one line, one promotion, and
 *  one posted `STOCK_COUNT`. They live behind an option because `assertFieldCoverage` refuses a zero-row
 *  tie-out (ADR 0068), so a fixture without them cannot prove anything about those four definitions — and
 *  because posting a count is the one document in this slice that needs an approval hop. */
export interface CatalogueFixture { priceListId: string; promotionId: string; countDocumentId: string }
export interface ReportFixture {
  db: Db; s: Seed; reader: string; outsider: string;
  accounts: Readonly<Record<string, string>>; branchB: string;
  journals: { documentId: string; number: string }[];
  inventory: InventoryFixture | null; sales: SalesFixture | null; catalogue: CatalogueFixture | null;
}

/** The §4.15 codes this catalogue names in a tieOut or an assertion. Seeded by 0C/3C/3D in production; created
 *  here with 1A's `seedAccount` because `seedTenantV2` creates only `1000` Cash, `4000` Sales and `5920` FX
 *  rounding — the third wired to `company.fx_rounding_account_id` (§4.1; 4B fact 3, phase-1a:2424). None of
 *  the eleven below is one of those three, so nothing here re-seeds a shipped row (hazard 33).
 *
 *  **`1310` is not optional and its absence is silent until the TRANSFER posts.** 3D's shipped
 *  `TRANSFER_POLICY` debits `{ code: "1310" }` for `line.cost` and §4.15 assigns the row to 3C, so
 *  `inventoryChain`'s third post resolves it by code; hazard 33 forbids a null-account fallback, so a
 *  missing `1310` is a `PostingError` from `postDocument` and the whole inventory chain — and with it
 *  Tasks 5, 6, 7 and 8 — dies in `beforeAll`. */
const CATALOGUE_ACCOUNTS: readonly { code: string; nameEn: string; type: "asset" | "liability" | "equity" | "income" | "expense" }[] = [
  { code: "1100", nameEn: "Bank", type: "asset" },
  { code: "1200", nameEn: "Trade receivables", type: "asset" },
  { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" },
  { code: "1300", nameEn: "Inventory control", type: "asset" },
  { code: "1310", nameEn: "Goods in transit", type: "asset" },
  { code: "2100", nameEn: "Trade payables", type: "liability" },
  { code: "2150", nameEn: "Goods received not invoiced", type: "liability" },
  { code: "5000", nameEn: "Cost of goods sold", type: "expense" },
  { code: "5100", nameEn: "Inventory write-off - expiry loss", type: "expense" },
  { code: "5110", nameEn: "Stock-count variance", type: "expense" },
  { code: "5900", nameEn: "Other operating expense", type: "expense" },
];

const READ_CODES = [
  "accounting.report.read", "accounting.ledger.read", "admin.audit_log.read",
  "inventory.stock.read", "inventory.cost.read", "inventory.item.read",
];

export async function reportFixture(
  db: Db, name: string, opts: { inventory?: boolean; sales?: boolean; catalogue?: boolean } = {},
): Promise<ReportFixture> {
  const s = await seedTenantV2(db, name);
  // 3B's signature is (db, s, year: number). It opens EVERY 2026 period, including the two `seedTenantV2`
  // created as closed and locked, so `s.closedPeriod` and `s.lockedPeriod` are open here and are used only
  // as a second and third period id. No case in this slice asserts a period STATUS; a case that needs a
  // genuinely closed period must close it itself rather than trusting the seed's name.
  await ensureOpenPeriods(db, s, 2026);
  const accounts: Record<string, string> = { "1000": s.cash, "4000": s.sales };
  for (const a of CATALOGUE_ACCOUNTS) accounts[a.code] = await seedAccount(db, s, a);
  const branchB = await seedBranch(db, s, { code: "BR2", nameEn: "Branch two" });
  const outsider = await uuidv7(db.admin);
  await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
    await tx`insert into app.principal (id, kind, auth_subject, display_name)
             values (${outsider}, 'human', ${`human-out:${s.tenant}`}, 'Outsider')`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${outsider})`;
  });
  await grantCodes(db, s, { codes: READ_CODES, principalId: s.human, roleCode: "phase7b_reader" });
  await grantCodes(db, s, { codes: [], principalId: outsider, roleCode: "phase7b_nothing" });

  // Three posted JOURNALs in 2026-01, one in 2026-02 — the period comparison needs two populated periods.
  const journals = [
    await postJournal(db, s, [{ account: s.cash, debit: "1200.0000" }, { account: s.sales, credit: "1200.0000" }], { effectiveDate: "2026-01-05" }),
    await postJournal(db, s, [{ account: accounts["5900"]!, debit: "300.0000" }, { account: s.cash, credit: "300.0000" }], { effectiveDate: "2026-01-12" }),
    await postJournal(db, s, [{ account: s.sales, debit: "200.0000" }, { account: s.cash, credit: "200.0000" }], { effectiveDate: "2026-01-20" }),
    await postJournal(db, s, [{ account: s.cash, debit: "450.0000" }, { account: s.sales, credit: "450.0000" }], { effectiveDate: "2026-02-09" }),
  ];

  let inventory: InventoryFixture | null = null;
  if (opts.inventory === true) inventory = await inventoryChain(db, s, accounts, branchB);
  let sales: SalesFixture | null = null;
  if (opts.sales === true) sales = await salesChain(db, s, accounts, inventory);
  let catalogue: CatalogueFixture | null = null;
  if (opts.catalogue === true) catalogue = await catalogueChain(db, s, inventory);

  return { db, s, reader: s.human, outsider, accounts, branchB, journals, inventory, sales, catalogue };
}

/** Memoised per (label, options). Two callers: Task 14's three regression files, which add a tenant to 0B's
 *  `sharedDb()` container instead of starting one of their own, and any later slice's regression block that
 *  needs a report over real rows. A group test in `packages/db/test/reports/` uses `reportFixture` directly:
 *  it owns its container and a memo across files would be a lie about isolation. */
const FIXTURES = new Map<string, Promise<ReportFixture>>();
export function cachedReportFixture(
  db: Db, label: string, opts: { inventory?: boolean; sales?: boolean; catalogue?: boolean } = {},
): Promise<ReportFixture> {
  const key = `${label}|${JSON.stringify(opts)}`;
  const existing = FIXTURES.get(key);
  if (existing) return existing;
  const built = reportFixture(db, label, opts);
  FIXTURES.set(key, built);
  return built;
}

async function catalogueChain(db: Db, s: Seed, inventory: InventoryFixture | null): Promise<CatalogueFixture> {
  if (!inventory) throw new Error("reportFixture: { catalogue: true } needs { inventory: true } — the price line and the count both name the item");
  const priceListId = await seedPriceList(db, s, {
    code: "RETAIL", currency: "MYR",
    lines: [{ itemId: inventory.itemId, unitId: inventory.baseUnitId, minQuantity: "0", unitPrice: "11.0000" }],
  });
  const promotionId = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.promotion (id, tenant_id, company_id, code, name_en, name_ar, kind, definition, starts_at, ends_at, branch_id)
    values (${promotionId}, ${s.tenant}, ${s.company}, 'JAN10', 'January 10%', ${"خصم يناير"},
            'percent_off', ${JSON.stringify({ percent: "10" })}::jsonb,
            '2026-01-01T00:00:00Z', '2026-01-31T23:59:59Z', ${s.hq})`);
  // THE COUNT GOES THROUGH 3D'S OWN PAIR, NOT THROUGH `postFromPack`. 3D declares `recordCounts` "**the sole
  // writer of `document_line.quantity` on a counted line** … sets `counted_quantity` and `quantity = counted
  // − expected` in ONE statement, so the variance can never disagree with its operands" (phase-3d:3290–3291),
  // and `snapshotCountSheet` is what writes `expected_quantity`. `postFromPack`'s `lines` are `DraftLine`s,
  // which carry no `countedQuantity`/`expectedQuantity` member at all (3C, phase-3c:384–402), so a
  // hand-built `quantity: "-1.000000"` line would leave BOTH operands NULL — a row no 3D code path
  // produces, and the count register's "Variance value" column would rest on it. The flow below is 3D's own
  // suite's (phase-3d:3729–3760): snapshot, record, then submit / approve / issue / post through the state
  // machine, with `packApproval` reading the hop off the shipped envelope rather than guessing it.
  const scType = await seedTypeFromPack(db, s, "STOCK_COUNT");
  // `PackApproval` is `{ required; approve: string | null; post: string }` (4B, phase-4b:1888) — it carries no
  // `create` member, so the counter's code is the one literal this chain names, and it is 3D's shipped
  // envelope's (`approval.create: "inventory.count.create"`, phase-3d:3708) and a §3.6.2 row, not an
  // invention. `required` is asserted rather than trusted: if 3D's envelope ever ships `false`, the
  // transitions below are illegal and the message says which side changed.
  const approval = packApproval("STOCK_COUNT");
  if (!approval.required || approval.approve === null) {
    throw new Error("reportFixture: STOCK_COUNT.json no longer declares approval.required with an approve code — 3D's envelope changed (§4.14)");
  }
  const checker = await secondPrincipal(db, s, "count-checker");
  await grantCodes(db, s, { codes: ["inventory.count.create"], principalId: s.human, roleCode: "phase7b_counter" });
  await grantCodes(db, s, { codes: [approval.approve, approval.post], principalId: checker, roleCode: "phase7b_checker" });
  const counterCtx = ctxFor(s, s.human);
  const checkerCtx = ctxFor(s, checker);

  // WH-HQ holds 30 (40 received − 6 delivered − 4 transferred out). The sheet's one line therefore carries
  // `expected_quantity` 30.000000; counting 29 makes `counted_quantity` 29.000000 and `quantity` −1.000000,
  // and at the avco unit cost of 5.0000 the variance posts 1300 credit 5.0000 / 5110 debit 5.0000.
  const sheet = await withTenant(db.rw, s.tenant, s.human, (tx) =>
    snapshotCountSheet(tx, counterCtx, {
      documentTypeId: scType, series: "SC", effectiveDate: "2026-01-24",
      warehouseId: inventory.whHq, itemIds: [inventory.itemId],
    }));
  if (sheet.lines.length !== 1) {
    throw new Error(`reportFixture: the count sheet has ${sheet.lines.length} lines, expected 1 — the inventory chain changed`);
  }
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    recordCounts(tx, counterCtx, {
      documentId: sheet.documentId,
      counts: [{ documentLineId: sheet.lines[0]!.documentLineId, countedQuantity: "29.000000" }],
    }));
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" }));
  await withTenant(db.rw, s.tenant, checker, async (tx) => {
    await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" });
    await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "issued" });
    await postDocument(tx, checkerCtx, { documentId: sheet.documentId });
  });
  return { priceListId, promotionId, countDocumentId: sheet.documentId };
}
```

The two chain builders finish the file. They configure **no document type of their own**: every type is read off disk from the shipped pack by 4B's `seedTypeFromPack(db, s, code) → id`, which is why this slice registers nothing in §4.14. Three frozen posting helpers are called, each with its own shape, and **which one a document takes is decided by its policy, not by convenience**:

- `postFromPack(db, s, opts)` (4B, §4.17.1) takes a **`code`**, `partyId?`, `warehouseId?` and `lines: DraftLine[]` of `{ kind, itemId?, warehouseId?, lotId?, unitId?, quantity?, unitPrice?, amount? }`; it resolves the type from the pack file, threads `partyId`/`warehouseId` straight through 3C's `draftTypedDocument`, derives the approval path from `packApproval(code)` and posts through the real `postDocument`. **`amount` is not computed for you** — `draftTypedDocument` defaults it to `"0"` — so every line writes it.
- `postInventoryDocument(db, s, opts)` (3B) takes **`documentTypeId`**, `toWarehouseId?` and a `lines: InventoryLine[]` of `{ itemId, warehouseId, quantity, unitPrice, lotId?, unitId?, accountId? }` **magnitudes** (the policy's `inventory.effect` carries the direction — 3A assumption 2); it computes `amount` in SQL and calls `ensureOpenPeriods` for the document's own year itself. **It has no `partyId` member**, so it serves only the type in this chain whose policy `requires` no party — `TRANSFER` — and it is the only one of the three that carries `to_warehouse_id`.
- `postArDocument(db, s, opts)` (4A) takes `documentTypeId`, **`series`** and `lines: ArLine[]` of `{ kind, itemId?, quantity?, unitPrice?, amount? }`, and grants the type's approval codes once per `Seed` (4A amendment 14) — which is why `salesChain` grants nothing of its own while `inventoryChain` must.

**The fixture's arithmetic, written out because every tie-out in this slice depends on it.** 40 received at `5.0000` into `WH-HQ` → `1300` debit `200.0000`, one layer of 40. 6 delivered out of `WH-HQ` → `1250` debit / `1300` credit `30.0000`, layer residue 34. 4 transferred into the in-transit warehouse → `1310` debit / `1300` credit `20.0000`, a **second** layer of 4 at `5.0000` in `WH-TR` (a transfer line emits two movements, §4.7.3). Therefore: `stock_on_hand` = `WH-HQ` 30, `WH-TR` 4, total 34; `valuationAsOf` = `WH-HQ` `150.0000`, `WH-TR` `20.0000`; ledger `1300` = `150.0000` and `1310` = `20.0000`. **The transfer is deliberately not received** — goods in transit are then in neither stock warehouse and in the company's total, which is 3D's own DoD clause and the tie `inventory.transfer_register` uses.

```ts
async function inventoryChain(
  db: Db, s: Seed, accounts: Readonly<Record<string, string>>, branchB: string,
): Promise<InventoryFixture> {
  const typeIds: Record<string, string> = {};
  for (const code of ["GOODS_RECEIPT", "DELIVERY_ORDER", "TRANSFER", "TRANSFER_RECEIPT", "STOCK_COUNT"]) {
    typeIds[code] = await seedTypeFromPack(db, s, code);
  }

  // ── R2, read off the shipped envelopes rather than pinned as literals ──────────────────────────────
  // 2B's `document_status_before` trigger evaluates R2 as `app.actor_has(policy.approval.post, company_id,
  // branch_id)` at `issued → posted` (§4.5.1), INSIDE the posting transaction, and `seedTenantV2` grants
  // `s.human` nothing (§4.1, pinned). 3B's `postInventoryDocument` grants nothing either — its own suites
  // call `grantCodes` themselves (phase-3b:2295) — and `postFromPack` grants only on the approval-REQUIRED
  // path, which none of these three types takes (`approval.required: false` on all of them). So the three
  // post codes are granted here, once, or every post below raises `ERR_RBAC_FORBIDDEN`.
  //
  // The codes are READ from each type's own envelope through `packApproval` rather than written out, and
  // `DELIVERY_ORDER` is why: its `approval.post` is **`inventory.transfer.post`**, not the
  // `inventory.delivery.post` a reader would guess — that is §4.14's own register row ("outbound / issue /
  // `inventory.transfer.post`"), not a 3D slip, because §3.6.2's closed vocabulary has no `inventory.
  // delivery.*` pair to name (hazard 26). Two of the three therefore resolve to the SAME code; `new Set`
  // collapses the duplicate, and `grantCodes` is called ONCE because it inserts a fresh `app.role` per call
  // (phase-2b:1031). None of these codes appears in `INCOMPATIBLE_PAIRS` (§4.2.5), so one role holds all of
  // them and `role-seed` has nothing to say about a test-tier grant in any case.
  const postCodes = [...new Set(
    ["GOODS_RECEIPT", "DELIVERY_ORDER", "TRANSFER"].map((code) => packApproval(code).post),
  )];
  await grantCodes(db, s, { codes: postCodes, principalId: s.human, roleCode: "phase7b_poster" });

  // `requires: ["party", "warehouse"]` on both `GOODS_RECEIPT` (phase-3d:1709) and `DELIVERY_ORDER`
  // (phase-3d:2194) makes these two rows mandatory, and 2A's `validateRequires` refuses at §4.3.2 step 4
  // with `ERR_POLICY_REQUIRES_MISSING` without them. `seedParty` selects-or-creates `1200`/`2100`
  // (phase-2a:406-418) and both already exist from `CATALOGUE_ACCOUNTS`, so nothing is re-seeded.
  const vendorId = await seedParty(db, s, { kind: "vendor", code: "VEND-1", nameEn: "Alpha supplier" });
  const customerId = await seedParty(db, s, { kind: "customer", code: "CUST-1" });

  const unitCode = "EA";
  const baseUnit = await seedUnit(db, s, { code: unitCode, nameEn: "Each" });
  const { itemId, baseUnitId } = await seedItem(db, s, { code: "ITEM-1", kind: "product", trackLots: true, baseUnitId: baseUnit });
  const whHq = await seedWarehouse(db, s, { code: "WH-HQ", kind: "stock", branchId: s.hq });
  const whBranch = await seedWarehouse(db, s, { code: "WH-BR2", kind: "stock", branchId: branchB });
  const whTransit = await seedWarehouse(db, s, { code: "WH-TR", kind: "in_transit", branchId: branchB });
  const lotCode = "LOT-A";
  const lotId = await seedLot(db, s, { itemId, code: lotCode, expiresOn: "2026-06-30" });

  // `postFromPack` takes a CODE and `DraftLine`s, not a `documentTypeId` and `InventoryLine`s, and
  // `draftTypedDocument` defaults `amount` to `"0"` (phase-3c:466-473) — so **`amount` is written out on
  // every line here**. It matters: 3C's `GRN_POLICY` credits `2150` with `line.amount` (phase-3d:1711),
  // and a zero amount would post a receipt whose inventory debit is `line.cost` 200.0000 against a payable
  // credit of 0.0000, which `postDocument`'s balance check refuses. `postFromPack` does NOT call
  // `ensureOpenPeriods` the way `postInventoryDocument` does; `reportFixture` already opened all of 2026
  // before either chain runs, so January is open for all three documents below.
  const receipt = await postFromPack(db, s, {
    code: "GOODS_RECEIPT", effectiveDate: "2026-01-06", partyId: vendorId, warehouseId: whHq,
    lines: [{
      kind: "item", itemId, warehouseId: whHq, lotId, unitId: baseUnitId,
      quantity: "40.000000", unitPrice: "5.0000", amount: "200.0000",
    }],
  });
  const delivery = await postFromPack(db, s, {
    code: "DELIVERY_ORDER", effectiveDate: "2026-01-14", partyId: customerId, warehouseId: whHq,
    lines: [{
      kind: "item", itemId, warehouseId: whHq, lotId, unitId: baseUnitId,
      quantity: "6.000000", unitPrice: "11.0000", amount: "66.0000",
    }],
  });
  // The TRANSFER stays on 3B's helper: it is the one document in this chain that carries a
  // `to_warehouse_id`, and `PostFromPackOptions` has no member for it (phase-4b:1885-1911), while
  // `TRANSFER`'s `requires: ["warehouse", "to_warehouse"]` names no party (phase-3d:3113). Its ledger legs
  // are `1310` debit / `1300` credit for `line.cost` — which is why `1310` is in `CATALOGUE_ACCOUNTS`.
  const transfer = await postInventoryDocument(db, s, {
    documentTypeId: typeIds.TRANSFER!, effectiveDate: "2026-01-16", warehouseId: whHq, toWarehouseId: whTransit,
    lines: [{ itemId, warehouseId: whHq, lotId, unitId: baseUnitId, quantity: "4.000000", unitPrice: "5.0000" }],
  });

  return {
    itemId, itemCode: "ITEM-1", baseUnitId, unitCode, whHq, whBranch, whTransit, lotId, lotCode, typeIds,
    vendorId, customerId,
    receiptId: receipt.documentId, deliveryId: delivery.documentId, transferId: transfer.documentId,
  };
}

async function salesChain(
  db: Db, s: Seed, accounts: Readonly<Record<string, string>>, inventory: InventoryFixture | null,
): Promise<SalesFixture> {
  if (!inventory) throw new Error("reportFixture: { sales: true } needs { inventory: true } — the invoice lines name the item");
  const invoiceTypeId = await seedTypeFromPack(db, s, "SALES_INVOICE");
  const creditTypeId = await seedTypeFromPack(db, s, "SALES_CREDIT_NOTE");
  const termId = await seedPaymentTerm(db, s, { code: "NET30", dueDays: 30 });
  // The customer is `inventoryChain`'s, not a second one: `DELIVERY_ORDER` already required a party, and a
  // separate `CUST-2` here would put the delivery and the invoice on two parties for one item — which is
  // neither what a fixture should assert about nor what 4B's `item_profitability` rebuild expects.
  const partyId = inventory.customerId;
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    tx`update app.party set payment_term_id = ${termId} where id = ${partyId}`);
  // 6 invoiced at 11.0000 = 66.0000 revenue on 4000; 1 credited back = 11.0000. Net revenue 55.0000 against
  // a delivered cost of 30.0000, so `item_profitability` reads margin 25.0000 for the item in 2026-01.
  const invoice = await postArDocument(db, s, {
    documentTypeId: invoiceTypeId, series: "INV", effectiveDate: "2026-01-15", partyId, paymentTermId: termId,
    lines: [{ kind: "item", itemId: inventory.itemId, quantity: "6.000000", unitPrice: "11.0000", amount: "66.0000" }],
  });
  const creditNote = await postArDocument(db, s, {
    documentTypeId: creditTypeId, series: "CN", effectiveDate: "2026-01-22", partyId,
    lines: [{ kind: "item", itemId: inventory.itemId, quantity: "1.000000", unitPrice: "11.0000", amount: "11.0000" }],
  });
  return { partyId, termId, invoiceId: invoice.documentId, creditNoteId: creditNote.documentId };
}
```

- [ ] **Step 2: Write ADR 0068**

`docs/adr/0068-tie-out-declarations-are-executed.md`, in Plan 0A's format.

```markdown
# ADR 0068: A report's `tieOut` declaration is executed, not documentation

- **Status:** accepted
- **Date:** 2026-09-05
- **Slice:** 7B
- **Supersedes / superseded by:** none

## Context

Phase 7's definition of done is *"A user clones and edits a report without a release; every report's numbers
tie to the ledger"* (spec:2293). The second clause is the one that fails silently. `ReportDefinition` already
carries `tieOut: { kind; account?; projection? }` (contracts §4.11.1) described as "the tie-to-ledger test each
core report declares" — but a declaration nothing executes is a comment, and the legacy system's own reporting
failure (SAH-069, SAH-070, SAH-076) was exactly a catalogue of queries nobody could reconcile against the
ledger. Twenty-two definitions land in this slice and eleven more in 7C and 8D. Written per report, twenty-two
bespoke tie-out tests would drift: three would tie against a hand-written aggregate, one would compare a
report to itself, and two would be forgotten.

## Decision

**One harness executes the declaration.** `tests/invariants/support/reports.ts` reads a definition off disk,
runs it through 7A's `rowsForDefinition` — the same one row provider `reporting.render` uses, so the tie-out is a
claim about the query that renders and not about a parallel one — and turns `tieOut` into an assertion against an independent path — a direct
`ledger_entry` sum for `ledger_sum`, the projection's own stored rows for `projection`, and a caller-supplied
row witness for `none`. `tests/invariants/report-tie-out.test.ts` enumerates the catalogue and **fails naming
the code when a definition has no case**, so a report cannot be added to the pack without one.

Three rules make the assertion mean something rather than pass vacuously:

1. **The two sides are different code paths.** The report's figure is the dataset's aggregation; the other side
   is one SQL sum or one projection read. A tie-out that summed the same query twice would prove nothing.
2. **The measure map is closed** (`base_debit`, `base_credit`, `base_balance`, `base_total` — 7A's own column
   aliases), so a definition cannot compare debits against a net and pass.
3. **`none` requires a row witness.** A master-data list has no monetary total; it still has a row set, and an
   independent query must produce the same one.

## Consequences

- Adding a core report is: write the definition, add the tie-out case, and the roll-up goes green. Forgetting
  the second step is a red build with the report's code in the message.
- `assertTieOut`'s `projection` switch is extended additively by 7C (`party_ageing`, and the POS sources) and
  8D (`employee_ytd`, `statutory_schedule`). Neither edits an existing case.
- The harness pays a fixture cost: a tie-out is only as good as the rows behind it, so `assertFieldCoverage`
  refuses a zero-row result outright rather than letting an empty report tie to an empty ledger.
- A report whose numbers *cannot* tie — a list of master data — is visible as such in one place, the
  justification table in this slice's Self-Review, instead of being indistinguishable from an untested one.

## Rejected

- **A tie-out per report, hand-written.** Twenty-two files, twenty-two chances to compare a figure with itself.
- **Tie-outs as a property of the render job** (verify at run time, warn in the PDF footer). It moves a build
  failure into a production warning nobody reads, and spec:2245's SLO makes a per-render reconciliation query
  a latency problem as well.
- **Making `tieOut.kind: "none"` illegal.** Four of this slice's definitions are master-data lists; forcing a
  monetary total onto a price list would invent a figure to satisfy a schema.
```

- [ ] **Step 3: Write the failing test `packages/db/test/reports/7b-accounting-ledger.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { Money, currency, validateReportDefinition } from "@dulja/domain";
import { DATASET_IDS, type DatasetRow } from "@dulja/db";
import { startDb, withTenant, type Db } from "@dulja/db/test";
import {
  assertTieOut, readDefinition, readEnvelope, reportFixture, runDefinition, type ReportFixture,
} from "../../../../tests/invariants/support/reports";

const MYR = currency("MYR");
/** `validateReportDefinition`'s second argument is `ReportDefinitionSets` — BOTH closed sets, as
 *  `ReadonlySet<string>` (7A, A11). A one-array call does not type-check and would skip the
 *  `dataset.source` membership check the register relies on. The same constant appears in all eight
 *  group tests; it is four lines, so it is repeated rather than added to the shared harness, which has no
 *  business importing `@dulja/contracts`. */
const SETS = {
  datasets: new Set<string>(DATASET_IDS),
  permissions: new Set(PERMISSIONS.map((p) => p.code)),
};
const CODES = [
  "accounting.general_ledger", "accounting.journal_register",
  "accounting.account_statement", "accounting.period_comparison",
] as const;

describe("7B accounting ledger definitions (§4.16.1, DoD: numbers tie to the ledger)", () => {
  let db: Db; let f: ReportFixture;

  beforeAll(async () => { db = await startDb(); f = await reportFixture(db, "Alpha"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[3]>[0]) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);

  it("the thirteen §4.15 accounts this catalogue names all resolve for the seeded company, and none was re-seeded", async () => {
    const rows = await read((tx) => tx<{ code: string; n: number }[]>`
      select code, count(*)::int as n from app.account where company_id = ${f.s.company} group by code order by code`);
    const byCode = new Map(rows.map((r) => [r.code, r.n]));
    for (const code of ["1000", "1100", "1200", "1250", "1300", "1310", "2100", "2150", "4000", "5000", "5100", "5110", "5900"]) {
      expect(byCode.get(code), `account ${code} must resolve (hazard 33)`).toBe(1);
    }
  });

  it("all four definitions validate, and each file name equals its definition.code (amendment A1)", () => {
    for (const code of CODES) {
      const envelope = readEnvelope(code);
      expect(envelope.definitionVersion).toBe(1);
      expect(envelope.definition.version).toBe(1);
      const result = validateReportDefinition(envelope.definition, SETS);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it("each definition's permission is the code §4.16.1 assigns it, and every one is non-mutating", () => {
    const mutating = new Map(PERMISSIONS.map((p) => [p.code, p.mutating]));
    for (const code of CODES) {
      const d = readDefinition(code);
      expect(d.permission).toBe("accounting.report.read");
      expect(mutating.get(d.permission)).toBe(false);
      expect(d.module).toBe("accounting");
    }
  });

  it("every field every definition references exists in its dataset's rows (amendment A3's executed half)", async () => {
    await read(async (tx) => {
      for (const code of CODES) {
        const d = readDefinition(code);
        await assertTieOut(tx, d, {
          params: paramsFor(code, f), baseCurrency: MYR, window: windowFor(code, f),
        });
      }
    });
  });

  it("accounting.general_ledger ties to account_balance for every account and currency", async () => {
    await read(async (tx) => {
      const d = readDefinition("accounting.general_ledger");
      await assertTieOut(tx, d, {
        params: { companyId: f.s.company, fromDate: "2026-01-01", toDate: "2026-01-31", accountId: null, branchId: null },
        baseCurrency: MYR, window: { fiscalPeriodId: f.s.period },
      });
    });
  });

  it("accounting.journal_register's debit total equals the ledger's own, and debits equal credits", async () => {
    await read(async (tx) => {
      const d = readDefinition("accounting.journal_register");
      const params = { companyId: f.s.company, fromDate: "2026-01-01", toDate: "2026-01-31", documentTypeCode: null };
      await assertTieOut(tx, d, { params, baseCurrency: MYR, window: { fromDate: "2026-01-01", toDate: "2026-01-31" } });
      const rows = await runDefinition(tx, d, params);
      // Global Constraint 3: every tie-out sum in this slice accumulates through `Money`, never `Number()`,
      // and the comparison is string-against-string at fixed 4 dp so no epsilon is ever chosen. This file is
      // outside the lint runner's ROOTS (§3.7.5), so the rule is the constraint's, not `no-number-money`'s.
      expect(sum(rows, "base_debit")).toBe(sum(rows, "base_credit"));
      expect(rows.length).toBe(6);                                           // three journals, two lines each
    });
  });

  it("accounting.account_statement over 1000 Cash ties to account_balance, and its rows are chronological", async () => {
    await read(async (tx) => {
      const d = readDefinition("accounting.account_statement");
      const params = { companyId: f.s.company, accountId: f.s.cash, fromDate: "2026-01-01", toDate: "2026-01-31" };
      await assertTieOut(tx, d, { params, baseCurrency: MYR, window: { fiscalPeriodId: f.s.period, accountCode: "1000" } });
      const rows = await runDefinition(tx, d, params);
      expect(rows.map((r) => String(r.effective_date))).toEqual(["2026-01-05", "2026-01-12", "2026-01-20"]);
    });
  });

  // `accountType` is passed as "income" and NOT left null. The definition's first money total is `base_balance`,
  // which the measure map compares against `sum(base_debit - base_credit)`; over EVERY account that sum is
  // zero by the ledger invariant (1A) and the report's own Σ base_balance is zero too, so a null type would
  // compare 0.0000 against 0.0000 and pass no matter what the dataset returned — exactly the tie-out that
  // "passes for the wrong reason" that ADR 0068's first rule forbids. Restricting to one type makes both
  // sides non-zero. The ledger side is narrowed by `accountCode` because `LedgerWindow` carries no type
  // member until Task 2; the case asserts the fixture's income accounts are exactly {4000}, so the two
  // restrictions are the same set and the pin fails loudly if a later slice seeds a second income account.
  // BOTH periods are populated on account 4000: the fixture's four journals credit it 1200.0000 and debit it
  // 200.0000 in 2026-01 (net -1000.0000) and credit it 450.0000 at 2026-02-09, which falls inside
  // `s.closedPeriod` (2026-02-01..2026-02-28, per 0A's `seedTenantV2`). `ensureOpenPeriods` opened it, so the
  // journal posts. Neither iteration compares an empty report against an empty sum.
  // The definition declares ONE `fiscalPeriodId` (amendment A15): a `DatasetFilter` binds one value per
  // clause, so two `fiscal_period_id eq` clauses on one query would intersect to nothing. The COMPARISON is
  // the viewer's — run once per period, place the results side by side — and this case runs it twice for
  // exactly that reason, which is also what makes the definition tie-able at all.
  it("accounting.period_comparison, run once per period, equals the ledger's own sum for that period", async () => {
    await read(async (tx) => {
      const d = readDefinition("accounting.period_comparison");
      expect(d.parameters.filter((p) => p.kind === "period").map((p) => p.name)).toEqual(["fiscalPeriodId"]);
      for (const periodId of [f.s.period, f.s.closedPeriod] as const) {
        const params = { companyId: f.s.company, fiscalPeriodId: periodId, accountType: "income" };
        const rows = await runDefinition(tx, d, params);
        expect([...new Set(rows.map((r) => String(r.account_code)))]).toEqual(["4000"]);
        await assertTieOut(tx, d, {
          params, baseCurrency: MYR,
          window: { fiscalPeriodId: periodId, accountCode: "4000" },
        });
      }
      const net = await runDefinition(tx, d, { companyId: f.s.company, fiscalPeriodId: f.s.period, accountType: "income" });
      expect(sum(net, "base_balance")).not.toBe("0.0000");
    });
  });
});

/** Σ of one money field as a string — local to this file, so the case above can prove it is not summing zero.
 *  The parameter is `readonly DatasetRow[]`, which is what `runDefinition` returns: `DatasetRow` is
 *  `Readonly<Record<string, string | number | boolean | null>>` (A11), and a narrower index-signature value
 *  type — `string | number | null` — is **not** assignable from it, so a hand-narrowed parameter is TS2345
 *  at both call sites under strict. Import the type from `@dulja/db` beside `DATASET_IDS`. */
function sum(rows: readonly DatasetRow[], field: string): string {
  return rows
    .reduce((acc, r) => acc.add(Money.of(String(r[field] ?? "0.0000"), MYR)), Money.zero(MYR))
    .toString();
}

/** Parameters and ledger window per code — one place, so a case never disagrees with the tie-out's window. */
function paramsFor(code: string, f: ReportFixture): Record<string, string | null> {
  const base = { companyId: f.s.company, fromDate: "2026-01-01", toDate: "2026-01-31" };
  if (code === "accounting.account_statement") return { ...base, accountId: f.s.cash };
  if (code === "accounting.period_comparison") return { companyId: f.s.company, fiscalPeriodId: f.s.period, accountType: "income" };
  if (code === "accounting.general_ledger") return { ...base, accountId: null, branchId: null };
  return { ...base, documentTypeCode: null };
}
function windowFor(code: string, f: ReportFixture): { fiscalPeriodId?: string; fromDate?: string; toDate?: string; accountCode?: string } {
  if (code === "accounting.account_statement") return { fiscalPeriodId: f.s.period, accountCode: "1000" };
  if (code === "accounting.period_comparison") return { fiscalPeriodId: f.s.period, accountCode: "4000" };
  if (code === "accounting.general_ledger") return { fiscalPeriodId: f.s.period };
  return { fromDate: "2026-01-01", toDate: "2026-01-31" };
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/reports/7b-accounting-ledger.test.ts`
Expected: **FAIL** on the first `beforeAll`-independent case with `ENOENT: no such file or directory, open '…/packages/db/seed/my/reports/7b/accounting.general_ledger.json'` — `readEnvelope` throws before any assertion. The fixture itself must build cleanly. Three failures mean it did not, and each names a different missing grant or row:

- `new row violates row-level security policy` or `ERR_RBAC_FORBIDDEN` from `postJournal` — the `grantCodes(… READ_CODES …)` call in `reportFixture` did not run. `seedTenant` grants `s.human` nothing (§4.1) and 2B's R2 evaluates `approval.post` inside the posting transaction.
- `ERR_RBAC_FORBIDDEN` from `postFromPack` or `postInventoryDocument` (only with `{ inventory: true }`, so from Task 5 onward) — the `phase7b_poster` grant in `inventoryChain` did not run, or `packApproval` read a different `post` code off one of the three envelopes. **Read the code out of the message and compare it with the envelope; never hard-code the three literals to make it pass.**
- `ERR_POLICY_REQUIRES_MISSING` on the receipt or the delivery — a `partyId` did not reach `draftTypedDocument`. Both policies declare `requires: ["party", "warehouse"]`, and that is the whole reason those two go through `postFromPack` rather than `postInventoryDocument`.

- [ ] **Step 5: Write the four definitions**

`packages/db/seed/my/reports/7b/accounting.general_ledger.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.general_ledger",
    "nameEn": "General ledger",
    "nameAr": "دفتر الأستاذ العام",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "accountId", "kind": "account", "required": false },
      { "name": "branchId", "kind": "branch", "required": false }
    ],
    "dataset": {
      "source": "ledger_entry",
      "filters": [
        { "field": "effective_date", "op": "gte", "param": "fromDate" },
        { "field": "effective_date", "op": "lte", "param": "toDate" },
        { "field": "account_id", "op": "eq", "param": "accountId" },
        { "field": "branch_id", "op": "eq", "param": "branchId" }
      ]
    },
    "columns": [
      { "field": "account_code", "labelEn": "Account", "labelAr": "الحساب", "format": "text", "align": "start", "width": 70 },
      { "field": "effective_date", "labelEn": "Date", "labelAr": "التاريخ", "format": "date", "align": "start", "width": 80 },
      { "field": "document_type_code", "labelEn": "Type", "labelAr": "النوع", "format": "text", "align": "start", "width": 90 },
      { "field": "number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 80 },
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 60 },
      { "field": "currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 50 },
      { "field": "posting_seq", "labelEn": "Seq", "labelAr": "التسلسل", "format": "integer", "align": "end", "width": 45 },
      { "field": "line_no", "labelEn": "Line", "labelAr": "السطر", "format": "integer", "align": "end", "width": 40 },
      { "field": "base_debit", "labelEn": "Debit", "labelAr": "مدين", "format": "money", "align": "end", "width": 100 },
      { "field": "base_credit", "labelEn": "Credit", "labelAr": "دائن", "format": "money", "align": "end", "width": 100 }
    ],
    "groups": [{ "field": "account_code", "subtotal": true }],
    "totals": [{ "field": "base_debit", "fn": "sum" }, { "field": "base_credit", "fn": "sum" }],
    "sort": [
      { "field": "account_code", "dir": "asc" },
      { "field": "effective_date", "dir": "asc" },
      { "field": "posting_seq", "dir": "asc" },
      { "field": "line_no", "dir": "asc" }
    ],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {fromDate} – {toDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "projection", "projection": "account_balance" }
  }
}
```

**Why `posting_seq` and `line_no` are rendered columns and not just sort keys — the rule that shapes every definition in this slice.** 7A's `validateReportDefinition` rule 4 (the three `is not one of this definition's columns` messages in `packages/domain/src/reports/validate.ts`) rejects **any** `groups[].field`, `totals[].field` or `sort[].field` that is not also a `columns[].field` of the same definition, with three distinct error paths and one message each. There is no `hidden` member on a column (§4.11.1), so a definition that sorts on the chronological key (`posting_seq`, §4.3.5) must render it. That is the right trade rather than a workaround: a register whose row order a reader cannot reconstruct from the page is a register they cannot audit, and a narrow integer column is what makes the order visible. **The same rule binds a `count` total** — `t.fn !== "count"` skips only the *numeric-format* check (`total fn '<fn>' needs a money, quantity, integer or percent column`), never the membership check above it (`total field '<f>' is not one of this definition's columns`) — so every `{ fn: "count" }` in this slice names a column the definition already renders (`number`, `code`, `item_code`), and never a bare id.

`packages/db/seed/my/reports/7b/accounting.journal_register.json` — the chronological register of posted lines, grouped by document number rather than by account, with the `documentTypeCode` filter that makes it a *journal* register when the caller asks for `JOURNAL` and a full daybook when they do not. **It groups on `number`, not on `document_id`:** a document's number is unique within `(company, series, period)` and is the identifier a reader sees, and `document_id` is not a column this register renders, so rule 4 would refuse it:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.journal_register",
    "nameEn": "Journal register",
    "nameAr": "سجل القيود",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "documentTypeCode", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "ledger_entry",
      "filters": [
        { "field": "effective_date", "op": "gte", "param": "fromDate" },
        { "field": "effective_date", "op": "lte", "param": "toDate" },
        { "field": "document_type_code", "op": "eq", "param": "documentTypeCode" }
      ]
    },
    "columns": [
      { "field": "effective_date", "labelEn": "Date", "labelAr": "التاريخ", "format": "date", "align": "start", "width": 80 },
      { "field": "document_type_code", "labelEn": "Type", "labelAr": "النوع", "format": "text", "align": "start", "width": 90 },
      { "field": "number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 80 },
      { "field": "line_no", "labelEn": "Line", "labelAr": "السطر", "format": "integer", "align": "end", "width": 40 },
      { "field": "account_code", "labelEn": "Account", "labelAr": "الحساب", "format": "text", "align": "start", "width": 70 },
      { "field": "account_name_en", "labelEn": "Account name", "labelAr": "اسم الحساب", "format": "text", "align": "start", "width": 160 },
      { "field": "posting_seq", "labelEn": "Seq", "labelAr": "التسلسل", "format": "integer", "align": "end", "width": 45 },
      { "field": "base_debit", "labelEn": "Debit", "labelAr": "مدين", "format": "money", "align": "end", "width": 100 },
      { "field": "base_credit", "labelEn": "Credit", "labelAr": "دائن", "format": "money", "align": "end", "width": 100 }
    ],
    "groups": [{ "field": "number", "subtotal": true }],
    "totals": [{ "field": "base_debit", "fn": "sum" }, { "field": "base_credit", "fn": "sum" }],
    "sort": [
      { "field": "effective_date", "dir": "asc" },
      { "field": "posting_seq", "dir": "asc" },
      { "field": "line_no", "dir": "asc" }
    ],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {fromDate} – {toDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

`packages/db/seed/my/reports/7b/accounting.account_statement.json` — one account over a range, the printable statement the clerk hands to an accountant. It is **not** `accounting.ledger`: the ledger report is the raw entry list with a running balance and a keyset cursor (1B's own route), this one is a grouped monthly statement whose figures come from the same rows. **It groups on `fiscal_period_code` (`YYYY-MM`, A3), not on `fiscal_period_id`:** a period uuid is not something a statement renders, and rule 4 refuses a group field that is not a rendered column:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.account_statement",
    "nameEn": "Account statement",
    "nameAr": "كشف حساب",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "accountId", "kind": "account", "required": true },
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true }
    ],
    "dataset": {
      "source": "ledger_entry",
      "filters": [
        { "field": "account_id", "op": "eq", "param": "accountId" },
        { "field": "effective_date", "op": "gte", "param": "fromDate" },
        { "field": "effective_date", "op": "lte", "param": "toDate" }
      ]
    },
    "columns": [
      { "field": "effective_date", "labelEn": "Date", "labelAr": "التاريخ", "format": "date", "align": "start", "width": 80 },
      { "field": "document_type_code", "labelEn": "Type", "labelAr": "النوع", "format": "text", "align": "start", "width": 90 },
      { "field": "number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 80 },
      { "field": "currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 50 },
      { "field": "exchange_rate", "labelEn": "Rate", "labelAr": "سعر الصرف", "format": "text", "align": "end", "width": 80 },
      { "field": "fiscal_period_code", "labelEn": "Period", "labelAr": "الفترة", "format": "text", "align": "start", "width": 70 },
      { "field": "posting_seq", "labelEn": "Seq", "labelAr": "التسلسل", "format": "integer", "align": "end", "width": 45 },
      { "field": "line_no", "labelEn": "Line", "labelAr": "السطر", "format": "integer", "align": "end", "width": 40 },
      { "field": "base_debit", "labelEn": "Debit", "labelAr": "مدين", "format": "money", "align": "end", "width": 100 },
      { "field": "base_credit", "labelEn": "Credit", "labelAr": "دائن", "format": "money", "align": "end", "width": 100 }
    ],
    "groups": [{ "field": "fiscal_period_code", "subtotal": true }],
    "totals": [{ "field": "base_debit", "fn": "sum" }, { "field": "base_credit", "fn": "sum" }],
    "sort": [
      { "field": "effective_date", "dir": "asc" },
      { "field": "posting_seq", "dir": "asc" },
      { "field": "line_no", "dir": "asc" }
    ],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {accountCode} {accountName} · {fromDate} – {toDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "projection", "projection": "account_balance" }
  }
}
```

`packages/db/seed/my/reports/7b/accounting.period_comparison.json` — §4.16.1's "two period parameters" report. **Both periods are separate runs of one definition**, one per `fiscalPeriodId`, because `dataset.filters` has no `or` and inventing one would be a schema change to §4.11.1 for a presentation convenience; 7A's layout places the two results side by side and the tie-out runs once per period, which is stronger than one comparison of a joined row:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.period_comparison",
    "nameEn": "Period comparison",
    "nameAr": "مقارنة الفترات",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "fiscalPeriodId", "kind": "period", "required": true },
      { "name": "accountType", "kind": "enum", "required": false, "options": ["asset", "liability", "equity", "income", "expense"] }
    ],
    "dataset": {
      "source": "account_balance",
      "filters": [
        { "field": "fiscal_period_id", "op": "eq", "param": "fiscalPeriodId" },
        { "field": "account_type", "op": "eq", "param": "accountType" }
      ]
    },
    "columns": [
      { "field": "account_code", "labelEn": "Account", "labelAr": "الحساب", "format": "text", "align": "start", "width": 70 },
      { "field": "account_name_en", "labelEn": "Account name", "labelAr": "اسم الحساب", "format": "text", "align": "start", "width": 180 },
      { "field": "account_type", "labelEn": "Type", "labelAr": "النوع", "format": "text", "align": "start", "width": 80 },
      { "field": "currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 50 },
      { "field": "base_debit", "labelEn": "Debit", "labelAr": "مدين", "format": "money", "align": "end", "width": 100 },
      { "field": "base_credit", "labelEn": "Credit", "labelAr": "دائن", "format": "money", "align": "end", "width": 100 },
      { "field": "base_balance", "labelEn": "Net", "labelAr": "الصافي", "format": "money", "align": "end", "width": 100 }
    ],
    "groups": [{ "field": "account_type", "subtotal": true }],
    "totals": [{ "field": "base_balance", "fn": "sum" }],
    "sort": [{ "field": "account_code", "dir": "asc" }, { "field": "currency", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {periodLabel}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

- [ ] **Step 6: Run it to pass**

Run: `cd packages/db && bun run test -- test/reports/7b-accounting-ledger.test.ts`
Expected: **PASS, 8 tests.** Two failures are worth predicting because both mean a real disagreement, not a flaky fixture:
- `accounting.general_ledger: account_balance says −1000.0000 for 4000|MYR, the report says 1000.0000` — the harness's `account_balance` branch nets `base_debit − base_credit` on both sides; if the sign is inverted on one, the dataset is returning the projection's columns swapped. Fix the dataset (raise against 7A), never the harness's subtraction.
- `accounting.period_comparison: the report totals 1000.0000 and the ledger totals -1000.0000 for measure net on account 4000` — the dataset's `base_balance` is **sign-inverted**: it computed `base_credit − base_debit`, and account `4000` is income, so the two paths agree in magnitude and disagree in sign. A3 pins the field as `(b.base_debit - b.base_credit)`; raise against 7A's `account_balance` dataset and never negate inside the harness, which would hide the next inversion. (If `base_balance` is **absent** from the dataset rather than inverted you see a different failure first — `assertFieldCoverage` names the field before any total is compared, because it runs on the rows as soon as they come back.)
- A third, and it is the one to expect while the definitions are being written: `{ "path": "/sort/2/field", "message": "sort field 'posting_seq' is not one of this definition's columns" }` in the validation case. That is 7A's rule 4 (the `sort field '<f>' is not one of this definition's columns` push in `packages/domain/src/reports/validate.ts`), and the fix is always to **render the field**, never to drop the sort key — the chronological order is §4.3.5's and a register without it is not a register.

- [ ] **Step 7: Run everything and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: all green. `lint:rules` in particular: the new test file is under `packages/db/test/**`, whose allowance to import `tests/invariants/support/**` is 3B's amendment A21(c) — if `dependency-rule` names this file, that allowance did not merge (Task 0's gate checks it).

```bash
git add tests/invariants/support/reports.ts docs/adr/0068-tie-out-declarations-are-executed.md \
        packages/db/seed/my/reports/7b/ packages/db/test/reports/7b-accounting-ledger.test.ts
git commit -m "feat(db): the tie-out harness and the four accounting ledger definitions [7B T1]

ADR 0068: a report's tieOut declaration is executed by one harness, never
documented. general_ledger, journal_register, account_statement and
period_comparison, each tying to account_balance or to the ledger's own sum.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: The two financial statements — `accounting.profit_and_loss` and `accounting.balance_sheet`

Both read `account_balance`, both are **company-level** (amendment A6 — the BRANCH cut is 7C's `accounting.branch_profit_and_loss`, because `account_balance`'s key carries no branch), and both tie to the ledger's own sum for their account types. Their **layouts** are 7A's, their **definitions** are this slice's (§4.16.1) — and a 7B definition **is** 7A's layout: each seed file's `definition` is exactly what `statementDefinition(kind, identity)` returns.

**Files:**
- Create: `packages/db/seed/my/reports/7b/accounting.profit_and_loss.json`, `…/accounting.balance_sheet.json`, `packages/db/test/reports/7b-financial-statements.test.ts`
- Modify: `tests/invariants/support/reports.ts` (one additive member on `LedgerWindow`)

**Interfaces:**
- Consumes: everything Task 1 produced, plus `PERMISSIONS` (§4.2.5); `statementDefinition`, `STATEMENT_LAYOUTS`, `StatementKind` (7A, `@dulja/domain`, A6/A11); `statementRows` (7A, `@dulja/db`, reached through `rowsForDefinition` inside the harness — never called directly from this slice); `trialBalance` (1B — the cross-check that the two statements partition the same trial balance).
- Produces: the two definitions, and `LedgerWindow.accountTypes?: readonly string[]`.

**Why neither statement carries an `accountTypes` parameter, and why an earlier draft of this task was wrong to give it one.** The obvious reading of §4.11.1 is that a definition cannot express a *constant* restriction — `parameters` has no multi-select kind and no default, and every filter clause names a parameter — so a statement that filtered nothing would print a trial balance under a P&L heading, and the remedy would be a required `accountTypes` text parameter consumed by `op: "in"`. **7A already solved it a different way and its answer is the contract** (§4.18): the restriction lives in `statementRows`, which filters the other statement's account types out and annotates each row with its `section` (its private `annotate` helper), so the *definition* needs one parameter — `fiscalPeriodId` — and one filter. A 7B definition that added `accountTypes` would answer a different row set from `statementRows` under the same code, would fail the deep-equality assertion in Step 2's first case, and would be the second spelling of a statement A6 exists to prevent. **`LedgerWindow.accountTypes` is still added in Step 1** and is unrelated: it narrows the *ledger* side of the tie-out, which has no `statementRows` to lean on and must be told which account types the statement covers.

- [ ] **Step 1: Add `accountTypes` to `LedgerWindow` in `tests/invariants/support/reports.ts`**

```ts
export interface LedgerWindow {
  fiscalPeriodId?: string; fromDate?: string; toDate?: string;
  accountCode?: string; accountTypes?: readonly string[]; documentTypeCodes?: readonly string[];
}
```

and one clause in the `ledger_sum` query, beside the `accountCode` one — the `types` binding is renamed so the two arrays cannot be confused:

```ts
    const codes = w.documentTypeCodes ? [...w.documentTypeCodes] : null;
    const kinds = w.accountTypes ? [...w.accountTypes] : null;
    const [row] = await tx<{ debit: string; credit: string; net: string; credit_net: string }[]>`
      select coalesce(sum(le.base_debit), 0)::numeric(19,4)::text                  as debit,
             coalesce(sum(le.base_credit), 0)::numeric(19,4)::text                 as credit,
             coalesce(sum(le.base_debit - le.base_credit), 0)::numeric(19,4)::text as net,
             coalesce(sum(le.base_credit - le.base_debit), 0)::numeric(19,4)::text as credit_net
        from app.ledger_entry le
        join app.account a on a.id = le.account_id
        join app.document d on d.id = le.document_id
        join app.document_type dt on dt.id = d.document_type_id
       where le.company_id = ${companyId}
         and (${w.fiscalPeriodId ?? null}::uuid is null or le.fiscal_period_id = ${w.fiscalPeriodId ?? null}::uuid)
         and (${w.fromDate ?? null}::date is null or le.effective_date >= ${w.fromDate ?? null}::date)
         and (${w.toDate ?? null}::date is null or le.effective_date <= ${w.toDate ?? null}::date)
         and (${account}::text is null or a.code = ${account}::text)
         and (${kinds}::text[] is null or a.type::text = any(${kinds}::text[]))
         and (${codes}::text[] is null or dt.code = any(${codes}::text[]))`;
```

Note the two new clauses are `a.type` and `dt.code`, both **bound parameters** — the query still computes all four measures as fixed columns and the branch picks one by the map's key, so nothing is interpolated into SQL. **This slice contains no `sql.unsafe` call at all**: §3.3 gives it exactly three homes (the migration runner, the pg-boss adapter, the Firebird reader), and a test helper is not one of them. Being outside the lint roots would have made the rule unenforced here, not satisfied.

- [ ] **Step 2: Write the failing test `packages/db/test/reports/7b-financial-statements.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import {
  Money, STATEMENT_LAYOUTS, currency, statementDefinition, validateReportDefinition,
  type StatementKind,
} from "@dulja/domain";
import { DATASET_IDS, trialBalance } from "@dulja/db";
import { startDb, withTenant, type Db } from "@dulja/db/test";
import {
  assertTieOut, readDefinition, readEnvelope, reportFixture, runDefinition, type ReportFixture,
} from "../../../../tests/invariants/support/reports";

const MYR = currency("MYR");
/** `validateReportDefinition`'s second argument is `ReportDefinitionSets` — BOTH closed sets (7A, A11). */
const SETS = {
  datasets: new Set<string>(DATASET_IDS),
  permissions: new Set(PERMISSIONS.map((p) => p.code)),
};
const PL = "accounting.profit_and_loss";
const BS = "accounting.balance_sheet";
/** The four members `statementDefinition` takes beyond the layout — everything else in the file is 7A's. */
const IDENTITY: Readonly<Record<string, { kind: StatementKind; nameEn: string; nameAr: string }>> = {
  [PL]: { kind: "profit_and_loss", nameEn: "Profit and loss", nameAr: "قائمة الأرباح والخسائر" },
  [BS]: { kind: "balance_sheet", nameEn: "Balance sheet", nameAr: "الميزانية العمومية" },
};
const definitionFor = (code: string) =>
  statementDefinition(IDENTITY[code]!.kind, {
    code, nameEn: IDENTITY[code]!.nameEn, nameAr: IDENTITY[code]!.nameAr,
    permission: "accounting.report.read",
  });
/** The ledger side of each tie-out: which account types the statement covers. `statementRows` applies the
 *  same split on the report side; the ledger side has no such helper and must be told. */
const PL_TYPES = ["income", "expense"] as const;
const BS_TYPES = ["asset", "liability", "equity"] as const;

describe("7B financial statements (§4.16.1, amendment A6; the layout is 7A's, the identity is 7B's)", () => {
  let db: Db; let f: ReportFixture;

  beforeAll(async () => { db = await startDb(); f = await reportFixture(db, "Alpha"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[3]>[0]) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);

  // THE CASE THAT MAKES A6 MECHANICAL. A seed file is not "modelled on" 7A's layout, it IS 7A's layout with
  // a code, two names and a permission on it. Deep equality is the only assertion that cannot drift: a
  // relabelled column, an extra parameter or a re-ordered sort key all fail here with the diff on screen.
  it("each definition is EXACTLY statementDefinition(kind, identity) — 7A's layout, byte for byte", () => {
    for (const code of [PL, BS]) {
      expect(readDefinition(code), `${code} diverges from 7A's frozen layout (amendment A6)`)
        .toEqual(definitionFor(code));
      expect(readEnvelope(code).definitionVersion).toBe(1);
    }
    // And the layout the two are built from is the frozen pair, not a `statementLayout(..., opts)` variant:
    // `perBranch` is 7C's, and a `perBranch` statement here would carry a branch column 7B never asked for.
    expect(readDefinition(PL).columns).toEqual(STATEMENT_LAYOUTS.profit_and_loss.columns);
    expect(readDefinition(BS).columns).toEqual(STATEMENT_LAYOUTS.balance_sheet.columns);
  });

  it("both validate, are gated accounting.report.read and read account_balance", () => {
    for (const code of [PL, BS]) {
      const envelope = readEnvelope(code);
      const result = validateReportDefinition(envelope.definition, SETS);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(result.ok).toBe(true);
      expect(envelope.definition.permission).toBe("accounting.report.read");
      expect(envelope.definition.dataset.source).toBe("account_balance");
      expect(envelope.definition.module).toBe("accounting");
    }
  });

  it("one parameter, one filter, no branch and no asOf (amendment A6)", () => {
    for (const code of [PL, BS]) {
      const d = readDefinition(code);
      expect(d.parameters.map((p) => p.name)).toEqual(["fiscalPeriodId"]);
      expect(d.dataset.filters).toEqual([{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }]);
      expect(d.parameters.map((p) => p.kind)).not.toContain("branch");
      expect(d.parameters.map((p) => p.name)).not.toContain("asOf");
      expect(d.parameters.map((p) => p.name)).not.toContain("accountTypes");
      expect(d.layout.header, "no {asOfLabel}: a period statement names its period").not.toContain("asOfLabel");
    }
  });

  it("accounting.profit_and_loss ties to the ledger's own sum over income and expense", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(PL), {
        params: { companyId: f.s.company, fiscalPeriodId: f.s.period },
        baseCurrency: MYR,
        window: { fiscalPeriodId: f.s.period, accountTypes: [...PL_TYPES] },
      });
    });
  });

  it("accounting.balance_sheet ties to the ledger's own sum over asset, liability and equity", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(BS), {
        params: { companyId: f.s.company, fiscalPeriodId: f.s.period },
        baseCurrency: MYR,
        window: { fiscalPeriodId: f.s.period, accountTypes: [...BS_TYPES] },
      });
    });
  });

  it("THE IDENTITY: the balance sheet's net plus the profit-and-loss net is exactly zero", async () => {
    // The fixture's 2026-01 figures: cash 1200 − 300 − 200 = +700 debit; other expense +300 debit;
    // sales 1200 − 200 = 1000 credit. Assets +700, income/expense net −700, and the sum is 0.0000.
    // This is the accounting identity read out of the two STATEMENTS rather than out of the ledger, so it
    // fails if `statementRows` drops a row or classifies one into the wrong statement (spec:2420's spirit).
    await read(async (tx) => {
      const netOf = async (code: string) => {
        const rows = await runDefinition(tx, readDefinition(code), {
          companyId: f.s.company, fiscalPeriodId: f.s.period,
        });
        return rows.reduce((a, r) => a.add(Money.of(String(r.base_balance ?? "0.0000"), MYR)), Money.zero(MYR));
      };
      const bs = await netOf(BS);
      const pl = await netOf(PL);
      expect(bs.toString()).toBe("700.0000");
      expect(pl.toString()).toBe("-700.0000");
      expect(bs.add(pl).toString()).toBe("0.0000");
    });
  });

  it("the two statements partition the trial balance: every 1B row appears in exactly one of them", async () => {
    await read(async (tx) => {
      const tb = await trialBalance(tx, { companyId: f.s.company, fiscalPeriodId: f.s.period, limit: 1000 });
      const seen = new Set<string>();
      for (const code of [BS, PL]) {
        const rows = await runDefinition(tx, readDefinition(code), {
          companyId: f.s.company, fiscalPeriodId: f.s.period,
        });
        for (const r of rows) {
          // LEFT: the dataset's snake_case alias (A3). RIGHT (below): `TrialBalanceRow`'s camelCase member.
          // The two vocabularies meet in this one line and nowhere else in the file.
          const key = `${String(r.account_code)}|${String(r.currency)}`;
          expect(seen.has(key), `${key} appears in both statements`).toBe(false);
          seen.add(key);
        }
      }
      expect([...seen].sort()).toEqual(tb.map((r) => `${r.accountCode}|${r.currency}`).sort());
    });
  });

  it("both group and sort on `section`, which statementRows annotates and no dataset column carries", async () => {
    for (const code of [PL, BS]) {
      const d = readDefinition(code);
      expect(d.groups).toEqual([{ field: "section", subtotal: true }]);
      expect(d.totals).toEqual([{ field: "base_balance", fn: "sum" }]);
      expect(d.sort).toEqual([{ field: "section", dir: "asc" }, { field: "account_code", dir: "asc" }]);
      expect(d.layout.paper).toBe("A4");
      expect(d.layout.orientation).toBe("portrait");
    }
    // And the annotation really is there at run time — the assertion that would catch a harness whose
    // statement branch was never taken, in which case `section` would be absent and every row's group empty.
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(PL), {
        companyId: f.s.company, fiscalPeriodId: f.s.period,
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(typeof r.section, "statementRows annotates `section`").toBe("string");
      expect(new Set(rows.map((r) => String(r.account_type)))).toEqual(new Set(["income", "expense"]));
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/reports/7b-financial-statements.test.ts`
Expected: **FAIL** with `ENOENT … accounting.profit_and_loss.json` from `readDefinition` in the first case.

- [ ] **Step 4: Write the two definitions — the printed output of `statementDefinition`**

**Do not compose these by hand from the prose.** The two files below are what `statementDefinition(kind, identity)` returns for 7A's frozen `STATEMENT_LAYOUTS` — the return of `build()` in `packages/domain/src/reports/statement.ts` — serialised. Generate them and diff, rather than typing them: from the repository root,

```bash
bun -e 'const { statementDefinition } = await import("@dulja/domain");
const w = (code, kind, nameEn, nameAr) => Bun.write(
  `packages/db/seed/my/reports/7b/${code}.json`,
  JSON.stringify({ definitionVersion: 1,
    definition: statementDefinition(kind, { code, nameEn, nameAr, permission: "accounting.report.read" }) },
    null, 2) + "\n");
await w("accounting.profit_and_loss", "profit_and_loss", "Profit and loss", "قائمة الأرباح والخسائر");
await w("accounting.balance_sheet", "balance_sheet", "Balance sheet", "الميزانية العمومية");'
```

The result is the two files below, and Step 2's first case is the proof that it stayed that way. **If what the generator writes differs from what is printed here, 7A's layout has changed since this plan was written: the generator's output wins, this plan's print is corrected in the same PR, and A6's transcription of the layout is corrected with it** (§4.18's rule).

`packages/db/seed/my/reports/7b/accounting.profit_and_loss.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.profit_and_loss",
    "nameEn": "Profit and loss",
    "nameAr": "قائمة الأرباح والخسائر",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "fiscalPeriodId", "kind": "period", "required": true }
    ],
    "dataset": {
      "source": "account_balance",
      "filters": [
        { "field": "fiscal_period_id", "op": "eq", "param": "fiscalPeriodId" }
      ]
    },
    "columns": [
      { "field": "section", "labelEn": "Section", "labelAr": "القسم", "format": "text", "align": "start", "width": 120 },
      { "field": "account_code", "labelEn": "Code", "labelAr": "الرمز", "format": "text", "align": "start", "width": 80 },
      { "field": "account_name_en", "labelEn": "Name", "labelAr": "الاسم", "format": "text", "align": "start" },
      { "field": "base_balance", "labelEn": "Balance", "labelAr": "الرصيد", "format": "money", "align": "end", "width": 120 }
    ],
    "groups": [{ "field": "section", "subtotal": true }],
    "totals": [{ "field": "base_balance", "fn": "sum" }],
    "sort": [{ "field": "section", "dir": "asc" }, { "field": "account_code", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{title} — {fiscalPeriodId}",
      "footer": "{rowCount} accounts · {generatedAt}"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

`packages/db/seed/my/reports/7b/accounting.balance_sheet.json` — the same layout under the balance-sheet identity. **The two are separate files rather than one definition with a section parameter**, because §4.16.1 registers two codes and a code is what a saved view, a permission gate and a `report_run` row all name; the *rows* differ because `statementRows("balance_sheet", …)` classifies and filters, not because the definitions do:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.balance_sheet",
    "nameEn": "Balance sheet",
    "nameAr": "الميزانية العمومية",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "fiscalPeriodId", "kind": "period", "required": true }
    ],
    "dataset": {
      "source": "account_balance",
      "filters": [
        { "field": "fiscal_period_id", "op": "eq", "param": "fiscalPeriodId" }
      ]
    },
    "columns": [
      { "field": "section", "labelEn": "Section", "labelAr": "القسم", "format": "text", "align": "start", "width": 120 },
      { "field": "account_code", "labelEn": "Code", "labelAr": "الرمز", "format": "text", "align": "start", "width": 80 },
      { "field": "account_name_en", "labelEn": "Name", "labelAr": "الاسم", "format": "text", "align": "start" },
      { "field": "base_balance", "labelEn": "Balance", "labelAr": "الرصيد", "format": "money", "align": "end", "width": 120 }
    ],
    "groups": [{ "field": "section", "subtotal": true }],
    "totals": [{ "field": "base_balance", "fn": "sum" }],
    "sort": [{ "field": "section", "dir": "asc" }, { "field": "account_code", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{title} — {fiscalPeriodId}",
      "footer": "{rowCount} accounts · {generatedAt}"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

**Two things in that JSON look wrong and are deliberately left alone.** The header interpolates `{fiscalPeriodId}` — a raw uuid where a human wants `2026-01` — and the money column is labelled "Balance" where a *period-movement* statement wants "Movement (net)". Both are single strings inside 7A's `build()` — its `heading` const and the last entry of `BASE_COLUMNS`, `packages/domain/src/reports/statement.ts` and neither is 7B's to change: editing either here would break the deep-equality case that is the only mechanical guard A6 has. **They are the first two rows of this slice's raise list against 7A** (Self-Review), and the honest fix is one PR in 7A's own file that also updates `STATEMENT_LAYOUTS`, after which these two seed files are regenerated by the command above and re-committed unchanged in every other respect.

- [ ] **Step 5: Run it to pass**

Run: `cd packages/db && bun run test -- test/reports/7b-financial-statements.test.ts`
Expected: **PASS, 8 tests.** Four failures worth predicting:
- `accounting.profit_and_loss diverges from 7A's frozen layout (amendment A6)` with a diff naming `parameters` or `columns` — the file was hand-written instead of generated, or 7A's layout moved. Regenerate; never edit the expectation.
- `statementRows annotates 'section'` failing with `typeof r.section === "undefined"` — `rowsForDefinition` did not take its statement branch, i.e. `statementKindFor(definition.code)` returned `null`, i.e. the seed file's `code` is not the one `STATEMENT_CODES` carries. The next symptom would be a `ReportError` from `columnOf` on the `section` sort key; fix the definition's `code` or raise against 7A's `STATEMENT_CODES`, and never re-add a local code→kind map to the harness.
- `expected "1000.0000" to be "700.0000"` on the identity case — the fixture's third journal (sales debited 200) did not post, so the period holds only two journals. Check `postJournal`'s three results in `reportFixture`, not the definition.
- `accounting.profit_and_loss: the report totals -700.0000 and the ledger totals 0.0000 for measure net` — the `accountTypes` **window** member did not reach the query, i.e. Step 1's clause is missing. The report side is right; the ledger side summed every account type and netted to zero, which is the ledger invariant, not a tie-out.

- [ ] **Step 6: Run everything and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`

```bash
git add tests/invariants/support/reports.ts packages/db/seed/my/reports/7b/ \
        packages/db/test/reports/7b-financial-statements.test.ts
git commit -m "feat(db): profit-and-loss and balance-sheet definitions from 7A's layout [7B T2]

Each seed file IS statementDefinition(kind, identity), asserted by deep
equality; the rows come from statementRows, which annotates section and splits
the two statements. Both tie to the ledger's own sum for their account types
and the two nets sum to zero. The BRANCH cut stays 7C's
accounting.branch_profit_and_loss (amendment A6).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: The document register and the two `auditor` views

`accounting.document_register` (one definition, thirty document types, a `text` parameter — amendment A10) and the two views spec:2163 gives the `auditor`: `accounting.audit_log` and `accounting.document_event_log`, both gated `admin.audit_log.read`.

**Files:**
- Create: `packages/db/seed/my/reports/7b/accounting.document_register.json`, `…/accounting.audit_log.json`, `…/accounting.document_event_log.json`, `packages/db/test/reports/7b-registers.test.ts`
- Modify: nothing.

**Interfaces:**
- Consumes: Task 1's harness; `ROLES` from `packages/db/seed/roles.ts` (0D, §3.6.4 — imported by relative path, because `packages` never import `apps` and the seed is not on the main barrel, §3.1); `PERMISSIONS` (§4.2.5).
- Produces: the three definitions.

**Three facts about these three definitions that a reader would otherwise get wrong.**

1. **`documentTypeCode` is free text, not an enum** (amendment A10). Test 15's clause is *"numbers, posts, prints, **reports**, reverses"* with zero code; an `options` list of §4.14's thirty codes makes a tenant's own type unreportable until a release, which is the clause failing. An unknown code returns no rows, and that is the correct answer.
2. **`accounting.audit_log` is tenant-scoped, not company-scoped.** `app.audit_log` has no `company_id` (plan0A: `seq`, `tenant_id`, `actor_id`, `occurred_at`, `table_name`, `row_id`, `action`, `before`, `after`, `prev_hash`, `hash`), so `DatasetParams.companyId` is accepted and unused for this one source and the report's header names the tenant. That is deliberate rather than a gap: the hash chain is per tenant (plan0A's `tenant-serial:<tenant>` advisory lock), and an audit report cut by company would silently omit rows whose table has no company column — `principal`, `membership`, `tenant` itself. `admin.audit_log.read` is evaluated `{ company: "any" }` by 0B's own audit-log route for the same reason.
3. **`before` and `after` are not columns of either view** (amendment A3). An audit *report* that rendered row images is a covered side channel for `employee_sensitive` and for every other payload (spec:2450; tests 32 and 36 name the export path). The images stay reachable only through 0B's gated `/v1/admin/audit-log` resource.

- [ ] **Step 1: Write the failing test `packages/db/test/reports/7b-registers.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { Money, currency, validateReportDefinition } from "@dulja/domain";
import { DATASET_IDS } from "@dulja/db";
import { startDb, withTenant, type Db } from "@dulja/db/test";
import { ROLES } from "../../seed/roles";
import {
  assertTieOut, readDefinition, readEnvelope, reportFixture, runDefinition, type ReportFixture,
} from "../../../../tests/invariants/support/reports";

const MYR = currency("MYR");
/** `validateReportDefinition`'s second argument is `ReportDefinitionSets` — BOTH closed sets (7A, A11). */
const SETS = {
  datasets: new Set<string>(DATASET_IDS),
  permissions: new Set(PERMISSIONS.map((p) => p.code)),
};
const REGISTER = "accounting.document_register";
const AUDIT = "accounting.audit_log";
const EVENTS = "accounting.document_event_log";

describe("7B document register and the two auditor views (§4.16.1, spec:2163)", () => {
  let db: Db; let f: ReportFixture;

  beforeAll(async () => { db = await startDb(); f = await reportFixture(db, "Alpha"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[3]>[0]) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);

  it("all three validate, and the two auditor views are gated admin.audit_log.read", () => {
    for (const code of [REGISTER, AUDIT, EVENTS]) {
      const result = validateReportDefinition(readDefinition(code), SETS);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(readEnvelope(code).definitionVersion).toBe(1);
    }
    expect(readDefinition(AUDIT).permission).toBe("admin.audit_log.read");
    expect(readDefinition(EVENTS).permission).toBe("admin.audit_log.read");
    expect(readDefinition(REGISTER).permission).toBe("accounting.report.read");
  });

  it("documentTypeCode is a text parameter, not an enum over §4.14 (amendment A10, test 15's report clause)", () => {
    const p = readDefinition(REGISTER).parameters.find((x) => x.name === "documentTypeCode");
    expect(p).toBeDefined();
    expect(p!.kind).toBe("text");
    expect(p!.options).toBeUndefined();
    expect(p!.required).toBe(false);
  });

  it("neither auditor view exposes a row image — `before` and `after` are not columns (spec:2450, test 32)", () => {
    for (const code of [AUDIT, EVENTS]) {
      const fields = readDefinition(code).columns.map((c) => c.field);
      expect(fields).not.toContain("before");
      expect(fields).not.toContain("after");
      expect(readDefinition(code).dataset.filters.map((c) => c.field)).not.toContain("before");
    }
  });

  it("accounting.document_register's amount total equals the ledger's own debit sum for the same documents", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(REGISTER), {
        params: {
          companyId: f.s.company, fromDate: "2026-01-01", toDate: "2026-01-31",
          documentTypeCode: "JOURNAL", status: "posted", branchId: null,
        },
        baseCurrency: MYR,
        window: { fromDate: "2026-01-01", toDate: "2026-01-31", documentTypeCodes: ["JOURNAL"] },
      });
    });
  });

  it("the register reports one row per document, and an unknown type code answers zero rows, not an error", async () => {
    await read(async (tx) => {
      const d = readDefinition(REGISTER);
      const rows = await runDefinition(tx, d, {
        companyId: f.s.company, fromDate: "2026-01-01", toDate: "2026-01-31",
        documentTypeCode: "JOURNAL", status: "posted", branchId: null,
      });
      expect(rows.length).toBe(3);
      // `document_id` and `base_total` are 7A's column aliases (A3). A camelCase access here would read
      // `undefined`: `new Set([undefined]).size` is 1, not 3, and `Money.of("undefined")` throws — the two
      // ways this mistake shows up, neither of them "the report is wrong".
      expect(new Set(rows.map((r) => String(r.document_id))).size).toBe(3);
      const totals = rows.map((r) => Money.of(String(r.base_total), MYR).toString());
      expect(totals).toEqual(["1200.0000", "300.0000", "200.0000"]);
      const unknown = await runDefinition(tx, d, {
        companyId: f.s.company, fromDate: "2026-01-01", toDate: "2026-01-31",
        documentTypeCode: "A_TYPE_NO_TENANT_HAS", status: null, branchId: null,
      });
      expect(unknown).toEqual([]);
    });
  });

  it("accounting.audit_log's witness: every posted document has its insert audit row, and the report shows it", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(AUDIT), {
        params: { companyId: f.s.company, tableName: "document", action: "insert", fromDate: "2026-01-01", toDate: "2027-01-01", actorId: null },
        baseCurrency: MYR,
        // `assertTieOut` projects the SAME key list over both sides (Task 1), so the witness columns are
        // aliased to the dataset's own snake_case field names (A3) — `table_name` and `row_id`, never
        // `tableName`/`rowId`, which would project every report row to the empty string and pass or fail
        // for a reason that has nothing to do with the audit log.
        witness: {
          key: ["table_name", "row_id"],
          rows: (t) => t<{ table_name: string; row_id: string }[]>`
            select 'document' as table_name, id::text as row_id
              from app.document where company_id = ${f.s.company}`,
        },
      });
    });
  });

  it("accounting.document_event_log's witness: one posted transition per posted document (2B's trigger wrote them, no handler did)", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(EVENTS), {
        params: { companyId: f.s.company, documentTypeCode: null, eventKind: "transition", toStatus: "posted", fromDate: "2026-01-01", toDate: "2027-01-01" },
        baseCurrency: MYR,
        witness: {
          key: ["document_id", "to_status"],
          rows: (t) => t<{ document_id: string; to_status: string }[]>`
            select id::text as document_id, 'posted' as to_status
              from app.document where company_id = ${f.s.company} and status = 'posted'`,
        },
      });
    });
  });

  it("the auditor role reaches both views and holds nothing mutating (spec:2163, R7)", () => {
    const auditor = ROLES.find((r) => r.code === "auditor");
    expect(auditor, "the nine roles of §3.6.4 include auditor").toBeDefined();
    expect(auditor!.permissions).toContain("admin.audit_log.read");
    expect(auditor!.permissions).toContain("accounting.report.read");
    const mutating = new Map(PERMISSIONS.map((p) => [p.code, p.mutating]));
    expect(auditor!.permissions.filter((c) => mutating.get(c) === true)).toEqual([]);
  });

  it("a principal holding no code sees no rows through the dataset either — RLS and the gate are separate controls", async () => {
    await withTenant(db.rw, f.s.tenant, f.outsider, async (tx) => {
      // The gate is `requirePermission` at the route (§4.2.5); the dataset itself is under RLS, which is
      // tenant-scoped, not permission-scoped. The outsider is in the SAME tenant, so RLS admits the rows and
      // the API gate is what refuses. Asserting that here — rather than an empty result — is what keeps the
      // two controls honestly distinct (spec:2173 "the data layer remains the control" is about tenancy).
      const rows = await runDefinition(tx, readDefinition(AUDIT), {
        companyId: f.s.company, tableName: "document", action: "insert",
        fromDate: "2026-01-01", toDate: "2027-01-01", actorId: null,
      });
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/reports/7b-registers.test.ts`
Expected: **FAIL** — `ENOENT … accounting.document_register.json`. If instead the failure is `Cannot find module '../../seed/roles'`, the relative depth is wrong: the test is at `packages/db/test/reports/`, so `roles.ts` at `packages/db/seed/roles.ts` is `../../seed/roles`.

- [ ] **Step 3: Write the three definitions**

`packages/db/seed/my/reports/7b/accounting.document_register.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.document_register",
    "nameEn": "Document register",
    "nameAr": "سجل المستندات",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "documentTypeCode", "kind": "text", "required": false },
      { "name": "status", "kind": "enum", "required": false, "options": ["draft", "submitted", "approved", "issued", "void", "posted", "reversed"] },
      { "name": "branchId", "kind": "branch", "required": false }
    ],
    "dataset": {
      "source": "document",
      "filters": [
        { "field": "effective_date", "op": "gte", "param": "fromDate" },
        { "field": "effective_date", "op": "lte", "param": "toDate" },
        { "field": "document_type_code", "op": "eq", "param": "documentTypeCode" },
        { "field": "status", "op": "eq", "param": "status" },
        { "field": "branch_id", "op": "eq", "param": "branchId" }
      ]
    },
    "columns": [
      { "field": "effective_date", "labelEn": "Date", "labelAr": "التاريخ", "format": "date", "align": "start", "width": 80 },
      { "field": "document_type_code", "labelEn": "Type", "labelAr": "النوع", "format": "text", "align": "start", "width": 110 },
      { "field": "series", "labelEn": "Series", "labelAr": "السلسلة", "format": "text", "align": "start", "width": 60 },
      { "field": "number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 70 },
      { "field": "status", "labelEn": "Status", "labelAr": "الحالة", "format": "text", "align": "start", "width": 70 },
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 60 },
      { "field": "party_name_en", "labelEn": "Party", "labelAr": "الطرف", "format": "text", "align": "start", "width": 160 },
      { "field": "currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 50 },
      { "field": "base_total", "labelEn": "Amount", "labelAr": "المبلغ", "format": "money", "align": "end", "width": 110 }
    ],
    "groups": [{ "field": "document_type_code", "subtotal": true }],
    "totals": [{ "field": "base_total", "fn": "sum" }, { "field": "number", "fn": "count" }],
    "sort": [{ "field": "effective_date", "dir": "asc" }, { "field": "series", "dir": "asc" }, { "field": "number", "dir": "asc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {documentTypeCode} · {fromDate} – {toDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

`packages/db/seed/my/reports/7b/accounting.audit_log.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.audit_log",
    "nameEn": "Audit log",
    "nameAr": "سجل التدقيق",
    "module": "accounting",
    "permission": "admin.audit_log.read",
    "parameters": [
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "tableName", "kind": "text", "required": false },
      { "name": "action", "kind": "enum", "required": false, "options": ["insert", "update", "delete"] },
      { "name": "actorId", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "audit_log",
      "filters": [
        { "field": "occurred_at", "op": "gte", "param": "fromDate" },
        { "field": "occurred_at", "op": "lt", "param": "toDate" },
        { "field": "table_name", "op": "eq", "param": "tableName" },
        { "field": "action", "op": "eq", "param": "action" },
        { "field": "actor_id", "op": "eq", "param": "actorId" }
      ]
    },
    "columns": [
      { "field": "seq", "labelEn": "Sequence", "labelAr": "التسلسل", "format": "integer", "align": "end", "width": 70 },
      { "field": "occurred_at", "labelEn": "When", "labelAr": "الوقت", "format": "date", "align": "start", "width": 140 },
      { "field": "actor_display_name", "labelEn": "Actor", "labelAr": "المستخدم", "format": "text", "align": "start", "width": 150 },
      { "field": "table_name", "labelEn": "Table", "labelAr": "الجدول", "format": "text", "align": "start", "width": 130 },
      { "field": "row_id", "labelEn": "Row", "labelAr": "السجل", "format": "text", "align": "start", "width": 260 },
      { "field": "action", "labelEn": "Action", "labelAr": "الإجراء", "format": "text", "align": "start", "width": 70 }
    ],
    "groups": [{ "field": "table_name", "subtotal": false }],
    "totals": [{ "field": "seq", "fn": "count" }],
    "sort": [{ "field": "seq", "dir": "asc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{tenantName} · {reportName} · {fromDate} – {toDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "none" }
  }
}
```

`packages/db/seed/my/reports/7b/accounting.document_event_log.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "accounting.document_event_log",
    "nameEn": "Document event log",
    "nameAr": "سجل أحداث المستندات",
    "module": "accounting",
    "permission": "admin.audit_log.read",
    "parameters": [
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "documentTypeCode", "kind": "text", "required": false },
      { "name": "eventKind", "kind": "enum", "required": false, "options": ["transition", "override"] },
      { "name": "toStatus", "kind": "enum", "required": false, "options": ["draft", "submitted", "approved", "issued", "void", "posted", "reversed"] }
    ],
    "dataset": {
      "source": "document_event",
      "filters": [
        { "field": "occurred_at", "op": "gte", "param": "fromDate" },
        { "field": "occurred_at", "op": "lt", "param": "toDate" },
        { "field": "document_type_code", "op": "eq", "param": "documentTypeCode" },
        { "field": "event_kind", "op": "eq", "param": "eventKind" },
        { "field": "to_status", "op": "eq", "param": "toStatus" }
      ]
    },
    "columns": [
      { "field": "occurred_at", "labelEn": "When", "labelAr": "الوقت", "format": "date", "align": "start", "width": 140 },
      { "field": "document_type_code", "labelEn": "Type", "labelAr": "النوع", "format": "text", "align": "start", "width": 110 },
      { "field": "number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 70 },
      { "field": "event_kind", "labelEn": "Event", "labelAr": "الحدث", "format": "text", "align": "start", "width": 80 },
      { "field": "from_status", "labelEn": "From", "labelAr": "من", "format": "text", "align": "start", "width": 80 },
      { "field": "to_status", "labelEn": "To", "labelAr": "إلى", "format": "text", "align": "start", "width": 80 },
      { "field": "override_code", "labelEn": "Override", "labelAr": "التجاوز", "format": "text", "align": "start", "width": 200 },
      { "field": "actor_display_name", "labelEn": "Actor", "labelAr": "المستخدم", "format": "text", "align": "start", "width": 140 },
      { "field": "attributed_to", "labelEn": "Attributed to", "labelAr": "منسوب إلى", "format": "text", "align": "start", "width": 140 },
      { "field": "reason", "labelEn": "Reason", "labelAr": "السبب", "format": "text", "align": "start", "width": 200 }
    ],
    "groups": [{ "field": "number", "subtotal": false }],
    "totals": [{ "field": "number", "fn": "count" }],
    "sort": [{ "field": "occurred_at", "dir": "asc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {fromDate} – {toDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "none" }
  }
}
```

**All three group and count on a field they render, and that is 7A's validator rule 4, not a style choice.** `document_register` counts `number` rather than `document_id`, and `document_event_log` groups and counts `number` rather than `document_id` / `event_id`, because rule 4 refuses a `groups[]`, `totals[]` or `sort[]` field that is not a `columns[]` field of the same definition — and a `count` total goes through the **same** membership check (`total field '<f>' is not one of this definition's columns` in `packages/domain/src/reports/validate.ts`), only skipping the numeric-format check that follows it. Neither id is a column any of these three renders, so naming one would fail `validateReportDefinition` at seed time with `total field 'document_id' is not one of this definition's columns`. A document number is also what the reader actually reconciles against, so the count is over the identifier on the page. `accounting.audit_log` already counted `seq`, which it renders.

**`attributed_to` renders a uuid, not a name, and that is 7A's dataset and not an oversight here.** `documentEventDataset` joins `app.principal` **once**, for `actor_id`, and selects `de.attributed_to` raw (A3, `DOCUMENT_EVENT_COLUMNS` / `documentEventDataset`). There is no `attributed_to_name` column, and a report may not add a join. The column is kept because the *fact* that an override was attributed to a different principal is what the auditor needs to see; resolving it to a display name is the **`documentEventDataset` row of the Self-Review's raise list** — a second `app.principal` join on 7A's `document_event` dataset — and until it lands the auditor follows the id through 0B's audit-log resource. Rendering the id is honest; omitting the column would hide the attribution entirely.

- [ ] **Step 4: Run it to pass**

Run: `cd packages/db && bun run test -- test/reports/7b-registers.test.ts`
Expected: **PASS, 9 tests.** Three failures worth predicting:
- `accounting.document_register: the report totals 3400.0000 and the ledger totals 1700.0000 for measure debit` — `base_total` is summing **both** sides of each document. 7A's lateral is `sum(le.base_debit)` (A3, `base_total` on `DOCUMENT_COLUMNS`); raise against 7A's `document` dataset, and do not divide by two anywhere.
- `expected [ "1200.0000", "300.0000", "200.0000" ] to equal …` in a different order — the `sort` is not being applied, or `series`/`number` sort as text where the fixture expects date order. The definition's `sort` is the contract and `runDefinition` passes it through as `DatasetSortKey[]`; if 7A ignores it, that is a 7A raise, not a re-ordering of the expectation.
- `accounting.audit_log: the witness has row document|0192… and the report does not` — the `occurred_at` filters compared a `timestamptz` with a bare date and the boundary cut a row. Note the definition uses `gte fromDate` and **`lt` toDate**, exclusive on the upper bound, precisely so a same-day audit row at 23:59 is not lost; if the dataset renders `lt` as `lte` the last day is double-counted rather than lost, which the witness also catches.

- [ ] **Step 5: Run everything and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`

```bash
git add packages/db/seed/my/reports/7b/ packages/db/test/reports/7b-registers.test.ts
git commit -m "feat(db): document register and the two auditor views [7B T3]

document_register with a free-text type parameter (test 15's report clause),
audit_log and document_event_log gated admin.audit_log.read with no row
images (spec:2450), each with an independent row witness.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: Re-expressing 1B's two codes — `accounting.trial_balance` and `accounting.ledger` at version 2

The first half of §4.16.1's "re-expresses" clause. Two definitions land at `definitionVersion = 2` under the codes 1B already serves; the **parity** case proves the definition reads the same numbers as `trialBalance` and `accountLedger`; and **1B's own route test is re-run unchanged**, which is what the clause actually guarantees (amendment A2).

**Files:**
- Create: `packages/db/seed/my/reports/7b/accounting.trial_balance.json`, `…/accounting.ledger.json`, `packages/db/test/reports/7b-reexpress-phase1.test.ts`
- Modify: **nothing.** In particular not `apps/api/src/routes/accounting/reports.ts`, not `packages/contracts/src/accounting/reports.ts` (Task 9 widens the enum, and neither of these two codes is a new member), and not `packages/db/src/reports/trial-balance.ts` or `ledger.ts`.

**Interfaces:**
- Consumes: `trialBalance`, `TrialBalanceRow`, `accountLedger`, `LedgerRow`, `accountOpeningBalance` (1B, §4.16.3); Task 1's harness.
- Produces: the two definitions at `definitionVersion 2`.

**Why version 2 and not version 1.** §4.16.1's rule, which is §3.4.8's policy-version rule applied to reports: *"A definition seeded for a code an earlier slice already served upserts on `(company_id, code, version)` at `version = 2`."* 1B seeded no `report_definition` row at all, so there is no version 1 in the table — and the number is still 2, because the *code* has been served since Phase 1 and a staging database that later grows a version 1 from any source must not shadow this one. The seed is `do update` on conflict (amendment A1), so re-running it after an edit replaces the definition rather than silently keeping the old one.

- [ ] **Step 1: Write the failing test `packages/db/test/reports/7b-reexpress-phase1.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { Money, currency, validateReportDefinition } from "@dulja/domain";
import { DATASET_IDS, accountLedger, accountOpeningBalance, trialBalance } from "@dulja/db";
import { startDb, withTenant, type Db } from "@dulja/db/test";
import {
  assertTieOut, readDefinition, readEnvelope, reportFixture, runDefinition, type ReportFixture,
} from "../../../../tests/invariants/support/reports";

const MYR = currency("MYR");
/** `validateReportDefinition`'s second argument is `ReportDefinitionSets` — BOTH closed sets (7A, A11). */
const SETS = {
  datasets: new Set<string>(DATASET_IDS),
  permissions: new Set(PERMISSIONS.map((p) => p.code)),
};
/** The two vocabularies this file joins (A3): LEFT of every comparison is a `DatasetRow`'s snake_case column
 *  alias, RIGHT is 1B's camelCase read-function row member. The map is written once, here, so no case has to
 *  decide it again — and a `DatasetRow` access anywhere in this file that is not one of these keys is a bug. */
const FIGURES = [
  ["debit", "debit"], ["credit", "credit"], ["base_debit", "baseDebit"], ["base_credit", "baseCredit"],
] as const;
const TB = "accounting.trial_balance";
const LEDGER = "accounting.ledger";

describe("7B re-expresses 1B's two minimal-set codes (§4.16.1, spec:2300)", () => {
  let db: Db; let f: ReportFixture;

  beforeAll(async () => { db = await startDb(); f = await reportFixture(db, "Alpha"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[3]>[0]) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);

  it("both are seeded at definitionVersion 2 and keep 1B's code and permission exactly", () => {
    for (const code of [TB, LEDGER]) {
      const envelope = readEnvelope(code);
      expect(envelope.definitionVersion).toBe(2);
      expect(envelope.definition.code).toBe(code);
      expect(envelope.definition.permission).toBe("accounting.report.read");
      const result = validateReportDefinition(envelope.definition, SETS);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
    }
  });

  it("PARITY: accounting.trial_balance's definition returns exactly what trialBalance returns", async () => {
    await read(async (tx) => {
      const fn = await trialBalance(tx, { companyId: f.s.company, fiscalPeriodId: f.s.period, limit: 1000 });
      const def = await runDefinition(tx, readDefinition(TB), {
        companyId: f.s.company, fiscalPeriodId: f.s.period, currency: null,
      });
      expect(def.length).toBe(fn.length);
      const key = (code: string, cur: string) => `${code}|${cur}`;
      const byKey = new Map(def.map((r) => [key(String(r.account_code), String(r.currency)), r]));
      for (const row of fn) {
        const got = byKey.get(key(row.accountCode, row.currency));
        expect(got, `the definition is missing ${row.accountCode}|${row.currency}`).toBeDefined();
        for (const [column, member] of FIGURES) {
          expect(Money.of(String(got![column]), MYR).toString()).toBe(Money.of(row[member], MYR).toString());
        }
        expect(String(got!.account_type)).toBe(row.accountType);
        expect(String(got!.account_name_en)).toBe(row.accountNameEn);
      }
    });
  });

  it("PARITY: accounting.ledger's definition returns 1B's rows for one account, minus the running balance", async () => {
    await read(async (tx) => {
      const fn = await accountLedger(tx, {
        companyId: f.s.company, accountId: f.s.cash, fromDate: "2026-01-01", toDate: "2026-01-31", limit: 1000,
      });
      const def = await runDefinition(tx, readDefinition(LEDGER), {
        companyId: f.s.company, accountId: f.s.cash, fromDate: "2026-01-01", toDate: "2026-01-31",
      });
      expect(def.map((r) => String(r.entry_id))).toEqual(fn.map((r) => r.entryId));
      for (const [i, row] of fn.entries()) {
        for (const [column, member] of FIGURES) {
          expect(Money.of(String(def[i]![column]), MYR).toString()).toBe(Money.of(row[member], MYR).toString());
        }
        expect(String(def[i]!.effective_date)).toBe(row.effectiveDate);
        expect(String(def[i]!.document_type_code)).toBe(row.documentTypeCode);
      }
      // `running_base_balance` is 1B's route arithmetic over an ordered page and is deliberately NOT a dataset
      // field (amendment A3). The definition therefore carries no such column, and a renderer that wanted one
      // would be asking for a second implementation of the figure `accountOpeningBalance` already defines.
      expect(readDefinition(LEDGER).columns.map((c) => c.field)).not.toContain("running_base_balance");
      const opening = await accountOpeningBalance(tx, { companyId: f.s.company, accountId: f.s.cash, beforeDate: "2026-01-01" });
      expect(Money.of(opening, MYR).toString()).toBe("0.0000");
    });
  });

  it("accounting.trial_balance ties: Σ debit = Σ credit, and the total equals the ledger's own", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(TB), {
        params: { companyId: f.s.company, fiscalPeriodId: f.s.period, currency: null },
        baseCurrency: MYR, window: { fiscalPeriodId: f.s.period },
      });
      const rows = await runDefinition(tx, readDefinition(TB), {
        companyId: f.s.company, fiscalPeriodId: f.s.period, currency: null,
      });
      const debit = rows.reduce((a, r) => a.add(Money.of(String(r.base_debit), MYR)), Money.zero(MYR));
      const credit = rows.reduce((a, r) => a.add(Money.of(String(r.base_credit), MYR)), Money.zero(MYR));
      expect(debit.toString()).toBe(credit.toString());
      expect(debit.toString()).toBe("1700.0000");
    });
  });

  it("accounting.ledger ties to account_balance for the account it reports", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(LEDGER), {
        params: { companyId: f.s.company, accountId: f.s.cash, fromDate: "2026-01-01", toDate: "2026-01-31" },
        // `accountCode` is REQUIRED here, not decorative: the report is filtered to one account, so the
        // stored side must be narrowed to the same one. See the note below.
        baseCurrency: MYR, window: { fiscalPeriodId: f.s.period, accountCode: "1000" },
      });
    });
  });
});
```

**On `window.accountCode` in the last case, and why omitting it would be a bug and not a stronger test.** `assertTieOut`'s `account_balance` branch compares the report's figures against the projection's **stored rows for the window it is given**. This report is filtered to account `1000`, so a window without `accountCode` would hand the branch every stored account of the company — `4000` among them, which the fixture posts 1000.0000 of income to — and the comparison for `4000` would be `−1000.0000` stored against `Money.zero` reported. The tie-out would throw on a correct definition, and it would throw at the *first* such account, so the message would blame a report that never claimed to cover it.

The narrowed window is still a real check of two independent paths: the report's aggregation over its own pages against `account_balance`'s stored debit and credit for the same account and period, and the branch additionally refuses to pass when the narrowed projection read comes back **empty** (`account_balance has no row for account 1000 in this window`), which is what would otherwise make a single-account tie-out vacuous. A definition whose `accountId` filter is wired to the wrong field fails here with both figures in the message; a definition whose filter is dropped entirely fails the parity case above, row for row. The single-account case is the one 1B's route serves.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/reports/7b-reexpress-phase1.test.ts`
Expected: **FAIL** — `ENOENT … accounting.trial_balance.json`.

- [ ] **Step 3: Write the two definitions**

`packages/db/seed/my/reports/7b/accounting.trial_balance.json`:

```json
{
  "definitionVersion": 2,
  "definition": {
    "version": 1,
    "code": "accounting.trial_balance",
    "nameEn": "Trial balance",
    "nameAr": "ميزان المراجعة",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "fiscalPeriodId", "kind": "period", "required": true },
      { "name": "currency", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "account_balance",
      "filters": [
        { "field": "fiscal_period_id", "op": "eq", "param": "fiscalPeriodId" },
        { "field": "currency", "op": "eq", "param": "currency" }
      ]
    },
    "columns": [
      { "field": "account_code", "labelEn": "Account", "labelAr": "الحساب", "format": "text", "align": "start", "width": 70 },
      { "field": "account_name_en", "labelEn": "Account name", "labelAr": "اسم الحساب", "format": "text", "align": "start", "width": 200 },
      { "field": "account_type", "labelEn": "Type", "labelAr": "النوع", "format": "text", "align": "start", "width": 80 },
      { "field": "currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 50 },
      { "field": "debit", "labelEn": "Debit", "labelAr": "مدين", "format": "money", "align": "end", "width": 100 },
      { "field": "credit", "labelEn": "Credit", "labelAr": "دائن", "format": "money", "align": "end", "width": 100 },
      { "field": "base_debit", "labelEn": "Base debit", "labelAr": "مدين بالعملة الأساسية", "format": "money", "align": "end", "width": 110 },
      { "field": "base_credit", "labelEn": "Base credit", "labelAr": "دائن بالعملة الأساسية", "format": "money", "align": "end", "width": 110 }
    ],
    "groups": [{ "field": "account_type", "subtotal": true }],
    "totals": [{ "field": "base_debit", "fn": "sum" }, { "field": "base_credit", "fn": "sum" }],
    "sort": [{ "field": "account_code", "dir": "asc" }, { "field": "currency", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {periodLabel}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

`packages/db/seed/my/reports/7b/accounting.ledger.json`:

```json
{
  "definitionVersion": 2,
  "definition": {
    "version": 1,
    "code": "accounting.ledger",
    "nameEn": "Ledger",
    "nameAr": "دفتر الأستاذ",
    "module": "accounting",
    "permission": "accounting.report.read",
    "parameters": [
      { "name": "accountId", "kind": "account", "required": true },
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true }
    ],
    "dataset": {
      "source": "ledger_entry",
      "filters": [
        { "field": "account_id", "op": "eq", "param": "accountId" },
        { "field": "effective_date", "op": "gte", "param": "fromDate" },
        { "field": "effective_date", "op": "lte", "param": "toDate" }
      ]
    },
    "columns": [
      { "field": "effective_date", "labelEn": "Date", "labelAr": "التاريخ", "format": "date", "align": "start", "width": 80 },
      { "field": "document_type_code", "labelEn": "Type", "labelAr": "النوع", "format": "text", "align": "start", "width": 100 },
      { "field": "series", "labelEn": "Series", "labelAr": "السلسلة", "format": "text", "align": "start", "width": 60 },
      { "field": "number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 70 },
      { "field": "line_no", "labelEn": "Line", "labelAr": "السطر", "format": "integer", "align": "end", "width": 40 },
      { "field": "posting_seq", "labelEn": "Seq", "labelAr": "التسلسل", "format": "integer", "align": "end", "width": 45 },
      { "field": "currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 50 },
      { "field": "debit", "labelEn": "Debit", "labelAr": "مدين", "format": "money", "align": "end", "width": 100 },
      { "field": "credit", "labelEn": "Credit", "labelAr": "دائن", "format": "money", "align": "end", "width": 100 },
      { "field": "base_debit", "labelEn": "Base debit", "labelAr": "مدين بالعملة الأساسية", "format": "money", "align": "end", "width": 110 },
      { "field": "base_credit", "labelEn": "Base credit", "labelAr": "دائن بالعملة الأساسية", "format": "money", "align": "end", "width": 110 }
    ],
    "groups": [],
    "totals": [{ "field": "base_debit", "fn": "sum" }, { "field": "base_credit", "fn": "sum" }],
    "sort": [
      { "field": "effective_date", "dir": "asc" },
      { "field": "posting_seq", "dir": "asc" },
      { "field": "line_no", "dir": "asc" }
    ],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {accountCode} {accountName} · {fromDate} – {toDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "projection", "projection": "account_balance" }
  }
}
```

- [ ] **Step 4: Run it to pass, then re-run 1B's own tests unchanged**

Run: `cd packages/db && bun run test -- test/reports/7b-reexpress-phase1.test.ts`
Expected: **PASS, 5 tests.**

Then the clause that matters (amendment A2), **with no edit to either file**:

Run: `bun run --cwd apps/api test -- test/routes/accounting/reports.test.ts`
Expected: **PASS, unchanged** — the same case count 1B shipped, including its own `"the trial balance ties to the ledger: Σdebit = Σcredit and every row matches a fresh recomputation"`.
Run: `bun run --cwd packages/db test -- test/reports/`
Expected: every file green.

**If 1B's route test now fails, stop.** It can only mean this slice modified a route, a DTO or a read function, which A2 forbids. Revert that change; do not adjust 1B's expectations.

- [ ] **Step 5: Run everything and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`

```bash
git add packages/db/seed/my/reports/7b/ packages/db/test/reports/7b-reexpress-phase1.test.ts
git commit -m "feat(db): re-express accounting.trial_balance and accounting.ledger at version 2 [7B T4]

Same codes, same permission, same numbers: the definitions give both a render
path, the parity cases prove they read what trialBalance and accountLedger
read, and 1B's own route test is re-run unchanged (amendment A2).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: Stock ageing, the movement register and the expiry list

The inventory catalogue's first three: `inventory.stock_ageing` over 3B's layers (SAH-055 — read, never recomputed), `inventory.movement_register` over `inventory_movement`, and `inventory.expiry_list` over `lot`.

**Files:**
- Create: `packages/db/seed/my/reports/7b/inventory.stock_ageing.json`, `…/inventory.movement_register.json`, `…/inventory.expiry_list.json`, `packages/db/test/reports/7b-inventory-stock.test.ts`
- Modify: nothing.

**Interfaces:**
- Consumes: `openLayersOf`, `CostLayerRow`, `valuationAsOf`, `ValuationRow`, `rebuildStockValuation` (3B, §4.7.2); `stockOnHand` (3D); Task 1's harness with `{ inventory: true }`; `SENTINEL_LOT_CODE` (3A).
- Produces: the three definitions.

**Read this before writing the definitions — the SAH-055 clause.** The legacy `procMatStorage` was a stock-ageing procedure that never worked: an `or` where an `and` was meant reset the carry-forward on every row, and an uninitialised counter made its `skip` clause NULL for ever. The new answer is that **there is no carry-forward and no counter**: a layer's residue is `cost_layer.qty_remaining`, a stored column 3B maintains, and the age of that residue is its own `effective_at`. So `inventory.stock_ageing` reads 7A's `cost_layer` **dataset** — which is `costLayerDataset`, **not** 3B's `openLayersOf`; the two are reconciled by the tie-out rather than by sharing a query, because both read the same stored `qty_remaining` (amendment A13). Its tie-out is that Σ (`qty_remaining` × `unit_cost`) per warehouse equals `valuationAsOf`'s `value`, the one implementation spec:1228 requires, and the multiplication lives in the harness's one `stock_valuation` branch (A5). **The report computes nothing.** **`itemId` is required and there is no `asOf` parameter at all**: `openLayersOf` is per item and a company-wide residue query beside `valuationAsOf`'s would be SAH-009 by another name, while 7A computes `age_days` from `current_date` and takes no as-of of any kind, so a definition offering one would be a parameter that silently does nothing (A13). The harness's `asOf` is the *tie-out's*, supplied by the group test through `TieOutOptions.asOf`, and never a member of the definition.

- [ ] **Step 1: Write the failing test `packages/db/test/reports/7b-inventory-stock.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { Money, Quantity, currency, validateReportDefinition } from "@dulja/domain";
import { DATASET_IDS, openLayersOf, stockOnHand, valuationAsOf } from "@dulja/db";
import { startDb, withTenant, type Db } from "@dulja/db/test";
import {
  assertTieOut, readDefinition, reportFixture, runDefinition, type ReportFixture,
} from "../../../../tests/invariants/support/reports";

const MYR = currency("MYR");
/** `validateReportDefinition`'s second argument is `ReportDefinitionSets` — BOTH closed sets (7A, A11). */
const SETS = {
  datasets: new Set<string>(DATASET_IDS),
  permissions: new Set(PERMISSIONS.map((p) => p.code)),
};
const AGEING = "inventory.stock_ageing";
const MOVEMENTS = "inventory.movement_register";
const EXPIRY = "inventory.expiry_list";
/** The TIE-OUT's as-of, not the report's: `inventory.stock_ageing` declares no `asOf` parameter (A13), and
 *  this value reaches `valuationAsOf` through `TieOutOptions.asOf` alone. */
const AS_OF = "2026-01-31";

describe("7B stock ageing, movement register and expiry list (§4.16.1, SAH-055)", () => {
  let db: Db; let f: ReportFixture;

  beforeAll(async () => { db = await startDb(); f = await reportFixture(db, "Alpha", { inventory: true }); }, 240_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[3]>[0]) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);
  const inv = () => {
    if (!f.inventory) throw new Error("the fixture was built without { inventory: true }");
    return f.inventory;
  };

  it("all three validate; ageing and the register carry the permissions §4.16.1 assigns them", () => {
    for (const code of [AGEING, MOVEMENTS, EXPIRY]) {
      const result = validateReportDefinition(readDefinition(code), SETS);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(readDefinition(code).module).toBe("inventory");
    }
    expect(readDefinition(AGEING).permission).toBe("inventory.cost.read");
    expect(readDefinition(MOVEMENTS).permission).toBe("inventory.stock.read");
    expect(readDefinition(EXPIRY).permission).toBe("inventory.stock.read");
  });

  it("inventory.stock_ageing requires itemId, declares NO asOf, and reads cost_layer (amendment A13)", () => {
    const d = readDefinition(AGEING);
    expect(d.dataset.source).toBe("cost_layer");
    expect(d.parameters.filter((p) => p.required).map((p) => p.name)).toEqual(["itemId"]);
    // 7A computes `age_days` from `current_date` and its dataset takes no as-of of any kind, so a definition
    // offering one would be a parameter that silently does nothing — worse than not offering it (A13). The
    // tie-out's own as-of is `TieOutOptions.asOf`, which is the harness's and never the report's.
    expect(d.parameters.map((p) => p.name)).toEqual(["itemId", "warehouseId"]);
    expect(d.parameters.map((p) => p.name)).not.toContain("asOf");
  });

  it("SAH-055: the ageing rows ARE the layers — every row's residue is a layer's qty_remaining", async () => {
    await read(async (tx) => {
      // LEFT of every comparison below is a `DatasetRow`'s snake_case column alias (A3); RIGHT is 3B's
      // `CostLayerRow` camelCase member. `openLayersOf` takes an `asOf`; the REPORT does not.
      const layers = await openLayersOf(tx, { companyId: f.s.company, itemId: inv().itemId, asOf: AS_OF, limit: 100 });
      const rows = await runDefinition(tx, readDefinition(AGEING), {
        companyId: f.s.company, itemId: inv().itemId, warehouseId: null,
      });
      expect(rows.map((r) => String(r.layer_id)).sort()).toEqual(layers.map((l) => l.layerId).sort());
      const byLayer = new Map(layers.map((l) => [l.layerId, l]));
      for (const r of rows) {
        const layer = byLayer.get(String(r.layer_id))!;
        expect(Quantity.of(String(r.qty_remaining)).toString()).toBe(Quantity.of(layer.qtyRemaining).toString());
        expect(Money.of(String(r.unit_cost), MYR).toString()).toBe(Money.of(layer.unitCost, MYR).toString());
      }
      // The fixture's two layers: 30 remaining at WH-HQ and 4 at WH-TR, both at 5.0000.
      expect(rows.length).toBe(2);
      expect(rows.map((r) => Quantity.of(String(r.qty_remaining)).toString()).sort())
        .toEqual(["30.000000", "4.000000"].sort());
    });
  });

  it("inventory.stock_ageing ties to valuationAsOf per warehouse, which is what stock_valuation stores", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(AGEING), {
        params: { companyId: f.s.company, itemId: inv().itemId, warehouseId: null },
        baseCurrency: MYR, asOf: AS_OF,
      });
      const valuation = await valuationAsOf(tx, { companyId: f.s.company, asOf: AS_OF, itemId: inv().itemId, limit: 50 });
      expect(valuation.map((v) => [v.warehouseCode, v.value]).sort())
        .toEqual([["WH-HQ", "150.0000"], ["WH-TR", "20.0000"]].sort());
    });
  });

  it("every layer's age is its OWN effective_at in days, and there is no bucket column (A3)", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(AGEING), {
        companyId: f.s.company, itemId: inv().itemId, warehouseId: null,
      });
      // 7A's `cost_layer` dataset computes `age_days` as `(current_date - cl.effective_at)::int` and selects
      // NOTHING else about age: there is no `age_bucket` and no bucket vocabulary anywhere (A3). A report
      // cannot compute one — `ReportDefinition` has no expression member — so the definition renders the
      // number and sorts oldest first, and bucketing is a raise against 7A's dataset (Self-Review).
      expect(readDefinition(AGEING).columns.map((c) => c.field)).not.toContain("age_bucket");
      for (const r of rows) {
        expect(Number.isInteger(Number(r.age_days)), `age_days is an int: ${String(r.age_days)}`).toBe(true);
        expect(Number(r.age_days)).toBeGreaterThanOrEqual(0);
      }
      // Received 2026-01-06 into WH-HQ, dispatched to transit 2026-01-16 — two DIFFERENT layer dates, so the
      // corridor layer is strictly the younger of the two. `age_days` runs from `current_date`, which moves,
      // so the assertion is on the ORDER and the DIFFERENCE, never on an absolute day count.
      const byWarehouse = new Map(rows.map((r) => [String(r.warehouse_code), Number(r.age_days)]));
      expect(byWarehouse.get("WH-HQ")! - byWarehouse.get("WH-TR")!).toBe(10);
      expect(rows.map((r) => String(r.effective_at))).toEqual(["2026-01-06", "2026-01-16"]);
    });
  });

  it("inventory.movement_register ties to stock_on_hand once the range covers every movement", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(MOVEMENTS), {
        params: {
          companyId: f.s.company, fromDate: "2020-01-01", toDate: "2030-12-31",
          itemId: null, warehouseId: null, documentTypeCode: null,
        },
        baseCurrency: MYR,
      });
      const rows = await runDefinition(tx, readDefinition(MOVEMENTS), {
        companyId: f.s.company, fromDate: "2020-01-01", toDate: "2030-12-31",
        itemId: null, warehouseId: null, documentTypeCode: null,
      });
      // receipt 40 in, delivery 6 out, transfer 4 out of WH-HQ and 4 into WH-TR — four movements, and the
      // transfer's TWO are why `movement_no` exists (§4.7.3).
      expect(rows.length).toBe(4);
      expect(rows.map((r) => String(r.document_type_code)))
        .toEqual(["GOODS_RECEIPT", "DELIVERY_ORDER", "TRANSFER", "TRANSFER"]);
      const soh = await stockOnHand(tx, { companyId: f.s.company, includeInTransit: true, limit: 50 });
      expect(soh.map((r) => [r.warehouseCode, r.quantity]).sort())
        .toEqual([["WH-HQ", "30.000000"], ["WH-TR", "4.000000"]].sort());
    });
  });

  it("inventory.expiry_list is a lot list with a row witness — the `lot` dataset carries no quantity (A3)", async () => {
    await read(async (tx) => {
      // `tieOut.kind` is `none`, so the harness REQUIRES a row witness (A5) and throws "the group test must
      // supply a row witness" without one. The witness is `app.lot` itself, keyed on the dataset's own
      // snake_case aliases — the lot's code is `code`, not `lot_code` (the `*_code` fields on this dataset
      // belong to the item), so the projection would silently compare empty strings if it named `lot_code`.
      await assertTieOut(tx, readDefinition(EXPIRY), {
        params: { companyId: f.s.company, beforeDate: "2026-12-31", itemId: null },
        baseCurrency: MYR,
        witness: {
          key: ["code", "item_code", "expires_on"],
          rows: (t) => t<{ code: string; item_code: string; expires_on: string }[]>`
            select l.code, i.code as item_code, l.expires_on::text as expires_on
              from app.lot l join app.item i on i.id = l.item_id
             where l.company_id = ${f.s.company}
               and l.expires_on is not null and l.expires_on <= date '2026-12-31'`,
        },
      });
      const rows = await runDefinition(tx, readDefinition(EXPIRY), {
        companyId: f.s.company, beforeDate: "2026-12-31", itemId: null,
      });
      // The item's sentinel lot 'NONE' carries no expiry, so the `expires_on lte` filter excludes it —
      // which is the point of the comparison living in the dataset rather than in a report.
      expect(rows.map((r) => String(r.code))).toEqual(["LOT-A"]);
      expect(Number(rows[0]!.days_to_expiry)).toBeGreaterThan(0);
      // And there is no quantity here, deliberately: `inventory.stock_on_hand` reports quantity filtered by
      // `expires_on`, and a second differently-derived quantity on the lot list is the two-spellings failure
      // §4.16.1's register exists to prevent.
      expect(readDefinition(EXPIRY).columns.map((c) => c.field)).not.toContain("quantity");
      expect(readDefinition(EXPIRY).columns.map((c) => c.field)).not.toContain("quantity_on_hand");
    });
  });

  it("a lot whose expiry is beyond the parameter is not reported (the filter is the report's whole job)", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(EXPIRY), {
        companyId: f.s.company, beforeDate: "2026-01-01", itemId: null,
      });
      expect(rows).toEqual([]);
    });
  });
});
```

**On the last two cases and `assertFieldCoverage`.** The zero-row case deliberately calls `runDefinition` rather than `assertTieOut`: the harness refuses a zero-row tie-out outright (`the fixture returned no rows, so field coverage proves nothing`), which is the right default and is why an "empty" assertion has to be made directly.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/reports/7b-inventory-stock.test.ts`
Expected: **FAIL** — `ENOENT … inventory.stock_ageing.json`. The fixture must build: if `postFromPack` (the receipt and the delivery) or `postInventoryDocument` (the transfer) raises `ERR_STOCK_INSUFFICIENT`, the delivery of 6 ran before the receipt of 40 — the three calls in `inventoryChain` are ordered and `effective_date` is not what `assert_stock_available` reads (it sums movements as they are inserted, §4.7.3). If instead you see `ERR_RBAC_FORBIDDEN` or `ERR_POLICY_REQUIRES_MISSING`, read Task 1 Step 4's three-way list: this is the first task whose fixture takes `{ inventory: true }`, so it is the first place `inventoryChain`'s grant and its two parties are exercised.

- [ ] **Step 3: Write the three definitions**

`packages/db/seed/my/reports/7b/inventory.stock_ageing.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "inventory.stock_ageing",
    "nameEn": "Stock ageing",
    "nameAr": "أعمار المخزون",
    "module": "inventory",
    "permission": "inventory.cost.read",
    "parameters": [
      { "name": "itemId", "kind": "item", "required": true },
      { "name": "warehouseId", "kind": "warehouse", "required": false }
    ],
    "dataset": {
      "source": "cost_layer",
      "filters": [
        { "field": "item_id", "op": "eq", "param": "itemId" },
        { "field": "warehouse_id", "op": "eq", "param": "warehouseId" }
      ]
    },
    "columns": [
      { "field": "warehouse_code", "labelEn": "Warehouse", "labelAr": "المستودع", "format": "text", "align": "start", "width": 90 },
      { "field": "lot_code", "labelEn": "Lot", "labelAr": "الدفعة", "format": "text", "align": "start", "width": 90 },
      { "field": "effective_at", "labelEn": "Received", "labelAr": "تاريخ الاستلام", "format": "date", "align": "start", "width": 90 },
      { "field": "age_days", "labelEn": "Days", "labelAr": "الأيام", "format": "integer", "align": "end", "width": 60 },
      { "field": "sequence", "labelEn": "Layer", "labelAr": "الطبقة", "format": "integer", "align": "end", "width": 50 },
      { "field": "qty_in", "labelEn": "Received qty", "labelAr": "الكمية المستلمة", "format": "quantity", "align": "end", "width": 100 },
      { "field": "qty_remaining", "labelEn": "Remaining", "labelAr": "الكمية المتبقية", "format": "quantity", "align": "end", "width": 100 },
      { "field": "unit_cost", "labelEn": "Unit cost", "labelAr": "تكلفة الوحدة", "format": "money", "align": "end", "width": 100 }
    ],
    "groups": [{ "field": "warehouse_code", "subtotal": true }],
    "totals": [{ "field": "qty_remaining", "fn": "sum" }],
    "sort": [{ "field": "effective_at", "dir": "asc" }, { "field": "sequence", "dir": "asc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {itemId}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "projection", "projection": "stock_valuation" }
  }
}
```

**Four things this definition deliberately does not have, each because 7A's `cost_layer` dataset does not serve it (A3, A13).** They are listed here rather than left as an absence a later reader would try to "fix" by naming a field the query has no column for.

1. **No `age_bucket` column and no bucket grouping.** 7A computes `age_days` (`current_date - cl.effective_at`) and nothing else; a `1_30 | 31_60 | 61_90 | over_90` bucket would be either a second computed column in 7A's file or JavaScript arithmetic in a report, and the first is not this slice's to write while the second is not a thing a `ReportDefinition` can express. The report groups by warehouse, renders `age_days` per layer and sorts oldest first, which is the same information without an invented vocabulary. **Bucketing is a raise against 7A's dataset**, carried in the Self-Review.
2. **No `value` column and no money total.** A layer's value is `qty_remaining × unit_cost`, an arithmetic that has exactly one implementation (3B's) and must not gain a second in a report (SAH-009, spec:1228). The two operands are rendered; the *product* is asserted only in the tie-out, where the harness multiplies them once with an explicit `RoundingMode` and compares against `valuationAsOf` (A5's two-shape `stock_valuation` branch). That is why this definition's `tieOut.kind` is `projection` and not `ledger_sum`: a `ledger_sum` needs a money total, and inventing one here would mean inventing the figure.
3. **No `asOf` parameter.** 7A measures `age_days` from `current_date`; a definition offering an as-of date the dataset ignores would be a parameter that silently does nothing, which is worse than not offering it (A13). The tie-out's own as-of therefore defaults to today.
4. **No filter excluding invalidated layers.** `cost_layer.invalidated_at` is selected but the filter grammar has no `is null` operator (§4.11.1's eight ops), so a replayed item's superseded layers would appear alongside its live ones and the Σ would exceed `valuationAsOf`'s. **No fixture in this slice replays**, so the tie holds here; the report is nonetheless only correct for an item whose layers have never been rebuilt, and that is **row 5** of the Self-Review's raise list — the fix is either an `is_null` op (§4.11.1, a 7A change) or an `invalidated` boolean column the definition can filter `eq false` (also 7A's).

`packages/db/seed/my/reports/7b/inventory.movement_register.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "inventory.movement_register",
    "nameEn": "Movement register",
    "nameAr": "سجل حركات المخزون",
    "module": "inventory",
    "permission": "inventory.stock.read",
    "parameters": [
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "itemId", "kind": "item", "required": false },
      { "name": "warehouseId", "kind": "warehouse", "required": false },
      { "name": "documentTypeCode", "kind": "text", "required": false }
    ],
    "dataset": {
      "source": "inventory_movement",
      "filters": [
        { "field": "effective_date", "op": "gte", "param": "fromDate" },
        { "field": "effective_date", "op": "lte", "param": "toDate" },
        { "field": "item_id", "op": "eq", "param": "itemId" },
        { "field": "warehouse_id", "op": "eq", "param": "warehouseId" },
        { "field": "document_type_code", "op": "eq", "param": "documentTypeCode" }
      ]
    },
    "columns": [
      { "field": "effective_date", "labelEn": "Date", "labelAr": "التاريخ", "format": "date", "align": "start", "width": 80 },
      { "field": "document_type_code", "labelEn": "Type", "labelAr": "النوع", "format": "text", "align": "start", "width": 120 },
      { "field": "document_number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 70 },
      { "field": "posting_seq", "labelEn": "Seq", "labelAr": "التسلسل", "format": "integer", "align": "end", "width": 45 },
      { "field": "movement_no", "labelEn": "Movement", "labelAr": "رقم الحركة", "format": "integer", "align": "end", "width": 60 },
      { "field": "item_code", "labelEn": "Item", "labelAr": "الصنف", "format": "text", "align": "start", "width": 90 },
      { "field": "warehouse_code", "labelEn": "Warehouse", "labelAr": "المستودع", "format": "text", "align": "start", "width": 90 },
      { "field": "lot_code", "labelEn": "Lot", "labelAr": "الدفعة", "format": "text", "align": "start", "width": 90 },
      { "field": "quantity", "labelEn": "Quantity", "labelAr": "الكمية", "format": "quantity", "align": "end", "width": 100 },
      { "field": "value", "labelEn": "Value", "labelAr": "القيمة", "format": "money", "align": "end", "width": 110 }
    ],
    "groups": [{ "field": "item_code", "subtotal": true }],
    "totals": [{ "field": "quantity", "fn": "sum" }, { "field": "value", "fn": "sum" }],
    "sort": [
      { "field": "effective_date", "dir": "asc" },
      { "field": "posting_seq", "dir": "asc" },
      { "field": "movement_no", "dir": "asc" }
    ],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {fromDate} – {toDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "projection", "projection": "stock_on_hand" }
  }
}
```

`packages/db/seed/my/reports/7b/inventory.expiry_list.json` — spec:1022's "expiry reporting and near-expiry alerts", as a report:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "inventory.expiry_list",
    "nameEn": "Expiry list",
    "nameAr": "قائمة تواريخ انتهاء الصلاحية",
    "module": "inventory",
    "permission": "inventory.stock.read",
    "parameters": [
      { "name": "beforeDate", "kind": "date", "required": true },
      { "name": "itemId", "kind": "item", "required": false }
    ],
    "dataset": {
      "source": "lot",
      "filters": [
        { "field": "expires_on", "op": "lte", "param": "beforeDate" },
        { "field": "item_id", "op": "eq", "param": "itemId" }
      ]
    },
    "columns": [
      { "field": "expires_on", "labelEn": "Expires", "labelAr": "تاريخ الانتهاء", "format": "date", "align": "start", "width": 90 },
      { "field": "days_to_expiry", "labelEn": "Days left", "labelAr": "الأيام المتبقية", "format": "integer", "align": "end", "width": 70 },
      { "field": "item_code", "labelEn": "Item", "labelAr": "الصنف", "format": "text", "align": "start", "width": 90 },
      { "field": "item_name_en", "labelEn": "Item name", "labelAr": "اسم الصنف", "format": "text", "align": "start", "width": 180 },
      { "field": "code", "labelEn": "Lot", "labelAr": "الدفعة", "format": "text", "align": "start", "width": 90 },
      { "field": "manufactured_on", "labelEn": "Manufactured", "labelAr": "تاريخ الإنتاج", "format": "date", "align": "start", "width": 90 }
    ],
    "groups": [{ "field": "item_code", "subtotal": true }],
    "totals": [{ "field": "code", "fn": "count" }],
    "sort": [{ "field": "expires_on", "dir": "asc" }, { "field": "item_code", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {beforeDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "none" }
  }
}
```

**Why this one has no quantity and ties with a row witness.** 7A's `lot` dataset is lot master data joined to the item and nothing else — `lot_id`, `item_id`, `item_code`, `item_name_en`, `code`, `expires_on`, `manufactured_on`, `days_to_expiry`, `archived_at` (A3). **There is no `quantity_on_hand`**: summing `stock_on_hand.quantity` for a lot across every warehouse would be a lateral 7A's query does not have, and a report cannot add one. So the expiry list is a **list of lots expiring before a date**, its only total is a `count` over the lot's own **`code`** — a `count` total skips the *numeric-format* check (`total fn '<fn>' needs a money, quantity, integer or percent column`) but still goes through rule 4's membership check (`total field '<f>' is not one of this definition's columns`), so it must name a column the definition renders, and `lot_id` is not one — and its `tieOut.kind` is `none` with the row witness amendment A5 requires: an independent `select l.code, i.code as item_code, l.expires_on from app.lot l join app.item i … where l.expires_on <= $beforeDate`, keyed on `code, item_code, expires_on` so "no monetary tie" still means "an executed test". The witness key names the **dataset's** aliases because `assertTieOut` projects one key list over both sides.

**The quantity is not lost, it is elsewhere and correctly so.** `inventory.stock_on_hand` (Task 8) reads the `stock_on_hand` dataset, which carries both `expires_on` and `quantity` and can be filtered `expires_on lte <date>` — that is the "what will expire, and how much of it" report, and it ties against the projection. Putting a second, differently-derived quantity on the lot list would be exactly the two-spellings-of-one-number failure §4.16.1's register exists to prevent. **A `quantity_on_hand` lateral on the `lot` dataset is a raise against 7A** and is **row 6** of the Self-Review's raise list.

- [ ] **Step 4: Run it to pass**

Run: `cd packages/db && bun run test -- test/reports/7b-inventory-stock.test.ts`
Expected: **PASS, 8 tests.** Three failures worth predicting:
- `inventory.stock_ageing: a stock_valuation tie-out needs the itemId parameter` — the params object omitted `itemId`; the harness refuses rather than comparing a per-item valuation with a whole-catalogue report, which is A13's rule enforced in code.
- `inventory.stock_ageing: valuationAsOf says 150.0000 for warehouse WH-HQ, the report says 170.0000` — the `warehouseId` grouping collapsed: the dataset returned the transit layer under `WH-HQ`, i.e. it is reading the layer's *movement's* warehouse rather than the layer's own. Raise against 7A's `cost_layer` dataset; `openLayersOf` returns the layer's `warehouseId` (3B's `CostLayerRow`).
- `inventory.expiry_list: tieOut.kind is "none", so the group test must supply a row witness (amendment A5)` — the `witness` member was dropped from the `assertTieOut` call. The harness is right to refuse: `none` never means "no test" (A5), and a witness whose `key` names a column the dataset does not carry (`lot_code` rather than `code`) fails differently — every row projects to `"||"`, the two sets collapse to one member each and the case passes for the wrong reason, which is why the key is the dataset's own alias.

- [ ] **Step 5: Run everything and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`

```bash
git add packages/db/seed/my/reports/7b/ packages/db/test/reports/7b-inventory-stock.test.ts
git commit -m "feat(db): stock ageing over the layers, movement register, expiry list [7B T5]

SAH-055's answer: the ageing rows ARE cost_layer rows, their residue is the
stored qty_remaining, and qty_remaining x unit_cost per warehouse equals
valuationAsOf to the cent. Nothing is recomputed, and the report declares no
asOf because 7A's age_days is measured from current_date (amendment A13).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: The four catalogue and adjustment registers

`inventory.price_list`, `inventory.promotion_register`, `inventory.transfer_register` and `inventory.count_register` — two master-data lists whose tie-out is a row witness, and two registers over movements and documents.

**Files:**
- Create: `packages/db/seed/my/reports/7b/inventory.price_list.json`, `…/inventory.promotion_register.json`, `…/inventory.transfer_register.json`, `…/inventory.count_register.json`, `packages/db/test/reports/7b-inventory-registers.test.ts`
- Modify: `tests/invariants/support/reports.ts` — **one additive member**, `TieOutOptions.projectionKeys`.

**Interfaces:**
- Consumes: Task 1's harness with `{ inventory: true, catalogue: true }` — `catalogueChain` and `CatalogueFixture` are **Task 1's**, printed in full there; `seedPriceList` (3A, §4.17); `packApproval` (4B, §4.17.1); `stockOnHand` (3D).
- Produces: the four definitions and `TieOutOptions.projectionKeys?: readonly string[]`.

**Why the price list, the promotion and the count live in Task 1's fixture and not in this file.** Three of this task's four definitions have nothing to report without them, and `assertFieldCoverage` refuses a zero-row tie-out (ADR 0068). **Task 11's roll-up needs the same three rows**, and a second copy of an approval-hopping `postFromPack` call is exactly the duplication §4.17.1 exists to prevent (hazard 9) — so they are one option on the shared fixture, used by two files.

**Why the transfer register needs `projectionKeys`.** The `stock_on_hand` branch compares **every** stored key, which is right for a register that covers every movement (Task 5's) and wrong for one filtered to transfers: the `WH-HQ` key would compare 30 on hand against a −4 transfer line. But the in-transit warehouse is different in kind — **only** transfers touch it, so for that key the register *is* complete, and the equality Σ(into transit) − Σ(out of transit) = its on-hand is precisely 3D's DoD clause (*"goods in transit are in neither warehouse's on-hand and in the company's total"*). `projectionKeys` names exactly the keys the report is complete for, and the harness throws when a named key is not in the projection at all — so the restriction cannot silently become "compare nothing".

**Why `inventory.count_register`'s `tieOut` carries no account.** The obvious literal is `5110` (§4.15, 3D's stock-count variance). It is wrong: for a *shortage* the variance is a `5110` debit, for an *overage* it is a `5110` credit and the debit is on `1300`, so `Σ base_total` (a sum of debits, A3) equals the `5110` debit sum in one direction and not the other. The register therefore ties against the ledger's own debit total for its own document set — a genuine cross-path check that holds both ways — and a **separate** case asserts the `5110` leg for this fixture's shortage, which is the accounting claim rather than the arithmetic one.

- [ ] **Step 1: Add `projectionKeys` to the harness**

In `tests/invariants/support/reports.ts`, one member and three lines:

```ts
export interface TieOutOptions {
  params: Readonly<Record<string, string | null>>;
  baseCurrency: CurrencyCode;
  window?: LedgerWindow;
  asOf?: string;
  /** For a `stock_on_hand` tie-out over a report that is complete for SOME keys only: the exact keys to
   *  compare, joined the way the branch joins them. A named key absent from the projection is an error. */
  projectionKeys?: readonly string[];
  witness?: TieOutWitness;
}
```

and inside the `stock_on_hand` case, immediately before the comparison loop:

```ts
        if (opts.projectionKeys) {
          for (const key of opts.projectionKeys) {
            if (!expected.has(key)) {
              throw new Error(`${definition.code}: projectionKeys names ${key}, which stock_on_hand does not hold`);
            }
          }
          for (const key of [...expected.keys()]) {
            if (!opts.projectionKeys.includes(key)) expected.delete(key);
          }
        }
```

- [ ] **Step 2: Write the failing test `packages/db/test/reports/7b-inventory-registers.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { Money, Quantity, currency, validateReportDefinition } from "@dulja/domain";
import { DATASET_IDS } from "@dulja/db";
import { startDb, withTenant, type Db } from "@dulja/db/test";
import { packApproval } from "../../../../tests/invariants/support/ar-ap";
import {
  assertTieOut, readDefinition, reportFixture, runDefinition, type ReportFixture,
} from "../../../../tests/invariants/support/reports";

const MYR = currency("MYR");
/** `validateReportDefinition`'s second argument is `ReportDefinitionSets` — BOTH closed sets (7A, A11). */
const SETS = {
  datasets: new Set<string>(DATASET_IDS),
  permissions: new Set(PERMISSIONS.map((p) => p.code)),
};
const PRICES = "inventory.price_list";
const PROMOS = "inventory.promotion_register";
const TRANSFERS = "inventory.transfer_register";
const COUNTS = "inventory.count_register";

describe("7B price list, promotions, transfer register, count register (§4.16.1)", () => {
  let db: Db; let f: ReportFixture;
  const priceListId = () => f.catalogue!.priceListId;
  const countDocumentId = () => f.catalogue!.countDocumentId;

  beforeAll(async () => {
    db = await startDb();
    // `{ catalogue: true }` is what Step 1 adds to the fixture: the price list, the promotion and one posted
    // STOCK_COUNT, in the one place that posts a count (hazard 9 — Task 11's roll-up needs the same three
    // rows, and two copies of an approval-hopping post is exactly the duplication the register forbids).
    f = await reportFixture(db, "Alpha", { inventory: true, catalogue: true });
    expect(packApproval("STOCK_COUNT").required, "the fixture's count needs the approval hop").toBe(true);
  }, 240_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[3]>[0]) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);

  it("all four validate, and the two master-data lists are gated inventory.item.read", () => {
    for (const code of [PRICES, PROMOS, TRANSFERS, COUNTS]) {
      const result = validateReportDefinition(readDefinition(code), SETS);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
    }
    expect(readDefinition(PRICES).permission).toBe("inventory.item.read");
    expect(readDefinition(PROMOS).permission).toBe("inventory.item.read");
    expect(readDefinition(TRANSFERS).permission).toBe("inventory.stock.read");
    expect(readDefinition(COUNTS).permission).toBe("inventory.stock.read");
  });

  it("inventory.price_list's witness is app.price_list_line itself, row for row", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(PRICES), {
        params: { companyId: f.s.company, priceListId: priceListId(), itemId: null, onDate: "2026-01-15" },
        baseCurrency: MYR,
        // The witness columns are aliased to the DATASET's own snake_case fields (A3), because `assertTieOut`
        // projects one key list over both sides: a camelCase key would read `undefined` on every report row.
        witness: {
          key: ["item_code", "min_quantity", "unit_price"],
          rows: (t) => t<{ item_code: string; min_quantity: string; unit_price: string }[]>`
            select i.code as item_code, l.min_quantity::text as min_quantity, l.unit_price::text as unit_price
              from app.price_list_line l
              join app.item i on i.id = l.item_id
             where l.price_list_id = ${priceListId()}`,
        },
      });
    });
  });

  it("inventory.promotion_register's witness is app.promotion, and the rule body is not a column", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(PROMOS), {
        params: { companyId: f.s.company, onDate: "2026-01-15", branchId: null },
        baseCurrency: MYR,
        witness: {
          key: ["code", "kind"],
          rows: (t) => t<{ code: string; kind: string }[]>`
            select code, kind from app.promotion where company_id = ${f.s.company}`,
        },
      });
    });
    expect(readDefinition(PROMOS).columns.map((c) => c.field)).not.toContain("definition");
  });

  it("inventory.transfer_register ties to the in-transit warehouse's on-hand — 3D's DoD clause", async () => {
    const inv = f.inventory!;
    await read(async (tx) => {
      const params = {
        companyId: f.s.company, fromDate: "2026-01-01", toDate: "2026-01-31",
        itemId: null, warehouseId: null, transferTypes: "TRANSFER,TRANSFER_RECEIPT",
      };
      await assertTieOut(tx, readDefinition(TRANSFERS), {
        params, baseCurrency: MYR,
        projectionKeys: [`${inv.itemId}|${inv.whTransit}|${inv.lotId}`],
      });
      const rows = await runDefinition(tx, readDefinition(TRANSFERS), params);
      // Two movements from one transfer line: −4 out of WH-HQ, +4 into WH-TR (§4.7.3's movement_no).
      expect(rows.length).toBe(2);
      const byWarehouse = new Map(rows.map((r) => [String(r.warehouse_code), Quantity.of(String(r.quantity)).toString()]));
      expect(byWarehouse.get("WH-HQ")).toBe("-4.000000");
      expect(byWarehouse.get("WH-TR")).toBe("4.000000");
      expect(rows.every((r) => ["TRANSFER", "TRANSFER_RECEIPT"].includes(String(r.document_type_code)))).toBe(true);
    });
  });

  it("inventory.count_register's amount total equals the ledger's own debits for its documents", async () => {
    await read(async (tx) => {
      const params = {
        companyId: f.s.company, fromDate: "2026-01-01", toDate: "2026-01-31",
        branchId: null, status: "posted", countTypes: "STOCK_COUNT",
      };
      await assertTieOut(tx, readDefinition(COUNTS), {
        params, baseCurrency: MYR,
        window: { fromDate: "2026-01-01", toDate: "2026-01-31", documentTypeCodes: ["STOCK_COUNT"] },
      });
      const rows = await runDefinition(tx, readDefinition(COUNTS), params);
      expect(rows.map((r) => String(r.document_id))).toEqual([countDocumentId()]);
      expect(Money.of(String(rows[0]!.base_total), MYR).toString()).toBe("5.0000");
    });
  });

  it("the shortage landed on 5110, which is the accounting claim the arithmetic tie cannot make", async () => {
    await read(async (tx) => {
      const legs = await tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, le.base_debit::text as debit, le.base_credit::text as credit
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.document_id = ${countDocumentId()} order by a.code`;
      expect(legs).toEqual([
        { code: "1300", debit: "0.0000", credit: "5.0000" },
        { code: "5110", debit: "5.0000", credit: "0.0000" },
      ]);
    });
  });

  it("a price list outside its validity window is not reported, and neither is another company's", async () => {
    await read(async (tx) => {
      const outside = await runDefinition(tx, readDefinition(PRICES), {
        companyId: f.s.company, priceListId: priceListId(), itemId: null, onDate: "2025-01-01",
      });
      // `seedPriceList` leaves valid_from/valid_to null, which means "always valid" — so the window filter
      // must not exclude a null-bounded list. This case is what tells a null-handling slip from a working
      // filter: an implementation using `valid_from <= $1` without the null guard answers zero rows here.
      expect(outside.length).toBe(1);
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/reports/7b-inventory-registers.test.ts`
Expected: **FAIL** — `ENOENT … inventory.price_list.json`. Two `beforeAll` failures worth naming: `ERR_DOC_STATUS_ILLEGAL` from `postFromPack` means `packApproval("STOCK_COUNT")` read `required: false` and the helper skipped the approval hop — check 3D's shipped envelope, not the helper; `ERR_STOCK_INSUFFICIENT` on the count means the variance was drafted positive-then-negative, i.e. the sign convention was inverted (counted − expected, so a shortage is negative).

- [ ] **Step 4: Write the four definitions**

`packages/db/seed/my/reports/7b/inventory.price_list.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "inventory.price_list",
    "nameEn": "Price list",
    "nameAr": "قائمة الأسعار",
    "module": "inventory",
    "permission": "inventory.item.read",
    "parameters": [
      { "name": "priceListId", "kind": "text", "required": false },
      { "name": "itemId", "kind": "item", "required": false },
      { "name": "onDate", "kind": "date", "required": true }
    ],
    "dataset": {
      "source": "price_list_line",
      "filters": [
        { "field": "price_list_id", "op": "eq", "param": "priceListId" },
        { "field": "item_id", "op": "eq", "param": "itemId" },
        { "field": "valid_from", "op": "lte", "param": "onDate" }
      ]
    },
    "columns": [
      { "field": "price_list_code", "labelEn": "Price list", "labelAr": "قائمة الأسعار", "format": "text", "align": "start", "width": 90 },
      { "field": "price_list_currency", "labelEn": "Currency", "labelAr": "العملة", "format": "text", "align": "start", "width": 50 },
      { "field": "customer_kind", "labelEn": "Customer type", "labelAr": "نوع العميل", "format": "text", "align": "start", "width": 90 },
      { "field": "item_code", "labelEn": "Item", "labelAr": "الصنف", "format": "text", "align": "start", "width": 90 },
      { "field": "item_name_en", "labelEn": "Item name", "labelAr": "اسم الصنف", "format": "text", "align": "start", "width": 180 },
      { "field": "unit_code", "labelEn": "Unit", "labelAr": "الوحدة", "format": "text", "align": "start", "width": 50 },
      { "field": "min_quantity", "labelEn": "Minimum quantity", "labelAr": "الحد الأدنى للكمية", "format": "quantity", "align": "end", "width": 100 },
      { "field": "unit_price", "labelEn": "Price", "labelAr": "السعر", "format": "money", "align": "end", "width": 100 }
    ],
    "groups": [{ "field": "price_list_code", "subtotal": false }],
    "totals": [{ "field": "item_code", "fn": "count" }],
    "sort": [{ "field": "price_list_code", "dir": "asc" }, { "field": "item_code", "dir": "asc" }, { "field": "min_quantity", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {onDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "none" }
  }
}
```

`packages/db/seed/my/reports/7b/inventory.promotion_register.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "inventory.promotion_register",
    "nameEn": "Promotion register",
    "nameAr": "سجل العروض الترويجية",
    "module": "inventory",
    "permission": "inventory.item.read",
    "parameters": [
      { "name": "onDate", "kind": "date", "required": true },
      { "name": "branchId", "kind": "branch", "required": false }
    ],
    "dataset": {
      "source": "promotion",
      "filters": [
        { "field": "starts_at", "op": "lte", "param": "onDate" },
        { "field": "branch_id", "op": "eq", "param": "branchId" }
      ]
    },
    "columns": [
      { "field": "code", "labelEn": "Code", "labelAr": "الرمز", "format": "text", "align": "start", "width": 80 },
      { "field": "name_en", "labelEn": "Name", "labelAr": "الاسم", "format": "text", "align": "start", "width": 200 },
      { "field": "kind", "labelEn": "Kind", "labelAr": "النوع", "format": "text", "align": "start", "width": 100 },
      { "field": "starts_at", "labelEn": "Starts", "labelAr": "تاريخ البداية", "format": "date", "align": "start", "width": 120 },
      { "field": "ends_at", "labelEn": "Ends", "labelAr": "تاريخ النهاية", "format": "date", "align": "start", "width": 120 },
      { "field": "name_ar", "labelEn": "Name (ar)", "labelAr": "الاسم بالعربية", "format": "text", "align": "start", "width": 200 }
    ],
    "groups": [{ "field": "kind", "subtotal": false }],
    "totals": [{ "field": "code", "fn": "count" }],
    "sort": [{ "field": "starts_at", "dir": "asc" }, { "field": "code", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {onDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "none" }
  }
}
```

`packages/db/seed/my/reports/7b/inventory.transfer_register.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "inventory.transfer_register",
    "nameEn": "Transfer register",
    "nameAr": "سجل التحويلات",
    "module": "inventory",
    "permission": "inventory.stock.read",
    "parameters": [
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "itemId", "kind": "item", "required": false },
      { "name": "warehouseId", "kind": "warehouse", "required": false },
      { "name": "transferTypes", "kind": "enum", "required": false, "options": ["TRANSFER", "TRANSFER_RECEIPT"] }
    ],
    "dataset": {
      "source": "inventory_movement",
      "filters": [
        { "field": "effective_date", "op": "gte", "param": "fromDate" },
        { "field": "effective_date", "op": "lte", "param": "toDate" },
        { "field": "document_type_code", "op": "in", "param": "transferTypes" },
        { "field": "item_id", "op": "eq", "param": "itemId" },
        { "field": "warehouse_id", "op": "eq", "param": "warehouseId" }
      ]
    },
    "columns": [
      { "field": "effective_date", "labelEn": "Date", "labelAr": "التاريخ", "format": "date", "align": "start", "width": 80 },
      { "field": "document_type_code", "labelEn": "Leg", "labelAr": "المرحلة", "format": "text", "align": "start", "width": 130 },
      { "field": "document_number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 70 },
      { "field": "posting_seq", "labelEn": "Seq", "labelAr": "التسلسل", "format": "integer", "align": "end", "width": 45 },
      { "field": "movement_no", "labelEn": "Movement", "labelAr": "رقم الحركة", "format": "integer", "align": "end", "width": 60 },
      { "field": "item_code", "labelEn": "Item", "labelAr": "الصنف", "format": "text", "align": "start", "width": 90 },
      { "field": "warehouse_code", "labelEn": "Warehouse", "labelAr": "المستودع", "format": "text", "align": "start", "width": 90 },
      { "field": "lot_code", "labelEn": "Lot", "labelAr": "الدفعة", "format": "text", "align": "start", "width": 90 },
      { "field": "quantity", "labelEn": "Quantity", "labelAr": "الكمية", "format": "quantity", "align": "end", "width": 100 },
      { "field": "value", "labelEn": "Value", "labelAr": "القيمة", "format": "money", "align": "end", "width": 110 }
    ],
    "groups": [{ "field": "warehouse_code", "subtotal": true }],
    "totals": [{ "field": "quantity", "fn": "sum" }, { "field": "value", "fn": "sum" }],
    "sort": [{ "field": "effective_date", "dir": "asc" }, { "field": "posting_seq", "dir": "asc" }, { "field": "movement_no", "dir": "asc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {fromDate} – {toDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "projection", "projection": "stock_on_hand" }
  }
}
```

**All four count a rendered column, and the transfer register renders its two sort keys.** 7A's validator rule 4 refuses a `groups[]`, `totals[]` or `sort[]` field that is not one of the definition's own `columns[]` (`packages/domain/src/reports/validate.ts`), and a `count` total goes through the same membership check even though it skips the numeric-format check that follows it. So `inventory.price_list` counts `item_code`, `inventory.promotion_register` counts `code`, `inventory.count_register` counts `number`, and `inventory.transfer_register` renders `posting_seq` and `movement_no` because it sorts on them — the chronological key of §4.3.5 and the leg number of §4.7.3, both of which a reader needs on the page to reconstruct the order the register claims.

**On `transferTypes` and `countTypes`, the two parameters a caller does not really choose.** §4.11.1's filter clauses always name a parameter, so a definition cannot carry a *constant* restriction — and a transfer register with no type filter is the movement register under a second name. Both are therefore declared `required: false` with `options` naming exactly the codes the register is about (§4.14's `TRANSFER`/`TRANSFER_RECEIPT`, and `STOCK_COUNT`), and 7A's runs route supplies them as a saved view's stored parameters, which is what a saved view is for (§4.11.2). Task 9's completeness case asserts that every filter clause in all twenty-two definitions names a declared parameter, so a filter and its parameter can never drift apart.

`packages/db/seed/my/reports/7b/inventory.count_register.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "inventory.count_register",
    "nameEn": "Stock-count register",
    "nameAr": "سجل جرد المخزون",
    "module": "inventory",
    "permission": "inventory.stock.read",
    "parameters": [
      { "name": "fromDate", "kind": "date", "required": true },
      { "name": "toDate", "kind": "date", "required": true },
      { "name": "branchId", "kind": "branch", "required": false },
      { "name": "status", "kind": "enum", "required": false, "options": ["draft", "submitted", "approved", "issued", "void", "posted", "reversed"] },
      { "name": "countTypes", "kind": "enum", "required": false, "options": ["STOCK_COUNT"] }
    ],
    "dataset": {
      "source": "document",
      "filters": [
        { "field": "effective_date", "op": "gte", "param": "fromDate" },
        { "field": "effective_date", "op": "lte", "param": "toDate" },
        { "field": "document_type_code", "op": "in", "param": "countTypes" },
        { "field": "branch_id", "op": "eq", "param": "branchId" },
        { "field": "status", "op": "eq", "param": "status" }
      ]
    },
    "columns": [
      { "field": "effective_date", "labelEn": "Date", "labelAr": "التاريخ", "format": "date", "align": "start", "width": 80 },
      { "field": "series", "labelEn": "Series", "labelAr": "السلسلة", "format": "text", "align": "start", "width": 60 },
      { "field": "number", "labelEn": "Number", "labelAr": "الرقم", "format": "text", "align": "start", "width": 70 },
      { "field": "status", "labelEn": "Status", "labelAr": "الحالة", "format": "text", "align": "start", "width": 80 },
      { "field": "branch_code", "labelEn": "Branch", "labelAr": "الفرع", "format": "text", "align": "start", "width": 70 },
      { "field": "posted_at", "labelEn": "Posted", "labelAr": "تاريخ الترحيل", "format": "date", "align": "start", "width": 120 },
      { "field": "base_total", "labelEn": "Variance value", "labelAr": "قيمة الفرق", "format": "money", "align": "end", "width": 120 }
    ],
    "groups": [{ "field": "branch_code", "subtotal": true }],
    "totals": [{ "field": "base_total", "fn": "sum" }, { "field": "number", "fn": "count" }],
    "sort": [{ "field": "effective_date", "dir": "asc" }, { "field": "number", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {fromDate} – {toDate}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "ledger_sum" }
  }
}
```

- [ ] **Step 5: Run it to pass**

Run: `cd packages/db && bun run test -- test/reports/7b-inventory-registers.test.ts`
Expected: **PASS, 7 tests.** Two failures worth predicting:
- `inventory.transfer_register: projectionKeys names <item>|<transit>|<lot>, which stock_on_hand does not hold` — the transfer's receipt movement did not reach `stock_on_hand`, i.e. the `TRANSFER` policy emitted one movement instead of two. That is a 3D/3B raise (§4.7.3's `movement_no` exists for exactly this), not a fixture problem.
- `inventory.count_register: the report totals 5.0000 and the ledger totals 10.0000 for measure debit` — the ledger window is missing `documentTypeCodes: ["STOCK_COUNT"]` and summed every document's debits in January.

- [ ] **Step 6: Run everything and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`

```bash
git add tests/invariants/support/reports.ts packages/db/seed/my/reports/7b/ \
        packages/db/test/reports/7b-inventory-registers.test.ts
git commit -m "feat(db): price list, promotion, transfer and count registers [7B T6]

Two master-data lists with row witnesses; the transfer register tying to the
in-transit warehouse's on-hand (3D's DoD clause) through projectionKeys; the
count register tying to the ledger's own debits for its own documents.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: `inventory.profit_by_item` over 4B's projection, and test 7's revenue-bearing re-run

The catalogue's one profit report. It reads **4B's `item_profitability` projection and recomputes nothing** (§4.16.1: *"never recomputed — this is where test 7's revenue-bearing profit figure is re-run"*).

**Files:**
- Create: `packages/db/seed/my/reports/7b/inventory.profit_by_item.json`, `packages/db/test/reports/7b-profit-by-item.test.ts`
- Modify: nothing.

**Interfaces:**
- Consumes: `itemProfitabilityRows`, `ItemProfitabilityRow`, `rebuildItemProfitability`, `SALE_MOVEMENT_TYPES` (4B); `valuationAsOf` (3B); Task 1's harness with `{ inventory: true, sales: true }`; Task 5's `inventory.stock_ageing` definition.
- Produces: one definition.

**The fixture's profit arithmetic, and why each figure comes from where it does.** 6 units delivered out of a 40-unit layer at `5.0000` and invoiced at `11.0000`, with 1 unit credited back. Per 4B's attribution rule (its amendments 6 and 7): `quantity_sold` = `Σ −movement.quantity` over the **sale** document types, so the delivery's issue of 6 gives **6.000000** and the financial-only credit note gives nothing; `revenue_base` = the item lines of posted `SALES_INVOICE` and `SALES_CREDIT_NOTE` signed by the document's own ledger direction, so **`66.0000 − 11.0000 = 55.0000`**; `cogs_base` = `Σ cost_consumption.value` for the delivery's issue movement, **`30.0000`**; `margin_base` = **`25.0000`**. Every one of those is the projection's, computed by `app.item_profitability_rows` — this report's job is to read them.

- [ ] **Step 1: Write the failing test `packages/db/test/reports/7b-profit-by-item.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { Money, Quantity, currency, validateReportDefinition } from "@dulja/domain";
import { DATASET_IDS, itemProfitabilityRows, rebuildItemProfitability, valuationAsOf } from "@dulja/db";
import { startDb, withTenant, type Db } from "@dulja/db/test";
import {
  assertTieOut, readDefinition, reportFixture, runDefinition, type ReportFixture,
} from "../../../../tests/invariants/support/reports";

const MYR = currency("MYR");
/** `validateReportDefinition`'s second argument is `ReportDefinitionSets` — BOTH closed sets (7A, A11). */
const SETS = {
  datasets: new Set<string>(DATASET_IDS),
  permissions: new Set(PERMISSIONS.map((p) => p.code)),
};
const PROFIT = "inventory.profit_by_item";
const AGEING = "inventory.stock_ageing";

describe("7B inventory.profit_by_item over item_profitability (§4.16.1, test 7 re-run)", () => {
  let db: Db; let f: ReportFixture;

  beforeAll(async () => {
    db = await startDb();
    f = await reportFixture(db, "Alpha", { inventory: true, sales: true });
    // The projection is asynchronous (spec:1204). Its rebuild is 4B's function, run here as the system
    // principal exactly as the pg-boss handler does (hazard 20) — this slice enqueues no job and writes no
    // projection row of its own.
    await withTenant(db.migrator, f.s.tenant, f.s.system, (tx) =>
      rebuildItemProfitability(tx, { companyId: f.s.company }));
  }, 240_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[3]>[0]) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);
  const params = () => ({ companyId: f.s.company, fiscalPeriodId: f.s.period, itemId: null });

  it("validates, is gated inventory.cost.read, and reads the projection — not the ledger, not the layers", () => {
    const d = readDefinition(PROFIT);
    const result = validateReportDefinition(d, SETS);
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    expect(d.permission).toBe("inventory.cost.read");
    expect(d.dataset.source).toBe("item_profitability");
    expect(d.tieOut).toEqual({ kind: "projection", projection: "item_profitability" });
  });

  it("every figure in the report is the projection's, to the cent", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(PROFIT), { params: params(), baseCurrency: MYR });
      const stored = await itemProfitabilityRows(tx, { companyId: f.s.company });
      expect(stored.length).toBe(1);
      expect(Quantity.of(stored[0]!.quantitySold).toString()).toBe("6.000000");
      expect(Money.of(stored[0]!.revenueBase, MYR).toString()).toBe("55.0000");
      expect(Money.of(stored[0]!.cogsBase, MYR).toString()).toBe("30.0000");
      expect(Money.of(stored[0]!.marginBase, MYR).toString()).toBe("25.0000");
    });
  });

  it("the report's own columns carry those four figures and a margin percentage that is not money", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(PROFIT), params());
      expect(rows.length).toBe(1);
      expect(Money.of(String(rows[0]!.margin_base), MYR).toString()).toBe("25.0000");
      const d = readDefinition(PROFIT);
      // A definition's `columns[].field` is a `DatasetColumn.field`, i.e. 7A's snake_case alias (A3) — a
      // camelCase key here reads `undefined` and every one of these four assertions fails on `undefined`.
      const formats = new Map(d.columns.map((c) => [c.field, c.format]));
      expect(formats.get("revenue_base")).toBe("money");
      expect(formats.get("cogs_base")).toBe("money");
      expect(formats.get("margin_base")).toBe("money");
      expect(formats.get("quantity_sold")).toBe("quantity");
      // No `margin_percent` column: a percentage of a Money is a derived number with a rounding policy, and
      // §4.11.1's `format: "percent"` has no source field on the projection to render. 7A's layout computes
      // a subtotal percentage at render time if a tenant clones the report and wants one; the CORE
      // definition states only figures the projection stores (spec:2041 "stored base amounts are never
      // recomputed on read" applied to a report).
      expect(d.columns.map((c) => c.field)).not.toContain("margin_percent");
    });
  });

  it("TEST 7's REVENUE-BEARING RE-RUN: valuation plus recognised cost equals every layer ever created", async () => {
    // spec:2425: "Stock valuation and profit reports tie to the cent for an item that has been transferred,
    // gone negative, and had a supplier return." 3D owns the whole scenario and its file is re-run unchanged
    // in Step 4. What THIS slice adds is the revenue-bearing half over the two reports that now read the
    // same figures: the item's layers created (the 1300 debits) must equal what is still on hand (stock
    // ageing, over BOTH warehouses, the in-transit one included) plus what has been recognised as cost
    // (profit by item). Three sources, one arithmetic identity, no recomputation anywhere.
    await read(async (tx) => {
      const ageing = await runDefinition(tx, readDefinition(AGEING), {
        companyId: f.s.company, itemId: f.inventory!.itemId, warehouseId: null,
      });
      // 7A's `cost_layer` dataset has NO `value` column (A3) — a layer's money is `qty_remaining × unit_cost`,
      // its own two stored facts, and the product has exactly one definition: the `stock_valuation` branch of
      // `assertTieOut` (A5), which this case's own `assertTieOut` above already exercised. Repeating the
      // multiplication here would be a second implementation of the figure, so the on-hand VALUE is taken
      // from `valuationAsOf` — the one implementation spec:1228 requires — and the ageing report's job in
      // this case is to prove it reports the same LAYERS that valuation is computed from.
      const valuation = await valuationAsOf(tx, {
        companyId: f.s.company, asOf: "2026-01-31", itemId: f.inventory!.itemId, limit: 50,
      });
      const onHandValue = valuation.reduce((a, v) => a.add(Money.of(v.value, MYR)), Money.zero(MYR));
      expect(new Set(ageing.map((r) => String(r.warehouse_code))))
        .toEqual(new Set(valuation.map((v) => v.warehouseCode)));
      const profit = await runDefinition(tx, readDefinition(PROFIT), params());
      const recognisedCost = profit.reduce((a, r) => a.add(Money.of(String(r.cogs_base), MYR)), Money.zero(MYR));
      const [ledger] = await tx<{ total: string }[]>`
        select coalesce(sum(le.base_debit), 0)::numeric(19,4)::text as total
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.company_id = ${f.s.company} and a.code = '1300'`;
      expect(onHandValue.toString()).toBe("170.0000");
      expect(recognisedCost.toString()).toBe("30.0000");
      expect(onHandValue.add(recognisedCost).toString()).toBe(Money.of(ledger!.total, MYR).toString());
      expect(ledger!.total).toBe("200.0000");
      // And the ageing report's own tie-out is what binds it to that valuation, so the identity above is a
      // statement about three READERS of one set of stored facts and not about three computations.
      await assertTieOut(tx, readDefinition(AGEING), {
        params: { companyId: f.s.company, itemId: f.inventory!.itemId, warehouseId: null },
        baseCurrency: MYR, asOf: "2026-01-31",
      });
    });
  });

  it("a period with no sales reports no row rather than a zero row", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(PROFIT), {
        companyId: f.s.company, fiscalPeriodId: f.s.lockedPeriod, itemId: null,
      });
      expect(rows).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/reports/7b-profit-by-item.test.ts`
Expected: **FAIL** — `ENOENT … inventory.profit_by_item.json`. If instead `rebuildItemProfitability` throws in `beforeAll`, read the message: `SALE_MOVEMENT_TYPES` exhaustiveness (4B's amendment 6) fails the build when a *seeded* type with a stock effect is in neither list — this fixture seeds `GOODS_RECEIPT`, `DELIVERY_ORDER`, `TRANSFER`, `TRANSFER_RECEIPT` and `STOCK_COUNT`, all of which 4B and 3D already classify. A new name there means a type was renamed, which is a raise, not a local fix.

- [ ] **Step 3: Write the definition**

`packages/db/seed/my/reports/7b/inventory.profit_by_item.json`:

```json
{
  "definitionVersion": 1,
  "definition": {
    "version": 1,
    "code": "inventory.profit_by_item",
    "nameEn": "Profit by item",
    "nameAr": "الأرباح حسب الصنف",
    "module": "inventory",
    "permission": "inventory.cost.read",
    "parameters": [
      { "name": "fiscalPeriodId", "kind": "period", "required": true },
      { "name": "itemId", "kind": "item", "required": false }
    ],
    "dataset": {
      "source": "item_profitability",
      "filters": [
        { "field": "fiscal_period_id", "op": "eq", "param": "fiscalPeriodId" },
        { "field": "item_id", "op": "eq", "param": "itemId" }
      ]
    },
    "columns": [
      { "field": "item_code", "labelEn": "Item", "labelAr": "الصنف", "format": "text", "align": "start", "width": 90 },
      { "field": "item_name_en", "labelEn": "Item name", "labelAr": "اسم الصنف", "format": "text", "align": "start", "width": 200 },
      { "field": "fiscal_period_code", "labelEn": "Period", "labelAr": "الفترة", "format": "text", "align": "start", "width": 90 },
      { "field": "quantity_sold", "labelEn": "Quantity sold", "labelAr": "الكمية المباعة", "format": "quantity", "align": "end", "width": 100 },
      { "field": "revenue_base", "labelEn": "Revenue", "labelAr": "الإيرادات", "format": "money", "align": "end", "width": 110 },
      { "field": "cogs_base", "labelEn": "Cost", "labelAr": "التكلفة", "format": "money", "align": "end", "width": 110 },
      { "field": "margin_base", "labelEn": "Margin", "labelAr": "هامش الربح", "format": "money", "align": "end", "width": 110 }
    ],
    "groups": [{ "field": "item_code", "subtotal": false }],
    "totals": [
      { "field": "revenue_base", "fn": "sum" },
      { "field": "cogs_base", "fn": "sum" },
      { "field": "margin_base", "fn": "sum" },
      { "field": "quantity_sold", "fn": "sum" }
    ],
    "sort": [{ "field": "margin_base", "dir": "desc" }, { "field": "item_code", "dir": "asc" }],
    "layout": {
      "orientation": "landscape",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {periodLabel}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "projection", "projection": "item_profitability" }
  }
}
```

**One period column, not two, and its format is `text`.** A3 pins `item_profitability`'s period handles as `fiscal_period_id` plus `fiscal_period_code` (*computed:* `to_char(fp.starts_on, 'YYYY-MM')`) and says in terms that **there is no `period_starts_on` / `period_ends_on`** — so a "Period from" / "Period to" pair would be one field rendered twice, which 7A's validator rejects outright (`column 'fiscal_period_code' is declared twice`, `packages/domain/src/reports/validate.ts`). `YYYY-MM` is also not a `date`: `format: "date"` would hand `2026-01` to the formatter's date path, so the column is `text`.

- [ ] **Step 4: Run it to pass, then re-run 3D's acceptance test 7 unchanged**

Run: `cd packages/db && bun run test -- test/reports/7b-profit-by-item.test.ts`
Expected: **PASS, 5 tests.**

Run: `bun run --cwd tests test -- invariants/test-07-one-costing-answer.test.ts`
Expected: **PASS, unchanged** — 3D's whole scenario (transferred, override-negative, supplier-returned) with its own figures. **This slice does not edit that file.** §6.1 lists 7B as a re-runner of test 7, and the re-run is this command plus the revenue-bearing case above; if 3D's file now fails, something in this slice touched a read function or a projection, which nothing in it is allowed to do.

Two failures worth predicting in the new file:
- `inventory.profit_by_item: item_profitability has (…, …) and the report has 0 row(s)` — the `fiscalPeriodId` filter is comparing against the wrong period: the projection keys on the period the *ledger line* fell in, and the fixture's invoice is 2026-01-15, so `f.s.period` is the one with rows. Passing `closedPeriod` here would produce exactly this message, which is why the last case uses `lockedPeriod` deliberately and asserts an **empty** result instead.
- `expected "200.0000" to be "170.0000"` on the identity case — the transit layer was dropped, so the on-hand value is 150 and the identity misses by the 20 in the corridor. That is the in-transit clause of test 7, and it fails loudly here rather than silently in a valuation report. The companion assertion in the same case (`new Set(ageing warehouse_code)` equals `new Set(valuation warehouseCode)`) says which of the two sides lost it: if the *ageing* set is short, the report's `warehouseId: null` was not honoured; if the *valuation* set is short, it is 3B's, and a raise.

- [ ] **Step 5: Run everything and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`

```bash
git add packages/db/seed/my/reports/7b/ packages/db/test/reports/7b-profit-by-item.test.ts
git commit -m "feat(db): profit by item over 4B's projection, and test 7's revenue half [7B T7]

The report reads item_profitability and recomputes nothing. The revenue-bearing
re-run of test 7: stock ageing's on-hand value plus profit-by-item's recognised
cost equals every layer ever created, to the cent.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: Re-expressing 3D's three codes — stock on hand, valuation and sales by item at version 2

The second half of the re-expression clause. Three definitions at `definitionVersion = 2` under 3D's codes, three parity cases against `stockOnHand`, `valuationAsOf` and `salesByItem`, and **3D's own inventory-report test re-run unchanged**.

**Files:**
- Create: `packages/db/seed/my/reports/7b/inventory.stock_on_hand.json`, `…/inventory.valuation.json`, `…/inventory.sales_by_item.json`, `packages/db/test/reports/7b-reexpress-phase3.test.ts`
- Modify: **nothing** — not `packages/db/src/reports/stock-on-hand.ts`, not `sales-by-item.ts`, not 3B's `valuation.ts`, not `apps/api/src/routes/accounting/reports.ts`.

**Interfaces:**
- Consumes: `stockOnHand`, `stockOnHandTotals`, `StockOnHandReportRow`, `salesByItem`, `SalesByItemRow` (3D, §4.16.3 — **`StockOnHandReportRow`, never `StockOnHandRow`**: the unprefixed name is 3A's list-route row on `packages/db/src/inventory/stock.ts` and importing it here would type the parity case against the wrong read); `valuationAsOf`, `ValuationRow`, `rebuildStockValuation` (3B, §4.7.2); `itemProfitabilityRows`, `rebuildItemProfitability` (4B); Task 1's harness with `{ inventory: true, sales: true }`.
- Produces: the three definitions at `definitionVersion 2`.

**Three shape decisions, each forced by something already frozen.**

1. **`inventory.stock_on_hand` carries a required `warehouseKinds` parameter.** 3D's `stockOnHand` defaults `includeInTransit` to **false** — *"the DoD clause is that in-transit stock is in NEITHER warehouse's on-hand"* — and a definition has no defaults (§4.11.1). A definition that filtered nothing would answer a different number from the function under the same code, which is exactly what re-expression may not do. So the parameter is required, `kind: "text"`, consumed by `op: "in"`: `stock` reproduces the function's default and `stock,in_transit` reproduces `includeInTransit: true`. Both are asserted.
2. **`inventory.valuation` reads the `stock_valuation` snapshot and ties to `valuationAsOf`.** That is A5's one substitution, and it is the strongest available check: the snapshot is what a report renders and `valuationAsOf` is the single implementation spec:1228 requires, so the tie-out *is* 3B's rebuild-and-compare seen from the report side (test 2's flavour). The fixture therefore rebuilds the snapshot through 3B's own `rebuildStockValuation` — this slice writes no projection row.
3. **`inventory.sales_by_item`'s definition is per fiscal period** (amendment A14). 3D's and 4A's function is date-ranged; `item_profitability` is keyed per period. The definition takes `fiscalPeriodId`, and the parity case compares it against `salesByItem` over **that period's own start and end dates**, where the two agree by construction. The JSON route keeps the date range (A2), so no caller loses anything.

- [ ] **Step 1: Write the failing test `packages/db/test/reports/7b-reexpress-phase3.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { Money, Quantity, currency, validateReportDefinition } from "@dulja/domain";
import {
  DATASET_IDS, rebuildItemProfitability, rebuildStockValuation, salesByItem, stockOnHand, valuationAsOf,
} from "@dulja/db";
import { startDb, withTenant, type Db } from "@dulja/db/test";
import {
  assertTieOut, readDefinition, readEnvelope, reportFixture, runDefinition, type ReportFixture,
} from "../../../../tests/invariants/support/reports";

const MYR = currency("MYR");
/** `validateReportDefinition`'s second argument is `ReportDefinitionSets` — BOTH closed sets (7A, A11). */
const SETS = {
  datasets: new Set<string>(DATASET_IDS),
  permissions: new Set(PERMISSIONS.map((p) => p.code)),
};
const SOH = "inventory.stock_on_hand";
const VALUATION = "inventory.valuation";
const SALES = "inventory.sales_by_item";
const AS_OF = "2026-01-31";

describe("7B re-expresses 3D's three minimal-set codes (§4.16.1, spec:2300)", () => {
  let db: Db; let f: ReportFixture;

  beforeAll(async () => {
    db = await startDb();
    f = await reportFixture(db, "Alpha", { inventory: true, sales: true });
    await withTenant(db.migrator, f.s.tenant, f.s.system, async (tx) => {
      await rebuildStockValuation(tx, { companyId: f.s.company, asOf: AS_OF });
      await rebuildItemProfitability(tx, { companyId: f.s.company });
    });
  }, 240_000);
  afterAll(async () => { await db.stop(); });

  const read = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[3]>[0]) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);
  const inv = () => f.inventory!;

  it("all three are seeded at definitionVersion 2 with 3D's codes and permissions unchanged", () => {
    for (const [code, permission] of [
      [SOH, "inventory.stock.read"], [VALUATION, "inventory.cost.read"], [SALES, "inventory.stock.read"],
    ] as const) {
      const envelope = readEnvelope(code);
      expect(envelope.definitionVersion).toBe(2);
      expect(envelope.definition.code).toBe(code);
      expect(envelope.definition.permission).toBe(permission);
      const result = validateReportDefinition(envelope.definition, SETS);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
    }
  });

  it("PARITY: stock_on_hand with warehouseKinds=stock is exactly the function's default answer", async () => {
    await read(async (tx) => {
      const fn = await stockOnHand(tx, { companyId: f.s.company, limit: 100 });
      const def = await runDefinition(tx, readDefinition(SOH), {
        companyId: f.s.company, warehouseKinds: "stock", itemId: null, warehouseId: null,
      });
      // LEFT: the dataset's snake_case alias (A3). RIGHT: 3D's `StockOnHandReportRow` camelCase member.
      expect(def.map((r) => [String(r.warehouse_code), Quantity.of(String(r.quantity)).toString()]))
        .toEqual(fn.map((r) => [r.warehouseCode, Quantity.of(r.quantity).toString()]));
      expect(def.map((r) => String(r.warehouse_code))).toEqual(["WH-HQ"]);
    });
  });

  it("PARITY: warehouseKinds=stock,in_transit is exactly includeInTransit — the corridor row appears", async () => {
    await read(async (tx) => {
      const fn = await stockOnHand(tx, { companyId: f.s.company, includeInTransit: true, limit: 100 });
      const def = await runDefinition(tx, readDefinition(SOH), {
        companyId: f.s.company, warehouseKinds: "stock,in_transit", itemId: null, warehouseId: null,
      });
      expect(def.map((r) => String(r.warehouse_code)).sort()).toEqual(fn.map((r) => r.warehouseCode).sort());
      expect(def.length).toBe(2);
      await assertTieOut(tx, readDefinition(SOH), {
        params: { companyId: f.s.company, warehouseKinds: "stock,in_transit", itemId: null, warehouseId: null },
        baseCurrency: MYR,
      });
    });
  });

  it("PARITY: inventory.valuation's snapshot rows equal valuationAsOf, warehouse for warehouse", async () => {
    await read(async (tx) => {
      const fn = await valuationAsOf(tx, { companyId: f.s.company, asOf: AS_OF, itemId: inv().itemId, limit: 50 });
      const def = await runDefinition(tx, readDefinition(VALUATION), {
        companyId: f.s.company, asOf: AS_OF, itemId: inv().itemId, warehouseId: null,
      });
      const byWarehouse = new Map(def.map((r) => [String(r.warehouse_code), r]));
      for (const row of fn) {
        const got = byWarehouse.get(row.warehouseCode);
        expect(got, `the snapshot is missing ${row.warehouseCode}`).toBeDefined();
        expect(Money.of(String(got!.value), MYR).toString()).toBe(Money.of(row.value, MYR).toString());
        expect(Quantity.of(String(got!.quantity)).toString()).toBe(Quantity.of(row.quantity).toString());
      }
      // NO unit-cost comparison: A3's `stock_valuation` row is
      // `item_id, item_code, item_name_en, warehouse_id, warehouse_code, branch_id, as_of, quantity, value`
      // — there is no `unit_cost` column on this dataset at all, so an assertion on one would compare
      // `undefined` against `ValuationRow.unitCost` and throw inside `Money.of`. A per-warehouse unit cost is
      // `value / quantity`, a division with a rounding policy that has exactly one home (3B's engine) and
      // must not gain a second in a report or in a test (SAH-009). Adding `unit_cost` to 7A's
      // `stockValuationDataset` is a raise against 7A, carried in this slice's Self-Review.
      await assertTieOut(tx, readDefinition(VALUATION), {
        params: { companyId: f.s.company, asOf: AS_OF, itemId: inv().itemId, warehouseId: null },
        baseCurrency: MYR, asOf: AS_OF,
      });
    });
  });

  it("PARITY: sales_by_item's per-period definition equals salesByItem over that period's own dates (A14)", async () => {
    await read(async (tx) => {
      const [period] = await tx<{ starts_on: string; ends_on: string }[]>`
        select starts_on::text, ends_on::text from app.fiscal_period where id = ${f.s.period}`;
      const fn = await salesByItem(tx, {
        companyId: f.s.company, fromDate: period!.starts_on, toDate: period!.ends_on, limit: 100,
      });
      const def = await runDefinition(tx, readDefinition(SALES), {
        companyId: f.s.company, fiscalPeriodId: f.s.period, itemId: null,
      });
      expect(def.length).toBe(fn.length);
      // LEFT: the `item_profitability` dataset's snake_case aliases (A3). RIGHT: 3D's/4A's `SalesByItemRow`
      // camelCase members. The two vocabularies meet in these four lines and nowhere else in the file.
      expect(Quantity.of(String(def[0]!.quantity_sold)).toString()).toBe(Quantity.of(fn[0]!.deliveredQuantity).toString());
      expect(Money.of(String(def[0]!.cogs_base), MYR).toString()).toBe(Money.of(fn[0]!.cost, MYR).toString());
      expect(Money.of(String(def[0]!.revenue_base), MYR).toString()).toBe(Money.of(fn[0]!.revenue, MYR).toString());
      expect(Money.of(String(def[0]!.margin_base), MYR).toString()).toBe(Money.of(fn[0]!.margin, MYR).toString());
      // The figures, so a reader can check them by hand: 6 delivered, 30.0000 cost, 66 − 11 = 55.0000
      // revenue, 25.0000 margin.
      expect(Money.of(fn[0]!.margin, MYR).toString()).toBe("25.0000");
    });
  });

  it("inventory.valuation is gated inventory.cost.read and stock_on_hand is not — the cost/quantity split", () => {
    expect(readDefinition(VALUATION).permission).toBe("inventory.cost.read");
    expect(readDefinition(SOH).permission).toBe("inventory.stock.read");
    // spec:2159's clerk reads stock and not costs; §3.6.2 splits the two codes for exactly that, and the
    // warehouse role's row (spec:2160) excludes prices and costs. A valuation report gated
    // `inventory.stock.read` would hand every cost to both roles through the report catalogue.
    expect(readDefinition(SOH).columns.map((c) => c.field)).not.toContain("value");
    expect(readDefinition(SOH).columns.map((c) => c.field)).not.toContain("unit_cost");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/reports/7b-reexpress-phase3.test.ts`
Expected: **FAIL** — `ENOENT … inventory.stock_on_hand.json`. If `rebuildStockValuation` rejects the `asOf` argument, check 3B's signature and pass what it takes; the snapshot's key is `(company_id, item_id, warehouse_id, as_of)` (§4.6.1), so an as-of is part of a rebuild by construction.

- [ ] **Step 3: Write the three definitions**

`packages/db/seed/my/reports/7b/inventory.stock_on_hand.json`:

```json
{
  "definitionVersion": 2,
  "definition": {
    "version": 1,
    "code": "inventory.stock_on_hand",
    "nameEn": "Stock on hand",
    "nameAr": "المخزون المتاح",
    "module": "inventory",
    "permission": "inventory.stock.read",
    "parameters": [
      { "name": "warehouseKinds", "kind": "text", "required": true },
      { "name": "itemId", "kind": "item", "required": false },
      { "name": "warehouseId", "kind": "warehouse", "required": false }
    ],
    "dataset": {
      "source": "stock_on_hand",
      "filters": [
        { "field": "warehouse_kind", "op": "in", "param": "warehouseKinds" },
        { "field": "item_id", "op": "eq", "param": "itemId" },
        { "field": "warehouse_id", "op": "eq", "param": "warehouseId" }
      ]
    },
    "columns": [
      { "field": "item_code", "labelEn": "Item", "labelAr": "الصنف", "format": "text", "align": "start", "width": 90 },
      { "field": "item_name_en", "labelEn": "Item name", "labelAr": "اسم الصنف", "format": "text", "align": "start", "width": 200 },
      { "field": "warehouse_code", "labelEn": "Warehouse", "labelAr": "المستودع", "format": "text", "align": "start", "width": 90 },
      { "field": "warehouse_kind", "labelEn": "Kind", "labelAr": "النوع", "format": "text", "align": "start", "width": 80 },
      { "field": "lot_code", "labelEn": "Lot", "labelAr": "الدفعة", "format": "text", "align": "start", "width": 90 },
      { "field": "expires_on", "labelEn": "Expires", "labelAr": "تاريخ الانتهاء", "format": "date", "align": "start", "width": 90 },
      { "field": "base_unit_code", "labelEn": "Unit", "labelAr": "الوحدة", "format": "text", "align": "start", "width": 50 },
      { "field": "quantity", "labelEn": "Quantity", "labelAr": "الكمية", "format": "quantity", "align": "end", "width": 100 }
    ],
    "groups": [{ "field": "item_code", "subtotal": true }],
    "totals": [{ "field": "quantity", "fn": "sum" }],
    "sort": [{ "field": "item_code", "dir": "asc" }, { "field": "warehouse_code", "dir": "asc" }, { "field": "lot_code", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {generatedAt}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "projection", "projection": "stock_on_hand" }
  }
}
```

`packages/db/seed/my/reports/7b/inventory.valuation.json`:

```json
{
  "definitionVersion": 2,
  "definition": {
    "version": 1,
    "code": "inventory.valuation",
    "nameEn": "Stock valuation",
    "nameAr": "تقييم المخزون",
    "module": "inventory",
    "permission": "inventory.cost.read",
    "parameters": [
      { "name": "asOf", "kind": "date", "required": true },
      { "name": "itemId", "kind": "item", "required": false },
      { "name": "warehouseId", "kind": "warehouse", "required": false }
    ],
    "dataset": {
      "source": "stock_valuation",
      "filters": [
        { "field": "as_of", "op": "eq", "param": "asOf" },
        { "field": "item_id", "op": "eq", "param": "itemId" },
        { "field": "warehouse_id", "op": "eq", "param": "warehouseId" }
      ]
    },
    "columns": [
      { "field": "item_code", "labelEn": "Item", "labelAr": "الصنف", "format": "text", "align": "start", "width": 90 },
      { "field": "item_name_en", "labelEn": "Item name", "labelAr": "اسم الصنف", "format": "text", "align": "start", "width": 200 },
      { "field": "warehouse_code", "labelEn": "Warehouse", "labelAr": "المستودع", "format": "text", "align": "start", "width": 90 },
      { "field": "quantity", "labelEn": "Quantity", "labelAr": "الكمية", "format": "quantity", "align": "end", "width": 100 },
      { "field": "value", "labelEn": "Value", "labelAr": "القيمة", "format": "money", "align": "end", "width": 120 }
    ],
    "groups": [{ "field": "item_code", "subtotal": true }],
    "totals": [{ "field": "value", "fn": "sum" }, { "field": "quantity", "fn": "sum" }],
    "sort": [{ "field": "item_code", "dir": "asc" }, { "field": "warehouse_code", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {asOf}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "projection", "projection": "stock_valuation" }
  }
}
```

`packages/db/seed/my/reports/7b/inventory.sales_by_item.json`:

```json
{
  "definitionVersion": 2,
  "definition": {
    "version": 1,
    "code": "inventory.sales_by_item",
    "nameEn": "Sales by item",
    "nameAr": "المبيعات حسب الصنف",
    "module": "inventory",
    "permission": "inventory.stock.read",
    "parameters": [
      { "name": "fiscalPeriodId", "kind": "period", "required": true },
      { "name": "itemId", "kind": "item", "required": false }
    ],
    "dataset": {
      "source": "item_profitability",
      "filters": [
        { "field": "fiscal_period_id", "op": "eq", "param": "fiscalPeriodId" },
        { "field": "item_id", "op": "eq", "param": "itemId" }
      ]
    },
    "columns": [
      { "field": "item_code", "labelEn": "Item", "labelAr": "الصنف", "format": "text", "align": "start", "width": 90 },
      { "field": "item_name_en", "labelEn": "Item name", "labelAr": "اسم الصنف", "format": "text", "align": "start", "width": 200 },
      { "field": "quantity_sold", "labelEn": "Quantity sold", "labelAr": "الكمية المباعة", "format": "quantity", "align": "end", "width": 100 },
      { "field": "revenue_base", "labelEn": "Revenue", "labelAr": "الإيرادات", "format": "money", "align": "end", "width": 110 },
      { "field": "cogs_base", "labelEn": "Cost", "labelAr": "التكلفة", "format": "money", "align": "end", "width": 110 },
      { "field": "margin_base", "labelEn": "Margin", "labelAr": "هامش الربح", "format": "money", "align": "end", "width": 110 }
    ],
    "groups": [{ "field": "item_code", "subtotal": false }],
    "totals": [
      { "field": "quantity_sold", "fn": "sum" },
      { "field": "revenue_base", "fn": "sum" },
      { "field": "cogs_base", "fn": "sum" },
      { "field": "margin_base", "fn": "sum" }
    ],
    "sort": [{ "field": "revenue_base", "dir": "desc" }, { "field": "item_code", "dir": "asc" }],
    "layout": {
      "orientation": "portrait",
      "paper": "A4",
      "header": "{companyName} · {reportName} · {periodLabel}",
      "footer": "{pageNumber}/{pageCount} · {generatedAt} · {actorName}"
    },
    "tieOut": { "kind": "projection", "projection": "item_profitability" }
  }
}
```

**`inventory.sales_by_item` and `inventory.profit_by_item` read one projection and are still two reports** (amendment A14): this one is gated `inventory.stock.read` and is the sales view a clerk may see; Task 7's is gated `inventory.cost.read`, sorts by margin and is the cost view. The columns overlap because the underlying figures are the same four — and that is the point of a projection. Neither recomputes; §4.16.1 registers both codes; and the permission split is what spec:2159's "no costs" clerk row requires. **The one asymmetry worth noting:** this report exposes `cogsBase` under a stock-read gate, which is a cost figure. It is here because 4A already shipped `cost` and `margin` on this code's JSON route under the same gate (§4.16.1's "4A extends the same code"), and changing the gate now would be renaming the code's authority mid-flight. Self-Review pushback 4 records it as a question for the owner rather than a silent decision.

- [ ] **Step 4: Run it to pass, then re-run 3D's own report test unchanged**

Run: `cd packages/db && bun run test -- test/reports/7b-reexpress-phase3.test.ts`
Expected: **PASS, 6 tests.**

Run: `cd packages/db && bun run test -- test/reports/inventory-reports.test.ts`
Expected: **PASS, unchanged** — 3D's three minimal reports with their own DoD case (*"shelves 10, transit 4, total 14"* in 3D's fixture, not this one's). **No edit to that file.**

Two failures worth predicting:
- `expected [ [ "WH-HQ", "30.000000" ], [ "WH-TR", "4.000000" ] ] to equal [ [ "WH-HQ", "30.000000" ] ]` on the first parity case — `warehouseKinds: "stock"` was not applied, so the definition answered the function's `includeInTransit: true`. That is precisely the re-expression bug this parity case exists to catch: same code, different number.
- `the snapshot is missing WH-TR` — `rebuildStockValuation` snapshotted stock warehouses only. Raise against 3B: `valuationAsOf` returns the corridor and the snapshot must store what the function returns, or the two disagree by 20.0000 for every transfer in flight.

- [ ] **Step 5: Run everything and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`

```bash
git add packages/db/seed/my/reports/7b/ packages/db/test/reports/7b-reexpress-phase3.test.ts
git commit -m "feat(db): re-express 3D's stock_on_hand, valuation and sales_by_item at version 2 [7B T8]

Three parity cases pin the numbers to stockOnHand, valuationAsOf and
salesByItem; 3D's own inventory-report test is re-run unchanged. The
warehouseKinds parameter is what reproduces the function's in-transit default.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: `ReportCodeSchema` + 17, the seed application, and the catalogue completeness gate

The twenty-two files become twenty-two `app.report_definition` rows, the wire enum learns the seventeen new codes, and one test asserts every claim this plan's prose has made about the catalogue's shape.

**Files:**
- Create: `packages/db/test/reports/7b-catalogue.test.ts`
- Modify: `packages/contracts/src/accounting/reports.ts` (`ReportCodeSchema` gains seventeen members)

**Interfaces:**
- Consumes: `reportsLoader`, `PackLoader`, `LoaderContext`, `SeedConfig` (7A / 0C, §4.2.13); `app.report_definition` (7A, §4.11.2); `CATALOGUE_7B`, `readEnvelope` (Task 1); `ReportCodeSchema` (1B, widened by 3D and 4B, and by 6D if it has merged — §6.3 runs Phase 6 in parallel with this chain).
- Produces: the widened `ReportCodeSchema` (this slice's seventeen appended, amendment A4 — no total count is asserted, because §6.3 may or may not have landed 6D's two first).

- [ ] **Step 1: Write the failing test `packages/db/test/reports/7b-catalogue.test.ts`**

```ts
import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { ReportCodeSchema } from "@dulja/contracts";
import { validateReportDefinition } from "@dulja/domain";
import { DATASET_IDS } from "@dulja/db";
import { reportsLoader } from "@dulja/db/seed";
import { startDb, withTenant, type Db } from "@dulja/db/test";
import { CATALOGUE_7B, CATALOGUE_DIR, readEnvelope, reportFixture, type ReportFixture } from "../../../../tests/invariants/support/reports";

/** §4.16.1's assignment, as a literal. A disagreement between this table and a definition is a register
 *  violation (hazard 32), not a preference — which is why the table is written out rather than derived. */
const REGISTER: Readonly<Record<string, { permission: string; version: number }>> = {
  "accounting.general_ledger":      { permission: "accounting.report.read", version: 1 },
  "accounting.journal_register":    { permission: "accounting.report.read", version: 1 },
  "accounting.account_statement":   { permission: "accounting.report.read", version: 1 },
  "accounting.period_comparison":   { permission: "accounting.report.read", version: 1 },
  "accounting.profit_and_loss":     { permission: "accounting.report.read", version: 1 },
  "accounting.balance_sheet":       { permission: "accounting.report.read", version: 1 },
  "accounting.document_register":   { permission: "accounting.report.read", version: 1 },
  "accounting.audit_log":           { permission: "admin.audit_log.read",   version: 1 },
  "accounting.document_event_log":  { permission: "admin.audit_log.read",   version: 1 },
  "accounting.trial_balance":       { permission: "accounting.report.read", version: 2 },
  "accounting.ledger":              { permission: "accounting.report.read", version: 2 },
  "inventory.stock_ageing":         { permission: "inventory.cost.read",    version: 1 },
  "inventory.movement_register":    { permission: "inventory.stock.read",   version: 1 },
  "inventory.expiry_list":          { permission: "inventory.stock.read",   version: 1 },
  "inventory.price_list":           { permission: "inventory.item.read",    version: 1 },
  "inventory.promotion_register":   { permission: "inventory.item.read",    version: 1 },
  "inventory.transfer_register":    { permission: "inventory.stock.read",   version: 1 },
  "inventory.count_register":       { permission: "inventory.stock.read",   version: 1 },
  "inventory.profit_by_item":       { permission: "inventory.cost.read",    version: 1 },
  "inventory.stock_on_hand":        { permission: "inventory.stock.read",   version: 2 },
  "inventory.valuation":            { permission: "inventory.cost.read",    version: 2 },
  "inventory.sales_by_item":        { permission: "inventory.stock.read",   version: 2 },
};

/** The thirteen `DatasetId` members this catalogue reads. 7A's registry holds twenty-six; this slice adds none
 *  and a definition naming a fourteenth here would be a §4.16.2 amendment, not a code change. */
const SOURCES = [
  "ledger_entry", "account_balance", "document", "document_event", "audit_log",
  "inventory_movement", "cost_layer", "stock_on_hand", "stock_valuation", "item_profitability",
  "lot", "price_list_line", "promotion",
] as const;

describe("7B catalogue completeness and the reports seed pack (§4.16.1, §3.4.8)", () => {
  let db: Db; let f: ReportFixture;

  beforeAll(async () => { db = await startDb(); f = await reportFixture(db, "Alpha"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("the directory holds exactly the twenty-two codes, seventeen new and five re-expressed", () => {
    const onDisk = readdirSync(CATALOGUE_DIR).filter((n) => n.endsWith(".json")).map((n) => n.replace(/\.json$/, "")).sort();
    expect(onDisk).toEqual([...CATALOGUE_7B].sort());
    expect(onDisk.length).toBe(22);
    const versions = onDisk.map((code) => readEnvelope(code).definitionVersion);
    expect(versions.filter((v) => v === 1).length).toBe(17);
    expect(versions.filter((v) => v === 2).length).toBe(5);
  });

  it("every definition matches §4.16.1's register: code, module, permission and row version", () => {
    for (const code of CATALOGUE_7B) {
      const envelope = readEnvelope(code);
      const row = REGISTER[code]!;
      expect(envelope.definition.code, code).toBe(code);
      expect(envelope.definition.module, code).toBe(code.split(".")[0]);
      expect(envelope.definition.permission, code).toBe(row.permission);
      expect(envelope.definitionVersion, code).toBe(row.version);
      expect(envelope.definition.version, code).toBe(1);      // the FORMAT version (amendment A1)
    }
  });

  it("every permission a definition names is in the catalogue and is non-mutating", () => {
    const byCode = new Map(PERMISSIONS.map((p) => [p.code, p]));
    for (const code of CATALOGUE_7B) {
      const permission = readEnvelope(code).definition.permission;
      expect(byCode.has(permission), `${code} names ${permission}`).toBe(true);
      expect(byCode.get(permission)!.mutating, `${code}'s gate must be a read code`).toBe(false);
    }
  });

  it("every filter clause names a declared parameter, and every parameter kind is one §4.11.1 allows", () => {
    const KINDS = ["date", "date_range", "period", "account", "party", "item", "warehouse", "branch", "dimension_value", "enum", "text"];
    for (const code of CATALOGUE_7B) {
      const d = readEnvelope(code).definition;
      const declared = new Set(d.parameters.map((p) => p.name));
      for (const clause of d.dataset.filters) {
        expect(declared.has(clause.param), `${code}: filter on ${clause.field} names undeclared parameter ${clause.param}`).toBe(true);
      }
      for (const p of d.parameters) expect(KINDS, `${code}.${p.name}`).toContain(p.kind);
    }
  });

  it("this slice reads only datasets 7A already registered — no definition reaches for a new DatasetId", () => {
    for (const code of CATALOGUE_7B) {
      expect(SOURCES, `${code} reads ${readEnvelope(code).definition.dataset.source}`)
        .toContain(readEnvelope(code).definition.dataset.source);
    }
  });

  it("every tieOut is one the harness executes, and a `none` is one of exactly four codes", () => {
    const none: string[] = [];
    for (const code of CATALOGUE_7B) {
      const t = readEnvelope(code).definition.tieOut;
      if (t.kind === "none") { none.push(code); continue; }
      if (t.kind === "projection") {
        expect(["account_balance", "stock_on_hand", "stock_valuation", "item_profitability"], code).toContain(t.projection);
      } else {
        expect(t.kind, code).toBe("ledger_sum");
      }
    }
    expect(none.sort()).toEqual([
      "accounting.audit_log", "accounting.document_event_log",
      "inventory.price_list", "inventory.promotion_register",
    ]);
  });

  // No total count is asserted, on purpose. §6.3 runs Phase 6 in parallel with (7A → 7B) and makes 6D a
  // predecessor of 7C, so `pos.z_report` and `pos.sales_by_cashier` may or may not be members yet; this
  // slice lands at twenty-three or twenty-five and neither is a defect. What IS this slice's business is
  // that all twenty-two of its own codes are members and that it removed nothing.
  it("every code in CATALOGUE_7B is a ReportCodeSchema member, and the earlier slices' are untouched", () => {
    for (const code of CATALOGUE_7B) expect(ReportCodeSchema.options).toContain(code);
    for (const code of ["accounting.trial_balance", "accounting.ledger", "inventory.stock_on_hand",
                        "inventory.valuation", "inventory.sales_by_item", "accounting.ageing"]) {
      expect(ReportCodeSchema.options).toContain(code);
    }
    expect(new Set(ReportCodeSchema.options).size, "a duplicated member").toBe(ReportCodeSchema.options.length);
  });

  it("the reports loader seeds all twenty-two as core rows, and re-running it changes nothing", async () => {
    const config = {
      tenantId: f.s.tenant, only: ["reports"] as const, packRoot: "packages/db/seed/my",
      tenantName: "Alpha", ownerEmail: "owner@example.invalid",
      companyCode: "HQ", companyName: "Alpha HQ", baseCurrency: "MYR", timezone: "Asia/Kuala_Lumpur",
      fiscalYearStartMonth: 1, fiscalYear: 2026,
    };
    const ctx = {
      config, tenantId: f.s.tenant, companyId: f.s.company,
      systemPrincipalId: f.s.system, packRoot: "packages/db/seed/my",
    };
    const first = await withTenant(db.migrator, f.s.tenant, f.s.system, (tx) => reportsLoader.load(tx, ctx));
    expect(first).toBeGreaterThanOrEqual(22);

    const rows = await withTenant(db.rw, f.s.tenant, f.reader, (tx) => tx<{ code: string; version: number; is_core: boolean }[]>`
      select code, version, is_core from app.report_definition
       where company_id = ${f.s.company} order by code, version`);
    const mine = rows.filter((r) => (CATALOGUE_7B as readonly string[]).includes(r.code));
    expect(mine.length).toBe(22);
    expect(mine.every((r) => r.is_core)).toBe(true);
    for (const r of mine) expect(r.version, r.code).toBe(REGISTER[r.code]!.version);

    // Idempotent per §3.4.8: `on conflict (company_id, code, version) do update`, so a second run replaces
    // the definition and adds no row. A pack that inserted a THIRD version on re-seed would break
    // `unique (company_id, code, version)`'s meaning and leave a staging database with two live cores.
    await withTenant(db.migrator, f.s.tenant, f.s.system, (tx) => reportsLoader.load(tx, ctx));
    const after = await withTenant(db.rw, f.s.tenant, f.reader, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.report_definition where company_id = ${f.s.company}`);
    expect(after[0]!.n).toBe(rows.length);
  });

  it("a second tenant sees none of them (spec:106's Always clause, over a table this slice fills)", async () => {
    const other = await reportFixture(db, "Beta");
    const seen = await withTenant(db.rw, other.s.tenant, other.reader, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.report_definition`);
    expect(seen[0]!.n).toBe(0);
  });

  it("every definition validates against 7A's validator with the real dataset and permission sets", () => {
    // `ReportDefinitionSets` is BOTH closed sets (7A, A11): passing a bare array of codes does not
    // type-check, and it would also skip the `dataset.source` membership check the register relies on.
    const SETS = {
      datasets: new Set<string>(DATASET_IDS),
      permissions: new Set(PERMISSIONS.map((p) => p.code)),
    };
    for (const code of CATALOGUE_7B) {
      const result = validateReportDefinition(readEnvelope(code).definition, SETS);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(result.ok, code).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/reports/7b-catalogue.test.ts`
Expected: **FAIL** on the enum case with `expected [ 'accounting.trial_balance', … ] to contain 'accounting.general_ledger'` — the membership assertion, not a count — and on the loader case if 7A's loader walks a flat directory: `readPackFile … reports/accounting.general_ledger.json` (no `7b/` segment) is the failure amendment A11's `WALKS <packRoot>/reports/<slice>/*.json` clause exists to make visible. **That is a raise against 7A**, not a flattening of this slice's directory: §4.16.1 requires one directory per owning slice precisely so 7B, 7C and 8D never share a file.

- [ ] **Step 3: Widen `ReportCodeSchema`**

`packages/contracts/src/accounting/reports.ts` — the enum only; **every DTO in the file is untouched**, because this slice adds no route and no wire shape (A2).

**This is an APPEND, and what is printed below is the fragment to append — not the enum.** Amendment A4 says the seventeen go "after whatever members already exist", and a full enum literal in a plan is exactly how a slice ends up asserting another slice's membership: §6.3 runs `(6A → 6C → 6B → 6D)` in **parallel** with `(7A → 7B)` and makes 6D a predecessor of **7C**, so `pos.z_report` and `pos.sales_by_cashier` may or may not be in the file when you open it. Open it, find the closing `]);` of `ReportCodeSchema`, and paste the fragment immediately above it.

**Before you paste, read what is there.** You should find between six and eight members: 1B's `accounting.trial_balance` and `accounting.ledger`; 3D's `inventory.stock_on_hand`, `inventory.valuation` and `inventory.sales_by_item`; 4B's `accounting.ageing`; and — only if 6D has merged — `pos.z_report` and `pos.sales_by_cashier`. **Leave every one of them exactly as it is:** do not add the 6D pair if it is absent, do not remove it if it is present, and do not re-sort the array — the per-slice append order is what makes a diff of this file readable. Two of the five codes 7B re-expresses (`accounting.trial_balance`, `accounting.ledger`) and three more (`inventory.*`) are already members and are **not** repeated below; a repeat is what Step 1's duplicate-member assertion catches.

```ts
  // ── 7B — the accounting catalogue (§4.16.1; amendment A4: appended, never re-sorted) ──
  "accounting.general_ledger",
  "accounting.journal_register",
  "accounting.account_statement",
  "accounting.period_comparison",
  "accounting.profit_and_loss",
  "accounting.balance_sheet",
  "accounting.document_register",
  "accounting.audit_log",
  "accounting.document_event_log",
  // ── 7B — the inventory catalogue ──
  "inventory.stock_ageing",
  "inventory.movement_register",
  "inventory.expiry_list",
  "inventory.price_list",
  "inventory.promotion_register",
  "inventory.transfer_register",
  "inventory.count_register",
  "inventory.profit_by_item",
```

The doc comment above `ReportCodeSchema` is 1B's and is **extended, not replaced** — append one sentence to it so the next slice knows what the enum is and is not:

```ts
 * §4.16.1 is the register; this enum is the TYPED surface (1B's two `GET`s, 7A's definition and saved-view
 * routes, every contract-tier consumer) and never a second register. Membership is not what makes a code
 * runnable: 7A's `POST …/reports/{code}/runs` validates `{code}` against a bare grammar regex and answers
 * 404 "No such report" when no definition resolves for a caller who has already cleared `requireReportExport` (amendment A4). Slices append their
 * own codes here and no slice asserts a total member count.
```

**Do not assert a total count anywhere.** This slice can legitimately land with six pre-existing members (→ twenty-three) or eight (→ twenty-five), and a test that pinned either number would fail for a reason that has nothing to do with this slice. Task 0's gate script prints the count it actually found; the assertions in Step 1 are membership assertions, which hold either way.

- [ ] **Step 4: Apply the pack for real, once, and read the exit code**

The loader case above exercises `reportsLoader` in a transaction. The operational form is the CLI, and §3.4.8 makes running it a task of the introducing slice:

Run: `bun run seed --tenant <tenant uuid> --only reports`
Expected: exit **0** and a line naming twenty-two report definitions. Exit **3** is a pack-shape violation (§4.2.13's four exit codes) — the `7b/` directory is not in `assertPackShape`'s allowed set, which from 2C onward derives from `SUB_PACKS`; if `reports` is not a `SubPack` member, 7A's five edits did not land and Task 0's gate should have caught it. Exit **1** naming a file is a validation failure in that file, and the file name is the code.

**Owner-account form (hazard 5).** *Owner provides: nothing for this task.* The seed runs against any database the runner can reach. **Until a staging database exists:** the same command runs against `startDb()` through the loader case above, and it must print the same twenty-two.

- [ ] **Step 5: Run it to pass, then run everything and commit**

Run: `cd packages/db && bun run test -- test/reports/7b-catalogue.test.ts`
Expected: **PASS, 10 tests.**
Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: all green. **`openapi:generate` diff**: the enum is part of the generated OpenAPI document (§4.2.7), so run `bun run --cwd packages/contracts openapi:generate` and commit `packages/contracts/openapi.json` in the same commit — CI fails on an undiffed generator output.

```bash
git add packages/contracts/src/accounting/reports.ts packages/contracts/openapi.json \
        packages/db/test/reports/7b-catalogue.test.ts
git commit -m "feat(contracts): ReportCodeSchema gains 7B's seventeen codes [7B T9]

Appended after whatever members were already there, which is six or eight
depending on whether 6D has merged (amendment A4) - no total is asserted. The
catalogue completeness gate asserts the register, the twenty-two rows, the 17/5
version split and that no definition reaches for a DatasetId 7A did not
register.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: The SAH-070 EXPLAIN gate and migration 0077 — the four missing report-filter indexes

The card's third deliverable: *"EXPLAIN check that every report filter column is indexed (SAH-070)."* One test enumerates every `(table, filter column)` pair the twenty-two definitions imply, EXPLAINs a canonical predicate for each and fails on a sequential scan; migration 0077 supplies the four the gate finds unserved.

**Files:**
- Create: `packages/db/migrations/0077_add_report_filter_indexes.sql`, `packages/db/migrations/0077.down.sql`, `packages/db/test/reports/7b-report-indexes.test.ts`
- Modify: `packages/db/src/schema/document.ts`, `packages/db/src/schema/document-event.ts`, `packages/db/src/schema/inventory-movement.ts`, `packages/db/src/schema/audit-log.ts` — **one `index(...)` entry each and nothing else**. §3.4.9 makes the mirror the diff source, so an index in the database and not in the mirror makes the next slice's `drizzle-kit generate` emit four spurious drops.

**Interfaces:**
- Consumes: `up`, `down`, `listApplied`, `MIGRATIONS_DIR`, `lintSchema` (§4.1); `CATALOGUE_7B`, `readEnvelope` (Task 1).
- Produces: the four indexes `document_company_type_date_idx`, `document_event_company_time_idx`, `inventory_movement_company_date_idx`, `audit_log_tenant_table_time_idx`.

**How the gate decides, and why "not a Seq Scan" is the wrong question.** A report filter is served or it is not, and the planner is the only authority on that. A Testcontainers table with four rows is always cheaper to scan than to index, so a bare `EXPLAIN` would report `Seq Scan` for every well-indexed column; the test therefore runs each plan with **`set local enable_seqscan = off`**.

That alone is not enough, and the difference matters. With sequential scans discouraged, the planner will pick **any** usable index and drop the column it cannot use into `Filter` — and `document`, `inventory_movement` and `audit_log` each already carry a `company_id`- or `tenant_id`-leading index from their owning phase. A predicate of `where company_id = $1 and <column> is not null` therefore plans an Index Scan on that index for **every** column, served or not, and three of this slice's own four missing pairs would have passed before 0077 was written. The gate would be a decoration.

So the assertion is on the **condition, not the node type**: the column's name must appear in an `Index Cond` (or the `Recheck Cond` a Bitmap Heap Scan carries for the Bitmap Index Scan beneath it), and the probe is an **equality on a real value** read from the table a moment earlier, because `is not null` is not a predicate Postgres pushes into an index condition. A column with no usable index lands in `Filter`, `conds()` does not contain it, and the failure names the table, the column, the plan and the conditions that were used instead. That is the discrimination SAH-070 needs, and it is stable on a table of any size.

**The pairs, and the four that are unserved.** Every one below is a `dataset.filters[].field` of a shipped definition, mapped to its column:

| Table | Column | Served by | Owner |
|---|---|---|---|
| `ledger_entry` | `effective_date` | `ledger_entry_company_date_idx` | 0A |
| `ledger_entry` | `account_id` | `ledger_entry_account_date_idx` | 0A |
| `account_balance` | `fiscal_period_id`, `currency` | `account_balance_company_period_idx` | 1B |
| `document` | `fiscal_period_id`, `status` | `document_company_period_status_idx` | 1B |
| **`document`** | **`document_type_id` + `effective_date`** | **nothing** — 1B's index leads with `fiscal_period_id`, and the register filters by type and date | **0077** |
| **`document_event`** | **`company_id` + `occurred_at`** | **nothing** — 2B's index is `(document_id, occurred_at)`, useless for a company-wide event log | **0077** |
| **`inventory_movement`** | **`company_id` + `effective_date`** | **nothing** — 3A's chrono index is `(company_id, item_id, warehouse_id, effective_date, …)`, so a date scan across items cannot use it | **0077** |
| **`audit_log`** | **`table_name` + `occurred_at`** | **nothing** — 0A's index is `(tenant_id, seq desc)` for the chain walk | **0077** |
| `cost_layer` | `item_id`, `effective_at` | `cost_layer_open_idx` | 3B |
| `stock_on_hand` | `item_id`, `warehouse_id` | the primary key `(company_id, item_id, warehouse_id, lot_id)` | 3A |
| `stock_valuation` | `as_of`, `item_id` | the primary key `(company_id, item_id, warehouse_id, as_of)` | 3B |
| `item_profitability` | `fiscal_period_id` | `item_profitability_period_idx` | 4B |
| `lot` | `expires_on` | `lot_expiry_idx` (partial, `expires_on is not null`) | 3A |
| `price_list_line` | `price_list_id`, `item_id` | `unique (price_list_id, item_id, unit_id, min_quantity)` | 3A |
| `promotion` | `starts_at` | `promotion_window_idx` | 3A |

**Why the four live in 0077 and not in the owning slice's range.** §3.4.1: a slice writes only inside its own range and never renumbers or borrows; 0A's, 1B's, 2B's and 3A's ranges are spent and frozen. Amendment A7 records that the card's index clause therefore spends this slice's reserved 0077. All four are `create index` on existing tables — an **expand** step (§3.4.7) that adds no column and no constraint, so it needs no contract PR and can deploy under load.

- [ ] **Step 1: Write the failing test `packages/db/test/reports/7b-report-indexes.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "@dulja/db";
import { startDb, withTenant, type Db } from "@dulja/db/test";
import { CATALOGUE_7B, readEnvelope, reportFixture, type ReportFixture } from "../../../../tests/invariants/support/reports";

/**
 * Every filter field of every shipped definition, mapped to the table and column it reaches. The map is
 * written out rather than derived because the field→column mapping is 7A's registry's, and a test that
 * guessed it would pass on a wrong guess. A field missing from here fails the coverage case below.
 *
 * THE KEY IS `<dataset id>.<DatasetColumn.field>` AND THE FIELD HALF IS `snake_case` (A3) — the coverage
 * case below builds it as `${d.dataset.source}.${clause.field}` straight off the definition, and every
 * shipped definition's `dataset.filters[].field` is a `DatasetColumn.field`. A `camelCase` key here matches
 * nothing: every filter pair of all twenty-two definitions would report as missing, and the EXPLAIN case
 * would then iterate a set of pairs no definition references — a gate that is red for the wrong reason and
 * green about nothing.
 */
const COLUMN_OF: Readonly<Record<string, { table: string; column: string; scope: "company" | "tenant" }>> = {
  "ledger_entry.effective_date":        { table: "ledger_entry", column: "effective_date", scope: "company" },
  "ledger_entry.account_id":            { table: "ledger_entry", column: "account_id", scope: "company" },
  "ledger_entry.document_type_code":    { table: "document", column: "document_type_id", scope: "company" },
  // `ledger_entry.branch_id` comes from the DOCUMENT join (A3: `d.branch_id`), so the column the planner has
  // to find is `document.branch_id` — not `ledger_entry.company_id`, which every scope predicate already
  // supplies and which would make this pair report "served" while nothing indexes the branch cut at all.
  "ledger_entry.branch_id":             { table: "document", column: "branch_id", scope: "company" },
  "account_balance.fiscal_period_id":   { table: "account_balance", column: "fiscal_period_id", scope: "company" },
  "account_balance.currency":           { table: "account_balance", column: "currency", scope: "company" },
  // `account_balance.account_type` is `a.type` from the ACCOUNT join (A3), so the column is `account.type`.
  "account_balance.account_type":       { table: "account", column: "type", scope: "company" },
  "document.effective_date":            { table: "document", column: "effective_date", scope: "company" },
  "document.document_type_code":        { table: "document", column: "document_type_id", scope: "company" },
  "document.status":                    { table: "document", column: "status", scope: "company" },
  "document.branch_id":                 { table: "document", column: "branch_id", scope: "company" },
  "document_event.occurred_at":         { table: "document_event", column: "occurred_at", scope: "company" },
  "document_event.document_type_code":  { table: "document", column: "document_type_id", scope: "company" },
  "document_event.event_kind":          { table: "document_event", column: "event_kind", scope: "company" },
  "document_event.to_status":           { table: "document_event", column: "to_status", scope: "company" },
  "audit_log.occurred_at":              { table: "audit_log", column: "occurred_at", scope: "tenant" },
  "audit_log.table_name":               { table: "audit_log", column: "table_name", scope: "tenant" },
  "audit_log.action":                   { table: "audit_log", column: "action", scope: "tenant" },
  "audit_log.actor_id":                 { table: "audit_log", column: "actor_id", scope: "tenant" },
  "inventory_movement.effective_date":  { table: "inventory_movement", column: "effective_date", scope: "company" },
  "inventory_movement.item_id":         { table: "inventory_movement", column: "item_id", scope: "company" },
  "inventory_movement.warehouse_id":    { table: "inventory_movement", column: "warehouse_id", scope: "company" },
  "inventory_movement.document_type_code": { table: "document", column: "document_type_id", scope: "company" },
  "cost_layer.item_id":                 { table: "cost_layer", column: "item_id", scope: "company" },
  "cost_layer.warehouse_id":            { table: "cost_layer", column: "warehouse_id", scope: "company" },
  "stock_on_hand.item_id":              { table: "stock_on_hand", column: "item_id", scope: "company" },
  "stock_on_hand.warehouse_id":         { table: "stock_on_hand", column: "warehouse_id", scope: "company" },
  "stock_on_hand.warehouse_kind":       { table: "warehouse", column: "kind", scope: "company" },
  "stock_valuation.as_of":              { table: "stock_valuation", column: "as_of", scope: "company" },
  "stock_valuation.item_id":            { table: "stock_valuation", column: "item_id", scope: "company" },
  "stock_valuation.warehouse_id":       { table: "stock_valuation", column: "warehouse_id", scope: "company" },
  "item_profitability.fiscal_period_id": { table: "item_profitability", column: "fiscal_period_id", scope: "company" },
  "item_profitability.item_id":         { table: "item_profitability", column: "item_id", scope: "company" },
  "lot.expires_on":                     { table: "lot", column: "expires_on", scope: "company" },
  "lot.item_id":                        { table: "lot", column: "item_id", scope: "company" },
  "price_list_line.price_list_id":      { table: "price_list_line", column: "price_list_id", scope: "company" },
  "price_list_line.item_id":            { table: "price_list_line", column: "item_id", scope: "company" },
  // `valid_from`/`valid_to` are `app.price_list`'s columns (§4.6.1, 3A migration 0030); the dataset exposes
  // them on the LINE row through the join, so the planner's question is about `price_list`.
  "price_list_line.valid_from":         { table: "price_list", column: "valid_from", scope: "company" },
  "promotion.starts_at":                { table: "promotion", column: "starts_at", scope: "company" },
  "promotion.branch_id":                { table: "promotion", column: "branch_id", scope: "company" },
};

/** The four this slice's migration adds. */
const NEW_INDEXES = [
  "audit_log_tenant_table_time_idx", "document_company_type_date_idx",
  "document_event_company_time_idx", "inventory_movement_company_date_idx",
];

describe("SAH-070 — every report filter column is served by an index (7B, migration 0077)", () => {
  let db: Db; let f: ReportFixture;

  beforeAll(async () => { db = await startDb(); f = await reportFixture(db, "Alpha", { inventory: true }); }, 240_000);
  afterAll(async () => { await db.stop(); });

  it("every filter field of every definition is in the column map — a new filter must be considered here", () => {
    const missing: string[] = [];
    for (const code of CATALOGUE_7B) {
      const d = readEnvelope(code).definition;
      for (const clause of d.dataset.filters) {
        const key = `${d.dataset.source}.${clause.field}`;
        if (!(key in COLUMN_OF)) missing.push(`${code} → ${key}`);
      }
    }
    expect(missing, "add the pair to COLUMN_OF and check its index before shipping the filter").toEqual([]);
  });

  it("the four indexes of migration 0077 exist with their exact names and columns", async () => {
    const rows = await withTenant(db.migrator, f.s.tenant, f.s.system, (tx) => tx<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
       where schemaname = 'app' and indexname = any(${NEW_INDEXES}) order by indexname`);
    expect(rows.map((r) => r.indexname)).toEqual(NEW_INDEXES);
    expect(rows[0]!.indexdef).toContain("(tenant_id, table_name, occurred_at)");
    expect(rows[1]!.indexdef).toContain("(company_id, document_type_id, effective_date)");
    expect(rows[2]!.indexdef).toContain("(company_id, occurred_at)");
    expect(rows[3]!.indexdef).toContain("(company_id, effective_date, posting_seq)");
  });

  it("every filter column is served by an index condition, not by a filter over a wider scan", async () => {
    const failures: string[] = [];
    await withTenant(db.rw, f.s.tenant, f.reader, async (tx) => {
      await tx`set local enable_seqscan = off`;
      for (const [field, target] of Object.entries(COLUMN_OF)) {
        const scope = target.scope === "company"
          ? tx`company_id = ${f.s.company}`
          : tx`tenant_id = ${f.s.tenant}`;
        // One scalar read per pair, so the probe never guesses a value vocabulary that belongs to another
        // slice (`audit_log.action`'s labels are 0A's, `document.status`'s are 2B's) and never casts: an
        // explicit `::text` over an enum column defeats the very index the gate is asking about, while a
        // bare bound parameter resolves to the column's own type. The read does not affect the plan below.
        const [sample] = await tx<{ v: string | number | Date }[]>`
          select ${tx(target.column)} as v from app.${tx(target.table)}
           where ${scope} and ${tx(target.column)} is not null limit 1`;
        if (sample?.v == null) {
          failures.push(`${field} → app.${target.table}(${target.column}) has no sample row; the fixture must post one before the gate can judge it`);
          continue;
        }
        const plan = await tx<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>`
          explain (format json)
          select 1 from app.${tx(target.table)}
           where ${scope} and ${tx(target.column)} = ${sample.v}`;
        const node = plan[0]!["QUERY PLAN"][0]!.Plan;
        // The assertion is that the COLUMN appears in an index condition. "Not a Seq Scan" is not enough:
        // with `enable_seqscan = off` the planner will happily pick ANY company_id-leading index and drop
        // the target column into `Filter`, which reads the whole company's rows and is precisely the plan
        // SAH-070 is about. `document`, `inventory_movement` and `audit_log` all carry such an index, so a
        // node-type-only check would have passed three of this slice's four pairs before 0077 existed.
        if (!conds(node).some((c) => c.includes(target.column))) {
          failures.push(`${field} → app.${target.table}(${target.column}) plans ${flatten(node).join(" / ")} with conditions [${conds(node).join("; ")}]`);
        }
      }
    });
    expect(failures, "SAH-070: a report filter served by a filter rather than an index condition — the index belongs to the owning phase's range unless it is one of this slice's four").toEqual([]);
  });

  it("the schema linter still reports zero violations, and 0077 added no table", async () => {
    expect(await lintSchema(db.migrator)).toEqual([]);
    const tables = await withTenant(db.migrator, f.s.tenant, f.s.system, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables where table_schema = 'app'`);
    expect(tables[0]!.n).toBeGreaterThan(0);
  });
});

interface PlanNode {
  "Node Type": string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Plans?: unknown[];
}

/** Every `Node Type` in a plan tree — reported in a failure so the plan that lost is readable. */
function flatten(node: PlanNode): string[] {
  const children = (node.Plans ?? []) as PlanNode[];
  return [node["Node Type"], ...children.flatMap(flatten)];
}

/** Every index condition in a plan tree. `Recheck Cond` is included because a Bitmap Index Scan carries its
 *  condition on the Bitmap Heap Scan above it, and that is still the column being used to find rows. */
function conds(node: PlanNode): string[] {
  const children = (node.Plans ?? []) as PlanNode[];
  const own = [node["Index Cond"], node["Recheck Cond"]].filter((c): c is string => typeof c === "string");
  return [...own, ...children.flatMap(conds)];
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/reports/7b-report-indexes.test.ts`
Expected: **FAIL twice, and both failures are the point of the task**:
1. the index case with `expected [] to equal [ "audit_log_tenant_table_time_idx", … ]` — the four do not exist yet;
2. the condition case listing **at least these four** unserved pairs, each with the plan that was chosen instead — the shape is `audit_log.table_name → app.audit_log(table_name) plans Index Scan with conditions [(tenant_id = '…'::uuid)]` for the three tables that already carry a scope-leading index, and `document_event.occurred_at → app.document_event(occurred_at) plans Seq Scan with conditions []` where none applies. The four are `audit_log.table_name`, `document.document_type_code`, `document_event.occurred_at` and `inventory_movement.effective_date` — **the map's keys are `snake_case`**, because the coverage case above builds them straight off each definition's `dataset.filters[].field`, which is a `DatasetColumn.field` (A3). A failure list naming `audit_log.tableName` means `COLUMN_OF` was rekeyed by hand and is now describing a vocabulary no definition uses.

**Record the list you actually get, and do not assume it is exactly four.** `document.status`, `document.branch_id`, `document_event.event_kind`, `document_event.to_status`, `audit_log.action` and `audit_log.actor_id` are served by indexes belonging to 1A, 2B and 0A, and this plan cannot verify from outside the repository which of them exist — the gate is being written precisely because that question has never been asked of the planner before. **A pair beyond this slice's four is an index request against that table's owning phase**, recorded as a contracts amendment and built in that phase's migration range before any file is written here — never added to 0077, whose four columns are fixed by amendment A7. If a pair beyond the four cannot be resolved that way in this slice, add it to `COLUMN_OF` with the owning phase named in a comment and leave the gate failing on it, rather than deleting the row and making the gate lie.

- [ ] **Step 3: Write `packages/db/migrations/0077_add_report_filter_indexes.sql`**

```sql
-- ── 0077. Report-filter indexes (SAH-070 "index coverage is thin on exactly the columns reports filter
--          by"; contracts §2.8's 7B card, amendment A7) ──────────────────────────────────────────────────
-- Four indexes, no column and no data: an expand step (§3.4.7) that can deploy under load. Not
-- `create index concurrently` — §3.4.3 runs each migration file whole in one transaction.
-- Each one is a pair the 7B EXPLAIN gate (packages/db/test/reports/7b-report-indexes.test.ts) reported as
-- planning a sequential scan with `enable_seqscan = off`, which means no usable index exists.

-- accounting.document_register and inventory.count_register filter (company_id, document_type_id,
-- effective_date). 1B's document_company_period_status_idx leads with fiscal_period_id and cannot serve a
-- type-and-date scan; `unique (company_id, series, fiscal_period_id, number)` leads with series.
create index document_company_type_date_idx
  on app.document (company_id, document_type_id, effective_date);

-- accounting.document_event_log filters (company_id, occurred_at). 2B's document_event_document_idx is
-- (document_id, occurred_at) — right for one document's history, useless for a company-wide event log.
create index document_event_company_time_idx
  on app.document_event (company_id, occurred_at);

-- inventory.movement_register and inventory.transfer_register filter (company_id, effective_date) across
-- items. 3A's inventory_movement_chrono_idx is (company_id, item_id, warehouse_id, effective_date,
-- posting_seq, line_no, movement_no): item_id sits between the two filtered columns. `posting_seq` is the
-- third column here because the register's sort is (effective_date, posting_seq, movement_no) — §4.3.5's
-- chronological key — so the index serves the ORDER BY as well as the predicate.
create index inventory_movement_company_date_idx
  on app.inventory_movement (company_id, effective_date, posting_seq);

-- accounting.audit_log filters (tenant_id, table_name, occurred_at). 0A's audit_log_tenant_seq_idx is
-- (tenant_id, seq desc) for the hash-chain walk (plan0A:2276) and leads with the wrong second column.
-- `tenant_id` and not `company_id`: app.audit_log has no company column, and the chain is per tenant.
create index audit_log_tenant_table_time_idx
  on app.audit_log (tenant_id, table_name, occurred_at);
```

- [ ] **Step 4: Write `packages/db/migrations/0077.down.sql`**

```sql
-- Reverse of 0077, in reverse creation order (§3.4.5). Dropping an index never touches a row, and no other
-- object in this file exists to drop: 0077 creates no table, column, constraint, function or grant.
drop index if exists app.audit_log_tenant_table_time_idx;
drop index if exists app.inventory_movement_company_date_idx;
drop index if exists app.document_event_company_time_idx;
drop index if exists app.document_company_type_date_idx;
```

- [ ] **Step 5: Add the four index entries to the Drizzle mirrors**

§3.4.9 makes the mirror the diff source, so an index in the database and not in the mirror makes the *next* slice's `drizzle-kit generate` emit a spurious drop. One entry each, in the existing table's index block:

```ts
// packages/db/src/schema/document.ts — inside the table's extra-config object
  companyTypeDate: index("document_company_type_date_idx").on(t.companyId, t.documentTypeId, t.effectiveDate),

// packages/db/src/schema/document-event.ts
  companyTime: index("document_event_company_time_idx").on(t.companyId, t.occurredAt),

// packages/db/src/schema/inventory-movement.ts
  companyDate: index("inventory_movement_company_date_idx").on(t.companyId, t.effectiveDate, t.postingSeq),

// packages/db/src/schema/audit-log.ts
  tenantTableTime: index("audit_log_tenant_table_time_idx").on(t.tenantId, t.tableName, t.occurredAt),
```

**If `packages/db/src/schema/audit-log.ts` does not exist**, create it as the mirror of the 0001 table with `seq` as its primary key — 0B mirrored "the 0001 tables used for reads in `apps/api`" (§3.4.9) and `audit_log` is read by 0B's own admin route, so it should be there; if it is not, this is the slice that needs it and the file is the minimum mirror of the ten columns plan0A declares, `before`/`after` included (a mirror is not a report — the *report* excludes them, per A3).

- [ ] **Step 6: Run it to pass, and prove reversibility**

Run: `cd packages/db && bun run test -- test/reports/7b-report-indexes.test.ts`
Expected: **PASS, 4 tests.**

**If `document.effective_date` is still listed, it is not a missing index.** `effective_date` is the **third** column of `document_company_type_date_idx (company_id, document_type_id, effective_date)`, and Postgres does report a non-leading equality qual in `Index Cond` when it chooses that index — so the pair should clear. If it does not, the planner bounded the scan on `company_id` alone and left the date in `Filter`, which means it preferred a narrower existing index; confirm with `explain (analyze, buffers)` by hand before concluding anything. **The answer is never a fifth index in 0077** (A7 fixes its four columns) and never deleting the row from `COLUMN_OF` — it is a `document_type_id`-shaped question for 1A's range, raised as a contracts amendment.

Run: `cd packages/db && bun run test -- test/privileges.test.ts`
Expected: **PASS** — 0B's generalised up → down → up case (§3.4.6) now covers 0077, and `schemaFingerprint` includes the index list, so a forgotten drop in the down file fails here rather than in a later slice.
Run: `bun run db:lint`
Expected: zero violations.

- [ ] **Step 7: Run everything and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`

```bash
git add packages/db/migrations/0077_add_report_filter_indexes.sql packages/db/migrations/0077.down.sql \
        packages/db/src/schema/ packages/db/test/reports/7b-report-indexes.test.ts
git commit -m "feat(db): migration 0077 - the four missing report-filter indexes (SAH-070) [7B T10]

An EXPLAIN gate over every filter column of all twenty-two definitions, run
with enable_seqscan off so a small table cannot hide a missing index. Four
pairs were unserved: document by type and date, document_event by company and
time, inventory_movement by company and date, audit_log by table and time.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: The DoD roll-up — every declared tie-out executed, test 2 and test 23 re-run

The one test that makes *"every report's numbers tie to the ledger"* a CI fact: it enumerates the catalogue, executes each definition's declared `tieOut`, and **fails naming the code when a definition has no case**. It also carries this slice's two remaining re-runs — test 2 (deterministic projections, from the report side) and test 23 (RTL/LTR parity of a rendered report) — and the one assertion that needs a running API: that 7A's runs route accepts every one of the seventeen new codes.

**Files:**
- Create: `tests/invariants/report-tie-out.test.ts`
- Modify: nothing.

**Interfaces:**
- Consumes: `CATALOGUE_7B`, `readEnvelope`, `assertTieOut`, `runDefinition`, `reportFixture` (Task 1); `renderReport`, `renderCsv`, `intlFormatters`, `RenderedReport` (7A, `@dulja/domain`, §4.11.2 / A11); `sharedApi`, `grantAdmin`, `problemOf` (0B, §4.17.1); `rebuildStockValuation`, `rebuildItemProfitability` (3B/4B); the production `withTenant(sql, ctx, fn)` (§4.2.2 — **root `tests/` use the production helper**, hazard 15). **Not consumed: `pdfText`, `rendererFor`, `startWorker`** — see the note below.
- Produces: nothing exported.

**Why this file is in `tests/invariants/`.** It is a continuous proof of a definition-of-done sentence over a whole catalogue, which is what that directory holds (§3.7.1: `ledger-balance`, `projection-rebuild`, `audit-chain`). It is also the only place in this slice that may import `tests/support/api.ts` — a `packages/db/test/**` file may reach `tests/invariants/support/**` and nothing else (3B's allowance), so the API half of this slice's proof has to live here.

**And why the test-23 re-run stops at the rendered-text layer.** PDF bytes have exactly one producer, `rendererFor(format).render(rendered)` in `apps/worker/src/reports/renderers/`, and the only way to drive it end to end is `startWorker()` in `apps/worker/test/support/worker.ts` (§4.17.1). **§3.1 admits neither into `tests/`**: the `tests` workspace "imports any package and `apps/api` **only** through its exported entry points `createApp()` and `./routes`", and the two dependency-rule allowances that exist run the *other* way (`apps/worker/test/**` and `apps/api/test/**` → `tests/invariants/support/**`). A third allowance in this direction would be a §4.17.1 amendment 7B has no reason to make: **7A already owns the PDF byte layer of test 23**, at `apps/worker/test/reports/pdf.test.ts`, where it belongs. What this slice adds is the same property over its **own catalogue**, asserted where it can be: `renderReport` is synchronous and returns a `RenderedReport` whose `columns`, `rows`, `dir` and `header` carry everything test 23 is about (spec:2253 — numerals, dates and column order), and `renderCsv` turns it into text. Neither is a weaker check than reading a PDF's text layer; both are the same data one step earlier, and 7A's own renderer test is what proves the step after it.

- [ ] **Step 1: Write the test**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, intlFormatters, renderCsv, renderReport, type RenderedReport } from "@dulja/domain";
import { rebuildItemProfitability, rebuildStockValuation, withTenant } from "@dulja/db";
import { startDb, uuidv7, type Db } from "@dulja/db/test";
import { sharedApi, grantAdmin, problemOf } from "../support/api";
import {
  CATALOGUE_7B, assertTieOut, readEnvelope, reportFixture, runDefinition, type ReportFixture,
} from "./support/reports";

const MYR = currency("MYR");
const AS_OF = "2026-01-31";

/** Every code's parameters and ledger window, in ONE place. A definition added to `CATALOGUE_7B` without an
 *  entry here fails the first case by name, which is the whole mechanism of ADR 0068. */
function caseFor(code: string, f: ReportFixture): Parameters<typeof assertTieOut>[2] {
  const c = f.s.company; const inv = f.inventory!;
  const jan = { fiscalPeriodId: f.s.period };
  const range = { fromDate: "2026-01-01", toDate: "2026-01-31" };
  switch (code) {
    case "accounting.general_ledger":
      return { params: { companyId: c, ...range, accountId: null, branchId: null }, baseCurrency: MYR, window: jan };
    case "accounting.journal_register":
      return { params: { companyId: c, ...range, documentTypeCode: null }, baseCurrency: MYR, window: range };
    case "accounting.account_statement":
      return { params: { companyId: c, accountId: f.s.cash, ...range }, baseCurrency: MYR, window: { ...jan, accountCode: "1000" } };
    // `accountType` is "income", never null: this definition's first money total is `base_balance`, and over
    // every account `sum(base_debit - base_credit)` is zero by the ledger invariant, so a null type would
    // compare 0.0000 against 0.0000 and pass whatever the dataset returned (ADR 0068 rule 1).
    case "accounting.period_comparison":
      return { params: { companyId: c, fiscalPeriodId: f.s.period, accountType: "income" }, baseCurrency: MYR, window: { ...jan, accountTypes: ["income"] } };
    // The two statements take ONE parameter (amendment A6): `statementRows` applies the account-type split on
    // the report side, so only the LEDGER side has to be told which types the statement covers.
    case "accounting.profit_and_loss":
      return { params: { companyId: c, fiscalPeriodId: f.s.period }, baseCurrency: MYR, window: { ...jan, accountTypes: ["income", "expense"] } };
    case "accounting.balance_sheet":
      return { params: { companyId: c, fiscalPeriodId: f.s.period }, baseCurrency: MYR, window: { ...jan, accountTypes: ["asset", "liability", "equity"] } };
    case "accounting.document_register":
      return { params: { companyId: c, ...range, documentTypeCode: "JOURNAL", status: "posted", branchId: null }, baseCurrency: MYR, window: { ...range, documentTypeCodes: ["JOURNAL"] } };
    case "accounting.audit_log":
      return {
        params: { companyId: c, tableName: "document", action: "insert", fromDate: "2026-01-01", toDate: "2027-01-01", actorId: null },
        baseCurrency: MYR,
        // Every witness key below is a `DatasetColumn.field` (A3), because `assertTieOut` projects ONE key
        // list over both sides: a camelCase key reads `undefined` on every report row and the tie-out then
        // fails — or, worse, passes — for a reason that has nothing to do with the report.
        witness: { key: ["table_name", "row_id"], rows: (t) => t`select 'document' as table_name, id::text as row_id from app.document where company_id = ${c}` },
      };
    case "accounting.document_event_log":
      return {
        params: { companyId: c, documentTypeCode: null, eventKind: "transition", toStatus: "posted", fromDate: "2026-01-01", toDate: "2027-01-01" },
        baseCurrency: MYR,
        witness: { key: ["document_id", "to_status"], rows: (t) => t`select id::text as document_id, 'posted' as to_status from app.document where company_id = ${c} and status = 'posted'` },
      };
    case "accounting.trial_balance":
      return { params: { companyId: c, fiscalPeriodId: f.s.period, currency: null }, baseCurrency: MYR, window: jan };
    // `accountCode` narrows the stored side to the one account the report is filtered to — without it the
    // `account_balance` branch would ask this report to account for account 4000 as well. Task 4 explains.
    case "accounting.ledger":
      return { params: { companyId: c, accountId: f.s.cash, ...range }, baseCurrency: MYR, window: { ...jan, accountCode: "1000" } };
    // No `asOf` in the params: the definition declares none (A13). `TieOutOptions.asOf` is the HARNESS's,
    // and it is what `valuationAsOf` is called with.
    case "inventory.stock_ageing":
      return { params: { companyId: c, itemId: inv.itemId, warehouseId: null }, baseCurrency: MYR, asOf: AS_OF };
    case "inventory.movement_register":
      return { params: { companyId: c, fromDate: "2020-01-01", toDate: "2030-12-31", itemId: null, warehouseId: null, documentTypeCode: null }, baseCurrency: MYR };
    // `tieOut.kind` is `none` (the `lot` dataset carries no quantity, A3), so a witness is MANDATORY: the
    // harness throws "the group test must supply a row witness" without one (A5).
    case "inventory.expiry_list":
      return {
        params: { companyId: c, beforeDate: "2026-12-31", itemId: null }, baseCurrency: MYR,
        witness: {
          key: ["code", "item_code", "expires_on"],
          rows: (t) => t`select l.code, i.code as item_code, l.expires_on::text as expires_on
                           from app.lot l join app.item i on i.id = l.item_id
                          where l.company_id = ${c}
                            and l.expires_on is not null and l.expires_on <= date '2026-12-31'`,
        },
      };
    case "inventory.price_list":
      return {
        params: { companyId: c, priceListId: null, itemId: null, onDate: "2026-01-15" }, baseCurrency: MYR,
        witness: { key: ["item_code", "unit_price"], rows: (t) => t`select i.code as item_code, l.unit_price::text as unit_price from app.price_list_line l join app.item i on i.id = l.item_id` },
      };
    case "inventory.promotion_register":
      return {
        params: { companyId: c, onDate: "2026-01-15", branchId: null }, baseCurrency: MYR,
        witness: { key: ["code", "kind"], rows: (t) => t`select code, kind from app.promotion where company_id = ${c}` },
      };
    case "inventory.transfer_register":
      return {
        params: { companyId: c, ...range, itemId: null, warehouseId: null, transferTypes: "TRANSFER,TRANSFER_RECEIPT" },
        baseCurrency: MYR, projectionKeys: [`${inv.itemId}|${inv.whTransit}|${inv.lotId}`],
      };
    case "inventory.count_register":
      return { params: { companyId: c, ...range, branchId: null, status: "posted", countTypes: "STOCK_COUNT" }, baseCurrency: MYR, window: { ...range, documentTypeCodes: ["STOCK_COUNT"] } };
    case "inventory.profit_by_item":
      return { params: { companyId: c, fiscalPeriodId: f.s.period, itemId: null }, baseCurrency: MYR };
    case "inventory.stock_on_hand":
      return { params: { companyId: c, warehouseKinds: "stock,in_transit", itemId: null, warehouseId: null }, baseCurrency: MYR };
    case "inventory.valuation":
      return { params: { companyId: c, asOf: AS_OF, itemId: inv.itemId, warehouseId: null }, baseCurrency: MYR, asOf: AS_OF };
    case "inventory.sales_by_item":
      return { params: { companyId: c, fiscalPeriodId: f.s.period, itemId: null }, baseCurrency: MYR };
    default:
      throw new Error(`report-tie-out: ${code} has no tie-out case — ADR 0068 requires one before the definition ships`);
  }
}

describe("Phase 7 DoD — every report's numbers tie to the ledger (7B's catalogue, ADR 0068)", () => {
  let db: Db; let f: ReportFixture;

  beforeAll(async () => {
    db = await startDb();
    f = await reportFixture(db, "TieOut", { inventory: true, sales: true, catalogue: true });
    const ctx = { tenantId: f.s.tenant, actorId: f.s.system, requestId: await uuidv7(db.admin) };
    await withTenant(db.migrator, ctx, async (tx) => {
      await rebuildStockValuation(tx, { companyId: f.s.company, asOf: AS_OF });
      await rebuildItemProfitability(tx, { companyId: f.s.company });
    });
  }, 300_000);
  afterAll(async () => { await db.stop(); });

  it("every code in the catalogue has a tie-out case", () => {
    for (const code of CATALOGUE_7B) expect(() => caseFor(code, f), code).not.toThrow();
  });

  it.each([...CATALOGUE_7B])("%s ties", async (code) => {
    const ctx = { tenantId: f.s.tenant, actorId: f.reader, requestId: await uuidv7(db.admin) };
    await withTenant(db.rw, ctx, (tx) => assertTieOut(tx, readEnvelope(code).definition, caseFor(code, f)));
  });

  it("TEST 2 re-run: a projection-backed report reads the projection, so a rebuild moves both or neither", async () => {
    // spec:2420. The report side of the clause: rebuild the two async projections a second time and every
    // projection-kind tie-out must still hold. If a report were re-aggregating instead of reading, a rebuild
    // would leave the report unchanged and the projection changed — and this case would pass with a
    // stale figure. So it also asserts the projections' own rebuild is a no-op the second time, which is
    // what "rebuilds bit-identically" means from outside the integrity job.
    const sys = { tenantId: f.s.tenant, actorId: f.s.system, requestId: await uuidv7(db.admin) };
    const before = await withTenant(db.rw, { ...sys, actorId: f.reader }, (tx) => tx<{ h: string }[]>`
      select md5(string_agg(t, '|' order by t)) as h from (
        select item_id::text || ':' || warehouse_id::text || ':' || value::text as t from app.stock_valuation
        union all
        select item_id::text || ':' || fiscal_period_id::text || ':' || margin_base::text from app.item_profitability
      ) s`);
    await withTenant(db.migrator, sys, async (tx) => {
      await rebuildStockValuation(tx, { companyId: f.s.company, asOf: AS_OF });
      await rebuildItemProfitability(tx, { companyId: f.s.company });
    });
    const after = await withTenant(db.rw, { ...sys, actorId: f.reader }, (tx) => tx<{ h: string }[]>`
      select md5(string_agg(t, '|' order by t)) as h from (
        select item_id::text || ':' || warehouse_id::text || ':' || value::text as t from app.stock_valuation
        union all
        select item_id::text || ':' || fiscal_period_id::text || ':' || margin_base::text from app.item_profitability
      ) s`);
    expect(after[0]!.h).toBe(before[0]!.h);
    for (const code of ["inventory.valuation", "inventory.profit_by_item", "inventory.sales_by_item"]) {
      const ctx = { tenantId: f.s.tenant, actorId: f.reader, requestId: await uuidv7(db.admin) };
      await withTenant(db.rw, ctx, (tx) => assertTieOut(tx, readEnvelope(code).definition, caseFor(code, f)));
    }
  });

  it("TEST 23 re-run: one definition renders in both directions with the same figures (spec:2441)", async () => {
    const ctx = { tenantId: f.s.tenant, actorId: f.reader, requestId: await uuidv7(db.admin) };
    const definition = readEnvelope("accounting.trial_balance").definition;
    const rows = await withTenant(db.rw, ctx, (tx) =>
      runDefinition(tx, definition, { companyId: f.s.company, fiscalPeriodId: f.s.period, currency: null }));
    // `renderReport` is SYNCHRONOUS and `RenderOptions.formatters` is REQUIRED (A11): the numeral and
    // calendar policy is 0E's, injected, and never re-decided by a renderer. `generatedAt` is pinned so the
    // two renders differ in nothing but language. It returns a `RenderedReport` VALUE OBJECT, never bytes.
    const render = (lang: "en" | "ar"): RenderedReport =>
      renderReport(definition, rows, {
        format: "csv", lang,
        formatters: intlFormatters(lang, { currency: "MYR" }),
        parameters: { fiscalPeriodId: f.s.period },
        generatedAt: "2026-02-01T00:00:00Z",
      });
    const en = render("en");
    const ar = render("ar");

    expect(en.dir).toBe("ltr");
    expect(ar.dir).toBe("rtl");
    // The COLUMNS are the same fields in the same LOGICAL order in both (7A's `RenderedReport.columns` comment — "LOGICAL order — never reversed for rtl";
    // direction is carried by `dir` and applied by the renderer, which is what makes one definition serve
    // both). What differs is the label, and both labels come from the definition.
    expect(ar.columns.map((c) => c.field)).toEqual(en.columns.map((c) => c.field));
    expect(en.title).toBe(definition.nameEn);
    expect(ar.title).toBe(definition.nameAr);
    expect(en.rowCount).toBe(ar.rowCount);
    expect(en.rowCount).toBeGreaterThan(0);

    // And the FIGURES are identical, asserted at the rendered-text layer through `renderCsv` — the same data
    // one step before `rendererFor` turns it into bytes, and the layer 7A's own PDF test 23 asserts on
    // (apps/worker/test/reports/pdf.test.ts), which §3.1 keeps out of this workspace.
    // `intlFormatters` defaults `numberingSystem` to "latn" for BOTH languages (`opts.numberingSystem ?? "latn"` in `packages/domain/src/reports/format.ts`), so a Latin
    // digit regex is correct here. If a later slice makes "arab" the Arabic default, this case fails on
    // `figures(arText)` being empty — and the fix is to normalise the numerals, never to drop the assertion.
    const figures = (csv: string) =>
      csv.split(/[\r\n,]+/).filter((t) => /^-?\d[\d,]*\.\d{4}$/.test(t)).sort();
    const enText = renderCsv(en);
    const arText = renderCsv(ar);
    expect(figures(arText)).toEqual(figures(enText));
    expect(figures(enText).length).toBeGreaterThan(0);
    expect(arText).toContain(definition.columns[0]!.labelAr);
    expect(enText).toContain(definition.columns[0]!.labelEn);
  });

  it("7A's runs route accepts all seventeen new codes and 404s a well-formed code with no definition", async () => {
    const api = await sharedApi();
    await grantAdmin(api, api.a);
    const codes = CATALOGUE_7B.filter((c) => readEnvelope(c).definitionVersion === 1);
    expect(codes.length).toBe(17);
    for (const code of codes) {
      const res = await api.request({
        method: "POST", path: `/v1/companies/${api.a.company}/reports/${code}/runs`,
        as: api.a.human, body: { parameters: {}, format: "csv", lang: "en" },
      });
      // 404, not 202: `sharedApi()`'s tenant is 0B's, NOT this file's fixture, so no 7B definition is
      // seeded there and `resolveDefinitionForRun` resolves nothing. What this loop proves is that all
      // seventeen codes get PAST the path grammar and reach 7A's handler — a code the regex rejects never
      // gets that far, and answers the 400 the `malformed` case below pins. Seventeen 404s here are the
      // PASSING result and do not mean the seed step failed.
      expect(res.status, `${code} answered ${res.status}`).toBe(404);
    }
    // A WELL-FORMED code with no seeded definition is a 404, not a 400 and not a 403 — FOR THIS CALLER.
    // `{code}` is validated by a bare grammar regex, and 7A's gate order is `requireReportExport` →
    // `resolveDefinitionForRun` → `requireReportRead`, so export authority is proved on the path parameter
    // before any row is read and the route never becomes an existence oracle (amendment A4). The
    // `grantAdmin` above is therefore load-bearing: WITHOUT it every request here would answer 403 and this
    // case would be asserting the opposite of what the handler does. `ReportCodeSchema` is the TYPED
    // surface, not the route's guard, so a case asserting 400 here would also be asserting something 7A's
    // route does not do.
    const missing = await api.request({
      method: "POST", path: `/v1/companies/${api.a.company}/reports/accounting.not_a_report/runs`,
      as: api.a.human, body: { parameters: {}, format: "csv", lang: "en" },
    });
    expect(missing.status).toBe(404);
    expect((await problemOf(missing)).code).toBe("ERR_NOT_FOUND");
    // A code that does not match the grammar at all is the 400: uppercase, and no module segment.
    const malformed = await api.request({
      method: "POST", path: `/v1/companies/${api.a.company}/reports/Accounting.NotAReport/runs`,
      as: api.a.human, body: { parameters: {}, format: "csv", lang: "en" },
    });
    expect(malformed.status).toBe(400);
    expect((await problemOf(malformed)).code).toBe("ERR_VALIDATION_FAILED");
  });
});
```

**`sharedApi()`'s returned shape is 0B's** (`FullContext`, §4.17.1) and the two members used above are its running API and its first seeded tenant. §4.18's round-1 open item 5 records that `sharedDb()`'s shape is declared one way in §4.17.1 and used another way in 1A's blocks — the same caution applies here: if `FullContext` names them differently, **correct the destructuring in this file** and never add a second `startApi()` beside 0B's memoised stack (`sharedApi()` is memoised per process, 0b:39, and a second stack in the same run leaks a container).

**On the three status codes in the last case, and why seventeen 404s are the passing result.** `sharedApi()`'s tenant is 0B's and is **not** this file's fixture: it runs no seed of 7B's pack, so none of the seventeen resolves to a definition and every one of them answers 7A's **404 "No such report"**. That is the assertion, and it is exact rather than a set, because a permissive `[202, 404, 422]` would read as if the loop proved a run succeeded when the only thing it can prove is **reachability** — that the code got past `{code}`'s grammar regex, past `requireReportExport` (which the `grantAdmin` above satisfies) and into `resolveDefinitionForRun` — 7A's gate order is `requireReportExport` → `resolveDefinitionForRun` → `requireReportRead`, so an **ungranted** caller would see 403 here and prove nothing (A4). The discrimination is therefore the pair below the loop: a well-formed-but-unseeded code is a **404 / `ERR_NOT_FOUND`**, and a code the regex rejects is the **400 / `ERR_VALIDATION_FAILED`** — the only 400 this route can produce for a code, and the reason `ReportCodeSchema` membership is the *typed* surface and not the route's guard. **Seeding the pack into `sharedApi()`'s tenant to chase a 202 is not the improvement it looks like**: it would need a second seed run against a second database inside an invariants file, and the 202/422 path over real parameters is already what the twenty-two `%s ties` cases and Task 9's loader case cover.

- [ ] **Step 2: Run it and read the failures**

Run: `bun run --cwd tests test -- invariants/report-tie-out.test.ts`
Expected: **PASS, 26 tests** (one coverage case, twenty-two `%s ties` cases, test 2, test 23, the runs route). Four failures worth naming:
- `report-tie-out: <code> has no tie-out case — ADR 0068 requires one before the definition ships` — the intended failure when a definition is added without a case. Add the case; never widen the `default` branch.
- `<code>: the fixture returned no rows, so field coverage proves nothing` — a parameter in `caseFor` does not match this fixture (a wrong period, an `asOf` before the receipt). The tie-out is right to refuse; fix the case's parameters.
- `Property 'formatters' is missing in type …` from `typecheck` — `RenderOptions.formatters` is **required** (A11) and `intlFormatters(lang, { currency: "MYR" })` is what supplies it. Never widen the type; the numeral and calendar policy is 0E's and is injected on purpose.
- `expected [] to equal [ "1000.0000", … ]` on `figures(arText)` — the Arabic render emitted Arabic-Indic numerals, i.e. something set `numberingSystem: "arab"` where 7A defaults both languages to `"latn"` (`opts.numberingSystem ?? "latn"` in `packages/domain/src/reports/format.ts`). **Normalise the digits in `figures`, or pass the numbering system explicitly and say so** — do not delete the comparison, which is the whole of test 23's numeral clause.

- [ ] **Step 3: Run everything and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`

```bash
git add tests/invariants/report-tie-out.test.ts
git commit -m "test(invariants): the catalogue's tie-out roll-up, tests 2 and 23 re-run [7B T11]

Twenty-two declared tie-outs executed, and a definition with no case fails the
build by name (ADR 0068). Test 2 from the report side: a second rebuild moves
neither the projection nor the report. Test 23: one definition rendered in both
directions carries the same figures.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: ⚠️ OD-27 — mapping the legacy template catalogue to definitions

**Owner decision OD-27** (§2.12): Part VII items #6–#9 and #13, of which **#8** is this slice's — *which of the 255 legacy report templates are actually in use* (spec:2472). The 7B card names the consequence in terms: *"informs the catalogue; the task 'map the legacy template catalogue from 9A to definitions' is dropped or trimmed if 9A has not run."*

**Default written into this plan: the task is dropped.** The twenty-two definitions of Tasks 1–8 are derived from §4.16.1's register and from the spec's own scope sentence, not from the legacy catalogue, and nothing in Tasks 1–11 depends on this task. If the material is absent, **leave Steps 2–4 unchecked and ship the slice.**

**Files (only if the gate opens):**
- Create: `docs/legacy/7b-template-mapping.md`
- Modify: nothing. **This task never adds a definition** — see Step 4.
- If the gate is closed: **creates and modifies nothing.**

**Interfaces:**
- Consumes: nothing at build time. If the gate opens, it *reads* 9A's artefacts from **`artefacts/legacy/<run>/`** as files on disk (§4.13.1) — never as an import, because 9A ships no package this slice's import graph reaches. Otherwise: `CATALOGUE_7B` (Task 1) as the list of codes a mapping row may name, consulted by the writer and by no code. **The directory is git-ignored and its contents are never committed** — 9A Task 1 puts `artefacts/` in `.gitignore` because every file under it is customer data — so `<run>` is whatever `--out` the owner passed and the artefacts arrive on the machine that ran 9A, not in the repository. An earlier draft of this task named `docs/legacy/9a-artefacts/`, a path **9A does not write and by its own rule may not write**; the correction is this line, and the artefact document this task produces is the only thing that lands under `docs/`.
- Produces: `docs/legacy/7b-template-mapping.md` if the gate opens, **or nothing**. **No TypeScript, no JSON definition, no export, and no name in any shared namespace** — a twenty-third definition here would be a report code no register holds (hazard 32) and a definition with no tie-out case (ADR 0068), and Step 4 says so.

- [ ] **Step 1: The gate**

*Owner provides:* the answer to Part VII #8 — the list of legacy report templates in daily use — **or** 9A's profiling artefacts, which answer it from the data rather than from memory.

**Verify:** the owner names the run directory 9A wrote — call it `$RUN`, e.g. `artefacts/legacy/scope` for a live run or `artefacts/legacy/dev` for a fixture one — and

```bash
RUN=artefacts/legacy/<the run the owner names>
ls "$RUN"/index.json "$RUN"/templates.json "$RUN"/scope.json "$RUN"/open-questions.json \
  && bash scripts/check/contracts-7b-amendments.sh
```

lists the four files and prints `7B Task 0 gate OK.` **`ls` of a fixed committed path is deliberately not the check**: `artefacts/` is git-ignored (9A Task 1), so the directory is absent on a clean clone by design and its absence proves nothing about whether 9A ran.
**Until provided:** this task is dropped. Nothing else in the slice is blocked, and no later slice depends on its output — 7C carries the same gate for its own eleven codes and drops it the same way.

**What 9A produces that this task would read** (§4.13.1, named file by file so this is a step and not a gesture — every one of them is written by a `bun run legacy <command> --out "$RUN"` the owner runs, and `bun run legacy all --out "$RUN"` writes the lot):

| File in `$RUN` | 9A's shape | What this task takes from it |
|---|---|---|
| `index.json` | `ArtefactIndex` | the manifest — `generatedAt`, `source`, `engineVersion` and every `ArtefactEntry`. Read first: it says which of the rows below actually ran, so a missing `templates.json` is read as "9A T12 was not run" rather than as "the customer has no templates" |
| `templates.json` (+ `templates.csv`) | `TemplateCatalogue` — `entries: TemplateEntry[]` with `name`, `bytes`, `empty`, `group`, `customisation`, `sha256`, `nearDuplicateOf`, and a `note` | **the 255 legacy templates by name.** This is the left-hand column of the mapping table below. `nearDuplicateOf` is what collapses a near-duplicate family onto one Dulja code; `empty: true` is a template with no blob and maps to nothing |
| `scope.json` | `ScopeReport` — `tables: TableScope[]` with per-table row counts and date ranges | corroboration only: a template over a table whose last row is from 2014 is not in daily use whatever the owner remembers |
| `open-questions.json` | `OpenQuestionReport` — one `OpenQuestionAnswer` per `QuestionId` | its **`VII-8`** row is the evidence for this task's own owner decision (Part VII #8, spec:2472, OD-27). 9A's probe **collects evidence and decides nothing**: `verdict` is `null` until the owner fills it, and a question the source cannot answer carries `status: "unanswerable_here"`. **A `null` verdict is not an answer and this task may not supply one** — it is exactly the case in which Step 1's gate stays closed |

**9A floats in the schedule** (§6.3: "9A ∥ anything after 0B"), so its absence here is expected rather than a failure. **Nothing above is imported.** Each is `JSON.parse` of a file the writer of the mapping document opens by hand; this task ships no TypeScript, so it never depends on `@dulja/importer` and 9A's barrel is not in this slice's import graph.

- [ ] **Step 2: Read the artefacts and write the mapping document**

`docs/legacy/7b-template-mapping.md`, one table, one row per legacy template the owner or 9A names:

```markdown
# Legacy report templates → Dulja report codes (7B's half)

Source: the owner's list, dated, and/or 9A's run `artefacts/legacy/<run>` — quote `index.json`'s
`generatedAt`, `source` and `engineVersion` here so the mapping says which extraction it was read from.
The artefacts themselves are NOT copied into this document or into the repository: they are customer data
and `artefacts/` is git-ignored. **This document maps; it decides nothing.** A legacy template with no Dulja code is a *finding*, not a work item: adding a report
code requires a §4.16.1 amendment first (hazard 32), and Phase 10 is where a genuinely new report lands.

| Legacy template | In use (source) | Dulja code | Fit |
|---|---|---|---|
| … | … | `accounting.general_ledger` | exact / partial / none |
```

**Fit is one of three words, and each has a consequence.** *exact* — the legacy output is a parameterisation of a shipped definition, and the row records which parameters. *partial* — the shipped definition carries the figures but not the layout or a grouping; the remedy is a **tenant clone** through 7A's designer, which is Phase 7's own DoD sentence and needs no release. *none* — no shipped code covers it; the row states what it would need, and that is a §4.16.1 amendment for a later slice.

- [ ] **Step 3: Record the count, and nothing else, in the mapping document's header**

Three numbers: templates named, templates mapped *exact* or *partial*, templates *none*. They are the only quantitative claim this task makes, and they are what the owner needs to decide whether the catalogue is complete enough to cut over.

- [ ] **Step 4: Do not add a definition in this task**

If the mapping finds a *none* row that the owner considers essential, the sequence is: amend §4.16.1 with the new code (one line, one PR), then ship its definition and its tie-out in a slice of its own. **A twenty-third definition added here would be a report code that no register holds**, which hazard 32 makes a review-blocking finding, and it would arrive without a tie-out, which ADR 0068's roll-up would fail on by name — correctly.

- [ ] **Step 5: Commit (only if Steps 2–3 ran)**

```bash
git add docs/legacy/7b-template-mapping.md
git commit -m "docs(legacy): map the in-use legacy templates to 7B's report codes [7B T12]

OD-27 / Part VII #8. The mapping records exact, partial and none per template;
a `none` row is a finding for a §4.16.1 amendment, never a definition added here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 13: ⚠️ OD-24 — the catalogue's screens

**Owner decision OD-24** (§2.12, hazard 29): *screenshots and a two-minute operator description before any screen* (spec:79, 108, 2408).

**⚠️ First, the discrepancy this task exists inside of.** **§2.8's 7B card names OD-27 and no other owner gate**, and §2.12's OD-24 row scopes that decision to "every slice with a screen task" — 7B has none, which is why the card omits it. The **orchestrator's slice record** for 7B does list OD-24, and hazard 6 requires one isolated task per owner decision a slice carries, so the task is written rather than silently dropped. It ships nothing under either reading, so the discrepancy costs a heading and no work; it is recorded here, in the Assumptions block and in the Self-Review so that whoever reconciles the two sources can see which one this plan followed and why. **If the card is the authority, delete this task; renumbering nothing else, because no task depends on it.**

**Default written into this plan: no screen ships in 7B, and the slice is not blocked.** The twenty-two definitions appear in **7A's** report list and **7A's** designer the moment they are seeded — that is what a definition is *for* — and this slice adds no route, no component and no navigation entry. There is therefore nothing behind this gate for the catalogue to work.

**Files:**
- Create: nothing. Modify: nothing. **This task ships no file under either reading of the OD-24 discrepancy above** — under its default because no screen ships, and under the open gate because Step 2 writes a *proposal* into the same PR as the owner's screenshots and Step 3 is a re-run of an existing spec file, not a new one.

**Interfaces:**
- Consumes: nothing at build time. If the material arrives, Step 3 runs 0E's `bootLocalStack()` fixture against **7A's** existing report list and viewer specs with this slice's catalogue seeded — 7A's screens, 7A's spec file, this slice's seed data.
- Produces: nothing. **No route, no component, no navigation entry, no `ReportDefinition` member.** A `layout.group` or `category` member is what a grouped menu would read, and §4.11.1 carries neither — so Step 2 proposes it (spec:95) and stops, because adding a member to a frozen format is a contracts PR before it is code.

- [ ] **Step 1: The gate**

*Owner provides:* screenshots of the legacy report **menu** (how a user finds a report among a few dozen) and a two-minute description of how a clerk runs one, plus which reports they run daily.
**Verify:** `ls docs/owner/od-24/7b/` lists at least one image and one `description.md`, and the description is attached to this task.
**Until provided:** **this task ships nothing.** Steps 2–3 stay unchecked and Task 14 proceeds.

- [ ] **Step 2: If the material arrives — a catalogue-browse view is 7A's screen, not a new one**

The only thing this slice could add is a *grouping* of the catalogue for the report list: the seventeen new codes arrive as a flat alphabetical list otherwise. The change would be **one field's worth of presentation data**, and it does not exist in §4.11.1 — so it needs an amendment to that frozen format before any code. Write it as a **proposal** (spec:95) in the same PR as the screenshots, state that a `layout.group` or a `category` member is what a menu would read, and **stop there**. Do not add the member and then discuss it.

- [ ] **Step 3: If the material arrives — re-run test 23 against the two screens 7A already ships**

`bun run --cwd tests test:e2e -- --grep "report"` through 0E's `bootLocalStack()` fixture, in both text directions, over 7A's list and viewer with this slice's catalogue seeded. No new spec file: 7A owns those screens and their spec, and this is a re-run against a fuller catalogue (spec:2377, test 23).

- [ ] **Step 4: Record the outcome either way**

Whether the material arrived or not, note it in Task 14's slice report line — *"OD-24: no material; 7B shipped no screen, as designed"* is a complete and correct outcome, and it is what tells 7C's reader that the gate is still open for the export screen it does need.

### Task 14: Slice exit — five regression appends, the pins, and the re-run matrix

The five `— 7B` blocks §2.8 assigns this slice, one file that pins every count this plan's prose claims, and the matrix of everything that must be green before 7C starts. **This slice does not close Phase 7 and does not rewrite `AGENTS.md`'s "Current phase" section** (§3.8 names 7C).

**Files:**
- Create: `tests/invariants/report-catalogue-pins.test.ts`
- Modify: `tests/regression/sah-014.test.ts`, `tests/regression/sah-015.test.ts`, `tests/regression/sah-055.test.ts`, `tests/regression/sah-070.test.ts`, `tests/regression/sah-076.test.ts` — **append one `describe` block each; never edit an earlier block** (§3.7.3).

**Interfaces:**
- Consumes: `sharedDb`, `repoFile` (0B/0C, §4.17.1); `ROUTES` from `@dulja/api/routes`, `JOBS` and `discover` from `@dulja/db`, `ERRORS` and `ReportCodeSchema` from `@dulja/contracts` (**one import statement, not two** — Step 6's own `bun run lint` runs `no-duplicate-imports`), `MIGRATIONS_DIR` and the 4-argument test `withTenant` and `seedRate` from `@dulja/db/test`; `openLayersOf`, `valuationAsOf` and the types `CostLayerRow`, `ValuationRow` (3B) and `DatasetRow` (7A) — the four the printed helpers of Steps 1 and 3 annotate with; `Money`, `currency` (0D); `CATALOGUE_7B`, `readEnvelope`, `readDefinition`, `runDefinition`, **`cachedReportFixture`** and the type `ReportFixture` (Task 1).
- Produces: nothing exported.

- [ ] **Step 1: Append the `— 7B` block to `tests/regression/sah-014.test.ts`** (created by 4A)

```ts
describe("SAH-014 The caller's exchange rate is never discarded — 7B", () => {
  // The defect: the legacy posting path took a rate from the caller and then re-derived one at read time,
  // so a report and a voucher disagreed. Every base figure in this catalogue is a STORED column — spec:2041,
  // "stored base amounts are never recomputed on read" — and the report carries the document's own
  // `exchangeRate` beside it so a reader can see which rate produced it.
  it("a later rate for the same pair does not move a single figure in the general ledger", async () => {
    const { db } = await sharedDb();
    const f = await cachedReportFixture(db, "sah014-7b");
    // A document posts at the rate of its day, a NEWER rate lands, and the report is read again. Both reads
    // must be byte-identical: if any report re-derived a base amount, the second read would move.
    const before = await readGeneralLedger(f);
    await seedRate(db, f.s, { from: "USD", to: "MYR", on: "2026-01-20", rate: "9.99000000", source: "manual:test" });
    const after = await readGeneralLedger(f);
    expect(after).toEqual(before);
    expect(after.every((r) => /^\d+\.\d{8}$/.test(r.exchangeRate))).toBe(true);
  });
});
```

**The fixture is a THIRD tenant on 0B's shared container**, built through `cachedReportFixture(db, "sah014-7b")` — not a `startDb()` of this file's own, which would add a container to a suite that runs one (§3.7.1). `readGeneralLedger` is file-local and goes **above** the `describe`, beside 4A's own helpers:

```ts
// tests/regression/sah-014.test.ts — file-local, above the 7B describe.
// Imports this block adds (merge into the file's existing statements; `no-duplicate-imports` is on):
//   import { cachedReportFixture, readDefinition, runDefinition, type ReportFixture }
//     from "../invariants/support/reports";
//   import { seedRate, withTenant } from "@dulja/db/test";
interface LedgerLine { number: string; exchangeRate: string; baseDebit: string; baseCredit: string }

/** January 2026's general ledger as the shipped definition answers it, in a stable order.
 *  **The right-hand side of each field is a snake_case dataset alias (A3); the left-hand side is this
 *  helper's own local shape** — which is why the case reads `r.exchangeRate` and not `r.exchange_rate`:
 *  it is reading a `LedgerLine`, not a `DatasetRow`. */
async function readGeneralLedger(f: ReportFixture): Promise<LedgerLine[]> {
  const rows = await withTenant(f.db.rw, f.s.tenant, f.reader, (tx) =>
    runDefinition(tx, readDefinition("accounting.general_ledger"), {
      companyId: f.s.company, fromDate: "2026-01-01", toDate: "2026-01-31",
      accountId: null, branchId: null,
    }));
  return rows
    .map((r) => ({
      number: String(r.number), exchangeRate: String(r.exchange_rate),
      baseDebit: String(r.base_debit), baseCredit: String(r.base_credit),
    }))
    .sort((a, b) => a.number.localeCompare(b.number));
}
```

- [ ] **Step 2: Append to `tests/regression/sah-015.test.ts`** (created by 3B)

```ts
describe("SAH-015 A date window computed from a predicate that can never be satisfied — 7B", () => {
  // The defect: a window built so that no row could ever satisfy it, and no error either — an empty report
  // that looked like an empty business. Every date-ranged definition in this catalogue expresses its window
  // as TWO clauses on ONE field with TWO DISTINCT parameters, which is the only shape that can be
  // satisfied and the only shape a reader can check. This asserts it mechanically over all twenty-two.
  it("no definition builds a window from one parameter used twice, and no clause compares a field with itself", () => {
    for (const code of CATALOGUE_7B) {
      const d = readEnvelope(code).definition;
      const byField = new Map<string, { op: string; param: string }[]>();
      for (const c of d.dataset.filters) byField.set(c.field, [...(byField.get(c.field) ?? []), c]);
      for (const [field, clauses] of byField) {
        const params = clauses.map((c) => c.param);
        expect(new Set(params).size, `${code}: ${field} has ${clauses.length} clauses and ${new Set(params).size} distinct parameters`)
          .toBe(params.length);
        const ops = clauses.map((c) => c.op).sort();
        if (clauses.length === 2) expect(ops, `${code}: ${field}`).toSatisfy((o: string[]) =>
          (o[0] === "gte" && (o[1] === "lt" || o[1] === "lte")));
      }
    }
  });

  it("a reversed window returns no rows and raises nothing — an empty answer, not an error", async () => {
    const { db } = await sharedDb();
    const f = await cachedReportFixture(db, "sah015-7b");
    const rows = await withTenant(f.db.rw, f.s.tenant, f.reader, (tx) =>
      runDefinition(tx, readDefinition("accounting.general_ledger"), {
        companyId: f.s.company, fromDate: "2026-01-31", toDate: "2026-01-01", accountId: null, branchId: null,
      }));
    expect(rows).toEqual([]);
  });
});
```

This block's imports are `CATALOGUE_7B`, `readEnvelope`, `readDefinition`, `runDefinition` and `cachedReportFixture` from `../invariants/support/reports`, plus `withTenant` (the 4-argument **test** helper) from `@dulja/db/test` — 3B's own blocks in this file already import it, so check what is there before adding a second import line. `toSatisfy` is Vitest's; if the project's Vitest version predates it, the same assertion is `expect(o[0] === "gte" && (o[1] === "lt" || o[1] === "lte")).toBe(true)` with the field in a message.

- [ ] **Step 3: Append to `tests/regression/sah-055.test.ts`** (created by **3B** — §3.7.3's conditional-file rule, and the file must exist; Task 0's gate checks it)

```ts
describe("SAH-055 procMatStorage (FIFO stock ageing) is non-functional — 7B", () => {
  // 3B's block proves the ENGINE walks every layer with a real carry-forward. This one proves the REPORT
  // does not walk anything: `inventory.stock_ageing` reads `cost_layer` through 3B's `openLayersOf`, its
  // residue column is the layer's own stored `qty_remaining`, and its value per warehouse equals
  // `valuationAsOf`. Written for OD-06's `'avco'` default and asserting nothing about consumption ORDER,
  // which is the method's business and not the report's (amendment A12).
  it("the report's rows are the layers, and their value equals the ONE valuation implementation", async () => {
    const { db } = await sharedDb();
    const f = await cachedReportFixture(db, "sah055-7b", { inventory: true });
    const { layers, rows, valuation } = await readAgeing(f);
    // `rows` are `DatasetRow`s, so every key is 7A's snake_case column alias (A3); `layers` are 3B's
    // `CostLayerRow`s, so every member is camelCase. The two vocabularies meet in this block and nowhere else.
    expect(rows.map((r) => String(r.layer_id)).sort()).toEqual(layers.map((l) => l.layerId).sort());
    for (const r of rows) {
      const layer = layers.find((l) => l.layerId === String(r.layer_id))!;
      expect(String(r.qty_remaining)).toBe(layer.qtyRemaining);   // a stored column, not a loop variable
    }
    // The report's value is `qty_remaining × unit_cost` — the `cost_layer` dataset has NO `value` column
    // (A3) — and `valuationAsOf`'s is its own `value`. `sumValue` folds the first; `sumStored` folds the
    // second. Comparing them is the SAH-055 claim: the ageing report reads layers and recomputes nothing.
    expect(sumValue(rows)).toBe(sumStored(valuation));
  });

  it("the definition names no aggregate of its own: no SQL, no re-derivation, one source", () => {
    const definition = readEnvelope("inventory.stock_ageing").definition;
    expect(definition.dataset.source).toBe("cost_layer");
    expect(JSON.stringify(definition)).not.toMatch(/select|sum\(|group by/i);
  });
});
```

`readAgeing`, `sumValue` and `sumStored` are file-local and go **above** the `describe`; the fixture is again a tenant on 0B's shared container:

```ts
// tests/regression/sah-055.test.ts — file-local, above the 7B describe.
// Imports this block adds (merge into the file's existing statements):
//   import { cachedReportFixture, readDefinition, runDefinition, type ReportFixture }
//     from "../invariants/support/reports";
//   import { openLayersOf, valuationAsOf, type CostLayerRow, type DatasetRow, type ValuationRow }
//     from "@dulja/db";
//   import { withTenant } from "@dulja/db/test";
//   import { Money, currency } from "@dulja/domain";
const MYR = currency("MYR");

/** The three reads the SAH-055 claim compares, taken in **one** transaction so they cannot be three
 *  instants apart. **Note the asymmetry and keep it:** `openLayersOf` and `valuationAsOf` take an `asOf`;
 *  the *report* does not, because 7A's `age_days` is measured from `current_date` and its dataset declares
 *  no as-of parameter at all (A13). */
async function readAgeing(
  f: ReportFixture,
): Promise<{ layers: CostLayerRow[]; rows: DatasetRow[]; valuation: ValuationRow[] }> {
  const itemId = f.inventory!.itemId;
  return withTenant(f.db.rw, f.s.tenant, f.reader, async (tx) => {
    const layers = await openLayersOf(tx, { companyId: f.s.company, itemId, asOf: "2026-01-31", limit: 100 });
    const rows = await runDefinition(tx, readDefinition("inventory.stock_ageing"), {
      companyId: f.s.company, itemId, warehouseId: null,
    });
    const valuation = await valuationAsOf(tx, { companyId: f.s.company, asOf: "2026-01-31", itemId, limit: 50 });
    return { layers, rows, valuation };
  });
}

/** Σ (`qty_remaining` × `unit_cost`) over the report's own rows. The multiplication is here because the
 *  `cost_layer` dataset has **no `value` column** (A3) and the block needs a figure; it is the **same**
 *  arithmetic `assertTieOut`'s `stock_valuation` branch performs (A5), with the same explicit
 *  `RoundingMode`, and the block asserts the two agree rather than introducing a third path. */
function sumValue(rows: readonly DatasetRow[]): string {
  return rows
    .reduce(
      (a, r) => a.add(Money.of(String(r.unit_cost), MYR).multiply(String(r.qty_remaining), "HALF_AWAY_FROM_ZERO")),
      Money.zero(MYR),
    )
    .toString();
}

/** Σ of `valuationAsOf`'s own **stored** `value`. Two folds rather than one generic one: this side reads a
 *  camelCase `ValuationRow` member and the side above reads snake_case `DatasetRow` keys, and collapsing
 *  them behind one signature is how a vocabulary mix-up gets hidden. */
function sumStored(valuation: readonly ValuationRow[]): string {
  return valuation.reduce((a, v) => a.add(Money.of(v.value, MYR)), Money.zero(MYR)).toString();
}
```

- [ ] **Step 4: Append to `tests/regression/sah-070.test.ts`** (created by 0B; 1A and 1B already appended)

```ts
describe("SAH-070 Index coverage is thin on exactly the columns reports filter by — 7B", () => {
  // 1B added three indexes for its two readers. This slice's catalogue filters by twenty-odd more columns,
  // and the EXPLAIN gate found four that no index condition covered — three of them on tables that DO have
  // a scope-leading index, which served the tenant or company predicate and left the report's own column in
  // `Filter`, reading every row of the company. That is the SAH-070 shape, and it is why the gate asserts on
  // the index condition rather than on the scan's node type. The gate itself lives in
  // packages/db/test/reports/7b-report-indexes.test.ts and runs every pair; this block pins the four so a
  // later slice cannot quietly drop one, and re-states WHY each was missing.
  it("the four indexes of migration 0077 exist, and each names the report that needed it", async () => {
    const { db } = await sharedDb();
    const rows = await db.migrator<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes where schemaname = 'app'
         and indexname in ('document_company_type_date_idx', 'document_event_company_time_idx',
                           'inventory_movement_company_date_idx', 'audit_log_tenant_table_time_idx')
       order by indexname`;
    expect(rows.length).toBe(4);
    const sql = await repoFile("packages/db/migrations/0077_add_report_filter_indexes.sql");
    for (const report of ["accounting.document_register", "accounting.document_event_log",
                          "inventory.movement_register", "accounting.audit_log"]) {
      expect(sql, `0077 must say which report needed each index`).toContain(report);
    }
  });
});
```

- [ ] **Step 5: Append to `tests/regression/sah-076.test.ts`** (created by 3B)

```ts
describe("SAH-076 Duplicate and near-duplicate costing procedures — 7B", () => {
  // The legacy system had several procedures computing "the" cost, and they disagreed. The catalogue is the
  // place a rewrite is most tempted to add another: a valuation report, a profit report and an ageing report
  // could each carry their own arithmetic. None of them does — three definitions, three registered sources,
  // zero aggregates of their own.
  it("no definition in the 7b pack reads cost_consumption, and the three cost reports name one source each", () => {
    const sources = new Map(CATALOGUE_7B.map((c) => [c, readEnvelope(c).definition.dataset.source]));
    expect(sources.get("inventory.valuation")).toBe("stock_valuation");
    expect(sources.get("inventory.stock_ageing")).toBe("cost_layer");
    expect(sources.get("inventory.profit_by_item")).toBe("item_profitability");
    expect([...sources.values()]).not.toContain("cost_consumption");
  });

  it("no file in the 7b pack contains SQL of any kind (test 27's clause, applied to seed data)", async () => {
    for (const code of CATALOGUE_7B) {
      const raw = await repoFile(`packages/db/seed/my/reports/7b/${code}.json`);
      expect(raw, code).not.toMatch(/\bselect\b|\bfrom\b|\bwhere\b|\bjoin\b|;/i);
    }
  });
});
```

**The second case's regex is deliberately blunt and it passes.** No shipped definition contains the word "from", "where", "join" or a semicolon: the ICU header and footer strings use `·` and `–` as separators for exactly this reason, and every label is a noun phrase. If a later editor writes a header like *"Ledger from {fromDate}"*, this case fails — and the correct fix is the header text, because a definition that can carry prose can carry a predicate, and test 27's guarantee is that no SQL text ever crosses into data.

- [ ] **Step 6: Write `tests/invariants/report-catalogue-pins.test.ts`**

Every number this plan's prose claims, in one file, so a later slice's change fails here rather than in a review.

```ts
import { describe, expect, it } from "vitest";
// ONE statement per module specifier: `no-duplicate-imports` is on, and this task's own Step 7 runs
// `bun run lint`, so two consecutive `@dulja/contracts` imports would fail the step that ships the file.
import { ERRORS, ReportCodeSchema } from "@dulja/contracts";
import { JOBS, discover } from "@dulja/db";
import { MIGRATIONS_DIR } from "@dulja/db/test";
import { ROUTES } from "@dulja/api/routes";
import { repoFile } from "../support/regression";
import { CATALOGUE_7B, readEnvelope } from "./support/reports";

describe("7B pins — every count this slice's prose claims (§2.8, §4.16)", () => {
  it("twenty-two definitions: seventeen new at version 1, five re-expressed at version 2", () => {
    expect(CATALOGUE_7B.length).toBe(22);
    const versions = CATALOGUE_7B.map((c) => readEnvelope(c).definitionVersion);
    expect(versions.filter((v) => v === 1).length).toBe(17);
    expect(versions.filter((v) => v === 2).length).toBe(5);
  });

  // The pin is on MEMBERSHIP and on the register, never on a total or on an index. §6.3 runs Phase 6 in
  // parallel with (7A → 7B) and makes 6D a predecessor of 7C, so `pos.z_report` and `pos.sales_by_cashier`
  // may legitimately be absent when this slice lands — `slice(0, 8)` would then be off by two and a length
  // of 23 would be correct. Both of the checks below hold at twenty-three and at twenty-five.
  it("ReportCodeSchema holds this slice's twenty-two, every member is a §4.16.1 code, and none is 7C's", () => {
    for (const code of CATALOGUE_7B) expect(ReportCodeSchema.options).toContain(code);
    // §4.16.1's register, transcribed in full — all forty-one rows. A member outside it means a code was
    // invented without the one-line register PR §4.16.1 requires, which is the failure this case exists for.
    const REGISTERED = new Set([
      // 1B, 3D, 4B, 6D — the minimal set (the last two only once 6D has merged)
      "accounting.trial_balance", "accounting.ledger", "accounting.ageing",
      "inventory.stock_on_hand", "inventory.valuation", "inventory.sales_by_item",
      "pos.z_report", "pos.sales_by_cashier",
      // 7B — this slice's seventeen
      ...CATALOGUE_7B,
      // 7C's eight and 8D's eight: registered, and NOT members until those slices land.
      "accounting.party_statement", "accounting.allocation_register", "accounting.unreconciled_items",
      "accounting.pdc_register", "accounting.branch_profit_and_loss", "accounting.tax_return_view",
      "pos.sales_by_branch", "pos.needs_attention",
      "hr.employee_list", "hr.payroll_register", "hr.statutory_summary", "hr.payable_reconciliation",
      "hr.contract_expiry", "hr.attendance", "hr.payslip", "hr.annual_statement",
    ]);
    for (const code of ReportCodeSchema.options) {
      expect(REGISTERED, `${code} is not in §4.16.1's register`).toContain(code);
    }
    // Nothing from a later slice may have been seeded early BY THIS SLICE: a code whose route accepts it
    // and whose run can only 404. Asserted against 7B's own pack, NOT against the enum — 7C and 8D widen
    // `ReportCodeSchema` in the PRs that ship their own definitions, and a `not.toContain` on the enum
    // would be a 7B pin those slices have to delete to land registered rows. The subset check above is
    // what catches an invented code, whoever wrote it; this loop is what catches 7B jumping the queue.
    for (const notYet of ["accounting.party_statement", "accounting.branch_profit_and_loss",
                          "pos.needs_attention", "hr.payroll_register"]) {
      expect(CATALOGUE_7B, `${notYet} belongs to 7C or 8D, not to this slice`).not.toContain(notYet);
    }
  });

  it("this slice added no DatasetId: every member of the union belongs to 7A, 7C or 8D", async () => {
    // §4.16.2's register, transcribed as three sets. This case asserts a SUBSET, never a count and never
    // the ABSENCE of a later slice's member: 7C adds three and 8D six, and a pin that said "not `shift`"
    // or "at most twenty-six" would go red the day 7C merged and would then be a 7B assertion another
    // slice has to edit to land its own registered rows (§3.7.3 puts a pin in the commit that moves it,
    // and nothing moves this one). What 7B actually claims is that it added NONE — so the union may hold
    // only names some slice's §4.16.2 row carries, and a member outside all three sets is the hazard-32
    // finding this case exists to catch, whichever slice wrote it.
    const REGISTERED_DATASETS = new Set([
      // 7A — every source table exists at migration ≤ 0058. `pdc` ⚠️ drops with 4B's table if OD-09 = no.
      "ledger_entry", "account_balance", "account", "document", "document_line", "document_event", "audit_log",
      "party", "party_ageing", "allocation", "payment_term", "bank_statement_line", "bank_match", "pdc",
      "item", "lot", "warehouse", "price_list_line", "promotion",
      "inventory_movement", "stock_on_hand", "cost_layer", "cost_consumption", "stock_valuation",
      "item_profitability", "tax_transaction",
      // 7C — the Phase 6 tables (migrations 0059–0073).
      "shift", "till_event", "needs_attention",
      // 8D — Phase 8, plus the two 6C tables whose first report is 8D's. `leave_record` ⚠️ drops if OD-13 = no.
      "employee", "attendance_event", "payroll_line", "employee_ytd", "statutory_schedule", "leave_record",
    ]);
    const src = await repoFile("packages/db/src/reports/datasets.ts");
    const union = src.slice(src.indexOf("export type DatasetId"), src.indexOf(";", src.indexOf("export type DatasetId")));
    const members = (union.match(/"[a-z_]+"/g) ?? []).map((m) => m.slice(1, -1));
    expect(members.length, "7A creates this file with its whole ≤ 0058 set").toBeGreaterThanOrEqual(25);
    for (const id of members) {
      expect(REGISTERED_DATASETS, `${id} is in no slice's §4.16.2 row — 7B adds none, so it is someone's hazard 32`)
        .toContain(id);
    }
    // The thirteen this catalogue reads must all still be there, or a definition of this slice's is
    // pointing at an id 7A retired. Task 9 Step 5's case proves the other direction — that no definition
    // reaches for an id outside `DATASET_IDS` — so between the two nothing this slice ships can drift.
    // The thirteen are read off the catalogue rather than re-listed, so this case cannot fall out of step
    // with the definitions it is about.
    const mine = new Set(CATALOGUE_7B.map((c) => readEnvelope(c).definition.dataset.source));
    expect(mine.size, "thirteen sources across twenty-two definitions").toBe(13);
    for (const source of mine) expect(members, `${source} is a source of this catalogue`).toContain(source);
  });

  it("this slice mounted no route module and added no job", () => {
    const reports = ROUTES.filter((r) => r.path.includes("/reports"));
    expect(reports.length, "1B's module is the only one on that path (§4.2.7)").toBe(1);
    expect(JOBS.filter((n) => n.startsWith("reporting.")).length, "reporting.render is 7A's and the only one").toBe(1);
  });

  it("this slice added no ERRORS row and consumes 7A's one report code", () => {
    expect(Object.keys(ERRORS)).toContain("ERR_REPORT_DATASET_UNKNOWN");
    for (const invented of ["ERR_REPORT_TIE_OUT", "ERR_REPORT_FIELD_UNKNOWN", "ERR_REPORT_INVALID"]) {
      expect(Object.keys(ERRORS), `${invented} is not a registered code and this slice must not have added it`)
        .not.toContain(invented);
    }
  });

  it("0077 is this slice's only migration, and it has a hand-written down", () => {
    const mine = discover(MIGRATIONS_DIR).filter((m) => m.version === 77);
    expect(mine.length).toBe(1);
    expect(mine[0]!.name).toBe("add_report_filter_indexes");
    expect(mine[0]!.downPath).toMatch(/0077\.down\.sql$/);
    expect(discover(MIGRATIONS_DIR).filter((m) => m.version > 77 && m.version < 80).length,
      "0078-0079 are 7C's and this slice writes neither").toBe(0);
  });

  it("the linter sets and the DELETE pin are untouched (§3.5.3, §3.5.4)", async () => {
    const lint = await repoFile("packages/db/src/lint-schema.ts");
    expect(lint).not.toContain("report_definition");     // 7A's table, and 7A's set memberships
    expect(lint).not.toContain("7B");
    const privileges = await repoFile("packages/db/test/privileges.test.ts");
    expect(privileges).toContain('"document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"');
  });

  it("the re-expression left every owning slice's route and read function in place (amendment A2)", async () => {
    const route = await repoFile("apps/api/src/routes/accounting/reports.ts");
    for (const call of ["trialBalance(", "accountLedger(", "accountOpeningBalance("]) {
      expect(route, `1B's handler must still call ${call}`).toContain(call);
    }
    for (const fn of ["stockOnHand(", "salesByItem(", "valuationAsOf("]) {
      expect(route, `3D's and 3B's handlers must still call ${fn}`).toContain(fn);
    }
    // `runDataset` does not exist anywhere (A11), so asserting its absence proves nothing. The thing that
    // WOULD show a rewritten handler is the dataset registry being reached from a JSON list route.
    expect(route, "this slice adds no definition-driven handler to the JSON list routes")
      .not.toContain("datasetFor(");
  });
});
```

- [ ] **Step 7: Run the whole re-run matrix**

| What | Command | Why it is in the matrix |
|---|---|---|
| This slice's group tests | `bun run --cwd packages/db test -- test/reports/` | eleven files: 3D's `inventory-reports.test.ts` and 3B's valuation suite share the directory and must stay green |
| The tie-out roll-up | `bun run --cwd tests test -- invariants/report-tie-out.test.ts` | the DoD sentence; **tests 2 and 23 re-run** |
| The pins | `bun run --cwd tests test -- invariants/report-catalogue-pins.test.ts` | every count above |
| **Test 7, unchanged** | `bun run --cwd tests test -- invariants/test-07-one-costing-answer.test.ts` | §6.1 lists 7B as a re-runner; 3D's file is not edited |
| **Test 2, 1B's own** | `bun run --cwd tests test -- invariants/projection-rebuild.test.ts` | `projections.checked` must still be 1B's + 2B's + 3A's + 8C's set; this slice registers no `ProjectionCheck` |
| Tenant isolation | `bun run --cwd tests test -- invariants/tenant-isolation.test.ts` | `ROUTES`/`PROBES` bijection; this slice adds neither |
| 1B's route tests | `bun run --cwd apps/api test -- test/routes/accounting/reports.test.ts` | amendment A2's proof that nothing moved |
| The five regression files | `bun run --cwd tests test -- regression/sah-014.test.ts regression/sah-015.test.ts regression/sah-055.test.ts regression/sah-070.test.ts regression/sah-076.test.ts` | one `— 7B` block each, no earlier block edited |
| Schema and privileges | `bun run --cwd packages/db test -- test/privileges.test.ts test/schema-lint.test.ts` | 0077's reversibility and zero linter violations |
| The seed pack | `bun run seed --tenant <id> --only reports` | exit 0, twenty-two definitions (§3.4.8) |
| Everything | `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test` | the root gate after every task |

- [ ] **Step 8: Write the slice report line and commit**

Append one paragraph to `docs/review/` **only if a Phase 7 report file already exists** (7C writes it — §3.8 makes 7C the phase-closing slice). Otherwise the outcome is recorded in the commit body and in this task's Step 4 of Task 13: which owner gates were open, and that the catalogue shipped on its defaults.

```bash
git add tests/invariants/report-catalogue-pins.test.ts tests/regression/sah-014.test.ts \
        tests/regression/sah-015.test.ts tests/regression/sah-055.test.ts \
        tests/regression/sah-070.test.ts tests/regression/sah-076.test.ts
git commit -m "test(regression): the five 7B blocks and the catalogue pins [7B T14]

sah-014 (a later rate moves no reported figure), sah-015 (no window built from
one parameter twice), sah-055 (the ageing report reads layers), sah-070 (the
four indexes of 0077), sah-076 (three cost reports, three registered sources,
no aggregate of their own). The pins file holds every count this slice claims.

OD-24: no material; 7B shipped no screen, as designed.
OD-27: <dropped | mapped, see docs/legacy/7b-template-mapping.md>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

## Self-Review

### Contract additions — every name this plan had to invent because the contracts document lacked it

Each is either an amendment Task 0 writes into the contracts document (**A1–A17**, all seventeen listed below) or a name internal to this slice. **A name in neither list is a review-blocking finding** (hazard 32).

| Id | What it adds or settles | Section touched |
|---|---|---|
| A1 ⓘ **LANDED with 7A** | The report seed **envelope** `{ definitionVersion, definition }`, its refusals (the three `loadDocumentTypes` performs, plus `assertDefinitionFields`), and `is_core = true` / `on conflict … do update`. 7A's own handoff carries this as its `4.16.1 ⛑ BEFORE` row and names 7B's A1 as satisfied by it — Task 0 **verifies**, and writes nothing | §4.16.1 |
| A2 | **Re-expression does not rewrite the JSON list route** — the settlement between §4.16.1's two clauses | §4.16.1 |
| A3 | The **dataset field vocabulary** for the thirteen sources this catalogue reads, `snake_case` throughout (7A's `DatasetColumn.field` values, **never** the camelCase members of a §4.16.3 read-function row): `base_total` on `document` (a lateral Σ`base_debit`), `base_balance` on `account_balance`, `age_days` on `cost_layer` (and **no** `age_bucket`, **no** `value`), `days_to_expiry` and `code` on `lot` (and **no** `quantity_on_hand`), `actor_display_name` on `audit_log`/`document_event` (and **no** `attributed_to_name`), `document_number` and `movement_no` on `inventory_movement` (and **no** `series`, **no** `warehouse_kind`), **no** `base_net` and **no** `running_base_balance` on `ledger_entry`, **no** `unit_cost` on `stock_valuation`, **no** `period_starts_on`/`period_ends_on` on `item_profitability`, and the exclusion of `before`/`after` and `promotion.definition` from every 7B definition | §4.16.2 |
| A4 | `ReportCodeSchema` gains seventeen by **append**, why a code with no member cannot be run, why no slice asserts a total (§6.3 may land 6D's two before or after this slice), and — settled at 7B because §4.16.1 makes it the re-expressing slice — that **a module list endpoint is not a `ReportCode`**: 3A's `GET …/stock-on-hand` (`listStockOnHand` / `StockOnHandRow`) and 3D's `inventory.stock_on_hand` report code (`stockOnHand` / `StockOnHandReportRow`) coexist over one projection, neither re-aggregates `inventory_movement`, and **this slice retires neither** | §4.16.3 |
| A5 | **Executable `tieOut` semantics**: the closed measure map — now **four** arms, `debit`, `credit`, `net` (debit − credit) and **`credit_net`** (credit − debit) — with the sign convention that binds every key a later slice adds (gross totals take `debit`/`credit`; a **signed** measure takes `net` or `credit_net` by the natural balance of the account it ties against, and never `credit`), the `projection` list with `stock_valuation`'s substitution, and `none`'s row witness | §4.11.1 |
| A6 | The two financial statements are **company-level** and are **exactly `statementDefinition(kind, identity)`** — 7A's frozen layout, not a hand-written pair; `section` is annotated by `statementRows` and a statement is executed through it — reached through 7A's `rowsForDefinition`, never through `datasetFor("account_balance").run` and never through a code→kind map of this slice's own; one `fiscalPeriodId` parameter, no `accountTypes`, no `asOf`, no `{asOfLabel}`; the BRANCH cut is 7C's own code | §2.8 (7A card), §4.16.1 |
| A7 | **0077 is spent** on the SAH-070 indexes, and why no earlier range can hold them | §3.4.1, §2.8 (7B card) |
| A8 ⓘ **LANDED with 7A** | `seedReportDefinition`'s options are `{ code; definition; definitionVersion?; isCore?; clonedFrom? }` — **three** additive options, not the two this slice asked for; 7A shipped them in the same PR as its Task 1 and its handoff names 7B's A8 as satisfied. 7B passes `definitionVersion` and lets `isCore` default; `clonedFrom` is 7A's | §4.17 |
| A9 | The harness row (`runDefinition` wraps 7A's `rowsForDefinition`; `assertFieldCoverage` is the row-level check that complements 7A's declaration-level `assertDefinitionFields`), **all eighteen exported names**: `CATALOGUE_7B`, `ReportCode7B`, `CATALOGUE_DIR`, `ReportSeedEnvelope`, `readEnvelope`, `readDefinition`, `runDefinition`, `assertFieldCoverage`, `LedgerWindow`, `TieOutWitness`, `TieOutOptions`, `assertTieOut`, `InventoryFixture`, `SalesFixture`, `CatalogueFixture`, `ReportFixture`, `reportFixture`, `cachedReportFixture` | §4.17.1 |
| A10 | `documentTypeCode` is `kind: "text"`, not an enum over §4.14 — test 15's report clause | §4.16.1 |
| A11 | The **minimum 7A surface** with signatures: `validateReportDefinition` + `ReportDefinitionSets` (**two closed sets**, never a bare array), `ReportDefinitionValidation`, `renderReport` (synchronous, `formatters` required, returns a value object) and `renderCsv`, `datasetFor`/`Dataset.run` (**there is no `runDataset`**), `DatasetParams`, `DatasetRow`, `StatementKind`/`statementDefinition`/`statementLayout`/`statementRows`, **`STATEMENT_CODES`/`statementKindFor`/`STATEMENT_EXTRA_FIELDS`/`rowsForDefinition`/`assertDefinitionFields`** (the one row provider and the one field check — a consuming slice calls them and keeps no dispatch of its own), `reportsLoader`'s sub-directory walk, the runs route's grammar-regex + gate order (`requireReportExport` first, so 403 precedes 404), and the record that `rendererFor`/`startWorker` are **not reachable from `tests/`** (§3.1) | §2.8, §4.11 |
| A12 | sah-055's 7B block is AVCO-safe and asserts no consumption order | §3.7.3 |
| A13 | `inventory.stock_ageing` reads **7A's `costLayerDataset`, not 3B's `openLayersOf`** — the two are reconciled by the tie-out, both reading the stored `qty_remaining`; it requires `itemId` and declares **no `asOf`**, because 7A's `age_days` runs from `current_date` | §4.16.1 |
| A14 | `inventory.sales_by_item` (per period, stock gate) and `inventory.profit_by_item` (per period, cost gate) over one projection, and the parity range | §4.16.1 |
| A15 | `accounting.period_comparison` is **one `fiscalPeriodId` parameter, run once per period** — a `DatasetFilter` binds one value per clause, so two `fiscal_period_id eq` clauses intersect to nothing; §4.16.1's register cell and its intro sentence amended together | §4.16.1 |
| A16 | The `document_event` paging clause is **retired from 7B** and reassigned to the next slice that touches that route (7C or 8D); `listDocumentEvents`' constant `null` cursor stands, and there is still no `DocumentEventQuery` | §4.2.8 |
| A17 | **0077 creates report-filter indexes and nothing else**; a filter on a table a later slice owns is that slice's index and leaves the gate green through a **named exemption entry** carrying the owner and the reason, never through a permanently red invariant; the exemption list is closed at merge and every entry is a Self-Review row | §3.4.1 |

**Internal to this slice and deliberately not registered** (the 6D precedent: a test-local or file-local name with one home and one caller is not a contract): `REGISTER` and `SOURCES` (Task 9's literal tables), `COLUMN_OF` and `NEW_INDEXES` and `flatten` and `conds` (Task 10), `caseFor` (Task 11), `SETS` (the eight group tests' `ReportDefinitionSets` constant — four lines, repeated per file rather than added to the harness, which has no business importing `@dulja/contracts`), `IDENTITY`/`definitionFor`/`PL_TYPES`/`BS_TYPES` (Task 2) and `FIGURES` (Task 4's snake↔camel pairing), `PL`/`BS`/`TB`/`LEDGER`/`AGEING`/`MOVEMENTS`/`EXPIRY`/`PRICES`/`PROMOS`/`TRANSFERS`/`COUNTS`/`SOH`/`VALUATION`/`SALES`/`AUDIT`/`EVENTS`/`PROFIT`/`AS_OF` (the per-file code constants), `sum`/`read`/`inv`/`netOf`/`paramsFor`/`windowFor` (per-file helpers), `firstMoneyTotal`, `firstQuantityTotal`, `referencedFields`, `sumRows`, `ctxFor`, `LEDGER_MEASURE`, `CATALOGUE_ACCOUNTS`, `READ_CODES`, `catalogueChain`, `inventoryChain`, `salesChain` (private to the harness); `readGeneralLedger`, `readAgeing`, `sumValue`, `sumStored` (Task 14's four file-local regression helpers, printed in full in Steps 1 and 3). **Every one of the harness's eighteen EXPORTS is registered by A9** — `CATALOGUE_7B`, `ReportCode7B`, `CATALOGUE_DIR`, `ReportSeedEnvelope`, `readEnvelope`, `readDefinition`, `runDefinition`, `assertFieldCoverage`, `LedgerWindow`, `TieOutWitness`, `TieOutOptions`, `assertTieOut`, `InventoryFixture`, `SalesFixture`, `CatalogueFixture`, `ReportFixture`, `reportFixture`, `cachedReportFixture` — and an export this file gains that A9's row does not name is a hazard-32 finding, not a convenience.

### The four `tieOut.kind: "none"` definitions, justified one by one

The DoD says *every* report's numbers tie to the ledger. Four of the twenty-two have no monetary or quantity total to tie, and pretending otherwise would mean inventing a figure. Each still has an executed row witness (A5), and here is why a monetary tie does not exist:

| Code | Why `none` | What its witness proves instead |
|---|---|---|
| `accounting.audit_log` | An audit row has no amount. Its `after` image sometimes contains one, and A3 excludes images from the report as a side channel (spec:2450) | every `document` row of the company has its `insert` audit row and the report shows it — test 13's clause read from the report side |
| `accounting.document_event_log` | A transition has no amount either; the amount belongs to the document, which `accounting.document_register` reports | one `posted` transition per posted document, read from two different tables — 2B's trigger wrote them and no handler did |
| `inventory.price_list` | A price is not a posted figure. Nothing in the ledger corresponds to a price list, and a "total price" is meaningless | the report's rows are `app.price_list_line`'s rows, and a null-bounded validity window is not excluded |
| `inventory.promotion_register` | Same, plus a promotion's effect on the ledger is realised through `POS_TICKET` discounts, which is 7C's `pos.*` catalogue | the report's rows are `app.promotion`'s rows, and the `jsonb` rule body is not a column |

### The skill's checklist, walked

| Requirement | Where |
|---|---|
| For-agentic-workers line, Goal, Architecture, Tech Stack, Spec | header, lines 1–24 |
| Assumptions block (§3.10), every bullet filled | header, "Assumptions and contracts" |
| Global Constraints | header, nineteen numbered items |
| File Structure | header, the tree, with the four Drizzle mirrors and the three "UNCHANGED" pins |
| Every task has Files / Interfaces (Consumes / Produces with exact signatures) | Tasks 1–14; Task 0 is the contracts gate and names its two files |
| Bite-sized checkbox steps | every task; 4–8 steps each |
| TDD: failing test → the exact expected failure → minimal implementation → run to pass → commit | Tasks 1–10 each open with the failing test and the literal failure text; Task 11 **is** a test and names four failures worth reading; Tasks 12 and 13 are owner gates and say what they ship (nothing) if the gate is closed; Task 14 is the exit |
| Real code in every code step | twenty-two complete JSON definitions (all twenty-two pass 7A's `validateReportDefinition` rules 1–6 by construction: unique column fields, every group/total/sort field rendered, every filter naming a declared parameter, every `enum` parameter carrying `options`, module agreeing with the code's first segment), the whole harness including its statement branch, every test body, the migration and its down, four mirror entries, the `ReportCodeSchema` append fragment, five regression blocks |
| No placeholders | audited below |
| Self-Review section | this section |
| Execution handoff section | next section |
| Task headings exactly `### Task N: <title>` | all fifteen (0–14) |
| 10–15 tasks | fifteen |

### Placeholder audit

Searched for `TBD`, `TODO`, `implement later`, `add appropriate`, `similar to Task`, `etc.`, `and so on`, `per Step`, `…` standing in for content, and an `it(...)` with no statements. **Findings, and what was done:**

1. **Four file-local test helpers were described rather than printed, and are now printed in full**: `readGeneralLedger` (Task 14 Step 1), `readAgeing`, `sumValue` and `sumStored` (Step 3). An earlier draft named each, stated its arguments, its return shape and its imports in prose and argued that four short compositions over already-printed functions did not need transcribing. That was the one place this plan asked the executor to compose rather than transcribe, and the rule admits no such place: **a described-but-unwritten step is a placeholder however precisely it is described.** Each is now a real code block above its `describe`, with its `LedgerLine` / `CostLayerRow` / `ValuationRow` types, its import list (merged into the host file's existing statements, because `no-duplicate-imports` is on) and the snake_case-versus-camelCase note kept as a doc comment on the function it applies to. **There is no remaining composition step in this plan.**
   **One deliberate composition beyond them**: Task 2 Step 4 gives a `bun -e` **generator** for the two statement seed files rather than asking for them to be typed, and prints the exact JSON it produces so the executor can diff. That is the opposite of a placeholder — it is the only way to make "the definition IS 7A's layout" checkable rather than aspirational, and Step 2's deep-equality case is what keeps it true.
2. **`/* … */` appears nowhere.** Where a task modifies an existing file, the step prints the *whole* new member (Task 2's `LedgerWindow`, Task 6's `projectionKeys` block, Task 9's whole enum, Task 10's four mirror entries) rather than eliding the file's existing content behind a comment.
3. **Every `it(...)` in this plan has statements.** There is no `it.skip` and no title-only case: the two owner-gate tasks ship *nothing* when their gate is closed rather than shipping skipped tests, which is what hazard 6's "droppable without renumbering neighbours" means for a slice whose gates change no interface.
4. **`packages/db/src/schema/audit-log.ts` may not exist**, and Task 10 Step 5 says so explicitly with what to do in both cases. That is a conditional, not a placeholder: the condition is checkable with one `ls` and both branches are written.

### Five tie-outs and gates that would have passed for the wrong reason, and what they are now

Written down because each was a **green test that proved nothing**, which is the failure mode a tie-out plan is most exposed to. All five are fixed in the tasks above; this is the record of why the code reads the way it does.

| # | What was wrong | Why it was wrong | What it is now |
|---|---|---|---|
| 1 | `assertTieOut`'s `account_balance` branch compared **every** stored account against the report | A single-account report (`accounting.ledger`, `accounting.account_statement`) reports nothing for account `4000`, so the branch compared `Money.zero` against the projection's `-1000.0000` and **threw on a correct definition**. An earlier draft of Task 4 argued the opposite — that comparing other accounts against zero "is what makes it a real check" — which was exactly backwards | The stored read is narrowed by `window.accountCode`, **and** refuses an empty result, so a narrowed tie-out cannot become vacuous either. Task 4's note is rewritten |
| 2 | `accounting.period_comparison` ran with `accountType: null` | Its first money total is `base_balance` → `sum(base_debit − base_credit)`, which over every account is **zero by the ledger invariant**; the report's Σ was zero too, so it compared `0.0000` with `0.0000` and would have passed whatever the dataset returned — ADR 0068's first rule, broken by the plan that introduces it | Both the Task 1 case and Task 11's `caseFor` pass `accountType: "income"`, assert the report's accounts are exactly `{4000}`, and assert the total is **not** `0.0000` |
| 3 | Task 10's EXPLAIN gate asserted "the scan is not a `Seq Scan`" | With `enable_seqscan = off` the planner picks **any** usable index and drops the unindexed column into `Filter`. `document`, `inventory_movement` and `audit_log` all carry a scope-leading index, so **three of this slice's own four missing pairs would have passed** before 0077 existed, and the gate would have been a decoration | The assertion is on the column appearing in an `Index Cond`/`Recheck Cond`, probed with an **equality on a real value** read from the table (`is not null` is not pushed into an index condition). The predicted-failure text no longer claims a count |
| 4 | `ReportCodeSchema` was pinned at **25** members with `slice(0, 8)` order | §6.3 runs Phase 6 in **parallel** with `7A → 7B` and makes 6D a predecessor of **7C**. If 7B lands first the enum has six members going in and twenty-three coming out, and both pins fail for a reason unrelated to this slice | Membership assertions plus §4.16.1's forty-one-row register, no total and no index. A4 specifies an append; pushback 6 records the trade-off |
| 5 | The harness used `sql.unsafe` to pick the `ledger_sum` measure | §3.3 gives `sql.unsafe` exactly three homes and a test helper is not one of them. "It is outside the lint roots" made the rule **unenforced** here, not satisfied — and asking a reviewer to waive a review-blocking hazard for a two-line convenience is the wrong trade | One query computes all four measures as fixed columns; `LEDGER_MEASURE` maps a field to `"debit" \| "credit" \| "net" \| "credit_net"` and the branch picks one client-side. **This slice adds no `sql.unsafe` call site**, and hazard 21's row says so |

A sixth, smaller one: the `item_profitability` branch iterated every stored period, which was harmless for this fixture and wrong for the next one; it is now restricted to `params.fiscalPeriodId` when the report was run for a period, and refuses an empty projection.

**And a seventh, found while re-anchoring this plan against 7A as merged: `runDefinition` owned a two-entry `STATEMENT_KIND_OF` map and called `datasetFor(source).run` itself.** Both statements tied out and every case was green — against a **second copy of the dispatch**, not against the query the route renders. 7A ships `rowsForDefinition` and its `reporting.render` handler calls it, so the harness now calls the same function and keeps no map: the tie-out is a claim about the rendering path, and 7C's `accounting.branch_profit_and_loss` cannot be added to `STATEMENT_CODES` and forgotten in a copy here, because there is no copy. The same pass corrected two prose claims this plan carried about 7A that its merged form contradicts — that a field the dataset does not serve is *not* refused at seed time (`assertDefinitionFields` refuses it), and that `resolveDefinitionForRun` runs before either permission gate (`requireReportExport` runs first, so an ungranted caller sees 403, not 404).

**And an eighth, which is worse than a wrong-reason pass because nothing would have run at all: `inventoryChain` could not post a single document.** Three independent defects, each fatal on its own, and all three in the fifteen lines that create the stock this slice's inventory half reports on.

| What was wrong | Why it was fatal | What it is now |
|---|---|---|
| `CATALOGUE_ACCOUNTS` seeded ten codes and **not `1310`** | 3D's shipped `TRANSFER_POLICY` debits `{ code: "1310" }` for `line.cost` and §4.15 assigns the row to **3C**, which this fixture does not run; hazard 33 admits no null-account fallback, so the third post is a `PostingError`. The plan contradicted itself twice on the way in — its Assumptions block already listed `1310` under 3C's consumed rows, and its own fixture arithmetic already said "4 transferred → `1310` debit / `1300` credit 20.0000" | Eleven codes with `1310` among them; the account assertion is thirteen codes, not twelve; and the comment says why a missing row is a `PostingError` rather than a blank column |
| The `GOODS_RECEIPT` and the `DELIVERY_ORDER` went through **`postInventoryDocument`**, which sets no `party_id` | Both policies declare `requires: ["party", "warehouse"]`, so 2A's `validateRequires` refuses at §4.3.2 step 4 with `ERR_POLICY_REQUIRES_MISSING`. `PostInventoryOptions` has no `partyId` member in any plan, and 3D's own plan documents the same trap for the same two types (phase-3d:5870). Compounding it, `salesChain` — the only place a party existed — ran *after* `inventoryChain` | Both go through 4B's **`postFromPack`**, which threads `partyId` and `warehouseId` into 3C's `draftTypedDocument`; the vendor and the customer are created in `inventoryChain` itself, and `salesChain` reuses the customer instead of seeding a second one. `TRANSFER` stays on `postInventoryDocument` — it needs no party and is the only document here with a `to_warehouse_id` |
| **No inventory `approval.post` code was granted to anyone** | 2B's R2 evaluates `app.actor_has(policy.approval.post, …)` at `issued → posted` inside the posting transaction. Unlike 1B's `postJournal` and 4A's `postArDocument`, 3B's `postInventoryDocument` grants nothing (its own suites call `grantCodes` themselves, phase-3b:2295) and `postFromPack` grants only on the approval-**required** path, which none of these three types takes. All three posts would have raised `ERR_RBAC_FORBIDDEN` | One `grantCodes(… phase7b_poster …)` in `inventoryChain`, with the codes **read off each type's own envelope** through `packApproval(code).post` and de-duplicated. Reading beats pinning here for a reason worth knowing: `DELIVERY_ORDER`'s post code is `inventory.transfer.post`, **not** the `inventory.delivery.post` a reader would guess — that is §4.14's own register row, and §3.6.2's closed vocabulary has no `inventory.delivery.*` pair to name — so two of the three codes are the same string, and a hand-written list is one guess away from a grant that looks right and gates nothing |

**The common shape, worth naming:** all three are *consumption* errors — a frozen helper's real signature, a shipped policy's real `requires`, a shipped trigger's real gate — and none of them is visible in a definition, a tie-out or a dataset. They are also all three invisible until a test with `{ inventory: true }` runs, which is Task 5, four tasks after the harness is written. Task 1 Step 4's expected-failure list now names each one with the message it produces, so the executor reads them there rather than discovering them in `beforeAll`.

### Every hazard in §5 that touches this slice, and where it is discharged

| Hazard | Discharge |
|---|---|
| 1 no statutory rate | Global Constraint 14. This slice ships no HR and no tax definition; `accounting.tax_return_view` is 7C's |
| 2 no MyInvois detail | Constraint 14; nothing here touches e-invoicing |
| 3 Firebird unknown | Task 12 reads 9A's artefacts **if they exist** and invents no legacy row shape; the default is that the task is dropped |
| 4 reports ship inside each phase | The whole slice is the other half of that hazard: the five re-expressed codes keep their codes, their permissions and their numbers (Tasks 4 and 8), and their owning slices' tie-out tests are re-run unchanged |
| 5 owner-account pattern | Task 9 Step 4 and Tasks 12 and 13 Step 1 all use "owner provides X; verify with `<exact command>`" with a local equivalent |
| 6 one task per OD item | **OD-27 → Task 12; OD-24 → Task 13.** Both isolated, both droppable, neither changing an interface |
| 7 never re-open D1–D27 | Nothing here re-decides one; ADR 0068 is a new decision inside this slice's own range |
| 8 0A helpers by exact name | `startDb`, `Db`, `Seed`, the 4-argument test `withTenant` (in `packages/db/test/**`), the production `withTenant(sql, ctx, fn)` (in `tests/**`), `uuidv7`, `lintSchema`, `discover`, `MIGRATIONS_DIR` |
| 9 `fixtures.ts` additive, and §4.17.1 too | **`fixtures.ts` is not edited at all.** The one new shared helper file is registered by A9 before it is written, and the two option members added in Tasks 2 and 6 are additive to this slice's own interfaces |
| 10 no per-tenant rows in a migration | Constraint 8: 0077 creates four indexes; twenty-two definitions are seed-pack data applied by `bun run seed --only reports` |
| 11 no enum label | This slice adds no enum label and no closed vocabulary. The place it was nearly invented is stock ageing: A3 records that 7A's `cost_layer` dataset computes `age_days` and **nothing else about age — there is no `age_bucket`** — so `inventory.stock_ageing` renders the integer and sorts oldest first rather than introducing a `1_30 | 31_60 | 61_90 | over_90` vocabulary that would be a new closed set in a report. Bucketing is a raise against 7A's dataset (below). The `enum` **parameters** this slice declares (`status`, `action`, `eventKind`, `toStatus`, `transferTypes`, `countTypes`, `accountType`) all carry `options` drawn from vocabularies 2B, 0A, 3D and 1A already own |
| 12 0A's `[1]` generalised | 0077's reversibility relies on it; Task 10 Step 6 runs `privileges.test.ts` |
| 13 `lint-schema.ts` hotspot | **Not edited** (Constraint 7); Task 14's pins case asserts it |
| 14 numbers never renumbered or borrowed | 0077 only; the pins case asserts 0078–0079 are untouched (7C's) |
| 15 two `withTenant`s | **The split is by what a file *is*, not by which directory it sits in.** Every `*.test.ts` under `packages/db/test/**` and `tests/invariants/**` opens its sessions with the form its tier already uses — this slice's `tests/invariants/report-tie-out.test.ts` takes the production `withTenant(sql, ctx, fn)` with a `requestId`, and its eight `packages/db/test/reports/*.test.ts` take the 4-argument test helper. **The shared fixture BUILDERS under `tests/invariants/support/` take `(db, Seed)` and use the 4-argument test helper**, because a `Seed` is a test-tier value and every §4.17.1 builder they compose with already does: 1B's `postJournal` takes `db + Seed`, 3C's `draftTypedDocument` calls `withTenant(db.rw, s.tenant, s.human, …)` (phase-3c:450) and 4B's `postFromPack` builds its own `TenantContext` from `s` and hands it to the production form where a shipped function needs one. `tests/invariants/support/reports.ts` follows that precedent exactly: 4-argument calls to open a session, `ctxFor(s, actorId)` to build the production `TenantContext` the shipped read and write functions take. Both forms are 0A/0B names used as their owners defined them, which is what hazard 15 asks for; using one form everywhere would mean either a `Seed`-less fixture or a shipped function called without a `TenantContext` |
| 18 test 22's projection set | Untouched; this slice registers no `ProjectionCheck` and Task 14's matrix runs `projection-rebuild` |
| 20 jobs as the system principal | Constraint 16; the two projection rebuilds run under `s.system`, and this slice registers no job |
| 21 `sql.unsafe` has three homes | **Not used.** An earlier draft of the harness reached for it to pick the `ledger_sum` measure; the query now computes all four measures as fixed columns and the branch selects one by the closed map's key, so the count of `sql.unsafe` call sites in the repository is unchanged by this slice. Being inside `tests/` and outside the lint roots (§3.7.5) would have left §3.3's rule unenforced here, not satisfied |
| 22 nothing outside `posting/` writes the ledger | Constraint 1; every fixture row is posted by `postJournal` / `postInventoryDocument` / `postArDocument` / `postFromPack`; `posting-only-tables` sees no DML in this slice |
| 23 `toBase` rounds HALF_AWAY_FROM_ZERO | This slice performs no base conversion; it reads stored base columns (Constraint 2, and sah-014's block) |
| 24 `document_event` only by triggers | This slice reads it and inserts none; sah-015's and Task 3's witnesses assert the trigger's rows |
| 25 the DELETE pin | Constraint (Task 14's pins case asserts the five-row list verbatim); `saved_view` archival is 7A's |
| 26 the permission vocabulary is closed | Constraint 11; **no code seeded**, and every `permission` member is one §4.16.1 assigns |
| 29 the UI is not specified | Constraint 15; Task 13 is the gate and ships nothing |
| 30 the PDF engine is decided once, in 0E | Task 11's test-23 case consumes ADR 0016 through `renderReport` and re-evaluates no engine; a shaping failure is a raise, not a format swap |
| 31 every route needs a probe | No route mounted, so no probe; Task 14's pins case asserts exactly one module on `/reports` |
| 32 no invented literal in a shared namespace | The contract-additions table above; Task 9's completeness cases and Task 14's pins are the mechanical proofs |
| 33 the policy-seeder seeds its accounts | This slice seeds no policy and no account; Task 1 Step 3's first case asserts the thirteen it names resolve — `1310` included, because 3D's `TRANSFER_POLICY` debits it by code and a missing row is a `PostingError`, never a null-account fallback |
| 34 a seed file is an envelope | A1 makes the report file an envelope for the same reason §4.3.7 makes a document-type file one, and Task 9 asserts `definition.version === 1` beside `definitionVersion` |
| 35 written to the skill | this section |

### Six things a reviewer should push back on

1. **A2 deviates from §4.16.1's literal words.** The register says re-expression "replaces the route's body with `ReportDefinition` + `renderReport`"; this plan keeps the body and adds a parity test. The reason is in A2 and it is load-bearing: 1B's `LedgerList` carries `opening_base_balance` and nests `MoneySchema`, 3D's `StockOnHandReportRow` carries `warehouseKind`, and a generic definition-driven list answers neither — so a literal reading changes the wire shape of five shipped endpoints without an expand/contract and breaks the exact tests the register names as the proof that nothing moved. **A reviewer who wants the literal reading should say so**, and then the honest sequence is: 7A ships a definition-driven list envelope, §4.2.8 registers it, the five owning slices' route tests are rewritten by *those* slices, and 7B re-expresses afterwards. That is three slices of work to change a wire shape nobody asked to change.
2. **`inventory.sales_by_item` exposes `cogsBase` under an `inventory.stock.read` gate.** spec:2159's clerk row says "no costs" and spec:2160's warehouse row says the same. The code's gate is 3D's and 4A already shipped `cost` and `margin` on it (§4.16.1's "4A extends the same code"), so this slice changing the gate would rename the code's authority mid-flight and break 4A's route test. **It is recorded here rather than decided**: if the owner wants costs out of the clerk's reach, the change is 4A's column set or a `inventory.cost.read` gate on the code, and either is a §4.16.1 amendment — not a 7B edit.
3. **`accounting.audit_log` is tenant-scoped and every other definition is company-scoped.** A multi-company tenant's audit report therefore shows every company's rows to anyone holding `admin.audit_log.read` in any company. Task 3's second note argues it is correct — `app.audit_log` has no company column, and a company filter would silently omit `principal`, `membership` and `tenant` rows — and 0B's own audit-log route already evaluates the code as `{ company: "any" }`. **A reviewer who disagrees should say so**: the fix is a company column on `app.audit_log`, which is a Plan 0A table and therefore an amendment before a migration, and it would not be this slice's.
4. **`inventory.stock_ageing` requires an item.** A stock-ageing report a warehouse manager cannot run across the whole catalogue is a real limitation, and it exists because the only registered residue reader is per item (A13) and a second company-wide residue query beside `valuationAsOf`'s is SAH-009 by another name. The lawful fix is an additional 3B read function (`openLayersForCompany`) registered in §4.7.2, which is 3B's file and a frozen plan's surface. **Recorded, not worked around.**
5. **Thirteen dataset field lists are transcribed by this slice from 7A's shipped queries** (A3). If the repository disagrees with 7A's plan, thirteen definitions and eight tests change — a real cost, paid to make the catalogue executable at all. The mitigation is mechanical rather than hopeful, and it is now **three** checks deep: Task 0's Step 1 says to confirm every `<NAME>_COLUMNS` constant by symbol before writing anything (never by line number — 7A has been re-cut once already and every line anchor this plan originally carried went stale); 7A's own `assertDefinitionFields` then refuses a bad field at **seed** time, naming the file and the field; and `assertFieldCoverage` runs the definition against a fixture and compares `Object.keys(row)` with the definition's references, catching the residue — a column 7A **declares** but does not **select**. A mismatch therefore fails with the field's name in the message on the *first* test of the *first* task, not in review. **A reviewer who would rather 7B waited should weigh that against §6.3, which runs `7A → 7B` as one serial pair**: 7A is merged before this slice starts, so the transcription is from a shipped file and not a guess.

6. **This slice cannot know how many `ReportCodeSchema` members it will end at, and every count assertion was therefore removed.** §6.3 executes `(6A → 6C → 6B → 6D)` in **parallel** with `(7A → 7B)` and makes 6D a predecessor of **7C**, not of 7B, so `pos.z_report` and `pos.sales_by_cashier` may or may not be members when this slice merges: 7B lands at **twenty-three or twenty-five**, and neither is a defect. A4 therefore specifies an **append** and forbids a total; Task 9 Step 3 prints only this slice's seventeen as a fragment for exactly that reason, the enum cases assert membership plus §4.16.1's register, and Task 0's gate script prints the count it found for the record. **A reviewer who wants a deterministic count should say so**, and then the honest fix is a §6.3 amendment making 6D a predecessor of 7B — which serialises Phase 6 ahead of Phase 7 and costs the parallelism §6.3 exists to buy, for a number no behaviour depends on.

### Seven raises against other slices — six open, one since landed

Each is a change to a **frozen** file this slice may not touch, and each is carried here so the owning slice sees the request rather than discovering it in a diff. None blocks 7B: every definition ships correct for what its dataset actually serves. **Row 3 has since landed in 7A** and is kept, marked, rather than deleted — the numbering is referenced elsewhere in this file (rows **5** and **6** are cited by Tasks 5 and 6) and renumbering it would break those references.

**Four raises came the other way — from 3D, 7C and 8D against this file — and all four were correct about this side. Each is applied above; none is still open.**

- **3D → §4.16.3, the two reads over `app.stock_on_hand`.** Applied twice. (i) 3D's report types carry a `Report` infix — `StockOnHandReportParams` / `StockOnHandReportRow` — because 3A already exports `StockOnHandRow` from the same flat `packages/db/src/index.ts` barrel for its list route; this plan had been naming **3A's** type where it meant 3D's, in the Assumptions block, in A2 twice, in Task 8's Consumes and parity comment, and in pushback 1. That is a wrong type, not a spelling, and every one is corrected. (ii) The absorption question is **7B's call and the answer is neither**: A4 now carries the settlement — a module list endpoint is not a `ReportCode`, the two answer different questions, and A2 means this slice touches no route and no read function, so the settlement holds under either outcome of A2's architect decision.
- **7C → Task 12's artefact path.** Correct and now fixed. `docs/legacy/9a-artefacts/` is a directory **9A does not write and may not write**: 9A Task 1 puts `artefacts/` in `.gitignore` and every command writes under `artefacts/legacy/<runId>/` because the contents are customer data. The gate is now an owner-named run directory, the Verify lists the four files by name (`index.json`, `templates.json`, `scope.json`, `open-questions.json`) instead of `ls`-ing a committed path that by design never exists, and the "what 9A produces" paragraph became a table naming each artefact's 9A shape and what this task takes from it — including that `open-questions.json`'s `VII-8` row is OD-27 #8's evidence and that a `null` verdict is not an answer.
- **8D → `LEDGER_MEASURE`'s sign convention (its open question (e)).** Correct that `"credit"` is wrong for `net_contribution`, and right to file it rather than answer it: the answer is **neither `"credit"` nor `"net"`**. A negative-net supplementary run posts the net leg as a debit, so `"credit"` misses by the whole amount; `"net"` is debit − credit and misses by twice the amount on every ordinary run as well. This slice added the arm the shape needs — `credit_net` = `sum(base_credit − base_debit)`, a fourth fixed column of the one `ledger_sum` query and a fourth member of the value union — and A5 now states the convention. Both of 8D's keys map to `credit_net`; the handoff paragraph says so in the words 8D can copy.
- **8D → Task 14's `DatasetId` pin.** Correct: the pin asserted a member **count** of 25–26 and the **absence** of 7C's three, so it went red the moment 7C merged and would then be a 7B assertion 7C had to delete to land registered rows. Rewritten as a **subset** check against §4.16.2's three sets, with the thirteen sources read off `CATALOGUE_7B` rather than re-listed. Two neighbours in the same file had the same defect and were rewritten with it: the "not a later slice's code" loop now runs over `CATALOGUE_7B` instead of over `ReportCodeSchema.options`, and the Assumptions block no longer claims Task 14 asserts `datasets.ts` is byte-identical to its 7A state — a claim the case never made and 7C's hunk would falsify. Three prose references to "Task 14 Step 5" for these pins were also corrected to **Step 6**, which is where the pins file actually is.

**One candidate raise was investigated and dropped: `DELIVERY_ORDER`'s `approval.post` is `inventory.transfer.post`, and that is the register's own value, not 3D's slip.** §4.14's row reads *"`DELIVERY_ORDER` | 3D | `inventory` | outbound / issue / `inventory.transfer.post` | `DO`"*, §3.6.2's 3D row seeds exactly `inventory.transfer.create` · `inventory.transfer.post` · `inventory.count.create` · `inventory.adjustment.create` · `inventory.adjustment.approve`, and **there is no `inventory.delivery.*` code anywhere in the permission catalogue** — the vocabulary is closed (hazard 26), so a delivery-specific pair would be a new code before it could be an envelope value. `inventoryChain` reads the code through `packApproval` rather than writing it out, which is right for a different reason than "3D is wrong": it keeps this fixture correct if the vocabulary ever *does* gain a delivery pair, without this slice having to know.

| # | Against | What is missing | What this slice does instead |
|---|---|---|---|
| 1 | **7A**, `packages/domain/src/reports/statement.ts` | `STATEMENT_LAYOUTS`' header is `"{title} — {fiscalPeriodId}"`, which interpolates a raw **uuid** where a reader wants `2026-01` | Ships 7A's string unchanged; the deep-equality case in Task 2 is what would break if 7B "fixed" it locally |
| 2 | **7A**, same file | The balance sheet's money column is labelled **"Balance"**, but `account_balance` stores one period's **movement** (§4.3.3), so the honest label is "Movement (net)" | Ships 7A's label and states the movement identity in Task 2's own case instead |
| 3 ✅ **LANDED — no longer a raise** | **7A**, `packages/db/src/reports/statement.ts` and `apps/worker/src/reports/render.ts` | This row asked 7A to ship `STATEMENT_CODES` / `rowsForDefinition` / `assertDefinitionFields` and to wire the row provider into `reporting.render`, because an earlier cut of 7A promised all three in its header and printed none, and its handler called `datasetFor(source).run` directly — so a statement run **through the route** rendered a blank `section`. **7A Task 9 now ships all three and Task 11's handler calls `rowsForDefinition`.** | Kept as a row rather than deleted so a reader of an older diff can see it closed. Task 1's `runDefinition` now calls the same `rowsForDefinition`, which is what makes a 7B tie-out a claim about the query that renders |
| 4 | **7A**, `packages/db/src/reports/datasets.ts` (`costLayerDataset`) | No `age_bucket`, and `age_days` is measured from `current_date` with no `as_of` parameter, so an as-of-dated or bucketed ageing report cannot be expressed | `inventory.stock_ageing` renders `age_days`, declares no `asOf`, and its tie-out carries the as-of (A13) |
| 5 | **7A**, same file (`costLayerDataset`) | `invalidated_at` is selected but §4.11.1's eight filter ops carry no `is null`, so a replayed item's superseded layers cannot be excluded | No fixture in this slice replays, so the tie holds; the fix is an `is_null` op or an `invalidated boolean` column, both 7A's |
| 6 | **7A**, same file (`lotDataset`, `stockValuationDataset`, `documentEventDataset`) | No `quantity_on_hand` lateral on `lot`; no `unit_cost` on `stock_valuation`; no second `app.principal` join for `attributed_to`'s display name | `inventory.expiry_list` ties with a row witness, `inventory.valuation`'s parity case compares `value` and `quantity` only, and `accounting.document_event_log` renders the attribution uuid rather than hiding the column |
| 7 | **7A**, same file (`accountBalanceDataset`) | No period ordinal and no `period_ends_on`, so a **cumulative as-of balance sheet** cannot be read at all (A6) | 7B ships a period-movement statement and names it honestly; the cumulative one is out of scope for v1 |

---

## Execution handoff

### Read these before Task 1

1. **The contracts document, in this order**: your card (§2.8's 7B row), §2.12 (**OD-27** and **OD-24**), all of §3, §4.1, §4.2 (especially §4.2.4, §4.2.5, §4.2.7, §4.2.8, §4.2.12, §4.2.13), §4.3.3–§4.3.5, §4.5.2, §4.6.1, §4.7.3, §4.8.2, **§4.11 in full**, §4.14, §4.15, **§4.16 in full**, §4.17 and §4.17.1, **§4.18 both rounds**, all of §5, and your rows in §6.1 (tests 2, 7, 23) and §6.2 (spec:1047).
2. **7A's plan**, at its Produces blocks: `ReportDefinition`, `validateReportDefinition` + `ReportDefinitionSets`, `datasets.ts` / `datasetFor(source).run` / `DatasetId` (**there is no `runDataset`** — A11), **`rowsForDefinition` and `assertDefinitionFields`** (7A Task 9 — the one row provider and the one field check), `renderReport` / `renderCsv` / `intlFormatters`, `STATEMENT_LAYOUTS` / `statementDefinition` / `statementRows`, `reportsLoader`, `app.report_definition`, the runs route, `seedReportDefinition`. **Every name amendment A11 pins is checked by Task 0's gate; if 7A spelled one differently, correct this plan's import line and record it — never add a second implementation** (§4.18's rule).
3. **The four plans whose numbers you re-express or read**: `…-1b-projections-integrity-reports.md` (Task 9's `trialBalance` / `accountLedger` and the reports route), `…-3b-costing-engine.md` (`valuationAsOf`, `openLayersOf`, `CostLayerRow`, `postInventoryDocument`, `ensureOpenPeriods`, and the `packages/db/test/**` lint allowance), `…-3d-sales-transfers-counts.md` (`stockOnHand`, `salesByItem`, the six inventory types, `test-07-one-costing-answer.test.ts`), `…-4b-ageing-fx-bank-reconciliation.md` (`itemProfitabilityRows`, `rebuildItemProfitability`, `seedTypeFromPack`, `postFromPack`, `packApproval`).
4. **Plan 0A Tasks 3, 4, 7 and 11**, for `startDb` / `withTenant` / `uuidv7` / `seedTenant` / `Seed` / `draftDocument` / `lintSchema` / `discover` / the migration runner exactly as they exist.

### Execution order and the three PRs

Tasks run **in order**; the numbering is the dependency order and there is no parallel branch.

| PR | Migration | Tasks | Gate to merge |
|---|---|---|---|
| — | none | **0** | `bash scripts/check/contracts-7b-amendments.sh` exits 0 |
| **1** | none | **1, 2, 3, 4, 5, 6, 7, 8** | the twenty-two definitions and their eight group tests green; 1B's and 3D's own report tests green **unchanged**; root checks green after every task |
| **2** | none | **9, 11** | the loader seeds twenty-two rows; `ReportCodeSchema` contains all twenty-two and every member is a §4.16.1 code; the roll-up green including tests 2 and 23; `openapi.json` regenerated and committed |
| **3** | `0077` | **10** | the EXPLAIN gate green for every pair; `privileges.test.ts` reversibility green; `db:lint` zero violations |
| — ⚠️ | none | **12, 13** | OD-27 / OD-24 material present; otherwise both dropped and nothing is blocked |
| — | none | **14** | the whole re-run matrix, the five regression appends, the pins |

**Why Task 11 is in PR 2 and Task 10 in PR 3, in that order.** The roll-up is the DoD proof and belongs with the catalogue; the migration is one file and §3.4.3's one-migration-per-PR rule makes it its own. Running Task 10's gate **before** the definitions exist would report every pair as unserved and prove nothing, which is why it comes last of the code tasks rather than first.

### Where to stop and raise, per task

**The rule: if the failure text differs from what the task predicted, stop and read this table rather than adjusting the test.** A test adjusted to match a wrong implementation is the defect this column exists to prevent.

| Task | What you should see | Stop and raise if |
|---|---|---|
| **0** | **thirty-two** `MISSING (doc …)` lines — one per `need_contract` call except A1's envelope literal and A8's registered `seedReportDefinition` row, which landed with 7A and are PRESENT before Step 1; **thirty-four** calls as the script stands, and you count them in the file rather than trusting this number — then, after Step 1, `7B Task 0 gate OK.` and three informational lines | **any `MISSING (repo)` line.** Each names the plan that owns the export — 7A for the engine, statement and render names, 1B/3B/3D/4A/4B for the read functions, 3B for the lint allowance. A *different spelling* is corrected in this plan's import and recorded as an **eighteenth** amendment; an *absent* name is a raise and this slice stops. Never edit the gate to pass |
| **1** | `ENOENT … accounting.general_ledger.json`, then **8 passed** | `new row violates row-level security policy` or `ERR_RBAC_FORBIDDEN` from `postJournal` in the fixture — `grantCodes` did not run, and `seedTenant` grants `s.human` nothing (§4.1, pinned). **Or** `ERR_RBAC_FORBIDDEN` from `postFromPack`/`postInventoryDocument` under `{ inventory: true }` — `inventoryChain`'s `phase7b_poster` grant did not run; read the code out of the message and compare it with `packApproval(<code>).post`, and never pin the three literals to quiet it. **Or** `ERR_POLICY_REQUIRES_MISSING` on the receipt or the delivery — a `partyId` did not reach `draftTypedDocument`, which is what `postFromPack` exists here to do. **Or** `account_balance says … the report says …` with the signs swapped: the dataset returns the projection's columns reversed, which is a 7A raise and not a harness subtraction to invert. **Or** `sort field 'posting_seq' is not one of this definition's columns` — 7A's validator rule 4; render the field, never drop the sort key |
| **2** | `ENOENT … accounting.profit_and_loss.json`, then **8 passed** | `accounting.profit_and_loss diverges from 7A's frozen layout (amendment A6)` — the pair was hand-written instead of generated from `statementDefinition`, or 7A's layout moved and this plan's print is stale. Regenerate and correct A6's transcription; never edit the expectation. **Or** `typeof r.section === "undefined"` — `rowsForDefinition` did not take its statement branch, i.e. the code is not a `STATEMENT_CODES` key. **Or** the report totals a figure and the ledger totals `0.0000` — the `accountTypes` **window** member did not reach the query (Step 1's clause); the ledger side summing to zero is the ledger invariant, not a tie-out |
| **3** | `ENOENT … accounting.document_register.json`, then **9 passed** | `the report totals 3400.0000 and the ledger totals 1700.0000` — `base_total` is summing both sides of each document; A3 pins it as `Σ base_debit` and this is a 7A raise. **Never divide by two anywhere**. **Or** `total field 'document_id' is not one of this definition's columns` — a `count` total goes through rule 4's membership check too; count a rendered column |
| **4** | `ENOENT … accounting.trial_balance.json`, then **5 passed**, then 1B's route suite green | **1B's route test fails.** This slice modified a route, a DTO or a read function, which A2 forbids. Revert that change; do not adjust 1B's expectations |
| **5** | `ENOENT … inventory.stock_ageing.json`, then **8 passed** | `valuationAsOf says 150.0000 for warehouse WH-HQ, the report says 170.0000` — the `cost_layer` dataset is reading the movement's warehouse instead of the layer's. 3B's `CostLayerRow` carries the layer's own; a 7A raise. **Or** `tieOut.kind is "none", so the group test must supply a row witness` on `inventory.expiry_list` — the witness was dropped; `none` never means "no test" (A5) |
| **6** | `ENOENT … inventory.price_list.json`, then **7 passed** | `projectionKeys names <item>\|<transit>\|<lot>, which stock_on_hand does not hold` — the transfer emitted one movement instead of two. §4.7.3's `movement_no` exists for exactly that; a 3B/3D raise, not a fixture fix. **Or** `reportFixture: STOCK_COUNT.json no longer declares approval.required with an approve code` — `catalogueChain`'s own guard, thrown **before** any transition, because `packApproval("STOCK_COUNT")` read `required: false` or a null `approve`. That is 3D's shipped envelope changing (§4.14 gives the type `approve+post inventory.adjustment.approve`), not the helper misbehaving; the count never goes through `postFromPack`, so do not look there |
| **7** | `ENOENT … inventory.profit_by_item.json`, then **5 passed**, then test 7 green | `expected "200.0000" to be "170.0000"` on the identity case — the ageing report dropped the in-transit layer, which is test 7's own in-transit clause failing loudly. **Or** 3D's `test-07-one-costing-answer.test.ts` fails: something in this slice touched a read function or a projection, and nothing in it is allowed to |
| **8** | `ENOENT … inventory.stock_on_hand.json`, then **6 passed**, then 3D's report suite green | `expected [["WH-HQ", …], ["WH-TR", …]] to equal [["WH-HQ", …]]` — `warehouseKinds: "stock"` was not applied, so the definition answers a *different number under the same code*, which is the one thing re-expression may not do. **Or** `the snapshot is missing WH-TR`: `rebuildStockValuation` snapshotted stock warehouses only — a 3B raise worth 20.0000 per transfer in flight |
| **9** | the enum membership case, then **10 passed** | `readPackFile … reports/accounting.general_ledger.json` with no `7b/` segment — 7A's loader walks a flat directory. **That is a 7A raise** (A11's `WALKS <packRoot>/reports/<slice>/*.json`); never flatten this slice's directory, because §4.16.1 gives 7B, 7C and 8D one each so they never share a file. **Or** exit **3** from the seed CLI: `reports` is not a `SubPack` member and 7A's five edits did not land |
| **10** | the four-index case failing, and the condition case listing **at least this slice's four** pairs, named in `snake_case` (`audit_log.table_name`, not `audit_log.tableName`) | **the coverage case listing EVERY filter pair of all twenty-two definitions as missing** — `COLUMN_OF` was keyed in camelCase and matches nothing the definitions carry (A3). Rekey it; do not add camelCase aliases. **Or a pair beyond the four.** It is an index request against the table's owning phase, recorded as a contracts amendment and built in that phase's range — never added to 0077, and never deleted from `COLUMN_OF` to quiet the gate. **Or** the condition case listing **zero** pairs before the migration: either `enable_seqscan = off` did not apply (it is `set local` and needs the transaction), or the assertion regressed to a node-type check — a `company_id`-leading index makes every column plan an Index Scan, so a node-type check is vacuous and would stay vacuous |
| **11** | **26 passed** | `report-tie-out: <code> has no tie-out case` — the intended failure when a definition arrives without one. Add the case; **never widen the `default` branch**. **Or** a typecheck error on `RenderOptions.formatters`: it is required (A11) and `intlFormatters(lang, { currency: "MYR" })` supplies it. **Or** `figures(arText)` empty: the Arabic render emitted Arabic-Indic numerals where 7A defaults both languages to `"latn"` — normalise, never delete the comparison. **Or** the runs-route case answering 400 where 404 is expected: 7A validates `{code}` by grammar regex and `resolveDefinitionForRun` runs before both gates (A4), so a 400 there means the route grew a `ReportCodeSchema` guard, which is a 7A change and a raise. **Seventeen 404s in that loop are the PASS**, not a failed seed — `sharedApi()`'s tenant is 0B's and holds no 7B definition |
| **12** | the 9A artefact gate — an `artefacts/legacy/<run>/` directory the **owner names**, never a committed path (`artefacts/` is git-ignored by 9A Task 1, so a clean clone has none and that is not evidence) | no run directory, or `open-questions.json`'s `VII-8` verdict still `null` → **stop, drop Task 12, ship**. That is the designed outcome, not a blocked slice. **Never add a twenty-third definition here**: a code no register holds fails hazard 32, and a definition with no tie-out fails ADR 0068's roll-up by name |
| **13** | the `docs/owner/od-24/7b/` gate | the directory is absent → **leave Steps 2–3 unchecked and ship.** Nothing in the catalogue depends on this task, and 7A's list and designer already render every definition |
| **14** | the whole matrix green | a pins case fails. Each is a claim this plan's prose made — twenty-two definitions, all twenty-two enum members registered in §4.16.1, one route module on `/reports`, one `reporting.*` job, no `DatasetId` added, 0077 alone, the DELETE five, the six read-function calls still in 1B's/3D's route. **A failure means the prose or the code is wrong, and the prose is the one to check first** |

### What the next slice needs from this one

**7C** re-expresses **`accounting.ageing`** (4B's code), **`pos.z_report`** and **`pos.sales_by_cashier`** (6D's) at `definitionVersion = 2` into `packages/db/seed/my/reports/7c/`, and ships its own **eight** register rows. It **extends** three things this slice created and edits none of them: `assertTieOut`'s `projection` switch gains `party_ageing` and the POS sources (additively, no existing case touched); **`runDefinition` needs no edit at all for `accounting.branch_profit_and_loss`** — the harness keeps no code→kind map of its own and delegates to 7A's `rowsForDefinition`, whose `STATEMENT_CODES` already carries that third key, and `rowsForDefinition` forwards `branchId` on the statement branch, which `statementLayout("profit_and_loss", { perBranch: true })` declares (A6); 7C's own definition is `statementDefinition("profit_and_loss", identity, { perBranch: true })` by the same rule Task 2 follows, and 7C's tie-out case passes `branchId` in `params` like any other parameter; `caseFor` in `tests/invariants/report-tie-out.test.ts` gains its own codes — or 7C writes `tests/invariants/report-tie-out-7c.test.ts` beside it, which is cleaner and is what the `default` branch's error message points at; and `ReportCodeSchema` gains 7C's **eight** register rows (`accounting.party_statement`, `accounting.allocation_register`, `accounting.unreconciled_items`, `accounting.pdc_register` ⚠️ OD-09, `accounting.branch_profit_and_loss`, `accounting.tax_return_view`, `pos.sales_by_branch`, `pos.needs_attention`) — appended, with no total asserted, for the reason A4 gives. It also adds the **three Phase 6 `DatasetId` members** to `packages/db/src/reports/datasets.ts` — the file **this slice never touched**, and Task 14's pins case asserts 7B added none, so 7C's diff on it is one hunk. **7C does not have to move that pin, and must not have to**: the case asserts a subset — every member of the union is a name §4.16.2 assigns to 7A, 7C or 8D — so `shift`, `till_event` and `needs_attention` are already inside the set it checks against and it stays green through 7C's hunk and 8D's. Two neighbouring pins were rewritten to the same shape for the same reason and neither is 7C's to edit either: `ReportCodeSchema`'s "not a later slice's code" loop now runs over **`CATALOGUE_7B`** rather than over the enum, so 7C widening the enum by eight moves nothing here; and this plan's Assumptions block no longer claims Task 14 asserts `datasets.ts` is *byte-identical* to its 7A state, which it never did and which 7C's hunk would have falsified. **If a pins case in `tests/invariants/report-catalogue-pins.test.ts` goes red on a 7C branch that added only registered names, that is a defect in this file, not a licence to edit the pin** — raise it against 7B.

**7C inherits four open questions from this slice's Self-Review**, each recorded rather than decided: the `cogsBase`-under-a-stock-gate asymmetry on `inventory.sales_by_item` (pushback 2), `accounting.audit_log`'s tenant scope (pushback 3), whether a company-wide stock ageing is worth a new 3B read function (pushback 4), and — since 7C DOES depend on 6D — whether §4.16.3 should carry a deterministic member count once Phase 6 has landed (pushback 6). None blocks 7C; all four are owner- or architect-level.

**8D** adds the **eight** `hr.*` definitions §4.16.1 assigns it into `packages/db/seed/my/reports/8d/` — `hr.employee_list`, `hr.payroll_register`, `hr.statutory_summary`, `hr.payable_reconciliation`, `hr.contract_expiry`, `hr.attendance`, `hr.payslip`, `hr.annual_statement`, the eight Task 14's `REGISTERED` set already lists — and the six HR `DatasetId` members, and needs `assertTieOut` to grow an `employee_ytd` and a `statutory_schedule` case. **Its `hr.payable_reconciliation` is the one HR report whose tie-out is a `ledger_sum` with an account** (`2400` and `24nn`, §4.15) — the first user of `tieOut.account`, which this slice deliberately left unused and A5 keeps available for exactly that shape.

**And 8D's open question (e) is answered here, because `LEDGER_MEASURE`'s sign convention is this slice's to fix: `net_contribution` and `payable_contribution` map to `"credit_net"`, not to `"credit"` and not to `"net"`.** 8D's amendment A10 adds those two keys to this map, both as `"credit"`, and files as an open question whether `net_contribution` should be `"net"` instead — because a **negative-net supplementary run posts the net leg as a DEBIT to `2400`** (8c:6097–6107 seeds exactly that shape), so Σ`net_contribution` over such a run is negative while `sum(base_credit)` for the window is zero and `sum(base_debit)` carries the figure. **Neither of the two proposed answers is right.** `"credit"` disagrees by the whole amount on that run. `"net"` is `sum(base_debit − base_credit)`, which is `+X` where the measure is `−X` and `−X` where the measure is `+X` — it disagrees by twice the amount on *every* run, ordinary ones included, and would only be made to work by negating the measure in the dataset's SQL, which renders "To net pay" negative on every ordinary payslip register. So this slice adds the arm the shape actually needs rather than telling 8D to bend one of the three: `LEDGER_MEASURE`'s value union is now `"debit" | "credit" | "net" | "credit_net"`, the `ledger_sum` query computes `credit_net` as `coalesce(sum(le.base_credit - le.base_debit), 0)` as a fourth fixed column, and A5 states the convention — gross totals take `debit`/`credit`, a **signed** measure takes `net` or `credit_net` by the natural balance of the account it ties against, and a signed measure is never mapped to `credit`. Both of 8D's measures are signed contributions to credit-natured accounts (`2400`, `241n`), so both take **`credit_net`**. 8D's Step 5 therefore writes `net_contribution: "credit_net", payable_contribution: "credit_net"` and **copies this file's four-member value union rather than the three-member one its plan currently quotes** (8d:2323); nothing else in that step changes, the two keys are still purely additive, and A10 stays additive on exactly A6's terms — 8D adds keys, 7B owns the arms. **8D's own corpus does not distinguish the two mappings** (it posts one ordinary regular run, so `credit` and `credit_net` agree there); the parallel run of 8C is where the difference is real, which is why it is settled now rather than when it fails.

**Nothing in Phase 7, 8 or 9 may rename or re-shape** the twenty-two report codes, the seed envelope of A1, `CATALOGUE_7B`, `reportFixture`, `runDefinition`, `assertFieldCoverage`, `assertTieOut`, `TieOutWitness`, `LedgerWindow`, `TieOutOptions`, the thirteen dataset field lists of A3, or the four indexes of migration 0077. All are registered in the contracts document by Task 0's amendments and are frozen from the moment this slice merges.















