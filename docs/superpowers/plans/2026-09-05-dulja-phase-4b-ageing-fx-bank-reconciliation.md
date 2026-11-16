# Dulja Phase 4B — Ageing, FX settlement and revaluation, bank reconciliation, post-dated cheques

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 4 by proving both sentences of its definition of done. Ship the two async projections spec:1204 names beside `stock_valuation` — **`party_ageing`**, an as-of open-item snapshot whose Σ buckets tie to the `1200`/`2100` control accounts to the cent, and **`item_profitability`**, revenue, COGS and margin per item per fiscal period, the table 7B's "profit by item" and test 7's revenue-bearing re-run read; ship **FX on settlement and at period end** as the one registered `FX_REVALUATION` document type through the `4900`/`5910` pair, completing acceptance test 8 (invoice EUR, part-pay USD, settle in base, revalue at period end); ship **bank reconciliation** — CSV statement import, a `Reconcilable` registry that 6D's till bankings and 8C's payroll batches plug into without editing this slice's file, match and unmatch that never touch a ledger entry, and a reconciled balance that equals the bank account's ledger balance — completing acceptance test 39; and ship the ⚠️ **post-dated cheque** register behind OD-09 as two isolated tasks that drop whole if the owner says no.

**Architecture:** Nothing in this slice invents a posting path or a second definition of an amount. Three seams carry the whole slice. (1) **Two SQL functions in migration 0048** — `app.party_ageing_rows(company, as_of)` and `app.item_profitability_rows(company, sale_types[])` — hold the *only* definition of the ageing arithmetic and of the item split; the projection rebuild `MERGE`s from them, the reports select from them, and the nightly rebuild-and-compare full-outer-joins the stored table against them, so a report and its integrity check can never disagree about what the figure is. This is `app.rate_for` (§4.2.10) and `app.series_gaps` (§4.5.5) applied to a projection. (2) **`FX_REVALUATION` is a seed-pack envelope** (`packages/db/seed/my/document-types/FX_REVALUATION.json`, §4.3.7) with JOURNAL-shaped `line.account` rules; two drafting services in `packages/db/src/ar-ap/fx.ts` resolve the accounts and hand over to 1A's frozen `postDocument`, so no FX amount is computed anywhere but in `Money`. (3) **`packages/db/src/ar-ap/reconciliation.ts` is §4.8.3 verbatim** — a source registry, an importer, `match`/`unmatch` writing only `app.bank_match`, and `reconciledBalance`. **This slice adds exactly one route module** (`/v1/companies/:companyId/bank-statements`) and therefore exactly one `PROBES` key; the ageing report is a `GET` on 1B's `reports` module and the revaluation is a `POST` sub-path on 1A's `documents` module.

**Tech Stack:** Bun 1.4 (install, scripts, the API entrypoint) · Node 24 LTS (runs Vitest) · TypeScript strict · PostgreSQL 18 (Testcontainers `postgres:18`) · `postgres` (postgres.js) tagged templates for every write and every projection read · Drizzle ORM mirrors for typed reads and as the migration diff source (ADR-0002) · Hono + `@hono/zod-openapi` · Zod · `decimal.js` behind `@dulja/domain`'s `Money` · pg-boss for `accounting.projection.rebuild` (0D) · React 19 + `@dulja/ui` + i18next (the OD-24 screens) · Vitest + Testcontainers · Playwright (the both-directions re-run of test 23) · oxlint + oxfmt · Turborepo. No package version appears in any source file — the lockfile owns versions (spec:104).

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §0.2 the never/always lists (spec:97–108), §3.0.3 the **Purchase in foreign currency** and **Customer credit control** rows (spec:1023, 1026), §3.0.4 rows **1043 Bank reconciliation**, **1044 Post-dated cheques ⚠️**, **1045 Multi-currency** and 1042/1047 (spec:1042–1047), §3.3 asynchronous projections (spec:1204), §3.8 `document.currency`/`exchange_rate`/`rate_source` (spec:1760–1762), the `ledger_entry` base checks (spec:1816), the FX-rounding-line comment (spec:1866–1869) and `company.fx_rounding_account_id` (spec:1691, 2001), §3.9 Money/Time/Deletion/Error codes (spec:2037–2053), §4.2.1 `accounting.bank.reconcile` and the `accountant`/`auditor` rows (spec:2147, 2157, 2163), §4.7 rounding (spec:2228), §4.11 engineering practice (spec:2258–2266), Part V the Phase 4 row and the continuous-reporting clause (spec:2290, 2300), Part VI tests **2**, **7**, **8**, **39** (spec:2420, 2425, 2426, 2457), Part VII **#15** (spec:2479), Part I **SAH-011** (spec:311), **SAH-012** (spec:320), **SAH-014** (spec:340), **SAH-019** (spec:381), **SAH-031** (spec:490), **SAH-041** (spec:567).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 4B — Ageing, FX settlement and revaluation, bank reconciliation, post-dated cheques. **Phase:** 4. **Phase gate:** this plan starts only when **4A** is merged (and therefore 3A–3D before it) and Phase 3's definition of done is green in CI (spec:87).
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.forbid_change`. **0B** — `createDb`, the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `AppError`, `ERRORS`, `Problem`, `fromDatabaseError`, `createLogger`, `PERMISSION`, `PermissionCode`, `requirePermission`, `assertRouteGates`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `createApp`, `AppDeps`, `AppEnv`, `startApi`, `TEST_ISSUER`, `PROBES`, `IsolationProbe`, `encodeCursor`, `decodeCursor`, `Cursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `MoneySchema`, `CurrencySchema`, `QuantitySchema`, `RateSchema`, `ProblemSchema`, `parseFilters`, `FILTER_OPS`, `FilterClause`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `sourceFiles`, `REPO_ROOT`, `repoFile`. **0D** — `Money`, `currency`, `CurrencyCode`, `round`, `toBase`, `UNIT_RATE`, `ExchangeRate`, `MONEY_SCALE`, `RATE_SCALE`, `Quantity`, `RoundingMode`, `JOBS`, `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `EnqueueOptions`, `registerHandler`, `runJob`, `eachTenant`, `JOB_PROBES`, `JobIsolationProbe`, `log`, `startWorker`, `seedBranch`, `seedCurrency`, `seedRate`, `app.rate_for`, `app.currency`, `app.exchange_rate`, `PERMISSIONS`, `ROLES`, `INCOMPATIBLE_PAIRS`. **0C** — the seed CLI, `PackLoader`, `LoaderContext`, `readPackFile`, `assertPackShape`, `SUB_PACKS`, the `0c-base.json` chart rows. **0E** — `packages/ui`, `packages/i18n`, `bootLocalStack`, `grantAdminRole`. **1A** — `postDocument`, `issueDocument`, `loadSnapshot`, `resolvePolicy`, `reverseDocument`, `voidDocument`, `PostResult`, `PostingError`, `insertLedger`, `app.posting_seq`, `document.posting_seq`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount`, `JOURNAL_POLICY_V1`, `loadDocumentTypes`, `documentTypesLoader`. **1B** — `trialBalance`, `accountLedger`, `accountOpeningBalance`, `trialBalanceFingerprint`, `postJournal`, `ProjectionCheck`, `ProjectionMismatch`, `registerProjectionCheck`, `projectionChecks`, `runIntegrityCheck`, `recordIntegrityIncident`, `IntegrityReport`, `ACCOUNT_BALANCE_CHECK`, `reportsRoutes`, `reportsRouteModule`, `ReportCodeSchema`. **2A** — `evaluatePolicy`, `balanceInBase`, `parsePolicy`, `validatePolicy`, `validateDocumentTypeSeed`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PostingPlan`, `PolicyEvaluationError`, `requireDocumentPermission`, `DocumentStage`, `DOCUMENT_STAGE_CODES`, `POLICY_RESOLVED_CODES`, `seedParty`, `seedDocumentType`, `DocumentLineInput`, `app.party`. **2B** — `transitionDocument`, `recordOverride`, `setEventContext`, `listDocumentEvents`, `stageCode`, `grantCodes`, `app.principal_has`, `app.effective_policy`, `app.document_event`, `SERIES_GAP_CHECK`. **2C** — `MODULE_READ_CODE`, `requireDocumentModuleRead`, `pdfText`, `document.notes`. **3A** — `app.item` (with `revenue_account_id`, `cogs_account_id`, `inventory_account_id`, `expense_account_id`), `app.warehouse`, `app.lot`, `app.unit_of_measure`, `app.inventory_movement`, `app.stock_on_hand`, `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot`, `INVENTORY_PERMISSION`, `STOCK_ON_HAND_CHECK`. **3B** — `costingEngine`, `app.cost_layer`, `app.cost_consumption`, `app.stock_valuation`, `applyMovements` (full body), `invalidateFrom`, `replay`, `openLayersFor`, `valuationAsOf`, `rebuildStockValuation`, `company.costing_method`, `COST_ADJUSTMENT`, **`postDocument`'s optional `input.jobs?: JobClient` and `AppEnv["Variables"].jobs` (amendment A5)**, and the test-tier helpers `postInventoryDocument`, `postOverriddenIssue`, `recordingJobs`, `ensureOpenPeriods`, `costingContext`. **3C** — `app.document_link`, `app.document_open_quantity`, `linkFulfilment`, `listLinks`, `openQuantity`, `LinkKind`, `DocumentLinkRow`, `GOODS_RECEIPT`, `PURCHASE_INVOICE`-facing chart rows `2150`/`1310`/`5100`, and the `fixtures.ts` helper **`draftTypedDocument(db, s, opts) → { documentId, lineIds }`** with its `DraftLine` shape. **3D** — `SALES_ORDER`, `DELIVERY_ORDER`, `TRANSFER`, `TRANSFER_RECEIPT`, `STOCK_COUNT`, `EXPIRY_WRITE_OFF`, `stockOnHand`, `salesByItem`, `SalesByItemRow`, `document_line.counted_quantity`/`expected_quantity`, the `1250`/`5110` chart rows, `secondPrincipal`. **4A** — `app.payment_term`, `app.allocation`, `allocateSettlement`, `AllocationLine`, `unallocate`, `openBalance`, `partyBalance`, `party.credit_limit`/`payment_term_id`/`credit_hold`, the six document types `SALES_INVOICE`, `SALES_CREDIT_NOTE`, `PURCHASE_INVOICE`, `PURCHASE_CREDIT_NOTE`, `RECEIPT`, `PAYMENT` as seed-pack envelopes, the seven §3.6.2 codes, `seedPaymentTerm`, the §4.17.1 helper `postArDocument` / `PostArOptions` / `ArLine` in `tests/invariants/support/post-ar.ts`, and the revenue-and-margin columns of `inventory.sales_by_item`.

  ⚠️ **4A's plan file did not exist when this plan was written, so every 4A name above is taken from the contracts registry verbatim (§4.8.1, §4.5.7, §4.14, §3.6.2, §4.17) and from nowhere else** — procedure step 4. Where 4A's written plan and this plan disagree about a 4A name, **4A's file is the authority** (§4.18's rule) and Task 0's gate script is what discovers the difference before any code is written. Three 4A facts this plan deliberately does **not** assume: that 4A stores a due date on `document` (it derives one from `party.payment_term_id`, and Task 0 Step 5 greps for a column and switches to it if 4A shipped one); that 4A registered `receipt`/`payment` with `registerReconcilableSource` (it cannot have — §4.8.3's file is in **this** slice's range and does not exist before Task 7, so **4B registers both**); and that `partyBalance().byCurrency` is an open-item view (Task 3 asserts the ageing's own per-currency figures and 4A's `partyBalance().base` only — see the ⚠️ under Task 3 Step 7).
- **Migration numbers:** **0048–0052**, five files, five PRs (§3.4.3 "one migration per PR"), each with a hand-written `NNNN.down.sql`:
  - `0048_create_party_ageing_item_profitability.sql` (**T1**) — the two projection tables and the two SQL functions that define their arithmetic.
  - `0049_create_bank_statement.sql` (**T6**) — `app.bank_statement` and `app.bank_statement_line`.
  - `0050_create_bank_match.sql` (**T7**) — `app.bank_match` with **both** stamps.
  - `0051_create_pdc.sql` (**T9**, ⚠️ **OD-09** — the file is never written if the owner says no).
  - `0052_seed_permission_phase4b.sql` (**T2**) — the one code `accounting.bank.reconcile`.

  **ADR numbers:** 0046–0048, each written **as a proposal and asked before implementing** (spec:95 — all three touch money semantics): **0046** *Ageing and item-profitability projection shapes* (T3, T4); **0047** *Realised and unrealised FX in one document type* (T5); **0048** *Bank reconciliation never alters a ledger entry* (T6, T7).
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `currency`, `round`, `toBase`, `ExchangeRate`, `UNIT_RATE`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`, `createDb`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`, the middleware order), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`, `PostingError` — and `ERR_BANK_MATCH_AMOUNT`, this slice's one registry row), §4.2.5 (`PERMISSION`, `requirePermission`, `ROLES`, `INCOMPATIBLE_PAIRS`, `assertRouteGates`), §4.2.6 (`JOBS`, `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `registerHandler`, `runJob`, `eachTenant`, `JOB_PROBES`), §4.2.7 (`RouteModule`, `buildRoutes`, `IdempotencyHeader`, `createApp`, `PROBES`, `TENANT_FREE`), §4.2.8 (the common schemas, the list envelope, the cursor codec, **the one list-filter convention — `parseFilters` is named there as the mechanism 4B's ageing route uses**), §4.2.9 (`idempotency`, `RECLAIM_AFTER_SECONDS`), §4.2.10 (`app.rate_for`, `app.exchange_rate`, `app.currency`), §4.2.12 (`startApi`, `ApiRequest`, `StartedApi`), §4.2.13 (`readPackFile`, `SubPack`), §4.3.1 (`postDocument`, `loadSnapshot`, `resolvePolicy`, `reverseDocument`, `transitionDocument`), §4.3.2 (the fixed algorithm — steps 5, 6, 10, 12, **14**), §4.3.3 (`account_balance` and its `MERGE`), §4.3.4 (`document_line` and the `document` header additions), §4.3.5 (`posting_seq`), §4.3.6 (numbering at issue), §4.3.7 (the seed envelope and `loadDocumentTypes`), §4.4.1 (`posting-policy.schema.json` — consumed **unchanged**, same `$id`, same `"version": 1`), §4.4.2 (`evaluatePolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, **sign normalisation A9**), §4.5.1 (legal transitions), §4.5.2 (`document_event`), §4.5.4 (`requireDocumentPermission`, `DOCUMENT_STAGE_CODES`), §4.5.7 (`app.party` and 4A's three additions), §4.6.1 (the register rows for `party_ageing`, `item_profitability`, `bank_statement`, `bank_statement_line`, `bank_match`, `pdc`), §4.7.3 (`inventory_movement`, `cost_layer`, `cost_consumption`), §4.8.1 (`app.allocation`, `allocateSettlement`, `openBalance`, `partyBalance`), §4.11.1 (`ReportDefinition` — only for the shape 7C re-expresses `accounting.ageing` into), §4.14 (document-type codes), §4.15 (account codes), §4.16.1 / §4.16.2 / §4.16.3 (report codes, the closed `DatasetId` registry, the Phase 1 report surface and the `ProjectionCheck` registry), §4.17 / §4.17.1 (the two helper registers), §5 (all thirty-five hazards), §6.1 rows 2, 7, 8, 39, §6.2 rows 1043, 1044, 1045.
- **Interfaces produced:** §4.8.2 in full (`party_ageing` rebuilt by `accounting.projection.rebuild`, buckets from `document.effective_date + payment_term.due_days`, the ageing report under **`accounting.ageing`**, the Σ-buckets-to-control-account tie-out); §4.8.3 in full (`app.bank_statement`, `app.bank_statement_line`, `app.bank_match` with both stamps, `Reconcilable`, `ReconcilableSource`, `registerReconcilableSource`, `importStatement`, `CsvMapping`, `match`, `unmatch`, `reconciledBalance`); §4.6.1's `party_ageing`, `item_profitability`, `bank_statement`, `bank_statement_line`, `bank_match` and ⚠️ `pdc` rows verbatim; §4.14's `FX_REVALUATION` row and ⚠️ its `PDC_RECEIPT`/`PDC_DEPOSIT` rows; §3.6.2's one code `accounting.bank.reconcile`; §4.2.6's one 4B-owned `JOBS` entry `accounting.projection.rebuild`; §4.2.4's `ERR_BANK_MATCH_AMOUNT`; §4.16.1's `accounting.ageing`. Everything else is listed under **Contract additions** in the Self-Review and lands through **Task 0**.
- **Owner decisions:** **OD-09** (post-dated cheques — spec:1044, 2479; Part VII #15) → **Tasks 9 and 10**, the two isolated tasks §2.5's card names; default **not built**, and the two tasks are dropped whole with migration 0051, the `4b-pdc.json` chart file, the two document types, the `pdc` route module and its `PROBES` key. **This is also the discharge of OD-05 for this slice**: OD-05 is "confirmation of every ⚠️ row in §3.0.3 and §3.0.4" and 4B's scope contains exactly one ⚠️ row — spec:1044, post-dated cheques — which is OD-09's own subject, so Task 9 Step 1 records both ids against one decision record rather than creating a second gate for the same sentence (hazard 6 asks for one task per decision, not one task per id pointing at one decision). **OD-24** (screenshots + a two-minute operator description before any screen) → **Task 11**, isolated; default: the screen task is blocked, the slice is not.
- **Part VI tests owned / re-run:** **owns 8** (multi-currency round-trip — Task 5) and **39** (bank reconciliation — **Task 7**, not Task 8. §6.1's row 39 reads "statement import; match/unmatch; unreconciled list; reconciled = ledger **(T8)**", and that task column is §6.1's own declared **indicative** pointer, not an assignment: all four clauses are proved in **Task 7 Step 5**, `tests/invariants/test-39-bank-reconciliation.test.ts`, which is where the acceptance test file lives. Task 8 adds route-level coverage over the same four clauses and owns none of them. No amendment is made for this — §6.1 says the column is indicative — but a reader following the pointer should land on Task 7; 6D re-runs the till-banking clause and 8C the payroll-batch clause through `registerReconcilableSource`, which is why the registry and not a type list is the seam). **Re-runs:** **2** (deterministic projections, over `party_ageing` and `item_profitability` — Tasks 3 and 4), **7** (the revenue half of "valuation and profit tie to the cent", which 3D could prove on cost only — Task 4), **12**, **13** and **36** (tenant isolation, audit completeness and the permission catalogue over this slice's five tables, one code and one route module — Tasks 1, 2, 8 and 12), **27** (no SQL text across the API — Task 12). **§3.0.4 rows owned:** spec:**1043** Bank reconciliation, spec:**1044** Post-dated cheques ⚠️, spec:**1045** Multi-currency (0D contributed the rate tables and 1A `base = value × rate`); spec:1042's ageing half and spec:1047's Phase 4 report. **Regression files created / appended:** **creates none.** **Appends** a `— 4B` block to `tests/regression/sah-011.test.ts`, `sah-012.test.ts`, `sah-014.test.ts`, `sah-019.test.ts`, `sah-031.test.ts` and `sah-041.test.ts` — all six are 0B's thin files (§3.7.3's Plan 0A-proven list plus 0B's structural set), and this slice never edits an earlier block.
- **Shared namespaces this slice writes into:** **document-type codes (§4.14)** — **`FX_REVALUATION`** (`module: "accounting"`, series `FXR`, `direction: internal`, `inventory.effect: "none"`, `approval.post: "accounting.journal.post"`), seeded as `packages/db/seed/my/document-types/FX_REVALUATION.json`; ⚠️ **`PDC_RECEIPT`** (`accounting`, `PDC`) and ⚠️ **`PDC_DEPOSIT`** (`accounting`, `PDD`) only if OD-09. **This slice registers no test-only document-type code.** Every type its tests configure is a 4A / 3C / 3D **pack envelope read off disk** by `seedTypeFromPack`, and the ageing's due dates are varied through `party.payment_term_id` and `seedPaymentTerm` — which is where `due_days` lives (amendment 3) — not through a document type of this slice's own. An earlier draft allocated a test-only code for that job; Task 3's tests use `SALES_INVOICE`, `PURCHASE_INVOICE` and `RECEIPT` and never reach for it, so nothing is registered in §4.14 beyond the three rows above (hazard 32 cuts both ways — an unused registration is a name another slice must then avoid for nothing). **Account codes (§4.15)** — **seeds none in the unconditional slice.** Consumed and asserted-not-reseeded, each with its seeding slice: **`1200` trade receivables (0C)**, **`2100` trade payables (0C)**, **`4900` FX gain (0C)**, **`5910` FX loss (0C)**, **`5920` FX rounding (0C)**, **`1100` Bank (0C)**, `4000` Sales / `5000` COGS / `1300` Inventory control / `5900` Other operating expense (0C), `1250` goods delivered not invoiced (**3D**), `2150` goods received not invoiced (**3C**) and `5100` inventory write-off — expiry loss (**3C**) reached only through 3C's, 3D's and 4A's own policies. **The last three matter to the fixture and not only to the register:** Task 4 posts a `GOODS_RECEIPT` (policy `account: { code: "2150" }`, phase-3c:2302), a `DELIVERY_ORDER` (`{ code: "1250" }`, phase-3d:2028) and an `EXPIRY_WRITE_OFF` (`{ code: "5100" }`, phase-3d:4143), and `seedTenantV2` creates none of them — so `arApFixture` creates all three with `seedAccount` beside the other nine, and never re-seeds a pack file. Task 2 Step 5 asserts all six of the first group resolve for the seeded company and Task 5 Step 1 re-asserts the FX three, which is the card's "its first FX task asserts the three resolve". ⚠️ **One conditional addition: `1150` Cheques in hand (asset), seeded by 4B in `packages/db/seed/my/chart-of-accounts/4b-pdc.json` only if OD-09 = yes** — a §4.15 amendment made in Task 0 amendment 8 and dropped with Task 9. **Report codes (§4.16.1)** — **`accounting.ageing`** only, shipped as a `GET` on 1B's `reports` module over a named read function under §4.16.3's rules; 7C re-expresses it at `version = 2` under the same code. **`accounting.unreconciled_items` and ⚠️ `accounting.pdc_register` are 7C's rows and this slice ships neither** — the unreconciled list is `reconciledBalance().unreconciled` behind a `GET` on the bank-statements module, not a `ReportCode` (see Task 8 Step 4). **`DatasetId` members (§4.16.2) — none:** 7A creates `datasets.ts` with `party_ageing`, `item_profitability`, `bank_statement_line`, `bank_match` and `pdc` already in its ≤ 0058 set, and this slice adds no member and never edits that file. **`fixtures.ts` helpers (§4.17) — none added.** §4.17 assigns 4B no row and hazard 9 forbids inventing one beside the register; every row this slice's tests need comes from `seedTenantV2`, `seedAccount`, `seedParty`, `seedDocumentType`, `seedPaymentTerm`, `seedCurrency`, `seedRate`, `seedBranch`, `grantCodes`, `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot`, 3C's `draftTypedDocument`, 3B's `ensureOpenPeriods`/`postInventoryDocument`, 3D's `secondPrincipal`, or a **file-local** function this plan writes out in full. **Shared test helpers (§4.17.1) — one new file, registered by Task 0 amendment 9:** `tests/invariants/support/ar-ap.ts` with `PACK_DIR`, `seedTypeFromPack`, `packApproval`, `postFromPack`, `ArApFixture` and `arApFixture` — the helpers Tasks 3, 4, 5, 7 and 12 all need, and the reason they are shared rather than file-local is that `seedTypeFromPack` reads **4A's own shipped envelope** off disk instead of restating a policy this plan has never seen, and five files copying that read is hazard 9.
- **Six `Seed`, fixture and register facts every test in this plan depends on, stated once because getting one wrong is a silent failure.** (1) **`Seed` has no `branch` member.** It is `{ tenant; system; human; company; period; closedPeriod; lockedPeriod; cash; sales; docType; policy; branchType; hq }` (§4.1); `app.document.branch_id` is NOT NULL, so every `branchId:` in this plan is `<seed>.hq` unless a second value came from `seedBranch`. (2) **`seedTenant` grants `s.human` nothing** (§4.1, pinned) and 2B's R2 evaluates `policy.approval.post` *inside* the posting transaction, so **every posting test calls `grantCodes` first**. (3) **`seedTenantV2` creates `1000 Cash`, `4000 Sales` and `5920 FX rounding` — and nothing else.** (`5920` comes with it because `seedTenantV2`'s whole job beyond `seedTenant` is that account wired to `company.fx_rounding_account_id`, phase-1a:2424; this slice therefore never seeds `5920` and only asserts it resolves.) Every other account this slice's tests touch — `1100`, `1200`, `1250`, `1300`, `2100`, `2150`, `4900`, `5000`, `5100`, `5900`, `5910`, and ⚠️ `1150` — is created in the test by 1A's `seedAccount(db, s, { code, nameEn, type })` with `type ∈ ('asset','liability','equity','income','expense')`, through `arApFixture`'s `ACCOUNTS` list (Task 3 Step 4). (4) **Plan 0A seeds exactly three fiscal periods and only 2026-01 is open** (`s.period` open, `s.closedPeriod` = 2026-02 **closed**, `s.lockedPeriod` = 2026-03 **locked**); every test in this plan that posts outside January calls **3B's `ensureOpenPeriods(db, s, 2026)`** first, and Task 12's period-lock case closes one deliberately to prove `assert_period_open` still governs. (5) **`app.document` has no `custom_fields` column** — only `document_line` does (§4.3.4), and `DocumentSnapshot.header.customFields` is assembled by `loadSnapshot` from `app.custom_field_value` (§4.2.11). Every marker this slice writes on an FX document therefore lives in **`document_line.custom_fields`**, under the key **`fxKind`**, and Task 0 amendment 5 records why. (6) **`app_rw` holds DELETE on exactly five tables** (§3.5.4: `document`, `document_line`, `idempotency_key`, `role_assignment_branch`, `role_permission`) and **2B is the only slice that ever extends that list**, so **no rebuild in this slice deletes a projection row**: both rebuilds `MERGE` and then zero the stale keys of the same scope, exactly as `account_balance` and `stock_valuation` do.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first (that is what Task 0 is).
- **Contracts version:** 2026-09-08 — §4.18's header now reads "(2026-09-07, extended 2026-09-08)" and the document carries a **round 3** amendment block ("from plans 3A–9B"). One of its rows is tagged **`4A, 4B`** and it ratifies rather than changes this plan: **§4.8.1** settles that `partyBalance` reads `ledger_entry` on the party's control account (never a sum of document totals) and **negates a vendor's** figure so positive means "owed by us", that `app.party_open_balance` applies no flip because it is the customer-only credit-control read, and that **"4B's ageing DoD reads the un-flipped control balance directly."** That is exactly what this plan already does and what the Self-Review's reviewer-check (2) already says: `ageingTieOut` (written in **Task 3 Step 5**, asserted in **Task 3 Step 2**) differences the ageing base against `Σ (base_debit − base_credit)` on `1200` and `2100` read straight off the control account with no flip, and the one place this slice touches `partyBalance` — **Task 5 Step 8**, acceptance test 8's clause 6 — asserts its `base` member only and never `byCurrency`. No task changes; the stamp is bumped so an executor told to read "the contracts version this plan was written against" reads the document that contains this row. Round 3's other rows are per-slice amendments the owning slices land in their own PRs (§4.18 says so), and none of them is 4B's — **Task 0's twelve amendments are still 4B's to write, and its gate script still fails until they are in the file.**

## Global Constraints

Copied verbatim from the spec and the contracts document; every task's requirements implicitly include this section.

1. **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (SAH-036/037/069); issue DDL from application code (SAH-053); disable an invariant, constraint or trigger "temporarily" (SAH-027, 041, 053); gate an audit write on any flag (SAH-030); hard-code a package version into a source file — the lockfile owns versions.
2. **Always**, for every new table (spec:106): `tenant_id`, an RLS policy named exactly `tenant_isolation`, `created_at`, a migration with a hand-written down, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge. **This slice creates five tables** (four unconditionally, `pdc` behind OD-09) and every one of them carries the §3.3 binding form and a two-tenant test in the same task.
3. **Nothing outside `packages/db/src/posting/` and `packages/db/src/costing/` writes `ledger_entry`, `ledger_entry_dimension`, `inventory_movement`, `cost_layer`, `cost_consumption`, `account_balance`, `stock_on_hand` or `tax_transaction`** (§4.3.2, the `posting-only-tables` lint, hazard 22). Every FX and PDC service in this slice writes `document` and `document_line` rows and then calls `postDocument`. **The two projections `party_ageing` and `item_profitability` are deliberately *not* on that lint's list** (§3.7.5 says so by name) — they are rebuilt by their pg-boss job, and `packages/db/src/ar-ap/ageing.ts` and `packages/db/src/projections/item-profitability.ts` are their only writers.
4. **Money** is `numeric(19,4)` in Postgres and the opaque `Money` type in `@dulja/domain` in TypeScript; no `number` ever holds a monetary value (spec:2041, §3.7.5 `no-number-money`). Every wire amount is `{ amount, currency }`; every rate is an 8-dp string; every date `YYYY-MM-DD`. **Every tie-out in this slice sums through `Money.add` or through SQL `sum(...)::text` — never through `Number()` and never through `.toFixed()`.**
5. **`Money.toBase` rounds `HALF_AWAY_FROM_ZERO` at scale 4** (hazard 23, spec:1816), the only mode satisfying `base_debit = round(debit * exchange_rate, 4)`. The FX services in this slice compute *base* amounts and post them at `exchange_rate = 1`, so the CHECK holds by construction; the one place a rate is applied is `toBase`/SQL `round(value * rate, 4)`, and both are the same arithmetic.
6. **`PlannedLedgerLine.amount` is never negative and `side` is the sole carrier of direction** (§4.4.2 A9); `PlannedTaxLine.amount` stays signed and this slice plans no tax line. **No line of this slice reads the sign of a planned amount to decide a ledger direction.** The three places a sign *is* read are drafting decisions over stored figures, declared in the Self-Review: `allocation.fx_difference`'s sign chooses which side of a `document_line` the control leg goes on (Task 5), a revaluation delta's sign does the same (Task 5), and a statement line's sign chooses which `Reconcilable` kinds may match it (Task 7). In all three the resulting `document_line.debit`/`credit` and `bank_match.amount` are non-negative magnitudes.
7. **Every query, reads included, runs inside `withTenant`** (spec:2053). `db.` is a lint violation; only a `tx` obtained from `withTenant` may tag SQL. `sql.unsafe` has exactly three homes and none is in this slice (§3.3, hazard 21). The CSV parser in Task 6 takes a `string` and returns rows; it never builds SQL.
8. **One migration per PR** (spec:2057); each file runs whole in one transaction (so no `create index concurrently`); every statement carries a comment naming the SAH-/spec reference it serves; SQL keywords lowercase; section banners `-- ── N. title ───`; a hand-written `NNNN.down.sql` that drops only what the up added, in reverse dependency order (§3.4.5).
9. **No enum label is added** (§3.4.4, hazard 11); every new closed vocabulary in this slice is `text` + a named `check` — `party_ageing.bucket`, `bank_match.reconcilable_kind`, ⚠️ `pdc.status`.
10. **Deletion** (spec:2049): financial rows never — correction is a reversal; master data is `archived_at`. §3.5.4's pinned `app_rw` DELETE list is **unchanged** by this slice and Task 12 re-asserts it as an equality. `bank_match` is *unmatched*, never deleted (`unmatched_at`, §4.8.3) — that is the whole of SAH-041's fix applied to reconciliation.
11. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). **This slice adds exactly one row to `ERRORS`: `ERR_BANK_MATCH_AMOUNT` (422), allocated by §4.2.4 to 4B, added in the PR that raises it (Task 7).** Everything else it raises is already shipped: `ERR_VALIDATION_FAILED`, `ERR_NOT_FOUND`, `ERR_RBAC_FORBIDDEN`, `ERR_RLS_DENIED`, `ERR_CONFLICT_UNIQUE`, `ERR_DOC_STATUS_ILLEGAL`, `ERR_DOC_NO_LINES`, `ERR_POLICY_NOT_FOUND`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_PERIOD_NOT_FOUND`, `ERR_PERIOD_NOT_OPEN`, `ERR_LEDGER_UNBALANCED`, `ERR_RATE_NOT_FOUND`, `ERR_INTERNAL`. **This list is closed: a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.**
12. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice seeds exactly the one code §3.6.2 assigns it — `accounting.bank.reconcile`, `mutating: true` — and invents none.
13. **No plan invents a literal in a shared namespace** (hazard 32). Document-type codes, account codes, report codes, `DatasetId` members, `fixtures.ts` helper names and `ERR_*` names all come from the registers; **Task 0 amends a register before any task writes a literal into it**, and the one conditional account code (`1150`) is amended there and dropped with its task.
14. **The slice that seeds a policy seeds the accounts that policy names by code** (§4.15, hazard 33). `FX_REVALUATION`'s policy names **no** `account: { code }` literal — its two rules resolve `{ from: "line.account" }` — and the account codes the *drafting service* resolves (`4900`, `5910`, and the control account it reads off `party`) are 0C's. **Task 2 Step 5 asserts every one of them resolves for the seeded company and never re-seeds one and never falls back to a null account.**
15. **Jobs run as the tenant's system principal** through `systemContext` and fan out through `eachTenant`, never through `app.tenant` (FORCE RLS), and do their work in **many short transactions, never one long one** (spec:1368, 1179; hazard 20). `accounting.projection.rebuild` processes **one company per `withTenant` transaction**.
16. **The UI is not specified** (spec:79, 108). Task 11 begins with OD-24 and targets keyboard parity (spec:2254); no workflow is invented (hazard 29).
17. **Localisation** (spec:2061): every user-facing string goes through i18next with an ICU message; `packages/i18n` catalogues are complete in `en` and `ar` before merge; every screen is verified in both text directions (test 23).
18. **No real Malaysian statutory rate, threshold or formula appears anywhere in this slice, and no LHDN or MyInvois endpoint, field, schema version or deadline appears either** (hazards 1 and 2). This slice touches neither domain: every exchange rate in every fixture is a round invented figure (`5.0000`, `4.0000`, `5.2000`, `5.5000`) with `source: 'manual:test'`, and no tax code, tax account or return is read or written.
19. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [4B T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root stay green after every task.

---

## This slice's share of the Phase 4 definition of done

The Phase 4 row of the phase table, verbatim (spec:2290) — **Definition of done:** *"Ageing report reconciles to the ledger to the cent; a month is bank-reconciled with every receipt and payment matched or listed as unreconciled (till bankings and payroll batches join the same matching when Phases 6 and 8 land — test 39)"*.

Both sentences are **4B's**, and 4A's card says so ("both DoD sentences are verified in 4B").

| Clause | Owner | Where it is green |
|---|---|---|
| **"Ageing report reconciles to the ledger to the cent"** | **4B** | **Task 3 Step 2's DoD case**, over the `ageingTieOut` Step 5 writes — it returns one row per control account with `ageingBase`, `ledgerBase`, `revaluationBase` and `difference`, and the DoD test asserts `difference === "0.0000"` for **`1200`** and **`2100`** (§4.8.2's two literals) over a fixture containing a same-currency invoice, a cross-currency part-payment, a credit note, an unallocated receipt on account and a vendor bill. **Task 5 Step 8** re-asserts it after the realised FX difference and after the unrealised revaluation and its reversal, which is the only reason the equality can hold at all in a cross-currency month (ADR 0047) |
| **"a month is bank-reconciled with every receipt and payment matched or listed as unreconciled"** | **4B** | **Task 7 Step 5**, `tests/invariants/test-39-bank-reconciliation.test.ts` (§6.1's row-39 task column reads T8 and is that table's declared *indicative* pointer, not an assignment) — acceptance test 39: a January statement is imported, every receipt and payment of the month is matched, `reconciledBalance` returns `statement === ledger`, one deliberately unmatched payment appears in `unreconciled` and disappears from it when matched, an `unmatch` restores it, and a per-document hash of `ledger_entry` taken before the first `match` is byte-identical after the last `unmatch` |
| "(till bankings and payroll batches join the same matching when Phases 6 and 8 land)" | **6D**, **8C** | **Task 7 Step 4** ships `registerReconcilableSource(source: ReconcilableSource)` and registers the `receipt` and `payment` sources; the `reconcilable_kind` CHECK already admits `till_banking` and `payroll_batch` (§4.8.3), so 6D and 8C each add one `registerReconcilableSource` call and **edit no file of this slice**. **Task 7 Step 1**'s case *"a third source registers without editing this slice's file"* proves the seam with a synthetic third source registered inside the test |

**Phase 4 exit (Task 12).** Both clauses green in CI, plus tests **8** and **39** passing and tests **2**, **7**, **12**, **13**, **27** and **36** re-run over this slice's tables, code, job and route module; the pinned `app_rw` DELETE list re-asserted unchanged; `lintSchema` at zero violations; the staging re-seed run; `AGENTS.md`'s "Current phase" section rewritten (§3.8 names 4B as a phase-closing slice).

---

## File Structure

Every path is relative to the repository root. **NEW** means this slice creates it; **EDIT** means an existing file gains the stated additions and nothing else.

```
docs/
├─ adr/0046-ageing-and-item-profitability-projection-shapes.md   NEW  proposal (spec:95)     T3,T4
├─ adr/0047-realised-and-unrealised-fx-in-one-document-type.md   NEW  proposal               T5
├─ adr/0048-bank-reconciliation-never-alters-a-ledger-entry.md   NEW  proposal               T6,T7
├─ decisions/od-09-4b-post-dated-cheques.md                      NEW  the OD-09/OD-05 record T9
├─ runbooks/bank-reconciliation.md                               NEW  the monthly procedure  T7
├─ review/2026-09-05-phase-4-exit.md                             NEW  the phase report       T12
└─ owner/od-24/4b/                                               NEW  the OD-24 gate dir     T11

scripts/check/
└─ contracts-4b-amendments.sh                                    NEW  Task 0's gate          T0

AGENTS.md                                                        EDIT "Current phase" → 4B   T12

packages/db/
├─ migrations/
│  ├─ 0048_create_party_ageing_item_profitability.sql   NEW  two tables + two SQL functions  T1
│  ├─ 0048.down.sql                                     NEW                                  T1
│  ├─ 0049_create_bank_statement.sql                    NEW  statement + statement_line       T6
│  ├─ 0049.down.sql                                     NEW                                  T6
│  ├─ 0050_create_bank_match.sql                        NEW  bank_match + BOTH stamps         T7
│  ├─ 0050.down.sql                                     NEW                                  T7
│  ├─ 0051_create_pdc.sql                               NEW  ⚠️ OD-09 only                    T9
│  ├─ 0051.down.sql                                     NEW  ⚠️ OD-09 only                    T9
│  ├─ 0052_seed_permission_phase4b.sql                  NEW  one code                         T2
│  └─ 0052.down.sql                                     NEW                                  T2
├─ src/
│  ├─ lint-schema.ts                     EDIT four set memberships, exactly §3.5.3's state   T1
│  │                                     (T1 ONLY — §3.5.3's rows for bank_statement,
│  │                                      bank_statement_line, bank_match and pdc are all
│  │                                      dashes, so T6, T7 and T9 must not touch this file)
│  ├─ schema/
│  │  ├─ party-ageing.ts                 NEW  Drizzle mirror                                  T1
│  │  ├─ item-profitability.ts           NEW  Drizzle mirror                                  T1
│  │  ├─ bank-statement.ts               NEW  bankStatement + bankStatementLine mirrors        T6
│  │  ├─ bank-match.ts                   NEW  Drizzle mirror                                   T7
│  │  └─ pdc.ts                          NEW  ⚠️ OD-09 only                                    T9
│  ├─ ar-ap/
│  │  ├─ ageing.ts        NEW  AgeingBucket, PartyAgeingRow, AgeingParams, ageingRows,
│  │  │                        rebuildPartyAgeing, PARTY_AGEING_BUCKETS, ageingTieOut,
│  │  │                        AgeingTieOutRow, outstandingRevaluation                        T3
│  │  ├─ fx.ts            NEW  postSettlementFxDifference, settleWithFx, revalueAtPeriodEnd,
│  │  │                        reverseRevaluation, FxAccounts, resolveFxAccounts,
│  │  │                        FX_REVALUATION_CODE, FX_ACCOUNT_CODES, RevaluationResult       T5
│  │  ├─ reconciliation.ts NEW  §4.8.3 verbatim + CsvMapping, parseDelimited,
│  │  │                        unmatchedStatementLines, ReconciledBalance, BankStatementRow,
│  │  │                        BankStatementLineRow, BankMatchRow, listStatements,
│  │  │                        listStatementLines                                             T6,T7
│  │  ├─ pdc.ts           NEW  ⚠️ OD-09: PdcRow, PdcStatus, draftPdcReceipt, depositPdc,
│  │  │                        bouncePdc, listPdc, PDC_ACCOUNT_CODE                           T9,T10
│  │  └─ index.ts         EDIT 4A's barrel gains this slice's export blocks (never rewritten)  T3,T5,T6,T7,T9,T10
│  ├─ projections/
│  │  ├─ item-profitability.ts  NEW  ItemProfitabilityRow, itemProfitabilityRows,
│  │  │                              rebuildItemProfitability, ITEM_PROFITABILITY_CHECK,
│  │  │                              SALE_MOVEMENT_TYPES, NON_SALE_MOVEMENT_TYPES             T4
│  │  └─ index.ts               NEW  the barrel                                                T4
│  ├─ reports/ageing.ts   NEW  agedBalance, AgedBalanceParams, AgedBalanceRow                  T3
│  ├─ posting/post.ts     EDIT step 14 enqueues accounting.projection.rebuild                  T4
│  ├─ posting/errors.ts   EDIT PostingErrorCode gains "ERR_RATE_NOT_FOUND" (amendment 11)      T5
│  ├─ jobs/payloads.ts    EDIT one JobPayload key                                              T3
│  ├─ integrity/index.ts  EDIT registers ITEM_PROFITABILITY_CHECK                              T4
│  └─ index.ts            EDIT re-exports ./ar-ap, ./projections, ./reports/ageing            T3,T4,T5
├─ seed/
│  ├─ roles.ts            EDIT accounting.bank.reconcile → accountant (§3.6.4)                 T2
│  └─ my/
│     ├─ chart-of-accounts/4b-pdc.json      NEW  ⚠️ OD-09 only: 1150 (§4.15 amendment)         T9
│     └─ document-types/FX_REVALUATION.json NEW                                                T5
│        + PDC_RECEIPT.json, PDC_DEPOSIT.json  NEW  ⚠️ OD-09 only                              T10
└─ test/
   ├─ ar-ap/party-ageing.test.ts        NEW  0048 DDL, RLS, lint, two-tenant, the functions    T1
   ├─ ar-ap/ageing.test.ts              NEW  buckets, rebuild, compare, the DoD tie-out        T3
   ├─ ar-ap/item-profitability.test.ts  NEW  attribution, the registry, test 7's revenue half  T4
   ├─ ar-ap/fx.test.ts                  NEW  realised, unrealised, the reversal, test 8        T5
   ├─ ar-ap/bank-statement.test.ts      NEW  0049 DDL, CSV import, the balance check           T6
   ├─ ar-ap/bank-match.test.ts          NEW  0050 DDL, match/unmatch, reconciledBalance, t39   T7
   ├─ ar-ap/pdc.test.ts                 NEW  ⚠️ OD-09 only                                     T9,T10
   ├─ seed/permission-phase4b.test.ts   NEW  the 0052 catalogue, role-seed and account asserts  T2
   └─ privileges.test.ts                EDIT the unchanged DELETE list re-asserted             T12

packages/contracts/
├─ permissions.ts                    EDIT one PermissionDef row (§3.6.2)                       T2
└─ src/
   ├─ errors.ts                      EDIT ERR_BANK_MATCH_AMOUNT                                T7
   ├─ accounting/reports.ts          EDIT ReportCodeSchema += accounting.ageing; the ageing DTOs T3
   ├─ accounting/bank.ts             NEW  BankStatementSchema, ImportStatementBody, CsvMappingSchema,
   │                                      BankStatementLineSchema, BankStatementLineQuery,
   │                                      CreateBankMatchBody, BankMatchSchema, UnmatchBody,
   │                                      ReconciledBalanceSchema, ReconcilableSchema         T6,T7,T8
   ├─ accounting/fx.ts               NEW  RevalueBody, RevaluationResultSchema                 T5
   └─ accounting/pdc.ts              NEW  ⚠️ OD-09: PdcSchema, CreatePdcBody, DepositPdcBody,
                                          BouncePdcBody, PdcQuery, PdcList                    T9,T10

apps/api/src/routes/accounting/
├─ reports.ts        EDIT one GET (accounting.ageing) on 1B's module                           T3
├─ documents.ts      EDIT one POST sub-path (…/documents/revaluations)                          T5
├─ bank-statements.ts NEW  T2 creates it with BANK_PERMISSION only (permission-catalogue must
│                          pass inside T2's own commit); T8 fills in bankStatementRoutes and
│                          bankStatementRouteModule (six sub-paths)                          T2,T8
└─ pdc.ts            NEW  ⚠️ OD-09: pdcRoutes, pdcRouteModule                                   T9,T10
apps/api/src/routes/index.ts   EDIT buildRoutes gains one module (two with OD-09)              T8,T9
apps/api/test/routes/accounting/
├─ ageing-report.test.ts     NEW                                                                T3
├─ revaluation.test.ts       NEW                                                                T5
├─ bank-statements.test.ts   NEW                                                                T8
└─ pdc.test.ts               NEW  ⚠️ OD-09 only                                                 T10

apps/worker/src/handlers/
└─ accounting-projection-rebuild.ts   NEW  the job registration                                 T3
apps/worker/test/handlers/
├─ accounting-projection-rebuild.test.ts   NEW                                                  T3
└─ integrity-check.test.ts                 EDIT projections.checked gains item_profitability     T4

apps/backoffice/src/                  (OD-24, Task 11)
├─ lib/ar-ap-api.ts                   NEW  the typed fetch layer the two screens share
├─ routes/accounting/ageing.tsx       NEW  the ageing worklist
├─ routes/accounting/bank-reconciliation.tsx  NEW  the two-column matching screen
└─ router.tsx                         EDIT two routes; app-shell.tsx gains two nav entries
apps/backoffice/test/
├─ ar-ap-ageing.test.tsx              NEW
└─ bank-reconciliation.test.tsx       NEW
packages/i18n/src/locales/{en,ar}.json  EDIT the accounting.ageing.* / accounting.bank.* keys   T11

tests/
├─ invariants/support/ar-ap.ts               NEW  §4.17.1 amendment 9                       T0,T3
├─ invariants/probes.ts                      EDIT one PROBES key, one JOB_PROBES entry     T3,T8
├─ invariants/projection-rebuild.test.ts     EDIT projections.checked gains item_profitability T4
├─ invariants/audit-chain.test.ts            EDIT the same array                              T4
├─ invariants/test-08-multi-currency.test.ts NEW  acceptance test 8                           T5
├─ invariants/test-39-bank-reconciliation.test.ts  NEW  acceptance test 39                    T7
├─ regression/sah-011.test.ts   EDIT append a `— 4B` block (no NULL reaches an ageing bucket) T3
├─ regression/sah-012.test.ts   EDIT append a `— 4B` block (base = value × rate on FX lines)  T5
├─ regression/sah-014.test.ts   EDIT append a `— 4B` block (neither rate is discarded)        T5
├─ regression/sah-019.test.ts   EDIT append a `— 4B` block (one rounding function)            T5
├─ regression/sah-031.test.ts   EDIT append a `— 4B` block (a locked period refuses a match)  T7
├─ regression/sah-041.test.ts   EDIT append a `— 4B` block (matching never alters an entry)   T7
└─ e2e/ar-ap-screens.spec.ts    NEW  test 23 re-run, both directions                          T11
```

**Two notes on this structure, both deliberate.** (1) **`ageing.ts` lives under `ar-ap/` and `item-profitability.ts` under `projections/`, and the asymmetry is the register's, not a slip.** §4.8.2 places ageing inside the AR/AP interface family beside `allocation.ts` and `reconciliation.ts`, and 4B's ageing read, its rebuild and its tie-out are all AR/AP concepts. `item_profitability` is not an AR/AP concept at all — §4.6.1 registers it beside `stock_valuation`, and it reads `inventory_movement`, `cost_consumption` and `cost_layer` — so a new `packages/db/src/projections/` directory is where it belongs, and Task 0 amendment 6 registers that path. Both are rebuilt by the one job, which is a fact about the *job*, not about where the code lives. (2) **There is no `packages/db/seed/my/reports/4b/` directory and no `ReportDefinition` anywhere in this slice.** §4.16.1's rule is that a minimal-set slice ships its report as a route over a named read function and 7C re-expresses it as a definition under the same code at `version = 2`; a `4b/` seed directory would be 7C's work done early and would need a `reports` sub-pack loader that 7A owns.

---

### Task 0: Contracts amendments and the 4A/3B/3C/3D repo gate

**This task carries no application code.** It does two things: it writes down every name this slice must add to the contracts document because the registry lacks it, and it *checks the repository* for the seventeen names from 4A, 3B, 3C and 3D that every later task imports. 4A's plan file did not exist when this plan was written, so its names came from the registry rather than from a written plan — this gate is where that assumption is tested, once, before any code depends on it.

**Files:**
- Create: `scripts/check/contracts-4b-amendments.sh`
- Create: `tests/invariants/support/ar-ap.ts` (the file amendment 9 registers; Task 3 fills it)
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` — the twelve amendments below

**Interfaces**

- Consumes: nothing at runtime. The gate script reads the repository with `grep` and `test -f`.
- Produces: `scripts/check/contracts-4b-amendments.sh` (exit 0 = every amendment landed and every consumed name exists; exit 1 = a `MISSING` line names what is absent).

- [ ] **Step 1: Write the twelve amendments into the contracts document**

Each is one edit, in the section named. **Do not proceed to Task 1 until all twelve are in the file** — every later task cites them by number.

| # | § | Amendment |
|---|---|---|
| **1** | 4.2.6 | **`JobPayload` gains the one 4B-owned key: `"accounting.projection.rebuild": { companyId?: string; asOf?: string }`, and `JOB_PROBES` gains an entry for it** (hazard 31). The shape is 3B's `inventory.projection.rebuild` key verbatim, deliberately: both are "rebuild this company's async projections as of this date", the two handlers are twins, and a reader who has seen one has seen both. **`JOBS` itself is not edited** — the name and its `"0 3 * * *"` schedule are already in 0B's closed sixteen-name const with `owner: "4B"`. |
| **2** | 4.3.2 | **Step 14's `accounting.projection.rebuild` clause is realised here, and it does *not* fail closed.** After step 13, `postDocument` enqueues `accounting.projection.rebuild` with `singletonKey = companyId` and `startAfterSeconds = 60` when the document has a `party_id` **or** the plan carried movements. **When `input.jobs` is absent it pushes a warning onto `PostResult.warnings` and skips the enqueue** — the opposite of 3B's fail-closed step-14 branch, and the difference is the severity of the omission: a missed cost replay leaves a *wrong* number in the ledger for ever (SAH-005), while a missed projection enqueue leaves a *stale as-of snapshot* that the nightly `accounting.projection.rebuild` recomputes and the nightly compare would flag. Throwing here would break every 4A call site that supplies no `JobClient`. |
| **3** | 4.8.2 | **The ageing arithmetic is one SQL function, `app.party_ageing_rows(p_company uuid, p_as_of date)`, created by migration 0048**, and the projection table, the report and the rebuild-and-compare all read it. Its contract: one row per `(party, currency, bucket)` with a non-zero open figure; `amount` in the document's currency and `base_amount` at each open document's **own** rate; buckets cut on `document.effective_date + coalesce(payment_term.due_days, 0)` resolved through `party.payment_term_id`; a party's control account chosen by `kind` (`vendor` → `coalesce(payable, receivable)`, otherwise `coalesce(receivable, payable)`) with the vendor side sign-flipped so an open figure is positive in both directions; a settlement document's consumption measured as `allocation.base_amount + allocation.fx_difference` (the settlement base), which is what makes the tie-out hold once the realised FX difference has posted. **The DoD tie-out is stated in base only** — see amendment 4. |
| **4** | 4.8.2 | **The tie-out is base-only, and per-currency equality is not claimed.** §4.8.2 says "Σ buckets per party to the AR/AP control-account balance"; in a cross-currency settlement that equality is *false* per currency and *true* in base. A EUR invoice part-paid by a USD receipt leaves the control account with a EUR debit row and a USD credit row in `account_balance`, while the ageing shows the invoice's residual EUR and nothing in USD — the two views agree on base and cannot agree per currency, because `allocation.amount` is denominated in the **settled** document's currency and no column denominates it in the settlement's. The registered tie-out is therefore `Σ base_amount == ledger base of the control account − outstanding unrealised revaluation on it`, computed by `ageingTieOut` (Task 3), and **`account_balance`'s per-currency rows on a party control account are not an open-item view; no report reads them as one.** A same-currency month satisfies the per-currency equality as well, and Task 3 Step 8 asserts that case separately. |
| **5** | 4.14 (`FX_REVALUATION` row) | **Realised and unrealised FX share the one registered code, and the marker is `document_line.custom_fields.fxKind ∈ 'realised' \| 'unrealised'` on every line of the document.** `app.document` has **no** `custom_fields` column (plan0A's DDL) and §4.4.1 A6's `when["document.kind"]` reads *header* custom fields, which are `app.custom_field_value` rows needing a `custom_field_definition` per company — machinery a job cannot create. The line bag needs neither, is already `jsonb not null default '{}'`, and is copied by `reverseDocument` along with the rest of the line. The key is spelled `fxKind`, not `kind`, so it can never be confused with `document_line.kind` (a column) or with 6A's `custom_fields.method`. **Only the unrealised document is reversed at period start**; a realised difference is never reversed on its own — reversing the settlement is what undoes it. A realised document additionally carries `settlementDocumentId`, `settledDocumentId` and `partyId` on its lines, and an `app.document_link` row (`link_kind = 'settles'`, source = the FX document, target = the settlement) is its idempotency key. |
| **6** | 4.6.1 | **`packages/db/src/projections/item-profitability.ts` is the home of `item_profitability`'s rebuild and read**, and `app.item_profitability_rows(p_company uuid, p_sale_types text[])` (migration 0048) is the one definition of its arithmetic. The **sale-type membership** is `SALE_MOVEMENT_TYPES`, a `readonly string[]` in that module — `["DELIVERY_ORDER", "SALES_INVOICE", "SALES_CREDIT_NOTE"]` at 4B, **`"POS_TICKET"` appended by 6A** — with a companion `NON_SALE_MOVEMENT_TYPES` and an exhaustiveness test that fails when a *seeded* document type with a stock effect appears in neither list, so the slice that adds a type must classify it. **It is membership only and carries no sign**: the direction of revenue is read from the ledger per document (amendment 7) and the direction of quantity and cost from the movement's own sign, because a reversal-produced `SALES_CREDIT_NOTE` carries negated line amounts (§4.4.2 A9) and a hand-drafted one does not, so a type → sign map would be right for one and wrong for the other. |
| **7** | 4.6.1 | **`item_profitability`'s attribution, in three sentences.** `quantity_sold` = `Σ −inventory_movement.quantity` over the sale documents' movements, so an issue adds and a return subtracts. `cogs_base` = per movement, `Σ cost_consumption.value` for an issue and `−(cost_layer.qty_in × unit_cost)` for a receipt, both `where invalidated_at is null` — **the same `cost_consumption` source 3D's `salesByItem` chose over `document_line.cost`, for 3D's reason: only consumptions and layers are rewritten by `inventory.cost.replay`, so a projection reading `document_line.cost` would show the pre-recost figure for ever.** `revenue_base` = `doc_sign × Σ round(abs(document_line.amount) × document.exchange_rate, 4)` over the document's item lines, where `doc_sign` is `+1` unless the document's ledger rows on the **item's own `revenue_account_id`** net to a debit, in which case `−1`; a document with no such ledger row (a `DELIVERY_ORDER`, which posts to `1250`) contributes quantity and cost and **no revenue**, and a `SALES_INVOICE` linked to a delivery contributes revenue and no movement — which is exactly how the two-document path lands both halves on one `(item, period)` row. |
| **8** | 4.15 | ⚠️ **`1150` Cheques in hand, asset, seeded by 4B in `packages/db/seed/my/chart-of-accounts/4b-pdc.json`, resolved by `PDC_RECEIPT` (debit) and `PDC_DEPOSIT` (credit) — conditional on OD-09.** The register has no cheque-in-hand account and spec:1044's "cheque-in-hand asset with maturity date" needs one. `1150` is free between `1130` (6D) and `1200` (0C). **If OD-09 = no, neither the file nor the row exists and this line stays allocated-but-unseeded**, exactly as §4.16.2 treats the `pdc` `DatasetId`. |
| **9** | 4.17.1 | **`tests/invariants/support/ar-ap.ts`, owner 4B**, exporting **`PACK_DIR`** (an ABSOLUTE seed-pack directory with a trailing separator — named `PACK_DIR` and **not** `PACK_ROOT`, because 4A's `PACK_ROOT` in `packages/db/test/ar-ap/_support.ts` is the RELATIVE `"seed/my"` that `readPackFile` takes as its first argument, and the two shapes are not interchangeable), `seedTypeFromPack(db, s, code)`, `packApproval(code)` with its `PackApproval` type, `postFromPack(db, s, opts)` with `PostFromPackOptions`, `arApFixture(db, s)` and the `ArApFixture` type. `seedTypeFromPack` reads **4A's own shipped seed envelope** from `packages/db/seed/my/document-types/<CODE>.json` through `readPackFile` and configures it with 2A's `seedDocumentType`, so no test in this slice restates a policy 4A owns and a change to 4A's file is a test failure rather than a silent divergence (the alternative — 3D's "copy the policy into a constant and assert equality" — needs the policy text, which this plan does not have). Five files consume them, which is why they are shared and not file-local (hazard 9). |
| **10** | 4.16.3 | **4B adds `agedBalance` (`packages/db/src/reports/ageing.ts`) with `AgedBalanceParams` and `AgedBalanceRow` to the Phase 1 report surface, and widens `ReportCodeSchema` by `accounting.ageing`.** 7C re-expresses the code over this function, so the name is contract. **4B adds no `DatasetId` member** — 7A's ≤ 0058 set already names `party_ageing`, `item_profitability`, `bank_statement_line`, `bank_match` and `pdc`. |
| **11** | 4.2.4 (the declaration, contracts:1586–1589) + §4.3.1 / §4.3.8 (the cross-references) | **`PostingErrorCode` gains a tenth member, `"ERR_RATE_NOT_FOUND"`.** The edit is one line: contracts:1589's `  \| "ERR_LEDGER_UNBALANCED";` becomes `  \| "ERR_LEDGER_UNBALANCED" \| "ERR_RATE_NOT_FOUND";`, keeping the trailing comment. **Nothing else moves, and this is a registry correction rather than a new decision:** §4.3.8 (contracts:2294) already lists `ERR_RATE_NOT_FOUND` among the errors the posting service raises, and `ERRORS` has carried the row since **0D** (contracts:1542, 1575), so `PostingErrorCode` stays a literal subset of `ErrCode` and 1A's `if (e instanceof PostingError) return new AppError(e.code, e.detail)` branch still type-checks **with no cast** (phase-1a:2455). 1A declared the union with nine members (phase-1a:2204–2213) because Phase 1 had no rate-resolving code path inside `packages/db`; **4B is the first slice that does** — `revalueAtPeriodEnd` calls `app.rate_for` in `packages/db/src/ar-ap/fx.ts`, which may not import `@dulja/contracts` (§3.1) and therefore cannot raise `AppError` the way 0D's and 1A's *handlers* do (phase-0d:3684, phase-1a:4796). Task 5 makes the one-line edit to `packages/db/src/posting/errors.ts`; **no cast, no second error class.** |
| **12** | 4.2.8 | **A row's money column may be a bare signed 4-dp decimal string when the row carries its own `currency` exactly once**, and 4B's `packages/contracts/src/accounting/bank.ts` and the ageing DTOs in `accounting/reports.ts` do that. §4.2.8's "Money is always `{ amount, currency }`" is written for a *field*, and repeating the currency on seven bucket columns of one ageing row — five buckets, `total` and `totalBase` — would put the same three characters in the payload seven times and force the ageing handler to read `company.base_currency` for `totalBase` alone, a query the report does not otherwise make. **This registers shipped practice rather than inventing an exception:** 1A's `DocumentLineSchema` already declares `debit: Amount, credit: Amount` over `const Amount = z.string().regex(/^\d+\.\d{4}$/)` with the currency on the document header (phase-1a:4638). The registered form is `const Amount = z.string().regex(/^-?\d+\.\d{4}$/)` — **file-local, never a `common.ts` export**, because a shared name would invite a slice to reach for it where `MoneySchema` is right. `MoneySchema` remains the rule for a standalone amount: `CreateBankMatchBody.amount`, `ReconciledBalanceSchema.statement`/`.ledger` and `ReconcilableSchema.amount` all use it. **A slice wanting a third form amends this paragraph first.** |

- [ ] **Step 2: Write the gate script**

```bash
#!/usr/bin/env bash
# scripts/check/contracts-4b-amendments.sh
# Slice 4B's pre-flight. Two halves: the twelve contracts amendments of Task 0, and the seventeen
# repository names Tasks 3-12 import from 4A, 3B, 3C and 3D. Exit 1 on the first missing thing.
set -uo pipefail
CONTRACTS="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0

need_contract() {   # need_contract <literal> <amendment number>
  if ! grep -qF -- "$1" "$CONTRACTS"; then
    echo "MISSING (contracts amendment $2): $1"
    fail=1
  fi
}

need_repo() {       # need_repo <file> <literal> <what it is>
  if [ ! -f "$1" ]; then
    echo "MISSING (repo): $1 does not exist — $3"
    fail=1
  elif ! grep -qF -- "$2" "$1"; then
    echo "MISSING (repo): $2 is not in $1 — $3"
    fail=1
  fi
}

# ── The twelve amendments ───
need_contract 'accounting.projection.rebuild": { companyId?: string; asOf?: string }' 1
need_contract 'pushes a warning onto `PostResult.warnings` and skips the enqueue' 2
need_contract 'app.party_ageing_rows(p_company uuid, p_as_of date)' 3
need_contract 'The tie-out is base-only, and per-currency equality is not claimed' 4
need_contract "custom_fields.fxKind" 5
need_contract 'app.item_profitability_rows(p_company uuid, p_sale_types text[])' 6
need_contract 'SALE_MOVEMENT_TYPES' 6
need_contract 'doc_sign' 7
need_contract '`1150` Cheques in hand' 8
need_contract 'tests/invariants/support/ar-ap.ts' 9
need_contract 'agedBalance' 10
# Amendments 11 and 12 need literals that occur NOWHERE else in the contracts document. Bare
# 'ERR_RATE_NOT_FOUND' would match §4.2.4's registry row and §4.3.8's list, both of which predate
# this slice, so the check is against the widened union's own line and against amendment 12's sentence.
# NOTE the single line: need_contract passes $1 to `grep -F`, and a multi-line pattern there means
# "match ANY of these lines", which would pass on the un-widened union.
need_contract '| "ERR_LEDGER_UNBALANCED" | "ERR_RATE_NOT_FOUND";' 11
need_contract 'may be a bare signed 4-dp decimal string when the row carries its own' 12

# ── The seventeen repository names every later task imports ───
need_repo packages/db/src/ar-ap/index.ts 'export * from "./allocation"' \
  '4A owns this barrel and packages/db/src/index.ts re-exports ./ar-ap — Tasks 3, 5, 6, 7 APPEND to it and never rewrite it. If 4A spells the line differently, adjust this literal; if the file is absent, 4A has not landed and no task past Task 2 may start'
need_repo packages/db/src/ar-ap/allocation.ts 'export async function allocateSettlement' \
  '4A §4.8.1 — Task 5 wraps it'
need_repo packages/db/src/ar-ap/allocation.ts 'export async function partyBalance' \
  '4A §4.8.1 — Task 5 Step 8, test 8 clause 6, asserts its BASE member only'
need_repo packages/db/test/fixtures.ts 'export async function seedPaymentTerm' \
  '4A §4.17 — Task 3 varies due_days with it'
need_repo packages/db/test/fixtures.ts 'export async function draftTypedDocument' \
  '3C §4.17 amendment — every drafting test in this slice'
need_repo packages/db/seed/my/document-types/SALES_INVOICE.json '"code": "SALES_INVOICE"' \
  '4A §4.14 — seedTypeFromPack reads this file'
need_repo packages/db/seed/my/document-types/RECEIPT.json '"code": "RECEIPT"' \
  '4A §4.14 — the settlement side of tests 8 and 39'
need_repo packages/db/seed/my/document-types/PAYMENT.json '"code": "PAYMENT"' \
  '4A §4.14 — the payment side of test 39'
need_repo packages/db/src/posting/post.ts 'jobs?: JobClient' \
  '3B amendment A5 — Task 4 Step 6 adds step 14 through this seam'
need_repo tests/invariants/support/post-inventory.ts 'export async function ensureOpenPeriods' \
  '3B §4.17.1 — every test in this slice that posts outside 2026-01'
need_repo tests/invariants/support/post-inventory.ts 'export async function secondPrincipal' \
  '3D §4.17.1 amendment — Task 12 R1 case'
need_repo packages/db/src/reports/sales-by-item.ts 'cost_consumption' \
  '3D §4.16.3 — amendment 7 uses the identical cost source'
need_repo tests/invariants/support/post-ar.ts 'export async function postArDocument' \
  '4A §4.17.1 — see the RELATIONSHIP note after this script: postFromPack is deliberately not it'
need_repo packages/db/test/ar-ap/_support.ts 'PACK_ROOT' \
  '4A — 4B names its own constant PACK_DIR so the two cannot be confused; see the RELATIONSHIP note after this script'
need_repo packages/db/seed/my/document-types/GOODS_RECEIPT.json '"code": "GOODS_RECEIPT"' \
  '3C §4.14 — Task 4 creates its cost layer with it; postFromPack reads the file for its approval block'
need_repo packages/db/seed/my/document-types/DELIVERY_ORDER.json '"code": "DELIVERY_ORDER"' \
  '3D §4.14 — Task 4 proves a delivery contributes quantity and cost and NO revenue'
need_repo packages/db/seed/my/document-types/EXPIRY_WRITE_OFF.json '"code": "EXPIRY_WRITE_OFF"' \
  '3D §4.14 — Task 4 posts it, and it is the approval-REQUIRED case postFromPack derives its path from'

# ── Three facts, not names: report them, do not fail on them ───  (two of them steer Tasks 3 and 5;
#     the third is belt-and-braces on a guard seedTypeFromPack keeps either way)
echo "--- informational ---"
echo -n "4A due-date column on app.document: "
if grep -rqE 'add column +(due_date|due_days)' packages/db/migrations/004[4-7]_*.sql 2>/dev/null; then
  echo "PRESENT — Task 3 must read it instead of deriving from party.payment_term_id"
else
  echo "absent — Task 3 derives effective_date + coalesce(payment_term.due_days, 0) (amendment 3)"
fi
echo -n "app.document_link INSERT trigger (3C migration 0037): "
if grep -qE 'create trigger .* on app\.document_link' packages/db/migrations/0037_*.sql 2>/dev/null; then
  echo "PRESENT — Task 5 must not insert document_link directly; use the fxKind probe alone"
else
  echo "absent — Task 5 may insert the 'settles' link row directly (amendment 5)"
fi
echo -n "2A seedDocumentType is idempotent: "
if grep -qE 'on conflict' packages/db/test/fixtures.ts 2>/dev/null &&
   grep -A12 'export async function seedDocumentType' packages/db/test/fixtures.ts 2>/dev/null |
     grep -qE 'on conflict'; then
  echo "yes (on conflict) — seedTypeFromPack's select-or-insert guard is belt and braces"
else
  echo "no — seedTypeFromPack's select-or-insert guard is REQUIRED; postFromPack calls it per post"
fi

[ "$fail" -eq 0 ] && echo "contracts-4b: OK"
exit "$fail"
```

- [ ] **Step 3: Run the gate and see it pass**

```bash
chmod +x scripts/check/contracts-4b-amendments.sh
bash scripts/check/contracts-4b-amendments.sh
```

Expected, once Step 1's twelve amendments are in the file and 4A/3B/3C/3D are merged:

```
--- informational ---
4A due-date column on app.document: absent — Task 3 derives effective_date + coalesce(payment_term.due_days, 0) (amendment 3)
app.document_link INSERT trigger (3C migration 0037): absent — Task 5 may insert the 'settles' link row directly (amendment 5)
2A seedDocumentType is idempotent: no — seedTypeFromPack's select-or-insert guard is REQUIRED; postFromPack calls it per post
contracts-4b: OK
```

**A `MISSING (repo):` line is a reconciliation with the owning plan, never a workaround here.** The owning plan is the authority for what it exports (§4.18's rule): if `allocateSettlement` is not at `packages/db/src/ar-ap/allocation.ts`, correct **this** plan's import path to 4A's; if `seedPaymentTerm` is absent, 4A skipped a §4.17 row and that is a 4A correction. Stop and raise.

**RELATIONSHIP — 4A's `postArDocument` and this slice's `postFromPack`, and 4A's `PACK_ROOT` and this slice's `PACK_DIR`.** The two `need_repo` lines naming `post-ar.ts` and `_support.ts` exist because 4A registered a §4.17.1 helper of its own, `postArDocument` in `tests/invariants/support/post-ar.ts`, whose register row names **4B** as a consumer. Read both before writing `postFromPack`, and then apply these two rules.

- **`postFromPack` is deliberately not `postArDocument`, and neither replaces the other.** `postArDocument` takes a `documentTypeId` the caller has already resolved and an opt-in `twoPrincipal: boolean`; `postFromPack` takes a **code**, resolves the type from the pack file itself, and reads `approval.required` **out of that same envelope** so no call site can forget the flag — which is what makes Task 4's `EXPIRY_WRITE_OFF` and Task 7's `PAYMENT` post at all. It also threads three members `PostArOptions` has no room for: `jobs` (3B amendment A5, the seam Task 4 Step 5's warn-and-skip case is written against), `warehouseId` (the header column `GOODS_RECEIPT` and `DELIVERY_ORDER` resolve) and `allocate` (4A's `allocateSettlement` in the post's own transaction, which is Task 5's whole subject). **A task that only needs "post an invoice against a party" should call `postArDocument`;** this slice's tasks all need at least one of the three, so they call `postFromPack`. Say so in the PR body rather than leaving a reviewer to find two helpers and guess.
- **4A's `PACK_ROOT` and 4B's `PACK_DIR` are different values, and that is why they carry different names.** 4A ships `export const PACK_ROOT = "seed/my";` (phase-4a:3044) — a **relative** pack root whose only consumer is `readPackFile(root, ...)` (§4.2.13), which resolves it itself. Amendment 9 registers 4B's as **`PACK_DIR`**: an **absolute** directory with a trailing separator, because its two consumers are a bare `readFileSync(`${PACK_DIR}document-types/<CODE>.json`)` in `readEnvelope` and a `join(PACK_DIR, "document-types")` + `readdirSync` glob in Task 4's exhaustiveness guard, neither of which goes through `readPackFile`. **Do not "unify" them by importing 4A's constant into `ar-ap.ts`** — an earlier draft of this note said to, and it was wrong: substituting `"seed/my"` at either call site yields `"seed/mydocument-types/..."` resolved against the process working directory, which fails as a **missing file at run time** rather than as a type error at compile time. One name, one shape, one accessor each; neither file imports the other's. **What the executor still owes the catalogue** is the PR-body note amendment 9 asks for: two constants now name one directory in two shapes, §4.17.1 should record both rows, and if the catalogue later gives `readPackFile` an absolute-root overload the two may be collapsed **in that PR and not in this one**. Task 4's exhaustiveness guard globs `PACK_DIR`.

- [ ] **Step 4: Create the empty shared-helper file with its header**

Task 3 fills it. Creating it here means amendment 9's registered path exists before five tasks import it, and a reviewer reading the register can open the file.

```ts
// tests/invariants/support/ar-ap.ts
//
// Slice 4B's shared AR/AP test helpers (contracts §4.17.1, amendment 9). Four exports, consumed by
// packages/db/test/ar-ap/*.test.ts, tests/invariants/test-08-multi-currency.test.ts and
// tests/invariants/test-39-bank-reconciliation.test.ts.
//
// `seedTypeFromPack` deliberately reads 4A's OWN shipped envelope off disk rather than restating a
// policy 4A owns: a change to packages/db/seed/my/document-types/SALES_INVOICE.json then shows up as a
// test failure in this slice instead of as a silent divergence between a copied constant and the pack.
//
// Filled by Task 3 Step 3.
export {};
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md \
        scripts/check/contracts-4b-amendments.sh tests/invariants/support/ar-ap.ts
git commit -m "docs(plans): record slice 4B's twelve contracts amendments and its repo gate [4B T0]

Twelve amendments the registry lacked: the accounting.projection.rebuild payload key and its
probe; step 14's warn-and-skip branch (deliberately not 3B's fail-closed one); the ageing
arithmetic as one SQL function and its base-only tie-out; the fxKind line marker and why the
document header cannot carry it; item_profitability's home, its membership-only type list and
its three-sentence attribution; the conditional 1150 chart row; the shared ar-ap test helpers;
agedBalance in the Phase 1 report surface; PostingErrorCode's tenth member ERR_RATE_NOT_FOUND,
which §4.3.8 and 0D's ERRORS have both listed since 0D but which 1A's nine-member union omits
because Phase 1 had no rate lookup inside packages/db; and the bare 4-dp row-money form 1A's
DocumentLineSchema already ships, registered rather than re-invented.

The gate script additionally checks the seventeen 4A/3B/3C/3D names every later task imports,
because 4A's plan file did not exist when this plan was written and its names came from the
contracts registry rather than from a written plan.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Migration 0048 — `party_ageing`, `item_profitability` and the two SQL functions that define their arithmetic

**PR 1 of 5.** One migration file creating two projection tables and two `stable` SQL functions. The functions matter more than the tables: they are the **only** definition of the ageing arithmetic and of the item split, and the projection rebuild, the two reports and the nightly rebuild-and-compare all read them, so a report and its integrity check cannot disagree about what a figure is. This is `app.rate_for` (§4.2.10) and `app.series_gaps` (§4.5.5) applied to a projection.

**Neither function is `SECURITY DEFINER`.** They are plain `language sql stable`, so every row they read is already filtered by `tenant_isolation` and by `FORCE ROW LEVEL SECURITY` as the caller — which is what makes Step 6's two-tenant assertion *through the function* meaningful rather than decorative. A `SECURITY DEFINER` here would be a tenancy hole (the reasoning §4.5.6 gives for `actor_in_warehouse`).

**Files:**
- Create: `packages/db/migrations/0048_create_party_ageing_item_profitability.sql`, `packages/db/migrations/0048.down.sql`
- Create: `packages/db/src/schema/party-ageing.ts`, `packages/db/src/schema/item-profitability.ts`
- Create: `packages/db/test/ar-ap/party-ageing.test.ts`
- Modify: `packages/db/src/lint-schema.ts` (four set memberships, to exactly §3.5.3's state)

**Interfaces**

- Consumes: `app.tenant`, `app.company`, `app.fiscal_period`, `app.document`, `app.document_line`, `app.ledger_entry` (plan0A); `app.party` (2A, §4.5.7); `app.payment_term`, `app.allocation` (4A, §4.6.1, §4.8.1); `app.item` with `revenue_account_id`/`cogs_account_id` (3A, §4.6.1); `app.inventory_movement` (3A, §4.7.3); `app.cost_layer`, `app.cost_consumption` (3B, §4.7.3); `app_meta.enable_tenant_rls` (§4.1); `startDb`, `Db`, `Seed`, `seedTenant`, `uuidv7`, the 4-argument test `withTenant`, `lintSchema`, `AUDIT_EXEMPT`, `up`, `down`, `listApplied`, `discover`, `schemaFingerprint` (§4.1).
- Produces:
  - `app.party_ageing (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount, created_at, updated_at)` with `primary key (company_id, party_id, currency, as_of, bucket)` — §4.6.1 verbatim.
  - `app.item_profitability (tenant_id, company_id, item_id, fiscal_period_id, quantity_sold, revenue_base, cogs_base, margin_base, created_at, updated_at)` with `primary key (company_id, item_id, fiscal_period_id)` — §4.6.1 verbatim.
  - `app.party_ageing_rows(p_company uuid, p_as_of date) returns table (party_id uuid, currency char(3), bucket text, amount numeric(19,4), base_amount numeric(19,4))` — amendment 3.
  - `app.item_profitability_rows(p_company uuid, p_sale_types text[]) returns table (item_id uuid, fiscal_period_id uuid, quantity_sold numeric(19,6), revenue_base numeric(19,4), cogs_base numeric(19,4), margin_base numeric(19,4))` — amendments 6 and 7.
  - Drizzle mirrors `partyAgeing` and `itemProfitability` (§3.4.9).

- [ ] **Step 1: Write the failing test**

`packages/db/test/ar-ap/party-ageing.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema, listApplied } from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedParty, seedTenant, type Seed } from "../fixtures";

let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenant(db, "ageing-a");
  b = await seedTenant(db, "ageing-b");
}, 180_000);
afterAll(async () => { await db?.stop(); });

describe("migration 0048 — the two async projections (§4.6.1, spec:1204)", () => {
  it("applies as version 48", async () => {
    expect(await listApplied(db.migrator)).toContain(48);
  });

  it("both tables carry the §3.3 binding form: tenant_id, forced RLS, one policy named tenant_isolation, created_at", async () => {
    for (const table of ["party_ageing", "item_profitability"]) {
      const [rel] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relrowsecurity, relforcerowsecurity from pg_class
         where oid = ${`app.${table}`}::regclass`;
      expect(rel, table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });

      const policies = await db.admin<{ policyname: string; permissive: string }[]>`
        select policyname, permissive from pg_policies
         where schemaname = 'app' and tablename = ${table} order by policyname`;
      expect(policies.map((p) => p.policyname), table).toEqual(["tenant_isolation"]);

      const cols = await db.admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'app' and table_name = ${table} order by column_name`;
      const names = cols.map((c) => c.column_name);
      expect(names, table).toContain("tenant_id");
      expect(names, table).toContain("created_at");
      expect(names, table).not.toContain("id");        // both join NO_ID_TABLES: a natural key
    }
  });

  it("the two primary keys are §4.6.1's natural keys", async () => {
    const pk = async (table: string) => {
      const rows = await db.admin<{ attname: string }[]>`
        select a.attname from pg_index i
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = ${`app.${table}`}::regclass and i.indisprimary
         order by array_position(i.indkey, a.attnum)`;
      return rows.map((r) => r.attname);
    };
    expect(await pk("party_ageing")).toEqual(["company_id", "party_id", "currency", "as_of", "bucket"]);
    expect(await pk("item_profitability")).toEqual(["company_id", "item_id", "fiscal_period_id"]);
  });

  it("app_rw may select, insert and update both, and may NOT delete either (§3.5.4's pinned list is unchanged)", async () => {
    const grants = await db.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app'
         and table_name in ('party_ageing', 'item_profitability')
       order by table_name, privilege_type`;
    const of = (t: string) => grants.filter((g) => g.table_name === t).map((g) => g.privilege_type).sort();
    expect(of("party_ageing")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(of("item_profitability")).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("the bucket vocabulary is a named CHECK, not an enum (§3.4.4, hazard 11)", async () => {
    const [chk] = await db.admin<{ pg_get_constraintdef: string }[]>`
      select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'app.party_ageing'::regclass and conname = 'party_ageing_bucket_check'`;
    expect(chk?.pg_get_constraintdef).toContain("'current'");
    expect(chk?.pg_get_constraintdef).toContain("'over_90'");
  });

  it("both SQL functions exist, are STABLE and are NOT security definer", async () => {
    const fns = await db.admin<{ proname: string; provolatile: string; prosecdef: boolean }[]>`
      select proname, provolatile, prosecdef from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and proname in ('party_ageing_rows', 'item_profitability_rows')
       order by proname`;
    expect(fns).toHaveLength(2);
    for (const f of fns) {
      expect(f.provolatile, f.proname).toBe("s");     // STABLE
      expect(f.prosecdef, f.proname).toBe(false);     // never SECURITY DEFINER (§4.5.6's reasoning)
    }
  });

  it("both functions return zero rows for a company with no documents", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const ageing = await tx`select * from app.party_ageing_rows(${a.company}, '2026-01-31'::date)`;
      expect(ageing).toEqual([]);
      const profit = await tx`
        select * from app.item_profitability_rows(${a.company}, array['SALES_INVOICE']::text[])`;
      expect(profit).toEqual([]);
    });
  });

  it("tenant B cannot see tenant A's projection rows, by table or through the function (test 12)", async () => {
    // A party FIRST. Without it the insert below selects zero rows and the test proves nothing: B would
    // read an empty table because the table IS empty, not because RLS hid anything. An isolation test
    // that cannot fail is worse than no isolation test — it is a green light with no bulb behind it.
    const partyA = await seedParty(db, a, { kind: "customer", code: "ISO-C",
                                           receivableAccountId: a.cash });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`
        insert into app.party_ageing (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount)
        values (${a.tenant}, ${a.company}, ${partyA}, 'MYR', '2026-01-31'::date, 'current', 100, 100)`;
      // Prove A can see its own row, so the zero B reads below is attributable to RLS and nothing else.
      const [own] = await tx<{ n: number }[]>`select count(*)::int as n from app.party_ageing`;
      expect(own!.n).toBe(1);
    });
    await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.party_ageing`;
      expect(n!.n).toBe(0);
      const rows = await tx`select * from app.party_ageing_rows(${a.company}, '2026-01-31'::date)`;
      expect(rows).toEqual([]);      // A's company id is visible as a uuid, its rows are not
    });
  });

  it("lintSchema reports zero violations after 0048 (§3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- ar-ap/party-ageing
```

Expected — the migration does not exist, so `listApplied` stops at 47 and the first `regclass` cast throws:

```
FAIL  test/ar-ap/party-ageing.test.ts > migration 0048 … > applies as version 48
AssertionError: expected [ 1, 2, …, 47 ] to include 48

FAIL  test/ar-ap/party-ageing.test.ts > … > both tables carry the §3.3 binding form
PostgresError: relation "app.party_ageing" does not exist
```

- [ ] **Step 3: Write the up migration**

`packages/db/migrations/0048_create_party_ageing_item_profitability.sql`:

```sql
-- 0048_create_party_ageing_item_profitability.sql
--
-- The two ASYNCHRONOUS projections spec:1204 names beside stock_valuation: "Asynchronous ones
-- (party_ageing, item_profitability, stock_valuation history) are pg-boss jobs. All of them are rebuilt
-- from ledger_entry/inventory_movement into scratch tables nightly and compared row for row; a mismatch
-- is an incident."  Derived, never hand-edited (SAH-001, 002, 013, 049, 050).
--
-- Neither table is written by the posting service, so neither joins the posting-only-tables lint
-- (contracts §3.7.5 names all three async projections as exclusions); their only writers are
-- packages/db/src/ar-ap/ageing.ts and packages/db/src/projections/item-profitability.ts.

-- ── 1. app.party_ageing — the as-of open-item ageing snapshot (§4.6.1, §4.8.2) ───
create table app.party_ageing (
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  party_id     uuid not null,
  currency     char(3) not null,
  as_of        date not null,
  bucket       text not null,
  -- SAH-011: every monetary column is NOT NULL DEFAULT 0. One NULL in an accumulation nulled a whole
  -- period's balance in the old system and only a table rebuild recovered it.
  amount       numeric(19,4) not null default 0,      -- the open document's own currency
  base_amount  numeric(19,4) not null default 0,      -- SAH-012: base = value × rate, at each open document's OWN rate
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint party_ageing_bucket_check
    check (bucket in ('current', '1_30', '31_60', '61_90', 'over_90')),
  primary key (company_id, party_id, currency, as_of, bucket),   -- the full natural key the MERGE targets (SAH-002/049)
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, party_id)   references app.party(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.party_ageing');
-- Derived projection: no audit trigger (joins AUDIT_EXEMPT), no id (joins NO_ID_TABLES, and therefore the
-- derived NO_CREATED_AT_TABLES too — the created_at column is kept anyway, as account_balance and
-- stock_on_hand keep theirs, because spec:106's Always list names it for every new table).
-- No branch_isolation form: the table has no branch key and is not one of §4.5.6 Form C's five stock tables.
-- app_rw receives select/insert/update through default privileges (plan0A:2564); DELETE is NOT granted —
-- §3.5.4's list is pinned and 2B is the only slice that extends it, so the rebuild MERGEs and zeroes.
create index party_ageing_as_of_idx on app.party_ageing (company_id, as_of, party_id);

-- ── 2. app.item_profitability — revenue, COGS and margin per item per fiscal period (§4.6.1) ───
create table app.item_profitability (
  tenant_id        uuid not null references app.tenant(id),
  company_id       uuid not null,
  item_id          uuid not null,
  fiscal_period_id uuid not null,
  quantity_sold    numeric(19,6) not null default 0,   -- base unit; an issue adds, a return subtracts
  revenue_base     numeric(19,4) not null default 0,
  cogs_base        numeric(19,4) not null default 0,
  margin_base      numeric(19,4) not null default 0,   -- revenue_base − cogs_base, stored so a report never recomputes it
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (company_id, item_id, fiscal_period_id),
  foreign key (tenant_id, company_id)       references app.company(tenant_id, id),
  foreign key (tenant_id, item_id)          references app.item(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.item_profitability');
create index item_profitability_period_idx on app.item_profitability (company_id, fiscal_period_id);

-- ── 3. app.party_ageing_rows — the ONE definition of the ageing arithmetic (§4.8.2, amendment 3) ───
--
-- STABLE and NOT security definer, so every row below is already filtered by tenant_isolation and by
-- FORCE ROW LEVEL SECURITY as the caller (the reasoning §4.5.6 gives for actor_in_warehouse).
--
-- Buckets are cut on the DUE date — document.effective_date + the party's payment term (spec:1042's
-- "payment terms"); a document with no term is due on its effective date.
-- A party's control account is chosen by kind, so a party carrying both defaults is not netted:
-- vendor → coalesce(payable, receivable), anything else → coalesce(receivable, payable), and the vendor
-- side is sign-flipped so "open" is a positive figure in both directions.
create function app.party_ageing_rows(p_company uuid, p_as_of date)
returns table (party_id uuid, currency char(3), bucket text, amount numeric(19,4), base_amount numeric(19,4))
language sql stable as $$
  with control as (
    -- one row per posted party document up to p_as_of: what it charged the party, in its own currency and in base
    select d.id,
           d.party_id,
           d.currency,
           d.exchange_rate,
           d.effective_date,
           coalesce(pt.due_days, 0) as due_days,
           (case when p.kind = 'vendor' then -1 else 1 end)
             * coalesce(sum(le.debit - le.credit), 0)           as charged_ccy,
           (case when p.kind = 'vendor' then -1 else 1 end)
             * coalesce(sum(le.base_debit - le.base_credit), 0)  as charged_base
      from app.document d
      join app.party p on p.id = d.party_id
      left join app.payment_term pt on pt.id = p.payment_term_id
      left join app.ledger_entry le
             on le.document_id = d.id
            and le.account_id = case when p.kind = 'vendor'
                                     then coalesce(p.payable_account_id, p.receivable_account_id)
                                     else coalesce(p.receivable_account_id, p.payable_account_id) end
     where d.company_id = p_company
       and d.status in ('posted', 'reversed')      -- a reversed document keeps its rows; its reversal cancels them
       and d.party_id is not null
       and d.effective_date <= p_as_of
     group by d.id, d.party_id, d.currency, d.exchange_rate, d.effective_date, pt.due_days, p.kind
  ),
  charged_off as (
    -- what has been settled AGAINST this document: it is the SETTLED side of an allocation
    select a.settled_document_id as id,
           sum(a.amount)      as ccy,
           sum(a.base_amount) as base
      from app.allocation a
      join app.document sd on sd.id = a.settlement_document_id
     where a.company_id = p_company
       and a.unallocated_at is null
       and sd.effective_date <= p_as_of
     group by a.settled_document_id
  ),
  applied as (
    -- what this document has APPLIED elsewhere: it is the SETTLEMENT side. Its consumption is the
    -- SETTLEMENT base — base_amount + fx_difference (§4.8.1 defines fx_difference as "settlement base −
    -- settled base") — which is exactly why the base tie-out holds once the realised FX difference has
    -- posted to the control account, and why it does not hold before (ADR 0047, amendment 4).
    --
    -- The AS-OF GUARD IS ON THE SETTLED DOCUMENT, and it is the mirror of charged_off's guard on the
    -- settlement. Without it, an allocation whose settlement is dated <= p_as_of but whose SETTLED
    -- document is dated after it — a January receipt on account applied to a February invoice, which is
    -- the ordinary deposit-then-invoice sequence, and equally ANY January report re-run after a February
    -- allocation — is subtracted from the settlement's open figure here and never added back by
    -- charged_off (the settled document is outside `control`, so charged_off's row has nothing to join
    -- to). Sigma ageing base then differs from the control account's ledger base by that allocation, and
    -- ageingTieOut's `difference` is non-zero: the exact Phase 4 DoD clause. The guard makes the pair
    -- symmetric — an allocation contributes to this function only when BOTH its documents exist as of
    -- p_as_of, which is also the only reading under which the receipt is correctly still fully open.
    select a.settlement_document_id as id,
           sum(a.base_amount + a.fx_difference) as base
      from app.allocation a
      join app.document td on td.id = a.settled_document_id
     where a.company_id = p_company
       and a.unallocated_at is null
       and td.effective_date <= p_as_of
     group by a.settlement_document_id
  ),
  per_doc as (
    select c.party_id,
           c.currency,
           case when (p_as_of - (c.effective_date + c.due_days)) <= 0  then 'current'
                when (p_as_of - (c.effective_date + c.due_days)) <= 30 then '1_30'
                when (p_as_of - (c.effective_date + c.due_days)) <= 60 then '31_60'
                when (p_as_of - (c.effective_date + c.due_days)) <= 90 then '61_90'
                else 'over_90' end as bucket,
           -- The settlement side's own-currency remainder divides its consumed base back by its own rate;
           -- the residue is at most one hundredth of a cent per document and never enters base, which is
           -- the second reason the registered tie-out is base-only (amendment 4).
           (c.charged_ccy - coalesce(co.ccy, 0)
              + case when c.exchange_rate = 0 then 0
                     else round(coalesce(ap.base, 0) / c.exchange_rate, 4) end)::numeric(19,4) as open_ccy,
           (c.charged_base - coalesce(co.base, 0) + coalesce(ap.base, 0))::numeric(19,4)        as open_base
      from control c
      left join charged_off co on co.id = c.id
      left join applied     ap on ap.id = c.id
  )
  select party_id, currency, bucket,
         sum(open_ccy)::numeric(19,4),
         sum(open_base)::numeric(19,4)
    from per_doc
   where open_ccy <> 0 or open_base <> 0
   group by party_id, currency, bucket
  having sum(open_ccy) <> 0 or sum(open_base) <> 0
$$;
revoke execute on function app.party_ageing_rows(uuid, date) from public;
grant  execute on function app.party_ageing_rows(uuid, date) to app_rw;

-- ── 4. app.item_profitability_rows — the ONE definition of the item split (amendments 6 and 7) ───
--
-- p_sale_types is a PARAMETER, not a literal list, because the membership lives in one TypeScript constant
-- (SALE_MOVEMENT_TYPES, packages/db/src/projections/item-profitability.ts) that 6A appends POS_TICKET to.
-- Membership carries no sign: a reversal-produced SALES_CREDIT_NOTE has negated line amounts and a
-- hand-drafted one does not (§4.4.2 A9), so the direction of revenue is read from the LEDGER per document
-- and the direction of quantity and cost from the movement's own sign.
create function app.item_profitability_rows(p_company uuid, p_sale_types text[])
returns table (item_id uuid, fiscal_period_id uuid, quantity_sold numeric(19,6),
               revenue_base numeric(19,4), cogs_base numeric(19,4), margin_base numeric(19,4))
language sql stable as $$
  with sale_doc as (
    select d.id, d.fiscal_period_id, d.exchange_rate
      from app.document d
      join app.document_type t on t.id = d.document_type_id
     where d.company_id = p_company
       and d.status in ('posted', 'reversed')
       and d.fiscal_period_id is not null
       and t.code = any (p_sale_types)
  ),
  doc_sign as (
    -- +1 unless this document's rows on ITS OWN items' revenue accounts net to a debit (a credit note).
    select sd.id,
           case when coalesce(sum(le.base_credit - le.base_debit), 0) < 0 then -1 else 1 end as sign,
           count(le.id) as revenue_rows
      from sale_doc sd
      left join app.ledger_entry le
             on le.document_id = sd.id
            and le.account_id in (select distinct i.revenue_account_id
                                    from app.document_line dl
                                    join app.item i on i.id = dl.item_id
                                   where dl.document_id = sd.id
                                     and i.revenue_account_id is not null)
     group by sd.id
  ),
  revenue as (
    -- Only a document that actually posted revenue contributes revenue: a DELIVERY_ORDER posts to 1250
    -- and has revenue_rows = 0, so its priced lines are NOT counted and the linked SALES_INVOICE's are.
    select sd.id as document_id, dl.item_id,
           (sum(round(abs(dl.amount) * sd.exchange_rate, 4)) * max(ds.sign))::numeric(19,4) as revenue_base
      from sale_doc sd
      join doc_sign ds on ds.id = sd.id and ds.revenue_rows > 0
      join app.document_line dl on dl.document_id = sd.id and dl.item_id is not null
     group by sd.id, dl.item_id
  ),
  movement as (
    -- Quantity and cost from the movement. cost_consumption / cost_layer and never document_line.cost:
    -- only consumptions and layers are rewritten by inventory.cost.replay, so a projection reading
    -- document_line.cost would show the pre-recost figure for ever (3D's reasoning for salesByItem).
    select sd.id as document_id, m.item_id,
           sum(-m.quantity)::numeric(19,6) as quantity_sold,
           sum(case when m.quantity < 0
                    then coalesce((select sum(c.value) from app.cost_consumption c
                                    where c.movement_id = m.id and c.invalidated_at is null), 0)
                    else -coalesce((select l.qty_in * l.unit_cost from app.cost_layer l
                                     where l.movement_id = m.id and l.invalidated_at is null), 0)
               end)::numeric(19,4) as cogs_base
      from sale_doc sd
      join app.inventory_movement m on m.document_id = sd.id
     group by sd.id, m.item_id
  ),
  joined as (
    select coalesce(r.document_id, mv.document_id) as document_id,
           coalesce(r.item_id, mv.item_id)         as item_id,
           coalesce(mv.quantity_sold, 0)           as quantity_sold,
           coalesce(r.revenue_base, 0)             as revenue_base,
           coalesce(mv.cogs_base, 0)               as cogs_base
      from revenue r
      full outer join movement mv
        on mv.document_id = r.document_id and mv.item_id = r.item_id
  )
  select j.item_id, sd.fiscal_period_id,
         sum(j.quantity_sold)::numeric(19,6),
         sum(j.revenue_base)::numeric(19,4),
         sum(j.cogs_base)::numeric(19,4),
         (sum(j.revenue_base) - sum(j.cogs_base))::numeric(19,4)
    from joined j
    join sale_doc sd on sd.id = j.document_id
   group by j.item_id, sd.fiscal_period_id
  having sum(j.quantity_sold) <> 0 or sum(j.revenue_base) <> 0 or sum(j.cogs_base) <> 0
$$;
revoke execute on function app.item_profitability_rows(uuid, text[]) from public;
grant  execute on function app.item_profitability_rows(uuid, text[]) to app_rw;
```

- [ ] **Step 4: Write the hand-written down**

`packages/db/migrations/0048.down.sql` — every object the up created, dropped in reverse dependency order (§3.4.5); the two indexes go with their tables, and the two functions are dropped by their full signatures because a later slice may add an overload:

```sql
-- 0048.down.sql — reverse dependency order (§3.4.5). After down to 0 there must be zero tables in
-- schema app (plan0A:2505), so both tables go; app_meta is never touched.
drop function if exists app.item_profitability_rows(uuid, text[]);
drop function if exists app.party_ageing_rows(uuid, date);
drop index if exists app.item_profitability_period_idx;
drop index if exists app.party_ageing_as_of_idx;
drop table if exists app.item_profitability;
drop table if exists app.party_ageing;
```

- [ ] **Step 5: Edit `lint-schema.ts` to exactly §3.5.3's state**

Four memberships, and **nothing else in the file changes** (hazard 13). §3.5.3's rows: `party_ageing` → `NO_ID_TABLES` **yes**, `AUDIT_EXEMPT` **add**; `item_profitability` → the same pair. `NO_CREATED_AT_TABLES` is **derived** (`new Set([...NO_ID_TABLES, "ledger_entry"])`, plan0A:2702) and is not rewritten.

```ts
// packages/db/src/lint-schema.ts — the two 4B projections join the natural-key and audit-exempt sets.
export const NO_ID_TABLES = new Set([
  // (every earlier member of this set is untouched — append only, below the last existing line)
  "party_ageing",         // 4B: primary key (company_id, party_id, currency, as_of, bucket) — §3.5.3
  "item_profitability",   // 4B: primary key (company_id, item_id, fiscal_period_id) — §3.5.3
]);

export const AUDIT_EXEMPT = new Set([
  // (every earlier member of this set is untouched — append only, below the last existing line)
  "party_ageing",         // 4B: derived projection, rebuilt from ledger_entry + allocation — §3.5.3
  "item_profitability",   // 4B: derived projection, rebuilt from ledger_entry + inventory_movement — §3.5.3
]);
```

- [ ] **Step 6: Write the two Drizzle mirrors (§3.4.9)**

Every slice that creates a table adds its mirror in the same PR; the mirror is also the diff source for the next change to these tables.

```ts
// packages/db/src/schema/party-ageing.ts
import { char, date, numeric, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const partyAgeing = app.table("party_ageing", {
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  partyId: uuid("party_id").notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  asOf: date("as_of").notNull(),
  bucket: text("bucket").notNull(),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  baseAmount: numeric("base_amount", { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.companyId, t.partyId, t.currency, t.asOf, t.bucket] }),
}));
```

```ts
// packages/db/src/schema/item-profitability.ts
import { numeric, pgSchema, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const itemProfitability = app.table("item_profitability", {
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  itemId: uuid("item_id").notNull(),
  fiscalPeriodId: uuid("fiscal_period_id").notNull(),
  quantitySold: numeric("quantity_sold", { precision: 19, scale: 6 }).notNull(),
  revenueBase: numeric("revenue_base", { precision: 19, scale: 4 }).notNull(),
  cogsBase: numeric("cogs_base", { precision: 19, scale: 4 }).notNull(),
  marginBase: numeric("margin_base", { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.companyId, t.itemId, t.fiscalPeriodId] }),
}));
```

`bucket` is `text` in the first mirror deliberately, not a Drizzle enum (§3.4.4) — which is why `text` sits in that one import list, alphabetically between `primaryKey` and `timestamp`. **One import statement per specifier**: a second `import { text } from "drizzle-orm/pg-core";` beside the first is what `no-duplicate-imports` flags.

- [ ] **Step 7: Run the test to green, then the reversibility proof**

```bash
bun run --cwd packages/db test -- ar-ap/party-ageing
bun run --cwd packages/db test -- privileges       # §3.4.6's up → down → up fingerprint test
bun run --cwd packages/db db:lint
bun run typecheck && bun run lint && bun run lint:rules && bun run format:check
```

All green. `privileges.test.ts` is the one that catches a down file that forgot the two functions: `schemaFingerprint` includes the `app_rw` grant list and the enum catalogue (§3.4.6), and a leftover function would leave `count(*) from information_schema.tables where table_schema = 'app'` at zero but the second `up()` would fail on `create function … already exists`.

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0048_create_party_ageing_item_profitability.sql \
        packages/db/migrations/0048.down.sql \
        packages/db/src/schema/party-ageing.ts packages/db/src/schema/item-profitability.ts \
        packages/db/src/lint-schema.ts packages/db/test/ar-ap/party-ageing.test.ts
git commit -m "feat(db): add party_ageing and item_profitability with their two SQL functions [4B T1]

The two async projections spec:1204 names beside stock_valuation, plus the two STABLE SQL
functions that hold the ONE definition of the ageing arithmetic and of the item split. The
rebuild MERGEs from them, both reports select from them and the nightly compare full-outer-joins
against them, so a report and its integrity check cannot disagree about a figure.

Neither function is SECURITY DEFINER, so every row they read is filtered by tenant_isolation as
the caller. Neither table grants DELETE: §3.5.4's list is pinned, so the rebuilds MERGE and zero.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0052 — `accounting.bank.reconcile`, the `accountant` grant, and the six account assertions

**PR 2 of 5.** The one permission code §3.6.2 assigns 4B, its single role grant, and — the more important half — the **assertions that the six account codes this slice resolves already exist**, seeded by 0C, never re-seeded here (hazard 33). §4.15's rule is that the slice which seeds a policy seeds the accounts that policy names *by code*; `FX_REVALUATION`'s policy names none (it resolves `{ from: "line.account" }`), and the codes its *drafting service* resolves are all 0C's, so this slice's obligation is to prove they resolve and to fail loudly if they do not.

**Why the permission reference lands in `apps/api` in this task and not in Task 8.** `scripts/lint/rules/permission-catalogue.ts` (§3.6.3) scans `apps/api`, `apps/worker`, `apps/pos`, `packages/sync` and `packages/db/src` — **not** `packages/contracts/src` — and fails when a catalogue code has no reference. `packages/db` may not import `@dulja/contracts` (§3.1), so the only legal home for `PERMISSION["accounting.bank.reconcile"]` is `apps/api`. This task therefore creates `apps/api/src/routes/accounting/bank-statements.ts` carrying **only** `BANK_PERMISSION` (3A's `INVENTORY_PERMISSION` precedent); Task 8 adds the router, the module and the probe. The file is not registered in `buildRoutes` here, so the isolation harness sees no `ROUTES` entry without a `PROBES` key. The reference is the **bracket** form `PERMISSION["accounting.bank.reconcile"]`, which is what 1A, 1B, 2A and 3A all rely on — a dotted code cannot be reached by dot access.

**Files:**
- Create: `packages/db/migrations/0052_seed_permission_phase4b.sql`, `packages/db/migrations/0052.down.sql`
- Create: `apps/api/src/routes/accounting/bank-statements.ts` (the constant only)
- Create: `packages/db/test/seed/permission-phase4b.test.ts`
- Modify: `packages/contracts/permissions.ts` (one `PermissionDef` row), `packages/db/seed/roles.ts` (one grant)

**Interfaces**

- Consumes: `app.permission` (plan0A, global, no RLS); `PERMISSIONS`, `PermissionDef`, `PERMISSION`, `PermissionCode`, `SliceId` (§4.2.5, 0B); `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` (§4.2.5, 0D); `app.account` (plan0A); `readPackFile` (§4.2.13, 0C — the hazard-33 case reads `0c-base.json` with it); `seedTenantV2`, `seedAccount` (§4.17, 1A); `startDb`, `Db`, `Seed`, the test `withTenant`, `lintSchema`, `listApplied` (§4.1).
- Produces:
  - `app.permission` row `('accounting.bank.reconcile', 'accounting', true, …)`.
  - `PERMISSIONS` gains `{ code: "accounting.bank.reconcile", module: "accounting", mutating: true, description: "Import bank statements and match or unmatch receipts, payments, till bankings and payroll batches", phase: "4B" }`.
  - `ROLES` — `accountant.permissions` gains `"accounting.bank.reconcile"`. **§3.6.4's recorded sentence gains its row: `accounting.bank.reconcile` → `accountant` (4B).**
  - `apps/api/src/routes/accounting/bank-statements.ts` — `export const BANK_PERMISSION = { reconcile: PERMISSION["accounting.bank.reconcile"] } as const;`
  - `AR_AP_ACCOUNT_CODES` is **not** produced here — Task 5 owns `FX_ACCOUNT_CODES`; this task's assertion list is a local constant in its test.

- [ ] **Step 1: Write the failing test**

`packages/db/test/seed/permission-phase4b.test.ts`:

```ts
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../seed/roles";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { lintSchema, listApplied } from "../../src";
import { readPackFile } from "../../src/seed";          // 0C, §4.2.13 — throws SeedError naming the file
import { startDb, withTenant, type Db } from "../harness";
import { seedAccount, seedTenantV2, type Seed } from "../fixtures";

/** The six §4.15 codes this slice RESOLVES and does not seed. Each names its seeding slice. */
const CONSUMED_ACCOUNTS = [
  { code: "1200", nameEn: "Trade receivables (AR control)", type: "asset",     seededBy: "0C" },
  { code: "2100", nameEn: "Trade payables (AP control)",    type: "liability", seededBy: "0C" },
  { code: "4900", nameEn: "Foreign-exchange gain",          type: "income",    seededBy: "0C" },
  { code: "5910", nameEn: "Foreign-exchange loss",          type: "expense",   seededBy: "0C" },
  { code: "5920", nameEn: "FX rounding",                    type: "expense",   seededBy: "0C" },
  { code: "1100", nameEn: "Bank",                           type: "asset",     seededBy: "0C" },
] as const;

let db: Db;
let s: Seed;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "perm-4b");
}, 180_000);
afterAll(async () => { await db?.stop(); });

describe("migration 0052 — accounting.bank.reconcile (§3.6.2, §3.6.3)", () => {
  it("applies as version 52", async () => {
    expect(await listApplied(db.migrator)).toContain(52);
  });

  it("app.permission carries exactly one 4B row, and it is mutating", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code = 'accounting.bank.reconcile'`;
    expect(rows).toEqual([{ code: "accounting.bank.reconcile", module: "accounting", mutating: true }]);
  });

  it("the catalogue module agrees with the database, both directions (0B's permission-catalogue test)", async () => {
    const def = PERMISSIONS.find((p) => p.code === "accounting.bank.reconcile");
    expect(def).toMatchObject({ module: "accounting", mutating: true, phase: "4B" });
  });

  it("accountant holds it; auditor does not, because it is mutating (R7, spec:2163)", () => {
    const role = (code: string) => ROLES.find((r) => r.code === code)!;
    expect(role("accountant").permissions).toContain("accounting.bank.reconcile");
    expect(role("auditor").permissions).not.toContain("accounting.bank.reconcile");
    expect(role("user").permissions).not.toContain("accounting.bank.reconcile");
    expect(role("warehouse").permissions).not.toContain("accounting.bank.reconcile");
  });

  it("no seeded role other than admin holds an incompatible pair (R6, spec:2177)", () => {
    for (const role of ROLES.filter((r) => r.code !== "admin")) {
      for (const [x, y] of INCOMPATIBLE_PAIRS) {
        expect(role.permissions.includes(x) && role.permissions.includes(y),
          `${role.code} holds both ${x} and ${y}`).toBe(false);
      }
    }
  });

  // ── Hazard 33's real assertion: it reads 0C's SHIPPED PACK, not a row this test made ───
  //
  // The case below it seeds the six accounts with `seedAccount` and then proves they resolve, which is
  // what the unit-test tenant needs — but on its own that assertion is self-fulfilling and could never
  // detect the single failure hazard 33 exists to prevent: 0C dropping a row from its chart file. This
  // case reads `0c-base.json` off disk through 0C's own `readPackFile` and fails when a row goes missing,
  // which is 3D's precedent for the same obligation (phase-3d:686-700 reads `3d-adjustments.json`).
  it("0C's shipped chart pack declares all six codes this slice consumes, with the §4.15 types", () => {
    // `readPackFile(packRoot, subPack, file)` (§4.2.13, 0C) throws SeedError naming the file when it is
    // absent or malformed, so a moved pack is a named failure rather than an empty array.
    const packRoot = join(process.cwd(), "seed", "my");     // packages/db is this workspace's cwd
    const rows = readPackFile<{ code: string; nameEn: string; type: string; isGroup?: boolean }[]>(
      packRoot, "chart-of-accounts", "0c-base.json");
    const leaves = new Map(rows.filter((r) => r.isGroup !== true).map((r) => [r.code, r]));
    for (const a of CONSUMED_ACCOUNTS) {
      expect(leaves.has(a.code), `0c-base.json has no leaf ${a.code} — 0C dropped a §4.15 row`).toBe(true);
      expect(leaves.get(a.code)!.type, a.code).toBe(a.type);
      // §4.15's first-digit rule: the code and the type can never disagree.
      expect(a.code[0], a.code).toBe({ asset: "1", liability: "2", equity: "3", income: "4", expense: "5" }[a.type]);
    }
    // …and this slice ships no chart file of its own in the unconditional path, so nothing here is 4B's.
    expect(rows.some((r) => r.code === "1150")).toBe(false);   // ⚠️ 1150 is Task 9's 4b-pdc.json, if OD-09
  });

  it("every account code this slice resolves already exists, with the right type (hazard 33)", async () => {
    for (const a of CONSUMED_ACCOUNTS) {
      await seedAccount(db, s, { code: a.code, nameEn: a.nameEn, type: a.type });
    }
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await tx<{ code: string; type: string }[]>`
        select code, type from app.account
         where company_id = ${s.company}
           and code = any(${CONSUMED_ACCOUNTS.map((a) => a.code)}::text[])
         order by code`;
      expect(rows.map((r) => r.code)).toEqual(["1100", "1200", "2100", "4900", "5910", "5920"]);
      expect(rows.find((r) => r.code === "4900")!.type).toBe("income");
      expect(rows.find((r) => r.code === "5910")!.type).toBe("expense");
    });
  });

  it("this slice seeds no chart-of-accounts file of its own in the unconditional path (§4.15)", async () => {
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../../seed/my/chart-of-accounts/", import.meta.url));
    // 4b-pdc.json exists ONLY when OD-09 lands (Task 9). No other 4b file may ever appear.
    for (const forbidden of ["4b-ageing.json", "4b-fx.json", "4b-bank.json", "4b-base.json"]) {
      expect(existsSync(`${dir}${forbidden}`), forbidden).toBe(false);
    }
  });

  it("lintSchema reports zero violations after 0052", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- seed/permission-phase4b
```

Expected:

```
FAIL  test/seed/permission-phase4b.test.ts > … > applies as version 52
AssertionError: expected [ 1, 2, …, 48 ] to include 52

FAIL  test/seed/permission-phase4b.test.ts > … > app.permission carries exactly one 4B row
AssertionError: expected [] to deeply equal [ { code: 'accounting.bank.reconcile', … } ]

FAIL  test/seed/permission-phase4b.test.ts > … > the catalogue module agrees with the database
AssertionError: expected undefined to match object { module: 'accounting', … }
```

- [ ] **Step 3: Write the migration and its down**

`packages/db/migrations/0052_seed_permission_phase4b.sql` — the §3.4.2 name is `NNNN_seed_permission_phase<slice id with its letter>.sql`, so `phase4b` and not `phase4`:

```sql
-- 0052_seed_permission_phase4b.sql
-- app.permission is GLOBAL (no RLS, read-only for app_rw — plan0A:1254), so it is migration data and not
-- seed-pack data (§3.4.8). Slice 4B introduces exactly one code (§3.6.2): the reconciler's authority.
-- spec:2147 lists accounting.bank.reconcile among the accountant's codes; spec:2157 gives it to that role.
insert into app.permission (code, module, mutating, description) values
  ('accounting.bank.reconcile', 'accounting', true,
   'Import bank statements and match or unmatch receipts, payments, till bankings and payroll batches')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;
```

`packages/db/migrations/0052.down.sql`. **§3.4.5 (round-3 correction) binds this file and requires the task that ships it to state the precondition on its rollback command**, so the sentence is written twice — once in the file, where an operator running `bun run migrate down` reads it, and once here. The reason is structural and not an omission: `app.role_permission.permission_code references app.permission(code)` carries no `on delete` action (plan0A:1325) and RI checks bypass RLS, so on a database where `--only roles` has granted this code to `accountant`, the `delete` raises SQLSTATE **23503**; the down cannot remove the grant itself either, because `app.role_permission` is `FORCE ROW LEVEL SECURITY` and a migration with no `set_config('app.tenant_id', …)` sees zero rows, and it cannot even enumerate the tenants to set a context for, because `app.tenant` is policy-guarded the same way. **Never "fix" this by dropping or disabling the policy** — Global Constraint 1, SAH-027/041/053. 6A's `0062.down.sql` and 6B's `0063.down.sql` are the two other written instances and carry the same paragraph.

```sql
-- 0052.down.sql — delete exactly the code this file inserted (§3.6.3).
--
-- PRECONDITION (§3.4.5): this down is reversible only against an UNSEEDED database — which is exactly
-- where §3.4.6's generalised up → down → up reversibility test exercises it. On a seeded database the
-- delete raises 23503 against app.role_permission, whose FK to app.permission(code) has no `on delete`
-- action and whose RI check bypasses RLS. This file cannot remove the grant itself: app.role_permission
-- carries FORCE ROW LEVEL SECURITY and a migration with no tenant context writes zero rows, and
-- app.tenant is guarded the same way, so the migrator cannot even enumerate the tenants to set a
-- context for. The operator therefore removes the per-tenant grants first, as a seed-tier act with
-- set_config('app.tenant_id', <tenant>, false), then runs this down, and re-runs
--   bun run seed --tenant <id> --only roles
-- after re-migrating. Never disable or drop the policy to make this file pass (SAH-027, 041, 053).
delete from app.permission where code = 'accounting.bank.reconcile';
```

- [ ] **Step 4: Add the catalogue row, the role grant and the one `PERMISSION[...]` reference**

`packages/contracts/permissions.ts` — one row appended to `PERMISSIONS`, nothing else touched:

```ts
  {
    code: "accounting.bank.reconcile",
    module: "accounting",
    mutating: true,
    description:
      "Import bank statements and match or unmatch receipts, payments, till bankings and payroll batches",
    phase: "4B",
  },
```

`packages/db/seed/roles.ts` — one string appended to `accountant.permissions`:

```ts
// accountant — spec:2157 "…release of the net-pay bank batch, bank reconciliation, tax returns, period
// close…". auditor must NOT hold it: the code is mutating and R7 forbids the auditor any mutating code
// (spec:2178, enforced by scripts/lint/rules/role-seed.ts).
    "accounting.bank.reconcile",
```

`apps/api/src/routes/accounting/bank-statements.ts` — the constant only; Task 8 fills the file:

```ts
// apps/api/src/routes/accounting/bank-statements.ts
//
// Slice 4B. This file carries the bank-reconciliation route module (Task 8). At Task 2 it carries only the
// permission constant, because scripts/lint/rules/permission-catalogue.ts (§3.6.3) scans apps/api,
// apps/worker, apps/pos, packages/sync and packages/db/src — not packages/contracts/src — and
// packages/db may not import @dulja/contracts (§3.1), so apps/api is the only legal home for the
// reference. Nothing is registered in buildRoutes until Task 8 adds the router AND its PROBES key
// together (hazard 31: a ROUTES entry without a probe fails the isolation harness).
import { PERMISSION } from "@dulja/contracts/permissions";

/** 3A's INVENTORY_PERMISSION precedent: one home for the slice's codes, so no route writes the literal. */
export const BANK_PERMISSION = {
  reconcile: PERMISSION["accounting.bank.reconcile"],
} as const;
```

- [ ] **Step 5: Run every check the catalogue and the role seed have**

```bash
bun run --cwd packages/db test -- seed/permission-phase4b
bun run --cwd packages/db test -- permission-catalogue     # 0B's both-directions DB ↔ module equality
bun run lint:rules                                          # permission-catalogue + role-seed (§3.6.3)
bun run typecheck && bun run test
```

All green. `lint:rules` is the one that matters here: without Step 4's third file it prints

```
packages/contracts/permissions.ts:<line> permission-catalogue catalogue code accounting.bank.reconcile has no reference in apps/api, apps/worker, apps/pos, packages/sync or packages/db/src
```

and that is the failure this task's file layout exists to prevent. **Never defer it to Task 8 and never add a lint suppression.**

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0052_seed_permission_phase4b.sql \
        packages/db/migrations/0052.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts \
        apps/api/src/routes/accounting/bank-statements.ts \
        packages/db/test/seed/permission-phase4b.test.ts
git commit -m "feat(db): seed accounting.bank.reconcile and assert the six consumed accounts [4B T2]

One code, one role grant (accountant; auditor must not hold it under R7), and the assertions
that 1200, 2100, 4900, 5910, 5920 and 1100 already resolve for the seeded company. This slice
seeds no account: FX_REVALUATION's policy names no account.code literal and every code its
drafting service resolves is 0C's, so hazard 33's obligation here is to prove they resolve and
fail loudly if they do not — never to re-seed one and never to fall back to a null account.

The PERMISSION[...] reference lands in apps/api because permission-catalogue does not scan
packages/contracts/src and packages/db may not import @dulja/contracts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `party_ageing` — the snapshot rebuild, `accounting.projection.rebuild`, the `accounting.ageing` report and the DoD tie-out

The first half of the Phase 4 definition of done: *"Ageing report reconciles to the ledger to the cent."* Six pieces: the TypeScript over Task 1's SQL function, the `MERGE`-and-zero rebuild, the pg-boss job that runs it nightly and compares it, the `accounting.ageing` report as a `GET` on 1B's existing `reports` module, the `ageingTieOut` function the DoD test asserts on, and ADR 0046.

**`party_ageing` is an as-of snapshot and it does *not* join 1B's `projectionChecks` registry** — 3B's ADR 0039 made exactly this call for `stock_valuation` ("an as-of history keyed by date, not a current-state projection, and its rebuild-and-compare belongs to `inventory.projection.rebuild`"), and the same reasoning binds here. `item_profitability` **does** join it, because it is current state keyed on a period; that is Task 4.

**Files:**
- Create: `packages/db/src/ar-ap/ageing.ts`, `packages/db/src/reports/ageing.ts`
- Create: `apps/worker/src/handlers/accounting-projection-rebuild.ts`
- Create: `docs/adr/0046-ageing-and-item-profitability-projection-shapes.md`
- Create: `packages/db/test/ar-ap/ageing.test.ts`, `apps/worker/test/handlers/accounting-projection-rebuild.test.ts`, `apps/api/test/routes/accounting/ageing-report.test.ts`
- Modify: `packages/db/src/ar-ap/index.ts` (**4A's barrel — append one export block; never rewrite the file**), `tests/invariants/support/ar-ap.ts` (fill it — amendment 9), `packages/db/src/jobs/payloads.ts` (one key — amendment 1), `packages/db/src/index.ts` (one re-export line for `./reports/ageing`; `./ar-ap` is already re-exported by 4A), `packages/contracts/src/accounting/reports.ts` (`ReportCodeSchema` + the ageing DTOs), `apps/api/src/routes/accounting/reports.ts` (one `GET`), `tests/invariants/probes.ts` (one `JOB_PROBES` entry), `tests/regression/sah-011.test.ts` (append a `— 4B` block)

**Interfaces**

- Consumes: `app.party_ageing`, `app.party_ageing_rows` (Task 1); `app.party` (2A), `app.payment_term`, `app.allocation` (4A); `app.account`, `app.account_balance`, `app.ledger_entry`, `app.document`, `app.document_type` (plan0A, 1A); the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext` (§4.2.2); `JobEnvelope`, `JobHandler`, `registerHandler`, `JobPayload`, `JobName`, `eachTenant`, `log` (§4.2.6); `IntegrityReport`, `ProjectionMismatch`, `recordIntegrityIncident` (1B, §4.16.3); `Money`, `currency`, `CurrencyCode` (§4.2.1); `encodeCursor`, `decodeCursor`, `Cursor`, `ListEnvelope`, `ListQuery`, `parseFilters`, `FilterClause`, `FILTER_OPS`, `UuidSchema`, `DateSchema`, `MoneySchema`, `CurrencySchema`, `ProblemSchema` (§4.2.8); `AppError`, `ERRORS` (§4.2.4); `requirePermission`, `PERMISSION` (§4.2.5); `reportsRoutes`, `reportsRouteModule`, `ReportCodeSchema` (1B); `startApi`, `ApiRequest`, `StartedApi` (§4.2.12); `startWorker` (§4.17.1, 0D); `startDb`, `Db`, `Seed`, the test `withTenant`, `uuidv7` (§4.1); `seedTenantV2`, `seedAccount` (1A), `seedParty` (2A), `seedDocumentType` (2A), `grantCodes` (2B), `seedPaymentTerm` (4A), `seedCurrency`, `seedRate` (0D), `draftTypedDocument` with its frozen `DraftTypedDocumentOptions` (3C, §4.17), `transitionDocument` (2B, §4.3.1 — `postFromPack`'s approval path), `ensureOpenPeriods` and `secondPrincipal` (3B/3D, §4.17.1).
- Produces:
  ```ts
  // packages/db/src/ar-ap/ageing.ts
  export type AgeingBucket = "current" | "1_30" | "31_60" | "61_90" | "over_90";
  /** Registry order, oldest last — the order every report column set and every screen renders. */
  export const PARTY_AGEING_BUCKETS: readonly AgeingBucket[];

  export interface PartyAgeingRow {
    partyId: string; currency: string; bucket: AgeingBucket;
    amount: string;        // 4 dp, the open document's own currency
    baseAmount: string;    // 4 dp, at each open document's own rate
  }
  export interface AgeingParams { companyId: string; asOf: string }

  /** The fresh computation, straight off `app.party_ageing_rows` — never a second arithmetic (amendment 3). */
  export async function ageingRows(tx: Sql, params: AgeingParams): Promise<PartyAgeingRow[]>;

  /** MERGEs the fresh rows into `app.party_ageing` for this `(company, as_of)` and zeroes the stale keys of
   *  the same scope. It NEVER deletes: §3.5.4's DELETE list is pinned and 2B is its only extender. */
  export async function rebuildPartyAgeing(
    tx: Sql, params: AgeingParams,
  ): Promise<{ merged: number; zeroed: number }>;

  /** The nightly rebuild-and-compare (test 2, spec:1204 "a mismatch is an incident"). */
  export async function comparePartyAgeing(tx: Sql, params: AgeingParams): Promise<ProjectionMismatch[]>;

  export interface AgeingTieOutRow {
    accountId: string; accountCode: string; accountType: string;
    ageingBase: string; ledgerBase: string; revaluationBase: string;
    /** ageingBase − (ledgerBase − revaluationBase). "0.0000" is the definition-of-done (§4.8.2). */
    difference: string;
  }
  /** One row per control account any party of the company points at. The DoD test asserts
   *  `difference === "0.0000"` for the `1200` and `2100` rows (§4.8.2's two literals). */
  export async function ageingTieOut(tx: Sql, params: AgeingParams): Promise<AgeingTieOutRow[]>;

  /** Base carried on `accountId` by posted, not-yet-reversed UNREALISED `FX_REVALUATION` documents up to
   *  `asOf`, signed by the account's type. Zero before Task 5 ships the type (amendment 4). */
  export async function outstandingRevaluation(
    tx: Sql, params: { companyId: string; accountId: string; asOf: string },
  ): Promise<string>;
  ```
  ```ts
  // packages/db/src/reports/ageing.ts — the §4.16.3 read function 7C re-expresses (amendment 10)
  export interface AgedBalanceParams {
    companyId: string; asOf: string;
    partyId?: string; partyKind?: string; currency?: string; buckets?: readonly AgeingBucket[];
    cursor?: { partyCode: string; currency: string } | null;
    limit: number;
  }
  export interface AgedBalanceRow {
    partyId: string; partyCode: string; partyNameEn: string; partyNameAr: string | null; partyKind: string;
    currency: string;
    current: string; d1_30: string; d31_60: string; d61_90: string; over_90: string;
    total: string; totalBase: string;
  }
  export async function agedBalance(tx: Sql, params: AgedBalanceParams): Promise<AgedBalanceRow[]>;
  ```
  ```ts
  // tests/invariants/support/ar-ap.ts (§4.17.1, amendment 9)
  export interface DocumentTypeEnvelope {
    code: string; nameEn: string; nameAr?: string; module: string;
    policyVersion: number; effectiveFrom: string; policy: unknown;
  }
  /** Reads 4A's OWN shipped envelope from packages/db/seed/my/document-types/<CODE>.json and configures it
   *  with 2A's seedDocumentType. No test in this slice restates a policy 4A owns. */
  export async function seedTypeFromPack(db: Db, s: Seed, code: string): Promise<string>;
  export interface PackApproval { required: boolean; approve: string | null; post: string }
  /** `policy.approval` off the same envelope. `postFromPack` derives the state-machine path from this, so
   *  no call site can forget that a type is approval-required (§4.5.1). */
  export function packApproval(code: string): PackApproval;
  export async function postFromPack(db: Db, s: Seed, opts: PostFromPackOptions): Promise<{ documentId: string; result: PostResult }>;
  export interface ArApFixture {
    documentTypeIds: Readonly<Record<string, string>>;
    accountIds: Readonly<Record<string, string>>;
    partyIds: { customer: string; vendor: string };
    termId: string;
  }
  /** Open periods for 2025 and 2026, the twelve accounts, the two parties, a 30-day term, every 4A type in
   *  the pack and the seventeen permission codes the posting transaction evaluates — in one call. Every
   *  ageing, FX and reconciliation test starts here. */
  export async function arApFixture(db: Db, s: Seed): Promise<ArApFixture>;
  ```
  Plus `JobPayload["accounting.projection.rebuild"] = { companyId?: string; asOf?: string }`, the `accounting.projection.rebuild` handler registration, `ReportCodeSchema` widened by `accounting.ageing`, the contracts DTOs `AgeingRowSchema` / `AgeingQuery` / `AgeingList`, and one `JOB_PROBES` entry.

- [ ] **Step 1: Write ADR 0046 as a proposal, and ask**

`docs/adr/0046-ageing-and-item-profitability-projection-shapes.md`. spec:95 requires a decision touching money semantics to be **proposed and asked before implementing**; the ageing definition is money semantics in its purest form.

```markdown
# 0046 — Ageing and item-profitability projection shapes

- Status: **proposed** (spec:95 — this touches money semantics; do not merge the implementation before this is accepted)
- Date: 2026-09-05
- Slice: 4B

## Context

spec:1204 names three asynchronous projections — `party_ageing`, `item_profitability` and
`stock_valuation` history — and requires all of them to be "rebuilt from
`ledger_entry`/`inventory_movement` into scratch tables nightly and compared row for row; a mismatch
is an incident". §4.8.2 additionally requires the ageing to tie to the `1200`/`2100` control accounts
"to the cent", and that clause is half of the Phase 4 definition of done.

Three questions had no registered answer.

1. **Where does the arithmetic live?** A report, a projection rebuild and an integrity comparison that
   each carry their own copy of "what is open" will disagree, and the disagreement will look like a
   mismatch incident rather than like a bug.
2. **Does the tie-out hold per currency?** §4.8.2 says "Σ buckets per party to the AR/AP control-account
   balance" without saying in which currency.
3. **Do these two projections join 1B's `projectionChecks` registry?** 3B's ADR 0039 excluded
   `stock_valuation` from it and put its compare inside its own job.

## Decision

**One arithmetic, in SQL.** `app.party_ageing_rows(company, as_of)` and
`app.item_profitability_rows(company, sale_types[])` (migration 0048) are the only definitions. The
rebuild `MERGE`s from them, the two reports select from them, and the compare full-outer-joins the
stored table against them. Both are plain `stable` SQL and never `SECURITY DEFINER`, so RLS applies as
the caller. This is the shape `app.rate_for` and `app.series_gaps` already established.

**The tie-out is base-only, and the per-currency equality is not claimed.** In a cross-currency
settlement it is false: a EUR invoice part-paid by a USD receipt leaves the control account with a EUR
debit row and a USD credit row in `account_balance`, while the ageing shows the invoice's residual EUR
and nothing in USD — because `allocation.amount` is denominated in the **settled** document's currency
and no column denominates it in the settlement's. The registered equality is therefore

    Σ party_ageing.base_amount  ==  ledger base of the control account − outstanding unrealised revaluation

with the sign taken from the account's type, and it holds **only once the realised FX difference has
posted** (ADR 0047): the residue between "settlement base" and "settled base" is income, not a
receivable, and until it is posted to the control account the ledger carries it and the ageing does not.
That is why the ageing counts a settlement's consumption as `base_amount + fx_difference`.
A same-currency month satisfies the per-currency equality too, and the test asserts that case separately.

`account_balance`'s per-currency rows on a party control account are consequently **not an open-item
view**, and no report reads them as one. The open-item view is `party_ageing`.

**`item_profitability` joins `projectionChecks`; `party_ageing` does not.** `item_profitability` is
current state keyed on `(company, item, fiscal_period)` — exactly the shape `account_balance` and
`stock_on_hand` have, and 1B's nightly `accounting.ledger.integrity_check` is where current-state
projections are compared. `party_ageing` is an as-of snapshot keyed by date, so a comparison is only
meaningful for a date somebody asked for; its rebuild-and-compare belongs to
`accounting.projection.rebuild`, which is the identical call 3B's ADR 0039 made for `stock_valuation`.

**Neither rebuild deletes.** §3.5.4's `app_rw` DELETE list is pinned to five tables and 2B is its only
extender, so both rebuilds `MERGE` and then zero the stale keys of their own scope. A zeroed row and an
absent row are the same thing to every reader, and the compare treats a missing side as zero.

## Consequences

- A change to the ageing definition is a migration, reviewed as SQL, not a diff in three TypeScript files.
- `IntegrityReport.projections.checked` becomes `["account_balance", "cost_layer", "document_series",
  "item_profitability", "stock_on_hand"]`; the three pinned assertions that read it move in the same PR.
- The DoD test cannot be written without the FX work, so Task 3's tie-out case is same-currency and
  Task 5 Step 8 re-asserts it across a cross-currency month. That ordering is deliberate, not an oversight.
- An ageing snapshot exists only for the dates the job ran, so the **report always computes fresh** through
  `agedBalance` and never tells a user "no snapshot for that date"; the stored table exists for the
  comparison and for 7C's re-expression, not to answer the query.
```

Ask before implementing (spec:95). Record the answer in the ADR's status line; the rest of this task is written against the proposal as stated.

- [ ] **Step 2: Write the failing test**

`packages/db/test/ar-ap/ageing.test.ts`. The fixture is **same-currency** on purpose (ADR 0046's last consequence): one 30-day invoice inside its term, one 45 days overdue, one 100 days overdue, a credit note, a partly-allocated receipt, an unallocated receipt on account, and a vendor bill.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { ageingRows, ageingTieOut, agedBalance, comparePartyAgeing, rebuildPartyAgeing } from "../../src";
import { startDb, withTenant, type Db } from "../harness";
// `seedParty` (2A) is for the last case in the DoD block only, which needs a party of its own so that
// no absolute figure asserted anywhere above it moves.
import { seedParty, seedTenantV2, type Seed } from "../fixtures";
import { arApFixture, postFromPack, type ArApFixture } from "../../../../tests/invariants/support/ar-ap";

const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: ArApFixture;
let oldInvoiceId: string;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "ageing");
  f = await arApFixture(db, s);

  // Six documents, all MYR, all against the 30-day customer term. as_of is 2026-03-31 throughout, so:
  //   2026-03-15 invoice → due 2026-04-14 → current
  //   2026-02-01 invoice → due 2026-03-03 → 28 days overdue → 1_30
  //   2025-12-01 invoice → due 2025-12-31 → 90 days overdue → 61_90
  await postFromPack(db, s, { code: "SALES_INVOICE", effectiveDate: "2026-03-15", partyId: f.partyIds.customer,
    lines: [{ kind: "account", accountId: f.accountIds["4000"]!, credit: "1000.0000" },
            { kind: "account", accountId: f.accountIds["1200"]!, debit:  "1000.0000" }] });
  await postFromPack(db, s, { code: "SALES_INVOICE", effectiveDate: "2026-02-01", partyId: f.partyIds.customer,
    lines: [{ kind: "account", accountId: f.accountIds["4000"]!, credit: "600.0000" },
            { kind: "account", accountId: f.accountIds["1200"]!, debit:  "600.0000" }] });
  // The 61_90 invoice's id is captured: Step 5's `postFromPack` allocates by ID (4A's frozen
  // `AllocationLine` shape), never by code-plus-index.
  ({ documentId: oldInvoiceId } = await postFromPack(db, s, { code: "SALES_INVOICE",
    effectiveDate: "2025-12-01", partyId: f.partyIds.customer,
    lines: [{ kind: "account", accountId: f.accountIds["4000"]!, credit: "400.0000" },
            { kind: "account", accountId: f.accountIds["1200"]!, debit:  "400.0000" }] }));
  await postFromPack(db, s, { code: "PURCHASE_INVOICE", effectiveDate: "2026-03-20", partyId: f.partyIds.vendor,
    lines: [{ kind: "account", accountId: f.accountIds["5900"]!, debit:  "750.0000" },
            { kind: "account", accountId: f.accountIds["2100"]!, credit: "750.0000" }] });
}, 300_000);
afterAll(async () => { await db?.stop(); });

describe("party_ageing — the buckets (§4.8.2, spec:1042)", () => {
  it("cuts buckets on effective_date + payment_term.due_days, not on effective_date", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-03-31" }));
    const customer = rows.filter((r) => r.partyId === f.partyIds.customer);
    expect(new Map(customer.map((r) => [r.bucket, r.amount]))).toEqual(new Map([
      ["current", "1000.0000"],   // due 2026-04-14 — not yet due
      ["1_30",     "600.0000"],   // due 2026-03-03 — 28 days
      ["61_90",    "400.0000"],   // due 2025-12-31 — 90 days
    ]));
  });

  it("a vendor's open figure is POSITIVE, so an ageing row never depends on the reader knowing the sign", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-03-31" }));
    const vendor = rows.filter((r) => r.partyId === f.partyIds.vendor);
    expect(vendor).toEqual([{ partyId: f.partyIds.vendor, currency: "MYR", bucket: "current",
                             amount: "750.0000", baseAmount: "750.0000" }]);
  });

  it("an allocation reduces the settled invoice's bucket and the receipt disappears entirely", async () => {
    const receipt = await postFromPack(db, s, {
      code: "RECEIPT", effectiveDate: "2026-03-25", partyId: f.partyIds.customer,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, debit:  "250.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, credit: "250.0000" }],
      allocate: [{ settledDocumentId: oldInvoiceId, amount: Money.of("250.0000", MYR) }],
    });
    expect(receipt.result.number).toBeGreaterThan(0n);
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-03-31" }));
    const customer = new Map(rows.filter((r) => r.partyId === f.partyIds.customer).map((r) => [r.bucket, r.amount]));
    expect(customer.get("61_90")).toBe("150.0000");   // 400 − 250
    // The receipt itself is fully applied, so it contributes no row at all — not a zero row.
    expect(rows.filter((r) => r.amount === "0.0000")).toEqual([]);
  });

  it("an UNALLOCATED receipt on account sits in `current` as a negative figure (money held, not owed)", async () => {
    await postFromPack(db, s, {
      code: "RECEIPT", effectiveDate: "2026-03-28", partyId: f.partyIds.customer,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, debit:  "90.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, credit: "90.0000" }],
    });
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-03-31" }));
    const current = rows.find((r) => r.partyId === f.partyIds.customer && r.bucket === "current")!;
    expect(current.amount).toBe("910.0000");     // 1000 invoice − 90 on account
  });

  it("SAH-011: a party with NO payment term and a document with no control-account leg yield 0, never NULL", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-03-31" }));
    for (const r of rows) {
      expect(r.amount).toMatch(/^-?\d+\.\d{4}$/);
      expect(r.baseAmount).toMatch(/^-?\d+\.\d{4}$/);
    }
  });
});

describe("party_ageing — the snapshot and its comparison (test 2, spec:1204)", () => {
  it("rebuildPartyAgeing writes the snapshot and comparePartyAgeing then finds nothing", async () => {
    const { merged } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-03-31" }));
    expect(merged).toBeGreaterThan(0);
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      comparePartyAgeing(tx, { companyId: s.company, asOf: "2026-03-31" }));
    expect(mismatches).toEqual([]);
  });

  it("a hand-corrupted snapshot row is reported as amount_differs, naming the column and both values", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`
        update app.party_ageing set base_amount = base_amount + 1
         where company_id = ${s.company} and as_of = '2026-03-31' and bucket = '1_30'`;
    });
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      comparePartyAgeing(tx, { companyId: s.company, asOf: "2026-03-31" }));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ projection: "party_ageing", side: "amount_differs" });
    expect(mismatches[0]!.detail).toContain("base_amount");
    expect(mismatches[0]!.key).toMatchObject({ bucket: "1_30" });
    // Repair for the later cases.
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-03-31" }));
  });

  it("re-running the rebuild ZEROES a key that no longer applies — it never DELETEs (§3.5.4)", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`
        insert into app.party_ageing (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount)
        values (${s.tenant}, ${s.company}, ${f.partyIds.vendor}, 'MYR', '2026-03-31', 'over_90', 42, 42)`;
    });
    const { zeroed } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-03-31" }));
    expect(zeroed).toBe(1);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ amount: string; base_amount: string }[]>`
        select amount::text, base_amount::text from app.party_ageing
         where company_id = ${s.company} and as_of = '2026-03-31'
           and party_id = ${f.partyIds.vendor} and bucket = 'over_90'`;
      expect(row).toMatchObject({ amount: "0.0000", base_amount: "0.0000" });
    });
  });
});

describe("the definition-of-done tie-out (§4.8.2)", () => {
  it("Σ base_amount equals the 1200 and 2100 control-account balances to the cent", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-03-31" }));
    const byCode = new Map(rows.map((r) => [r.accountCode, r]));
    expect(byCode.get("1200")!.difference).toBe("0.0000");
    expect(byCode.get("2100")!.difference).toBe("0.0000");
    // No FX_REVALUATION type exists yet (Task 5), so the third column is zero — and the equality is
    // therefore also the ageing == ledger equality outright.
    expect(byCode.get("1200")!.revaluationBase).toBe("0.0000");
    expect(byCode.get("1200")!.ageingBase).toBe(byCode.get("1200")!.ledgerBase);
  });

  it("in a SAME-CURRENCY month the per-currency equality holds as well (ADR 0046)", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await ageingRows(tx, { companyId: s.company, asOf: "2026-03-31" });
      const ar = rows.filter((r) => r.partyId === f.partyIds.customer)
        .reduce((sum, r) => sum.add(Money.of(r.amount, MYR)), Money.zero(MYR));
      const [balance] = await tx<{ signed: string }[]>`
        select (sum(base_debit) - sum(base_credit))::text as signed
          from app.account_balance
         where company_id = ${s.company} and account_id = ${f.accountIds["1200"]} and currency = 'MYR'`;
      expect(ar.toString()).toBe(Money.of(balance!.signed, MYR).toString());
    });
  });

  // LAST in this describe. The case the `applied` CTE's as-of guard exists for. A receipt on account dated INSIDE the reporting
  // window, allocated to an invoice dated OUTSIDE it — the ordinary deposit-then-invoice sequence, and
  // equally any earlier month re-run after a later allocation. Without the guard the allocation is
  // subtracted from the receipt's open figure and never added back, and this `difference` reads 300.0000.
  //
  // It uses its OWN party, so every absolute figure asserted above and in the `agedBalance` block below
  // (`current: "910.0000"`, `total: "1660.0000"`) is untouched; the 1200 tie-out still covers it, because
  // the tie-out sums the control account over ALL parties.
  it("an allocation across the as-of boundary keeps the tie-out at zero (the `applied` guard)", async () => {
    const later = await seedParty(db, s, {
      kind: "customer", code: "CUST-LATER", receivableAccountId: f.accountIds["1200"]! });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set payment_term_id = ${f.termId} where id = ${later}`);

    // The invoice is dated AFTER as_of; the receipt that settles it is dated before.
    const { documentId: aprInvoice } = await postFromPack(db, s, {
      code: "SALES_INVOICE", effectiveDate: "2026-04-05", partyId: later,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, credit: "300.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, debit:  "300.0000" }] });
    await postFromPack(db, s, {
      code: "RECEIPT", effectiveDate: "2026-03-20", partyId: later,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, debit:  "300.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, credit: "300.0000" }],
      allocate: [{ settledDocumentId: aprInvoice, amount: Money.of("300.0000", MYR) }],
    });

    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-03-31" }));
    expect(new Map(rows.map((r) => [r.accountCode, r.difference])).get("1200")).toBe("0.0000");

    // …and the reason it holds: as of 2026-03-31 the receipt is FULLY OPEN, because the invoice it paid
    // does not exist yet. A negative figure (money held, not owed) in `current` is the right answer.
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-03-31" }));
    expect(open.find((r) => r.partyId === later)).toMatchObject({ bucket: "current", amount: "-300.0000" });

    // As of a date that contains BOTH documents the allocation applies and the party disappears.
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-04-30" }));
    expect(after.filter((r) => r.partyId === later)).toEqual([]);
  });
});

describe("agedBalance — the accounting.ageing report read (§4.16.3, amendment 10)", () => {
  it("pivots the buckets into one row per party and currency, with both totals", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      agedBalance(tx, { companyId: s.company, asOf: "2026-03-31", limit: 50 }));
    const customer = rows.find((r) => r.partyId === f.partyIds.customer)!;
    expect(customer).toMatchObject({ currency: "MYR", current: "910.0000", d1_30: "600.0000",
                                     d31_60: "0.0000", d61_90: "150.0000", over_90: "0.0000" });
    expect(customer.total).toBe("1660.0000");
    expect(customer.totalBase).toBe("1660.0000");
  });

  it("filters by party kind and by bucket, and keysets on (party_code, currency)", async () => {
    const vendors = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      agedBalance(tx, { companyId: s.company, asOf: "2026-03-31", partyKind: "vendor", limit: 50 }));
    expect(vendors.map((r) => r.partyId)).toEqual([f.partyIds.vendor]);

    const first = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      agedBalance(tx, { companyId: s.company, asOf: "2026-03-31", limit: 1 }));
    const next = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      agedBalance(tx, { companyId: s.company, asOf: "2026-03-31", limit: 1,
                        cursor: { partyCode: first[0]!.partyCode, currency: first[0]!.currency } }));
    expect(next[0]!.partyCode).not.toBe(first[0]!.partyCode);
  });
});
```

- [ ] **Step 3: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- ar-ap/ageing
```

Expected — the module and the shared helper file are both empty:

```
FAIL  test/ar-ap/ageing.test.ts [ test/ar-ap/ageing.test.ts ]
SyntaxError: The requested module '../../src' does not provide an export named 'ageingRows'
SyntaxError: The requested module '../../../../tests/invariants/support/ar-ap' does not provide an export named 'arApFixture'
```

- [ ] **Step 4: Fill `tests/invariants/support/ar-ap.ts` (amendment 9)**

`seedTypeFromPack` is the reason this file is shared: it reads **4A's own envelope off disk** so no test in this slice restates a policy 4A owns — and `packApproval` reads `policy.approval` off that same envelope, which is what lets `postFromPack` walk an approval-required type through 2B's state machine without a caller-supplied flag.

```ts
// tests/invariants/support/ar-ap.ts  — contracts §4.17.1, amendment 9. Owner 4B.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Money, currency, type CurrencyCode } from "@dulja/domain";
import {
  allocateSettlement, postDocument, transitionDocument, withTenant, type PostResult,
} from "@dulja/db";
import {
  draftTypedDocument, seedAccount, seedParty, seedPaymentTerm, seedDocumentType,
  type Db, type DraftLine, type Seed,
} from "@dulja/db/test";
import { grantCodes } from "@dulja/db/test";
// 3B's file, with `secondPrincipal` exported by 3D's amendment 12 (§4.17.1) — the second principal R1
// needs, and the reason this slice writes no principal helper of its own (hazard 9).
import { ensureOpenPeriods, secondPrincipal } from "./post-inventory";
import { uuidv7 } from "@dulja/db/test";
import type { JobClient } from "@dulja/db";

/**
 * The ONE definition of the seed pack's location in the test tier — an ABSOLUTE directory path with a
 * trailing separator, so `${PACK_DIR}document-types/X.json` and `join(PACK_DIR, "document-types")` both
 * resolve from any working directory. Exported because Task 4's exhaustiveness guard globs
 * `document-types/` from it: a second `new URL(...)` computed relative to a different file is a second
 * way to name the same directory, and the first refactor that moves either file breaks exactly one of
 * them silently (hazard 9).
 *
 * NAMED `PACK_DIR` AND NOT `PACK_ROOT`, DELIBERATELY. 4A ships `export const PACK_ROOT = "seed/my";` in
 * `packages/db/test/ar-ap/_support.ts` (phase-4a:3044) — a RELATIVE pack root passed as `readPackFile`'s
 * first argument (§4.2.13). The two values are not interchangeable: dropping 4A's string into the two
 * call sites below yields `"seed/my" + "document-types/…"` — no separator, and resolved against the
 * process working directory — which fails as a missing file rather than as a type error. Two constants
 * with one name and two shapes is the trap; two constants with two names, each used through its own
 * accessor, is not. Nothing in this file imports 4A's, and nothing in 4A's imports this one.
 */
export const PACK_DIR = fileURLToPath(new URL("../../../packages/db/seed/my/", import.meta.url));

export interface DocumentTypeEnvelope {
  code: string; nameEn: string; nameAr?: string; module: string;
  policyVersion: number; effectiveFrom: string; policy: unknown;
}

/**
 * Configure a document type in a Testcontainers company from the SEED PACK's own envelope. 4A owns
 * SALES_INVOICE.json, RECEIPT.json and the other four; copying their policies into a constant here would
 * diverge silently the first time 4A edited one. Reading the file makes that a test failure instead.
 */
/**
 * The ONE read of a document-type envelope in this file. `seedTypeFromPack` configures the type from it
 * and `packApproval` reads its `approval` block, and both must see the same file — two `readFileSync`
 * calls composing the same path is the duplication hazard 9 names, in miniature.
 */
function readEnvelope(code: string): DocumentTypeEnvelope {
  const raw = readFileSync(`${PACK_DIR}document-types/${code}.json`, "utf8");
  const envelope = JSON.parse(raw) as DocumentTypeEnvelope;
  if (envelope.code !== code) {
    throw new Error(`seed pack file ${code}.json declares code ${envelope.code} (§4.3.7 forbids the mismatch)`);
  }
  return envelope;
}

export async function seedTypeFromPack(db: Db, s: Seed, code: string): Promise<string> {
  const envelope = readEnvelope(code);
  // SELECT-OR-INSERT, not insert. `postFromPack` calls this on EVERY post, and a fixture posts the same
  // code four times; `app.document_type` carries `unique (tenant_id, code)`, so a second bare insert
  // raises 23505 and every test after the first would fail on setup. 2A's `seedDocumentType` is not
  // assumed to be idempotent — Task 0's gate greps it for `on conflict` and reports what it found, and
  // this guard is correct either way.
  const [existing] = await db.rw<{ id: string }[]>`
    select id::text from app.document_type
     where tenant_id = ${s.tenant} and code = ${code} limit 1`;
  if (existing) return existing.id;

  return seedDocumentType(db, s, {
    code: envelope.code,
    module: envelope.module,
    policy: envelope.policy,
    policyVersion: envelope.policyVersion,
    effectiveFrom: envelope.effectiveFrom,
  });
}

/**
 * The twelve accounts every AR/AP test in slice 4B touches, each with the slice that seeds it in
 * production. `seedAccount` is `on conflict (company_id, code) do nothing` followed by a select
 * (phase-1a:2388-2405), so it is idempotent and `4000`, which `seedTenantV2` already created, returns the
 * existing id rather than colliding. `5920` is deliberately absent: nothing here needs its id, because
 * `resolveFxAccounts` reads `company.fx_rounding_account_id`, which `seedTenantV2` wired
 * (phase-1a:2424). `1150` is absent unless OD-09 landed (Task 9 seeds it).
 *
 * The last three exist because Task 4 posts three INVENTORY documents through `postFromPack`, and each
 * one's policy resolves an account by code that `seedTenantV2` does not create — so without them every
 * post in that fixture raises ERR_POLICY_REQUIRES_MISSING on the code:
 *   GOODS_RECEIPT    → `account: { code: "2150" }` and `{ code: "1300" }`  (3C, phase-3c:2302)
 *   DELIVERY_ORDER   → `account: { code: "1250" }`                        (3D, phase-3d:2028)
 *   EXPIRY_WRITE_OFF → `account: { code: "5100" }`                        (3D's policy over 3C's account,
 *                                                                          phase-3d:4143)
 * §4.15 assigns 1250 to 3D and 2150/5100 to 3C; this file CREATES them in a Testcontainers company and
 * re-seeds no pack file, which is the same thing every other slice's fixture does with a code it consumes.
 */
const ACCOUNTS = [
  { code: "1100", nameEn: "Bank",                            type: "asset"     },  // 0C
  { code: "1200", nameEn: "Trade receivables (AR control)",  type: "asset"     },  // 0C
  { code: "1250", nameEn: "Goods delivered not invoiced",    type: "asset"     },  // 3D
  { code: "1300", nameEn: "Inventory control",               type: "asset"     },  // 0C
  { code: "2100", nameEn: "Trade payables (AP control)",     type: "liability" },  // 0C
  { code: "2150", nameEn: "Goods received not invoiced (GRNI)", type: "liability" }, // 3C
  { code: "4000", nameEn: "Sales",                           type: "income"    },  // 0C
  { code: "4900", nameEn: "Foreign-exchange gain",           type: "income"    },  // 0C
  { code: "5000", nameEn: "Cost of goods sold",              type: "expense"   },  // 0C
  { code: "5100", nameEn: "Inventory write-off — expiry loss", type: "expense" },  // 3C
  { code: "5900", nameEn: "Other operating expense",         type: "expense"   },  // 0C
  { code: "5910", nameEn: "Foreign-exchange loss",           type: "expense"   },  // 0C
] as const;

/** Every 4A/4B document type these tests post. FX_REVALUATION is absent until Task 5 writes its file. */
const TYPES = ["SALES_INVOICE", "SALES_CREDIT_NOTE", "PURCHASE_INVOICE", "PURCHASE_CREDIT_NOTE",
               "RECEIPT", "PAYMENT"] as const;

export interface ArApFixture {
  documentTypeIds: Readonly<Record<string, string>>;
  accountIds: Readonly<Record<string, string>>;
  partyIds: { customer: string; vendor: string };
  termId: string;
}

/**
 * Open periods for 2025 and 2026 (3B's helper — Plan 0A opens only 2026-01, closes 2026-02 and LOCKS
 * 2026-03), the twelve accounts, a customer and a vendor on a 30-day term, every 4A type, and every
 * permission code the posting transaction evaluates. `seedTenant` grants s.human nothing (§4.1, pinned),
 * so the grant is not optional: 2B's R2 reads policy.approval.post INSIDE postDocument's transaction.
 *
 * **The five INVENTORY codes are not padding.** Task 4 posts three inventory documents through
 * `postFromPack`, and 2B's R2 asks `app.actor_has(policy.approval.post, …)` inside the post, so without
 * them each raises ERR_RBAC_FORBIDDEN before any arithmetic runs:
 *   GOODS_RECEIPT    → post `inventory.receipt.post`     (§4.14; create `inventory.receipt.create`)
 *   DELIVERY_ORDER   → post `inventory.transfer.post`    (phase-3d:2035; create `inventory.transfer.create`)
 *   EXPIRY_WRITE_OFF → approve AND post `inventory.adjustment.approve`, create
 *                      `inventory.adjustment.create`     (phase-3d:4149)
 * `EXPIRY_WRITE_OFF` also carries `approval.required: true`, which `postFromPack` handles by walking the
 * state machine with a second principal — see the note under `postFromPack`.
 */
export async function arApFixture(db: Db, s: Seed): Promise<ArApFixture> {
  await ensureOpenPeriods(db, s, 2025);
  await ensureOpenPeriods(db, s, 2026);
  await grantCodes(db, s, { codes: [
    "accounting.journal.post", "accounting.sales.create", "accounting.sales.post",
    "accounting.purchase.create", "accounting.purchase.post",
    "accounting.receipt.create", "accounting.receipt.post",
    "accounting.payment.create", "accounting.payment.approve", "accounting.payment.post",
    "accounting.bank.reconcile",
    // 3C's and 3D's codes, for the three inventory documents Task 4's fixture posts (see above).
    "inventory.receipt.create", "inventory.receipt.post",
    "inventory.transfer.create", "inventory.transfer.post",
    "inventory.adjustment.create", "inventory.adjustment.approve",
  ] });

  const accountIds: Record<string, string> = {};
  for (const a of ACCOUNTS) accountIds[a.code] = await seedAccount(db, s, a);

  const termId = await seedPaymentTerm(db, s, { code: "N30", dueDays: 30 });
  const customer = await seedParty(db, s, {
    kind: "customer", code: "CUST-1", receivableAccountId: accountIds["1200"] });
  const vendor = await seedParty(db, s, {
    kind: "vendor", code: "VEND-1", payableAccountId: accountIds["2100"] });
  await withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
    async (tx) => {
      await tx`update app.party set payment_term_id = ${termId}
                where id in (${customer}, ${vendor})`;
    });

  const documentTypeIds: Record<string, string> = {};
  for (const code of TYPES) documentTypeIds[code] = await seedTypeFromPack(db, s, code);

  return { documentTypeIds, accountIds, partyIds: { customer, vendor }, termId };
}

export interface PostFromPackOptions {
  code: string;
  effectiveDate: string;
  partyId?: string;
  currency?: string;
  exchangeRate?: string;
  rateSource?: string;
  /**
   * HEADER warehouse. A type whose policy resolves `inventory.warehouse: "header.warehouse"` and
   * declares `requires: ["warehouse"]` — 3C's `GOODS_RECEIPT` and 3D's `DELIVERY_ORDER` both do —
   * reads it off the DOCUMENT, not off the line, and fails its own gate without it. **Passed straight
   * through to 3C's `draftTypedDocument`, which already declares `warehouseId?: string` and already
   * writes `app.document.warehouse_id`** (`DraftTypedDocumentOptions`, phase-3c:403-414; the column is
   * 3A's, migration 0031, §4.3.4). An earlier draft of this helper set it with a follow-up `UPDATE`
   * because it had not read 3C's option shape; that was a second writer of a column 3C's helper owns.
   */
  warehouseId?: string;
  /**
   * Passed straight through to `postDocument` (3B amendment A5). Omit it and the post runs with no job
   * client at all, which is the state Task 4 Step 5's "warns and skips" case asserts; pass 3B's
   * `recordingJobs()` and step 14's enqueue becomes observable.
   */
  jobs?: JobClient;
  lines: readonly DraftLine[];
  /** Allocations to apply through 4A's allocateSettlement, in the same transaction as the post. */
  allocate?: readonly { settledDocumentId: string; amount: Money<CurrencyCode> }[];
}

/** The `approval` block of a pack envelope's policy — the three members §4.4.1 requires. */
export interface PackApproval { required: boolean; approve: string | null; post: string }

/**
 * Read `policy.approval` out of the pack file. `postFromPack` derives the state-machine path from THIS
 * rather than from a caller-supplied flag, so a call site cannot forget that a type needs approval — the
 * defect that would otherwise make Task 4's EXPIRY_WRITE_OFF case and Task 7's PAYMENT post (and with it
 * acceptance test 39) fail with ERR_DOC_STATUS_ILLEGAL at §4.3.2 step 2.
 */
export function packApproval(code: string): PackApproval {
  const { policy } = readEnvelope(code);
  const a = (policy as { approval?: Partial<PackApproval> } | null)?.approval;
  if (!a || typeof a.post !== "string") {
    throw new Error(`${code}.json declares no policy.approval.post — §4.4.1 requires it`);
  }
  return { required: a.required === true, approve: a.approve ?? null, post: a.post };
}

/**
 * One approver principal per (tenant, document-type code), holding that type's `approve` and `post`
 * codes. `secondPrincipal` is already idempotent by label (it selects on `auth_subject`,
 * phase-3b:2489-2493), but `grantCodes` inserts a FRESH `app.role` on every call, so the grant is
 * memoised: a fixture that posts four PAYMENTs must not leave four roles behind.
 */
const approvers = new Map<string, Promise<string>>();

async function approverFor(db: Db, s: Seed, code: string, approval: PackApproval): Promise<string> {
  const key = `${s.tenant}:${code}`;
  let pending = approvers.get(key);
  if (!pending) {
    pending = (async () => {
      const principalId = await secondPrincipal(db, s, `approver-${code}`);
      // `roleCode` is deliberately NOT passed: grantCodes defaults it to a unique
      // `grant-<8 hex>` (phase-2b:1031), and a fixed code would collide on unique (tenant_id, code)
      // the second time any test in the run needed an approver.
      await grantCodes(db, s, {
        principalId,
        codes: [...new Set([approval.approve ?? approval.post, approval.post])],
      });
      return principalId;
    })();
    approvers.set(key, pending);
  }
  return pending;
}

/**
 * Draft a typed document with 3C's `draftTypedDocument`, walk it through 2B's REAL state machine when the
 * pack's policy says approval is required, post it through 1A's frozen `postDocument`, and — when
 * `allocate` is given — apply 4A's `allocateSettlement` in the same transaction, which is the shape a real
 * settlement takes and the shape Task 5's realised-FX wrapper replaces.
 */
export async function postFromPack(
  db: Db, s: Seed, opts: PostFromPackOptions,
): Promise<{ documentId: string; result: PostResult }> {
  const typeId = await seedTypeFromPack(db, s, opts.code);
  const approval = packApproval(opts.code);
  const { documentId } = await draftTypedDocument(db, s, {
    documentTypeId: typeId,
    series: "TMP",                      // issueDocument overwrites this from policy.numbering.series
    effectiveDate: opts.effectiveDate,
    currency: opts.currency ?? "MYR",
    exchangeRate: opts.exchangeRate ?? "1.00000000",
    // 3C's `partyId` is `string | undefined`, never `string | null` (phase-3c:410), so the member is
    // omitted rather than nulled — `?? null` does not type-check under strict.
    ...(opts.partyId === undefined ? {} : { partyId: opts.partyId }),
    ...(opts.warehouseId === undefined ? {} : { warehouseId: opts.warehouseId }),
    branchId: s.hq,
    lines: opts.lines,
  });

  const humanCtx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
  if (opts.rateSource) {
    await withTenant(db.rw, humanCtx, (tx) =>
      tx`update app.document set rate_source = ${opts.rateSource} where id = ${documentId}`);
  }

  // ── The approval path, taken ONLY when the pack's policy says `approval.required` ───
  //
  // §4.5.1 makes `draft → issued` legal only when the effective policy has `approval.required = false`,
  // and §4.3.2 step 2 turns anything else into ERR_DOC_STATUS_ILLEGAL — so a bare `postDocument` on an
  // approval-required type never posts. Two of the types this slice's fixtures use are
  // approval-required: 4A's PAYMENT (§4.14: "approve accounting.payment.approve, post
  // accounting.payment.post, required") and 3D's EXPIRY_WRITE_OFF (phase-3d:4149). Every other code
  // these fixtures post — SALES_INVOICE, SALES_CREDIT_NOTE, PURCHASE_INVOICE, PURCHASE_CREDIT_NOTE,
  // RECEIPT, GOODS_RECEIPT, DELIVERY_ORDER, FX_REVALUATION — has `approval.required: false` and takes
  // the straight path below, unchanged from the shape every earlier task's fixture already relies on.
  //
  // R1 forbids the approver from being a `submitted` actor, and it is checked AGAIN at `issued → posted`
  // (§4.5.1's two R1 rows), so `s.human` submits and the APPROVER approves, issues AND posts. Running the
  // post as `s.human` would satisfy R2 and fail R1.
  let postCtx = humanCtx;
  if (approval.required) {
    const approver = await approverFor(db, s, opts.code, approval);
    postCtx = { tenantId: s.tenant, actorId: approver, requestId: await uuidv7(db.admin) };
    await withTenant(db.rw, humanCtx, (tx) =>
      transitionDocument(tx, humanCtx, { documentId, to: "submitted" }));
    // A SEPARATE transaction, because R1 compares app.current_actor() against every `submitted` actor
    // and the actor is set by withTenant's own SET LOCAL (§4.2.2).
    await withTenant(db.rw, postCtx, async (tx) => {
      await transitionDocument(tx, postCtx, { documentId, to: "approved" });
      await transitionDocument(tx, postCtx, { documentId, to: "issued" });
    });
  }

  const result = await withTenant(db.rw, postCtx, async (tx) => {
    const posted = await postDocument(tx, postCtx, { documentId, jobs: opts.jobs });
    if (opts.allocate?.length) {
      await allocateSettlement(tx, postCtx, {
        settlementDocumentId: documentId,
        lines: opts.allocate.map((a) => ({ settledDocumentId: a.settledDocumentId, amount: a.amount })),
      });
    }
    return posted;
  });
  return { documentId, result };
}
```

**Four things about this helper that are deliberate, and that an executor must not "simplify".**

**`allocate` takes a `settledDocumentId`.** That is what compiles against 4A's frozen `AllocationLine` (§4.8.1: `{ settledDocumentId: string; amount: Money }`). A convenience overload taking a code plus an index would be a second way to name a document, which is hazard 9; Step 2's fixture therefore captures `oldInvoiceId` from the `postFromPack` return and passes it.

**`jobs` is optional and is threaded, not defaulted.** `postDocument(tx, ctx, { documentId, jobs: opts.jobs })` passes `undefined` through when the caller omitted it, which is exactly the input step 14's warn-and-skip branch is specified against (3B amendment A5 made the member optional for this reason). Defaulting it to a live client here would make Task 4 Step 5's "no job client → one warning, no throw" case untestable.

**`warehouseId` and `partyId` go through 3C's own options, and nothing here writes `app.document` twice.** `GOODS_RECEIPT` and `DELIVERY_ORDER` resolve `inventory.warehouse: "header.warehouse"` and declare `requires: ["warehouse"]`, so they read the **document**, not the line, and raise a `PostingError` without it. 3C's frozen `DraftTypedDocumentOptions` already declares both members (`partyId?: string`, `warehouseId?: string`, phase-3c:403-414) and its body already inserts `warehouse_id` and `party_id` into `app.document` (phase-3c:436-441), so both are passed through and **the two are spread conditionally rather than defaulted to `null`**: the members are `string | undefined`, `opts.partyId ?? null` is `string | null`, and TypeScript strict rejects the assignment. `rateSource` keeps its own `UPDATE` because 3C's shape has no member for it and `document.rate_source` is 1A's column, written by the create handler in production.

**The approval path is derived from the pack, not requested by the caller.** `packApproval(code)` reads `policy.approval` off the same envelope `seedTypeFromPack` configures, so **no call site can forget it** — and three of this slice's fixtures depend on that: 4A's `PAYMENT` (§4.14 — "approve `accounting.payment.approve`, post `accounting.payment.post`, required"), which acceptance test 39's `beforeAll` posts, and 3D's `EXPIRY_WRITE_OFF` (`approval.required: true`, phase-3d:4149), which Task 4's non-sale case posts. §4.5.1 admits `draft → issued` **only** when `approval.required = false`, so a bare `postDocument` on any of them is `ERR_DOC_STATUS_ILLEGAL` at §4.3.2 step 2 — not a wrong number, a document that never posts and a test that never runs. 4A's `postArDocument` puts the same decision behind an opt-in `twoPrincipal: boolean` (phase-4a:2705); reading the policy is the same behaviour with the forgetting removed, and it is the one place `postFromPack` is deliberately *not* that helper (see Task 0's RELATIONSHIP note). **R1 is checked twice** — at `submitted → approved` and again at `issued → posted` (§4.5.1) — so the approver, not `s.human`, performs the post; a post by the submitter satisfies R2 and fails R1 with `ERR_SOD_MAKER_IS_CHECKER`. When `allocate` is also given it runs in that same transaction under the approver's context, which is correct and currently untested-by-accident: `RECEIPT` is `approval.required = false` (§4.14, "no maker-checker", spec:2147), so every `allocate` call site in this slice runs as `s.human`. **If a later slice allocates on an approval-required settlement, check 4A's `allocateSettlement` for an actor-bound gate first** — it has none as written (phase-4a:4801-4813).

- [ ] **Step 5: Write `packages/db/src/ar-ap/ageing.ts`**

```ts
// packages/db/src/ar-ap/ageing.ts
//
// Slice 4B. The TypeScript over migration 0048's app.party_ageing_rows: it selects, it MERGEs, it
// compares and it ties out. It contains NO ageing arithmetic of its own (ADR 0046) — every figure below
// comes out of the SQL function, so the report, the snapshot and the integrity comparison cannot
// disagree about what "open" means.
import type { Sql } from "postgres";
import type { ProjectionMismatch } from "../integrity/types";

export type AgeingBucket = "current" | "1_30" | "31_60" | "61_90" | "over_90";

/** Registry order, oldest last. Every column set and every screen renders in this order. */
export const PARTY_AGEING_BUCKETS: readonly AgeingBucket[] = [
  "current", "1_30", "31_60", "61_90", "over_90",
];

export interface PartyAgeingRow {
  partyId: string;
  currency: string;
  bucket: AgeingBucket;
  amount: string;
  baseAmount: string;
}
export interface AgeingParams { companyId: string; asOf: string }

interface RawRow { party_id: string; currency: string; bucket: AgeingBucket; amount: string; base_amount: string }

/** The fresh computation. `::text` on both amounts so no JavaScript number ever touches money (spec:2041). */
export async function ageingRows(tx: Sql, params: AgeingParams): Promise<PartyAgeingRow[]> {
  const rows = await tx<RawRow[]>`
    select party_id, currency, bucket, amount::text, base_amount::text
      from app.party_ageing_rows(${params.companyId}, ${params.asOf}::date)
     order by party_id, currency, bucket`;
  return rows.map((r) => ({
    partyId: r.party_id, currency: r.currency, bucket: r.bucket,
    amount: r.amount, baseAmount: r.base_amount,
  }));
}

/**
 * MERGE the fresh rows into the snapshot for this (company, as_of), then zero the keys of the same scope
 * the fresh set no longer contains. It never DELETEs: §3.5.4's app_rw DELETE list is pinned to five
 * tables and 2B is its only extender (ADR 0046). A zeroed row and an absent row read identically.
 */
export async function rebuildPartyAgeing(
  tx: Sql, params: AgeingParams,
): Promise<{ merged: number; zeroed: number }> {
  const merged = await tx`
    merge into app.party_ageing t
    using (select app.current_tenant() as tenant_id, ${params.companyId}::uuid as company_id,
                  r.party_id, r.currency, ${params.asOf}::date as as_of, r.bucket, r.amount, r.base_amount
             from app.party_ageing_rows(${params.companyId}, ${params.asOf}::date) r) s
       on t.company_id = s.company_id and t.party_id = s.party_id
      and t.currency   = s.currency   and t.as_of    = s.as_of
      and t.bucket     = s.bucket
     when matched then update
          set amount = s.amount, base_amount = s.base_amount, updated_at = now()
     when not matched then insert
          (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount)
          values (s.tenant_id, s.company_id, s.party_id, s.currency, s.as_of, s.bucket, s.amount, s.base_amount)`;

  const zeroed = await tx`
    update app.party_ageing t
       set amount = 0, base_amount = 0, updated_at = now()
     where t.company_id = ${params.companyId} and t.as_of = ${params.asOf}::date
       and (t.amount <> 0 or t.base_amount <> 0)
       and not exists (
         select 1 from app.party_ageing_rows(${params.companyId}, ${params.asOf}::date) r
          where r.party_id = t.party_id and r.currency = t.currency and r.bucket = t.bucket)`;

  return { merged: merged.count, zeroed: zeroed.count };
}

/** Rebuild-and-compare (test 2, spec:1204 "a mismatch is an incident"). A missing side reads as zero. */
export async function comparePartyAgeing(tx: Sql, params: AgeingParams): Promise<ProjectionMismatch[]> {
  const rows = await tx<{
    party_id: string; currency: string; bucket: string;
    stored_amount: string | null; stored_base: string | null;
    fresh_amount: string | null; fresh_base: string | null;
  }[]>`
    with stored as (
      select party_id, currency, bucket, amount, base_amount
        from app.party_ageing
       where company_id = ${params.companyId} and as_of = ${params.asOf}::date
         and (amount <> 0 or base_amount <> 0)
    ),
    fresh as (
      select party_id, currency, bucket, amount, base_amount
        from app.party_ageing_rows(${params.companyId}, ${params.asOf}::date)
    )
    select coalesce(s.party_id, f.party_id) as party_id,
           coalesce(s.currency, f.currency) as currency,
           coalesce(s.bucket,   f.bucket)   as bucket,
           s.amount::text      as stored_amount, s.base_amount::text as stored_base,
           f.amount::text      as fresh_amount,  f.base_amount::text as fresh_base
      from stored s
      full outer join fresh f
        on f.party_id = s.party_id and f.currency = s.currency and f.bucket = s.bucket
     where s.party_id is null or f.party_id is null
        or s.amount <> f.amount or s.base_amount <> f.base_amount
     order by 1, 2, 3`;

  return rows.map((r) => {
    const key = { company_id: params.companyId, party_id: r.party_id, currency: r.currency,
                  as_of: params.asOf, bucket: r.bucket };
    if (r.stored_amount === null) {
      return { projection: "party_ageing", key, side: "missing_in_projection" as const,
               detail: `fresh amount ${r.fresh_amount}, base_amount ${r.fresh_base}, no stored row` };
    }
    if (r.fresh_amount === null) {
      return { projection: "party_ageing", key, side: "missing_in_rebuild" as const,
               detail: `stored amount ${r.stored_amount}, base_amount ${r.stored_base}, no fresh row` };
    }
    const parts: string[] = [];
    if (r.stored_amount !== r.fresh_amount) parts.push(`amount ${r.stored_amount} <> ${r.fresh_amount}`);
    if (r.stored_base !== r.fresh_base) parts.push(`base_amount ${r.stored_base} <> ${r.fresh_base}`);
    return { projection: "party_ageing", key, side: "amount_differs" as const, detail: parts.join("; ") };
  });
}

export interface AgeingTieOutRow {
  accountId: string; accountCode: string; accountType: string;
  ageingBase: string; ledgerBase: string; revaluationBase: string; difference: string;
}

/**
 * The definition-of-done figure (§4.8.2, ADR 0046). One row per control account any party of the company
 * points at, with the sign taken from the account's TYPE — an asset control is debit-positive, a
 * liability control credit-positive, which is the same flip app.party_ageing_rows applies for a vendor.
 *
 *   difference = ageingBase − (ledgerBase − revaluationBase)
 *
 * and "0.0000" is the DoD. `revaluationBase` is the base carried by posted, not-yet-reversed UNREALISED
 * FX_REVALUATION documents: the ageing values open items at each document's own rate, so an unrealised
 * restatement of the control account is legitimately outside it until it is reversed at period start.
 */
export async function ageingTieOut(tx: Sql, params: AgeingParams): Promise<AgeingTieOutRow[]> {
  const rows = await tx<{
    account_id: string; code: string; type: string;
    ageing_base: string; ledger_base: string; revaluation_base: string; difference: string;
  }[]>`
    with control as (
      select distinct
             case when p.kind = 'vendor'
                  then coalesce(p.payable_account_id, p.receivable_account_id)
                  else coalesce(p.receivable_account_id, p.payable_account_id) end as account_id
        from app.party p
       where p.company_id = ${params.companyId}
    ),
    acct as (
      select a.id, a.code, a.type::text as type,
             case when a.type = 'liability' then -1 else 1 end as sign
        from app.account a join control c on c.account_id = a.id
       where a.company_id = ${params.companyId}
    ),
    ageing as (
      select case when p.kind = 'vendor'
                  then coalesce(p.payable_account_id, p.receivable_account_id)
                  else coalesce(p.receivable_account_id, p.payable_account_id) end as account_id,
             sum(g.base_amount) as base
        from app.party_ageing_rows(${params.companyId}, ${params.asOf}::date) g
        join app.party p on p.id = g.party_id
       group by 1
    ),
    led as (
      select le.account_id, sum(le.base_debit - le.base_credit) as base
        from app.ledger_entry le
       where le.company_id = ${params.companyId} and le.effective_date <= ${params.asOf}::date
       group by 1
    ),
    rev as (
      -- EXISTS, never a join to document_line: a join would multiply every ledger row by the number of
      -- marked lines (two per exposure pair), reading a revaluation of 800 where 400 was posted.
      select le.account_id, sum(le.base_debit - le.base_credit) as base
        from app.ledger_entry le
        join app.document d      on d.id = le.document_id
        join app.document_type t on t.id = d.document_type_id
       where le.company_id = ${params.companyId}
         and le.effective_date <= ${params.asOf}::date
         and t.code = 'FX_REVALUATION'
         and exists (select 1 from app.document_line ol
                      where ol.document_id = coalesce(d.reverses_document_id, d.id)
                        and ol.custom_fields->>'fxKind' = 'unrealised')
       group by 1
    )
    -- `g.base` is ALREADY party-oriented (positive means open, in both directions — app.party_ageing_rows
    -- flips the vendor side), while `l.base` and `r.base` are the ledger's debit-minus-credit. So the sign
    -- brings the LEDGER columns into the ageing's orientation and is never applied to the ageing column:
    --   1200 (asset,  sign  1): 4000 − ( 4400 −  400) = 0
    --   2100 (liability, −1) : 2500 − (−1) × (−2750 − (−250)) = 0
    select a.id as account_id, a.code, a.type,
           coalesce(g.base, 0)::text                                              as ageing_base,
           (a.sign * coalesce(l.base, 0))::text                                   as ledger_base,
           (a.sign * coalesce(r.base, 0))::text                                   as revaluation_base,
           (coalesce(g.base, 0) - a.sign * (coalesce(l.base, 0) - coalesce(r.base, 0)))::text as difference
      from acct a
      left join ageing g on g.account_id = a.id
      left join led    l on l.account_id = a.id
      left join rev    r on r.account_id = a.id
     order by a.code`;

  return rows.map((r) => ({
    accountId: r.account_id, accountCode: r.code, accountType: r.type,
    ageingBase: r.ageing_base, ledgerBase: r.ledger_base,
    revaluationBase: r.revaluation_base, difference: r.difference,
  }));
}

/** The `rev` figure above for one account, exported because Task 5's tests assert it directly. */
export async function outstandingRevaluation(
  tx: Sql, params: { companyId: string; accountId: string; asOf: string },
): Promise<string> {
  const [row] = await tx<{ base: string }[]>`
    select coalesce(sum(le.base_debit - le.base_credit), 0)::text as base
      from app.ledger_entry le
      join app.document d      on d.id = le.document_id
      join app.document_type t on t.id = d.document_type_id
     where le.company_id = ${params.companyId}
       and le.account_id = ${params.accountId}
       and le.effective_date <= ${params.asOf}::date
       and t.code = 'FX_REVALUATION'
       and exists (select 1 from app.document_line ol
                    where ol.document_id = coalesce(d.reverses_document_id, d.id)
                      and ol.custom_fields->>'fxKind' = 'unrealised')`;
  return row?.base ?? "0.0000";
}
```

**Three things in `ageingTieOut` a reader will want explained, and one trap this code exists to avoid.**

**Why `exists`, never a join, to reach `document_line`.** The marker lives on lines, but the figure being summed lives on `ledger_entry`. An FX revaluation posts a *pair* of lines (the subject account and the gain-or-loss account), so joining `document_line` multiplies every ledger row by the number of marked lines and reads a revaluation of **800** where **400** was posted — silently, and in the direction that makes the tie-out look broken when it is not. `exists` asks the only question that matters ("is this document an unrealised revaluation?") without changing the cardinality of the sum. The same `exists` appears in `outstandingRevaluation` for the same reason, and **the two must stay identical** — which is why test 8's clause 3 reads the figure by *both* paths and asserts they agree:

```ts
    // The tie-out's own `rev` term and the exported reader are two spellings of one query; if a future
    // edit changes one, this is the assertion that catches it.
    expect(tie.find((r) => r.accountCode === "1200")!.revaluationBase)
      .toBe(await withTenant(db.rw, await ctxFor(), (tx) =>
        outstandingRevaluation(tx, { companyId: s.company,
                                     accountId: f.accountIds["1200"]!, asOf: "2026-01-31" })));
```

**How a reversal is counted.** `coalesce(d.reverses_document_id, d.id)` looks at the **original's** lines when the document is a reversal and at its own otherwise, because `reverseDocument` may or may not copy `custom_fields` onto the reversing lines — that is 1A's implementation detail and this plan does not assume it either way (amendment 5). Both halves therefore count whichever way 1A behaves, and they net to zero once the reversal has posted, which is what makes the DoD equality hold for a date after period start.

**Where `sign` is applied, and where it must not be.** `app.party_ageing_rows` already returns a **party-oriented** figure: positive means "open", for a customer *and* for a vendor (§4.8.2 — the point of a bucket report is that a clerk never has to know the sign convention). `ledger_entry` returns the ledger's own debit-minus-credit. So `sign` brings the **ledger** columns into the ageing's orientation, and is never applied to `ageing_base`:

| account | type | `sign` | `ageing_base` | `ledger_base` raw | `revaluation_base` raw | difference |
|---|---|---|---|---|---|---|
| `1200` | asset | `+1` | `4000` | `4400` | `400` | `4000 − (+1)(4400 − 400) = 0` |
| `2100` | liability | `−1` | `2500` | `−2750` | `−250` | `2500 − (−1)(−2750 − (−250)) = 0` |

Multiplying `ageing_base` by `sign` as well — the shape this function had before review — reads `−1 × (2500 + 2750 − 250) = −5000` for `2100`, and passes only on the asset side. That is precisely the class of defect SAH-011 was: arithmetic that is correct in the one case its author exercised. The **liability** row of Step 2's DoD test is what pins it, and it is the reason that test asserts `2100` and not only `1200`.

- [ ] **Step 6: Write `packages/db/src/reports/ageing.ts`**

```ts
// packages/db/src/reports/ageing.ts
//
// The `accounting.ageing` read function (§4.16.3, amendment 10). 7C replaces the ROUTE's body with a
// ReportDefinition over this same function and re-runs Task 3's tie-out unchanged as the proof that
// nothing moved (§4.16.1's "re-expresses" rule), so this name and this row shape are contract.
//
// It computes FRESH through app.party_ageing_rows and never reads the stored snapshot: a snapshot exists
// only for the dates the job ran, and a report that answered "no snapshot for that date" would be a
// worse report (ADR 0046's last consequence).
import type { Sql } from "postgres";
import type { AgeingBucket } from "../ar-ap/ageing";

export interface AgedBalanceParams {
  companyId: string; asOf: string;
  partyId?: string; partyKind?: string; currency?: string; buckets?: readonly AgeingBucket[];
  cursor?: { partyCode: string; currency: string } | null;
  limit: number;
}
export interface AgedBalanceRow {
  partyId: string; partyCode: string; partyNameEn: string; partyNameAr: string | null; partyKind: string;
  currency: string;
  current: string; d1_30: string; d31_60: string; d61_90: string; over_90: string;
  total: string; totalBase: string;
}

export async function agedBalance(tx: Sql, params: AgedBalanceParams): Promise<AgedBalanceRow[]> {
  const buckets = params.buckets ?? null;
  const rows = await tx<{
    party_id: string; code: string; name_en: string; name_ar: string | null; kind: string;
    currency: string; b_current: string; b_1_30: string; b_31_60: string; b_61_90: string;
    b_over_90: string; total: string; total_base: string;
  }[]>`
    select g.party_id, p.code, p.name_en, p.name_ar, p.kind, g.currency,
           coalesce(sum(case when g.bucket = 'current' then g.amount end), 0)::text as b_current,
           coalesce(sum(case when g.bucket = '1_30'    then g.amount end), 0)::text as b_1_30,
           coalesce(sum(case when g.bucket = '31_60'   then g.amount end), 0)::text as b_31_60,
           coalesce(sum(case when g.bucket = '61_90'   then g.amount end), 0)::text as b_61_90,
           coalesce(sum(case when g.bucket = 'over_90' then g.amount end), 0)::text as b_over_90,
           sum(g.amount)::text      as total,
           sum(g.base_amount)::text as total_base
      from app.party_ageing_rows(${params.companyId}, ${params.asOf}::date) g
      join app.party p on p.id = g.party_id
     where (${params.partyId ?? null}::uuid is null   or g.party_id = ${params.partyId ?? null})
       and (${params.partyKind ?? null}::text is null or p.kind     = ${params.partyKind ?? null})
       and (${params.currency ?? null}::text is null  or g.currency = ${params.currency ?? null})
       and (${buckets}::text[] is null                or g.bucket   = any(${buckets}::text[]))
       and (${params.cursor === null || params.cursor === undefined}
            or (p.code, g.currency) > (${params.cursor?.partyCode ?? ""}, ${params.cursor?.currency ?? ""}))
     group by g.party_id, p.code, p.name_en, p.name_ar, p.kind, g.currency
     order by p.code, g.currency
     limit ${params.limit}`;

  return rows.map((r) => ({
    partyId: r.party_id, partyCode: r.code, partyNameEn: r.name_en, partyNameAr: r.name_ar,
    partyKind: r.kind, currency: r.currency,
    current: r.b_current, d1_30: r.b_1_30, d31_60: r.b_31_60, d61_90: r.b_61_90, over_90: r.b_over_90,
    total: r.total, totalBase: r.total_base,
  }));
}
```

- [ ] **Step 7: The barrel, the job payload key, and the worker handler**

`packages/db/src/ar-ap/index.ts` — **this file already exists and is 4A's.** 4A creates it in its Task 1 (phase-4a:556) as "the barrel; later tasks add their lines to it and nothing else" (phase-4a:932) and every 4A task appends one line to it: `./payment-term`, `./credit`, `./invoice`, `./credit-note`, `./allocation`, `./settlement`. `packages/db/src/index.ts` re-exports `./ar-ap` and nothing beneath it (phase-4a:562, :942), so **`allocateSettlement`, `unallocate`, `openBalance`, `partyBalance` and `listAllocations` reach `@dulja/db` *through* this barrel** — rewriting the file whole would delete 4A's entire AR/AP surface from the package and break `tests/invariants/support/ar-ap.ts`, `fx.ts` and every 4A consumer. Task 0's gate has a `need_repo` line on this exact file for that reason. **Append this block below 4A's lines and touch nothing above it:**

```ts
// packages/db/src/ar-ap/index.ts — appended by slice 4B, below 4A's `export * from "./…"` lines.
// Task 5 appends ./fx, Tasks 6-7 ./reconciliation, Tasks 9-10 ./pdc (⚠️ OD-09). 4A's lines —
// ./payment-term, ./credit, ./invoice, ./credit-note, ./allocation, ./settlement — are NOT touched,
// and this slice never re-exports a 4A name a second time (one export path per name, hazard 9).
export {
  ageingRows, ageingTieOut, comparePartyAgeing, outstandingRevaluation, rebuildPartyAgeing,
  PARTY_AGEING_BUCKETS,
  type AgeingBucket, type AgeingParams, type AgeingTieOutRow, type PartyAgeingRow,
} from "./ageing";
```

`packages/db/src/index.ts` gains **one** line and nothing else — `export * from "./ar-ap";` is already there, put by 4A's Task 1:

```ts
export { agedBalance, type AgedBalanceParams, type AgedBalanceRow } from "./reports/ageing";
```

`packages/db/src/jobs/payloads.ts` — **one key added, no other line touched** (amendment 1). `JobPayload extends Record<JobName, unknown>`, so a slice adds only its own key:

```ts
  /** Slice 4B. Omit both for the nightly whole-tenant run; `asOf` defaults to the run date. The shape is
   *  3B's inventory.projection.rebuild key verbatim — the two handlers are twins. */
  "accounting.projection.rebuild": { companyId?: string; asOf?: string };
```

`packages/db/src/jobs/names.ts` is **not** edited: the name and its `"0 3 * * *"` schedule are already in 0B's closed sixteen-name `JOBS` with `owner: "4B"` (§4.2.6).

`apps/worker/src/handlers/accounting-projection-rebuild.ts`:

```ts
// apps/worker/src/handlers/accounting-projection-rebuild.ts
//
// The nightly rebuild-and-compare of the two ASYNCHRONOUS projections (spec:1204). It runs as the
// tenant's system principal through systemContext and does ONE COMPANY PER TRANSACTION (spec:1368,
// hazard 20) — never one long transaction over a tenant.
//
// Task 3 ships the party_ageing half. Task 4 adds the rebuildItemProfitability call; item_profitability's
// COMPARISON is 1B's, through projectionChecks (ADR 0046), so it is not repeated here.
import {
  comparePartyAgeing, rebuildPartyAgeing, recordIntegrityIncident, systemContext, withTenant,
  type IntegrityReport, type ProjectionMismatch,
} from "@dulja/db";
import type { Sql } from "postgres";
import { log } from "../log";
import { registerHandler, type JobEnvelope } from "../handler";

const NAME = "accounting.projection.rebuild" as const;

export async function accountingProjectionRebuild(
  sql: Sql, job: JobEnvelope<{ companyId?: string; asOf?: string }>,
): Promise<void> {
  const asOf = job.payload.asOf ?? new Date().toISOString().slice(0, 10);
  const ctx = await systemContext(sql, job.tenantId, job.requestId);

  const companies = await withTenant(sql, ctx, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select id from app.company
       where (${job.payload.companyId ?? null}::uuid is null or id = ${job.payload.companyId ?? null})
       order by id`;
    return rows.map((r) => r.id);
  });

  const mismatches: ProjectionMismatch[] = [];
  for (const companyId of companies) {
    // One company per transaction. A failure on one company must not abandon the rest, so each is
    // attempted and the aggregate is reported once (the eachTenant rule of §4.2.6 applied inside a tenant).
    try {
      const found = await withTenant(sql, ctx, async (tx) => {
        const { merged, zeroed } = await rebuildPartyAgeing(tx, { companyId, asOf });
        log().info({ job: NAME, company_id: companyId, as_of: asOf, merged, zeroed },
                   "party_ageing rebuilt");
        return comparePartyAgeing(tx, { companyId, asOf });
      });
      mismatches.push(...found);
    } catch (error) {
      log().error({ job: NAME, company_id: companyId, as_of: asOf, error: String(error) },
                  "projection rebuild failed for one company");
      mismatches.push({
        projection: "party_ageing",
        key: { company_id: companyId, as_of: asOf },
        side: "amount_differs",
        detail: `rebuild threw: ${String(error)}`,
      });
    }
  }

  if (mismatches.length > 0) {
    const report: IntegrityReport = {
      tenantId: job.tenantId, requestId: job.requestId, checkedAt: new Date().toISOString(),
      ledgerBalance: { byPeriod: [], byDocument: [] },
      projections: { checked: ["party_ageing"], mismatches },
      auditChain: { rows: 0, brokenLinks: 0, badHashes: 0, firstBrokenSeq: null },
      periodReopens: [],
      ok: false,
      summary: `party_ageing: ${mismatches.length} mismatch(es) as of ${asOf}`,
    };
    await withTenant(sql, ctx, (tx) => recordIntegrityIncident(tx, report));
  }
}

registerHandler(NAME, accountingProjectionRebuild);
```

`tests/invariants/probes.ts` — one `JOB_PROBES` entry (hazard 31):

```ts
  "accounting.projection.rebuild": {
    async seed(db, attacker, victim) {
      // The victim owns an ageing snapshot; the attacker's job must not touch it.
      await withTenant(db.rw, victim.tenant, victim.human, async (tx) => {
        await tx`
          insert into app.party_ageing
            (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount)
          select ${victim.tenant}, ${victim.company}, p.id, 'MYR', '2026-01-31'::date, 'current', 5, 5
            from app.party p where p.company_id = ${victim.company} limit 1`;
      });
      void attacker;
    },
    async survivors(db, victim) {
      return withTenant(db.rw, victim.tenant, victim.human, async (tx) => {
        const [n] = await tx<{ n: number }[]>`
          select count(*)::int as n from app.party_ageing where amount <> 0`;
        return n!.n;
      });
    },
  },
```

- [ ] **Step 8: Mount the report `GET`, and the contracts DTOs**

`packages/contracts/src/accounting/reports.ts` — `ReportCodeSchema` widened (it is a wire-validation convenience and never a second register, §4.16.3) plus the ageing DTOs:

```ts
// ReportCodeSchema gains one member. §4.16.1 is the register; this enum is the set of codes whose ROUTE
// exists, widened by each report-shipping slice in the PR that ships the route.
export const ReportCodeSchema = z.enum([
  "accounting.trial_balance",
  "accounting.ledger",
  "inventory.stock_on_hand",
  "inventory.valuation",
  "inventory.sales_by_item",
  "accounting.ageing",          // 4B
]);

/**
 * Task 0 amendment 12's registered form, FILE-LOCAL and never a `common.ts` export. §4.2.8's "Money is
 * always { amount, currency }" is written for a standalone amount; an ageing row carries its `currency`
 * once and then seven figures in it, and `MoneySchema` on all seven would repeat the code seven times per
 * row AND force this handler to read `company.base_currency` for `totalBase` alone — a query the report
 * makes for no other reason. 1A already ships exactly this: `const Amount = z.string().regex(...)` with
 * `debit`/`credit` over it and the currency on the header (phase-1a:4638). The sign is admitted because an
 * unallocated receipt on account is a NEGATIVE open figure (money held, not owed) — Task 3 Step 2's
 * fourth case — and `agedBalance` returns `sum(...)::text` straight from `app.party_ageing_rows`.
 */
const AgeingAmount = z.string().regex(/^-?\d+\.\d{4}$/);

export const AgeingRowSchema = z.object({
  partyId: UuidSchema, partyCode: z.string(), partyNameEn: z.string(),
  partyNameAr: z.string().nullable(), partyKind: z.string(), currency: CurrencySchema,
  current: AgeingAmount, d1_30: AgeingAmount, d31_60: AgeingAmount, d61_90: AgeingAmount,
  over_90: AgeingAmount, total: AgeingAmount,
  // `totalBase` is in the COMPANY's base currency, not in the row's `currency`. The name says so and
  // amendment 4 says why the two are different views; nothing here converts.
  totalBase: AgeingAmount,
}).openapi("AgeingRow");
export type AgeingRowDto = z.infer<typeof AgeingRowSchema>;
export const AgeingList = ListEnvelope(AgeingRowSchema).openapi("AgeingList");

/**
 * §4.2.8 Layer 1 closes the flat-parameter set at ListQuery's four plus 0B/1A/1B's grandfathered
 * schemas, so `asOf` is NOT a flat parameter here: it is expressed inside the grammar as
 * `filter[as_of][eq]=YYYY-MM-DD` and it is REQUIRED. Layer 2 then makes `parseFilters` the right
 * mechanism rather than literal keys, because the surface is five fields wide with `in` on three of
 * them — which is the case §4.2.8 names 4B's ageing route as needing.
 */
export const AGEING_FILTER_FIELDS = ["as_of", "party_id", "party_kind", "currency", "bucket"] as const;
export const AgeingQuery = ListQuery;
```

`apps/api/src/routes/accounting/reports.ts` — **one `GET` added to 1B's existing module**; no second module on that path (§4.2.7's note on `reportsRouteModule`):

```ts
// 4B — one GET on 1B's reports module. No new RouteModule and therefore no new PROBES key: the
// /v1/companies/:companyId/reports key already exists (hazard 31).
reportsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/accounting.ageing",
    request: { params: CompanyParams, query: AgeingQuery },
    responses: {
      200: { content: { "application/json": { schema: AgeingList } }, description: "AR/AP ageing as of a date" },
      400: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "invalid filter" },
      403: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "forbidden" },
    },
    middleware: [requirePermission(PERMISSION["accounting.report.read"], { company: "path:companyId" })],
    tags: ["accounting"],
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const filters = parseFilters(c.req.queries());

    // No field name ever reaches SQL as text (test 27): every declared field maps through this closed
    // switch onto a typed parameter, and an undeclared one is ERR_VALIDATION_FAILED.
    const params: AgedBalanceParams = { companyId, asOf: "", limit: q.limit,
      cursor: q.cursor ? (decodeCursor(q.cursor).k as [string, string]).length === 2
        ? { partyCode: String(decodeCursor(q.cursor).k[0]), currency: String(decodeCursor(q.cursor).k[1]) }
        : null : null };
    for (const f of filters) {
      switch (f.field) {
        case "as_of":      params.asOf = f.value; break;
        case "party_id":   params.partyId = f.value; break;
        case "party_kind": params.partyKind = f.value; break;
        case "currency":   params.currency = f.value; break;
        case "bucket":
          params.buckets = f.value.split(",").filter(
            (b): b is AgeingBucket => (PARTY_AGEING_BUCKETS as readonly string[]).includes(b));
          break;
        default:
          throw new AppError("ERR_VALIDATION_FAILED", `filter field ${f.field} is not declared on accounting.ageing`,
            { errors: [{ path: `filter[${f.field}]`, message: `declared fields: ${AGEING_FILTER_FIELDS.join(", ")}` }] });
      }
    }
    if (!params.asOf) {
      throw new AppError("ERR_VALIDATION_FAILED", "accounting.ageing requires filter[as_of][eq]=YYYY-MM-DD",
        { errors: [{ path: "filter[as_of][eq]", message: "required" }] });
    }

    const items = await c.var.withTenant((tx) => agedBalance(tx, params));
    const last = items.at(-1);
    return c.json({
      items,
      next_cursor: items.length === params.limit && last
        ? encodeCursor({ k: [last.partyCode, last.currency], id: last.partyId })
        : null,
    }, 200);
  },
);
```

`reportsRouteModule.permissions` already contains `accounting.report.read` (1B), so it is unchanged.

- [ ] **Step 9: Append the `— 4B` block to `tests/regression/sah-011.test.ts`**

SAH-011 is "NULL arithmetic irreversibly nulls balances and tax boxes" (spec:311). 0B created the thin file; this slice appends and never edits an earlier block (§3.7.3).

```ts
describe("SAH-011 NULL arithmetic irreversibly nulls balances and tax boxes — 4B", () => {
  it("every monetary column of both async projections is NOT NULL DEFAULT 0", async () => {
    const { rw } = await sharedDb();
    const rows = await rw<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }[]>`
      select table_name, column_name, is_nullable, column_default
        from information_schema.columns
       where table_schema = 'app'
         and table_name in ('party_ageing', 'item_profitability')
         and data_type = 'numeric'
       order by table_name, column_name`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.is_nullable, `${r.table_name}.${r.column_name}`).toBe("NO");
      expect(r.column_default, `${r.table_name}.${r.column_name}`).toBe("0");
    }
  });

  it("the ageing function coalesces every accumulation, so no NULL can reach a bucket", async () => {
    const { rw } = await sharedDb();
    const [fn] = await rw<{ prosrc: string }[]>`
      select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'party_ageing_rows'`;
    // Every sum() in the body is wrapped: the old system's OnVouItemsAIUD did none of this and one NULL
    // foreign-currency line nulled a whole account balance permanently.
    const sums = fn!.prosrc.match(/sum\(/g) ?? [];
    const coalesced = fn!.prosrc.match(/coalesce\(/g) ?? [];
    expect(sums.length).toBeGreaterThan(0);
    expect(coalesced.length).toBeGreaterThanOrEqual(sums.length - 3);   // the three outer projection sums
  });
});
```

- [ ] **Step 10: Run everything to green**

```bash
bun run --cwd packages/db test -- ar-ap/ageing
bun run --cwd apps/worker test -- accounting-projection-rebuild
bun run --cwd apps/api test -- accounting/ageing-report
bun run --cwd tests test -- regression/sah-011
bun run --cwd tests test -- invariants/tenant-isolation     # the new JOB_PROBES entry
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
```

- [ ] **Step 11: Commit**

```bash
git add docs/adr/0046-ageing-and-item-profitability-projection-shapes.md \
        packages/db/src/ar-ap/ packages/db/src/reports/ageing.ts packages/db/src/index.ts \
        packages/db/src/jobs/payloads.ts apps/worker/src/handlers/accounting-projection-rebuild.ts \
        packages/contracts/src/accounting/reports.ts apps/api/src/routes/accounting/reports.ts \
        tests/invariants/support/ar-ap.ts tests/invariants/probes.ts \
        tests/regression/sah-011.test.ts \
        packages/db/test/ar-ap/ageing.test.ts \
        apps/worker/test/handlers/accounting-projection-rebuild.test.ts \
        apps/api/test/routes/accounting/ageing-report.test.ts
git commit -m "feat(db): party_ageing snapshot, the rebuild job and the accounting.ageing report [4B T3]

The first half of the Phase 4 DoD. ageingRows/rebuildPartyAgeing/comparePartyAgeing carry no
arithmetic of their own — every figure comes out of app.party_ageing_rows, so the report, the
snapshot and the integrity comparison cannot disagree about what open means (ADR 0046).

The rebuild MERGEs and zeroes and never DELETEs: §3.5.4's list is pinned. party_ageing does not
join projectionChecks — it is an as-of snapshot, the call 3B's ADR 0039 already made for
stock_valuation — so its compare lives in accounting.projection.rebuild.

ageingTieOut is the DoD figure: ageingBase − (ledgerBase − revaluationBase) == 0.0000 for 1200
and 2100. The third term is zero until Task 5 ships FX_REVALUATION, which is why this task's
tie-out case is same-currency and Task 5 re-asserts it across a cross-currency month.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `item_profitability` — the projection, its place in `projectionChecks`, step 14's enqueue, and test 7's revenue half

The third projection spec:1204 names. It is 4B's and not 3B's for one reason: **revenue does not exist before 4A**. 3D shipped `inventory.sales_by_item` on delivered quantity and cost because no revenue-posting type existed; 4A extended that same code with revenue and margin; this task backs it with a projection, and 7B re-expresses the code over this table.

**`item_profitability` joins 1B's `projectionChecks` registry** (ADR 0046) — it is current state keyed on `(company, item, fiscal_period)`, exactly the shape `account_balance` and `stock_on_hand` have, so it is compared by the job that already compares those. That makes `IntegrityReport.projections.checked` **`["account_balance", "cost_layer", "document_series", "item_profitability", "stock_on_hand"]`** — `projectionChecks()` sorts by name (1b:930–932), so the array stays alphabetical and no earlier member moves — and **the three pinned assertions that read it move in this task's PR**, exactly as 2B did for `document_series` and 3B for `cost_layer`.

**Files:**
- Create: `packages/db/src/projections/item-profitability.ts`, `packages/db/src/projections/index.ts`
- Create: `packages/db/test/ar-ap/item-profitability.test.ts`
- Modify: `packages/db/src/integrity/index.ts` (one registration), `packages/db/src/index.ts` (one re-export), `packages/db/src/posting/post.ts` (step 14 — amendment 2), `apps/worker/src/handlers/accounting-projection-rebuild.ts` (the second rebuild call), `tests/invariants/projection-rebuild.test.ts`, `tests/invariants/audit-chain.test.ts`, `apps/worker/test/handlers/integrity-check.test.ts` (the pinned array, all three), `docs/adr/0046-…md` (the consequence line is already written; tick it)

**Interfaces**

- Consumes: `app.item_profitability`, `app.item_profitability_rows` (Task 1); `app.document`, `app.document_type`, `app.document_line`, `app.ledger_entry`, `app.account_balance`, `app.fiscal_period` (plan0A, 1A); `app.item` (3A); `app.inventory_movement` (3A, §4.7.3); `app.cost_layer`, `app.cost_consumption` (3B, §4.7.3); `ProjectionCheck`, `ProjectionMismatch`, `registerProjectionCheck` (1B, §4.16.3); `salesByItem`, `SalesByItemRow` (3D, §4.16.3) — read in the tie-out to prove the two agree; `postDocument`, `PostResult`, `PostingError` (1A); `JobClient`, `JobEnvelope`, `EnqueueOptions` (§4.2.6); the production `withTenant`, `TenantContext` (§4.2.2); `Money`, `currency`, `Quantity` (§4.2.1); `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot` (3A), `postInventoryDocument`, `recordingJobs`, `ensureOpenPeriods` (3B), `arApFixture`, `postFromPack`, `seedTypeFromPack` (Task 3).
- Produces:
  ```ts
  // packages/db/src/projections/item-profitability.ts
  /** Document types whose movements are SALES movements. Membership only — it carries no sign
   *  (amendment 6). 6A appends "POS_TICKET" in the PR that seeds that type. */
  export const SALE_MOVEMENT_TYPES: readonly string[];
  /** Every other seeded type with a stock effect, so the exhaustiveness test can force the slice that
   *  adds a type to classify it rather than silently omitting it from the projection. */
  export const NON_SALE_MOVEMENT_TYPES: readonly string[];

  export interface ItemProfitabilityRow {
    itemId: string; fiscalPeriodId: string;
    quantitySold: string;   // 6 dp
    revenueBase: string; cogsBase: string; marginBase: string;   // 4 dp, base currency
  }
  export async function itemProfitabilityRows(tx: Sql, params: { companyId: string }): Promise<ItemProfitabilityRow[]>;
  export async function rebuildItemProfitability(
    tx: Sql, params: { companyId: string },
  ): Promise<{ merged: number; zeroed: number }>;
  /** Every visible company, so it fits `ProjectionCheck.run(tx)`'s one-argument shape. */
  export async function compareItemProfitability(tx: Sql): Promise<ProjectionMismatch[]>;
  export const ITEM_PROFITABILITY_CHECK: ProjectionCheck;   // { name: "item_profitability", run: compareItemProfitability }
  ```

- [ ] **Step 1: Write the failing test**

`packages/db/test/ar-ap/item-profitability.test.ts`. The fixture is the two-document sales path plus a credit note, because that is the case the attribution rule exists for.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Money, Quantity, currency } from "@dulja/domain";
import {
  ITEM_PROFITABILITY_CHECK, NON_SALE_MOVEMENT_TYPES, SALE_MOVEMENT_TYPES,
  compareItemProfitability, itemProfitabilityRows, projectionChecks, rebuildItemProfitability,
  reverseDocument, salesByItem,
} from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedItem, seedTenantV2, seedUnit, seedWarehouse, type Seed } from "../fixtures";
import {
  PACK_DIR, arApFixture, postFromPack, type ArApFixture, type DocumentTypeEnvelope,
} from "../../../../tests/invariants/support/ar-ap";

const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: ArApFixture;
let itemId: string;
let baseUnitId: string;
let warehouseId: string;
let invoiceId: string;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "profit");
  f = await arApFixture(db, s);
  await seedUnit(db, s, { code: "EA" });
  ({ itemId, baseUnitId } = await seedItem(db, s, { code: "IT-1", kind: "product" }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-1" });

  // 1. Receive 100 @ 10.00 base, so a cost layer exists (3C's GOODS_RECEIPT).
  //    `warehouseId` goes in the HEADER as well as on the line: the type declares
  //    `requires: ["warehouse"]` and resolves `inventory.warehouse: "header.warehouse"`.
  await postFromPack(db, s, {
    code: "GOODS_RECEIPT", effectiveDate: "2026-01-05", partyId: f.partyIds.vendor, warehouseId,
    lines: [{ kind: "item", itemId, warehouseId, unitId: baseUnitId,
              quantity: "100.000000", unitPrice: "10.0000", amount: "1000.0000" }],
  });
  // 2. Sell 30 at 25.00 on ONE unlinked SALES_INVOICE: revenue AND the stock issue on the same
  //    document. This is the shape the fixture must take — see the note under this block.
  ({ documentId: invoiceId } = await postFromPack(db, s, {
    code: "SALES_INVOICE", effectiveDate: "2026-01-12", partyId: f.partyIds.customer, warehouseId,
    lines: [{ kind: "item", itemId, warehouseId, unitId: baseUnitId,
              quantity: "30.000000", unitPrice: "25.0000", amount: "750.0000" }],
  }));
}, 300_000);
afterAll(async () => { await db?.stop(); });
```

⚠️ **Why the base fixture is ONE unlinked `SALES_INVOICE` and not the delivery-then-invoice pair.** The natural shape to reach for is 3D's two-document flow — a `DELIVERY_ORDER` moves the stock, a linked `SALES_INVOICE` carries the revenue — and the first draft of this task did exactly that, with the comment "no movement, the invoice is linked to the delivery". **That comment would have been false.** `SALES_INVOICE` is `outbound / issue` in its own envelope; nothing suppresses its movement except a fulfilment link, and a link is only created by 3C's `linkFulfilment`, which this fixture never calls. Both documents would therefore have issued 30 each: `quantitySold` 60, `cogsBase` 600, and the very first assertion red — while the *arithmetic under test* was right. Linking them here is not the fix either: `linkFulfilment`'s mechanics are 4A/3C's and the exact effect of a `fulfils` link on a downstream issue is a fact this plan has not read, so a fixture built on it would be an assumption dressed as a test.

So the base case is the **single-document** sale, which is self-contained and needs no link: one invoice, one movement, one revenue posting, one row. The two-document rule — *a delivery contributes quantity and cost but never revenue* — is what amendment 7 actually claims, and it is proved as a **delta** case at the end of this block, where a `DELIVERY_ORDER` is posted on its own and revenue is asserted **unchanged** while quantity and cost move. That is a stronger test of the claim than the original fixture was, and it does not depend on link semantics at all.

```ts
describe("item_profitability — the attribution (§4.6.1, amendments 6 and 7)", () => {
  it("the single-document sales path lands revenue and cost on ONE (item, period) row", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      itemProfitabilityRows(tx, { companyId: s.company }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId,
      quantitySold: "30.000000",     // from the SALES_INVOICE's OWN movement — it is outbound/issue and
                                     // nothing suppresses it; the delivery case is the last `it` here
      revenueBase: "750.0000",       // from the SALES_INVOICE's lines, which have a revenue ledger row
      cogsBase: "300.0000",          // 30 × 10.00 from cost_consumption
      marginBase: "450.0000",
    });
  });

  it("a HAND-DRAFTED credit note reduces revenue: doc_sign comes from the ledger, not from the type", async () => {
    await postFromPack(db, s, {
      code: "SALES_CREDIT_NOTE", effectiveDate: "2026-01-20", partyId: f.partyIds.customer,
      warehouseId,
      lines: [{ kind: "item", itemId, warehouseId, unitId: baseUnitId,
                quantity: "5.000000", unitPrice: "25.0000", amount: "125.0000" }],
    });
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      itemProfitabilityRows(tx, { companyId: s.company }));
    expect(rows[0]!.revenueBase).toBe("625.0000");            // 750 − 125
    expect(Money.of(rows[0]!.marginBase, MYR).isPositive()).toBe(true);
  });

  it("a REVERSAL-produced credit note reduces revenue too, though its line amounts are NEGATED (§4.4.2 A9)", async () => {
    const before = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      itemProfitabilityRows(tx, { companyId: s.company }));
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    await withTenant(db.rw, ctx, (tx) =>
      reverseDocument(tx, ctx, { documentId: invoiceId, effectiveDate: "2026-01-25",
                                 reason: "revenue reversal, item_profitability sign case" }));
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      itemProfitabilityRows(tx, { companyId: s.company }));
    // abs(amount) × the LEDGER's direction: a type → sign map would have added 750 here instead.
    expect(Money.of(after[0]!.revenueBase, MYR).toString())
      .toBe(Money.of(before[0]!.revenueBase, MYR).subtract(Money.of("750.0000", MYR)).toString());
  });

  it("a TRANSFER and an EXPIRY_WRITE_OFF are not sales — neither quantity nor cost reaches the row", async () => {
    const wh2 = await seedWarehouse(db, s, { code: "WH-2" });
    const before = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      itemProfitabilityRows(tx, { companyId: s.company }));
    await postFromPack(db, s, {
      code: "EXPIRY_WRITE_OFF", effectiveDate: "2026-01-28", warehouseId,
      lines: [{ kind: "item", itemId, warehouseId, unitId: baseUnitId,
                quantity: "2.000000", unitPrice: "10.0000", amount: "20.0000" }],
    });
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      itemProfitabilityRows(tx, { companyId: s.company }));
    expect(after[0]!.quantitySold).toBe(before[0]!.quantitySold);
    expect(after[0]!.cogsBase).toBe(before[0]!.cogsBase);
    void wh2;
  });

  // LAST in the block, because it is the only case that adds a stock issue: every assertion above is
  // written against the fixture's 30, and a delivery posted earlier would move them all.
  it("a DELIVERY_ORDER contributes quantity and cost but NEVER revenue (amendment 7)", async () => {
    const before = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      itemProfitabilityRows(tx, { companyId: s.company }));
    await postFromPack(db, s, {
      code: "DELIVERY_ORDER", effectiveDate: "2026-01-30", partyId: f.partyIds.customer, warehouseId,
      lines: [{ kind: "item", itemId, warehouseId, unitId: baseUnitId,
                quantity: "10.000000", unitPrice: "25.0000", amount: "250.0000" }],
    });
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      itemProfitabilityRows(tx, { companyId: s.company }));

    // The delivery's own line carries amount 250.0000 and a unit price. If revenue were read from
    // `document_line` rather than anchored to a REVENUE LEDGER ROW, this would rise by 250 — which is
    // the double-count amendment 7 exists to prevent, and the defect SAH-012 is the ledger analogue of.
    expect(after[0]!.revenueBase).toBe(before[0]!.revenueBase);

    // …while quantity and cost DO move, because the movement and its cost_consumption are real.
    expect(Quantity.of(after[0]!.quantitySold).toString())
      .toBe(Quantity.of(before[0]!.quantitySold).add(Quantity.of("10.000000")).toString());
    expect(Money.of(after[0]!.cogsBase, MYR).toString())
      .toBe(Money.of(before[0]!.cogsBase, MYR).add(Money.of("100.0000", MYR)).toString());  // 10 × 10.00

    // And the margin stays the difference of the two, which is the only invariant the row must hold.
    expect(Money.of(after[0]!.marginBase, MYR).toString())
      .toBe(Money.of(after[0]!.revenueBase, MYR).subtract(Money.of(after[0]!.cogsBase, MYR)).toString());
  });
});

describe("item_profitability — the two type lists (amendment 6)", () => {
  it("SALE_MOVEMENT_TYPES is membership only and does not yet contain POS_TICKET (6A appends it)", () => {
    expect([...SALE_MOVEMENT_TYPES].sort())
      .toEqual(["DELIVERY_ORDER", "SALES_CREDIT_NOTE", "SALES_INVOICE"]);
    expect(SALE_MOVEMENT_TYPES).not.toContain("POS_TICKET");
  });

  it("every SHIPPED type with a stock effect is classified in exactly one of the two lists", () => {
    // Read the SEED PACK off disk, not app.document_type. Two reasons, and both matter:
    //   1. `app.document_type` has NO `company_id` column (§4.3.7 keys it `(tenant_id, code)`), so the
    //      predicate this test used to carry — `where t.company_id is not null` — does not compile.
    //   2. The DB only holds what THIS test seeded, so a DB-driven check can never fail: the guard has
    //      to see every envelope the repository ships, which is what makes it bind on 6A when POS_TICKET
    //      lands with a stock effect and nobody has classified it.
    const dir = join(PACK_DIR, "document-types");
    const shipped = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const stockEffect = shipped
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as DocumentTypeEnvelope)
      .filter((e) => (e.policy as { inventory?: { effect?: string } }).inventory?.effect !== undefined
                  && (e.policy as { inventory?: { effect?: string } }).inventory?.effect !== "none")
      .map((e) => e.code);
    expect(stockEffect.length, "no shipped envelope declares a stock effect — the glob is wrong")
      .toBeGreaterThan(0);
    const classified = new Set<string>([...SALE_MOVEMENT_TYPES, ...NON_SALE_MOVEMENT_TYPES]);
    const unclassified = stockEffect.filter((c) => !classified.has(c));
    expect(unclassified,
      "a SHIPPED stock-effect document type is in neither SALE_MOVEMENT_TYPES nor " +
      "NON_SALE_MOVEMENT_TYPES — the slice that added it must classify it (amendment 6)").toEqual([]);
  });

  it("the two lists are disjoint", () => {
    for (const code of SALE_MOVEMENT_TYPES) expect(NON_SALE_MOVEMENT_TYPES).not.toContain(code);
  });
});

describe("item_profitability — the projection registry (test 2, ADR 0046)", () => {
  it("joins 1B's projectionChecks under its table name", () => {
    expect(ITEM_PROFITABILITY_CHECK.name).toBe("item_profitability");
    expect(projectionChecks().map((c) => c.name))
      .toEqual(["account_balance", "cost_layer", "document_series", "item_profitability", "stock_on_hand"]);
  });

  it("rebuild then compare finds nothing; a corrupted row is reported naming the column", async () => {
    await withTenant(db.rw, s.tenant, s.human, (tx) => rebuildItemProfitability(tx, { companyId: s.company }));
    expect(await withTenant(db.rw, s.tenant, s.human, (tx) => compareItemProfitability(tx))).toEqual([]);

    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`update app.item_profitability set cogs_base = cogs_base + 3 where company_id = ${s.company}`;
    });
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) => compareItemProfitability(tx));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ projection: "item_profitability", side: "amount_differs" });
    expect(mismatches[0]!.detail).toContain("cogs_base");
    await withTenant(db.rw, s.tenant, s.human, (tx) => rebuildItemProfitability(tx, { companyId: s.company }));
  });
});

describe("acceptance test 7 — the revenue half of one costing answer (spec:2425)", () => {
  it("TIE-OUT A: Σ revenue_base equals the item's revenue-account balance to the cent", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await itemProfitabilityRows(tx, { companyId: s.company });
      const projection = rows.reduce((sum, r) => sum.add(Money.of(r.revenueBase, MYR)), Money.zero(MYR));
      const [ledger] = await tx<{ signed: string }[]>`
        select coalesce(sum(b.base_credit) - sum(b.base_debit), 0)::text as signed
          from app.account_balance b
          join app.item i on i.revenue_account_id = b.account_id
         where b.company_id = ${s.company} and i.id = ${itemId}`;
      expect(projection.toString()).toBe(Money.of(ledger!.signed, MYR).toString());
    });
  });

  it("TIE-OUT B: Σ cogs_base equals 3D's salesByItem cost — the identical cost_consumption source", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await itemProfitabilityRows(tx, { companyId: s.company });
      const projection = rows.reduce((sum, r) => sum.add(Money.of(r.cogsBase, MYR)), Money.zero(MYR));
      const report = await salesByItem(tx, {
        companyId: s.company, fromDate: "2026-01-01", toDate: "2026-12-31", limit: 50 });
      const reported = report.reduce((sum: Money, r: { cost: string }) =>
        sum.add(Money.of(r.cost, MYR)), Money.zero(MYR));
      expect(projection.toString()).toBe(reported.toString());
    });
  });

  it("TIE-OUT C: margin_base is revenue_base − cogs_base on every row, never recomputed by a reader", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      itemProfitabilityRows(tx, { companyId: s.company }));
    for (const r of rows) {
      expect(r.marginBase).toBe(
        Money.of(r.revenueBase, MYR).subtract(Money.of(r.cogsBase, MYR)).toString());
    }
  });
});

describe("step 14 — postDocument enqueues accounting.projection.rebuild (amendment 2)", () => {
  it("a party document enqueues once per company, collapsed by singletonKey", async () => {
    const jobs = recordingJobs();
    await postFromPack(db, s, {
      code: "SALES_INVOICE", effectiveDate: "2026-02-02", partyId: f.partyIds.customer, jobs,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, credit: "10.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, debit:  "10.0000" }],
    });
    const enqueued = jobs.enqueued.filter((j) => j.name === "accounting.projection.rebuild");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.opts?.singletonKey).toBe(s.company);
    expect(enqueued[0]!.job.payload).toMatchObject({ companyId: s.company });
  });

  it("without a JobClient it WARNS and posts — it never throws (amendment 2 is not 3B's fail-closed branch)", async () => {
    const { result } = await postFromPack(db, s, {
      code: "SALES_INVOICE", effectiveDate: "2026-02-03", partyId: f.partyIds.customer,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, credit: "11.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, debit:  "11.0000" }],
    });
    expect(result.warnings.some((w) => w.includes("accounting.projection.rebuild"))).toBe(true);
    expect(result.ledgerEntryIds).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- ar-ap/item-profitability
```

Expected:

```
FAIL  test/ar-ap/item-profitability.test.ts [ test/ar-ap/item-profitability.test.ts ]
SyntaxError: The requested module '../../src' does not provide an export named 'ITEM_PROFITABILITY_CHECK'
```

and, once the module exists but before Step 5, `projectionChecks()` still reads `["account_balance", "cost_layer", "document_series", "stock_on_hand"]`.

- [ ] **Step 3: Write `packages/db/src/projections/item-profitability.ts`**

```ts
// packages/db/src/projections/item-profitability.ts
//
// Slice 4B. The third asynchronous projection of spec:1204. It is 4B's and not 3B's because REVENUE
// does not exist before 4A: 3D shipped inventory.sales_by_item on delivered quantity and cost, 4A
// extended that same code with revenue and margin, and 7B re-expresses the code over this table.
//
// Every figure comes out of app.item_profitability_rows (migration 0048). This module selects, MERGEs
// and compares; it contains no attribution arithmetic of its own (ADR 0046).
import type { Sql } from "postgres";
import type { ProjectionCheck, ProjectionMismatch } from "../integrity/types";

/**
 * Document types whose movements are SALES movements. MEMBERSHIP ONLY — it carries no sign (amendment 6).
 * The direction of revenue is read from the ledger per document and the direction of quantity and cost
 * from the movement's own sign, because a reversal-produced SALES_CREDIT_NOTE carries negated line
 * amounts (§4.4.2 A9) and a hand-drafted one does not: a type → sign map would be right for one of them
 * and wrong for the other.
 *
 * **6A appends "POS_TICKET" in the PR that seeds that type.** The exhaustiveness test below is what makes
 * that an obligation rather than a hope.
 */
export const SALE_MOVEMENT_TYPES: readonly string[] = [
  "DELIVERY_ORDER",       // 3D — stock out before the invoice; posts to 1250, never to a revenue account
  "SALES_INVOICE",        // 4A — revenue; carries a movement only when it is NOT linked to a delivery
  "SALES_CREDIT_NOTE",    // 4A — a return: the movement is a receipt, so quantity and cost both subtract
];

/**
 * Every other type with a stock effect. It exists so the exhaustiveness test can name a type that is in
 * neither list and fail, forcing the slice that added it to classify it. A type is added here when its
 * movements are NOT sales: a purchase, a transfer, a count variance, a write-off, a cut-over opening.
 */
export const NON_SALE_MOVEMENT_TYPES: readonly string[] = [
  "SHIPMENT", "GOODS_RECEIPT", "PURCHASE_RETURN", "PURCHASE_INVOICE", "PURCHASE_CREDIT_NOTE",   // 3C, 4A
  "TRANSFER", "TRANSFER_RECEIPT", "STOCK_COUNT", "EXPIRY_WRITE_OFF",                            // 3D
  "OPENING_STOCK",                                                                              // 9B
];

export interface ItemProfitabilityRow {
  itemId: string; fiscalPeriodId: string;
  quantitySold: string; revenueBase: string; cogsBase: string; marginBase: string;
}

interface RawRow {
  item_id: string; fiscal_period_id: string; quantity_sold: string;
  revenue_base: string; cogs_base: string; margin_base: string;
}

export async function itemProfitabilityRows(
  tx: Sql, params: { companyId: string },
): Promise<ItemProfitabilityRow[]> {
  const rows = await tx<RawRow[]>`
    select item_id, fiscal_period_id, quantity_sold::text,
           revenue_base::text, cogs_base::text, margin_base::text
      from app.item_profitability_rows(${params.companyId}, ${SALE_MOVEMENT_TYPES}::text[])
     order by item_id, fiscal_period_id`;
  return rows.map((r) => ({
    itemId: r.item_id, fiscalPeriodId: r.fiscal_period_id, quantitySold: r.quantity_sold,
    revenueBase: r.revenue_base, cogsBase: r.cogs_base, marginBase: r.margin_base,
  }));
}

/** MERGE, then zero the stale keys of this company. Never DELETE (§3.5.4 is pinned — ADR 0046). */
export async function rebuildItemProfitability(
  tx: Sql, params: { companyId: string },
): Promise<{ merged: number; zeroed: number }> {
  const merged = await tx`
    merge into app.item_profitability t
    using (select app.current_tenant() as tenant_id, ${params.companyId}::uuid as company_id,
                  r.item_id, r.fiscal_period_id, r.quantity_sold, r.revenue_base, r.cogs_base, r.margin_base
             from app.item_profitability_rows(${params.companyId}, ${SALE_MOVEMENT_TYPES}::text[]) r) s
       on t.company_id = s.company_id and t.item_id = s.item_id
      and t.fiscal_period_id = s.fiscal_period_id
     when matched then update
          set quantity_sold = s.quantity_sold, revenue_base = s.revenue_base,
              cogs_base = s.cogs_base, margin_base = s.margin_base, updated_at = now()
     when not matched then insert
          (tenant_id, company_id, item_id, fiscal_period_id, quantity_sold, revenue_base, cogs_base, margin_base)
          values (s.tenant_id, s.company_id, s.item_id, s.fiscal_period_id,
                  s.quantity_sold, s.revenue_base, s.cogs_base, s.margin_base)`;

  const zeroed = await tx`
    update app.item_profitability t
       set quantity_sold = 0, revenue_base = 0, cogs_base = 0, margin_base = 0, updated_at = now()
     where t.company_id = ${params.companyId}
       and (t.quantity_sold <> 0 or t.revenue_base <> 0 or t.cogs_base <> 0 or t.margin_base <> 0)
       and not exists (
         select 1 from app.item_profitability_rows(${params.companyId}, ${SALE_MOVEMENT_TYPES}::text[]) r
          where r.item_id = t.item_id and r.fiscal_period_id = t.fiscal_period_id)`;

  return { merged: merged.count, zeroed: zeroed.count };
}

/**
 * Every company RLS lets the caller see, so this fits `ProjectionCheck.run(tx)`'s one-argument shape
 * (§4.16.3). 1B's nightly accounting.ledger.integrity_check is the caller.
 */
export async function compareItemProfitability(tx: Sql): Promise<ProjectionMismatch[]> {
  const companies = await tx<{ id: string }[]>`select id from app.company order by id`;
  const mismatches: ProjectionMismatch[] = [];

  for (const { id: companyId } of companies) {
    const rows = await tx<{
      item_id: string; fiscal_period_id: string;
      s_qty: string | null; s_rev: string | null; s_cogs: string | null; s_margin: string | null;
      f_qty: string | null; f_rev: string | null; f_cogs: string | null; f_margin: string | null;
    }[]>`
      with stored as (
        select item_id, fiscal_period_id, quantity_sold, revenue_base, cogs_base, margin_base
          from app.item_profitability
         where company_id = ${companyId}
           and (quantity_sold <> 0 or revenue_base <> 0 or cogs_base <> 0 or margin_base <> 0)
      ),
      fresh as (
        select item_id, fiscal_period_id, quantity_sold, revenue_base, cogs_base, margin_base
          from app.item_profitability_rows(${companyId}, ${SALE_MOVEMENT_TYPES}::text[])
      )
      select coalesce(s.item_id, f.item_id)                     as item_id,
             coalesce(s.fiscal_period_id, f.fiscal_period_id)   as fiscal_period_id,
             s.quantity_sold::text as s_qty, s.revenue_base::text as s_rev,
             s.cogs_base::text     as s_cogs, s.margin_base::text as s_margin,
             f.quantity_sold::text as f_qty, f.revenue_base::text as f_rev,
             f.cogs_base::text     as f_cogs, f.margin_base::text as f_margin
        from stored s
        full outer join fresh f
          on f.item_id = s.item_id and f.fiscal_period_id = s.fiscal_period_id
       where s.item_id is null or f.item_id is null
          or s.quantity_sold <> f.quantity_sold or s.revenue_base <> f.revenue_base
          or s.cogs_base     <> f.cogs_base     or s.margin_base  <> f.margin_base
       order by 1, 2`;

    for (const r of rows) {
      const key = { company_id: companyId, item_id: r.item_id, fiscal_period_id: r.fiscal_period_id };
      if (r.s_qty === null) {
        mismatches.push({ projection: "item_profitability", key, side: "missing_in_projection",
          detail: `fresh quantity_sold ${r.f_qty}, revenue_base ${r.f_rev}, cogs_base ${r.f_cogs}, no stored row` });
        continue;
      }
      if (r.f_qty === null) {
        mismatches.push({ projection: "item_profitability", key, side: "missing_in_rebuild",
          detail: `stored quantity_sold ${r.s_qty}, revenue_base ${r.s_rev}, cogs_base ${r.s_cogs}, no fresh row` });
        continue;
      }
      const parts: string[] = [];
      if (r.s_qty !== r.f_qty) parts.push(`quantity_sold ${r.s_qty} <> ${r.f_qty}`);
      if (r.s_rev !== r.f_rev) parts.push(`revenue_base ${r.s_rev} <> ${r.f_rev}`);
      if (r.s_cogs !== r.f_cogs) parts.push(`cogs_base ${r.s_cogs} <> ${r.f_cogs}`);
      if (r.s_margin !== r.f_margin) parts.push(`margin_base ${r.s_margin} <> ${r.f_margin}`);
      mismatches.push({ projection: "item_profitability", key, side: "amount_differs", detail: parts.join("; ") });
    }
  }
  return mismatches;
}

/** The ProjectionCheck this slice contributes to 1B's registry; registered in ../integrity/index.ts. */
export const ITEM_PROFITABILITY_CHECK: ProjectionCheck = {
  name: "item_profitability",
  run: compareItemProfitability,
};
```

`packages/db/src/projections/index.ts`:

```ts
// packages/db/src/projections/index.ts — the home of a projection that belongs to no single module.
// party_ageing lives under ar-ap/ because §4.8.2 places ageing in the AR/AP interface family;
// item_profitability is not an AR/AP concept at all — §4.6.1 registers it beside stock_valuation and it
// reads inventory_movement, cost_consumption and cost_layer — so it lives here (amendment 6).
export {
  ITEM_PROFITABILITY_CHECK, NON_SALE_MOVEMENT_TYPES, SALE_MOVEMENT_TYPES,
  compareItemProfitability, itemProfitabilityRows, rebuildItemProfitability,
  type ItemProfitabilityRow,
} from "./item-profitability";
```

`packages/db/src/index.ts` gains one line: `export * from "./projections";`.

- [ ] **Step 4: Register the check in 1B's registry, and move the three pinned arrays**

`packages/db/src/integrity/index.ts` — one import and one call appended, in the shape 1B, 3A, 3B and 8C all use:

```ts
import { ITEM_PROFITABILITY_CHECK } from "../projections/item-profitability";

// (1B's existing imports and its ACCOUNT_BALANCE_CHECK / STOCK_ON_HAND_CHECK / SERIES_GAP_CHECK /
//  COST_LAYER_CHECK registrations stay exactly as they are; this task appends the import above and the
//  single call below, in the shape 1B, 3A, 3B and 8C all use. Nothing else in the file changes.)
registerProjectionCheck(ITEM_PROFITABILITY_CHECK);   // 4B — current state keyed on (company, item, period), ADR 0046
```

Then the **three** pinned assertions, all in this PR (2B set the precedent for `document_series`, 3B for `cost_layer`):

| File | Owner | Change |
|---|---|---|
| `tests/invariants/projection-rebuild.test.ts` | 1B | the expected array becomes `["account_balance", "cost_layer", "document_series", "item_profitability", "stock_on_hand"]` |
| `tests/invariants/audit-chain.test.ts` | 1B | the same array |
| `apps/worker/test/handlers/integrity-check.test.ts` | 1B | the same array |

Nothing else in those three files changes. **If a fourth site turns up, add it here and say so in the Self-Review** — a `grep -rn '"document_series"' tests apps packages` is the check.

- [ ] **Step 5: Add step 14's enqueue to `packages/db/src/posting/post.ts` (amendment 2)**

3B opened this seam (`input.jobs?: JobClient`, amendment A5) and put its own back-dated `inventory.cost.replay` branch at step 14. This adds the second branch **after** 3B's, before the return:

```ts
  // Step 14 (§4.3.2), the accounting.projection.rebuild half (4B, amendment 2). A document with a party
  // changes an ageing bucket; a document with movements changes item_profitability. `singletonKey`
  // collapses a burst of posts into one job and `startAfterSeconds` lets a batch settle first, so the
  // cost of enqueueing on every such post is one job per company per minute.
  const touchesProjections = snapshot.header.partyId !== null || plan.movements.length > 0;
  if (touchesProjections) {
    if (input.jobs) {
      await input.jobs.enqueue(tx, "accounting.projection.rebuild", {
        tenantId: ctx.tenantId, requestId: ctx.requestId,
        payload: { companyId: snapshot.header.companyId, asOf: snapshot.header.effectiveDate },
      }, { singletonKey: snapshot.header.companyId, startAfterSeconds: 60 });
      enqueuedJobIds.push(`accounting.projection.rebuild:${snapshot.header.companyId}`);
    } else {
      // Deliberately a WARNING and not a throw — the opposite of 3B's back-dated branch above, and the
      // difference is the severity of the omission. A missed cost replay leaves a WRONG number in the
      // ledger for ever (SAH-005). A missed projection enqueue leaves a STALE as-of snapshot that the
      // nightly accounting.projection.rebuild recomputes and the nightly compare would flag. Throwing
      // here would break every 4A call site that supplies no JobClient (amendment 2).
      warnings.push(
        `accounting.projection.rebuild was not enqueued for company ${snapshot.header.companyId}: ` +
        `this document was posted through a caller that supplied no JobClient; the nightly job will rebuild`,
      );
    }
  }
```

`PostResult.warnings` is the array §4.3.1 already declares and §4.3.2 step 6 already pushes evaluator warnings onto; this appends to the same array. **No signature changes.**

- [ ] **Step 6: Add the second rebuild call to the worker handler**

`apps/worker/src/handlers/accounting-projection-rebuild.ts` — inside the per-company `withTenant`, after `rebuildPartyAgeing`:

```ts
        const profit = await rebuildItemProfitability(tx, { companyId });
        log().info({ job: NAME, company_id: companyId, merged: profit.merged, zeroed: profit.zeroed },
                   "item_profitability rebuilt");
```

and `"item_profitability"` is **not** added to the report's `projections.checked` array here: its comparison is 1B's, through `projectionChecks` (ADR 0046). The handler rebuilds it and 1B's nightly job is what compares it — that division is the whole point of the registry.

- [ ] **Step 7: Run to green**

```bash
bun run --cwd packages/db test -- ar-ap/item-profitability
bun run --cwd tests test -- invariants/projection-rebuild invariants/audit-chain
bun run --cwd apps/worker test
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
```

`lint:rules` matters here for one reason: `posting-only-tables` must **not** fire on `packages/db/src/projections/item-profitability.ts`. §3.7.5 excludes the three async projections from that rule's table list by name, so a `merge into app.item_profitability` outside `posting/` and `costing/` is legal — and if it fires, the rule's table list has drifted from §3.7.5 and that is the finding, not this file.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/projections/ packages/db/src/integrity/index.ts packages/db/src/index.ts \
        packages/db/src/posting/post.ts apps/worker/src/handlers/accounting-projection-rebuild.ts \
        tests/invariants/projection-rebuild.test.ts tests/invariants/audit-chain.test.ts \
        apps/worker/test/handlers/integrity-check.test.ts \
        packages/db/test/ar-ap/item-profitability.test.ts
git commit -m "feat(db): item_profitability, its registry membership and step 14's enqueue [4B T4]

The third projection of spec:1204, owned here because revenue does not exist before 4A.
Attribution is ledger-anchored: doc_sign comes from the document's own rows on its items'
revenue accounts, never from a type → sign map, because a reversal-produced credit note carries
negated line amounts and a hand-drafted one does not. COGS comes from cost_consumption and
cost_layer — 3D's source, for 3D's reason: only those are rewritten by inventory.cost.replay.

item_profitability joins projectionChecks (current state, keyed on a period), so
IntegrityReport.projections.checked becomes ["account_balance", "cost_layer", "document_series",
"item_profitability", "stock_on_hand"] and the three pinned assertions move in this PR.

Step 14 warns and skips without a JobClient rather than throwing: a stale as-of snapshot that
the nightly job rebuilds is not SAH-005, and throwing would break 4A's call sites.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `FX_REVALUATION` — the realised settlement difference, the unrealised period-end revaluation, its reversal, and acceptance test 8

**Files:**
- Create: `packages/db/seed/my/document-types/FX_REVALUATION.json`, `packages/db/src/ar-ap/fx.ts`, `packages/contracts/src/accounting/fx.ts`, `docs/adr/0047-realised-and-unrealised-fx-in-one-document-type.md`
- Create: `packages/db/test/ar-ap/fx.test.ts`, `tests/invariants/test-08-multi-currency.test.ts`, `apps/api/test/routes/accounting/revaluation.test.ts`
- Modify: `packages/db/src/posting/errors.ts` (**one line** — `PostingErrorCode` gains `"ERR_RATE_NOT_FOUND"`, Task 0 amendment 11), `packages/db/src/ar-ap/index.ts`, `apps/api/src/routes/accounting/documents.ts` (one `POST` sub-path **and** one call-site change inside 4A's allocation handler — the file Task 0's gate named), `tests/regression/sah-012.test.ts`, `sah-014.test.ts`, `sah-019.test.ts` (append a `— 4B` block to each)

**Why one document type and not two.** §4.14 registers **one** row for 4B — `FX_REVALUATION`, series `FXR` — and §2.5's card says "FX difference on settlement **and** period-end revaluation as an `FX_REVALUATION` document". They are distinguished by `document_line.custom_fields.fxKind` (amendment 5) because `app.document` has no `custom_fields` column and §4.4.1 A6's header custom fields need a `custom_field_definition` per company that a job cannot create.

**The one-line widening of `PostingErrorCode`, and why it belongs here.** `revalueAtPeriodEnd` raises `ERR_RATE_NOT_FOUND` when `app.rate_for` returns no row for an exposed currency (SAH-012/SAH-014: never assume 1, never reuse the previous row's rate). It must raise it as a **`PostingError`**, because `packages/db` may not import `@dulja/contracts` and therefore cannot construct `AppError` (§3.1, restated by 1A at phase-1a:2197-2200) — and 1A's union has nine members, not ten (phase-1a:2204-2213). So **Task 0 amendment 11** widens §4.2.4's declaration and this task makes the matching one-line edit:

```ts
// packages/db/src/posting/errors.ts — the tenth member. §4.3.8 (contracts:2294) has listed
// ERR_RATE_NOT_FOUND among the posting service's errors since the registry was written, and 0D put the
// row in ERRORS (contracts:1542), so PostingErrorCode stays a literal subset of ErrCode and
// apps/api/src/problem.ts's `new AppError(e.code, e.detail)` branch still type-checks with NO cast
// (phase-1a:2455). 1A declared nine because Phase 1 had no rate lookup inside packages/db; 4B is the
// first slice that does.
export type PostingErrorCode =
  | "ERR_NOT_FOUND"
  | "ERR_DOC_STATUS_ILLEGAL"
  | "ERR_DOC_NO_LINES"
  | "ERR_POLICY_NOT_FOUND"
  | "ERR_POLICY_INVALID"
  | "ERR_POLICY_REQUIRES_MISSING"
  | "ERR_PERIOD_NOT_FOUND"
  | "ERR_PERIOD_NOT_OPEN"
  | "ERR_LEDGER_UNBALANCED"
  | "ERR_RATE_NOT_FOUND";     // 4B, Task 0 amendment 11 — the only change to this file
```

`errors.ts` gains nothing else: no new class, no cast, and `ERRORS` is untouched because the row has been there since 0D. **If `bun run typecheck` reports `ERR_RATE_NOT_FOUND` is not assignable to `ErrCode`, `ERRORS` lost the 0D row** — that is a 0D regression, not a reason to cast.

**Why the settlement difference cannot be posted by the settlement's own policy.** §4.8.1's comment says "FX_REVALUATION / gain-loss lines are posted by the settlement's policy", and that reading is **not expressible in the frozen schema**: §4.4.1's `amountRef` union has thirteen members and none of them is an allocation's FX difference. A `RECEIPT` policy has no way to address it. A separate document through the posting service is therefore the only shape the frozen `posting-policy.schema.json` admits, and it is also the honest one — the difference arises at *allocation* time, not at posting time, and one receipt allocated across three invoices at three rates produces three differences.

**Interfaces**

- Consumes: `app.allocation` and 4A's `allocateSettlement` / `AllocationLine` (§4.8.1); `app.party`, `app.account`, `app.account_balance`, `app.ledger_entry`, `app.fiscal_period`, `app.document`, `app.document_line` (plan0A, 1A, 2A); `app.rate_for`, `app.exchange_rate` (0D, §4.2.10); `postDocument`, `reverseDocument`, `PostResult`, `PostingError` (1A, §4.3.1); `ageingRows`, `ageingTieOut`, `outstandingRevaluation` (Task 3); `Money`, `currency`, `CurrencyCode`, `round`, `toBase`, `UNIT_RATE`, `ExchangeRate`, `MONEY_SCALE` and **`D`** (§4.2.1 — `D` is 0D's cloned precision-40 constructor, `export { D } from "./money/decimal";` at 0d:443 and still in the completed barrel at 0d:1126; `fx.ts` builds every intermediate with it because nothing under `packages/db/src` may import `decimal.js`); the production `withTenant`, `TenantContext` (§4.2.2); `JobClient` (§4.2.6); `AppError`, `ERRORS` (§4.2.4); `requirePermission`, `PERMISSION` (§4.2.5); `IdempotencyHeader`, `documentRoutes` (1A, §4.2.7); `loadDocumentTypes`, `documentTypesLoader`, `readPackFile` (1A, 0C); `validateDocumentTypeSeed`, `validatePolicy` (2A); `pdfText` is **not** used (no template ships here).
- Produces:
  ```ts
  // packages/db/src/ar-ap/fx.ts
  export const FX_REVALUATION_CODE = "FX_REVALUATION" as const;      // §4.14
  /** The three §4.15 codes this slice RESOLVES and 0C seeds. Never re-seeded here (hazard 33). */
  export const FX_ACCOUNT_CODES = { gain: "4900", loss: "5910", rounding: "5920" } as const;

  export interface FxAccounts { gainAccountId: string; lossAccountId: string; roundingAccountId: string }
  /** Resolves the three by code for one company; ERR_POLICY_REQUIRES_MISSING naming the missing code. */
  export async function resolveFxAccounts(tx: Sql, companyId: string): Promise<FxAccounts>;

  /**
   * Posts the REALISED difference of one allocation as an FX_REVALUATION document, or returns null when
   * `allocation.fx_difference` is zero or an FX document already exists for that settlement.
   * It reads the STORED `fx_difference` and never recomputes it (4A owns that arithmetic).
   */
  export async function postSettlementFxDifference(
    tx: Sql, ctx: TenantContext,
    input: { settlementDocumentId: string; jobs?: JobClient },
  ): Promise<{ fxDocumentId: string; difference: Money } | null>;

  /** `allocateSettlement` followed by `postSettlementFxDifference`, in the caller's ONE transaction. */
  export async function settleWithFx(
    tx: Sql, ctx: TenantContext,
    input: { settlementDocumentId: string; lines: readonly AllocationLine[]; jobs?: JobClient },
  ): Promise<{ allocationIds: string[]; fxDifference: Money; fxDocumentId: string | null }>;

  export interface RevaluationResult {
    documentId: string | null;                   // null when nothing needed revaluing
    fiscalPeriodId: string;
    asOf: string;
    lines: readonly {
      accountId: string; accountCode: string; currency: string;
      amountCcy: string; carriedBase: string; revaluedBase: string; delta: string; rate: string;
    }[];
  }
  /** One UNREALISED FX_REVALUATION per company per period, dated the period's `ends_on`. */
  export async function revalueAtPeriodEnd(
    tx: Sql, ctx: TenantContext,
    input: { companyId: string; fiscalPeriodId: string; jobs?: JobClient },
  ): Promise<RevaluationResult>;

  /** Reverses one unrealised revaluation on the first day of the following period (D13, §4.14's row). */
  export async function reverseRevaluation(
    tx: Sql, ctx: TenantContext,
    input: { documentId: string; effectiveDate: string; jobs?: JobClient },
  ): Promise<{ reversalDocumentId: string; number: bigint }>;
  ```

- [ ] **Step 1: Assert the three FX accounts resolve — the card's "first FX task asserts the three resolve"**

This is hazard 33's obligation, and it is a *step*, not a comment. Add it to `packages/db/test/ar-ap/fx.test.ts` as the first `it`, and to `resolveFxAccounts` as a fail-closed lookup.

**These two cases prove `resolveFxAccounts`, not the pack.** They run against a Testcontainers company whose accounts `arApFixture` created, so on their own they could not detect 0C dropping `4900` or `5910` from `0c-base.json` — which is the single failure hazard 33 exists to prevent. **That assertion lives in Task 2 Step 5**, which reads `packages/db/seed/my/chart-of-accounts/0c-base.json` through 0C's `readPackFile` and fails when a row goes missing. Do not copy it here: one reader of the pack, in the task that owns the account list (hazard 9).

```ts
  it("4900, 5910 and 5920 all resolve for the seeded company, and this slice seeds none of them", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const accounts = await resolveFxAccounts(tx, s.company);
      expect(accounts.gainAccountId).toBe(f.accountIds["4900"]);
      expect(accounts.lossAccountId).toBe(f.accountIds["5910"]);
      const [rounding] = await tx<{ code: string }[]>`
        select code from app.account where id = ${accounts.roundingAccountId}`;
      expect(rounding!.code).toBe("5920");
    });
    // company.fx_rounding_account_id is 0C's wiring (spec:2001) and 1A's seedTenantV2 sets it; this slice
    // reads it and never writes it.
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../../seed/my/chart-of-accounts/", import.meta.url));
    expect(existsSync(`${dir}4b-fx.json`)).toBe(false);
  });

  it("a company missing 4900 raises ERR_POLICY_REQUIRES_MISSING naming the code, never a null account", async () => {
    const bare = await seedTenantV2(db, "fx-bare");
    await withTenant(db.rw, bare.tenant, bare.human, async (tx) => {
      await expect(resolveFxAccounts(tx, bare.company)).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING.*4900/);
    });
  });
```

- [ ] **Step 2: Write ADR 0047 as a proposal, and ask**

`docs/adr/0047-realised-and-unrealised-fx-in-one-document-type.md`:

```markdown
# 0047 — Realised and unrealised FX in one document type

- Status: **proposed** (spec:95 — money semantics; do not merge the implementation before this is accepted)
- Date: 2026-09-05
- Slice: 4B

## Context

§3.0.4 row 1045 requires "rates with source, base = value × rate, FX difference on settlement,
revaluation", and acceptance test 8 requires all four in one scenario. §4.14 registers exactly one
document-type code for 4B, `FX_REVALUATION`, and §4.15 registers the pair `4900` / `5910` plus the
rounding account `5920` — all three seeded by 0C, none by this slice.

Four things had no registered answer.

1. **Who posts the settlement difference?** §4.8.1's comment says "the settlement's policy" does.
2. **How are realised and unrealised told apart when they share a code?**
3. **What gets revalued at period end, and against what?**
4. **How does the ageing tie-out survive a cross-currency month?**

## Decision

**A separate document, because the settlement's policy cannot express it.** §4.4.1's `amountRef` union has
thirteen members and none of them is an allocation's FX difference, so a `RECEIPT` policy has no way to
address the figure. The difference also arises at *allocation* time rather than at posting time — one
receipt allocated across three invoices at three rates produces three differences — so a document per
settlement, drafted after `allocateSettlement` and posted in the same transaction, is both the only
expressible shape and the honest one.

**One code, distinguished by `document_line.custom_fields.fxKind ∈ realised | unrealised`.**
`app.document` has no `custom_fields` column, and §4.4.1 A6's `when["document.kind"]` reads *header*
custom fields — `app.custom_field_value` rows needing a `custom_field_definition` per company, which a
job cannot create. The line bag needs neither and is copied by `reverseDocument` along with the rest of
the line. Only the **unrealised** document is reversed at period start; a realised difference is undone by
reversing the settlement, never on its own.

**Neither FX document carries a `party_id`, and that is load-bearing.** `app.party_ageing_rows` treats
every posted document with a `party_id` as an open item; an FX document with one would appear as an open
receivable of exactly the FX amount and would break the tie-out by exactly that figure. The party is
recorded on the lines' `custom_fields.partyId` instead, where a report can read it and the ageing cannot.

**What is revalued.** Party control accounts are revalued from the **open items** (`ageingRows` at the
period's `ends_on`), not from `account_balance`'s per-currency rows: in a cross-currency month those rows
are not an open-item view (ADR 0046), and revaluing them would restate a receivable that allocation has
already settled. Every other monetary account — `type ∈ asset | liability`, `is_group = false`, carrying a
non-base-currency balance, and not a party control — is revalued from `account_balance`. Inventory,
revenue and expense accounts are not revalued: inventory is always carried in base (`inventory_movement.value`
is a base figure), and a non-monetary balance has no exposure.

**One direction rule, in debit-positive terms, for both the realised and the unrealised case.** Work in
`debit − credit`; a positive `delta` debits the subject account and the other leg is a credit, a negative
`delta` credits it and the other leg is a debit; and then

    resultAccount = resultSide === "credit" ? 4900 : 5910

with no reference to the party's kind or the account's type. A credit to the result account is income and
a debit is expense, which is the whole of the rule. **`Money` magnitudes are non-negative on both lines**
and the direction lives in `document_line.debit` / `credit`, so §4.4.2 A9 is satisfied by construction:
no planned amount's sign is ever read to choose a side.

**The ageing tie-out is self-consistent for any value of `fx_difference`, and that is the point.**
`app.party_ageing_rows` counts a settlement's consumption as `base_amount + fx_difference`, and the
realised document posts exactly `fx_difference` to the control account. Writing out one settlement:

| | ageing base | control-account ledger base |
|---|---|---|
| invoice | `charged − base_amount` | `charged` |
| settlement | `−settlementLeg + base_amount + fx` | `−settlementLeg` |
| FX document | (absent — no `party_id`) | `+fx` |
| **Σ** | `charged − settlementLeg + fx` | `charged − settlementLeg + fx` |

The two columns are equal **whatever `fx` is**. 4B therefore reads the stored `allocation.fx_difference`
and never recomputes it: 4A owns that arithmetic, and a disagreement about its *value* shows up as a
wrong FX gain in a report, never as a broken definition of done. The unrealised term is the one remaining
difference, and `ageingTieOut` states it as its own column.

## Consequences

- 4B **edits 4A's allocation handler** to call `settleWithFx` instead of `allocateSettlement`. Posting the
  difference in a later, separate call would leave the tie-out false between the two calls, which is a
  state a reader of the ageing report could observe.
- `FX_REVALUATION` declares `reversal.allowed: true, producesType: "FX_REVALUATION"`, so D13's machinery
  reverses a revaluation with no new code.
- A revaluation's reversal lands in the **next** period, which must be open. A company that closes a
  period before reversing must reopen it under `accounting.period.reopen` with a reason — which is the
  correct workflow and is why `revalueAtPeriodEnd` does not close the period itself.
- No account code is added by this slice. If a future slice wants unrealised FX on its own balance-sheet
  line rather than on the control account, that is a new §4.15 row and an amendment, not a plan decision.
```

Ask before implementing (spec:95).

- [ ] **Step 3: Write the seed envelope**

`packages/db/seed/my/document-types/FX_REVALUATION.json` — the §4.3.7 envelope, JOURNAL-shaped, with **no `account: { code }` literal anywhere** (the drafting service resolves accounts and writes `document_line.account_id`, so the policy addresses `line.account`; hazard 33 is discharged by Step 1's assertion, not by a policy literal):

```json
{
  "code": "FX_REVALUATION",
  "nameEn": "Foreign-exchange revaluation",
  "nameAr": "إعادة تقييم العملات الأجنبية",
  "module": "accounting",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "FX_REVALUATION",
    "direction": "internal",
    "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "FXR", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "FX_REVALUATION" },
    "approval": { "required": false, "approve": null, "post": "accounting.journal.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

**Three notes a reviewer should check against the registers.** `module: "accounting"` is §4.14's value and it sits **outside** `policy` because `posting-policy.schema.json` is `additionalProperties: false` (hazard 34). `approval.post` is `accounting.journal.post`, which is §3.6.2's sentence for this type verbatim ("the FX-revaluation and cost-adjustment documents post under `accounting.journal.post` (system principal for the job path)"), so **this slice adds nothing to `DOCUMENT_STAGE_CODES`** — the code is already in the `documents` module's list from 1A. `dimensions.required` is empty: a revaluation is a company-level entry, and the evaluator tags `BRANCH` from `document.branch_id` on every line regardless (§4.3.2 step 10).

- [ ] **Step 4: Write the failing test**

`packages/db/test/ar-ap/fx.test.ts` carries Step 1's two cases plus the unit behaviour of each function; `tests/invariants/test-08-multi-currency.test.ts` carries the acceptance test. The unit file:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  ageingTieOut, outstandingRevaluation, postSettlementFxDifference, resolveFxAccounts,
  revalueAtPeriodEnd, reverseRevaluation, settleWithFx, withTenant as prodWithTenant,
} from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedCurrency, seedRate, seedTenantV2, type Seed } from "../fixtures";
import { arApFixture, postFromPack, seedTypeFromPack, type ArApFixture } from "../../../../tests/invariants/support/ar-ap";

const MYR = currency("MYR");
const EUR = currency("EUR");
let db: Db;
let s: Seed;
let f: ArApFixture;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "fx");
  f = await arApFixture(db, s);
  await seedTypeFromPack(db, s, "FX_REVALUATION");
  for (const code of ["EUR", "USD"]) await seedCurrency(db, s, { code });
  // Four rates, all invented figures with source 'manual:test' (hazard 18 — no real rate anywhere).
  await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-01-01", rate: "5.00000000", source: "manual:test" });
  await seedRate(db, s, { from: "USD", to: "MYR", on: "2026-01-20", rate: "4.00000000", source: "manual:test" });
  await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-01-20", rate: "5.20000000", source: "manual:test" });
  await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-01-31", rate: "5.50000000", source: "manual:test" });
  await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-02-01", rate: "5.10000000", source: "manual:test" });
}, 300_000);
afterAll(async () => { await db?.stop(); });

describe("resolveFxAccounts (hazard 33)", () => {
  /* Step 1's two cases go here, verbatim. */
});

describe("postSettlementFxDifference — the realised half (ADR 0047)", () => {
  let invoiceId: string;

  it("a zero fx_difference posts nothing and returns null", async () => {
    ({ documentId: invoiceId } = await postFromPack(db, s, {
      code: "SALES_INVOICE", effectiveDate: "2026-01-05", partyId: f.partyIds.customer,
      currency: "EUR", exchangeRate: "5.00000000", rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, credit: "1000.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, debit:  "1000.0000" }],
    }));
    const receipt = await postFromPack(db, s, {
      code: "RECEIPT", effectiveDate: "2026-01-06", partyId: f.partyIds.customer,
      currency: "EUR", exchangeRate: "5.00000000", rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, debit:  "100.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, credit: "100.0000" }],
      allocate: [{ settledDocumentId: invoiceId, amount: Money.of("100.0000", EUR) }],
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const posted = await prodWithTenant(db.rw, ctx, (tx) =>
      postSettlementFxDifference(tx, ctx, { settlementDocumentId: receipt.documentId }));
    expect(posted).toBeNull();          // same currency, same rate → nothing realised
  });

  it("a cross-currency settlement posts ONE FX document: the control leg and 4900, both non-negative", async () => {
    const receipt = await postFromPack(db, s, {
      code: "RECEIPT", effectiveDate: "2026-01-20", partyId: f.partyIds.customer,
      currency: "USD", exchangeRate: "4.00000000", rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, debit:  "260.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, credit: "260.0000" }],
      allocate: [{ settledDocumentId: invoiceId, amount: Money.of("200.0000", EUR) }],
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const posted = await prodWithTenant(db.rw, ctx, (tx) =>
      postSettlementFxDifference(tx, ctx, { settlementDocumentId: receipt.documentId }));
    expect(posted).not.toBeNull();

    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [doc] = await tx<{ party_id: string | null; currency: string; exchange_rate: string; series: string }[]>`
        select party_id, currency, exchange_rate::text, series from app.document where id = ${posted!.fxDocumentId}`;
      expect(doc!.party_id).toBeNull();          // ADR 0047: a party_id here would break the tie-out
      expect(doc!.currency).toBe("MYR");         // base currency at rate 1: the lines ARE base amounts
      expect(doc!.exchange_rate).toBe("1.00000000");
      expect(doc!.series).toBe("FXR");           // §4.14's series, written back by issueDocument

      const lines = await tx<{ account_id: string; debit: string; credit: string; custom_fields: Record<string, string> }[]>`
        select account_id, debit::text, credit::text, custom_fields
          from app.document_line where document_id = ${posted!.fxDocumentId} order by line_no`;
      expect(lines).toHaveLength(2);
      for (const l of lines) {
        expect(Number(l.debit) >= 0 && Number(l.credit) >= 0).toBe(true);   // magnitudes only (A9)
        expect(l.custom_fields.fxKind).toBe("realised");
        expect(l.custom_fields.settlementDocumentId).toBe(receipt.documentId);
        expect(l.custom_fields.partyId).toBe(f.partyIds.customer);
      }
      const control = lines.find((l) => l.account_id === f.accountIds["1200"])!;
      const result = lines.find((l) => l.account_id === f.accountIds["4900"])!;
      expect(control.debit).toBe("40.0000");     // settlement base 1040 − settled base 1000
      expect(result.credit).toBe("40.0000");     // a credit to the result account is a GAIN
    });
  });

  it("it is idempotent: a second call for the same settlement posts nothing", async () => {
    const [{ id: settlementId }] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select a.settlement_document_id as id from app.allocation a
       where a.company_id = ${s.company} and a.fx_difference <> 0 limit 1`);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    expect(await prodWithTenant(db.rw, ctx, (tx) =>
      postSettlementFxDifference(tx, ctx, { settlementDocumentId: settlementId }))).toBeNull();
  });

  it("a VENDOR payment whose settlement base exceeds the settled base debits 5910, not 4900", async () => {
    const bill = await postFromPack(db, s, {
      code: "PURCHASE_INVOICE", effectiveDate: "2026-01-06", partyId: f.partyIds.vendor,
      currency: "EUR", exchangeRate: "5.00000000", rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["5900"]!, debit:  "500.0000" },
              { kind: "account", accountId: f.accountIds["2100"]!, credit: "500.0000" }],
    });
    const payment = await postFromPack(db, s, {
      code: "PAYMENT", effectiveDate: "2026-01-20", partyId: f.partyIds.vendor,
      currency: "EUR", exchangeRate: "5.20000000", rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["2100"]!, debit:  "500.0000" },
              { kind: "account", accountId: f.accountIds["1100"]!, credit: "500.0000" }],
      allocate: [{ settledDocumentId: bill.documentId, amount: Money.of("500.0000", EUR) }],
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const posted = await prodWithTenant(db.rw, ctx, (tx) =>
      postSettlementFxDifference(tx, ctx, { settlementDocumentId: payment.documentId }));
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const lines = await tx<{ account_id: string; debit: string; credit: string }[]>`
        select account_id, debit::text, credit::text from app.document_line
         where document_id = ${posted!.fxDocumentId} order by line_no`;
      const control = lines.find((l) => l.account_id === f.accountIds["2100"])!;
      const result = lines.find((l) => l.account_id === f.accountIds["5910"])!;
      expect(control.credit).toBe("100.0000");   // paid 2600 base to settle 2500 → AP over-relieved by 100
      expect(result.debit).toBe("100.0000");     // a debit to the result account is a LOSS
    });
  });
});

describe("revalueAtPeriodEnd and reverseRevaluation — the unrealised half", () => {
  it("revalues the open EUR item at the period-end rate and marks both lines unrealised", async () => {
    const period = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string; ends_on: string }[]>`
      select id, ends_on::text from app.fiscal_period
       where company_id = ${s.company} and starts_on = '2026-01-01'`);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const result = await prodWithTenant(db.rw, ctx, (tx) =>
      revalueAtPeriodEnd(tx, ctx, { companyId: s.company, fiscalPeriodId: period[0]!.id }));
    expect(result.documentId).not.toBeNull();
    expect(result.asOf).toBe("2026-01-31");
    const ar = result.lines.find((l) => l.accountCode === "1200" && l.currency === "EUR")!;
    expect(ar.rate).toBe("5.50000000");
    expect(ar.amountCcy).toBe("800.0000");      // 1000 invoiced − 200 allocated
    expect(ar.carriedBase).toBe("4000.0000");   // at the invoice's OWN rate, 5.0
    expect(ar.revaluedBase).toBe("4400.0000");
    expect(ar.delta).toBe("400.0000");

    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const lines = await tx<{ custom_fields: Record<string, string> }[]>`
        select custom_fields from app.document_line where document_id = ${result.documentId}`;
      for (const l of lines) expect(l.custom_fields.fxKind).toBe("unrealised");
      expect(await outstandingRevaluation(tx, {
        companyId: s.company, accountId: f.accountIds["1200"]!, asOf: "2026-01-31" })).toBe("400.0000");
    });
  });

  it("running it twice for the same period posts nothing the second time", async () => {
    const period = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select id from app.fiscal_period where company_id = ${s.company} and starts_on = '2026-01-01'`);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const again = await prodWithTenant(db.rw, ctx, (tx) =>
      revalueAtPeriodEnd(tx, ctx, { companyId: s.company, fiscalPeriodId: period[0]!.id }));
    expect(again.documentId).toBeNull();
    expect(again.lines).toEqual([]);
  });

  it("the reversal lands on the first day of the next period and nets the outstanding term to zero (§4.14)", async () => {
    const [fx] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select d.id from app.document d
        join app.document_type t on t.id = d.document_type_id
        join app.document_line l on l.document_id = d.id
       where t.code = 'FX_REVALUATION' and d.status = 'posted'
         and l.custom_fields->>'fxKind' = 'unrealised'
       limit 1`);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const { reversalDocumentId } = await prodWithTenant(db.rw, ctx, (tx) =>
      reverseRevaluation(tx, ctx, { documentId: fx!.id, effectiveDate: "2026-02-01" }));
    expect(reversalDocumentId).toBeTruthy();
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [original] = await tx<{ status: string }[]>`select status from app.document where id = ${fx!.id}`;
      expect(original!.status).toBe("reversed");
      expect(await outstandingRevaluation(tx, {
        companyId: s.company, accountId: f.accountIds["1200"]!, asOf: "2026-02-28" })).toBe("0.0000");
    });
  });

  // Immediately AFTER the reversal, and this is the case the guard's status set exists for. The
  // "twice" case above runs while the original is still 'posted', so a `status = 'posted'` guard passes
  // it and fails here: the original is now 'reversed', the guard would count zero, and January would be
  // revalued a second time — 400.0000 restated onto 1200 with nothing to reverse it and
  // ageingTieOut('2026-01-31') non-zero for the rest of the company's life.
  it("re-running it AFTER the reversal still posts nothing (the guard counts 'reversed' too)", async () => {
    const period = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select id from app.fiscal_period where company_id = ${s.company} and starts_on = '2026-01-01'`);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const third = await prodWithTenant(db.rw, ctx, (tx) =>
      revalueAtPeriodEnd(tx, ctx, { companyId: s.company, fiscalPeriodId: period[0]!.id }));
    expect(third.documentId).toBeNull();
    expect(third.lines).toEqual([]);
    // And the January tie-out is still exact, which is the figure that would have moved.
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-01-31" }));
    expect(new Map(rows.map((r) => [r.accountCode, r.difference])).get("1200")).toBe("0.0000");
  });

  it("a period with no foreign-currency exposure produces no document at all", async () => {
    const clean = await seedTenantV2(db, "fx-clean");
    await arApFixture(db, clean);
    const period = await withTenant(db.rw, clean.tenant, clean.human, (tx) => tx<{ id: string }[]>`
      select id from app.fiscal_period where company_id = ${clean.company} and starts_on = '2026-01-01'`);
    const ctx = { tenantId: clean.tenant, actorId: clean.human, requestId: await uuidv7(db.admin) };
    const result = await prodWithTenant(db.rw, ctx, (tx) =>
      revalueAtPeriodEnd(tx, ctx, { companyId: clean.company, fiscalPeriodId: period[0]!.id }));
    expect(result).toMatchObject({ documentId: null, lines: [] });
  });

  it("a missing rate for an exposed currency raises ERR_RATE_NOT_FOUND naming the pair (SAH-012)", async () => {
    // The GBP exposure below has no exchange_rate row at all: the revaluation must refuse, never assume 1.
    const gbp = await seedTenantV2(db, "fx-norate");
    const g = await arApFixture(db, gbp);
    await seedCurrency(db, gbp, { code: "GBP" });
    await seedTypeFromPack(db, gbp, "FX_REVALUATION");
    await postFromPack(db, gbp, {
      code: "SALES_INVOICE", effectiveDate: "2026-01-05", partyId: g.partyIds.customer,
      currency: "GBP", exchangeRate: "6.00000000", rateSource: "manual:test",
      lines: [{ kind: "account", accountId: g.accountIds["4000"]!, credit: "10.0000" },
              { kind: "account", accountId: g.accountIds["1200"]!, debit:  "10.0000" }],
    });
    const period = await withTenant(db.rw, gbp.tenant, gbp.human, (tx) => tx<{ id: string }[]>`
      select id from app.fiscal_period where company_id = ${gbp.company} and starts_on = '2026-01-01'`);
    const ctx = { tenantId: gbp.tenant, actorId: gbp.human, requestId: await uuidv7(db.admin) };
    await expect(prodWithTenant(db.rw, ctx, (tx) =>
      revalueAtPeriodEnd(tx, ctx, { companyId: gbp.company, fiscalPeriodId: period[0]!.id })))
      .rejects.toThrow(/ERR_RATE_NOT_FOUND.*GBP.*MYR/);
  });
});
```

- [ ] **Step 5: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- ar-ap/fx
```

Expected:

```
FAIL  test/ar-ap/fx.test.ts [ test/ar-ap/fx.test.ts ]
SyntaxError: The requested module '../../src' does not provide an export named 'postSettlementFxDifference'
```

- [ ] **Step 6: Write `packages/db/src/ar-ap/fx.ts`**

```ts
// packages/db/src/ar-ap/fx.ts
//
// Slice 4B. FX difference on settlement and at period end, both as FX_REVALUATION documents through 1A's
// frozen postDocument (ADR 0047). Nothing here writes a ledger, movement or projection table: every
// function drafts app.document + app.document_line rows and hands over (hazard 22).
//
// One direction rule for both halves, in DEBIT-POSITIVE terms: a positive delta debits the subject
// account and credits the result account, a negative one does the reverse, and
//     resultAccount = resultSide === "credit" ? 4900 : 5910
// with no reference to the party's kind or the account's type. Both document_line amounts are
// non-negative magnitudes, so §4.4.2 A9 is satisfied by construction.
// NOTHING under packages/db/src imports decimal.js — it is packages/domain's dependency (§4.2.1 D11,
// 0d:212 `bun add --cwd packages/domain decimal.js`) and is not in packages/db/package.json, which is the
// rule 3B fixed for packages/db/src/costing (3b:1124) and 4A restated for packages/db/src/ar-ap
// (phase-4a:35). `D` is 0D's CLONED constructor at precision 40, exported from the domain barrel
// (`export { D } from "./money/decimal";`, 0d:443); the bare decimal.js constructor would compute at the
// library default precision, which 0D's Global Constraint 11 forbids.
import { D, Money, currency, round, type CurrencyCode } from "@dulja/domain";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import type { JobClient } from "../jobs/enqueue";

/** The instance type of 0D's cloned constructor. 0D exports the value `D`, not decimal.js's type. */
type Dec = InstanceType<typeof D>;
import { PostingError } from "../posting/errors";
import { postDocument, reverseDocument } from "../posting";
import { allocateSettlement, type AllocationLine } from "./allocation";
import { ageingRows } from "./ageing";

export const FX_REVALUATION_CODE = "FX_REVALUATION" as const;

/** The three §4.15 codes this slice RESOLVES. All three are 0C's; this slice seeds none (hazard 33). */
export const FX_ACCOUNT_CODES = { gain: "4900", loss: "5910", rounding: "5920" } as const;

export interface FxAccounts { gainAccountId: string; lossAccountId: string; roundingAccountId: string }

export async function resolveFxAccounts(tx: Sql, companyId: string): Promise<FxAccounts> {
  const rows = await tx<{ code: string; id: string }[]>`
    select code, id from app.account
     where company_id = ${companyId}
       and code = any(${[FX_ACCOUNT_CODES.gain, FX_ACCOUNT_CODES.loss]}::text[])`;
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  for (const code of [FX_ACCOUNT_CODES.gain, FX_ACCOUNT_CODES.loss]) {
    if (!byCode.has(code)) {
      // Never a null account and never a fallback (hazard 33). 0C seeds these; if one is missing the
      // seed pack was not applied to this company and the operator must apply it.
      throw new PostingError("ERR_POLICY_REQUIRES_MISSING",
        `company ${companyId} cannot resolve account code ${code} (§4.15: seeded by 0C in 0c-base.json)`);
    }
  }
  const [company] = await tx<{ fx_rounding_account_id: string | null }[]>`
    select fx_rounding_account_id from app.company where id = ${companyId}`;
  if (!company?.fx_rounding_account_id) {
    throw new PostingError("ERR_POLICY_REQUIRES_MISSING",
      `company ${companyId} has no fx_rounding_account_id (${FX_ACCOUNT_CODES.rounding}; spec:2001, 0C's seed task)`);
  }
  return {
    gainAccountId: byCode.get(FX_ACCOUNT_CODES.gain)!,
    lossAccountId: byCode.get(FX_ACCOUNT_CODES.loss)!,
    roundingAccountId: company.fx_rounding_account_id,
  };
}

interface FxLine {
  accountId: string;
  debit: string;
  credit: string;
  description: string;
  customFields: Record<string, unknown>;
}

/** Drafts the document, posts it, and returns its id. The ONLY place this module writes a document. */
async function draftAndPostFx(
  tx: Sql, ctx: TenantContext,
  input: { companyId: string; branchId: string; baseCurrency: string; effectiveDate: string;
           lines: readonly FxLine[]; jobs?: JobClient },
): Promise<string> {
  const [type] = await tx<{ id: string }[]>`
    select id from app.document_type where code = ${FX_REVALUATION_CODE}`;
  if (!type) {
    throw new PostingError("ERR_POLICY_NOT_FOUND",
      `document type ${FX_REVALUATION_CODE} is not configured for this tenant (seed pack document-types/FX_REVALUATION.json)`);
  }
  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       rate_source, party_id, branch_id)
    values (app.current_tenant(), ${input.companyId}, ${type.id}, ${"FXR"}, ${input.effectiveDate}::date,
            ${input.baseCurrency}, 1, ${"derived:fx"}, null, ${input.branchId})
    returning id`;
  // party_id is deliberately NULL: app.party_ageing_rows treats every posted document WITH a party as an
  // open item, so a party_id here would appear as an open receivable of exactly the FX amount and would
  // break the §4.8.2 tie-out by that figure (ADR 0047). The party is on the lines' custom_fields.
  let lineNo = 0;
  for (const l of input.lines) {
    lineNo += 1;
    await tx`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, description, account_id, debit, credit, custom_fields)
      values (app.current_tenant(), ${input.companyId}, ${doc!.id}, ${lineNo}, 'account',
              ${l.description}, ${l.accountId}, ${l.debit}, ${l.credit},
              ${JSON.stringify(l.customFields)}::jsonb)`;
  }
  await postDocument(tx, ctx, { documentId: doc!.id, jobs: input.jobs });
  return doc!.id;
}

/** The one direction rule (ADR 0047). `delta` is signed in debit-positive terms. */
function fxPair(
  subjectAccountId: string, delta: Dec, accounts: FxAccounts,
  description: string, customFields: Record<string, unknown>,
): FxLine[] {
  const magnitude = delta.abs().toFixed(4);
  const subjectSide = delta.isPositive() ? "debit" : "credit";
  const resultSide = subjectSide === "debit" ? "credit" : "debit";
  const resultAccountId = resultSide === "credit" ? accounts.gainAccountId : accounts.lossAccountId;
  return [
    { accountId: subjectAccountId, description,
      debit: subjectSide === "debit" ? magnitude : "0.0000",
      credit: subjectSide === "credit" ? magnitude : "0.0000", customFields },
    { accountId: resultAccountId, description,
      debit: resultSide === "debit" ? magnitude : "0.0000",
      credit: resultSide === "credit" ? magnitude : "0.0000", customFields },
  ];
}

/**
 * Posts the REALISED difference of one settlement. It reads the STORED `allocation.fx_difference` and
 * never recomputes it: 4A owns that arithmetic, and the tie-out is self-consistent for any value of it
 * (ADR 0047's table). Returns null when the sum is zero or an FX document already exists.
 */
export async function postSettlementFxDifference(
  tx: Sql, ctx: TenantContext,
  input: { settlementDocumentId: string; jobs?: JobClient },
): Promise<{ fxDocumentId: string; difference: Money } | null> {
  const [existing] = await tx<{ n: number }[]>`
    select count(*)::int as n
      from app.document_line l
      join app.document d      on d.id = l.document_id
      join app.document_type t on t.id = d.document_type_id
     where t.code = ${FX_REVALUATION_CODE}
       and d.status in ('posted', 'reversed')
       and l.custom_fields->>'fxKind' = 'realised'
       and l.custom_fields->>'settlementDocumentId' = ${input.settlementDocumentId}`;
  if ((existing?.n ?? 0) > 0) return null;

  const rows = await tx<{
    company_id: string; branch_id: string; effective_date: string; base_currency: string;
    party_id: string; control_account_id: string | null; kind: string;
    fx: string; settled_ids: string[];
  }[]>`
    select d.company_id, d.branch_id, d.effective_date::text, c.base_currency,
           p.id as party_id, p.kind,
           case when p.kind = 'vendor'
                then coalesce(p.payable_account_id, p.receivable_account_id)
                else coalesce(p.receivable_account_id, p.payable_account_id) end as control_account_id,
           sum(a.fx_difference)::text as fx,
           array_agg(distinct a.settled_document_id::text) as settled_ids
      from app.allocation a
      join app.document d on d.id = a.settlement_document_id
      join app.company  c on c.id = d.company_id
      join app.party    p on p.id = a.party_id
     where a.settlement_document_id = ${input.settlementDocumentId}
       and a.unallocated_at is null
     group by d.company_id, d.branch_id, d.effective_date, c.base_currency, p.id, p.kind, 3`;
  if (rows.length === 0) return null;

  const accounts = await resolveFxAccounts(tx, rows[0]!.company_id);
  const base = currency(rows[0]!.base_currency);
  const lines: FxLine[] = [];
  let total = new D(0);

  for (const r of rows) {
    const delta = new D(r.fx);
    if (delta.isZero()) continue;
    if (!r.control_account_id) {
      throw new PostingError("ERR_POLICY_REQUIRES_MISSING",
        `party ${r.party_id} has neither receivable_account_id nor payable_account_id, so its realised FX difference has no control account`);
    }
    total = total.plus(delta);
    lines.push(...fxPair(r.control_account_id, delta, accounts,
      `realised FX on settlement ${input.settlementDocumentId}`,
      { fxKind: "realised", settlementDocumentId: input.settlementDocumentId,
        settledDocumentId: r.settled_ids[0] ?? null, partyId: r.party_id }));
  }
  if (lines.length === 0) return null;

  const fxDocumentId = await draftAndPostFx(tx, ctx, {
    companyId: rows[0]!.company_id, branchId: rows[0]!.branch_id,
    baseCurrency: rows[0]!.base_currency, effectiveDate: rows[0]!.effective_date,
    lines, jobs: input.jobs,
  });

  // The idempotency key beside the fxKind marker: an app.document_link row (3C's table, link_kind
  // 'settles'). Inserted directly rather than through 3C's linkFulfilment, which requires at least one
  // source/target LINE pair and writes a fulfilment quantity — an FX document has neither (amendment 5).
  await tx`
    insert into app.document_link
      (tenant_id, company_id, source_document_id, target_document_id, link_kind, amount)
    values (app.current_tenant(), ${rows[0]!.company_id}, ${fxDocumentId},
            ${input.settlementDocumentId}, 'settles', ${total.abs().toFixed(4)})`;

  return { fxDocumentId, difference: Money.of(total.toFixed(4), base) };
}

/** `allocateSettlement` then `postSettlementFxDifference`, in the caller's ONE transaction (ADR 0047). */
export async function settleWithFx(
  tx: Sql, ctx: TenantContext,
  input: { settlementDocumentId: string; lines: readonly AllocationLine[]; jobs?: JobClient },
): Promise<{ allocationIds: string[]; fxDifference: Money; fxDocumentId: string | null }> {
  const allocated = await allocateSettlement(tx, ctx, {
    settlementDocumentId: input.settlementDocumentId, lines: input.lines,
  });
  const fx = await postSettlementFxDifference(tx, ctx, {
    settlementDocumentId: input.settlementDocumentId, jobs: input.jobs,
  });
  return { ...allocated, fxDocumentId: fx?.fxDocumentId ?? null };
}

export interface RevaluationResult {
  documentId: string | null;
  fiscalPeriodId: string;
  asOf: string;
  lines: readonly {
    accountId: string; accountCode: string; currency: string;
    amountCcy: string; carriedBase: string; revaluedBase: string; delta: string; rate: string;
  }[];
}

/**
 * One UNREALISED FX_REVALUATION per company per period, dated the period's `ends_on`.
 *
 * Party control accounts are revalued from the OPEN ITEMS (`ageingRows`), not from account_balance's
 * per-currency rows: in a cross-currency month those rows are not an open-item view (ADR 0046) and
 * revaluing them would restate a receivable allocation has already settled. Every other monetary account
 * — asset or liability, not a group, carrying a non-base balance, not a party control — is revalued from
 * account_balance. Inventory, revenue and expense accounts are not revalued: inventory is always carried
 * in base, and a non-monetary balance has no exposure.
 */
export async function revalueAtPeriodEnd(
  tx: Sql, ctx: TenantContext,
  input: { companyId: string; fiscalPeriodId: string; jobs?: JobClient },
): Promise<RevaluationResult> {
  const [period] = await tx<{ ends_on: string; starts_on: string }[]>`
    select ends_on::text, starts_on::text from app.fiscal_period
     where id = ${input.fiscalPeriodId} and company_id = ${input.companyId}`;
  if (!period) {
    throw new PostingError("ERR_PERIOD_NOT_FOUND",
      `fiscal period ${input.fiscalPeriodId} is not a period of company ${input.companyId}`);
  }
  const asOf = period.ends_on;

  // The idempotency guard. `status in ('posted','reversed')` — NOT `= 'posted'` — for the same reason
  // app.party_ageing_rows and the `rev` CTE use that pair: reverseRevaluation leaves the ORIGINAL at
  // 'reversed' (asserted in Step 6's reversal case), so a `= 'posted'` guard would count zero after the
  // period-start reversal and re-post the whole revaluation, double-restating the control account and
  // breaking ageingTieOut for that as-of date. The reversal document itself is dated the FIRST DAY OF THE
  // FOLLOWING period, so it never matches `effective_date = asOf` and cannot make the guard fire early.
  // `exists`, not `count(*)` over a join to document_line: a revaluation posts a PAIR of marked lines and
  // the join would fan out — the same defect the second review pass fixed in the `rev` CTE.
  const [already] = await tx<{ n: number }[]>`
    select count(*)::int as n
      from app.document d
      join app.document_type t on t.id = d.document_type_id
     where t.code = ${FX_REVALUATION_CODE} and d.company_id = ${input.companyId}
       and d.status in ('posted', 'reversed') and d.effective_date = ${asOf}::date
       and exists (select 1 from app.document_line l
                    where l.document_id = d.id and l.custom_fields->>'fxKind' = 'unrealised')`;
  if ((already?.n ?? 0) > 0) return { documentId: null, fiscalPeriodId: input.fiscalPeriodId, asOf, lines: [] };

  const [company] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${input.companyId}`;
  const base = company!.base_currency;
  const accounts = await resolveFxAccounts(tx, input.companyId);
  // The head-office BRANCH value, resolved BY CODE and never "the first row". `app.document.branch_id` is
  // NOT NULL and a company-level revaluation belongs to head office; `order by dv.code limit 1` would tag
  // it to whichever branch sorts first, so a company with a 'BR-2' or 'B01' branch would see 7C's branch
  // P&L attribute the whole unrealised FX to that branch. `HQ` is the code Plan 0A's seed uses for the
  // BRANCH dimension's one value (§4.1, "dimension type BRANCH with value HQ") and the literal a real
  // company's chart is expected to carry; a company without it is refused rather than guessed at.
  const [hq] = await tx<{ id: string }[]>`
    select dv.id from app.dimension_value dv
      join app.dimension_type dt on dt.id = dv.dimension_type_id
     where dt.code = 'BRANCH' and dt.company_id = ${input.companyId} and dv.code = 'HQ'`;
  if (!hq) {
    throw new PostingError("ERR_POLICY_REQUIRES_MISSING",
      `company ${input.companyId} has no BRANCH dimension value with code HQ, and a company-level ` +
      `FX_REVALUATION must carry one (app.document.branch_id is NOT NULL)`);
  }

  // (a) party control exposure, from the open items
  const open = await ageingRows(tx, { companyId: input.companyId, asOf });
  const parties = await tx<{ id: string; kind: string; control_account_id: string | null }[]>`
    select p.id, p.kind,
           case when p.kind = 'vendor'
                then coalesce(p.payable_account_id, p.receivable_account_id)
                else coalesce(p.receivable_account_id, p.payable_account_id) end as control_account_id
      from app.party p where p.company_id = ${input.companyId}`;
  const controlOf = new Map(parties.map((p) => [p.id, p]));
  const controlIds = new Set(parties.map((p) => p.control_account_id).filter((x): x is string => x !== null));

  type Exposure = { accountId: string; currency: string; amountCcy: Dec; carriedBase: Dec };
  const exposures = new Map<string, Exposure>();
  const addExposure = (accountId: string, ccy: string, amountCcy: Dec, carriedBase: Dec) => {
    const key = `${accountId}/${ccy}`;
    const prior = exposures.get(key);
    if (prior) { prior.amountCcy = prior.amountCcy.plus(amountCcy); prior.carriedBase = prior.carriedBase.plus(carriedBase); }
    else exposures.set(key, { accountId, currency: ccy, amountCcy, carriedBase });
  };

  const accountTypes = new Map(
    (await tx<{ id: string; type: string }[]>`
      select id, type::text as type from app.account where company_id = ${input.companyId}`)
      .map((r) => [r.id, r.type]),
  );

  for (const row of open) {
    if (row.currency === base) continue;
    const party = controlOf.get(row.partyId);
    if (!party?.control_account_id) continue;
    // ageingRows is positive-for-open in the PARTY's orientation (a vendor's figures are flipped). Bring
    // both figures back into the ledger's debit-positive orientation before differencing.
    const sign = accountTypes.get(party.control_account_id) === "liability" ? -1 : 1;
    addExposure(party.control_account_id, row.currency,
      new D(row.amount).times(sign), new D(row.baseAmount).times(sign));
  }

  // (b) every other monetary account, from account_balance
  const balances = await tx<{
    account_id: string; code: string; type: string; currency: string; ccy: string; base: string;
  }[]>`
    select b.account_id, a.code, a.type::text as type, b.currency,
           (sum(b.debit) - sum(b.credit))::text           as ccy,
           (sum(b.base_debit) - sum(b.base_credit))::text  as base
      from app.account_balance b
      join app.account a on a.id = b.account_id
     where b.company_id = ${input.companyId}
       and b.currency <> ${base}
       and a.is_group = false
       and a.type in ('asset', 'liability')
     group by b.account_id, a.code, a.type, b.currency`;
  for (const b of balances) {
    if (controlIds.has(b.account_id)) continue;      // (a) already covered it, and from the better source
    addExposure(b.account_id, b.currency, new D(b.ccy), new D(b.base));
  }

  const codeOf = new Map(
    (await tx<{ id: string; code: string }[]>`
      select id, code from app.account where company_id = ${input.companyId}`).map((r) => [r.id, r.code]),
  );

  const lines: FxLine[] = [];
  const detail: RevaluationResult["lines"][number][] = [];
  for (const e of [...exposures.values()].sort((x, y) =>
    `${codeOf.get(x.accountId)}${x.currency}`.localeCompare(`${codeOf.get(y.accountId)}${y.currency}`))) {
    if (e.amountCcy.isZero() && e.carriedBase.isZero()) continue;
    const [rate] = await tx<{ rate: string }[]>`
      select rate::text from app.rate_for(${input.companyId}, ${e.currency}, ${base}, ${asOf}::date)`;
    if (!rate?.rate) {
      // SAH-012/SAH-014: never assume 1 and never reuse the previous row's rate. Refuse and name the pair.
      throw new PostingError("ERR_RATE_NOT_FOUND",
        `no exchange_rate row for ${e.currency} → ${base} effective on or before ${asOf} (company ${input.companyId})`);
    }
    // The SAME arithmetic Money.toBase and the ledger_entry CHECK use: round(value × rate, 4),
    // HALF_AWAY_FROM_ZERO (spec:1816, hazard 23, SAH-019 — one rounding function, explicit mode).
    const revaluedBase = round(e.amountCcy.times(new D(rate.rate)), 4, "HALF_AWAY_FROM_ZERO");
    const delta = revaluedBase.minus(e.carriedBase);
    detail.push({
      accountId: e.accountId, accountCode: codeOf.get(e.accountId) ?? "", currency: e.currency,
      amountCcy: e.amountCcy.toFixed(4), carriedBase: e.carriedBase.toFixed(4),
      revaluedBase: revaluedBase.toFixed(4), delta: delta.toFixed(4), rate: rate.rate,
    });
    if (delta.isZero()) continue;
    lines.push(...fxPair(e.accountId, delta, accounts,
      `unrealised FX on ${codeOf.get(e.accountId)} ${e.currency} at ${asOf}`,
      { fxKind: "unrealised", fiscalPeriodId: input.fiscalPeriodId,
        revaluedAccountId: e.accountId, revaluedCurrency: e.currency }));
  }

  if (lines.length === 0) {
    return { documentId: null, fiscalPeriodId: input.fiscalPeriodId, asOf, lines: detail };
  }
  const documentId = await draftAndPostFx(tx, ctx, {
    companyId: input.companyId, branchId: hq.id, baseCurrency: base,
    effectiveDate: asOf, lines, jobs: input.jobs,
  });
  return { documentId, fiscalPeriodId: input.fiscalPeriodId, asOf, lines: detail };
}

/** D13 through 1A's frozen reverseDocument; §4.14's row says the revaluation is "reversed at period start". */
export async function reverseRevaluation(
  tx: Sql, ctx: TenantContext,
  input: { documentId: string; effectiveDate: string; jobs?: JobClient },
): Promise<{ reversalDocumentId: string; number: bigint }> {
  return reverseDocument(tx, ctx, {
    documentId: input.documentId,
    effectiveDate: input.effectiveDate,
    reason: `period-start reversal of the unrealised FX revaluation (§4.14, ADR 0047)`,
    jobs: input.jobs,
  });
}
```

`packages/db/src/ar-ap/index.ts` gains one export block:

```ts
export {
  FX_ACCOUNT_CODES, FX_REVALUATION_CODE, postSettlementFxDifference, resolveFxAccounts,
  revalueAtPeriodEnd, reverseRevaluation, settleWithFx,
  type FxAccounts, type RevaluationResult,
} from "./fx";
```

- [ ] **Step 7: The route, and the one call-site change inside 4A's allocation handler**

`packages/contracts/src/accounting/fx.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { CurrencySchema, DateSchema, MoneySchema, UuidSchema } from "../common";

export const RevalueBody = z.object({
  fiscalPeriodId: UuidSchema,
}).openapi("RevalueBody");

export const RevaluationResultSchema = z.object({
  documentId: UuidSchema.nullable(),
  fiscalPeriodId: UuidSchema,
  asOf: DateSchema,
  lines: z.array(z.object({
    accountId: UuidSchema, accountCode: z.string(), currency: CurrencySchema,
    amountCcy: z.string().regex(/^-?\d+\.\d{4}$/),
    carriedBase: z.string().regex(/^-?\d+\.\d{4}$/),
    revaluedBase: z.string().regex(/^-?\d+\.\d{4}$/),
    delta: z.string().regex(/^-?\d+\.\d{4}$/),
    rate: z.string().regex(/^\d+\.\d{8}$/),
  })),
}).openapi("RevaluationResult");
void MoneySchema;    // re-exported by the module barrel; not used in this file's shapes
```

`apps/api/src/routes/accounting/documents.ts` — **one `POST` sub-path on 1A's `documents` module**, the precedent 3D set with `POST …/documents/transfers`. **No new `RouteModule`, so no new `PROBES` key** (hazard 31 — `PROBES` is keyed by `RouteModule.path`).

```ts
// 4B — POST /v1/companies/{companyId}/documents/revaluations. Gated by the STATIC code §3.6.2 assigns
// this type ("the FX-revaluation and cost-adjustment documents post under accounting.journal.post"),
// not by requireDocumentPermission: the document does not exist yet, so there is no policy to resolve.
documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/revaluations",
    request: { params: CompanyParams, headers: IdempotencyHeader,
               body: { content: { "application/json": { schema: RevalueBody } } } },
    responses: {
      201: { content: { "application/json": { schema: RevaluationResultSchema } },
             description: "the unrealised revaluation for the period, or documentId null when nothing was exposed" },
      403: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "forbidden" },
      422: { content: { "application/problem+json": { schema: ProblemSchema } },
             description: "ERR_RATE_NOT_FOUND, ERR_PERIOD_NOT_OPEN or ERR_POLICY_REQUIRES_MISSING" },
    },
    middleware: [requirePermission(PERMISSION["accounting.journal.post"], { company: "path:companyId" })],
    tags: ["accounting"],
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { fiscalPeriodId } = c.req.valid("json");
    const result = await c.var.withTenant((tx) =>
      revalueAtPeriodEnd(tx, c.var.ctx, { companyId, fiscalPeriodId, jobs: c.var.jobs }));
    return c.json(result, 201);
  },
);
```

**The call-site change.** Task 0's gate printed the file that calls `allocateSettlement(`; in that handler, replace the call with `settleWithFx` and widen the response by one nullable member:

```ts
-   const result = await c.var.withTenant((tx) => allocateSettlement(tx, c.var.ctx, { settlementDocumentId, lines }));
+   // 4B: the realised FX difference posts in the SAME transaction as the allocation. A later, separate
+   // call would leave the §4.8.2 tie-out false in between, which is a state a reader of the ageing
+   // report could observe (ADR 0047).
+   const result = await c.var.withTenant((tx) =>
+     settleWithFx(tx, c.var.ctx, { settlementDocumentId, lines, jobs: c.var.jobs }));
```

and add `fxDocumentId: UuidSchema.nullable()` to 4A's allocation response schema. **If Task 0's gate found no handler calling `allocateSettlement`, stop and raise** — do not add a second settlement endpoint (see the Execution handoff).

- [ ] **Step 8: Write acceptance test 8**

`tests/invariants/test-08-multi-currency.test.ts`. Every figure below is derived in the plan and checked twice; the sequence is invoice EUR → part-pay USD → revalue → reverse → settle in base.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  ageingRows, ageingTieOut, outstandingRevaluation, partyBalance, postSettlementFxDifference,
  revalueAtPeriodEnd, reverseRevaluation, withTenant,
} from "@dulja/db";
import { seedCurrency, seedRate, seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { arApFixture, postFromPack, seedTypeFromPack, type ArApFixture } from "./support/ar-ap";

const MYR = currency("MYR");
const EUR = currency("EUR");
let db: Db;
let s: Seed;
let f: ArApFixture;
let ctx: { tenantId: string; actorId: string; requestId: string };
let invoiceId: string;
let revaluationId: string;

const ctxFor = async () => ({ tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "test08");
  f = await arApFixture(db, s);
  await seedTypeFromPack(db, s, "FX_REVALUATION");
  for (const code of ["EUR", "USD"]) await seedCurrency(db, s, { code });
  await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-01-01", rate: "5.00000000", source: "manual:test" });
  await seedRate(db, s, { from: "USD", to: "MYR", on: "2026-01-20", rate: "4.00000000", source: "manual:test" });
  await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-01-20", rate: "5.20000000", source: "manual:test" });
  await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-01-31", rate: "5.50000000", source: "manual:test" });
  await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-02-01", rate: "5.10000000", source: "manual:test" });
  ctx = await ctxFor();
}, 300_000);
afterAll(async () => { await db?.stop(); });

const controlBase = async (): Promise<string> =>
  withTenant(db.rw, await ctxFor(), async (tx) => {
    const [row] = await tx<{ base: string }[]>`
      select coalesce(sum(base_debit) - sum(base_credit), 0)::text as base
        from app.account_balance where company_id = ${s.company} and account_id = ${f.accountIds["1200"]}`;
    return row!.base;
  });

describe("acceptance test 8 — multi-currency round-trip (spec:2426; SAH-011, 012, 014)", () => {
  it("1. a EUR 1,000 invoice at 5.0000 carries base 5,000 and ages in EUR", async () => {
    ({ documentId: invoiceId } = await postFromPack(db, s, {
      code: "SALES_INVOICE", effectiveDate: "2026-01-05", partyId: f.partyIds.customer,
      currency: "EUR", exchangeRate: "5.00000000", rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, credit: "1000.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, debit:  "1000.0000" }],
    }));
    expect(await controlBase()).toBe("5000.0000");
    const rows = await withTenant(db.rw, await ctxFor(), (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-01-31" }));
    expect(rows).toEqual([{ partyId: f.partyIds.customer, currency: "EUR", bucket: "current",
                           amount: "1000.0000", baseAmount: "5000.0000" }]);
  });

  it("2. a USD 260 receipt at 4.0000 allocated as EUR 200 realises 40 base of gain, and the tie-out holds", async () => {
    const receipt = await postFromPack(db, s, {
      code: "RECEIPT", effectiveDate: "2026-01-20", partyId: f.partyIds.customer,
      currency: "USD", exchangeRate: "4.00000000", rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, debit:  "260.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, credit: "260.0000" }],
      allocate: [{ settledDocumentId: invoiceId, amount: Money.of("200.0000", EUR) }],
    });
    const c = await ctxFor();
    const posted = await withTenant(db.rw, c, (tx) =>
      postSettlementFxDifference(tx, c, { settlementDocumentId: receipt.documentId }));
    // settlement base 200 × 5.2 = 1040; settled base 200 × 5.0 = 1000; difference +40.
    expect(posted!.difference.toString()).toBe("40.0000");
    expect(await controlBase()).toBe("4000.0000");     // 5000 − 1040 + 40

    const tie = await withTenant(db.rw, await ctxFor(), (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-01-31" }));
    expect(tie.find((r) => r.accountCode === "1200")!.difference).toBe("0.0000");
  });

  it("2b. the ageing shows EUR 800 open and NO USD row — per currency it is an open-item view, not the ledger", async () => {
    const rows = await withTenant(db.rw, await ctxFor(), (tx) =>
      ageingRows(tx, { companyId: s.company, asOf: "2026-01-31" }));
    expect(rows.map((r) => [r.currency, r.amount])).toEqual([["EUR", "800.0000"]]);
    // The USD receipt is fully applied — base_amount + fx_difference == its own settlement base — so it
    // contributes no row at all. account_balance still carries its USD credit; ADR 0046 says why.
  });

  it("3. the period-end revaluation at 5.5000 posts 400 of unrealised gain, and the tie-out still holds", async () => {
    const [period] = await withTenant(db.rw, await ctxFor(), (tx) => tx<{ id: string }[]>`
      select id from app.fiscal_period where company_id = ${s.company} and starts_on = '2026-01-01'`);
    const c = await ctxFor();
    const result = await withTenant(db.rw, c, (tx) =>
      revalueAtPeriodEnd(tx, c, { companyId: s.company, fiscalPeriodId: period!.id }));
    revaluationId = result.documentId!;
    expect(result.lines.find((l) => l.accountCode === "1200")).toMatchObject({
      currency: "EUR", amountCcy: "800.0000", carriedBase: "4000.0000",
      revaluedBase: "4400.0000", delta: "400.0000", rate: "5.50000000" });
    expect(await controlBase()).toBe("4400.0000");

    const tie = await withTenant(db.rw, await ctxFor(), (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-01-31" }));
    const ar = tie.find((r) => r.accountCode === "1200")!;
    expect(ar).toMatchObject({ ageingBase: "4000.0000", ledgerBase: "4400.0000",
                               revaluationBase: "400.0000", difference: "0.0000" });
  });

  it("4. the reversal on 2026-02-01 returns the control account to 4,000 and zeroes the outstanding term", async () => {
    const c = await ctxFor();
    await withTenant(db.rw, c, (tx) =>
      reverseRevaluation(tx, c, { documentId: revaluationId, effectiveDate: "2026-02-01" }));
    expect(await controlBase()).toBe("4000.0000");
    await withTenant(db.rw, await ctxFor(), async (tx) => {
      expect(await outstandingRevaluation(tx, {
        companyId: s.company, accountId: f.accountIds["1200"]!, asOf: "2026-02-28" })).toBe("0.0000");
      const tie = await ageingTieOut(tx, { companyId: s.company, asOf: "2026-02-28" });
      expect(tie.find((r) => r.accountCode === "1200")!.difference).toBe("0.0000");
    });
  });

  it("5. settling in BASE at 5.1000 realises 80 more and closes the invoice to zero", async () => {
    const receipt = await postFromPack(db, s, {
      code: "RECEIPT", effectiveDate: "2026-02-05", partyId: f.partyIds.customer,
      currency: "MYR", exchangeRate: "1.00000000", rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, debit:  "4080.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, credit: "4080.0000" }],
      allocate: [{ settledDocumentId: invoiceId, amount: Money.of("800.0000", EUR) }],
    });
    const c = await ctxFor();
    const posted = await withTenant(db.rw, c, (tx) =>
      postSettlementFxDifference(tx, c, { settlementDocumentId: receipt.documentId }));
    expect(posted!.difference.toString()).toBe("80.0000");   // 800 × 5.1 − 800 × 5.0
    expect(await controlBase()).toBe("0.0000");              // 4000 − 4080 + 80

    await withTenant(db.rw, await ctxFor(), async (tx) => {
      expect(await ageingRows(tx, { companyId: s.company, asOf: "2026-02-28" })).toEqual([]);
      const tie = await ageingTieOut(tx, { companyId: s.company, asOf: "2026-02-28" });
      expect(tie.find((r) => r.accountCode === "1200")!.difference).toBe("0.0000");
    });
  });

  it("6. the party balance is right in all three currencies (spec:2426's clause)", async () => {
    await withTenant(db.rw, await ctxFor(), async (tx) => {
      // The open-item view: nothing outstanding in any currency.
      expect(await ageingRows(tx, { companyId: s.company, asOf: "2026-02-28" })).toEqual([]);
      // 4A's ledger-derived base figure agrees.
      const balance = await partyBalance(tx, { partyId: f.partyIds.customer, asOf: "2026-02-28" });
      expect(balance.base.toString()).toBe("0.0000");
    });
  });

  it("7. base = round(value × rate, 4) holds on EVERY ledger line of the fixture (SAH-012)", async () => {
    await withTenant(db.rw, await ctxFor(), async (tx) => {
      const [bad] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.ledger_entry
         where company_id = ${s.company}
           and (base_debit <> round(debit * exchange_rate, 4)
             or base_credit <> round(credit * exchange_rate, 4))`;
      expect(bad!.n).toBe(0);
      const [rows] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.ledger_entry where company_id = ${s.company}`;
      expect(rows!.n).toBeGreaterThan(10);      // the assertion above is not vacuous
    });
  });

  it("8. every ORIGINATING document of the fixture records its rate SOURCE (SAH-012, spec:1762)", async () => {
    await withTenant(db.rw, await ctxFor(), async (tx) => {
      const [missing] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.document
         where company_id = ${s.company} and status in ('posted', 'reversed')
           and reverses_document_id is null
           and (rate_source is null or rate_source = '')`;
      expect(missing!.n).toBe(0);
      // Not vacuous, and the count is exact — SIX originating documents, enumerated so a reader can
      // check the number rather than trust it:
      //   1. the EUR 1,000 SALES_INVOICE            (clause 1)
      //   2. the USD 260 RECEIPT                    (clause 2)
      //   3. its realised FX_REVALUATION            (clause 2, postSettlementFxDifference)
      //   4. the period-end unrealised FX_REVALUATION (clause 3, revalueAtPeriodEnd)
      //   5. the MYR 4,080 RECEIPT                  (clause 5)
      //   6. its realised FX_REVALUATION            (clause 5)
      // The reversal from clause 4 is the one document excluded, and it is excluded BY the predicate:
      // its rate_source is whatever 1A's reverseDocument copies, which this plan has not read and
      // therefore does not assert. Task 0's gate reports what reverse.ts does with the column.
      const [total] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.document
         where company_id = ${s.company} and status in ('posted', 'reversed')
           and reverses_document_id is null`;
      expect(total!.n).toBe(6);
      // And the reversal really is present, so the exclusion is doing work and not hiding an empty set.
      const [reversals] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.document
         where company_id = ${s.company} and reverses_document_id is not null`;
      expect(reversals!.n).toBe(1);
    });
  });
});
```

- [ ] **Step 9: Append the three regression blocks**

`tests/regression/sah-012.test.ts` — "base amounts never derived from value × rate; the rate never validated":

```ts
describe("SAH-012 Base amounts never derived from value × rate — 4B", () => {
  it("the revaluation applies round(value × rate, 4) and nothing else — one rounding call, one mode", async () => {
    const source = repoFile("packages/db/src/ar-ap/fx.ts");
    expect(source).toContain('round(e.amountCcy.times(new D(rate.rate)), 4, "HALF_AWAY_FROM_ZERO")');
    // No second arithmetic: no bare .times() feeding a document_line, and no toFixed on an unrounded product.
    expect(source).not.toMatch(/times\([^)]*rate[^)]*\)\.toFixed/);
  });

  it("a missing rate REFUSES rather than assuming 1 — the SAH-012 failure was ItmEqu = 1 with a foreign amount", async () => {
    expect(repoFile("packages/db/src/ar-ap/fx.ts")).toContain("ERR_RATE_NOT_FOUND");
  });
});
```

`tests/regression/sah-014.test.ts` — "`procSumVouItems` silently discards the caller's exchange rate":

```ts
describe("SAH-014 The caller's exchange rate is never discarded — 4B", () => {
  it("the ageing values each open item at ITS OWN rate, and the revaluation at the period-end rate", async () => {
    const { rw } = await sharedDb();
    const [fn] = await rw<{ prosrc: string }[]>`
      select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'party_ageing_rows'`;
    // base comes from each document's own exchange_rate, never from a single rate for the whole run.
    expect(fn!.prosrc).toContain("c.exchange_rate");
    expect(fn!.prosrc).not.toMatch(/exchange_rate\s*=\s*1/);
    // And the revaluation reads app.rate_for per (currency, as_of) — never the previous loop's rate.
    expect(repoFile("packages/db/src/ar-ap/fx.ts")).toContain("app.rate_for(");
  });
});
```

`tests/regression/sah-019.test.ts` — "rounding configured everywhere, applied nowhere, and the function wrong":

```ts
describe("SAH-019 One rounding function, explicit mode, symmetric across sign — 4B", () => {
  it("this slice rounds through @dulja/domain's round() with an explicit mode, never with toFixed alone", () => {
    const source = repoFile("packages/db/src/ar-ap/fx.ts");
    expect(source).toContain('from "@dulja/domain"');
    expect(source).toContain('"HALF_AWAY_FROM_ZERO"');
    // toFixed(4) appears only to SERIALISE an already-rounded decimal, never to round a product.
    for (const line of source.split("\n").filter((l) => l.includes("toFixed(4)"))) {
      expect(line, line).not.toMatch(/times\(|dividedBy\(/);
    }
  });

  it("the +6 / −6 asymmetry the old RoundTo.sql had is impossible: the mode is symmetric by contract", () => {
    // 0D's property tests own the proof; this block asserts 4B USES that function rather than a local one.
    expect(repoFile("packages/db/src/ar-ap/fx.ts")).not.toMatch(/function\s+round\w*\s*\(/);
  });
});
```

- [ ] **Step 10: Run to green**

```bash
bun run --cwd packages/db test -- ar-ap/fx
bun run --cwd tests test -- invariants/test-08-multi-currency
bun run --cwd tests test -- regression/sah-012 regression/sah-014 regression/sah-019
bun run --cwd apps/api test -- accounting/revaluation
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
```

- [ ] **Step 11: Commit**

```bash
git add docs/adr/0047-realised-and-unrealised-fx-in-one-document-type.md \
        packages/db/seed/my/document-types/FX_REVALUATION.json \
        packages/db/src/ar-ap/fx.ts packages/db/src/ar-ap/index.ts \
        packages/contracts/src/accounting/fx.ts apps/api/src/routes/accounting/documents.ts \
        packages/db/test/ar-ap/fx.test.ts tests/invariants/test-08-multi-currency.test.ts \
        apps/api/test/routes/accounting/revaluation.test.ts \
        tests/regression/sah-012.test.ts tests/regression/sah-014.test.ts tests/regression/sah-019.test.ts
git commit -m "feat(db): FX on settlement and at period end as FX_REVALUATION; acceptance test 8 [4B T5]

One registered code, two kinds, distinguished by document_line.custom_fields.fxKind — app.document
has no custom_fields column and A6's header bag needs a per-company definition a job cannot create.

The settlement difference cannot be posted by the settlement's own policy: §4.4.1's amountRef union
has no member for an allocation's FX difference. So it is a separate document, drafted after
allocateSettlement and posted in the SAME transaction, because a later call would leave the §4.8.2
tie-out false in between.

Neither FX document carries a party_id: app.party_ageing_rows treats a party document as an open
item, so one would break the tie-out by exactly the FX amount. One direction rule for both halves,
in debit-positive terms, with resultAccount = resultSide === credit ? 4900 : 5910 and non-negative
magnitudes on both lines.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Migration 0049 — `bank_statement`, `bank_statement_line` and the CSV import

**PR 3 of 5.** The import half of §4.8.3. Statement lines are **facts about the bank**, not about the ledger: nothing in this task or the next writes a `ledger_entry`, and that is the whole of SAH-041's fix applied to reconciliation (ADR 0048).

**Files:**
- Create: `packages/db/migrations/0049_create_bank_statement.sql`, `packages/db/migrations/0049.down.sql`
- Create: `packages/db/src/schema/bank-statement.ts`, `packages/db/src/ar-ap/reconciliation.ts`, `packages/contracts/src/accounting/bank.ts`
- Create: `docs/adr/0048-bank-reconciliation-never-alters-a-ledger-entry.md`
- Create: `packages/db/test/ar-ap/bank-statement.test.ts`
- Modify: `packages/db/src/lint-schema.ts` (nothing to add — see Step 4), `packages/db/src/ar-ap/index.ts`

**Interfaces**

- Consumes: `app.account` (plan0A), `app.company`, `app.attachment` (2C), `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp` (§4.1); `Money`, `currency`, `CurrencyCode` and **`D`** (§4.2.1 — `reconciliation.ts` parses and sums CSV amounts with `new D(...)`, never with `decimal.js` directly); `TenantContext`, the production `withTenant` (§4.2.2); `AppError`, `ERRORS` (§4.2.4); `lintSchema`, `listApplied` (§4.1); `startDb`, `Db`, `Seed`, the test `withTenant`, `uuidv7` (§4.1); `seedTenantV2`, `seedAccount` (1A); `arApFixture` (Task 3).
- Produces:
  - `app.bank_statement (…, bank_account_id, statement_date, opening_balance, closing_balance, currency, source_file_attachment_id, imported_by)` with `unique (company_id, bank_account_id, statement_date)` — §4.8.3 verbatim.
  - `app.bank_statement_line (…, statement_id, line_no, value_date, description, reference, amount)` with `unique (statement_id, line_no)` — §4.8.3 verbatim.
  ```ts
  // packages/db/src/ar-ap/reconciliation.ts (the import half; Task 7 adds the matching half)
  /**
   * The CSV column map AND the statement header the file does not carry. §4.8.3 freezes
   * `importStatement(tx, ctx, { companyId, bankAccountId, csv, mapping })`, so `mapping` is the only
   * place the three NOT NULL header figures can come from (amendment: registered by Task 0 as the §4.8.3
   * detail the register left open). `currency` is NOT here: it is
   * `coalesce(account.currency, company.base_currency)`, because a statement is always in the account's
   * own currency and letting a caller declare a different one is a class of error, not a feature.
   */
  export interface CsvMapping {
    readonly statement: {
      readonly statementDate: string;      // YYYY-MM-DD
      readonly openingBalance: string;     // 4 dp
      readonly closingBalance: string;     // 4 dp
    };
    readonly columns: {
      readonly valueDate: number | string;         // column index (0-based) or header name
      readonly description: number | string;
      readonly reference?: number | string;
      /** Either the signed single column… */
      readonly amount?: number | string;
      /** …or the two-column bank form, where DEBIT is money OUT: amount = credit − debit. */
      readonly debit?: number | string;
      readonly credit?: number | string;
    };
    readonly dateFormat: "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
    readonly hasHeader: boolean;
    readonly delimiter?: string;           // default ","
    readonly decimalComma?: boolean;       // "1.234,56" → "1234.56"
  }

  /** RFC 4180-shaped: quoted fields, "" as an escaped quote, CRLF or LF. It builds no SQL (hazard 21). */
  export function parseDelimited(text: string, delimiter?: string): string[][];

  export interface BankStatementRow {
    id: string; bankAccountId: string; statementDate: string;
    openingBalance: string; closingBalance: string; currency: string; lines: number;
  }
  export interface BankStatementLineRow {
    id: string; statementId: string; lineNo: number; valueDate: string;
    description: string; reference: string | null; amount: string;
    matchedAmount: string;                 // Σ live bank_match.amount — Task 7 fills it; 0 until then
  }
  export async function importStatement(
    tx: Sql, ctx: TenantContext,
    input: { companyId: string; bankAccountId: string; csv: string; mapping: CsvMapping },
  ): Promise<{ statementId: string; lines: number }>;
  export async function listStatements(
    tx: Sql, params: { companyId: string; bankAccountId?: string; limit: number },
  ): Promise<BankStatementRow[]>;
  export async function listStatementLines(
    tx: Sql, params: { statementId: string; unmatchedOnly?: boolean; limit: number },
  ): Promise<BankStatementLineRow[]>;
  /** Exported, and carrying a literal `code`, so Task 8's `rethrowAsAppError` can translate it — 3C's
   *  `LandedCostError` shape (phase-3c:2984). `packages/db` may not import `AppError` (§3.1). */
  export class ImportError extends Error {
    readonly code: "ERR_VALIDATION_FAILED";
    constructor(detail: string);
    readonly detail: string;
  }
  ```
  Contracts: `CsvMappingSchema`, `ImportStatementBody`, `BankStatementSchema`, `BankStatementList`, `BankStatementLineSchema`, `BankStatementLineQuery`, `BankStatementLineList` and the two DTO aliases `BankStatementDto` / `BankStatementLineDto` (Task 11's screens import the aliases, not the schemas — a schema is a value, not a type).

- [ ] **Step 1: Write ADR 0048 as a proposal, and ask**

`docs/adr/0048-bank-reconciliation-never-alters-a-ledger-entry.md`:

```markdown
# 0048 — Bank reconciliation never alters a ledger entry

- Status: **proposed** (spec:95 — money semantics; do not merge the implementation before this is accepted)
- Date: 2026-09-05
- Slice: 4B

## Context

spec:1043 requires "statement import (CSV), match/unmatch against receipts, payments, payroll batches and
till bankings; unreconciled-items report", and acceptance test 39 adds "matching never alters a ledger
entry; the reconciled balance equals the bank account's ledger balance". The legacy system's equivalent
did the opposite: SAH-031 shows a direct `UPDATE "VouItems"` on a signed, locked, closed-period voucher
silently rewriting `AccTotals` to match, and SAH-041 shows the anti-tampering triggers shipped inactive.

## Decision

**A match is a row in `app.bank_match` and nothing else.** No statement import, no match and no unmatch
writes, updates or deletes a `ledger_entry`, an `account_balance` or a `document` row. `packages/db/src/ar-ap/reconciliation.ts`
is outside `posting/` and `costing/`, so the `posting-only-tables` lint (§3.7.5) makes that mechanical
rather than a promise. **A match in a locked period therefore succeeds** — there is nothing for
`assert_period_open` to refuse — and the locked period's ledger rows are byte-identical afterwards, which
is what the sah-031 regression block asserts.

**Unmatching sets `unmatched_at`; nothing is deleted.** §3.5.4's `app_rw` DELETE list is pinned to five
tables and 2B is its only extender, so a `bank_match` row survives its own reversal and the audit trigger
keeps the before-image. spec:2049 admits deletion for drafts and for the erasure workflow, and a match is
neither.

**A statement line's `amount` is signed; a match's `amount` is a magnitude.** The line's sign is the bank's
own convention (money in positive) and the match's direction comes from the line, so
`bank_match.amount` carries `check (amount > 0)` and the direction is never inferred from a sign
(§4.4.2 A9's rule applied one layer out). A `reconcilable_kind` whose direction disagrees with the line's
sign is `ERR_BANK_MATCH_AMOUNT`, not a silent partial match.

**The `Reconcilable` registry, not a type list.** `registerReconcilableSource(source)` is the seam 6D's
till bankings and 8C's payroll batches plug into, and the `reconcilable_kind` CHECK already admits both
labels (§4.8.3), so neither slice edits a file of this one. **4B registers the `receipt` and `payment`
sources itself**: §4.8.3's comment assigns that to 4A, but `reconciliation.ts` is in *this* slice's
migration and file range and does not exist before this task, so 4A had nothing to register into.

**A source lists from the ledger's bank leg, not from a document total.** `Reconcilable.amount` is
`Σ(debit − credit)` on `ledger_entry` for the statement's own `bank_account_id`, and `valueDate` is the
document's `effective_date`. That works for a receipt banked into any of several bank accounts, for a
payment that draws on one, and for 6D's and 8C's documents without either slice having to know what a
"total" means for its own type.

**`CsvMapping` carries the statement header.** §4.8.3 freezes `importStatement`'s input as
`{ companyId, bankAccountId, csv, mapping }`, and `bank_statement.statement_date`, `opening_balance` and
`closing_balance` are all NOT NULL, so `mapping` is the only place they can come from. The **currency is
not** on the mapping: it is `coalesce(account.currency, company.base_currency)`, because a statement is
always in its account's currency and letting a caller declare another is a class of error.

**The import validates the statement against itself.** `closing_balance − opening_balance` must equal
`Σ amount` over the parsed lines, or the import is refused with `ERR_VALIDATION_FAILED` naming the
difference. A statement that does not add up is a bad file or a bad mapping, and importing it would make
every later "reconciled == ledger" assertion meaningless.

## Consequences

- `reconciledBalance(tx, { bankAccountId, asOf })` returns `{ statement, ledger, unreconciled }` and
  `statement === ledger` is the definition of done. It does **not** return unmatched *statement* lines —
  the frozen type has no member for them — so `unmatchedStatementLines` is a sibling function and the
  API returns both (Task 8).
- 7C's registered `accounting.unreconciled_items` report code is **not** shipped here (§4.16.1 owns it);
  this slice's unreconciled list is that function behind a `GET`.
- A partly-matched line is legal during a month and illegal at close: `reconciledBalance` reports the
  residue through `unreconciled` and the operator's runbook step is to finish or unmatch it.
```

Ask before implementing (spec:95).

- [ ] **Step 2: Write the failing test**

`packages/db/test/ar-ap/bank-statement.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importStatement, listStatementLines, listStatements, parseDelimited } from "../../src";
import { lintSchema, listApplied, withTenant as prodWithTenant } from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import { arApFixture, type ArApFixture } from "../../../../tests/invariants/support/ar-ap";

const CSV = [
  "Date,Narrative,Ref,Debit,Credit",
  "05/01/2026,TRANSFER FROM CUST-1,RCT-1,,1000.00",
  '08/01/2026,"PAYMENT, VEND-1",PAY-1,750.00,',
  "12/01/2026,BANK CHARGE,FEE,25.00,",
].join("\r\n");

const MAPPING = {
  statement: { statementDate: "2026-01-31", openingBalance: "0.0000", closingBalance: "225.0000" },
  columns: { valueDate: "Date", description: "Narrative", reference: "Ref", debit: "Debit", credit: "Credit" },
  dateFormat: "DD/MM/YYYY" as const,
  hasHeader: true,
};

let db: Db;
let s: Seed;
let f: ArApFixture;
let ctx: { tenantId: string; actorId: string; requestId: string };

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "bankstmt");
  f = await arApFixture(db, s);
  ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
}, 240_000);
afterAll(async () => { await db?.stop(); });

describe("migration 0049 — bank_statement and bank_statement_line (§4.8.3)", () => {
  it("applies as version 49", async () => {
    expect(await listApplied(db.migrator)).toContain(49);
  });

  it("both tables carry the §3.3 binding form, an audit trigger and an id", async () => {
    for (const table of ["bank_statement", "bank_statement_line"]) {
      const [rel] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relrowsecurity, relforcerowsecurity from pg_class where oid = ${`app.${table}`}::regclass`;
      expect(rel, table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await db.admin<{ policyname: string }[]>`
        select policyname from pg_policies where schemaname = 'app' and tablename = ${table}`;
      expect(policies.map((p) => p.policyname), table).toEqual(["tenant_isolation"]);
      const triggers = await db.admin<{ tgname: string }[]>`
        select tgname from pg_trigger where tgrelid = ${`app.${table}`}::regclass and not tgisinternal
         order by tgname`;
      expect(triggers.map((t) => t.tgname), table).toContain("audit_row");
    }
  });

  it("imported_by is stamped, so a supplied value cannot win (SAH-044)", async () => {
    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.bank_statement'::regclass and not tgisinternal`;
    expect(triggers.map((t) => t.tgname)).toContain("stamp_imported_by");
  });

  it("app_rw may not DELETE either table — §3.5.4's pinned list is unchanged (spec:2049)", async () => {
    const grants = await db.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app'
         and table_name in ('bank_statement', 'bank_statement_line')`;
    expect(grants.filter((g) => g.privilege_type === "DELETE")).toEqual([]);
  });

  it("lintSchema reports zero violations after 0049", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});

describe("parseDelimited (ADR 0048)", () => {
  it("handles quoted fields containing the delimiter, escaped quotes and CRLF", () => {
    const rows = parseDelimited('a,"b,c",d\r\n1,"he said ""hi""",3\r\n');
    expect(rows).toEqual([["a", "b,c", "d"], ["1", 'he said "hi"', "3"]]);
  });

  it("drops a trailing empty line rather than yielding a row of one empty field", () => {
    expect(parseDelimited("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("respects a semicolon delimiter", () => {
    expect(parseDelimited("a;b\n1;2", ";")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("importStatement (§4.8.3, ADR 0048)", () => {
  it("imports the three lines, converts DD/MM/YYYY, and signs debit as money OUT", async () => {
    const { statementId, lines } = await prodWithTenant(db.rw, ctx, (tx) =>
      importStatement(tx, ctx, { companyId: s.company, bankAccountId: f.accountIds["1100"]!,
                                 csv: CSV, mapping: MAPPING }));
    expect(lines).toBe(3);
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatementLines(tx, { statementId, limit: 50 }));
    expect(rows.map((r) => [r.valueDate, r.amount])).toEqual([
      ["2026-01-05", "1000.0000"],
      ["2026-01-08", "-750.0000"],
      ["2026-01-12", "-25.0000"],
    ]);
    expect(rows[1]!.description).toBe("PAYMENT, VEND-1");
    expect(rows[1]!.reference).toBe("PAY-1");
    expect(rows.every((r) => r.matchedAmount === "0.0000")).toBe(true);
  });

  it("takes the currency from the ACCOUNT, never from the caller", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatements(tx, { companyId: s.company, limit: 10 }));
    const [company] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ base_currency: string }[]>`
      select base_currency from app.company where id = ${s.company}`);
    expect(rows[0]!.currency).toBe(company!.base_currency);
  });

  it("refuses a statement that does not add up, naming the difference (SAH-011's discipline)", async () => {
    const bad = { ...MAPPING, statement: { ...MAPPING.statement, closingBalance: "300.0000",
                                           statementDate: "2026-02-28" } };
    await expect(prodWithTenant(db.rw, ctx, (tx) =>
      importStatement(tx, ctx, { companyId: s.company, bankAccountId: f.accountIds["1100"]!,
                                 csv: CSV, mapping: bad })))
      .rejects.toThrow(/ERR_VALIDATION_FAILED.*225\.0000.*300\.0000/);
  });

  it("refuses a second statement for the same account and date (unique (company, account, date))", async () => {
    await expect(prodWithTenant(db.rw, ctx, (tx) =>
      importStatement(tx, ctx, { companyId: s.company, bankAccountId: f.accountIds["1100"]!,
                                 csv: CSV, mapping: MAPPING })))
      .rejects.toThrow(/ERR_CONFLICT_UNIQUE|duplicate key/);
  });

  it("refuses a mapping that names neither `amount` nor the debit/credit pair", async () => {
    const bad = { ...MAPPING, columns: { valueDate: "Date", description: "Narrative" } } as never;
    await expect(prodWithTenant(db.rw, ctx, (tx) =>
      importStatement(tx, ctx, { companyId: s.company, bankAccountId: f.accountIds["1100"]!,
                                 csv: CSV, mapping: bad })))
      .rejects.toThrow(/ERR_VALIDATION_FAILED.*amount.*debit.*credit/);
  });

  it("refuses a zero-amount line rather than storing a fact that means nothing", async () => {
    const csv = ["Date,Narrative,Ref,Debit,Credit", "05/01/2026,NIL,X,0.00,0.00"].join("\n");
    const mapping = { ...MAPPING, statement: { statementDate: "2026-03-31",
                                               openingBalance: "0.0000", closingBalance: "0.0000" } };
    await expect(prodWithTenant(db.rw, ctx, (tx) =>
      importStatement(tx, ctx, { companyId: s.company, bankAccountId: f.accountIds["1100"]!,
                                 csv, mapping })))
      .rejects.toThrow(/ERR_VALIDATION_FAILED.*line 1.*zero/);
  });
});
```

- [ ] **Step 3: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- ar-ap/bank-statement
```

Expected:

```
FAIL  test/ar-ap/bank-statement.test.ts [ test/ar-ap/bank-statement.test.ts ]
SyntaxError: The requested module '../../src' does not provide an export named 'importStatement'
```

- [ ] **Step 4: Write migration 0049 and its down**

`packages/db/migrations/0049_create_bank_statement.sql`:

```sql
-- 0049_create_bank_statement.sql
-- §3.0.4 row 1043 "Bank reconciliation — statement import (CSV)…"; contracts §4.8.3.
-- A statement line is a fact about the BANK. Nothing in this slice writes a ledger_entry from one:
-- SAH-031's failure was a direct UPDATE on a locked voucher silently rewriting the balances, and
-- SAH-041's was hard deletion with the anti-tampering triggers shipped inactive (ADR 0048).

-- ── 1. app.bank_statement ───
create table app.bank_statement (
  id                        uuid primary key default uuidv7(),
  tenant_id                 uuid not null references app.tenant(id),
  company_id                uuid not null,
  bank_account_id           uuid not null,                        -- the app.account of the bank (1100 by default)
  statement_date            date not null,
  opening_balance           numeric(19,4) not null,               -- SAH-011: not null, and the import proves it adds up
  closing_balance           numeric(19,4) not null,
  currency                  char(3) not null,                     -- coalesce(account.currency, company.base_currency)
  source_file_attachment_id uuid,                                 -- 2C's attachment holding the original CSV
  imported_by               uuid not null default app.current_actor() references app.principal(id),
  created_at                timestamptz not null default now(),
  unique (company_id, bank_account_id, statement_date),           -- one statement per account per date
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)                references app.company(tenant_id, id),
  foreign key (tenant_id, bank_account_id)           references app.account(tenant_id, id),
  foreign key (tenant_id, source_file_attachment_id) references app.attachment(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.bank_statement');
call app_meta.attach_audit('app.bank_statement');
call app_meta.attach_stamp('app.bank_statement', 'imported_by');   -- server-supplied actor, never a payload (SAH-044)

-- ── 2. app.bank_statement_line ───
create table app.bank_statement_line (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  statement_id uuid not null,
  line_no      int not null check (line_no > 0),
  value_date   date not null,
  description  text not null,
  reference    text,
  -- SIGNED, and the sign is the bank's own convention: positive is money IN. app.bank_match.amount is a
  -- MAGNITUDE and takes its direction from this sign (§4.4.2 A9's rule applied one layer out).
  amount       numeric(19,4) not null check (amount <> 0),
  created_at   timestamptz not null default now(),
  unique (statement_id, line_no),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)   references app.company(tenant_id, id),
  -- No `on delete cascade`: app_rw holds no DELETE on either table (§3.5.4 is pinned) and spec:2049
  -- admits deletion only for drafts and the erasure workflow. A wrong statement is superseded, not deleted.
  foreign key (tenant_id, statement_id) references app.bank_statement(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.bank_statement_line');
call app_meta.attach_audit('app.bank_statement_line');
create index bank_statement_line_value_date_idx on app.bank_statement_line (company_id, value_date);
create index bank_statement_line_statement_idx  on app.bank_statement_line (statement_id, line_no);
```

`packages/db/migrations/0049.down.sql`:

```sql
-- 0049.down.sql — reverse dependency order (§3.4.5). `drop function … cascade` is not needed: the two
-- audit and one stamp trigger are dropped with their tables.
drop index if exists app.bank_statement_line_statement_idx;
drop index if exists app.bank_statement_line_value_date_idx;
drop table if exists app.bank_statement_line;
drop table if exists app.bank_statement;
```

**`lint-schema.ts` gains nothing in this task.** §3.5.3's row for `bank_statement`, `bank_statement_line`, `bank_match` and `pdc` has a dash in every column: they keep their `id`, their `created_at` and their audit trigger, and none is immutable. **A plan that adds one of them to a set has misread the register** (hazard 13).

- [ ] **Step 5: Write the Drizzle mirror**

```ts
// packages/db/src/schema/bank-statement.ts
import { char, date, integer, numeric, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const bankStatement = app.table("bank_statement", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  bankAccountId: uuid("bank_account_id").notNull(),
  statementDate: date("statement_date").notNull(),
  openingBalance: numeric("opening_balance", { precision: 19, scale: 4 }).notNull(),
  closingBalance: numeric("closing_balance", { precision: 19, scale: 4 }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  sourceFileAttachmentId: uuid("source_file_attachment_id"),
  importedBy: uuid("imported_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const bankStatementLine = app.table("bank_statement_line", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  statementId: uuid("statement_id").notNull(),
  lineNo: integer("line_no").notNull(),
  valueDate: date("value_date").notNull(),
  description: text("description").notNull(),
  reference: text("reference"),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 6: Write the import half of `packages/db/src/ar-ap/reconciliation.ts`**

```ts
// packages/db/src/ar-ap/reconciliation.ts
//
// Slice 4B, contracts §4.8.3. The import half (Task 6) and the matching half (Task 7). NOTHING in this
// file writes, updates or deletes a ledger_entry, an account_balance or a document row — the
// posting-only-tables lint (§3.7.5) makes that mechanical, and it is the whole of SAH-031's and
// SAH-041's fix applied to reconciliation (ADR 0048).
// Same rule as fx.ts: no file under packages/db/src imports decimal.js (§4.2.1 D11, phase-4a:35,
// 3b:1124). `D` is 0D's cloned precision-40 constructor, exported from the domain barrel (0d:443).
import { D, Money, currency, type CurrencyCode } from "@dulja/domain";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";

/** The instance type of 0D's cloned constructor. 0D exports the value `D`, not decimal.js's type. */
type Dec = InstanceType<typeof D>;

export interface CsvMapping {
  readonly statement: {
    readonly statementDate: string;
    readonly openingBalance: string;
    readonly closingBalance: string;
  };
  readonly columns: {
    readonly valueDate: number | string;
    readonly description: number | string;
    readonly reference?: number | string;
    readonly amount?: number | string;
    readonly debit?: number | string;
    readonly credit?: number | string;
  };
  readonly dateFormat: "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
  readonly hasHeader: boolean;
  readonly delimiter?: string;
  readonly decimalComma?: boolean;
}

/**
 * `packages/db` may not import `@dulja/contracts` (§3.1) and therefore cannot construct `AppError`, so
 * this is **3C's `LandedCostError` shape exactly** (phase-3c:2984-2987): one exported class carrying a
 * `readonly code` that is a literal member of `ErrCode`, plus a `readonly detail`. The three things that
 * matters for:
 *   - it is `export`ed, so `apps/api` can write `error instanceof ImportError` at all;
 *   - `code` is a literal, so Task 8's handler can write `new AppError(error.code, error.detail)` with
 *     **no cast** — exactly 3C's route pattern (phase-3c:4501), which is why this slice adds NO branch to
 *     `apps/api/src/problem.ts` (that file is a merge hotspot and 3C already proved the route-level catch);
 *   - the token stays in the `super()` message, so the packages/db-tier tests keep asserting
 *     `rejects.toThrow(/ERR_VALIDATION_FAILED: …/)` unchanged.
 * Without the export and the `code`, an unrecognised `Error` reaches 0B's generic handler as
 * `ERR_INTERNAL` 500 and every 4xx assertion in Task 8 fails.
 */
export class ImportError extends Error {
  /** A LITERAL member of `ErrCode`, so the handler's `new AppError(error.code, error.detail)` needs no
   *  cast. It is a field rather than a constructor parameter (3C's `LandedCostError` takes one) because
   *  this class has exactly one code: every rejection an import can produce is a bad file. */
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(readonly detail: string) {
    super(`ERR_VALIDATION_FAILED: ${detail}`);
    this.name = "ImportError";
  }
}

/** RFC 4180-shaped. It builds no SQL and touches no database (hazard 21). */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => {
    // A trailing newline must not yield a row of one empty field.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { quoted = true; i += 1; continue; }
    if (ch === delimiter) { pushField(); i += 1; continue; }
    if (ch === "\r") { i += 1; continue; }
    if (ch === "\n") { pushField(); pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  pushField();
  pushRow();
  return rows;
}

function columnIndex(spec: number | string, header: readonly string[] | null, what: string): number {
  if (typeof spec === "number") return spec;
  if (!header) throw new ImportError(`mapping names column "${spec}" for ${what} but hasHeader is false`);
  const at = header.findIndex((h) => h.trim() === spec);
  if (at < 0) throw new ImportError(`mapping names column "${spec}" for ${what}, which the header does not contain`);
  return at;
}

function toIsoDate(raw: string, format: CsvMapping["dateFormat"]): string {
  const parts = raw.trim().split(/[/\-.]/);
  if (format === "YYYY-MM-DD") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) throw new ImportError(`"${raw}" is not YYYY-MM-DD`);
    return raw.trim();
  }
  if (parts.length !== 3) throw new ImportError(`"${raw}" is not ${format}`);
  const [a, b, y] = parts as [string, string, string];
  const [dd, mm] = format === "DD/MM/YYYY" ? [a, b] : [b, a];
  if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(dd) || !/^\d{1,2}$/.test(mm)) {
    throw new ImportError(`"${raw}" is not ${format}`);
  }
  return `${y}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function toDecimal(raw: string, decimalComma: boolean): Dec {
  const cleaned = raw.trim().replace(/\s/g, "");
  if (cleaned === "") return new D(0);
  const normalised = decimalComma
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(normalised)) throw new ImportError(`"${raw}" is not a number`);
  return new D(normalised);
}

export async function importStatement(
  tx: Sql, ctx: TenantContext,
  input: { companyId: string; bankAccountId: string; csv: string; mapping: CsvMapping },
): Promise<{ statementId: string; lines: number }> {
  const m = input.mapping;
  const rows = parseDelimited(input.csv, m.delimiter);
  if (rows.length === 0) throw new ImportError("the CSV is empty");
  const header = m.hasHeader ? rows[0]! : null;
  const body = m.hasHeader ? rows.slice(1) : rows;
  if (body.length === 0) throw new ImportError("the CSV has a header and no rows");

  const iDate = columnIndex(m.columns.valueDate, header, "valueDate");
  const iDesc = columnIndex(m.columns.description, header, "description");
  const iRef = m.columns.reference === undefined ? null : columnIndex(m.columns.reference, header, "reference");
  const signed = m.columns.amount !== undefined;
  const pair = m.columns.debit !== undefined || m.columns.credit !== undefined;
  if (!signed && !pair) {
    throw new ImportError("mapping.columns must name either `amount` (signed) or the `debit`/`credit` pair");
  }
  const iAmount = signed ? columnIndex(m.columns.amount!, header, "amount") : null;
  const iDebit = m.columns.debit === undefined ? null : columnIndex(m.columns.debit, header, "debit");
  const iCredit = m.columns.credit === undefined ? null : columnIndex(m.columns.credit, header, "credit");

  const parsed: { valueDate: string; description: string; reference: string | null; amount: Dec }[] = [];
  let sum = new D(0);
  for (let n = 0; n < body.length; n += 1) {
    const cells = body[n]!;
    // debit is money OUT: amount = credit − debit (ADR 0048).
    const amount = iAmount !== null
      ? toDecimal(cells[iAmount] ?? "", m.decimalComma ?? false)
      : toDecimal(iCredit !== null ? cells[iCredit] ?? "" : "", m.decimalComma ?? false)
          .minus(toDecimal(iDebit !== null ? cells[iDebit] ?? "" : "", m.decimalComma ?? false));
    if (amount.isZero()) {
      throw new ImportError(`statement line ${n + 1} has a zero amount; a zero movement is not a fact about the bank`);
    }
    parsed.push({
      valueDate: toIsoDate(cells[iDate] ?? "", m.dateFormat),
      description: (cells[iDesc] ?? "").trim(),
      reference: iRef === null ? null : ((cells[iRef] ?? "").trim() || null),
      amount,
    });
    sum = sum.plus(amount);
  }

  const declared = new D(m.statement.closingBalance).minus(new D(m.statement.openingBalance));
  if (!declared.equals(sum)) {
    throw new ImportError(
      `the statement does not add up: opening ${m.statement.openingBalance} + Σ lines ${sum.toFixed(4)} ` +
      `is ${new D(m.statement.openingBalance).plus(sum).toFixed(4)}, but closing is ${m.statement.closingBalance}`);
  }

  // The currency is the ACCOUNT's, never the caller's (ADR 0048).
  const [account] = await tx<{ currency: string | null; base_currency: string }[]>`
    select a.currency, c.base_currency
      from app.account a join app.company c on c.id = a.company_id
     where a.id = ${input.bankAccountId} and a.company_id = ${input.companyId}`;
  if (!account) throw new ImportError(`account ${input.bankAccountId} is not an account of company ${input.companyId}`);
  const statementCurrency = account.currency ?? account.base_currency;

  const [statement] = await tx<{ id: string }[]>`
    insert into app.bank_statement
      (tenant_id, company_id, bank_account_id, statement_date, opening_balance, closing_balance, currency)
    values (app.current_tenant(), ${input.companyId}, ${input.bankAccountId},
            ${m.statement.statementDate}::date, ${m.statement.openingBalance}, ${m.statement.closingBalance},
            ${statementCurrency})
    returning id`;

  for (let n = 0; n < parsed.length; n += 1) {
    const l = parsed[n]!;
    await tx`
      insert into app.bank_statement_line
        (tenant_id, company_id, statement_id, line_no, value_date, description, reference, amount)
      values (app.current_tenant(), ${input.companyId}, ${statement!.id}, ${n + 1},
              ${l.valueDate}::date, ${l.description}, ${l.reference}, ${l.amount.toFixed(4)})`;
  }
  void ctx;    // the actor reaches the row through app.current_actor()'s default and stamp_imported_by
  return { statementId: statement!.id, lines: parsed.length };
}

export interface BankStatementRow {
  id: string; bankAccountId: string; statementDate: string;
  openingBalance: string; closingBalance: string; currency: string; lines: number;
}
export async function listStatements(
  tx: Sql, params: { companyId: string; bankAccountId?: string; limit: number },
): Promise<BankStatementRow[]> {
  const rows = await tx<{
    id: string; bank_account_id: string; statement_date: string; opening_balance: string;
    closing_balance: string; currency: string; lines: number;
  }[]>`
    select st.id, st.bank_account_id, st.statement_date::text, st.opening_balance::text,
           st.closing_balance::text, st.currency,
           (select count(*)::int from app.bank_statement_line l where l.statement_id = st.id) as lines
      from app.bank_statement st
     where st.company_id = ${params.companyId}
       and (${params.bankAccountId ?? null}::uuid is null or st.bank_account_id = ${params.bankAccountId ?? null})
     order by st.statement_date desc, st.id
     limit ${params.limit}`;
  return rows.map((r) => ({
    id: r.id, bankAccountId: r.bank_account_id, statementDate: r.statement_date,
    openingBalance: r.opening_balance, closingBalance: r.closing_balance,
    currency: r.currency, lines: r.lines,
  }));
}

export interface BankStatementLineRow {
  id: string; statementId: string; lineNo: number; valueDate: string;
  description: string; reference: string | null; amount: string; matchedAmount: string;
}
export async function listStatementLines(
  tx: Sql, params: { statementId: string; unmatchedOnly?: boolean; limit: number },
): Promise<BankStatementLineRow[]> {
  const rows = await tx<{
    id: string; statement_id: string; line_no: number; value_date: string;
    description: string; reference: string | null; amount: string; matched: string;
  }[]>`
    select l.id, l.statement_id, l.line_no, l.value_date::text, l.description, l.reference,
           l.amount::text,
           coalesce((select sum(bm.amount) from app.bank_match bm
                      where bm.statement_line_id = l.id and bm.unmatched_at is null), 0)::text as matched
      from app.bank_statement_line l
     where l.statement_id = ${params.statementId}
       and (${params.unmatchedOnly ?? false} = false
            or abs(l.amount) > coalesce((select sum(bm.amount) from app.bank_match bm
                                          where bm.statement_line_id = l.id and bm.unmatched_at is null), 0))
     order by l.line_no
     limit ${params.limit}`;
  return rows.map((r) => ({
    id: r.id, statementId: r.statement_id, lineNo: r.line_no, valueDate: r.value_date,
    description: r.description, reference: r.reference, amount: r.amount, matchedAmount: r.matched,
  }));
}
void Money; void currency;   // re-exported types used by Task 7's half of this file
export type { CurrencyCode };
```

⚠️ **`listStatementLines` reads `app.bank_match`, which migration 0050 creates in Task 7.** That is deliberate and it is the one forward reference in this file: writing the sub-select in Task 7 instead would mean editing a function Task 6's tests already assert on. **Task 6's `matchedAmount` assertions therefore run only after 0050 has been applied**, and the two migrations land in consecutive PRs — so Step 3's failing run and Step 8's green run are both after `bun run db:migrate` has applied 0049 **and** 0050. If Task 6 is executed strictly alone, comment the sub-select to `0::text as matched` and restore it in Task 7 Step 4; the tests then read `"0.0000"` either way.

- [ ] **Step 7: The contracts module**

`packages/contracts/src/accounting/bank.ts` (Task 8 adds the request/response schemas that need `bank_match`; this task ships the statement half):

```ts
import { z } from "@hono/zod-openapi";
import { CurrencySchema, DateSchema, ListEnvelope, ListQuery, UuidSchema } from "../common";

const Amount = z.string().regex(/^-?\d+\.\d{4}$/);

export const CsvMappingSchema = z.object({
  statement: z.object({
    statementDate: DateSchema,
    openingBalance: Amount,
    closingBalance: Amount,
  }),
  columns: z.object({
    valueDate: z.union([z.number().int().min(0), z.string().min(1)]),
    description: z.union([z.number().int().min(0), z.string().min(1)]),
    reference: z.union([z.number().int().min(0), z.string().min(1)]).optional(),
    amount: z.union([z.number().int().min(0), z.string().min(1)]).optional(),
    debit: z.union([z.number().int().min(0), z.string().min(1)]).optional(),
    credit: z.union([z.number().int().min(0), z.string().min(1)]).optional(),
  }).refine((c) => c.amount !== undefined || c.debit !== undefined || c.credit !== undefined,
    { message: "name either `amount` (signed) or the `debit`/`credit` pair" }),
  dateFormat: z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"]),
  hasHeader: z.boolean(),
  delimiter: z.string().length(1).optional(),
  decimalComma: z.boolean().optional(),
}).openapi("CsvMapping");

export const ImportStatementBody = z.object({
  bankAccountId: UuidSchema,
  csv: z.string().min(1).max(4_000_000),
  mapping: CsvMappingSchema,
}).openapi("ImportStatementBody");

export const BankStatementSchema = z.object({
  id: UuidSchema, bankAccountId: UuidSchema, statementDate: DateSchema,
  openingBalance: Amount, closingBalance: Amount, currency: CurrencySchema, lines: z.number().int(),
}).openapi("BankStatement");
export const BankStatementList = ListEnvelope(BankStatementSchema).openapi("BankStatementList");

export const BankStatementLineSchema = z.object({
  id: UuidSchema, statementId: UuidSchema, lineNo: z.number().int(), valueDate: DateSchema,
  description: z.string(), reference: z.string().nullable(), amount: Amount, matchedAmount: Amount,
}).openapi("BankStatementLine");

/**
 * §4.2.8 Layer 1: **no slice introduces a new flat filter parameter** — the grandfathered set is closed at
 * 0B's `AuditLogQuery`, 1A's `LedgerEntryQuery` and 1B's two. So the unmatched filter is expressed INSIDE
 * the grammar, as a literal `filter[<field>][<op>]` key: Layer 2's default, and 2A's form
 * (`"filter[code][eq]": …`, phase-2a:3408). `z.enum(["true","false"])` and not `z.coerce.boolean()`,
 * because a query value is always a string and `Boolean("false")` is `true` — the coercion would make
 * `filter[matched][eq]=false` mean "matched only", silently.
 *
 * `.strict()` for 1B's stated reason (phase-1b:3006-3011): `ListQuery` is a plain `z.object`, a plain Zod
 * object STRIPS unknown keys instead of rejecting them, and without this a misspelt
 * `filter[mached][eq]=false` would answer 200 with the wrong rows.
 *
 * The module's two other GETs read `bank_account_id` and `as_of` through `parseFilters` instead, and the
 * difference is that those two are **required**: `requiredFilter` (Task 8) raises one
 * `ERR_VALIDATION_FAILED` naming the exact key, which a Zod-required query member cannot express in the
 * same shape. One mechanism per route (§4.2.8), never both on one route.
 */
export const BankStatementLineQuery = ListQuery.extend({
  "filter[matched][eq]": z.enum(["true", "false"]).optional(),
}).strict();
export const BankStatementLineList = ListEnvelope(BankStatementLineSchema).openapi("BankStatementLineList");

// The DTO aliases the OD-24 screens import (§4.2.8's convention, 1B's `TrialBalanceRowDto` precedent).
// Without them Task 11's `import type { BankStatement, BankStatementLine } from "@dulja/contracts"` names
// symbols that do not exist — a schema is a value, not a type.
export type BankStatementDto = z.infer<typeof BankStatementSchema>;
export type BankStatementLineDto = z.infer<typeof BankStatementLineSchema>;
```

`packages/db/src/ar-ap/index.ts` gains the import half of `reconciliation.ts` — **including `ImportError`**, which `apps/api` cannot name in an `instanceof` unless it is re-exported here:

```ts
export {
  ImportError, importStatement, listStatementLines, listStatements, parseDelimited,
  type BankStatementLineRow, type BankStatementRow, type CsvMapping,
} from "./reconciliation";
```

- [ ] **Step 8: Run to green and commit**

```bash
bun run --cwd packages/db test -- ar-ap/bank-statement
bun run --cwd packages/db test -- privileges
bun run --cwd packages/db db:lint
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
```

```bash
git add packages/db/migrations/0049_create_bank_statement.sql packages/db/migrations/0049.down.sql \
        packages/db/src/schema/bank-statement.ts packages/db/src/ar-ap/reconciliation.ts \
        packages/db/src/ar-ap/index.ts packages/contracts/src/accounting/bank.ts \
        docs/adr/0048-bank-reconciliation-never-alters-a-ledger-entry.md \
        packages/db/test/ar-ap/bank-statement.test.ts
git commit -m "feat(db): bank_statement, bank_statement_line and the CSV import [4B T6]

A statement line is a fact about the BANK: nothing here writes a ledger_entry, and the
posting-only-tables lint makes that mechanical rather than a promise (ADR 0048). The import
validates the statement against itself — opening + Σ lines must equal closing, or it is refused
naming the difference, because importing a file that does not add up makes every later
reconciled == ledger assertion meaningless.

CsvMapping carries the statement header because §4.8.3 freezes importStatement's input and the
three header columns are NOT NULL; the currency is NOT on the mapping — it is the account's.
debit is money OUT, so amount = credit − debit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Migration 0050 — `bank_match`, the `Reconcilable` registry, match/unmatch, and acceptance test 39

**PR 4 of 5.** The second half of the Phase 4 definition of done, and the seam 6D and 8C plug into.

**Files:**
- Create: `packages/db/migrations/0050_create_bank_match.sql`, `packages/db/migrations/0050.down.sql`
- Create: `packages/db/src/schema/bank-match.ts`, `packages/db/test/ar-ap/bank-match.test.ts`, `tests/invariants/test-39-bank-reconciliation.test.ts`, `docs/runbooks/bank-reconciliation.md`
- Modify: `packages/db/src/ar-ap/reconciliation.ts` (the matching half), `packages/db/src/ar-ap/index.ts`, `packages/contracts/src/errors.ts` (`ERR_BANK_MATCH_AMOUNT`), `packages/contracts/src/accounting/bank.ts`, `tests/regression/sah-031.test.ts`, `tests/regression/sah-041.test.ts`

**Interfaces**

- Consumes: `app.bank_statement_line` (Task 6); `app.document`, `app.document_type`, `app.ledger_entry`, `app.account` (plan0A, 1A); `Money`, `currency`, `CurrencyCode` and **`D`** (§4.2.1 — the matching half's remaining-balance arithmetic, same rule as Task 6); `TenantContext`, the production `withTenant` (§4.2.2); `AppError`, `ERRORS`, `Problem` (§4.2.4); `arApFixture`, `postFromPack` (Task 3); `seedTenantV2`, `seedAccount` (1A); `startApi` (§4.2.12).
- Produces:
  - `app.bank_match (…, statement_line_id, reconcilable_kind, reconcilable_document_id, amount, matched_by, matched_at, unmatched_by, unmatched_at)` — §4.8.3 verbatim, with **both** stamps.
  - `ERR_BANK_MATCH_AMOUNT` (422) in `ERRORS` — §4.2.4's allocated row, added in the PR that raises it.
  ```ts
  export interface Reconcilable {
    kind: "receipt" | "payment" | "till_banking" | "payroll_batch";
    documentId: string; bankAccountId: string; valueDate: string; amount: Money; reference: string | null;
  }
  export interface ReconcilableSource {
    kind: Reconcilable["kind"];
    list(tx: Sql, input: { companyId: string; bankAccountId: string; from: string; to: string;
                           unmatchedOnly: boolean }): Promise<Reconcilable[]>;
  }
  /** The seam 6D (till bankings) and 8C (payroll batches) plug into. Registering twice under one kind
   *  replaces the earlier entry, so a hot reload is harmless — 1B's registerProjectionCheck's rule. */
  export function registerReconcilableSource(source: ReconcilableSource): void;
  export function reconcilableSources(): readonly ReconcilableSource[];
  /** Money in or money out, per kind. A kind whose direction disagrees with the statement line's sign
   *  cannot match it (ADR 0048). 6D and 8C's kinds are already here because the CHECK admits them. */
  export const RECONCILABLE_DIRECTION: Readonly<Record<Reconcilable["kind"], "in" | "out">>;

  export interface BankMatchRow {
    id: string; statementLineId: string; kind: Reconcilable["kind"]; reconcilableDocumentId: string;
    amount: string; matchedAt: string; unmatchedAt: string | null;
  }
  export async function match(
    tx: Sql, ctx: TenantContext,
    input: { statementLineId: string; reconcilable: Pick<Reconcilable, "kind" | "documentId">; amount: Money },
  ): Promise<{ matchId: string }>;
  export async function unmatch(
    tx: Sql, ctx: TenantContext, input: { matchId: string; reason: string },
  ): Promise<void>;
  export async function unmatchedStatementLines(
    tx: Sql, params: { bankAccountId: string; asOf: string },
  ): Promise<BankStatementLineRow[]>;
  export async function reconciledBalance(
    tx: Sql, input: { bankAccountId: string; asOf: string },
  ): Promise<{ statement: Money; ledger: Money; unreconciled: Reconcilable[] }>;
  /** `ImportError`'s twin. Exported and carrying a literal `code` so Task 8's handlers translate it with
   *  `new AppError(error.code, error.detail)` and no branch is added to apps/api/src/problem.ts. */
  export class BankMatchError extends Error {
    readonly code: "ERR_BANK_MATCH_AMOUNT";
    constructor(detail: string);
    readonly detail: string;
  }
  ```

  `packages/db/src/ar-ap/index.ts` gains the matching half of the same module. `BankMatchError` is in the
  list for the same reason `ImportError` was in Task 6's: `apps/api` cannot write `instanceof` against a
  class the barrel does not re-export.

  ```ts
  export {
    BankMatchError, RECONCILABLE_DIRECTION, match, reconcilableSources, reconciledBalance,
    registerReconcilableSource, unmatch, unmatchedStatementLines,
    type BankMatchRow, type Reconcilable, type ReconcilableSource,
  } from "./reconciliation";
  ```

- [ ] **Step 1: Write the failing test**

`packages/db/test/ar-ap/bank-match.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  RECONCILABLE_DIRECTION, importStatement, lintSchema, listApplied, listStatementLines, match,
  reconcilableSources, reconciledBalance, registerReconcilableSource, unmatch, unmatchedStatementLines,
  withTenant as prodWithTenant,
} from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import { arApFixture, postFromPack, type ArApFixture } from "../../../../tests/invariants/support/ar-ap";

const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: ArApFixture;
let ctx: { tenantId: string; actorId: string; requestId: string };
let receiptId: string;
let paymentId: string;
let statementId: string;
let lines: Awaited<ReturnType<typeof listStatementLines>>;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "bankmatch");
  f = await arApFixture(db, s);
  ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };

  ({ documentId: receiptId } = await postFromPack(db, s, {
    code: "RECEIPT", effectiveDate: "2026-01-05", partyId: f.partyIds.customer,
    lines: [{ kind: "account", accountId: f.accountIds["1100"]!, debit:  "1000.0000" },
            { kind: "account", accountId: f.accountIds["1200"]!, credit: "1000.0000" }],
  }));
  ({ documentId: paymentId } = await postFromPack(db, s, {
    code: "PAYMENT", effectiveDate: "2026-01-08", partyId: f.partyIds.vendor,
    lines: [{ kind: "account", accountId: f.accountIds["2100"]!, debit:  "750.0000" },
            { kind: "account", accountId: f.accountIds["1100"]!, credit: "750.0000" }],
  }));

  ({ statementId } = await prodWithTenant(db.rw, ctx, (tx) => importStatement(tx, ctx, {
    companyId: s.company, bankAccountId: f.accountIds["1100"]!,
    csv: ["Date,Narrative,Ref,Amount",
          "2026-01-05,RECEIPT CUST-1,RCT,1000.00",
          "2026-01-08,PAYMENT VEND-1,PAY,-750.00"].join("\n"),
    mapping: { statement: { statementDate: "2026-01-31", openingBalance: "0.0000", closingBalance: "250.0000" },
               columns: { valueDate: "Date", description: "Narrative", reference: "Ref", amount: "Amount" },
               dateFormat: "YYYY-MM-DD", hasHeader: true },
  })));
  lines = await withTenant(db.rw, s.tenant, s.human, (tx) =>
    listStatementLines(tx, { statementId, limit: 10 }));
}, 300_000);
afterAll(async () => { await db?.stop(); });

describe("migration 0050 — bank_match (§4.8.3)", () => {
  it("applies as version 50 and carries BOTH stamps", async () => {
    expect(await listApplied(db.migrator)).toContain(50);
    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.bank_match'::regclass and not tgisinternal
       order by tgname`;
    const names = triggers.map((t) => t.tgname);
    expect(names).toContain("stamp_matched_by");
    expect(names).toContain("stamp_unmatched_by");   // §4.8.3 says so explicitly; stamp_actor fires on
    expect(names).toContain("audit_row");            // EVERY *_by column that lacks a trigger
  });

  it("amount is a MAGNITUDE: check (amount > 0)", async () => {
    const [chk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.bank_match'::regclass and conname = 'bank_match_amount_check'`;
    expect(chk!.def).toContain("> 0");
  });

  it("the kind vocabulary already admits 6D's and 8C's labels", async () => {
    const [chk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.bank_match'::regclass and conname = 'bank_match_kind_check'`;
    for (const kind of ["receipt", "payment", "till_banking", "payroll_batch"]) {
      expect(chk!.def).toContain(`'${kind}'`);
    }
  });

  it("app_rw may not DELETE it (spec:2049; §3.5.4 pinned)", async () => {
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'bank_match'`;
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("lintSchema reports zero violations after 0050", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});

describe("the Reconcilable registry (§4.8.3, ADR 0048)", () => {
  it("4B registers receipt and payment — §4.8.3 assigns them to 4A, which had no file to register into", () => {
    expect(reconcilableSources().map((x) => x.kind).sort()).toEqual(["payment", "receipt"]);
  });

  it("directions are declared for all four kinds, including the two nobody has shipped yet", () => {
    expect(RECONCILABLE_DIRECTION).toEqual({
      receipt: "in", payment: "out", till_banking: "in", payroll_batch: "out" });
  });

  it("a third source registers without editing this slice's file — the seam 6D and 8C use", async () => {
    registerReconcilableSource({
      kind: "till_banking",
      async list() { return []; },
    });
    expect(reconcilableSources().map((x) => x.kind).sort())
      .toEqual(["payment", "receipt", "till_banking"]);
  });

  it("a source lists from the LEDGER's bank leg, so a receipt banked elsewhere is not listed", async () => {
    const receiptSource = reconcilableSources().find((x) => x.kind === "receipt")!;
    const found = await withTenant(db.rw, s.tenant, s.human, (tx) => receiptSource.list(tx, {
      companyId: s.company, bankAccountId: f.accountIds["1100"]!,
      from: "2026-01-01", to: "2026-01-31", unmatchedOnly: true }));
    expect(found.map((r) => [r.documentId, r.amount.toString(), r.valueDate]))
      .toEqual([[receiptId, "1000.0000", "2026-01-05"]]);
    const elsewhere = await withTenant(db.rw, s.tenant, s.human, (tx) => receiptSource.list(tx, {
      companyId: s.company, bankAccountId: f.accountIds["1000"] ?? f.accountIds["1200"]!,
      from: "2026-01-01", to: "2026-01-31", unmatchedOnly: true }));
    expect(elsewhere).toEqual([]);
  });
});

describe("match and unmatch (§4.8.3, ADR 0048)", () => {
  it("matches the receipt to the positive line and the payment to the negative one", async () => {
    const inLine = lines.find((l) => l.amount === "1000.0000")!;
    const outLine = lines.find((l) => l.amount === "-750.0000")!;
    await prodWithTenant(db.rw, ctx, async (tx) => {
      await match(tx, ctx, { statementLineId: inLine.id,
        reconcilable: { kind: "receipt", documentId: receiptId }, amount: Money.of("1000.0000", MYR) });
      await match(tx, ctx, { statementLineId: outLine.id,
        reconcilable: { kind: "payment", documentId: paymentId }, amount: Money.of("750.0000", MYR) });
    });
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatementLines(tx, { statementId, limit: 10 }));
    expect(after.map((l) => l.matchedAmount)).toEqual(["1000.0000", "750.0000"]);
  });

  it("a PAYMENT cannot match a positive line: the direction disagrees (ERR_BANK_MATCH_AMOUNT)", async () => {
    const inLine = lines.find((l) => l.amount === "1000.0000")!;
    await expect(prodWithTenant(db.rw, ctx, (tx) => match(tx, ctx, {
      statementLineId: inLine.id, reconcilable: { kind: "payment", documentId: paymentId },
      amount: Money.of("1.0000", MYR) }))).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*payment.*out.*\+/);
  });

  it("over-matching a line is refused, naming the line total and the running sum", async () => {
    const inLine = lines.find((l) => l.amount === "1000.0000")!;
    await expect(prodWithTenant(db.rw, ctx, (tx) => match(tx, ctx, {
      statementLineId: inLine.id, reconcilable: { kind: "receipt", documentId: receiptId },
      amount: Money.of("0.0100", MYR) }))).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*1000\.0000/);
  });

  it("over-matching a DOCUMENT is refused too — its bank leg is 1,000 and it is already fully matched", async () => {
    const { statementId: second } = await prodWithTenant(db.rw, ctx, (tx) => importStatement(tx, ctx, {
      companyId: s.company, bankAccountId: f.accountIds["1100"]!,
      csv: ["Date,Narrative,Ref,Amount", "2026-02-05,DUPLICATE,RCT,1000.00"].join("\n"),
      mapping: { statement: { statementDate: "2026-02-28", openingBalance: "250.0000", closingBalance: "1250.0000" },
                 columns: { valueDate: "Date", description: "Narrative", reference: "Ref", amount: "Amount" },
                 dateFormat: "YYYY-MM-DD", hasHeader: true },
    }));
    const [dup] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatementLines(tx, { statementId: second, limit: 10 }));
    await expect(prodWithTenant(db.rw, ctx, (tx) => match(tx, ctx, {
      statementLineId: dup!.id, reconcilable: { kind: "receipt", documentId: receiptId },
      amount: Money.of("1000.0000", MYR) }))).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*already matched/);
  });

  it("unmatch sets unmatched_at and the row SURVIVES — nothing is deleted (spec:2049, SAH-041)", async () => {
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select id from app.bank_match where unmatched_at is null and reconcilable_kind = 'payment'`);
    await prodWithTenant(db.rw, ctx, (tx) =>
      unmatch(tx, ctx, { matchId: row!.id, reason: "matched to the wrong line" }));
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [after] = await tx<{ unmatched_at: string | null; unmatched_by: string | null }[]>`
        select unmatched_at::text, unmatched_by::text from app.bank_match where id = ${row!.id}`;
      expect(after!.unmatched_at).not.toBeNull();
      expect(after!.unmatched_by).toBe(s.human);      // stamped on the NULL → value transition
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.bank_match`;
      expect(n!.n).toBeGreaterThan(0);
    });
  });

  it("reconciledBalance returns statement, ledger and the unreconciled items", async () => {
    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reconciledBalance(tx, { bankAccountId: f.accountIds["1100"]!, asOf: "2026-01-31" }));
    expect(result.ledger.toString()).toBe("250.0000");      // 1000 in − 750 out
    expect(result.statement.toString()).toBe("250.0000");   // the January statement's closing balance
    // The payment was just unmatched, so it is unreconciled again.
    expect(result.unreconciled.map((r) => r.documentId)).toEqual([paymentId]);
    // All THREE readers of the account's currency agree, and the fixture's 1100 row has
    // `currency IS NULL` (seedAccount sets none, plan0A:1495 "null = any currency"), so this is the
    // coalesce-onto-company.base_currency path in every one of them: importStatement stored MYR,
    // reconciledBalance reads MYR, and ledgerLegSource must mint MYR and not a literal of its own.
    // Without the join this line reads "XXX" and the next expression raises ERR_MONEY_CURRENCY_MISMATCH.
    for (const item of result.unreconciled) expect(item.amount.currency).toBe(MYR);
    expect(result.statement.currency).toBe(MYR);
    expect(result.ledger.currency).toBe(MYR);
    // And the two are arithmetically compatible, which is the whole point: the 250 that reconciles plus
    // the 750 payment still listed as unreconciled is the 1,000 receipt that is matched.
    expect(result.ledger.add(result.unreconciled[0]!.amount).toString()).toBe("1000.0000");
  });

  it("unmatchedStatementLines is the OTHER side, and the frozen type has no member for it", async () => {
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unmatchedStatementLines(tx, { bankAccountId: f.accountIds["1100"]!, asOf: "2026-01-31" }));
    expect(open.map((l) => l.amount)).toEqual(["-750.0000"]);
  });
});
```

- [ ] **Step 2: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- ar-ap/bank-match
```

Expected:

```
FAIL  test/ar-ap/bank-match.test.ts [ test/ar-ap/bank-match.test.ts ]
SyntaxError: The requested module '../../src' does not provide an export named 'registerReconcilableSource'
```

- [ ] **Step 3: Write migration 0050 and its down**

`packages/db/migrations/0050_create_bank_match.sql`:

```sql
-- 0050_create_bank_match.sql
-- §4.8.3. A match is a row HERE and nowhere else: no ledger_entry, no account_balance and no document
-- row is written, updated or deleted by matching or unmatching (ADR 0048, acceptance test 39). SAH-031's
-- failure was a direct UPDATE on a locked voucher rewriting the balances; SAH-041's was hard deletion.

create table app.bank_match (
  id                       uuid primary key default uuidv7(),
  tenant_id                uuid not null references app.tenant(id),
  company_id               uuid not null,
  statement_line_id        uuid not null,
  reconcilable_kind        text not null,
  reconcilable_document_id uuid not null,
  -- A MAGNITUDE. The direction comes from bank_statement_line.amount's sign, so no reader ever infers a
  -- direction from this figure (§4.4.2 A9's rule applied one layer out).
  amount                   numeric(19,4) not null,
  matched_by               uuid not null default app.current_actor() references app.principal(id),
  matched_at               timestamptz not null default now(),
  unmatched_by             uuid references app.principal(id),
  unmatched_at             timestamptz,
  created_at               timestamptz not null default now(),
  constraint bank_match_amount_check check (amount > 0),
  constraint bank_match_kind_check
    check (reconcilable_kind in ('receipt', 'payment', 'till_banking', 'payroll_batch')),
  -- Both unmatch columns move together, so "unmatched with no actor" is unrepresentable.
  constraint bank_match_unmatch_pair_check
    check ((unmatched_at is null and unmatched_by is null)
        or (unmatched_at is not null and unmatched_by is not null)),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)               references app.company(tenant_id, id),
  foreign key (tenant_id, statement_line_id)        references app.bank_statement_line(tenant_id, id),
  foreign key (tenant_id, reconcilable_document_id) references app.document(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.bank_match');
call app_meta.attach_audit('app.bank_match');
-- BOTH stamps. §4.8.3 states it and the linter requires it: the stamp_actor rule fires on EVERY column
-- whose name ends `_by` and lacks a stamp_<col> trigger (plan0A:2755-2758) and §3.5.2 requires zero
-- violations. It is also the right behaviour — stamp_actor stamps on the NULL → value transition
-- (plan0A:2379-2380), which is exactly when unmatch() sets unmatched_by.
call app_meta.attach_stamp('app.bank_match', 'matched_by');
call app_meta.attach_stamp('app.bank_match', 'unmatched_by');

-- One LIVE match per (line, document) pair: a second is a double-count, and re-matching after an unmatch
-- is legal because the partial index only covers unmatched_at is null.
create unique index bank_match_live_idx
  on app.bank_match (statement_line_id, reconcilable_document_id) where unmatched_at is null;
create index bank_match_document_idx on app.bank_match (reconcilable_document_id) where unmatched_at is null;
```

`packages/db/migrations/0050.down.sql`:

```sql
-- 0050.down.sql — reverse dependency order (§3.4.5).
drop index if exists app.bank_match_document_idx;
drop index if exists app.bank_match_live_idx;
drop table if exists app.bank_match;
```

- [ ] **Step 4: Write the matching half of `reconciliation.ts`**

Appended to the file Task 6 created. **If Task 6 was executed alone and `listStatementLines`' sub-select was commented out, restore it now.**

```ts
// ── The matching half (Task 7) ───

export interface Reconcilable {
  kind: "receipt" | "payment" | "till_banking" | "payroll_batch";
  documentId: string;
  bankAccountId: string;
  valueDate: string;
  amount: Money;
  reference: string | null;
}
export interface ReconcilableSource {
  kind: Reconcilable["kind"];
  list(tx: Sql, input: { companyId: string; bankAccountId: string; from: string; to: string;
                         unmatchedOnly: boolean }): Promise<Reconcilable[]>;
}

/** Money in or money out, per kind. All four are declared here, including the two nobody has shipped:
 *  the CHECK already admits them (§4.8.3) and a direction is a property of the kind, not of the slice. */
export const RECONCILABLE_DIRECTION: Readonly<Record<Reconcilable["kind"], "in" | "out">> = {
  receipt: "in",
  payment: "out",
  till_banking: "in",       // 6D — cash out of the till and INTO the bank
  payroll_batch: "out",     // 8C — the net-pay batch leaving the bank
};

const SOURCES = new Map<Reconcilable["kind"], ReconcilableSource>();

/** 1B's `registerProjectionCheck` rule: registering twice under one kind replaces the earlier entry. */
export function registerReconcilableSource(source: ReconcilableSource): void {
  SOURCES.set(source.kind, source);
}
export function reconcilableSources(): readonly ReconcilableSource[] {
  return [...SOURCES.values()].sort((x, y) => x.kind.localeCompare(y.kind));
}

/**
 * One source shape serves receipts and payments, and it lists from the LEDGER's bank leg rather than
 * from a document total (ADR 0048): that works for a receipt banked into any of several bank accounts and
 * gives 6D and 8C a shape they can copy without knowing what a "total" means for their own type.
 */
function ledgerLegSource(kind: Reconcilable["kind"], typeCode: string): ReconcilableSource {
  return {
    kind,
    async list(tx, input) {
      // `app.account.currency` is NULLABLE — plan0A:1495 comments it `-- null = any currency`, and 1A's
      // `seedAccount(db, s, { code, nameEn, type })` sets none, so the fixture's `1100` row has it null.
      // The query therefore joins `app.company` for `base_currency` and the mapper coalesces onto it,
      // which is the identical rule `importStatement` stores with and `reconciledBalance` reads back.
      // A literal fallback here would mint a currency no other reader agrees with, and the first
      // Money comparison between a `Reconcilable.amount` and `reconciledBalance().statement` would raise
      // ERR_MONEY_CURRENCY_MISMATCH instead of returning an answer.
      const rows = await tx<{
        document_id: string; value_date: string; leg: string; reference: string | null;
        currency: string | null; base_currency: string;
      }[]>`
        select d.id as document_id, d.effective_date::text as value_date,
               (sum(le.debit) - sum(le.credit))::text as leg,
               nullif(concat_ws('-', d.series, d.number::text), '') as reference,
               a.currency, c.base_currency
          from app.ledger_entry le
          join app.document      d on d.id = le.document_id
          join app.document_type t on t.id = d.document_type_id
          join app.account       a on a.id = le.account_id
          join app.company       c on c.id = d.company_id
         where le.company_id = ${input.companyId}
           and le.account_id = ${input.bankAccountId}
           and t.code = ${typeCode}
           and d.status in ('posted', 'reversed')
           and d.effective_date between ${input.from}::date and ${input.to}::date
         group by d.id, d.effective_date, d.series, d.number, a.currency, c.base_currency
        having sum(le.debit) - sum(le.credit) <> 0
           and (${input.unmatchedOnly} = false
                or abs(sum(le.debit) - sum(le.credit)) >
                   coalesce((select sum(bm.amount) from app.bank_match bm
                              where bm.reconcilable_document_id = d.id and bm.unmatched_at is null), 0))
         order by d.effective_date, d.id`;
      return rows.map((r) => ({
        kind,
        documentId: r.document_id,
        bankAccountId: input.bankAccountId,
        valueDate: r.value_date,
        amount: Money.of(new D(r.leg).abs().toFixed(4), currency(r.currency ?? r.base_currency)),
        reference: r.reference,
      }));
    },
  };
}

// §4.8.3's comment assigns these two to 4A. It cannot have shipped them: this FILE is in 4B's range and
// does not exist before Task 6, so 4A had nothing to register into (ADR 0048). 6D adds till_banking and
// 8C payroll_batch, each with one registerReconcilableSource call and no edit to this file.
registerReconcilableSource(ledgerLegSource("receipt", "RECEIPT"));
registerReconcilableSource(ledgerLegSource("payment", "PAYMENT"));

/**
 * `ImportError`'s twin, for the same three reasons (see Task 6's comment on that class): exported, so
 * `apps/api` can test `instanceof`; a `readonly code` that is a literal member of `ErrCode`, so Task 8's
 * handlers write `new AppError(error.code, error.detail)` with no cast and no branch in
 * `apps/api/src/problem.ts`; and the token still in the message, so the packages/db-tier tests keep
 * asserting `rejects.toThrow(/ERR_BANK_MATCH_AMOUNT: …/)`.
 *
 * **One code covers every rejection this file makes, deliberately.** A statement line or a match that is
 * "not visible" is also 422 here rather than 404: under FORCE RLS an invisible row and a row in another
 * tenant are the same observation, and the isolation probe (Task 8 Step 4) is what proves the *route*
 * refuses cross-tenant reads. §4.2.4 allocated 4B exactly one new `ERRORS` row and Global Constraint 11
 * closes the list; a second code here would be an amendment, and the route declares only 403 and 422.
 */
export class BankMatchError extends Error {
  readonly code = "ERR_BANK_MATCH_AMOUNT" as const;
  constructor(readonly detail: string) {
    super(`ERR_BANK_MATCH_AMOUNT: ${detail}`);
    this.name = "BankMatchError";
  }
}

export interface BankMatchRow {
  id: string; statementLineId: string; kind: Reconcilable["kind"];
  reconcilableDocumentId: string; amount: string; matchedAt: string; unmatchedAt: string | null;
}

export async function match(
  tx: Sql, ctx: TenantContext,
  input: { statementLineId: string; reconcilable: Pick<Reconcilable, "kind" | "documentId">; amount: Money },
): Promise<{ matchId: string }> {
  const amount = new D(input.amount.toString());
  if (!amount.isPositive()) {
    throw new BankMatchError(`a match amount is a magnitude and must be greater than zero, got ${amount.toFixed(4)}`);
  }

  const [line] = await tx<{ id: string; company_id: string; amount: string; matched: string }[]>`
    select l.id, l.company_id, l.amount::text,
           coalesce((select sum(bm.amount) from app.bank_match bm
                      where bm.statement_line_id = l.id and bm.unmatched_at is null), 0)::text as matched
      from app.bank_statement_line l where l.id = ${input.statementLineId}`;
  if (!line) throw new BankMatchError(`statement line ${input.statementLineId} is not visible`);

  const lineAmount = new D(line.amount);
  const wanted = RECONCILABLE_DIRECTION[input.reconcilable.kind];
  const lineDirection = lineAmount.isPositive() ? "in" : "out";
  if (wanted !== lineDirection) {
    throw new BankMatchError(
      `a ${input.reconcilable.kind} is money ${wanted} and statement line ${line.amount} is money ` +
      `${lineDirection} (${lineAmount.isPositive() ? "+" : "-"}): the direction disagrees`);
  }

  const lineRemaining = lineAmount.abs().minus(new D(line.matched));
  if (amount.greaterThan(lineRemaining)) {
    throw new BankMatchError(
      `statement line total ${lineAmount.abs().toFixed(4)} already carries ${new D(line.matched).toFixed(4)} ` +
      `of matches, so ${amount.toFixed(4)} exceeds the remaining ${lineRemaining.toFixed(4)}`);
  }

  const [doc] = await tx<{ leg: string; matched: string }[]>`
    select coalesce(abs(sum(le.debit) - sum(le.credit)), 0)::text as leg,
           coalesce((select sum(bm.amount) from app.bank_match bm
                      where bm.reconcilable_document_id = ${input.reconcilable.documentId}
                        and bm.unmatched_at is null), 0)::text as matched
      from app.ledger_entry le
     where le.document_id = ${input.reconcilable.documentId}
       and le.account_id = (select l2.bank_account_id
                              from app.bank_statement_line sl
                              join app.bank_statement l2 on l2.id = sl.statement_id
                             where sl.id = ${input.statementLineId})`;
  const docRemaining = new D(doc?.leg ?? "0").minus(new D(doc?.matched ?? "0"));
  if (amount.greaterThan(docRemaining)) {
    throw new BankMatchError(
      `document ${input.reconcilable.documentId} has a bank leg of ${new D(doc?.leg ?? "0").toFixed(4)} ` +
      `and is already matched for ${new D(doc?.matched ?? "0").toFixed(4)}, so ${amount.toFixed(4)} ` +
      `exceeds the remaining ${docRemaining.toFixed(4)}`);
  }

  const [row] = await tx<{ id: string }[]>`
    insert into app.bank_match
      (tenant_id, company_id, statement_line_id, reconcilable_kind, reconcilable_document_id, amount)
    values (app.current_tenant(), ${line.company_id}, ${input.statementLineId},
            ${input.reconcilable.kind}, ${input.reconcilable.documentId}, ${amount.toFixed(4)})
    returning id`;
  void ctx;
  return { matchId: row!.id };
}

/** Sets `unmatched_at`; never alters a ledger entry and never deletes the row (spec:2457, SAH-041). */
export async function unmatch(
  tx: Sql, ctx: TenantContext, input: { matchId: string; reason: string },
): Promise<void> {
  const updated = await tx`
    update app.bank_match
       set unmatched_at = now(), unmatched_by = app.current_actor()
     where id = ${input.matchId} and unmatched_at is null`;
  if (updated.count === 0) {
    throw new BankMatchError(`match ${input.matchId} is not visible or is already unmatched`);
  }
  void ctx; void input.reason;   // the reason reaches app.audit_log's after-image through the row update
}

export async function unmatchedStatementLines(
  tx: Sql, params: { bankAccountId: string; asOf: string },
): Promise<BankStatementLineRow[]> {
  const rows = await tx<{
    id: string; statement_id: string; line_no: number; value_date: string;
    description: string; reference: string | null; amount: string; matched: string;
  }[]>`
    select l.id, l.statement_id, l.line_no, l.value_date::text, l.description, l.reference,
           l.amount::text,
           coalesce((select sum(bm.amount) from app.bank_match bm
                      where bm.statement_line_id = l.id and bm.unmatched_at is null), 0)::text as matched
      from app.bank_statement_line l
      join app.bank_statement st on st.id = l.statement_id
     where st.bank_account_id = ${params.bankAccountId}
       and l.value_date <= ${params.asOf}::date
       and abs(l.amount) > coalesce((select sum(bm.amount) from app.bank_match bm
                                      where bm.statement_line_id = l.id and bm.unmatched_at is null), 0)
     order by l.value_date, l.line_no`;
  return rows.map((r) => ({
    id: r.id, statementId: r.statement_id, lineNo: r.line_no, valueDate: r.value_date,
    description: r.description, reference: r.reference, amount: r.amount, matchedAmount: r.matched,
  }));
}

/** `statement === ledger` is the definition of done (§4.8.3). */
export async function reconciledBalance(
  tx: Sql, input: { bankAccountId: string; asOf: string },
): Promise<{ statement: Money; ledger: Money; unreconciled: Reconcilable[] }> {
  const [account] = await tx<{ company_id: string; currency: string | null; base_currency: string }[]>`
    select a.company_id, a.currency, c.base_currency
      from app.account a join app.company c on c.id = a.company_id
     where a.id = ${input.bankAccountId}`;
  if (!account) throw new BankMatchError(`account ${input.bankAccountId} is not visible`);
  const ccy = currency(account.currency ?? account.base_currency);

  const [stmt] = await tx<{ closing: string }[]>`
    select closing_balance::text as closing from app.bank_statement
     where bank_account_id = ${input.bankAccountId} and statement_date <= ${input.asOf}::date
     order by statement_date desc limit 1`;

  const [led] = await tx<{ balance: string }[]>`
    select coalesce(sum(debit) - sum(credit), 0)::text as balance
      from app.ledger_entry
     where account_id = ${input.bankAccountId} and effective_date <= ${input.asOf}::date`;

  const unreconciled: Reconcilable[] = [];
  for (const source of reconcilableSources()) {
    // 1900-01-01 is a deliberate floor rather than the earliest statement date: an item older than the
    // first statement is exactly the kind of thing that must show up as unreconciled.
    unreconciled.push(...await source.list(tx, {
      companyId: account.company_id, bankAccountId: input.bankAccountId,
      from: "1900-01-01", to: input.asOf, unmatchedOnly: true,
    }));
  }

  return {
    statement: Money.of(new D(stmt?.closing ?? "0").toFixed(4), ccy),
    ledger: Money.of(new D(led?.balance ?? "0").toFixed(4), ccy),
    unreconciled,
  };
}
```

`packages/contracts/src/errors.ts` — one row appended to `ERRORS`, **in this PR because this is the PR that raises it** (§4.2.4):

```ts
  ERR_BANK_MATCH_AMOUNT: {
    status: 422,
    title: "Bank match amounts do not agree",
    remedy: "Match an amount no greater than the statement line's and the document's remaining balance, and match money in against money in.",
  },
```

`apps/api/src/problem.ts` needs **no new branch**: `BankMatchError` and `ImportError` both carry their token in the message, and `fromDatabaseError`'s `/^ERR_[A-Z_]+:/` translation already covers that shape (§4.2.4) — the same route `PostingError`'s tokens take.

- [ ] **Step 5: Write acceptance test 39**

`tests/invariants/test-39-bank-reconciliation.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  importStatement, listStatementLines, match, reconciledBalance, unmatch, unmatchedStatementLines,
  withTenant,
} from "@dulja/db";
import { seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { arApFixture, postFromPack, type ArApFixture } from "./support/ar-ap";

const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: ArApFixture;
let ids: { receipt1: string; receipt2: string; payment1: string; payment2: string };
let statementId: string;

const ctxFor = async () => ({ tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) });

/** A per-document sha256 of every ledger_entry column that could be tampered with (SAH-031, SAH-041). */
const ledgerFingerprint = async (): Promise<string> =>
  withTenant(db.rw, await ctxFor(), async (tx) => {
    const [row] = await tx<{ h: string }[]>`
      select coalesce(encode(sha256(convert_to(string_agg(t, '|' order by t), 'UTF8')), 'hex'), '') as h
        from (select concat_ws(':', document_id::text, line_no::text, account_id::text,
                               debit::text, credit::text, base_debit::text, base_credit::text,
                               effective_date::text, fiscal_period_id::text) as t
                from app.ledger_entry where company_id = ${s.company}) x`;
    return row!.h;
  });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "test39");
  f = await arApFixture(db, s);
  const post = (code: string, date: string, party: string, bankDebit: string, bankCredit: string,
                other: string) =>
    postFromPack(db, s, { code, effectiveDate: date, partyId: party,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, debit: bankDebit, credit: bankCredit },
              { kind: "account", accountId: f.accountIds[other]!,
                debit: bankCredit, credit: bankDebit }] });
  ids = {
    receipt1: (await post("RECEIPT", "2026-01-03", f.partyIds.customer, "1200.0000", "0.0000", "1200")).documentId,
    receipt2: (await post("RECEIPT", "2026-01-17", f.partyIds.customer, "800.0000", "0.0000", "1200")).documentId,
    payment1: (await post("PAYMENT", "2026-01-09", f.partyIds.vendor, "0.0000", "500.0000", "2100")).documentId,
    payment2: (await post("PAYMENT", "2026-01-24", f.partyIds.vendor, "0.0000", "300.0000", "2100")).documentId,
  };
}, 300_000);
afterAll(async () => { await db?.stop(); });

describe("acceptance test 39 — bank reconciliation (spec:2457; SAH-031, SAH-041, RC-2)", () => {
  let before = "";

  it("1. a month's statement imports and adds up", async () => {
    before = await ledgerFingerprint();
    const ctx = await ctxFor();
    ({ statementId } = await withTenant(db.rw, ctx, (tx) => importStatement(tx, ctx, {
      companyId: s.company, bankAccountId: f.accountIds["1100"]!,
      csv: ["Date,Narrative,Ref,Amount",
            "2026-01-03,RECEIPT CUST-1,R1,1200.00",
            "2026-01-09,PAYMENT VEND-1,P1,-500.00",
            "2026-01-17,RECEIPT CUST-1,R2,800.00",
            "2026-01-24,PAYMENT VEND-1,P2,-300.00"].join("\n"),
      mapping: { statement: { statementDate: "2026-01-31", openingBalance: "0.0000", closingBalance: "1200.0000" },
                 columns: { valueDate: "Date", description: "Narrative", reference: "Ref", amount: "Amount" },
                 dateFormat: "YYYY-MM-DD", hasHeader: true },
    })));
  });

  it("2. every receipt and payment matches, or is listed as unreconciled — one is left open on purpose", async () => {
    const lines = await withTenant(db.rw, await ctxFor(), (tx) =>
      listStatementLines(tx, { statementId, limit: 10 }));
    const pairs: [string, "receipt" | "payment", string][] = [
      [lines[0]!.id, "receipt", ids.receipt1],
      [lines[1]!.id, "payment", ids.payment1],
      [lines[2]!.id, "receipt", ids.receipt2],
      // lines[3] (payment2, −300) is deliberately NOT matched yet.
    ];
    const ctx = await ctxFor();
    await withTenant(db.rw, ctx, async (tx) => {
      for (const [lineId, kind, documentId] of pairs) {
        const [amount] = await tx<{ a: string }[]>`
          select abs(amount)::text as a from app.bank_statement_line where id = ${lineId}`;
        await match(tx, ctx, { statementLineId: lineId, reconcilable: { kind, documentId },
                               amount: Money.of(amount!.a, MYR) });
      }
    });

    const result = await withTenant(db.rw, await ctxFor(), (tx) =>
      reconciledBalance(tx, { bankAccountId: f.accountIds["1100"]!, asOf: "2026-01-31" }));
    expect(result.unreconciled.map((r) => r.documentId)).toEqual([ids.payment2]);
    const open = await withTenant(db.rw, await ctxFor(), (tx) =>
      unmatchedStatementLines(tx, { bankAccountId: f.accountIds["1100"]!, asOf: "2026-01-31" }));
    expect(open.map((l) => l.amount)).toEqual(["-300.0000"]);
  });

  it("3. once every item is matched, the reconciled balance EQUALS the bank account's ledger balance", async () => {
    const lines = await withTenant(db.rw, await ctxFor(), (tx) =>
      listStatementLines(tx, { statementId, limit: 10 }));
    const ctx = await ctxFor();
    await withTenant(db.rw, ctx, (tx) => match(tx, ctx, {
      statementLineId: lines[3]!.id, reconcilable: { kind: "payment", documentId: ids.payment2 },
      amount: Money.of("300.0000", MYR) }));

    const result = await withTenant(db.rw, await ctxFor(), (tx) =>
      reconciledBalance(tx, { bankAccountId: f.accountIds["1100"]!, asOf: "2026-01-31" }));
    expect(result.unreconciled).toEqual([]);
    expect(result.statement.toString()).toBe("1200.0000");
    expect(result.ledger.toString()).toBe("1200.0000");
    expect(result.statement.equals(result.ledger)).toBe(true);      // the DoD sentence
  });

  it("4. matching NEVER altered a ledger entry — the fingerprint is byte-identical (SAH-031, SAH-041)", async () => {
    expect(await ledgerFingerprint()).toBe(before);
  });

  it("5. an unmatch reopens the item, and the ledger is still byte-identical", async () => {
    const [row] = await withTenant(db.rw, await ctxFor(), (tx) => tx<{ id: string }[]>`
      select id from app.bank_match where unmatched_at is null and reconcilable_document_id = ${ids.payment2}`);
    const ctx = await ctxFor();
    await withTenant(db.rw, ctx, (tx) => unmatch(tx, ctx, { matchId: row!.id, reason: "test 39 clause 5" }));
    const result = await withTenant(db.rw, await ctxFor(), (tx) =>
      reconciledBalance(tx, { bankAccountId: f.accountIds["1100"]!, asOf: "2026-01-31" }));
    expect(result.unreconciled.map((r) => r.documentId)).toEqual([ids.payment2]);
    expect(await ledgerFingerprint()).toBe(before);
  });

  it("6. the till-banking and payroll-batch clauses are 6D's and 8C's, and the seam is already open", async () => {
    // 6D and 8C each add ONE registerReconcilableSource call and edit no file of this slice; the
    // reconcilable_kind CHECK already admits both labels (§4.8.3, F-5).
    const [chk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.bank_match'::regclass and conname = 'bank_match_kind_check'`;
    expect(chk!.def).toContain("'till_banking'");
    expect(chk!.def).toContain("'payroll_batch'");
  });
});
```

**The fingerprint uses `sha256(bytea)`, which is built into PostgreSQL 18 — it needs no extension.** `pgcrypto`'s `digest()` would work too (Plan 0A's migration 0001 installs it for the audit chain), but reaching for an extension function where core SQL does the job adds a dependency this test does not need, and `sha256` cannot be dropped by a future migration the way an extension can. The `convert_to(..., 'UTF8')` is required: `sha256` takes `bytea`, and the implicit cast from `text` does not exist.

- [ ] **Step 6: Append the two regression blocks**

`tests/regression/sah-031.test.ts` — "period locks live on a sibling table, are per-privilege-tier, and do not reach the line items". It is 0B's thin file; this slice **appends** the block below and edits no earlier one (§3.7.3). The block needs these imports added at the top of the file, and nothing else in it changes:

```ts
import { Money, currency } from "@dulja/domain";
import {
  importStatement, listStatementLines, match, withTenant as prodWithTenant,
} from "@dulja/db";
import { seedTenantV2, uuidv7 } from "@dulja/db/test";
import { arApFixture, postFromPack } from "../invariants/support/ar-ap";
// `sharedDb` and `repoFile` are already imported by the file (0B, §4.17.1).
```

```ts
describe("SAH-031 Period locks reach the lines, and reconciliation does not touch them — 4B", () => {
  it("a match against a document in a LOCKED period succeeds and that period's ledger rows are byte-identical", async () => {
    // The old system's failure was the opposite: a direct UPDATE on a signed, locked, closed-period
    // voucher changed the amount and silently rewrote AccTotals. Here matching writes only bank_match,
    // so a locked period is irrelevant to it — and that is the correct answer, not a loophole.
    //
    // The tenant is this block's OWN, not the shared `a`/`b` seeds: `arApFixture` calls 3B's
    // `ensureOpenPeriods`, which REOPENS 2026-01..03 (phase-3b:2416-2421), and doing that to a shared
    // seed would break every other regression file that reads `a.lockedPeriod` as locked.
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "sah031-4b");
    const f = await arApFixture(db, s);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };

    // Post the receipt into 2026-03 while it is open…
    const { documentId: receiptId } = await postFromPack(db, s, {
      code: "RECEIPT", effectiveDate: "2026-03-10", partyId: f.partyIds.customer,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, debit:  "400.0000" },
              { kind: "account", accountId: f.accountIds["1200"]!, credit: "400.0000" }],
    });
    // …then LOCK it. This is the old system's exact scenario — a signed, posted, locked-period voucher —
    // and the claim under test is that reconciliation cannot reach it. `db.migrator` as `s.system` is
    // 3B's own form for a fixture period change (phase-3b:2416), because `app_rw`'s grants on
    // app.fiscal_period are not this plan's to assume.
    const [locked] = await prodWithTenant(db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ id: string }[]>`
        update app.fiscal_period set status = 'locked'
         where company_id = ${s.company} and starts_on = '2026-03-01'::date
        returning id`);

    const fingerprint = async () => {
      const [row] = await prodWithTenant(db.rw, ctx, (tx) => tx<{ h: string | null }[]>`
        select md5(string_agg(concat_ws(':', id::text, debit::text, credit::text), '|' order by id)) as h
          from app.ledger_entry where fiscal_period_id = ${locked!.id}`);
      return row!.h;
    };
    const before = await fingerprint();
    expect(before).not.toBeNull();          // the receipt really is IN the locked period

    const { statementId } = await prodWithTenant(db.rw, ctx, (tx) => importStatement(tx, ctx, {
      companyId: s.company, bankAccountId: f.accountIds["1100"]!,
      csv: "2026-03-10,RECEIPT CUST-1,RCT,400.00",
      mapping: { statement: { statementDate: "2026-03-31", openingBalance: "0.0000", closingBalance: "400.0000" },
                 columns: { valueDate: 0, description: 1, reference: 2, amount: 3 },
                 dateFormat: "YYYY-MM-DD", hasHeader: false },
    }));
    const lines = await prodWithTenant(db.rw, ctx, (tx) =>
      listStatementLines(tx, { statementId, limit: 10 }));
    const { matchId } = await prodWithTenant(db.rw, ctx, (tx) => match(tx, ctx, {
      statementLineId: lines[0]!.id,
      reconcilable: { kind: "receipt", documentId: receiptId },
      amount: Money.of("400.0000", currency("MYR")),
    }));

    // The match row exists and is live — the lock did not refuse it, because no lock reaches bank_match.
    const [row] = await prodWithTenant(db.rw, ctx, (tx) => tx<{ unmatched_at: string | null }[]>`
      select unmatched_at from app.bank_match where id = ${matchId}`);
    expect(row!.unmatched_at).toBeNull();

    // …and not one byte of the locked period's ledger moved.
    expect(await fingerprint()).toBe(before);
  });

  it("the reconciliation module names no ledger, projection or document write at all", () => {
    const source = repoFile("packages/db/src/ar-ap/reconciliation.ts");
    for (const forbidden of ["insert into app.ledger_entry", "update app.ledger_entry",
                             "update app.account_balance", "update app.document ",
                             "delete from app."]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
```

`tests/regression/sah-041.test.ts` — "documents are hard-deleted and the anti-tampering controls are shipped disabled":

```ts
describe("SAH-041 Nothing in reconciliation is deleted, and no control is optional — 4B", () => {
  it("app_rw holds no DELETE on any of this slice's five tables", async () => {
    const { rw } = await sharedDb();
    const rows = await rw<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type = 'DELETE'
         and table_name in ('party_ageing', 'item_profitability', 'bank_statement',
                            'bank_statement_line', 'bank_match', 'pdc')`;
    expect(rows).toEqual([]);
  });

  it("§3.5.4's pinned DELETE list is exactly its five rows after this slice", async () => {
    const { rw } = await sharedDb();
    const rows = await rw<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type = 'DELETE'
       order by table_name`;
    expect([...new Set(rows.map((r) => r.table_name))])
      .toEqual(["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]);
  });

  it("both unmatch columns move together, so an unmatched row with no actor is unrepresentable", async () => {
    const { rw } = await sharedDb();
    const [chk] = await rw<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.bank_match'::regclass and conname = 'bank_match_unmatch_pair_check'`;
    expect(chk!.def).toContain("unmatched_by");
  });
});
```

- [ ] **Step 7: Write the runbook**

`docs/runbooks/bank-reconciliation.md` — the monthly procedure, so the operator's steps are written down once rather than implied by an API:

```markdown
# Runbook — monthly bank reconciliation

**Who:** a principal holding `accounting.bank.reconcile` (the `accountant` role).
**When:** after every bank statement arrives; before the period is closed.

1. **Export the statement as CSV** from the bank. Note the statement date and the printed opening and
   closing balances — the import needs all three and refuses a file that does not add up.
2. **`POST /v1/companies/{companyId}/bank-statements`** with the CSV, the bank account and the mapping.
   A refusal naming a difference means either the mapping picked the wrong columns or the file is partial.
3. **`GET …/bank-statements/{statementId}/lines?filter[matched][eq]=false`** and match each line against the
   receipt, payment, till banking or payroll batch it corresponds to. A direction refusal
   (`ERR_BANK_MATCH_AMOUNT` naming "money in"/"money out") means the line's sign and the kind disagree.
4. **`GET …/bank-statements/reconciliation?filter[bank_account_id][eq]=…&filter[as_of][eq]=…`.** `statement` must equal `ledger` and
   `unreconciled` and `unmatchedLines` must both be empty. Anything left is either a genuine timing
   difference (an item that will clear next month — leave it) or a missing document (post it).
5. **A wrong match is unmatched, never deleted.** `POST …/bank-statements/matches/{matchId}/unmatch` with
   a reason; the row survives with `unmatched_at` set and the audit log keeps both images.
6. **Nothing in steps 1–5 changes a ledger entry.** If a figure in the ledger is wrong, the remedy is a
   reversal in an open period (spec:2224) — never an edit, and never a "correcting" match.
```

- [ ] **Step 8: Run everything to green**

```bash
bun run --cwd packages/db test -- ar-ap/bank-match
bun run --cwd tests test -- invariants/test-39-bank-reconciliation
bun run --cwd tests test -- regression/sah-031 regression/sah-041
bun run --cwd packages/db test -- privileges
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
```

- [ ] **Step 9: Commit**

```bash
git add packages/db/migrations/0050_create_bank_match.sql packages/db/migrations/0050.down.sql \
        packages/db/src/schema/bank-match.ts packages/db/src/ar-ap/reconciliation.ts \
        packages/db/src/ar-ap/index.ts packages/contracts/src/errors.ts \
        packages/contracts/src/accounting/bank.ts docs/runbooks/bank-reconciliation.md \
        packages/db/test/ar-ap/bank-match.test.ts \
        tests/invariants/test-39-bank-reconciliation.test.ts \
        tests/regression/sah-031.test.ts tests/regression/sah-041.test.ts
git commit -m "feat(db): bank_match, the Reconcilable registry and acceptance test 39 [4B T7]

The second half of the Phase 4 DoD. A match is a row in app.bank_match and nothing else: test 39
clause 4 takes a per-document sha256 of every tamperable ledger_entry column before the first
match and asserts it byte-identical after the last unmatch, which is SAH-031 and SAH-041 stated
as a test rather than as a promise.

4B registers the receipt and payment sources itself — §4.8.3 assigns them to 4A, which had no
file to register into, because reconciliation.ts is in this slice's range. 6D and 8C each add one
registerReconcilableSource call and edit no file here; the reconcilable_kind CHECK already admits
both labels. A source lists from the LEDGER's bank leg, not a document total, so it works for a
receipt banked into any account and gives 6D and 8C a shape they can copy.

bank_match carries BOTH stamps, as §4.8.3 requires and as the stamp_actor linter rule forces.
ERR_BANK_MATCH_AMOUNT lands in ERRORS in this PR, the one that raises it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The bank-reconciliation route module, its one `PROBES` key, and the unreconciled endpoint

**This slice's only new `RouteModule`, and therefore its only new `PROBES` key** (hazard 31). Six sub-paths on one mount prefix; the ageing report is a `GET` on 1B's module (Task 3) and the revaluation a `POST` on 1A's (Task 5), so neither needs a probe of its own.

**Files:**
- Modify: `apps/api/src/routes/accounting/bank-statements.ts` (Task 2 created it with `BANK_PERMISSION`; this fills it), `apps/api/src/routes/index.ts` (`buildRoutes` gains one module), `packages/contracts/src/accounting/bank.ts` (the match schemas), `tests/invariants/probes.ts` (one `PROBES` key)
- Create: `apps/api/test/routes/accounting/bank-statements.test.ts`

**Interfaces**

- Consumes: `importStatement`, `listStatements`, `listStatementLines`, `match`, `unmatch`, `reconciledBalance`, `unmatchedStatementLines`, `Reconcilable`, **`ImportError`**, **`BankMatchError`** (Tasks 6, 7 — both re-exported from `packages/db/src/ar-ap/index.ts` so `instanceof` can name them); `BANK_PERMISSION` (Task 2); `RouteModule`, `buildRoutes`, `IdempotencyHeader`, `createApp` (§4.2.7); `requirePermission` (§4.2.5); `AppError` (§4.2.4 — the only thing `rethrowAsAppError` constructs); `parseFilters`, `FilterClause`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `MoneySchema`, `ProblemSchema`, `encodeCursor` (§4.2.8); `Money`, `currency` (§4.2.1); `startApi`, `ApiRequest` (§4.2.12); `IsolationProbe`, `PROBES` (§4.2.7).
- Produces: `bankStatementRoutes`, `bankStatementRouteModule` (path `/v1/companies/:companyId/bank-statements`, `permissions: [BANK_PERMISSION.reconcile]`, `auth: "human"`), the six sub-paths, the private `requiredFilter` and `rethrowAsAppError`, and `PROBES["/v1/companies/:companyId/bank-statements"]`. Contracts: `ReconcilableKindSchema`, `CreateBankMatchBody`, `BankMatchSchema`, `UnmatchBody`, `ReconcilableSchema`, `ReconciledBalanceSchema` and the three DTO aliases `BankMatchDto`, `ReconcilableDto`, `ReconciledBalanceDto`. **`apps/api/src/problem.ts` is NOT modified** — see `rethrowAsAppError`.

| Method and sub-path | Body / query | Gate |
|---|---|---|
| `POST …/bank-statements` | `ImportStatementBody` | `accounting.bank.reconcile` |
| `GET …/bank-statements` | `ListQuery`, optional `filter[bank_account_id][eq]` through `parseFilters` | `accounting.bank.reconcile` |
| `GET …/bank-statements/{statementId}/lines` | `BankStatementLineQuery` (`filter[matched][eq]`, a literal key) | `accounting.bank.reconcile` |
| `POST …/bank-statements/{statementId}/lines/{lineId}/matches` | `CreateBankMatchBody` | `accounting.bank.reconcile` |
| `POST …/bank-statements/matches/{matchId}/unmatch` | `UnmatchBody` | `accounting.bank.reconcile` |
| `GET …/bank-statements/reconciliation` | `filter[bank_account_id][eq]` and `filter[as_of][eq]`, both REQUIRED | `accounting.bank.reconcile` |

**Gating a `GET` with a mutating code is legal and deliberate.** R7 (`assertRouteGates`, §3.6.3) refuses an *unsafe* method gated by a `mutating: false` code, never the reverse; §4.16.1 makes the same choice for 7C's `accounting.unreconciled_items` ("mutating-gated by design: only a reconciler sees it").

- [ ] **Step 1: Write the failing route test**

`apps/api/test/routes/accounting/bank-statements.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES } from "@dulja/api";
import { startApi, type StartedApi } from "../../support/app";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { arApFixture, postFromPack, type ArApFixture } from "../../../../../tests/invariants/support/ar-ap";
import { grantAdmin } from "../../../../../tests/support/api";

let api: StartedApi;
let s: Seed;
let f: ArApFixture;
let receiptId: string;

const CSV = ["Date,Narrative,Ref,Amount", "2026-01-05,RECEIPT,R1,900.00"].join("\n");
const MAPPING = {
  statement: { statementDate: "2026-01-31", openingBalance: "0.0000", closingBalance: "900.0000" },
  columns: { valueDate: "Date", description: "Narrative", reference: "Ref", amount: "Amount" },
  dateFormat: "YYYY-MM-DD" as const, hasHeader: true,
};

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "bankapi");
  f = await arApFixture(api.db, s);
  await grantAdmin(api, s);
  ({ documentId: receiptId } = await postFromPack(api.db, s, {
    code: "RECEIPT", effectiveDate: "2026-01-05", partyId: f.partyIds.customer,
    lines: [{ kind: "account", accountId: f.accountIds["1100"]!, debit:  "900.0000" },
            { kind: "account", accountId: f.accountIds["1200"]!, credit: "900.0000" }],
  }));
}, 300_000);
afterAll(async () => { await api?.stop(); });

describe("the bank-statements route module (§4.2.7)", () => {
  it("is registered once, on its own path, with the one gate code", () => {
    const mounted = ROUTES.filter((m) => m.path === "/v1/companies/:companyId/bank-statements");
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.permissions).toEqual(["accounting.bank.reconcile"]);
    expect(mounted[0]!.auth).toBe("human");
  });

  it("imports, lists, matches, unmatches and reports the reconciliation", async () => {
    const imported = await api.request({ method: "POST", path: `/v1/companies/${s.company}/bank-statements`,
      as: s.human, body: { bankAccountId: f.accountIds["1100"], csv: CSV, mapping: MAPPING } });
    expect(imported.status).toBe(201);
    const { statementId } = await imported.json() as { statementId: string };

    const lines = await api.request({ method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/bank-statements/${statementId}/lines` });
    const { items } = await lines.json() as { items: { id: string; amount: string }[] };
    expect(items).toHaveLength(1);

    const matched = await api.request({ method: "POST", as: s.human,
      path: `/v1/companies/${s.company}/bank-statements/${statementId}/lines/${items[0]!.id}/matches`,
      body: { kind: "receipt", documentId: receiptId, amount: { amount: "900.0000", currency: "MYR" } } });
    expect(matched.status).toBe(201);
    const { matchId } = await matched.json() as { matchId: string };

    const recon = await api.request({ method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/bank-statements/reconciliation` +
            `?filter[bank_account_id][eq]=${f.accountIds["1100"]}&filter[as_of][eq]=2026-01-31` });
    const body = await recon.json() as { statement: { amount: string }; ledger: { amount: string };
                                         unreconciled: unknown[]; unmatchedLines: unknown[] };
    expect(body.statement.amount).toBe("900.0000");
    expect(body.ledger.amount).toBe("900.0000");
    expect(body.unreconciled).toEqual([]);
    expect(body.unmatchedLines).toEqual([]);

    const undone = await api.request({ method: "POST", as: s.human,
      path: `/v1/companies/${s.company}/bank-statements/matches/${matchId}/unmatch`,
      body: { reason: "wrong line" } });
    expect(undone.status).toBe(204);
  });

  it("an over-match is a 422 ERR_BANK_MATCH_AMOUNT problem+json", async () => {
    const list = await api.request({ method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/bank-statements` });
    const { items } = await list.json() as { items: { id: string }[] };
    const lines = await api.request({ method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/bank-statements/${items[0]!.id}/lines` });
    const line = ((await lines.json()) as { items: { id: string }[] }).items[0]!;
    const res = await api.request({ method: "POST", as: s.human,
      path: `/v1/companies/${s.company}/bank-statements/${items[0]!.id}/lines/${line.id}/matches`,
      body: { kind: "receipt", documentId: receiptId, amount: { amount: "5000.0000", currency: "MYR" } } });
    expect(res.status).toBe(422);
    const problem = await res.json() as { code: string; type: string };
    expect(problem.code).toBe("ERR_BANK_MATCH_AMOUNT");
    expect(problem.type).toBe("urn:dulja:error:ERR_BANK_MATCH_AMOUNT");
  });

  it("every unsafe method requires Idempotency-Key (spec:2055)", async () => {
    const res = await api.request({ method: "POST", path: `/v1/companies/${s.company}/bank-statements`,
      as: s.human, idempotencyKey: null,
      body: { bankAccountId: f.accountIds["1100"], csv: CSV, mapping: MAPPING } });
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("a principal without accounting.bank.reconcile gets 403 on every sub-path", async () => {
    const bare = await seedTenantV2(api.db, "bankapi-bare");
    await api.loadPrincipals();
    for (const path of ["", "/reconciliation"]) {
      const res = await api.request({ method: "GET", as: bare.human,
        path: `/v1/companies/${bare.company}/bank-statements${path}` });
      expect(res.status).toBe(403);
    }
  });
});
```

- [ ] **Step 2: Run it, see the failure, then fill the route file**

```bash
bun run --cwd apps/api test -- accounting/bank-statements
```

Expected: `AssertionError: expected [] to have a length of 1 but got +0` on the first case (nothing is mounted yet), then 404s.

`apps/api/src/routes/accounting/bank-statements.ts` — the `BANK_PERMISSION` constant Task 2 added stays exactly as it is; the router, the six routes and the module are appended:

```ts
// The imports this appended block adds. Task 2 created the file with `BANK_PERMISSION` and therefore
// already has `PERMISSION`; the `OpenAPIHono` / `createRoute` / `z`, `AppEnv`, `RouteModule`,
// `IdempotencyHeader`, `requirePermission` and `Context` imports are the same ones every route module in
// `apps/api/src/routes/` already writes — copy them from the neighbouring `documents.ts` rather than
// guessing a path. **The two lines that are specific to this task:**
//
//   `ImportError` and `BankMatchError` come through the ROOT `@dulja/db` barrel, because Tasks 6 and 7
//   re-export them from `packages/db/src/ar-ap/index.ts`. Without both names here `rethrowAsAppError`
//   cannot be written and every 4xx assertion in Step 1's test arrives as ERR_INTERNAL 500.
import {
  BankMatchError, ImportError, importStatement, listStatementLines, listStatements, match,
  reconciledBalance, unmatch, unmatchedStatementLines,
} from "@dulja/db";
import {
  AppError, ListQuery, ProblemSchema, UuidSchema, parseFilters,
  BankStatementLineList, BankStatementLineQuery, BankStatementList,
  CreateBankMatchBody, ImportStatementBody, ReconciledBalanceSchema, UnmatchBody,
} from "@dulja/contracts";
import { Money } from "@dulja/domain";

export const bankStatementRoutes = new OpenAPIHono<AppEnv>();

const CompanyParams = z.object({ companyId: UuidSchema });
const gate = () => requirePermission(BANK_PERMISSION.reconcile, { company: "path:companyId" });
const problem = (description: string) =>
  ({ content: { "application/problem+json": { schema: ProblemSchema } }, description });

/**
 * The ONE place this module translates a `packages/db` error class into an `AppError`. 3C's route pattern
 * verbatim (phase-3c:4501): both classes carry a `readonly code` that is a literal member of `ErrCode`,
 * so there is no cast and — deliberately — **no branch added to `apps/api/src/problem.ts`**, which is a
 * merge hotspot every slice would otherwise touch. Without this, an unrecognised `Error` reaches 0B's
 * `asAppError` fall-through as `ERR_INTERNAL` 500 and Task 8 Step 1's 422 assertions fail.
 */
function rethrowAsAppError(error: unknown): never {
  if (error instanceof BankMatchError || error instanceof ImportError) {
    throw new AppError(error.code, error.detail);
  }
  throw error;
}

/** One filter reader for the two GETs that need a value from the grammar (§4.2.8 Layer 1: no new flat
 *  parameter, so `bank_account_id` and `as_of` are filter[…][eq] keys). An undeclared field is a 400. */
function requiredFilter(c: Context<AppEnv>, field: string): string {
  const clause = parseFilters(c.req.queries()).find((f) => f.field === field && f.op === "eq");
  if (!clause) {
    throw new AppError("ERR_VALIDATION_FAILED", `filter[${field}][eq] is required on this route`,
      { errors: [{ path: `filter[${field}][eq]`, message: "required" }] });
  }
  return clause.value;
}

bankStatementRoutes.openapi(createRoute({
  method: "post", path: "/",
  request: { params: CompanyParams, headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: ImportStatementBody } } } },
  responses: {
    201: { content: { "application/json": { schema: z.object({ statementId: UuidSchema, lines: z.number().int() }) } },
           description: "the imported statement" },
    400: problem("ERR_VALIDATION_FAILED — the statement does not add up, or the mapping is wrong"),
    403: problem("forbidden"), 409: problem("ERR_CONFLICT_UNIQUE — a statement already exists for that date"),
  },
  middleware: [gate()], tags: ["accounting"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const { bankAccountId, csv, mapping } = c.req.valid("json");
  const result = await c.var.withTenant((tx) =>
    importStatement(tx, c.var.ctx, { companyId, bankAccountId, csv, mapping }))
    .catch(rethrowAsAppError);
  return c.json(result, 201);
});

bankStatementRoutes.openapi(createRoute({
  method: "get", path: "/",
  request: { params: CompanyParams, query: ListQuery },
  responses: { 200: { content: { "application/json": { schema: BankStatementList } }, description: "statements" },
               403: problem("forbidden") },
  middleware: [gate()], tags: ["accounting"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  const bankAccountId = parseFilters(c.req.queries())
    .find((f) => f.field === "bank_account_id" && f.op === "eq")?.value;
  const items = await c.var.withTenant((tx) => listStatements(tx, { companyId, bankAccountId, limit: q.limit }));
  return c.json({ items, next_cursor: null }, 200);
});

bankStatementRoutes.openapi(createRoute({
  method: "get", path: "/{statementId}/lines",
  request: { params: CompanyParams.extend({ statementId: UuidSchema }), query: BankStatementLineQuery },
  responses: { 200: { content: { "application/json": { schema: BankStatementLineList } }, description: "lines" },
               403: problem("forbidden"), 404: problem("ERR_NOT_FOUND") },
  middleware: [gate()], tags: ["accounting"],
}), async (c) => {
  const { statementId } = c.req.valid("param");
  const q = c.req.valid("query");
  // `filter[matched][eq]=false` means "unmatched only" — §4.2.8 Layer 2's literal key, validated by Zod
  // as the two strings `"true"`/`"false"`, so no coercion can turn `"false"` into `true`. Absent means
  // "every line", which is what a reconciliation sheet opens on.
  const matched = q["filter[matched][eq]"];
  const items = await c.var.withTenant((tx) =>
    listStatementLines(tx, { statementId, unmatchedOnly: matched === "false", limit: q.limit }));
  return c.json({ items, next_cursor: null }, 200);
});

bankStatementRoutes.openapi(createRoute({
  method: "post", path: "/{statementId}/lines/{lineId}/matches",
  request: { params: CompanyParams.extend({ statementId: UuidSchema, lineId: UuidSchema }),
             headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: CreateBankMatchBody } } } },
  responses: { 201: { content: { "application/json": { schema: z.object({ matchId: UuidSchema }) } },
                      description: "the match" },
               403: problem("forbidden"),
               422: problem("ERR_BANK_MATCH_AMOUNT — the direction or the amount disagrees") },
  middleware: [gate()], tags: ["accounting"],
}), async (c) => {
  const { lineId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await c.var.withTenant((tx) => match(tx, c.var.ctx, {
    statementLineId: lineId,
    reconcilable: { kind: body.kind, documentId: body.documentId },
    amount: Money.fromJSON(body.amount),
  })).catch(rethrowAsAppError);
  return c.json(result, 201);
});

bankStatementRoutes.openapi(createRoute({
  method: "post", path: "/matches/{matchId}/unmatch",
  request: { params: CompanyParams.extend({ matchId: UuidSchema }), headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: UnmatchBody } } } },
  responses: { 204: { description: "unmatched; the row survives with unmatched_at set (spec:2049)" },
               403: problem("forbidden"), 422: problem("ERR_BANK_MATCH_AMOUNT — already unmatched") },
  middleware: [gate()], tags: ["accounting"],
}), async (c) => {
  const { matchId } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  await c.var.withTenant((tx) => unmatch(tx, c.var.ctx, { matchId, reason }))
    .catch(rethrowAsAppError);
  return c.body(null, 204);
});

bankStatementRoutes.openapi(createRoute({
  method: "get", path: "/reconciliation",
  request: { params: CompanyParams },
  responses: { 200: { content: { "application/json": { schema: ReconciledBalanceSchema } },
                      description: "statement, ledger, the unreconciled items and the unmatched lines" },
               403: problem("forbidden") },
  // A mutating code on a GET is legal under R7, which only refuses an UNSAFE method gated by a
  // non-mutating code — and it is deliberate: §4.16.1 makes the same choice for 7C's
  // accounting.unreconciled_items ("only a reconciler sees it").
  middleware: [gate()], tags: ["accounting"],
}), async (c) => {
  const bankAccountId = requiredFilter(c, "bank_account_id");
  const asOf = requiredFilter(c, "as_of");
  const result = await c.var.withTenant(async (tx) => {
    const balance = await reconciledBalance(tx, { bankAccountId, asOf });
    // reconciledBalance's frozen return has no member for unmatched STATEMENT lines (§4.8.3), so the
    // route composes the two halves rather than widening a registered type (ADR 0048).
    const unmatchedLines = await unmatchedStatementLines(tx, { bankAccountId, asOf });
    return {
      statement: balance.statement.toJSON(),
      ledger: balance.ledger.toJSON(),
      unreconciled: balance.unreconciled.map((r) => ({
        kind: r.kind, documentId: r.documentId, bankAccountId: r.bankAccountId,
        valueDate: r.valueDate, amount: r.amount.toJSON(), reference: r.reference,
      })),
      unmatchedLines,
    };
  });
  return c.json(result, 200);
});

export const bankStatementRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/bank-statements",
  router: bankStatementRoutes,
  permissions: [BANK_PERMISSION.reconcile],
  auth: "human",
};
```

`apps/api/src/routes/index.ts` — the module is added **inside `buildRoutes`** (never by pushing onto `ROUTES`, §4.2.7):

```ts
    bankStatementRouteModule,     // 4B
```

- [ ] **Step 3: The contracts schemas**

Appended to `packages/contracts/src/accounting/bank.ts`:

```ts
export const ReconcilableKindSchema = z.enum(["receipt", "payment", "till_banking", "payroll_batch"]);

export const CreateBankMatchBody = z.object({
  kind: ReconcilableKindSchema,
  documentId: UuidSchema,
  amount: MoneySchema,            // a magnitude; the statement line's sign carries the direction
}).openapi("CreateBankMatchBody");

export const UnmatchBody = z.object({ reason: z.string().min(1).max(500) }).openapi("UnmatchBody");

export const BankMatchSchema = z.object({
  id: UuidSchema, statementLineId: UuidSchema, kind: ReconcilableKindSchema,
  reconcilableDocumentId: UuidSchema, amount: Amount,
  matchedAt: TimestampSchema, unmatchedAt: TimestampSchema.nullable(),
}).openapi("BankMatch");

export const ReconcilableSchema = z.object({
  kind: ReconcilableKindSchema, documentId: UuidSchema, bankAccountId: UuidSchema,
  valueDate: DateSchema, amount: MoneySchema, reference: z.string().nullable(),
}).openapi("Reconcilable");

export const ReconciledBalanceSchema = z.object({
  statement: MoneySchema, ledger: MoneySchema,
  unreconciled: z.array(ReconcilableSchema),
  unmatchedLines: z.array(BankStatementLineSchema),
}).openapi("ReconciledBalance");

// The remaining DTO aliases Task 11's screens import (1B's `TrialBalanceRowDto` convention; Task 6 added
// `BankStatementDto` and `BankStatementLineDto` beside their own schemas). `ReconcilableDto` matters most:
// `Reconcilable` itself is a **packages/db** interface (§4.8.3) and `apps/backoffice` may not reach
// packages/db under §3.1, so the wire shape has to have a name in `@dulja/contracts` or the screen has no
// legal way to spell it.
export type BankMatchDto = z.infer<typeof BankMatchSchema>;
export type ReconcilableDto = z.infer<typeof ReconcilableSchema>;
export type ReconciledBalanceDto = z.infer<typeof ReconciledBalanceSchema>;
```

- [ ] **Step 4: The one `PROBES` key (hazard 31)**

`tests/invariants/probes.ts`:

```ts
  "/v1/companies/:companyId/bank-statements": {
    async seed(db, owner) {
      // The owner imports a statement; the harness then performs this request as the OTHER tenant.
      const f = await arApFixture(db, owner);
      const ctx = { tenantId: owner.tenant, actorId: owner.human, requestId: await uuidv7(db.admin) };
      const { statementId } = await prodWithTenant(db.rw, ctx, (tx) => importStatement(tx, ctx, {
        companyId: owner.company, bankAccountId: f.accountIds["1100"]!,
        csv: "2026-01-05,PROBE,X,10.00",
        mapping: { statement: { statementDate: "2026-01-31", openingBalance: "0.0000", closingBalance: "10.0000" },
                   columns: { valueDate: 0, description: 1, reference: 2, amount: 3 },
                   dateFormat: "YYYY-MM-DD", hasHeader: false },
      }));
      return { path: `/v1/companies/${owner.company}/bank-statements/${statementId}/lines`, method: "GET" };
    },
    expect: 403,
  },
```

- [ ] **Step 5: Run to green and commit**

```bash
bun run --cwd apps/api test -- accounting/bank-statements
bun run --cwd tests test -- invariants/tenant-isolation
bun run --cwd packages/contracts openapi:generate && git diff --exit-code packages/contracts/openapi.json || true
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
```

The OpenAPI regeneration is not optional: CI runs the generator and fails on a diff (§4.2.7), so the six new paths must be committed with the code.

```bash
git add apps/api/src/routes/accounting/bank-statements.ts apps/api/src/routes/index.ts \
        packages/contracts/src/accounting/bank.ts packages/contracts/openapi.json \
        tests/invariants/probes.ts apps/api/test/routes/accounting/bank-statements.test.ts
git commit -m "feat(api): the bank-reconciliation routes, one module, one probe key [4B T8]

This slice's only new RouteModule and therefore its only new PROBES key: the ageing report is a
GET on 1B's reports module and the revaluation a POST on 1A's documents module, so neither needs
one. The reconciliation GET is gated by a MUTATING code, which R7 permits and §4.16.1 already
chose for 7C's accounting.unreconciled_items — only a reconciler sees it.

The reconciliation response composes reconciledBalance with unmatchedStatementLines rather than
widening §4.8.3's frozen return type, which has no member for unmatched statement lines.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: ⚠️ OD-09 — migration 0051 `app.pdc`, the `1150` chart row, and the decision record

**Owner decision OD-09 (§2.12): "Post-dated cheques" — spec:1044, 2479; Part VII #15. Default: NOT BUILT.** This task and Task 10 are the two isolated tasks §2.5's card names, and they are **dropped whole** if the owner says no: migration 0051 and its down, `4b-pdc.json`, `packages/db/src/ar-ap/pdc.ts`, `packages/contracts/src/accounting/pdc.ts`, the two document-type files, `apps/api/src/routes/accounting/pdc.ts`, its `buildRoutes` line, its `PROBES` key, `packages/db/src/schema/pdc.ts`, the two `lint-schema.ts` mentions (there are none — see Step 3) and `packages/db/test/ar-ap/pdc.test.ts`. **Nothing in Tasks 1–8 or 11–12 references any of them**, which is what makes dropping them a deletion rather than a reversal.

**This task also discharges OD-05 for this slice.** OD-05 is "confirmation of every ⚠️ row in §3.0.3 and §3.0.4", and 4B's scope contains exactly **one** ⚠️ row — spec:1044, post-dated cheques — which is OD-09's own subject. One decision, one task, two ids on the record (hazard 6 asks for one task per decision, not one task per id pointing at the same sentence).

**Owner provides:** the answer to Part VII #15's second half — *"does the business collect post-dated cheques"* — and, if yes, the three facts the sentence leaves open (below). **Verify:** `ls -1 docs/owner/od-09/` shows one file and `docs/decisions/od-09-4b-post-dated-cheques.md` records the answer and its date. **Until provided:** nothing is blocked. Tasks 1–8 and 11–12 are complete without this, and Phase 4's definition of done does not mention cheques.

| Question the ⚠️ row leaves open | Assumption if the answer is yes | Where it lives |
|---|---|---|
| Is a cheque in hand an asset of its own, or is it just an unbanked receipt? | **An asset of its own**, `1150` Cheques in hand — spec:1044 says "cheque-in-hand asset with maturity date", and a receipt that is not yet money must not sit in `1100` Bank or the bank reconciliation of Task 7 can never balance | the §4.15 amendment and `PDC_RECEIPT`'s debit (Task 10) |
| Does a bounce reverse the deposit, or the original receipt? | **The deposit** — §4.14's row says "bounce = reversal of the deposit (D13)", so the cheque returns to `in_hand` and the receivable it settled stays settled until the operator unallocates | `bouncePdc` (Task 10) |
| Is there a maturity alarm? | **No job.** `JOBS` is a closed sixteen-name registry (§4.2.6) and adding a seventeenth is an amendment this slice does not make; maturity is a **query** (`listPdc({ maturingBefore })`) and the register is 7C's `accounting.pdc_register` ⚠️ report code | `listPdc` (Task 10) |

**Files (all conditional):**
- Create: `docs/decisions/od-09-4b-post-dated-cheques.md`, `docs/owner/od-09/` (the gate directory)
- Create: `packages/db/migrations/0051_create_pdc.sql`, `packages/db/migrations/0051.down.sql`
- Create: `packages/db/seed/my/chart-of-accounts/4b-pdc.json`, `packages/db/src/schema/pdc.ts`
- Create: `packages/db/test/ar-ap/pdc.test.ts` (the DDL half; Task 10 appends the lifecycle half)

**Interfaces**

- Consumes: `app.tenant`, `app.company`, `app.party` (2A, §4.5.7), `app.document` (plan0A) — the four FK targets; `app_meta.enable_tenant_rls`, `app_meta.attach_audit` (§4.1); `uuidv7` the **SQL** function (plan0A migration 0001, the `default`); the `chart-of-accounts` `PackLoader` and the seed CLI's `--only` flag (0C, §4.2.13, §3.4.8); `NO_ID_TABLES`, `AUDIT_EXEMPT`, `IMMUTABLE` — **read to confirm nothing is added** (§3.5.3's row for `pdc` is dashes in every column); `lintSchema`, `listApplied`, `startDb`, `Db`, `Seed`, the 4-argument test `withTenant` (§4.1); `seedTenantV2` (1A); `readPackFile` (0C).
- Produces:
  - `app.pdc` — the DDL below, exactly, with `pdc_status_check`, `pdc_deposit_pair_check`, `unique (company_id, party_id, cheque_number)`, `unique (tenant_id, id)` and `pdc_maturity_idx`.
  - `packages/db/src/schema/pdc.ts` — the Drizzle mirror `pdc` (§3.4.9: the mirror lands in the same PR as the table and is the diff source for the next change to it).
  - `packages/db/seed/my/chart-of-accounts/4b-pdc.json` — the one §4.15 row `1150` (Task 0 amendment 8).
  - `docs/decisions/od-09-4b-post-dated-cheques.md`.
  - **`packages/db/src/lint-schema.ts` — nothing. See Step 3.**

- [ ] **Step 1: Write the decision record, naming both OD ids**

`docs/decisions/od-09-4b-post-dated-cheques.md`. It decides nothing; it records what was assumed and exactly what is deleted if the answer is no.

```markdown
# OD-09 (and OD-05's spec:1044 row) — post-dated cheques

- Owner decision: **OD-09** (§2.12), spec:1044, spec:2479, Part VII #15.
- Also discharges: **OD-05** for slice 4B. OD-05 is "confirmation of every ⚠️ row in §3.0.3 and §3.0.4";
  4B's scope contains exactly one ⚠️ row, spec:1044, which is OD-09's subject. One decision, one record.
- Status: **pending** as of 2026-09-05. Default: **not built.**

## The row, verbatim (spec:1044)

> **Post-dated cheques** — cheque-in-hand asset with maturity date, deposit and bounce reversal ⚠️
> *(confirm the business collects PDCs)*

## What was assumed, and where each assumption lives

[the three-question table above, copied]

## If the answer is NO

Delete, in this order: `packages/db/test/ar-ap/pdc.test.ts`; `apps/api/test/routes/accounting/pdc.test.ts`;
the `pdcRouteModule` line in `apps/api/src/routes/index.ts` and its `PROBES` key in
`tests/invariants/probes.ts`; `apps/api/src/routes/accounting/pdc.ts`;
`packages/contracts/src/accounting/pdc.ts`; `packages/db/src/ar-ap/pdc.ts` and its export block in
`packages/db/src/ar-ap/index.ts`; `packages/db/seed/my/document-types/PDC_RECEIPT.json` and
`PDC_DEPOSIT.json`; `packages/db/seed/my/chart-of-accounts/4b-pdc.json`;
`packages/db/src/schema/pdc.ts`; `packages/db/migrations/0051_create_pdc.sql` and `0051.down.sql`.
Then strike the §4.14 rows `PDC_RECEIPT`/`PDC_DEPOSIT`, the §4.15 row `1150` and the §4.16.2 `pdc`
`DatasetId` member from the contracts document — §4.16.2 already says the id and the report that reads it
are dropped together — and leave migration 0051 **unused**: §3.4.1 says unused numbers stay unused and
`discover()` sorts whatever exists, so no slice borrows it and nothing renumbers.

**Nothing in Tasks 1–8 or 11–12 imports any of the above**, so this is a deletion, not a reversal.
```

- [ ] **Step 2: Write the failing DDL test, then migration 0051**

`packages/db/test/ar-ap/pdc.test.ts` (the DDL half). Task 10 appends the lifecycle half to the same file.

```ts
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema, listApplied } from "../../src";
import { readPackFile } from "../../src/seed";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";

let db: Db;
let s: Seed;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "pdc");
}, 180_000);
afterAll(async () => { await db?.stop(); });

describe("migration 0051 — app.pdc (⚠️ OD-09, §4.6.1)", () => {
  it("applies as version 51", async () => {
    expect(await listApplied(db.migrator)).toContain(51);
  });

  it("carries the §3.3 binding form: RLS on, FORCE RLS, one policy named exactly tenant_isolation", async () => {
    const [rel] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class where oid = 'app.pdc'::regclass`;
    expect(rel).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await db.admin<{ policyname: string }[]>`
      select policyname from pg_policies where schemaname = 'app' and tablename = 'pdc'`;
    expect(policies.map((p) => p.policyname)).toEqual(["tenant_isolation"]);
  });

  it("has the audit trigger — §3.5.3 grants pdc NO exemption, because a status change is the record", async () => {
    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.pdc'::regclass and not tgisinternal
       order by tgname`;
    expect(triggers.map((t) => t.tgname)).toContain("audit_row");
  });

  it("has a uuidv7 id and a created_at default — it is NOT a natural-key projection", async () => {
    const cols = await db.admin<{ column_name: string; column_default: string | null; is_nullable: string }[]>`
      select column_name, column_default, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'pdc' and column_name in ('id', 'created_at')
       order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(["created_at", "id"]);
    expect(cols.find((c) => c.column_name === "id")!.column_default).toContain("uuidv7()");
    expect(cols.find((c) => c.column_name === "created_at")!.column_default).toContain("now()");
    for (const c of cols) expect(c.is_nullable, c.column_name).toBe("NO");
  });

  it("app_rw may not DELETE it — a bounced cheque is a status, never a deletion (spec:2049, §3.5.4)", async () => {
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'pdc'`;
    expect(grants.filter((g) => g.privilege_type === "DELETE")).toEqual([]);
  });

  it("status is TEXT with a named CHECK, never an enum label (§3.4.4, hazard 11)", async () => {
    const [col] = await db.admin<{ data_type: string; udt_name: string }[]>`
      select data_type, udt_name from information_schema.columns
       where table_schema = 'app' and table_name = 'pdc' and column_name = 'status'`;
    expect(col!.data_type).toBe("text");
    const [chk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.pdc'::regclass and conname = 'pdc_status_check'`;
    for (const label of ["in_hand", "deposited", "cleared", "bounced"]) {
      expect(chk!.def, label).toContain(label);
    }
    // …and the deposit pair: a cleared or bounced cheque must have been deposited.
    const [pair] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.pdc'::regclass and conname = 'pdc_deposit_pair_check'`;
    expect(pair!.def).toContain("deposit_document_id");
  });

  it("lintSchema reports zero violations after 0051", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("a second tenant cannot see this tenant's cheque (spec:106's mandatory clause)", async () => {
    const other = await seedTenantV2(db, "pdc-other");
    const [party] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select id from app.party where company_id = ${s.company} limit 1`);
    const [doc] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select id from app.document where company_id = ${s.company} limit 1`);
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
      insert into app.pdc (tenant_id, company_id, party_id, receipt_document_id, cheque_number,
                           amount, currency, maturity_date)
      values (${s.tenant}, ${s.company}, ${party!.id}, ${doc!.id}, 'CHQ-1', 500, 'MYR', '2026-04-30')`);
    // The owner sees its own row first, so the assertion below is about isolation and not about nothing.
    const mine = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.pdc`);
    expect(mine[0]!.n).toBe(1);
    const theirs = await withTenant(db.rw, other.tenant, other.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.pdc`);
    expect(theirs[0]!.n).toBe(0);
  });

  it("the 1150 chart row is seeded by this slice and only by this slice (§4.15 amendment 8)", () => {
    const rows = readPackFile<{ code: string; nameEn: string; nameAr: string; type: string;
                               parentCode: string }[]>(
      join(process.cwd(), "seed", "my"), "chart-of-accounts", "4b-pdc.json");
    // `parentCode: "1"` is the ASSET GROUP, not the 1100 Bank leaf — see the note under Step 4.
    expect(rows).toEqual([{ code: "1150", nameEn: "Cheques in hand", nameAr: "شيكات تحت التحصيل",
                           type: "asset", parentCode: "1" }]);
    // 0C's own file must NOT have grown a 1150 row: §4.15 allocates it to 4B and hazard 32 makes a
    // second seeder of one code the finding.
    const base = readPackFile<{ code: string }[]>(
      join(process.cwd(), "seed", "my"), "chart-of-accounts", "0c-base.json");
    expect(base.some((r) => r.code === "1150")).toBe(false);
  });
});
```

**Run it and see the exact expected failure before writing the migration:**

```bash
bun run --cwd packages/db test -- ar-ap/pdc
```

Expected: every case fails on `relation "app.pdc" does not exist` (SQLSTATE 42P01) except "applies as version 51", which reports `expected [ …, 50 ] to include 51`, and the chart case, which throws `SeedError: seed pack file chart-of-accounts/4b-pdc.json not found`.

`packages/db/migrations/0051_create_pdc.sql`:

```sql
-- 0051_create_pdc.sql  ⚠️ OD-09 ONLY. If the owner does not confirm that the business collects
-- post-dated cheques, this file is never written and migration 0051 stays unused (§3.4.1).
-- spec:1044 "cheque-in-hand asset with maturity date, deposit and bounce reversal"; contracts §4.6.1.
create table app.pdc (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references app.tenant(id),
  company_id          uuid not null,
  party_id            uuid not null,
  receipt_document_id uuid not null,                      -- the PDC_RECEIPT that debited 1150
  deposit_document_id uuid,                               -- the PDC_DEPOSIT that moved it to 1100
  cheque_number       text not null,
  bank_name           text,
  amount              numeric(19,4) not null check (amount > 0),
  currency            char(3) not null,
  maturity_date       date not null,
  status              text not null default 'in_hand',
  created_at          timestamptz not null default now(),
  constraint pdc_status_check check (status in ('in_hand', 'deposited', 'cleared', 'bounced')),
  -- A bounced or cleared cheque must have been deposited; an in-hand one must not have been.
  constraint pdc_deposit_pair_check
    check ((status = 'in_hand' and deposit_document_id is null)
        or (status <> 'in_hand' and deposit_document_id is not null)),
  unique (company_id, party_id, cheque_number),           -- one cheque number per drawer
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)          references app.company(tenant_id, id),
  foreign key (tenant_id, party_id)            references app.party(tenant_id, id),
  foreign key (tenant_id, receipt_document_id) references app.document(tenant_id, id),
  foreign key (tenant_id, deposit_document_id) references app.document(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.pdc');
call app_meta.attach_audit('app.pdc');                    -- status changes matter; §3.5.3 grants no exemption
create index pdc_maturity_idx on app.pdc (company_id, status, maturity_date);
```

`packages/db/migrations/0051.down.sql`:

```sql
-- 0051.down.sql  ⚠️ OD-09 only.
drop index if exists app.pdc_maturity_idx;
drop table if exists app.pdc;
```

- [ ] **Step 3: `lint-schema.ts` gains nothing, and the Drizzle mirror**

§3.5.3's row for `pdc` has a dash in every column: it keeps its `id`, its `created_at` and its audit trigger and is not immutable. **A plan that adds `pdc` to a set has misread the register** (hazard 13), and the File Structure attributes every `lint-schema.ts` edit in this slice to **T1** for that reason.

```ts
// packages/db/src/schema/pdc.ts  ⚠️ OD-09 only. §3.4.9: the mirror lands in the migration's own PR and is
// the diff source for the next change to this table.
import { char, date, numeric, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const pdc = app.table("pdc", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  partyId: uuid("party_id").notNull(),
  receiptDocumentId: uuid("receipt_document_id").notNull(),
  // Nullable, and the pdc_deposit_pair_check constraint is what ties it to `status`: null exactly when
  // the cheque is still in hand. Drizzle expresses no CHECK, so the mirror must not imply notNull here.
  depositDocumentId: uuid("deposit_document_id"),
  chequeNumber: text("cheque_number").notNull(),
  bankName: text("bank_name"),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  maturityDate: date("maturity_date").notNull(),
  // TEXT, never a Drizzle pgEnum: §3.4.4 forbids adding an enum label and the DDL's named CHECK is the
  // vocabulary. A pgEnum here would make the next status a migration this plan's range cannot hold.
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 4: Seed the chart row**

`packages/db/seed/my/chart-of-accounts/4b-pdc.json` — §4.15's per-slice file layout, applied by this task with `bun run seed --tenant <id> --only chart-of-accounts`:

```json
[
  { "code": "1150", "nameEn": "Cheques in hand", "nameAr": "شيكات تحت التحصيل", "type": "asset", "parentCode": "1" }
]
```

**`parentCode` is `"1"`, the asset GROUP row, and not `"1100"`.** §4.15 registers `1100 Bank` as a **leaf** — the `RECEIPT`/`PAYMENT` bank leg, `bank_statement.bank_account_id`, the POS transfer tender — and says only leaf codes are registered because "group accounts (`is_group = true`) are free to use the same range". 0C's `0c-base.json` ships five group parents, `"1" Assets` among them, and hangs every 1xxx leaf under it (`0c:3872-3882`). Hanging `1150` under `1100` would make the chart tree report two accounts under a node that itself carries a posting balance — the FK to `app.account(tenant_id, parent_id)` permits it, so nothing fails and nothing catches it either. If a future 0C grows a current-assets group in the 11xx range, `1150` moves under that; until then the asset group is the honest parent.

- [ ] **Step 5: Run to green and commit**

```bash
bun run --cwd packages/db test -- ar-ap/pdc
bun run --cwd packages/db test -- privileges
bun run --cwd packages/db db:lint
bun run --cwd packages/db seed -- --tenant "$TENANT_ID" --only chart-of-accounts
```

```bash
git add docs/decisions/od-09-4b-post-dated-cheques.md \
        packages/db/migrations/0051_create_pdc.sql packages/db/migrations/0051.down.sql \
        packages/db/seed/my/chart-of-accounts/4b-pdc.json packages/db/src/schema/pdc.ts \
        packages/db/test/ar-ap/pdc.test.ts
git commit -m "feat(db): app.pdc and the 1150 chart row (OD-09) [4B T9]

Isolated behind OD-09, which also discharges OD-05's spec:1044 row for this slice — one decision,
one record, two ids. The decision record names every file that is deleted if the answer is no, and
nothing in Tasks 1-8 or 11-12 imports any of them.

1150 Cheques in hand is a §4.15 amendment (Task 0 amendment 8), seeded here and only here: a
receipt that is not yet money must not sit in 1100 Bank, or Task 7's reconciliation could never
balance. No maturity JOB: JOBS is a closed sixteen-name registry and maturity is a query.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: ⚠️ OD-09 — `PDC_RECEIPT`, `PDC_DEPOSIT`, the deposit, the bounce reversal and the register read

**The second of OD-09's two isolated tasks.** Dropped with Task 9 if the owner says no.

**Files (all conditional):** `packages/db/seed/my/document-types/PDC_RECEIPT.json`, `PDC_DEPOSIT.json`, `packages/db/src/ar-ap/pdc.ts`, `packages/contracts/src/accounting/pdc.ts`, `apps/api/src/routes/accounting/pdc.ts`; modify `packages/db/src/ar-ap/index.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`, `packages/db/test/ar-ap/pdc.test.ts`; create `apps/api/test/routes/accounting/pdc.test.ts`.

**Interfaces**

- Consumes: `app.pdc` (Task 9); `postDocument`, `reverseDocument` (1A); `resolveFxAccounts` is **not** used (a PDC is a single-currency instrument in this slice); `draftTypedDocument`, `seedTypeFromPack`, `postFromPack` (Task 3); `Money`, `currency` (§4.2.1); `RouteModule`, `IdempotencyHeader`, `requirePermission`, `PERMISSION` (§4.2.5, §4.2.7).
- Produces:
  ```ts
  // packages/db/src/ar-ap/pdc.ts
  export const PDC_ACCOUNT_CODE = "1150" as const;                 // §4.15 amendment 8
  export type PdcStatus = "in_hand" | "deposited" | "cleared" | "bounced";
  export interface PdcRow {
    id: string; partyId: string; chequeNumber: string; bankName: string | null;
    amount: string; currency: string; maturityDate: string; status: PdcStatus;
    receiptDocumentId: string; depositDocumentId: string | null;
  }
  /** Drafts and posts a PDC_RECEIPT (debit 1150, credit the party's control) and its app.pdc row. */
  export async function draftPdcReceipt(
    tx: Sql, ctx: TenantContext,
    input: { companyId: string; partyId: string; chequeNumber: string; bankName?: string;
             amount: Money; maturityDate: string; effectiveDate: string; branchId: string;
             jobs?: JobClient },
  ): Promise<{ pdcId: string; documentId: string }>;
  /** Posts a PDC_DEPOSIT (debit 1100, credit 1150) and moves the row to `deposited`. */
  export async function depositPdc(
    tx: Sql, ctx: TenantContext,
    input: { pdcId: string; bankAccountId: string; effectiveDate: string; jobs?: JobClient },
  ): Promise<{ documentId: string }>;
  /** REVERSES THE DEPOSIT (D13, §4.14's row), returning the cheque to `in_hand`. */
  export async function bouncePdc(
    tx: Sql, ctx: TenantContext, input: { pdcId: string; effectiveDate: string; reason: string; jobs?: JobClient },
  ): Promise<{ reversalDocumentId: string }>;
  export async function listPdc(
    tx: Sql, params: { companyId: string; status?: PdcStatus; maturingBefore?: string; limit: number },
  ): Promise<PdcRow[]>;
  ```

- [ ] **Step 1: The two seed envelopes**

`packages/db/seed/my/document-types/PDC_RECEIPT.json`:

```json
{
  "code": "PDC_RECEIPT",
  "nameEn": "Post-dated cheque received",
  "nameAr": "شيك مؤجل مستلم",
  "module": "accounting",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "PDC_RECEIPT",
    "direction": "inbound",
    "requires": ["party"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "PDC", "assignAt": "issue" },
    "reversal": { "allowed": false, "producesType": null },
    "approval": { "required": false, "approve": null, "post": "accounting.receipt.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

`packages/db/seed/my/document-types/PDC_DEPOSIT.json`:

```json
{
  "code": "PDC_DEPOSIT",
  "nameEn": "Post-dated cheque deposited",
  "nameAr": "إيداع شيك مؤجل",
  "module": "accounting",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "PDC_DEPOSIT",
    "direction": "internal",
    "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "PDD", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "PDC_DEPOSIT" },
    "approval": { "required": false, "approve": null, "post": "accounting.receipt.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

**Five things in these two files that are decisions, not boilerplate.**

**`module` sits outside `policy`.** `posting-policy.schema.json` is `additionalProperties: false` and its `$id` is frozen at `urn:dulja:posting-policy:1` (§4.4.1, hazard 34), so an envelope-level field inside `policy` fails validation. `module: "accounting"` is §4.14's value for both rows.

**`PDC_RECEIPT` declares `reversal.allowed: false`.** A cheque in hand is not undone by reversing the receipt — it is undone by the cheque *bouncing*, and a bounce reverses the **deposit** (§4.14's row for `PDC_DEPOSIT`). Allowing a direct reversal would give an operator two ways to unwind one instrument, and the second one leaves `app.pdc.status` describing a document that no longer exists. Step 2's last case asserts the refusal.

**`PDC_DEPOSIT` declares `reversal.allowed: true, producesType: "PDC_DEPOSIT"`.** This is what makes `bouncePdc` a *call to 1A's `reverseDocument`* rather than new posting code — D13's machinery, unchanged (§4.14). The reversing document is itself a `PDC_DEPOSIT`, so the series and the approval code do not change on the way back.

**`requires` differs between them, and deliberately.** `PDC_RECEIPT` requires `party` because it credits that party's control account and the ageing must see it. `PDC_DEPOSIT` requires nothing and is `direction: "internal"`, because a deposit moves money between two of the company's own accounts — which is also why `draftAndPostPdc` writes `party_id` null for it (see Step 3's note).

**Neither policy names an `account: { code }` literal.** Both address `line.account`, exactly as `FX_REVALUATION` does: the drafting service resolves `1150`, `1100` and the party's control account and writes `document_line.account_id`. Hazard 33 is discharged by resolution that fails closed (Step 3's `resolvePdcAccounts`), never by a literal in a policy that no code checks.

- [ ] **Step 2: Write the failing lifecycle test**

Appended to `packages/db/test/ar-ap/pdc.test.ts`:

```ts
describe("the PDC lifecycle (spec:1044, §4.14)", () => {
  let pdcId = "";

  it("a PDC_RECEIPT debits 1150 and credits the party's control account — never 1100", async () => {
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const result = await prodWithTenant(db.rw, ctx, (tx) => draftPdcReceipt(tx, ctx, {
      companyId: s.company, partyId: f.partyIds.customer, chequeNumber: "CHQ-001",
      bankName: "Test Bank", amount: Money.of("5000.0000", MYR),
      maturityDate: "2026-03-15", effectiveDate: "2026-01-15", branchId: s.hq }));
    pdcId = result.pdcId;
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, le.debit::text, le.credit::text
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.document_id = ${result.documentId} order by a.code`;
      expect(rows).toEqual([
        { code: "1150", debit: "5000.0000", credit: "0.0000" },
        { code: "1200", debit: "0.0000", credit: "5000.0000" },
      ]);
      const [row] = await tx<{ status: string; maturity_date: string }[]>`
        select status, maturity_date::text from app.pdc where id = ${pdcId}`;
      expect(row).toMatchObject({ status: "in_hand", maturity_date: "2026-03-15" });
    });
  });

  it("the cheque in hand does NOT appear in the bank reconciliation before it is deposited", async () => {
    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reconciledBalance(tx, { bankAccountId: f.accountIds["1100"]!, asOf: "2026-01-31" }));
    expect(result.ledger.toString()).toBe("0.0000");
    expect(result.unreconciled).toEqual([]);
  });

  it("depositPdc debits 1100, credits 1150 and moves the row to `deposited`", async () => {
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const { documentId } = await prodWithTenant(db.rw, ctx, (tx) => depositPdc(tx, ctx, {
      pdcId, bankAccountId: f.accountIds["1100"]!, effectiveDate: "2026-03-16" }));
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, le.debit::text, le.credit::text
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.document_id = ${documentId} order by a.code`;
      expect(rows).toEqual([
        { code: "1100", debit: "5000.0000", credit: "0.0000" },
        { code: "1150", debit: "0.0000", credit: "5000.0000" },
      ]);
      const [row] = await tx<{ status: string }[]>`select status from app.pdc where id = ${pdcId}`;
      expect(row!.status).toBe("deposited");
    });
  });

  it("a bounce REVERSES THE DEPOSIT (D13) and returns the cheque to `in_hand`", async () => {
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const { reversalDocumentId } = await prodWithTenant(db.rw, ctx, (tx) => bouncePdc(tx, ctx, {
      pdcId, effectiveDate: "2026-03-20", reason: "returned unpaid" }));
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ status: string; deposit_document_id: string | null }[]>`
        select status, deposit_document_id::text from app.pdc where id = ${pdcId}`;
      // The receivable it settled STAYS settled: unallocating is the operator's separate decision.
      expect(row).toMatchObject({ status: "in_hand", deposit_document_id: null });
      const [reversal] = await tx<{ reverses_document_id: string | null }[]>`
        select reverses_document_id::text from app.document where id = ${reversalDocumentId}`;
      expect(reversal!.reverses_document_id).not.toBeNull();
      const [bank] = await tx<{ base: string }[]>`
        select coalesce(sum(base_debit) - sum(base_credit), 0)::text as base
          from app.account_balance where account_id = ${f.accountIds["1100"]}`;
      expect(bank!.base).toBe("0.0000");
    });
  });

  it("a PDC_RECEIPT cannot be reversed directly — its policy declares reversal.allowed false", async () => {
    const [receipt] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select receipt_document_id as id from app.pdc where id = ${pdcId}`);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    await expect(prodWithTenant(db.rw, ctx, (tx) => reverseDocument(tx, ctx, {
      documentId: receipt!.id, effectiveDate: "2026-03-21", reason: "should be refused" })))
      .rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL|reversal/);
  });

  it("listPdc answers the maturity question without a job (JOBS is closed — §4.2.6)", async () => {
    const due = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listPdc(tx, { companyId: s.company, status: "in_hand", maturingBefore: "2026-04-01", limit: 50 }));
    expect(due.map((p) => p.chequeNumber)).toEqual(["CHQ-001"]);
    const none = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listPdc(tx, { companyId: s.company, status: "in_hand", maturingBefore: "2026-01-01", limit: 50 }));
    expect(none).toEqual([]);
  });
});
```

- [ ] **Step 3: Write `packages/db/src/ar-ap/pdc.ts`**

```ts
// packages/db/src/ar-ap/pdc.ts
//
// Slice 4B, OD-09. Post-dated cheques. Deleted whole with Task 9 if the owner says no.
//
// The shape is fx.ts's, for fx.ts's reason: resolve every account by code and FAIL CLOSED, draft
// app.document + app.document_line, hand over to 1A's frozen postDocument, and only then write the
// instrument's own row. Nothing here touches a ledger, movement or projection table (hazard 22).
//
// The one idea worth stating: a cheque in hand is 1150, NOT 1100. That is the whole point of the
// feature. Until the cheque is banked it is not money in the bank, so Task 7's reconciliation cannot
// see it (Step 2's second case asserts exactly that), and no bank statement will ever carry a line for
// it. The legacy system posted cheques straight to the bank account and its reconciliation never
// balanced in a month that had any (Part VII #15).
import type { Money, CurrencyCode } from "@dulja/domain";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import type { JobClient } from "../jobs/enqueue";
import { PostingError } from "../posting/errors";
import { postDocument, reverseDocument } from "../posting";

export const PDC_ACCOUNT_CODE = "1150" as const;                 // §4.15 amendment 8
export const PDC_RECEIPT_CODE = "PDC_RECEIPT" as const;
export const PDC_DEPOSIT_CODE = "PDC_DEPOSIT" as const;

export type PdcStatus = "in_hand" | "deposited" | "cleared" | "bounced";

export interface PdcRow {
  id: string; partyId: string; chequeNumber: string; bankName: string | null;
  amount: string; currency: string; maturityDate: string; status: PdcStatus;
  receiptDocumentId: string; depositDocumentId: string | null;
}

interface PdcAccounts { chequesInHandId: string; controlAccountId: string }

/**
 * `1150` and the party's own control account. Fails closed on either (hazard 33): a null account_id
 * would post a line to nowhere, and a FALLBACK to 1100 would be the legacy defect this feature exists
 * to remove. The party's control account comes from the party, never from a code literal, because 4A
 * lets a party override it (§4.5.7) and a second definition here would silently ignore the override.
 */
async function resolvePdcAccounts(tx: Sql, companyId: string, partyId: string): Promise<PdcAccounts> {
  const [cheques] = await tx<{ id: string }[]>`
    select id from app.account where company_id = ${companyId} and code = ${PDC_ACCOUNT_CODE}`;
  if (!cheques) {
    throw new PostingError("ERR_POLICY_REQUIRES_MISSING",
      `company ${companyId} cannot resolve account code ${PDC_ACCOUNT_CODE} ` +
      `(§4.15 amendment 8: seeded by 4B in chart-of-accounts/4b-pdc.json — apply the seed pack)`);
  }
  const [party] = await tx<{ kind: string; receivable_account_id: string | null;
                             payable_account_id: string | null }[]>`
    select kind, receivable_account_id, payable_account_id
      from app.party where id = ${partyId} and company_id = ${companyId}`;
  if (!party) {
    throw new PostingError("ERR_NOT_FOUND", `party ${partyId} not found in company ${companyId}`);
  }
  const controlAccountId = party.kind === "vendor" ? party.payable_account_id : party.receivable_account_id;
  if (!controlAccountId) {
    throw new PostingError("ERR_POLICY_REQUIRES_MISSING",
      `party ${partyId} (kind ${party.kind}) has no ` +
      `${party.kind === "vendor" ? "payable" : "receivable"}_account_id (§4.5.7)`);
  }
  return { chequesInHandId: cheques.id, controlAccountId };
}

interface PdcLine { accountId: string; debit: string; credit: string; description: string }

/**
 * Drafts one PDC document and posts it. The ONLY place this module writes a document.
 *
 * `partyId` is passed through as given, and the two callers differ: a PDC_RECEIPT carries its party
 * (it credits that party's control account, and app.party_ageing_rows must see it as reducing the open
 * balance), while a PDC_DEPOSIT passes NULL — a deposit moves money between two of the company's own
 * accounts, and a party_id on it would appear in the ageing as an open item of exactly the cheque's
 * value, double-counting the instrument. This is the same trap ADR 0047 documents for FX documents.
 */
async function draftAndPostPdc(
  tx: Sql, ctx: TenantContext,
  input: { companyId: string; typeCode: string; series: string; branchId: string; currency: string;
           effectiveDate: string; partyId: string | null; lines: readonly PdcLine[]; jobs?: JobClient },
): Promise<string> {
  const [type] = await tx<{ id: string }[]>`
    select id from app.document_type where code = ${input.typeCode}`;
  if (!type) {
    throw new PostingError("ERR_POLICY_NOT_FOUND",
      `document type ${input.typeCode} is not configured for this tenant ` +
      `(seed pack document-types/${input.typeCode}.json)`);
  }
  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       rate_source, party_id, branch_id)
    values (app.current_tenant(), ${input.companyId}, ${type.id}, ${input.series},
            ${input.effectiveDate}::date, ${input.currency}, 1, ${"derived:pdc"},
            ${input.partyId}, ${input.branchId})
    returning id`;
  let lineNo = 0;
  for (const l of input.lines) {
    lineNo += 1;
    await tx`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, description, account_id, debit, credit)
      values (app.current_tenant(), ${input.companyId}, ${doc!.id}, ${lineNo}, 'account',
              ${l.description}, ${l.accountId}, ${l.debit}, ${l.credit})`;
  }
  await postDocument(tx, ctx, { documentId: doc!.id, jobs: input.jobs });
  return doc!.id;
}

/** Drafts and posts a PDC_RECEIPT (debit 1150, credit the party's control) and its app.pdc row. */
export async function draftPdcReceipt(
  tx: Sql, ctx: TenantContext,
  input: { companyId: string; partyId: string; chequeNumber: string; bankName?: string;
           amount: Money<CurrencyCode>; maturityDate: string; effectiveDate: string; branchId: string;
           jobs?: JobClient },
): Promise<{ pdcId: string; documentId: string }> {
  if (!input.amount.isPositive()) {
    throw new PostingError("ERR_VALIDATION_FAILED",
      `a post-dated cheque's amount must be positive (got ${input.amount.toString()})`);
  }
  if (input.maturityDate <= input.effectiveDate) {
    // The whole instrument is defined by maturing LATER. A cheque dated today is an ordinary receipt
    // and belongs on 4A's RECEIPT path, where it hits the bank account immediately.
    throw new PostingError("ERR_VALIDATION_FAILED",
      `maturity_date ${input.maturityDate} must be after effective_date ${input.effectiveDate}: ` +
      `a cheque maturing today is an ordinary RECEIPT (4A), not a post-dated cheque`);
  }
  const accounts = await resolvePdcAccounts(tx, input.companyId, input.partyId);
  const magnitude = input.amount.toString();
  const description = `PDC ${input.chequeNumber} maturing ${input.maturityDate}`;
  const documentId = await draftAndPostPdc(tx, ctx, {
    companyId: input.companyId, typeCode: PDC_RECEIPT_CODE, series: "PDC",
    branchId: input.branchId, currency: input.amount.currency, effectiveDate: input.effectiveDate,
    partyId: input.partyId, jobs: input.jobs,
    lines: [
      { accountId: accounts.chequesInHandId, debit: magnitude, credit: "0.0000", description },
      { accountId: accounts.controlAccountId, debit: "0.0000", credit: magnitude, description },
    ],
  });
  const [row] = await tx<{ id: string }[]>`
    insert into app.pdc
      (tenant_id, company_id, party_id, cheque_number, bank_name, amount, currency,
       maturity_date, status, receipt_document_id)
    values (app.current_tenant(), ${input.companyId}, ${input.partyId}, ${input.chequeNumber},
            ${input.bankName ?? null}, ${magnitude}, ${input.amount.currency},
            ${input.maturityDate}::date, 'in_hand', ${documentId})
    returning id`;
  return { pdcId: row!.id, documentId };
}

/**
 * Locks the row, then posts a PDC_DEPOSIT (debit the bank account, credit 1150).
 *
 * `for update` is not decoration: two operators banking the same cheque in overlapping transactions
 * would otherwise both read `in_hand`, both post, and the cheque would appear in the bank twice. The
 * lock makes the second one read `deposited` and refuse.
 */
export async function depositPdc(
  tx: Sql, ctx: TenantContext,
  input: { pdcId: string; bankAccountId: string; effectiveDate: string; jobs?: JobClient },
): Promise<{ documentId: string }> {
  const [pdc] = await tx<{ company_id: string; amount: string; currency: string; status: PdcStatus;
                           cheque_number: string; branch_id: string | null }[]>`
    select p.company_id, p.amount::text, p.currency, p.status, p.cheque_number,
           d.branch_id
      from app.pdc p
      join app.document d on d.id = p.receipt_document_id
     where p.id = ${input.pdcId}
       for update of p`;
  if (!pdc) throw new PostingError("ERR_NOT_FOUND", `pdc ${input.pdcId} not found`);
  if (pdc.status !== "in_hand") {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL",
      `pdc ${input.pdcId} is ${pdc.status}; only a cheque in_hand can be deposited`);
  }
  const [cheques] = await tx<{ id: string }[]>`
    select id from app.account where company_id = ${pdc.company_id} and code = ${PDC_ACCOUNT_CODE}`;
  if (!cheques) {
    throw new PostingError("ERR_POLICY_REQUIRES_MISSING",
      `company ${pdc.company_id} cannot resolve account code ${PDC_ACCOUNT_CODE} (§4.15 amendment 8)`);
  }
  const description = `Deposit of PDC ${pdc.cheque_number}`;
  const documentId = await draftAndPostPdc(tx, ctx, {
    companyId: pdc.company_id, typeCode: PDC_DEPOSIT_CODE, series: "PDD",
    branchId: pdc.branch_id!, currency: pdc.currency, effectiveDate: input.effectiveDate,
    partyId: null, jobs: input.jobs,
    lines: [
      { accountId: input.bankAccountId, debit: pdc.amount, credit: "0.0000", description },
      { accountId: cheques.id, debit: "0.0000", credit: pdc.amount, description },
    ],
  });
  await tx`
    update app.pdc set status = 'deposited', deposit_document_id = ${documentId}
     where id = ${input.pdcId}`;
  return { documentId };
}

/**
 * REVERSES THE DEPOSIT (D13, §4.14's row) and returns the cheque to `in_hand`.
 *
 * Two things it deliberately does NOT do. It does not reverse the receipt — `PDC_RECEIPT` declares
 * `reversal.allowed: false`, and the cheque still exists as a claim on the party. And it does not
 * unallocate whatever receivable the receipt settled: that is the operator's separate decision through
 * 4A's `unallocate`, made with knowledge this function does not have (whether the customer will
 * re-issue, whether it goes to collections). Deciding it here would be the SAH-013 mistake — a
 * reversal reading current state and acting on it.
 */
export async function bouncePdc(
  tx: Sql, ctx: TenantContext,
  input: { pdcId: string; effectiveDate: string; reason: string; jobs?: JobClient },
): Promise<{ reversalDocumentId: string }> {
  const [pdc] = await tx<{ status: PdcStatus; deposit_document_id: string | null }[]>`
    select status, deposit_document_id::text from app.pdc where id = ${input.pdcId} for update`;
  if (!pdc) throw new PostingError("ERR_NOT_FOUND", `pdc ${input.pdcId} not found`);
  if (pdc.status !== "deposited" || !pdc.deposit_document_id) {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL",
      `pdc ${input.pdcId} is ${pdc.status}; only a deposited cheque can bounce ` +
      `(a cheque in_hand has not been presented to a bank and cannot be returned by one)`);
  }
  const reversal = await reverseDocument(tx, ctx, {
    documentId: pdc.deposit_document_id,
    effectiveDate: input.effectiveDate,
    reason: `PDC bounced: ${input.reason}`,
  });
  await tx`
    update app.pdc set status = 'in_hand', deposit_document_id = null where id = ${input.pdcId}`;
  return { reversalDocumentId: reversal.documentId };
}

/**
 * The maturity question, answered as a query. There is no PDC job and there will not be one: `JOBS` is
 * a closed sixteen-name registry (§4.2.6) and adding a seventeenth name is 0B's decision, not 4B's.
 * The register itself is 7C's `accounting.pdc_register` report code (§4.16.1), which reads this.
 */
export async function listPdc(
  tx: Sql,
  params: { companyId: string; status?: PdcStatus; maturingBefore?: string; limit: number },
): Promise<PdcRow[]> {
  const rows = await tx<{ id: string; party_id: string; cheque_number: string; bank_name: string | null;
                          amount: string; currency: string; maturity_date: string; status: PdcStatus;
                          receipt_document_id: string; deposit_document_id: string | null }[]>`
    select id::text, party_id::text, cheque_number, bank_name, amount::text, currency,
           maturity_date::text, status, receipt_document_id::text, deposit_document_id::text
      from app.pdc
     where company_id = ${params.companyId}
       and (${params.status ?? null}::text is null or status = ${params.status ?? null})
       and (${params.maturingBefore ?? null}::date is null
            or maturity_date < ${params.maturingBefore ?? null}::date)
     order by maturity_date, cheque_number
     limit ${params.limit}`;
  return rows.map((r) => ({
    id: r.id, partyId: r.party_id, chequeNumber: r.cheque_number, bankName: r.bank_name,
    amount: r.amount, currency: r.currency, maturityDate: r.maturity_date, status: r.status,
    receiptDocumentId: r.receipt_document_id, depositDocumentId: r.deposit_document_id,
  }));
}
```

**On the two `select … for update`s.** `depositPdc` locks `of p` specifically, because the statement joins `app.document` to reach `branch_id` and a bare `for update` would take a row lock on the document too — which 1A's posting path also wants, and which is a deadlock waiting for the first operator who banks a cheque while someone else amends the receipt. `bouncePdc` needs no join and takes the plain form. Both raise `ERR_DOC_STATUS_ILLEGAL` **naming the status they actually found**, so the operator's problem+json says "is deposited" rather than "illegal transition"; §4.2.4's `remedy` extension carries the next step.

**Why `Money` is a parameter but not a return.** `draftPdcReceipt` takes `Money` so the caller cannot hand in a float, and stores `amount.toString()` into `numeric(19,4)`. `PdcRow.amount` comes back as the database's own `::text`, exactly as every other row type in this slice does (§3.4.9): re-wrapping it in `Money` here would make the type depend on the currency being loadable, and the route layer re-wraps it once, where the currency is already in hand.

- [ ] **Step 4: The routes, the module and the probe**

`packages/contracts/src/accounting/pdc.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, MoneySchema, UuidSchema } from "../common";

export const PdcStatusSchema = z.enum(["in_hand", "deposited", "cleared", "bounced"]).openapi("PdcStatus");

export const CreatePdcBody = z.object({
  partyId: UuidSchema,
  chequeNumber: z.string().min(1).max(64),
  bankName: z.string().min(1).max(200).optional(),
  amount: MoneySchema,
  maturityDate: DateSchema,
  effectiveDate: DateSchema,
}).openapi("CreatePdcBody");

export const DepositPdcBody = z.object({
  bankAccountId: UuidSchema,
  effectiveDate: DateSchema,
}).openapi("DepositPdcBody");

export const BouncePdcBody = z.object({
  effectiveDate: DateSchema,
  reason: z.string().min(1).max(500),
}).openapi("BouncePdcBody");

export const PdcSchema = z.object({
  id: UuidSchema,
  partyId: UuidSchema,
  chequeNumber: z.string(),
  bankName: z.string().nullable(),
  amount: MoneySchema,
  maturityDate: DateSchema,
  status: PdcStatusSchema,
  receiptDocumentId: UuidSchema,
  depositDocumentId: UuidSchema.nullable(),
}).openapi("Pdc");

export const PdcList = z.object({
  items: z.array(PdcSchema),
  next_cursor: z.string().nullable(),
}).openapi("PdcList");
```

`apps/api/src/routes/accounting/pdc.ts`:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { currency, Money } from "@dulja/domain";
import {
  BouncePdcBody, CreatePdcBody, DepositPdcBody, PdcList, PdcStatusSchema, ProblemSchema,
  UuidSchema, ListQuery, DateSchema,
} from "@dulja/contracts";
import { bouncePdc, depositPdc, draftPdcReceipt, listPdc } from "@dulja/db";
import { IdempotencyHeader, PERMISSION, requirePermission, type AppEnv, type RouteModule } from "../../kernel";

export const pdcRoutes = new OpenAPIHono<AppEnv>();

const CompanyParams = z.object({ companyId: UuidSchema });
const PdcParams = CompanyParams.extend({ pdcId: UuidSchema });
const problem = (description: string) =>
  ({ content: { "application/problem+json": { schema: ProblemSchema } }, description });

// Two gates, not one. Drafting a cheque is `.create`; banking one and bouncing one both MOVE MONEY
// between accounts and are `.post` (§4.14's row gives both document types accounting.receipt.post).
// A clerk who may record a cheque is not thereby allowed to bank it.
const createGate = () => requirePermission(PERMISSION["accounting.receipt.create"], { company: "path:companyId" });
const postGate = () => requirePermission(PERMISSION["accounting.receipt.post"], { company: "path:companyId" });

pdcRoutes.openapi(createRoute({
  method: "post", path: "/",
  request: { params: CompanyParams, headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: CreatePdcBody } } } },
  responses: {
    201: { content: { "application/json": { schema: z.object({ pdcId: UuidSchema, documentId: UuidSchema }) } },
           description: "the cheque, recorded in hand" },
    400: problem("ERR_VALIDATION_FAILED — maturity is not after the effective date, or the amount is not positive"),
    403: problem("forbidden"),
    422: problem("ERR_POLICY_REQUIRES_MISSING — 1150 or the party's control account does not resolve"),
  },
  middleware: [createGate()], tags: ["accounting"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const b = c.req.valid("json");
  const result = await c.var.withTenant((tx) => draftPdcReceipt(tx, c.var.ctx, {
    companyId, partyId: b.partyId, chequeNumber: b.chequeNumber, bankName: b.bankName,
    amount: Money.of(b.amount.amount, currency(b.amount.currency)),
    maturityDate: b.maturityDate, effectiveDate: b.effectiveDate,
    branchId: c.var.ctx.branchId, jobs: c.var.jobs,
  }));
  return c.json(result, 201);
});

pdcRoutes.openapi(createRoute({
  method: "post", path: "/{pdcId}/deposit",
  request: { params: PdcParams, headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: DepositPdcBody } } } },
  responses: {
    201: { content: { "application/json": { schema: z.object({ documentId: UuidSchema }) } },
           description: "the cheque, banked" },
    403: problem("forbidden"), 404: problem("ERR_NOT_FOUND"),
    409: problem("ERR_DOC_STATUS_ILLEGAL — the cheque is not in_hand; the message names the status found"),
  },
  middleware: [postGate()], tags: ["accounting"],
}), async (c) => {
  const { pdcId } = c.req.valid("param");
  const b = c.req.valid("json");
  const result = await c.var.withTenant((tx) => depositPdc(tx, c.var.ctx, {
    pdcId, bankAccountId: b.bankAccountId, effectiveDate: b.effectiveDate, jobs: c.var.jobs }));
  return c.json(result, 201);
});

pdcRoutes.openapi(createRoute({
  method: "post", path: "/{pdcId}/bounce",
  request: { params: PdcParams, headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: BouncePdcBody } } } },
  responses: {
    201: { content: { "application/json": { schema: z.object({ reversalDocumentId: UuidSchema }) } },
           description: "the deposit, reversed; the cheque is in_hand again" },
    403: problem("forbidden"), 404: problem("ERR_NOT_FOUND"),
    409: problem("ERR_DOC_STATUS_ILLEGAL — only a deposited cheque can bounce"),
  },
  middleware: [postGate()], tags: ["accounting"],
}), async (c) => {
  const { pdcId } = c.req.valid("param");
  const b = c.req.valid("json");
  const result = await c.var.withTenant((tx) => bouncePdc(tx, c.var.ctx, {
    pdcId, effectiveDate: b.effectiveDate, reason: b.reason, jobs: c.var.jobs }));
  return c.json(result, 201);
});

pdcRoutes.openapi(createRoute({
  method: "get", path: "/",
  request: { params: CompanyParams,
             query: ListQuery.extend({ status: PdcStatusSchema.optional(),
                                       maturingBefore: DateSchema.optional() }) },
  responses: { 200: { content: { "application/json": { schema: PdcList } }, description: "cheques" },
               403: problem("forbidden") },
  middleware: [createGate()], tags: ["accounting"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  const rows = await c.var.withTenant((tx) => listPdc(tx, {
    companyId, status: q.status, maturingBefore: q.maturingBefore, limit: q.limit }));
  const items = rows.map((r) => ({
    id: r.id, partyId: r.partyId, chequeNumber: r.chequeNumber, bankName: r.bankName,
    amount: { amount: r.amount, currency: r.currency },
    maturityDate: r.maturityDate, status: r.status,
    receiptDocumentId: r.receiptDocumentId, depositDocumentId: r.depositDocumentId,
  }));
  return c.json({ items, next_cursor: null }, 200);
});

export const pdcRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/pdc",
  router: pdcRoutes,
  permissions: [PERMISSION["accounting.receipt.create"], PERMISSION["accounting.receipt.post"]],
  auth: "human",
};
```

`apps/api/src/routes/index.ts` — one line **inside `buildRoutes`** (never pushed onto `ROUTES`, §4.2.7):

```ts
    pdcRouteModule,               // 4B — OD-09; deleted with Tasks 9 and 10
```

`tests/invariants/probes.ts` — the one `PROBES` key, added in this task and deleted with it (hazard 31):

```ts
  "/v1/companies/:companyId/pdc": {
    // The probe writes as tenant A and reads as tenant B, like every other entry.
    //
    // It seeds its OWN prerequisites and reads nothing off `Seed` that is not there. `Seed` is
    // `{ tenant; system; human; company; period; closedPeriod; lockedPeriod; cash; sales; docType;
    // policy; branchType; hq }` and has NO `customer` member (§4.1, and this plan's fact 1) — reaching
    // for `s.customer` is the silent failure that fact exists to prevent. `1150` and `PDC_RECEIPT` are
    // 4B's own and no other probe has seeded them, so this one must.
    seed: async (api, s) => {
      const chequesInHand = await seedAccount(api.db, s,
        { code: "1150", nameEn: "Cheques in hand", type: "asset" });
      const partyId = await seedParty(api.db, s,
        { kind: "customer", code: "PROBE-C", receivableAccountId: s.cash });
      await seedTypeFromPack(api.db, s, "PDC_RECEIPT");
      const { pdcId } = await api.request({ method: "POST", as: s.human,
        path: `/v1/companies/${s.company}/pdc`,
        body: { partyId, chequeNumber: "PROBE-1", amount: { amount: "1.0000", currency: "MYR" },
                maturityDate: "2026-12-31", effectiveDate: "2026-01-02" } })
        .then((r) => r.json() as Promise<{ pdcId: string }>);
      void chequesInHand;
      return { pdcId };
    },
    read: (s, seeded) => ({ method: "GET", path: `/v1/companies/${s.company}/pdc`,
                            expectMissing: (seeded as { pdcId: string }).pdcId }),
  },
```

`tests/invariants/probes.ts` gains three imports with that entry — `seedAccount` and `seedParty` from `../invariants/fixtures` and `seedTypeFromPack` from `./support/ar-ap` — and loses them again when Tasks 9 and 10 are dropped. Task 8's `bank-statements` probe needed none of them, so they arrive with this entry and belong to it.

**`c.var.ctx.branchId` is the one thing here a reviewer should check against 0B.** §4.2.3's `RequestContext` carries the acting principal's branch, and `draftPdcReceipt` needs a `branch_id` because §4.3.2 step 10 tags every line's `BRANCH` dimension from the document header. If 0B named it differently, this is a one-word correction; if 0B does not carry a branch on the context at all, the body gains a required `branchId` and the two screens send it. **Task 0's gate does not probe this**, because Tasks 9 and 10 do not run at all unless OD-09 comes back yes — and if it does, this is the first thing Step 4 discovers, in the typecheck, before any test runs.

- [ ] **Step 5: Run to green and commit**

```bash
bun run --cwd packages/db test -- ar-ap/pdc
bun run --cwd apps/api test -- accounting/pdc
bun run --cwd tests test -- invariants/tenant-isolation
bun run --cwd packages/contracts openapi:generate
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
```

```bash
git add packages/db/seed/my/document-types/PDC_RECEIPT.json packages/db/seed/my/document-types/PDC_DEPOSIT.json \
        packages/db/src/ar-ap/pdc.ts packages/db/src/ar-ap/index.ts \
        packages/contracts/src/accounting/pdc.ts packages/contracts/openapi.json \
        apps/api/src/routes/accounting/pdc.ts apps/api/src/routes/index.ts \
        tests/invariants/probes.ts packages/db/test/ar-ap/pdc.test.ts \
        apps/api/test/routes/accounting/pdc.test.ts
git commit -m "feat(db): PDC_RECEIPT, PDC_DEPOSIT, the deposit and the bounce reversal (OD-09) [4B T10]

The second of OD-09's two isolated tasks. A cheque in hand is 1150 and not 1100, so it stays out
of Task 7's reconciliation until it is banked. A bounce reverses the DEPOSIT through 1A's
reverseDocument (D13, §4.14's row) and returns the cheque to in_hand; the receivable it settled
stays settled, because unallocating is the operator's separate decision. PDC_RECEIPT declares
reversal.allowed false for that reason.

No maturity job: JOBS is a closed sixteen-name registry, so maturity is listPdc's query and the
register is 7C's accounting.pdc_register.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: ⚠️ OD-24 — the ageing and bank-reconciliation screens

**Owner decision OD-24 (§2.12): "Screenshots + operator description before any screen" — spec:79, 108, 2408. Default: the screen task is blocked, not the slice.** spec:79 and spec:108 state that the UI is not specified and hazard 29 forbids inventing a workflow.

**Owner provides:** screenshots of the two legacy screens an operator uses for these jobs — the **debtor/creditor ageing enquiry** and the **bank reconciliation sheet** — and a **two-minute description per screen** of what the operator does, in order, including which keys they press. **Verify:** `ls -1 docs/owner/od-24/4b/` shows four files — `ageing.png`, `bank-reconciliation.png` and one `.md` transcript each. **Until provided:** Steps 2 onward do not run; the slice ships with the API and no screens, and Tasks 3–8 are a deliverable an operator's own tooling can already drive.

**Steps 2–6 carry real code against a stated default layout**, on 3A's and 3D's terms and for their reason: hazard 29 blocks the *screen*, not the ability to write one, and if the owner's material shows a different workflow only the two `.tsx` files and their tests change — `ar-ap-api.ts` does not.

**The stated default layout, so a reviewer can compare it to the owner's material.** 0E Task 4's keyboard model unchanged (`/` filters, `↑`/`↓` move the selection, `Enter` opens, `Ctrl+S` saves, `Esc` reverts, `Ctrl+N` starts a new row), plus **two additions these two jobs need**. (1) The ageing screen is a **read-only grid** with a mandatory as-of date in the toolbar and one row per party and currency: `Enter` on a row opens that party's open items rather than a detail form, because the operator's next action is always "which invoice is this". (2) The reconciliation screen is **two columns side by side** — statement lines on one side, unmatched `Reconcilable`s on the other — where `Space` toggles a selection in the focused column and `Enter` matches the two selections; a mouse-driven drag would be unusable for a hundred-line statement, and the amount is never typed (it is the smaller of the two remaining figures, and a partial match is an explicit `Ctrl+Enter`).

**Files:** create `apps/backoffice/src/lib/ar-ap-api.ts`, `src/routes/accounting/ageing.tsx`, `src/routes/accounting/bank-reconciliation.tsx`, `apps/backoffice/test/ar-ap-ageing.test.tsx`, `bank-reconciliation.test.tsx`, `tests/e2e/ar-ap-screens.spec.ts`; modify `apps/backoffice/src/router.tsx` (two routes), `src/components/app-shell.tsx` (two nav entries), `packages/i18n/src/locales/en.json` and `ar.json`.

**Interfaces**

- Consumes: the eight `@dulja/ui` components 0E owns — `DataGrid`, `DateField`, `MoneyText`, `SegmentedControl`, `Toolbar` (the ageing grid) and `AccountPicker`, `ProblemAlert`, `SelectList` (the reconciliation screen); **this slice adds none**, and any that 0E did not ship is a 0E reconciliation, not a component invented here. `apiFetch` (0E Task 3's authenticated fetch wrapper, `apps/backoffice/src/lib/api-client.ts`); `useTranslation` and the `accounting.ageing.*` / `accounting.bank.*` ICU keys (`@dulja/i18n`, 0E); `MoneyJson` (`@dulja/i18n`, 0E — the §4.2.8 `MoneySchema` wire shape given a TypeScript name, and reachable from `apps/**` where `@dulja/domain`'s `Money` is the wrong tool for a rendered figure); the TanStack `createRoute` shape 0E's `router.tsx` already uses. From `@dulja/contracts`: the **DTO aliases**, never the schemas — `AgeingRowDto` (Task 3), `BankStatementDto`, `BankStatementLineDto` (Task 6), `BankMatchDto`, `ReconcilableDto`, `ReconciledBalanceDto` (Task 8). **`apps/backoffice` may not import `packages/db` (§3.1)**, so `Reconcilable` — a `packages/db` interface (§4.8.3) — is unreachable here and `ReconcilableDto` is the only legal spelling of that row.
- Produces: `apps/backoffice/src/lib/ar-ap-api.ts` — `filterQuery` (private, **the one place in the backoffice that composes §4.2.8's filter grammar**), `fetchAgeing`, `AgeingResponse`, `fetchStatements`, `fetchStatementLines`, `fetchReconciliation`, `ReconciliationResponse`, `postMatch`, `postUnmatch`; `src/routes/accounting/ageing.tsx` and `bank-reconciliation.tsx`, each exporting its TanStack `Route` and keeping `pivot`, `footer` and its row types file-local; two `router.tsx` route entries and two `app-shell.tsx` nav entries; the `accounting.ageing.*` and `accounting.bank.*` keys in both locale catalogues, complete in `en` **and** `ar` before merge (spec:2061). No contract, no route and no table: everything on this screen already exists after Task 8, which is what makes the task droppable whole.

- [ ] **Step 1: The OD-24 gate**

```bash
mkdir -p docs/owner/od-24/4b
ls -1 docs/owner/od-24/4b/
```

Four files must be listed. **Until then, stop here** and record in `docs/decisions/od-09-4b-post-dated-cheques.md`'s sibling — a one-line note in the phase report (Task 12) — that the screens are outstanding. The slice ships without them.

- [ ] **Step 2: The typed fetch layer**

```ts
// apps/backoffice/src/lib/ar-ap-api.ts
//
// Slice 4B's read/write surface for the two screens. The ONE place in the backoffice that composes a
// `filter[<field>][<op>]` query string: §4.2.8's grammar is a convention, and a convention that two
// components implement separately is a convention that will diverge. Every function here returns the
// contract type from @dulja/contracts, so a screen never shapes a response of its own.
// DTO ALIASES, not schemas: a Zod schema is a value and `import type` cannot name one. Each is
// `z.infer<typeof …Schema>` declared beside its schema (1B's `TrialBalanceRowDto` convention) —
// `AgeingRowDto` by Task 3, the two statement aliases by Task 6, the three reconciliation ones by Task 8.
import type {
  AgeingRowDto, BankMatchDto, BankStatementDto, BankStatementLineDto, ReconcilableDto,
} from "@dulja/contracts";
// The wire money shape `{ amount: string; currency: string }`. 0E already gave it a name for the
// identical reason (@dulja/i18n cannot import @dulja/domain either), and §4.2.8's MoneySchema is what it
// mirrors; `@dulja/contracts` exports MoneySchema as a VALUE and no `Money` type at all.
import type { MoneyJson } from "@dulja/i18n";
import { apiFetch } from "./api-client";        // 0E Task 3's authenticated fetch wrapper

/** §4.2.8 Layer 1's grammar, in one place. Values are encoded; an empty clause list yields "". */
function filterQuery(clauses: Readonly<Record<string, string | undefined>>): string {
  const parts = Object.entries(clauses)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([field, value]) => `filter[${field}][eq]=${encodeURIComponent(value)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export interface AgeingResponse { items: AgeingRowDto[]; next_cursor: string | null }

/**
 * `as_of` is REQUIRED by the route (Task 3's `requiredFilter`), so it is a positional parameter here
 * rather than an optional member of a filter bag: a screen cannot forget it and get a 400 at runtime.
 */
export async function fetchAgeing(
  companyId: string, asOf: string,
  opts: { partyKind?: "customer" | "vendor"; currency?: string } = {},
): Promise<AgeingResponse> {
  const query = filterQuery({ as_of: asOf, party_kind: opts.partyKind, currency: opts.currency });
  return apiFetch<AgeingResponse>(`/v1/companies/${companyId}/reports/accounting.ageing${query}`);
}

export async function fetchStatements(
  companyId: string, bankAccountId?: string,
): Promise<{ items: BankStatementDto[]; next_cursor: string | null }> {
  return apiFetch(`/v1/companies/${companyId}/bank-statements${filterQuery({ bank_account_id: bankAccountId })}`);
}

export async function fetchStatementLines(
  companyId: string, statementId: string, unmatchedOnly: boolean,
): Promise<{ items: BankStatementLineDto[]; next_cursor: string | null }> {
  // `filter[matched][eq]=false` — §4.2.8's grammar through the ONE composer above, never a hand-built
  // query string, and never a flat `?unmatchedOnly=` (Layer 1 admits no new flat parameter).
  // `undefined` when the caller wants every line, which is what the clause filter drops.
  return apiFetch(`/v1/companies/${companyId}/bank-statements/${statementId}/lines` +
                  filterQuery({ matched: unmatchedOnly ? "false" : undefined }));
}

/**
 * Mirrors `ReconciledBalanceSchema` (Task 8) exactly, and note what is NOT in it: there is no
 * `difference`. The screen subtracts the two figures itself through `Money`, because a difference
 * computed on the server and a difference computed in the browser are two definitions of one number,
 * and the first month they disagree is the month an operator signs off on the wrong one.
 */
export interface ReconciliationResponse {
  statement: MoneyJson; ledger: MoneyJson;
  unreconciled: ReconcilableDto[]; unmatchedLines: BankStatementLineDto[];
}

export async function fetchReconciliation(
  companyId: string, bankAccountId: string, asOf: string,
): Promise<ReconciliationResponse> {
  return apiFetch(`/v1/companies/${companyId}/bank-statements/reconciliation` +
                  filterQuery({ bank_account_id: bankAccountId, as_of: asOf }));
}

export async function postMatch(
  companyId: string, statementId: string, lineId: string,
  body: { kind: ReconcilableDto["kind"]; documentId: string; amount: MoneyJson },
): Promise<{ matchId: string }> {
  return apiFetch(`/v1/companies/${companyId}/bank-statements/${statementId}/lines/${lineId}/matches`,
                  { method: "POST", body });
}

export async function postUnmatch(
  companyId: string, matchId: string, reason: string,
): Promise<void> {
  await apiFetch<void>(`/v1/companies/${companyId}/bank-statements/matches/${matchId}/unmatch`,
                       { method: "POST", body: { reason } });
}

export type { AgeingRowDto, BankMatch, BankStatement, BankStatementLine, Reconcilable };
```

**`apiFetch` is 0E's, and it is the reason no `Idempotency-Key` appears above.** 0E Task 3's wrapper attaches the bearer token and generates an `Idempotency-Key` for every unsafe method (§4.2.9); a screen composing its own header would be a second implementation of a rule the kernel already enforces. If a `POST` here is retried by the user's own double-click, the kernel's idempotency layer returns the first response rather than posting twice — which for `postMatch` is the difference between one match and a 422 over-match.

- [ ] **Step 3: The ageing screen**

```tsx
// apps/backoffice/src/routes/accounting/ageing.tsx
import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Money, currency, type CurrencyCode } from "@dulja/domain";
import { DataGrid, DateField, MoneyText, SegmentedControl, Toolbar } from "@dulja/ui";
import { fetchAgeing, type AgeingRowDto } from "../../lib/ar-ap-api";
import { useCompanyId } from "../../lib/session";

// The five bucket columns, named as they are on AgeingRowSchema (Task 3). `d1_30` and friends carry the
// `d` prefix because a TypeScript property in this position cannot start with a digit, and the register's
// bucket labels ("1_30") are the SQL function's, not the DTO's — Task 3's read function does the mapping
// once. This array is the only place the five are ordered, so a column cannot be omitted from the footer.
const BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "over_90"] as const;
type Bucket = (typeof BUCKETS)[number];

/** The label key for a bucket column, so the `d` prefix never reaches a translation file. */
const BUCKET_LABEL: Readonly<Record<Bucket, string>> = {
  current: "current", d1_30: "1_30", d31_60: "31_60", d61_90: "61_90", over_90: "over_90",
};

interface CurrencyTotal {
  currencyCode: string;
  buckets: Record<Bucket, Money<CurrencyCode>>;
  total: Money<CurrencyCode>;
}

/**
 * Column totals, ONE ROW PER CURRENCY.
 *
 * Two rules, and both are Global Constraint 4 rather than presentation taste. Every addition goes
 * through `Money.add` and every accumulator starts at `Money.zero(ccy)` — never `0`, never
 * `Number(r.total)`: a screen that adds 1,234.5600 and 0.0001 in a float and shows a figure the ledger
 * does not hold is SAH-019 with a browser in front of it. And amounts of different currencies are never
 * added to each other, which is why this returns a row per currency instead of one grand total. A single
 * "total" across MYR and EUR is not a smaller number, it is a meaningless one.
 */
function currencyTotals(rows: readonly AgeingRowDto[]): CurrencyTotal[] {
  const byCcy = new Map<string, CurrencyTotal>();
  for (const r of rows) {
    const ccy = currency(r.currency);
    const acc = byCcy.get(r.currency) ?? {
      currencyCode: r.currency,
      buckets: Object.fromEntries(BUCKETS.map((b) => [b, Money.zero(ccy)])) as Record<Bucket, Money<CurrencyCode>>,
      total: Money.zero(ccy),
    };
    const buckets = { ...acc.buckets };
    for (const b of BUCKETS) buckets[b] = buckets[b].add(Money.of(r[b], ccy));
    byCcy.set(r.currency, { ...acc, buckets, total: acc.total.add(Money.of(r.total, ccy)) });
  }
  return [...byCcy.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}

function AgeingScreen() {
  const { t, i18n } = useTranslation("accounting");
  const navigate = useNavigate();
  const companyId = useCompanyId();
  // Default as-of is today, and the field is MANDATORY rather than defaulted-and-hidden: an ageing
  // report with no visible date is the commonest way a stale figure reaches a customer. The route
  // requires filter[as_of][eq] (Task 3's `requiredFilter`), so there is no such thing as "no date".
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [partyKind, setPartyKind] = useState<"customer" | "vendor">("customer");

  const query = useQuery({
    queryKey: ["ageing", companyId, asOf, partyKind],
    queryFn: () => fetchAgeing(companyId, asOf, { partyKind }),
  });

  const rows = query.data?.items ?? [];
  const totals = useMemo(() => currencyTotals(rows), [rows]);
  // The row is already pivoted by the report (AgeingRowSchema carries the five buckets as columns), so
  // this screen does no arithmetic on individual amounts at all — only the footer sums.
  const partyName = (r: AgeingRowDto) =>
    (i18n.language.startsWith("ar") ? r.partyNameAr : null) ?? r.partyNameEn;

  return (
    <section aria-labelledby="ageing-heading">
      <h1 id="ageing-heading">{t("ageing.title")}</h1>
      <Toolbar>
        <DateField label={t("ageing.asOf")} value={asOf} onChange={setAsOf} required
                   data-testid="ageing-as-of" />
        <SegmentedControl
          label={t("ageing.partyKind")}
          value={partyKind}
          onChange={(v) => setPartyKind(v as "customer" | "vendor")}
          options={[{ value: "customer", label: t("ageing.customers") },
                    { value: "vendor",   label: t("ageing.vendors") }]}
        />
      </Toolbar>

      <DataGrid
        // READ-ONLY: there is nothing on this screen to save, so Ctrl+S and Ctrl+N are not bound and the
        // grid takes no edit affordance. Enter opens the party's open items, because the operator's next
        // question is always "which invoice is this" (the stated layout, OD-24).
        readOnly
        loading={query.isLoading}
        error={query.error ? t("ageing.loadFailed") : undefined}
        emptyMessage={t("ageing.nothingOpen", { asOf })}
        caption={t("ageing.caption", { asOf })}
        rows={rows}
        rowKey={(r: AgeingRowDto) => `${r.partyId}:${r.currency}`}
        onOpenRow={(r: AgeingRowDto) => void navigate({
          to: "/accounting/parties/$partyId/open-items",
          params: { partyId: r.partyId },
          search: { asOf, currency: r.currency },
        })}
        columns={[
          { id: "party", header: t("ageing.party"), align: "start",
            cell: (r: AgeingRowDto) => `${r.partyCode} — ${partyName(r)} (${r.currency})` },
          ...BUCKETS.map((b) => ({
            id: b, header: t(`ageing.bucket.${BUCKET_LABEL[b]}`), align: "end" as const, numeric: true,
            cell: (r: AgeingRowDto) => <MoneyText value={Money.of(r[b], currency(r.currency))} />,
          })),
          { id: "total", header: t("ageing.total"), align: "end", numeric: true, emphasis: true,
            cell: (r: AgeingRowDto) => <MoneyText value={Money.of(r.total, currency(r.currency))} /> },
        ]}
        footerRows={totals.map((f) => ({
          key: f.currencyCode,
          cells: [t("ageing.totalFor", { currency: f.currencyCode }),
                  ...BUCKETS.map((b) => <MoneyText key={b} value={f.buckets[b]} />),
                  <MoneyText key="t" value={f.total} />],
        }))}
      />
    </section>
  );
}

export const Route = createFileRoute("/accounting/ageing")({ component: AgeingScreen });
```

**Four notes.** `MoneyText` is `packages/ui`'s formatter (0E): it applies the currency's display policy at render time and **never re-rounds the stored figure** (spec:2041), which is why it takes a `Money` and not a string — a string would let a caller pre-format and lose the currency. `align: "end"` rather than `"right"` is what keeps the numeric columns correct under `dir="rtl"` (Step 5's test asserts it). **The screen does no arithmetic on individual amounts**, because `AgeingRowSchema` is already pivoted — the five buckets are columns on the row (Task 3), so `currencyTotals` is the only place this file adds anything, and a reviewer checking Global Constraint 4 has exactly one function to read. And **`/accounting/parties/$partyId/open-items` is 4A's route, not this one**: if 4A shipped no open-items screen the `onOpenRow` prop is dropped and the grid is inert on `Enter` — one line, and the OD-24 material settles whether the operator wants it at all.

- [ ] **Step 4: The reconciliation screen**

```tsx
// apps/backoffice/src/routes/accounting/bank-reconciliation.tsx
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Money, currency } from "@dulja/domain";
import { AccountPicker, DateField, MoneyText, ProblemAlert, SelectList, Toolbar } from "@dulja/ui";
import {
  fetchReconciliation, fetchStatementLines, fetchStatements, postMatch,
  type BankStatementLine, type Reconcilable,
} from "../../lib/ar-ap-api";
import { useCompanyId } from "../../lib/session";

function ReconciliationScreen() {
  const { t } = useTranslation("accounting");
  const companyId = useCompanyId();
  const qc = useQueryClient();

  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [lineId, setLineId] = useState<string | null>(null);
  const [itemKey, setItemKey] = useState<string | null>(null);
  // Set when plain Enter refuses an unequal pair. Cleared on every successful match and on reselection,
  // so it can never describe a pair that is no longer selected.
  const [hint, setHint] = useState<string | null>(null);

  const statements = useQuery({
    queryKey: ["statements", companyId, bankAccountId],
    queryFn: () => fetchStatements(companyId, bankAccountId ?? undefined),
    enabled: bankAccountId !== null,
  });
  // The most recent statement for this account. `listStatements` orders by statement_date descending
  // (Task 6), so [0] is "the one the operator just imported" without a second query.
  const statement = statements.data?.items[0] ?? null;

  const lines = useQuery({
    queryKey: ["statement-lines", companyId, statement?.id],
    queryFn: () => fetchStatementLines(companyId, statement!.id, true),
    enabled: statement !== null,
  });
  const recon = useQuery({
    queryKey: ["reconciliation", companyId, bankAccountId, asOf],
    queryFn: () => fetchReconciliation(companyId, bankAccountId!, asOf),
    enabled: bankAccountId !== null,
  });

  // A statement LINE carries a bare amount string and no currency of its own (BankStatementLineSchema):
  // the currency belongs to the statement, one per statement by construction. So the currency comes from
  // there, and a line amount is never turned into Money without it.
  const lineCcy = statement ? currency(statement.currency) : null;

  const match = useMutation({
    mutationFn: async (opts: { partial: boolean }) => {
      const line = lines.data?.items.find((l) => l.id === lineId);
      const item = recon.data?.unreconciled.find((i) => `${i.kind}:${i.documentId}` === itemKey);
      if (!line || !item || !statement || !lineCcy) return;

      // The amount is NEVER typed. A full match is the smaller of the two REMAINING figures, which is
      // what makes an over-match impossible from this screen — an ERR_BANK_MATCH_AMOUNT problem here
      // means someone else matched concurrently, not that the operator mistyped.
      //
      // `abs()` on both halves is required and is not defensive: a bank export signs its amounts (a
      // payment out is negative) while a Reconcilable's amount is a MAGNITUDE with
      // RECONCILABLE_DIRECTION carrying its side (Task 7). Comparing the two signed would pick the
      // wrong minimum on every payment — the direction is already settled by the time a pair can be
      // selected, because `unmatchedStatementLines` only offers sources whose direction admits the line.
      const remainingOnLine = Money.of(line.amount, lineCcy).abs()
        .subtract(Money.of(line.matchedAmount, lineCcy).abs());
      const itemAmount = Money.of(item.amount.amount, currency(item.amount.currency)).abs();

      // PLAIN ENTER IS FOR A CLEAN MATCH ONLY. When the two figures differ, one of them is left
      // partly open and the operator has to have meant it — so Enter refuses and says which key does
      // it. Letting Enter silently part-match is how a statement ends up "reconciled" with a trail of
      // 0.05 remainders nobody chose to leave, and the header band would still read zero.
      if (!opts.partial && !remainingOnLine.equals(itemAmount)) {
        setHint(t("recon.partialNeedsCtrlEnter",
                  { line: remainingOnLine.toString(), item: itemAmount.toString() }));
        return;
      }
      setHint(null);
      const amount = remainingOnLine.isLessThan(itemAmount) ? remainingOnLine : itemAmount;

      await postMatch(companyId, statement.id, line.id, {
        kind: item.kind, documentId: item.documentId,
        amount: { amount: amount.toString(), currency: statement.currency },
      });
    },
    onSuccess: async () => {
      setLineId(null); setItemKey(null); setHint(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["statement-lines", companyId, statement?.id] }),
        qc.invalidateQueries({ queryKey: ["reconciliation", companyId, bankAccountId, asOf] }),
      ]);
    },
  });

  // The difference is computed HERE, through Money, because ReconciledBalanceSchema does not carry one
  // (Task 8) — deliberately: one definition of the figure, in the place that displays it.
  const difference = recon.data
    ? Money.of(recon.data.statement.amount, currency(recon.data.statement.currency))
        .subtract(Money.of(recon.data.ledger.amount, currency(recon.data.ledger.currency)))
    : null;
  const reconciled = difference?.isZero() ?? false;
  const canMatch = lineId !== null && itemKey !== null && !match.isPending;

  return (
    <section aria-labelledby="recon-heading"
             onKeyDown={(e) => {
               // Enter matches the two selections; Ctrl+Enter is the explicit PARTIAL match, used when
               // the operator knows the two will not close each other out. Space toggles the selection
               // inside the focused column and is SelectList's own binding, not this screen's.
               if (e.key === "Enter" && canMatch) {
                 e.preventDefault();
                 match.mutate({ partial: e.ctrlKey });
               }
             }}>
      <h1 id="recon-heading">{t("recon.title")}</h1>
      <Toolbar>
        <AccountPicker label={t("recon.bankAccount")} value={bankAccountId}
                       onChange={setBankAccountId} filter={{ type: "asset" }} required />
        <DateField label={t("recon.asOf")} value={asOf} onChange={setAsOf} required />
      </Toolbar>

      {/* The ONLY alarm on the screen. When the difference is not zero it says so and names both
          counts; when it is zero it says THAT too, because "no news" is not something an operator can
          sign off on. aria-live="polite" so a screen reader hears the figure change after a match. */}
      {recon.data && difference && (
        <div role="status" aria-live="polite"
             data-state={reconciled ? "reconciled" : "unreconciled"}
             data-testid="recon-band">
          <MoneyText label={t("recon.statementBalance")}
                     value={Money.of(recon.data.statement.amount, currency(recon.data.statement.currency))} />
          <MoneyText label={t("recon.ledgerBalance")}
                     value={Money.of(recon.data.ledger.amount, currency(recon.data.ledger.currency))} />
          <MoneyText label={t("recon.difference")} value={difference} emphasis={!reconciled} />
          <p>{reconciled
            ? t("recon.balanced", { asOf })
            : t("recon.notBalanced", { items: recon.data.unreconciled.length,
                                       lines: recon.data.unmatchedLines.length })}</p>
        </div>
      )}

      {/* The problem is RENDERED, never re-worded: Task 7's `detail` already names both figures, and a
          message composed here would be a second copy of the rule, free to drift from it. */}
      {match.error ? <ProblemAlert error={match.error} /> : null}
      {hint ? <p role="alert" data-testid="recon-hint">{hint}</p> : null}

      <div className="recon-columns">
        <SelectList
          aria-label={t("recon.statementLines")}
          items={lines.data?.items ?? []}
          itemKey={(l: BankStatementLine) => l.id}
          selectedKey={lineId}
          onSelect={(k) => { setLineId(k); setHint(null); }}
          loading={lines.isLoading}
          emptyMessage={statement ? t("recon.noUnmatchedLines") : t("recon.pickAnAccount")}
          renderItem={(l: BankStatementLine) => (
            <>
              <span>{l.valueDate}</span>
              <span>{l.description}</span>
              <MoneyText value={Money.of(l.amount, lineCcy!)} />
            </>
          )}
        />
        <SelectList
          aria-label={t("recon.unreconciledItems")}
          items={recon.data?.unreconciled ?? []}
          itemKey={(i: Reconcilable) => `${i.kind}:${i.documentId}`}
          selectedKey={itemKey}
          onSelect={(k) => { setItemKey(k); setHint(null); }}
          loading={recon.isLoading}
          emptyMessage={t("recon.nothingUnreconciled")}
          renderItem={(i: Reconcilable) => (
            <>
              <span>{i.valueDate}</span>
              <span>{t(`recon.kind.${i.kind}`)} {i.reference ?? ""}</span>
              <MoneyText value={Money.of(i.amount.amount, currency(i.amount.currency))} />
            </>
          )}
        />
      </div>
    </section>
  );
}

export const Route = createFileRoute("/accounting/bank-reconciliation")({ component: ReconciliationScreen });
```

**Why the two columns are one `div` with a class and not a grid component.** `dir="rtl"` must swap which column sits on which side, and that is a CSS logical-property job — `grid-template-columns` on a container whose `direction` the app shell already sets — not something a component should compute from a locale. Step 5's test asserts the swap actually happens.

**Three shapes this component reads that a reviewer should check against Tasks 6, 7 and 8.** (1) **A statement line has no currency of its own.** `BankStatementLineSchema` carries `amount` and `matchedAmount` as bare strings; the currency is the *statement's*, one per statement by construction, which is why `lineCcy` is derived once and a line amount is never turned into `Money` without it. (2) **A `Reconcilable`'s `amount` IS a `Money` DTO** (`ReconcilableSchema`), so it carries its own currency and is read directly — the two halves genuinely differ in shape, and flattening them to one would need a conversion this screen has no rate for. (3) **`ReconciledBalanceSchema` carries no `difference`**, so the screen subtracts `statement − ledger` through `Money` itself. That is the deliberate choice: one definition of the figure, in the place that displays it, rather than a server figure and a browser figure that agree until the day they do not.

**Enter and Ctrl+Enter are genuinely different, and that is the whole keyboard decision this screen adds.** Plain `Enter` completes a match only when the line's remaining figure and the item's are **equal**; when they are not, it refuses and names both figures, because a part-match leaves something open and the operator must choose it. `Ctrl+Enter` is that choice, and it takes the smaller of the two. Without the refusal, `Enter` would quietly part-match and a statement could reach "reconciled" trailing remainders nobody decided to leave — with the header band still reading zero, which is the one thing on this screen an operator trusts. Step 5's e2e exercises both keys.

**And the remaining amount, not the line amount.** `remainingOnLine` subtracts `matchedAmount` from `amount`, both `abs()`, so a line already half-matched offers only what is left — matching against the gross figure would produce an `ERR_BANK_MATCH_AMOUNT` on the operator's second, entirely reasonable, partial match.

- [ ] **Step 5: Both directions (test 23's re-run)**

`tests/e2e/ar-ap-screens.spec.ts` through 0E's `bootLocalStack()`: both screens in `en` and `ar`, asserting that the numeric columns stay in reading order in both directions and that the two-column matcher's columns swap sides under `dir="rtl"`. The i18n catalogues are complete in both locales before merge (Global Constraint 17).

- [ ] **Step 6: Commit**

```bash
git add apps/backoffice/src/lib/ar-ap-api.ts apps/backoffice/src/routes/accounting/ \
        apps/backoffice/src/router.tsx apps/backoffice/src/components/app-shell.tsx \
        apps/backoffice/test/ packages/i18n/src/locales/en.json packages/i18n/src/locales/ar.json \
        tests/e2e/ar-ap-screens.spec.ts docs/owner/od-24/4b/
git commit -m "feat(backoffice): the ageing and bank-reconciliation screens (OD-24) [4B T11]

Built against the owner's screenshots and operator transcripts, which Step 1 gates on. The two
additions to 0E's keyboard model are stated in the plan so a reviewer can compare them to the
owner's material: the ageing grid opens a party's open items on Enter, and the reconciliation
screen is two columns matched with Space and Enter rather than a drag.

Every amount sums through Money.add and renders through packages/ui's formatter; both screens are
verified in both text directions (test 23).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Phase 4 exit — the re-run matrix, the pinned lists, the staging re-seed, AGENTS.md and the phase report

**The last task of a phase-closing slice** (§3.8 names 4B among the ten). It writes no new feature: it proves the phase.

**Files:** create `docs/review/2026-09-05-phase-4-exit.md`; modify `AGENTS.md` ("Current phase"), `packages/db/test/privileges.test.ts` (re-assert the unchanged DELETE list)

**Interfaces**

- Consumes, and every one of them is read as a PINNED value rather than called for its behaviour: §3.5.4's five-table `app_rw` DELETE list (`packages/db/test/privileges.test.ts`, plan0A:2476–2485); `lintSchema` (§4.1); `projectionChecks()` (1B, §4.16.3 — five members after Task 4); `JOB_NAMES` / `JOBS` (§4.2.6 — still sixteen names; this slice added a *payload key*); `ALLOWED_PERMISSIVE` and `GLOBAL_TABLES` (plan0A's linter sets, untouched); `up`/`down`/`listApplied`/`discover` and `schemaFingerprint` (§4.1 — §3.4.6's up → down → up proof over 0001..0052); the seed CLI's `--only` flag with the `chart-of-accounts` and `document-types` sub-packs (0C, 1A); `PERMISSIONS` and the `permission-catalogue` lint (§3.6.3); 3D's `secondPrincipal` and 2B's `transitionDocument` by way of `postFromPack` (Task 3), for the R1 case.
- Produces: `docs/review/2026-09-05-phase-4-exit.md`; the rewritten `AGENTS.md` "Current phase" section (§3.8 names 4B among the ten phase-closing slices); **one added `it` in `packages/db/test/privileges.test.ts` and no other code anywhere.** No table, no migration, no contract, no route, no export.

**Why this task has no failing-test-first step, and why that is not an exception being smuggled through.** Step 2's assertion is a **re-assertion of an existing equality**, not a new behaviour: §3.5.4's DELETE list is pinned by Plan 0A and 2B is its only registered extender, so the case is written to pass on the first run and its value is that it would go red if any of 0048–0052 had granted a DELETE. There is nothing to see fail first — a red version of it would mean this slice had already broken the pin, which Tasks 1, 6, 7 and 9 each assert against for their own tables. Every other step here runs a suite that already exists. That is the shape of a phase-exit task and it is stated so a reviewer does not read the absence as an omission.

- [ ] **Step 1: The re-run matrix, green**

```bash
bun run --cwd tests test -- invariants/test-08-multi-currency        # owned: 8
bun run --cwd tests test -- invariants/test-39-bank-reconciliation   # owned: 39
bun run --cwd tests test -- invariants/projection-rebuild            # re-run: 2, over both new projections
bun run --cwd packages/db test -- ar-ap/item-profitability           # re-run: 7, the revenue half
bun run --cwd tests test -- invariants/tenant-isolation              # re-run: 12, over five tables, one job, one module
bun run --cwd tests test -- invariants/audit-chain                   # re-run: 13, over the 3 (⚠️ 4) audited tables
bun run --cwd tests test -- invariants/ledger-balance                # re-run: 1, unchanged by this slice
bun run lint:rules                                                    # re-run: 27, 36
bun run --cwd packages/db test -- permission-catalogue               # re-run: 36
bun run --cwd tests test -- regression                                # the six appended blocks
bun run test                                                          # everything
```

| Test | Clause this slice re-runs it over |
|---|---|
| **2** | `party_ageing` compared by `accounting.projection.rebuild`; `item_profitability` by `projectionChecks` |
| **7** | the revenue half of "valuation and profit tie to the cent" (Task 4's three tie-outs) |
| **8** | owned — Task 5 |
| **12** | `party_ageing`, `item_profitability`, `bank_statement`, `bank_statement_line`, `bank_match` (+ ⚠️ `pdc`); the `accounting.projection.rebuild` job probe; the `bank-statements` route probe (+ ⚠️ `pdc`) |
| **13** | the **three** audited tables of this slice — `bank_statement`, `bank_statement_line`, `bank_match` (⚠️ **four** with `pdc` under OD-09) — and the incident row `accounting.projection.rebuild` writes. `party_ageing` and `item_profitability` are the other two tables this slice creates and they are **`AUDIT_EXEMPT`** (§3.5.3, Task 1 Step 5): they carry no audit trigger and must NOT appear in this suite |
| **27** | no SQL text from a definition or a client: the ageing route maps declared filter fields through a closed `switch`, `parseDelimited` builds no SQL, and `sql.unsafe` appears nowhere in this slice |
| **36** | one new catalogue code with a handler reference, one role grant, and `auditor` holding no mutating code |
| **39** | owned — Task 7 |

- [ ] **Step 2: The three pinned lists, re-asserted as equalities**

```ts
// packages/db/test/privileges.test.ts — the §3.5.4 list is UNCHANGED by slice 4B.
it("app_rw's DELETE grants are still exactly §3.5.4's five tables after 0048–0052", async () => {
  const rows = await db.admin<{ table_name: string }[]>`
    select distinct table_name from information_schema.role_table_grants
     where grantee = 'app_rw' and table_schema = 'app' and privilege_type = 'DELETE'
     order by table_name`;
  expect(rows.map((r) => r.table_name))
    .toEqual(["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]);
});
```

and, in the same run: `lintSchema(db.admin)` returns `[]`; `projectionChecks().map(c => c.name)` equals `["account_balance", "cost_layer", "document_series", "item_profitability", "stock_on_hand"]`; `JOB_NAMES` still has sixteen members (this slice added a **payload key**, never a name); `ALLOWED_PERMISSIVE` and `GLOBAL_TABLES` are untouched.

- [ ] **Step 3: The reversibility proof over the whole range**

```bash
bun run --cwd packages/db test -- privileges     # §3.4.6's up → down → up fingerprint over 0001..0052
```

This is the step that catches a down file that forgot one of migration 0048's two SQL functions or one of 0050's two partial indexes: after `down(…)` to 0 there must be **zero** tables in schema `app` and the second `up()` must reproduce the fingerprint byte for byte.

- [ ] **Step 4: The staging re-seed (the owner-account pattern, hazard 5)**

**Owner provides:** the staging `DATABASE_URL_MIGRATOR` and the tenant id (OD-19, OD-21). **Verify:**

```bash
bun run --cwd packages/db db:migrate
bun run --cwd packages/db seed -- --tenant "$TENANT_ID" --only chart-of-accounts
bun run --cwd packages/db seed -- --tenant "$TENANT_ID" --only document-types
```

prints exit code 0 and the `document-types` loader reports `FX_REVALUATION` created (plus ⚠️ `PDC_RECEIPT` and `PDC_DEPOSIT` if OD-09 landed). **Until provided:** the identical three commands run against `startDb()` in `packages/db/test/seed/phase4-pack.test.ts` and must print the same result — the pattern hazard 5 fixes, so the slice never blocks on an account.

- [ ] **Step 5: Rewrite `AGENTS.md`'s "Current phase"**

§3.8: the last task of every phase-closing slice rewrites that section. It names Phase 4 as complete, the two DoD clauses and where each is proven, the five tables and one job this phase added, the two projections and which nightly job compares each, the `Reconcilable` registry as the seam 6D and 8C plug into, and the one sentence a Phase 5 reader most needs: **`FX_REVALUATION` is the only document type in the system whose lines are base-currency amounts at rate 1, and its `custom_fields.fxKind` decides whether it is reversed at period start.**

- [ ] **Step 6: The phase report**

`docs/review/2026-09-05-phase-4-exit.md`: the re-run matrix with its results; the three ADRs and their status (each was written as a proposal — the report records whether the owner accepted, and a still-`proposed` ADR is a merge blocker for the *implementation*, not for the report); the OD-09 and OD-24 outcomes; the six regression blocks appended; and **What Phase 5 inherits** — that `1200`/`2100` tie to `party_ageing` to the cent at any as-of date, that `item_profitability` is the table 7B's "profit by item" reads and never recomputes, that a tax document's own FX difference will go through `postSettlementFxDifference` unchanged because it reads `allocation.fx_difference` and not a document type, and that `accounting.unreconciled_items` and `accounting.pdc_register` are still 7C's to ship.

- [ ] **Step 7: Commit**

```bash
git add docs/review/2026-09-05-phase-4-exit.md AGENTS.md packages/db/test/privileges.test.ts
git commit -m "docs(review): Phase 4 exit — both DoD clauses green, the re-run matrix and AGENTS.md [4B T12]

Ageing reconciles to the ledger to the cent at any as-of date, across a cross-currency month, and
a month is bank-reconciled with every receipt and payment matched or listed as unreconciled.
Tests 8 and 39 owned and passing; 1, 2, 7, 12, 13, 27 and 36 re-run over this slice's five tables,
one payload key, one job, one route module and one permission code.

The three pinned lists are re-asserted as equalities: §3.5.4's DELETE grants are unchanged,
lintSchema is at zero, and JOBS still has sixteen names — this slice added a payload key, never a name.

Step 2's privileges case is a re-assertion of an existing equality, not a new red test; the task's
Interfaces block says so, because the absence of a failing-test-first step is deliberate here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

**Against the contracts card (§2.5's 4B row).** Every deliverable the card lists has a task. `party_ageing` as an async projection rebuilt by `accounting.projection.rebuild` with a nightly rebuild-and-compare, the ageing report under **`accounting.ageing`**, tying to the **`1200`/`2100`** control accounts to the cent (T1, T3); **`item_profitability`** per company, item and fiscal period — quantity sold, revenue, COGS, margin, all in base — rebuilt from `ledger_entry` and `inventory_movement` and compared nightly with a mismatch on the incident path (T1, T4); FX difference on settlement and period-end revaluation as an **`FX_REVALUATION`** document through **`4900`/`5910`** with **`5920`** consumed via `balanceInBase`, and the first FX task asserting all three resolve (T2 Step 5, T5 Step 1); bank reconciliation with `bank_statement` + `bank_statement_line` (CSV import), `bank_match` (match/unmatch by `unmatched_at`, never altering a ledger entry), the `Reconcilable` interface generic over the four kinds, an unreconciled-items list, `reconciled balance = bank ledger balance`, and `accounting.bank.reconcile` (T2, T6, T7, T8); ⚠️ PDC as **two** isolated tasks (T9, T10); the ageing and reconciliation screens (T11). Migration range **0048–0052, all five used, five PRs**; ADR range **0046–0048**, all three written as proposals per spec:95. **Target size 12–14 tasks: 13** (T0 carries no application code, the shape 2C, 3C and 3D all used).

**This plan is longer than the 2500–4000-line guidance — about 8,500 lines — and the reason is recorded rather than hidden.** Five of the thirteen tasks carry a complete SQL function or module in full (0048's two `stable` functions, `fx.ts`, `reconciliation.ts`, `pdc.ts`, and the two screens), and hazard 35 requires the plan to repeat the code rather than gesture at it. The written peer plans in this folder run 5,400–6,500 lines for the same reason. **About 700 of those lines were added by the second review pass and about 700 more by the third**, which replaced the prose in Tasks 10 and 11 Steps 1–4, and then in Task 9 Steps 2 and 3, with the real envelopes, module, routes, DDL cases, Drizzle mirror and components: "the same shape as `fx.ts`" and "four routes" are exactly the *similar to Task N* the assignment names as a plan failure, and 3D's own OD-24 task set the precedent of shipping real `.tsx` behind an owner gate. Nothing was padded: every task's prose either states a decision a reviewer must be able to check or names a trap.

**Six things the FIRST review pass changed, all of which were in the file before it.** (1) The **per-currency ageing tie-out was asserted and is false** in a cross-currency settlement — `allocation.amount` is denominated in the *settled* document's currency and nothing denominates it in the settlement's — so amendment 4 makes the registered equality base-only, `ageingTieOut` states the unrealised term as its own column, and a same-currency case asserts the per-currency equality separately (T3 Step 2's last case). (2) **`item_profitability`'s sign came from a `REVENUE_BEARING_TYPES` type → sign map**, which is wrong for exactly half its inputs: §4.4.2 A9 says a reversal document carries *negated* line amounts, so a reversal-produced `SALES_CREDIT_NOTE` and a hand-drafted one share a code and have opposite signs. `doc_sign` now comes from the document's own ledger rows on its items' revenue accounts, and the type list is membership only (amendments 6 and 7; T4 Step 1 tests both credit-note shapes). (3) The **realised FX difference was to be posted by a later, separate call**; it now posts inside 4A's allocation handler's own transaction, because the tie-out is false between the two calls and a reader of the ageing report could observe that state (ADR 0047). (4) The **`fxKind` marker was on `document.custom_fields`, a column that does not exist** — plan0A's `app.document` DDL has no such column and §4.4.1 A6's header bag is `app.custom_field_value` rows needing a per-company definition; it is now `document_line.custom_fields.fxKind` (amendment 5). (5) **Both projection rebuilds deleted before re-inserting**, which needs a DELETE grant §3.5.4 pins to five tables with 2B as its only extender; both now `MERGE` and zero the stale keys of their own scope. (6) **`item_profitability`'s COGS came from `document_line.cost`**; it now comes from `cost_consumption` and `cost_layer`, which is 3D's source for 3D's reason — only those are rewritten by `inventory.cost.replay`, so the other reading shows the pre-recost figure for ever, and 7B re-expresses `inventory.sales_by_item` over this table so the two must agree by construction.

**Nine things the SECOND review pass changed.** These were defects in code the plan had already written out in full, which is the point of writing it out: six of them would have failed on first run, and two of those were the DoD tests themselves.

1. **`ageingTieOut` was wrong for every liability account, and the `2100` clause of its own DoD test would have failed.** `party_ageing_rows` already returns a party-oriented figure, but the function multiplied *that* column by `sign` as well as the ledger's, computing `sign × (g − l + r)`: for `2100` that reads `−1 × (2500 + 2750 − 250) = −5000`. `sign` now brings only the **ledger** columns into the ageing's orientation, and the corrected shape is stated with the worked table for both directions. Assets passed either way, which is what made it survive the first pass — the same class of defect as SAH-011.
2. **The `rev` CTE and `outstandingRevaluation` both fanned out.** `join app.document_line ol` multiplied every ledger row by the number of marked lines, and a revaluation posts a *pair*, so `revaluationBase` read **800** where 400 was posted and test 8's clause 3 would have failed. Both are now `exists`, and the note says why the two must stay identical.
3. **`postFromPack` silently dropped two options its own callers passed.** `PostFromPackOptions` had no `jobs`, so Task 4's step-14 case would have observed zero enqueues from a `postDocument` call that never received a job client; and `GOODS_RECEIPT`/`DELIVERY_ORDER` resolve `inventory.warehouse: "header.warehouse"` and would have raised a `PostingError` on the fixture's first post. Both are threaded now. *(The third pass then removed the `UPDATE` this item had introduced for `warehouseId` — 3C's `draftTypedDocument` already declares the option and already writes the column. See third-pass item 3.)*
4. **Task 4's fixture issued the same stock twice.** It posted a `DELIVERY_ORDER` *and* a `SALES_INVOICE` for the same 30 units with the comment "no movement — linked to the delivery", but nothing called `linkFulfilment` and `SALES_INVOICE` is `outbound / issue`: `quantitySold` would have been 60 and `cogsBase` 600. The base case is now the single unlinked invoice, and amendment 7's actual claim — a delivery contributes quantity and cost but never revenue — is proved as a **delta** case that needs no link semantics, which is a stronger test than the original was.
5. **The exhaustiveness test queried a column that does not exist.** `app.document_type` is keyed `(tenant_id, code)` and has no `company_id`, so `where t.company_id is not null` would have errored — and a DB-driven check could never have failed anyway, because the DB holds only what the test seeded. It now globs the **shipped seed pack** off disk through the exported `PACK_DIR`, which is what makes the guard bind on 6A.
6. **Tasks 10 and 11 were prose.** "The same shape as `fx.ts`", "four routes", "the two-column layout above" — five steps of it. All now carry the real code.
7. **`seedTypeFromPack` was insert-only** while `postFromPack` calls it on every post, so the second post of any code would have hit `unique (tenant_id, code)`. It is select-or-insert, and the gate reports whether 2A's helper was idempotent anyway.
8. **Test 8's clause 8 asserted `rate_source` on a document 1A writes.** The reversal's `rate_source` is whatever `reverseDocument` copies, which this plan has not read; the clause now excludes reversals, states why, and pins the exact count of originating documents (six, enumerated) so the exclusion cannot hide an empty set.
9. **Two smaller ones.** The `party_ageing` isolation case inserted `select … from app.party limit 1` into a seed with no party, so it asserted that tenant B could not see a row that did not exist — it now seeds the party and proves A can see its own row first. And the fingerprint used `pgcrypto`'s `digest()` where PostgreSQL 18's built-in `sha256(bytea)` does the job.

**Twelve things the THIRD review pass changed.** Eight of them would have failed on first run — four at `bun run typecheck`, three at run time inside a fixture, one silently — and two of those eight were the owned acceptance tests.

1. **`postFromPack` could not post an approval-required type at all, so acceptance test 39 never ran.** It drafted and then called `postDocument` with no `submitted → approved` step, and §4.5.1 admits `draft → issued` **only** when the effective policy has `approval.required = false`; §4.3.2 step 2 turns anything else into `ERR_DOC_STATUS_ILLEGAL`. Three fixtures depended on that: test 39's `beforeAll` posts a `PAYMENT` (§4.14: "required"), Task 5's vendor-payment FX case posts another, and Task 4's non-sale case posts an `EXPIRY_WRITE_OFF` (`approval.required: true`, phase-3d:4149). `postFromPack` now reads `policy.approval` off the same pack envelope through the new `packApproval`, submits as `s.human` and approves, issues **and posts** as a memoised second principal — R1 is checked at `issued → posted` too, so a post by the submitter would fail even with the approval done.
2. **`arApFixture` seeded neither the accounts nor the permission codes Task 4's three inventory documents need.** `2150`, `1250` and `5100` are named by code in the `GOODS_RECEIPT`, `DELIVERY_ORDER` and `EXPIRY_WRITE_OFF` policies and `seedTenantV2` creates none of them (`ERR_POLICY_REQUIRES_MISSING`); `inventory.receipt.post`, `inventory.transfer.post`/`.create` and `inventory.adjustment.approve`/`.create` are what 2B's R2 asks for **inside** the posting transaction (`ERR_RBAC_FORBIDDEN`). `ACCOUNTS` is twelve rows now and `grantCodes` seventeen codes, each annotated with the slice that owns it. The Assumptions block's fact (3) was reconciled with the result, and it was wrong about `5920` as well — `seedTenantV2` creates that one.
3. **`partyId: opts.partyId ?? null` does not type-check, and the `warehouse_id` UPDATE it justified was never needed.** 3C's frozen `DraftTypedDocumentOptions` declares `partyId?: string` and `warehouseId?: string` (phase-3c:403–414) and its body already inserts both into `app.document` (phase-3c:436–441). Both members are now spread conditionally and passed through; the `update app.document set warehouse_id = …` is gone, and with it Task 0's informational probe for the column's name — a gate reporting a fact the plan no longer acts on is noise.
4. **`new PostingError("ERR_RATE_NOT_FOUND", …)` did not compile.** 1A's `PostingErrorCode` has nine members (phase-1a:2204–2213) and no plan had widened it, while §4.3.8 has listed the code since the registry was written and `ERRORS` has carried the row since 0D. **Task 0 amendment 11** widens the union by one member and Task 5 makes the matching one-line edit to `packages/db/src/posting/errors.ts`. No cast, no second error class, no `ERRORS` change.
5. **`AgeingRowSchema` used an identifier that exists nowhere.** `MoneyAmount` is in no plan and in no register; §4.2.8's `common.ts` exports `MoneySchema`. The seven bucket columns now use a file-local `AgeingAmount` regex — 1A's own `DocumentLineSchema` already ships exactly that form (phase-1a:4638), and this slice's `accounting/bank.ts` was already using it unregistered — and **Task 0 amendment 12** registers the practice instead of leaving two undeclared deviations.
6. **`ImportError` and `BankMatchError` were unexported, code-less `Error` subclasses**, so Task 8's `422`/`ERR_BANK_MATCH_AMOUNT` assertions would have received `ERR_INTERNAL` 500 from 0B's fall-through — and `apps/api/src/problem.ts` appeared in no task's Files list, so the branch the comment promised was never going to be written. Both are exported with a `readonly code` that is a literal member of `ErrCode`, re-exported from `ar-ap/index.ts`, and translated by one private `rethrowAsAppError` in the route module — **3C's shipped pattern** (`LandedCostError`, phase-3c:2984 and 4501), which keeps `problem.ts` untouched.
7. **The sah-031 block replaced its own body with an ellipsis** and, as written, hashed `ledger_entry`, did nothing, hashed it again and asserted equality — a test that cannot fail, in the block whose whole job is the SAH-031 claim. It now seeds its own tenant inside the shared container (touching `arApFixture`'s `ensureOpenPeriods` to a shared seed would unlock `a.lockedPeriod` for every other regression file), posts a receipt into 2026-03, **locks the period after the post**, matches, and asserts both that the `bank_match` row is live and that the locked period's fingerprint is byte-identical — with `expect(before).not.toBeNull()` so the receipt's presence in the locked period is itself proven.
8. **`app.party_ageing_rows`'s `applied` CTE had no as-of guard on the settled document**, so any allocation whose settlement is dated inside the window and whose settled document is dated after it — the ordinary deposit-then-invoice sequence, and any earlier month re-run after a later allocation — was subtracted from the settlement's open figure and never added back, and the DoD `difference` was non-zero by that amount. The guard is now the mirror of `charged_off`'s, and Task 3's tie-out block ends with a case that allocates a 2026-03-25 receipt against a 2026-04-05 invoice on its **own** party (so no absolute figure elsewhere moves) and asserts `difference === "0.0000"`.
9. **Hazard 33's account assertions were self-fulfilling.** Task 2's case seeded the six accounts and then proved they resolved, and Task 5's compared `resolveFxAccounts` against ids `arApFixture` had just created — neither could detect 0C dropping a row from `0c-base.json`, which is the one failure the hazard exists to prevent. Task 2 Step 5 now reads that pack file through 0C's own `readPackFile` and checks the six codes, their types and §4.15's first-digit rule; Task 5 Step 1 points at it rather than copying it.
10. **`BankStatementLineQuery` declared a flat `unmatchedOnly` parameter**, which §4.2.8 Layer 1 forbids outright ("no slice introduces a new flat filter parameter"), and the backoffice then hand-built `?unmatchedOnly=true` outside its own `filterQuery`. It is `filter[matched][eq]` as a literal key now, with `.strict()` (1B's stated reason) and `z.enum(["true","false"])` rather than `z.coerce.boolean()` — which would have read `"false"` as `true`. The runbook's two query strings were corrected with it.
11. **Task 11 imported five type names this plan never produces, and one that belongs to `packages/db`.** `BankStatement`, `BankStatementLine`, `BankMatch` and `Reconcilable` were never declared as aliases; `@dulja/contracts` exports `MoneySchema` as a value and no `Money` type; and `Reconcilable` is a `packages/db` interface (§4.8.3) that `apps/backoffice` may not reach under §3.1. Five `z.infer` DTO aliases now sit beside their schemas and the money shape comes from 0E's `MoneyJson`, which exists for the identical layering reason.
12. **Three smaller ones.** Task 9's DDL test and Drizzle mirror were prose pointing at Tasks 1 and 6 — the *similar to Task N* the assignment names as a plan failure, and the one place the second pass missed; both are written out, and Tasks 9, 11 and 12 gained the `Interfaces` block every other task has. Task 4's first assertion carried a comment naming the `DELIVERY_ORDER` the second pass had removed from that fixture. Task 0's `seedDocumentType` probe grepped `tests/invariants/fixtures.ts`, which does not exist — 2A's helper is in `packages/db/test/fixtures.ts` (contracts §4.17) — so the probe always printed its "no" branch. And `AGEING_TEST`, a document-type code the gate required an amendment for, was used nowhere in the plan: the gate line, the header clause and the Self-Review mention are gone rather than the code being registered for nothing.

**Ten things the FOURTH review pass changed, after an independent audit read this plan against the contracts document, plan 0A, the spec and 4A's now-written plan.** Two were blockers that would have broken the build for every consumer of `@dulja/db`; one shipped a fabricated currency to the wire; the rest are consistency repairs.

1. **`packages/db/src/ar-ap/index.ts` was written as a Create, and 4A already owns it.** The File Structure marked it NEW, Task 3's Files list said *Create*, and Task 3 Step 7 wrote the file whole with only the five ageing exports, carrying the comment *"`allocation.ts` is 4A's and is re-exported from `packages/db/src/index.ts` by 4A; this barrel does not re-export it"*. 4A's written plan contradicts both halves: it creates this file in its Task 1 (phase-4a:556, :932 — *"the barrel; later tasks add their lines to it and nothing else"*), appends `./credit`, `./invoice`, `./credit-note`, `./allocation` and `./settlement` to it (phase-4a:2100, :3580, :4261, :5130, :5597), and modifies `packages/db/src/index.ts` **only** to `export * from "./ar-ap"` (phase-4a:562, :942). `allocateSettlement`, `unallocate`, `openBalance`, `partyBalance` and `listAllocations` therefore reach `@dulja/db` **through** this barrel. Writing it whole would have deleted 4A's entire AR/AP surface from the package, and `tests/invariants/support/ar-ap.ts` and `fx.ts` would both have failed to compile on their `@dulja/db` imports. It is now **Modify** in the File Structure, in Task 3's Files list and in the Contract-additions list; Step 7 appends a block below 4A's lines and says in the file's own comment that it must not be rewritten; and the gate script gained a **seventeenth** `need_repo` line on `packages/db/src/ar-ap/index.ts` for `export * from "./allocation"`, so the shape is proved before Task 3 runs rather than discovered by it.
2. **`fx.ts` and `reconciliation.ts` imported `decimal.js`, which `packages/db` does not depend on and is forbidden from importing.** 0D adds the package to **one** workspace (`bun add --cwd packages/domain decimal.js`, 0d:212; `packages/domain/package.json … deps: decimal.js`, 0d:88); 4A states the rule for this exact directory (*"no file under `packages/db/src` in this slice imports `decimal.js`. It is `packages/domain`'s dependency (§4.2.1, D11) and is not declared in `packages/db/package.json`"*, phase-4a:35) and 3B fixed it first for `packages/db/src/costing` (3b:1124). Even where workspace hoisting made the bare specifier resolve, `new Decimal(...)` would compute at the library default precision instead of 0D's **cloned constructor at precision 40**, which 0D's Global Constraint 11 forbids. Both files now `import { D, … } from "@dulja/domain"` (0D's `export { D } from "./money/decimal";`, 0d:443), every one of the twenty-six `new Decimal(x)` sites is `new D(x)`, and each file declares `type Dec = InstanceType<typeof D>` for the type positions, because 0D exports the **value** `D` and not decimal.js's type. The `sah-012` block's source assertion was updated to the new text in the same pass, so it still binds. **No `package.json` was touched** — adding `decimal.js` to `packages/db` would contradict a constraint 3B and 4A have both shipped.
3. **`ledgerLegSource` minted every `Reconcilable.amount` in a fabricated `"XXX"`.** The query deliberately joined `app.company` for `c.base_currency`, but the declared row type omitted the column and the mapper read `currency(r.currency ?? "XXX")`. `app.account.currency` is nullable (plan0A:1495, *"null = any currency"*) and 1A's `seedAccount(db, s, { code, nameEn, type })` sets none, so `arApFixture`'s `1100` row has it null and **every** unreconciled item carried `XXX` — disagreeing with the two sibling readers in the same file, `reconciledBalance` (`currency(account.currency ?? account.base_currency)`) and `importStatement` (`coalesce(account.currency, company.base_currency)`), whose agreement Task 6's own case asserts. Any `Money` arithmetic between `reconciledBalance().statement` and an entry in `.unreconciled` would have raised `ERR_MONEY_CURRENCY_MISMATCH`, and Task 8 would have shipped the fabricated code to the OD-24 screen through `ReconcilableSchema.amount`. The row type now declares `currency: string | null; base_currency: string`, the mapper coalesces, and Task 7 Step 1's `reconciledBalance` case asserts all three readers agree **and** adds the two `Money` values together, so they cannot drift apart silently again.
4. **Task 2's `0052.down.sql` carried no §3.4.5 precondition.** §3.4.5's round-3 correction ends *"The task that ships such a migration states the precondition on its rollback command"*, and 6A's `0062.down.sql` and 6B's `0063.down.sql` are the two written instances that do. Task 2 Step 3 now states it twice — as a comment block in the file, naming the 23503 the delete raises on a seeded database, why the file can remove neither the grant (forced RLS) nor discover the tenants (`app.tenant` is policy-guarded), and the operator's sequence ending in `bun run seed --tenant <id> --only roles`; and in the step's prose, with the "never disable the policy" line §3.4.5 attaches to it.
5. **The File Structure omitted Task 2's test file and mis-attributed `bank-statements.ts`.** `packages/db/test/seed/permission-phase4b.test.ts` appeared in Task 2's Files list and nowhere in the tree; and `apps/api/src/routes/accounting/bank-statements.ts` was marked `T8` although **Task 2** creates it with `BANK_PERMISSION` only, which is what makes `permission-catalogue` pass inside Task 2's own commit. Both rows are corrected, the second to `T2,T8` with the reason on the row.
6. **The re-run matrix said test 13 re-runs over "the five audited tables of this slice"; only three are audited.** §3.5.3 puts `party_ageing` and `item_profitability` in `AUDIT_EXEMPT` and Task 1 Step 5 adds them there and attaches no audit trigger. The row now names the three — `bank_statement`, `bank_statement_line`, `bank_match` (⚠️ four with `pdc`) — and says the other two must **not** appear in that suite; the `# re-run: 13` comment above the command matches.
7. **Task 1's `party-ageing.ts` mirror used `text` without importing it, and was then told to add a second import from the same specifier.** `text` now sits in the one existing `drizzle-orm/pg-core` import list between `primaryKey` and `timestamp`, and the trailing sentence says why a second `import { text } from "drizzle-orm/pg-core";` is exactly what `no-duplicate-imports` flags.
8. **The header pinned a contracts version that no longer exists.** §4.18 now reads *"(2026-09-07, extended 2026-09-08)"* and carries a **round 3** block whose §4.8.1 row is tagged `4A, 4B`. The row **ratifies** this plan rather than changing it — `partyBalance` reads the control account and negates a vendor, and *"4B's ageing DoD reads the un-flipped control balance directly"*, which is what `ageingTieOut` does. The stamp is now `2026-09-08` with that row quoted, plus the reminder that round 3 lands no 4B amendment: **Task 0's twelve are still 4B's to write and its gate still fails until they are in the file.**
9. **`PACK_ROOT` would have existed twice, with one name and two incompatible shapes.** 4A ships `export const PACK_ROOT = "seed/my";` (phase-4a:3044) — a **relative** root `readPackFile` resolves. This plan registered an **absolute** one with a trailing separator, consumed by a bare `readFileSync` concatenation and a `readdirSync` glob. The old RELATIONSHIP note told the executor to "import and re-export" 4A's where reachable, which would have produced `"seed/mydocument-types/…"` resolved against the process working directory — a **missing file at run time**, not a compile error. 4B's constant is now **`PACK_DIR`** everywhere (amendment 9, the definition and its two call sites, the re-export list, the Contract-additions row and reviewer-check (5)), the RELATIONSHIP note explains why the two are not interchangeable and forbids the substitution outright, and the PR-body reconciliation §4.17.1 is owed is still asked for. **The rename is corroborated rather than unilateral:** 5B's own Task 0 gate already reads `need_repo "tests/invariants/support/ar-ap.ts" "export const PACK_DIR"` with the note *"It is PACK_DIR and NOT PACK_ROOT: 4A's PACK_ROOT is the relative 'seed/my' readPackFile takes"* (phase-5b:344), so a downstream consumer reached the same conclusion independently and this file now satisfies that gate. 5B's `einvoice.ts` still writes `import { PACK_ROOT, arApFixture, … } from "./ar-ap";` (phase-5b:4824), which contradicts 5B's own gate; **that line is 5B's to fix and this plan does not touch it.** No other plan imports the constant: 5A, 7B and 7C consume only `seedTypeFromPack`, `postFromPack`, `arApFixture` and `packApproval` from this file.
10. **Four stale pointers, found while fixing the above.** §6.1's row 39 names T8 for acceptance test 39; the plan proves all four of its clauses in **Task 7 Step 5** and Task 8 only adds route coverage — the card bullet now says so and quotes §6.1's own word *indicative*, so no thirteenth amendment is made for a column that table declares non-binding. Inside the plan, the DoD table pointed at "Task 3 Step 8" for the tie-out (written in Step 5, asserted in Step 2), at "Task 7 Step 8" for test 39 (Step 5) and at "Task 7 Step 7" for the third-source seam (it is Task 7 Step 1's *"a third source registers without editing this slice's file"* case); and the gate script's comment on `partyBalance` said "Task 3 Step 7" when the only assertion on it is **Task 5 Step 8**, test 8's clause 6. All four now point where the code is. The two `// … every earlier member, unchanged …` lines in Task 1's `lint-schema.ts` block were reworded so no literal ellipsis stands inside a code fence.

**Contract additions — every name invented because the registers lacked one.** All **twelve** register amendments land in Task 0; nothing below is a literal in a registered namespace except the one that Task 0 amends explicitly (`1150`).

- `app.party_ageing_rows(uuid, date)` and `app.item_profitability_rows(uuid, text[])` — the two SQL functions (migration 0048, amendments 3 and 6).
- `packages/db/src/ar-ap/ageing.ts` — `AgeingBucket`, `PARTY_AGEING_BUCKETS`, `PartyAgeingRow`, `AgeingParams`, `ageingRows`, `rebuildPartyAgeing`, `comparePartyAgeing`, `AgeingTieOutRow`, `ageingTieOut`, `outstandingRevaluation`.
- `packages/db/src/reports/ageing.ts` — `agedBalance`, `AgedBalanceParams`, `AgedBalanceRow` (registered in §4.16.3 by amendment 10).
- `packages/db/src/projections/item-profitability.ts` (**a new directory**, registered by amendment 6) — `SALE_MOVEMENT_TYPES`, `NON_SALE_MOVEMENT_TYPES`, `ItemProfitabilityRow`, `itemProfitabilityRows`, `rebuildItemProfitability`, `compareItemProfitability`, `ITEM_PROFITABILITY_CHECK`, plus `packages/db/src/projections/index.ts`.
- `packages/db/src/ar-ap/fx.ts` — `FX_REVALUATION_CODE`, `FX_ACCOUNT_CODES`, `FxAccounts`, `resolveFxAccounts`, `postSettlementFxDifference`, `settleWithFx`, `RevaluationResult`, `revalueAtPeriodEnd`, `reverseRevaluation`, and the private `draftAndPostFx` / `fxPair`.
- `packages/db/src/ar-ap/reconciliation.ts` — `CsvMapping` (**the §4.8.3 detail the register left open**), `parseDelimited`, `importStatement`, `BankStatementRow`, `BankStatementLineRow`, `listStatements`, `listStatementLines`, `Reconcilable`, `ReconcilableSource`, `registerReconcilableSource`, `reconcilableSources`, **`RECONCILABLE_DIRECTION`**, `BankMatchRow`, `match`, `unmatch`, `unmatchedStatementLines`, `reconciledBalance`, the private `ledgerLegSource`, and the **exported** `ImportError` / `BankMatchError` — exported because `apps/api` writes `instanceof` against them, each with a `readonly code` that is a literal member of `ErrCode` (3C's `LandedCostError` shape).
- ⚠️ `packages/db/src/ar-ap/pdc.ts` — `PDC_ACCOUNT_CODE`, **`PDC_RECEIPT_CODE`**, **`PDC_DEPOSIT_CODE`**, `PdcStatus`, `PdcRow`, `draftPdcReceipt`, `depositPdc`, `bouncePdc`, `listPdc`, and the private `PdcAccounts` / `resolvePdcAccounts` / `PdcLine` / `draftAndPostPdc` (all dropped with OD-09).
- `packages/db/src/ar-ap/index.ts` — **not a creation: 4A's barrel, appended to.** 4A creates it (phase-4a:556) and `packages/db/src/index.ts` re-exports `./ar-ap` (phase-4a:562), so `allocateSettlement`, `unallocate`, `openBalance`, `partyBalance` and `listAllocations` reach `@dulja/db` through it. Tasks 3, 5, 6, 7 and ⚠️ 9/10 each append one export block below 4A's lines and rewrite nothing; Task 0's seventeenth `need_repo` line fails the gate if the file or 4A's `./allocation` line is missing.
- `packages/contracts/src/accounting/reports.ts` — `AgeingRowSchema`, `AgeingRowDto`, `AgeingList`, `AgeingQuery`, `AGEING_FILTER_FIELDS` and the file-local `AgeingAmount` (amendment 12); `accounting/bank.ts` — `CsvMappingSchema`, `ImportStatementBody`, `BankStatementSchema`, `BankStatementList`, `BankStatementLineSchema`, `BankStatementLineQuery`, `BankStatementLineList`, `ReconcilableKindSchema`, `CreateBankMatchBody`, `UnmatchBody`, `BankMatchSchema`, `ReconcilableSchema`, `ReconciledBalanceSchema`, the file-local `Amount`, and the five DTO aliases the OD-24 screens import — `BankStatementDto`, `BankStatementLineDto`, `BankMatchDto`, `ReconcilableDto`, `ReconciledBalanceDto`; `accounting/fx.ts` — `RevalueBody`, `RevaluationResultSchema`; ⚠️ `accounting/pdc.ts` — `PdcStatusSchema`, `CreatePdcBody`, `DepositPdcBody`, `BouncePdcBody`, `PdcSchema`, `PdcList`.
- `packages/db/src/posting/errors.ts` — **one member added** to `PostingErrorCode`, `"ERR_RATE_NOT_FOUND"` (amendment 11), and nothing else in that file. `apps/api/src/routes/accounting/bank-statements.ts` — `BANK_PERMISSION`, `bankStatementRoutes`, `bankStatementRouteModule`, the private `requiredFilter` and `rethrowAsAppError` (**`apps/api/src/problem.ts` gains no branch**); ⚠️ `pdc.ts` — `pdcRoutes`, `pdcRouteModule`.
- `apps/worker/src/handlers/accounting-projection-rebuild.ts` — `accountingProjectionRebuild`.
- ⚠️ Backoffice (OD-24, dropped with Task 11): `apps/backoffice/src/lib/ar-ap-api.ts` — `fetchAgeing`, `AgeingResponse`, `fetchStatements`, `fetchStatementLines`, `fetchReconciliation`, `ReconciliationResponse`, `postMatch`, `postUnmatch`, and the private `filterQuery` (**the one place in the backoffice that composes §4.2.8's filter grammar**); `src/routes/accounting/ageing.tsx` and `bank-reconciliation.tsx` each export the TanStack `Route` and keep `pivot`, `footer` and their row types file-local. **`ageing.tsx` reads five `@dulja/ui` components (`DataGrid`, `DateField`, `MoneyText`, `SegmentedControl`, `Toolbar`) and the reconciliation screen three more (`AccountPicker`, `ProblemAlert`, `SelectList`) — 0E owns all eight and this slice adds none**; any that 0E did not ship is a 0E reconciliation, not a component invented here.
- Test tier: **`tests/invariants/support/ar-ap.ts`** with **`PACK_DIR`**, `DocumentTypeEnvelope`, the private `readEnvelope`, `seedTypeFromPack`, **`PackApproval` / `packApproval`** and the private `approverFor` (the approval path), `PostFromPackOptions` (including its `jobs` and `warehouseId` members), `postFromPack`, `ArApFixture`, `arApFixture` (§4.17.1, amendment 9). **This file is 4B's and 4A's `tests/invariants/support/post-ar.ts` is 4A's; Task 0's RELATIONSHIP note says which task calls which and why both exist.** the file-local `seedArApAccounts`, `ledgerFingerprint` and `ctxFor` repeated where needed. **`ledgerFingerprint` appears in test 39 and in the sah-031 and sah-041 blocks and is a §4.17.1 candidate the catalogue should place** — it is named here rather than invented as a shared helper, because hazard 9 assigns that decision to the register.
- Documents: `docs/decisions/od-09-4b-post-dated-cheques.md`, `docs/runbooks/bank-reconciliation.md`, `docs/review/2026-09-05-phase-4-exit.md`, `docs/owner/od-24/4b/`, `scripts/check/contracts-4b-amendments.sh`.

**Against the never/always lists.** Five tables are created (four unconditional, `pdc` behind OD-09) and every one carries `tenant_id`, forced RLS, a policy named exactly `tenant_isolation`, `created_at`, a hand-written down and a two-tenant test in its own task; the two projections join `NO_ID_TABLES` and `AUDIT_EXEMPT` to exactly §3.5.3's state and nothing else in `lint-schema.ts` moves. Every endpoint has a Zod schema, an OpenAPI entry regenerated in the same commit, idempotency on every unsafe method and a probe on the one new module. No `ledger_entry`, movement, layer, `account_balance`, `stock_on_hand` or `tax_transaction` write happens outside `posting/` and `costing/` — every FX and PDC service drafts `document` + `document_line` and calls `postDocument`, and the two projection rebuilds write only their own tables, which §3.7.5 excludes from `posting-only-tables` by name. No `number` holds money; every tie-out sums through `Money.add` or SQL `sum(...)::text`. No `sql.unsafe`, no string-concatenated SQL, no DDL from application code, no disabled invariant, no enum label added. Every commit message carries the trailer.

**Against §4.4.2's A9.** No line of this slice reads the sign of a **planned** amount to choose a direction — this slice plans no ledger line at all: the evaluator does, from `document_line.debit`/`credit` that the drafting services write as non-negative magnitudes. The three places a sign *is* read are drafting decisions over stored figures, each named in Global Constraint 6: `allocation.fx_difference`'s sign and a revaluation delta's sign choose which side of a `document_line` the subject account goes on (`fxPair`), and a statement line's sign chooses which `reconcilable_kind` may match it (`RECONCILABLE_DIRECTION`). `bank_match.amount` carries `check (amount > 0)` for the same reason `ledger_entry.debit` does. `PlannedTaxLine` stays signed and this slice plans no tax line — `FX_REVALUATION` and both PDC types declare `tax.applies: false`.

**Against the hazards.** **1** and **2**: no statutory rate and no MyInvois detail appears; every rate in every fixture is an invented round figure with `source: 'manual:test'`. **4**: `accounting.ageing` ships here rather than being deferred to Phase 7, and `item_profitability` backs the report 3D and 4A shipped under one code. **5**: Task 12 Step 4 is the owner-account pattern with its exact command and its local equivalent. **6**: OD-09 is two isolated tasks and OD-24 one, all three droppable without renumbering a neighbour's interface. **8** and **9**: every 0A helper is cited by its exact name; `fixtures.ts` gains **nothing**; §4.17.1 gains one registered file. **11**: three new closed vocabularies, all `text` + a named CHECK. **13**: `lint-schema.ts` is edited once, to exactly §3.5.3's state. **14**: all five allocated migration numbers are used and none is borrowed. **15**: root `tests/` and every service use the production `withTenant`; only `packages/db/test` uses the 4-argument one. **20**: the job runs as the system principal through `systemContext`, one company per transaction. **22**: see the never-list paragraph. **23**: every base conversion is `round(value × rate, 4)` `HALF_AWAY_FROM_ZERO`, and the sah-019 block asserts no local `round` exists. **24**: no handler inserts a `document_event`; the FX reversal goes through `reverseDocument`. **25**: the DELETE list is re-asserted as an equality in Task 12. **26**: one code, from the register. **29**: Task 11 begins with OD-24 and states its two keyboard additions so a reviewer can compare them to the owner's material. **31**: one new route module, one new `PROBES` key, one new `JOB_PROBES` entry; the ageing `GET` and the revaluation `POST` are sub-paths and inherit existing keys. **32** and **33**: every literal comes from a register; the six accounts this slice consumes are asserted, never re-seeded, and `1150` is a Task 0 amendment dropped with its task. **34**: all three seed files are envelopes with `module` outside `policy`. **35**: every task has exact paths, real code, a failing test first and a commit — with the one stated exception of **Task 12**, a phase-exit task whose only new assertion is a re-assertion of an existing pinned equality, said so in its own Interfaces block rather than left for a reviewer to notice.

**Seven things a reviewer should check that this plan cannot prove on its own.** (1) **4A's `allocation.fx_difference`.** Every figure in Task 5 and test 8 assumes 4A stores "settlement base − settled base"; the *tie-out* holds for any value (ADR 0047's table), but the specific `40.0000` and `80.0000` assertions do not. If they fail by a consistent figure, read `allocateSettlement` and reconcile with 4A — never adjust `postSettlementFxDifference`, which correctly posts whatever is stored. (2) **4A's `partyBalance().byCurrency`.** Test 8 clause 6 asserts the ageing's per-currency view and 4A's `base` member only, because a ledger-derived `byCurrency` legitimately disagrees with an open-item one in a cross-currency month (ADR 0046). If 4A's plan claims `byCurrency` is an open-item view, that is a 4A/4B reconciliation and this plan's clause 6 is the more conservative half. (3) **Whether 4A's allocation route exists.** Task 5 Step 7 edits the handler Task 0's gate names; if the gate found none, raise rather than adding a second settlement endpoint. (4) **3C's `document_link` triggers.** Task 0's second informational line says whether migration 0037 put a trigger on that table; if it did, Task 5's direct `'settles'` insert must go and the `fxKind` probe stands alone — the idempotency behaviour is unchanged either way. (5) **What shape 4A's `PACK_ROOT` actually is.** 4A ships `packages/db/test/ar-ap/_support.ts` with a `PACK_ROOT` of its own (phase-4a:137, :3044) and this file registers **`PACK_DIR`** at `tests/invariants/support/ar-ap.ts` (amendment 9). The two names differ because the two **values** differ: 4A's is the relative `"seed/my"` that `readPackFile` resolves, 4B's is an absolute directory with a trailing separator that `readFileSync` and `readdirSync` consume directly. The RELATIONSHIP note after Task 0's script spells out why importing 4A's into `ar-ap.ts` would fail as a **missing file at run time** and not as a compile error. **Confirm 4A's spelling before writing `ar-ap.ts`** — if 4A's constant turns out to be absolute after all, say so in the PR body and let §4.17.1 collapse the two; do not silently rename 4B's, because Task 4's exhaustiveness guard globs `PACK_DIR` and Task 3's `readEnvelope` concatenates onto it. **The neighbouring question is `postArDocument` and it is already answered:** 4A's helper takes a resolved `documentTypeId` and an opt-in `twoPrincipal` flag and has no `jobs`, `warehouseId` or `allocate`, so `postFromPack` is not it and neither replaces the other — the RELATIONSHIP note says which task calls which. (6) **Whether 2A's `seedDocumentType` is idempotent.** `seedTypeFromPack`'s select-or-insert makes it not matter, and Task 0's third informational line records which it was — the guard stays either way, because `postFromPack` calls it on every post and a future 2A change must not be able to break every fixture in this slice. (7) ⚠️ **Whether 0B's `RequestContext` carries `branchId`** (OD-09 only). Task 10's `POST /pdc` reads `c.var.ctx.branchId` because `draftPdcReceipt` needs a `branch_id` for §4.3.2 step 10's `BRANCH` tag. If 0B does not carry it, `CreatePdcBody` gains a required `branchId` and the screen sends it. This is deliberately **not** gated in Task 0: Tasks 9 and 10 do not run unless OD-09 returns yes, and if it does, the typecheck finds this before any test runs.

**Deliberately not in this slice.** No `ReportDefinition`, no `DatasetId` member, no `packages/db/seed/my/reports/4b/` directory — 7A builds the engine and 7C re-expresses `accounting.ageing` at `version = 2`. No `accounting.unreconciled_items` and no ⚠️ `accounting.pdc_register` report code: both are §4.16.1's rows for **7C**, and this slice ships the unreconciled list as `reconciledBalance().unreconciled` behind a `GET`. No `till_banking` and no `payroll_batch` source — 6D and 8C each add one `registerReconcilableSource` call and edit no file here. No unrealised-FX balance-sheet account of its own: the revaluation posts to the control account, and a separate account would be a new §4.15 row and an amendment. No maturity job for PDCs: `JOBS` is closed at sixteen names. No credit control, no allocation and no payment term — all 4A's. No revaluation of inventory, revenue or expense accounts: inventory is carried in base and a non-monetary balance has no exposure.

---

## Execution handoff

**Read before starting.** This plan's Assumptions block, all of §3 of the contracts document, §4.8 in full, and §4.4.2's sign-normalisation section. Then Task 0 in full: it is a gate, not a formality, and **Task 1 does not start until `bash scripts/check/contracts-4b-amendments.sh` exits 0**. Its two informational lines change what Tasks 3 and 5 do, so read them rather than skimming past them, and the RELATIONSHIP note after the script decides which of two shared test helpers each later task calls.

**Order and independence.** **T0 → T1 → T2** are strictly sequential. Then **T3 → T4** (T4 registers into the job T3 created and moves the array T3's tests read), and **T6 → T7 → T8** (0050 needs 0049; the routes need both). **T5 needs T3** (it calls `ageingRows` and `ageingTieOut`) and nothing else, so **T5 may run in parallel with T6/T7** if two engineers are working. **T9 → T10** are OD-09's pair and depend only on T2 and T3's fixture. **T11 is gated on OD-24 and blocks nothing.** T12 is last by definition.

**One migration per PR (spec:2057).** Five migrations, five PRs: T1 (0048), T2 (0052), T6 (0049), T7 (0050), T9 (0051 ⚠️). Nothing else in the plan adds DDL. Tasks 3, 4, 5, 8, 10, 11 and 12 may be grouped by whatever review cadence the team runs, but a task is never split across PRs — its failing test and its implementation land together.

**Three ADRs are written as proposals and must be accepted before their implementation merges** (spec:95): 0046 (T3, T4), 0047 (T5), 0048 (T6, T7). A still-`proposed` ADR blocks its own tasks' merge, not the plan.

**Where to stop and raise rather than working around.**

- A `MISSING (repo):` line from Task 0's gate. That is a reconciliation with 4A, 3B, 3C or 3D, and **the owning plan is the authority for what it exports** (§4.18). Correct *this* plan's import path or name; never add a second spelling.
- **`packages/db/src/ar-ap/index.ts` missing, or missing 4A's `export * from "./allocation"`.** That is the seventeenth `need_repo` line, and it is a hard stop rather than a note: 4A owns that barrel, `packages/db/src/index.ts` re-exports `./ar-ap` and nothing beneath it, and every 4A AR/AP name reaches `@dulja/db` through it. **Tasks 3, 5, 6, 7 and ⚠️ 9/10 append an export block below 4A's lines and never rewrite the file** — a whole-file write here deletes 4A's surface from the package and breaks `tests/invariants/support/ar-ap.ts`, `fx.ts` and every 4A consumer at `bun run typecheck`. If 4A spells its line differently, fix the gate's literal; if the file is absent, 4A has not landed and no task past T2 may start.
- **A `decimal.js` import anywhere under `packages/db/src`.** It is `packages/domain`'s dependency (§4.2.1 D11, 0d:212) and is not in `packages/db/package.json`; 3B fixed this for `costing` (3b:1124) and 4A restated it for `ar-ap` (phase-4a:35). `fx.ts` and `reconciliation.ts` use **0D's cloned precision-40 constructor** `D` from `@dulja/domain` and the file-local `type Dec = InstanceType<typeof D>`. **Never resolve a failure here by adding `decimal.js` to `packages/db/package.json`** — if `D` turns out not to be re-exported from `@dulja/domain`'s barrel, that is a 0D reconciliation to raise (0d:443 says it is), and the alternative is to route the arithmetic through `Money` / `Money.toDecimal()` as 3B's costing engine does.
- **No handler calling `allocateSettlement` anywhere in `apps/api`.** Task 5 Step 7's edit has no target. Do **not** add a second settlement endpoint — that is two doors onto one operation and the tie-out would be false through one of them. Raise it as a 4A gap.
- **`allocation.fx_difference` is always `0` on a cross-currency allocation.** 4A is not computing it. The tie-out will still read `0.0000` (ADR 0047's table), so the DoD survives — but the FX gain is not being recognised, and that is a 4A correctness bug, not a 4B one. Raise it; do not compute it here.
- **Test 8's clause 3 reading a revalued base that is not `amountCcy × rate`.** Either `app.rate_for` returned a rate for the wrong date (check the `effective_from` of the five seeded rows) or `ageingRows` returned the ledger's per-currency figure rather than the open item's. The second is the serious one: re-read `app.party_ageing_rows`'s `applied` CTE, which is what makes the settlement's consumption `base_amount + fx_difference`.
- **`ERR_LEDGER_UNBALANCED` from an FX document.** `fxPair` always emits a balanced pair, so this means `balanceInBase` appended an `fx_rounding` line and the residue exceeded its tolerance — which for a base-currency document at rate 1 should be impossible. Read `resolveFxAccounts`' `fx_rounding_account_id` result before anything else.
- **`posting-only-tables` firing on `packages/db/src/projections/item-profitability.ts` or on `ar-ap/ageing.ts`.** §3.7.5 excludes all three async projections from that rule's table list **by name**; if it fires, the rule's list has drifted from the register and *that* is the finding. Never add a suppression.
- **A `permission-catalogue` failure at Task 2 reading "code introduced in 4B has no reference".** Task 2 Step 4's third file is what satisfies it, in Task 2's own commit. Run it; never defer it to Task 8 and never add a lint suppression.
- **Any proposal to give `party_ageing` a `role` or `control_account_id` column**, so the AR and AP sides can be split without joining `party`. §4.6.1's row is frozen at five key columns; the split comes from `party.kind` and `ageingTieOut` already reports per control account. A column here is a contracts amendment first.
- **Any proposal to revalue party control accounts from `account_balance` instead of from the open items.** It restates receivables that allocation has already settled, and it breaks the tie-out in exactly the cross-currency case the DoD is about. ADR 0047 derives this; do not re-open it as a performance question.
- **Any proposal to put a `party_id` on an `FX_REVALUATION` document.** It turns the FX document into an open item and breaks the tie-out by exactly the FX amount. The party is on the lines' `custom_fields.partyId`.

**The two commands that must be green after every task.** `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck` and `bun run test`, both at the repository root. `lint:rules` is the one that catches this slice's likeliest mistakes: a `db.` outside `withTenant`, a permission code with no reference, and a projection write the `posting-only-tables` list has drifted onto.

**What Phase 5 and later phases inherit, so nobody has to re-derive it.**

- **`1200` and `2100` tie to `party_ageing` to the cent at any as-of date**, through `ageingTieOut`, and the equality survives a cross-currency month only because the realised FX difference posts in the allocation's own transaction. A slice that adds a settlement path must call `settleWithFx`, not `allocateSettlement`.
- **`item_profitability` is the table 7B's `inventory.profit_by_item` reads and never recomputes**, and `SALE_MOVEMENT_TYPES` is the one list that decides what counts as a sale. **6A appends `"POS_TICKET"` to it in the PR that seeds that type**, and Task 4's exhaustiveness test fails until it does.
- **`registerReconcilableSource` is the whole seam for 6D and 8C.** Copy `ledgerLegSource`: list from the ledger's bank leg on the statement's own `bank_account_id`, with `valueDate = effective_date` and `amount` a magnitude. The `reconcilable_kind` CHECK already admits `till_banking` and `payroll_batch`, so neither slice needs a migration.
- **`FX_REVALUATION` is the only document type whose lines are base-currency amounts at `exchange_rate = 1`**, and `document_line.custom_fields.fxKind` decides whether it is reversed at period start. A tax or payroll slice that needs an FX difference of its own posts through `postSettlementFxDifference`, which reads `allocation.fx_difference` and knows nothing about document types.
- **`accounting.projection.rebuild` rebuilds both projections and compares only `party_ageing`.** `item_profitability` is compared by 1B's `accounting.ledger.integrity_check` through `projectionChecks`, and `projections.checked` is now five members. A slice adding a current-state projection registers a `ProjectionCheck`; one adding an as-of snapshot compares it in its own job, the call 3B's ADR 0039 and this slice's ADR 0046 both made.
- **`accounting.unreconciled_items` and ⚠️ `accounting.pdc_register` are still 7C's**, over `bank_statement_line`, `bank_match` and `pdc` — all three already in 7A's ≤ 0058 `DatasetId` set, so 7A adds no member for them either.

