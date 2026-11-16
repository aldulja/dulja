# Dulja Phase 3D — Sales orders and delivery orders, two-step transfers, stock counts, expiry write-off, inventory reports and screens

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 3 by shipping the six outbound and adjustment document types the inventory module still owes — `SALES_ORDER`, `DELIVERY_ORDER`, `TRANSFER`, `TRANSFER_RECEIPT`, `STOCK_COUNT`, `EXPIRY_WRITE_OFF` — as configuration over the existing posting service, proving this slice's two definition-of-done clauses (*"a stock count posts only the variance"* and *"goods in transit are in neither warehouse's on-hand and in the company's total"*), completing acceptance test 7 (one costing answer for an item that has been transferred, gone negative through an explicit override, and been supplier-returned), and shipping the three minimal inventory reports spec:2300 requires from Phase 3 onward.

**Architecture:** Nothing in this slice computes a cost, writes a movement or invents a posting path. Every one of the six types is a **seed-pack envelope** (`packages/db/seed/my/document-types/<CODE>.json`, §4.3.7) whose `policy` drives 2A's `evaluatePolicy` and 3B's `applyMovements` through 1A's frozen `postDocument`. The slice's own code is three thin seams: (1) **the variance shape** — a `document_line` carrying `counted_quantity` and `expected_quantity` has a *signed* `quantity` (`counted − expected`), which is what makes "post only the variance" a policy fact rather than a special case, and which the frozen `posting-policy.schema.json` already anticipates through its `when: { "line.quantity_sign": … }` key; (2) **drafting services** in `packages/db/src/inventory/` that build a target document from a source document (`SALES_ORDER` → `DELIVERY_ORDER` with FEFO lot resolution, `TRANSFER` → `TRANSFER_RECEIPT`) and snapshot `expected_quantity` from `stock_on_hand`, always writing `document_line.warehouse_id` explicitly; (3) **three read functions** in `packages/db/src/reports/` shaped exactly like 1B's `trialBalance`/`accountLedger`, mounted as three `GET`s on 1B's existing reports module so 7B can replace their bodies under the same codes. **This slice adds no route module and no `PROBES` entry** — every endpoint is a sub-path of 1A's generic `documents` module (§4.2.7) or a `GET` on 1B's `reports` module.

**Tech Stack:** Bun 1.4 (install, scripts, the API entrypoint) · Node 24 LTS (runs Vitest) · TypeScript strict · PostgreSQL 18 (Testcontainers `postgres:18`) · `postgres` (postgres.js) tagged templates · Drizzle ORM mirrors for reads · Hono + `@hono/zod-openapi` · Zod · `decimal.js` behind `@dulja/domain`'s `Money`/`Quantity` · React 19 + `@dulja/ui` + i18next (the OD-24 screens) · Vitest + Testcontainers · Playwright (the both-directions re-run of test 23) · oxlint + oxfmt · Turborepo.

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §0.2 (spec:97–108), §3.0.3 rows Multi-branch stock and Batch/lot (spec:1021–1022), §3.0.4 rows 1050–1054 and the Inventory core row (spec:1048), §3.4 costing in full (spec:1208–1228), §3.7.3 Stock paragraph (spec:1308), §3.8 immutable and derived lists (spec:1370, 1979–1993), §3.9 Quantities/Naming/Deletion/Error codes (spec:2037–2053), §4.2.1 `inventory.*` codes and the `warehouse` / `branch_manager` rows (spec:2148, 2159–2160), §4.2.2 R1 STOCK_COUNT and R2 (spec:2172–2173), §4.11 engineering practice (spec:2258–2266), Part V Phase 3 row and the reporting sequencing note (spec:2289, 2300), Part VI tests 7, 15, 18, 23, 31 (spec:2425, 2433, 2436, 2441, 2449), Part I SAH-009 (spec:286), SAH-017 (spec:361), SAH-018 (spec:374), SAH-048.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 3D — Sales orders and delivery orders, two-step transfers, stock counts, expiry write-off, inventory reports and screens. **Phase:** 3. **Phase gate:** this plan starts only when **3C** is merged (and therefore 3A and 3B before it) and Phase 2's definition of done is green in CI (spec:87).
- **Depends on (merged):** 0A helpers by exact name — `startDb`, `Db`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `Seed`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.current_tenant`. 0B — `createApp`, `AppDeps`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `requirePermission`, `assertRouteGates`, `AppError`, `ERRORS`, `Problem`, `fromDatabaseError`, `createLogger`, the production `withTenant(sql, ctx, fn)`, `startApi`, `TEST_ISSUER`, `PROBES`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `problemOf`, `fullRegression`, `sourceFiles`, `REPO_ROOT`, `repoFile`, `encodeCursor`, `decodeCursor`, `ListEnvelope`, `ListQuery`. 0D — `Money`, `currency`, `Quantity`, `round`, `MONEY_SCALE`, `QUANTITY_SCALE`, `rational`, `JobClient`, `startWorker`, `seedBranch`. 0C — the seed CLI, `PackLoader`, `readPackFile`, `assertPackShape`. 0E — `packages/ui`, `packages/i18n`, `bootLocalStack`. 1A — `postDocument`, `issueDocument`, `loadSnapshot`, `resolvePolicy`, `reverseDocument`, `PostResult`, `PostingError`, `seedTenantV2`, `seedAccount`, `loadDocumentTypes`, `documentTypesLoader`. 1B — `trialBalance`, `accountLedger`, `postJournal`, `registerProjectionCheck`, `ReportCodeSchema`, `reportsRouteModule`. 2A — `evaluatePolicy`, `parsePolicy`, `validatePolicy`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PlannedMovement`, `PostingPlan`, `requireDocumentPermission`, `DOCUMENT_STAGE_CODES`, `POLICY_RESOLVED_CODES`, `seedParty`, `seedDocumentType`, `DocumentLineInput`. 2B — `transitionDocument`, `recordOverride`, `stageCode`, `grantCodes`, `app.principal_has`, `app.document_event`. 2C — `MODULE_READ_CODE`, `requireDocumentModuleRead`. 3A — `app.item`, `app.warehouse`, `app.lot`, `app.unit_of_measure`, `app.inventory_movement`, `app.stock_on_hand`, `app.pick_lots_fefo`, `app.assert_stock_available`, `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot`, `inventory.negative_stock.override`, the `inventory` row of `MODULE_READ_CODE`. 3B — `costingEngine`, `CostingError`, `MIN_MEANINGFUL_QTY`, `CostingInput.allowShortfall`, `applyMovements` (full body), `invalidateFrom`, `replay`, `openLayersFor`, `valuationAsOf`, `ValuationParams`, `ValuationRow`, `openLayersOf`, `CostLayerRow`, `rebuildStockValuation`, `VALUATION_PAGE`, `valuationRoutes`, `valuationRouteModule`, `ValuationRowSchema`, `ValuationQuery`, `ValuationList`, `app.cost_layer`, `app.cost_consumption`, `app.stock_valuation`, `company.costing_method`, `COST_ADJUSTMENT`, the `inventory.cost.replay` and `inventory.projection.rebuild` jobs, and the test-tier helpers `postInventoryDocument`, `PostInventoryOptions`, `InventoryLine`, `postOverriddenIssue`, `recordingJobs`, `ensureOpenPeriods`, `costingContext`. 3C — `app.document_link`, `app.document_open_quantity`, `linkFulfilment`, `listLinks`, `openQuantity`, `LinkKind`, `FulfilmentLineInput`, `LinkFulfilmentInput`, `DocumentLinkRow`, `OpenQuantityRow`, `landedCostAllocation`, `ERR_DOC_LINK_OVER_FULFILLED`, `PURCHASE_ORDER`, `SHIPMENT`, `GOODS_RECEIPT`, `PURCHASE_RETURN`, the `2150` / `1310` / `5100` chart rows, and the `fixtures.ts` helper **`draftTypedDocument(db, s, opts) → { documentId, lineIds }`** with its `DraftLine` shape.

  ⚠️ **Three names the 3D card's prose and this plan's first draft got wrong, corrected here against the written 3C and 3B plans, which are the authority for what they export (§4.18's rule).** 3C ships **`linkFulfilment` / `listLinks` / `openQuantity` from `packages/db/src/documents/link.ts`** — *not* `createDocumentLink` / `documentOpenQuantity`, and *not* from `packages/db/src/document-link/index.ts`; `documentOpenQuantity` is the name of the **Drizzle view mirror** in `packages/db/src/schema/document-open-quantity.ts` and nothing else. And **`ValuationParams` / `ValuationRow` / `valuationAsOf` are 3B's**, in `packages/db/src/costing/valuation.ts`; 3B's own plan states "3D's report reads `valuationAsOf`; it does not re-derive anything", so **this slice writes no valuation read function and no second `ValuationRow`** (hazard 9). And **`pickLotsFefo` / `FefoPick` are exported from `packages/db/src/inventory/lots.ts`** (3a:114, 3a:6534, 3a:6795) — **3A ships no `fefo.ts`**, and an earlier draft of this plan imported one. Task 0's gate script checks all four by their real names and paths, the fefo one as a `need_grep` on the TypeScript file rather than only on migration 0031.
- **Migration numbers:** **0040–0043** — `0040_alter_document_line_add_counted_columns.sql` (T1), `0041_seed_permission_phase3d.sql` (T2), `0042_add_inventory_report_index.sql` (**T10** — the File Structure and the definition-of-done table both put the reports in Task 10; an earlier draft of this line said T11 and was wrong), each with its hand-written `NNNN.down.sql`. **0043 is allocated to this slice and left unused** — §3.4.1 says unused numbers stay unused and `discover()` sorts whatever exists; no slice borrows it. **ADR numbers:** 0042–0043 — **0042** *Variance documents in the frozen posting-policy schema* (written **as a proposal**, spec:95: it touches money semantics — the signed variance quantity, the evaluator's effect flip, the two-quantity transfer and the `applyMovements` fill rules); **0043** *In-transit warehouse resolution and the two-step transfer protocol*.
- **Interfaces consumed:** §4.1 (the Plan 0A surface), §4.2.2 (`withTenant`, `TenantContext`), §4.2.3 (`AppEnv`, `Logger`), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`, `PostingError`), §4.2.5 (`PERMISSION`, `PermissionCode`, `requirePermission`, `ROLES`, `INCOMPATIBLE_PAIRS`), §4.2.7 (`RouteModule`, `buildRoutes`, `IdempotencyHeader`, `createApp`), §4.2.8 (the common schemas, the list envelope, the one filter convention), §4.2.9 (`idempotency`), §4.2.12 (`startApi`, `ApiRequest`, `StartedApi`), §4.2.13 (`SubPack`, `readPackFile`), §4.3.1 (`postDocument`, `loadSnapshot`, `resolvePolicy`, `reverseDocument`, `transitionDocument`, `recordOverride`), §4.3.2 (the fixed posting algorithm, steps 6, 8, 9, 10, 12), §4.3.4 (`document_line` and the `document` header additions), §4.3.5 (`posting_seq`), §4.3.6 (numbering at issue), §4.3.7 (the document-type seed envelope), §4.4.1 (`posting-policy.schema.json` — consumed **unchanged**, same `$id`, same `"version": 1`), §4.4.2 (`evaluatePolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PlannedMovement`, sign normalisation A9), §4.5.1 (legal transitions), §4.5.2 (`document_event`), §4.5.3 (overrides, `app.principal_has`), §4.5.4 (`requireDocumentPermission`, `DOCUMENT_STAGE_CODES`), §4.5.6 (Form A″ and Form C — consumed as a *future* attachment by 6C; 3D attaches nothing), §4.6.1 (the table register), §4.7.1 (`CostingEngine`), §4.7.2 (`applyMovements`), §4.7.3 (`inventory_movement`, `stock_on_hand`, `cost_layer`, `cost_consumption` and the `stock_on_hand` MERGE), §4.11.1 (`ReportDefinition` — for the shape 7B re-expresses these three reports into), §4.14 (document-type codes), §4.15 (account codes), §4.16.1 / §4.16.3 (report codes and the Phase 1 report surface), §4.17 / §4.17.1 (the two helper registers).
- **Interfaces produced:** the six §4.14 rows `SALES_ORDER`, `DELIVERY_ORDER`, `TRANSFER`, `TRANSFER_RECEIPT`, `STOCK_COUNT`, `EXPIRY_WRITE_OFF` as seed-pack envelopes; the §4.3.4 `document_line` additions `counted_quantity` and `expected_quantity` (migration 0040); the §4.15 rows `1250` and `5110`; the §3.6.2 codes `inventory.transfer.create`, `inventory.transfer.post`, `inventory.count.create`, `inventory.adjustment.create`, `inventory.adjustment.approve`, `accounting.sales.create`; the §4.16.1 report codes `inventory.stock_on_hand`, `inventory.valuation`, `inventory.sales_by_item` and the read functions behind them. Everything else is listed under *Contract additions* in the Self-Review and lands through **Task 0**.
- **Owner decisions:** **OD-05** (every ⚠️ row in §3.0.3/§3.0.4 — for this slice the **Multi-branch stock** row, spec:1021) → **Task 12**, isolated; default: the spec text as written (a warehouse per branch, transfers between them, stock and margin per branch), built as designed. **OD-24** (screenshots + a two-minute operator description before any screen) → **Task 13**, isolated; default: the screen task is blocked, the slice is not. **OD-06** (costing method) is 3B's and is consumed here through `company.costing_method` without re-gating; **OD-07** (serials) is 3A's and no line of this slice references `serial_unit`.
- **Part VI tests owned / re-run:** **owns 7** (one costing answer — Task 11). **Re-runs:** **31** (segregation of duties on `STOCK_COUNT` — Task 8), **18** (the negative-stock override path on a real sale — Task 6), **15** (a document type added with zero code, in the inventory domain — Task 8), **23** (screens in both text directions — Task 13), **2** and **36** (the projection rebuild and the permission catalogue, over this slice's rows and codes — Tasks 2 and 14). **§3.0.4 rows owned:** spec:1050 (sales/purchase orders — the sales half; 3C contributed `PURCHASE_ORDER`), spec:1051 (delivery order, document half; 4A adds the invoice link), spec:1052 (stock count), spec:1053 (two-step transfer), spec:1054 (expiry write-off). **Regression files created / appended:** **creates `tests/regression/sah-018.test.ts`** (returned and delivered quantity as a projection, never a stored column — 3D is the first slice in execution order to touch SAH-018, §6.3; 4A appends); **appends** a `— 3D` block to `tests/regression/sah-009.test.ts` (created by 3B), `tests/regression/sah-017.test.ts` (created by 3B) and `tests/regression/sah-048.test.ts` (created by 3A).
- **Shared namespaces this slice writes into:** **document-type codes (§4.14)** — `SALES_ORDER` (`inventory`, `SO`), `DELIVERY_ORDER` (`inventory`, `DO`), `TRANSFER` (`inventory`, `TRF`), `TRANSFER_RECEIPT` (`inventory`, `TRR`), `STOCK_COUNT` (`inventory`, `SC`), `EXPIRY_WRITE_OFF` (`inventory`, `EWO`), all six seeded, plus **`COUNT_TEST` (`inventory`, `CT`) — test only, never a file under `packages/db/seed/my/document-types/`**, registered by Task 0 exactly as 2A's `POLICY_TEST` and 2B's `GAP_TEST` are. **Account codes (§4.15)** — **seeds `1250` goods delivered not invoiced and `5110` stock-count variance** in `packages/db/seed/my/chart-of-accounts/3d-adjustments.json`; **consumes without re-seeding `1310` goods in transit and `5100` inventory write-off — expiry loss (both 3C's)**, `1300` inventory control / `5000` cost of goods sold / `5920` FX rounding (0C's), and resolves each with an explicit assertion in Task 2 (hazard 33). **Report codes (§4.16.1)** — `inventory.stock_on_hand`, `inventory.valuation`, `inventory.sales_by_item`, seeded as routes over hand-written dataset queries under §4.16.3's rules; **`DatasetId` members (§4.16.2) — none**: 7A creates `datasets.ts` and this slice adds no member. **`fixtures.ts` helpers (§4.17) — none added.** §4.17 assigns 3D no row and hazard 9 forbids inventing one beside the register; every row this slice's tests need comes from `seedTenantV2`, `seedAccount`, `seedBranch`, `seedParty`, `seedDocumentType`, `grantCodes`, `seedUnit`, `seedItem`, `seedWarehouse`, `seedLot`, **3C's `draftTypedDocument`** (the generic typed-document draft builder, whose §4.17 row names 3D as a consumer) or a **file-local** function. **Shared test helpers (§4.17.1) — one word, and it is a Task 0 amendment, not a new file:** `secondPrincipal(db, s, label)` is **exported** from 3B's `tests/invariants/support/post-inventory.ts`, where it is currently module-private. Tasks 6, 8, 9 and 11 all need a second principal for an override or an R1 approval, `postOverriddenIssue` cannot serve them (it drafts no party, and `DELIVERY_ORDER` `requires: ["party", …]`), and writing a file-local copy in four test files is the duplication hazard 9 forbids. Nothing else in that file changes. The file-local `receiveStock` this plan repeats is named in the Self-Review as a further §4.17.1 candidate for the catalogue to place.
- **Four `Seed` and fixture facts every test in this plan depends on, stated once because getting one wrong is a silent failure.** (1) **`Seed` has no `branch` member.** It is `{ tenant; system; human; company; period; closedPeriod; lockedPeriod; cash; sales; docType; policy; branchType; hq }` (§4.1); the BRANCH dimension *value* is **`hq`**, `app.document.branch_id` is NOT NULL, so every `branchId:` in this plan is `<seed>.hq` unless a second value came from `seedBranch`. (2) **`seedTenant` grants `s.human` nothing** (§4.1, pinned) and 2B's R2 evaluates `policy.approval.post` *inside* the posting transaction, so **every posting test calls `grantCodes` first**. (3) **`seedTenantV2` creates only `1000 Cash` and `4000 Sales`.** Every inventory account this slice's policies name (`1250`, `1300`, `1310`, `5000`, `5100`, `5110`, `5920`) is created in a test by 1A's `seedAccount(db, s, { code, nameEn, type })` — `type ∈ ('asset','liability','equity','income','expense')` — through the file-local `seedInventoryAccounts` this plan repeats where it is needed. (4) **`seedItem` returns `{ itemId, baseUnitId }`**, not a bare string, and creates the item's sentinel lot `NONE` (§4.7.3); `seedWarehouse(db, s, { kind: 'in_transit' })` is how an in-transit warehouse is created (§4.17).
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first (that is what Task 0 is).
- **Contracts version:** 2026-09-07.

## Global Constraints

Copied verbatim from the spec and the contracts document; every task's requirements implicitly include this section.

1. **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (SAH-036/037/069); issue DDL from application code (SAH-053); disable an invariant, constraint or trigger "temporarily" (SAH-027, 041, 053); gate an audit write on any flag (SAH-030); hard-code a package version into a source file — the lockfile owns versions.
2. **Always**, for every new table (spec:106): `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge. **This slice creates no table** — every migration is an `alter` or an index — so clause 2's table half is satisfied by re-running `lintSchema` to zero after each migration.
3. **Nothing outside `packages/db/src/posting/` and `packages/db/src/costing/` writes `ledger_entry`, `ledger_entry_dimension`, `inventory_movement`, `cost_layer`, `cost_consumption`, `account_balance`, `stock_on_hand` or `tax_transaction`** (§4.3.2, the `posting-only-tables` lint, hazard 22). Every one of this slice's drafting services writes `document` and `document_line` rows and then calls `postDocument`. **`document_line.cost` is written only by `applyMovements`** (§4.7.2) — a drafting service never sets it.
4. **Money** is `numeric(19,4)` in Postgres and the opaque `Money` type in `@dulja/domain` in TypeScript; **quantities** are `numeric(19,6)` and the opaque `Quantity`; no `number` ever holds a monetary value or a quantity that crosses a boundary (spec:2041–2043, §3.7.5 `no-number-money`). Every wire amount is `{ amount, currency }` and every wire quantity a 6-dp string.
5. **`Money.toBase` rounds `HALF_AWAY_FROM_ZERO` at scale 4** (hazard 23), the only mode satisfying `base_debit = round(debit * exchange_rate, 4)`. No task in this slice performs a base conversion of its own — `evaluatePolicy` and `balanceInBase` do it.
6. **`PlannedLedgerLine.amount` is never negative and `side` is the sole carrier of direction** (§4.4.2 A9). ⚠️ **§4.4.2 names 3D explicitly** as a slice whose natural expression is negative; every ledger direction in this slice is chosen by the policy (a fixed `side`, or `when: { "line.quantity_sign": … }`) and **no line of code in this slice tests the sign of an amount to decide a direction**. `PlannedTaxLine.amount` stays signed and this slice plans no tax line (`tax.applies: false` on all six types).
7. **Every query, reads included, runs inside `withTenant`** (spec:2053). `db.` is a lint violation; only a `tx` obtained from `withTenant` may tag SQL. `sql.unsafe` has exactly three homes and none is in this slice (§3.3).
8. **One migration per PR** (spec:2057); each file runs whole in one transaction (so no `create index concurrently`); every statement carries a comment naming the SAH-/spec reference it serves; SQL keywords lowercase; section banners `-- ── N. title ───`; a hand-written `NNNN.down.sql` that drops only what the up added (§3.4.5).
9. **Expand only on a live table** (spec:2057, 2236, §3.4.7): migration 0040 adds two nullable columns and nothing else; no column is renamed and none is dropped.
10. **Deletion** (spec:2049): financial rows never — reversal only; master data `archived_at`. §3.5.4's pinned `app_rw` DELETE list is **unchanged** by this slice and Task 14 re-asserts it.
11. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). **This slice adds no new registry code** — it raises `ERR_VALIDATION_FAILED`, `ERR_NOT_FOUND`, `ERR_DOC_STATUS_ILLEGAL`, `ERR_DOC_NO_LINES`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_STOCK_INSUFFICIENT`, `ERR_DOC_LINK_OVER_FULFILLED`, `ERR_SOD_NO_SUBMISSION`, `ERR_SOD_MAKER_IS_CHECKER`, `ERR_OVERRIDE_NOT_AUTHORISED` (2B, contracts:1561 — asserted by name in Task 6's two override cases) and `ERR_RBAC_FORBIDDEN`, all already shipped by 0B, 2B, 3A or 3C. **This list is closed: a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.**
12. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice seeds exactly the six codes §3.6.2 assigns it and invents none.
13. **No plan invents a literal in a shared namespace** (hazard 32). Document-type codes, account codes, report codes, `DatasetId` members, `fixtures.ts` helper names and `ERR_*` names all come from the registers; Task 0 amends a register before any task writes a literal into it.
14. **The slice that seeds a policy seeds the accounts that policy names by code** (§4.15, hazard 33). 3D seeds `1250` and `5110`; for `1310` and `5100` — 3C's — **Task 2's first step asserts the account resolves and never re-seeds it and never falls back to a null account**.
15. **The UI is not specified** (spec:79, 108). Every screen task begins with OD-24 and targets keyboard parity (spec:2254); no workflow is invented (hazard 29).
16. **Localisation** (spec:2061): every user-facing string goes through i18next with an ICU message; `packages/i18n` catalogues are complete in `en` and `ar` before merge.
17. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [3D T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root stay green after every task.

---

## This slice's share of the Phase 3 definition of done

The Phase 3 row of the phase table, verbatim (spec:2289) — **Definition of done:** "Back-dated purchase recosts only forward, in bounded time, with a visible adjustment entry; FEFO picking returns the earliest-expiring lot; a landed-cost allocation changes unit cost and every downstream margin; **a stock count posts only the variance; goods in transit are in neither warehouse's on-hand and in the company's total**".

| Clause | Owner | Where it is green |
|---|---|---|
| "Back-dated purchase recosts only forward, in bounded time, with a visible adjustment entry" | 3B | re-asserted here in Task 11 as part of test 7's tie-out |
| "FEFO picking returns the earliest-expiring lot" | 3A | re-asserted here in Task 5 — `convertOrderToDelivery` resolves lots through `app.pick_lots_fefo` and the test proves the earliest-expiring lot is picked first |
| "a landed-cost allocation changes unit cost and every downstream margin" | 3C | re-asserted here in Task 11 — the landed-cost receipt is the stock test 7 transfers and sells |
| **"a stock count posts only the variance"** | **3D** | **Task 8** — a `STOCK_COUNT` over three lines of which one has a variance posts exactly one `inventory_movement`, exactly two `ledger_entry` rows, and leaves the two matching lines with no movement and no ledger row |
| **"goods in transit are in neither warehouse's on-hand and in the company's total"** | **3D** | **Task 7** — after a `TRANSFER` dispatch, `stock_on_hand` shows the source warehouse decremented, the destination unchanged, and the quantity held against a `warehouse.kind = 'in_transit'` row; `inventory.stock_on_hand`'s per-warehouse rows exclude it (Task 10) while the company total includes it, and `1310` carries its value in the ledger |

**Phase 3 exit (Task 14).** Every clause above green in CI, plus tests **5, 6, 7, 18** and **31** passing and tests **2, 12, 13, 15, 23, 27** and **36** re-run over this slice's rows, codes and endpoints — **23 only if OD-24 has landed and Task 13 shipped**, which is the same caveat Task 14 Step 2 carries and Task 13's own gate states (the screen task is blocked by an unanswered OD-24; the slice is not).

---

## File Structure

Every path is relative to the repository root. **NEW** means this slice creates it; **EDIT** means an existing file gains the stated additions and nothing else.

```
docs/
├─ adr/0042-variance-documents-in-the-posting-policy-schema.md   NEW  proposal (spec:95)        T3
├─ adr/0043-in-transit-warehouse-and-two-step-transfer.md        NEW                            T7
├─ review/2026-09-05-phase-3-exit.md                             NEW  the phase report          T14
└─ runbooks/stock-count.md                                       NEW  the count-sheet procedure T8

scripts/check/
└─ contracts-3d-amendments.sh                                    NEW  Task 0's gate             T0

packages/db/
├─ migrations/
│  ├─ 0040_alter_document_line_add_counted_columns.sql            NEW  §4.3.4 3D row             T1
│  ├─ 0040.down.sql                                               NEW  drops two columns only    T1
│  ├─ 0041_seed_permission_phase3d.sql                            NEW  six codes (§3.6.2)        T2
│  ├─ 0041.down.sql                                               NEW                            T2
│  ├─ 0042_add_inventory_report_index.sql                       NEW  one report index        T10
│  └─ 0042.down.sql                                               NEW                            T10
├─ src/
│  ├─ schema/document-line.ts                                     EDIT counted/expected columns  T1
│  ├─ costing/apply-movements.ts                                  EDIT the fill rules (§4.7.2)   T4
│  ├─ inventory/
│  │  ├─ fulfilment.ts       NEW  convertOrderToDelivery, ConvertToDeliveryInput, ConvertResult    T5
│  │  ├─ transfer.ts         NEW  draftTransfer, resolveInTransitWarehouse, TransferInput        T7
│  │  │                           + draftTransferReceipt, TransferReceiptInput                   T8
│  │  ├─ count.ts            NEW  snapshotCountSheet, recordCounts, readCountSheet,
│  │  │                           CountSheetLine, SnapshotCountSheetInput                        T8
│  │  ├─ write-off.ts        NEW  draftExpiryWriteOff, ExpiryWriteOffInput                       T9
│  │  └─ index.ts            NEW  the barrel @dulja/db re-exports                                T5
│  ├─ reports/
│  │  ├─ stock-on-hand.ts    NEW  stockOnHand, StockOnHandReportParams, StockOnHandReportRow                 T10
│  │  └─ sales-by-item.ts    NEW  salesByItem, SalesByItemParams, SalesByItemRow                 T10
│  └─ index.ts               EDIT re-exports ./inventory and the two report modules             T5,T10
├─ seed/
│  ├─ roles.ts               EDIT six codes onto four roles (§3.6.4)                             T2
│  └─ my/
│     ├─ chart-of-accounts/3d-adjustments.json   NEW  1250, 5110 (§4.15)                         T2
│     └─ document-types/
│        ├─ SALES_ORDER.json        NEW                                                          T5
│        ├─ DELIVERY_ORDER.json     NEW                                                          T6
│        ├─ TRANSFER.json           NEW                                                          T7
│        ├─ TRANSFER_RECEIPT.json   NEW                                                          T8
│        ├─ STOCK_COUNT.json        NEW                                                          T8
│        └─ EXPIRY_WRITE_OFF.json   NEW                                                          T9
└─ test/
   ├─ document-line-counted.test.ts     NEW  0040 DDL, round-trip, lint, two-tenant              T1
   ├─ seed/permission-phase3d.test.ts   NEW  0041, roles.ts, the account assertions              T2
   ├─ costing/apply-movements-fill.test.ts  NEW  the fill rules over real movements              T4
   ├─ inventory/policies.ts             NEW  ctxOf + the shared policy constants (T4 creates it;
   │                                         T5, T7, T8, T9 append)                         T4-T9
   ├─ inventory/fulfilment.test.ts      NEW  conversion, FEFO, open quantity, over-fulfilment    T5
   ├─ inventory/delivery-order.test.ts  NEW  posting, 1250, the override path                    T6
   ├─ inventory/transfer.test.ts        NEW  dispatch, the in-transit DoD clause                  T7
   ├─ inventory/transfer-receipt.test.ts NEW two-quantity receipt, variance, in-transit clears   T8
   ├─ inventory/stock-count.test.ts     NEW  variance-only, R1/R2, COUNT_TEST                     T8
   ├─ inventory/write-off.test.ts       NEW  branch drafts, accountant approves, 5100 + BRANCH    T9
   ├─ reports/inventory-reports.test.ts NEW  the three reports and their tie-outs                 T10
   └─ privileges.test.ts                EDIT the unchanged DELETE list re-asserted after 0042     T14

packages/domain/
├─ src/posting/evaluate.ts    EDIT variance quantity, the effect flip, the two-quantity transfer,
│                                  the zero-quantity drop, PlannedLedgerLine.fill                T3
└─ test/posting/
   ├─ evaluate-variance.test.ts   NEW  pure unit tests of all five behaviours                    T3
   └─ evaluate-transfer.test.ts   NEW  pure unit tests of the transfer effect                    T3

packages/contracts/
├─ permissions.ts                     EDIT six PermissionDef rows (§3.6.2)                       T2
└─ src/
   ├─ accounting/document.ts          EDIT DocumentLineInput gains countedQuantity/expectedQuantity, DocumentLineSchema returns them   T1
   ├─ accounting/reports.ts           EDIT ReportCodeSchema widened by three codes                T10
   ├─ inventory/fulfilment.ts         NEW  ConvertDocumentBody, ConvertResultSchema                T5
   ├─ inventory/transfer.ts           NEW  TransferDraftBody, TransferDraftSchema (T7)
   │                                       + TransferReceiptBody (T8)                          T7,T8
   ├─ inventory/count.ts              NEW  CountSheetBody, RecordCountsBody, CountSheetResultSchema T8
   └─ inventory/reports.ts            NEW  StockOnHand + SalesByItem DTOs and query schemas        T10
                                           (the valuation report re-uses 3B's inventory/valuation.ts)

apps/api/src/routes/
├─ accounting/documents.ts   EDIT six sub-paths (convert T5; transfers T7; count-sheet, counts,
│                                 count-sheet GET and receipt T8); the six codes reach
│                                 DOCUMENT_STAGE_CODES through POLICY_RESOLVED_CODES at T2     T5,T7,T8
└─ accounting/reports.ts     EDIT three GETs on 1B's module + two gate codes                      T10
apps/api/test/routes/
├─ accounting/document-fulfilment.test.ts  NEW                                                    T5
├─ accounting/document-count.test.ts       NEW                                                    T8
└─ accounting/inventory-reports.test.ts    NEW                                                    T10

apps/backoffice/src/                  (OD-24, Task 13)
├─ lib/transfer-api.ts                 NEW  the typed fetch layer the three screens share
├─ routes/inventory/transfers.tsx      NEW  dispatch + receive, the in-transit worklist
├─ routes/inventory/stock-count.tsx    NEW  the count sheet
├─ routes/inventory/reports.stock-on-hand.tsx  NEW  the report view
└─ router.tsx                          EDIT three routes; app-shell.tsx gains three nav entries
apps/backoffice/test/
├─ inventory-transfers.test.tsx        NEW
└─ inventory-stock-count.test.tsx      NEW
packages/i18n/src/locales/{en,ar}.json  EDIT the `inventory.transfer.*` / `inventory.count.*` keys    T13

tests/
├─ regression/sah-018.test.ts   NEW  created by 3D (§3.7.3); at T6, not T5, because its behavioural
│                                    case seeds DELIVERY_ORDER from the pack                      T6
├─ regression/sah-009.test.ts   EDIT append a `— 3D` block                                        T11
├─ regression/sah-017.test.ts   EDIT append a `— 3D` block                                        T5
├─ regression/sah-048.test.ts   EDIT append a `— 3D` block                                        T6
├─ invariants/test-07-one-costing-answer.test.ts   NEW  acceptance test 7                          T11
└─ e2e/inventory-transfers.spec.ts                 NEW  test 23 re-run, both directions            T13
```

**Two corrections to an earlier draft of this section, made here rather than left as a trap** (both recorded in the Self-Review): the back-office block previously named `src/screens/*.tsx` and a `routes.tsx`, neither of which exists — 0E ships `apps/backoffice/src/router.tsx` with TanStack `createRoute` entries and 3A put its three screens at `src/routes/inventory/*.tsx`, so this slice follows that layout; and a `WarehouseList.tsx` screen was dropped outright because **3A already ships the warehouse list** at `routes/inventory/warehouses.tsx` (its Task 15) and a second one is hazard 9. The 3D card's "warehouse … screens" is served by the in-transit worklist inside `transfers.tsx`, which is the view 3A's list cannot show. Likewise `tests/e2e/inventory-screens.spec.ts` is **3A's file**; this slice adds `inventory-transfers.spec.ts` beside it.

---

### Task 0: Contracts amendments and the 3A/3B/3C repo gate

This task writes **no application code**. It lands the amendments the rest of the plan depends on into `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`, and it ships a gate script that refuses to pass until both (a) those amendments are present and (b) the 3A/3B/3C exports this plan consumes actually exist in the repository with the shapes this plan was written against. **Task 1 does not start until this task's PR is merged and the script exits 0.**

**Files:**
- Create: `scripts/check/contracts-3d-amendments.sh`
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` (§2.4's 3D card, §3.6.4, §4.3.4, §4.4.2, §4.7.1, §4.7.2, §4.14, §4.15, §4.16.1, §4.16.3, §4.17.1)
- Modify: `tests/invariants/support/post-inventory.ts` — **one `export` keyword** on 3B's module-private `secondPrincipal` (amendment 12). This is the one file edit in the task and it is test-tier, so "no application code" still holds; the gate script greps for it, so without this step Step 5 can never pass.

**Interfaces:**
- Consumes: nothing. The script reads files with `grep -F` and `grep -E` only.
- Produces: `scripts/check/contracts-3d-amendments.sh` — exit 0 when every amendment and every consumed export is present, exit 1 printing one line per missing item.

**The thirteen amendments, each with the section it lands in and why the plan cannot proceed without it.** (Thirteen numbered items below; the gate script's `need_doc` list has **fifteen** entries because amendments 8 and 11 each land two separately grepped literals.)

1. **§4.4.2 — the variance quantity.** Add to the `LineSnapshot` doc comment: *"On a line carrying both `countedQuantity` and `expectedQuantity`, `quantity` is the **variance** `countedQuantity − expectedQuantity` and is therefore signed; `when: { "line.quantity_sign": … }` resolves from it. 3D's `STOCK_COUNT` and `TRANSFER_RECEIPT` are the two types that use this shape (§4.14)."* Without it a reader assumes `quantity` is the counted figure and every variance posts twice.
2. **§4.4.2 — the effect flip.** Add to `evaluatePolicy`'s contract: *"For `inventory.effect ∈ { issue, receipt }`, a **negative** resolved line quantity emits the **opposite** effect at the magnitude (`quantity.negate()` on a negative) and swaps `costing` `create_layer` ↔ `consume_layers`. `PlannedMovement.quantity` is therefore always a **magnitude** and `effect` is the sole carrier of direction — the movement twin of A9."* Without it 3B's `costingEngine.cost()`, which dispatches on `effect`, receives a negative quantity it has no branch for. **The wording is `negate()`, not `abs()`:** §4.2.1's `Quantity` has `negate`, `isNegative`, `isZero`, `compare`, `add`, `subtract`, `multiply` and `convert` and **no `abs` member** (contracts:1377–1386), and Task 3 Step 5's `orientMovement` correctly writes `quantity.negate()`. A landed contract that named a method the type does not have would be copied into code by the next slice that reads it.
3. **§4.4.2 — the zero-quantity drop.** Add: *"A planned movement whose resolved quantity is zero, or whose quantity reference is null, is **dropped** — `app.inventory_movement` carries `check (quantity <> 0)`, so emitting one is a runtime error. Dropping it drops no ledger line: a policy that plans a ledger leg for such a line does so through `when: { "line.quantity_sign": … }`, which a zero matches in neither direction."* Without it every zero-variance count line aborts the post.
4. **§4.4.2 — the two-quantity transfer.** Add to `PlannedMovement`'s comment: *"For `inventory.effect: "transfer"` the two movements need not carry the same quantity. When the line carries both `expectedQuantity` and `countedQuantity`, the **issue** movement's quantity is `expectedQuantity` and the **receipt** movement's is `countedQuantity`; otherwise both are `quantity`. This is the only in-schema expression of spec:1053's 'variance on receipt' — `inventory.effect` is one value per policy, so a receipt shortfall cannot be a second effect. **The two legs also carry different `costing` values: the issue leg carries the policy's `inventory.costing` and the receipt leg carries `create_layer`, or `zero` when the policy says `zero` (a free-of-charge inter-branch move, spec:1055). A transfer policy's `costing` describes the source leg — handing `consume_layers` to a receipt would describe a layer being consumed into existence, and §4.7.1's `cost()` dispatches on `effect`, so this is the honest value rather than a hint."*
5. **§4.4.2 — `PlannedLedgerLine.fill`.** Add the optional member `fill?: "cost" | "variance_value"` with: *"Set by the evaluator to the `amountRef` this line resolved from when that reference was `line.cost` or `line.variance_value`, and absent otherwise. It is what lets `applyMovements` (§4.7.2) tell two survivors of amendment A5 apart on one `sourceLineNo`. Purely additive: every existing consumer ignores it."*
6. **§4.7.2 — the `applyMovements` fill rules.** Add: *"`applyMovements` fills every planned ledger line carrying a `fill` tag with a **non-negative magnitude** and never alters `side` — direction is the policy's, through a fixed `side` or `when: { "line.quantity_sign": … }`. **Which rule applies is decided by the tags the policy put on the source line, not by how many movements survived the evaluator's zero-drop.** A source line carrying **only one** tag kind is a single-value line: that tag receives `|movement.value|` of its sole movement. A source line carrying **both** tags is a two-quantity variance line, and then `fill: "cost"` receives `|receipt.value|` and `fill: "variance_value"` receives `| |issue.value| − |receipt.value| |`, **with an absent leg contributing `Money.zero`** — which is the total-loss case (`counted_quantity = 0`, the receipt movement dropped by the zero-quantity rule): `cost` is zero, so the destination's inventory account is debited nothing, and the whole dispatched value lands on the variance legs. Reading the survivor's value into both tags there would debit the destination for goods that never arrived and relieve the corridor twice. `document_line.cost` is written as the same non-negative magnitude as the line's `fill: "cost"` value (4A and 7B read it)."*
7. **§4.7.2 — the transfer costing order.** Add: *"For a `transfer` line `applyMovements` costs the **issue** leg first and sets the receipt leg's `value` from the consumed value — `unitCost = |issue.value| ÷ issueQuantity`, `receipt.value = unitCost × receiptQuantity` — before the destination layer is created. 3D is the first slice to use `effect: "transfer"`."*
8. **§4.7.1 — two `CostingEngine.cost()` pins.** Add: *"A **receipt** whose `PlannedMovement.value` is null is valued at `average(openLayers)`; with no open layer the unit cost is `Money.zero` and one warning is recorded — this is the count-surplus and over-receipt case, where no purchase price exists. And when the policy's `inventory.allowNegative` is true and the movement was admitted by the data layer (an `inventory.negative_stock.override` event exists, §4.5.3), `cost()` **does not raise** for the quantity no open layer covers; the covered quantity is consumed and recorded in `cost_consumption` as usual (`layer_id` is NOT NULL, so the uncovered quantity has no consumption row) and the uncovered quantity's treatment is 3B's golden fixture, not 3D's to define."*
9. **§4.3.4 — the 3D row's wire half.** Add to the 3D row: *"and `DocumentLineInput` / `DocumentLineSchema` gain `countedQuantity` and `expectedQuantity` in the same PR as the columns, per §4.2.8's rule for 3A and 5A."*
10. **§4.14 — one test-only row.** `COUNT_TEST` · 3D (**test only**) · `inventory` · internal / receipt (variance only) / approve+post `inventory.adjustment.approve` · `CT` · *"the tenant-defined type test 15's inventory re-run configures through `POST …/document-types`; never a file under `packages/db/seed/my/document-types/`. A second code is needed because `STOCK_COUNT` is seeded and the zero-code claim must be made about a type the release did not ship."*
11. **§4.15 / §4.16.1 / §3.6.4 — three register cells.** `5110`'s *Resolved by* column gains *"and the `TRANSFER_RECEIPT` variance legs (3D, spec:1053)"*. §4.16.1's three `inventory.*` minimal-set rows gain *"3D ships it as a route over `packages/db/src/reports/<file>.ts`; §4.16.3's rule applies"* — **except `inventory.valuation`, whose cell instead gains *"3D mounts it on 1B's `reports` module over 3B's `valuationAsOf` and writes no read function of its own; 3B's own `/v1/companies/:companyId/valuation` module and its `PROBES` key are unaffected — a report code and a route module are two surfaces over one read (3B amendment A8)"***. §3.6.4's recorded-grants sentence gains *"`accounting.sales.create` → `user`; `inventory.transfer.create`, `inventory.transfer.post`, `inventory.count.create`, `inventory.adjustment.create` → `warehouse` and `branch_manager`; `inventory.adjustment.approve` → `accountant` (3D)"*.
12. **§4.17.1 — export `secondPrincipal`.** The `postInventoryDocument` row's Shape cell gains: *"and **`secondPrincipal(db, s, label: string): Promise<string>`** — a second human principal in the same tenant and company, returning its principal id. 3B shipped it module-private beside `postOverriddenIssue`; 3D exports it because four of its test files need a second principal for an override or an R1 approval and `postOverriddenIssue` cannot serve them (it drafts no `party`, and `DELIVERY_ORDER` requires one). Additive: one `export` keyword, no signature change."* Without it Tasks 6, 8, 9 and 11 each write their own copy, which is the duplication hazard 9 names.
13. **§4.16.3 — the three 3D read functions.** Add after the `accountLedger` block: *"3D adds `stockOnHand` (`packages/db/src/reports/stock-on-hand.ts`) and `salesByItem` (`sales-by-item.ts`) with their params/row types; `inventory.valuation` is served by **3B's** `valuationAsOf` (§4.7.2 amendment A19) and 3D adds no third function. All three are `ReportCodeSchema` members and `GET`s on 1B's `reports` module."* Without it 7B has no registry entry to re-express against and would rewrite the queries.

**The consumed-export gate.** 3A, 3B and 3C execute before this slice, so the script checks the repository rather than trusting prose. **The names below are taken from the written 3A/3B/3C plans, not from the 3D card's prose, which named three of them wrongly** (see the ⚠️ note in the Assumptions block). Eleven checks, each a stop-and-raise against the named slice:

| Check | Why this plan needs it |
|---|---|
| `linkFulfilment`, `listLinks`, `openQuantity`, `OpenQuantityRow` exported from `packages/db/src/documents/link.ts` | Task 5's conversion writes links through `linkFulfilment` and reads open quantity through `openQuantity`. **`createDocumentLink` and `documentOpenQuantity` do not exist** — the second is 3C's Drizzle *view mirror* name |
| `app.document_link` has a column named **`quantity`** | §4.6.1's DDL says `quantity`; the 3C card's prose said `linked_quantity`. 3C resolved it in favour of the register, and `linked_quantity` is the derived column of the `document_open_quantity` **view** |
| the view `app.document_open_quantity` exists with `open_quantity` | Task 5 reads open quantity through 3C's function over this view; a stored counter here would be SAH-017 |
| `app.pick_lots_fefo` returns `table (lot_id uuid, quantity numeric(19,6))` | Task 5 consumes the rows by those two names; the 3A card registers the function's arguments only |
| `pickLotsFefo` and `FefoPick` exported from **`packages/db/src/inventory/lots.ts`** | Task 5 imports the TypeScript wrapper by path, so a correct SQL function alone does not save it. 3A puts both in `lots.ts` (3a:114, 3a:6534) and the barrel re-export is `export { pickLotsFefo, type FefoPick } from "./inventory/lots";` (3a:6795). **There is no `packages/db/src/inventory/fefo.ts`** — an earlier draft of this plan named one, and the failure would have surfaced at Task 5 Step 5 as a module-not-found |
| `draftTypedDocument` exported from `packages/db/test/fixtures.ts` | every DB-tier test from Task 5 on drafts a typed document with item lines; `draftDocument` (§4.1) is JOURNAL-only |
| `postInventoryDocument`, `postOverriddenIssue`, `recordingJobs`, `ensureOpenPeriods` exported from `tests/invariants/support/post-inventory.ts` | Tasks 6 and 11 post inventory documents and open an authorised shortfall through the one door F-6 admits |
| `packages/db/src/costing/apply-movements.ts` mentions `negative_stock.override` | **the load-bearing one.** §4.7.2 costs through `costingEngine.cost()` *before* the movement insert, so an over-issue dies in the engine before `assert_stock_available` ever reads the override event. 3B closes this with `CostingInput.allowShortfall`, set when the event exists. If the string is absent, 3B shipped no override path and Tasks 6 and 11 are blocked on a **3B correction** — never a 3D workaround |
| `openLayersFor` and `valuationAsOf` exported from `packages/db/src/costing/` | Task 10's valuation report and Task 11's tie-out read them; re-deriving a valuation is SAH-009 |
| `GOODS_RECEIPT.json` exists and its policy needs **no** `document_link` to post | every test in this plan creates stock with a `GOODS_RECEIPT`; if a receipt requires a purchase order this plan's fixtures all grow one |
| `PURCHASE_RETURN.json` exists; `1310` and `5100` are rows of `packages/db/seed/my/chart-of-accounts/3c-purchasing.json` | test 7's supplier-return leg; hazard 33: 3D consumes those two codes and must not re-seed them |

- [ ] **Step 1: Write the gate script**

```bash
#!/usr/bin/env bash
# scripts/check/contracts-3d-amendments.sh
# Refuses until slice 3D's contract amendments are in the contracts document AND the
# 3A/3B/3C exports this plan consumes exist in the repository. Run from the repo root.
set -uo pipefail
C="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0
need_doc() {  # need_doc <fixed string> <what it is>
  if ! grep -qF -- "$1" "$C"; then echo "MISSING (contracts): $2 — expected the literal: $1"; fail=1; fi
}
need_file() { if [ ! -f "$1" ]; then echo "MISSING (repo): $1 — $2"; fail=1; fi }
need_grep() {  # need_grep <file> <ERE> <what it is>
  if [ ! -f "$1" ]; then echo "MISSING (repo): $1 — $3"; fail=1;
  elif ! grep -qE -- "$2" "$1"; then echo "MISSING (repo): $3 — $1 has no match for /$2/"; fail=1; fi
}

# ── the thirteen amendments (fifteen literals) ──────────────────────────
need_doc 'quantity` is the **variance**'                       '3D-1 variance quantity (§4.4.2)'
need_doc 'emits the **opposite** effect at the magnitude'    '3D-2 effect flip (§4.4.2)'
need_doc 'A planned movement whose resolved quantity is zero'  '3D-3 zero-quantity drop (§4.4.2)'
need_doc 'the two movements need not carry the same quantity'  '3D-4 two-quantity transfer (§4.4.2)'
need_doc 'fill?: "cost" | "variance_value"'                    '3D-5 PlannedLedgerLine.fill (§4.4.2)'
need_doc 'fills every planned ledger line carrying a `fill` tag' '3D-6 applyMovements fill rules (§4.7.2)'
need_doc 'costs the **issue** leg first'                       '3D-7 transfer costing order (§4.7.2)'
need_doc 'is valued at `average(openLayers)`'                  '3D-8a null-value receipt (§4.7.1)'
need_doc 'does not raise** for the quantity no open layer covers' '3D-8b allowNegative (§4.7.1)'
need_doc 'gain `countedQuantity` and `expectedQuantity`'       '3D-9 wire fields (§4.3.4) — NOT §4.4.2 A9, the frozen sign contract this slice consumes'
need_doc '| `COUNT_TEST` | 3D'                                 '3D-10 COUNT_TEST row (§4.14)'
need_doc 'TRANSFER_RECEIPT` variance legs'                     '3D-11a 5110 resolved-by (§4.15)'
need_doc '`accounting.sales.create` → `user`'                  '3D-11b role grants (§3.6.4)'
need_doc 'secondPrincipal(db, s, label: string): Promise<string>' '3D-12 secondPrincipal export (§4.17.1)'
need_doc '3D adds `stockOnHand`'                               '3D-13 the 3D read functions (§4.16.3)'

# ── the consumed-export gate ────────────────────────────────────────────
# Every name below is copied from the WRITTEN 3A/3B/3C plans, which are the authority for what they
# export. The 3D card's prose named three of them wrongly; do not "fix" this list back to the prose.
need_grep packages/db/src/documents/link.ts \
  'export .*linkFulfilment' '3C: linkFulfilment (NOT createDocumentLink)'
need_grep packages/db/src/documents/link.ts \
  'export .*openQuantity' '3C: openQuantity (NOT documentOpenQuantity — that is the view mirror)'
need_grep packages/db/src/documents/link.ts \
  'export .*listLinks' '3C: listLinks'
need_grep packages/db/src/documents/link.ts \
  'OpenQuantityRow' '3C: OpenQuantityRow'
need_grep packages/db/migrations/0037_create_document_link.sql \
  '^[[:space:]]*quantity[[:space:]]+numeric\(19,6\)' '3C: document_link.quantity (NOT linked_quantity)'
need_grep packages/db/migrations/0037_create_document_link.sql \
  'open_quantity' '3C: the app.document_open_quantity view'
need_grep packages/db/migrations/0031_create_inventory_movement_stock_on_hand.sql \
  'pick_lots_fefo' '3A: app.pick_lots_fefo'
need_grep packages/db/migrations/0031_create_inventory_movement_stock_on_hand.sql \
  'lot_id uuid, *quantity numeric\(19,6\)' '3A: pick_lots_fefo returns (lot_id, quantity)'
# The TypeScript half of the same check. Task 5 imports the wrapper by PATH, so a correct SQL function in a
# file this script never greps would still leave Task 5 Step 5 dying on a module-not-found. 3A ships both
# names from `lots.ts` (3a:114, 3a:6534, 3a:6795) and ships no `fefo.ts`; do not "fix" this back to one.
need_grep packages/db/src/inventory/lots.ts \
  'export .*pickLotsFefo' '3A: pickLotsFefo (packages/db/src/inventory/lots.ts, NOT fefo.ts)'
need_grep packages/db/src/inventory/lots.ts \
  'FefoPick' '3A: FefoPick (same file)'
need_grep packages/db/test/fixtures.ts \
  'export async function draftTypedDocument' '3C: draftTypedDocument (§4.17)'
for n in postInventoryDocument postOverriddenIssue recordingJobs ensureOpenPeriods secondPrincipal; do
  need_grep tests/invariants/support/post-inventory.ts "export .*$n" "3A/3B: $n (§4.17.1)"
done
# The load-bearing one: §4.7.2 costs through costingEngine.cost() BEFORE the movement insert, so an
# over-issue dies in the engine before assert_stock_available can read the override event. 3B closes
# that with CostingInput.allowShortfall. No string here means Tasks 6 and 11 are blocked on 3B.
need_grep packages/db/src/costing/apply-movements.ts \
  'negative_stock\.override' '3B: applyMovements sets allowShortfall from the override event (F-6)'
need_grep packages/db/src/costing/apply-movements.ts \
  'export .*openLayersFor' '3B: openLayersFor — the ONE open-layer reader'
need_grep packages/db/src/costing/valuation.ts \
  'export .*valuationAsOf' '3B: valuationAsOf — the ONE valuation read (spec:1228)'
need_file packages/db/seed/my/document-types/GOODS_RECEIPT.json '3C: the receipt this slice creates stock with'
need_file packages/db/seed/my/document-types/PURCHASE_RETURN.json '3C: test 7 supplier-return leg'
need_grep packages/db/seed/my/chart-of-accounts/3c-purchasing.json '"1310"' '3C: account 1310 goods in transit'
need_grep packages/db/seed/my/chart-of-accounts/3c-purchasing.json '"5100"' '3C: account 5100 expiry loss'

if [ "$fail" -ne 0 ]; then
  echo
  echo "Slice 3D cannot start. Land the contracts amendments (Task 0) and reconcile the"
  echo "3A/3B/3C exports above with their owning plans. Do NOT work around a missing export."
  exit 1
fi
echo "contracts-3d-amendments: ok"
```

- [ ] **Step 2: Run it to see it fail**

Run: `chmod +x scripts/check/contracts-3d-amendments.sh && bash scripts/check/contracts-3d-amendments.sh`
Expected: FAIL (exit 1) printing fifteen `MISSING (contracts):` lines — **one per grepped literal, across the thirteen amendments** (amendments 8 and 11 each land two separately grepped literals, which is why fifteen and not thirteen) — before any `MISSING (repo):` line, ending with the three-line refusal.

- [ ] **Step 3: Apply the thirteen amendments to the contracts document**

Edit `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` exactly as the table above states, using the literal strings the script greps for. Add the `COUNT_TEST` row to §4.14 immediately after `SOD_TEST`'s row:

```markdown
| `COUNT_TEST` | 3D (**test only**) | `inventory` | internal / receipt (variance only) / approve+post `inventory.adjustment.approve` | `CT` | the tenant-defined type test 15's inventory re-run configures through `POST …/document-types`; never a file under `packages/db/seed/my/document-types/`. A second code is needed because `STOCK_COUNT` is seeded and the zero-code claim must be made about a type the release did not ship |
```

and the `fill` member to §4.4.2's `PlannedLedgerLine`:

```ts
export interface PlannedLedgerLine { lineNo: number; accountId: string; side: "debit" | "credit"; amount: Money; base: Money; dimensions: Record<string, string>; sourceLineNo: number | null; role: "policy" | "fx_rounding"; fill?: "cost" | "variance_value" }
```

- [ ] **Step 4: Export `secondPrincipal` (amendment 12's one keyword)**

In `tests/invariants/support/post-inventory.ts`, 3B declared the helper module-private beside `postOverriddenIssue`. Add the keyword and nothing else — no signature change, no body change, no re-ordering:

```ts
/** A second human principal in the same tenant and company, returning its principal id. Exported by 3D
 *  (§4.17.1 amendment 12): Tasks 6, 8, 9 and 11 each need a second principal for an `override` event or an
 *  R1 approval, and `postOverriddenIssue` cannot serve them — it drafts no `party`, and DELIVERY_ORDER's
 *  policy carries `requires: ["party", …]`. Four file-local copies is the duplication hazard 9 forbids. */
export async function secondPrincipal(db: Db, s: Seed, label: string): Promise<string> {
```

Verify the helper's shape is the one the amendment records before adding the keyword:

Run: `grep -n "function secondPrincipal" tests/invariants/support/post-inventory.ts`
Expected: one line reading `async function secondPrincipal(db: Db, s: Seed, label: string): Promise<string> {` (with or without `export`). **If the parameters differ, stop and amend §4.17.1 to 3B's real shape rather than changing 3B's helper** — the written plan is the authority (§4.18's rule).

- [ ] **Step 5: Run the script again**

Run: `bash scripts/check/contracts-3d-amendments.sh`
Expected: PASS if 3A/3B/3C are merged with the shapes above. If a `MISSING (repo):` line remains, **stop** — that is a reconciliation with the named slice's plan, not a 3D change. Record the discrepancy in the PR body and raise it before continuing.

- [ ] **Step 6: Wire the script into CI**

In `.github/workflows/ci.yml`, in the job that already runs `bun run lint:rules`, add a step after it:

```yaml
      - name: Contracts amendments (3D)
        run: bash scripts/check/contracts-3d-amendments.sh
```

- [ ] **Step 7: Commit**

```bash
git add scripts/check/contracts-3d-amendments.sh docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md \
        tests/invariants/support/post-inventory.ts .github/workflows/ci.yml
git commit -m "docs(contracts): register slice 3D's variance, transfer and fill contracts [3D T0]

Thirteen amendments across §3.6.4, §4.3.4, §4.4.2, §4.7.1, §4.7.2, §4.14, §4.15, §4.16.3, §4.17.1
and §4.16.1, plus a gate script that also verifies the 3A/3B/3C exports this
slice consumes. No application code.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Migration 0040 — `document_line.counted_quantity` and `expected_quantity`, and the wire fields

**Files:**
- Create: `packages/db/migrations/0040_alter_document_line_add_counted_columns.sql`
- Create: `packages/db/migrations/0040.down.sql`
- Create: `packages/db/test/document-line-counted.test.ts`
- Modify: `packages/db/src/schema/document-line.ts` (the 1A Drizzle mirror — two columns appended)
- Modify: `packages/db/src/posting/load.ts` (`loadSnapshot` — two `LineSnapshot` fields filled)
- Modify: `packages/contracts/src/accounting/document.ts` (`DocumentLineInput`, `DocumentLineSchema`)

**Interfaces:**
- Consumes: `up(sql, dir)`, `down(sql, dir, toVersion)`, `listApplied(sql)`, `MIGRATIONS_DIR`, `startDb`, `withTenant` (test, 4-argument), `uuidv7`, `lintSchema`, `Violation`, `seedTenantV2(db, name): Promise<Seed>`, `draftDocument(db, s, opts?)`, `LineSnapshot` (§4.4.2), `loadSnapshot(tx, documentId)` (§4.3.1), `DocumentLineInput` (§4.2.8, 2A).
- Produces:
  - `app.document_line.counted_quantity numeric(19,6)` and `app.document_line.expected_quantity numeric(19,6)`, both nullable (expand only, §3.4.7).
  - `LineSnapshot.countedQuantity: Quantity | null` and `LineSnapshot.expectedQuantity: Quantity | null` filled by `loadSnapshot` (declared at 2A, stubbed until now).
  - `DocumentLineInput` gains `countedQuantity?: string` and `expectedQuantity?: string` (6-dp strings, `QuantitySchema`); `DocumentLineSchema` returns both as nullable.

**Why these two columns and not three.** §4.4.2 declares `countedQuantity` and `expectedQuantity` on `LineSnapshot` and nothing else; the *variance value* needs no column, because it is filled at post from the movement values and told apart from the line cost by `PlannedLedgerLine.fill` (Task 0 amendment 5). A `document_line.variance_value` column would be a second store of a derived number — SAH-018's exact shape.

- [ ] **Step 1: Write the failing test**

`packages/db/test/document-line-counted.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { MIGRATIONS_DIR, startDb, uuidv7, withTenant, type Db } from "./harness";
import { down, listApplied, up } from "../src/migrate";
import { draftDocument, seedTenantV2, type Seed } from "./fixtures";

describe("migration 0040 — document_line.counted_quantity / expected_quantity (§4.3.4 3D row, spec:1052)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "tenant-a");
    b = await seedTenantV2(db, "tenant-b");
  }, 180_000);
  afterAll(async () => { await db?.stop(); });

  it("both columns exist, are numeric(19,6) and are nullable", async () => {
    const rows = await db.admin<{ column_name: string; data_type: string; numeric_scale: number; is_nullable: string }[]>`
      select column_name, data_type, numeric_scale, is_nullable
        from information_schema.columns
       where table_schema = 'app' and table_name = 'document_line'
         and column_name in ('counted_quantity', 'expected_quantity')
       order by column_name`;
    expect(rows.map((r) => r.column_name)).toEqual(["counted_quantity", "expected_quantity"]);
    for (const r of rows) {
      expect(r.data_type).toBe("numeric");
      expect(r.numeric_scale).toBe(6);
      expect(r.is_nullable).toBe("YES");
    }
  });

  it("a line round-trips both quantities at six decimal places", async () => {
    const docId = await draftDocument(db, a);
    const lineId = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_line
                 (id, tenant_id, company_id, document_id, line_no, kind, quantity, counted_quantity, expected_quantity)
               values (${lineId}, ${a.tenant}, ${a.company}, ${docId}, 1, 'item', -1.500000, 8.500000, 10.000000)`;
    });
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { quantity: string; counted_quantity: string; expected_quantity: string }[]
    >`select quantity::text, counted_quantity::text, expected_quantity::text
        from app.document_line where id = ${lineId}`);
    expect(row).toEqual({
      quantity: "-1.500000",
      counted_quantity: "8.500000",
      expected_quantity: "10.000000",
    });
  });

  it("tenant B cannot see tenant A's counted line (spec:106)", async () => {
    const rows = await withTenant(db.rw, b.tenant, b.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_line where counted_quantity is not null`);
    expect(rows[0]!.n).toBe(0);
  });

  it("lintSchema still reports zero violations (§3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("0040 down drops the two columns and leaves app.document_line standing (§3.4.5)", async () => {
    const applied = await listApplied(db.migrator);
    expect(applied).toContain(40);
    await down(db.migrator, MIGRATIONS_DIR, 39);
    const [after] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'document_line'
         and column_name in ('counted_quantity', 'expected_quantity')`;
    expect(after!.n).toBe(0);
    const [tbl] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'app' and table_name = 'document_line'`;
    expect(tbl!.n).toBe(1);
    await up(db.migrator, MIGRATIONS_DIR);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test document-line-counted`
Expected: FAIL — the first test reports `expect(received).toEqual(["counted_quantity", "expected_quantity"])` with `received: []`, because migration 0040 does not exist.

- [ ] **Step 3: Write migration 0040**

`packages/db/migrations/0040_alter_document_line_add_counted_columns.sql`:

```sql
-- ── 0040 · document_line gains the two count columns (§4.3.4 3D row) ───
-- spec:1052 "Stock count / cycle count with variance posted through a STOCK_COUNT document".
-- spec:1053 "dispatched into an in-transit warehouse, received at the branch, variance on receipt".
-- Expand only (spec:2057, §3.4.7): two nullable columns, no rename, no drop, no backfill.
-- SAH-018: the VARIANCE itself gets no column — document_line.quantity carries
-- counted_quantity - expected_quantity and every consumer derives from that one number.

alter table app.document_line
  add column counted_quantity  numeric(19,6),   -- what the counter / receiver actually found
  add column expected_quantity numeric(19,6);   -- snapshot of stock_on_hand (STOCK_COUNT) or the dispatched quantity (TRANSFER_RECEIPT)

comment on column app.document_line.counted_quantity is
  'STOCK_COUNT: the counted quantity. TRANSFER_RECEIPT: the received quantity. Base unit (spec:2043).';
comment on column app.document_line.expected_quantity is
  'STOCK_COUNT: stock_on_hand at count time. TRANSFER_RECEIPT: the dispatched quantity. Base unit.';
comment on column app.document_line.quantity is
  'Base unit. On a line carrying both count columns this is the signed VARIANCE '
  '(counted_quantity - expected_quantity); when: { "line.quantity_sign": ... } resolves from it (ADR 0042).';
```

`packages/db/migrations/0040.down.sql`:

```sql
-- ── 0040 down ──────────────────────────────────────────────────────────
-- Drops only the two columns this file added; app.document_line belongs to 0011 (§3.4.5).
comment on column app.document_line.quantity is null;
alter table app.document_line
  drop column if exists expected_quantity,
  drop column if exists counted_quantity;
```

- [ ] **Step 4: Extend the Drizzle mirror**

In `packages/db/src/schema/document-line.ts`, append two columns to the existing `documentLine` table object, immediately after the 3A block (`warehouseId`, `lotId`, `unitId`, `unitQuantity`). Add nothing else and reorder nothing — 1A, 2A and 3A own the lines above:

```ts
  // 3D, migration 0040 — §4.3.4. Both nullable; `quantity` is the signed variance on these lines.
  countedQuantity: numeric("counted_quantity", { precision: 19, scale: 6 }),
  expectedQuantity: numeric("expected_quantity", { precision: 19, scale: 6 }),
```

- [ ] **Step 5: Fill the two `LineSnapshot` fields in `loadSnapshot`**

`LineSnapshot.countedQuantity` and `expectedQuantity` were declared by 2A and left `null` (§4.3.1's stub list). In `packages/db/src/posting/load.ts`, add both columns to the `document_line` select list and both fields to the row mapper:

```ts
// packages/db/src/posting/load.ts — inside the document_line query's select list, after unit_quantity:
       l.counted_quantity::text  as counted_quantity,
       l.expected_quantity::text as expected_quantity,
```

```ts
// … and inside the LineSnapshot mapper, replacing the two `null` stubs 2A left:
    countedQuantity:  r.counted_quantity  === null ? null : Quantity.of(r.counted_quantity),
    expectedQuantity: r.expected_quantity === null ? null : Quantity.of(r.expected_quantity),
```

`Quantity.of` takes a fixed 6-dp string (§4.2.1) and `::text` on a `numeric(19,6)` produces exactly that, so no formatting step is needed.

- [ ] **Step 6: Add the wire fields**

In `packages/contracts/src/accounting/document.ts`, add both fields to `DocumentLineInput` and to `DocumentLineSchema`. **Every constraint 2A restored stays** — the non-negative `Amount` regex, the debit-or-credit `.refine`, `.min(1)` on the list, the two `.openapi(…)` component names and the conditional `accountId` — and nothing is reordered:

```ts
// DocumentLineInput — 3D, migration 0040 (§4.3.4). Optional: only STOCK_COUNT and
// TRANSFER_RECEIPT lines carry them, and on those lines `quantity` is the signed variance.
  countedQuantity: QuantitySchema.optional(),
  expectedQuantity: QuantitySchema.optional(),
```

```ts
// DocumentLineSchema — returned shape. Nullable, because every other type's lines have neither.
  countedQuantity: QuantitySchema.nullable(),
  expectedQuantity: QuantitySchema.nullable(),
```

`QuantitySchema` is `z.string().regex(/^-?\d+\.\d{6}$/)` from `packages/contracts/src/common.ts` (§4.2.8) — already imported by this file for `quantity`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test document-line-counted && bun run --cwd packages/db test posting && bun run --cwd packages/contracts test`
Expected: PASS — all five new cases, plus 1A's and 2A's posting suites unchanged (the two new snapshot fields are additive and every existing line resolves them to `null`).

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0040_alter_document_line_add_counted_columns.sql \
        packages/db/migrations/0040.down.sql \
        packages/db/test/document-line-counted.test.ts \
        packages/db/src/schema/document-line.ts \
        packages/db/src/posting/load.ts \
        packages/contracts/src/accounting/document.ts
git commit -m "feat(db): document_line counted_quantity and expected_quantity [3D T1]

Migration 0040 expands document_line with the two count columns §4.3.4 assigns 3D,
fills the two LineSnapshot fields 2A stubbed, and adds both to the wire shapes in
the same PR as the columns (§4.2.8). The variance itself gets no column (SAH-018).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0041 — the six permission codes, the role grants, and the `3d-adjustments` chart

**Files:**
- Create: `packages/db/migrations/0041_seed_permission_phase3d.sql`
- Create: `packages/db/migrations/0041.down.sql`
- Create: `packages/db/seed/my/chart-of-accounts/3d-adjustments.json`
- Create: `packages/db/test/seed/permission-phase3d.test.ts`
- Modify: `packages/contracts/permissions.ts` (six `PermissionDef` rows appended)
- Modify: `packages/db/seed/roles.ts` (six codes onto four roles)
- Modify: `apps/api/src/middleware/require-document-permission.ts` (the six codes appended to 2A's `POLICY_RESOLVED_CODES` — Step 6; without it `permission-catalogue` fails this task's commit)

**Interfaces:**
- Consumes: `PERMISSIONS`, `PermissionDef`, `PermissionCode`, `PERMISSION`, `SliceId` (§4.2.5), `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` (§4.2.5), `POLICY_RESOLVED_CODES` (§4.5.4, 2A — extended in place by Step 6, never redefined), `up`/`down`/`listApplied`/`MIGRATIONS_DIR`, `startDb`, `withTenant` (test), `seedTenantV2`, `seedAccount(db, s, opts: { code; nameEn; type; parentCode?; currency? }): Promise<string>` (§4.17, 1A), the `chart-of-accounts` `PackLoader` (0C) reached through `@dulja/db/seed`.
- Produces:
  - `app.permission` rows for `inventory.transfer.create`, `inventory.transfer.post`, `inventory.count.create`, `inventory.adjustment.create`, `inventory.adjustment.approve`, `accounting.sales.create` — all `mutating = true`, modules `inventory` and `accounting`, `phase: "3D"`.
  - `packages/db/seed/my/chart-of-accounts/3d-adjustments.json` — the two §4.15 rows `1250` (asset) and `5110` (expense).
  - the §3.6.4 grants: `accounting.sales.create` → `user`; `inventory.transfer.create`, `inventory.transfer.post`, `inventory.count.create`, `inventory.adjustment.create` → `warehouse` and `branch_manager`; `inventory.adjustment.approve` → `accountant`.

**The grants come from the spec's role table, not from taste** (spec:2159–2161). `warehouse` — "transfer to branches, draft stock counts and expired/damaged write-offs; post receipts and transfers — quantities only"; `branch_manager` — "receiving transfers, drafting counts and write-offs"; `accountant` — "approve stock counts and expiry/damage write-offs (`inventory.adjustment.approve`)"; `user` — "Draft sales and purchase orders and documents". **`accountant` deliberately does not hold `inventory.adjustment.create`** — the approver never drafts, which is what makes R1 non-vacuous on `STOCK_COUNT` (test 31, Task 8) — and `auditor` holds none of the six, all being mutating (R7).

**Hazard 33's assertion, and where it lives.** Step 1's last case asserts that after `--only chart-of-accounts` the company resolves **all seven** codes this slice's policies name: `1250` and `5110` (3D's), `1310` and `5100` (3C's), `1300`, `5000` and `5920` (0C's). It re-seeds none of the five it does not own; a missing one is a stop-and-raise against the owning slice.

- [ ] **Step 1: Write the failing test**

`packages/db/test/seed/permission-phase3d.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../seed/roles";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";

const CODES = [
  "accounting.sales.create",
  "inventory.adjustment.approve",
  "inventory.adjustment.create",
  "inventory.count.create",
  "inventory.transfer.create",
  "inventory.transfer.post",
] as const;

describe("slice 3D permission seed and chart additions (§3.6.2, §3.6.4, §4.15)", () => {
  let db: Db;
  let s: Seed;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d");
  }, 180_000);
  afterAll(async () => { await db?.stop(); });

  it("migration 0041 seeded exactly the six codes, all mutating", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code = any(${[...CODES]}) order by code`;
    expect(rows.map((r) => r.code)).toEqual([...CODES]);
    expect(rows.every((r) => r.mutating)).toBe(true);
    expect(rows.map((r) => r.module)).toEqual([
      "accounting", "inventory", "inventory", "inventory", "inventory", "inventory",
    ]);
  });

  it("the catalogue module agrees with the database for all six (permission-catalogue.test.ts's rule)", () => {
    for (const code of CODES) {
      const def = PERMISSIONS.find((p) => p.code === code);
      expect(def, `${code} missing from packages/contracts/permissions.ts`).toBeDefined();
      expect(def!.mutating).toBe(true);
      expect(def!.phase).toBe("3D");
    }
  });

  it("roles.ts carries exactly the §3.6.4 grants and no others", () => {
    const of = (c: string) => ROLES.find((r) => r.code === c)!.permissions;
    expect(of("user")).toContain("accounting.sales.create");
    expect(of("accountant")).toContain("inventory.adjustment.approve");
    expect(of("accountant")).not.toContain("inventory.adjustment.create");
    for (const role of ["warehouse", "branch_manager"]) {
      expect(of(role)).toContain("inventory.transfer.create");
      expect(of(role)).toContain("inventory.transfer.post");
      expect(of(role)).toContain("inventory.count.create");
      expect(of(role)).toContain("inventory.adjustment.create");
      expect(of(role)).not.toContain("inventory.adjustment.approve");
    }
    expect(of("auditor").filter((c) => (CODES as readonly string[]).includes(c))).toEqual([]);
  });

  it("no seeded role other than admin holds both codes of an incompatible pair (R6)", () => {
    for (const role of ROLES.filter((r) => r.code !== "admin")) {
      for (const [x, y] of INCOMPATIBLE_PAIRS) {
        expect(role.permissions.includes(x) && role.permissions.includes(y),
          `${role.code} holds both ${x} and ${y}`).toBe(false);
      }
    }
  });

  it("3d-adjustments.json declares exactly 1250 and 5110, with the §4.15 first-digit rule", () => {
    const file = join(process.cwd(), "seed", "my", "chart-of-accounts", "3d-adjustments.json");
    const rows = JSON.parse(readFileSync(file, "utf8")) as
      { code: string; nameEn: string; nameAr: string; type: string }[];
    expect(rows.map((r) => r.code).sort()).toEqual(["1250", "5110"]);
    const first: Record<string, string> = { "1": "asset", "2": "liability", "3": "equity", "4": "income", "5": "expense" };
    for (const r of rows) {
      expect(r.code).toMatch(/^[1-5][0-9]{3}$/);
      expect(r.type).toBe(first[r.code[0]!]);
      expect(r.nameAr.length).toBeGreaterThan(0);
    }
  });

  it("every account code this slice's policies name resolves in the seeded company (hazard 33)", async () => {
    // 1250, 5110 are 3D's (this task). 1310, 5100 are 3C's. 1300, 5000, 5920 are 0C's.
    const need = ["1250", "1300", "1310", "5000", "5100", "5110", "5920"];
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ code: string }[]>`
      select code from app.account where company_id = ${s.company} and code = any(${need}) order by code`);
    expect(rows.map((r) => r.code)).toEqual(need);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test seed/permission-phase3d`
Expected: FAIL — the first case reports `expect(received).toEqual([...])` with `received: []` (no `app.permission` rows), and the fifth throws `ENOENT: no such file or directory … seed/my/chart-of-accounts/3d-adjustments.json`.

- [ ] **Step 3: Write migration 0041 and its down**

`packages/db/migrations/0041_seed_permission_phase3d.sql`:

```sql
-- ── 0041 · slice 3D permission codes (§3.6.2; spec:2147–2148) ──────────
-- app.permission is global and has no RLS (plan0A:1254), so this is migration data,
-- not seed-pack data (§3.4.8). on conflict (code) do update keeps the row authoritative.
-- spec:2148 inventory: transfer.create/.post, count.create, adjustment.create/.approve
-- spec:2147 accounting: "sales and purchase *orders* are created under accounting.sales.create"

insert into app.permission (code, module, mutating, description) values
  ('inventory.transfer.create',   'inventory',  true,  'Draft a delivery order, a stock transfer or a transfer receipt'),
  ('inventory.transfer.post',     'inventory',  true,  'Post a delivery order, a stock transfer or a transfer receipt (stock out, no revenue — F-19)'),
  ('inventory.count.create',      'inventory',  true,  'Draft a stock count and enter counted quantities'),
  ('inventory.adjustment.create', 'inventory',  true,  'Draft a stock adjustment or an expiry write-off'),
  ('inventory.adjustment.approve','inventory',  true,  'Approve and post a stock count or an expiry write-off (spec:2026)'),
  ('accounting.sales.create',     'accounting', true,  'Draft a sales order or a sales document')
on conflict (code) do update
  set module      = excluded.module,
      mutating    = excluded.mutating,
      description = excluded.description;
```

`packages/db/migrations/0041.down.sql`:

```sql
-- ── 0041 down ──────────────────────────────────────────────────────────
-- Deletes exactly the six codes this file inserted (§3.4.5). app.role_permission.permission_code
-- references app.permission(code) with NO `on delete cascade` (plan0A:1325), so the FK BLOCKS this
-- delete while any tenant still grants one of the six — which is the correct signal, not a defect:
-- re-run that tenant's role seed first. 3A's 0033.down.sql documents the identical statement the same
-- way. A §3.4.6 roll-down against a role-seeded tenant therefore raises 23503 here, by design.
delete from app.permission where code in (
  'inventory.transfer.create',
  'inventory.transfer.post',
  'inventory.count.create',
  'inventory.adjustment.create',
  'inventory.adjustment.approve',
  'accounting.sales.create');
```

- [ ] **Step 4: Add the six catalogue rows**

Append to the `PERMISSIONS` array in `packages/contracts/permissions.ts`, after 3C's block. `SliceId` already contains `"3D"` (§4.2.5), so no type widening is needed:

```ts
  { code: "inventory.transfer.create",    module: "inventory",  mutating: true,  description: "Draft a delivery order, a stock transfer or a transfer receipt", phase: "3D" },
  { code: "inventory.transfer.post",      module: "inventory",  mutating: true,  description: "Post a delivery order, a stock transfer or a transfer receipt (stock out, no revenue — F-19)", phase: "3D" },
  { code: "inventory.count.create",       module: "inventory",  mutating: true,  description: "Draft a stock count and enter counted quantities", phase: "3D" },
  { code: "inventory.adjustment.create",  module: "inventory",  mutating: true,  description: "Draft a stock adjustment or an expiry write-off", phase: "3D" },
  { code: "inventory.adjustment.approve", module: "inventory",  mutating: true,  description: "Approve and post a stock count or an expiry write-off (spec:2026)", phase: "3D" },
  { code: "accounting.sales.create",      module: "accounting", mutating: true,  description: "Draft a sales order or a sales document", phase: "3D" },
```

- [ ] **Step 5: Add the role grants**

In `packages/db/seed/roles.ts`, add each code to the `permissions` array of the role the spec's table gives that authority. **`admin.permissions` is computed from `PERMISSIONS` and is never edited** (§3.6.4):

```ts
// user (spec:2159 "Draft sales and purchase orders and documents") — add to its permissions array:
  "accounting.sales.create",

// warehouse (spec:2160 "transfer to branches, draft stock counts and expired/damaged write-offs;
// post receipts and transfers — quantities only") — add to its permissions array:
  "inventory.transfer.create",
  "inventory.transfer.post",
  "inventory.count.create",
  "inventory.adjustment.create",

// branch_manager (spec:2160 "receiving transfers, drafting counts and write-offs") — add the same four:
  "inventory.transfer.create",
  "inventory.transfer.post",
  "inventory.count.create",
  "inventory.adjustment.create",

// accountant (spec:2159 "approve stock counts and expiry/damage write-offs") — add ONE code, and
// deliberately NOT inventory.adjustment.create: the approver never drafts, which is what keeps
// R1 non-vacuous on STOCK_COUNT (test 31).
  "inventory.adjustment.approve",
```

- [ ] **Step 6: Register the six codes in `POLICY_RESOLVED_CODES` — in this same commit, unconditionally**

`permission-catalogue` (§3.6.3, contracts:1214) fails the build on **a catalogue code with no reference**. The six codes gain their *policy* references only from Task 5 onward, when `SALES_ORDER.json` … `EXPIRY_WRITE_OFF.json` name them in `approval` — three tasks later. So at this task there is no reference, the lint fails, and Global Constraint 17's "`lint:rules` … stays green after every task" is not satisfied. This is determined by the plan itself, not by luck, so the step is unconditional rather than a contingency an executor has to diagnose.

`POLICY_RESOLVED_CODES` in `apps/api/src/middleware/require-document-permission.ts` (§4.5.4) is 2A's constant for exactly this case: a code whose gate is resolved from `posting_policy` at request time rather than named at compile time by a `requirePermission(...)` call. Appending the six **is** the reference the lint wants, and it stays after Task 5 — the policy files do not replace it, because `requireDocumentPermission(stage)` still resolves these codes from data.

```ts
// apps/api/src/middleware/require-document-permission.ts — appended to 2A's POLICY_RESOLVED_CODES array.
// 3D (§3.6.2). Each is the `approval.create` / `.post` / `.approve` of one of the six seed-pack policies
// Tasks 5-9 ship, so the gate resolves it from posting_policy and no route names it at compile time.
  "inventory.transfer.create",
  "inventory.transfer.post",
  "inventory.count.create",
  "inventory.adjustment.create",
  "inventory.adjustment.approve",
  "accounting.sales.create",
```

- [ ] **Step 7: Write the chart-of-accounts file**

`packages/db/seed/my/chart-of-accounts/3d-adjustments.json` — one file per contributing slice (§4.15); no shared file is edited:

```json
[
  {
    "code": "1250",
    "nameEn": "Goods delivered not invoiced",
    "nameAr": "بضاعة مسلَّمة غير مفوترة",
    "type": "asset",
    "parentCode": "1200"
  },
  {
    "code": "5110",
    "nameEn": "Stock-count variance",
    "nameAr": "فروق جرد المخزون",
    "type": "expense",
    "parentCode": "5100"
  }
]
```

`parentCode` points at a row 0C and 3C already seed (`1200` trade receivables, `5100` inventory write-off), so the loader's parent resolution finds both; the sub-pack rule of §3.4.8 makes this file part of the pack only from this slice onward.

- [ ] **Step 8: Apply the sub-pack against the test tenant**

The `chart-of-accounts` loader is 0C's and takes no change (§3.4.8: "A slice that adds rows to an existing sub-pack adds a **file**, never a loader"). Add this line to the test's `beforeAll`, after `seedTenantV2`, so the seventh case has rows to find:

```ts
    // 0C's chart-of-accounts loader, re-applied for this tenant so 3C's and 3D's files land.
    // Idempotent on (company_id, code) — §3.4.8.
    const { chartOfAccountsLoader } = await import("../../src/seed");
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      chartOfAccountsLoader.load(tx, {
        config: { tenantId: s.tenant } as never,
        tenantId: s.tenant,
        companyId: s.company,
        systemPrincipalId: s.system,
        packRoot: join(process.cwd(), "seed", "my"),
      }));
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test seed/permission-phase3d && bun run --cwd packages/db test permission-catalogue && bun run lint:rules`
Expected: PASS. `permission-catalogue.test.ts` (0B) compares `app.permission` to `PERMISSIONS` in both directions and is green because Steps 3 and 4 landed together; `lint:rules` runs `role-seed` (R6/R7) and `permission-catalogue` (a catalogue code with no reference fails the build), and the six codes have their reference from Step 6. **If `permission-catalogue` still reports "code introduced in 3D has no reference", Step 6 was skipped** — that is the only way this can fail here, because the policy JSON files that will also reference the codes do not exist until Task 5.

- [ ] **Step 10: Commit**

```bash
git add packages/db/migrations/0041_seed_permission_phase3d.sql \
        packages/db/migrations/0041.down.sql \
        packages/db/seed/my/chart-of-accounts/3d-adjustments.json \
        packages/db/test/seed/permission-phase3d.test.ts \
        packages/contracts/permissions.ts \
        packages/db/seed/roles.ts \
        apps/api/src/middleware/require-document-permission.ts
git commit -m "feat(db): slice 3D permission codes, role grants and the adjustments chart [3D T2]

Migration 0041 seeds the six §3.6.2 codes; roles.ts grants them per spec:2159-2161
(accountant approves but never drafts, so R1 stays non-vacuous on STOCK_COUNT);
3d-adjustments.json adds 1250 and 5110 and asserts 3C's 1310/5100 resolve (hazard 33).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The evaluator's variance resolutions — the signed quantity, the effect flip, the two-quantity transfer, the zero drop and `fill`

Five behaviours, all inside 2A's `packages/domain/src/posting/evaluate.ts`, all **pure** and tested with no database. Nothing about `evaluatePolicy`'s signature changes; nothing 1A, 2A or 2B tests changes behaviour. ADR 0042 is written here **as a proposal** (spec:95 — it touches money semantics) and is the record of why the frozen `posting-policy.schema.json` needs none of it.

**Files:**
- Create: `docs/adr/0042-variance-documents-in-the-posting-policy-schema.md`
- Create: `packages/domain/test/posting/evaluate-variance.test.ts`
- Create: `packages/domain/test/posting/evaluate-transfer.test.ts`
- Modify: `packages/domain/src/posting/evaluate.ts`

**Interfaces:**
- Consumes: `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PlannedMovement`, `PostingPlan`, `PolicyEvaluationError`, `evaluatePolicy`, `parsePolicy` (§4.4.2, 2A); `Money`, `Quantity`, `currency`, `round` (§4.2.1, 0D).
- Produces:
  - `PlannedLedgerLine.fill?: "cost" | "variance_value"` — set to the `amountRef` the line resolved from when that reference was `line.cost` or `line.variance_value`, absent otherwise.
  - `evaluatePolicy` resolves `when: { "line.quantity_sign": … }` from `LineSnapshot.quantity` — `"positive"` matches `quantity` strictly greater than zero, `"negative"` strictly less, and a null or zero quantity matches **neither**.
  - `evaluatePolicy` emits `PlannedMovement.quantity` as a **magnitude** and flips `effect` and `costing` when the resolved quantity is negative.
  - `evaluatePolicy` drops a planned movement whose resolved quantity is zero or null.
  - For `inventory.effect: "transfer"` with both count columns present, the issue movement carries `expectedQuantity` and the receipt movement `countedQuantity`.

**The five behaviours, exactly.**

| # | Behaviour | Why it cannot be anything else |
|---|---|---|
| 1 | `when: { "line.quantity_sign": "positive" \| "negative" }` reads `LineSnapshot.quantity`; zero and null match neither | It is the only `when` key in the frozen schema that can discriminate a variance direction, and `document_line.quantity` is the signed variance on a counted line (T1). A zero-variance line must plan nothing |
| 2 | A negative resolved quantity under `effect ∈ { issue, receipt }` emits the **opposite** effect at the magnitude (`quantity.negate()` — §4.2.1's `Quantity` has no `abs()`) and swaps `costing` `create_layer` ↔ `consume_layers` | §4.7.1's `cost()` dispatches on `effect` ("receipts create a layer, issues consume"); handing it a negative quantity gives it no branch. `inventory_movement.quantity` is "+ receipt, − issue", so the sign lives in the row, not on the plan |
| 3 | A planned movement whose resolved quantity is zero or null is dropped | `app.inventory_movement` carries `check (quantity <> 0)`. Any other behaviour aborts a stock count whose sheet matches |
| 4 | For `effect: "transfer"`, the issue quantity is `expectedQuantity ?? quantity` and the receipt quantity is `countedQuantity ?? quantity` | `inventory.effect` is one value per policy, so spec:1053's "variance on receipt" has no second effect to live in. Two movements with different quantities is the only in-schema expression |
| 5 | `PlannedLedgerLine.fill` records which of `line.cost` / `line.variance_value` a line resolved from | Amendment A5 keeps *both* alive at `Money.zero` on the same `sourceLineNo`; without the tag `applyMovements` cannot tell the matched value from the variance |

**What is deliberately NOT done here.** No `$id` change, no `"version"` bump, no new enum label, no new `amountRef`, no new `when` key, no new `LineSnapshot` field and no new column. Every one of the five is a resolution rule inside the evaluator, over references the schema already admits. **`PlannedTaxLine.amount` is untouched and stays signed** (§4.4.2's one exception); this slice plans no tax line.

- [ ] **Step 1: Write the failing test for behaviours 1, 2, 3 and 5**

`packages/domain/test/posting/evaluate-variance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { currency, Money, Quantity } from "../../src/index";
import { evaluatePolicy, parsePolicy, type DocumentSnapshot, type LineSnapshot } from "../../src/posting/evaluate";

const MYR = currency("MYR");
const UNIT = { from: MYR, to: MYR, rate: "1.00000000", effectiveFrom: "2026-01-01", source: "unit" } as const;

/** A STOCK_COUNT-shaped policy: one movement per line, four ledger legs keyed on the variance sign. */
const COUNT_POLICY = parsePolicy({
  version: 1,
  documentType: "STOCK_COUNT",
  direction: "internal",
  requires: ["warehouse"],
  lines: [
    { for: "each_line", side: "debit",  account: { from: "item.inventory_account" }, amount: "line.cost", when: { "line.kind": "item", "line.quantity_sign": "positive" } },
    { for: "each_line", side: "credit", account: { code: "5110" },                  amount: "line.cost", when: { "line.kind": "item", "line.quantity_sign": "positive" } },
    { for: "each_line", side: "credit", account: { from: "item.inventory_account" }, amount: "line.cost", when: { "line.kind": "item", "line.quantity_sign": "negative" } },
    { for: "each_line", side: "debit",  account: { code: "5110" },                  amount: "line.cost", when: { "line.kind": "item", "line.quantity_sign": "negative" } },
  ],
  inventory: { effect: "receipt", warehouse: "line.warehouse", costing: "create_layer", allowNegative: false },
  tax: { applies: false },
  numbering: { series: "SC", assignAt: "issue" },
  reversal: { allowed: true, producesType: "STOCK_COUNT" },
  approval: { required: true, approve: "inventory.adjustment.approve", post: "inventory.adjustment.approve", create: "inventory.count.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
});

function line(no: number, counted: string, expected: string): LineSnapshot {
  const q = Quantity.of(counted).subtract(Quantity.of(expected));
  return {
    id: `line-${no}`, lineNo: no, kind: "item", description: null,
    accountId: null, itemId: "item-1", quantity: q, unitPrice: null,
    discount: Money.zero(MYR), amount: Money.zero(MYR), taxCodeId: null,
    taxAmount: Money.zero(MYR), totalInclTax: Money.zero(MYR),
    debit: Money.zero(MYR), credit: Money.zero(MYR), cost: null,
    warehouseId: "wh-1", toWarehouseId: null, lotId: "lot-1",
    unitId: "unit-1", unitQuantity: null,
    countedQuantity: Quantity.of(counted), expectedQuantity: Quantity.of(expected),
    tenderMethod: null, customFields: {}, dimensions: {}, payroll: null,
  };
}

function snapshot(lines: LineSnapshot[]): DocumentSnapshot {
  return {
    header: {
      id: "doc-1", companyId: "co-1", documentTypeCode: "STOCK_COUNT", status: "issued",
      series: "SC", fiscalPeriodId: "fp-1", number: 1n, effectiveDate: "2026-01-15",
      partyId: null, currency: MYR, exchangeRate: UNIT, branchId: "branch-hq",
      attributedTo: null, clientRef: null, warehouseId: "wh-1", toWarehouseId: null,
      taxInclusive: false, reversesDocumentId: null, customFields: {},
    },
    lines,
    company: { id: "co-1", baseCurrency: MYR, fxRoundingAccountId: "acct-5920", costingMethod: "avco" },
    party: null,
    refs: {
      accountsByCode: { "5110": "acct-5110" },
      items: { "item-1": { id: "item-1", code: "SKU1", kind: "product", baseUnitId: "unit-1", trackLots: true,
                           revenueAccountId: "acct-4000", inventoryAccountId: "acct-1300",
                           cogsAccountId: "acct-5000", expenseAccountId: "acct-5900" } },
      taxCodes: {}, components: {}, schemes: {},
      dimensionTypesByCode: { BRANCH: "dt-branch" },
    },
  };
}

describe("evaluatePolicy — variance lines (ADR 0042; §4.4.2 as amended by 3D)", () => {
  it("a SURPLUS keeps the declared effect, plans a magnitude movement and tags both legs `cost`", () => {
    const plan = evaluatePolicy(COUNT_POLICY, snapshot([line(1, "12.000000", "10.000000")]));
    expect(plan.movements).toHaveLength(1);
    expect(plan.movements[0]!.effect).toBe("receipt");
    expect(plan.movements[0]!.costing).toBe("create_layer");
    expect(plan.movements[0]!.quantity.toString()).toBe("2.000000");
    expect(plan.movements[0]!.warehouseId).toBe("wh-1");
    expect(plan.movements[0]!.value).toBeNull();
    expect(plan.ledgerLines.map((l) => [l.side, l.accountId, l.fill])).toEqual([
      ["debit",  "acct-1300", "cost"],
      ["credit", "acct-5110", "cost"],
    ]);
    expect(plan.ledgerLines.every((l) => !l.amount.isNegative())).toBe(true);
  });

  it("a SHORTFALL flips effect AND costing, still plans a magnitude, and selects the other two legs", () => {
    const plan = evaluatePolicy(COUNT_POLICY, snapshot([line(1, "7.000000", "10.000000")]));
    expect(plan.movements).toHaveLength(1);
    expect(plan.movements[0]!.effect).toBe("issue");
    expect(plan.movements[0]!.costing).toBe("consume_layers");
    expect(plan.movements[0]!.quantity.toString()).toBe("3.000000");
    expect(plan.ledgerLines.map((l) => [l.side, l.accountId])).toEqual([
      ["credit", "acct-1300"],
      ["debit",  "acct-5110"],
    ]);
  });

  it("a MATCHING line plans no movement and no ledger line at all (spec:1052 'only the variance')", () => {
    const plan = evaluatePolicy(COUNT_POLICY, snapshot([line(1, "10.000000", "10.000000")]));
    expect(plan.movements).toEqual([]);
    expect(plan.ledgerLines).toEqual([]);
  });

  it("a null quantity plans nothing either — `check (quantity <> 0)` has no null branch", () => {
    const l = line(1, "10.000000", "10.000000");
    const plan = evaluatePolicy(COUNT_POLICY, snapshot([{ ...l, quantity: null }]));
    expect(plan.movements).toEqual([]);
    expect(plan.ledgerLines).toEqual([]);
  });

  it("three lines, one with a variance: exactly one movement and two ledger legs, movementNo 1", () => {
    const plan = evaluatePolicy(COUNT_POLICY, snapshot([
      line(1, "10.000000", "10.000000"),
      line(2, "4.000000", "6.000000"),
      line(3, "8.000000", "8.000000"),
    ]));
    expect(plan.movements).toHaveLength(1);
    expect(plan.movements[0]!.lineNo).toBe(2);
    expect(plan.movements[0]!.movementNo).toBe(1);
    expect(plan.ledgerLines).toHaveLength(2);
    expect(plan.ledgerLines.every((l) => l.sourceLineNo === 2)).toBe(true);
  });

  it("the null-cost warning is one per SOURCE LINE, not one per rule (amendment A5)", () => {
    const plan = evaluatePolicy(COUNT_POLICY, snapshot([line(1, "12.000000", "10.000000")]));
    expect(plan.warnings.filter((w) => w.startsWith("line 1:"))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/domain test posting/evaluate-variance`
Expected: FAIL — the first case reports `expect(received).toEqual([["debit","acct-1300","cost"],["credit","acct-5110","cost"]])` with `received: [["debit","acct-1300",undefined],["credit","acct-5110",undefined]]` (no `fill` tag), and the third case fails with one movement of quantity `0.000000` instead of none.

- [ ] **Step 3: Write the failing test for behaviour 4**

`packages/domain/test/posting/evaluate-transfer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { currency, Money, Quantity } from "../../src/index";
import { evaluatePolicy, parsePolicy, type DocumentSnapshot, type LineSnapshot } from "../../src/posting/evaluate";

const MYR = currency("MYR");
const UNIT = { from: MYR, to: MYR, rate: "1.00000000", effectiveFrom: "2026-01-01", source: "unit" } as const;

const RECEIPT_POLICY = parsePolicy({
  version: 1,
  documentType: "TRANSFER_RECEIPT",
  direction: "internal",
  requires: ["warehouse", "to_warehouse"],
  lines: [
    { for: "each_line", side: "debit",  account: { from: "item.inventory_account" }, amount: "line.cost",           when: { "line.kind": "item" } },
    { for: "each_line", side: "credit", account: { code: "1310" },                  amount: "line.cost",           when: { "line.kind": "item" } },
    { for: "each_line", side: "debit",  account: { code: "5110" },                  amount: "line.variance_value", when: { "line.kind": "item", "line.quantity_sign": "negative" } },
    { for: "each_line", side: "credit", account: { code: "1310" },                  amount: "line.variance_value", when: { "line.kind": "item", "line.quantity_sign": "negative" } },
    { for: "each_line", side: "credit", account: { code: "5110" },                  amount: "line.variance_value", when: { "line.kind": "item", "line.quantity_sign": "positive" } },
    { for: "each_line", side: "debit",  account: { code: "1310" },                  amount: "line.variance_value", when: { "line.kind": "item", "line.quantity_sign": "positive" } },
  ],
  inventory: { effect: "transfer", warehouse: "header.warehouse", to_warehouse: "header.to_warehouse", costing: "consume_layers", allowNegative: false },
  tax: { applies: false },
  numbering: { series: "TRR", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },        // see "the reversal interaction" in Task 8
  approval: { required: false, approve: null, post: "inventory.transfer.post", create: "inventory.transfer.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
});

function receiptLine(counted: string, expected: string): LineSnapshot {
  return {
    id: "line-1", lineNo: 1, kind: "item", description: null,
    accountId: null, itemId: "item-1",
    quantity: Quantity.of(counted).subtract(Quantity.of(expected)),
    unitPrice: null, discount: Money.zero(MYR), amount: Money.zero(MYR), taxCodeId: null,
    taxAmount: Money.zero(MYR), totalInclTax: Money.zero(MYR),
    debit: Money.zero(MYR), credit: Money.zero(MYR), cost: null,
    warehouseId: null, toWarehouseId: null, lotId: "lot-1", unitId: "unit-1", unitQuantity: null,
    countedQuantity: Quantity.of(counted), expectedQuantity: Quantity.of(expected),
    tenderMethod: null, customFields: {}, dimensions: {}, payroll: null,
  };
}

function receiptSnapshot(line: LineSnapshot): DocumentSnapshot {
  return {
    header: {
      id: "doc-1", companyId: "co-1", documentTypeCode: "TRANSFER_RECEIPT", status: "issued",
      series: "TRR", fiscalPeriodId: "fp-1", number: 1n, effectiveDate: "2026-01-20",
      partyId: null, currency: MYR, exchangeRate: UNIT, branchId: "branch-b",
      attributedTo: null, clientRef: null, warehouseId: "wh-transit", toWarehouseId: "wh-b",
      taxInclusive: false, reversesDocumentId: null, customFields: {},
    },
    lines: [line],
    company: { id: "co-1", baseCurrency: MYR, fxRoundingAccountId: "acct-5920", costingMethod: "avco" },
    party: null,
    refs: {
      accountsByCode: { "1310": "acct-1310", "5110": "acct-5110" },
      items: { "item-1": { id: "item-1", code: "SKU1", kind: "product", baseUnitId: "unit-1", trackLots: true,
                           revenueAccountId: "acct-4000", inventoryAccountId: "acct-1300",
                           cogsAccountId: "acct-5000", expenseAccountId: "acct-5900" } },
      taxCodes: {}, components: {}, schemes: {},
      dimensionTypesByCode: { BRANCH: "dt-branch" },
    },
  };
}

describe("evaluatePolicy — the transfer effect (ADR 0043; §4.4.2 as amended by 3D)", () => {
  it("an EXACT receipt emits issue(expected) at the source and receipt(counted) at the destination", () => {
    const plan = evaluatePolicy(RECEIPT_POLICY, receiptSnapshot(receiptLine("10.000000", "10.000000")));
    expect(plan.movements.map((m) => [m.movementNo, m.effect, m.warehouseId, m.quantity.toString()])).toEqual([
      [1, "issue",   "wh-transit", "10.000000"],
      [2, "receipt", "wh-b",       "10.000000"],
    ]);
    // Amendment A4: the issue leg carries the policy's `costing`; the destination leg always creates.
    expect(plan.movements.map((m) => m.costing)).toEqual(["consume_layers", "create_layer"]);
    // Zero variance: the two variance legs match neither sign, so only the two `cost` legs are planned.
    expect(plan.ledgerLines.map((l) => [l.side, l.accountId, l.fill])).toEqual([
      ["debit",  "acct-1300", "cost"],
      ["credit", "acct-1310", "cost"],
    ]);
  });

  it("a SHORTFALL emits the two quantities unequally and adds the two negative-sign variance legs", () => {
    const plan = evaluatePolicy(RECEIPT_POLICY, receiptSnapshot(receiptLine("8.000000", "10.000000")));
    expect(plan.movements.map((m) => [m.effect, m.warehouseId, m.quantity.toString()])).toEqual([
      ["issue",   "wh-transit", "10.000000"],
      ["receipt", "wh-b",       "8.000000"],
    ]);
    expect(plan.ledgerLines.map((l) => [l.side, l.accountId, l.fill])).toEqual([
      ["debit",  "acct-1300", "cost"],
      ["credit", "acct-1310", "cost"],
      ["debit",  "acct-5110", "variance_value"],
      ["credit", "acct-1310", "variance_value"],
    ]);
  });

  it("an OVER-RECEIPT selects the positive-sign legs, which reverse the variance direction", () => {
    const plan = evaluatePolicy(RECEIPT_POLICY, receiptSnapshot(receiptLine("11.000000", "10.000000")));
    expect(plan.movements.map((m) => m.quantity.toString())).toEqual(["10.000000", "11.000000"]);
    expect(plan.ledgerLines.map((l) => [l.side, l.accountId, l.fill])).toEqual([
      ["debit",  "acct-1300", "cost"],
      ["credit", "acct-1310", "cost"],
      ["credit", "acct-5110", "variance_value"],
      ["debit",  "acct-1310", "variance_value"],
    ]);
  });

  it("a line with no count columns transfers `quantity` on both legs (the TRANSFER dispatch shape)", () => {
    const l = receiptLine("10.000000", "10.000000");
    const plan = evaluatePolicy(RECEIPT_POLICY, receiptSnapshot({
      ...l, quantity: Quantity.of("6.000000"), countedQuantity: null, expectedQuantity: null,
    }));
    expect(plan.movements.map((m) => m.quantity.toString())).toEqual(["6.000000", "6.000000"]);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun run --cwd packages/domain test posting/evaluate-transfer`
Expected: FAIL — the second case reports the two movement quantities as `["10.000000","10.000000"]` instead of `["10.000000","8.000000"]`, because 2A's transfer emission uses one quantity for both legs.

- [ ] **Step 5: Implement all five behaviours in the evaluator**

In `packages/domain/src/posting/evaluate.ts`. **Additive only** — no existing exported name changes and no branch that JOURNAL, `POLICY_TEST` or 2A's own suites reach is edited.

Add the `fill` member to the interface (mirroring Task 0's amendment):

```ts
export interface PlannedLedgerLine {
  lineNo: number; accountId: string; side: "debit" | "credit"; amount: Money; base: Money;
  dimensions: Record<string, string>; sourceLineNo: number | null; role: "policy" | "fx_rounding";
  /** 3D: which of `line.cost` / `line.variance_value` this line resolved from, so `applyMovements`
   *  (§4.7.2) can tell two amendment-A5 survivors on one source line apart. Absent for every other ref. */
  fill?: "cost" | "variance_value";
}
```

Add the three helpers, above `evaluatePolicy`:

```ts
/** Behaviour 1. `when: { "line.quantity_sign": … }` (§4.4.1) resolves from the line's SIGNED quantity.
 *  On a line carrying both count columns that quantity is the variance (§4.3.4, migration 0040), which is
 *  what makes "post only the variance" a policy fact. Zero and null match NEITHER value — that is what
 *  makes a stock-count line whose sheet matches plan nothing at all (spec:1052). */
function quantitySignOf(line: LineSnapshot): "positive" | "negative" | null {
  if (line.quantity === null || line.quantity.isZero()) return null;
  return line.quantity.isNegative() ? "negative" : "positive";
}

/** Behaviour 2. `PlannedMovement.quantity` is always a MAGNITUDE and `effect` carries the direction —
 *  the movement twin of A9's rule for ledger lines. §4.7.1's cost() dispatches on `effect`, so a negative
 *  quantity would reach a branch that does not exist; and `inventory_movement.quantity` is "+ receipt,
 *  − issue" (§4.7.3), so the sign belongs to the row, which applyMovements writes. */
function orientMovement(
  effect: "issue" | "receipt",
  costing: PlannedMovement["costing"],
  quantity: Quantity,
): { effect: "issue" | "receipt"; costing: PlannedMovement["costing"]; quantity: Quantity } {
  if (!quantity.isNegative()) return { effect, costing, quantity };
  const flippedEffect = effect === "issue" ? "receipt" : "issue";
  const flippedCosting =
    costing === "create_layer" ? "consume_layers" : costing === "consume_layers" ? "create_layer" : costing;
  return { effect: flippedEffect, costing: flippedCosting, quantity: quantity.negate() };
}

/** Behaviour 4. A `transfer` line's two legs need not carry one quantity. When the line carries both count
 *  columns the ISSUE leg takes `expected_quantity` (everything that left the source) and the RECEIPT leg
 *  takes `counted_quantity` (what arrived); the difference is spec:1053's "variance on receipt", and it has
 *  nowhere else to live because `inventory.effect` is one value per policy (ADR 0043). */
function transferQuantities(line: LineSnapshot): { issue: Quantity | null; receipt: Quantity | null } {
  if (line.expectedQuantity !== null && line.countedQuantity !== null) {
    return { issue: line.expectedQuantity, receipt: line.countedQuantity };
  }
  return { issue: line.quantity, receipt: line.quantity };
}
```

In the `when` matcher, add the one branch (beside the existing `line.kind`, `line.tender_method`, `item.kind` branches):

```ts
    if (key === "line.quantity_sign" && quantitySignOf(line) !== value) return false;
```

In the movement-emission block, replace 2A's `issue`/`receipt` push and its `transfer` pair with:

```ts
  // Behaviours 2, 3 and 4. `movementNo` stays 1-based PER DOCUMENT in emission order (§4.4.2).
  if (policy.inventory.effect === "issue" || policy.inventory.effect === "receipt") {
    const q = resolveMovementQuantity(policy, line);            // 2A's existing resolver
    if (q !== null && !q.isZero()) {                             // behaviour 3
      const o = orientMovement(policy.inventory.effect, policy.inventory.costing!, q);
      movements.push({
        lineNo: line.lineNo, movementNo: ++movementNo, itemId: line.itemId!,
        warehouseId: resolveWarehouse(policy, snapshot, line)!,  // 2A's existing resolver
        lotId: line.lotId, quantity: o.quantity, effect: o.effect, value: null, costing: o.costing,
      });
    }
  } else if (policy.inventory.effect === "transfer") {
    const { issue, receipt } = transferQuantities(line);
    const from = resolveWarehouse(policy, snapshot, line);
    const to = resolveToWarehouse(policy, snapshot, line);       // 2A's existing resolver
    if (issue !== null && !issue.isZero()) {
      const o = orientMovement("issue", policy.inventory.costing!, issue);
      movements.push({ lineNo: line.lineNo, movementNo: ++movementNo, itemId: line.itemId!,
                       warehouseId: from!, lotId: line.lotId, quantity: o.quantity,
                       effect: o.effect, value: null, costing: o.costing });
    }
    if (receipt !== null && !receipt.isZero()) {
      // The destination leg always CREATES a layer (or a zero-cost one for a free-of-charge move,
      // spec:1055). A transfer policy's `costing` describes the SOURCE leg: handing `consume_layers`
      // to a receipt would describe a layer being consumed into existence, and §4.7.1's cost()
      // dispatches on `effect`, so this is the honest value rather than a hint (amendment A4).
      const receiptCosting = policy.inventory.costing === "zero" ? "zero" : "create_layer";
      const o = orientMovement("receipt", receiptCosting, receipt);
      movements.push({ lineNo: line.lineNo, movementNo: ++movementNo, itemId: line.itemId!,
                       warehouseId: to!, lotId: line.lotId, quantity: o.quantity,
                       effect: o.effect, value: null, costing: o.costing });
    }
  }
```

And in the ledger-line push, tag the two fillable references (behaviour 5) — this is the only change to that block:

```ts
      const fill: PlannedLedgerLine["fill"] | undefined =
        rule.amount === "line.cost" ? "cost" : rule.amount === "line.variance_value" ? "variance_value" : undefined;
      // 2A's push is left byte for byte as it stands — bind it to a local, then spread it with the tag. The
      // conditional spread is what keeps `fill` ABSENT (not `undefined`) on every other reference, so 1A's,
      // 2A's and 2B's `toEqual` assertions on whole planned lines stay green (`{ fill: undefined }` is not
      // equal to `{}` under Vitest's strict object comparison).
      const line: PlannedLedgerLine = {
        lineNo: ledgerLineNo, accountId, side, amount, base, dimensions,
        sourceLineNo: source.lineNo, role: "policy",
      };
      plan.ledgerLines.push(fill === undefined ? line : { ...line, fill });
```

- [ ] **Step 6: Run both suites to verify they pass**

Run: `bun run --cwd packages/domain test posting`
Expected: PASS — the ten new cases plus every 2A case unchanged. The three JOURNAL/`POLICY_TEST` policies declare `inventory.effect: "none"`, so no existing plan gains or loses a movement, and `fill` is absent on every `line.debit`/`line.credit` line.

- [ ] **Step 7: Write ADR 0042**

`docs/adr/0042-variance-documents-in-the-posting-policy-schema.md`:

```markdown
# ADR 0042 — Variance documents in the frozen posting-policy schema

- **Status:** Proposed (spec:95 — this touches money semantics, so it is asked before it is relied on)
- **Date:** 2026-09-05
- **Slice:** 3D

## Context

`STOCK_COUNT` must post only the variance (spec:1052) and `TRANSFER_RECEIPT` must post a variance on
receipt (spec:1053). `posting-policy.schema.json` has one `inventory.effect` and one `inventory.costing`
per policy, and §4.4.1 fixes any schema change as a new `version` const and a new `$id` — which would
invalidate every policy file in the repository. So neither document type may add an effect.

## Decision

Four resolution rules inside `evaluatePolicy`, over references the schema already admits:

1. On a `document_line` carrying `counted_quantity` and `expected_quantity`, `quantity` is the signed
   variance `counted − expected`. `when: { "line.quantity_sign": … }` — a key the frozen schema already
   has and that nothing else uses — resolves from it; zero and null match neither value.
2. `PlannedMovement.quantity` is a magnitude and `effect` carries the direction. A negative resolved
   quantity emits the opposite effect and swaps `costing`. `applyMovements` writes the sign onto the row.
3. A planned movement whose quantity is zero or null is dropped: `inventory_movement` carries
   `check (quantity <> 0)`.
4. For `effect: "transfer"` the issue leg carries `expected_quantity` and the receipt leg
   `counted_quantity` when both are present. This is the only in-schema place a receipt variance can live.

`PlannedLedgerLine.fill` records whether a line resolved from `line.cost` or `line.variance_value`, so
`applyMovements` can fill two amendment-A5 survivors on one source line with the right magnitude.

## Consequences

- `$id`, `"version": 1` and every existing policy file are untouched; the change is additive.
- A variance's direction is a *policy* decision (`when` on the sign), never a sign test in code — which is
  what §4.4.2's warning about 3D demands.
- The variance is never stored: `document_line.quantity` is the one number and every consumer derives from
  it. That is SAH-018's fix stated in the schema rather than in a trigger.
- 3B's `costingEngine` needs two pins to make rule 2 total: a receipt with no value is costed at
  `average(openLayers)`, and `allowNegative` suppresses the uncovered-quantity refusal. Both are Task 0.
```

- [ ] **Step 8: Commit**

```bash
git add docs/adr/0042-variance-documents-in-the-posting-policy-schema.md \
        packages/domain/src/posting/evaluate.ts \
        packages/domain/test/posting/evaluate-variance.test.ts \
        packages/domain/test/posting/evaluate-transfer.test.ts
git commit -m "feat(domain): variance quantities, the effect flip and PlannedLedgerLine.fill [3D T3]

Five pure resolution rules in evaluatePolicy so STOCK_COUNT posts only the variance
and TRANSFER_RECEIPT posts a receipt variance, with no change to posting-policy.schema.json's
\$id or version. ADR 0042 is a proposal (spec:95).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `applyMovements` — the fill rules, the transfer costing order and `document_line.cost`

3B ships `applyMovements` with a body that inserts movements, writes layers and consumptions and fills `value` on the plan. This task adds the half that only 3D exercises: **filling the planned ledger lines the evaluator tagged**, in the right order for a transfer, always as a non-negative magnitude.

**Files:**
- Create: `packages/db/test/costing/apply-movements-fill.test.ts`
- Create: `packages/db/test/inventory/policies.ts` (`ctxOf`, `GRN_POLICY`, `TRANSFER_RECEIPT_POLICY` — the shared test-policy module; Tasks 5, 7, 8 and 9 append the other four constants to it)
- Modify: `packages/db/src/costing/apply-movements.ts`

**Interfaces:**
- Consumes: `applyMovements(tx, ctx, plan, snapshot): Promise<PostingPlan>` (§4.7.2, 3B — signature frozen, body extended), `costingEngine` (§4.7.1, 3B), `PostingPlan`, `PlannedLedgerLine`, `PlannedMovement`, `DocumentSnapshot` (§4.4.2), `Money`, `Quantity`, `round`, `MONEY_SCALE` (§4.2.1), `withTenant` (test), `TenantContext` (§4.2.2), `startDb`, `uuidv7`, `seedTenantV2`, `seedAccount`, `seedUnit`, `seedItem`, `seedWarehouse`, `seedLot`, `seedParty`, `seedDocumentType`, `grantCodes`, `postDocument`.

**Why this task creates `packages/db/test/inventory/policies.ts` rather than Task 5.** Task 4 is the first task in execution order that configures a document type, and it configures two: 3C's `GOODS_RECEIPT` (to create the stock) and this slice's `TRANSFER_RECEIPT` (to exercise the fill). Neither can be read from `packages/db/seed/my/document-types/` here — **`TRANSFER_RECEIPT.json` is written by Task 8, four tasks later**, so a fixture that read the pack would fail with ENOENT at execution time even though the plan reads correctly end to end. The constants therefore live in one shared module from this task onward, and Task 9 Step 6 is the case that asserts each one still equals its seed file once all six exist.
- Produces: the §4.7.2 fill contract, implemented:

```ts
/** 3D. Fills the planned ledger lines the evaluator tagged (§4.4.2 `PlannedLedgerLine.fill`) from the
 *  movements this call costed. ALWAYS a non-negative magnitude, and `side` is NEVER altered — direction is
 *  the policy's, through a fixed side or `when: { "line.quantity_sign": … }` (§4.4.2 A9).
 *
 *  Which rule applies is decided by the TAGS THE POLICY PUT ON THE SOURCE LINE, never by how many movements
 *  survived the evaluator's zero-drop:
 *    one tag kind on the line  → that tag receives |the sole movement's value|
 *    both tag kinds on the line (a two-quantity variance line):
 *      `cost`           → |receipt.value|,  Money.zero when the receipt leg is absent
 *      `variance_value` → | |issue.value| − |receipt.value| |, an absent leg counting as zero
 */
function fillTaggedLedgerLines(plan: PostingPlan, costed: readonly PlannedMovement[]): PostingPlan;
/** 3D. A `transfer` line's ISSUE leg is costed first and prices the receipt leg from the consumed unit cost,
 *  BEFORE the destination layer is created (§4.7.2 amendment A7). Costing the receipt first would need a cost
 *  for stock that has not yet left the source. The transfer costing order is not negotiable. On EQUAL
 *  quantities the receipt takes the issue's value whole, with no division: `10.0000 ÷ 3 × 3` is `9.9999`, and
 *  two legs of one line carrying two values strand a cent on `1310` for ever. */
function priceTransferReceipt(issue: PlannedMovement, receipt: PlannedMovement): PlannedMovement;
/** 3D. `document_line.cost` per source line — the `fill: "cost"` magnitude when the policy addressed one,
 *  otherwise the sole movement's magnitude. Never negative (§4.7.2), and zero on a total-loss receipt. */
function costByLine(plan: PostingPlan): Map<number, Money>;
```

**Why the tags and not the movement count.** A `TRANSFER_RECEIPT` line whose `counted_quantity` is `0` — nothing arrived — plans an issue out of the corridor and a receipt of zero, and Task 3's behaviour 3 **drops** the zero receipt because `app.inventory_movement` carries `check (quantity <> 0)`. One movement survives on a line the policy tagged with both `cost` and `variance_value`. A rule keyed on "one movement ⇒ both tags get its value" would then debit the destination's inventory account the full dispatched value for goods that do not exist and credit `1310` twice — a document that balances perfectly and is entirely wrong. Keyed on the tags instead, `cost` is `Money.zero` and the variance legs carry the whole loss, which is the only reading of the four `TRANSFER_RECEIPT` rules that keeps "the corridor clears to zero on every receipt" true.

**The transfer costing order, and why it is not negotiable.** For a `transfer` line the issue leg is costed **first**; its consumed value divided by its quantity is the unit cost, and the receipt leg's `value` is that unit cost times the receipt quantity, computed **before** the destination layer is created. Costing the receipt first would need a cost for stock that has not yet left the source. 3D is the first slice to use `effect: "transfer"`, so nothing before it pinned this.

- [ ] **Step 1: Write the failing test**

`packages/db/test/costing/apply-movements-fill.test.ts`. The suite drives the **real** `postDocument`, so it proves the fill through the whole step-9/step-10 path rather than unit-testing a private function:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  grantCodes, seedAccount, seedDocumentType, seedItem, seedLot, seedParty, seedTenantV2, seedUnit,
  seedWarehouse, type Seed,
} from "../fixtures";
// The shared test-policy module, CREATED BY THIS TASK (the second fence of this step) because Task 4 is the
// first task in execution order that configures a document type. Tasks 5, 7, 8 and 9 append to it.
// The policies are `as const` objects rather than a read of `packages/db/seed/my/document-types/`: this task
// executes BEFORE Task 8, so `TRANSFER_RECEIPT.json` does not exist on disk yet. `GOODS_RECEIPT.json` does
// (it is 3C's), and Task 9 Step 6 is the case that asserts the constant still equals 3C's file.
import { ctxOf, GRN_POLICY, TRANSFER_RECEIPT_POLICY } from "../inventory/policies";

/** File-local. §4.17 assigns 3D no fixtures.ts helper and hazard 9 forbids inventing one beside the
 *  register. Creates every account this slice's policies name by code — including **`2150`**, which is
 *  3C's `GOODS_RECEIPT` credit leg (`{ code: "2150" }`) and therefore needed by `receiveStock` below:
 *  §4.4.1 raises `ERR_POLICY_REQUIRES_MISSING` (422) on an `account.code` the company cannot resolve
 *  rather than falling back to a null account, so the first receipt would fail before any fill assertion
 *  ran. `1250`, `5000` and `5100` are not named by either policy this file posts; they are seeded anyway
 *  so the helper is the same six-plus-one list every other task in this slice uses. */
async function seedInventoryAccounts(db: Db, s: Seed): Promise<void> {
  await seedAccount(db, s, { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" });
  await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
  await seedAccount(db, s, { code: "1310", nameEn: "Goods in transit", type: "asset" });
  await seedAccount(db, s, { code: "2150", nameEn: "Goods received not invoiced", type: "liability" });
  await seedAccount(db, s, { code: "5000", nameEn: "Cost of goods sold", type: "expense" });
  await seedAccount(db, s, { code: "5100", nameEn: "Inventory write-off — expiry loss", type: "expense" });
  await seedAccount(db, s, { code: "5110", nameEn: "Stock-count variance", type: "expense" });
}

/** File-local. Puts `qty` of `itemId` into `warehouseId` at `unitCost` through 3C's GOODS_RECEIPT, which
 *  is the only way stock legitimately exists (hazard 22: nothing outside the posting service writes a
 *  movement). Returns the receipt document id. */
async function receiveStock(
  db: Db, s: Seed, grnTypeId: string,
  opts: {
    itemId: string; unitId: string; warehouseId: string; lotId: string; qty: string; unitCost: string;
    partyId: string;
  },
): Promise<string> {
  const docId = await uuidv7(db.admin);
  const lineId = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    // Two columns an earlier draft of this fixture omitted, both of which fail BEFORE any assertion runs
    // and both of which read like a costing bug when they do:
    //   `series`   — `app.document.series` is `text not null` with NO default (plan0A:1780), so omitting
    //                it raises 23502 on the insert. The value is the policy's own `numbering.series`.
    //   `party_id` — `GRN_POLICY` declares `requires: ["party", "warehouse"]`, and step 4 of §4.3.2 runs
    //                `validateRequires` before anything else, raising ERR_POLICY_REQUIRES_MISSING naming
    //                `party`. The column is nullable in the DDL; the POLICY is what makes it mandatory here.
    await tx`insert into app.document
               (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id,
                party_id, warehouse_id)
             values (${docId}, ${s.tenant}, ${s.company}, ${grnTypeId}, 'GRN', '2026-01-05', 'MYR', ${s.hq},
                     ${opts.partyId}, ${opts.warehouseId})`;
    await tx`insert into app.document_line
               (id, tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id,
                unit_id, quantity, unit_price, amount)
             values (${lineId}, ${s.tenant}, ${s.company}, ${docId}, 1, 'item', ${opts.itemId},
                     ${opts.warehouseId}, ${opts.lotId}, ${opts.unitId}, ${opts.qty}, ${opts.unitCost},
                     round(${opts.qty}::numeric * ${opts.unitCost}::numeric, 4))`;
    // The product is computed in SQL at numeric precision, never as `Number(qty) * Number(cost)`: Global
    // Constraint 1 forbids money through a float "at any phase, for any reason", and fixture code is where
    // that habit gets copied from.
  });
  await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId: docId }));
  return docId;
}

describe("applyMovements — the 3D fill rules (§4.7.2 as amended)", () => {
  let db: Db;
  let s: Seed;
  let item: { itemId: string; baseUnitId: string };
  let whA: string;
  let whTransit: string;
  let lot: string;
  let grn: string;
  let receiptType: string;
  let partyId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "fill");
    await seedInventoryAccounts(db, s);
    await grantCodes(db, s, { codes: [
      "inventory.receipt.post", "inventory.transfer.post", "inventory.adjustment.approve",
      "accounting.journal.post",
    ] });
    await seedUnit(db, s, { code: "EA" });
    item = await seedItem(db, s, { code: "SKU1", trackLots: true });
    // `seedItem` seeds and resolves the item's default accounts itself — 1300, 5000 and 5900 through
    // `seedAccount` (3a:885-910) — so `inventory_account` resolves without an `accounts` override here.
    whA = await seedWarehouse(db, s, { code: "WH-A" });
    whTransit = await seedWarehouse(db, s, { code: "WH-TRANSIT", kind: "in_transit" });
    lot = await seedLot(db, s, { itemId: item.itemId, code: "L1", expiresOn: "2027-01-01" });
    partyId = await seedParty(db, s, { code: "SUP-1", kind: "supplier" });
    grn = await seedDocumentType(db, s, { code: "GOODS_RECEIPT", module: "inventory", policy: GRN_POLICY });
    receiptType = await seedDocumentType(db, s, {
      code: "TRANSFER_RECEIPT", module: "inventory", policy: TRANSFER_RECEIPT_POLICY,
    });
    // 100 units at 3.0000 into the in-transit warehouse: the state a dispatched TRANSFER leaves behind.
    await receiveStock(db, s, grn, { itemId: item.itemId, unitId: item.baseUnitId,
      warehouseId: whTransit, lotId: lot, qty: "100.000000", unitCost: "3.0000", partyId });
  }, 240_000);
  afterAll(async () => { await db?.stop(); });

  async function postReceipt(counted: string, expected: string): Promise<string> {
    const docId = await uuidv7(db.admin);
    const lineId = await uuidv7(db.admin);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      // `series` again (plan0A:1780). TRANSFER_RECEIPT's `requires` is `["warehouse", "to_warehouse"]` and
      // NOT `party`, so this insert carries no `party_id` — the two fixtures differ because the two
      // policies differ, not by oversight.
      await tx`insert into app.document
                 (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id,
                  warehouse_id, to_warehouse_id)
               values (${docId}, ${s.tenant}, ${s.company}, ${receiptType}, 'TRR', '2026-01-20', 'MYR',
                       ${s.hq}, ${whTransit}, ${whA})`;
      // `warehouse_id` is written on the LINE as well as the header, because the policy reads
      // `warehouse: "line.warehouse"` — which is also what `draftTransferReceipt` (Task 8) does, and what
      // this plan's Architecture paragraph means by "always writing `document_line.warehouse_id`
      // explicitly". The corridor is the line's warehouse; the header's `to_warehouse_id` is the
      // destination the receipt movement lands in.
      await tx`insert into app.document_line
                 (id, tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id,
                  unit_id, quantity, counted_quantity, expected_quantity)
               values (${lineId}, ${s.tenant}, ${s.company}, ${docId}, 1, 'item', ${item.itemId},
                       ${whTransit}, ${lot}, ${item.baseUnitId},
                       (${counted}::numeric(19,6) - ${expected}::numeric(19,6)),
                       ${counted}, ${expected})`;
      // The variance is subtracted in SQL, exactly as `draftTransferReceipt` does it — a quantity never
      // passes through `Number()` (Global Constraint 4), and the two operands and their difference are
      // written in one statement so they cannot disagree.
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId: docId }));
    return docId;
  }

  it("an unequal transfer fills `cost` from the receipt leg and `variance_value` from the difference", async () => {
    // 10 left in-transit at 3.0000 = 30.0000; 8 arrived = 24.0000; variance 6.0000.
    const docId = await postReceipt("8.000000", "10.000000");
    // `l.credit desc` is the THIRD sort key and it is load-bearing, not decoration: the expected list holds
    // two `1310` rows whose `debit` is `0.0000` on both, so `order by a.code, l.debit desc` leaves the pair
    // tied and Postgres may return either order — the case would pass or fail on plan choice. The credits
    // (24.0000 and 6.0000) are what separate them.
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; debit: string; credit: string }[]
    >`select a.code, l.debit::text, l.credit::text
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${docId} order by a.code, l.debit desc, l.credit desc`);
    expect(rows).toEqual([
      { code: "1300", debit: "24.0000", credit: "0.0000" },
      { code: "1310", debit: "0.0000",  credit: "24.0000" },
      { code: "1310", debit: "0.0000",  credit: "6.0000"  },
      { code: "5110", debit: "6.0000",  credit: "0.0000"  },
    ]);
    const [dl] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ cost: string }[]>`
      select cost::text from app.document_line where document_id = ${docId}`);
    expect(dl!.cost).toBe("24.0000");            // the matched value, non-negative
  });

  it("the in-transit warehouse is emptied by the ISSUE leg's expected quantity, not the received one", async () => {
    const [soh] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ quantity: string }[]>`
      select quantity::text from app.stock_on_hand
       where company_id = ${s.company} and item_id = ${item.itemId} and warehouse_id = ${whTransit}`);
    expect(soh!.quantity).toBe("90.000000");     // 100 − 10 dispatched-out, not 100 − 8
  });

  it("an exact transfer plans two ledger lines only, both at the same magnitude", async () => {
    const docId = await postReceipt("5.000000", "5.000000");
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; debit: string; credit: string }[]
    >`select a.code, l.debit::text, l.credit::text
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${docId} order by a.code`);
    expect(rows).toEqual([
      { code: "1300", debit: "15.0000", credit: "0.0000" },
      { code: "1310", debit: "0.0000",  credit: "15.0000" },
    ]);
  });

  it("an over-receipt fills the same magnitudes and the POLICY reverses the variance direction", async () => {
    const docId = await postReceipt("7.000000", "6.000000");
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; debit: string; credit: string }[]
    >`select a.code, l.debit::text, l.credit::text
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${docId} order by a.code, l.debit desc, l.credit desc`);
    expect(rows).toEqual([
      { code: "1300", debit: "21.0000", credit: "0.0000" },
      { code: "1310", debit: "3.0000",  credit: "0.0000" },
      { code: "1310", debit: "0.0000",  credit: "21.0000" },
      { code: "5110", debit: "0.0000",  credit: "3.0000" },
    ]);
    // Every amount is a magnitude; nothing in this slice reads a sign to choose a direction (§4.4.2 A9).
    expect(rows.every((r) => !r.debit.startsWith("-") && !r.credit.startsWith("-"))).toBe(true);
  });

  it("a TOTAL LOSS in transit puts the whole dispatched value on 5110 and NOTHING on the destination", async () => {
    // counted 0 against expected 10: the receipt movement's quantity resolves to zero and Task 3's
    // behaviour 3 DROPS it (`app.inventory_movement` carries `check (quantity <> 0)`), so one movement
    // survives on a line the policy tagged with BOTH `cost` and `variance_value`. The fill rule is chosen
    // by the tags, so `cost` is Money.zero: the destination's inventory account is debited nothing and the
    // 30.0000 that left the corridor lands on 5110. If instead 1300 shows a 30.0000 debit and 1310 a
    // 60.0000 credit, `fillTaggedLedgerLines` is still keying on the movement COUNT — that is the defect
    // this case exists to catch, and it produces a document that balances.
    const docId = await postReceipt("0.000000", "10.000000");
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; debit: string; credit: string }[]
    >`select a.code, coalesce(sum(l.debit), 0)::text as debit, coalesce(sum(l.credit), 0)::text as credit
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${docId} group by a.code order by a.code`;
    // Per-account sums, not an exact row list: whether a zero-amount `cost` leg is inserted or dropped
    // before the insert is 3B's business, and the accounting claim is true either way.
    expect(rows).toEqual([
      { code: "1300", debit: "0.0000",  credit: "0.0000"  },   // nothing arrived, nothing is debited
      { code: "1310", debit: "0.0000",  credit: "30.0000" },   // the corridor is relieved ONCE, in full
      { code: "5110", debit: "30.0000", credit: "0.0000"  },   // the whole loss
    ]);
    const [dl] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ cost: string }[]>`
      select cost::text from app.document_line where document_id = ${docId}`);
    expect(dl!.cost).toBe("0.0000");             // `document_line.cost` follows the `fill: "cost"` value
    const [transit] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ q: string }[]>`
      select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
       where item_id = ${item.itemId} and warehouse_id = ${whTransit}`);
    expect(transit!.q).toBe("69.000000");        // 100 − 10 − 5 − 6 − 10: the whole dispatched 10 left
  });

  it("an EXACT receipt whose unit cost does not divide keeps BOTH legs at one value (§4.7.2 A7)", async () => {
    // This case is last on purpose: it changes the corridor's AVCO pool, and the four cases above assert
    // absolute figures against a pool of 3.0000 exactly.
    //
    // Top the corridor up with one unit at 4.0000. The pool becomes 70 units at 211.0000, whose average
    // 3.014285714… needs more precision than MONEY_SCALE holds — which is the whole point.
    await receiveStock(db, s, grn, { itemId: item.itemId, unitId: item.baseUnitId,
      warehouseId: whTransit, lotId: lot, qty: "1.000000", unitCost: "4.0000", partyId });
    const docId = await postReceipt("7.000000", "7.000000");
    // The two legs of ONE transfer line must carry ONE value. A `priceTransferReceipt` that divided the
    // issue value by the issue quantity into a 4-dp `Money` and then re-multiplied would hand the receipt
    // leg a different figure — `21.1000 ÷ 7 = 3.0142857… → 3.0143 → × 7 = 21.1001`. The corridor would then
    // never clear: 1310 was debited |issue.value| at dispatch and is credited |receipt.value| here, so a
    // cent is stranded on the account for ever and Task 7's "1310 carries the value of the goods in
    // transit, to the cent" becomes false one document later.
    //
    // `sum(value)` over the document's two movements is the assertion rather than a literal, because it is
    // exact whichever way 3B rounds the AVCO average (unit cost first, or the extended value first) — and
    // the defect this case catches is a DIFFERENCE between the two legs, not a particular figure.
    const [net] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ net: string; n: number }[]>`
      select coalesce(sum(value), 0)::text as net, count(*)::int as n
        from app.inventory_movement where document_id = ${docId}`);
    expect(net).toEqual({ net: "0.0000", n: 2 });
    // …and the two `cost` ledger legs carry that same single magnitude, as does `document_line.cost`.
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; debit: string; credit: string }[]
    >`select a.code, l.debit::text, l.credit::text
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${docId} order by a.code`);
    expect(rows.map((r) => r.code)).toEqual(["1300", "1310"]);
    const [dl] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ cost: string }[]>`
      select cost::text from app.document_line where document_id = ${docId}`);
    expect(rows[0]!.debit).toBe(dl!.cost);
    expect(rows[1]!.credit).toBe(dl!.cost);
  });
});
```

…and the module it imports, `packages/db/test/inventory/policies.ts` — **one file for all of this slice's policies plus the 3C one its tests need**, so Tasks 4–11 never re-type a policy and cannot drift from the seed files. Each constant is the `policy` member of §4.3.7's envelope, exactly as the seed file carries it; Task 9 Step 6 asserts the two agree after `JSON.parse`. Tasks 5, 7, 8 and 9 **append** to this file and edit nothing already in it:

```ts
import type { TenantContext } from "../../src/with-tenant";
import type { Seed } from "../fixtures";

/** The `TenantContext` every posting call in this directory needs. `requestId` is per-call so an
 *  idempotency replay in one test cannot be served from another's record (§4.2.9). */
export function ctxOf(s: Seed, requestId = `test-${Math.random().toString(36).slice(2)}`): TenantContext {
  return { tenantId: s.tenant, actorId: s.human, requestId };
}

/** 3C's `GOODS_RECEIPT`, repeated here because every test in this slice creates stock with it and
 *  `packages/db/seed/` is not importable from a test (§3.1). If 3C's seed file differs from this constant,
 *  3C's file wins and this one is corrected — Task 9 Step 6 is the check that says so. Note the `2150`
 *  credit leg: every `beforeAll` that configures this policy seeds that account, or the first post raises
 *  `ERR_POLICY_REQUIRES_MISSING` (§4.4.1), and `requires: ["party", "warehouse"]` means every receipt
 *  document carries a `party_id`. */
export const GRN_POLICY = {
  version: 1, documentType: "GOODS_RECEIPT", direction: "inbound", requires: ["party", "warehouse"],
  lines: [
    { for: "each_line", side: "debit",  account: { from: "item.inventory_account" }, amount: "line.cost",   when: { "line.kind": "item" } },
    { for: "each_line", side: "credit", account: { code: "2150" },                  amount: "line.amount", when: { "line.kind": "item" } },
  ],
  inventory: { effect: "receipt", warehouse: "line.warehouse", costing: "create_layer", allowNegative: false },
  tax: { applies: false },
  numbering: { series: "GRN", assignAt: "issue" },
  reversal: { allowed: true, producesType: "PURCHASE_RETURN" },
  approval: { required: false, approve: null, post: "inventory.receipt.post", create: "inventory.receipt.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;

/** §4.14 `TRANSFER_RECEIPT` — the receive leg with variance (spec:1053). Landed here rather than at Task 8
 *  because Task 4 is the first task that posts one, and `TRANSFER_RECEIPT.json` does not exist until Task 8.
 *
 *  FOUR ledger rules, and the shape is load-bearing. The first pair is unconditional and moves what ARRIVED
 *  (`line.cost`, which Task 4 fills with |receipt.value|) out of 1310 and into the destination's inventory
 *  account. The two conditional pairs move the DIFFERENCE (`line.variance_value`, filled with
 *  | |issue.value| − |receipt.value| |) between 1310 and 5110, in whichever direction the variance's sign
 *  says. Net effect on 1310 across all four: a credit of |issue.value| — the exact figure the dispatch
 *  debited — so the corridor clears to zero on every receipt, short or over. That is the arithmetic the DoD
 *  clause's second half rests on, and it is why `variance_value` needs no column (SAH-018). */
export const TRANSFER_RECEIPT_POLICY = {
  version: 1, documentType: "TRANSFER_RECEIPT", direction: "internal", requires: ["warehouse", "to_warehouse"],
  lines: [
    { for: "each_line", side: "debit",  account: { from: "item.inventory_account" }, amount: "line.cost", when: { "line.kind": "item" } },
    { for: "each_line", side: "credit", account: { code: "1310" },                  amount: "line.cost", when: { "line.kind": "item" } },
    // A SHORTFALL (counted < expected, so the variance is negative): the missing value is a loss.
    { for: "each_line", side: "debit",  account: { code: "5110" }, amount: "line.variance_value", when: { "line.kind": "item", "line.quantity_sign": "negative" } },
    { for: "each_line", side: "credit", account: { code: "1310" }, amount: "line.variance_value", when: { "line.kind": "item", "line.quantity_sign": "negative" } },
    // An OVERAGE (counted > expected): more arrived than left. The corridor is over-relieved, so the
    // difference goes back the other way.
    { for: "each_line", side: "debit",  account: { code: "1310" }, amount: "line.variance_value", when: { "line.kind": "item", "line.quantity_sign": "positive" } },
    { for: "each_line", side: "credit", account: { code: "5110" }, amount: "line.variance_value", when: { "line.kind": "item", "line.quantity_sign": "positive" } },
  ],
  inventory: {
    effect: "transfer", warehouse: "line.warehouse", to_warehouse: "header.to_warehouse",
    costing: "consume_layers", allowNegative: false,
  },
  tax: { applies: false },
  numbering: { series: "TRR", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },        // see "the reversal interaction" in Task 8
  approval: { required: false, approve: null, post: "inventory.transfer.post", create: "inventory.transfer.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test costing/apply-movements-fill`
Expected: FAIL — the first case reports the four ledger rows with `debit`/`credit` of `"0.0000"` on the `5110` and second `1310` rows (the tagged lines were never filled), and `document_line.cost` as `null`.

- [ ] **Step 3: Implement the fill in `applyMovements`**

Append to `packages/db/src/costing/apply-movements.ts`. 3B's body already computes each movement's `value` through `costingEngine`; these two functions run **after** that and **before** the function returns the plan:

```ts
/** 3D. Non-negative magnitude of a Money, as a Money. `abs()` is §4.2.1's own member. */
const mag = (m: Money): Money => m.abs();

/**
 * 3D (§4.7.2). Fills every planned ledger line the evaluator tagged with `fill`, from the movements this
 * call costed. `amount` and `base` are always non-negative and `side` is NEVER touched: the direction is
 * the policy's, through a fixed side or `when: { "line.quantity_sign": … }` (§4.4.2 A9). Both are the same
 * figure because this slice's six types are single-currency internal or outbound documents at rate 1; a
 * later slice that transfers across currencies converts here through `toBase`.
 *
 * The rule is chosen by the TAGS the policy put on the source line, not by how many movements survived the
 * evaluator's zero-quantity drop. That distinction is load-bearing: a TRANSFER_RECEIPT line whose
 * `counted_quantity` is 0 loses its receipt movement to the drop and leaves ONE movement on a line the
 * policy tagged with both `cost` and `variance_value`. Treating that as "one movement, so both tags get its
 * value" debits the destination's inventory account the full dispatched value for goods that never arrived
 * and credits 1310 twice, in a document that balances.
 */
function fillTaggedLedgerLines(plan: PostingPlan, costed: readonly PlannedMovement[]): PostingPlan {
  const bySource = new Map<number, PlannedMovement[]>();
  for (const m of costed) {
    const list = bySource.get(m.lineNo) ?? [];
    list.push(m);
    bySource.set(m.lineNo, list);
  }
  // Which fill references the policy resolved on each source line. Two kinds on one line ⇒ the policy is
  // describing a matched value AND a difference, which is only true of a two-quantity variance line.
  const tagKinds = new Map<number, Set<NonNullable<PlannedLedgerLine["fill"]>>>();
  for (const l of plan.ledgerLines) {
    if (l.fill === undefined || l.sourceLineNo === null) continue;
    const kinds = tagKinds.get(l.sourceLineNo) ?? new Set<NonNullable<PlannedLedgerLine["fill"]>>();
    kinds.add(l.fill);
    tagKinds.set(l.sourceLineNo, kinds);
  }
  const ledgerLines = plan.ledgerLines.map((l) => {
    if (l.fill === undefined || l.sourceLineNo === null) return l;
    const ms = bySource.get(l.sourceLineNo);
    if (ms === undefined || ms.length === 0 || ms.some((m) => m.value === null)) return l;
    const issue = ms.find((m) => m.effect === "issue");
    const receipt = ms.find((m) => m.effect === "receipt");
    let amount: Money;
    if ((tagKinds.get(l.sourceLineNo)?.size ?? 1) < 2) {
      // A single-value line — DELIVERY_ORDER, TRANSFER, STOCK_COUNT, EXPIRY_WRITE_OFF. One movement, or a
      // transfer's pair at equal quantities where both legs carry the same magnitude by construction
      // (`priceTransferReceipt` derives the receipt from the issue's unit cost).
      amount = mag((issue ?? ms[0]!).value!);
    } else {
      // A two-quantity variance line. `l.amount` is the plan's Money.zero for this line (amendment A5), so
      // its currency is the base currency and `Money.zero(l.amount.currency)` needs no second source.
      const zero = Money.zero(l.amount.currency);
      const iv = issue === undefined ? zero : mag(issue.value!);
      const rv = receipt === undefined ? zero : mag(receipt.value!);
      amount = l.fill === "cost" ? rv : mag(iv.subtract(rv));
    }
    return { ...l, amount, base: amount };
  });
  return { ...plan, ledgerLines };
}

/**
 * 3D (§4.7.2). A `transfer` line's ISSUE leg is costed first; the receipt leg's value is the consumed
 * unit cost times the receipt quantity, set BEFORE the destination layer is created. Costing the receipt
 * first would need a cost for stock that has not yet left the source. Called from the per-line loop, in
 * place of costing the two legs independently.
 *
 * **Equal quantities take the whole issue value, without a division.** `divide` produces a `Money` at
 * MONEY_SCALE 4, so on a value that does not divide by its quantity the round trip loses a cent:
 * `10.0000 ÷ 3 = 3.3333`, and `3.3333 × 3 = 9.9999`. On the common case — everything dispatched arrived —
 * that would hand the two legs of one line two different values: `1310` is debited |issue.value| at
 * dispatch and credited |receipt.value| at receipt, so the corridor never clears and a cent is stranded on
 * the account for ever. The quantities being equal is exactly the condition under which the unit cost is
 * not needed at all, so the division is skipped rather than rounded.
 */
function priceTransferReceipt(issue: PlannedMovement, receipt: PlannedMovement): PlannedMovement {
  if (issue.quantity.compare(receipt.quantity) === 0) return { ...receipt, value: mag(issue.value!) };
  const unitCost = mag(issue.value!).divide(issue.quantity.toDecimal(), "HALF_AWAY_FROM_ZERO");
  return { ...receipt, value: unitCost.multiply(receipt.quantity.toDecimal(), "HALF_AWAY_FROM_ZERO") };
}
```

**What this does *not* fix, stated so a later pass does not read it as fixed.** `app.cost_layer` stores `qty_in` and a `unit_cost numeric(19,4)` and **no `value` column** (§4.7.3, contracts:3076–3079), so a layer's value is `qty_remaining × unit_cost` and a receipt whose value does not divide by its quantity is representable only to the nearest cent *in the layer*, on **every** document type, not only a transfer. That residual is 3B's and §4.7.3's, and a `TRANSFER_RECEIPT` on an unequal pair still meets it. The equal-quantity branch above closes the part that is **3D's**: two legs of one line disagreeing with each other, which is what makes Task 7's "1310 carries the value of the goods in transit, to the cent" false one document later. If Task 11's tie-out A ever fails by a sub-cent on an unequal transfer, that is the §4.7.3 residual and the Execution handoff's "raise it against whichever slice owns the account" rule applies — it is not a licence to round here.

Wire both into the existing body: in the per-line loop, when a line produced an `issue` and a `receipt` movement, cost the issue through `costingEngine.cost()` and derive the receipt with `priceTransferReceipt` instead of costing it separately; and immediately before `return plan`, replace the return with:

```ts
  // 3D: fill the tagged ledger lines, then write document_line.cost as the same non-negative magnitude
  // as the line's `fill: "cost"` value (4A and 7B read that column).
  const filled = fillTaggedLedgerLines(plan, plan.movements);
  for (const [lineNo, amount] of costByLine(filled)) {
    await tx`update app.document_line set cost = ${amount.toString()}
              where document_id = ${snapshot.header.id} and line_no = ${lineNo}`;
  }
  return filled;
```

with the small selector beside the two functions above:

```ts
/** 3D. `document_line.cost` per source line: the `fill: "cost"` magnitude when the policy addressed one,
 *  otherwise the sole movement's magnitude. Never negative (§4.7.2). */
function costByLine(plan: PostingPlan): Map<number, Money> {
  const out = new Map<number, Money>();
  for (const l of plan.ledgerLines) {
    if (l.fill === "cost" && l.sourceLineNo !== null && !out.has(l.sourceLineNo)) out.set(l.sourceLineNo, l.amount);
  }
  for (const m of plan.movements) {
    if (!out.has(m.lineNo) && m.value !== null) out.set(m.lineNo, mag(m.value));
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --cwd packages/db test costing && bun run --cwd packages/db test posting`
Expected: PASS — the **six** new cases (unequal fill, the in-transit quantity, exact, over-receipt, total loss, and the non-dividing unit cost) plus 3A's and 3B's costing suites unchanged. `fillTaggedLedgerLines` is a no-op on every plan whose lines carry no `fill` tag, which is every document type before this slice.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/costing/apply-movements.ts \
        packages/db/test/inventory/policies.ts \
        packages/db/test/costing/apply-movements-fill.test.ts
git commit -m "feat(db): applyMovements fills the tagged ledger lines as magnitudes [3D T4]

The §4.7.2 fill rules: one movement -> |value|; an equal transfer -> |issue.value|;
an unequal transfer -> |receipt.value| for `cost` and the difference for
`variance_value`. The issue leg is costed first and prices the receipt leg. `side`
is never altered - direction is the policy's (§4.4.2 A9).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `SALES_ORDER`, the order-to-delivery conversion with FEFO, and SAH-018

The first of the six types, and the one that carries the conversion service the next task's `DELIVERY_ORDER` is drafted by. `SALES_ORDER` is the sales twin of 3C's `PURCHASE_ORDER`: `direction: none`, `lines: []`, nothing posts, and its open quantity is 3C's derived view — never a stored counter (SAH-017, SAH-018).

**Files:**
- Create: `packages/db/seed/my/document-types/SALES_ORDER.json`
- Create: `packages/db/src/inventory/fulfilment.ts`
- Create: `packages/db/src/inventory/index.ts`
- Create: `packages/contracts/src/inventory/fulfilment.ts`
- Create: `packages/db/test/inventory/fulfilment.test.ts`
- Create: `apps/api/test/routes/accounting/document-fulfilment.test.ts`
- Modify: `packages/db/test/inventory/policies.ts` (Task 4 created it; this task appends `SALES_ORDER_POLICY` and `DELIVERY_ORDER_POLICY`)
- Modify: `packages/db/src/index.ts` (re-export `./inventory`)
- Modify: `packages/contracts/src/index.ts` (re-export `./inventory/fulfilment`)
- Modify: `apps/api/src/routes/accounting/documents.ts` (one sub-path)
- Modify: `tests/regression/sah-017.test.ts` (append a `— 3D` block)

**Interfaces:**
- Consumes: `linkFulfilment(tx, ctx, input)`, `openQuantity(tx, documentId)`, `listLinks(tx, documentId)`, `LinkFulfilmentInput`, `FulfilmentLineInput`, `OpenQuantityRow`, `DocumentLinkRow`, `LinkKind`, `ERR_DOC_LINK_OVER_FULFILLED` (§4.18, 3C, `packages/db/src/documents/link.ts`); `pickLotsFefo(tx, params)` and `FefoPick` (3A, **`packages/db/src/inventory/lots.ts`** — 3A ships no `fefo.ts`; its file structure puts `createLot`, `listLots`, `sentinelLotId`, `pickLotsFefo` and `FefoPick` in `lots.ts` (3a:114, 3a:6534) and the barrel line is `export { pickLotsFefo, type FefoPick } from "./inventory/lots";` at 3a:6795); `resolvePolicy` (§4.3.1, 1A); `requireDocumentPermission("create")`, `requireDocumentModuleRead()` (§4.5.4, 2A/2C); `AppError`, `ERRORS`, `fromDatabaseError` (§4.2.4); `IdempotencyHeader`, `RouteModule` (§4.2.7); `UuidSchema`, `QuantitySchema`, `ListEnvelope`, `ProblemSchema` (§4.2.8); `Quantity` (§4.2.1); `withTenant` (test) / `TenantContext` (§4.2.2); `draftTypedDocument`, `DraftLine`, `seedTenantV2`, `seedAccount`, `seedDocumentType`, `seedParty`, `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot`, `grantCodes` (§4.17); `startApi`, `sharedApi`, `grantAdmin`, `problemOf` (§4.2.12, §4.17.1); `sourceFiles` (0B, §4.17.1 — the `sah-017` block's only dependency; this task calls neither `sharedDb` nor `thinRegression`).
- Produces:

```ts
// packages/db/src/inventory/fulfilment.ts
export interface ConvertToDeliveryInput {
  /** The SALES_ORDER being converted. Must be `issued` (3C's rule for a link source). */
  sourceDocumentId: string;
  /** The DELIVERY_ORDER type to draft. Resolved by the caller so this function never reads a code register. */
  targetDocumentTypeId: string;
  targetSeries: string;
  effectiveDate: string;
  /** The warehouse every drafted line ships from. NOT optional and never defaulted from the header:
   *  `applyMovements` needs a warehouse per line, and a null one is an `ERR_POLICY_REQUIRES_MISSING` at post. */
  warehouseId: string;
  /** Which order lines to fulfil, and how much of each. A line omitted here stays fully open (a back-order,
   *  spec:1050). `quantity` is a 6-dp magnitude string; a quantity above the line's open quantity is refused
   *  by 3C's guard with `ERR_DOC_LINK_OVER_FULFILLED`. */
  lines: readonly { sourceLineId: string; quantity: string }[];
  /** Resolve each drafted line's lot through `app.pick_lots_fefo`, splitting one order line into one drafted
   *  line per lot. Default true — the Phase 3 DoD clause "FEFO picking returns the earliest-expiring lot"
   *  is proven through this path (spec:1051). False leaves `lot_id` null and lets `applyMovements` resolve
   *  the item's `NONE` sentinel, which is what a non-lot-tracked item wants.
   *
   *  **FEFO never reduces the requested quantity.** `app.pick_lots_fefo` caps each pick at the lot's
   *  available quantity and stops when the warehouse is exhausted — 3A's own test is titled "returns fewer
   *  rows than asked rather than raising — the refusal is the trigger's job" — so `Σ picked` may be less
   *  than `quantity`. The shortfall becomes **one final pair with a null lot**, so the drafted lines always
   *  sum to exactly what was asked and `app.assert_stock_available` sees the true over-issue. Capping the
   *  draft to on-hand instead would make test 18's re-run and test 7's "gone negative" leg vacuous. */
  fefo?: boolean;
}
export interface ConvertResultLine {
  targetLineId: string; sourceLineId: string; lineNo: number;
  itemId: string; warehouseId: string; lotId: string | null; quantity: string;
}
export interface ConvertResult {
  documentId: string;                 // the drafted DELIVERY_ORDER
  lines: ConvertResultLine[];
  links: DocumentLinkRow[];           // 3C's rows, linkKind "converts_to"
  /** The source order's open quantity AFTER the links were written — read back from 3C's view, never
   *  computed here (SAH-017/SAH-018: the remaining quantity is a projection, never a stored column). */
  remaining: OpenQuantityRow[];
}
/** Drafts one DELIVERY_ORDER from one SALES_ORDER inside the caller's transaction and links the two through
 *  3C's `linkFulfilment` with `linkKind: "converts_to"`. Writes `document` and `document_line` rows and
 *  nothing else — it never posts, never writes a movement and never sets `document_line.cost` (§4.7.2 owns
 *  that column). Raises `ERR_VALIDATION_FAILED` when the source is not `issued`, `ERR_NOT_FOUND` when a named
 *  source line is not on the source document, and lets 3C's over-fulfilment guard raise
 *  `ERR_DOC_LINK_OVER_FULFILLED` untouched. */
export async function convertOrderToDelivery(
  tx: Sql, ctx: TenantContext, input: ConvertToDeliveryInput,
): Promise<ConvertResult>;
```

```ts
// packages/contracts/src/inventory/fulfilment.ts
export const ConvertDocumentBody: z.ZodObject<{
  targetDocumentTypeCode; targetSeries; effectiveDate; warehouseId; fefo; lines }>;
export const ConvertResultLineSchema: z.ZodObject<{ targetLineId; sourceLineId; lineNo; itemId; warehouseId; lotId; quantity }>;
export const ConvertResultSchema: z.ZodObject<{ documentId; lines; links; remaining }>;
```

**Why the *source* order is the path parameter and the target type is in the body.** 3C put the target in the path because its caller already had a draft receipt. Here the target does not exist yet, so there is nothing to name — and §4.5.4 covers exactly this: for the `create` stage `requireDocumentPermission` resolves the policy of **"the type named in the body"**. The gate therefore asks `DELIVERY_ORDER`'s `approval.create` (`inventory.transfer.create`), not `SALES_ORDER`'s, which is the right question: the authority being requested is "may this principal raise a delivery", and a salesperson who may raise orders must not thereby be able to ship stock. The route body carries `targetDocumentTypeCode` (a code, resolved to an id by the handler) so a client never sends a `document_type` uuid it has no way to know.

**Open quantity is read, never stored (SAH-018).** `ConvertResult.remaining` comes from a `select` on `app.document_open_quantity` after the links are inserted. This slice adds no column anywhere that holds a delivered, returned or remaining quantity, and `tests/regression/sah-018.test.ts` proves it by scanning `information_schema` for one. **That file is created by Task 6, not here**, because its third case converts a real order and therefore needs `DELIVERY_ORDER` configured — and `DELIVERY_ORDER.json` is written by Task 6 Step 3. Creating it here would either read a seed file that does not yet exist or fork a third copy of the policy into the `tests` workspace, which is the duplication hazard 9 forbids.

- [ ] **Step 1: Write the failing DB-tier test**

`packages/db/test/inventory/fulfilment.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertOrderToDelivery } from "../../src/inventory/fulfilment";
import { issueDocument, postDocument } from "../../src/posting";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedItem, seedLot, seedParty,
  seedTenantV2, seedUnit, seedWarehouse, type Seed,
} from "../fixtures";
import { ctxOf, DELIVERY_ORDER_POLICY, GRN_POLICY, SALES_ORDER_POLICY } from "./policies";

describe("convertOrderToDelivery — SALES_ORDER → DELIVERY_ORDER (spec:1050-1051, §4.14)", () => {
  let db: Db;
  let s: Seed;
  let soType: string;
  let doType: string;
  let itemId: string;
  let unitId: string;
  let warehouseId: string;
  let partyId: string;
  let lotEarly: string;
  let lotLate: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-fulfil");
    await grantCodes(db, s);
    await seedAccount(db, s, { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" });
    await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    // `2150` is GRN_POLICY's credit leg. Without it `receive()` below raises ERR_POLICY_REQUIRES_MISSING at
    // post (§4.4.1: an §4.15 account code the company cannot resolve is a 422, never a null-account
    // fallback), and the FEFO cases would fail on an empty warehouse rather than on their own claim.
    await seedAccount(db, s, { code: "2150", nameEn: "Goods received not invoiced", type: "liability" });
    soType = await seedDocumentType(db, s, { code: "SALES_ORDER", module: "inventory", policy: SALES_ORDER_POLICY });
    doType = await seedDocumentType(db, s, { code: "DELIVERY_ORDER", module: "inventory", policy: DELIVERY_ORDER_POLICY });
    partyId = await seedParty(db, s, { code: "CUST-1", kind: "customer" });
    warehouseId = await seedWarehouse(db, s, { code: "WH-MAIN" });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, { code: "SKU-FEFO", trackLots: true, baseUnitId: unitId }));
    // The FEFO proof needs two lots whose expiry order is the OPPOSITE of their insertion order,
    // so a query that happened to return them by ctid would fail this test.
    lotLate = await seedLot(db, s, { itemId, code: "LOT-DEC", expiresOn: "2026-12-31" });
    lotEarly = await seedLot(db, s, { itemId, code: "LOT-MAR", expiresOn: "2026-03-31" });
  }, 180_000);
  afterAll(async () => { await db?.stop(); });

  /** Puts stock in both lots through a GOODS_RECEIPT (3C) — the only legitimate way stock exists.
   *  `warehouseId` is on the HEADER as well as the line: `GRN_POLICY` declares
   *  `requires: ["party", "warehouse"]` and §4.3.2 step 4's `validateRequires` reads the header. */
  async function receive(lotId: string, qty: string): Promise<void> {
    const grn = await seedDocumentType(db, s, { code: "GOODS_RECEIPT", module: "inventory", policy: GRN_POLICY });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: grn, series: "GRN", effectiveDate: "2026-01-05", partyId, warehouseId,
      lines: [{ kind: "item", itemId, warehouseId, lotId, unitId, quantity: qty, unitPrice: "3.0000", amount: "0" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
  }

  it("converts a partial quantity, links with `converts_to` and leaves the rest open", async () => {
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType, series: "SO", effectiveDate: "2026-01-10", partyId,
      lines: [{ kind: "item", itemId, warehouseId, unitId, quantity: "10.000000", unitPrice: "5.0000", amount: "50.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => issueDocument(tx, ctxOf(s), { documentId: order.documentId }));

    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId, targetDocumentTypeId: doType, targetSeries: "DO",
        effectiveDate: "2026-01-12", warehouseId, fefo: false,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "4.000000" }],
      }));

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.quantity).toBe("4.000000");
    expect(result.links.map((l) => l.linkKind)).toEqual(["converts_to"]);
    expect(result.remaining[0]!.openQuantity).toBe("6.000000");
  });

  it("FEFO splits one order line into one drafted line per lot, earliest expiry first", async () => {
    await receive(lotLate, "5.000000");
    await receive(lotEarly, "3.000000");
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType, series: "SO", effectiveDate: "2026-01-15", partyId,
      lines: [{ kind: "item", itemId, warehouseId, unitId, quantity: "4.000000", unitPrice: "5.0000", amount: "20.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => issueDocument(tx, ctxOf(s), { documentId: order.documentId }));

    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId, targetDocumentTypeId: doType, targetSeries: "DO",
        effectiveDate: "2026-01-16", warehouseId, fefo: true,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "4.000000" }],
      }));

    // LOT-MAR expires 2026-03-31 and LOT-DEC 2026-12-31, so the March lot is exhausted first.
    expect(result.lines.map((l) => [l.lotId, l.quantity])).toEqual([
      [lotEarly, "3.000000"],
      [lotLate,  "1.000000"],
    ]);
    expect(result.lines.map((l) => l.lineNo)).toEqual([1, 2]);
  });

  it("a quantity ABOVE on-hand drafts the FULL quantity — N lot pairs plus one null-lot shortfall pair", async () => {
    // The two receipts above put 3 in LOT-MAR and 5 in LOT-DEC and nothing has been posted out, so 8 units
    // exist. Asking for 12 must draft 12, not 8: `app.pick_lots_fefo` caps its picks at what each lot holds
    // and returns fewer rows than asked (3A), and a conversion that accepted that cap would silently ship
    // less than the customer ordered, link only the capped quantity, and make the negative-stock override
    // path unreachable — test 18's re-run (Task 6) and test 7's "gone negative" leg (Task 11) both go
    // through exactly this call.
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType, series: "SO", effectiveDate: "2026-01-17", partyId,
      lines: [{ kind: "item", itemId, warehouseId, unitId, quantity: "12.000000", unitPrice: "5.0000", amount: "60.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => issueDocument(tx, ctxOf(s), { documentId: order.documentId }));

    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId, targetDocumentTypeId: doType, targetSeries: "DO",
        effectiveDate: "2026-01-18", warehouseId, fefo: true,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "12.000000" }],
      }));

    expect(result.lines.map((l) => [l.lotId, l.quantity])).toEqual([
      [lotEarly, "3.000000"],
      [lotLate,  "5.000000"],
      [null,     "4.000000"],        // the uncovered remainder; applyMovements resolves the NONE sentinel
    ]);
    // The drafted quantity is exactly what was asked, and the WHOLE of it is linked to the order line, so
    // the order closes and 3C's over-fulfilment guard would fire on a second conversion.
    expect(result.remaining[0]!.openQuantity).toBe("0.000000");
  });

  it("a quantity above the open quantity is refused by 3C's guard", async () => {
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType, series: "SO", effectiveDate: "2026-01-20", partyId,
      lines: [{ kind: "item", itemId, warehouseId, unitId, quantity: "2.000000", unitPrice: "5.0000", amount: "10.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => issueDocument(tx, ctxOf(s), { documentId: order.documentId }));
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId, targetDocumentTypeId: doType, targetSeries: "DO",
        effectiveDate: "2026-01-21", warehouseId, fefo: false,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "3.000000" }],
      }))).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
  });

  it("a DRAFT source is refused — 3C's link source must be issued or posted", async () => {
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType, series: "SO", effectiveDate: "2026-01-22", partyId,
      lines: [{ kind: "item", itemId, warehouseId, unitId, quantity: "1.000000", unitPrice: "5.0000", amount: "5.0000" }],
    });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId, targetDocumentTypeId: doType, targetSeries: "DO",
        effectiveDate: "2026-01-23", warehouseId, fefo: false,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
      }))).rejects.toThrow(/ERR_VALIDATION_FAILED: source document .* is draft, not issued or posted/);
  });

  it("a source line id that is not on the source document is ERR_NOT_FOUND", async () => {
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType, series: "SO", effectiveDate: "2026-01-24", partyId,
      lines: [{ kind: "item", itemId, warehouseId, unitId, quantity: "1.000000", unitPrice: "5.0000", amount: "5.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => issueDocument(tx, ctxOf(s), { documentId: order.documentId }));
    const stranger = await draftTypedDocument(db, s, {
      documentTypeId: soType, series: "SO", effectiveDate: "2026-01-24", partyId,
      lines: [{ kind: "item", itemId, warehouseId, unitId, quantity: "1.000000", unitPrice: "5.0000", amount: "5.0000" }],
    });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId, targetDocumentTypeId: doType, targetSeries: "DO",
        effectiveDate: "2026-01-25", warehouseId, fefo: false,
        lines: [{ sourceLineId: stranger.lineIds[0]!, quantity: "1.000000" }],
      }))).rejects.toThrow(/ERR_NOT_FOUND: document line .* is not a line of document/);
  });
});
```

The three policy constants and `ctxOf` all live in `packages/db/test/inventory/policies.ts` — `ctxOf` and `GRN_POLICY` from **Task 4**, which created that module, and `SALES_ORDER_POLICY` / `DELIVERY_ORDER_POLICY` appended by Step 2 below. The import block above names all four alongside `postDocument` and `issueDocument` from `../../src/posting` — **the block is complete as written and `bun run typecheck` is the check.** `openQuantity` is deliberately **not** imported: the remaining quantity is read by `convertOrderToDelivery` itself and returned as `ConvertResult.remaining`, so importing it here would be an unused binding.

- [ ] **Step 2: Append the two sales policies to the shared test policies module**

`packages/db/test/inventory/policies.ts` was **created by Task 4** with `ctxOf`, `GRN_POLICY` and `TRANSFER_RECEIPT_POLICY`. This step appends two constants to it and edits nothing already there. Each constant is the `policy` member of §4.3.7's envelope, exactly as the seed file will carry it; Task 9 Step 6 asserts the two agree after `JSON.parse`.

```ts
/** §4.14 `SALES_ORDER` — the sales twin of 3C's PURCHASE_ORDER. `lines: []` is the whole of "non-posting". */
export const SALES_ORDER_POLICY = {
  version: 1, documentType: "SALES_ORDER", direction: "none", requires: ["party"], lines: [],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "SO", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.sales.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as const;

/** §4.14 `DELIVERY_ORDER` — stock out before the invoice (F-19). `allowNegative: true` is load-bearing:
 *  amendment A8b makes `cost()` admit an uncovered quantity only when BOTH this flag and the override event
 *  are present, and test 18's re-run and test 7 both go negative through this type. */
export const DELIVERY_ORDER_POLICY = {
  version: 1, documentType: "DELIVERY_ORDER", direction: "outbound", requires: ["party", "warehouse"],
  lines: [
    { for: "each_line", side: "debit",  account: { code: "1250" },                    amount: "line.cost", when: { "line.kind": "item" } },
    { for: "each_line", side: "credit", account: { from: "item.inventory_account" },   amount: "line.cost", when: { "line.kind": "item" } },
  ],
  inventory: { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers", allowNegative: true },
  tax: { applies: false },
  numbering: { series: "DO", assignAt: "issue" },
  reversal: { allowed: true, producesType: "DELIVERY_ORDER" },
  approval: { required: false, approve: null, post: "inventory.transfer.post", create: "inventory.transfer.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;
```

Tasks 7, 8 and 9 append `TRANSFER_POLICY`, `STOCK_COUNT_POLICY` and `EXPIRY_WRITE_OFF_POLICY` to this same file. `GRN_POLICY` and `TRANSFER_RECEIPT_POLICY` are already in it from Task 4 and are not re-declared here.

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run --cwd packages/db test inventory/fulfilment`
Expected: FAIL — `Cannot find module '../../src/inventory/fulfilment'`. Once Step 5 lands the module, the FEFO case is the one that fails on content, reporting one drafted line of `4.000000` against the expected two.

- [ ] **Step 4: Write `packages/db/seed/my/document-types/SALES_ORDER.json`**

```json
{
  "code": "SALES_ORDER",
  "nameEn": "Sales Order",
  "nameAr": "أمر بيع",
  "module": "inventory",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "SALES_ORDER",
    "direction": "none",
    "requires": ["party"],
    "lines": [],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "SO", "assignAt": "issue" },
    "reversal": { "allowed": false, "producesType": null },
    "approval": { "required": false, "approve": null, "post": "accounting.sales.create" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

`module` is `inventory` and not `accounting` even though `approval.post` is `accounting.sales.create`: §4.14's rule is that the column is the **attachment download gate** and an order's attachments — the customer's purchase order, the delivery instruction — are filed and read by the warehouse (hazard 34). `dimensions.required` is `[]` for 3C's reason: the check runs over planned ledger lines and there are none.

- [ ] **Step 5: Write `packages/db/src/inventory/fulfilment.ts`**

```ts
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";
import { Quantity } from "@dulja/domain";
import type { TenantContext } from "../with-tenant";
import { linkFulfilment, openQuantity, type DocumentLinkRow, type OpenQuantityRow } from "../documents/link";
// 3A ships `pickLotsFefo` and `FefoPick` from `lots.ts`, NOT from a `fefo.ts` — there is no such file
// (3a:114, 3a:6534, 3a:6795). Task 0's gate greps this exact export path.
import { pickLotsFefo } from "./lots";

export interface ConvertToDeliveryInput {
  sourceDocumentId: string;
  targetDocumentTypeId: string;
  targetSeries: string;
  effectiveDate: string;
  warehouseId: string;
  lines: readonly { sourceLineId: string; quantity: string }[];
  fefo?: boolean;
}
export interface ConvertResultLine {
  targetLineId: string; sourceLineId: string; lineNo: number;
  itemId: string; warehouseId: string; lotId: string | null; quantity: string;
}
export interface ConvertResult {
  documentId: string;
  lines: ConvertResultLine[];
  links: DocumentLinkRow[];
  remaining: OpenQuantityRow[];
}

interface SourceLine {
  id: string; line_no: number; item_id: string | null; unit_id: string | null;
  unit_price: string | null; discount: string; description: string | null; dimensions: Record<string, string>;
}

/**
 * SALES_ORDER → DELIVERY_ORDER. Runs inside the caller's transaction so the draft, its lines and 3C's links
 * are one atomic unit: a half-linked delivery would show a wrong open quantity for as long as it existed.
 *
 * FEFO splitting is why one source line can become several target lines. `app.pick_lots_fefo` returns
 * (lot_id, quantity) rows oldest-expiry-first over the SYNCHRONOUS stock_on_hand projection (3A, ADR 0036);
 * picking here, at drafting time, is correct precisely because nothing is posted yet — inside a posting
 * transaction the projection has not been MERGEd and `assert_stock_available` is the control instead.
 *
 * The function writes `document` and `document_line` only. It sets no `cost` (that is `applyMovements`,
 * §4.7.2), issues nothing and posts nothing: the caller transitions the draft when the picker is done.
 */
export async function convertOrderToDelivery(
  tx: Sql, ctx: TenantContext, input: ConvertToDeliveryInput,
): Promise<ConvertResult> {
  const [source] = await tx<{ id: string; company_id: string; status: string; party_id: string | null; branch_id: string; currency: string; exchange_rate: string }[]>`
    select id, company_id, status, party_id, branch_id, currency, exchange_rate::text as exchange_rate
      from app.document where id = ${input.sourceDocumentId}`;
  if (source === undefined) {
    throw new AppError("ERR_NOT_FOUND", `document ${input.sourceDocumentId} is not visible`);
  }
  if (source.status !== "issued" && source.status !== "posted") {
    throw new AppError(
      "ERR_VALIDATION_FAILED",
      `source document ${input.sourceDocumentId} is ${source.status}, not issued or posted`,
    );
  }

  const ids = input.lines.map((l) => l.sourceLineId);
  const sourceLines = await tx<SourceLine[]>`
    select id, line_no, item_id, unit_id, unit_price::text as unit_price, discount::text as discount,
           description, dimensions
      from app.document_line
     where document_id = ${input.sourceDocumentId} and id = any(${ids})`;
  const byId = new Map(sourceLines.map((l) => [l.id, l]));
  for (const id of ids) {
    if (!byId.has(id)) {
      throw new AppError("ERR_NOT_FOUND", `document line ${id} is not a line of document ${input.sourceDocumentId}`);
    }
  }

  const [target] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       party_id, warehouse_id, branch_id)
    values (${ctx.tenantId}, ${source.company_id}, ${input.targetDocumentTypeId}, ${input.targetSeries},
            ${input.effectiveDate}, ${source.currency}, ${source.exchange_rate},
            ${source.party_id}, ${input.warehouseId}, ${source.branch_id})
    returning id`;
  const documentId = target!.id;

  const drafted: ConvertResultLine[] = [];
  const linkLines: { sourceLineId: string; targetLineId: string; quantity: string }[] = [];
  let lineNo = 0;

  for (const wanted of input.lines) {
    const src = byId.get(wanted.sourceLineId)!;
    // One (lotId, quantity) pair per drafted line. FEFO off, or an item with no lot-tracked stock, gives
    // exactly one pair with a null lot — applyMovements resolves the item's 'NONE' sentinel (SAH-050).
    let pairs: { lotId: string | null; quantity: string }[] = [{ lotId: null, quantity: wanted.quantity }];
    if ((input.fefo ?? true) && src.item_id !== null) {
      const asked = Quantity.of(wanted.quantity);
      const picked = await pickLotsFefo(tx, {
        itemId: src.item_id, warehouseId: input.warehouseId, quantity: asked,
      });
      if (picked.length > 0) {
        pairs = picked.map((p) => ({ lotId: p.lotId, quantity: p.quantity.toString() }));
        // FEFO returns FEWER rows than asked when the warehouse cannot cover the quantity (3A: "the refusal
        // is the trigger's job"). The requested quantity is NEVER reduced here: the uncovered remainder
        // becomes one final pair with a null lot, which `applyMovements` resolves to the item's `NONE`
        // sentinel (SAH-050) so `app.assert_stock_available` sees the true over-issue and either raises
        // ERR_STOCK_INSUFFICIENT or admits it against an `inventory.negative_stock.override` event
        // (§4.5.3). Capping the draft to on-hand would make test 18's re-run and test 7's "gone negative"
        // leg vacuous, and would link only the capped quantity to the order line.
        const covered = picked.reduce((sum, p) => sum.add(p.quantity), Quantity.zero());
        const shortfall = asked.subtract(covered);
        if (shortfall.compare(Quantity.zero()) > 0) {
          pairs.push({ lotId: null, quantity: shortfall.toString() });
        }
      }
    }
    for (const pair of pairs) {
      lineNo += 1;
      const [row] = await tx<{ id: string }[]>`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, description, item_id, warehouse_id, lot_id,
           unit_id, quantity, unit_price, discount, amount, dimensions)
        values (${ctx.tenantId}, ${source.company_id}, ${documentId}, ${lineNo}, 'item', ${src.description},
                ${src.item_id}, ${input.warehouseId}, ${pair.lotId}, ${src.unit_id}, ${pair.quantity},
                ${src.unit_price}, ${src.discount}, 0, ${tx.json(src.dimensions)})
        returning id`;
      drafted.push({
        targetLineId: row!.id, sourceLineId: src.id, lineNo,
        itemId: src.item_id!, warehouseId: input.warehouseId, lotId: pair.lotId, quantity: pair.quantity,
      });
      linkLines.push({ sourceLineId: src.id, targetLineId: row!.id, quantity: pair.quantity });
    }
  }

  // 3C's writer, and 3C's over-fulfilment guard. `priceFromSource: false` — the price is already copied
  // above from the order line, and letting 3C copy it again would recompute `amount` on a line whose amount
  // is deliberately 0 (a delivery carries no revenue; 4A's SALES_INVOICE does).
  const links = await linkFulfilment(tx, ctx, {
    sourceDocumentId: input.sourceDocumentId, targetDocumentId: documentId,
    linkKind: "converts_to", lines: linkLines, priceFromSource: false,
  });

  return { documentId, lines: drafted, links, remaining: await openQuantity(tx, input.sourceDocumentId) };
}
```

`packages/db/src/inventory/index.ts`:

```ts
// The barrel `packages/db/src/index.ts` re-exports. 3A's inventory modules (`items.ts`, `units.ts`,
// `warehouses.ts`, `lots.ts`, `prices.ts`, `promotions.ts`, `stock.ts`, `expiry.ts` — there is no
// `fefo.ts`) are already exported individually from the main barrel; this file collects only
// 3D's four services so one line in the main barrel covers the slice.
export { convertOrderToDelivery } from "./fulfilment";
export type { ConvertToDeliveryInput, ConvertResult, ConvertResultLine } from "./fulfilment";
```

Add `export * from "./inventory";` to `packages/db/src/index.ts` beneath 3C's exports.

- [ ] **Step 6: Add the wire contracts and the route sub-path**

`packages/contracts/src/inventory/fulfilment.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, QuantitySchema, UuidSchema } from "../common";
import { DocumentLinkSchema, OpenQuantitySchema } from "../accounting/document-link";

export const ConvertDocumentBody = z.object({
  /** A §4.14 CODE, not an id: a client has no way to know a `document_type` uuid. The handler resolves it. */
  targetDocumentTypeCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  targetSeries: z.string().regex(/^[A-Z0-9-]{1,16}$/),
  effectiveDate: DateSchema,
  warehouseId: UuidSchema,
  fefo: z.boolean().default(true),
  lines: z.array(z.object({ sourceLineId: UuidSchema, quantity: QuantitySchema })).min(1),
}).strict().openapi("ConvertDocumentBody");

export const ConvertResultLineSchema = z.object({
  targetLineId: UuidSchema, sourceLineId: UuidSchema, lineNo: z.number().int().positive(),
  itemId: UuidSchema, warehouseId: UuidSchema, lotId: UuidSchema.nullable(), quantity: QuantitySchema,
}).openapi("ConvertResultLine");

export const ConvertResultSchema = z.object({
  documentId: UuidSchema,
  lines: z.array(ConvertResultLineSchema),
  links: z.array(DocumentLinkSchema),
  remaining: z.array(OpenQuantitySchema),
}).openapi("ConvertResult");
```

In `apps/api/src/routes/accounting/documents.ts`, add the one sub-path beside 3C's five. It declares `IdempotencyHeader` because it is an unsafe method (spec:2055, §4.2.9) and it gates on the **body's** type:

```ts
const convertRoute = createRoute({
  method: "post",
  path: "/{documentId}/convert",
  tags: ["accounting"],
  summary: "Convert an issued order into a fulfilment document (SALES_ORDER → DELIVERY_ORDER)",
  // §4.5.4: for the `create` stage the middleware resolves the policy of the type named in the BODY, which
  // is DELIVERY_ORDER's `approval.create` (inventory.transfer.create) — not the order's. A salesperson who
  // may raise orders must not thereby be able to ship stock.
  middleware: [requireDocumentPermission("create")] as const,
  request: {
    params: z.object({ documentId: z.string().uuid(), companyId: z.string().uuid() }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: ConvertDocumentBody } } },
  },
  responses: {
    201: { description: "The drafted fulfilment document", content: { "application/json": { schema: ConvertResultSchema } } },
    400: { description: "Invalid body or source status", content: { "application/problem+json": { schema: ProblemSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "Source document or line not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    409: { description: "Over-fulfilment", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

documentRoutes.openapi(convertRoute, async (c) => {
  const { documentId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await c.var.withTenant(async (tx) => {
    const [type] = await tx<{ id: string }[]>`
      select id from app.document_type where code = ${body.targetDocumentTypeCode} and archived_at is null`;
    if (type === undefined) {
      throw new AppError("ERR_NOT_FOUND", `document type ${body.targetDocumentTypeCode} is not configured`);
    }
    return convertOrderToDelivery(tx, c.var.ctx, {
      sourceDocumentId: documentId, targetDocumentTypeId: type.id, targetSeries: body.targetSeries,
      effectiveDate: body.effectiveDate, warehouseId: body.warehouseId, fefo: body.fefo, lines: body.lines,
    });
  });
  return c.json(result, 201);
});
```

No `PROBES` entry and no new `RouteModule`: this is a sub-path of 1A's `documents` module, whose probe key `/v1/companies/:companyId/documents` already exists (§4.2.7, hazard 31).

- [ ] **Step 7: Write the route test**

`apps/api/test/routes/accounting/document-fulfilment.test.ts` — the four cases Global Constraint 2 requires of every new endpoint (Zod schema, OpenAPI entry, idempotency on an unsafe method, a tenant-isolation assertion; the last is 0B's `tests/invariants/tenant-isolation.test.ts` walking `ROUTES`, which this sub-path joins for free because it is on 1A's already-registered `documents` module). `api` is `sharedApi()`'s `StartedApi`, `s` its `Seed`, and `order` a `SALES_ORDER` issued in the `beforeAll` through `draftTypedDocument` + `issueDocument`, exactly as the DB-tier suite does it.

```ts
  it("201s and returns a body that validates against ConvertResultSchema", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
      as: s.human, idempotencyKey: "conv-201",
      body: {
        targetDocumentTypeCode: "DELIVERY_ORDER", targetSeries: "DO", effectiveDate: "2026-01-12",
        warehouseId, fefo: false, lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(201);
    // `parse`, not `safeParse().success`: a failure must name the member that did not match.
    const body = ConvertResultSchema.parse(await res.json());
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]!.quantity).toBe("1.000000");
    expect(body.links.map((l) => l.linkKind)).toEqual(["converts_to"]);
  });

  it("400s a request with no Idempotency-Key (spec:2055, §4.2.9)", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
      as: s.human, idempotencyKey: null,          // the helper omits the header entirely
      body: {
        targetDocumentTypeCode: "DELIVERY_ORDER", targetSeries: "DO", effectiveDate: "2026-01-12",
        warehouseId, fefo: false, lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_REQUIRED");
  });

  it("403s a principal who may raise orders but not ship stock (the gate reads the BODY's type)", async () => {
    const salesOnly = await grantCodes(db, s, {
      codes: ["accounting.sales.create"], principalId: await secondPrincipal(db, s, "sales"), roleCode: "sales-only",
    });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
      as: salesOnly.principalId, idempotencyKey: "conv-403",
      body: {
        targetDocumentTypeCode: "DELIVERY_ORDER", targetSeries: "DO", effectiveDate: "2026-01-12",
        warehouseId, fefo: false, lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("a replay of the same Idempotency-Key returns the SAME documentId and drafts no second delivery", async () => {
    const body = {
      targetDocumentTypeCode: "DELIVERY_ORDER", targetSeries: "DO", effectiveDate: "2026-01-13",
      warehouseId, fefo: false, lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
    };
    // Counted around the pair rather than absolutely: the 201 case above already converted part of this
    // order, so an absolute "exactly one" would be wrong for a reason that has nothing to do with replay.
    const targets = () => withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(distinct target_document_id)::int as n
        from app.document_link where source_document_id = ${order.documentId}`);
    const [before] = await targets();
    const first = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
      as: s.human, idempotencyKey: "conv-replay", body,
    });
    const second = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
      as: s.human, idempotencyKey: "conv-replay", body,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = ConvertResultSchema.parse(await first.json());
    const b = ConvertResultSchema.parse(await second.json());
    expect(b.documentId).toBe(a.documentId);
    // …and the replay was served from the idempotency record rather than re-run: the pair added exactly ONE
    // delivery to the order, which a second draft would have made two.
    const [after] = await targets();
    expect(after!.n).toBe(before!.n + 1);
  });
```

- [ ] **Step 8: Append a `— 3D` block to `tests/regression/sah-017.test.ts`**

3B created the file and 3C appended to it; this slice appends a third block and edits neither. A plain `describe` beside the existing blocks — **not** a `thinRegression` call: that wrapper runs its body inside a single `it` (0b:5317–5326), which is a nested-test error, and 3B's Self-Review finding 7 records the same correction (3b:6801). This block needs no database at all, so it destructures nothing from `sharedDb()`; `sourceFiles` comes from `../support/source` (§4.17.1, 0B):

```ts
describe("SAH-017 Open quantity defined once — 3D", () => {
  it("the SALES_ORDER side reads the same view the PURCHASE_ORDER side does", async () => {
    // One definition serves both directions: exactly one file in `packages/db/src` READS the view, and no
    // file computes open quantity a second way.
    //
    // The predicate is the `from` clause and NOT `/open_quantity/`, deliberately. 3C ships a second file
    // whose text contains the column name — `packages/db/src/schema/document-open-quantity.ts`, the Drizzle
    // mirror `pgView("document_open_quantity", { … openQuantity: numeric("open_quantity", …) }).existing()`
    // (3c:975-989). That mirror is a **declaration of the migration's view, not a second definition**, and
    // `.existing()` means Drizzle never emits DDL for it. A future slice must not delete it to make this
    // test pass — narrow the predicate instead, exactly as this line does.
    const files = await sourceFiles("packages/db/src");
    const readers = files.filter((f) => /from app\.document_open_quantity/.test(f.text));
    expect(readers.map((f) => f.path).sort()).toEqual(["packages/db/src/documents/link.ts"]);
    // …and nothing anywhere re-derives it. The view's own expression is `ordered_quantity − coalesce(Σ
    // link.quantity, 0)`; that shape appearing in `src` at all would be the second definition SAH-017 names.
    const rederivers = files.filter((f) => /ordered_quantity\s*-\s*coalesce\(/.test(f.text));
    expect(rederivers.map((f) => f.path)).toEqual([]);
  });
});
```

- [ ] **Step 9: Apply the sub-pack against the test tenant and run everything**

Run: `bun run --cwd packages/db test inventory/fulfilment && bun run --cwd apps/api test document-fulfilment && bun run --cwd packages/db seed --tenant "$TEST_TENANT" --only document-types && bun run --cwd packages/db test seed/document-types && bun run test tests/regression/sah-017.test.ts`
Expected: PASS. The seed run is idempotent on `(document_type_id, version)` (§3.4.8) and loads `SALES_ORDER.json` for the first time; `seed/document-types.test.ts` (1A) validates every envelope in the directory against `document-type-seed.schema.json` and every `policy` against the catalogue, so a bad `approval` code fails here and not at post (F-21).

- [ ] **Step 10: Commit**

```bash
git add packages/db/seed/my/document-types/SALES_ORDER.json \
        packages/db/src/inventory/fulfilment.ts packages/db/src/inventory/index.ts packages/db/src/index.ts \
        packages/contracts/src/inventory/fulfilment.ts packages/contracts/src/index.ts \
        packages/db/test/inventory/policies.ts packages/db/test/inventory/fulfilment.test.ts \
        apps/api/src/routes/accounting/documents.ts \
        apps/api/test/routes/accounting/document-fulfilment.test.ts \
        tests/regression/sah-017.test.ts
git commit -m "feat(inventory): SALES_ORDER and the order-to-delivery conversion with FEFO [3D T5]

SALES_ORDER as configuration (direction none, lines []); convertOrderToDelivery drafts a
DELIVERY_ORDER from an issued order through 3C's linkFulfilment, splitting one order line
into one line per lot via app.pick_lots_fefo. Back-orders stay open because the remaining
quantity is 3C's view and no column; tests/regression/sah-018.test.ts proves that at Task 6,
once DELIVERY_ORDER.json exists to seed the conversion's target type from the pack.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `DELIVERY_ORDER` — stock out to `1250`, and the negative-stock override on a real sale (test 18 re-run)

The type that makes stock leave before an invoice exists (spec:1051, F-19). Its two ledger legs debit **`1250` goods delivered not invoiced** and credit the item's inventory account at the line's cost; 4A's `SALES_INVOICE` clears `1250` when it is linked to the delivery. This task also re-runs **acceptance test 18** on a real sale: an over-issue is refused by the data layer, and admitted only through an `inventory.negative_stock.override` event recorded by a **second** principal.

**Files:**
- Create: `packages/db/seed/my/document-types/DELIVERY_ORDER.json`
- Create: `packages/db/test/inventory/delivery-order.test.ts`
- Create: `tests/regression/sah-018.test.ts` (3D creates it, §3.7.3 — here rather than at Task 5 because its third case seeds `DELIVERY_ORDER` from the pack file Step 3 writes)
- Modify: `packages/db/test/inventory/policies.ts` (nothing — `DELIVERY_ORDER_POLICY` landed at Task 5)
- Modify: `tests/regression/sah-048.test.ts` (append a `— 3D` block)

**Interfaces:**
- Consumes: `postDocument`, `issueDocument`, `loadSnapshot`, `PostResult`, `PostingError` (§4.3.1, 1A); `applyMovements` with the Task 4 fill (§4.7.2); `costingEngine`, `CostingInput.allowShortfall` (§4.7.1, 3B); `recordOverride` (§4.3.1, 2B); `app.assert_stock_available`, `app.assert_override_authorised` (3A, 2B); `secondPrincipal` (§4.17.1, exported at Task 0); `convertOrderToDelivery` (Task 5); `draftTypedDocument`, `grantCodes`, `seedAccount`, `seedDocumentType`, `seedItem`, `seedLot`, `seedParty`, `seedUnit`, `seedWarehouse`, `seedTenantV2` (§4.17); `ensureOpenPeriods` (§4.17.1, 3B); `Money`, `Quantity` (§4.2.1); and for the two regression files, `sharedDb` and `REPO_ROOT` (§4.17.1, 0B) — **not** `thinRegression`, for the reason Step 4 gives.
- Produces: `packages/db/seed/my/document-types/DELIVERY_ORDER.json` — the §4.14 row `DELIVERY_ORDER` / module `inventory` / series `DO` / `direction: outbound` / `inventory: issue` / `approval.post: inventory.transfer.post`. **No TypeScript.** The whole type is configuration; that is this task's claim.

**Why `allowNegative: true` on this policy and nowhere else in the slice.** Amendment A8b makes `costingEngine.cost()` admit an uncovered quantity only when **both** the policy's `inventory.allowNegative` is true **and** an `inventory.negative_stock.override` event exists for the document (`applyMovements` reads the event and sets `CostingInput.allowShortfall`). Two conditions, deliberately: the flag says "this document type can, in principle, be authorised to go short" and the event says "on this document, a second principal authorised it". A type with the flag and no event still fails, and a type with an event and no flag still fails. `DELIVERY_ORDER` is the only type in this slice that carries it, because a delivery is the only outbound movement a business genuinely sometimes has to make against a stock figure it knows is stale (spec:1308's "the till shows a stale figure and says so" is the POS twin). `TRANSFER`, `STOCK_COUNT` and `EXPIRY_WRITE_OFF` all leave it `false`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/inventory/delivery-order.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// `recordOverride` lives beside `postDocument` in `packages/db/src/posting/` (contracts §4.3.1, file layout
// at contracts:2046 — 2B put it in `posting/lifecycle.ts` and the barrel re-exports it). There is no
// `src/documents/events.ts`; an earlier draft of this block named one.
import { issueDocument, postDocument, recordOverride } from "../../src/posting";
import { convertOrderToDelivery } from "../../src/inventory/fulfilment";
import { currency, Money, Quantity } from "@dulja/domain";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedItem, seedLot, seedParty,
  seedTenantV2, seedUnit, seedWarehouse, type Seed,
} from "../fixtures";
import { ctxOf, DELIVERY_ORDER_POLICY, GRN_POLICY, SALES_ORDER_POLICY } from "./policies";
// §4.17.1 amendment 12 (Task 0): the one shared test helper this slice exports rather than copies.
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";

const MYR = currency("MYR");
/** The agreed selling price. It reaches no ledger row in this slice — 4A's SALES_INVOICE is what recognises
 *  revenue (F-19) — but the order line carries it so the invoice can read it. */
const SELL = Money.of("9.0000", MYR);

describe("DELIVERY_ORDER — stock out to 1250, and the override path (spec:1051, test 18)", () => {
  let db: Db;
  let s: Seed;
  let soType: string; let doType: string; let grnType: string;
  let itemId: string; let unitId: string; let warehouseId: string; let partyId: string; let lotId: string;
  let acc1250: string; let acc1300: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-do");
    await grantCodes(db, s);
    acc1250 = await seedAccount(db, s, { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" });
    acc1300 = await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, s, { code: "2150", nameEn: "Goods received not invoiced", type: "liability" });
    soType = await seedDocumentType(db, s, { code: "SALES_ORDER", module: "inventory", policy: SALES_ORDER_POLICY });
    doType = await seedDocumentType(db, s, { code: "DELIVERY_ORDER", module: "inventory", policy: DELIVERY_ORDER_POLICY });
    grnType = await seedDocumentType(db, s, { code: "GOODS_RECEIPT", module: "inventory", policy: GRN_POLICY });
    partyId = await seedParty(db, s, { code: "CUST-1", kind: "customer" });
    warehouseId = await seedWarehouse(db, s, { code: "WH-MAIN" });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, {
      code: "SKU-DO", trackLots: true, baseUnitId: unitId,
      accounts: { inventoryAccountId: acc1300 },
    }));
    lotId = await seedLot(db, s, { itemId, code: "LOT-A", expiresOn: "2026-06-30" });
    // 20 units at 3.0000 = 60.0000 of stock, one layer.
    await receive("20.000000", "3.0000", "60.0000");
  }, 180_000);
  afterAll(async () => { await db?.stop(); });

  /** `amount` is passed in rather than multiplied out: every fixture figure here is a hand-chosen constant
   *  and Global Constraint 1 forbids money through a float even in a test. */
  async function receive(qty: string, price: string, amount: string): Promise<string> {
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: grnType, series: "GRN", effectiveDate: "2026-01-05", partyId, warehouseId,
      lines: [{ kind: "item", itemId, warehouseId, lotId, unitId, quantity: qty, unitPrice: price, amount }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
    return documentId;
  }

  /** Drafts a delivery for `qty` and posts it, returning the PostResult. The order line's extended amount is
   *  computed through `Money`, which is exact at scale 4 — `Number(qty) * 9` is the float this codebase
   *  never writes (Global Constraint 1). Nothing posts from the order itself (`lines: []`), so the figure is
   *  only what 4A's invoice will read. */
  async function deliver(qty: string, effectiveDate: string, beforePost?: (tx: unknown, id: string) => Promise<unknown>) {
    const extended = SELL.multiply(Quantity.of(qty).toDecimal(), "HALF_AWAY_FROM_ZERO");
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType, series: "SO", effectiveDate, partyId,
      lines: [{ kind: "item", itemId, warehouseId, unitId, quantity: qty, unitPrice: SELL.toString(),
                amount: extended.toString() }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => issueDocument(tx, ctxOf(s), { documentId: order.documentId }));
    return withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const { documentId } = await convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId, targetDocumentTypeId: doType, targetSeries: "DO",
        effectiveDate, warehouseId, fefo: true,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: qty }],
      });
      await issueDocument(tx, ctxOf(s), { documentId });
      if (beforePost !== undefined) await beforePost(tx, documentId);
      return { documentId, result: await postDocument(tx, ctxOf(s), { documentId }) };
    });
  }

  it("posts exactly two ledger lines: debit 1250, credit the item's inventory account, at cost", async () => {
    const { documentId } = await deliver("5.000000", "2026-01-10");
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; debit: string; credit: string }[]
    >`select a.code, e.debit::text, e.credit::text
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${documentId} order by a.code`);
    // 5 at the AVCO unit cost of 3.0000 = 15.0000. The DELIVERY carries no revenue: 9.0000 is the agreed
    // SELLING price, copied onto the line for 4A's invoice, and it appears in NO ledger row here.
    expect(rows).toEqual([
      { code: "1250", debit: "15.0000", credit: "0.0000" },
      { code: "1300", debit: "0.0000",  credit: "15.0000" },
    ]);
  });

  it("writes one negative movement and decrements stock_on_hand", async () => {
    const { documentId } = await deliver("2.000000", "2026-01-11");
    const [mv] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { quantity: string; value: string; lot_id: string; movement_no: number }[]
    >`select quantity::text, value::text, lot_id, movement_no
        from app.inventory_movement where document_id = ${documentId}`);
    expect(mv!.quantity).toBe("-2.000000");   // + receipt, − issue (§4.7.3)
    expect(mv!.value).toBe("-6.0000");
    expect(mv!.lot_id).toBe(lotId);           // FEFO resolved the only lot with stock
    expect(mv!.movement_no).toBe(1);
  });

  it("document_line.cost is the non-negative magnitude applyMovements wrote", async () => {
    const { documentId } = await deliver("1.000000", "2026-01-12");
    const [line] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ cost: string }[]>`
      select cost::text from app.document_line where document_id = ${documentId}`);
    expect(line!.cost).toBe("3.0000");        // never "-3.0000" — §4.7.2 amendment A6
  });

  it("an over-issue with NO override is refused by the data layer with ERR_STOCK_INSUFFICIENT (test 18)", async () => {
    await expect(deliver("500.000000", "2026-01-13")).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
  });

  it("an over-issue WITH a second principal's override event posts, and the shortfall has no consumption row", async () => {
    const supervisor = await secondPrincipal(db, s, "supervisor");
    await grantCodes(db, s, {
      codes: ["inventory.negative_stock.override"], principalId: supervisor, roleCode: "override-holder",
    });
    const remaining = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ q: string }[]>`
      select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
       where item_id = ${itemId} and warehouse_id = ${warehouseId}`);
    const onHand = Quantity.of(remaining[0]!.q);
    const asked = onHand.add(Quantity.of("4.000000"));   // four units more than exist

    const { documentId, result } = await deliver(asked.toString(), "2026-01-14", async (tx, id) =>
      // The ONE door F-6 admits, in the ONE shape §4.5.3's guard accepts. `recordOverride` does NOT take
      // `actor_id` from the ctx — `document_event.actor_id` defaults to `app.current_actor()`, so inside
      // this transaction it is always `s.human`, the document's creator (3B states this at 3b:2631-2634 and
      // shapes `postOverriddenIssue` the same way). The supervisor is therefore the **attributed**
      // principal: `assert_override_authorised` resolves `coalesce(attributed_to, actor_id)` and refuses
      // when that equals `created_by`. Passing a supervisor-flavoured ctx instead would insert
      // `actor_id = s.human, attributed_to = null` and raise. The event must be inserted BEFORE
      // postDocument: `assert_stock_available` fires inside it.
      recordOverride(tx as never, ctxOf(s), {
        documentId: id, code: "inventory.negative_stock.override", reason: "customer collection, count pending",
        attributedTo: supervisor,
      }));

    expect(result.status).toBe("posted");
    // Task 5's FEFO split put the uncovered four units on their own line against the item's `NONE`
    // sentinel lot, so WH-MAIN now has two `stock_on_hand` rows for this item (LOT-A at 0 and NONE at −4).
    // Sum them: a single-row read would return whichever key the planner produced first.
    const [soh] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ q: string }[]>`
      select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
       where item_id = ${itemId} and warehouse_id = ${warehouseId}`);
    expect(soh!.q).toBe("-4.000000");          // genuinely negative, and visible as such

    // `cost_consumption.layer_id` is NOT NULL (§4.7.3), so the four uncovered units have no consumption
    // row — the covered quantity is consumed as usual and the uncovered quantity carries no value on
    // either side. That asymmetry is 3B's golden fixture to define, not this slice's.
    const [cons] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ q: string }[]>`
      select coalesce(sum(c.quantity), 0)::text as q
        from app.cost_consumption c
        join app.inventory_movement m on m.id = c.movement_id
       where m.document_id = ${documentId}`);
    expect(Quantity.of(cons!.q).toString()).toBe(onHand.toString());
  });

  it("the override event needs a SECOND principal — the creator authorising itself is refused", async () => {
    // `attributedTo: s.human` is the creator, so `coalesce(attributed_to, actor_id)` = `created_by` and the
    // guard raises. This case is deliberately distinguishable from the one above: both run as `s.human`,
    // and the ONLY difference is which principal the override is attributed to — which is exactly the
    // control §4.5.3 describes. (Omitting `attributedTo` altogether raises the same code, because the
    // column then falls back to `app.current_actor()`, and that is what makes the positive case above
    // impossible to write any other way.)
    await expect(deliver("999.000000", "2026-01-15", async (tx, id) =>
      recordOverride(tx as never, ctxOf(s), {
        documentId: id, code: "inventory.negative_stock.override", reason: "self-authorised",
        attributedTo: s.human,
      }))).rejects.toThrow(/ERR_OVERRIDE_NOT_AUTHORISED: an override on document .* needs a second principal/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test inventory/delivery-order`
Expected: FAIL in `beforeAll` — `seedDocumentType` succeeds (the policy constant exists) but the first case reports `expect(received).toEqual([...])` with `received: []`, because `DELIVERY_ORDER.json` is not in the pack and nothing else is missing. **If instead it fails with `ERR_COST_NEGATIVE` or an unhandled `CostingError` on the override case, stop:** that is the 3B `allowShortfall` gap Task 0's gate script checks for, and the fix is 3B's, never a `try/catch` here.

**Two failures that mean the opposite of what they look like, and both are about Task 5's FEFO split.** If the **500-unit** case *passes cleanly* — a posted delivery instead of `ERR_STOCK_INSUFFICIENT` — then `convertOrderToDelivery` is still capping the drafted quantity at what FEFO returned, and the assertion is vacuous rather than green: the delivery was drafted at 20 units and posted correctly. Same for the override case reading `stock_on_hand` as `0` instead of `-4`. In both cases the fix is Task 5's shortfall pair (one final pair with a null lot for `asked − Σ picked`), not a change here; re-run `bun run --cwd packages/db test inventory/fulfilment` and check the "a quantity ABOVE on-hand drafts the FULL quantity" case first.

- [ ] **Step 3: Write `packages/db/seed/my/document-types/DELIVERY_ORDER.json`**

```json
{
  "code": "DELIVERY_ORDER",
  "nameEn": "Delivery Order",
  "nameAr": "أمر تسليم",
  "module": "inventory",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "DELIVERY_ORDER",
    "direction": "outbound",
    "requires": ["party", "warehouse"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "code": "1250" },                  "amount": "line.cost", "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "credit", "account": { "from": "item.inventory_account" }, "amount": "line.cost", "when": { "line.kind": "item" } }
    ],
    "inventory": { "effect": "issue", "warehouse": "line.warehouse", "costing": "consume_layers", "allowNegative": true },
    "tax": { "applies": false },
    "numbering": { "series": "DO", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "DELIVERY_ORDER" },
    "approval": { "required": false, "approve": null, "post": "inventory.transfer.post", "create": "inventory.transfer.create" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

Four choices worth stating, because each has an alternative a reader will reach for:

- **`amount: "line.cost"` on both legs, not `line.amount`.** A delivery moves *cost*, not price. `line.unit_price` carries the agreed selling price so 4A's invoice can read it, and it must reach no ledger row before `SALES_INVOICE` exists — otherwise revenue is recognised at dispatch, which is the error F-19 exists to avoid. Both legs resolve from `LineSnapshot.cost`, which is `null` at plan time and filled by `applyMovements` at step 9 (amendment A5 keeps the line alive at `Money.zero` until then).
- **`requires: ["party", "warehouse"]`.** A delivery without a customer cannot be invoiced later, and `validateRequires` refusing at post beats a null `party_id` discovered in Phase 4. `warehouse` is the header's; the *lines* each carry their own, which is what `warehouse: "line.warehouse"` reads.
- **`approval.required: false`.** spec:1050's "no approval workflow (that stays Phase 10)" covers the order; the delivery inherits it. R1 is therefore vacuous on this type by design, and the R1 proof lives on `STOCK_COUNT` (Task 8), where spec:2026 requires it.
- **`reversal.producesType: "DELIVERY_ORDER"`.** A cancelled delivery is a delivery with negated quantities, which amendment A2's effect flip turns into a *receipt* automatically — the returned stock goes back to the same lot, and no `DELIVERY_RETURN` type is needed or registered. ⚠️ **That claim is about the movement only, and this plan asserts nothing about the reversal's ledger direction.** Both legs address `amount: "line.cost"` with a **fixed** `side`, 3C copies `document_line.cost` onto the reversal line **unnegated** (3c:219 — "`cost` is a magnitude, so it is copied and not negated"), and §4.7.2's fill rules never alter `side`; so A9's sign flip has no negative amount to act on and the reversal would debit `1250` a second time. Reversing that needs either `reverseDocument` to negate `cost` or the evaluator to read `line.cost` on a negative-quantity line as negative — **a 2A/3C amendment, not a 3D change**, and it must land before Phase 4 relies on a `DELIVERY_ORDER` reversal to clear `1250`. No test in this slice reverses a `DELIVERY_ORDER`, and none should be added here.

- [ ] **Step 4: Create `tests/regression/sah-018.test.ts` and append a `— 3D` block to `tests/regression/sah-048.test.ts`**

**Both blocks are plain `describe`s, and neither calls `thinRegression`.** 0B's `thinRegression(sah, heading, cites: string, body)` runs its body **inside a single `it`** (0b:5317–5326), so declaring cases in it is a nested-test error; its `cites` is a `string`, not an array; and the body's parameter is 0B's `ThinContext` — stated verbatim as `{ db, rw, a, b, withTenant, expect }` (3b:5971) — which carries no `s`, no document-type ids and none of this slice's services. 3B's Self-Review finding 7 records having made exactly this mistake and having fixed it the same way, and 2A appended to 0B's files the same way (2a:4664). `sharedDb()` gives the shared container and its shape is destructured as **`const { db } = await sharedDb();` then `db.admin`** (3b:6022) — there is no `rw.db`. The module is **`tests/support/regression.ts`** (§4.17.1), never `../support/shared`.

`tests/regression/sah-018.test.ts` — 3D is the first slice in execution order to touch SAH-018 (§6.3), so it **creates** the file; 4A appends its own block for returned quantity once credit notes exist. The file gets its own tenant on the shared container, for 3B's reason (3b:5973): the shared `a`/`b` seeds come from Plan 0A's `seedTenant`, which wires neither `fx_rounding_account_id` nor the `1000`/`4000` accounts.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sharedDb } from "../support/regression";
import { convertOrderToDelivery, issueDocument, withTenant } from "@dulja/db";
import {
  draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedItem, seedParty, seedTenantV2,
  seedUnit, seedWarehouse, type Seed,
} from "@dulja/db/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../support/source";

/** The two envelopes are read from the seed pack rather than re-typed: `packages/db/test/inventory/
 *  policies.ts` is not part of `@dulja/db/test`'s exports, and a third copy of either policy is the
 *  duplication hazard 9 forbids. `REPO_ROOT` is 0B's (§4.17.1) — Vitest runs this workspace from `tests/`,
 *  so a bare relative path never resolves. Both files exist by this task: SALES_ORDER at Task 5 Step 4 and
 *  DELIVERY_ORDER at Step 3 above. */
const packPolicy = (code: string): unknown =>
  (JSON.parse(readFileSync(
    join(REPO_ROOT, "packages", "db", "seed", "my", "document-types", `${code}.json`), "utf8",
  )) as { policy: unknown }).policy;

/**
 * SAH-018 — the legacy system stored a returned/delivered quantity as a column on the order row and it drifted
 * from the movements within weeks. The fix is structural: a fulfilled, delivered or returned quantity is a
 * PROJECTION over `document_link` and `inventory_movement`, and no table holds one.
 */
describe("SAH-018 Delivered and returned quantity as a projection, never a stored column — 3D", () => {
  let s: Seed;
  let soType: string; let doType: string;
  let itemId: string; let unitId: string; let warehouseId: string; let partyId: string;
  let ctx: { tenantId: string; actorId: string; requestId: string };

  beforeAll(async () => {
    const { db } = await sharedDb();
    s = await seedTenantV2(db, "sah-018");
    ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah-018" };
    await grantCodes(db, s);
    await seedAccount(db, s, { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" });
    soType = await seedDocumentType(db, s, { code: "SALES_ORDER", module: "inventory", policy: packPolicy("SALES_ORDER") });
    doType = await seedDocumentType(db, s, { code: "DELIVERY_ORDER", module: "inventory", policy: packPolicy("DELIVERY_ORDER") });
    partyId = await seedParty(db, s, { code: "CUST-1", kind: "customer" });
    warehouseId = await seedWarehouse(db, s, { code: "WH-018" });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, { code: "SKU-018", trackLots: false, baseUnitId: unitId }));
  }, 180_000);
  // No `afterAll`: the container belongs to `sharedDb()` and is stopped by the run, not by this file.

  it("no table carries a delivered / fulfilled / returned / remaining quantity column", async () => {
    const { db } = await sharedDb();
    const rows = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'app'
         and (column_name ~ '(delivered|fulfilled|returned|remaining|shipped)_(quantity|qty)'
              or column_name in ('quantity_delivered', 'quantity_returned', 'quantity_remaining'))
         -- cost_layer.qty_remaining is the ONE legitimate exception: a layer's remaining quantity is the
         -- layer's own state, written by the costing engine, not a duplicate of anything (§4.7.3).
         and not (table_name = 'cost_layer' and column_name = 'qty_remaining')
       order by table_name, column_name`;
    expect(rows).toEqual([]);
  });

  it("open quantity comes from a view over document_link, and the view has no storage", async () => {
    const { db } = await sharedDb();
    const [rel] = await db.admin<{ relkind: string }[]>`
      select relkind::text from pg_class
       where relname = 'document_open_quantity' and relnamespace = 'app'::regnamespace`;
    expect(rel!.relkind).toBe("v");            // 'v' = view; 'r' or 'm' would be a stored copy
  });

  it("a partial conversion moves the open quantity without touching the order line", async () => {
    const { db } = await sharedDb();
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType, series: "SO", effectiveDate: "2026-01-10", partyId, warehouseId,
      lines: [{ kind: "item", itemId, warehouseId, unitId, quantity: "10.000000", unitPrice: "5.0000", amount: "50.0000" }],
    });
    await withTenant(db.rw, ctx, (tx) => issueDocument(tx, ctx, { documentId: order.documentId }));

    // `quantity` alone, and the line's AUDIT rows — NOT `updated_at`. `app.document_line` has `created_at`
    // and no `updated_at` (§4.3.4's base DDL, contracts:2200-2217, and §4.6.1's universal-column rule),
    // so selecting one is a 42703 and the case would fail for the wrong reason. `attach_audit` is on this
    // table (contracts:2221), so an UPDATE of any kind writes an `app.audit_log` row — which is a stronger
    // statement than a timestamp: it says nothing was written at all, not merely that a clock did not move.
    const lineId = order.lineIds[0]!;
    const ordered = () => withTenant(db.rw, ctx, (tx) => tx<{ quantity: string }[]>`
      select quantity::text from app.document_line where id = ${lineId}`);
    // `action` is lower case: plan0A:2269 declares `check (action in ('insert', 'update', 'delete'))`, and
    // `row_id` is `text` (plan0A:2268 — join tables have composite keys), so the uuid is compared as text.
    const audits = () => db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where table_name = 'document_line' and row_id = ${lineId}::text and action = 'update'`;

    const [beforeQty] = await ordered();
    const [beforeAudit] = await audits();

    await withTenant(db.rw, ctx, (tx) =>
      convertOrderToDelivery(tx, ctx, {
        sourceDocumentId: order.documentId, targetDocumentTypeId: doType, targetSeries: "DO",
        effectiveDate: "2026-01-12", warehouseId, fefo: false,
        lines: [{ sourceLineId: lineId, quantity: "4.000000" }],
      }));

    const [afterQty] = await ordered();
    const [afterAudit] = await audits();
    expect(afterQty!.quantity).toBe(beforeQty!.quantity);     // still 10.000000
    expect(afterAudit!.n).toBe(beforeAudit!.n);               // and not one UPDATE was written
    const [open] = await withTenant(db.rw, ctx, (tx) => tx<{ open_quantity: string }[]>`
      select open_quantity::text from app.document_open_quantity where document_line_id = ${lineId}`);
    expect(open!.open_quantity).toBe("6.000000");             // the remaining 6 is arithmetic, not a column
  });
});
```

Then `tests/regression/sah-048.test.ts`. 3A created it (negative-stock controls that were per-user, opt-in and bypassable four ways); this slice appends the "on a real sale" block and edits none of 3A's three cases. Both cases below are pure reads of the catalogue and the function source, so the block needs no tenant of its own:

```ts
describe("SAH-048 Negative stock rejected by the data layer on a real sale — 3D", () => {
  it("the DELIVERY_ORDER policy's allowNegative alone admits nothing without the event", async () => {
    // The legacy control was a per-user flag: setting it was enough. Here the flag is on the TYPE and it is
    // necessary but not sufficient — the second condition is a document_event by a second principal, and
    // amendment A8b makes `cost()` require BOTH.
    const { db } = await sharedDb();
    const [policy] = await db.admin<{ allow: boolean }[]>`
      select (p.definition -> 'inventory' ->> 'allowNegative')::boolean as allow
        from app.posting_policy p join app.document_type t on t.id = p.document_type_id
       where t.code = 'DELIVERY_ORDER'`;
    expect(policy!.allow).toBe(true);
    // …and the data layer's own gate never reads that flag: `assert_stock_available` looks for a
    // `document_event`, full stop. So setting `allowNegative` on a type admits nothing on its own — which
    // is the precise shape of the legacy defect, where setting the user flag WAS the admission. The
    // assertion is on the function source rather than on a row count, because a row count over the shared
    // regression container depends on which other files have run.
    const [gate] = await db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc
       where proname = 'assert_stock_available' and pronamespace = 'app'::regnamespace`;
    expect(gate!.src).not.toMatch(/allowNegative|posting_policy/);
  });

  it("no session flag, GUC or user attribute can turn the check off", async () => {
    const { db } = await sharedDb();
    // The four legacy bypasses were: a user flag, a session variable, a direct table write and a second
    // write path. All four are closed: the check is a BEFORE INSERT trigger on the only table that holds a
    // movement, `app_rw` has no UPDATE or DELETE on it, and no GUC appears in the function body.
    const [fn] = await db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc
       where proname = 'assert_stock_available' and pronamespace = 'app'::regnamespace`;
    expect(fn!.src).not.toMatch(/current_setting|set_config/i);
    expect(fn!.src).toMatch(/document_event/);       // the ONE door, and it is an audited row
  });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test inventory/delivery-order && bun run --cwd packages/db seed --tenant "$TEST_TENANT" --only document-types && bun run --cwd packages/db test seed/document-types && bun run test tests/regression/sah-018.test.ts tests/regression/sah-048.test.ts`

The regression command is `bun run test <file>` from the repository root, which is the `@dulja/tests` workspace's own `test` script — `node ../node_modules/vitest/vitest.mjs run` (§3.7.1, contracts:1189), the form Task 11 Step 4 also uses. An earlier draft of this line read `bun run --cwd node --test tests/regression/sah-048.test.ts`, which passes `node` as the **working directory** and invokes Node's own test runner; `tests/` is a Vitest workspace and has neither.

Expected: PASS — six cases in the delivery-order suite, the three new `sah-018` cases and both new `sah-048` cases. The three tests 3A wrote in `sah-048` are untouched.

- [ ] **Step 6: Commit**

```bash
git add packages/db/seed/my/document-types/DELIVERY_ORDER.json \
        packages/db/test/inventory/delivery-order.test.ts \
        tests/regression/sah-018.test.ts tests/regression/sah-048.test.ts
git commit -m "feat(inventory): DELIVERY_ORDER posts stock out to 1250 [3D T6]

The type is configuration only - two legs at line.cost, debit 1250 credit the item's
inventory account, so no revenue is recognised at dispatch (F-19). allowNegative is true
and, with a second principal's override event, admits an authorised shortfall; the
uncovered quantity has no cost_consumption row. Test 18 re-run on a real sale.
tests/regression/sah-018.test.ts is created here (§3.7.3), once DELIVERY_ORDER.json
exists for its conversion case to seed the target type from the pack.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `TRANSFER` — the dispatch leg, the in-transit warehouse, and the DoD clause on `stock_on_hand`

The first half of the two-step transfer (spec:1053). A `TRANSFER` moves stock out of the source warehouse and into a warehouse whose `kind` is `in_transit`, debiting **`1310` goods in transit** and crediting the item's inventory account. This is where this slice's second definition-of-done clause becomes true and testable: *"goods in transit are in neither warehouse's on-hand and in the company's total"*.

**Files:**
- Create: `packages/db/seed/my/document-types/TRANSFER.json`
- Create: `packages/db/src/inventory/transfer.ts`
- Create: `packages/contracts/src/inventory/transfer.ts` (`TransferDraftBody`, `TransferDraftSchema`)
- Create: `docs/adr/0043-in-transit-warehouse-and-two-step-transfer.md`
- Create: `packages/db/test/inventory/transfer.test.ts`
- Modify: `packages/db/test/inventory/policies.ts` (append `TRANSFER_POLICY`)
- Modify: `packages/db/src/inventory/index.ts` (three exports), `packages/contracts/src/index.ts`
- Modify: `apps/api/src/routes/accounting/documents.ts` (one sub-path — `POST …/documents/transfers`), `apps/api/test/routes/accounting/document-fulfilment.test.ts`

**Interfaces:**
- Consumes: `postDocument`, `issueDocument` (§4.3.1); `applyMovements` with Task 4's transfer costing order (§4.7.2); `evaluatePolicy`'s two-quantity transfer and receipt-costing rules (Task 3); `app.warehouse` with `kind in ('stock','in_transit')` and `branch_id` (3A); `AppError` (§4.2.4); `Quantity` (§4.2.1); `TenantContext` (§4.2.2); `draftTypedDocument`, `seedWarehouse`, `seedBranch` (§4.17).
- Produces:

```ts
// packages/db/src/inventory/transfer.ts
export interface TransferInput {
  /** The dispatching warehouse. Every line ships from here. */
  fromWarehouseId: string;
  /** The FINAL destination — a `kind = 'stock'` warehouse at the receiving branch. NOT the in-transit one:
   *  the caller names where the goods are going and this service resolves the corridor they travel through. */
  toWarehouseId: string;
  effectiveDate: string;
  series: string;
  documentTypeId: string;
  lines: readonly { itemId: string; unitId: string; lotId?: string | null; quantity: string }[];
}
export interface TransferResult { documentId: string; lineIds: string[]; inTransitWarehouseId: string }

/** The in-transit warehouse a dispatch to `toWarehouseId` travels through: the `kind = 'in_transit'`
 *  warehouse whose `branch_id` equals the destination's branch. One per receiving branch — see ADR 0043 for
 *  why per-branch and not per-pair. Raises `ERR_VALIDATION_FAILED` naming the branch when none is configured,
 *  because silently posting into the destination would make the DoD clause false and nothing would notice. */
export async function resolveInTransitWarehouse(tx: Sql, toWarehouseId: string): Promise<string>;

/** Drafts a TRANSFER whose header `to_warehouse_id` is the resolved in-transit warehouse and whose lines each
 *  carry `warehouse_id = fromWarehouseId`. Writes `document` and `document_line` only; the caller issues and
 *  posts. `document.custom_fields.final_warehouse_id` records the ultimate destination so Task 8's receipt
 *  knows where to put the goods without a second table (§4.2.11 — the custom-field bag is core's extension
 *  point, and one uuid does not earn a column). */
export async function draftTransfer(tx: Sql, ctx: TenantContext, input: TransferInput): Promise<TransferResult>;
```

**The header carries the destination, not the line — and that is a decision, not an omission.** §4.4.1's `inventory.to_warehouse` admits `"line.to_warehouse"`, but **`app.document_line` has no `to_warehouse_id` column and this slice does not add one.** 3A settled this explicitly (its assumption 3): the 3A row of §4.3.4 adds four line columns and not that one, `LineSnapshot.toWarehouseId` is filled as a constant `null`, and `planMovements` resolves `"line.to_warehouse"` to `line.toWarehouseId ?? header.toWarehouseId` — always the header's. 3A left the column to 3D "if it needs one". **It does not.** A dispatch note travels to one place: one lorry, one destination, one document. A transfer to two branches is two `TRANSFER` documents, which is also how the receiving branches acknowledge them independently. So `TRANSFER.json` declares `to_warehouse: "header.to_warehouse"`, migration 0043 stays unused as the Assumptions block promised, and `document_line` keeps the shape 3A froze.

- [ ] **Step 1: Append `TRANSFER_POLICY` to `packages/db/test/inventory/policies.ts`**

```ts
/** §4.14 `TRANSFER` — the dispatch leg. `effect: "transfer"` emits TWO movements per line (issue at
 *  `warehouse`, receipt at `to_warehouse`), and Task 3's rule gives the receipt leg `create_layer` however
 *  this `costing` reads: a transfer policy's `costing` describes the SOURCE leg. `1310` is 3C's account. */
export const TRANSFER_POLICY = {
  version: 1, documentType: "TRANSFER", direction: "internal", requires: ["warehouse", "to_warehouse"],
  lines: [
    { for: "each_line", side: "debit",  account: { code: "1310" },                  amount: "line.cost", when: { "line.kind": "item" } },
    { for: "each_line", side: "credit", account: { from: "item.inventory_account" }, amount: "line.cost", when: { "line.kind": "item" } },
  ],
  inventory: {
    effect: "transfer", warehouse: "line.warehouse", to_warehouse: "header.to_warehouse",
    costing: "consume_layers", allowNegative: false,
  },
  tax: { applies: false },
  numbering: { series: "TRF", assignAt: "issue" },
  reversal: { allowed: true, producesType: "TRANSFER" },
  approval: { required: false, approve: null, post: "inventory.transfer.post", create: "inventory.transfer.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;
```

- [ ] **Step 2: Write the failing test**

`packages/db/test/inventory/transfer.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument, issueDocument } from "../../src/posting";
import { draftTransfer, resolveInTransitWarehouse } from "../../src/inventory/transfer";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument, grantCodes, seedAccount, seedBranch, seedDocumentType, seedItem, seedLot,
  seedParty, seedTenantV2, seedUnit, seedWarehouse, type Seed,
} from "../fixtures";
import { ctxOf, GRN_POLICY, TRANSFER_POLICY } from "./policies";

describe("TRANSFER — dispatch into an in-transit warehouse (spec:1053; the DoD clause)", () => {
  let db: Db;
  let s: Seed;
  let trfType: string; let grnType: string;
  let itemId: string; let unitId: string; let partyId: string;
  let whHq: string; let whBranch: string; let whTransit: string; let branchB: string;
  let acc1300: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-trf");
    await grantCodes(db, s);
    acc1300 = await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, s, { code: "1310", nameEn: "Goods in transit", type: "asset" });
    await seedAccount(db, s, { code: "2150", nameEn: "Goods received not invoiced", type: "liability" });
    trfType = await seedDocumentType(db, s, { code: "TRANSFER", module: "inventory", policy: TRANSFER_POLICY });
    grnType = await seedDocumentType(db, s, { code: "GOODS_RECEIPT", module: "inventory", policy: GRN_POLICY });
    partyId = await seedParty(db, s, { code: "SUP-1", kind: "supplier" });
    // Two branches: s.hq (Plan 0A's BRANCH value) and a second from 0D's seedBranch.
    branchB = await seedBranch(db, s, { code: "BR-2", nameEn: "Branch 2" });
    whHq     = await seedWarehouse(db, s, { code: "WH-HQ",      kind: "stock",      branchId: s.hq });
    whBranch = await seedWarehouse(db, s, { code: "WH-BR2",     kind: "stock",      branchId: branchB });
    whTransit = await seedWarehouse(db, s, { code: "WH-BR2-TR", kind: "in_transit", branchId: branchB });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, { code: "SKU-TRF", trackLots: false, baseUnitId: unitId,
                                          accounts: { inventoryAccountId: acc1300 } }));
    // 12 units at 5.0000 into WH-HQ.
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: grnType, series: "GRN", effectiveDate: "2026-01-05", partyId, warehouseId: whHq,
      lines: [{ kind: "item", itemId, warehouseId: whHq, unitId, quantity: "12.000000", unitPrice: "5.0000", amount: "60.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
  }, 180_000);
  afterAll(async () => { await db?.stop(); });

  async function dispatch(qty: string, effectiveDate: string) {
    return withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const drafted = await draftTransfer(tx, ctxOf(s), {
        fromWarehouseId: whHq, toWarehouseId: whBranch, effectiveDate,
        series: "TRF", documentTypeId: trfType,
        lines: [{ itemId, unitId, quantity: qty }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: drafted.documentId });
      return { ...drafted, result: await postDocument(tx, ctxOf(s), { documentId: drafted.documentId }) };
    });
  }

  it("resolveInTransitWarehouse finds the in_transit warehouse of the DESTINATION's branch", async () => {
    const resolved = await withTenant(db.rw, s.tenant, s.human, (tx) => resolveInTransitWarehouse(tx, whBranch));
    expect(resolved).toBe(whTransit);
  });

  it("a destination branch with no in_transit warehouse is refused, naming the branch", async () => {
    const branchC = await seedBranch(db, s, { code: "BR-3", nameEn: "Branch 3" });
    const whC = await seedWarehouse(db, s, { code: "WH-BR3", kind: "stock", branchId: branchC });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => resolveInTransitWarehouse(tx, whC)))
      .rejects.toThrow(/ERR_VALIDATION_FAILED: branch .* has no in_transit warehouse/);
  });

  it("emits TWO movements for one line — an issue at the source and a receipt in transit", async () => {
    const { documentId } = await dispatch("5.000000", "2026-01-10");
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { movement_no: number; warehouse_id: string; quantity: string; value: string }[]
    >`select movement_no, warehouse_id, quantity::text, value::text
        from app.inventory_movement where document_id = ${documentId} order by movement_no`);
    expect(rows).toEqual([
      { movement_no: 1, warehouse_id: whHq,      quantity: "-5.000000", value: "-25.0000" },
      { movement_no: 2, warehouse_id: whTransit, quantity: "5.000000",  value: "25.0000" },
    ]);
  });

  it("THE DoD CLAUSE — in transit is in neither warehouse's on-hand and in the company's total", async () => {
    // Opening: 12 at HQ. One dispatch has run above and moved 5. So HQ 7, transit 5, company total 12 —
    // and WH-BR2 has NO ROW AT ALL, which is a stronger statement of "the destination is unchanged" than a
    // zero would be. `app.stock_on_hand` rows exist only where the step-12 MERGE inserted one, and its
    // source is `select … from app.inventory_movement where document_id = $3` with `when not matched then
    // insert` (§4.7.3): a warehouse no movement has touched is absent from the projection, so a
    // `{ code: "WH-BR2", quantity: "0.000000" }` expectation would fail on the join, not on the arithmetic.
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; kind: string; quantity: string }[]
    >`select w.code, w.kind, sum(h.quantity)::text as quantity
        from app.stock_on_hand h join app.warehouse w on w.id = h.warehouse_id
       where h.item_id = ${itemId} group by w.code, w.kind order by w.code`);
    expect(rows).toEqual([
      { code: "WH-BR2-TR", kind: "in_transit", quantity: "5.000000" },   // held here
      { code: "WH-HQ",     kind: "stock",      quantity: "7.000000" },   // source decremented
    ]);
    expect(rows.some((r) => r.code === "WH-BR2")).toBe(false);           // destination UNCHANGED — no row
    // …and the company total is unchanged by the move.
    const [total] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ q: string }[]>`
      select sum(quantity)::text as q from app.stock_on_hand where item_id = ${itemId}`);
    expect(total!.q).toBe("12.000000");
  });

  it("1310 carries the value of the goods in transit, to the cent", async () => {
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ debit: string; credit: string }[]>`
      select coalesce(sum(e.debit), 0)::text as debit, coalesce(sum(e.credit), 0)::text as credit
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where a.code = '1310' and e.company_id = ${s.company}`);
    // 5 units at the AVCO unit cost 5.0000. Debit only: nothing has been received yet.
    expect(row!.debit).toBe("25.0000");
    expect(row!.credit).toBe("0.0000");
  });

  it("both ledger legs are the same magnitude and `side` carries the direction (A9)", async () => {
    const { documentId } = await dispatch("2.000000", "2026-01-11");
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; debit: string; credit: string }[]
    >`select a.code, e.debit::text, e.credit::text
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${documentId} order by a.code`);
    expect(rows).toEqual([
      { code: "1300", debit: "0.0000",  credit: "10.0000" },
      { code: "1310", debit: "10.0000", credit: "0.0000" },
    ]);
    // Neither figure is ever negative — the ledger_entry CHECKs would refuse it (§4.4.2 A9). Tested on the
    // `::text` form, not through `Number()`: no monetary value in this plan passes through a float.
    for (const r of rows) {
      expect(r.debit.startsWith("-")).toBe(false);
      expect(r.credit.startsWith("-")).toBe(false);
    }
  });

  it("the destination layer is created at the source's unit cost, not re-derived", async () => {
    const layers = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; qty_in: string; unit_cost: string }[]
    >`select w.code, l.qty_in::text, l.unit_cost::text
        from app.cost_layer l join app.warehouse w on w.id = l.warehouse_id
       where l.item_id = ${itemId} and w.kind = 'in_transit' order by l.sequence`);
    expect(layers.map((l) => l.unit_cost)).toEqual(["5.0000", "5.0000"]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run --cwd packages/db test inventory/transfer`
Expected: FAIL — `Cannot find module '../../src/inventory/transfer'`, so every case errors in `beforeAll`.

- [ ] **Step 4: Write `packages/db/src/inventory/transfer.ts`**

```ts
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";
import type { TenantContext } from "../with-tenant";

export interface TransferInput {
  fromWarehouseId: string;
  toWarehouseId: string;
  effectiveDate: string;
  series: string;
  documentTypeId: string;
  lines: readonly { itemId: string; unitId: string; lotId?: string | null; quantity: string }[];
}
export interface TransferResult { documentId: string; lineIds: string[]; inTransitWarehouseId: string }

/**
 * The corridor a dispatch travels through. ONE in-transit warehouse per receiving branch (ADR 0043): the
 * question a branch manager asks is "what is on its way to me", and the answer must not be spread over one
 * row per sending branch.
 *
 * A missing in-transit warehouse RAISES rather than falling back to the destination. Falling back would post
 * the goods straight into the receiving warehouse, which is arithmetically fine and makes the definition-of-
 * done clause quietly false — the destination's on-hand would rise before anyone received anything.
 */
export async function resolveInTransitWarehouse(tx: Sql, toWarehouseId: string): Promise<string> {
  const [dest] = await tx<{ id: string; branch_id: string; kind: string; code: string }[]>`
    select id, branch_id, kind, code from app.warehouse where id = ${toWarehouseId} and archived_at is null`;
  if (dest === undefined) {
    throw new AppError("ERR_NOT_FOUND", `warehouse ${toWarehouseId} is not visible`);
  }
  if (dest.kind !== "stock") {
    throw new AppError(
      "ERR_VALIDATION_FAILED",
      `warehouse ${dest.code} is ${dest.kind}; a transfer destination must be a stock warehouse`,
    );
  }
  const [transit] = await tx<{ id: string }[]>`
    select id from app.warehouse
     where branch_id = ${dest.branch_id} and kind = 'in_transit' and archived_at is null
     order by code
     limit 1`;
  if (transit === undefined) {
    throw new AppError(
      "ERR_VALIDATION_FAILED",
      `branch ${dest.branch_id} has no in_transit warehouse; configure one before transferring to ${dest.code}`,
    );
  }
  return transit.id;
}

/**
 * Drafts the dispatch. Runs inside the caller's transaction and writes `document` + `document_line` only.
 *
 * `document.to_warehouse_id` is the IN-TRANSIT warehouse, because that is what the policy's
 * `to_warehouse: "header.to_warehouse"` resolves to and therefore where the receipt movement lands. The
 * ultimate destination goes into `custom_fields.final_warehouse_id`: Task 8's receipt reads it to know where
 * the goods finally belong, and one uuid does not earn a column (§4.2.11).
 *
 * `document_line.lot_id` may be null — `applyMovements` resolves the item's `NONE` sentinel (SAH-050). A
 * lot-tracked item's caller passes the lot it physically loaded; FEFO is a picking decision that belongs to
 * whatever drafts the line, exactly as it does for a delivery.
 */
export async function draftTransfer(
  tx: Sql, ctx: TenantContext, input: TransferInput,
): Promise<TransferResult> {
  const inTransitWarehouseId = await resolveInTransitWarehouse(tx, input.toWarehouseId);
  const [from] = await tx<{ company_id: string; branch_id: string; kind: string; code: string }[]>`
    select company_id, branch_id, kind, code from app.warehouse
     where id = ${input.fromWarehouseId} and archived_at is null`;
  if (from === undefined) {
    throw new AppError("ERR_NOT_FOUND", `warehouse ${input.fromWarehouseId} is not visible`);
  }
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new AppError("ERR_VALIDATION_FAILED", `a transfer's source and destination are the same warehouse (${from.code})`);
  }

  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       warehouse_id, to_warehouse_id, branch_id, custom_fields)
    select ${ctx.tenantId}, ${from.company_id}, ${input.documentTypeId}, ${input.series},
           ${input.effectiveDate}, c.base_currency, '1.00000000',
           ${input.fromWarehouseId}, ${inTransitWarehouseId}, ${from.branch_id},
           ${tx.json({ final_warehouse_id: input.toWarehouseId })}
      from app.company c where c.id = ${from.company_id}
    returning id`;
  const documentId = doc!.id;

  const lineIds: string[] = [];
  for (let i = 0; i < input.lines.length; i += 1) {
    const l = input.lines[i]!;
    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id, unit_id, quantity, amount)
      values (${ctx.tenantId}, ${from.company_id}, ${documentId}, ${i + 1}, 'item', ${l.itemId},
              ${input.fromWarehouseId}, ${l.lotId ?? null}, ${l.unitId}, ${l.quantity}, 0)
      returning id`;
    lineIds.push(row!.id);
  }
  return { documentId, lineIds, inTransitWarehouseId };
}
```

Append to `packages/db/src/inventory/index.ts`:

```ts
export { draftTransfer, resolveInTransitWarehouse } from "./transfer";
export type { TransferInput, TransferResult } from "./transfer";
```

- [ ] **Step 5: Write `packages/db/seed/my/document-types/TRANSFER.json`**

```json
{
  "code": "TRANSFER",
  "nameEn": "Stock Transfer (dispatch)",
  "nameAr": "تحويل مخزون (إرسال)",
  "module": "inventory",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "TRANSFER",
    "direction": "internal",
    "requires": ["warehouse", "to_warehouse"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "code": "1310" },                  "amount": "line.cost", "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "credit", "account": { "from": "item.inventory_account" }, "amount": "line.cost", "when": { "line.kind": "item" } }
    ],
    "inventory": {
      "effect": "transfer",
      "warehouse": "line.warehouse",
      "to_warehouse": "header.to_warehouse",
      "costing": "consume_layers",
      "allowNegative": false
    },
    "tax": { "applies": false },
    "numbering": { "series": "TRF", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "TRANSFER" },
    "approval": { "required": false, "approve": null, "post": "inventory.transfer.post", "create": "inventory.transfer.create" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

`allowNegative: false`: a branch cannot dispatch stock it does not have, and there is no business case for an authorised negative transfer — the honest document for stock that has vanished is a `STOCK_COUNT` or an `EXPIRY_WRITE_OFF`. `1310` is **3C's** account (§4.15) and this file names it without re-seeding it; Task 2's hazard-33 assertion is what proves it resolves.

- [ ] **Step 6: Write ADR 0043**

`docs/adr/0043-in-transit-warehouse-and-two-step-transfer.md`:

```markdown
# ADR 0043 — In-transit warehouse resolution and the two-step transfer protocol

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 3D

## Context

spec:1053 requires a two-step inter-branch transfer: "dispatched into an in-transit warehouse, received at the
branch, variance on receipt", and the Phase 3 definition of done requires that goods in transit be "in neither
warehouse's on-hand and in the company's total". Three things had to be decided and none is in the spec: how
many in-transit warehouses exist and what they are keyed by; where the ultimate destination is recorded
between dispatch and receipt; and whether `document_line` gains a `to_warehouse_id` column.

## Decision

**1. One `kind = 'in_transit'` warehouse per receiving branch**, resolved by
`resolveInTransitWarehouse(tx, toWarehouseId)` as "the in-transit warehouse whose `branch_id` is the
destination's branch". Not one per (source, destination) pair, and not one per company. The question a branch
manager asks daily is *"what is on its way to me"*, and the answer must be one warehouse's on-hand rather than
a sum over one row per sending branch. A company-wide corridor would answer that question wrongly for
everyone. `app.warehouse` already carries `kind` and `branch_id` (3A), so this needs no table and no column.

**2. A missing in-transit warehouse raises `ERR_VALIDATION_FAILED` naming the branch**, and never falls back
to the destination warehouse. The fallback is arithmetically harmless and makes the definition-of-done clause
silently false: the destination's on-hand would rise at dispatch. A configuration gap must be loud.

**3. `document.to_warehouse_id` is the in-transit warehouse; the final destination lives in
`document.custom_fields.final_warehouse_id`.** The policy's `to_warehouse: "header.to_warehouse"` is what the
receipt movement resolves from, so the header column must hold the corridor. The destination is read once, by
the receipt drafting service, and one uuid does not earn a column (§4.2.11 makes the custom-field bag core's
extension point for exactly this).

**4. `document_line` gains no `to_warehouse_id` column.** 3A's assumption 3 left the column to this slice "if
it needs one". It does not: a dispatch note travels to one place, so one destination per document is the
honest shape, and a transfer to two branches is two documents — which is also how two receiving branches
acknowledge independently. Migration 0043, allocated to this slice, stays unused (§3.4.1).

**5. The receipt leg's quantity may differ from the dispatch leg's.** `TRANSFER_RECEIPT` carries
`expected_quantity` (what was dispatched) and `counted_quantity` (what arrived) on each line; Task 3's
evaluator rule gives the issue movement the expected quantity and the receipt movement the counted one, and
the difference posts to `5110`. This is the only in-schema place spec:1053's "variance on receipt" can live,
because `inventory.effect` is one value per policy. ADR 0042 records that rule; this ADR records that the
two-step protocol is what needs it.

## Consequences

- A tenant must configure one in-transit warehouse per branch before transferring to it. That is a seed-pack
  and onboarding fact, not a code fact, and the error message says exactly what to create.
- Goods in transit are visible: `1310` carries their value and the in-transit warehouse carries their
  quantity, both queryable per branch. The legacy system had `MunIsTrans` as a boolean on a warehouse row and
  no ledger account at all.
- A dispatch that is never received leaves stock in transit indefinitely and visibly. Ageing that balance is
  7B's `inventory.transfer_register` report, not a job that guesses.
- `stock_on_hand` needs no change: the in-transit warehouse is a warehouse, so the projection's own MERGE
  handles it, and every report that wants "real" stock filters on `warehouse.kind = 'stock'` (Task 10).
```

- [ ] **Step 7: Add the wire contract and the `documents/transfers` sub-path**

`draftTransfer` needs an endpoint for the same reason `convertOrderToDelivery` does: Global Constraint 2 requires a Zod schema, an OpenAPI entry, idempotency on the unsafe method and tenant-isolation coverage for **every new endpoint**, the card's delivery bullet is "a two-step transfer … under `inventory.transfer.create/.post`", and Task 13's `transfer-api.ts` calls this exact path. Without it the two-step transfer has a DB service and no way to reach it.

`packages/contracts/src/inventory/transfer.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, QuantitySchema, UuidSchema } from "../common";

/** The dispatch. `toWarehouseId` is the FINAL destination — a `kind = 'stock'` warehouse at the receiving
 *  branch — and the corridor is resolved server-side by `resolveInTransitWarehouse` (ADR 0043). A client
 *  never names an in-transit warehouse, which is what stops a caller posting straight into the destination
 *  and making the definition-of-done clause quietly false. */
export const TransferDraftBody = z.object({
  documentTypeCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  series: z.string().regex(/^[A-Z0-9-]{1,16}$/),
  effectiveDate: DateSchema,
  fromWarehouseId: UuidSchema,
  toWarehouseId: UuidSchema,
  lines: z.array(z.object({
    itemId: UuidSchema, unitId: UuidSchema, lotId: UuidSchema.nullable().optional(),
    quantity: QuantitySchema,
  })).min(1),
}).strict().openapi("TransferDraftBody");

/** The response of both transfer sub-paths — the dispatch here and the receipt at Task 8. Both drafting
 *  services return a document, its line ids and the warehouse the caller could not have known:
 *  `inTransitWarehouseId` on dispatch, `finalWarehouseId` on receipt. One schema with both members
 *  nullable keeps `transfer-api.ts` to one parser. */
export const TransferDraftSchema = z.object({
  documentId: UuidSchema,
  lineIds: z.array(UuidSchema),
  inTransitWarehouseId: UuidSchema.nullable(),
  finalWarehouseId: UuidSchema.nullable(),
}).openapi("TransferDraft");
```

Add `export * from "./inventory/transfer";` to `packages/contracts/src/index.ts`.

In `apps/api/src/routes/accounting/documents.ts`, beside Task 5's `convert`:

```ts
const transferRoute = createRoute({
  method: "post",
  path: "/transfers",
  tags: ["accounting"],
  summary: "Draft a stock transfer (dispatch) into the receiving branch's in-transit warehouse",
  // §4.5.4's `create` stage: no `:documentId` exists yet, so the middleware resolves the policy of the type
  // named in the BODY — TRANSFER's `approval.create` (inventory.transfer.create).
  middleware: [requireDocumentPermission("create")] as const,
  request: {
    params: z.object({ companyId: z.string().uuid() }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: TransferDraftBody } } },
  },
  responses: {
    201: { description: "The drafted transfer", content: { "application/json": { schema: TransferDraftSchema } } },
    400: { description: "Same source and destination, or a non-stock destination, or no in-transit warehouse for the destination's branch", content: { "application/problem+json": { schema: ProblemSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "Warehouse or document type not found", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

documentRoutes.openapi(transferRoute, async (c) => {
  const body = c.req.valid("json");
  const result = await c.var.withTenant(async (tx) => {
    const [type] = await tx<{ id: string }[]>`
      select id from app.document_type where code = ${body.documentTypeCode} and archived_at is null`;
    if (type === undefined) {
      throw new AppError("ERR_NOT_FOUND", `document type ${body.documentTypeCode} is not configured`);
    }
    const drafted = await draftTransfer(tx, c.var.ctx, {
      documentTypeId: type.id, series: body.series, effectiveDate: body.effectiveDate,
      fromWarehouseId: body.fromWarehouseId, toWarehouseId: body.toWarehouseId,
      lines: body.lines.map((l) => ({ itemId: l.itemId, unitId: l.unitId, lotId: l.lotId ?? null, quantity: l.quantity })),
    });
    return { ...drafted, finalWarehouseId: null };
  });
  return c.json(result, 201);
});
```

The route **drafts only** — it does not issue and does not post, exactly as `draftTransfer` does not; the caller transitions the draft through 2B's existing `POST …/documents/{id}/transitions`, whose R2 asks the policy's `approval.post` (`inventory.transfer.post`). That is why `inventory.transfer.create` and `.post` are two codes and why this route names only the first. **No `PROBES` entry and no new `RouteModule`**: `/v1/companies/:companyId/documents` is already registered and probed (§4.2.7, hazard 31), so tenant-isolation coverage (test 12) picks this sub-path up for free.

Add to `apps/api/test/routes/accounting/document-fulfilment.test.ts` — the file Task 5 created, rather than a second API file for one route — this block. Its `beforeAll` adds to Task 5's the two branches, the three warehouses and the `TRANSFER` type, in the shape Task 7 Step 2's DB-tier `beforeAll` builds them:

```ts
describe("POST …/documents/transfers (3D T7)", () => {
  it("201s, and the corridor in the response is the DESTINATION branch's in-transit warehouse", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human, idempotencyKey: "trf-201",
      body: {
        documentTypeCode: "TRANSFER", series: "TRF", effectiveDate: "2026-01-10",
        fromWarehouseId: whHq, toWarehouseId: whBranch,
        lines: [{ itemId, unitId, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(201);
    const body = TransferDraftSchema.parse(await res.json());
    // The client named the FINAL destination; the server resolved the corridor. A response echoing
    // `whBranch` here would mean the goods were about to post straight into the destination, which is the
    // definition-of-done clause failing silently (ADR 0043's decision 2).
    expect(body.inTransitWarehouseId).toBe(whTransit);
    expect(body.lineIds).toHaveLength(1);
  });

  it("400s a request with no Idempotency-Key (spec:2055, §4.2.9)", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human, idempotencyKey: null,
      body: {
        documentTypeCode: "TRANSFER", series: "TRF", effectiveDate: "2026-01-10",
        fromWarehouseId: whHq, toWarehouseId: whBranch,
        lines: [{ itemId, unitId, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_REQUIRED");
  });

  it("403s a principal who does not hold inventory.transfer.create", async () => {
    const salesOnly = await grantCodes(db, s, {
      codes: ["accounting.sales.create"], principalId: await secondPrincipal(db, s, "trf-sales"),
      roleCode: "trf-sales-only",
    });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/transfers`,
      as: salesOnly.principalId, idempotencyKey: "trf-403",
      body: {
        documentTypeCode: "TRANSFER", series: "TRF", effectiveDate: "2026-01-10",
        fromWarehouseId: whHq, toWarehouseId: whBranch,
        lines: [{ itemId, unitId, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("400s a destination branch with no in-transit warehouse, naming the branch", async () => {
    const branchC = await seedBranch(db, s, { code: "BR-3", nameEn: "Branch 3" });
    const whC = await seedWarehouse(db, s, { code: "WH-BR3", kind: "stock", branchId: branchC });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human, idempotencyKey: "trf-no-corridor",
      body: {
        documentTypeCode: "TRANSFER", series: "TRF", effectiveDate: "2026-01-10",
        fromWarehouseId: whHq, toWarehouseId: whC,
        lines: [{ itemId, unitId, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    // The message is `resolveInTransitWarehouse`'s own, reaching the wire through `AppError` unchanged —
    // a configuration gap must be loud and must say what to create (ADR 0043's decision 2).
    expect(problem.detail).toMatch(/has no in_transit warehouse; configure one before transferring to WH-BR3/);
  });
});
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test inventory/transfer && bun run --cwd apps/api test document-fulfilment && bun run --cwd packages/db test costing && bun run --cwd packages/db seed --tenant "$TEST_TENANT" --only document-types`
Expected: PASS — seven cases in the DB-tier transfer suite, four more in the API file, plus 3A's and 3B's costing suites unchanged. **If the two movements come back with equal quantities but the destination layer's `unit_cost` is `0.0000`**, Task 4's transfer costing order did not land: the receipt leg's `value` must be set from the issue leg's consumed value *before* the layer is created.

- [ ] **Step 9: Commit**

```bash
git add packages/db/seed/my/document-types/TRANSFER.json \
        packages/db/src/inventory/transfer.ts packages/db/src/inventory/index.ts \
        packages/contracts/src/inventory/transfer.ts packages/contracts/src/index.ts \
        apps/api/src/routes/accounting/documents.ts \
        apps/api/test/routes/accounting/document-fulfilment.test.ts \
        packages/db/test/inventory/policies.ts packages/db/test/inventory/transfer.test.ts \
        docs/adr/0043-in-transit-warehouse-and-two-step-transfer.md
git commit -m "feat(inventory): TRANSFER dispatches into an in-transit warehouse [3D T7]

One in_transit warehouse per receiving branch, resolved from the destination's branch and
raising when absent (ADR 0043). The DoD clause is green: the source is decremented, the
destination is unchanged, the quantity is held against the in-transit warehouse and the
company total is unmoved; 1310 carries the value. No document_line.to_warehouse_id column.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `TRANSFER_RECEIPT` and `STOCK_COUNT` — the two variance types, tests 31 and 15

The two types whose lines carry Task 1's count columns, and therefore the two that make Task 3's evaluator rules do real work. `TRANSFER_RECEIPT` closes the corridor Task 7 opened and posts any shortfall to `5110`; `STOCK_COUNT` posts **only the variance** — this slice's other definition-of-done clause — under a genuine maker-checker (spec:2026). Acceptance test **31** is re-run on `STOCK_COUNT` through all three paths, and acceptance test **15** is re-run in the inventory domain with the test-only type `COUNT_TEST`.

**Files:**
- Create: `packages/db/seed/my/document-types/TRANSFER_RECEIPT.json`
- Create: `packages/db/seed/my/document-types/STOCK_COUNT.json`
- Create: `packages/db/src/inventory/count.ts`
- Create: `packages/contracts/src/inventory/count.ts`
- Create: `packages/db/test/inventory/transfer-receipt.test.ts`
- Create: `packages/db/test/inventory/stock-count.test.ts`
- Create: `docs/runbooks/stock-count.md`
- Modify: `packages/db/src/inventory/transfer.ts` (`draftTransferReceipt`)
- Modify: `packages/db/src/inventory/index.ts`, `packages/db/test/inventory/policies.ts` (append `STOCK_COUNT_POLICY`; `TRANSFER_RECEIPT_POLICY` landed at Task 4)
- Modify: `apps/api/src/routes/accounting/documents.ts` (**four** sub-paths — the three count routes and `POST …/{documentId}/receipt`), `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/inventory/transfer.ts` (Task 7's file — append `TransferReceiptBody`)
- Create: `apps/api/test/routes/accounting/document-count.test.ts`

**Interfaces:**
- Consumes: `postDocument`, `issueDocument`, `reverseDocument`, `transitionDocument` (§4.3.1, 1A/2B); `applyMovements` with Task 4's fill rules (§4.7.2); Task 3's five evaluator behaviours; `app.stock_on_hand` (§4.7.3); `app.document_status_before()` R1/R2 (§4.5.1); `secondPrincipal` (§4.17.1); `grantCodes` (§4.17, 2B); `requireDocumentPermission("create")` (§4.5.4); `MODULE_READ_CODE` (§4.5.8, 2C); `pdfText` (§4.17.1, 2C — test 15's print clause); `draftTypedDocument`, `seedDocumentType`, `seedItem`, `seedLot`, `seedWarehouse`, `seedUnit` (§4.17); `renderTemplate` / the print route (2C).
- Produces:

```ts
// packages/db/src/inventory/count.ts
export interface CountSheetLine {
  documentLineId: string; lineNo: number;
  itemId: string; itemCode: string; warehouseId: string; lotId: string; lotCode: string;
  expectedQuantity: string;                 // the stock_on_hand snapshot at sheet time
  countedQuantity: string | null;           // null until a counter enters a figure
  variance: string | null;                  // document_line.quantity — null while counted is null
}
export interface SnapshotCountSheetInput {
  documentTypeId: string; series: string; effectiveDate: string;
  warehouseId: string;
  /** Restrict the sheet to these items. Empty means every item with a `stock_on_hand` row in the warehouse —
   *  a full count. A cycle count passes a subset (spec:1052 names both). */
  itemIds?: readonly string[];
  /** Include keys whose projected quantity is zero. Default false: a full sheet of a large warehouse would
   *  otherwise carry every item ever stocked there. A counter who finds stock on a zero key adds the line. */
  includeZero?: boolean;
}
/** Drafts a STOCK_COUNT and one line per (item, warehouse, lot) key from `app.stock_on_hand`, writing
 *  `expected_quantity` and leaving `counted_quantity` and `quantity` NULL. Nothing about the sheet is a
 *  count yet; `recordCounts` is what makes it one. Writes `document` and `document_line` only. */
export async function snapshotCountSheet(
  tx: Sql, ctx: TenantContext, input: SnapshotCountSheetInput,
): Promise<{ documentId: string; lines: CountSheetLine[] }>;

/** **The sole writer of `document_line.quantity` on a counted line.** Sets `counted_quantity` and
 *  `quantity = counted − expected` in ONE statement, so the variance can never disagree with its operands.
 *  Refuses unless the document is `draft` (`ERR_DOC_STATUS_ILLEGAL`) — a submitted sheet is evidence.
 *  A line not named here keeps its NULL counted quantity and plans nothing at all: `quantity_sign` is null,
 *  which matches neither `when` value, and Task 3's zero-drop removes its movement. */
export async function recordCounts(
  tx: Sql, ctx: TenantContext, input: { documentId: string; counts: readonly { documentLineId: string; countedQuantity: string }[] },
): Promise<CountSheetLine[]>;

/** Reads a sheet back in `line_no` order — the count screen's list and the runbook's printout. */
export async function readCountSheet(tx: Sql, documentId: string): Promise<CountSheetLine[]>;

// packages/db/src/inventory/transfer.ts (appended)
export interface TransferReceiptInput {
  /** The posted TRANSFER being received. Its `to_warehouse_id` is the corridor and its
   *  `custom_fields.final_warehouse_id` the destination — both read here, neither passed in. */
  transferDocumentId: string;
  documentTypeId: string; series: string; effectiveDate: string;
  /** What actually arrived, per dispatch line. A line omitted arrives in full. */
  received?: readonly { transferLineId: string; countedQuantity: string }[];
}
/** Drafts a TRANSFER_RECEIPT: one line per dispatch line, `warehouse_id` = the in-transit warehouse,
 *  `expected_quantity` = the dispatched quantity, `counted_quantity` = what arrived, and
 *  `quantity` = counted − expected (the signed variance, written in the same statement). Links the two
 *  documents through 3C's `linkFulfilment` with `linkKind: "receives_against"`. */
export async function draftTransferReceipt(
  tx: Sql, ctx: TenantContext, input: TransferReceiptInput,
): Promise<{ documentId: string; lineIds: string[]; finalWarehouseId: string }>;
```

**One writer for the variance, and why that matters more than it looks.** `document_line.quantity` on a counted line is `counted_quantity − expected_quantity` (Task 1's column comment says so and Task 3's evaluator depends on it). Nothing in the frozen surface enforces the arithmetic, and a CHECK constraint cannot: the triple is null-null-null on every other document type in the system, and a reversal carries a negated `quantity` with **no** count columns at all. So the enforcement is structural instead — **`recordCounts` and `draftTransferReceipt` are the only two functions that ever write `counted_quantity`, and each writes it in the same `update`/`insert` statement as `quantity`.** A count screen calls `recordCounts`; nothing else may set the column, and Task 14's self-review step greps `packages/db/src` to prove no third writer exists.

**The reversal interaction — and why `TRANSFER_RECEIPT` declares `reversal.allowed: false`.** 1A's `reverseDocument` builds the reversal's lines from the original's, negating the signed magnitudes it knows about (`amount`, `discount`, `tax_amount`, `total_incl_tax`, `quantity` — contracts §4.4.2's sign-normalisation section, contracts:2506) and it does **not** copy `counted_quantity` or `expected_quantity`: its insert list is frozen at 2A's six columns plus 3A's four plus 3C's `cost` (3c:219), and the count columns are not in it.

For **`STOCK_COUNT`** that is exactly right, and the reversal is sound. The line carries a negated `quantity` and two null count columns, so `quantitySignOf` reads the opposite sign — which swaps the ledger legs, because this policy's direction comes from `when: { "line.quantity_sign": … }` and not from a fixed `side` — and Task 3's behaviour 2 flips the single movement's `effect`. A reversed 3-unit shortfall is a 3-unit receipt debited to inventory and credited to `5110`. Nothing else is needed.

For **`TRANSFER_RECEIPT` it is not right, and no amount of test-writing makes it so.** On a variance line `quantity` is the *variance*, not the quantity moved: negating −3 gives `+3`, `transferQuantities` falls back to `{ issue: 3, receipt: 3 }`, `orientMovement` leaves a positive quantity alone, and the "reversal" therefore **issues 3 more units out of the corridor and receives 3 more into the branch** — a forward move of the variance, in the same direction as the document it claims to reverse. By then the corridor holds nothing, so `assert_stock_available` raises `ERR_STOCK_INSUFFICIENT` (the policy sets `allowNegative: false` and no override event exists) and the failure is at least loud; a corridor that happened to hold stock would post silent nonsense. **A `Σdebit = Σcredit` assertion would have passed on either outcome**, which is why this plan asserts movement warehouses and quantities instead.

So the policy refuses the reversal at the front door: `reverseDocument` raises `ERR_DOC_STATUS_ILLEGAL` — *"policy for TRANSFER_RECEIPT does not allow reversal"* (1A's own guard, `!definition.reversal.allowed || producesType === null`). **This needs no register amendment:** §4.14's `TRANSFER_RECEIPT` row (contracts:3498) records module, direction, effect, gate, series and a one-line note, and no §4.14 row has ever recorded `reversal` — the policy file is the only place that value lives. `SALES_ORDER` already ships `reversal: { allowed: false, producesType: null }` in this same slice, so the shape is not new either. **A mis-counted receipt is corrected by a `STOCK_COUNT` at the receiving branch**, which is the type spec:1052 provides for exactly this — stock that is not where the books say — and which posts the surplus or shortfall it finds against the same `5110`, so the net `5110` balance is correct after both documents even though neither references the other. The correction is *net* correct through two independent postings; it is not a reversal, and the link between them is by date and warehouse rather than by a `document_link` row. It cannot be corrected by a second `TRANSFER_RECEIPT`: the first receipt's issue leg already took the *whole* dispatched quantity out of the corridor (Task 4's second case asserts that: transit goes 100 → 90 on a receive of 8 against 10), so a second receipt would issue against an empty corridor. The transfer's residual `document_open_quantity` of 3 is a link artefact recording what never arrived, not stock awaiting receipt. Nothing is deleted on either route, so Global Constraint 10 holds.

**What would have to change before any variance-shaped type may declare `reversal.allowed: true`** — recorded here so a later slice does not re-open this as a 3D bug. Two amendments, both outside this slice: (1) `reverseDocument`'s frozen line copy must gain `counted_quantity` and `expected_quantity`, **negated as a pair**, so `transferQuantities` reproduces the two legs it must undo (a §4.3.1/§4.4.2 amendment, 1A's and 2A's); and (2) §4.7.2's fill rules must stop keying on the movement's `effect` name, because negating the pair flips both legs and `fill: "cost"` would then read the corridor leg instead of the destination leg. One without the other produces a balanced document with the wrong figures on `1310`. The Execution handoff repeats this as a stop-and-raise.

- [ ] **Step 1: Append `STOCK_COUNT_POLICY` to `packages/db/test/inventory/policies.ts`**

`TRANSFER_RECEIPT_POLICY` is already in that module — **Task 4 put it there**, because Task 4 is the first task that posts a `TRANSFER_RECEIPT` and `TRANSFER_RECEIPT.json` does not exist until Step 5 below. This step adds one constant and re-declares nothing.

```ts
/** §4.14 `STOCK_COUNT` — variance only (spec:1052, 2026). This is Task 3's `COUNT_POLICY` verbatim: the
 *  evaluator's unit tests and the seeded type must not be two different policies. */
export const STOCK_COUNT_POLICY = {
  version: 1, documentType: "STOCK_COUNT", direction: "internal", requires: ["warehouse"],
  lines: [
    { for: "each_line", side: "debit",  account: { from: "item.inventory_account" }, amount: "line.cost", when: { "line.kind": "item", "line.quantity_sign": "positive" } },
    { for: "each_line", side: "credit", account: { code: "5110" },                   amount: "line.cost", when: { "line.kind": "item", "line.quantity_sign": "positive" } },
    { for: "each_line", side: "credit", account: { from: "item.inventory_account" }, amount: "line.cost", when: { "line.kind": "item", "line.quantity_sign": "negative" } },
    { for: "each_line", side: "debit",  account: { code: "5110" },                   amount: "line.cost", when: { "line.kind": "item", "line.quantity_sign": "negative" } },
  ],
  inventory: { effect: "receipt", warehouse: "line.warehouse", costing: "create_layer", allowNegative: false },
  tax: { applies: false },
  numbering: { series: "SC", assignAt: "issue" },
  reversal: { allowed: true, producesType: "STOCK_COUNT" },
  approval: { required: true, approve: "inventory.adjustment.approve", post: "inventory.adjustment.approve", create: "inventory.count.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;
```

**`effect: "receipt"` with `costing: "create_layer"` on a type that also issues.** A surplus is a receipt with no purchase price, valued by amendment A8 at `average(openLayers)`; a shortfall is a *negative* resolved quantity, which Task 3's behaviour 2 flips to `issue` + `consume_layers` automatically. One declared effect covers both directions because the sign does the work — which is the whole reason the schema needed no new label.

- [ ] **Step 2: Write the failing `TRANSFER_RECEIPT` test**

`packages/db/test/inventory/transfer-receipt.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument, issueDocument, reverseDocument } from "../../src/posting";
import { draftTransfer, draftTransferReceipt } from "../../src/inventory/transfer";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument, grantCodes, seedAccount, seedBranch, seedDocumentType, seedItem, seedParty,
  seedTenantV2, seedUnit, seedWarehouse, type Seed,
} from "../fixtures";
import { ctxOf, GRN_POLICY, TRANSFER_POLICY, TRANSFER_RECEIPT_POLICY } from "./policies";

describe("TRANSFER_RECEIPT — the receive leg and its variance (spec:1053)", () => {
  let db: Db; let s: Seed;
  let trfType: string; let trrType: string; let grnType: string;
  let itemId: string; let unitId: string; let partyId: string;
  let whHq: string; let whBranch: string; let whTransit: string; let branchB: string; let acc1300: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-trr");
    await grantCodes(db, s);
    acc1300 = await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, s, { code: "1310", nameEn: "Goods in transit", type: "asset" });
    await seedAccount(db, s, { code: "5110", nameEn: "Stock-count variance", type: "expense" });
    await seedAccount(db, s, { code: "2150", nameEn: "Goods received not invoiced", type: "liability" });
    trfType = await seedDocumentType(db, s, { code: "TRANSFER", module: "inventory", policy: TRANSFER_POLICY });
    trrType = await seedDocumentType(db, s, { code: "TRANSFER_RECEIPT", module: "inventory", policy: TRANSFER_RECEIPT_POLICY });
    grnType = await seedDocumentType(db, s, { code: "GOODS_RECEIPT", module: "inventory", policy: GRN_POLICY });
    partyId = await seedParty(db, s, { code: "SUP-1", kind: "supplier" });
    branchB = await seedBranch(db, s, { code: "BR-2", nameEn: "Branch 2" });
    whHq      = await seedWarehouse(db, s, { code: "WH-HQ",      kind: "stock",      branchId: s.hq });
    whBranch  = await seedWarehouse(db, s, { code: "WH-BR2",     kind: "stock",      branchId: branchB });
    whTransit = await seedWarehouse(db, s, { code: "WH-BR2-TR",  kind: "in_transit", branchId: branchB });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, { code: "SKU-TRR", trackLots: false, baseUnitId: unitId,
                                          accounts: { inventoryAccountId: acc1300 } }));
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: grnType, series: "GRN", effectiveDate: "2026-01-05", partyId, warehouseId: whHq,
      lines: [{ kind: "item", itemId, warehouseId: whHq, unitId, quantity: "40.000000", unitPrice: "5.0000", amount: "200.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
  }, 180_000);
  afterAll(async () => { await db?.stop(); });

  /** Dispatch `qty` and return the posted TRANSFER's ids. */
  async function dispatch(qty: string, effectiveDate: string) {
    return withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const d = await draftTransfer(tx, ctxOf(s), {
        fromWarehouseId: whHq, toWarehouseId: whBranch, effectiveDate, series: "TRF",
        documentTypeId: trfType, lines: [{ itemId, unitId, quantity: qty }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: d.documentId });
      await postDocument(tx, ctxOf(s), { documentId: d.documentId });
      return d;
    });
  }

  async function receive(transfer: { documentId: string; lineIds: string[] }, counted: string | null, effectiveDate: string) {
    return withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await draftTransferReceipt(tx, ctxOf(s), {
        transferDocumentId: transfer.documentId, documentTypeId: trrType, series: "TRR", effectiveDate,
        received: counted === null ? undefined : [{ transferLineId: transfer.lineIds[0]!, countedQuantity: counted }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      return { ...r, result: await postDocument(tx, ctxOf(s), { documentId: r.documentId }) };
    });
  }

  /** `e.credit desc` is the THIRD sort key and it is load-bearing. The SHORTFALL case below expects two
   *  `1310` rows whose `debit` is `0.0000` on both (credits 40.0000 and 10.0000); `order by a.code,
   *  e.debit desc` leaves that pair tied, so Postgres may return either order and the `toEqual` would pass
   *  or fail on plan choice. The credits are what separate them. */
  const ledgerOf = (documentId: string) =>
    withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text, e.credit::text
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${documentId} order by a.code, e.debit desc, e.credit desc`);

  it("a FULL receipt moves the whole value out of 1310 and posts no variance", async () => {
    const t = await dispatch("10.000000", "2026-01-10");
    const r = await receive(t, "10.000000", "2026-01-11");
    expect(await ledgerOf(r.documentId)).toEqual([
      { code: "1300", debit: "50.0000", credit: "0.0000" },
      { code: "1310", debit: "0.0000",  credit: "50.0000" },
    ]);
    const [transit] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ q: string }[]>`
      select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
       where item_id = ${itemId} and warehouse_id = ${whTransit}`);
    expect(transit!.q).toBe("0.000000");           // the corridor cleared
  });

  it("a SHORTFALL posts the difference to 5110 and still clears 1310 exactly", async () => {
    const t = await dispatch("10.000000", "2026-01-12");
    const r = await receive(t, "8.000000", "2026-01-13");
    // Dispatched 10 at 5.0000 = 50.0000 debited to 1310. Arrived 8 = 40.0000. Missing 2 = 10.0000.
    expect(await ledgerOf(r.documentId)).toEqual([
      { code: "1300", debit: "40.0000", credit: "0.0000" },
      { code: "1310", debit: "0.0000",  credit: "40.0000" },
      { code: "1310", debit: "0.0000",  credit: "10.0000" },
      { code: "5110", debit: "10.0000", credit: "0.0000" },
    ]);
    const [transit] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ q: string }[]>`
      select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
       where item_id = ${itemId} and warehouse_id = ${whTransit}`);
    expect(transit!.q).toBe("0.000000");           // 10 in, 10 out: the missing 2 left transit too
  });

  it("the two movements carry DIFFERENT quantities — expected out of transit, counted into the branch", async () => {
    const t = await dispatch("6.000000", "2026-01-14");
    const r = await receive(t, "5.000000", "2026-01-15");
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { movement_no: number; warehouse_id: string; quantity: string }[]
    >`select movement_no, warehouse_id, quantity::text
        from app.inventory_movement where document_id = ${r.documentId} order by movement_no`);
    expect(rows).toEqual([
      { movement_no: 1, warehouse_id: whTransit, quantity: "-6.000000" },   // everything that left
      { movement_no: 2, warehouse_id: whBranch,  quantity: "5.000000" },    // what arrived
    ]);
  });

  it("an OVERAGE posts the difference the other way", async () => {
    const t = await dispatch("4.000000", "2026-01-16");
    const r = await receive(t, "5.000000", "2026-01-17");
    const rows = await ledgerOf(r.documentId);
    // Arrived 5 at the transit unit cost 5.0000 = 25.0000; dispatched 4 = 20.0000; over by 5.0000.
    expect(rows).toContainEqual({ code: "1310", debit: "5.0000", credit: "0.0000" });
    expect(rows).toContainEqual({ code: "5110", debit: "0.0000", credit: "5.0000" });
  });

  it("`received` omitted receives everything, so the variance is null and no 5110 row exists", async () => {
    const t = await dispatch("3.000000", "2026-01-18");
    const r = await receive(t, null, "2026-01-19");
    expect((await ledgerOf(r.documentId)).map((x) => x.code)).toEqual(["1300", "1310"]);
  });

  it("the receipt links to the transfer with `receives_against`", async () => {
    const t = await dispatch("2.000000", "2026-01-20");
    const r = await receive(t, "2.000000", "2026-01-21");
    const links = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ link_kind: string; source: string }[]>`
      select link_kind, source_document_id as source from app.document_link where target_document_id = ${r.documentId}`);
    expect(links).toEqual([{ link_kind: "receives_against", source: t.documentId }]);
  });

  it("a shortfall receipt's movements are asserted by WAREHOUSE and DIRECTION, not by a balance sum", async () => {
    // The direction is the whole content of this type, and Σdebit = Σcredit is satisfied by every
    // policy-driven document ever posted — it would not have caught a receipt that moved goods the wrong
    // way. So the assertion is the two rows themselves: everything that left the corridor, and only what
    // arrived at the branch.
    const t = await dispatch("10.000000", "2026-01-22");
    const r = await receive(t, "7.000000", "2026-01-23");
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { movement_no: number; warehouse_id: string; quantity: string; value: string }[]
    >`select movement_no, warehouse_id, quantity::text, value::text
        from app.inventory_movement where document_id = ${r.documentId} order by movement_no`);
    expect(rows).toEqual([
      { movement_no: 1, warehouse_id: whTransit, quantity: "-10.000000", value: "-50.0000" },
      { movement_no: 2, warehouse_id: whBranch,  quantity: "7.000000",   value: "35.0000" },
    ]);
  });

  it("a TRANSFER_RECEIPT cannot be reversed — the policy forbids it and 1A's guard says so by name", async () => {
    // `document_line.quantity` on this type is the VARIANCE, so `reverseDocument`'s negation would produce a
    // FORWARD move of the variance rather than an undo of the 10-out / 7-in pair (see "the reversal
    // interaction" above). The policy therefore declares `reversal: { allowed: false, producesType: null }`
    // and 1A's `reverseDocument` refuses before it writes anything. A mis-counted receipt is corrected by a
    // STOCK_COUNT at the receiving branch.
    const t = await dispatch("10.000000", "2026-01-25");
    const r = await receive(t, "7.000000", "2026-01-26");
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctxOf(s), { documentId: r.documentId, effectiveDate: "2026-01-27", reason: "wrong receipt" })))
      .rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: policy for TRANSFER_RECEIPT does not allow reversal/);
    // Nothing was written: no reversal document, and the receipt is still `posted`.
    const [counts] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number; status: string }[]>`
      select (select count(*)::int from app.document where reverses_document_id = ${r.documentId}) as n,
             (select status from app.document where id = ${r.documentId})                          as status`);
    expect(counts).toEqual({ n: 0, status: "posted" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run --cwd packages/db test inventory/transfer-receipt`
Expected: FAIL — `draftTransferReceipt is not a function` (it is not yet exported from `transfer.ts`), so every case errors.

- [ ] **Step 4: Append `draftTransferReceipt` to `packages/db/src/inventory/transfer.ts`**

```ts
export interface TransferReceiptInput {
  transferDocumentId: string;
  documentTypeId: string; series: string; effectiveDate: string;
  received?: readonly { transferLineId: string; countedQuantity: string }[];
}

/**
 * The receive leg. Reads the dispatch rather than trusting the caller: the corridor is the transfer's
 * `to_warehouse_id` and the destination its `custom_fields.final_warehouse_id` (ADR 0043), so a receipt
 * cannot be pointed at a warehouse the goods never travelled to.
 *
 * Each drafted line carries THREE quantities and they are written in one statement, which is what makes the
 * variance impossible to desynchronise:
 *   expected_quantity = what the dispatch line moved
 *   counted_quantity  = what arrived (the dispatched quantity when `received` omits the line)
 *   quantity          = counted − expected, the SIGNED variance the policy's `when` rules read
 * Task 3's `transferQuantities` then gives movement 1 the expected quantity (out of transit) and movement 2
 * the counted one (into the branch), and Task 4 fills `line.cost` from the receipt leg and
 * `line.variance_value` from the difference.
 */
export async function draftTransferReceipt(
  tx: Sql, ctx: TenantContext, input: TransferReceiptInput,
): Promise<{ documentId: string; lineIds: string[]; finalWarehouseId: string }> {
  const [transfer] = await tx<{
    id: string; company_id: string; status: string; branch_id: string; currency: string;
    exchange_rate: string; to_warehouse_id: string | null; final_warehouse_id: string | null;
  }[]>`
    select id, company_id, status, branch_id, currency, exchange_rate::text as exchange_rate,
           to_warehouse_id, custom_fields ->> 'final_warehouse_id' as final_warehouse_id
      from app.document where id = ${input.transferDocumentId}`;
  if (transfer === undefined) {
    throw new AppError("ERR_NOT_FOUND", `document ${input.transferDocumentId} is not visible`);
  }
  if (transfer.status !== "posted") {
    throw new AppError(
      "ERR_VALIDATION_FAILED",
      `transfer ${input.transferDocumentId} is ${transfer.status}; only a posted transfer can be received`,
    );
  }
  if (transfer.to_warehouse_id === null || transfer.final_warehouse_id === null) {
    throw new AppError(
      "ERR_VALIDATION_FAILED",
      `transfer ${input.transferDocumentId} carries no in-transit or final warehouse; it was not drafted by draftTransfer`,
    );
  }
  const inTransitWarehouseId = transfer.to_warehouse_id;
  const finalWarehouseId = transfer.final_warehouse_id;

  const dispatchLines = await tx<{ id: string; line_no: number; item_id: string | null; lot_id: string; unit_id: string | null; quantity: string }[]>`
    select id, line_no, item_id, lot_id, unit_id, quantity::text as quantity
      from app.document_line where document_id = ${input.transferDocumentId} order by line_no`;
  const counted = new Map((input.received ?? []).map((r) => [r.transferLineId, r.countedQuantity]));
  for (const id of counted.keys()) {
    if (!dispatchLines.some((l) => l.id === id)) {
      throw new AppError("ERR_NOT_FOUND", `document line ${id} is not a line of document ${input.transferDocumentId}`);
    }
  }

  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       warehouse_id, to_warehouse_id, branch_id, custom_fields)
    values (${ctx.tenantId}, ${transfer.company_id}, ${input.documentTypeId}, ${input.series},
            ${input.effectiveDate}, ${transfer.currency}, ${transfer.exchange_rate},
            ${inTransitWarehouseId}, ${finalWarehouseId}, ${transfer.branch_id},
            ${tx.json({ transfer_document_id: input.transferDocumentId })})
    returning id`;
  const documentId = doc!.id;

  const lineIds: string[] = [];
  const links: { sourceLineId: string; targetLineId: string; quantity: string }[] = [];
  for (const dl of dispatchLines) {
    // The dispatch line's quantity is a positive magnitude on the document (the MOVEMENT is what carries the
    // sign), so `expected` is that figure as written.
    const expected = dl.quantity;
    const arrived = counted.get(dl.id) ?? expected;
    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id, unit_id,
         quantity, counted_quantity, expected_quantity, amount)
      values (${ctx.tenantId}, ${transfer.company_id}, ${documentId}, ${dl.line_no}, 'item', ${dl.item_id},
              ${inTransitWarehouseId}, ${dl.lot_id}, ${dl.unit_id},
              (${arrived}::numeric(19,6) - ${expected}::numeric(19,6)), ${arrived}, ${expected}, 0)
      returning id`;
    lineIds.push(row!.id);
    links.push({ sourceLineId: dl.id, targetLineId: row!.id, quantity: arrived });
  }

  await linkFulfilment(tx, ctx, {
    sourceDocumentId: input.transferDocumentId, targetDocumentId: documentId,
    linkKind: "receives_against", lines: links, priceFromSource: false,
  });
  return { documentId, lineIds, finalWarehouseId };
}
```

Add `import { linkFulfilment } from "../documents/link";` to the top of `transfer.ts`, and export the two new names from `packages/db/src/inventory/index.ts`.

**Note the destination the movement lands in.** The receipt's `to_warehouse_id` is the **final** warehouse (not the corridor), which is what the policy's `to_warehouse: "header.to_warehouse"` resolves to for movement 2, while every line's `warehouse_id` is the corridor, which movement 1 issues from. The dispatch and the receipt therefore use the same policy shape with the two warehouses swapped in meaning — no second effect and no second policy key.

- [ ] **Step 5: Write `packages/db/seed/my/document-types/TRANSFER_RECEIPT.json` and `STOCK_COUNT.json`**

`TRANSFER_RECEIPT.json` — the envelope around `TRANSFER_RECEIPT_POLICY` from Step 1, with `"code": "TRANSFER_RECEIPT"`, `"nameEn": "Stock Transfer (receipt)"`, `"nameAr": "تحويل مخزون (استلام)"`, `"module": "inventory"`, `"policyVersion": 1`, `"effectiveFrom": "2026-01-01"` and the six-rule `policy` copied verbatim.

`STOCK_COUNT.json`:

```json
{
  "code": "STOCK_COUNT",
  "nameEn": "Stock Count",
  "nameAr": "جرد المخزون",
  "module": "inventory",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "STOCK_COUNT",
    "direction": "internal",
    "requires": ["warehouse"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "item.inventory_account" }, "amount": "line.cost", "when": { "line.kind": "item", "line.quantity_sign": "positive" } },
      { "for": "each_line", "side": "credit", "account": { "code": "5110" },                   "amount": "line.cost", "when": { "line.kind": "item", "line.quantity_sign": "positive" } },
      { "for": "each_line", "side": "credit", "account": { "from": "item.inventory_account" }, "amount": "line.cost", "when": { "line.kind": "item", "line.quantity_sign": "negative" } },
      { "for": "each_line", "side": "debit",  "account": { "code": "5110" },                   "amount": "line.cost", "when": { "line.kind": "item", "line.quantity_sign": "negative" } }
    ],
    "inventory": { "effect": "receipt", "warehouse": "line.warehouse", "costing": "create_layer", "allowNegative": false },
    "tax": { "applies": false },
    "numbering": { "series": "SC", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "STOCK_COUNT" },
    "approval": { "required": true, "approve": "inventory.adjustment.approve", "post": "inventory.adjustment.approve", "create": "inventory.count.create" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

`approval.required: true` with `create` and `approve` naming **different** codes is what spec:2026 asks for and what makes R1 non-vacuous: Task 2 granted `inventory.count.create` to `warehouse`/`branch_manager` and `inventory.adjustment.approve` to `accountant` alone, so the counter and the approver are necessarily different principals.

- [ ] **Step 6: Write the failing `STOCK_COUNT` test**

`packages/db/test/inventory/stock-count.test.ts` — the DoD clause, the R1/R2 proof through all three paths test 31 names, and the zero-variance line that plans nothing:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument, issueDocument, transitionDocument } from "../../src/posting";
import { recordCounts, snapshotCountSheet, type CountSheetLine } from "../../src/inventory/count";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedItem, seedParty, seedTenantV2,
  seedUnit, seedWarehouse, type Seed,
} from "../fixtures";
import { ctxOf, GRN_POLICY, STOCK_COUNT_POLICY } from "./policies";
// §4.17.1 amendment 12 (Task 0): the second principal R1 needs, exported rather than copied four times.
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";
import type { TenantContext } from "../../src/with-tenant";

describe("STOCK_COUNT — posts ONLY the variance (spec:1052, 2026; test 31)", () => {
  let db: Db;
  let s: Seed;
  let scType: string; let grnType: string;
  let warehouseId: string; let unitId: string; let partyId: string;
  let acc1300: string;
  let items: string[];                       // three items, seeded in code order SKU-C1 … SKU-C3
  let counter: string; let checker: string;  // two principals — R1 needs a maker and a differing checker
  let counterCtx: TenantContext; let checkerCtx: TenantContext;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-count");
    acc1300 = await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, s, { code: "5110", nameEn: "Stock-count variance", type: "expense" });
    // GRN_POLICY's credit leg. Without it the stock-creating receipt raises ERR_POLICY_REQUIRES_MISSING
    // (§4.4.1) and every case below fails in `beforeAll` for a reason that has nothing to do with counting.
    await seedAccount(db, s, { code: "2150", nameEn: "Goods received not invoiced", type: "liability" });
    scType = await seedDocumentType(db, s, { code: "STOCK_COUNT", module: "inventory", policy: STOCK_COUNT_POLICY });
    grnType = await seedDocumentType(db, s, { code: "GOODS_RECEIPT", module: "inventory", policy: GRN_POLICY });
    partyId = await seedParty(db, s, { code: "SUP-1", kind: "supplier" });
    warehouseId = await seedWarehouse(db, s, { code: "WH-COUNT", kind: "stock", branchId: s.hq });
    unitId = await seedUnit(db, s, { code: "PCS" });

    // Three items, so "one line has a variance and the other two do not" is a real three-line sheet.
    // `snapshotCountSheet` orders its lines by item code then lot code, so the array below is the sheet's
    // own order and `sheet.lines[0]` is SKU-C1 — which is what lets a case name a line by index.
    items = [];
    for (const code of ["SKU-C1", "SKU-C2", "SKU-C3"]) {
      const { itemId } = await seedItem(db, s, {
        code, trackLots: false, baseUnitId: unitId, accounts: { inventoryAccountId: acc1300 },
      });
      items.push(itemId);
    }

    // The two principals, and the grants that make R1 non-vacuous: the counter may draft and may NOT
    // approve; the checker may approve and post and may NOT draft (Task 2's role split, spec:2159-2161).
    counter = await secondPrincipal(db, s, "counter");
    checker = await secondPrincipal(db, s, "checker");
    await grantCodes(db, s, { codes: ["inventory.count.create"], principalId: counter, roleCode: "counter" });
    await grantCodes(db, s, {
      codes: ["inventory.adjustment.approve"], principalId: checker, roleCode: "checker",
    });
    // `s.human` posts the receipts that create the stock, so it needs the receipt code and nothing else
    // this suite gates on. `grantCodes(db, s)` with no options grants the human every catalogue code
    // (§4.17), which would make R1 vacuous if the counter or the checker were `s.human` — they are not.
    await grantCodes(db, s, { codes: ["inventory.receipt.post", "inventory.receipt.create"] });
    counterCtx = { tenantId: s.tenant, actorId: counter, requestId: "count-maker" };
    checkerCtx = { tenantId: s.tenant, actorId: checker, requestId: "count-checker" };

    // Stock of 10 each at 4.0000, one GOODS_RECEIPT per item so each has its own layer.
    for (const itemId of items) {
      const { documentId } = await draftTypedDocument(db, s, {
        documentTypeId: grnType, series: "GRN", effectiveDate: "2026-01-05", partyId, warehouseId,
        lines: [{ kind: "item", itemId, warehouseId, unitId, quantity: "10.000000",
                  unitPrice: "4.0000", amount: "40.0000" }],
      });
      await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
    }
  }, 240_000);
  afterAll(async () => { await db?.stop(); });

  it("THE DoD CLAUSE — three lines, one variance: one movement, two ledger rows, nothing for the matches", async () => {
    const sheet = await withTenant(db.rw, counterCtx.tenantId, counter, (tx) =>
      snapshotCountSheet(tx, counterCtx, { documentTypeId: scType, series: "SC", effectiveDate: "2026-02-01", warehouseId }));
    expect(sheet.lines).toHaveLength(3);
    expect(sheet.lines.map((l) => [l.expectedQuantity, l.countedQuantity, l.variance])).toEqual([
      ["10.000000", null, null], ["10.000000", null, null], ["10.000000", null, null],
    ]);

    // Item 1 counts short by 2; items 2 and 3 match exactly.
    await withTenant(db.rw, counterCtx.tenantId, counter, (tx) => recordCounts(tx, counterCtx, {
      documentId: sheet.documentId,
      counts: [
        { documentLineId: sheet.lines[0]!.documentLineId, countedQuantity: "8.000000" },
        { documentLineId: sheet.lines[1]!.documentLineId, countedQuantity: "10.000000" },
        { documentLineId: sheet.lines[2]!.documentLineId, countedQuantity: "10.000000" },
      ],
    }));

    // R1: the counter submits, the checker approves and posts.
    await withTenant(db.rw, counterCtx.tenantId, counter, (tx) =>
      transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" }));
    await withTenant(db.rw, checkerCtx.tenantId, checker, async (tx) => {
      await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" });
      await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "issued" });
      await postDocument(tx, checkerCtx, { documentId: sheet.documentId });
    });

    const movements = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { line_no: number; quantity: string; value: string }[]
    >`select line_no, quantity::text, value::text
        from app.inventory_movement where document_id = ${sheet.documentId} order by line_no`);
    expect(movements).toEqual([{ line_no: 1, quantity: "-2.000000", value: "-8.0000" }]);

    const ledger = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; debit: string; credit: string; source_line: number | null }[]
    >`select a.code, e.debit::text, e.credit::text, e.line_no as source_line
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${sheet.documentId} order by a.code`);
    expect(ledger).toEqual([
      { code: "1300", debit: "0.0000", credit: "8.0000", source_line: 1 },
      { code: "5110", debit: "8.0000", credit: "0.0000", source_line: 1 },
    ]);
    // The two matching lines contributed NOTHING — no movement, no ledger row, no cost_layer.
    expect(ledger.every((r) => r.source_line === 1)).toBe(true);
  });

  it("a SURPLUS line is valued at the average of the open layers (amendment A8)", async () => {
    // Stock is 10 @ 4.0000 in one layer. A count finding 13 is a receipt of 3 with NO purchase price, so
    // amendment A8 values it at `average(openLayers)` = 4.0000 and the surplus posts at 12.0000.
    const sheet = await snapshotAndCount([{ index: 0, counted: "13.000000" }], "2026-02-05");
    const ledger = await ledgerOf(sheet.documentId);
    expect(ledger).toEqual([
      { code: "1300", debit: "12.0000", credit: "0.0000", source_line: 1 },
      { code: "5110", debit: "0.0000",  credit: "12.0000", source_line: 1 },
    ]);
    const [layer] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ unit_cost: string; qty_in: string }[]>`
      select l.unit_cost::text, l.qty_in::text
        from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
       where m.document_id = ${sheet.documentId}`);
    expect(layer).toEqual({ unit_cost: "4.0000", qty_in: "3.000000" });
  });

  it("a fully matching sheet posts a document with no movements and no ledger lines at all", async () => {
    // Every line's variance is zero, so `quantity_sign` is null on every line: no `when` matches, Task 3's
    // zero-drop removes every movement, and `postDocument` posts a document whose plan is empty. This is
    // the case that would ABORT without behaviour 3 — inventory_movement carries check (quantity <> 0).
    const sheet = await snapshotAndCount([
      { index: 0, counted: "10.000000" }, { index: 1, counted: "10.000000" }, { index: 2, counted: "10.000000" },
    ], "2026-02-10");
    const [doc] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ status: string; number: string }[]>`
      select status, number::text from app.document where id = ${sheet.documentId}`);
    expect(doc!.status).toBe("posted");
    expect(doc!.number).not.toBeNull();                     // it still numbered — a matching count is evidence
    const [counts] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ mv: number; le: number }[]>`
      select (select count(*)::int from app.inventory_movement where document_id = ${sheet.documentId}) as mv,
             (select count(*)::int from app.ledger_entry      where document_id = ${sheet.documentId}) as le`);
    expect(counts).toEqual({ mv: 0, le: 0 });
  });

  // Test 31's THREE paths are two files, not one. The **API** path is a case in
  // `apps/api/test/routes/accounting/document-count.test.ts` (Step 8 below): `sharedApi` and `problemOf`
  // are `apps/api` test-tier helpers (§4.17.1) and §3.1's `dependency-rule` forbids `packages/db` from
  // depending on `apps/api`, so an `api.request(...)` in THIS file is a lint failure and, in a package
  // that does not have `apps/api` on its path, a module-not-found. The **direct SQL** and **job** paths
  // belong here, where they are what they claim to be: the trigger refusing a write that never went
  // through the API at all.
  it("test 31 by direct `app_rw` SQL: the same principal's UPDATE raises the same token", async () => {
    // `sheetId` comes from this case's own sheet. An earlier draft referenced a `sheetId` no line declared,
    // which would have been a compile error at `bun run typecheck`.
    const { documentId: sheetId } = await snapshotAndRecord([{ index: 0, counted: "9.000000" }], "2026-02-15");
    await withTenant(db.rw, s.tenant, counter, (tx) =>
      transitionDocument(tx, counterCtx, { documentId: sheetId, to: "submitted" }));
    await expect(withTenant(db.rw, s.tenant, counter, (tx) =>
      tx`update app.document set status = 'approved' where id = ${sheetId}`))
      .rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER/);
  });

  it("test 31 by job: the system principal cannot approve either — R1 needs a differing HUMAN actor", async () => {
    // A job runs as the tenant's system principal (hazard 20). R2 passes — a system principal satisfies
    // `app.actor_has` unconditionally (§4.5.3's first `exists`) — and R1 still refuses, because the
    // submitted event's actor is the counter and the trigger compares actors, not authority.
    const sheet = await snapshotAndRecord([{ index: 0, counted: "9.000000" }], "2026-02-16");
    await withTenant(db.rw, s.tenant, counter, (tx) =>
      transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" }));
    await expect(withTenant(db.rw, s.tenant, s.system, (tx) =>
      transitionDocument(tx, { tenantId: s.tenant, actorId: s.system, requestId: "job-approve" },
                         { documentId: sheet.documentId, to: "approved" })))
      .rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER|ERR_SOD_NO_SUBMISSION/);
  });

  it("an approver who never received a submission is ERR_SOD_NO_SUBMISSION", async () => {
    // draft → approved directly. R1's first clause is "at least one `submitted` event exists".
    const sheet = await snapshotAndRecord([{ index: 0, counted: "9.000000" }], "2026-02-17");
    await expect(withTenant(db.rw, s.tenant, checker, (tx) =>
      transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" })))
      .rejects.toThrow(/ERR_SOD_NO_SUBMISSION/);
  });

  it("recordCounts refuses a non-draft sheet, so a submitted count cannot be edited", async () => {
    const sheet = await snapshotAndRecord([{ index: 0, counted: "9.000000" }], "2026-02-18");
    await withTenant(db.rw, s.tenant, counter, (tx) =>
      transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" }));
    await expect(withTenant(db.rw, s.tenant, counter, (tx) => recordCounts(tx, counterCtx, {
      documentId: sheet.documentId,
      counts: [{ documentLineId: sheet.lines[0]!.documentLineId, countedQuantity: "1.000000" }],
    }))).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: count sheet .* is submitted; counted quantities may only be entered on a draft/);
  });

  it("`quantity` and `counted_quantity` are written together — no line has one without the other", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_line
       where (counted_quantity is null) <> (quantity is null)
         and expected_quantity is not null`);
    expect(rows[0]!.n).toBe(0);
  });
});
```

**The three file-local helpers every case above uses**, written once at the top of the suite so no case repeats the four-step sheet dance:

```ts
/** Snapshot a sheet and enter the given counts, leaving it a DRAFT. `index` is the position in the
 *  snapshot's own line order (item code, then lot code), so a case names a line without knowing its uuid. */
async function snapshotAndRecord(
  counts: readonly { index: number; counted: string }[], effectiveDate: string,
): Promise<{ documentId: string; lines: CountSheetLine[] }> {
  const sheet = await withTenant(db.rw, s.tenant, counter, (tx) =>
    snapshotCountSheet(tx, counterCtx, { documentTypeId: scType, series: "SC", effectiveDate, warehouseId }));
  const lines = await withTenant(db.rw, s.tenant, counter, (tx) => recordCounts(tx, counterCtx, {
    documentId: sheet.documentId,
    counts: counts.map((c) => ({
      documentLineId: sheet.lines[c.index]!.documentLineId, countedQuantity: c.counted,
    })),
  }));
  return { documentId: sheet.documentId, lines };
}

/** …and take it all the way to `posted` through the R1 pair: the counter submits, the checker approves,
 *  issues and posts. Two principals, because that is the whole point of the type (spec:2026). */
async function snapshotAndCount(
  counts: readonly { index: number; counted: string }[], effectiveDate: string,
): Promise<{ documentId: string; lines: CountSheetLine[] }> {
  const sheet = await snapshotAndRecord(counts, effectiveDate);
  await withTenant(db.rw, s.tenant, counter, (tx) =>
    transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" }));
  await withTenant(db.rw, s.tenant, checker, async (tx) => {
    await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" });
    await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "issued" });
    await postDocument(tx, checkerCtx, { documentId: sheet.documentId });
  });
  return sheet;
}

const ledgerOf = (documentId: string) =>
  withTenant(db.rw, s.tenant, s.human, (tx) => tx<
    { code: string; debit: string; credit: string; source_line: number | null }[]
  >`select a.code, e.debit::text, e.credit::text, e.line_no as source_line
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = ${documentId} order by a.code`);
```

- [ ] **Step 7: Write `packages/db/src/inventory/count.ts`**

```ts
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";
import type { TenantContext } from "../with-tenant";

export interface CountSheetLine {
  documentLineId: string; lineNo: number;
  itemId: string; itemCode: string; warehouseId: string; lotId: string; lotCode: string;
  expectedQuantity: string; countedQuantity: string | null; variance: string | null;
}
export interface SnapshotCountSheetInput {
  documentTypeId: string; series: string; effectiveDate: string; warehouseId: string;
  itemIds?: readonly string[]; includeZero?: boolean;
}

/**
 * One line per (item, warehouse, lot) key from the SYNCHRONOUS stock_on_hand projection (§4.7.3), with
 * `expected_quantity` set and `counted_quantity` / `quantity` NULL. Reading the projection rather than
 * re-summing `inventory_movement` is 1B's rule and the reason test 2 exists: a sheet that quietly
 * re-aggregated would hide the very drift the count is meant to find.
 */
export async function snapshotCountSheet(
  tx: Sql, ctx: TenantContext, input: SnapshotCountSheetInput,
): Promise<{ documentId: string; lines: CountSheetLine[] }> {
  const [wh] = await tx<{ company_id: string; branch_id: string; kind: string; code: string }[]>`
    select company_id, branch_id, kind, code from app.warehouse
     where id = ${input.warehouseId} and archived_at is null`;
  if (wh === undefined) throw new AppError("ERR_NOT_FOUND", `warehouse ${input.warehouseId} is not visible`);
  if (wh.kind !== "stock") {
    throw new AppError("ERR_VALIDATION_FAILED", `warehouse ${wh.code} is ${wh.kind}; only a stock warehouse is counted`);
  }

  const keys = await tx<{ item_id: string; item_code: string; lot_id: string; lot_code: string; quantity: string }[]>`
    select h.item_id, i.code as item_code, h.lot_id, l.code as lot_code, h.quantity::text as quantity
      from app.stock_on_hand h
      join app.item i on i.id = h.item_id
      join app.lot  l on l.id = h.lot_id
     where h.warehouse_id = ${input.warehouseId}
       and (${input.itemIds === undefined || input.itemIds.length === 0} or h.item_id = any(${[...(input.itemIds ?? [])]}))
       and (${input.includeZero ?? false} or h.quantity <> 0)
     order by i.code, l.code`;
  if (keys.length === 0) {
    throw new AppError("ERR_DOC_NO_LINES", `warehouse ${wh.code} has no stock to count`);
  }

  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       warehouse_id, branch_id)
    select ${ctx.tenantId}, ${wh.company_id}, ${input.documentTypeId}, ${input.series},
           ${input.effectiveDate}, c.base_currency, '1.00000000', ${input.warehouseId}, ${wh.branch_id}
      from app.company c where c.id = ${wh.company_id}
    returning id`;
  const documentId = doc!.id;

  const lines: CountSheetLine[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i]!;
    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id, unit_id,
         quantity, counted_quantity, expected_quantity, amount)
      select ${ctx.tenantId}, ${wh.company_id}, ${documentId}, ${i + 1}, 'item', ${k.item_id},
             ${input.warehouseId}, ${k.lot_id}, i.base_unit_id, null, null, ${k.quantity}, 0
        from app.item i where i.id = ${k.item_id}
      returning id`;
    lines.push({
      documentLineId: row!.id, lineNo: i + 1, itemId: k.item_id, itemCode: k.item_code,
      warehouseId: input.warehouseId, lotId: k.lot_id, lotCode: k.lot_code,
      expectedQuantity: k.quantity, countedQuantity: null, variance: null,
    });
  }
  return { documentId, lines };
}

/**
 * **The sole writer of `counted_quantity` and of `quantity` on a counted line.** Both columns move in ONE
 * statement, computed in SQL from the row's own `expected_quantity`, so the variance cannot disagree with its
 * operands and no caller can set one without the other. A CHECK constraint could not express this: the
 * triple is null-null-null on every other document type and a reversal carries a negated `quantity` with no
 * count columns at all (§4.5.1's reversal shape).
 */
export async function recordCounts(
  tx: Sql, ctx: TenantContext,
  input: { documentId: string; counts: readonly { documentLineId: string; countedQuantity: string }[] },
): Promise<CountSheetLine[]> {
  const [doc] = await tx<{ status: string }[]>`select status from app.document where id = ${input.documentId}`;
  if (doc === undefined) throw new AppError("ERR_NOT_FOUND", `document ${input.documentId} is not visible`);
  if (doc.status !== "draft") {
    throw new AppError(
      "ERR_DOC_STATUS_ILLEGAL",
      `count sheet ${input.documentId} is ${doc.status}; counted quantities may only be entered on a draft`,
    );
  }
  for (const c of input.counts) {
    const affected = await tx`
      update app.document_line
         set counted_quantity = ${c.countedQuantity}::numeric(19,6),
             quantity         = ${c.countedQuantity}::numeric(19,6) - expected_quantity
       where id = ${c.documentLineId}
         and document_id = ${input.documentId}
         and expected_quantity is not null`;
    if (affected.count === 0) {
      throw new AppError(
        "ERR_NOT_FOUND",
        `document line ${c.documentLineId} is not a count line of document ${input.documentId}`,
      );
    }
  }
  return readCountSheet(tx, input.documentId);
}

/** The sheet in `line_no` order — the count screen's list and the runbook's printout. */
export async function readCountSheet(tx: Sql, documentId: string): Promise<CountSheetLine[]> {
  const rows = await tx<{
    id: string; line_no: number; item_id: string; item_code: string; warehouse_id: string;
    lot_id: string; lot_code: string; expected: string; counted: string | null; variance: string | null;
  }[]>`
    select dl.id, dl.line_no, dl.item_id, i.code as item_code, dl.warehouse_id, dl.lot_id, l.code as lot_code,
           dl.expected_quantity::text as expected, dl.counted_quantity::text as counted, dl.quantity::text as variance
      from app.document_line dl
      join app.item i on i.id = dl.item_id
      join app.lot  l on l.id = dl.lot_id
     where dl.document_id = ${documentId} and dl.expected_quantity is not null
     order by dl.line_no`;
  return rows.map((r) => ({
    documentLineId: r.id, lineNo: r.line_no, itemId: r.item_id, itemCode: r.item_code,
    warehouseId: r.warehouse_id, lotId: r.lot_id, lotCode: r.lot_code,
    expectedQuantity: r.expected, countedQuantity: r.counted, variance: r.variance,
  }));
}
```

- [ ] **Step 8: Add the wire contracts, the three count sub-paths and the transfer `receipt` sub-path**

`packages/contracts/src/inventory/count.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, QuantitySchema, UuidSchema } from "../common";

export const CountSheetLineSchema = z.object({
  documentLineId: UuidSchema, lineNo: z.number().int().positive(),
  itemId: UuidSchema, itemCode: z.string(), warehouseId: UuidSchema,
  lotId: UuidSchema, lotCode: z.string(),
  /** Nullable on the wire and **omitted by the count screen's own read** (Task 13): a counter who can see
   *  the expected figure confirms it, which is the one control the legacy process lacked. The accountant
   *  reviewing the sheet sees it; the counter does not. */
  expectedQuantity: QuantitySchema.nullable(),
  countedQuantity: QuantitySchema.nullable(),
  variance: QuantitySchema.nullable(),
}).openapi("CountSheetLine");

export const CountSheetBody = z.object({
  documentTypeCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  series: z.string().regex(/^[A-Z0-9-]{1,16}$/),
  effectiveDate: DateSchema,
  warehouseId: UuidSchema,
  itemIds: z.array(UuidSchema).optional(),
  includeZero: z.boolean().optional(),
}).strict().openapi("CountSheetBody");

export const RecordCountsBody = z.object({
  counts: z.array(z.object({ documentLineId: UuidSchema, countedQuantity: QuantitySchema })).min(1),
}).strict().openapi("RecordCountsBody");

export const CountSheetResultSchema = z.object({
  documentId: UuidSchema, lines: z.array(CountSheetLineSchema),
}).openapi("CountSheetResult");
```

Add `export * from "./inventory/count";` to `packages/contracts/src/index.ts`.

**Four sub-paths on 1A's `documents` module** — the three count routes and the transfer **receipt**, which is the second half of the two-step transfer and has no other home (Task 7 Step 7 added the dispatch). All four are sub-paths of an already-registered, already-probed module, so there is **no new `RouteModule` and no `PROBES` entry** (§4.2.7, hazard 31) and test 12's tenant-isolation walk covers them for free.

| Route | Gate | Handler |
|---|---|---|
| `POST …/documents/count-sheet` | `requireDocumentPermission("create")` over the **body's** `documentTypeCode` — there is no `:documentId` yet (§4.5.4's create stage) | `snapshotCountSheet` |
| `PATCH …/documents/{documentId}/counts` | `requireDocumentPermission("create")` — `PATCH`, not `PUT`: a counter enters part of a sheet at a time | `recordCounts` |
| `GET …/documents/{documentId}/count-sheet` | `requireDocumentModuleRead()` — the `inventory` row of §4.5.8's map, which 3A shipped | `readCountSheet` |
| `POST …/documents/{documentId}/receipt` | `requireDocumentPermission("create")` — `{documentId}` is the **posted `TRANSFER`** being received | `draftTransferReceipt` |

```ts
// apps/api/src/routes/accounting/documents.ts — beside Task 5's `convert` and Task 7's `transfers`.

const countSheetRoute = createRoute({
  method: "post",
  path: "/count-sheet",
  tags: ["accounting"],
  summary: "Snapshot a stock-count sheet from stock_on_hand (report-free; the document is the sheet)",
  middleware: [requireDocumentPermission("create")] as const,
  request: {
    params: z.object({ companyId: z.string().uuid() }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: CountSheetBody } } },
  },
  responses: {
    201: { description: "The drafted sheet", content: { "application/json": { schema: CountSheetResultSchema } } },
    400: { description: "Not a stock warehouse", content: { "application/problem+json": { schema: ProblemSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "Warehouse or document type not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    422: { description: "The warehouse has no stock to count (ERR_DOC_NO_LINES)", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

documentRoutes.openapi(countSheetRoute, async (c) => {
  const body = c.req.valid("json");
  const result = await c.var.withTenant(async (tx) => {
    const [type] = await tx<{ id: string }[]>`
      select id from app.document_type where code = ${body.documentTypeCode} and archived_at is null`;
    if (type === undefined) {
      throw new AppError("ERR_NOT_FOUND", `document type ${body.documentTypeCode} is not configured`);
    }
    return snapshotCountSheet(tx, c.var.ctx, {
      documentTypeId: type.id, series: body.series, effectiveDate: body.effectiveDate,
      warehouseId: body.warehouseId, itemIds: body.itemIds, includeZero: body.includeZero,
    });
  });
  return c.json(result, 201);
});

const recordCountsRoute = createRoute({
  method: "patch",
  path: "/{documentId}/counts",
  tags: ["accounting"],
  summary: "Enter counted quantities on a draft stock-count sheet",
  middleware: [requireDocumentPermission("create")] as const,
  request: {
    params: z.object({ documentId: z.string().uuid(), companyId: z.string().uuid() }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: RecordCountsBody } } },
  },
  responses: {
    200: { description: "The sheet after the entry", content: { "application/json": { schema: CountSheetResultSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "Sheet or line not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    409: { description: "The sheet is not a draft (ERR_DOC_STATUS_ILLEGAL)", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

documentRoutes.openapi(recordCountsRoute, async (c) => {
  const { documentId } = c.req.valid("param");
  const { counts } = c.req.valid("json");
  const lines = await c.var.withTenant((tx) => recordCounts(tx, c.var.ctx, { documentId, counts }));
  return c.json({ documentId, lines }, 200);
});

const readCountSheetRoute = createRoute({
  method: "get",
  path: "/{documentId}/count-sheet",
  tags: ["accounting"],
  summary: "Read a stock-count sheet in line order",
  middleware: [requireDocumentModuleRead()] as const,
  request: { params: z.object({ documentId: z.string().uuid(), companyId: z.string().uuid() }) },
  responses: {
    200: { description: "The sheet", content: { "application/json": { schema: CountSheetResultSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

documentRoutes.openapi(readCountSheetRoute, async (c) => {
  const { documentId, companyId } = c.req.valid("param");
  const { lines } = await c.var.withTenant(async (tx) => {
    const rows = await readCountSheet(tx, documentId);
    // The runbook's one control, expressed once and on the server: a COUNTER never sees the expected
    // figure, because a counter who can see it confirms it instead of counting. The approver does — that
    // is the whole of reviewing a variance. The check is on the APPROVE code rather than on a query flag
    // so a client cannot ask for the column and be given it.
    //
    // `app.actor_has(code, company_id, branch_id)` takes THREE arguments (plan0A:1203, 1212 — a null
    // branch means company-wide), so both are passed; a one-argument call does not exist.
    const [gate] = await tx<{ ok: boolean }[]>`
      select app.actor_has('inventory.adjustment.approve', ${companyId}, null) as ok`;
    return {
      lines: gate!.ok ? rows : rows.map((l) => ({ ...l, expectedQuantity: null })),
    };
  });
  return c.json({ documentId, lines }, 200);
});

const transferReceiptRoute = createRoute({
  method: "post",
  path: "/{documentId}/receipt",
  tags: ["accounting"],
  summary: "Draft the receipt of a posted stock transfer, with the variance on receipt (spec:1053)",
  // `{documentId}` is the posted TRANSFER. The gate is still the `create` stage over the BODY's type —
  // TRANSFER_RECEIPT's `approval.create` (inventory.transfer.create) — because the authority being asked
  // for is "may this principal raise a receipt", not "may this principal touch that transfer".
  middleware: [requireDocumentPermission("create")] as const,
  request: {
    params: z.object({ documentId: z.string().uuid(), companyId: z.string().uuid() }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: TransferReceiptBody } } },
  },
  responses: {
    201: { description: "The drafted receipt", content: { "application/json": { schema: TransferDraftSchema } } },
    400: { description: "The transfer is not posted, or was not drafted by draftTransfer", content: { "application/problem+json": { schema: ProblemSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "Transfer, line or document type not found", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

documentRoutes.openapi(transferReceiptRoute, async (c) => {
  const { documentId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await c.var.withTenant(async (tx) => {
    const [type] = await tx<{ id: string }[]>`
      select id from app.document_type where code = ${body.documentTypeCode} and archived_at is null`;
    if (type === undefined) {
      throw new AppError("ERR_NOT_FOUND", `document type ${body.documentTypeCode} is not configured`);
    }
    const drafted = await draftTransferReceipt(tx, c.var.ctx, {
      transferDocumentId: documentId, documentTypeId: type.id, series: body.series,
      effectiveDate: body.effectiveDate, received: body.received,
    });
    return { ...drafted, inTransitWarehouseId: null };
  });
  return c.json(result, 201);
});
```

`TransferReceiptBody` is appended to **Task 7's** `packages/contracts/src/inventory/transfer.ts`, beside `TransferDraftBody` and the `TransferDraftSchema` both routes answer with:

```ts
/** What arrived, per dispatch line. A line omitted arrives in full — which is the common case, and the
 *  reason `received` is optional rather than a required echo of the dispatch. */
export const TransferReceiptBody = z.object({
  documentTypeCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  series: z.string().regex(/^[A-Z0-9-]{1,16}$/),
  effectiveDate: DateSchema,
  received: z.array(z.object({ transferLineId: UuidSchema, countedQuantity: QuantitySchema })).optional(),
}).strict().openapi("TransferReceiptBody");
```

- [ ] **Step 9: Write the API-tier suite — test 31's API path, the four route cases, and test 15**

`apps/api/test/routes/accounting/document-count.test.ts` is this task's API-tier file, and **test 31's API path lives here**, not in the DB-tier suite: `sharedApi`, `api.request` and `problemOf` are `apps/api` helpers (§4.17.1) and §3.1's `dependency-rule` forbids `packages/db` depending on `apps/api`.

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CountSheetResultSchema } from "@dulja/contracts";
import { postDocument, withTenant } from "@dulja/db";
import {
  draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedItem, seedParty,
  seedUnit, seedWarehouse, type Db, type Seed,
} from "@dulja/db/test";
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";
import { sharedApi, problemOf, type StartedApi } from "../../support/api";

/** The policies come from the seed pack, not from `packages/db/test/inventory/policies.ts`: that module is
 *  a `packages/db` test file and is not part of `@dulja/db/test`'s exports, so it is not importable from
 *  `apps/api`. Both files exist by this step — `GOODS_RECEIPT.json` is 3C's and `STOCK_COUNT.json` is
 *  written by Step 5 above. `process.cwd()` is `apps/api`, because this suite runs `--cwd apps/api`. */
const packPolicy = (code: string): unknown =>
  (JSON.parse(readFileSync(
    join(process.cwd(), "..", "..", "packages", "db", "seed", "my", "document-types", `${code}.json`), "utf8",
  )) as { policy: unknown }).policy;

describe("stock-count routes and acceptance test 31's API path (3D T8)", () => {
  let api: StartedApi; let db: Db; let s: Seed;
  let warehouseId: string; let unitId: string; let itemId: string; let partyId: string;
  let counter: string; let checker: string;
  /** A sheet left in DRAFT with one count entered — the `GET` case reads it. */
  let sheetId: string;
  /** A second sheet, SUBMITTED — the "PATCH on a non-draft" case needs one that cannot be edited. */
  let submittedSheetId: string; let submittedLineId: string;

  beforeAll(async () => {
    ({ api, db, s } = await sharedApi());
    await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, s, { code: "5110", nameEn: "Stock-count variance", type: "expense" });
    await seedAccount(db, s, { code: "2150", nameEn: "Goods received not invoiced", type: "liability" });
    await seedDocumentType(db, s, { code: "STOCK_COUNT", module: "inventory", policy: packPolicy("STOCK_COUNT") });
    const grnType = await seedDocumentType(db, s, { code: "GOODS_RECEIPT", module: "inventory", policy: packPolicy("GOODS_RECEIPT") });
    partyId = await seedParty(db, s, { code: "SUP-API", kind: "supplier" });
    warehouseId = await seedWarehouse(db, s, { code: "WH-API", kind: "stock", branchId: s.hq });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, { code: "SKU-API", trackLots: false, baseUnitId: unitId }));

    // The two principals and the disjoint grants that make R1 non-vacuous through the API as well as
    // through the service: the counter may draft, the checker may approve, neither may do the other's job.
    counter = await secondPrincipal(db, s, "api-counter");
    checker = await secondPrincipal(db, s, "api-checker");
    await grantCodes(db, s, { codes: ["inventory.count.create"], principalId: counter, roleCode: "api-counter" });
    await grantCodes(db, s, { codes: ["inventory.adjustment.approve"], principalId: checker, roleCode: "api-checker" });
    await grantCodes(db, s, { codes: ["inventory.receipt.post", "inventory.receipt.create"] });

    // 10 units at 4.0000, so there is something to count.
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: grnType, series: "GRN", effectiveDate: "2026-01-05", partyId, warehouseId,
      lines: [{ kind: "item", itemId, warehouseId, unitId, quantity: "10.000000",
                unitPrice: "4.0000", amount: "40.0000" }],
    });
    const humanCtx = { tenantId: s.tenant, actorId: s.human, requestId: "api-count-fixture" };
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, humanCtx, { documentId }));

    // Sheet 1: drafted through the route and left a draft, with one count entered.
    const draftSheet = CountSheetResultSchema.parse(await (await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/count-sheet`,
      as: counter, idempotencyKey: "api-sheet-1",
      body: { documentTypeCode: "STOCK_COUNT", series: "SC", effectiveDate: "2026-02-01", warehouseId },
    })).json());
    sheetId = draftSheet.documentId;
    await api.request({
      method: "PATCH", path: `/v1/companies/${s.company}/documents/${sheetId}/counts`,
      as: counter, idempotencyKey: "api-counts-1",
      body: { counts: [{ documentLineId: draftSheet.lines[0]!.documentLineId, countedQuantity: "9.000000" }] },
    });

    // Sheet 2: drafted and SUBMITTED, so `recordCounts` must refuse it.
    const submitted = CountSheetResultSchema.parse(await (await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/count-sheet`,
      as: counter, idempotencyKey: "api-sheet-2",
      body: { documentTypeCode: "STOCK_COUNT", series: "SC", effectiveDate: "2026-02-02", warehouseId },
    })).json());
    submittedSheetId = submitted.documentId;
    submittedLineId = submitted.lines[0]!.documentLineId;
    await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${submittedSheetId}/transitions`,
      as: counter, idempotencyKey: "api-submit-2", body: { to: "submitted" },
    });
  }, 300_000);
  // No `afterAll`: `sharedApi()` owns the API and its container, and this file stops neither.
```

The four cases below close that `describe`. `checker` is used by the last two of them.

```ts
  it("test 31 by API: the counter cannot approve their own sheet (ERR_SOD_MAKER_IS_CHECKER)", async () => {
    // The sheet is drafted and submitted through the two routes above, so this case exercises the whole
    // API path rather than reaching into the service: POST count-sheet → PATCH counts → POST transitions.
    const sheet = CountSheetResultSchema.parse(await (await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/count-sheet`,
      as: counter, idempotencyKey: "sod-sheet",
      body: { documentTypeCode: "STOCK_COUNT", series: "SC", effectiveDate: "2026-02-15", warehouseId },
    })).json());
    await api.request({
      method: "PATCH", path: `/v1/companies/${s.company}/documents/${sheet.documentId}/counts`,
      as: counter, idempotencyKey: "sod-counts",
      body: { counts: [{ documentLineId: sheet.lines[0]!.documentLineId, countedQuantity: "9.000000" }] },
    });
    await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${sheet.documentId}/transitions`,
      as: counter, idempotencyKey: "sod-submit", body: { to: "submitted" },
    });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${sheet.documentId}/transitions`,
      as: counter, idempotencyKey: "sod-api", body: { to: "approved" },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_SOD_MAKER_IS_CHECKER");
  });

  it("the count sheet a COUNTER reads carries no expected quantity (the runbook's one control)", async () => {
    const res = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/documents/${sheetId}/count-sheet`, as: counter,
    });
    expect(res.status).toBe(200);
    const body = CountSheetResultSchema.parse(await res.json());
    expect(body.lines.every((l) => l.expectedQuantity === null)).toBe(true);
  });

  it("PATCH …/counts on a submitted sheet is 409 ERR_DOC_STATUS_ILLEGAL", async () => {
    const res = await api.request({
      method: "PATCH", path: `/v1/companies/${s.company}/documents/${submittedSheetId}/counts`,
      as: counter, idempotencyKey: "late-count",
      body: { counts: [{ documentLineId: submittedLineId, countedQuantity: "1.000000" }] },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_DOC_STATUS_ILLEGAL");
  });

  it("POST …/count-sheet without an Idempotency-Key is 400, and without the code is 403", async () => {
    const noKey = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/count-sheet`,
      as: counter, idempotencyKey: null,
      body: { documentTypeCode: "STOCK_COUNT", series: "SC", effectiveDate: "2026-02-20", warehouseId },
    });
    expect(noKey.status).toBe(400);
    expect((await problemOf(noKey)).code).toBe("ERR_IDEMPOTENCY_KEY_REQUIRED");
    const wrongPrincipal = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/count-sheet`,
      as: checker, idempotencyKey: "sheet-403",          // the checker holds `approve`, never `create`
      body: { documentTypeCode: "STOCK_COUNT", series: "SC", effectiveDate: "2026-02-20", warehouseId },
    });
    expect(wrongPrincipal.status).toBe(403);
    expect((await problemOf(wrongPrincipal)).code).toBe("ERR_RBAC_FORBIDDEN");
  });
```

**The `expectedQuantity`-is-null case is a claim about the ROUTE, not about the service**, and Step 8's `readCountSheetRoute` handler is where it is implemented (the `app.actor_has('inventory.adjustment.approve')` projection). `readCountSheet` itself always returns the column — the accountant reviewing variances needs it, and the DB-tier suite asserts on it — so nulling it in the service would break both. `sheetId`, `submittedSheetId` and `submittedLineId` are `let`s the `beforeAll` fills from its own `POST …/count-sheet` and `PATCH …/counts` calls, in the shape the first case above shows.

Then the test-15 re-run. Add to the same file a `describe("acceptance test 15 — a new inventory document type, zero code")` block that configures **`COUNT_TEST`** through `POST /v1/companies/{companyId}/document-types` (2A's route) with a body carrying the §4.14 row's shape — `module: "inventory"`, series `CT`, `approval.approve` and `.post` both `inventory.adjustment.approve`, and the same four variance rules as `STOCK_COUNT` — and then proves all five clauses of the test against it, in order: it **numbers** (`CT-1` from the policy's series, §4.3.6), it **posts** only the variance, it **prints** (2C's print route returns a PDF whose `pdfText` contains the number), it **reports** (the document appears in `accounting.ledger` for `5110` — Task 10's `inventory.stock_on_hand` is the inventory half), and it **reverses** (`producesType: "COUNT_TEST"`, the reversal balancing to zero).

`COUNT_TEST` is registered in §4.14 by Task 0 and is **never** a file under `packages/db/seed/my/document-types/`. The test asserts that too:

```ts
  it("COUNT_TEST is not in the seed pack — the zero-code claim is about a type the release did not ship", () => {
    expect(existsSync(join(TYPES_DIR, "COUNT_TEST.json"))).toBe(false);
  });
```

- [ ] **Step 10: Write `docs/runbooks/stock-count.md`**

The operator procedure, four sections: **before the count** (choose the warehouse, decide full or cycle, `POST …/count-sheet`, print the sheet with blank count boxes — the `expected_quantity` column is deliberately *omitted* from the printed sheet so a counter cannot copy it, which is the one control the legacy process lacked); **during** (count by lot, write the figure, the sheet is the evidence); **after** (`PATCH …/counts`, submit); **approval** (the accountant reviews variances against the expected figures, approves and posts; the resulting `5110` balance is the month's shrinkage). The runbook states plainly that a matching sheet posts a document with no ledger effect, and that this is the intended outcome rather than a failure.

- [ ] **Step 11: Run everything**

Run: `bun run --cwd packages/db test inventory && bun run --cwd apps/api test document-count && bun run --cwd packages/db seed --tenant "$TEST_TENANT" --only document-types && bun run --cwd packages/db test seed/document-types && bun run lint:rules`
Expected: PASS. Five of the six seed files now exist; `seed/document-types.test.ts` validates each envelope and each policy against the catalogue.

- [ ] **Step 12: Commit**

```bash
git add packages/db/seed/my/document-types/TRANSFER_RECEIPT.json \
        packages/db/seed/my/document-types/STOCK_COUNT.json \
        packages/db/src/inventory/count.ts packages/db/src/inventory/transfer.ts \
        packages/db/src/inventory/index.ts packages/db/test/inventory/policies.ts \
        packages/contracts/src/inventory/count.ts packages/contracts/src/inventory/transfer.ts \
        packages/contracts/src/index.ts \
        packages/db/test/inventory/transfer-receipt.test.ts packages/db/test/inventory/stock-count.test.ts \
        apps/api/src/routes/accounting/documents.ts \
        apps/api/test/routes/accounting/document-count.test.ts \
        docs/runbooks/stock-count.md
git commit -m "feat(inventory): TRANSFER_RECEIPT and STOCK_COUNT, the two variance types [3D T8]

STOCK_COUNT posts only the variance: a matching line plans no movement and no ledger row,
and the DoD clause is asserted on a three-line sheet with one variance. TRANSFER_RECEIPT's
two legs carry different quantities and the difference clears 1310 to zero through 5110.
recordCounts is the sole writer of counted_quantity and of the derived variance. Tests 31
(three paths) and 15 (COUNT_TEST, configured through the API) re-run.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `EXPIRY_WRITE_OFF` — the branch drafts, the accountant approves, `5100` tagged BRANCH

The last of the six types (spec:1054): "branch drafts, accountant approves, posts to an expiry-loss account tagged BRANCH". The write-off is a plain issue at cost — no variance shape, no second quantity — so this task is short, and its whole content is the authority split and the BRANCH tag.

**Files:**
- Create: `packages/db/seed/my/document-types/EXPIRY_WRITE_OFF.json`
- Create: `packages/db/src/inventory/write-off.ts`
- Create: `packages/db/test/inventory/write-off.test.ts`
- Modify: `packages/db/src/inventory/index.ts`, `packages/db/test/inventory/policies.ts`

**Interfaces:**
- Consumes: `postDocument`, `transitionDocument` (§4.3.1, 2B); `listNearExpiryLots`, `NearExpiryLot` (3A, `packages/db/src/inventory/expiry.ts`); `app.stock_on_hand`, `app.lot.expires_on` (3A); `secondPrincipal`, `grantCodes` (§4.17.1, §4.17); `AppError` (§4.2.4); `Quantity` (§4.2.1, 0D — `totalQuantity` is a `Quantity`, never a `number`); `TenantContext` (§4.2.2).
- Produces:

```ts
// packages/db/src/inventory/write-off.ts
export interface ExpiryWriteOffInput {
  documentTypeId: string; series: string; effectiveDate: string; warehouseId: string;
  /** Written off in full unless a quantity is given — a partly-spoiled lot is the exception, not the rule. */
  lots: readonly { lotId: string; quantity?: string }[];
  reason: string;
}
/** Drafts an EXPIRY_WRITE_OFF: one line per lot at the quantity `stock_on_hand` holds for it in this
 *  warehouse. Refuses a lot with no stock here (`ERR_VALIDATION_FAILED` naming the lot) rather than drafting
 *  a line that would fail `assert_stock_available` at post — the branch clerk should learn at drafting time.
 *  `reason` is written to `document.custom_fields.reason` for the accountant reviewing the draft. */
export async function draftExpiryWriteOff(
  tx: Sql, ctx: TenantContext, input: ExpiryWriteOffInput,
): Promise<{ documentId: string; lineIds: string[]; totalQuantity: string }>;
```

- [ ] **Step 1: Append `EXPIRY_WRITE_OFF_POLICY` to `packages/db/test/inventory/policies.ts`**

```ts
/** §4.14 `EXPIRY_WRITE_OFF` — spec:1054. `5100` is 3C's account (§4.15) and is named, never re-seeded.
 *  `dimensions.required: ["BRANCH"]` is the spec's "tagged BRANCH": the evaluator adds `document.branch` as
 *  BRANCH to every planned line and then checks `required`, so a policy that omitted it would post untagged
 *  lines and the branch profit report (7C) would silently miss the loss. */
export const EXPIRY_WRITE_OFF_POLICY = {
  version: 1, documentType: "EXPIRY_WRITE_OFF", direction: "internal", requires: ["warehouse"],
  lines: [
    { for: "each_line", side: "debit",  account: { code: "5100" },                   amount: "line.cost", when: { "line.kind": "item" } },
    { for: "each_line", side: "credit", account: { from: "item.inventory_account" }, amount: "line.cost", when: { "line.kind": "item" } },
  ],
  inventory: { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers", allowNegative: false },
  tax: { applies: false },
  numbering: { series: "EWO", assignAt: "issue" },
  reversal: { allowed: true, producesType: "EXPIRY_WRITE_OFF" },
  approval: { required: true, approve: "inventory.adjustment.approve", post: "inventory.adjustment.approve", create: "inventory.adjustment.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;
```

- [ ] **Step 2: Write the failing test**

`packages/db/test/inventory/write-off.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument, transitionDocument } from "../../src/posting";
import { draftExpiryWriteOff } from "../../src/inventory/write-off";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument, grantCodes, seedAccount, seedBranch, seedDocumentType, seedItem, seedLot,
  seedParty, seedTenantV2, seedUnit, seedWarehouse, type Seed,
} from "../fixtures";
import { ctxOf, EXPIRY_WRITE_OFF_POLICY, GRN_POLICY } from "./policies";
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";
import type { TenantContext } from "../../src/with-tenant";

describe("EXPIRY_WRITE_OFF — branch drafts, accountant approves, 5100 tagged BRANCH (spec:1054)", () => {
  let db: Db; let s: Seed;
  let ewoType: string; let grnType: string;
  let itemId: string; let unitId: string; let partyId: string;
  let branchB: string; let whHq: string; let whBranch: string;
  let lotExpired: string; let lotGood: string;
  let acc1300: string;
  let clerk: string; let accountant: string;
  let clerkCtx: TenantContext; let accountantCtx: TenantContext;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-ewo");
    acc1300 = await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    // 5100 is 3C's account (§4.15) and is NAMED, never re-seeded, by the policy — but a Testcontainers
    // tenant has only seedTenantV2's two accounts, so the test creates it exactly as it creates 1300.
    // Task 2's hazard-33 case is what proves the real seed pack resolves it.
    await seedAccount(db, s, { code: "5100", nameEn: "Inventory write-off — expiry loss", type: "expense" });
    await seedAccount(db, s, { code: "2150", nameEn: "Goods received not invoiced", type: "liability" });
    ewoType = await seedDocumentType(db, s, { code: "EXPIRY_WRITE_OFF", module: "inventory", policy: EXPIRY_WRITE_OFF_POLICY });
    grnType = await seedDocumentType(db, s, { code: "GOODS_RECEIPT", module: "inventory", policy: GRN_POLICY });
    partyId = await seedParty(db, s, { code: "SUP-1", kind: "supplier" });
    branchB = await seedBranch(db, s, { code: "BR-2", nameEn: "Branch 2" });
    whHq     = await seedWarehouse(db, s, { code: "WH-HQ",  kind: "stock", branchId: s.hq });
    whBranch = await seedWarehouse(db, s, { code: "WH-BR2", kind: "stock", branchId: branchB });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, {
      code: "SKU-EWO", trackLots: true, baseUnitId: unitId, accounts: { inventoryAccountId: acc1300 },
    }));
    lotExpired = await seedLot(db, s, { itemId, code: "LOT-FEB", expiresOn: "2026-02-28" });
    lotGood    = await seedLot(db, s, { itemId, code: "LOT-JAN", expiresOn: "2027-01-31" });

    clerk = await secondPrincipal(db, s, "clerk");
    accountant = await secondPrincipal(db, s, "accountant");
    // The authority split spec:1054 asks for, and the reason R1 and R2 are BOTH non-vacuous here: the
    // drafting code and the approving code are held by disjoint principals (Task 2's role grants).
    await grantCodes(db, s, { codes: ["inventory.adjustment.create"], principalId: clerk, roleCode: "ewo-clerk" });
    await grantCodes(db, s, { codes: ["inventory.adjustment.approve"], principalId: accountant, roleCode: "ewo-approver" });
    await grantCodes(db, s, { codes: ["inventory.receipt.post", "inventory.receipt.create"] });
    clerkCtx      = { tenantId: s.tenant, actorId: clerk,      requestId: "ewo-clerk" };
    accountantCtx = { tenantId: s.tenant, actorId: accountant, requestId: "ewo-approver" };

    // 10 units of each lot at 4.0000 into WH-BR2 — the BRANCH the write-off is drafted at, which is what
    // makes the BRANCH-dimension case a real assertion rather than a restatement of `s.hq`.
    for (const lotId of [lotExpired, lotGood]) {
      const { documentId } = await draftTypedDocument(db, s, {
        documentTypeId: grnType, series: "GRN", effectiveDate: "2026-01-05", partyId, warehouseId: whBranch,
        lines: [{ kind: "item", itemId, warehouseId: whBranch, lotId, unitId, quantity: "10.000000",
                  unitPrice: "4.0000", amount: "40.0000" }],
      });
      await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
    }
  }, 240_000);
  afterAll(async () => { await db?.stop(); });

  /** A fresh draft of the expired lot's full 10 units, as the clerk. Each call drafts its OWN document:
   *  three cases below take one all the way to `posted`, and a memoised single draft would be written off
   *  three times against a lot that holds ten units once. */
  async function draft(effectiveDate = "2026-03-01"): Promise<{ documentId: string }> {
    return withTenant(db.rw, s.tenant, clerk, (tx) =>
      draftExpiryWriteOff(tx, clerkCtx, {
        documentTypeId: ewoType, series: "EWO", effectiveDate, warehouseId: whBranch,
        lots: [{ lotId: lotExpired, quantity: "2.000000" }], reason: "expired 2026-02-28, destroyed per SOP",
      }));
  }

  /** …and its full R1/R2 walk: the clerk submits, the accountant approves, issues and posts. Two units at
   *  4.0000 = 8.0000 per call, so the lot's ten units cover the three cases that use it with room to spare
   *  and every one of them is a genuinely separate document. */
  async function approvedAndPosted(effectiveDate = "2026-03-01"): Promise<string> {
    const { documentId } = await draft(effectiveDate);
    await withTenant(db.rw, s.tenant, clerk, (tx) =>
      transitionDocument(tx, clerkCtx, { documentId, to: "submitted" }));
    await withTenant(db.rw, s.tenant, accountant, async (tx) => {
      await transitionDocument(tx, accountantCtx, { documentId, to: "approved" });
      await transitionDocument(tx, accountantCtx, { documentId, to: "issued" });
      await postDocument(tx, accountantCtx, { documentId });
    });
    return documentId;
  }

  const ledgerOf = (documentId: string) =>
    withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text, e.credit::text
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${documentId} order by a.code, e.debit desc, e.credit desc`);

  it("drafts one line per lot at the quantity on hand, and records the reason", async () => {
    const drafted = await withTenant(db.rw, s.tenant, clerk, (tx) =>
      draftExpiryWriteOff(tx, clerkCtx, {
        documentTypeId: ewoType, series: "EWO", effectiveDate: "2026-03-01", warehouseId: whBranch,
        lots: [{ lotId: lotExpired }], reason: "expired 2026-02-28, destroyed per SOP",
      }));
    expect(drafted.totalQuantity).toBe("10.000000");
    const [doc] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ reason: string }[]>`
      select custom_fields ->> 'reason' as reason from app.document where id = ${drafted.documentId}`);
    expect(doc!.reason).toBe("expired 2026-02-28, destroyed per SOP");
  });

  it("a lot with no stock in this warehouse is refused at DRAFTING time, naming the lot", async () => {
    await expect(withTenant(db.rw, s.tenant, clerk, (tx) =>
      draftExpiryWriteOff(tx, clerkCtx, {
        documentTypeId: ewoType, series: "EWO", effectiveDate: "2026-03-01", warehouseId: whHq,
        lots: [{ lotId: lotExpired }], reason: "wrong warehouse",
      // The message names the warehouse the CALL asked for — `input.warehouseId`, here WH-HQ — because
      // that is where the clerk claims the stock is. Step 4's raise reads `wh.code`, which is looked up
      // from `input.warehouseId`; expecting WH-BR2 (where the stock actually is) can never match, and the
      // case would fail even when the behaviour is exactly right.
      }))).rejects.toThrow(/ERR_VALIDATION_FAILED: lot LOT-FEB has no stock in warehouse WH-HQ/);
  });

  it("the CLERK cannot approve their own write-off (R1) and cannot post it (R2)", async () => {
    const { documentId } = await draft();
    await withTenant(db.rw, s.tenant, clerk, (tx) => transitionDocument(tx, clerkCtx, { documentId, to: "submitted" }));
    await expect(withTenant(db.rw, s.tenant, clerk, (tx) =>
      transitionDocument(tx, clerkCtx, { documentId, to: "approved" })))
      .rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER/);
    // …and even after the accountant approves and issues it, the clerk cannot post: R2 asks
    // app.actor_has(policy.approval.post = inventory.adjustment.approve), which the clerk does not hold.
    await withTenant(db.rw, s.tenant, accountant, async (tx) => {
      await transitionDocument(tx, accountantCtx, { documentId, to: "approved" });
      await transitionDocument(tx, accountantCtx, { documentId, to: "issued" });
    });
    await expect(withTenant(db.rw, s.tenant, clerk, (tx) => postDocument(tx, clerkCtx, { documentId })))
      .rejects.toThrow(/ERR_RBAC_FORBIDDEN|ERR_SOD/);
  });

  it("posts a debit to 5100 and a credit to the item's inventory account, at cost", async () => {
    // `approvedAndPosted` writes off 2 units of LOT-FEB at the AVCO unit cost 4.0000 = 8.0000, and it
    // drafts its OWN document per call — the lot holds ten units, and the three cases that use the helper
    // would otherwise be writing the same ten units off three times.
    const documentId = await approvedAndPosted("2026-03-01");
    expect(await ledgerOf(documentId)).toEqual([
      { code: "1300", debit: "0.0000", credit: "8.0000" },
      { code: "5100", debit: "8.0000", credit: "0.0000" },
    ]);
  });

  it("EVERY posted ledger line carries the BRANCH dimension of the drafting branch (spec:1054)", async () => {
    const documentId = await approvedAndPosted("2026-03-02");
    const dims = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; value_code: string }[]
    >`select dt.code, dv.code as value_code
        from app.ledger_entry e
        join app.ledger_entry_dimension d on d.ledger_entry_id = e.id
        join app.dimension_value dv on dv.id = d.dimension_value_id
        join app.dimension_type  dt on dt.id = dv.dimension_type_id
       where e.document_id = ${documentId} order by dt.code`);
    expect(dims).toHaveLength(2);                       // one per ledger line
    expect(dims.every((d) => d.code === "BRANCH" && d.value_code === "BR-2")).toBe(true);
  });

  it("the write-off consumes the expired lot's own layer, not the cheapest one", async () => {
    // AVCO pools by (item, warehouse), but the MOVEMENT names the lot, so the quantity leaves the expired
    // lot's stock_on_hand key. A write-off that drained another lot would leave expired stock on the books
    // — which is why LOT-JAN exists in this fixture and holds the same ten units at the same cost.
    const documentId = await approvedAndPosted("2026-03-03");
    const [mv] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ lot_id: string }[]>`
      select lot_id from app.inventory_movement where document_id = ${documentId}`);
    expect(mv!.lot_id).toBe(lotExpired);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run --cwd packages/db test inventory/write-off`
Expected: FAIL — `Cannot find module '../../src/inventory/write-off'`.

- [ ] **Step 4: Write `packages/db/src/inventory/write-off.ts`**

```ts
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";
import { Quantity } from "@dulja/domain";
import type { TenantContext } from "../with-tenant";

export interface ExpiryWriteOffInput {
  documentTypeId: string; series: string; effectiveDate: string; warehouseId: string;
  lots: readonly { lotId: string; quantity?: string }[];
  reason: string;
}

/**
 * The branch clerk's document. It writes `document` + `document_line` only; the accountant's approval and the
 * post are transitions, gated by the policy's `approval.approve` / `.post` (both
 * `inventory.adjustment.approve`, which Task 2 granted to `accountant` and to nobody who can draft).
 *
 * Quantities come from `stock_on_hand` for the (item, warehouse, lot) key, so "write off the lot" needs no
 * figure typed twice. A lot with nothing here is refused now rather than at post: `assert_stock_available`
 * would refuse it anyway, and a clerk should not discover that after an accountant has approved it.
 */
export async function draftExpiryWriteOff(
  tx: Sql, ctx: TenantContext, input: ExpiryWriteOffInput,
): Promise<{ documentId: string; lineIds: string[]; totalQuantity: string }> {
  const [wh] = await tx<{ company_id: string; branch_id: string; kind: string; code: string }[]>`
    select company_id, branch_id, kind, code from app.warehouse
     where id = ${input.warehouseId} and archived_at is null`;
  if (wh === undefined) throw new AppError("ERR_NOT_FOUND", `warehouse ${input.warehouseId} is not visible`);
  if (input.lots.length === 0) throw new AppError("ERR_DOC_NO_LINES", "a write-off names no lot");

  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       warehouse_id, branch_id, custom_fields)
    select ${ctx.tenantId}, ${wh.company_id}, ${input.documentTypeId}, ${input.series},
           ${input.effectiveDate}, c.base_currency, '1.00000000', ${input.warehouseId}, ${wh.branch_id},
           ${tx.json({ reason: input.reason })}
      from app.company c where c.id = ${wh.company_id}
    returning id`;
  const documentId = doc!.id;

  const lineIds: string[] = [];
  // `Quantity`, not a `number`: `totalQuantity` crosses this function's boundary and Global Constraint 4
  // forbids a `number` holding a quantity that does (spec:2041-2043, §3.7.5 `no-number-money`).
  let total = Quantity.zero();
  for (let i = 0; i < input.lots.length; i += 1) {
    const l = input.lots[i]!;
    const [key] = await tx<{ item_id: string; base_unit_id: string; on_hand: string; lot_code: string }[]>`
      select h.item_id, i.base_unit_id, h.quantity::text as on_hand, lo.code as lot_code
        from app.stock_on_hand h
        join app.item i  on i.id  = h.item_id
        join app.lot  lo on lo.id = h.lot_id
       where h.lot_id = ${l.lotId} and h.warehouse_id = ${input.warehouseId} and h.quantity > 0`;
    if (key === undefined) {
      const [lot] = await tx<{ code: string }[]>`select code from app.lot where id = ${l.lotId}`;
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        `lot ${lot?.code ?? l.lotId} has no stock in warehouse ${wh.code}`,
      );
    }
    const quantity = l.quantity ?? key.on_hand;
    if (Quantity.of(quantity).compare(Quantity.of(key.on_hand)) > 0) {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        `lot ${key.lot_code} holds ${key.on_hand} in warehouse ${wh.code}; cannot write off ${quantity}`,
      );
    }
    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id, unit_id, quantity, amount)
      values (${ctx.tenantId}, ${wh.company_id}, ${documentId}, ${i + 1}, 'item', ${key.item_id},
              ${input.warehouseId}, ${l.lotId}, ${key.base_unit_id}, ${quantity}, 0)
      returning id`;
    lineIds.push(row!.id);
    total = total.add(Quantity.of(quantity));
  }
  return { documentId, lineIds, totalQuantity: total.toString() };
}
```

Export both names from `packages/db/src/inventory/index.ts`.

- [ ] **Step 5: Write `packages/db/seed/my/document-types/EXPIRY_WRITE_OFF.json`**

The §4.3.7 envelope around `EXPIRY_WRITE_OFF_POLICY` — `"code": "EXPIRY_WRITE_OFF"`, `"nameEn": "Expiry Write-off"`, `"nameAr": "إعدام بضاعة منتهية"`, `"module": "inventory"`, `"policyVersion": 1`, `"effectiveFrom": "2026-01-01"`, and the policy copied verbatim from Step 1.

- [ ] **Step 6: Assert every seed file matches its policy constant**

The six policies now exist twice — as `as const` objects the DB-tier tests configure and as `policy` members of six seed files. Add two cases to `packages/db/test/seed/permission-phase3d.test.ts` (Task 2's file, which already reads the seed directory with `readFileSync`/`join`) proving they cannot drift, and the same for 3C's `GOODS_RECEIPT`. Two lines go at the top of that file first — the constants and the directory the cases below name:

```ts
import {
  DELIVERY_ORDER_POLICY, EXPIRY_WRITE_OFF_POLICY, GRN_POLICY, SALES_ORDER_POLICY, STOCK_COUNT_POLICY,
  TRANSFER_POLICY, TRANSFER_RECEIPT_POLICY,
} from "../inventory/policies";

const TYPES_DIR = join(process.cwd(), "seed", "my", "document-types");
```

```ts
  it("every 3D document-type seed file's policy equals the constant this slice's tests configure", () => {
    const pairs: [string, unknown][] = [
      ["SALES_ORDER", SALES_ORDER_POLICY], ["DELIVERY_ORDER", DELIVERY_ORDER_POLICY],
      ["TRANSFER", TRANSFER_POLICY], ["TRANSFER_RECEIPT", TRANSFER_RECEIPT_POLICY],
      ["STOCK_COUNT", STOCK_COUNT_POLICY], ["EXPIRY_WRITE_OFF", EXPIRY_WRITE_OFF_POLICY],
    ];
    for (const [code, constant] of pairs) {
      const envelope = JSON.parse(readFileSync(join(TYPES_DIR, `${code}.json`), "utf8")) as { code: string; module: string; policy: unknown };
      expect(envelope.code, `${code}.json's code`).toBe(code);
      expect(envelope.module, `${code}.json's module`).toBe("inventory");
      expect(envelope.policy, `${code}.json's policy vs the test constant`).toEqual(JSON.parse(JSON.stringify(constant)));
    }
  });

  it("3C's GOODS_RECEIPT policy is what this slice's fixtures assume (a drift here is 3C's finding)", () => {
    const envelope = JSON.parse(readFileSync(join(TYPES_DIR, "GOODS_RECEIPT.json"), "utf8")) as { policy: unknown };
    expect(envelope.policy).toEqual(JSON.parse(JSON.stringify(GRN_POLICY)));
  });
```

**If the `GOODS_RECEIPT` case fails, 3C's file is right and `GRN_POLICY` is corrected** — never the reverse (§4.18's rule that the written plan owns what it ships).

- [ ] **Step 7: Run everything and commit**

Run: `bun run --cwd packages/db test inventory && bun run --cwd packages/db test seed/permission-phase3d && bun run --cwd packages/db seed --tenant "$TEST_TENANT" --only document-types && bun run --cwd packages/db test seed/document-types`
Expected: PASS — all six of this slice's types are in the pack and validated, and the two drift cases are green.

```bash
git add packages/db/seed/my/document-types/EXPIRY_WRITE_OFF.json \
        packages/db/src/inventory/write-off.ts packages/db/src/inventory/index.ts \
        packages/db/test/inventory/policies.ts packages/db/test/inventory/write-off.test.ts \
        packages/db/test/seed/permission-phase3d.test.ts
git commit -m "feat(inventory): EXPIRY_WRITE_OFF, branch drafts and accountant approves [3D T9]

An issue at cost to 5100 (3C's account, named not re-seeded) with dimensions.required
BRANCH, so every posted line carries the drafting branch. R1 and R2 are both non-vacuous:
adjustment.create and adjustment.approve are held by disjoint roles. Quantities come from
stock_on_hand, and a lot with no stock here is refused at drafting time. All six seed files
are now asserted equal to the policy constants the tests configure.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The three minimal inventory reports, and migration 0042

spec:2300 requires a minimal report set from Phase 1 onward — "trial balance, ledger, stock on hand, sales by item". 1B shipped the first two; this task ships the inventory three under the §4.16.1 codes **`inventory.stock_on_hand`**, **`inventory.valuation`** and **`inventory.sales_by_item`**, as `GET`s on **1B's existing `reports` module** over hand-written read functions. 7B replaces the route bodies under the same codes and re-runs this task's tie-outs unchanged as the proof that nothing moved.

**Files:**
- Create: `packages/db/migrations/0042_add_inventory_report_index.sql`, `0042.down.sql`
- Create: `packages/db/src/reports/stock-on-hand.ts`, `packages/db/src/reports/sales-by-item.ts`
- Create: `packages/contracts/src/inventory/reports.ts`
- Create: `packages/db/test/reports/inventory-reports.test.ts`
- Create: `apps/api/test/routes/accounting/inventory-reports.test.ts`
- Modify: `packages/db/src/index.ts`, `packages/contracts/src/accounting/reports.ts` (`ReportCodeSchema`), `apps/api/src/routes/accounting/reports.ts`

**Interfaces:**
- Consumes: `valuationAsOf(tx, params)`, `ValuationParams`, `ValuationRow`, `ValuationRowSchema`, `ValuationQuery`, `ValuationList` (**3B**, §4.7.2 amendment A19 — this slice writes **no** valuation read function and **no** second row type, hazard 9); `reportsRoutes`, `reportsRouteModule`, `ReportCodeSchema` (1B); `app.stock_on_hand`, `app.warehouse.kind`, `app.item`, `app.lot` (3A); `app.cost_consumption`, `app.inventory_movement` (§4.7.3); `INVENTORY_PERMISSION` (3A); `requirePermission` (§4.2.5); `encodeCursor`, `decodeCursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `MoneySchema`, `QuantitySchema`, `ProblemSchema` (§4.2.8); `AppError` (§4.2.4); `Money`, `currency` (§4.2.1, 0D — the tie-out sums, so no `Number()` touches a monetary string); `lintSchema` (§3.5.2).
- Produces:

```ts
// packages/db/src/reports/stock-on-hand.ts
export interface StockOnHandReportParams {
  companyId: string;
  itemId?: string | null; warehouseId?: string | null;
  /** Include `warehouse.kind = 'in_transit'` rows. Default false — the DoD clause is that in-transit stock is
   *  in NEITHER warehouse's on-hand, so the default answer to "what is on my shelves" excludes it. `true` is
   *  what a company-total or a transfer-chasing view asks for. */
  includeInTransit?: boolean;
  cursor?: { itemCode: string; warehouseCode: string; lotCode: string } | null;
  limit: number;
}
export interface StockOnHandReportRow {
  itemId: string; itemCode: string; itemNameEn: string;
  warehouseId: string; warehouseCode: string; warehouseKind: "stock" | "in_transit";
  lotId: string; lotCode: string; lotExpiresOn: string | null;
  quantity: string;                 // 6-dp string; a `number` here is a `no-number-money` violation
}
/** Reads the SYNCHRONOUS projection `app.stock_on_hand` and never re-aggregates `inventory_movement` —
 *  1B's rule for `trialBalance`, applied to the inventory projection: a report that quietly recomputed would
 *  hide the drift the integrity job (test 2) exists to find. */
export async function stockOnHand(tx: Sql, params: StockOnHandReportParams): Promise<StockOnHandReportRow[]>;
/** The two company totals the DoD clause's second half needs, in one query so they cannot be read at two
 *  different instants: `onShelves` over `kind = 'stock'` and `total` over every warehouse. */
export async function stockOnHandTotals(
  tx: Sql, params: { companyId: string; itemId: string },
): Promise<{ onShelves: string; inTransit: string; total: string }>;

// packages/db/src/reports/sales-by-item.ts
export interface SalesByItemParams {
  companyId: string; fromDate: string; toDate: string;        // inclusive, on effective_date (spec:2039)
  itemId?: string | null; branchId?: string | null;
  cursor?: { itemCode: string } | null; limit: number;
}
export interface SalesByItemRow {
  itemId: string; itemCode: string; itemNameEn: string;
  deliveredQuantity: string;        // Σ |movement.quantity| over DELIVERY_ORDER issues
  cost: string;                     // Σ cost_consumption.value for those movements — the ONE cost source
  /** Deliberately absent: `revenue` and `margin`. There is no revenue-posting document type before 4A's
   *  SALES_INVOICE, so at Phase 3 this report is quantity and cost (hazard 4). **4A extends this same code**
   *  with both columns in the PR that ships SALES_INVOICE; 7B re-expresses it over 4B's item_profitability. */
}
export async function salesByItem(tx: Sql, params: SalesByItemParams): Promise<SalesByItemRow[]>;
```

**Why every name here carries `Report`, and what would break without it.** 3A already ships **`StockOnHandRow`** from `packages/db/src/inventory/stock.ts`, re-exported from the flat `packages/db/src/index.ts` barrel (`export { listStockOnHand, type StockOnHandRow } from "./inventory/stock";`, 3a:7730), and **`StockOnHandSchema` / `StockOnHandQuery` / `StockOnHandList`** from `packages/contracts/src/inventory/stock.ts` for its `GET …/stock-on-hand` list route (3a:7845, 3a:7853–7867). Re-using any of those five names here is a duplicate export from the same barrel — a TypeScript error — and, for the two Zod ones, a duplicate `.openapi(...)` component name in the generated document. So 3D's report types are `StockOnHandReportParams` / `StockOnHandReportRow` / `StockOnHandReportRowSchema` / `StockOnHandReportQuery` / `StockOnHandReportList`, and the read function is `stockOnHand` (3A's is `listStockOnHand`, so the functions do not collide).

**And the two reads are not a duplication (hazard 9), for a reason worth stating.** 3A's `listStockOnHand` is a **master-data list endpoint** on the `stock-on-hand` module — every key, `nonZeroOnly` optional, no notion of a corridor. 3D's `stockOnHand` is the **`inventory.stock_on_hand` report code** of §4.16.1: it excludes `warehouse.kind = 'in_transit'` by default because the definition-of-done clause says in-transit stock is in neither warehouse's on-hand, it carries `warehouseKind` on every row, and 7B replaces its body under the same report code. Both read the same projection and neither re-aggregates `inventory_movement`, which is the property SAH-009 actually names. If a later slice wants one of them gone, it is a §4.16.3 amendment and 7B's call, not something to resolve by renaming here.

**Why `cost` comes from `cost_consumption` and not from `document_line.cost`.** Both hold the same figure for a clean delivery, but only `cost_consumption` is layer-accurate after a replay: 3B's `inventory.cost.replay` rewrites consumptions and posts a `COST_ADJUSTMENT`, and a report reading `document_line.cost` would show the pre-recost figure forever. spec:1228's "one costing implementation" means one *source* too. The consequence, stated because Task 11 depends on it: an override-admitted shortfall has no consumption row (§4.7.3's NOT NULL `layer_id`), so its uncovered quantity contributes quantity but **no** cost — and that is the honest answer, not a gap.

- [ ] **Step 1: Write the failing DB-tier test**

`packages/db/test/reports/inventory-reports.test.ts`. The fixture is one item received at two prices into two warehouses, one delivery, one transfer left in transit, and one stock count — enough for every tie-out:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money } from "@dulja/domain";
import { salesByItem } from "../../src/reports/sales-by-item";
import { stockOnHand, stockOnHandTotals } from "../../src/reports/stock-on-hand";
import { valuationAsOf } from "../../src/costing/valuation";           // 3B's — this slice writes none
import { convertOrderToDelivery } from "../../src/inventory/fulfilment";
import { draftTransfer } from "../../src/inventory/transfer";
import { issueDocument, postDocument } from "../../src/posting";
import { lintSchema } from "../../src/lint-schema";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument, grantCodes, seedAccount, seedBranch, seedDocumentType, seedItem, seedParty,
  seedTenantV2, seedUnit, seedWarehouse, type Seed,
} from "../fixtures";
import { ctxOf, DELIVERY_ORDER_POLICY, GRN_POLICY, SALES_ORDER_POLICY, TRANSFER_POLICY } from "../inventory/policies";

const MYR = currency("MYR");        // `currency` and `Money` from @dulja/domain — the tie-outs sum exactly

describe("the three minimal inventory reports (spec:2300, §4.16.1, §4.16.3)", () => {
  let db: Db; let s: Seed;
  let branchB: string; let whHq: string; let whBr2: string; let whTransit: string;
  let itemId: string; let unitId: string; let supplierId: string; let customerId: string;
  let acc1300: string;
  let grnType: string; let soType: string; let doType: string; let trfType: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-reports");
    await grantCodes(db, s);
    acc1300 = await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    for (const a of [
      { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" as const },
      { code: "1310", nameEn: "Goods in transit",             type: "asset" as const },
      { code: "2150", nameEn: "Goods received not invoiced",  type: "liability" as const },
      { code: "5110", nameEn: "Stock-count variance",         type: "expense" as const },
    ]) {
      await seedAccount(db, s, a);
    }
    grnType = await seedDocumentType(db, s, { code: "GOODS_RECEIPT", module: "inventory", policy: GRN_POLICY });
    soType  = await seedDocumentType(db, s, { code: "SALES_ORDER", module: "inventory", policy: SALES_ORDER_POLICY });
    doType  = await seedDocumentType(db, s, { code: "DELIVERY_ORDER", module: "inventory", policy: DELIVERY_ORDER_POLICY });
    trfType = await seedDocumentType(db, s, { code: "TRANSFER", module: "inventory", policy: TRANSFER_POLICY });
    supplierId = await seedParty(db, s, { code: "SUP-1", kind: "supplier" });
    customerId = await seedParty(db, s, { code: "CUST-1", kind: "customer" });
    branchB   = await seedBranch(db, s, { code: "BR-2", nameEn: "Branch 2" });
    whHq      = await seedWarehouse(db, s, { code: "WH-HQ",     kind: "stock",      branchId: s.hq });
    whBr2     = await seedWarehouse(db, s, { code: "WH-BR2",    kind: "stock",      branchId: branchB });
    whTransit = await seedWarehouse(db, s, { code: "WH-BR2-TR", kind: "in_transit", branchId: branchB });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, {
      code: "SKU-RPT", trackLots: false, baseUnitId: unitId, accounts: { inventoryAccountId: acc1300 },
    }));

    // 1. GRN of 20 @ 5.0000 into WH-HQ → 100.0000 of stock in one layer.
    const grn = await draftTypedDocument(db, s, {
      documentTypeId: grnType, series: "GRN", effectiveDate: "2026-01-05", partyId: supplierId, warehouseId: whHq,
      lines: [{ kind: "item", itemId, warehouseId: whHq, unitId, quantity: "20.000000",
                unitPrice: "5.0000", amount: "100.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId: grn.documentId }));

    // 2. A DELIVERY_ORDER of 6, through the order-to-delivery conversion Task 5 ships — the only path that
    //    produces DELIVERY_ORDER movements, which is what `salesByItem` counts.
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType, series: "SO", effectiveDate: "2026-01-10", partyId: customerId, warehouseId: whHq,
      lines: [{ kind: "item", itemId, warehouseId: whHq, unitId, quantity: "6.000000",
                unitPrice: "9.0000", amount: "54.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await issueDocument(tx, ctxOf(s), { documentId: order.documentId });
      const { documentId } = await convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId, targetDocumentTypeId: doType, targetSeries: "DO",
        effectiveDate: "2026-01-11", warehouseId: whHq, fefo: true,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "6.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId });
      await postDocument(tx, ctxOf(s), { documentId });
    });

    // 3. A TRANSFER of 4 to WH-BR2, left UNRECEIVED: the corridor holds it, so WH-HQ is 20 − 6 − 4 = 10,
    //    WH-BR2-TR is 4, WH-BR2 has no row at all, and the company total is 14. That is the whole of the
    //    definition-of-done clause, read back through the report in the third case below.
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const d = await draftTransfer(tx, ctxOf(s), {
        fromWarehouseId: whHq, toWarehouseId: whBr2, effectiveDate: "2026-01-15", series: "TRF",
        documentTypeId: trfType, lines: [{ itemId, unitId, quantity: "4.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: d.documentId });
      await postDocument(tx, ctxOf(s), { documentId: d.documentId });
    });
  }, 300_000);
  afterAll(async () => { await db?.stop(); });

  it("stockOnHand excludes in-transit rows by default and reports the warehouse kind", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHand(tx, { companyId: s.company, limit: 50 }));
    expect(rows.map((r) => [r.warehouseCode, r.quantity])).toEqual([["WH-HQ", "10.000000"]]);
    expect(rows.every((r) => r.warehouseKind === "stock")).toBe(true);
  });

  it("includeInTransit surfaces the corridor row", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHand(tx, { companyId: s.company, includeInTransit: true, limit: 50 }));
    expect(rows.map((r) => [r.warehouseCode, r.warehouseKind, r.quantity])).toEqual([
      ["WH-BR2-TR", "in_transit", "4.000000"],
      ["WH-HQ",     "stock",      "10.000000"],
    ]);
  });

  it("THE DoD CLAUSE, from the report's own output: shelves 10, transit 4, total 14", async () => {
    const totals = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHandTotals(tx, { companyId: s.company, itemId }));
    expect(totals).toEqual({ onShelves: "10.000000", inTransit: "4.000000", total: "14.000000" });
  });

  it("TIE-OUT 1 — Σ valuationAsOf value = the 1300 + 1310 ledger balances, to the cent", async () => {
    // Both sides are summed EXACTLY — the ledger side in SQL at numeric precision, returned as `::text`,
    // and the valuation side through `Money.add`. `rows.reduce((n, r) => n + Number(r.value), 0)` over many
    // `numeric(19,4)` values can differ from the exact total in the fourth decimal place, and `.toFixed(4)`
    // then rounds two accumulations to two different strings: a test whose stated contract is "to the cent"
    // must not be able to pass or fail on accumulation order (Global Constraints 1 and 4).
    const { valued, ledger } = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await valuationAsOf(tx, { companyId: s.company, asOf: "2026-12-31", limit: 500 });
      const [bal] = await tx<{ bal: string }[]>`
        select coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::text as bal
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where a.code in ('1300', '1310') and e.company_id = ${s.company}`;
      return {
        valued: rows.reduce((m, r) => m.add(Money.of(r.value, MYR)), Money.zero(MYR)),
        ledger: Money.of(bal!.bal, MYR),
      };
    });
    expect(valued.toString()).toBe(ledger.toString());
  });

  it("TIE-OUT 2 — salesByItem's cost = Σ cost_consumption on DELIVERY_ORDER movements = the 1250 balance", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      salesByItem(tx, { companyId: s.company, fromDate: "2026-01-01", toDate: "2026-12-31", limit: 50 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveredQuantity).toBe("6.000000");
    expect(rows[0]!.cost).toBe("30.0000");
    const [acc] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ bal: string }[]>`
      select (sum(e.base_debit) - sum(e.base_credit))::text as bal
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where a.code = '1250' and e.company_id = ${s.company}`);
    expect(acc!.bal).toBe("30.0000");
  });

  it("salesByItem counts DELIVERY_ORDER movements only — a transfer or a write-off is not a sale", async () => {
    // The TRANSFER issued 4 units out of WH-HQ. If the report joined on `quantity < 0` alone it would report
    // 10 delivered. The join is on document_type.code = 'DELIVERY_ORDER'.
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      salesByItem(tx, { companyId: s.company, fromDate: "2026-01-01", toDate: "2026-12-31", limit: 50 }));
    expect(rows[0]!.deliveredQuantity).toBe("6.000000");
  });

  it("stockOnHand pages by (itemCode, warehouseCode, lotCode) and the cursor round-trips", async () => {
    const page1 = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHand(tx, { companyId: s.company, includeInTransit: true, limit: 1 }));
    expect(page1.map((r) => r.warehouseCode)).toEqual(["WH-BR2-TR"]);
    const page2 = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHand(tx, {
        companyId: s.company, includeInTransit: true, limit: 1,
        cursor: { itemCode: page1[0]!.itemCode, warehouseCode: page1[0]!.warehouseCode, lotCode: page1[0]!.lotCode },
      }));
    expect(page2.map((r) => r.warehouseCode)).toEqual(["WH-HQ"]);
    const page3 = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHand(tx, {
        companyId: s.company, includeInTransit: true, limit: 1,
        cursor: { itemCode: page2[0]!.itemCode, warehouseCode: page2[0]!.warehouseCode, lotCode: page2[0]!.lotCode },
      }));
    expect(page3).toEqual([]);                      // exhausted, and no row was returned twice
  });

  it("no report re-aggregates inventory_movement — the SQL reads stock_on_hand", () => {
    // The path is relative to `process.cwd()`, which is `packages/db` — every run of this suite is
    // `--cwd packages/db`. A repo-root-relative `"packages/db/src/..."` resolves to
    // `packages/db/packages/db/src/...` and throws ENOENT; Task 2 Step 1 gets this right the same way.
    const src = readFileSync(join(process.cwd(), "src", "reports", "stock-on-hand.ts"), "utf8");
    expect(src).toMatch(/app\.stock_on_hand/);
    expect(src).not.toMatch(/from app\.inventory_movement/);
  });

  it("lintSchema still reports zero violations after 0042 (§3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test reports/inventory-reports`
Expected: FAIL — `Cannot find module '../../src/reports/stock-on-hand'`.

- [ ] **Step 3: Write migration 0042**

`packages/db/migrations/0042_add_inventory_report_index.sql`:

```sql
-- ── 0042 · the one index the three minimal inventory reports need (spec:2300) ───
-- No table, no column, no constraint: this file is a single covering index, so `lintSchema`'s table rules
-- are unaffected and the §3.5.3 sets are unchanged.
-- Not `create index concurrently`: §3.4.1 runs each migration file whole in one transaction.

-- inventory.sales_by_item aggregates cost_consumption per movement over a date range. cost_consumption has
-- no date of its own (it hangs off the movement), so the join is movement_id and the range lives on
-- inventory_movement, whose chronological index 3A already provides. §4.7.3's DDL declares only
-- `unique (tenant_id, id)` and the two composite FKs on this table, so there is genuinely no index on
-- `movement_id` yet; this one makes the JOIN side of the report cheap.
create index cost_consumption_movement_idx
  on app.cost_consumption (movement_id)
  include (quantity, value)
  where invalidated_at is null;   -- a replay's superseded rows are never reported (spec:1223)
```

**No index is added to `app.stock_on_hand`, and an earlier draft of this file was wrong to add one.** That draft created `stock_on_hand_report_idx on app.stock_on_hand (company_id, item_id, warehouse_id, lot_id) include (quantity)`. §4.7.3 declares the table with `primary key (company_id, item_id, warehouse_id, lot_id)` (contracts:3071–3074) and `quantity` is its only other non-key data column — so that index is the primary key's own index plus an `INCLUDE` of the one column left over: a pure duplicate that costs write amplification on every posting transaction and buys nothing. Its stated justification was also unsupportable in either direction: `stockOnHand`'s keyset orders by `i.code, w.code, l.code` — **codes on the joined `item`, `warehouse` and `lot` tables** — and no index on `stock_on_hand`'s uuid columns can order by those. The real cost of the ordered page is the sort over joined codes, and at Phase 3 volumes (one company, a few thousand keys) that sort is accepted deliberately; if a tenant's page ever needs help, the index to add is `app.item (company_id, code)` / `app.warehouse (company_id, code)` — 3A's tables, so 3A's or 7B's call, with the write cost stated — and never a second copy of this projection's primary key.

`packages/db/migrations/0042.down.sql`:

```sql
-- ── 0042 down ────────────────────────────────────────────────────────────
-- Drops only the one index this file added (§3.4.5).
drop index if exists app.cost_consumption_movement_idx;
```

- [ ] **Step 4: Write `packages/db/src/reports/stock-on-hand.ts`**

```ts
import type { Sql } from "postgres";

export interface StockOnHandReportParams {
  companyId: string;
  itemId?: string | null; warehouseId?: string | null; includeInTransit?: boolean;
  cursor?: { itemCode: string; warehouseCode: string; lotCode: string } | null;
  limit: number;
}
export interface StockOnHandReportRow {
  itemId: string; itemCode: string; itemNameEn: string;
  warehouseId: string; warehouseCode: string; warehouseKind: "stock" | "in_transit";
  lotId: string; lotCode: string; lotExpiresOn: string | null;
  quantity: string;
}

/**
 * The `inventory.stock_on_hand` dataset query (§4.16.3). Reads the projection, never the movements.
 *
 * In-transit rows are excluded by default because the definition-of-done clause is that goods in transit are
 * in NEITHER warehouse's on-hand: "what is on my shelves" must not include them, and `stockOnHandTotals` is
 * how the company figure that DOES include them is asked for. `warehouseKind` is on every row so the
 * distinction is visible in the output rather than implied by a parameter.
 */
export async function stockOnHand(tx: Sql, params: StockOnHandReportParams): Promise<StockOnHandReportRow[]> {
  const rows = await tx<{
    item_id: string; item_code: string; item_name_en: string;
    warehouse_id: string; warehouse_code: string; warehouse_kind: string;
    lot_id: string; lot_code: string; lot_expires_on: string | null; quantity: string;
  }[]>`
    select h.item_id, i.code as item_code, i.name_en as item_name_en,
           h.warehouse_id, w.code as warehouse_code, w.kind as warehouse_kind,
           h.lot_id, l.code as lot_code, l.expires_on::text as lot_expires_on,
           h.quantity::text as quantity
      from app.stock_on_hand h
      join app.item      i on i.id = h.item_id
      join app.warehouse w on w.id = h.warehouse_id
      join app.lot       l on l.id = h.lot_id
     where h.company_id = ${params.companyId}
       and h.quantity <> 0
       and (${params.includeInTransit ?? false} or w.kind = 'stock')
       and (${params.itemId ?? null}::uuid is null      or h.item_id      = ${params.itemId ?? null})
       and (${params.warehouseId ?? null}::uuid is null or h.warehouse_id = ${params.warehouseId ?? null})
       and (${params.cursor === null || params.cursor === undefined}
            or (i.code, w.code, l.code) > (${params.cursor?.itemCode ?? ""},
                                           ${params.cursor?.warehouseCode ?? ""},
                                           ${params.cursor?.lotCode ?? ""}))
     order by i.code, w.code, l.code
     limit ${params.limit}`;
  return rows.map((r) => ({
    itemId: r.item_id, itemCode: r.item_code, itemNameEn: r.item_name_en,
    warehouseId: r.warehouse_id, warehouseCode: r.warehouse_code,
    warehouseKind: r.warehouse_kind as "stock" | "in_transit",
    lotId: r.lot_id, lotCode: r.lot_code, lotExpiresOn: r.lot_expires_on,
    quantity: r.quantity,
  }));
}

/** One query, three figures, so no caller can read the shelves and the total at two different instants and
 *  report a total that never existed. */
export async function stockOnHandTotals(
  tx: Sql, params: { companyId: string; itemId: string },
): Promise<{ onShelves: string; inTransit: string; total: string }> {
  const [row] = await tx<{ on_shelves: string; in_transit: string; total: string }[]>`
    select coalesce(sum(h.quantity) filter (where w.kind = 'stock'), 0)::text      as on_shelves,
           coalesce(sum(h.quantity) filter (where w.kind = 'in_transit'), 0)::text as in_transit,
           coalesce(sum(h.quantity), 0)::text                                      as total
      from app.stock_on_hand h
      join app.warehouse w on w.id = h.warehouse_id
     where h.company_id = ${params.companyId} and h.item_id = ${params.itemId}`;
  return { onShelves: row!.on_shelves, inTransit: row!.in_transit, total: row!.total };
}
```

- [ ] **Step 5: Write `packages/db/src/reports/sales-by-item.ts`**

```ts
import type { Sql } from "postgres";

export interface SalesByItemParams {
  companyId: string; fromDate: string; toDate: string;
  itemId?: string | null; branchId?: string | null;
  cursor?: { itemCode: string } | null; limit: number;
}
export interface SalesByItemRow {
  itemId: string; itemCode: string; itemNameEn: string;
  deliveredQuantity: string; cost: string;
}

/**
 * The `inventory.sales_by_item` dataset query (§4.16.3) at its **Phase 3** meaning: delivered quantity and
 * its cost per item, from DELIVERY_ORDER movements and `cost_consumption` (hazard 4). There is no revenue
 * and no margin column because no document type posts revenue before 4A's SALES_INVOICE — 4A extends this
 * same code with both, and 7B re-expresses it over 4B's `item_profitability`. A new code at either step
 * would break spec:2300's "ships continuously", which is why the register names one code for all three.
 *
 * Cost comes from `cost_consumption`, not `document_line.cost`: after a back-dated recost (3B's replay) only
 * the consumptions are current. `invalidated_at is null` is what keeps a superseded replay generation out.
 * A movement admitted by an `inventory.negative_stock.override` has no consumption row for its uncovered
 * quantity (`cost_consumption.layer_id` is NOT NULL), so such a line contributes quantity and no cost — the
 * honest figure, and the one Task 11's tie-out is built on.
 */
export async function salesByItem(tx: Sql, params: SalesByItemParams): Promise<SalesByItemRow[]> {
  const rows = await tx<{ item_id: string; item_code: string; item_name_en: string; qty: string; cost: string }[]>`
    select m.item_id, i.code as item_code, i.name_en as item_name_en,
           sum(-m.quantity)::text                            as qty,
           coalesce(sum(c.value), 0)::text                    as cost
      from app.inventory_movement m
      join app.document      d on d.id = m.document_id
      join app.document_type t on t.id = d.document_type_id
      join app.item          i on i.id = m.item_id
      left join app.cost_consumption c
             on c.movement_id = m.id and c.invalidated_at is null
     where m.company_id     = ${params.companyId}
       and t.code           = 'DELIVERY_ORDER'
       and m.quantity       < 0
       and m.effective_date between ${params.fromDate} and ${params.toDate}
       and (${params.itemId ?? null}::uuid is null   or m.item_id  = ${params.itemId ?? null})
       and (${params.branchId ?? null}::uuid is null or d.branch_id = ${params.branchId ?? null})
       and (${params.cursor === null || params.cursor === undefined} or i.code > ${params.cursor?.itemCode ?? ""})
     group by m.item_id, i.code, i.name_en
     order by i.code
     limit ${params.limit}`;
  return rows.map((r) => ({
    itemId: r.item_id, itemCode: r.item_code, itemNameEn: r.item_name_en,
    deliveredQuantity: r.qty, cost: r.cost,
  }));
}
```

`sum(-m.quantity)` rather than `abs`: the filter already restricts to issues, and negating the signed column makes the report's own arithmetic visible. `left join` on the consumption is deliberate — an inner join would silently drop an override-admitted movement instead of reporting it at zero cost.

Export the four names and two types from `packages/db/src/index.ts` beside 1B's report exports.

- [ ] **Step 6: Widen `ReportCodeSchema` and mount the three `GET`s**

In `packages/contracts/src/accounting/reports.ts`, widen 1B's enum in place — it is "a `z.enum` of the codes whose route exists" (§4.16.3) and each report-shipping slice widens it in the PR that ships the route:

```ts
/** 1B's two, plus 3D's three (§4.16.1). Every later report-shipping slice appends its own here. */
export const ReportCodeSchema = z.enum([
  "accounting.trial_balance", "accounting.ledger",
  "inventory.stock_on_hand", "inventory.valuation", "inventory.sales_by_item",
]);
```

`packages/contracts/src/inventory/reports.ts` adds `StockOnHandReportRowSchema`, `StockOnHandReportQuery` (`ListQuery.extend({ filter…, includeInTransit })`.strict()), `StockOnHandReportList`, `SalesByItemRowSchema`, `SalesByItemQuery` (`fromDate`, `toDate`, optional filters) and `SalesByItemList`. **It defines no valuation DTO** — `inventory/valuation.ts` is 3B's and its `ValuationRowSchema` / `ValuationQuery` / `ValuationList` are imported unchanged.

In `apps/api/src/routes/accounting/reports.ts`, add three routes to 1B's `reportsRoutes` router and two codes to its module's permission list. **No new `RouteModule` and no new `PROBES` key** — the path `/v1/companies/:companyId/reports` is already registered and probed (hazard 31), and a second module on the same path would break that key:

```ts
const stockOnHandRoute = createRoute({
  method: "get",
  path: "/inventory.stock_on_hand",
  tags: ["inventory"],
  summary: "Stock on hand per item, warehouse and lot (report code inventory.stock_on_hand)",
  middleware: [requirePermission(INVENTORY_PERMISSION.stockRead, { company: "path:companyId" })] as const,
  request: { params: CompanyParams, query: StockOnHandReportQuery },
  responses: {
    200: { description: "Stock-on-hand rows", content: { "application/json": { schema: StockOnHandReportList } } },
    400: { description: "Invalid query", content: { "application/problem+json": { schema: ProblemSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

reportsRoutes.openapi(stockOnHandRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  let cursor: { itemCode: string; warehouseCode: string; lotCode: string } | null = null;
  if (q.cursor !== undefined) {
    const decoded = decodeCursor(q.cursor);
    if (decoded.k.length !== 3 || decoded.k.some((v) => typeof v !== "string")) {
      throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid keyset cursor for inventory.stock_on_hand");
    }
    cursor = { itemCode: decoded.k[0] as string, warehouseCode: decoded.k[1] as string, lotCode: decoded.k[2] as string };
  }
  const rows = await c.var.withTenant((tx) => stockOnHand(tx, {
    companyId, itemId: q["filter[item_id][eq]"] ?? null, warehouseId: q["filter[warehouse_id][eq]"] ?? null,
    includeInTransit: q.includeInTransit, cursor, limit: q.limit,
  }));
  const last = rows.at(-1);
  return c.json({
    items: rows,
    next_cursor: rows.length === q.limit && last !== undefined
      ? encodeCursor({ k: [last.itemCode, last.warehouseCode, last.lotCode], id: last.lotId })
      : null,
  }, 200);
});
```

The `inventory.valuation` route is the same shape over **3B's** `valuationAsOf` with `ValuationQuery`/`ValuationList` and `INVENTORY_PERMISSION.costRead`; the `inventory.sales_by_item` route is the same shape over `salesByItem` with `INVENTORY_PERMISSION.stockRead`.

**3B's own `valuationRouteModule` stays exactly as it is, and this is not a second mount of one thing.** 3B's amendment **A8** (3b:42) registers `/v1/companies/:companyId/valuation` → `valuationRoutes` with its own `PROBES` entry and two sub-paths (`GET …/valuation` and `GET …/valuation/layers`, the raw open layers 7B's `inventory.stock_ageing` reads), and it says in terms: *"This is **not** the `inventory.valuation` report code of §4.16.1 — that is 3D's, mounted on 1B's `reports` module — and the two never collide because they are different modules on different paths."* So the two routes are a **module** and a **report code**, one function behind both (`valuationAsOf`), and hazard 9's duplication rule is satisfied where it matters: there is exactly one valuation read in `packages/db/src`, which is what Task 11's `sah-009` block greps for. 3D neither retires nor aliases 3B's module, and Step 7's route test asserts that both still exist. Then:

```ts
export const reportsRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/reports",
  router: reportsRoutes,
  permissions: [
    PERMISSION["accounting.report.read"], PERMISSION["accounting.ledger.read"],
    INVENTORY_PERMISSION.stockRead, INVENTORY_PERMISSION.costRead,     // 3D
  ],
  auth: "human",
};
```

`INVENTORY_PERMISSION.costRead` is **3B's** member of 3A's constant (3B extended it by one for its valuation route); if it is absent, that is a 3B reconciliation, not a licence to write `PERMISSION["inventory.cost.read"]` inline here.

- [ ] **Step 7: Write the route test**

`apps/api/test/routes/accounting/inventory-reports.test.ts` — for each of the three codes: a 200 whose body validates against the list schema; a principal without the report's code getting 403 `ERR_RBAC_FORBIDDEN`; an unknown query key getting 400 `ERR_VALIDATION_FAILED` (the `.strict()` proof); and a garbage cursor getting 400 with the report's own message. Plus one cross-code case:

```ts
  it("all three codes live on 1B's reports module, and ROUTES has exactly one entry for that path", () => {
    const onPath = ROUTES.filter((m) => m.path === "/v1/companies/:companyId/reports");
    expect(onPath).toHaveLength(1);                       // a second module here would break the PROBES key
    expect(ReportCodeSchema.options).toEqual([
      "accounting.trial_balance", "accounting.ledger",
      "inventory.stock_on_hand", "inventory.valuation", "inventory.sales_by_item",
    ]);
    // …and 3B's own valuation MODULE is untouched by this slice: `inventory.valuation` as a report code and
    // `/v1/companies/:companyId/valuation` as a module are two surfaces over one read function, which is
    // what 3B's amendment A8 says in terms (3b:42). A pass here that found ZERO valuation modules would
    // mean this slice had retired someone else's route — which it must not.
    expect(ROUTES.filter((m) => m.path === "/v1/companies/:companyId/valuation")).toHaveLength(1);
  });
```

- [ ] **Step 8: Run everything and commit**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test reports && bun run --cwd apps/api test inventory-reports && bun run --cwd packages/db test migrate-reversibility && bun run lint:rules`
Expected: PASS. `migrate-reversibility` (0B's generalisation of Plan 0A's test) runs 0042 down and up again; `lintSchema` is unchanged because the file adds no table and no column.

```bash
git add packages/db/migrations/0042_add_inventory_report_index.sql packages/db/migrations/0042.down.sql \
        packages/db/src/reports/stock-on-hand.ts packages/db/src/reports/sales-by-item.ts packages/db/src/index.ts \
        packages/contracts/src/inventory/reports.ts packages/contracts/src/accounting/reports.ts \
        packages/contracts/src/index.ts \
        apps/api/src/routes/accounting/reports.ts \
        packages/db/test/reports/inventory-reports.test.ts \
        apps/api/test/routes/accounting/inventory-reports.test.ts
git commit -m "feat(reports): the three minimal inventory reports on 1B's reports module [3D T10]

inventory.stock_on_hand reads the projection and excludes in-transit rows by default, so
the DoD clause is provable from the report's own output; inventory.valuation is a GET over
3B's valuationAsOf with no second row type; inventory.sales_by_item is delivered quantity
and cost from cost_consumption, the columns 4A extends with revenue under the same code.
Migration 0042 adds one covering index on cost_consumption and nothing else.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Acceptance test 7 — one costing answer for a transferred, override-negative, supplier-returned item

**Part VI test 7 (spec:2425), verbatim:** *"One costing answer. Stock valuation and profit reports tie to the cent for an item that has been transferred, gone negative, and had a supplier return."* Regression source **SAH-009**. This is the only acceptance test this slice **owns**, and it is the reason the slice exists at the end of Phase 3: it needs every earlier slice's machinery and one item that has been through all three excursions.

**Files:**
- Create: `tests/invariants/test-07-one-costing-answer.test.ts`
- Modify: `tests/regression/sah-009.test.ts` (append a `— 3D` block)

**Interfaces:**
- Consumes: `valuationAsOf` (3B); `stockOnHand`, `stockOnHandTotals`, `salesByItem` (Task 10); `openLayersFor` (3B); `postDocument`, `issueDocument`, `transitionDocument`, `reverseDocument` (§4.3.1); `draftTransfer`, `draftTransferReceipt` (Task 7/8), `convertOrderToDelivery` (Task 5), `snapshotCountSheet`, `recordCounts` (Task 8); `secondPrincipal`, `recordingJobs`, `ensureOpenPeriods` (§4.17.1); `recordOverride` (2B); `grantCodes`, `draftTypedDocument`, `seedParty`, `seedBranch` and the 3A seeders (§4.17); `Money`, `Quantity`, `currency` (§4.2.1, 0D — every tie-out sums through these and `currency("MYR")` is what makes `openLayersFor`'s branded `baseCurrency` assignable, contracts:1329); the production `withTenant(sql, ctx, fn)` (§4.2.2 — root `tests/` use the production one, hazard 15).
- Produces: nothing exported. One invariant suite, and the `— 3D` block on `sah-009`.

**Hazard 17 is the binding constraint on how "gone negative" is produced.** F-6 admits exactly one route: an issue that exceeds the open layers, authorised by an `inventory.negative_stock.override` `document_event` written by a **second** principal (§4.5.3). A test that toggles a flag, writes a movement directly or relaxes a trigger is invalid and this suite must not contain one. Task 6 proved the mechanism on one delivery; this suite uses it as one step of a longer story.

**The story, in order, and why this order.** Each step is a real document through the real posting service, and every later figure depends on the earlier ones — which is the whole point of "one costing answer".

| # | Document | Effect | Why it is here |
|---|---|---|---|
| 1 | `GOODS_RECEIPT` 100 @ 4.0000 into WH-HQ | layer A, 400.0000 | the base stock |
| 2 | `SHIPMENT` + landed cost on a second receipt of 50 @ 5.0000 | layer B at a **landed** unit cost above 5.0000 | 3C's DoD clause re-asserted: the landed allocation is in the cost the later steps consume |
| 3 | `TRANSFER` 30 to WH-BR2, then `TRANSFER_RECEIPT` of 28 | 2 units short, 5110 debited | the "transferred" excursion, with a variance so the transfer is not a no-op |
| 4 | `DELIVERY_ORDER` of everything on hand at WH-HQ **plus 5** | the override excursion | the "gone negative" excursion, through the one door |
| 5 | `PURCHASE_RETURN` of 10 from WH-BR2 | an issue against the branch's layer | the "supplier return" excursion (3C's type) |
| 6 | `STOCK_COUNT` at WH-BR2 finding 1 unit short | a variance-only posting | proves the count does not disturb the tie-out |

Steps run in one `beforeAll`, with `recordingJobs()` in place of a real `JobClient` so the back-dated-document rule of 3B's amendment A5 is satisfied without a worker; **no step is back-dated**, so no `inventory.cost.replay` is enqueued and the assertions read the first-pass figures. The last case then back-dates a purchase deliberately and re-runs the tie-outs after the replay, which is the "in bounded time, with a visible adjustment entry" half of 3B's clause.

- [ ] **Step 1: Write the failing suite**

`tests/invariants/test-07-one-costing-answer.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { openLayersFor, valuationAsOf } from "@dulja/db";
import { salesByItem, stockOnHand, stockOnHandTotals } from "@dulja/db";
import { postDocument, issueDocument, transitionDocument } from "@dulja/db";
import { convertOrderToDelivery, draftTransfer, draftTransferReceipt, recordCounts, snapshotCountSheet } from "@dulja/db";
import { allocateLandedCostForDocument, recordOverride, replay } from "@dulja/db";
import { startDb, type Db } from "@dulja/db/test";
import {
  draftTypedDocument, grantCodes, seedAccount, seedBranch, seedDocumentType, seedItem, seedLot,
  seedParty, seedTenantV2, seedUnit, seedWarehouse, type Seed,
} from "@dulja/db/test";
import { currency, Money, Quantity } from "@dulja/domain";
import { ensureOpenPeriods, recordingJobs, secondPrincipal } from "./support/post-inventory";
import { repoFile } from "../support/regression";     // 0C's repo-root-relative reader (§4.17.1)

/** Every figure in this suite is a `Money` or a `Quantity`, never a `number`: the three tie-outs are the
 *  slice's "to the cent" claim and an accumulation through binary doubles can decide them either way. */
const MYR = currency("MYR");

/**
 * Acceptance test 7 (spec:2425) — "Stock valuation and profit reports tie to the cent for an item that has
 * been transferred, gone negative, and had a supplier return." SAH-009.
 *
 * At Phase 3 "profit" is the COST side only: quantity times unit cost from `cost_consumption`. No document
 * type posts revenue before 4A's SALES_INVOICE, so there is no sales value to tie to (hazard 4, and the 3D
 * card says so in the same words). 7B re-runs this test against the revenue-bearing `item_profitability`
 * projection once 4A and 4B exist, under the same report codes.
 */
describe("acceptance test 7 — one costing answer (spec:2425, SAH-009)", () => {
  let db: Db;
  let ctx: { tenantId: string; actorId: string; requestId: string };
  let s: Seed;
  let jobs: ReturnType<typeof recordingJobs>;
  let branchB: string; let whHq: string; let whBr2: string; let whTransit: string;
  let unitId: string; let itemId: string; let lotA: string; let lotB: string;
  let supplierId: string; let customerId: string;
  /** The nine policies this story needs: 3D's six from `packages/db/test/inventory/policies.ts`, plus
   *  3C's `GOODS_RECEIPT`, `SHIPMENT` and `PURCHASE_RETURN` read from the seed pack with `repoFile`.
   *  Declared as one map so the `beforeAll`'s seeding loop is one loop. */
  let TYPES: Record<string, unknown>;
  const typeIds: Record<string, string> = {};
  let shipmentId: string;
  let transfer: { documentId: string; receiptId: string };
  let delivery: { documentId: string };
  let supplierReturn: { documentId: string };
  let count: { documentId: string };
  /** Keeps `countShort`'s two principals and their two role codes distinct across repeat calls. */
  let countShortCalls = 0;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-test-07");
    await ensureOpenPeriods(db, s, 2026);
    await grantCodes(db, s);                              // the human holds every code (R2 inside the tx)
    jobs = recordingJobs();
    ctx = { tenantId: s.tenant, actorId: s.human, requestId: "test-07" };

    for (const a of [
      { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" as const },
      { code: "1300", nameEn: "Inventory control",            type: "asset" as const },
      { code: "1310", nameEn: "Goods in transit",             type: "asset" as const },
      { code: "2150", nameEn: "Goods received not invoiced",  type: "liability" as const },
      { code: "5000", nameEn: "Cost of goods sold",           type: "expense" as const },
      { code: "5100", nameEn: "Inventory write-off — expiry loss", type: "expense" as const },
      { code: "5110", nameEn: "Stock-count variance",         type: "expense" as const },
    ]) {
      await seedAccount(db, s, a);
    }
    branchB   = await seedBranch(db, s, { code: "BR-2", nameEn: "Branch 2" });
    whHq      = await seedWarehouse(db, s, { code: "WH-HQ",     kind: "stock",      branchId: s.hq });
    whBr2     = await seedWarehouse(db, s, { code: "WH-BR2",    kind: "stock",      branchId: branchB });
    whTransit = await seedWarehouse(db, s, { code: "WH-BR2-TR", kind: "in_transit", branchId: branchB });
    unitId    = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, { code: "SKU-07", trackLots: true, baseUnitId: unitId }));
    lotA = await seedLot(db, s, { itemId, code: "LOT-A", expiresOn: "2027-01-31" });
    lotB = await seedLot(db, s, { itemId, code: "LOT-B", expiresOn: "2027-06-30" });
    supplierId = await seedParty(db, s, { code: "SUP-1", kind: "supplier" });
    customerId = await seedParty(db, s, { code: "CUST-1", kind: "customer" });
    // Every policy comes from the seed pack — the six this slice ships and 3C's three — read with 0C's
    // `repoFile` (§4.17.1), because Vitest runs this workspace from `tests/` and a bare relative path
    // never resolves. Reading the pack rather than importing `packages/db/test/inventory/policies.ts`
    // (which is not an export of `@dulja/db/test`) also makes this suite the last place a drift between
    // the shipped file and a test constant could hide: by Task 11 all nine files exist.
    TYPES = Object.fromEntries(
      ["GOODS_RECEIPT", "SHIPMENT", "PURCHASE_RETURN", "SALES_ORDER", "DELIVERY_ORDER",
       "TRANSFER", "TRANSFER_RECEIPT", "STOCK_COUNT", "EXPIRY_WRITE_OFF"].map((code) => [
        code,
        (JSON.parse(repoFile(`packages/db/seed/my/document-types/${code}.json`)) as { policy: unknown }).policy,
      ]),
    );
    for (const [code, policy] of Object.entries(TYPES)) {          // the six 3D policies plus 3C's three
      typeIds[code] = await seedDocumentType(db, s, { code, module: "inventory", policy });
    }

    // ── 1. base stock: 100 @ 4.0000 ──────────────────────────────────────
    await receive(whHq, lotA, "100.000000", "4.0000", "2026-02-01");

    // ── 2. a landed-cost receipt: 50 @ 5.0000 plus 100.0000 of freight ───
    // ONE SHIPMENT carrying both lines, allocated `by_value` while it is still a draft, so layer B's unit
    // cost is 5.0000 + 100.0000/50 = 7.0000. This slice does not compute that — it asserts the figure it
    // inherits from 3C's `allocateLandedCostForDocument` and `receiptValue`.
    shipmentId = await receiveWithLandedCost(whHq, lotB, "50.000000", "5.0000", "100.0000", "2026-02-05");

    // ── 3. transfer 30, receive 28 ───────────────────────────────────────
    transfer = await dispatchAndReceive(whHq, whBr2, "30.000000", "28.000000", "2026-02-10", "2026-02-11");

    // ── 4. deliver everything at WH-HQ plus five, through the override ───
    const hqOnHand = Quantity.of((await totals(whHq)).onShelves);   // 100 + 50 − 30 = 120
    const supervisor = await secondPrincipal(db, s, "supervisor");
    await grantCodes(db, s, { codes: ["inventory.negative_stock.override"], principalId: supervisor, roleCode: "ovr" });
    delivery = await deliverWithOverride(
      hqOnHand.add(Quantity.of("5.000000")).toString(), supervisor, "2026-02-15");

    // ── 5. supplier return of 10 from the branch ─────────────────────────
    supplierReturn = await returnToSupplier(whBr2, "10.000000", "2026-02-20");

    // ── 6. a stock count at the branch finding one unit short ────────────
    count = await countShort(whBr2, "1.000000", "2026-02-25");
  }, 300_000);
  afterAll(async () => { await db?.stop(); });

  it("no replay was enqueued — every document above is forward-dated, so these are first-pass figures", () => {
    expect(jobs.enqueued.filter((j) => j.name === "inventory.cost.replay")).toEqual([]);
  });

  it("TIE-OUT A — Σ valuationAsOf value = the 1300 + 1310 ledger balances, to the cent", async () => {
    // Every tie-out in this suite sums EXACTLY: the SQL side at `numeric` precision returned as `::text`,
    // the report side through `Money.add` / `Quantity.add`. A `reduce((n, r) => n + Number(r.value), 0)`
    // over many `numeric(19,4)` values can differ from the exact total in the fourth decimal place, and
    // `.toFixed(4)` then rounds two accumulations to two different strings — a test whose contract is "to
    // the cent" must not be able to pass or fail on accumulation order (Global Constraints 1 and 4, and
    // §3.7.5's `no-number-money`).
    const { valued, ledger } = await withTenant(db.rw, ctx, async (tx) => {
      const rows = await valuationAsOf(tx, { companyId: s.company, asOf: "2026-12-31", limit: 500 });
      const [bal] = await tx<{ bal: string }[]>`
        select coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::text as bal
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where a.code in ('1300', '1310') and e.company_id = ${s.company}`;
      return {
        valued: rows.reduce((m, r) => m.add(Money.of(r.value, MYR)), Money.zero(MYR)),
        ledger: Money.of(bal!.bal, MYR),
      };
    });
    expect(valued.toString()).toBe(ledger.toString());
  });

  it("TIE-OUT B — Σ valuationAsOf quantity = Σ max(stock_on_hand.quantity, 0), and the negative is the override's", async () => {
    // **Why this identity is over the NON-NEGATIVE projection, and why a later pass must not "fix" it back
    // to `stockOnHandTotals(...).total`.** `valuationAsOf` is derived from the layers (3B), and
    // `app.cost_layer.qty_remaining` carries `check (qty_remaining >= 0)` (§4.7.3, contracts:3060). A
    // negative on-hand therefore has NO layer that can represent it: the five units the override admitted
    // at WH-HQ are a quantity the ledger and the projection both show and the layers structurally cannot.
    // Comparing Σ layers to the raw Σ `stock_on_hand` would be short by exactly those five units — the same
    // asymmetry tie-out C handles on the value side, where the uncovered quantity has no `cost_consumption`
    // row. So the identity is stated over `greatest(quantity, 0)` and the excursion is asserted beside it,
    // rather than hidden inside a figure that cannot balance.
    const { valued, nonNegative, negative } = await withTenant(db.rw, ctx, async (tx) => {
      const rows = await valuationAsOf(tx, { companyId: s.company, asOf: "2026-12-31", limit: 500 });
      const [p] = await tx<{ non_negative: string; negative: string }[]>`
        select coalesce(sum(greatest(h.quantity, 0)), 0)::text as non_negative,
               coalesce(sum(least(h.quantity, 0)), 0)::text    as negative
          from app.stock_on_hand h
         where h.company_id = ${s.company} and h.item_id = ${itemId}`;
      return {
        valued: rows.reduce((q, r) => q.add(Quantity.of(r.quantity)), Quantity.zero()),
        nonNegative: Quantity.of(p!.non_negative),
        negative: Quantity.of(p!.negative),
      };
    });
    expect(valued.toString()).toBe(nonNegative.toString());
    expect(negative.toString()).toBe("-5.000000");        // the override's uncovered five units, and nothing else
  });

  it("TIE-OUT C — the delivered cost report = Σ cost_consumption on the delivery = the 1250 balance", async () => {
    const { reported, consumed, control } = await withTenant(db.rw, ctx, async (tx) => {
      const rows = await salesByItem(tx, { companyId: s.company, fromDate: "2026-01-01", toDate: "2026-12-31", limit: 50 });
      const [c] = await tx<{ v: string }[]>`
        select coalesce(sum(c.value), 0)::text as v
          from app.cost_consumption c
          join app.inventory_movement m on m.id = c.movement_id
         where m.document_id = ${delivery.documentId} and c.invalidated_at is null`;
      const [a] = await tx<{ bal: string }[]>`
        select coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::text as bal
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where a.code = '1250' and e.company_id = ${s.company}`;
      return {
        reported: Money.of(rows[0]!.cost, MYR), consumed: Money.of(c!.v, MYR), control: Money.of(a!.bal, MYR),
      };
    });
    expect(reported.toString()).toBe(consumed.toString());
    expect(reported.toString()).toBe(control.toString());
  });

  it("the override's uncovered five units carry quantity but NO cost, on both sides of tie-out C", async () => {
    // `cost_consumption.layer_id` is NOT NULL (§4.7.3), so the five units no layer covered have no
    // consumption row. They therefore contribute to `deliveredQuantity` and not to `cost`, and the 1250
    // debit is the covered value alone — which is why tie-out C holds rather than being off by five units'
    // worth of a cost that does not exist. This asymmetry is 3B's golden fixture to define; this case is
    // the assertion that 3D reports it consistently on every surface.
    const { rows, layersLeft } = await withTenant(db.rw, ctx, async (tx) => ({
      rows: await salesByItem(tx, { companyId: s.company, fromDate: "2026-01-01", toDate: "2026-12-31", limit: 50 }),
      // `baseCurrency` is the branded `CurrencyCode` 3B's signature declares (contracts:1329), not a bare
      // `"MYR"` — `currency("MYR")` is what makes it assignable.
      layersLeft: await openLayersFor(tx, { companyId: s.company, itemId, warehouseId: whHq, baseCurrency: MYR }),
    }));
    expect(rows[0]!.deliveredQuantity).toBe("125.000000");      // 120 covered + 5 uncovered
    expect(layersLeft.every((l) => l.qtyRemaining.isZero())).toBe(true);
    // Task 5's FEFO split put the uncovered five units on their own line against the item's `NONE` sentinel
    // lot, so WH-HQ has one `stock_on_hand` row per lot (LOT-A 0, LOT-B 0, NONE −5). Sum them: a single-row
    // read would return whichever key the planner produced first.
    const [soh] = await withTenant(db.rw, ctx, (tx) => tx<{ q: string }[]>`
      select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
       where company_id = ${s.company} and item_id = ${itemId} and warehouse_id = ${whHq}`);
    expect(soh!.q).toBe("-5.000000");                           // genuinely negative, and visibly so
  });

  it("the landed cost is IN the tie-out — layer B's unit cost is 7.0000, not 5.0000 (3C's DoD clause)", async () => {
    const layers = await withTenant(db.rw, ctx, (tx) => tx<{ unit_cost: string; qty_in: string }[]>`
      select l.unit_cost::text, l.qty_in::text
        from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
       where m.document_id = ${shipmentId} order by l.sequence`);
    expect(layers.map((l) => l.unit_cost)).toEqual(["7.0000"]);
  });

  it("the transfer's 2-unit shortfall is in 5110 and the corridor cleared to zero", async () => {
    const { variance, transit } = await withTenant(db.rw, ctx, async (tx) => {
      const [v] = await tx<{ bal: string }[]>`
        select coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::text as bal
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where a.code = '5110' and e.document_id = ${transfer.receiptId}`;
      const [t] = await tx<{ q: string }[]>`
        select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
         where company_id = ${s.company} and item_id = ${itemId} and warehouse_id = ${whTransit}`;
      return { variance: Money.of(v!.bal, MYR), transit: Quantity.of(t!.q) };
    });
    expect(transit.isZero()).toBe(true);
    expect(variance.isPositive()).toBe(true);  // a loss, debited — the exact figure is the AVCO unit cost × 2
  });

  it("the supplier return consumed the BRANCH's layers, not head office's", async () => {
    const rows = await withTenant(db.rw, ctx, (tx) => tx<{ warehouse_id: string; quantity: string }[]>`
      select m.warehouse_id, m.quantity::text
        from app.inventory_movement m where m.document_id = ${supplierReturn.documentId}`);
    expect(rows).toEqual([{ warehouse_id: whBr2, quantity: "-10.000000" }]);
  });

  it("the stock count posted ONE movement and did not disturb either tie-out", async () => {
    const movements = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.inventory_movement where document_id = ${count.documentId}`);
    expect(movements[0]!.n).toBe(1);
    // …and tie-outs A and B are re-asserted here, after the count, by calling the same two helpers.
  });

  it("a BACK-DATED purchase recosts forward only, and both tie-outs hold again afterwards", async () => {
    // 3B's DoD clause, and the reason test 7 is the LAST costing test: the answer must survive a replay.
    await receive(whHq, lotA, "20.000000", "9.0000", "2026-02-03");    // before steps 3-6
    const replayJobs = jobs.enqueued.filter((j) => j.name === "inventory.cost.replay");
    expect(replayJobs).toHaveLength(1);
    expect(replayJobs[0]!.singletonKey).toBe(s.company);
    await runReplayToCompletion();                                     // drains the recorded job through 3B's `replay`
    const adjustments = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document d join app.document_type t on t.id = d.document_type_id
       where t.code = 'COST_ADJUSTMENT' and d.status = 'posted'`);
    expect(adjustments[0]!.n).toBeGreaterThan(0);                      // the "visible adjustment entry"
    // Tie-outs A, B and C re-asserted verbatim: one costing answer, after a recost.
  });
});
```

**The eight helpers, written out.** All eight are **file-local** — §4.17 assigns 3D no `fixtures.ts` row and §4.17.1 assigns it one word, so a shared helper here would be hazard 9. They go above the `describe`'s `beforeAll`, inside the `describe` so they close over `db`, `s`, `ctx` and the ids.

```ts
  /** A GOODS_RECEIPT of `qty` at `unitCost` into `warehouseId`/`lotId` — the only way stock legitimately
   *  exists (hazard 22). `amount` is computed with `Money`, never `Number(qty) * Number(cost)`. */
  async function receive(
    warehouseId: string, lotId: string, qty: string, unitCost: string, effectiveDate: string,
  ): Promise<string> {
    const amount = Money.of(unitCost, MYR).multiply(Quantity.of(qty).toDecimal(), "HALF_AWAY_FROM_ZERO");
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: typeIds.GOODS_RECEIPT!, series: "GRN", effectiveDate,
      partyId: supplierId, warehouseId,
      lines: [{ kind: "item", itemId, warehouseId, lotId, unitId, quantity: qty,
                unitPrice: unitCost, amount: amount.toString() }],
    });
    await withTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId }));
    return documentId;
  }

  /** A SHIPMENT carrying the goods line **and** the freight line, allocated `by_value` before it posts, so
   *  the layer's unit cost is `unitCost + freight ÷ qty`.
   *
   *  **This is 3C's mechanism, and it is not a link.** Landed cost is *one* document: 3C's `SHIPMENT` is
   *  `GOODS_RECEIPT`'s four rules with the same accounts (3c:3914), the freight arrives as an `account`
   *  line on that same document, and `allocateLandedCostForDocument(tx, ctx, { documentId, allocations })`
   *  upserts the (cost line × goods line) shares while the document is still a **draft** (3c:3042, and the
   *  draft-only rule is migration 0038's trigger). `app.document_link` has no allocation `LinkKind` —
   *  §4.18's list is `"fulfils" | "converts_to" | "receives_against" | "returns" | "settles"` (3c:1493) —
   *  so an earlier draft of this helper that linked a freight-only SHIPMENT to a separate receipt was
   *  inventing a sixth kind and a second document. Returns the SHIPMENT's id: it is the receipt, and its
   *  layer is what the landed-cost case reads.
   *
   *  The freight line's account is `5900` other operating expense — 0C's, and the account `seedItem`
   *  already creates (3a:885–890) — because the SHIPMENT policy debits `1300` and credits `line.account`
   *  for every `account` line (3c:290), so the credit needs an account that resolves. */
  async function receiveWithLandedCost(
    warehouseId: string, lotId: string, qty: string, unitCost: string, freight: string, effectiveDate: string,
  ): Promise<string> {
    const goods = Money.of(unitCost, MYR).multiply(Quantity.of(qty).toDecimal(), "HALF_AWAY_FROM_ZERO");
    const [freightAccount] = await withTenant(db.rw, ctx, (tx) => tx<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '5900'`);
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId: typeIds.SHIPMENT!, series: "SHP", effectiveDate, partyId: supplierId, warehouseId,
      lines: [
        { kind: "item", itemId, warehouseId, lotId, unitId, quantity: qty,
          unitPrice: unitCost, amount: goods.toString() },
        { kind: "account", accountId: freightAccount!.id, description: "ocean freight and duty", amount: freight },
      ],
    });
    await withTenant(db.rw, ctx, async (tx) => {
      // Allocated on the DRAFT, before the post: `receiptValue(line, landedCost, rate)` is what turns
      // `line.amount + Σ allocated` into the layer's value (3c:231), so an allocation written after the
      // post would change nothing at all.
      await allocateLandedCostForDocument(tx, ctx, {
        documentId, allocations: [{ costLineId: lineIds[1]!, method: "by_value" }],
      });
      await issueDocument(tx, ctx, { documentId });
      await postDocument(tx, ctx, { documentId });
    });
    return documentId;
  }

  /** Dispatch `dispatched` from `from` to `to`, then receive `received` — the two-step transfer end to end.
   *  **`lotId` is explicit.** `TransferInput.lines[].lotId` is optional and `applyMovements` resolves a null
   *  lot to the item's `NONE` sentinel (SAH-050), which holds nothing, so a lot-tracked item transferred
   *  without a lot raises ERR_STOCK_INSUFFICIENT before step 4 of the story is ever reached (3A's own
   *  assumption 7 says so in those words). */
  async function dispatchAndReceive(
    from: string, to: string, dispatched: string, received: string,
    dispatchDate: string, receiveDate: string,
  ): Promise<{ documentId: string; receiptId: string }> {
    return withTenant(db.rw, ctx, async (tx) => {
      const d = await draftTransfer(tx, ctx, {
        fromWarehouseId: from, toWarehouseId: to, effectiveDate: dispatchDate, series: "TRF",
        documentTypeId: typeIds.TRANSFER!,
        lines: [{ itemId, unitId, lotId: lotA, quantity: dispatched }],
      });
      await issueDocument(tx, ctx, { documentId: d.documentId });
      await postDocument(tx, ctx, { documentId: d.documentId });

      const r = await draftTransferReceipt(tx, ctx, {
        transferDocumentId: d.documentId, documentTypeId: typeIds.TRANSFER_RECEIPT!, series: "TRR",
        effectiveDate: receiveDate,
        received: [{ transferLineId: d.lineIds[0]!, countedQuantity: received }],
      });
      await issueDocument(tx, ctx, { documentId: r.documentId });
      await postDocument(tx, ctx, { documentId: r.documentId });
      return { documentId: d.documentId, receiptId: r.documentId };
    });
  }

  /** A DELIVERY_ORDER of `qty` out of WH-HQ, admitted past `assert_stock_available` by an
   *  `inventory.negative_stock.override` event attributed to `supervisor`.
   *
   *  Three things this must get exactly right, each of which fails the suite in a way that looks like a
   *  different bug:
   *  1. The ctx is the SAME `s.human` ctx the document was created under, and the supervisor is the
   *     **attributed** principal. `document_event.actor_id` defaults to `app.current_actor()` (3b:2631-2634),
   *     so it is `s.human` however the ctx is flavoured, and `assert_override_authorised` refuses when
   *     `coalesce(attributed_to, actor_id)` equals `created_by` (§4.5.3). A supervisor-flavoured ctx with no
   *     `attributedTo` raises ERR_OVERRIDE_NOT_AUTHORISED and step 4 never happens.
   *  2. The event is inserted BEFORE `postDocument`: `assert_stock_available` fires inside it.
   *  3. It drafts through `draftTypedDocument` + `convertOrderToDelivery`, NOT through 3B's
   *     `postInventoryDocument` — that helper takes no `partyId` and DELIVERY_ORDER declares
   *     `requires: ["party", "warehouse"]`, so `validateRequires` would refuse at post. That is the exact
   *     reason Task 0's amendment 12 exports `secondPrincipal` instead of reaching for `postOverriddenIssue`. */
  async function deliverWithOverride(
    qty: string, supervisor: string, effectiveDate: string,
  ): Promise<{ documentId: string }> {
    const extended = Money.of("9.0000", MYR).multiply(Quantity.of(qty).toDecimal(), "HALF_AWAY_FROM_ZERO");
    const order = await draftTypedDocument(db, s, {
      documentTypeId: typeIds.SALES_ORDER!, series: "SO", effectiveDate, partyId: customerId, warehouseId: whHq,
      lines: [{ kind: "item", itemId, warehouseId: whHq, unitId, quantity: qty,
                unitPrice: "9.0000", amount: extended.toString() }],
    });
    return withTenant(db.rw, ctx, async (tx) => {
      await issueDocument(tx, ctx, { documentId: order.documentId });
      const { documentId } = await convertOrderToDelivery(tx, ctx, {
        sourceDocumentId: order.documentId, targetDocumentTypeId: typeIds.DELIVERY_ORDER!,
        targetSeries: "DO", effectiveDate, warehouseId: whHq, fefo: true,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: qty }],
      });
      await issueDocument(tx, ctx, { documentId });
      await recordOverride(tx, ctx, {
        documentId, code: "inventory.negative_stock.override",
        reason: "customer collection, count pending", attributedTo: supervisor,
      });
      await postDocument(tx, ctx, { documentId });
      return { documentId };
    });
  }

  /** 3C's PURCHASE_RETURN of `qty` from `warehouseId` — an issue against that warehouse's own layers. */
  async function returnToSupplier(
    warehouseId: string, qty: string, effectiveDate: string,
  ): Promise<{ documentId: string }> {
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: typeIds.PURCHASE_RETURN!, series: "PRT", effectiveDate,
      partyId: supplierId, warehouseId,
      lines: [{ kind: "item", itemId, warehouseId, lotId: lotA, unitId, quantity: qty,
                unitPrice: "4.0000", amount: "0.0000" }],
    });
    await withTenant(db.rw, ctx, async (tx) => {
      await issueDocument(tx, ctx, { documentId });
      await postDocument(tx, ctx, { documentId });
    });
    return { documentId };
  }

  /** A STOCK_COUNT at `warehouseId` finding the first sheet line `short` units light. The R1 pair is real:
   *  the counter drafts and submits, a second principal approves, issues and posts. */
  async function countShort(
    warehouseId: string, short: string, effectiveDate: string,
  ): Promise<{ documentId: string }> {
    // A monotonic counter, not the date: a `roleCode` is a slug, and embedding `2026-02-25` in one bets on
    // whatever pattern 2B's `grantCodes` applies to it. The label is only there to keep repeat calls apart.
    countShortCalls += 1;
    const n = countShortCalls;
    const counter = await secondPrincipal(db, s, `count-maker-${n}`);
    const checker = await secondPrincipal(db, s, `count-checker-${n}`);
    await grantCodes(db, s, { codes: ["inventory.count.create"], principalId: counter, roleCode: `count-maker-${n}` });
    await grantCodes(db, s, { codes: ["inventory.adjustment.approve"], principalId: checker, roleCode: `count-checker-${n}` });
    const counterCtx = { tenantId: s.tenant, actorId: counter, requestId: `count-${n}` };
    const checkerCtx = { tenantId: s.tenant, actorId: checker, requestId: `approve-${n}` };

    const sheet = await withTenant(db.rw, counterCtx, (tx) => snapshotCountSheet(tx, counterCtx, {
      documentTypeId: typeIds.STOCK_COUNT!, series: "SC", effectiveDate, warehouseId,
    }));
    const line = sheet.lines[0]!;
    const counted = Quantity.of(line.expectedQuantity).subtract(Quantity.of(short));
    await withTenant(db.rw, counterCtx, (tx) => recordCounts(tx, counterCtx, {
      documentId: sheet.documentId,
      counts: [{ documentLineId: line.documentLineId, countedQuantity: counted.toString() }],
    }));
    await withTenant(db.rw, counterCtx, (tx) =>
      transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" }));
    await withTenant(db.rw, checkerCtx, async (tx) => {
      await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" });
      await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "issued" });
      await postDocument(tx, checkerCtx, { documentId: sheet.documentId });
    });
    return { documentId: sheet.documentId };
  }

  /** `stockOnHandTotals` for this item at one warehouse's company — THREE figures from ONE query (Task 10),
   *  so `onShelves` and `total` cannot be read at two different instants and report a total that never
   *  existed. The `warehouseId` argument is what the caller is asking about; the totals are company-wide,
   *  which is what the definition-of-done clause's second half is about. */
  async function totals(_warehouseId: string): Promise<{ onShelves: string; inTransit: string; total: string }> {
    return withTenant(db.rw, ctx, (tx) => stockOnHandTotals(tx, { companyId: s.company, itemId }));
  }

  /** Drains the `inventory.cost.replay` jobs `recordingJobs()` captured, through 3B's own `replay`, until
   *  none is left — the reason this suite needs no worker process. `replay` runs as many short transactions
   *  (spec:1368) and may enqueue a continuation, so this is a loop and not one call.
   *
   *  Three shapes taken from 3B rather than assumed. (1) `recordingJobs()` returns
   *  `JobClient & { readonly enqueued: readonly RecordedJob[] }` (3b:2294) and a `RecordedJob` is
   *  `{ name, payload, singletonKey }` (3b:2458) — **readonly, with no place to mark one drained**, so the
   *  drained set is a local `Set` of indices. (2) `replay(sql, job, ctx)` takes a **`JobEnvelope`**, not a
   *  bare payload — `{ tenantId, requestId, payload }` (contracts:1707) — so the envelope is rebuilt here.
   *  (3) The argument order is `(sql, job, ctx)` (3b:4050), not `(tx, ctx, payload)`. */
  async function runReplayToCompletion(): Promise<void> {
    const drained = new Set<number>();
    for (let guard = 0; guard < 50; guard += 1) {
      const index = jobs.enqueued.findIndex(
        (j, i) => j.name === "inventory.cost.replay" && !drained.has(i));
      if (index === -1) return;
      drained.add(index);
      const job = jobs.enqueued[index]!;
      await withTenant(db.rw, ctx, (tx) =>
        replay(tx, { tenantId: s.tenant, requestId: `replay-${index}`, payload: job.payload as { companyId: string } }, ctx));
    }
    throw new Error("inventory.cost.replay did not converge in 50 batches — that is 3B's bounded-time clause");
  }
```

`replay` (3B) and `allocateLandedCostForDocument` (3C) are in the import block above. Every one of these helpers takes its neighbours' shapes from the written plans rather than from this plan's prose — `replay`'s `(sql, job: JobEnvelope, ctx)` order, `RecordedJob`'s three readonly members, `LinkKind`'s five values, `AllocateLandedCostInput`'s `{ documentId, allocations }` and `app.audit_log`'s lower-case `action` — because every one of them was got wrong in an earlier draft and each is a `beforeAll` failure that reads like a costing bug.

**Three things the helpers must get exactly right, because each one fails the suite in a way that looks like a different bug.**

1. **`deliverWithOverride`'s override event takes the shape Task 6 Step 1 shows, and only that shape:** `recordOverride(tx, ctx, { documentId, code: "inventory.negative_stock.override", reason, attributedTo: supervisor })` — the ctx is the **same `s.human` ctx the document was created under**, and the supervisor is the **attributed** principal. `document_event.actor_id` defaults to `app.current_actor()`, so it is `s.human` however the ctx is flavoured (3b:2631–2634), and `assert_override_authorised` refuses when `coalesce(attributed_to, actor_id)` equals `created_by` (§4.5.3). Handing it a supervisor-flavoured ctx with no `attributedTo` raises `ERR_OVERRIDE_NOT_AUTHORISED` and step 4 of the story never happens.
2. **`dispatchAndReceive` and `countShort` pass an explicit `lotId`.** `TransferInput.lines[].lotId` is optional and `applyMovements` resolves a null lot to the item's `NONE` sentinel (SAH-050) — and 3A's own assumption 7 says an issue with no lot then "usually fails loudly on `ERR_STOCK_INSUFFICIENT` because the sentinel holds nothing". `SKU-07` is lot-tracked with `LOT-A` and `LOT-B`, so a transfer drafted without a lot raises before the override step is reached. Pass `lotA`.
3. **`totals` is `stockOnHandTotals`**, whose three figures come from one query (Task 10), so `onShelves` and `total` cannot be read at two different instants.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test tests/invariants/test-07-one-costing-answer.test.ts`
Expected: FAIL — the `beforeAll` completes and **tie-out C** is the first content failure, reporting `reported` as the full 125 units' worth of cost against a `1250` balance covering 120: the uncovered quantity has no consumption row, so the two figures differ until `salesByItem`'s `left join` is in place (Task 10 Step 5). If tie-out **A** fails instead, the discrepancy is a real one between `valuationAsOf` and the ledger and it belongs to whichever slice owns the account the difference lands in — read the failure's per-account breakdown before touching anything. If tie-out **B** fails by exactly `5.000000`, someone has restated it against `stockOnHandTotals(...).total`: `qty_remaining >= 0` means the layers cannot carry the override's negative, and the case's own comment says so — restore the `greatest(quantity, 0)` form rather than adjusting the expectation.

- [ ] **Step 3: Append the `— 3D` block to `tests/regression/sah-009.test.ts`**

3B created the file. This slice appends the "one answer across three excursions" block:

```ts
describe("SAH-009 One costing answer across a transfer, an override and a return — 3D", () => {
  it("exactly one module computes a valuation, and every report imports it", async () => {
    // The legacy system recomputed stock value in four places with three different answers. Here
    // `valuationAsOf` is the one read (spec:1228) and `costingEngine` the one calculator.
    const files = await sourceFiles("packages/db/src");
    const recomputers = files.filter((f) =>
      /qty_remaining\s*\*\s*unit_cost/.test(f.text) && !f.path.startsWith("packages/db/src/costing/"));
    expect(recomputers.map((f) => f.path)).toEqual([]);
  });

  it("the three inventory reports read the projections and the consumptions, never a second arithmetic", async () => {
    const soh = await repoFile("packages/db/src/reports/stock-on-hand.ts");
    const sbi = await repoFile("packages/db/src/reports/sales-by-item.ts");
    expect(soh).toMatch(/app\.stock_on_hand/);
    expect(soh).not.toMatch(/from app\.inventory_movement/);
    expect(sbi).toMatch(/app\.cost_consumption/);
    expect(sbi).not.toMatch(/unit_cost\s*\*/);            // no re-multiplication anywhere
  });
});
```

- [ ] **Step 4: Run everything and commit**

Run: `bun run test tests/invariants/test-07-one-costing-answer.test.ts && bun run test tests/regression/sah-009.test.ts && bun run --cwd packages/db test costing`
Expected: PASS — **ten** cases in the acceptance suite (no-replay-enqueued, tie-outs A, B and C, the override's uncovered units, the landed cost, the transfer shortfall, the supplier return, the stock count, and the back-dated recost — the last of which runs the replay and re-asserts all three tie-outs), both new `sah-009` cases, and 3B's costing suites unchanged.

```bash
git add tests/invariants/test-07-one-costing-answer.test.ts tests/regression/sah-009.test.ts
git commit -m "test: acceptance test 7 - one costing answer (spec:2425) [3D T11]

One item through a landed-cost receipt, a two-step transfer with a shortfall, an
override-authorised negative delivery, a supplier return and a stock count. Three tie-outs
to the cent: valuation vs 1300+1310, valuation quantity vs stock_on_hand, delivered cost vs
cost_consumption vs 1250. The override's uncovered quantity carries no consumption row and
therefore no cost, consistently on every surface. Re-asserted after a back-dated recost.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: ⚠️ OD-05 — the Multi-branch stock row of §3.0.3

**Owner decision OD-05 (§2.12): "Confirmation of every ⚠️ row in §3.0.3 and §3.0.4" — spec:38, 1014, 1036, 2404. Default: the spec text as written.** For this slice OD-05 touches exactly **one** row, spec:1021:

> **Multi-branch stock** — "Warehouse per branch, transfers between them, stock and margin visible per branch" (legacy: `Warehouses` (tree), `MunIsTrans`).

**Owner provides:** confirmation of that sentence, and the answers to the three questions the sentence leaves open. **Verify:** the confirmation is attached to this task in the issue tracker; `ls docs/owner/od-05/3d/` shows one file. **Until provided:** nothing is blocked — Tasks 7, 8 and 10 are already built to the default, and this task is the record of what was assumed and what changes if the owner says otherwise.

**The three open questions, with the assumption each is built on.**

| Question | Built assumption | Where it lives |
|---|---|---|
| Is a two-step transfer with an explicit in-transit state wanted, or is a one-step "move stock now" transfer enough? | **Two-step**, because spec:1053 is a §3.0.4 row of its own and the Phase 3 DoD names the in-transit clause | `TRANSFER` + `TRANSFER_RECEIPT` (Tasks 7, 8) |
| One in-transit warehouse per receiving branch, or per (source, destination) pair? | **Per receiving branch** — ADR 0043 | `resolveInTransitWarehouse` (Task 7) |
| Is a receipt variance a routine event that posts to a loss account, or an exception that must be investigated before the receipt is accepted? | **Routine, posted to `5110`.** spec:1053's "variance on receipt" states no workflow, and blocking a receipt would leave stock in transit indefinitely | `TRANSFER_RECEIPT`'s four ledger rules (Task 8) |

- [ ] **Step 1: Record the assumption, or the owner's answer**

Write `docs/decisions/od-05-3d-multi-branch-stock.md` with the row's text, the three questions, the assumption taken for each, and either the owner's confirmation or the date the request was sent. This is a decision record, not an ADR: it decides nothing, it records what the plan assumed while waiting.

- [ ] **Step 2: If OD-05 is confirmed as written — do nothing else**

Tick this step, note "OD-05 confirmed; no change" in the decision record, and move to Task 13. Every artefact is already the default.

- [ ] **Step 3: If the owner rejects the two-step transfer — the exact reversal**

Only these files change, and nothing else in the slice does:

- `packages/db/seed/my/document-types/TRANSFER.json` — `inventory.to_warehouse` becomes `"header.to_warehouse"` pointing at the **destination** warehouse, and the `1310` leg pair is deleted (a one-step move debits and credits the item's inventory account at the two warehouses, which nets to nothing in the ledger and is exactly why `1310` exists only for the two-step form).
- `packages/db/seed/my/document-types/TRANSFER_RECEIPT.json` — **deleted**, and its §4.14 row struck. A one-step transfer has no receipt.
- `packages/db/src/inventory/transfer.ts` — `resolveInTransitWarehouse` and `draftTransferReceipt` deleted; `draftTransfer` sets `to_warehouse_id` to the destination and drops the `custom_fields.final_warehouse_id` write.
- `packages/db/test/inventory/transfer.test.ts` — the two in-transit cases and the DoD case are replaced by a single "source down, destination up, company total unchanged" case; `transfer-receipt.test.ts` is deleted.
- Task 10's `includeInTransit` parameter and `stockOnHandTotals`' `inTransit` member stay: `warehouse.kind = 'in_transit'` is 3A's column and other slices may still use it.
- **The Phase 3 definition of done changes**, and that is the owner's to accept: "goods in transit are in neither warehouse's on-hand and in the company's total" has no meaning without an in-transit state. Escalate rather than reinterpreting the clause.

- [ ] **Step 4: If the owner wants a blocking variance instead of a posted one**

`TRANSFER_RECEIPT`'s `approval` gains `required: true` with `approve: "inventory.adjustment.approve"`, so a receipt whose counted quantity differs needs the accountant — and **only that**. The four ledger rules, the two-quantity movement and `5110` are unchanged: a variance still posts, it just posts later. `draftTransferReceipt` needs no change at all, because the transition is the caller's.

- [ ] **Step 5: Commit the record**

```bash
git add docs/decisions/od-05-3d-multi-branch-stock.md
git commit -m "docs(decisions): record the OD-05 assumption for slice 3D [3D T12]

The Multi-branch stock row (spec:1021) is built as written: a two-step transfer through one
in-transit warehouse per receiving branch, with a routine receipt variance posted to 5110.
The record states exactly which files revert under each alternative answer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: ⚠️ OD-24 — the transfer, count and stock-on-hand screens

**Owner decision OD-24 (§2.12): "Screenshots + operator description before any screen" — spec:79, 108, 2408. Default: the screen task is blocked, not the slice.** spec:79 and spec:108 state that the UI is not specified, and hazard 29 forbids inventing a workflow.

**Owner provides:** screenshots of the three legacy screens an operator uses for these jobs — the branch transfer entry, the stock count sheet and the stock enquiry — and a **two-minute description per screen** of what the operator does, in order, including which keys they press. **Verify:** run `ls -1 docs/owner/od-24/3d/` and confirm six files — `transfers.png`, `stock-count.png`, `stock-on-hand.png` and one `.md` transcript each. **Until provided:** Steps 2 onward do not run; the slice ships with the API and no screens, and Tasks 5–11 are the deliverable an operator's own tooling can already drive.

**Steps 2–6 carry real code against a stated default layout**, on 3A's terms and for 3A's reason: hazard 29 blocks the *screen*, not the ability to write one, and if the owner's material shows a different workflow only the three `.tsx` files and their tests change — `transfer-api.ts` below does not.

**The stated default layout, so a reviewer can compare it to the owner's material.** 3A's two-pane list-and-detail with 0E Task 4's keyboard model, unchanged (`/` filters, `↑`/`↓` move the selection, `Enter` opens, `Ctrl+S` saves, `Esc` reverts, `Ctrl+N` starts a new row), plus **one addition this slice needs**: the count sheet is a *grid* whose only editable column is the counted quantity, and `Enter` moves down that column rather than opening a detail pane — a counter walks a shelf and types figures, and a screen that made them reach for a mouse between rows would be unusable. `Tab` still moves across. **The expected quantity is not shown on the count screen and not in its API response** for the reason the runbook gives: a counter who can see the expected figure will confirm it.

**Files:**
- Create: `apps/backoffice/src/lib/transfer-api.ts`
- Create: `apps/backoffice/src/routes/inventory/transfers.tsx`, `stock-count.tsx`, `reports.stock-on-hand.tsx`
- Create: `apps/backoffice/test/inventory-transfers.test.tsx`, `inventory-stock-count.test.tsx`
- Create: `tests/e2e/inventory-transfers.spec.ts`
- Modify: `apps/backoffice/src/router.tsx` (three routes), `src/components/app-shell.tsx` (three nav entries), `packages/i18n/src/locales/en.json` and `ar.json`

**Interfaces:**
- Consumes: `createAdminApi`, `AdminApi` (0E — `get(path, schema)` / `send(method, path, body, schema)`, the schema always a parameter); `AppShell`, `DirectionProvider`, the keyboard primitives, `useT` (0E, `packages/ui`, `packages/i18n`); `createRoute`, `router` (0E); `createInventoryApi` (3A — extended by composition, never edited); `ConvertDocumentBody`, `ConvertResultSchema`, **`TransferDraftBody`, `TransferReceiptBody`, `TransferDraftSchema`** (Task 7's `packages/contracts/src/inventory/transfer.ts`, extended by Task 8), `CountSheetBody`, `RecordCountsBody`, `CountSheetResultSchema`, `StockOnHandReportList` (Tasks 5, 7, 8, 10); `bootLocalStack`, `grantAdminRole` (0E, `tests/e2e/support/boot.ts`).
- Produces: `export interface TransferApi { draftTransfer; receiveTransfer; listInTransit; countSheet; recordCounts; readCountSheet; stockOnHand }` and `export function createTransferApi(api: AdminApi, companyId: string): TransferApi`; `TransfersRoute`, `StockCountRoute`, `StockOnHandRoute`; three `createRoute` entries at `/inventory/transfers`, `/inventory/stock-count`, `/inventory/reports/stock-on-hand`.

- [ ] **Step 1: The gate — confirm the owner's material is attached, or stop**

Run: `ls -1 docs/owner/od-24/3d/`
Expected: the six files above. **If the directory is missing or incomplete: stop here.** Record "OD-24 unanswered for 3D; screens deferred" in the task, leave Steps 2–6 unchecked, and ship the slice — nothing in Tasks 0–12 or 14 depends on this task. Do not substitute a guess.

- [ ] **Step 2: Write `apps/backoffice/src/lib/transfer-api.ts`**

The typed fetch layer the three screens share, in 3A's shape: one method per endpoint, every path built here so a typo is a compile error rather than a runtime 404, and every Zod schema passed to 0E's `AdminApi` as a parameter. `Idempotency-Key` is set by `AdminApi.send` for every unsafe method (0E Task 5), so no screen can forget it.

```ts
export function createTransferApi(api: AdminApi, companyId: string): TransferApi {
  const base = `/v1/companies/${companyId}`;
  return {
    draftTransfer: (body) => api.send("POST", `${base}/documents/transfers`, body, TransferDraftSchema),
    receiveTransfer: (transferId, body) =>
      api.send("POST", `${base}/documents/${transferId}/receipt`, body, TransferDraftSchema),
    listInTransit: (query) => api.get(`${base}/reports/inventory.stock_on_hand?includeInTransit=true&${query}`, StockOnHandReportList),
    countSheet: (body) => api.send("POST", `${base}/documents/count-sheet`, body, CountSheetResultSchema),
    recordCounts: (documentId, body) =>
      api.send("PATCH", `${base}/documents/${documentId}/counts`, body, CountSheetResultSchema),
    readCountSheet: (documentId) => api.get(`${base}/documents/${documentId}/count-sheet`, CountSheetResultSchema),
    stockOnHand: (query) => api.get(`${base}/reports/inventory.stock_on_hand?${query}`, StockOnHandReportList),
  };
}
```

- [ ] **Step 3: Write the three screens**

`transfers.tsx` — two panes: the in-transit worklist (every `warehouse.kind = 'in_transit'` row, grouped by receiving branch, oldest dispatch first) on the inline-start side, and on the other a form that is either a new dispatch or the receipt of the selected row. The receipt form's counted-quantity field defaults to the dispatched quantity, so the common case is `Ctrl+S` with no typing, and a shortfall is a deliberate edit.

`stock-count.tsx` — the grid. One row per sheet line showing item code, lot code, expiry and **one editable column**. `Enter` commits the cell and moves down; `Ctrl+S` sends the accumulated edits as one `PATCH`; the submit action is a separate, confirmed command because a submitted sheet cannot be edited (Task 8's `recordCounts` refuses a non-draft).

`reports.stock-on-hand.tsx` — the report view, with an explicit "include goods in transit" toggle whose default is off, mirroring `StockOnHandReportParams.includeInTransit`. The `warehouseKind` column is always shown when the toggle is on, so a reader can never mistake a corridor row for shelf stock.

Every user-facing string goes through `useT` with an ICU message; `packages/i18n/src/locales/en.json` and `ar.json` both gain the complete `inventory.transfer.*` and `inventory.count.*` key sets before merge (spec:2061).

- [ ] **Step 4: Write the component tests**

`apps/backoffice/test/inventory-transfers.test.tsx` and `inventory-stock-count.test.tsx`, against a mocked `TransferApi`: the receipt form pre-filling the dispatched quantity; a shortfall producing the right `counted_quantity` in the request body; the count grid's `Enter`-moves-down behaviour; the count grid rendering **no** expected-quantity column; and every interactive element reachable by keyboard alone (no `onClick` without a corresponding key handler).

- [ ] **Step 5: Re-run acceptance test 23 in both directions**

`tests/e2e/inventory-transfers.spec.ts` — Playwright, against `bootLocalStack`, each screen rendered in `en` (LTR) and `ar` (RTL): no horizontal overflow, the count grid's column order mirrored, Arabic-Indic numerals rendered per the locale, and the same keyboard walk completing in both. This is 3D's re-run of **test 23** (spec:2441); 3A's `inventory-screens.spec.ts` is a separate file and is not edited.

- [ ] **Step 6: Commit**

```bash
git add apps/backoffice/src/lib/transfer-api.ts \
        apps/backoffice/src/routes/inventory/transfers.tsx \
        apps/backoffice/src/routes/inventory/stock-count.tsx \
        apps/backoffice/src/routes/inventory/reports.stock-on-hand.tsx \
        apps/backoffice/src/router.tsx apps/backoffice/src/components/app-shell.tsx \
        apps/backoffice/test/inventory-transfers.test.tsx \
        apps/backoffice/test/inventory-stock-count.test.tsx \
        packages/i18n/src/locales/en.json packages/i18n/src/locales/ar.json \
        tests/e2e/inventory-transfers.spec.ts
git commit -m "feat(backoffice): transfer, stock-count and stock-on-hand screens [3D T13]

Built against the owner's OD-24 material. The count sheet is a keyboard grid whose only
editable column is the counted quantity and which never shows the expected figure; the
transfer screen's worklist is the in-transit stock per receiving branch. Test 23 re-run in
both text directions.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Phase 3 exit — the re-run matrix, the pinned lists, the staging re-seed and the phase report

3D is the last slice of Phase 3, so this task is the phase gate: every clause of the Phase 3 definition of done green in CI, every acceptance test the phase owns passing, every cross-cutting test re-run over this slice's rows and codes, and the written phase report spec:110 requires.

**Files:**
- Create: `docs/review/2026-09-05-phase-3-exit.md`
- Modify: `packages/db/test/privileges.test.ts` (the DELETE list re-asserted, unchanged)
- Modify: `CLAUDE.md` (the slice's one-line entry, §3.8)

**Interfaces:** consumes everything; produces nothing but the report. No source file outside the two above changes in this task — if a re-run fails, the fix belongs in the task that owns the code, and this task's PR waits for it.

- [ ] **Step 1: The Phase 3 definition of done, clause by clause**

Run each command and paste its last line into the report:

| Clause | Owner | Command |
|---|---|---|
| Back-dated purchase recosts forward only, in bounded time, with a visible adjustment entry | 3B | `bun run test tests/invariants/test-05-back-dated-costing.test.ts` |
| FEFO picking returns the earliest-expiring lot | 3A | `bun run --cwd packages/db test inventory/fefo && bun run --cwd packages/db test inventory/fulfilment` |
| A landed-cost allocation changes unit cost and every downstream margin | 3C | `bun run test tests/invariants/test-05-back-dated-costing.test.ts && bun run test tests/invariants/test-07-one-costing-answer.test.ts` |
| **A stock count posts only the variance** | **3D** | `bun run --cwd packages/db test inventory/stock-count` |
| **Goods in transit are in neither warehouse's on-hand and in the company's total** | **3D** | `bun run --cwd packages/db test inventory/transfer && bun run --cwd packages/db test reports/inventory-reports` |

- [ ] **Step 2: The acceptance-test matrix**

| Test | Owner | Command | Note |
|---|---|---|---|
| 5 Back-dated costing | 3B | `bun run test tests/invariants/test-05-back-dated-costing.test.ts` | re-run |
| 6 Costing edge cases | 3B | `bun run test tests/invariants/test-06-costing-edges.test.ts` | re-run |
| **7 One costing answer** | **3D** | `bun run test tests/invariants/test-07-one-costing-answer.test.ts` | **owned, Task 11** |
| 18 Stock availability | 3A | `bun run test tests/invariants/test-18-stock-availability.test.ts && bun run --cwd packages/db test inventory/delivery-order` | 3D re-runs it on a real sale (Task 6) |
| 31 Segregation of duties | 2B | `bun run test tests/invariants/test-31-segregation.test.ts && bun run --cwd packages/db test inventory/stock-count` | 3D re-runs it on `STOCK_COUNT` (Task 8) |
| 2 Deterministic projections | 1B | `bun run test tests/invariants/projection-rebuild.test.ts` | `stock_on_hand` rebuilds bit-identically after this slice's six types |
| 12 Tenant isolation | 0B | `bun run test tests/invariants/tenant-isolation.test.ts` | over `ROUTES` — **six** new sub-paths on `documents`, three `GET`s on `reports`, **no new module** |
| 13 Attachment authorisation | 2C | `bun run test tests/invariants/test-13-attachments.test.ts` | the `inventory` module row 3A shipped now gates six more types |
| 15 New document type, zero code | 2C | `bun run --cwd apps/api test document-count` | 3D re-runs it with `COUNT_TEST` (Task 8) |
| 23 RTL/LTR parity | 0E | `bun run test:e2e tests/e2e/inventory-transfers.spec.ts` | Task 13; skipped with the screens if OD-24 is unanswered |
| 27 No SQL text across the API | 0B | `bun run lint:rules` | `no-sql-concat` and `no-bare-db` over this slice's eight new source files |
| 36 Role catalogue integrity | 0D | `bun run --cwd packages/db test permission-catalogue && bun run --cwd packages/db test roles-seed` | the six codes of Task 2 |

- [ ] **Step 3: Re-assert the pinned lists this slice did not change**

Three lists exist precisely so a slice cannot widen them quietly. Each assertion is an equality, not a containment:

```ts
// packages/db/test/privileges.test.ts — 3D adds NOTHING. §3.5.4's list is 2B's five rows and stays five.
it("the app_rw DELETE grant list is unchanged by slice 3D (§3.5.4, hazard 25)", async () => {
  const rows = await db.admin<{ table_name: string }[]>`
    select table_name from information_schema.role_table_grants
     where grantee = 'app_rw' and privilege_type = 'DELETE' and table_schema = 'app'
     order by table_name`;
  // contracts §3.5.4 (contracts:1119), verbatim and in `order by table_name` order: "after 0023 that list
  // … is ["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"].
  // No other table ever grants DELETE." `attachment` and `saved_view` are archived with `archived_at`
  // (contracts:1115) and must NEVER appear here — a plan that adds either has misread §3.5.4.
  expect(rows.map((r) => r.table_name)).toEqual([
    "document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission",
  ]);
});
```

Then, by hand:

Run: `bun run --cwd packages/db test lint-schema`
Expected: zero violations, and the §3.5.3 membership sets **unchanged** — this slice created no table, so it added no row to `AUDIT_EXEMPT`, `IMMUTABLE` or any other set. A diff on `packages/db/src/lint-schema.ts` in this slice's history must be empty; verify with `git log --oneline -- packages/db/src/lint-schema.ts | grep "3D T" | wc -l` printing `0`.

Run: `grep -rn "counted_quantity" packages/db/src --include=*.ts | grep -v "^packages/db/src/schema/" | grep -v "^packages/db/src/posting/load.ts"`
Expected: matches in **`packages/db/src/inventory/count.ts` and `packages/db/src/inventory/transfer.ts` only** — the two functions Task 8 declares as the sole writers of that column. A third file here means the variance can be set without its operands, and the fix is to route that caller through `recordCounts`.

- [ ] **Step 4: Re-seed staging and verify the two sub-packs**

The slice added six document-type files and one chart-of-accounts file. §3.4.8 makes re-applying the seed a release-runbook step, and 3B's task list already established that staging is re-seeded at the end of a Phase 3 slice:

Run: `bun run --cwd packages/db seed --tenant "$STAGING_TENANT" --only chart-of-accounts && bun run --cwd packages/db seed --tenant "$STAGING_TENANT" --only document-types`
Expected: both exit 0. `chart-of-accounts` is idempotent on `(company_id, code)` and adds `1250` and `5110`; `document-types` upserts on `(document_type_id, version)` and adds the six types at `version = 1`.

**Owner-account note (hazard 5).** Owner provides: the staging tenant id and `app_rw` credentials (OD-19, 0C's task). Verify: the two commands above print `applied: 2 rows` and `applied: 6 document types`. **Until provided:** the same two commands run against `startDb()` with the fixture tenant and must print the same two lines — which is what Tasks 2, 5, 6, 8 and 9 each already did for their own file, so this step is a re-run against a real database and nothing new.

- [ ] **Step 5: Confirm the register state this slice leaves behind**

A checklist for the reviewer, each line one `grep` against the contracts document:

- §4.14 carries **seven** new rows from 3D — the six seeded types plus `COUNT_TEST` marked *test only*.
- §4.15's `1250` and `5110` name **3D** in their *Seeded by* column; `1310` and `5100` still name **3C** and this slice's history contains no edit to `3c-purchasing.json` (`git log --oneline -- packages/db/seed/my/chart-of-accounts/3c-purchasing.json | grep "3D T" | wc -l` prints `0`).
- §4.16.1's three `inventory.*` minimal-set rows carry the shipping note Task 0 added, and `ReportCodeSchema` has exactly five members.
- §4.16.2's `DatasetId` union is **unchanged** — this slice added no member, because 7A creates that file.
- §4.17 has **no** 3D row; §4.17.1's `post-inventory.ts` row carries `secondPrincipal`.
- §3.6.2 carries the six codes with `phase: "3D"`, and §3.6.4 the four role rows.
- Migration **0043 is unused** and no file claims it (`ls packages/db/migrations/0043* 2>/dev/null` prints nothing); ADR 0042 and 0043 exist, 0042 as a proposal.

- [ ] **Step 6: Write the phase report**

`docs/review/2026-09-05-phase-3-exit.md` — the written report spec:110 requires at each phase gate. Sections: the five DoD clauses with the command and its last line; the acceptance matrix of Step 2 with each result; what Phase 3 delivered across 3A–3D against the spec:2289 scope sentence, item by item, **including the two items deferred and why** (serials, per OD-07, not built; BOM/consignment/commissions/project costing, per OD-08, names reserved only); the open owner decisions the phase ran on defaults for (**OD-05**, **OD-06**, **OD-07**, **OD-08**, **OD-24**) with the file list each would change; and the three things Phase 4 inherits — **`1250` is cleared by `SALES_INVOICE`** when linked through `document_link`, **`inventory.sales_by_item` gains revenue and margin under the same code**, and **test 7 is re-run against `item_profitability`** once 4B's projection exists.

- [ ] **Step 7: Add the CLAUDE.md line and commit**

Per §3.8, one line under the slice log: `3D — sales orders, delivery orders, two-step transfers, stock counts, expiry write-off, three inventory reports. Migrations 0040-0042 (0043 unused). ADRs 0042 (proposal), 0043. Phase 3 exit.`

```bash
git add docs/review/2026-09-05-phase-3-exit.md packages/db/test/privileges.test.ts CLAUDE.md
git commit -m "docs(review): Phase 3 exit report [3D T14]

Five DoD clauses green, tests 5, 6, 7, 18 and 31 passing, tests 2, 12, 13, 15, 23, 27 and 36
re-run over this slice's rows, codes and endpoints. The app_rw DELETE list, the linter sets
and the DatasetId union are unchanged by 3D and re-asserted as equalities. Staging re-seeded
for both touched sub-packs. Phase 4 inherits 1250, the sales_by_item code and test 7.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

**Against the contracts card (§2.4's 3D row).** Every deliverable the card lists has a task. `SALES_ORDER` → `DELIVERY_ORDER` with back-orders and FEFO (T5, T6); the two-step transfer with the in-transit DoD clause (T7, T8); `STOCK_COUNT` posting only the variance under `inventory.adjustment.approve` (T8); `EXPIRY_WRITE_OFF` with the branch/accountant split and the BRANCH tag (T9); test 7 completed (T11); the three minimal reports under the §4.16.1 codes (T10); the six permission codes and their role grants (T2); `1250` and `5110` seeded and `1310`/`5100` asserted-not-reseeded (T2, T7, T9); the screens (T13). Migration range **0040–0042 used, 0043 allocated and left unused**; ADR range **0042–0043**, 0042 written as a proposal per spec:95. Target size 13–15 tasks: **15** (Task 0 carries no application code, the same shape 2C and 3C used).

**Five things this review changed, and they were all in the file before this pass.** (1) Task 0's gate script grepped `secondPrincipal` in a file Task 0's Files list did not name, so Step 4 could never pass — the file is now listed and Step 4 exports the keyword. (2) "Eleven amendments" appeared three times against thirteen numbered items and fifteen grep literals; all three now say thirteen and the count discrepancy is explained where the list starts. (3) The File Structure named `convertSourceToTarget` while the DoD table named `convertOrderToDelivery`; the second name won, because `transfer.ts` owns the transfer drafting and `fulfilment.ts` is order-to-delivery only. (4) The back-office block named `src/screens/*.tsx` and a `routes.tsx`, neither of which exists — 0E ships `router.tsx` and 3A put its screens at `src/routes/inventory/*.tsx`. (5) That block also created a `WarehouseList.tsx` and a `tests/e2e/inventory-screens.spec.ts` that **3A already ships**; both were dropped, and the card's "warehouse screens" is served by the in-transit worklist inside `transfers.tsx`, which is the view 3A's list cannot show.

**Eighteen review findings applied in a later pass, and the four that were blockers.** Recorded so a reader does not "simplify" any of them back. (1) **FEFO no longer caps the drafted quantity** — `app.pick_lots_fefo` returns fewer rows than asked, so `convertOrderToDelivery` appends a null-lot shortfall pair; without it the 500-unit refusal, the override path, test 18's re-run and test 7's "gone negative" leg were all vacuous, and 3C's over-fulfilment guard never fired. (2) **The override event is attributed, not acted** — `recordOverride` takes `actor_id` from `app.current_actor()`, so the supervisor is `attributedTo` and the poster stays `s.human`; the negative case now attributes to the creator so the two cases differ by exactly the control under test. (3) **`TRANSFER_RECEIPT` declares `reversal.allowed: false`** — a variance-shaped line's negated `quantity` is a *forward* move of the variance, and the two amendments that would fix it are 1A's and 2A's, not this slice's; the ledger-balance assertion that would have passed either way is replaced by per-movement warehouse and quantity assertions. (4) **Task 14's `app_rw` DELETE list is §3.5.4's five rows** (contracts:1119), not the six-entry mixture an earlier draft carried. Then: the `fillTaggedLedgerLines` rule is chosen by the source line's **tags** rather than by how many movements survived, so a total loss in transit no longer debits the destination and relieves `1310` twice; tie-out B is stated over `greatest(quantity, 0)` because `cost_layer.qty_remaining >= 0` cannot represent the override's negative; the DoD case asserts WH-BR2's **absence** from `stock_on_hand` rather than a zero row the MERGE never inserts; SAH-017's scan matches the view's `from` clause, not the column name 3C's Drizzle mirror also contains; `stock_on_hand_report_idx` is gone (it duplicated the projection's primary key) and 0042 ships one index; every tie-out sums through `Money`/`Quantity` and `sum(…)::text` instead of `Number()` and `.toFixed()`; the six permission codes reach `POLICY_RESOLVED_CODES` in Task 2's own commit instead of behind a conditional; and 0041's down comment, two import blocks, `openLayersFor`'s branded currency, Global Constraint 11's code list, the File Structure's `count.ts`/`transfer.ts` rows and Task 4's Interfaces block are corrected.

**A third pass against an independent audit, and the five things it caught that would have stopped execution.** Recorded so none is re-introduced.

1. **`pickLotsFefo` was imported from a `packages/db/src/inventory/fefo.ts` that 3A does not ship.** 3A puts `pickLotsFefo` and `FefoPick` in **`lots.ts`** (3a:114, 3a:6534) and re-exports them from there (3a:6795). Task 5 Step 5 would have died on a module-not-found, and Task 0's gate could not have caught it because it grepped only migration 0031 for the SQL function. The import is corrected, and the gate now carries a `need_grep` on the TypeScript export path — eleven checks, not ten.
2. **Task 4's two hand-rolled `insert into app.document` statements omitted `series`**, which plan0A:1780 declares `text not null` with no default, and its `GOODS_RECEIPT` insert omitted `party_id`, which `GRN_POLICY`'s `requires: ["party", …]` makes mandatory at step 4 of §4.3.2. Both raise before any assertion runs, and both failures read like costing bugs. Both columns are now in the inserts, with a comment saying why.
3. **Task 4's fixture called `Bun.file()` inside a Vitest file.** §3.7.1 runs the test tier under **Node 24 via Vitest** ("Bun runs everything else") and `packages/db`'s `test` script is `node …/vitest.mjs run` (plan0A:321), so `Bun` is undefined there. The deeper problem was that it read `TRANSFER_RECEIPT.json`, which **Task 8 writes four tasks later** — so no reader of any kind would have worked. `packages/db/test/inventory/policies.ts` is therefore created by **Task 4**, the first task that configures a document type, and Tasks 5, 7, 8 and 9 append to it; Task 9 Step 6 still asserts every constant against its shipped seed file.
4. **Both regression blocks misused 0B's shared surface, in the exact way 3B's own Self-Review finding 7 records.** They imported from `../support/shared` (it is `tests/support/regression.ts`, §4.17.1), destructured `const { rw } = await sharedDb()` and then read `rw.db.admin` (it is `const { db } = …` then `db.admin`, 3b:6022), called `thinRegression` with a body that declares cases **inside the single `it` that wrapper runs** and with a `ThinContext` that has none of the named members (3b:5971), left five identifiers unimported, and selected `document_line.updated_at` — a column §4.3.4's DDL does not have (contracts:2200–2217). Both are now plain `describe`s with full import blocks and their own tenants, and the immutability assertion is on `quantity` plus the line's `app.audit_log` UPDATE rows, which is a stronger claim than a timestamp. `sah-018.test.ts` also moved from Task 5 to **Task 6**, because its conversion case needs `DELIVERY_ORDER.json` to exist.
5. **Four `beforeAll` blocks and thirteen helpers were prose.** Task 11 — the slice's only owned acceptance test — declared two `let`s and assigned nineteen, and named eight helpers it never wrote. Task 8's stock-count suite, Task 9 and Task 10 were the same shape. All four `beforeAll`s and every named helper are now written out, every `let` the fences assign is declared, and `approvedAndPosted()` drafts its own document per call rather than writing the same ten units off three times.

Then, from the same audit: `priceTransferReceipt` takes the issue value whole when the quantities are equal, because `10.0000 ÷ 3 × 3` is `9.9999` and two legs of one line carrying two values strand a cent on `1310` for ever (a sixth case in Task 4 proves it, and the §4.7.3 residual it does *not* fix is stated rather than hidden); the "test 31 by API" case moved out of `packages/db` into the API tier, where §3.1's `dependency-rule` allows `sharedApi`/`problemOf`; three `order by` clauses gained the tie-breaking third key their `toEqual`s needed; Task 9's "lot with no stock" case expects **WH-HQ**, the warehouse the call names, which is the only one the implementation can print; Task 10's source scan resolves its path from `process.cwd()`; four test-count claims were recounted from the blocks; Task 6's regression command is `bun run test <file>`; the gate script's amendment labels are `3D-1`…`3D-13` so no label collides with §4.4.2's frozen **A9**; amendment 2 says `quantity.negate()`, which is a member §4.2.1's `Quantity` actually has; and line 65's Phase 3 exit list carries Task 14 Step 2's own OD-24 caveat.

**Six neighbour shapes this pass verified by grep rather than by memory, four of which were wrong when first written out.** Every one is a `beforeAll` failure that reads like a costing bug. (a) Task 11's `receiveWithLandedCost` linked a freight-only `SHIPMENT` to a separate receipt with `linkKind: "allocates_to"` — **there is no such `LinkKind`** (the five are `"fulfils" | "converts_to" | "receives_against" | "returns" | "settles"`, 3c:1493) and landed cost is not a link at all: 3C puts the goods line and the freight `account` line on **one** SHIPMENT and calls `allocateLandedCostForDocument(tx, ctx, { documentId, allocations })` while it is still a draft (3c:3042, 3c:3936–3948). The helper is rewritten to 3C's mechanism. (b) `replay` is `(sql, job: JobEnvelope<{ companyId }>, ctx)` (3b:4050), not `(tx, ctx, payload)`, and `recordingJobs()`'s `enqueued` is a **readonly** array of `{ name, payload, singletonKey }` (3b:2294, 3b:2458) with nowhere to mark an entry drained — `runReplayToCompletion` now rebuilds the envelope (contracts:1707) and keeps its own `Set` of indices. (c) `app.audit_log.action` is lower case (`check (action in ('insert','update','delete'))`, plan0A:2269) and `row_id` is `text` (plan0A:2268); the `sah-018` immutability case was written against `'UPDATE'` and an untyped uuid. (d) `app.actor_has` takes `(code, company_id, branch_id)` (plan0A:1203, 1212), not one argument, so the count-sheet `GET` handler passes the company and a null branch. (e) `LinkKind`'s `"converts_to"` and `"receives_against"` — the two this slice actually writes — are on that list. (f) `Money.abs()` exists (contracts:1360) and `Quantity.abs()` does not (contracts:1377–1386), which is why Task 4 may use the first and amendment 2 must say `negate()`.

**Two collisions with 3A that the audit did not raise and this pass found while fixing it.** (a) 3A ships **`StockOnHandRow`** from `packages/db/src/inventory/stock.ts` through the flat `packages/db/src/index.ts` barrel (3a:7730) and **`StockOnHandSchema` / `StockOnHandQuery` / `StockOnHandList`** from `packages/contracts/src/inventory/stock.ts` (3a:7853–7867). This slice's report types would have been duplicate exports from both barrels — a TypeScript error — and duplicate `.openapi(...)` component names; they are now `StockOnHandReportParams` / `StockOnHandReportRow` / `StockOnHandReportRowSchema` / `StockOnHandReportQuery` / `StockOnHandReportList`, and Task 10 states why the two reads are a list endpoint and a report code rather than a duplication. (b) The **two transfer endpoints named in this Self-Review had no task**, while Task 13's `transfer-api.ts` called both against a `TransferDraftSchema` defined nowhere. `POST …/documents/transfers` is now Task 7 Step 7 and `POST …/{documentId}/receipt` Task 8 Step 8, both with their Zod bodies, `IdempotencyHeader`, gates and route tests; the four places that gave four different sub-path counts all say **six**.

**Contract additions — every name invented because the registers lacked one.** Listed here and in the structured result; none is in a registered namespace (§4.14, §4.15, §4.16, §4.17, §4.2.4 are all consumed unchanged except where Task 0 amends them).

- `packages/db/src/inventory/fulfilment.ts` — `convertOrderToDelivery`, `ConvertToDeliveryInput`, `ConvertResult`, `ConvertResultLine`.
- `packages/db/src/inventory/transfer.ts` — `draftTransfer`, `resolveInTransitWarehouse`, `draftTransferReceipt`, `TransferInput`, `TransferResult`, `TransferReceiptInput`.
- `packages/db/src/inventory/count.ts` — `snapshotCountSheet`, `recordCounts`, `readCountSheet`, `CountSheetLine`, `SnapshotCountSheetInput`. **`recordCounts` is the one the catalogue should note**: it is the sole writer of `document_line.counted_quantity` and of the derived `quantity`, and Task 14 Step 3 greps to keep it so.
- `packages/db/src/inventory/write-off.ts` — `draftExpiryWriteOff`, `ExpiryWriteOffInput`.
- `packages/db/src/reports/stock-on-hand.ts` — `stockOnHand`, `stockOnHandTotals`, `StockOnHandReportParams`, `StockOnHandReportRow`; `sales-by-item.ts` — `salesByItem`, `SalesByItemParams`, `SalesByItemRow`. All registered in §4.16.3 by Task 0's amendment 13.
- `packages/contracts/src/inventory/` — `ConvertDocumentBody`, `ConvertResultSchema`, `ConvertResultLineSchema`, `CountSheetBody`, `RecordCountsBody`, `CountSheetLineSchema`, `CountSheetResultSchema`, `StockOnHandReportRowSchema`, `StockOnHandReportQuery`, `StockOnHandReportList`, `SalesByItemRowSchema`, `SalesByItemQuery`, `SalesByItemList`.
- `packages/domain/src/posting/evaluate.ts` — `PlannedLedgerLine.fill`, and the three private helpers `quantitySignOf`, `orientMovement`, `transferQuantities` (T3).
- `packages/db/src/costing/apply-movements.ts` — the private `fillTaggedLedgerLines`, `priceTransferReceipt` and `costByLine` (T4), all three declared in that task's Produces block with their signatures.
- Test-tier: `packages/db/test/inventory/policies.ts` with `ctxOf` and the seven policy constants; `secondPrincipal` exported from 3B's `post-inventory.ts` (§4.17.1 amendment 12); the file-local `seedInventoryAccounts` and `receiveStock` repeated where needed. **`receiveStock` appears in three test files and is a §4.17.1 candidate the catalogue should place** — it is named here rather than invented as a shared helper, because hazard 9 assigns that decision to the register.
- **Six** route sub-paths on 1A's `documents` module, each with its Zod body, its OpenAPI entry, `IdempotencyHeader` on the unsafe methods and its gate — `POST …/{id}/convert` (T5), `POST …/documents/transfers` (T7), `POST …/{id}/receipt`, `POST …/documents/count-sheet`, `PATCH …/{id}/counts`, `GET …/{id}/count-sheet` (T8) — and three `GET`s on 1B's `reports` module (T10). The File Structure, Task 8's route table, Task 14's test-12 row and this line all say **six**; an earlier draft of the plan said two, three and six in four different places, and the two transfer routes it named had no task at all. **No new `RouteModule` and no new `PROBES` key** (hazard 31 satisfied by the existing two keys), so test 12's `ROUTES` walk covers all nine surfaces without a new entry.
- `packages/contracts/src/inventory/transfer.ts` — `TransferDraftBody`, `TransferReceiptBody`, `TransferDraftSchema` (T7, T8).
- Documents: `docs/decisions/od-05-3d-multi-branch-stock.md`, `docs/runbooks/stock-count.md`, `docs/review/2026-09-05-phase-3-exit.md`, `docs/owner/od-24/3d/` (the gate directory), `scripts/check/contracts-3d-amendments.sh`.

**Against the never/always lists.** No table is created, so the always-list's table clause is satisfied by re-running `lintSchema` to zero after 0040 and 0042; both migrations are expand-only and each has a hand-written down file. No ledger, movement, layer or projection write happens outside `packages/db/src/posting/` and `packages/db/src/costing/` — every drafting service in this slice writes `document` and `document_line` and then hands over to `postDocument` (hazard 22). No `number` holds money or a quantity across a boundary; every wire quantity is a 6-dp string and every wire amount `{ amount, currency }`. No `sql.unsafe`, no string-concatenated SQL, no DDL from application code, no disabled invariant. Every commit message carries the trailer.

**Against §4.4.2's A9 warning, which names 3D explicitly.** No line of this slice tests the sign of an *amount* to choose a *direction*. The three sign tests that do appear are none of that: `Quantity.isNegative()` inside `orientMovement` chooses a movement **effect** from a signed quantity (behaviour 2, which is the rule A9's movement twin states), `shortfall.compare(Quantity.zero()) > 0` in Task 5 decides whether a shortfall pair exists at all, and `Money.isPositive()` in Task 11 is a test asserting that a loss was debited. Direction is chosen in exactly two ways throughout: a fixed `side` in a policy rule, or `when: { "line.quantity_sign": … }` over the line's signed *quantity* — never over an amount. `PlannedMovement.quantity` is a magnitude with `effect` as its direction (T3 behaviour 2), `PlannedLedgerLine.amount` is a magnitude with `side` as its direction, `document_line.cost` and both `fill` targets are non-negative magnitudes (T4), and `inventory_movement.quantity`/`value` carry the sign because the row's own contract says they do (§4.7.3). `PlannedTaxLine` stays signed and this slice plans no tax line — all six policies declare `tax.applies: false`.

**Against the hazards.** 1 and 2: no statutory rate and no MyInvois detail appears — this slice touches neither domain. 4: the three minimal reports ship here rather than being deferred to Phase 7, and "sales by item" ships at its Phase 3 meaning under the code 4A extends. 5: the two owner-account steps (T13's gate, T14 Step 4) both state the command and the local equivalent. 6: OD-05 and OD-24 are one isolated task each, droppable without renumbering. 8 and 9: every 0A helper is cited by its exact name, `fixtures.ts` gains nothing, and §4.17.1 gains one `export` keyword rather than a file. 13: `lint-schema.ts` is untouched and T14 Step 3 proves it. 14: 0043 is left unused rather than borrowed. 17: "gone negative" is produced only through the override event, and T6's last case proves a self-authorised override is refused. 25: the DELETE list is re-asserted as an equality. 31: no new route module, so no new probe key. 32 and 33: every literal comes from a register, and the two accounts this slice consumes but does not own are asserted rather than re-seeded. 34: all six seed files are envelopes with `module: "inventory"` outside `policy`. 35: every task has exact paths, real code, a failing test first and a commit.

**Three things a reviewer should check that this plan cannot prove on its own.** (1) **3B's `allowShortfall`** — Task 0's gate greps for `negative_stock.override` in `apply-movements.ts`, and if 3B shipped no override path then Tasks 6 and 11 are blocked on a 3B correction, never a 3D workaround. The gate says so and Task 6 Step 2's expected-failure note repeats it. (2) **`INVENTORY_PERMISSION.costRead`** — 3B extended 3A's constant by one member for its valuation route; Task 10 imports that member and does not write `PERMISSION["inventory.cost.read"]` inline. (3) **3C's `GOODS_RECEIPT` policy** — every test in Tasks 5–11 creates stock with it, and Task 9 Step 6 asserts the plan's `GRN_POLICY` constant equals 3C's seed file; a mismatch is corrected in this plan's constant, not in 3C's file.

**Deliberately not in this slice.** No revenue and no margin anywhere (4A). No `DELIVERY_RETURN` type — a cancelled delivery is a reversal, and the effect flip makes one policy serve both movement directions (the reversal's *ledger* direction on a fixed-side `line.cost` policy is a 2A/3C gap this plan records and does not test). **No reversal of `TRANSFER_RECEIPT`**, whose policy declares `reversal.allowed: false` for the reason Task 8 states. No `item_profitability` (4B). No `ReportDefinition`, no `DatasetId` member, no `packages/db/seed/my/reports/3d/` directory — 7A creates the engine and 7B re-expresses these three codes at `version = 2`. No serial handling (OD-07, 3A's gate). No `document_line.to_warehouse_id` column, and migration 0043 left unused as a consequence (ADR 0043).

---

## Execution handoff

**Read before starting.** This plan's Assumptions block, all of §3 of the contracts document, and §4.4.2's sign-normalisation section — including the ⚠️ paragraph that names 3D. Then Task 0 in full: it is a gate, not a formality, and Task 1 does not start until its script exits 0.

**Order and independence.** Tasks 0 → 1 → 2 → 3 → 4 are strictly sequential: 1 adds the columns 3 reads, 3 tags the lines 4 fills, and 5 onward all post through 4. **Task 4 also creates `packages/db/test/inventory/policies.ts`** — it is the first task that configures a document type, and it configures two of them — so Tasks 5, 7, 8 and 9 *append* to that module and none of them re-declares `ctxOf`, `GRN_POLICY` or `TRANSFER_RECEIPT_POLICY`. From Task 5 the order is 5 → 6 → 7 → 8 → 9 (each seeds a type the next task's fixtures may use, and Task 9 Step 6 asserts all six files at once), then **10 and 11 in either order** (11's tie-outs call 10's read functions, so 10 first is easier; 11 can be written against them before they exist if two engineers are working in parallel). **Task 12 is independent of everything** — it writes one decision record and may be done at any point. **Task 13 is gated on OD-24 and blocks nothing.** Task 14 is last by definition.

**One migration per PR (spec:2057).** Tasks 1, 2 and 10 each carry exactly one migration, so those three are three PRs; nothing else in the plan adds DDL. Tasks 3–9 and 11–14 may be grouped by whatever review cadence the team runs, but a task is never split across PRs — its failing test and its implementation land together.

**Where to stop and raise rather than working around.**

- A `MISSING (repo):` line from Task 0's gate script. That is a reconciliation with 3A, 3B or 3C, and the owning plan is the authority for what it exports (§4.18).
- `ERR_COST_NEGATIVE` or an unhandled `CostingError` on Task 6's override case, or on Task 11's step 4. 3B's `CostingInput.allowShortfall` is missing; the fix is 3B's.
- Tie-out A failing in Task 11 by a figure that is not the override's uncovered value. That is a real discrepancy between `valuationAsOf` and the ledger; read the per-account breakdown and raise it against whichever slice owns the account the difference lands in.
- Task 9 Step 6's `GOODS_RECEIPT` case failing. 3C's file wins; correct `GRN_POLICY`.
- **Any proposal to set `reversal.allowed: true` on `TRANSFER_RECEIPT`** (or on any later type whose `document_line.quantity` is a variance). Two amendments must land first, both outside this slice: `reverseDocument`'s frozen line copy must gain `counted_quantity`/`expected_quantity` **negated as a pair** (§4.3.1/§4.4.2 — 1A's and 2A's), and §4.7.2's fill rules must stop keying on the movement's `effect` name, because negating the pair flips both legs. Without both, the "reversal" moves the variance **forward** and either raises `ERR_STOCK_INSUFFICIENT` against an empty corridor or posts a balanced document with the wrong figures on `1310`. Task 8's prose derives this; do not re-open it as a 3D bug.
- **A test that reverses a `DELIVERY_ORDER`, a `TRANSFER` or an `EXPIRY_WRITE_OFF` and asserts the ledger direction.** All three address `amount: "line.cost"` with a fixed `side`, and 3C copies `cost` unnegated, so the reversal's ledger legs land on the same side as the original. That is a 2A/3C reversal-mechanism gap (see Task 6 Step 3's note); raise it there rather than adding a policy rule or a sign test here — Global Constraint 6 forbids the sign test outright.
- **The 500-unit case in Task 6 passing, or the override case reading `stock_on_hand` as `0`.** Task 5's shortfall pair is missing; see Task 6 Step 2.
- A `permission-catalogue` failure at Task 2 reading "code introduced in 3D has no reference" — **Task 2 Step 6** already adds the six codes to `POLICY_RESOLVED_CODES` in that task's own commit, so this can only mean that step was skipped. Run it; never defer it and never add a `// eslint-disable`.
- Any temptation to add a `document_line.variance_value`, a `delivered_quantity` or a second `open_quantity` expression. All three are SAH-017/SAH-018 by construction and `tests/regression/sah-018.test.ts` fails on the first two mechanically.
- **A sub-cent difference between `valuationAsOf` and the `1300`/`1310` balances on an UNEQUAL transfer.** `app.cost_layer` stores `qty_in` and a `unit_cost numeric(19,4)` and **no `value` column** (§4.7.3, contracts:3076–3079), so a layer whose value does not divide by its quantity is representable only to the nearest cent — on every document type, not only a transfer. Task 4's equal-quantity branch in `priceTransferReceipt` closes the part that is 3D's (two legs of one line disagreeing with each other); the residual is 3B's and §4.7.3's. Raise it there. **Do not round in `fillTaggedLedgerLines`** to make a tie-out pass — that moves the discrepancy into the ledger, where it is much harder to find.
- **`sharedDb()`'s return shape differing from `{ db, rw, a, b }`.** §4.18's open item 5 records that §4.17.1's declaration and 1A's use sites disagree, and this slice's two regression files destructure `db` and read `db.admin`, following 3B (3b:6022) and 3A (3a:942). If the merged 0B file exports another shape, **follow the merged file** and change the destructuring line — it is one line in each of two files, and §4.18 already names the discrepancy as plan-side.
- **`recordingJobs()` returning frozen entries**, which Task 11's `runReplayToCompletion` mutates with a `drained` flag. Track the drained set in a local `Set<string>` keyed by job id instead; that is a two-line change in this slice's own helper and never a change to 3B's recorder.

**The two commands that must be green after every task.** `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck` and `bun run test`, both at the repository root. `lint:rules` is the one that catches this slice's likeliest mistake: a `db.` outside `withTenant`, or a permission code with no reference.

**What Phase 4 inherits, so 4A's writer does not have to re-derive it.** `1250` carries every delivered-not-invoiced cost and is cleared by `SALES_INVOICE` when it is linked to the delivery through `document_link` (3C's `linkFulfilment`, `linkKind: "fulfils"`). `inventory.sales_by_item` is one report code with a `deliveredQuantity` and a `cost` column, and 4A adds `revenue` and `margin` to that same code and its same two files. Acceptance test 7 is re-run by 7B against `item_profitability`; its three tie-outs are written so the first two are unchanged by revenue and only tie-out C gains columns.
