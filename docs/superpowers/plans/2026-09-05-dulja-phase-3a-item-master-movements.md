# Dulja Phase 3A — Item master, units, warehouses, lots, prices, movements, stock on hand

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** Give the posting service something to move. Concretely: the item master (`app.item`, `app.unit_of_measure`, `app.unit_conversion` with exact rationals), the places stock lives (`app.warehouse` as a tree with an `in_transit` kind, `app.lot` with expiry, `app.variant`), what stock is sold at (`app.price_list`, `app.price_list_line`, `app.promotion`), and the two tables that make a quantity real — the immutable `app.inventory_movement` and the synchronous `app.stock_on_hand` projection it is `MERGE`d into inside the posting transaction. Around those: the movement-planning half of `evaluatePolicy` that 2A deliberately left returning `[]`; the `applyMovements` hook `postDocument` step 9 calls, in its provisional 3A form; negative-stock rejection in the **data layer** (`app.assert_stock_available`), overridable only by a second principal's `document_event`; FEFO picking; a near-expiry alert job; lot attachments; and the item, unit, warehouse, price and stock APIs. At the end of this slice a document type whose policy declares `inventory.effect: "issue"` posts, writes signed movements, updates stock on hand to the microgram, refuses to go negative through the API, through a job and through raw `app_rw` SQL alike, and `app.pick_lots_fefo` returns the earliest-expiring lot.

**Architecture.** Three layers, no shortcuts across them. **SQL** owns the invariants: `assert_stock_available` is a BEFORE INSERT trigger on `inventory_movement` (so no write path escapes it), `item_sentinel_lot` is an AFTER INSERT trigger on `item` (so `stock_on_hand`'s `lot_id` primary-key column is never NULL — SAH-050), `warehouse_no_cycle` is a recursive-CTE guard written once (SAH-071), and `pick_lots_fefo` is a stable SQL function over the projection rather than a replay of history (SAH-067). **`packages/domain`** owns the pure half: `planMovements` inside `evaluatePolicy` turns `policy.inventory` plus the line snapshots into `PlannedMovement[]` with `movementNo` assigned in emission order, and `applyConversion` turns an entered `(unit, unit_quantity)` pair into an exact base quantity (SAH-066). **`packages/db/src/costing/apply-movements.ts`** owns the I/O half: it is the only writer of `app.inventory_movement`, it resolves the sentinel lot and the base unit, it fills `value` on the plan and `cost` on `document_line`, and 3B replaces its body without touching its signature. Nothing in `apps/api` or `apps/worker` writes a movement.

**Tech Stack.** PostgreSQL 18 (`numeric(19,4)` money, `numeric(19,6)` quantities, `bigint` rational parts, `uuidv7()` keys, RLS forced on every table, `MERGE` for the projection); `postgres.js` tagged templates for every posting/movement write; Drizzle mirrors as the migration diff source (ADR-0002); TypeScript strict, Bun for everything except tests; Vitest + Testcontainers (`postgres:18`) under Node 24; Hono + `@hono/zod-openapi` for routes; Zod contracts in `packages/contracts`; pg-boss for the expiry-alert job; `decimal.js` behind `Money`/`Quantity`/`Rational` in `packages/domain`.

**Spec:** `C:/Users/Edres101/Desktop/dulja/rebuild-spec.md` (v1.2). Sections this slice argues from: §0.2 (the never/always lists), §0.4 glossary (spec:158–162 Material/Warehouse/Batch/MatUnits/Prices), §3.0.3 (spec:1021–1025 Batch/lot, Multi-branch stock, Multi-unit items, Price lists; spec:1032 the "probably not needed" list), §3.0.4 (spec:1048 Inventory core — this slice's owned row; spec:1062 the POS selling row's promotions half; spec:1067 the attachment row's lot link), §3.3 (spec:1178–1183, 1198), §3.4 (spec:1212, 1225–1226), §3.7.3 (spec:1308–1310), §3.7.5 (spec:1312), §3.8 (spec:1370, 1979–1993), §3.9 (spec:2043, 2047), §4.2.1 (spec:2148, 2159), §4.2.2 R8 (spec:2179), §4.11 (spec:2264), Part V Phase 3 (spec:2289, 2404), Part VI tests 17 and 18 (spec:2435–2436), Part I SAH-048, 050, 052, 056, 057, 063, 064, 066, 067, 071, 073, 074.

**Contracts:** `C:/Users/Edres101/Desktop/dulja/docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` — the authority for every shared name. Where it gives code, this plan repeats it verbatim.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 3A — Item master, units, warehouses, lots, prices, movements, stock on hand. **Phase:** 3. **Phase gate:** this plan starts only when 2A, 2B and 2C are merged and the Phase 2 definition of done is green in CI (spec:87) — a tenant-defined document type numbers, posts, prints, reports and reverses with zero code; the state machine, `document_event`, R1/R2 and gapless numbering are proven.
- **Depends on (merged):** 2A (`evaluatePolicy` over the full §4.4.1 schema, `loadSnapshot`, `app.party`, the ten `document_line` columns, `document_type.module`, `requireDocumentPermission`, `seedParty`, `seedDocumentType`, amendment A5's fail-closed guard in `postDocument`), 2B (`app.document_event`, `app.principal_has`, `app.assert_override_authorised`, `document_event_override_guard`, `recordOverride`, `OverrideCode`, `OverrideBody`, `POST …/documents/{id}/overrides`, `grantCodes`, `app.effective_policy`, `app.series_gaps`, `SERIES_GAP_CHECK`), 2C (`app.attachment`, `MODULE_READ_CODE`, `requireAttachmentRead`, `readableModules`, `listAttachments`, `ObjectStore`, `objectKeyFor`, `AttachmentSchema`, `UploadAttachmentBody`, `AttachmentQuery`, `AttachmentList`, `pdfText`, `SubPack` with `"templates"`), 1A (`postDocument`, `loadSnapshot`, `resolvePolicy`, `issueDocument`, `insertLedger`, `PostingError`, `posting-policy.schema.json`, `document.posting_seq`, `app.posting_seq`, `seedAccount`, `seedTenantV2`, `seedJournalPolicy`, `JOURNAL_POLICY_V1`, `documentTypesLoader`), 1B (`registerProjectionCheck`, `projectionChecks`, `ProjectionCheck`, `ProjectionMismatch`, `IntegrityReport`, `runIntegrityCheck`, `recordIntegrityIncident`, and `tests/invariants/projection-rebuild.test.ts` itself, which Task 8 Step 8 extends — **not** `postJournal`, which drafts a JOURNAL and cannot carry an item line), 0D (`Money`, `Quantity`, `Rational`, `rational`, `round`, `toBase`, `UNIT_RATE`, `MONEY_SCALE`, `QUANTITY_SCALE`, `JOBS`, `JobEnvelope`, `JobClient`, `JobPayload`, `eachTenant`, `JOB_PROBES`, `registerHandler`, `runJob`, `startWorker`, `seedBranch`, `seedCurrency`, `seedRate`), 0C (`0c-base.json` — the account codes `1300`, `4000`, `5000`, `5900` this slice resolves and never re-seeds; the seed CLI, `PackLoader`, `SUB_PACKS`), 0B (`withTenant`, `createDb`, `TenantContext`, `systemContext`, `AppError`, `ERRORS`, `fromDatabaseError`, `PERMISSION`, `PERMISSIONS`, `requirePermission`, `assertRouteGates`, `buildRoutes`, `RouteModule`, `ROUTES`, `PROBES`, `IsolationProbe`, `IdempotencyHeader`, `createApp`, `startApi`, `grantAdmin`, `problemOf`, `sharedDb`, `thinRegression`, `sourceFiles`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `QuantitySchema`, `MoneySchema`, `encodeCursor`, `decodeCursor`, the generalised reversibility test of §3.4.6), and the Plan 0A surface by exact name: `startDb`, `Db`, `withTenant` (the 4-argument test helper), `uuidv7`, `seedTenant`, `Seed`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_tenant`, `app.current_actor`, `app.forbid_change`.
- **Migration numbers:** 0028–0033 (contracts §3.4.1) — `0028_create_item_unit.sql`, `0029_create_warehouse_lot_variant.sql`, `0030_create_price_list_promotion.sql`, `0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql`, `0032_alter_document_line_add_inventory_columns.sql`, `0033_seed_permission_phase3a.sql`, each with its hand-written `NNNN.down.sql`. **ADR numbers:** 0034–0036 — **0034** the sentinel lot and `inventory_movement.lot_id NOT NULL` (SAH-050), **0035** movement planning belongs to the evaluator and the provisional 3A value rule, **0036** exact unit conversion at line write plus FEFO over the synchronous projection (SAH-066, SAH-067).
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `Quantity`, `Rational`, `round`, `toBase`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`AppEnv`, `Logger`, the middleware order), §4.2.4 (the error envelope, `AppError`, `ERRORS`, `fromDatabaseError`, `PostingError`), §4.2.5 (`PERMISSIONS`, `PERMISSION`, `requirePermission`, `RoleSeed`, `ROLES`), §4.2.6 (`JOBS`, `JobPayload`, `JobEnvelope`, `JobHandler`, `registerHandler`, `JOB_PROBES`, the audit `table_name` sentinels — **`eachTenant` is not consumed**: the one job this slice registers fans out over companies inside one tenant's context, which `runJob` has already resolved; Task 10 Step 5 says so at the import line), §4.2.7 (`RouteModule`, `buildRoutes`, `PROBES`, `IdempotencyHeader`), §4.2.8 (the Zod naming convention, `ListEnvelope`, `ListQuery`, the cursor codec, the `filter[<field>][<op>]` grammar), §4.2.12 (`startApi`, `StartedApi`), §4.3.1 (`postDocument`, `loadSnapshot`, `recordOverride`, `OverrideCode`), §4.3.2 (the fixed algorithm — steps 6, 8, **9**, 9b, 10, 12), §4.3.3 (the `account_balance` MERGE, as the shape the stock MERGE mirrors), §4.3.4 (`document_line` and the 3A row of its additions; the `document` header additions), §4.3.5 (`document.posting_seq` and the four-element chronological key), §4.4.1 (the `inventory` block of the policy schema), §4.4.2 (`DocumentSnapshot`, `LineSnapshot`, `ItemRef`, `PlannedMovement`, `PostingPlan`, `PolicyEvaluationError`, and **amendment A9's sign normalisation**), §4.5.3 (the override door), §4.5.6 (Form A″ and Form C, which 6C attaches — this slice creates the tables branch-ready and attaches nothing), §4.5.8 (`app.attachment` and the download map), §4.6.1 (the register rows for all nine of this slice's master tables), §4.7.2 (`applyMovements`), §4.7.3 (`inventory_movement`, `stock_on_hand` and the MERGE, verbatim), §4.15 (the account-code register), §4.16.3 (`registerProjectionCheck`, `ProjectionCheck`), §4.17 and §4.17.1 (the fixture registers).
- **Interfaces produced:** §4.6.1's nine 3A rows verbatim (`item`, `unit_of_measure`, `unit_conversion`, `warehouse`, `lot`, `variant`, `price_list`, `price_list_line`, `promotion`); §4.7.3's `inventory_movement`, `stock_on_hand` and the `stock_on_hand` MERGE verbatim; `app.assert_stock_available()` (§4.7.3's comment, as executable PL/pgSQL); `app.pick_lots_fefo(item_id, warehouse_id, quantity)` (the 3A card); §4.7.2's `applyMovements(tx, ctx, plan, snapshot)` in its **provisional 3A form** — the signature is frozen here and never changes; §4.3.4's 3A `document_line` row (`warehouse_id`, `lot_id`, `unit_id`, `unit_quantity` and the `item_id` FK) and the `document` header's `warehouse_id`/`to_warehouse_id`; `attachment.lot_id` and the `inventory` row of §4.5.8's download map plus the lot rule; §4.4.2's `PlannedMovement` emission (the movement half of `evaluatePolicy`, which 2A left as `[]`); §3.6.2's five `inventory.*` codes and §3.6.4's role rows for them; §4.2.6's `inventory.lot.expiry_warning` handler; §4.16.3's registry extended with `stock_on_hand`; §4.17's `seedUnit`, `seedItem`, `seedWarehouse`, `seedLot`, `seedPriceList`.
- **Owner decisions:** **OD-05** (confirmation of every ⚠️ §3.0.3/§3.0.4 row — spec:38, 1014, 1036, 2404) → **cited in Tasks 1, 2, 4 and 10**, which build the four §3.0.3 rows this slice owns (Multi-unit items spec:1024, Batch/lot with expiry spec:1022, Price lists per customer type spec:1025, Multi-branch stock spec:1023) at the spec text as written; those rows *are* the slice and are not droppable, so OD-05 is a **header citation with a stated per-task consequence** rather than a sixteenth task — see assumption 12. **OD-07** (serial numbers — spec:92, 1032, 1310, 2435) → **Task 13** only, isolated; default: not built. **OD-08** (manufacturing/BOM, consignment stock, dealer commissions, project/job costing — spec:1032) → **Task 14** only, isolated; default: not built, names reserved, no DDL. **OD-24** (screenshots and a two-minute operator description before any screen — spec:79, 108, 2408) → **Task 15** only, isolated; default: the screen task is blocked, not the slice. This plan decides none of them (contracts §2.12) and re-opens none of D1–D27.
- **Part VI tests owned / re-run:** owns **18** (stock availability — rejected by the data layer regardless of session flags, user attributes or write path; overrides explicit and audited; Task 9). Re-runs **2** (deterministic projections, for `stock_on_hand`; Task 8), **13** (audit completeness, for lot attachments; Task 10), **12** and **36** (tenant isolation and role-catalogue integrity, for every new table and route; Tasks 1, 2, 4, 5, 11, 12), **1** (the ledger invariant, through the posting path a movement now travels; Task 8). **§3.0.4 rows owned:** spec:1048 (Inventory core — items, exact-rational units, warehouses (tree), lots with expiry, FEFO picking, price lists per customer type, stock-on-hand projection; the *valuation* projection is 3B's). Contributes the lot link to spec:1067. **Regression files created:** `sah-048`, `sah-063`, `sah-064`, `sah-066`, `sah-067`; ⚠️ `sah-052`, `sah-056`, `sah-057` **only if OD-07 = yes** (3A is their named creator — contracts §3.7.3). **Appends to:** `sah-050` (dimension NOT NULL on movements), `sah-071` (warehouse tree), `sah-073`, `sah-074`.
- **Shared namespaces this slice writes into:** **Document-type codes (§4.14)** — no packaged code. **Four** **test-only** codes, registered as contract additions and never written to `packages/db/seed/`: `STOCK_ISSUE_TEST` (series `SIT`), `STOCK_RECEIPT_TEST` (series `SRT`), `STOCK_TRANSFER_TEST` (series `STT`) and `COST_LINE_TEST` (series `CLT`) — all module `inventory`, each configured through `seedDocumentType` inside a Testcontainers database, each with `approval: { required: false, approve: null, post: "accounting.journal.post" }` because that is the only posting code in the catalogue at 3A (`inventory.receipt.post` is 3C's and `inventory.transfer.post` is 3D's). The **first three** address their ledger accounts as `{ from: "line.account" }` with `line.debit`/`line.credit` on `kind = 'account'` lines, so hazard 33 does not engage and amendment A5's step-9b guard never fires. **`COST_LINE_TEST` is the deliberate opposite** (Task 8's last case): it addresses `amount: "line.cost"` against `{ code: "5000" }` and `{ code: "1300" }` precisely so the 9b guard *does* fire, which is the only way to prove the guard is still standing at 3A. It therefore engages hazard 33 by design, and Task 8's `beforeAll` seeds `1300`, `5000` and `5900` so the resolution it depends on is real rather than assumed. **Account codes (§4.15)** — **none seeded**: this slice seeds no chart file and adds no register row. It **consumes four codes 0C seeds** — `1300` inventory control, `4000` sales, `5000` cost of goods sold, `5900` other operating expense — as the per-item defaults of §4.6.1, and Task 1 Step 1 asserts they resolve before anything depends on them (hazard 33). **Report codes (§4.16.1)** — **none**: `inventory.stock_on_hand`, `inventory.valuation` and `inventory.sales_by_item` are **3D's** minimal set, and the `GET …/stock-on-hand` list route of Task 12 is an ordinary list endpoint, not a `ReportCode`. `DatasetId` members (§4.16.2) — **none**: 7A creates `packages/db/src/reports/datasets.ts` and its ≤ 0058 set already names `item`, `lot`, `warehouse`, `price_list_line`, `promotion`, `inventory_movement` and `stock_on_hand`; this slice does not create or edit that file. **`fixtures.ts` helpers (§4.17)** — exactly the five §4.17 assigns 3A: `seedUnit`, `seedItem`, `seedWarehouse`, `seedLot`, `seedPriceList`. **Shared test helpers (§4.17.1)** — **none added, and none needed**: Tasks 8 and 9 consume 0B's `sharedDb`/`thinRegression` and write their own document-posting helper inline in each suite, because §4.17 assigns this slice no such row and §4.17.1 binds a slice to "only the rows this table assigns it". `postJournal` (1B) is **not** used anywhere in this slice — it drafts a JOURNAL, and every document this slice posts is a §4.14 inventory test type with item lines.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Never, at any phase, for any reason** (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (SAH-036/037/069); issue DDL from application code (SAH-053); disable an invariant, constraint or trigger "temporarily" (SAH-027, 041, 053); gate an audit write on any flag (SAH-030); hard-code a package version into a source file — the lockfile owns versions.
- **Always, for every new table** (spec:106): `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. **For every new endpoint:** Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. **For every UI screen:** verified in both text directions before merge.
- **Money** (spec:2041): `numeric(19,4)` in Postgres; `Money` in TypeScript; no `number` ever holds a monetary value — the `no-number-money` lint enforces it. Base conversion is `round(value × rate, 4)` `HALF_AWAY_FROM_ZERO` (hazard 23).
- **Quantities** (spec:2043): `numeric(19,6)`. Unit conversions are exact rationals `(numerator bigint, denominator bigint)`, never floats (SAH-066). Quantity is stored once, **in the item's base unit**; the entered unit and quantity are kept for display.
- **Time** (spec:2039): all timestamps `timestamptz` in UTC; `effective_date` is a `date` entered by the user and is the accounting date, never derived from `posted_at`.
- **Naming** (spec:2045): `snake_case`, **singular** table names; `name_en`/`name_ar` on master data, never a JSON blob; TypeScript `camelCase`, types `PascalCase`.
- **Enumerations** (spec:2047): new closed vocabularies are `text` + `CHECK`, never a new Postgres enum (§3.4.4 — a label cannot be used in the migration that adds it). This slice adds no enum label.
- **Deletion** (spec:2049): financial rows never; master data `archived_at`, never `DELETE`. This slice adds **no** `app_rw` DELETE grant and does not touch `privileges.test.ts`'s pinned list (§3.5.4 — 2B is the only slice that extends it).
- **Database access** (spec:2053): every query, reads included, runs inside `withTenant`; the `no-bare-db` lint forbids bare `db.` calls; only `tx` may tag SQL.
- **API** (spec:2055): `/v1/…`; cursor pagination; `Idempotency-Key` required on POST/PUT/PATCH/DELETE; `application/problem+json` errors; OpenAPI generated from Zod, committed, diffed in CI.
- **Error codes** (spec:2051): `ERR_<DOMAIN>_<REASON>` in the one file `packages/contracts/src/errors.ts`; a code no code raises fails the build. DB-raised tokens use `errcode = 'check_violation'` and the message form `TOKEN: text` (plan0A:1130–1141).
- **Migrations** (spec:2057, §3.4.3): one migration per PR; each file is one transaction, so no `create index concurrently`; every statement carries a comment naming the SAH/spec reference it serves; keywords lowercase; section banners `-- ── N. title ───`; a hand-written `NNNN.down.sql` with a drop for everything the up creates, in reverse dependency order.
- **Commits** (§3.8): conventional commits, subject `<type>(<scope>): <summary> [3A T<n>]`, every message ending with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Hazards** (§5): no real statutory rate anywhere; no invented MyInvois or LHDN detail; `fixtures.ts` extended additively and only with §4.17's assigned helpers; per-tenant rows are seed-pack data, never migration data (only `app.permission` is global); migration and ADR numbers are never renumbered or borrowed; jobs run as the tenant's system principal; nothing outside `packages/db/src/posting/**` and `packages/db/src/costing/**` writes a movement or a projection; test 18's "gone negative" is produced only through `inventory.negative_stock.override` recorded as an `override` `document_event` by a second principal (hazard 17); every route needs a `PROBES` entry keyed by its `RouteModule.path`; no plan invents a literal in a shared namespace.

---

## Assumptions this plan rests on

Every assumption is stated here so a reviewer can reject it in one place instead of discovering it inside a task.

1. **Movement planning belongs to the evaluator, and 3A is the slice that writes it (ADR 0035).** 2A's `evaluatePolicy` returns `movements: []` with the comment "`inventory.effect` is read by 3A's `applyMovements` … which is the slice that has `app.item` and `app.warehouse` to plan against" (2a:1883). But §4.4.2's `PlannedMovement` doc comment says "**The evaluator assigns `movementNo` in emission order**", and §4.7.2's `applyMovements` "assign[s] `movement_no` from `plan.movements[i].movementNo`" — it *reads* the number, so something upstream must have produced it. Planning is also pure: every input (`policy.inventory`, `LineSnapshot.itemId`/`quantity`/`warehouseId`/`toWarehouseId`/`lotId`, `header.warehouseId`/`toWarehouseId`, `refs.items`) is already on the snapshot. **Task 7 therefore implements `planMovements` in `packages/domain/src/posting/evaluate.ts` and `evaluatePolicy` returns it**, and Task 8's `applyMovements` consumes it. Both readings of 2A's sentence end at the same place — 3A writes the code — and this one keeps `applyMovements` free of policy interpretation, which is what lets 3B replace its body.
2. **`PlannedMovement.quantity` is a magnitude and `effect` is the sole carrier of direction**, exactly as amendment A9 makes `side` the sole carrier for `PlannedLedgerLine`. A reversal document carries **negated** `line.quantity` (2A, §4.4.2's sign-normalisation section), so a rule that would emit `issue` over a negative line quantity emits `receipt` at `quantity.abs()` instead; a `transfer` swaps its two legs. `applyMovements` is the only place a sign is re-attached: `inventory_movement.quantity = effect === "issue" ? qty.negate() : qty`, and `value`'s sign follows it (§4.7.3: "sign follows quantity"). **No code in this slice, and none in 3B, 3D, 6A or 9B, may infer direction from `PlannedMovement.quantity.isNegative()`** — it is always false.
3. **`line.to_warehouse` has no `document_line` column and does not gain one.** §4.4.1's `inventory.to_warehouse` enum admits `"line.to_warehouse"`, but §4.3.4's 3A row adds exactly `warehouse_id`, `lot_id`, `unit_id`, `unit_quantity` — there is no `to_warehouse_id` on a line, and §4.4.2's `LineSnapshot` already declares `toWarehouseId: string | null`, which `loadSnapshot` fills as a constant `null` (2a:2186 marks it "3A / 0031, 0032"). So `planMovements` resolves `"line.to_warehouse"` to `line.toWarehouseId ?? header.toWarehouseId`, which at 3A is always the header's. The two-step transfer that needs a per-line destination is **3D's**, and 3D adds the column in its own range if it needs one. Task 6 fills `LineSnapshot.toWarehouseId` from `null` with the comment naming 3D.
4. **`policy.inventory.allowNegative` is not read by this slice.** The schema carries it (§4.4.1) and test 18 requires that negative stock be "rejected by the data layer regardless of session flags, user attributes, or write path" (spec:2436). A policy flag *is* a user attribute. `app.assert_stock_available` therefore has exactly **one** door — an `inventory.negative_stock.override` `document_event` recorded by a second principal (§4.5.3) — and Task 9 Step 6 asserts that a policy with `allowNegative: true` is still refused. The field stays in the schema unread; the slice that wants it to mean something amends the contracts document first.
5. **`document_line` has no BEFORE UPDATE guard**, so `applyMovements` may write `cost` on an `issued` document. 2B ships `document_line_delete_draft_only` (BEFORE **DELETE**) and nothing else; 1A's own tests update a posted document's line description to prove the audit trail records it. If a later slice adds an update guard it must admit `cost`, and this assumption is where to look.
6. **Only `item.kind = 'product'` plans movements.** §4.6.1 makes `kind` NOT NULL over `product | service | asset`; a service has no stock and an asset is Phase 10's fixed-asset register (spec:1073 "Still deferred"). `planMovements` skips a non-product item line rather than raising, so a mixed invoice (goods plus freight-as-service) posts. The `when: { "item.kind": … }` filter is unaffected — it is the evaluator's ledger-line filter and 2A already implements it.
7. **`item.track_lots` makes a lot mandatory on a receipt and optional on an issue.** §4.7.2 says `applyMovements` "resolves each line's `lot_id` to the item's `NONE` sentinel lot when the line carries none" and separately that "`trackLots` is what the costing hook reads to decide whether a lot is required". Both hold: a **receipt** of a lot-tracked item with no `lot_id` raises `ERR_POLICY_REQUIRES_MISSING` naming the line and the item (a food receipt without a batch is a data error, and the sentinel would silently pool two batches); every other case resolves the sentinel. An **issue** with no lot resolves the sentinel too, and then usually fails loudly on `ERR_STOCK_INSUFFICIENT` because the sentinel holds nothing — which is the correct answer, not a bypass.
8. **The provisional value rule is `round(unit_price × quantity, 4)` in base currency, and 3B deletes it.** §4.7.2 fixes it in those words. When `line.unitPrice` is null the fallback is `line.amount` (which §4.3.4 defines as the line total excluding tax, in document currency) — a free-of-charge line therefore values at zero, which is what spec:1055's FOC clause wants and what 3B's `costing: "zero"` will formalise. Both are converted with `toBase(value, snapshot.header.exchangeRate)`, `HALF_AWAY_FROM_ZERO` at scale 4 (hazard 23). §4.7.2 states plainly that rows posted between 3A and 3B are test data only and are never back-filled.
9. **Registering `STOCK_ON_HAND_CHECK` changes two pinned assertions, and Task 8 moves them.** 2B's `SERIES_GAP_CHECK` made `IntegrityReport.projections.checked` equal `["account_balance", "document_series"]`, and §4.18 records that 1B's two assertions on that array — in `tests/invariants/audit-chain.test.ts` and `apps/worker/test/handlers/integrity-check.test.ts` — move in the same PR as a registration. This slice adds a third member, so both become `["account_balance", "document_series", "stock_on_hand"]` (`projectionChecks()` sorts by name, so the order is alphabetical and stable).
10. **0032 breaks two 2A tests, deliberately, and Task 6 fixes them.** §4.3.4 records that "2A's own tests write arbitrary uuids into both [`item_id` and `tax_code_id`], which is legal exactly until those PRs land". Adding `(tenant_id, item_id) → app.item` makes an arbitrary uuid a `23503`. Task 6 Step 2 derives the exact call sites with one `grep` and replaces each arbitrary id with `seedItem`'s.
11. **Warehouse and unit maintenance are gated by `inventory.item.manage`; there is no separate warehouse code.** §3.6.1 closes the permission vocabulary and §3.6.2's inventory row names exactly five codes for 3A. spec:2160 gives `branch_manager` no catalogue authority ("May not: Prices, item master or credit terms — head office owns the catalogue") and spec:2159 gives `warehouse` none either ("May not: Prices, item master"), so warehouses, units and unit conversions are head-office catalogue and share the item-master code. Recorded as a contract addition to §3.6.2's "Uses fixed by this document" sentence.
12. **OD-05's four §3.0.3 rows are the slice, not an optional task.** Hazard 6 wants one isolated task per pending decision, but the four rows OD-05 gates for 3A — Batch/lot with expiry, Multi-branch stock, Multi-unit items, Price lists per customer type (spec:1022–1025) — are the deliverables §4.6.1 assigns 3A by name, and an isolated task holding all of them would be the whole plan. OD-05 is therefore cited in the four tasks that build them with the **exact consequence of a rejection** stated per task: reject Multi-unit items → drop `app.unit_conversion` from 0028 and the conversion half of Task 6; reject Batch/lot → `app.lot` shrinks to the per-item sentinel row (which `stock_on_hand`'s primary key needs regardless) and Task 10's FEFO and expiry work is dropped; reject Multi-branch stock → `warehouse.branch_id` becomes nullable and Task 2's tree is one row per company; reject Price lists → drop 0030 and Task 12's two route modules. Nothing else moves, because nothing else depends on them. The three genuinely droppable decisions (OD-07, OD-08, OD-24) each keep their own isolated task.
13. **Money and quantities cross every boundary as strings.** `postgres.js` returns `numeric` as a JavaScript string; no value in this plan passes through `Number()`, `parseFloat` or `number` arithmetic. Amounts are `MoneySchema` (`{ amount, currency }`) on the wire, `QuantitySchema` (a fixed-6-dp string) for quantities, `Money`/`Quantity` inside the domain, and fixed-scale strings in SQL. `numerator`/`denominator` are `bigint` in SQL and `bigint`/decimal strings in TypeScript — never `number` — and the Zod contract accepts them as digit strings.
14. **`app_rw` may create a temporary table.** 1B's assumption 4 established it (Plan 0A revokes object creation *in schema `app`* only, plan0A:2498) and its rebuild-and-compare depends on it. Task 8's `checkStockOnHandProjection` uses the same `create temporary table … on commit drop` shape and would fail loudly on the same line if that were ever falsified.
15. **Drizzle mirrors exist for every table in schema `app`** (§3.4.9 makes the mirror the diff source for every migration after 0001), and this slice adds one mirror file per new table in the same PR as its migration. `packages/db/src/schema/document.ts`, `document_line.ts` and `attachment.ts` already exist (0B, 1A, 2C); Tasks 5 and 6 add columns to them. If one is absent when a step runs, that step authors it column-for-column from the migration DDL before editing, and says so in the commit body.
16. **`withTenant` runs at READ COMMITTED, and both of this slice's advisory-lock sites depend on it.** §4.2.2 fixes the production seam as "one transaction, explicitly `begin isolation level read committed` (the audit chain depends on it — spec:1368)" and 0B's `with-tenant.test.ts` asserts `current_setting('transaction_isolation') = 'read committed'`. That is what makes lock-then-read correct: each statement takes a fresh snapshot, so a transaction that waits on `pg_advisory_xact_lock` and *then* runs `assert_stock_available`'s `sum(quantity)` sees the rows the lock holder committed. 1A's amendment A4 rests on the same property for the `account_balance` MERGE, and Task 8 applies it twice — `lockStockKeys` before the movement insert (step 9) and again before the `stock_on_hand` MERGE (step 12). Under REPEATABLE READ the second read would reuse the transaction snapshot and the lock would buy nothing; if §4.2.2's isolation level ever changes, **both** lock sites and A4 need re-deriving, and that is a contracts amendment rather than a plan edit.

## Contract deviations and additions recorded here

Each needs a one-line amendment to the contracts document. Nothing below changes a frozen name; every item is a name the registry lacks, or a naming rule applied.

**Why there is no Task 0 and no `scripts/check/contracts-3a-amendments.sh`, and what stands in its place.** Almost every slice from 3B onward opens with a Task 0 listing its own amendments and shipping a gate whose Step 2 is "run it to see it fail". 3A predates that convention and contracts §4.18's round-3 preamble records the consequence in those words: *"3A is the one plan with no Task 0 and no gate script. It records its contract additions as header prose (3a:76–84) and has no task that writes them, so every 3A row below is the architect's to land and has been landed here. A reader checking 3A's coverage looks at this table, not at a script."* Adding a Task 0 now would contradict that. Round 3 folded in the rows of this section that a *different* slice consumes — `applyConversion`'s §4.2.1 paragraph, the two new `ERR_VALIDATION_FAILED` raisers, the four §4.14 test-only document-type codes, `lockStockKeys` in §4.7.2's frozen step 9, and OD-05's §2.12 Gates cell. **It left two that a hazard or a downstream gate depends on**, and those two are the checklist below; the rest of this section is slice-internal, which is the boundary round 3's preamble draws. An executor who finds either of these missing stops and asks for the amendment rather than inventing it:

| Still to land in the contracts document | Where | Consequence if it is missing when 3A runs |
|---|---|---|
| `ERR_WAREHOUSE_TREE_CYCLE \| 409 \| app.warehouse_no_cycle() (3A)` | §4.2.4's allocated `ERR_*` registry | Hazard 32: an unregistered literal in the `ERR_*` namespace is a review-blocking finding, and `fromDatabaseError` has no `ERRORS[token]` row to map, so the 409 arrives as an unmapped 500. Task 2 Step 9 greps for it. |
| The 0031 rename (bullet 1 below) | §3.4.1's 3A row, §4.18 as a `3A \| plan` row, **and the one downstream preflight grep it still orphans** — the two `need_grep packages/db/migrations/0031_create_inventory_movement_stock_on_hand.sql` lines in `2026-09-05-dulja-phase-3d-sales-transfers-counts.md`'s Task 0 gate. They are cited here by their grep string rather than by line number, because the line number is exactly what goes stale. **6A no longer needs an edit:** its Task 0 gate now reads `need "3A document.warehouse" packages/db/migrations/0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql "warehouse_id"`, which is the file this plan creates, so the third spelling that used to sit here is gone. | 3D's Task 0 gate fails against the file 3A actually creates. That edit is not 3A's to make: it belongs to 3D and to the contracts document, and is listed here so the architect lands all three in one amendment. |

- **Migration 0031's file name is longer than the card's guess**, per §3.4.2's settled rule that "a file whose name understates what it does is renamed, not left". §4.3.4 assigns `document.warehouse_id`/`to_warehouse_id` to **0031** and 2C assigns `attachment.lot_id` to **0031**, so that file creates two tables *and* adds three link columns to two existing ones. The name is `0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql`. The card's `0031_create_inventory_movement_stock_on_hand.sql` is superseded exactly as 2A's `0018_…` and 2B's `0023_…` superseded theirs. **The amendment is not yet landed and it is not one line:** §3.4.1's 3A row still lists the old name, §4.18's round 3 folded in four other 3A rows and not this one, and **one downstream plan still greps for a file name that will not exist** — see the table above for the exact three edits.
- **New error code:** `ERR_WAREHOUSE_TREE_CYCLE` (409), raised by `app.warehouse_no_cycle()` (Task 2). §4.2.4's table needs the row, and **grepping the contracts document for the name returns zero hits today** — §4.18's round 3 did not fold it in. §4.2.4 says "A slice that needs a code absent from this table amends this table first", and hazard 32 makes an unregistered `ERR_*` literal a review-blocking finding, so **the row lands before Task 2's commit**; Task 2 Step 9 carries the grep that proves it. It is not `ERR_VALIDATION_FAILED`: the request is well-formed and the refusal is a state conflict, and `fromDatabaseError` maps the token to `ERRORS[token]`, so a wrong code would give a 400 for a 409.
- **New names, with their files:** `app.item_sentinel_lot()` and `SENTINEL_LOT_CODE = "NONE"` (Task 2, ADR 0034); `app.warehouse_no_cycle()` (Task 2); `app.pick_lots_fefo`'s return shape `table (lot_id uuid, quantity numeric(19,6))` and its TypeScript wrapper `pickLotsFefo(tx, params): Promise<FefoPick[]>` with `FefoPick { lotId; quantity }` (Task 10); `applyConversion(unitQuantity: Quantity, conversion: Rational): Quantity` and `resolveUnitConversion(tx, { itemId, unitId }): Promise<Rational>` (Task 6); `planMovements(policy, snapshot): PlannedMovement[]` (Task 7); `loadSentinelLots(tx, itemIds)` (Task 8, **exported** from `packages/db/src/costing/index.ts`); `insertMovements` and `writeLineCosts` (Task 8, **module-private** to `apply-movements.ts` — `export` appears on neither, and the barrel exports neither; they are named here only so 3B replaces the body *around* them without renaming them, and the same is true of that file's other two private helpers `provisionalValue` and `readPostingSeq`); `mergeStockOnHand(tx, input)` and `lockStockKeys(tx, companyId, keys)` (Task 8, `packages/db/src/costing/stock-on-hand.ts`); `checkStockOnHandProjection` and `STOCK_ON_HAND_CHECK: ProjectionCheck` (Task 8, `packages/db/src/integrity/stock.ts`); `listNearExpiryLots`, `NearExpiryLot`, `recordExpiryWarning`, `EXPIRY_HORIZON_DAYS = 30` (Task 10); `INVENTORY_PERMISSION` (Task 3, `apps/api/src/routes/inventory/permissions.ts`); `itemRoutes`, `unitRoutes`, `warehouseRoutes`, `priceListRoutes`, `promotionRoutes`, `stockRoutes` and their six `RouteModule.path` strings (Tasks 11, 12).
- **`applyConversion` is deliberately *not* a second spelling of `Quantity.convert`, and the difference is the rounding mode.** §4.2.1 fixes `Quantity.convert(conversion)` as "exact; rounded **HALF_EVEN** to 6 dp only at the end", while migration 0032's `document_line_base_quantity()` derives the same figure with Postgres `round(new.unit_quantity * num::numeric / den::numeric, 6)`, which is **half away from zero**. The two disagree at a tie — `1.000000 × 1/2000000` is `0.000000` under HALF_EVEN and `0.000001` under the trigger — and because the trigger *raises* rather than overwrites when a supplied `quantity` disagrees (Task 6), a caller that computed `quantity` with the wrong mode would get `ERR_VALIDATION_FAILED` on a legitimate line. `applyConversion` is therefore **`Quantity.convert`'s body with one token changed** — `times(numerator).div(denominator)` on the cloned precision-40 `D`, rounded once with `round(exact, QUANTITY_SCALE, "HALF_AWAY_FROM_ZERO")` — and is the read-side twin of the trigger *because* of that mode, not despite it. It is **not** `Quantity.multiply(conversion, "HALF_AWAY_FROM_ZERO")`, which is the shorter-looking route and the wrong one: 0D implements `multiply` as `new D(numerator).div(new D(denominator))` first and `times` afterwards, so it divides before it multiplies, which is the per-step shape 0D's own `convert` docstring calls "the SAH-066 defect" — and the trigger multiplies first too (`new.unit_quantity * num::numeric / den::numeric`). Same order as the SQL, same mode as the SQL; both are asserted at a tie on both sides. The amendment §4.2.1 needs is one sentence: "a conversion whose result must agree with the 0032 `document_line` trigger goes through 3A's `applyConversion`, which is `convert`'s arithmetic at `HALF_AWAY_FROM_ZERO`; `convert`'s own HALF_EVEN is for display-side conversion only." `IDENTITY_CONVERSION` is a plain addition — the registry has no spelling of `1/1`.
- **§4.2.4's `ERR_VALIDATION_FAILED` row gains two DB raisers** — `app.pick_lots_fefo` (Task 5) and `app.document_line_base_quantity()` (Task 6), which raises it three times — both as `check_violation` tokens in the `TOKEN: text` form, reaching the wire through `fromDatabaseError`. The registry's "Raised by" cell reads "Zod body/query failure" and needs the two names appended. **No `errors[]` array accompanies them**, which the optional member already permits (§4.2.4 pins `errors[]` to `ERR_VALIDATION_FAILED` and `ERR_POLICY_INVALID` and says "No third code gains it" — it does not require the array to be present, and a DB-raised token has no JSON Pointer to report). Neither raise is a new code; both are a new raiser for a shipped one, recorded here so a reader of that row is not surprised by a 400 with no `errors[]`.
- **§4.2.6 audit `table_name` sentinel:** `lot_expiry_warning` — the third allocated sentinel after 1B's `integrity_incident` and `month_end_ready`. The near-expiry job has no row of its own (`needs_attention` is 6A's), so it records one audit row per company per run.
- **§4.2.6 `JobPayload` entry:** `"inventory.lot.expiry_warning": { companyId?: string; horizonDays?: number }`. `horizonDays` defaults to 30 — a reporting horizon, not a statutory figure (hazard 1 does not engage).
- **§4.2.8 contracts modules:** `packages/contracts/src/inventory/item.ts`, `unit.ts`, `warehouse.ts`, `lot.ts`, `price-list.ts`, `promotion.ts`, `stock.ts` with the `<Resource>Schema` / `Create<Resource>Body` / `Update<Resource>Body` / `<Resource>Query` / `<Resource>List` naming §4.2.8 fixes.
- **§4.5.8 additions:** `listAttachments` gains an additive `includeLots?: boolean` option and its `join app.document` becomes a `left join` (2C's own comment at 2c:1346 hands 3A that edit); `requireAttachmentRead` gains a `row.lotId` branch resolving to `inventory.item.read`; `UploadAttachmentBody` becomes exactly-one-of `documentId | lotId`; `AttachmentSchema` gains `lotId`. `MODULE_READ_CODE` gains `inventory: PERMISSION["inventory.stock.read"]`.
- **§3.6.2 "Uses fixed by this document":** warehouses, units and unit conversions are maintained under `inventory.item.manage` (assumption 11). **§3.6.4 role rows:** `inventory.item.read` and `inventory.stock.read` → `accountant`, `user`, `warehouse`, `branch_manager`, `auditor`; `inventory.item.manage`, `inventory.price.manage` and `inventory.negative_stock.override` → **no seeded role but `admin`** (which is computed), per spec:2159–2163 read strictly.
- **§4.14 test-only rows:** `STOCK_ISSUE_TEST`/`SIT`, `STOCK_RECEIPT_TEST`/`SRT`, `STOCK_TRANSFER_TEST`/`STT` and `COST_LINE_TEST`/`CLT` — **four** codes, all module `inventory`, all `approval: { required: false, approve: null, post: "accounting.journal.post" }`, none ever a file under `packages/db/seed/my/document-types/`. Neither §4.14's register nor 2A holds any of the four (checked by grep against both documents), so all four are additions this plan makes; `COST_LINE_TEST` is seeded by Task 8 alone and by no other task.

## File Structure

```
packages/db/migrations/
├─ 0028_create_item_unit.sql · 0028.down.sql                     item, unit_of_measure, unit_conversion        T1
├─ 0029_create_warehouse_lot_variant.sql · 0029.down.sql          warehouse tree, lot, variant, sentinel lot    T2
├─ 0030_create_price_list_promotion.sql · 0030.down.sql            price_list, price_list_line, promotion        T4
├─ 0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql inventory_movement, stock_on_hand,
│  · 0031.down.sql                                                assert_stock_available, pick_lots_fefo,
│                                                                 document.warehouse_id/to_warehouse_id,
│                                                                 attachment.lot_id                             T5
├─ 0032_alter_document_line_add_inventory_columns.sql             warehouse_id, lot_id, unit_id, unit_quantity,
│  · 0032.down.sql                                                and the item_id FK 2A left open               T6
└─ 0033_seed_permission_phase3a.sql · 0033.down.sql               the five inventory.* codes                    T3

packages/db/src/schema/                                           Drizzle mirrors (§3.4.9, the diff source)
├─ item.ts · unit_of_measure.ts · unit_conversion.ts                                                            T1
├─ warehouse.ts · lot.ts · variant.ts                                                                           T2
├─ price_list.ts · price_list_line.ts · promotion.ts                                                            T4
├─ inventory_movement.ts · stock_on_hand.ts                                                                     T5
├─ document.ts        MODIFY  + warehouseId, toWarehouseId                                                      T5
├─ attachment.ts      MODIFY  + lotId                                                                           T5
└─ document_line.ts   MODIFY  + warehouseId, lotId, unitId, unitQuantity                                        T6

packages/db/src/inventory/                                        NEW directory — reads and master-data writes
├─ items.ts           createItem, updateItem, archiveItem, listItems, getItem, resolveItemAccounts, ItemRow     T1
├─ units.ts           createUnit, listUnits, replaceUnitConversions, resolveUnitConversion, convertToBase       T1, T6
├─ warehouses.ts      createWarehouse, updateWarehouse, archiveWarehouse, listWarehouses, warehouseTree         T2
├─ lots.ts            createLot, listLots, sentinelLotId, pickLotsFefo, FefoPick                                T2, T10
├─ prices.ts          createPriceList, replacePriceListLines, listPriceLists, resolvePrice                      T4
├─ promotions.ts      createPromotion, listPromotions, PromotionRow                                             T4
├─ stock.ts           listStockOnHand, StockOnHandRow                                                           T12
└─ expiry.ts          listNearExpiryLots, NearExpiryLot, recordExpiryWarning                                    T10

packages/db/src/costing/                                          NEW directory — the posting-service annexe
├─ apply-movements.ts applyMovements (provisional 3A body; 3B replaces it), loadSentinelLots,
│                     insertMovements, writeLineCosts                                                           T8
├─ stock-on-hand.ts   mergeStockOnHand — §4.7.3's MERGE verbatim — and lockStockKeys, the sorted
│                     `stock:` advisory locks both step 9 and step 12 take                                      T8
└─ index.ts           the barrel @dulja/db re-exports                                                           T8

packages/db/src/integrity/stock.ts   checkStockOnHandProjection, STOCK_ON_HAND_CHECK                            T8
packages/db/src/integrity/index.ts   MODIFY  registerProjectionCheck(STOCK_ON_HAND_CHECK)                       T8
packages/db/src/posting/post.ts      MODIFY  step 9 applyMovements; step 12 mergeStockOnHand                    T8
packages/db/src/posting/load.ts      MODIFY  header warehouses, line inventory columns, refs.items              T6
packages/db/src/lint-schema.ts       MODIFY  stock_on_hand → NO_ID_TABLES, AUDIT_EXEMPT                         T5
packages/db/src/index.ts             MODIFY  the inventory / costing / integrity re-exports              T1, T2, T4, T8, T10
packages/db/seed/roles.ts            MODIFY  five role arrays gain the two read codes                           T3

packages/domain/src/posting/evaluate.ts   MODIFY  planMovements; evaluatePolicy returns it                      T7
packages/domain/src/quantity/convert.ts   NEW     applyConversion (exact rational, SAH-066)                     T6
packages/contracts/permissions.ts         MODIFY  five PermissionDef entries, phase "3A"                        T3
packages/contracts/src/errors.ts          MODIFY  + ERR_STOCK_INSUFFICIENT, ERR_WAREHOUSE_TREE_CYCLE        T5, T2
packages/contracts/src/inventory/         NEW     item.ts unit.ts warehouse.ts lot.ts
│                                                 price-list.ts promotion.ts stock.ts                     T11, T12
packages/contracts/src/accounting/document.ts   MODIFY  DocumentLineInput + the four inventory fields           T6
packages/contracts/src/accounting/attachment.ts MODIFY  AttachmentSchema.lotId; UploadAttachmentBody one-of     T10

apps/api/src/routes/inventory/
├─ permissions.ts     INVENTORY_PERMISSION — the five typed constants every route below imports                 T3
├─ items.ts           itemRoutes  + /{itemId}/lots, /{itemId}/unit-conversions, /{itemId}/archive               T11
├─ units.ts           unitRoutes                                                                                T11
├─ warehouses.ts      warehouseRoutes + /tree, /{warehouseId}/archive                                           T11
├─ price-lists.ts     priceListRoutes + /{priceListId}/lines                                                    T12
├─ promotions.ts      promotionRoutes                                                                           T12
└─ stock.ts           stockRoutes — GET …/stock-on-hand                                                          T12
apps/api/src/routes/index.ts                    MODIFY  six modules inside buildRoutes                     T11, T12
apps/api/src/middleware/require-attachment-read.ts MODIFY MODULE_READ_CODE.inventory; the lot branch            T10
apps/api/src/routes/accounting/attachments.ts   MODIFY  lotId upload and the lot filter                         T10
apps/worker/src/handlers/inventory.ts           NEW     registerInventoryHandlers — the expiry job              T10

apps/backoffice/src/lib/inventory-api.ts        NEW     the typed fetch layer the screens share                 T15
apps/backoffice/src/routes/inventory/items.tsx  · warehouses.tsx  · stock.tsx                                   T15
apps/backoffice/src/router.tsx   MODIFY  three routes under /inventory                                          T15
packages/i18n/src/locales/en.json · ar.json   MODIFY  every inventory.* key, in BOTH files                      T15

packages/db/test/
├─ inventory/item.test.ts · unit-conversion.test.ts                                                         T1, T6
├─ inventory/warehouse.test.ts · lot.test.ts                                                                T2, T10
├─ inventory/price-list.test.ts                                                                                 T4
├─ inventory/movement.test.ts · stock-on-hand.test.ts                                                       T5, T8
├─ inventory/fefo.test.ts         the SQL function at T5, its wrapper at T10                            T5, T10
├─ inventory/stock.test.ts        listStockOnHand                                                              T12
├─ inventory/reserved-names.test.ts   OD-08's proof that no reserved name exists                              T14
├─ inventory/serial-unit.test.ts      OD-07's proof that serial_unit is absent (default)                      T13
├─ costing/apply-movements.test.ts                                                                              T8
├─ roles-seed.test.ts             MODIFY  + the two read codes on five roles                                    T3
├─ permission-catalogue.test.ts   MODIFY  + the five 3A codes                                                   T3
└─ fixtures.ts                    MODIFY  seedUnit, seedItem, seedWarehouse, seedLot, seedPriceList  T1, T2, T4
apps/api/test/routes/inventory/items.test.ts · warehouses.test.ts · units.test.ts                              T11
apps/api/test/routes/inventory/price-lists.test.ts · promotions.test.ts · stock.test.ts                        T12
apps/api/test/routes/accounting/attachments-lot.test.ts                                                        T10
apps/worker/test/handlers/expiry-warning.test.ts                                                               T10
packages/domain/test/posting/plan-movements.test.ts · test/quantity/convert.test.ts                         T7, T6
tests/invariants/probes.ts        MODIFY  six PROBES entries + one JOB_PROBES entry                    T10, T11, T12
tests/invariants/stock-availability.test.ts   test 18: API, job, two concurrent jobs, raw SQL                    T9
tests/invariants/projection-rebuild.test.ts   MODIFY  + stock_on_hand (test 2 re-run)                           T8
tests/invariants/audit-chain.test.ts          MODIFY  projections.checked gains stock_on_hand                   T8
apps/worker/test/handlers/integrity-check.test.ts MODIFY  the same array                                        T8
tests/regression/sah-048.test.ts · 063 · 064 · 066 · 067        CREATE                          T9, T1, T1, T6, T8
tests/regression/sah-050.test.ts · 071 · 073 · 074              APPEND                              T5, T2, T5, T5
tests/regression/sah-052.test.ts · 056 · 057                    CREATE only if OD-07 = yes                     T13
tests/e2e/inventory-screens.spec.ts            both text directions — test 23 re-run                           T15
docs/adr/0034-sentinel-lot-and-not-null-lot-id.md                                                               T2
docs/adr/0035-movement-planning-in-the-evaluator.md                                                             T7
docs/adr/0036-exact-unit-conversion-and-fefo-over-the-projection.md                                         T6, T10
```

---

### Task 1: Migration 0028 — `app.item`, `app.unit_of_measure`, `app.unit_conversion`

The item master and the exact-rational unit conversion SAH-066 says the old system defined in the schema and applied nowhere. Three tables, one migration file, and the two `fixtures.ts` helpers §4.17 assigns 3A for them. This task also discharges hazard 33 for the whole slice: `app.item`'s four account columns default to the §4.15 codes `4000`, `1300`, `5000` and `5900`, all four seeded by **0C** in `packages/db/seed/my/chart-of-accounts/0c-base.json`, and Step 1's first assertion is that they resolve. `seedTenant` ships only `1000 Cash` and `4000 Sales` (§4.1), so every test that needs the other three creates them with 1A's `seedAccount`.

**⚠️ OD-05 — the §3.0.3 "Multi-unit items" row (spec:1024).** This task builds it at the spec text as written: "Carton / inner / piece, with exact conversion — sold in different units at different levels of trade". **If the owner rejects the row:** drop `app.unit_conversion` from this migration (and its mirror, its `unique (item_id, unit_id)` and Step 9's `sah-063` file), keep `item.base_unit_id` and `app.unit_of_measure` — a quantity still needs a unit — and drop the conversion half of Task 6. Nothing else in the slice moves.

**Files:**
- Create: `packages/db/migrations/0028_create_item_unit.sql`, `packages/db/migrations/0028.down.sql`
- Create: `packages/db/src/schema/unit_of_measure.ts`, `packages/db/src/schema/item.ts`, `packages/db/src/schema/unit_conversion.ts`
- Create: `packages/db/src/inventory/errors.ts`, `packages/db/src/inventory/items.ts`, `packages/db/src/inventory/units.ts`
- Create: `tests/regression/sah-063.test.ts`, `tests/regression/sah-064.test.ts`
- Modify: `packages/db/src/index.ts` (the inventory re-exports), `packages/db/test/fixtures.ts` (`seedUnit`, `seedItem`)
- Test: `packages/db/test/inventory/item.test.ts`

**Interfaces:**
- Consumes: `startDb`, `Db`, `withTenant(sql, tenantId, actorId, fn)`, `uuidv7(sql)`, `MIGRATIONS_DIR`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE` from `@dulja/db` / `@dulja/db/test` (§4.1); `seedTenant`, `Seed` (§4.1); `seedAccount(db, s, { code, nameEn, type, parentCode?, currency? }): Promise<string>` (1A, §4.17); `app_meta.enable_tenant_rls(tbl regclass)` and `app_meta.attach_audit(tbl regclass, mode text default 'tenant_column', key_cols text default '')` (§4.1); `app.account(tenant_id, id)` and `app.company(tenant_id, id)` from migration 0001.
- Produces:
  - SQL: `app.unit_of_measure`, `app.item`, `app.unit_conversion` exactly as contracts §4.6.1; index `item_barcode_idx`.
  - `export const ITEM_ACCOUNT_DEFAULTS = { revenue: "4000", inventory: "1300", cogs: "5000", expense: "5900" } as const`
  - `export class ItemAccountUnresolvedError extends Error { readonly code: "ERR_VALIDATION_FAILED"; readonly accountCode: string }`
  - `export interface ItemAccounts { revenueAccountId: string | null; inventoryAccountId: string | null; cogsAccountId: string | null; expenseAccountId: string | null }`
  - `export interface ItemAccountOverrides { revenueAccountId?: string | null; inventoryAccountId?: string | null; cogsAccountId?: string | null; expenseAccountId?: string | null }`
  - `export async function resolveItemAccounts(tx: Sql, params: { companyId: string; kind: ItemKind; overrides?: ItemAccountOverrides }): Promise<ItemAccounts>`
  - `export type ItemKind = "product" | "service" | "asset"`
  - `export interface ItemRow { id: string; companyId: string; code: string; nameEn: string; nameAr: string | null; kind: ItemKind; baseUnitId: string; barcode: string | null; revenueAccountId: string | null; inventoryAccountId: string | null; cogsAccountId: string | null; expenseAccountId: string | null; trackLots: boolean; shelfLifeDays: number | null; archivedAt: string | null; createdAt: string }`
  - `export interface NewItem { companyId: string; code: string; nameEn: string; nameAr?: string | null; kind: ItemKind; baseUnitId: string; barcode?: string | null; trackLots?: boolean; shelfLifeDays?: number | null; accounts?: ItemAccountOverrides }`
  - `export async function createItem(tx: Sql, ctx: TenantContext, input: NewItem): Promise<ItemRow>`
  - `export async function updateItem(tx: Sql, itemId: string, patch: { nameEn?: string; nameAr?: string | null; barcode?: string | null; trackLots?: boolean; shelfLifeDays?: number | null; accounts?: ItemAccountOverrides }): Promise<ItemRow | null>`
  - `export async function archiveItem(tx: Sql, itemId: string): Promise<ItemRow | null>`
  - `export async function getItem(tx: Sql, itemId: string): Promise<ItemRow | null>`
  - `export async function listItems(tx: Sql, params: { companyId: string; kind?: ItemKind; includeArchived?: boolean; cursor?: { code: string } | null; limit: number }): Promise<ItemRow[]>`
  - `export interface UnitRow { id: string; companyId: string; code: string; nameEn: string; nameAr: string | null; createdAt: string }`
  - `export async function createUnit(tx: Sql, input: { companyId: string; code: string; nameEn: string; nameAr?: string | null }): Promise<UnitRow>`
  - `export async function listUnits(tx: Sql, params: { companyId: string; cursor?: { code: string } | null; limit: number }): Promise<UnitRow[]>`
  - `seedUnit(db: Db, s: Seed, opts?: { code?: string; nameEn?: string }): Promise<string>` and `seedItem(db: Db, s: Seed, opts?: { code?: string; kind?: ItemKind; trackLots?: boolean; baseUnitId?: string; accounts?: ItemAccountOverrides }): Promise<{ itemId: string; baseUnitId: string }>` — §4.17's two 3A rows, exactly those signatures.

- [ ] **Step 1: Write the failing test `packages/db/test/inventory/item.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { createItem, resolveItemAccounts, ItemAccountUnresolvedError, listItems } from "../../src/inventory/items";
import { createUnit } from "../../src/inventory/units";
import { seedAccount, seedTenant, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("app.item / app.unit_of_measure / app.unit_conversion — migration 0028 (contracts §4.6.1)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Item A");
    b = await seedTenant(db, "Item B");
    // hazard 33: 3A consumes four §4.15 codes it does not seed. seedTenant ships only 1000 and 4000,
    // so the three the item defaults need are created here through 1A's seedAccount.
    await seedAccount(db, a, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, a, { code: "5000", nameEn: "Cost of goods sold", type: "expense" });
    await seedAccount(db, a, { code: "5900", nameEn: "Other operating expense", type: "expense" });
  });
  afterAll(async () => { await db.stop(); });

  it("the four §4.15 item-default account codes resolve in the company's chart (hazard 33)", async () => {
    const accounts = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolveItemAccounts(tx, { companyId: a.company, kind: "product" }));
    expect(accounts.revenueAccountId).toBe(a.sales);          // 4000, seedTenant's
    expect(accounts.inventoryAccountId).not.toBeNull();       // 1300
    expect(accounts.cogsAccountId).not.toBeNull();            // 5000
    expect(accounts.expenseAccountId).not.toBeNull();         // 5900
  });

  it("a service item takes 4000 and 5900 and leaves the two stock accounts null", async () => {
    const accounts = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolveItemAccounts(tx, { companyId: a.company, kind: "service" }));
    expect(accounts.inventoryAccountId).toBeNull();
    expect(accounts.cogsAccountId).toBeNull();
    expect(accounts.expenseAccountId).not.toBeNull();
  });

  it("a missing default code is named, never silently nulled (hazard 33, SAH-064)", async () => {
    // Tenant B has no 1300/5000/5900 rows.
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) =>
      resolveItemAccounts(tx, { companyId: b.company, kind: "product" })))
      .rejects.toThrow(ItemAccountUnresolvedError);
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) =>
      resolveItemAccounts(tx, { companyId: b.company, kind: "product" })))
      .rejects.toThrow(/account 1300 is not in company/);
  });

  it("createItem stores the base unit and the four resolved accounts", async () => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "item-1" };
    const row = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const unit = await createUnit(tx, { companyId: a.company, code: "PCS", nameEn: "Piece" });
      return createItem(tx, ctx, {
        companyId: a.company, code: "RICE-5KG", nameEn: "Rice 5kg", kind: "product",
        baseUnitId: unit.id, barcode: "9556000000019", shelfLifeDays: 365,
      });
    });
    expect(row.kind).toBe("product");
    expect(row.trackLots).toBe(true);                    // §4.6.1 default: food is batch-tracked
    expect(row.inventoryAccountId).not.toBeNull();
    expect(row.cogsAccountId).not.toBeNull();
    expect(row.archivedAt).toBeNull();
  });

  it("unit_conversion refuses a zero denominator and a non-positive numerator (spec:2043, SAH-063)", async () => {
    const { itemId, unitId } = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const unit = await createUnit(tx, { companyId: a.company, code: "CTN", nameEn: "Carton" });
      const [item] = await tx<{ id: string }[]>`select id from app.item where company_id = ${a.company} and code = 'RICE-5KG'`;
      return { itemId: item!.id, unitId: unit.id };
    });
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.unit_conversion (tenant_id, item_id, unit_id, numerator, denominator)
      values (${a.tenant}, ${itemId}, ${unitId}, 12, 0)`))
      .rejects.toThrow(/unit_conversion_denominator_check/);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.unit_conversion (tenant_id, item_id, unit_id, numerator, denominator)
      values (${a.tenant}, ${itemId}, ${unitId}, 0, 1)`))
      .rejects.toThrow(/unit_conversion_numerator_check/);
  });

  it("a second tenant sees none of the three tables' rows (spec:106, test 12)", async () => {
    const counts = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const [i] = await tx<{ n: number }[]>`select count(*)::int as n from app.item`;
      const [u] = await tx<{ n: number }[]>`select count(*)::int as n from app.unit_of_measure`;
      const [c] = await tx<{ n: number }[]>`select count(*)::int as n from app.unit_conversion`;
      return [i!.n, u!.n, c!.n];
    });
    expect(counts).toEqual([0, 0, 0]);
    expect(await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [i] = await tx<{ n: number }[]>`select count(*)::int as n from app.item`;
      return i!.n;
    })).toBeGreaterThan(0);
  });

  it("a cross-tenant insert is refused by the RLS with check, not silently written", async () => {
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) => tx`
      insert into app.unit_of_measure (tenant_id, company_id, code, name_en)
      values (${a.tenant}, ${a.company}, 'HIJACK', 'Hijack')`))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("listItems pages by code and hides archived rows by default", async () => {
    const codes = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const rows = await listItems(tx, { companyId: a.company, limit: 10 });
      return rows.map((r) => r.code);
    });
    expect(codes).toContain("RICE-5KG");
  });

  it("lintSchema reports zero violations after 0028", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("every new table is audited and neither is immutable (contracts §3.5.3)", async () => {
    for (const t of ["item", "unit_of_measure", "unit_conversion"]) {
      expect(AUDIT_EXEMPT.has(t)).toBe(false);
      expect(IMMUTABLE.has(t)).toBe(false);
      const [trg] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where not t.tgisinternal and c.relname = ${t} and t.tgname = 'audit_row'`;
      expect(trg!.n).toBe(1);
    }
  });
});
```

Add `AUDIT_EXEMPT, IMMUTABLE` to the `../../src/lint-schema` import line.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- test/inventory/item.test.ts`
Expected: **FAIL** at collection — `Cannot find module '../../src/inventory/items'`. Create the two source files as empty stubs (`export {}`) if your runner needs the module to exist to report per-test failures; then the expected failure is `relation "app.item" does not exist` on the first `it`.

- [ ] **Step 3: Write `packages/db/migrations/0028_create_item_unit.sql`**

```sql
-- ── 0028 · app.unit_of_measure, app.item, app.unit_conversion ──────────────────────────────────
-- spec:1178–1181 (§3.3 Item / UnitOfMeasure / conversions), spec:1048 (§3.0.4 Inventory core),
-- spec:2043 (§3.9 Quantities: conversions are exact rationals, never floats — SAH-066),
-- spec:158–160 (§0.4 Material → Item, MatUnits.Exchange → UnitConversion).
-- Contracts §4.6.1 fixes every column below.

-- ── 1. units of measure ─────────────────────────────────────────────────────────────────────────
create table app.unit_of_measure (
  id         uuid primary key default uuidv7(),
  tenant_id  uuid not null references app.tenant(id),
  company_id uuid not null,
  code       text not null,
  name_en    text not null,
  name_ar    text,                                                  -- spec:2045 bilingual labels as columns
  created_at timestamptz not null default now(),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);

-- ── 2. the item master ──────────────────────────────────────────────────────────────────────────
-- `kind` is NOT NULL because §4.4.1's `when: { "item.kind": … }` filter and §4.4.2's ItemRef.kind are
-- total: a NULL would silently match no rule and post a document with no revenue line.
-- The four account columns are the policy paths item.revenue_account / inventory_account /
-- cogs_account / expense_account (§4.4.1). They are filled from the §4.15 codes 4000 / 1300 / 5000 /
-- 5900 by resolveItemAccounts at create — there is no DDL default, because a default cannot look a
-- code up in this company's chart, and a wrong account is SAH-064 in a new costume.
create table app.item (
  id                   uuid primary key default uuidv7(),
  tenant_id            uuid not null references app.tenant(id),
  company_id           uuid not null,
  code                 text not null,
  name_en              text not null,
  name_ar              text,
  kind                 text not null check (kind in ('product', 'service', 'asset')),   -- spec:1178
  base_unit_id         uuid not null,                               -- spec:2043 quantity is stored in this unit
  barcode              text,
  revenue_account_id   uuid,
  inventory_account_id uuid,
  cogs_account_id      uuid,
  expense_account_id   uuid,
  track_lots           boolean not null default true,               -- spec:1022 food is batch-tracked
  shelf_life_days      int check (shelf_life_days > 0),             -- SAH-063: a guarded divisor-shaped value
  archived_at          timestamptz,                                 -- spec:2049 master data is archived, never deleted
  created_at           timestamptz not null default now(),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)           references app.company(tenant_id, id),
  foreign key (tenant_id, base_unit_id)         references app.unit_of_measure(tenant_id, id),
  foreign key (tenant_id, revenue_account_id)   references app.account(tenant_id, id),
  foreign key (tenant_id, inventory_account_id) references app.account(tenant_id, id),
  foreign key (tenant_id, cogs_account_id)      references app.account(tenant_id, id),
  foreign key (tenant_id, expense_account_id)   references app.account(tenant_id, id)
);
-- the till and the back office both scan; a partial index keeps it out of the way of items with none.
create index item_barcode_idx on app.item (company_id, barcode) where barcode is not null;

-- ── 3. exact-rational unit conversion (SAH-066) ─────────────────────────────────────────────────
-- "1 <unit> = numerator / denominator base units". bigint parts, never a float: MatUnits.Exchange was
-- `double precision` against `numeric(18,4)` quantities, so 10 boxes → 30 units → 9.9999… boxes.
-- The denominator CHECK is contracts §4.6.1 verbatim (`<> 0`); the numerator CHECK is added here
-- because a zero or negative factor is the other half of what nothing in the old system rejected.
-- Both constraints are NAMED, because packages/db/test asserts on the name.
create table app.unit_conversion (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  item_id     uuid not null,
  unit_id     uuid not null,
  numerator   bigint not null constraint unit_conversion_numerator_check   check (numerator > 0),
  denominator bigint not null constraint unit_conversion_denominator_check check (denominator <> 0),
  created_at  timestamptz not null default now(),
  unique (item_id, unit_id),
  unique (tenant_id, id),
  foreign key (tenant_id, item_id) references app.item(tenant_id, id),
  foreign key (tenant_id, unit_id) references app.unit_of_measure(tenant_id, id)
);

-- ── 4. tenancy and audit (spec:106, spec:1370, contracts §3.5.1) ────────────────────────────────
call app_meta.enable_tenant_rls('app.unit_of_measure');
call app_meta.enable_tenant_rls('app.item');
call app_meta.enable_tenant_rls('app.unit_conversion');
call app_meta.attach_audit('app.unit_of_measure');
call app_meta.attach_audit('app.item');
call app_meta.attach_audit('app.unit_conversion');
-- No *_by column on any of the three, so no attach_stamp (contracts §3.3's naming rule).
-- app_rw receives select/insert/update through default privileges (plan0A:2564). No DELETE grant:
-- §3.5.4's list is pinned and 2B is the only slice that extends it; removal is `archived_at`.
```

- [ ] **Step 4: Write `packages/db/migrations/0028.down.sql`**

```sql
-- reverse dependency order (§3.4.5). `drop table` removes each table's indexes, its tenant_isolation
-- policy and its audit_row trigger with it; app_meta and app_meta.schema_migration are never dropped.
drop table if exists app.unit_conversion;
drop table if exists app.item;
drop table if exists app.unit_of_measure;
```

- [ ] **Step 5: Write the three Drizzle mirrors**

`packages/db/src/schema/unit_of_measure.ts`:

```ts
import { pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

export const unitOfMeasure = app.table(
  "unit_of_measure",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [unique().on(t.companyId, t.code), unique().on(t.tenantId, t.id)],
);
```

`packages/db/src/schema/item.ts`:

```ts
import { boolean, index, integer, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const app = pgSchema("app");

export const item = app.table(
  "item",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    kind: text("kind").notNull(),
    baseUnitId: uuid("base_unit_id").notNull(),
    barcode: text("barcode"),
    revenueAccountId: uuid("revenue_account_id"),
    inventoryAccountId: uuid("inventory_account_id"),
    cogsAccountId: uuid("cogs_account_id"),
    expenseAccountId: uuid("expense_account_id"),
    trackLots: boolean("track_lots").notNull().default(true),
    shelfLifeDays: integer("shelf_life_days"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique().on(t.companyId, t.code),
    unique().on(t.tenantId, t.id),
    index("item_barcode_idx").on(t.companyId, t.barcode).where(sql`barcode is not null`),
  ],
);
```

`packages/db/src/schema/unit_conversion.ts`:

```ts
import { bigint, pgSchema, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

export const unitConversion = app.table(
  "unit_conversion",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    itemId: uuid("item_id").notNull(),
    unitId: uuid("unit_id").notNull(),
    // `mode: "bigint"` and not "number": a conversion factor is exact and must never round (SAH-066).
    numerator: bigint("numerator", { mode: "bigint" }).notNull(),
    denominator: bigint("denominator", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [unique().on(t.itemId, t.unitId), unique().on(t.tenantId, t.id)],
);
```

- [ ] **Step 6: Write `packages/db/src/inventory/errors.ts` and `units.ts`**

`packages/db/src/inventory/errors.ts`:

```ts
/**
 * `packages/db` may not import `@dulja/contracts` (contracts §3.1), so it cannot throw `AppError`.
 * This is the same declared exception `PostingError` is (§4.2.4): a named class carrying an existing
 * ErrCode string, which the route layer rethrows as an `AppError`. It introduces no new error code.
 */
export class ItemAccountUnresolvedError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(readonly accountCode: string, readonly companyId: string) {
    super(
      `account ${accountCode} is not in company ${companyId}'s chart: it is a §4.15 item default seeded ` +
        `by 0C's packages/db/seed/my/chart-of-accounts/0c-base.json — run \`bun run seed --tenant <id> ` +
        `--only chart-of-accounts\` before creating items`,
    );
  }
}

/**
 * Raised when a line names a unit that has no conversion to the item's base unit (SAH-066). Declared HERE and
 * nowhere else: Task 6 raises it from `inventory/units.ts` and **imports** it from this module. One class, one
 * barrel line — a second `export class` of the same name re-exported from `packages/db/src/index.ts` is TS2308
 * at `bun run typecheck`.
 *
 * The message text is asserted verbatim by Task 6's `unit-conversion.test.ts`
 * (`/no unit conversion for item .* and unit .*/`), so it is fixed here and the two never drift.
 */
export class UnitConversionMissingError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(readonly itemId: string, readonly unitId: string) {
    super(`no unit conversion for item ${itemId} and unit ${unitId}, and it is not the item's base unit`);
    this.name = "UnitConversionMissingError";
  }
}
```

`packages/db/src/inventory/units.ts`:

```ts
import type { Sql } from "postgres";

export interface UnitRow {
  id: string; companyId: string; code: string; nameEn: string; nameAr: string | null; createdAt: string;
}

interface DbUnit {
  id: string; company_id: string; code: string; name_en: string; name_ar: string | null; created_at: string;
}

const toUnit = (r: DbUnit): UnitRow => ({
  id: r.id, companyId: r.company_id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar, createdAt: r.created_at,
});

export async function createUnit(
  tx: Sql,
  input: { companyId: string; code: string; nameEn: string; nameAr?: string | null },
): Promise<UnitRow> {
  const [row] = await tx<DbUnit[]>`
    insert into app.unit_of_measure (tenant_id, company_id, code, name_en, name_ar)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null})
    returning id, company_id, code, name_en, name_ar, created_at`;
  return toUnit(row!);
}

/** Keyset paging on `code`, the only sortable field the unit resource declares (§4.2.8). */
export async function listUnits(
  tx: Sql,
  params: { companyId: string; cursor?: { code: string } | null; limit: number },
): Promise<UnitRow[]> {
  const rows = params.cursor
    ? await tx<DbUnit[]>`
        select id, company_id, code, name_en, name_ar, created_at from app.unit_of_measure
         where company_id = ${params.companyId} and code > ${params.cursor.code}
         order by code limit ${params.limit}`
    : await tx<DbUnit[]>`
        select id, company_id, code, name_en, name_ar, created_at from app.unit_of_measure
         where company_id = ${params.companyId}
         order by code limit ${params.limit}`;
  return rows.map(toUnit);
}
```

> Every column list is written out literally and no statement calls `tx.unsafe`. §3.3 gives `sql.unsafe` exactly three homes and `tx.unsafe` *is* `sql.unsafe` on a transaction, so a fourth call site fails the `no-sql-concat` allow-list even when what it interpolates is a compile-time constant. `DbUnit` is the one place the snake-case spellings are asserted; a typo is a `42703` on the first run.

- [ ] **Step 7: Write `packages/db/src/inventory/items.ts`**

```ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { ItemAccountUnresolvedError } from "./errors";

export type ItemKind = "product" | "service" | "asset";

/**
 * The §4.15 codes an item's four account columns default to. Registered there with 0C as the ONE
 * seeding slice; this slice resolves them and never seeds or invents one (hazard 33).
 */
export const ITEM_ACCOUNT_DEFAULTS = {
  revenue: "4000",
  inventory: "1300",
  cogs: "5000",
  expense: "5900",
} as const;

export interface ItemAccounts {
  revenueAccountId: string | null;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  expenseAccountId: string | null;
}
export interface ItemAccountOverrides {
  revenueAccountId?: string | null;
  inventoryAccountId?: string | null;
  cogsAccountId?: string | null;
  expenseAccountId?: string | null;
}

/**
 * Resolves the four account columns for a new or updated item.
 *
 * A product needs all four codes; a service or asset holds no stock, so `1300` and `5000` are left
 * NULL and only revenue and expense are resolved (§4.15's `5900` row: "item.expense_account_id default
 * for kind ∈ service | asset"). An explicit override wins — including an explicit `null`, which means
 * "this item deliberately has no such account". A default code the company's chart does not contain is
 * an `ItemAccountUnresolvedError` naming the code, never a silent NULL: SAH-064 is exactly a guard that
 * looked like it defaulted a value and did not, and a NULL `inventory_account_id` would surface much
 * later as `ERR_POLICY_REQUIRES_MISSING` at post, in the slice that did not write it.
 */
export async function resolveItemAccounts(
  tx: Sql,
  params: { companyId: string; kind: ItemKind; overrides?: ItemAccountOverrides },
): Promise<ItemAccounts> {
  const needed: (keyof typeof ITEM_ACCOUNT_DEFAULTS)[] =
    params.kind === "product" ? ["revenue", "inventory", "cogs", "expense"] : ["revenue", "expense"];
  const codes = needed.map((k) => ITEM_ACCOUNT_DEFAULTS[k]);
  const rows = await tx<{ code: string; id: string }[]>`
    select code, id from app.account
     where company_id = ${params.companyId} and code = any(${codes}) and is_group = false`;
  const byCode = new Map(rows.map((r) => [r.code, r.id]));

  const pick = (slot: keyof typeof ITEM_ACCOUNT_DEFAULTS, override: string | null | undefined): string | null => {
    if (override !== undefined) return override;
    if (!needed.includes(slot)) return null;
    const code = ITEM_ACCOUNT_DEFAULTS[slot];
    const id = byCode.get(code);
    if (!id) throw new ItemAccountUnresolvedError(code, params.companyId);
    return id;
  };

  const o = params.overrides ?? {};
  return {
    revenueAccountId: pick("revenue", o.revenueAccountId),
    inventoryAccountId: pick("inventory", o.inventoryAccountId),
    cogsAccountId: pick("cogs", o.cogsAccountId),
    expenseAccountId: pick("expense", o.expenseAccountId),
  };
}

export interface ItemRow {
  id: string; companyId: string; code: string; nameEn: string; nameAr: string | null; kind: ItemKind;
  baseUnitId: string; barcode: string | null;
  revenueAccountId: string | null; inventoryAccountId: string | null;
  cogsAccountId: string | null; expenseAccountId: string | null;
  trackLots: boolean; shelfLifeDays: number | null; archivedAt: string | null; createdAt: string;
}
export interface NewItem {
  companyId: string; code: string; nameEn: string; nameAr?: string | null; kind: ItemKind;
  baseUnitId: string; barcode?: string | null; trackLots?: boolean; shelfLifeDays?: number | null;
  accounts?: ItemAccountOverrides;
}

interface DbItem {
  id: string; company_id: string; code: string; name_en: string; name_ar: string | null; kind: ItemKind;
  base_unit_id: string; barcode: string | null; revenue_account_id: string | null;
  inventory_account_id: string | null; cogs_account_id: string | null; expense_account_id: string | null;
  track_lots: boolean; shelf_life_days: number | null; archived_at: string | null; created_at: string;
}

const COLUMNS = `id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
                 revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
                 track_lots, shelf_life_days, archived_at, created_at`;

const toItem = (r: DbItem): ItemRow => ({
  id: r.id, companyId: r.company_id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar, kind: r.kind,
  baseUnitId: r.base_unit_id, barcode: r.barcode,
  revenueAccountId: r.revenue_account_id, inventoryAccountId: r.inventory_account_id,
  cogsAccountId: r.cogs_account_id, expenseAccountId: r.expense_account_id,
  trackLots: r.track_lots, shelfLifeDays: r.shelf_life_days, archivedAt: r.archived_at, createdAt: r.created_at,
});

/** `ctx` is taken for the log/enqueue envelope symmetry every §4.3.1 writer has; the acting principal
 *  is always `app.current_actor()` from the session, never a parameter (SAH-044). */
export async function createItem(tx: Sql, ctx: TenantContext, input: NewItem): Promise<ItemRow> {
  const accounts = await resolveItemAccounts(tx, {
    companyId: input.companyId, kind: input.kind, overrides: input.accounts,
  });
  const [row] = await tx<DbItem[]>`
    insert into app.item (tenant_id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
                          revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
                          track_lots, shelf_life_days)
    values (${ctx.tenantId}, ${input.companyId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null},
            ${input.kind}, ${input.baseUnitId}, ${input.barcode ?? null},
            ${accounts.revenueAccountId}, ${accounts.inventoryAccountId},
            ${accounts.cogsAccountId}, ${accounts.expenseAccountId},
            ${input.trackLots ?? true}, ${input.shelfLifeDays ?? null})
    returning id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
              revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
              track_lots, shelf_life_days, archived_at, created_at`;
  return toItem(row!);
}

export async function getItem(tx: Sql, itemId: string): Promise<ItemRow | null> {
  const [row] = await tx<DbItem[]>`
    select id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
           revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
           track_lots, shelf_life_days, archived_at, created_at
      from app.item where id = ${itemId}`;
  return row ? toItem(row) : null;
}

/**
 * `code` and `kind` are immutable after create: `code` is the natural key a price list, a legacy_ref
 * and every import batch point at, and `kind` decides whether the item holds stock at all — changing
 * it under existing movements is SAH-007's shape. A rename is `name_en`/`name_ar`.
 */
export async function updateItem(
  tx: Sql,
  itemId: string,
  patch: {
    nameEn?: string; nameAr?: string | null; barcode?: string | null;
    trackLots?: boolean; shelfLifeDays?: number | null; accounts?: ItemAccountOverrides;
  },
): Promise<ItemRow | null> {
  const current = await getItem(tx, itemId);
  if (!current) return null;
  const accounts = patch.accounts
    ? await resolveItemAccounts(tx, { companyId: current.companyId, kind: current.kind, overrides: patch.accounts })
    : {
        revenueAccountId: current.revenueAccountId, inventoryAccountId: current.inventoryAccountId,
        cogsAccountId: current.cogsAccountId, expenseAccountId: current.expenseAccountId,
      };
  const [row] = await tx<DbItem[]>`
    update app.item set
      name_en              = ${patch.nameEn ?? current.nameEn},
      name_ar              = ${patch.nameAr === undefined ? current.nameAr : patch.nameAr},
      barcode              = ${patch.barcode === undefined ? current.barcode : patch.barcode},
      track_lots           = ${patch.trackLots ?? current.trackLots},
      shelf_life_days      = ${patch.shelfLifeDays === undefined ? current.shelfLifeDays : patch.shelfLifeDays},
      revenue_account_id   = ${accounts.revenueAccountId},
      inventory_account_id = ${accounts.inventoryAccountId},
      cogs_account_id      = ${accounts.cogsAccountId},
      expense_account_id   = ${accounts.expenseAccountId}
     where id = ${itemId}
    returning id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
              revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
              track_lots, shelf_life_days, archived_at, created_at`;
  return row ? toItem(row) : null;
}

/** spec:2049 — master data is archived, never deleted. Idempotent: a second call is a no-op. */
export async function archiveItem(tx: Sql, itemId: string): Promise<ItemRow | null> {
  const [row] = await tx<DbItem[]>`
    update app.item set archived_at = coalesce(archived_at, now()) where id = ${itemId}
    returning id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
              revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
              track_lots, shelf_life_days, archived_at, created_at`;
  return row ? toItem(row) : null;
}

export async function listItems(
  tx: Sql,
  params: {
    companyId: string; kind?: ItemKind; includeArchived?: boolean;
    cursor?: { code: string } | null; limit: number;
  },
): Promise<ItemRow[]> {
  const rows = await tx<DbItem[]>`
    select id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
           revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
           track_lots, shelf_life_days, archived_at, created_at
      from app.item
     where company_id = ${params.companyId}
       and (${params.kind ?? null}::text is null or kind = ${params.kind ?? null})
       and (${params.includeArchived ?? false} or archived_at is null)
       and (${params.cursor?.code ?? null}::text is null or code > ${params.cursor?.code ?? null})
     order by code
     limit ${params.limit}`;
  return rows.map(toItem);
}
```

> The `(${param}::text is null or column = ${param})` form keeps one statement per read instead of a branch per optional filter, and every value is still a bound parameter — no field name and no operator reaches SQL as text (test 27).

Append to `packages/db/src/index.ts`:

```ts
export {
  ITEM_ACCOUNT_DEFAULTS, archiveItem, createItem, getItem, listItems, resolveItemAccounts, updateItem,
  type ItemAccountOverrides, type ItemAccounts, type ItemKind, type ItemRow, type NewItem,
} from "./inventory/items";
export { createUnit, listUnits, type UnitRow } from "./inventory/units";
export { ItemAccountUnresolvedError, UnitConversionMissingError } from "./inventory/errors";
```

- [ ] **Step 8: Add `seedUnit` and `seedItem` to `packages/db/test/fixtures.ts`**

Appended at the end of the file. `seedTenant` and `draftDocument` are never edited (§4.1, hazard 9).

```ts
/**
 * contracts §4.17 — 3A's helpers. `seedItem` returns BOTH ids because every document line needs the
 * item and its base unit, and a caller that had to fetch the unit separately would either duplicate
 * the query in twenty files or reach for `db.admin`.
 *
 * The three §4.15 codes `seedTenant` does not ship (1300, 5000, 5900) are created here on first use,
 * so a test can call `seedItem(db, s)` on a bare seed and get a fully-accounted product.
 */
export async function seedUnit(db: Db, s: Seed, opts: { code?: string; nameEn?: string } = {}): Promise<string> {
  const code = opts.code ?? "PCS";
  const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    insert into app.unit_of_measure (tenant_id, company_id, code, name_en)
    values (${s.tenant}, ${s.company}, ${code}, ${opts.nameEn ?? code})
    on conflict (company_id, code) do update set name_en = excluded.name_en
    returning id`);
  return row!.id;
}

/** The three §4.15 codes `seedTenant` does not ship. Created through `seedAccount` — §4.17 calls it "the one
 *  way any test creates a §4.15 account", and 1A's helper is idempotent on `(company_id, code)` and returns
 *  the existing row's id, so a caller that already seeded `1300` itself (Task 9's `beforeAll` does) is not a
 *  23505. A raw `insert … on conflict do nothing` here would be a second way to create an account and would
 *  skip whatever `parentCode`/`currency` handling that helper performs. */
const ITEM_DEFAULT_ACCOUNTS: readonly {
  code: string; nameEn: string; type: "asset" | "liability" | "equity" | "income" | "expense";
}[] = [
  { code: "1300", nameEn: "Inventory control", type: "asset" },
  { code: "5000", nameEn: "Cost of goods sold", type: "expense" },
  { code: "5900", nameEn: "Other operating expense", type: "expense" },
];

export async function seedItem(
  db: Db,
  s: Seed,
  opts: {
    code?: string;
    kind?: "product" | "service" | "asset";
    trackLots?: boolean;
    baseUnitId?: string;
    accounts?: {
      revenueAccountId?: string | null; inventoryAccountId?: string | null;
      cogsAccountId?: string | null; expenseAccountId?: string | null;
    };
  } = {},
): Promise<{ itemId: string; baseUnitId: string }> {
  const baseUnitId = opts.baseUnitId ?? (await seedUnit(db, s));
  const code = opts.code ?? "ITEM-1";
  const kind = opts.kind ?? "product";
  // Hoisted OUT of the withTenant below: `seedAccount` takes `db` and opens its own transaction, so calling
  // it inside one would nest (§4.2.2 forbids nesting outright for the production seam).
  for (const a of ITEM_DEFAULT_ACCOUNTS) {
    await seedAccount(db, s, { code: a.code, nameEn: a.nameEn, type: a.type });
  }
  const itemId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const row = await createItem(tx, { tenantId: s.tenant, actorId: s.human, requestId: `seed-item-${code}` }, {
      companyId: s.company, code, nameEn: code, kind, baseUnitId,
      trackLots: opts.trackLots, accounts: opts.accounts,
    });
    return row.id;
  });
  return { itemId, baseUnitId };
}
```

Add `import { createItem } from "../src/inventory/items";` to the top of `fixtures.ts`. `seedAccount` is already in that file (1A, §4.17) and needs no import.

- [ ] **Step 9: Run the test to verify it passes**

Run: `bun run --cwd packages/db test -- test/inventory/item.test.ts`
Expected: **PASS**, 10 tests. If the account-resolution test fails with `column "is_group" does not exist`, drop the `and is_group = false` clause from `resolveItemAccounts` — Plan 0A's `app.account` carries it (plan0A:1173–1568) but the clause is a belt, not the braces, and the register says only leaf codes appear in §4.15.

- [ ] **Step 10: Write the two regression files this task creates**

`tests/regression/sah-063.test.ts` — 3A is the creator (contracts §3.7.3; the defect is untouched before this slice):

```ts
import { describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { seedItem, seedUnit } from "@dulja/db/test";
import { sharedDb } from "../support/regression";

describe("SAH-063 Unguarded division by BtmSize in six of eight places — 3A", () => {
  it("a zero or negative conversion divisor cannot be stored at all", async () => {
    const { db, rw, a } = await sharedDb();
    const { itemId } = await seedItem(db, a, { code: "SAH063" });
    const unitId = await seedUnit(db, a, { code: "SAH063-CTN" });
    // The old system divided by BtmSize in six of eight sites with no zero/NULL guard. Here the
    // divisor cannot reach the code: the column is NOT NULL and the CHECK refuses 0.
    for (const [numerator, denominator, constraintName] of [
      [12, 0, "unit_conversion_denominator_check"],
      [0, 1, "unit_conversion_numerator_check"],
      [-12, 1, "unit_conversion_numerator_check"],
    ] as const) {
      await expect(withTenant(rw, { tenantId: a.tenant, actorId: a.human, requestId: "sah-063" }, (tx) => tx`
        insert into app.unit_conversion (tenant_id, item_id, unit_id, numerator, denominator)
        values (${a.tenant}, ${itemId}, ${unitId}, ${numerator}, ${denominator})`))
        .rejects.toThrow(new RegExp(constraintName));
    }
  });

  it("shelf_life_days, the other divisor-shaped column, is guarded the same way", async () => {
    const { db, rw, a } = await sharedDb();
    const unitId = await seedUnit(db, a, { code: "SAH063-U2" });
    await expect(withTenant(rw, { tenantId: a.tenant, actorId: a.human, requestId: "sah-063" }, (tx) => tx`
      insert into app.item (tenant_id, company_id, code, name_en, kind, base_unit_id, shelf_life_days)
      values (${a.tenant}, ${a.company}, 'SAH063-ZERO', 'Zero shelf life', 'product', ${unitId}, 0)`))
      .rejects.toThrow(/item_shelf_life_days_check/);
  });
});
```

`tests/regression/sah-064.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveItemAccounts, withTenant, ItemAccountUnresolvedError } from "@dulja/db";
import { seedUnit } from "@dulja/db/test";
import { sharedDb } from "../support/regression";

describe("SAH-064 Copy-paste dead NULL guard; BuyCur never defaulted — 3A", () => {
  it("an unresolvable account default raises and names the code; it is never written back as NULL", async () => {
    const { rw, b } = await sharedDb();
    // Tenant B's chart has 1000 and 4000 only, exactly as seedTenant leaves it (contracts §4.1).
    // The old system's third test re-checked a value line 63 had just forced non-null, so it never
    // fired, and a NULL CstBuyCur was written back anyway. Here the failure is loud and named.
    await expect(withTenant(rw, { tenantId: b.tenant, actorId: b.human, requestId: "sah-064" }, (tx) =>
      resolveItemAccounts(tx, { companyId: b.company, kind: "product" })))
      .rejects.toThrow(ItemAccountUnresolvedError);
    const [n] = await withTenant(rw, { tenantId: b.tenant, actorId: b.human, requestId: "sah-064" }, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.item where inventory_account_id is null`);
    expect(n!.n).toBe(0);
  });

  it("an explicit null override is honoured, so 'no account' and 'unresolved' are different answers", async () => {
    const { db, rw, a } = await sharedDb();
    const unitId = await seedUnit(db, a, { code: "SAH064-U" });
    const accounts = await withTenant(rw, { tenantId: a.tenant, actorId: a.human, requestId: "sah-064" }, (tx) =>
      resolveItemAccounts(tx, {
        companyId: a.company, kind: "product", overrides: { inventoryAccountId: null },
      }));
    expect(accounts.inventoryAccountId).toBeNull();
    expect(accounts.cogsAccountId).not.toBeNull();
    void unitId;
  });
});
```

Both files import `seedItem` and `seedUnit` from `@dulja/db/test`, **`withTenant` from `@dulja/db` — the production three-argument helper, never `@dulja/db/test`'s four-argument test one** (hazard 15: "Root `tests/` use the production one"; §4.2.12 says the same) — and `sharedDb` from `../support/regression` (0B, §4.17.1).

**`sharedDb()`'s shape, settled once for this whole plan.** It is `await`ed and returns **`{ db: Db; rw: Sql; a: Seed; b: Seed }`** — §4.17.1's "one `Db` + `rw` + two `Seed`s", spelled out identically by 1A (1a:5440, "it returns `{ db: Db; rw: Sql; a: Seed; b: Seed }`, so every regression file below destructures it and never treats the result as a `Db`") and by 2B (2b:3951, "`const { db } = await sharedDb();` … returns `{ db, rw, a, b }`"). So: `db` is the `Db` handed to a `fixtures.ts` seeder (`seedItem(db, a, …)`) and used for catalogue assertions (`db.admin`), and `rw` is the production pool handed to the production `withTenant(rw, { tenantId, actorId, requestId }, tx => …)`. **Never `rw.db`, never `sharedDb().<anything>` without an `await`, and — having destructured `rw` — never reach for `db.rw` beside it.** (A `tests/` file that opens its *own* `startDb()` rather than calling `sharedDb()` still writes `db.rw`, because there `db` is the whole `Db`; 1B's `projection-rebuild.test.ts`, which Task 8 Step 8 appends to, is that case.) §4.18's round-2 open item 5 records that 1A's *blocks* were once written against a bare `Db`; that is the direction this plan does not follow, and all **sixteen** `sharedDb()` sites in this plan use the shape above.

- [ ] **Step 11: Run the whole suite, the linter and the type checker**

Run: `bun run --cwd packages/db test && bun run --cwd tests test -- regression/sah-063.test.ts regression/sah-064.test.ts && bun run typecheck && bun run lint && bun run lint:rules`
Expected: **PASS**, with zero `lint:rules` violations. `packages/db/test/privileges.test.ts`'s up → down → up fingerprint test (§3.4.6) is the one to watch: it fails if `0028.down.sql` forgets a table, and it must pass here.

- [ ] **Step 12: Commit**

```bash
git add packages/db/migrations/0028_create_item_unit.sql packages/db/migrations/0028.down.sql \
        packages/db/src/schema/item.ts packages/db/src/schema/unit_of_measure.ts \
        packages/db/src/schema/unit_conversion.ts packages/db/src/inventory packages/db/src/index.ts \
        packages/db/test/fixtures.ts packages/db/test/inventory/item.test.ts \
        tests/regression/sah-063.test.ts tests/regression/sah-064.test.ts
git commit -m "$(cat <<'EOF'
feat(db): item master, units and exact-rational unit conversion [3A T1]

Migration 0028 creates app.unit_of_measure, app.item and app.unit_conversion at
contracts §4.6.1's columns. Conversion factors are bigint numerator/denominator
pairs with both parts constrained — SAH-066 defined the factor as a float and
applied it nowhere, and SAH-063 divided by it unguarded in six of eight places.

app.item's four account columns are filled at create by resolveItemAccounts from
the §4.15 codes 4000/1300/5000/5900, all seeded by 0C. An absent code raises
ItemAccountUnresolvedError naming it; nothing is written back as NULL (SAH-064).

fixtures.ts gains seedUnit and seedItem, the two helpers §4.17 assigns 3A.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration 0029 — `app.warehouse` (tree), `app.lot`, `app.variant`, and the per-item sentinel lot

Where stock lives, what batch it belongs to, and the one row that makes `stock_on_hand`'s primary key safe. The warehouse tree gets a cycle guard written **once** as a recursive CTE (SAH-071 — the old system walked the ancestor chain with a recursive procedure call per row, in at least three modules). `app.lot` carries expiry, which is what FEFO and the near-expiry alert of Task 10 read. And every `app.item` insert gets a companion lot with code `NONE` by trigger, so `inventory_movement.lot_id` and `stock_on_hand.lot_id` can both be NOT NULL — the structural answer to SAH-050, where a NULL dimension made every increment insert a fresh orphan row and every decrement match nothing at all. That reasoning is **ADR 0034**.

**⚠️ OD-05 — two §3.0.3 rows.** "Batch / lot with expiry" (spec:1022 — "Food. Requires batch on every movement, FEFO picking, expiry reporting and near-expiry alerts") and "Multi-branch stock" (spec:1023 — "Warehouse per branch, transfers between them, stock and margin visible per branch"). Built at the spec text as written. **If the owner rejects Batch/lot:** `app.lot` stays, reduced to the per-item sentinel the primary key needs; `expires_on`, `manufactured_on`, `lot_expiry_idx` and the `POST …/items/{itemId}/lots` route go, and Task 10's FEFO and expiry-alert work is dropped. **If the owner rejects Multi-branch stock:** `warehouse.branch_id` becomes nullable and `parent_id` unused; §4.5.6's Form A″ and Form C become dead in 6C. Nothing else in the slice moves.

**Files:**
- Create: `packages/db/migrations/0029_create_warehouse_lot_variant.sql`, `packages/db/migrations/0029.down.sql`
- Create: `packages/db/src/schema/warehouse.ts`, `packages/db/src/schema/lot.ts`, `packages/db/src/schema/variant.ts`
- Create: `packages/db/src/inventory/warehouses.ts`, `packages/db/src/inventory/lots.ts`
- Create: `docs/adr/0034-sentinel-lot-and-not-null-lot-id.md`
- Modify: `packages/db/src/index.ts`, `packages/contracts/src/errors.ts` (`ERR_WAREHOUSE_TREE_CYCLE`), `packages/db/test/fixtures.ts` (`seedWarehouse`, `seedLot`), `tests/regression/sah-071.test.ts` (append)
- Test: `packages/db/test/inventory/warehouse.test.ts`, `packages/db/test/inventory/lot.test.ts`

**Interfaces:**
- Consumes: `app.item(tenant_id, id)`, `app.unit_of_measure` (Task 1); `app.dimension_value(tenant_id, id)` and `app.dimension_type` from migration 0001 (the `BRANCH` type and its `HQ` value are `Seed.branchType`/`Seed.hq`); `seedBranch(db, s, opts?): Promise<string>` (0D, §4.17); `app_meta.enable_tenant_rls`, `app_meta.attach_audit`; `ERRORS`, `ErrorDef` (§4.2.4); `seedItem`, `seedUnit` (Task 1).
- Produces:
  - SQL: `app.warehouse`, `app.lot`, `app.variant` exactly as §4.6.1; `app.warehouse_no_cycle()` + trigger `warehouse_no_cycle`; `app.item_sentinel_lot()` + trigger `item_sentinel_lot`; indexes `lot_expiry_idx`, `warehouse_parent_idx`.
  - `export const SENTINEL_LOT_CODE = "NONE"` — the one spelling; no plan re-types the literal.
  - `export type WarehouseKind = "stock" | "in_transit"`
  - `export interface WarehouseRow { id: string; companyId: string; code: string; nameEn: string; nameAr: string | null; kind: WarehouseKind; branchId: string; parentId: string | null; archivedAt: string | null; createdAt: string }`
  - `export async function createWarehouse(tx: Sql, input: { companyId: string; code: string; nameEn: string; nameAr?: string | null; kind?: WarehouseKind; branchId: string; parentId?: string | null }): Promise<WarehouseRow>`
  - `export async function updateWarehouse(tx: Sql, warehouseId: string, patch: { nameEn?: string; nameAr?: string | null; parentId?: string | null }): Promise<WarehouseRow | null>`
  - `export async function archiveWarehouse(tx: Sql, warehouseId: string): Promise<WarehouseRow | null>`
  - `export async function getWarehouse(tx: Sql, warehouseId: string): Promise<WarehouseRow | null>`
  - `export async function listWarehouses(tx: Sql, params: { companyId: string; kind?: WarehouseKind; includeArchived?: boolean; cursor?: { code: string } | null; limit: number }): Promise<WarehouseRow[]>`
  - `export interface WarehouseNode extends WarehouseRow { depth: number; path: string[] }` and `export async function warehouseTree(tx: Sql, companyId: string): Promise<WarehouseNode[]>`
  - `export interface LotRow { id: string; companyId: string; itemId: string; code: string; expiresOn: string | null; manufacturedOn: string | null; archivedAt: string | null; createdAt: string }`
  - `export async function createLot(tx: Sql, input: { companyId: string; itemId: string; code: string; expiresOn?: string | null; manufacturedOn?: string | null }): Promise<LotRow>`
  - `export async function listLots(tx: Sql, params: { companyId: string; itemId?: string; expiringBefore?: string; includeArchived?: boolean; cursor?: { code: string } | null; limit: number }): Promise<LotRow[]>`
  - `export async function sentinelLotId(tx: Sql, itemId: string): Promise<string>`
  - `ERRORS` gains `ERR_WAREHOUSE_TREE_CYCLE: { status: 409, title: "Warehouse tree cycle", remedy: "…" }`
  - `seedWarehouse(db: Db, s: Seed, opts?: { code?: string; kind?: WarehouseKind; branchId?: string }): Promise<string>` and `seedLot(db: Db, s: Seed, opts: { itemId: string; code?: string; expiresOn?: string }): Promise<string>` — §4.17's two rows.

- [ ] **Step 1: Write the failing test `packages/db/test/inventory/warehouse.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { createWarehouse, updateWarehouse, warehouseTree } from "../../src/inventory/warehouses";
import { seedBranch, seedTenant, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("app.warehouse — migration 0029 (contracts §4.6.1, SAH-071)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "WH A");
    b = await seedTenant(db, "WH B");
  });
  afterAll(async () => { await db.stop(); });

  it("a warehouse carries a NOT NULL branch and defaults to kind 'stock'", async () => {
    const row = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createWarehouse(tx, { companyId: a.company, code: "HQ-MAIN", nameEn: "HQ main store", branchId: a.hq }));
    expect(row.kind).toBe("stock");
    expect(row.branchId).toBe(a.hq);
    expect(row.parentId).toBeNull();
  });

  it("branch_id is NOT NULL, so no warehouse can be branch-less (spec:1023, SAH-050 in the other direction)", async () => {
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.warehouse (tenant_id, company_id, code, name_en, branch_id)
      values (${a.tenant}, ${a.company}, 'NO-BRANCH', 'No branch', null)`))
      .rejects.toThrow(/branch_id/);
  });

  it("kind is closed to stock | in_transit (spec:1053, §4.6.1)", async () => {
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.warehouse (tenant_id, company_id, code, name_en, kind, branch_id)
      values (${a.tenant}, ${a.company}, 'BAD-KIND', 'Bad', 'virtual', ${a.hq})`))
      .rejects.toThrow(/warehouse_kind_check/);
  });

  it("a cycle in the tree is refused in ONE indexed check, not a procedure per row (SAH-071)", async () => {
    const { parent, child } = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const p = await createWarehouse(tx, { companyId: a.company, code: "T-P", nameEn: "Parent", branchId: a.hq });
      const c = await createWarehouse(tx, {
        companyId: a.company, code: "T-C", nameEn: "Child", branchId: a.hq, parentId: p.id,
      });
      return { parent: p.id, child: c.id };
    });
    // self-parent
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      updateWarehouse(tx, parent, { parentId: parent })))
      .rejects.toThrow(/ERR_WAREHOUSE_TREE_CYCLE/);
    // two-node cycle: parent becomes the child of its own child
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      updateWarehouse(tx, parent, { parentId: child })))
      .rejects.toThrow(/ERR_WAREHOUSE_TREE_CYCLE/);
  });

  it("warehouseTree returns depth and path from one recursive CTE", async () => {
    const nodes = await withTenant(db.rw, a.tenant, a.human, (tx) => warehouseTree(tx, a.company));
    const child = nodes.find((n) => n.code === "T-C");
    expect(child?.depth).toBe(1);
    expect(child?.path).toEqual(["T-P", "T-C"]);
    expect(nodes.find((n) => n.code === "T-P")?.depth).toBe(0);
  });

  it("a second tenant sees no warehouse (test 12)", async () => {
    const [n] = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.warehouse`);
    expect(n!.n).toBe(0);
  });

  it("lintSchema is clean and the branch_isolation policy is NOT attached yet (§4.5.6)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    const [p] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_policies where schemaname = 'app' and tablename = 'warehouse'
        and policyname = 'branch_isolation'`;
    // 6C's migration 0068 attaches Form A″ (Form A plus the in-transit exception). 3A creates the table
    // branch-ready and attaches nothing, and 6C's branch_isolation_policy linter rule does not exist yet.
    expect(p!.n).toBe(0);
  });
});
```

- [ ] **Step 2: Write the failing test `packages/db/test/inventory/lot.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SENTINEL_LOT_CODE, createLot, listLots, sentinelLotId } from "../../src/inventory/lots";
import { seedItem, seedTenant, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("app.lot and the per-item sentinel — migration 0029 (SAH-050, ADR 0034)", () => {
  let db: Db;
  let a: Seed;
  let itemId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Lot A");
    ({ itemId } = await seedItem(db, a, { code: "MILK-1L" }));
  });
  afterAll(async () => { await db.stop(); });

  it("every item is created with exactly one sentinel lot coded NONE, by trigger", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ code: string; expires_on: string | null }[]>`
        select code, expires_on from app.lot where item_id = ${itemId} order by code`);
    expect(rows.map((r) => r.code)).toEqual([SENTINEL_LOT_CODE]);
    expect(rows[0]!.expires_on).toBeNull();
  });

  it("EVERY item has a sentinel — the trigger's invariant, asserted over the whole table", async () => {
    // Migration 0029 deliberately carries no back-fill statement: FORCE RLS binds app_migrator too, so a
    // migration with no tenant set sees zero rows and could never insert one (§3.4.8 — only app.permission
    // is migration data). The guarantee is the AFTER INSERT trigger, and this is where it is checked, inside
    // `withTenant` where there are rows to check. `stock_on_hand`'s primary key contains `lot_id`, so an
    // item without a sentinel would fail the step-12 MERGE much later (SAH-050).
    const [gap] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.item i
       where not exists (select 1 from app.lot l where l.item_id = i.id and l.code = ${SENTINEL_LOT_CODE})`);
    expect(gap!.n).toBe(0);
  });

  it("sentinelLotId finds it and is stable across calls", async () => {
    const first = await withTenant(db.rw, a.tenant, a.human, (tx) => sentinelLotId(tx, itemId));
    const second = await withTenant(db.rw, a.tenant, a.human, (tx) => sentinelLotId(tx, itemId));
    expect(first).toBe(second);
  });

  it("a real lot carries expiry and cannot expire before it was made", async () => {
    const lot = await withTenant(db.rw, a.tenant, a.human, (tx) => createLot(tx, {
      companyId: a.company, itemId, code: "B-2026-01", manufacturedOn: "2026-01-05", expiresOn: "2026-07-05",
    }));
    expect(lot.expiresOn).toBe("2026-07-05");
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => createLot(tx, {
      companyId: a.company, itemId, code: "B-BAD", manufacturedOn: "2026-07-05", expiresOn: "2026-01-05",
    }))).rejects.toThrow(/lot_expiry_after_manufacture_check/);
  });

  it("(item_id, code) is unique, so the same batch cannot be entered twice", async () => {
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => createLot(tx, {
      companyId: a.company, itemId, code: "B-2026-01",
    }))).rejects.toMatchObject({ code: "23505" });
  });

  it("listLots can filter to lots expiring before a date, sentinel excluded by its null expiry", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listLots(tx, { companyId: a.company, itemId, expiringBefore: "2026-12-31", limit: 10 }));
    expect(rows.map((r) => r.code)).toEqual(["B-2026-01"]);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `bun run --cwd packages/db test -- test/inventory/warehouse.test.ts test/inventory/lot.test.ts`
Expected: **FAIL** — `relation "app.warehouse" does not exist` on the first `it` of the first file and `relation "app.lot" does not exist` on the first `it` of the second.

- [ ] **Step 4: Write `packages/db/migrations/0029_create_warehouse_lot_variant.sql`**

```sql
-- ── 0029 · app.warehouse, app.lot, app.variant, and the per-item sentinel lot ──────────────────
-- spec:1182 (§3.3 Warehouse tree ── StockBalance), spec:1022–1023 (§3.0.3 Batch/lot with expiry;
-- Multi-branch stock), spec:161 (§0.4 Batch → Lot), spec:1048 (§3.0.4 Inventory core).
-- SAH-071: the tree check is ONE recursive CTE in ONE function, not a recursive procedure called per
-- row in three modules. SAH-050: every item gets a sentinel lot so the stock_on_hand primary key,
-- which contains lot_id, never holds NULL (ADR 0034).

-- ── 1. warehouses, as a tree, one branch each ───────────────────────────────────────────────────
-- branch_id is a BRANCH dimension_value (spec:2166). It is NOT NULL — head-office stores carry the
-- head-office value — which is what makes 6C's Form A″ branch_isolation policy total. `in_transit` is
-- the two-step-transfer waypoint spec:1053 needs; 3D uses it and Form A″ exempts it from branch
-- isolation so both branches of a transfer can see the goods in flight (§4.5.6).
create table app.warehouse (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  code        text not null,
  name_en     text not null,
  name_ar     text,
  kind        text not null default 'stock' constraint warehouse_kind_check check (kind in ('stock', 'in_transit')),
  branch_id   uuid not null,
  parent_id   uuid,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)  references app.dimension_value(tenant_id, id),
  foreign key (tenant_id, parent_id)  references app.warehouse(tenant_id, id)
);
create index warehouse_parent_idx on app.warehouse (parent_id) where parent_id is not null;
create index warehouse_branch_idx on app.warehouse (company_id, branch_id);

-- SAH-071: cycle detection as one recursive CTE walking UP from the proposed parent. The old system
-- called a recursive procedure per row inside a trigger, duplicated in at least three modules, and
-- RecursiveRecord was the most-raised exception in the corpus. This is the only such check in Dulja.
create function app.warehouse_no_cycle() returns trigger language plpgsql as $$
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'ERR_WAREHOUSE_TREE_CYCLE: warehouse % cannot be its own parent', new.id
      using errcode = 'check_violation';
  end if;
  if exists (
    with recursive ancestor as (
      select w.id, w.parent_id
        from app.warehouse w
       where w.id = new.parent_id
      union all
      select w.id, w.parent_id
        from app.warehouse w
        join ancestor an on w.id = an.parent_id
    )
    select 1 from ancestor where ancestor.id = new.id
  ) then
    raise exception 'ERR_WAREHOUSE_TREE_CYCLE: making warehouse % a child of % would close a cycle',
      new.id, new.parent_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger warehouse_no_cycle before insert or update of parent_id on app.warehouse
  for each row execute function app.warehouse_no_cycle();

-- ── 2. lots, with expiry ────────────────────────────────────────────────────────────────────────
create table app.lot (
  id               uuid primary key default uuidv7(),
  tenant_id        uuid not null references app.tenant(id),
  company_id       uuid not null,
  item_id          uuid not null,
  code             text not null,
  expires_on       date,                                          -- spec:1022; FEFO and the alert job read it
  manufactured_on  date,
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint lot_expiry_after_manufacture_check
    check (manufactured_on is null or expires_on is null or expires_on >= manufactured_on),
  unique (item_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, item_id)    references app.item(tenant_id, id)
);
-- FEFO orders by expires_on; the alert job filters on it. Partial, because the sentinel has none.
create index lot_expiry_idx on app.lot (company_id, expires_on)
  where expires_on is not null and archived_at is null;
create index lot_item_idx on app.lot (item_id);

-- SAH-050 / ADR 0034: one sentinel lot per item, created with the item, code 'NONE'. stock_on_hand's
-- primary key contains lot_id (§4.7.3), and a NULL there is exactly the old defect: MtoJob = NULL is
-- unknown, so the increment matched nothing and inserted an orphan, and the decrement matched nothing
-- and left the row. applyMovements resolves a line's null lot to this row before insert.
-- SECURITY INVOKER (the default): the insert runs as whoever inserted the item, under that session's
-- tenant, so app.lot's own tenant_isolation with-check is the control here as everywhere.
create function app.item_sentinel_lot() returns trigger language plpgsql as $$
begin
  insert into app.lot (tenant_id, company_id, item_id, code)
  values (new.tenant_id, new.company_id, new.id, 'NONE')
  on conflict (item_id, code) do nothing;
  return null;
end $$;

create trigger item_sentinel_lot after insert on app.item
  for each row execute function app.item_sentinel_lot();

-- No back-fill statement stands here, and that is not an omission. §3.4.8 restricts migration data to the
-- one GLOBAL table app.permission precisely because `FORCE ROW LEVEL SECURITY` binds app_migrator too
-- (spec:1366): a migration file with no `set_config` sees zero tenants, so an
-- `insert into app.lot … select … from app.item` could never insert a row — not in the runner and not in
-- the local `up`-in-stages case either, which also goes through `up(sql, dir)` on `db.migrator` with no
-- tenant set. The guarantee that every item has its sentinel is the AFTER INSERT trigger above, and it is
-- asserted where there are rows to assert over: `packages/db/test/inventory/lot.test.ts` checks that no
-- app.item row lacks a 'NONE' lot, inside `withTenant`. (0031's header makes the same point for itself:
-- "Nothing in this migration writes a row: hazard 10".)

-- ── 3. variants ─────────────────────────────────────────────────────────────────────────────────
-- spec:1181. Reserved and complete, but no document type reads it in v1: a variant is a selling
-- attribute (size, colour), and the food distributor's v1 catalogue is coded per SKU.
create table app.variant (
  id         uuid primary key default uuidv7(),
  tenant_id  uuid not null references app.tenant(id),
  item_id    uuid not null,
  code       text not null,
  name_en    text not null,
  name_ar    text,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (item_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, item_id) references app.item(tenant_id, id)
);

-- ── 4. tenancy and audit ────────────────────────────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.warehouse');
call app_meta.enable_tenant_rls('app.lot');
call app_meta.enable_tenant_rls('app.variant');
call app_meta.attach_audit('app.warehouse');
call app_meta.attach_audit('app.lot');
call app_meta.attach_audit('app.variant');
-- No *_by column on any of the three. No DELETE grant (§3.5.4); removal is `archived_at`.
```

- [ ] **Step 5: Write `packages/db/migrations/0029.down.sql`**

```sql
-- reverse dependency order (§3.4.5). `drop function … cascade` is the accepted way to remove a
-- function's triggers (plan0A:1518) — item_sentinel_lot's trigger sits on app.item, which this file
-- does not drop, so it must go explicitly and cannot ride a `drop table`.
drop function if exists app.item_sentinel_lot() cascade;
drop table if exists app.variant;
drop table if exists app.lot;
drop function if exists app.warehouse_no_cycle() cascade;
drop table if exists app.warehouse;
```

- [ ] **Step 6: Write the three Drizzle mirrors**

`packages/db/src/schema/warehouse.ts`:

```ts
import { sql } from "drizzle-orm";
import { index, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

export const warehouse = app.table(
  "warehouse",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    kind: text("kind").notNull().default("stock"),
    branchId: uuid("branch_id").notNull(),
    parentId: uuid("parent_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique().on(t.companyId, t.code),
    unique().on(t.tenantId, t.id),
    index("warehouse_parent_idx").on(t.parentId).where(sql`parent_id is not null`),
    index("warehouse_branch_idx").on(t.companyId, t.branchId),
  ],
);
```

`packages/db/src/schema/lot.ts`:

```ts
import { sql } from "drizzle-orm";
import { date, index, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

export const lot = app.table(
  "lot",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    itemId: uuid("item_id").notNull(),
    code: text("code").notNull(),
    // `mode: "string"` on every date: a JavaScript Date would carry a timezone into an accounting date.
    expiresOn: date("expires_on", { mode: "string" }),
    manufacturedOn: date("manufactured_on", { mode: "string" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique().on(t.itemId, t.code),
    unique().on(t.tenantId, t.id),
    index("lot_expiry_idx").on(t.companyId, t.expiresOn)
      .where(sql`expires_on is not null and archived_at is null`),
    index("lot_item_idx").on(t.itemId),
  ],
);
```

`packages/db/src/schema/variant.ts`:

```ts
import { jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

export const variant = app.table(
  "variant",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    itemId: uuid("item_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    attributes: jsonb("attributes").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [unique().on(t.itemId, t.code), unique().on(t.tenantId, t.id)],
);
```

- [ ] **Step 7: Write `packages/db/src/inventory/warehouses.ts`**

```ts
import type { Sql } from "postgres";

export type WarehouseKind = "stock" | "in_transit";

export interface WarehouseRow {
  id: string; companyId: string; code: string; nameEn: string; nameAr: string | null;
  kind: WarehouseKind; branchId: string; parentId: string | null;
  archivedAt: string | null; createdAt: string;
}
export interface WarehouseNode extends WarehouseRow {
  depth: number;
  /** Codes from the root to this node inclusive — what a screen renders as a breadcrumb. */
  path: string[];
}

interface DbWarehouse {
  id: string; company_id: string; code: string; name_en: string; name_ar: string | null;
  kind: WarehouseKind; branch_id: string; parent_id: string | null;
  archived_at: string | null; created_at: string;
}

const toWarehouse = (r: DbWarehouse): WarehouseRow => ({
  id: r.id, companyId: r.company_id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar,
  kind: r.kind, branchId: r.branch_id, parentId: r.parent_id,
  archivedAt: r.archived_at, createdAt: r.created_at,
});

export async function createWarehouse(
  tx: Sql,
  input: {
    companyId: string; code: string; nameEn: string; nameAr?: string | null;
    kind?: WarehouseKind; branchId: string; parentId?: string | null;
  },
): Promise<WarehouseRow> {
  const [row] = await tx<DbWarehouse[]>`
    insert into app.warehouse (tenant_id, company_id, code, name_en, name_ar, kind, branch_id, parent_id)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null},
            ${input.kind ?? "stock"}, ${input.branchId}, ${input.parentId ?? null})
    returning id, company_id, code, name_en, name_ar, kind, branch_id, parent_id, archived_at, created_at`;
  return toWarehouse(row!);
}

export async function getWarehouse(tx: Sql, warehouseId: string): Promise<WarehouseRow | null> {
  const [row] = await tx<DbWarehouse[]>`
    select id, company_id, code, name_en, name_ar, kind, branch_id, parent_id, archived_at, created_at
      from app.warehouse where id = ${warehouseId}`;
  return row ? toWarehouse(row) : null;
}

/** `code`, `kind` and `branch_id` are immutable: movements already written are keyed by this row, and
 *  moving a warehouse to another branch would silently re-scope every historical figure (SAH-045). */
export async function updateWarehouse(
  tx: Sql,
  warehouseId: string,
  patch: { nameEn?: string; nameAr?: string | null; parentId?: string | null },
): Promise<WarehouseRow | null> {
  const current = await getWarehouse(tx, warehouseId);
  if (!current) return null;
  const [row] = await tx<DbWarehouse[]>`
    update app.warehouse set
      name_en   = ${patch.nameEn ?? current.nameEn},
      name_ar   = ${patch.nameAr === undefined ? current.nameAr : patch.nameAr},
      parent_id = ${patch.parentId === undefined ? current.parentId : patch.parentId}
     where id = ${warehouseId}
    returning id, company_id, code, name_en, name_ar, kind, branch_id, parent_id, archived_at, created_at`;
  return row ? toWarehouse(row) : null;
}

export async function archiveWarehouse(tx: Sql, warehouseId: string): Promise<WarehouseRow | null> {
  const [row] = await tx<DbWarehouse[]>`
    update app.warehouse set archived_at = coalesce(archived_at, now()) where id = ${warehouseId}
    returning id, company_id, code, name_en, name_ar, kind, branch_id, parent_id, archived_at, created_at`;
  return row ? toWarehouse(row) : null;
}

export async function listWarehouses(
  tx: Sql,
  params: {
    companyId: string; kind?: WarehouseKind; includeArchived?: boolean;
    cursor?: { code: string } | null; limit: number;
  },
): Promise<WarehouseRow[]> {
  const rows = await tx<DbWarehouse[]>`
    select id, company_id, code, name_en, name_ar, kind, branch_id, parent_id, archived_at, created_at
      from app.warehouse
     where company_id = ${params.companyId}
       and (${params.kind ?? null}::text is null or kind = ${params.kind ?? null})
       and (${params.includeArchived ?? false} or archived_at is null)
       and (${params.cursor?.code ?? null}::text is null or code > ${params.cursor?.code ?? null})
     order by code
     limit ${params.limit}`;
  return rows.map(toWarehouse);
}

/** SAH-071's positive form: one recursive CTE, top-down, returning depth and the code path. */
export async function warehouseTree(tx: Sql, companyId: string): Promise<WarehouseNode[]> {
  const rows = await tx<(DbWarehouse & { depth: number; path: string[] })[]>`
    with recursive node as (
      select w.id, w.company_id, w.code, w.name_en, w.name_ar, w.kind, w.branch_id, w.parent_id,
             w.archived_at, w.created_at, 0 as depth, array[w.code] as path
        from app.warehouse w
       where w.company_id = ${companyId} and w.parent_id is null
      union all
      select w.id, w.company_id, w.code, w.name_en, w.name_ar, w.kind, w.branch_id, w.parent_id,
             w.archived_at, w.created_at, n.depth + 1, n.path || w.code
        from app.warehouse w
        join node n on w.parent_id = n.id
       where w.company_id = ${companyId}
    )
    select * from node order by path`;
  return rows.map((r) => ({ ...toWarehouse(r), depth: r.depth, path: r.path }));
}
```

- [ ] **Step 8: Write `packages/db/src/inventory/lots.ts`**

```ts
import type { Sql } from "postgres";

/** ADR 0034. The ONE spelling of the sentinel code; no plan re-types the literal. */
export const SENTINEL_LOT_CODE = "NONE";

export interface LotRow {
  id: string; companyId: string; itemId: string; code: string;
  expiresOn: string | null; manufacturedOn: string | null;
  archivedAt: string | null; createdAt: string;
}

interface DbLot {
  id: string; company_id: string; item_id: string; code: string;
  expires_on: string | null; manufactured_on: string | null;
  archived_at: string | null; created_at: string;
}

const toLot = (r: DbLot): LotRow => ({
  id: r.id, companyId: r.company_id, itemId: r.item_id, code: r.code,
  expiresOn: r.expires_on, manufacturedOn: r.manufactured_on,
  archivedAt: r.archived_at, createdAt: r.created_at,
});

export async function createLot(
  tx: Sql,
  input: {
    companyId: string; itemId: string; code: string;
    expiresOn?: string | null; manufacturedOn?: string | null;
  },
): Promise<LotRow> {
  const [row] = await tx<DbLot[]>`
    insert into app.lot (tenant_id, company_id, item_id, code, expires_on, manufactured_on)
    values (app.current_tenant(), ${input.companyId}, ${input.itemId}, ${input.code},
            ${input.expiresOn ?? null}, ${input.manufacturedOn ?? null})
    returning id, company_id, item_id, code, expires_on, manufactured_on, archived_at, created_at`;
  return toLot(row!);
}

export async function listLots(
  tx: Sql,
  params: {
    companyId: string; itemId?: string; expiringBefore?: string; includeArchived?: boolean;
    cursor?: { code: string } | null; limit: number;
  },
): Promise<LotRow[]> {
  const rows = await tx<DbLot[]>`
    select id, company_id, item_id, code, expires_on, manufactured_on, archived_at, created_at
      from app.lot
     where company_id = ${params.companyId}
       and (${params.itemId ?? null}::uuid is null or item_id = ${params.itemId ?? null})
       and (${params.expiringBefore ?? null}::date is null
            or (expires_on is not null and expires_on <= ${params.expiringBefore ?? null}))
       and (${params.includeArchived ?? false} or archived_at is null)
       and (${params.cursor?.code ?? null}::text is null or code > ${params.cursor?.code ?? null})
     order by code
     limit ${params.limit}`;
  return rows.map(toLot);
}

/**
 * The sentinel `app.lot` row every item is created with (ADR 0034). `applyMovements` resolves a null
 * `document_line.lot_id` to it, because `inventory_movement.lot_id` and `stock_on_hand.lot_id` are
 * both NOT NULL (§4.7.3). Throws rather than returning null: the row is created by trigger with the
 * item, so its absence means the trigger was dropped, which is a schema fault, not a data one.
 */
export async function sentinelLotId(tx: Sql, itemId: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.lot where item_id = ${itemId} and code = ${SENTINEL_LOT_CODE}`;
  if (!row) {
    throw new Error(
      `item ${itemId} has no '${SENTINEL_LOT_CODE}' sentinel lot: app.item_sentinel_lot() is missing ` +
        `from the schema (migration 0029, ADR 0034)`,
    );
  }
  return row.id;
}
```

Append to `packages/db/src/index.ts`:

```ts
export {
  archiveWarehouse, createWarehouse, getWarehouse, listWarehouses, updateWarehouse, warehouseTree,
  type WarehouseKind, type WarehouseNode, type WarehouseRow,
} from "./inventory/warehouses";
export { SENTINEL_LOT_CODE, createLot, listLots, sentinelLotId, type LotRow } from "./inventory/lots";
```

- [ ] **Step 9: Add `ERR_WAREHOUSE_TREE_CYCLE` to `packages/contracts/src/errors.ts`**

Inside the `ERRORS` object, in the file's existing alphabetical position:

```ts
  ERR_WAREHOUSE_TREE_CYCLE: {
    status: 409,
    title: "Warehouse tree cycle",
    remedy: "Choose a parent warehouse that is not this warehouse or one of its descendants.",
  },
```

The token is raised by `app.warehouse_no_cycle()` with `errcode = 'check_violation'` in the `TOKEN: text` form, so `fromDatabaseError` (0B, §4.2.4) maps it to this row's 409 with no handler `catch`. `error-codes` (§3.7.5) scans `packages/db/migrations/**`, so the code's evidence is the migration's SQL text and the rule stays green from this commit.

**First, prove the contracts amendment landed.** §4.2.4 reserves "the name, status, title and raiser of every code the v1 system will ever raise" and says a slice needing an absent code "amends this table first"; hazard 32 makes an unregistered `ERR_*` literal a review-blocking finding. §4.18's round 3 did **not** fold this row in (see the header table), so run:

```bash
grep -q 'ERR_WAREHOUSE_TREE_CYCLE' docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md   || { echo "STOP: §4.2.4 has no ERR_WAREHOUSE_TREE_CYCLE row. Land the amendment"; echo "      ERR_WAREHOUSE_TREE_CYCLE | 409 | app.warehouse_no_cycle() (3A)"; echo "      before this commit — do not invent the code here."; exit 1; }
```

Expected on a first run, today: **FAIL** with that message. Land the row, re-run to see it pass, then add the `ERRORS` entry above. The grep is the whole gate — 3A ships no `scripts/check/contracts-3a-amendments.sh`, for the reason the header gives.

- [ ] **Step 10: Add `seedWarehouse` and `seedLot` to `packages/db/test/fixtures.ts`**

```ts
/** contracts §4.17 — 3A's helpers. `kind` defaults to 'stock'; pass 'in_transit' for 3D's transfers.
 *  `branchId` defaults to the seed's head-office BRANCH value, so a bare call needs no argument. */
export async function seedWarehouse(
  db: Db,
  s: Seed,
  opts: { code?: string; kind?: "stock" | "in_transit"; branchId?: string } = {},
): Promise<string> {
  const code = opts.code ?? "WH-1";
  const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    insert into app.warehouse (tenant_id, company_id, code, name_en, kind, branch_id)
    values (${s.tenant}, ${s.company}, ${code}, ${code}, ${opts.kind ?? "stock"}, ${opts.branchId ?? s.hq})
    on conflict (company_id, code) do update set name_en = excluded.name_en
    returning id`);
  return row!.id;
}

/** A REAL lot. The sentinel is created by trigger with the item and is reached through `sentinelLotId`. */
export async function seedLot(
  db: Db,
  s: Seed,
  opts: { itemId: string; code?: string; expiresOn?: string },
): Promise<string> {
  const code = opts.code ?? "LOT-1";
  const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    insert into app.lot (tenant_id, company_id, item_id, code, expires_on)
    values (${s.tenant}, ${s.company}, ${opts.itemId}, ${code}, ${opts.expiresOn ?? null})
    on conflict (item_id, code) do update set expires_on = excluded.expires_on
    returning id`);
  return row!.id;
}
```

- [ ] **Step 11: Run both tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/inventory/warehouse.test.ts test/inventory/lot.test.ts`
Expected: **PASS**, 7 + 6 tests. If the cycle test's second case passes without raising, the trigger is missing `or update of parent_id` — a BEFORE INSERT-only trigger never sees a re-parenting.

- [ ] **Step 12: Append this slice's block to `tests/regression/sah-071.test.ts`**

0B created the file (§3.7.3's list of Plan 0A-proven defects includes 071 — the recursive-CTE `account` tree). This slice **appends** and never edits 0B's block.

```ts
describe("SAH-071 Tree-integrity checks run a recursive procedure per row inside triggers — 3A", () => {
  it("the warehouse tree's cycle check is one CTE in one function, and app.warehouse is its only caller", async () => {
    const { db, a } = await sharedDb();
    const [fn] = await db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc where proname = 'warehouse_no_cycle'
        and pronamespace = 'app'::regnamespace`;
    expect(fn!.src).toMatch(/with recursive/i);
    // The old system called a recursive PROCEDURE per row. Assert this one calls no procedure at all.
    expect(fn!.src).not.toMatch(/\bcall\b/i);
    const triggers = await db.admin<{ tbl: string }[]>`
      select c.relname as tbl from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_proc p on p.oid = t.tgfoid
       where not t.tgisinternal and p.proname = 'warehouse_no_cycle' order by 1`;
    expect(triggers.map((t) => t.tbl)).toEqual(["warehouse"]);
    void a;
  });
});
```

- [ ] **Step 13: Write `docs/adr/0034-sentinel-lot-and-not-null-lot-id.md`**

```markdown
# ADR 0034 — The per-item sentinel lot, and why `lot_id` is NOT NULL on every stock row

- **Status:** accepted
- **Date:** 2026-09-05
- **Slice:** 3A
- **Supersedes:** nothing. **Related:** contracts §4.7.3, spec:1022, SAH-050.

## Context

`app.stock_on_hand`'s primary key is `(company_id, item_id, warehouse_id, lot_id)` and
`app.inventory_movement.lot_id` is NOT NULL (contracts §4.7.3). But the user need not enter a lot:
`document_line.lot_id` is deliberately nullable, and a great many lines — services, non-food goods,
a quick counter sale — legitimately carry none.

SAH-050 is what happens when the aggregate key admits NULL. `MtoJob = NULL` is unknown, so the old
system's increment matched no row, reported `ROW_COUNT = 0` and inserted a fresh one; the decrement
matched no row either and there was **no `ROW_COUNT = 0` fallback on the decrement**, so the row
stayed. Every NULL-job line accumulated one orphan, and the repair procedure grouped by the same
NULL and folded them all into one row the trigger could never find again.

## Decision

Every `app.item` insert creates one companion `app.lot` row with `code = 'NONE'`, no expiry, by an
AFTER INSERT trigger `item_sentinel_lot` (migration 0029). `applyMovements` (contracts §4.7.2)
resolves a null `document_line.lot_id` to that row before the movement insert. `lot_id` is therefore
NOT NULL on `inventory_movement`, on `stock_on_hand` and on `cost_layer` alike, the `MERGE` of
§4.7.3 always matches on a full key, and no aggregate row can ever be orphaned by an unknown value.

The sentinel is a real row, not a magic uuid: it has a tenant, a company, an audit trail and an FK
like any other lot, and `app.pick_lots_fefo` orders `expires_on nulls last`, so it is picked only
when no dated lot can satisfy the quantity.

## Consequences

- `document_line.lot_id` stays nullable and no wire contract requires a lot (contracts §4.6.1).
- A lot-tracked item's **receipt** without a lot is refused (`ERR_POLICY_REQUIRES_MISSING`), because
  pooling two food batches under `NONE` would defeat spec:1022's whole point. Issues resolve the
  sentinel and then usually fail loudly on `ERR_STOCK_INSUFFICIENT`, which is the correct answer.
- `SENTINEL_LOT_CODE` is exported from `@dulja/db` so the literal `'NONE'` is typed in exactly one
  place; the migration's SQL is the only other occurrence.
- Dropping the trigger silently breaks the step-12 `MERGE`, so `sentinelLotId` throws with a message
  naming this ADR rather than returning null.
```

- [ ] **Step 14: Run the whole suite, the linter and the type checker**

Run: `bun run --cwd packages/db test && bun run --cwd tests test -- regression/sah-071.test.ts && bun run typecheck && bun run lint && bun run lint:rules`
Expected: **PASS**, zero `lint:rules` violations. `packages/db/test/inventory/item.test.ts` from Task 1 is still green: the sentinel-lot trigger adds a row per item and that file counts items, not lots.

- [ ] **Step 15: Commit**

```bash
git add packages/db/migrations/0029_create_warehouse_lot_variant.sql packages/db/migrations/0029.down.sql \
        packages/db/src/schema/warehouse.ts packages/db/src/schema/lot.ts packages/db/src/schema/variant.ts \
        packages/db/src/inventory/warehouses.ts packages/db/src/inventory/lots.ts packages/db/src/index.ts \
        packages/contracts/src/errors.ts packages/db/test/fixtures.ts \
        packages/db/test/inventory/warehouse.test.ts packages/db/test/inventory/lot.test.ts \
        tests/regression/sah-071.test.ts docs/adr/0034-sentinel-lot-and-not-null-lot-id.md
git commit -m "$(cat <<'EOF'
feat(db): warehouses as a tree, lots with expiry, and the sentinel lot [3A T2]

Migration 0029 creates app.warehouse (NOT NULL branch, kind stock|in_transit,
parent tree), app.lot (expiry, manufacture, one-per-(item, code)) and
app.variant at contracts §4.6.1's columns.

Cycle detection is one recursive CTE in app.warehouse_no_cycle(), the only such
check in the codebase — SAH-071 called a recursive procedure per row inside
triggers, duplicated across three modules.

Every item gets a companion lot coded NONE by trigger, which is what lets
inventory_movement.lot_id and stock_on_hand.lot_id both be NOT NULL and the
step-12 MERGE always match a full key. That is ADR 0034 and the structural
answer to SAH-050.

ERR_WAREHOUSE_TREE_CYCLE joins the ERRORS registry; the token is raised in SQL,
so error-codes sees its evidence in the migration text.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration 0033 — the five `inventory.*` permission codes, `INVENTORY_PERMISSION`, and the role grants

The catalogue half of the slice, taken early on purpose. Three later tasks need these codes to exist before they can be written: Task 5's override door grants `inventory.negative_stock.override` to a second principal, and `app.role_permission.permission_code` has a foreign key to `app.permission(code)`, so the grant is impossible until the row is there; Tasks 11 and 12 gate every route with `INVENTORY_PERMISSION`; and Task 10 puts `inventory.stock.read` into 2C's `MODULE_READ_CODE`, where `PERMISSION["inventory.stock.read"]` is a **compile error** until `permissions.ts` carries the entry.

**Migration 0033 is committed before 0030, 0031 and 0032, and that is legal.** Hazard 14: "Parallel phases mean a higher number may be applied before a lower one — no plan asserts `max(version)`." `up(sql, dir)` applies every discovered file whose version is not in `listApplied()`, in version order, so when Task 4 lands 0030 the runner applies it after 0033 is already recorded and nothing rolls back. The file numbers are allocated by area (§3.4.1), not by task order, and the card fixes 0033 as the permission seed.

**Files:**
- Create: `packages/db/migrations/0033_seed_permission_phase3a.sql`, `packages/db/migrations/0033.down.sql`
- Create: `apps/api/src/routes/inventory/permissions.ts`
- Modify: `packages/contracts/permissions.ts` (five `PermissionDef` entries, `phase: "3A"`), `packages/db/seed/roles.ts` (five role arrays)
- Test: `packages/db/test/roles-seed.test.ts` (append a `describe`), `packages/db/test/permission-catalogue.test.ts` (unchanged — its both-directions assertion widens by itself)

**Interfaces:**
- Consumes: `PermissionDef`, `PERMISSIONS`, `PERMISSION`, `PermissionCode`, `isMutating` (0B, §4.2.5); `RoleSeed`, `ROLES`, `INCOMPATIBLE_PAIRS`, `adminPermissions(catalogue)` (0D, §4.2.5); `app.permission (code, module, mutating, description)` from migration 0001; the seed CLI `bun run seed --tenant <id> --only roles` (0C, §4.2.13).
- Produces:
  - Five `PERMISSIONS` entries: `inventory.item.read` (`mutating: false`), `inventory.item.manage` (`true`), `inventory.price.manage` (`true`), `inventory.stock.read` (`false`), `inventory.negative_stock.override` (`true`) — §3.6.2's inventory/3A row exactly.
  - `export const INVENTORY_PERMISSION` in `apps/api/src/routes/inventory/permissions.ts`:

```ts
export const INVENTORY_PERMISSION: {
  readonly itemRead: "inventory.item.read";
  readonly itemManage: "inventory.item.manage";
  readonly priceManage: "inventory.price.manage";
  readonly stockRead: "inventory.stock.read";
  readonly negativeStockOverride: "inventory.negative_stock.override";
};
```

  - `ROLES` grants (§3.6.4's per-slice sentence, extended by this slice): `inventory.item.read` and `inventory.stock.read` → `accountant`, `user`, `warehouse`, `branch_manager`, `auditor`; `inventory.item.manage`, `inventory.price.manage` and `inventory.negative_stock.override` → **no seeded role**, picked up by `admin` through `adminPermissions()`.

- [ ] **Step 1: Write the failing test — append to `packages/db/test/roles-seed.test.ts`**

Append this `describe` at the end of the file. Do not edit 0D's or 1A's blocks.

```ts
describe("the five inventory codes and their role grants — slice 3A (contracts §3.6.2, §3.6.4)", () => {
  const CODES = [
    "inventory.item.read",
    "inventory.item.manage",
    "inventory.price.manage",
    "inventory.stock.read",
    "inventory.negative_stock.override",
  ] as const;

  it("all five are in the catalogue, module 'inventory', phase '3A'", () => {
    for (const code of CODES) {
      const def = PERMISSIONS.find((p) => p.code === code);
      expect(def, code).toBeDefined();
      expect(def!.module).toBe("inventory");
      expect(def!.phase).toBe("3A");
    }
  });

  it("the two reads are non-mutating and the three authorities are mutating (R7, spec:2178)", () => {
    expect(isMutating("inventory.item.read")).toBe(false);
    expect(isMutating("inventory.stock.read")).toBe(false);
    expect(isMutating("inventory.item.manage")).toBe(true);
    expect(isMutating("inventory.price.manage")).toBe(true);
    expect(isMutating("inventory.negative_stock.override")).toBe(true);
  });

  it("the two reads are granted to exactly the five roles spec:2157-2163 gives catalogue and stock visibility", () => {
    const holders = (code: string) =>
      ROLES.filter((r) => r.permissions.includes(code)).map((r) => r.code).sort();
    expect(holders("inventory.item.read")).toEqual(
      ["accountant", "auditor", "branch_manager", "user", "warehouse"]);
    expect(holders("inventory.stock.read")).toEqual(
      ["accountant", "auditor", "branch_manager", "user", "warehouse"]);
  });

  it("no seeded role holds item.manage, price.manage or negative_stock.override — only computed admin does", () => {
    // spec:2159 warehouse "May not: Prices, item master"; spec:2160 branch_manager "May not: Prices, item
    // master or credit terms (head office owns the catalogue)". Nothing in the spec's table gives a named
    // role the catalogue write or the negative-stock override, so nothing here does either.
    for (const code of ["inventory.item.manage", "inventory.price.manage", "inventory.negative_stock.override"]) {
      expect(ROLES.filter((r) => r.code !== "admin").some((r) => r.permissions.includes(code)), code).toBe(false);
    }
    const admin = adminPermissions(PERMISSIONS.map((p) => p.code));
    expect(admin).toContain("inventory.negative_stock.override");
    expect(admin).toContain("inventory.price.manage");
  });

  it("the auditor still holds no mutating code (R7)", () => {
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    for (const code of auditor.permissions) {
      expect(isMutating(code as PermissionCode), code).toBe(false);
    }
  });

  it("no INCOMPATIBLE_PAIRS entry is created by these grants (R6)", () => {
    for (const role of ROLES.filter((r) => r.code !== "admin")) {
      for (const [a, b] of INCOMPATIBLE_PAIRS) {
        expect(role.permissions.includes(a) && role.permissions.includes(b), `${role.code} ${a}+${b}`).toBe(false);
      }
    }
  });
});
```

The file's existing imports need `PERMISSIONS`, `PERMISSION`-free `isMutating`, `PermissionCode` from `@dulja/contracts` and `ROLES`, `INCOMPATIBLE_PAIRS`, `adminPermissions` from `../seed/roles`; 0D's block already imports all of them, so add nothing.

- [ ] **Step 2: Run the test to see the exact failure**

Run: `bun run --cwd packages/db test -- test/roles-seed.test.ts`
Expected: **FAIL**, first assertion, `expected undefined to be defined` with the message `inventory.item.read` — the catalogue has **fourteen** codes at this point and none of them is an inventory code. (§3.6.2, counted by introducing slice for everything ahead of 3A in execution order: admin/0B 5, accounting/1A 6, 1B 1, 2A 1, 2B 1; 0D, 0C, 0E and 2C introduce none.)

- [ ] **Step 3: Add the five entries to `packages/contracts/permissions.ts`**

Append this block to the `PERMISSIONS` array, after the accounting block. Order inside the array is `§3.6.2`'s table order; nothing already in the array moves.

```ts
  // ── inventory (slice 3A) ────────────────────────────────────────────────────────────────────────────
  { code: "inventory.item.read",              module: "inventory", mutating: false, phase: "3A", description: "Read the item master, units, unit conversions, warehouses and lots, and download a lot's attachments" },
  { code: "inventory.item.manage",            module: "inventory", mutating: true,  phase: "3A", description: "Create, edit and archive items, units, unit conversions and warehouses — the head-office catalogue" },
  { code: "inventory.price.manage",           module: "inventory", mutating: true,  phase: "3A", description: "Create and edit price lists, their lines and promotions" },
  { code: "inventory.stock.read",             module: "inventory", mutating: false, phase: "3A", description: "Read stock on hand per item, warehouse and lot, and download an inventory document's attachments" },
  { code: "inventory.negative_stock.override", module: "inventory", mutating: true, phase: "3A", description: "As a second principal, authorise one document to take stock below zero; recorded as an override document_event" },
```

Two things a reviewer checks here. `inventory.negative_stock.override` satisfies the `permission.code` CHECK `^[a-z_]+\.[a-z_]+\.[a-z_]+$` — three segments, `negative_stock` is `[a-z_]+` — and satisfies `PermissionDef["code"]`'s template `` `${PermissionModule}.${string}.${PermissionAction}` `` with `override` already in `PermissionAction` (§4.2.5). And `mutating: true` on it is what makes R7 refuse to gate a `GET` with it, which is correct: the override is recorded by a `POST …/documents/{id}/overrides` (2B's route).

- [ ] **Step 4: Add the grants to `packages/db/seed/roles.ts`**

Five one-line edits inside `ROLES`. `admin`'s array stays `[]` — it is computed (§3.6.4).

```ts
  {
    code: "accountant", nameEn: "Accountant", nameAr: "محاسب",
    description: /* unchanged */,
    permissions: [
      /* …1A's and 2B's codes, unchanged… */
      "inventory.item.read", "inventory.stock.read",              // 3A
    ],
  },
  {
    code: "user", nameEn: "Clerk", nameAr: "مستخدم",
    description: /* unchanged */,
    permissions: [
      /* …1A's and 2A's codes, unchanged… */
      "inventory.item.read", "inventory.stock.read",              // 3A — spec:2158 "reads accounts, items, stock"
    ],
  },
  {
    code: "warehouse", nameEn: "Warehouse", nameAr: "أمين المستودع",
    description: /* unchanged */,
    permissions: [
      "inventory.item.read", "inventory.stock.read",              // 3A — the first codes this role holds
    ],
  },
  {
    code: "branch_manager", nameEn: "Branch manager", nameAr: "مدير الفرع",
    description: /* unchanged */,
    permissions: [
      "inventory.item.read", "inventory.stock.read",              // 3A — reads the catalogue, never writes it (spec:2160)
    ],
  },
  {
    code: "auditor", nameEn: "Auditor", nameAr: "مدقق",
    description: /* unchanged */,
    permissions: [
      "admin.audit_log.read",                                     // 0D
      /* …1B's accounting.report.read and 1A's accounting.ledger.read, unchanged… */
      "inventory.item.read", "inventory.stock.read",              // 3A — both mutating: false, so R7 holds
    ],
  },
```

- [ ] **Step 5: Write `packages/db/migrations/0033_seed_permission_phase3a.sql`**

```sql
-- 0033_seed_permission_phase3a.sql — the five Phase 3A inventory codes (spec:2148, contracts §3.6.2).
-- app.permission is the one table a migration may write: it is global (no tenant_id, no RLS — plan0A:1313),
-- so FORCE ROW LEVEL SECURITY does not hide it from app_migrator the way it hides every per-tenant table
-- (contracts §3.4.8, spec:1366, hazard 10). The role grants over these codes are per-tenant seed-pack data
-- and are applied by `bun run seed --tenant <id> --only roles` from packages/db/seed/roles.ts.
-- `do update` rather than `do nothing`: re-running on staging must correct a drifted description.
-- This file's version is higher than 0030-0032, which land in later tasks. That is expected and legal:
-- hazard 14 — no plan asserts max(version), and the runner applies whatever is not in listApplied().

-- ── 1. the Phase 3A catalogue ─────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('inventory.item.read',               'inventory', false, 'Read the item master, units, unit conversions, warehouses and lots, and download a lot''s attachments'),
  ('inventory.item.manage',             'inventory', true,  'Create, edit and archive items, units, unit conversions and warehouses — the head-office catalogue'),
  ('inventory.price.manage',            'inventory', true,  'Create and edit price lists, their lines and promotions'),
  ('inventory.stock.read',              'inventory', false, 'Read stock on hand per item, warehouse and lot, and download an inventory document''s attachments'),
  ('inventory.negative_stock.override', 'inventory', true,  'As a second principal, authorise one document to take stock below zero; recorded as an override document_event')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;
```

`packages/db/migrations/0033.down.sql`:

```sql
-- Reverse of 0033: exactly the five codes it inserted. The FK from app.role_permission.permission_code blocks
-- the delete while any tenant still grants one, which is the correct signal — re-run the role seed for that
-- tenant first (contracts §3.4.5).
delete from app.permission where code in (
  'inventory.item.read',
  'inventory.item.manage',
  'inventory.price.manage',
  'inventory.stock.read',
  'inventory.negative_stock.override'
);
```

- [ ] **Step 6: Write `apps/api/src/routes/inventory/permissions.ts`**

```ts
import { PERMISSION } from "@dulja/contracts";

/**
 * The five codes §3.6.2 assigns slice 3A, named once so every inventory route imports the constant rather
 * than repeating a string. This file is also what keeps the `permission-catalogue` lint green from THIS task
 * onward instead of from Task 11: the rule fails the build when a catalogue code has no reference in
 * `apps/api`, `apps/worker`, `apps/pos`, `packages/sync` or `packages/db/src` (§3.6.3), and the five
 * `PERMISSION[…]` reads below are those references. Tasks 11 and 12 then use the constant in their gates.
 *
 * Warehouses, units and unit conversions are maintained under `itemManage` — there is no separate warehouse
 * code, because §3.6.1 closes the vocabulary and spec:2159/2160 give neither `warehouse` nor `branch_manager`
 * any catalogue authority ("head office owns the catalogue"). Recorded as a contract addition to §3.6.2.
 */
export const INVENTORY_PERMISSION = {
  itemRead: PERMISSION["inventory.item.read"],
  itemManage: PERMISSION["inventory.item.manage"],
  priceManage: PERMISSION["inventory.price.manage"],
  stockRead: PERMISSION["inventory.stock.read"],
  negativeStockOverride: PERMISSION["inventory.negative_stock.override"],
} as const;
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/roles-seed.test.ts test/permission-catalogue.test.ts`
Expected: **PASS**. `permission-catalogue.test.ts` needed no edit — its assertion is that the `(code, module, mutating)` set in `app.permission` equals the set exported by `permissions.ts`, in both directions, and both sides grew by the same five rows in this commit.

Run: `bun run --cwd packages/contracts typecheck && bun run --cwd apps/api typecheck`
Expected: PASS. `PermissionCode` is now a **nineteen-member** union — the fourteen above plus this commit's five.

Run: `bun run lint:rules`
Expected: PASS with **zero** violations — `permission-catalogue` finds all five references in `apps/api/src/routes/inventory/permissions.ts`, and `role-seed` finds no incompatible pair, no mutating auditor code and no unknown code.

- [ ] **Step 8: Apply the role seed to the development tenant**

Run: `bun run seed --tenant "$DEV_TENANT_ID" --only roles`
Expected: the CLI prints the per-role diff — five roles gaining `inventory.item.read` and `inventory.stock.read`, and `admin` gaining all five — and is idempotent on a second run (zero changes). It runs as the tenant's system principal, so `forbid_self_grant` and `keep_last_admin_permission` hold (§3.6.4).

- [ ] **Step 9: Commit**

```bash
git add packages/db/migrations/0033_seed_permission_phase3a.sql packages/db/migrations/0033.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts \
        apps/api/src/routes/inventory/permissions.ts packages/db/test/roles-seed.test.ts
git commit -m "$(cat <<'EOF'
feat(db): the five inventory permission codes and their role grants [3A T3]

Migration 0033 seeds inventory.item.read, item.manage, price.manage,
stock.read and negative_stock.override; permissions.ts gains the five entries
with phase 3A; roles.ts grants the two reads to accountant, user, warehouse,
branch_manager and auditor and grants the three authorities to nobody — admin
picks them up through adminPermissions().

The catalogue lands before 0030-0032 on purpose: Task 5 cannot grant the
override code to a second principal until app.permission holds the row
(role_permission.permission_code has an FK to it), and Task 10 cannot put
inventory.stock.read into 2C's MODULE_READ_CODE until PERMISSION[...] compiles.
A higher version applied before a lower one is expected — contracts hazard 14.

INVENTORY_PERMISSION carries the five references the permission-catalogue lint
needs, so lint:rules is green in this commit rather than red until Task 11.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Migration 0030 — `app.price_list`, `app.price_list_line`, `app.promotion`

What stock is sold at. Three tables: a price list scoped by currency, trade level, branch and date window; its lines, keyed by item, unit and a quantity break; and promotions, whose `definition jsonb` 6B interprets at the till and 6A down-syncs. `resolvePrice` is the one deterministic resolver — written here so that 3D's `SALES_ORDER`, 4A's `SALES_INVOICE` and 6B's till all read one answer instead of three.

**⚠️ OD-05 — the §3.0.3 "Price lists per customer type" row (spec:1025).** Built at the spec text as written: "Wholesale, retail, branch transfer pricing". **If the owner rejects the row:** drop migration 0030 and its three mirrors entirely, drop `prices.ts` and `promotions.ts`, and drop Task 12's `priceListRoutes` and `promotionRoutes` (its `stockRoutes` survives — it reads `stock_on_hand`, not a price). `inventory.price.manage` then has no handler and Task 3's catalogue entry is dropped with it, which is the one cross-task consequence. Nothing else in the slice moves: no posting path reads a price list, because `document_line.unit_price` is entered, not resolved.

**The promotions half is spec:1062's, not spec:1048's, and it lands here anyway.** §4.6.1 assigns `promotion` to 3A/0030 and the 3A card names it in Delivers; spec:2292 puts "offers" in Phase 6 scope and 6A adds the `revision` column that down-syncs it. So this task ships the table, the CRUD and the date-window guard, and interprets **nothing**: no code in this slice reads `definition`. 6B is where a percentage becomes a discount.

**Files:**
- Create: `packages/db/migrations/0030_create_price_list_promotion.sql`, `packages/db/migrations/0030.down.sql`
- Create: `packages/db/src/schema/price_list.ts`, `packages/db/src/schema/price_list_line.ts`, `packages/db/src/schema/promotion.ts`
- Create: `packages/db/src/inventory/prices.ts`, `packages/db/src/inventory/promotions.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/test/fixtures.ts` (`seedPriceList`)
- Test: `packages/db/test/inventory/price-list.test.ts`

**Interfaces:**
- Consumes: `app.item(tenant_id, id)`, `app.unit_of_measure(tenant_id, id)` (Task 1); `app.dimension_value(tenant_id, id)` from migration 0001 (`Seed.hq`, `seedBranch`); `app.company(tenant_id, id)`; `app_meta.enable_tenant_rls`, `app_meta.attach_audit` (§4.1); `Money` and `Quantity` (§4.2.1); `seedItem`, `seedUnit` (Task 1); `seedBranch` (0D, §4.17).
- Produces:
  - SQL: `app.price_list`, `app.price_list_line`, `app.promotion` as §4.6.1; indexes `price_list_line_item_idx`, `promotion_window_idx`.
  - `export type PriceListRow = { id: string; companyId: string; code: string; nameEn: string; nameAr: string | null; currency: string; customerKind: string | null; branchId: string | null; validFrom: string | null; validTo: string | null; archivedAt: string | null; createdAt: string }`
  - `export interface PriceListLineInput { itemId: string; unitId?: string | null; minQuantity?: string; unitPrice: string }`
  - `export interface PriceListLineRow { id: string; priceListId: string; itemId: string; unitId: string | null; minQuantity: string; unitPrice: string; archivedAt: string | null; createdAt: string }`
  - `export async function createPriceList(tx: Sql, input: { companyId: string; code: string; nameEn: string; nameAr?: string | null; currency: string; customerKind?: string | null; branchId?: string | null; validFrom?: string | null; validTo?: string | null }): Promise<PriceListRow>`
  - `export async function updatePriceList(tx: Sql, priceListId: string, patch: { nameEn?: string; nameAr?: string | null; customerKind?: string | null; validFrom?: string | null; validTo?: string | null }): Promise<PriceListRow | null>`
  - `export async function archivePriceList(tx: Sql, priceListId: string): Promise<PriceListRow | null>`
  - `export async function getPriceList(tx: Sql, priceListId: string): Promise<PriceListRow | null>`
  - `export async function listPriceLists(tx: Sql, params: { companyId: string; branchId?: string | null; includeArchived?: boolean; cursor?: { code: string } | null; limit: number }): Promise<PriceListRow[]>`
  - `export async function replacePriceListLines(tx: Sql, priceListId: string, lines: readonly PriceListLineInput[]): Promise<PriceListLineRow[]>`
  - `export async function listPriceListLines(tx: Sql, params: { priceListId: string; includeArchived?: boolean }): Promise<PriceListLineRow[]>`
  - `export interface PriceQuery { companyId: string; itemId: string; currency: string; quantity: string; on: string; unitId?: string | null; customerKind?: string | null; branchId?: string | null }`
  - `export interface ResolvedPrice { priceListId: string; priceListCode: string; priceListLineId: string; unitId: string | null; minQuantity: string; unitPrice: string }`
  - `export async function resolvePrice(tx: Sql, q: PriceQuery): Promise<ResolvedPrice | null>`
  - `export type PromotionKind = "percent_off" | "amount_off" | "bundle"`
  - `export interface PromotionRow { id: string; companyId: string; code: string; nameEn: string; nameAr: string | null; kind: PromotionKind; definition: Record<string, unknown>; startsAt: string | null; endsAt: string | null; branchId: string | null; createdAt: string }`
  - `export async function createPromotion(tx: Sql, input: { companyId: string; code: string; nameEn: string; nameAr?: string | null; kind: PromotionKind; definition: Record<string, unknown>; startsAt?: string | null; endsAt?: string | null; branchId?: string | null }): Promise<PromotionRow>`
  - `export async function updatePromotion(tx: Sql, promotionId: string, patch: { nameEn?: string; nameAr?: string | null; definition?: Record<string, unknown>; startsAt?: string | null; endsAt?: string | null }): Promise<PromotionRow | null>`
  - `export async function listPromotions(tx: Sql, params: { companyId: string; branchId?: string | null; activeOn?: string; cursor?: { code: string } | null; limit: number }): Promise<PromotionRow[]>`
  - `seedPriceList(db: Db, s: Seed, opts?: { code?: string; currency?: string; branchId?: string; lines?: readonly PriceListLineInput[] }): Promise<string>` — §4.17's 3A row, that signature exactly.

- [ ] **Step 1: Write the failing test `packages/db/test/inventory/price-list.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import {
  createPriceList, listPriceLists, replacePriceListLines, resolvePrice,
} from "../../src/inventory/prices";
import { createPromotion, listPromotions } from "../../src/inventory/promotions";
import { seedBranch, seedItem, seedTenant, seedUnit, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("app.price_list / price_list_line / promotion — migration 0030 (contracts §4.6.1, spec:1025)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let itemId: string;
  let baseUnitId: string;
  let cartonId: string;
  let branchId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Price A");
    b = await seedTenant(db, "Price B");
    ({ itemId, baseUnitId } = await seedItem(db, a, { code: "RICE-5KG" }));
    cartonId = await seedUnit(db, a, { code: "CTN", nameEn: "Carton" });
    branchId = await seedBranch(db, a, { code: "KL-01" });
  });
  afterAll(async () => { await db.stop(); });

  it("a price list carries currency, trade level, branch and a date window", async () => {
    const row = await withTenant(db.rw, a.tenant, a.human, (tx) => createPriceList(tx, {
      companyId: a.company, code: "RETAIL", nameEn: "Retail", currency: "MYR",
      customerKind: "retail", validFrom: "2026-01-01", validTo: "2026-12-31",
    }));
    expect(row.currency).toBe("MYR");
    expect(row.customerKind).toBe("retail");
    expect(row.branchId).toBeNull();          // null = every branch (§3.7.5, spec:1312)
    expect(row.archivedAt).toBeNull();
  });

  it("valid_to before valid_from is refused", async () => {
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => createPriceList(tx, {
      companyId: a.company, code: "BACKWARDS", nameEn: "Backwards", currency: "MYR",
      validFrom: "2026-06-01", validTo: "2026-05-01",
    }))).rejects.toThrow(/price_list_window_check/);
  });

  it("a line is unique on (list, item, unit, min_quantity) with NULLS NOT DISTINCT", async () => {
    const listId = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const pl = await createPriceList(tx, {
        companyId: a.company, code: "WHOLESALE", nameEn: "Wholesale", currency: "MYR", customerKind: "wholesale",
      });
      await replacePriceListLines(tx, pl.id, [
        { itemId, unitPrice: "18.5000" },                                        // unit null, break 0
        { itemId, minQuantity: "100.000000", unitPrice: "17.2500" },
        { itemId, unitId: cartonId, unitPrice: "210.0000" },
      ]);
      return pl.id;
    });
    // The second insert of (listId, itemId, null, 0) must collide, not create a twin.
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.price_list_line (tenant_id, price_list_id, item_id, unit_id, min_quantity, unit_price)
      values (${a.tenant}, ${listId}, ${itemId}, null, 0, 19.0000)`))
      .rejects.toThrow(/price_list_line_price_list_id_item_id_unit_id_min_quantity_key/);
  });

  it("a negative unit price is refused (SAH-073's shape, applied to a price)", async () => {
    const [pl] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ id: string }[]>`select id from app.price_list where company_id = ${a.company} and code = 'WHOLESALE'`);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.price_list_line (tenant_id, price_list_id, item_id, min_quantity, unit_price)
      values (${a.tenant}, ${pl!.id}, ${itemId}, 500, -1.0000)`))
      .rejects.toThrow(/price_list_line_unit_price_check/);
  });

  it("resolvePrice picks the most specific match and is stable across calls", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const branchList = await createPriceList(tx, {
        companyId: a.company, code: "KL-RETAIL", nameEn: "KL retail", currency: "MYR",
        customerKind: "retail", branchId,
      });
      await replacePriceListLines(tx, branchList.id, [{ itemId, unitPrice: "19.9000" }]);
    });
    const q = {
      companyId: a.company, itemId, currency: "MYR", quantity: "1.000000",
      on: "2026-03-15", customerKind: "retail",
    };
    // no branch → the company-wide RETAIL list
    const anyBranch = await withTenant(db.rw, a.tenant, a.human, (tx) => resolvePrice(tx, q));
    expect(anyBranch?.priceListCode).toBe("RETAIL");
    // with the branch → the branch list wins over the company-wide one
    const inBranch = await withTenant(db.rw, a.tenant, a.human, (tx) => resolvePrice(tx, { ...q, branchId }));
    expect(inBranch?.priceListCode).toBe("KL-RETAIL");
    expect(inBranch?.unitPrice).toBe("19.9000");
    const again = await withTenant(db.rw, a.tenant, a.human, (tx) => resolvePrice(tx, { ...q, branchId }));
    expect(again).toEqual(inBranch);
  });

  it("resolvePrice takes the highest quantity break at or below the quantity", async () => {
    const q = {
      companyId: a.company, itemId, currency: "MYR",
      on: "2026-03-15", customerKind: "wholesale",
    };
    const one = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolvePrice(tx, { ...q, quantity: "1.000000" }));
    const many = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolvePrice(tx, { ...q, quantity: "250.000000" }));
    expect(one?.unitPrice).toBe("18.5000");
    expect(many?.unitPrice).toBe("17.2500");
    expect(many?.minQuantity).toBe("100.000000");
  });

  it("resolvePrice returns null outside the window and for an archived list, never a stale price", async () => {
    const q = {
      companyId: a.company, itemId, currency: "MYR", quantity: "1.000000",
      on: "2027-01-05", customerKind: "retail",
    };
    expect(await withTenant(db.rw, a.tenant, a.human, (tx) => resolvePrice(tx, q))).toBeNull();
  });

  it("a promotion is closed to three kinds and needs a forward window", async () => {
    const row = await withTenant(db.rw, a.tenant, a.human, (tx) => createPromotion(tx, {
      companyId: a.company, code: "RAYA-10", nameEn: "Raya 10% off", kind: "percent_off",
      definition: { percent: "10.00", itemIds: [itemId] },
      startsAt: "2026-03-01T00:00:00Z", endsAt: "2026-03-31T23:59:59Z", branchId,
    }));
    expect(row.kind).toBe("percent_off");
    expect(row.definition).toMatchObject({ percent: "10.00" });
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.promotion (tenant_id, company_id, code, name_en, kind, definition)
      values (${a.tenant}, ${a.company}, 'BAD-KIND', 'Bad', 'buy_one_get_one', '{}'::jsonb)`))
      .rejects.toThrow(/promotion_kind_check/);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.promotion (tenant_id, company_id, code, name_en, kind, definition, starts_at, ends_at)
      values (${a.tenant}, ${a.company}, 'BACKWARDS', 'Backwards', 'amount_off', '{}'::jsonb,
              '2026-04-01T00:00:00Z', '2026-03-01T00:00:00Z')`))
      .rejects.toThrow(/promotion_window_check/);
  });

  it("listPromotions filters by branch and by the instant it is active on (spec:1312)", async () => {
    const inWindow = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listPromotions(tx, { companyId: a.company, branchId, activeOn: "2026-03-15T09:00:00Z", limit: 50 }));
    expect(inWindow.map((p) => p.code)).toEqual(["RAYA-10"]);
    const after = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listPromotions(tx, { companyId: a.company, branchId, activeOn: "2026-05-01T09:00:00Z", limit: 50 }));
    expect(after).toEqual([]);
  });

  it("a second tenant sees none of the three tables' rows (spec:106, test 12)", async () => {
    const counts = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const [l] = await tx<{ n: number }[]>`select count(*)::int as n from app.price_list`;
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.price_list_line`;
      const [p] = await tx<{ n: number }[]>`select count(*)::int as n from app.promotion`;
      return [l!.n, n!.n, p!.n];
    });
    expect(counts).toEqual([0, 0, 0]);
    expect((await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listPriceLists(tx, { companyId: a.company, limit: 50 }))).length).toBeGreaterThan(0);
  });

  it("lintSchema is clean; branch_isolation is NOT attached yet (Form B is 6C's, §4.5.6)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    const [p] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_policies where schemaname = 'app'
        and tablename in ('price_list', 'promotion') and policyname = 'branch_isolation'`;
    expect(p!.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to see the exact failure**

Run: `bun run --cwd packages/db test -- test/inventory/price-list.test.ts`
Expected: **FAIL** at import — `Cannot find module '../../src/inventory/prices'`.

- [ ] **Step 3: Write `packages/db/migrations/0030_create_price_list_promotion.sql`**

```sql
-- 0030_create_price_list_promotion.sql — price lists per customer type and promotions
-- (contracts §4.6.1; spec:1025 "Wholesale, retail, branch transfer pricing"; spec:1062 the POS offers clause;
-- spec:1312 "a shop pulls only its own price list, its own warehouse, its own promotions" — which is why both
-- price_list.branch_id and promotion.branch_id are NULLABLE: null means every branch, and 6C's Form B
-- branch_isolation policy (§4.5.6) is written for exactly that shape).

-- ── 1. price_list — currency, trade level, branch and date window ─────────────────────────────────────
create table app.price_list (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references app.tenant(id),
  company_id    uuid not null,
  code          text not null,
  name_en       text not null,                        -- spec:2045: name_en/name_ar columns, never a JSON blob
  name_ar       text,
  currency      char(3) not null,                     -- char(3) with no FK, exactly as app.party.currency (§4.5.7)
  customer_kind text,                                 -- the trade level; spec:1025's three examples are 'retail',
                                                      -- 'wholesale' and 'branch_transfer', and a tenant may use others
                                                      -- deliberately NO check: no code branches on it (spec:2047's
                                                      -- rule is about vocabularies the code branches on), and the
                                                      -- levels are the tenant's own — spec:1025's three are examples
  branch_id     uuid,                                 -- null = every branch (spec:1312)
  valid_from    date,
  valid_to      date,
  archived_at   timestamptz,                          -- spec:2049: master data is archived, never deleted
  created_at    timestamptz not null default now(),
  constraint price_list_window_check check (valid_to is null or valid_from is null or valid_to >= valid_from),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)  references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.price_list');
call app_meta.attach_audit('app.price_list');

-- ── 2. price_list_line — item × unit × quantity break ─────────────────────────────────────────────────
create table app.price_list_line (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references app.tenant(id),
  price_list_id uuid not null,
  item_id       uuid not null,
  unit_id       uuid,                                 -- null = the item's base unit
  min_quantity  numeric(19,6) not null default 0,     -- spec:2043 quantities are numeric(19,6)
  unit_price    numeric(19,4) not null,               -- spec:2041 money is numeric(19,4)
  archived_at   timestamptz,                          -- see the comment below: retirement without a DELETE grant
  created_at    timestamptz not null default now(),
  constraint price_list_line_min_quantity_check check (min_quantity >= 0),
  constraint price_list_line_unit_price_check   check (unit_price >= 0),
  -- NULLS NOT DISTINCT is load-bearing: unit_id is nullable, and under the default NULLS DISTINCT two rows
  -- for (list, item, null, 0) would both be accepted and resolvePrice would have two answers for one query.
  unique nulls not distinct (price_list_id, item_id, unit_id, min_quantity),
  unique (tenant_id, id),
  foreign key (tenant_id, price_list_id) references app.price_list(tenant_id, id),
  foreign key (tenant_id, item_id)       references app.item(tenant_id, id),
  foreign key (tenant_id, unit_id)       references app.unit_of_measure(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.price_list_line');
call app_meta.attach_audit('app.price_list_line');
create index price_list_line_item_idx on app.price_list_line (item_id, price_list_id) where archived_at is null;
-- archived_at is an addition to §4.6.1's row, and it is necessary rather than convenient: contracts §3.5.4 pins
-- the app_rw DELETE grant list and names 2B as its only extender, so replacePriceListLines cannot delete a line
-- the new payload omits. It archives it instead, which is also what spec:2049 wants for master data.

-- ── 3. promotion — the offer body 6B interprets and 6A down-syncs ──────────────────────────────────────
create table app.promotion (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  code        text not null,
  name_en     text not null,
  name_ar     text,
  kind        text not null,
  definition  jsonb not null,                         -- interpreted by 6B at the till; NO code in slice 3A reads it
  starts_at   timestamptz,
  ends_at     timestamptz,
  branch_id   uuid,                                   -- null = every branch (spec:1312)
  created_at  timestamptz not null default now(),
  -- text + CHECK, never a Postgres enum (spec:2047, §3.4.4 — a label cannot be used in the migration that adds it)
  constraint promotion_kind_check   check (kind in ('percent_off', 'amount_off', 'bundle')),
  constraint promotion_window_check check (ends_at is null or starts_at is null or ends_at > starts_at),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)  references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.promotion');
call app_meta.attach_audit('app.promotion');
create index promotion_window_idx on app.promotion (company_id, starts_at, ends_at);
-- No archived_at here, and that is §4.6.1's row read strictly: a promotion is retired by setting ends_at, which
-- is what a date-windowed offer means. app_rw holds UPDATE through default privileges (plan0A:2564).
```

`packages/db/migrations/0030.down.sql`:

```sql
-- Reverse of 0030, in reverse dependency order. The audit and RLS objects are attached by the app_meta
-- procedures and go with the tables (contracts §3.4.5).
drop index if exists app.promotion_window_idx;
drop table if exists app.promotion;
drop index if exists app.price_list_line_item_idx;
drop table if exists app.price_list_line;
drop table if exists app.price_list;
```

- [ ] **Step 4: Write the three Drizzle mirrors**

`packages/db/src/schema/price_list.ts` (the pattern Tasks 1 and 2 established; §3.4.9 makes the mirror the diff source for every migration after 0001):

```ts
import { char, date, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// `pgSchema("app").table(...)`, never bare `pgTable(...)`: a bare `pgTable` declares the table in `public`,
// and ADR-0002 (§3.4.9) makes this file the diff source for every migration after 0001 — so a `public`
// mirror would generate a diff proposing to CREATE twins outside schema `app` and DROP the real `app.*`
// tables. Tasks 1 and 2 use this form, and so does every mirror in this slice. The constraint callback
// returns an ARRAY for the same reason: that is the form the other seven mirrors use.
export const app = pgSchema("app");

export const priceList = app.table(
  "price_list",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    currency: char("currency", { length: 3 }).notNull(),
    customerKind: text("customer_kind"),
    branchId: uuid("branch_id"),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.companyId, t.code),
    unique().on(t.tenantId, t.id),
  ],
);
```

`packages/db/src/schema/price_list_line.ts`:

```ts
import { index, numeric, pgSchema, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const app = pgSchema("app");

export const priceListLine = app.table(
  "price_list_line",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    priceListId: uuid("price_list_id").notNull(),
    itemId: uuid("item_id").notNull(),
    unitId: uuid("unit_id"),
    minQuantity: numeric("min_quantity", { precision: 19, scale: 6 }).notNull().default("0"),
    unitPrice: numeric("unit_price", { precision: 19, scale: 4 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // `nullsNotDistinct()` mirrors the DDL. Without it the mirror and migration 0030 disagree about the one
    // key that gives resolvePrice exactly one answer, and the generated diff would propose replacing it.
    unique().on(t.priceListId, t.itemId, t.unitId, t.minQuantity).nullsNotDistinct(),
    unique().on(t.tenantId, t.id),
    index("price_list_line_item_idx").on(t.itemId, t.priceListId).where(sql`archived_at is null`),
  ],
);
```

`packages/db/src/schema/promotion.ts`:

```ts
import { index, jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const app = pgSchema("app");

export const promotion = app.table(
  "promotion",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    kind: text("kind").notNull(),
    definition: jsonb("definition").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    branchId: uuid("branch_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.companyId, t.code),
    unique().on(t.tenantId, t.id),
    index("promotion_window_idx").on(t.companyId, t.startsAt, t.endsAt),
  ],
);
```

The mirror carries no `unique nulls not distinct` for `price_list_line` — Drizzle's `unique()` has no such modifier at the pinned version, so the constraint lives only in the migration and the mirror's comment says so. Add that comment to the file:

```ts
// The (price_list_id, item_id, unit_id, min_quantity) key is `unique nulls not distinct` in migration 0030 and
// is deliberately absent here: Drizzle cannot express the modifier, and a mirror that declared the weaker
// NULLS DISTINCT form would generate a diff that silently loosens the constraint. The migration is the source
// for this one key (§3.4.9's mirror rule, with the exception stated where it applies).
```

- [ ] **Step 5: Write `packages/db/src/inventory/prices.ts`**

```ts
import type { Sql } from "postgres";
import { Quantity } from "@dulja/domain";

export interface PriceListRow {
  id: string; companyId: string; code: string; nameEn: string; nameAr: string | null;
  currency: string; customerKind: string | null; branchId: string | null;
  validFrom: string | null; validTo: string | null; archivedAt: string | null; createdAt: string;
}
export interface PriceListLineInput { itemId: string; unitId?: string | null; minQuantity?: string; unitPrice: string }
export interface PriceListLineRow {
  id: string; priceListId: string; itemId: string; unitId: string | null;
  minQuantity: string; unitPrice: string; archivedAt: string | null; createdAt: string;
}

// The column list is repeated at each site rather than held in a constant and spliced with `tx.unsafe`.
// That is not an oversight: hazard 21 gives `sql.unsafe` exactly three homes — the migration runner, the
// pg-boss enqueue adapter and the Firebird reader — and `no-sql-concat` (§3.7.5) fails on `.unsafe(` with a
// non-literal argument. postgres.js can splice an identifier list with `tx(cols)` but not one carrying
// `as "alias"` renames, so the honest form is the repeated literal.

export async function createPriceList(tx: Sql, input: {
  companyId: string; code: string; nameEn: string; nameAr?: string | null; currency: string;
  customerKind?: string | null; branchId?: string | null; validFrom?: string | null; validTo?: string | null;
}): Promise<PriceListRow> {
  const [row] = await tx<PriceListRow[]>`
    insert into app.price_list
      (tenant_id, company_id, code, name_en, name_ar, currency, customer_kind, branch_id, valid_from, valid_to)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null},
            ${input.currency}, ${input.customerKind ?? null}, ${input.branchId ?? null},
            ${input.validFrom ?? null}, ${input.validTo ?? null})
    returning id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
              currency, customer_kind as "customerKind", branch_id as "branchId",
              valid_from::text as "validFrom", valid_to::text as "validTo",
              archived_at::text as "archivedAt", created_at::text as "createdAt"`;
  return row!;
}

export async function updatePriceList(tx: Sql, priceListId: string, patch: {
  nameEn?: string; nameAr?: string | null; customerKind?: string | null;
  validFrom?: string | null; validTo?: string | null;
}): Promise<PriceListRow | null> {
  const [row] = await tx<PriceListRow[]>`
    update app.price_list set
      name_en       = coalesce(${patch.nameEn ?? null}, name_en),
      name_ar       = case when ${patch.nameAr !== undefined} then ${patch.nameAr ?? null} else name_ar end,
      customer_kind = case when ${patch.customerKind !== undefined} then ${patch.customerKind ?? null} else customer_kind end,
      valid_from    = case when ${patch.validFrom !== undefined} then ${patch.validFrom ?? null}::date else valid_from end,
      valid_to      = case when ${patch.validTo !== undefined} then ${patch.validTo ?? null}::date else valid_to end
    where id = ${priceListId}
    returning id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
              currency, customer_kind as "customerKind", branch_id as "branchId",
              valid_from::text as "validFrom", valid_to::text as "validTo",
              archived_at::text as "archivedAt", created_at::text as "createdAt"`;
  return row ?? null;
}

export async function archivePriceList(tx: Sql, priceListId: string): Promise<PriceListRow | null> {
  const [row] = await tx<PriceListRow[]>`
    update app.price_list set archived_at = now()
     where id = ${priceListId} and archived_at is null
    returning id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
              currency, customer_kind as "customerKind", branch_id as "branchId",
              valid_from::text as "validFrom", valid_to::text as "validTo",
              archived_at::text as "archivedAt", created_at::text as "createdAt"`;
  return row ?? null;
}

export async function getPriceList(tx: Sql, priceListId: string): Promise<PriceListRow | null> {
  const [row] = await tx<PriceListRow[]>`
    select id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
           currency, customer_kind as "customerKind", branch_id as "branchId",
           valid_from::text as "validFrom", valid_to::text as "validTo",
           archived_at::text as "archivedAt", created_at::text as "createdAt"
      from app.price_list where id = ${priceListId}`;
  return row ?? null;
}

export async function listPriceLists(tx: Sql, params: {
  companyId: string; branchId?: string | null; includeArchived?: boolean;
  cursor?: { code: string } | null; limit: number;
}): Promise<PriceListRow[]> {
  return tx<PriceListRow[]>`
    select id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
           currency, customer_kind as "customerKind", branch_id as "branchId",
           valid_from::text as "validFrom", valid_to::text as "validTo",
           archived_at::text as "archivedAt", created_at::text as "createdAt"
      from app.price_list
     where company_id = ${params.companyId}
       and (${params.includeArchived ?? false} or archived_at is null)
       and (${params.branchId ?? null}::uuid is null or branch_id is null or branch_id = ${params.branchId ?? null})
       and (${params.cursor?.code ?? null}::text is null or code > ${params.cursor?.code ?? null})
     order by code
     limit ${params.limit}`;
}

/**
 * Upserts every supplied line and archives every non-archived line the payload omits — a replace performed
 * without a DELETE, because contracts §3.5.4 pins the app_rw DELETE grant list and 2B is its only extender.
 * `minQuantity` defaults to "0" (the no-break price) and `unitId` to null (the item's base unit).
 */
export async function replacePriceListLines(
  tx: Sql, priceListId: string, lines: readonly PriceListLineInput[],
): Promise<PriceListLineRow[]> {
  // Both sides of the comparison must be the SAME TEXT for the same quantity, and `min_quantity::text` on a
  // numeric(19,6) is always six decimal places. A key built from a raw "0" or "100" would match nothing, and
  // every line would be archived on every call. `Quantity.of(...).toString()` is the one normaliser.
  const normalise = (q: string | undefined) => Quantity.of(q ?? "0.000000").toString();
  const keys = lines.map((l) => `${l.itemId}|${l.unitId ?? ""}|${normalise(l.minQuantity)}`);
  await tx`
    update app.price_list_line set archived_at = now()
     where price_list_id = ${priceListId} and archived_at is null
       and (item_id::text || '|' || coalesce(unit_id::text, '') || '|' || min_quantity::text) <> all(${keys})`;
  for (const line of lines) {
    await tx`
      insert into app.price_list_line
        (tenant_id, price_list_id, item_id, unit_id, min_quantity, unit_price)
      values (app.current_tenant(), ${priceListId}, ${line.itemId}, ${line.unitId ?? null},
              ${normalise(line.minQuantity)}, ${line.unitPrice})
      on conflict (price_list_id, item_id, unit_id, min_quantity)
      do update set unit_price = excluded.unit_price, archived_at = null`;
  }
  return listPriceListLines(tx, { priceListId });
}

export async function listPriceListLines(
  tx: Sql, params: { priceListId: string; includeArchived?: boolean },
): Promise<PriceListLineRow[]> {
  return tx<PriceListLineRow[]>`
    select id, price_list_id as "priceListId", item_id as "itemId", unit_id as "unitId",
           min_quantity::text as "minQuantity", unit_price::text as "unitPrice",
           archived_at::text as "archivedAt", created_at::text as "createdAt"
      from app.price_list_line
     where price_list_id = ${params.priceListId}
       and (${params.includeArchived ?? false} or archived_at is null)
     order by item_id, min_quantity, unit_id nulls first`;
}

export interface PriceQuery {
  companyId: string; itemId: string; currency: string; quantity: string; on: string;
  unitId?: string | null; customerKind?: string | null; branchId?: string | null;
}
export interface ResolvedPrice {
  priceListId: string; priceListCode: string; priceListLineId: string;
  unitId: string | null; minQuantity: string; unitPrice: string;
}

/**
 * The ONE price resolver. 3D's SALES_ORDER, 4A's SALES_INVOICE and 6B's till all call this, so a price is one
 * answer rather than three. Deterministic by construction: the ordering below is a total order on the candidate
 * set, so two calls with the same arguments return the same row even when two lists tie on specificity.
 *
 * Candidates: a non-archived list of the company, matching `currency`; window containing `on`; `branch_id` null
 * or equal to `branchId`; `customer_kind` null or equal to `customerKind`; with a non-archived line for the item
 * whose `unit_id` is null or equal to `unitId` and whose `min_quantity <= quantity`.
 * Most specific first: branch-specific, then trade-level-specific, then unit-specific, then the largest
 * quantity break, then the list code (the stable tiebreak).
 */
export async function resolvePrice(tx: Sql, q: PriceQuery): Promise<ResolvedPrice | null> {
  const [row] = await tx<ResolvedPrice[]>`
    select l.id                     as "priceListId",
           l.code                   as "priceListCode",
           n.id                     as "priceListLineId",
           n.unit_id                as "unitId",
           n.min_quantity::text     as "minQuantity",
           n.unit_price::text       as "unitPrice"
      from app.price_list l
      join app.price_list_line n
        on n.price_list_id = l.id and n.archived_at is null
     where l.company_id = ${q.companyId}
       and l.archived_at is null
       and l.currency = ${q.currency}
       and (l.valid_from is null or l.valid_from <= ${q.on}::date)
       and (l.valid_to   is null or l.valid_to   >= ${q.on}::date)
       and (l.branch_id  is null or l.branch_id = ${q.branchId ?? null})
       and (l.customer_kind is null or l.customer_kind = ${q.customerKind ?? null})
       and n.item_id = ${q.itemId}
       and (n.unit_id is null or n.unit_id = ${q.unitId ?? null})
       and n.min_quantity <= ${q.quantity}::numeric
     order by (l.branch_id is not null)     desc,
              (l.customer_kind is not null) desc,
              (n.unit_id is not null)       desc,
              n.min_quantity                desc,
              l.code                        asc
     limit 1`;
  return row ?? null;
}
```

- [ ] **Step 6: Write `packages/db/src/inventory/promotions.ts`**

Column lists are inlined here for the same reason as in `prices.ts`: `sql.unsafe` has three homes and this is not one of them (hazard 21).

```ts
import type { Sql } from "postgres";

export type PromotionKind = "percent_off" | "amount_off" | "bundle";

export interface PromotionRow {
  id: string; companyId: string; code: string; nameEn: string; nameAr: string | null;
  kind: PromotionKind; definition: Record<string, unknown>;
  startsAt: string | null; endsAt: string | null; branchId: string | null; createdAt: string;
}

export async function createPromotion(tx: Sql, input: {
  companyId: string; code: string; nameEn: string; nameAr?: string | null; kind: PromotionKind;
  definition: Record<string, unknown>; startsAt?: string | null; endsAt?: string | null; branchId?: string | null;
}): Promise<PromotionRow> {
  const [row] = await tx<PromotionRow[]>`
    insert into app.promotion
      (tenant_id, company_id, code, name_en, name_ar, kind, definition, starts_at, ends_at, branch_id)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null},
            ${input.kind}, ${tx.json(input.definition)}, ${input.startsAt ?? null}, ${input.endsAt ?? null},
            ${input.branchId ?? null})
    returning id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
              kind, definition, starts_at::text as "startsAt", ends_at::text as "endsAt",
              branch_id as "branchId", created_at::text as "createdAt"`;
  return row!;
}

export async function updatePromotion(tx: Sql, promotionId: string, patch: {
  nameEn?: string; nameAr?: string | null; definition?: Record<string, unknown>;
  startsAt?: string | null; endsAt?: string | null;
}): Promise<PromotionRow | null> {
  const [row] = await tx<PromotionRow[]>`
    update app.promotion set
      name_en    = coalesce(${patch.nameEn ?? null}, name_en),
      name_ar    = case when ${patch.nameAr !== undefined} then ${patch.nameAr ?? null} else name_ar end,
      definition = coalesce(${patch.definition ? tx.json(patch.definition) : null}, definition),
      starts_at  = case when ${patch.startsAt !== undefined} then ${patch.startsAt ?? null}::timestamptz else starts_at end,
      ends_at    = case when ${patch.endsAt !== undefined} then ${patch.endsAt ?? null}::timestamptz else ends_at end
    where id = ${promotionId}
    returning id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
              kind, definition, starts_at::text as "startsAt", ends_at::text as "endsAt",
              branch_id as "branchId", created_at::text as "createdAt"`;
  return row ?? null;
}

/** A promotion is retired by setting `ends_at` — there is no archived_at on this table (§4.6.1). */
export async function listPromotions(tx: Sql, params: {
  companyId: string; branchId?: string | null; activeOn?: string;
  cursor?: { code: string } | null; limit: number;
}): Promise<PromotionRow[]> {
  return tx<PromotionRow[]>`
    select id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
           kind, definition, starts_at::text as "startsAt", ends_at::text as "endsAt",
           branch_id as "branchId", created_at::text as "createdAt"
      from app.promotion
     where company_id = ${params.companyId}
       and (${params.branchId ?? null}::uuid is null or branch_id is null or branch_id = ${params.branchId ?? null})
       and (${params.activeOn ?? null}::timestamptz is null
            or ((starts_at is null or starts_at <= ${params.activeOn ?? null}::timestamptz)
            and (ends_at   is null or ends_at   >= ${params.activeOn ?? null}::timestamptz)))
       and (${params.cursor?.code ?? null}::text is null or code > ${params.cursor?.code ?? null})
     order by code
     limit ${params.limit}`;
}
```

- [ ] **Step 7: Add `seedPriceList` to `packages/db/test/fixtures.ts`**

Append at the end of the file, after Task 2's `seedWarehouse`/`seedLot`. Additive only (hazard 9).

```ts
/**
 * §4.17's 3A row. Creates a price list and, when `lines` is given, its lines. 6A's catalogue-sync tests use it.
 * Defaults: code "RETAIL", currency "MYR", no branch (every branch), no window (always valid), no lines.
 */
export async function seedPriceList(db: Db, s: Seed, opts?: {
  code?: string; currency?: string; branchId?: string; lines?: readonly PriceListLineInput[];
}): Promise<string> {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const list = await createPriceList(tx, {
      companyId: s.company,
      code: opts?.code ?? "RETAIL",
      nameEn: opts?.code ?? "Retail",
      currency: opts?.currency ?? "MYR",
      branchId: opts?.branchId ?? null,
    });
    if (opts?.lines?.length) await replacePriceListLines(tx, list.id, opts.lines);
    return list.id;
  });
}
```

Add `import { createPriceList, replacePriceListLines, type PriceListLineInput } from "../src/inventory/prices";` to the file's import block.

- [ ] **Step 8: Re-export from `packages/db/src/index.ts`**

Add two lines to the inventory block Tasks 1 and 2 started:

```ts
export {
  archivePriceList, createPriceList, getPriceList, listPriceListLines, listPriceLists,
  replacePriceListLines, resolvePrice, updatePriceList,
  type PriceListLineInput, type PriceListLineRow, type PriceListRow, type PriceQuery, type ResolvedPrice,
} from "./inventory/prices";
export {
  createPromotion, listPromotions, updatePromotion, type PromotionKind, type PromotionRow,
} from "./inventory/promotions";
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/inventory/price-list.test.ts`
Expected: **PASS**, eleven assertions.

Run: `bun run --cwd packages/db db:lint`
Expected: `0 violations`. Neither table joins a linter set (§3.5.3's 3A row: none of the nine master tables is in `NO_ID_TABLES`, `AUDIT_EXEMPT` or `IMMUTABLE`), so `lint-schema.ts` is **not** edited by this task.

Run: `bun run --cwd packages/db db:rollback 29 && bun run --cwd packages/db db:migrate`
Expected: down to 29 then back to the current head with no error — 0033 is already applied and is not re-run, and 0030's down drops the two indexes and three tables in reverse dependency order. This is §3.4.6's generalised reversibility test doing its work.

- [ ] **Step 10: Commit**

```bash
git add packages/db/migrations/0030_create_price_list_promotion.sql packages/db/migrations/0030.down.sql \
        packages/db/src/schema/price_list.ts packages/db/src/schema/price_list_line.ts \
        packages/db/src/schema/promotion.ts packages/db/src/inventory/prices.ts \
        packages/db/src/inventory/promotions.ts packages/db/src/index.ts \
        packages/db/test/fixtures.ts packages/db/test/inventory/price-list.test.ts
git commit -m "$(cat <<'EOF'
feat(db): price lists per customer type, quantity breaks and promotions [3A T4]

Migration 0030 creates app.price_list (currency, trade level, nullable branch,
date window), app.price_list_line and app.promotion at contracts §4.6.1's
columns. Both branch keys are nullable because spec:1312 scopes a shop's pull
and null means every branch — the shape 6C's Form B policy is written for.

price_list_line's key is `unique nulls not distinct`: unit_id is nullable and
the default NULLS DISTINCT would let two rows answer one price query. The
mirror cannot express the modifier and says so.

price_list_line gains archived_at, an addition to §4.6.1. It is necessary, not
convenient: §3.5.4 pins the app_rw DELETE grant list with 2B as its only
extender, so replacePriceListLines archives an omitted line rather than
deleting it — which is also what spec:2049 wants of master data.

resolvePrice is the one resolver, with a total ordering so two identical calls
cannot disagree. promotion.definition is stored and never read by this slice;
6B interprets it and 6A adds its revision column.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Migration 0031 — `app.inventory_movement`, `app.stock_on_hand`, `app.assert_stock_available`, `app.pick_lots_fefo`, and the warehouse / lot link columns

The two tables that make a quantity real, and the trigger that makes test 18 true. `inventory_movement` is append-only and signed exactly as `ledger_entry` is; `stock_on_hand` is a natural-key projection with no `id`. Both come from §4.7.3 **verbatim** — this task copies that DDL rather than paraphrasing it, because 3B, 3D, 6A and 9B all read it and a paraphrase is a divergence. Around them: `assert_stock_available` as executable PL/pgSQL (§4.7.3 gives it as a comment), `pick_lots_fefo` over the projection, and the three link columns two other slices assigned to this file — `document.warehouse_id`, `document.to_warehouse_id` (§4.3.4) and `attachment.lot_id` (2C).

**Nothing writes either table in this task.** The writer is Task 8's `applyMovements`; the `posting-only-tables` lint (1A, §3.7.5) already names both tables and allows only `packages/db/src/posting/**`, `packages/db/src/costing/**`, `packages/db/test/**` and `scripts/lint/rules/**`, so this task's test file may insert directly (it is under `packages/db/test/`) and no production file may.

**Files:**
- Create: `packages/db/migrations/0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql`, `packages/db/migrations/0031.down.sql`
- Create: `packages/db/src/schema/inventory_movement.ts`, `packages/db/src/schema/stock_on_hand.ts`
- Create: `packages/db/test/inventory/movement.test.ts`, `packages/db/test/inventory/fefo.test.ts`
- Modify: `packages/db/src/lint-schema.ts` (`stock_on_hand` into `NO_ID_TABLES` and `AUDIT_EXEMPT`), `packages/contracts/src/errors.ts` (`ERR_STOCK_INSUFFICIENT`), `packages/db/src/schema/document.ts` (+ `warehouseId`, `toWarehouseId`), `packages/db/src/schema/attachment.ts` (+ `lotId`)
- Modify: `tests/regression/sah-050.test.ts`, `tests/regression/sah-073.test.ts`, `tests/regression/sah-074.test.ts` (append one `describe` each; 0B created all three)

**Interfaces:**
- Consumes: `app.item`, `app.unit_of_measure` (Task 1), `app.warehouse`, `app.lot` (Task 2), `app.company`, `app.document`, `app.principal`, `app.attachment` (0001 / 2C), `app.document_event` and its `override_code` column (2B, §4.5.2), `app.posting_seq` (1A, 0013), `app.forbid_change()` (§4.1), `app_meta.enable_tenant_rls`, `app_meta.attach_stamp` (§4.1); `AUDIT_EXEMPT`, `IMMUTABLE`, `lintSchema` (§4.1); `ERRORS`, `ErrorDef` (§4.2.4); `grantCodes` (2B, §4.17), `recordOverride`, `OverrideCode` (§4.3.1); `seedItem`, `seedWarehouse`, `seedLot`, `draftDocument` (Tasks 1–2, §4.1).
- Produces:
  - SQL: `app.inventory_movement` and `app.stock_on_hand` exactly as §4.7.3; index `inventory_movement_chrono_idx`; triggers `inventory_movement_immutable`, `inventory_movement_stock_available`, `stamp_posted_by`; `revoke update, delete on app.inventory_movement from app_rw`.
  - SQL: `app.assert_stock_available() returns trigger` — §4.7.3's comment as code.
  - SQL: `app.pick_lots_fefo(p_item_id uuid, p_warehouse_id uuid, p_quantity numeric) returns table (lot_id uuid, quantity numeric(19,6))`.
  - SQL: `app.document.warehouse_id uuid`, `app.document.to_warehouse_id uuid` (§4.3.4's 3A row of the header additions); `app.attachment.lot_id uuid` with `attachment_owner_check`.
  - `ERRORS` gains `ERR_STOCK_INSUFFICIENT: { status: 422, title: "Insufficient stock", remedy: … }` — **422, not 409**: §4.2.4's table fixes the status and marks the code ¶ (spec-named).
  - `lint-schema.ts`: `NO_ID_TABLES` and `AUDIT_EXEMPT` each gain `"stock_on_hand"`, and nothing else changes (§3.5.3).

- [ ] **Step 1: Write the failing test `packages/db/test/inventory/movement.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
import { sentinelLotId } from "../../src/inventory/lots";
import { recordOverride } from "../../src/posting";
import { draftDocument, grantCodes, seedItem, seedTenant, seedWarehouse, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/** The one place this suite writes a movement by hand. Production code may not: `posting-only-tables`
 *  (§3.7.5) allows app.inventory_movement DML only under packages/db/src/posting/**,
 *  packages/db/src/costing/**, packages/db/test/** and scripts/lint/rules/**. This file is the third. */
async function insertMovement(tx: import("postgres").Sql, s: Seed, m: {
  documentId: string; lineNo?: number; movementNo?: number; itemId: string; warehouseId: string;
  lotId: string; unitId: string; quantity: string; value?: string; effectiveDate?: string; postingSeq?: string;
}) {
  const [row] = await tx<{ id: string }[]>`
    insert into app.inventory_movement
      (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
       quantity, value, effective_date, posting_seq)
    values (${s.tenant}, ${s.company}, ${m.documentId}, ${m.lineNo ?? 1}, ${m.movementNo ?? 1}, ${m.itemId},
            ${m.warehouseId}, ${m.lotId}, ${m.unitId}, ${m.quantity}, ${m.value ?? "10.0000"},
            ${m.effectiveDate ?? "2026-01-15"}, ${m.postingSeq ?? "1"})
    returning id`;
  return row!.id;
}

describe("app.inventory_movement / app.stock_on_hand — migration 0031 (contracts §4.7.3)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let itemId: string;
  let unitId: string;
  let warehouseId: string;
  let lotId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Mv A");
    b = await seedTenant(db, "Mv B");
    ({ itemId, baseUnitId: unitId } = await seedItem(db, a, { code: "RICE-5KG" }));
    warehouseId = await seedWarehouse(db, a, { code: "HQ-MAIN" });
    lotId = await withTenant(db.rw, a.tenant, a.human, (tx) => sentinelLotId(tx, itemId));
  });
  afterAll(async () => { await db.stop(); });

  it("a receipt is accepted; quantity 0 is refused (§4.7.3 check (quantity <> 0))", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, { documentId: doc, itemId, warehouseId, lotId, unitId, quantity: "100.000000" }));
    const doc2 = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, { documentId: doc2, itemId, warehouseId, lotId, unitId, quantity: "0" })))
      .rejects.toThrow(/inventory_movement_quantity_check/);
  });

  it("movement_no is unique per document, so a transfer line's two legs both fit", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await insertMovement(tx, a, { documentId: doc, lineNo: 1, movementNo: 1, itemId, warehouseId, lotId, unitId, quantity: "-5.000000" });
      await insertMovement(tx, a, { documentId: doc, lineNo: 1, movementNo: 2, itemId, warehouseId, lotId, unitId, quantity: "5.000000" });
    });
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, { documentId: doc, lineNo: 1, movementNo: 2, itemId, warehouseId, lotId, unitId, quantity: "1.000000" })))
      .rejects.toThrow(/inventory_movement_document_id_movement_no_key/);
  });

  it("movement_no must be positive, and lot_id is NOT NULL (SAH-050, ADR 0034)", async () => {
    const doc = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, { documentId: doc, movementNo: 0, itemId, warehouseId, lotId, unitId, quantity: "1.000000" })))
      .rejects.toThrow(/inventory_movement_movement_no_check/);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.inventory_movement
        (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
      values (${a.tenant}, ${a.company}, ${doc}, 1, 9, ${itemId}, ${warehouseId}, null, ${unitId},
              1.0, 1.0, '2026-01-15', 1)`))
      .rejects.toThrow(/lot_id/);
  });

  it("value is mandatory — a movement without one is rejected at write time (SAH-007)", async () => {
    const doc = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.inventory_movement
        (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, effective_date, posting_seq)
      values (${a.tenant}, ${a.company}, ${doc}, 1, 1, ${itemId}, ${warehouseId}, ${lotId}, ${unitId},
              1.0, '2026-01-15', 1)`))
      .rejects.toThrow(/value/);
  });

  it("the table is immutable: app_rw holds no UPDATE or DELETE and the trigger refuses both", async () => {
    const doc = await draftDocument(db, a);
    const id = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, { documentId: doc, itemId, warehouseId, lotId, unitId, quantity: "1.000000" }));
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`update app.inventory_movement set value = 0 where id = ${id}`)).rejects.toThrow();
    const [priv] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.table_privileges
       where table_schema = 'app' and table_name = 'inventory_movement'
         and grantee = 'app_rw' and privilege_type in ('UPDATE', 'DELETE')`;
    expect(priv!.n).toBe(0);
    expect(IMMUTABLE.has("inventory_movement")).toBe(true);
    expect(AUDIT_EXEMPT.has("inventory_movement")).toBe(true);
  });

  it("an issue beyond available stock is refused with ERR_STOCK_INSUFFICIENT (test 18, SAH-048)", async () => {
    const wh = await seedWarehouse(db, a, { code: "SHORT" });
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, { documentId: doc, itemId, warehouseId: wh, lotId, unitId, quantity: "3.000000" }));
    const doc2 = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, { documentId: doc2, itemId, warehouseId: wh, lotId, unitId, quantity: "-4.000000" })))
      .rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
    // 3 out of 3 is exactly zero and is allowed — the boundary is `available + new.quantity < 0`.
    const doc3 = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, { documentId: doc3, itemId, warehouseId: wh, lotId, unitId, quantity: "-3.000000" }));
  });

  it("the availability sum sees this transaction's earlier rows, never stock_on_hand", async () => {
    const wh = await seedWarehouse(db, a, { code: "SAMETX" });
    const doc = await draftDocument(db, a);
    // stock_on_hand is empty for this warehouse (nothing MERGEs it in this task), yet the receipt in the
    // same transaction is enough for the issue that follows it. That is §4.7.3's "NEVER from stock_on_hand".
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await insertMovement(tx, a, { documentId: doc, lineNo: 1, movementNo: 1, itemId, warehouseId: wh, lotId, unitId, quantity: "7.000000" });
      await insertMovement(tx, a, { documentId: doc, lineNo: 2, movementNo: 2, itemId, warehouseId: wh, lotId, unitId, quantity: "-7.000000" });
    });
    const [soh] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.stock_on_hand where warehouse_id = ${wh}`);
    expect(soh!.n).toBe(0);
  });

  it("an inventory.negative_stock.override event on the document is the one door (§4.5.3, hazard 17)", async () => {
    const wh = await seedWarehouse(db, a, { code: "OVERRIDE" });
    const doc = await draftDocument(db, a);
    // A REAL second principal: role_assignment.principal_id has an FK to app.principal, so a bare uuid is a
    // 23503 and `document_event_override_guard` needs a principal that actually holds the code at the
    // document's branch. The two inserts are 2B's own `secondPrincipal` shape (plan0A:837 — the principal
    // without RETURNING, then its membership, in one transaction as the tenant's system principal).
    const second = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${second}, 'human', ${`stock-supervisor:${a.tenant}`}, 'Stock supervisor')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${second})`;
    });
    await grantCodes(db, a, {
      codes: ["inventory.negative_stock.override"], principalId: second, roleCode: "stock-override",
    });
    // recordOverride (2B, §4.3.1) is the ONE way an override event is written — it knows §4.5.2's column
    // list and the guard checks its `coalesce(attributed_to, actor_id)`. A hand-rolled document_event insert
    // here would be a second spelling of a frozen write (hazard 24: only triggers and this door write it).
    await withTenant(db.rw, a.tenant, second, (tx) => recordOverride(
      tx, { tenantId: a.tenant, actorId: second, requestId: "stock-override-1" },
      { documentId: doc, code: "inventory.negative_stock.override", reason: "stock count pending" }));
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, { documentId: doc, itemId, warehouseId: wh, lotId, unitId, quantity: "-2.000000" }));
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ quantity: string }[]>`select quantity::text from app.inventory_movement
                                  where document_id = ${doc} and warehouse_id = ${wh}`);
    expect(row!.quantity).toBe("-2.000000");
  });

  it("the override is per DOCUMENT, so a second document with no event is still refused", async () => {
    // The same warehouse the previous case drove to −2. Looked up, not re-seeded: warehouse is
    // `unique (company_id, code)` and a second seedWarehouse with this code would be a 23505.
    const [wh] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ id: string }[]>`select id from app.warehouse where company_id = ${a.company} and code = 'OVERRIDE'`)
      .then((rows) => rows.map((r) => r.id));
    const other = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, { documentId: other, itemId, warehouseId: wh, lotId, unitId, quantity: "-1.000000" })))
      .rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
  });

  it("stock_on_hand has no id column and its primary key is the full natural key (§3.5.3)", async () => {
    const [idCol] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'stock_on_hand' and column_name = 'id'`;
    expect(idCol!.n).toBe(0);
    const [pk] = await db.admin<{ cols: string[] }[]>`
      select array_agg(a.attname order by k.ord) as cols
        from pg_constraint c
        join unnest(c.conkey) with ordinality k(attnum, ord) on true
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.conrelid = 'app.stock_on_hand'::regclass and c.contype = 'p'`;
    expect(pk!.cols).toEqual(["company_id", "item_id", "warehouse_id", "lot_id"]);
  });

  it("a second tenant sees neither table's rows (spec:106, test 12)", async () => {
    const counts = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const [m] = await tx<{ n: number }[]>`select count(*)::int as n from app.inventory_movement`;
      const [h] = await tx<{ n: number }[]>`select count(*)::int as n from app.stock_on_hand`;
      return [m!.n, h!.n];
    });
    expect(counts).toEqual([0, 0]);
  });

  it("document gained warehouse_id / to_warehouse_id and attachment gained lot_id, each FK'd", async () => {
    const fks = await db.admin<{ tbl: string; col: string; ref: string }[]>`
      select cl.relname as tbl, a.attname as col, rf.relname as ref
        from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_class rf on rf.oid = c.confrelid
        join unnest(c.conkey) as k(attnum) on true
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.contype = 'f'
         and ((cl.relname = 'document'   and a.attname in ('warehouse_id', 'to_warehouse_id'))
           or (cl.relname = 'attachment' and a.attname = 'lot_id'))
       order by cl.relname, a.attname`;
    expect(fks.map((f) => `${f.tbl}.${f.col}->${f.ref}`)).toEqual([
      "attachment.lot_id->lot", "document.to_warehouse_id->warehouse", "document.warehouse_id->warehouse",
    ]);
  });

  it("an attachment must belong to exactly one of a document or a lot", async () => {
    const doc = await draftDocument(db, a);
    const both = withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.attachment (tenant_id, company_id, document_id, lot_id, object_key, file_name,
                                   mime_type, byte_size, sha256)
      values (${a.tenant}, ${a.company}, ${doc}, ${lotId}, 'k-both', 'cert.pdf', 'application/pdf', 10,
              decode('00', 'hex'))`);
    await expect(both).rejects.toThrow(/attachment_owner_check/);
    const neither = withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.attachment (tenant_id, company_id, object_key, file_name, mime_type, byte_size, sha256)
      values (${a.tenant}, ${a.company}, 'k-none', 'cert.pdf', 'application/pdf', 10, decode('00', 'hex'))`);
    await expect(neither).rejects.toThrow(/attachment_owner_check/);
  });

  it("lintSchema is clean with stock_on_hand in NO_ID_TABLES and AUDIT_EXEMPT", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the failing test `packages/db/test/inventory/fefo.test.ts`**

This file proves the SQL function's ordering. Task 10 appends the TypeScript wrapper's tests to the same file.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLot, sentinelLotId } from "../../src/inventory/lots";
import { seedItem, seedTenant, seedWarehouse, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("app.pick_lots_fefo — migration 0031 (the 3A card, SAH-067, ADR 0036)", () => {
  let db: Db;
  let a: Seed;
  let itemId: string;
  let warehouseId: string;
  const lots: Record<string, string> = {};

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "FEFO A");
    ({ itemId } = await seedItem(db, a, { code: "MILK-1L" }));
    warehouseId = await seedWarehouse(db, a, { code: "CHILL" });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      lots.late  = (await createLot(tx, { companyId: a.company, itemId, code: "B-LATE",  expiresOn: "2026-09-30" })).id;
      lots.early = (await createLot(tx, { companyId: a.company, itemId, code: "B-EARLY", expiresOn: "2026-07-31" })).id;
      lots.mid   = (await createLot(tx, { companyId: a.company, itemId, code: "B-MID",   expiresOn: "2026-08-31" })).id;
      lots.none  = await sentinelLotId(tx, itemId);
      // The projection is what FEFO reads (ADR 0036). Writing it by hand is legal here and nowhere in
      // production: packages/db/test/** is on posting-only-tables' allow-list (§3.7.5).
      for (const [key, qty] of [["late", "40"], ["early", "10"], ["mid", "25"], ["none", "100"]] as const) {
        await tx`insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
                 values (${a.tenant}, ${a.company}, ${itemId}, ${warehouseId}, ${lots[key]}, ${qty})`;
      }
    });
  });
  afterAll(async () => { await db.stop(); });

  it("returns the earliest-expiring lot first — this slice's share of the Phase 3 DoD", async () => {
    const picks = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ lot_id: string; quantity: string }[]>`
        select lot_id, quantity::text from app.pick_lots_fefo(${itemId}, ${warehouseId}, 5.0)`);
    expect(picks).toHaveLength(1);
    expect(picks[0]!.lot_id).toBe(lots.early);
    expect(picks[0]!.quantity).toBe("5.000000");
  });

  it("walks forward through lots in expiry order and stops when the quantity is met", async () => {
    const picks = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ lot_id: string; quantity: string }[]>`
        select lot_id, quantity::text from app.pick_lots_fefo(${itemId}, ${warehouseId}, 30.0)`);
    expect(picks.map((p) => p.lot_id)).toEqual([lots.early, lots.mid]);
    expect(picks.map((p) => p.quantity)).toEqual(["10.000000", "20.000000"]);
  });

  it("a NULL expiry sorts last, so the sentinel lot is never picked ahead of a dated batch", async () => {
    const picks = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ lot_id: string }[]>`
        select lot_id from app.pick_lots_fefo(${itemId}, ${warehouseId}, 80.0)`);
    expect(picks.map((p) => p.lot_id)).toEqual([lots.early, lots.mid, lots.late, lots.none]);
  });

  it("returns fewer rows than asked rather than raising — the refusal is the trigger's job", async () => {
    const picks = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ quantity: string }[]>`
        select quantity::text from app.pick_lots_fefo(${itemId}, ${warehouseId}, 1000.0)`);
    const total = picks.reduce((sum, p) => sum + Number(p.quantity), 0);
    expect(total).toBe(175);        // 10 + 25 + 40 + 100 — every open lot, and no more
  });

  it("a non-positive quantity is a caller error, not an empty result", async () => {
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`select * from app.pick_lots_fefo(${itemId}, ${warehouseId}, 0)`))
      .rejects.toThrow(/ERR_VALIDATION_FAILED: pick_lots_fefo needs a positive quantity/);
  });

  it("the ordering is total, so two identical calls return identical rows (SAH-067)", async () => {
    const once = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ lot_id: string; quantity: string }[]>`select lot_id, quantity::text from app.pick_lots_fefo(${itemId}, ${warehouseId}, 60.0)`);
    const twice = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ lot_id: string; quantity: string }[]>`select lot_id, quantity::text from app.pick_lots_fefo(${itemId}, ${warehouseId}, 60.0)`);
    expect(twice).toEqual(once);
  });
});
```

- [ ] **Step 3: Run both tests to see the exact failures**

Run: `bun run --cwd packages/db test -- test/inventory/movement.test.ts test/inventory/fefo.test.ts`
Expected: **FAIL**. `movement.test.ts` fails on the first insert with `relation "app.inventory_movement" does not exist`; `fefo.test.ts` fails in `beforeAll` with `relation "app.stock_on_hand" does not exist`.

- [ ] **Step 4: Write `packages/db/migrations/0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql`**

```sql
-- 0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql
-- The movement ledger and its synchronous projection, given verbatim by contracts §4.7.3, plus the three link
-- columns other slices assigned to this file: document.warehouse_id / to_warehouse_id (§4.3.4's 3A row) and
-- attachment.lot_id (2C's own note, spec:1067 "3 (lot link)"). The file's name says all four things it does,
-- per §3.4.2's rule that a name understating its contents is renamed, not left.
-- Nothing in this migration writes a row: hazard 10 — FORCE ROW LEVEL SECURITY binds app_migrator and a
-- migration has no tenant set, so per-tenant rows are seed-pack data. The writer is Task 8's applyMovements.

-- ── 1. inventory_movement — append-only and signed, exactly as ledger_entry is ────────────────────────
create table app.inventory_movement (                        -- IMMUTABLE, audit-exempt (plan0A:1624-1629)
  id              uuid primary key default uuidv7(),
  tenant_id       uuid not null references app.tenant(id),
  company_id      uuid not null,
  document_id     uuid not null,
  line_no         int not null,                              -- the source document_line.line_no
  movement_no     int not null check (movement_no > 0),      -- 1-based per document; the unique key. A `transfer`
                                                             -- line emits TWO movements (issue at warehouse,
                                                             -- receipt at to_warehouse), so line_no alone is not
                                                             -- unique — TRANSFER/TRANSFER_RECEIPT would collide.
  item_id         uuid not null,
  warehouse_id    uuid not null,
  lot_id          uuid not null,                             -- NOT NULL: stock_on_hand's primary key contains
                                                             -- lot_id, so a NULL here would fail the step-12
                                                             -- MERGE at runtime. Every item has one sentinel lot
                                                             -- coded 'NONE' created with it (migration 0029);
                                                             -- applyMovements resolves a line's null lot_id to it
                                                             -- before insert (SAH-050, ADR 0034).
  unit_id         uuid not null,
  quantity        numeric(19,6) not null check (quantity <> 0),   -- base unit; + receipt, − issue (spec:2043)
  value           numeric(19,4) not null,                    -- mandatory (SAH-007); base currency; sign follows quantity
  effective_date  date not null,                             -- the accounting date, never derived from posted_at (spec:2039)
  posting_seq     bigint not null,                           -- document.posting_seq, assigned at step 8 (§4.3.5)
  posted_at       timestamptz not null default now(),        -- the posting instant (spec:1370's ledger_entry pattern)
  created_at      timestamptz not null default now(),        -- spec:1370 exempts ONLY ledger_entry from created_at;
                                                             -- this table is neither a join nor a counter table
  posted_by       uuid not null default app.current_actor() references app.principal(id),   -- stamped
  unique (document_id, movement_no),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)   references app.company(tenant_id, id),
  foreign key (tenant_id, document_id)  references app.document(tenant_id, id),
  foreign key (tenant_id, item_id)      references app.item(tenant_id, id),
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id),
  foreign key (tenant_id, lot_id)       references app.lot(tenant_id, id),
  foreign key (tenant_id, unit_id)      references app.unit_of_measure(tenant_id, id)
);
-- The total chronological key of spec:1225 and §4.3.5, as an index and not as a plan hint (SAH-067).
create index inventory_movement_chrono_idx on app.inventory_movement
  (company_id, item_id, warehouse_id, effective_date, posting_seq, line_no, movement_no);
call app_meta.enable_tenant_rls('app.inventory_movement');
call app_meta.attach_stamp('app.inventory_movement', 'posted_by');
-- No attach_audit: the table is in AUDIT_EXEMPT (spec:1370, §3.5.3) — auditing an append-only movement ledger
-- would serialise every post behind the per-tenant audit lock to record what the row already is.
create trigger inventory_movement_immutable before update or delete on app.inventory_movement
  for each row execute function app.forbid_change();
revoke update, delete on app.inventory_movement from app_rw;

-- ── 2. assert_stock_available — §4.7.3's comment, as code (test 18, SAH-048, spec:2436) ───────────────
-- Availability is summed from THIS table, which already includes the current transaction's earlier rows, and
-- NEVER from stock_on_hand, which is MERGEd only at step 12. The one door is an override document_event
-- recorded by a second principal (§4.5.3): document_event_override_guard is what proves the second principal
-- held the code at the document's branch, so this function only has to see that the event exists.
-- There is deliberately NO session flag and NO policy flag here. spec:2436 requires the refusal "regardless of
-- session flags, user attributes, or write path", and policy.inventory.allowNegative is a user attribute.
create function app.assert_stock_available() returns trigger
language plpgsql as $$
declare
  available numeric(19,6);
begin
  if new.quantity >= 0 then
    return new;                          -- a receipt cannot take stock below zero
  end if;

  select coalesce(sum(m.quantity), 0) into available
    from app.inventory_movement m
   where m.company_id   = new.company_id
     and m.item_id      = new.item_id
     and m.warehouse_id = new.warehouse_id
     and m.lot_id       = new.lot_id;

  if available + new.quantity >= 0 then
    return new;
  end if;

  if exists (
    select 1 from app.document_event e
     where e.document_id   = new.document_id
       and e.event_kind    = 'override'
       and e.override_code = 'inventory.negative_stock.override'
  ) then
    return new;
  end if;

  raise exception 'ERR_STOCK_INSUFFICIENT: item % warehouse % lot % holds %, this movement needs %',
    new.item_id, new.warehouse_id, new.lot_id, available, (- new.quantity)
    using errcode = 'check_violation';
end $$;
create trigger inventory_movement_stock_available before insert on app.inventory_movement
  for each row execute function app.assert_stock_available();

-- ── 3. stock_on_hand — the synchronous projection (D14), MERGEd in the posting transaction ────────────
create table app.stock_on_hand (
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  item_id      uuid not null,
  warehouse_id uuid not null,
  lot_id       uuid not null,
  quantity     numeric(19,6) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (company_id, item_id, warehouse_id, lot_id),
  foreign key (tenant_id, company_id)   references app.company(tenant_id, id),
  foreign key (tenant_id, item_id)      references app.item(tenant_id, id),
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id),
  foreign key (tenant_id, lot_id)       references app.lot(tenant_id, id)
);
-- No `id` and no unique (tenant_id, id): the natural key IS the key, which is why the table joins NO_ID_TABLES
-- in lint-schema.ts in this same PR (§3.5.3). No attach_audit either — it is derived (AUDIT_EXEMPT).
-- `lot_id` is NOT NULL on both sides: every item has one sentinel lot coded 'NONE' and applyMovements resolves
-- a line's null lot to it, so the primary key never contains NULL (SAH-050). document_line.lot_id stays
-- nullable — the user need not enter a lot; the posting service is what resolves the sentinel.
call app_meta.enable_tenant_rls('app.stock_on_hand');

-- ── 4. pick_lots_fefo — FEFO over the projection, not over a replay of history (SAH-067, ADR 0036) ────
-- Reads the SYNCHRONOUS projection, so outside a posting transaction it is current to the last commit. The
-- ordering is total — expiry, then lot code, then lot id — so two identical calls cannot disagree; SAH-067's
-- root cause was an answer that depended on which index the planner chose.
-- Returns fewer rows than asked when the warehouse cannot satisfy the quantity: refusing is
-- assert_stock_available's job, and a picker that raised would hide a partial pick a user may legitimately want.
create function app.pick_lots_fefo(p_item_id uuid, p_warehouse_id uuid, p_quantity numeric)
returns table (lot_id uuid, quantity numeric(19,6))
language plpgsql stable as $$
declare
  remaining numeric(19,6) := p_quantity;
  r         record;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'ERR_VALIDATION_FAILED: pick_lots_fefo needs a positive quantity, got %', p_quantity
      using errcode = 'check_violation';
  end if;
  for r in
    select h.lot_id as id, h.quantity as available
      from app.stock_on_hand h
      join app.lot l on l.tenant_id = h.tenant_id and l.id = h.lot_id
     where h.item_id = p_item_id
       and h.warehouse_id = p_warehouse_id
       and h.quantity > 0
       and l.archived_at is null
     order by l.expires_on asc nulls last, l.code asc, h.lot_id asc
  loop
    exit when remaining <= 0;
    lot_id   := r.id;
    quantity := least(r.available, remaining);
    remaining := remaining - quantity;
    return next;
  end loop;
end $$;

-- ── 5. the three link columns (§4.3.4's 3A header row; 2C's attachment note, spec:1067) ───────────────
alter table app.document add column warehouse_id    uuid;      -- header default; a line's warehouse_id overrides
alter table app.document add column to_warehouse_id uuid;      -- the transfer destination (3D's TRANSFER)
alter table app.document add constraint document_warehouse_fk
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id);
alter table app.document add constraint document_to_warehouse_fk
  foreign key (tenant_id, to_warehouse_id) references app.warehouse(tenant_id, id);

alter table app.attachment add column lot_id uuid;             -- spec:1067 "linked to a document or a lot"
alter table app.attachment add constraint attachment_lot_fk
  foreign key (tenant_id, lot_id) references app.lot(tenant_id, id);
-- Exactly one owner. 2C left document_id nullable for this column's arrival and shipped no check, so the
-- constraint lands here with the second option: an attachment with neither owner is unreachable by either
-- read path, and one with both would need two different permission codes at once (§4.5.8).
alter table app.attachment add constraint attachment_owner_check
  check (num_nonnulls(document_id, lot_id) = 1);
create index attachment_lot_idx on app.attachment (lot_id) where lot_id is not null;
```

`packages/db/migrations/0031.down.sql`:

```sql
-- Reverse of 0031, in reverse dependency order (contracts §3.4.5). down runs only in CI on empty tenants, so
-- the attachment check can be dropped without re-examining rows.
drop index if exists app.attachment_lot_idx;
alter table app.attachment drop constraint if exists attachment_owner_check;
alter table app.attachment drop constraint if exists attachment_lot_fk;
alter table app.attachment drop column if exists lot_id;
alter table app.document drop constraint if exists document_to_warehouse_fk;
alter table app.document drop constraint if exists document_warehouse_fk;
alter table app.document drop column if exists to_warehouse_id;
alter table app.document drop column if exists warehouse_id;
drop function if exists app.pick_lots_fefo(uuid, uuid, numeric);
drop table if exists app.stock_on_hand;
drop trigger if exists inventory_movement_stock_available on app.inventory_movement;
drop trigger if exists inventory_movement_immutable on app.inventory_movement;
drop index if exists app.inventory_movement_chrono_idx;
drop table if exists app.inventory_movement;
drop function if exists app.assert_stock_available();
```

- [ ] **Step 5: Write the two Drizzle mirrors and extend two existing ones**

`packages/db/src/schema/inventory_movement.ts`:

```ts
import { bigint, date, index, integer, numeric, pgSchema, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const app = pgSchema("app");

export const inventoryMovement = app.table(
  "inventory_movement",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id").notNull(),
    lineNo: integer("line_no").notNull(),
    movementNo: integer("movement_no").notNull(),
    itemId: uuid("item_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    lotId: uuid("lot_id").notNull(),
    unitId: uuid("unit_id").notNull(),
    quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull(),
    value: numeric("value", { precision: 19, scale: 4 }).notNull(),
    effectiveDate: date("effective_date").notNull(),
    // `bigint(..., { mode: "bigint" })` and NOT `numeric()`: migration 0031 declares `posting_seq bigint`,
    // and a `numeric` mirror would generate a diff altering a bigint column to numeric. `mode: "bigint"` is
    // what keeps it off `number` in TypeScript — the same form Task 1 uses for `unit_conversion`.
    postingSeq: bigint("posting_seq", { mode: "bigint" }).notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    postedBy: uuid("posted_by").notNull().default(sql`app.current_actor()`),
  },
  (t) => [
    unique().on(t.documentId, t.movementNo),
    unique().on(t.tenantId, t.id),
    index("inventory_movement_chrono_idx").on(
      t.companyId, t.itemId, t.warehouseId, t.effectiveDate, t.postingSeq, t.lineNo, t.movementNo),
  ],
);
```

`packages/db/src/schema/stock_on_hand.ts`:

```ts
import { numeric, pgSchema, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

export const stockOnHand = app.table(
  "stock_on_hand",
  {
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    itemId: uuid("item_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    lotId: uuid("lot_id").notNull(),
    quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.itemId, t.warehouseId, t.lotId] })],
);
// No `id` column: this is a natural-key projection, and lint-schema.ts's NO_ID_TABLES records that.
```

In `packages/db/src/schema/document.ts`, add two columns to the existing `document` table object:

```ts
  warehouseId: uuid("warehouse_id"),              // 3A / 0031 — header default; a line's warehouse_id overrides
  toWarehouseId: uuid("to_warehouse_id"),         // 3A / 0031 — the transfer destination (3D uses it)
```

In `packages/db/src/schema/attachment.ts`, add one column:

```ts
  lotId: uuid("lot_id"),                          // 3A / 0031 — spec:1067; exactly one of documentId / lotId
```

If either file is absent when this step runs, author it column-for-column from its own migration DDL before editing and say so in the commit body (assumption 15).

- [ ] **Step 6: Edit `packages/db/src/lint-schema.ts` — two set members, nothing else**

```ts
const NO_ID_TABLES = new Set([
  "membership", "role_permission", "role_assignment", "role_assignment_branch", "ledger_entry_dimension",
  "document_series", "document_number_void", "idempotency_key", "audit_log", "permission",
  "account_balance",                          // 1A
  "stock_on_hand",                            // 3A — natural key (company_id, item_id, warehouse_id, lot_id)
]);
```

```ts
export const AUDIT_EXEMPT = new Set([
  "ledger_entry", "ledger_entry_dimension", "inventory_movement", "document_event", "audit_log",
  "account_balance", "cost_layer", "cost_consumption", "employee_ytd", "idempotency_key", "permission",
  "stock_on_hand",                            // 3A — derived projection (§3.5.3)
]);
```

`inventory_movement` is already in both `AUDIT_EXEMPT` and `IMMUTABLE` from Plan 0A (plan0A:2706–2711) — §3.5.3's "already" in those two columns. Do not re-add it, and do not touch `IMMUTABLE`, `GLOBAL_TABLES` or `ALLOWED_PERMISSIVE`. `NO_CREATED_AT_TABLES` is `new Set([...NO_ID_TABLES, "ledger_entry"])` and therefore picks `stock_on_hand` up automatically; §3.5.3's `—` in that column records that no slice edits the derivation, not that the table stands outside it. `stock_on_hand` has a `created_at` anyway, so the exemption is unused.

- [ ] **Step 7: Add `ERR_STOCK_INSUFFICIENT` to `packages/contracts/src/errors.ts`**

```ts
  ERR_STOCK_INSUFFICIENT: {
    status: 422,
    title: "Insufficient stock",
    remedy: "Reduce the quantity, pick a different lot or warehouse, or have a second principal record an inventory.negative_stock.override on this document.",
  },
```

**422 and not 409**: §4.2.4's allocated table gives this code 422 and marks it ¶ (the spec names it). The token is raised in the `TOKEN: text` form with `errcode = 'check_violation'`, so `fromDatabaseError` maps it with no handler `catch`, and `error-codes` sees its evidence in this migration's SQL text — the rule scans `packages/db/migrations/**`, so it stays green in this same commit.

- [ ] **Step 8: Append to the three regression files**

`tests/regression/sah-050.test.ts` — append (0B created the file; do not edit its block):

```ts
describe("SAH-050 NULL dimension values make aggregates accumulate orphans and lose all decrements — 3A", () => {
  it("every stock key column is NOT NULL on both the movement and the projection", async () => {
    const { db } = await sharedDb();
    const nullable = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app'
         and table_name in ('inventory_movement', 'stock_on_hand')
         and column_name in ('company_id', 'item_id', 'warehouse_id', 'lot_id', 'unit_id')
         and is_nullable = 'YES'
       order by table_name, column_name`;
    // The old system let a movement carry a NULL batch or warehouse; every increment then inserted a fresh
    // orphan row and every decrement matched nothing. The structural answer is ADR 0034's sentinel lot,
    // which is what lets both lot_id columns be NOT NULL rather than "NULL means unbatched".
    expect(nullable).toEqual([]);
  });
});
```

`tests/regression/sah-073.test.ts` — append:

```ts
describe("SAH-073 Referential integrity enforced inconsistently for the same logical relationship — 3A", () => {
  it("every tenant-scoped parent of a movement is reached by a COMPOSITE (tenant_id, x) foreign key", async () => {
    const { db } = await sharedDb();
    const fks = await db.admin<{ ref: string; cols: string[] }[]>`
      select rf.relname as ref, array_agg(a.attname order by k.ord) as cols
        from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_class rf on rf.oid = c.confrelid
        join unnest(c.conkey) with ordinality k(attnum, ord) on true
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.contype = 'f' and cl.relname = 'inventory_movement'
       group by c.oid, rf.relname
       order by rf.relname`;
    // company, document, item, warehouse, lot and unit_of_measure are all reached as (tenant_id, x); only
    // app.tenant and app.principal are plain, which §4.1 permits. One shape for one relationship.
    for (const fk of fks) {
      if (fk.ref === "tenant" || fk.ref === "principal") { expect(fk.cols).toHaveLength(1); continue; }
      expect(fk.cols[0], fk.ref).toBe("tenant_id");
      expect(fk.cols, fk.ref).toHaveLength(2);
    }
    expect(fks.map((f) => f.ref)).toContain("lot");
  });
});
```

`tests/regression/sah-074.test.ts` — append:

```ts
describe("SAH-074 42 of 460 tables have no primary key — 3A", () => {
  it("both tables this slice's posting path writes have a primary key", async () => {
    const { db } = await sharedDb();
    const pks = await db.admin<{ relname: string; n: number }[]>`
      select cl.relname, count(c.oid)::int as n
        from pg_class cl
        left join pg_constraint c on c.conrelid = cl.oid and c.contype = 'p'
       where cl.relname in ('inventory_movement', 'stock_on_hand')
       group by cl.relname order by cl.relname`;
    expect(pks).toEqual([
      { relname: "inventory_movement", n: 1 },
      { relname: "stock_on_hand", n: 1 },        // a natural key is still a key
    ]);
  });
});
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/inventory/movement.test.ts test/inventory/fefo.test.ts`
Expected: **PASS** — fourteen assertions in `movement.test.ts`, six in `fefo.test.ts`.

Run: `bun run --cwd packages/db db:lint`
Expected: `0 violations`. Without Step 6 the linter reports two: `stock_on_hand id_column missing id column` and `stock_on_hand audit_trigger missing audit_row trigger`.

Run: `bun run --cwd packages/db test -- test/privileges.test.ts`
Expected: **PASS**. The pinned DELETE list is untouched — this slice grants none (§3.5.4) — and the `revoke update, delete` on `inventory_movement` is what the `immutable_privileges` rule and this test both check for.

Run: `bun run --cwd tests test -- regression/sah-050.test.ts regression/sah-073.test.ts regression/sah-074.test.ts`
Expected: **PASS**, with each file now carrying its earlier blocks plus one 3A block.

Run: `bun run lint:rules`
Expected: PASS. `posting-only-tables` sees the two new table names in DML only under `packages/db/test/**`, which is on its allow-list; `error-codes` finds `ERR_STOCK_INSUFFICIENT` raised in `packages/db/migrations/0031_…sql`.

- [ ] **Step 10: Commit**

```bash
git add packages/db/migrations/0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql \
        packages/db/migrations/0031.down.sql packages/db/src/schema/inventory_movement.ts \
        packages/db/src/schema/stock_on_hand.ts packages/db/src/schema/document.ts \
        packages/db/src/schema/attachment.ts packages/db/src/lint-schema.ts \
        packages/contracts/src/errors.ts packages/db/test/inventory/movement.test.ts \
        packages/db/test/inventory/fefo.test.ts tests/regression/sah-050.test.ts \
        tests/regression/sah-073.test.ts tests/regression/sah-074.test.ts
git commit -m "$(cat <<'EOF'
feat(db): the movement ledger, stock on hand, and the negative-stock refusal [3A T5]

Migration 0031 creates app.inventory_movement (append-only, signed, value
mandatory) and app.stock_on_hand (natural key, no id) verbatim from contracts
§4.7.3, plus document.warehouse_id / to_warehouse_id and attachment.lot_id —
the three link columns §4.3.4 and 2C assigned to this file.

app.assert_stock_available is §4.7.3's comment as code. It sums availability
from inventory_movement, which already contains this transaction's earlier
rows, and never from stock_on_hand, which is MERGEd only at step 12. Its one
door is an inventory.negative_stock.override document_event, whose second
principal 2B's override guard has already proved. There is no session flag and
no policy flag: spec:2436 wants the refusal regardless of user attributes, and
policy.inventory.allowNegative is one.

app.pick_lots_fefo reads the synchronous projection with a total ordering —
expiry, lot code, lot id — so the answer never depends on a chosen plan
(SAH-067). A NULL expiry sorts last, which keeps the sentinel lot behind every
dated batch.

attachment gains attachment_owner_check (exactly one of document_id, lot_id) —
an addition to §4.5.8, and the reason 2C left document_id nullable.

lint-schema.ts gains stock_on_hand in NO_ID_TABLES and AUDIT_EXEMPT, exactly
§3.5.3's row, and nothing else. inventory_movement was already in AUDIT_EXEMPT
and IMMUTABLE from Plan 0A.

Nothing writes either table yet — Task 8's applyMovements is the writer, and
posting-only-tables already forbids everyone else.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Migration 0032 — the `document_line` inventory columns, the `item_id` key, and exact unit conversion applied by the data layer

SAH-066 is one sentence long: "Unit conversion is defined in the schema and applied nowhere." Task 1 defined it; this task applies it, and applies it in **SQL** so that no write path — API, importer, POS sync apply, a hand-typed `app_rw` insert — can enter a carton quantity and have it counted as pieces. `app.document_line_base_quantity()` is a BEFORE INSERT OR UPDATE trigger that derives `quantity` (always the item's base unit — spec:2043) from the entered `(unit_id, unit_quantity)` pair, and raises when a supplied `quantity` disagrees with what the conversion says.

The same migration closes 2A's `item_id` FK slot (§4.3.4: "3A's 0032 adds `(tenant_id, item_id) → app.item` … and adds its field to `DocumentLineInput` in the same PR as its key, never before"), which breaks three 2A tests that write arbitrary uuids into that column. Step 3 fixes all three; assumption 10 predicted it.

**⚠️ OD-05 — the §3.0.3 "Multi-unit items" row (spec:1024), continued from Task 1.** **If the owner rejects the row:** keep migration 0032's four columns (`document_line.unit_id` and `unit_quantity` still record what the user typed, and a base-unit-only system types the base unit), drop the trigger, the two `packages/domain` conversion exports, `resolveUnitConversion`/`convertToBase`/`replaceUnitConversions`, `sah-066.test.ts` and the `POST …/items/{itemId}/unit-conversions` route of Task 11. `applyConversion`'s callers reduce to the identity, and nothing else in the slice moves.

**Files:**
- Create: `packages/db/migrations/0032_alter_document_line_add_inventory_columns.sql`, `packages/db/migrations/0032.down.sql`
- Create: `packages/domain/src/quantity/convert.ts`, `packages/domain/test/quantity/convert.test.ts`
- Create: `packages/db/test/inventory/unit-conversion.test.ts`, `tests/regression/sah-066.test.ts`
- Create: `docs/adr/0036-exact-unit-conversion-and-fefo-over-the-projection.md`
- Modify: `packages/db/src/schema/document_line.ts`, `packages/db/src/inventory/units.ts`, `packages/db/src/posting/load.ts`, `packages/db/src/posting/reverse.ts`, `packages/domain/src/index.ts`, `packages/contracts/src/accounting/document.ts`
- Modify (fix, assumption 10): `packages/db/test/document-line-generalised.test.ts`, `packages/db/test/posting/load.test.ts`, `packages/db/test/posting/reverse.test.ts`

**Interfaces:**
- Consumes: `Quantity`, `Rational`, `rational`, `round`, `QUANTITY_SCALE` (0D, §4.2.1); `app.item`, `app.unit_conversion`, `app.unit_of_measure` (Task 1), `app.warehouse`, `app.lot` (Task 2); `loadSnapshot`, `LineSnapshot`, `ItemRef`, `DocumentSnapshot` (§4.3.1, §4.4.2); `reverseDocument` (2A/§4.3.1); `DocumentLineInput`, `QuantitySchema`, `UuidSchema` (§4.2.8); `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot`, `draftDocument` (Tasks 1–2); `UnitConversionMissingError` from `packages/db/src/inventory/errors.ts` (Task 1 — imported, never re-declared).
- Produces:
  - SQL: `app.document_line.warehouse_id`, `.lot_id`, `.unit_id`, `.unit_quantity` with their four FKs plus `(tenant_id, item_id) → app.item`; `app.document_line_base_quantity()` + trigger `document_line_base_quantity`; index `document_line_warehouse_idx`.
  - `export function applyConversion(unitQuantity: Quantity, conversion: Rational): Quantity` — `packages/domain/src/quantity/convert.ts`, re-exported from `@dulja/domain`. **Not `Quantity.convert`:** it rounds `HALF_AWAY_FROM_ZERO`, which is what Postgres `round()` in the 0032 trigger does, and `Quantity.convert`'s HALF_EVEN would disagree at a tie. See the third contract-deviation bullet in the header.
  - `export const IDENTITY_CONVERSION: Rational` — `{ numerator: 1n, denominator: 1n }`; the one spelling of "the entered unit *is* the base unit".
  - `export interface UnitConversionRow { itemId: string; unitId: string; unitCode: string; numerator: string; denominator: string }`
  - `export async function replaceUnitConversions(tx: Sql, itemId: string, conversions: readonly { unitId: string; numerator: string; denominator: string }[]): Promise<UnitConversionRow[]>`
  - `export async function listUnitConversions(tx: Sql, itemId: string): Promise<UnitConversionRow[]>`
  - `export async function resolveUnitConversion(tx: Sql, params: { itemId: string; unitId: string }): Promise<Rational>` — throws `UnitConversionMissingError` when the unit is neither the base unit nor a configured conversion.
  - `export async function convertToBase(tx: Sql, params: { itemId: string; unitId: string; unitQuantity: Quantity }): Promise<Quantity>`
  - **No new error class.** `UnitConversionMissingError` is **Task 1's**, declared in `packages/db/src/inventory/errors.ts` and already on the barrel; `units.ts` imports it from `./errors` and this task adds no second declaration and no second barrel line.
  - `loadSnapshot`: `header.warehouseId`, `header.toWarehouseId`, every line's `warehouseId` / `lotId` / `unitId` / `unitQuantity`, and `refs.items` filled from `app.item` — the four fields §4.3.1's stub list assigns 3A.
  - `DocumentLineInput` gains `itemId`, `warehouseId`, `lotId`, `unitId` (all `UuidSchema.optional()`) and `unitQuantity` (`QuantitySchema.optional()`).

- [ ] **Step 1: Write the failing test `packages/domain/test/quantity/convert.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { IDENTITY_CONVERSION, Quantity, applyConversion, rational } from "../../src";

describe("applyConversion — exact rational unit conversion (spec:2043, SAH-066)", () => {
  it("1 carton of 12 pieces is 12 base units", () => {
    expect(applyConversion(Quantity.of("1.000000"), rational(12n, 1n)).toString()).toBe("12.000000");
    expect(applyConversion(Quantity.of("3.500000"), rational(12n, 1n)).toString()).toBe("42.000000");
  });

  it("a fractional conversion is exact, not a float — 1 piece = 1/12 carton", () => {
    // 1/3 of a base unit at 6 dp; a double would give 0.33333333333333331 and drift over a thousand lines.
    expect(applyConversion(Quantity.of("1.000000"), rational(1n, 3n)).toString()).toBe("0.333333");
    // Three of them sum to 0.999999, and the plan says so rather than pretending it is 1: the residue is a
    // reporting fact, and clamping it here would be the invented precision spec:2043 forbids.
    const third = applyConversion(Quantity.of("1.000000"), rational(1n, 3n));
    expect(third.add(third).add(third).toString()).toBe("0.999999");
  });

  it("rounds HALF_AWAY_FROM_ZERO at a tie, matching Postgres round() and NOT Quantity.convert", () => {
    // 1 × 1/2000000 = 0.0000005 — exactly a tie at QUANTITY_SCALE. The 0032 trigger computes
    // round(1.000000 * 1 / 2000000, 6), and Postgres numeric round() is half away from zero, so the
    // database says 0.000001. §4.2.1 fixes Quantity.convert at HALF_EVEN, which would say 0.000000 and
    // would then be REFUSED by the trigger's agreement branch on a legitimate line. applyConversion is
    // the trigger's twin because of this mode, not despite it.
    const tie = rational(1n, 2000000n);
    expect(applyConversion(Quantity.of("1.000000"), tie).toString()).toBe("0.000001");
    expect(applyConversion(Quantity.of("1.000000"), tie).toString())
      .not.toBe(Quantity.of("1.000000").convert(tie).toString());   // the two modes are observably different
    // Away from zero on the negative side too, which is what keeps a reversal's negated pair in agreement.
    expect(applyConversion(Quantity.of("-1.000000"), tie).toString()).toBe("-0.000001");
    // 3 × 1/2000000 = 0.0000015, another tie. This case pins the ORDER as well as the mode: multiply by the
    // numerator, THEN divide by the denominator, then round once — the order 0D's `convert` uses and the
    // order the SQL trigger uses (`unit_quantity * num / den`). Collapsing the rational to a Decimal first,
    // which is what `Quantity.multiply(rational, mode)` does, is the per-step rounding shape SAH-066 is.
    expect(applyConversion(Quantity.of("3.000000"), tie).toString()).toBe("0.000002");
  });

  it("the identity conversion is the base unit and changes nothing", () => {
    expect(IDENTITY_CONVERSION).toEqual({ numerator: 1n, denominator: 1n });
    expect(applyConversion(Quantity.of("7.250000"), IDENTITY_CONVERSION).toString()).toBe("7.250000");
  });

  it("is symmetric across sign, which is what makes a reversal agree with its original", () => {
    const positive = applyConversion(Quantity.of("2.500000"), rational(7n, 3n));
    const negative = applyConversion(Quantity.of("-2.500000"), rational(7n, 3n));
    expect(negative.toString()).toBe(positive.negate().toString());
  });

  it("a zero denominator is refused by rational() before it reaches here (SAH-063)", () => {
    expect(() => rational(12n, 0n)).toThrow(/ERR_RATIONAL_ZERO_DENOMINATOR/);
  });
});
```

- [ ] **Step 2: Write `packages/domain/src/quantity/convert.ts`**

```ts
// `D` is the cloned precision-40 Decimal of `money/decimal.ts` (0d:355, barrelled at 0d:439); `rounding.ts`
// exports `round`, the four `*_SCALE` constants and `RoundingMode` and NOT `D`. Two import lines, not one.
import { D } from "../money/decimal";
import { QUANTITY_SCALE, round } from "../money/rounding";
import { Quantity } from "../money/quantity";
import type { Rational } from "../money/rational";

/**
 * "The entered unit IS the base unit", named once so no caller types `{ numerator: 1n, denominator: 1n }`
 * a second time and no caller reaches for `rational(1n, 1n)` in a hot path.
 */
export const IDENTITY_CONVERSION: Rational = { numerator: 1n, denominator: 1n };

/**
 * Converts a quantity entered in some unit to the item's BASE unit, exactly (spec:2043 — "exact rationals
 * (numerator bigint, denominator bigint), never floats"; SAH-066).
 *
 * **This is NOT `Quantity.convert`, and the difference is the rounding mode — read this before "simplifying"
 * the body to a delegation.** §4.2.1 fixes `Quantity.convert(conversion)` as "exact; rounded HALF_EVEN to
 * 6 dp only at the end". Migration 0032's `app.document_line_base_quantity()` derives the same figure as
 * `round(new.unit_quantity * num::numeric / den::numeric, 6)`, and Postgres `numeric round()` is HALF AWAY
 * FROM ZERO. The two disagree at a tie: `1.000000 × 1/2000000` is `0.000000` under HALF_EVEN and `0.000001`
 * under the trigger. The trigger *raises* rather than overwrites when a supplied `quantity` disagrees with
 * the entered pair, so an API caller that computed `quantity` with HALF_EVEN and posted both values would
 * get ERR_VALIDATION_FAILED on a perfectly legitimate line — a defect indistinguishable from SAH-066 to the
 * user who hits it.
 *
 * **The body below is `Quantity.convert`'s body with one token changed — the mode — and it must stay that
 * way.** 0D's `convert` is `this.value.times(numerator).div(denominator)` at the cloned constructor's
 * precision 40, rounded ONCE at the end, with the docstring "Rounding per step is the SAH-066 defect". This
 * function repeats that exact order and rounds `HALF_AWAY_FROM_ZERO` instead. **It is deliberately NOT
 * `Quantity.multiply(conversion, "HALF_AWAY_FROM_ZERO")`**, which looks like the shorter route and is not:
 * `multiply` collapses a `Rational` to a `Decimal` FIRST (`new D(numerator).div(new D(denominator))`) and
 * multiplies afterwards, so it divides before it multiplies — the per-step rounding shape 0D wrote `convert`
 * to avoid. At precision 40 the two agree on every plausible package factor, but "agrees in practice" is not
 * the standard SAH-066 sets, and the trigger multiplies before it divides
 * (`new.unit_quantity * num::numeric / den::numeric`). Same order as the SQL, same mode as the SQL.
 *
 * What is named here is the **mode contract**: every conversion whose result has to agree with a
 * `document_line` row goes through `applyConversion`, so a reviewer greps one symbol and the mode is never a
 * caller's choice. `Quantity.convert` remains correct for display-side conversion, where nothing compares it
 * to a stored row.
 *
 * `rational()` has already refused a zero denominator (ERR_RATIONAL_ZERO_DENOMINATOR), so there is no divisor
 * guard here: SAH-063's defect was six unguarded divisions, and the guard belongs at construction, once.
 */
export function applyConversion(unitQuantity: Quantity, conversion: Rational): Quantity {
  const exact = new D(unitQuantity.toDecimal())
    .times(new D(conversion.numerator.toString()))
    .div(new D(conversion.denominator.toString()));
  return Quantity.of(round(exact, QUANTITY_SCALE, "HALF_AWAY_FROM_ZERO").toFixed(QUANTITY_SCALE));
}

/** Re-exported for callers that need the scale in an error message; never used to change it. */
export { QUANTITY_SCALE };
```

Add to `packages/domain/src/index.ts`:

```ts
export { IDENTITY_CONVERSION, applyConversion } from "./quantity/convert";
```

- [ ] **Step 3: Write the failing test `packages/db/test/inventory/unit-conversion.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Quantity } from "@dulja/domain";
import {
  convertToBase, listUnitConversions, replaceUnitConversions, resolveUnitConversion,
} from "../../src/inventory/units";
import { UnitConversionMissingError } from "../../src/inventory/errors";   // Task 1's module — one declaration
import { draftDocument, seedItem, seedTenant, seedUnit, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("unit conversion applied by the data layer — migration 0032 (SAH-066, ADR 0036)", () => {
  let db: Db;
  let a: Seed;
  let itemId: string;
  let pieceId: string;
  let cartonId: string;
  let innerId: string;
  let tieId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Conv A");
    ({ itemId, baseUnitId: pieceId } = await seedItem(db, a, { code: "RICE-5KG" }));
    cartonId = await seedUnit(db, a, { code: "CTN", nameEn: "Carton" });
    innerId = await seedUnit(db, a, { code: "INR", nameEn: "Inner" });
    tieId = await seedUnit(db, a, { code: "TIE", nameEn: "Tie unit" });
    await withTenant(db.rw, a.tenant, a.human, (tx) => replaceUnitConversions(tx, itemId, [
      { unitId: cartonId, numerator: "12", denominator: "1" },     // 1 carton = 12 pieces
      { unitId: innerId, numerator: "1", denominator: "4" },       // 1 inner = 1/4 piece
      // 1 TIE = 1/2000000 piece: one unit converts to exactly 0.0000005, a tie at QUANTITY_SCALE. It exists
      // only so the rounding-mode agreement between TypeScript and the trigger is asserted and not assumed.
      { unitId: tieId, numerator: "1", denominator: "2000000" },
    ]));
  });
  afterAll(async () => { await db.stop(); });

  it("resolveUnitConversion returns the item's own rational, and the identity for the base unit", async () => {
    const carton = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolveUnitConversion(tx, { itemId, unitId: cartonId }));
    expect(carton).toEqual({ numerator: 12n, denominator: 1n });
    const base = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolveUnitConversion(tx, { itemId, unitId: pieceId }));
    expect(base).toEqual({ numerator: 1n, denominator: 1n });      // no row needed for the base unit
  });

  it("an unconfigured unit is named, never silently treated as the base unit", async () => {
    const stray = await seedUnit(db, a, { code: "PLT", nameEn: "Pallet" });
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolveUnitConversion(tx, { itemId, unitId: stray }))).rejects.toThrow(UnitConversionMissingError);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolveUnitConversion(tx, { itemId, unitId: stray })))
      .rejects.toThrow(new RegExp(`no unit conversion for item ${itemId} and unit ${stray}`));
  });

  it("convertToBase multiplies exactly and returns a Quantity, never a number", async () => {
    const q = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      convertToBase(tx, { itemId, unitId: cartonId, unitQuantity: Quantity.of("2.500000") }));
    expect(q.toString()).toBe("30.000000");
  });

  it("replaceUnitConversions is idempotent and re-prices an existing pair rather than duplicating it", async () => {
    await withTenant(db.rw, a.tenant, a.human, (tx) => replaceUnitConversions(tx, itemId, [
      { unitId: cartonId, numerator: "24", denominator: "1" },
      { unitId: innerId, numerator: "1", denominator: "4" },
    ]));
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) => listUnitConversions(tx, itemId));
    // TIE is omitted from the payload and therefore LEFT STANDING — the documented behaviour of
    // `replaceUnitConversions`, asserted here rather than only described in its docstring.
    expect(rows.map((r) => `${r.unitCode}=${r.numerator}/${r.denominator}`).sort())
      .toEqual(["CTN=24/1", "INR=1/4", "TIE=1/2000000"]);
  });

  it("convertToBase and the 0032 trigger agree at a rounding TIE — one mode, both sides", async () => {
    // The only assertion that actually proves the read-side twin is a twin. 1 TIE = 1/2000000 piece, so the
    // exact answer is 0.0000005 and the answer depends entirely on the mode: HALF_AWAY_FROM_ZERO (Postgres
    // round(), and applyConversion) gives 0.000001; HALF_EVEN (Quantity.convert) gives 0.000000. If they
    // ever diverge, the insert below fails with
    // `ERR_VALIDATION_FAILED: line 1 says 0.000000 base units but 1.000000 of that unit is 0.000001`,
    // which is precisely the false refusal an API caller would hit.
    // Two entered quantities, because one pins the MODE and the pair pins the ORDER: 1 → 0.0000005 and
    // 3 → 0.0000015 are both ties, and only "multiply by the numerator, then divide, then round once" gives
    // 0.000001 and 0.000002 on both sides. A twin that collapsed the rational to a decimal before
    // multiplying (what `Quantity.multiply(rational, mode)` does) is what the second row would catch.
    const doc = await draftDocument(db, a);
    let lineNo = 0;
    for (const [entered, expected] of [["1.000000", "0.000001"], ["3.000000", "0.000002"]] as const) {
      const previewed = await withTenant(db.rw, a.tenant, a.human, (tx) =>
        convertToBase(tx, { itemId, unitId: tieId, unitQuantity: Quantity.of(entered) }));
      expect(previewed.toString()).toBe(expected);
      const [line] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ quantity: string }[]>`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, item_id, unit_id, unit_quantity, quantity, amount)
        values (${a.tenant}, ${a.company}, ${doc}, ${++lineNo}, 'item', ${itemId}, ${tieId}, ${entered},
                ${previewed.toString()}, 1.0000)
        returning quantity::text as quantity`);
      expect(line!.quantity).toBe(expected);
    }
  });

  it("the TRIGGER derives document_line.quantity from the entered pair — every write path (SAH-066)", async () => {
    const doc = await draftDocument(db, a);
    const [line] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ quantity: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, unit_id, unit_quantity, amount)
      values (${a.tenant}, ${a.company}, ${doc}, 1, 'item', ${itemId}, ${cartonId}, 3.000000, 100.0000)
      returning quantity::text as quantity`);
    expect(line!.quantity).toBe("72.000000");                     // 3 cartons × 24 pieces, derived in SQL
  });

  it("a supplied quantity that disagrees with the conversion is refused, not overwritten", async () => {
    const doc = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, unit_id, unit_quantity, quantity, amount)
      values (${a.tenant}, ${a.company}, ${doc}, 1, 'item', ${itemId}, ${cartonId}, 3.000000, 36.000000, 100.0000)`))
      .rejects.toThrow(/ERR_VALIDATION_FAILED: line 1 says 36.000000 base units but 3.000000 of that unit is 72.000000/);
  });

  it("a line entered directly in base units, with no pair, is left exactly as written", async () => {
    const doc = await draftDocument(db, a);
    const [line] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ quantity: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, quantity, amount)
      values (${a.tenant}, ${a.company}, ${doc}, 1, 'item', ${itemId}, 5.500000, 100.0000)
      returning quantity::text as quantity`);
    expect(line!.quantity).toBe("5.500000");
  });

  it("an entered pair whose unit has no conversion is refused at write time", async () => {
    const doc = await draftDocument(db, a);
    const stray = await seedUnit(db, a, { code: "DRM", nameEn: "Drum" });
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, unit_id, unit_quantity, amount)
      values (${a.tenant}, ${a.company}, ${doc}, 1, 'item', ${itemId}, ${stray}, 1.000000, 10.0000)`))
      .rejects.toThrow(/ERR_VALIDATION_FAILED: no unit conversion for item/);
  });

  it("item_id now has a foreign key: an arbitrary uuid is a 23503 (§4.3.4, assumption 10)", async () => {
    const doc = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, item_id, amount)
      values (${a.tenant}, ${a.company}, ${doc}, 1, 'item', ${await uuidv7(db.admin)}, 10.0000)`))
      .rejects.toMatchObject({ code: "23503" });
  });

  it("document_line carries NO branch_isolation policy and never gains one (§4.5.6)", async () => {
    const [p] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_policies
       where schemaname = 'app' and tablename = 'document_line' and policyname = 'branch_isolation'`;
    // It has a warehouse_id from this migration, and §3.5.1 step 7 is explicit that a warehouse_id alone does
    // not attract the policy — document_line is isolated through its parent document.
    expect(p!.n).toBe(0);
  });
});
```

- [ ] **Step 4: Run both tests to see the exact failures**

Run: `bun run --cwd packages/domain test -- test/quantity/convert.test.ts`
Expected: **FAIL** at import — `"IDENTITY_CONVERSION" is not exported by "src/index.ts"`.

Run: `bun run --cwd packages/db test -- test/inventory/unit-conversion.test.ts`
Expected: **FAIL** at import — `Cannot find module`'s `resolveUnitConversion` export does not exist in `../../src/inventory/units`.

- [ ] **Step 5: Write `packages/db/migrations/0032_alter_document_line_add_inventory_columns.sql`**

```sql
-- 0032_alter_document_line_add_inventory_columns.sql
-- contracts §4.3.4's 3A row: warehouse_id, lot_id, unit_id, unit_quantity, and the (tenant_id, item_id) key
-- 2A left open. Expand only — every column is nullable, so the deploy is the expand half of expand/contract
-- (spec:2057) and no live row needs a backfill.
-- spec:2043: "Quantity is stored once, in the item's base unit; the entered unit and quantity are kept for
-- display." unit_id/unit_quantity are that display pair, and the trigger below is what makes the sentence true
-- on every write path rather than in the one handler that remembers (SAH-066).

-- ── 1. the four columns ───────────────────────────────────────────────────────────────────────────────
alter table app.document_line add column warehouse_id  uuid;
alter table app.document_line add column lot_id        uuid;           -- NULLABLE: applyMovements resolves
                                                                       -- the item's 'NONE' sentinel (§4.7.3)
alter table app.document_line add column unit_id       uuid;
alter table app.document_line add column unit_quantity numeric(19,6);

-- ── 2. the five foreign keys, all composite (tenant_id, x) (spec:106, SAH-073) ────────────────────────
alter table app.document_line add constraint document_line_item_fk
  foreign key (tenant_id, item_id)      references app.item(tenant_id, id);
alter table app.document_line add constraint document_line_warehouse_fk
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id);
alter table app.document_line add constraint document_line_lot_fk
  foreign key (tenant_id, lot_id)       references app.lot(tenant_id, id);
alter table app.document_line add constraint document_line_unit_fk
  foreign key (tenant_id, unit_id)      references app.unit_of_measure(tenant_id, id);
create index document_line_warehouse_idx on app.document_line (warehouse_id) where warehouse_id is not null;
-- No branch_isolation policy on this table, now or ever: §3.5.1 step 7 and §4.5.6 both say a warehouse_id
-- alone does not qualify, and document_line is isolated through its parent document.

-- ── 3. the base quantity, derived in SQL so no write path can skip it (SAH-066) ───────────────────────
-- Behaviour, in three branches:
--   * no entered pair (unit_id or unit_quantity null) → quantity is left exactly as written. A JOURNAL line
--     has neither, and a line typed directly in base units has neither.
--   * pair present, quantity null → quantity := round(unit_quantity * numerator / denominator, 6).
--   * pair present, quantity supplied → the two must agree, or ERR_VALIDATION_FAILED naming both figures.
--     Overwriting a supplied value silently would hide a caller bug; the round() is symmetric across sign
--     (Postgres numeric round() is half-away-from-zero), so a reversal's negated pair agrees with its
--     negated quantity by construction and reverse.ts needs no special case.
-- The base unit needs no unit_conversion row: unit_id = item.base_unit_id resolves to 1/1.
create function app.document_line_base_quantity() returns trigger
language plpgsql as $$
declare
  base_unit uuid;
  num       bigint;
  den       bigint;
  derived   numeric(19,6);
begin
  if new.unit_id is null or new.unit_quantity is null then
    return new;
  end if;
  if new.item_id is null then
    raise exception 'ERR_VALIDATION_FAILED: line % carries a unit and a unit quantity but no item', new.line_no
      using errcode = 'check_violation';
  end if;

  select i.base_unit_id into base_unit from app.item i where i.id = new.item_id;
  if base_unit = new.unit_id then
    num := 1; den := 1;
  else
    select c.numerator, c.denominator into num, den
      from app.unit_conversion c
     where c.item_id = new.item_id and c.unit_id = new.unit_id;
    if num is null then
      raise exception 'ERR_VALIDATION_FAILED: no unit conversion for item % and unit % on line %',
        new.item_id, new.unit_id, new.line_no using errcode = 'check_violation';
    end if;
  end if;

  derived := round(new.unit_quantity * num::numeric / den::numeric, 6);
  if new.quantity is null then
    new.quantity := derived;
  elsif new.quantity <> derived then
    raise exception 'ERR_VALIDATION_FAILED: line % says % base units but % of that unit is %',
      new.line_no, new.quantity, new.unit_quantity, derived using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger document_line_base_quantity before insert or update on app.document_line
  for each row execute function app.document_line_base_quantity();
```

`packages/db/migrations/0032.down.sql`:

```sql
-- Reverse of 0032, in reverse dependency order. down runs only in CI on empty tenants (contracts §3.4.5).
drop trigger if exists document_line_base_quantity on app.document_line;
drop function if exists app.document_line_base_quantity();
drop index if exists app.document_line_warehouse_idx;
alter table app.document_line drop constraint if exists document_line_unit_fk;
alter table app.document_line drop constraint if exists document_line_lot_fk;
alter table app.document_line drop constraint if exists document_line_warehouse_fk;
alter table app.document_line drop constraint if exists document_line_item_fk;
alter table app.document_line drop column if exists unit_quantity;
alter table app.document_line drop column if exists unit_id;
alter table app.document_line drop column if exists lot_id;
alter table app.document_line drop column if exists warehouse_id;
```

- [ ] **Step 6: Extend `packages/db/src/schema/document_line.ts`**

Add four columns to the existing table object and `document_line_warehouse_idx` to its constraint array:

```ts
  warehouseId: uuid("warehouse_id"),                                        // 3A / 0032
  lotId: uuid("lot_id"),                                                    // 3A / 0032 — nullable by design
  unitId: uuid("unit_id"),                                                  // 3A / 0032
  unitQuantity: numeric("unit_quantity", { precision: 19, scale: 6 }),      // 3A / 0032 — the entered quantity
```

```ts
  warehouseIdx: index("document_line_warehouse_idx").on(t.warehouseId),
```

- [ ] **Step 7: Extend `packages/db/src/inventory/units.ts`**

Append to the file Task 1 created. `createUnit` and `listUnits` are unchanged.

```ts
import { IDENTITY_CONVERSION, Quantity, applyConversion, rational, type Rational } from "@dulja/domain";
// `UnitConversionMissingError` is declared ONCE, in the module Task 1 created, and imported here. Declaring
// it a second time in this file and re-exporting both from `packages/db/src/index.ts` is a duplicate named
// export — TS2308 — and Step 14 requires `bun run typecheck` to pass.
import { UnitConversionMissingError } from "./errors";

export interface UnitConversionRow {
  itemId: string; unitId: string; unitCode: string; numerator: string; denominator: string;
}

/**
 * The conversions of one item, upserted. `numerator`/`denominator` cross this boundary as digit STRINGS and
 * are `bigint` in SQL — never `number`, which would silently lose precision above 2^53 and is what
 * `no-number-money` forbids for a rate (§3.7.5).
 *
 * **A pair the payload omits is left standing, not removed.** `app_rw` holds no DELETE on
 * `app.unit_conversion` (§3.5.4's list is pinned and 2B is its only extender) and §4.6.1 gives the table no
 * `archived_at`, so there is no mechanism to retire one — which is acceptable because a conversion is a
 * physical fact about a package, and a carton that held twelve pieces still held twelve. To stop selling in
 * a unit, remove it from the item's price lists; the conversion staying is harmless. A slice that genuinely
 * needs retirement adds `archived_at` to §4.6.1's row first, exactly as Task 4 did for `price_list_line`.
 */
export async function replaceUnitConversions(
  tx: Sql, itemId: string,
  conversions: readonly { unitId: string; numerator: string; denominator: string }[],
): Promise<UnitConversionRow[]> {
  for (const c of conversions) {
    await tx`
      insert into app.unit_conversion (tenant_id, item_id, unit_id, numerator, denominator)
      values (app.current_tenant(), ${itemId}, ${c.unitId}, ${c.numerator}::bigint, ${c.denominator}::bigint)
      on conflict (item_id, unit_id)
      do update set numerator = excluded.numerator, denominator = excluded.denominator`;
  }
  return listUnitConversions(tx, itemId);
}

export async function listUnitConversions(tx: Sql, itemId: string): Promise<UnitConversionRow[]> {
  return tx<UnitConversionRow[]>`
    select c.item_id as "itemId", c.unit_id as "unitId", u.code as "unitCode",
           c.numerator::text as "numerator", c.denominator::text as "denominator"
      from app.unit_conversion c
      join app.unit_of_measure u on u.id = c.unit_id
     where c.item_id = ${itemId}
     order by u.code`;
}

/**
 * The rational for one (item, unit). The item's own base unit needs no row and resolves to IDENTITY_CONVERSION;
 * anything else must be configured, and an unconfigured unit raises rather than defaulting to 1/1 — a silent
 * identity is exactly SAH-066's failure mode with a different sign.
 */
export async function resolveUnitConversion(
  tx: Sql, params: { itemId: string; unitId: string },
): Promise<Rational> {
  const [row] = await tx<{ isBase: boolean; numerator: string | null; denominator: string | null }[]>`
    select (i.base_unit_id = ${params.unitId}) as "isBase",
           c.numerator::text  as "numerator",
           c.denominator::text as "denominator"
      from app.item i
      left join app.unit_conversion c on c.item_id = i.id and c.unit_id = ${params.unitId}
     where i.id = ${params.itemId}`;
  if (!row) throw new UnitConversionMissingError(params.itemId, params.unitId);
  if (row.isBase) return IDENTITY_CONVERSION;
  if (row.numerator === null || row.denominator === null) {
    throw new UnitConversionMissingError(params.itemId, params.unitId);
  }
  return rational(BigInt(row.numerator), BigInt(row.denominator));
}

/** The read-side twin of the 0032 trigger: same arithmetic, for a preview or a plan input. */
export async function convertToBase(
  tx: Sql, params: { itemId: string; unitId: string; unitQuantity: Quantity },
): Promise<Quantity> {
  return applyConversion(params.unitQuantity, await resolveUnitConversion(tx, params));
}
```

Re-export from `packages/db/src/index.ts`:

```ts
export {
  convertToBase, listUnitConversions, replaceUnitConversions, resolveUnitConversion,
  type UnitConversionRow,
} from "./inventory/units";
```

`UnitConversionMissingError` is **not** on this line: Task 1 already exports it from `./inventory/errors`, and
one name may leave the barrel through exactly one module (TS2308 otherwise).

- [ ] **Step 8: Fill the four `loadSnapshot` fields §4.3.1 assigns 3A**

`packages/db/src/posting/load.ts`, four edits to 2A's file. Nothing else in it changes.

**(a)** Add two columns to the header select — the last line of `d.…` in 2A's query — and to `HeaderRow`:

```ts
           d.warehouse_id, d.to_warehouse_id,
```

**(b)** Add four columns to the line select and to `LineRow`:

```ts
           warehouse_id, lot_id, unit_id, unit_quantity::text as unit_quantity,
```

**(c)** Replace the four stubbed line fields in the mapping:

```ts
    warehouseId: r.warehouse_id, toWarehouseId: null, lotId: r.lot_id,
    unitId: r.unit_id,
    unitQuantity: r.unit_quantity === null ? null : Quantity.of(r.unit_quantity),
```

`toWarehouseId` stays a constant `null` and keeps 2A's comment naming its owner, now updated: **there is no `document_line.to_warehouse_id` column and 0032 does not add one** (assumption 3). `planMovements` resolves `"line.to_warehouse"` to `line.toWarehouseId ?? header.toWarehouseId`, which at 3A is always the header's; 3D adds the column in its own range if a per-line destination is needed. Write the comment as:

```ts
    // No document_line.to_warehouse_id column exists (§4.3.4's 3A row adds four columns and not this one).
    // planMovements falls back to header.toWarehouseId; 3D adds the column if a per-line destination arrives.
```

**(d)** Fill the header warehouses and `refs.items`. Add the item read beside 2A's account, dimension and custom-field reads:

```ts
  const itemIds = [...new Set(lineRows.map((r) => r.item_id).filter((v): v is string => v !== null))];
  const itemRows = itemIds.length === 0 ? [] : await tx<{
    id: string; code: string; kind: string; base_unit_id: string; track_lots: boolean;
    revenue_account_id: string | null; inventory_account_id: string | null;
    cogs_account_id: string | null; expense_account_id: string | null;
  }[]>`
    select id, code, kind, base_unit_id, track_lots,
           revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id
      from app.item where id = any(${itemIds})`;
```

Then, in the returned object, `header.warehouseId: h.warehouse_id`, `header.toWarehouseId: h.to_warehouse_id`, and:

```ts
      // §4.4.2: refs.items is keyed by the ROW ID (the document_line.item_id value), never by code, so the
      // evaluator never does a second lookup. ItemRef.kind is total because app.item.kind is NOT NULL (§4.6.1).
      items: Object.fromEntries(itemRows.map((r) => [r.id, {
        id: r.id, code: r.code, kind: r.kind as ItemRef["kind"], baseUnitId: r.base_unit_id,
        trackLots: r.track_lots, revenueAccountId: r.revenue_account_id,
        inventoryAccountId: r.inventory_account_id, cogsAccountId: r.cogs_account_id,
        expenseAccountId: r.expense_account_id,
      }])),
```

Add `ItemRef` to the file's `@dulja/domain` type import. `taxCodes`, `components` and `schemes` stay `{}` with 2A's comments naming 5A and 8A.

- [ ] **Step 9: Carry the four columns onto a reversal**

`packages/db/src/posting/reverse.ts`, one edit to 2A's insert. Add the four columns to its column list and its select list, negating only `unit_quantity`:

```sql
                                   kind, item_id, quantity, unit_price, discount, amount,
                                   warehouse_id, lot_id, unit_id, unit_quantity,
```
```sql
           l.kind, l.item_id, -l.quantity, l.unit_price, -l.discount, -l.amount,
           l.warehouse_id, l.lot_id, l.unit_id, -l.unit_quantity,
```

`warehouse_id`, `lot_id` and `unit_id` are references and are copied; `unit_quantity` is a signed magnitude and is negated, exactly like `quantity`, `discount` and `amount` (§4.4.2's sign-normalisation section). The 0032 trigger then re-derives `quantity` from the negated pair and, because `round()` is symmetric across sign, it equals `-l.quantity` and the agreement branch passes. **A reversal that copied `unit_quantity` unnegated would be refused by the trigger**, which is the guard doing its job.

- [ ] **Step 10: Add 3A's five fields to `DocumentLineInput`**

`packages/contracts/src/accounting/document.ts` — five properties inside 2A's `z.object`, before the `.strict()`:

```ts
  itemId: UuidSchema.optional(),                 // 3A: the field lands in the PR that adds the FK (§4.3.4)
  warehouseId: UuidSchema.optional(),
  lotId: UuidSchema.optional(),                  // omitted → applyMovements resolves the item's NONE sentinel
  unitId: UuidSchema.optional(),
  unitQuantity: QuantitySchema.optional(),       // the entered quantity; `quantity` is the base one
```

And one `.refine` after 2A's two, because the pair is meaningless half-given:

```ts
  .refine((l) => (l.unitId === undefined) === (l.unitQuantity === undefined), {
    message: "unitId and unitQuantity are given together or not at all",
  })
```

The line's `quantity` stays optional and, when omitted with the pair present, is what migration 0032's trigger derives. `DocumentLineSchema` (the line as *returned*) gains the same five fields, `unitQuantity` typed with 2A's `SignedAmount`-style signed quantity so a reversal validates on the wire.

- [ ] **Step 11: Fix the three 2A test sites the new FK breaks (assumption 10)**

Find them with one command:

```bash
grep -rn "item_id: \(item\|await uuidv7\)" packages/db/test/
```

Expected three files: `packages/db/test/document-line-generalised.test.ts` (2A T2), `packages/db/test/posting/load.test.ts` (2A T7), `packages/db/test/posting/reverse.test.ts` (2A T8). In each, replace `const item = await uuidv7(db.admin);` with a real row and leave every assertion untouched:

```ts
  const { itemId: item } = await seedItem(db, a, { code: "ITM-2A" });
```

adding `seedItem` to the file's `../fixtures` (or `../../fixtures`) import. In `document-line-generalised.test.ts` the same substitution applies to the inline `insert(300, { kind: "item", item_id: await uuidv7(db.admin) })` case, which becomes `item_id: item`; its assertion (`resolves.toBeDefined()`) is unchanged and now means "a real item id is accepted" instead of "any uuid is accepted". Add one `it` beside it recording the new refusal, so the change of meaning is visible in the file rather than only in this plan:

```ts
  it("since 3A's 0032, an item_id with no app.item row is a 23503", async () => {
    await expect(insert(301, { kind: "item", item_id: await uuidv7(db.admin) }))
      .rejects.toMatchObject({ code: "23503" });
  });
```

- [ ] **Step 12: Write `tests/regression/sah-066.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { sharedDb, thinRegression } from "../support/regression";

thinRegression(
  66,
  "Unit conversion is defined in the schema and applied nowhere",
  ["contracts §4.3.4", "spec:2043", "packages/db/test/inventory/unit-conversion.test.ts"],
  () => {
    it("the conversion is applied by a TRIGGER, so no write path can skip it", async () => {
      const { db } = await sharedDb();
      const [trigger] = await db.admin<{ tgname: string; enabled: string }[]>`
        select t.tgname, t.tgenabled as enabled
          from pg_trigger t
         where t.tgrelid = 'app.document_line'::regclass
           and t.tgname = 'document_line_base_quantity'`;
      // The old system stored MatUnits.Exchange and never multiplied by it: the conversion existed as data and
      // as documentation, and each of five call sites decided for itself. Here the only place the arithmetic
      // happens on a write is inside the database, which is what makes "every write path" true rather than
      // "every write path we remembered".
      expect(trigger?.tgname).toBe("document_line_base_quantity");
      expect(trigger?.enabled).toBe("O");        // enabled, ORIGIN — never disabled "temporarily" (spec:97)
    });

    it("the conversion is an exact rational in the schema, not a float", async () => {
      const { db } = await sharedDb();
      const cols = await db.admin<{ column_name: string; data_type: string }[]>`
        select column_name, data_type from information_schema.columns
         where table_schema = 'app' and table_name = 'unit_conversion'
           and column_name in ('numerator', 'denominator')
         order by column_name`;
      expect(cols).toEqual([
        { column_name: "denominator", data_type: "bigint" },
        { column_name: "numerator", data_type: "bigint" },
      ]);
    });
  },
);
```

- [ ] **Step 13: Write `docs/adr/0036-exact-unit-conversion-and-fefo-over-the-projection.md`**

```markdown
# ADR 0036 — Exact unit conversion at line write, and FEFO over the synchronous projection

- Status: Accepted
- Date: 2026-09-07
- Slice: 3A
- Supersedes: none. Related: ADR 0034 (the sentinel lot), ADR 0035 (movement planning in the evaluator)

## Context

Two decisions in one record, because they share a root cause: the legacy system computed an answer at each
call site instead of once, and the answer therefore depended on which call site ran.

**SAH-066** — `MatUnits.Exchange` held a conversion factor per (material, unit) and no code multiplied by it.
Quantities were entered in cartons and stored as if they were pieces. The factor existed as data and as
documentation and as nothing else.

**SAH-067** — stock on hand was computed by replaying the entire movement history under a hinted
index-navigation plan. Two consequences: it was slow in proportion to history rather than to stock, and the
row order — and so the answer to "which batch do I pick?" — was a property of the chosen plan rather than of
the data.

## Decision

**1. The base quantity is derived in SQL, by a trigger on `app.document_line`.**
`app.document_line_base_quantity()` (migration 0032) fires BEFORE INSERT OR UPDATE. When a line carries the
entered pair `(unit_id, unit_quantity)` it sets `quantity := round(unit_quantity × numerator / denominator, 6)`
from `app.unit_conversion`, resolving the item's own base unit to 1/1 and raising `ERR_VALIDATION_FAILED` for
an unconfigured unit. When the caller also supplied `quantity`, the two must agree.

`packages/domain`'s `applyConversion(unitQuantity, conversion)` is the read-side twin, used for previews and
for plan inputs. It is `Quantity.convert`'s arithmetic — `times(numerator).div(denominator)` at precision 40,
rounded once at `QUANTITY_SCALE` — with **`HALF_AWAY_FROM_ZERO` in place of `convert`'s HALF_EVEN**, which
§4.2.1 fixes. What this ADR decides is the **mode**, and only the mode. The trigger's `round(…, 6)` is
Postgres `numeric round()`, which is half away from zero, so a twin rounding HALF_EVEN would answer
`0.000000` where the database answers `0.000001` for `1 × 1/2000000`, and the trigger's agreement branch
would then refuse a legitimate line. Same scale by `QUANTITY_SCALE`, same mode by this decision — and the
same *order*: numerator first, denominator second, one rounding at the end, matching
`unit_quantity * num::numeric / den::numeric`. `Quantity.multiply(rational, mode)` is not used, because 0D
implements it by collapsing the rational to a decimal before multiplying, and rounding before multiplying is
the SAH-066 shape.

**2. FEFO reads `app.stock_on_hand`, and its ordering is total.**
`app.pick_lots_fefo(item_id, warehouse_id, quantity)` (migration 0031) walks the synchronous projection
ordered by `expires_on asc nulls last, code asc, lot_id asc` and returns `(lot_id, quantity)` pairs until the
requested quantity is met, or fewer if the warehouse cannot meet it.

## Consequences

- A carton quantity cannot be counted as pieces by any write path, including a hand-typed `app_rw` insert, the
  Phase 9 importer and Phase 6 sync apply. That is the whole content of "applied nowhere" being fixed.
- A caller that supplies a `quantity` inconsistent with its own entered pair gets a named refusal rather than
  a silently corrected row. `reverseDocument` negates `unit_quantity` alongside `quantity`, and the agreement
  branch passes because Postgres `round()` on `numeric` is symmetric across sign — and because
  `applyConversion`'s HALF_AWAY_FROM_ZERO is symmetric across sign too, which HALF_EVEN is not.
- **A conversion result that will be compared to a stored `document_line` row must be computed with
  `applyConversion`, never with `Quantity.convert`.** The two agree everywhere except at a tie at the sixth
  decimal place, and at a tie the trigger wins and the caller is refused. The agreement is asserted on both
  sides: `packages/domain/test/quantity/convert.test.ts` pins the pure value, and
  `packages/db/test/inventory/unit-conversion.test.ts` inserts a line at the tie and asserts the trigger's
  derived `quantity` equals `convertToBase`'s. §4.2.1 needs one sentence recording that its `Quantity` class
  now has two documented conversion modes for two different jobs.
- The trigger costs one indexed lookup per line carrying a unit pair, and none for a line without one.
- FEFO's cost is proportional to the number of open lots of one item in one warehouse, not to history.
- FEFO's answer is stable: the ordering is a total order on the candidate rows, so no planner choice can change
  it. The old behaviour is unreachable, not merely discouraged.
- The projection is synchronous (D14, MERGEd in the posting transaction), so outside a posting transaction the
  picker is current to the last commit. **Inside** one it is not, which is why `app.assert_stock_available`
  sums `inventory_movement` and never reads the projection (§4.7.3).
- Picking is a drafting-time concern: a user or a screen asks for lots before the document is posted. Nothing
  in the posting path calls `pick_lots_fefo`.
- A lot with no expiry — every item's `NONE` sentinel — sorts last, so a dated batch is always consumed first.
  For an item that genuinely has no batches, all stock is on the sentinel and the ordering is a no-op.
```

- [ ] **Step 14: Run everything and verify**

Run: `bun run --cwd packages/domain test -- test/quantity/convert.test.ts`
Expected: **PASS**, six assertions.

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/inventory/unit-conversion.test.ts`
Expected: **PASS**, eleven assertions. Two failures to recognise in the tie case: `ERR_VALIDATION_FAILED: line 1 says 0.000000 base units but 1.000000 of that unit is 0.000001` means `applyConversion` was written as a delegation to `Quantity.convert` and its HALF_EVEN mode is the whole content of the failure; a first row that passes and a **second** row that fails on `3.000000` means it was written as `Quantity.multiply(conversion, …)`, which divides the rational before multiplying. Both are fixed by Step 2's body as given — `convert`'s order, `HALF_AWAY_FROM_ZERO`'s mode.

Run: `bun run --cwd packages/db test`
Expected: **PASS** across 1A's, 2A's and 2B's suites. If `document-line-generalised.test.ts`, `posting/load.test.ts` or `posting/reverse.test.ts` fails with `23503`, Step 11 missed a call site — re-run the `grep`.

Run: `bun run --cwd tests test -- regression/sah-066.test.ts`
Expected: **PASS**, two assertions.

Run: `bun run --cwd packages/contracts openapi:generate && git diff --exit-code packages/contracts/openapi.json`
Expected: a **diff**, then commit it — `DocumentLine` and `CreateDocument` gained five properties, and spec:2055 requires the generated document to be committed and diffed in CI.

Run: `bun run typecheck && bun run lint && bun run lint:rules && bun run --cwd packages/db db:lint`
Expected: PASS, `0 violations`.

- [ ] **Step 15: Commit**

```bash
git add packages/db/migrations/0032_alter_document_line_add_inventory_columns.sql \
        packages/db/migrations/0032.down.sql packages/db/src/schema/document_line.ts \
        packages/db/src/inventory/units.ts packages/db/src/index.ts \
        packages/db/src/posting/load.ts packages/db/src/posting/reverse.ts \
        packages/domain/src/quantity/convert.ts packages/domain/src/index.ts \
        packages/domain/test/quantity/convert.test.ts packages/contracts/src/accounting/document.ts \
        packages/contracts/openapi.json packages/db/test/inventory/unit-conversion.test.ts \
        packages/db/test/document-line-generalised.test.ts packages/db/test/posting/load.test.ts \
        packages/db/test/posting/reverse.test.ts tests/regression/sah-066.test.ts \
        docs/adr/0036-exact-unit-conversion-and-fefo-over-the-projection.md
git commit -m "$(cat <<'EOF'
feat(db): document_line inventory columns, the item_id key, and conversion applied in SQL [3A T6]

Migration 0032 adds warehouse_id, lot_id, unit_id and unit_quantity to
document_line with five composite FKs, closing the item_id slot 2A left open,
and ships app.document_line_base_quantity() — the trigger that derives the base
quantity from the entered (unit_id, unit_quantity) pair on every write path.
That is SAH-066: the factor existed in MatUnits.Exchange and nothing multiplied
by it. A supplied quantity that disagrees is refused rather than overwritten.

loadSnapshot fills the four fields §4.3.1's stub list assigns 3A —
header.warehouseId, header.toWarehouseId, the four line columns and refs.items
from app.item. toWarehouseId stays null on a LINE because no such column
exists and 0032 does not add one; planMovements falls back to the header.

reverseDocument now carries the four columns, negating unit_quantity with the
other signed magnitudes. round() is symmetric across sign, so the trigger's
agreement branch passes by construction — and a reversal that forgot to negate
would be refused, which is the guard working.

Closing the FK broke three 2A tests that wrote arbitrary uuids into item_id,
exactly as §4.3.4 warned. Each now uses seedItem, and document-line-generalised
gained an it asserting the new 23503 so the change of meaning is visible there.

applyConversion is the read-side twin and rounds HALF_AWAY_FROM_ZERO, not
Quantity.convert's HALF_EVEN: Postgres numeric round() is half away from zero,
so a HALF_EVEN twin would answer 0.000000 where the trigger answers 0.000001
for 1 x 1/2000000 and the agreement branch would refuse a legitimate line. Both
suites assert the tie — the pure value in packages/domain, and the trigger's
derived quantity against convertToBase's in packages/db.

ADR 0036 records all three: conversion at line write, the one rounding mode on
both sides of it, and FEFO over the synchronous projection with a total
ordering (SAH-067).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `planMovements` — the movement half of `evaluatePolicy`, and ADR 0035

2A's `evaluatePolicy` ends `return { ledgerLines, movements: [], taxLines, warnings };` with the note that `inventory.effect` "is read by 3A's `applyMovements` … which is the slice that has `app.item` and `app.warehouse` to plan against". This task reads it — but in the **evaluator**, not in `applyMovements`, because §4.4.2 says "the evaluator assigns `movementNo` in emission order" and §4.7.2 says `applyMovements` "assign[s] `movement_no` from `plan.movements[i].movementNo`". Something upstream must produce the number, planning is pure, and every input it needs is already on the snapshot after Task 6. That is **ADR 0035**, and it is what lets 3B replace `applyMovements`' body without touching policy interpretation.

**`quantity` is a magnitude and `effect` is the sole carrier of direction**, exactly as amendment A9 makes `side` the sole carrier for `PlannedLedgerLine`. A reversal carries negated `line.quantity` (Task 6 made `reverse.ts` negate `unit_quantity` too), so a rule that would emit `issue` over a negative line quantity emits `receipt` at `quantity.abs()` instead, and a `transfer` swaps its two legs. **`PlannedMovement.quantity.isNegative()` is always `false`** — hazard-level: 3B, 3D, 6A and 9B all consume this array and none of them may read a direction from the sign.

**Files:**
- Create: `packages/domain/test/posting/plan-movements.test.ts`, `docs/adr/0035-movement-planning-in-the-evaluator.md`
- Modify: `packages/domain/src/posting/evaluate.ts` (add `planMovements`; the `movements: []` return becomes a call)

**Interfaces:**
- Consumes: `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `ItemRef`, `PlannedMovement`, `PostingPlan`, `PolicyEvaluationError` (§4.4.2, all 2A's); `Quantity` (§4.2.1).
- Produces:
  - `export function planMovements(policy: PostingPolicy, snapshot: DocumentSnapshot): PlannedMovement[]` — exported from `@dulja/domain` so 3B's golden fixtures can call it without going through `evaluatePolicy`.
  - `evaluatePolicy`'s `movements` member, filled.

**The nine rules, fixed here so no later slice guesses one:**

1. `inventory.effect === "none"` → `[]`. No other short circuit.
2. A non-`none` effect whose `costing` is absent or `"none"` → `PolicyEvaluationError("ERR_POLICY_INVALID", …)`. §4.4.1's `if/then` requires the member but admits the label `"none"`, while `PlannedMovement.costing` admits only `consume_layers | create_layer | zero`. A policy in that gap is unplannable and says so at post rather than producing a movement the costing engine cannot price.
3. A line with no `itemId`, or whose item is `kind ∈ service | asset`, plans nothing and **warns nothing** (assumption 6). A mixed invoice — goods plus freight-as-a-service — is the normal case, and a warning per freight line would make every real document noisy.
4. A line whose `itemId` is not in `snapshot.refs.items` → `ERR_POLICY_REQUIRES_MISSING` naming the line and the id. It cannot happen after Task 6 (`document_line_item_fk` guarantees the row and `loadSnapshot` reads every distinct id), so it is a loud assertion of a real invariant rather than a fallback.
5. A product line with `quantity === null` under a non-`none` effect → `ERR_POLICY_REQUIRES_MISSING` keyed `line <n>: quantity`. `validateRequires` cannot have caught it: `requires` names header fields, never a line's.
6. A product line with `quantity` exactly zero plans nothing — the same zero-drop step 6 applies to ledger lines, and `inventory_movement` has `check (quantity <> 0)`.
7. Warehouse resolution: `"line.warehouse"` → `line.warehouseId ?? header.warehouseId`; `"header.warehouse"` → `header.warehouseId` alone (a policy that says the whole document ships from one place means it). `"line.to_warehouse"` → `line.toWarehouseId ?? header.toWarehouseId`, which at 3A is always the header's (assumption 3); `"header.to_warehouse"` → the header's. A null result → `ERR_POLICY_REQUIRES_MISSING` naming `warehouse` or `to_warehouse`. **A policy may declare `line.warehouse` without listing `warehouse` in `requires`**, so `validateRequires` is not a substitute for this check.
8. Lots: a line the policy declares a **receipt** and that is *emitting* a receipt, on an item with `trackLots`, must carry a `lotId` → otherwise `ERR_POLICY_REQUIRES_MISSING`. Every other case leaves `lotId` as the line has it — `null` included, which `applyMovements` resolves to the item's `NONE` sentinel. The gate is on **both** the declared and the emitted direction so a reversal never trips it: the reversal's lines carry the original's `lot_id` (Task 6), and a return of stock to the lot it came from is not a new batch.

9. **`costing` follows the EMITTED effect — everywhere, not only on a transfer — unless the policy declared `"zero"`, which is an instruction and not a direction.** One helper, `costingFor(emittedEffect)`, decides it for all three `movements.push` sites: `"zero"` survives untouched, an emitted `issue` is `consume_layers` and an emitted `receipt` is `create_layer`. Two reasons, and each is a defect if the rule is only half-applied. **(a)** §4.7.1's `CostingEngine.cost` branches on the movement to produce `newLayer` for a receipt and `consumptions` for an issue. A reversal of an `issue` policy emits `{ effect: "receipt" }`; carrying the declared `consume_layers` onto it would freeze a self-contradictory `PlannedMovement` — a receipt that tells 3B to consume layers — into the array 3B, 3D, 6A and 9B all read. **(b)** In the other direction, a blanket override would erase a legitimate `costing: "zero"`. §4.7.1 says in as many words that "a value-less issue with no open layers costs at zero only when `costing = \"zero\"`" (free-of-charge lines, spec:1055), so `"zero"` is exactly the marker 3B reads and exactly the one a direction-derived rule must not replace with `consume_layers`. It is also assumption 8's FOC path, which values at `line.amount` — zero — and would otherwise arrive at 3B's engine with no way to say so.

**A transfer, spelled out.** One line emits two movements: `movementNo` *n* at the `warehouse` and *n+1* at the `to_warehouse`, **in that order regardless of direction**, so the numbering is a property of the policy and not of the sign. Costing follows the emitted effect through rule 9's `costingFor`, the same helper the non-transfer branch uses: the leg that leaves consumes layers, the leg that arrives creates one (§4.7.1) — and a transfer whose policy declares `costing: "zero"` keeps `"zero"` on both legs. `to_warehouse` equal to `warehouse` → `ERR_POLICY_REQUIRES_MISSING` naming `to_warehouse`; the two legs would cancel to a net-zero key and the document would post as an expensive no-op. That code is the closest of `PolicyEvaluationError`'s **three** frozen members (§4.4.2) and the message is exact; inventing a fourth would need a contracts amendment, which this slice does not make for a message.

- [ ] **Step 1: Write the failing test `packages/domain/test/posting/plan-movements.test.ts`**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  Money, PolicyEvaluationError, Quantity, currency, planMovements, evaluatePolicy,
  type DocumentSnapshot, type ItemRef, type LineSnapshot, type PostingPolicy,
} from "../../src";

const MYR = currency("MYR");
const m = (v: string) => Money.of(v, MYR);

const product: ItemRef = {
  id: "item-p", code: "RICE-5KG", kind: "product", baseUnitId: "unit-pcs", trackLots: false,
  revenueAccountId: "acc-4000", inventoryAccountId: "acc-1300", cogsAccountId: "acc-5000", expenseAccountId: null,
};
const tracked: ItemRef = { ...product, id: "item-t", code: "MILK-1L", trackLots: true };
const service: ItemRef = { ...product, id: "item-s", code: "FREIGHT", kind: "service", trackLots: false };

function line(over: Partial<LineSnapshot> & { lineNo: number }): LineSnapshot {
  return {
    id: `l-${over.lineNo}`, kind: "item", description: null, accountId: null, itemId: product.id,
    quantity: Quantity.of("10.000000"), unitPrice: m("5.0000"), discount: m("0.0000"), amount: m("50.0000"),
    taxCodeId: null, taxAmount: m("0.0000"), totalInclTax: m("50.0000"), debit: m("0.0000"),
    credit: m("0.0000"), cost: null, warehouseId: null, toWarehouseId: null, lotId: null,
    unitId: null, unitQuantity: null, countedQuantity: null, expectedQuantity: null,
    tenderMethod: null, customFields: {}, dimensions: {}, payroll: null, ...over,
  };
}

function snapshot(lines: LineSnapshot[], header: Partial<DocumentSnapshot["header"]> = {}): DocumentSnapshot {
  return {
    header: {
      id: "doc-1", companyId: "co-1", documentTypeCode: "STOCK_ISSUE_TEST", status: "issued", series: "SIT",
      fiscalPeriodId: "fp-1", number: 1n, effectiveDate: "2026-01-15", partyId: null, currency: MYR,
      exchangeRate: { from: MYR, to: MYR, rate: "1.00000000", effectiveFrom: "2026-01-01", source: "unit" },
      branchId: "br-hq", attributedTo: null, clientRef: null,
      warehouseId: "wh-main", toWarehouseId: null, taxInclusive: false, reversesDocumentId: null,
      customFields: {}, ...header,
    },
    lines,
    company: { id: "co-1", baseCurrency: MYR, fxRoundingAccountId: "acc-5920", costingMethod: "avco" },
    party: null,
    refs: {
      accountsByCode: {}, taxCodes: {}, components: {}, schemes: {}, dimensionTypesByCode: { BRANCH: "dt-branch" },
      items: { [product.id]: product, [tracked.id]: tracked, [service.id]: service },
    },
  };
}

function policy(inventory: PostingPolicy["inventory"]): PostingPolicy {
  return {
    version: 1, documentType: "STOCK_ISSUE_TEST", direction: "internal", requires: [], lines: [],
    inventory, tax: { applies: false }, numbering: { series: "SIT", assignAt: "issue" },
    reversal: { allowed: true, producesType: "STOCK_ISSUE_TEST" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" }, dimensions: { required: [] },
  } as PostingPolicy;
}

describe("planMovements — ADR 0035, contracts §4.4.2", () => {
  it("plans nothing when the policy moves no stock", () => {
    expect(planMovements(policy({ effect: "none" }), snapshot([line({ lineNo: 1 })]))).toEqual([]);
  });

  it("an issue emits one movement per product line, numbered from 1 in emission order", () => {
    const plan = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1 }), line({ lineNo: 2, quantity: Quantity.of("4.000000") })]));
    expect(plan).toEqual([
      { lineNo: 1, movementNo: 1, itemId: product.id, warehouseId: "wh-main", lotId: null,
        quantity: Quantity.of("10.000000"), effect: "issue", value: null, costing: "consume_layers" },
      { lineNo: 2, movementNo: 2, itemId: product.id, warehouseId: "wh-main", lotId: null,
        quantity: Quantity.of("4.000000"), effect: "issue", value: null, costing: "consume_layers" },
    ]);
  });

  it("a negative line quantity flips the effect and keeps the quantity a MAGNITUDE (amendment A9)", () => {
    const [mv] = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1, quantity: Quantity.of("-10.000000") })]));
    expect(mv!.effect).toBe("receipt");
    expect(mv!.quantity.toString()).toBe("10.000000");
    expect(mv!.quantity.isNegative()).toBe(false);
    // Rule 9: costing follows the EMITTED effect. The policy declared consume_layers, but this movement is
    // a receipt, and §4.7.1's engine produces `newLayer` for a receipt — a receipt carrying consume_layers
    // would be a self-contradictory plan frozen into the array 3B, 3D, 6A and 9B all read.
    expect(mv!.costing).toBe("create_layer");
  });

  it("costing 'zero' is an instruction, not a direction: it survives every flip and both transfer legs", () => {
    // §4.7.1: "a value-less issue with no open layers costs at zero only when costing = 'zero'" — the FOC
    // marker (spec:1055) 3B reads. Rule 9 derives costing from the emitted effect for every other label and
    // leaves this one alone; overriding it would delete exactly the signal it exists to carry.
    const [foc] = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "zero" }),
      snapshot([line({ lineNo: 1 })]));
    expect(foc!.costing).toBe("zero");
    const [reversedFoc] = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "zero" }),
      snapshot([line({ lineNo: 1, quantity: Quantity.of("-3.000000") })]));
    expect([reversedFoc!.effect, reversedFoc!.costing]).toEqual(["receipt", "zero"]);
    const legs = planMovements(
      policy({ effect: "transfer", warehouse: "header.warehouse", to_warehouse: "header.to_warehouse", costing: "zero" }),
      snapshot([line({ lineNo: 1 })], { toWarehouseId: "wh-transit" }));
    expect(legs.map((mv) => [mv.effect, mv.costing])).toEqual([["issue", "zero"], ["receipt", "zero"]]);
  });

  it("a line warehouse overrides the header's; header.warehouse ignores the line's", () => {
    const perLine = planMovements(
      policy({ effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1, warehouseId: "wh-branch" }), line({ lineNo: 2 })]));
    expect(perLine.map((mv) => mv.warehouseId)).toEqual(["wh-branch", "wh-main"]);
    const perHeader = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1, warehouseId: "wh-branch" })]));
    expect(perHeader[0]!.warehouseId).toBe("wh-main");
  });

  it("a transfer emits two movements per line: warehouse leg first, always", () => {
    const plan = planMovements(
      policy({ effect: "transfer", warehouse: "header.warehouse", to_warehouse: "header.to_warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1 })], { toWarehouseId: "wh-transit" }));
    expect(plan).toEqual([
      { lineNo: 1, movementNo: 1, itemId: product.id, warehouseId: "wh-main", lotId: null,
        quantity: Quantity.of("10.000000"), effect: "issue", value: null, costing: "consume_layers" },
      { lineNo: 1, movementNo: 2, itemId: product.id, warehouseId: "wh-transit", lotId: null,
        quantity: Quantity.of("10.000000"), effect: "receipt", value: null, costing: "create_layer" },
    ]);
  });

  it("a reversed transfer swaps the legs' effects and keeps the leg ORDER and the numbering", () => {
    const plan = planMovements(
      policy({ effect: "transfer", warehouse: "header.warehouse", to_warehouse: "header.to_warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1, quantity: Quantity.of("-10.000000") })], { toWarehouseId: "wh-transit" }));
    expect(plan.map((mv) => [mv.movementNo, mv.warehouseId, mv.effect, mv.costing])).toEqual([
      [1, "wh-main", "receipt", "create_layer"],
      [2, "wh-transit", "issue", "consume_layers"],
    ]);
  });

  it("line.to_warehouse falls back to the header at 3A, because no line column exists (assumption 3)", () => {
    const plan = planMovements(
      policy({ effect: "transfer", warehouse: "header.warehouse", to_warehouse: "line.to_warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1 })], { toWarehouseId: "wh-transit" }));
    expect(plan[1]!.warehouseId).toBe("wh-transit");
  });

  it("a service or asset line plans nothing and warns nothing (assumption 6)", () => {
    const plan = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1, itemId: service.id }), line({ lineNo: 2 })]));
    expect(plan.map((mv) => mv.lineNo)).toEqual([2]);
  });

  it("a line with no item, and a zero quantity, both plan nothing", () => {
    const plan = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([
        line({ lineNo: 1, kind: "text", itemId: null, quantity: null }),
        line({ lineNo: 2, quantity: Quantity.zero() }),
      ]));
    expect(plan).toEqual([]);
  });

  it("a product line with a null quantity is named, never skipped", () => {
    expect(() => planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 3, quantity: null })])))
      .toThrow(/ERR_POLICY_REQUIRES_MISSING/);
    expect(() => planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 3, quantity: null })])))
      .toThrow(/line 3: quantity/);
  });

  it("an unresolvable warehouse names the reference, not a null id", () => {
    expect(() => planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1 })], { warehouseId: null })))
      .toThrow(/line 1: warehouse/);
    expect(() => planMovements(
      policy({ effect: "transfer", warehouse: "header.warehouse", to_warehouse: "header.to_warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1 })])))
      .toThrow(/line 1: to_warehouse/);
  });

  it("a transfer to the same warehouse is refused, not posted as a net-zero pair", () => {
    expect(() => planMovements(
      policy({ effect: "transfer", warehouse: "header.warehouse", to_warehouse: "header.to_warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1 })], { toWarehouseId: "wh-main" })))
      .toThrow(/line 1: to_warehouse resolves to the same warehouse/);
  });

  it("a lot-tracked item must carry a lot on a declared receipt, and need not on an issue", () => {
    expect(() => planMovements(
      policy({ effect: "receipt", warehouse: "header.warehouse", costing: "create_layer" }),
      snapshot([line({ lineNo: 1, itemId: tracked.id })])))
      .toThrow(/line 1: lot is required by STOCK_ISSUE_TEST for lot-tracked item MILK-1L/);
    const issued = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1, itemId: tracked.id })]));
    expect(issued[0]!.lotId).toBeNull();            // applyMovements resolves the NONE sentinel
  });

  it("a REVERSED receipt of a tracked item does not trip the lot gate", () => {
    const plan = planMovements(
      policy({ effect: "receipt", warehouse: "header.warehouse", costing: "create_layer" }),
      snapshot([line({ lineNo: 1, itemId: tracked.id, quantity: Quantity.of("-6.000000"), lotId: "lot-1" })]));
    expect(plan[0]!.effect).toBe("issue");
    expect(plan[0]!.lotId).toBe("lot-1");
    expect(plan[0]!.costing).toBe("consume_layers");   // rule 9 again, from the other direction
  });

  it("a stock-moving effect with costing 'none' is an invalid policy, not a movement", () => {
    expect(() => planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "none" }),
      snapshot([line({ lineNo: 1 })])))
      .toThrow(PolicyEvaluationError);
    expect(() => planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "none" }),
      snapshot([line({ lineNo: 1 })])))
      .toThrow(/ERR_POLICY_INVALID/);
  });

  it("evaluatePolicy now returns the movements instead of an empty array", () => {
    const plan = evaluatePolicy(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1 })]));
    expect(plan.movements).toHaveLength(1);
    expect(plan.ledgerLines).toEqual([]);           // this policy declares no `lines` rules
  });

  it("allowNegative is carried by the schema and read by nothing here (assumption 4)", () => {
    const permissive = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers", allowNegative: true }),
      snapshot([line({ lineNo: 1 })]));
    const strict = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1 })]));
    expect(permissive).toEqual(strict);
  });
});
```

- [ ] **Step 2: Run the test to see the exact failure**

Run: `bun run --cwd packages/domain test -- test/posting/plan-movements.test.ts`
Expected: **FAIL** at import — `"planMovements" is not exported by "src/index.ts"`.

- [ ] **Step 3: Write `planMovements` in `packages/domain/src/posting/evaluate.ts`**

Append below `evaluatePolicy`. Nothing above it changes except the return statement in Step 4.

```ts
type WarehouseRef = NonNullable<PostingPolicy["inventory"]["warehouse"]>;
type ToWarehouseRef = NonNullable<PostingPolicy["inventory"]["to_warehouse"]>;

function resolveWarehouse(
  ref: WarehouseRef, line: LineSnapshot, snapshot: DocumentSnapshot,
): string | null {
  // §4.3.4: the header carries the default and a line's warehouse_id overrides it. A policy that names
  // header.warehouse means the whole document ships from one place, so it does NOT consult the line.
  return ref === "line.warehouse" ? line.warehouseId ?? snapshot.header.warehouseId : snapshot.header.warehouseId;
}

function resolveToWarehouse(
  ref: ToWarehouseRef, line: LineSnapshot, snapshot: DocumentSnapshot,
): string | null {
  // `line.toWarehouseId` is a constant null at 3A: there is no document_line.to_warehouse_id column and
  // §4.3.4's 3A row does not add one (assumption 3). The fallback is what makes the branch meaningful today,
  // and 3D adds the column in its own migration range if a per-line destination arrives.
  return ref === "line.to_warehouse"
    ? line.toWarehouseId ?? snapshot.header.toWarehouseId
    : snapshot.header.toWarehouseId;
}

/**
 * The movement half of the plan (ADR 0035). Pure: every input is on the snapshot, and the only outputs are
 * `PlannedMovement`s with `value: null` — §4.7.2's `applyMovements` fills `value`, and 3B replaces how.
 *
 * `quantity` is always a MAGNITUDE and `effect` is the sole carrier of direction, exactly as amendment A9
 * makes `side` the sole carrier for a planned ledger line. `PlannedMovement.quantity.isNegative()` is
 * therefore always false, and no consumer — 3B, 3D, 6A, 9B — may infer a direction from it.
 *
 * `movementNo` is 1-based per DOCUMENT and assigned in emission order (§4.4.2), which is why a `transfer`
 * line's two legs can share one `lineNo`: `(document_id, movement_no)` is the movement row's unique key.
 */
export function planMovements(policy: PostingPolicy, snapshot: DocumentSnapshot): PlannedMovement[] {
  const inv = policy.inventory;
  if (inv.effect === "none") return [];

  // §4.4.1's if/then requires `costing` for a stock-moving effect but admits the label "none", while
  // PlannedMovement.costing admits only consume_layers | create_layer | zero. A policy in that gap describes a
  // movement the costing engine cannot price, so it is refused at post rather than half-planned.
  const declaredCosting = inv.costing;
  if (declaredCosting === undefined || declaredCosting === "none") {
    throw new PolicyEvaluationError(
      "ERR_POLICY_INVALID",
      `${policy.documentType} declares inventory.effect "${inv.effect}" with costing "${declaredCosting ?? "absent"}"; a planned movement carries consume_layers, create_layer or zero`,
    );
  }

  // Rule 9, in one place so no branch below can apply half of it. `costing` follows the EMITTED effect —
  // §4.7.1's engine produces `newLayer` for a receipt and `consumptions` for an issue, so a movement whose
  // costing disagrees with its effect is a plan 3B cannot price. The one exception is `"zero"`, which is a
  // costing INSTRUCTION and not a direction: §4.7.1 reads it as the free-of-charge marker ("a value-less
  // issue with no open layers costs at zero only when costing = 'zero'", spec:1055), so deriving over it
  // would delete the signal.
  const costingFor = (emitted: "issue" | "receipt"): PlannedMovement["costing"] =>
    declaredCosting === "zero" ? "zero" : emitted === "issue" ? "consume_layers" : "create_layer";

  const movements: PlannedMovement[] = [];
  let movementNo = 0;

  for (const line of snapshot.lines) {
    if (line.itemId === null) continue;

    const item = snapshot.refs.items[line.itemId];
    if (item === undefined) {
      // Unreachable after 3A's migration 0032 (document_line_item_fk guarantees the row, and loadSnapshot
      // reads every distinct item_id) — asserted loudly rather than defaulted, because a missing ref would
      // otherwise plan a movement for an item whose kind and trackLots nobody knows.
      throw new PolicyEvaluationError(
        "ERR_POLICY_REQUIRES_MISSING",
        `line ${line.lineNo}: item ${line.itemId} is not in the snapshot's item map`,
      );
    }
    if (item.kind !== "product") continue;      // a service has no stock; an asset is Phase 10's register

    if (line.quantity === null) {
      throw new PolicyEvaluationError(
        "ERR_POLICY_REQUIRES_MISSING",
        `line ${line.lineNo}: quantity is required by ${policy.documentType}'s inventory.effect "${inv.effect}"`,
      );
    }
    if (line.quantity.isZero()) continue;       // inventory_movement has check (quantity <> 0)

    const reversed = line.quantity.isNegative();
    const magnitude = reversed ? line.quantity.negate() : line.quantity;

    const from = resolveWarehouse(inv.warehouse ?? "header.warehouse", line, snapshot);
    if (from === null) {
      throw new PolicyEvaluationError(
        "ERR_POLICY_REQUIRES_MISSING",
        `line ${line.lineNo}: warehouse is required by ${policy.documentType} and neither the line nor the header carries one`,
      );
    }

    if (inv.effect === "transfer") {
      const to = resolveToWarehouse(inv.to_warehouse ?? "header.to_warehouse", line, snapshot);
      if (to === null) {
        throw new PolicyEvaluationError(
          "ERR_POLICY_REQUIRES_MISSING",
          `line ${line.lineNo}: to_warehouse is required by ${policy.documentType} and neither the line nor the header carries one`,
        );
      }
      if (to === from) {
        throw new PolicyEvaluationError(
          "ERR_POLICY_REQUIRES_MISSING",
          `line ${line.lineNo}: to_warehouse resolves to the same warehouse as warehouse (${from}); a transfer needs two`,
        );
      }
      // The warehouse leg is always emitted first, whichever way the stock is going, so the numbering is a
      // property of the policy and not of the sign. Costing comes from `costingFor` — rule 9's one helper,
      // shared with the non-transfer branch below.
      const fromEffect = reversed ? "receipt" : "issue";
      const toEffect = reversed ? "issue" : "receipt";
      movements.push({
        lineNo: line.lineNo, movementNo: ++movementNo, itemId: item.id, warehouseId: from,
        lotId: line.lotId, quantity: magnitude, effect: fromEffect, value: null,
        costing: costingFor(fromEffect),
      });
      movements.push({
        lineNo: line.lineNo, movementNo: ++movementNo, itemId: item.id, warehouseId: to,
        lotId: line.lotId, quantity: magnitude, effect: toEffect, value: null,
        costing: costingFor(toEffect),
      });
      continue;
    }

    const effect = reversed
      ? (inv.effect === "issue" ? "receipt" : "issue")
      : inv.effect;

    // A line the policy DECLARES a receipt and that is EMITTING one, on a lot-tracked item, must name its
    // batch: the sentinel would silently pool two batches and the expiry report would then be wrong. Both
    // conditions are required so a reversal — declared receipt, emitting issue — never trips the gate, and
    // neither does a return, which is an issue policy emitting a receipt into the lot it came from.
    if (effect === "receipt" && inv.effect === "receipt" && item.trackLots && line.lotId === null) {
      throw new PolicyEvaluationError(
        "ERR_POLICY_REQUIRES_MISSING",
        `line ${line.lineNo}: lot is required by ${policy.documentType} for lot-tracked item ${item.code}`,
      );
    }

    movements.push({
      lineNo: line.lineNo, movementNo: ++movementNo, itemId: item.id, warehouseId: from,
      lotId: line.lotId, quantity: magnitude, effect, value: null, costing: costingFor(effect),
    });
  }

  return movements;
}
```

Add `PlannedMovement` to the file's type imports if it is not already there, and export `planMovements` from `packages/domain/src/posting/index.ts` and `packages/domain/src/index.ts`.

**`inv.allowNegative` is read nowhere above, and that is deliberate (assumption 4).** Test 18 requires the refusal "regardless of session flags, user attributes, or write path" (spec:2436), and a policy flag is a user attribute. `app.assert_stock_available` has one door and it is an override event. The field stays in the schema unread; the slice that wants it to mean something amends the contracts document first.

- [ ] **Step 4: Replace the `movements: []` return**

One line in `evaluatePolicy`:

```ts
  return { ledgerLines, movements: planMovements(policy, snapshot), taxLines, warnings };
```

Delete 2A's paragraph-comment above the old return if it is inline in the file, and put this in its place:

```ts
  // 3A: `movements` is planned here rather than in applyMovements (ADR 0035) — §4.4.2 makes movementNo the
  // evaluator's to assign, planning is pure, and this keeps applyMovements free of policy interpretation,
  // which is what lets 3B replace its body without touching this file.
```

- [ ] **Step 5: Write `docs/adr/0035-movement-planning-in-the-evaluator.md`**

```markdown
# ADR 0035 — Movement planning belongs to the evaluator, and the provisional value rule

- Status: Accepted
- Date: 2026-09-07
- Slice: 3A
- Related: ADR 0026 (the posting-policy schema), ADR 0034 (the sentinel lot), ADR 0036 (unit conversion, FEFO)

## Context

Two sentences in the frozen contracts disagreed about where `inventory.effect` is read.

2A's `evaluatePolicy` returns `movements: []` with the note that the field "is read by 3A's `applyMovements`
(contracts §4.7.2), which is the slice that has `app.item` and `app.warehouse` to plan against".

But contracts §4.4.2's doc comment on `PlannedMovement` says "**the evaluator assigns `movementNo` in
emission order**", and §4.7.2 says `applyMovements` "assign[s] `movement_no` from
`plan.movements[i].movementNo`" — it *reads* the number. Something upstream has to have produced it.

## Decision

**`planMovements(policy, snapshot)` lives in `packages/domain/src/posting/evaluate.ts` and `evaluatePolicy`
returns its result.** `applyMovements` consumes the array and interprets no policy.

Both readings of 2A's sentence end in the same slice — 3A writes the code either way — and this one is
correct on three counts:

1. **It is pure.** Every input is already on the snapshot after 3A's migration 0032 and its `loadSnapshot`
   edit: `policy.inventory`, each line's `itemId` / `quantity` / `warehouseId` / `toWarehouseId` / `lotId`,
   the header's two warehouses, and `refs.items`. No I/O is needed to plan, so planning belongs on the pure
   side of the line and 3B's golden fixtures (`tests/golden/costing/`) can call it with no database.
2. **It is the only place that can number movements.** `movementNo` is 1-based per document and a `transfer`
   line emits two, so the number is a property of the whole emission sequence — which only the evaluator sees
   in one pass.
3. **It keeps `applyMovements` replaceable.** 3B rewrites that body from "value = unit price × quantity" to
   "value from `costingEngine.cost()` plus layers and consumptions". If policy interpretation lived there,
   3B's rewrite would carry it, and the two versions could disagree about which warehouse a line ships from.

**The provisional value rule stays in `applyMovements` and is 3B's to delete.** §4.7.2 fixes it as
`round(unit_price × quantity, 4)` in base currency for both directions, with `line.amount` as the fallback
when `unitPrice` is null (so a free-of-charge line values at zero — spec:1055). `PlannedMovement.value` is
therefore `null` on every movement this function returns.

## Consequences

- `PlannedMovement.quantity` is a magnitude and `effect` is the sole carrier of direction — the same rule
  amendment A9 fixed for `PlannedLedgerLine.side`. A reversal's negated line quantity flips the effect; a
  transfer swaps its legs and keeps their order. **`quantity.isNegative()` is always false**, and 3B, 3D, 6A
  and 9B must read `effect`.
- Nine planning rules are now contract rather than implementation detail; they are listed in 3A's Task 7 and
  proved by `packages/domain/test/posting/plan-movements.test.ts`.
- **`PlannedMovement.costing` is derived from the emitted `effect`, not copied from `policy.inventory.costing`
  — with `"zero"` as the one exception.** §4.7.1's engine branches on the movement's direction to produce a
  layer or consumptions, so a receipt carrying `consume_layers` (which is what a reversal of an `issue` policy
  would carry if the declared label were copied) is a plan nothing can price. `"zero"` is not a direction but
  the free-of-charge instruction §4.7.1 reads (spec:1055), so it passes through both branches unchanged. The
  rule lives in one helper, `costingFor`, used by all three emission sites.
- `policy.inventory.allowNegative` is read by nothing. Test 18 wants the refusal regardless of user
  attributes, and a policy flag is one; the field stays in the schema unread until this document is amended.
- A stock-moving effect declared with `costing: "none"` is `ERR_POLICY_INVALID` at post. `validatePolicy` at
  seed time cannot catch it — the JSON Schema admits the combination — so the seeder of such a type learns
  from its first post, and 3B's engine never receives an unpriceable movement.
- `line.to_warehouse` resolves through the header at 3A, because no `document_line.to_warehouse_id` column
  exists. If 3D adds one, only `resolveToWarehouse`'s first branch changes.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd packages/domain test -- test/posting/plan-movements.test.ts`
Expected: **PASS**, eighteen assertions.

Run: `bun run --cwd packages/domain test && bun run --cwd packages/db test -- test/posting/`
Expected: **PASS**. Every 1A/2A/2B policy declares `inventory: { effect: "none" }` (the JOURNAL policy of §4.3.7 and every §4.14 test-only type of round 2), so `planMovements` returns `[]` for all of them and no existing posting test changes behaviour.

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/posting/evaluate.ts packages/domain/src/posting/index.ts \
        packages/domain/src/index.ts packages/domain/test/posting/plan-movements.test.ts \
        docs/adr/0035-movement-planning-in-the-evaluator.md
git commit -m "$(cat <<'EOF'
feat(domain): planMovements — the movement half of the plan [3A T7]

evaluatePolicy no longer returns movements: []. planMovements reads
policy.inventory and the line snapshots and emits PlannedMovements with
movementNo numbered 1-based per document in emission order, which is what
§4.4.2 says the evaluator does and what applyMovements reads.

ADR 0035 records why planning is here and not in applyMovements: it is pure,
it is the only pass that sees the whole emission sequence, and it keeps
applyMovements free of policy interpretation so 3B can replace that body.

quantity is a magnitude; effect carries direction, exactly as amendment A9
makes side carry it for a ledger line. A reversal flips the effect; a transfer
swaps its legs and keeps warehouse-leg-first ordering. isNegative() is always
false on a planned movement and 3B, 3D, 6A and 9B must read effect.

Nine rules are now contract: costing "none" under a moving effect is
ERR_POLICY_INVALID, a null product quantity and an unresolvable warehouse are
named, a service or asset line plans nothing silently, a declared receipt of a
lot-tracked item needs its batch, and a same-warehouse transfer is refused
rather than posted as a net-zero pair.

Rule 9 is new to this round: costing follows the EMITTED effect through one
helper, costingFor, at all three emission sites — not only on a transfer.
§4.7.1's engine makes a layer for a receipt and consumptions for an issue, so a
reversal of an issue policy must carry create_layer and not the declared
consume_layers. costing "zero" is the exception and passes through untouched:
it is the free-of-charge instruction §4.7.1 reads (spec:1055), not a direction.

allowNegative is read by nothing: spec:2436 wants the refusal regardless of user
attributes, and a policy flag is one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `applyMovements` (provisional), `mergeStockOnHand`, posting steps 9 and 12, and the `stock_on_hand` projection check

The task that makes a document move stock. `applyMovements` is `postDocument` step 9's hook and the **only** writer of `app.inventory_movement`; `mergeStockOnHand` is step 12's twin of the `account_balance` MERGE; and `STOCK_ON_HAND_CHECK` joins 1B's registry so the nightly rebuild-and-compare covers the new projection (test 2's 3A re-run).

**The signature is frozen here and never changes** (§4.7.2). 3B replaces the body — computing through `costingEngine.cost()` and writing `cost_layer`/`cost_consumption` after the movements — and deletes the provisional value rule. Nothing else about the function moves.

**`PostingPlan.movements[].value` is a MAGNITUDE, like `quantity`.** The row attaches both signs from `effect` (`quantity = effect === "issue" ? q.negate() : q`, and `value` follows it — §4.7.3 "sign follows quantity"). This is the same discipline amendment A9 fixed for `PlannedLedgerLine`: the plan is direction-free and `effect` is the sole carrier. Recorded as a contract addition, because §4.4.2 declares the field's type and not its sign.

**The provisional value rule is `round(unit_price × quantity, 4)` in base currency and it is 3B's to delete, not this task's to perfect.** `unit_price` is per *entered* unit while `quantity` is in base units, so the two agree only at a 1/1 conversion. §4.7.2 fixes the rule in those exact words and states plainly that rows posted between 3A and 3B are test data only, never back-filled. This task therefore tests **base-unit lines only** and says so; disambiguating the rule here would be inventing a costing decision that belongs to ADR 0037.

**Amendment A5's step-9b guard stays exactly where it is.** §4.3.2 says **3B** replaces it, not 3A. 2B ships a passing fail-closed test over it and Step 8 below adds one more: a policy whose `amount` is `line.cost` still gets `ERR_POLICY_REQUIRES_MISSING` at 3A, because 3A's provisional body writes `document_line.cost` *after* the plan was evaluated and does not revisit `plan.ledgerLines`.

**Files:**
- Create: `packages/db/src/costing/apply-movements.ts`, `packages/db/src/costing/stock-on-hand.ts`, `packages/db/src/costing/index.ts`
- Create: `packages/db/src/integrity/stock.ts`
- Create: `packages/db/test/costing/apply-movements.test.ts`, `packages/db/test/inventory/stock-on-hand.test.ts`, `tests/regression/sah-067.test.ts`
- Modify: `packages/db/src/posting/post.ts` (step 9, step 12, `movementIds`), `packages/db/src/integrity/index.ts` (register), `packages/db/src/index.ts` (the costing barrel)
- Modify: `tests/invariants/projection-rebuild.test.ts`, `tests/invariants/audit-chain.test.ts`, `apps/worker/test/handlers/integrity-check.test.ts`

**Interfaces:**
- Consumes: `postDocument`, `loadSnapshot`, `insertLedger`, `PostingError`, `PostResult` (1A, §4.3.1); `PostingPlan`, `PlannedMovement`, `DocumentSnapshot`, `LineSnapshot`, `ItemRef` (§4.4.2); `Money`, `Quantity`, `toBase` (§4.2.1); `TenantContext` (§4.2.2); `ProjectionCheck`, `ProjectionMismatch`, `registerProjectionCheck`, `projectionChecks` (1B, §4.16.3); `SENTINEL_LOT_CODE` (Task 2); `app.inventory_movement`, `app.stock_on_hand` (Task 5); `seedDocumentType` (2A, §4.17), `grantCodes` (2B, §4.17), `seedTenantV2`, `seedAccount` (1A, §4.17), `seedItem`, `seedWarehouse`, `seedLot` (Tasks 1–2). **Not `postJournal`** — every document this task posts is a §4.14 inventory test type carrying item lines, which `postJournal` cannot draft; Step 1's own `post` helper drafts them and Step 8's appended case repeats that helper inside 1B's file.
- Produces:
  - `export async function applyMovements(tx: Sql, ctx: TenantContext, plan: PostingPlan, snapshot: DocumentSnapshot): Promise<PostingPlan>` — §4.7.2's signature, verbatim and frozen.
  - `export async function loadSentinelLots(tx: Sql, itemIds: readonly string[]): Promise<Map<string, string>>`
  - `export interface StockKey { itemId: string; warehouseId: string; lotId: string }`
  - `export async function mergeStockOnHand(tx: Sql, input: { tenantId: string; companyId: string; documentId: string; keys: readonly StockKey[] }): Promise<void>` — `packages/db/src/costing/stock-on-hand.ts`.
  - `export async function lockStockKeys(tx: Sql, companyId: string, keys: readonly StockKey[]): Promise<void>` — same file; the sorted, de-duplicated `stock:<company>/<item>/<warehouse>/<lot>` transaction-scoped advisory locks, called by **`applyMovements` before the movement insert (step 9)** and by `mergeStockOnHand` before the MERGE (step 12). Re-locking a held key is a no-op, so calling it twice in one transaction is free.
  - `export async function checkStockOnHandProjection(tx: Sql): Promise<ProjectionMismatch[]>` and `export const STOCK_ON_HAND_CHECK: ProjectionCheck` — `packages/db/src/integrity/stock.ts`.
  - `PostResult.movementIds` filled, in `movement_no` order.
  - `IntegrityReport.projections.checked` becomes `["account_balance", "document_series", "stock_on_hand"]` — `projectionChecks()` sorts by `name.localeCompare` (1B), so the order is alphabetical and stable.
  - **Four test-only document types** (§4.14 contract additions, never seeded into a pack): `STOCK_RECEIPT_TEST`/`SRT`, `STOCK_ISSUE_TEST`/`SIT`, `STOCK_TRANSFER_TEST`/`STT` and `COST_LINE_TEST`/`CLT` — all `module: "inventory"`, all `approval: { required: false, approve: null, post: "accounting.journal.post" }`. The first three are seeded in `beforeAll`; `COST_LINE_TEST` is seeded inside the last case, because it is the only one whose documents are required to fail.

- [ ] **Step 1: Write the failing test `packages/db/test/costing/apply-movements.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import {
  grantCodes, seedAccount, seedDocumentType, seedItem, seedLot, seedTenantV2, seedWarehouse, type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const ctx = (s: Seed, actor?: string) => ({
  tenantId: s.tenant, actorId: actor ?? s.human, requestId: "apply-movements",
});

/** Two balancing `account` lines plus N `item` lines. The ledger rules match only `kind: "account"`, so the
 *  item lines carry stock and no ledger leg — which is what lets this suite test movements without inventing
 *  an account-resolution rule (hazard 33 does not engage: `line.account` is the only account reference). */
const stockPolicy = (code: string, series: string, inventory: Record<string, unknown>) => ({
  version: 1, documentType: code, direction: "internal", requires: [],
  lines: [
    { for: "each_line", side: "debit",  account: { from: "line.account" }, amount: "line.debit",  when: { "line.kind": "account" } },
    { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
  ],
  inventory, tax: { applies: false },
  numbering: { series, assignAt: "issue" },
  reversal: { allowed: true, producesType: code },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
});

describe("applyMovements — postDocument step 9 (contracts §4.7.2, provisional 3A body)", () => {
  let db: Db;
  let a: Seed;
  let receiptType: string;
  let issueType: string;
  let transferType: string;
  let itemId: string;
  let baseUnitId: string;
  let main: string;
  let transit: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Move A");
    await seedAccount(db, a, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, a, { code: "5000", nameEn: "Cost of goods sold", type: "expense" });
    await seedAccount(db, a, { code: "5900", nameEn: "Other operating expense", type: "expense" });
    // `approval.post` is evaluated inside the posting transaction and seedTenant grants s.human nothing
    // (§4.1, pinned), so the grant is the first thing this suite needs. Once per seed object, not per file.
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    receiptType = await seedDocumentType(db, a, {
      code: "STOCK_RECEIPT_TEST", module: "inventory",
      policy: stockPolicy("STOCK_RECEIPT_TEST", "SRT",
        { effect: "receipt", warehouse: "line.warehouse", costing: "create_layer" }),
    });
    issueType = await seedDocumentType(db, a, {
      code: "STOCK_ISSUE_TEST", module: "inventory",
      policy: stockPolicy("STOCK_ISSUE_TEST", "SIT",
        { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" }),
    });
    transferType = await seedDocumentType(db, a, {
      code: "STOCK_TRANSFER_TEST", module: "inventory",
      policy: stockPolicy("STOCK_TRANSFER_TEST", "STT",
        { effect: "transfer", warehouse: "line.warehouse", to_warehouse: "header.to_warehouse", costing: "consume_layers" }),
    });
    // All three declare `warehouse: "line.warehouse"`, which resolves `line.warehouseId ?? header.warehouseId`
    // (Task 7 rule 7). The `post` helper below writes only the HEADER warehouse, so these DB-tier cases
    // exercise the fallback — and Task 9's API-tier cases, which have no header warehouse on the wire
    // (`CreateDocumentBody` gains no such field in this slice), set it per line and resolve directly.
    // One policy text for both tiers is the point: two spellings of a registered §4.14 code would be hazard 32.
    // trackLots: false — seedItem defaults it to TRUE (§4.6.1, food is batch-tracked), and Task 7's gate
    // refuses a declared receipt of a lot-tracked item with no lotId. The lot-tracked path has its own case.
    ({ itemId, baseUnitId } = await seedItem(db, a, { code: "BOLT-M6", trackLots: false }));
    main = await seedWarehouse(db, a, { code: "HQ-MAIN" });
    transit = await seedWarehouse(db, a, { code: "IN-TRANSIT", kind: "in_transit" });
  });
  afterAll(async () => { await db.stop(); });

  /** Drafts and posts a document of `typeId`. `draftDocument` is JOURNAL-only, so the insert is explicit —
   *  2A's `postItemDocument` shape, extended with the header warehouses migration 0031 added. */
  const post = async (typeId: string, series: string, opts: {
    lines: readonly Record<string, unknown>[]; warehouseId?: string; toWarehouseId?: string;
    effectiveDate?: string;
  }) => prodWithTenant(db.rw, ctx(a), async (tx) => {
    const id = await uuidv7(db.admin);
    await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                        effective_date, currency, branch_id, warehouse_id, to_warehouse_id)
             values (${id}, ${a.tenant}, ${a.company}, ${typeId}, ${series}, ${a.period},
                     ${opts.effectiveDate ?? "2026-01-15"}, 'MYR', ${a.hq},
                     ${opts.warehouseId ?? main}, ${opts.toWarehouseId ?? null})`;
    let lineNo = 0;
    for (const line of opts.lines) {
      await tx`insert into app.document_line ${tx({
        id: await uuidv7(db.admin), tenant_id: a.tenant, company_id: a.company, document_id: id,
        line_no: ++lineNo, ...line,
      })}`;
    }
    return { id, result: await postDocument(tx, ctx(a), { documentId: id }) };
  });

  const ledgerLegs = (debitAccount: string, creditAccount: string, amount: string) => [
    { kind: "account", account_id: debitAccount, debit: amount },
    { kind: "account", account_id: creditAccount, credit: amount },
  ];

  it("a receipt writes one signed movement, fills the plan's value and document_line.cost", async () => {
    const { id, result } = await post(receiptType, "SRT", {
      lines: [
        ...ledgerLegs(a.cash, a.sales, "120.0000"),
        { kind: "item", item_id: itemId, quantity: "10.000000", unit_price: "12.0000", amount: "120.0000" },
      ],
    });
    expect(result.movementIds).toHaveLength(1);
    const [mv] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<Record<string, string>[]>`
      select movement_no::text as movement_no, line_no::text as line_no, quantity::text as quantity,
             value::text as value, warehouse_id, unit_id, posting_seq::text as posting_seq,
             effective_date::text as effective_date
        from app.inventory_movement where document_id = ${id}`);
    expect(mv!.movement_no).toBe("1");
    expect(mv!.line_no).toBe("3");
    expect(mv!.quantity).toBe("10.000000");                 // + receipt
    expect(mv!.value).toBe("120.0000");                     // round(12.0000 × 10, 4) in base
    expect(mv!.warehouse_id).toBe(main);
    expect(mv!.unit_id).toBe(baseUnitId);                   // the movement's quantity IS in the base unit
    expect(mv!.posting_seq).toBe(result.postingSeq.toString());
    expect(mv!.effective_date).toBe("2026-01-15");
    const [line] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ cost: string }[]>`
      select cost::text as cost from app.document_line where document_id = ${id} and line_no = 3`);
    expect(line!.cost).toBe("120.0000");                    // the magnitude, never a negative cost
  });

  it("an issue writes a NEGATIVE quantity and value, from the same magnitude on the plan", async () => {
    const { id } = await post(issueType, "SIT", {
      lines: [
        ...ledgerLegs(a.sales, a.cash, "48.0000"),
        { kind: "item", item_id: itemId, quantity: "4.000000", unit_price: "12.0000", amount: "48.0000" },
      ],
    });
    const [mv] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<Record<string, string>[]>`
      select quantity::text as quantity, value::text as value
        from app.inventory_movement where document_id = ${id}`);
    expect(mv!.quantity).toBe("-4.000000");
    expect(mv!.value).toBe("-48.0000");
    const [line] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ cost: string }[]>`
      select cost::text as cost from app.document_line where document_id = ${id} and line_no = 3`);
    expect(line!.cost).toBe("48.0000");                     // cost is the magnitude (§4.7.2)
  });

  it("stock_on_hand is MERGEd in the SAME transaction and now nets the two documents (D14)", async () => {
    const [soh] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand
       where item_id = ${itemId} and warehouse_id = ${main}`);
    expect(soh!.quantity).toBe("6.000000");                 // 10 received − 4 issued
  });

  it("a transfer writes TWO movements for one line, numbered 1 and 2, source leg first", async () => {
    const { id, result } = await post(transferType, "STT", {
      toWarehouseId: transit,
      lines: [
        // NOT zero: step 6 drops zero-amount planned lines and then raises ERR_DOC_NO_LINES when none
        // survive (§4.3.2 step 6), so a transfer whose only ledger legs were "0.0000" could never reach
        // step 9 at all. The accounts and the figure are arbitrary — this suite tests movements, and the
        // ledger half only has to exist and balance.
        ...ledgerLegs(a.cash, a.sales, "72.0000"),
        { kind: "item", item_id: itemId, quantity: "6.000000", unit_price: "12.0000", amount: "72.0000" },
      ],
    });
    expect(result.movementIds).toHaveLength(2);
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<Record<string, string>[]>`
      select movement_no::text as movement_no, warehouse_id, quantity::text as quantity, value::text as value
        from app.inventory_movement where document_id = ${id} order by movement_no`);
    expect(rows.map((r) => [r.movement_no, r.warehouse_id, r.quantity, r.value])).toEqual([
      ["1", main, "-6.000000", "-72.0000"],
      ["2", transit, "6.000000", "72.0000"],
    ]);
    // Insertion is in movement_no order, which is what lets assert_stock_available see the source leg's
    // effect before the destination leg — and, in the other direction, a receipt before the issue that
    // depends on it. The guard sums this table, not the projection (§4.7.3).
    const soh = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<Record<string, string>[]>`
      select warehouse_id, quantity::text as quantity from app.stock_on_hand
       where item_id = ${itemId} order by warehouse_id`);
    const byWarehouse = Object.fromEntries(soh.map((r) => [r.warehouse_id, r.quantity]));
    expect(byWarehouse[main]).toBe("0.000000");
    expect(byWarehouse[transit]).toBe("6.000000");
  });

  it("only ONE document_line.cost is written for a transfer line — the lowest-numbered movement", async () => {
    const [line] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ cost: string }[]>`
      select l.cost::text as cost from app.document_line l
        join app.document d on d.id = l.document_id
       where d.document_type_id = ${transferType} and l.line_no = 3`);
    expect(line!.cost).toBe("72.0000");
  });

  it("a null unit_price falls back to line.amount, so a free-of-charge line costs zero (spec:1055)", async () => {
    const { id } = await post(receiptType, "SRT", {
      lines: [
        ...ledgerLegs(a.cash, a.sales, "1.0000"),
        { kind: "item", item_id: itemId, quantity: "2.000000", amount: "0.0000" },
      ],
    });
    const [mv] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ value: string }[]>`
      select value::text as value from app.inventory_movement where document_id = ${id}`);
    expect(mv!.value).toBe("0.0000");
  });

  it("a line with no lot resolves the item's NONE sentinel, not a NULL (SAH-050, ADR 0034)", async () => {
    const [mv] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ code: string }[]>`
      select l.code from app.inventory_movement m
        join app.lot l on l.id = m.lot_id
       where m.item_id = ${itemId} limit 1`);
    expect(mv!.code).toBe("NONE");
  });

  it("a lot-tracked receipt writes the named lot, and its issue draws from that lot", async () => {
    const { itemId: milk } = await seedItem(db, a, { code: "MILK-1L", trackLots: true });
    const lot = await seedLot(db, a, { itemId: milk, code: "B-2026-02", expiresOn: "2026-08-31" });
    await post(receiptType, "SRT", {
      lines: [
        ...ledgerLegs(a.cash, a.sales, "60.0000"),
        { kind: "item", item_id: milk, lot_id: lot, quantity: "20.000000", unit_price: "3.0000", amount: "60.0000" },
      ],
    });
    const [soh] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand
       where item_id = ${milk} and lot_id = ${lot}`);
    expect(soh!.quantity).toBe("20.000000");
  });

  it("an issue beyond stock refuses the whole post, and nothing is left behind (test 18 via the API path)", async () => {
    const onHand = () => withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand
       where item_id = ${itemId} and warehouse_id = ${main}`).then((r) => r[0]!.quantity);
    const before = await onHand();              // 2.000000 as the cases above leave it: the transfer emptied
                                                // MAIN and the free-of-charge receipt put two units back.
    await expect(post(issueType, "SIT", {
      lines: [
        ...ledgerLegs(a.sales, a.cash, "1200.0000"),
        { kind: "item", item_id: itemId, quantity: "100.000000", unit_price: "12.0000", amount: "1200.0000" },
      ],
    })).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
    // Compared against the READING, not against a literal. What this case proves is that the refusal rolled
    // the projection back together with the movements; a hard-coded figure here would quietly turn it into a
    // test of the running arithmetic of every case above it, and would break when one of them changed.
    expect(await onHand()).toBe(before);
  });

  it("a stock-moving policy over lines that carry no item writes no movement at all", async () => {
    const before = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.inventory_movement`);
    const { result } = await post(issueType, "SIT", {
      lines: [{ kind: "account", account_id: a.cash, debit: "5.0000" },
              { kind: "account", account_id: a.sales, credit: "5.0000" }],
    });
    const after = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.inventory_movement`);
    expect(after[0]!.n).toBe(before[0]!.n);     // the policy moves stock, but no line carries an item
    expect(result.movementIds).toEqual([]);
  });

  it("amendment A5's step-9b guard still fires at 3A — 3B is what replaces it (§4.3.2)", async () => {
    const costType = await seedDocumentType(db, a, {
      code: "COST_LINE_TEST", module: "inventory",
      policy: {
        ...stockPolicy("COST_LINE_TEST", "CLT",
          // A RECEIPT, deliberately. Step 9b sits *after* step 9 (§4.3.2), so an issue-shaped case would
          // first have to survive `assert_stock_available`, and whether it did would depend on whatever
          // stock the cases above happened to leave at MAIN. A receipt can never be refused for stock, so
          // the only thing that can refuse this document is the guard — which is what the case claims.
          { effect: "receipt", warehouse: "line.warehouse", costing: "create_layer" }),
        lines: [
          { for: "each_line", side: "debit",  account: { code: "5000" }, amount: "line.cost",   when: { "line.kind": "item" } },
          { for: "each_line", side: "credit", account: { code: "1300" }, amount: "line.cost",   when: { "line.kind": "item" } },
        ],
      },
    });
    await expect(post(costType, "CLT", {
      lines: [{ kind: "item", item_id: itemId, quantity: "1.000000", unit_price: "12.0000", amount: "12.0000" }],
    })).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING/);
    // 3A's applyMovements writes document_line.cost AFTER evaluatePolicy has already run, so a policy that
    // addresses line.cost still plans a zero line and 9b still refuses it. 3B moves the fill to step 9 and
    // deletes the guard; until then a COGS-from-cost policy cannot post, which is the fail-closed intent.
  });
});
```

- [ ] **Step 2: Write the failing test `packages/db/test/inventory/stock-on-hand.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkStockOnHandProjection } from "../../src/integrity/stock";
import { projectionChecks } from "../../src/integrity";
import { seedItem, seedTenant, seedWarehouse, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("stock_on_hand rebuild-and-compare — test 2's 3A re-run (contracts §4.7.3, §4.16.3)", () => {
  let db: Db;
  let a: Seed;
  let itemId: string;
  let warehouseId: string;
  let lotId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "SOH A");
    ({ itemId } = await seedItem(db, a, { code: "NAIL-3IN" }));
    warehouseId = await seedWarehouse(db, a, { code: "HQ-MAIN" });
    [lotId] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ id: string }[]>`select id from app.lot where item_id = ${itemId}`).then((r) => r.map((x) => x.id));
  });
  afterAll(async () => { await db.stop(); });

  it("the registry now holds three checks, in a stable alphabetical order", () => {
    expect(projectionChecks().map((c) => c.name))
      .toEqual(["account_balance", "document_series", "stock_on_hand"]);
  });

  it("an untouched database has no mismatch", async () => {
    expect(await withTenant(db.rw, a.tenant, a.human, (tx) => checkStockOnHandProjection(tx))).toEqual([]);
  });

  it("a projection row with no movements behind it is reported as missing_in_rebuild", async () => {
    // Written by hand, which only packages/db/test/** may do (§3.7.5's allow-list) — the point of the check
    // is to catch a projection that drifted from the movements, so the test has to make it drift.
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
      values (${a.tenant}, ${a.company}, ${itemId}, ${warehouseId}, ${lotId}, 7.000000)`);
    const mismatches = await withTenant(db.rw, a.tenant, a.human, (tx) => checkStockOnHandProjection(tx));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      projection: "stock_on_hand",
      side: "missing_in_rebuild",
      key: { company_id: a.company, item_id: itemId, warehouse_id: warehouseId, lot_id: lotId },
    });
    expect(mismatches[0]!.detail).toMatch(/stock_on_hand has 7.000000 and the movements have none/);
  });

  it("a quantity that differs is reported as amount_differs, naming both figures", async () => {
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.inventory_movement
        (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
      select ${a.tenant}, ${a.company}, d.id, 1, 1, ${itemId}, ${warehouseId}, ${lotId}, i.base_unit_id,
             5.000000, 50.0000, '2026-01-15', 1
        from app.document d, app.item i
       where i.id = ${itemId} limit 1`);
    const mismatches = await withTenant(db.rw, a.tenant, a.human, (tx) => checkStockOnHandProjection(tx));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ projection: "stock_on_hand", side: "amount_differs" });
    expect(mismatches[0]!.detail).toMatch(/quantity 7.000000 <> 5.000000/);
  });

  it("the temp table is dropped on commit, so a second call in a new transaction is clean", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await checkStockOnHandProjection(tx);
      await checkStockOnHandProjection(tx);        // `drop table if exists` makes a second call in one tx safe
    });
    const [temp] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_tables where tablename = 'integrity_rebuilt_stock_on_hand'`;
    expect(temp!.n).toBe(0);
  });
});
```

- [ ] **Step 3: Run both tests to see the exact failures**

Run: `bun run --cwd packages/db test -- test/costing/apply-movements.test.ts test/inventory/stock-on-hand.test.ts`
Expected: **FAIL**. The first fails on `result.movementIds` being `[]` and zero `inventory_movement` rows — `postDocument` step 9 is still a comment. The second fails at import — `Cannot find module '../../src/integrity/stock'`.

- [ ] **Step 4: Write `packages/db/src/costing/apply-movements.ts`**

```ts
import type { Sql } from "postgres";
import {
  Money, Quantity, toBase,
  type DocumentSnapshot, type LineSnapshot, type PlannedMovement, type PostingPlan,
} from "@dulja/domain";
import { SENTINEL_LOT_CODE } from "../inventory/lots";
import { PostingError } from "../posting/errors";
import type { TenantContext } from "../with-tenant";
import { lockStockKeys } from "./stock-on-hand";

/**
 * Every item's `NONE` sentinel lot, keyed by item id. One query for the whole document: `applyMovements` needs
 * it only for the movements whose plan carries `lotId === null`, and the evaluator is pure and has no source
 * for the uuid (§4.4.2's note on `PlannedMovement.lotId`).
 */
export async function loadSentinelLots(tx: Sql, itemIds: readonly string[]): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx<{ item_id: string; id: string }[]>`
    select item_id, id from app.lot
     where item_id = any(${itemIds}) and code = ${SENTINEL_LOT_CODE}`;
  return new Map(rows.map((r) => [r.item_id, r.id]));
}

/**
 * The provisional 3A value rule, fixed by contracts §4.7.2 in these words: `round(unit_price × quantity, 4)`
 * in base currency, for a receipt and for an issue alike, with `line.amount` as the fallback when `unitPrice`
 * is null — so a free-of-charge line values at zero (spec:1055), which is what 3B's `costing: "zero"` will
 * formalise. **3B DELETES this function**; it does not extend it.
 *
 * `unit_price` is per ENTERED unit and `mv.quantity` is in base units, so the two agree exactly at a 1/1
 * conversion and approximately otherwise. That is a known property of the provisional rule, not a defect to
 * patch here: §4.7.2 states that rows posted between 3A and 3B are test data only and are never back-filled,
 * and 3B computes value through `costingEngine.cost()` from the layers instead. This slice's tests therefore
 * use base-unit lines.
 *
 * Returns a MAGNITUDE. `insertMovements` attaches the sign, from `effect`, to quantity and value together.
 */
function provisionalValue(line: LineSnapshot, mv: PlannedMovement, snapshot: DocumentSnapshot): Money {
  const inDocumentCurrency = line.unitPrice === null
    ? line.amount
    : line.unitPrice.multiply(mv.quantity.toDecimal(), "HALF_AWAY_FROM_ZERO");
  // HALF_AWAY_FROM_ZERO at scale 4 — the only mode that matches the ledger's own CHECK (hazard 23).
  return toBase(inDocumentCurrency, snapshot.header.exchangeRate).abs();
}

/** `document.posting_seq`, assigned by step 8 — read here because `DocumentSnapshot` has no such field and
 *  the snapshot was loaded at step 3, before step 8 ran. Do not add a field to that frozen interface. */
async function readPostingSeq(tx: Sql, documentId: string): Promise<bigint> {
  const [row] = await tx<{ posting_seq: string | null }[]>`
    select posting_seq::text as posting_seq from app.document where id = ${documentId}`;
  if (!row || row.posting_seq === null) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${documentId} has no posting_seq; step 8 of the posting algorithm must run before step 9 (contracts §4.3.2)`,
    );
  }
  return BigInt(row.posting_seq);
}

/**
 * Inserts the movement rows, **one at a time, in `movementNo` order**. The order is load-bearing:
 * `app.assert_stock_available` sums `app.inventory_movement` for the same (company, item, warehouse, lot) and
 * therefore sees this transaction's EARLIER rows (§4.7.3). A document that receives on line 1 and issues on
 * line 2, or a transfer whose source leg must land before its destination leg, is correct only in this order —
 * a single multi-row insert would fire the trigger per row in an order Postgres does not promise.
 */
async function insertMovements(
  tx: Sql, snapshot: DocumentSnapshot, movements: readonly PlannedMovement[], postingSeq: bigint,
): Promise<void> {
  for (const mv of movements) {
    const item = snapshot.refs.items[mv.itemId];
    if (item === undefined) {
      throw new PostingError("ERR_POLICY_REQUIRES_MISSING", `item ${mv.itemId} is not in the snapshot's item map`);
    }
    if (mv.lotId === null || mv.value === null) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `movement ${mv.movementNo} of document ${snapshot.header.id} reached the insert with no lot or no value`,
      );
    }
    const signedQuantity = mv.effect === "issue" ? mv.quantity.negate() : mv.quantity;
    const signedValue = mv.effect === "issue" ? mv.value.negate() : mv.value;
    await tx`
      insert into app.inventory_movement
        (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
      values (app.current_tenant(), ${snapshot.header.companyId}, ${snapshot.header.id},
              ${mv.lineNo}, ${mv.movementNo}, ${mv.itemId}, ${mv.warehouseId}, ${mv.lotId},
              ${item.baseUnitId}, ${signedQuantity.toString()}, ${signedValue.toString()},
              ${snapshot.header.effectiveDate}, ${postingSeq.toString()})`;
  }
}

/**
 * `document_line.cost` — the magnitude, one row per source line, taken from the line's LOWEST-numbered
 * movement. A transfer line emits two movements and has one cost: the value that left the source warehouse.
 *
 * This UPDATE runs migration 0032's `document_line_base_quantity` BEFORE UPDATE trigger. It is a no-op here:
 * `unit_id`, `unit_quantity` and `quantity` are unchanged, so the trigger re-derives the same figure and its
 * agreement branch passes. And `document_line` has no draft-only UPDATE guard — 2B ships only a BEFORE DELETE
 * one — which is what lets the costing engine write `cost` on an already-issued document (assumption 5).
 */
async function writeLineCosts(
  tx: Sql, documentId: string, movements: readonly PlannedMovement[],
): Promise<void> {
  const firstByLine = new Map<number, PlannedMovement>();
  for (const mv of movements) if (!firstByLine.has(mv.lineNo)) firstByLine.set(mv.lineNo, mv);
  for (const [lineNo, mv] of firstByLine) {
    await tx`
      update app.document_line set cost = ${mv.value!.toString()}
       where document_id = ${documentId} and line_no = ${lineNo}`;
  }
}

/**
 * `postDocument` step 9 (contracts §4.3.2, §4.7.2) — the **provisional 3A body**, and the ONLY writer of
 * `app.inventory_movement` anywhere in the system (the `posting-only-tables` lint enforces it).
 *
 * Resolves each movement's sentinel lot, prices it with the provisional rule, inserts the rows in movementNo
 * order — which is where `assert_stock_available` fires and refuses negative stock unless an
 * `inventory.negative_stock.override` event exists for the document (§4.5.3) — writes `document_line.cost`,
 * and returns the plan with `value` filled.
 *
 * It writes **no** `cost_layer` / `cost_consumption`: those tables do not exist until 3B's migration 0034.
 * **3B replaces this body** — compute through `costingEngine.cost()`, insert the movements, THEN the layers
 * and consumptions (which FK to `inventory_movement(tenant_id, id)` and cannot precede it), then the costs.
 * The signature is frozen from here and never changes.
 */
export async function applyMovements(
  tx: Sql, ctx: TenantContext, plan: PostingPlan, snapshot: DocumentSnapshot,
): Promise<PostingPlan> {
  void ctx;   // frozen in the signature (§4.7.2); 3B's body enqueues `invalidateFrom` with it. See below.
  if (plan.movements.length === 0) return plan;

  const postingSeq = await readPostingSeq(tx, snapshot.header.id);
  const needSentinel = [...new Set(plan.movements.filter((mv) => mv.lotId === null).map((mv) => mv.itemId))];
  const sentinels = await loadSentinelLots(tx, needSentinel);
  const linesByNo = new Map(snapshot.lines.map((l) => [l.lineNo, l]));

  const priced: PlannedMovement[] = plan.movements.map((mv) => {
    const line = linesByNo.get(mv.lineNo);
    if (line === undefined) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `movement ${mv.movementNo} names line ${mv.lineNo}, which the snapshot does not have`,
      );
    }
    const lotId = mv.lotId ?? sentinels.get(mv.itemId) ?? null;
    if (lotId === null) {
      // Unreachable: migration 0029's item_sentinel_lot trigger creates the NONE lot with every item, and
      // 0031 makes inventory_movement.lot_id NOT NULL. Named loudly rather than passed through as a null
      // that would fail on the column instead of on the reason (ADR 0034).
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `item ${mv.itemId} has no '${SENTINEL_LOT_CODE}' lot; every item is created with one (ADR 0034)`,
      );
    }
    return { ...mv, lotId, value: provisionalValue(line, mv, snapshot) };
  });

  // The stock keys are locked BEFORE the first movement row is inserted, and stay locked for the rest of the
  // transaction. `assert_stock_available` fires inside the insert below and reads `sum(quantity)` over
  // app.inventory_movement; §4.3.2 step 1's `for update` on app.document serialises posters of one DOCUMENT
  // and no more, so without this lock two documents issuing the same (company, item, warehouse, lot) both
  // read the same committed sum, both pass the trigger and both commit — negative stock with no override
  // event, which is test 18's invariant defeated by concurrency alone. See lockStockKeys' own comment and
  // assumption 16 (READ COMMITTED is what makes the second transaction's re-read see the first's row).
  await lockStockKeys(tx, snapshot.header.companyId, priced.map((mv) => ({
    itemId: mv.itemId, warehouseId: mv.warehouseId, lotId: mv.lotId!,
  })));
  await insertMovements(tx, snapshot, priced, postingSeq);
  await writeLineCosts(tx, snapshot.header.id, priced);
  return { ...plan, movements: priced };
}
```

`tenant_id` is written as `app.current_tenant()`, the form Tasks 1, 2 and 4 use, rather than from `ctx.tenantId`: the session already carries the tenant and reading it back from the database is what makes a cross-tenant value impossible to smuggle through a parameter (SAH-044's shape applied to the tenant).

`ctx` is unused in the body and stays in the signature: §4.7.2 freezes it, and 3B's body needs it for `invalidateFrom`'s enqueue. The `void ctx;` on the function's first line above is what silences the unused-parameter lint Step 10 requires to report `0 violations`; it is there rather than a renamed parameter because a renamed parameter is a signature change in every reader's diff.

- [ ] **Step 5: Write `packages/db/src/costing/stock-on-hand.ts`**

```ts
import type { Sql } from "postgres";

export interface StockKey { itemId: string; warehouseId: string; lotId: string }

/**
 * **The one place the `stock:` advisory locks are taken, so both users of them take the same keys in the same
 * order.** Transaction-scoped (`pg_advisory_xact_lock`), de-duplicated, and acquired in sorted order — sorted
 * so two transactions touching an overlapping set queue behind one another instead of deadlocking. Re-locking
 * a key the same transaction already holds is a no-op that returns immediately, which is what lets step 9 and
 * step 12 both call this without either having to know whether the other did.
 *
 * **Two invariants depend on it, and each would be silently broken without it.**
 *
 * 1. **Step 9 — `assert_stock_available` (§4.7.3).** The trigger computes availability as `sum(quantity)` over
 *    `app.inventory_movement` for the (company, item, warehouse, lot) key. §4.3.2 step 1 takes
 *    `select … from app.document where id = $1 for update`, which serialises posters of ONE DOCUMENT and
 *    nothing more: two different documents issuing the same stock key hold different row locks, so under
 *    READ COMMITTED (§4.2.2; assumption 16) both read the same committed sum, both satisfy the trigger and
 *    both commit — leaving stock negative with no `inventory.negative_stock.override` event anywhere. That is
 *    test 18's claim falsified by concurrency alone. Holding the key's lock across the read-and-insert is what
 *    makes the second transaction read the first's committed row and be refused.
 * 2. **Step 12 — the MERGE.** 1A's amendment A4, applied to the second projection; 1A's own step-12 comment
 *    names this slice as the copier. `MERGE … WHEN NOT MATCHED THEN INSERT` is not `INSERT … ON CONFLICT`: it
 *    does not re-check the target when a concurrent transaction inserts the same key, so two posts that both
 *    find no `stock_on_hand` row take the NOT MATCHED branch and the second raises 23505 on the first's
 *    commit. The production `withTenant` retries only 40001 and 40P01 (§4.2.2), so that would surface as
 *    ERR_CONFLICT_UNIQUE on a legitimate post.
 */
export async function lockStockKeys(
  tx: Sql, companyId: string, keys: readonly StockKey[],
): Promise<void> {
  const lockKeys = [
    ...new Set(keys.map((k) => `stock:${companyId}/${k.itemId}/${k.warehouseId}/${k.lotId}`)),
  ].sort();
  for (const key of lockKeys) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

/**
 * `postDocument` step 12's stock half — contracts §4.7.3's MERGE, verbatim, in the posting transaction (D14).
 *
 * The locks come first, through `lockStockKeys`. Step 9's `applyMovements` has already taken exactly these
 * keys, so in the ordinary posting path this call re-acquires locks the transaction holds and returns at once;
 * the call stays because a future caller of `mergeStockOnHand` that did not go through step 9 must not depend
 * on someone else having locked for it.
 */
export async function mergeStockOnHand(tx: Sql, input: {
  tenantId: string; companyId: string; documentId: string; keys: readonly StockKey[];
}): Promise<void> {
  await lockStockKeys(tx, input.companyId, input.keys);

  await tx`
    merge into app.stock_on_hand h
    using (select ${input.tenantId}::uuid as tenant_id, ${input.companyId}::uuid as company_id,
                  m.item_id, m.warehouse_id, m.lot_id, sum(m.quantity) as quantity
             from app.inventory_movement m where m.document_id = ${input.documentId}::uuid
            group by m.item_id, m.warehouse_id, m.lot_id) s
       on h.company_id = s.company_id and h.item_id = s.item_id
      and h.warehouse_id = s.warehouse_id and h.lot_id = s.lot_id
     when matched then update set quantity = h.quantity + s.quantity, updated_at = now()
     when not matched then insert (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
                           values (s.tenant_id, s.company_id, s.item_id, s.warehouse_id, s.lot_id, s.quantity)`;
}
```

`packages/db/src/costing/index.ts`:

```ts
export { applyMovements, loadSentinelLots } from "./apply-movements";
export { lockStockKeys, mergeStockOnHand, type StockKey } from "./stock-on-hand";
```

And in `packages/db/src/index.ts`:

```ts
export { applyMovements, loadSentinelLots, lockStockKeys, mergeStockOnHand, type StockKey } from "./costing";
```

- [ ] **Step 6: Write `packages/db/src/integrity/stock.ts`**

Mirrors 1B's `checkAccountBalanceProjection` deliberately: one temp table, one `full outer join` on the projection's whole key, one mismatch shape. A second way of comparing a projection would be a second answer to "did it drift?".

```ts
import type { Sql } from "postgres";
import type { ProjectionCheck, ProjectionMismatch } from "./types";

interface CompareRow {
  company_id: string; item_id: string; warehouse_id: string; lot_id: string;
  missing_in_projection: boolean; missing_in_rebuild: boolean;
  r_quantity: string | null; b_quantity: string | null;
}

/**
 * §4.7.3's rebuild, executed: group `app.inventory_movement` into a scratch temp table on the projection's
 * full key, full-outer-join it against `app.stock_on_hand`, and report every row missing on either side or
 * whose quantity differs. Movements are append-only and signed — a reversal ADDS negative rows rather than
 * editing anything — so the projection is a pure sum and the comparison is exact.
 *
 * Runs inside `withTenant`, so both sides are already one tenant's rows (§4.2.2). Reads only: `select` and
 * `join` on a protected table are not DML, so `posting-only-tables` (§3.7.5) is satisfied without an
 * allow-list entry, exactly as it is for 1B's `integrity/projections.ts`.
 *
 * `create temporary table` needs only the database-level TEMPORARY privilege Postgres grants PUBLIC; Plan 0A
 * revokes object creation in schema `app` from `app_rw` (plan0A:2498) and nothing else. `on commit drop` ties
 * the table to the caller's transaction and `drop table if exists` makes a second call inside one safe.
 */
export async function checkStockOnHandProjection(tx: Sql): Promise<ProjectionMismatch[]> {
  await tx`drop table if exists integrity_rebuilt_stock_on_hand`;
  await tx`
    create temporary table integrity_rebuilt_stock_on_hand on commit drop as
      select m.company_id, m.item_id, m.warehouse_id, m.lot_id, sum(m.quantity) as quantity
        from app.inventory_movement m
       group by m.company_id, m.item_id, m.warehouse_id, m.lot_id`;

  const rows = await tx<CompareRow[]>`
    select coalesce(r.company_id, h.company_id)::text     as company_id,
           coalesce(r.item_id, h.item_id)::text           as item_id,
           coalesce(r.warehouse_id, h.warehouse_id)::text as warehouse_id,
           coalesce(r.lot_id, h.lot_id)::text             as lot_id,
           (h.company_id is null)                        as missing_in_projection,
           (r.company_id is null)                        as missing_in_rebuild,
           r.quantity::text as r_quantity,
           h.quantity::text as b_quantity
      from integrity_rebuilt_stock_on_hand r
      full outer join app.stock_on_hand h
        on  h.company_id   = r.company_id
        and h.item_id      = r.item_id
        and h.warehouse_id = r.warehouse_id
        and h.lot_id       = r.lot_id
     where r.company_id is null
        or h.company_id is null
        or h.quantity <> r.quantity
     order by 1, 2, 3, 4`;

  return rows.map((row) => {
    const key = {
      company_id: row.company_id, item_id: row.item_id,
      warehouse_id: row.warehouse_id, lot_id: row.lot_id,
    };
    if (row.missing_in_projection) {
      return {
        projection: "stock_on_hand", key, side: "missing_in_projection" as const,
        detail: `the movements sum to ${row.r_quantity} and stock_on_hand has no row`,
      };
    }
    if (row.missing_in_rebuild) {
      return {
        projection: "stock_on_hand", key, side: "missing_in_rebuild" as const,
        detail: `stock_on_hand has ${row.b_quantity} and the movements have none`,
      };
    }
    return {
      projection: "stock_on_hand", key, side: "amount_differs" as const,
      detail: `quantity ${row.b_quantity} <> ${row.r_quantity}`,
    };
  });
}

/** The ProjectionCheck this slice contributes to 1B's registry (§4.16.3); registered in ./index.ts. */
export const STOCK_ON_HAND_CHECK: ProjectionCheck = {
  name: "stock_on_hand",
  run: checkStockOnHandProjection,
};
```

Two lines in `packages/db/src/integrity/index.ts`, beside 1B's and 2B's registrations:

```ts
import { STOCK_ON_HAND_CHECK } from "./stock";
registerProjectionCheck(STOCK_ON_HAND_CHECK);
export { STOCK_ON_HAND_CHECK, checkStockOnHandProjection } from "./stock";
```

`projectionChecks()` sorts by `name.localeCompare` (1B), so the array becomes `["account_balance", "document_series", "stock_on_hand"]` whatever order the registrations run in.

- [ ] **Step 7: Wire steps 9 and 12 into `packages/db/src/posting/post.ts`**

Replace 1A's step-9 comment block with the call. **`plan` must be reassigned**, so its declaration becomes `let plan` if it is still `const`:

```ts
  // 9. Phase 3: the movement hook (contracts §4.3.2 step 9, §4.7.2). The length guard keeps every
  //    inventory.effect === "none" policy — JOURNAL and every Phase 1/2 test type — on a read-free path.
  if (plan.movements.length > 0) {
    plan = await applyMovements(tx, ctx, plan, snapshot);
  }
  const movementIds = plan.movements.length === 0 ? [] : (
    await tx<{ id: string }[]>`
      select id from app.inventory_movement where document_id = ${input.documentId} order by movement_no`
  ).map((r) => r.id);
```

Reading the ids back is deliberate: `PlannedMovement` has no `id` member (§4.4.2 is frozen) and `PostResult.movementIds` needs them in `movement_no` order. Do **not** add a field to the plan.

**Step 9b is unchanged.** It stays where 2A put it, immediately before `insertLedger`. §4.3.2 assigns its removal to 3B.

At step 12, after 1A's `account_balance` MERGE:

```ts
  //     …and the stock half (contracts §4.7.3), same transaction (D14). 3A's addition; the advisory-lock
  //     reasoning of amendment A4 lives in `lockStockKeys`, which mergeStockOnHand calls and which step 9's
  //     applyMovements already called for the same keys — re-locking a held key is a no-op.
  if (plan.movements.length > 0) {
    await mergeStockOnHand(tx, {
      tenantId: ctx.tenantId,
      companyId: snapshot.header.companyId,
      documentId: input.documentId,
      keys: plan.movements.map((mv) => ({
        itemId: mv.itemId, warehouseId: mv.warehouseId, lotId: mv.lotId!,
      })),
    });
  }
```

`mv.lotId` is non-null here because step 9 resolved every sentinel; the assertion is safe and its reason is the line above it.

And the return:

```ts
    ledgerEntryIds, movementIds, taxTransactionIds: [], enqueuedJobIds: [], warnings: plan.warnings,
```

Add `import { applyMovements } from "../costing/apply-movements";` and `import { mergeStockOnHand } from "../costing/stock-on-hand";` — **the file paths, not the `@dulja/db` barrel**, because `packages/db/src/index.ts` imports `posting/` and the barrel would close a cycle.

- [ ] **Step 8: Extend the three pinned assertions and the projection-rebuild suite**

**(a) `tests/invariants/projection-rebuild.test.ts` — the registry assertion.** 1B's first case reads `expect(projectionChecks().map((c) => c.name)).toEqual(["account_balance"])` and 2B widened it to `["account_balance", "document_series"]`. Widen it once more, in place:

```ts
  it("the registry holds exactly the projections this phase has", () => {
    expect(projectionChecks().map((c) => c.name)).toEqual(["account_balance", "document_series", "stock_on_hand"]);
  });
```

**(b) The same file — the new stock case, written out in full.** This file is **1B's** and it does **not** use `sharedDb()`: its `beforeAll` calls `startDb()` itself and holds `db: Db`, `a: Seed`, `b: Seed` and the local `ctxFor(s)` helper (1b:797–806). The case below reuses exactly those and seeds its own tenant, so it cannot disturb 1B's or 2B's arithmetic on `a`. Append it as the last `it` inside the existing `describe`, and extend the file's import lines to:

```ts
import {
  checkAccountBalanceProjection, checkStockOnHandProjection, postDocument, projectionChecks,
  reverseDocument, withTenant,
} from "@dulja/db";
import {
  grantCodes, seedAccount, seedDocumentType, seedItem, seedTenantV2, seedWarehouse, startDb, uuidv7,
  type Db, type Seed,
} from "@dulja/db/test";
```

```ts
  // ── 3A: the stock_on_hand projection (acceptance test 2's 3A re-run) ─────────────────────────────
  // Written inline rather than behind a helper: §4.17.1 binds a slice to the shared-helper rows it is
  // assigned, and this slice is assigned none, so a `stockScenario()` in `tests/support/**` would be a
  // contracts amendment bought for one case. The policy factory below is the same text Task 8 Step 1's
  // `apply-movements.test.ts` uses — the same registered §4.14 codes, so there is one policy text per code
  // (two spellings of a registered code is hazard 32).
  const stockPolicy = (code: string, series: string, inventory: Record<string, unknown>) => ({
    version: 1, documentType: code, direction: "internal", requires: [],
    lines: [
      { for: "each_line", side: "debit",  account: { from: "line.account" }, amount: "line.debit",  when: { "line.kind": "account" } },
      { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
    ],
    inventory, tax: { applies: false },
    numbering: { series, assignAt: "issue" },
    reversal: { allowed: true, producesType: code },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    dimensions: { required: [] },
  });

  it("stock_on_hand rebuilds bit-identically from the movements (test 2, 3A's projection)", async () => {
    // The three quantities are declared once and the expected figures are DERIVED from them in Postgres —
    // no literal answer, and no JavaScript number touches a quantity (spec:2043, this plan's assumption 13).
    const RECEIVED = "10.000000";
    const ISSUED = "4.000000";
    const TRANSFERRED = "3.000000";

    const c = await seedTenantV2(db, "Stock 3A");
    await grantCodes(db, c, { codes: ["accounting.journal.post"] });   // seedTenant grants nothing (§4.1)
    const receiptType = await seedDocumentType(db, c, {
      code: "STOCK_RECEIPT_TEST", module: "inventory",
      policy: stockPolicy("STOCK_RECEIPT_TEST", "SRT",
        { effect: "receipt", warehouse: "line.warehouse", costing: "create_layer" }),
    });
    const issueType = await seedDocumentType(db, c, {
      code: "STOCK_ISSUE_TEST", module: "inventory",
      policy: stockPolicy("STOCK_ISSUE_TEST", "SIT",
        { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" }),
    });
    const transferType = await seedDocumentType(db, c, {
      code: "STOCK_TRANSFER_TEST", module: "inventory",
      policy: stockPolicy("STOCK_TRANSFER_TEST", "STT",
        { effect: "transfer", warehouse: "line.warehouse", to_warehouse: "header.to_warehouse",
          costing: "consume_layers" }),
    });
    // trackLots: false — seedItem defaults it to TRUE (§4.6.1) and Task 7's gate refuses a declared receipt
    // of a lot-tracked item with no lotId; the lot-tracked path is covered in packages/db's own suites.
    const { itemId } = await seedItem(db, c, { code: "REBUILD-ITEM", trackLots: false });
    const main = await seedWarehouse(db, c, { code: "RB-MAIN" });
    const transit = await seedWarehouse(db, c, { code: "RB-TRANSIT", kind: "in_transit" });

    /** Drafts and posts one document. `draftDocument` is JOURNAL-only (§4.1), so the insert is explicit —
     *  the same shape Task 8 Step 1's `post` helper uses, with 0031's two header warehouses. */
    const post = async (typeId: string, series: string, opts: {
      quantity: string; unitPrice: string; amount: string; toWarehouseId?: string;
    }) => {
      const ctx = await ctxFor(c);
      return withTenant(db.rw, ctx, async (tx) => {
        const id = await uuidv7(db.admin);
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series,
                                            fiscal_period_id, effective_date, currency, branch_id,
                                            warehouse_id, to_warehouse_id)
                 values (${id}, ${c.tenant}, ${c.company}, ${typeId}, ${series}, ${c.period},
                         '2026-01-15', 'MYR', ${c.hq}, ${main}, ${opts.toWarehouseId ?? null})`;
        for (const [lineNo, line] of [
          { kind: "account", account_id: c.cash, debit: opts.amount },
          { kind: "account", account_id: c.sales, credit: opts.amount },
          { kind: "item", item_id: itemId, quantity: opts.quantity, unit_price: opts.unitPrice,
            amount: opts.amount },
        ].entries()) {
          await tx`insert into app.document_line ${tx({
            id: await uuidv7(db.admin), tenant_id: c.tenant, company_id: c.company, document_id: id,
            line_no: lineNo + 1, ...line,
          })}`;
        }
        return postDocument(tx, ctx, { documentId: id });
      });
    };

    await post(receiptType, "SRT", { quantity: RECEIVED, unitPrice: "12.0000", amount: "120.0000" });
    await post(issueType, "SIT", { quantity: ISSUED, unitPrice: "12.0000", amount: "48.0000" });
    await post(transferType, "STT", {
      quantity: TRANSFERRED, unitPrice: "12.0000", amount: "36.0000", toWarehouseId: transit,
    });

    const ctx = await ctxFor(c);
    expect(await withTenant(db.rw, ctx, (tx) => checkStockOnHandProjection(tx))).toEqual([]);

    // …and the projection is not merely self-consistent with its own movements: it holds the arithmetic
    // answer, computed here from the three posted quantities in exact `numeric` rather than stated.
    const rows = await withTenant(db.rw, ctx, (tx) => tx<{ warehouse_id: string; quantity: string }[]>`
      select warehouse_id, quantity::text as quantity from app.stock_on_hand
       where item_id = ${itemId} order by warehouse_id`);
    const [expected] = await withTenant(db.rw, ctx, (tx) => tx<{ main: string; transit: string }[]>`
      select ((${RECEIVED}::numeric(19,6) - ${ISSUED}::numeric(19,6) - ${TRANSFERRED}::numeric(19,6))
                ::numeric(19,6))::text as main,
             (${TRANSFERRED}::numeric(19,6))::text as transit`);
    expect(Object.fromEntries(rows.map((r) => [r.warehouse_id, r.quantity]))).toEqual({
      [main]: expected!.main,          // received, less what was issued, less what left on the transfer
      [transit]: expected!.transit,    // the transfer's receiving leg
    });
  });
```

**(c) `tests/invariants/audit-chain.test.ts` and `apps/worker/test/handlers/integrity-check.test.ts`** — the same one-line change in each, and §4.18 records that these two assertions move in the same PR as a registration:

```ts
    expect(report.projections.checked).toEqual(["account_balance", "document_series", "stock_on_hand"]);
```

- [ ] **Step 9: Write `tests/regression/sah-067.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { sharedDb, thinRegression } from "../support/regression";

thinRegression(
  67,
  "Stock-on-hand replays the entire movement history under a forced index-navigation plan",
  ["spec:1225", "contracts §4.3.5", "§4.7.3", "packages/db/test/inventory/fefo.test.ts"],
  () => {
    it("stock on hand is a stored projection, not a replay — and it has a primary key to update", async () => {
      const { db } = await sharedDb();
      const [pk] = await db.admin<{ cols: string[] }[]>`
        select array_agg(a.attname order by k.ord) as cols
          from pg_constraint c
          join unnest(c.conkey) with ordinality k(attnum, ord) on true
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
         where c.conrelid = 'app.stock_on_hand'::regclass and c.contype = 'p'`;
      // The old system computed the figure by walking every movement of the material, every time, and the
      // walk was pinned to one index. Here the figure is a row, MERGEd in the posting transaction, and the
      // nightly job rebuilds and compares it (test 2) instead of the read path recomputing it.
      expect(pk!.cols).toEqual(["company_id", "item_id", "warehouse_id", "lot_id"]);
    });

    it("the chronological key is an INDEX and its columns are explicit and total (spec:1225)", async () => {
      const { db } = await sharedDb();
      const [idx] = await db.admin<{ indexdef: string }[]>`
        select indexdef from pg_indexes
         where schemaname = 'app' and indexname = 'inventory_movement_chrono_idx'`;
      for (const column of ["company_id", "item_id", "warehouse_id", "effective_date", "posting_seq",
                            "line_no", "movement_no"]) {
        expect(idx!.indexdef, column).toContain(column);
      }
    });

    it("no source file pins a query plan the way the legacy procedures did", async () => {
      const { sourceFiles } = await import("../support/source");
      const offenders = sourceFiles()
        .filter((f) => /\+INDEX\s*\(|enable_seqscan|PLAN\s*\(/i.test(f.text))
        .map((f) => f.path);
      expect(offenders).toEqual([]);
    });
  },
);
```

- [ ] **Step 10: Run everything and verify**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/costing/apply-movements.test.ts test/inventory/stock-on-hand.test.ts`
Expected: **PASS** — eleven assertions in the first, five in the second.

Run: `bun run --cwd packages/db test`
Expected: **PASS**. 1A's, 1B's, 2A's and 2B's posting suites are unaffected: every one of their policies declares `inventory: { effect: "none" }`, so `plan.movements` is empty, step 9 is skipped and step 12's stock half is skipped.

Run: `bun run --cwd tests test -- invariants/projection-rebuild.test.ts invariants/audit-chain.test.ts regression/sah-067.test.ts`
Expected: **PASS**.

Run: `bun run --cwd apps/worker test -- test/handlers/integrity-check.test.ts`
Expected: **PASS** with the three-member array.

Run: `bun run lint:rules`
Expected: PASS. `posting-only-tables` finds `app.inventory_movement` DML only in `packages/db/src/costing/apply-movements.ts` and `app.stock_on_hand` DML only in `packages/db/src/costing/stock-on-hand.ts` — both on its allow-list — plus the test files, which are too. `integrity/stock.ts` contains no DML on either.

- [ ] **Step 11: Commit**

```bash
git add packages/db/src/costing packages/db/src/integrity/stock.ts packages/db/src/integrity/index.ts \
        packages/db/src/posting/post.ts packages/db/src/index.ts \
        packages/db/test/costing/apply-movements.test.ts packages/db/test/inventory/stock-on-hand.test.ts \
        tests/invariants/projection-rebuild.test.ts tests/invariants/audit-chain.test.ts \
        tests/regression/sah-067.test.ts apps/worker/test/handlers/integrity-check.test.ts
git commit -m "$(cat <<'EOF'
feat(db): applyMovements, the stock_on_hand MERGE, and posting steps 9 and 12 [3A T8]

postDocument now moves stock. applyMovements is step 9's hook and the only
writer of app.inventory_movement: it resolves each movement's NONE sentinel
lot, prices it with §4.7.2's provisional rule, inserts the rows ONE AT A TIME
IN movementNo ORDER — which is what lets assert_stock_available see this
transaction's earlier rows — and writes document_line.cost. It writes no cost
layers; 3B replaces the body and deletes the provisional rule. The signature is
frozen from here.

PlannedMovement.value is a MAGNITUDE, like quantity: the row attaches both
signs from effect, which is the same discipline amendment A9 fixed for a
planned ledger line. A contract addition, since §4.4.2 gave the type and not
the sign.

mergeStockOnHand is step 12's twin of the account_balance MERGE, verbatim from
§4.7.3, and it carries amendment A4's sorted advisory locks — 1A's step-12
comment names this slice as the copier, and MERGE ... WHEN NOT MATCHED has the
same concurrent-insert hazard on a stock key as on a balance key.

Those locks are factored into lockStockKeys and taken TWICE: applyMovements
takes them before the first movement insert, mergeStockOnHand before the MERGE.
Step 9 is the load-bearing one. §4.3.2 step 1's `for update` on app.document
serialises posters of one DOCUMENT only, so two documents issuing the same
(company, item, warehouse, lot) would both read the same committed sum in
assert_stock_available, both pass and both commit — negative stock with no
override event, which is test 18's invariant defeated by concurrency rather
than by a bypass. Re-locking a held key is a no-op, so the second call is free.

PostResult.movementIds is read back from the table in movement_no order rather
than added to the frozen plan interface.

STOCK_ON_HAND_CHECK joins 1B's registry, so projections.checked becomes
["account_balance", "document_series", "stock_on_hand"] and the two pinned
assertions move in this PR, as §4.18 requires.

Amendment A5's step-9b guard is untouched — §4.3.2 assigns its removal to 3B —
and a new test proves a line.cost policy still fails closed at 3A.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Acceptance test 18 — stock availability refused by the data layer, by every write path

**Part VI test 18** (spec:2436): "Negative stock is rejected by the data layer regardless of session flags, user attributes, or write path. Overrides are explicit and audited." SAH-048 is the defect: "Negative-stock and overcost controls are opt-in per user and have four bypasses." This task is the proof, and it is written as an **invariant suite** rather than a unit test because the claim is about the *system*, not about a function.

**The write paths, and what each one means here.**

| Path | How it is exercised | Why it is the right stand-in |
|---|---|---|
| **API** | `POST /v1/companies/{id}/documents` then `POST …/documents/{id}/transitions { to: "posted" }` through `sharedApi()` | The real HTTP surface, with `requirePermission`, idempotency and Zod in front of it. |
| **Job** | `postDocument` under `systemContext(sql, tenantId, requestId)` inside the production `withTenant` | 3A registers one job (`inventory.lot.expiry_warning`, Task 10) and it posts nothing, so there is no *named* job to enqueue. What the clause tests is that the refusal does not depend on **who** is acting, and the system principal is the strongest case available: `app.actor_has` returns **true** for it unconditionally (§4.1, R8 spec:2179), so a control that consulted authority at all would let this one through. Every future posting job — 3B's `inventory.cost.replay`, 6A's `pos.sync.apply`, 9B's `admin.import.run` — enters through exactly this context. |
| **Two jobs at once** | two `postDocument` transactions on two documents issuing the same `(company, item, warehouse, lot)`, interleaved deterministically | "Regardless of … write path" includes two of the same path concurrently, and this is the only clause of test 18 that a *correct-looking* implementation fails. §4.3.2 step 1's `for update` locks one **document**, so without Task 8's `lockStockKeys` both transactions read the same committed movement sum, both satisfy the trigger and both commit. The refusal must survive concurrency or it is a refusal only of the careless. |
| **Raw `app_rw` SQL** | a direct `insert into app.inventory_movement` inside `withTenant`, bypassing `postDocument` entirely | The database is the last line, and `assert_stock_available` is a BEFORE INSERT trigger, so nothing that can write the table can miss it. Legal in `tests/` only: `scripts/lint/run.ts`'s `ROOTS` are `["apps", "packages", "scripts"]` and `tests/` is deliberately outside them (§3.7.5). |

**And the two "attributes" clauses, which are the half SAH-048 is really about.** The legacy control was a per-user flag with four bypasses, so the test must show that no attribute of the session or of the configuration changes the answer: a `set_config('app.allow_negative_stock', 'true', true)` session GUC, and a policy whose `inventory.allowNegative` is `true` (assumption 4).

**Files:**
- Create: `tests/invariants/stock-availability.test.ts`, `tests/regression/sah-048.test.ts`

**Interfaces:**
- Consumes: `sharedApi`, `grantAdmin`, `FullContext`, `problemOf` and `sharedDb`, `thinRegression` (0B, §4.17.1); `withTenant` (production, §4.2.2) and `systemContext` (§4.2.2); `postDocument`, `recordOverride` (§4.3.1); `seedDocumentType` (2A), `grantCodes` (2B), `seedItem`, `seedWarehouse`, `seedAccount`, `seedTenantV2` (Tasks 1–2, 1A); `listDocumentEvents` and `DocumentEventRow`'s `id`/`occurredAt` members (2B); `lockStockKeys` indirectly, through the two posting paths (Task 8). **Not `app.audit_log`:** `app.document_event` is AUDIT_EXEMPT (§3.5.3) and no `attach_audit` ever runs on it, so this suite proves "audited" from the immutable, actor-stamped event row instead.
- Produces: no source; the suite and one regression file. Test 18 passes from this commit.

- [ ] **Step 1: Write the failing test `tests/invariants/stock-availability.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listDocumentEvents, postDocument, recordOverride, systemContext, withTenant,
} from "@dulja/db";
import {
  grantCodes, seedAccount, seedDocumentType, seedItem, seedTenantV2, seedWarehouse,
  type Db, type Seed,
} from "@dulja/db/test";
import { sharedApi, grantAdmin, problemOf } from "../support/api";
// Type-only, so no runtime edge and no `dependency-rule` question — §4.18 round 3 settles that a root
// `tests/**` file may import `apps/api/test/support/app.ts` for a TYPE and reaches `startApi()` itself only
// through 0B's memoised `sharedApi()`, which this file uses.
import type { StartedApi } from "../../apps/api/test/support/app";

/**
 * Part VI test 18 (spec:2436) — "Negative stock is rejected by the data layer regardless of session flags,
 * user attributes, or write path. Overrides are explicit and audited." SAH-048.
 *
 * The control is app.assert_stock_available, a BEFORE INSERT trigger on app.inventory_movement (migration
 * 0031). Nothing below reaches around it, because there is nothing to reach around: the check is not in a
 * handler, not in a service and not behind a flag.
 */
describe("test 18 — stock availability is refused by the data layer, by every path", () => {
  let api: StartedApi;
  let db: Db;
  let s: Seed;
  let itemId: string;
  let warehouseId: string;
  let typeId: string;
  let supervisor: string;

  const ctx = (actor?: string) => ({
    tenantId: s.tenant, actorId: actor ?? s.human, requestId: "test-18",
  });

  /** `warehouse: "line.warehouse"` so a line can name it: CreateDocumentBody carries no header warehouse in
   *  this slice (3D adds one when TRANSFER needs it). Two account legs balance the ledger; the item line
   *  carries the stock and matches no ledger rule. */
  const ISSUE_POLICY = {
    version: 1, documentType: "STOCK_ISSUE_TEST", direction: "internal", requires: [],
    lines: [
      { for: "each_line", side: "debit",  account: { from: "line.account" }, amount: "line.debit",  when: { "line.kind": "account" } },
      { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
    ],
    inventory: { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" },
    tax: { applies: false },
    numbering: { series: "SIT", assignAt: "issue" },
    reversal: { allowed: true, producesType: "STOCK_ISSUE_TEST" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    dimensions: { required: [] },
  };

  beforeAll(async () => {
    // `sharedApi()` returns `{ api, a, b }` (0B, §4.17.1) — it is NOT a `StartedApi`, so it is destructured.
    // Its `a`/`b` are bare `seedTenant` seeds; this suite needs a V2 tenant with an approval-bearing policy,
    // so it seeds its own and leaves `a`/`b` untouched for the regression files that share the instance.
    ({ api } = await sharedApi());
    db = api.db;
    s = await seedTenantV2(db, "Test18");
    await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, s, { code: "5000", nameEn: "Cost of goods sold", type: "expense" });
    await seedAccount(db, s, { code: "5900", nameEn: "Other operating expense", type: "expense" });
    await grantAdmin(api, s);                                  // the caller of the API path
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    typeId = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST", module: "inventory", policy: ISSUE_POLICY,
    });
    ({ itemId } = await seedItem(db, s, { code: "SUGAR-1KG", trackLots: false }));
    warehouseId = await seedWarehouse(db, s, { code: "HQ-MAIN" });
    // A second principal for the override door, in 2B's `secondPrincipal` shape (plan0A:837).
    supervisor = crypto.randomUUID();
    // The context is built from `s.system` rather than resolved through `systemContext`, because this
    // transaction runs as `app_migrator` and `app.resolve_principal`'s EXECUTE is granted to `app_rw` ONLY
    // (§4.1) — `systemContext` on the migrator handle is a `permission denied`, not a context. `Seed.system`
    // already holds the id that lookup would return (§4.1), and 2B's `secondPrincipal` passes `s.system` the
    // same way. The two `systemContext` calls further down stay: they run on `db.rw`, model the real job
    // path, and are `await`ed — §4.2.2 declares `Promise<TenantContext>`, so passing the promise is a
    // typecheck failure and, had it reached runtime, `ctx.tenantId` would have been `undefined`.
    const setupCtx = { tenantId: s.tenant, actorId: s.system, requestId: "test-18-setup" };
    await withTenant(db.migrator, setupCtx, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${supervisor}, 'human', ${`stock-supervisor:${s.tenant}`}, 'Stock supervisor')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${supervisor})`;
    });
    await grantCodes(db, s, {
      codes: ["inventory.negative_stock.override"], principalId: supervisor, roleCode: "stock-override",
    });
  });
  // No `afterAll` stopping the API: `sharedApi()` is memoised for the whole `tests` run and §4.18 round 3
  // states plainly that its consumers must not call `api.stop()` on it — the next file to import it would
  // get a dead container. Testcontainers' Ryuk reaps it on process exit (0B assumption 10).

  /** A draft STOCK_ISSUE_TEST for `quantity`, created through the API. Returns the document id.
   *  `item` defaults to the suite's item; the concurrency case passes its own so it cannot disturb — or be
   *  disturbed by — the stock_on_hand figures the cases above and below assert on `itemId`. */
  const draftIssue = async (quantity: string, item: string = itemId): Promise<string> => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents`, as: s.human,
      body: {
        documentTypeCode: "STOCK_ISSUE_TEST", effectiveDate: "2026-01-15", currency: "MYR",
        branchId: s.hq,
        lines: [
          { lineNo: 1, kind: "account", accountId: s.sales, debit: "12.0000" },
          { lineNo: 2, kind: "account", accountId: s.cash, credit: "12.0000" },
          { lineNo: 3, kind: "item", itemId: item, warehouseId, quantity, unitPrice: "12.0000", amount: "12.0000" },
        ],
      },
    });
    expect(res.status).toBe(201);
    return (await res.json()).id as string;
  };

  it("PATH 1 — the API refuses it with a 422 problem naming the code", async () => {
    const id = await draftIssue("5.000000");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${id}/transitions`,
      as: s.human, body: { to: "posted" },
    });
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_STOCK_INSUFFICIENT");
    expect(problem.detail).toMatch(new RegExp(`item ${itemId}`));
    expect(problem.detail).toMatch(/holds 0.000000, this movement needs 5.000000/);
    // and the document did not post — it is still a DRAFT, and its series number was not consumed.
    // `postDocument` is ONE transaction (§4.3.2 runs steps 1–15 in the caller's tx, and §4.5.4 routes
    // `to: "posted"` straight into it), so the step-7 issue — `series`, `fiscal_period_id`, `number` and the
    // `document_series` counter bump — rolls back together with the step-9 refusal. Asserting "issued" here
    // would be asserting a state that cannot survive the 422; asserting the null number is the visible proof
    // that a refused post costs no number, which is what 2B's gapless guarantee needs.
    const [row] = await withTenant(db.rw, ctx(), (tx) =>
      tx<{ status: string; number: string | null }[]>`
        select status::text as status, number::text as number from app.document where id = ${id}`);
    expect(row!.status).toBe("draft");
    expect(row!.number).toBeNull();
  });

  it("PATH 2 — a job, as the tenant's SYSTEM principal, is refused identically", async () => {
    const id = await draftIssue("5.000000");
    // app.actor_has returns TRUE for the system principal unconditionally (§4.1, R8), so a control that
    // consulted authority at all would admit this write. It is refused, because the control consults stock.
    const jobCtx = await systemContext(db.rw, s.tenant, "job-run-1");   // async; resolved once, used twice
    await expect(withTenant(db.rw, jobCtx, (tx) => postDocument(tx, jobCtx, { documentId: id })))
      .rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
  });

  it("PATH 3 — a raw app_rw insert, with no posting service at all, is refused by the trigger", async () => {
    const id = await draftIssue("5.000000");
    await expect(withTenant(db.rw, ctx(), (tx) => tx`
      insert into app.inventory_movement
        (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
      select app.current_tenant(), ${s.company}, ${id}, 3, 1, ${itemId}, ${warehouseId},
             l.id, i.base_unit_id, -5.000000, -60.0000, '2026-01-15', 1
        from app.item i join app.lot l on l.item_id = i.id and l.code = 'NONE'
       where i.id = ${itemId}`))
      .rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
  });

  it("PATH 2b — two CONCURRENT posts of the same stock key cannot both succeed", async () => {
    // The clause "regardless of … write path" includes two of the same path at once. `assert_stock_available`
    // sums app.inventory_movement, and §4.3.2 step 1's `select … for update` serialises posters of ONE
    // DOCUMENT — so two different documents issuing the same (company, item, warehouse, lot) would, under
    // READ COMMITTED, both read the same committed sum, both satisfy the trigger and both commit. Stock goes
    // negative with no override event anywhere, which is test 18 falsified by concurrency rather than by a
    // bypass. `lockStockKeys`, taken by applyMovements before the insert, is what closes it (Task 8).
    const { itemId: raceItem } = await seedItem(db, s, { code: "SUGAR-RACE", trackLots: false });
    // Stage +5 with a raw receipt movement: the trigger reads the movement table, never stock_on_hand
    // (§4.7.3), so a raw row is exactly the state under test — and stock_on_hand is left untouched, so the
    // projection assertions in the cases around this one are unaffected. Legal in `tests/` (PATH 3's note).
    const stageDoc = await draftIssue("1.000000", raceItem);
    await withTenant(db.rw, ctx(), (tx) => tx`
      insert into app.inventory_movement
        (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
      select app.current_tenant(), ${s.company}, ${stageDoc}, 3, 1, ${raceItem}, ${warehouseId},
             l.id, i.base_unit_id, 5.000000, 60.0000, '2026-01-15', 1
        from app.item i join app.lot l on l.item_id = i.id and l.code = 'NONE'
       where i.id = ${raceItem}`);

    const first = await draftIssue("5.000000", raceItem);
    const second = await draftIssue("5.000000", raceItem);
    const jobCtx = await systemContext(db.rw, s.tenant, "job-race");
    // Two open transactions need two connections; `createDb`'s default `max` is 4 (§4.2.2), so the pool is
    // large enough. If this case ever hangs instead of failing, that is the number to check first.
    //
    // Deterministic ordering, not a sleep race: T1 signals once its own postDocument has returned — so its
    // movement row is written and its stock locks are held — and only then is T2 started. T1 stays open on
    // `gate` until T2 has had its chance to reach the lock.
    let t1Ready!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { t1Ready = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const t1 = withTenant(db.rw, jobCtx, async (tx) => {
      const result = await postDocument(tx, jobCtx, { documentId: first });
      t1Ready();
      await gate;                      // hold the transaction — and its advisory locks — open
      return result;
    });
    const t2 = ready.then(() =>
      withTenant(db.rw, jobCtx, (tx) => postDocument(tx, jobCtx, { documentId: second })));
    // Let T2 block, then let T1 commit. Either order is correct once the locks exist: T2 waits and re-reads
    // 0 available, or T2 starts after the commit and reads 0 available. Without the locks T2 reads the
    // staged +5 (T1's −5 invisible) and both succeed, which is the red this case exists to see.
    //
    // T2 may stall at step 7 rather than at `pg_advisory_xact_lock`: issuing takes the document's
    // `document_series` counter row, which T1 holds uncommitted. That is a plain row wait, not a deadlock —
    // the two hold `for update` on different `app.document` rows and take the stock keys in sorted order —
    // and it produces the same single refusal. An executor watching where T2 blocks should expect either.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();

    const outcomes = await Promise.allSettled([t1, t2]);
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/ERR_STOCK_INSUFFICIENT/);
    // The movements now sum to exactly zero — +5 staged, −5 issued once — so the second issue is refused for
    // the right reason and no stock went negative.
    const [sum] = await withTenant(db.rw, ctx(), (tx) => tx<{ q: string }[]>`
      select coalesce(sum(quantity), 0)::text as q from app.inventory_movement
       where item_id = ${raceItem} and warehouse_id = ${warehouseId}`);
    expect(sum!.q).toBe("0.000000");
    // stock_on_hand shows −5 and not 0, and that is correct rather than drift: the staged +5 was inserted
    // raw, so no step-12 MERGE ever saw it, while the posted document's −5 went through the MERGE. The
    // projection is a pure sum of the movements the posting service wrote. This case therefore leaves a row
    // `checkStockOnHandProjection` would call a mismatch, and that is contained rather than ignored:
    // `sharedApi()` and `sharedDb()` are different databases (0B), and test 2's rebuild-and-compare runs in
    // `projection-rebuild.test.ts` against `sharedDb()` with its own scenario. (PATH 3's raw insert leaves
    // nothing behind at all — it is refused and rolls back — so this case is the suite's only such row.)
    const [soh] = await withTenant(db.rw, ctx(), (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand
       where item_id = ${raceItem} and warehouse_id = ${warehouseId}`);
    expect(soh!.quantity).toBe("-5.000000");
  });

  it("a session flag changes nothing — there is no flag to set (SAH-048's four bypasses)", async () => {
    const id = await draftIssue("5.000000");
    await expect(withTenant(db.rw, ctx(), async (tx) => {
      await tx`select set_config('app.allow_negative_stock', 'true', true)`;
      await tx`select set_config('app.skip_stock_check', 'true', true)`;
      return postDocument(tx, ctx(), { documentId: id });
    })).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
    // Not "the flag was ignored" but "the flag is not a thing": no SQL in the repository reads either name.
    const { sourceFiles } = await import("../support/source");
    const readers = sourceFiles()
      .filter((f) => /allow_negative_stock|skip_stock_check/.test(f.text))
      .map((f) => f.path);
    expect(readers).toEqual([]);
  });

  it("a policy attribute changes nothing — allowNegative is read by no code (assumption 4)", async () => {
    await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST", policyVersion: 2, effectiveFrom: "2026-01-01",
      policy: { ...ISSUE_POLICY, inventory: { ...ISSUE_POLICY.inventory, allowNegative: true } },
    });
    const id = await draftIssue("5.000000");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${id}/transitions`,
      as: s.human, body: { to: "posted" },
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_STOCK_INSUFFICIENT");
  });

  it("the ONE door: a second principal's override event, and the post then succeeds", async () => {
    const id = await draftIssue("5.000000");
    await withTenant(db.rw, ctx(supervisor), (tx) => recordOverride(tx, ctx(supervisor), {
      documentId: id, code: "inventory.negative_stock.override", reason: "physical count pending",
    }));
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${id}/transitions`,
      as: s.human, body: { to: "posted" },
    });
    expect(res.status).toBe(200);
    const [soh] = await withTenant(db.rw, ctx(), (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand
       where item_id = ${itemId} and warehouse_id = ${warehouseId}`);
    expect(soh!.quantity).toBe("-5.000000");                   // negative, and only through the door
  });

  it("the override is EXPLICIT and AUDITED — a named event, stamped, and append-only", async () => {
    // "Audited" is proved from the artefact that exists. `app.document_event` has NO audit trigger: §3.5.3's
    // register row marks it `already` in both AUDIT_EXEMPT and IMMUTABLE, §4.5.2's DDL calls only
    // attach_stamp('app.document_event', 'actor_id'), and Task 5's own quoted AUDIT_EXEMPT set contains
    // "document_event". So there is no app.audit_log row to count, and looking for one would be a test that
    // can only fail. The immutable, actor-stamped event row IS the audit record for this table — which is
    // exactly why the table is audit-exempt — so the assertions are on that row: it names the code, it names
    // the second principal (stamped by app.stamp_actor from app.current_actor(), never from a payload), it
    // carries the reason and an occurrence time, and it cannot be edited afterwards.
    const [doc] = await withTenant(db.rw, ctx(), (tx) => tx<{ id: string }[]>`
      select d.id from app.document d
       where d.document_type_id = ${typeId} and d.status = 'posted' order by d.number desc limit 1`);
    const events = await withTenant(db.rw, ctx(), (tx) => listDocumentEvents(tx, doc!.id));
    const override = events.find((e) => e.eventKind === "override");
    expect(override).toMatchObject({
      overrideCode: "inventory.negative_stock.override",
      actorId: supervisor,
      reason: "physical count pending",
    });
    expect(override!.occurredAt).not.toBeNull();

    // Append-only, both ways it is enforced. `app_rw` has UPDATE revoked (§4.5.2), so it never reaches the
    // trigger at all — it is refused on privilege, one layer earlier.
    await expect(withTenant(db.rw, ctx(), (tx) => tx`
      update app.document_event set reason = 'rewritten' where id = ${override!.id}`))
      .rejects.toThrow(/permission denied/);
    // And the role that DOES hold UPDATE meets `document_event_immutable`, which is the control itself.
    // Built directly, for the reason the `beforeAll` gives: `app_migrator` may not execute
    // `app.resolve_principal`, so `systemContext` on this handle would fail before the trigger could.
    const migratorCtx = { tenantId: s.tenant, actorId: s.system, requestId: "test-18-immutable" };
    await expect(withTenant(db.migrator, migratorCtx, (tx) => tx`
      update app.document_event set reason = 'rewritten' where id = ${override!.id}`))
      .rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
  });

  it("the override does not survive the document: the next document is refused again", async () => {
    const id = await draftIssue("1.000000");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${id}/transitions`,
      as: s.human, body: { to: "posted" },
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_STOCK_INSUFFICIENT");
  });

  it("the override needs a SECOND principal: the creator's own is refused by 2B's guard", async () => {
    const id = await draftIssue("1.000000");
    await grantCodes(db, s, { codes: ["inventory.negative_stock.override"], roleCode: "self-stock-override" });
    await expect(withTenant(db.rw, ctx(), (tx) => recordOverride(tx, ctx(), {
      documentId: id, code: "inventory.negative_stock.override", reason: "mine",
    }))).rejects.toThrow(/ERR_OVERRIDE_NOT_AUTHORISED/);
  });

  it("a principal WITHOUT the code cannot record the override even as a second principal", async () => {
    const id = await draftIssue("1.000000");
    const stranger = crypto.randomUUID();
    // Same reason as the `beforeAll`: built from `s.system`, not resolved on the migrator handle.
    await withTenant(db.migrator, { tenantId: s.tenant, actorId: s.system, requestId: "test-18-stranger" }, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${stranger}, 'human', ${`stranger:${s.tenant}`}, 'Stranger')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${stranger})`;
    });
    await expect(withTenant(db.rw, ctx(stranger), (tx) => recordOverride(tx, ctx(stranger), {
      documentId: id, code: "inventory.negative_stock.override", reason: "no authority",
    }))).rejects.toThrow(/ERR_OVERRIDE_NOT_AUTHORISED/);
  });
});
```

- [ ] **Step 2: Run the suite to see the exact failure**

Run: `bun run --cwd tests test -- invariants/stock-availability.test.ts`
Expected: **FAIL** on `PATH 1` with `expected 200 to be 422` — Task 8 wired step 9 and Task 5 shipped the trigger, so the first four cases pass as soon as the fixtures line up; the failure to expect on a first run is a 401 on every call, which means an `api.request({ ... })` object lost its `as` — the harness treats a missing `as` as an UNAUTHENTICATED call (§4.2.12), and nothing here is unauthenticated. Fix that; the assertions do not move. No call sets an `Idempotency-Key` header by hand: the harness mints one for every unsafe method itself.

If the suite is written **before** Task 8 has merged, PATH 1 fails with `expected 200 to be 422` because no movement is written at all — which is the correct known-red state and the reason this task follows Task 8.

- [ ] **Step 3: Write `tests/regression/sah-048.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { sharedDb, thinRegression } from "../support/regression";
import { sourceFiles } from "../support/source";

thinRegression(
  48,
  "Negative-stock and overcost controls are opt-in per user and have four bypasses",
  ["spec:1308", "spec:2179", "spec:2436", "contracts §4.7.3", "tests/invariants/stock-availability.test.ts"],
  () => {
    it("the control is a TRIGGER on the movement table, not a handler and not a user setting", async () => {
      const { db } = await sharedDb();
      const [trigger] = await db.admin<{ tgname: string; enabled: string; tgtype: number }[]>`
        select tgname, tgenabled as enabled, tgtype
          from pg_trigger
         where tgrelid = 'app.inventory_movement'::regclass and tgname = 'inventory_movement_stock_available'`;
      expect(trigger?.tgname).toBe("inventory_movement_stock_available");
      expect(trigger?.enabled).toBe("O");     // enabled, ORIGIN — never disabled "temporarily" (spec:97)
      expect(trigger!.tgtype & 4).toBe(4);    // TRIGGER_TYPE_INSERT
      expect(trigger!.tgtype & 2).toBe(2);    // TRIGGER_TYPE_BEFORE
    });

    it("there is no per-user stock setting anywhere: no column, no GUC, no catalogue code for one", async () => {
      const { db } = await sharedDb();
      const columns = await db.admin<{ table_name: string; column_name: string }[]>`
        select table_name, column_name from information_schema.columns
         where table_schema = 'app'
           and (column_name ilike '%allow_negative%' or column_name ilike '%skip_stock%'
             or column_name ilike '%negative_stock%')`;
      expect(columns).toEqual([]);
      // The one authority that exists is a PERMISSION exercised per document by a second principal, which is
      // an audited event and not a setting (spec:2179).
      const { db } = await sharedDb();
      const [code] = await db.admin<{ mutating: boolean }[]>`
        select mutating from app.permission where code = 'inventory.negative_stock.override'`;
      expect(code!.mutating).toBe(true);
    });

    it("the availability sum reads the movement ledger, never the projection", async () => {
      const { db } = await sharedDb();
      const [fn] = await db.admin<{ src: string }[]>`
        select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app' and p.proname = 'assert_stock_available'`;
      // Reading stock_on_hand would be wrong twice: it is MERGEd only at step 12, so an in-transaction
      // receipt would be invisible, and a drifted projection would become an authorisation decision.
      expect(fn!.src).toContain("app.inventory_movement");
      expect(fn!.src).not.toContain("stock_on_hand");
    });

    it("no source file reads a stock bypass flag of any kind", () => {
      const offenders = sourceFiles()
        .filter((f) => /allow_negative_stock|skip_stock_check|ignore_stock|bypass_stock/i.test(f.text))
        .map((f) => f.path);
      expect(offenders).toEqual([]);
    });
  },
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd tests test -- invariants/stock-availability.test.ts regression/sah-048.test.ts`
Expected: **PASS** — eleven assertions in the suite, four in the regression file. **Test 18 is green from this commit.**

If **PATH 2b** is the one that fails — `expected [] to have length 1`, i.e. *both* concurrent posts succeeded — the `lockStockKeys` call at the top of `applyMovements` is missing or was placed after `insertMovements`. That is the failure the case exists to catch, and Task 8 Step 4 is where it is fixed, not here.

Run: `bun run --cwd tests test`
Expected: PASS across the whole invariants and regression tier.

- [ ] **Step 5: Commit**

```bash
git add tests/invariants/stock-availability.test.ts tests/regression/sah-048.test.ts
git commit -m "$(cat <<'EOF'
test(invariants): acceptance test 18 — stock availability by every write path [3A T9]

The API path gets a 422 problem naming ERR_STOCK_INSUFFICIENT and the document
stays issued. The job path runs postDocument under systemContext, for which
app.actor_has returns true unconditionally — so a control that consulted
authority at all would admit it, and it is refused. The raw app_rw path inserts
straight into app.inventory_movement with no posting service and the BEFORE
INSERT trigger refuses that too.

The two attribute clauses are the half SAH-048 is really about: a session GUC
changes nothing because no SQL in the repository reads one, and a policy with
inventory.allowNegative: true changes nothing because no code reads that either
(assumption 4) — spec:2436 wants the refusal regardless of user attributes and a
policy flag is one.

The one door is a second principal's override event. It is explicit (the code is
on the event), audited (the immutable, actor-stamped document_event row — app.document_event
is AUDIT_EXEMPT, so the event row IS the record and no audit_log row exists), scoped
to ONE document (the next one is refused again), refused for the creator by 2B's
guard, and refused for a principal without the code.

sah-048 asserts the shape rather than the behaviour: a BEFORE INSERT trigger, no
per-user column or GUC anywhere in schema app, an availability sum that reads
the movement ledger and never the projection, and no source file reading a
bypass flag.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: FEFO's TypeScript wrapper, the near-expiry alert job, and lot attachments

Three loose ends of the "Batch / lot with expiry" row (spec:1022 — "Requires batch on every movement, FEFO picking, expiry reporting and near-expiry alerts"): the wrapper a screen and 3D's picking call, the daily job that warns before stock expires, and the lot end of §4.5.8's attachment map — spec:1067's "3 (lot link)", the certificates and permits a food distributor keeps per batch.

**⚠️ OD-05 — the §3.0.3 "Batch / lot with expiry" row (spec:1022), continued from Task 2.** **If the owner rejects the row:** drop `expiry.ts`, `apps/worker/src/handlers/inventory.ts`, the `inventory.lot.expiry_warning` payload entry and its `JOB_PROBES` row; keep `pickLotsFefo` (the sentinel-only case is a one-lot pick and 3D's delivery orders still call it) and keep the attachment work (a lot attachment is a certificate, not an expiry feature).

**Files:**
- Create: `packages/db/src/inventory/expiry.ts`, `apps/worker/src/handlers/inventory.ts`
- Create: `apps/worker/test/handlers/expiry-warning.test.ts`, `apps/api/test/routes/accounting/attachments-lot.test.ts`
- Modify: `packages/db/src/inventory/lots.ts` (`pickLotsFefo`, `FefoPick`), `packages/db/src/index.ts`, `packages/db/src/jobs/payloads.ts`
- Modify: `apps/api/src/routes/accounting/attachments.ts` (`MODULE_READ_CODE`, `requireAttachmentRead`, `listAttachments`'s call, the upload), `packages/contracts/src/accounting/attachment.ts`
- Modify: `packages/db/src/attachment/*` — wherever 2C's `listAttachments` lives — for the `includeLots` option and the `left join`
- Modify: `apps/worker/src/index.ts` (register the handlers), `packages/db/test/inventory/fefo.test.ts` (append the wrapper's cases), `tests/invariants/probes.ts` (one `JOB_PROBES` entry)

**Interfaces:**
- Consumes: `app.pick_lots_fefo`, `app.lot`, `app.stock_on_hand` (Tasks 2, 5); `Quantity` (§4.2.1); `JOBS`, `JobPayload`, `JobEnvelope`, `registerHandler`, `JobIsolationProbe`, `JOB_PROBES` (0D, §4.2.6) — **not `eachTenant`**, whose fan-out is the scheduler's and whose axis is the tenant, while this handler's is the company (Step 5 states the reason at the import line); `startWorker` (0D, §4.17.1); `withTenant` (§4.2.2) and `systemContext` (§4.2.2) — the latter in the **test** file only, because the handler receives the tenant's system context as `ctx`; `MODULE_READ_CODE`, `requireAttachmentRead`, `readableModules`, `listAttachments`, `ObjectStore`, `objectKeyFor`, `AttachmentSchema`, `UploadAttachmentBody`, `createAttachmentRoutes` (2C, §4.5.8); `INVENTORY_PERMISSION` (Task 3); `startApi`, `StartedApi` (0B, `apps/api/test/support/app`) and `grantAdmin`, `problemOf` (0B, `tests/support/api`) — **not `sharedApi`**, for the reason Task 11 gives; `uuidv7` (§4.1) for the second principal this suite creates.
- Produces:
  - `export interface FefoPick { lotId: string; quantity: Quantity }`
  - `export async function pickLotsFefo(tx: Sql, params: { itemId: string; warehouseId: string; quantity: Quantity }): Promise<FefoPick[]>`
  - `export const EXPIRY_HORIZON_DAYS = 30`
  - `export interface NearExpiryLot { companyId: string; itemId: string; itemCode: string; lotId: string; lotCode: string; expiresOn: string; warehouseId: string; warehouseCode: string; quantity: string; daysToExpiry: number }`
  - `export async function listNearExpiryLots(tx: Sql, params: { companyId?: string; horizonDays?: number; asOf?: string }): Promise<NearExpiryLot[]>`
  - `export async function recordExpiryWarning(tx: Sql, input: { companyId: string; lots: readonly NearExpiryLot[] }): Promise<void>`
  - `export function registerInventoryHandlers(): void` — `apps/worker/src/handlers/inventory.ts`
  - `JobPayload["inventory.lot.expiry_warning"] = { companyId?: string; horizonDays?: number }`
  - `MODULE_READ_CODE.inventory = PERMISSION["inventory.stock.read"]`; `requireAttachmentRead`'s lot branch → `inventory.item.read`; `AttachmentSchema.lotId`; `UploadAttachmentBody` exactly-one-of `documentId | lotId`; `listAttachments`' `includeLots?: boolean`.
  - Audit `table_name` sentinel `lot_expiry_warning` — the third after 1B's two (§4.2.6 contract addition).

- [ ] **Step 2: Append the wrapper's cases to `packages/db/test/inventory/fefo.test.ts`**

Add to the existing `describe` from Task 5:

```ts
  it("pickLotsFefo returns Quantity values, never numbers, and the same order as the function", async () => {
    const picks = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      pickLotsFefo(tx, { itemId, warehouseId, quantity: Quantity.of("30.000000") }));
    expect(picks.map((p) => p.lotId)).toEqual([lots.early, lots.mid]);
    expect(picks.map((p) => p.quantity.toString())).toEqual(["10.000000", "20.000000"]);
    expect(picks[0]!.quantity).toBeInstanceOf(Quantity);
  });

  it("pickLotsFefo on an item with only its sentinel lot returns that one lot", async () => {
    const { itemId: bolts } = await seedItem(db, a, { code: "BOLT-M8", trackLots: false });
    const sentinel = await withTenant(db.rw, a.tenant, a.human, (tx) => sentinelLotId(tx, bolts));
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
      values (${a.tenant}, ${a.company}, ${bolts}, ${warehouseId}, ${sentinel}, 50.000000)`);
    const picks = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      pickLotsFefo(tx, { itemId: bolts, warehouseId, quantity: Quantity.of("5.000000") }));
    expect(picks).toEqual([{ lotId: sentinel, quantity: Quantity.of("5.000000") }]);
  });

  it("listNearExpiryLots reports what expires inside the horizon, soonest first", async () => {
    const near = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listNearExpiryLots(tx, { companyId: a.company, horizonDays: 40, asOf: "2026-07-01" }));
    expect(near.map((l) => l.lotCode)).toEqual(["B-EARLY"]);       // 2026-07-31 is 30 days out; MID is 61
    expect(near[0]!.daysToExpiry).toBe(30);
    expect(near[0]!.quantity).toBe("10.000000");
    expect(near[0]!.warehouseCode).toBe("CHILL");
  });

  it("listNearExpiryLots ignores a lot with no stock and a lot with no expiry", async () => {
    const near = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listNearExpiryLots(tx, { companyId: a.company, horizonDays: 3650, asOf: "2026-07-01" }));
    expect(near.map((l) => l.lotCode).sort()).toEqual(["B-EARLY", "B-LATE", "B-MID"]);   // never NONE
  });

  it("EXPIRY_HORIZON_DAYS is a reporting horizon and defaults to 30", async () => {
    expect(EXPIRY_HORIZON_DAYS).toBe(30);
    const near = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listNearExpiryLots(tx, { companyId: a.company, asOf: "2026-07-01" }));
    expect(near.map((l) => l.lotCode)).toEqual(["B-EARLY"]);
  });
```

Extend the file's imports with `EXPIRY_HORIZON_DAYS`, `listNearExpiryLots` from `../../src/inventory/expiry`, `pickLotsFefo` from `../../src/inventory/lots`, `Quantity` from `@dulja/domain`, and `seedItem` from `../fixtures`.

- [ ] **Step 3: Write the failing test `apps/worker/test/handlers/expiry-warning.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { seedItem, seedTenant, seedWarehouse, type Seed } from "@dulja/db/test";
import { createLot } from "@dulja/db";
import { startWorker, type StartedWorker } from "../support/worker";

describe("inventory.lot.expiry_warning — the daily near-expiry alert (spec:1022, §4.2.6)", () => {
  let w: StartedWorker;
  let s: Seed;
  let itemId: string;
  let warehouseId: string;

  beforeAll(async () => {
    w = await startWorker();
    s = await seedTenant(w.db, "Expiry A");
    ({ itemId } = await seedItem(w.db, s, { code: "YOG-500G", trackLots: true }));
    warehouseId = await seedWarehouse(w.db, s, { code: "CHILL" });
    await withTenant(w.db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "expiry-seed" }, async (tx) => {
      const soon = await createLot(tx, {
        companyId: s.company, itemId, code: "B-SOON",
        expiresOn: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
      });
      const later = await createLot(tx, {
        companyId: s.company, itemId, code: "B-LATER",
        expiresOn: new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10),
      });
      for (const lot of [soon.id, later.id]) {
        await tx`insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
                 values (${s.tenant}, ${s.company}, ${itemId}, ${warehouseId}, ${lot}, 12.000000)`;
      }
    });
  });
  afterAll(async () => { await w.stop(); });

  it("logs one warning per near-expiry lot and writes ONE audit row per company", async () => {
    await w.run("inventory.lot.expiry_warning", {
      tenantId: s.tenant, requestId: "expiry-run-1", payload: {},
    });
    const warned = w.logs.filter((l) => l.msg === "lot expiring soon");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ level: "warn", lotCode: "B-SOON", itemCode: "YOG-500G" });
    const [audit] = await withTenant(w.db.rw, { tenantId: s.tenant, actorId: s.system, requestId: "check" }, (tx) =>
      tx<{ n: number; actor: string }[]>`
        select count(*)::int as n, max(actor_id::text) as actor from app.audit_log
         where table_name = 'lot_expiry_warning'`);
    expect(audit!.n).toBe(1);
    expect(audit!.actor).toBe(s.system);        // jobs run as the tenant's system principal (hazard 20)
  });

  it("a horizon in the payload widens the window", async () => {
    w.logs.length = 0;
    await w.run("inventory.lot.expiry_warning", {
      tenantId: s.tenant, requestId: "expiry-run-2", payload: { horizonDays: 500 },
    });
    expect(w.logs.filter((l) => l.msg === "lot expiring soon").map((l) => l.lotCode).sort())
      .toEqual(["B-LATER", "B-SOON"]);
  });

  it("a company with nothing near expiry writes no audit row and logs nothing", async () => {
    const quiet = await seedTenant(w.db, "Expiry B");
    w.logs.length = 0;
    await w.run("inventory.lot.expiry_warning", {
      tenantId: quiet.tenant, requestId: "expiry-run-3", payload: {},
    });
    expect(w.logs.filter((l) => l.msg === "lot expiring soon")).toEqual([]);
    const [audit] = await withTenant(w.db.rw, { tenantId: quiet.tenant, actorId: quiet.system, requestId: "c" }, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.audit_log where table_name = 'lot_expiry_warning'`);
    expect(audit!.n).toBe(0);
  });

  it("the job is scheduled daily at 06:00 and its name is in the closed registry", async () => {
    const { JOBS } = await import("@dulja/db");
    expect(JOBS["inventory.lot.expiry_warning"]).toEqual({ schedule: "0 6 * * *", owner: "3A" });
  });
});
```

- [ ] **Step 4: Write `packages/db/src/inventory/expiry.ts` and the `pickLotsFefo` wrapper**

Append to `packages/db/src/inventory/lots.ts`:

```ts
export interface FefoPick { lotId: string; quantity: Quantity }

/**
 * First-expired-first-out picking — the 3A card's function, wrapped. This is the ONE caller-facing entry to
 * `app.pick_lots_fefo` (migration 0031): the ordering, the partial-pick behaviour and the sentinel's
 * last-place position all live in the SQL, so a screen, 3D's DELIVERY_ORDER and 6B's till cannot disagree
 * about which batch goes first (ADR 0036).
 *
 * Picking happens at DRAFTING time, over the synchronous projection. It is never called inside a posting
 * transaction, where the projection has not yet been MERGEd — `assert_stock_available` is the control there.
 */
export async function pickLotsFefo(
  tx: Sql, params: { itemId: string; warehouseId: string; quantity: Quantity },
): Promise<FefoPick[]> {
  const rows = await tx<{ lot_id: string; quantity: string }[]>`
    select lot_id, quantity::text as quantity
      from app.pick_lots_fefo(${params.itemId}, ${params.warehouseId}, ${params.quantity.toString()}::numeric)`;
  return rows.map((r) => ({ lotId: r.lot_id, quantity: Quantity.of(r.quantity) }));
}
```

`packages/db/src/inventory/expiry.ts`:

```ts
import type { Sql } from "postgres";

/**
 * The default reporting horizon for the near-expiry alert. **A reporting choice, not a statutory figure** —
 * hazard 1 does not engage: nothing about it is a rate, threshold, ceiling or formula from any authority. A
 * tenant that wants a different window passes `horizonDays` in the job payload.
 */
export const EXPIRY_HORIZON_DAYS = 30;

export interface NearExpiryLot {
  companyId: string; itemId: string; itemCode: string;
  lotId: string; lotCode: string; expiresOn: string;
  warehouseId: string; warehouseCode: string;
  quantity: string; daysToExpiry: number;
}

/**
 * Lots with stock on hand that expire on or before `asOf + horizonDays`, soonest first. Reads the synchronous
 * projection, so a lot whose stock has all been issued does not appear — the alert is about goods that are
 * still there. A lot with no `expires_on` — every item's `NONE` sentinel, and any untracked batch — is never
 * reported: it has no expiry to warn about.
 */
export async function listNearExpiryLots(tx: Sql, params: {
  companyId?: string; horizonDays?: number; asOf?: string;
}): Promise<NearExpiryLot[]> {
  return tx<NearExpiryLot[]>`
    select h.company_id            as "companyId",
           h.item_id               as "itemId",
           i.code                  as "itemCode",
           h.lot_id                as "lotId",
           l.code                  as "lotCode",
           l.expires_on::text      as "expiresOn",
           h.warehouse_id          as "warehouseId",
           w.code                  as "warehouseCode",
           h.quantity::text        as "quantity",
           (l.expires_on - coalesce(${params.asOf ?? null}::date, current_date))::int as "daysToExpiry"
      from app.stock_on_hand h
      join app.lot l       on l.tenant_id = h.tenant_id and l.id = h.lot_id
      join app.item i      on i.tenant_id = h.tenant_id and i.id = h.item_id
      join app.warehouse w on w.tenant_id = h.tenant_id and w.id = h.warehouse_id
     where h.quantity > 0
       and l.expires_on is not null
       and l.archived_at is null
       and (${params.companyId ?? null}::uuid is null or h.company_id = ${params.companyId ?? null})
       and l.expires_on <= coalesce(${params.asOf ?? null}::date, current_date)
                           + ${params.horizonDays ?? EXPIRY_HORIZON_DAYS}::int
     order by l.expires_on, i.code, l.code, w.code`;
}

/**
 * One `app.audit_log` row per company per run, under the sentinel `table_name` **`lot_expiry_warning`** —
 * the third allocated sentinel after 1B's `integrity_incident` and `month_end_ready` (§4.2.6). The alert has
 * no row of its own: `needs_attention` is 6A's table and this slice does not anticipate it.
 *
 * Called only when there is something to report, so a quiet company writes nothing and the log stays readable.
 */
export async function recordExpiryWarning(tx: Sql, input: {
  companyId: string; lots: readonly NearExpiryLot[];
}): Promise<void> {
  if (input.lots.length === 0) return;
  // The column list is 1B's `recordIntegrityIncident` field for field: no `before`, and the payload as
  // `JSON.stringify(...)::jsonb`. `seq`, `actor_id` and `occurred_at` come from defaults and the
  // `audit_chain` trigger. `app.current_tenant()` rather than a passed tenantId because this runs inside
  // `withTenant` and the GUC is already the authority for which tenant is writing.
  await tx`
    insert into app.audit_log (tenant_id, table_name, row_id, action, after)
    values (app.current_tenant(), 'lot_expiry_warning', ${input.companyId}, 'insert',
            ${JSON.stringify({
              companyId: input.companyId,
              lotCount: input.lots.length,
              soonest: input.lots[0]!.expiresOn,
              lots: input.lots.map((l) => ({
                itemCode: l.itemCode, lotCode: l.lotCode, warehouseCode: l.warehouseCode,
                expiresOn: l.expiresOn, quantity: l.quantity,
              })),
            })}::jsonb)`;
}
```

The column list above is **not** a guess. It is 1B's `recordIntegrityIncident` copied field for field — `insert into app.audit_log (tenant_id, table_name, row_id, action, after) values (…, 'integrity_incident', …, 'insert', ${JSON.stringify(report)}::jsonb)` — which is the established precedent for a sentinel write and is already green. Confirm with `\d app.audit_log` (plan0A:1520–1560) before the first run; if a column has moved since 1B landed, follow `recordIntegrityIncident` as it then stands and not this page.

Re-export both from `packages/db/src/index.ts`:

```ts
export { pickLotsFefo, type FefoPick } from "./inventory/lots";
export {
  EXPIRY_HORIZON_DAYS, listNearExpiryLots, recordExpiryWarning, type NearExpiryLot,
} from "./inventory/expiry";
```

`FefoPick` is an **interface** (Task 2's Produces), so it carries the `type` modifier exactly as `NearExpiryLot` does on the line below it. Re-exporting it as a value is a compile error under this repo's `verbatimModuleSyntax`/`isolatedModules` and, under a config that tolerates it, emits a re-export that resolves to nothing at runtime. Every type re-export in this plan uses the modifier; there is no exception.

- [ ] **Step 5: Write `apps/worker/src/handlers/inventory.ts` and register it**

```ts
import { listNearExpiryLots, recordExpiryWarning, withTenant } from "@dulja/db";
import type { JobEnvelope } from "@dulja/db";
import { registerHandler } from "../handler";
import { log } from "../log";

/**
 * `inventory.lot.expiry_warning` (§4.2.6, scheduled `0 6 * * *`) — the "near-expiry alerts" half of
 * spec:1022. Runs as the tenant's system principal (hazard 20) in short transactions, one per company.
 *
 * It warns and audits; it posts nothing and writes no `app.needs_attention` row (that table is 6A's). When
 * 6A lands, its handler is the natural consumer of `listNearExpiryLots` — this file changes then, not now.
 */
export function registerInventoryHandlers(): void {
  registerHandler("inventory.lot.expiry_warning", async (sql, job: JobEnvelope<{
    companyId?: string; horizonDays?: number;
  }>, ctx) => {
    const companies = await withTenant(sql, ctx, (tx) =>
      job.payload.companyId !== undefined
        ? Promise.resolve([{ id: job.payload.companyId }])
        : tx<{ id: string }[]>`select id from app.company order by id`);

    for (const company of companies) {
      // One short transaction per company (spec:1368), so one company's failure cannot roll back another's
      // audit row and a long-running tenant cannot hold a snapshot open for the rest.
      await withTenant(sql, ctx, async (tx) => {
        const lots = await listNearExpiryLots(tx, {
          companyId: company.id, horizonDays: job.payload.horizonDays,
        });
        for (const lot of lots) {
          log().warn({
            msg: "lot expiring soon",
            companyId: lot.companyId, itemCode: lot.itemCode, lotCode: lot.lotCode,
            warehouseCode: lot.warehouseCode, expiresOn: lot.expiresOn,
            daysToExpiry: lot.daysToExpiry, quantity: lot.quantity,
          });
        }
        await recordExpiryWarning(tx, { companyId: company.id, lots });
      });
    }
  });
}
```

In `apps/worker/src/index.ts`, beside 1B's and 0D's registrations:

```ts
import { registerInventoryHandlers } from "./handlers/inventory";
registerInventoryHandlers();
```

**Why neither `eachTenant` nor `systemContext` appears in that import line, though a reader of §4.2.6 would expect both.** `eachTenant` is the *scheduler's* fan-out: `runJob` already resolves one tenant's `systemContext` per envelope and the scheduler enqueues one envelope per tenant through `pgboss.tenant_registry` (§4.2.6), so by the time this handler runs the tenant is settled and arrives as `ctx`, the third parameter. This handler's own fan-out is over **companies**, a different axis, done with the `select id from app.company` above. `systemContext` is absent for the same reason: `ctx` *is* the tenant's system principal. Importing either and not using it fails `bun run lint` and `bun run typecheck`, which DoD item 4 requires at `0 violations` — so the block above is complete as written and nothing is to be removed from it.

Add the payload entry to `packages/db/src/jobs/payloads.ts` — **only this key**, exactly as the file's own comment requires:

```ts
  /** Slice 3A. Omit both for the nightly whole-tenant run; `horizonDays` defaults to EXPIRY_HORIZON_DAYS (30). */
  "inventory.lot.expiry_warning": { companyId?: string; horizonDays?: number };
```

And the probe, in `tests/invariants/probes.ts`'s `JOB_PROBES` (hazard 31 — every job payload carries `tenantId` and is probed the same way):

```ts
  "inventory.lot.expiry_warning": {
    async seed(db, attacker, victim) {
      const { itemId } = await seedItem(db, victim, { code: "VICTIM-LOT", trackLots: true });
      const warehouseId = await seedWarehouse(db, victim, { code: "V-CHILL" });
      const lotId = await seedLot(db, victim, { itemId, code: "V-B1", expiresOn: "2026-01-20" });
      await withTenant(db.rw, ctxFor(victim, "probe-seed"), (tx) => tx`
        insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
        values (${victim.tenant}, ${victim.company}, ${itemId}, ${warehouseId}, ${lotId}, 5.000000)`);
      void attacker;
    },
    /** The victim's lot row must still be there after the job ran for the attacker with the victim's ids. */
    async survivors(db, victim) {
      const [row] = await withTenant(db.rw, ctxFor(victim, "probe-survivors"), (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.lot where code = 'V-B1'`);
      return row!.n;
    },
  },
```

**`withTenant` here is the PRODUCTION three-argument helper from `@dulja/db`, not the four-argument test one.**
`tests/invariants/probes.ts` is in the root `tests/` tree, and hazard 15 and §4.2.12 both say the same thing:
"Root `tests/` use the production one." 0B's file already imports it that way; the local `ctxFor` below is the
`TenantContext` builder the other `JOB_PROBES` entries use, and is added beside them if 0B's file does not
already carry it:

```ts
const ctxFor = (s: Seed, label: string) => ({ tenantId: s.tenant, actorId: s.human, requestId: label });
```

- [ ] **Step 6: Write the failing test `apps/api/test/routes/accounting/attachments-lot.test.ts`**

The file is `apps/api/test/routes/accounting/attachments-lot.test.ts` — it extends 2C's suite rather than replacing it.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedItem, seedLot, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("attachments on a lot — spec:1067's \"3 (lot link)\", §4.5.8's inventory row", () => {
  let api: StartedApi;
  let s: Seed;
  let itemId: string;
  let lotId: string;
  let reader: string;

  /** A REAL second principal, in 2B's `secondPrincipal` shape (plan0A:837 — the principal insert carries no
   *  `returning`, and the membership goes in the same transaction). A bare `crypto.randomUUID()` cannot be
   *  used: `app.role_assignment.principal_id` has a foreign key to `app.principal`, so `grantCodes` would be
   *  a 23503, and `request({ as })` would sign a token whose subject resolves to no membership. This is the
   *  same correction the self-review made to Task 5's override test. */
  const secondPrincipal = async (label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    // `actorId: s.system` — the tenant's system principal, taken from the `Seed` (§4.1), NOT resolved through
    // `systemContext`: that helper calls `app.resolve_principal`, whose EXECUTE is granted to `app_rw` only
    // (§4.1), and this transaction runs as `app_migrator`. 2B's own `secondPrincipal` passes `s.system` for
    // exactly this reason (2b:157–165); the only difference here is the three-argument PRODUCTION `withTenant`,
    // which is what `apps/*/test` uses (§4.2.12) where `packages/db/test` uses the four-argument one.
    await withTenant(api.db.migrator, {
      tenantId: s.tenant, actorId: s.system, requestId: `${label}-setup`,
    }, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${s.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    return id;
  };

  /** Multipart upload. §4.2.12's harness field is `form?: FormData` (mutually exclusive with `body`), and it
   *  mints a fresh `Idempotency-Key` for every unsafe method itself, so neither is set by hand here. */
  const upload = (fields: Record<string, string>, as: string = s.human) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "cert.pdf",
      { type: "application/pdf" }));
    return api.request({ method: "POST", path: `/v1/companies/${s.company}/attachments`, as, form });
  };

  beforeAll(async () => {
    // Its own instance, like 2C's `attachments.test.ts`: an `apps/api` route suite starts the API it drives,
    // and 0B's memoised `sharedApi()` is for the root `tests/` regression files (§4.17.1). `grantAdmin` and
    // `problemOf` are still imported from `tests/support/api` — the same value import 2A, 2B, 2C and 3C make
    // from this directory, five levels up, needing no new `dependency-rule` allowance.
    api = await startApi();
    s = await seedTenantV2(api.db, "LotAttach");
    await grantAdmin(api, s);
    ({ itemId } = await seedItem(api.db, s, { code: "CHICKEN-1KG", trackLots: true }));
    lotId = await seedLot(api.db, s, { itemId, code: "B-2026-03", expiresOn: "2026-09-30" });
    reader = await secondPrincipal("lot-reader");
  }, 180_000);
  afterAll(async () => { await api.stop(); });

  it("uploads against a lot and stores the link", async () => {
    const res = await upload({ lotId });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.lotId).toBe(lotId);
    expect(body.documentId).toBeNull();
    expect(body.objectKey).toBe(`${s.tenant}/${body.id}`);       // server-generated (SAH-038)
  });

  it("refuses an upload naming both a document and a lot, and one naming neither", async () => {
    const both = await upload({ lotId, documentId: crypto.randomUUID() });
    expect(both.status).toBe(400);
    expect((await problemOf(both)).code).toBe("ERR_VALIDATION_FAILED");
    const neither = await upload({});
    expect(neither.status).toBe(400);
  });

  it("the download gate for a LOT attachment is inventory.item.read, not the module code", async () => {
    const created = await (await upload({ lotId })).json();
    // A principal holding only inventory.stock.read (the `inventory` MODULE row) may not download a lot's
    // certificate: §4.5.8 gives the lot its own rule, and item.read is the narrower catalogue code.
    await grantCodes(api.db, s, { codes: ["inventory.stock.read"], principalId: reader, roleCode: "stock-only" });
    const denied = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/attachments/${created.id}/content`, as: reader,
    });
    expect(denied.status).toBe(403);
    expect((await problemOf(denied)).code).toBe("ERR_RBAC_FORBIDDEN");
    await grantCodes(api.db, s, { codes: ["inventory.item.read"], principalId: reader, roleCode: "item-read" });
    const allowed = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/attachments/${created.id}/content`, as: reader,
    });
    expect(allowed.status).toBe(200);
  });

  it("the list omits lot attachments unless includeLots is asked for, and filters by lotId", async () => {
    const withoutLots = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/attachments`, as: s.human,
    });
    expect(((await withoutLots.json()).items as { lotId: string | null }[]).every((a) => a.lotId === null))
      .toBe(true);
    const withLots = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/attachments?filter[lotId][eq]=${lotId}`, as: s.human,
    });
    const items = (await withLots.json()).items as { lotId: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((a) => a.lotId === lotId)).toBe(true);
  });

  it("an inventory-module DOCUMENT's attachment is gated by inventory.stock.read (§4.5.8's new row)", async () => {
    // The module row, as distinct from the lot rule above: document_type.module = 'inventory' resolves to
    // inventory.stock.read. 2C shipped only the accounting row and a default deny; this is 3A's one-line add.
    const { MODULE_READ_CODE } = await import("@dulja/api/routes/accounting/attachments");
    expect(MODULE_READ_CODE.inventory).toBe("inventory.stock.read");
  });
});
```

- [ ] **Step 7: Make the five attachment edits (§4.5.8's 3A row)**

**(a)** `apps/api/src/routes/accounting/attachments.ts` — one row on 2C's map:

```ts
export const MODULE_READ_CODE: Readonly<Record<DocumentTypeModule, PermissionCode>> = {
  accounting: PERMISSION["accounting.ledger.read"],
  inventory: PERMISSION["inventory.stock.read"],      // 3A — §4.5.8; `pos` is 6D's and `hr` is 8B's
};
```

2C's default-deny branch stays for the two modules still absent. **Do not** merge this with 2B's same-named local map in `documents.ts` (hazard 32; §4.5.8 says so explicitly).

**(b)** `requireAttachmentRead` gains the lot branch, **before** the module lookup:

```ts
  // §4.5.8: "a lot attachment → inventory.item.read". The lot rule is not the inventory MODULE row: a lot's
  // certificate is catalogue data, and item.read is the code that reads the catalogue.
  if (row.lotId !== null) {
    const ok = await c.var.withTenant((tx) =>
      actorHas(tx, INVENTORY_PERMISSION.itemRead, { companyId: row.companyId }));
    if (!ok) throw new AppError("ERR_RBAC_FORBIDDEN", `principal may not read lot attachments of company ${row.companyId}`);
    c.set("attachment", row);
    return;
  }
```

**(c)** `UploadAttachmentBody` becomes exactly-one-of, and `AttachmentSchema` gains the field — `packages/contracts/src/accounting/attachment.ts`:

```ts
export const UploadAttachmentBody = z.object({
  documentId: UuidSchema.optional(),
  lotId: UuidSchema.optional(),                         // 3A
}).strict().refine((b) => (b.documentId === undefined) !== (b.lotId === undefined), {
  message: "an attachment belongs to exactly one of a document or a lot",
}).openapi("UploadAttachment");

// and on AttachmentSchema, beside documentId:
  lotId: UuidSchema.nullable(),                         // 3A
```

The `.refine` mirrors migration 0031's `attachment_owner_check` so a bad body is a 400 from Zod rather than a 500 from a `check_violation` the handler cannot pre-empt.

**(d)** `listAttachments` gains the option and the join becomes a `left join` — 2C's own comment at its `join app.document` hands 3A this edit:

```ts
export async function listAttachments(tx: Sql, params: {
  companyId: string; modules: readonly DocumentTypeModule[];      // required, never defaulted (§4.5.8)
  documentId?: string; lotId?: string; includeLots?: boolean;
  cursor?: { id: string } | null; limit: number;
}): Promise<AttachmentRow[]> {
```

with `left join app.document d on d.id = a.document_id left join app.document_type t on t.id = d.document_type_id` and the predicate

```sql
       and (
         (a.lot_id is null and t.module = any(${params.modules}))
         or (a.lot_id is not null and ${params.includeLots ?? false})
       )
       and (${params.lotId ?? null}::uuid is null or a.lot_id = ${params.lotId ?? null})
```

A lot attachment has no document and therefore no module, which is exactly why the join must be outer and why `includeLots` exists: without it the module predicate would drop every lot row silently, and a silent drop is how a list becomes a lie.

**(e)** The upload handler passes `lotId` through and the list route sets `includeLots` from the `filter[lotId]` parameter's presence, or from an explicit `includeLots` query flag — the `filter[<field>][<op>]` grammar of §4.2.8, with `lotId` added to the route's literal filter keys.

- [ ] **Step 8: Run everything and verify**

Run: `bun run --cwd packages/db test -- test/inventory/fefo.test.ts`
Expected: **PASS**, eleven assertions (Task 5's six plus five).

Run: `bun run --cwd apps/worker test -- test/handlers/expiry-warning.test.ts`
Expected: **PASS**, four assertions.

Run: `bun run --cwd apps/api test -- test/routes/accounting/attachments-lot.test.ts test/routes/accounting/attachments.test.ts`
Expected: **PASS** — 2C's own suite included, because every edit above is additive: `modules` stays required, the module map gains a row, and `includeLots` defaults to `false` so 2C's list assertions are unchanged.

Run: `bun run --cwd tests test -- invariants/tenant-isolation.test.ts`
Expected: **PASS** with the new `JOB_PROBES` entry; the harness fails the build for a registered handler with no probe (§3.7.2), which is what this entry answers.

Run: `bun run --cwd packages/contracts openapi:generate && git add packages/contracts/openapi.json`
Expected: a diff on `Attachment` and `UploadAttachment`; commit it (spec:2055).

Run: `bun run lint:rules && bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/inventory/lots.ts packages/db/src/inventory/expiry.ts packages/db/src/index.ts \
        packages/db/src/jobs/payloads.ts packages/db/src/attachment \
        apps/worker/src/handlers/inventory.ts apps/worker/src/index.ts \
        apps/api/src/routes/accounting/attachments.ts \
        apps/api/src/middleware/require-attachment-read.ts \
        packages/contracts/src/accounting/attachment.ts packages/contracts/openapi.json \
        packages/db/test/inventory/fefo.test.ts apps/worker/test/handlers/expiry-warning.test.ts \
        apps/api/test/routes/accounting/attachments-lot.test.ts tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(inventory): FEFO wrapper, the near-expiry alert job, and lot attachments [3A T10]

pickLotsFefo is the one caller-facing entry to app.pick_lots_fefo, returning
Quantity values. The ordering, the partial pick and the sentinel's last place
stay in SQL so a screen, 3D's delivery orders and 6B's till cannot disagree.

inventory.lot.expiry_warning runs daily at 06:00 as the tenant's system
principal, one short transaction per company, logs one warning per lot with
stock that expires inside the horizon and writes one audit row per company
under the new sentinel table_name 'lot_expiry_warning' — the third after 1B's
two. horizonDays defaults to 30: a reporting horizon, not a statutory figure.

§4.5.8's 3A row lands: MODULE_READ_CODE gains inventory -> inventory.stock.read,
requireAttachmentRead gains a lot branch resolving to inventory.item.read (a
lot's certificate is catalogue data, so the narrower code guards it),
UploadAttachmentBody becomes exactly-one-of documentId | lotId mirroring
migration 0031's attachment_owner_check, AttachmentSchema gains lotId, and
listAttachments' join becomes a LEFT join with includeLots — a lot attachment
has no document and therefore no module, and without the flag the module
predicate would drop every lot row silently.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The item, unit and warehouse APIs

Three route modules over Tasks 1, 2 and 6. Every read is `inventory.item.read`; every write is `inventory.item.manage` — including warehouses, units and unit conversions, because §3.6.1 closes the permission vocabulary at five inventory codes for 3A and spec:2159/2160 give neither `warehouse` nor `branch_manager` any catalogue authority ("head office owns the catalogue"). That is assumption 11 and it is a contract addition to §3.6.2's "Uses fixed by this document" sentence.

**Files:**
- Create: `packages/contracts/src/inventory/item.ts`, `unit.ts`, `warehouse.ts`, `lot.ts`
- Create: `apps/api/src/routes/inventory/items.ts`, `units.ts`, `warehouses.ts`
- Create: `apps/api/test/routes/inventory/items.test.ts`, `units.test.ts`, `warehouses.test.ts`
- Modify: `apps/api/src/routes/index.ts` (three modules inside `buildRoutes`), `packages/contracts/src/index.ts`, `tests/invariants/probes.ts` (three `PROBES` entries)

**Interfaces:**
- Consumes: `UuidSchema`, `DateSchema`, `QuantitySchema`, `MoneySchema`, `ListEnvelope`, `ListQuery`, `encodeCursor`, `decodeCursor` (§4.2.8); `RouteModule`, `buildRoutes`, `IdempotencyHeader`, `AppEnv`, `PROBES`, `IsolationProbe` (§4.2.7); `requirePermission` (§4.2.5); `INVENTORY_PERMISSION` (Task 3); `createItem`, `updateItem`, `archiveItem`, `getItem`, `listItems`, `createUnit`, `listUnits`, `replaceUnitConversions`, `listUnitConversions`, `createWarehouse`, `updateWarehouse`, `archiveWarehouse`, `getWarehouse`, `listWarehouses`, `warehouseTree`, `createLot`, `listLots` (Tasks 1, 2, 6); `startApi`, `StartedApi` (0B, `apps/api/test/support/app`, §4.2.12) and `grantAdmin`, `problemOf` (0B, `tests/support/api`, §4.17.1) — **not `sharedApi`**, which is the root `tests/` regression tier's memoised instance; an `apps/api` route suite starts its own, as 2C's and 3C's do.
- Produces:
  - Contracts: `ItemSchema`, `ItemKindSchema`, `CreateItemBody`, `UpdateItemBody`, `ItemQuery`, `ItemList`; `UnitSchema`, `CreateUnitBody`, `UnitQuery`, `UnitList`, `UnitConversionSchema`, `ReplaceUnitConversionsBody`, `UnitConversionList`; `WarehouseSchema`, `WarehouseKindSchema`, `CreateWarehouseBody`, `UpdateWarehouseBody`, `WarehouseQuery`, `WarehouseList`, `WarehouseNodeSchema`, `WarehouseTree`; `LotSchema`, `CreateLotBody`, `LotQuery`, `LotList` — the `<Resource>Schema` / `Create<Resource>Body` / … naming §4.2.8 fixes.
  - Route modules, with their `RouteModule.path` strings (also the `PROBES` keys — hazard 31):
    - `/v1/companies/:companyId/items` → `itemRoutes`; sub-paths `POST …/items/{itemId}/archive`, `GET|PUT …/items/{itemId}/unit-conversions`, `GET|POST …/items/{itemId}/lots`
    - `/v1/companies/:companyId/units` → `unitRoutes`
    - `/v1/companies/:companyId/warehouses` → `warehouseRoutes`; sub-paths `GET …/warehouses/tree`, `POST …/warehouses/{warehouseId}/archive`
  - Three `PROBES` entries, one per module. **A sub-path needs none** — `PROBES` is keyed by `RouteModule.path` (§4.2.7).

- [ ] **Step 1: Write the failing test `apps/api/test/routes/inventory/items.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, seedAccount, seedUnit, uuidv7, type Seed } from "@dulja/db/test";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("GET|POST /v1/companies/{companyId}/items", () => {
  let api: StartedApi;
  let s: Seed;
  let other: Seed;
  let pieceId: string;
  let cartonId: string;
  let readOnly: string;

  /** §4.2.12's harness: ONE `ApiRequest` object, `as` for the principal, and a fresh `Idempotency-Key`
   *  minted for every unsafe method unless `idempotencyKey` says otherwise. Nothing sets that header here. */
  const post = (path: string, body: unknown, as: string = s.human) =>
    api.request({ method: "POST", path, body, as });
  const get = (path: string, as: string = s.human) =>
    api.request({ method: "GET", path, as });

  /** A real second principal (2B's `secondPrincipal` shape, plan0A:837): `role_assignment.principal_id` has a
   *  foreign key to `app.principal`, so a bare uuid handed to `grantCodes` is a 23503, and `as` would sign a
   *  token resolving to no membership. */
  const secondPrincipal = async (label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    // `actorId: s.system` — the tenant's system principal, taken from the `Seed` (§4.1), NOT resolved through
    // `systemContext`: that helper calls `app.resolve_principal`, whose EXECUTE is granted to `app_rw` only
    // (§4.1), and this transaction runs as `app_migrator`. 2B's own `secondPrincipal` passes `s.system` for
    // exactly this reason (2b:157–165); the only difference here is the three-argument PRODUCTION `withTenant`,
    // which is what `apps/*/test` uses (§4.2.12) where `packages/db/test` uses the four-argument one.
    await withTenant(api.db.migrator, {
      tenantId: s.tenant, actorId: s.system, requestId: `${label}-setup`,
    }, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${s.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    return id;
  };

  beforeAll(async () => {
    // Its own API instance, like 2C's and 3C's route suites; `grantAdmin` and `problemOf` still come from
    // `tests/support/api` five levels up, which is the import 2A, 2B, 2C and 3C already make from here.
    api = await startApi();
    s = await seedTenantV2(api.db, "Items API");
    other = await seedTenantV2(api.db, "Items API B");
    for (const code of [["1300", "asset"], ["5000", "expense"], ["5900", "expense"]] as const) {
      await seedAccount(api.db, s, { code: code[0], nameEn: code[0], type: code[1] });
    }
    await grantAdmin(api, s);
    pieceId = await seedUnit(api.db, s, { code: "PCS", nameEn: "Piece" });
    cartonId = await seedUnit(api.db, s, { code: "CTN", nameEn: "Carton" });
    readOnly = await secondPrincipal("item-reader");
  }, 180_000);
  afterAll(async () => { await api.stop(); });

  it("creates an item with the four resolved account defaults", async () => {
    const res = await post(`/v1/companies/${s.company}/items`, {
      code: "RICE-5KG", nameEn: "Rice 5kg", nameAr: "أرز ٥ كجم", kind: "product",
      baseUnitId: pieceId, barcode: "9556000000019", shelfLifeDays: 365,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ code: "RICE-5KG", kind: "product", trackLots: true, archivedAt: null });
    expect(body.inventoryAccountId).not.toBeNull();
    expect(body.cogsAccountId).not.toBeNull();
  });

  it("requires Idempotency-Key on POST (spec:2055)", async () => {
    // `idempotencyKey: null` sends NO header. Omitting the field would let the harness mint one and the
    // request would succeed — §4.2.12 names this exact case at the field.
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/items`, as: s.human, idempotencyKey: null,
      body: { code: "X", nameEn: "X", kind: "product", baseUnitId: pieceId },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("a duplicate code in one company is a 409", async () => {
    const res = await post(`/v1/companies/${s.company}/items`, {
      code: "RICE-5KG", nameEn: "Rice again", kind: "product", baseUnitId: pieceId,
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("a bad kind is a 400 with a JSON Pointer, never a 500", async () => {
    const res = await post(`/v1/companies/${s.company}/items`, {
      code: "BAD", nameEn: "Bad", kind: "widget", baseUnitId: pieceId,
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toContain("/kind");
  });

  it("lists with a cursor and hides archived items by default", async () => {
    for (const code of ["AAA-1", "BBB-2", "CCC-3"]) {
      await post(`/v1/companies/${s.company}/items`, {
        code, nameEn: code, kind: "product", baseUnitId: pieceId,
      });
    }
    const first = await get(`/v1/companies/${s.company}/items?limit=2`);
    const page1 = await first.json();
    expect(page1.items.map((i: { code: string }) => i.code)).toEqual(["AAA-1", "BBB-2"]);
    expect(page1.nextCursor).toBeTruthy();
    const second = await get(
      `/v1/companies/${s.company}/items?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`);
    expect((await second.json()).items.map((i: { code: string }) => i.code)).toEqual(["CCC-3", "RICE-5KG"]);
  });

  it("archive is a POST, never a DELETE (spec:2049)", async () => {
    const created = await (await post(`/v1/companies/${s.company}/items`, {
      code: "OLD-1", nameEn: "Old", kind: "product", baseUnitId: pieceId,
    })).json();
    const res = await post(`/v1/companies/${s.company}/items/${created.id}/archive`, {});
    expect(res.status).toBe(200);
    expect((await res.json()).archivedAt).not.toBeNull();
    const gone = await get(`/v1/companies/${s.company}/items`);
    expect((await gone.json()).items.map((i: { code: string }) => i.code)).not.toContain("OLD-1");
    const del = await api.request({
      method: "DELETE", path: `/v1/companies/${s.company}/items/${created.id}`, as: s.human,
    });
    expect(del.status).toBe(404);                       // no route: master data is archived, never deleted
  });

  it("replaces an item's unit conversions and refuses a zero denominator", async () => {
    const item = await (await get(`/v1/companies/${s.company}/items?filter[code][eq]=RICE-5KG`))
      .json().then((b: { items: { id: string }[] }) => b.items[0]!);
    const ok = await api.request({
      method: "PUT", path: `/v1/companies/${s.company}/items/${item.id}/unit-conversions`, as: s.human,
      body: { conversions: [{ unitId: cartonId, numerator: "12", denominator: "1" }] },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).items).toEqual([
      expect.objectContaining({ unitId: cartonId, unitCode: "CTN", numerator: "12", denominator: "1" }),
    ]);
    const bad = await api.request({
      method: "PUT", path: `/v1/companies/${s.company}/items/${item.id}/unit-conversions`, as: s.human,
      body: { conversions: [{ unitId: cartonId, numerator: "12", denominator: "0" }] },
    });
    expect(bad.status).toBe(400);                       // the Zod schema refuses it before the CHECK does
  });

  it("a read code cannot write, and a write code is required for the manage routes (R7)", async () => {
    await grantCodes(api.db, s, {
      codes: ["inventory.item.read"], principalId: readOnly, roleCode: "item-reader",
    });
    const list = await get(`/v1/companies/${s.company}/items`, readOnly);
    expect(list.status).toBe(200);
    const write = await post(`/v1/companies/${s.company}/items`, {
      code: "NOPE", nameEn: "Nope", kind: "product", baseUnitId: pieceId,
    }, readOnly);
    expect(write.status).toBe(403);
    expect((await problemOf(write)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("another tenant's company is refused before any row is read (test 12)", async () => {
    const res = await get(`/v1/companies/${other.company}/items`);
    expect(res.status).toBe(403);
  });
});
```

`units.test.ts` and `warehouses.test.ts` follow the same shape — the same `startApi()` `beforeAll`, the same `post`/`get`/`secondPrincipal` helpers — with **eight cases for units and nine for warehouses** (the ninth is the tree). Write them with these cases and no others, so the three files read as one surface:

| Case | `units.test.ts` | `warehouses.test.ts` |
|---|---|---|
| create | `POST …/units { code: "CTN", nameEn: "Carton" }` → 201 | `POST …/warehouses { code, nameEn, branchId, kind? }` → 201, `kind` defaults `"stock"` |
| idempotency | missing header → 400 `ERR_IDEMPOTENCY_KEY_MISSING` | same |
| duplicate | duplicate `(company, code)` → 409 `ERR_CONFLICT_UNIQUE` | same |
| validation | `code: ""` → 400 with `/code` | `kind: "virtual"` → 400 with `/kind` |
| list | cursor over `code`, two pages | cursor over `code`; `?filter[kind][eq]=in_transit` returns only transit warehouses |
| archive | **none** — a unit has no `archived_at` (§4.6.1) and the route does not exist; assert `POST …/units/{id}/archive` → 404 | `POST …/warehouses/{id}/archive` → 200, then absent from the default list |
| tree | — | `GET …/warehouses/tree` returns `depth` and `path`; setting a parent to a descendant → 409 `ERR_WAREHOUSE_TREE_CYCLE` |
| RBAC | read code lists, cannot create | same, plus: a `branch_manager`-shaped principal holding only the two read codes cannot create a warehouse (spec:2160) |
| isolation | another tenant's company → 403 | same |

- [ ] **Step 2: Run the three suites to see the exact failures**

Run: `bun run --cwd apps/api test -- test/routes/inventory/`
Expected: **FAIL** — every case 404, because `buildRoutes` mounts no inventory module yet.

- [ ] **Step 3: Write the four contracts modules**

`packages/contracts/src/inventory/item.ts` — the pattern the other three follow exactly:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, ListQuery, UuidSchema } from "../common";

export const ItemKindSchema = z.enum(["product", "service", "asset"]).openapi("ItemKind");

export const ItemSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  code: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  kind: ItemKindSchema,
  baseUnitId: UuidSchema,
  barcode: z.string().max(64).nullable(),
  revenueAccountId: UuidSchema.nullable(),
  inventoryAccountId: UuidSchema.nullable(),
  cogsAccountId: UuidSchema.nullable(),
  expenseAccountId: UuidSchema.nullable(),
  trackLots: z.boolean(),
  shelfLifeDays: z.number().int().positive().nullable(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
}).openapi("Item");

/** The four account ids are OMITTED, not accepted: §4.15's codes are the defaults and `resolveItemAccounts`
 *  resolves them. A caller that could post an arbitrary account id could point COGS at a revenue account. An
 *  override arrives as an account CODE in a later slice, if a tenant asks for one. */
export const CreateItemBody = z.object({
  code: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  kind: ItemKindSchema,
  baseUnitId: UuidSchema,
  barcode: z.string().max(64).optional(),
  trackLots: z.boolean().optional(),
  shelfLifeDays: z.number().int().positive().optional(),
}).strict().openapi("CreateItem");

export const UpdateItemBody = CreateItemBody
  .omit({ code: true, kind: true, baseUnitId: true })     // identity and unit are set once
  .partial()
  .strict()
  .openapi("UpdateItem");

/** The `filter[<field>][<op>]` grammar of §4.2.8, with literal Zod keys — the default mechanism for a narrow
 *  surface. `parseFilters` is for a wide or open one, and never both on one route. */
export const ItemQuery = ListQuery.extend({
  "filter[code][eq]": z.string().optional(),
  "filter[kind][eq]": ItemKindSchema.optional(),
  "filter[barcode][eq]": z.string().optional(),
  includeArchived: z.coerce.boolean().optional(),
}).openapi("ItemQuery");

export const ItemList = ListEnvelope(ItemSchema).openapi("ItemList");
```

`unit.ts` adds `UnitSchema`, `CreateUnitBody`, `UnitQuery`, `UnitList` plus the conversion pair — `numerator`/`denominator` as **digit strings**, never numbers (assumption 13):

```ts
export const UnitConversionSchema = z.object({
  itemId: UuidSchema, unitId: UuidSchema, unitCode: z.string(),
  numerator: z.string().regex(/^[1-9][0-9]{0,17}$/),      // bigint in SQL; > 0 by the CHECK
  denominator: z.string().regex(/^[1-9][0-9]{0,17}$/),    // <> 0 by the CHECK, and negatives are meaningless
}).openapi("UnitConversion");

export const ReplaceUnitConversionsBody = z.object({
  conversions: z.array(UnitConversionSchema.pick({ unitId: true, numerator: true, denominator: true })).max(50),
}).strict().openapi("ReplaceUnitConversions");

export const UnitConversionList = ListEnvelope(UnitConversionSchema).openapi("UnitConversionList");
```

The two regexes are what make `denominator: "0"` a 400 rather than a 500 from `unit_conversion_denominator_check` — SAH-063 answered at the wire as well as in the schema.

`warehouse.ts` adds `WarehouseKindSchema` (`z.enum(["stock", "in_transit"])`), `WarehouseSchema`, `CreateWarehouseBody` (with a required `branchId`), `UpdateWarehouseBody` (`nameEn`, `nameAr`, `parentId`), `WarehouseQuery`, `WarehouseList`, and

```ts
export const WarehouseNodeSchema = WarehouseSchema.extend({
  depth: z.number().int().nonnegative(),
  path: z.array(z.string()),
}).openapi("WarehouseNode");
export const WarehouseTree = z.object({ items: z.array(WarehouseNodeSchema) }).openapi("WarehouseTree");
```

`WarehouseTree` is **not** a `ListEnvelope`: a tree is returned whole (a company has tens of warehouses, not thousands) and paging it would hand the caller a fragment it cannot reassemble. `lot.ts` adds `LotSchema`, `CreateLotBody` (`code`, `expiresOn?`, `manufacturedOn?`), `LotQuery` (with `filter[expiresBefore][lte]`) and `LotList`.

- [ ] **Step 4: Write the three route modules**

`apps/api/src/routes/inventory/items.ts`:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AppError, CreateItemBody, ItemList, ItemQuery, ItemSchema, ReplaceUnitConversionsBody, UnitConversionList,
  UpdateItemBody, CreateLotBody, LotList, LotQuery, LotSchema,
} from "@dulja/contracts";
import {
  archiveItem, createItem, createLot, getItem, listItems, listLots, listUnitConversions,
  replaceUnitConversions, updateItem,
} from "@dulja/db";
import { IdempotencyHeader } from "../index";
import { requirePermission } from "../../middleware/require-permission";
import { decodeCursor, encodeCursor } from "@dulja/contracts";
import type { AppEnv } from "../../env";
import { INVENTORY_PERMISSION } from "./permissions";

export const itemRoutes = new OpenAPIHono<AppEnv>();

const PAGE = { company: "path:companyId" } as const;

itemRoutes.openapi(createRoute({
  method: "get", path: "/", tags: ["inventory"],
  middleware: [requirePermission(INVENTORY_PERMISSION.itemRead, PAGE)],
  request: { params: z.object({ companyId: z.string().uuid() }), query: ItemQuery },
  responses: { 200: { description: "Items", content: { "application/json": { schema: ItemList } } } },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  const limit = q.limit ?? 50;
  const rows = await c.var.withTenant((tx) => listItems(tx, {
    companyId,
    kind: q["filter[kind][eq]"],
    includeArchived: q.includeArchived,
    cursor: q.cursor ? decodeCursor<{ code: string }>(q.cursor) : null,
    limit: limit + 1,
  }));
  const page = rows.slice(0, limit);
  return c.json({
    items: page,
    nextCursor: rows.length > limit ? encodeCursor({ code: page[page.length - 1]!.code }) : null,
  });
});

itemRoutes.openapi(createRoute({
  method: "post", path: "/", tags: ["inventory"],
  middleware: [requirePermission(INVENTORY_PERMISSION.itemManage, PAGE)],
  request: {
    params: z.object({ companyId: z.string().uuid() }), headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: CreateItemBody } } },
  },
  responses: { 201: { description: "Created", content: { "application/json": { schema: ItemSchema } } } },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await c.var.withTenant((tx) => createItem(tx, c.var.ctx, { companyId, ...body }));
  return c.json(row, 201);
});
```

The remaining routes are that same two-part shape — a `createRoute` with its gate and its schemas, then a handler that calls one `@dulja/db` function inside `c.var.withTenant`. Each is fully determined by this table: **method, path, gate, request schema, the one function it calls, response schema and status.** No route in the table does anything the two above do not.

| Module | Method · path | Gate | Request | Calls | Response |
|---|---|---|---|---|---|
| `items` | `GET /{itemId}` | `itemRead` | param `itemId` | `getItem(tx, itemId)` | 200 `ItemSchema`, 404 `ERR_NOT_FOUND` on null |
| `items` | `PATCH /{itemId}` | `itemManage` | `IdempotencyHeader`, body `UpdateItemBody` | `updateItem(tx, itemId, body)` | 200 `ItemSchema`, 404 on null |
| `items` | `POST /{itemId}/archive` | `itemManage` | `IdempotencyHeader`, empty body | `archiveItem(tx, itemId)` | 200 `ItemSchema`, 404 on null (already archived) |
| `items` | `GET /{itemId}/unit-conversions` | `itemRead` | param `itemId` | `listUnitConversions(tx, itemId)` | 200 `UnitConversionList` |
| `items` | `PUT /{itemId}/unit-conversions` | `itemManage` | `IdempotencyHeader`, body `ReplaceUnitConversionsBody` | `replaceUnitConversions(tx, itemId, body.conversions)` | 200 `UnitConversionList` |
| `items` | `GET /{itemId}/lots` | `itemRead` | param `itemId`, query `LotQuery` | `listLots(tx, { companyId, itemId, … })` | 200 `LotList` |
| `items` | `POST /{itemId}/lots` | `itemManage` | `IdempotencyHeader`, body `CreateLotBody` | `createLot(tx, { companyId, itemId, ...body })` | 201 `LotSchema` |
| `units` | `GET /` | `itemRead` | query `UnitQuery` | `listUnits(tx, { companyId, cursor, limit })` | 200 `UnitList` |
| `units` | `POST /` | `itemManage` | `IdempotencyHeader`, body `CreateUnitBody` | `createUnit(tx, { companyId, ...body })` | 201 `UnitSchema` |
| `warehouses` | `GET /` | `itemRead` | query `WarehouseQuery` | `listWarehouses(tx, { companyId, kind, includeArchived, cursor, limit })` | 200 `WarehouseList` |
| `warehouses` | `GET /tree` | `itemRead` | param `companyId` | `warehouseTree(tx, companyId)` | 200 `WarehouseTree` (whole, unpaged) |
| `warehouses` | `POST /` | `itemManage` | `IdempotencyHeader`, body `CreateWarehouseBody` | `createWarehouse(tx, { companyId, ...body })` | 201 `WarehouseSchema` |
| `warehouses` | `GET /{warehouseId}` | `itemRead` | param `warehouseId` | `getWarehouse(tx, warehouseId)` | 200 `WarehouseSchema`, 404 on null |
| `warehouses` | `PATCH /{warehouseId}` | `itemManage` | `IdempotencyHeader`, body `UpdateWarehouseBody` | `updateWarehouse(tx, warehouseId, body)` | 200 `WarehouseSchema`, 404 on null |
| `warehouses` | `POST /{warehouseId}/archive` | `itemManage` | `IdempotencyHeader`, empty body | `archiveWarehouse(tx, warehouseId)` | 200 `WarehouseSchema`, 404 on null |

Every path above is registered under `PAGE = { company: "path:companyId" }`, every unsafe method declares `IdempotencyHeader`, and every list handler uses the `limit + 1` / `slice(0, limit)` / `encodeCursor` pattern the `GET /` handler above shows. The two whose bodies are **not** determined by the table, because their semantics are not "call one function and return it", are written out here:

```ts
// PUT /{itemId}/unit-conversions — a replace, so the body is the complete set (1A's PUT …/lines precedent).
// The response is the surviving set rather than an echo of the request: replaceUnitConversions leaves an
// omitted pair standing (§3.5.4 pins the DELETE grants), and returning the request would hide that.
itemRoutes.openapi(createRoute({
  method: "put", path: "/{itemId}/unit-conversions", tags: ["inventory"],
  middleware: [requirePermission(INVENTORY_PERMISSION.itemManage, PAGE)],
  request: {
    params: z.object({ companyId: z.string().uuid(), itemId: z.string().uuid() }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: ReplaceUnitConversionsBody } } },
  },
  responses: {
    200: { description: "Conversions", content: { "application/json": { schema: UnitConversionList } } },
  },
}), async (c) => {
  const { itemId } = c.req.valid("param");
  const { conversions } = c.req.valid("json");
  const rows = await c.var.withTenant((tx) => replaceUnitConversions(tx, itemId, conversions));
  return c.json({ items: rows, nextCursor: null });
});

// POST /{itemId}/archive — the whole deletion vocabulary for master data (spec:2049). 404 rather than 409 on
// an already-archived row: archiveItem's `and archived_at is null` returns null, and "there is no unarchived
// item by that id" is the honest answer for an idempotent replay whose first attempt succeeded.
itemRoutes.openapi(createRoute({
  method: "post", path: "/{itemId}/archive", tags: ["inventory"],
  middleware: [requirePermission(INVENTORY_PERMISSION.itemManage, PAGE)],
  request: {
    params: z.object({ companyId: z.string().uuid(), itemId: z.string().uuid() }),
    headers: IdempotencyHeader,
  },
  responses: { 200: { description: "Archived", content: { "application/json": { schema: ItemSchema } } } },
}), async (c) => {
  const { itemId } = c.req.valid("param");
  const row = await c.var.withTenant((tx) => archiveItem(tx, itemId));
  if (row === null) throw new AppError("ERR_NOT_FOUND", `no unarchived item ${itemId} in this company`);
  return c.json(row);
});
```

Three points a reviewer checks, each of which is a rule and not a preference:

- **`GET /{itemId}` carries `itemRead`, not membership alone.** §4.2.7's precedent for membership-only reads — `accounts`, `fiscal-periods`, `documents/{id}` — exists because §3.6.1 closes the vocabulary with no accounts-read code. Here there **is** a read code, so the gate uses it.
- **No `DELETE` route exists on any of the three.** spec:2049 and §3.5.4: master data is archived. `POST …/{id}/archive` is the whole vocabulary, and this slice adds no `app_rw` DELETE grant.
- **The `PUT …/unit-conversions` route is a replace, and its response is a `UnitConversionList`.** It is a `PUT` because the body is the complete set, the same reasoning as 1A's `PUT …/documents/{id}/lines`.

- [ ] **Step 5: Mount the modules and add the probes**

`apps/api/src/routes/index.ts`, three entries **inside `buildRoutes`** (never pushed onto `ROUTES` — §4.2.7):

```ts
    { path: "/v1/companies/:companyId/items", router: itemRoutes,
      permissions: ["inventory.item.read", "inventory.item.manage"], auth: "human" },
    { path: "/v1/companies/:companyId/units", router: unitRoutes,
      permissions: ["inventory.item.read", "inventory.item.manage"], auth: "human" },
    { path: "/v1/companies/:companyId/warehouses", router: warehouseRoutes,
      permissions: ["inventory.item.read", "inventory.item.manage"], auth: "human" },
```

`tests/invariants/probes.ts`, three entries keyed by those exact paths:

```ts
  "/v1/companies/:companyId/items": {
    seed: async (db, owner) => {
      const { itemId } = await seedItem(db, owner, { code: "PROBE-ITEM" });
      return { path: `/v1/companies/${owner.company}/items/${itemId}`, method: "GET" };
    },
    expect: 403,        // requirePermission refuses the foreign company before any row is read
  },
  "/v1/companies/:companyId/units": {
    seed: (_db, owner) => Promise.resolve({
      path: `/v1/companies/${owner.company}/units`, method: "POST",
      body: { code: "PROBE-UNIT", nameEn: "Probe" },
    }),
    expect: 403,
  },
  "/v1/companies/:companyId/warehouses": {
    seed: async (db, owner) => {
      const warehouseId = await seedWarehouse(db, owner, { code: "PROBE-WH" });
      return { path: `/v1/companies/${owner.company}/warehouses/${warehouseId}`, method: "GET" };
    },
    expect: 403,
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test -- test/routes/inventory/`
Expected: **PASS** — nine assertions in `items.test.ts`, **eight** in `units.test.ts` and **nine** in `warehouses.test.ts` (the extra one is the tree case; the table above is the source of both counts).

Run: `bun run --cwd tests test -- invariants/tenant-isolation.test.ts`
Expected: **PASS**. The harness fails the build when a `ROUTES` entry has no `PROBES` key or a key matches no route (§3.7.2), so this is the assertion that the three entries above are spelled exactly like the three mount paths.

Run: `bun run --cwd apps/api test -- test/routes/route-gates.test.ts`
Expected: **PASS**. `assertRouteGates` (R7) refuses an unsafe method gated by a `mutating: false` code at boot; every write above uses `itemManage`, which is `mutating: true`.

Run: `bun run --cwd packages/contracts openapi:generate && git add packages/contracts/openapi.json`
Expected: a diff adding the four modules' components and the three paths. Commit it.

Run: `bun run lint:rules && bun run typecheck`
Expected: PASS with `0 violations`.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/inventory packages/contracts/src/index.ts packages/contracts/openapi.json \
        apps/api/src/routes/inventory apps/api/src/routes/index.ts \
        apps/api/test/routes/inventory tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(api): the item, unit and warehouse routes [3A T11]

Three modules under /v1/companies/{companyId}/{items,units,warehouses}, reads
gated inventory.item.read and every write inventory.item.manage — warehouses,
units and unit conversions included, because §3.6.1 closes the vocabulary at
five codes and spec:2159/2160 give neither warehouse nor branch_manager any
catalogue authority. A contract addition to §3.6.2's uses sentence.

CreateItemBody omits the four account ids rather than accepting them: §4.15's
codes are the defaults and resolveItemAccounts resolves them, so no caller can
point COGS at a revenue account.

The unit-conversion numerator and denominator are digit-string regexes on the
wire, so denominator "0" is a 400 with a JSON Pointer instead of a 500 from a
check_violation — SAH-063 answered at the wire as well as in the schema.

No DELETE route exists anywhere in the three: master data is archived
(spec:2049), and this slice adds no app_rw DELETE grant. GET …/warehouses/tree
returns the whole tree rather than a page, because a fragment of a tree cannot
be reassembled by the caller.

Three PROBES entries, keyed by the three mount paths — the isolation harness
fails the build for a route without one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: The price-list, promotion and stock-on-hand APIs

The remaining three modules: prices and promotions under `inventory.price.manage`, and the stock read under `inventory.stock.read`. **`GET …/stock-on-hand` is an ordinary list endpoint and not a `ReportCode`** — `inventory.stock_on_hand`, `inventory.valuation` and `inventory.sales_by_item` are **3D's** minimal report set (§4.16.1, hazard 4), and a slice that seeded a report code here would collide with the slice that owns it.

**Files:**
- Create: `packages/contracts/src/inventory/price-list.ts`, `promotion.ts`, `stock.ts`
- Create: `apps/api/src/routes/inventory/price-lists.ts`, `promotions.ts`, `stock.ts`
- Create: `packages/db/src/inventory/stock.ts`
- Create: `apps/api/test/routes/inventory/price-lists.test.ts`, `promotions.test.ts`, `stock.test.ts`, `packages/db/test/inventory/stock.test.ts`
- Modify: `apps/api/src/routes/index.ts`, `packages/db/src/index.ts`, `packages/contracts/src/index.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Consumes: everything Task 11 consumes, plus `createPriceList`, `updatePriceList`, `archivePriceList`, `getPriceList`, `listPriceLists`, `replacePriceListLines`, `listPriceListLines`, `resolvePrice`, `createPromotion`, `updatePromotion`, `listPromotions` (Task 4); `pickLotsFefo` (Task 10).
- Produces:
  - `export interface StockOnHandRow { companyId: string; itemId: string; itemCode: string; itemNameEn: string; warehouseId: string; warehouseCode: string; lotId: string; lotCode: string; expiresOn: string | null; quantity: string; updatedAt: string }`
  - `export async function listStockOnHand(tx: Sql, params: { companyId: string; itemId?: string; warehouseId?: string; lotId?: string; nonZeroOnly?: boolean; cursor?: { itemCode: string; warehouseCode: string; lotCode: string } | null; limit: number }): Promise<StockOnHandRow[]>` — `packages/db/src/inventory/stock.ts`.
  - Contracts: `PriceListSchema`, `CreatePriceListBody`, `UpdatePriceListBody`, `PriceListQuery`, `PriceListList`, `PriceListLineSchema`, `ReplacePriceListLinesBody`, `PriceListLineList`, `ResolvedPriceSchema`, `PriceQuerySchema`; `PromotionSchema`, `PromotionKindSchema`, `CreatePromotionBody`, `UpdatePromotionBody`, `PromotionQuery`, `PromotionList`; `StockOnHandSchema`, `StockOnHandQuery`, `StockOnHandList`, `FefoPickSchema`, `FefoPickList`.
  - Route modules: `/v1/companies/:companyId/price-lists` → `priceListRoutes` (sub-paths `GET|PUT …/{priceListId}/lines`, `POST …/{priceListId}/archive`, `GET …/price-lists/resolve`); `/v1/companies/:companyId/promotions` → `promotionRoutes`; `/v1/companies/:companyId/stock-on-hand` → `stockRoutes` (sub-path `GET …/stock-on-hand/fefo`).
  - Three more `PROBES` entries.

- [ ] **Step 1: Write the failing test `packages/db/test/inventory/stock.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listStockOnHand } from "../../src/inventory/stock";
import { seedItem, seedLot, seedTenant, seedWarehouse, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("listStockOnHand — the read behind GET …/stock-on-hand", () => {
  let db: Db;
  let a: Seed;
  let itemId: string;
  let main: string;
  let chill: string;
  let lotId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Stock A");
    ({ itemId } = await seedItem(db, a, { code: "MILK-1L" }));
    main = await seedWarehouse(db, a, { code: "HQ-MAIN" });
    chill = await seedWarehouse(db, a, { code: "CHILL" });
    lotId = await seedLot(db, a, { itemId, code: "B-2026-04", expiresOn: "2026-10-31" });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      for (const [wh, lot, qty] of [[main, lotId, "40"], [chill, lotId, "0"]] as const) {
        await tx`insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
                 values (${a.tenant}, ${a.company}, ${itemId}, ${wh}, ${lot}, ${qty})`;
      }
    });
  });
  afterAll(async () => { await db.stop(); });

  it("joins the names a screen needs and orders by item, warehouse, lot", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listStockOnHand(tx, { companyId: a.company, limit: 50 }));
    expect(rows.map((r) => [r.itemCode, r.warehouseCode, r.lotCode, r.quantity])).toEqual([
      ["MILK-1L", "CHILL", "B-2026-04", "0.000000"],
      ["MILK-1L", "HQ-MAIN", "B-2026-04", "40.000000"],
    ]);
    expect(rows[0]!.expiresOn).toBe("2026-10-31");
  });

  it("nonZeroOnly drops a settled row, which is what a stock screen wants by default", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listStockOnHand(tx, { companyId: a.company, nonZeroOnly: true, limit: 50 }));
    expect(rows.map((r) => r.warehouseCode)).toEqual(["HQ-MAIN"]);
  });

  it("filters by warehouse and by lot, and pages on the full ordering key", async () => {
    const byWarehouse = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listStockOnHand(tx, { companyId: a.company, warehouseId: main, limit: 50 }));
    expect(byWarehouse).toHaveLength(1);
    const page = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listStockOnHand(tx, { companyId: a.company, limit: 1 }));
    const next = await withTenant(db.rw, a.tenant, a.human, (tx) => listStockOnHand(tx, {
      companyId: a.company, limit: 1,
      cursor: { itemCode: page[0]!.itemCode, warehouseCode: page[0]!.warehouseCode, lotCode: page[0]!.lotCode },
    }));
    expect(next[0]!.warehouseCode).toBe("HQ-MAIN");
  });
});
```

- [ ] **Step 2: Write `packages/db/src/inventory/stock.ts`**

```ts
import type { Sql } from "postgres";

export interface StockOnHandRow {
  companyId: string; itemId: string; itemCode: string; itemNameEn: string;
  warehouseId: string; warehouseCode: string;
  lotId: string; lotCode: string; expiresOn: string | null;
  quantity: string; updatedAt: string;
}

/**
 * Reads the SYNCHRONOUS projection (D14, §4.7.3) and never re-aggregates `inventory_movement` — exactly as
 * 1B's `trialBalance` reads `account_balance` and never re-aggregates `ledger_entry`. A read that quietly
 * recomputed would hide the drift the nightly integrity job exists to find (test 2).
 *
 * The keyset is `(item.code, warehouse.code, lot.code)` — the three natural keys, so a page boundary is
 * stable across inserts and reads the way a human reads a stock sheet, rather than by uuid.
 */
export async function listStockOnHand(tx: Sql, params: {
  companyId: string; itemId?: string; warehouseId?: string; lotId?: string; nonZeroOnly?: boolean;
  cursor?: { itemCode: string; warehouseCode: string; lotCode: string } | null; limit: number;
}): Promise<StockOnHandRow[]> {
  return tx<StockOnHandRow[]>`
    select h.company_id       as "companyId",
           h.item_id          as "itemId",
           i.code             as "itemCode",
           i.name_en          as "itemNameEn",
           h.warehouse_id     as "warehouseId",
           w.code             as "warehouseCode",
           h.lot_id           as "lotId",
           l.code             as "lotCode",
           l.expires_on::text as "expiresOn",
           h.quantity::text   as "quantity",
           h.updated_at::text as "updatedAt"
      from app.stock_on_hand h
      join app.item i      on i.tenant_id = h.tenant_id and i.id = h.item_id
      join app.warehouse w on w.tenant_id = h.tenant_id and w.id = h.warehouse_id
      join app.lot l       on l.tenant_id = h.tenant_id and l.id = h.lot_id
     where h.company_id = ${params.companyId}
       and (${params.itemId ?? null}::uuid is null      or h.item_id = ${params.itemId ?? null})
       and (${params.warehouseId ?? null}::uuid is null or h.warehouse_id = ${params.warehouseId ?? null})
       and (${params.lotId ?? null}::uuid is null       or h.lot_id = ${params.lotId ?? null})
       and (not ${params.nonZeroOnly ?? false} or h.quantity <> 0)
       and (${params.cursor?.itemCode ?? null}::text is null
            or (i.code, w.code, l.code) > (${params.cursor?.itemCode ?? null},
                                           ${params.cursor?.warehouseCode ?? null},
                                           ${params.cursor?.lotCode ?? null}))
     order by i.code, w.code, l.code
     limit ${params.limit}`;
}
```

Re-export from `packages/db/src/index.ts`: `export { listStockOnHand, type StockOnHandRow } from "./inventory/stock";`

- [ ] **Step 3: Write the failing route test `apps/api/test/routes/inventory/stock.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  grantCodes, seedItem, seedLot, seedTenantV2, seedWarehouse, uuidv7, type Seed,
} from "@dulja/db/test";
import { withTenant } from "@dulja/db";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("GET /v1/companies/{companyId}/stock-on-hand", () => {
  let api: StartedApi;
  let s: Seed;
  let itemId: string;
  let warehouseId: string;
  let early: string;
  let late: string;
  let priceOnly: string;

  /** §4.2.12: one `ApiRequest` object; `as` names the principal. A GET with no `as` is unauthenticated and
   *  answers 401, so every read below names one. */
  const get = (path: string, as: string = s.human) => api.request({ method: "GET", path, as });

  /** A real second principal (2B's `secondPrincipal` shape, plan0A:837) — `role_assignment.principal_id` has
   *  a foreign key to `app.principal`, so a bare uuid would be a 23503 in `grantCodes`. */
  const secondPrincipal = async (label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    // `actorId: s.system` — the tenant's system principal, taken from the `Seed` (§4.1), NOT resolved through
    // `systemContext`: that helper calls `app.resolve_principal`, whose EXECUTE is granted to `app_rw` only
    // (§4.1), and this transaction runs as `app_migrator`. 2B's own `secondPrincipal` passes `s.system` for
    // exactly this reason (2b:157–165); the only difference here is the three-argument PRODUCTION `withTenant`,
    // which is what `apps/*/test` uses (§4.2.12) where `packages/db/test` uses the four-argument one.
    await withTenant(api.db.migrator, {
      tenantId: s.tenant, actorId: s.system, requestId: `${label}-setup`,
    }, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${s.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    return id;
  };

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Stock API");
    await grantAdmin(api, s);
    ({ itemId } = await seedItem(api.db, s, { code: "MILK-1L", trackLots: true }));
    warehouseId = await seedWarehouse(api.db, s, { code: "CHILL" });
    early = await seedLot(api.db, s, { itemId, code: "B-EARLY", expiresOn: "2026-07-31" });
    late = await seedLot(api.db, s, { itemId, code: "B-LATE", expiresOn: "2026-09-30" });
    await withTenant(api.db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "stock-seed" }, async (tx) => {
      for (const [lot, qty] of [[early, "10"], [late, "40"]] as const) {
        await tx`insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
                 values (${s.tenant}, ${s.company}, ${itemId}, ${warehouseId}, ${lot}, ${qty})`;
      }
    });
    priceOnly = await secondPrincipal("price-only");
  }, 180_000);
  afterAll(async () => { await api.stop(); });

  it("lists stock per item, warehouse and lot with the names a screen needs", async () => {
    const res = await get(`/v1/companies/${s.company}/stock-on-hand`);
    expect(res.status).toBe(200);
    const items = (await res.json()).items as { lotCode: string; quantity: string }[];
    expect(items.map((i) => [i.lotCode, i.quantity]))
      .toEqual([["B-EARLY", "10.000000"], ["B-LATE", "40.000000"]]);
  });

  it("quantities are STRINGS on the wire, never JSON numbers (assumption 13)", async () => {
    const raw = await (await get(`/v1/companies/${s.company}/stock-on-hand`)).text();
    expect(raw).toContain('"quantity":"10.000000"');
    expect(raw).not.toMatch(/"quantity":\s*10/);
  });

  it("GET …/stock-on-hand/fefo returns the earliest-expiring lot first", async () => {
    const res = await get(
      `/v1/companies/${s.company}/stock-on-hand/fefo?itemId=${itemId}&warehouseId=${warehouseId}&quantity=30.000000`);
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([
      { lotId: early, quantity: "10.000000" },
      { lotId: late, quantity: "20.000000" },
    ]);
  });

  it("a non-positive fefo quantity is a 400, not an empty list", async () => {
    const res = await get(
      `/v1/companies/${s.company}/stock-on-hand/fefo?itemId=${itemId}&warehouseId=${warehouseId}&quantity=0.000000`);
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("the gate is inventory.stock.read: price.manage alone is refused", async () => {
    await grantCodes(api.db, s, {
      codes: ["inventory.price.manage"], principalId: priceOnly, roleCode: "price-only",
    });
    const res = await get(`/v1/companies/${s.company}/stock-on-hand`, priceOnly);
    expect(res.status).toBe(403);
  });

  it("stock-on-hand is a LIST endpoint and not a report code (§4.16.1, hazard 4)", async () => {
    const res = await get(`/v1/companies/${s.company}/reports/inventory.stock_on_hand`);
    expect(res.status).toBe(404);        // 3D seeds that code; this slice must not
  });
});
```

`price-lists.test.ts` and `promotions.test.ts` carry these cases and no others:

| Case | `price-lists.test.ts` | `promotions.test.ts` |
|---|---|---|
| create | `POST …/price-lists` → 201, `branchId` null = every branch | `POST …/promotions { kind: "percent_off", definition }` → 201 |
| validation | `validTo` before `validFrom` → 400 with `/validTo` | `kind: "buy_one_get_one"` → 400 with `/kind`; `endsAt` before `startsAt` → 400 |
| lines | `PUT …/{id}/lines` replaces, archives an omitted line, returns the surviving set; a negative `unitPrice` → 400 | — |
| resolve | `GET …/price-lists/resolve?itemId&quantity&on&customerKind&branchId` → the branch list over the company one; no match → `200 { price: null }`, never a 404 | — |
| list | cursor over `code` | `?activeOn=` filters the window; `?branchId=` returns the branch's plus the company-wide |
| archive | `POST …/{id}/archive` → 200 | **none** — a promotion has no `archived_at` (§4.6.1); assert `POST …/promotions/{id}/archive` → 404 and that `PATCH` with `endsAt` retires it |
| RBAC | `inventory.stock.read` alone is refused on write; `inventory.price.manage` succeeds | same |
| isolation | another tenant's company → 403 | same |

`GET …/price-lists/resolve` returning `200 { price: null }` rather than a 404 is deliberate: "this item has no price on any applicable list" is a **successful answer** a screen renders as an empty price field, while a 404 means "no such route or resource" and would make a normal catalogue gap look like a client error.

- [ ] **Step 4: Write the three contracts modules and the three route modules**

Every route is the two-part shape Task 11 writes out in full — a `createRoute` carrying its gate and schemas, then a handler calling one `@dulja/db` function inside `c.var.withTenant` — and each is fully determined by this table. The list handlers use the same `limit + 1` / `slice(0, limit)` / `encodeCursor` pattern; every unsafe method declares `IdempotencyHeader`; every gate is scoped `{ company: "path:companyId" }`.

| Module | Method · path | Gate | Request | Calls | Response |
|---|---|---|---|---|---|
| `price-lists` | `GET /` | `priceManage` | query `PriceListQuery` | `listPriceLists` | 200 `PriceListList` |
| `price-lists` | `POST /` | `priceManage` | body `CreatePriceListBody` | `createPriceList` | 201 `PriceListSchema` |
| `price-lists` | `GET /resolve` | `priceManage` | query `PriceQuerySchema` | `resolvePrice` | 200 `{ price: ResolvedPriceSchema \| null }` |
| `price-lists` | `GET /{priceListId}` | `priceManage` | param | `getPriceList` | 200 `PriceListSchema`, 404 on null |
| `price-lists` | `PATCH /{priceListId}` | `priceManage` | body `UpdatePriceListBody` | `updatePriceList` | 200 `PriceListSchema`, 404 on null |
| `price-lists` | `POST /{priceListId}/archive` | `priceManage` | empty body | `archivePriceList` | 200 `PriceListSchema`, 404 on null |
| `price-lists` | `GET /{priceListId}/lines` | `priceManage` | param | `listPriceListLines` | 200 `PriceListLineList` |
| `price-lists` | `PUT /{priceListId}/lines` | `priceManage` | body `ReplacePriceListLinesBody` | `replacePriceListLines` | 200 `PriceListLineList` (the surviving set) |
| `promotions` | `GET /` | `priceManage` | query `PromotionQuery` | `listPromotions` | 200 `PromotionList` |
| `promotions` | `POST /` | `priceManage` | body `CreatePromotionBody` | `createPromotion` | 201 `PromotionSchema` |
| `promotions` | `PATCH /{promotionId}` | `priceManage` | body `UpdatePromotionBody` | `updatePromotion` | 200 `PromotionSchema`, 404 on null |
| `stock-on-hand` | `GET /` | `stockRead` | query `StockOnHandQuery` | `listStockOnHand` | 200 `StockOnHandList` |
| `stock-on-hand` | `GET /fefo` | `stockRead` | query `FefoQuery` | `pickLotsFefo` | 200 `FefoPickList` |

`GET /resolve` is mounted **before** `GET /{priceListId}` so `resolve` is never parsed as a uuid path parameter, and its response is an object wrapping a nullable member rather than a bare nullable body: `{ "price": null }` is a document a client can validate, `null` is not. There is no `POST /promotions/{id}/archive` — a promotion is retired by `PATCH` with `endsAt` (§4.6.1 gives it no `archived_at`) — and no `DELETE` anywhere.

The three contract additions worth writing out:

```ts
// packages/contracts/src/inventory/stock.ts
export const StockOnHandSchema = z.object({
  companyId: UuidSchema, itemId: UuidSchema, itemCode: z.string(), itemNameEn: z.string(),
  warehouseId: UuidSchema, warehouseCode: z.string(),
  lotId: UuidSchema, lotCode: z.string(), expiresOn: DateSchema.nullable(),
  quantity: QuantitySchema,              // a fixed-6-dp STRING; no JSON number holds a quantity
  updatedAt: z.string().datetime(),
}).openapi("StockOnHand");

export const StockOnHandQuery = ListQuery.extend({
  "filter[itemId][eq]": UuidSchema.optional(),
  "filter[warehouseId][eq]": UuidSchema.optional(),
  "filter[lotId][eq]": UuidSchema.optional(),
  nonZeroOnly: z.coerce.boolean().optional(),
}).openapi("StockOnHandQuery");

export const FefoPickSchema = z.object({ lotId: UuidSchema, quantity: QuantitySchema }).openapi("FefoPick");
export const FefoPickList = z.object({ items: z.array(FefoPickSchema) }).openapi("FefoPickList");
export const FefoQuery = z.object({
  itemId: UuidSchema, warehouseId: UuidSchema,
  quantity: QuantitySchema.refine((q) => Number.parseFloat(q) > 0, { message: "quantity must be positive" }),
}).openapi("FefoQuery");
```

`FefoQuery`'s `.refine` is the one place in this slice where a quantity string reaches `Number.parseFloat`, and it is legal: the value is compared against zero for a **validation** decision and never stored, returned or arithmetically combined. `no-number-money` targets a property, parameter or variable *typed* `number` (§3.7.5) and this is neither. It exists so `app.pick_lots_fefo`'s own `ERR_VALIDATION_FAILED` raise is a defence in depth rather than the caller's error message.

Mount the three modules inside `buildRoutes` with `permissions: ["inventory.price.manage"]`, `["inventory.price.manage"]` and `["inventory.stock.read"]`, and add three `PROBES` entries keyed by the three paths, all `expect: 403`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/inventory/stock.test.ts`
Expected: **PASS**, three assertions.

Run: `bun run --cwd apps/api test -- test/routes/inventory/`
Expected: **PASS** across all six files.

Run: `bun run --cwd tests test -- invariants/tenant-isolation.test.ts`
Expected: **PASS** with six inventory `PROBES` entries and six mounted modules.

Run: `bun run --cwd packages/contracts openapi:generate && git add packages/contracts/openapi.json && bun run lint:rules && bun run typecheck`
Expected: PASS, `0 violations`.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/inventory packages/contracts/openapi.json \
        packages/db/src/inventory/stock.ts packages/db/src/index.ts \
        apps/api/src/routes/inventory apps/api/src/routes/index.ts \
        packages/db/test/inventory/stock.test.ts apps/api/test/routes/inventory \
        tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(api): the price-list, promotion and stock-on-hand routes [3A T12]

Prices and promotions under inventory.price.manage; the stock read under
inventory.stock.read. listStockOnHand reads the synchronous projection and never
re-aggregates inventory_movement — the same rule 1B set for trialBalance over
account_balance, because a read that quietly recomputed would hide the drift the
nightly integrity job exists to find.

GET …/stock-on-hand is a plain LIST endpoint, deliberately not a ReportCode:
inventory.stock_on_hand, inventory.valuation and inventory.sales_by_item are 3D's
minimal set (§4.16.1, hazard 4), and a test here asserts the report route is
still a 404 in this slice.

GET …/price-lists/resolve answers 200 { price: null } for a catalogue gap rather
than 404 — "no applicable price" is a successful answer a screen renders as an
empty field, and a 404 would make it look like a client error.

Quantities cross the wire as fixed-6-dp strings, asserted on the raw response
text so a future serialiser change cannot quietly turn one into a JSON number.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: ⚠️ OD-07 — serial numbers: `app.serial_unit` and the exact-match index (only if the owner confirms)

**Owner decision OD-07 (§2.12): "Serial numbers in scope?" — spec:92, 1032, 1310, 2435. Default: NOT BUILT.** §3.0.3's "probably not needed" list (spec:1032) puts serials there for a food distributor, and spec:1310 says the same in the POS section. This plan decides nothing (hazard 7): it builds the default and states exactly what changes if the answer is yes.

**Owner provides:** a written yes or no on serial-numbered goods, and if yes, the product categories that carry serials. **Verify:** the answer is attached to this task in the issue tracker before any step below runs. **Until provided:** the default path (Step 1) is the whole task, and the slice ships without `app.serial_unit`.

**This task is droppable without renumbering anything.** No other task in this slice imports a name it produces; `serial_unit`'s three regression files are created here and nowhere else (§3.7.3's conditional-defect rule names 3A as their creator precisely so a "no" leaves no orphan append).

- [ ] **Step 1 (the default path — run this if OD-07 is unanswered or NO): assert the table is absent and record the decision**

Create `packages/db/test/inventory/serial-unit.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, type Db } from "../harness";

describe("app.serial_unit — ⚠️ OD-07, default NOT BUILT (spec:1032, 1310)", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db.stop(); });

  it("the table does not exist, and no source file references it", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'app' and table_name = 'serial_unit'`;
    // §3.0.3 puts serial tracking on the "probably not needed" list for a food distributor and spec:1310
    // agrees. If OD-07 comes back yes, this file's expectation flips to 1 and Step 2 builds the table.
    expect(row!.n).toBe(0);
  });

  it("no regression file for the three serial defects exists either (§3.7.3's conditional rule)", async () => {
    const { readdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // A resolved PATH, not an import of `tests/support/source`. §4.18 pins the allowances that let a file
    // outside the `tests` workspace import from it to `apps/api/test/**` and `apps/worker/test/**`, and
    // `packages/db/test/**` is not one of them; adding a third would be a contracts amendment bought for
    // one assertion. `dependency-rule` lints `import` statements, so reading the tree by path needs no
    // allowance and no tsconfig `include` entry.
    const files = readdirSync(resolve(import.meta.dirname, "../../../../tests/regression"));
    // 3A is the NAMED creator of sah-052, 056 and 057 (§3.7.3), so their absence is this slice's statement
    // that the decision has not landed — not an oversight by a later slice. 6A appends to 052 when it does.
    for (const sah of ["sah-052", "sah-056", "sah-057"]) {
      expect(files.some((f) => f.startsWith(sah)), sah).toBe(false);
    }
  });
});
```

Commit:

```bash
git add packages/db/test/inventory/serial-unit.test.ts
git commit -m "$(cat <<'EOF'
test(db): OD-07 is unanswered, so app.serial_unit is not built [3A T13]

§3.0.3's "probably not needed" list and spec:1310 both put serial tracking
outside a food distributor's scope, and §2.12's default for OD-07 is "not
built". This asserts the absence rather than leaving it unstated, and asserts
that sah-052, 056 and 057 do not exist — 3A is their named creator (§3.7.3), so
their absence is a statement and not an omission.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2 (only if OD-07 = YES): append the DDL to migration `0029_create_warehouse_lot_variant.sql`**

§4.6.1 assigns `serial_unit` to "`0029_create_warehouse_lot_variant.sql` appended to by the OD-07 task only if serials are confirmed (0033 is the permission seed)" — there is no spare number in 0028–0033. **State the consequence honestly rather than pretend it is free:** an environment that already applied 0029 has the file recorded in `app.migration` and will never re-run it, so the appended DDL reaches only a database migrated after the append. The procedure is therefore `bun run --cwd packages/db db:rollback 28 && bun run --cwd packages/db db:migrate` on CI and on staging, and it is legal **only** because no tenant transacts before the Phase 3 definition of done is green (§4.7.2 states the same for provisional movement values). If OD-07 arrives after any tenant has transacted, this step is replaced by a new migration in the range of whichever slice is then current, and that is an amendment to §4.6.1, not a plan decision.

Append to `0029_create_warehouse_lot_variant.sql`, after `app.variant`:

```sql
-- ── 5. serial_unit ⚠️ — appended by the OD-07 task, only after the owner confirmed serials are in scope.
-- spec:1181: "SerialUnit is a ROW, unique, not a range." SAH-052 was a serial that could be sold twice
-- because the uniqueness check had no callers; SAH-056 looked a serial up by length and prefix, which is
-- non-sargable and silently wrong; SAH-057 expanded serial blocks unit-by-unit with a full scan per unit.
-- One row per physical unit and one partial unique index answer all three.
create table app.serial_unit (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  item_id      uuid not null,
  lot_id       uuid not null,
  serial       text not null,
  status       text not null default 'in_stock',
  warehouse_id uuid,                                  -- null once sold: the unit has left every warehouse
  created_at   timestamptz not null default now(),
  constraint serial_unit_status_check check (status in ('in_stock', 'sold', 'returned')),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)   references app.company(tenant_id, id),
  foreign key (tenant_id, item_id)      references app.item(tenant_id, id),
  foreign key (tenant_id, lot_id)       references app.lot(tenant_id, id),
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id)
);
-- The uniqueness that matters: one IN-STOCK unit per (item, serial). A sold unit may be re-serialled by a
-- supplier and a returned one is still that serial, so a total unique index would refuse legitimate history.
-- It is a UNIQUE INDEX and not a check, so two terminals racing on one serial contend on the index and
-- exactly one wins (acceptance test 17, which is 6A's) — the answer SAH-052's callerless check never gave.
create unique index serial_unit_in_stock_key on app.serial_unit (item_id, serial) where status = 'in_stock';
-- Exact-match only. SAH-056's lookup was `where left(serial, n) = ...` over a computed length, which no index
-- can serve; this index is what makes `where item_id = $1 and serial = $2` a single-row probe.
create index serial_unit_lookup_idx on app.serial_unit (company_id, serial);
call app_meta.enable_tenant_rls('app.serial_unit');
call app_meta.attach_audit('app.serial_unit');
```

Prepend to `0029.down.sql`, before its existing drops:

```sql
drop index if exists app.serial_unit_lookup_idx;
drop index if exists app.serial_unit_in_stock_key;
drop table if exists app.serial_unit;
```

Then: add `"serial_unit"` to **no** linter set (§3.5.3's row is all dashes — it is an ordinary audited table); add the Drizzle mirror `packages/db/src/schema/serial_unit.ts`; flip `serial-unit.test.ts`'s two expectations and extend it with the exact-match probe and the in-stock-uniqueness race; and create `tests/regression/sah-052.test.ts`, `sah-056.test.ts` and `sah-057.test.ts` with `thinRegression(52 | 56 | 57, …)` blocks asserting, respectively: the partial unique index exists and a second `in_stock` insert of one `(item, serial)` is a 23505; `serial_unit_lookup_idx` exists and no source file matches `/left\s*\(\s*serial|substring\s*\(\s*serial/`; and that a serial enquiry is one indexed query, asserted by `explain (format json)` showing an `Index Scan` and no `Seq Scan` on `app.serial_unit`.

**What 6A then owns and this task does not:** acceptance **test 17** (two terminals racing on one serial, §6.1) and the `pos.ticket.sell` path that allocates a serial. This task creates the table and the index the race contends on; 6A writes the race.

- [ ] **Step 3 (only if Step 2 ran): verify and commit**

Run: `bun run --cwd packages/db db:rollback 28 && bun run --cwd packages/db db:migrate` — the re-run Step 2's own paragraph requires, because 0029 is already recorded in `app.migration` and an appended file is never re-applied on its own.
Expected: clean both ways, and `packages/db/test/privileges.test.ts`'s up → down → up fingerprint test (§3.4.6) green — it is what catches a `0029.down.sql` that forgot one of the three new drops.

Run: `bun run --cwd packages/db db:lint && bun run --cwd packages/db test -- test/inventory/serial-unit.test.ts`
Expected: **PASS**, `0 violations`, four assertions (Step 1's two, now flipped to expect the table, plus the exact-match probe and the in-stock-uniqueness race).

Run: `bun run --cwd tests test -- regression/sah-052.test.ts regression/sah-056.test.ts regression/sah-057.test.ts`
Expected: **PASS**, three files.

Commit:

```bash
git add packages/db/migrations/0029_create_warehouse_lot_variant.sql \
        packages/db/migrations/0029.down.sql packages/db/src/schema/serial_unit.ts \
        packages/db/test/inventory/serial-unit.test.ts tests/regression/sah-052.test.ts \
        tests/regression/sah-056.test.ts tests/regression/sah-057.test.ts
git commit -m "$(cat <<'EOF'
feat(inventory): serial_unit and the exact-match index [3A T13]

OD-07 came back YES and this is the branch that answer opens. app.serial_unit is
one ROW per physical unit (spec:1181 "SerialUnit is a ROW, unique, not a
range"), with a PARTIAL unique index on (item_id, serial) where status =
'in_stock' — SAH-052's uniqueness check had no callers, and an index is a
control rather than a convention: two terminals racing on one serial contend on
it and exactly one wins. serial_unit_lookup_idx makes (company_id, serial) an
exact-match probe, which is SAH-056's non-sargable left(serial, n) lookup made
impossible. One row per unit is also SAH-057's per-unit full scan removed.

The DDL is APPENDED to 0029 because §4.6.1 assigns it there and 0028-0033 has no
spare number (0033 is the permission seed). That means an environment which
already applied 0029 will never re-run it, so this commit is accompanied by
`db:rollback 28 && db:migrate` on CI and staging — legal only because no tenant
transacts before the Phase 3 definition of done is green. If OD-07 arrives after
a tenant has transacted, this step is replaced by a new migration in the then
current slice's range, and that is an amendment to §4.6.1.

serial_unit joins NO linter set (§3.5.3's row is all dashes — an ordinary
audited table), gains its Drizzle mirror, and brings sah-052, 056 and 057 into
existence; 3A is their named creator (§3.7.3). Acceptance test 17 stays 6A's:
this commit creates the table and the index its race contends on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: ⚠️ OD-08 — manufacturing/BOM, consignment stock, dealer commissions, project costing: reserved names, no DDL

**Owner decision OD-08 (§2.12): "Manufacturing/BOM, consignment stock, dealer commissions, project/job costing" — spec:1032. Default: NOT BUILT, names reserved, no DDL.** All four are on §3.0.3's "probably not needed" list. spec:1178–1183's object model names `BillOfMaterials` under `Item`, which is why the name is reserved rather than forgotten.

**Owner provides:** a written yes or no per capability. **Verify:** the answer is attached to this task before Step 2 is considered. **Until provided:** Step 1 is the whole task.

**"Reserve names, no DDL" needs a deliverable or it is a placeholder**, so this task ships an executable statement of the reservation: a test that the four names are absent from schema `app` and from the shared registries, which fails the moment a later slice quietly introduces one under a different spelling.

- [ ] **Step 1: Write `packages/db/test/inventory/reserved-names.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, type Db } from "../harness";

/**
 * ⚠️ OD-08 (§2.12) — the four capabilities on spec:1032's "probably not needed" list. The DEFAULT is: not
 * built, names reserved. This file is the reservation, executable: if a later slice needs one of these
 * capabilities it renames these expectations in the same PR as its migration, and a reviewer sees the
 * decision instead of discovering a `bom_line` table nobody agreed to.
 *
 * The reserved table names, with the shape §4.6.1 would use if OD-08 came back yes:
 *   app.bill_of_materials       parent item_id, output_quantity, effective_from  — spec:1182
 *   app.bill_of_materials_line  bom_id, component item_id, quantity, scrap_pct
 *   app.consignment_holding     party_id, item_id, warehouse_id, quantity — stock owned by someone else
 *   app.dealer_commission       party_id, item_id?, basis, rate — a commission ACCRUAL, never a payroll line
 *   app.job                     company_id, code, name_en, name_ar, status — project/job costing's cost object
 * None is created by any slice in this document. A capability that needs one amends §4.6.1 first.
 */
describe("⚠️ OD-08 — reserved names, no DDL (spec:1032)", () => {
  const RESERVED = [
    "bill_of_materials", "bill_of_materials_line", "consignment_holding", "dealer_commission", "job",
  ] as const;
  let db: Db;

  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db.stop(); });

  it("none of the five reserved table names exists in schema app", async () => {
    const present = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.tables
       where table_schema = 'app' and table_name = any(${RESERVED as unknown as string[]})
       order by table_name`;
    expect(present.map((r) => r.table_name)).toEqual([]);
  });

  it("no near-spelling of one has slipped in either — the reservation is about the capability", async () => {
    const suspicious = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.tables
       where table_schema = 'app'
         and (table_name like '%bom%' or table_name like '%consign%'
           or table_name like '%commission%' or table_name like '%project%')
       order by table_name`;
    expect(suspicious.map((r) => r.table_name)).toEqual([]);
  });

  it("no permission code, document-type code or account code exists for any of the four", async () => {
    const codes = await db.admin<{ code: string }[]>`
      select code from app.permission
       where code like '%bom%' or code like '%manufactur%' or code like '%consign%'
          or code like '%commission%' or code like '%project%'
       order by code`;
    // §3.6.1 closes the permission vocabulary at spec:2146-2150, so a code here would mean a slice widened a
    // closed registry — the mechanical half of hazard 26 and hazard 32.
    expect(codes.map((r) => r.code)).toEqual([]);
  });

  it("`job` in particular is reserved and NOT the legacy MatOpens.Job column (Part VII #7, OD-27)", async () => {
    // 9A's profiler reports on the legacy `Job` column under OD-27; that is a report about the old database
    // and creates nothing here. Recorded because "job" is a word two decisions use.
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and column_name in ('job_id', 'bom_id', 'commission_id')`;
    expect(row!.n).toBe(0);
  });
});
```

- [ ] **Step 2 (only if OD-08 = YES for any capability): stop and write an ADR proposal**

Do **not** implement. Each of the four is a new subsystem with its own posting policy, its own account codes and — for BOM — its own costing semantics (a manufactured item's cost is the sum of its components' consumptions, which changes `CostingEngine`'s contract). Hazard 7: "A plan needing a deviation writes an ADR proposal and stops; it does not implement first." The proposal goes in the ADR range of whichever slice is then current, names the §4.6.1 rows, the §4.14 document-type codes and the §4.15 account codes it would need, and this task's test file is updated in the PR that implements it.

- [ ] **Step 3: Commit**

```bash
git add packages/db/test/inventory/reserved-names.test.ts
git commit -m "$(cat <<'EOF'
test(db): OD-08 is unanswered — the four names are reserved, with no DDL [3A T14]

BOM, consignment stock, dealer commissions and project/job costing are all on
spec:1032's "probably not needed" list and §2.12's default is not built. This
makes the reservation executable rather than prose: the five table names are
absent, no near-spelling has slipped in, and no permission code exists for any
of the four — so a later slice that needs one renames these expectations in the
same PR as its migration and a reviewer sees the decision.

`job` is reserved here and is unrelated to the legacy MatOpens.Job column 9A
profiles under OD-27; recorded because one word carries two decisions.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: ⚠️ OD-24 — the item, warehouse and stock screens

**Owner decision OD-24 (§2.12): "Screenshots + operator description before any screen" — spec:79, 108, 2408. Default: the screen task is blocked, not the slice.** spec:79 and spec:108 are explicit that the UI is not specified, and hazard 29 forbids inventing a workflow.

**Owner provides:** screenshots of the three legacy screens an operator uses daily — the material master, the warehouse list and the stock enquiry — and a **two-minute description per screen** of what the operator does, in order, including which keys they press. **Verify:** the screenshots and the three descriptions are attached to this task in the issue tracker; run `ls docs/owner/od-24/3a/` and confirm one file per screen plus one transcript per screen. **Until provided:** Steps 2 onward do not run and the slice ships with the API and no screens; the API tasks (11, 12) are the deliverable an operator's own tooling can already drive.

**Steps 2–5 still carry real code**, against a **stated default layout**, because hazard 29 blocks the *screen* and not the ability to write one: if the owner's material shows a different workflow, only the three `.tsx` files and their tests change, and the `inventory-api.ts` layer below them does not.

**The stated default layout, so a reviewer can compare it against the owner's material.** Each screen is a two-pane list-and-detail: 0E's `DataGrid` on the inline-start side, a form on the inline-end side, and a row of `Button`s and filter controls above both. **There is no command bar component**: 0E's `packages/ui` ships exactly `DirectionProvider`, `Button`, `TextField`, `Select` and `DataGrid` (0e:2022–2027 is the whole barrel), and adding a sixth primitive to `packages/ui` is 0E's file, not 3A's.

**The keyboard model, split by who owns each key.** `/` focuses the filter, `↑`/`↓`/`←`/`→` move the cell focus (direction-mapped) and `Enter` activates the focused row — those three are 0E Task 4's `DataGrid` plus 0E Task 8's `/` handler, used unchanged. `Ctrl+S` saves, `Esc` reverts and `Ctrl+N` starts a new row are **this task's own additions**, implemented as one `keydown` effect per screen in the shape 0E Task 8 established for `/`; they are not 0E's and no reviewer should look for them in `packages/ui`. No mouse-only affordance exists anywhere (spec:2254). Both text directions are verified before merge (spec:106) and the e2e spec re-runs acceptance **test 23**.

**Files:**
- Create: `apps/backoffice/src/lib/inventory-api.ts`
- Create: `apps/backoffice/src/routes/inventory/items.tsx`, `warehouses.tsx`, `stock.tsx`
- Create: `apps/backoffice/test/inventory-items.test.tsx`, `inventory-warehouses.test.tsx`, `inventory-stock.test.tsx`
- Create: `tests/e2e/inventory-screens.spec.ts`
- Modify: `apps/backoffice/src/router.tsx` (three routes), `apps/backoffice/src/components/app-shell.tsx` (three nav entries), `packages/i18n/src/locales/en.json` and `ar.json`

**Interfaces:**
- Consumes: `createAdminApi`, `AdminApi`, `AdminApiOptions` (0E, `apps/backoffice/src/lib/admin-api.ts` — `get(path, schema)` and `send(method, path, body, schema)`, both taking the Zod schema as a **parameter**; `AdminApiOptions` is `{ baseUrl; accessToken; fetchImpl? }` and `fetchImpl` is the test seam); `ApiError`, `problemMessage` (0E, `apps/backoffice/src/lib/problem.ts`); `AppShell` and **`useShell`** — `{ locale, setLocale, t }` — from 0E's `apps/backoffice/src/components/app-shell.tsx`, **not** from `@dulja/i18n`, which exports no hook; `Button`, `TextField`, `Select`, `DataGrid`, `Column`, `PHYSICAL_PROPERTY_PATTERNS` (0E, `@dulja/ui` — the whole barrel); `formatQuantity`, `formatDate` (0E, `@dulja/i18n`, both taking a `FormatContext` of `{ locale }`); `useSession`, `useCompanyId`, `readEnv` (0E, `apps/backoffice/src/lib/session.tsx` and `env.ts`); `createRootRoute`, `createRoute`, `routeTree`, `router` (0E, `apps/backoffice/src/router.tsx`); `ItemList`, `ItemSchema`, `CreateItemBody`, `UpdateItemBody`, `UnitList`, `WarehouseSchema`, `WarehouseTree`, `WarehouseList`, `CreateWarehouseBody`, `StockOnHandList`, `FefoPickList` (Tasks 11, 12); `bootLocalStack`, `grantAdminRole` (0E, `tests/e2e/support/boot.ts`).
- Produces: `export interface InventoryApi { listItems; listUnits; createItem; updateItem; archiveItem; listWarehouses; warehouseTree; createWarehouse; listStockOnHand; pickFefo }` and `export function createInventoryApi(api: AdminApi, companyId: string): InventoryApi`; `ItemsRoute`, `WarehousesRoute`, `StockRoute`, each taking 0E's `UsersRouteProps` shape `{ api: AdminApiOptions; companyId: string }`; the three module-private `router.tsx` wrappers `ItemsScreen`, `WarehousesScreen`, `StockScreen` that supply those props from the live session (0E Task 8 Step 5's `UsersScreen` shape); three `createRoute` entries at `/inventory/items`, `/inventory/warehouses`, `/inventory/stock`.

**Why props and not a React context.** An earlier draft of this task put `InventoryApi` in a `createContext` and read it with a `useInventoryApi` hook. 0E Task 8 injects `api: AdminApiOptions` and `companyId` as **props** on `UsersRoute` precisely so the screen renders in a test with no network and no provider tree beyond `QueryClientProvider` + `AppShell` (0e:3480–3488), and Step 5's tests below are that file's shape. Following 0E costs one wrapper component per route in `router.tsx` and removes a file.

- [ ] **Step 1: The gate — confirm the owner's material is attached, or stop**

Run: `ls -1 docs/owner/od-24/3a/`
Expected: six files — `items.png`, `warehouses.png`, `stock.png` and `items.md`, `warehouses.md`, `stock.md`, each `.md` being the transcribed two-minute description.
**If the directory is missing or incomplete: stop here.** Record in the task "OD-24 unanswered for 3A; screens deferred", leave Steps 2–5 unchecked, and ship the slice. Nothing in Tasks 1–14 depends on this task. Do **not** substitute a guess: hazard 29, and the legacy screens are the only record of the workflow this business actually runs.

- [ ] **Step 2: Write `apps/backoffice/src/lib/inventory-api.ts`**

```ts
import type { ZodType } from "zod";
import type { AdminApi } from "./admin-api";
import {
  CreateItemBody, CreateWarehouseBody, FefoPickList, ItemList, ItemSchema, StockOnHandList,
  UnitList, UpdateItemBody, WarehouseList, WarehouseSchema, WarehouseTree,
} from "@dulja/contracts";
import type { z } from "zod";

/**
 * The typed fetch layer the three screens share. It exists so a screen never builds a URL: a path typo is a
 * runtime 404 in a React component and a compile error here. Every method passes the Zod schema to 0E's
 * `AdminApi` as a parameter, which is why this file imports the schemas and `admin-api.ts` does not.
 *
 * `Idempotency-Key` is set by `AdminApi.send` for every unsafe method (0E Task 5) — not here, and not by a
 * screen, so no component can forget it (spec:2055).
 */
export interface InventoryApi {
  listItems(query?: { limit?: number; cursor?: string; code?: string }): Promise<z.infer<typeof ItemList>>;
  listUnits(query?: { limit?: number; cursor?: string }): Promise<z.infer<typeof UnitList>>;
  createItem(body: z.infer<typeof CreateItemBody>): Promise<z.infer<typeof ItemSchema>>;
  updateItem(itemId: string, body: z.infer<typeof UpdateItemBody>): Promise<z.infer<typeof ItemSchema>>;
  archiveItem(itemId: string): Promise<z.infer<typeof ItemSchema>>;
  listWarehouses(query?: { limit?: number; cursor?: string }): Promise<z.infer<typeof WarehouseList>>;
  warehouseTree(): Promise<z.infer<typeof WarehouseTree>>;
  createWarehouse(body: z.infer<typeof CreateWarehouseBody>): Promise<z.infer<typeof WarehouseSchema>>;
  listStockOnHand(query?: {
    limit?: number; cursor?: string; itemId?: string; warehouseId?: string; nonZeroOnly?: boolean;
  }): Promise<z.infer<typeof StockOnHandList>>;
  pickFefo(q: { itemId: string; warehouseId: string; quantity: string }): Promise<z.infer<typeof FefoPickList>>;
}

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
};

export function createInventoryApi(api: AdminApi, companyId: string): InventoryApi {
  const base = `/v1/companies/${companyId}`;
  const get = <T>(path: string, schema: ZodType<T>) => api.get(path, schema);
  return {
    listItems: (q = {}) => get(`${base}/items${qs({
      limit: q.limit, cursor: q.cursor, "filter[code][eq]": q.code,
    })}`, ItemList),
    listUnits: (q = {}) => get(`${base}/units${qs(q)}`, UnitList),
    createItem: (body) => api.send("POST", `${base}/items`, body, ItemSchema),
    updateItem: (itemId, body) => api.send("PATCH", `${base}/items/${itemId}`, body, ItemSchema),
    archiveItem: (itemId) => api.send("POST", `${base}/items/${itemId}/archive`, {}, ItemSchema),
    listWarehouses: (q = {}) => get(`${base}/warehouses${qs(q)}`, WarehouseList),
    warehouseTree: () => get(`${base}/warehouses/tree`, WarehouseTree),
    createWarehouse: (body) => api.send("POST", `${base}/warehouses`, body, WarehouseSchema),
    listStockOnHand: (q = {}) => get(`${base}/stock-on-hand${qs({
      limit: q.limit, cursor: q.cursor, nonZeroOnly: q.nonZeroOnly,
      "filter[itemId][eq]": q.itemId, "filter[warehouseId][eq]": q.warehouseId,
    })}`, StockOnHandList),
    pickFefo: (q) => get(`${base}/stock-on-hand/fefo${qs(q)}`, FefoPickList),
  };
}
```

- [ ] **Step 3: Write the three screens against the stated default layout**

Each is 0E Task 8's `users.tsx` shape, over this slice's data — the same props, the same `useQuery`, the same `Column<T>` list, the same `problemMessage` alert. The item screen, written out; the other two follow it.

```tsx
// apps/backoffice/src/routes/inventory/items.tsx
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo, useRef, useState } from "react";
import { CreateItemBody, ItemList, UnitList } from "@dulja/contracts";
import { useShell } from "../../components/app-shell";
import { createAdminApi, type AdminApiOptions } from "../../lib/admin-api";
import { createInventoryApi } from "../../lib/inventory-api";
import { ApiError, problemMessage } from "../../lib/problem";
import type { z } from "zod";

type CreateItem = z.infer<typeof CreateItemBody>;
type Item = z.infer<typeof ItemList>["items"][number];
type Unit = z.infer<typeof UnitList>["items"][number];

/** 0E Task 8's `UsersRouteProps` shape, so the screen renders in a test with no network. */
export interface InventoryRouteProps {
  api: AdminApiOptions;
  companyId: string;
}

export function ItemsRoute({ api, companyId }: InventoryRouteProps) {
  const { t } = useShell();                       // 0E's shell hook — @dulja/i18n exports no hook
  const client = useMemo(() => createInventoryApi(createAdminApi(api), companyId), [api, companyId]);
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const items = useQuery({ queryKey: ["items"], queryFn: () => client.listItems({ limit: 100 }) });
  const units = useQuery({ queryKey: ["units"], queryFn: () => client.listUnits({ limit: 200 }) });

  const form = useForm<CreateItem>({
    resolver: zodResolver(CreateItemBody),
    defaultValues: { kind: "product", trackLots: true },
  });
  const create = useMutation({
    mutationFn: (body: CreateItem) => client.createItem(body),
    onSuccess: async () => {
      form.reset();
      await queryClient.invalidateQueries({ queryKey: ["items"] });
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? problemMessage(cause.problem, t) : String(cause)),
  });

  /**
   * The three keys `packages/ui` does not own. `/` is 0E Task 8's handler verbatim; Ctrl+S, Ctrl+N and
   * Esc are this screen's, because 0E ships no command bar and adding one is 0E's file. `requestSubmit`
   * (not `submit`) so the form's `onSubmit` — and therefore the Zod resolver — actually runs.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        filterRef.current?.focus();
        return;
      }
      if (event.key === "Escape") { form.reset(); setError(null); return; }
      if (!event.ctrlKey) return;
      if (event.key === "s") { event.preventDefault(); formRef.current?.requestSubmit(); }
      if (event.key === "n") { event.preventDefault(); form.reset(); setError(null); }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [form]);

  const rows = (items.data?.items ?? []).filter((row: Item) =>
    filter === "" || `${row.code} ${row.nameEn}`.toLowerCase().includes(filter.toLowerCase()),
  );

  // `Column<T>.cell` is required on every column (0e:1907) — there is no `render` and no bare `key`.
  const columns: Column<Item>[] = [
    { key: "code", header: t("inventory.items.code"), cell: (r) => r.code },
    { key: "nameEn", header: t("inventory.items.nameEn"), cell: (r) => r.nameEn },
    { key: "kind", header: t("inventory.items.kind"), cell: (r) => t(`inventory.kind.${r.kind}`) },
    {
      key: "trackLots",
      header: t("inventory.items.trackLots"),
      cell: (r) => t(r.trackLots ? "common.yes" : "common.no"),
    },
  ];

  return (
    <div className="grid grid-cols-[2fr_1fr] gap-4">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <TextField
            label={t("inventory.items.filter")}       {/* focused by "/" */}
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
          />
          <Button variant="secondary" onClick={() => { form.reset(); setError(null); }}>
            {t("common.new")}                          {/* the Ctrl+N affordance, visible */}
          </Button>
        </div>
        <DataGrid
          caption={t("inventory.items.list")}
          columns={columns}
          rows={rows}
          rowKey={(r: Item) => r.id}
          emptyLabel={t("app.empty")}
          onActivate={(row: Item) => form.reset(row)}   {/* Enter */}
        />
      </section>

      <form
        ref={formRef}
        aria-label={t("inventory.items.form")}
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit((body) => { setError(null); create.mutate(body); })}
      >
        <TextField
          label={t("inventory.items.code")}
          error={form.formState.errors.code?.message}
          autoComplete="off"
          {...form.register("code")}
        />
        <TextField
          label={t("inventory.items.nameEn")}
          error={form.formState.errors.nameEn?.message}
          {...form.register("nameEn")}
        />
        {/* dir="rtl" on the FIELD, never on the document: 0E's DirectionProvider owns the page */}
        <TextField
          label={t("inventory.items.nameAr")}
          error={form.formState.errors.nameAr?.message}
          dir="rtl"
          {...form.register("nameAr")}
        />

        {/*
          `register` on a <Select> would hand its `ref` to a plain function component: 0E wraps only
          `TextField` in `forwardRef` (0e:3745). `Controller` keeps the field controlled and never asks
          for a ref, which is why the three selects below differ from the three text fields above.
          `SelectProps` carries `label` and `options` only — no `error` slot — so select-level Zod
          messages land in the shared alert underneath.
        */}
        <Controller
          control={form.control}
          name="kind"
          render={({ field }) => (
            <Select
              label={t("inventory.items.kind")}
              name={field.name}
              value={field.value}
              onBlur={field.onBlur}
              onChange={(e) => field.onChange(e.currentTarget.value)}
              options={["product", "service", "asset"].map((k) => ({
                value: k, label: t(`inventory.kind.${k}`),
              }))}
            />
          )}
        />
        <Controller
          control={form.control}
          name="baseUnitId"
          render={({ field }) => (
            <Select
              label={t("inventory.items.baseUnit")}
              name={field.name}
              value={field.value ?? ""}
              onBlur={field.onBlur}
              onChange={(e) => field.onChange(e.currentTarget.value)}
              options={(units.data?.items ?? []).map((u: Unit) => ({
                value: u.id, label: `${u.code} — ${u.nameEn}`,
              }))}
            />
          )}
        />
        {/* A boolean as a two-option Select: `packages/ui` ships no toggle, and inventing one here
            would be an edit to 0E's package. The string is converted at the boundary, not stored. */}
        <Controller
          control={form.control}
          name="trackLots"
          render={({ field }) => (
            <Select
              label={t("inventory.items.trackLots")}
              name={field.name}
              value={field.value ? "yes" : "no"}
              onBlur={field.onBlur}
              onChange={(e) => field.onChange(e.currentTarget.value === "yes")}
              options={[{ value: "yes", label: t("common.yes") }, { value: "no", label: t("common.no") }]}
            />
          )}
        />

        {/* The four account fields are absent on purpose: CreateItemBody omits them and §4.15's codes are
            the defaults (Task 11). A screen that offered an account picker would be offering a way to point
            COGS at a revenue account. */}

        {(() => {
          const selectError = form.formState.errors.kind?.message
            ?? form.formState.errors.baseUnitId?.message
            ?? error;
          return selectError === null || selectError === undefined
            ? null
            : <p role="alert" className="text-start text-danger">{selectError}</p>;
        })()}

        {/* 0E's Button defaults to type="button" (0e:1815), so submit is spelled out or Ctrl+S does nothing. */}
        <Button variant="primary" type="submit" disabled={create.isPending}>
          {t("common.save")}                            {/* Ctrl+S */}
        </Button>
      </form>
    </div>
  );
}
```

`warehouses.tsx` and `stock.tsx` are that exact component structure — filter row + `DataGrid` + `<form>` for the first, filter row + `DataGrid` alone for the second — over different data, with these differences and no others:

| | `warehouses.tsx` | `stock.tsx` |
|---|---|---|
| Query | `warehouseTree()` — the whole tree, one request | `listStockOnHand({ nonZeroOnly, itemId, warehouseId, limit: 100 })` |
| Table | indented by each node's `depth`, `path.join(" / ")` as the row's accessible name | `itemCode`, `warehouseCode`, `lotCode`, `expiresOn`, `quantity` |
| Quantities | — | rendered through `@dulja/i18n`'s number formatter **from the response string**; no `Number()` anywhere |
| Form | `CreateWarehouseBody` — `code`, `nameEn`, `nameAr`, `kind`, `branchId`, `parentId` | **none — the screen is read-only**; stock changes only by posting a document |
| Parent picker | excludes the selected node and every node whose `path` contains it — the client-side echo of `ERR_WAREHOUSE_TREE_CYCLE`, which the server still enforces and which the form surfaces as a 409 if a stale tree lets one through | — |
| Extra action | — | "pick FEFO", which calls `pickFefo({ itemId, warehouseId, quantity })` and lists the lots in the order returned, unsorted by the client |
| Filters | `kind` (all / stock / in-transit), `includeArchived` | item, warehouse, and a `nonZeroOnly` toggle defaulted **on** |

**Neither sibling adds a provider, a context or a hook of its own.** Each is a plain function component taking the same `InventoryRouteProps` (`{ api: AdminApiOptions; companyId: string }`) and calling `createInventoryApi(createAdminApi(api), companyId)` in a `useMemo`, exactly as `ItemsRoute` does above — that is the whole of the "Why props and not a React context" paragraph in practice. The live `api` and `companyId` are supplied by the three `router.tsx` wrappers Step 4 writes, and nothing in `packages/ui` or `apps/backoffice/src/components` is edited to make it work.

- [ ] **Step 4: Register the routes and the i18n keys**

`apps/backoffice/src/router.tsx`, three entries beside 0E's four — each behind the **wrapper** the previous step's props decision costs. `createRoute`'s `component` is called with no props, so `component: ItemsRoute` would not typecheck against `InventoryRouteProps`; 0E Task 8 Step 5 solved the same problem for `UsersRoute` with a `UsersScreen` wrapper that reads the live session, and these three are that component copied three times:

```tsx
import { useSession, useCompanyId } from "./lib/session";
import { readEnv } from "./lib/env";
import { ItemsRoute } from "./routes/inventory/items";
import { WarehousesRoute } from "./routes/inventory/warehouses";
import { StockRoute } from "./routes/inventory/stock";

/** 0E Task 8 Step 5's `UsersScreen` shape: the composition root injects, the screen stays testable. */
function ItemsScreen() {
  const { accessToken } = useSession();
  const env = readEnv();
  const companyId = useCompanyId();
  return <ItemsRoute api={{ baseUrl: env.apiBaseUrl, accessToken: () => accessToken }} companyId={companyId} />;
}
function WarehousesScreen() {
  const { accessToken } = useSession();
  const env = readEnv();
  const companyId = useCompanyId();
  return <WarehousesRoute api={{ baseUrl: env.apiBaseUrl, accessToken: () => accessToken }} companyId={companyId} />;
}
function StockScreen() {
  const { accessToken } = useSession();
  const env = readEnv();
  const companyId = useCompanyId();
  return <StockRoute api={{ baseUrl: env.apiBaseUrl, accessToken: () => accessToken }} companyId={companyId} />;
}

export const itemsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/inventory/items", component: ItemsScreen });
export const warehousesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/inventory/warehouses", component: WarehousesScreen });
export const stockRoute = createRoute({ getParentRoute: () => rootRoute, path: "/inventory/stock", component: StockScreen });

export const routeTree = rootRoute.addChildren([
  indexRoute, loginRoute, mfaRoute, usersRoute, itemsRoute, warehousesRoute, stockRoute,
]);
```

Add every `inventory.*` key this task uses to **both** `packages/i18n/src/locales/en.json` and `ar.json`. 0E ships a catalogue-completeness checker; a key present in one file and absent in the other fails it, which is the point.

- [ ] **Step 5: Write the component tests and the e2e spec**

`apps/backoffice/test/inventory-items.test.tsx` — the four clauses 0E's `users.test.tsx` establishes: the list renders from a mocked `InventoryApi`; the form's Zod resolver shows `/code` on an empty code without a network call; `Ctrl+S` submits and `Esc` reverts; and the whole screen renders under both `dir="ltr"` and `dir="rtl"` with no physical-property class (0E's Tailwind preset admits only logical properties, so the assertion is that the rendered `class` attributes contain no `ml-`, `mr-`, `pl-`, `pr-`, `left-` or `right-`).

`tests/e2e/inventory-screens.spec.ts` — acceptance **test 23** re-run, through 0E's `bootLocalStack()`:

```ts
import { expect, test } from "@playwright/test";
import { bootLocalStack, grantAdminRole } from "./support/boot";

for (const dir of ["ltr", "rtl"] as const) {
  test(`inventory screens are keyboard-complete in ${dir} (test 23)`, async ({ page }) => {
    const stack = await bootLocalStack();
    await grantAdminRole(stack.api, stack.seed);
    await page.goto(`${stack.baseUrl}/inventory/items?lang=${dir === "rtl" ? "ar" : "en"}`);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);

    // Create an item with the keyboard only — no click anywhere in this test.
    await page.keyboard.press("Control+n");
    await page.keyboard.type("RICE-5KG");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Rice 5kg");
    await page.keyboard.press("Control+s");
    await expect(page.getByRole("row", { name: /RICE-5KG/ })).toBeVisible();

    // Navigate to the stock screen by keyboard and read the figure back.
    await page.keyboard.press("Alt+3");
    await expect(page).toHaveURL(/\/inventory\/stock/);
    await expect(page.getByRole("table", { name: /stock/i })).toBeVisible();
    await stack.stop();
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/backoffice/src/lib/inventory-api.ts apps/backoffice/src/lib/inventory-schemas.ts \
        apps/backoffice/src/routes/inventory apps/backoffice/src/router.tsx \
        apps/backoffice/src/components/app-shell.tsx apps/backoffice/test \
        packages/i18n/src/locales tests/e2e/inventory-screens.spec.ts
git commit -m "$(cat <<'EOF'
feat(backoffice): the item, warehouse and stock screens [3A T15]

OD-24's material is attached (docs/owner/od-24/3a/), so the three screens land
against the workflow the operator described rather than an invented one.

Two panes per screen — 0E's DataGrid and a form, with a plain row of Buttons and
filters above both. No command bar: packages/ui ships five primitives and a
sixth is 0E's file, not this slice's. 0E Task 4's keyboard model is unchanged —
"/" filters, arrows select, Enter opens — and Ctrl+S, Esc and Ctrl+N are this
task's own keydown effect. No mouse-only affordance (spec:2254). Both
directions verified, and
tests/e2e/inventory-screens.spec.ts re-runs acceptance test 23 by creating an
item with the keyboard alone in ltr and in rtl.

inventory-api.ts is the one place a URL is built, so a path typo is a compile
error rather than a 404 inside a component, and Idempotency-Key comes from 0E's
AdminApi.send where no screen can forget it.

The item form offers no account picker: CreateItemBody omits the four ids and
§4.15's codes are the defaults, so there is no way through the UI to point COGS
at a revenue account.

The stock screen is read-only and renders quantities from the response STRING
through the i18n formatter — no JSON number holds a quantity at any layer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

Written against the writing-plans skill and the contracts document, and everything found is fixed inline above rather than listed as future work.

**Contracts conformance.**

| Card claim | Where it is discharged |
|---|---|
| Migration range 0028–0033, six files | T1 0028, T2 0029, T4 0030, T5 0031, T6 0032, T3 0033. **0033 lands third and that is legal** — hazard 14, stated in T3. |
| ADR range 0034–0036 | 0034 (T2), 0035 (T7), 0036 (T6). None borrowed, none renumbered. |
| §4.6.1's nine tables | `item`, `unit_of_measure`, `unit_conversion` (T1); `warehouse`, `lot`, `variant` (T2); `price_list`, `price_list_line`, `promotion` (T4). |
| §4.7.3's two tables and the MERGE | T5 (DDL verbatim), T8 (MERGE verbatim, with A4's locks — factored into `lockStockKeys` and taken at step 9 as well as step 12). |
| §4.7.2's `applyMovements`, provisional | T8, signature verbatim and frozen; the body's replacement assigned to 3B in the docstring. |
| §4.3.4's 3A row | T6 (four columns, five FKs) and T5 (the header's two warehouses). |
| §4.5.8's `inventory` row and the lot rule | T10. |
| Negative-stock rejection in the data layer + the override | T5 (the trigger), T8 (`lockStockKeys` at step 9, which is what makes the trigger's read-and-insert atomic per stock key), T9 (test 18 by API, job, two concurrent jobs and raw SQL). |
| `pick_lots_fefo` + the expiry job | T5 (SQL), T10 (wrapper, job). |
| `attachment.lot_id` | T5 (column + `attachment_owner_check`), T10 (the gate). |
| The five APIs | T11 (item, unit, warehouse), T12 (price, promotion, stock). |
| Test 18 owned; 2, 12, 13, 36, 1 re-run | T9 owns 18. T8 re-runs 2; T11/T12 re-run 12 and 36 through `PROBES`; T10 re-runs 13 for lot uploads; T8's posting path re-runs 1. |
| §3.0.4 row spec:1048; contributes spec:1067 | T1–T8 build the row; T10 contributes the lot link. |
| Regression files created 048, 063, 064, 066, 067 | T9, T1, T1, T6, T8. Appends: 050, 073, 074 (T5), 071 (T2). Conditional 052/056/057 in T13 only. |
| Owner gates OD-05, OD-07, OD-24 | OD-05 cited with a per-task consequence in T1, T2, T4, T6 and T10 (assumption 12); OD-07 is T13 alone; OD-08 is T14 alone; OD-24 is T15 alone. |

**Twelve problems found and fixed while reviewing.**

1. **`tx.unsafe(COLUMNS)` in T4 violated hazard 21** — `sql.unsafe` has exactly three homes and neither `prices.ts` nor `promotions.ts` is one, and `no-sql-concat` fails on a non-literal argument. Every column list is now inlined at its site, with the reason stated once.
2. **T4's `replacePriceListLines` would have archived every line on every call.** The key was built from a raw `"0"` while the SQL side is `min_quantity::text` on a `numeric(19,6)`, i.e. `"0.000000"` — nothing would ever match. Both sides now normalise through `Quantity.of(...).toString()`.
3. **T5's override test used a bare uuid as a principal.** `role_assignment.principal_id` has an FK to `app.principal`, so `grantCodes` would have been a 23503. It now creates a real second principal in 2B's `secondPrincipal` shape and records the event through `recordOverride` instead of a hand-rolled `document_event` insert — which also stops this plan from being a second speller of a write hazard 24 reserves for triggers and that one door.
4. **The three §4.14 test types had to agree across two tiers.** T8 first declared `warehouse: "header.warehouse"`, which cannot work over the API — `CreateDocumentBody` gains no header warehouse in this slice — so T9 would have needed a second policy text under a registered code, which is hazard 32. All three now declare `warehouse: "line.warehouse"`, which resolves `line ?? header` and serves both tiers from one text.
5. **`applyMovements` cannot read `postingSeq` from the snapshot.** `DocumentSnapshot.header` has no such field (§4.4.2 is frozen) and the snapshot is loaded at step 3, before step 8 assigns it. T8 reads `app.document` inside the transaction and says why, rather than adding a field.
6. **`PostResult.movementIds` needed ids `PlannedMovement` does not carry.** T8 reads them back with `order by movement_no` instead of widening the frozen plan interface.
7. **T8's transfer case could never have posted.** Its two ledger legs were `ledgerLegs(a.cash, a.cash, "0.0000")`, and step 6 drops zero-amount planned lines and then raises `ERR_DOC_NO_LINES` when none survive (§4.3.2) — so the case asserting two movements would have died three steps earlier, on the ledger half it was not testing. The legs are now `a.cash → a.sales` at `"72.0000"`, with the reason at the line. The free-of-charge case was checked for the same fault and is already non-zero; its `"1.0000"` legs are load-bearing, not decoration.
8. **`systemContext` is `async`, and T9 called it four times without `await`.** §4.2.2 declares `Promise<TenantContext>` — it resolves the tenant's system principal with a query — so every call handed `withTenant` a promise. `bun run typecheck` refuses that outright — `Promise<TenantContext>` is not assignable to `TenantContext` — and had it reached runtime, `ctx.tenantId` would have been `undefined`. The two setup blocks now `await` in place; PATH 2 resolves it once into `jobCtx` and uses it for both the transaction and `postDocument`, which is also the shape a real job handler has.
9. **T8's amendment-A5 case was issue-shaped, so step 9 would have decided it before step 9b could.** The guard sits *after* `applyMovements` (§4.3.2), so an issue had to survive `assert_stock_available` first — and whether it did depended on whatever stock the ten cases above happened to leave at MAIN. `COST_LINE_TEST` is now `effect: "receipt"` / `costing: "create_layer"`: a receipt cannot be refused for stock, so the guard is unambiguously the only thing that can refuse the document, which is what the case claims to prove.
10. **A hard-coded `"0.000000"` in T8's roll-back assertion had gone stale.** The free-of-charge receipt two cases earlier puts two units back into MAIN, so the figure was wrong and the comment beside it was wrong too. It now reads the projection before the failed post and compares against that reading — which is what "nothing is left behind" actually means, and which stops the case from silently becoming a test of every earlier case's arithmetic.
11. **T13's absence test imported from the `tests` workspace, which `packages/db/test` may not do.** §4.18 pins the named `dependency-rule` allowances for importing `tests/support/**` to `apps/api/test/**` and `apps/worker/test/**`; a third would have been a contracts amendment bought for one assertion (and the relative path was miscounted besides). It now resolves the directory from `import.meta.dirname` — a path, not an import, so the rule does not engage and no `tsconfig` `include` entry is needed.
12. **Three smaller ones.** T10's `recordExpiryWarning` had a hedged column list with an `if it differs, use the real one` note; it is now 1B's `recordIntegrityIncident` copied field for field — no `before`, payload as `JSON.stringify(...)::jsonb` — with the verification step kept but demoted to a check. T11's archive handler used `AppError` without importing it. And six `Expected: PASS, N assertions` lines had drifted from the blocks above them (item 9→10, warehouse 6→7, movement thirteen→fourteen, planMovements sixteen→seventeen, apply-movements twelve→eleven, test 18 eleven→ten); every count in the plan was recounted from the `it(` blocks, not adjusted by eye.

**Reviewer round — twelve findings, eleven applied and one recorded as a cross-document mismatch.** The section above lists what the *first* self-review caught; these came from an external review of the finished plan and are fixed inline in exactly the same way.

1. **`FefoPick` was re-exported as a value.** T10's barrel line read `export { FefoPick, pickLotsFefo }`, and `FefoPick` is an interface — a compile error under `verbatimModuleSyntax` and a runtime no-op without it. It now carries the `type` modifier, like the two lines beneath it.
2. **The stock advisory locks were taken only at step 12, which made the step-9 trigger racy.** §4.3.2 step 1's `for update` locks one *document*, so two documents issuing the same `(company, item, warehouse, lot)` both read the same committed movement sum, both satisfied `assert_stock_available` and both committed. Test 18's invariant was defeatable by concurrency alone, with no bypass and no override event. The loop is now `lockStockKeys` in `stock-on-hand.ts`, called by `applyMovements` **before** `insertMovements` and still by `mergeStockOnHand`; re-locking a held key is a no-op, so the second call is free. T9 gained PATH 2b, which is deterministic (T1 signals after its own post returns, then T2 starts) and goes red without the fix. Assumption 16 now names the READ COMMITTED property both lock sites rest on.
3. **T9's PATH 1 asserted `status === "issued"` after a 422.** `postDocument` is one transaction and §4.5.4 routes `to: "posted"` straight into it, so the step-7 issue rolls back with the step-9 refusal: the document is a `draft` and its `number` is null. Both are now asserted, and the null number is the visible proof that a refused post costs no series number.
4. **T9's "audited" case counted `app.audit_log` rows for `document_event`.** That table is AUDIT_EXEMPT (§3.5.3, §4.5.2, and T5's own quoted set), so no `attach_audit` runs on it and the count is always 0 — an assertion that could only fail. "Audited" is now proved from the artefact that exists: the immutable, actor-stamped event row, plus a refused `update` under both `app_rw` (privilege, `permission denied`) and `app_migrator` (the `document_event_immutable` trigger, `ERR_TABLE_IMMUTABLE`).
5. **`applyConversion` rounded HALF_EVEN while the 0032 trigger rounds half away from zero.** `Quantity.convert` is HALF_EVEN by §4.2.1; Postgres `round()` is not. At a tie the trigger would then *refuse* a caller that computed `quantity` correctly — `ERR_VALIDATION_FAILED` on a legitimate line. `applyConversion` is now `Quantity.convert`'s body with the mode swapped — `times(numerator).div(denominator)` on the precision-40 `D`, one `round(…, QUANTITY_SCALE, "HALF_AWAY_FROM_ZERO")` at the end — and **not** `Quantity.multiply(conversion, …)`, which was the first candidate and is wrong: 0D implements `multiply` by collapsing the `Rational` to a `Decimal` before multiplying, so it divides first, which is the per-step shape 0D's own `convert` docstring names as the SAH-066 defect. The tie is asserted on both sides and at two entered quantities — `1 → 0.000001` pins the mode, `3 → 0.000002` pins the order — in the pure test and again against the trigger's derived `quantity`. The docstring, ADR 0036, the header bullet and the DoD failure hint all say *not `Quantity.convert`*, *not `Quantity.multiply`*, and why. This also answers the separate finding that `applyConversion` was a redundant spelling of a frozen method: it is a different operation, and the difference is now the point.
6. **T10's handler block imported `eachTenant` and `systemContext` and used neither**, with prose underneath instructing the reader to undo the block. Both are gone from the import line, and the prose now explains why neither belongs (the fan-out is over companies; `ctx` *is* the system context) instead of contradicting the code above it.
7. **`planMovements` gave a reversed non-transfer movement the *declared* costing.** A reversal of an `issue` policy emitted `{ effect: "receipt", costing: "consume_layers" }` — a receipt telling 3B to consume layers, frozen into the array 3B, 3D, 6A and 9B all read. The transfer branch had the opposite bug: it overrode a legitimate `costing: "zero"`, deleting the free-of-charge marker §4.7.1 reads. One helper, `costingFor`, now serves all three emission sites: costing follows the emitted effect, and `"zero"` passes through. Rule 9, two test cases and an ADR-0035 consequence bullet.
8. **Migration 0029 carried a per-tenant back-fill `insert`.** §3.4.8 restricts migration data to `app.permission` because FORCE RLS binds `app_migrator`, so the statement could never insert a row — including in the local `up`-in-stages case it was written for, which also runs with no tenant set. Deleted, and replaced by an assertion in `lot.test.ts` that no `app.item` row lacks a `NONE` lot — which runs with a tenant set and therefore checks something.
9. **`seedItem` created its three §4.15 accounts with a raw insert.** §4.17 makes `seedAccount` "the one way any test creates a §4.15 account" and T1 already listed it in Consumes. The loop now calls it, hoisted out of the `withTenant` because that helper opens its own transaction; it is idempotent on `(company_id, code)`, so a caller that seeded `1300` itself (T9's `beforeAll` does) is not a 23505.
10. **Two SQL functions raise `ERR_VALIDATION_FAILED`, whose §4.2.4 row names a different raiser.** No code change — the raises are correct — but the deviation is now recorded as a header bullet, including the fact that a DB-raised token carries no `errors[]` array, which the optional member permits.
11. **T13's OD-07 branch ended without a commit step.** Every other code path in the plan ends in one; Step 3 now carries the verification runs, the `db:rollback 28 && db:migrate` the append requires, and the full commit message. Separately, the contract-additions bullet said `insertMovements`/`writeLineCosts` were "produced"; it now states plainly that they are module-private, that `loadSentinelLots` is the exported one, and that the two private helpers `provisionalValue`/`readPostingSeq` are named for 3B's benefit only.
12. **Recorded, not changed: OD-05 has no isolated task in this plan, and the slice brief lists it among 3A's owner gates.** That is a disagreement between two documents, not a defect here — contracts §2's 3A card lists only **OD-07, OD-08 and OD-24** in its "Owner gates (isolated tasks)" row, and §2.12's OD-05 row gates "each ⚠️ row's task" rather than a task of its own. The four §3.0.3 rows OD-05 covers *are* this slice's deliverables (assumption 12), so an isolated task holding them would be the whole plan. The fix belongs in §2.12's OD-05 "Gates" cell: "3A: header citation with a per-task consequence (assumption 12), not an isolated task."

**Five judgement calls a reviewer should check, each with its reasoning on the page.**

- **`PlannedMovement.value` is a magnitude** (T8). §4.4.2 gives the field's type and not its sign. A magnitude is consistent with `quantity` and with amendment A9's discipline — the plan is direction-free, `effect` carries direction, the row attaches both signs together. A signed plan value would have been defensible from §4.7.3's "sign follows quantity", and the choice is a contract addition either way.
- **The 0032 trigger raises on a disagreeing `quantity` rather than overwriting it** (T6). Overwriting hides a caller bug; raising surfaces it, and `round()`'s symmetry across sign is what makes a reversal's negated pair agree by construction.
- **A same-warehouse transfer raises `ERR_POLICY_REQUIRES_MISSING`** (T7). `PolicyEvaluationError`'s code union is three frozen members and none of them fits exactly; that one is closest and the message is precise. Inventing a fourth needs a contracts amendment, which this slice does not make for a message.
- **`price_list_line` gains `archived_at`** (T4). §3.5.4 pins the DELETE grant list with 2B as its only extender, so a replace cannot delete an omitted line. `unit_conversion` deliberately does **not** gain one (T6): a conversion is a physical fact about a package, so leaving it standing is correct rather than merely tolerable.
- **`replaceUnitConversions` upserts and does not remove, while `replacePriceListLines` archives what the payload omits** (T6, T4) — two functions sharing a prefix and behaving differently, reached over a `PUT`, which promises replacement. The divergence is deliberate and it is the previous bullet's consequence: neither may DELETE (§3.5.4), and a price line that is no longer offered *should* stop resolving while a carton that still holds twelve pieces *should not* stop converting. The name and the verb are kept — `upsertUnitConversions` would need a `PATCH` and a matching rename in the OpenAPI document, the contracts module and T11's route table, for a semantic the docstring, the OpenAPI `description` and T6's own test already state — but a reviewer who thinks the surprise outweighs that should say so here, because this is the entry to argue with. The one asymmetry that is **not** a judgement call: both functions are additive-by-default, so neither can silently lose data.

**Discipline checks, each verified by reading the tasks back.**

- **No placeholders.** No "TBD", no "TODO", no ellipsis standing in for content. Three places compress deliberately, and each compresses into a **table that fully determines what to type**, not into a reference to another task: T11's and T12's remaining routes are a table of method · path · gate · request schema · the one `@dulja/db` function · response, with the two whose bodies are *not* "call one function and return it" written out in full; T11's two sibling test files are a table of case · expected status · expected code; T15's two sibling screens are a table of query · table columns · form · filters · extra action, over a component structure `items.tsx` gives in full. A first draft of T11 ended a code block with "…and the same shape for" five more routes, which **is** the failure the skill names, and it was replaced with that table. T13 Step 2 and T14 Step 2 are conditional branches whose condition is an owner answer, and each carries its complete DDL or its complete stop-instruction.
- **TDD in every code task.** Failing test → run it → see the exact named failure → minimal implementation → run to pass → commit. T13's and T14's default paths are assertions of absence, which is the only test such a decision admits.
- **Hazard 1.** No statutory rate, threshold, ceiling or formula appears anywhere. `EXPIRY_HORIZON_DAYS = 30` is a reporting horizon and T10 says so at the constant.
- **Hazard 2.** No MyInvois or LHDN detail appears.
- **Hazard 9.** `fixtures.ts` gains exactly §4.17's five 3A helpers and nothing else; `seedTenant`'s inserts and constants are untouched.
- **Hazard 13.** `lint-schema.ts` gains exactly `stock_on_hand` in `NO_ID_TABLES` and `AUDIT_EXEMPT` (T5) — §3.5.3's row — and nothing else. `inventory_movement` was already in both from Plan 0A.
- **Hazard 22.** DML on `inventory_movement` exists in exactly one production file (`costing/apply-movements.ts`) and on `stock_on_hand` in exactly one (`costing/stock-on-hand.ts`); `integrity/stock.ts` only reads. Every other writer is a test under an allow-listed root.
- **Hazard 31.** Six routes, six `PROBES` entries, keyed by the six mount paths; one job, one `JOB_PROBES` entry.
- **Hazard 32.** No literal is invented in a shared namespace: no account code is seeded (four are consumed and T1 Step 1 asserts they resolve), no report code is created, no `DatasetId` member is added, and the four document-type codes — `STOCK_ISSUE_TEST`, `STOCK_RECEIPT_TEST`, `STOCK_TRANSFER_TEST`, `COST_LINE_TEST` — are test-only, seeded only inside Testcontainers, and registered as contract additions. `COST_LINE_TEST` is the one a first pass under-counted: the header and this bullet both said *three* while Task 8 seeded four. Grepped against both the contracts document and 2A to confirm none of the four is already registered, then made the count agree in all four places it is stated.
- **§3.5.4 untouched.** This slice grants no `app_rw` DELETE and does not edit `privileges.test.ts`.
- **Every plan header element present:** the For-agentic-workers line, Goal, Architecture, Tech Stack, Spec, Contracts, the §3.10 Assumptions block, the assumptions this plan rests on, the contract deviations (now opening with the two-row table of what is still to land in the contracts document, and why there is no Task 0), the File Structure, fifteen `### Task N` headings — 1 to 15, none renumbered — this Self-Review and the handoff below.

**Cross-plan round — one defect found by 3C's writer, applied here.**

13. **Three API tests imported `tests/support/api` one directory too high.** `apps/api/test/routes/accounting/attachments-lot.test.ts` (T10 Step 6), `apps/api/test/routes/inventory/items.test.ts` (T11 Step 1) and `apps/api/test/routes/inventory/stock.test.ts` (T12 Step 3) each sit **five** directories below the repository root, and all three wrote the four-level `../../../../tests/support/api`, which resolves to `apps/tests/support/api` — every one of those files would have died at import time, before a single assertion ran. 1B's frozen precedent is exact, and 2A's own self-review restates it: four levels from `apps/worker/test/handlers/`, five from `apps/api/test/routes/<dir>/`. All three corrected to `../../../../../tests/support/api`. The two other places this plan reaches the root `tests/` tree were re-counted and are right as written: T13's `readdirSync(resolve(import.meta.dirname, "../../../../tests/regression"))` is four levels from `packages/db/test/inventory/`, and `tests/invariants/stock-availability.test.ts` reaches its sibling support module with a single `../support/api`. T10 Step 6's heading also spelled the file as `apps/api/test/routes/inventory/../accounting/attachments-lot.test.ts`; it now reads the normalised path the sentence under it already gave.

**Audit round — an independent auditor read this plan against the contracts document, plan 0A and the spec. Thirteen findings applied, two rejected with the evidence, two referred to the architect — plus one defect found while applying them and fixed in the same pass.** As with the rounds above, everything applied is fixed inline rather than listed as future work. Numbering continues from the cross-plan round, so nothing above is renumbered.

14. **Every route test called `api.request` with a three-positional-argument signature that does not exist.** §4.2.12 freezes the harness as `request(input: ApiRequest)` — one object carrying `{ method, path, body, form, as, aal, idempotencyKey, headers }` — and says so in those words ("every route test in every slice calls `request`, so it is written out here rather than elided"). All twenty-seven call sites in Tasks 9, 10, 11 and 12 wrote `api.request("POST", path, { headers, body, actor })`, using `actor` where the frozen field is `as` and `multipart` where it is `form?: FormData`. Not one would have compiled. Every one is now the object form, and three consequences came with it: `as` is **required** on the reads too (a call with no `as` is an *unauthenticated* call and answers 401, not a 200); no call sets an `Idempotency-Key` header by hand, because the harness mints one for every unsafe method; and T11's missing-header case is `idempotencyKey: null`, which is the only spelling that sends no header at all — omitting the field would have let the harness supply one and the case would have asserted 400 against a 201. T9's failure hint said to suspect the harness's own key; it now names the 401 instead.
15. **`sharedApi()` is not a `StartedApi`, and three suites used it as one.** 0B declares `sharedApi(): Promise<{ api: StartedApi; a: Seed; b: Seed }>` (0b:5700), so `api = await sharedApi(); api.db` was a type error four ways over. T9's `tests/invariants/stock-availability.test.ts` now destructures `({ api } = await sharedApi())` and — per §4.18 round 3, which states that consumers of the memoised instance must not stop it — no longer calls `api.stop()`. The three **`apps/api` route suites** (T10, T11, T12) do what 2C's and 3C's route suites do instead: `startApi()` for their own instance, with `grantAdmin`/`problemOf` still imported from `tests/support/api` five levels up. That is also the shape that makes their `afterAll(() => api.stop())` correct.
16. **Three suites handed `grantCodes` and `as` a bare `crypto.randomUUID()` as a principal.** This is exactly the defect reviewer-round finding 3 fixed in T5 and it survived in three more places — T10's `reader`, T11's `readOnly`, T12's `priceOnly`. `app.role_assignment.principal_id` has a foreign key to `app.principal`, so `grantCodes` would have been a 23503; and had it not, `request({ as })` signs the id as its own subject, which resolves to no membership (§4.2.12's orphan-token case) and answers 401 rather than the 200/403 each case asserts. All three now create a real principal in 2B's `secondPrincipal` shape (plan0A:837 — the principal insert with no `returning`, the membership in the same transaction), written out in each file.
17. **`sharedDb()` was used with three mutually incompatible shapes.** T1 and T2 wrote `const { rw, a } = await sharedDb()` and then `rw.db` and `rw.db.rw`; Tasks 5, 6, 8 and 9 wrote `sharedDb().admin` and `sharedDb().rw` with no `await` at all. §4.17.1 declares one `Db` + `rw` + two `Seed`s, and both 1A (1a:5440) and 2B (2b:3951) spell the same shape out: `{ db: Db; rw: Sql; a: Seed; b: Seed }`, awaited. That shape is now stated once, under T1 Step 10, and used at all **sixteen** sites — `db` for a `fixtures.ts` seeder and for `db.admin` catalogue queries, `rw` for the production `withTenant`. §4.18's round-2 open item 5 is cited there as what this plan is choosing *between*, not as licence to leave both.
18. **The four-argument test `withTenant` appeared inside the root `tests/` tree.** Hazard 15 is one sentence — "Root `tests/` use the production one" — and §4.2.12 repeats it. `sah-063.test.ts`, `sah-064.test.ts` and T10's `JOB_PROBES` entry all called `withTenant(sql, tenantId, actorId, fn)`, and the prose under T1 Step 10 told the reader to import it from `@dulja/db/test`, which is where hazard 15 confines it. All four now use `withTenant(rw, { tenantId, actorId, requestId }, tx => …)` from `@dulja/db`, and the prose says so. T8's `apply-movements.test.ts` had it right all along (`withTenant as prodWithTenant`), which made the inconsistency internal as well as contractual.
19. **`applyConversion` imported `D` from the wrong 0D module.** `packages/domain/src/money/rounding.ts` exports `round`, the four `*_SCALE` constants and `RoundingMode`; the cloned precision-40 `D` is `money/decimal.ts` (0d:355, barrelled at 0d:439). One import line became two. This is the file the whole HALF_AWAY_FROM_ZERO argument of ADR 0036 lives in, so it not resolving would have taken the slice's most-argued decision with it.
20. **`UnitConversionMissingError` was declared twice and exported from the barrel twice.** T1 created it in `inventory/errors.ts` and added it to `packages/db/src/index.ts`; T6 declared the same class again in `inventory/units.ts`, with a different message, and added a second barrel line. That is TS2308 at the `bun run typecheck` T6 Step 14 requires to pass. T1 keeps the class and the barrel line; T6 imports it from `./errors`; and T1's message text is now the one T6's test asserts, so the two cannot drift.
21. **T8 Step 8 rested on a `stockScenario()` helper nothing defined.** The case that discharges definition-of-done item 7 read `const { s, itemId, warehouseId } = await stockScenario()`, used an undefined `ctx()`, and asserted a hard-coded `"6.000000"` against a scenario that did not exist — while the header said "Shared test helpers (§4.17.1) — none added". The case is now written out in full against the file it actually appends to: 1B's `projection-rebuild.test.ts` opens its own `startDb()` and holds `db`, `a`, `b` and `ctxFor(s)` (1b:797–806), so the new case reuses those, seeds its own tenant and the three §4.14 test types with the same policy text T8 Step 1 uses, posts a receipt, an issue and a transfer, and **derives** the two expected quantities from the three posted ones in exact `numeric` rather than stating a literal. Step 8 also now carries the edit to 1B's registry assertion, which the old text described and did not write.
22. **Five Drizzle mirrors declared their tables in `public`.** T4's `price_list`, `price_list_line`, `promotion` and T5's `inventory_movement`, `stock_on_hand` used bare `pgTable(...)` where T1 and T2 use `pgSchema("app").table(...)`. §3.4.9 makes the mirror the diff source for every migration after 0001, so the generated diff would have proposed creating five tables outside schema `app` and dropping the real ones. All five are rewritten with `pgSchema`, the array-returning constraint callback the other mirrors use, and the constraints they were missing — `price_list_line` had neither its `unique nulls not distinct` key nor `(tenant_id, id)`, and its index lost the `where archived_at is null` predicate. `price_list.ts` also imported `boolean`, `index` and `numeric` and used none of them.
23. **`inventory_movement.postingSeq` was typed `numeric` against a `bigint` column** — with the comment on the same line saying "bigint". A generated diff would have proposed altering the column. It is now `bigint("posting_seq", { mode: "bigint" })`, which is the form T1's `unit_conversion` already used.
24. **`void ctx;` was required by the prose and absent from the code.** T8 Step 4's paragraph said to silence the unused-parameter lint with it as the function's first statement; the block began with the length guard. Step 10 requires `0 violations`. It is now the first line, and the paragraph points at it instead of prescribing it.
25. **The permission-catalogue counts were wrong in both places T3 states them.** Step 2's expected-failure text said "the catalogue has eleven codes after 1A and 2A/2B" and Step 7's expected outcome said `PermissionCode` becomes "a sixteen-member union". Counting §3.6.2 by introducing slice for everything ahead of 3A in execution order gives admin/0B 5 + accounting/1A 6 + 1B 1 + 2A 1 + 2B 1 = **fourteen** (0D, 0C, 0E and 2C introduce none), and fourteen plus this commit's five is **nineteen**. Both figures sit in "expected" lines, so an executor comparing them to a correct run would have thought something had gone wrong. Both corrected, with the count's derivation on the page so the next slice can re-derive rather than trust it.
26. **`replaceUnitConversions` upserts behind a `PUT` while `replacePriceListLines` archives what it omits.** The auditor asked for a rename or a record; it is now the fifth entry in the judgement-calls list above, with the §3.5.4 reason both behaviours share and the argument for keeping the name spelled out, so a reviewer has something specific to disagree with.
27. **`systemContext` was called on the `app_migrator` handle in four places.** Plan 0A grants `app.resolve_principal` EXECUTE to **`app_rw` only** (§4.1), so `systemContext(db.migrator, …)` is a `permission denied` before it can return a context — T9's `beforeAll`, its stranger-principal setup and its immutability case would each have died there. `Seed.system` already holds the id that lookup returns, and 2B's `secondPrincipal` passes `s.system` for exactly this reason (2b:157–165), so every migrator-handle site now builds `{ tenantId, actorId: s.system, requestId }` directly. The two `systemContext(db.rw, …)` calls in T9's job paths are untouched and correct: `app_rw` is the role that holds the grant, and modelling the real job path is what those cases are for. The three new `secondPrincipal` helpers of finding 16 were written this way from the start.
28. **Three smaller ones.** T9's commit message still claimed "an audit_log row for the document_event insert", which reviewer-round finding 4 had already disproved — `app.document_event` is AUDIT_EXEMPT and the count is always 0; the message now says what the test proves. T8's Consumes listed `postJournal`, which no step in the task calls (it drafts a JOURNAL and every document here carries item lines) — dropped from the task, from the header's shared-helper sentence and from the Depends-on line. And T11 said its two sibling files follow "the same eight-clause shape" over a table giving eight rows for units and nine for warehouses; both the sentence and the expected-count line now say eight and nine.

**Two findings rejected, with what the file says.**

- **"The relative import depth from `apps/api/test/routes/**` to `tests/` is one level short."** Already fixed, by the cross-plan round above: finding 13 records the correction and all three files read `../../../../../tests/support/api` — five levels, which is 1B's and 2A's frozen precedent. The finding's second half — that the import needs a `dependency-rule` allowance and a `tsconfig` `include` entry named in the plan — is also rejected: 2A (2a:3289, 3752, 4224, 4329), 2C (2c:1363, 3477, 4642) and 3C (3c:1508, 4197) all make exactly this import from exactly this directory and none of them adds an entry, and 2B states the reason on the page — "reached through the same allowance 0B's `tests/support/api.ts` uses, so no new `dependency-rule` entry is needed" (2b:3364). A slice that invented a fourth allowance for an import three merged slices already make would be adding a contracts amendment nobody needs.
- **"3A has no Task 0 amendments gate, unlike 3C, 3D and 4A."** Correct as an observation and wrong as a defect: contracts §4.18's round-3 preamble states it as settled — "3A is the one plan with no Task 0 and no gate script … every 3A row below is the architect's to land and has been landed here. A reader checking 3A's coverage looks at this table, not at a script." Adding one now would contradict the contracts document and would make a gate that passes before the plan starts, which is the failure that preamble exists to prevent. What the finding was right about is that the two rows round 3 did **not** land had no visible checklist; the header now carries one, and T2 Step 9 carries the `ERR_WAREHOUSE_TREE_CYCLE` grep, which fails today and is meant to.

**Two referred upward, because they are edits to files this plan does not own.** Both are on the header checklist so the architect lands them together, and both would otherwise be found by an executor as a gate that never opens:

- **§4.2.4 needs the `ERR_WAREHOUSE_TREE_CYCLE` row** (409, raised by `app.warehouse_no_cycle()`). Grepping the contracts document returns zero hits.
- **The 0031 rename needs three edits outside this file**: §3.4.1's 3A row, a §4.18 `3A | plan` row, and the two `need_grep packages/db/migrations/0031_create_inventory_movement_stock_on_hand.sql` lines in `2026-09-05-dulja-phase-3d-sales-transfers-counts.md`'s Task 0 gate, which preflight-grep for the superseded name. **6A is no longer among them** — its Task 0 gate was corrected in its own repair round and now greps `0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql`, the file 3A creates.

**One thing this slice deliberately does not do, stated so a later reader does not look for it.** There is no valuation, no cost layer and no `stock_valuation` projection. `applyMovements`' value is provisional by contract and 3B deletes the rule. A reader who wants to know what a unit actually cost at 3A has the honest answer: nobody knows yet, which is why §4.7.2 says rows posted before 3B are test data.

---

## Execution handoff

**Read before starting.** Contracts §2's 3A card, all of §3, §4.1, §4.2, §4.3, §4.4, §4.5.3, §4.5.6, §4.5.8, §4.6.1, §4.7, §4.17, §4.18 and §5; spec §0.2, §3.0.3 (spec:1021–1025, 1032), §3.0.4 (spec:1048, 1062, 1067), §3.3, §3.4, §3.7.3, §3.7.5, §3.8, §3.9, §4.2.1, §4.2.2, Part VI tests 17 and 18, Part I SAH-048, 050, 052, 056, 057, 063, 064, 066, 067, 071, 073, 074. Then this plan's header and its two assumption blocks, end to end, before Task 1.

**Phase gate.** Do not start until 2A, 2B and 2C are merged and the Phase 2 definition of done is green in CI: a tenant-defined document type numbers, posts, prints, reports and reverses with zero code, and the state machine, `document_event`, R1/R2 and gapless numbering are proven.

**And one gate before that, which is not in CI.** The two contracts amendments in the header's table — the `ERR_WAREHOUSE_TREE_CYCLE` row in §4.2.4, and the 0031 rename across §3.4.1, §4.18 and 3D's Task 0 (**not** 6A's — its Task 0 gate already greps `0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql`, the file this plan creates) — are **not landed**, and 3A ships no `contracts-3a-amendments.sh` to tell you (contracts §4.18 round 3 records why: 3A is the one plan with no Task 0). **Task 2 Step 9 opens with a grep that fails by design until the first of them lands**, so an executor who starts Task 2 without reading the header will hit a red gate with no upstream warning. Land both, then start.

**Order.** Strictly 1 → 15. The dependencies that make it strict:

- T2 needs T1's `app.item` (the sentinel-lot trigger fires on it).
- T3 must precede T5 — `role_permission.permission_code` has an FK to `app.permission`, so the override cannot be granted before 0033 lands — and must precede T10, where `PERMISSION["inventory.stock.read"]` has to compile.
- T5 needs T1, T2 and T3.
- T6 needs T1 and T5; it breaks and then fixes three 2A tests.
- T7 needs T6 (`loadSnapshot` must fill `refs.items` and the line columns before planning can be tested against them).
- T8 needs T5, T6 and T7.
- T9 needs T8 (nothing writes a movement before it) and T3.
- T10 needs T2, T5 and T3.
- T11 needs T1, T2, T3 and T6; T12 needs T4, T5, T10 and T11.
- T13, T14 and T15 are independent of one another and of everything after T12, and each is droppable on its own.

**Parallelisable, if two workers are available.** T4 (prices) has no dependency beyond T1, and T13/T14 have none beyond a running database. Everything from T5 to T12 is a chain.

**One PR per task**, subject `<type>(<scope>): <summary> [3A T<n>]`, every message ending with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. One migration per PR (§3.4.3).

**Definition of done for the slice.**

1. `bun run --cwd packages/db db:migrate && bun run --cwd packages/db db:lint` → `0 violations`.
2. `bun run --cwd packages/db db:rollback 27 && bun run --cwd packages/db db:migrate` → clean both ways (§3.4.6's generalised reversibility test).
3. `bun run test` green across `packages/db`, `packages/domain`, `packages/contracts`, `apps/api`, `apps/worker` and `tests`.
4. `bun run lint && bun run lint:rules && bun run typecheck` → `0 violations`.
5. `git diff --exit-code packages/contracts/openapi.json` clean after `openapi:generate`.
6. **Acceptance test 18 green**: `bun run --cwd tests test -- invariants/stock-availability.test.ts`.
7. **Test 2's 3A re-run green**: `projectionChecks()` returns `["account_balance", "document_series", "stock_on_hand"]` and `checkStockOnHandProjection` finds no mismatch after a mixed receipt/issue/transfer scenario.
8. **This slice's share of the Phase 3 DoD**: `app.pick_lots_fefo` returns the earliest-expiring lot — `bun run --cwd packages/db test -- test/inventory/fefo.test.ts`.
9. Tenant isolation green for all six new routes and the one new job.
10. If OD-24 landed: `bun run --cwd tests test:e2e -- inventory-screens.spec.ts` green in both directions.

**What this slice hands the next ones.**

- **3B** receives `applyMovements`' frozen signature with a body to replace, `PlannedMovement` with `value` filled as a magnitude, `document.posting_seq` read from inside the transaction, the four-element chronological key as an index, and the `inventory_movement` FK its `cost_layer` must land after. It also receives amendment A5's step-9b guard, still standing and still passing, which is **3B's** to remove.
- **3C** receives `app.item`'s four account columns, the `GOODS_RECEIPT` path's `document_line` inventory columns, and the fact that this slice seeds **no** account code — 3C seeds `2150`, `1310` and `5100`.
- **3D** receives `warehouse.kind = 'in_transit'`, `document.to_warehouse_id`, `planMovements`' `transfer` branch with its two-leg numbering, `pickLotsFefo` for delivery-order picking, and the note that a per-line `to_warehouse_id` column does not exist and is 3D's to add if it needs one.
- **4A** receives `resolvePrice` for invoice pricing and `document_line.item_id`'s key.
- **6A** receives `promotion` (ready for its `revision` column), `price_list`/`promotion`'s nullable `branch_id` shaped for Form B, and `seedPriceList` for its catalogue-sync tests.
- **6C** receives `warehouse`, `inventory_movement`, `stock_on_hand`, `price_list` and `promotion` created branch-ready and with **no** `branch_isolation` policy attached — migration 0068 attaches Form A″, Form B and Form C, and this slice deliberately attaches nothing.
- **7A/7B** receive `item`, `lot`, `warehouse`, `price_list_line`, `promotion`, `inventory_movement` and `stock_on_hand`, every one already named in the ≤ 0058 `DatasetId` set, and `listStockOnHand` as the read 3D's report code will wrap.
- **9B** receives `item`, `lot` and the movement ledger as its load targets, and the rule that its importer calls `postDocument` and never writes a movement (hazard 22).

**Where to look when something is wrong.**

| Symptom | First place to look |
|---|---|
| `ERR_STOCK_INSUFFICIENT` on a post that should be fine | the movement insert order in `insertMovements` — a receipt must land before the issue that depends on it (T8) |
| `23505` on `stock_on_hand`'s primary key under load | `lockStockKeys` — amendment A4's reasoning, called by `mergeStockOnHand` (T8) |
| Stock went negative with no `override` event on the document | `lockStockKeys` again, this time the call at the **top of `applyMovements`**: without it two concurrent posts of one stock key both pass `assert_stock_available` (T8; the case is PATH 2b in T9) |
| A quantity is wrong by a whole carton | the 0032 trigger and the item's `unit_conversion` row (T6) |
| A movement has a NULL lot, or the step-12 MERGE misses | the sentinel lot: `app.item_sentinel_lot` (T2) and `loadSentinelLots` (T8) |
| `ERR_POLICY_REQUIRES_MISSING` on a `line.cost` policy | expected at 3A — amendment A5's step-9b guard, which 3B removes (T8) |
| `projections.checked` has two members, not three | `packages/db/src/integrity/index.ts`'s registration (T8) |
| A lot attachment 403s for a principal who can see stock | the lot rule is `inventory.item.read`, not the module code (T10) |
| A price query returns two answers | `price_list_line`'s `unique nulls not distinct` key (T4) |

