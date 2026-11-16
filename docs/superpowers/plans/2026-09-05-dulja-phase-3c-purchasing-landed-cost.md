# Dulja Phase 3C — Purchasing: purchase orders, import shipment and landed cost, goods receipt with GRNI, purchase returns

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the buy side of Phase 3 as configuration on top of 3A's item/movement model and 3B's costing engine: four document types (`PURCHASE_ORDER`, `SHIPMENT`, `GOODS_RECEIPT`, `PURCHASE_RETURN`) seeded as posting policies with no application code of their own, one link table (`app.document_link`) with open quantity as a **derived view** rather than a stored counter, one allocation table (`app.landed_cost_allocation`) with three allocation methods that carry freight, duty and clearance into `cost_layer.unit_cost`, the goods-received-not-invoiced accrual, and the three chart-of-accounts rows (`2150`, `1310`, `5100`) the rest of Phase 3 posts to.

**Architecture:** Nothing in this slice is a new posting path. `postDocument` (1A, generalised by 2A) already reads a policy and emits ledger lines and movements; `applyMovements` (3A provisional, 3B complete) already writes `inventory_movement`, `cost_layer` and `cost_consumption`. 3C adds exactly **three seams**. (1) **Fulfilment** — `app.document_link` is an append-only row per (source order line × target fulfilment line); open quantity is `app.document_open_quantity`, a `security_invoker` **view** computing `ordered − Σ linked`, so no quantity is ever incremented in place (SAH-017) and no fulfilled or returned quantity is ever a stored column (SAH-018); a BEFORE INSERT OR UPDATE trigger on the link refuses over-fulfilment with `ERR_DOC_LINK_OVER_FULFILLED`. (2) **Landed cost** — a route on the shipment computes `landed_cost_allocation` rows with `Money.allocate` (exact, Σ = the cost lines' total, largest-remainder residue to the first weight), and one function in `packages/db/src/costing/landed-cost.ts` is the single place a *receipt* movement's value is decided: `value = toBase(line.amount + Σ allocated, rate)`. Because the value is what `costingEngine` turns into a layer, the freight lands in `cost_layer.unit_cost` and therefore in every downstream margin, which is this slice's clause of the Phase 3 definition of done. (3) **Accrual** — the `GOODS_RECEIPT` and `SHIPMENT` policies credit `2150` GRNI for the goods portion and each freight/duty/clearance line's own accrual account for its portion, debiting `item.inventory_account` and `1300` respectively, so the document balances rule by rule and the *sum* debited to inventory is the landed cost that reaches the layer; 4A's `PURCHASE_INVOICE` then has an accrual to clear. `PURCHASE_ORDER` is the one type in the system that is **issued and never posted**: its policy plans zero ledger lines, so `postDocument` would raise `ERR_DOC_NO_LINES` by design, and its open quantity is what a `GOODS_RECEIPT` consumes.

**Tech Stack:** Bun 1.4 (install, scripts, the API entrypoint) · Node 24 LTS (runs Vitest) · TypeScript strict · PostgreSQL 18 (Testcontainers `postgres:18`) · `postgres` (postgres.js) tagged templates · Drizzle ORM mirrors for reads · Hono + `@hono/zod-openapi` · Zod · `decimal.js` behind `@dulja/domain`'s `Money` / `Quantity` · Vitest + Testcontainers + fast-check · oxlint + oxfmt · Turborepo.

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §0.2 the never/always lists (spec:97–108), §3.0.3 Landed cost and Purchase in foreign currency (spec:1020, 1023), §3.0.4 rows 1049–1050 and 1055 (spec:1049–1050, 1055), §3.3 the document-type list (spec:1186–1187), §3.4 costing in full and layers per receipt (spec:1208–1228), §3.9 conventions (spec:2037–2063), §4.2.1 `accounting.purchase.*` / `inventory.receipt.*` and the `warehouse` and `user`/`accountant` role rows (spec:2147–2148, 2159), §4.11 golden-file and concurrency practice (spec:2258–2266), Part V Phase 3 row (spec:2289), Part VI tests 5, 7, 14, 15 (spec:2423, 2425, 2432, 2433), Part I SAH-005 (spec:2491), SAH-017 (spec:2503), SAH-049 (spec:2535).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 3C — Purchasing: purchase orders, import shipment and landed cost, goods receipt with GRNI, purchase returns. **Phase:** 3. **Phase gate:** this plan starts only when **3B** is merged (and with it 3A, 2C, 2B, 2A, 1B, 1A) and Phase 2's definition of done is green in CI (spec:87). 3B is a hard gate, not a soft one: this slice's DoD clause is about `cost_layer.unit_cost`, and before 3B there are no layers.
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_tenant`, `app.current_actor`, `app.forbid_change`. **0B** — `createApp`, `AppDeps`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `requirePermission`, `assertRouteGates`, `AppError`, `ERRORS`, `Problem`, `fromDatabaseError`, `createLogger`, the production `withTenant(sql, ctx, fn)`, `systemContext`, `startApi`, `TEST_ISSUER`, `PROBES`, `TENANT_FREE`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `problemOf`, `fullRegression`, `repoFile`, `REPO_ROOT`, `sourceFiles`, `encodeCursor`, `decodeCursor`, `ListEnvelope`, `ListQuery`. **0D** — `Money`, `currency`, `Quantity`, `rational`, `round`, `toBase`, `UNIT_RATE`, `MONEY_SCALE`, `QUANTITY_SCALE`, `PERMISSIONS`, `PERMISSION`, `ROLES`, `seedBranch`, `seedCurrency`, `seedRate`, `startWorker`, the `permission-catalogue` and `role-seed` lints. **0C** — `SubPack`, `SUB_PACKS`, `PackLoader`, `LoaderContext`, `readPackFile`, `assertPackShape`, `PHASE_0_SUB_PACK_DIRECTORIES`, the seed CLI and its four exit codes, `packages/db/seed/my/chart-of-accounts/0c-base.json`. **1A** — `postDocument`, `loadSnapshot`, `resolvePolicy`, `issueDocument`, `reverseDocument`, `voidDocument`, `PostingError`, `PostingErrorCode`, `documentRoutes`, `seedTenantV2`, `seedJournalPolicy`, `JOURNAL_POLICY_V1`, `seedAccount`, `loadDocumentTypes`, `documentTypesLoader`, `app.posting_seq`. **1B** — `trialBalance`, `accountLedger`, `accountOpeningBalance`, `postJournal`, `registerProjectionCheck`, `projectionChecks`, `ProjectionCheck`. **2A** — `evaluatePolicy`, `validatePolicy`, `parsePolicy`, `validateDocumentTypeSeed`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PlannedMovement`, `PostingPlan`, `ItemRef`, `balanceInBase`, `requireDocumentPermission`, `DocumentStage`, `DOCUMENT_STAGE_CODES`, `POLICY_RESOLVED_CODES`, `seedParty`, `seedDocumentType`, `DocumentLineInput`, `document_type.module`. **2B** — `transitionDocument`, `recordOverride`, `setEventContext`, `listDocumentEvents`, `stageCode`, `grantCodes`, `app.principal_has`, `app.effective_policy`, `app.series_gaps`, `app.document_event`. **2C** — `MODULE_READ_CODE`, `requireDocumentModuleRead`, `requireAttachmentRead`, `readableModules`, `ObjectStore`, `pdfText`. **The first four live in `apps/api/src/middleware/require-attachment-read.ts`** (2c:1794, 2c:4591 "the same file — one map, one home", and 2c:2144/2c:5013 import them from there), **not** in `apps/api/src/routes/accounting/attachments.ts` as §4.5.8's prose says. The frozen plan is the authority for what is on disk; Task 0 Step 6 records the discrepancy so the next slice does not import a path that does not exist. **3A** — `app.item`, `app.unit_of_measure`, `app.unit_conversion`, `app.warehouse`, `app.lot` (with the per-item `NONE` sentinel), `app.variant`, `app.price_list`, `app.inventory_movement`, `app.stock_on_hand`, `app.assert_stock_available`, `app.pick_lots_fefo`, `applyMovements`, the `document_line` inventory columns (`warehouse_id`, `lot_id`, `unit_id`, `unit_quantity`) and the `document` header columns (`warehouse_id`, `to_warehouse_id`), the `inventory` row of `MODULE_READ_CODE`, `seedUnit`, `seedItem`, `seedWarehouse`, `seedLot`, `seedPriceList`. **3B** — `costingEngine`, `CostingEngine`, `Layer`, `Consumption`, `CostingInput`, `CostingOutput`, `CostingMethod`, `app.cost_layer`, `app.cost_consumption`, `app.stock_valuation`, `company.costing_method`, the full `applyMovements` body, `invalidateFrom`, `replay`, the `inventory.cost.replay` job, `COST_ADJUSTMENT`, `valuationAsOf` with `ValuationParams`/`ValuationRow` and `openLayersFor` (amendment A19), and the test-tier helpers `postInventoryDocument`, `postOverriddenIssue`, `recordingJobs`, `ensureOpenPeriods`, `STOCK_ISSUE_COST_POLICY` (`tests/invariants/support/post-inventory.ts`, amendment A11) and **`costingContext(sah)` / `CostingFixture`** (`tests/regression/support/costing.ts`, amendment A21(a)) — the per-file regression tenant Task 14's three blocks build on.
- **Migration numbers:** **0037–0039** — `0037_create_document_link.sql` (the link table, the `document_open_quantity` view and the over-fulfilment guard), `0038_create_landed_cost_allocation.sql`, `0039_seed_permission_phase3c.sql`, each with its hand-written `NNNN.down.sql`. **ADR numbers:** 0040–0041 — **0040** `docs/adr/0040-fulfilment-links-and-derived-open-quantity.md` (the link row, the view, and why open quantity is never a column); **0041** `docs/adr/0041-landed-cost-allocation-and-purchase-return-valuation.md`, written **as a proposal** because it touches money semantics (spec:95).
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `Quantity`, `toBase`, `round`, `RoundingMode`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`, `createDb`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`), §4.2.4 (`Problem`, `ERRORS`, `ErrCode`, `AppError`, `fromDatabaseError`, `PostingError`), §4.2.5 (`PERMISSIONS`, `PERMISSION`, `PermissionCode`, `requirePermission`, `ScopeSource`, `assertRouteGates`), §4.2.7 (`RouteModule`, `buildRoutes`, `ROUTES`, `IdempotencyHeader`, `createApp`, `AppDeps`, `PROBES`, `IsolationProbe`), §4.2.8 (`UuidSchema`, `DateSchema`, `QuantitySchema`, `TimestampSchema`, `CurrencySchema`, `ListEnvelope`, `ListQuery`, `ProblemSchema`, the one list-filter convention, **and the money-string exception Task 0 Step 5 registers** — this slice consumes `MoneySchema` nowhere), §4.2.9 (`idempotency`, `IdempotencyHeader`), §4.2.11 (custom fields — the `weight_kg` input), §4.2.12 (`startApi`, `StartedApi`, `ApiRequest`, `TEST_ISSUER`), §4.2.13 (`SubPack`, `SUB_PACKS`, `PackLoader`, `readPackFile`, `assertPackShape`), §4.3.1 (`postDocument`, `loadSnapshot`, `resolvePolicy`, `issueDocument`, `reverseDocument`, `transitionDocument`), §4.3.2 (the fixed algorithm — steps 6, 8, 9, 10, 12, 14), §4.3.4 (`document_line` and its per-slice additions, the `document` header additions), §4.3.5 (`posting_seq` as the chronological key), §4.3.6 (numbering at issue), §4.3.7 (the document-type seed envelope and `loadDocumentTypes`), §4.4.1 (the widened `posting-policy.schema.json` — `accountRef`, `amountRef`, `inventory`, `approval`, `requires`), §4.4.2 (`DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PlannedMovement`, `PostingPlan`, `ItemRef`, `evaluatePolicy`, `balanceInBase`, **the sign-normalisation contract**), §4.5.1 (legal transitions), §4.5.2 (`document_event`), §4.5.4 (`requireDocumentPermission`, `DocumentStage`, `stageCode`, `DOCUMENT_STAGE_CODES`, `POLICY_RESOLVED_CODES`), §4.5.6 (the five `branch_isolation` forms — none applies to either of this slice's tables), §4.5.7 (`app.party` and `payable_account_id`), §4.5.8 (`MODULE_READ_CODE`, `requireDocumentModuleRead`), §4.6.1 (the register rows for `document_link` and `landed_cost_allocation`), §4.7.1 (`costingEngine`, `Layer`, `CostingInput`, `CostingOutput`), §4.7.2 (`applyMovements`, `invalidateFrom`, `replay`), §4.7.3 (`inventory_movement`, `stock_on_hand`, `cost_layer`, `cost_consumption` and the `stock_on_hand` MERGE), §4.14 (the document-type register), §4.15 (the account-code register), §4.16.1 (the report register — 3C owns no code), §4.17 / §4.17.1 (the two helper registers).
- **Interfaces produced:** §4.6.1's `document_link` and `landed_cost_allocation` rows verbatim; the four §4.14 rows `PURCHASE_ORDER`, `SHIPMENT`, `GOODS_RECEIPT`, `PURCHASE_RETURN` as seed-pack envelopes; the three §4.15 rows `2150`, `1310`, `5100` in `packages/db/seed/my/chart-of-accounts/3c-purchasing.json`; the four §3.6.2 permission codes `accounting.purchase.create`, `accounting.purchase.post`, `inventory.receipt.create`, `inventory.receipt.post`. Everything else this slice names is listed under **Contract additions** in the Self-Review and **must be carried into the contracts document before 3D consumes any of it** — 3D consumes `document_link` for `SALES_ORDER` → `DELIVERY_ORDER`, the `1310` and `5100` accounts, and `draftTypedDocument`.
- **Owner decisions:** **OD-05** (§2.12; spec:38, 1014, 1036, 2404 — confirmation of every ⚠️ row in §3.0.3 and §3.0.4) → **Task 12**, isolated. The two rows that touch this slice are **Landed cost** (spec:1020) and **Purchase in foreign currency** (spec:1023); both are built to the spec text as written, which is §2.12's stated default. **OD-24** (screenshots + a two-minute operator description before any screen) → **Task 13**, isolated and blocked. No other OD item gates this slice; OD-06 (`avco`) is 3B's and is consumed as built, never re-gated.
- **Part VI tests owned / re-run:** **owns none exclusively.** **Re-runs:** **5** (the landed-cost clause — Task 9), **7** (the supplier-return leg — Task 10), **14** (a real `PURCHASE_RETURN` type exists for the one-query test — Task 10), **15** (orders and the inventory-bearing consignment return as configured types — Tasks 5 and 11), plus **12** and **36** for the two new tables and the four new permission codes (Tasks 1, 7, 2, 14), **13** (every write on both new tables audited — Tasks 1, 7, 14), **18** (`assert_stock_available` on the purchase-return issue — Task 10), **27** (no SQL text across the API — Task 14, CI). **§3.0.4 rows owned:** **spec:1049** (goods receipt with a GRNI accrual, and an import-shipment document that carries freight, duty and clearance into landed cost per lot). **Contributes** `PURCHASE_ORDER` to spec:1050 (owned by 3D) and the free-of-charge receipt line to spec:1055 (owned by 3B). **Regression files created / appended:** creates **none**; **appends** a `— 3C` block to `tests/regression/sah-005.test.ts` (created by 0D — "transactional enqueue"; 3B appends the recost block before 3C), to `tests/regression/sah-017.test.ts` (**created by 3B**, which executes first — §3.7.3) and to `tests/regression/sah-049.test.ts` (created by 1B).
- **Shared namespaces this slice writes into:** **document-type codes (§4.14)** — four, all seeded into the pack: **`PURCHASE_ORDER`** module `inventory` series `PO`, **`SHIPMENT`** module `inventory` series `SHP`, **`GOODS_RECEIPT`** module `inventory` series `GRN`, **`PURCHASE_RETURN`** module `inventory` series `PR`. All four are `inventory` and not `accounting` even though two post under `accounting.purchase.*`: §4.14's rule is that `document_type.module` answers "which module's read code may see this document's attachments", and the delivery note, halal certificate, import permit and customs form are filed and read by the warehouse (spec:1049 is an Inventory row). This slice additionally *re-runs* test 15 against 2C's registered test-only code **`CONSIGNMENT_RETURN`** in the inventory-bearing shape 2C deferred to 3C. **It also adds fourteen `test only` §4.14 rows** — `TYPED_TEST`, `TYPED_TEST_2` (T0), `LINK_ORDER`, `LINK_RECEIPT` (T1), `API_ORDER`, `API_RECEIPT` (T4) and the eight `LCA_*` (T7) — every one a `seedDocumentType` argument inside a single test file, never a file under `packages/db/seed/`. They are registered in **Task 0 Step 6**, before Task 1 uses the first of them, because §4.14's *test only* mark is a registration requirement and not an exemption from one (hazard 32); 2A, 2B, 3A and 8B registered their file-local codes on the same rule. None of the fourteen engages hazard 33: every one of their policies has `lines: []`, so no `account: { code }` literal exists in any of them. **Account codes (§4.15)** — **seeds three**: `2150` Goods received not invoiced (liability), `1310` Goods in transit (asset), `5100` Inventory write-off — expiry loss (expense), all in `packages/db/seed/my/chart-of-accounts/3c-purchasing.json`. `1310` and `5100` are **consumed by 3D** (`TRANSFER`/`TRANSFER_RECEIPT` and `EXPIRY_WRITE_OFF`) and 3D asserts they resolve rather than re-seeding them. **Consumed but seeded elsewhere:** `1300` inventory control, `2100` trade payables, `5000` COGS, `5920` FX rounding, `1000` Cash, `4000` Sales — all **0C's** (`0c-base.json`). The `account: { code }` literals in the policies this slice seeds are exactly **two**: **`2150`**, seeded here by Task 3, and **`1300` inventory control, which is 0C's** — the capitalised-freight debit of `GOODS_RECEIPT` and `SHIPMENT` (an `account`-kind line carries no `item_id`, so `item.inventory_account` has nothing to resolve against). Task 3 satisfies hazard 33 for both before Task 6 seeds the first policy that names them: it seeds `2150` and **asserts `1300` resolves without re-seeding it**, which is the rule for a consumed code. Every other account is resolved through `item.inventory_account`, `party.payable_account` or `line.account`. **Report codes (§4.16.1) and `DatasetId` members (§4.16.2)** — **none.** §4.16.1 gives 3C no row; the Phase 3 minimal set (`inventory.stock_on_hand`, `inventory.valuation`, `inventory.sales_by_item`) is **3D's**, and hazard 4 is satisfied for Phase 3 by 3D, not by this slice. **`fixtures.ts` helpers (§4.17)** — **`draftTypedDocument` and no others** (a contract addition, declared in the Self-Review). §4.17 assigns 3C no helper, and hazard 9 forbids inventing one beside the register — so this one is declared as a §4.17 amendment before Task 4 uses it, exactly as 2B declared `grantCodes`. Every other row this slice's tests need comes from an existing helper (`seedTenantV2`, `grantCodes`, `seedAccount`, `seedParty`, `seedDocumentType`, `seedUnit`, `seedItem`, `seedWarehouse`, `seedLot`, `seedBranch`, `seedCurrency`, `seedRate`, `postJournal`). **Shared test helpers (§4.17.1)** — **none added.** **`ERR_*` (§4.2.4)** — this slice adds exactly **`ERR_DOC_LINK_OVER_FULFILLED`** (422, already allocated in §4.2.4's table to 3C) to `ERRORS`, **in the same commit as migration 0037**, whose SQL text raises the token, because `scripts/lint/rules/error-codes.ts` scans `packages/db/migrations/**` as well as source and must be green at every commit (2B's precedent). `ERR_VALIDATION_FAILED`, `ERR_NOT_FOUND`, `ERR_RBAC_FORBIDDEN`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_DOC_NO_LINES`, `ERR_STOCK_INSUFFICIENT`, `ERR_CONFLICT_REFERENCE` already exist and are re-used, never re-spelled.
- **Three facts about `Seed` and the fixtures every task below depends on, stated once because getting any of them wrong is a silent failure.** (1) **`Seed` has no `branch` member.** It is `{ tenant; system; human; company; period; closedPeriod; lockedPeriod; cash; sales; docType; policy; branchType; hq }` (§4.1) and `app.document.branch_id` is NOT NULL, so every `branchId:` in this plan is `<seed>.hq`. (2) **`seedTenant` grants `s.human` no permission at all** (§4.1, pinned) — no `role`, no `role_permission`, no `role_assignment`. Every DB-tier test in this plan that posts or issues calls **`grantCodes`** (2B) first, once per `Seed` object; every route test calls `grantAdmin()` (0B) or `grantCodes` with the narrow list. (3) **`seedTenantV2` already creates `1000 Cash` (asset) and `4000 Sales` (income)** — plan0A's pinned constants — so a test needing `2150`, `1310`, `5100`, `1300`, `2100` or `5000` in a Testcontainers tenant creates it with **`seedAccount(db, s, { code, nameEn, type })`**, whose `type` is one of `('asset','liability','equity','income','expense')`.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

## Global Constraints

Copied verbatim from the spec and the contracts document; every task's requirements implicitly include this section.

1. **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (SAH-036/037/069); issue DDL from application code (SAH-053); disable an invariant, constraint or trigger "temporarily" (SAH-027, 041, 053); gate an audit write on any flag (SAH-030); hard-code a package version into a source file — the lockfile owns versions.
2. **Always**, for every new table (spec:106): `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge.
3. **Binding form of a new table** (§3.3): `tenant_id`; RLS enabled **and forced** through `app_meta.enable_tenant_rls`; the policy named exactly `tenant_isolation`; `id uuid primary key default uuidv7()`; `created_at timestamptz not null default now()`; an `audit_row` trigger through `app_meta.attach_audit`; `stamp_<col>` for every `*_by` column through `app_meta.attach_stamp`; composite `(tenant_id, <parent>_id)` FKs to every tenant-scoped parent; a hand-written down file; a two-tenant test. `lintSchema` must report **zero** violations after every migration. **Neither of this slice's two tables has a `*_by` column and neither joins any linter set** (§3.5.3 lists both with dashes in every column), so **`packages/db/src/lint-schema.ts` is not edited by this slice at all** — hazard 13.
4. **Money** is `numeric(19,4)` in Postgres and the opaque `Money` type from `@dulja/domain` in TypeScript; **no `number` ever holds a monetary value** (spec:2041; the `no-number-money` lint, §3.7.5). Quantities are `numeric(19,6)` and the opaque `Quantity`. Rates are `numeric(19,8)`. Every allocation in this slice goes through `Money.allocate`, never through a division and a fudge.
5. **`Money.toBase` rounds `HALF_AWAY_FROM_ZERO` at scale 4** — the only mode satisfying `ledger_entry`'s `check (base_debit = round(debit * exchange_rate, 4))` (spec:1816; hazard 23). Every base figure this slice computes goes through `toBase`.
6. **Sign normalisation is contract, not implementation detail** (§4.4.2 amendment A9; the ⚠️ list names 3B, 3D, 5A, 6A, 8B — and 3C reads planned lines too). `PlannedLedgerLine.amount` is **never negative** and **`side` alone carries the direction**. No code in this slice tests `amount.isNegative()` to decide which way a value moves.
7. **Every query, reads included, runs inside `withTenant`** (spec:2053). A bare `db.` call is a lint violation; only a `tx` obtained from `withTenant` may tag SQL. **`sql.unsafe` has exactly three homes and none is in this slice** (§3.3).
8. **Nothing outside `packages/db/src/posting/` and `packages/db/src/costing/` writes ledger, movement, layer, projection or tax-transaction tables** (§4.3.2; the `posting-only-tables` lint, §3.7.5). This slice's landed-cost seam lives in `packages/db/src/costing/` for exactly that reason. `document_link` and `landed_cost_allocation` are **not** protected tables and are written by their routes.
9. **One migration per PR** (spec:2057); each file runs whole in one transaction; every statement carries a comment naming the SAH-/spec reference it serves; SQL keywords lowercase; section banners `-- ── N. title ───`. No `create index concurrently`, no enum label added and used in one file (§3.4.4 — this slice adds none).
10. **Per-tenant rows cannot be written by a migration** (spec:1366; hazard 10). `document_type`, `posting_policy` and the chart of accounts are **seed-pack data** applied by `bun run seed --tenant <id> --only <sub-pack>`. Only `app.permission` is migration data.
11. **Deletion** (spec:2049): financial rows never; master data `archived_at`; genuine deletion only for drafts and the erasure workflow. **§3.5.4's pinned DELETE grant list is closed and 2B is the only slice that extends it** — so **neither of this slice's tables ever receives a DELETE grant**, and both are designed around that: a link or an allocation is released by deleting the *draft target document* (cascade) or replaced by an upsert, never by a `DELETE` from `app_rw`.
12. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice introduces exactly the four codes §3.6.2 assigns it and no others.
13. **No plan invents a literal in a shared namespace** (hazard 32). Document-type codes and their `module` (§4.14), account codes (§4.15), report codes and `DatasetId` members (§4.16), `fixtures.ts` helper names (§4.17), the `ERR_*` space (§4.2.4). Every literal this slice writes is listed in the Assumptions block above, and the one helper it adds is declared as an amendment in Task 0.
14. **The slice that seeds a policy seeds the accounts that policy names by code** (§4.15, hazard 33). `2150` is named by the `GOODS_RECEIPT` and `SHIPMENT` policies and is seeded by **Task 3 of this plan, before Task 6 seeds either policy**.
15. **The UI is not specified** (spec:79, 108; hazard 29). The screen task begins with OD-24 and targets keyboard parity (spec:2254); no workflow is invented.
16. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [3C T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check` and `bun run typecheck` at the repository root stay green after every task, and so does `bun run test` — **with one inherited exception this slice does not create and cannot close before Task 8**: every `packages/db/test/costing` case that posts a receipt (3B's own Task 7 case at 3b:2736 among them) is red from 3B's merge, because `planMovements` returns `value: null` and `costReceipt` refuses a null (§4.7.2). **Every one of those failures carries `ERR_COST_VALUE_MISSING`, and that code — not a failure count — is how an executor tells the inheritance from a regression. Task 8 Step 4 is what turns them green**; Task 8 Step 9 is where they are re-run. This slice lands no red case of its own — see the Execution handoff.

---

## This slice's share of the Phase 3 definition of done

The Phase 3 row of the phase table, verbatim (spec:2289) — **Definition of done:** "Back-dated purchase recosts only forward, in bounded time, with a visible adjustment entry; FEFO picking returns the earliest-expiring lot; **a landed-cost allocation changes unit cost and every downstream margin**; a stock count posts only the variance; goods in transit are in neither warehouse's on-hand and in the company's total".

| Clause | Owner | Where it is green |
|---|---|---|
| "Back-dated purchase recosts only forward, in bounded time, with a visible adjustment entry" | 3B | re-asserted here in Task 9 for a **back-dated shipment**: the recost the landed cost triggers is the same `inventory.cost.replay` job, and the `COST_ADJUSTMENT` it posts is 3B's |
| "FEFO picking returns the earliest-expiring lot" | 3A | consumed by Task 10's purchase return, which picks the lot explicitly rather than by FEFO |
| **"a landed-cost allocation changes unit cost and every downstream margin"** | **3C** | **Task 9** — allocate freight over a two-item shipment; `cost_layer.unit_cost` moves by exactly the allocated share; a subsequent issue's `cost_consumption.value` and `document_line.cost` move with it; the same shipment re-allocated `by_quantity` produces a different, exactly-summing split |
| "a stock count posts only the variance" | 3D | — |
| "goods in transit are in neither warehouse's on-hand and in the company's total" | 3D | 3C seeds the `1310` account 3D's `TRANSFER` policy names |

**Slice exit (Task 14).** The DoD clause above green in CI, plus tests **5, 7, 14 and 15** re-run and tests **12, 13, 18, 27 and 36** re-run over the two new tables, the four new permission codes and the four new document types; `lintSchema` reports zero violations; `up → down → up` reproduces the schema byte for byte.

---

## File Structure

Every path is relative to the repository root. **NEW** means this slice creates it; **EDIT** means an existing file gains the stated additions and nothing else.

```
packages/db/
├─ migrations/
│  ├─ 0037_create_document_link.sql              NEW  document_link + open-quantity view + guard   T1
│  ├─ 0037.down.sql                              NEW  trigger, function, view, table — reverse     T1
│  ├─ 0038_create_landed_cost_allocation.sql     NEW  landed_cost_allocation (§4.6.1)              T7
│  ├─ 0038.down.sql                              NEW                                               T7
│  ├─ 0039_seed_permission_phase3c.sql           NEW  the four §3.6.2 codes (global rows)          T2
│  └─ 0039.down.sql                              NEW  deletes exactly those four codes            T2
├─ src/
│  ├─ schema/
│  │  ├─ document-link.ts                        NEW  Drizzle mirror (§3.4.9)                       T1
│  │  ├─ document-open-quantity.ts               NEW  Drizzle view mirror                           T1
│  │  └─ landed-cost-allocation.ts               NEW  Drizzle mirror                                T7
│  ├─ documents/
│  │  └─ link.ts                                 NEW  linkFulfilment, openQuantity, unlink-by-draft T4
│  ├─ seed/
│  │  └─ index.ts                                EDIT one line — re-export chartOfAccountsLoader,
│  │                                                  which 0C's barrel only imports               T9
│  ├─ posting/
│  │  └─ reverse.ts                              EDIT the line copy gains l.cost, UNNEGATED        T8
│  └─ costing/
│     ├─ landed-cost.ts                          NEW  allocateLandedCost, landedCostByLine,
│     │                                               landedCostSummary, listLandedCost,
│     │                                               receiptValue — the ONE receipt-value rule    T8
│     └─ apply-movements.ts                      EDIT the receipt-value site becomes the
│                                                     four-branch rule (one call site)             T8
├─ seed/
│  ├─ my/chart-of-accounts/3c-purchasing.json    NEW  2150, 1310, 5100 (§4.15)                      T3
│  └─ my/document-types/
│     ├─ PURCHASE_ORDER.json                     NEW  §4.3.7 envelope, series PO                    T5
│     ├─ GOODS_RECEIPT.json                      NEW  §4.3.7 envelope, series GRN                   T6
│     ├─ SHIPMENT.json                           NEW  §4.3.7 envelope, series SHP                   T9
│     └─ PURCHASE_RETURN.json                    NEW  §4.3.7 envelope, series PR                    T10
├─ test/
│  ├─ fixtures.ts                                EDIT + draftTypedDocument (additively — §4.17)     T0
│  ├─ fixtures-typed-document.test.ts            NEW  the helper's own two cases                    T0
│  ├─ document-link.test.ts                      NEW  DDL, RLS, guard, view, two tenants            T1
│  ├─ landed-cost-allocation.test.ts             NEW  DDL, RLS, upsert, draft guard, two tenants    T7
│  ├─ purchasing/
│  │  ├─ purchase-order.test.ts                  NEW  issue-never-post, open quantity               T5
│  │  ├─ goods-receipt.test.ts                   NEW  GRNI accrual, PO pricing, FOC line            T6
│  │  ├─ landed-cost.test.ts                     NEW  allocation arithmetic, receiptValue,
│  │  │                                               unit cost and margin move (DoD)              T8, T9
│  │  ├─ purchase-return.test.ts                 NEW  issue leg, tests 7, 14 and 18                 T10
│  │  └─ foreign-currency-shipment.test.ts       NEW  the OD-05 FX default, pinned                  T12
│  ├─ seed/chart-of-accounts-3c.test.ts          NEW  the three codes resolve                       T3
│  └─ privileges.test.ts                         EDIT the DELETE list is UNCHANGED — asserted       T1
├─ package.json                                  EDIT no change expected; verified in T14
packages/contracts/
├─ src/
│  ├─ accounting/document-link.ts                NEW  link + open-quantity wire shapes              T4
│  ├─ inventory/landed-cost.ts                   NEW  allocation wire shapes                        T9
│  └─ errors.ts                                  EDIT + ERR_DOC_LINK_OVER_FULFILLED                 T1
├─ permissions.ts                                EDIT + the four §3.6.2 codes                       T2
│                                                     (NOT src/permissions.ts — contracts §3.6.1
│                                                      fixes the spec's literal path, spec:2135)
apps/api/
├─ src/routes/accounting/documents.ts            EDIT + 5 sub-paths, + DOCUMENT_STAGE_CODES rows    T4, T9
├─ src/documents/link-handlers.ts                NEW  the three link handlers                       T4
├─ src/inventory/landed-cost-handlers.ts         NEW  the two landed-cost handlers                  T9
└─ test/routes/accounting/
   ├─ document-links.test.ts                     NEW  route tests incl. idempotency + isolation     T4
   └─ landed-cost.test.ts                        NEW  route tests incl. the three methods           T9
packages/db/seed/roles.ts                        EDIT + the four codes on user/accountant/warehouse T2
tests/
├─ fixtures/document-types/CONSIGNMENT_RETURN.v2.json  NEW policy version 2, inventory-bearing      T11
├─ invariants/zero-code-document-type.test.ts    EDIT + the test-15 re-run describe block           T11
├─ invariants/probes.ts                          EDIT no new PROBES key — asserted in T14           T14
├─ regression/sah-005.test.ts                    EDIT + a "— 3C" describe block                     T14
├─ regression/sah-017.test.ts                    EDIT + a "— 3C" describe block                     T14
└─ regression/sah-049.test.ts                    EDIT + a "— 3C" describe block                     T14
docs/ux/purchasing/                              (OWNER) three screenshots + the operator note      T13
docs/adr/
├─ 0040-fulfilment-links-and-derived-open-quantity.md   NEW                                         T1
└─ 0041-landed-cost-allocation-and-purchase-return-valuation.md  NEW (a proposal)                   T7
docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md  EDIT the amendment PR                     T0, T14
```

**Why there is no new route module, and therefore no new `PROBES` key.** §4.2.7 says "Every `documents` route is generic over document types … a type-specific route is a convention violation", and `PROBES` is keyed by `RouteModule.path` (hazard 31). All five routes this slice adds are **sub-paths on 1A's existing `/v1/companies/:companyId/documents` module**, so they inherit its probe entry exactly as 2B's four routes and 2C's print route do. The two handlers are generic in shape — they refuse a document whose *policy* is the wrong shape, never a document whose *code* is not on a list:

| Method and sub-path | Handler | Gate | Refusal when the policy is wrong |
|---|---|---|---|
| `POST …/documents/{documentId}/links` | `createDocumentLinks` | `requireDocumentPermission("submit")` on the **target** | the target must be a draft (`ERR_DOC_NOT_DRAFT`); the source must be `issued` or `posted` (`ERR_VALIDATION_FAILED`) |
| `GET …/documents/{documentId}/links` | `listDocumentLinks` | `requireDocumentModuleRead()` | — |
| `GET …/documents/{documentId}/open-quantity` | `getOpenQuantity` | `requireDocumentModuleRead()` | — |
| `POST …/documents/{documentId}/landed-cost` | `allocateLandedCostHandler` | `requireDocumentPermission("submit")` | `policy.inventory.effect` must be `"receipt"` (`ERR_VALIDATION_FAILED` naming the type and the effect) |
| `GET …/documents/{documentId}/landed-cost` | `listLandedCost` | `requireDocumentModuleRead()` | — |

**The stage is `"submit"` and not `"create"`, and the reason is 2A's merged middleware rather than a preference.** §4.5.4 maps **create *and* submit** to the same code, `approval.create ?? approval.post` (2a:2867–2871, `codeFor`), so both stages ask for exactly the authority these two routes need: "may this principal edit this draft". They differ in *how the policy is found*. 2A's `"create"` branch is written for `POST /v1/companies/{companyId}/documents`, where no document exists yet: it reads **`body.documentTypeCode` and `body.effectiveDate`** and raises `ERR_NOT_FOUND` when either is absent (2a:2897–2906). Neither of this slice's bodies carries them — the document is named by `:documentId` — so `requireDocumentPermission("create")` would 404 **every** request to both routes, before the handler ran. Every other stage, `"submit"` included, takes the `:documentId` branch (2a:2909–2915), loads the document, resolves the policy effective for its own `effective_date` and calls `app.actor_has` with the resolved code. `"submit"` is therefore the stage that means "resolve the create-authority of the document I am pointing at", and it is the one to use on any `POST` sub-path of an existing document. Task 0 Step 6 registers this so 3D's `DELIVERY_ORDER` links and `count-sheet` routes do not rediscover it. **`DOCUMENT_STAGE_CODES` is unaffected** — the code set is the same either way (Task 2 Step 6 adds the four codes).

**Two register discrepancies this plan resolves, both in favour of the register (hazard 32).** (1) The §2.4 card's prose calls the link quantity `linked_quantity`; **§4.6.1's register — the DDL authority — names the columns `quantity numeric(19,6)` and `amount numeric(19,4)`**, and `linked_quantity` is the name of the *derived* column in the `document_open_quantity` view. The plan implements §4.6.1. (2) §4.3.2's closed write list admits `document_link` for "3C+, fulfilment quantities"; **this slice does not use that allowance** — links are written by `createDocumentLinks` on the draft target and by nothing else, so `postDocument` gains no new write and the `posting-only-tables` lint needs no change. The allowance stays open for a later slice.

---

### Task 0: The contracts amendment PR — four names, one helper, before any of them is used

**Files:**
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`

**Interfaces:**
- Consumes: nothing. This task writes no code.
- Produces: the register rows every later task cites. Nothing in Tasks 1–14 may reference a name this task has not landed.

Hazard 32 makes an unregistered literal in a shared namespace a review-blocking finding, and hazard 9 forbids inventing a `fixtures.ts` helper beside §4.17's register. Five names in this plan are new. They are landed here, in one small documentation PR, before Task 1 — the same shape as 2B's Task 12 Step 1 and 2C's Task 0.

- [ ] **Step 1: Add the `draftTypedDocument` row to §4.17**

In the §4.17 table, immediately after the `seedLot` row, insert:

```markdown
| `draftTypedDocument(db, s, opts: { documentTypeId; series; effectiveDate?; currency?; exchangeRate?; partyId?; warehouseId?; toWarehouseId?; branchId?; lines })` | 3C | `{ documentId: string; lineIds: string[] }` | the generic "draft a document of any type with any lines" builder. `draftDocument` (§4.1) is JOURNAL-only — it hard-codes `s.docType` and series `'JV'` — and every slice from 3C on needs item, account and text lines on a configured type. `lines` is `readonly DraftLine[]` with `DraftLine = { kind: "account" \| "item" \| "tax" \| "text"; lineNo?: number; description?: string; accountId?: string; itemId?: string; warehouseId?: string; lotId?: string; unitId?: string; quantity?: string; unitQuantity?: string; unitPrice?: string; discount?: string; amount?: string; debit?: string; credit?: string; dimensions?: Record<string, string>; customFields?: Record<string, unknown> }`; every money and quantity value is a **string** at the caller (`no-number-money`, §3.7.5) and reaches the row as a `numeric` literal. Consumed by 3D (`SALES_ORDER`, `DELIVERY_ORDER`, `TRANSFER`, `STOCK_COUNT`), 4A, 6A and 8B |
```

- [ ] **Step 2: Add the two table rows to §4.6.1's register footnote and the view to §4.6.1**

Immediately after the `landed_cost_allocation` row of the §4.6.1 register, insert:

```markdown
| `document_open_quantity` (**a VIEW, not a table**) | 3C / 0037 | `create view app.document_open_quantity with (security_invoker = true)` over `document_line` and `document_link`: `tenant_id`, `company_id`, `document_id`, `document_line_id`, `line_no`, `item_id`, `ordered_quantity`, `linked_quantity`, `open_quantity`. It is a **view** and not a projection table because §3.5.3 pre-declares no linter-set membership for it, and hazard 13 forbids a slice adding one — a projection table would need `NO_ID_TABLES` and `AUDIT_EXEMPT` rows like `stock_on_hand` has. `security_invoker = true` is mandatory: without it the view would run with `app_migrator`'s privileges and bypass `tenant_isolation` on both base tables. The linter never sees it (`relkind = 'v'`, and its filters are `relkind in ('r','p')`) |
```

- [ ] **Step 3: Verify — do not restate — 3B's amendment A4, and record the one consequence it leaves open**

**3B already settled the currency of `document_line.cost`, in the opposite direction to this plan's first draft, and 3B is right.** 3B's amendment **A4** (3b:38, Task 5) makes `document_line.cost` and `LineSnapshot.cost` **base currency**, adds `role: "cost"` to `PlannedLedgerLine`, and has the evaluator copy a cost amount into `base` at rate `1.00000000` instead of calling `toBase` — because a cost layer outlives the exchange rate of the document that created it, and §4.7.3 already declares `inventory_movement.value` and `cost_layer.unit_cost` base. This plan **consumes** that rule and adds nothing to §4.3.4. Verify it has landed before Task 6:

```bash
grep -n "COST_AMOUNT_REFS" packages/domain/src/posting/evaluate.ts
grep -n 'role: "cost"' packages/domain/src/posting/evaluate.ts
```

Expected: both print a line. If either is silent, **stop** — 3B's Task 5 has not merged, and every `line.cost` leg this slice seeds would be converted a second time and die on `ledger_entry`'s `check (base_debit = round(debit * exchange_rate, 4))`.

The consequence A4 leaves open is the only thing this step records. Append to §4.3.4, after the `document_type` additions sentence:

```markdown
**A cost-derived ledger leg may only be paired with another cost-derived leg — never with `line.amount` (3C, consuming 3B's A4 and A5).** This is the consequence A4 leaves open, and it is a hard rule rather than a style preference, because of *when* the two figures exist. `LineSnapshot.cost` is `null` on a fresh draft; §4.3.2 **step 6** emits a `line.cost` leg at `Money.zero` (A5's exemption) and then runs `balanceInBase` **immediately, before any insert**, raising `ERR_LEDGER_UNBALANCED` when the residue exceeds `0.01 × lines`. Step 9's `applyMovements` is what fills the cost, and 3B re-loads the snapshot and re-evaluates after it (3b:3172–3180) — but that second evaluation is reached only if the *first* one balanced. So:

- **A policy whose legs are cost/cost balances at step 6 as `0 = 0`**, is filled at step 9 and re-balanced at its real figures. This is 3B's `STOCK_ISSUE_TEST` shape (3b:2556–2557), and it is this slice's **`PURCHASE_RETURN`** shape (Task 10).
- **A policy pairing one cost leg against one `line.amount` leg cannot post at all.** With cost null the plan is `0` against the full amount, the residue is the whole document, and step 6 refuses it. This is why 3B's own receipt policy (3b:2580–2581) puts **`line.amount` on both legs** and reads `document_line.cost` only for the layer.
- **Therefore a *receipt* policy's ledger legs are all `line.amount`, and the capitalised freight reaches the inventory account through the freight line's own debit** (`account: { code: "1300" }`, `when: { "line.kind": "account" }`), not through a cost reference. The inventory account still equals the layer to the cent — Σ debits to inventory is `goods amount + Σ freight amounts`, and §4.7.2's `receiptValue` makes the layer `toBase(line.amount + Σ allocated, rate)` from the same two figures — but it gets there by addition rather than by reading a column that does not exist yet.

Per-line `toBase` residues across several lines can differ from the total's by a cent; `balanceInBase`'s `fxRoundingAccount` line (§4.4.2) absorbs it — the mechanism spec:1868 already provides. **3C's `GOODS_RECEIPT`, `SHIPMENT` (receipt: all `line.amount`) and `PURCHASE_RETURN` (issue: all `line.cost`) are the first three policies bound by this rule; 3D's `DELIVERY_ORDER` and `TRANSFER` and 4A's `SALES_INVOICE` are the next, and a plan that pairs the two references on one document is refused by the database rather than by review.**
```

- [ ] **Step 4: Record the receipt-value rule in §4.7.2**

At the end of §4.7.2, after the paragraph about rows posted between 3A and 3B, add:

```markdown
**A receipt movement's value — the four-branch rule, and the null it closes (3C, superseding 3A's provisional rule).** `planMovements` (3A) returns every movement with `value: null` (3a:4930), and 3B's `costReceipt` raises `ERR_COST_VALUE_MISSING` on a null value (3b:994) while 3B's `applyMovements` passes a receipt's `movement.value` through untouched (3b:2990) — so **between 3B and 3C no receipt can post at all**, and 3B's own Task 7 case expecting `value: "1000.0000"` is red until this rule lands. 3C closes it, in the one place a receipt's value is decided, `packages/db/src/costing/landed-cost.ts`:

    export function receiptValue(line: LineSnapshot, landedCost: Money, rate: ExchangeRate): Money;
    export async function landedCostByLine(tx: Sql, documentId: string): Promise<Map<string, string>>;

`receiptValue` is `toBase(line.amount.add(landedCost), rate)`. `line.amount` and not `round(unit_price × quantity, 4)`: §4.3.4 defines `amount` as "excl. tax, document currency", which is the discount-correct figure, and 3A's provisional rule ignored `document_line.discount`. `landedCostByLine` is keyed by `document_line.id` with a **document-currency** decimal string as its value; a document with no allocation yields an empty map, and `receiptValue` is then `toBase(line.amount, rate)`.

**`applyMovements` calls it at exactly one site, and the rule there has four branches in this order — a receipt whose value comes from somewhere else must not be overwritten:**

1. **`snapshot.lines[i].cost !== null` → that cost.** A4 makes it base currency and a magnitude already, so it is used as it stands. **This branch is reachable only because 3C adds one column to `reverseDocument`'s line copy — `l.cost`, unnegated.** 2A widened that copy to `kind, item_id, quantity, unit_price, discount, amount` and 3A to `warehouse_id, lot_id, unit_id, unit_quantity` (3a:4270); `cost` was left out, so a reversal of a stock **issue** — which emits a *receipt* of the returned goods — would reach branch 3 and value that receipt at the negated **sale** price instead of the carrying cost. `cost` is a magnitude, so it is copied and not negated, and step 5 of `applyMovements` overwrites it with the same number, which makes the copy idempotent. 3D's `DELIVERY_ORDER` and 4A's `SALES_INVOICE` reversals depend on this column.
2. **else, a same-`lineNo` `issue` movement exists → that leg's computed value.** A `transfer` line emits an issue at `warehouse_id` and a receipt at `to_warehouse_id` (§4.7.3); the receipt leg's value is what left the first warehouse, never a re-priced `line.amount`. 3D's `TRANSFER`/`TRANSFER_RECEIPT` depend on this branch.
3. **else → `receiptValue(line, landedCost, rate)`.** The genuine purchase-side receipt: `GOODS_RECEIPT`, `SHIPMENT`, 9B's `OPENING_STOCK`.
4. **else — no line at all for the movement's `lineNo` → `null`, explicitly**, and `costingEngine` raises `ERR_COST_VALUE_MISSING` naming the movement (SAH-007). The fall-through is written out rather than defaulted to zero: a movement with no source line is an internal inconsistency, and a zero would silently create a free receipt and a zero-cost layer that every later margin reads.

**The allocation reaches the layer once, through the movement's value, and every later replay preserves it.** `inventory_movement` is immutable and 3B's `replay` recomputes a receipt's layer as `unit_cost = value / quantity` from that immutable value (3b:4073–4079), which is why 3B's own comment calls landed cost "the one thing that legitimately changes a receipt's value". Landed cost is therefore a **draft-only** operation: after post there is nothing to re-allocate, and a correction is `reverseDocument` plus a re-post.
```

- [ ] **Step 5: Add the contracts-module rows to §4.2.8 and the sub-paths to §4.2.7**

In §4.2.8's module-name table, after the `accounting/print.ts` row, add:

```markdown
| `accounting/document-link.ts` | `LinkKindSchema`, `DocumentLinkSchema`, `CreateDocumentLinksBody`, `DocumentLinkList`, `OpenQuantitySchema`, `OpenQuantityList` | 3C |
| `inventory/landed-cost.ts` | `LandedCostMethodSchema`, `AllocateLandedCostBody`, `LandedCostAllocationSchema`, `LandedCostAllocationList`, `LandedCostSummarySchema` | 3C |
```

Then, immediately after §4.2.8's `MoneySchema` line, add the exception these two modules take — because §4.2.8's rule is "Money is always `{ amount, currency }`" and a slice wanting an exception amends the paragraph first:

```markdown
**The one exception: a money field on a sub-resource of a single document is a bare 4-dp decimal string (3C).** `z.string().regex(/^-?\d+\.\d{4}$/)`, with **no `currency` member**, in `accounting/document-link.ts` (`DocumentLinkSchema.amount`) and `inventory/landed-cost.ts` (`LandedCostAllocationSchema.allocatedAmount`, `LandedCostSummarySchema.lineAmount` / `allocated` / `landedAmount`). Two reasons, and both are about where the currency lives. (1) `app.document_link` **has no currency column** (§4.6.1) — the currency is the *document's*, and emitting `{ amount, currency }` would mean joining `app.document` on every link read to restate a value the caller already has from the document it just fetched. (2) Every one of these figures is returned under a path that already names the document (`…/documents/{documentId}/links`, `…/landed-cost`), so the currency is fixed for the whole response and repeating it per row is noise a client cannot use to disambiguate anything. The rule this exception does **not** touch: the `Money` *type* is still what computes every one of these numbers (`landedCostSummary` does the addition in `Money`, Global Constraint 4), the scale is still 4, and `no-number-money` still forbids a `number`. A **top-level** resource carrying money — anything whose currency is not implied by its own path — keeps `MoneySchema`, so this is an exception for document sub-resources and not a second general spelling.
```

In §4.2.7's "Sub-paths the scheme above does not spell out" paragraph, after 2C's two entries, add: **by 3C, on 1A's `documents` module: `POST` and `GET …/documents/{documentId}/links`, `GET …/documents/{documentId}/open-quantity`, `POST` and `GET …/documents/{documentId}/landed-cost` — five sub-paths, no new module, no new `PROBES` key. Every `POST` sub-path of an existing document is gated `requireDocumentPermission("submit")`, never `"create"` — §4.5.4's `"create"` branch resolves the type from the request body and 404s when the body does not carry one (see §4.5.4's note below).**

And in §4.5.4, after the paragraph that describes `requireDocumentPermission`, add:

```markdown
**`"create"` is for `POST …/documents` only; a `POST` sub-path of an existing document uses `"submit"` (3C).** The two stages resolve the **same** code — `approval.create ?? approval.post` — but `"create"` finds the policy through `body.documentTypeCode` + `body.effectiveDate` and raises `ERR_NOT_FOUND` when either is missing (2a:2897–2906), while every other stage loads the document named by `:documentId` (2a:2909–2915). So a sub-path route whose body carries no type would 404 on the gate under `"create"` and never reach its handler. 3C's `…/links` and `…/landed-cost` use `"submit"`; 3D's `…/count-sheet` and `…/links` and 4A's allocation sub-paths inherit the rule.
```

- [ ] **Step 6: Register the fourteen test-only document-type codes in §4.14, then add the round-3 amendment rows**

**First, §4.14, and it is not optional.** Hazard 32 makes an unregistered document-type code a review-blocking finding, and §4.14's *test only* paragraph is explicit that its rows "are registered here because hazard 32 makes an unregistered document-type code a review-blocking finding, **not** because they are packaged: none of them is ever a file under `packages/db/seed/my/document-types/` … each exists only as a `seedDocumentType` call or a request body inside a test." So "it never reaches a seed pack" is the *reason the mark exists*, not an exemption from registering. 2A registered `POLICY_TEST`/`POLICY_TEST_2`, 2B `GAP_TEST`/`NG_NG`/`NG_RC`/`NG_HT`/`SOD_TEST`, 3A its four and 8B `PAYROLL_DDL_TEST` on exactly this rule. This slice configures fourteen file-local codes through `seedDocumentType`, so all fourteen land here, grouped the way 2B's three `NG_*` codes are. In the §4.14 register table, immediately after the `PAYROLL_DDL_TEST` row, insert:

```markdown
| `TYPED_TEST`, `TYPED_TEST_2` | 3C (**test only**) | `inventory` | none / none / `approval: { required: false, approve: null, post: "accounting.journal.post" }` | `TT`, `TT2` | `draftTypedDocument`'s own two cases (3C Task 0). Two are needed, not one: the first proves an item line and a text line come back in `line_no` order, the second that warehouse, lot, unit, `dimensions` and `customFields` reach the row — and a second type keeps the second case's `CARTON` unit and `weight_kg` custom field off the first case's series. Never a file under `packages/db/seed/` |
| `LINK_ORDER`, `LINK_RECEIPT` | 3C (**test only**) | `inventory` | none / none / `post: "accounting.journal.post"` | `LO`, `LR` | migration 0037's own suite (3C Task 1) needs a *pair* of types — the source of a link and its target — because `app.document_link` has `check (source_document_id <> target_document_id)` and the two partial unique indexes key a source/target pair. Both are configured in **two tenants** by the isolation case. Never a file under `packages/db/seed/` |
| `API_ORDER`, `API_RECEIPT` | 3C (**test only**) | `inventory` | none / none / `API_ORDER` `post: "accounting.purchase.create"`; `API_RECEIPT` `post: "inventory.receipt.post"`, `create: "inventory.receipt.create"` | `AO`, `AR` | the `…/documents/{id}/links` route suite (3C Task 4). These are the two rows in this group that **name 3C's own permission codes**, which is why 3C Task 2 must merge before Task 4: `validatePolicy` raises `ERR_POLICY_INVALID` on an `approval` code absent from the catalogue (F-21). Never a file under `packages/db/seed/` |
| `LCA_SHIP`, `LCA_ZERO`, `LCA_BAD`, `LCA_ISSUED`, `LCA_CROSS`, `LCA_CASCADE`, `LCA_ISO`, `LCA_AUDIT` | 3C (**test only**) | `inventory` | none / none / `post: "accounting.journal.post"` | `LS`, `LZ`, `LB`, `LI`, `LX`, `LC`, `LO`, `LA` | migration 0038's suite (3C Task 7): one type per case, so that a case which drives a document to `issued` (`LCA_ISSUED`) or deletes its draft (`LCA_CASCADE`) cannot disturb the document another case is asserting over, and so each case's series is its own. All eight share one policy shape and differ only in code and series. `LCA_ISO` is configured in both tenants. Never a file under `packages/db/seed/` |
```

Then amend §4.14's count sentence — `**Thirteen rows are marked *test only*, and the mark is binding.**` becomes `**Twenty-seven rows are marked *test only*, and the mark is binding.**`, and its enumeration gains `, **3C's fourteen** (`TYPED_TEST`, `TYPED_TEST_2`, `LINK_ORDER`, `LINK_RECEIPT`, `API_ORDER`, `API_RECEIPT` and the eight `LCA_*`)` after `**`PAYROLL_DDL_TEST` (8B)**`.

**Hazard 33 does not bite on any of the fourteen.** Every one of these policies has `lines: []` — they plan no ledger line at all, so no `account: { code }` literal appears in any of them and there is nothing for a seeded company to resolve. That is the same reason §4.14's hazard-33 paragraph gives for the 2A/2B/2C rows, and the fourteen are added to its "does not bite" list rather than to `COST_LINE_TEST`'s exception.

**Then, §4.18.** At the end of §4.18, add a `### Round 3 — from plans 3A, 3B, 3C, 3D … (2026-09-07)` heading if it does not exist, then these rows:

```markdown
| 4.17 | `draftTypedDocument(db, s, opts)` → `{ documentId; lineIds }` — the generic typed-document draft builder; `draftDocument` stays JOURNAL-only | 3C | plan |
| **4.14** | **3C's fourteen test-only codes** — `TYPED_TEST`/`TT`, `TYPED_TEST_2`/`TT2` (T0); `LINK_ORDER`/`LO`, `LINK_RECEIPT`/`LR` (T1); `API_ORDER`/`AO`, `API_RECEIPT`/`AR` (T4); `LCA_SHIP`/`LS`, `LCA_ZERO`/`LZ`, `LCA_BAD`/`LB`, `LCA_ISSUED`/`LI`, `LCA_CROSS`/`LX`, `LCA_CASCADE`/`LC`, `LCA_ISO`/`LO`, `LCA_AUDIT`/`LA` (T7) — all module `inventory`, all `direction: "none"` / `inventory.effect: "none"` / `lines: []`, none ever a file under `packages/db/seed/`. Registered because hazard 32 makes an unregistered document-type code review-blocking and §4.14's *test only* mark is a registration requirement, not an exemption. **`API_ORDER` and `API_RECEIPT` are the only two that name a 3C permission code**, which is what puts Task 2 before Task 4. **Hazard 33 does not engage on any of them** — `lines: []` means no `account: { code }` literal exists to resolve. The test-only count becomes **twenty-seven** | 3C | plan |
| 4.6.1 | `app.document_open_quantity` is a **`security_invoker` VIEW**, not a projection table — §3.5.3 pre-declares no set membership for it and hazard 13 forbids adding one | 3C | correction |
| 4.3.4, 4.3.2 | **3B's A4 stands: `document_line.cost` is BASE currency.** 3C's first draft claimed document currency and is withdrawn. What 3C records instead is the consequence A4 and A5 leave open: **a cost-derived ledger leg may only be paired with another cost-derived leg.** §4.3.2 step 6 runs `balanceInBase` before step 9 fills the cost, so a cost/`line.amount` pair is refused with `ERR_LEDGER_UNBALANCED` on the *first* evaluation and never reaches 3B's re-evaluation. A **receipt** policy is therefore all `line.amount` (3b:2580–2581's shape) with capitalised freight debiting `1300` from the freight line, and an **issue** policy is all `line.cost` (3b:2556–2557's shape). Binds 3D's `DELIVERY_ORDER`/`TRANSFER` and 4A's `SALES_INVOICE` | 3C, 3B | settlement |
| 4.7.2 | **The receipt-value rule has four branches** — a non-null `LineSnapshot.cost`, else the same-`lineNo` issue leg's value (the `transfer` case), else **`receiptValue(line, landedCost, rate)`** = `toBase(line.amount + landedCost, rate)`, else **an explicit `null`** so `costingEngine` raises `ERR_COST_VALUE_MISSING` on a movement with no source line (SAH-007) rather than valuing it at zero. It supersedes 3A's provisional `unit_price × quantity` **and closes the null 3B leaves**: `planMovements` returns `value: null` and `costReceipt` refuses a null, so no receipt posts between 3B and 3C. `landedCostByLine(tx, documentId)` is the companion reader; landed cost is **draft-only**, because `replay` recomputes `unit_cost` from the immutable movement value | 3C | correction |
| 4.2.8 | **One money-on-the-wire exception, scoped to document sub-resources**: `DocumentLinkSchema.amount` and the four `inventory/landed-cost.ts` money fields are bare `z.string().regex(/^-?\d+\.\d{4}$/)` with no `currency` member, because `app.document_link` carries no currency column and every one of these rows is returned under a path that already names the document whose currency it is. The `Money` type still does the arithmetic and `no-number-money` still binds. A top-level money-bearing resource keeps `MoneySchema` | 3C | correction |
| 4.5.4, 4.2.7 | **`requireDocumentPermission("create")` is for `POST …/documents` only.** Its `"create"` branch resolves the policy from `body.documentTypeCode` + `body.effectiveDate` and raises `ERR_NOT_FOUND` when either is absent (2a:2897–2906); every other stage loads `:documentId` (2a:2909–2915). A `POST` **sub-path** of an existing document therefore uses **`"submit"`**, which §4.5.4 maps to the same code (`approval.create ?? approval.post`, 2a:2867–2871). Binds 3C's `…/links` and `…/landed-cost`, 3D's `…/links` and `…/count-sheet`, and 4A's allocation sub-paths | 3C | correction |
| 4.5.8 | **`MODULE_READ_CODE`, `requireAttachmentRead`, `readableModules` and `requireDocumentModuleRead` are in `apps/api/src/middleware/require-attachment-read.ts`**, not in `apps/api/src/routes/accounting/attachments.ts` as §4.5.8's prose says. 2C's merged plan puts all four in that one file and says why (2c:1794, 2c:4591 "the same file — one map, one home"), and 2C's own consumers import from there (2c:2144, 2c:5013). The prose is corrected to the file 2C shipped; the "one home, one map" rule it states is unchanged | 3C | correction |
| 4.6.1 | `landed_cost_allocation` gains `unique (cost_line_id, target_line_id)` (the upsert key — SAH-049), `check (allocated_amount >= 0)`, and a `landed_cost_allocation_draft_only` trigger reusing `ERR_DOC_NOT_DRAFT`; `company_id` is in the standard set and `method` is NOT NULL | 3C | correction |
| 4.2.7, 4.2.8 | 3C's five `documents` sub-paths and its two contracts modules; **no new route module and no new `PROBES` key** | 3C | plan |
| 2.4 (3C card), 4.6.1 | The card's prose `linked_quantity` yields to the register's `quantity`/`amount`; `linked_quantity` is the view's derived column | 3C | correction |
| 2.4 (3C card) | §4.3.2's `document_link` write allowance for `postDocument` **goes unused** — links are written by the route on the draft target | 3C | plan |
| 2.4 (3C card), 4.14 | `GOODS_RECEIPT` and `SHIPMENT` share **one** four-rule policy shape — the item line debits `item.inventory_account` and credits `2150` at `line.amount`; every freight/duty/clearance `account` line debits `1300` and credits `line.account` at `line.amount` — and differ only in `requires` and in which paperwork the warehouse files against them. The landed-cost route is what makes a `SHIPMENT` a shipment | 3C | plan |
| 4.15 | **`1300` inventory control gains a second resolver: the freight/duty/clearance debit of `GOODS_RECEIPT` and `SHIPMENT` (3C).** The register row lists `item.inventory_account_id` default and `COST_ADJUSTMENT`; a receipt's capitalised-freight debit is the third, and it is an `account: { code }` literal, so hazard 33 applies — `1300` is **0C's** and Task 3 asserts it resolves rather than re-seeding it | 3C | correction |
| 4.3.1 | **`reverseDocument`'s line copy gains `l.cost`, unnegated** — 2A widened it to six columns and 3A to four more, and the omission makes a reversal of a stock issue value the returned goods at the sale price. Binds 3D and 4A | 3C | correction |
| 3.7.3 | `sah-005`'s creator is **0D** (§2.1's 0D card, "transactional enqueue"); 3B's header names 0B. 3C **appends** either way | 3C | correction |
```

- [ ] **Step 7: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
git commit -m "docs(contracts): register 3C's names — draftTypedDocument, the open-quantity view, the cost currency and receipt-value rules [3C T0]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 8: Write the failing test for the helper — `packages/db/test/fixtures-typed-document.test.ts`**

Every test from Task 1 onward drafts a document of a configured type with real lines, and `draftDocument` (§4.1) is JOURNAL-only. The helper is registered by Step 1; this step is where it exists.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { draftTypedDocument, seedDocumentType, seedItem, seedTenantV2, seedUnit, startDb, withTenant, type Db, type Seed } from "./index";

let db: Db;
let s: Seed;

beforeAll(async () => { db = await startDb(); s = await seedTenantV2(db, "typed-doc"); }, 180_000);
afterAll(async () => { await db.stop(); });

describe("draftTypedDocument — contracts §4.17 (3C)", () => {
  it("drafts a document of a configured type with an item line and a text line, and returns line ids in order", async () => {
    const documentTypeId = await seedDocumentType(db, s, {
      code: "TYPED_TEST", module: "inventory",
      policy: {
        version: 1, documentType: "TYPED_TEST", direction: "none", requires: [], lines: [],
        inventory: { effect: "none" }, tax: { applies: false },
        numbering: { series: "TT", assignAt: "issue" },
        reversal: { allowed: false, producesType: null },
        approval: { required: false, approve: null, post: "accounting.journal.post" },
        fxRoundingAccount: { from: "company.fx_rounding_account_id" },
        dimensions: { required: [] },
      },
    });
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "TYPED-ITEM" });

    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId, series: "TT", effectiveDate: "2026-01-20",
      lines: [
        { kind: "item", itemId, unitId: baseUnitId, quantity: "7.500000", unitPrice: "3.2500", amount: "24.3750" },
        { kind: "text", description: "free-text note" },
      ],
    });

    expect(lineIds).toHaveLength(2);
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { id: string; line_no: number; kind: string; quantity: string | null; amount: string; description: string | null }[]
    >`select id, line_no, kind, quantity::text as quantity, amount::text as amount, description
        from app.document_line where document_id = ${documentId} order by line_no`);
    expect(rows.map((r) => r.id)).toEqual(lineIds);
    expect(rows[0]).toMatchObject({ line_no: 1, kind: "item", quantity: "7.500000", amount: "24.3750" });
    expect(rows[1]).toMatchObject({ line_no: 2, kind: "text", quantity: null, amount: "0.0000", description: "free-text note" });

    const [header] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { status: string; series: string; effective_date: string; currency: string; branch_id: string; number: string | null }[]
    >`select status::text as status, series, effective_date::text as effective_date, currency, branch_id, number::text as number
        from app.document where id = ${documentId}`);
    expect(header).toMatchObject({ status: "draft", series: "TT", effective_date: "2026-01-20", currency: "MYR", branch_id: s.hq, number: null });
  });

  it("carries warehouse, lot, unit, dimensions and customFields through to the row", async () => {
    const documentTypeId = await seedDocumentType(db, s, {
      code: "TYPED_TEST_2", module: "inventory",
      policy: {
        version: 1, documentType: "TYPED_TEST_2", direction: "none", requires: [], lines: [],
        inventory: { effect: "none" }, tax: { applies: false },
        numbering: { series: "TT2", assignAt: "issue" },
        reversal: { allowed: false, producesType: null },
        approval: { required: false, approve: null, post: "accounting.journal.post" },
        fxRoundingAccount: { from: "company.fx_rounding_account_id" },
        dimensions: { required: [] },
      },
    });
    const unitId = await seedUnit(db, s, { code: "CARTON" });
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "TYPED-ITEM-2" });

    const { lineIds } = await draftTypedDocument(db, s, {
      documentTypeId, series: "TT2",
      lines: [{
        kind: "item", itemId, unitId: baseUnitId, quantity: "12.000000",
        unitQuantity: "1.000000", unitPrice: "60.0000", amount: "60.0000",
        customFields: { weight_kg: "18.400000" }, dimensions: {},
      }],
    });
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { unit_id: string; unit_quantity: string; custom_fields: Record<string, unknown> }[]
    >`select unit_id, unit_quantity::text as unit_quantity, custom_fields
        from app.document_line where id = ${lineIds[0]!}`);
    expect(row).toMatchObject({ unit_id: baseUnitId, unit_quantity: "1.000000", custom_fields: { weight_kg: "18.400000" } });
    expect(unitId).toBeTruthy();
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/fixtures-typed-document.test.ts`
Expected: **FAIL** — `draftTypedDocument is not a function` (TypeScript reports "has no exported member 'draftTypedDocument'" first).

- [ ] **Step 10: Append `draftTypedDocument` to `packages/db/test/fixtures.ts`**

Additively, at the end of the file. Nothing existing is edited — `seedTenant`, `draftDocument` and every constant stay exactly as Plan 0A wrote them (§4.1, hazard 9).

```ts
/** One line as accepted by `draftTypedDocument`. Every money and quantity value is a STRING (no-number-money, §3.7.5). */
export interface DraftLine {
  kind: "account" | "item" | "tax" | "text";
  lineNo?: number;
  description?: string;
  accountId?: string;
  itemId?: string;
  warehouseId?: string;
  lotId?: string;
  unitId?: string;
  quantity?: string;
  unitQuantity?: string;
  unitPrice?: string;
  discount?: string;
  amount?: string;
  debit?: string;
  credit?: string;
  dimensions?: Record<string, string>;
  customFields?: Record<string, unknown>;
}

export interface DraftTypedDocumentOptions {
  documentTypeId: string;
  series: string;
  effectiveDate?: string;
  currency?: string;
  exchangeRate?: string;
  partyId?: string;
  warehouseId?: string;
  toWarehouseId?: string;
  branchId?: string;
  clientRef?: string;
  lines: readonly DraftLine[];
}

/**
 * Drafts a document of ANY configured type with any lines, and returns the header id and the line ids in
 * `line_no` order. `draftDocument` (Plan 0A) is JOURNAL-only — it hard-codes `s.docType` and series `'JV'` —
 * and every slice from 3C on configures its own types. The number stays null: numbering happens at issue,
 * in the posting service, never here (§4.3.6).
 */
export async function draftTypedDocument(
  db: Db, s: Seed, opts: DraftTypedDocumentOptions,
): Promise<{ documentId: string; lineIds: string[] }> {
  const documentId = await uuidv7(db.admin);
  const lineIds: string[] = [];
  for (let i = 0; i < opts.lines.length; i += 1) lineIds.push(await uuidv7(db.admin));

  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`
      insert into app.document
        (id, tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date,
         currency, exchange_rate, party_id, warehouse_id, to_warehouse_id, branch_id, client_ref)
      values (${documentId}, ${s.tenant}, ${s.company}, ${opts.documentTypeId}, ${opts.series},
              ${s.period}, ${opts.effectiveDate ?? "2026-01-15"},
              ${opts.currency ?? "MYR"}, ${opts.exchangeRate ?? "1.00000000"},
              ${opts.partyId ?? null}, ${opts.warehouseId ?? null}, ${opts.toWarehouseId ?? null},
              ${opts.branchId ?? s.hq}, ${opts.clientRef ?? null})`;
    for (let i = 0; i < opts.lines.length; i += 1) {
      const l = opts.lines[i]!;
      await tx`
        insert into app.document_line
          (id, tenant_id, company_id, document_id, line_no, kind, description, account_id, item_id,
           warehouse_id, lot_id, unit_id, quantity, unit_quantity, unit_price, discount, amount,
           debit, credit, dimensions, custom_fields)
        values (${lineIds[i]!}, ${s.tenant}, ${s.company}, ${documentId}, ${l.lineNo ?? i + 1},
                ${l.kind}, ${l.description ?? null}, ${l.accountId ?? null}, ${l.itemId ?? null},
                ${l.warehouseId ?? null}, ${l.lotId ?? null}, ${l.unitId ?? null},
                ${l.quantity ?? null}, ${l.unitQuantity ?? null}, ${l.unitPrice ?? null},
                ${l.discount ?? "0"}, ${l.amount ?? "0"}, ${l.debit ?? "0"}, ${l.credit ?? "0"},
                ${JSON.stringify(l.dimensions ?? {})}::jsonb, ${JSON.stringify(l.customFields ?? {})}::jsonb)`;
    }
  });
  return { documentId, lineIds };
}
```

**Two notes the implementer needs.** `posting_policy_id` is **not** written: 1A's `draftDocument` writes `s.policy` because a JOURNAL draft in Plan 0A's fixture predates the pin rule, but §4.3.2 step 13 is what pins the policy at post and §4.3.1's `reverseDocument` reads that pin — writing a guess here would give an unposted draft a pin it did not earn. The column is nullable (plan0A migration 0001). And `exchange_rate` defaults to `"1.00000000"` rather than being omitted, so the FX cases in Tasks 9 and 12 differ from the default in exactly one visible parameter.

- [ ] **Step 11: Run the test to verify it passes**

Run: `cd packages/db && bun run test -- test/fixtures-typed-document.test.ts`
Expected: **PASS** (2 tests).

One failure worth naming in advance: if the insert reports `null value in column "posting_policy_id"`, 1A added a NOT NULL to that column after the contracts were frozen — in that case pass `${s.policy}` and raise it as a finding against §4.3.2 step 13, because a draft that already names a policy version cannot demonstrate the pin.

- [ ] **Step 12: Commit**

```bash
git add packages/db/test/fixtures.ts packages/db/test/fixtures-typed-document.test.ts
git commit -m "test(db): add draftTypedDocument, the generic typed-document draft builder [3C T0]

fixtures.ts is extended additively (contracts 4.1, hazard 9); draftDocument stays JOURNAL-only.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Migration 0037 — `app.document_link`, the derived open-quantity view, the over-fulfilment guard

**Files:**
- Create: `packages/db/migrations/0037_create_document_link.sql`
- Create: `packages/db/migrations/0037.down.sql`
- Create: `packages/db/src/schema/document-link.ts`
- Create: `packages/db/src/schema/document-open-quantity.ts`
- Create: `packages/db/test/document-link.test.ts`
- Create: `docs/adr/0040-fulfilment-links-and-derived-open-quantity.md`
- Modify: `packages/contracts/src/errors.ts`
- Test: `packages/db/test/document-link.test.ts`, `packages/db/test/privileges.test.ts` (re-run, unchanged)

**Interfaces:**
- Consumes: `app.document(tenant_id, id)`, `app.document.status` (`app.document_status` enum, plan0A), `app.document_line(tenant_id, id)`, `app.document_line.quantity` (2A's migration 0019), `app.company(tenant_id, id)` — all Plan 0A / 1A / 2A. `app_meta.enable_tenant_rls(tbl regclass)`, `app_meta.attach_audit(tbl regclass, mode text default 'tenant_column', key_cols text default '')` (§4.1). From `@dulja/db/test`: `startDb`, `Db`, `withTenant` (4-argument), `uuidv7`, `seedTenantV2`, `seedItem`, `seedWarehouse`, `seedParty`, `grantCodes`, `draftTypedDocument` (Task 0). `lintSchema`, `Violation` from `@dulja/db`.
- Produces:
  - `app.document_link` — the DDL below, exactly.
  - `app.document_open_quantity` — the view below, exactly: columns `tenant_id uuid`, `company_id uuid`, `document_id uuid`, `document_line_id uuid`, `line_no int`, `item_id uuid`, `ordered_quantity numeric(19,6)`, `linked_quantity numeric(19,6)`, `open_quantity numeric(19,6)`.
  - `app.assert_document_link_within_open_quantity() returns trigger` and the trigger `document_link_open_quantity` on `app.document_link`, raising the tokens `ERR_DOC_LINK_OVER_FULFILLED`, `ERR_DOC_NOT_DRAFT` (the target must be a draft) and `ERR_DOC_STATUS_ILLEGAL` (the source must be `issued` or `posted`), each with `errcode = 'check_violation'`.

**The three rules are all in the trigger, and that is deliberate.** `packages/db` may not import `AppError` (§3.1), and `PostingError`'s code union is a frozen literal subset that contains none of these three (§4.2.4) — so a TypeScript service that enforced "the target must be a draft" would need either a fourth error class or a new `PostingError` code, both of which the contracts forbid. Putting all three in the trigger is also the shape spec:2173 asks for: the data layer is the control, so the rules hold for the API, a job and a direct `app_rw` statement alike, and `fromDatabaseError` (0B) turns each token into the right `Problem` with no per-route mapping. `ERR_DOC_NOT_DRAFT` and `ERR_DOC_STATUS_ILLEGAL` are 2B's rows in `ERRORS` and are re-used, never re-spelled.
  - `ERRORS.ERR_DOC_LINK_OVER_FULFILLED = { status: 422, title: "Over-fulfilled", remedy: "…" }` in `packages/contracts/src/errors.ts`.
  - `documentLink` and `documentOpenQuantity` Drizzle mirrors in `packages/db/src/schema/`.

**Why the guard is a trigger and the quantity is a view.** SAH-017 is "order-delivery tracking double-adds bonus on edit and never reverses on re-pointing" — a stored counter incremented by application code. SAH-018 is "returned quantity as a projection, never a stored column". Both are closed by the same shape: the link is a **row**, the open quantity is **derived from the rows every time it is read**, and the invariant `Σ linked ≤ ordered` is enforced **in the data layer** so it holds for the API, a job and a direct `app_rw` statement alike (test 18's standard, applied to fulfilment).

- [ ] **Step 1: Write the failing test `packages/db/test/document-link.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema, type Violation } from "../src/index";
import {
  draftTypedDocument, grantCodes, seedDocumentType, seedItem, seedParty, seedTenantV2, seedWarehouse,
  startDb, withTenant, type Db, type Seed,
} from "./index";

let db: Db;
let a: Seed;
let b: Seed;

/** A PURCHASE_ORDER-shaped type configured in the database: direction none, inventory none, no ledger lines. */
async function orderType(s: Seed): Promise<string> {
  return seedDocumentTypeLocal(s, "LINK_ORDER", "LO");
}
/** A GOODS_RECEIPT-shaped type: it only has to be a second type with its own series. */
async function receiptType(s: Seed): Promise<string> {
  return seedDocumentTypeLocal(s, "LINK_RECEIPT", "LR");
}
/** File-local because §4.17 gives 3C no type-seeding helper and 2A's `seedDocumentType` needs a Db, not a Seed alone. */
async function seedDocumentTypeLocal(s: Seed, code: string, series: string): Promise<string> {
  return seedDocumentType(db, s, {
    code,
    module: "inventory",
    policy: {
      version: 1, documentType: code, direction: "none", requires: [], lines: [],
      inventory: { effect: "none" }, tax: { applies: false },
      numbering: { series, assignAt: "issue" },
      reversal: { allowed: false, producesType: null },
      approval: { required: false, approve: null, post: "accounting.journal.post" },
      fxRoundingAccount: { from: "company.fx_rounding_account_id" },
      dimensions: { required: [] },
    },
  });
}

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "link-a");
  b = await seedTenantV2(db, "link-b");
  await grantCodes(db, a, { codes: ["accounting.journal.post", "accounting.journal.create"] });
  await grantCodes(db, b, { codes: ["accounting.journal.post", "accounting.journal.create"] });
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("app.document_link — migration 0037 (contracts §4.6.1; SAH-017, SAH-018)", () => {
  it("the schema linter reports zero violations after 0037", async () => {
    const violations: Violation[] = await lintSchema(db.admin);
    expect(violations).toEqual([]);
  });

  it("has tenant_id, forced RLS, a tenant_isolation policy and an audit_row trigger", async () => {
    const [t] = await db.admin<{ rls: boolean; forced: boolean }[]>`
      select relrowsecurity as rls, relforcerowsecurity as forced
        from pg_class where oid = 'app.document_link'::regclass`;
    expect(t).toEqual({ rls: true, forced: true });
    const policies = await db.admin<{ polname: string; permissive: string }[]>`
      select polname, polpermissive::text as permissive from pg_policy where polrelid = 'app.document_link'::regclass order by 1`;
    expect(policies.map((p) => p.polname)).toEqual(["tenant_isolation"]);
    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.document_link'::regclass and not tgisinternal order by 1`;
    expect(triggers.map((t2) => t2.tgname)).toEqual(["audit_row", "document_link_open_quantity"]);
  });

  it("app_rw holds select, insert and update — and NO delete (contracts §3.5.4 is closed)", async () => {
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'document_link' order by 1`;
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("app_rw holds SELECT and ONLY select on the open-quantity view, and the view runs as the invoker", async () => {
    const [v] = await db.admin<{ opts: string[] | null }[]>`
      select reloptions as opts from pg_class where oid = 'app.document_open_quantity'::regclass`;
    expect(v!.opts).toContain("security_invoker=true");
    // The EXACT list, not "SELECT is present". Plan 0A's `alter default privileges … grant select, insert,
    // update on tables to app_rw` (plan0A:2564) applies to VIEWS as well as tables, so without 0037's
    // explicit revoke this returns ["INSERT", "SELECT", "UPDATE"] — and Task 14's SAH-017 claim that the one
    // place the figure exists "cannot be written to at all" would be unsupported by the privilege surface.
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'document_open_quantity' order by 1`;
    expect(grants.map((g) => g.privilege_type)).toEqual(["SELECT"]);
  });

  it("open_quantity is ordered minus every non-void, non-reversed link", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "LINK-ITEM" });
    const warehouseId = await seedWarehouse(db, a, { code: "LINK-WH" });
    const partyId = await seedParty(db, a, { kind: "vendor", code: "LINK-VEND" });

    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy, series: "LO", partyId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "100.000000", unitPrice: "5.0000", amount: "500.0000" }],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy, series: "LR", partyId, warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "40.000000", unitPrice: "5.0000", amount: "200.0000" }],
    });

    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`update app.document set status = 'issued' where id = ${order.documentId}`;
      await tx`insert into app.document_link
                 (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
               values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!},
                       ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 40)`;
    });

    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { ordered: string; linked: string; open: string }[]
    >`select ordered_quantity::text as ordered, linked_quantity::text as linked, open_quantity::text as open
        from app.document_open_quantity where document_line_id = ${order.lineIds[0]!}`);
    expect(row).toEqual({ ordered: "100.000000", linked: "40.000000", open: "60.000000" });

    // Voiding the target releases the quantity — nothing is decremented anywhere.
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'issued' where id = ${receipt.documentId}`);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'void' where id = ${receipt.documentId}`);
    const [after] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { linked: string; open: string }[]
    >`select linked_quantity::text as linked, open_quantity::text as open
        from app.document_open_quantity where document_line_id = ${order.lineIds[0]!}`);
    expect(after).toEqual({ linked: "0.000000", open: "100.000000" });
  });

  it("refuses a link beyond the open quantity with ERR_DOC_LINK_OVER_FULFILLED, naming both figures", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "OVER-ITEM" });
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy, series: "LO",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "10.000000", unitPrice: "1.0000", amount: "10.0000" }],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy, series: "LR",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "11.000000", unitPrice: "1.0000", amount: "11.0000" }],
    });
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`);

    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.document_link
          (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
        values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!},
                ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 11)`),
    ).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED: source line .* has 10\.000000 open of 10\.000000 ordered; 11\.000000 requested/);
  });

  it("refuses the second of two links that together exceed the order (the double-add of SAH-017)", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "DOUBLE-ITEM" });
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy, series: "LO",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "10.000000", unitPrice: "1.0000", amount: "10.0000" }],
    });
    const r1 = await draftTypedDocument(db, a, { documentTypeId: receiptTy, series: "LR", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "6.000000", unitPrice: "1.0000", amount: "6.0000" }] });
    const r2 = await draftTypedDocument(db, a, { documentTypeId: receiptTy, series: "LR", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "6.000000", unitPrice: "1.0000", amount: "6.0000" }] });
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`);

    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${r1.documentId}, ${r1.lineIds[0]!}, 'receives_against', 6)`);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
        values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${r2.documentId}, ${r2.lineIds[0]!}, 'receives_against', 6)`),
    ).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED: source line .* has 4\.000000 open of 10\.000000 ordered; 6\.000000 requested/);
  });

  it("refuses a link whose target is not a draft (ERR_DOC_NOT_DRAFT) and whose source is not issued (ERR_DOC_STATUS_ILLEGAL)", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "STATUS-ITEM" });
    const order = await draftTypedDocument(db, a, { documentTypeId: orderTy, series: "LO", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "9.000000", unitPrice: "1.0000", amount: "9.0000" }] });
    const receipt = await draftTypedDocument(db, a, { documentTypeId: receiptTy, series: "LR", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "9.000000", unitPrice: "1.0000", amount: "9.0000" }] });

    // The source is still a draft: nothing has been committed to, so there is nothing to fulfil.
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
        values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 9)`),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: source document .* is draft — only an issued or posted document can be fulfilled/);

    // Issue both: the target is no longer a draft, so the link cannot be recorded on it.
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'issued' where id = ${receipt.documentId}`);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
        values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 9)`),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is issued — a fulfilment link is recorded on a draft/);
  });

  it("admits a link against a POSTED source, because a goods receipt may follow an invoice", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "POSTED-SRC-ITEM" });
    const order = await draftTypedDocument(db, a, { documentTypeId: orderTy, series: "LO", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "2.000000", unitPrice: "1.0000", amount: "2.0000" }] });
    const receipt = await draftTypedDocument(db, a, { documentTypeId: receiptTy, series: "LR", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "2.000000", unitPrice: "1.0000", amount: "2.0000" }] });
    // A raw status walk: draft → issued → posted is what the state machine admits, and this is a DB-tier test
    // of the link guard, not of the posting service.
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'posted' where id = ${order.documentId}`);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 2)`);
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { open: string }[]
    >`select open_quantity::text as open from app.document_open_quantity where document_line_id = ${order.lineIds[0]!}`);
    expect(row!.open).toBe("0.000000");
  });

  it("deleting the draft target cascades the link away and releases the quantity (no DELETE grant needed)", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "CASCADE-ITEM" });
    const order = await draftTypedDocument(db, a, { documentTypeId: orderTy, series: "LO", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "10.000000", unitPrice: "1.0000", amount: "10.0000" }] });
    const receipt = await draftTypedDocument(db, a, { documentTypeId: receiptTy, series: "LR", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "10.000000", unitPrice: "1.0000", amount: "10.0000" }] });
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 10)`);

    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`delete from app.document where id = ${receipt.documentId}`);
    const [after] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { open: string }[]
    >`select open_quantity::text as open from app.document_open_quantity where document_line_id = ${order.lineIds[0]!}`);
    expect(after!.open).toBe("10.000000");
  });

  it("refuses to delete the line of an ISSUED order at all — 2B's child guard fires before the FK (ERR_DOC_NOT_DRAFT)", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "NODEL-ITEM" });
    const order = await draftTypedDocument(db, a, { documentTypeId: orderTy, series: "LO", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "5.000000", unitPrice: "1.0000", amount: "5.0000" }] });
    const receipt = await draftTypedDocument(db, a, { documentTypeId: receiptTy, series: "LR", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "5.000000", unitPrice: "1.0000", amount: "5.0000" }] });
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 5)`);

    // NOT 23503. 2B ships `app.forbid_line_delete_unless_draft()` as a BEFORE DELETE trigger on
    // app.document_line raising `ERR_DOC_NOT_DRAFT … its lines cannot be deleted` with errcode
    // 'check_violation' (2b:1874–1887), and it fires on the non-draft parent BEFORE any foreign-key check on
    // document_link runs. So the source-side NO ACTION FK is unreachable through app_rw while that guard
    // stands — which is the stronger property, and is what the DDL comment in Step 3 means by "an issued
    // order cannot be deleted anyway". The FK is still the belt: it is what a future slice holding a DELETE
    // grant would hit, and §3.5.4 is closed, so no test can reach it today.
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`delete from app.document_line where id = ${order.lineIds[0]!}`),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  });

  it("tenant B sees none of tenant A's links and none of A's open-quantity rows (test 12)", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "ISO-ITEM" });
    const order = await draftTypedDocument(db, a, { documentTypeId: orderTy, series: "LO", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "3.000000", unitPrice: "1.0000", amount: "3.0000" }] });
    const receipt = await draftTypedDocument(db, a, { documentTypeId: receiptTy, series: "LR", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "3.000000", unitPrice: "1.0000", amount: "3.0000" }] });
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 3)`);

    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) => tx<{ n: number }[]>`
      select (select count(*)::int from app.document_link) + (select count(*)::int from app.document_open_quantity) as n`);
    expect(seen[0]!.n).toBe(0);

    // …and B cannot point a link at A's rows either. NOT 23503, and the reason is the firing order:
    // `document_link_open_quantity` is a BEFORE INSERT ROW trigger, and PostgreSQL runs those before it
    // evaluates referential integrity (an FK is an AFTER-row RI trigger). Under B's RLS the guard's
    // `select d.status … where d.id = new.source_document_id` returns no row, `v_source` is null, and it
    // raises `ERR_DOC_STATUS_ILLEGAL: source document … is not visible — only an issued or posted document
    // can be fulfilled` with errcode 'check_violation' (23514). So the GUARD is the first refusal, not the
    // composite FK. The FK is still the belt underneath — it is what a caller that somehow satisfied every
    // trigger clause would hit — but no cross-tenant document id can reach it, because "invisible" fails the
    // source-status clause first. Asserting 23503 here would be a test that can never go green.
    const bReceipt = await draftTypedDocument(db, b, { documentTypeId: await receiptType(b), series: "LR", lines: [{ kind: "text", description: "x" }] });
    await expect(
      withTenant(db.rw, b.tenant, b.human, (tx) => tx`
        insert into app.document_link (tenant_id, company_id, source_document_id, target_document_id, link_kind)
        values (${b.tenant}, ${b.company}, ${order.documentId}, ${bReceipt.documentId}, 'receives_against')`),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: source document .* is not visible/);
  });

  it("writes an audit row for every link insert (test 13)", async () => {
    const before = await db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where table_name = 'document_link'`;
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "AUDIT-ITEM" });
    const order = await draftTypedDocument(db, a, { documentTypeId: orderTy, series: "LO", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "1.000000", unitPrice: "1.0000", amount: "1.0000" }] });
    const receipt = await draftTypedDocument(db, a, { documentTypeId: receiptTy, series: "LR", lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "1.000000", unitPrice: "1.0000", amount: "1.0000" }] });
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 1)`);
    const after = await db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where table_name = 'document_link'`;
    expect(after[0]!.n).toBe(before[0]!.n + 1);
  });
});
```

Every name in the import block above is used by the file: `seedDocumentType` is 2A's helper (`seedDocumentType(db, s, opts)`) and is called by `seedDocumentTypeLocal`; `uuidv7` is **not** imported, because no case below mints an id — the trigger and the composite FKs are exercised with real document and line ids, and an unused import fails `bun run lint`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/document-link.test.ts`
Expected: **FAIL** — `relation "app.document_link" does not exist` on the first `pg_class` query.

- [ ] **Step 3: Write `packages/db/migrations/0037_create_document_link.sql`**

```sql
-- 0037_create_document_link.sql
-- Slice 3C. Order ↔ fulfilment links (contracts §4.6.1) and open quantity as a DERIVED VIEW.
-- spec:1050  — sales and purchase orders are non-posting commitment documents with open-quantity tracking.
-- spec:1049  — a GOODS_RECEIPT receives against a PURCHASE_ORDER and prices its GRNI accrual from it.
-- SAH-017    — the old system incremented a delivered-quantity counter in place: it double-added on edit and
--              never reversed on re-pointing. Here the link is a row and the quantity is recomputed on read.
-- SAH-018    — fulfilled and returned quantity is a projection, never a stored column.
-- SAH-049    — an aggregate with no unique key duplicates under an upsert race. There is no aggregate row here
--              at all; the two partial unique indexes below key the LINK, which is the only stored thing.

-- ── 1. app.document_link ──────────────────────────────────────────────────────
create table app.document_link (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references app.tenant(id),
  company_id          uuid not null,
  source_document_id  uuid not null,                                   -- the order / the document being fulfilled
  source_line_id      uuid,                                            -- null = a header-only link (no quantity)
  target_document_id  uuid not null,                                   -- the fulfilment / receipt / return
  target_line_id      uuid,
  link_kind           text not null
    check (link_kind in ('fulfils', 'converts_to', 'receives_against', 'returns', 'settles')),
  quantity            numeric(19,6),                                   -- base unit, always positive
  amount              numeric(19,4),                                   -- document currency; used by 4A's 'settles'
  created_at          timestamptz not null default now(),
  check (source_document_id <> target_document_id),                    -- a document never fulfils itself
  check (quantity is null or quantity > 0),                            -- a release is a deleted draft, never a negative link
  check (amount is null or amount >= 0),
  check ((source_line_id is null) = (target_line_id is null)),         -- line-to-line or header-to-header, never mixed
  unique (tenant_id, id),
  -- Composite FKs: an FK check bypasses RLS, so a plain reference would let tenant A point at tenant B's row.
  foreign key (tenant_id, company_id)         references app.company(tenant_id, id),
  -- Source side: NO ACTION. An order line that has been received against cannot be deleted (SAH-018 in the
  -- opposite direction — losing the order would strand the receipt), and an issued order cannot be deleted anyway.
  foreign key (tenant_id, source_document_id) references app.document(tenant_id, id),
  foreign key (tenant_id, source_line_id)     references app.document_line(tenant_id, id),
  -- Target side: ON DELETE CASCADE. Deleting the DRAFT target (or replacing its lines through
  -- PUT …/documents/{id}/lines) releases the open quantity. That is the only release path, because
  -- contracts §3.5.4's DELETE grant list is closed and app_rw holds no DELETE on this table.
  foreign key (tenant_id, target_document_id) references app.document(tenant_id, id) on delete cascade,
  foreign key (tenant_id, target_line_id)     references app.document_line(tenant_id, id) on delete cascade
);

-- One link per (source line, target line, kind); and for header-only links, one per (source doc, target doc, kind).
-- Two partial indexes rather than one constraint, because a UNIQUE constraint treats NULLs as distinct and would
-- admit unlimited duplicate header links (SAH-049's shape).
create unique index document_link_line_pair_key
  on app.document_link (source_line_id, target_line_id, link_kind) where source_line_id is not null;
create unique index document_link_header_pair_key
  on app.document_link (source_document_id, target_document_id, link_kind) where source_line_id is null;
create index document_link_source_line_idx on app.document_link (source_line_id) where source_line_id is not null;
create index document_link_target_document_idx on app.document_link (target_document_id);

call app_meta.enable_tenant_rls('app.document_link');
call app_meta.attach_audit('app.document_link');
-- app_rw receives select, insert, update through default privileges (plan0A). No DELETE: §3.5.4 is closed.

-- ── 2. app.document_open_quantity — the derived view (SAH-017, SAH-018) ───────
-- security_invoker = true is MANDATORY. Without it the view executes with its owner's (app_migrator's)
-- privileges and RLS on both base tables is evaluated for app_migrator, not for the caller — which would make
-- this view a cross-tenant read of every order in the database. With it, tenant_isolation applies as normal.
create view app.document_open_quantity with (security_invoker = true) as
select l.tenant_id,
       l.company_id,
       l.document_id,
       l.id                                                   as document_line_id,
       l.line_no,
       l.item_id,
       l.quantity                                             as ordered_quantity,
       coalesce(k.linked, 0)::numeric(19,6)                    as linked_quantity,
       (l.quantity - coalesce(k.linked, 0))::numeric(19,6)     as open_quantity
  from app.document_line l
  join app.document d on d.id = l.document_id
  left join lateral (
         select sum(x.quantity) as linked
           from app.document_link x
           join app.document t on t.id = x.target_document_id
          where x.source_line_id = l.id
            and t.status not in ('void', 'reversed')          -- a voided or reversed fulfilment releases its quantity
       ) k on true
 where l.quantity is not null
   and d.status not in ('void', 'reversed');                  -- a voided order has no open quantity

-- Plan 0A's `alter default privileges … grant select, insert, update on tables to app_rw` (plan0A:2564)
-- applies to VIEWS too, so without this revoke app_rw would hold INSERT and UPDATE on the one figure this
-- slice exists to keep derived. The view is not auto-updatable (it joins and aggregates), so the grants are
-- inert in practice — but SAH-017's claim is about the privilege surface, and Task 14 asserts the exact list.
revoke insert, update on app.document_open_quantity from app_rw;

-- ── 3. The over-fulfilment guard (the data layer is the control — spec:2173) ──
create function app.assert_document_link_within_open_quantity() returns trigger language plpgsql as $$
declare
  v_ordered numeric(19,6);
  v_linked  numeric(19,6);
  v_source  app.document_status;
  v_target  app.document_status;
begin
  -- The three rules live here, not in TypeScript: packages/db may not import AppError and PostingError's code
  -- union is frozen (contracts §4.2.4), and spec:2173 wants the data layer to be the control in any case.
  select d.status into v_target from app.document d where d.id = new.target_document_id;
  if v_target is null then
    raise exception 'ERR_DOC_STATUS_ILLEGAL: target document % is not visible', new.target_document_id
      using errcode = 'check_violation';
  end if;
  if v_target <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: document % is % — a fulfilment link is recorded on a draft', new.target_document_id, v_target
      using errcode = 'check_violation';
  end if;
  select d.status into v_source from app.document d where d.id = new.source_document_id;
  if v_source is null or v_source not in ('issued', 'posted') then
    raise exception 'ERR_DOC_STATUS_ILLEGAL: source document % is % — only an issued or posted document can be fulfilled',
      new.source_document_id, coalesce(v_source::text, 'not visible')
      using errcode = 'check_violation';
  end if;

  if new.source_line_id is null or new.quantity is null then
    return new;                                               -- a header-only or amount-only link has no quantity to bound
  end if;

  -- SAH-017's concurrency face, and it is NOT closed by the read below on its own. `withTenant` runs at READ
  -- COMMITTED (§4.2.2; 3a:68), so without this lock two transactions each linking 6 against a 10-unit order
  -- line both read v_linked = 0, both satisfy the test, and both commit — 12 linked against 10 ordered, with
  -- no bypass and no override event. This is verbatim the class 3A found in its own step-9 guard and fixed
  -- the same way (`lockStockKeys`, 3a:5719–5727): lock the key, THEN read, which is correct precisely because
  -- each statement takes a fresh snapshot at READ COMMITTED. The key is the SOURCE LINE, because that is what
  -- the sum is over; `linkFulfilment` sorts its input by `sourceLineId` so two multi-line links can never
  -- take two locks in opposite orders.
  perform pg_advisory_xact_lock(hashtextextended('document_link:' || new.source_line_id::text, 0));

  select l.quantity into v_ordered from app.document_line l where l.id = new.source_line_id;
  if v_ordered is null then
    raise exception 'ERR_DOC_LINK_OVER_FULFILLED: source line % carries no quantity to fulfil', new.source_line_id
      using errcode = 'check_violation';
  end if;
  select coalesce(sum(x.quantity), 0) into v_linked
    from app.document_link x
    join app.document t on t.id = x.target_document_id
   where x.source_line_id = new.source_line_id
     and t.status not in ('void', 'reversed')
     and x.id <> new.id;                                      -- the row's own default id is already set on INSERT
  if v_linked + new.quantity > v_ordered then
    raise exception 'ERR_DOC_LINK_OVER_FULFILLED: source line % has % open of % ordered; % requested',
      new.source_line_id, v_ordered - v_linked, v_ordered, new.quantity
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger document_link_open_quantity before insert or update on app.document_link
  for each row execute function app.assert_document_link_within_open_quantity();
```

- [ ] **Step 4: Write `packages/db/migrations/0037.down.sql`**

```sql
-- Reverse dependency order: trigger, function, view, then the table. The view depends on the table, so it
-- must go first or `drop table` fails. `app_meta` and app_meta.schema_migration are never dropped (§3.4.5).
drop trigger if exists document_link_open_quantity on app.document_link;
drop function if exists app.assert_document_link_within_open_quantity() cascade;
drop view if exists app.document_open_quantity;
drop index if exists app.document_link_target_document_idx;
drop index if exists app.document_link_source_line_idx;
drop index if exists app.document_link_header_pair_key;
drop index if exists app.document_link_line_pair_key;
drop table if exists app.document_link;
```

- [ ] **Step 5: Add `ERR_DOC_LINK_OVER_FULFILLED` to `packages/contracts/src/errors.ts` — the SAME commit as the migration**

`scripts/lint/rules/error-codes.ts` scans `packages/db/migrations/**` as well as source, and it fails when a code **present in `ERRORS`** has no occurrence. The migration above is the occurrence, so the row and the migration land together (2B's precedent, §4.2.4). In the `ERRORS` object literal, in the position the §4.2.4 table gives it:

```ts
  ERR_DOC_LINK_OVER_FULFILLED: {
    status: 422,
    title: "Over-fulfilled",
    remedy: "Reduce the quantity on this line, or check the order's remaining open quantity at GET /v1/companies/{companyId}/documents/{documentId}/open-quantity.",
  },
```

- [ ] **Step 6: Write the two Drizzle mirrors**

`packages/db/src/schema/document-link.ts`:

```ts
import { index, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/** Mirror of app.document_link (migration 0037). Reads only — every write goes through packages/db/src/documents/link.ts. */
export const documentLink = pgTable(
  "document_link",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    sourceDocumentId: uuid("source_document_id").notNull(),
    sourceLineId: uuid("source_line_id"),
    targetDocumentId: uuid("target_document_id").notNull(),
    targetLineId: uuid("target_line_id"),
    linkKind: text("link_kind").notNull(),
    quantity: numeric("quantity", { precision: 19, scale: 6 }),
    amount: numeric("amount", { precision: 19, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("document_link_tenant_id_id_key").on(t.tenantId, t.id),
    index("document_link_target_document_idx").on(t.targetDocumentId),
  ],
);
```

`packages/db/src/schema/document-open-quantity.ts`:

```ts
import { integer, numeric, pgView, uuid } from "drizzle-orm/pg-core";

/** Mirror of the app.document_open_quantity VIEW (migration 0037). `.existing()` — Drizzle never emits its DDL. */
export const documentOpenQuantity = pgView("document_open_quantity", {
  tenantId: uuid("tenant_id"),
  companyId: uuid("company_id"),
  documentId: uuid("document_id"),
  documentLineId: uuid("document_line_id"),
  lineNo: integer("line_no"),
  itemId: uuid("item_id"),
  orderedQuantity: numeric("ordered_quantity", { precision: 19, scale: 6 }),
  linkedQuantity: numeric("linked_quantity", { precision: 19, scale: 6 }),
  openQuantity: numeric("open_quantity", { precision: 19, scale: 6 }),
}).existing();
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/db && bun run test -- test/document-link.test.ts`
Expected: **PASS** (13 tests).

Three failures worth naming in advance. If the `security_invoker=true` assertion reports `null`, the `with (...)` clause was dropped — the view then runs as `app_migrator` and the tenant-isolation case will *also* fail, showing non-zero rows for tenant B; that is the single most dangerous mistake in this file. If the over-fulfilment message reports `has 10.000000 open` where the test expects `has 4.000000`, the guard's `x.id <> new.id` filter is excluding rows it should count — check that it is comparing ids and not `source_line_id`. If the cascade case leaves `open` at `0.000000`, the target-side FKs were written without `on delete cascade` and the draft delete raised 23503 instead; re-read the source/target asymmetry comment.

- [ ] **Step 8: Re-run the privileges suite to prove the DELETE list is unchanged**

Run: `cd packages/db && bun run test -- test/privileges.test.ts`
Expected: **PASS** — the pinned list is still `["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]` (§3.5.4). This slice adds no grant; the assertion is that it did not.

- [ ] **Step 9: Run the schema linter and the reversibility proof**

Run: `cd packages/db && bun run db:lint && bun run test -- test/privileges.test.ts`
Expected: `lint` prints no violations and exits 0; the `up → down → up` test in `privileges.test.ts` (§3.4.6) passes, which is what proves 0037.down.sql restores the fingerprint including the new function and the view.

- [ ] **Step 10: Write `docs/adr/0040-fulfilment-links-and-derived-open-quantity.md`**

```markdown
# ADR 0040 — Fulfilment is a link row; open quantity is a derived view

- **Status:** Accepted
- **Date:** 2026-09-07
- **Slice:** 3C
- **Spec:** spec:1049, spec:1050; Part I SAH-017, SAH-018, SAH-049

## Context

An order commits to a quantity; one or more fulfilment documents consume it. The legacy system stored the
consumed quantity on the order line and incremented it from application code. SAH-017 is the result: editing a
fulfilment double-added the bonus quantity, and re-pointing it at another order never reversed the first.
SAH-018 is the same defect on the returns side. SAH-049 is its concurrency face — an aggregate row with no
unique key duplicates under an upsert race and is then double-updated forever.

## Decision

1. **`app.document_link` is the only stored fulfilment fact**: one row per (source line, target line, kind),
   append-only in practice, with two partial unique indexes so a duplicate is impossible with or without lines.
2. **Open quantity is never stored.** `app.document_open_quantity` is a view computing
   `ordered − Σ linked` on every read, excluding links whose target document is `void` or `reversed`.
3. **The invariant is enforced in the data layer, under a lock.** `app.assert_document_link_within_open_quantity()`
   is a BEFORE INSERT OR UPDATE trigger raising `ERR_DOC_LINK_OVER_FULFILLED`, so it holds for the API, a job
   and a direct `app_rw` statement alike. It takes `pg_advisory_xact_lock` on the **source line** before summing
   the existing links, because `withTenant` is READ COMMITTED and two concurrent links would otherwise both
   read the same committed sum and both commit — 3A's `lockStockKeys` precedent (3a:5719–5727), applied to
   fulfilment. `linkFulfilment` sorts its lines by `sourceLineId`, so multi-line links cannot deadlock.
4. **Release is a deleted draft, not a negative link.** The target-side FKs cascade; `quantity > 0` is a CHECK.
   `app_rw` holds no DELETE on `document_link` and contracts §3.5.4's grant list is closed, so there is no
   `DELETE …/links/{id}` route and there never will be one — un-linking means deleting or re-lining the draft.
5. **The view is `security_invoker = true`.** A view is not RLS-transparent by default; without the option the
   caller would read every tenant's orders.

## Consequences

- A back-order is `open_quantity > 0` and needs no status column (3D's `SALES_ORDER` relies on this).
- A partially received order stays `issued` forever; "closing" it early is out of v1 scope and would be a
  `link_kind` of its own, decided here rather than invented later.
- Reversing a fulfilment (2B's `reverseDocument`) releases the quantity automatically, because the original
  becomes `reversed` and the view excludes it. No compensating link is written.
```

- [ ] **Step 11: Commit**

```bash
git add packages/db/migrations/0037_create_document_link.sql packages/db/migrations/0037.down.sql \
        packages/db/src/schema/document-link.ts packages/db/src/schema/document-open-quantity.ts \
        packages/db/test/document-link.test.ts packages/contracts/src/errors.ts \
        docs/adr/0040-fulfilment-links-and-derived-open-quantity.md
git commit -m "feat(db): add document_link, the derived open-quantity view and the over-fulfilment guard [3C T1]

Open quantity is ordered minus every non-void link, recomputed on read (SAH-017, SAH-018);
the view is security_invoker so RLS is the caller's, and app_rw holds SELECT on it and nothing
else; app_rw gets no DELETE on the table (contracts 3.5.4). The guard locks the source line
before it sums, so the invariant is not defeatable by concurrency alone (SAH-049, 3a:5719).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0039 — the four permission codes, the catalogue, the role grants and the stage codes

**Files:**
- Create: `packages/db/migrations/0039_seed_permission_phase3c.sql`
- Create: `packages/db/migrations/0039.down.sql`
- Modify: `packages/contracts/permissions.ts`
- Modify: `packages/db/seed/roles.ts`
- Modify: `apps/api/src/middleware/require-document-permission.ts` (`POLICY_RESOLVED_CODES`)
- Modify: `apps/api/src/routes/accounting/documents.ts` (`DOCUMENT_STAGE_CODES`)
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` (§3.6.4's grant-register sentence and one §4.18 row — Step 5, **the same PR as the grants**, which is what §3.6.4 requires)
- Test: `packages/db/test/permission-catalogue.test.ts` (existing, re-run), `packages/db/test/roles.test.ts` (existing, re-run)

**Interfaces:**
- Consumes: `app.permission (code, module, mutating, description)` (plan0A migration 0001, global, no RLS, read-only for `app_rw`); `PERMISSIONS`, `PermissionDef`, `PermissionModule`, `PermissionAction`, `SliceId`, `PERMISSION` from `packages/contracts/permissions.ts` (0B); `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` from `packages/db/seed/roles.ts` (0D); `POLICY_RESOLVED_CODES` (2A), `DOCUMENT_STAGE_CODES` (2A).
- Produces: the four codes as catalogue entries with `phase: "3C"` —
  - `accounting.purchase.create` · module `accounting` · `mutating: true`
  - `accounting.purchase.post` · module `accounting` · `mutating: true`
  - `inventory.receipt.create` · module `inventory` · `mutating: true`
  - `inventory.receipt.post` · module `inventory` · `mutating: true`
  and the four role grants below; `POLICY_RESOLVED_CODES` and `DOCUMENT_STAGE_CODES` each grown by exactly these four.

**This task runs before any policy is seeded, and that ordering is load-bearing.** §4.4.1: "a policy naming an `approval` code absent from the catalogue fails `validatePolicy` (`ERR_POLICY_INVALID`) — so a type's policy is seeded in the slice that introduces its codes (F-21)". Tasks 5, 6, 9 and 10 each seed a policy naming one of these four; none of them can be green until this task is merged.

**The role grants, derived from spec:2159 and recorded in §3.6.4's sentence.** `accountant` — "sales and purchase documents and their posting" → `accounting.purchase.create`, `accounting.purchase.post`. `user` — "Draft sales and purchase orders and documents … `*.create`" → `accounting.purchase.create`. `warehouse` — "Receive against purchase documents … post receipts and transfers — quantities only" → `inventory.receipt.create`, `inventory.receipt.post`. **`accountant` does not receive `inventory.receipt.*`** and `branch_manager` receives neither pair: spec:2159 gives the branch manager "receiving transfers", which is 3D's `inventory.transfer.*`, and gives receipt posting to the warehouse. `auditor` receives nothing (R7 — every one of the four is `mutating: true`). `admin` is computed from `PERMISSIONS` and its array is never edited.

- [ ] **Step 1: Extend `packages/contracts/permissions.ts`**

Append to the `PERMISSIONS` array, keeping the file's existing module grouping and its `as const satisfies readonly PermissionDef[]` tail:

```ts
  { code: "accounting.purchase.create", module: "accounting", mutating: true,  phase: "3C",
    description: "Create and submit purchase orders, import shipments and purchase returns" },
  { code: "accounting.purchase.post",   module: "accounting", mutating: true,  phase: "3C",
    description: "Post purchase returns and purchase documents" },
  { code: "inventory.receipt.create",   module: "inventory",  mutating: true,  phase: "3C",
    description: "Create and submit goods receipts and import shipments" },
  { code: "inventory.receipt.post",     module: "inventory",  mutating: true,  phase: "3C",
    description: "Post goods receipts and import shipments — quantities and landed cost" },
```

`"3C"` is already a member of `SliceId` (§4.2.5), so no type widens.

- [ ] **Step 2: Write the failing catalogue test run**

Run: `cd packages/db && bun run test -- test/permission-catalogue.test.ts`
Expected: **FAIL** — the test asserts that the set of `(code, module, mutating)` in `app.permission` equals the set exported by `permissions.ts`, in **both** directions; four codes are now in the module and not in the table, so it reports the four missing rows by code.

- [ ] **Step 3: Write `packages/db/migrations/0039_seed_permission_phase3c.sql`**

```sql
-- 0039_seed_permission_phase3c.sql
-- Slice 3C. The four permission codes of contracts §3.6.2, spec:2147–2148.
-- app.permission is GLOBAL (no tenant_id, no RLS, read-only for app_rw — plan0A), so it is migration data,
-- not seed-pack data (§3.4.8, hazard 10).
insert into app.permission (code, module, mutating, description) values
  ('accounting.purchase.create', 'accounting', true,
   'Create and submit purchase orders, import shipments and purchase returns'),
  ('accounting.purchase.post',   'accounting', true,
   'Post purchase returns and purchase documents'),
  ('inventory.receipt.create',   'inventory',  true,
   'Create and submit goods receipts and import shipments'),
  ('inventory.receipt.post',     'inventory',  true,
   'Post goods receipts and import shipments — quantities and landed cost')
on conflict (code) do update
  set module      = excluded.module,
      mutating    = excluded.mutating,
      description = excluded.description;
```

- [ ] **Step 4: Write `packages/db/migrations/0039.down.sql`**

```sql
-- Deletes exactly the four codes this file inserted, and nothing else (§3.6.3).
delete from app.permission
 where code in ('accounting.purchase.create', 'accounting.purchase.post',
                'inventory.receipt.create', 'inventory.receipt.post');
```

- [ ] **Step 5: Extend `packages/db/seed/roles.ts`**

Add each code to the `permissions` array of the roles named above, leaving every other array untouched and never editing `admin`'s computed array:

```ts
// accountant — spec:2159 "sales and purchase documents and their posting"
"accounting.purchase.create",
"accounting.purchase.post",
// user — spec:2159 "Draft sales and purchase orders and documents"
"accounting.purchase.create",
// warehouse — spec:2159 "Receive against purchase documents … post receipts and transfers — quantities only"
"inventory.receipt.create",
"inventory.receipt.post",
```

**And, in the SAME commit, write the four grants back into §3.6.4's register sentence.** §3.6.4 is explicit: "The grants recorded so far, so no slice has to re-derive one from the spec's table … Every later introducing slice adds its row to this sentence in the same PR." 3C is the first slice after 2B to grant anything, so this is the first exercise of that rule; if it is skipped, 3D and 4A re-derive the same four rows from spec:2159 instead of reading the register, which is exactly what the sentence exists to prevent. In `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` §3.6.4, extend the sentence that currently ends `**`accounting.document.reverse` → `accountant`** (2B)` so it reads:

```markdown
**`accounting.party.manage` → `user`** (2A; spec:2159 gives the back-office clerk party maintenance), **`accounting.document.reverse` → `accountant`** (2B), and — from 3C, all four derived from spec:2159 — **`accounting.purchase.create` → `accountant` and `user`**, **`accounting.purchase.post` → `accountant`**, **`inventory.receipt.create` → `warehouse`** and **`inventory.receipt.post` → `warehouse`**. 3C's own note on the two roles that get nothing: `accountant` does **not** receive `inventory.receipt.*` (spec:2159 gives receipt posting to the warehouse), and `branch_manager` receives neither pair — its "receiving transfers" is 3D's `inventory.transfer.*`.
```

Add the same fact as a §4.18 round-3 row, beside the rows Task 0 Step 6 landed:

```markdown
| 3.6.4 | Role seeds recorded: `accounting.purchase.create` → `accountant`, `user`; `accounting.purchase.post` → `accountant`; `inventory.receipt.create` → `warehouse`; `inventory.receipt.post` → `warehouse` (3C, spec:2159). `accountant` deliberately holds no `inventory.receipt.*` and `branch_manager` holds none of the four | 3C | plan |
```

- [ ] **Step 6: Extend `POLICY_RESOLVED_CODES` and `DOCUMENT_STAGE_CODES`**

In `apps/api/src/middleware/require-document-permission.ts`, append to `POLICY_RESOLVED_CODES`:

```ts
  PERMISSION["accounting.purchase.create"],
  PERMISSION["accounting.purchase.post"],
  PERMISSION["inventory.receipt.create"],
  PERMISSION["inventory.receipt.post"],
```

`DOCUMENT_STAGE_CODES` in `apps/api/src/routes/accounting/documents.ts` is **initialised from `POLICY_RESOLVED_CODES`** (§4.5.4), so it needs no second edit — verify with `grep -n "DOCUMENT_STAGE_CODES" apps/api/src/routes/accounting/documents.ts` that the initialiser is `POLICY_RESOLVED_CODES` and not a literal array. If it is a literal array, that is 2A's finding, not a licence to add a fifth spelling: fix the initialiser to read from `POLICY_RESOLVED_CODES` in this commit and say so in the message. §4.5.4 names 3C as "the first slice that genuinely extends it", which is why this is the task that discovers it.

- [ ] **Step 7: Run the catalogue, role-seed and route-gate checks to verify they pass**

Run: `cd packages/db && bun run test -- test/permission-catalogue.test.ts test/roles.test.ts && cd ../.. && bun run lint:rules`
Expected: **PASS**, and `lint:rules` exits 0.

Two failures worth naming in advance. `permission-catalogue` failing in the *other* direction (a code in the table, none in the module) means the migration ran before the `permissions.ts` edit was saved — re-run after `bun run db:migrate`. `role-seed` failing with "role holds a code not in the catalogue" means a code string in `roles.ts` is misspelled; the codes are typed as `readonly string[]` deliberately (F-21), so the compiler will not catch it and only this lint will.

- [ ] **Step 8: Verify the handler ↔ catalogue check is satisfied and understand why**

Run: `cd ../.. && bun run lint:rules 2>&1 | grep permission-catalogue || echo "clean"`
Expected: `clean`. The four codes are gated from *data* (a policy's `approval` block), which no source scan can see — `POLICY_RESOLVED_CODES` is the `PERMISSION[…]` reference that satisfies `scripts/lint/rules/permission-catalogue.ts` for exactly that case (§4.5.4). Without Step 6 this lint fails, and it fails on *this* slice, not on the one that wrote the policy.

- [ ] **Step 9: Commit**

```bash
git add packages/db/migrations/0039_seed_permission_phase3c.sql packages/db/migrations/0039.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts \
        apps/api/src/middleware/require-document-permission.ts apps/api/src/routes/accounting/documents.ts \
        docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
git commit -m "feat(db): seed the four purchasing permission codes and their role grants [3C T2]

accounting.purchase.create/.post to accountant and user; inventory.receipt.create/.post to warehouse
(spec:2159). POLICY_RESOLVED_CODES gains all four so the policy-resolved gates satisfy the catalogue lint.
Contracts 3.6.4's grant register gains the four rows in this same PR, as that section requires.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Chart-of-accounts additions — `2150` GRNI, `1310` goods in transit, `5100` expiry loss

**Files:**
- Create: `packages/db/seed/my/chart-of-accounts/3c-purchasing.json`
- Create: `packages/db/test/seed/chart-of-accounts-3c.test.ts`
- Test: `packages/db/test/seed/chart-of-accounts-3c.test.ts`

**Interfaces:**
- Consumes: the `chart-of-accounts` `PackLoader` (0C) and `readPackFile` / `assertPackShape` (§4.2.13); `AccountSeed = { code; nameEn; nameAr?; type; parentCode?; currency?; isGroup? }` (§4.15, `isGroup` recorded by 0C); the seed CLI `bun run seed --tenant <id> --only chart-of-accounts` and its exit codes (§4.2.13); `app.account (company_id, code)` unique (plan0A).
- Produces: the three §4.15 rows. **`2150` is named by the `GOODS_RECEIPT` and `SHIPMENT` policies of Tasks 6 and 9** and must resolve before either is seeded (hazard 33). **`1310` and `5100` are seeded here and consumed by 3D** — 3D's plan asserts they resolve and does not re-seed them.

**Why three rows and not one.** §4.15 assigns 3C exactly these three, and the reason `5100` is 3C's though only 3D posts to it is stated there: 3C owns the purchasing chart additions its card already names, and the F-21 rule applied to accounts says the file that carries a slice's chart additions carries all of them. A slice consuming a code it did not seed asserts it resolves; it never re-seeds and never falls back to a null account.

- [ ] **Step 1: Write the failing test `packages/db/test/seed/chart-of-accounts-3c.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenantV2, startDb, withTenant, type Db, type Seed } from "../index";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";

const here = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(here, "..", "..", "seed", "my");

interface AccountSeed { code: string; nameEn: string; nameAr?: string; type: string; parentCode?: string; isGroup?: boolean }

let db: Db;
let s: Seed;

beforeAll(async () => { db = await startDb(); s = await seedTenantV2(db, "coa-3c"); }, 180_000);
afterAll(async () => { await db.stop(); });

describe("chart-of-accounts/3c-purchasing.json — contracts §4.15", () => {
  it("carries exactly the three rows §4.15 assigns 3C, with the right types", () => {
    const rows = JSON.parse(readFileSync(join(PACK_ROOT, "chart-of-accounts", "3c-purchasing.json"), "utf8")) as AccountSeed[];
    expect(rows.map((r) => [r.code, r.type])).toEqual([
      ["2150", "liability"],
      ["1310", "asset"],
      ["5100", "expense"],
    ]);
    expect(rows.every((r) => r.nameAr !== undefined && r.nameAr.length > 0)).toBe(true);
    expect(rows.every((r) => r.isGroup !== true)).toBe(true);
  });

  it("every code matches ^[1-5][0-9]{3}$ and its first digit is its account_type (§4.15, frozen)", () => {
    const rows = JSON.parse(readFileSync(join(PACK_ROOT, "chart-of-accounts", "3c-purchasing.json"), "utf8")) as AccountSeed[];
    const firstDigit: Record<string, string> = { asset: "1", liability: "2", equity: "3", income: "4", expense: "5" };
    for (const r of rows) {
      expect(r.code).toMatch(/^[1-5][0-9]{3}$/);
      expect(r.code[0]).toBe(firstDigit[r.type]);
    }
  });

  it("the loader applies the file and the three accounts resolve for the company (hazard 33)", async () => {
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      chartOfAccountsLoader.load(tx, {
        config: {
          tenantId: s.tenant, only: ["chart-of-accounts"], packRoot: PACK_ROOT,
          tenantName: "coa-3c", ownerEmail: "owner@example.invalid",
          companyCode: "HQ", companyName: "coa-3c HQ",
          baseCurrency: "MYR", timezone: "Asia/Kuala_Lumpur",
          fiscalYearStartMonth: 1, fiscalYear: 2026,
        },
        tenantId: s.tenant, companyId: s.company, systemPrincipalId: s.system, packRoot: PACK_ROOT,
      }),
    );
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; type: string }[]
    >`select code, type::text as type from app.account where company_id = ${s.company} and code in ('2150','1310','5100') order by code`);
    expect(rows).toEqual([
      { code: "1310", type: "asset" },
      { code: "2150", type: "liability" },
      { code: "5100", type: "expense" },
    ]);
  });

  it("1300 inventory control (0C's) also resolves — GOODS_RECEIPT and SHIPMENT name it by literal", async () => {
    // Hazard 33 in the other direction: this slice's receipt policies carry TWO `account: { code }` literals,
    // `2150` (seeded above) and `1300` (0C's `0c-base.json`, seeded before this slice runs). The rule for a
    // consumed code is "assert it resolves in your first task in that area; never re-seed it, never fall back
    // to a null account" — so this case is the assertion and `3c-purchasing.json` deliberately omits `1300`.
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ code: string; type: string }[]>`
      select code, type::text as type from app.account where company_id = ${s.company} and code = '1300'`);
    expect(row).toEqual({ code: "1300", type: "asset" });
    const seeded = JSON.parse(readFileSync(join(PACK_ROOT, "chart-of-accounts", "3c-purchasing.json"), "utf8")) as AccountSeed[];
    expect(seeded.map((r) => r.code)).not.toContain("1300");
  });

  it("re-applying the pack is idempotent on (company_id, code) — spec:2002", async () => {
    const before = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account where company_id = ${s.company}`);
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      chartOfAccountsLoader.load(tx, {
        config: {
          tenantId: s.tenant, only: ["chart-of-accounts"], packRoot: PACK_ROOT,
          tenantName: "coa-3c", ownerEmail: "owner@example.invalid",
          companyCode: "HQ", companyName: "coa-3c HQ",
          baseCurrency: "MYR", timezone: "Asia/Kuala_Lumpur",
          fiscalYearStartMonth: 1, fiscalYear: 2026,
        },
        tenantId: s.tenant, companyId: s.company, systemPrincipalId: s.system, packRoot: PACK_ROOT,
      }),
    );
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account where company_id = ${s.company}`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/seed/chart-of-accounts-3c.test.ts`
Expected: **FAIL** — `ENOENT` on `chart-of-accounts/3c-purchasing.json`.

- [ ] **Step 3: Write `packages/db/seed/my/chart-of-accounts/3c-purchasing.json`**

```json
[
  {
    "code": "2150",
    "nameEn": "Goods received not invoiced",
    "nameAr": "بضاعة مستلمة غير مفوترة",
    "type": "liability",
    "parentCode": "2100"
  },
  {
    "code": "1310",
    "nameEn": "Goods in transit",
    "nameAr": "بضاعة في الطريق",
    "type": "asset",
    "parentCode": "1300"
  },
  {
    "code": "5100",
    "nameEn": "Inventory write-off — expiry loss",
    "nameAr": "إتلاف مخزون — خسارة انتهاء الصلاحية",
    "type": "expense",
    "parentCode": "5000"
  }
]
```

`parentCode` points at 0C's `0c-base.json` rows (`2100` trade payables, `1300` inventory control, `5000` COGS), which §4.15 marks as 0C's and which the pack has already applied — the loader's application order is `SUB_PACKS` order and `chart-of-accounts` is one sub-pack, so `0c-base.json` is read before `3c-purchasing.json` within it (files in lexical order: `0c-` sorts before `3c-`). **Nothing about `0c-base.json` is edited** — §4.15 splits the chart one file per slice precisely so eight writers never share one file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/db && bun run test -- test/seed/chart-of-accounts-3c.test.ts`
Expected: **PASS** (5 tests).

One failure worth naming in advance: if the loader throws naming `2150`'s `parentCode`, the pack applied `3c-purchasing.json` before `0c-base.json` — the loader must read the directory's files in lexical order, and `0c-` before `3c-` is what makes the parent exist. If it does not, that is a 0C finding; fixing it by dropping `parentCode` would hide it, so raise it instead.

- [ ] **Step 5: Apply the sub-pack against a scratch tenant and record the command**

Run:

```bash
bun run --cwd packages/db seed --tenant "$SCRATCH_TENANT_ID" --only chart-of-accounts
```

Expected: exit **0**, and the run reports three new accounts on a tenant that already had 0C's chart. `$SCRATCH_TENANT_ID` is a local tenant created by the seed bootstrap; on a developer machine the same command runs against Testcontainers through the test above, which is the local equivalent hazard 5 requires — no owner account is involved.

- [ ] **Step 6: Commit**

```bash
git add packages/db/seed/my/chart-of-accounts/3c-purchasing.json packages/db/test/seed/chart-of-accounts-3c.test.ts
git commit -m "chore(seed): add the 3C chart rows 2150 GRNI, 1310 goods in transit, 5100 expiry loss [3C T3]

2150 is named by the GOODS_RECEIPT and SHIPMENT policies (hazard 33); 1310 and 5100 are consumed by 3D.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The fulfilment service and its three sub-paths on the `documents` module

**Files:**
- Create: `packages/db/src/documents/link.ts`
- Create: `packages/contracts/src/accounting/document-link.ts`
- Create: `apps/api/src/documents/link-handlers.ts`
- Modify: `apps/api/src/routes/accounting/documents.ts`
- Modify: `packages/db/src/index.ts` (three exports)
- Create: `apps/api/test/routes/accounting/document-links.test.ts`
- Test: `apps/api/test/routes/accounting/document-links.test.ts`, `tests/invariants/tenant-isolation.test.ts` (re-run)

**Interfaces:**
- Consumes: `app.document_link`, `app.document_open_quantity` and the guard (Task 1); `Sql` from `postgres`; `TenantContext` from `../with-tenant` (0B); `requireDocumentPermission("submit")` from `apps/api/src/middleware/require-document-permission.ts` (2A) and `requireDocumentModuleRead()` from `apps/api/src/middleware/require-attachment-read.ts` (2C — that file, not `routes/accounting/attachments.ts`; see the Assumptions block); `IdempotencyHeader`, `RouteModule` (0B); `ListEnvelope`, `UuidSchema`, `QuantitySchema`, `ProblemSchema`, `TimestampSchema` from `@dulja/contracts` (0B); `AppError`, `ERRORS`, `fromDatabaseError` from `@dulja/contracts` (0B, `packages/contracts/src/errors.ts`); `AppEnv` from `apps/api/src/context.ts` (0B); `startApi`, `grantAdmin`, `problemOf` (0B); `documentRoutes` (1A, mounted at `/v1/companies/:companyId/documents`, so every sub-path below is declared **relative**).
- Produces:

```ts
// packages/db/src/documents/link.ts
export type LinkKind = "fulfils" | "converts_to" | "receives_against" | "returns" | "settles";
export interface FulfilmentLineInput { sourceLineId: string; targetLineId: string; quantity: string }
export interface LinkFulfilmentInput {
  sourceDocumentId: string;
  targetDocumentId: string;
  linkKind: LinkKind;
  lines: readonly FulfilmentLineInput[];
  /** Copy the source line's unit_price and recompute the target line's amount when the target carries no price.
   *  This is what "a GOODS_RECEIPT … prices its GRNI accrual from [the PO]" means (spec:1050). Default true. */
  priceFromSource?: boolean;
}
export interface DocumentLinkRow {
  id: string; companyId: string;
  sourceDocumentId: string; sourceLineId: string | null;
  targetDocumentId: string; targetLineId: string | null;
  linkKind: LinkKind; quantity: string | null; amount: string | null; createdAt: string;
}
export interface OpenQuantityRow {
  documentId: string; documentLineId: string; lineNo: number; itemId: string | null;
  orderedQuantity: string; linkedQuantity: string; openQuantity: string;
}
export async function linkFulfilment(tx: Sql, ctx: TenantContext, input: LinkFulfilmentInput): Promise<DocumentLinkRow[]>;
export async function listLinks(tx: Sql, documentId: string): Promise<DocumentLinkRow[]>;
export async function openQuantity(tx: Sql, documentId: string): Promise<OpenQuantityRow[]>;
```

and, exported from `@dulja/db`: `linkFulfilment`, `listLinks`, `openQuantity` with the four types above.

```ts
// packages/contracts/src/accounting/document-link.ts
export const LinkKindSchema: z.ZodEnum<["fulfils", "converts_to", "receives_against", "returns", "settles"]>;
export const DocumentLinkSchema: z.ZodObject<{ id; companyId; sourceDocumentId; sourceLineId; targetDocumentId; targetLineId; linkKind; quantity; amount; createdAt }>;
export const CreateDocumentLinksBody: z.ZodObject<{ sourceDocumentId; linkKind; priceFromSource; lines }>;
export const DocumentLinkList: ReturnType<typeof ListEnvelope<typeof DocumentLinkSchema>>;
export const OpenQuantitySchema: z.ZodObject<{ documentId; documentLineId; lineNo; itemId; orderedQuantity; linkedQuantity; openQuantity }>;
export const OpenQuantityList: ReturnType<typeof ListEnvelope<typeof OpenQuantitySchema>>;
```

**Why the target document is the path parameter and the source is in the body.** The gate is `requireDocumentPermission("submit")`, which resolves `approval.create ?? approval.post` from the policy of the document named by `:documentId` (§4.5.4; the stage is `"submit"` and not `"create"` for the reason the File Structure section gives — 2A's `"create"` branch reads the type from the request body). The authority being asked for is "may this principal edit this draft receipt", so the receipt must be the path parameter. Asking the *order's* authority instead would let anyone who can raise a purchase order also write onto someone else's draft receipt.

- [ ] **Step 1: Write the failing route test `apps/api/test/routes/accounting/document-links.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  draftTypedDocument, seedDocumentType, seedItem, seedParty, seedTenantV2, seedWarehouse,
  withTenant, type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories
// up, which is what 2A's route suites use (2a:3253). There is no `apps/api/test/support/api.ts`.
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let orderTypeId: string;
let receiptTypeId: string;
let itemId: string;
let baseUnitId: string;
let warehouseId: string;
let partyId: string;

const ORDER_POLICY = (code: string, series: string) => ({
  version: 1 as const, documentType: code, direction: "none" as const, requires: [] as const, lines: [] as const,
  inventory: { effect: "none" as const }, tax: { applies: false },
  numbering: { series, assignAt: "issue" as const },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.purchase.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" as const },
  dimensions: { required: [] as const },
});

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "links-api");
  await grantAdmin(api, s);
  orderTypeId = await seedDocumentType(api.db, s, { code: "API_ORDER", module: "inventory", policy: ORDER_POLICY("API_ORDER", "AO") });
  receiptTypeId = await seedDocumentType(api.db, s, {
    code: "API_RECEIPT", module: "inventory",
    policy: { ...ORDER_POLICY("API_RECEIPT", "AR"), approval: { required: false, approve: null, post: "inventory.receipt.post", create: "inventory.receipt.create" } },
  });
  ({ itemId, baseUnitId } = await seedItem(api.db, s, { code: "API-ITEM" }));
  warehouseId = await seedWarehouse(api.db, s, { code: "API-WH" });
  partyId = await seedParty(api.db, s, { kind: "vendor", code: "API-VEND" });
}, 240_000);
afterAll(async () => { await api.stop(); });

/** `amount` is the THIRD argument and is passed explicitly: it is `quantity × unitPrice` and computing it here
 *  would put a monetary value through JavaScript arithmetic (`no-number-money`, §3.7.5). Every call below
 *  states all three, so the row is the row the assertions expect. */
async function issuedOrder(
  quantity: string, unitPrice: string, amount: string,
): Promise<{ documentId: string; lineIds: string[] }> {
  const order = await draftTypedDocument(api.db, s, {
    documentTypeId: orderTypeId, series: "AO", partyId,
    lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity, unitPrice, amount }],
  });
  await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`);
  return order;
}

describe("POST/GET /v1/companies/{companyId}/documents/{documentId}/links (3C)", () => {
  it("creates a link, prices the target line from the source, and reports the open quantity", async () => {
    const order = await issuedOrder("100.000000", "5.0000", "500.0000");
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptTypeId, series: "AR", partyId, warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "40.000000" }],
    });

    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`,
      as: s.human,
      body: {
        sourceDocumentId: order.documentId,
        linkKind: "receives_against",
        priceFromSource: true,
        lines: [{ sourceLineId: order.lineIds[0], targetLineId: receipt.lineIds[0], quantity: "40.000000" }],
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { items: { linkKind: string; quantity: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ linkKind: "receives_against", quantity: "40.000000" });

    // The PO's unit price reached the receipt line, and amount was recomputed from it (spec:1050).
    const [line] = await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx<
      { unit_price: string; amount: string }[]
    >`select unit_price::text as unit_price, amount::text as amount from app.document_line where id = ${receipt.lineIds[0]!}`);
    expect(line).toEqual({ unit_price: "5.0000", amount: "200.0000" });

    const open = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/documents/${order.documentId}/open-quantity`,
      as: s.human,
    });
    expect(open.status).toBe(200);
    const openBody = (await open.json()) as { items: { orderedQuantity: string; linkedQuantity: string; openQuantity: string }[] };
    expect(openBody.items[0]).toEqual({
      documentId: order.documentId, documentLineId: order.lineIds[0], lineNo: 1, itemId,
      orderedQuantity: "100.000000", linkedQuantity: "40.000000", openQuantity: "60.000000",
    });

    const list = await api.request({ method: "GET", path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`, as: s.human });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("returns 422 ERR_DOC_LINK_OVER_FULFILLED when the link exceeds the open quantity", async () => {
    const order = await issuedOrder("10.000000", "10.0000", "100.0000");
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptTypeId, series: "AR", partyId, warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "11.000000" }],
    });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`, as: s.human,
      body: { sourceDocumentId: order.documentId, linkKind: "receives_against", lines: [{ sourceLineId: order.lineIds[0], targetLineId: receipt.lineIds[0], quantity: "11.000000" }] },
    });
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_DOC_LINK_OVER_FULFILLED");
    expect(problem.detail).toContain("10.000000 ordered");
    expect(problem.remedy).toContain("open-quantity");
  });

  it("returns 409 ERR_DOC_NOT_DRAFT when the target has already been issued", async () => {
    const order = await issuedOrder("5.000000", "5.0000", "25.0000");
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptTypeId, series: "AR", partyId, warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "5.000000" }],
    });
    await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx`update app.document set status = 'issued' where id = ${receipt.documentId}`);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`, as: s.human,
      body: { sourceDocumentId: order.documentId, linkKind: "receives_against", lines: [{ sourceLineId: order.lineIds[0], targetLineId: receipt.lineIds[0], quantity: "5.000000" }] },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_DOC_NOT_DRAFT");
  });

  it("requires an Idempotency-Key and replays the same key with the same body", async () => {
    const order = await issuedOrder("8.000000", "8.0000", "64.0000");
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptTypeId, series: "AR", partyId, warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "8.000000" }],
    });
    const body = { sourceDocumentId: order.documentId, linkKind: "receives_against", lines: [{ sourceLineId: order.lineIds[0], targetLineId: receipt.lineIds[0], quantity: "8.000000" }] };

    const missing = await api.request({ method: "POST", path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`, as: s.human, body, idempotencyKey: null });
    expect(missing.status).toBe(400);
    expect((await problemOf(missing)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");

    const key = "3c-links-replay";
    const first = await api.request({ method: "POST", path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`, as: s.human, body, idempotencyKey: key });
    expect(first.status).toBe(201);
    const replay = await api.request({ method: "POST", path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`, as: s.human, body, idempotencyKey: key });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    const links = await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_link where target_document_id = ${receipt.documentId}`);
    expect(links[0]!.n).toBe(1);
  });

  it("403s a principal that holds no create authority on the target's type", async () => {
    const order = await issuedOrder("4.000000", "4.0000", "16.0000");
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptTypeId, series: "AR", partyId, warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "4.000000" }],
    });
    const stranger = await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      const [row] = await tx<{ id: string }[]>`select uuidv7() as id`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${row!.id}, 'human', ${"stranger:" + s.tenant}, 'stranger')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${row!.id})`;
      return row!.id;
    });
    await api.loadPrincipals();
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`, as: stranger,
      body: { sourceDocumentId: order.documentId, linkKind: "receives_against", lines: [{ sourceLineId: order.lineIds[0], targetLineId: receipt.lineIds[0], quantity: "4.000000" }] },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test -- test/routes/accounting/document-links.test.ts`
Expected: **FAIL** — the first request returns **404** because no route is mounted at `…/documents/{documentId}/links`.

- [ ] **Step 3: Write `packages/db/src/documents/link.ts`**

```ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";

export type LinkKind = "fulfils" | "converts_to" | "receives_against" | "returns" | "settles";

export interface FulfilmentLineInput { sourceLineId: string; targetLineId: string; quantity: string }

export interface LinkFulfilmentInput {
  sourceDocumentId: string;
  targetDocumentId: string;
  linkKind: LinkKind;
  lines: readonly FulfilmentLineInput[];
  priceFromSource?: boolean;
}

export interface DocumentLinkRow {
  id: string; companyId: string;
  sourceDocumentId: string; sourceLineId: string | null;
  targetDocumentId: string; targetLineId: string | null;
  linkKind: LinkKind; quantity: string | null; amount: string | null; createdAt: string;
}

export interface OpenQuantityRow {
  documentId: string; documentLineId: string; lineNo: number; itemId: string | null;
  orderedQuantity: string; linkedQuantity: string; openQuantity: string;
}

interface LinkDbRow {
  id: string; company_id: string;
  source_document_id: string; source_line_id: string | null;
  target_document_id: string; target_line_id: string | null;
  link_kind: LinkKind; quantity: string | null; amount: string | null;
  /** `timestamptz` is left UNCAST in both selects below, so postgres.js hands back a `Date`. A `::text` cast
   *  would give `2026-01-15 10:00:00+00` — a space, not a `T` — which `TimestampSchema`
   *  (`z.string().datetime({ offset: true })`, §4.2.8) rejects. `toISOString()` is the RFC 3339 it wants. */
  created_at: Date;
}

const toRow = (r: LinkDbRow): DocumentLinkRow => ({
  id: r.id, companyId: r.company_id,
  sourceDocumentId: r.source_document_id, sourceLineId: r.source_line_id,
  targetDocumentId: r.target_document_id, targetLineId: r.target_line_id,
  linkKind: r.link_kind, quantity: r.quantity, amount: r.amount,
  createdAt: r.created_at.toISOString(),
});

/**
 * Records one fulfilment link per input line and, when `priceFromSource` is not false and the target line
 * carries no `unit_price`, copies the source line's price onto it and recomputes `amount` as
 * `round(unit_price × quantity − discount, 4)` in SQL — never in JavaScript, where a `number` would touch a
 * monetary value (spec:2041).
 *
 * Every rule about *whether* the link is legal lives in `app.assert_document_link_within_open_quantity()`
 * (migration 0037): the target must be a draft (`ERR_DOC_NOT_DRAFT`), the source must be issued or posted
 * (`ERR_DOC_STATUS_ILLEGAL`), and the sum of links must not exceed the ordered quantity
 * (`ERR_DOC_LINK_OVER_FULFILLED`). This function raises none of them itself — the caller's
 * `fromDatabaseError` translates the token (§4.2.4), which is what makes the guard hold for a direct
 * `app_rw` statement too (spec:2173).
 */
export async function linkFulfilment(
  tx: Sql, ctx: TenantContext, input: LinkFulfilmentInput,
): Promise<DocumentLinkRow[]> {
  const [target] = await tx<{ company_id: string }[]>`
    select company_id from app.document where id = ${input.targetDocumentId}`;
  if (target === undefined) {
    // The caller maps this to ERR_NOT_FOUND; packages/db may not import AppError (§3.1).
    throw new Error(`ERR_NOT_FOUND: document ${input.targetDocumentId} is not visible`);
  }

  const created: DocumentLinkRow[] = [];
  // SORTED BY SOURCE LINE, and it is a correctness requirement rather than tidiness. The 0037 trigger takes
  // `pg_advisory_xact_lock` on each source line before it sums, so two transactions linking the same pair of
  // order lines in opposite orders would deadlock (one 40P01, retried by `withTenant` — §4.2.2 — but a sorted
  // loop never gets there). Sorting the acquisition order is 3A's rule for `lockStockKeys` (3a:5719–5727),
  // applied to the same problem. The copy is what keeps the caller's `readonly` array untouched.
  const lines = [...input.lines].sort((x, y) => (x.sourceLineId < y.sourceLineId ? -1 : x.sourceLineId > y.sourceLineId ? 1 : 0));
  for (const l of lines) {
    const [row] = await tx<LinkDbRow[]>`
      insert into app.document_link
        (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${ctx.tenantId}, ${target.company_id}, ${input.sourceDocumentId}, ${l.sourceLineId},
              ${input.targetDocumentId}, ${l.targetLineId}, ${input.linkKind}, ${l.quantity})
      returning id, company_id, source_document_id, source_line_id, target_document_id, target_line_id,
                link_kind, quantity::text as quantity, amount::text as amount, created_at`;
    created.push(toRow(row!));

    if (input.priceFromSource !== false) {
      await tx`
        update app.document_line t
           set unit_price = s.unit_price,
               amount     = round(s.unit_price * t.quantity - t.discount, 4)
          from app.document_line s
         where t.id = ${l.targetLineId}
           and s.id = ${l.sourceLineId}
           and t.unit_price is null
           and s.unit_price is not null
           and t.quantity is not null`;
    }
  }
  return created;
}

export async function listLinks(tx: Sql, documentId: string): Promise<DocumentLinkRow[]> {
  const rows = await tx<LinkDbRow[]>`
    select id, company_id, source_document_id, source_line_id, target_document_id, target_line_id,
           link_kind, quantity::text as quantity, amount::text as amount, created_at
      from app.document_link
     where source_document_id = ${documentId} or target_document_id = ${documentId}
     order by created_at, id`;
  return rows.map(toRow);
}

export async function openQuantity(tx: Sql, documentId: string): Promise<OpenQuantityRow[]> {
  const rows = await tx<{
    document_id: string; document_line_id: string; line_no: number; item_id: string | null;
    ordered_quantity: string; linked_quantity: string; open_quantity: string;
  }[]>`
    select document_id, document_line_id, line_no, item_id,
           ordered_quantity::text as ordered_quantity,
           linked_quantity::text  as linked_quantity,
           open_quantity::text    as open_quantity
      from app.document_open_quantity
     where document_id = ${documentId}
     order by line_no`;
  return rows.map((r) => ({
    documentId: r.document_id, documentLineId: r.document_line_id, lineNo: r.line_no, itemId: r.item_id,
    orderedQuantity: r.ordered_quantity, linkedQuantity: r.linked_quantity, openQuantity: r.open_quantity,
  }));
}
```

Add to `packages/db/src/index.ts`:

```ts
export {
  linkFulfilment, listLinks, openQuantity,
  type DocumentLinkRow, type FulfilmentLineInput, type LinkFulfilmentInput, type LinkKind, type OpenQuantityRow,
} from "./documents/link";
```

- [ ] **Step 4: Write `packages/contracts/src/accounting/document-link.ts`**

```ts
import { z } from "@hono/zod-openapi";
import { ListEnvelope, QuantitySchema, TimestampSchema, UuidSchema } from "../common";

export const LinkKindSchema = z
  .enum(["fulfils", "converts_to", "receives_against", "returns", "settles"])
  .openapi("LinkKind");

export const DocumentLinkSchema = z
  .object({
    id: UuidSchema,
    companyId: UuidSchema,
    sourceDocumentId: UuidSchema,
    sourceLineId: UuidSchema.nullable(),
    targetDocumentId: UuidSchema,
    targetLineId: UuidSchema.nullable(),
    linkKind: LinkKindSchema,
    quantity: QuantitySchema.nullable(),
    /** A 4-dp decimal string and NOT `MoneySchema`, under the exception Task 0 Step 5 registers in §4.2.8:
     *  `app.document_link` has no currency column, and the currency is the one named by the `{documentId}`
     *  in this route's own path. The figure is still computed in `Money` and still scale 4. */
    amount: z.string().regex(/^-?\d+\.\d{4}$/).nullable(),
    createdAt: TimestampSchema,
  })
  .openapi("DocumentLink");

export const CreateDocumentLinksBody = z
  .object({
    sourceDocumentId: UuidSchema,
    linkKind: LinkKindSchema,
    /** Copy the source line's unit price onto an unpriced target line (spec:1050). Default true. */
    priceFromSource: z.boolean().default(true),
    lines: z
      .array(z.object({ sourceLineId: UuidSchema, targetLineId: UuidSchema, quantity: QuantitySchema }))
      .min(1),
  })
  .openapi("CreateDocumentLinksBody");

export const DocumentLinkList = ListEnvelope(DocumentLinkSchema).openapi("DocumentLinkList");

export const OpenQuantitySchema = z
  .object({
    documentId: UuidSchema,
    documentLineId: UuidSchema,
    lineNo: z.number().int().positive(),
    itemId: UuidSchema.nullable(),
    orderedQuantity: QuantitySchema,
    linkedQuantity: QuantitySchema,
    openQuantity: QuantitySchema,
  })
  .openapi("OpenQuantity");

export const OpenQuantityList = ListEnvelope(OpenQuantitySchema).openapi("OpenQuantityList");
```

**`next_cursor` is a constant `null` on both lists, and the reason is stated on the route.** A document's own links and its own open quantity are bounded by its line count, exactly like 2B's `GET …/documents/{documentId}/events`; advertising `ListQuery` while ignoring it would let a caller mistake a truncated page for a complete list (§4.2.8). Neither route declares a query parameter, and there is no `DocumentLinkQuery`.

- [ ] **Step 5: Write `apps/api/src/documents/link-handlers.ts`**

```ts
import { createRoute, z } from "@hono/zod-openapi";
import {
  CreateDocumentLinksBody, DocumentLinkList, OpenQuantityList, ProblemSchema, UuidSchema,
} from "@dulja/contracts";
import { linkFulfilment, listLinks, openQuantity } from "@dulja/db";
import { AppError, fromDatabaseError } from "@dulja/contracts";
// 2C's file, and the ONLY home of MODULE_READ_CODE and its two middlewares (2c:1794, 2c:4591). §4.5.8's
// prose says `routes/accounting/attachments.ts`; the merged plan says this, and Task 0 Step 6 corrects §4.5.8.
import { requireDocumentModuleRead } from "../middleware/require-attachment-read";
import { requireDocumentPermission } from "../middleware/require-document-permission";
import { IdempotencyHeader } from "../routes/index";
import type { AppEnv } from "../context";
import type { Context } from "hono";

const PathParams = z.object({ companyId: UuidSchema, documentId: UuidSchema });

/** Any error whose message starts with a token is turned into that AppError; anything else goes through
 *  fromDatabaseError. `packages/db` cannot import AppError (§3.1), so the translation happens here. */
function asAppError(e: unknown): AppError {
  if (e instanceof Error && /^ERR_[A-Z_]+: /.test(e.message)) {
    const [code, ...rest] = e.message.split(": ");
    return new AppError(code as never, rest.join(": "));
  }
  return fromDatabaseError(e);
}

export const createDocumentLinksRoute = createRoute({
  method: "post",
  path: "/{documentId}/links",
  request: { params: PathParams, headers: IdempotencyHeader, body: { content: { "application/json": { schema: CreateDocumentLinksBody } } } },
  responses: {
    201: { description: "The links created", content: { "application/json": { schema: DocumentLinkList } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    409: { description: "The target is not a draft, or the source is not issued", content: { "application/problem+json": { schema: ProblemSchema } } },
    422: { description: "Over-fulfilled", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
  // "submit", not "create": both resolve `approval.create ?? approval.post` (2a:2867–2871), but 2A's
  // "create" branch finds the type in the request BODY and 404s when it is absent (2a:2897–2906). This body
  // names a source document, not a type. See the File Structure section.
  middleware: [requireDocumentPermission("submit")] as const,
  tags: ["documents"],
});

export async function createDocumentLinks(c: Context<AppEnv>) {
  const { documentId } = c.req.valid("param" as never) as { documentId: string };
  const body = c.req.valid("json" as never) as z.infer<typeof CreateDocumentLinksBody>;
  try {
    const items = await c.var.withTenant((tx) =>
      linkFulfilment(tx, c.var.ctx, {
        sourceDocumentId: body.sourceDocumentId,
        targetDocumentId: documentId,
        linkKind: body.linkKind,
        lines: body.lines,
        priceFromSource: body.priceFromSource,
      }),
    );
    return c.json({ items, next_cursor: null }, 201);
  } catch (e) {
    throw asAppError(e);
  }
}

export const listDocumentLinksRoute = createRoute({
  method: "get",
  path: "/{documentId}/links",
  request: { params: PathParams },
  responses: {
    200: { description: "Every link into or out of this document", content: { "application/json": { schema: DocumentLinkList } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
  middleware: [requireDocumentModuleRead()] as const,
  tags: ["documents"],
});

export async function listDocumentLinks(c: Context<AppEnv>) {
  const { documentId } = c.req.valid("param" as never) as { documentId: string };
  // Deliberately unpaged: a document's own links are bounded by its line count (§4.2.8, 2B's precedent).
  const items = await c.var.withTenant((tx) => listLinks(tx, documentId));
  return c.json({ items, next_cursor: null }, 200);
}

export const openQuantityRoute = createRoute({
  method: "get",
  path: "/{documentId}/open-quantity",
  request: { params: PathParams },
  responses: {
    200: { description: "Ordered, linked and open quantity per line", content: { "application/json": { schema: OpenQuantityList } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
  middleware: [requireDocumentModuleRead()] as const,
  tags: ["documents"],
});

export async function getOpenQuantity(c: Context<AppEnv>) {
  const { documentId } = c.req.valid("param" as never) as { documentId: string };
  const items = await c.var.withTenant((tx) => openQuantity(tx, documentId));
  return c.json({ items, next_cursor: null }, 200);
}
```

- [ ] **Step 6: Mount the three sub-paths in `apps/api/src/routes/accounting/documents.ts`**

Beside 1A's existing `documentRoutes.openapi(...)` calls, add:

```ts
import {
  createDocumentLinks, createDocumentLinksRoute,
  getOpenQuantity, openQuantityRoute,
  listDocumentLinks, listDocumentLinksRoute,
} from "../../documents/link-handlers";

documentRoutes.openapi(createDocumentLinksRoute, createDocumentLinks);
documentRoutes.openapi(listDocumentLinksRoute, listDocumentLinks);
documentRoutes.openapi(openQuantityRoute, getOpenQuantity);
```

**No `RouteModule` is added and no `PROBES` key is added.** These are sub-paths on the module 1A already registered at `/v1/companies/:companyId/documents`; `PROBES` is keyed by `RouteModule.path` (hazard 31), so the existing key covers them exactly as it covers 2B's four sub-paths and 2C's print route.

- [ ] **Step 7: Run the route test to verify it passes**

Run: `cd apps/api && bun run test -- test/routes/accounting/document-links.test.ts`
Expected: **PASS** (5 tests).

Three failures worth naming in advance. If the price-copy assertion reports `unit_price: null`, the `update … from` joined on the wrong side — `t` is the target line named by `targetLineId` and `s` the source named by `sourceLineId`, and swapping them silently updates nothing because `t.unit_price is null` then fails on the priced source. If `ERR_DOC_LINK_OVER_FULFILLED` arrives as a **500** `ERR_INTERNAL`, `asAppError` was not reached — check that `fromDatabaseError` maps SQLSTATE 23514 whose message starts `/^ERR_[A-Z_]+:/` to that code (§4.2.4) and that the handler's `try` wraps the `withTenant` call and not just the `linkFulfilment` call. If the replay case creates two links, the idempotency middleware is not registered for this path — it is registered with `app.use` for every unsafe method (§4.2.3), so a second link means the route was mounted outside `documentRoutes`.

- [ ] **Step 8: Re-run the tenant-isolation harness (test 12)**

Run: `cd ../../tests && bun run test -- invariants/tenant-isolation.test.ts`
Expected: **PASS**. The harness fails the build when a `ROUTES` entry has no `PROBES` entry; three new sub-paths on an already-probed module add no entry and remove none, which is the assertion this step makes.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/documents/link.ts packages/db/src/index.ts \
        packages/contracts/src/accounting/document-link.ts \
        apps/api/src/documents/link-handlers.ts apps/api/src/routes/accounting/documents.ts \
        apps/api/test/routes/accounting/document-links.test.ts
git commit -m "feat(api): record fulfilment links and read open quantity on the documents module [3C T4]

Three sub-paths, no new route module and no new PROBES key. A goods receipt is priced from the order
it receives against (spec:1050). Every legality rule stays in the 0037 trigger.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `PURCHASE_ORDER` — the type that is issued and never posted, and its open quantity end to end

**Files:**
- Create: `packages/db/seed/my/document-types/PURCHASE_ORDER.json`
- Create: `packages/db/test/purchasing/purchase-order.test.ts`
- Test: `packages/db/test/purchasing/purchase-order.test.ts`

**Interfaces:**
- Consumes: the §4.3.7 envelope and `document-type-seed.schema.json` (1A); `loadDocumentTypes` / `documentTypesLoader` (1A) reached through `@dulja/db/seed`; `validateDocumentTypeSeed`, `validatePolicy`, `parsePolicy` (2A); `postDocument`, `issueDocument`, `transitionDocument` (1A, 2B); `accounting.purchase.create` (Task 2); `PostingError` (1A). **Not here:** `openQuantity` and `linkFulfilment` (Task 4) — the two cases that use them need `GOODS_RECEIPT` and arrive with Task 6 Step 5.
- Produces: `packages/db/seed/my/document-types/PURCHASE_ORDER.json` — the §4.14 row `PURCHASE_ORDER` / module `inventory` / series `PO` / `direction: none` / `inventory: none` / `approval.post: accounting.purchase.create`.

**The one design decision in this task, stated plainly.** spec:1050 makes a purchase order a "non-posting commitment document (`direction: none`, `inventory: none`) with agreed price, quantity and open-quantity tracking … no approval workflow (that stays Phase 10)". Three consequences follow mechanically and each is asserted below.
1. **Its policy plans zero ledger lines**, so `postDocument` raises `ERR_DOC_NO_LINES` at §4.3.2 step 6. That is not a bug to work around — it is the mechanism that makes the type non-posting, and there is no other one in the system.
2. **It stops at `issued`.** `approval.required = false` makes `draft → issued` legal (§4.5.1) and `transitionDocument(…, to: "issued")` delegates to `issueDocument`, so the order gets its `PO` series number and its fiscal period without ever touching the ledger.
3. **`approval.post` is `accounting.purchase.create`, not `accounting.purchase.post`.** §4.5.4 gates the `issue` stage on `approval.post`, and spec:2159 gives the back-office clerk (`user`) order drafting with `*.create` only — so naming `.post` here would mean a clerk could raise an order but not issue it, which is the approval workflow spec:1050 defers to Phase 10. `approval.create` is omitted and therefore defaults to `approval.post`, exactly as JOURNAL's does (§4.4.1).

- [ ] **Step 1: Write the failing test `packages/db/test/purchasing/purchase-order.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDocumentTypeSeed } from "@dulja/domain";
import { PERMISSIONS } from "@dulja/contracts";
import { postDocument, transitionDocument } from "../../src/index";
import { documentTypesLoader } from "../../src/seed/index";
// `openQuantity`, `linkFulfilment` and `seedWarehouse` are NOT imported here: the two cases that need them
// also need `GOODS_RECEIPT`, which Task 6 seeds, so Task 6 Step 5 appends those cases and these imports
// together. An import this file does not yet use fails `bun run lint` (Global Constraint 16).
import {
  draftTypedDocument, grantCodes, seedItem, seedParty, seedTenantV2,
  startDb, withTenant, type Db, type Seed,
} from "../index";

const here = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(here, "..", "..", "seed", "my");
const TYPES_DIR = join(PACK_ROOT, "document-types");

let db: Db;
let s: Seed;

const ctx = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "3c-po-test" });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "po");
  await grantCodes(db, s, { codes: ["accounting.purchase.create", "inventory.receipt.create", "inventory.receipt.post"] });
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    documentTypesLoader.load(tx, {
      config: {
        tenantId: s.tenant, only: ["document-types"], packRoot: PACK_ROOT,
        tenantName: "po", ownerEmail: "owner@example.invalid",
        companyCode: "HQ", companyName: "po HQ", baseCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur", fiscalYearStartMonth: 1, fiscalYear: 2026,
      },
      tenantId: s.tenant, companyId: s.company, systemPrincipalId: s.system, packRoot: PACK_ROOT,
    }),
  );
}, 240_000);
afterAll(async () => { await db.stop(); });

async function typeId(code: string): Promise<string> {
  const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = ${code}`);
  return row!.id;
}

describe("PURCHASE_ORDER — contracts §4.14, spec:1050", () => {
  it("the seed file is a valid §4.3.7 envelope with module inventory and series PO", () => {
    const envelope = JSON.parse(readFileSync(join(TYPES_DIR, "PURCHASE_ORDER.json"), "utf8")) as Record<string, unknown>;
    expect(validateDocumentTypeSeed(envelope)).toEqual({ ok: true, errors: [] });
    expect(envelope["code"]).toBe("PURCHASE_ORDER");
    expect(envelope["module"]).toBe("inventory");
    const policy = envelope["policy"] as Record<string, unknown>;
    expect(policy["direction"]).toBe("none");
    expect(policy["inventory"]).toEqual({ effect: "none" });
    expect(policy["lines"]).toEqual([]);
    expect(policy["numbering"]).toEqual({ series: "PO", assignAt: "issue" });
    expect(policy["approval"]).toEqual({ required: false, approve: null, post: "accounting.purchase.create" });
    expect(policy["reversal"]).toEqual({ allowed: false, producesType: null });
  });

  it("every approval code the policy names is in the catalogue (F-21)", () => {
    const envelope = JSON.parse(readFileSync(join(TYPES_DIR, "PURCHASE_ORDER.json"), "utf8")) as { policy: { approval: Record<string, string | null> } };
    const codes = PERMISSIONS.map((p) => p.code as string);
    for (const named of Object.values(envelope.policy.approval)) {
      if (typeof named === "string") expect(codes).toContain(named);
    }
  });

  it("issues, takes a PO number, and never posts (ERR_DOC_NO_LINES by design)", async () => {
    const documentTypeId = await typeId("PURCHASE_ORDER");
    const partyId = await seedParty(db, s, { kind: "vendor", code: "PO-VEND" });
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "PO-ITEM" });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId, series: "PO", partyId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "250.000000", unitPrice: "4.0000", amount: "1000.0000" }],
    });

    const issued = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctx(s), { documentId, to: "issued" }),
    );
    expect(issued).toMatchObject({ from: "draft", to: "issued" });
    expect(issued.number).toBe(1n);

    const [header] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { series: string; status: string; number: string }[]
    >`select series, status::text as status, number::text as number from app.document where id = ${documentId}`);
    expect(header).toEqual({ series: "PO", status: "issued", number: "1" });

    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId })),
    ).rejects.toMatchObject({ code: "ERR_DOC_NO_LINES" });

    // Nothing reached the ledger or the movements.
    const [counts] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ ledger: number; movements: number }[]>`
      select (select count(*)::int from app.ledger_entry where document_id = ${documentId}) as ledger,
             (select count(*)::int from app.inventory_movement where document_id = ${documentId}) as movements`);
    expect(counts).toEqual({ ledger: 0, movements: 0 });
  });

});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/purchasing/purchase-order.test.ts`
Expected: **FAIL** — `ENOENT` on `document-types/PURCHASE_ORDER.json` inside `beforeAll`, so every test in the file errors.

- [ ] **Step 3: Write `packages/db/seed/my/document-types/PURCHASE_ORDER.json`**

```json
{
  "code": "PURCHASE_ORDER",
  "nameEn": "Purchase Order",
  "nameAr": "أمر شراء",
  "module": "inventory",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "PURCHASE_ORDER",
    "direction": "none",
    "requires": ["party"],
    "lines": [],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "PO", "assignAt": "issue" },
    "reversal": { "allowed": false, "producesType": null },
    "approval": { "required": false, "approve": null, "post": "accounting.purchase.create" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

`"lines": []` is the whole of "non-posting". `"reversal": { "allowed": false, "producesType": null }` because a commitment that never posted has nothing to reverse — it is voided instead (`issued → void` is legal and records the number in `document_number_void`). `"dimensions": { "required": [] }` rather than `["BRANCH"]`: `dimensions.required` is checked against **planned ledger lines** (§4.4.1) and there are none, so requiring a type code here would assert nothing; the order's `document.branch_id` is NOT NULL regardless.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/db && bun run test -- test/purchasing/purchase-order.test.ts`
Expected: **PASS** (3 tests) — and **all three of them, at this commit**. The two open-quantity cases that need a second document type (`GOODS_RECEIPT`, Task 6) are not in this file yet: **Task 6 Step 5 appends them, with their three imports, in the commit that makes them green.** That is why this task's suite is green on its own rather than "green except two" — Global Constraint 16 requires `bun run test` at the root to pass after **every** task, and a plan that lands a red case has no way to distinguish a deliberate red from a regression.

Two failures worth naming in advance. If `validateDocumentTypeSeed` reports `additionalProperties` on `policy`, a member was put inside `policy` that belongs in the envelope — `nameEn`, `nameAr`, `module`, `policyVersion` and `effectiveFrom` are all outside it (§4.3.7, hazard 34). If `transitionDocument(…, to: "issued")` returns `number: undefined`, 2B's `transitionDocument` is writing the status itself instead of delegating to `issueDocument`; that is 2B's own named failure mode and it is fixed there, not here.

- [ ] **Step 5: Commit**

```bash
git add packages/db/seed/my/document-types/PURCHASE_ORDER.json packages/db/test/purchasing/purchase-order.test.ts
git commit -m "feat(seed): add the PURCHASE_ORDER document type — issued, numbered, never posted [3C T5]

lines: [] is the whole of non-posting (spec:1050); approval.post is accounting.purchase.create so a
back-office clerk can issue an order without the Phase 10 approval workflow.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `GOODS_RECEIPT` — the GRNI accrual, pricing from the order, and the free-of-charge receipt line

**Files:**
- Create: `packages/db/seed/my/document-types/GOODS_RECEIPT.json`
- Create: `packages/db/test/purchasing/goods-receipt.test.ts` (the envelope case only — Task 8 Step 7 appends the four posting cases)
- Modify: `packages/db/test/purchasing/purchase-order.test.ts` (append the two open-quantity cases Task 5 deferred)
- Test: `packages/db/test/purchasing/goods-receipt.test.ts`, `packages/db/test/purchasing/purchase-order.test.ts`

**Interfaces:**
- Consumes: `validateDocumentTypeSeed` (2A) for this task's own case; `transitionDocument` (2B), `linkFulfilment`, `openQuantity` (Task 4), `seedWarehouse` (3A) for the two cases Step 5 appends to Task 5's file; `2150` (Task 3); `inventory.receipt.create` / `inventory.receipt.post` (Task 2); `item.inventory_account` resolution through `ItemRef` (§4.4.2) and `app.item.inventory_account_id` defaulting to `1300` (§4.6.1). **`postDocument`, `applyMovements`, `costingEngine`, `app.inventory_movement`, `app.stock_on_hand` and `app.cost_layer` are consumed by the four posting cases, which land in Task 8 Step 7** — no receipt can post before it (§4.7.2).
- Produces: `packages/db/seed/my/document-types/GOODS_RECEIPT.json` — the §4.14 row `GOODS_RECEIPT` / module `inventory` / series `GRN` / `direction: inbound` / `inventory: receipt` / `approval.post: inventory.receipt.post`. **The `2150` GRNI accrual leg is the §3.0.4 row spec:1049 this slice owns.**

**The accounting: four rules, every one of them at `line.amount`, and the freight reaches inventory through its own debit.** A goods receipt takes stock in at a value and owes for it; the invoice has not arrived, so the credit is an accrual. The item line debits `item.inventory_account` and credits `2150` at the supplier's price (`line.amount`); each freight, duty or clearance line — a `kind: "account"` line whose `account_id` is the forwarder's, customs' or the agent's accrual account — debits **`1300` inventory control** and credits `line.account`, also at `line.amount`. So the inventory side of the ledger receives `goods amount + Σ freight amounts`, which is exactly the figure §4.7.2's `receiptValue` puts into the layer (`toBase(line.amount + Σ allocated, rate)`, and `Σ allocated = Σ` the cost lines' amounts by construction — `Money.allocate` sums exactly). **The inventory account equals the layer to the cent, reached by addition rather than by reading `line.cost`.**

**Why not debit `line.cost` directly, which reads more obviously.** Because it cannot post. §4.3.2 **step 6** runs `balanceInBase` before step 9 fills the cost, and on a fresh draft `LineSnapshot.cost` is `null` — A5 emits that leg at `Money.zero` and exempts it from the zero-*drop*, but nothing exempts it from the *balance check*. A policy pairing a cost leg against a `line.amount` leg plans `0` against the full amount, the residue is the whole document, and step 6 raises `ERR_LEDGER_UNBALANCED` before any insert; 3B's re-evaluation after step 9 (3b:3172–3180) is never reached. This is why **3B's own receipt policy puts `line.amount` on both legs** (3b:2580–2581) while its issue policy is cost/cost (3b:2556–2557), and it is the rule Task 0 Step 3 registers in §4.3.4. A cost reference belongs on an **issue** document, which is where Task 10's `PURCHASE_RETURN` puts it.

**Two consequences worth stating.** (1) Crediting `line.amount` keeps the GRNI liability in the **supplier's currency** at the header rate, so 4A's `PURCHASE_INVOICE` clears an accrual denominated the way the invoice will be; a base-currency credit would have booked the liability at rate 1 and left 4A an FX difference nobody planned. (2) `GOODS_RECEIPT` and `SHIPMENT` therefore share **one** policy shape, differing only in `requires` and in the paperwork the warehouse files against them — the landed-cost route (Task 9) is what makes a shipment a shipment. That is honest rather than accidental, and it is why Task 9 seeds `SHIPMENT.json` as a near-copy and says so.

**The free-of-charge line, and why it needs no policy rule of its own.** spec:1055 wants "free-of-charge lines that consume stock and cost at zero price". On the buy side a FOC line is a supplier bonus: `unit_price = 0`, `amount = 0`, a real `quantity`. `inventory.effect` is what emits the movement, not `lines`, so the bonus quantity enters stock and creates a layer at `unit_cost = 0`; both of its planned ledger lines resolve `line.amount` to zero and are dropped by §4.3.2 step 6's ordinary zero-drop — A5's exemption is not involved at all here, because no rule on this policy references `line.cost`. The result is stock in with no ledger effect, which is what a free bonus is. **The test below asserts the aggregate, not the row count**, because whether a zero line survives to `ledger_entry` as a `0/0` row depends on where 3B's body drops it and `ledger_entry` has no "not both zero" CHECK (plan0A:2012–2013) — see this plan's *Spec questions*.

- [ ] **Step 1: Write the failing test `packages/db/test/purchasing/goods-receipt.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateDocumentTypeSeed } from "@dulja/domain";

const here = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(here, "..", "..", "seed", "my");
const TYPES_DIR = join(PACK_ROOT, "document-types");

describe("GOODS_RECEIPT — contracts §4.14, §3.0.4 row spec:1049", () => {
  it("the seed file is a valid envelope: inbound, receipt, create_layer, series GRN, and it names 2150", () => {
    const envelope = JSON.parse(readFileSync(join(TYPES_DIR, "GOODS_RECEIPT.json"), "utf8")) as Record<string, unknown>;
    expect(validateDocumentTypeSeed(envelope)).toEqual({ ok: true, errors: [] });
    expect(envelope["module"]).toBe("inventory");
    const policy = envelope["policy"] as Record<string, unknown>;
    expect(policy["direction"]).toBe("inbound");
    expect(policy["inventory"]).toEqual({ effect: "receipt", warehouse: "line.warehouse", costing: "create_layer" });
    expect(policy["numbering"]).toEqual({ series: "GRN", assignAt: "issue" });
    expect(policy["approval"]).toEqual({ required: false, approve: null, post: "inventory.receipt.post", create: "inventory.receipt.create" });
    // Four rules, every amount `line.amount`: the item line debits item.inventory_account and credits 2150;
    // each freight/duty/clearance `account` line debits 1300 and credits its own account. NO rule references
    // line.cost — §4.3.2 step 6 balances before step 9 fills it (Task 0 Step 3's §4.3.4 rule).
    expect((policy["lines"] as { side: string; amount: string }[]).map((l) => [l.side, l.amount])).toEqual([
      ["debit", "line.amount"], ["credit", "line.amount"], ["debit", "line.amount"], ["credit", "line.amount"],
    ]);
    expect(JSON.stringify(policy["lines"])).toContain('"code":"2150"');
    expect(JSON.stringify(policy["lines"])).toContain('"code":"1300"');
    expect(JSON.stringify(policy["lines"])).not.toContain("line.cost");
  });
});
```

**One case, no `beforeAll`, and no database — deliberately.** The four cases that *post* a goods receipt cannot pass in this task and cannot pass in any task before **Task 8**: `planMovements` (3A) returns every movement with `value: null` and 3B's `costReceipt` refuses a null value, so **no receipt can post anywhere in the system until Task 8 lands the receipt-value site** (§4.7.2, registered in Task 0 Step 4). Global Constraint 16 requires the root `bun run test` to be green after **every** task, so those four cases — and the `startDb` container, the loaders, `grantCodes`, `seedParty`, `seedWarehouse` and the imports they need — are written in **Task 8 Step 7**, which appends them to this same file in the commit that makes them green. This task therefore lands a pure file-reading case that needs nothing but the JSON on disk, and every import in the block above is used by it (an unused import fails `bun run lint`).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/purchasing/goods-receipt.test.ts`
Expected: **FAIL** — `ENOENT: no such file or directory, open '…/seed/my/document-types/GOODS_RECEIPT.json'` **inside the case** (there is no `beforeAll` in this file yet), so the one test fails and nothing else runs.

- [ ] **Step 3: Write `packages/db/seed/my/document-types/GOODS_RECEIPT.json`**

```json
{
  "code": "GOODS_RECEIPT",
  "nameEn": "Goods Receipt",
  "nameAr": "إشعار استلام بضاعة",
  "module": "inventory",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "GOODS_RECEIPT",
    "direction": "inbound",
    "requires": ["party", "warehouse"],
    "lines": [
      {
        "for": "each_line",
        "side": "debit",
        "account": { "from": "item.inventory_account" },
        "amount": "line.amount",
        "when": { "line.kind": "item" }
      },
      {
        "for": "each_line",
        "side": "credit",
        "account": { "code": "2150" },
        "amount": "line.amount",
        "when": { "line.kind": "item" }
      },
      {
        "for": "each_line",
        "side": "debit",
        "account": { "code": "1300" },
        "amount": "line.amount",
        "when": { "line.kind": "account" }
      },
      {
        "for": "each_line",
        "side": "credit",
        "account": { "from": "line.account" },
        "amount": "line.amount",
        "when": { "line.kind": "account" }
      }
    ],
    "inventory": { "effect": "receipt", "warehouse": "line.warehouse", "costing": "create_layer" },
    "tax": { "applies": false },
    "numbering": { "series": "GRN", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "GOODS_RECEIPT" },
    "approval": {
      "required": false,
      "approve": null,
      "post": "inventory.receipt.post",
      "create": "inventory.receipt.create"
    },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

**Six members that look arbitrary and are not.** The **third and fourth rules together** — `{ "code": "1300" }` debited and `{ "from": "line.account" }` credited, both `when: { "line.kind": "account" }` — are the freight pair: a domestic receipt that carries its own inland-freight line capitalises it into inventory control and credits *that line's* accrual account, and the pair matches nothing on a receipt with no `account` line, so it costs a plain GRN nothing (§4.4.1's `when` is a conjunction of equalities). `1300` is the **company-wide** inventory control account rather than `item.inventory_account`, and it has to be: an `account`-kind line carries no `item_id`, so `item.inventory_account` has nothing to resolve against — this is the same reason §4.7.3 has `COST_ADJUSTMENT` post to the `1300`/`5000` literals when it aggregates across items. The consequence is honest and is asserted below: with per-item inventory accounts the goods debit and the freight debit can land in **different** accounts, and it is the *sum over the inventory accounts* that equals the layer, which is what a valuation report compares anyway. `"tax": { "applies": false }` — tax on a purchase arrives with the supplier's invoice (4A's `PURCHASE_INVOICE`), not with the goods; a receipt that claimed input tax before the invoice existed would put a claim in the return that the authority has no document for. `"requires": ["party", "warehouse"]` — `validateRequires` raises `ERR_POLICY_REQUIRES_MISSING` naming the field, so a receipt with no supplier or no warehouse is refused at post rather than posting to a null account. `"reversal": { "allowed": true, "producesType": "GOODS_RECEIPT" }` — a reversal carries negated magnitudes on its own lines and the sign normalisation of §4.4.2 flips the sides, so **one** policy produces both directions; the reversal's movement is an issue against the same layer. `"dimensions": { "required": ["BRANCH"] }` — the evaluator tags every planned line with `document.branch_id` as `BRANCH` and then checks `required`, so this makes a branchless receipt impossible rather than merely unlikely.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/db && bun run test -- test/purchasing/goods-receipt.test.ts`
Expected: **PASS** (1 test). The envelope case reads the file off disk, so it goes green the moment Step 3 lands.

One failure worth naming in advance. If `validateDocumentTypeSeed` reports `additionalProperties` on `policy`, a member was put inside `policy` that belongs in the envelope — `nameEn`, `nameAr`, `module`, `policyVersion` and `effectiveFrom` are all outside it (§4.3.7, hazard 34).

- [ ] **Step 5: Append the two open-quantity cases to `packages/db/test/purchasing/purchase-order.test.ts`, and re-run that file**

Task 5 deferred these two: both draft a `GOODS_RECEIPT`, which did not exist until Step 3. **Neither posts anything** — an order never posts, and a receipt is only *linked* here — so both are green in this task and neither waits for Task 8.

First widen that file's import block by exactly three names, which is what the comment Task 5 left there says to do:

```ts
import { postDocument, transitionDocument, openQuantity, linkFulfilment } from "../../src/index";
import {
  draftTypedDocument, grantCodes, seedItem, seedParty, seedTenantV2, seedWarehouse,
  startDb, withTenant, type Db, type Seed,
} from "../index";
```

Then append the two cases inside the existing `describe`, after the "never posts" case:

```ts
  it("open quantity starts at the ordered quantity and falls as fulfilments are linked (spec:1050)", async () => {
    const orderTypeId = await typeId("PURCHASE_ORDER");
    const receiptTypeId = await typeId("GOODS_RECEIPT");
    const partyId = await seedParty(db, s, { kind: "vendor", code: "PO-VEND-2" });
    const warehouseId = await seedWarehouse(db, s, { code: "PO-WH" });
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "PO-ITEM-2" });

    const order = await draftTypedDocument(db, s, {
      documentTypeId: orderTypeId, series: "PO", partyId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "100.000000", unitPrice: "7.5000", amount: "750.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => transitionDocument(tx, ctx(s), { documentId: order.documentId, to: "issued" }));

    const before = await withTenant(db.rw, s.tenant, s.human, (tx) => openQuantity(tx, order.documentId));
    expect(before).toEqual([{
      documentId: order.documentId, documentLineId: order.lineIds[0], lineNo: 1, itemId,
      orderedQuantity: "100.000000", linkedQuantity: "0.000000", openQuantity: "100.000000",
    }]);

    // Two part receipts: 60 then 40. The back-order stays open in between.
    for (const qty of ["60.000000", "40.000000"]) {
      const receipt = await draftTypedDocument(db, s, {
        documentTypeId: receiptTypeId, series: "GRN", partyId, warehouseId,
        lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: qty }],
      });
      await withTenant(db.rw, s.tenant, s.human, (tx) =>
        linkFulfilment(tx, ctx(s), {
          sourceDocumentId: order.documentId, targetDocumentId: receipt.documentId,
          linkKind: "receives_against",
          lines: [{ sourceLineId: order.lineIds[0]!, targetLineId: receipt.lineIds[0]!, quantity: qty }],
        }),
      );
      const now = await withTenant(db.rw, s.tenant, s.human, (tx) => openQuantity(tx, order.documentId));
      expect(now[0]!.linkedQuantity).toBe(qty === "60.000000" ? "60.000000" : "100.000000");
    }
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) => openQuantity(tx, order.documentId));
    expect(after[0]!.openQuantity).toBe("0.000000");
  });

  it("a third receipt against a fully received order is refused (ERR_DOC_LINK_OVER_FULFILLED)", async () => {
    const orderTypeId = await typeId("PURCHASE_ORDER");
    const receiptTypeId = await typeId("GOODS_RECEIPT");
    const partyId = await seedParty(db, s, { kind: "vendor", code: "PO-VEND-3" });
    const warehouseId = await seedWarehouse(db, s, { code: "PO-WH-3" });
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "PO-ITEM-3" });
    const order = await draftTypedDocument(db, s, {
      documentTypeId: orderTypeId, series: "PO", partyId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "5.000000", unitPrice: "1.0000", amount: "5.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => transitionDocument(tx, ctx(s), { documentId: order.documentId, to: "issued" }));
    const r1 = await draftTypedDocument(db, s, { documentTypeId: receiptTypeId, series: "GRN", partyId, warehouseId, lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "5.000000" }] });
    await withTenant(db.rw, s.tenant, s.human, (tx) => linkFulfilment(tx, ctx(s), {
      sourceDocumentId: order.documentId, targetDocumentId: r1.documentId, linkKind: "receives_against",
      lines: [{ sourceLineId: order.lineIds[0]!, targetLineId: r1.lineIds[0]!, quantity: "5.000000" }],
    }));
    const r2 = await draftTypedDocument(db, s, { documentTypeId: receiptTypeId, series: "GRN", partyId, warehouseId, lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "1.000000" }] });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => linkFulfilment(tx, ctx(s), {
        sourceDocumentId: order.documentId, targetDocumentId: r2.documentId, linkKind: "receives_against",
        lines: [{ sourceLineId: order.lineIds[0]!, targetLineId: r2.lineIds[0]!, quantity: "1.000000" }],
      })),
    ).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
  });```

Run: `cd packages/db && bun run test -- test/purchasing/purchase-order.test.ts`
Expected: **PASS** (5 tests) — Task 5's three plus these two.

Two failures worth naming in advance. If the first case reports `linkedQuantity: "0.000000"` after the 60-unit link, the assertion read the wrong document — the source is the *order* and the target is the draft receipt, and passing them the other way round is refused by the 0037 trigger (`ERR_DOC_STATUS_ILLEGAL`: the source must be issued), never silently zero. If the 40-unit link raises `ERR_DOC_LINK_OVER_FULFILLED`, the guard is counting the row it is inserting in its own sum — check the `x.id <> new.id` filter.

- [ ] **Step 6: Commit**

```bash
git add packages/db/seed/my/document-types/GOODS_RECEIPT.json packages/db/test/purchasing/goods-receipt.test.ts \
        packages/db/test/purchasing/purchase-order.test.ts
git commit -m "feat(seed): add GOODS_RECEIPT with the 2150 GRNI accrual [3C T6]

Four rules, every amount line.amount: no ledger leg reads line.cost, because 4.3.2 step 6 balances before
step 9 fills it. Capitalised freight debits 1300 from its own line, so the sum over the inventory accounts
equals the layer to the cent (spec:1049). The four cases that POST a receipt land in T8, the task that
decides a receipt movement's value; nothing can post one before it (contracts 4.7.2). The two
open-quantity cases T5 deferred are appended here, and both are green.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Migration 0038 — `app.landed_cost_allocation`, the upsert key and the draft-only guard

**Files:**
- Create: `packages/db/migrations/0038_create_landed_cost_allocation.sql`
- Create: `packages/db/migrations/0038.down.sql`
- Create: `packages/db/src/schema/landed-cost-allocation.ts`
- Create: `packages/db/test/landed-cost-allocation.test.ts`
- Create: `docs/adr/0041-landed-cost-allocation-and-purchase-return-valuation.md`
- Test: `packages/db/test/landed-cost-allocation.test.ts`, `packages/db/test/privileges.test.ts` (re-run, unchanged)

**Interfaces:**
- Consumes: `app.document(tenant_id, id)`, `app.document.status` (`app.document_status`, plan0A), `app.document_line(tenant_id, id)`, `app.company(tenant_id, id)`; `app_meta.enable_tenant_rls`, `app_meta.attach_audit` (§4.1). From `@dulja/db/test`: `startDb`, `Db`, `Seed`, `withTenant`, `uuidv7`, `seedTenantV2`, `seedItem`, `seedParty`, `seedWarehouse`, `seedDocumentType`, `grantCodes`, `draftTypedDocument` (Task 0). `lintSchema`, `Violation` from `@dulja/db`.
- Produces:
  - `app.landed_cost_allocation` — the DDL below, exactly: `id`, `tenant_id`, `company_id`, `shipment_document_id`, `cost_line_id`, `target_line_id`, `method text not null check in ('by_value','by_quantity','by_weight')`, `allocated_amount numeric(19,4) not null check (>= 0)`, `created_at`, `unique (tenant_id, id)`, `unique (cost_line_id, target_line_id)`.
  - `app.assert_landed_cost_allocation_draft() returns trigger` and the trigger `landed_cost_allocation_draft_only`, raising the tokens `ERR_DOC_NOT_DRAFT`, `ERR_NOT_FOUND` and `ERR_VALIDATION_FAILED`, each with `errcode = 'check_violation'`.
  - `landedCostAllocation` Drizzle mirror in `packages/db/src/schema/landed-cost-allocation.ts`.
  - `docs/adr/0041-landed-cost-allocation-and-purchase-return-valuation.md` — **a proposal**, because it decides money semantics (spec:95).

**Three design points, each of which a reviewer will otherwise ask about.**

**(1) `unique (cost_line_id, target_line_id)` is the upsert key, and it is why there is no DELETE.** Re-allocating a shipment `by_quantity` after allocating it `by_value` must *replace* the split, not add a second one. `app_rw` holds no DELETE on this table and §3.5.4's grant list is closed (Global Constraint 11), so the only replacement mechanism is `insert … on conflict (cost_line_id, target_line_id) do update`, and that requires exactly this constraint. It is also the SAH-049 fix in its original form: the legacy defect was an aggregate row with no unique key that duplicated under an upsert race and was then double-updated forever. Task 9's handler writes **every** (cost line × goods line) pair on every call, zero shares included — which is why the CHECK is `allocated_amount >= 0` and not `> 0`: a `by_weight` split over a line with no weight, or a `by_value` split over a free-of-charge line, is a legitimate zero, and a row that is absent instead of zero would make a re-allocation leave a stale share behind.

**(2) There is no `weight` column, deliberately.** The obvious convenience — storing the basis each share was computed from — is exactly the shape SAH-017 and SAH-018 name: a derived number kept beside the rows it was derived from, free to drift. The basis is `method` plus the target line's own `amount`, `quantity` or `custom_fields.weight_kg`, all of which are on `document_line` and all of which the guard in point (3) pins to the same document. Task 9's response body recomputes and returns the weights for display; nothing stores them.

**(3) The trigger enforces two rules a CHECK cannot.** A CHECK constraint sees one row and no other table, so neither "the shipment is a draft" nor "both lines belong to that shipment" is expressible as one. Both are enforced in the data layer for the reason §4.5.2 and spec:2173 give — the rule then holds for the API, a job and a direct `app_rw` statement alike, and `fromDatabaseError` (0B) turns each token into the right `Problem` with no per-route mapping. **Draft-only** is not a convenience: 3B's `replay` recomputes a receipt's layer as `unit_cost = value / quantity` from the immutable `inventory_movement.value` (3b:4073–4079), so once a shipment is posted there is nothing left for an allocation to change — a correction is `reverseDocument` plus a re-post. **Same-document** closes a real hole: the composite FKs prove only that both lines belong to the same *tenant*, so without this rule tenant A could allocate its freight across another of its own documents' goods lines and inflate that document's layers.

- [ ] **Step 1: Write the failing test `packages/db/test/landed-cost-allocation.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema, type Violation } from "../src/index";
import {
  draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedItem, seedParty, seedTenantV2,
  seedWarehouse, startDb, withTenant, type Db, type Seed,
} from "./index";

let db: Db;
let a: Seed;
let b: Seed;

/** A SHIPMENT-shaped type: it only has to be a configured type whose documents can hold item and account lines. */
async function shipmentType(s: Seed, code: string, series: string): Promise<string> {
  return seedDocumentType(db, s, {
    code, module: "inventory",
    policy: {
      version: 1, documentType: code, direction: "none", requires: [], lines: [],
      inventory: { effect: "none" }, tax: { applies: false },
      numbering: { series, assignAt: "issue" },
      reversal: { allowed: false, producesType: null },
      approval: { required: false, approve: null, post: "accounting.journal.post" },
      fxRoundingAccount: { from: "company.fx_rounding_account_id" },
      dimensions: { required: [] },
    },
  });
}

/** A draft with two goods lines and one freight line, which is the minimum shape an allocation needs. */
async function draftShipment(s: Seed, typeId: string, series: string, accountId: string): Promise<{ documentId: string; lineIds: string[] }> {
  const { itemId, baseUnitId } = await seedItem(db, s, { code: `LCA-${Math.random().toString(36).slice(2, 8)}` });
  const warehouseId = await seedWarehouse(db, s, { code: `LCA-WH-${Math.random().toString(36).slice(2, 8)}` });
  return draftTypedDocument(db, s, {
    documentTypeId: typeId, series, warehouseId,
    lines: [
      { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "10.000000", unitPrice: "100.0000", amount: "1000.0000" },
      { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "5.000000", unitPrice: "200.0000", amount: "1000.0000" },
      { kind: "account", accountId, description: "ocean freight", amount: "120.0000" },
    ],
  });
}

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "lca-a");
  b = await seedTenantV2(db, "lca-b");
  await grantCodes(db, a, { codes: ["accounting.journal.create", "accounting.journal.post"] });
  await grantCodes(db, b, { codes: ["accounting.journal.create", "accounting.journal.post"] });
  // `seedTenantV2` creates ONLY `1000 Cash` and `4000 Sales` (Assumptions fact 3), and this suite loads no
  // seed pack — so the freight account every `draftShipment` needs is created here, in both tenants, BEFORE
  // any `accountIdOf` call. `5900` is 0C's code and is created rather than seeded: `seedAccount` is
  // idempotent on (company_id, code) and this is a Testcontainers company, not a tenant's chart.
  for (const s of [a, b]) {
    await seedAccount(db, s, { code: "5900", nameEn: "Other operating expense", type: "expense" });
  }
}, 180_000);
afterAll(async () => { await db.stop(); });

async function accountIdOf(s: Seed, code: string): Promise<string> {
  const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = ${code}`);
  return row!.id;
}

describe("app.landed_cost_allocation — migration 0038 (contracts §4.6.1; spec:1020, 1049; SAH-049)", () => {
  it("the schema linter reports zero violations after 0038", async () => {
    const violations: Violation[] = await lintSchema(db.admin);
    expect(violations).toEqual([]);
  });

  it("has tenant_id, forced RLS, a tenant_isolation policy, an audit_row trigger and the draft guard", async () => {
    const [t] = await db.admin<{ rls: boolean; forced: boolean }[]>`
      select relrowsecurity as rls, relforcerowsecurity as forced
        from pg_class where oid = 'app.landed_cost_allocation'::regclass`;
    expect(t).toEqual({ rls: true, forced: true });
    const policies = await db.admin<{ polname: string }[]>`
      select polname from pg_policy where polrelid = 'app.landed_cost_allocation'::regclass order by 1`;
    expect(policies.map((p) => p.polname)).toEqual(["tenant_isolation"]);
    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.landed_cost_allocation'::regclass and not tgisinternal order by 1`;
    expect(triggers.map((x) => x.tgname)).toEqual(["audit_row", "landed_cost_allocation_draft_only"]);
  });

  it("app_rw holds select, insert and update — and NO delete (contracts §3.5.4 is closed)", async () => {
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'landed_cost_allocation' order by 1`;
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("stores one row per (cost line, target line) and REPLACES it on re-allocation through the upsert key", async () => {
    const ty = await shipmentType(a, "LCA_SHIP", "LS");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LS", freightAccount);
    const [goodsA, goodsB, cost] = [lineIds[0]!, lineIds[1]!, lineIds[2]!];

    // by_value over two equal amounts: 60.0000 each.
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      for (const [target, amount] of [[goodsA, "60.0000"], [goodsB, "60.0000"]] as const) {
        await tx`insert into app.landed_cost_allocation
                   (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
                 values (${a.tenant}, ${a.company}, ${documentId}, ${cost}, ${target}, 'by_value', ${amount})
                 on conflict (cost_line_id, target_line_id) do update
                   set method = excluded.method, allocated_amount = excluded.allocated_amount`;
      }
    });
    const first = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ method: string; amount: string }[]>`
      select method, allocated_amount::text as amount from app.landed_cost_allocation
       where shipment_document_id = ${documentId} order by target_line_id`);
    expect(first).toHaveLength(2);
    expect(first.map((r) => [r.method, r.amount])).toEqual([["by_value", "60.0000"], ["by_value", "60.0000"]].sort());

    // Re-allocate by_quantity, 10 : 5 → 80.0000 : 40.0000. The SAME two rows must change, not four rows exist.
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      for (const [target, amount] of [[goodsA, "80.0000"], [goodsB, "40.0000"]] as const) {
        await tx`insert into app.landed_cost_allocation
                   (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
                 values (${a.tenant}, ${a.company}, ${documentId}, ${cost}, ${target}, 'by_quantity', ${amount})
                 on conflict (cost_line_id, target_line_id) do update
                   set method = excluded.method, allocated_amount = excluded.allocated_amount`;
      }
    });
    const second = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ n: number; total: string }[]>`
      select count(*)::int as n, sum(allocated_amount)::text as total
        from app.landed_cost_allocation where shipment_document_id = ${documentId}`);
    expect(second[0]).toEqual({ n: 2, total: "120.0000" });
    const methods = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ method: string }[]>`
      select distinct method from app.landed_cost_allocation where shipment_document_id = ${documentId}`);
    expect(methods.map((m) => m.method)).toEqual(["by_quantity"]);
  });

  it("admits a zero share, because an absent row would leave a stale one behind", async () => {
    const ty = await shipmentType(a, "LCA_ZERO", "LZ");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LZ", freightAccount);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.landed_cost_allocation
        (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
      values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_weight', 0)`);
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ amount: string }[]>`
      select allocated_amount::text as amount from app.landed_cost_allocation where shipment_document_id = ${documentId}`);
    expect(row!.amount).toBe("0.0000");
  });

  it("refuses a negative share and an unknown method", async () => {
    const ty = await shipmentType(a, "LCA_BAD", "LB");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LB", freightAccount);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.landed_cost_allocation
          (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
        values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', -1)`),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.landed_cost_allocation
          (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
        values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'pro_rata', 10)`),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses an allocation on a document that is no longer a draft (ERR_DOC_NOT_DRAFT)", async () => {
    const ty = await shipmentType(a, "LCA_ISSUED", "LI");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LI", freightAccount);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set status = 'issued' where id = ${documentId}`);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.landed_cost_allocation
          (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
        values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', 10)`),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is issued — landed cost is allocated on a draft/);
  });

  it("refuses a pair whose lines belong to another document (ERR_VALIDATION_FAILED)", async () => {
    const ty = await shipmentType(a, "LCA_CROSS", "LX");
    const freightAccount = await accountIdOf(a, "5900");
    const one = await draftShipment(a, ty, "LX", freightAccount);
    const two = await draftShipment(a, ty, "LX", freightAccount);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.landed_cost_allocation
          (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
        values (${a.tenant}, ${a.company}, ${one.documentId}, ${one.lineIds[2]!}, ${two.lineIds[0]!}, 'by_value', 10)`),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: cost line .* and target line .* must both belong to document/);
  });

  it("deleting the draft shipment cascades its allocations away (no DELETE grant needed)", async () => {
    const ty = await shipmentType(a, "LCA_CASCADE", "LC");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LC", freightAccount);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.landed_cost_allocation
        (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
      values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', 120)`);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`delete from app.document where id = ${documentId}`);
    const [after] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.landed_cost_allocation where shipment_document_id = ${documentId}`);
    expect(after!.n).toBe(0);
  });

  it("tenant B sees none of tenant A's allocations and cannot point one at A's rows (test 12)", async () => {
    const ty = await shipmentType(a, "LCA_ISO", "LO");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LO", freightAccount);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.landed_cost_allocation
        (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
      values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', 120)`);

    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.landed_cost_allocation`);
    expect(seen[0]!.n).toBe(0);

    // NOT 23503. `landed_cost_allocation_draft_only` is a BEFORE INSERT ROW trigger and PostgreSQL runs
    // those before referential integrity (an FK is an AFTER-row RI trigger). Its first statement reads
    // `app.document` for `new.shipment_document_id`; under B's RLS that is A's row and returns nothing, so
    // `v_status` is null and it raises `ERR_NOT_FOUND: document … is not visible` with errcode
    // 'check_violation' (23514) before the composite FK is ever evaluated. The GUARD is the first refusal;
    // the composite FKs are the belt underneath, and no cross-tenant document id can reach them.
    await expect(
      withTenant(db.rw, b.tenant, b.human, (tx) => tx`
        insert into app.landed_cost_allocation
          (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
        values (${b.tenant}, ${b.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', 1)`),
    ).rejects.toThrow(/ERR_NOT_FOUND: document .* is not visible/);
  });

  it("writes an audit row for every allocation insert and update (test 13)", async () => {
    const before = await db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where table_name = 'landed_cost_allocation'`;
    const ty = await shipmentType(a, "LCA_AUDIT", "LA");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LA", freightAccount);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.landed_cost_allocation
                 (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
               values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', 120)`;
      await tx`update app.landed_cost_allocation set allocated_amount = 100 where shipment_document_id = ${documentId}`;
    });
    const after = await db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where table_name = 'landed_cost_allocation'`;
    expect(after[0]!.n).toBe(before[0]!.n + 2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/landed-cost-allocation.test.ts`
Expected: **FAIL** — `relation "app.landed_cost_allocation" does not exist` on the first `pg_class` query.

- [ ] **Step 3: Write `packages/db/migrations/0038_create_landed_cost_allocation.sql`**

```sql
-- 0038_create_landed_cost_allocation.sql
-- Slice 3C. The stored allocation of an import shipment's freight, duty and clearance across its goods lines.
-- spec:1020  — "Imported goods carry freight, duty, clearance and handling that must be allocated across a
--               shipment and into unit cost — otherwise every margin figure is wrong."
-- spec:1049  — the import-shipment document carries freight, duty and clearance into landed cost per lot.
-- SAH-049    — an aggregate with no unique key duplicates under an upsert race and is then double-updated
--               forever. `unique (cost_line_id, target_line_id)` is that key, and it is the ONLY replacement
--               mechanism this table has: app_rw holds no DELETE (contracts §3.5.4 is closed).
-- SAH-017/018 — nothing derived is stored. There is no `weight` column: the basis is `method` plus the target
--               line's own amount / quantity / custom_fields.weight_kg, and the trigger pins both lines to the
--               same document so those columns cannot come from somewhere else.

-- ── 1. app.landed_cost_allocation ─────────────────────────────────────────────
create table app.landed_cost_allocation (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references app.tenant(id),
  company_id            uuid not null,
  shipment_document_id  uuid not null,                                   -- the SHIPMENT / GOODS_RECEIPT draft
  cost_line_id          uuid not null,                                   -- the freight/duty/clearance line (kind = 'account')
  target_line_id        uuid not null,                                   -- the goods line receiving a share (kind = 'item')
  method                text not null
    check (method in ('by_value', 'by_quantity', 'by_weight')),          -- the §2.4 card's three methods, closed
  allocated_amount      numeric(19,4) not null check (allocated_amount >= 0),
                                                                          -- DOCUMENT currency; ZERO IS LEGAL, and the
                                                                          -- handler writes every pair on every call so a
                                                                          -- re-allocation cannot leave a stale share
  created_at            timestamptz not null default now(),
  check (cost_line_id <> target_line_id),                                -- a line never allocates onto itself
  unique (tenant_id, id),
  unique (cost_line_id, target_line_id),                                 -- the upsert key (SAH-049)
  -- Composite FKs: an FK check bypasses RLS, so a plain reference would let tenant A point at tenant B's row.
  foreign key (tenant_id, company_id)           references app.company(tenant_id, id),
  -- Every reference cascades from the DRAFT document: re-lining or deleting the draft releases the allocation,
  -- which is the only release path (contracts §3.5.4; app_rw holds no DELETE here).
  foreign key (tenant_id, shipment_document_id) references app.document(tenant_id, id)      on delete cascade,
  foreign key (tenant_id, cost_line_id)         references app.document_line(tenant_id, id) on delete cascade,
  foreign key (tenant_id, target_line_id)       references app.document_line(tenant_id, id) on delete cascade
);

create index landed_cost_allocation_document_idx on app.landed_cost_allocation (shipment_document_id);
create index landed_cost_allocation_target_idx   on app.landed_cost_allocation (target_line_id);

call app_meta.enable_tenant_rls('app.landed_cost_allocation');
call app_meta.attach_audit('app.landed_cost_allocation');
-- app_rw receives select, insert, update through default privileges (plan0A). No DELETE: §3.5.4 is closed.

-- ── 2. The draft-only and same-document guard (spec:2173 — the data layer is the control) ──
create function app.assert_landed_cost_allocation_draft() returns trigger language plpgsql as $$
declare
  v_status     app.document_status;
  v_cost_doc   uuid;
  v_target_doc uuid;
begin
  -- Draft-only, and this is arithmetic rather than policy: 3B's replay recomputes a receipt's layer as
  -- unit_cost = value / quantity from the IMMUTABLE inventory_movement.value, so after post there is nothing
  -- an allocation could change. A correction is reverseDocument plus a re-post.
  select d.status into v_status from app.document d where d.id = new.shipment_document_id;
  if v_status is null then
    raise exception 'ERR_NOT_FOUND: document % is not visible', new.shipment_document_id
      using errcode = 'check_violation';
  end if;
  if v_status <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: document % is % — landed cost is allocated on a draft, because a posted movement''s value is immutable',
      new.shipment_document_id, v_status
      using errcode = 'check_violation';
  end if;

  -- Same document. The composite FKs prove only the TENANT; without this a company could allocate one
  -- document's freight across another document's goods lines and inflate that document's layers.
  select l.document_id into v_cost_doc   from app.document_line l where l.id = new.cost_line_id;
  select l.document_id into v_target_doc from app.document_line l where l.id = new.target_line_id;
  if v_cost_doc is distinct from new.shipment_document_id
     or v_target_doc is distinct from new.shipment_document_id then
    raise exception 'ERR_VALIDATION_FAILED: cost line % and target line % must both belong to document %',
      new.cost_line_id, new.target_line_id, new.shipment_document_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger landed_cost_allocation_draft_only before insert or update on app.landed_cost_allocation
  for each row execute function app.assert_landed_cost_allocation_draft();
```

- [ ] **Step 4: Write `packages/db/migrations/0038.down.sql`**

```sql
-- Reverse dependency order: trigger, function, indexes, table. `app_meta` and app_meta.schema_migration are
-- never dropped (§3.4.5).
drop trigger if exists landed_cost_allocation_draft_only on app.landed_cost_allocation;
drop function if exists app.assert_landed_cost_allocation_draft() cascade;
drop index if exists app.landed_cost_allocation_target_idx;
drop index if exists app.landed_cost_allocation_document_idx;
drop table if exists app.landed_cost_allocation;
```

- [ ] **Step 5: Write the Drizzle mirror `packages/db/src/schema/landed-cost-allocation.ts`**

```ts
import { index, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * Mirror of app.landed_cost_allocation (migration 0038). Reads only — every write goes through
 * packages/db/src/costing/landed-cost.ts (Task 8), which is inside the one directory contracts §4.3.2 licenses
 * to touch costing state.
 */
export const landedCostAllocation = pgTable(
  "landed_cost_allocation",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    shipmentDocumentId: uuid("shipment_document_id").notNull(),
    costLineId: uuid("cost_line_id").notNull(),
    targetLineId: uuid("target_line_id").notNull(),
    method: text("method").notNull(),
    allocatedAmount: numeric("allocated_amount", { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("landed_cost_allocation_tenant_id_id_key").on(t.tenantId, t.id),
    unique("landed_cost_allocation_cost_line_id_target_line_id_key").on(t.costLineId, t.targetLineId),
    index("landed_cost_allocation_document_idx").on(t.shipmentDocumentId),
  ],
);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/db && bun run test -- test/landed-cost-allocation.test.ts`
Expected: **PASS** (11 tests).

Three failures worth naming in advance. If the upsert case reports `n: 4` rather than `n: 2`, the `unique (cost_line_id, target_line_id)` constraint was written as an *index* instead of a table constraint — `on conflict (cost_line_id, target_line_id)` accepts either, but a plain `create unique index` outside the table body is dropped by `0038.down.sql`'s `drop table` in a different order and the reversibility proof in Step 7 goes red; keep it in the table body. If the same-document case passes when it should fail, the trigger's two `select … into` statements were written against `app.document_line l where l.id = new.cost_line_id` **without** the `document_id` projection and both variables are null, in which case `is distinct from` compares `null` to a uuid and is true — read the error text, which names the lines it actually saw. If the audit case reports `+1` rather than `+2`, `attach_audit` was called with a `mode` argument; the default `'tenant_column'` is what audits both INSERT and UPDATE (§4.1).

- [ ] **Step 7: Run the schema linter and the reversibility proof**

Run: `cd packages/db && bun run db:lint && bun run test -- test/privileges.test.ts`
Expected: `db:lint` prints no violations and exits 0; `privileges.test.ts` passes with the DELETE list still `["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]` (§3.5.4) and the `up → down → up` fingerprint identical (§3.4.6). **`packages/db/src/lint-schema.ts` is not edited** — §3.5.3 pre-declares `landed_cost_allocation` with a dash in every set column, and hazard 13 forbids adding one.

- [ ] **Step 8: Write `docs/adr/0041-landed-cost-allocation-and-purchase-return-valuation.md` as a PROPOSAL**

Status is **Proposed**, not Accepted: spec:95 requires an ADR proposal rather than an implementation for anything that changes money semantics, and both halves of this file do.

```markdown
# ADR 0041 — Landed-cost allocation, and how a purchase return is valued

- **Status:** Proposed — the allocation half is implemented behind it; the return-valuation half needs the
  owner's accountant to confirm (raised with OD-05's Landed cost row, Task 12)
- **Date:** 2026-09-07
- **Slice:** 3C
- **Spec:** spec:95 (an ADR proposal precedes a money-semantics change), spec:1020 (landed cost), spec:1049,
  spec:1698 (purchase return); Part I SAH-007, SAH-009, SAH-049

## Context

An import shipment's freight, duty, clearance and handling belong in unit cost. Two questions follow, and the
second is not obviously answerable from the spec.

1. **How is a cost line split across the goods lines, and where does the split live?**
2. **When those goods go back to the supplier, what value leaves stock — and what does the supplier owe?**

## Decision — the allocation

1. **Three methods, closed:** `by_value` (weights are the goods lines' `amount`), `by_quantity` (weights are
   `quantity`), `by_weight` (weights are `custom_fields.weight_kg`, a §4.2.11 custom field). The method is a
   parameter of the allocation call and is stored on every row it writes, so a shipment carrying two cost lines
   may split one by weight and the other by value — which is what a real customs bill does.
2. **The split is exact, by `Money.allocate` (§4.2.1) and never by a division.** `Σ allocated` equals the cost
   line's `amount` to the cent, with the largest-remainder residue going to the first weight. A division with a
   rounding fudge is how a shipment's freight comes to differ from the sum of its shares.
3. **The split is stored per (cost line × goods line) pair** in `app.landed_cost_allocation`, with
   `unique (cost_line_id, target_line_id)` as the upsert key. Every pair is written on every call, zero shares
   included, so a re-allocation replaces the whole split rather than adding to it.
4. **It reaches the layer exactly once, through the movement's value.** `receiptValue` (§4.7.2, Task 8) is
   `toBase(line.amount + Σ allocated, rate)`; `inventory_movement.value` is immutable and 3B's `replay`
   recomputes `unit_cost = value / quantity` from it. There is therefore no second path by which freight enters
   or leaves a cost, and **allocation is a draft-only operation** — enforced by a trigger, not by convention.
5. **The ledger reaches the same total by addition.** A receipt's ledger legs are all `line.amount` (a cost
   reference cannot post — §4.3.2 step 6 balances before step 9 fills it), so the freight is capitalised by the
   cost line's own debit to `1300`. Σ debits to inventory = goods amount + Σ cost amounts = the layer's value.

## Decision — the purchase return, and the part that is a proposal

A `PURCHASE_RETURN` is an **issue**, so its ledger legs are both `line.cost` (§4.3.4's rule) and its value is
what the costing engine says the goods carry — freight included. Two consequences, and the owner's accountant
should confirm both:

6. **Stock leaves at carrying cost, not at the supplier's price.** `line.cost` is the only expressible choice:
   §4.4.1's `amountRef` enumeration has no member meaning "the difference between two others", and inventing one
   is a schema change (a new `version` const and a new `$id`) rather than a plan's decision. It is also the
   right answer for the report that matters — valuation drops by exactly what `cost_consumption` records, so
   acceptance test 7 ties to the cent.
7. **The counterparty is `party.payable_account`, and the difference is 4A's.** The return debits trade
   payables at carrying cost: at Phase 3 it is a debit note against the supplier, which is what a returns
   document is. The supplier will credit the *goods* price, not our freight, and the difference — freight spent
   on goods that went back — is recognised when 4A's `PURCHASE_CREDIT_NOTE` lands against this document. **We
   deliberately do not debit `2150` GRNI instead**, even though the receipt credited it: the policy cannot know
   whether the invoice has arrived, and one counterparty with a visible difference is better accounting than
   conditional accounting the policy cannot express.

## Consequences

- Re-allocating a shipment by a different method is a single idempotent call; there is no un-allocate endpoint
  and there never will be one, because `app_rw` holds no DELETE on the table (§3.5.4).
- A shipment posted before its landed cost was allocated has layers at the goods price only. That is not
  silently corrected: the remedy is `reverseDocument` and a re-post, and Task 9's DoD test performs exactly that
  sequence so the path is exercised rather than described.
- `by_weight` needs `weight_kg` on every goods line; a line without it is refused by name at allocation time
  rather than silently weighted zero.
- If the accountant rejects point 7, the change is two `account` refs in one seed file (`PURCHASE_RETURN.json`)
  and the two assertions in `purchase-return.test.ts` that name the account — no code, no migration. That is
  recorded here so the reversal cost is known before the question is asked.
```

- [ ] **Step 9: Commit**

```bash
git add packages/db/migrations/0038_create_landed_cost_allocation.sql packages/db/migrations/0038.down.sql \
        packages/db/src/schema/landed-cost-allocation.ts packages/db/test/landed-cost-allocation.test.ts \
        docs/adr/0041-landed-cost-allocation-and-purchase-return-valuation.md
git commit -m "feat(db): add landed_cost_allocation with the upsert key and the draft-only guard [3C T7]

One row per (cost line, target line); unique (cost_line_id, target_line_id) is the only replacement
mechanism because app_rw holds no DELETE (SAH-049, contracts 3.5.4). Draft-only is arithmetic: replay
recomputes a layer from the immutable movement value. ADR 0041 is a proposal (spec:95).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `landed-cost.ts` — the allocation arithmetic and the ONE place a receipt movement's value is decided

**Files:**
- Create: `packages/db/src/costing/landed-cost.ts`
- Modify: `packages/db/src/costing/apply-movements.ts` (the receipt-value site — one expression becomes the four-branch rule)
- Modify: `packages/db/src/posting/reverse.ts` (one column added to the line copy)
- Modify: `packages/db/src/costing/index.ts`, `packages/db/src/index.ts` (exports)
- Create: `packages/db/test/purchasing/landed-cost.test.ts`
- Modify: `packages/db/test/purchasing/goods-receipt.test.ts` (Step 7 appends the four posting cases and the scaffolding they need)
- Test: `packages/db/test/purchasing/landed-cost.test.ts`, `packages/db/test/purchasing/goods-receipt.test.ts`, `packages/db/test/costing/apply-movements.test.ts` and `packages/db/test/costing/replay.test.ts` (3B, re-run unchanged)

**Interfaces:**
- Consumes: `Money`, `Quantity`, `currency`, `toBase`, `CurrencyCode`, `ExchangeRate`, `RoundingMode` (§4.2.1); `LineSnapshot`, `DocumentSnapshot`, `PlannedMovement`, `PostingPlan` (§4.4.2); `app.landed_cost_allocation` (Task 7); `app.document`, `app.document_line`; `TenantContext` (§4.2.2); `Sql` from `postgres`; `openLayersFor`, `applyMovements`, `CostingError`, `costingEngine` (3B, §4.7.2); `PostingError` (1A); `reverseDocument`'s insert (2A, widened by 3A Step 9).
- Produces:

```ts
// packages/db/src/costing/landed-cost.ts
export type LandedCostMethod = "by_value" | "by_quantity" | "by_weight";

/** One goods line as a candidate for a share. `weightKg` is the §4.2.11 custom field `weight_kg`. */
export interface AllocationTarget { lineId: string; amount: Money; quantity: Quantity | null; weightKg: Quantity | null }
/** One computed share. `weight` is the basis, returned for display and NEVER stored (SAH-018). */
export interface AllocationShare { costLineId: string; targetLineId: string; method: LandedCostMethod; amount: Money; weight: bigint }
export interface LandedCostRow { id: string; costLineId: string; targetLineId: string; method: LandedCostMethod; allocatedAmount: string; createdAt: string }
export interface AllocateLandedCostInput { documentId: string; allocations: readonly { costLineId: string; method: LandedCostMethod }[] }

/** `packages/db` may not import `AppError` (§3.1), so this is `CostingError`'s shape exactly (3b amendment A2a):
 *  one class, codes that are literal members of `ErrCode`, reaching the same `asAppError` branch as
 *  `PolicyEvaluationError` and `PostingError` (§4.2.4). */
export class LandedCostError extends Error { constructor(readonly code: "ERR_VALIDATION_FAILED" | "ERR_NOT_FOUND", readonly detail: string) }

/** PURE. Splits one cost line's amount across the goods lines with `Money.allocate` — Σ shares = `costAmount`
 *  exactly, largest-remainder residue to the FIRST weight (§4.2.1). Never a division. */
export function allocateLandedCost(input: { costLineId: string; costAmount: Money; method: LandedCostMethod; targets: readonly AllocationTarget[] }): AllocationShare[];
/** Computes and UPSERTS every (cost line × goods line) pair, zero shares included, and returns the document's
 *  allocation rows. The draft-only and same-document rules are migration 0038's trigger, not this function's. */
export async function allocateLandedCostForDocument(tx: Sql, ctx: TenantContext, input: AllocateLandedCostInput): Promise<LandedCostRow[]>;
export async function listLandedCost(tx: Sql, documentId: string): Promise<LandedCostRow[]>;
/** `document_line.id` → the total allocated onto it, a DOCUMENT-currency decimal string. Empty for a document
 *  with no allocation, which is the ordinary goods-receipt case. */
export async function landedCostByLine(tx: Sql, documentId: string): Promise<Map<string, string>>;
/** Per goods line: the amount, the total allocated onto it and their sum. A READ MODEL — `landedAmount` is
 *  recomputed on every read and stored nowhere (SAH-018). Task 9's two routes return it as `summary`. */
export interface LandedCostSummaryRow {
  targetLineId: string; lineNo: number; itemId: string | null;
  lineAmount: string; allocated: string; landedAmount: string; quantity: string | null;
}
export async function landedCostSummary(tx: Sql, documentId: string): Promise<LandedCostSummaryRow[]>;
/** `toBase(line.amount + landedCost, rate)` — the ONE rule for a purchase-side receipt movement's value. */
export function receiptValue(line: LineSnapshot, landedCost: Money, rate: ExchangeRate): Money;
```

and, exported from `@dulja/db`: all nine names above. **`landedCostSummary` lives here and not in the handler** for the reason Task 4 put `openQuantity` in `packages/db` too: a handler that ran its own `select` over `document_line` and did its own money arithmetic would be a second reader of the same figure, and Global Constraint 4 wants that arithmetic in `Money` rather than in hand-rolled integer maths.

**The four-branch receipt-value rule, and why the order matters.** Task 0 Step 4 registered it in §4.7.2; this is where it exists. `applyMovements` decides a receipt's value at exactly one site, and a receipt whose value comes from somewhere else must not be overwritten:

1. **`snapshot.lines[i].cost !== null` → that cost.** A4 makes it base currency and a magnitude already. This branch is reachable only because Step 5 below adds `l.cost` to `reverseDocument`'s line copy: without it, reversing a stock **issue** — which emits a *receipt* of the returned goods — would fall through to branch 3 and value that receipt at the negated **sale** price instead of the carrying cost. `cost` is a magnitude, so it is copied unnegated, and step 5 of `applyMovements` writes the same number back, which makes the copy idempotent.
2. **else, a same-`lineNo` `issue` movement already computed → that leg's value.** A `transfer` line emits an issue at `warehouse_id` then a receipt at `to_warehouse_id` in that order (§4.7.3), so by the time the receipt is reached the issue is in `computed`. What left the first warehouse is what arrives at the second; a re-priced `line.amount` would create value out of a movement. 3D's `TRANSFER`/`TRANSFER_RECEIPT` depend on this branch.
3. **else → `receiptValue(line, landedCost, rate)`.** The genuine purchase-side receipt: `GOODS_RECEIPT`, `SHIPMENT`, 9B's `OPENING_STOCK`. `line.amount` and not `round(unit_price × quantity, 4)`: §4.3.4 defines `amount` as "excl. tax, document currency", which is the discount-correct figure, and 3A's provisional rule ignored `document_line.discount`.
4. **No line at all → `null`**, and the engine raises `ERR_COST_VALUE_MISSING` naming the movement (SAH-007). The fall-through is left explicit rather than defaulted to zero: a movement with no source line is an internal inconsistency, not a free receipt.

**The weights are `bigint` and the conversion is a string operation.** `Money.allocate` takes `readonly bigint[]`, and `Money.toString()` / `Quantity.toString()` are *fixed*-scale (4 and 6 decimal places), so `"1000.0000" → 10000000n` is exact by removing the point — no `Decimal` arithmetic, no rounding, nothing to get wrong. `by_value` weights at money scale, `by_quantity` and `by_weight` at quantity scale; the scales never mix within one call because the method is one value.

- [ ] **Step 1: Write the failing test `packages/db/test/purchasing/landed-cost.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, Quantity, currency, type ExchangeRate } from "@dulja/domain";
import {
  allocateLandedCost, allocateLandedCostForDocument, landedCostByLine, listLandedCost, receiptValue,
  LandedCostError, postDocument, type AllocationTarget, type LineSnapshot,
} from "../../src/index";
import { documentTypesLoader } from "../../src/seed/index";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import {
  draftTypedDocument, grantCodes, seedItem, seedParty, seedTenantV2, seedWarehouse,
  startDb, withTenant, type Db, type Seed,
} from "../index";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "seed", "my");
const MYR = currency("MYR");
const UNIT: ExchangeRate = { from: MYR, to: MYR, rate: "1.00000000", effectiveFrom: "2026-01-01", source: "unit" };

let db: Db;
let s: Seed;
let partyId: string;
let warehouseId: string;

const ctx = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "3c-lc-test" });
const loaderCtx = (seed: Seed, only: string[]) => ({
  config: {
    tenantId: seed.tenant, only, packRoot: PACK_ROOT, tenantName: "lc",
    ownerEmail: "owner@example.invalid", companyCode: "HQ", companyName: "lc HQ",
    baseCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", fiscalYearStartMonth: 1, fiscalYear: 2026,
  },
  tenantId: seed.tenant, companyId: seed.company, systemPrincipalId: seed.system, packRoot: PACK_ROOT,
});

const target = (lineId: string, amount: string, quantity: string | null, weightKg: string | null): AllocationTarget => ({
  lineId, amount: Money.of(amount, MYR),
  quantity: quantity === null ? null : Quantity.of(quantity),
  weightKg: weightKg === null ? null : Quantity.of(weightKg),
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "lc");
  await grantCodes(db, s, { codes: ["accounting.purchase.create", "inventory.receipt.create", "inventory.receipt.post"] });
  await withTenant(db.migrator, s.tenant, s.system, (tx) => chartOfAccountsLoader.load(tx, loaderCtx(s, ["chart-of-accounts"])));
  await withTenant(db.migrator, s.tenant, s.system, (tx) => documentTypesLoader.load(tx, loaderCtx(s, ["document-types"])));
  partyId = await seedParty(db, s, { kind: "vendor", code: "LC-VEND" });
  warehouseId = await seedWarehouse(db, s, { code: "LC-WH" });
}, 240_000);
afterAll(async () => { await db.stop(); });

async function typeId(code: string): Promise<string> {
  const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = ${code}`);
  return row!.id;
}
async function accountId(code: string): Promise<string> {
  const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = ${code}`);
  return row!.id;
}

describe("allocateLandedCost — pure arithmetic (contracts §4.2.1 Money.allocate; spec:1020)", () => {
  it("by_value splits in proportion to amount and sums exactly", () => {
    const shares = allocateLandedCost({
      costLineId: "c1", costAmount: Money.of("120.0000", MYR), method: "by_value",
      targets: [target("g1", "1000.0000", "10.000000", null), target("g2", "500.0000", "5.000000", null)],
    });
    expect(shares.map((x) => x.amount.toString())).toEqual(["80.0000", "40.0000"]);
    expect(shares.map((x) => x.weight)).toEqual([10000000n, 5000000n]);
  });

  it("by_quantity splits in proportion to quantity, which differs from by_value when prices differ", () => {
    const targets = [target("g1", "1000.0000", "10.000000", null), target("g2", "1000.0000", "5.000000", null)];
    const byValue = allocateLandedCost({ costLineId: "c1", costAmount: Money.of("120.0000", MYR), method: "by_value", targets });
    const byQty = allocateLandedCost({ costLineId: "c1", costAmount: Money.of("120.0000", MYR), method: "by_quantity", targets });
    expect(byValue.map((x) => x.amount.toString())).toEqual(["60.0000", "60.0000"]);
    expect(byQty.map((x) => x.amount.toString())).toEqual(["80.0000", "40.0000"]);
  });

  it("by_weight reads weight_kg and refuses a line that has none, naming the line", () => {
    const ok = allocateLandedCost({
      costLineId: "c1", costAmount: Money.of("100.0000", MYR), method: "by_weight",
      targets: [target("g1", "1000.0000", "10.000000", "30.000000"), target("g2", "1000.0000", "5.000000", "10.000000")],
    });
    expect(ok.map((x) => x.amount.toString())).toEqual(["75.0000", "25.0000"]);
    expect(() =>
      allocateLandedCost({
        costLineId: "c1", costAmount: Money.of("100.0000", MYR), method: "by_weight",
        targets: [target("g1", "1000.0000", "10.000000", "30.000000"), target("g2", "1000.0000", "5.000000", null)],
      }),
    ).toThrow(/ERR_VALIDATION_FAILED: line g2 carries no weight_kg custom field/);
  });

  it("puts the residue on the FIRST weight and still sums to the cent", () => {
    const shares = allocateLandedCost({
      costLineId: "c1", costAmount: Money.of("100.0000", MYR), method: "by_quantity",
      targets: [target("g1", "1.0000", "1.000000", null), target("g2", "1.0000", "1.000000", null), target("g3", "1.0000", "1.000000", null)],
    });
    expect(shares.map((x) => x.amount.toString())).toEqual(["33.3334", "33.3333", "33.3333"]);
    const total = shares.reduce((acc, x) => acc.add(x.amount), Money.zero(MYR));
    expect(total.toString()).toBe("100.0000");
  });

  it("refuses an all-zero basis and an empty target set rather than dividing by nothing", () => {
    expect(() =>
      allocateLandedCost({
        costLineId: "c1", costAmount: Money.of("100.0000", MYR), method: "by_value",
        targets: [target("g1", "0.0000", "10.000000", null)],   // an all-free-of-charge shipment
      }),
    ).toThrow(/ERR_VALIDATION_FAILED: cost line c1: every by_value basis is zero/);
    expect(() =>
      allocateLandedCost({ costLineId: "c1", costAmount: Money.of("100.0000", MYR), method: "by_value", targets: [] }),
    ).toThrow(/ERR_VALIDATION_FAILED: cost line c1 has no goods line to allocate onto/);
    expect(new LandedCostError("ERR_NOT_FOUND", "x").code).toBe("ERR_NOT_FOUND");
  });
});

describe("receiptValue — the one rule (contracts §4.7.2, 3C)", () => {
  const line = (amount: string): LineSnapshot => ({
    id: "l1", lineNo: 1, kind: "item", description: null, accountId: null, itemId: "i1",
    quantity: Quantity.of("10.000000"), unitPrice: Money.of("100.0000", MYR), discount: Money.of("0.0000", MYR),
    amount: Money.of(amount, MYR), taxCodeId: null, taxAmount: Money.zero(MYR), totalInclTax: Money.of(amount, MYR),
    debit: Money.zero(MYR), credit: Money.zero(MYR), cost: null, warehouseId: "w1", toWarehouseId: null,
    lotId: null, unitId: "u1", unitQuantity: Quantity.of("10.000000"), countedQuantity: null,
    expectedQuantity: null, tenderMethod: null, customFields: {}, dimensions: {}, payroll: null,
  });

  it("is amount + allocated, converted once at the header rate", () => {
    expect(receiptValue(line("1000.0000"), Money.of("80.0000", MYR), UNIT).toString()).toBe("1080.0000");
    const usd = currency("USD");
    const rate: ExchangeRate = { from: usd, to: MYR, rate: "4.20000000", effectiveFrom: "2026-01-01", source: "manual:test" };
    const usdLine = { ...line("1000.0000"), amount: Money.of("1000.0000", usd) };
    // 1080 USD × 4.2 = 4536.0000 base, HALF_AWAY_FROM_ZERO at scale 4 (hazard 23).
    expect(receiptValue(usdLine, Money.of("80.0000", usd), rate).toString()).toBe("4536.0000");
  });

  it("is amount and not unit_price × quantity, so a discount is honoured (3A's provisional rule was not)", () => {
    const discounted = { ...line("900.0000"), discount: Money.of("100.0000", MYR) };
    expect(receiptValue(discounted, Money.zero(MYR), UNIT).toString()).toBe("900.0000");
  });
});

describe("GOODS_RECEIPT with a landed cost — end to end (spec:1049)", () => {
  it("allocates on the draft, posts, and the layer carries goods + freight", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const freight = await accountId("5900");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "LC-ITEM-1" });
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId, series: "GRN", partyId, warehouseId,
      lines: [
        { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "10.000000", unitPrice: "100.0000", amount: "1000.0000" },
        { kind: "account", accountId: freight, description: "inland freight", amount: "120.0000" },
      ],
    });

    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), { documentId, allocations: [{ costLineId: lineIds[1]!, method: "by_value" }] }));
    expect(rows.map((r) => [r.targetLineId, r.allocatedAmount])).toEqual([[lineIds[0]!, "120.0000"]]);

    const map = await withTenant(db.rw, s.tenant, s.human, (tx) => landedCostByLine(tx, documentId));
    expect(map.get(lineIds[0]!)).toBe("120.0000");

    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId }));

    const [layer] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { qty_in: string; unit_cost: string }[]
    >`select l.qty_in::text as qty_in, l.unit_cost::text as unit_cost
        from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
       where m.document_id = ${documentId}`);
    // 1000 + 120 = 1120 over 10 units.
    expect(layer).toEqual({ qty_in: "10.000000", unit_cost: "112.0000" });

    const [mv] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ value: string }[]>`
      select value::text as value from app.inventory_movement where document_id = ${documentId}`);
    expect(mv!.value).toBe("1120.0000");

    // The ledger reaches the same 1120 by addition: 1000 to the item's inventory account, 120 to 1300.
    const [totals] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ inventory: string; grni: string; freight: string }[]>`
      select coalesce(sum(e.base_debit) filter (where a.code in ('1300')), 0)::text as inventory,
             coalesce(sum(e.base_credit) filter (where a.code = '2150'), 0)::text as grni,
             coalesce(sum(e.base_credit) filter (where a.code = '5900'), 0)::text as freight
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${documentId}`);
    expect(totals).toEqual({ inventory: "1120.0000", grni: "1000.0000", freight: "120.0000" });
  });

  it("a receipt with no allocation values the layer at the line amount alone", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "LC-ITEM-2" });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId, series: "GRN", partyId, warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "4.000000", unitPrice: "25.0000", amount: "100.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId }));
    const [layer] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ unit_cost: string }[]>`
      select l.unit_cost::text as unit_cost from app.cost_layer l
        join app.inventory_movement m on m.id = l.movement_id where m.document_id = ${documentId}`);
    expect(layer!.unit_cost).toBe("25.0000");
    const empty = await withTenant(db.rw, s.tenant, s.human, (tx) => landedCostByLine(tx, documentId));
    expect(empty.size).toBe(0);
  });

  it("refuses an allocation whose cost line is an item line, or is not on the document", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "LC-ITEM-3" });
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId, series: "GRN", partyId, warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "1.000000", unitPrice: "1.0000", amount: "1.0000" }],
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        allocateLandedCostForDocument(tx, ctx(s), { documentId, allocations: [{ costLineId: lineIds[0]!, method: "by_value" }] })),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: line .* is a item line; a landed-cost line is an account line/);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        allocateLandedCostForDocument(tx, ctx(s), { documentId, allocations: [{ costLineId: documentId, method: "by_value" }] })),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: line .* is not a line of document/);
    expect(await withTenant(db.rw, s.tenant, s.human, (tx) => listLandedCost(tx, documentId))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/purchasing/landed-cost.test.ts`
Expected: **FAIL** — TypeScript reports `has no exported member 'allocateLandedCost'` (and six more) before any test runs.

- [ ] **Step 3: Write `packages/db/src/costing/landed-cost.ts`**

```ts
import { Money, Quantity, currency, toBase, type CurrencyCode, type ExchangeRate, type LineSnapshot } from "@dulja/domain";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";

export type LandedCostMethod = "by_value" | "by_quantity" | "by_weight";

/** One goods line as a candidate for a share. `weightKg` is the §4.2.11 custom field `weight_kg`. */
export interface AllocationTarget {
  lineId: string;
  amount: Money;              // document currency, excl. tax (§4.3.4)
  quantity: Quantity | null;
  weightKg: Quantity | null;
}

/** One computed share. `weight` is the BASIS, returned for display and never stored (SAH-017, SAH-018). */
export interface AllocationShare {
  costLineId: string;
  targetLineId: string;
  method: LandedCostMethod;
  amount: Money;
  weight: bigint;
}

export interface LandedCostRow {
  id: string;
  costLineId: string;
  targetLineId: string;
  method: LandedCostMethod;
  allocatedAmount: string;    // document currency, 4 dp
  createdAt: string;
}

export interface AllocateLandedCostInput {
  documentId: string;
  allocations: readonly { costLineId: string; method: LandedCostMethod }[];
}

/**
 * `packages/db` may not import `AppError` (§3.1), so this takes `CostingError`'s shape exactly (3B amendment
 * A2a): one class, codes that are literal members of `ErrCode`, reaching the same `asAppError` branch as
 * `PolicyEvaluationError` and `PostingError` (§4.2.4). No new `ERR_*` row is needed.
 */
export class LandedCostError extends Error {
  constructor(readonly code: "ERR_VALIDATION_FAILED" | "ERR_NOT_FOUND", readonly detail: string) {
    super(detail);
    this.name = "LandedCostError";
  }
}

/**
 * A FIXED-scale decimal string → the exact bigint of its minor units. `Money.toString()` is always 4 dp and
 * `Quantity.toString()` always 6, so removing the point is exact — no Decimal arithmetic and nothing to round.
 */
function minorUnits(fixed: string): bigint {
  const negative = fixed.startsWith("-");
  const digits = (negative ? fixed.slice(1) : fixed).replace(".", "");
  const magnitude = BigInt(digits);
  return negative ? -magnitude : magnitude;
}

function weightOf(method: LandedCostMethod, t: AllocationTarget): bigint {
  switch (method) {
    case "by_value":
      return minorUnits(t.amount.toString());
    case "by_quantity":
      if (t.quantity === null) {
        throw new LandedCostError("ERR_VALIDATION_FAILED", `line ${t.lineId} carries no quantity; by_quantity cannot weight it`);
      }
      return minorUnits(t.quantity.toString());
    case "by_weight":
      if (t.weightKg === null) {
        throw new LandedCostError(
          "ERR_VALIDATION_FAILED",
          `line ${t.lineId} carries no weight_kg custom field; by_weight cannot weight it`,
        );
      }
      return minorUnits(t.weightKg.toString());
  }
}

/**
 * PURE. Splits one cost line's amount across the goods lines. `Money.allocate` guarantees Σ shares =
 * `costAmount` to the cent with the largest-remainder residue on the FIRST weight (§4.2.1) — the whole reason
 * this is not a division and a fudge, which is how a shipment's freight comes to differ from the sum of its
 * shares (spec:1020: "otherwise every margin figure is wrong").
 */
export function allocateLandedCost(input: {
  costLineId: string;
  costAmount: Money;
  method: LandedCostMethod;
  targets: readonly AllocationTarget[];
}): AllocationShare[] {
  const { costLineId, costAmount, method, targets } = input;
  if (targets.length === 0) {
    throw new LandedCostError("ERR_VALIDATION_FAILED", `cost line ${costLineId} has no goods line to allocate onto`);
  }
  const weights = targets.map((t) => weightOf(method, t));
  if (weights.some((w) => w < 0n)) {
    throw new LandedCostError("ERR_VALIDATION_FAILED", `cost line ${costLineId}: a negative ${method} basis cannot weight an allocation`);
  }
  if (weights.every((w) => w === 0n)) {
    // An all-free-of-charge shipment by value, or an unweighed one by weight. Refused by name rather than
    // divided by zero or silently spread evenly — the operator picks another method or prices the lines.
    throw new LandedCostError(
      "ERR_VALIDATION_FAILED",
      `cost line ${costLineId}: every ${method} basis is zero — choose another method or price the lines`,
    );
  }
  const shares = costAmount.allocate(weights, "HALF_AWAY_FROM_ZERO");
  return targets.map((t, i) => ({ costLineId, targetLineId: t.lineId, method, amount: shares[i]!, weight: weights[i]! }));
}

function weightKgOf(customFields: Record<string, unknown>): Quantity | null {
  const raw = customFields["weight_kg"];
  return typeof raw === "string" ? Quantity.of(raw) : null;
}

/**
 * Computes and UPSERTS every (cost line × goods line) pair, zero shares included, then returns the document's
 * rows. Draft-only and same-document are migration 0038's trigger, not this function's — so a job, a direct
 * `app_rw` statement and this call are bound by the same two rules (spec:2173).
 */
export async function allocateLandedCostForDocument(
  tx: Sql, ctx: TenantContext, input: AllocateLandedCostInput,
): Promise<LandedCostRow[]> {
  const [header] = await tx<{ company_id: string; currency: string }[]>`
    select company_id::text as company_id, currency from app.document where id = ${input.documentId}`;
  if (!header) {
    throw new LandedCostError("ERR_NOT_FOUND", `document ${input.documentId} is not visible`);
  }
  const docCurrency: CurrencyCode = currency(header.currency);

  const lines = await tx<{
    id: string; kind: string; amount: string; quantity: string | null; custom_fields: Record<string, unknown>;
  }[]>`
    select id::text as id, kind, amount::text as amount, quantity::text as quantity, custom_fields
      from app.document_line where document_id = ${input.documentId} order by line_no`;

  const targets: AllocationTarget[] = lines
    .filter((l) => l.kind === "item")
    .map((l) => ({
      lineId: l.id,
      amount: Money.of(l.amount, docCurrency),
      quantity: l.quantity === null ? null : Quantity.of(l.quantity),
      weightKg: weightKgOf(l.custom_fields),
    }));

  const shares: AllocationShare[] = [];
  for (const a of input.allocations) {
    const costLine = lines.find((l) => l.id === a.costLineId);
    if (!costLine) {
      throw new LandedCostError("ERR_VALIDATION_FAILED", `line ${a.costLineId} is not a line of document ${input.documentId}`);
    }
    if (costLine.kind !== "account") {
      throw new LandedCostError(
        "ERR_VALIDATION_FAILED",
        `line ${a.costLineId} is a ${costLine.kind} line; a landed-cost line is an account line carrying the freight, duty or clearance amount`,
      );
    }
    shares.push(
      ...allocateLandedCost({ costLineId: a.costLineId, costAmount: Money.of(costLine.amount, docCurrency), method: a.method, targets }),
    );
  }

  for (const share of shares) {
    // `on conflict` is the ONLY replacement mechanism: app_rw holds no DELETE (§3.5.4) and every pair is
    // written on every call, so re-allocating by another method cannot leave a stale share behind (SAH-049).
    await tx`
      insert into app.landed_cost_allocation
        (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
      values (${ctx.tenantId}, ${header.company_id}, ${input.documentId}, ${share.costLineId},
              ${share.targetLineId}, ${share.method}, ${share.amount.toString()})
      on conflict (cost_line_id, target_line_id) do update
        set method = excluded.method, allocated_amount = excluded.allocated_amount`;
  }
  return listLandedCost(tx, input.documentId);
}

export async function listLandedCost(tx: Sql, documentId: string): Promise<LandedCostRow[]> {
  const rows = await tx<{
    id: string; cost_line_id: string; target_line_id: string; method: string;
    // `created_at` is UNCAST, so postgres.js hands back a `Date`. `created_at::text` would be
    // `2026-01-15 10:00:00+00` — a space, not a `T` — which `TimestampSchema` (§4.2.8) rejects, and
    // `DocumentLinkRow` two tasks earlier reads the same column the same way, on purpose.
    allocated_amount: string; created_at: Date;
  }[]>`
    select id::text as id, cost_line_id::text as cost_line_id, target_line_id::text as target_line_id,
           method, allocated_amount::text as allocated_amount, created_at
      from app.landed_cost_allocation
     where shipment_document_id = ${documentId}
     order by cost_line_id, target_line_id`;
  return rows.map((r) => ({
    id: r.id, costLineId: r.cost_line_id, targetLineId: r.target_line_id,
    method: r.method as LandedCostMethod, allocatedAmount: r.allocated_amount,
    createdAt: r.created_at.toISOString(),
  }));
}

export interface LandedCostSummaryRow {
  targetLineId: string;
  lineNo: number;
  itemId: string | null;
  lineAmount: string;
  allocated: string;
  landedAmount: string;
  quantity: string | null;
}

/**
 * Per goods line: the amount, the total allocated onto it, and their sum. A READ MODEL — `landedAmount` is
 * recomputed here on every read and stored nowhere (SAH-018), and the arithmetic is `Money`, never a
 * hand-rolled integer (Global Constraint 4). Task 9's two routes return it as `summary`.
 */
export async function landedCostSummary(tx: Sql, documentId: string): Promise<LandedCostSummaryRow[]> {
  const [header] = await tx<{ currency: string }[]>`
    select currency from app.document where id = ${documentId}`;
  if (!header) {
    throw new LandedCostError("ERR_NOT_FOUND", `document ${documentId} is not visible`);
  }
  const docCurrency: CurrencyCode = currency(header.currency);
  const allocated = await landedCostByLine(tx, documentId);
  const lines = await tx<{ id: string; line_no: number; item_id: string | null; amount: string; quantity: string | null }[]>`
    select id::text as id, line_no, item_id::text as item_id, amount::text as amount, quantity::text as quantity
      from app.document_line where document_id = ${documentId} and kind = 'item' order by line_no`;
  return lines.map((l) => {
    const share = allocated.get(l.id);
    const shareMoney = share === undefined ? Money.zero(docCurrency) : Money.of(share, docCurrency);
    const lineAmount = Money.of(l.amount, docCurrency);
    return {
      targetLineId: l.id, lineNo: l.line_no, itemId: l.item_id,
      lineAmount: lineAmount.toString(),
      allocated: shareMoney.toString(),
      landedAmount: lineAmount.add(shareMoney).toString(),
      quantity: l.quantity,
    };
  });
}

/**
 * `document_line.id` → the total allocated onto it, a DOCUMENT-currency decimal string. Empty for a document
 * with no allocation, which is the ordinary goods-receipt case; `applyMovements` then values the receipt at
 * `toBase(line.amount, rate)`.
 */
export async function landedCostByLine(tx: Sql, documentId: string): Promise<Map<string, string>> {
  const rows = await tx<{ target_line_id: string; total: string }[]>`
    select target_line_id::text as target_line_id, sum(allocated_amount)::text as total
      from app.landed_cost_allocation
     where shipment_document_id = ${documentId}
     group by target_line_id`;
  return new Map(rows.map((r) => [r.target_line_id, r.total]));
}

/**
 * The ONE rule for a purchase-side receipt movement's value (§4.7.2 branch 3, 3C). `line.amount` and not
 * `round(unit_price × quantity, 4)`: §4.3.4 defines `amount` as excl. tax in document currency, which is the
 * discount-correct figure — 3A's provisional rule ignored `document_line.discount`. One `toBase` at the end,
 * HALF_AWAY_FROM_ZERO at scale 4, which is what `ledger_entry`'s CHECK requires (hazard 23).
 */
export function receiptValue(line: LineSnapshot, landedCost: Money, rate: ExchangeRate): Money {
  return toBase(line.amount.add(landedCost), rate);
}
```

- [ ] **Step 4: Replace the receipt-value expression in `packages/db/src/costing/apply-movements.ts`**

3B's compute loop decides a movement's value in one expression (3b:2988–2990):

```ts
    const value = movement.effect === "issue" ? Money.zero(baseCurrency) : movement.value;
```

Add two lines above the loop, and replace that expression with the four-branch rule. **Nothing else in the file changes**, and 3B's note 3 comment about the issue branch stays verbatim above it.

```ts
  // Above the compute loop, beside `const layerState = new Map<string, Layer[]>();`:
  const docCurrency = snapshot.header.currency;
  const landedCost = await landedCostByLine(tx, documentId);          // empty for every document but a shipment
```

```ts
    // ── The receipt-value rule (§4.7.2, four branches IN THIS ORDER — 3C) ─────────────────────────
    // Note 3 (3B) still holds for the issue branch: an ISSUE is costed from the layers, never from its
    // planned value, and the engine reads that value only to learn which currency to answer in.
    let value: Money | null;
    if (movement.effect === "issue") {
      value = Money.zero(baseCurrency);
    } else {
      const line = snapshot.lines.find((l) => l.lineNo === movement.lineNo) ?? null;
      // Branch 2's leg is already in `computed`: a transfer line emits its issue before its receipt (§4.7.3).
      const sameLineIssue = computed.find((c) => c.movement.lineNo === movement.lineNo && c.movement.effect === "issue");
      if (line?.cost != null) {
        // 1. An already-costed line: a reversal (whose copy carries `cost` — Step 5) or a re-post. A4 makes
        //    it base currency and a magnitude, so it is used as it stands.
        value = line.cost;
      } else if (sameLineIssue) {
        // 2. The transfer case: what left the first warehouse is what arrives at the second. Re-pricing it
        //    from `line.amount` would create value out of a movement. 3D's TRANSFER_RECEIPT depends on this.
        value = sameLineIssue.value;
      } else if (line) {
        // 3. The genuine purchase-side receipt: GOODS_RECEIPT, SHIPMENT, 9B's OPENING_STOCK.
        const allocated = landedCost.get(line.id);
        value = receiptValue(line, allocated === undefined ? Money.zero(docCurrency) : Money.of(allocated, docCurrency), snapshot.header.exchangeRate);
      } else {
        // 4. No source line at all — an internal inconsistency, not a free receipt. Left null on purpose so
        //    the engine raises ERR_COST_VALUE_MISSING naming the movement (SAH-007).
        value = null;
      }
    }
```

Add to the import block: `import { landedCostByLine, receiptValue } from "./landed-cost";`. There is no cycle — `landed-cost.ts` imports nothing from `apply-movements.ts`.

- [ ] **Step 5: Add `cost` to `reverseDocument`'s line copy in `packages/db/src/posting/reverse.ts`**

2A widened this insert to six columns and 3A to four more (3a:4276–4279). `cost` was left out, and the omission is not cosmetic: reversing a stock **issue** emits a *receipt* of the returned goods, which reaches branch 1 only if the copy carries the cost. Without it the reversal falls to branch 3 and values the returned goods at the negated **sale** price.

Column list — add `cost` after `amount`:

```sql
                                   kind, item_id, quantity, unit_price, discount, amount, cost,
                                   warehouse_id, lot_id, unit_id, unit_quantity,
```

Select list — add `l.cost`, **unnegated**:

```sql
           l.kind, l.item_id, -l.quantity, l.unit_price, -l.discount, -l.amount, l.cost,
           l.warehouse_id, l.lot_id, l.unit_id, -l.unit_quantity,
```

`cost` is a **magnitude**, exactly as `PlannedMovement.value` is (3a:54, amendment A9's discipline): direction is carried by `effect`, and the reversal's own `effect` is already flipped by the negated quantity. So it is copied, not negated — and `applyMovements` step 5 writes the same number back over it, which makes the copy idempotent. 3D's `DELIVERY_ORDER` and 4A's `SALES_INVOICE` reversals depend on this column.

- [ ] **Step 6: Export all thirteen names**

`packages/db/src/costing/index.ts` — add `export * from "./landed-cost";`. `packages/db/src/index.ts` already re-exports `./costing`, so verify rather than edit:

```bash
grep -n 'from "./costing"' packages/db/src/index.ts
```

Expected: one line. If it is a named re-export list rather than `export *`, add **all thirteen** names to it — seven values and six types, which is the Produces block above in full:

```ts
export {
  allocateLandedCost, allocateLandedCostForDocument, listLandedCost, landedCostByLine,
  landedCostSummary, receiptValue, LandedCostError,
} from "./landed-cost";
export type {
  LandedCostMethod, AllocationTarget, AllocationShare, LandedCostRow, AllocateLandedCostInput,
  LandedCostSummaryRow,
} from "./landed-cost";
```

**`landedCostSummary` and `LandedCostSummaryRow` are not optional members of that list** — Task 9 Step 8's handler imports `landedCostSummary` from `@dulja/db` and returns its rows as the `summary` half of both responses, so a named re-export that omits it compiles here and breaks Task 9. §4.18's `4.7.2` row (Task 14 Step 5) names the same thirteen.

- [ ] **Step 7: Append the four posting cases — and the database scaffolding they need — to `packages/db/test/purchasing/goods-receipt.test.ts`**

Task 6 landed that file with one case and no database, because until this task's Step 4 **no receipt can post anywhere in the system**: `planMovements` (3A) returns every movement with `value: null` and 3B's `costReceipt` refuses a null (§4.7.2). These four cases are the ones the receipt-value site makes possible, so they land in the commit that makes them pass — Global Constraint 16 wants the root `bun run test` green after every task, and a plan that lands a red case cannot tell a deliberate red from a regression.

Replace that file's five-line header with the full preamble — the imports, the tenant, the two loaders in **chart-of-accounts-before-document-types** order (hazard 33: `2150` must resolve before the policy naming it is validated at post), and the two file-local lookups:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDocumentTypeSeed } from "@dulja/domain";
import { linkFulfilment, openQuantity, postDocument, transitionDocument } from "../../src/index";
import { documentTypesLoader } from "../../src/seed/index";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import {
  draftTypedDocument, grantCodes, seedItem, seedParty, seedTenantV2, seedWarehouse,
  startDb, withTenant, type Db, type Seed,
} from "../index";

const here = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(here, "..", "..", "seed", "my");
const TYPES_DIR = join(PACK_ROOT, "document-types");

let db: Db;
let s: Seed;
let partyId: string;
let warehouseId: string;

const ctx = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "3c-grn-test" });
const loaderCtx = (seed: Seed, only: string[]) => ({
  config: {
    tenantId: seed.tenant, only, packRoot: PACK_ROOT, tenantName: "grn",
    ownerEmail: "owner@example.invalid", companyCode: "HQ", companyName: "grn HQ",
    baseCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", fiscalYearStartMonth: 1, fiscalYear: 2026,
  },
  tenantId: seed.tenant, companyId: seed.company, systemPrincipalId: seed.system, packRoot: PACK_ROOT,
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "grn");
  await grantCodes(db, s, { codes: ["accounting.purchase.create", "inventory.receipt.create", "inventory.receipt.post"] });
  await withTenant(db.migrator, s.tenant, s.system, (tx) => chartOfAccountsLoader.load(tx, loaderCtx(s, ["chart-of-accounts"])));
  await withTenant(db.migrator, s.tenant, s.system, (tx) => documentTypesLoader.load(tx, loaderCtx(s, ["document-types"])));
  partyId = await seedParty(db, s, { kind: "vendor", code: "GRN-VEND" });
  warehouseId = await seedWarehouse(db, s, { code: "GRN-WH" });
}, 240_000);
afterAll(async () => { await db.stop(); });

async function typeId(code: string): Promise<string> {
  const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = ${code}`);
  return row!.id;
}
async function accountId(code: string): Promise<string> {
  const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = ${code}`);
  return row!.id;
}
```

Then append the four cases inside the existing `describe`, after the envelope case:

```ts
  it("posts the GRNI accrual: inventory debited and 2150 credited at line.amount (spec:1049)", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "GRN-ITEM" });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId, series: "GRN", partyId, warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "20.000000", unitPrice: "12.5000", amount: "250.0000" }],
    });
    const result = await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId }));
    expect(result.movementIds).toHaveLength(1);

    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; debit: string; credit: string; base_debit: string; base_credit: string }[]
    >`select a.code, l.debit::text as debit, l.credit::text as credit,
             l.base_debit::text as base_debit, l.base_credit::text as base_credit
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${documentId} order by a.code`);
    expect(rows).toEqual([
      { code: "1300", debit: "250.0000", credit: "0.0000", base_debit: "250.0000", base_credit: "0.0000" },
      { code: "2150", debit: "0.0000", credit: "250.0000", base_debit: "0.0000", base_credit: "250.0000" },
    ]);

    // Stock and the layer agree with the ledger, to the cent.
    const [stock] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { quantity: string }[]
    >`select quantity::text as quantity from app.stock_on_hand where item_id = ${itemId} and warehouse_id = ${warehouseId}`);
    expect(stock!.quantity).toBe("20.000000");
    const [layer] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { qty_in: string; unit_cost: string }[]
    >`select qty_in::text as qty_in, unit_cost::text as unit_cost from app.cost_layer where item_id = ${itemId}`);
    expect(layer).toEqual({ qty_in: "20.000000", unit_cost: "12.5000" });
    expect(await accountId("2150")).toBeTruthy();
  });

  it("a discounted line still balances, because the cost is derived from the same amount", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "GRN-DISCOUNT" });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId, series: "GRN", partyId, warehouseId,
      // 10 × 10.0000 = 100.0000, less a 15.0000 discount → amount 85.0000. cost follows amount, not unit_price × qty.
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "10.000000", unitPrice: "10.0000", discount: "15.0000", amount: "85.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId }));
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; debit: string; credit: string }[]
    >`select a.code, l.debit::text as debit, l.credit::text as credit
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${documentId} order by a.code`);
    expect(rows).toEqual([
      { code: "1300", debit: "85.0000", credit: "0.0000" },
      { code: "2150", debit: "0.0000", credit: "85.0000" },
    ]);
    const [layer] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { unit_cost: string }[]
    >`select unit_cost::text as unit_cost from app.cost_layer where item_id = ${itemId}`);
    expect(layer!.unit_cost).toBe("8.5000");
  });

  it("prices its accrual from the order it receives against (spec:1050)", async () => {
    const orderTypeId = await typeId("PURCHASE_ORDER");
    const receiptTypeId = await typeId("GOODS_RECEIPT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "GRN-FROM-PO" });
    const order = await draftTypedDocument(db, s, {
      documentTypeId: orderTypeId, series: "PO", partyId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "40.000000", unitPrice: "9.0000", amount: "360.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => transitionDocument(tx, ctx(s), { documentId: order.documentId, to: "issued" }));

    // The receipt line carries a quantity and NO price: the link is what prices it.
    const receipt = await draftTypedDocument(db, s, {
      documentTypeId: receiptTypeId, series: "GRN", partyId, warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "25.000000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => linkFulfilment(tx, ctx(s), {
      sourceDocumentId: order.documentId, targetDocumentId: receipt.documentId, linkKind: "receives_against",
      lines: [{ sourceLineId: order.lineIds[0]!, targetLineId: receipt.lineIds[0]!, quantity: "25.000000" }],
    }));
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId: receipt.documentId }));

    const [grni] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { credit: string }[]
    >`select l.credit::text as credit from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${receipt.documentId} and a.code = '2150'`);
    expect(grni!.credit).toBe("225.0000");                    // 25 × 9.0000, the order's price
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) => openQuantity(tx, order.documentId));
    expect(open[0]!.openQuantity).toBe("15.000000");           // the back-order stays open
  });

  it("a free-of-charge line takes stock in at zero cost with no net ledger effect (spec:1055)", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "GRN-FOC" });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId, series: "GRN", partyId, warehouseId,
      lines: [
        { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "100.000000", unitPrice: "2.0000", amount: "200.0000" },
        { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "10.000000", unitPrice: "0.0000", amount: "0.0000" },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId }));

    // Both lines moved stock; only the priced one carried value.
    const movements = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { line_no: number; quantity: string; value: string }[]
    >`select line_no, quantity::text as quantity, value::text as value
        from app.inventory_movement where document_id = ${documentId} order by line_no`);
    expect(movements).toEqual([
      { line_no: 1, quantity: "100.000000", value: "200.0000" },
      { line_no: 2, quantity: "10.000000", value: "0.0000" },
    ]);
    const [layers] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { n: number; zero: number }[]
    >`select count(*)::int as n, count(*) filter (where unit_cost = 0)::int as zero
        from app.cost_layer where item_id = ${itemId}`);
    expect(layers).toEqual({ n: 2, zero: 1 });

    // Asserted as an aggregate, deliberately: whether a zero-value planned line survives to ledger_entry as a
    // 0/0 row is 3B's zero-drop question (see the plan's Spec questions). The NET is what must be exact.
    const [totals] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { debit: string; credit: string }[]
    >`select coalesce(sum(base_debit), 0)::text as debit, coalesce(sum(base_credit), 0)::text as credit
        from app.ledger_entry where document_id = ${documentId}`);
    expect(totals).toEqual({ debit: "200.0000", credit: "200.0000" });
  });```

- [ ] **Step 8: Run this task's test, then Task 6's — which is where the four posting cases first run**

Run: `cd packages/db && bun run test -- test/purchasing/landed-cost.test.ts test/purchasing/goods-receipt.test.ts`
Expected: **PASS** — 10 in `landed-cost.test.ts` and **all 5** in `goods-receipt.test.ts` (the envelope case Task 6 landed plus the four Step 7 appended).

Two failures worth naming in advance, both of them in the appended cases rather than in this task's code. `ERR_POLICY_REQUIRES_MISSING: 2150` means the two loaders ran in the wrong order — `chart-of-accounts` comes **before** `document-types` (hazard 33 in miniature). If the free-of-charge case reports `n: 1` layers, `applyMovements` is skipping a zero-value movement: a value of zero **is** a value (SAH-007 is about *null*), and the layer must exist so a later issue can consume it.

Three failures worth naming in advance. `ERR_COST_VALUE_MISSING` still raised means Step 4's edit landed in the *issue* branch or the `find` matched no line — check that `snapshot.lines` is keyed on `lineNo` and not on array index, because a document whose first line is a `text` line has `lines[0].lineNo === 1` but a movement for line 2 at index 1. `unit_cost: "100.0000"` where the test expects `"112.0000"` means `landedCostByLine` returned an empty map: the allocation was written under a different `shipment_document_id`, or the test posted before allocating. And `ERR_MONEY_CURRENCY_MISMATCH` inside `receiptValue` means `docCurrency` was taken from `snapshot.company.baseCurrency` instead of `snapshot.header.currency` — the allocation is stored in **document** currency and `toBase` is the only conversion.

- [ ] **Step 9: Re-run 3B's costing suites and the reversal suite to prove nothing regressed**

Run: `cd packages/db && bun run test -- test/costing test/posting`
Expected: **PASS**, including 3B's own Task 7 case that expected `value: "1000.0000"` for a receipt — the case that could not pass before this task existed (§4.7.2's "no receipt can post between 3B and 3C"). If a 3B reversal case now reports a *different* cost than before, Step 5 negated `l.cost`; remove the minus sign.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/costing/landed-cost.ts packages/db/src/costing/apply-movements.ts \
        packages/db/src/costing/index.ts packages/db/src/posting/reverse.ts packages/db/src/index.ts \
        packages/db/test/purchasing/landed-cost.test.ts packages/db/test/purchasing/goods-receipt.test.ts
git commit -m "feat(costing): decide a receipt movement's value in one place, with landed cost [3C T8]

receiptValue is toBase(line.amount + allocated, rate); applyMovements chooses between an already-costed
line, a same-line issue leg (transfer), that rule, and an explicit null for a movement with no source
line, in that order. reverseDocument now copies l.cost unnegated, without which reversing an issue values
the returned goods at the sale price. Closes the null 3B left: no receipt could post between 3B and 3C
(contracts 4.7.2), which is why T6's four posting cases are appended and first run here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `SHIPMENT`, the two landed-cost routes, and the definition-of-done proof

**Files:**
- Create: `packages/db/seed/my/document-types/SHIPMENT.json`
- Create: `packages/contracts/src/inventory/landed-cost.ts`
- Create: `apps/api/src/inventory/landed-cost-handlers.ts`
- Modify: `apps/api/src/routes/accounting/documents.ts` (two sub-paths)
- Modify: `packages/contracts/src/index.ts` (one re-export)
- Modify: `packages/db/src/seed/index.ts` (**one line** — `export { chartOfAccountsLoader } from "./chart-of-accounts";`, the re-export 0C's barrel is missing and the route suite's `beforeAll` needs; Step 5)
- Modify: `packages/db/test/purchasing/landed-cost.test.ts` (append the DoD describe block)
- Create: `apps/api/test/routes/accounting/landed-cost.test.ts`
- Test: `packages/db/test/purchasing/landed-cost.test.ts`, `apps/api/test/routes/accounting/landed-cost.test.ts`, `tests/invariants/tenant-isolation.test.ts` (re-run)

**Interfaces:**
- Consumes: `allocateLandedCostForDocument`, `listLandedCost`, `LandedCostError`, `LandedCostMethod`, `LandedCostRow` (Task 8); `2150` (Task 3), `1300` (0C — Task 3 asserts it resolves); `inventory.receipt.create` / `.post` (Task 2); `postDocument` with `jobs` (1A, 3B amendment A5), `reverseDocument` with `jobs` (3B A15), `invalidateFrom`, `replay`, `COST_ADJUSTMENT` (3B); `postInventoryDocument`, `recordingJobs`, `STOCK_ISSUE_COST_POLICY` from `tests/invariants/support/post-inventory` (3B, §4.17.1 — the import is legal in `packages/db/test/**` through 3B's amendment A21(c) allowance); `requireDocumentPermission("submit")` from `apps/api/src/middleware/require-document-permission.ts` (2A) and `requireDocumentModuleRead()` from `apps/api/src/middleware/require-attachment-read.ts` (2C); `IdempotencyHeader` (0B, from **`apps/api/src/routes/index.ts`** — 0B Task 11's home, never `@dulja/contracts`) and `RouteModule` (0B); `AppError`, `fromDatabaseError`, `ERRORS` from `@dulja/contracts` (§4.2.4) and `AppEnv` from `apps/api/src/context.ts` (§4.2.3); `chartOfAccountsLoader` (0C) and `documentTypesLoader` (1A) through the **`@dulja/db/seed`** subpath — Step 5 adds the one-line re-export 0C's barrel is missing; `ListEnvelope`, `UuidSchema`, `QuantitySchema`, `ProblemSchema`, `TimestampSchema` (§4.2.8 — **not** `MoneySchema`; the four money fields take the 4-dp string exception Task 0 Step 5 registers); `startApi`, `grantAdmin`, `problemOf` (0B); `documentRoutes` (1A, at `/v1/companies/:companyId/documents` — both sub-paths below are declared **relative** to it).
- Produces:

```ts
// packages/contracts/src/inventory/landed-cost.ts
export const LandedCostMethodSchema: z.ZodEnum<["by_value", "by_quantity", "by_weight"]>;
export const AllocateLandedCostBody: z.ZodObject<{ allocations: z.ZodArray<z.ZodObject<{ costLineId; method }>> }>;
export const LandedCostAllocationSchema: z.ZodObject<{ id; costLineId; targetLineId; method; allocatedAmount; createdAt }>;
export const LandedCostAllocationList: ReturnType<typeof ListEnvelope<typeof LandedCostAllocationSchema>>;
/** Per goods line: the total allocated onto it and the value the layer will carry. A read model — nothing stores it. */
export const LandedCostSummarySchema: z.ZodObject<{ targetLineId; lineNo; itemId; lineAmount; allocated; landedAmount }>;
```

```ts
// apps/api/src/inventory/landed-cost-handlers.ts
export const allocateLandedCostHandler: RouteHandler<typeof allocateLandedCostRoute, AppEnv>;
export const listLandedCostHandler: RouteHandler<typeof listLandedCostRoute, AppEnv>;
```

- `packages/db/seed/my/document-types/SHIPMENT.json` — the §4.14 row `SHIPMENT` / module `inventory` / series `SHP` / `direction: inbound` / `inventory: receipt` / `approval.post: inventory.receipt.post`.

**`SHIPMENT` is `GOODS_RECEIPT`'s policy with one word changed, and that is the finding rather than the shortcut.** Both are inbound receipts that take stock in and accrue what is owed; the four ledger rules are identical because the accounting *is* identical. What distinguishes an import shipment is that the landed-cost route is called on it — freight, duty, clearance and handling arrive as `account` lines and are allocated across the goods — and that the warehouse files an import permit and a customs form against it rather than a delivery note. So the one difference in the seed file is `requires`: a shipment insists on `party` and `warehouse` like a receipt, and this plan does **not** add a `requires` member for "has at least one cost line", because §4.4.1's `requires` enum is closed and a shipment whose freight invoice has not arrived yet is a legitimate shipment. Task 12 (OD-05) is where the owner is asked whether that is the business's expectation.

**Why the allocate route is gated on the create authority and refuses by policy shape, not by type code.** §4.2.7 forbids a type-specific route, so the handler asks the *policy* whether this document receives stock: `policy.inventory.effect` must be `"receipt"`, and anything else is `ERR_VALIDATION_FAILED` naming the type and the effect it actually has. That admits `GOODS_RECEIPT` (a domestic receipt with an inland-freight line is a real case) and 9B's `OPENING_STOCK`, and refuses a `JOURNAL` or a `PURCHASE_ORDER` with a message that says why. The gate resolves `approval.create ?? approval.post` and not `approval.post`, because allocating is editing a draft — the same authority that put the lines there. The stage passed to the middleware is **`"submit"`**, which resolves that same code off the document named by `:documentId`; `"create"` would look for a document type in the request body and 404 (see the File Structure section, and Task 0 Step 6's §4.5.4 row).

- [ ] **Step 1: Append the failing DoD describe block to `packages/db/test/purchasing/landed-cost.test.ts`**

Add these imports to the existing block, **one line to the existing `beforeAll`**, and the six cases at the end of the file.

```ts
import { replay, reverseDocument } from "../../src/index";
import { ensureOpenPeriods, recordingJobs, STOCK_ISSUE_COST_POLICY } from "../../../../tests/invariants/support/post-inventory";
import { seedDocumentType } from "../index";
```

**The `beforeAll` line, and it is load-bearing rather than tidy.** Plan 0A's `seedTenant` creates exactly three fiscal periods and only 2026-01 is open (plan0A:1588–1591); every date below is June to September, so without this every new case fails on `ERR_PERIOD_NOT_OPEN` and none of them reaches the arithmetic they exist to assert. Add it as the **last** statement of the existing `beforeAll`, after the two loaders:

```ts
  await ensureOpenPeriods(db, s, 2026);          // 3B's helper: months 4–12 open, 0A's three reopened
```

```ts
describe("Phase 3 DoD — a landed-cost allocation changes unit cost and every downstream margin (spec:2289)", () => {
  /** Two goods lines and one freight line on a SHIPMENT draft, ready to allocate. */
  async function shipmentDraft(itemCode: string, freightAmount: string): Promise<{
    documentId: string; lineIds: string[]; itemId: string; baseUnitId: string;
  }> {
    const documentTypeId = await typeId("SHIPMENT");
    const freight = await accountId("5900");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: itemCode });
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId, series: "SHP", partyId, warehouseId, effectiveDate: "2026-06-15",
      lines: [
        { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "100.000000", unitPrice: "10.0000", amount: "1000.0000",
          customFields: { weight_kg: "300.000000" } },
        { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "50.000000", unitPrice: "20.0000", amount: "1000.0000",
          customFields: { weight_kg: "100.000000" } },
        { kind: "account", accountId: freight, description: "ocean freight and duty", amount: freightAmount },
      ],
    });
    return { documentId, lineIds, itemId, baseUnitId };
  }

  it("the SHIPMENT seed file is GOODS_RECEIPT's four rules with the same accounts", () => {
    const shipment = JSON.parse(readFileSync(join(PACK_ROOT, "document-types", "SHIPMENT.json"), "utf8")) as Record<string, unknown>;
    const receipt = JSON.parse(readFileSync(join(PACK_ROOT, "document-types", "GOODS_RECEIPT.json"), "utf8")) as Record<string, unknown>;
    expect(validateDocumentTypeSeed(shipment)).toEqual({ ok: true, errors: [] });
    expect(shipment["module"]).toBe("inventory");
    const sp = shipment["policy"] as Record<string, unknown>;
    const rp = receipt["policy"] as Record<string, unknown>;
    expect(sp["lines"]).toEqual(rp["lines"]);                       // identical accounting, deliberately
    expect(sp["inventory"]).toEqual(rp["inventory"]);
    expect(sp["numbering"]).toEqual({ series: "SHP", assignAt: "issue" });
    expect(sp["approval"]).toEqual(rp["approval"]);
    expect(sp["reversal"]).toEqual({ allowed: true, producesType: "SHIPMENT" });
  });

  it("the allocated share lands in cost_layer.unit_cost, exactly", async () => {
    const { documentId, lineIds } = await shipmentDraft("DOD-ITEM-1", "300.0000");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), { documentId, allocations: [{ costLineId: lineIds[2]!, method: "by_value" }] }));
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }));

    // by_value over 1000 : 1000 → 150 : 150. Line 1: (1000 + 150) / 100 = 11.5000.
    // Line 2: (1000 + 150) / 50 = 23.0000. Without the allocation they would be 10.0000 and 20.0000.
    const layers = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { line_no: number; qty_in: string; unit_cost: string; value: string }[]
    >`select m.line_no, l.qty_in::text as qty_in, l.unit_cost::text as unit_cost, m.value::text as value
        from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
       where m.document_id = ${documentId} order by m.line_no`);
    expect(layers).toEqual([
      { line_no: 1, qty_in: "100.000000", unit_cost: "11.5000", value: "1150.0000" },
      { line_no: 2, qty_in: "50.000000", unit_cost: "23.0000", value: "1150.0000" },
    ]);

    // The ledger's inventory side is the same 2300 the two layers carry, reached by addition.
    const [totals] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ inventory: string; grni: string }[]>`
      select coalesce(sum(e.base_debit) filter (where a.code = '1300'), 0)::text as inventory,
             coalesce(sum(e.base_credit) filter (where a.code = '2150'), 0)::text as grni
        from app.ledger_entry e join app.account a on a.id = e.account_id where e.document_id = ${documentId}`);
    expect(totals).toEqual({ inventory: "2300.0000", grni: "2000.0000" });
  });

  it("and therefore in every downstream margin: the issue's cost_consumption and document_line.cost move with it", async () => {
    const { documentId, lineIds, itemId, baseUnitId } = await shipmentDraft("DOD-ITEM-2", "300.0000");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), { documentId, allocations: [{ costLineId: lineIds[2]!, method: "by_value" }] }));
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }));

    // There is no sale document before 3D, so the issue is 3A's registered test-only type with 3B's
    // cost policy (amendment A14): DR item.cogs_account, CR item.inventory_account, both at line.cost.
    const issueType = await seedDocumentType(db, s, { code: "STOCK_ISSUE_TEST", module: "inventory", policy: STOCK_ISSUE_COST_POLICY });
    const issue = await draftTypedDocument(db, s, {
      documentTypeId: issueType, series: "SIT", warehouseId, effectiveDate: "2026-07-01",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "15.000000", unitPrice: "40.0000", amount: "600.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId: issue.documentId, jobs: recordingJobs() }));

    // AVCO over the two layers: (1150 + 1150) / 150 = 15.333333… per unit. FIFTEEN units is deliberate:
    // 2300 × 15/150 = 230.0000 EXACTLY, so the assertion that carries the DoD is not also a bet on which
    // decimal place the engine rounds at. Without the freight it would be 2000 × 15/150 = 200.0000, so the
    // allocation moved this issue's cost by exactly 30.0000 — the 300.0000 freight's 15/150 share.
    const consumptions = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { quantity: string; unit_cost: string; value: string }[]
    >`select k.quantity::text as quantity, k.unit_cost::text as unit_cost, k.value::text as value
        from app.cost_consumption k join app.inventory_movement m on m.id = k.movement_id
       where m.document_id = ${issue.documentId} order by k.unit_cost`);
    const consumed = consumptions.reduce((acc, r) => acc.add(Money.of(r.value, MYR)), Money.zero(MYR));
    expect(consumed.toString()).toBe("230.0000");

    const [line] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ cost: string }[]>`
      select cost::text as cost from app.document_line where document_id = ${issue.documentId}`);
    expect(line!.cost).toBe("230.0000");

    // The margin: revenue is not posted before 4A, so at Phase 3 "margin" is the cost side (hazard 4).
    // Sale value 600.0000 − cost 230.0000 = 370.0000, and it is exactly 30.0000 lower than the 400.0000 the
    // same sale would have shown had the freight never reached the layer. That difference IS the DoD clause.
    const [cogs] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ total: string }[]>`
      select coalesce(sum(e.base_debit), 0)::text as total from app.ledger_entry e
        join app.account a on a.id = e.account_id
       where e.document_id = ${issue.documentId} and a.code = '5000'`);
    expect(cogs!.total).toBe("230.0000");
  });

  it("the same shipment re-allocated by_quantity gives a different split that still sums exactly", async () => {
    const { documentId, lineIds } = await shipmentDraft("DOD-ITEM-3", "300.0000");
    const byValue = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), { documentId, allocations: [{ costLineId: lineIds[2]!, method: "by_value" }] }));
    expect(byValue.map((r) => r.allocatedAmount)).toEqual(["150.0000", "150.0000"]);

    // 100 : 50 by quantity → 200 : 100. Two rows change; there are never four.
    const byQuantity = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), { documentId, allocations: [{ costLineId: lineIds[2]!, method: "by_quantity" }] }));
    expect(byQuantity).toHaveLength(2);
    expect(byQuantity.map((r) => r.allocatedAmount)).toEqual(["200.0000", "100.0000"]);
    expect(byQuantity.every((r) => r.method === "by_quantity")).toBe(true);

    // 300 : 100 by weight → 225 : 75, and the residue rule keeps every total exact.
    const byWeight = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), { documentId, allocations: [{ costLineId: lineIds[2]!, method: "by_weight" }] }));
    expect(byWeight.map((r) => r.allocatedAmount)).toEqual(["225.0000", "75.0000"]);
    for (const rows of [byValue, byQuantity, byWeight]) {
      const total = rows.reduce((acc, r) => acc.add(Money.of(r.allocatedAmount, MYR)), Money.zero(MYR));
      expect(total.toString()).toBe("300.0000");
    }
  });

  it("a BACK-DATED shipment recosts only forward and posts a visible COST_ADJUSTMENT (test 5 re-run)", async () => {
    const documentTypeId = await typeId("SHIPMENT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "DOD-ITEM-4" });
    const freight = await accountId("5900");

    // A later receipt first, so the back-dated one has a tail to invalidate.
    const later = await draftTypedDocument(db, s, {
      documentTypeId, series: "SHP", partyId, warehouseId, effectiveDate: "2026-09-01",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "10.000000", unitPrice: "10.0000", amount: "100.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId: later.documentId, jobs: recordingJobs() }));

    // …and a CONSUMPTION in that tail, without which the replay has nothing to adjust. A back-dated receipt
    // on its own only rewrites layer unit costs, and no COGS total changes — so `adjustmentsPosted` would be
    // empty and test 5's "adjustment is visible and explained" clause would have nothing to point at.
    const issueType = await seedDocumentType(db, s, { code: "STOCK_ISSUE_TEST", module: "inventory", policy: STOCK_ISSUE_COST_POLICY });
    const sold = await draftTypedDocument(db, s, {
      documentTypeId: issueType, series: "SIT", warehouseId, effectiveDate: "2026-09-15",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "5.000000", unitPrice: "30.0000", amount: "150.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId: sold.documentId, jobs: recordingJobs() }));
    // Costed at 10.0000 a unit today: the only layer it can see is September's.
    const [before] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ cost: string }[]>`
      select cost::text as cost from app.document_line where document_id = ${sold.documentId}`);
    expect(before!.cost).toBe("50.0000");

    const back = await draftTypedDocument(db, s, {
      documentTypeId, series: "SHP", partyId, warehouseId, effectiveDate: "2026-08-01",
      lines: [
        { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "10.000000", unitPrice: "10.0000", amount: "100.0000" },
        { kind: "account", accountId: freight, description: "airfreight", amount: "50.0000" },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), { documentId: back.documentId, allocations: [{ costLineId: back.lineIds[1]!, method: "by_value" }] }));

    const jobs = recordingJobs();
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId: back.documentId, jobs }));
    // Step 14 fired because an already-posted movement of this item carries a LATER effective_date.
    expect(jobs.enqueued.map((j) => j.name)).toContain("inventory.cost.replay");

    // Copy the JobEnvelope literal from 3B's own `replay.test.ts` rather than retyping it — §4.2.6 owns the
    // shape and 3B's suite is the one place it is already written correctly.
    const outcome = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      replay(tx, { id: "job-dod-4", name: "inventory.cost.replay", data: { companyId: s.company }, tenantId: s.tenant }, ctx(s)));
    expect(outcome.movementsReplayed).toBeGreaterThan(0);
    expect(outcome.adjustmentsPosted.length).toBeGreaterThan(0);

    // The September issue is now costed over BOTH layers at the running average: (150 + 100) / 20 = 12.5000
    // a unit, so 5 units cost 62.5000 rather than the 50.0000 they cost before the shipment arrived. The
    // 12.5000 difference is what the COST_ADJUSTMENT posts, and it is the whole content of "recosts forward".
    const [after] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ cost: string }[]>`
      select cost::text as cost from app.document_line where document_id = ${sold.documentId}`);
    expect(after!.cost).toBe("62.5000");

    // Each layer keeps its OWN unit cost — AVCO consumes proportionally, it does not rewrite a layer's rate.
    const layers = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { effective_at: string; unit_cost: string; qty_remaining: string }[]
    >`select l.effective_at::text as effective_at, l.unit_cost::text as unit_cost, l.qty_remaining::text as qty_remaining
        from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
       where m.item_id = ${itemId} and l.invalidated_at is null order by l.effective_at`);
    expect(layers).toEqual([
      { effective_at: "2026-08-01", unit_cost: "15.0000", qty_remaining: "7.500000" },
      { effective_at: "2026-09-01", unit_cost: "10.0000", qty_remaining: "7.500000" },
    ]);

    const adjustments = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ code: string; status: string }[]>`
      select t.code, d.status::text as status from app.document d
        join app.document_type t on t.id = d.document_type_id
       where d.id = any(${outcome.adjustmentsPosted}::uuid[])`);
    expect(adjustments.every((a) => a.code === "COST_ADJUSTMENT" && a.status === "posted")).toBe(true);
  });

  it("landed cost cannot be re-allocated after post; the remedy is a reversal and a re-post", async () => {
    const { documentId, lineIds } = await shipmentDraft("DOD-ITEM-5", "300.0000");
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }));
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        allocateLandedCostForDocument(tx, ctx(s), { documentId, allocations: [{ costLineId: lineIds[2]!, method: "by_value" }] })),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is posted — landed cost is allocated on a draft/);

    // The remedy, exercised rather than described (ADR 0041).
    const { reversalDocumentId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctx(s), { documentId, effectiveDate: "2026-06-16", reason: "freight invoice arrived late", jobs: recordingJobs() }));
    expect(reversalDocumentId).toBeTruthy();
    const [onHand] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ quantity: string }[]>`
      select coalesce(sum(quantity), 0)::text as quantity from app.stock_on_hand h
        join app.item i on i.id = h.item_id where i.code = 'DOD-ITEM-5'`);
    expect(onHand!.quantity).toBe("0.000000");
  });
});
```

Add `validateDocumentTypeSeed` (from `@dulja/domain`), `readFileSync` and `join` to the file's imports if the Task 8 version did not already need them.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/purchasing/landed-cost.test.ts`
Expected: **FAIL** — the six new cases fail, the first with `ENOENT … document-types/SHIPMENT.json` and the rest with `Cannot read properties of undefined (reading 'id')` from `typeId("SHIPMENT")`. Task 8's ten cases stay green.

- [ ] **Step 3: Write `packages/db/seed/my/document-types/SHIPMENT.json`**

Identical to `GOODS_RECEIPT.json` in every member but `code`, the two names, `numbering.series` and `reversal.producesType`. The four `lines` rules are copied **verbatim**, and the test above asserts that byte for byte, so a future edit to one policy that forgets the other fails immediately.

```json
{
  "code": "SHIPMENT",
  "nameEn": "Import Shipment",
  "nameAr": "إرسالية استيراد",
  "module": "inventory",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "SHIPMENT",
    "direction": "inbound",
    "requires": ["party", "warehouse"],
    "lines": [
      {
        "for": "each_line",
        "side": "debit",
        "account": { "from": "item.inventory_account" },
        "amount": "line.amount",
        "when": { "line.kind": "item" }
      },
      {
        "for": "each_line",
        "side": "credit",
        "account": { "code": "2150" },
        "amount": "line.amount",
        "when": { "line.kind": "item" }
      },
      {
        "for": "each_line",
        "side": "debit",
        "account": { "code": "1300" },
        "amount": "line.amount",
        "when": { "line.kind": "account" }
      },
      {
        "for": "each_line",
        "side": "credit",
        "account": { "from": "line.account" },
        "amount": "line.amount",
        "when": { "line.kind": "account" }
      }
    ],
    "inventory": { "effect": "receipt", "warehouse": "line.warehouse", "costing": "create_layer" },
    "tax": { "applies": false },
    "numbering": { "series": "SHP", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "SHIPMENT" },
    "approval": {
      "required": false,
      "approve": null,
      "post": "inventory.receipt.post",
      "create": "inventory.receipt.create"
    },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

**Import duty is an `account` line, not a member of this policy.** A customs bill's duty, port charges and clearance agent's fee are three separate `account` lines with three different credit accounts, and each is allocated with the method that suits it — duty by value, port charges by weight. Naming any of them in the policy would fix a chart of accounts this design deliberately leaves to the tenant (spec:1240's "text-defined, diffable" principle applied to accounts rather than templates), and `{ "from": "line.account" }` already resolves whatever the operator chose.

- [ ] **Step 4: Run the DoD suite to verify it passes**

Run: `cd packages/db && bun run test -- test/purchasing/landed-cost.test.ts`
Expected: **PASS** (16 tests — Task 8's ten plus these six). **This is the commit where this slice's clause of the Phase 3 definition of done is green.**

Four failures worth naming in advance. `unit_cost: "11.5000"` expected and `"10.0000"` reported means the allocation was written *after* the post — the draft-only trigger would have refused an allocation on a posted document, so the test's own ordering is wrong, not the code's. A consumed total of `133.3333` rather than `153.3333` means `company.costing_method` is `fifo` rather than the `avco` default (OD-06, 3B's) — the arithmetic differs and the expectation belongs to `avco`; assert the method in `beforeAll` rather than adjusting the number. `ERR_INTERNAL: … posted through a caller that supplied no JobClient` on the back-dated case means `jobs: recordingJobs()` was omitted from that one `postDocument` call — 3B's amendment A5 fail-closes rather than silently skipping a recost. And if the September layer reports `15.0000`, `invalidateFrom`'s row-wise comparison is invalidating *forward* of the wrong point; that is a 3B defect and the finding belongs there.

- [ ] **Step 5: Write the failing route test `apps/api/test/routes/accounting/landed-cost.test.ts`**

**`StartedApi` is exactly the eight members §4.2.12 lists** — `db`, `objectStore`, `app`, `tokenFor`, `signToken`, `loadPrincipals`, `request(input: ApiRequest)`, `stop()` — and `request` takes **one object**, not `(method, path, opts)`. There is no `typeId`, no `accountId`, no `loadSeedPack` and no `requestAs`. So every lookup below is a **file-local** helper over `api.db`, which is the pattern 1A's and 2B's route suites already use, and `as` on the request object is how a call is attributed to a principal.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  draftTypedDocument, seedItem, seedParty, seedTenantV2, seedWarehouse, withTenant, type Seed,
} from "@dulja/db/test";
// BOTH loaders through the `@dulja/db/seed` subpath (0C Task 12's export, `./src/seed/index.ts`). A route
// suite lives in `apps/api` and CANNOT reach into another package by relative path the way this slice's
// `packages/db` suites do (`../../src/seed/chart-of-accounts`), so the barrel is the only route — and 0C's
// barrel re-exports `SeedError`, `SUB_PACKS`, `SeedConfig`, `ConfigError`, `parseSeedArgs`, `assertPackShape`,
// `PHASE_0_SUB_PACK_DIRECTORIES`, `readPackFile` and the auth-admin names, **not** `chartOfAccountsLoader`,
// which it only imports to populate the private `LOADERS` map (0c:2492ff, 0c:3813). 1A hit the same gap and
// closed it the same way for `documentTypesLoader` (1a:5356). The last paragraph of this step adds the line.
import { chartOfAccountsLoader, documentTypesLoader } from "@dulja/db/seed";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// FIVE levels up: this file is `apps/api/test/routes/accounting/`, which is 2A's route-suite depth (2a:3253).
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let shipmentTypeId: string;
let orderTypeId: string;
let itemId: string;
let baseUnitId: string;
let warehouseId: string;
let partyId: string;
let freightAccountId: string;

// ABSOLUTE, built from this file's own location — five directories to the repository root, then down into
// the pack. §4.2.13's `LoaderContext.packRoot` is a path the loader `join`s against and promises nothing
// about a working directory, and Vitest runs this suite from `apps/api`, so the bare relative
// `"packages/db/seed/my"` would resolve under `apps/api/` and every loader call would raise ENOENT inside
// `beforeAll`, before any case ran. Every `packages/db` suite in this plan builds it the same way (Task 8).
const PACK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "packages", "db", "seed", "my");
const loaderCtx = (only: string[]) => ({
  config: {
    tenantId: s.tenant, only, packRoot: PACK_ROOT, tenantName: "lc-api",
    ownerEmail: "owner@example.invalid", companyCode: "HQ", companyName: "lc-api HQ",
    baseCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", fiscalYearStartMonth: 1, fiscalYear: 2026,
  },
  tenantId: s.tenant, companyId: s.company, systemPrincipalId: s.system, packRoot: PACK_ROOT,
});

/** File-local, per §4.17: §4.2.12 gives `StartedApi` no lookup members and hazard 9 forbids adding one. */
async function typeId(code: string): Promise<string> {
  const [row] = await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = ${code}`);
  return row!.id;
}
async function accountId(code: string): Promise<string> {
  const [row] = await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = ${code}`);
  return row!.id;
}

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "lc-api");
  await grantAdmin(api, s);
  // The seed pack, applied through 0C's loader seam (§4.2.13) — chart of accounts BEFORE document types, so
  // `2150` and `1300` resolve when the policies that name them are validated (hazard 33).
  await withTenant(api.db.migrator, s.tenant, s.system, (tx) => chartOfAccountsLoader.load(tx, loaderCtx(["chart-of-accounts"])));
  await withTenant(api.db.migrator, s.tenant, s.system, (tx) => documentTypesLoader.load(tx, loaderCtx(["document-types"])));
  ({ itemId, baseUnitId } = await seedItem(api.db, s, { code: "LCAPI-ITEM" }));
  warehouseId = await seedWarehouse(api.db, s, { code: "LCAPI-WH" });
  partyId = await seedParty(api.db, s, { kind: "vendor", code: "LCAPI-VEND" });
  shipmentTypeId = await typeId("SHIPMENT");
  orderTypeId = await typeId("PURCHASE_ORDER");
  freightAccountId = await accountId("5900");
  await api.loadPrincipals();
}, 300_000);
afterAll(async () => { await api.stop(); });

async function draft(documentTypeId: string, series: string, withFreight: boolean) {
  return draftTypedDocument(api.db, s, {
    documentTypeId, series, partyId, warehouseId,
    lines: [
      { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "10.000000", unitPrice: "100.0000", amount: "1000.0000",
        customFields: { weight_kg: "25.000000" } },
      ...(withFreight ? [{ kind: "account" as const, accountId: freightAccountId, description: "freight", amount: "120.0000" }] : []),
    ],
  });
}

describe("POST/GET /v1/companies/{companyId}/documents/{documentId}/landed-cost (3C)", () => {
  it("allocates by_value and returns the rows and the per-line summary", async () => {
    const { documentId, lineIds } = await draft(shipmentTypeId, "SHP", true);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`, as: s.human,
      idempotencyKey: "lc-1", body: { allocations: [{ costLineId: lineIds[1]!, method: "by_value" }] },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      items: { targetLineId: string; method: string; allocatedAmount: string }[];
      summary: { targetLineId: string; lineAmount: string; allocated: string; landedAmount: string }[];
    };
    expect(body.items.map((i) => [i.targetLineId, i.method, i.allocatedAmount])).toEqual([[lineIds[0]!, "by_value", "120.0000"]]);
    expect(body.summary.map((r) => [r.targetLineId, r.lineAmount, r.allocated, r.landedAmount]))
      .toEqual([[lineIds[0]!, "1000.0000", "120.0000", "1120.0000"]]);

    const get = await api.request({ method: "GET", path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`, as: s.human });
    expect(get.status).toBe(200);
    const listed = await get.json() as { items: { allocatedAmount: string }[] };
    expect(listed.items.map((i) => i.allocatedAmount)).toEqual(["120.0000"]);
  });

  it("replays the same idempotency key without allocating twice", async () => {
    const { documentId, lineIds } = await draft(shipmentTypeId, "SHP", true);
    const call = () => api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`, as: s.human,
      idempotencyKey: "lc-2", body: { allocations: [{ costLineId: lineIds[1]!, method: "by_weight" }] },
    });
    const first = await call();
    const second = await call();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
  });

  it("refuses a document whose policy does not receive stock, naming the type and the effect", async () => {
    const { documentId, lineIds } = await draft(orderTypeId, "PO", true);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`, as: s.human,
      idempotencyKey: "lc-3", body: { allocations: [{ costLineId: lineIds[1]!, method: "by_value" }] },
    });
    // 400, not 422: §4.2.4 fixes `ERR_VALIDATION_FAILED` at status 400 and `AppError` takes its status from
    // `ERRORS[code].status`, so the handler's own `new AppError("ERR_VALIDATION_FAILED", …)` reaches the wire
    // as 400. 422 belongs to the codes §4.2.4 allocates there — `ERR_DOC_LINK_OVER_FULFILLED` in Task 4's
    // suite is one; none of them is raised on this path.
    expect(res.status).toBe(400);
    expect(await problemOf(res)).toMatchObject({
      code: "ERR_VALIDATION_FAILED",
      detail: expect.stringContaining("PURCHASE_ORDER has inventory.effect 'none'"),
    });
  });

  it("refuses an unknown method at the schema, before any query runs", async () => {
    const { documentId, lineIds } = await draft(shipmentTypeId, "SHP", true);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`, as: s.human,
      idempotencyKey: "lc-4", body: { allocations: [{ costLineId: lineIds[1]!, method: "pro_rata" }] },
    });
    // 400: a Zod enum failure is `ERR_VALIDATION_FAILED`, which §4.2.4 fixes at 400.
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("refuses a by_weight allocation over a line with no weight_kg, naming the line", async () => {
    const noWeight = await draftTypedDocument(api.db, s, {
      documentTypeId: shipmentTypeId, series: "SHP", partyId, warehouseId,
      lines: [
        { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "1.000000", unitPrice: "1.0000", amount: "1.0000" },
        { kind: "account", accountId: freightAccountId, description: "freight", amount: "10.0000" },
      ],
    });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${noWeight.documentId}/landed-cost`, as: s.human,
      idempotencyKey: "lc-5", body: { allocations: [{ costLineId: noWeight.lineIds[1]!, method: "by_weight" }] },
    });
    // 400: `LandedCostError("ERR_VALIDATION_FAILED", …)` is translated to `AppError` with the same code, and
    // §4.2.4 gives that code status 400.
    expect(res.status).toBe(400);
    expect((await problemOf(res)).detail).toContain("carries no weight_kg custom field");
  });

  it("refuses an allocation on a document that is no longer a draft, as 409 and not 500", async () => {
    const { documentId, lineIds } = await draft(shipmentTypeId, "SHP", true);
    // Straight to `issued` through `app_rw`, which is how Tasks 1 and 7 reach a non-draft status without
    // routing a transition — the point of this case is the DATABASE guard, not the lifecycle.
    await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx`
      update app.document set status = 'issued' where id = ${documentId}`);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`, as: s.human,
      idempotencyKey: "lc-7", body: { allocations: [{ costLineId: lineIds[1]!, method: "by_value" }] },
    });
    // The refusal is migration 0038's `landed_cost_allocation_draft_only` trigger, raising
    // `ERR_DOC_NOT_DRAFT: document … is issued — landed cost is allocated on a draft, …` as a
    // check_violation. It is NOT a `LandedCostError`, so it reaches the wire only through the handler's
    // `asAppError`; without that translation this case reports 500 `ERR_INTERNAL`, which is exactly the
    // hole this case exists to hold closed. 409 is §4.2.4's status for `ERR_DOC_NOT_DRAFT` (2B's row).
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_DOC_NOT_DRAFT");
  });

  it("refuses a principal with no codes at all (ERR_RBAC_FORBIDDEN)", async () => {
    const { documentId, lineIds } = await draft(shipmentTypeId, "SHP", true);
    // `s.human` holds every code through grantAdmin; `s.system` holds none of the document gates, which is
    // the "authenticated but unauthorised" shape without inventing a principal.
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`, as: s.system,
      idempotencyKey: "lc-6", body: { allocations: [{ costLineId: lineIds[1]!, method: "by_value" }] },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("returns ERR_NOT_FOUND for another tenant's document (test 12)", async () => {
    const other = await seedTenantV2(api.db, "lc-api-other");
    await grantAdmin(api, other);
    await api.loadPrincipals();
    const { documentId } = await draft(shipmentTypeId, "SHP", true);
    // Tenant B's principal, tenant B's company path, tenant A's document id: RLS makes it invisible, so the
    // answer is 404 and never an empty 200 — an empty list would tell B that the id exists somewhere.
    const res = await api.request({
      method: "GET", path: `/v1/companies/${other.company}/documents/${documentId}/landed-cost`, as: other.human,
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });
});
```

**Still in this step: add the one line 0C's seed barrel is missing, or the file above cannot resolve.** `packages/db/src/seed/index.ts` re-exports `SeedError`, `SUB_PACKS`, `SubPack`, `SeedConfig`, `ConfigError`, `parseSeedArgs`, `assertPackShape`, `PHASE_0_SUB_PACK_DIRECTORIES`, `readPackFile`, `seed` and the auth-admin names (0c:2492ff, 0c:3508ff), plus 1A's `documentTypesLoader` / `loadDocumentTypes` / `DocumentTypeSeedResult` (1a:5356). **`chartOfAccountsLoader` is not among them** — 0C only *imports* it into the private `LOADERS` map (0c:3813) — so `import { chartOfAccountsLoader } from "@dulja/db/seed"` fails to resolve, `beforeAll` throws, and every case in this file errors before it runs. This slice's `packages/db` suites do not hit it because they import `../../src/seed/chart-of-accounts` directly; a suite in `apps/api` has no such path. Append, beside 1A's line:

```ts
export { chartOfAccountsLoader } from "./chart-of-accounts";
```

**And only that.** It is a re-export of a name 0C already owns and already exports from its own module — no new interface, no §4.2.13 amendment (§4.2.13 already names `chartOfAccountsLoader` as 0C's and every later slice consumes it unchanged), and **not** `packages/db/src/index.ts`: §3.1 and 0C's `tests/regression/sah-039.test.ts` forbid the main barrel carrying `export … from "./seed"` at any depth, because `packages/db/src/seed/auth-admin.ts` imports `@supabase/supabase-js`. Adding it to the seed barrel touches nothing on that import graph.

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && bun run test -- test/routes/accounting/landed-cost.test.ts`
Expected: **FAIL** — every case returns `404` with `ERR_NOT_FOUND`, because the sub-path is not mounted. If instead the whole file errors in `beforeAll` with `The requested module '@dulja/db/seed' does not provide an export named 'chartOfAccountsLoader'`, the re-export at the end of Step 5 was skipped.

- [ ] **Step 7: Write `packages/contracts/src/inventory/landed-cost.ts`**

```ts
// `@hono/zod-openapi`, not `"zod"`: `.openapi(...)` exists only on that package's re-export, and every
// schema below calls it. `packages/contracts/src/accounting/document-link.ts` (Task 4) imports it from the
// same place, and two spellings of `z` in one package is hazard 9's shape.
import { z } from "@hono/zod-openapi";
import { ListEnvelope, QuantitySchema, TimestampSchema, UuidSchema } from "../common";

/** Money on the wire in this module is a 4-dp decimal string with NO currency member, under the §4.2.8
 *  exception Task 0 Step 5 registers: every row below is returned under a path that already names the
 *  document whose currency it is, and `app.document_link`'s sibling has no currency column at all. The
 *  arithmetic behind each figure is still `Money` (`landedCostSummary`, Global Constraint 4). */
const MoneyAmount = z.string().regex(/^-?\d+\.\d{4}$/);

export const LandedCostMethodSchema = z.enum(["by_value", "by_quantity", "by_weight"]).openapi({
  description: "How one cost line is split across the goods lines: by their amount, their quantity, or their weight_kg custom field.",
});

export const AllocateLandedCostBody = z.object({
  allocations: z.array(z.object({
    costLineId: UuidSchema.openapi({ description: "An `account` line of this document carrying freight, duty, clearance or handling." }),
    method: LandedCostMethodSchema,
  })).min(1).max(50),
}).openapi("AllocateLandedCostBody");

export const LandedCostAllocationSchema = z.object({
  id: UuidSchema,
  costLineId: UuidSchema,
  targetLineId: UuidSchema,
  method: LandedCostMethodSchema,
  allocatedAmount: MoneyAmount,
  createdAt: TimestampSchema,
}).openapi("LandedCostAllocation");

export const LandedCostAllocationList = ListEnvelope(LandedCostAllocationSchema);

/** A read model. Nothing stores `landedAmount`: it is `lineAmount + allocated`, recomputed on every read. */
export const LandedCostSummarySchema = z.object({
  targetLineId: UuidSchema,
  lineNo: z.number().int().positive(),
  itemId: UuidSchema.nullable(),
  lineAmount: MoneyAmount,
  allocated: MoneyAmount,
  landedAmount: MoneyAmount,
  quantity: QuantitySchema.nullable(),
}).openapi("LandedCostSummary");
```

Re-export from `packages/contracts/src/index.ts` beside the other `inventory/` modules.

- [ ] **Step 8: Write `apps/api/src/inventory/landed-cost-handlers.ts`**

**Read the five rules this file obeys before writing it; each one is a mistake that compiles nowhere else in the slice.** (1) **Paths are relative.** `documentRoutes` is already mounted at `/v1/companies/:companyId/documents` (1a:5024), so a sub-path declares `path: "/{documentId}/landed-cost"` — an absolute path here would mount at `…/documents/v1/companies/{companyId}/documents/{documentId}/landed-cost` and every case would keep 404-ing. 2C's print route and Task 4's three routes are the precedent. (2) **The gates are `middleware: [...] as const` on the route.** `requireDocumentPermission(stage)` and `requireDocumentModuleRead()` are `MiddlewareHandler<AppEnv>` (§4.5.4) — `(c, next)` — so calling one as `await gate(c, { companyId, documentId })` passes an object where a `Next` function is required, and even if it compiled the gate would never call `next`. (3) **The transaction seam is `c.var.withTenant`.** `AppEnv["Variables"]` is a registered seven-member set and **has no `tx`** (§4.2.3: "a slice adding an eighth amends this block first"). (4) **`AppError` takes `(code, detail, extra?)`** (§4.2.4) — a second-argument object makes `detail` an object, and the same three imports Task 4 uses are the right homes: `AppError` from `@dulja/contracts`, `AppEnv` from `../context`, `requireDocumentModuleRead` from `../middleware/require-attachment-read`. (5) **`IdempotencyHeader` is NOT a `@dulja/contracts` export.** 0B defines it once in **`apps/api/src/routes/index.ts`** (0B Task 11), 2C's routes import it as `from "../index"`, and Task 4's handler file — one directory deeper, like this one — imports it as `from "../routes/index"`. Putting it in the `@dulja/contracts` import statement is a module-resolution failure, not a lint nit: the file does not compile and every case in Step 5 errors before it runs.

```ts
import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import {
  AllocateLandedCostBody, LandedCostAllocationSchema, LandedCostSummarySchema,
  ProblemSchema, UuidSchema,
} from "@dulja/contracts";
import { allocateLandedCostForDocument, landedCostSummary, listLandedCost, resolvePolicy, LandedCostError } from "@dulja/db";
import { z } from "@hono/zod-openapi";
import { AppError, fromDatabaseError } from "@dulja/contracts";
import type { AppEnv } from "../context";
import { requireDocumentPermission } from "../middleware/require-document-permission";
import { requireDocumentModuleRead } from "../middleware/require-attachment-read";
// 0B's home for this schema — `apps/api/src/routes/index.ts`, never `@dulja/contracts` (rule 5 above).
// Task 4 Step 5 imports it by the identical specifier from the sibling handler file.
import { IdempotencyHeader } from "../routes/index";

const ResponseBody = z.object({
  items: z.array(LandedCostAllocationSchema),
  summary: z.array(LandedCostSummarySchema),
});
const Params = z.object({ companyId: UuidSchema, documentId: UuidSchema });

/** Task 4's `asAppError`, verbatim and for the same reason: migration 0038's `landed_cost_allocation_draft_only`
 *  trigger raises `ERR_DOC_NOT_DRAFT: document … is …` as a `check_violation`, and `packages/db` cannot import
 *  `AppError` (§3.1), so the token is translated here. Without this the guard's refusal — an ordinary user
 *  error, 409 — would reach the client as an unmapped `ERR_INTERNAL` 500, and the 409 declared on
 *  `allocateLandedCostRoute` below would be a lie. Anything that is not a token goes through
 *  `fromDatabaseError` exactly as §4.2.4 specifies. */
function asAppError(e: unknown): AppError {
  if (e instanceof Error && /^ERR_[A-Z_]+: /.test(e.message)) {
    const [code, ...rest] = e.message.split(": ");
    return new AppError(code as never, rest.join(": "));
  }
  return fromDatabaseError(e);
}

export const allocateLandedCostRoute = createRoute({
  method: "post",
  // RELATIVE to documentRoutes' own path (1a:5024), exactly like 2C's `/{documentId}/print` (2c:5018)
  // and Task 4's `/{documentId}/links`.
  path: "/{documentId}/landed-cost",
  tags: ["documents"],
  summary: "Allocate an import shipment's freight, duty and clearance across its goods lines",
  // "submit" and not "create": both resolve `approval.create ?? approval.post` (2a:2867-2871), but 2A's
  // "create" branch reads the document TYPE from the request body and 404s when it is absent
  // (2a:2897-2906). This body carries allocations, not a type.
  middleware: [requireDocumentPermission("submit")] as const,
  request: { params: Params, headers: IdempotencyHeader, body: { content: { "application/json": { schema: AllocateLandedCostBody } } } },
  responses: {
    201: { description: "Allocated", content: { "application/json": { schema: ResponseBody } } },
    // 400 and NOT 422. Every refusal this route can produce below the gates is `ERR_VALIDATION_FAILED` —
    // the Zod method enum, the "policy does not receive stock" check, and every `LandedCostError` whose code
    // is `ERR_VALIDATION_FAILED` — and §4.2.4 fixes that code at **400**. No code allocated to 422 is raised
    // on this path, so declaring 422 here would describe a status the route never returns.
    400: { description: "Refused", content: { "application/problem+json": { schema: ProblemSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    409: { description: "The document is not a draft (migration 0038's guard)", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

export const listLandedCostRoute = createRoute({
  method: "get",
  path: "/{documentId}/landed-cost",
  tags: ["documents"],
  summary: "The stored allocation and the landed amount per goods line",
  middleware: [requireDocumentModuleRead()] as const,
  request: { params: Params },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ResponseBody } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

export const allocateLandedCostHandler: RouteHandler<typeof allocateLandedCostRoute, AppEnv> = async (c) => {
  const { documentId } = c.req.valid("param");
  const { allocations } = c.req.valid("json");

  return c.var.withTenant(async (tx) => {
    // Generic over document types, per §4.2.7: the POLICY is asked whether this document receives stock, and a
    // refusal names the type and the effect it actually has. That admits GOODS_RECEIPT and 9B's OPENING_STOCK
    // and refuses a PURCHASE_ORDER, without a list of codes anywhere.
    //
    // `resolvePolicy(tx, documentTypeId, effectiveDate)` is THREE POSITIONAL arguments returning
    // `{ policyId, definition }` (§4.3.1) — it does not take a document. So the header is read first, exactly
    // as 2A's middleware reads it (2a:2909-2915), and the policy is resolved for the document's OWN
    // effective_date: a shipment dated before a policy version change must be allocated under the version it
    // will post under. The gate middleware has already refused an invisible document with 404, so a missing
    // row here would be a race rather than an ordinary miss — it is still handled, because RLS makes
    // "invisible" and "absent" the same answer and a 500 would leak the difference.
    const [header] = await tx<{ document_type_id: string; effective_date: string }[]>`
      select document_type_id, to_char(effective_date, 'YYYY-MM-DD') as effective_date
        from app.document where id = ${documentId}`;
    if (!header) throw new AppError("ERR_NOT_FOUND", `document ${documentId} is not visible`);
    const policy = await resolvePolicy(tx, header.document_type_id, header.effective_date);
    if (policy.definition.inventory.effect !== "receipt") {
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        `${policy.definition.documentType} has inventory.effect '${policy.definition.inventory.effect}'; landed cost is allocated on a document that receives stock`,
      );
    }
    try {
      const rows = await allocateLandedCostForDocument(tx, c.var.ctx, { documentId, allocations });
      return c.json({ items: rows, summary: await landedCostSummary(tx, documentId) }, 201);
    } catch (error) {
      // packages/db may not import AppError (§3.1), so LandedCostError carries a literal ErrCode and reaches
      // the same asAppError branch as PolicyEvaluationError and PostingError (§4.2.4). Two arguments:
      // `AppError` is `(code, detail, extra?)` — a `{ detail }` object would land in `detail` itself.
      if (error instanceof LandedCostError) throw new AppError(error.code, error.detail);
      // Not a LandedCostError: this is where migration 0038's draft-only trigger arrives, as a postgres
      // check_violation whose message starts `ERR_DOC_NOT_DRAFT: `. 409, per §4.2.4.
      throw asAppError(error);
    }
  });
};

export const listLandedCostHandler: RouteHandler<typeof listLandedCostRoute, AppEnv> = async (c) => {
  const { documentId } = c.req.valid("param");
  return c.var.withTenant(async (tx) => {
    try {
      const rows = await listLandedCost(tx, documentId);
      return c.json({ items: rows, summary: await landedCostSummary(tx, documentId) }, 200);
    } catch (error) {
      // `landedCostSummary` raises ERR_NOT_FOUND when the document is invisible — which for another tenant's
      // id is exactly the right answer, and is what the isolation case asserts.
      if (error instanceof LandedCostError) throw new AppError(error.code, error.detail);
      throw asAppError(error);
    }
  });
};
```

**Why the response can be typed and still carry decimal strings.** `RouteHandler<typeof allocateLandedCostRoute, AppEnv>` type-checks `c.json(...)` against the declared 201 schema, so `LandedCostRow.allocatedAmount` and `LandedCostSummaryRow.lineAmount`/`allocated`/`landedAmount` — all `string` in `packages/db` (Task 8) — must line up with the schema. They do, because Step 7 declares those four fields as the 4-dp string of Task 0's §4.2.8 exception rather than as `MoneySchema`. Declaring `MoneySchema` here and returning the rows unchanged is a **compile error**, not merely a wrong OpenAPI document; if a later slice wants `{ amount, currency }` on the wire, the currency must be added to both readers in `packages/db` and the two halves changed together.

- [ ] **Step 9: Mount the two sub-paths on 1A's `documents` module**

In `apps/api/src/routes/accounting/documents.ts`, beside the three link registrations Task 4 added — no new `RouteModule`, no new `PROBES` key (§4.2.7, hazard 31). The symbol is **`documentRoutes`**, 1A's `OpenAPIHono<AppEnv>` in that file; there is no local `app` there, and Task 4 Step 6 registers its three routes the same way:

```ts
import {
  allocateLandedCostHandler, allocateLandedCostRoute,
  listLandedCostHandler, listLandedCostRoute,
} from "../../inventory/landed-cost-handlers";

documentRoutes.openapi(allocateLandedCostRoute, allocateLandedCostHandler);
documentRoutes.openapi(listLandedCostRoute, listLandedCostHandler);
```

- [ ] **Step 10: Run the route suite and the isolation harness to verify they pass**

Run: `cd apps/api && bun run test -- test/routes/accounting/landed-cost.test.ts && cd ../.. && bun run --cwd tests test -- invariants/tenant-isolation.test.ts`
Expected: **PASS** (8 route tests; the harness unchanged — the `documents` module's existing probe covers both sub-paths).

Four failures worth naming in advance. A `500` `ERR_INTERNAL` on the not-a-draft case means Step 8's `asAppError` was skipped or the `catch` still ends `throw error`: 0038's trigger raises a plain postgres `check_violation` carrying the `ERR_DOC_NOT_DRAFT:` token and nothing else in this file translates it, so the 409 declared on the route would be undeliverable. A `404` on **every** case means the paths were written absolutely: they are relative to `documentRoutes`' own `/v1/companies/:companyId/documents` and the router would have mounted them one level down from where the test asks. A `201` where the RBAC case expects `403` means the gate is not on the route — it belongs in `middleware: [...] as const`, which Hono runs before the handler and before the body is parsed, and a gate invoked inside the handler body would both compile wrongly (`MiddlewareHandler` wants `(c, next)`) and run too late. And `ERR_VALIDATION_FAILED: PURCHASE_ORDER has inventory.effect 'undefined'` means the resolved policy was read through the wrong member: `resolvePolicy` returns **`{ policyId, definition }`** (§4.3.1, 1a:2057) and the effect is on `.definition.inventory` — read the shape, do not add a fallback.

- [ ] **Step 11: Commit**

```bash
git add packages/db/seed/my/document-types/SHIPMENT.json packages/contracts/src/inventory/landed-cost.ts \
        packages/contracts/src/index.ts apps/api/src/inventory/landed-cost-handlers.ts \
        apps/api/src/routes/accounting/documents.ts packages/db/src/seed/index.ts \
        packages/db/test/purchasing/landed-cost.test.ts \
        apps/api/test/routes/accounting/landed-cost.test.ts
git commit -m "feat(inventory): add SHIPMENT and the landed-cost routes; the Phase 3 DoD clause is green [3C T9]

An allocated share reaches cost_layer.unit_cost exactly and moves the next issue's cost_consumption and
document_line.cost with it (spec:2289, spec:1020). Re-allocating by another method replaces the split and
still sums to the cent. A back-dated shipment recosts forward only, with a COST_ADJUSTMENT (test 5).
SHIPMENT's four ledger rules are GOODS_RECEIPT's verbatim, asserted byte for byte.
Also re-exports 0C's chartOfAccountsLoader from the seed barrel: the route suite is in apps/api and
cannot reach packages/db/src/seed/chart-of-accounts by path, and 0C's barrel only imported it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `PURCHASE_RETURN` — the issue leg, and tests 7, 14 and 18 re-run over it

**Files:**
- Create: `packages/db/seed/my/document-types/PURCHASE_RETURN.json`
- Create: `packages/db/test/purchasing/purchase-return.test.ts`
- Test: `packages/db/test/purchasing/purchase-return.test.ts`

**Interfaces:**
- Consumes: `postDocument`, `transitionDocument`, `loadSnapshot` (1A, 2B); `applyMovements`, `app.inventory_movement`, `app.stock_on_hand`, `app.assert_stock_available` (3A); `costingEngine`, `app.cost_layer`, `app.cost_consumption`, `valuationAsOf` (3B); `linkFulfilment`, `openQuantity` (Task 4); `accounting.purchase.post` / `.create` (Task 2); `party.payable_account` and `app.party.payable_account_id` defaulting to `2100` (§4.5.7); `item.inventory_account` (§4.4.2 `ItemRef`); `postOverriddenIssue`, `recordingJobs`, `ensureOpenPeriods` (3B, `tests/invariants/support/post-inventory`); ADR 0041's two return decisions (Task 7).
- Produces: `packages/db/seed/my/document-types/PURCHASE_RETURN.json` — the §4.14 row `PURCHASE_RETURN` / module `inventory` / series `PR` / `direction: outbound` / `inventory: issue` / `approval.post: accounting.purchase.post`.

**Two rules, both `line.cost`, and this is the shape §4.3.4's rule *requires* rather than merely permits.** A return is an **issue**: stock leaves and the costing engine says what it carries. Both legs therefore reference `line.cost`, which is `null` at §4.3.2 step 6 — so the plan balances there as `0 = 0`, `applyMovements` fills it at step 9 from the consumed layers, and 3B re-loads the snapshot and re-balances at the real figures (3b:3172–3180). This is 3B's `STOCK_ISSUE_TEST` shape exactly (3b:2556–2557); the only difference is which accounts the two refs resolve to.

**The two decisions ADR 0041 records, restated here because the implementer types them.** (1) **Stock leaves at carrying cost, not at the supplier's price** — §4.4.1's `amountRef` enumeration has thirteen members and none of them means "the difference between two others", so a three-rule policy that debited payables at the supplier's price and pushed the freight difference to COGS is not expressible; widening the schema is a new `version` const and a new `$id` proposed through the contracts document, never a plan's decision (hazard 7). It is also the right answer for the report that matters: valuation drops by exactly what `cost_consumption` records, which is what makes test 7 tie to the cent. (2) **The debit is `party.payable_account`** — at Phase 3 the return is a debit note against the supplier, and `requires: ["party", "warehouse"]` makes the supplier mandatory rather than merely likely. The supplier will credit the *goods* price; the difference is recognised when 4A's `PURCHASE_CREDIT_NOTE` lands against this document. If the owner's accountant rejects that in Task 12, the change is one `account` ref in this seed file and two assertions below.

**What "test 7 re-run" means here, and what it does not.** Test 7 is 3D's: "an item transferred, gone negative, and had a supplier return; valuation and the profit figure tie to the cent". 3C owns the **supplier-return leg** and the **negative excursion on that leg**; the transfer half needs 3D's `TRANSFER` and is asserted there. So the case below drives a receipt → an override-authorised return beyond stock → a normal return, and ties `stock_valuation` to Σ layer residues and Σ`cost_consumption` to the cent. F-6 and hazard 17 bind it: the excursion is produced **only** through an `inventory.negative_stock.override` event recorded by a **second** principal, which is `postOverriddenIssue`'s whole reason for existing (3B amendment A21(b)) — a test that toggled a flag or inserted a movement directly would be invalid, and test 18 is exactly the assertion that no such door exists.

- [ ] **Step 1: Write the failing test `packages/db/test/purchasing/purchase-return.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { validateDocumentTypeSeed } from "@dulja/domain";
import { PERMISSIONS } from "@dulja/contracts";
import { allocateLandedCostForDocument, linkFulfilment, openQuantity, postDocument, valuationAsOf } from "../../src/index";
import { documentTypesLoader } from "../../src/seed/index";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import {
  ensureOpenPeriods, postOverriddenIssue, recordingJobs, STOCK_ISSUE_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import {
  draftTypedDocument, grantCodes, seedDocumentType, seedItem, seedParty, seedTenantV2, seedWarehouse,
  startDb, withTenant, type Db, type Seed,
} from "../index";

const PACK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "seed", "my");
const TYPES_DIR = join(PACK_ROOT, "document-types");
const MYR = currency("MYR");

let db: Db;
let s: Seed;
let partyId: string;
let warehouseId: string;

const ctx = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "3c-pr-test" });
const loaderCtx = (seed: Seed, only: string[]) => ({
  config: {
    tenantId: seed.tenant, only, packRoot: PACK_ROOT, tenantName: "pr",
    ownerEmail: "owner@example.invalid", companyCode: "HQ", companyName: "pr HQ",
    baseCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", fiscalYearStartMonth: 1, fiscalYear: 2026,
  },
  tenantId: seed.tenant, companyId: seed.company, systemPrincipalId: seed.system, packRoot: PACK_ROOT,
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "pr");
  await grantCodes(db, s, {
    codes: ["accounting.purchase.create", "accounting.purchase.post", "inventory.receipt.create", "inventory.receipt.post"],
  });
  await withTenant(db.migrator, s.tenant, s.system, (tx) => chartOfAccountsLoader.load(tx, loaderCtx(s, ["chart-of-accounts"])));
  await withTenant(db.migrator, s.tenant, s.system, (tx) => documentTypesLoader.load(tx, loaderCtx(s, ["document-types"])));
  await ensureOpenPeriods(db, s, 2026);
  partyId = await seedParty(db, s, { kind: "vendor", code: "PR-VEND" });
  warehouseId = await seedWarehouse(db, s, { code: "PR-WH" });
}, 300_000);
afterAll(async () => { await db.stop(); });

async function typeId(code: string): Promise<string> {
  const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = ${code}`);
  return row!.id;
}

/** A posted receipt of `quantity` at `unitPrice`, which is what a return has to have something to return. */
async function receive(itemCode: string, quantity: string, unitPrice: string, amount: string): Promise<{ itemId: string; baseUnitId: string }> {
  const { itemId, baseUnitId } = await seedItem(db, s, { code: itemCode });
  const { documentId } = await draftTypedDocument(db, s, {
    documentTypeId: await typeId("GOODS_RECEIPT"), series: "GRN", partyId, warehouseId, effectiveDate: "2026-05-01",
    lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity, unitPrice, amount }],
  });
  await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }));
  return { itemId, baseUnitId };
}

describe("PURCHASE_RETURN — contracts §4.14, spec:1698, ADR 0041", () => {
  it("the seed file is a valid envelope: outbound, issue, consume_layers, series PR, both legs line.cost", () => {
    const envelope = JSON.parse(readFileSync(join(TYPES_DIR, "PURCHASE_RETURN.json"), "utf8")) as Record<string, unknown>;
    expect(validateDocumentTypeSeed(envelope)).toEqual({ ok: true, errors: [] });
    expect(envelope["code"]).toBe("PURCHASE_RETURN");
    expect(envelope["module"]).toBe("inventory");
    const policy = envelope["policy"] as Record<string, unknown>;
    expect(policy["direction"]).toBe("outbound");
    expect(policy["inventory"]).toEqual({ effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" });
    expect(policy["numbering"]).toEqual({ series: "PR", assignAt: "issue" });
    expect(policy["requires"]).toEqual(["party", "warehouse"]);
    expect(policy["approval"]).toEqual({
      required: false, approve: null, post: "accounting.purchase.post", create: "accounting.purchase.create",
    });
    // ADR 0041: both legs at line.cost, debit party.payable_account, credit item.inventory_account.
    expect((policy["lines"] as { side: string; amount: string; account: Record<string, string> }[]).map((l) => [l.side, l.amount, l.account["from"]])).toEqual([
      ["debit", "line.cost", "party.payable_account"],
      ["credit", "line.cost", "item.inventory_account"],
    ]);
  });

  it("every approval code the policy names is in the catalogue (F-21)", () => {
    const envelope = JSON.parse(readFileSync(join(TYPES_DIR, "PURCHASE_RETURN.json"), "utf8")) as { policy: { approval: Record<string, string | null> } };
    const catalogue = new Set(PERMISSIONS.map((p) => p.code));
    for (const key of ["approve", "post", "create"] as const) {
      const code = envelope.policy.approval[key];
      if (code !== null && code !== undefined) expect(catalogue.has(code)).toBe(true);
    }
  });

  it("issues stock at carrying cost, debits payables and credits inventory by the same figure", async () => {
    const { itemId, baseUnitId } = await receive("PR-ITEM-1", "100.000000", "12.0000", "1200.0000");
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_RETURN"), series: "PR", partyId, warehouseId, effectiveDate: "2026-05-10",
      // The operator enters the SUPPLIER's price for the printed document; the policy uses only line.cost.
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "10.000000", unitPrice: "12.0000", amount: "120.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }));

    const [mv] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ quantity: string; value: string }[]>`
      select quantity::text as quantity, value::text as value from app.inventory_movement where document_id = ${documentId}`);
    expect(mv).toEqual({ quantity: "-10.000000", value: "-120.0000" });     // signs from `effect`, never from the plan

    const entries = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; debit: string; credit: string; rate: string }[]
    >`select a.code, e.debit::text as debit, e.credit::text as credit, e.exchange_rate::text as rate
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${documentId} order by a.code`);
    // 2100 trade payables debited, the item's inventory account (1300 by default) credited, both 120.0000.
    // Rate 1.00000000 on both: a cost line is written in base currency (3B's A4 widened insertLedger's branch).
    expect(entries).toEqual([
      { code: "1300", debit: "0.0000", credit: "120.0000", rate: "1.00000000" },
      { code: "2100", debit: "120.0000", credit: "0.0000", rate: "1.00000000" },
    ]);

    const [onHand] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand where item_id = ${itemId}`);
    expect(onHand!.quantity).toBe("90.000000");
  });

  it("returns goods that carry a landed cost at the LANDED figure, not at the supplier's price", async () => {
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "PR-ITEM-2" });
    const freight = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '5900'`);
    const receipt = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("SHIPMENT"), series: "SHP", partyId, warehouseId, effectiveDate: "2026-05-02",
      lines: [
        { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "10.000000", unitPrice: "100.0000", amount: "1000.0000" },
        { kind: "account", accountId: freight[0]!.id, description: "freight", amount: "200.0000" },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), { documentId: receipt.documentId, allocations: [{ costLineId: receipt.lineIds[1]!, method: "by_value" }] }));
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId: receipt.documentId, jobs: recordingJobs() }));

    const ret = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_RETURN"), series: "PR", partyId, warehouseId, effectiveDate: "2026-05-11",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "2.000000", unitPrice: "100.0000", amount: "200.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId: ret.documentId, jobs: recordingJobs() }));

    // The layer is at 120.0000 a unit, so two units leave at 240.0000 — not the 200.0000 the operator typed.
    // The 40.0000 difference is the freight share on the returned goods; ADR 0041 leaves it for 4A's credit note.
    const [line] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ cost: string }[]>`
      select cost::text as cost from app.document_line where document_id = ${ret.documentId}`);
    expect(line!.cost).toBe("240.0000");
    const [payables] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ debit: string }[]>`
      select e.debit::text as debit from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${ret.documentId} and a.code = '2100'`);
    expect(payables!.debit).toBe("240.0000");
  });

  it("test 18: the data layer refuses a return beyond stock, and only an authorised override admits it", async () => {
    const { itemId, baseUnitId } = await receive("PR-ITEM-3", "5.000000", "10.0000", "50.0000");
    const returnType = await typeId("PURCHASE_RETURN");

    // No flag, no header, no session variable opens this door — the trigger reads the movements themselves.
    const tooMuch = await draftTypedDocument(db, s, {
      documentTypeId: returnType, series: "PR", partyId, warehouseId, effectiveDate: "2026-05-12",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "9.000000", unitPrice: "10.0000", amount: "90.0000" }],
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId: tooMuch.documentId, jobs: recordingJobs() })),
    ).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);

    // The one door F-6 admits: an `inventory.negative_stock.override` event recorded by a SECOND principal
    // (hazard 17). postOverriddenIssue is 3B's helper precisely because the guard has two clauses a caller
    // gets wrong once each.
    //
    // The override half runs through 3A's registered STOCK_ISSUE_TEST and NOT through PURCHASE_RETURN, for
    // one mechanical reason: `postOverriddenIssue`'s options carry no `partyId`, and PURCHASE_RETURN's
    // `requires: ["party", "warehouse"]` would refuse the document at step 4 with
    // ERR_POLICY_REQUIRES_MISSING before `assert_stock_available` ever fired. Test 18 is an assertion about
    // the TRIGGER — "negative stock is rejected by the data layer regardless of write path" — not about a
    // document type, and the refusal half above already establishes that a purchase return is one such path.
    const issueType = await seedDocumentType(db, s, { code: "STOCK_ISSUE_TEST", module: "inventory", policy: STOCK_ISSUE_COST_POLICY });
    const overridden = await postOverriddenIssue(db, s, {
      documentTypeId: issueType, itemId, warehouseId, quantity: "9.000000",
      effectiveDate: "2026-05-13", unitPrice: "10.0000",
    });
    expect(overridden.supervisorId).not.toBe(s.human);
    const [onHand] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand where item_id = ${itemId}`);
    expect(onHand!.quantity).toBe("-4.000000");
    const [event] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_event
       where document_id = ${overridden.documentId} and event_kind = 'override'
         and override_code = 'inventory.negative_stock.override'`);
    expect(event!.n).toBe(1);
  });

  it("test 7's supplier-return leg: valuation and the cost side tie to the cent", async () => {
    const { itemId, baseUnitId } = await receive("PR-ITEM-4", "20.000000", "15.0000", "300.0000");
    const ret = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_RETURN"), series: "PR", partyId, warehouseId, effectiveDate: "2026-05-14",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "6.000000", unitPrice: "15.0000", amount: "90.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId: ret.documentId, jobs: recordingJobs() }));

    // ONE costing answer (SAH-009): the valuation read, the layer residues and the consumption rows all agree.
    // `ValuationParams` is 3B's frozen shape: `{ companyId; asOf; itemId?; warehouseId?; cursor?; limit }`
    // (3b:4475–4486). There is no `itemIds`, and `limit` is REQUIRED — an excess property on an object
    // literal is a TypeScript error and a missing required one is another, so this call is the shape or the
    // suite does not compile.
    const valuation = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      valuationAsOf(tx, { companyId: s.company, asOf: "2026-05-31", itemId, limit: 100 }));
    // `round(…, 4)`, not a bare `::text`. `numeric(19,6) * numeric(19,4)` has scale 6 + 4 = 10 in PostgreSQL
    // and `sum()` keeps it, so the bare cast would read "210.0000000000" while the arithmetic is right. The
    // rounding is the one `valuationAsOf` itself applies per layer (3b:1106), which is why the two agree.
    const [residue] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ quantity: string; value: string }[]>`
      select coalesce(sum(l.qty_remaining), 0)::text as quantity,
             round(coalesce(sum(l.qty_remaining * l.unit_cost), 0), 4)::text as value
        from app.cost_layer l where l.item_id = ${itemId} and l.invalidated_at is null`);
    expect(residue).toEqual({ quantity: "14.000000", value: "210.0000" });
    const valued = valuation.reduce((acc, r) => acc.add(Money.of(r.value, MYR)), Money.zero(MYR));
    expect(valued.toString()).toBe("210.0000");

    const [consumed] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ value: string }[]>`
      select coalesce(sum(k.value), 0)::text as value from app.cost_consumption k
        join app.inventory_movement m on m.id = k.movement_id where m.document_id = ${ret.documentId}`);
    expect(consumed!.value).toBe("90.0000");
    // 300 received − 90 returned = 210 remaining, to the cent, by three independent readers.
  });

  it("test 14: who can post a purchase return in company X is one query, and it names a real type", async () => {
    // The type exists as configuration, which is what makes the question meaningful (§2.4's "a real
    // purchase-return type exists for the one-query test"). 0A pinned the query; this re-runs it verbatim.
    expect(await typeId("PURCHASE_RETURN")).toBeTruthy();
    const who = await withTenant(db.rw, s.tenant, s.system, (tx) => tx<{ id: string; display_name: string }[]>`
      select distinct p.id, p.display_name
        from app.principal p
        join app.role_assignment ra on ra.principal_id = p.id
        join app.role_permission rp on rp.role_id = ra.role_id
       where ra.company_id = ${s.company} and rp.permission_code = 'accounting.purchase.post'
         and (ra.expires_at is null or ra.expires_at > now())
       order by p.display_name`);
    expect(who.map((r) => r.id)).toContain(s.human);
  });

  it("links a return to the receipt it reverses, and the receipt's open quantity falls (SAH-018)", async () => {
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "PR-ITEM-5" });
    const order = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_ORDER"), series: "PO", partyId, effectiveDate: "2026-05-03",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "10.000000", unitPrice: "10.0000", amount: "100.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`);
    const receipt = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("GOODS_RECEIPT"), series: "GRN", partyId, warehouseId, effectiveDate: "2026-05-04",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "10.000000", unitPrice: "10.0000", amount: "100.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      linkFulfilment(tx, ctx(s), {
        sourceDocumentId: order.documentId, targetDocumentId: receipt.documentId, linkKind: "receives_against",
        lines: [{ sourceLineId: order.lineIds[0]!, targetLineId: receipt.lineIds[0]!, quantity: "10.000000" }],
      }));
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId: receipt.documentId, jobs: recordingJobs() }));

    const ret = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_RETURN"), series: "PR", partyId, warehouseId, effectiveDate: "2026-05-15",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "4.000000", unitPrice: "10.0000", amount: "40.0000" }],
    });
    // link_kind 'returns' against the POSTED receipt: the guard admits a posted source (Task 1) and the
    // returned quantity is a projection over these rows, never a column on the receipt line (SAH-018).
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      linkFulfilment(tx, ctx(s), {
        sourceDocumentId: receipt.documentId, targetDocumentId: ret.documentId, linkKind: "returns",
        lines: [{ sourceLineId: receipt.lineIds[0]!, targetLineId: ret.lineIds[0]!, quantity: "4.000000" }],
      }));
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => openQuantity(tx, receipt.documentId));
    expect(rows.map((r) => [r.orderedQuantity, r.linkedQuantity, r.openQuantity])).toEqual([["10.000000", "4.000000", "6.000000"]]);

    const [returnedColumn] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'document_line' and column_name like '%returned%'`;
    expect(returnedColumn!.n).toBe(0);          // SAH-018 asserted structurally, not by inspection
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/purchasing/purchase-return.test.ts`
Expected: **FAIL** — the first case with `ENOENT … document-types/PURCHASE_RETURN.json`, the rest with `Cannot read properties of undefined (reading 'id')` from `typeId("PURCHASE_RETURN")`.

- [ ] **Step 3: Write `packages/db/seed/my/document-types/PURCHASE_RETURN.json`**

```json
{
  "code": "PURCHASE_RETURN",
  "nameEn": "Purchase Return",
  "nameAr": "مرتجع مشتريات",
  "module": "inventory",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "PURCHASE_RETURN",
    "direction": "outbound",
    "requires": ["party", "warehouse"],
    "lines": [
      {
        "for": "each_line",
        "side": "debit",
        "account": { "from": "party.payable_account" },
        "amount": "line.cost",
        "when": { "line.kind": "item" }
      },
      {
        "for": "each_line",
        "side": "credit",
        "account": { "from": "item.inventory_account" },
        "amount": "line.cost",
        "when": { "line.kind": "item" }
      }
    ],
    "inventory": { "effect": "issue", "warehouse": "line.warehouse", "costing": "consume_layers" },
    "tax": { "applies": false },
    "numbering": { "series": "PR", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "PURCHASE_RETURN" },
    "approval": {
      "required": false,
      "approve": null,
      "post": "accounting.purchase.post",
      "create": "accounting.purchase.create"
    },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

**Four members that look arbitrary and are not.** `"costing": "consume_layers"` — the return consumes the layers the receipt created, which is what makes the value the *carrying* cost and what makes `cost_consumption` record exactly what left (spec:1220). `"tax": { "applies": false }` — the input tax on a purchase is claimed on the supplier's invoice, not on the movement of goods; reversing a claim the return has no document for is 4A's `PURCHASE_CREDIT_NOTE`'s job, and a return that adjusted the tax return before that document existed would put an entry in the return the authority cannot see. `"requires": ["party", "warehouse"]` — the party is mandatory because the *debit account is resolved from it*, and `validateRequires` refuses at post with `ERR_POLICY_REQUIRES_MISSING` naming the field rather than posting to a null account. `"reversal": { "allowed": true, "producesType": "PURCHASE_RETURN" }` — reversing a return re-receives the goods, and branch 1 of §4.7.2's rule values that receipt from the copied `l.cost` (Task 8 Step 5), which is why the column had to be added: without it the re-receipt would be valued at the negated *supplier* price and the item's cost would drift by the freight share on every return-and-reverse cycle.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/db && bun run test -- test/purchasing/purchase-return.test.ts`
Expected: **PASS** (8 tests).

Four failures worth naming in advance. `ERR_LEDGER_UNBALANCED` on the first posting case means one of the two rules was given `line.amount` rather than `line.cost` — the pair must be cost/cost or step 6 refuses the document before `applyMovements` can fill anything (§4.3.4's rule). `ERR_POLICY_REQUIRES_MISSING: party.payable_account` means `seedParty` created the vendor without `payable_account_id`; §4.5.7 defaults it to `2100` and the chart loader must run **before** `seedParty`, which is why the `beforeAll` orders them that way. Exchange rate `4.20000000` where the test expects `1.00000000` means 3B's amendment A4 edit to `insertLedger` did not widen `isFx` to `role !== "policy"` — a cost line must be written in base at rate 1, and Task 0 Step 3's `grep` gate exists to catch this before Task 6. And `onHand: "-4.000000"` reported as `"5.000000"` in the test-18 case means `postOverriddenIssue` recorded the override under `s.human` rather than a second principal, in which case `app.assert_override_authorised`'s second clause should have refused it — read 3B's doc comment on that helper rather than working around it.

- [ ] **Step 5: Commit**

```bash
git add packages/db/seed/my/document-types/PURCHASE_RETURN.json packages/db/test/purchasing/purchase-return.test.ts
git commit -m "feat(seed): add PURCHASE_RETURN, an issue valued at carrying cost [3C T10]

Both legs are line.cost (contracts 4.3.4's rule for an issue): payables debited, inventory credited, at the
figure the layers say. Goods that carry a landed cost go back at the landed figure; the difference against
the supplier's price is 4A's credit note (ADR 0041). Re-runs tests 7 (return leg), 14 (a real type for the
one query) and 18 (negative stock refused by the data layer, override the only door).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Test 15 re-run — `CONSIGNMENT_RETURN` in the inventory-bearing shape 2C deferred

**Files:**
- Create: `tests/fixtures/document-types/CONSIGNMENT_RETURN.v2.json`
- Modify: `tests/invariants/zero-code-document-type.test.ts` (one appended describe block)
- Test: `tests/invariants/zero-code-document-type.test.ts`

**Interfaces:**
- Consumes: 2C's test-15 machinery unchanged — the `POST /v1/companies/{companyId}/document-types` and `…/posting-policies` routes, `tests/fixtures/document-types/CONSIGNMENT_RETURN.json`, `tests/fixtures/templates/CONSIGNMENT_RETURN.standard.v1.{json,html}`, `pdfText` (§4.17.1), 1B's `accounting.ledger` report route, 2B's `…/reverse` route; `app.item`, `app.warehouse`, `app.cost_layer` (3A, 3B); `accounting.purchase.post` (Task 2); `startApi`, `grantAdmin`, `problemOf`, `fullRegression` (0B); `seedItem`, `seedWarehouse`, `seedParty` (3A, 2A).
- Produces: `tests/fixtures/document-types/CONSIGNMENT_RETURN.v2.json` — **policy version 2 of the same §4.14 code**, `inbound / receipt / accounting.purchase.post`. No new document-type code, no new §4.14 row.

**This task exists because 2C wrote down that it would.** 2C's Task 10 note (2c:5202) and §4.14's `CONSIGNMENT_RETURN` row both say the same thing: the fixture is "**deliberately inventory-free at 2C**" because `accounting.purchase.post` is 3C's code and §4.4.1's `validatePolicy` fails with `ERR_POLICY_INVALID` on an `approval` code absent from the catalogue (F-21), while `inventory.effect: "receipt"` makes `warehouse` and `costing` required by the schema's conditional and needs `app.warehouse`, `app.item` and `app.cost_layer` — none of which existed. All four now exist, and **3C re-runs test 15 on the inventory-bearing shape**. That sentence is the whole scope of this task.

**It is a second policy *version*, not a second document type, and that is the sharper proof.** The tenant already has `CONSIGNMENT_RETURN` from 2C. Adding `inventory` behaviour to it is a `POST …/document-types/{id}/posting-policies` with `policyVersion: 2` and a later `effectiveFrom` — so the same code now numbers, posts, prints, reports and reverses with a **stock effect it did not have yesterday**, with zero lines of application code and without touching the documents already posted under version 1. Test 15 says "define a new document type purely as configuration"; this says the stronger thing, that its *behaviour* is configuration too, which is what §4.4.1's `effectiveFrom` versioning is for and what nothing has yet exercised.

- [ ] **Step 1: Write `tests/fixtures/document-types/CONSIGNMENT_RETURN.v2.json`**

The envelope a tenant would POST as a second version. `code` still matches `policy.documentType` (§4.3.7's cross-field rule), and the accounts stay `{ from: … }` refs so this fixture, like 2C's, seeds no account code of its own (hazard 33 does not bite).

```json
{
  "code": "CONSIGNMENT_RETURN",
  "nameEn": "Consignment Return",
  "nameAr": "مرتجع أمانة",
  "module": "accounting",
  "policyVersion": 2,
  "effectiveFrom": "2026-07-01",
  "policy": {
    "version": 1,
    "documentType": "CONSIGNMENT_RETURN",
    "direction": "inbound",
    "requires": ["party", "warehouse"],
    "lines": [
      {
        "for": "each_line",
        "side": "debit",
        "account": { "from": "item.inventory_account" },
        "amount": "line.amount",
        "when": { "line.kind": "item" }
      },
      {
        "for": "each_line",
        "side": "credit",
        "account": { "from": "line.account" },
        "amount": "line.amount",
        "when": { "line.kind": "account" }
      }
    ],
    "inventory": { "effect": "receipt", "warehouse": "line.warehouse", "costing": "create_layer" },
    "tax": { "applies": false },
    "numbering": { "series": "CR", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "CONSIGNMENT_RETURN" },
    "approval": {
      "required": false,
      "approve": null,
      "post": "accounting.purchase.post",
      "create": "accounting.purchase.create"
    },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

**`module` stays `accounting`** — §4.14's row says so, and hazard 34's rule is that the column answers "which module's read code may see this document's attachments", which for a consignment return is the accountant's, not the warehouse's. Adding a stock effect does not move the filing cabinet. **The `account`-kind credit rule replaces `2150`**: a consignment return is not a purchase and owes no supplier accrual — the counterparty is whatever account the operator names on the line, which is exactly the "zero-code" freedom test 15 is about.

- [ ] **Step 2: Append the failing describe block to `tests/invariants/zero-code-document-type.test.ts`**

2C's file already has the version-1 block, its `beforeAll`, its fixture readers and its own file-local lookups. This adds one block that reuses them. **`StartedApi` is the eight members §4.2.12 lists and no more** (`db`, `objectStore`, `app`, `tokenFor`, `signToken`, `loadPrincipals`, `request(input: ApiRequest)`, `stop`), and `request` takes **one object** — so the two lookups below are file-local, exactly as 2C's own block writes them, and hazard 9 forbids adding a member for either.

```ts
/** File-local, beside 2C's own: §4.2.12 gives `StartedApi` no lookup members. */
async function consignmentTypeId(): Promise<string> {
  const [row] = await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = 'CONSIGNMENT_RETURN'`);
  return row!.id;
}

describe("acceptance test 15 — the inventory-bearing shape, added as policy version 2 (3C)", () => {
  let v2DocumentId = "";

  it("accepts version 2 with a stock effect, over the API, with zero code", async () => {
    const v2 = JSON.parse(readFileSync(join(FIXTURES, "document-types/CONSIGNMENT_RETURN.v2.json"), "utf8")) as {
      code: string; policyVersion: number; effectiveFrom: string; policy: unknown;
    };
    const typeId = await consignmentTypeId();                       // created by the version-1 block
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/document-types/${typeId}/posting-policies`, as: s.human,
      idempotencyKey: "cr-v2",
      body: { policyVersion: v2.policyVersion, effectiveFrom: v2.effectiveFrom, definition: v2.policy },
    });
    expect(res.status).toBe(201);

    // Both versions are live, each on its own side of effectiveFrom (§4.4.1's versioning).
    const versions = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/document-types/${typeId}/posting-policies`, as: s.human,
    });
    const listed = await versions.json() as { items: { policyVersion: number; effectiveFrom: string }[] };
    expect(listed.items.map((i) => [i.policyVersion, i.effectiveFrom])).toEqual([[1, "2026-01-01"], [2, "2026-07-01"]]);
  });

  it("a document dated after effectiveFrom takes stock in, creates a layer and numbers in the same CR series", async () => {
    const typeId = await consignmentTypeId();
    const { itemId, baseUnitId } = await seedItem(api.db, s, { code: "CR-ITEM" });
    const warehouseId = await seedWarehouse(api.db, s, { code: "CR-WH" });
    const partyId = await seedParty(api.db, s, { kind: "vendor", code: "CR-CONSIGNOR" });
    await ensureOpenPeriods(api.db, s, 2026);          // August is not one of 0A's three periods

    const created = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents`, as: s.human, idempotencyKey: "cr-v2-doc",
      body: {
        documentTypeId: typeId, effectiveDate: "2026-08-05", partyId, warehouseId, branchId: s.hq,
        lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "6.000000", unitPrice: "25.0000", amount: "150.0000" }],
      },
    });
    expect(created.status).toBe(201);
    const { id: documentId } = await created.json() as { id: string };
    v2DocumentId = documentId;

    // `POST …/documents/{id}/transitions` with `{ to: "posted" }`. There is no `…/post` sub-path: 1A's
    // `documentRoutes` declares exactly `POST /`, `GET /{documentId}`, `PUT /{documentId}/lines` and
    // `POST /{documentId}/transitions` (1a:4768–4876), and §4.5.4 makes `to = "posted"` the thing that calls
    // `postDocument`. 2C's own test-15 file posts the same way (2c:5441).
    const posted = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/transitions`, as: s.human,
      idempotencyKey: "cr-v2-post", body: { to: "posted" },
    });
    expect(posted.status).toBe(200);
    // `TransitionResultSchema` (1A) is `{ documentId, status, number, series, fiscalPeriodId, ledgerEntryIds }`
    // — there is no `postingPolicyVersion` member on it, or on any declared schema.
    const body = await posted.json() as { status: string; number: string; series: string };
    expect(body).toMatchObject({ status: "posted", series: "CR" });

    // The pin is read where §4.3.2 step 13 writes it: `app.document.posting_policy_id`. Version 2, because
    // the document is dated after July and `resolvePolicy` picks the row effective on `effective_date`.
    const [pinned] = await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx<{ version: number }[]>`
      select p.version from app.posting_policy p
        join app.document d on d.posting_policy_id = p.id
       where d.id = ${documentId}`);
    expect(pinned!.version).toBe(2);

    const [layer] = await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx<{ unit_cost: string; qty_in: string }[]>`
      select l.unit_cost::text as unit_cost, l.qty_in::text as qty_in
        from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
       where m.document_id = ${documentId}`);
    expect(layer).toEqual({ unit_cost: "25.0000", qty_in: "6.000000" });
    const [onHand] = await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand where item_id = ${itemId}`);
    expect(onHand!.quantity).toBe("6.000000");
  });

  it("and still prints, reports and reverses — the clauses test 15 names, now with stock", async () => {
    expect(v2DocumentId).not.toBe("");                   // the previous case posted it

    const pdf = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/documents/${v2DocumentId}/print?template=standard`, as: s.human,
    });
    expect(pdf.status).toBe(200);
    expect(await pdfText(await pdf.arrayBuffer())).toContain("Consignment Return");

    const report = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/reports/accounting.ledger?from=2026-08-01&to=2026-08-31`, as: s.human,
    });
    expect(report.status).toBe(200);
    expect(JSON.stringify(await report.json())).toContain(v2DocumentId);

    const reversed = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${v2DocumentId}/reverse`, as: s.human,
      idempotencyKey: "cr-v2-rev", body: { effectiveDate: "2026-08-20", reason: "consignor recalled the return" },
    });
    expect(reversed.status).toBe(201);
    // The reversal is an ISSUE of the same goods, valued from the copied l.cost (Task 8 branch 1) — so stock
    // returns to zero and the layer is fully consumed rather than left half-costed.
    const [onHand] = await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx<{ quantity: string }[]>`
      select coalesce(sum(h.quantity), 0)::text as quantity from app.stock_on_hand h
        join app.item i on i.id = h.item_id where i.code = 'CR-ITEM'`);
    expect(onHand!.quantity).toBe("0.000000");
  });

  it("no application code was added for any of it (the zero-code clause, mechanically)", async () => {
    // The same assertion 2C's version-1 block makes, over this PR's own diff. `sourceFiles` and `REPO_ROOT`
    // are 0B's exports (§4.2.12); the git call is the one 2C's block already uses — reuse it rather than
    // writing a second shape of the same check.
    const changed = execFileSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n").filter((l) => l.length > 0);
    expect(changed.filter((f) => /^(apps|packages)\/[^/]+\/src\//.test(f))).toEqual([]);
  });
});
```

Add `execFileSync` from `node:child_process`, `REPO_ROOT` from `@dulja/db` (0B) and `ensureOpenPeriods` from `tests/invariants/support/post-inventory` to the file's imports if 2C's version-1 block does not already carry them. **If 2C's block already has an equivalent zero-code check, call that one instead of adding this** — two spellings of one assertion is the duplication §4.17.1 exists to prevent.

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run --cwd tests test -- invariants/zero-code-document-type.test.ts`
Expected: **FAIL** — the first new case with `ENOENT … CONSIGNMENT_RETURN.v2.json`. 2C's version-1 block stays green throughout.

- [ ] **Step 4: Run it again after Step 1's fixture exists**

Run: `bun run --cwd tests test -- invariants/zero-code-document-type.test.ts`
Expected: **PASS** — 2C's original cases plus four.

Two failures worth naming in advance. `ERR_POLICY_INVALID` with an `errors[]` entry at `/approval/post` means Task 2 has not merged — that is the exact refusal §4.14's row predicted, and it is why this task is 3C's rather than 2C's. `postingPolicyVersion: 1` on a document dated August means `resolvePolicy` is selecting by `max(policy_version)` instead of by `effectiveFrom <= effective_date`; that is a 1A defect and a finding against §4.3.1, not something to work around by re-dating the fixture.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/document-types/CONSIGNMENT_RETURN.v2.json tests/invariants/zero-code-document-type.test.ts
git commit -m "test(invariants): re-run test 15 on the inventory-bearing CONSIGNMENT_RETURN 2C deferred [3C T11]

A second POLICY VERSION of the same type, not a second type: the same code gains a stock effect through
configuration alone, on its own side of effectiveFrom, and still numbers, posts, prints, reports and
reverses. 2C deferred this because accounting.purchase.post is 3C's code (contracts 4.14, 2c:5202).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: OD-05 — the two ⚠️ rows this slice builds, and a foreign-currency shipment posted to the default

**Files:**
- Create: `packages/db/test/purchasing/foreign-currency-shipment.test.ts`
- Modify: `docs/adr/0041-landed-cost-allocation-and-purchase-return-valuation.md` (Status line only, when the answer arrives)
- Test: `packages/db/test/purchasing/foreign-currency-shipment.test.ts`

**Interfaces:**
- Consumes: `seedCurrency`, `seedRate` (0D, §4.17); `toBase`, `Money`, `currency`, `ExchangeRate` (§4.2.1); `allocateLandedCostForDocument`, `receiptValue` (Task 8); `SHIPMENT` (Task 9); `postDocument` (1A); `ensureOpenPeriods`, `recordingJobs` (3B).
- Produces: no interface. One isolated task, one suite, and one question.

**This is an isolated owner-gate task (§2.0, hazard 6). Dropping it renames nothing and unblocks nothing.** OD-05 asks the owner to confirm every ⚠️ row of spec §3.0.3 and §3.0.4; §2.12's default is "the spec text as written", and that is what Tasks 1–11 built. Two rows touch this slice.

| ⚠️ row | Spec | Built as | If the owner says no |
|---|---|---|---|
| **Landed cost** — "Imported goods carry freight, duty, clearance and handling that must be allocated across a shipment and into unit cost" | spec:1020 | `app.landed_cost_allocation` (0038), the three methods, `receiptValue`, `SHIPMENT`, the two routes — Tasks 7, 8, 9 | The whole of Tasks 7 and 9 and migration 0038 drop; **Task 8 does not** — `receiptValue`'s branch 3 collapses to `toBase(line.amount, rate)` and every receipt still needs a value (SAH-007), so `landed-cost.ts` keeps `receiptValue` and loses `allocateLandedCost`, `allocateLandedCostForDocument`, `listLandedCost` and `landedCostByLine`. Tasks 1–6, 10 and 11 are untouched. |
| **Purchase in foreign currency** — "Importing means supplier invoices in USD/AED/EUR against MYR books, with FX difference on settlement" | spec:1023 | No code of its own. The header carries `currency` + `exchange_rate` (Plan 0A), every ledger amount goes through `toBase` (hazard 23), the GRNI accrual stays in the **supplier's** currency and the layer is base — Tasks 6, 8, 9. The **settlement** FX difference is 4B's. | Nothing drops. A refusal would mean "we buy only in MYR", which the built path already covers as the `UNIT_RATE` case. The question worth asking is narrower and is below. |

- [ ] **Step 1: Write the owner question, verbatim, into the task tracker**

> **OD-05, rows "Landed cost" and "Purchase in foreign currency" (spec:1020, 1023).** We have built both to the spec text. Three specifics need a yes or no, because each changes a default rather than a feature:
> 1. **Which allocation method should a shipment default to** — by value, by quantity, or by weight? We currently make the operator choose per cost line and store nothing as a default.
> 2. **Must a shipment's freight be entered before the goods can be received?** Today it need not be: a shipment posts with the goods alone and the freight invoice, when it arrives late, is handled by reversing and re-posting (ADR 0041). The alternative is to block the post, which means goods sit unreceived until the forwarder invoices.
> 3. **When a supplier invoices in USD, is the amount owed re-stated at each month end?** We hold the accrual in USD at the receipt's rate; the revaluation and the settlement difference are Phase 4 work (4B). Confirm that Phase 3 need not revalue.
>
> **Verify (owner-account pattern, hazard 5):** the answers are recorded on this task and ADR 0041's Status line changes from *Proposed* to *Accepted* or a superseding ADR is opened. **Until provided:** the defaults above stand and the suite below pins them, so a later change is a visible diff rather than a silent drift.

- [ ] **Step 2: Write the test that pins the FX default `packages/db/test/purchasing/foreign-currency-shipment.test.ts`**

The point of this suite is not to prove `toBase` works — 0D's property tests do that. It is to pin, in one readable place, **what a USD shipment with USD freight does to a MYR book**, so the owner's answer to question 3 has something concrete to be a change to.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { allocateLandedCostForDocument, postDocument } from "../../src/index";
import { documentTypesLoader } from "../../src/seed/index";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { ensureOpenPeriods, recordingJobs } from "../../../../tests/invariants/support/post-inventory";
import {
  draftTypedDocument, grantCodes, seedCurrency, seedItem, seedParty, seedRate, seedTenantV2,
  seedWarehouse, startDb, withTenant, type Db, type Seed,
} from "../index";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "seed", "my");
const MYR = currency("MYR");
const USD = currency("USD");

let db: Db;
let s: Seed;
let partyId: string;
let warehouseId: string;

const ctx = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "3c-fx-test" });
const loaderCtx = (seed: Seed, only: string[]) => ({
  config: {
    tenantId: seed.tenant, only, packRoot: PACK_ROOT, tenantName: "fx",
    ownerEmail: "owner@example.invalid", companyCode: "HQ", companyName: "fx HQ",
    baseCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", fiscalYearStartMonth: 1, fiscalYear: 2026,
  },
  tenantId: seed.tenant, companyId: seed.company, systemPrincipalId: seed.system, packRoot: PACK_ROOT,
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "fx");
  await grantCodes(db, s, { codes: ["inventory.receipt.create", "inventory.receipt.post"] });
  await withTenant(db.migrator, s.tenant, s.system, (tx) => chartOfAccountsLoader.load(tx, loaderCtx(s, ["chart-of-accounts"])));
  await withTenant(db.migrator, s.tenant, s.system, (tx) => documentTypesLoader.load(tx, loaderCtx(s, ["document-types"])));
  await ensureOpenPeriods(db, s, 2026);
  await seedCurrency(db, s, { code: "USD" });
  // A plainly invented rate. No published or market figure appears anywhere in this repository.
  await seedRate(db, s, { from: "USD", to: "MYR", rate: "4.00000000", effectiveFrom: "2026-01-01", source: "manual:fixture" });
  partyId = await seedParty(db, s, { kind: "vendor", code: "FX-VEND" });
  warehouseId = await seedWarehouse(db, s, { code: "FX-WH" });
}, 300_000);
afterAll(async () => { await db.stop(); });

describe("OD-05 — a USD shipment against MYR books, at the built default (spec:1023)", () => {
  it("holds the GRNI accrual in USD and the cost layer in MYR, with base = round(value × rate, 4)", async () => {
    const [ty] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select id from app.document_type where company_id = ${s.company} and code = 'SHIPMENT'`);
    const [freight] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '5900'`);
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "FX-ITEM" });

    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId: ty!.id, series: "SHP", partyId, warehouseId,
      effectiveDate: "2026-04-10", currency: "USD", exchangeRate: "4.00000000",
      lines: [
        { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "8.000000", unitPrice: "125.0000", amount: "1000.0000" },
        { kind: "account", accountId: freight!.id, description: "ocean freight, USD", amount: "60.0000" },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), { documentId, allocations: [{ costLineId: lineIds[1]!, method: "by_value" }] }));
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }));

    // Every ledger amount is USD at rate 4, with base = value × 4 exactly (hazard 23; ledger_entry's CHECK).
    const entries = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<
      { code: string; currency: string; debit: string; credit: string; base_debit: string; base_credit: string }[]
    >`select a.code, e.currency, e.debit::text as debit, e.credit::text as credit,
             e.base_debit::text as base_debit, e.base_credit::text as base_credit
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${documentId} order by a.code, e.line_no`);
    // Ordered `by a.code, e.line_no`. BOTH debits land on `1300`: line 1 through `item.inventory_account`,
    // whose default IS `1300` (§4.6.1), and line 2 through the freight rule's `account: { code: "1300" }`.
    // Line 1 (the goods, 1000) therefore precedes line 2 (the freight, 60).
    expect(entries).toEqual([
      { code: "1300", currency: "USD", debit: "1000.0000", credit: "0.0000", base_debit: "4000.0000", base_credit: "0.0000" },
      { code: "1300", currency: "USD", debit: "60.0000", credit: "0.0000", base_debit: "240.0000", base_credit: "0.0000" },
      { code: "2150", currency: "USD", debit: "0.0000", credit: "1000.0000", base_debit: "0.0000", base_credit: "4000.0000" },
      { code: "5900", currency: "USD", debit: "0.0000", credit: "60.0000", base_debit: "0.0000", base_credit: "240.0000" },
    ]);

    // The layer is BASE currency (§4.7.3, 3B's A4): (1000 + 60) USD × 4 = 4240 MYR over 8 units.
    const [layer] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ unit_cost: string; value: string }[]>`
      select l.unit_cost::text as unit_cost, m.value::text as value
        from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
       where m.document_id = ${documentId}`);
    expect(layer).toEqual({ unit_cost: "530.0000", value: "4240.0000" });

    // The accrual the supplier will invoice against is 1000 USD, not 4000 MYR. That is the default OD-05
    // question 3 asks about: nothing in Phase 3 revalues it, and 4B is where the settlement difference posts.
    const [accrual] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ currency: string; total: string }[]>`
      select e.currency, sum(e.credit)::text as total from app.ledger_entry e
        join app.account a on a.id = e.account_id
       where e.document_id = ${documentId} and a.code = '2150' group by e.currency`);
    expect(accrual).toEqual({ currency: "USD", total: "1000.0000" });
  });

  it("the allocation itself is document currency, so the split is the supplier's arithmetic", async () => {
    const [ty] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select id from app.document_type where company_id = ${s.company} and code = 'SHIPMENT'`);
    const [freight] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '5900'`);
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "FX-ITEM-2" });
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId: ty!.id, series: "SHP", partyId, warehouseId,
      effectiveDate: "2026-04-11", currency: "USD", exchangeRate: "4.00000000",
      lines: [
        { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "3.000000", unitPrice: "1.0000", amount: "3.0000" },
        { kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "3.000000", unitPrice: "1.0000", amount: "3.0000" },
        { kind: "account", accountId: freight!.id, description: "handling, USD", amount: "1.0000" },
      ],
    });
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), { documentId, allocations: [{ costLineId: lineIds[2]!, method: "by_value" }] }));
    // 1.0000 USD over two equal weights → 0.5000 / 0.5000, in USD. Converting first and splitting in MYR
    // would give 2.0000 / 2.0000 and a supplier reconciliation nobody can follow.
    expect(rows.map((r) => r.allocatedAmount)).toEqual(["0.5000", "0.5000"]);
    const total = rows.reduce((acc, r) => acc.add(Money.of(r.allocatedAmount, USD)), Money.zero(USD));
    expect(total.toString()).toBe("1.0000");
    expect(MYR).not.toBe(USD);
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `cd packages/db && bun run test -- test/purchasing/foreign-currency-shipment.test.ts`
Expected: **PASS** (2 tests).

Two failures worth naming in advance. `ERR_MONEY_CURRENCY_MISMATCH` from `receiptValue` means the allocation was read as base rather than document currency — Task 8's `docCurrency` must be `snapshot.header.currency`. And a `base_debit` of `4000.0000` on the `1300` freight leg means the *goods* and *freight* legs were merged; each `account` line contributes its own row, and merging them would hide exactly the split this suite exists to show.

- [ ] **Step 4: Commit**

```bash
git add packages/db/test/purchasing/foreign-currency-shipment.test.ts
git commit -m "test(purchasing): pin the OD-05 landed-cost and foreign-currency defaults [3C T12]

A USD shipment holds its GRNI accrual in USD and its layer in MYR; the allocation splits in document
currency. No published or market rate appears anywhere — the fixture rate is manual:fixture (hazard 1's
discipline applied outside Phase 8). OD-05 questions recorded on the task; ADR 0041 stays Proposed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: OD-24 — the three purchasing screens (BLOCKED until the owner provides screenshots)

**Files:** none until the gate opens. On opening: `apps/desktop/src/screens/purchasing/{PurchaseOrder,GoodsReceipt,Shipment}.tsx`, `apps/desktop/test/screens/purchasing/*.test.tsx`.

**Interfaces:**
- Consumes: 0E's desktop shell, i18n harness and the `dir` switch; 2C's print route; the five sub-paths of Tasks 4 and 9; `LandedCostSummarySchema`, `OpenQuantitySchema`, `DocumentLinkSchema` (Tasks 4, 9).
- Produces: nothing until OD-24 is answered.

**This task is blocked, and the slice is not (hazard 29, §2.12 OD-24).** spec:79 and spec:108 say the UI is not specified; §2.12's entry is "screen task blocked, not the slice". Tasks 0–12 and 14 are green without a single component, because every capability is reachable through the five documented sub-paths — which is the point of the API-first split, not a consolation.

- [ ] **Step 1: Record the owner request, verbatim**

> **OD-24 (spec:2408).** Before we build the purchasing screens, please provide: **(a)** screenshots of the three Sahlisoft screens your staff use today for raising a purchase order, receiving goods against one, and entering an import shipment's freight and duty; **(b)** a two-minute description, from whoever does the job, of the order in which they type and what they tab between. Not a specification — the actual sequence, including the parts that are annoying.
>
> **Verify:** the description is attached to this task and the three screenshots are in `docs/ux/purchasing/`. **Until provided:** this task stays open and no component is written. Nothing else in slice 3C waits.

- [ ] **Step 2: Record what the three screens will be, so the request is answerable**

Named here and nowhere else, so a reviewer can see the shape being asked about without a workflow being invented for it:

| Screen | What it shows | The one thing that is not obvious from the API |
|---|---|---|
| **Purchase order** | party, warehouse, item lines with agreed price and quantity; a running total; **`open_quantity` per line once anything has been received against it** | An order stops at `issued` and never posts (Task 5), so the screen has an *Issue* action and no *Post* action — a Post button would be a bug the operator cannot recover from |
| **Goods receipt** | the open lines of one or more issued orders, quantity received per line defaulting to the open quantity, lot and expiry per line | Receiving is *link creation plus a draft*, which the operator experiences as one action; `ERR_DOC_LINK_OVER_FULFILLED` is the only refusal they can cause and its message already names both figures (Task 1) |
| **Import shipment** | goods lines, cost lines, and a **method selector per cost line** with the resulting per-line landed amount recomputed live from `GET …/landed-cost`'s `summary` | Allocation is draft-only (Task 7). After post the selector must be absent, not disabled-with-a-tooltip: the remedy is a reversal, and offering a control that cannot work invites the support call it looks like it prevents |

- [ ] **Step 3: The acceptance criteria the screens will be held to, fixed now**

Independent of what the screenshots show, so the answer cannot be read as licence to skip them (spec:2254; Global Constraint 2):

- **Keyboard parity:** every action reachable without a pointer, tab order follows the typing order the operator described, and `Enter` on the last line of a document adds a line rather than submitting.
- **Both text directions verified before merge:** each screen rendered `dir="ltr"` and `dir="rtl"` in `apps/desktop/test/screens/purchasing/*.test.tsx` with 0E's harness, and the numeric columns right-aligned in both — a quantity column that flips to the left in Arabic is the defect this check exists to catch.
- **No invented workflow:** every field on each screen maps to a `document`/`document_line` column or to one of the five sub-paths. A field that maps to neither is a change to this plan, not to a component.

- [ ] **Step 4: Do not commit anything**

There is nothing to commit. The task stays open with the request and the table above recorded on it. **Task 14's slice exit does not wait for it** — §2.12's default is explicit that the screen task, not the slice, is blocked.

---

### Task 14: Slice exit — the regression blocks, the probe assertion, the contracts round-3 finalisation and full CI

**Files:**
- Modify: `tests/regression/sah-005.test.ts`, `tests/regression/sah-017.test.ts`, `tests/regression/sah-049.test.ts`
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`
- Test: everything, at the repository root

**Interfaces:**
- Consumes: `sharedDb` (0B, §4.2.12) — reached **through** 3B's `costingContext(sah)` / `CostingFixture` (`tests/regression/support/costing.ts`, amendment A21(a)), which is what gives each regression file its own `seedTenantV2` tenant on the one shared container; `PROBES` (§4.2.7); the production `withTenant(sql, ctx, fn)` (hazard 15 — root `tests/` always uses it, never the 4-argument test helper); `recordingJobs`, `ensureOpenPeriods` (3B, `tests/invariants/support/post-inventory.ts`); `postDocument`, `allocateLandedCostForDocument`, `linkFulfilment`, `openQuantity` (Tasks 4, 8); `draftTypedDocument`, `seedAccount`, `seedItem`, `seedParty`, `grantCodes` (§4.17); everything Tasks 1–12 produced. **Not consumed: `thinRegression`** — it is a `describe`/`it` wrapper returning `void` (0b:5312–5326), not a fixture factory, and `sharedDb()`'s container must never be stopped by a file.
- Produces: the three appended regression blocks; the finalised §4.18 round-3 rows.

**§3.7.3's ownership rule decides which file this task appends to and which it must not create.** `sah-005` is **0D's** (its §2.1 card says "transactional enqueue"); `sah-017` is **3B's**, which executes before 3C (§6.3); `sah-049` is **1B's**. This slice **creates none** and appends a `— 3C` describe block to each, which is exactly what §3.7.3 prescribes for a slice that touches a defect another slice already owns.

**The shared preamble all three blocks use, and why it is not `thinRegression`.** 0B's helper is
`thinRegression(sah, heading, cites, body): void` — a `describe`/`it` wrapper that *invokes* its body inside a
running `it` (0b:5312–5326). It returns nothing, so `const { db, s } = await thinRegression("…")` neither
compiles nor yields a tenant, and `sharedDb()`'s `Db` is **one container for the whole `tests` run**
(§4.17.1) — calling `db.stop()` on it would break every regression file that runs after this one. The shape
these three blocks use is 3B's, for the same reason 3B chose it: a plain `describe` with the ` — 3C` suffix
§3.7.3 requires, over **`costingContext(sah)`** (`tests/regression/support/costing.ts`, 3B amendment
A21(a)), which hands out one `seedTenantV2` tenant per regression file on the shared container and never
stops it. `sah-005.test.ts` and `sah-017.test.ts` already carry `const ctx = costingContext("<sah>");` at
module scope from 3B's own blocks — **reuse it, do not declare a second one**; `sah-049.test.ts` is 1B's and
has none, so that block adds one.

- [ ] **Step 1: Append the `— 3C` block to `tests/regression/sah-005.test.ts`**

SAH-005 is "the dirty flag was set from three of four write paths, so a back-dated purchase mis-costed a month and nothing noticed". 3B appended the recost block; 3C's contribution is that the *landed cost* path is the fourth path, and it is not a path at all — the allocation commits with the draft and the recost enqueues on the posting `tx`.

Add to the file's existing import block (3B's block already imports `costingContext`, `recordingJobs`, `ensureOpenPeriods`, `describe`/`it`/`expect` and `withTenant`; these are the names only 3C's block needs):

```ts
import { allocateLandedCostForDocument, postDocument } from "@dulja/db";
import { draftTypedDocument, seedAccount, seedItem, seedParty, grantCodes } from "@dulja/db/test";
// CostingFixture is 3B's own type, exported beside costingContext (amendment A21(a)) — not a @dulja/db/test name.
import type { CostingFixture } from "./support/costing";
```

Then the block, with its one helper written out:

```ts
describe("SAH-005 — 3C: a back-dated SHIPMENT enqueues its recost on the posting transaction, or posts nothing", () => {
  const ctxOf = (s: { tenant: string; human: string }) =>
    ({ tenantId: s.tenant, actorId: s.human, requestId: "sah-005-3c" });

  /**
   * A posted September SHIPMENT, then a DRAFT August one carrying a freight line that has already been
   * allocated — the state Task 9's back-dated case reaches just before its post, with the post removed.
   * File-local because §4.17.1 gives 3C no shared helper and hazard 9 forbids inventing one.
   *
   * The September document has to be posted FIRST: step 14 enqueues `inventory.cost.replay` only when an
   * already-posted movement of the same item carries a LATER effective_date, so without it `jobs.enqueued`
   * is empty and the first case asserts nothing (Task 9's own comment says the same).
   */
  async function prepareBackDatedShipment(f: CostingFixture, code: string): Promise<{ documentId: string; costLineId: string }> {
    const { db, s, warehouse } = f;
    // `2150` is 3C's own account (Task 3) and `costingContext` does not seed it; `1300`, `5000` and `5900`
    // arrive with 3A's `seedItem`, which `ctx.inventory()` already called. `seedAccount` is idempotent on
    // (company_id, code), so this is safe even if a later fixture seeds it too.
    await seedAccount(db, s, { code: "2150", nameEn: "Goods received not invoiced", type: "liability" });
    // `costingContext` calls `grantCodes(db, s)` with NO codes, which creates an empty role — so the two
    // receipt codes have to be granted here or every post below is ERR_RBAC_FORBIDDEN at 2B's R2 trigger.
    await grantCodes(db, s, { codes: ["inventory.receipt.create", "inventory.receipt.post"] });
    const partyId = await seedParty(db, s, { kind: "vendor", code: "SAH005-VEND" });
    // The item code is a PARAMETER, so the two cases below never share a layer chain: each gets its own
    // September receipt and its own back-dated draft, and neither depends on the order Vitest runs them in.
    const { itemId, baseUnitId } = await seedItem(db, s, { code });

    const [shipmentType] = await withTenant(db.rw, ctxOf(s), (tx) => tx<{ id: string }[]>`
      select id from app.document_type where company_id = ${s.company} and code = 'SHIPMENT'`);
    const [freightAccount] = await withTenant(db.rw, ctxOf(s), (tx) => tx<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '5900'`);

    const later = await draftTypedDocument(db, s, {
      documentTypeId: shipmentType!.id, series: "SHP", partyId, warehouseId: warehouse, effectiveDate: "2026-09-01",
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId: warehouse, quantity: "10.000000", unitPrice: "10.0000", amount: "100.0000" }],
    });
    await withTenant(db.rw, ctxOf(s), (tx) =>
      postDocument(tx, ctxOf(s), { documentId: later.documentId, jobs: recordingJobs() }));

    const back = await draftTypedDocument(db, s, {
      documentTypeId: shipmentType!.id, series: "SHP", partyId, warehouseId: warehouse, effectiveDate: "2026-08-01",
      lines: [
        { kind: "item", itemId, unitId: baseUnitId, warehouseId: warehouse, quantity: "10.000000", unitPrice: "10.0000", amount: "100.0000" },
        { kind: "account", accountId: freightAccount!.id, description: "airfreight", amount: "50.0000" },
      ],
    });
    await withTenant(db.rw, ctxOf(s), (tx) =>
      allocateLandedCostForDocument(tx, ctxOf(s), {
        documentId: back.documentId, allocations: [{ costLineId: back.lineIds[1]!, method: "by_value" }],
      }));
    return { documentId: back.documentId, costLineId: back.lineIds[1]! };
  }

  it("a rolled-back post leaves no movement, no layer and no job effect — but keeps the allocation", async () => {
    const f = await ctx.inventory();
    await ensureOpenPeriods(f.db, f.s, 2026);
    const jobs = recordingJobs();
    const prepared = await prepareBackDatedShipment(f, "SAH005-SHP-A");

    await expect(
      withTenant(f.db.rw, ctxOf(f.s), async (tx) => {
        await postDocument(tx, ctxOf(f.s), { documentId: prepared.documentId, jobs });
        throw new Error("deliberate rollback");                    // after the post, inside the same tx
      }),
    ).rejects.toThrow("deliberate rollback");

    const [after] = await withTenant(f.db.rw, ctxOf(f.s), (tx) => tx<
      { movements: number; layers: number; allocations: number }[]
    >`select (select count(*)::int from app.inventory_movement where document_id = ${prepared.documentId}) as movements,
             (select count(*)::int from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
               where m.document_id = ${prepared.documentId}) as layers,
             (select count(*)::int from app.landed_cost_allocation where shipment_document_id = ${prepared.documentId}) as allocations`);
    // The allocation was committed BEFORE the post, on the draft, so it survives — that is correct and is the
    // whole reason allocation is draft-only. The movement and the layer do not.
    expect(after).toEqual({ movements: 0, layers: 0, allocations: 1 });
    // The enqueue is asserted on the RECORDER, not on `pgboss.job`: `recordingJobs` never reaches pg-boss, so
    // a `select count(*) from pgboss.job` would read zero whatever happened and prove nothing. What the roll
    // back has to demonstrate is that the recorder *did* see the enqueue during the transaction — so the
    // enqueue and the movements were on one `tx` — and that the movements are gone all the same.
    expect(jobs.enqueued.map((j) => j.name)).toEqual(["inventory.cost.replay"]);
  });

  it("and a caller that supplies no JobClient is refused rather than silently skipping the recost", async () => {
    const f = await ctx.inventory();
    await ensureOpenPeriods(f.db, f.s, 2026);
    const prepared = await prepareBackDatedShipment(f, "SAH005-SHP-B");
    await expect(
      withTenant(f.db.rw, ctxOf(f.s), (tx) =>
        postDocument(tx, ctxOf(f.s), { documentId: prepared.documentId })),
    ).rejects.toThrow(/is back-dated and needs a cost replay, but was posted through a caller that supplied no JobClient/);
  });
});
```

**Both cases share the memoised fixture and pass DIFFERENT item codes, which is what makes them order-independent.** `ctx.inventory()` returns one tenant per file, so the two cases share a company — and case 1 asserts `jobs.enqueued` is exactly `["inventory.cost.replay"]`, an absolute claim. Distinct items give each case its own layer chain and its own September receipt, so neither reading depends on which ran first (Vitest runs them in file order by default, but `--sequence.shuffle` exists and 3B's own regression files were reworked for exactly this reason, 3b:6802). `db.stop()` is **not** called: the container is `sharedDb()`'s and belongs to the whole `tests` run.

- [ ] **Step 2: Append the `— 3C` block to `tests/regression/sah-017.test.ts`**

SAH-017 is "order-delivery tracking double-adds on edit and never reverses on re-pointing". 3B created the file; 3C's block asserts the *structural* fix rather than a behaviour, because that is what makes it unrepeatable — and then adds the two behaviours a structure alone does not prove: re-pointing, and concurrency.

Add to the file's existing import block:

```ts
import { linkFulfilment, openQuantity } from "@dulja/db";
import { draftTypedDocument, seedItem, seedParty, grantCodes, type Db, type Seed } from "@dulja/db/test";
import type { CostingFixture } from "./support/costing";
```

```ts
describe("SAH-017 — 3C: open quantity is a view over links, and there is no counter to double-add", () => {
  const ctxOf = (s: { tenant: string; human: string }) =>
    ({ tenantId: s.tenant, actorId: s.human, requestId: "sah-017-3c" });

  /** An ISSUED 10-unit order of `f`'s own item, drafted and issued through the data layer. */
  async function issuedOrderOf(f: CostingFixture, code: string): Promise<{ documentId: string; lineId: string; itemId: string; baseUnitId: string; partyId: string }> {
    const { db, s } = f;
    await grantCodes(db, s, { codes: ["accounting.purchase.create", "inventory.receipt.create", "inventory.receipt.post"] });
    const partyId = await seedParty(db, s, { kind: "vendor", code: `${code}-VEND` });
    const { itemId, baseUnitId } = await seedItem(db, s, { code: `${code}-ITEM` });
    const [orderType] = await withTenant(db.rw, ctxOf(s), (tx) => tx<{ id: string }[]>`
      select id from app.document_type where company_id = ${s.company} and code = 'PURCHASE_ORDER'`);
    const order = await draftTypedDocument(db, s, {
      documentTypeId: orderType!.id, series: "PO", partyId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity: "10.000000", unitPrice: "1.0000", amount: "10.0000" }],
    });
    // Straight to `issued` with an UPDATE rather than through `transitionDocument`: this file is asserting
    // the link invariant, and an order's numbering path is Task 5's subject, tested there.
    await withTenant(db.rw, ctxOf(s), (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`);
    return { documentId: order.documentId, lineId: order.lineIds[0]!, itemId, baseUnitId, partyId };
  }

  /** A DRAFT 10-unit goods receipt of the same item, ready to be linked at any of the orders above. */
  async function draftReceipt(f: CostingFixture, o: { itemId: string; baseUnitId: string; partyId: string }): Promise<{ documentId: string; lineId: string }> {
    const { db, s, warehouse } = f;
    const [receiptType] = await withTenant(db.rw, ctxOf(s), (tx) => tx<{ id: string }[]>`
      select id from app.document_type where company_id = ${s.company} and code = 'GOODS_RECEIPT'`);
    const receipt = await draftTypedDocument(db, s, {
      documentTypeId: receiptType!.id, series: "GRN", partyId: o.partyId, warehouseId: warehouse,
      lines: [{ kind: "item", itemId: o.itemId, unitId: o.baseUnitId, warehouseId: warehouse, quantity: "10.000000" }],
    });
    return { documentId: receipt.documentId, lineId: receipt.lineIds[0]! };
  }

  /** `open_quantity` of one order line, as text. */
  async function openOf(db: Db, s: Seed, orderDocumentId: string): Promise<string> {
    const rows = await withTenant(db.rw, ctxOf(s), (tx) => openQuantity(tx, orderDocumentId));
    return rows[0]!.openQuantity;
  }

  /** Link `quantity` of a draft receipt against one order line. */
  async function linkTo(
    db: Db, s: Seed, order: { documentId: string; lineId: string }, receipt: { documentId: string; lineId: string }, quantity: string,
  ): Promise<void> {
    await withTenant(db.rw, ctxOf(s), (tx) => linkFulfilment(tx, ctxOf(s), {
      sourceDocumentId: order.documentId, targetDocumentId: receipt.documentId, linkKind: "receives_against",
      lines: [{ sourceLineId: order.lineId, targetLineId: receipt.lineId, quantity }],
    }));
  }

  it("no table in the schema carries a fulfilled, delivered or received quantity column", async () => {
    const { db } = await ctx.inventory();
    const columns = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app'
         and (column_name like '%fulfilled%' or column_name like '%delivered_quantity%'
              or column_name like '%received_quantity%' or column_name like '%returned_quantity%')
       order by 1, 2`;
    expect(columns).toEqual([]);
    // …and the one place the figure exists is a VIEW, so it cannot be written to at all.
    const [kind] = await db.admin<{ relkind: string }[]>`
      select relkind::text as relkind from pg_class where oid = 'app.document_open_quantity'::regclass`;
    expect(kind!.relkind).toBe("v");
    // The EXACT grant list. Plan 0A's default privileges (plan0A:2564) cover views too, so this passes only
    // because migration 0037 issues `revoke insert, update on app.document_open_quantity from app_rw`.
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'document_open_quantity' order by 1`;
    expect(grants.map((g) => g.privilege_type)).toEqual(["SELECT"]);
  });

  it("the guard takes an advisory lock on the source line BEFORE it sums, so the sum cannot be stale", async () => {
    const { db } = await ctx.inventory();
    // Structural, and deliberately so: an interleaved two-transaction race is not deterministically
    // reproducible in a test (you cannot await "the other transaction is now blocked"), while the ORDER of
    // the two statements inside the trigger is exactly what closes the window. This is the shape 3B uses for
    // sah-010, which asserts an ordering clause rather than trying to provoke the wrong answer.
    const [fn] = await db.admin<{ def: string }[]>`
      select pg_get_functiondef('app.assert_document_link_within_open_quantity()'::regprocedure) as def`;
    const def = fn!.def;
    const lockAt = def.indexOf("pg_advisory_xact_lock");
    const sumAt = def.indexOf("sum(x.quantity)");
    expect(lockAt).toBeGreaterThan(-1);
    expect(sumAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(sumAt);
    // The key is the SOURCE LINE, which is what the sum is over. A lock on the document, or on the tenant,
    // would either be too coarse (serialising unrelated lines) or too narrow to protect the sum.
    expect(def).toContain("'document_link:' || new.source_line_id::text");
  });

  it("a second transaction linking against the same line reads the FIRST one's committed sum and is refused", async () => {
    const f = await ctx.inventory();
    const order = await issuedOrderOf(f, "SAH017A");
    const r1 = await draftReceipt(f, order);
    const r2 = await draftReceipt(f, order);

    await linkTo(f.db, f.s, order, r1, "6.000000");
    // 6 + 6 = 12 against 10 ordered. The second transaction is a separate `withTenant`, so it sees the
    // first's COMMITTED row — which is the property the advisory lock guarantees for the interleaved case
    // too, because at READ COMMITTED the post-lock read takes a fresh snapshot (3a:68).
    await expect(linkTo(f.db, f.s, order, r2, "6.000000")).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
    expect(await openOf(f.db, f.s, order.documentId)).toBe("4.000000");
  });

  it("re-pointing a fulfilment releases the first order's quantity with no compensating write", async () => {
    const f = await ctx.inventory();
    // Two orders for the same item; one draft receipt linked to the first, then deleted and linked to the
    // second. In the legacy system the first order's counter stayed incremented forever.
    const first = await issuedOrderOf(f, "SAH017B");
    const second = await issuedOrderOf(f, "SAH017C");
    const receipt = await draftReceipt(f, first);

    await linkTo(f.db, f.s, first, receipt, "10.000000");
    expect(await openOf(f.db, f.s, first.documentId)).toBe("0.000000");

    await withTenant(f.db.rw, ctxOf(f.s), (tx) => tx`delete from app.document where id = ${receipt.documentId}`);
    expect(await openOf(f.db, f.s, first.documentId)).toBe("10.000000");     // released, by deletion alone

    const again = await draftReceipt(f, second);
    await linkTo(f.db, f.s, second, again, "10.000000");
    expect(await openOf(f.db, f.s, second.documentId)).toBe("0.000000");
    expect(await openOf(f.db, f.s, first.documentId)).toBe("10.000000");     // and never re-decremented
  });
});
```

`issuedOrderOf(f, "SAH017B")` and `issuedOrderOf(f, "SAH017C")` seed **different items**, which is what keeps the last case's two `openOf` readings independent: `openQuantity(tx, documentId)` is per document, so each order reports only its own line.

- [ ] **Step 3: Append the `— 3C` block to `tests/regression/sah-049.test.ts`**

SAH-049 is "an aggregate with no unique key duplicates under an upsert race and is then double-updated forever". 1B created this file with a `thinRegression` call; 3C appends a plain `describe` beside it and adds the preamble that file does not yet have (the placement 3B used at 3b:6251 and 2A at 2a:4664).

Add at the top of the file, beside 1B's existing import:

```ts
import { describe, expect, it } from "vitest";
import { allocateLandedCostForDocument, withTenant } from "@dulja/db";
import { draftTypedDocument, seedAccount, seedItem, seedParty, grantCodes } from "@dulja/db/test";
import { costingContext, type CostingFixture } from "./support/costing";

const ctx3c = costingContext("049-3c");
```

```ts
describe("SAH-049 — 3C: the allocation's upsert key survives a concurrent re-allocation", () => {
  const ctxOf = (s: { tenant: string; human: string }) =>
    ({ tenantId: s.tenant, actorId: s.human, requestId: "sah-049-3c" });

  /** A DRAFT shipment with two goods lines and one 300.0000 freight line. `costLineId` is that freight line. */
  async function draftShipmentWithFreight(f: CostingFixture): Promise<{ documentId: string; costLineId: string }> {
    const { db, s, warehouse } = f;
    await seedAccount(db, s, { code: "2150", nameEn: "Goods received not invoiced", type: "liability" });
    await grantCodes(db, s, { codes: ["inventory.receipt.create", "inventory.receipt.post"] });
    const partyId = await seedParty(db, s, { kind: "vendor", code: "SAH049-VEND" });
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "SAH049-ITEM" });
    const [shipmentType] = await withTenant(db.rw, ctxOf(s), (tx) => tx<{ id: string }[]>`
      select id from app.document_type where company_id = ${s.company} and code = 'SHIPMENT'`);
    const [freightAccount] = await withTenant(db.rw, ctxOf(s), (tx) => tx<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '5900'`);
    const draft = await draftTypedDocument(db, s, {
      documentTypeId: shipmentType!.id, series: "SHP", partyId, warehouseId: warehouse, effectiveDate: "2026-06-15",
      lines: [
        // 1000 : 1000 by value and 100 : 50 by quantity, so the two methods give DIFFERENT splits of the
        // same 300.0000 — which is what makes "one method across both rows" a real assertion below.
        { kind: "item", itemId, unitId: baseUnitId, warehouseId: warehouse, quantity: "100.000000", unitPrice: "10.0000", amount: "1000.0000" },
        { kind: "item", itemId, unitId: baseUnitId, warehouseId: warehouse, quantity: "50.000000", unitPrice: "20.0000", amount: "1000.0000" },
        { kind: "account", accountId: freightAccount!.id, description: "ocean freight", amount: "300.0000" },
      ],
    });
    return { documentId: draft.documentId, costLineId: draft.lineIds[2]! };
  }

  it("two transactions allocating the same shipment produce two rows, not four", async () => {
    const f = await ctx3c.inventory();
    const prepared = await draftShipmentWithFreight(f);
    const one = { costLineId: prepared.costLineId, method: "by_value" as const };
    const two = { costLineId: prepared.costLineId, method: "by_quantity" as const };

    // Both start before either commits. One wins the unique key and the other blocks on it, then updates —
    // which is what `on conflict … do update` under a real constraint does, and what SAH-049 lacked.
    const results = await Promise.allSettled([
      withTenant(f.db.rw, ctxOf(f.s), (tx) => allocateLandedCostForDocument(tx, ctxOf(f.s), { documentId: prepared.documentId, allocations: [one] })),
      withTenant(f.db.rw, ctxOf(f.s), (tx) => allocateLandedCostForDocument(tx, ctxOf(f.s), { documentId: prepared.documentId, allocations: [two] })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);

    const [rows] = await withTenant(f.db.rw, ctxOf(f.s), (tx) => tx<{ n: number; methods: number; total: string }[]>`
      select count(*)::int as n, count(distinct method)::int as methods, sum(allocated_amount)::text as total
        from app.landed_cost_allocation where shipment_document_id = ${prepared.documentId}`);
    // Two goods lines → two rows, whichever transaction won; one method across them; the total is the cost
    // line's own amount to the cent. Four rows, or two methods, is the defect.
    expect(rows).toMatchObject({ n: 2, methods: 1, total: "300.0000" });
  });
});
```

- [ ] **Step 4: Assert `PROBES` gained no key, and that this is correct**

Run: `bun run --cwd tests test -- invariants/tenant-isolation.test.ts && grep -c "path:" tests/invariants/probes.ts`
Expected: the harness **passes** and the probe count is **unchanged from before this slice**. All five of this slice's sub-paths hang off 1A's `documents` module, whose `RouteModule.path` already has a probe (§4.2.7, hazard 31). Add nothing. If the harness reports "no probe for …", a sub-path was registered on a new `RouteModule` — that is the §4.2.7 violation to fix, not a probe to add.

- [ ] **Step 5: Finalise the §4.18 round-3 rows for the corrections this plan made after Task 0**

Task 0 landed the amendment before Task 1. Four findings arrived later and belong in the same table, appended in the same shape (the `"submit"` stage, the money-string exception and §4.5.8's file are **not** here: they are needed from Task 4 onward, so they are in Task 0 Step 6 where an executor reads them before writing the first route):

```markdown
| 4.3.2, 4.3.4 | **A cost-derived ledger leg may only be paired with another cost-derived leg.** Step 6's `balanceInBase` runs before step 9 fills `LineSnapshot.cost`, so a `line.cost`/`line.amount` pair is refused with `ERR_LEDGER_UNBALANCED` on the first evaluation and never reaches 3B's re-evaluation (3b:3172–3180). A **receipt** policy is all `line.amount` with capitalised freight debiting `1300` from the cost line; an **issue** policy is all `line.cost`. Discovered writing 3C's `GOODS_RECEIPT`; the rule was already 3B's practice (3b:2556–2557 vs 2580–2581) and is now stated. Binds 3D and 4A | 3C | correction |
| 4.15 | `1300` gains a third resolver — the freight/duty/clearance debit of a receipt policy, as an `account: { code }` literal. `1300` stays **0C's**; 3C asserts it resolves (Task 3) and does not re-seed it | 3C | correction |
| 4.14 | `CONSIGNMENT_RETURN`'s inventory-bearing shape is **policy version 2 of the same code**, fixture `tests/fixtures/document-types/CONSIGNMENT_RETURN.v2.json`, `module` still `accounting`. No new §4.14 row, and the stronger reading of test 15: behaviour is configuration too | 3C | plan |
| 4.7.2 | `LandedCostError` (`"ERR_VALIDATION_FAILED" \| "ERR_NOT_FOUND"`), `allocateLandedCost`, `allocateLandedCostForDocument`, `listLandedCost`, `landedCostSummary`, `LandedCostSummaryRow`, `AllocationTarget`, `AllocationShare`, `LandedCostRow`, `LandedCostMethod`, `AllocateLandedCostInput` — the eleven names beside `receiptValue` and `landedCostByLine`. The error class is `CostingError`'s shape (3B A2a) and needs no new `asAppError` branch. **`landedCostSummary` is in `packages/db`, not in the handler**: `landedAmount` is `Money` arithmetic (Global Constraint 4) and a second reader of the same figure in `apps/api` is what SAH-009 is | 3C | plan |
```

- [ ] **Step 6: Run the whole thing**

```bash
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck
bun run --cwd packages/db test
bun run --cwd apps/api test
bun run --cwd tests test
bun run --cwd packages/db db:lint
```

Expected: every command exits 0. `lint:rules` covers `no-number-money`, `posting-only-tables`, `error-codes`, `permission-catalogue`, `role-seed`, `dependency-rule` and the `sql.unsafe` check (test 27) — the last is why no handler in this slice concatenates SQL and why `landed-cost.ts` uses tagged templates throughout.

- [ ] **Step 7: Walk the slice-exit checklist and tick it in the PR body**

| Exit criterion | Where it is green |
|---|---|
| **DoD clause** — "a landed-cost allocation changes unit cost and every downstream margin" | Task 9 Step 4 |
| Test 5 re-run (back-dated landed cost) | Task 9's back-dated case; Task 14 Step 1 |
| Test 7 re-run (supplier-return leg) | Task 10's tie-out case |
| Test 14 re-run (a real purchase-return type, one query) | Task 10 |
| Test 15 re-run (orders and the inventory-bearing consignment return as configuration) | Tasks 5 and 11 |
| Tests 12, 36 (two new tables, four new permission codes) | Tasks 1, 7, 2 |
| Test 13 (every write audited) | Tasks 1, 7 |
| Test 18 (negative stock refused by the data layer) | Task 10 |
| Test 27 (no SQL text) | Step 6's `lint:rules` |
| §3.0.4 row spec:1049 owned | Tasks 6, 9 |
| `lintSchema` zero violations; `up → down → up` byte-identical | Tasks 1, 7 Step 7 |
| `PROBES` unchanged; §3.5.4 DELETE list unchanged; `lint-schema.ts` unedited | Step 4; Tasks 1, 7 |
| OD-05 asked; OD-24 blocked, slice not | Tasks 12, 13 |

- [ ] **Step 8: Commit and open the PR**

```bash
git add tests/regression/sah-005.test.ts tests/regression/sah-017.test.ts tests/regression/sah-049.test.ts \
        docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
git commit -m "test(regression): append the 3C blocks and finalise the contracts round-3 rows [3C T14]

sah-005: a rolled-back back-dated post leaves no movement and no layer, keeps the draft's allocation,
and a caller with no JobClient is refused. sah-017: no fulfilled-quantity column exists anywhere, the one
figure is a SELECT-only view, the guard locks the source line before it sums, and re-pointing releases
with no compensating write. sah-049: a concurrent re-allocation yields two rows and one method, never
four. All three blocks are plain describes over 3B's costingContext, not thinRegression — that wrapper
returns void and sharedDb()'s container belongs to the whole run.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

**Against the writing-plans skill.** Fifteen tasks (0–14), each with exact file paths, a Consumes/Produces block whose signatures are copied from the contracts registry rather than paraphrased, bite-sized checkbox steps, a failing test run with its **exact** expected failure text before any implementation, and a commit. Every code step carries the real code — the full `CREATE TABLE`s with every column, constraint, composite FK, `enable_tenant_rls`/`attach_audit` call and matching down file; the real trigger bodies with their exact `raise exception` strings; the real TypeScript with imports; the real Zod, the real Hono routes, the real Vitest with the error strings asserted by regex. No "TBD", no "similar to Task N", no ellipsis standing in for content — including Task 14, whose six regression helpers were prose instructions to "copy it into this file" until the reviewer round below and are now written out. Two tasks (12, 13) are owner gates, each isolated and each stating precisely what changes if the owner decides otherwise.

**Three things I got wrong on the first pass and fixed, named because a reviewer should see them.**

1. **The `GOODS_RECEIPT` policy debited `line.cost`.** It cannot post: §4.3.2 step 6 runs `balanceInBase` **before** step 9 fills the cost, so a cost leg paired against a `line.amount` leg plans `0` against the full amount and is refused with `ERR_LEDGER_UNBALANCED` before `applyMovements` is ever reached. 3B had already solved this in practice — its receipt policy is `line.amount` on both legs (3b:2580–2581) and only its *issue* policy is cost/cost (3b:2556–2557) — but nothing had stated the rule. Task 6 is now four rules, all `line.amount`, with capitalised freight debiting `1300` from the cost line's own row; Task 0 Step 3's §4.3.4 paragraph states the rule; Task 14 Step 5 registers it. The `sum` over the inventory accounts still equals the layer to the cent, reached by addition.
2. **The DoD cases were dated June to September with no open period.** Plan 0A's `seedTenant` opens exactly one period (2026-01) and closes or locks the other two; every one of those cases would have died on `ERR_PERIOD_NOT_OPEN` before asserting anything. Task 9 Step 1 now adds `ensureOpenPeriods(db, s, 2026)` — 3B's helper — as the last line of the `beforeAll`, and says why.
3. **`landed_cost_allocation` had a `weight` column.** It is derived from `method` plus the target line's own `amount`/`quantity`/`weight_kg`, and storing a derived number beside the rows it derives from is precisely the SAH-017/018 shape this slice exists to close. Removed; the weight is returned by `allocateLandedCost` for display and by the route's `summary`, and nothing persists it. This also keeps the table exactly as Task 0's amendment registered it.

**Six further defects found on a second pass over the test code, all fixed above.** Each would have failed for a zero-context engineer at the step that claims *Expected: PASS*, and each is worth reading as a class of mistake rather than a typo.

4. **`StartedApi` has eight members and I had invented six.** §4.2.12 gives it `db`, `objectStore`, `app`, `tokenFor`, `signToken`, `loadPrincipals`, `request(input: ApiRequest)` and `stop` — no `typeId`, no `accountId`, no `loadSeedPack`, no `requestAs`, no `lastDocumentOf`, no `changedFilesInHead` — and `request` takes **one object**, not `(method, path, opts)`. Tasks 9 and 11 now use `api.request({ method, path, as, idempotencyKey, body })` throughout, with file-local lookups over `api.db` (1A's and 2B's pattern) and the loaders called directly. Hazard 9 is exactly this: a helper invented beside the register gives two slices two ways to do one thing, and here it would simply not have compiled.
5. **The back-dated case had nothing to adjust.** A back-dated *receipt* alone only rewrites layer unit costs; no COGS total moves, so `replay` posts no `COST_ADJUSTMENT` and `adjustmentsPosted.length > 0` fails. Task 9 now posts a September **issue** of 5 units before the August shipment, so the replay re-costs a real consumption from 50.0000 to 62.5000 — which is also what test 5's "adjustment is visible and explained" clause needs to point at.
6. **The DoD's AVCO figure was a rounding bet.** 10 units of 150 at 2300 is 153.3333…; the one assertion that carries the definition of done should not also test which decimal place the engine rounds at. Fifteen units gives 230.0000 exactly, against 200.0000 without the freight — a clean 30.0000 difference that *is* the clause.
7. **Task 7 read account `5900` before anything created it.** `seedTenantV2` creates only `1000` and `4000` (this plan's own Assumptions fact 3), and the `seedItem` call that seeds `5900` ran *inside* the helper that came after. The `beforeAll` now calls `seedAccount` for both tenants first.
8. **The test-18 override ran through `PURCHASE_RETURN`.** `postOverriddenIssue`'s options carry no `partyId`, and that policy's `requires: ["party", …]` refuses at step 4 with `ERR_POLICY_REQUIRES_MISSING` before `assert_stock_available` can fire. The refusal half stays on `PURCHASE_RETURN` (it is a genuine write path); the override half runs through `STOCK_ISSUE_TEST`, because test 18 is an assertion about the trigger, not about a type.
9. **Task 12's expected ledger rows were in the wrong order, for an instructive reason.** `item.inventory_account_id` defaults to `1300`, so a receipt's goods debit and its freight debit land on the *same* account and `order by a.code, e.line_no` puts the goods line first. I had assumed two different accounts. The comment now says why they coincide, which is the fact the "sum over the inventory accounts" wording elsewhere depends on.

**One promise the plan made and did not keep, now kept.** Three places said "Task 3 asserts `1300` resolves" and Task 3 did not. It now has that case, and it also asserts `3c-purchasing.json` does **not** contain `1300` — so the "assert, never re-seed" half of hazard 33 is checked mechanically rather than trusted. The Assumptions block's claim that `2150` is the only `account: { code }` literal was false once the freight rule existed and now names both.

**Where I deliberately did not follow the §2.4 card.** The card's prose calls the link quantity `linked_quantity`; §4.6.1's register — the DDL authority — names it `quantity`, and `linked_quantity` is the *view's* derived column. Resolved in favour of the register (hazard 32), recorded in Task 0's amendment. The card also expects `document_open_quantity` to be a "projection"; it is a `security_invoker` **view**, because §3.5.3 pre-declares no linter-set membership for it and hazard 13 forbids a slice adding one — a projection table would need `NO_ID_TABLES` and `AUDIT_EXEMPT` rows it does not have.

**Hazards, one line each.** 1 — no statutory figure anywhere; Task 12's only rate is `4.00000000` from `manual:fixture`, plainly invented and labelled. 2 — no MyInvois detail; `tax.applies` is `false` on all four types and the reason is written down (the input tax is claimed on 4A's invoice). 3 — no Firebird assumption; this slice reads no legacy data. 5 — Tasks 12 and 13 use the "owner provides X; verify with …; until provided …" pattern. 6 — one task per OD item. 7 — D1–D27 untouched; the two money-semantics decisions are an ADR **proposal** (0041) with the reversal cost stated. 8 — every Plan 0A name cited exactly. 9 — `fixtures.ts` gains `draftTypedDocument` and nothing else, appended, registered in Task 0 before use. 10 — the chart and all four document types are seed-pack data; only `app.permission` is migration data (0039). 11 — no enum label added. 13 — `lint-schema.ts` is not edited; both new tables are §3.5.3 dashes. 14 — migrations 0037–0039 and ADRs 0040–0041, no renumbering, no `max(version)` assertion. 15 — root `tests/` use the production `withTenant`; the DB tier uses the 4-argument test one. 17 — the negative excursion is `postOverriddenIssue` only. 21 — no `sql.unsafe`. 22 — every layer/movement write is inside `packages/db/src/costing/`. 23 — every base figure goes through `toBase`. 25 — no DELETE grant added; asserted. 26 — exactly the four §3.6.2 codes. 29 — Task 13 is blocked. 31 — no new `RouteModule`, no new `PROBES` key. 32, 33, 34 — see below. 35 — no placeholders.

**Contract additions** (every name invented because the contracts document lacked it; all registered in Task 0 or Task 14 Step 5 before use): `draftTypedDocument`, `DraftLine`, `DraftTypedDocumentOptions` (§4.17); `app.document_open_quantity` as a view (§4.6.1); `app.assert_document_link_within_open_quantity`, the trigger `document_link_open_quantity`, the indexes `document_link_line_pair_key` / `document_link_header_pair_key` / `document_link_source_line_idx` / `document_link_target_document_idx` (0037); `app.assert_landed_cost_allocation_draft`, the trigger `landed_cost_allocation_draft_only`, the indexes `landed_cost_allocation_document_idx` / `landed_cost_allocation_target_idx`, and `unique (cost_line_id, target_line_id)` (0038); `LinkKind`, `FulfilmentLineInput`, `LinkFulfilmentInput`, `DocumentLinkRow`, `OpenQuantityRow`, `linkFulfilment`, `listLinks`, `openQuantity` (§4.7.2's sibling seam, Task 4); `receiptValue`, `landedCostByLine`, `landedCostSummary`, `LandedCostSummaryRow`, `allocateLandedCost`, `allocateLandedCostForDocument`, `listLandedCost`, `LandedCostError`, `LandedCostMethod`, `AllocationTarget`, `AllocationShare`, `LandedCostRow`, `AllocateLandedCostInput` (§4.7.2, Tasks 8, 14); the two contracts modules and their eleven schema names (§4.2.8); the five `documents` sub-paths (§4.2.7); the four-branch receipt-value rule and the `reverseDocument` `l.cost` column (§4.7.2, §4.3.1); the cost/`line.amount` pairing rule (§4.3.4, §4.3.2); `1300`'s third resolver (§4.15); `CONSIGNMENT_RETURN.v2.json` as a policy version (§4.14); the **fourteen test-only document-type codes** `TYPED_TEST`, `TYPED_TEST_2`, `LINK_ORDER`, `LINK_RECEIPT`, `API_ORDER`, `API_RECEIPT` and the eight `LCA_*` (§4.14, Task 0 Step 6); the **four role grants** `accounting.purchase.create` → `accountant`/`user`, `accounting.purchase.post` → `accountant`, `inventory.receipt.create`/`.post` → `warehouse` (§3.6.4, Task 2 Step 5); `docs/ux/purchasing/` as the OD-24 destination. **One name is re-exported rather than added:** `chartOfAccountsLoader` is 0C's and stays 0C's; Task 9 Step 5 only makes it reachable through the `@dulja/db/seed` subpath that 0C already declares, which needs no §4.2.13 amendment because §4.2.13 already registers the loader as 0C's and every later slice consumes it unchanged.

**Reviewer round — twenty-two findings: nineteen applied, one applied with a correction to the finding itself, one rejected, and four further defects found while applying them.** The section above is what the *self*-review caught; these came from an external review of the finished plan and are fixed inline in the same way.

1. **Task 9's two routes declared absolute paths and mounted on an undefined `app`.** `documentRoutes` is already at `/v1/companies/:companyId/documents` (1a:5024), so `path: "/v1/companies/{companyId}/documents/{documentId}/landed-cost"` would have mounted one level down from where every case asks — Step 6's predicted 404 would have survived Step 8. Both paths are now `"/{documentId}/landed-cost"` and both register on `documentRoutes.openapi(...)`, as 2C's print route (2c:5018) and Task 4's three routes already do.
2. **Task 9's handlers used `c.var.tx` and called the gates as plain functions.** `AppEnv["Variables"]` is a registered seven-member set with **no `tx`** (§4.2.3: "a slice adding an eighth amends this block first"), and `requireDocumentPermission(stage)` is a `MiddlewareHandler<AppEnv>` — `await gate(c, { companyId, documentId })` passes an object where `Next` is required and would never call `next`. Both gates are now `middleware: [...] as const` on the route and the seam is `c.var.withTenant`, exactly as Task 4's handlers.
3. **`AppError` was constructed with an options object, in three places.** The frozen constructor is `(code, detail, extra?)` (§4.2.4), so `{ detail: … }` would have put an object in `detail`. Fixed, along with three import homes that contradicted Task 4 in the same plan: `AppError` from `@dulja/contracts`, `AppEnv` from `../context`, `requireDocumentModuleRead` from 2C's middleware file.
4. **The money schemas and the row types disagreed, which is a compile error and not a documentation nit.** `LandedCostAllocationSchema.allocatedAmount` and the three `LandedCostSummarySchema` money fields were `MoneySchema` (an object) while `LandedCostRow` and `LandedCostSummaryRow` are `string` and the route test asserts bare strings — and `RouteHandler` checks `c.json` against the declared schema. Resolved in the direction the design already implies: the four fields (and `DocumentLinkSchema.amount`, which had the same shape without saying so) are a 4-dp decimal string, and **Task 0 Step 5 now amends §4.2.8** with the exception and its two reasons — no currency column on `document_link`, and a path that already names the document. §4.2.8 requires the amendment before the exception, which is why it is in Task 0 and not in a comment.
5. **Task 10 called `valuationAsOf` with a non-existent `itemIds` and no `limit`.** 3B's `ValuationParams` is `{ companyId; asOf; itemId?; warehouseId?; cursor?; limit }` (3b:4475–4486); an excess property on an object literal and a missing required one are two TypeScript errors, so the suite could not compile. Now `{ companyId, asOf, itemId, limit: 100 }`.
6. **Task 4's price-from-source assertion was arithmetically impossible against its own helper.** `issuedOrder(quantity, unitPrice)` wrote `unitPrice` into **both** `unit_price` and `amount`, so `issuedOrder("100.000000", "500.0000")` gave a 500.0000 unit price and the copy produced `20000.0000` where the test expects `200.0000`. The helper now takes `amount` as a third argument — explicitly, because computing `quantity × unitPrice` in TypeScript would put a monetary value through a `number` — and all five call sites state all three figures. The same helper was economically wrong for every other call.
7. **The over-fulfilment guard was defeatable by concurrency alone — the exact defect 3A found in itself.** `sum(x.quantity)` under no lock, at READ COMMITTED (3a:68): two transactions each linking 6 against a 10-unit line both read `v_linked = 0`, both satisfy the test and both commit. 3A fixed the same class with `pg_advisory_xact_lock(hashtextextended(key, 0))` before the read (3a:5719–5727); migration 0037 now takes that lock on `'document_link:' || new.source_line_id`, `linkFulfilment` sorts its lines by `sourceLineId` so two multi-line links cannot deadlock, ADR 0040's Decision 3 says both, and Task 14's SAH-017 block gained two cases — one structural (the lock precedes the sum in `pg_get_functiondef`, the shape 3B uses for sah-010) and one two-transaction.
8. **Task 14 asserted the open-quantity view is SELECT-only, which 0037 did not make true.** Plan 0A's `alter default privileges … grant select, insert, update on tables to app_rw` (plan0A:2564) covers **views**, so the grant list was `["INSERT", "SELECT", "UPDATE"]` and Task 1's own case — which only asserted SELECT was *present* — concealed it. 0037 now issues `revoke insert, update on app.document_open_quantity from app_rw`, and both cases assert the exact list.
9. **Task 1's "refuses to delete an ISSUED source line" expected SQLSTATE 23503 and gets 23514.** 2B's `forbid_line_delete_unless_draft()` is a BEFORE DELETE trigger raising `ERR_DOC_NOT_DRAFT` with `errcode = 'check_violation'` whenever the parent is not a draft (2b:1874–1887), and it fires before any FK check. The case is retitled and asserts `/ERR_DOC_NOT_DRAFT/`; the DDL comment already knew this ("an issued order cannot be deleted anyway"), and the finding's alternative — pinning the FK against a *draft* source — is unreachable, because the 0037 guard refuses a link whose source is not issued or posted.
10. **Task 11 posted through `POST …/documents/{id}/post`, which does not exist.** 1A's `documentRoutes` declares four paths and `…/post` is none of them (1a:4768–4876); §4.5.4 makes `to = "posted"` on `…/transitions` the thing that calls `postDocument`, and 2C's own test-15 file posts that way (2c:5441). The case now uses `/transitions` with `{ to: "posted" }`, asserts `status`/`series` off `TransitionResultSchema`, and reads the pinned policy version from `app.document.posting_policy_id` — there is no `postingPolicyVersion` member on any declared schema.
11. **Task 9's route test called `problemOf` on a parsed body and never awaited it.** `problemOf(res): Promise<Problem>` takes the `Response` (§4.17.1), so all five assertions compared `undefined`. Fixed to `(await problemOf(res)).code`, as Task 4's suite already does.
12. **Task 10's layer-residue assertion had the wrong scale.** `numeric(19,6) × numeric(19,4)` has scale 10 in PostgreSQL and `sum()` keeps it, so `::text` yields `"210.0000000000"`. Now `round(…, 4)::text` against `"210.0000"` — the rounding `valuationAsOf` itself applies per layer (3b:1106), which is what makes the two readers agree.
13. **Task 6 committed a deliberately red suite, against this plan's own Global Constraint 16.** Split instead: Task 6 lands the seed file and the one envelope case (green on disk alone), and **Task 8 Step 7** appends the four posting cases *and the `beforeAll` they need* in the commit that makes them pass. Applying that fix exposed the same defect in **Task 5** (two of its five cases needed Task 6's seed file) and a second-order one: leaving Task 6's full import block beside one case would fail `bun run lint` on unused imports. Both are fixed — Task 5 lands three cases and Task 6 Step 5 appends the other two, and each file's imports arrive with the cases that use them. The Execution handoff no longer carries a "land three tasks as one PR" escape hatch, because there is nothing to escape.
14. **Five of Task 14's helpers existed only as prose instructions to copy code from elsewhere** — the one "similar to Task N" pattern in an otherwise fully-coded plan. All are written out, and writing them exposed the real defect underneath: the three blocks called `await thinRegression("…")` destructuring `{ db, s }` and then `db.stop()`. `thinRegression(sah, heading, cites, body)` returns **`void`** and invokes its body inside a running `it` (0b:5312–5326), and `sharedDb()`'s container is **one for the whole `tests` run** — stopping it would break every regression file after this one. All three blocks are now plain `describe`s over 3B's **`costingContext(sah)`** (amendment A21(a)), which is the shape 3B chose for exactly this reason, and none of them stops the container.
15. **The §4.7.2 entry said three branches; the code lands four.** Task 0 Step 4, the §4.18 row, Task 8's prose and heading, the File Structure line and Task 8's commit body all now say four and name branch 4 as the explicit `null` that makes the engine raise `ERR_COST_VALUE_MISSING` (SAH-007).
16. **Five `Expected: PASS (n)` counts did not match the `it` blocks written**, and an executing engineer treats them as the pass criterion. Recounted from the blocks, not adjusted by eye, and then recounted again after findings 13 and 14 moved cases between files: 13 (`document-link`), 5 (`chart-of-accounts-3c`), 11 (`landed-cost-allocation`), 10 (Task 8's `landed-cost`), 16 (after Task 9's six), 1 then 5 (`goods-receipt`), 3 then 5 (`purchase-order`).
17. **Three smaller ones.** `permissions.ts` was drawn under `packages/contracts/src/` in the File Structure block while Task 2's own Files list had it right — §3.6.1 fixes it at `packages/contracts/permissions.ts` (spec:2135), and the diagram is what an engineer scans first. `packages/contracts/src/inventory/landed-cost.ts` imported `z` from `"zod"` and then called `.openapi(…)`, which exists only on `@hono/zod-openapi`'s re-export — the same package's `accounting/document-link.ts` had it right. And `listLandedCost` cast `created_at::text`, which is `2026-01-15 10:00:00+00` and fails `TimestampSchema`'s RFC 3339; both readers now leave the column uncast, type it `Date` and call `.toISOString()`, so the same field is read the same way in both files.
18. **Task 9's route test resolved the seed pack from a cwd-relative path.** §4.2.13's `packRoot` promises nothing about a working directory and Vitest runs that suite from `apps/api`, so `beforeAll` would have raised ENOENT before any case ran. Built absolutely from `import.meta.url`, as every `packages/db` suite in this plan does.
19. **Task 1's test imported `uuidv7` and never used it** (a `bun run lint` failure under the unused-import rule) **and called `seedDocumentType` before a sentence *after* the code block added the import** — which an engineer pasting the block does not see until the file fails to compile. The import block is now exactly what the file uses, and the sentence explains why `uuidv7` is absent.

**Applied with a correction to the finding.** Finding 3 said `requireDocumentModuleRead` lives in `apps/api/src/routes/accounting/attachments.ts`, citing §4.5.8, and that Task 4 had it right. Neither half holds: 2C's merged plan puts `MODULE_READ_CODE` and all three of its consumers in **`apps/api/src/middleware/require-attachment-read.ts`** and says why (2c:1794, 2c:4591 "the same file — one map, one home"), and 2C's own callers import from there (2c:2144, 2c:5013). Task 4 was wrong too, in the other direction. Both tasks now import 2C's actual file, and Task 0 Step 6 corrects §4.5.8's prose — a frozen plan is the authority for what is on disk.

**Rejected, with the line that settles it.** Finding 22 says Task 1 Step 9 overstates the reversibility proof because `schemaFingerprint` "hashes neither functions nor views". It hashes both. Plan 0A's implementation is seven catalog queries, and two of them cover exactly those objects: `select p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef from pg_proc p where p.pronamespace = 'app'::regnamespace` (plan0A:2452) is the function half, and `information_schema.columns where table_schema = 'app'` (plan0A:2447) includes **view** columns as well as table columns. §3.4.6's 0B extension adds enum labels and `app_rw` grants on top of that, it does not replace it. The step's sentence stands as written.

**Five further defects found while applying the above, all fixed.**
20. **`requireDocumentPermission("create")` on a sub-path 404s every request.** 2A's `"create"` branch resolves the type from `body.documentTypeCode` + `body.effectiveDate` and raises `ERR_NOT_FOUND` when either is absent (2a:2897–2906) — it is written for `POST …/documents`, where no document exists yet. All five of this slice's sub-paths name the document in the **path**, so every case in Tasks 4 and 9 would have failed on the gate, before the handler. The stage is now **`"submit"`**, which §4.5.4 maps to the same code (`approval.create ?? approval.post`, 2a:2867–2871) but resolves it off `:documentId` (2a:2909–2915). Registered in Task 0 Step 6, because 3D's `…/links` and `…/count-sheet` and 4A's allocation sub-paths would each rediscover it.
21. **Both route suites imported `tests/support/api` four levels up from `apps/api/test/routes/accounting/`, which is five.** 2A's route suites at the same depth use five (2a:3253); 2C's comment says "five levels up" and then writes four (2c:4621–4624), which is where the miscount came from. Fixed in both files.
22. **`costingContext` grants nothing.** It calls `grantCodes(db, s)` with no `codes`, and 2B's helper inserts a role with no `role_permission` rows when the list is empty (2b:1035) — so every post in Task 14's blocks would have been refused by 2B's R2 trigger. Each helper now grants the codes its own documents need.
23. **`resolvePolicy` was called with a document, and it takes a document type and a date.** §4.3.1 and 1a:2057 fix it as `resolvePolicy(tx, documentTypeId, effectiveDate): Promise<{ policyId; definition }>` — three positional arguments — while Task 9's handler wrote `resolvePolicy(tx, { documentId })`, which is both the wrong arity and the wrong argument, and a "failures worth naming" line described the return as `{ id, version, definition }`. The handler now reads `document_type_id` and `effective_date` from the header first, as 2A's middleware does (2a:2909–2915), which also makes the resolution correct rather than merely compiling: a shipment must be allocated under the policy version it will *post* under, not under today's.
24. **`prepareBackDatedShipment` had to seed `2150` itself.** `costingContext`'s `inventory()` seeds `1300`, `5000` and `5900` through 3A's `seedItem` and loads every document type from the pack, but `2150` is 3C's own account (Task 3) and no regression fixture creates it — the `SHIPMENT` policy's credit leg would not resolve. `seedAccount` is idempotent on `(company_id, code)`, so the helper seeds it unconditionally.

**Second reviewer round — an independent audit against the contracts document, plan 0A and the spec. Ten findings: nine applied whole, one (finding 26 below) applied in the corrected form because half of the fix it proposed was aimed at a route that did not have the defect. Two further defects were found while applying them and are fixed too. Numbered 25–33 here because 33 bundles the audit's three register omissions, which share one cause.**

25. **Two cross-tenant cases asserted SQLSTATE 23503 and would have got 23514 — the same class as finding 9, missed twice.** Task 1's "tenant B cannot point a link at A's rows" and Task 7's "B cannot point an allocation at A's rows" both ended `.rejects.toMatchObject({ code: "23503" })` on the theory that the composite FK refuses first. It does not. PostgreSQL runs **BEFORE ROW triggers before referential integrity** (an FK is an AFTER-row RI trigger), so 0037's `assert_document_link_within_open_quantity()` reads A's document under B's RLS, sees nothing, and raises `ERR_DOC_STATUS_ILLEGAL: source document … is not visible` at `check_violation`; 0038's `assert_landed_cost_allocation_draft()` does the same with `ERR_NOT_FOUND: document … is not visible`. Both cases now assert the token the trigger actually raises, and both comments say that the **guard** is the first refusal and the composite FK is the belt underneath it — which is the stronger property anyway, and is unreachable for any cross-tenant document id. A genuine 23503 case would need an insert whose every trigger clause passes and only the FK fails; no such insert exists here.
26. **Three Task 9 route cases asserted 422 for `ERR_VALIDATION_FAILED`, whose registry status is 400.** §4.2.4 fixes that code at **400** ("Zod body/query failure") and `AppError` takes its status from `ERRORS[code].status`, so the "policy does not receive stock" refusal, the unknown-method Zod failure and the `by_weight`-without-`weight_kg` refusal all return 400. Task 4's own suite was already consistent with the registry (400 for `ERR_IDEMPOTENCY_KEY_MISSING`, 422 only for `ERR_DOC_LINK_OVER_FULFILLED`, which §4.2.4 does allocate at 422). All three now assert 400. **The finding's second half is half right and is applied in the corrected form:** `allocateLandedCostRoute.responses` did declare a 422 no code on that path can produce, and it now declares **400** instead — plus **409**, because migration 0038's draft-only trigger raises `ERR_DOC_NOT_DRAFT` and that has to be able to reach the client. `listLandedCostRoute.responses`, which the finding also named, never carried a 422: it is `200/403/404` and is unchanged.
27. **Making that 409 true exposed a real hole: the landed-cost handlers swallowed database tokens.** Both `catch` blocks translated `LandedCostError` and then `throw error`, so 0038's draft-only refusal — an ordinary user error — would have left `packages/db` as a raw postgres error and reached the client as an unmapped `ERR_INTERNAL` 500. The file now carries Task 4's `asAppError` verbatim (`fromDatabaseError` for anything that is not a `ERR_*: ` token) and both handlers end `throw asAppError(error)`. `fromDatabaseError` is added to the `@dulja/contracts` import and to Task 9's Consumes block. **And the branch is tested, because a declared response with no case behind it is what Global Constraint 2 forbids:** Step 5 gains an eighth route case that drives a shipment to `issued` through `app_rw` — Tasks 1 and 7's pattern — POSTs the allocation and asserts `409` / `ERR_DOC_NOT_DRAFT`; Step 10's expected count is 8, and its "failures worth naming" list leads with the 500 that means `asAppError` was skipped.
28. **Task 9's handler imported `IdempotencyHeader` from `@dulja/contracts`, which does not export it.** 0B Task 11 defines it once in **`apps/api/src/routes/index.ts`**, 2C imports it as `from "../index"`, and this plan's **own Task 4** already imports it correctly as `from "../routes/index"` — so the two handler files in one slice disagreed and the newer one did not compile. Moved to its own import line, and Step 8's "rules this file obeys" paragraph is now five rules rather than four, with the import home stated as rule 5.
29. **Task 9's route suite imported `chartOfAccountsLoader` from `@dulja/db/seed`, which 0C's barrel does not re-export.** 0C's `packages/db/src/seed/index.ts` re-exports `SeedError`, `SUB_PACKS`, `SeedConfig`, `ConfigError`, `parseSeedArgs`, `assertPackShape`, `PHASE_0_SUB_PACK_DIRECTORIES`, `readPackFile`, `seed` and the auth-admin names (0c:2492ff, 0c:3508ff); `chartOfAccountsLoader` it only *imports*, to populate the private `LOADERS` map (0c:3813). This slice's `packages/db` suites hide the gap by importing `../../src/seed/chart-of-accounts` directly; a suite in `apps/api` cannot, so its `beforeAll` would have thrown and every case in the file errored before running. Closed the way **1A closed the identical gap for `documentTypesLoader`** (1a:5356): one line, `export { chartOfAccountsLoader } from "./chart-of-accounts";`, added to the seed barrel — never the main barrel, which §3.1 and 0C's `sah-039` regression keep free of `./seed` at any depth. `packages/db/src/seed/index.ts` is now in Task 9's Files list, its commit and the File Structure block. **Seeding the accounts with `seedAccount` instead was the other option and was rejected**: the suite needs the whole `0c-base.json` chart plus `3c-purchasing.json` for the policies it validates, and hand-listing them would put a second, drifting copy of the chart in a test.
30. **Fourteen document-type codes were configured without a §4.14 row, on a misreading of that section's own paragraph.** The plan argued they were "the shape §4.14's 'test only' paragraph permits" because none reaches a seed pack. That paragraph says the reverse: its rows "are registered here because hazard 32 makes an unregistered document-type code a review-blocking finding, **not** because they are packaged". 2A, 2B, 3A and 8B each registered their file-local codes on that rule. **Task 0 Step 6 now adds all fourteen** as four grouped rows (the shape 2B used for `NG_NG`/`NG_RC`/`NG_HT`), amends §4.14's count sentence from thirteen to twenty-seven, adds a §4.18 round-3 row, and records that hazard 33 does not engage because every one of the fourteen policies is `lines: []`. The Assumptions block's "seeds no new test-only code" and the namespace paragraph above, both of which repeated the misreading — and the latter of which listed only six of the fourteen — are corrected.
31. **The phase gate told the executor to run a suite this plan itself says is red.** `bun run --cwd packages/db test -- test/costing` reads as a green check, but 3B's own Task 7 receipt case (3b:2736) fails from the moment 3B merges — `planMovements` returns `value: null`, `costReceipt` refuses a null — and Task 8 Step 9 says so outright. An executor seeing red there would conclude 3B had not merged. The gate now names the inheritance and says a *green* `test/costing` is itself a signal to stop. **It deliberately does not name a failure count.** The first rewrite said "red in exactly one place"; that is an assertion about 3B's fixtures, and how many of its replay, valuation and reversal cases build a layer by posting a receipt is 3B's business, not something this plan can pin without opening it. The discriminator is the **error code** — every inherited failure carries `ERR_COST_VALUE_MISSING` — which is robust whatever the count turns out to be. The "every task's commit is green" paragraph and **Global Constraint 16** are qualified the same way, and both now state the alternative — move Task 8 Steps 4–6 ahead of Task 1 — for a reader who wants zero red at every commit.
32. **Task 8 Step 6's fallback export list said "seven names" and omitted `landedCostSummary`.** It miscounted (six values plus four types) and left off both `landedCostSummary` and `LandedCostSummaryRow` — which Task 9's handler imports from `@dulja/db` and returns as the `summary` half of both responses, so an engineer taking the named-re-export branch would break Task 9 two tasks later. Rewritten as all thirteen names, written out as real `export` / `export type` statements, with the reason `landedCostSummary` is not optional stated.
33. **Two register omissions.** The File Structure block had no `posting/` entry at all, although Task 8's Files list and the §4.18 row both carry `packages/db/src/posting/reverse.ts` — the same class as finding 17's `permissions.ts`; it is now drawn, with `seed/index.ts` beside it. And §3.6.4's grant-register sentence was never amended with this slice's four grants, though Task 2's prose derives them correctly from spec:2159 — §3.6.4 requires the row "in the same PR", so **Task 2 Step 5** now writes the sentence and a §4.18 row, and the contracts document is in Task 2's Files list and commit. Also applied: the Execution handoff's ordering constraint 2 omitted **Task 4**, whose `API_ORDER` / `API_RECEIPT` policies name three of the four new permission codes through `seedDocumentType` → `parsePolicy`; it now reads "Tasks 4, 5, 6, 9, 10" and says why Task 4 is easy to miss.

**Namespaces, checked mechanically.** Document-type codes: four seeded (`PURCHASE_ORDER`, `SHIPMENT`, `GOODS_RECEIPT`, `PURCHASE_RETURN`), all §4.14 rows; two reused test-only codes (`STOCK_ISSUE_TEST` 3A's, `CONSIGNMENT_RETURN` 2C's) under amendment A14's rule that the policy is not part of the registration; and **fourteen file-local test types, every one of them a §4.14 `test only` row added by Task 0 Step 6** — `TYPED_TEST`, `TYPED_TEST_2` (T0), `LINK_ORDER`, `LINK_RECEIPT` (T1), `API_ORDER`, `API_RECEIPT` (T4), and `LCA_SHIP`, `LCA_ZERO`, `LCA_BAD`, `LCA_ISSUED`, `LCA_CROSS`, `LCA_CASCADE`, `LCA_ISO`, `LCA_AUDIT` (T7). **The first draft of this plan argued they needed no row because none reaches a seed pack; that reading is wrong and the reviewer round below records it.** §4.14's "test only" paragraph says the opposite — its rows exist *because* hazard 32 makes an unregistered code review-blocking, and "never packaged" is what the mark records rather than what excuses it — and 2A, 2B, 3A and 8B all registered their file-local codes. Hazard 33 does not engage on any of the fourteen: every policy is `lines: []`. Account codes: **seeds three** (`2150`, `1310`, `5100`); **names two by literal in a policy** (`2150` seeded here, `1300` 0C's — hazard 33 satisfied by Task 3 asserting it resolves); consumes `2100`, `5000`, `5900`, `5920` through refs or tests. Report codes and `DatasetId`: **none** — §4.16.1 gives 3C no row and hazard 4 is satisfied for Phase 3 by 3D. `ERR_*`: exactly one added (`ERR_DOC_LINK_OVER_FULFILLED`, already allocated to 3C in §4.2.4), in the same commit as the migration that raises it.

## Spec questions

Four, none of which blocks a task. Each is a question about the *contracts document or the spec*, not about this slice's behaviour, and each has a stated default that the tests pin.

1. **Does a zero-amount planned ledger line ever reach `ledger_entry`?** Task 6's free-of-charge case asserts the *aggregate* rather than the row count, because whether a `0/0` row survives depends on where 3B's body drops it and `ledger_entry` has no "not both zero" CHECK (plan0A:2012–2013). Either behaviour is correct for this slice; the question is whether §4.3.2 step 6 should say so, so 3D's `STOCK_COUNT` (whose variance lines are frequently zero) does not have to re-decide it. **Default:** assert aggregates, never row counts, in any test over a policy that can plan a zero.
2. **Should `requires` gain a member meaning "has at least one line of kind X"?** A `SHIPMENT` with no cost line is currently legal, and Task 12 asks the owner whether that matches the business. If the answer is no, the enforcement has nowhere to live: §4.4.1's `requires` enum is closed and a route-level check would not bind a job or an `app_rw` write. **Default:** legal, and the remedy for a late freight invoice is a reversal (ADR 0041).
3. **Is `line.total_excl_tax` intended as a synonym for `line.amount`, and should one be removed?** §4.4.1's note says they are the same column, two spellings, deliberately. Every policy this slice seeds uses `line.amount`. The question is whether the drift guard should refuse the synonym in a *seeded* file while permitting it in a tenant's own policy. **Default:** both accepted; this slice writes only `line.amount`.
4. **Which slice owns the "goods received not invoiced" ageing view?** `2150` accumulates from Task 6 onward and is cleared by 4A's `PURCHASE_INVOICE`; nothing reports its open balance by supplier and age. §4.16.1 gives the code to no one. **Default:** none built here — 4B's ageing work is the natural home, and this note is the pointer.

## Execution handoff

**Read before starting.** Contracts §2.4's 3C card, all of §3, §4.1, §4.2, §4.3.1–§4.3.7, §4.4.1–§4.4.2 (including the sign-normalisation section), §4.5.1–§4.5.8, §4.6.1, §4.7 in full, §4.14, §4.15, §4.17, **all of §4.18** and §5. Then the Produces blocks of 0B, 0D, 0C, 0E, 1A, 1B, 2A, 2B, 2C, 3A and 3B. Then spec §0.2, §3.0.3 (Landed cost, Purchase in foreign currency), §3.0.4 rows 1049–1055, §3.3, §3.4 in full, §3.9, Part V's Phase 3 row and Part VI tests 5, 7, 12, 13, 14, 15, 18, 27, 36.

**Phase gate — and it is NOT a green check.** Do not start until **3B** is merged and Phase 2's definition of done is green in CI. 3B is a hard gate: this slice's DoD clause is about `cost_layer.unit_cost`, and before 3B there are no layers. Verify the merge with `git log --oneline --grep "\[3B T" | wc -l` (expect 13 or more).

Then run `bun run --cwd packages/db test -- test/costing` and **expect it to be RED, and read the failures rather than the count before concluding anything.** 3A's `planMovements` returns every movement with `value: null` (3a:4930), 3B deleted 3A's provisional value helper and passes `movement.value` straight through for a receipt (3b:2990), and 3B's `costReceipt` raises `ERR_COST_VALUE_MISSING` on a null (3b:994). So **no receipt can post anywhere in the system between 3B and this slice's Task 8** — 3B's own Task 7 case that posts a receipt and expects `value: "1000.0000"` (3b:2736) fails from the moment 3B merges, and so does every case downstream of it that needed the layer a receipt creates. **That is inherited, expected, and closed by Task 8 Step 4**, where the receipt-value site is written; Task 8 Step 9 re-runs `test/costing` and is the commit that turns it green.

**The discriminator is the error code, not the number of failures**, because how many cases build their fixtures by posting a receipt is 3B's business and not something this plan should pin: **every inherited failure carries `ERR_COST_VALUE_MISSING`** (or fails an assertion in a case whose own `beforeAll` raised it). **A failure carrying any other code, or a green `test/costing`, is not 3B's inheritance — stop and find out what is on this branch before starting Task 0.**

**Order, and the three places it is not free.** Tasks in numeric order, one PR per task. Three constraints override convenience:
1. **Task 0 before Task 1.** Nothing may reference a name the amendment has not landed (hazard 32, hazard 9).
2. **Task 2 before Tasks 4, 5, 6, 9, 10.** Each of those configures a policy naming one of the four permission codes, and `validatePolicy` fails with `ERR_POLICY_INVALID` on a code absent from the catalogue (F-21). **Task 4 is on this list and is easy to miss** because its two policies are not seed-pack files: its route suite configures `API_ORDER` with `post: "accounting.purchase.create"` and `API_RECEIPT` with `post: "inventory.receipt.post"` / `create: "inventory.receipt.create"` through `seedDocumentType`, which calls `parsePolicy`, so the same dependency binds it. Harmless while the tasks run in numeric order — which is the default — but this note is what an executor reads when deciding whether an order is free, so it has to be complete.
3. **Task 3 before Task 6.** `2150` must resolve before the policy that names it is seeded (hazard 33), and Task 3 also asserts `1300` resolves — 0C's account, which Task 6's third rule names by literal.

**Every task's commit adds no new red, and two tasks are split for that reason alone — but ONE red is inherited and stands until Task 8.** `planMovements` returns `value: null` and 3B's `costReceipt` refuses a null, so **no receipt can post anywhere in the system** between 3B and this slice's **Task 8** (§4.7.2). Two consequences, and they are different:

- **This slice lands no red case of its own.** Every case that needs a receipt to post is written in the task whose code makes it pass, rather than landed red and left. Task 5 and Task 6 are split for exactly that (below).
- **3B's receipt cases in `packages/db/test/costing` are already red when this slice starts, and there is nothing Tasks 0–7 can do about them.** They are 3B's file, they fail on 3B's merge, and **Task 8 Step 4 is the fix**. So the honest statement of Global Constraint 16 for this slice is: `bun run lint`, `lint:rules`, `format:check` and `typecheck` are green after every task, and `bun run test` at the repository root is green after every task **except for the inherited `test/costing` failures — every one of which carries `ERR_COST_VALUE_MISSING`, directly or through the `beforeAll` that raised it — which are red from before Task 0 and green from Task 8 Step 9 onward.** The count is 3B's business and is deliberately not pinned here; the code is the discriminator. Do not "fix" them earlier by editing 3B's expectations; do not read them as a regression this slice caused; do read any failure carrying a *different* code as one. If landing zero red at every commit matters more than task order, the alternative is to move Task 8 Steps 4–6 — the `apply-movements.ts` receipt-value site, the `reverse.ts` `l.cost` column and the export list — ahead of Task 1 as the slice's first code commit; nothing in Tasks 1–7 depends on them, and Task 8's remaining steps stay where they are.
- **Task 5** lands three cases; the two that need `GOODS_RECEIPT` are appended by **Task 6 Step 5** (they only draft and link — they never post — so they are green there).
- **Task 6** lands `GOODS_RECEIPT.json` and one envelope case that reads the file off disk; the four cases that *post* a receipt, and the `beforeAll` they need, are appended by **Task 8 Step 7** — the commit that makes them pass.
Each task's own suite is therefore green at its own commit, and no PR needs to be batched with another.

**Do not.** Rename or alter anything Plan 0A produced; edit `packages/db/src/lint-schema.ts` (both new tables are §3.5.3 dashes — hazard 13); add a DELETE grant (§3.5.4 is closed, 2B is the only extender); add a `RouteModule` or a `PROBES` key (all five sub-paths hang off 1A's `documents` module); pair a `line.cost` leg against a `line.amount` leg on one document (§4.3.4's rule — the database refuses it); re-open OD-06 (`avco` is consumed as built); write a real statutory rate anywhere.

**When you are done.** Task 14 Step 7's checklist ticked in the PR body, the whole of Step 6 green, and the two owner questions — OD-05's three specifics and OD-24's screenshots — recorded on their tasks with ADR 0041 still marked **Proposed** until the accountant answers.
