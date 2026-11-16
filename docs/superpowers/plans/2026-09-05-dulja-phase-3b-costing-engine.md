# Dulja Phase 3B — Costing engine, cost layers, replay job, valuation

**For agentic workers:** every task below is self-contained. Read the task, open the files it names, and type what it shows. Do not read the other tasks first; do not look for context outside the paths a task names. Every signature, every SQL statement and every test assertion you need is written out in the task — where this plan repeats the contracts document, the repetition is deliberate (contracts §5 item 35: "a task's implementer sees only their own task").

**Goal.** Build the one costing implementation the whole system calls, and the machinery that keeps it honest when a document arrives late. Concretely: `app.cost_layer`, `app.cost_consumption` and `app.stock_valuation`; `company.costing_method` defaulting to `'avco'` with FIFO behind the same layer model; a pure `costingEngine` in `packages/domain/src/costing/` that refuses a negative unit cost, refuses an issue that exceeds the open layers, refuses a movement with no value and no way to compute one, and refuses a divisor below one micro-unit (amendment A22 — §4.7.1's doc comment says "clamped"; clamping a sub-micro divisor still yields the exploded unit cost test 6 forbids, so the engine refuses instead); the full body of `applyMovements`, which replaces 3A's provisional one and 2A's fail-closed step-9b guard so that posting inserts movements, then layers, then consumptions, then writes `document_line.cost`; `invalidateFrom` plus the `inventory.cost.replay` job, which replays forward from a back-dated document's own chronological point in bounded transactions and posts a visible `COST_ADJUSTMENT` document through the posting service rather than rewriting history; a valuation read under `inventory.cost.read`; and the `stock_valuation` snapshot with the nightly `inventory.projection.rebuild` rebuild-and-compare. At the end of this slice: twelve months of movements plus a purchase back-dated into month three recomputes months three to twelve and nothing earlier, in time proportional to the affected movements, with an adjustment entry a reader can explain; and the stock-valuation figure and the cost figure a profit report reads come out of the same function.

**Architecture.** The split of contracts §3.1 is unchanged and this slice deepens it once more. The **pure** half — the layer model, the AVCO and FIFO consumption algorithms, the guards, the running average — lives in `packages/domain/src/costing/engine.ts`, imports nothing but `decimal.js` and `packages/domain`'s own money module, and never touches a database, a clock, a network or a random number. That is what makes `tests/golden/costing/` a byte-comparable fixture set (spec:2264) and what makes LEGACY-009 unrepeatable: there is exactly one formula, in one file, and reporting, valuation and posting all import it. The **I/O** half lives in `packages/db/src/costing/` — `apply-movements.ts` (the `postDocument` step-9 hook and the only writer of `app.inventory_movement`), `invalidate.ts`, `replay.ts`, `valuation.ts` — and is exported from `@dulja/db`. Layers are *derived*: `inventory_movement` is the append-only record, `cost_layer` and `cost_consumption` are rebuildable from it, and a back-dated document invalidates rows at or after its own `(effective_date, posting_seq)` and no earlier row (spec:1216–1221). The replay never edits a posted ledger entry; it posts a new `COST_ADJUSTMENT` document through `postDocument`, so contracts §5 item 22 holds — nothing outside `packages/db/src/posting/` and `packages/db/src/costing/` writes a ledger, movement, layer or projection table.

**Tech Stack.** TypeScript on Bun (apps and packages) with Vitest on Node 24 for tests (D5); PostgreSQL 18 through `postgres.js` tagged templates; Drizzle ORM mirrors for reads and as the migration diff source (ADR-0002, contracts §3.4.9); Hono + `@hono/zod-openapi` for the valuation route; `decimal.js` behind `Money` and `Quantity` (0D); pg-boss for `inventory.cost.replay` and `inventory.projection.rebuild` (0D); Testcontainers for every database test. No package version appears in any source file — the lockfile owns versions (spec:104).

**Spec.** `docs/spec/rebuild-spec.md` v1.2 — §0.2 (spec:97–106), §3.3 the entity map's `InventoryMovement ── CostLayer + CostConsumption` line and the projections paragraph (spec:1198, 1204), **§3.4 in full (spec:1208–1228)**, §3.7 the POS posting rule (spec:1360), §3.8 the transactions paragraph, the linter-rule paragraph and the privileges block (spec:1368, 1370, 1979–1993), §3.9 (spec:2039–2051), §4.2.1 `inventory.cost.read` (spec:2148), §4.11 golden-file tests (spec:2262–2267), §5.2 `packages/domain` and `tests/golden/` (spec:2352–2389), Part V phase 3 row (spec:2289) and the §5.3 phase-3 confirmation row (spec:2404), Part VI tests 5, 6 and 7 (spec:2423–2425), Part I LEGACY-004, 005, 006, 007, 008, 009, 010, 015, 016, 017, 022, 054, 055, 060, 061, 062, 076. Contracts: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` (2026-09-07).

---

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 3B — Costing engine, cost layers, replay job, valuation. **Phase:** 3. **Phase gate:** this plan starts only when **3A** is merged and the Phase 2 definition of done (spec:2288) is green in CI, with 3A's own tests green on the head (spec:87). Phase 3's definition of done is not green until 3D; this slice owns one clause of it.
- **Depends on (merged):** **3A** (`app.item`, `app.unit_of_measure`, `app.unit_conversion`, `app.warehouse`, `app.lot` including the per-item `NONE` sentinel, `app.variant`, `app.price_list`, `app.price_list_line`, `app.promotion`, `app.inventory_movement`, `app.stock_on_hand` and its step-12 `MERGE`, `app.assert_stock_available()`, `app.pick_lots_fefo`, the provisional `applyMovements` in `packages/db/src/costing/apply-movements.ts` together with the three helpers 3A names as "internal, but named here because 3B replaces the body around them" — `loadSentinelLots(tx, itemIds)`, `insertMovements`, `writeLineCosts`; `mergeStockOnHand`, `STOCK_ON_HAND_CHECK`, `checkStockOnHandProjection`, `planMovements`, `applyConversion`, `resolveUnitConversion`, `pickLotsFefo`, `SENTINEL_LOT_CODE`, `INVENTORY_PERMISSION`, `document_line.warehouse_id`/`lot_id`/`unit_id`/`unit_quantity`, `document.warehouse_id`/`to_warehouse_id`, `loadSnapshot`'s `refs.items` and header warehouse fields, `seedUnit`, `seedItem`, `seedWarehouse`, `seedLot`, `seedPriceList`, the `stock_on_hand` `ProjectionCheck`); **2C** (`loadDocumentTypes` reachable as `@dulja/db/seed`, `assertPackShape`, `SUB_PACKS` including `"document-types"`); **2B** (`grantCodes`, `transitionDocument`, `setEventContext`, the status triggers, `SERIES_GAP_CHECK`); **2A** (`evaluatePolicy`, `balanceInBase`, `validatePolicy`, `parsePolicy`, `PlannedMovement`, `PostingPlan`, `DocumentSnapshot`, `LineSnapshot`, `ItemRef`, `posting-policy.schema.json` in full, `loadSnapshot` at its 2A fill, the step-9b guard this slice removes, `seedDocumentType`, `seedParty`); **1B** (`postJournal`, `ProjectionCheck`, `ProjectionMismatch`, `registerProjectionCheck`, `projectionChecks`, `runIntegrityCheck`, `IntegrityReport`, `reportsRouteModule`); **1A** (`postDocument`, `loadSnapshot`, `resolvePolicy`, `issueDocument`, `reverseDocument`, `PostingError`, `insertLedger`, `app.posting_seq`, `document.posting_seq`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount`, `JOURNAL_POLICY_V1`); **0D** (`Money`, `Quantity`, `currency`, `round`, `toBase`, `UNIT_RATE`, `MONEY_SCALE`, `QUANTITY_SCALE`, `RoundingMode`, `JOBS`, `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `registerHandler`, `runJob`, `eachTenant`, `startWorker`, `seedBranch`, `PERMISSIONS`, `ROLES`); **0B** (`withTenant`, `TenantContext`, `systemContext`, `createDb`, `AppError`, `ERRORS`, `PERMISSION`, `requirePermission`, `buildRoutes`, `RouteModule`, `IdempotencyHeader`, `createApp`, `AppEnv`, `startApi`, `PROBES`, `sharedDb`, `sharedApi`, `thinRegression`, `fullRegression`, `problemOf`, `grantAdmin`, `sourceFiles`, `REPO_ROOT`); **Plan 0A** (`startDb`, `Db`, `Seed`, the 4-argument test `withTenant`, `uuidv7`, `seedTenant`, `draftDocument`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `schemaFingerprint`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.forbid_change`).
- **Migration numbers:** 0034–0036 — files **`0034_create_cost_layer_consumption_valuation.sql`** (amendment A1 — the 3B card guessed `0034_create_cost_layer_consumption.sql` and contracts §4.6.1 puts `stock_valuation` in 0034 as well), `0035_alter_company_add_costing_method.sql`, `0036_seed_permission_phase3b.sql`, each with its hand-written `NNNN.down.sql`. **ADR numbers:** 0037–0039 — **0037** `0037-avco-is-the-v1-costing-method-and-fifo-shares-the-layer-model` (a **proposal**, spec:95: this touches money semantics), **0038** `0038-bounded-restartable-recost-and-the-cost-adjustment-document`, **0039** `0039-stock-valuation-is-an-as-of-snapshot-and-cost-layer-joins-the-projection-registry`.
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 `Money`/`Quantity`/`round`/`toBase`/`UNIT_RATE`, §4.2.2 `withTenant`/`TenantContext`/`systemContext`, §4.2.3 `AppEnv`/`RequestContext`/`Logger`, §4.2.4 `AppError`/`ERRORS`/`PostingError`, §4.2.5 `PERMISSION`/`requirePermission`, §4.2.6 `JOBS`/`JobPayload`/`JobEnvelope`/`JobClient`/`registerHandler`/`eachTenant`/`JOB_PROBES`, §4.2.7 `RouteModule`/`buildRoutes`/`IdempotencyHeader`/`PROBES`, §4.2.8 the common Zod schemas and the cursor codec, §4.2.12 `startApi`, §4.2.13 `readPackFile`/`PackLoader`, §4.3.1 the posting barrel, §4.3.2 the fixed algorithm (steps 6, 8, 9, 9b, 10, 12, 14), §4.3.4 `document_line`, §4.3.5 the chronological key, §4.3.7 the seed envelope and `loadDocumentTypes`, §4.4.2 the evaluator and amendment A9's sign normalisation, §4.6.1 the register rows for `cost_layer`/`cost_consumption`/`stock_valuation`, §4.16.3 `ProjectionCheck`/`registerProjectionCheck`, §4.17/§4.17.1 the fixture registers.
- **Interfaces produced:** §4.7.1 in full (`CostingMethod`, `Layer`, `Consumption`, `CostingInput`, `CostingOutput`, `CostingEngine`, `costingEngine`, plus amendment A2's `CostingError` and `MIN_MEANINGFUL_QTY`); §4.7.2 in full (`applyMovements`'s completed body, `invalidateFrom`, `replay`); §4.7.3's `cost_layer`, `cost_consumption` and `company.costing_method` verbatim, plus §4.6.1's `stock_valuation` row; §3.6.2's one `inventory.cost.read` code; §4.14's `COST_ADJUSTMENT` row; the two 3B-owned entries of §4.2.6's `JOBS` (`inventory.cost.replay`, `inventory.projection.rebuild`).
- **Two 0D behaviours every guard in this slice rests on, stated here because three tasks depend on them and neither is obvious from §4.2.1's signature list.** (1) **`Quantity.of` refuses more than six decimal places** — 0d:1034–1039 tests `/^-?\d+(\.\d{1,6})?$/` and throws a `RangeError`, so a sub-micro quantity *cannot be represented at all*. `MIN_MEANINGFUL_QTY` is therefore the smallest representable non-zero quantity, the refusal in `unitCostOf` is unreachable by construction from a `Quantity`, and it stays in the code as the guard that catches a future scale change rather than a runtime input (Task 3 guards case (b) asserts both halves). (2) **`Money.allocate` hands its residue by largest remainder with ties to the lowest index** (0d:474–477), not unconditionally to the first weight as §4.2.1's one-line summary reads; a zero weight has remainder zero and so cannot receive a residue unit while any positive-remainder share is unpaid. Task 2's AVCO split filters the zero-quantity shares out before allocating anyway, so the positional zip is correct by construction and not by that argument.
- **Owner decisions:** **OD-06** → **Task 4** (isolated); default `company.costing_method = 'avco'`. No other owner decision touches this slice — 3B has **no screen**, so OD-24 does not apply.
- **Part VI tests owned / re-run:** owned — **5** (back-dated costing, Task 9) and **6** (costing edge cases, Task 3). Re-run — **2** (`cost_layer`, Task 12; `stock_valuation`, Task 11), **7** partially (the cost side only — Task 13; 3D completes it and 7B re-runs it against 4B's `item_profitability`), **1** (the ledger invariant through an inventory-bearing document, Task 6), **12** and **13** and **36** for the three new tables. **§3.0.4 rows owned:** spec:1055 — cost layers, AVCO ⚠️, recost forward, one implementation, free-of-charge lines (3C contributes landed cost). **Regression files created / appended:** created — `legacy-004`, `legacy-006`, `legacy-007`, `legacy-009`, `legacy-010`, `legacy-015`, `legacy-016`, `legacy-017`, `legacy-022`, `legacy-054`, `legacy-060`, `legacy-061`, `legacy-062`, `legacy-076`, and **`legacy-055`** in the OD-06 task (contracts §3.7.3's "Conditional defects" paragraph names 3B as its creator and 7B as the appender — amendment A13); appended — `legacy-005`, `legacy-008` (both created by 0B, contracts §3.7.3).
- **Shared namespaces this slice writes into:** document-type codes (§4.14) — **`COST_ADJUSTMENT`**, module **`accounting`**, series `CA`, direction `internal`, `inventory.effect: "none"`, `approval.post: "accounting.journal.post"`, seeded as `packages/db/seed/my/document-types/COST_ADJUSTMENT.json`. **No *new* document-type code appears in this slice besides `COST_ADJUSTMENT`**: the registered test-only codes `POLICY_TEST` (2A, §4.14) and `STOCK_ISSUE_TEST` / `STOCK_RECEIPT_TEST` / `STOCK_TRANSFER_TEST` (3A, §4.14) are reused with this slice's own policies per amendment A14, which is what makes hazard 32 — *unregistered* codes — satisfied rather than the absence of every literal. Account codes (§4.15) — **none seeded**; consumed but seeded elsewhere: **`1300` Inventory control (0C)**, **`5000` Cost of goods sold (0C)** — resolved by code inside the replay job — and **`5900` Other operating expense (0C)**, which only the `STOCK_RECEIPT_TEST` *test* policy credits as a stand-in for 3C's GRNI; Task 8 asserts all three resolve before Task 9 uses them (contracts §5 item 33), and 3A's `seedItem` seeds all three idempotently in a Testcontainers company; `5920` FX rounding (0C, wired by 1A's `seedTenantV2`) is consumed only through `balanceInBase`. Report codes (§4.16.1) and `DatasetId` members (§4.16.2) — **none**: `inventory.valuation` is **3D's** code and 7B re-expresses it; this slice ships a valuation *read function and route*, not a report code (contracts §5 item 4 assigns the minimal inventory report set to 3D). `fixtures.ts` helpers (§4.17) — **none**; every fixture this slice needs is 3A's or earlier. Shared test helpers (§4.17.1) — **`postInventoryDocument`** in `tests/invariants/support/post-inventory.ts` under the `seedEmployee` rule (amendment A11: whichever of 3A/3B lands first commits it, the other verifies and extends its options additively).
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

### The twenty-three amendments this plan needs, and why

contracts:1261 says a plan implements §4's blocks **verbatim** and "may add members only by amending this document". Each row below is one amendment PR against the contracts document, landing **before** the task that needs it.

| # | § | Amendment | Task |
|---|---|---|---|
| **A1** | 3.4.1, 3.4.2 | Migration 0034 is **`0034_create_cost_layer_consumption_valuation.sql`**, not the 3B card's `0034_create_cost_layer_consumption.sql`. §4.6.1 assigns `stock_valuation` to `3B / 0034`, the slice's range 0034–0036 has no fourth slot, and §3.4.2's settled rule is "a file whose name understates what it does is renamed, not left" — the same rule that produced 2A's `0018_alter_document_party_fk_and_document_type_module.sql` and 2B's `0023_grant_document_draft_delete_and_add_series_gaps.sql`. The card's expected-name cell is amended to the long name. | T1 |
| **A2** | 4.7.1 | Five additions to the costing interface, all forced by the block's own prose. **(a) `CostingError` is declared with a body** — §4.7.1's doc comment says the engine "Throws ERR_COST_NEGATIVE" and "otherwise ERR_STOCK_INSUFFICIENT" but names no class; `packages/domain` may not import `AppError` (§3.1), so this is the `PolicyEvaluationError` situation exactly (§4.4.2) and takes the same shape: one class, three codes, each a literal member of `ErrCode`. **(b) `MIN_MEANINGFUL_QTY` is exported** rather than left as a comment literal, so the clamp is one name and not three copies of `"0.000001"`. **(c) `average` takes a second parameter, `baseCurrency: CurrencyCode`** — a `Money` cannot exist without a currency and `average([])` has no layer to borrow one from; this is the identical reasoning §4.4.2 already records for `balanceInBase`'s third parameter. **(d) `CostingInput.movement`'s intersection gains `movementId: string; lotId: string`** — `newLayer` is `Omit<Layer, "id">` and `Layer` carries both, but `PlannedMovement.lotId` is `string | null` (the sentinel is resolved by `applyMovements`) and `PlannedMovement` has no movement id at all; `(string | null) & string` reduces to `string`, so the intersection narrows the lot rather than redeclaring it, and the movement id is pre-generated with `select uuidv7()` before the engine is called, which is Plan 0A's own id convention. **(e) `CostingInput` gains `allowShortfall: boolean`** — `applyMovements` sets it when `movement.costing === "zero"` (a free-of-charge line, spec:1055) or when an `inventory.negative_stock.override` `document_event` exists for the document (F-6, test 7 and test 18). Without it the engine would refuse the very excursion 3A's override path exists to authorise, and test 7's "gone negative" clause could not be produced. **(f)** `CostingOutput.value` and `unitCost` are **magnitudes, never negative**: `effect` carries the direction exactly as `side` does for a planned ledger line (§4.4.2 amendment A9), and `applyMovements` writes `inventory_movement.value` as the negated magnitude for an issue. | T2, T3 |
| **A3** | 4.2.4 | One new `ERR_*` row and one widened union. **New row: `ERR_COST_VALUE_MISSING` — 422, raised by the costing engine (3B)** — "a stock movement reached the costing engine with no value and no way to compute one". LEGACY-007 is the Part I defect this slice owns and its fix is "value is a mandatory non-null attribute of every stock movement, rejected at write time if absent" (spec:1226); no allocated code says that (`ERR_COST_NEGATIVE` is about a computed sign, `ERR_POLICY_REQUIRES_MISSING` is about a policy input the *document* lacks). It joins `ERRORS` in the same PR that raises it, or `error-codes` (§3.7.5) goes red. **Widened: `PostingErrorCode` gains `ERR_STOCK_INSUFFICIENT`, `ERR_COST_NEGATIVE`, `ERR_COST_VALUE_MISSING` and `ERR_INTERNAL`** — all four are members of `ErrCode`, so the block's own rule ("a literal subset of ErrCode — never a new code") is respected, and §4.3.8 already lists the first two among the errors the posting service raises. | T2, T6, T7 |
| **A4** | 4.4.2, 4.3.2, 4.3.4 | **`document_line.cost` and `LineSnapshot.cost` are in the company's BASE currency, and `PlannedLedgerLine.role` gains `"cost"`.** §4.7.3 already declares `inventory_movement.value` "base currency", and a cost layer's `unit_cost` is base by construction — a layer outlives the exchange rate of the document that created it. 2A's `loadSnapshot` builds `cost: Money.of(r.cost, docCurrency)`, which is wrong in both directions: read as document currency it books a foreign-currency sale's COGS at the header rate (base COGS then depends on the sales rate, not on what the goods cost); read as base currency it makes `toBase(amount, rate)` throw `ERR_MONEY_CURRENCY_MISMATCH` inside `push`. The coherent fix is four one-expression edits, all in Task 5: `loadSnapshot` builds the field with `baseCurrency`; `evaluatePolicy` tags a planned line whose `amount` ref is `line.cost` or `line.variance_value` with `role: "cost"` and sets its `base` to the amount itself instead of calling `toBase`; `balanceInBase` is unchanged (it already sums `l.base`); and 1A's `insertLedger` widens its `isFx` branch to `role !== "policy"`, so a cost line is written in base currency at rate `1.00000000` exactly as an `fx_rounding` line already is. **The evaluator does the tagging, not `applyMovements`** — otherwise 3D's `line.variance_value` lines and every reversal of an already-costed document (whose `cost` is non-null and never passes through `applyMovements` at all) would carry the wrong currency and the wrong rate. | T5 |
| **A5** | 4.3.1, 4.2.3 | **`postDocument`'s input gains an optional `jobs?: JobClient`, and `AppEnv["Variables"]` gains an eighth member `jobs: JobClient`.** §4.3.2 step 14 requires `postDocument` to enqueue `inventory.cost.replay` "on this same `tx`", and `enqueue(tx, name, job, opts)` is a method on `JobClient` — which `postDocument(tx, ctx, { documentId })` has no way to reach. 3B is the first slice whose step 14 does anything, so it is the slice that opens the seam. The member is **optional**, so every 1A/1B/2A/2B/2C/3A call site compiles untouched: a document that plans no movement never consults it. When it is needed and absent — a back-dated inventory document posted through a caller that supplied none — `postDocument` fail-closes with `PostingError("ERR_INTERNAL", …)` rather than silently skipping a recost, which is LEGACY-005 (`CstChanged` never set on insert) reintroduced. `createApp` sets the Hono variable from `deps.jobs` in a two-line middleware; `apps/worker` handlers close over the client the entrypoint already constructed. | T7 |
| **A6** | 4.7.2 | `invalidateFrom`'s input object gains `jobs: JobClient` (required — its whole purpose is to enqueue), and **`replay` is registered through a thin `JobHandler` wrapper**: §4.7.2 gives it the signature `(sql, job, ctx) => Promise<{ movementsReplayed; adjustmentsPosted }>` while §4.2.6's `JobHandler<N>` returns `Promise<void>`, so `apps/worker/src/handlers/cost-replay.ts` registers `async (sql, job, ctx) => { const r = await replay(sql, job, ctx); log().info({ ...r }, "cost replay finished"); }`. The return value is contract because the job's own test asserts it; the registration adapts it. | T7, T9 |
| **A7** | 3.7.4 | For the **costing** area only, `expected.json` is a `CostingGoldenExpectation`: `{ plans: PostingPlan[]; consumptions: Consumption[][]; layersAfter: GoldenLayer[] }`. §3.7.4's sentence ("`expected.json` is the `PostingPlan`") still holds — the plans are in there — but a `PostingPlan` cannot express *which layers an issue consumed*, and LEGACY-009's entire failure was two implementations disagreeing about exactly that. The type is declared in `tests/golden/costing.test.ts` and the fixtures are `tests/golden/costing/<case>/input.json` (a `DocumentSnapshot[]`) plus `expected.json`. | T12 |
| **A8** | 4.2.7 | Register one `RouteModule` path: **`/v1/companies/:companyId/valuation`** → `valuationRoutes`, gate `inventory.cost.read`, with sub-paths `GET …/valuation` (as-of quantity and value per item and warehouse) and `GET …/valuation/layers` (the open layers of one item, the raw data 7B's `inventory.stock_ageing` reads). One `PROBES` entry keyed by that exact path. This is **not** the `inventory.valuation` report code of §4.16.1 — that is 3D's, mounted on 1B's `reports` module — and the two never collide because they are different modules on different paths. | T10 |
| **A9** | 4.2.6 | `JobPayload` gains the two 3B-owned keys — `"inventory.cost.replay": { companyId: string }` and `"inventory.projection.rebuild": { companyId?: string; asOf?: string }` — and `JOB_PROBES` gains an entry for each (hazard 31). The `JOBS` registry itself is **not** edited: both names and both schedules are already in 0B's closed sixteen-name const with `owner: "3B"`. | T7, T11 |
| **A10** | 4.16.3 | `cost_layer` joins 1B's `projectionChecks` registry, so **`IntegrityReport.projections.checked` becomes `["account_balance", "cost_layer", "document_series", "stock_on_hand"]`** — `projectionChecks()` sorts by name (1b:930–932), so the array is alphabetical and 3A's `stock_on_hand` needs no re-ordering. The three pinned assertions that read it — `tests/invariants/audit-chain.test.ts`, `apps/worker/test/handlers/integrity-check.test.ts` (both 1B's) and `tests/invariants/projection-rebuild.test.ts` — are updated in the same PR, exactly as 2B did for `document_series`. `stock_valuation` does **not** join it: it is an as-of history keyed by date, not a current-state projection, and its rebuild-and-compare belongs to `inventory.projection.rebuild` (ADR 0039). | T11, T12 |
| **A11** | 4.17.1 | Register **one row for the whole file `tests/invariants/support/post-inventory.ts`**, owner "**3A / 3B — whichever executes first**", under the `seedEmployee` rule of §4.17: the first of the two to land commits the file and the other's task is "verify these exports exist and their options cover this slice's needs", extending them additively if not. The row's Shape cell is the file's **full export list**, exactly as Task 6's Interfaces block declares it — `postInventoryDocument(db, s, opts): Promise<{ documentId: string; result: PostResult }>` with `PostInventoryOptions` and `InventoryLine`; `recordingJobs(): JobClient & { readonly enqueued: readonly RecordedJob[] }` with `RecordedJob`; **`ensureOpenPeriods(db, s, year): Promise<void>`**; and the two policy consts `STOCK_ISSUE_COST_POLICY` / `STOCK_RECEIPT_COST_POLICY`. (`postOverriddenIssue` and `postInventoryDocument`'s `beforePost` option are amendment A21(b)'s two additive rows against this same file, and stay there.) **`ensureOpenPeriods` is registered rather than left internal because a later slice's test names a month other than January only because of it** — Plan 0A's `seedTenant` creates three fiscal periods, one open, and `app.fiscal_period` carries an overlap constraint, so every slice whose fixtures span a year needs this one reopener rather than a second copy of it; **8B is the first, in every T13/T14 payroll suite**, and it depends on the name without being able to register it. **The contracts document does not yet carry the row**: §4.17.1's register lists no `tests/invariants/support/post-inventory.ts` entry, and §4.18's round 3 — the round that folds in plans 3A–9B — carries only two §4.17 rows (7A's `seedReportDefinition` and 5A's `DraftLine.taxCodeId`) and no §4.17.1 row at all. So this amendment is one of the ones round 3's own preamble exempts from "stays that slice's to land": *"an amendment a later slice depends on"*, which is the ⚑ treatment amendment A5 already has there, and landing it is the contracts editor's, not 8B's. Nothing in execution order breaks meanwhile — 3B runs in Phase 3 and 8B in Phase 8, so Task 6 Step 4 commits the file and the register row long before a payroll suite imports the name; what 8B cannot do is *cite* a register row that does not exist yet. 1B's `postJournal` is JOURNAL-shaped and cannot draft an item line; §4.17 assigns 3B no `fixtures.ts` helper and hazard 9 forbids inventing one beside the register, so all of it belongs in the test tier's own register beside `postJournal`. | T6 |
| **A12** | 4.7.3 | §4.7.3's closing paragraph calls `COST_ADJUSTMENT` "a `JOURNAL`-shaped document type (`direction: internal`, `account.code` lines for the `1300` inventory control and `5000` COGS accounts)". Realised as: **the policy addresses `{ from: "line.account" }` like JOURNAL's, and the replay *job* resolves the two §4.15 codes to `document_line.account_id`.** An `account: { code: "1300" }` reference cannot express "debit when the recomputed value rose, credit when it fell" — `document_line.debit` carries `check (debit >= 0)`, so the direction has to live in which column the job fills, and the job is the only thing that knows the sign. Hazard 33's rule is honoured through Task 8's assertion that both codes resolve in the company before Task 9 posts to them. | T8, T9 |
| **A13** | 3.7.3 | §3.7.3 states legacy-055's creator twice and the two disagree: the paragraph on conditional creators says "**055** — 7B (OD-06, with the stock-ageing report)" and the *Conditional defects* paragraph below it says "055 (FIFO — OD-06, **3B creates** with the FIFO layer path; 7B appends the stock-ageing report)". The 3B card's "Regression files created" list also names it. **Resolved in favour of the second: 3B creates, 7B appends** — the rule §3.7.3 itself states is that a conditional file's creator is "the slice that owns the conditional work", and the FIFO layer path is this slice's. The first sentence is corrected. | T4 |
| **A14** | 4.14 | **The `policy` a test configures through `seedDocumentType` is not part of a §4.14 code's registration.** 3A registers `STOCK_ISSUE_TEST`, `STOCK_RECEIPT_TEST` and `STOCK_TRANSFER_TEST` as test-only codes and notes that *its own* tests address them over `line.debit`/`line.credit` "so amendment A5's step-9b guard never fires". 3B is the slice that deletes that guard, so it configures the same two codes with a `line.cost` policy over `item.cogs_account` / `item.inventory_account` — the shape step 9 exists to fill. The §4.14 rows are unchanged (direction, `inventory.effect`, series and module all still hold) and **no new document-type code appears in this slice besides `COST_ADJUSTMENT`**. Without this, either the slice invents a fourth test-only code (hazard 32) or it cannot exercise a cost line at all. | T6 |
| **A15** | 4.3.1 | **`reverseDocument`'s input gains the same optional `jobs?: JobClient` as `postDocument`.** `reverseDocument` calls `postDocument` on the reversal document it creates, and a reversal whose `effective_date` precedes later movements of the same items **is** back-dated — so without the pass-through, amendment A5's fail-closed guard fires on an ordinary reversal and D13's reversal path breaks the moment Phase 3 ships. Optional for the same reason: a reversal that plans no movement never consults it. `voidDocument` needs nothing — a void writes no movement. The two API call sites (1A's post handler, 2B's `…/reverse` handler) each pass `jobs: c.var.jobs`. | T7 |
| **A16** | 4.7.2, 4.14 | **Three settled behaviours of the replay, recorded because a later slice will hit each one.** (a) One `COST_ADJUSTMENT` per **(fiscal period, `warehouse.branch_id`)** — `app.document.branch_id` is required, 3A's `warehouse.branch_id` is NOT NULL, and spec:1066 makes BRANCH meaningful on a COGS line, so grouping by branch is the only shape in which the adjustment tags correctly. (b) A **closed** source period carries the entry forward to the earliest open period on or after it, with `document.notes` naming the source period; **no** open period records an integrity incident and returns, rather than letting `ERR_PERIOD_NOT_OPEN` retry until pg-boss dead-letters the job. (c) The replay **does** rewrite `document_line.cost` on already-posted documents — it is the current answer, read by reversals, 3D's `line.variance_value` and every margin report, and two answers to one question is LEGACY-009; the audit trigger keeps the before-image and the adjustment reconciles the immutable ledger. All three are ADR 0038. | T9 |
| **A17** | 3.7.4 | **A golden costing case carries its own `policies.json` — an object keyed by `documentTypeCode`.** Amendment A7 fixes `expected.json`'s shape but leaves the policy unaccounted for: `input.json` is a `DocumentSnapshot[]`, a snapshot does not say how to post, and `expected.plans` came from an `evaluatePolicy` call — so the policy is fixture *input*. It is a **map, not a single policy**, because `inventory.effect` is a per-policy field and every costing case mixes receipts with issues: one policy would plan a receipt as an issue. The map lives per case rather than in the harness so a case wanting a different `inventory.costing` (a free-of-charge line) edits one file. Also recorded: **`bigint` is not JSON** — the harness serialises with a replacer rendering a bigint as its decimal string, and the fixtures store `header.number` and `postingSeq` as strings. | T12 |
| **A18** | 4.2.8 | The §4.2.8 contracts-module register gains **`packages/contracts/src/inventory/valuation.ts`** — the first `inventory/` module — with `ValuationRowSchema`, `ValuationQuery`, `ValuationList`, `CostLayerRowSchema`, `CostLayerQuery`, `CostLayerList`. It uses **literal `filter[<field>][<op>]` Zod keys**, which §4.2.8's round-2 settlement makes the default mechanism for a narrow surface (two filterable fields); `parseFilters` is for a wide or open one, and never both on one route. | T10 |
| **A19** | 4.7.2 | **Nine module-level names §4.7.2 does not carry, all of them consumed by more than one task or more than one slice.** `openLayersFor(tx, { companyId, itemId, warehouseId, baseCurrency }): Promise<Layer[]>` in `apply-movements.ts` — **the ONE open-layer reader**, and the most load-bearing of the nine: `applyMovements`, `replay`, `valuationAsOf`'s sibling reads and Task 13's helpers all call it, and 3C, 3D, 4B and 7B will each need the one definition of "open layer" (`invalidated_at is null and qty_remaining > 0`, ordered by all four §4.3.5 columns). Then `MOVEMENTS_PER_BATCH = 500` (`replay.ts`) and `VALUATION_PAGE = 1000` (`valuation.ts`), the two bounds spec:1368 requires and the two figures a test asserts; `valuationAsOf` with `ValuationParams`/`ValuationRow` and `openLayersOf` with `OpenLayersParams`/`CostLayerRow` (`valuation.ts`) — the read side §4.7.2's prose implies and its code block omits; `rebuildStockValuation` with `StockValuationRebuildResult` (`valuation.ts`), the `stock_valuation` half of §4.6.1's register row; and `COST_ADJUSTMENT_CODE`, `ADJUSTMENT_ACCOUNT_CODES`, `AdjustmentAccounts`, `resolveAdjustmentAccounts` (`cost-adjustment.ts`), which is amendment A12's realisation made importable. Recorded together because they ship in one PR and a later slice that cannot find them in the registry will write a second one. | T7, T8, T9, T10, T11 |
| **A20** | 4.16.3 | **`COST_LAYER_CHECK: ProjectionCheck` lives in `packages/db/src/integrity/cost-layer-check.ts`**, registered from `integrity/index.ts` exactly as 1B's `ACCOUNT_BALANCE_CHECK` and 3A's `STOCK_ON_HAND_CHECK` are. A10 already records the *consequence* (the four-name `projections.checked` array); this row records the name and its file, so §4.16.3's registry list is complete. Its `run` matches `ProjectionCheck` exactly — `run(tx: Sql)`, no second parameter: the invariant `qty_remaining = qty_in − Σ valid consumptions` is per-layer and RLS has already reduced the table to the caller's tenant, which is why 1B's and 3A's checks take no company either. | T12 |
| **A21** | 4.17.1 | **Two rows and one widening in the test tier's register.** (a) `costingContext(legacyDefect)` and `CostingFixture` in **`tests/regression/support/costing.ts`**, owner 3B — a cross-file shared helper, which §4.17.1 requires be registered before it is added; it is *this slice's own* module rather than a fifteenth export on 0B's `tests/support/regression.ts`, which is the merge hotspot §4.17 exists to prevent. (b) `postInventoryDocument`'s `beforePost` option **and the `postOverriddenIssue` export** in the same file, both additive, beside A11's row — the override sequence is written once because §4.5.3's guard refuses two plausible shapings of it (Task 6 Step 3 records which). (c) §4.17.1's closing paragraph names **two** files outside the `tests` workspace that import `tests/invariants/support/**` — `apps/worker/test/**` and `apps/api/test/**`; this slice makes it **three** by adding `packages/db/test/**`, through a third named allowance on `scripts/lint/rules/dependency-rule.ts` with its reason on the line plus one `include` entry in `packages/db/tsconfig.json`. Three DB-tier costing suites must post through the *real* `postDocument`, and §4.17 assigns 3B no `fixtures.ts` helper, so a second copy of the helper inside `packages/db` is the alternative hazard 9 forbids. | T7, T13 |
| **A22** | 4.7.1 | **The divisor is REFUSED below `MIN_MEANINGFUL_QTY`, not clamped to it.** §4.7.1's doc comment reads "the divisor is clamped to MIN_MEANINGFUL_QTY = Quantity.of(\"0.000001\") (spec:1227)". Clamping does not close LEGACY-008(b): dividing a value by `0.000001` instead of by `0.0000005` still produces the exploded unit cost Part VI test 6 forbids being *stored*, so the engine raises `ERR_STOCK_INSUFFICIENT` instead. Two facts make this a documentation fix more than a behavioural one: at `QUANTITY_SCALE = 6` a sub-micro quantity is unrepresentable (`Quantity.of` throws — see the Assumptions block), so no `Quantity` can reach the branch; and spec:1227's own word is "clamped to a minimum meaningful quantity", which the *representation* now enforces. The plan's Goal, ADR 0037 decision 5 and Task 3 guards case (b) all say "refused below" for the same reason. | T2, T3 |
| **A23** | 4.7.3 | **`app.cost_consumption` gains three CHECK constraints and one composite foreign key §4.7.3's block does not carry:** `quantity > 0`, `unit_cost >= 0`, `value >= 0`, and `foreign key (tenant_id, company_id) references app.company(tenant_id, id)`. Taking the FK first: §4.7.3 declares `company_id` on this table and no key over it, while `cost_layer` in the same block and `stock_valuation` in §4.6.1 both carry that exact FK, and the Always list of every plan in this phase requires "composite FKs `(tenant_id, <parent>_id)` to every tenant-scoped parent". Plan 0A's `composite_fk` rule only inspects the FKs a table *has*, so `lintSchema` stays green either way — which makes this a silent divergence rather than a caught one, and the reason it is recorded here instead of assumed. Then the CHECKs. §4.7.3 gives `cost_layer` the matching pair (`unit_cost >= 0`, `qty_remaining >= 0`) and leaves the consumption row unconstrained; LEGACY-008's arms are equally storable there, and a consumption is the row a margin report multiplies. Recorded rather than assumed because `quantity > 0` is load-bearing for a later slice: it forbids a **zero-quantity** consumption row, so 3C's landed cost and 3D's variance must adjust a layer's `unit_cost` or post an adjustment rather than write a nil consumption. Migration 0034's header comment and commit message name this amendment instead of claiming the block is verbatim. | T1 |

---

## Global Constraints

**Never** (spec:97–104, restated because each task must be able to stand alone): write to a ledger or movement table outside the posting service — for this slice that means outside `packages/db/src/posting/**` and `packages/db/src/costing/**`, the two directories `posting-only-tables` (§3.7.5) allows; represent money as a float anywhere, TypeScript included; build SQL by string concatenation (LEGACY-036/037/069); issue DDL from application code (LEGACY-053); disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053) — the replay in particular never disables `assert_stock_available` or `forbid_change`; gate an audit write on any flag (LEGACY-030); hard-code a package version into a source file — the lockfile owns versions.

**Always**, for every new table (spec:106 unioned with the Plan 0A linter, contracts §3.3): `tenant_id`; RLS enabled **and forced** through `call app_meta.enable_tenant_rls('app.<name>')`; the policy named exactly `tenant_isolation`; `id uuid primary key default uuidv7()` unless the table is in `NO_ID_TABLES`; `created_at timestamptz not null default now()`; `call app_meta.attach_audit('app.<name>')` unless the table is in `AUDIT_EXEMPT`; `call app_meta.attach_stamp('app.<name>', '<col>_by')` for every `*_by` column; composite FKs `(tenant_id, <parent>_id)` to every tenant-scoped parent; a migration with a hand-written down; a Drizzle mirror in `packages/db/src/schema/`; and a test that a second tenant cannot see it. `lintSchema` must report **zero** violations after every migration. This slice's three new tables all appear in contracts §3.5.3: `cost_layer` and `cost_consumption` are **already** in `AUDIT_EXEMPT` (plan0A:2707–2710 lists both as forward declarations) and join no other set; `stock_valuation` **joins `NO_ID_TABLES` and `AUDIT_EXEMPT`**. None of the three attracts a `branch_isolation` policy here — contracts §3.5.1 item 7 puts all three (and `cost_consumption` through its movement) in **6C's migration 0068**, which names them explicitly, and 6C is also the slice that adds the `branch_isolation_policy` linter rule.

**Every query — reads included — runs inside `withTenant`** (spec:2053). The `no-bare-db` lint forbids a bare `db.` call; only a `tx` obtained from `withTenant` may tag SQL. `sql.unsafe` has exactly three homes and none of them is in this slice (contracts §3.3).

**Long jobs run as many short transactions, never one long one** (spec:1368). `inventory.cost.replay` processes **500 movements per `withTenant` transaction** by default, and `inventory.projection.rebuild` one company per transaction. Every job handler runs as the tenant's **system principal** through `systemContext` (spec:2179, hazard 20) and fans out through `eachTenant`, never through `app.tenant` (FORCE RLS).

**Money is `numeric(19,4)` in Postgres and `Money` in TypeScript** (spec:2041); quantities are `numeric(19,6)` and `Quantity` (spec:2043); rates are `numeric(19,8)`. Base conversion is `round(value × rate, 4)` with `HALF_AWAY_FROM_ZERO` (spec:1816, contracts §5 item 23). A unit cost is `round(value ÷ quantity, 4)` with `HALF_AWAY_FROM_ZERO` for the same symmetry reason. `effective_date` is a `date` the user enters and is never derived from `posted_at` (spec:2039).

**The chronological key is explicit and total, and never an index definition** (spec:1225, LEGACY-067): `(document.effective_date, document.posting_seq, document_line.line_no, inventory_movement.movement_no)` — contracts §4.3.5. Every ordering in this slice — the open-layer read, the FIFO walk, the replay's forward pass, the golden fixtures — writes those four columns out in that order. A query that orders by fewer than four is a defect: LEGACY-005's incremental path ordered by document **id** while its batch path ordered by **date**, and that single disagreement is the defect.

**No new document-type code, account code, report code, `DatasetId` member or `fixtures.ts` helper beyond the ones this plan's Assumptions block names** (hazard 32). The one document-type code is `COST_ADJUSTMENT`; the two account codes are `1300` and `5000`, both seeded by 0C and only *resolved* here.

**Inside `packages/db`, every import is relative except `@dulja/domain`** (spec:2389, 0b:5052). 0B's
`dependency-rule` pins `"packages/db": ["@dulja/domain"]` and finds a file's owner by the path prefix
`packages/db/` with no `test/` exclusion (0b:5091), so `@dulja/db`, `@dulja/db/test`, `@dulja/db/seed` and
`@dulja/contracts` are all violations under `packages/db/test/**` — a self-import is reported like any other.
This slice's eight suites there import `../fixtures`, `../harness` and `../../src/**`, as 1A's and 3A's do
(1a:5109, 3a:237–241, 3a:2920–2924), and read the permission catalogue as `select code from app.permission`
rather than importing `PERMISSIONS` — 1A states that substitution and its reason explicitly (1a:5105,
1a:5131–5132). Two consequences worth naming once: a seed-pack path inside that package is resolved with
`fileURLToPath(new URL("../../seed/my…", import.meta.url))`, because Vitest runs the package from
`packages/db` and a bare `"packages/db/seed/…"` would resolve to `packages/db/packages/db/seed/…` (1a:5114);
and the same names ARE legal in `tests/**`, `apps/api/**`, `apps/worker/**` and `scripts/**`, which is why an
import block copied between tiers is this slice's most likely lint failure. `tests/**` and `scripts/**` have
no tier row at all (0b:5064).

**No statutory rate, threshold or formula appears anywhere in this slice** (hazard 1). Nothing in costing needs one; a number that looks like a tax or contribution rate in this plan is a defect.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `packages/db/migrations/0034_create_cost_layer_consumption_valuation.sql` | `app.cost_layer`, `app.cost_consumption`, `app.stock_valuation`, their indexes and RLS |
| `packages/db/migrations/0034.down.sql` | the three drops, reverse dependency order |
| `packages/db/migrations/0035_alter_company_add_costing_method.sql` | `company.costing_method text not null default 'avco' check in ('avco','fifo')` |
| `packages/db/migrations/0035.down.sql` | drops that one column and nothing else |
| `packages/db/migrations/0036_seed_permission_phase3b.sql` | the one global `app.permission` row `inventory.cost.read` |
| `packages/db/migrations/0036.down.sql` | deletes exactly that code |
| `packages/domain/src/costing/engine.ts` | the ONE costing implementation: types, `CostingError`, AVCO, FIFO, the guards, `average` |
| `packages/domain/src/costing/index.ts` | the costing barrel, re-exported from `packages/domain/src/index.ts` |
| `packages/db/src/costing/invalidate.ts` | `invalidateFrom` — marks layers and consumptions at or after a key invalid and enqueues the replay |
| `packages/db/src/costing/replay.ts` | `replay` — the bounded, restartable forward pass and the `COST_ADJUSTMENT` post |
| `packages/db/src/costing/valuation.ts` | `valuationAsOf`, `openLayersOf`, `rebuildStockValuation` — the read side, one implementation (spec:1228) |
| `packages/db/src/costing/index.ts` | the costing barrel `@dulja/db` re-exports |
| `packages/db/src/schema/cost-layer.ts` | Drizzle mirror (§3.4.9) |
| `packages/db/src/schema/cost-consumption.ts` | Drizzle mirror |
| `packages/db/src/schema/stock-valuation.ts` | Drizzle mirror |
| `packages/db/src/costing/cost-adjustment.ts` | `COST_ADJUSTMENT_CODE`, `ADJUSTMENT_ACCOUNT_CODES`, `resolveAdjustmentAccounts` |
| `packages/db/src/integrity/cost-layer-check.ts` | `COST_LAYER_CHECK` — the fourth registered `ProjectionCheck` |
| `packages/db/test/costing/layers.test.ts` | the DB-level layer and consumption tests, plus `COST_LAYER_CHECK` (T12 appends) |
| `packages/db/test/costing/method.test.ts` | `company.costing_method` and the FIFO switch (OD-06) |
| `packages/db/test/costing/apply-movements.test.ts` | the full step-9 hook: movements, layers, consumptions, `document_line.cost` |
| `packages/db/test/costing/cost-adjustment.test.ts` | the seed envelope and hazard 33's account-resolution assertion |
| `packages/db/test/costing/replay.test.ts` | acceptance test 5 — bounded, forward-only, restartable, with an adjustment |
| `packages/db/test/costing/valuation.test.ts` | the valuation reads and the `stock_valuation` rebuild-and-compare |
| `packages/db/test/posting/cost-lines.test.ts` | `role: "cost"` — a cost line is base currency at rate `1.00000000` |
| `packages/domain/test/costing/engine.test.ts` | the pure engine: receipts, AVCO, FIFO, `average`, purity |
| `packages/domain/test/costing/guards.test.ts` | acceptance test 6 — return exceeding stock, wash line, value-less movement |
| `packages/db/seed/my/document-types/COST_ADJUSTMENT.json` | the §4.3.7 envelope and the JOURNAL-shaped policy |
| `scripts/reseed-verify.ts` | the four-line staging check, written in full in Task 13 Step 6 and run by Step 7 (`--tenant` or `--local`) |
| `apps/api/src/routes/inventory/valuation.ts` | `valuationRoutes` — `GET …/valuation` and `GET …/valuation/layers` |
| `apps/api/test/routes/inventory/valuation.test.ts` | the route tests |
| `apps/worker/src/handlers/cost-replay.ts` | the `inventory.cost.replay` registration (amendment A6's wrapper) |
| `apps/worker/src/handlers/inventory-projection-rebuild.ts` | the `inventory.projection.rebuild` registration |
| `apps/worker/test/handlers/cost-replay.test.ts` | the handler through `startWorker()` |
| `packages/contracts/src/inventory/valuation.ts` | `ValuationRowSchema`, `ValuationQuery`, `ValuationList`, `CostLayerRowSchema`, `CostLayerQuery`, `CostLayerList` |
| `tests/golden/costing/avco-back-dated/{input,policies,expected}.json` | the golden case that pins the AVCO formula and the recost |
| `tests/golden/costing/avco-edge-cases/{input,policies,expected}.json` | the golden case that pins the guards' boundary values |
| `tests/golden/costing/fifo-oldest-first/{input,policies,expected}.json` | the golden case that pins the FIFO walk |
| `tests/golden/costing.test.ts` | the byte-compare harness (spec:2264), `CostingGoldenExpectation`, `GoldenLayer` |
| `tests/invariants/support/post-inventory.ts` | `postInventoryDocument`, `recordingJobs`, `ensureOpenPeriods`, the two policy consts (amendment A11) |
| `tests/regression/support/costing.ts` | `costingContext()` — the sixteen helpers the regression files share (T13) |
| `tests/regression/legacy-004.test.ts` | cost advanced on INSERT only, with no rebuild path (T13) |
| `tests/regression/legacy-006.test.ts` | an edit keyed on the OLD key desynchronising two aggregates (T13) |
| `tests/regression/legacy-007.test.ts` | value-less movements NULL-poisoning a cost for all history (T13) |
| `tests/regression/legacy-009.test.ts` | three irreconcilable averages — **and acceptance test 7's cost side** (T13) |
| `tests/regression/legacy-010.test.ts` | a dimension in the SELECT list but not in the sort or group break (T13) |
| `tests/regression/legacy-015.test.ts` | a date window from a predicate that can never be satisfied (T13) |
| `tests/regression/legacy-016.test.ts` | min/max prices that ratchet permanently (T13) |
| `tests/regression/legacy-017.test.ts` | the open-quantity projection half; 3C and 3D append (T13) |
| `tests/regression/legacy-022.test.ts` | a singleton SELECT omitting a key column (T13) |
| `tests/regression/legacy-054.test.ts` | a recost aborting on the first historical below-cost sale (T13) |
| `tests/regression/legacy-055.test.ts` | the FIFO carry-forward (OD-06 conditional; **3B creates**, 7B appends) — T4 |
| `tests/regression/legacy-060.test.ts` | a repair with two sort orders that dropped columns it rebuilt (T13) |
| `tests/regression/legacy-061.test.ts` | a repair that reset every cost to its opening value (T13) |
| `tests/regression/legacy-062.test.ts` | the watermark written at a group break (T13) |
| `tests/regression/legacy-076.test.ts` | duplicate and near-duplicate costing procedures (T13) |
| `docs/adr/0037-avco-is-the-v1-costing-method-and-fifo-shares-the-layer-model.md` | the proposal (spec:95) |
| `docs/adr/0038-bounded-restartable-recost-and-the-cost-adjustment-document.md` | |
| `docs/adr/0039-stock-valuation-is-an-as-of-snapshot-and-cost-layer-joins-the-projection-registry.md` | |

**Modified**

| Path | Change |
|---|---|
| `packages/db/src/costing/apply-movements.ts` | 3A's provisional body replaced whole (§4.7.2); the signature is untouched |
| `packages/db/src/posting/post.ts` | step 9 calls `applyMovements`; 2A's step-9b guard deleted; `insertLedger`'s `isFx` widened to `role !== "policy"`; step 14 enqueues; `input.jobs` |
| `packages/db/src/posting/reverse.ts` | `reverseDocument`'s input gains `jobs?` and passes it to `postDocument` (amendment A15) |
| `packages/db/src/posting/load.ts` | one expression: `cost` is built with `baseCurrency` (amendment A4); `costingMethod` read from the column (T4) |
| `packages/db/src/posting/errors.ts` | `PostingErrorCode` widened by four `ErrCode` members (amendment A3) |
| `packages/db/src/posting/index.ts` | the barrel re-exports nothing new — verify `postDocument`/`reverseDocument` still export from here |
| `packages/domain/src/posting/evaluate.ts` | `PlannedLedgerLine.role` gains `"cost"`; `push` tags cost refs and skips `toBase` for them; `COST_AMOUNT_REFS` |
| `packages/db/src/lint-schema.ts` | `stock_valuation` joins `NO_ID_TABLES` and `AUDIT_EXEMPT` |
| `scripts/lint/rules/dependency-rule.ts` | **one** allowance (T7 Step 9): `packages/db/test/**` → `tests/invariants/support/**`, the third named importer §4.17.1's closing paragraph lists (amendment A21(c)), with its reason on the line. 1B's two allowances are left exactly as they are |
| `packages/db/tsconfig.json` | one `include` entry — `../../tests/invariants/support/**/*.ts` (T7 Step 9). **No `package.json` dependency in that direction**, for the reason 1B records: it would close a cycle in the workspace graph turbo walks |
| `packages/db/src/schema/company.ts` | the `costingMethod` column on the Drizzle mirror (T4) |
| `packages/db/src/index.ts` | exports the costing barrel |
| `packages/db/package.json` | the `reseed:verify` script (T13) |
| `packages/db/src/integrity/index.ts` | registers `COST_LAYER_CHECK` |
| `packages/db/src/jobs/payloads.ts` | the two `JobPayload` keys (amendment A9) |
| `packages/domain/src/index.ts` | `export * from "./costing";` |
| `packages/contracts/src/errors.ts` | the `ERR_COST_VALUE_MISSING` row |
| `packages/contracts/permissions.ts` | the `inventory.cost.read` entry |
| `packages/contracts/src/index.ts` | exports the valuation contracts module (amendment A18) |
| `packages/contracts/openapi.json` | regenerated for the two `valuation` routes; CI fails on an uncommitted diff (spec:2055) |
| `packages/db/seed/roles.ts` | `inventory.cost.read` granted to `accountant`, `warehouse`, `branch_manager`, `auditor` |
| `apps/api/src/app.ts` | the two-line middleware that sets `c.var.jobs` |
| `apps/api/src/context.ts` | `AppEnv["Variables"]` gains `jobs` |
| `apps/api/src/routes/inventory/permissions.ts` | 3A's `INVENTORY_PERMISSION` gains `costRead`, additively — one line, nothing else moves |
| `apps/api/src/routes/index.ts` | `valuationRouteModule` registered inside `buildRoutes` |
| `apps/api/src/problem.ts` | nothing — `PostingError` already has its branch; the new code travels through it |
| `apps/api/src/routes/accounting/document.ts` | the post and reverse handlers each pass `jobs: c.var.jobs` (amendments A5, A15) |
| `apps/worker/src/index.ts` | imports the two handler modules so registration runs |
| `tests/invariants/probes.ts` | one `PROBES` entry and two `JOB_PROBES` entries, plus the local `seedCostLayerFixture` |
| `tests/invariants/ledger-balance.test.ts` | one appended `describe` — test 1 over costed documents (T6) |
| `tests/support/regression.ts` | **not** touched — Task 13's helpers live in `tests/regression/support/costing.ts` (§4.17.1 registers only 0B's three exports there) |
| `tests/package.json` | the dev-only `golden:costing` script (T12) |
| `tests/regression/legacy-005.test.ts`, `legacy-008.test.ts` | one appended `describe` block each (§3.7.3 — 0B created both) |
| `tests/invariants/projection-rebuild.test.ts` | the registry assertion and the `cost_layer` cases |
| `tests/invariants/audit-chain.test.ts` | the pinned `projections.checked` array |
| `apps/worker/test/handlers/integrity-check.test.ts` | the same pinned array |
| `packages/db/seed/my/document-types/` | the new `COST_ADJUSTMENT.json` file only — no loader change (§3.4.8: a slice adding rows to an existing sub-pack adds a **file**, never a loader) |
| `CLAUDE.md` | **not** touched — 3D completes Phase 3 (§3.8) |

---

### Task 1: Migration 0034 — `cost_layer`, `cost_consumption`, `stock_valuation`

**Files:**
- Create: `packages/db/migrations/0034_create_cost_layer_consumption_valuation.sql`, `packages/db/migrations/0034.down.sql`, `packages/db/src/schema/cost-layer.ts`, `packages/db/src/schema/cost-consumption.ts`, `packages/db/src/schema/stock-valuation.ts`
- Modify: `packages/db/src/lint-schema.ts`
- Test: `packages/db/test/costing/layers.test.ts`

**Interfaces:**
- Consumes: `startDb`, `Db`, `Seed`, `seedTenantV2(db, name)`, `uuidv7(sql)`, the 4-argument test `withTenant(sql, tenantId, actorId, fn)`, `lintSchema(sql)`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `MIGRATIONS_DIR` — all from `@dulja/db` / `@dulja/db/test` (contracts §4.1); `app_meta.enable_tenant_rls(tbl regclass)`; 3A's `seedItem(db, s, opts?)` returning `{ itemId, baseUnitId }`, `seedWarehouse(db, s, opts?)` returning a `string`, `seedLot(db, s, opts)` returning a `string` (contracts §4.17).
- Produces (SQL): `app.cost_layer`, `app.cost_consumption`, `app.stock_valuation`, the index `cost_layer_open_idx`, the indexes `cost_consumption_movement_idx` and `cost_consumption_layer_idx`.
- Produces (TS): `costLayer`, `costConsumption`, `stockValuation` Drizzle tables in `packages/db/src/schema/`.

**Read this before writing the DDL.** `cost_layer` carries `unique (movement_id)` and `app_rw` holds **no DELETE** on it (contracts §3.5.4 pins the DELETE list and 3B does not extend it). Three consequences shape every later task and they are stated here because the DDL is what forces them: a recost **updates** the layer of a movement in place rather than inserting a second one; a recost **marks the old consumption set `invalidated_at`** and inserts a fresh set, because `cost_consumption` has no natural unique key; and "valid" therefore means `invalidated_at is null` in every read, in every rebuild and in every golden compare. `qty_remaining` is mutable precisely because it is derived state (spec:1210).

- [ ] **Step 1: Write the failing test `packages/db/test/costing/layers.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Relative imports, never `@dulja/db*`: 0B's `dependency-rule` pins `"packages/db": ["@dulja/domain"]`
// and keys the owner on the path prefix `packages/db/`, so `test/**` is in its scope too — `@dulja/domain`
// is the only package specifier any file under `packages/db` may name (0b:5052, 0b:5091), and a
// `@dulja/db` self-import is reported like any other. 1A's and 3A's suites in this very directory import
// `../fixtures`, `../harness` and `../../src/**` for exactly this reason (3a:237–241, 3a:2920–2924).
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
import { seedItem, seedLot, seedTenantV2, seedWarehouse, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("migration 0034 — cost_layer, cost_consumption, stock_valuation (contracts §4.7.3, §4.6.1; spec:1210, 1216-1221)", () => {
  let db: Db; let a: Seed; let b: Seed;

  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); b = await seedTenantV2(db, "Beta"); });
  afterAll(async () => { await db.stop(); });

  it("the schema linter reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("the three tables are in the sets contracts §3.5.3 assigns them, and in no others", () => {
    // cost_layer and cost_consumption were forward-declared in plan0A's AUDIT_EXEMPT; stock_valuation is added here.
    expect(AUDIT_EXEMPT.has("cost_layer")).toBe(true);
    expect(AUDIT_EXEMPT.has("cost_consumption")).toBe(true);
    expect(AUDIT_EXEMPT.has("stock_valuation")).toBe(true);
    // Derived, not immutable — the posting service and the replay both UPDATE qty_remaining (spec:1210, 1993).
    expect(IMMUTABLE.has("cost_layer")).toBe(false);
    expect(IMMUTABLE.has("cost_consumption")).toBe(false);
    expect(IMMUTABLE.has("stock_valuation")).toBe(false);
  });

  it("app_rw may select, insert and update a layer but never delete one (contracts §3.5.4)", async () => {
    const held = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'cost_layer' order by 1`;
    expect(held.map((h) => h.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("a layer round-trips and qty_remaining refuses to go negative", async () => {
    // `baseUnitId` is destructured here, not fetched by seeding a SECOND item: `seedItem` returns both, and
    // a second row created only to read a unit id back would also be created on a different transaction
    // from the `withTenant` block below, inside a tagged-template argument.
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "ITEM-1" });
    const warehouseId = await seedWarehouse(db, a, { code: "WH-1" });
    const lotId = await seedLot(db, a, { itemId, code: "L1" });
    const movementId = await uuidv7(db.admin);
    const layerId = await uuidv7(db.admin);

    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      // A layer needs a movement to point at; the movement itself is 3A's table and applyMovements is its only
      // writer in production — this test writes one directly as app_migrator to isolate the DDL under test.
      await tx`insert into app.inventory_movement
        (id, tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
        values (${movementId}, ${a.tenant}, ${a.company}, ${await draftFor(tx, a)}, 1, 1, ${itemId}, ${warehouseId},
                ${lotId}, ${baseUnitId}, '10.000000', '100.0000', '2026-01-10', 1)`;
      await tx`insert into app.cost_layer
        (id, tenant_id, company_id, item_id, warehouse_id, lot_id, movement_id, qty_in, unit_cost, qty_remaining, effective_at, sequence)
        values (${layerId}, ${a.tenant}, ${a.company}, ${itemId}, ${warehouseId}, ${lotId}, ${movementId},
                '10.000000', '10.0000', '10.000000', '2026-01-10', 1)`;
    });

    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`update app.cost_layer set qty_remaining = '-0.000001' where id = ${layerId}`,
    )).rejects.toThrow(/cost_layer_qty_remaining_check/);

    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`update app.cost_layer set unit_cost = '-0.0001' where id = ${layerId}`,
    )).rejects.toThrow(/cost_layer_unit_cost_check/);
  });

  it("one movement can carry only one layer (contracts §4.7.3 unique (movement_id))", async () => {
    const [row] = await withTenant(db.migrator, a.tenant, a.system, (tx) =>
      tx<{ movement_id: string; item_id: string; warehouse_id: string; lot_id: string }[]>`
        select movement_id::text, item_id::text, warehouse_id::text, lot_id::text from app.cost_layer limit 1`);
    await expect(withTenant(db.migrator, a.tenant, a.system, (tx) => tx`
      insert into app.cost_layer (tenant_id, company_id, item_id, warehouse_id, lot_id, movement_id, qty_in, unit_cost, qty_remaining, effective_at, sequence)
      values (${a.tenant}, ${a.company}, ${row!.item_id}, ${row!.warehouse_id}, ${row!.lot_id}, ${row!.movement_id},
              '1.000000', '1.0000', '1.000000', '2026-01-11', 2)`),
    ).rejects.toThrow(/cost_layer_movement_id_key/);
  });

  it("all three tables carry the composite (tenant_id, company_id) FK to app.company (amendment A23)", async () => {
    // Plan 0A's `composite_fk` rule only inspects the FKs a table HAS, so the linter case above stays green
    // whether or not this key exists — which is why it is asserted by name. `cost_consumption`'s is the one
    // §4.7.3's block omits and amendment A23 restores.
    // Two shapes to keep: the schema and table name come from `pg_class`/`pg_namespace` rather than from
    // `conrelid::regclass::text`, which drops the schema whenever `app` is on the connection's search_path;
    // and `a.attname` is cast to `text` before the comparison, because `array_agg(name)` is `name[]` and
    // `name[] = text[]` has no operator. `'app.company'::regclass` as an INPUT is search_path-independent.
    const held = await db.admin<{ table_name: string }[]>`
      select n.nspname || '.' || cl.relname as table_name
        from pg_constraint c
        join pg_class     cl on cl.oid = c.conrelid
        join pg_namespace n  on n.oid  = cl.relnamespace
       where c.contype = 'f' and c.confrelid = 'app.company'::regclass
         and n.nspname = 'app'
         and cl.relname in ('cost_layer', 'cost_consumption', 'stock_valuation')
         and (select array_agg(a.attname::text order by a.attname)
                from unnest(c.conkey) as k
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k)
             = array['company_id', 'tenant_id']
       order by 1`;
    expect(held.map((h) => h.table_name)).toEqual(["app.cost_consumption", "app.cost_layer", "app.stock_valuation"]);
  });

  it("tenant B sees none of tenant A's layers, consumptions or valuation rows (spec:106, test 12)", async () => {
    const counts = await withTenant(db.rw, b.tenant, b.human, (tx) => tx<{ layers: number; cons: number; val: number }[]>`
      select (select count(*)::int from app.cost_layer)       as layers,
             (select count(*)::int from app.cost_consumption) as cons,
             (select count(*)::int from app.stock_valuation)  as val`);
    expect(counts[0]).toEqual({ layers: 0, cons: 0, val: 0 });
  });

  it("stock_valuation is keyed by (company, item, warehouse, as_of) and has no id column", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'stock_valuation' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(
      ["as_of", "company_id", "created_at", "item_id", "quantity", "tenant_id", "updated_at", "value", "warehouse_id"],
    );
  });
});

/**
 * A draft document to hang a movement on. Plan 0A's `draftDocument(db, s)` fixture does the same job and is
 * used elsewhere in this slice (Task 4), but it opens its OWN `withTenant`, and this row must land on the
 * same `tx` as the movement insert below — the movement's FK `(tenant_id, document_id)` is checked inside
 * that transaction. So the insert is written out here rather than delegated.
 */
async function draftFor(tx: import("postgres").Sql, s: Seed): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.document (tenant_id, company_id, document_type_id, posting_policy_id, series, fiscal_period_id, effective_date, currency, branch_id)
    values (${s.tenant}, ${s.company}, ${s.docType}, ${s.policy}, 'JV', ${s.period}, '2026-01-10', 'MYR', ${s.hq})
    returning id::text as id`;
  return row!.id;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- test/costing/layers.test.ts`
Expected: **FAIL**, in **four** cases, and it is worth knowing which four before running it:

1. every case that touches a table — `relation "app.cost_layer" does not exist` on the first insert, and the `stock_valuation` column query returns `[]`;
2. the linter-set case, on `expect(AUDIT_EXEMPT.has("stock_valuation")).toBe(true)` — `cost_layer` and `cost_consumption` are already forward-declared in plan0A's set, `stock_valuation` is added by Step 5;
3. the `app_rw` privileges case, which reads `information_schema.role_table_grants` for a table that does not exist yet and gets `[]` against `["INSERT", "SELECT", "UPDATE"]`;
4. the composite-FK case, whose `pg_constraint` query returns `[]` against the three expected names — `'app.company'::regclass` resolves fine, but no constraint yet points at it from any of the three tables.

The `lintSchema` case passes vacuously (there is nothing new to lint yet); that is expected and it is the case that will fail if a later step forgets a policy.

- [ ] **Step 3: Write `packages/db/migrations/0034_create_cost_layer_consumption_valuation.sql`**

```sql
-- ── 0034. Cost layers, consumptions and the stock-valuation snapshot ─────────────────
-- contracts §4.7.3 (cost_layer verbatim; cost_consumption verbatim PLUS the four additions amendment A23
--            records — the CHECKs `quantity > 0`, `unit_cost >= 0`, `value >= 0`, and the composite
--            `foreign key (tenant_id, company_id) references app.company(tenant_id, id)` that §4.7.3's
--            block omits while cost_layer and stock_valuation both carry it)
--            and §4.6.1 (stock_valuation).
-- spec:1210  movements are immutable; cost layers are DERIVED — rebuildable, and rebuilt forward
--            from any invalidation point. qty_remaining is mutable precisely because it is derived.
-- spec:1216-1221  one layer per inventory receipt; issues consume layers per the company's method and
--            record exactly what they consumed; a back-dated document invalidates only layers at or
--            after its sequence; the replay writes an adjustment entry.
-- spec:1370, 1993  derived tables are AUDIT-EXEMPT but MUST stay updatable by app_rw.
-- LEGACY-004  cost is a derived function of an immutable ordered movement ledger, never a running scalar.
-- LEGACY-008  unit_cost >= 0 and qty_remaining >= 0 are CHECKs, not conventions: a negative computed cost
--          is a hard error and must never reach a stored row.

-- ── 1. cost_layer ───────────────────────────────────────────────────────────────────
create table app.cost_layer (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  item_id        uuid not null,
  warehouse_id   uuid not null,
  lot_id         uuid not null,
  movement_id    uuid not null,
  qty_in         numeric(19,6) not null,
  unit_cost      numeric(19,4) not null check (unit_cost >= 0),          -- LEGACY-008: never a negative stored cost
  qty_remaining  numeric(19,6) not null check (qty_remaining >= 0),      -- LEGACY-008: never a negative residue
  effective_at   date   not null,                                        -- = movement.effective_date
  sequence       bigint not null,                                        -- = movement.posting_seq (spec:1220 "sequence")
  invalidated_at timestamptz,                                            -- set by invalidateFrom; cleared by the replay
  created_at     timestamptz not null default now(),
  unique (movement_id),                                                  -- one receipt, one layer — the replay UPDATEs, never inserts a second
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)   references app.company(tenant_id, id),
  foreign key (tenant_id, item_id)      references app.item(tenant_id, id),
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id),
  foreign key (tenant_id, lot_id)       references app.lot(tenant_id, id),
  foreign key (tenant_id, movement_id)  references app.inventory_movement(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.cost_layer');
-- No attach_audit: cost_layer is in AUDIT_EXEMPT (plan0A:2707-2710). Auditing it would serialise every
-- recost behind the per-tenant audit lock for nothing — the movements it derives from are the record (spec:1210).
-- No attach_stamp: no *_by column, deliberately. A layer is not something a principal did; it is arithmetic
-- over movements, each of which already carries its own stamped posted_by (contracts §3.3's *_by rule).

-- The costing scope is (company, item, warehouse) — NOT the lot. AVCO has no per-lot average and FIFO walks
-- the oldest layer whatever lot it belongs to; the lot is on the row because stock_on_hand's key needs it and
-- because a consumption must say which lot left. Availability is checked per lot by 3A's assert_stock_available.
-- The ordering columns are the first four elements of the contracts §4.3.5 chronological key; line_no and
-- movement_no come from the joined movement, which is why the index carries the movement id last.
create index cost_layer_open_idx
  on app.cost_layer (company_id, item_id, warehouse_id, effective_at, sequence, movement_id)
  where invalidated_at is null and qty_remaining > 0;
create index cost_layer_invalid_idx
  on app.cost_layer (company_id, item_id, effective_at, sequence)
  where invalidated_at is not null;                                      -- the replay's resume point (LEGACY-054)

-- ── 2. cost_consumption ─────────────────────────────────────────────────────────────
-- spec:1218 "record exactly what they consumed". No natural unique key: an AVCO issue takes a proportional
-- slice of EVERY open layer, so one movement legitimately produces many rows, and a recost replaces the set
-- by marking it invalidated_at and inserting a fresh one.
create table app.cost_consumption (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  movement_id    uuid not null,
  layer_id       uuid not null,
  -- The three CHECKs below are amendment A23, not §4.7.3's text. `quantity > 0` is the load-bearing one: it
  -- forbids a zero-quantity consumption row, so 3C's landed cost and 3D's variance adjust a LAYER's unit_cost
  -- or post an adjustment rather than writing a nil consumption.
  quantity       numeric(19,6) not null check (quantity > 0),            -- a magnitude; the movement carries the sign
  unit_cost      numeric(19,4) not null check (unit_cost >= 0),
  value          numeric(19,4) not null check (value >= 0),
  invalidated_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (tenant_id, id),
  -- The company FK is amendment A23 too: §4.7.3's block declares `company_id` and no key over it, while
  -- `cost_layer` and `stock_valuation` beside it both carry one. Plan 0A's `composite_fk` rule only inspects
  -- FKs that EXIST, so `lintSchema` would have stayed green over the omission — which is exactly why it is
  -- recorded rather than left for the next reader to take for an oversight. The Global Constraints' Always
  -- list ("composite FKs `(tenant_id, <parent>_id)` to every tenant-scoped parent") is the rule it restores.
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, movement_id) references app.inventory_movement(tenant_id, id),
  foreign key (tenant_id, layer_id)    references app.cost_layer(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.cost_consumption');
-- No attach_audit (AUDIT_EXEMPT, plan0A:2707-2710); no *_by column, for the same reason as cost_layer.
create index cost_consumption_movement_idx on app.cost_consumption (movement_id) where invalidated_at is null;
create index cost_consumption_layer_idx    on app.cost_consumption (layer_id)    where invalidated_at is null;

-- ── 3. stock_valuation ──────────────────────────────────────────────────────────────
-- spec:1204 names it an ASYNCHRONOUS projection, rebuilt by a pg-boss job and compared row for row.
-- contracts §4.6.1 fixes the columns and the primary key; §3.5.3 puts it in NO_ID_TABLES (natural key) and
-- adds it to AUDIT_EXEMPT. Joining NO_ID_TABLES also exempts it from the created_at rule (the set is derived
-- as NO_ID_TABLES ∪ {ledger_entry}, plan0A:2702) — the column is here anyway, because spec:106's Always list
-- names created_at for every new table and account_balance and stock_on_hand both carry one.
create table app.stock_valuation (
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  item_id      uuid not null,
  warehouse_id uuid not null,
  as_of        date not null,
  quantity     numeric(19,6) not null default 0,
  value        numeric(19,4) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (company_id, item_id, warehouse_id, as_of),
  foreign key (tenant_id, company_id)   references app.company(tenant_id, id),
  foreign key (tenant_id, item_id)      references app.item(tenant_id, id),
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.stock_valuation');

-- ── 4. Privileges ───────────────────────────────────────────────────────────────────
-- app_rw receives select, insert, update on all three through app_migrator's default privileges
-- (plan0A:2564) — no grant statement here. DELETE is not granted: contracts §3.5.4 pins that list and 2B is
-- the only slice that extends it. A superseded consumption is marked invalidated_at, never deleted (spec:2049).
```

- [ ] **Step 4: Write `packages/db/migrations/0034.down.sql`**

```sql
-- Reverse dependency order: cost_consumption points at cost_layer, which points at inventory_movement.
drop table if exists app.stock_valuation;
drop table if exists app.cost_consumption;
drop table if exists app.cost_layer;
```

- [ ] **Step 5: Add `stock_valuation` to the two linter sets**

In `packages/db/src/lint-schema.ts`, add `"stock_valuation"` to `NO_ID_TABLES` (its primary key is natural) and to `AUDIT_EXEMPT` (an async projection). Both edits are one string each and are exactly the state contracts §3.5.3 pre-declares for this slice — add nothing else, and do not touch the `NO_CREATED_AT_TABLES` derivation:

```ts
const NO_ID_TABLES = new Set([
  "membership", "role_permission", "role_assignment", "role_assignment_branch", "ledger_entry_dimension",
  "document_series", "document_number_void", "idempotency_key", "audit_log", "permission",
  "account_balance", "stock_on_hand",                       // 1A, 3A
  "stock_valuation",                                        // 3B — natural key (company, item, warehouse, as_of)
]);
```

```ts
export const AUDIT_EXEMPT = new Set([
  "ledger_entry", "ledger_entry_dimension", "inventory_movement", "document_event", "audit_log",
  "account_balance", "cost_layer", "cost_consumption", "employee_ytd", "idempotency_key", "permission",
  "stock_on_hand",                                          // 3A — derived projection
  "stock_valuation",                                        // 3B — async projection (spec:1204)
]);
```

If `"account_balance"` or `"stock_on_hand"` is not already in `NO_ID_TABLES` on the head you are working from, stop: 1A or 3A has not merged and this slice's phase gate is not met.

- [ ] **Step 6: Write the three Drizzle mirrors**

`packages/db/src/schema/cost-layer.ts` — the mirror is the migration diff source (ADR-0002, contracts §3.4.9) and is used for **reads** in `apps/api`:

```ts
import { sql } from "drizzle-orm";
import { bigint, date, index, numeric, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const costLayer = pgTable("cost_layer", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  itemId: uuid("item_id").notNull(),
  warehouseId: uuid("warehouse_id").notNull(),
  lotId: uuid("lot_id").notNull(),
  movementId: uuid("movement_id").notNull(),
  qtyIn: numeric("qty_in", { precision: 19, scale: 6 }).notNull(),
  unitCost: numeric("unit_cost", { precision: 19, scale: 4 }).notNull(),
  qtyRemaining: numeric("qty_remaining", { precision: 19, scale: 6 }).notNull(),
  effectiveAt: date("effective_at").notNull(),
  sequence: bigint("sequence", { mode: "bigint" }).notNull(),
  invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({
  // Table-level UNIQUE CONSTRAINTS, named exactly as Postgres names them, in 3A's mirror style (3a:3449-3450)
  // — `unique(...)`, never `uniqueIndex(...)`: a constraint and a bare unique index are different objects and
  // a Drizzle diff would report the swap. `cost_layer_movement_id_key` is the name Task 1's test matches on.
  movementUnique: unique("cost_layer_movement_id_key").on(t.movementId),
  tenantId_: unique("cost_layer_tenant_id_id_key").on(t.tenantId, t.id),
  // BOTH indexes are PARTIAL in the migration, and the mirror is the diff source (ADR-0002, §3.4.9) — a
  // mirror without the predicates makes the next slice's `drizzle-kit generate` emit two spurious changes.
  open: index("cost_layer_open_idx")
    .on(t.companyId, t.itemId, t.warehouseId, t.effectiveAt, t.sequence, t.movementId)
    .where(sql`${t.invalidatedAt} is null and ${t.qtyRemaining} > 0`),
  invalid: index("cost_layer_invalid_idx")
    .on(t.companyId, t.itemId, t.effectiveAt, t.sequence)
    .where(sql`${t.invalidatedAt} is not null`),
}));
```

The two `cost_consumption` indexes are partial too (`where invalidated_at is null`), so the next mirror carries the same `.where(...)` on both.

`packages/db/src/schema/cost-consumption.ts`:

```ts
import { sql } from "drizzle-orm";
import { index, numeric, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const costConsumption = pgTable("cost_consumption", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  movementId: uuid("movement_id").notNull(),
  layerId: uuid("layer_id").notNull(),
  quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull(),
  unitCost: numeric("unit_cost", { precision: 19, scale: 4 }).notNull(),
  value: numeric("value", { precision: 19, scale: 4 }).notNull(),
  invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({
  tenantId_: unique("cost_consumption_tenant_id_id_key").on(t.tenantId, t.id),
  byMovement: index("cost_consumption_movement_idx").on(t.movementId).where(sql`${t.invalidatedAt} is null`),
  byLayer: index("cost_consumption_layer_idx").on(t.layerId).where(sql`${t.invalidatedAt} is null`),
}));
```

`packages/db/src/schema/stock-valuation.ts`:

```ts
import { date, numeric, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

export const stockValuation = pgTable("stock_valuation", {
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  itemId: uuid("item_id").notNull(),
  warehouseId: uuid("warehouse_id").notNull(),
  asOf: date("as_of").notNull(),
  quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull(),
  value: numeric("value", { precision: 19, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => ({
  pk: primaryKey({ name: "stock_valuation_pkey", columns: [t.companyId, t.itemId, t.warehouseId, t.asOf] }),
}));
```

Every import in the three blocks above is used: `sql` by the four index predicates, `unique` by the four constraints, `primaryKey` by `stock_valuation`'s natural key. If `bun run lint` reports an unused import, a line was dropped while typing — put the line back rather than deleting the import.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/costing/layers.test.ts`
Expected: **PASS**, all eight cases.

Run: `bun run --cwd packages/db test -- test/privileges.test.ts`
Expected: **PASS** — the `up → down → up` reversibility test (contracts §3.4.6) applies 0034 and rolls it back; if it fails with "0 tables expected in schema app" the down file is missing a drop.

Run: `bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS. **`dependency-rule` bites here, at the slice’s first `packages/db/test` file, not at Task 7.**
0B pins `"packages/db": ["@dulja/domain"]` and keys the owner on the path prefix `packages/db/` with no
`test/` exclusion (0b:5052, 0b:5091), so a `@dulja/db`, `@dulja/db/test`, `@dulja/db/seed` or
`@dulja/contracts` specifier anywhere under `packages/db` — a self-import included — is a violation.
Step 1 therefore imports `../fixtures`, `../harness` and `../../src/**`, exactly as 1A’s and 3A’s suites in
this directory do (3a:237–241). If this step reports `packages/db may not import @dulja/db`, an import block
was copied from a `tests/**` or `apps/**` file, where the same names ARE legal.

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0034_create_cost_layer_consumption_valuation.sql packages/db/migrations/0034.down.sql \
        packages/db/src/schema/cost-layer.ts packages/db/src/schema/cost-consumption.ts packages/db/src/schema/stock-valuation.ts \
        packages/db/src/lint-schema.ts packages/db/test/costing/layers.test.ts
git commit -m "$(cat <<'EOF'
feat(db): cost_layer, cost_consumption and stock_valuation [3B T1]

contracts §4.7.3 verbatim for cost_layer and §4.6.1 for the valuation
snapshot. cost_consumption is §4.7.3 plus the four additions amendment A23
records: the CHECKs quantity > 0, unit_cost >= 0 and value >= 0, which the
block does not carry and which LEGACY-008 makes as necessary on a consumption as
on a layer, and the composite foreign key (tenant_id, company_id) to
app.company, which the block also omits while cost_layer beside it and
stock_valuation both carry it. Plan 0A's composite_fk rule only inspects the
FKs a table has, so lintSchema stayed green over the gap — the layers test
asserts the key by name instead. quantity > 0 is the load-bearing CHECK: a nil
consumption row is not expressible, so 3C's landed cost adjusts a layer.

All three tables are derived: audit-exempt (spec:1370, 1993) and updatable by
app_rw, because the posting service and the recost both move qty_remaining.

unique (movement_id) on cost_layer is what makes a recost an UPDATE in place;
cost_consumption has no natural key, so a recost marks the old set
invalidated_at and inserts a fresh one. "Valid" is invalidated_at is null
everywhere.

stock_valuation joins NO_ID_TABLES and AUDIT_EXEMPT, exactly the state
contracts §3.5.3 pre-declares.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The costing engine, part I — types, `CostingError`, AVCO, `average`

**Files:**
- Create: `packages/domain/src/costing/engine.ts`, `packages/domain/src/costing/index.ts`
- Modify: `packages/domain/src/index.ts`, `packages/contracts/src/errors.ts`, `packages/db/src/posting/errors.ts`
- Test: `packages/domain/test/costing/engine.test.ts`

**Interfaces:**
- Consumes: `Money`, `Quantity`, `currency`, `CurrencyCode`, `RoundingMode`, `QUANTITY_SCALE`, `MONEY_SCALE` from `packages/domain/src/money` (contracts §4.2.1, 0D); `PlannedMovement` from `packages/domain/src/posting/evaluate.ts` (contracts §4.4.2, 2A); `Decimal` from `decimal.js`.
- Produces (all exported from `@dulja/domain`):

```ts
export type CostingMethod = "avco" | "fifo";
export const MIN_MEANINGFUL_QTY: Quantity;                       // Quantity.of("0.000001") — spec:1227's clamp, as ONE name
export interface Layer {
  id: string; itemId: string; warehouseId: string; lotId: string; movementId: string;
  qtyIn: Quantity; unitCost: Money; qtyRemaining: Quantity;
  effectiveDate: string; postingSeq: bigint; lineNo: number; movementNo: number;
}
export interface Consumption { layerId: string; quantity: Quantity; unitCost: Money; value: Money }
export interface CostingInput {
  method: CostingMethod;
  openLayers: Layer[];                                            // for the item+warehouse, chronological
  movement: PlannedMovement & { effectiveDate: string; postingSeq: bigint; movementId: string; lotId: string };
  allowShortfall: boolean;                                        // amendment A2(e)
}
export interface CostingOutput {
  value: Money; unitCost: Money;                                  // magnitudes — `effect` carries direction
  consumptions: Consumption[];
  newLayer: Omit<Layer, "id"> | null;
  updatedRemaining: { layerId: string; qtyRemaining: Quantity }[];
}
export interface CostingEngine {
  cost(input: CostingInput): CostingOutput;
  average(openLayers: Layer[], baseCurrency: CurrencyCode): Money;
}
export const costingEngine: CostingEngine;
export class CostingError extends Error {
  constructor(readonly code: "ERR_COST_NEGATIVE" | "ERR_STOCK_INSUFFICIENT" | "ERR_COST_VALUE_MISSING", readonly detail: string);
}
```

**Read this before writing a line of it.** This file is the answer to LEGACY-009 — three weighted-average formulas in one codebase that could never reconcile. There is **one** implementation, it is pure, and reporting, valuation and posting all import `costingEngine` (spec:1228). Two invariants follow and both are asserted below: the function never reads a clock, a database, `Math.random` or a mutable module variable, so the same input always yields the same output; and **the costing scope is `(company, item, warehouse)`, not the lot** — AVCO has no per-lot average and FIFO takes the oldest layer whatever lot it belongs to. The lot is on `Layer` because a consumption must say which lot left the shelf, and per-lot *availability* is 3A's `assert_stock_available` trigger, which is a different question.

- [ ] **Step 1: Write the failing test `packages/domain/test/costing/engine.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  costingEngine, CostingError, MIN_MEANINGFUL_QTY, Money, Quantity, currency,
  type CostingInput, type CurrencyCode, type Layer,
} from "../../src/index";

const MYR = currency("MYR");
const money = (v: string) => Money.of(v, MYR);
const qty = (v: string) => Quantity.of(v);

/** A layer as `applyMovements` reads one back: chronological, open, in base currency. */
function layer(over: Partial<Layer> & { id: string; qtyIn: string; unitCost: string; qtyRemaining: string; seq: number }): Layer {
  return {
    id: over.id, itemId: "item-1", warehouseId: "wh-1", lotId: "lot-1", movementId: `mv-${over.id}`,
    qtyIn: qty(over.qtyIn), unitCost: money(over.unitCost), qtyRemaining: qty(over.qtyRemaining),
    effectiveDate: over.effectiveDate ?? "2026-01-01", postingSeq: BigInt(over.seq), lineNo: 1, movementNo: 1,
  };
}

function issue(quantity: string, openLayers: Layer[], over: Partial<CostingInput> = {}): CostingInput {
  return {
    method: "avco", openLayers, allowShortfall: false,
    movement: {
      lineNo: 1, movementNo: 1, itemId: "item-1", warehouseId: "wh-1", lotId: "lot-1",
      quantity: qty(quantity), effect: "issue", value: null, costing: "consume_layers",
      effectiveDate: "2026-02-01", postingSeq: 10n, movementId: "mv-issue",
    },
    ...over,
  };
}

function receipt(quantity: string, value: string | null, over: Partial<CostingInput> = {}): CostingInput {
  return {
    method: "avco", openLayers: [], allowShortfall: false,
    movement: {
      lineNo: 1, movementNo: 1, itemId: "item-1", warehouseId: "wh-1", lotId: "lot-1",
      quantity: qty(quantity), effect: "receipt", value: value === null ? null : money(value),
      costing: "create_layer", effectiveDate: "2026-01-15", postingSeq: 5n, movementId: "mv-receipt",
    },
    ...over,
  };
}

describe("costingEngine — the ONE implementation (spec:1228; LEGACY-009)", () => {
  it("a receipt creates one layer at value ÷ quantity and consumes nothing", () => {
    const out = costingEngine.cost(receipt("100.000000", "1000.0000"));
    expect(out.value.toString()).toBe("1000.0000");
    expect(out.unitCost.toString()).toBe("10.0000");
    expect(out.consumptions).toEqual([]);
    expect(out.updatedRemaining).toEqual([]);
    expect(out.newLayer).not.toBeNull();
    expect(out.newLayer!.qtyIn.toString()).toBe("100.000000");
    expect(out.newLayer!.qtyRemaining.toString()).toBe("100.000000");
    expect(out.newLayer!.unitCost.toString()).toBe("10.0000");
    expect(out.newLayer!.movementId).toBe("mv-receipt");
    expect(out.newLayer!.postingSeq).toBe(5n);
  });

  it("AVCO issues at the running average and takes a proportional slice of EVERY open layer (spec:1218)", () => {
    // 100 @ 10 and 100 @ 20 → average 15. Issue 50 → value 750, 25 from each layer.
    const layers = [
      layer({ id: "L1", qtyIn: "100.000000", unitCost: "10.0000", qtyRemaining: "100.000000", seq: 1 }),
      layer({ id: "L2", qtyIn: "100.000000", unitCost: "20.0000", qtyRemaining: "100.000000", seq: 2 }),
    ];
    const out = costingEngine.cost(issue("50.000000", layers));
    expect(out.unitCost.toString()).toBe("15.0000");
    expect(out.value.toString()).toBe("750.0000");
    expect(out.consumptions.map((c) => [c.layerId, c.quantity.toString(), c.unitCost.toString(), c.value.toString()])).toEqual([
      ["L1", "25.000000", "15.0000", "375.0000"],
      ["L2", "25.000000", "15.0000", "375.0000"],
    ]);
    expect(out.updatedRemaining).toEqual([
      { layerId: "L1", qtyRemaining: qty("75.000000") },
      { layerId: "L2", qtyRemaining: qty("75.000000") },
    ]);
    expect(out.newLayer).toBeNull();
  });

  it("the proportional split closes exactly — Σ consumed quantity = the issue, Σ value = the value", () => {
    // Three layers of coprime remainders and a quantity that cannot divide evenly: the largest-remainder
    // split must still close, or a residue would sit on the layers that no later issue could clear.
    const layers = [
      layer({ id: "L1", qtyIn: "7.000000", unitCost: "3.0000", qtyRemaining: "7.000000", seq: 1 }),
      layer({ id: "L2", qtyIn: "11.000000", unitCost: "5.0000", qtyRemaining: "11.000000", seq: 2 }),
      layer({ id: "L3", qtyIn: "13.000000", unitCost: "7.0000", qtyRemaining: "13.000000", seq: 3 }),
    ];
    const out = costingEngine.cost(issue("10.000000", layers));
    const totalQty = out.consumptions.reduce((a, c) => a.add(c.quantity), Quantity.zero());
    // `Money.zero<CurrencyCode>(MYR)`, never a bare `Money.zero(MYR)`: `currency()` has a `const` type
    // parameter, so `MYR` is `CurrencyCode & "MYR"` and a bare seed makes the reduce accumulator
    // `Money<CurrencyCode & "MYR">` — while `Consumption.value` is the wide `Money<CurrencyCode>`, so
    // `a.add(c.value)` is a compile error. The explicit argument widens the seed instead. 1A hit this exact
    // trap and records the same fix (1a:1572–1577).
    const totalValue = out.consumptions.reduce((a, c) => a.add(c.value), Money.zero<CurrencyCode>(MYR));
    expect(totalQty.toString()).toBe("10.000000");
    expect(totalValue.toString()).toBe(out.value.toString());
  });

  it("a layer whose proportional share floors to zero gets no consumption row, and the values still close", () => {
    // The oldest layer holds one micro-unit beside two of a hundred. 1.000000 split by weight gives it
    // 1_000_000 × 1 ÷ 200_000_001 = 0 micro-units, so it must receive neither a consumption row nor an
    // allocation weight — Σ consumption value has to equal out.value exactly, or COST_LAYER_CHECK's sibling
    // invariant and legacy-009's tie-out both drift by the difference.
    const layers = [
      layer({ id: "TINY", qtyIn: "0.000001", unitCost: "1.0000", qtyRemaining: "0.000001", seq: 1, effectiveDate: "2026-01-01" }),
      layer({ id: "BIG1", qtyIn: "100.000000", unitCost: "10.0000", qtyRemaining: "100.000000", seq: 2, effectiveDate: "2026-01-02" }),
      layer({ id: "BIG2", qtyIn: "100.000000", unitCost: "20.0000", qtyRemaining: "100.000000", seq: 3, effectiveDate: "2026-01-03" }),
    ];
    const out = costingEngine.cost(issue("1.000000", layers));
    expect(out.consumptions.map((c) => c.layerId)).toEqual(["BIG1", "BIG2"]);
    expect(out.consumptions.reduce((a, c) => a.add(c.value), Money.zero<CurrencyCode>(MYR)).toString()).toBe(out.value.toString());
    expect(out.consumptions.reduce((a, c) => a.add(c.quantity), Quantity.zero()).toString()).toBe("1.000000");
    // the tiny layer is untouched — it keeps its micro-unit and appears in no updatedRemaining entry
    expect(out.updatedRemaining.map((u) => u.layerId)).toEqual(["BIG1", "BIG2"]);
  });

  it("`average` is Σ(qtyRemaining × unitCost) ÷ Σ qtyRemaining and needs no layer to have a currency", () => {
    const layers = [
      layer({ id: "L1", qtyIn: "100.000000", unitCost: "10.0000", qtyRemaining: "40.000000", seq: 1 }),
      layer({ id: "L2", qtyIn: "100.000000", unitCost: "20.0000", qtyRemaining: "60.000000", seq: 2 }),
    ];
    expect(costingEngine.average(layers, MYR).toString()).toBe("16.0000");
    expect(costingEngine.average([], MYR).toString()).toBe("0.0000");
  });

  it("MIN_MEANINGFUL_QTY is one micro-unit and is exported, not retyped (spec:1227)", () => {
    expect(MIN_MEANINGFUL_QTY.toString()).toBe("0.000001");
  });

  it("a receipt with no value is refused — value is mandatory on every movement (LEGACY-007)", () => {
    expect(() => costingEngine.cost(receipt("10.000000", null)))
      .toThrow(/ERR_COST_VALUE_MISSING.*carries no value/s);
  });

  it("is pure — the same input twice gives byte-identical output", () => {
    const layers = [layer({ id: "L1", qtyIn: "3.000000", unitCost: "1.3333", qtyRemaining: "3.000000", seq: 1 })];
    const a = costingEngine.cost(issue("1.000000", layers));
    const b = costingEngine.cost(issue("1.000000", layers));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // and it did not mutate its input
    expect(layers[0]!.qtyRemaining.toString()).toBe("3.000000");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/domain test -- test/costing/engine.test.ts`
Expected: **FAIL** with `Cannot find module` / `costingEngine is not exported from ../../src/index` — the file does not exist yet.

- [ ] **Step 3: Write `packages/domain/src/costing/engine.ts`**

```ts
import type { PlannedMovement } from "../posting/evaluate";
import { Money, QUANTITY_SCALE, Quantity, type CurrencyCode } from "../money";

/** The company's method (spec:1214; `company.costing_method`, migration 0035). AVCO is the v1 default. */
export type CostingMethod = "avco" | "fifo";

/**
 * The minimum meaningful quantity — spec:1227's clamp, exported as ONE name so no call site retypes it.
 * LEGACY-008(b): the guard in the old system was `if (aCurrentQnt <> 0)`, which excludes only exact zero, and
 * the smallest non-zero numeric(18,4) is 0.0001 — so a divisor could be 10,000× smaller than one unit and a
 * return of 5.0001 against 5.0000 on hand produced a stored unit cost of 500,020.00. Anything below this
 * value is not a denominator; it is a residue, and an issue against it is refused.
 */
export const MIN_MEANINGFUL_QTY: Quantity = Quantity.of("0.000001");

/** One inventory receipt's cost layer (spec:1216-1217). Ordered by the contracts §4.3.5 chronological key. */
export interface Layer {
  id: string;
  itemId: string;
  warehouseId: string;
  lotId: string;
  movementId: string;
  qtyIn: Quantity;
  unitCost: Money;
  qtyRemaining: Quantity;
  effectiveDate: string;
  postingSeq: bigint;
  lineNo: number;
  movementNo: number;
}

/** Exactly what an issue consumed (spec:1218). `quantity` and `value` are magnitudes. */
export interface Consumption { layerId: string; quantity: Quantity; unitCost: Money; value: Money }

export interface CostingInput {
  method: CostingMethod;
  /** The OPEN layers of this movement's (company, item, warehouse), in chronological order. Never per-lot. */
  openLayers: Layer[];
  movement: PlannedMovement & { effectiveDate: string; postingSeq: bigint; movementId: string; lotId: string };
  /**
   * True when the caller has authority for the layers to fall short: a free-of-charge line
   * (`costing === "zero"`, spec:1055) or a document carrying an `inventory.negative_stock.override`
   * event recorded by a second principal (F-6; tests 7 and 18). The shortfall is then VALUED at the
   * running average and produces no consumption row — there is no layer to point at, and
   * `cost_consumption.layer_id` is NOT NULL because a consumption is a fact about a layer.
   */
  allowShortfall: boolean;
}

export interface CostingOutput {
  /** A magnitude, never negative. `movement.effect` carries the direction (§4.4.2 amendment A9's discipline). */
  value: Money;
  unitCost: Money;
  consumptions: Consumption[];
  newLayer: Omit<Layer, "id"> | null;
  updatedRemaining: { layerId: string; qtyRemaining: Quantity }[];
}

export interface CostingEngine {
  /**
   * Pure. A receipt creates a layer at the movement's value; an issue consumes per `method` — FIFO takes the
   * oldest layers, AVCO a proportional slice of all open layers at the running average (spec:1222).
   * Throws `CostingError`: `ERR_COST_NEGATIVE` if a computed unit cost is negative, `ERR_STOCK_INSUFFICIENT`
   * if the open layers cannot cover the issue and `allowShortfall` is false or if the divisor would fall
   * below `MIN_MEANINGFUL_QTY` (spec:1227), `ERR_COST_VALUE_MISSING` if a receipt carries no value (LEGACY-007).
   */
  cost(input: CostingInput): CostingOutput;
  /** Running average for display and valuation: Σ(qtyRemaining × unitCost) ÷ Σ qtyRemaining over open layers. */
  average(openLayers: Layer[], baseCurrency: CurrencyCode): Money;
}

/**
 * The engine's one error class. `packages/domain` may not import `AppError` from `@dulja/contracts`
 * (spec:2389 — domain imports nothing from the other packages), so this mirrors `PolicyEvaluationError`
 * (§4.4.2): one class, three codes, every code a literal member of `ErrCode`. `applyMovements` translates
 * it to `PostingError` with the same code, and `apps/api/src/problem.ts` maps that to the wire `Problem`.
 */
export class CostingError extends Error {
  constructor(
    readonly code: "ERR_COST_NEGATIVE" | "ERR_STOCK_INSUFFICIENT" | "ERR_COST_VALUE_MISSING",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CostingError";
  }
}

const QTY_UNIT = 10n ** BigInt(QUANTITY_SCALE);

/** A `Quantity` as an exact integer count of micro-units. `Quantity` is fixed at 6 dp, so this never loses. */
function micro(q: Quantity): bigint {
  return BigInt(q.toDecimal().times(QTY_UNIT.toString()).toFixed(0));
}

function fromMicro(v: bigint): Quantity {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = (abs / QTY_UNIT).toString();
  const frac = (abs % QTY_UNIT).toString().padStart(QUANTITY_SCALE, "0");
  return Quantity.of(`${negative ? "-" : ""}${whole}.${frac}`);
}

/** `Quantity` has no `abs()` (contracts §4.2.1) — direction lives on `effect`, so magnitudes are taken here. */
function magnitudeOf(q: Quantity): Quantity {
  return q.isNegative() ? q.negate() : q;
}

function sumRemaining(layers: readonly Layer[]): Quantity {
  return layers.reduce((a, l) => a.add(l.qtyRemaining), Quantity.zero());
}

/**
 * `value ÷ quantity`, rounded HALF_AWAY_FROM_ZERO at MONEY_SCALE — the same mode and scale base conversion
 * uses (spec:1816), so a unit cost and a base amount round the same way in both directions of the sign.
 * Refuses a divisor below MIN_MEANINGFUL_QTY (spec:1227) and a negative result (LEGACY-008).
 */
function unitCostOf(value: Money, quantity: Quantity, where: string): Money {
  const divisor = quantity.toDecimal();
  if (divisor.lessThan(MIN_MEANINGFUL_QTY.toDecimal())) {
    throw new CostingError(
      "ERR_STOCK_INSUFFICIENT",
      `${where}: quantity ${quantity.toString()} is below the minimum meaningful quantity ${MIN_MEANINGFUL_QTY.toString()} — dividing by a residue is what produced LEGACY-008's stored unit cost of 500,020.00`,
    );
  }
  const unit = value.divide(divisor, "HALF_AWAY_FROM_ZERO");
  if (unit.isNegative()) {
    throw new CostingError("ERR_COST_NEGATIVE", `${where}: computed unit cost ${unit.toString()} is negative`);
  }
  return unit;
}

/**
 * Largest-remainder split of `need` across `weights`, in exact micro-units. Σ result === need, always.
 * A proportional AVCO slice that did not close would leave a residue on the layers that no later issue
 * could ever clear, and `qty_remaining` would drift away from `qty_in − Σ consumptions` — which is exactly
 * the invariant the `cost_layer` projection check asserts every night.
 */
function splitQuantity(need: Quantity, weights: readonly Quantity[]): Quantity[] {
  const target = micro(need);
  const w = weights.map(micro);
  const total = w.reduce((a, x) => a + x, 0n);
  if (total <= 0n) {
    throw new CostingError("ERR_STOCK_INSUFFICIENT", `no open layer has any quantity remaining to consume ${need.toString()} from`);
  }
  const parts: bigint[] = [];
  const remainders: { index: number; rest: bigint }[] = [];
  let assigned = 0n;
  w.forEach((weight, index) => {
    const numerator = target * weight;
    const share = numerator / total;
    parts.push(share);
    remainders.push({ index, rest: numerator % total });
    assigned += share;
  });
  let left = target - assigned;
  // Descending remainder, ties broken by the layer's own chronological position — deterministic, which is
  // what makes the golden fixtures byte-comparable.
  remainders.sort((x, y) => (x.rest === y.rest ? x.index - y.index : y.rest > x.rest ? 1 : -1));
  for (const { index } of remainders) {
    if (left <= 0n) break;
    parts[index] = parts[index]! + 1n;
    left -= 1n;
  }
  return parts.map(fromMicro);
}

function costReceipt(input: CostingInput): CostingOutput {
  const { movement } = input;
  const where = `receipt movement ${movement.movementNo} of line ${movement.lineNo}`;
  const quantity = magnitudeOf(movement.quantity);
  if (quantity.isZero()) {
    throw new CostingError("ERR_COST_VALUE_MISSING", `${where}: quantity is zero — a movement of nothing has no cost`);
  }
  if (movement.value === null) {
    throw new CostingError(
      "ERR_COST_VALUE_MISSING",
      `${where} carries no value; value is a mandatory non-null attribute of every stock movement and is rejected at write time if absent (LEGACY-007, spec:1226)`,
    );
  }
  if (movement.value.isNegative()) {
    throw new CostingError("ERR_COST_NEGATIVE", `${where}: value ${movement.value.toString()} is negative`);
  }
  const unitCost = unitCostOf(movement.value, quantity, where);
  return {
    value: movement.value,
    unitCost,
    consumptions: [],
    newLayer: {
      itemId: movement.itemId,
      warehouseId: movement.warehouseId,
      lotId: movement.lotId,
      movementId: movement.movementId,
      qtyIn: quantity,
      unitCost,
      qtyRemaining: quantity,
      effectiveDate: movement.effectiveDate,
      postingSeq: movement.postingSeq,
      lineNo: movement.lineNo,
      movementNo: movement.movementNo,
    },
    updatedRemaining: [],
  };
}

function costIssue(input: CostingInput): CostingOutput {
  const { method, openLayers, movement, allowShortfall } = input;
  const where = `issue movement ${movement.movementNo} of line ${movement.lineNo}`;
  const need = magnitudeOf(movement.quantity);
  if (need.isZero()) {
    throw new CostingError("ERR_COST_VALUE_MISSING", `${where}: quantity is zero — a movement of nothing has no cost`);
  }
  const open = openLayers.filter((l) => !l.qtyRemaining.isZero() && !l.qtyRemaining.isNegative());
  const baseCurrency = open[0]?.unitCost.currency ?? movement.value?.currency ?? null;
  if (baseCurrency === null) {
    // No layer to borrow a currency from and no value on the movement. Legal only for an authorised
    // shortfall against an empty layer set (a free-of-charge line at zero stock, spec:1055).
    if (!allowShortfall) {
      throw new CostingError(
        "ERR_STOCK_INSUFFICIENT",
        `${where}: ${need.toString()} requested and no open cost layer exists for item ${movement.itemId} in warehouse ${movement.warehouseId}`,
      );
    }
    throw new CostingError(
      "ERR_COST_VALUE_MISSING",
      `${where}: an authorised shortfall against an empty layer set carries no currency; applyMovements must supply the company's base currency on movement.value`,
    );
  }
  const zero = Money.zero(baseCurrency);
  const available = sumRemaining(open);
  const short = available.compare(need) < 0;
  if (short && !allowShortfall) {
    throw new CostingError(
      "ERR_STOCK_INSUFFICIENT",
      `${where}: ${need.toString()} requested but only ${available.toString()} remains in the open cost layers of item ${movement.itemId} in warehouse ${movement.warehouseId} — refuse rather than absorb (LEGACY-008)`,
    );
  }
  const covered = short ? available : need;
  const shortfall = need.subtract(covered);

  const consumptions: Consumption[] = [];
  const updatedRemaining: { layerId: string; qtyRemaining: Quantity }[] = [];
  let coveredValue = zero;

  if (!covered.isZero()) {
    if (method === "avco") {
      const runningAverage = average(open, baseCurrency);
      coveredValue = runningAverage.multiply(covered.toDecimal(), "HALF_AWAY_FROM_ZERO");
      const parts = splitQuantity(covered, open.map((l) => l.qtyRemaining));
      // One rounding at the movement level, then allocate down. A very small layer beside large ones can
      // floor to a 0.000000 share, and such a layer gets NO consumption row — so it must not be a weight
      // either: allocate over the surviving shares only and zip positionally against them. (0D's allocate
      // orders the residue by largest remainder with ties to the lowest index, 0d:474-477, so a zero weight
      // could not in fact win a unit while a positive-remainder share is unpaid; filtering makes Σ
      // consumption value = out.value true by construction rather than by that argument.)
      const taking = open
        .map((layer, i) => ({ layer, quantity: parts[i]! }))
        .filter((t) => !t.quantity.isZero());
      const values = coveredValue.allocate(taking.map((t) => micro(t.quantity)), "HALF_AWAY_FROM_ZERO");
      taking.forEach((t, i) => {
        consumptions.push({ layerId: t.layer.id, quantity: t.quantity, unitCost: runningAverage, value: values[i]! });
        updatedRemaining.push({ layerId: t.layer.id, qtyRemaining: t.layer.qtyRemaining.subtract(t.quantity) });
      });
    } else {
      // FIFO — Task 3 fills this branch. Until then the method is unreachable: migration 0035's CHECK
      // admits 'fifo' but no company can be set to it before Task 4, and `cost` refuses it here rather
      // than silently costing a FIFO company at AVCO, which is LEGACY-009 in one file instead of three.
      // A PLAIN Error, not a CostingError: this is scaffolding Task 3 deletes, and giving it a registered
      // ErrCode would put a fake occurrence of a real code in front of the `error-codes` lint (§3.7.5).
      throw new Error(`${where}: costing method fifo is not implemented yet (3B Task 3 fills this branch)`);
    }
  }

  const shortfallValue = shortfall.isZero()
    ? zero
    : average(open, baseCurrency).multiply(shortfall.toDecimal(), "HALF_AWAY_FROM_ZERO");
  const value = coveredValue.add(shortfallValue);
  const unitCost = unitCostOf(value, need, where);
  return { value, unitCost, consumptions, newLayer: null, updatedRemaining };
}

function average(openLayers: Layer[], baseCurrency: CurrencyCode): Money {
  const zero = Money.zero(baseCurrency);
  if (openLayers.length === 0) return zero;
  const totalQty = sumRemaining(openLayers);
  // A residue below one micro-unit is not a denominator (spec:1227). Returning zero here is safe because
  // valuation never computes `average × quantity` — `valuationAsOf` sums round(qtyRemaining × unit_cost, 4)
  // per layer directly — so this value reaches a display, never a stored amount.
  if (totalQty.toDecimal().lessThan(MIN_MEANINGFUL_QTY.toDecimal())) return zero;
  const totalValue = openLayers.reduce(
    (a, l) => a.add(l.unitCost.multiply(l.qtyRemaining.toDecimal(), "HALF_AWAY_FROM_ZERO")),
    zero,
  );
  return totalValue.divide(totalQty.toDecimal(), "HALF_AWAY_FROM_ZERO");
}

function cost(input: CostingInput): CostingOutput {
  return input.movement.effect === "receipt" ? costReceipt(input) : costIssue(input);
}

/** THE one implementation (spec:1228). Reports, valuation and posting import this and never re-implement it. */
export const costingEngine: CostingEngine = { cost, average };
```

There is deliberately **no `import Decimal from "decimal.js"`** in that file. Every decimal operation goes through `Money` and `Quantity` (whose `toDecimal()` hands out the value when a divisor or a factor is needed), and Task 3's FIFO branch adds none either — it compares with `Quantity.compare` and multiplies with `Money.multiply`. If your editor adds the import, delete it: `bun run lint` flags it, and a `Decimal` in this file would be a second arithmetic surface beside the two opaque types (§4.2.1's rule).

- [ ] **Step 4: Write `packages/domain/src/costing/index.ts` and export it**

```ts
export {
  costingEngine, CostingError, MIN_MEANINGFUL_QTY,
  type Consumption, type CostingEngine, type CostingInput, type CostingMethod, type CostingOutput, type Layer,
} from "./engine";
```

Add `export * from "./costing";` to `packages/domain/src/index.ts`, beside the existing `export * from "./posting";`.

- [ ] **Step 5: Add `ERR_COST_VALUE_MISSING` to the error registry and widen `PostingErrorCode`**

In `packages/contracts/src/errors.ts`, add one row to `ERRORS` (amendment A3). It lands in this commit because the same commit raises it in `engine.ts`, and `scripts/lint/rules/error-codes.ts` fails on a code in `ERRORS` with no occurrence in `apps/**`, `packages/**/src/**` or `packages/db/migrations/**`:

```ts
  ERR_COST_VALUE_MISSING: {
    status: 422,
    title: "Stock movement cannot be costed",
    remedy: "A stock movement needs a non-zero quantity and a value. Give the line a quantity and a unit price, or allocate a landed cost to it, before posting.",
  },
```

**The title and remedy cover both arms the engine raises this code for**, and that is deliberate rather than loose. LEGACY-007 is the missing *value* (`procProducePackage` inserted both legs with no `BtmPureTotal`) and LEGACY-008(c) is the zero *quantity* (a wash line at zero stock); both are "this movement cannot be costed", and a remedy naming only the unit price would point a user at the wrong field on a wash line. The alternative — a second code for the quantity arm — would need a new `ErrCode` row *and* a fourth member on `CostingError`'s union, which amendment A3 does not carry.

`ERR_COST_NEGATIVE` and `ERR_STOCK_INSUFFICIENT` are already allocated in contracts §4.2.4 — `ERR_STOCK_INSUFFICIENT` shipped with 3A's `assert_stock_available` trigger and `ERR_COST_NEGATIVE` is allocated to this slice. Check both are present in `ERRORS` before adding the row; if `ERR_COST_NEGATIVE` is absent, add it too:

```ts
  ERR_COST_NEGATIVE: {
    status: 422,
    title: "Computed cost is negative",
    remedy: "A negative unit cost cannot be stored. Check the returned quantity and value on the movement that produced it.",
  },
```

In `packages/db/src/posting/errors.ts`, widen the union (amendment A3). Every added member is a literal member of `ErrCode`, which is the block's own rule:

```ts
export type PostingErrorCode =
  | "ERR_NOT_FOUND" | "ERR_DOC_STATUS_ILLEGAL" | "ERR_DOC_NO_LINES" | "ERR_POLICY_NOT_FOUND"
  | "ERR_POLICY_INVALID" | "ERR_POLICY_REQUIRES_MISSING" | "ERR_PERIOD_NOT_FOUND" | "ERR_PERIOD_NOT_OPEN"
  | "ERR_LEDGER_UNBALANCED"
  // 3B — the costing hook runs inside postDocument (contracts §4.3.2 step 9, §4.3.8)
  | "ERR_STOCK_INSUFFICIENT" | "ERR_COST_NEGATIVE" | "ERR_COST_VALUE_MISSING"
  // 3B — a back-dated inventory document reached postDocument through a caller that supplied no JobClient
  | "ERR_INTERNAL";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd packages/domain test -- test/costing/engine.test.ts`
Expected: **PASS**, all eight cases. If the proportional-split case fails with a Σ that is one micro-unit off, the `remainders.sort` comparator is returning `0` for unequal bigints — bigint subtraction cannot be used as a comparator result because `sort` coerces it to a number, which is why the comparator above branches on `>` instead.

Run: `bun run --cwd packages/domain test && bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS. `no-number-money` (§3.7.5) is the rule most likely to fire here: every name matching `/amount|price|cost|debit|credit|total|balance|rate|tax|net|gross/i` must be typed `Money`, `Quantity`, `Decimal` or `string`, never `number`. `unitCost`, `coveredValue`, `runningAverage` and `totalValue` are all `Money`; `micro()` returns `bigint`, which the rule does not name and does not flag.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/costing packages/domain/src/index.ts packages/domain/test/costing \
        packages/contracts/src/errors.ts packages/db/src/posting/errors.ts
git commit -m "$(cat <<'EOF'
feat(domain): the one costing engine — types, guards, AVCO [3B T2]

contracts §4.7.1, with the five additions amendment A2 records: CostingError
gets a body (packages/domain may not import AppError, so this is
PolicyEvaluationError's situation exactly), MIN_MEANINGFUL_QTY is one exported
name rather than three copies of "0.000001", average takes baseCurrency for the
reason balanceInBase already does, the movement intersection narrows lotId and
carries the pre-generated movementId, and allowShortfall lets an authorised
override excursion through.

AVCO takes a proportional slice of EVERY open layer at the running average
(spec:1218), split by largest remainder in exact micro-units so the quantities
close and Money.allocate so the values do. The costing scope is
(company, item, warehouse) and never the lot: AVCO has no per-lot average.

ERR_COST_VALUE_MISSING joins the registry in the commit that raises it, and
PostingErrorCode widens by four ErrCode members.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The costing engine, part II — FIFO, the chronological sort, and every guard (acceptance test 6)

**Files:**
- Modify: `packages/domain/src/costing/engine.ts`
- Test: `packages/domain/test/costing/engine.test.ts` (append), `packages/domain/test/costing/guards.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced — `costingEngine`, `CostingError`, `MIN_MEANINGFUL_QTY`, `Layer`, `Consumption`, `CostingInput`, `CostingOutput` — plus `Money`, `Quantity`, `currency` from `packages/domain/src/money`.
- Produces: no new exported name. The FIFO branch of `cost()` and the `byChronology` ordering become behaviour of `costingEngine`, which every later task and both later phases consume unchanged.

This task owns **acceptance test 6** (spec:2424 — "Costing edge cases. Return exceeding stock; wash line at zero stock; value-less movement. All rejected or handled; **no negative, NULL, or exploded cost is ever stored**." — LEGACY-007, 008) at the engine layer. Task 13's `legacy-007` and `legacy-008` regression files re-assert the same three cases through `postDocument` against a real database, which is where "is ever stored" is actually provable.

- [ ] **Step 1: Write the failing test `packages/domain/test/costing/guards.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  costingEngine, CostingError, MIN_MEANINGFUL_QTY, Money, Quantity, currency,
  type CostingInput, type Layer,
} from "../../src/index";

const MYR = currency("MYR");
const money = (v: string) => Money.of(v, MYR);
const qty = (v: string) => Quantity.of(v);

function layer(id: string, qtyRemaining: string, unitCost: string, seq: number, effectiveDate = "2026-01-01"): Layer {
  return {
    id, itemId: "item-1", warehouseId: "wh-1", lotId: "lot-1", movementId: `mv-${id}`,
    qtyIn: qty(qtyRemaining), unitCost: money(unitCost), qtyRemaining: qty(qtyRemaining),
    effectiveDate, postingSeq: BigInt(seq), lineNo: 1, movementNo: 1,
  };
}

function move(over: Partial<CostingInput["movement"]>, openLayers: Layer[], rest: Partial<CostingInput> = {}): CostingInput {
  return {
    method: "avco", openLayers, allowShortfall: false,
    movement: {
      lineNo: 1, movementNo: 1, itemId: "item-1", warehouseId: "wh-1", lotId: "lot-1",
      quantity: qty("1.000000"), effect: "issue", value: null, costing: "consume_layers",
      effectiveDate: "2026-03-01", postingSeq: 99n, movementId: "mv-x", ...over,
    },
    ...rest,
  };
}

describe("costing guards — acceptance test 6 (spec:2424; LEGACY-007, LEGACY-008)", () => {
  it("(a) a return exceeding stock is REFUSED, not absorbed — LEGACY-008(a)'s exact numbers", () => {
    // On hand 5 @ 10; return 6 to the supplier. The old system computed (10·5 − 30)/(−1) = −20.00 and
    // stored it, so every later sale booked negative COGS. Here the issue is refused before any arithmetic.
    const layers = [layer("L1", "5.000000", "10.0000", 1)];
    expect(() => costingEngine.cost(move({ quantity: qty("6.000000") }, layers)))
      .toThrow(/ERR_STOCK_INSUFFICIENT.*6\.000000 requested but only 5\.000000 remains/s);
    // and it threw the class, not a bare Error, so applyMovements can translate the code
    try {
      costingEngine.cost(move({ quantity: qty("6.000000") }, layers));
      expect.unreachable("the issue must be refused");
    } catch (e) {
      expect(e).toBeInstanceOf(CostingError);
      expect((e as CostingError).code).toBe("ERR_STOCK_INSUFFICIENT");
    }
  });

  it("(b) a sub-micro divisor is unrepresentable, and one micro-unit is a real denominator — LEGACY-008(b)", () => {
    // The old guard was `if (aCurrentQnt <> 0)`, which excludes only exact zero; the smallest non-zero
    // numeric(18,4) is 0.0001, so returning 5.0001 against 5.0000 left a divisor of −0.0001 and stored a unit
    // cost of 500,020.00. Two things close that here, and this case asserts both.
    //
    // FIRST: the type refuses the value. `Quantity.of` tests /^-?\d+(\.\d{1,6})?$/ and throws (0d:1034-1039),
    // so a 0.0000005 quantity cannot be constructed, let alone divided by. The engine's own refusal below
    // MIN_MEANINGFUL_QTY (amendment A22 — refused, not clamped: clamping 0.0000005 to 0.000001 still returns
    // an exploded unit cost) is therefore unreachable from a `Quantity` and stays as the guard that catches a
    // future QUANTITY_SCALE change rather than a runtime input.
    expect(() => Quantity.of("0.0000005")).toThrow(/at most 6 decimal places/);
    expect(MIN_MEANINGFUL_QTY.toString()).toBe("0.000001");

    // SECOND: the smallest representable quantity IS a denominator, and the boundary sits ON
    // MIN_MEANINGFUL_QTY, which `lessThan` admits. A one-micro-unit issue against a one-micro-unit layer
    // therefore posts: it empties the layer and its value rounds to 0.0000 at MONEY_SCALE. Nothing explodes
    // and nothing is falsely refused — which is the pair of failures LEGACY-008(b) actually produced.
    const layers = [layer("L1", "0.000001", "10.0000", 1)];
    const out = costingEngine.cost(move({ quantity: qty("0.000001") }, layers));
    expect(out.value.toString()).toBe("0.0000");        // round(0.000001 × 10.0000, 4) = 0.0000
    expect(out.unitCost.toString()).toBe("0.0000");     // 0.0000 ÷ 0.000001 is 0.0000, never 10,000×
    expect(out.updatedRemaining).toEqual([{ layerId: "L1", qtyRemaining: qty("0.000000") }]);
  });

  it("(c) a wash line — a movement of zero quantity — is refused, never costed at zero (LEGACY-008(c))", () => {
    // A landed-cost or reconciliation line posted at zero stock set Cost = 0 in the old system and every
    // later sale booked zero COGS. A movement of nothing has no cost; in 3C a landed cost adjusts a LAYER's
    // unit_cost and is not a movement at all.
    expect(() => costingEngine.cost(move({ quantity: qty("0.000000") }, [layer("L1", "5.000000", "10.0000", 1)])))
      .toThrow(/ERR_COST_VALUE_MISSING.*quantity is zero/s);
    expect(() => costingEngine.cost(move({ quantity: qty("0.000000"), effect: "receipt", value: money("50.0000"), costing: "create_layer" }, [])))
      .toThrow(/ERR_COST_VALUE_MISSING.*quantity is zero/s);
  });

  it("(d) a value-less receipt is refused — LEGACY-007's NULL poisoning", () => {
    // procProducePackage inserted both legs with no BtmPureTotal; (42·500 + NULL)/500 = NULL, coalesced to
    // 0.00 on the next sale, and a full recompute hit the same NULL. Value is mandatory here.
    expect(() => costingEngine.cost(move({ effect: "receipt", value: null, costing: "create_layer", quantity: qty("500.000000") }, [])))
      .toThrow(/ERR_COST_VALUE_MISSING.*mandatory non-null attribute/s);
  });

  it("(e) a negative receipt value is a hard error, not a stored cost", () => {
    expect(() => costingEngine.cost(move({ effect: "receipt", value: money("-30.0000"), costing: "create_layer", quantity: qty("6.000000") }, [])))
      .toThrow(/ERR_COST_NEGATIVE.*value -30\.0000 is negative/s);
  });

  it("(f) an issue with no open layer at all is refused unless a shortfall is authorised", () => {
    expect(() => costingEngine.cost(move({ quantity: qty("1.000000") }, [])))
      .toThrow(/ERR_STOCK_INSUFFICIENT.*no open cost layer exists/s);
  });

  it("an AUTHORISED shortfall is valued at the running average and layers only what it could take (F-6, test 7)", () => {
    // 3A's assert_stock_available refuses this unless an inventory.negative_stock.override event exists,
    // recorded by a second principal. When it does, applyMovements sets allowShortfall and the excursion is
    // valued — 6 units at the 10.0000 average — but only the 5 that existed produce a consumption row,
    // because cost_consumption.layer_id is NOT NULL and there is no layer for the sixth.
    const layers = [layer("L1", "5.000000", "10.0000", 1)];
    const out = costingEngine.cost(move({ quantity: qty("6.000000") }, layers, { allowShortfall: true }));
    expect(out.value.toString()).toBe("60.0000");
    expect(out.unitCost.toString()).toBe("10.0000");
    expect(out.consumptions).toHaveLength(1);
    expect(out.consumptions[0]!.quantity.toString()).toBe("5.000000");
    expect(out.consumptions[0]!.value.toString()).toBe("50.0000");
    expect(out.updatedRemaining).toEqual([{ layerId: "L1", qtyRemaining: qty("0.000000") }]);
  });

  it("an AUTHORISED override issue against NO layers is valued at zero, not refused (F-6, tests 7 and 18)", () => {
    // The negative-stock excursion at its extreme: an override issue when the item has never been received.
    // `applyMovements` gives every issue `Money.zero(baseCurrency)` (Task 7 note 3), so the engine always has
    // a currency to answer in and never reaches its own "no currency to borrow" refusal on this path. The
    // shortfall is the whole quantity, the running average of an empty layer set is 0.0000, and the movement
    // is therefore valued at 0.0000 with no consumption row — the layer-less half of ADR 0038 note 7.
    const out = costingEngine.cost(move(
      { quantity: qty("6.000000"), value: money("0.0000") },
      [],
      { allowShortfall: true },
    ));
    expect(out.value.toString()).toBe("0.0000");
    expect(out.unitCost.toString()).toBe("0.0000");
    expect(out.consumptions).toEqual([]);
    expect(out.updatedRemaining).toEqual([]);
    expect(out.newLayer).toBeNull();
  });

  it("a free-of-charge line at zero stock costs at zero (spec:1055) when the caller supplies the currency", () => {
    // `costing: "zero"` with no layers: applyMovements passes Money.zero(baseCurrency) on the movement so the
    // engine has a currency to answer in, and the line consumes nothing.
    const out = costingEngine.cost(move(
      { quantity: qty("2.000000"), costing: "zero", value: money("0.0000") },
      [],
      { allowShortfall: true },
    ));
    expect(out.value.toString()).toBe("0.0000");
    expect(out.unitCost.toString()).toBe("0.0000");
    expect(out.consumptions).toEqual([]);
  });
});
```

- [ ] **Step 2: Append the FIFO cases to `packages/domain/test/costing/engine.test.ts`**

```ts
describe("costingEngine — FIFO shares the layer model (spec:1214, LEGACY-055)", () => {
  const layers = () => [
    layer({ id: "L2", qtyIn: "100.000000", unitCost: "20.0000", qtyRemaining: "100.000000", seq: 2, effectiveDate: "2026-01-20" }),
    layer({ id: "L1", qtyIn: "100.000000", unitCost: "10.0000", qtyRemaining: "100.000000", seq: 1, effectiveDate: "2026-01-10" }),
  ];

  it("consumes the OLDEST layer first, whatever order the caller passed them in", () => {
    const out = costingEngine.cost(issue("150.000000", layers(), { method: "fifo" }));
    expect(out.consumptions.map((c) => [c.layerId, c.quantity.toString(), c.unitCost.toString(), c.value.toString()])).toEqual([
      ["L1", "100.000000", "10.0000", "1000.0000"],
      ["L2", "50.000000", "20.0000", "1000.0000"],
    ]);
    expect(out.value.toString()).toBe("2000.0000");
    // the movement's own unit cost is the weighted result, not either layer's
    expect(out.unitCost.toString()).toBe("13.3333");
    expect(out.updatedRemaining).toEqual([
      { layerId: "L1", qtyRemaining: qty("0.000000") },
      { layerId: "L2", qtyRemaining: qty("50.000000") },
    ]);
  });

  it("FIFO and AVCO answer differently over the same layers — the method is a real switch", () => {
    const fifo = costingEngine.cost(issue("150.000000", layers(), { method: "fifo" }));
    const avco = costingEngine.cost(issue("150.000000", layers(), { method: "avco" }));
    expect(fifo.value.toString()).toBe("2000.0000");
    expect(avco.value.toString()).toBe("2250.0000");           // 150 × the 15.0000 average
    expect(fifo.consumptions[0]!.unitCost.toString()).toBe("10.0000");
    expect(avco.consumptions[0]!.unitCost.toString()).toBe("15.0000");
  });

  it("the FIFO carry-forward is total — every layer touched, none skipped, and the quantities close (LEGACY-055)", () => {
    // procMatStorage's `if ((Material is not null) or (Material <> aMat))` reset the carry-forward on every
    // row, so the FIFO walk never happened. This asserts the opposite: the walk visits layers in order until
    // the need is met and Σ consumed = the issue exactly.
    const three = [
      layer({ id: "A", qtyIn: "3.000000", unitCost: "1.0000", qtyRemaining: "3.000000", seq: 1, effectiveDate: "2026-01-01" }),
      layer({ id: "B", qtyIn: "3.000000", unitCost: "2.0000", qtyRemaining: "3.000000", seq: 2, effectiveDate: "2026-01-02" }),
      layer({ id: "C", qtyIn: "3.000000", unitCost: "3.0000", qtyRemaining: "3.000000", seq: 3, effectiveDate: "2026-01-03" }),
    ];
    const out = costingEngine.cost(issue("7.000000", three, { method: "fifo" }));
    expect(out.consumptions.map((c) => c.layerId)).toEqual(["A", "B", "C"]);
    expect(out.consumptions.reduce((a, c) => a.add(c.quantity), Quantity.zero()).toString()).toBe("7.000000");
    expect(out.value.toString()).toBe("12.0000");              // 3×1 + 3×2 + 1×3
  });

  it("two layers with the same date and sequence are ordered by (line_no, movement_no) — the key is total (LEGACY-067)", () => {
    const sameKey = [
      { ...layer({ id: "SECOND", qtyIn: "1.000000", unitCost: "9.0000", qtyRemaining: "1.000000", seq: 4 }), lineNo: 1, movementNo: 2 },
      { ...layer({ id: "FIRST", qtyIn: "1.000000", unitCost: "1.0000", qtyRemaining: "1.000000", seq: 4 }), lineNo: 1, movementNo: 1 },
    ];
    const out = costingEngine.cost(issue("1.000000", sameKey, { method: "fifo" }));
    expect(out.consumptions.map((c) => c.layerId)).toEqual(["FIRST"]);
  });
});
```

Extend the file's `layer` helper so it accepts the two extra fields the new cases pass — replace its signature and body with:

```ts
function layer(over: {
  id: string; qtyIn: string; unitCost: string; qtyRemaining: string; seq: number;
  effectiveDate?: string; lineNo?: number; movementNo?: number;
}): Layer {
  return {
    id: over.id, itemId: "item-1", warehouseId: "wh-1", lotId: "lot-1", movementId: `mv-${over.id}`,
    qtyIn: qty(over.qtyIn), unitCost: money(over.unitCost), qtyRemaining: qty(over.qtyRemaining),
    effectiveDate: over.effectiveDate ?? "2026-01-01", postingSeq: BigInt(over.seq),
    lineNo: over.lineNo ?? 1, movementNo: over.movementNo ?? 1,
  };
}
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `bun run --cwd packages/domain test -- test/costing`
Expected: **FAIL** — **all four** appended FIFO cases in `engine.test.ts` fail with the same message, `Error: issue movement 1 of line 1: costing method fifo is not implemented yet (3B Task 3 fills this branch)`, the plain `Error` Task 2 left as scaffolding. The same-key ordering case is no exception: at this point the `else` branch throws before any ordering is consulted, so a reader who expects it to fail on a wrong consumption order is reading the wrong diagnosis. It would additionally fail on order once Step 4 adds the branch but before `byChronology` is applied to `openLayers` — which is why Step 4 adds the sort and the branch in one edit, and why the ordering case is written with the layers deliberately passed newest-first.

`guards.test.ts` is expected to be **green already** — every case in it is a Task 2 behaviour, and the file is written in this task only because acceptance test 6 is this task's to own. Two of its cases are worth reading if they are red rather than green, because each names a different defect: case (b)'s first assertion failing means `Quantity.of` accepts more than six decimal places, which contradicts 0d:1034–1039 and makes `MIN_MEANINGFUL_QTY` reachable from a runtime input; the override-against-no-layers case failing with `ERR_COST_VALUE_MISSING` means Task 2's `costIssue` was typed with a currency fallback that does not admit `Money.zero`, and the fix is in that function, not here.

- [ ] **Step 4: Add the chronological sort and the FIFO branch to `packages/domain/src/costing/engine.ts`**

First the ordering. Add above `costReceipt`:

```ts
/**
 * The contracts §4.3.5 chronological key, written out in full: (effective_date, posting_seq, line_no,
 * movement_no). The engine sorts its own input rather than trusting the caller's order, and that is
 * deliberate: LEGACY-005's whole defect was one path ordering by document **id** while the other ordered by
 * **date**, so "the incremental mode" and "the batch replay" disagreed about what "the newest transaction"
 * meant. There is one ordering, in one function, and neither `applyMovements` nor `replay` can get it wrong.
 * spec:1225 — "the chronological key is explicit and total — never dependent on an index definition (LEGACY-067)".
 */
function byChronology(a: Layer, b: Layer): number {
  if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate ? -1 : 1;
  if (a.postingSeq !== b.postingSeq) return a.postingSeq < b.postingSeq ? -1 : 1;
  if (a.lineNo !== b.lineNo) return a.lineNo - b.lineNo;
  return a.movementNo - b.movementNo;
}
```

Then, inside `costIssue`, replace the `open` binding with the sorted one — `[...openLayers]` because a pure function does not mutate its argument, which the purity case in `engine.test.ts` asserts:

```ts
  const open = [...openLayers]
    .filter((l) => !l.qtyRemaining.isZero() && !l.qtyRemaining.isNegative())
    .sort(byChronology);
```

Then replace the whole `else` branch — the `throw new Error(… "costing method fifo is not implemented yet …")` scaffolding Task 2 left — with the walk:

```ts
    } else {
      // FIFO: the oldest layers first, at each layer's OWN unit cost (spec:1222). `open` is already in
      // chronological order, so this is a single forward pass with no re-sorting and no lot filter — the
      // oldest layer wins whatever lot it belongs to. FEFO picking (3A's app.pick_lots_fefo) is what chooses
      // the lot on the document line; the layer order is a costing question, not a picking question.
      let left = covered;
      for (const l of open) {
        if (left.isZero()) break;
        const take = l.qtyRemaining.compare(left) <= 0 ? l.qtyRemaining : left;
        const takenValue = l.unitCost.multiply(take.toDecimal(), "HALF_AWAY_FROM_ZERO");
        consumptions.push({ layerId: l.id, quantity: take, unitCost: l.unitCost, value: takenValue });
        updatedRemaining.push({ layerId: l.id, qtyRemaining: l.qtyRemaining.subtract(take) });
        coveredValue = coveredValue.add(takenValue);
        left = left.subtract(take);
      }
      if (!left.isZero()) {
        // Unreachable: `covered` is min(need, available) and `available` is Σ over the same filtered set.
        // It is here because LEGACY-055's carry-forward bug was exactly a loop that silently did not finish.
        throw new CostingError(
          "ERR_STOCK_INSUFFICIENT",
          `${where}: the FIFO walk ended with ${left.toString()} unconsumed over ${open.length} open layer(s)`,
        );
      }
    }
```

`coveredValue` is reassigned in this branch, so its declaration must be `let coveredValue = zero;` — it already is in Task 2's text. If your editor added `const`, change it back.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/domain test -- test/costing`
Expected: **PASS** — twelve cases in `engine.test.ts` (eight from Task 2, four FIFO) and nine in `guards.test.ts`.

Verify the two FIFO figures by hand before moving on, because they are the numbers the golden fixtures of Task 12 pin: FIFO takes 100 at 10.0000 and 50 at 20.0000, so the value is 1000 + 1000 = 2000.0000 and `2000.0000 ÷ 150.000000` rounds HALF_AWAY_FROM_ZERO at four places to **13.3333**; AVCO takes 150 at the 15.0000 average, so 2250.0000. If FIFO reports 2250 the branch is falling through to AVCO — check that `method === "avco"` is the condition and not `method !== "fifo"` over a widened union.

Run: `bun run --cwd packages/domain test && bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS.

- [ ] **Step 6: Write ADR 0037**

`docs/adr/0037-avco-is-the-v1-costing-method-and-fifo-shares-the-layer-model.md`, in Plan 0A's format (plan0A:189–203). **This is a proposal, not a decision** — spec:95 requires anything touching money semantics to be "written as a proposal and asked before implementing", and OD-06 is the owner's to answer (Task 4):

```markdown
# ADR 0037: AVCO is the v1 costing method, and FIFO shares the same layer model

- **Status:** Proposed (owner decision OD-06, contracts §2.12; spec:92, 1214, 2404)
- **Date:** 2026-09-05
- **Deciders:** owner (method), architect (model)
- **Supersedes:** none

## Context

spec:1214 recommends weighted average (AVCO) as the v1 method, "matching the old system and the
business's expectations", and marks it ⚠️ *Owner to confirm*. spec:1214 also states that FIFO "is
supported by the same layer model … and can be enabled per company later without a schema change".

The old system had three weighted-average formulas — `procCalcCosts`, `procSumBillItems` and the
`OnBillItemsAIUD` trigger — which disagreed on transfer revaluation, on the zero-divisor fallback, on
reject-out revaluation and on whether a negative prior balance was clamped. Over the same data the trigger
answered 1.667 and `procCalcCosts` answered 10.00 (LEGACY-009). No amount of recosting could make the stock
valuation report and the profit report tie, because the formulas differed.

## Decision

1. **One implementation**, `costingEngine` in `packages/domain/src/costing/engine.ts`, pure, imported by
   posting, valuation and every report. spec:1228 states this as a requirement; this ADR records that the
   requirement is met by a single exported const and not by a convention.
2. **Both methods share one layer model.** A receipt writes a `cost_layer`; an issue writes
   `cost_consumption` rows. AVCO issues at the running average and consumes a proportional slice of every
   open layer; FIFO issues at each layer's own cost and consumes the oldest first. The tables, the
   chronological key and the replay are identical. Switching a company's method is one column write and no
   migration, exactly as spec:1214 promises.
3. **`company.costing_method` defaults to `'avco'`** and its CHECK admits `'avco'` and `'fifo'` only.
4. **The costing scope is `(company, item, warehouse)`,** not the lot. AVCO has no per-lot average and FIFO
   takes the oldest layer whatever lot it belongs to. Per-lot *availability* is a separate control (3A's
   `assert_stock_available`) and per-lot *picking* is a separate function (3A's `pick_lots_fefo`).
5. **Three guards are structural, not advisory:** `unit_cost >= 0` and `qty_remaining >= 0` are CHECKs on
   `cost_layer` (and `quantity > 0`, `unit_cost >= 0`, `value >= 0` on `cost_consumption`, amendment A23);
   a divisor below `MIN_MEANINGFUL_QTY = 0.000001` is **refused, not clamped** (amendment A22 — clamping
   0.0000005 to 0.000001 still returns the exploded unit cost test 6 forbids storing), and at
   `QUANTITY_SCALE = 6` such a divisor is unrepresentable anyway, so the refusal guards a future scale change
   rather than a runtime input; and a movement with no value and no way to compute one, or a movement of zero
   quantity, raises `ERR_COST_VALUE_MISSING`. These close LEGACY-007 and all three arms of LEGACY-008.

## Consequences

- A method change on a live company would need a full recost of that company from its first movement. The
  replay of ADR 0038 can do it, but nothing in v1 exposes it as an operation, and the switch is therefore a
  configuration decision taken once per company at setup.
- FIFO ships tested but not defaulted. If the owner answers OD-06 with FIFO, one literal in migration 0035
  changes and `tests/regression/legacy-055.test.ts` becomes the ageing report's proof rather than a switch test.
- Reports may never recompute a cost. 7B's `inventory.stock_ageing` and `inventory.profit_by_item` read
  `cost_layer` and `cost_consumption`; a report that re-derived a figure would be LEGACY-009's fourth formula.
```

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/costing/engine.ts packages/domain/test/costing \
        docs/adr/0037-avco-is-the-v1-costing-method-and-fifo-shares-the-layer-model.md
git commit -m "$(cat <<'EOF'
feat(domain): FIFO, the chronological sort, and every costing guard [3B T3]

Acceptance test 6 at the engine layer (spec:2424). The three cases the spec
names — a return exceeding stock, a wash line at zero stock, a value-less
movement — are refused with ERR_STOCK_INSUFFICIENT, ERR_COST_VALUE_MISSING and
ERR_COST_VALUE_MISSING, using LEGACY-008's own worked numbers as the assertions.

FIFO walks the oldest layer first at that layer's own cost; AVCO takes a
proportional slice at the running average. The engine sorts its own input by the
contracts §4.3.5 key (effective_date, posting_seq, line_no, movement_no) rather
than trusting the caller, because LEGACY-005 was two paths ordering by two
different columns.

ADR 0037 is a PROPOSAL (spec:95, OD-06): the model is the architect's, the
default method is the owner's.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: OD-06 — `company.costing_method`, the FIFO switch, and `legacy-055`

> **Owner decision OD-06 (contracts §2.12; spec:92, 1214, 2404): the v1 costing method.**
> **Owner provides:** a confirmation that weighted average (AVCO) is the v1 method for the first customer, or an instruction to default to FIFO instead.
> **Verify:** `bun run --cwd packages/db test -- test/costing/method.test.ts` prints `default costing_method: avco` and passes both the AVCO and the FIFO case.
> **Until provided:** the default written into migration 0035 is **`'avco'`**, which is spec:1214's own recommendation and contracts §2.12's stated default. Nothing blocks: FIFO ships fully implemented and tested behind the column, so the owner's answer changes **one literal in one migration** and nothing else.
> **What changes if the owner answers FIFO:** the `default 'avco'` in `0035_alter_company_add_costing_method.sql` becomes `default 'fifo'`; the one assertion in `method.test.ts` that reads the default flips; and `tests/regression/legacy-055.test.ts` stops being a switch test and becomes the standing proof for 7B's `inventory.stock_ageing`. No other file, no other task, no schema change (spec:1214 — "can be enabled per company later without a schema change").
> **What changes if the owner removes FIFO from v1 entirely:** delete `'fifo'` from the CHECK in migration 0035, delete the FIFO branch of `costIssue` and its four tests, and delete `tests/regression/legacy-055.test.ts`; 7B's stock-ageing report then documents itself as AVCO-only. That is the only branch in which a file is removed, and it removes exactly those four things.

**Files:**
- Create: `packages/db/migrations/0035_alter_company_add_costing_method.sql`, `packages/db/migrations/0035.down.sql`, `packages/db/test/costing/method.test.ts`, `tests/regression/legacy-055.test.ts`
- Modify: `packages/db/src/schema/company.ts`, `packages/db/src/posting/load.ts`

**Interfaces:**
- Consumes: `startDb`, `Db`, `Seed`, `seedTenantV2`, the 4-argument test `withTenant`, `lintSchema` (contracts §4.1); `loadSnapshot(tx, documentId)` returning `DocumentSnapshot` (contracts §4.3.1, 1A/2A); `costingEngine`, `Money`, `Quantity`, `currency`, `Layer` (Tasks 2–3). **Nothing from `tests/support/regression.ts`** — Step 6's file is a pure `describe` over the engine and needs neither `sharedDb()` nor `thinRegression` (the reason is in Step 6).
- Produces (SQL): `app.company.costing_method text not null default 'avco' check (costing_method in ('avco', 'fifo'))`.
- Produces (TS): `DocumentSnapshot["company"]["costingMethod"]` is read from the column instead of hard-coded — the last of the four fields 2A left stubbed for a named later slice (contracts §4.3.1's stub list: "`company.costingMethod` (3B)").

- [ ] **Step 1: Write the failing test `packages/db/test/costing/method.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSnapshot } from "../../src/posting";
import { lintSchema } from "../../src/lint-schema";
import { draftDocument, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("company.costing_method — OD-06 (spec:1214; contracts §4.7.3, §2.12)", () => {
  let db: Db; let s: Seed;

  beforeAll(async () => { db = await startDb(); s = await seedTenantV2(db, "Method"); });
  afterAll(async () => { await db.stop(); });

  it("a company created without the column defaults to avco — spec:1214's recommendation", async () => {
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ costing_method: string }[]>`select costing_method from app.company where id = ${s.company}`);
    // The line the owner's answer flips (OD-06). PRINTED, because the owner's Verify step above promises
    // `default costing_method: avco` in the output and a green run with no figure verifies nothing.
    // eslint-disable-next-line no-console -- allowed nowhere in src; this is a test file, outside the lint ROOTS
    console.log(`default costing_method: ${row!.costing_method}`);
    expect(row!.costing_method).toBe("avco");
  });

  it("the CHECK admits exactly avco and fifo", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.company set costing_method = 'lifo' where id = ${s.company}`,
    )).rejects.toThrow(/company_costing_method_check/);

    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.company set costing_method = 'fifo' where id = ${s.company}`);
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.company set costing_method = 'avco' where id = ${s.company}`);
  });

  it("loadSnapshot reads the column rather than hard-coding avco (contracts §4.3.1's stub list)", async () => {
    const documentId = await draftDocument(db, s);
    const avco = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, documentId));
    expect(avco.company.costingMethod).toBe("avco");

    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.company set costing_method = 'fifo' where id = ${s.company}`);
    const fifo = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, documentId));
    expect(fifo.company.costingMethod).toBe("fifo");

    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.company set costing_method = 'avco' where id = ${s.company}`);
  });

  it("the schema linter still reports zero violations after 0035", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- test/costing/method.test.ts`
Expected: **FAIL** with `column "costing_method" does not exist` on the first case, and the `loadSnapshot` case failing with `expected "avco" to be "fifo"` — 2A's `load.ts` hard-codes `costingMethod: "avco"` with the comment "3B adds company.costing_method; OD-06's default until then".

- [ ] **Step 3: Write `packages/db/migrations/0035_alter_company_add_costing_method.sql`**

```sql
-- ── 0035. The company's costing method ──────────────────────────────────────────────
-- contracts §4.7.3, last line, verbatim. spec:1214: "v1 costing method: weighted average (AVCO),
-- matching the old system and the business's expectations. ⚠️ Owner to confirm. FIFO is supported by the
-- same layer model … and can be enabled per company later without a schema change."
--
-- OD-06 (contracts §2.12) is the owner's confirmation of the DEFAULT below. Both labels are admitted
-- whatever the answer, because both are implemented (packages/domain/src/costing/engine.ts) — the answer
-- decides which one a newly seeded company starts on.
--
-- A text column with a CHECK rather than a Postgres enum: contracts §3.2's Enumerations rule, and §3.4.4's
-- gotcha — an enum label cannot be referenced in the migration that adds it, and this file's own `default`
-- references the label.
alter table app.company
  add column costing_method text not null default 'avco'
    constraint company_costing_method_check check (costing_method in ('avco', 'fifo'));
-- The constraint is named explicitly, not left to Postgres's generated name, for the reason contracts §4.3.4
-- names for document_line_kind_check: a later slice that widens or drops it must be able to name it, and a
-- generated name is not a contract.
```

- [ ] **Step 4: Write `packages/db/migrations/0035.down.sql`**

```sql
-- Drops ONLY the column this file added. app.company is a migration-0001 table and the reversibility test
-- (contracts §3.4.5) requires that a later migration's down never drop a 0001 table.
alter table app.company drop column if exists costing_method;
```

- [ ] **Step 5: Add the column to the Drizzle mirror and read it in `loadSnapshot`**

In `packages/db/src/schema/company.ts`, add to the `company` table definition:

```ts
  costingMethod: text("costing_method").notNull(),
```

In `packages/db/src/posting/load.ts`, the header query already selects from `app.company` (2A joins it for `base_currency` and `fx_rounding_account_id`). Add `c.costing_method` to that select list and to the row interface, then replace the hard-coded literal:

```ts
    company: {
      id: h.company_id,
      baseCurrency,
      fxRoundingAccountId: h.fx_rounding_account_id,
      costingMethod: h.costing_method as "avco" | "fifo",     // 3B / migration 0035 — the last 2A stub (contracts §4.3.1)
    },
```

The cast is safe and is the same shape 2A used for `h.status` and `h.party_kind`: the column's CHECK is the guarantee, and `parsePolicy`-style runtime re-validation of a two-label CHECK would be noise.

- [ ] **Step 6: Write `tests/regression/legacy-055.test.ts`**

Contracts §3.7.3 names **3B as this file's creator** (amendment A13) and 7B as its appender, because the conditional work — the FIFO layer path — is this slice's.

**This is a plain `describe`, not a `thinRegression` call, and the same decision governs the fourteen new files and two appended blocks Task 13 writes.** §3.7.3's rule is about the *title* — `describe("LEGACY-NNN <Part I heading> — <slice id>", …)` — and about never editing an earlier block. 0B's `thinRegression(legacyDefect, heading, cites: string, body)` wraps a **single `it`** and invokes the body inside it (0b:5317–5326), which is the right shape for the twenty-one one-assertion files 0B created and the wrong shape for a costing file with two or more cases: a `test` declared inside a running `test` is a Vitest error, not a failed assertion. So this slice writes the `describe` itself, exactly as 2A did when it appended to 0B's `legacy-013` (2a:4664), and cites the first-proving file in the case titles:

```ts
import { describe, expect, it } from "vitest";
import { costingEngine, Money, Quantity, currency, type Layer } from "@dulja/domain";

const MYR = currency("MYR");
const layer = (id: string, qty: string, unitCost: string, seq: number, date: string): Layer => ({
  id, itemId: "item-1", warehouseId: "wh-1", lotId: "lot-1", movementId: `mv-${id}`,
  qtyIn: Quantity.of(qty), unitCost: Money.of(unitCost, MYR), qtyRemaining: Quantity.of(qty),
  effectiveDate: date, postingSeq: BigInt(seq), lineNo: 1, movementNo: 1,
});

describe("LEGACY-055 procMatStorage (FIFO stock ageing) is non-functional — 3B", () => {
  it("the FIFO carry-forward happens on every layer and the walk is a total function (first proven by packages/domain/test/costing/engine.test.ts)", () => {
      // The defect: `if ((Material is not null) or (Material <> aMat)) then aRemain = 0;` — OR where AND was
      // meant, so from the second row onward the condition was always true and `aRemain` reset every
      // iteration. The carry-forward never happened. Separately `aCount` was declared, never initialised,
      // used as `select skip (:aCount)` — NULL forever.
      //
      // The new system has no carry-forward variable to reset and no skip counter: FIFO is one forward pass
      // over layers the engine itself has ordered by the contracts §4.3.5 key, and the residue is the
      // layer's own `qty_remaining` column, which is a stored fact rather than a loop variable.
      const layers = [
        layer("OLDEST", "3.000000", "1.0000", 1, "2026-01-01"),
        layer("MIDDLE", "3.000000", "2.0000", 2, "2026-01-02"),
        layer("NEWEST", "3.000000", "3.0000", 3, "2026-01-03"),
      ];
      const out = costingEngine.cost({
        method: "fifo", openLayers: layers, allowShortfall: false,
        movement: {
          lineNo: 1, movementNo: 1, itemId: "item-1", warehouseId: "wh-1", lotId: "lot-1",
          quantity: Quantity.of("8.000000"), effect: "issue", value: null, costing: "consume_layers",
          effectiveDate: "2026-02-01", postingSeq: 10n, movementId: "mv-issue",
        },
      });
      // every layer visited, in age order, and the carry-forward reached the third
      expect(out.consumptions.map((c) => [c.layerId, c.quantity.toString()])).toEqual([
        ["OLDEST", "3.000000"], ["MIDDLE", "3.000000"], ["NEWEST", "2.000000"],
      ]);
      expect(out.consumptions.reduce((a, c) => a.add(c.quantity), Quantity.zero()).toString()).toBe("8.000000");
      expect(out.value.toString()).toBe("15.0000");            // 3×1 + 3×2 + 2×3
      // and the input was not mutated — the residue lives on the row, not in a loop variable
      expect(layers[0]!.qtyRemaining.toString()).toBe("3.000000");
  });

  it("a company can be switched to FIFO with no schema change (spec:1214)", () => {
    // The switch is a column value, and both methods read the same tables. This asserts the two methods
    // are genuinely different answers over identical layers, so the column is not decoration.
    const two = [
      layer("A", "100.000000", "10.0000", 1, "2026-01-10"),
      layer("B", "100.000000", "20.0000", 2, "2026-01-20"),
    ];
    const movement = {
      lineNo: 1, movementNo: 1, itemId: "item-1", warehouseId: "wh-1", lotId: "lot-1",
      quantity: Quantity.of("150.000000"), effect: "issue" as const, value: null,
      costing: "consume_layers" as const, effectiveDate: "2026-02-01", postingSeq: 10n, movementId: "mv-i",
    };
    expect(costingEngine.cost({ method: "fifo", openLayers: two, allowShortfall: false, movement }).value.toString()).toBe("2000.0000");
    expect(costingEngine.cost({ method: "avco", openLayers: two, allowShortfall: false, movement }).value.toString()).toBe("2250.0000");
  });
});
```

Both cases are pure — no database, no `sharedDb()`, no container — which is the other reason this file needs no wrapper: it asserts the engine, and 7B's appended block will bring its own `describe` for the stock-ageing report.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/costing/method.test.ts`
Expected: **PASS**, all four cases.

Run: `bun run --cwd tests test -- regression/legacy-055.test.ts`
Expected: **PASS**, both cases.

Run: `bun run --cwd packages/db test -- test/privileges.test.ts && bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS. The reversibility test now applies and rolls back 0034 and 0035; if it fails on the `schemaFingerprint` comparison, 0035's down file dropped more than the one column.

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0035_alter_company_add_costing_method.sql packages/db/migrations/0035.down.sql \
        packages/db/src/schema/company.ts packages/db/src/posting/load.ts packages/db/test/costing/method.test.ts \
        tests/regression/legacy-055.test.ts
git commit -m "$(cat <<'EOF'
feat(db): company.costing_method, defaulting to avco [3B T4]

Owner decision OD-06 (contracts §2.12; spec:1214). The default written into
migration 0035 is 'avco', which is the spec's own recommendation, and both
labels are admitted because both are implemented. The owner's answer changes one
literal in this one file: no schema change, no other task (spec:1214 — "can be
enabled per company later without a schema change").

loadSnapshot now reads the column instead of hard-coding "avco", closing the
last of the four fields 2A left stubbed for a named later slice.

tests/regression/legacy-055.test.ts is created here, not by 7B: contracts §3.7.3's
rule is that a conditional file's creator is the slice that owns the conditional
work, and the FIFO layer path is this slice's. 7B appends the stock-ageing
report's own block.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `role: "cost"` — a cost is a base-currency amount at rate 1

**Files:**
- Modify: `packages/domain/src/posting/evaluate.ts`, `packages/db/src/posting/load.ts`, `packages/db/src/posting/post.ts`
- Test: `packages/domain/test/posting/evaluate.test.ts` (append), `packages/db/test/posting/cost-lines.test.ts`

**Interfaces:**
- Consumes: `Money`, `toBase`, `CurrencyCode` (contracts §4.2.1); `PlannedLedgerLine`, `DocumentSnapshot`, `LineSnapshot`, `evaluatePolicy`, `balanceInBase` (contracts §4.4.2, 2A); `postDocument`, `loadSnapshot`, `insertLedger` (contracts §4.3.1, 1A); `seedDocumentType`, `seedParty`, `seedTenantV2`, `seedAccount`, `grantCodes`, `seedCurrency`, `seedRate` (contracts §4.17).
- Produces:

```ts
// packages/domain/src/posting/evaluate.ts — the union widens by one member
export interface PlannedLedgerLine {
  lineNo: number; accountId: string; side: "debit" | "credit"; amount: Money; base: Money;
  dimensions: Record<string, string>; sourceLineNo: number | null;
  role: "policy" | "fx_rounding" | "cost";           // 3B — amendment A4
}
/** The two amount references whose value is a COST, and therefore already in base currency. */
export const COST_AMOUNT_REFS: ReadonlySet<string>;   // { "line.cost", "line.variance_value" }
```

**Read this before touching anything — it is the reasoning, and the reasoning is the whole task.** A cost layer's `unit_cost` outlives the exchange rate of the document that created it: §4.7.3 declares `inventory_movement.value` "base currency" and a layer's cost is arithmetic over movement values. So `document_line.cost` is **base currency**, and it is the only money column on `document_line` that is.

2A built the snapshot field as `Money.of(r.cost, docCurrency)` (2a:2185), and that is wrong in both readings. Read as document currency, a USD invoice's COGS gets converted at the *sales* rate, so the base COGS of goods that cost MYR 100 depends on what the dollar did that morning — the trial balance then moves when nothing about the goods did. Read as base currency without any other change, `push` calls `toBase(amount, snapshot.header.exchangeRate)` and `toBase` throws `ERR_MONEY_CURRENCY_MISMATCH` because `value.currency ≠ rate.from` (contracts §4.2.1).

The fix is three one-expression edits and it must be **the evaluator** that tags the line, not `applyMovements`: 3D's `line.variance_value` lines and every reversal or re-post of an *already costed* document carry a non-null `cost` and never pass through `applyMovements` at all, so tagging in the hook would leave exactly those lines at the wrong rate.

- [ ] **Step 1: Write the failing test `packages/db/test/posting/cost-lines.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// `loadSnapshot` comes from the RELATIVE barrel beside `postDocument`, never from `@dulja/db`: 0B's
// `dependency-rule` pins `"packages/db": ["@dulja/domain"]` and finds a file's owner by the path prefix
// `packages/db/` with no `test/` exclusion (0b:5052, 0b:5091), so a self-import is a violation here — and a
// dynamic `await import("@dulja/db")` merely escapes the rule's IMPORT regex rather than satisfying it.
// 1A's own loader suite spells it this way (1a:2079).
import { loadSnapshot, postDocument } from "../../src/posting";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import {
  draftDocument, grantCodes, seedAccount, seedCurrency, seedDocumentType, seedRate, seedTenantV2, type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/**
 * A policy with no inventory effect whose two legs both address `line.cost`. This is the shape a sales
 * policy's COGS/inventory pair has, minus the movements — so it exercises the currency and rate of a cost
 * line without needing applyMovements, which Task 6 adds.
 */
const COST_ONLY_POLICY = (cogsCode: string, inventoryCode: string) => ({
  version: 1,
  documentType: "POLICY_TEST",
  direction: "internal",
  requires: [],
  lines: [
    { for: "each_line", side: "debit", account: { code: cogsCode }, amount: "line.cost", when: { "line.kind": "item" } },
    { for: "each_line", side: "credit", account: { code: inventoryCode }, amount: "line.cost", when: { "line.kind": "item" } },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "PT", assignAt: "issue" },
  reversal: { allowed: true, producesType: "POLICY_TEST" },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
});

describe("a cost line is a base-currency amount at rate 1 (amendment A4; contracts §4.7.3)", () => {
  let db: Db; let s: Seed; let typeId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "CostLines");
    await grantCodes(db, s, { codes: ["accounting.journal.post", "accounting.journal.create"] });
    await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, s, { code: "5000", nameEn: "Cost of goods sold", type: "expense" });
    await seedCurrency(db, s, { code: "USD" });
    await seedRate(db, s, { from: "USD", to: "MYR", on: "2026-01-01", rate: "4.68000000" });
    typeId = await seedDocumentType(db, s, { code: "POLICY_TEST", policy: COST_ONLY_POLICY("5000", "1300") });
  });
  afterAll(async () => { await db.stop(); });

  /** A USD document with one item line whose cost is already computed — MYR 468.0000 of goods. */
  async function usdDocumentWithCost(): Promise<string> {
    const documentId = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date, currency, exchange_rate, branch_id)
               values (${documentId}, ${s.tenant}, ${s.company}, ${typeId}, 'PT', ${s.period}, '2026-01-15', 'USD', '4.68000000', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, amount, cost)
               values (${s.tenant}, ${s.company}, ${documentId}, 1, 'item', '100.0000', '468.0000')`;
    });
    return documentId;
  }

  it("the cost legs are written in MYR at rate 1, and the document still balances in base", async () => {
    const documentId = await usdDocumentWithCost();
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    await prodWithTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId }));

    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{
      code: string; currency: string; exchange_rate: string; debit: string; credit: string; base_debit: string; base_credit: string;
    }[]>`
      select a.code, l.currency, l.exchange_rate::text, l.debit::text, l.credit::text,
             l.base_debit::text, l.base_credit::text
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${documentId} order by a.code`);

    expect(rows).toEqual([
      { code: "1300", currency: "MYR", exchange_rate: "1.00000000", debit: "0.0000", credit: "468.0000", base_debit: "0.0000", base_credit: "468.0000" },
      { code: "5000", currency: "MYR", exchange_rate: "1.00000000", debit: "468.0000", credit: "0.0000", base_debit: "468.0000", base_credit: "0.0000" },
    ]);
  });

  it("the base COGS does not move when the document's exchange rate does", async () => {
    // The same goods, the same MYR 468.0000 cost, a document at a different USD rate. If the cost were
    // converted at the header rate the base figure would differ, and the trial balance would move because
    // of a currency the goods never touched.
    const documentId = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date, currency, exchange_rate, branch_id)
               values (${documentId}, ${s.tenant}, ${s.company}, ${typeId}, 'PT', ${s.period}, '2026-01-16', 'USD', '5.00000000', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, amount, cost)
               values (${s.tenant}, ${s.company}, ${documentId}, 1, 'item', '100.0000', '468.0000')`;
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    await prodWithTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId }));

    const [cogs] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ base_debit: string }[]>`
      select l.base_debit::text from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${documentId} and a.code = '5000'`);
    expect(cogs!.base_debit).toBe("468.0000");
  });

  it("loadSnapshot returns the cost in the company's BASE currency", async () => {
    const documentId = await usdDocumentWithCost();
    const snapshot = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, documentId));
    expect(snapshot.header.currency).toBe("USD");
    expect(snapshot.lines[0]!.cost!.currency).toBe("MYR");
    expect(snapshot.lines[0]!.cost!.toString()).toBe("468.0000");
    expect(snapshot.lines[0]!.amount.currency).toBe("USD");
  });
});
```

- [ ] **Step 2: Append the evaluator cases to `packages/domain/test/posting/evaluate.test.ts`**

```ts
describe("a cost amount reference is tagged role: \"cost\" and never converted (amendment A4)", () => {
  it("tags the line and copies the amount into base rather than calling toBase", () => {
    const policy = parsePolicy({
      ...JOURNAL_SHAPED,
      lines: [
        { for: "each_line", side: "debit", account: { code: "5000" }, amount: "line.cost", when: { "line.kind": "item" } },
        { for: "each_line", side: "credit", account: { code: "1300" }, amount: "line.cost", when: { "line.kind": "item" } },
      ],
    });
    // A USD document at 4.68 whose line already carries a MYR cost.
    const s = snapshotWith({
      currency: "USD", rate: "4.68000000",
      lines: [{ lineNo: 1, kind: "item", amount: Money.of("100.0000", currency("USD")), cost: Money.of("468.0000", currency("MYR")) }],
    });
    const plan = evaluatePolicy(policy, s);
    expect(plan.ledgerLines.map((l) => [l.role, l.side, l.amount.toString(), l.amount.currency, l.base.toString()])).toEqual([
      ["cost", "debit", "468.0000", "MYR", "468.0000"],
      ["cost", "credit", "468.0000", "MYR", "468.0000"],
    ]);
  });

  it("a null cost still emits at zero, in BASE currency, and still warns once per source line (A5 unchanged)", () => {
    const policy = parsePolicy({
      ...JOURNAL_SHAPED,
      lines: [
        { for: "each_line", side: "debit", account: { code: "5000" }, amount: "line.cost", when: { "line.kind": "item" } },
        { for: "each_line", side: "credit", account: { code: "1300" }, amount: "line.cost", when: { "line.kind": "item" } },
      ],
    });
    const s = snapshotWith({
      currency: "USD", rate: "4.68000000",
      lines: [{ lineNo: 1, kind: "item", amount: Money.of("100.0000", currency("USD")), cost: null }],
    });
    const plan = evaluatePolicy(policy, s);
    expect(plan.ledgerLines).toHaveLength(2);
    expect(plan.ledgerLines.every((l) => l.role === "cost" && l.amount.isZero() && l.amount.currency === "MYR")).toBe(true);
    expect(plan.warnings).toEqual(["line 1: cost is not yet computed; the costing engine fills it at post"]);
  });

  it("a non-cost reference is untouched — still role: \"policy\", still converted at the header rate", () => {
    const policy = parsePolicy({
      ...JOURNAL_SHAPED,
      lines: [{ for: "each_line", side: "debit", account: { code: "5000" }, amount: "line.amount", when: { "line.kind": "item" } }],
    });
    const s = snapshotWith({
      currency: "USD", rate: "4.68000000",
      lines: [{ lineNo: 1, kind: "item", amount: Money.of("100.0000", currency("USD")), cost: null }],
    });
    const [line] = evaluatePolicy(policy, s).ledgerLines;
    expect([line!.role, line!.amount.currency, line!.amount.toString(), line!.base.toString()]).toEqual(["policy", "USD", "100.0000", "468.0000"]);
  });
});
```

`JOURNAL_SHAPED` and `snapshotWith` are the two helpers 2A's `evaluate.test.ts` already defines at the top of the file — a valid minimal policy object and a `DocumentSnapshot` factory. If `snapshotWith` does not yet accept `currency` and `rate` overrides, widen its options object additively; do not change its defaults, because 2A's own thirty cases depend on them.

- [ ] **Step 3: Run both to verify they fail**

Run: `bun run --cwd packages/domain test -- test/posting/evaluate.test.ts`
Expected: **FAIL** — the first case reports `role: "policy"` and throws `ERR_MONEY_CURRENCY_MISMATCH` from `toBase` the moment the snapshot's cost is MYR while the header is USD; the second reports `"USD"` for the zero cost's currency.

Run: `bun run --cwd packages/db test -- test/posting/cost-lines.test.ts`
Expected: **FAIL** — 2A's step-9b guard raises `ERR_POLICY_REQUIRES_MISSING` … no: the cost is *non-null* here, so the guard does not fire and the post succeeds with the wrong rate. The first case fails on `exchange_rate: "4.68000000"` where `"1.00000000"` is expected, and `base_debit: "2190.2400"` where `"468.0000"` is expected. That is the defect stated as a number.

- [ ] **Step 4: Widen the union and tag the line in `packages/domain/src/posting/evaluate.ts`**

Add the exported set near the top of the file, beside 2A's `DOCUMENT_SCOPED_ACCOUNTS`:

```ts
/**
 * The two amount references whose resolved value is a COST — and a cost is arithmetic over
 * `inventory_movement.value`, which contracts §4.7.3 declares to be in the company's BASE currency. A
 * planned line built from one of these is therefore already base: it is tagged `role: "cost"`, `base` is
 * the amount itself, and `insertLedger` writes it at exchange rate 1.00000000 exactly as it already writes
 * an `fx_rounding` line. Converting it at the document's rate would make the base COGS of a fixed quantity
 * of goods depend on what the document's currency did that morning.
 */
export const COST_AMOUNT_REFS: ReadonlySet<string> = new Set(["line.cost", "line.variance_value"]);
```

Widen the interface:

```ts
export interface PlannedLedgerLine {
  lineNo: number; accountId: string; side: "debit" | "credit"; amount: Money; base: Money;
  dimensions: Record<string, string>; sourceLineNo: number | null;
  role: "policy" | "fx_rounding" | "cost";
}
```

Inside `evaluatePolicy`, add the base-currency zero beside 2A's document-currency one:

```ts
  const zero = Money.zero(snapshot.header.currency);
  const zeroBase = Money.zero(snapshot.company.baseCurrency);   // 3B — a cost is base currency (amendment A4)
```

Replace the body of `push`:

```ts
  const push = (rule: PolicyLine, source: LineSnapshot | null, raw: Money, unresolvedCost: boolean): void => {
    if (raw.isZero() && !unresolvedCost) return;
    const { side, amount } = normalise(rule.side, raw);
    const isCost = COST_AMOUNT_REFS.has(rule.amount);
    lineNo += 1;
    ledgerLines.push({
      lineNo,
      accountId: resolveAccount(rule.account, source, snapshot),
      side,
      amount,
      // A cost is already base; everything else converts at the document's rate (spec:1816).
      base: isCost ? amount : toBase(amount, snapshot.header.exchangeRate),
      dimensions: dimensionsFor(rule, source, snapshot),
      sourceLineNo: source?.lineNo ?? null,
      role: isCost ? "cost" : "policy",
    });
  };
```

And in the `each_line` branch, the unresolved-cost call passes the base zero — `lineAmount` returns `null` for `line.cost` and `line.variance_value` and for nothing else, so this call site is always a cost reference:

```ts
          push(rule, line, zeroBase, true);
```

The `each_tax` branch and the `document`-scoped branch are **unchanged**: `amount: "tax.amount"` and every `document.*` reference is outside `COST_AMOUNT_REFS`, so their `toBase` calls stand exactly as 2A wrote them.

- [ ] **Step 5: Build the snapshot field in base currency in `packages/db/src/posting/load.ts`**

One expression. `baseCurrency` is already in scope — 2A reads it from the company join for `Money.zero(baseCurrency)` and `DocumentSnapshot["company"]["baseCurrency"]`:

```ts
    // 3B / amendment A4: cost is BASE currency, matching inventory_movement.value (contracts §4.7.3).
    // null ≠ zero, still — amendment A5 depends on the distinction.
    cost: r.cost === null ? null : Money.of(r.cost, baseCurrency),
```

- [ ] **Step 6: Widen `insertLedger`'s base-currency branch in `packages/db/src/posting/post.ts`**

1A wrote `const isFx = line.role === "fx_rounding";` and used it to choose the line's currency and rate. Replace that one line and rename the variable so the next reader is not misled:

```ts
    // An fx_rounding line (1A) and a cost line (3B) are both BASE-currency lines at rate 1: the first because
    // it absorbs a base rounding residue (spec:1868), the second because a cost layer's unit_cost is base by
    // construction (contracts §4.7.3). A policy line carries the document's currency and the header rate.
    // Both satisfy base_* = round(value * rate, 4) by construction, which is the ledger_entry CHECK.
    const isBase = line.role !== "policy";
    const lineCurrency = isBase ? snapshot.company.baseCurrency : snapshot.header.currency;
    const rate = isBase ? "1.00000000" : snapshot.header.exchangeRate.rate;
```

Every later use of `isFx` in that function body becomes `isBase`. There are no other uses in 1A's text; if your head has one, it is 2A's or 2C's and the rename applies to it too.

- [ ] **Step 7: Run everything to verify it passes**

Run: `bun run --cwd packages/domain test -- test/posting/evaluate.test.ts`
Expected: **PASS**, 2A's cases plus three.

Run: `bun run --cwd packages/db test -- test/posting`
Expected: **PASS** — `cost-lines.test.ts`'s three cases plus 1A's and 2A's whole posting suite. A JOURNAL policy addresses `line.debit`/`line.credit`, which are not cost references, so nothing 1A asserted moves.

Run: `bun run --cwd tests test && bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS. The root `tests/` tier matters here: 1B's `postJournal` posts through the real `postDocument`, and if any invariant suite asserted `role === "policy"` on every line it would now see `"cost"` — none does at this head, but run it before committing rather than after.

- [ ] **Step 8: Commit**

```bash
git add packages/domain/src/posting/evaluate.ts packages/domain/test/posting/evaluate.test.ts \
        packages/db/src/posting/load.ts packages/db/src/posting/post.ts packages/db/test/posting/cost-lines.test.ts
git commit -m "$(cat <<'EOF'
feat(domain): a cost is a base-currency amount at rate 1 [3B T5]

Amendment A4. A cost layer's unit_cost outlives the exchange rate of the
document that created it — contracts §4.7.3 declares inventory_movement.value
base currency — so document_line.cost and LineSnapshot.cost are base currency,
and a planned line built from line.cost or line.variance_value is tagged
role: "cost" with base = amount and no toBase call.

Three one-expression edits: the evaluator tags and skips the conversion,
loadSnapshot builds the field with baseCurrency instead of the document's, and
insertLedger's isFx branch widens to `role !== "policy"` so a cost line is
written in base at rate 1.00000000 exactly as an fx_rounding line already is.

The evaluator does the tagging, not applyMovements: 3D's line.variance_value
lines and every reversal of an already-costed document carry a non-null cost and
never reach the hook.

Proof is a number — the same goods at two USD rates book the same MYR 468.0000
of COGS.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `postInventoryDocument`, the recording `JobClient`, and acceptance test 1 through an inventory-bearing document

**Files:**
- Create: `tests/invariants/support/post-inventory.ts`
- Modify: `tests/invariants/ledger-balance.test.ts` (append one `describe` block; never edit 1A's or 1B's blocks)
- Test: `tests/invariants/ledger-balance.test.ts`

**Interfaces:**
- Consumes: `postDocument`, `PostResult` (contracts §4.3.1, 1A); `recordOverride` and `OverrideCode` (§4.3.1, 2B); the **production** `withTenant(sql, ctx, fn)` and `TenantContext` (§4.2.2 — root `tests/` always uses the production one, hazard 15); `startDb`, `Db`, `Seed`, `uuidv7` (§4.1); `seedTenantV2`, `seedAccount`, `seedDocumentType`, `grantCodes(db, s, { codes?, principalId?, roleCode? })`, `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot` (§4.17); `JobClient`, `JobEnvelope`, `EnqueueOptions`, `JobName`, `JobPayload` (§4.2.6); `Money`, `currency` (§4.2.1); `app.assert_override_authorised` and `app.principal_has` as *behaviour* (§4.5.3, 2B) — `postOverriddenIssue` is shaped by their two refusal clauses.
- Produces (amendment A11, registered in contracts §4.17.1):

```ts
// tests/invariants/support/post-inventory.ts
export interface InventoryLine {
  itemId: string;
  warehouseId: string;
  /** A MAGNITUDE at 6 dp. Direction comes from the policy's `inventory.effect`, never from a sign (3A assumption 2). */
  quantity: string;
  /** Document currency, 4 dp. `applyMovements` derives a receipt's layer value from it; an issue ignores it. */
  unitPrice: string;
  lotId?: string | null;
  unitId?: string;
  accountId?: string | null;
}
export interface PostInventoryOptions {
  readonly documentTypeId: string;
  readonly lines: readonly InventoryLine[];
  readonly effectiveDate?: string;          // default "2026-02-01"
  readonly warehouseId?: string | null;     // the header default; a line's own wins
  readonly toWarehouseId?: string | null;
  readonly currency?: string;               // default the company's base
  readonly branchId?: string;               // default s.hq
  readonly jobs?: JobClient;                // amendment A5 — required for a BACK-DATED document
  readonly actorId?: string;                // default s.human
  /** Runs on the posting `tx` after the lines are inserted and BEFORE `postDocument`. The only place an
   *  `inventory.negative_stock.override` event can be recorded, because `assert_stock_available` fires
   *  inside `postDocument` and reads the event there (F-6, test 18). Used by Task 13's `overriddenIssue`. */
  readonly beforePost?: (tx: Sql, documentId: string) => Promise<unknown>;
}
export async function postInventoryDocument(
  db: Db, s: Seed, opts: PostInventoryOptions,
): Promise<{ documentId: string; result: PostResult }>;

/** A `JobClient` that records instead of enqueueing. Legal in the test tier only; `apps/worker/test`
 *  uses `startWorker().jobs`, which is a real pg-boss client (§4.17.1, 0D). */
export interface RecordedJob { name: JobName; payload: unknown; singletonKey: string | undefined }
export function recordingJobs(): JobClient & { readonly enqueued: readonly RecordedJob[] };

/** Twelve OPEN monthly periods for `year`, idempotently. `postInventoryDocument` calls it for the
 *  document's own year, so no caller has to remember. See the note below — this is load-bearing. */
export async function ensureOpenPeriods(db: Db, s: Seed, year: number): Promise<void>;

/** An issue the open layers cannot cover, authorised through a second principal's `override` event — the
 *  ONE way F-6 admits (§4.5.3). Consumed by Task 11's exclusion case and Task 13's `legacy-009`; it lives here
 *  rather than in either because `app.assert_override_authorised` has two clauses a caller gets wrong once
 *  each (see the doc comment on the implementation). */
export async function postOverriddenIssue(db: Db, s: Seed, opts: {
  documentTypeId: string; itemId: string; warehouseId: string; quantity: string;
  effectiveDate: string; unitPrice?: string;
}): Promise<{ documentId: string; result: PostResult; supervisorId: string }>;

/** The two policies this slice's DB-tier tests configure over 3A's registered test-only codes (amendment A14). */
export const STOCK_ISSUE_COST_POLICY: unknown;
export const STOCK_RECEIPT_COST_POLICY: unknown;
```

**`ensureOpenPeriods` is not a convenience — without it every test in this slice fails on `ERR_PERIOD_NOT_OPEN`.** Plan 0A's `seedTenant` creates exactly **three** fiscal periods and only the first is open (plan0A:1588–1591): `s.period` = 2026-01, **open**; `s.closedPeriod` = 2026-02, **closed**; `s.lockedPeriod` = 2026-03, **locked**. There is no April and no May. Costing tests need a year of dates, and `app.fiscal_period` carries an overlap constraint (plan0A:1173–1175 proves it), so the helper **reopens** 0A's three rather than inserting over them and adds months 4–12. It runs as `db.migrator` and writes a `status` column directly — legal in the test tier, and *not* a disabled invariant: `assert_period_open` still governs every post, and Task 9's closed-period case closes a period deliberately to prove it.

**`Seed` has no `baseCurrency` and no `humanSubject`** — its thirteen members are `tenant`, `system`, `human`, `company`, `period`, `closedPeriod`, `lockedPeriod`, `cash`, `sales`, `docType`, `policy`, `branchType`, `hq` (plan0A:1565–1570). The company's base currency is `'MYR'`, set by `seedTenant` (plan0A:1587), and the human principal's auth subject is `` `human:${s.tenant}` `` (plan0A:1585) — which is what `startApi().signToken(...)` takes. Both literals appear below rather than as invented `Seed` members; extending `Seed` would edit Plan 0A's frozen fixture (§4.1, hazard 9).

**Read this before writing it.** §4.17 assigns 3B **no** `fixtures.ts` helper and hazard 9 forbids inventing one beside the register, so this helper belongs in the test tier's own register (§4.17.1) next to 1B's `postJournal`. `postJournal` cannot stand in: it drafts a JOURNAL, whose lines are `kind = 'account'` with `debit`/`credit`, and this slice needs `kind = 'item'` lines carrying `item_id`, `warehouse_id`, `quantity` and `unit_price` — the only shape from which `evaluatePolicy` plans a `PlannedMovement` at all.

**Amendment A14 is what makes the document types legal.** 3A registers three *test-only* codes in §4.14 — `STOCK_ISSUE_TEST` (`SIT`), `STOCK_RECEIPT_TEST` (`SRT`), `STOCK_TRANSFER_TEST` (`STT`), all `module: "inventory"` — and notes that its own tests address them as `{ from: "line.account" }` over `line.debit`/`line.credit` "so amendment A5's step-9b guard never fires". **The policy is a `seedDocumentType` parameter, not part of the code's registration**, and 3B is precisely the slice that deletes that guard, so this slice configures the same two codes with a `line.cost` policy over `item.cogs_account` / `item.inventory_account`. **No new document-type code appears in this slice besides `COST_ADJUSTMENT`** (Task 8) — that constraint is unchanged.

- [ ] **Step 1: Append the failing block to `tests/invariants/ledger-balance.test.ts`**

Acceptance test 1 is 1A's (§6.1) and is re-run here over the one document shape 1A could not build: one whose ledger amounts come out of the costing engine rather than off the line.

**Two placements, not one.** Add the four `import` lines below to the file's **existing import block at the top** — `import/first` (and every shared ESLint config) flags an import after a statement, and this file opens with 1A's imports followed by its `describe`, so appending the imports with the block would turn `bun run lint` red even though ES module hoisting makes it run. Then append the `describe` block itself at the **end** of the file, after 1A's and 1B's blocks, editing neither.

```ts
// ── to the import block at the TOP of the file ───────────────────────────────────────────────────
import fc from "fast-check";
import { postInventoryDocument, recordingJobs, STOCK_ISSUE_COST_POLICY, STOCK_RECEIPT_COST_POLICY } from "./support/post-inventory";
import { seedDocumentType, seedItem, seedWarehouse, grantCodes } from "@dulja/db/test";
```

`db`, `s`, `startDb`, `seedTenantV2`, `withTenant`, `uuidv7`, `describe`, `beforeAll`, `afterAll`, `it` and `expect` are already imported by 1A's block; add only what is missing.

```ts
// ── 3B: appended at the END of the file — the invariant holds when the amounts come from the
//        costing engine (test 1 re-run) ──────────────────────────────────────────────────────────
describe("LEGACY-003 ledger invariant — inventory-bearing documents (test 1 re-run, 3B)", () => {
  let db: Db; let s: Seed;
  let receiptType: string; let issueType: string;
  let itemId: string; let warehouseId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Invariant-3B");
    await grantCodes(db, s);
    receiptType = await seedDocumentType(db, s, { code: "STOCK_RECEIPT_TEST", module: "inventory", policy: STOCK_RECEIPT_COST_POLICY });
    issueType = await seedDocumentType(db, s, { code: "STOCK_ISSUE_TEST", module: "inventory", policy: STOCK_ISSUE_COST_POLICY });
    ({ itemId } = await seedItem(db, s, { code: "INV-1" }));
    warehouseId = await seedWarehouse(db, s, { code: "INV-WH" });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("Σ base debit = Σ base credit over a random receipt/issue interleaving", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            receipt: fc.boolean(),
            qty: fc.integer({ min: 1, max: 40 }),
            price: fc.integer({ min: 1, max: 9_999 }),
          }),
          { minLength: 2, maxLength: 8 },
        ),
        async (steps) => {
          const jobs = recordingJobs();
          // A receipt first, always: an issue against no layer is ERR_STOCK_INSUFFICIENT by design (Task 2),
          // which is a refusal, not an imbalance, and the property is about what DOES post.
          const script = [{ receipt: true, qty: 100, price: 1_000 }, ...steps];
          let onHand = 0;
          for (const step of script) {
            const isReceipt = step.receipt || onHand < step.qty;
            await postInventoryDocument(db, s, {
              documentTypeId: isReceipt ? receiptType : issueType,
              warehouseId,
              jobs,
              lines: [{
                itemId, warehouseId,
                quantity: `${step.qty}.000000`,
                unitPrice: `${step.price}.0000`,
              }],
            });
            onHand += isReceipt ? step.qty : -step.qty;
          }
          const [sums] = await withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) }, (tx) =>
            tx<{ d: string; c: string }[]>`
              select coalesce(sum(base_debit), 0)::text as d, coalesce(sum(base_credit), 0)::text as c
                from app.ledger_entry where company_id = ${s.company}`);
          expect(sums!.d).toBe(sums!.c);
        },
      ),
      { numRuns: 15, endOnFailure: true },
    );
  }, 600_000);

  it("every posted movement carries a non-null value and every layer a non-negative unit cost (test 6's stored-row half)", async () => {
    const bad = await withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) }, (tx) =>
      tx<{ movements: number; layers: number }[]>`
        select (select count(*)::int from app.inventory_movement where value is null) as movements,
               (select count(*)::int from app.cost_layer where unit_cost < 0 or qty_remaining < 0) as layers`);
    expect(bad[0]).toEqual({ movements: 0, layers: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd tests test -- invariants/ledger-balance.test.ts`
Expected: **FAIL** with `Cannot find module './support/post-inventory'`. If instead it fails with `postInventoryDocument is not a function`, 3A landed the file first — go to Step 4 and verify rather than write.

- [ ] **Step 3: Write `tests/invariants/support/post-inventory.ts`**

```ts
import { postDocument, recordOverride, withTenant, type PostResult, type TenantContext } from "@dulja/db";
import { grantCodes, uuidv7, type Db, type Seed } from "@dulja/db/test";
import type { EnqueueOptions, JobClient, JobEnvelope, JobName, JobPayload } from "@dulja/db";
import type { Sql } from "postgres";

export interface InventoryLine {
  itemId: string;
  warehouseId: string;
  /** A MAGNITUDE at 6 dp — the policy's `inventory.effect` carries the direction (3A assumption 2). */
  quantity: string;
  unitPrice: string;
  lotId?: string | null;
  unitId?: string;
  accountId?: string | null;
}

export interface PostInventoryOptions {
  readonly documentTypeId: string;
  readonly lines: readonly InventoryLine[];
  readonly effectiveDate?: string;
  readonly warehouseId?: string | null;
  readonly toWarehouseId?: string | null;
  readonly currency?: string;
  readonly branchId?: string;
  readonly jobs?: JobClient;
  readonly actorId?: string;
  readonly beforePost?: (tx: Sql, documentId: string) => Promise<unknown>;
}

export interface RecordedJob { name: JobName; payload: unknown; singletonKey: string | undefined }

/**
 * Records instead of enqueueing. `postDocument`'s step 14 needs a `JobClient` (amendment A5) and a
 * Testcontainers database has no pg-boss installation, so a DB-tier test hands it this. `apps/worker`
 * tests use `startWorker().jobs`, which is real (§4.17.1).
 */
export function recordingJobs(): JobClient & { readonly enqueued: readonly RecordedJob[] } {
  const enqueued: RecordedJob[] = [];
  return {
    enqueued,
    async enqueue<N extends JobName>(_tx: Sql, name: N, job: JobEnvelope<JobPayload[N]>, opts?: EnqueueOptions) {
      const id = `recorded-${enqueued.length + 1}`;
      enqueued.push({ name, payload: job.payload, singletonKey: opts?.singletonKey });
      return id;
    },
  };
}

/**
 * Twelve OPEN monthly periods for `year`. Plan 0A's `seedTenant` gives 2026-01 open, 2026-02 closed and
 * 2026-03 locked and nothing after (plan0A:1588-1591), and `app.fiscal_period` refuses an overlapping row,
 * so this REOPENS those three and inserts months 4-12. Idempotent, so every call site may call it.
 */
export async function ensureOpenPeriods(db: Db, s: Seed, year: number): Promise<void> {
  await withTenant(db.migrator, { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) }, async (tx) => {
    await tx`
      update app.fiscal_period set status = 'open'
       where company_id = ${s.company} and status <> 'open'
         and extract(year from starts_on) = ${year}`;
    for (let month = 1; month <= 12; month += 1) {
      const starts = `${year}-${String(month).padStart(2, "0")}-01`;
      await tx`
        insert into app.fiscal_period (tenant_id, company_id, starts_on, ends_on, status)
        select ${s.tenant}, ${s.company}, ${starts}::date,
               (${starts}::date + interval '1 month' - interval '1 day')::date, 'open'
         where not exists (
           select 1 from app.fiscal_period
            where company_id = ${s.company}
              and starts_on <= (${starts}::date + interval '1 month' - interval '1 day')::date
              and ends_on   >= ${starts}::date)`;
    }
  });
}

/**
 * Drafts an item-line document and posts it through the REAL `postDocument` — the only way a test in this
 * tier creates movements, layers or ledger rows (§4.17.1's rule for `postJournal`, applied to inventory).
 *
 * The insert list is `document_line`'s 1A base plus 2A's and 3A's additions (§4.3.4): `kind = 'item'`,
 * `item_id`, `quantity`, `unit_price`, `amount`, `warehouse_id`, `lot_id`, `unit_id`, `unit_quantity`.
 * `cost` is left NULL deliberately — filling it here would bypass the very hook under test.
 */
export async function postInventoryDocument(
  db: Db, s: Seed, opts: PostInventoryOptions,
): Promise<{ documentId: string; result: PostResult }> {
  const effectiveDate = opts.effectiveDate ?? "2026-02-01";
  await ensureOpenPeriods(db, s, Number(effectiveDate.slice(0, 4)));
  const ctx: TenantContext = {
    tenantId: s.tenant,
    actorId: opts.actorId ?? s.human,
    requestId: await uuidv7(db.admin),
  };
  return withTenant(db.rw, ctx, async (tx) => {
    const [header] = await tx<{ id: string }[]>`
      insert into app.document
        (tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id, warehouse_id, to_warehouse_id)
      values (${s.tenant}, ${s.company}, ${opts.documentTypeId}, 'TMP',
              ${effectiveDate}, ${opts.currency ?? "MYR"},
              ${opts.branchId ?? s.hq}, ${opts.warehouseId ?? null}, ${opts.toWarehouseId ?? null})
      returning id::text as id`;
    const documentId = header!.id;

    let lineNo = 0;
    for (const line of opts.lines) {
      lineNo += 1;
      // amount = round(quantity × unit_price, 4) in DOCUMENT currency, computed by Postgres so no JavaScript
      // number touches money (`no-number-money`, §3.7.5). `cost` stays NULL — step 9 fills it.
      await tx`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, item_id, quantity, unit_price, amount,
           warehouse_id, lot_id, unit_id, unit_quantity, account_id, description)
        values (${s.tenant}, ${s.company}, ${documentId}, ${lineNo}, 'item', ${line.itemId},
                ${line.quantity}, ${line.unitPrice},
                round(${line.quantity}::numeric * ${line.unitPrice}::numeric, 4),
                ${line.warehouseId}, ${line.lotId ?? null}, ${line.unitId ?? null}, ${line.quantity},
                ${line.accountId ?? null}, ${`3B fixture line ${lineNo}`})`;
    }

    if (opts.beforePost) await opts.beforePost(tx, documentId);
    const result = await postDocument(tx, ctx, { documentId, jobs: opts.jobs });
    return { documentId, result };
  });
}

/** A second human principal in this tenant, created once per `(tenant, label)`. R8 (spec:2179) needs one:
 *  an override is a fact about a principal who is not the document's creator. */
async function secondPrincipal(db: Db, s: Seed, label: string): Promise<string> {
  const subject = `human:${label}:${s.tenant}`;
  const [existing] = await withTenant(db.migrator, { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
    (tx) => tx<{ id: string }[]>`select id::text as id from app.principal where auth_subject = ${subject}`);
  if (existing) return existing.id;
  const id = await uuidv7(db.admin);
  await withTenant(db.migrator, { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) }, async (tx) => {
    await tx`insert into app.principal (id, kind, auth_subject, display_name)
             values (${id}, 'human', ${subject}, ${label})`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
  });
  return id;
}

/**
 * An issue the open layers cannot cover, authorised the ONLY way F-6 admits: an `override` `document_event`
 * on the document, before it posts. **Three facts about `app.assert_override_authorised` (§4.5.3) determine
 * every line here, and each one refuses the obvious shape:**
 *
 * 1. The guard resolves `p := coalesce(new.attributed_to, new.actor_id)` and raises
 *    `ERR_OVERRIDE_NOT_AUTHORISED` when `p = document.created_by`. So the *document* is posted by `s.human`
 *    (the default) and the supervisor is the **attributed** principal — posting as the supervisor and
 *    attributing to them makes `p = created_by` and the insert is refused.
 * 2. `recordOverride` does not write `actor_id`; the column defaults to `app.current_actor()`, which inside
 *    one `withTenant` is the posting actor. A second *actor* is therefore impossible in a single
 *    transaction — which is why the second principal is the attributed one. That is exactly the shape
 *    §4.5.3 describes for POS ("attributed_to = the supervisor whose PIN authorised it").
 * 3. `app.principal_has(p, code, company, branch)` must hold for the attributed principal, so the
 *    supervisor gets its own role through `grantCodes({ principalId, roleCode })`.
 *
 * The event must exist when `app.assert_stock_available` fires, and that trigger fires *inside*
 * `postDocument` — which is the whole reason `beforePost` exists.
 */
export async function postOverriddenIssue(
  db: Db, s: Seed,
  opts: { documentTypeId: string; itemId: string; warehouseId: string; quantity: string; effectiveDate: string; unitPrice?: string },
): Promise<{ documentId: string; result: PostResult; supervisorId: string }> {
  const supervisorId = await secondPrincipal(db, s, "sup");
  await grantCodes(db, s, { codes: ["inventory.negative_stock.override"], principalId: supervisorId, roleCode: "sup" });
  const { documentId, result } = await postInventoryDocument(db, s, {
    documentTypeId: opts.documentTypeId,
    warehouseId: opts.warehouseId,
    effectiveDate: opts.effectiveDate,
    jobs: recordingJobs(),
    lines: [{
      itemId: opts.itemId, warehouseId: opts.warehouseId,
      quantity: opts.quantity, unitPrice: opts.unitPrice ?? "50.0000",
    }],
    beforePost: async (tx, id) => recordOverride(
      tx,
      { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
      {
        documentId: id, code: "inventory.negative_stock.override",
        reason: "authorised negative-stock excursion (3B fixture)", attributedTo: supervisorId,
      },
    ),
  });
  return { documentId, result, supervisorId };
}

/** The `each_line` pair every costing test needs: COGS debited and inventory credited, both at `line.cost`. */
export const STOCK_ISSUE_COST_POLICY = {
  version: 1,
  documentType: "STOCK_ISSUE_TEST",
  direction: "outbound",
  requires: [],
  lines: [
    { for: "each_line", side: "debit",  account: { from: "item.cogs_account" },      amount: "line.cost", when: { "line.kind": "item" } },
    { for: "each_line", side: "credit", account: { from: "item.inventory_account" }, amount: "line.cost", when: { "line.kind": "item" } },
  ],
  inventory: { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" },
  tax: { applies: false },
  numbering: { series: "SIT", assignAt: "issue" },
  reversal: { allowed: true, producesType: "STOCK_RECEIPT_TEST" },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as const;

/** A receipt's ledger pair is inventory debited against `line.amount`. A purchase's real credit leg is 3C's
 *  GRNI and does not exist yet, so the fixture books the other side to **`5900` other operating expense**
 *  by CODE (§4.15, seeded by 0C and re-asserted by 3A's `seedItem`). It is addressed as `account.code` and
 *  **not** as `item.expense_account`, because §4.6.1 defaults `item.expense_account_id` only for
 *  `kind ∈ service | asset` — a `product`, which every costing fixture uses, leaves it null and the policy
 *  would fail at post on an unresolvable account. The costing question is the debit. */
export const STOCK_RECEIPT_COST_POLICY = {
  version: 1,
  documentType: "STOCK_RECEIPT_TEST",
  direction: "inbound",
  requires: [],
  lines: [
    { for: "each_line", side: "debit",  account: { from: "item.inventory_account" }, amount: "line.amount", when: { "line.kind": "item" } },
    { for: "each_line", side: "credit", account: { code: "5900" },                  amount: "line.amount", when: { "line.kind": "item" } },
  ],
  inventory: { effect: "receipt", warehouse: "line.warehouse", costing: "create_layer" },
  tax: { applies: false },
  numbering: { series: "SRT", assignAt: "issue" },
  reversal: { allowed: true, producesType: "STOCK_ISSUE_TEST" },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as const;
```

**Why the receipt's layer value is `line.amount` and the issue's is `line.cost`.** A receipt *knows* what it paid — that is `quantity × unit_price` on the line, and `applyMovements` passes it to the engine as `movement.value`, which becomes the layer's `unit_cost`. An issue does not: what it costs is whatever the layers say, which is exactly what `line.cost` is filled with at step 9. The two policies differ in that one reference and nowhere else, and that difference is the whole of costing.

- [ ] **Step 4: Register the helper, or verify 3A already did (amendment A11's rule)**

Run: `git log --oneline -- tests/invariants/support/post-inventory.ts`

- **No output** — this slice is first. Add the row to contracts §4.17.1 in this PR: `postInventoryDocument(db, s, opts)` · `tests/invariants/support/post-inventory.ts` · owner "3A / 3B — whichever executes first" · returns `{ documentId, result }`.
- **Output exists** — 3A landed it. Do not rewrite the file. Instead verify, and extend **additively** if a member is missing: `opts.jobs` (3A has no step-14 path and may have omitted it), `opts.toWarehouseId`, `recordingJobs`, and the two policy consts. Adding an optional option and a new export is additive; changing an existing parameter or the return shape is not (§4.17's rule).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd tests test -- invariants/ledger-balance.test.ts`
Expected: **PASS** — 1A's and 1B's blocks plus this one's two cases. Fifteen fast-check runs of up to nine documents each is roughly 120 posts; the 600-second timeout is generous on purpose (`fileParallelism: false`, §3.7.1).

Two failures are informative rather than flaky and are worth recognising by their message:
- `ERR_POLICY_REQUIRES_MISSING: line 1: cost` means Task 7 has not landed — 2A's step-9b guard is still refusing the surviving zero-amount cost line. That is the guard doing its job; this block goes green when Task 7 replaces it.
- `ERR_MONEY_CURRENCY_MISMATCH` from `toBase` means Task 5 has not landed.

Run: `bun run --cwd tests test && bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS. `tests/` is outside every lint root (§3.7.5), so the direct `app.document_line` insert in this file draws no `posting-only-tables` violation — `document_line` is not on that rule's table list in any case.

- [ ] **Step 6: Commit**

```bash
git add tests/invariants/support/post-inventory.ts tests/invariants/ledger-balance.test.ts
git commit -m "$(cat <<'EOF'
test(invariants): postInventoryDocument and test 1 over costed documents [3B T6]

contracts §4.17.1 gains the helper amendment A11 registers, under the
seedEmployee rule: whichever of 3A/3B lands first commits it. postJournal is
JOURNAL-shaped and cannot draft an item line, and §4.17 assigns 3B no
fixtures.ts helper, so it belongs here beside postJournal.

recordingJobs is the JobClient a Testcontainers database can have: amendment
A5 makes postDocument's step 14 need one, and pg-boss is not installed there.

postOverriddenIssue is here rather than in either of its two callers because
app.assert_override_authorised refuses the obvious shape twice: the attributed
principal may not be the document's creator, and recordOverride takes actor_id
from app.current_actor(), so a second ACTOR cannot exist inside one
transaction. The supervisor is therefore the attributed principal and the
document is posted by s.human — the POS shape §4.5.3 describes.

Amendment A14: the policy a test configures through seedDocumentType is not
part of a §4.14 code's registration. 3A's STOCK_ISSUE_TEST and
STOCK_RECEIPT_TEST are reused with a line.cost policy, which is the shape step
9 exists to fill. No new document-type code.

Test 1 re-run: Σ base debit = Σ base credit over a random receipt/issue
interleaving whose amounts come out of the costing engine.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `applyMovements`'s full body, the `jobs` seam, step 9 replacing step 9b, and `invalidateFrom`

**Files:**
- Create: `packages/db/src/costing/invalidate.ts`
- Modify: `packages/db/src/costing/apply-movements.ts` (body replaced whole — the signature is untouched), `packages/db/src/costing/index.ts`, `packages/db/src/posting/post.ts`, `packages/db/src/posting/reverse.ts`, `packages/db/src/posting/index.ts`, `packages/db/src/jobs/payloads.ts`, `packages/db/src/index.ts`, `apps/api/src/context.ts`, `apps/api/src/app.ts`, `apps/api/src/routes/accounting/document.ts`, `scripts/lint/rules/dependency-rule.ts` (Step 9), `packages/db/tsconfig.json` (Step 9)
- Test: `packages/db/test/costing/apply-movements.test.ts`

**Interfaces:**
- Consumes: `costingEngine`, `CostingError`, `MIN_MEANINGFUL_QTY`, `Layer`, `Consumption`, `CostingInput`, `CostingOutput`, `CostingMethod` (Tasks 2–3); `PostingPlan`, `PlannedMovement`, `DocumentSnapshot`, `LineSnapshot` (contracts §4.4.2, 2A); `Money`, `Quantity`, `currency`, `CurrencyCode` (§4.2.1); `TenantContext` (§4.2.2); `JobClient`, `JobEnvelope`, `JobPayload`, `JobName` (§4.2.6); `PostingError`, `PostingErrorCode` (§4.2.4, widened in Task 2); `AppEnv` (§4.2.3); **3A's `loadSentinelLots(tx, itemIds: string[]): Promise<Map<string, string>>`**, the export §4.7.2's provisional body already needs — its query is `select item_id::text, id::text from app.lot where item_id = any($1) and code = 'NONE'`, one row per item (ADR 0034).
- Produces:

```ts
// packages/db/src/costing/apply-movements.ts — the SIGNATURE is 3A's and does not change (§4.7.2)
export async function applyMovements(tx: Sql, ctx: TenantContext, plan: PostingPlan, snapshot: DocumentSnapshot): Promise<PostingPlan>;
/** Every VALID open layer of one (company, item, warehouse), in §4.3.5 chronological order. The ONE reader —
 *  `applyMovements`, `replay` and `valuationAsOf` all call it, so "open layer" has one definition (spec:1228). */
export async function openLayersFor(tx: Sql, input: { companyId: string; itemId: string; warehouseId: string; baseCurrency: CurrencyCode }): Promise<Layer[]>;

// packages/db/src/costing/invalidate.ts
export async function invalidateFrom(tx: Sql, ctx: TenantContext, input: {
  companyId: string; itemIds: string[]; effectiveDate: string; postingSeq: bigint; jobs: JobClient;
}): Promise<void>;                                                   // amendment A6 — `jobs` is REQUIRED

// packages/db/src/posting/post.ts — amendment A5; `jobs` is OPTIONAL so every 1A/1B/2A/2B/2C/3A call site compiles
export async function postDocument(tx: Sql, ctx: TenantContext, input: { documentId: string; jobs?: JobClient }): Promise<PostResult>;
// packages/db/src/posting/reverse.ts — amendment A15, for the same reason one level up
export async function reverseDocument(tx: Sql, ctx: TenantContext, input: { documentId: string; effectiveDate: string; reason: string; jobs?: JobClient }): Promise<{ reversalDocumentId: string; number: bigint }>;

// apps/api/src/context.ts — the EIGHTH member (2C's seven, plus this)
export interface AppEnv { Variables: { /* … the seven 2C members … */ jobs: JobClient } }

// packages/db/src/jobs/payloads.ts — amendment A9; JOBS itself is NOT edited (0B's closed sixteen names)
export interface JobPayload extends Record<JobName, unknown> {
  /* … 1B's two keys … */
  /** Slice 3B. One job per company; `singletonKey = companyId` collapses a burst of back-dated posts into one replay. */
  "inventory.cost.replay": { companyId: string };
  /** Slice 3B. Omit both for the nightly whole-tenant rebuild; `asOf` defaults to the run date. */
  "inventory.projection.rebuild": { companyId?: string; asOf?: string };
}
```

**Read this before writing the body — four things about it are not obvious and each one is a defect if got wrong.**

1. **Compute first, write second, and write in exactly this order:** the engine call (pure, no I/O) for every movement in emission order, threading each movement's layer effect into the next; then the `inventory_movement` inserts (the BEFORE INSERT `assert_stock_available` trigger fires here, and it counts this transaction's earlier rows); then `cost_layer`, whose FK `(tenant_id, movement_id) → inventory_movement(tenant_id, id)` makes the reverse order a `23503`; then `cost_consumption`, whose FK points at both; then `document_line.cost`. `inventory_movement.value` is NOT NULL and an *issue's* value is not known until the engine has walked the layers — which is the whole reason the compute pass cannot be interleaved with the inserts.

2. **`openLayersFor` reads every valid open layer, with no date filter, and that is deliberate.** At step 9 the document being posted is the newest thing in the company (its `posting_seq` is the maximum), so "every open layer" and "every open layer at or before this key" are the same set — except for a **back-dated** document, where later layers exist. Filtering them out would let this issue consume a layer that a later, already-posted issue has already emptied, driving that layer's `qty_remaining` below zero into `cost_layer_qty_remaining_check`. The correct sequence is: post now against the layers as they stand, *then* invalidate from this document's own key forward (step 14) and let the replay recompute the whole affected tail. Post-now-replay-later is the design (spec:1220–1223); a clever date filter here is LEGACY-005's incremental mode reintroduced.

3. **Every ISSUE reaches the engine with `Money.zero(baseCurrency)` on `movement.value` — unconditionally, not just for a free-of-charge line.** Task 2's `costIssue` uses `movement.value` for exactly one thing: as the currency to answer in when there is no open layer to borrow one from. With no layers and no value it raises `ERR_COST_VALUE_MISSING`, which is right for a direct caller and wrong for two real posting paths — a free-of-charge line at zero stock (`costing === "zero"`, spec:1055) *and* an `inventory.negative_stock.override` issue against an empty layer set (`costing === "consume_layers"`, `value: null` from the evaluator; F-6, tests 7 and 18). Scoping the substitution to `costing === "zero"` would leave the authorised excursion dying on a message about a missing unit price. So the rule is one line and covers both: `const value = movement.effect === "issue" ? Money.zero(baseCurrency) : movement.value;`. It is a **substitution, not a fallback** (`??`) — an issue's planned `value` is a document-currency figure the evaluator computed from `unit_price`, and letting it through would hand the engine the *sales* currency as the currency to cost in. A receipt keeps its own value untouched: that value IS the layer's cost, and zeroing a `costing === "zero"` receipt would open every FOC receipt's layer at 0.0000. `allowShortfall` stays `movement.costing === "zero" || overridden`.

4. **`document_line.cost` is the ISSUE leg's value when a line has one.** A `transfer` line emits two movements — an issue at `warehouse_id` and a receipt at `to_warehouse_id` — and the line's cost is what left, once, not the sum of both legs. Rule: `cost` = Σ of the line's issue-movement values if the line has any issue movement, otherwise Σ of its receipt-movement values. It is a **magnitude in base currency** (Task 5).

- [ ] **Step 1: Write the failing test `packages/db/test/costing/apply-movements.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money } from "@dulja/domain";
import { openLayersFor } from "../../src/costing/apply-movements";
import {
  grantCodes, seedDocumentType, seedItem, seedLot, seedTenantV2, seedWarehouse, type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { postInventoryDocument, recordingJobs, STOCK_ISSUE_COST_POLICY, STOCK_RECEIPT_COST_POLICY }
  from "../../../../tests/invariants/support/post-inventory";

const MYR = currency("MYR");

describe("applyMovements — the full body (contracts §4.7.2; spec:1216-1226)", () => {
  let db: Db; let s: Seed; let receiptType: string; let issueType: string;
  let itemId: string; let warehouseId: string; let cogs: string; let inventory: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Apply");
    await grantCodes(db, s);
    receiptType = await seedDocumentType(db, s, { code: "STOCK_RECEIPT_TEST", module: "inventory", policy: STOCK_RECEIPT_COST_POLICY });
    issueType = await seedDocumentType(db, s, { code: "STOCK_ISSUE_TEST", module: "inventory", policy: STOCK_ISSUE_COST_POLICY });
    ({ itemId } = await seedItem(db, s, { code: "WIDGET" }));
    warehouseId = await seedWarehouse(db, s, { code: "MAIN" });
    const [accs] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ cogs: string; inv: string }[]>`
      select (select id::text from app.account where company_id = ${s.company} and code = '5000') as cogs,
             (select id::text from app.account where company_id = ${s.company} and code = '1300') as inv`);
    cogs = accs!.cogs; inventory = accs!.inv;
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("a receipt writes one movement, one layer, no consumption, and document_line.cost", async () => {
    const jobs = recordingJobs();
    const { documentId } = await postInventoryDocument(db, s, {
      documentTypeId: receiptType, warehouseId, jobs, effectiveDate: "2026-02-01",
      lines: [{ itemId, warehouseId, quantity: "100.000000", unitPrice: "10.0000" }],
    });
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{
      movements: number; value: string; layers: number; qty_in: string; unit_cost: string;
      qty_remaining: string; cons: number; cost: string; seq: string;
    }[]>`
      select (select count(*)::int from app.inventory_movement where document_id = ${documentId})  as movements,
             (select value::text  from app.inventory_movement where document_id = ${documentId})   as value,
             (select count(*)::int from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
               where m.document_id = ${documentId})                                                as layers,
             (select l.qty_in::text        from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id where m.document_id = ${documentId}) as qty_in,
             (select l.unit_cost::text     from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id where m.document_id = ${documentId}) as unit_cost,
             (select l.qty_remaining::text from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id where m.document_id = ${documentId}) as qty_remaining,
             (select count(*)::int from app.cost_consumption c join app.inventory_movement m on m.id = c.movement_id where m.document_id = ${documentId}) as cons,
             (select cost::text from app.document_line where document_id = ${documentId} and line_no = 1) as cost,
             (select l.sequence::text from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id where m.document_id = ${documentId}) as seq`);
    expect(row).toEqual({
      movements: 1, value: "1000.0000", layers: 1, qty_in: "100.000000", unit_cost: "10.0000",
      qty_remaining: "100.000000", cons: 0, cost: "1000.0000", seq: expect.any(String),
    });
  });

  it("an issue negates quantity and value, consumes the layer, and books COGS at the layer's cost", async () => {
    const jobs = recordingJobs();
    const { documentId } = await postInventoryDocument(db, s, {
      documentTypeId: issueType, warehouseId, jobs, effectiveDate: "2026-02-05",
      lines: [{ itemId, warehouseId, quantity: "30.000000", unitPrice: "25.0000" }],
    });
    const [mv] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ quantity: string; value: string }[]>`
      select quantity::text, value::text from app.inventory_movement where document_id = ${documentId}`);
    // The line's unit_price is 25 — the SALE price. Cost is the LAYER's 10, and nothing else.
    expect(mv).toEqual({ quantity: "-30.000000", value: "-300.0000" });

    const [cons] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ quantity: string; unit_cost: string; value: string }[]>`
      select c.quantity::text, c.unit_cost::text, c.value::text
        from app.cost_consumption c join app.inventory_movement m on m.id = c.movement_id
       where m.document_id = ${documentId} and c.invalidated_at is null`);
    expect(cons).toEqual({ quantity: "30.000000", unit_cost: "10.0000", value: "300.0000" });

    const ledger = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ account_id: string; debit: string; credit: string; exchange_rate: string }[]>`
      select account_id::text, debit::text, credit::text, exchange_rate::text
        from app.ledger_entry where document_id = ${documentId} order by line_no`);
    expect(ledger).toEqual([
      { account_id: cogs,      debit: "300.0000", credit: "0.0000", exchange_rate: "1.00000000" },
      { account_id: inventory, debit: "0.0000", credit: "300.0000", exchange_rate: "1.00000000" },
    ]);
  });

  it("openLayersFor returns the residue in chronological order and nothing invalidated", async () => {
    const layers = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      openLayersFor(tx, { companyId: s.company, itemId, warehouseId, baseCurrency: MYR }));
    expect(layers).toHaveLength(1);
    expect(layers[0]!.qtyRemaining.toString()).toBe("70.000000");
    expect(layers[0]!.unitCost.toString()).toBe("10.0000");
    expect(layers[0]!.lineNo).toBe(1);
    expect(layers[0]!.movementNo).toBe(1);
  });

  it("an issue the layers cannot cover is refused with ERR_STOCK_INSUFFICIENT and writes nothing", async () => {
    const jobs = recordingJobs();
    const before = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.inventory_movement where company_id = ${s.company}`);
    await expect(postInventoryDocument(db, s, {
      documentTypeId: issueType, warehouseId, jobs, effectiveDate: "2026-02-06",
      lines: [{ itemId, warehouseId, quantity: "5000.000000", unitPrice: "25.0000" }],
    })).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.inventory_movement where company_id = ${s.company}`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("a back-dated document invalidates from its own key forward and enqueues exactly one replay", async () => {
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, {
      documentTypeId: receiptType, warehouseId, jobs, effectiveDate: "2026-01-15",   // BEFORE the 2026-02-01 receipt
      lines: [{ itemId, warehouseId, quantity: "50.000000", unitPrice: "8.0000" }],
    });
    expect(jobs.enqueued).toEqual([
      { name: "inventory.cost.replay", payload: { companyId: s.company }, singletonKey: s.company },
    ]);
    const [counts] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ invalid_layers: number; valid_layers: number }[]>`
      select (select count(*)::int from app.cost_layer where company_id = ${s.company} and invalidated_at is not null) as invalid_layers,
             (select count(*)::int from app.cost_layer where company_id = ${s.company} and invalidated_at is null)     as valid_layers`);
    // The 2026-02-01 layer is at or after nothing — the back-dated key is 2026-01-15, so the February layer
    // IS at or after it and is invalidated; the January layer this document just wrote is too (its own key).
    expect(counts).toEqual({ invalid_layers: 2, valid_layers: 0 });
  });

  it("a back-dated document posted with no JobClient fail-closes rather than skipping the recost (LEGACY-005)", async () => {
    await expect(postInventoryDocument(db, s, {
      documentTypeId: receiptType, warehouseId, effectiveDate: "2026-01-10",
      lines: [{ itemId, warehouseId, quantity: "1.000000", unitPrice: "1.0000" }],
    })).rejects.toThrow(/ERR_INTERNAL.*back-dated.*no JobClient/s);
  });

  it("a forward-dated document enqueues nothing", async () => {
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, {
      documentTypeId: receiptType, warehouseId, jobs, effectiveDate: "2026-06-01",
      lines: [{ itemId, warehouseId, quantity: "1.000000", unitPrice: "1.0000" }],
    });
    expect(jobs.enqueued).toEqual([]);
  });

  it("a lot-less line resolves the item's NONE sentinel, and a second tenant sees none of it (test 12)", async () => {
    const b = await seedTenantV2(db, "Apply-B");
    const [mine] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ sentinel: number }[]>`
      select count(*)::int as sentinel from app.inventory_movement m
        join app.lot l on l.id = m.lot_id where l.code = 'NONE' and m.company_id = ${s.company}`);
    expect(mine!.sentinel).toBeGreaterThan(0);
    const [theirs] = await withTenant(db.rw, b.tenant, b.human, (tx) => tx<{ n: number }[]>`
      select (select count(*)::int from app.cost_layer) + (select count(*)::int from app.cost_consumption) as n`);
    expect(theirs!.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- test/costing/apply-movements.test.ts`
Expected: **FAIL**. The first case fails with `layers: 0, cons: 0` — 3A's provisional body writes movements and no layers. The `openLayersFor` case fails with `Cannot find module` / not exported. The back-dated cases fail with `jobs` not being a member of `postDocument`'s input (a TypeScript error, so the file does not even build) — that is the seam this task opens.

- [ ] **Step 3: Replace the body of `packages/db/src/costing/apply-movements.ts`**

3A's provisional value rule (`value = round(unit_price × quantity, 4)` for an issue as well as a receipt) is **deleted, not extended** (§4.7.2).

**Name the edits against 3A's actual file, which contains, in this order:** the import block, `loadSentinelLots`, `provisionalValue`, `readPostingSeq`, `insertMovements`, `writeLineCosts`, `applyMovements` (3a:5330–5460). So: **keep the import block and add to it** the four names below that are not already there (`costingEngine`, `CostingError`, `Layer`, `CostingMethod` — `Money`, `Quantity` and the plan/snapshot types are already imported, and `SENTINEL_LOT_CODE`, which `loadSentinelLots` needs, must stay); **keep `loadSentinelLots` verbatim**; **delete `provisionalValue`, `readPostingSeq`, `insertMovements` and `writeLineCosts`** — the new body inlines what they did and their signatures are internal, so no other file imports them; **add `openLayersFor` above `applyMovements`**; and **replace `applyMovements`' body** with the text below, leaving its signature exactly as 3A wrote it. There is no `openLayersFor` in the file to anchor on — this task is what introduces it.

```ts
// The import block after the additions. `SENTINEL_LOT_CODE` is 3A's and stays: loadSentinelLots uses it.
import { costingEngine, CostingError, Money, Quantity, type Consumption, type CostingMethod,
         type CurrencyCode, type DocumentSnapshot, type Layer, type PlannedMovement, type PostingPlan } from "@dulja/domain";
import type { Sql } from "postgres";
import { SENTINEL_LOT_CODE } from "../inventory/lots";     // 3A's line, unchanged (3a:5343)
import { PostingError } from "../posting/errors";
import type { TenantContext } from "../with-tenant";

/**
 * Every VALID open layer of one (company, item, warehouse), in the contracts §4.3.5 chronological order
 * `(effective_date, posting_seq, line_no, movement_no)` — all four columns, spelled out, never an index's
 * implicit order (spec:1225, LEGACY-067). `line_no` and `movement_no` live on the movement, which is why the
 * join is here and not optional.
 *
 * NO DATE FILTER, deliberately: see this task's note 2. The engine sorts its own input anyway (Task 3's
 * `byChronology`), so this ordering is belt and braces — and it is what makes the query plan use
 * `cost_layer_open_idx` instead of a sort.
 */
export async function openLayersFor(
  tx: Sql,
  input: { companyId: string; itemId: string; warehouseId: string; baseCurrency: CurrencyCode },
): Promise<Layer[]> {
  const rows = await tx<{
    id: string; item_id: string; warehouse_id: string; lot_id: string; movement_id: string;
    qty_in: string; unit_cost: string; qty_remaining: string;
    effective_at: string; sequence: string; line_no: number; movement_no: number;
  }[]>`
    select l.id::text as id, l.item_id::text as item_id, l.warehouse_id::text as warehouse_id,
           l.lot_id::text as lot_id, l.movement_id::text as movement_id,
           l.qty_in::text as qty_in, l.unit_cost::text as unit_cost, l.qty_remaining::text as qty_remaining,
           l.effective_at::text as effective_at, l.sequence::text as sequence,
           m.line_no, m.movement_no
      from app.cost_layer l
      join app.inventory_movement m on m.tenant_id = l.tenant_id and m.id = l.movement_id
     where l.company_id = ${input.companyId}
       and l.item_id = ${input.itemId}
       and l.warehouse_id = ${input.warehouseId}
       and l.invalidated_at is null
       and l.qty_remaining > 0
     order by l.effective_at, l.sequence, m.line_no, m.movement_no`;
  return rows.map((r) => ({
    id: r.id, itemId: r.item_id, warehouseId: r.warehouse_id, lotId: r.lot_id, movementId: r.movement_id,
    qtyIn: Quantity.of(r.qty_in),
    unitCost: Money.of(r.unit_cost, input.baseCurrency),
    qtyRemaining: Quantity.of(r.qty_remaining),
    effectiveDate: r.effective_at, postingSeq: BigInt(r.sequence),
    lineNo: r.line_no, movementNo: r.movement_no,
  }));
}

const pairKey = (itemId: string, warehouseId: string) => `${itemId}/${warehouseId}`;

/** One computed movement, ready to write. `value` is the MAGNITUDE; `effect` still carries the direction. */
interface Computed {
  planIndex: number;
  movementId: string;
  movement: PlannedMovement & { lotId: string };
  value: Money;
  unitCost: Money;
  consumptions: Consumption[];
  newLayerId: string | null;
}

/**
 * `postDocument` step 9 (§4.3.2). The ONLY writer of `app.inventory_movement`, `app.cost_layer` and
 * `app.cost_consumption`. Compute first, then write in FK order — see this task's note 1.
 */
export async function applyMovements(
  tx: Sql, ctx: TenantContext, plan: PostingPlan, snapshot: DocumentSnapshot,
): Promise<PostingPlan> {
  if (plan.movements.length === 0) return plan;

  const documentId = snapshot.header.id;
  const companyId = snapshot.header.companyId;
  const baseCurrency = snapshot.company.baseCurrency;
  const method: CostingMethod = snapshot.company.costingMethod;

  // posting_seq was assigned at step 8, before any row that carries it (§4.3.2).
  const [doc] = await tx<{ posting_seq: string }[]>`
    select posting_seq::text as posting_seq from app.document where id = ${documentId}`;
  if (!doc?.posting_seq) {
    throw new PostingError("ERR_INTERNAL", `document ${documentId} reached applyMovements with no posting_seq — step 8 did not run`);
  }
  const postingSeq = BigInt(doc.posting_seq);
  const effectiveDate = snapshot.header.effectiveDate;

  // F-6 / test 18: the ONLY door to a shortfall is a recorded override event by a second principal (§4.5.3).
  const [override] = await tx<{ present: boolean }[]>`
    select exists (
      select 1 from app.document_event
       where document_id = ${documentId} and event_kind = 'override'
         and override_code = 'inventory.negative_stock.override') as present`;
  const overridden = override?.present === true;

  const sentinels = await loadSentinelLots(tx, [...new Set(plan.movements.map((m) => m.itemId))]);
  const ids = await tx<{ id: string }[]>`select uuidv7()::text as id from generate_series(1, ${plan.movements.length * 2})`;
  let nextId = 0;
  const takeId = () => ids[nextId++]!.id;

  // ── 1. Compute, purely, in emission order, threading the layer state ────────────────────────────
  const layerState = new Map<string, Layer[]>();
  /** Every layer this document touched, at the value it ends the document with. Filled by the compute loop. */
  const finalRemaining = new Map<string, Quantity>();
  const computed: Computed[] = [];

  for (const [planIndex, movement] of plan.movements.entries()) {
    const lotId = movement.lotId ?? sentinels.get(movement.itemId);
    if (!lotId) {
      throw new PostingError("ERR_INTERNAL", `item ${movement.itemId} has no 'NONE' sentinel lot — migration 0029's item_sentinel_lot trigger did not fire`);
    }
    const key = pairKey(movement.itemId, movement.warehouseId);
    if (!layerState.has(key)) {
      layerState.set(key, await openLayersFor(tx, { companyId, itemId: movement.itemId, warehouseId: movement.warehouseId, baseCurrency }));
    }
    const openLayers = layerState.get(key)!;

    // Note 3. An ISSUE is costed from the layers, never from its planned value, and the engine reads that
    // value only to learn which currency to answer in — so every issue gets the company's base-currency zero,
    // unconditionally. That is what lets a free-of-charge line (spec:1055) AND an authorised
    // negative-stock excursion against an empty layer set (F-6) both post, instead of one of them dying on
    // ERR_COST_VALUE_MISSING. A RECEIPT keeps its own value: that value IS the layer's cost.
    const value = movement.effect === "issue" ? Money.zero(baseCurrency) : movement.value;
    const movementId = takeId();

    let out;
    try {
      out = costingEngine.cost({
        method, openLayers, allowShortfall: movement.costing === "zero" || overridden,
        movement: { ...movement, value, lotId, effectiveDate, postingSeq, movementId },
      });
    } catch (error) {
      // packages/domain may not import AppError, so the engine throws its own class and the hook translates
      // it to the code postDocument's caller already knows how to render (§4.2.4, amendment A3).
      if (error instanceof CostingError) throw new PostingError(error.code, error.detail);
      throw error;
    }

    const remaining = new Map(out.updatedRemaining.map((u) => [u.layerId, u.qtyRemaining]));
    const next: Layer[] = openLayers.map((l) => (remaining.has(l.id) ? { ...l, qtyRemaining: remaining.get(l.id)! } : l));
    let newLayerId: string | null = null;
    if (out.newLayer !== null) {
      newLayerId = takeId();
      next.push({ ...out.newLayer, id: newLayerId });
    }
    // Emptied layers are KEPT in the state, not filtered out. The engine already ignores a zero-remaining
    // layer (Task 2's `open` filter), and dropping one here loses the final figure for a layer created and
    // fully consumed by the SAME document — step 3's write would then fall back to `qty_in` and store a
    // residue the document does not have.
    layerState.set(key, next);
    for (const l of next) finalRemaining.set(l.id, l.qtyRemaining);

    computed.push({ planIndex, movementId, movement: { ...movement, lotId }, value: out.value, unitCost: out.unitCost, consumptions: out.consumptions, newLayerId });
  }

  // ── 2. The movements, in emission order — assert_stock_available fires per row ───────────────────
  for (const c of computed) {
    const signedQty = c.movement.effect === "issue" ? c.movement.quantity.negate() : c.movement.quantity;
    const signedValue = c.movement.effect === "issue" ? c.value.negate() : c.value;
    const unitId = snapshot.lines.find((l) => l.lineNo === c.movement.lineNo)?.unitId
      ?? snapshot.refs.items[c.movement.itemId]?.baseUnitId;
    if (!unitId) {
      throw new PostingError("ERR_INTERNAL", `line ${c.movement.lineNo}: no unit on the line and no base unit on item ${c.movement.itemId}`);
    }
    await tx`
      insert into app.inventory_movement
        (id, tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
      values (${c.movementId}, ${ctx.tenantId}, ${companyId}, ${documentId}, ${c.movement.lineNo},
              ${c.movement.movementNo}, ${c.movement.itemId}, ${c.movement.warehouseId}, ${c.movement.lotId},
              ${unitId}, ${signedQty.toString()}, ${signedValue.toString()},
              ${effectiveDate}, ${postingSeq.toString()})`;
  }

  // ── 3. The new layers, at their FINAL qty_remaining ─────────────────────────────────────────────
  // One write per layer, not one per consumption: the compute pass already recorded what each layer ends at
  // in `finalRemaining`, and `unique (movement_id)` makes a second row for the same receipt impossible (Task 1).
  for (const c of computed) {
    if (c.newLayerId === null) continue;
    await tx`
      insert into app.cost_layer
        (id, tenant_id, company_id, item_id, warehouse_id, lot_id, movement_id, qty_in, unit_cost, qty_remaining, effective_at, sequence)
      values (${c.newLayerId}, ${ctx.tenantId}, ${companyId}, ${c.movement.itemId}, ${c.movement.warehouseId},
              ${c.movement.lotId}, ${c.movementId}, ${c.movement.quantity.toString()}, ${c.unitCost.toString()},
              ${finalRemaining.get(c.newLayerId)!.toString()}, ${effectiveDate}, ${postingSeq.toString()})`;
  }

  // ── 4. The consumptions, then the pre-existing layers' residues ─────────────────────────────────
  for (const c of computed) {
    for (const consumption of c.consumptions) {
      await tx`
        insert into app.cost_consumption (tenant_id, company_id, movement_id, layer_id, quantity, unit_cost, value)
        values (${ctx.tenantId}, ${companyId}, ${c.movementId}, ${consumption.layerId},
                ${consumption.quantity.toString()}, ${consumption.unitCost.toString()}, ${consumption.value.toString()})`;
    }
  }
  // Only PRE-EXISTING layers need an UPDATE — a layer this document created was inserted at its final
  // figure two steps above, and updating it again would be a second write for no gain.
  const created = new Set(computed.map((c) => c.newLayerId).filter((id): id is string => id !== null));
  const touched = new Set(computed.flatMap((c) => c.consumptions.map((k) => k.layerId)).filter((id) => !created.has(id)));
  for (const layerId of touched) {
    const remaining = finalRemaining.get(layerId) ?? Quantity.zero();
    await tx`update app.cost_layer set qty_remaining = ${remaining.toString()} where id = ${layerId}`;
  }

  // ── 5. document_line.cost — the issue leg's value, base currency, magnitude (note 4) ────────────
  const perLine = new Map<number, { issue: Money; receipt: Money }>();
  for (const c of computed) {
    const acc = perLine.get(c.movement.lineNo) ?? { issue: Money.zero(baseCurrency), receipt: Money.zero(baseCurrency) };
    if (c.movement.effect === "issue") acc.issue = acc.issue.add(c.value);
    else acc.receipt = acc.receipt.add(c.value);
    perLine.set(c.movement.lineNo, acc);
  }
  for (const [lineNo, acc] of perLine) {
    const cost = acc.issue.isZero() ? acc.receipt : acc.issue;
    await tx`update app.document_line set cost = ${cost.toString()} where document_id = ${documentId} and line_no = ${lineNo}`;
  }

  // ── 6. Fill `value` on the plan and hand it back (§4.7.2) ────────────────────────────────────────
  const movements = plan.movements.map((m, i) => {
    const c = computed.find((x) => x.planIndex === i)!;
    return { ...m, lotId: c.movement.lotId, value: c.value };
  });
  return { ...plan, movements };
}
```

**Why step 5 re-reads `document_line` instead of trusting the plan's ledger lines.** The plan's cost-role ledger lines were built by `evaluatePolicy` from `LineSnapshot.cost`, which was `null` when the snapshot was taken — that is amendment A5's whole point. `postDocument` re-derives them after step 9 returns, from the plan this function just filled; the `document_line.cost` write here is what makes the *next* read of that document (a reversal, a report, `line.variance_value` in 3D) see the same number.

- [ ] **Step 4: Write `packages/db/src/costing/invalidate.ts`**

```ts
import type { Sql } from "postgres";
import type { JobClient } from "../jobs/enqueue";
import type { TenantContext } from "../with-tenant";

/**
 * Marks every layer and consumption of the affected items at or after `(effectiveDate, postingSeq)` invalid
 * and enqueues ONE `inventory.cost.replay` per company (§4.7.2). Runs on the caller's `tx`, so the
 * invalidation and the enqueue commit with the posting or roll back with it (spec:1127 — the guarantee
 * LEGACY-005 lacked, where a dirty flag was set from three of four code paths).
 *
 * The comparison is Postgres's row-wise `>=`, which is the contracts §4.3.5 key's first two elements
 * compared lexicographically — exactly "at or after its sequence" (spec:1220). Writing it as
 * `effective_at > d or (effective_at = d and sequence >= s)` is the same thing spelled less safely.
 *
 * Note what is NOT invalidated: a layer *before* the point that a movement *after* the point consumed
 * from. Its consumption row IS invalidated (the movement is at or after), so the layer's `qty_remaining`
 * is now stale — and restoring it is `replay`'s first act, not this function's, because doing it here
 * would leave a window in which the layer over-reports availability to a concurrent poster.
 */
export async function invalidateFrom(
  tx: Sql, ctx: TenantContext,
  input: { companyId: string; itemIds: string[]; effectiveDate: string; postingSeq: bigint; jobs: JobClient },
): Promise<void> {
  if (input.itemIds.length === 0) return;

  await tx`
    update app.cost_layer
       set invalidated_at = now()
     where company_id = ${input.companyId}
       and item_id = any(${input.itemIds}::uuid[])
       and (effective_at, sequence) >= (${input.effectiveDate}::date, ${input.postingSeq.toString()}::bigint)
       and invalidated_at is null`;

  await tx`
    update app.cost_consumption c
       set invalidated_at = now()
      from app.inventory_movement m
     where m.tenant_id = c.tenant_id and m.id = c.movement_id
       and m.company_id = ${input.companyId}
       and m.item_id = any(${input.itemIds}::uuid[])
       and (m.effective_date, m.posting_seq) >= (${input.effectiveDate}::date, ${input.postingSeq.toString()}::bigint)
       and c.invalidated_at is null`;

  await input.jobs.enqueue(
    tx, "inventory.cost.replay",
    { tenantId: ctx.tenantId, requestId: ctx.requestId, payload: { companyId: input.companyId } },
    { singletonKey: input.companyId },
  );
}
```

`packages/db/src/costing/index.ts` re-exports both files; `packages/db/src/index.ts` re-exports the barrel:

```ts
export { applyMovements, openLayersFor } from "./apply-movements";
export { invalidateFrom } from "./invalidate";
```

- [ ] **Step 5: Wire step 9, delete step 9b, and add step 14 in `packages/db/src/posting/post.ts`**

Three edits, in this order.

**(a) The input type and the step-9 call.** Where 3A left `plan = await applyMovements(tx, ctx, plan, snapshot)`, nothing changes — the signature is frozen. What changes is that the ledger lines must be re-derived from the filled plan, because step 6 planned them at `Money.zero`:

```ts
export async function postDocument(
  tx: Sql, ctx: TenantContext, input: { documentId: string; jobs?: JobClient },
): Promise<PostResult> {
  // … steps 1–8 unchanged …

  // Step 9 (§4.3.2): the costing hook. It inserts the movements, then the layers and consumptions, and
  // writes document_line.cost. From 3B this is also what fills the cost-role ledger amounts.
  const applied = await applyMovements(tx, ctx, plan, snapshot);
  plan = applied;
  if (applied.movements.length > 0) {
    // The snapshot's `cost` was null when step 6 ran (amendment A5), so re-read it and re-evaluate: this is
    // the second and last evaluation, and it is pure. Re-reading beats patching the plan line by line —
    // a policy may address `line.cost` from more than one rule, and the evaluator is the one place that knows.
    const costed = await loadSnapshot(tx, input.documentId);
    const reEvaluated = balanceInBase(evaluatePolicy(policy, costed), costed.company.fxRoundingAccountId, costed.company.baseCurrency);
    // Keep the APPLIED movements: `evaluatePolicy` re-plans them with `value: null`, and step 15's
    // `PostResult.movementIds` and step 14's item scope both read this array.
    plan = { ...reEvaluated, movements: applied.movements };
  }
  // Step 9b is GONE. 2A's fail-closed guard on a surviving zero-amount non-fx_rounding line was a stand-in
  // for exactly the call above (§4.3.2 step 9b: "3B replaces this guard with the applyMovements call").
  // Delete the whole block, including its comment; do not weaken it into a warning.

  // … steps 10–13 unchanged …
```

**(b) Step 14.** After step 13's status update, before the return:

```ts
  // Step 14 (§4.3.2): a BACK-DATED inventory document invalidates the affected items' tail and enqueues the
  // replay on THIS tx (spec:1127, 1223). Back-dated means: some already-posted movement of an affected item
  // carries a strictly LATER effective_date. This document's own rows carry its date, so they never match,
  // and its posting_seq is the maximum, so a same-date document never counts as back-dating it.
  const enqueuedJobIds: string[] = [];
  const itemIds = [...new Set(plan.movements.map((m) => m.itemId))];
  if (itemIds.length > 0) {
    const [later] = await tx<{ back_dated: boolean }[]>`
      select exists (
        select 1 from app.inventory_movement m
         where m.company_id = ${snapshot.header.companyId}
           and m.item_id = any(${itemIds}::uuid[])
           and m.effective_date > ${snapshot.header.effectiveDate}::date) as back_dated`;
    if (later?.back_dated) {
      if (!input.jobs) {
        // Never silently skip a recost. LEGACY-005 is exactly this: the flag that should have said "recost me"
        // was never set on insert, so a back-dated goods receipt mis-costed a whole month and nothing noticed.
        throw new PostingError(
          "ERR_INTERNAL",
          `document ${input.documentId} is back-dated and needs a cost replay, but was posted through a caller that supplied no JobClient`,
        );
      }
      await invalidateFrom(tx, ctx, {
        companyId: snapshot.header.companyId, itemIds,
        effectiveDate: snapshot.header.effectiveDate, postingSeq,
        jobs: input.jobs,
      });
      enqueuedJobIds.push(`inventory.cost.replay:${snapshot.header.companyId}`);
    }
  }
```

`PostResult.enqueuedJobIds` was `[]` at 1A and now carries that one entry when the replay was enqueued; `singletonKey` collapses a burst of back-dated posts into one job, so the id is the key, not a pg-boss uuid.

**(c) `insertLedger`'s base-currency branch** was already widened in Task 5 (`role !== "policy"`); check it is still there and change nothing.

- [ ] **Step 6: Thread `jobs` through `reverseDocument` (amendment A15)**

`reverseDocument` calls `postDocument` on the reversal document it creates. A reversal dated before later movements of the same items **is** back-dated, so without this the fail-closed guard fires on an ordinary reversal:

```ts
// packages/db/src/posting/reverse.ts
export async function reverseDocument(
  tx: Sql, ctx: TenantContext,
  input: { documentId: string; effectiveDate: string; reason: string; jobs?: JobClient },
): Promise<{ reversalDocumentId: string; number: bigint }> {
  // … unchanged, up to the post of the reversal document …
  const result = await postDocument(tx, ctx, { documentId: reversalDocumentId, jobs: input.jobs });
  // … unchanged …
}
```

`voidDocument` needs nothing: a void writes no movement.

- [ ] **Step 7: The Hono variable and the two call sites**

`apps/api/src/context.ts` — `AppEnv["Variables"]` gains an eighth member (2C's count of seven is in §4.2.3):

```ts
    /** 3B — `postDocument` step 14 enqueues `inventory.cost.replay` on the posting transaction (amendment A5). */
    jobs: JobClient;
```

`apps/api/src/app.ts` — two lines inside `createApp`, after the `otel` middleware and before the routes, so every handler has it:

```ts
  app.use("*", async (c, next) => { c.set("jobs", deps.jobs); await next(); });
```

`AppDeps.jobs` already exists (§4.2.7's six members), so no dependency is added.

`apps/api/src/routes/accounting/document.ts` — the post handler (1A) and the reverse handler (2B) each gain one property:

```ts
  const result = await postDocument(tx, ctx, { documentId, jobs: c.var.jobs });
  // and, in the reverse handler:
  const result = await reverseDocument(tx, ctx, { documentId, effectiveDate, reason, jobs: c.var.jobs });
```

Find every other call site with `grep -rn "postDocument(tx" apps packages | grep -v "src/posting/"` and add `jobs` only where the caller has one; a call site that plans no movement is correct as it stands, which is what makes the member optional.

- [ ] **Step 8: Add the two `JobPayload` keys (amendment A9)**

In `packages/db/src/jobs/payloads.ts`, add exactly two members and touch no other line — the interface extends `Record<JobName, unknown>` precisely so a slice adds only its own key:

```ts
  /** Slice 3B. One job per company; `singletonKey = companyId` collapses a burst of back-dated posts. */
  "inventory.cost.replay": { companyId: string };
  /** Slice 3B. Omit both fields for the nightly whole-tenant rebuild; `asOf` defaults to the run date. */
  "inventory.projection.rebuild": { companyId?: string; asOf?: string };
```

`packages/db/src/jobs/names.ts` is **not** edited: both names are already in 0B's closed sixteen-name `JOBS` with `owner: "3B"`, `inventory.cost.replay` at `schedule: null` and `inventory.projection.rebuild` at `"0 3 * * *"`.

- [ ] **Step 9: Let `packages/db/test/**` import the test tier's helper (amendment A21(c))**

Step 1's test file imports `postInventoryDocument` from `../../../../tests/invariants/support/post-inventory`, and so do Task 9's `replay.test.ts` and Task 11's `valuation.test.ts` — three files under `packages/db` importing the `tests` workspace. §4.17.1's closing paragraph names exactly **two** files outside that workspace which may: `apps/worker/test/**` and `apps/api/test/**`, each through a named allowance 1B added (1b:1668–1677). Without a third, `bun run lint:rules` fails here and in every later task that claims it passes, and the alternative — a second copy of the helper inside `packages/db/test/fixtures.ts` — is what §4.17 assigns 3B no helper for and hazard 9 forbids.

**This allowance covers the relative-path half only, and nothing else in the rule needs widening.** The same
rule’s package-specifier half — `"packages/db": ["@dulja/domain"]` (0b:5052) — is satisfied by *style*, not by
an allowance: every `packages/db/test/**` file in this slice imports `../fixtures`, `../harness` and
`../../src/**`, and `@dulja/domain` is the one package name any of them may write. Do **not** add
`@dulja/db` to the `packages/db` tier to make an import block compile; 0B is frozen and the relative style is
1A’s and 3A’s house rule in this directory, not a workaround (1a:5105, 3a:2920–2924).

**(a) `scripts/lint/rules/dependency-rule.ts` (0B owns the file).** Add one allowance beside 1B's two, in the same shape, with the reason on the line. The importing half is `packages/db/test/**` and the imported half stays `tests/invariants/support/**`, so `packages/db/src/**` gains nothing and no other directory under `tests/` becomes reachable:

```ts
// Test tier to test tier: packages/db/test/** may import tests/invariants/support/** — both are test code,
// and slice 3B's three DB-tier costing suites must post through the same real postInventoryDocument the
// invariant and regression suites use rather than a second copy of it (contracts §4.17.1's closing
// paragraph, widened to three importers by 3B's amendment A21(c); §4.17 assigns 3B no fixtures.ts helper,
// hazard 9). PRODUCTION code under packages/**/src/** may still import nothing from tests/.
```

**(b) `packages/db/tsconfig.json`.** The helper is outside the package, so add it to `include`:

```json
    "../../tests/invariants/support/**/*.ts"
```

Then run `bun run --cwd packages/db typecheck`. Two failures are expected shapes rather than surprises. **TS6059** (`File … is not under 'rootDir'`) means the package's tsconfig pins `rootDir`; delete that one line, exactly as 1B's Task 6 Step 1(c) instructs for `apps/worker`. A module-resolution error on `@dulja/db` *from the included file* would mean the package's own name does not resolve inside itself — it does: `tsconfig.base.json` sets `"moduleResolution": "Bundler"` (plan0A:278), which resolves a self-name import through the package's own `exports` map, the same way Bun and Vitest do at run time.

**Do not** add `@dulja/tests` to `packages/db/package.json`. `tests/package.json` already depends on `@dulja/db`; a dependency in the other direction closes a cycle in the workspace graph, and Plan 0A's turbo pipelines traverse it (plan0A:262–264). The lint allowance and the tsconfig `include` are the whole of what is needed.

- [ ] **Step 10: Run everything to verify it passes**

Run: `bun run --cwd packages/db test -- test/costing/apply-movements.test.ts`
Expected: **PASS**, all eight cases.

Run: `bun run --cwd packages/db test -- test/posting`
Expected: **PASS** — 1A's, 2A's, 2B's and Task 5's posting suites. **2A's step-9b test is now red and must be deleted, not skipped**: it asserted `ERR_POLICY_REQUIRES_MISSING` on a surviving zero-amount cost line, and the whole point of this task is that such a line now gets filled. Replace it with a one-line comment naming this task, exactly as 2B replaced its own pinning tests.

Run: `bun run --cwd tests test -- invariants/ledger-balance.test.ts`
Expected: **PASS** — Task 6's block goes green here.

Run: `bun run --cwd apps/api test && bun run --cwd tests test && bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS. `posting-only-tables` (§3.7.5) allows `packages/db/src/costing/**`, which is where every `cost_layer` / `cost_consumption` / `inventory_movement` DML in this task lives. If it fires, a statement leaked into `packages/db/src/posting/post.ts` — move it back into the hook. `dependency-rule` passes because of Step 9; if it reports `packages/db/test/costing/apply-movements.test.ts → tests/invariants/support/post-inventory.ts`, Step 9(a) was skipped.

- [ ] **Step 11: Commit**

```bash
git add packages/db/src/costing packages/db/src/posting/post.ts packages/db/src/posting/reverse.ts \
        packages/db/src/posting/index.ts packages/db/src/jobs/payloads.ts packages/db/src/index.ts \
        apps/api/src/context.ts apps/api/src/app.ts apps/api/src/routes/accounting/document.ts \
        scripts/lint/rules/dependency-rule.ts packages/db/tsconfig.json \
        packages/db/test/costing/apply-movements.test.ts
git commit -m "$(cat <<'EOF'
feat(db): applyMovements writes layers; step 9 replaces step 9b [3B T7]

The full body of contracts §4.7.2: compute purely through costingEngine for
every movement in emission order, threading the layer state; then the
inventory_movement inserts (assert_stock_available fires per row); then
cost_layer, which FKs to them; then cost_consumption; then document_line.cost.
3A's provisional value rule is deleted, not extended.

openLayersFor reads every valid open layer with NO date filter. Post now,
invalidate from this document's own key forward, replay later — a date filter
here would let an issue consume a layer a later posted issue has emptied, and
that is LEGACY-005's incremental mode by another name.

Amendment A5 opens postDocument's optional `jobs` seam and A15 threads it
through reverseDocument, whose reversal document is back-dated whenever later
movements exist. Absent where needed, step 14 raises ERR_INTERNAL rather than
skipping a recost — LEGACY-005 was a flag set from three of four code paths.

2A's step-9b guard and its test are deleted. Amendment A9 adds the two
JobPayload keys; JOBS itself is untouched. Amendment A21(c) adds the third
named dependency-rule allowance — packages/db/test/** to
tests/invariants/support/** — so three DB-tier costing suites post through the
real postInventoryDocument instead of a second copy of it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `COST_ADJUSTMENT` — the seed envelope, and proving `1300` and `5000` resolve before anything posts to them

**Files:**
- Create: `packages/db/seed/my/document-types/COST_ADJUSTMENT.json`, `packages/db/src/costing/cost-adjustment.ts`
- Modify: `packages/db/src/costing/index.ts`
- Test: `packages/db/test/costing/cost-adjustment.test.ts`

**Interfaces:**
- Consumes: `loadDocumentTypes(sql, ctx, packDir, catalogue)` and `DocumentTypeSeedResult` (contracts §4.3.7, 1A, reachable as `@dulja/db/seed` — never the main barrel, §3.1); `validateDocumentTypeSeed`, `validatePolicy`, `parsePolicy` (§4.4.2); the permission catalogue **as rows of `app.permission`, not as an import of `PERMISSIONS`** — `dependency-rule` forbids `packages/db` naming `@dulja/contracts` (1a:5105); `readPackFile`, `assertPackShape`, `SUB_PACKS` (§4.2.13); `seedTenantV2`, `startDb`, `withTenant` (§4.1, §4.17); `PostingError` (§4.2.4).
- Produces:

```ts
// packages/db/src/costing/cost-adjustment.ts
/** The one document-type code this slice owns (§4.14: accounting / internal / none / CA / accounting.journal.post). */
export const COST_ADJUSTMENT_CODE = "COST_ADJUSTMENT";
/** The two §4.15 codes the replay posts to. Seeded by 0C in `0c-base.json`; only RESOLVED here (hazard 33). */
export const ADJUSTMENT_ACCOUNT_CODES = { inventory: "1300", cogs: "5000" } as const;
export interface AdjustmentAccounts { inventoryAccountId: string; cogsAccountId: string; documentTypeId: string }
/** Resolves both codes and the document type, or raises naming the missing one. The replay calls this ONCE
 *  per run, before it computes anything, so a company with an incomplete chart fails loudly and early. */
export async function resolveAdjustmentAccounts(tx: Sql, companyId: string): Promise<AdjustmentAccounts>;
```

**Read this before writing the JSON.** §4.7.3's closing paragraph calls `COST_ADJUSTMENT` "a `JOURNAL`-shaped document type (`direction: internal`, `account.code` lines for the `1300` inventory control and `5000` COGS accounts)". **Amendment A12 realises that as: the policy addresses `{ from: "line.account" }`, and the replay job resolves the two codes to `document_line.account_id`.** The reason is one CHECK: `document_line.debit` carries `check (debit >= 0)` (§4.3.4), so "debit when the recomputed value rose, credit when it fell" cannot live in an `account: { code }` reference — the direction has to be *which column the job fills*, and the job is the only thing that knows the sign. An `account.code` policy would need two rule pairs and a `when` on a field no line has.

**Hazard 33's requirement is this task.** 3B consumes `1300` and `5000` and seeds neither, so "its first task in that area asserts the account resolves" — Step 1's second case is that assertion, and it runs before Task 9 posts a single adjustment.

**The system principal needs no role grant, and here is why it is safe to rely on that.** The replay posts under `approval.post = "accounting.journal.post"` as the tenant's system principal, and 2B's status trigger evaluates that code through `app.principal_has`. Plan 0A's `app.actor_has` opens with `select exists (select 1 from app.principal p join app.membership m on m.principal_id = p.id where p.id = app.current_actor() and p.kind = 'system' and m.tenant_id = app.current_tenant())` (plan0A:1366–1368) — **the tenant's system principal always passes, so a job never silently reads zero rows behind a gate** (plan0A:1363, verbatim). No `roles.ts` edit, no grant, and Step 1's fourth case pins it so a future change to `actor_has` breaks here rather than in production.

- [ ] **Step 1: Write the failing test `packages/db/test/costing/cost-adjustment.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADJUSTMENT_ACCOUNT_CODES, COST_ADJUSTMENT_CODE, resolveAdjustmentAccounts } from "../../src/costing/cost-adjustment";
import { loadDocumentTypes } from "../../src/seed/document-types";
import { readPackFile } from "../../src/seed/packs";
import { parsePolicy, validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import { seedItem, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/**
 * Resolved from THIS file, never from the cwd: Vitest runs this package from `packages/db`, so the bare
 * string `"packages/db/seed/my"` would resolve to `packages/db/packages/db/seed/my` and the loader would
 * raise ENOENT. 1A's document-types suite resolves the same pack the same way (1a:5114).
 */
const PACK = fileURLToPath(new URL("../../seed/my", import.meta.url));
const TYPES = join(PACK, "document-types");

describe("COST_ADJUSTMENT (contracts §4.14, §4.7.3; amendment A12)", () => {
  let db: Db; let s: Seed; let catalogue: string[];
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "CostAdj");
    // The permission catalogue as DATA, read from the table: `packages/db` may not import
    // `@dulja/contracts` (0B's `dependency-rule`; 1a:5105 spells out this exact substitution). `app.permission`
    // is global, carries no `tenant_id` and no RLS (plan0A:1313), migration 0014 is its only writer, and
    // `permission-catalogue.test.ts` pins it equal to `PERMISSIONS` in both directions — so the two sources
    // cannot disagree. 1A's loader suite reads it the same way (1a:5131–5132), and `no-bare-db` allows
    // `db.admin` under `packages/db/test/` (0b:4969).
    catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map((r) => r.code);
    // `seedTenantV2` seeds only 1000 and 4000 (plan0A:1592-1594). 3A's `seedItem` idempotently seeds
    // `ITEM_DEFAULT_ACCOUNTS` = 1300, 5000, 5900 — the three codes this slice resolves — so one call is
    // how a Testcontainers company gets a chart without applying 0C's pack.
    await seedItem(db, s, { code: "CA-CHART" });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("the seed file is a valid envelope whose policy validates against the catalogue", () => {
    const envelope = readPackFile<Record<string, unknown>>(PACK, "document-types", "COST_ADJUSTMENT.json");
    expect(envelope.code).toBe(COST_ADJUSTMENT_CODE);
    expect(envelope.module).toBe("accounting");
    expect(validateDocumentTypeSeed(envelope)).toEqual({ ok: true, errors: [] });
    expect(validatePolicy(envelope.policy, catalogue)).toEqual({ ok: true, errors: [] });
    const policy = parsePolicy(envelope.policy);
    expect(policy.direction).toBe("internal");
    expect(policy.inventory.effect).toBe("none");          // a recost moves VALUE, never quantity (spec:1224)
    expect(policy.numbering.series).toBe("CA");
    expect(policy.approval).toEqual({ required: false, approve: null, post: "accounting.journal.post" });
    // Amendment A12: line.account, not account.code — the job supplies the account and the direction.
    expect(policy.lines.map((l) => [l.side, l.account.from, l.amount])).toEqual([
      ["debit", "line.account", "line.debit"],
      ["credit", "line.account", "line.credit"],
    ]);
  });

  it("both account codes this slice consumes resolve in a freshly seeded company (hazard 33)", async () => {
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      loadDocumentTypes(tx, ctx, TYPES, catalogue));
    const resolved = await withTenant(db.rw, s.tenant, s.system, (tx) => resolveAdjustmentAccounts(tx, s.company));
    expect(resolved.inventoryAccountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolved.cogsAccountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolved.documentTypeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ADJUSTMENT_ACCOUNT_CODES).toEqual({ inventory: "1300", cogs: "5000" });
  });

  it("a company missing the chart fails loudly, naming the FIRST missing code and what it is for", async () => {
    const bare = await seedTenantV2(db, "NoChart");   // seedTenantV2 seeds 1000/4000 only (plan0A:1592-1594)
    await withTenant(db.migrator, bare.tenant, bare.system, (tx) =>
      loadDocumentTypes(tx, { tenantId: bare.tenant, actorId: bare.system, requestId: crypto.randomUUID() },
                        TYPES, catalogue));
    // `resolveAdjustmentAccounts` checks 1300 before 5000 and raises on the first one missing, so THAT is
    // the code the message names. Both are absent on a bare tenant; asserting on 5000 would fail.
    await expect(withTenant(db.rw, bare.tenant, bare.system, (tx) => resolveAdjustmentAccounts(tx, bare.company)))
      .rejects.toThrow(/ERR_NOT_FOUND.*account code 1300 \(inventory control\)/s);
  });

  it("5900 — the contra account the receipt fixture posts to — also resolves once seedItem has run", async () => {
    // §4.15 seeds it in 0C's `0c-base.json` and 3A's `seedItem` re-asserts it; this slice only consumes it
    // (hazard 33), and STOCK_RECEIPT_COST_POLICY addresses it by code because a `product` leaves
    // `item.expense_account_id` null (§4.6.1).
    const [row] = await withTenant(db.rw, s.tenant, s.system, (tx) => tx<{ id: string | null }[]>`
      select (select id::text from app.account where company_id = ${s.company} and code = '5900') as id`);
    expect(row!.id).not.toBeNull();
  });

  it("the tenant's system principal passes accounting.journal.post with no role grant (plan0A:1363)", async () => {
    const [ok] = await withTenant(db.rw, s.tenant, s.system, (tx) => tx<{ ok: boolean }[]>`
      select app.actor_has('accounting.journal.post', ${s.company}, ${s.hq}) as ok`);
    expect(ok!.ok).toBe(true);
    // …and a human with no grant does not, so the case above is not vacuous.
    const [no] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ ok: boolean }[]>`
      select app.actor_has('accounting.journal.post', ${s.company}, ${s.hq}) as ok`);
    expect(no!.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- test/costing/cost-adjustment.test.ts`
Expected: **FAIL** with `Cannot find module '../../src/costing/cost-adjustment'` — the file does not exist yet, so the whole suite fails to load rather than case by case. Create it as an empty file and re-run to see the intended per-case failures: the first case then throws from `readPackFile` naming `COST_ADJUSTMENT.json` (the JSON does not exist), and the second and third fail with `resolveAdjustmentAccounts is not a function`. The **fifth** case — the system principal's `app.actor_has` — **passes already**, and that is the point of writing it: it pins a Plan 0A behaviour this slice depends on and does not create.

- [ ] **Step 3: Write `packages/db/seed/my/document-types/COST_ADJUSTMENT.json`**

The §4.3.7 envelope, exactly. This is a **file added to an existing sub-pack**, so no loader changes (§3.4.8: "a slice adding rows to an existing sub-pack adds a file, never a loader"):

```json
{
  "code": "COST_ADJUSTMENT",
  "nameEn": "Cost Adjustment",
  "nameAr": "تسوية التكلفة",
  "module": "accounting",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "COST_ADJUSTMENT",
    "direction": "internal",
    "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "CA", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "COST_ADJUSTMENT" },
    "approval": { "required": false, "approve": null, "post": "accounting.journal.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

**Four decisions in that file worth stating so a reviewer does not have to reconstruct them.** `inventory.effect` is `"none"` because a recost changes what stock is *worth*, never how much of it there is — the movements are immutable and already correct (spec:1210). `approval.required` is `false` because the poster is a job, and a maker-checker on a system-generated correction is LEGACY-054's mutual-recursion defect in a new costume. `reversal.allowed` is `true` with `producesType: "COST_ADJUSTMENT"` so an accountant who disputes an adjustment reverses it like any other document (D13) rather than editing it. `dimensions.required` is `[]`, and BRANCH still lands on every line: §4.3.2 step 10 tags every ledger line from `document.branch_id`, which Task 9 sets per branch.

- [ ] **Step 4: Write `packages/db/src/costing/cost-adjustment.ts`**

```ts
import type { Sql } from "postgres";
import { PostingError } from "../posting/errors";

/** §4.14's one 3B row: accounting / internal / none / series CA / accounting.journal.post. */
export const COST_ADJUSTMENT_CODE = "COST_ADJUSTMENT";

/**
 * The two §4.15 codes the replay posts to. **Seeded by 0C** in `packages/db/seed/my/chart-of-accounts/0c-base.json`
 * and only resolved here — hazard 33 forbids a consuming slice from re-seeding or falling back to null.
 * They are the COMPANY-WIDE fallback: an item with its own control accounts sets
 * `item.inventory_account_id` / `cogs_account_id`, and the replay aggregates across items (§4.7.3).
 */
export const ADJUSTMENT_ACCOUNT_CODES = { inventory: "1300", cogs: "5000" } as const;

export interface AdjustmentAccounts { inventoryAccountId: string; cogsAccountId: string; documentTypeId: string }

const LABEL: Record<string, string> = {
  "1300": "inventory control",
  "5000": "cost of goods sold",
};

/**
 * Resolves both account codes and the `COST_ADJUSTMENT` document type for one company, or raises
 * `ERR_NOT_FOUND` naming exactly what is missing. Called ONCE per replay run, before any arithmetic, so a
 * company whose chart or seed pack is incomplete fails at the top of the job with a message an operator can
 * act on — rather than at the insert, halfway through a batch, with a null FK.
 */
export async function resolveAdjustmentAccounts(tx: Sql, companyId: string): Promise<AdjustmentAccounts> {
  const [row] = await tx<{ inventory_id: string | null; cogs_id: string | null; type_id: string | null }[]>`
    select (select id::text from app.account where company_id = ${companyId} and code = ${ADJUSTMENT_ACCOUNT_CODES.inventory} and archived_at is null) as inventory_id,
           (select id::text from app.account where company_id = ${companyId} and code = ${ADJUSTMENT_ACCOUNT_CODES.cogs}      and archived_at is null) as cogs_id,
           -- `company_id` on this subquery is NOT optional: app.document_type carries `company_id uuid not null`
           -- and `unique (company_id, code)` (spec:1694-1703), so in a tenant with two companies an unfiltered
           -- lookup is a non-deterministic single row or a 21000. The id is written onto app.document, whose FK
           -- is (tenant_id, document_type_id) and checks no company — so the wrong one would post silently.
           (select id::text from app.document_type
             where company_id = ${companyId} and code = ${COST_ADJUSTMENT_CODE} and archived_at is null)                       as type_id`;

  for (const code of [ADJUSTMENT_ACCOUNT_CODES.inventory, ADJUSTMENT_ACCOUNT_CODES.cogs]) {
    const id = code === ADJUSTMENT_ACCOUNT_CODES.inventory ? row?.inventory_id : row?.cogs_id;
    if (!id) {
      throw new PostingError(
        "ERR_NOT_FOUND",
        `company ${companyId} has no account code ${code} (${LABEL[code]}) — apply the 0C chart with \`bun run seed --tenant <id> --only chart-of-accounts\` before a cost replay can post an adjustment`,
      );
    }
  }
  if (!row?.type_id) {
    throw new PostingError(
      "ERR_NOT_FOUND",
      `document type ${COST_ADJUSTMENT_CODE} is not seeded — apply \`bun run seed --tenant <id> --only document-types\``,
    );
  }
  return { inventoryAccountId: row.inventory_id!, cogsAccountId: row.cogs_id!, documentTypeId: row.type_id };
}
```

`packages/db/src/costing/index.ts` gains `export * from "./cost-adjustment";`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/costing/cost-adjustment.test.ts`
Expected: **PASS**, all five cases.

Run: `bun run --cwd packages/db test -- test/seed`
Expected: **PASS** — 1A's document-types loader suite now loads two files instead of one. If `assertPackShape` exits 3, a `document-types` directory rule regressed; the directory has been in `SUB_PACKS` and in `PHASE_0_SUB_PACK_DIRECTORIES` since 1A (§4.2.13) and this task adds only a file to it.

Run: `bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/seed/my/document-types/COST_ADJUSTMENT.json packages/db/src/costing/cost-adjustment.ts \
        packages/db/src/costing/index.ts packages/db/test/costing/cost-adjustment.test.ts
git commit -m "$(cat <<'EOF'
feat(seed): the COST_ADJUSTMENT document type [3B T8]

§4.14's one 3B row, as a §4.3.7 envelope. Amendment A12 realises §4.7.3's
"account.code lines for 1300 and 5000" as a line.account policy whose accounts
and DIRECTION the replay job supplies: document_line.debit carries
check (debit >= 0), so which column is filled is the only place a sign can
live, and the job is the only thing that knows it.

inventory.effect is none — a recost changes what stock is worth, never how
much there is. approval.required is false: a maker-checker on a
system-generated correction is LEGACY-054's defect in a new costume.

resolveAdjustmentAccounts is hazard 33's assertion made executable: 3B
consumes 1300 and 5000 and seeds neither, so it proves both resolve before
Task 9 posts anything, and names the seed command when they do not.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `replay` — the bounded, restartable forward pass and the visible adjustment (acceptance test 5)

**Files:**
- Create: `packages/db/src/costing/replay.ts`, `apps/worker/src/handlers/cost-replay.ts`, `docs/adr/0038-bounded-restartable-recost-and-the-cost-adjustment-document.md`
- Modify: `packages/db/src/costing/index.ts`, `apps/worker/src/index.ts`, `tests/invariants/probes.ts`
- Test: `packages/db/test/costing/replay.test.ts`, `apps/worker/test/handlers/cost-replay.test.ts`

**Interfaces:**
- Consumes: `costingEngine`, `CostingError`, `Layer` (Tasks 2–3); `openLayersFor` (Task 7); `resolveAdjustmentAccounts`, `COST_ADJUSTMENT_CODE` (Task 8); `postDocument`, `PostResult` (contracts §4.3.1); `withTenant`, `systemContext`, `TenantContext` (§4.2.2); `JobEnvelope`, `JobHandler`, `registerHandler`, `JobPayload` (§4.2.6); `log()` (§4.2.6, 0D); `recordIntegrityIncident` (1B); `Money`, `Quantity`, `currency` (§4.2.1); `startWorker` (§4.17.1, 0D); `JOB_PROBES`, `JobIsolationProbe` (§4.2.6).
- Produces:

```ts
// packages/db/src/costing/replay.ts
/** Movements per `withTenant` transaction (spec:1368 — "long jobs run as many short transactions"). */
export const MOVEMENTS_PER_BATCH = 500;
/** §4.7.2 verbatim. Idempotent and restartable (LEGACY-054). */
export async function replay(sql: Sql, job: JobEnvelope<{ companyId: string }>, ctx: TenantContext): Promise<{ movementsReplayed: number; adjustmentsPosted: string[] }>;
```

**Read all of this before writing a line. Six behaviours are decisions, not implementation detail, and ADR 0038 records every one.**

**(1) An issue's `inventory_movement.value` is never rewritten — that is why the table can be immutable while layers are derived.** `app.inventory_movement` carries `forbid_change` (§4.7.3). So a recost does **not** correct the value the issue was posted with; it recomputes `cost_consumption` and books the *difference* as a `COST_ADJUSTMENT`. That is spec:1224 read literally — "the replay writes an adjustment entry, never silently rewriting posted history" — and it is what makes the whole design hold together: the movement is the immutable record of what happened, the consumptions are the derived answer to what it cost, and the adjustment is the ledger's reconciliation between the two. A plan that proposes updating `inventory_movement.value` has misread this and will die on the trigger.

**(2) `document_line.cost` IS rewritten.** It is the *current* answer to "what did this line cost", read by reversals, by 3D's `line.variance_value` and by every margin report, so leaving it at a superseded figure would give two reports two answers — LEGACY-009 by another route. `document_line` has no BEFORE UPDATE guard (3A assumption 5), it is audited (§4.3.4), and the audit row keeps the before-image, so the change is visible. The ledger is not touched: the adjustment reconciles it.

**(3) A layer is UPDATED, never re-inserted.** `unique (movement_id)` (Task 1) makes that structural rather than a convention.

**(4) The restore pass is a formula, so a crash-restart re-runs it harmlessly.** A layer *before* the invalidation point can have been consumed by a movement *after* it — its consumption row is invalid, its `qty_remaining` is stale, and it is not itself invalidated. So before the forward pass: `qty_remaining = qty_in − Σ(valid consumptions)`. Written that way it is idempotent: after two batches have committed, the same statement recomputes exactly the value already there.

**(5) "Before" is the LATEST invalidated generation, not every invalidated row.** All rows one `invalidateFrom` invalidates share a single `now()`, so `max(invalidated_at)` per movement selects exactly the set that was valid immediately before this run. Summing *all* invalidated rows would double-count a movement recosted twice, and the second adjustment would be wrong by the first one's amount.

**(6) A closed period carries forward; no open period is an incident.** The affected period may be locked (test 9), and spec:2179's remedy for a locked period is "a reversing entry in an open period". So the adjustment posts in the **earliest open period on or after** the affected one, with `document.notes` naming the source period, and its `effective_date` is that target period's `starts_on` (or the source period's `ends_on` when source and target are the same period). If **no** open period exists on or after it, the job records an integrity incident through 1B's `recordIntegrityIncident` and returns — the layers are already correct and are not period-bound, so nothing is lost and nothing retries forever. Letting `ERR_PERIOD_NOT_OPEN` escape would make pg-boss retry the job until its limit and then dead-letter it, with the layers silently right and the ledger silently wrong.

- [ ] **Step 1: Write the failing test `packages/db/test/costing/replay.test.ts`** — this is acceptance test 5

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { MOVEMENTS_PER_BATCH, replay } from "../../src/costing/replay";
import { loadDocumentTypes } from "../../src/seed/document-types";
import { grantCodes, seedDocumentType, seedItem, seedTenantV2, seedWarehouse, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { postInventoryDocument, recordingJobs, STOCK_ISSUE_COST_POLICY, STOCK_RECEIPT_COST_POLICY } from "../../../../tests/invariants/support/post-inventory";

/** Twelve months of alternating receipt and issue, one document each, all 2026. */
const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}-05`);
/** Resolved from this file: Vitest runs this package from `packages/db`, so a bare relative pack path
 *  would resolve to `packages/db/packages/db/seed/…` (1a:5114 does the same). */
const TYPES = fileURLToPath(new URL("../../seed/my/document-types", import.meta.url));

describe("acceptance test 5 — back-dated costing (spec:2423; LEGACY-004, 005, 010)", () => {
  let db: Db; let s: Seed; let receiptType: string; let issueType: string;
  let itemId: string; let warehouseId: string; let catalogue: string[];

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Replay");
    await grantCodes(db, s);
    // The permission catalogue as DATA, read from the table: `packages/db` may not import
    // `@dulja/contracts` (0B's `dependency-rule`; 1a:5105 spells out this exact substitution). `app.permission`
    // is global, carries no `tenant_id` and no RLS (plan0A:1313), migration 0014 is its only writer, and
    // `permission-catalogue.test.ts` pins it equal to `PERMISSIONS` in both directions — so the two sources
    // cannot disagree. 1A's loader suite reads it the same way (1a:5131–5132), and `no-bare-db` allows
    // `db.admin` under `packages/db/test/` (0b:4969).
    catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map((r) => r.code);
    // 3A's `seedItem` (called below) idempotently seeds 1300, 5000 and 5900 — the whole chart this slice
    // resolves. No `seedAccount` call is needed and none is made: 0C owns those rows (hazard 33).
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      loadDocumentTypes(tx, { tenantId: s.tenant, actorId: s.system, requestId: crypto.randomUUID() },
                        TYPES, catalogue));
    receiptType = await seedDocumentType(db, s, { code: "STOCK_RECEIPT_TEST", module: "inventory", policy: STOCK_RECEIPT_COST_POLICY });
    issueType = await seedDocumentType(db, s, { code: "STOCK_ISSUE_TEST", module: "inventory", policy: STOCK_ISSUE_COST_POLICY });
    ({ itemId } = await seedItem(db, s, { code: "REPLAY-1" }));
    warehouseId = await seedWarehouse(db, s, { code: "R-WH" });

    // Twelve months: buy 100 @ 10 on the 5th, sell 100 on the 6th. Every month, same numbers.
    //
    // The issue drains its OWN month's receipt exactly, so in THIS forward build — before any back-dating —
    // each month closes at zero on hand and no residue carries into the next. (Once the 2026-03-03 receipt
    // arrives, March leaves 100 units of residue and every later month carries some; the figures below are
    // derived from the layer sets that actually result, not from the zero-residue rule.) That is what makes
    // March's arithmetic a two-layer average a reader can check by hand instead of a twelve-term
    // proportional chain, and it is the whole reason the quantities are 100/100 rather than 100/50.
    //
    // The issue date is BUILT, never produced by `day.replace("-05", "-06")`: `String.prototype.replace`
    // with a string pattern replaces the FIRST occurrence, and for `2026-05-05` the first `-05` is the
    // MONTH — so May's issue would land on 2026-06-05, May would get no issue at all and June would get two
    // in one period. Every count in this suite (10, 10, 9, 8) would then be one short.
    const jobs = recordingJobs();
    for (const day of MONTHS) {
      const issueDay = `${day.slice(0, 8)}06`;          // "2026-05-05" → "2026-05-06"
      await postInventoryDocument(db, s, { documentTypeId: receiptType, warehouseId, jobs, effectiveDate: day,
        lines: [{ itemId, warehouseId, quantity: "100.000000", unitPrice: "10.0000" }] });
      await postInventoryDocument(db, s, { documentTypeId: issueType, warehouseId, jobs, effectiveDate: issueDay,
        lines: [{ itemId, warehouseId, quantity: "100.000000", unitPrice: "40.0000" }] });
    }
    expect(jobs.enqueued).toEqual([]);          // strictly forward so far — nothing to replay
  }, 600_000);
  afterAll(async () => { await db.stop(); });

  it("MOVEMENTS_PER_BATCH is 500, so a replay is many short transactions (spec:1368)", () => {
    expect(MOVEMENTS_PER_BATCH).toBe(500);
  });

  it("a purchase back-dated into month 3 recomputes months 3-12 and leaves months 1-2 untouched", async () => {
    const before = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string; created_at: string; effective_at: string }[]>`
      select l.id::text as id, l.created_at::text as created_at, l.effective_at::text as effective_at
        from app.cost_layer l where l.company_id = ${s.company} order by l.effective_at`);
    const early = before.filter((r) => r.effective_at < "2026-03-01");
    expect(early).toHaveLength(2);

    const jobs = recordingJobs();
    await postInventoryDocument(db, s, { documentTypeId: receiptType, warehouseId, jobs, effectiveDate: "2026-03-03",
      lines: [{ itemId, warehouseId, quantity: "100.000000", unitPrice: "30.0000" }] });
    expect(jobs.enqueued).toEqual([{ name: "inventory.cost.replay", payload: { companyId: s.company }, singletonKey: s.company }]);

    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const result = await replay(db.rw, { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } }, ctx);

    // 1 back-dated receipt + (10 receipts + 10 issues) from March on = 21 movements at or after the key.
    expect(result.movementsReplayed).toBe(21);
    // TEN adjustments, one per (fiscal period, branch) whose COGS moved (amendment A16(a)). Ten issues were
    // recosted — March to December — and `ensureOpenPeriods` gives each month its own period, so each
    // period's COGS change posts in the period it belongs to. That is spec:2039 (`effective_date` is the
    // accounting date) applied to a correction, and it is why the count is ten and not one.
    expect(result.adjustmentsPosted).toHaveLength(10);
    const periods = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ fiscal_period_id: string }[]>`
      select distinct fiscal_period_id::text as fiscal_period_id from app.document
       where id = any(${result.adjustmentsPosted}::uuid[])`);
    expect(periods).toHaveLength(10);          // one per period — never two in one period

    // The proportional clause, asserted on ROWS and never on a wall clock: months 1-2 keep their ids,
    // their created_at and their valid state. Nothing before the invalidation point was rewritten.
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string; created_at: string; effective_at: string; invalidated_at: string | null }[]>`
      select l.id::text as id, l.created_at::text as created_at, l.effective_at::text as effective_at, l.invalidated_at::text as invalidated_at
        from app.cost_layer l where l.company_id = ${s.company} and l.effective_at < '2026-03-01' order by l.effective_at`);
    expect(after.map((r) => ({ id: r.id, created_at: r.created_at }))).toEqual(early.map((r) => ({ id: r.id, created_at: r.created_at })));
    expect(after.every((r) => r.invalidated_at === null)).toBe(true);

    // …and nothing anywhere is left invalid.
    const [left] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.cost_layer where company_id = ${s.company} and invalidated_at is not null`);
    expect(left!.n).toBe(0);
  }, 600_000);

  it("every adjustment is visible, explained, balanced, and posted to 1300 against 5000", async () => {
    const cas = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{
      id: string; series: string; status: string; notes: string | null; effective_date: string; debit: string; credit: string;
    }[]>`
      select d.id::text as id, d.series, d.status, d.notes, d.effective_date::text as effective_date,
             (select sum(base_debit)::text  from app.ledger_entry where document_id = d.id) as debit,
             (select sum(base_credit)::text from app.ledger_entry where document_id = d.id) as credit
        from app.document d
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'COST_ADJUSTMENT' and d.company_id = ${s.company}
       order by d.effective_date`);
    expect(cas).toHaveLength(10);
    for (const ca of cas) {
      expect(ca.series).toBe("CA");
      expect(ca.status).toBe("posted");
      expect(ca.debit).toBe(ca.credit);              // sum(base_debit) = sum(base_credit), per document
      expect(ca.notes).toMatch(/cost replay adjustment/i);
      expect(ca.notes).toMatch(/recomputed from \d{4}-\d{2}-\d{2} forward/i);
    }
    // The first one carries March's date — the period the recomputation started in.
    expect(cas[0]!.effective_date.slice(0, 7)).toBe("2026-03");

    const legs = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.base_debit::text as debit, l.base_credit::text as credit
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${cas[0]!.id} order by a.code`);
    // The whole March figure, worked out against the layer set the fixture actually produces.
    //
    // Every month's issue of 100 drained that month's receipt of 100 in the forward build, so January's and
    // February's layers sit at qty_remaining 0 and `openLayersFor` (which filters `qty_remaining > 0`) does
    // not return them. (From March on the back-dated receipt leaves a residue, so this is a statement about
    // the two months BEFORE the invalidation point, not a standing property of the fixture.)
    // The layers open at the 2026-03-06 issue are therefore exactly two:
    //     the back-dated 2026-03-03 receipt   100.000000 @ 30.0000  = 3000.0000
    //     the monthly    2026-03-05 receipt   100.000000 @ 10.0000  = 1000.0000
    // so `average` is (100×30 + 100×10) ÷ 200 = 20.0000, and the issue of 100 costs 2000.0000 where it had
    // cost 1000.0000. COGS is debited the 1000.0000 difference and inventory control is credited it.
    expect(legs).toEqual([
      { code: "1300", debit: "0.0000",    credit: "1000.0000" },
      { code: "5000", debit: "1000.0000", credit: "0.0000" },
    ]);
  });

  it("a second replay over an unchanged company is a no-op — no movements, no adjustment (idempotent)", async () => {
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const again = await replay(db.rw, { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } }, ctx);
    expect(again).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });
  });

  it("re-running after a completed run adds nothing, and no period gets two adjustments (LEGACY-054)", async () => {
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, { documentTypeId: receiptType, warehouseId, jobs, effectiveDate: "2026-04-02",
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "50.0000" }] });

    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    // The observable state a restart reaches after its last committed batch: run the real function to
    // completion, then run it again. A restart mid-run is the same shape, because every batch commits and
    // the resume point is re-derived from committed rows rather than carried in memory (ADR 0038 note 4).
    const first = await replay(db.rw, { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } }, ctx);
    expect(first.movementsReplayed).toBeGreaterThan(0);
    expect(first.adjustmentsPosted).toHaveLength(9);       // April to December — nine periods moved
    const second = await replay(db.rw, { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } }, ctx);
    expect(second).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });

    // THIS RUN posts at most one adjustment per period. (Across runs a period legitimately accumulates
    // several — one per back-dated document that reached it, each a separate, reversible entry.)
    const perPeriod = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ fiscal_period_id: string; n: number }[]>`
      select fiscal_period_id::text as fiscal_period_id, count(*)::int as n
        from app.document where id = any(${first.adjustmentsPosted}::uuid[])
       group by 1 having count(*) > 1`);
    expect(perPeriod).toEqual([]);

    // The double-count guard of ADR 0038 note 5, stated as a figure: April's second adjustment is the
    // change since run 1's answer, not since the original posting.
    //
    // Run 1 left March's issue taking 50 from each of its two layers, so April opened on
    //     2026-03-03 layer  50.000000 @ 30.0000 = 1500.0000
    //     2026-03-05 layer  50.000000 @ 10.0000 =  500.0000
    //     2026-04-05 layer 100.000000 @ 10.0000 = 1000.0000
    // → 3000.0000 over 200.000000 = 15.0000, so run 1 moved April's COGS from 1000.0000 to 1500.0000.
    // The 10 @ 50.0000 receipt dated 2026-04-02 adds a fourth open layer, giving
    //     (50×30 + 50×10 + 10×50 + 100×10) ÷ 210 = 3500.0000 ÷ 210.000000 = 16.6667,
    // so April's issue of 100 now costs 1666.6700 and the delta is 166.6700 — not 666.6700, which is what
    // a "since the original posting" comparison would have produced.
    const [april] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ debit: string }[]>`
      select l.base_debit::text as debit
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = any(${first.adjustmentsPosted}::uuid[]) and a.code = '5000'
         and (select effective_date from app.document where id = l.document_id) < '2026-05-01'`);
    expect(april!.debit).toBe("166.6700");
  }, 600_000);

  it("qty_remaining equals qty_in minus its valid consumptions for every layer (the invariant the nightly check asserts)", async () => {
    const drift = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
      select l.id::text as id from app.cost_layer l
       where l.company_id = ${s.company}
         and l.qty_remaining <> l.qty_in - coalesce((select sum(c.quantity) from app.cost_consumption c
                                                      where c.layer_id = l.id and c.invalidated_at is null), 0)`);
    expect(drift).toEqual([]);
  });

  it("a closed affected period carries its adjustment forward and says so (test 9; amendment A16(b))", async () => {
    const jobs = recordingJobs();
    // POST FIRST, then close. `assert_period_open` refuses a post into a closed period, and this case is
    // about where the ADJUSTMENT lands, not about whether the source document could be entered.
    await postInventoryDocument(db, s, { documentTypeId: receiptType, warehouseId, jobs, effectiveDate: "2026-05-02",
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "70.0000" }] });
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      tx`update app.fiscal_period set status = 'closed' where company_id = ${s.company} and starts_on = '2026-05-01'`);

    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const out = await replay(db.rw, { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } }, ctx);
    expect(out.adjustmentsPosted).toHaveLength(8);        // May to December — eight periods moved

    const posted = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ effective_date: string; notes: string }[]>`
      select effective_date::text as effective_date, notes from app.document
       where id = any(${out.adjustmentsPosted}::uuid[]) order by effective_date`);
    // May's own adjustment cannot post in May, so it lands in June beside June's — two CA documents dated
    // in June, distinguishable by their notes. Nothing is netted and nothing is lost.
    const carried = posted.filter((d) => /source period 2026-05 is closed/i.test(d.notes));
    expect(carried).toHaveLength(1);
    expect(carried[0]!.effective_date >= "2026-06-01").toBe(true);
    expect(posted.filter((d) => d.effective_date.slice(0, 7) === "2026-06")).toHaveLength(2);
  }, 600_000);

  it("with no open period on or after the affected one, the job records an incident and returns", async () => {
    // The shape a replay finds after an operator closes the rest of the year between the enqueue and the
    // run: BACK-DATE FIRST, while July is still open, then close June onward, then replay.
    //
    // The obvious alternative — `update app.cost_consumption set invalidated_at = now()` by hand and replay
    // with nothing new posted — cannot produce an incident, and that is worth stating so nobody re-writes
    // it that way. The engine is pure and the layer set is unchanged, so a forward pass over invalidated-
    // but-otherwise-identical state recomputes byte-identical consumption values; the delta query's
    // `having sum(after_value - before_value) <> 0` then drops every group, and the run returns
    // `{ movementsReplayed: n, adjustmentsPosted: [] }` having reached no `target` lookup at all. A real
    // back-dated receipt is what makes the deltas non-zero and drives the job into note 6's branch.
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, { documentTypeId: receiptType, warehouseId, jobs, effectiveDate: "2026-07-02",
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "90.0000" }] });
    expect(jobs.enqueued).toEqual([{ name: "inventory.cost.replay", payload: { companyId: s.company }, singletonKey: s.company }]);

    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      tx`update app.fiscal_period set status = 'closed' where company_id = ${s.company} and starts_on >= '2026-06-01'`);

    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const out = await replay(db.rw, { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } }, ctx);
    // July to December all moved, and every one of those six periods is now closed with no open period
    // after it — so the layers are rewritten and NOTHING is posted. Not "fewer than eight": none.
    expect(out.adjustmentsPosted).toEqual([]);
    expect(out.movementsReplayed).toBeGreaterThan(0);

    const [incident] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name = 'integrity_incident'`);
    // Six, derived rather than guessed: the delta query's `replayed` CTE requires an invalidated
    // consumption generation, so the 2026-07-02 RECEIPT contributes nothing and the six issues of
    // 2026-07-06 … 2026-12-06 are the whole set — one (fiscal period, branch) group each, one branch, each
    // delta non-zero because the 10 @ 90.0000 layer moves every average from July onward.
    expect(incident!.n).toBe(6);

    // The operator's instruction is in the summary, by name — not a bare "replay failed". 1B writes the
    // whole IntegrityReport into `app.audit_log.after` (1b:1610-1614); the column is `after`, not `new_data`.
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ after: { summary: string } }[]>`
      select after from app.audit_log where table_name = 'integrity_incident' order by seq desc limit 1`);
    expect(row!.after.summary).toMatch(/no open fiscal period on or after 2026-\d{2}-\d{2}/);
    expect(row!.after.summary).toMatch(/accounting\.period\.reopen/);
  }, 600_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- test/costing/replay.test.ts`
Expected: **FAIL** with `Cannot find module '../../src/costing/replay'` — the module does not exist yet (the suite imports it relatively; `packages/db` may not name `@dulja/db`, see Global Constraints). The `beforeAll` runs to completion, which is itself worth confirming: twenty-four forward-dated documents post with an empty `jobs.enqueued`, so Task 7's back-dating predicate is not firing on same-or-later dates.

- [ ] **Step 3: Write `packages/db/src/costing/replay.ts`**

```ts
import { costingEngine, CostingError, Money, Quantity, type Layer } from "@dulja/domain";
import type { Sql } from "postgres";
import { openLayersFor } from "./apply-movements";
import { resolveAdjustmentAccounts, COST_ADJUSTMENT_CODE } from "./cost-adjustment";
import { recordIntegrityIncident } from "../integrity";
import { postDocument } from "../posting/post";
import { PostingError } from "../posting/errors";
import { withTenant, type TenantContext } from "../with-tenant";
import type { JobEnvelope } from "../jobs/enqueue";

/** spec:1368 — long jobs run as many short transactions, never one long one. */
export const MOVEMENTS_PER_BATCH = 500;

/** The §4.3.5 chronological key, as a value. */
interface Key { effectiveDate: string; postingSeq: bigint; lineNo: number; movementNo: number }

interface MovementRow {
  id: string; documentId: string; itemId: string; warehouseId: string; lotId: string;
  lineNo: number; movementNo: number; quantity: string; value: string;
  effectiveDate: string; postingSeq: string; layerId: string | null; layerQtyIn: string | null;
}

/**
 * §4.7.2's job handler. Replays movements forward from the earliest invalidation in bounded batches,
 * rewrites layers and consumptions, and posts one `COST_ADJUSTMENT` per (fiscal period, branch) whose
 * COGS total moved (spec:1224). Idempotent and restartable (LEGACY-054): every write is a formula over
 * committed state, so a crash mid-run leaves the next run computing the same resume point.
 *
 * Opens its OWN transactions — it is given `sql`, not a `tx` — because one transaction over twelve months
 * of movements would hold the per-tenant audit lock to commit (spec:1368).
 */
export async function replay(
  sql: Sql, job: JobEnvelope<{ companyId: string }>, ctx: TenantContext,
): Promise<{ movementsReplayed: number; adjustmentsPosted: string[] }> {
  const companyId = job.payload.companyId;

  // ── 1. What needs work, and from where ──────────────────────────────────────────────────────────
  // "Needs work" is structural, never a boolean somebody remembered to set (LEGACY-005): a layer that is
  // invalidated, or a movement whose only consumptions are invalidated.
  const scope = await withTenant(sql, ctx, (tx) => tx<{
    item_ids: string[] | null; effective_date: string | null; posting_seq: string | null; line_no: number | null; movement_no: number | null;
  }[]>`
    with needy as (
      select m.item_id, m.effective_date, m.posting_seq, m.line_no, m.movement_no
        from app.inventory_movement m
        join app.cost_layer l on l.tenant_id = m.tenant_id and l.movement_id = m.id
       where m.company_id = ${companyId} and l.invalidated_at is not null
      union all
      select m.item_id, m.effective_date, m.posting_seq, m.line_no, m.movement_no
        from app.inventory_movement m
       where m.company_id = ${companyId}
         and exists (select 1 from app.cost_consumption c where c.tenant_id = m.tenant_id and c.movement_id = m.id and c.invalidated_at is not null)
         and not exists (select 1 from app.cost_consumption c where c.tenant_id = m.tenant_id and c.movement_id = m.id and c.invalidated_at is null)
    )
    select array_agg(distinct item_id)                   as item_ids,
           min(effective_date)::text                     as effective_date,
           (select posting_seq::text from needy order by effective_date, posting_seq, line_no, movement_no limit 1) as posting_seq,
           (select line_no          from needy order by effective_date, posting_seq, line_no, movement_no limit 1) as line_no,
           (select movement_no      from needy order by effective_date, posting_seq, line_no, movement_no limit 1) as movement_no
      from needy`);

  const itemIds = scope[0]?.item_ids ?? null;
  if (!itemIds || itemIds.length === 0 || !scope[0]?.effective_date) {
    return { movementsReplayed: 0, adjustmentsPosted: [] };
  }
  const from: Key = {
    effectiveDate: scope[0].effective_date, postingSeq: BigInt(scope[0].posting_seq!),
    lineNo: scope[0].line_no!, movementNo: scope[0].movement_no!,
  };

  const accounts = await withTenant(sql, ctx, (tx) => resolveAdjustmentAccounts(tx, companyId));

  // ── 2. Re-invalidate, then restore. One transaction, in this order (notes 4, 7) ─────────────────
  await withTenant(sql, ctx, async (tx) => {
    // Note 7: a document may have POSTED between `invalidateFrom` and this run. Its movement is at or after
    // `from` and carries a VALID consumption set, so the forward pass would insert a second valid set beside
    // it and the "before/after" arithmetic would compare a movement against itself. Re-running the
    // invalidation over the same window closes that window and gives such a movement a correct "before"
    // generation. It is idempotent: only rows that are still valid get stamped.
    await tx`
      update app.cost_layer
         set invalidated_at = now()
       where company_id = ${companyId}
         and item_id = any(${itemIds}::uuid[])
         and (effective_at, sequence) >= (${from.effectiveDate}::date, ${from.postingSeq.toString()}::bigint)
         and invalidated_at is null`;
    await tx`
      update app.cost_consumption c
         set invalidated_at = now()
        from app.inventory_movement m
       where m.tenant_id = c.tenant_id and m.id = c.movement_id
         and m.company_id = ${companyId}
         and m.item_id = any(${itemIds}::uuid[])
         and (m.effective_date, m.posting_seq) >= (${from.effectiveDate}::date, ${from.postingSeq.toString()}::bigint)
         and c.invalidated_at is null`;
    // The restore pass — a formula, so a crash-restart re-runs it harmlessly (note 4).
    await tx`
      update app.cost_layer l
         set qty_remaining = l.qty_in - coalesce((
               select sum(c.quantity) from app.cost_consumption c
                where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is null), 0)
       where l.company_id = ${companyId}
         and exists (select 1 from app.cost_consumption c
                      where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is not null)`;
  });

  // ── 3. The forward pass, in bounded batches ─────────────────────────────────────────────────────
  let cursor = from;
  let movementsReplayed = 0;
  const company = (await withTenant(sql, ctx, (tx) => tx<{ base_currency: string; costing_method: string }[]>`
    select base_currency, costing_method from app.company where id = ${companyId}`))[0]!;
  const baseCurrency = company.base_currency as Parameters<typeof Money.of>[1];
  const method = company.costing_method as "avco" | "fifo";

  for (;;) {
    const done = await withTenant(sql, ctx, async (tx) => {
      const rows = await tx<MovementRow[]>`
        select m.id::text as "id", m.document_id::text as "documentId", m.item_id::text as "itemId",
               m.warehouse_id::text as "warehouseId", m.lot_id::text as "lotId",
               m.line_no as "lineNo", m.movement_no as "movementNo",
               m.quantity::text as "quantity", m.value::text as "value",
               m.effective_date::text as "effectiveDate", m.posting_seq::text as "postingSeq",
               l.id::text as "layerId", l.qty_in::text as "layerQtyIn"
          from app.inventory_movement m
          left join app.cost_layer l on l.tenant_id = m.tenant_id and l.movement_id = m.id
         where m.company_id = ${companyId}
           and m.item_id = any(${itemIds}::uuid[])
           and (m.effective_date, m.posting_seq, m.line_no, m.movement_no)
               >= (${cursor.effectiveDate}::date, ${cursor.postingSeq.toString()}::bigint, ${cursor.lineNo}::int, ${cursor.movementNo}::int)
         order by m.effective_date, m.posting_seq, m.line_no, m.movement_no
         limit ${MOVEMENTS_PER_BATCH}`;
      if (rows.length === 0) return true;

      // Thread the layer state in memory across the batch, exactly as applyMovements does — one read per
      // (item, warehouse), one write per touched layer at the end.
      const layerState = new Map<string, Layer[]>();
      const finalRemaining = new Map<string, Quantity>();

      for (const m of rows) {
        const key = `${m.itemId}/${m.warehouseId}`;
        if (!layerState.has(key)) {
          layerState.set(key, await openLayersFor(tx, { companyId, itemId: m.itemId, warehouseId: m.warehouseId, baseCurrency }));
        }
        const open = layerState.get(key)!;
        const magnitude = Quantity.of(m.quantity.startsWith("-") ? m.quantity.slice(1) : m.quantity);
        const value = Money.of(m.value.startsWith("-") ? m.value.slice(1) : m.value, baseCurrency);
        const isIssue = m.quantity.startsWith("-");

        if (!isIssue) {
          // `m.layerId` comes from a LEFT JOIN and is nullable, so the two conditions are split rather than
          // combined: a receipt with no layer row must NOT fall through to the issue branch below, which
          // would cost it against the layers, insert cost_consumption rows for a positive movement and
          // overwrite its document_line.cost with a consumption total. Such a row can only be a movement
          // posted by 3A's provisional body — which is exactly what Task 13's `reseed-verify` counts and
          // refuses to back-fill (§4.7.2) — so this raises and says which action to take.
          if (!m.layerId) {
            throw new PostingError(
              "ERR_INTERNAL",
              `replay: receipt movement ${m.id} has no cost_layer row; it was posted before this slice's applyMovements landed — re-seed rather than replay (contracts §4.7.2, Task 13 Step 7)`,
            );
          }
          // Its layer's unit_cost comes from the movement's own immutable value, so the recost
          // restores the layer and re-opens it. `unit_cost` is recomputed rather than trusted, because 3C's
          // landed-cost allocation is the one thing that legitimately changes a receipt's value.
          const unitCost = value.divide(magnitude.toDecimal(), "HALF_AWAY_FROM_ZERO");
          await tx`
            update app.cost_layer
               set unit_cost = ${unitCost.toString()}, qty_in = ${magnitude.toString()},
                   qty_remaining = ${magnitude.toString()}, invalidated_at = null
             where id = ${m.layerId}`;
          open.push({
            id: m.layerId, itemId: m.itemId, warehouseId: m.warehouseId, lotId: m.lotId, movementId: m.id,
            qtyIn: magnitude, unitCost, qtyRemaining: magnitude,
            effectiveDate: m.effectiveDate, postingSeq: BigInt(m.postingSeq), lineNo: m.lineNo, movementNo: m.movementNo,
          });
          finalRemaining.set(m.layerId, magnitude);
          movementsReplayed += 1;
          continue;
        }

        // An issue: recompute the consumption set. `allowShortfall` is true here and only here — the
        // movement is already posted and its override, if any, was authorised at post time; refusing now
        // would abort a correction over a historical excursion, which is LEGACY-054 exactly.
        let out;
        try {
          out = costingEngine.cost({
            method, openLayers: open, allowShortfall: true,
            movement: {
              lineNo: m.lineNo, movementNo: m.movementNo, itemId: m.itemId, warehouseId: m.warehouseId,
              lotId: m.lotId, quantity: magnitude, effect: "issue", value, costing: "consume_layers",
              effectiveDate: m.effectiveDate, postingSeq: BigInt(m.postingSeq), movementId: m.id,
            },
          });
        } catch (error) {
          if (error instanceof CostingError) throw new PostingError(error.code, `replay of movement ${m.id}: ${error.detail}`);
          throw error;
        }

        for (const c of out.consumptions) {
          await tx`
            insert into app.cost_consumption (tenant_id, company_id, movement_id, layer_id, quantity, unit_cost, value)
            values (${ctx.tenantId}, ${companyId}, ${m.id}, ${c.layerId}, ${c.quantity.toString()}, ${c.unitCost.toString()}, ${c.value.toString()})`;
        }
        const remaining = new Map(out.updatedRemaining.map((u) => [u.layerId, u.qtyRemaining]));
        layerState.set(key, open.map((l) => (remaining.has(l.id) ? { ...l, qtyRemaining: remaining.get(l.id)! } : l))
                                .filter((l) => !l.qtyRemaining.isZero()));
        for (const u of out.updatedRemaining) finalRemaining.set(u.layerId, u.qtyRemaining);

        // Note 2: document_line.cost is the CURRENT answer and is rewritten.
        await tx`update app.document_line set cost = ${out.value.toString()} where document_id = ${m.documentId} and line_no = ${m.lineNo}`;
        movementsReplayed += 1;
      }

      for (const [layerId, qty] of finalRemaining) {
        await tx`update app.cost_layer set qty_remaining = ${qty.toString()} where id = ${layerId}`;
      }
      const last = rows[rows.length - 1]!;
      cursor = { effectiveDate: last.effectiveDate, postingSeq: BigInt(last.postingSeq), lineNo: last.lineNo, movementNo: last.movementNo + 1 };
      return rows.length < MOVEMENTS_PER_BATCH;
    });
    if (done) break;
  }

  // ── 4. The adjustment, one per (fiscal period, branch) whose COGS moved (notes 5, 6) ────────────
  const deltas = await withTenant(sql, ctx, (tx) => tx<{ fiscal_period_id: string; branch_id: string; delta: string; source: string }[]>`
    with replayed as (
      select m.id, m.document_id, m.warehouse_id,
             coalesce((select sum(c.value) from app.cost_consumption c
                        where c.tenant_id = m.tenant_id and c.movement_id = m.id and c.invalidated_at is null), 0) as after_value,
             coalesce((select sum(c.value) from app.cost_consumption c
                        where c.tenant_id = m.tenant_id and c.movement_id = m.id
                          and c.invalidated_at = (select max(c2.invalidated_at) from app.cost_consumption c2
                                                   where c2.tenant_id = m.tenant_id and c2.movement_id = m.id
                                                     and c2.invalidated_at is not null)), 0) as before_value
        from app.inventory_movement m
       where m.company_id = ${companyId}
         and m.item_id = any(${itemIds}::uuid[])
         and (m.effective_date, m.posting_seq, m.line_no, m.movement_no)
             >= (${from.effectiveDate}::date, ${from.postingSeq.toString()}::bigint, ${from.lineNo}::int, ${from.movementNo}::int)
         and exists (select 1 from app.cost_consumption c where c.tenant_id = m.tenant_id and c.movement_id = m.id and c.invalidated_at is not null)
    )
    select d.fiscal_period_id::text as fiscal_period_id, w.branch_id::text as branch_id,
           sum(r.after_value - r.before_value)::text as delta,
           min(d.effective_date)::text as source
      from replayed r
      join app.document  d on d.tenant_id = ${ctx.tenantId} and d.id = r.document_id
      join app.warehouse w on w.tenant_id = ${ctx.tenantId} and w.id = r.warehouse_id
     group by 1, 2
    having sum(r.after_value - r.before_value) <> 0`);

  const adjustmentsPosted: string[] = [];
  for (const row of deltas) {
    const delta = Money.of(row.delta, baseCurrency);
    const posted = await withTenant(sql, ctx, async (tx) => {
      const [target] = await tx<{ id: string; starts_on: string; ends_on: string; same: boolean }[]>`
        select p.id::text as id, p.starts_on::text as starts_on, p.ends_on::text as ends_on,
               (p.id = ${row.fiscal_period_id}) as same
          from app.fiscal_period p
         where p.company_id = ${companyId} and p.status = 'open'
           and p.starts_on >= (select starts_on from app.fiscal_period where id = ${row.fiscal_period_id})
         order by p.starts_on limit 1`;
      if (!target) {
        // Note 6: no open period on or after the affected one. The layers are already right; the ledger is
        // not, and a human has to reopen a period. Record it and stop — never retry forever.
        //
        // 1B's signature is `recordIntegrityIncident(tx: Sql, report: IntegrityReport)` (1b:1240) and its
        // body inserts `report.tenantId` into app.audit_log.tenant_id (NOT NULL) and `report.requestId` into
        // row_id — so the argument is a whole IntegrityReport, not a loose `{ companyId, detail }`. This run
        // checked no projection and walked no chain, so every other member is its empty value and `summary`
        // carries the sentence an operator reads. No second sentinel table_name is invented: 1B writes
        // 'integrity_incident', which is what this task's Step 1 asserts.
        await recordIntegrityIncident(tx, {
          tenantId: ctx.tenantId,
          requestId: ctx.requestId,
          checkedAt: new Date().toISOString(),
          ledgerBalance: { byPeriod: [], byDocument: [] },
          projections: { checked: [], mismatches: [] },
          auditChain: { rows: 0, brokenLinks: 0, badHashes: 0, firstBrokenSeq: null },
          periodReopens: [],
          ok: false,
          summary: `FAILED: cost replay of company ${companyId} recomputed ${movementsReplayed} movement(s) but found no open fiscal period on or after ${row.source} to post the ${delta.toString()} adjustment into; reopen a period under accounting.period.reopen and re-enqueue inventory.cost.replay`,
        });
        return null;
      }
      // `row.source` is the earliest REPLAYED document date in this (period, branch) group — the point the
      // recomputation ran forward from — not necessarily the back-dated document itself.
      const notes = target.same
        ? `Cost replay adjustment. Recomputed from ${row.source} forward.`
        : `Cost replay adjustment. Recomputed from ${row.source} forward; source period ${row.source.slice(0, 7)} is closed, so this entry posts in the earliest open period on or after it.`;
      const [doc] = await tx<{ id: string }[]>`
        insert into app.document (tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id, notes)
        values (${ctx.tenantId}, ${companyId}, ${accounts.documentTypeId}, 'CA',
                ${target.same ? row.source : target.starts_on}, ${baseCurrency}, ${row.branch_id}, ${notes})
        returning id::text as id`;
      // Amendment A12: the JOB supplies the direction, because document_line.debit has check (debit >= 0).
      const rose = !delta.isNegative();
      const amount = delta.abs().toString();
      await tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, debit, credit, description)
        values (${ctx.tenantId}, ${companyId}, ${doc!.id}, 1, 'account',
                ${rose ? accounts.cogsAccountId : accounts.inventoryAccountId}, ${amount}, '0.0000',
                ${rose ? "Recomputed cost of goods sold" : "Recomputed inventory value"})`;
      await tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, debit, credit, description)
        values (${ctx.tenantId}, ${companyId}, ${doc!.id}, 2, 'account',
                ${rose ? accounts.inventoryAccountId : accounts.cogsAccountId}, '0.0000', ${amount},
                ${rose ? "Recomputed inventory value" : "Recomputed cost of goods sold"})`;
      // `inventory.effect: "none"` (Task 8), so step 14 never consults `jobs` and none is passed.
      await postDocument(tx, ctx, { documentId: doc!.id });
      return doc!.id;
    });
    if (posted) adjustmentsPosted.push(posted);
  }

  return { movementsReplayed, adjustmentsPosted };
}
```

One thing about that body a reader will want to check. `Money.of(row.delta, …)` receives a signed string, which `Money.of` accepts; the sign is then moved into *which account gets the debit*, which is amendment A9's discipline (§4.4.2's ⚠️ names 3B first: read the direction, never `amount.isNegative()` — and here the direction is `rose`).

- [ ] **Step 4: Register the handler (amendment A6) and probe it (hazard 31)**

`apps/worker/src/handlers/cost-replay.ts` — §4.7.2 gives `replay` a return value and §4.2.6's `JobHandler<N>` returns `Promise<void>`, so the registration adapts:

```ts
import { replay } from "@dulja/db";
import { registerHandler } from "../handler";
import { log } from "../log";

registerHandler("inventory.cost.replay", async (sql, job, ctx) => {
  const result = await replay(sql, job, ctx);
  log().info(
    { job: "inventory.cost.replay", companyId: job.payload.companyId, ...result },
    "cost replay finished",
  );
});
```

`apps/worker/src/index.ts` gains `import "./handlers/cost-replay";` beside the existing handler imports, so registration runs at boot.

`tests/invariants/probes.ts` gains one `JOB_PROBES` entry:

```ts
  "inventory.cost.replay": {
    async seed(db, attacker, victim) {
      // The victim gets one layer; the attacker's job will be enqueued with the VICTIM's companyId.
      await seedCostLayerFixture(db, victim);
    },
    async survivors(db, victim) {
      const [row] = await withTenant(db.rw, victim.tenant, victim.human, (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.cost_layer where invalidated_at is null`);
      return row!.n;
    },
  },
```

`seedCostLayerFixture` is local to `probes.ts` (it posts one receipt through `postInventoryDocument`) — the probe registry is test-tier code and §4.17.1 does not register per-probe helpers.

- [ ] **Step 5: Write `apps/worker/test/handlers/cost-replay.test.ts`**

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker, type StartedWorker } from "../support/worker";
import { PERMISSIONS } from "@dulja/contracts";
import { loadDocumentTypes } from "@dulja/db/seed";
import { grantCodes, seedDocumentType, seedItem, seedTenantV2, seedWarehouse, withTenant } from "@dulja/db/test";
import { postInventoryDocument, STOCK_ISSUE_COST_POLICY, STOCK_RECEIPT_COST_POLICY } from "../../../../tests/invariants/support/post-inventory";

/** `apps/worker/test/handlers/` → four levels up is the repo root. Derived here rather than imported from
 *  `tests/support/source`: A21(c)’s `dependency-rule` allowance covers `tests/invariants/support/**` only,
 *  and widening it a fourth time to reach one constant is worse than four `..` segments. This tier MAY
 *  import `@dulja/contracts` and `@dulja/db/seed` — TIER["apps/worker"] lists both (0b:5058). */
const TYPES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..",
                   "packages", "db", "seed", "my", "document-types");

describe("inventory.cost.replay through the worker", () => {
  let w: StartedWorker;
  beforeAll(async () => { w = await startWorker(); }, 180_000);
  afterAll(async () => { await w.stop(); });

  it("the handler is registered under its JOBS name and logs what it did", async () => {
    const s = await seedTenantV2(w.db, "WorkerReplay");
    await grantCodes(w.db, s);
    // `seedItem` below seeds 1300, 5000 and 5900 idempotently (3A's ITEM_DEFAULT_ACCOUNTS).
    const receipt = await seedDocumentType(w.db, s, { code: "STOCK_RECEIPT_TEST", module: "inventory", policy: STOCK_RECEIPT_COST_POLICY });
    const issue = await seedDocumentType(w.db, s, { code: "STOCK_ISSUE_TEST", module: "inventory", policy: STOCK_ISSUE_COST_POLICY });
    const { itemId } = await seedItem(w.db, s, { code: "W-1" });
    const warehouseId = await seedWarehouse(w.db, s, { code: "W-WH" });
    // `startWorker()` starts the container, applies the migrations and installs pg-boss — it does NOT load
    // the seed packs (0d:2350). The back-dated receipt below makes the replay post one adjustment, and
    // `resolveAdjustmentAccounts` raises `ERR_NOT_FOUND` on a company with no `COST_ADJUSTMENT` row before
    // it computes anything, so without this the assertion below would fail on a seeding gap.
    await withTenant(w.db.migrator, s.tenant, s.system, (tx) =>
      loadDocumentTypes(tx, { tenantId: s.tenant, actorId: s.system, requestId: crypto.randomUUID() },
                        TYPES, PERMISSIONS.map((p) => p.code)));

    // The real JobClient: postDocument's step 14 enqueues into pgboss on the posting transaction.
    await postInventoryDocument(w.db, s, { documentTypeId: receipt, warehouseId, jobs: w.jobs, effectiveDate: "2026-03-01",
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "5.0000" }] });
    await postInventoryDocument(w.db, s, { documentTypeId: issue, warehouseId, jobs: w.jobs, effectiveDate: "2026-03-02",
      lines: [{ itemId, warehouseId, quantity: "4.000000", unitPrice: "9.0000" }] });
    await postInventoryDocument(w.db, s, { documentTypeId: receipt, warehouseId, jobs: w.jobs, effectiveDate: "2026-02-01",
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "15.0000" }] });

    await w.run("inventory.cost.replay", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { companyId: s.company } });
    // `CapturedLog` is `{ level, fields, msg }` (0d:2340) and the handler spreads `...result` into the
    // FIELDS object, so the two counters are read off `fields` — `l.movementsReplayed` would not compile.
    const finished = w.logs.filter((l) => l.msg === "cost replay finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]!.fields).toMatchObject({
      job: "inventory.cost.replay", companyId: s.company, movementsReplayed: 3,
    });
    expect(finished[0]!.fields["adjustmentsPosted"]).toHaveLength(1);
  }, 600_000);
});
```

- [ ] **Step 6: Write ADR 0038**

`docs/adr/0038-bounded-restartable-recost-and-the-cost-adjustment-document.md`, Plan 0A's format (plan0A:189–203):

```markdown
# ADR 0038: A recost is bounded, restartable and visible

- **Status:** Accepted
- **Date:** 2026-09-07
- **Deciders:** Phase 3B
- **Spec:** §3.4 (spec:1220–1224), §3.8 transactions (spec:1368), Part VI test 5 (spec:2423), Part I LEGACY-004, 005, 010, 054

## Context

The old system's recost was one all-or-nothing transaction over every material, entered from two code
paths that ordered their work differently — one by document id, one by date (LEGACY-005) — and aborted on
the first historical below-cost sale, rolling back every material already processed (LEGACY-054). Its
incremental mode visited only materials whose dirty flag was set, and the flag was set from three of the
four code paths that could dirty one, so `vForce=0` was a silent-wrong-answer mode.

## Decision

Six things, and each one is a direct answer to one of those failures.

1. **An issue's `inventory_movement.value` is never rewritten.** The movement table is immutable
   (`forbid_change`); the recost rewrites `cost_consumption` and books the difference as a
   `COST_ADJUSTMENT`. spec:1224's "never silently rewriting posted history", read literally.
2. **`document_line.cost` IS rewritten.** It is the current answer, read by reversals, by 3D's
   `line.variance_value` and by every margin report; two answers to one question is LEGACY-009.
3. **A layer is UPDATEd, never re-inserted** — `unique (movement_id)` makes that structural.
4. **The restore pass is a formula** (`qty_remaining = qty_in − Σ valid consumptions`), so a crash-restart
   re-runs it harmlessly and the resume point is derived from committed state, never from a flag.
5. **"Before" is the latest invalidated generation per movement**, selected by `max(invalidated_at)`, so a
   movement recosted twice is not double-counted.
6. **A closed affected period carries the adjustment forward** to the earliest open period on or after it,
   with `document.notes` naming the source period. With no open period, the job records an integrity
   incident and returns rather than retrying until pg-boss dead-letters it.
7. **An authorised shortfall is valued but not consumed, and the layers therefore lag the movements until
   the next receipt. That lag is recognised, not netted, in v1.** When `inventory.negative_stock.override`
   authorises an issue the open layers cannot cover (F-6, test 18), the uncovered quantity is *valued* at
   the running average and produces **no** `cost_consumption` row — `cost_consumption.layer_id` is NOT NULL
   and there is no layer to point at. So for that `(item, warehouse)`, `Σ layer qty_remaining` exceeds
   `Σ movement.quantity` by the open shortfall — until a **back-dated** receipt makes the replay recompute
   that issue against replenished layers; a later receipt does not close it, because nothing re-consumes a
   historical shortfall — and `document_line.cost` exceeds `Σ cost_consumption.value` by the shortfall's value.
   **Consequences, both stated rather than papered over:** Task 11's nightly quantity compare **excludes
   `(item, warehouse)` pairs with an open shortfall**, naming them in the log rather than raising an
   incident; and `legacy-009`'s tie-out asserts
   `Σ document_line.cost = Σ cost_consumption.value + shortfall value`, which is the true identity.
   **The exclusion is bounded by a test, not by this paragraph:** `packages/db/test/costing/valuation.test.ts`
   opens a shortfall through `overriddenIssue`, asserts the pair appears in `excluded` and **not** in
   `mismatches`, and asserts it moves back into the compared set — with `excluded` empty — as soon as a
   receipt replenishes it. A carve-out that no test pins is a carve-out that quietly widens.

   **PROPOSAL, for the architect to accept or reject before 3C extends a receipt's value (spec:95 — this
   touches money semantics).** Net the shortfall into the next receipt's layer: `qty_remaining = qty_in −
   open shortfall` on that layer, with `(new unit cost − the shortfall's provisional cost) × shortfall`
   booked into the same `COST_ADJUSTMENT` the replay already posts. It makes both nightly compares
   unconditional and removes the exclusion above, and it is almost certainly the right long-term rule.
   It is **not** taken in this slice because it adds a member to a frozen interface — `CostingOutput`
   (§4.7.1) would gain `shortfall: { quantity: Quantity; value: Money } | null`, which `applyMovements`
   would persist and `replay` would consume — and hazard 7 makes a needed deviation a proposal rather than a
   plan task. Recorded here rather than as its own ADR because §3.9 allocates 3B exactly 0037–0039 and all
   three are used; hazard 14 forbids taking a number outside the range. It is also this plan's **second spec
   question**, so the orchestrator surfaces it rather than a reader having to find it in an ADR's note 7.

Batches are `MOVEMENTS_PER_BATCH = 500` per `withTenant` transaction (spec:1368), and the replay never
disables `assert_stock_available` or `forbid_change` — it writes no movement, so neither ever fires.

## Consequences

- Runtime is proportional to the movements at or after the invalidation point, not to total history —
  the clause acceptance test 5 asserts, and it is asserted on **rows** (months 1–2 keep their ids and
  `created_at`), never on a wall clock.
- A recost is visible in the ledger as a document a reader can open, reverse and explain.
- Two adjustments for one back-dated document are possible when its items span branches or periods; that
  is deliberate — `sum(base_debit) = sum(base_credit)` holds per document and BRANCH stays meaningful.
- A company whose chart lacks `1300` or `5000` fails at the top of the job with the seed command in the
  message (Task 8), not at an insert halfway through a batch.
- **Rejected:** a per-item watermark column. It is the shape LEGACY-005's `CstChanged` had, and the whole
  lesson of that defect is that invalidation must be structural — a row's own `invalidated_at` — rather
  than a scalar somebody has to remember to move.
```

- [ ] **Step 7: Run everything to verify it passes**

Run: `bun run --cwd packages/db test -- test/costing/replay.test.ts`
Expected: **PASS**, all eight cases. If `movementsReplayed` reports 22 rather than 21, the resume-point query's `min` is picking a row from the wrong `needy` branch — the two `select … limit 1` sub-selects must order by all four key columns, and the `min(effective_date)` in the outer select must agree with them.

Run: `bun run --cwd apps/worker test -- test/handlers/cost-replay.test.ts`
Expected: **PASS**.

Run: `bun run --cwd tests test -- invariants/tenant-isolation.test.ts`
Expected: **PASS** — the harness now finds a `JOB_PROBES` entry for `inventory.cost.replay`, and `registeredJobNames()` includes it.

Run: `bun run --cwd packages/db test && bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/costing/replay.ts packages/db/src/costing/index.ts \
        apps/worker/src/handlers/cost-replay.ts apps/worker/src/index.ts \
        apps/worker/test/handlers/cost-replay.test.ts packages/db/test/costing/replay.test.ts \
        tests/invariants/probes.ts docs/adr/0038-bounded-restartable-recost-and-the-cost-adjustment-document.md
git commit -m "$(cat <<'EOF'
feat(db): the bounded, restartable cost replay [3B T9]

Acceptance test 5. A back-dated purchase in month 3 of twelve recomputes
months 3-12 and leaves months 1-2 with their ids and created_at intact —
asserted on rows, never on a wall clock.

ADR 0038's six decisions: an issue's immutable movement value is never
rewritten and the difference becomes a COST_ADJUSTMENT; document_line.cost IS
rewritten, because two answers to one question is LEGACY-009; a layer is UPDATEd
under unique (movement_id); the restore pass is a formula so a restart re-runs
it harmlessly; "before" is the latest invalidated generation per movement, so
a twice-recosted movement is not double-counted; a closed source period
carries the entry forward and no open period is an integrity incident, not an
infinite retry.

500 movements per withTenant transaction (spec:1368). No invariant is
disabled: the replay writes no movement, so assert_stock_available and
forbid_change never fire. Rejected: a per-item watermark column — that is
LEGACY-005's CstChanged, and invalidation must be structural.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The valuation read, the `inventory.cost.read` gate, and migration 0036

**Files:**
- Create: `packages/db/src/costing/valuation.ts`, `packages/contracts/src/inventory/valuation.ts`, `apps/api/src/routes/inventory/valuation.ts`, `packages/db/migrations/0036_seed_permission_phase3b.sql`, `packages/db/migrations/0036.down.sql`, `apps/api/test/routes/inventory/valuation.test.ts`
- Modify: `packages/db/src/costing/index.ts`, `packages/contracts/permissions.ts`, `packages/contracts/src/index.ts`, `packages/db/seed/roles.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Consumes: `openLayersFor` (Task 7); `costingEngine.average` (Task 2); `Money`, `Quantity`, `currency`, `CurrencyCode` (contracts §4.2.1); `PERMISSION`, `requirePermission`, `PermissionCode`, `PERMISSIONS`, `RoleSeed`, `ROLES` (§4.2.5, §3.6.4); **3A's `INVENTORY_PERMISSION`** in `apps/api/src/routes/inventory/permissions.ts` — the five typed constants every `inventory` route imports, which this task extends by one member additively; `RouteModule`, `buildRoutes`, `PROBES`, `IsolationProbe` (§4.2.7); `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `MoneySchema`, `QuantitySchema`, `encodeCursor`, `decodeCursor` (§4.2.8); `startApi`, `StartedApi`, `problemOf`, `grantAdmin` (§4.2.12, §4.17.1); `AppEnv` (§4.2.3).
- Produces:

```ts
// packages/db/src/costing/valuation.ts
export interface ValuationParams {
  companyId: string; asOf: string;                       // inclusive, on effective_date — never posted_at (spec:2039)
  itemId?: string | null; warehouseId?: string | null;
  cursor?: { itemCode: string; warehouseCode: string } | null; limit: number;
}
export interface ValuationRow {
  itemId: string; itemCode: string; itemNameEn: string;
  warehouseId: string; warehouseCode: string;
  quantity: string; value: string; unitCost: string;     // strings — a number here is a `no-number-money` violation
}
/** Quantity and value per (item, warehouse) as at `asOf`, from the layers. THE valuation read (spec:1228). */
export async function valuationAsOf(tx: Sql, params: ValuationParams): Promise<ValuationRow[]>;

export interface OpenLayersParams {
  companyId: string; itemId: string; asOf: string;
  warehouseId?: string | null; cursor?: { effectiveAt: string; sequence: string } | null; limit: number;
}
export interface CostLayerRow {
  layerId: string; movementId: string; documentId: string; documentTypeCode: string; number: string | null;
  warehouseId: string; warehouseCode: string; lotId: string; lotCode: string; lotExpiresOn: string | null;
  qtyIn: string; qtyRemaining: string; unitCost: string; value: string; effectiveAt: string; sequence: string;
}
/** The open layers of one item, oldest first — the raw rows 7B's `inventory.stock_ageing` report reads. */
export async function openLayersOf(tx: Sql, params: OpenLayersParams): Promise<CostLayerRow[]>;

// packages/contracts/src/inventory/valuation.ts (§4.2.8's naming convention)
export const ValuationRowSchema: z.ZodObject<…>;
export const ValuationQuery: z.ZodObject<…>;            // asOf, filter[item_id][eq], filter[warehouse_id][eq], cursor, limit
export const ValuationList = ListEnvelope(ValuationRowSchema);
export const CostLayerRowSchema: z.ZodObject<…>;
export const CostLayerQuery: z.ZodObject<…>;
export const CostLayerList = ListEnvelope(CostLayerRowSchema);

// apps/api/src/routes/inventory/valuation.ts (amendment A8)
export const valuationRoutes: OpenAPIHono<AppEnv>;
export const valuationRouteModule: RouteModule;         // path "/v1/companies/:companyId/valuation"
```

**Read this before writing the SQL.** The as-of figure is derived **from the layers**, and every consumer derives it from this one function — that is spec:1228 and the whole reason LEGACY-009 cannot recur. Two clauses make it as-of rather than current:

- a layer counts only if **its own** movement's `effective_date <= asOf` (a receipt after the date has not happened yet); and
- its remaining quantity is `qty_in − Σ(valid consumption quantities whose consuming movement's `effective_date <= asOf`)` — the *consumption's* date, not the layer's.

Value is `Σ round(qty_remaining × unit_cost, 4)` **per layer**, summed — not `average × quantity`. The two differ by a rounding residue at the fourth place, and the per-layer form is the one `stock_valuation` stores and the one a profit report reads, so Task 11's rebuild-and-compare and test 7's tie-out both hold to the cent **whenever each layer's `qty_in × unit_cost` equals its own movement's `value`** — which is every fixture in this slice, because each builds a receipt's value as an integer quantity times a 4-decimal unit price and `round(value ÷ quantity, 4)` returns that price unchanged. The case where it does **not** — a receipt whose value does not divide by its quantity, which `app.cost_layer` can only represent to the nearest cent because it stores `unit_cost` and no `value` column (§4.7.3, contracts:3076–3079) — is the §4.7.3 residual, and it is the fourth blocker in the Execution handoff, not something to round away here.

**This is not a report code.** `inventory.valuation` in §4.16.1 is **3D's** `ReportCode`, mounted on 1B's `reports` module; this is an ordinary list endpoint on its own module (amendment A8), and the two never collide because they are different modules on different paths. 3D's report reads `valuationAsOf`; it does not re-derive anything.

- [ ] **Step 1: Write the failing test `apps/api/test/routes/inventory/valuation.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts";
import { grantAdmin, problemOf, startApi, type StartedApi } from "../../support/app";
import { grantCodes, seedDocumentType, seedItem, seedTenantV2, seedWarehouse, type Seed } from "@dulja/db/test";
import { postInventoryDocument, STOCK_ISSUE_COST_POLICY, STOCK_RECEIPT_COST_POLICY } from "../../../../../tests/invariants/support/post-inventory";

describe("GET /v1/companies/:companyId/valuation (inventory.cost.read; amendment A8)", () => {
  let api: StartedApi; let s: Seed; let itemId: string; let warehouseId: string; let token: string;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Valuation");
    await grantCodes(api.db, s, { codes: ["inventory.cost.read", "accounting.journal.post"] });
    token = await api.signToken(`human:${s.tenant}`);   // plan0A:1585 — `Seed` has no `humanSubject` member
    const receipt = await seedDocumentType(api.db, s, { code: "STOCK_RECEIPT_TEST", module: "inventory", policy: STOCK_RECEIPT_COST_POLICY });
    const issue = await seedDocumentType(api.db, s, { code: "STOCK_ISSUE_TEST", module: "inventory", policy: STOCK_ISSUE_COST_POLICY });
    ({ itemId } = await seedItem(api.db, s, { code: "VAL-1" }));
    warehouseId = await seedWarehouse(api.db, s, { code: "V-WH" });
    await postInventoryDocument(api.db, s, { documentTypeId: receipt, warehouseId, effectiveDate: "2026-01-10",
      lines: [{ itemId, warehouseId, quantity: "100.000000", unitPrice: "10.0000" }] });
    await postInventoryDocument(api.db, s, { documentTypeId: receipt, warehouseId, effectiveDate: "2026-02-10",
      lines: [{ itemId, warehouseId, quantity: "100.000000", unitPrice: "20.0000" }] });
    await postInventoryDocument(api.db, s, { documentTypeId: issue, warehouseId, effectiveDate: "2026-02-20",
      lines: [{ itemId, warehouseId, quantity: "50.000000", unitPrice: "40.0000" }] });
  }, 180_000);
  afterAll(async () => { await api.stop(); });

  it("the permission code is in the catalogue exactly once and is non-mutating", () => {
    const rows = PERMISSIONS.filter((p) => p.code === "inventory.cost.read");
    // `toMatchObject` on the three fields this case is about, never `toEqual` on a partial row: `PermissionDef`
    // has five required members (§4.2.5 — `description` and `phase` as well), so a `toEqual` against three of
    // them can only pass against a malformed entry.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ module: "inventory", mutating: false, phase: "3B" });
  });

  it("as at 2026-01-31 only the January layer exists — 100 at 10.0000", async () => {
    const res = await api.app.request(`/v1/companies/${s.company}/valuation?asOf=2026-01-31`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{
      itemId, itemCode: "VAL-1", itemNameEn: expect.any(String),
      warehouseId, warehouseCode: "V-WH",
      quantity: "100.000000", value: "1000.0000", unitCost: "10.0000",
    }]);
  });

  it("as at 2026-02-28 the issue has consumed proportionally — 150 at the 15.0000 average", async () => {
    const res = await api.app.request(`/v1/companies/${s.company}/valuation?asOf=2026-02-28`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    // AVCO took 25 from each layer at 15.0000: 75 × 10 + 75 × 20 = 2250.0000 over 150.000000.
    expect(body.data[0].quantity).toBe("150.000000");
    expect(body.data[0].value).toBe("2250.0000");
    expect(body.data[0].unitCost).toBe("15.0000");
  });

  it("…/valuation/layers returns the open layers oldest first with their residues", async () => {
    const res = await api.app.request(`/v1/companies/${s.company}/valuation/layers?asOf=2026-02-28&filter[item_id][eq]=${itemId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: { effectiveAt: string; qtyRemaining: string; unitCost: string; value: string }) =>
      [r.effectiveAt, r.qtyRemaining, r.unitCost, r.value])).toEqual([
      ["2026-01-10", "75.000000", "10.0000", "750.0000"],
      ["2026-02-10", "75.000000", "20.0000", "1500.0000"],
    ]);
    expect(body.data[0].documentTypeCode).toBe("STOCK_RECEIPT_TEST");
    expect(body.data[0].lotCode).toBe("NONE");
  });

  it("a principal without inventory.cost.read is refused with ERR_RBAC_FORBIDDEN", async () => {
    const other = await seedTenantV2(api.db, "NoRead");
    const otherToken = await api.signToken(`human:${other.tenant}`);
    const res = await api.app.request(`/v1/companies/${other.company}/valuation?asOf=2026-02-28`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("asOf is required — a missing one is a 422, not a silent 'today'", async () => {
    const res = await api.app.request(`/v1/companies/${s.company}/valuation`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd apps/api test -- test/routes/inventory/valuation.test.ts`
Expected: **FAIL** — the catalogue case fails with `[]` (the code is not seeded yet) and every request returns 404 because no module is mounted on that path.

- [ ] **Step 3: Write `packages/db/migrations/0036_seed_permission_phase3b.sql` and its down**

```sql
-- ── 0036. The one permission code slice 3B introduces ────────────────────────────────────────────
-- contracts §3.6.2: inventory / 3B / `inventory.cost.read` / mutating false.
-- app.permission is the one GLOBAL catalogue a migration may write (hazard 10) — every per-tenant row
-- is seed-pack data applied by `bun run seed --tenant`.
insert into app.permission (code, module, mutating)
values ('inventory.cost.read', 'inventory', false)
on conflict (code) do update set module = excluded.module, mutating = excluded.mutating;
```

```sql
-- 0036.down.sql — deletes exactly this slice's code and nothing else (§3.6.3).
delete from app.permission where code = 'inventory.cost.read';
```

`packages/contracts/permissions.ts` gains the matching entry — both halves in one PR, or `packages/db/test/permission-catalogue.test.ts` fails in whichever direction is missing:

```ts
  // All five PermissionDef members (§4.2.5): PERMISSIONS is `as const satisfies readonly PermissionDef[]`,
  // so a three-member entry fails the satisfies check and `bun run typecheck` goes red on the array itself.
  { code: "inventory.cost.read", module: "inventory", mutating: false,
    description: "Read stock valuation and open cost layers", phase: "3B" },
```

**3A's `INVENTORY_PERMISSION` gains one member, additively** — every route under `apps/api/src/routes/inventory/` imports its gate from that object rather than reaching for `PERMISSION` directly, and this slice's route lives in the same directory. Add the sixth key and change nothing else:

```ts
// apps/api/src/routes/inventory/permissions.ts (3A owns this file; 3B adds one line)
export const INVENTORY_PERMISSION = {
  itemRead: PERMISSION["inventory.item.read"],
  itemManage: PERMISSION["inventory.item.manage"],
  priceManage: PERMISSION["inventory.price.manage"],
  stockRead: PERMISSION["inventory.stock.read"],
  negativeStockOverride: PERMISSION["inventory.negative_stock.override"],
  /** 3B — the valuation and cost-layer reads (§3.6.2). Non-mutating, so `auditor` may hold it. */
  costRead: PERMISSION["inventory.cost.read"],
} as const;
```

`packages/db/seed/roles.ts` grants it to **`accountant`, `warehouse`, `branch_manager`, `auditor`** — spec:2157–2163 gives the accountant costing, the warehouse and branch manager stock and margin per branch (spec:1023), and the auditor read-only sight of everything; `mutating: false` is what lets `auditor` hold it at all (§3.6.3's R7 check). `admin`'s array is computed from `PERMISSIONS` and is never edited. Record the grant in contracts §3.6.4's sentence in the same PR.

- [ ] **Step 4: Write `packages/db/src/costing/valuation.ts`**

```ts
import type { Sql } from "postgres";

export interface ValuationParams {
  companyId: string; asOf: string;
  itemId?: string | null; warehouseId?: string | null;
  cursor?: { itemCode: string; warehouseCode: string } | null; limit: number;
}
export interface ValuationRow {
  itemId: string; itemCode: string; itemNameEn: string;
  warehouseId: string; warehouseCode: string;
  quantity: string; value: string; unitCost: string;
}

/**
 * THE valuation read (spec:1228). Every consumer — this slice's route, 3D's `inventory.valuation` report,
 * 4B's `item_profitability`, 7B's re-expression and Task 11's `stock_valuation` rebuild — calls this
 * function. None re-derives it, which is the whole answer to LEGACY-009.
 *
 * As-of, in two clauses: a layer counts only if ITS OWN movement's `effective_date <= asOf`, and its
 * residue subtracts only consumptions whose CONSUMING movement's `effective_date <= asOf`. Value is
 * `Σ round(qty_remaining × unit_cost, 4)` per layer — never `average × quantity`, which differs by a
 * rounding residue and would put a report and the stored snapshot a cent apart.
 */
export async function valuationAsOf(tx: Sql, params: ValuationParams): Promise<ValuationRow[]> {
  return tx<ValuationRow[]>`
    with layer_asof as (
      select l.id, l.item_id, l.warehouse_id, l.unit_cost,
             l.qty_in - coalesce((
               select sum(c.quantity)
                 from app.cost_consumption c
                 join app.inventory_movement cm on cm.tenant_id = c.tenant_id and cm.id = c.movement_id
                where c.tenant_id = l.tenant_id and c.layer_id = l.id
                  and c.invalidated_at is null
                  and cm.effective_date <= ${params.asOf}::date), 0) as qty_remaining
        from app.cost_layer l
        join app.inventory_movement m on m.tenant_id = l.tenant_id and m.id = l.movement_id
       where l.company_id = ${params.companyId}
         and l.invalidated_at is null
         and m.effective_date <= ${params.asOf}::date
         and (${params.itemId ?? null}::uuid      is null or l.item_id      = ${params.itemId ?? null}::uuid)
         and (${params.warehouseId ?? null}::uuid is null or l.warehouse_id = ${params.warehouseId ?? null}::uuid)
    )
    select i.id::text as "itemId", i.code as "itemCode", i.name_en as "itemNameEn",
           w.id::text as "warehouseId", w.code as "warehouseCode",
           sum(la.qty_remaining)::text as "quantity",
           sum(round(la.qty_remaining * la.unit_cost, 4))::text as "value",
           case when sum(la.qty_remaining) = 0 then '0.0000'
                else round(sum(round(la.qty_remaining * la.unit_cost, 4)) / sum(la.qty_remaining), 4)::text
           end as "unitCost"
      from layer_asof la
      join app.item      i on i.id = la.item_id
      join app.warehouse w on w.id = la.warehouse_id
     group by i.id, i.code, i.name_en, w.id, w.code
    having sum(la.qty_remaining) <> 0
       and (${params.cursor?.itemCode ?? null}::text is null
            or (i.code, w.code) > (${params.cursor?.itemCode ?? null}::text, ${params.cursor?.warehouseCode ?? ""}::text))
     order by i.code, w.code
     limit ${params.limit}`;
}

export interface OpenLayersParams {
  companyId: string; itemId: string; asOf: string;
  warehouseId?: string | null; cursor?: { effectiveAt: string; sequence: string } | null; limit: number;
}
export interface CostLayerRow {
  layerId: string; movementId: string; documentId: string; documentTypeCode: string; number: string | null;
  warehouseId: string; warehouseCode: string; lotId: string; lotCode: string; lotExpiresOn: string | null;
  qtyIn: string; qtyRemaining: string; unitCost: string; value: string; effectiveAt: string; sequence: string;
}

/** The open layers of one item, oldest first on the §4.3.5 key. These are the rows 7B's stock-ageing
 *  report reads and the rows an accountant opens when they want to know why a valuation says what it says. */
export async function openLayersOf(tx: Sql, params: OpenLayersParams): Promise<CostLayerRow[]> {
  return tx<CostLayerRow[]>`
    select l.id::text as "layerId", l.movement_id::text as "movementId",
           m.document_id::text as "documentId", dt.code as "documentTypeCode", d.number::text as "number",
           l.warehouse_id::text as "warehouseId", w.code as "warehouseCode",
           l.lot_id::text as "lotId", lot.code as "lotCode", lot.expires_on::text as "lotExpiresOn",
           l.qty_in::text as "qtyIn",
           (l.qty_in - coalesce((
              select sum(c.quantity) from app.cost_consumption c
                join app.inventory_movement cm on cm.tenant_id = c.tenant_id and cm.id = c.movement_id
               where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is null
                 and cm.effective_date <= ${params.asOf}::date), 0))::text as "qtyRemaining",
           l.unit_cost::text as "unitCost",
           round((l.qty_in - coalesce((
              select sum(c.quantity) from app.cost_consumption c
                join app.inventory_movement cm on cm.tenant_id = c.tenant_id and cm.id = c.movement_id
               where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is null
                 and cm.effective_date <= ${params.asOf}::date), 0)) * l.unit_cost, 4)::text as "value",
           l.effective_at::text as "effectiveAt", l.sequence::text as "sequence"
      from app.cost_layer l
      join app.inventory_movement m on m.tenant_id = l.tenant_id and m.id = l.movement_id
      join app.document      d  on d.tenant_id  = m.tenant_id and d.id  = m.document_id
      join app.document_type dt on dt.id = d.document_type_id
      join app.warehouse     w  on w.tenant_id  = l.tenant_id and w.id  = l.warehouse_id
      join app.lot           lot on lot.tenant_id = l.tenant_id and lot.id = l.lot_id
     where l.company_id = ${params.companyId}
       and l.item_id = ${params.itemId}
       and l.invalidated_at is null
       and m.effective_date <= ${params.asOf}::date
       and (${params.warehouseId ?? null}::uuid is null or l.warehouse_id = ${params.warehouseId ?? null}::uuid)
       and (${params.cursor?.effectiveAt ?? null}::date is null
            or (l.effective_at, l.sequence) > (${params.cursor?.effectiveAt ?? null}::date, ${params.cursor?.sequence ?? "0"}::bigint))
     order by l.effective_at, l.sequence, m.line_no, m.movement_no
     limit ${params.limit}`;
}
```

Both joins are on `id` alone and let RLS do the tenant work: every table in this query is under `tenant_isolation` and the whole statement runs inside `withTenant`, so a composite predicate would add nothing but a second place to get the parameter order wrong.

- [ ] **Step 5: Write the contracts module and the route**

`packages/contracts/src/inventory/valuation.ts` — §4.2.8's naming, with literal `filter[…]` Zod keys (the default mechanism for a narrow surface; `parseFilters` is for a wide one, and this route has two filterable fields):

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, UuidSchema } from "../common";

export const ValuationRowSchema = z.object({
  itemId: UuidSchema, itemCode: z.string(), itemNameEn: z.string(),
  warehouseId: UuidSchema, warehouseCode: z.string(),
  quantity: z.string(), value: z.string(), unitCost: z.string(),
}).openapi("ValuationRow");

export const ValuationQuery = z.object({
  asOf: DateSchema,                                        // REQUIRED: a valuation with no date is a question with no answer
  "filter[item_id][eq]": UuidSchema.optional(),
  "filter[warehouse_id][eq]": UuidSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const ValuationList = ListEnvelope(ValuationRowSchema);

export const CostLayerRowSchema = z.object({
  layerId: UuidSchema, movementId: UuidSchema, documentId: UuidSchema,
  documentTypeCode: z.string(), number: z.string().nullable(),
  warehouseId: UuidSchema, warehouseCode: z.string(),
  lotId: UuidSchema, lotCode: z.string(), lotExpiresOn: DateSchema.nullable(),
  qtyIn: z.string(), qtyRemaining: z.string(), unitCost: z.string(), value: z.string(),
  effectiveAt: DateSchema, sequence: z.string(),
}).openapi("CostLayerRow");

export const CostLayerQuery = ValuationQuery.extend({
  "filter[item_id][eq]": UuidSchema,                       // required here — layers are read one item at a time
});
export const CostLayerList = ListEnvelope(CostLayerRowSchema);
```

`packages/contracts/src/index.ts` gains `export * from "./inventory/valuation";`.

`apps/api/src/routes/inventory/valuation.ts`:

```ts
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { CostLayerList, CostLayerQuery, ValuationList, ValuationQuery } from "@dulja/contracts";
import { openLayersOf, valuationAsOf } from "@dulja/db";
// `requirePermission` lives in `apps/api/src/middleware/require-permission.ts` (contracts §4.2.5), NOT in
// `@dulja/contracts` — that module exports only `PERMISSIONS`, `PERMISSION`, `PermissionCode` and
// `isMutating`. 0B, 0D, 1A and 1B all spell this import exactly this way.
import { requirePermission } from "../../middleware/require-permission";
import { INVENTORY_PERMISSION } from "./permissions";
import { decodeCursor, encodeCursor } from "@dulja/contracts";
import type { AppEnv } from "../../context";
import type { RouteModule } from "../index";

export const valuationRoutes = new OpenAPIHono<AppEnv>();

valuationRoutes.openapi(
  createRoute({
    method: "get", path: "/",
    request: { query: ValuationQuery },
    responses: { 200: { description: "Quantity and value per item and warehouse as at a date", content: { "application/json": { schema: ValuationList } } } },
    // `ScopeSource` is a closed four-variant union (§4.2.5) and `{ company: "param" }` is not one of them.
    // The module mounts at /v1/companies/:companyId/valuation, which is exactly what "path:companyId" reads.
    middleware: [requirePermission(INVENTORY_PERMISSION.costRead, { company: "path:companyId" })],
    tags: ["inventory"],
  }),
  async (c) => {
    const q = c.req.valid("query");
    // `c.var.withTenant` — the request-scoped helper, which IS `withTenant(db, c.var.ctx, fn)` bound to
    // this request (§4.2.3). `c.var.db` does not exist: the registered `Variables` set is the eight members
    // §4.2.3 pins (this slice's amendment A5 adds the eighth, `jobs`), and a slice adding a ninth amends
    // that block first. This route adds none.
    const rows = await c.var.withTenant((tx) => valuationAsOf(tx, {
      companyId: c.req.param("companyId")!, asOf: q.asOf,
      itemId: q["filter[item_id][eq]"] ?? null, warehouseId: q["filter[warehouse_id][eq]"] ?? null,
      cursor: q.cursor ? decodeCursor<{ itemCode: string; warehouseCode: string }>(q.cursor) : null,
      limit: q.limit,
    }));
    const next = rows.length === q.limit
      ? encodeCursor({ itemCode: rows[rows.length - 1]!.itemCode, warehouseCode: rows[rows.length - 1]!.warehouseCode })
      : null;
    return c.json({ data: rows, next_cursor: next }, 200);
  },
);

valuationRoutes.openapi(
  createRoute({
    method: "get", path: "/layers",
    request: { query: CostLayerQuery },
    responses: { 200: { description: "The open cost layers of one item, oldest first", content: { "application/json": { schema: CostLayerList } } } },
    middleware: [requirePermission(INVENTORY_PERMISSION.costRead, { company: "path:companyId" })],
    tags: ["inventory"],
  }),
  async (c) => {
    const q = c.req.valid("query");
    const rows = await c.var.withTenant((tx) => openLayersOf(tx, {
      companyId: c.req.param("companyId")!, itemId: q["filter[item_id][eq]"], asOf: q.asOf,
      warehouseId: q["filter[warehouse_id][eq]"] ?? null,
      cursor: q.cursor ? decodeCursor<{ effectiveAt: string; sequence: string }>(q.cursor) : null,
      limit: q.limit,
    }));
    const last = rows[rows.length - 1];
    return c.json({ data: rows, next_cursor: rows.length === q.limit && last ? encodeCursor({ effectiveAt: last.effectiveAt, sequence: last.sequence }) : null }, 200);
  },
);

export const valuationRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/valuation",
  router: valuationRoutes,
  permissions: ["inventory.cost.read"],
  auth: "human",
};
```

`apps/api/src/routes/index.ts` registers it **inside `buildRoutes`** (§4.2.7: `ROUTES` is derived, never pushed onto):

```ts
    valuationRouteModule,
```

`tests/invariants/probes.ts` gains one entry, keyed by that exact path (hazard 31; a sub-path needs none):

```ts
  "/v1/companies/:companyId/valuation": {
    async seed(_db, owner) {
      return { path: `/v1/companies/${owner.company}/valuation?asOf=2026-12-31`, method: "GET" };
    },
    expect: 403,
  },
```

`TENANT_FREE` is untouched — this route answers about rows, not about the caller.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test -- test/routes/inventory/valuation.test.ts`
Expected: **PASS**, all six cases.

Run: `bun run --cwd packages/db test -- test/permission-catalogue.test.ts test/privileges.test.ts`
Expected: **PASS** — the catalogue test compares `app.permission` to `permissions.ts` in both directions, and the reversibility test now applies and rolls back 0034–0036.

Run: `bun run --cwd tests test -- invariants/tenant-isolation.test.ts`
Expected: **PASS** — every `ROUTES` entry has a `PROBES` key and every key matches a route.

Run: `bun run --cwd packages/contracts openapi:generate && git diff --exit-code packages/contracts/openapi.json`
Expected: a **diff**, which you commit — CI regenerates and fails on an *uncommitted* diff (spec:2055).

Run: `bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS. `role-seed` (§3.6.3) is the rule to watch: it fails if `auditor` holds a `mutating = true` code, and `inventory.cost.read` is `false`, which is why the auditor may have it.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0036_seed_permission_phase3b.sql packages/db/migrations/0036.down.sql \
        packages/db/src/costing/valuation.ts packages/db/src/costing/index.ts \
        packages/contracts/src/inventory/valuation.ts packages/contracts/src/index.ts \
        packages/contracts/permissions.ts packages/contracts/openapi.json packages/db/seed/roles.ts \
        apps/api/src/routes/inventory/valuation.ts apps/api/src/routes/index.ts \
        apps/api/test/routes/inventory/valuation.test.ts tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(api): the valuation read under inventory.cost.read [3B T10]

valuationAsOf is THE valuation function (spec:1228): this route, 3D's
inventory.valuation report, 4B's item_profitability, 7B's re-expression and
Task 11's snapshot rebuild all call it and none re-derives it. As-of in two
clauses — a layer counts when its own movement is on or before the date, and
its residue subtracts only consumptions whose consuming movement is. Value is
Σ round(qty_remaining × unit_cost, 4) per layer, never average × quantity,
because the two differ at the fourth place and a report and a stored snapshot
must agree to the cent.

Amendment A8's module at /v1/companies/:companyId/valuation with one PROBES
key; this is NOT §4.16.1's inventory.valuation report code, which is 3D's on
1B's reports module.

Migration 0036 and permissions.ts land together — the catalogue check is
bidirectional. inventory.cost.read goes to accountant, warehouse,
branch_manager and auditor; mutating: false is what lets auditor hold it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `stock_valuation` — the as-of snapshot, `inventory.projection.rebuild`, and test 2's re-run

**Files:**
- Create: `apps/worker/src/handlers/inventory-projection-rebuild.ts`, `docs/adr/0039-stock-valuation-is-an-as-of-snapshot-and-cost-layer-joins-the-projection-registry.md`
- Modify: `packages/db/src/costing/valuation.ts`, `packages/db/src/costing/index.ts`, `apps/worker/src/index.ts`, `tests/invariants/probes.ts`, `tests/invariants/projection-rebuild.test.ts`
- Test: `packages/db/test/costing/valuation.test.ts`

**Interfaces:**
- Consumes: `valuationAsOf` (Task 10); `ProjectionMismatch`, `recordIntegrityIncident` (1B, contracts §4.16.3); `eachTenant`, `registerHandler`, `JobHandler`, `JobEnvelope`, `JobPayload` (§4.2.6); `systemContext`, `withTenant`, `TenantContext` (§4.2.2); `log()` (0D); `startWorker` (§4.17.1); `JOB_PROBES`, `JobIsolationProbe` (§4.2.6).
- Produces:

```ts
// packages/db/src/costing/valuation.ts (appended)
export interface StockValuationRebuildResult {
  asOf: string; rowsWritten: number;
  mismatches: ProjectionMismatch[];
  /** Pairs skipped because an authorised negative-stock shortfall is still open (ADR 0038 note 7). */
  excluded: { itemId: string; warehouseId: string }[];
}
/** Rebuilds `app.stock_valuation` for one company at one date FROM `valuationAsOf`, and compares the
 *  quantity half to `inventory_movement`. One company per transaction (spec:1368). */
export async function rebuildStockValuation(tx: Sql, input: { companyId: string; asOf: string }): Promise<StockValuationRebuildResult>;
/** Pages through `valuationAsOf` — 1000 rows at a time on the (item code, warehouse code) cursor. */
export const VALUATION_PAGE = 1000;
```

**Read this before writing it — the two halves of `stock_valuation` are checked differently, and that asymmetry is the design.**

`app.stock_valuation` is spec:1204's third **asynchronous** projection: "rebuilt from `ledger_entry`/`inventory_movement` into scratch tables nightly and compared row for row; a mismatch is an incident". For quantity that is exactly what happens — the layer-derived figure must equal `sum(inventory_movement.quantity)` as at the date, and a difference is a real incident.

**The value half is deliberately not compared against `inventory_movement`, and a plan that compares it is wrong.** An issue's `inventory_movement.value` is the value it was *posted* with and is immutable (ADR 0038 note 1); after a recost the consumptions carry a different figure. So `Σ movement.value` and the layer-derived value legitimately differ by exactly the adjustments the replay has posted, and asserting their equality would raise an incident every single time a back-dated document was handled correctly. The value half's invariant is a *layer* invariant — `qty_remaining = qty_in − Σ(valid consumptions)` — and that is `COST_LAYER_CHECK`, registered in Task 12 through 1B's `projectionChecks`.

**One quantity exclusion, and it is a real hole rather than a convenience — ADR 0038 note 7.** An `inventory.negative_stock.override` issue is *valued* but produces no consumption row, because `cost_consumption.layer_id` is NOT NULL and there is no layer to point at. For that `(item, warehouse)` the layers therefore exceed the movements by the **open shortfall** until a receipt replenishes it, and comparing them would raise the same incident every night for ever over a correctly authorised excursion. So `rebuildStockValuation` computes the open shortfall per pair and **excludes a pair whose shortfall is open**, returning it in `excluded` so the handler logs it by name. Step 1's shortfall case is what bounds that carve-out: it asserts the pair lands in `excluded` and **not** in `mismatches`, and that it returns to the compared set once the gap closes — which happens when a **back-dated** receipt and the replay recompute the issue against replenished layers, not when a later receipt arrives (nothing re-consumes a historical shortfall in v1). Netting the shortfall into the next receipt's layer would remove the exclusion entirely; it changes `CostingOutput`, so it is ADR 0038 note 7's proposal and this plan's second spec question rather than a task here.

**`stock_valuation` does not join `projectionChecks`, and `cost_layer` does.** The registry is for *current-state* projections whose rebuild is a pure function of the append-only tables; `stock_valuation` is an as-of **history** keyed by date, and "rebuild every date that was ever snapshotted" is not the same job. Its rebuild-and-compare belongs to `inventory.projection.rebuild`, which is the job spec:1204 names for it. That split is ADR 0039.

**A stored as-of row changing after a replay is designed behaviour, not an incident.** Yesterday's snapshot said the stock was worth X; a back-dated purchase arriving today makes yesterday's stock worth Y, and the snapshot is *supposed* to be rewritten — the row is a materialised answer, not an archive. The archive is `cost_consumption`'s invalidated generations and the `COST_ADJUSTMENT` document.

- [ ] **Step 1: Write the failing test `packages/db/test/costing/valuation.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { projectionChecks } from "../../src/integrity";
import { replay } from "../../src/costing/replay";
import { rebuildStockValuation, VALUATION_PAGE, valuationAsOf } from "../../src/costing/valuation";
import { loadDocumentTypes } from "../../src/seed/document-types";
import { grantCodes, seedDocumentType, seedItem, seedTenantV2, seedWarehouse, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { postInventoryDocument, postOverriddenIssue, recordingJobs, STOCK_ISSUE_COST_POLICY, STOCK_RECEIPT_COST_POLICY }
  from "../../../../tests/invariants/support/post-inventory";

/** Resolved from this file: Vitest runs this package from `packages/db` (1a:5114). */
const TYPES = fileURLToPath(new URL("../../seed/my/document-types", import.meta.url));

describe("stock_valuation — the as-of snapshot (spec:1204; test 2 re-run)", () => {
  let db: Db; let s: Seed; let itemId: string; let warehouseId: string; let catalogue: string[];

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Snapshot");
    await grantCodes(db, s);
    // The permission catalogue as DATA, read from the table: `packages/db` may not import
    // `@dulja/contracts` (0B's `dependency-rule`; 1a:5105 spells out this exact substitution). `app.permission`
    // is global, carries no `tenant_id` and no RLS (plan0A:1313), migration 0014 is its only writer, and
    // `permission-catalogue.test.ts` pins it equal to `PERMISSIONS` in both directions — so the two sources
    // cannot disagree. 1A's loader suite reads it the same way (1a:5131–5132), and `no-bare-db` allows
    // `db.admin` under `packages/db/test/` (0b:4969).
    catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map((r) => r.code);
    const receipt = await seedDocumentType(db, s, { code: "STOCK_RECEIPT_TEST", module: "inventory", policy: STOCK_RECEIPT_COST_POLICY });
    const issue = await seedDocumentType(db, s, { code: "STOCK_ISSUE_TEST", module: "inventory", policy: STOCK_ISSUE_COST_POLICY });
    ({ itemId } = await seedItem(db, s, { code: "SNAP-1" }));
    warehouseId = await seedWarehouse(db, s, { code: "S-WH" });
    await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId, effectiveDate: "2026-01-10",
      lines: [{ itemId, warehouseId, quantity: "80.000000", unitPrice: "12.5000" }] });
    await postInventoryDocument(db, s, { documentTypeId: issue, warehouseId, effectiveDate: "2026-01-20",
      lines: [{ itemId, warehouseId, quantity: "30.000000", unitPrice: "40.0000" }] });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("VALUATION_PAGE is 1000 — the rebuild pages, it never reads a company in one gulp", () => {
    expect(VALUATION_PAGE).toBe(1000);
  });

  it("the rebuild writes one row per (item, warehouse) and reports no mismatch", async () => {
    const out = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      rebuildStockValuation(tx, { companyId: s.company, asOf: "2026-01-31" }));
    expect(out).toEqual({ asOf: "2026-01-31", rowsWritten: 1, mismatches: [], excluded: [] });

    const rows = await withTenant(db.rw, s.tenant, s.system, (tx) => tx<{ quantity: string; value: string; as_of: string }[]>`
      select quantity::text, value::text, as_of::text as as_of
        from app.stock_valuation where company_id = ${s.company} order by as_of`);
    expect(rows).toEqual([{ quantity: "50.000000", value: "625.0000", as_of: "2026-01-31" }]);
  });

  it("it agrees with valuationAsOf to the cent — one function, one answer (spec:1228, LEGACY-009)", async () => {
    const direct = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      valuationAsOf(tx, { companyId: s.company, asOf: "2026-01-31", limit: 50 }));
    const stored = await withTenant(db.rw, s.tenant, s.system, (tx) => tx<{ quantity: string; value: string }[]>`
      select quantity::text, value::text from app.stock_valuation where company_id = ${s.company} and as_of = '2026-01-31'`);
    expect([{ quantity: direct[0]!.quantity, value: direct[0]!.value }]).toEqual(stored);
  });

  it("re-running the same date is idempotent — the row is updated, never duplicated", async () => {
    const again = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      rebuildStockValuation(tx, { companyId: s.company, asOf: "2026-01-31" }));
    expect(again.rowsWritten).toBe(1);
    const [n] = await withTenant(db.rw, s.tenant, s.system, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.stock_valuation where company_id = ${s.company} and as_of = '2026-01-31'`);
    expect(n!.n).toBe(1);
  });

  it("a quantity that drifts from the movements IS a mismatch (test 2)", async () => {
    // Break the projection by hand, as app_migrator, exactly as 1B's projection tests do.
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      tx`update app.stock_valuation set quantity = '999.000000' where company_id = ${s.company} and as_of = '2026-01-31'`);
    // The rebuild overwrites it, so the mismatch is detected against the MOVEMENTS, not against the old row.
    // Break the layer side instead: that is the only way the two derivations can disagree.
    //
    // And it must be `qty_in`, NOT `qty_remaining`. `valuationAsOf` derives a layer's residue as
    // `qty_in − Σ(valid consumptions on or before asOf)` and never selects `qty_remaining` at all, so
    // moving that column changes nothing the rebuild writes: `from_layers` (read back out of
    // `app.stock_valuation`) and `from_movements` would both still say 50.000000, the drift query's
    // `where coalesce(l.qty,0) <> coalesce(m.qty,0)` would drop the pair, and the only visible effect would
    // be `live.gap = 5 > 0`, i.e. the pair silently classified as an open shortfall. Moving `qty_in` is what
    // actually makes the layer-derived figure disagree with the movements.
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      tx`update app.cost_layer set qty_in = qty_in + 5 where company_id = ${s.company}`);
    const out = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      rebuildStockValuation(tx, { companyId: s.company, asOf: "2026-01-31" }));
    expect(out.mismatches).toHaveLength(1);
    expect(out.mismatches[0]!.projection).toBe("stock_valuation");
    // Present on both sides and unequal — 80 + 5 in, 30 consumed, against the movements' 80 − 30.
    expect(out.mismatches[0]!.side).toBe("amount_differs");
    expect(out.mismatches[0]!.detail).toMatch(/quantity 55\.000000 from the cost layers .* 50\.000000 from the movements/);
    expect(out.excluded).toEqual([]);        // `live.gap` is 50 − 50 = 0, so this is NOT an open shortfall
    // Repair the same column, so the later cases, ADR 0039's layer invariant and Task 12's
    // `COST_LAYER_CHECK` all start from a clean company.
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      tx`update app.cost_layer set qty_in = qty_in - 5 where company_id = ${s.company}`);
    await withTenant(db.rw, s.tenant, s.system, (tx) =>
      rebuildStockValuation(tx, { companyId: s.company, asOf: "2026-01-31" }));   // and put the snapshot back
  });

  it("an OPEN authorised shortfall excludes its pair, and a back-dated receipt plus the replay puts it back", async () => {
    // ADR 0038 note 7's carve-out, bounded by a test rather than by prose. An override issue the layers
    // cannot cover is VALUED but produces no consumption row, so for that (item, warehouse) the layers
    // exceed the movements until a receipt replenishes them. The pair must land in `excluded` and NOT in
    // `mismatches` — otherwise the nightly job raises the same incident every night over a correctly
    // authorised excursion — and it must return to the compared set once the gap actually closes.
    //
    // What closes it is worth being precise about, because the obvious answer is wrong: a *later* receipt
    // does NOT, since nothing re-consumes a historical shortfall (v1 rejects netting — ADR 0038 note 7).
    // What closes it is a **back-dated** receipt: `invalidateFrom` marks the issue's consumptions invalid and
    // the replay recomputes that issue against the replenished layers, which now cover it in full.
    const own = await seedTenantV2(db, "Shortfall");
    await grantCodes(db, own);
    // This case runs the replay, and `replay` calls `resolveAdjustmentAccounts` unconditionally the moment
    // anything is in scope (Task 9 Step 3) — which raises `ERR_NOT_FOUND` on a missing document type before
    // any arithmetic. `COST_ADJUSTMENT` therefore has to exist in THIS tenant, not only in the one
    // `beforeAll` seeded. Nothing about the outcome depends on the adjustment; the pack load is what stops
    // the case failing for the wrong reason.
    await withTenant(db.migrator, own.tenant, own.system, (tx) =>
      loadDocumentTypes(tx, { tenantId: own.tenant, actorId: own.system, requestId: crypto.randomUUID() },
                        TYPES, catalogue));
    const receipt = await seedDocumentType(db, own, { code: "STOCK_RECEIPT_TEST", module: "inventory", policy: STOCK_RECEIPT_COST_POLICY });
    const issue = await seedDocumentType(db, own, { code: "STOCK_ISSUE_TEST", module: "inventory", policy: STOCK_ISSUE_COST_POLICY });
    const { itemId: shortItem } = await seedItem(db, own, { code: "SHORT-1" });
    const shortWarehouse = await seedWarehouse(db, own, { code: "SH-WH" });

    await postInventoryDocument(db, own, { documentTypeId: receipt, warehouseId: shortWarehouse, effectiveDate: "2026-01-05",
      lines: [{ itemId: shortItem, warehouseId: shortWarehouse, quantity: "10.000000", unitPrice: "10.0000" }] });
    // 12 issued against 10 on hand: two units of authorised shortfall, valued at 10.0000, unconsumed.
    await postOverriddenIssue(db, own, { documentTypeId: issue, itemId: shortItem, warehouseId: shortWarehouse,
      quantity: "12.000000", effectiveDate: "2026-01-10" });

    const open = await withTenant(db.rw, own.tenant, own.system, (tx) =>
      rebuildStockValuation(tx, { companyId: own.company, asOf: "2026-01-31" }));
    expect(open.excluded).toEqual([{ itemId: shortItem, warehouseId: shortWarehouse }]);
    expect(open.mismatches).toEqual([]);

    // Replenish BEFORE the issue: 5 @ 12.0000 on the 8th. Step 14 enqueues the replay; run it here.
    const jobs = recordingJobs();
    await postInventoryDocument(db, own, { documentTypeId: receipt, warehouseId: shortWarehouse, effectiveDate: "2026-01-08", jobs,
      lines: [{ itemId: shortItem, warehouseId: shortWarehouse, quantity: "5.000000", unitPrice: "12.0000" }] });
    expect(jobs.enqueued.map((j) => j.name)).toEqual(["inventory.cost.replay"]);
    const replayCtx = { tenantId: own.tenant, actorId: own.system, requestId: await uuidv7(db.admin) };
    await replay(db.rw, { tenantId: own.tenant, requestId: replayCtx.requestId, payload: { companyId: own.company } }, replayCtx);

    // 10 + 5 in, 12 out and now FULLY consumed: layers hold 3.000000 and the movements sum to 3.000000.
    const closed = await withTenant(db.rw, own.tenant, own.system, (tx) =>
      rebuildStockValuation(tx, { companyId: own.company, asOf: "2026-01-31" }));
    expect(closed.excluded).toEqual([]);
    expect(closed.mismatches).toEqual([]);
  }, 600_000);

  it("stock_valuation is NOT in the projection-check registry; cost_layer is (ADR 0039, amendment A10)", () => {
    const names = projectionChecks().map((c) => c.name);
    expect(names).not.toContain("stock_valuation");
    expect(names).toContain("cost_layer");           // registered in Task 12 — red until then, and that is correct
  });

  it("a second tenant's rebuild writes nothing of ours (test 12)", async () => {
    const b = await seedTenantV2(db, "Snapshot-B");
    await withTenant(db.rw, b.tenant, b.system, (tx) => rebuildStockValuation(tx, { companyId: s.company, asOf: "2026-01-31" }));
    const [n] = await withTenant(db.rw, b.tenant, b.system, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.stock_valuation`);
    expect(n!.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- test/costing/valuation.test.ts`
Expected: **FAIL** — `rebuildStockValuation is not exported from ../../src/costing/valuation` (Task 10 created that module; this task appends to it). The last-but-one case is expected to stay red until Task 12 registers `COST_LAYER_CHECK`; leave it failing on that one assertion and note it in the commit, or run the file with `-t` filters until Task 12 lands. Do **not** weaken it to `it.skip`.

- [ ] **Step 3: Append `rebuildStockValuation` to `packages/db/src/costing/valuation.ts`**

```ts
import type { ProjectionMismatch } from "../integrity";

/** The rebuild pages rather than reading a whole company at once — a tenant with 50 000 (item, warehouse)
 *  pairs is ordinary, and one 50 000-row result set inside a nightly job is not. */
export const VALUATION_PAGE = 1000;

export interface StockValuationRebuildResult {
  asOf: string; rowsWritten: number;
  mismatches: ProjectionMismatch[];
  excluded: { itemId: string; warehouseId: string }[];
}

/**
 * Rebuilds `app.stock_valuation` for one company at one date, **from `valuationAsOf`** — not from a second
 * query that happens to compute the same thing. Two derivations of one figure is LEGACY-009, and this function
 * exists to be the one place a stored snapshot and a live report cannot diverge.
 *
 * Compares the QUANTITY half to `sum(inventory_movement.quantity)` as at the date; a difference is a
 * `ProjectionMismatch` the caller records as an incident. The VALUE half is deliberately not compared
 * against movements — an issue's movement value is its post-time value and is immutable, so after a recost
 * the two legitimately differ by the adjustments already posted (ADR 0039). The value's invariant lives on
 * the layer and is `COST_LAYER_CHECK`.
 */
export async function rebuildStockValuation(
  tx: Sql, input: { companyId: string; asOf: string },
): Promise<StockValuationRebuildResult> {
  const rows: ValuationRow[] = [];
  let cursor: { itemCode: string; warehouseCode: string } | null = null;
  for (;;) {
    const page = await valuationAsOf(tx, { companyId: input.companyId, asOf: input.asOf, cursor, limit: VALUATION_PAGE });
    rows.push(...page);
    if (page.length < VALUATION_PAGE) break;
    const last = page[page.length - 1]!;
    cursor = { itemCode: last.itemCode, warehouseCode: last.warehouseCode };
  }

  for (const r of rows) {
    await tx`
      merge into app.stock_valuation v
      using (select ${input.companyId}::uuid as company_id, ${r.itemId}::uuid as item_id,
                    ${r.warehouseId}::uuid as warehouse_id, ${input.asOf}::date as as_of,
                    ${r.quantity}::numeric(19,6) as quantity, ${r.value}::numeric(19,4) as value) s
         on v.company_id = s.company_id and v.item_id = s.item_id
        and v.warehouse_id = s.warehouse_id and v.as_of = s.as_of
       when matched then update set quantity = s.quantity, value = s.value, updated_at = now()
       when not matched then insert (tenant_id, company_id, item_id, warehouse_id, as_of, quantity, value)
                             values (app.current_tenant(), s.company_id, s.item_id, s.warehouse_id, s.as_of, s.quantity, s.value)`;
  }

  // Rows that fell to zero must not linger from an earlier rebuild of the same date. app_rw holds no DELETE
  // on this table (§3.5.4), so they are zeroed, not removed — and a zero row is a true statement about the date.
  await tx`
    update app.stock_valuation
       set quantity = 0, value = 0, updated_at = now()
     where company_id = ${input.companyId} and as_of = ${input.asOf}::date
       and (item_id, warehouse_id) not in (
         select unnest(${rows.map((r) => r.itemId)}::uuid[]), unnest(${rows.map((r) => r.warehouseId)}::uuid[]))
       and (quantity <> 0 or value <> 0)`;

  const drift = await tx<{
    item_id: string; warehouse_id: string; layer_qty: string; movement_qty: string;
    layer_missing: boolean; movement_missing: boolean; shortfall_open: boolean;
  }[]>`
    with from_layers as (
      select item_id, warehouse_id, sum(quantity) as qty
        from app.stock_valuation
       where company_id = ${input.companyId} and as_of = ${input.asOf}::date
       group by 1, 2
    ), from_movements as (
      select item_id, warehouse_id, sum(quantity) as qty
        from app.inventory_movement
       where company_id = ${input.companyId} and effective_date <= ${input.asOf}::date
       group by 1, 2
    ), live as (
      -- The CURRENT (not as-of) layer and movement totals. An open shortfall exists when the layers still
      -- hold more than the movements say, which is only possible through an authorised override issue whose
      -- uncovered quantity was valued but never consumed (ADR 0038 note 7).
      select coalesce(l.item_id, m.item_id) as item_id, coalesce(l.warehouse_id, m.warehouse_id) as warehouse_id,
             coalesce(l.qty, 0) - coalesce(m.qty, 0) as gap
        from (select item_id, warehouse_id, sum(qty_remaining) as qty from app.cost_layer
               where company_id = ${input.companyId} and invalidated_at is null group by 1, 2) l
        full outer join (select item_id, warehouse_id, sum(quantity) as qty from app.inventory_movement
                          where company_id = ${input.companyId} group by 1, 2) m
          on m.item_id = l.item_id and m.warehouse_id = l.warehouse_id
    )
    select coalesce(l.item_id, m.item_id)::text as item_id,
           coalesce(l.warehouse_id, m.warehouse_id)::text as warehouse_id,
           coalesce(l.qty, 0)::text as layer_qty, coalesce(m.qty, 0)::text as movement_qty,
           -- Which SIDE of the full outer join is absent — the two booleans ProjectionMismatch.side needs.
           (l.item_id is null) as layer_missing, (m.item_id is null) as movement_missing,
           coalesce((select v.gap > 0 from live v
                      where v.item_id = coalesce(l.item_id, m.item_id)
                        and v.warehouse_id = coalesce(l.warehouse_id, m.warehouse_id)), false) as shortfall_open
      from from_layers l
      full outer join from_movements m on m.item_id = l.item_id and m.warehouse_id = l.warehouse_id
     where coalesce(l.qty, 0) <> coalesce(m.qty, 0)
     order by 1, 2`;

  return {
    asOf: input.asOf,
    rowsWritten: rows.length,
    excluded: drift.filter((d) => d.shortfall_open).map((d) => ({ itemId: d.item_id, warehouseId: d.warehouse_id })),
    mismatches: drift.filter((d) => !d.shortfall_open).map((d) => ({
      projection: "stock_valuation" as const,
      key: { itemId: d.item_id, warehouseId: d.warehouse_id, asOf: input.asOf },
      // `side` is REQUIRED on ProjectionMismatch (1b:442-450) and is DERIVED from the join, never guessed:
      // the movement side absent means the projection carries a pair the rebuild does not
      // ("missing_in_rebuild"); the layer side absent is the converse; present on both and unequal is
      // "amount_differs". Read from the two booleans, not from a "0.000000" string compare.
      side: d.movement_missing
        ? ("missing_in_rebuild" as const)
        : d.layer_missing
          ? ("missing_in_projection" as const)
          : ("amount_differs" as const),
      detail: `quantity ${d.layer_qty} from the cost layers does not equal ${d.movement_qty} from the movements for item ${d.item_id} in warehouse ${d.warehouse_id} as at ${input.asOf}`,
    })),
  };
}
```

The `unnest(...)` pair in the zeroing statement is positional and only correct because both arrays are built from the same `rows` in the same order; if you prefer, replace it with `not in (select … from unnest($1::uuid[], $2::uuid[]) as t(item_id, warehouse_id))`, which says the same thing and reads better.

- [ ] **Step 4: Register the handler, copying 1B's schedule-fired shape**

`apps/worker/src/handlers/inventory-projection-rebuild.ts` — `JOBS["inventory.projection.rebuild"].schedule` is `"0 3 * * *"`, so it fires with **no tenant** and fans out through `eachTenant`, never through `app.tenant` (FORCE RLS, hazard 20). This is the same shape as 1B's `accounting.ledger.integrity_check`; copy it rather than inventing a second one:

```ts
import { eachTenant, rebuildStockValuation, recordIntegrityIncident, systemContext, withTenant } from "@dulja/db";
import { registerHandler } from "../handler";
import { log } from "../log";

registerHandler("inventory.projection.rebuild", async (sql, job, ctx) => {
  const asOf = job.payload.asOf ?? new Date().toISOString().slice(0, 10);

  const runCompany = async (tenantCtx: typeof ctx, companyId: string) => {
    // One company per transaction (spec:1368) — a tenant with two hundred companies must not hold one
    // transaction, and the per-tenant audit lock, for the whole nightly run.
    const result = await withTenant(sql, tenantCtx, (tx) => rebuildStockValuation(tx, { companyId, asOf }));
    if (result.mismatches.length > 0) {
      // 1B's signature takes a whole `IntegrityReport` (1b:1240) — its body writes `report.tenantId` into
      // app.audit_log.tenant_id (NOT NULL) and `report.requestId` into row_id. This run checked exactly one
      // projection and walked no chain, so `projections` carries the real result and every other member is
      // its empty value. That also puts the mismatches themselves in the audit row, not just a sentence.
      await withTenant(sql, tenantCtx, (tx) => recordIntegrityIncident(tx, {
        tenantId: tenantCtx.tenantId,
        requestId: tenantCtx.requestId,
        checkedAt: new Date().toISOString(),
        ledgerBalance: { byPeriod: [], byDocument: [] },
        projections: { checked: ["stock_valuation"], mismatches: result.mismatches },
        auditChain: { rows: 0, brokenLinks: 0, badHashes: 0, firstBrokenSeq: null },
        periodReopens: [],
        ok: false,
        summary: `FAILED: stock_valuation rebuild of company ${companyId} found ${result.mismatches.length} quantity mismatch(es) as at ${asOf}: ${result.mismatches.map((m) => m.detail).join("; ")}`,
      }));
    }
    log().info({ job: "inventory.projection.rebuild", companyId, asOf, rowsWritten: result.rowsWritten,
                 mismatches: result.mismatches.length, excluded: result.excluded },
               "stock valuation rebuilt");
  };

  if (job.payload.companyId) {
    await runCompany(ctx, job.payload.companyId);
    return;
  }
  // The nightly, tenantless run.
  await eachTenant(sql, async (tenantId) => {
    const tenantCtx = await systemContext(sql, tenantId, ctx.requestId);
    const companies = await withTenant(sql, tenantCtx, (tx) =>
      tx<{ id: string }[]>`select id::text as id from app.company order by code`);
    for (const c of companies) await runCompany(tenantCtx, c.id);
  });
});
```

`apps/worker/src/index.ts` gains `import "./handlers/inventory-projection-rebuild";`.

`tests/invariants/probes.ts` gains the second `JOB_PROBES` entry (hazard 31):

```ts
  "inventory.projection.rebuild": {
    async seed(db, attacker, victim) { await seedCostLayerFixture(db, victim); },
    async survivors(db, victim) {
      const [row] = await withTenant(db.rw, victim.tenant, victim.human, (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.stock_valuation`);
      return row!.n;
    },
  },
```

The harness enqueues the job for tenant A with tenant B's `companyId` in the payload; the probe asserts B's rows are untouched, which under FORCE RLS means the rebuild wrote nothing at all — the seventh case of Step 1 asserts the same thing directly.

`tests/invariants/projection-rebuild.test.ts` gains a `stock_valuation` case in the same shape as 3A's `stock_on_hand` one: rebuild twice, assert the second rebuild changes no `quantity` or `value`, and assert a hand-broken layer produces a mismatch.

- [ ] **Step 5: Write ADR 0039**

`docs/adr/0039-stock-valuation-is-an-as-of-snapshot-and-cost-layer-joins-the-projection-registry.md`:

```markdown
# ADR 0039: `stock_valuation` is an as-of snapshot; `cost_layer` is the checked projection

- **Status:** Accepted
- **Date:** 2026-09-07
- **Deciders:** Phase 3B
- **Spec:** §3.3 projections (spec:1204), §3.4 (spec:1210, 1228), §3.8 (spec:1370), Part VI test 2 (spec:2420)

## Context

spec:1204 names three asynchronous projections — `party_ageing`, `item_profitability` and
`stock_valuation` history — and requires all of them rebuilt nightly and compared row for row.
1B built a `projectionChecks` registry for that comparison, and 3A added `stock_on_hand` to it.
The obvious move is to add `stock_valuation` too. It is the wrong move.

## Decision

**`stock_valuation` does not join `projectionChecks`. `cost_layer` does.**

`projectionChecks` compares a *current-state* projection to a pure aggregate of the append-only tables.
`stock_valuation` is a **history keyed by date**: "rebuild it" means "rebuild it for which dates?", and the
answer is the dates a job was asked to snapshot. Its rebuild-and-compare therefore belongs to
`inventory.projection.rebuild` — the job spec:1204 names for exactly this — and its result is a
`ProjectionMismatch` recorded as an incident by the handler.

`cost_layer` joins the registry instead, with `COST_LAYER_CHECK` (Task 12), because it *is* current state
and it *does* have a pure invariant: `qty_remaining = qty_in − Σ(valid consumptions)`.

**Only the quantity half is compared against `inventory_movement`.** An issue's movement value is its
post-time value and is immutable (ADR 0038), so after a recost `Σ movement.value` and the layer-derived
value differ by exactly the adjustments already posted. Comparing them would raise an incident every time
a back-dated document was handled correctly. The value's integrity is the layer invariant above.

**A stored as-of row changing after a replay is designed behaviour.** The row is a materialised answer to
"what was this worth as at D", and a back-dated purchase changes that answer. The archive is
`cost_consumption`'s invalidated generations and the `COST_ADJUSTMENT` document, not the snapshot.

## Consequences

- `IntegrityReport.projections.checked` becomes `["account_balance", "cost_layer", "document_series", "stock_on_hand"]`
  (amendment A10) — alphabetical, because `projectionChecks()` sorts by name.
- 4B adds `party_ageing` and `item_profitability` to `accounting.projection.rebuild` and faces the same
  question; this ADR is the precedent — a dated history is rebuilt by its job, current state by the registry.
- A tenant that never runs the nightly job has no valuation history and a perfectly correct live
  valuation, because `valuationAsOf` reads the layers. The snapshot is an optimisation and a record, never
  the source (spec:1210).
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/costing/valuation.test.ts`
Expected: **PASS** for seven of eight; the `cost_layer` registry assertion stays red until Task 12. Run Task 12 next and re-run this file — do not reorder the tasks to make it green early, because the assertion is what makes Task 12's registration non-optional.

Run: `bun run --cwd apps/worker test && bun run --cwd tests test -- invariants/projection-rebuild.test.ts invariants/tenant-isolation.test.ts`
Expected: **PASS**.

Run: `bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS. `posting-only-tables` does **not** list `stock_valuation` (§3.7.5 says so explicitly — the async projections are rebuilt by their jobs, not by the posting service), so the `merge` above is legal where it sits.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/costing/valuation.ts packages/db/src/costing/index.ts \
        apps/worker/src/handlers/inventory-projection-rebuild.ts apps/worker/src/index.ts \
        packages/db/test/costing/valuation.test.ts tests/invariants/probes.ts \
        tests/invariants/projection-rebuild.test.ts \
        docs/adr/0039-stock-valuation-is-an-as-of-snapshot-and-cost-layer-joins-the-projection-registry.md
git commit -m "$(cat <<'EOF'
feat(db): the stock_valuation snapshot and its nightly rebuild [3B T11]

rebuildStockValuation pages through valuationAsOf and MERGEs the result, so a
stored snapshot and a live report cannot diverge — two derivations of one
figure is LEGACY-009.

ADR 0039: stock_valuation is an as-of HISTORY and does not join 1B's
projectionChecks registry; cost_layer does, because it is current state with a
pure invariant. Only the QUANTITY half is compared to inventory_movement: an
issue's movement value is its immutable post-time value, so after a recost the
two differ by exactly the adjustments already posted, and comparing them would
raise an incident every time a back-dated document was handled correctly.

The schedule-fired handler copies 1B's integrity-check shape: tenantless, fans
out through eachTenant, one company per withTenant transaction (spec:1368).
Second JOB_PROBES entry, so the isolation harness covers both 3B jobs.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `COST_LAYER_CHECK`, and the golden costing fixtures (test 2's `cost_layer` re-run)

**Files:**
- Create: `packages/db/src/integrity/cost-layer-check.ts`, `tests/golden/costing.test.ts`, `tests/golden/costing/avco-back-dated/{input,policies,expected}.json`, `tests/golden/costing/avco-edge-cases/{input,policies,expected}.json`, `tests/golden/costing/fifo-oldest-first/{input,policies,expected}.json`
- Modify: `packages/db/src/integrity/index.ts`, `tests/invariants/audit-chain.test.ts`, `apps/worker/test/handlers/integrity-check.test.ts`, `tests/invariants/projection-rebuild.test.ts`, `tests/package.json`
- Test: `packages/db/test/costing/layers.test.ts` (append), `tests/golden/costing.test.ts`

**Interfaces:**
- Consumes: `ProjectionCheck`, `ProjectionMismatch`, `registerProjectionCheck`, `projectionChecks`, `runIntegrityCheck`, `IntegrityReport` (contracts §4.16.3, 1B — named from inside `packages/db` as `./types` and `../../src/integrity`, never as `@dulja/db`); `evaluatePolicy`, `parsePolicy`, `PostingPlan`, `DocumentSnapshot`, `PlannedMovement` (§4.4.2); `costingEngine`, `Consumption`, `Layer`, `CostingMethod` (Tasks 2–3); `Money`, `Quantity`, `currency` (§4.2.1); `repoFile` (§4.17.1, 0C).
- Produces:

```ts
// packages/db/src/integrity/cost-layer-check.ts
/** The fourth registered ProjectionCheck (amendment A10). Invariant: for every valid layer,
 *  qty_remaining = qty_in − Σ(valid consumption quantities). */
export const COST_LAYER_CHECK: ProjectionCheck;

// tests/golden/costing.test.ts (amendment A7)
export interface GoldenLayer { movementId: string; qtyIn: string; unitCost: string; qtyRemaining: string; effectiveDate: string; postingSeq: string }
export interface CostingGoldenExpectation { plans: PostingPlan[]; consumptions: Consumption[][]; layersAfter: GoldenLayer[] }
```

**Amendment A7, stated once so the shape is not re-litigated.** §3.7.4 says `expected.json` is the `PostingPlan`, and the plans **are** in there — but a `PostingPlan` cannot express *which layers an issue consumed*, and LEGACY-009's entire failure was two implementations disagreeing about exactly that. So for the costing area only, `expected.json` is a `CostingGoldenExpectation`: the plans, the per-document consumption sets, and the layer state after the last document.

**Amendment A17 settles the harness's one open question: each case carries its own `policies.json`, keyed by `documentTypeCode`.** `input.json` is a `DocumentSnapshot[]` and a snapshot alone does not say how to post — the plans in `expected.json` came from an `evaluatePolicy` call, so the policy is fixture input. It has to be a **map**: `inventory.effect` is a per-policy field, every case here mixes `STOCK_RECEIPT_TEST` and `STOCK_ISSUE_TEST` documents, and a single `effect: "issue"` policy would plan a receipt as an issue and cost it against layers it should have created. The map is per case rather than in the harness so a case that wants a different `inventory.costing` (a free-of-charge line) changes one file rather than a shared table.

**`bigint` is not JSON.** `DocumentSnapshot.header.number` and `Layer.postingSeq` are `bigint`, so the harness serialises with a replacer that renders a bigint as its decimal string, and the fixtures store those fields as strings. `Money.toJSON()` and `Quantity.toJSON()` already produce wire forms (§4.2.1), so nothing else needs special handling.

**The driver walks in CHRONOLOGICAL key order, not array order — that is how a back-dated case is expressible without a database.** `input.json`'s array order is *post* order, so the driver assigns `postingSeq` from the array index (1, 2, 3, …) exactly as `app.posting_seq` would, and then sorts by `(effectiveDate, postingSeq, lineNo, movementNo)` before costing. A document third in the array with January's date therefore costs *first* — which is precisely what Task 9's replay computes over the same facts. One fixture pins both the post path and the replay path.

- [ ] **Step 1: Append the failing `cost_layer` cases to `packages/db/test/costing/layers.test.ts`**

Two placements again, for the reason Task 6 Step 1 gives: the **imports go into the file's existing import block at the top** (`import/first` flags an import after a statement, and this file opens with Task 1's imports and its `describe`), and the `describe` block is appended at the **end**. Task 1's block already imports `withTenant`, `uuidv7`, `describe`, `expect` and `it`, and already declares `db`, `a` and `b` — so only the `@dulja/db` names are new, and they join the existing `@dulja/db` import line:

```ts
// ── ONE line added to the import block at the TOP of the file ─────────────────────────────
// Task 1 already wrote `import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";`,
// and this file may not name `@dulja/db` (Global Constraints: `dependency-rule` pins `packages/db`).
// `COST_LAYER_CHECK` is re-exported from the barrel by Step 3, so one import covers all three names.
import { COST_LAYER_CHECK, projectionChecks, runIntegrityCheck } from "../../src/integrity";
```

```ts
// ── appended at the END of the file by Task 12 ───────────────────────────────────────────────────

describe("COST_LAYER_CHECK — cost_layer joins the projection registry (test 2 re-run; amendment A10)", () => {
  // `runIntegrityCheck(tx, ctx, opts)` takes the TENANT CONTEXT second and its options third (1b:1497) —
  // it reads ctx.tenantId for the audit-chain walk and ctx.requestId for the report. Passing
  // `{ companyId }` in the second position puts the company in the ctx slot and the check walks nothing.
  const integrityCtx = async () => ({ tenantId: a.tenant, actorId: a.system, requestId: await uuidv7(db.admin) });

  it("the registry is exactly these four, alphabetically", () => {
    expect(projectionChecks().map((c) => c.name)).toEqual(
      ["account_balance", "cost_layer", "document_series", "stock_on_hand"]);
    expect(COST_LAYER_CHECK.name).toBe("cost_layer");
  });

  it("a clean company reports no mismatch", async () => {
    const ctx = await integrityCtx();
    const report = await withTenant(db.rw, a.tenant, a.system, (tx) => runIntegrityCheck(tx, ctx, { companyId: a.company }));
    expect(report.projections.checked).toEqual(["account_balance", "cost_layer", "document_series", "stock_on_hand"]);
    expect(report.projections.mismatches.filter((m) => m.projection === "cost_layer")).toEqual([]);
  });

  it("a layer whose qty_remaining drifts from qty_in minus its valid consumptions is a mismatch", async () => {
    const [layer] = await withTenant(db.migrator, a.tenant, a.system, (tx) => tx<{ id: string }[]>`
      update app.cost_layer set qty_remaining = qty_remaining + '1.000000'
       where invalidated_at is null returning id::text as id`);
    const ctx = await integrityCtx();
    const report = await withTenant(db.rw, a.tenant, a.system, (tx) => runIntegrityCheck(tx, ctx, { companyId: a.company }));
    const found = report.projections.mismatches.filter((m) => m.projection === "cost_layer");
    expect(found).toHaveLength(1);
    expect(found[0]!.side).toBe("amount_differs");        // the layer exists on both sides; only the residue differs
    expect(found[0]!.key).toEqual({ layerId: layer!.id });
    expect(found[0]!.detail).toMatch(new RegExp(`layer ${layer!.id}`));
    expect(found[0]!.detail).toMatch(/qty_remaining .* does not equal qty_in .* minus/);
    await withTenant(db.migrator, a.tenant, a.system, (tx) =>
      tx`update app.cost_layer set qty_remaining = qty_remaining - '1.000000' where id = ${layer!.id}`);
  });

  it("an invalidated layer is skipped — mid-replay is not a mismatch", async () => {
    const [layer] = await withTenant(db.migrator, a.tenant, a.system, (tx) => tx<{ id: string }[]>`
      update app.cost_layer set invalidated_at = now(), qty_remaining = '99999.000000'
       where invalidated_at is null returning id::text as id`);
    const ctx = await integrityCtx();
    const report = await withTenant(db.rw, a.tenant, a.system, (tx) => runIntegrityCheck(tx, ctx, { companyId: a.company }));
    expect(report.projections.mismatches.filter((m) => m.projection === "cost_layer")).toEqual([]);
    await withTenant(db.migrator, a.tenant, a.system, (tx) =>
      tx`update app.cost_layer set invalidated_at = null, qty_remaining = qty_in where id = ${layer!.id}`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/costing/layers.test.ts`
Expected: **FAIL** — the registry array is `["account_balance", "document_series", "stock_on_hand"]` and `COST_LAYER_CHECK` is not exported from `../../src/integrity`.

- [ ] **Step 3: Write `packages/db/src/integrity/cost-layer-check.ts`**

```ts
import type { Sql } from "postgres";
// The types come from `./types` and NOTHING is imported from `./index` — `index.ts` imports this file to run
// the registration, so importing the barrel back would close a cycle. That is why 1B's ACCOUNT_BALANCE_CHECK
// (1b:1030-1034) and 3A's STOCK_ON_HAND_CHECK (3a:5551, 5643-5645) both take their types from `./types` and
// leave `registerProjectionCheck` to the barrel. This file follows them; it does not register itself.
import type { ProjectionCheck, ProjectionMismatch } from "./types";

/**
 * `cost_layer`'s one pure invariant: a valid layer's residue is what came in, less what valid consumptions
 * took out. Nothing else about a layer can be checked by aggregation — its `unit_cost` is arithmetic over an
 * immutable movement value and its date and sequence are copies — which is exactly why this, and not
 * `stock_valuation`, is the registered check (ADR 0039).
 *
 * Invalidated layers are SKIPPED, deliberately: between `invalidateFrom` and the replay's forward pass a
 * layer is legitimately mid-flight, and a nightly job that fired during a replay would otherwise raise an
 * incident about work in progress. The replay's own restart test is what covers that window.
 *
 * `run` takes the transaction and NOTHING else: `ProjectionCheck.run` is `(tx: Sql) => Promise<…>` (1b:479-482)
 * and a function with an extra required parameter is not assignable to it, so a `companyId` argument would
 * make `registerProjectionCheck(COST_LAYER_CHECK)` fail to compile. It needs none — the invariant is
 * per-layer, and the statement runs inside `withTenant`, which has already reduced the table to one tenant.
 * That is why 1B's `account_balance` and 3A's `stock_on_hand` checks take no company either.
 *
 * So the statement below carries **no `company_id` predicate**: there is no `companyId` binding in scope
 * and adding one would be a `TS2304` at `bun run typecheck`. A tenant's layers across all its companies is
 * the correct scan set for a per-layer invariant, and the mismatch's `key` names the layer, which resolves
 * to its company for anyone reading the incident.
 */
export const COST_LAYER_CHECK: ProjectionCheck = {
  name: "cost_layer",
  async run(tx: Sql): Promise<ProjectionMismatch[]> {
    const drift = await tx<{ id: string; qty_remaining: string; qty_in: string; consumed: string }[]>`
      select l.id::text as id, l.qty_remaining::text as qty_remaining, l.qty_in::text as qty_in,
             coalesce((select sum(c.quantity) from app.cost_consumption c
                        where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is null), 0)::text as consumed
        from app.cost_layer l
       where l.invalidated_at is null
         and l.qty_remaining <> l.qty_in - coalesce((select sum(c.quantity) from app.cost_consumption c
                                                      where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is null), 0)
       order by l.effective_at, l.sequence`;
    return drift.map((d) => ({
      projection: "cost_layer" as const,
      key: { layerId: d.id },
      // `side` is required (1b:442-450). Every row here is "amount_differs" by construction: the layer is
      // present on both sides of the comparison — it IS the row — and only its residue disagrees with the
      // sum of its own consumptions. The other two variants cannot arise from this query.
      side: "amount_differs" as const,
      detail: `layer ${d.id}: qty_remaining ${d.qty_remaining} does not equal qty_in ${d.qty_in} minus the ${d.consumed} its valid consumptions took`,
    }));
  },
};
```

`packages/db/src/integrity/index.ts` gains the two lines 3A's Step 6 shows for `stock_on_hand` (3a:5652–5654) — the registration lives in the barrel, never in the check's own file:

```ts
import { COST_LAYER_CHECK } from "./cost-layer-check";
registerProjectionCheck(COST_LAYER_CHECK);
export { COST_LAYER_CHECK } from "./cost-layer-check";
```

**Amendment A10's three pinned assertions move in this same PR**, exactly as 2B did for `document_series`: `tests/invariants/audit-chain.test.ts`, `apps/worker/test/handlers/integrity-check.test.ts` and `tests/invariants/projection-rebuild.test.ts` each carry a literal `projections.checked` array; all three become `["account_balance", "cost_layer", "document_series", "stock_on_hand"]`. `projectionChecks()` sorts by name (1b:930–932), so the order is alphabetical and 3A's `stock_on_hand` needs no re-ordering.

- [ ] **Step 4: Write `tests/golden/costing.test.ts`**

```ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { costingEngine, evaluatePolicy, parsePolicy, Money, Quantity, currency,
         type Consumption, type CostingMethod, type DocumentSnapshot, type Layer, type PostingPlan } from "@dulja/domain";
import { REPO_ROOT } from "../support/source";

export interface GoldenLayer {
  movementId: string; qtyIn: string; unitCost: string; qtyRemaining: string; effectiveDate: string; postingSeq: string;
}
export interface CostingGoldenExpectation {
  plans: PostingPlan[]; consumptions: Consumption[][]; layersAfter: GoldenLayer[];
}

const DIR = join(REPO_ROOT, "tests", "golden", "costing");
/** `bun run --cwd tests test -- golden/costing.test.ts` compares; `GOLDEN_WRITE=1 …` regenerates. */
const WRITE = process.env.GOLDEN_WRITE === "1";

/** bigint is not JSON (amendment A7's note). One replacer, used for both directions of the compare. */
const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const stable = (value: unknown) => JSON.parse(JSON.stringify(value, replacer));

/**
 * The driver. PURE: no clock, no database, no random. It assigns `postingSeq` from the array index — the
 * array is POST order, exactly as `app.posting_seq` would number it — and then sorts by the §4.3.5
 * chronological key before costing anything. A document third in the array carrying January's date
 * therefore costs first, which is what Task 9's replay computes over the same facts.
 */
function run(snapshots: DocumentSnapshot[], policiesJson: Record<string, unknown>, method: CostingMethod): CostingGoldenExpectation {
  const policies = Object.fromEntries(Object.entries(policiesJson).map(([code, definition]) => [code, parsePolicy(definition)]));
  const numbered = snapshots.map((s, i) => ({ snapshot: s, postingSeq: BigInt(i + 1) }));
  const ordered = [...numbered].sort((a, b) =>
    a.snapshot.header.effectiveDate !== b.snapshot.header.effectiveDate
      ? (a.snapshot.header.effectiveDate < b.snapshot.header.effectiveDate ? -1 : 1)
      : (a.postingSeq < b.postingSeq ? -1 : 1));

  const layers: Layer[] = [];
  const plans: PostingPlan[] = [];
  const consumptions: Consumption[][] = [];

  for (const { snapshot, postingSeq } of ordered) {
    const policy = policies[snapshot.header.documentTypeCode];
    if (!policy) throw new Error(`fixture has no policy for document type ${snapshot.header.documentTypeCode}`);
    const plan = evaluatePolicy(policy, snapshot);
    const perDocument: Consumption[] = [];
    for (const movement of plan.movements) {
      const movementId = `mv-${postingSeq}-${movement.movementNo}`;
      const open = layers.filter((l) => l.itemId === movement.itemId && l.warehouseId === movement.warehouseId && !l.qtyRemaining.isZero());
      const out = costingEngine.cost({
        method, openLayers: open, allowShortfall: movement.costing === "zero",
        movement: {
          ...movement,
          // The SAME rule as `applyMovements` (Task 7 note 3), keyed on `effect` and not on `costing`: an
          // issue is costed from the layers and its value only tells the engine which currency to answer
          // in. Keying the fixture on `costing === "zero"` instead would make the golden file disagree
          // with the production hook for every ordinary issue, which is the one thing a golden file exists
          // to prevent.
          value: movement.effect === "issue" ? Money.zero(snapshot.company.baseCurrency) : movement.value,
          lotId: movement.lotId ?? "lot-sentinel",
          effectiveDate: snapshot.header.effectiveDate, postingSeq, movementId,
        },
      });
      perDocument.push(...out.consumptions);
      for (const u of out.updatedRemaining) {
        const layer = layers.find((l) => l.id === u.layerId);
        if (layer) layer.qtyRemaining = u.qtyRemaining;
      }
      if (out.newLayer) layers.push({ ...out.newLayer, id: `L-${movementId}` });
      movement.value = out.value;                                   // the plan as applyMovements returns it
    }
    plans.push(plan);
    consumptions.push(perDocument);
  }

  return {
    plans,
    consumptions,
    layersAfter: layers
      .slice()
      .sort((a, b) => (a.effectiveDate === b.effectiveDate ? (a.postingSeq < b.postingSeq ? -1 : 1) : a.effectiveDate < b.effectiveDate ? -1 : 1))
      .map((l) => ({
        movementId: l.movementId, qtyIn: l.qtyIn.toString(), unitCost: l.unitCost.toString(),
        qtyRemaining: l.qtyRemaining.toString(), effectiveDate: l.effectiveDate, postingSeq: l.postingSeq.toString(),
      })),
  };
}

/** `Money` and `Quantity` arrive from JSON as their wire forms and must become objects before the engine
 *  sees them — the fixture is data, and rehydrating it here is what keeps the fixture readable. */
function rehydrate(raw: unknown): DocumentSnapshot[] { /* see Step 5 */ return raw as DocumentSnapshot[]; }

describe("golden costing fixtures (spec:2264; amendment A7)", () => {
  const cases = readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

  it("there are exactly three cases and each has three files", () => {
    expect(cases).toEqual(["avco-back-dated", "avco-edge-cases", "fifo-oldest-first"]);
    for (const c of cases) {
      expect(readdirSync(join(DIR, c)).sort()).toEqual(["expected.json", "input.json", "policies.json"]);
    }
  });

  for (const name of cases) {
    it(`${name} matches its committed expected output byte for byte`, () => {
      const input = rehydrate(JSON.parse(readFileSync(join(DIR, name, "input.json"), "utf8")));
      const policies = JSON.parse(readFileSync(join(DIR, name, "policies.json"), "utf8"));
      const method: CostingMethod = name.startsWith("fifo") ? "fifo" : "avco";
      const actual = stable(run(input, policies, method));
      if (WRITE) {
        writeFileSync(join(DIR, name, "expected.json"), `${JSON.stringify(actual, null, 2)}\n`);
      }
      const expected = JSON.parse(readFileSync(join(DIR, name, "expected.json"), "utf8"));
      expect(actual).toEqual(expected);
    });

    it(`${name} is deterministic — two runs are identical`, () => {
      const input = rehydrate(JSON.parse(readFileSync(join(DIR, name, "input.json"), "utf8")));
      const policies = JSON.parse(readFileSync(join(DIR, name, "policies.json"), "utf8"));
      const method: CostingMethod = name.startsWith("fifo") ? "fifo" : "avco";
      expect(JSON.stringify(stable(run(input, policies, method)))).toBe(JSON.stringify(stable(run(rehydrate(JSON.parse(readFileSync(join(DIR, name, "input.json"), "utf8"))), policies, method))));
    });
  }
});
```

`tests/package.json` gains `"golden:costing": "GOLDEN_WRITE=1 node ../node_modules/vitest/vitest.mjs run golden/costing.test.ts"` — a **dev** script, not part of CI, so a formula change is a reviewable diff rather than a silently regenerated file (spec:2264).

- [ ] **Step 5: Write `rehydrate` and the three fixture triples**

`rehydrate` walks the parsed JSON and converts every wire form back:

```ts
function rehydrate(raw: unknown): DocumentSnapshot[] {
  const money = (v: { amount: string; currency: string } | null) =>
    (v === null ? null : Money.of(v.amount, currency(v.currency)));
  return (raw as Record<string, never>[]).map((d: Record<string, never>) => ({
    ...(d as unknown as DocumentSnapshot),
    header: { ...(d.header as unknown as DocumentSnapshot["header"]), number: null },
    company: { ...(d.company as unknown as DocumentSnapshot["company"]),
               baseCurrency: currency((d.company as unknown as { baseCurrency: string }).baseCurrency) },
    lines: (d.lines as unknown as Record<string, never>[]).map((l: Record<string, never>) => ({
      ...(l as unknown as DocumentSnapshot["lines"][number]),
      quantity: l.quantity === null ? null : Quantity.of(l.quantity as unknown as string),
      unitQuantity: l.unitQuantity === null ? null : Quantity.of(l.unitQuantity as unknown as string),
      unitPrice: money(l.unitPrice as unknown as { amount: string; currency: string } | null),
      discount: money(l.discount as unknown as { amount: string; currency: string })!,
      amount: money(l.amount as unknown as { amount: string; currency: string })!,
      taxAmount: money(l.taxAmount as unknown as { amount: string; currency: string })!,
      totalInclTax: money(l.totalInclTax as unknown as { amount: string; currency: string })!,
      debit: money(l.debit as unknown as { amount: string; currency: string })!,
      credit: money(l.credit as unknown as { amount: string; currency: string })!,
      cost: money(l.cost as unknown as { amount: string; currency: string } | null),
      countedQuantity: null, expectedQuantity: null,
    })),
  }));
}
```

**`fifo-oldest-first/input.json`** — three documents, one item, one warehouse, MYR throughout. Each snapshot carries the members §4.4.2 declares; the ones this fixture does not exercise are their zero values, written out because a fixture with holes is a fixture that stops validating:

```json
[
  { "header": { "id": "d1", "companyId": "c1", "documentTypeCode": "STOCK_RECEIPT_TEST", "status": "issued",
      "series": "SRT", "fiscalPeriodId": "p1", "number": null, "effectiveDate": "2026-01-10", "partyId": null,
      "currency": "MYR", "exchangeRate": { "from": "MYR", "to": "MYR", "rate": "1.00000000", "effectiveFrom": "2026-01-01", "source": "unit" },
      "branchId": "b1", "attributedTo": null, "clientRef": null, "warehouseId": "w1", "toWarehouseId": null,
      "taxInclusive": false, "reversesDocumentId": null, "customFields": {} },
    "company": { "id": "c1", "baseCurrency": "MYR", "fxRoundingAccountId": "a5920", "costingMethod": "fifo" },
    "party": null,
    "refs": { "accountsByCode": { "1300": "a1300", "5000": "a5000", "5900": "a5900" }, "items": { "i1": { "id": "i1", "code": "GOLD", "kind": "product", "baseUnitId": "u1",
        "trackLots": false, "revenueAccountId": "a4000", "inventoryAccountId": "a1300", "cogsAccountId": "a5000", "expenseAccountId": "a5900" } },
      "taxCodes": {}, "components": {}, "schemes": {}, "dimensionTypesByCode": { "BRANCH": "dt1" } },
    "lines": [ { "id": "l1", "lineNo": 1, "kind": "item", "description": "first in", "accountId": null, "itemId": "i1",
        "quantity": "100.000000", "unitPrice": { "amount": "10.0000", "currency": "MYR" },
        "discount": { "amount": "0.0000", "currency": "MYR" }, "amount": { "amount": "1000.0000", "currency": "MYR" },
        "taxCodeId": null, "taxAmount": { "amount": "0.0000", "currency": "MYR" },
        "totalInclTax": { "amount": "1000.0000", "currency": "MYR" },
        "debit": { "amount": "0.0000", "currency": "MYR" }, "credit": { "amount": "0.0000", "currency": "MYR" },
        "cost": null, "warehouseId": "w1", "toWarehouseId": null, "lotId": null, "unitId": "u1",
        "unitQuantity": "100.000000", "countedQuantity": null, "expectedQuantity": null,
        "tenderMethod": null, "customFields": {}, "dimensions": {}, "payroll": null } ] },

  { "header": { "id": "d2", "companyId": "c1", "documentTypeCode": "STOCK_RECEIPT_TEST", "status": "issued",
      "series": "SRT", "fiscalPeriodId": "p2", "number": null, "effectiveDate": "2026-02-10", "partyId": null,
      "currency": "MYR", "exchangeRate": { "from": "MYR", "to": "MYR", "rate": "1.00000000", "effectiveFrom": "2026-01-01", "source": "unit" },
      "branchId": "b1", "attributedTo": null, "clientRef": null, "warehouseId": "w1", "toWarehouseId": null,
      "taxInclusive": false, "reversesDocumentId": null, "customFields": {} },
    "company": { "id": "c1", "baseCurrency": "MYR", "fxRoundingAccountId": "a5920", "costingMethod": "fifo" },
    "party": null,
    "refs": { "accountsByCode": { "1300": "a1300", "5000": "a5000", "5900": "a5900" }, "items": { "i1": { "id": "i1", "code": "GOLD", "kind": "product", "baseUnitId": "u1",
        "trackLots": false, "revenueAccountId": "a4000", "inventoryAccountId": "a1300", "cogsAccountId": "a5000", "expenseAccountId": "a5900" } },
      "taxCodes": {}, "components": {}, "schemes": {}, "dimensionTypesByCode": { "BRANCH": "dt1" } },
    "lines": [ { "id": "l2", "lineNo": 1, "kind": "item", "description": "second in", "accountId": null, "itemId": "i1",
        "quantity": "100.000000", "unitPrice": { "amount": "20.0000", "currency": "MYR" },
        "discount": { "amount": "0.0000", "currency": "MYR" }, "amount": { "amount": "2000.0000", "currency": "MYR" },
        "taxCodeId": null, "taxAmount": { "amount": "0.0000", "currency": "MYR" },
        "totalInclTax": { "amount": "2000.0000", "currency": "MYR" },
        "debit": { "amount": "0.0000", "currency": "MYR" }, "credit": { "amount": "0.0000", "currency": "MYR" },
        "cost": null, "warehouseId": "w1", "toWarehouseId": null, "lotId": null, "unitId": "u1",
        "unitQuantity": "100.000000", "countedQuantity": null, "expectedQuantity": null,
        "tenderMethod": null, "customFields": {}, "dimensions": {}, "payroll": null } ] },

  { "header": { "id": "d3", "companyId": "c1", "documentTypeCode": "STOCK_ISSUE_TEST", "status": "issued",
      "series": "SIT", "fiscalPeriodId": "p3", "number": null, "effectiveDate": "2026-03-05", "partyId": null,
      "currency": "MYR", "exchangeRate": { "from": "MYR", "to": "MYR", "rate": "1.00000000", "effectiveFrom": "2026-01-01", "source": "unit" },
      "branchId": "b1", "attributedTo": null, "clientRef": null, "warehouseId": "w1", "toWarehouseId": null,
      "taxInclusive": false, "reversesDocumentId": null, "customFields": {} },
    "company": { "id": "c1", "baseCurrency": "MYR", "fxRoundingAccountId": "a5920", "costingMethod": "fifo" },
    "party": null,
    "refs": { "accountsByCode": { "1300": "a1300", "5000": "a5000", "5900": "a5900" }, "items": { "i1": { "id": "i1", "code": "GOLD", "kind": "product", "baseUnitId": "u1",
        "trackLots": false, "revenueAccountId": "a4000", "inventoryAccountId": "a1300", "cogsAccountId": "a5000", "expenseAccountId": "a5900" } },
      "taxCodes": {}, "components": {}, "schemes": {}, "dimensionTypesByCode": { "BRANCH": "dt1" } },
    "lines": [ { "id": "l3", "lineNo": 1, "kind": "item", "description": "the issue that walks two layers", "accountId": null, "itemId": "i1",
        "quantity": "150.000000", "unitPrice": { "amount": "40.0000", "currency": "MYR" },
        "discount": { "amount": "0.0000", "currency": "MYR" }, "amount": { "amount": "6000.0000", "currency": "MYR" },
        "taxCodeId": null, "taxAmount": { "amount": "0.0000", "currency": "MYR" },
        "totalInclTax": { "amount": "6000.0000", "currency": "MYR" },
        "debit": { "amount": "0.0000", "currency": "MYR" }, "credit": { "amount": "0.0000", "currency": "MYR" },
        "cost": null, "warehouseId": "w1", "toWarehouseId": null, "lotId": null, "unitId": "u1",
        "unitQuantity": "150.000000", "countedQuantity": null, "expectedQuantity": null,
        "tenderMethod": null, "customFields": {}, "dimensions": {}, "payroll": null } ] }
]
```

All three documents are written out because `expected.json` is **generated from this file** and byte-compared afterwards: a fixture whose input two workers would type differently is a fixture whose expected output they cannot both reproduce. `d2` differs from `d1` in six values (`header.id`, `fiscalPeriodId`, `effectiveDate`, `lines[0].id`, `description`, and the three money figures that follow from `unitPrice` 20.0000); `d3` additionally changes `documentTypeCode`, `series` and the quantity.

**`fifo-oldest-first/policies.json`** is the two-entry map, and the same file serves all three cases except where the table below says otherwise. Each value is exactly the `policy` member of Task 6's two consts — `STOCK_ISSUE_COST_POLICY` and `STOCK_RECEIPT_COST_POLICY` — as JSON:

```json
{
  "STOCK_RECEIPT_TEST": {
    "version": 1, "documentType": "STOCK_RECEIPT_TEST", "direction": "inbound", "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "item.inventory_account" }, "amount": "line.amount", "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "credit", "account": { "code": "5900" },                   "amount": "line.amount", "when": { "line.kind": "item" } }
    ],
    "inventory": { "effect": "receipt", "warehouse": "line.warehouse", "costing": "create_layer" },
    "tax": { "applies": false },
    "numbering": { "series": "SRT", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "STOCK_ISSUE_TEST" },
    "approval": { "required": false, "approve": null, "post": "accounting.journal.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  },
  "STOCK_ISSUE_TEST": {
    "version": 1, "documentType": "STOCK_ISSUE_TEST", "direction": "outbound", "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "item.cogs_account" },      "amount": "line.cost", "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "credit", "account": { "from": "item.inventory_account" }, "amount": "line.cost", "when": { "line.kind": "item" } }
    ],
    "inventory": { "effect": "issue", "warehouse": "line.warehouse", "costing": "consume_layers" },
    "tax": { "applies": false },
    "numbering": { "series": "SIT", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "STOCK_RECEIPT_TEST" },
    "approval": { "required": false, "approve": null, "post": "accounting.journal.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

The `account.code` and `item.*_account` references resolve through `snapshot.refs`, which the fixture supplies in memory — `refs.accountsByCode` carries `"5900"` and `refs.items["i1"]` carries the three account ids. Nothing here reaches a database.

**The figures to verify by hand before committing `expected.json`** — this table is the pin, and the generated file must match it:

| Case | What it fixes | The number |
|---|---|---|
| `fifo-oldest-first` | FIFO takes the oldest layer whatever it costs | issue of 150 takes 100 @ 10.0000 then 50 @ 20.0000 → value **2000.0000**, unit cost `2000.0000 ÷ 150.000000` = **13.3333**; `layersAfter` = one layer, `mv-2-1`, `qtyRemaining` **50.000000** at 20.0000 |
| `avco-back-dated` | the recost's answer, without a database | same three documents in the same array order, plus a fourth `STOCK_RECEIPT_TEST` of 100 @ 30.0000 dated **2026-02-01** (post order fourth, chronological order **second**). The driver sorts by date, so the issue sees three layers averaging `(1000 + 3000 + 2000) ÷ 300` = **20.0000**; the issue of 150 costs **3000.0000** and takes 50 from each layer |
| `avco-edge-cases` | the guards' boundaries | three documents: (1) `STOCK_RECEIPT_TEST` of `0.000001` @ `100.0000`, so `amount = round(0.000001 × 100, 4) =` **0.0001** and `unitCost = 0.0001 ÷ 0.000001 =` **100.0000** — the smallest layer that is not a residue, with the divisor sitting exactly *on* `MIN_MEANINGFUL_QTY` and therefore passing (`lessThan`, not `lessThanOrEqualTo`); (2) `STOCK_ISSUE_TEST` of `0.000001`, which empties it exactly: `value` **0.0001**, `layersAfter` **empty**; (3) `STOCK_TRANSFER_TEST` (the `costing: "zero"` policy) issuing `1.000000` against the now-empty set: `value` **0.0000**, `consumptions` **empty** — the free-of-charge line of spec:1055 |

**`avco-edge-cases` needs a third map entry, and this is where the map earns its keep.** Its documents 1 and 2 use the two policies above; document 3 is the free-of-charge issue, so `policies.json` carries a **third** key whose document type is `STOCK_ISSUE_TEST` with `"costing": "zero"` — which cannot be expressed by editing the shared entry, because documents 2 and 3 are both `STOCK_ISSUE_TEST` and only one of them is free of charge. Give document 3 the `documentTypeCode` **`"STOCK_TRANSFER_TEST"`** (3A's third registered test-only code, §4.14 — no new code) and map it to an `effect: "issue"`, `costing: "zero"` policy with series `STT`. That is what the code is for and it keeps the map one-to-one with the type.

Note what `"costing": "zero"` does and does not do: Task 7 note 3 and the driver both zero the value for an **issue only**, so document 1's receipt still opens its layer at the movement's own value — which is why the table's first figure is `100.0000` and not `0.0000`.

- [ ] **Step 6: Generate, read, and commit `expected.json`**

Run: `bun run --cwd tests golden:costing`
Then **read all three generated files** and check every figure against the table above. Run: `git diff --stat tests/golden/costing` — three new files. A generated expected file nobody read is not a golden fixture; it is a snapshot of whatever the code did.

Run: `bun run --cwd tests test -- golden/costing.test.ts`
Expected: **PASS**, seven cases — one structural, then two per fixture across three fixtures.

- [ ] **Step 7: Run everything to verify it passes**

Run: `bun run --cwd packages/db test -- test/costing`
Expected: **PASS** — including Task 11's registry assertion, which was the one case left red.

Run: `bun run --cwd apps/worker test -- test/handlers/integrity-check.test.ts && bun run --cwd tests test`
Expected: **PASS** with the four-name `projections.checked` array in all three pinned places.

Run: `bun run typecheck && bun run lint && bun run lint:rules`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/integrity/cost-layer-check.ts packages/db/src/integrity/index.ts \
        packages/db/test/costing/layers.test.ts tests/golden/costing.test.ts tests/golden/costing \
        tests/package.json tests/invariants/audit-chain.test.ts tests/invariants/projection-rebuild.test.ts \
        apps/worker/test/handlers/integrity-check.test.ts
git commit -m "$(cat <<'EOF'
test(golden): COST_LAYER_CHECK and the costing fixtures [3B T12]

cost_layer joins 1B's projectionChecks with its one pure invariant —
qty_remaining = qty_in − Σ(valid consumptions). Invalidated layers are skipped:
between invalidateFrom and the replay a layer is legitimately mid-flight, and
a nightly job firing then must not raise an incident about work in progress.
Amendment A10: projections.checked becomes the four-name array in all three
pinned assertions, in this same PR.

Amendment A7's expected.json carries the plans, the per-document consumption
sets and the layer state after — a PostingPlan cannot say WHICH layers an
issue consumed, and that disagreement was the whole of LEGACY-009. A17 gives each
case its own policies.json map keyed by document type, because a snapshot alone does not say how to
post and one policy would plan a receipt as an issue.

The driver assigns postingSeq from array (post) order and then sorts by the
§4.3.5 chronological key, so a back-dated document costs first — one fixture
pins both the post path and the replay path with no database.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: The fourteen new regression files and two appended blocks, test 7's cost side, and the staging re-seed

**Files:**
- Create: `tests/regression/legacy-004.test.ts`, `legacy-006.test.ts`, `legacy-007.test.ts`, `legacy-009.test.ts`, `legacy-010.test.ts`, `legacy-015.test.ts`, `legacy-016.test.ts`, `legacy-017.test.ts`, `legacy-022.test.ts`, `legacy-054.test.ts`, `legacy-060.test.ts`, `legacy-061.test.ts`, `legacy-062.test.ts`, `legacy-076.test.ts`
- Create: `tests/regression/support/costing.ts` (**Step 1** — write it FIRST; every file above imports it), `scripts/reseed-verify.ts` (Step 6)
- Modify: `tests/regression/legacy-005.test.ts` (append), `tests/regression/legacy-008.test.ts` (append), `packages/db/package.json` (the `reseed:verify` script, Step 6), `tests/invariants/support/post-inventory.ts` (**verify only** — `beforePost` and `postOverriddenIssue` are Task 6's; extend additively if the head lacks either)
- Test: all of the above

**Interfaces:**
- Consumes: `sharedDb()` (contracts §4.17.1, 0B) — for the shared container only; **not** `thinRegression` or `ThinContext`, for the reason the second box below gives; `postInventoryDocument`, `postOverriddenIssue`, `recordingJobs`, `ensureOpenPeriods`, the two policy consts (Task 6); `replay`, `valuationAsOf`, `openLayersFor`, `rebuildStockValuation`, `reverseDocument`, `MOVEMENTS_PER_BATCH` (Tasks 7–11); `costingEngine`, `MIN_MEANINGFUL_QTY`, `Quantity`, `Money`, `currency`, `Layer` (Tasks 2–3); `seedTenantV2`, `seedItem`, `seedWarehouse`, `seedDocumentType`, `grantCodes`, `uuidv7` (§4.17, §4.1); `sourceFiles`, `SourceFile` **and `REPO_ROOT`** (§4.17.1); `loadDocumentTypes` (§4.3.7, as `@dulja/db/seed`) and `PERMISSIONS` (§4.2.5) — legal here because `tests/**` has no `dependency-rule` tier owner (0b:5064), and needed because `costingContext` seeds `COST_ADJUSTMENT` into its own tenant before `legacy-054` runs the replay.
- Produces: `costingContext(legacyDefect)` and `CostingFixture` in `tests/regression/support/costing.ts` — this slice's own regression module, registered by amendment A21(a) and **not** a `ThinContext` member (§4.17.1 registers only `sharedDb`/`ThinContext`/`thinRegression` in 0B's file). Fourteen regression files, per §3.7.3's rule that the first slice in execution order to touch a defect creates the file, plus two appended blocks. Also `scripts/reseed-verify.ts` and the `reseed:verify` script (Step 6).

**The one shared preamble.** Every file below opens with the same block, so each is independently runnable. The `costingContext` argument is the file's own LEGACY number and is **not decoration** — see the two boxes under it:

```ts
import { describe, expect, it } from "vitest";
import { costingEngine, MIN_MEANINGFUL_QTY, Quantity } from "@dulja/domain";
import { MOVEMENTS_PER_BATCH } from "@dulja/db";
import { postInventoryDocument, recordingJobs } from "../invariants/support/post-inventory";
import { costingContext } from "./support/costing";

const ctx = costingContext("004");        // ← this file's own LEGACY number
```

**Each file writes a plain `describe`, not a `thinRegression` call, and the title carries the ` — 3B` suffix §3.7.3 requires.** 0B's `thinRegression(legacyDefect, heading, cites: string, body)` invokes its body *inside a single `it`* (0b:5317–5326): a `test` declared within a running `test` is a Vitest error, `cites` is a `string` and not an array, and the body's parameter is 0B's `ThinContext` (`{ db, rw, a, b, withTenant, expect }`), which has none of this slice's helpers on it. The wrapper is right for the twenty-one one-assertion files 0B created and wrong for a costing file with two or more cases, so these files are **full** files in §3.7.3's own sense — the shape 0B used for `legacy-026`, `034` and `035`. Each `describe` is titled `LEGACY-NNN <Part I heading> — 3B`, each `it` names the file that first proved the fact, and appending to `legacy-005` / `legacy-008` adds a `describe` beside 0B's `thinRegression` call without touching it, exactly as 2A did for `legacy-013` (2a:4664).

**Each file also gets its own tenant, and that is load-bearing rather than tidy.** `costingContext(legacyDefect)` seeds `LEGACY-<legacyDefect>` on `sharedDb()`'s shared `Db` — one container for the whole run, one *company* per file. Sharing one company would make most of the absolute assertions below false in any file order: `legacy-006` expects the valuation of its item to be `undefined`, `legacy-015` expects it to be `undefined` before its own receipt, `legacy-016` expects a unit cost of exactly `1.0000` — and `legacy-004` leaves 100 units at 10.0000 on the shelf, while `legacy-005` deliberately back-dates a document with a `recordingJobs()` client and never runs the replay, leaving invalidated layers that every later `valuation` and `openLayers` read silently skips. Per-file tenants also give each file its own `seedTenantV2` company, which is what wires `fx_rounding_account_id` and the `1000`/`4000` accounts; `sharedDb()`'s `a` and `b` come from Plan 0A's `seedTenant`, which does not.

`costingContext` is written out in full in **Step 1** — write that file first, because every `ctx.*` call in the files below is defined there.

- [ ] **Step 1: Write `tests/regression/support/costing.ts` — every file below imports it**

**`ctx` is not a `ThinContext` member.** 0B owns `tests/support/regression.ts` and §4.17.1 registers exactly `sharedDb`, `ThinContext` and `thinRegression` there; adding sixteen costing helpers to another slice's shared file is the merge hotspot §4.17 exists to prevent. So the helpers live in **`tests/regression/support/costing.ts`**, this slice's own module (amendment A21(a)), and each file's block opens `const ctx = costingContext("<legacyDefect>");`. Write it in full — every regression file above depends on it:

```ts
// tests/regression/support/costing.ts — 3B's own regression helpers. Not a ThinContext member (§4.17.1).
// `tests/**` has no `dependency-rule` TIER owner (0b:5064), so this file may name any package it needs.
import { join } from "node:path";
import { PERMISSIONS } from "@dulja/contracts";
import { openLayersFor, rebuildStockValuation, replay, reverseDocument, valuationAsOf, withTenant } from "@dulja/db";
import { loadDocumentTypes } from "@dulja/db/seed";
import { currency, Money, Quantity, type Layer } from "@dulja/domain";
import { grantCodes, seedDocumentType, seedItem, seedTenantV2, seedWarehouse, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { sharedDb } from "../../support/regression";
import { REPO_ROOT, sourceFiles as walk, type SourceFile } from "../../support/source";
// `postInventoryDocument` is deliberately NOT imported here: the regression files call it directly, and an
// import this module does not use fails `bun run lint`.
import { ensureOpenPeriods, postOverriddenIssue, recordingJobs,
         STOCK_ISSUE_COST_POLICY, STOCK_RECEIPT_COST_POLICY } from "../../invariants/support/post-inventory";

const MYR = currency("MYR");

export interface CostingFixture {
  db: Db; s: Seed; item: string; warehouse: string; receipt: string; issueType: string;
}

/**
 * @param legacyDefect this file's LEGACY number, e.g. "004". It names the tenant, and the ISOLATION is the point:
 *   one company per regression file. The files below assert absolute figures — a valuation that is
 *   `undefined`, a unit cost of exactly 1.0000 — and every one of them would be false in some file order if
 *   they shared a company, because `legacy-004` leaves stock on the shelf and `legacy-005` deliberately leaves
 *   invalidated layers behind (it back-dates against a `recordingJobs()` client and never runs the replay).
 *   The container is still shared: `sharedDb()` starts one for the whole `tests` run (§4.17.1).
 *   `seedTenantV2` rather than `sharedDb().a` because 1A's version wires `fx_rounding_account_id` and the
 *   1000/4000 accounts that every policy in this slice resolves; Plan 0A's `seedTenant` does not.
 */
export function costingContext(legacyDefect: string) {
  let fixture: CostingFixture | null = null;
  const ctxOf = async (s: Seed, db: Db) =>
    ({ tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) });

  const api = {
    /** This file's own tenant, item, warehouse and two document types, memoised after the first call. */
    async inventory(): Promise<CostingFixture> {
      if (fixture) return fixture;
      const { db } = await sharedDb();
      const s = await seedTenantV2(db, `LEGACY-${legacyDefect}`);
      await grantCodes(db, s);
      await ensureOpenPeriods(db, s, 2026);
      const { itemId } = await seedItem(db, s, { code: "LEGACY-COST" });
      // `COST_ADJUSTMENT` has to exist in THIS tenant before `runReplay`: `replay` calls
      // `resolveAdjustmentAccounts` unconditionally as soon as anything is in scope (Task 9 Step 3), and
      // that raises `ERR_NOT_FOUND` on a missing document type before any arithmetic. `legacy-054` asserts one
      // adjustment IS posted, so this load is load-bearing rather than defensive. The path is absolute
      // because Vitest runs the `tests` workspace from `tests/` — a bare `"packages/db/seed/…"` would
      // resolve under `tests/` and the loader would raise ENOENT (0B's `REPO_ROOT`, §4.17.1).
      const seedCtx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
      await withTenant(db.migrator, seedCtx, (tx) =>
        loadDocumentTypes(tx, seedCtx, join(REPO_ROOT, "packages", "db", "seed", "my", "document-types"),
                          PERMISSIONS.map((p) => p.code)));
      fixture = {
        db, s, item: itemId,
        warehouse: await seedWarehouse(db, s, { code: "LEGACY-WH" }),
        receipt: await seedDocumentType(db, s, { code: "STOCK_RECEIPT_TEST", module: "inventory", policy: STOCK_RECEIPT_COST_POLICY }),
        issueType: await seedDocumentType(db, s, { code: "STOCK_ISSUE_TEST", module: "inventory", policy: STOCK_ISSUE_COST_POLICY }),
      };
      return fixture;
    },

    async secondWarehouse(db: Db, s: Seed): Promise<string> {
      return seedWarehouse(db, s, { code: "LEGACY-WH2" });
    },

    /**
     * The one valuation row for this fixture's item. **Throws** when there is none, so a caller can read
     * `.unitCost` without a `!`: `tsconfig.base.json` sets `noUncheckedIndexedAccess` (plan0A:281), so a
     * helper returning `rows[0]` gives every call site a `ValuationRow | undefined` and every property
     * access a compile error. The two cases that assert ABSENCE use `valuationOrNone` below.
     */
    async valuation(db: Db, s: Seed, asOf: string) {
      const rows = await api.valuationRows(db, s, asOf);
      const row = rows[0];
      if (!row) throw new Error(`no valuation row for this fixture's item as at ${asOf} (the quantity is zero)`);
      return row;
    },
    /** The same read, for the two cases whose whole point is that the row is not there. */
    async valuationOrNone(db: Db, s: Seed, asOf: string) {
      return (await api.valuationRows(db, s, asOf))[0];
    },
    async valuationRows(db: Db, s: Seed, asOf: string) {
      return withTenant(db.rw, await ctxOf(s, db), (tx) =>
        valuationAsOf(tx, { companyId: s.company, asOf, limit: 50 }));
    },
    async openLayers(db: Db, s: Seed, itemId: string, warehouseId: string): Promise<Layer[]> {
      return withTenant(db.rw, await ctxOf(s, db), (tx) =>
        openLayersFor(tx, { companyId: s.company, itemId, warehouseId, baseCurrency: MYR }));
    },
    async storedValuation(db: Db, s: Seed, asOf: string) {
      return withTenant(db.rw, await ctxOf(s, db), (tx) => tx<{ quantity: string; value: string; updated_at: string }[]>`
        select quantity::text, value::text, updated_at::text from app.stock_valuation
         where company_id = ${s.company} and as_of = ${asOf}::date`);
    },
    async rebuild(db: Db, s: Seed, asOf: string) {
      return withTenant(db.rw, await ctxOf(s, db), (tx) => rebuildStockValuation(tx, { companyId: s.company, asOf }));
    },
    async runReplay(db: Db, s: Seed) {
      const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
      return replay(db.rw, { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } }, ctx);
    },
    async reverse(db: Db, s: Seed, documentId: string, effectiveDate: string) {
      const ctx = await ctxOf(s, db);
      return withTenant(db.rw, ctx, (tx) =>
        reverseDocument(tx, ctx, { documentId, effectiveDate, reason: "regression fixture", jobs: recordingJobs() }));
    },

    /**
     * An issue the layers cannot cover, authorised the ONLY way F-6 admits. It **delegates** to Task 6's
     * `postOverriddenIssue` rather than re-deriving the sequence: `app.assert_override_authorised` refuses
     * the obvious shaping twice — the attributed principal may not be the document's creator, and
     * `recordOverride` takes `actor_id` from `app.current_actor()`, so a second *actor* cannot exist inside
     * one transaction — and one file getting that wrong would be one file silently not testing an override.
     */
    async overriddenIssue(db: Db, s: Seed, documentTypeId: string, warehouseId: string, itemId: string, quantity: string, effectiveDate: string) {
      return postOverriddenIssue(db, s, { documentTypeId, itemId, warehouseId, quantity, effectiveDate });
    },

    async sumDocumentLineCost(db: Db, s: Seed): Promise<string> {
      const [row] = await withTenant(db.rw, await ctxOf(s, db), (tx) => tx<{ v: string }[]>`
        select coalesce(sum(l.cost), 0)::text as v
          from app.document_line l
          join app.inventory_movement m on m.document_id = l.document_id and m.line_no = l.line_no
         where l.company_id = ${s.company} and m.quantity < 0`);
      return row!.v;
    },
    async sumConsumptionValue(db: Db, s: Seed): Promise<string> {
      const [row] = await withTenant(db.rw, await ctxOf(s, db), (tx) => tx<{ v: string }[]>`
        select coalesce(sum(value), 0)::text as v from app.cost_consumption
         where company_id = ${s.company} and invalidated_at is null`);
      return row!.v;
    },
    /**
     * The valued-but-unconsumed part of every authorised shortfall (ADR 0038 note 7), derived from
     * **quantities and unit costs** — NOT as `Σ document_line.cost − Σ cost_consumption.value`. Deriving it
     * by that subtraction would make `legacy-009`'s first assertion (`Σ consumption + shortfall = Σ cost`) an
     * identity that holds over any data at all, including data where costing is broken, which is the one
     * thing that tie-out exists to detect.
     *
     * The formula: for every issue movement whose consumptions do not cover its quantity, the uncovered
     * quantity times the unit cost those consumptions were taken at. Under AVCO every consumption row of one
     * movement carries the same `unit_cost` — the running average, which is exactly what the engine values a
     * shortfall at — so `max(c.unit_cost)` IS that figure. A movement with no consumption row at all
     * (an override issue against no layers) coalesces to a 0.0000 unit cost, which is also what the engine
     * computes there: the average of an empty layer set. **AVCO only**, which is what every fixture in this
     * slice uses; a FIFO company's shortfall would need `average(openLayers)` at the movement's own point and
     * is not exercised here.
     *
     * `round(…, 4)` matters: `numeric(19,6) × numeric(19,4)` is a 10-dp result, and an unrounded
     * "120.0000000000" would never equal a 4-dp figure from `document_line.cost`.
     */
    async openShortfallValue(db: Db, s: Seed): Promise<string> {
      const [row] = await withTenant(db.rw, await ctxOf(s, db), (tx) => tx<{ v: string }[]>`
        select coalesce(round(sum((abs(m.quantity) - coalesce(c.qty, 0)) * coalesce(c.unit_cost, 0)), 4), 0)::text as v
          from app.inventory_movement m
          left join (
            select cc.movement_id, sum(cc.quantity) as qty, max(cc.unit_cost) as unit_cost
              from app.cost_consumption cc
             where cc.company_id = ${s.company} and cc.invalidated_at is null
             group by cc.movement_id) c on c.movement_id = m.id
         where m.company_id = ${s.company}
           and m.quantity < 0
           and abs(m.quantity) > coalesce(c.qty, 0)`);
      return row!.v;
    },
    async receiptValue(db: Db, s: Seed): Promise<string> {
      const [row] = await withTenant(db.rw, await ctxOf(s, db), (tx) => tx<{ v: string }[]>`
        select coalesce(sum(value), 0)::text as v from app.inventory_movement
         where company_id = ${s.company} and quantity > 0`);
      return row!.v;
    },
    /** Money arithmetic in SQL, so no JavaScript number ever touches an amount — not even in a test.
     *  `round(…, 4)` so the result is comparable to a `numeric(19,4)` column rendered as text. */
    async plus(db: Db, a: string, b: string): Promise<string> {
      const [row] = await db.admin<{ v: string }[]>`select round(${a}::numeric + ${b}::numeric, 4)::text as v`;
      return row!.v;
    },
    async minus(db: Db, a: string, b: string): Promise<string> {
      const [row] = await db.admin<{ v: string }[]>`select round(${a}::numeric - ${b}::numeric, 4)::text as v`;
      return row!.v;
    },

    async sourceFiles(roots: string[]): Promise<SourceFile[]> { return walk(roots); },

    /** The two pure inputs `legacy-007` and `legacy-008` hand straight to the engine. */
    valuelessReceipt() {
      return {
        method: "avco" as const, openLayers: [], allowShortfall: false,
        movement: {
          lineNo: 1, movementNo: 1, itemId: "i", warehouseId: "w", lotId: "l",
          quantity: Quantity.of("10.000000"), effect: "receipt" as const, value: null,
          costing: "create_layer" as const, effectiveDate: "2026-01-01", postingSeq: 1n, movementId: "m",
        },
      };
    },
    /**
     * A ZERO-quantity issue — LEGACY-008(c)'s wash line. Named for what it is: there is no such thing as a
     * sub-micro `Quantity` (`Quantity.of` throws above six decimal places, 0d:1034-1039), so the engine's
     * `MIN_MEANINGFUL_QTY` refusal cannot be reached from a constructed quantity and this is the arm of
     * LEGACY-008 a runtime input can still present. It is refused with `ERR_COST_VALUE_MISSING`.
     */
    washLineIssue() {
      const layer: Layer = {
        id: "L", itemId: "i", warehouseId: "w", lotId: "l", movementId: "m0",
        qtyIn: Quantity.of("0.000001"), unitCost: Money.of("1.0000", MYR), qtyRemaining: Quantity.of("0.000001"),
        effectiveDate: "2026-01-01", postingSeq: 1n, lineNo: 1, movementNo: 1,
      };
      return {
        method: "avco" as const, openLayers: [layer], allowShortfall: true,
        movement: {
          lineNo: 1, movementNo: 1, itemId: "i", warehouseId: "w", lotId: "l",
          quantity: Quantity.of("0.000000"), effect: "issue" as const, value: Money.zero(MYR),
          costing: "consume_layers" as const, effectiveDate: "2026-02-01", postingSeq: 2n, movementId: "m1",
        },
      };
    },
  };
  return api;
}
```

**The two members of Task 6's helper this file leans on are already in it** — `PostInventoryOptions.beforePost` and `postOverriddenIssue` — and both are recorded in amendment A21(b). Verify rather than re-add: `beforePost` runs after the lines are inserted and before `postDocument`, which is the only window an override event can be written in (the event must exist when `assert_stock_available` fires, and that trigger fires *inside* `postDocument`), and `postOverriddenIssue` is the one place the override sequence is spelled out, because §4.5.3's guard refuses two plausible shapings of it. If either is missing from the head you are working on, add it there — in `tests/invariants/support/post-inventory.ts`, additively (§4.17's rule) — and not a second copy here.

- [ ] **Step 2: Write the four costing-core files — 004, 007, 008 (append), 009**

`legacy-004.test.ts` — *Weighted-average cost is advanced on INSERT but never recomputed on UPDATE or DELETE, and nothing can rebuild it.* The old system's failure: buy 100 @ 10, buy 100 @ 20 (cost 15), delete the second purchase, quantity returns to 100 and **cost stays 15**, permanently, with no recovery path.

```ts
describe("LEGACY-004 Weighted-average cost advanced on INSERT only, with no rebuild path — 3B", () => {          // first proven by spec:231, spec:1210
  it("cost is a function of the movements, so reversing the second purchase restores the first's cost", async () => {
    const { db, s, item, warehouse, receipt } = await ctx.inventory();
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-01-10",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "100.000000", unitPrice: "10.0000" }] });
    const second = await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-01-20",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "100.000000", unitPrice: "20.0000" }] });
    const mid = await ctx.valuation(db, s, "2026-01-31");
    expect(mid.unitCost).toBe("15.0000");

    await ctx.reverse(db, s, second.documentId, "2026-01-25");
    const after = await ctx.valuation(db, s, "2026-01-31");
    // The old system left 15.0000 here for ever. There is no running scalar to leave stale: the layers are
    // derived from an immutable, ordered movement ledger, and the reversal added movements.
    expect(after.quantity).toBe("100.000000");
    expect(after.unitCost).toBe("10.0000");
  });
});
```

`legacy-007.test.ts` — *Production/repackaging writes value-less movements that NULL-poison a material's cost for all history.*

```ts
describe("LEGACY-007 Value-less movements NULL-poison a material's cost — 3B", () => {          // first proven by spec:264, spec:1226
  it("a receipt with no value is refused by the engine, and value is NOT NULL on the table", async () => {
    expect(() => costingEngine.cost(ctx.valuelessReceipt())).toThrow(/ERR_COST_VALUE_MISSING/);
  });
  it("value is NOT NULL in the database, so no path can store one", async () => {
    const { db } = await ctx.inventory();
    const [col] = await db.admin<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'inventory_movement' and column_name = 'value'`;
    expect(col!.is_nullable).toBe("NO");
  });
});
```

`legacy-008.test.ts` — **append** (0B created it, §3.7.3). One block, and the same two placements 2A used at 2a:4664: the preamble's imports go into the file's **existing import block at the top** (0B's version imports only `thinRegression`, so `describe`, `it`, `expect` and every `@dulja/*` name are new there) and `const ctx = costingContext("008");` goes beside them at module scope; the `describe` is appended at the **end**, leaving 0B's `thinRegression` call untouched. The same applies to `legacy-005.test.ts` in Step 3.

```ts
describe("LEGACY-008 Weighted-average cost can go negative, explode 10,000x, or be wiped — 3B", () => {
  it("a residue cannot even be expressed as a quantity, so no divisor can explode a cost", () => {
    // Two guards, and the first is the reason the second is unreachable. `Quantity` is fixed at six decimal
    // places and `Quantity.of` throws above them (0d:1034-1039), so the 0.0001-scale residue that gave the
    // old system a divisor of −0.0001 and a stored unit cost of 500,020.00 has no representation here.
    // MIN_MEANINGFUL_QTY is therefore the smallest expressible non-zero quantity, and the engine's refusal
    // below it (amendment A22 — refused, not clamped) guards a future scale change rather than an input.
    expect(() => Quantity.of("0.0000005")).toThrow(/at most 6 decimal places/);
    expect(MIN_MEANINGFUL_QTY.toString()).toBe("0.000001");
  });
  it("a wash line — the zero-quantity arm of LEGACY-008 — is refused, never costed at zero", () => {
    // This is the arm a runtime input can still present: a landed-cost or reconciliation line of zero
    // quantity. The old system set Cost = 0 and every later sale booked zero COGS.
    expect(() => costingEngine.cost(ctx.washLineIssue()))
      .toThrow(/ERR_COST_VALUE_MISSING.*quantity is zero/s);
  });
  it("negative unit_cost and negative qty_remaining are CHECKs, not conventions", async () => {
    const { db } = await ctx.inventory();
    const checks = await db.admin<{ constraint_name: string }[]>`
      select con.conname as constraint_name from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
       where rel.relname = 'cost_layer' and con.contype = 'c' order by 1`;
    expect(checks.map((c) => c.constraint_name)).toEqual(
      expect.arrayContaining(["cost_layer_qty_remaining_check", "cost_layer_unit_cost_check"]));
  });
});
```

`legacy-009.test.ts` — *Three different weighted-average formulas exist, so cost and profit reports cannot reconcile.* **This file is also acceptance test 7's cost side** (§6.1: test 7 is 3D's, re-run partially here; hazard 4 splits it cost-side at 3D and revenue-bearing from 4B):

```ts
describe("LEGACY-009 Three weighted-average formulas that cannot reconcile — 3B", () => {          // first proven by spec:286, spec:1228, spec:2425
  it("there is exactly ONE weighted-average implementation in the repository", async () => {
    // The mechanical half: no file outside packages/domain/src/costing/ divides a value by a quantity.
    const offenders = (await ctx.sourceFiles(["packages", "apps"]))
      .filter((f) => !f.path.includes("packages/domain/src/costing/"))
      .filter((f) => /\/\s*(?:sum|total)?[Vv]alue\s*\/\s*(?:sum|total)?[Qq]/.test(f.text) || /runningAverage|weightedAverage/.test(f.text));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("the valuation figure and the cost a profit report reads are the same number, to the cent (test 7, cost side)", async () => {
    const { db, s, item, warehouse, receipt, issueType } = await ctx.inventory();
    const jobs = recordingJobs();
    // Bought twice, sold once, GONE NEGATIVE under an authorised override, then a supplier return.
    await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-01-05",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "60.000000", unitPrice: "10.0000" }] });
    await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-01-15",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "40.000000", unitPrice: "15.0000" }] });
    await postInventoryDocument(db, s, { documentTypeId: issueType, warehouseId: warehouse, jobs, effectiveDate: "2026-01-20",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "70.000000", unitPrice: "50.0000" }] });
    // The excursion: only through inventory.negative_stock.override, recorded by a SECOND principal (F-6).
    await ctx.overriddenIssue(db, s, issueType, warehouse, item, "40.000000", "2026-01-25");
    await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-01-28",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "20.000000", unitPrice: "18.0000" }] });

    const valuation = await ctx.valuation(db, s, "2026-01-31");
    const fromLines = await ctx.sumDocumentLineCost(db, s);        // Σ document_line.cost over the issues
    const fromConsumptions = await ctx.sumConsumptionValue(db, s); // Σ cost_consumption.value, valid rows only
    const shortfall = await ctx.openShortfallValue(db, s);         // derived from QUANTITIES, not by subtraction
    const receipts = await ctx.receiptValue(db, s);

    // Every figure above, worked by hand, so the next reader checks the assertions instead of re-deriving
    // them — and so a wrong one shows up as a wrong number rather than as a green test:
    //   receipts        60 @ 10 + 40 @ 15 + 20 @ 18                              = 600 + 600 + 360 = 1560.0000
    //   issue of 70     average (600 + 600) ÷ 100 = 12.0000, so                             70 × 12 =  840.0000
    //   issue of 40     30 remain at the same 12.0000 average → 360.0000 consumed,
    //                   plus 10 units of AUTHORISED shortfall valued at 12.0000  →  360 + 120 =  480.0000
    //   Σ document_line.cost over the two issues                                    840 + 480 = 1320.0000
    //   Σ valid cost_consumption.value                                              840 + 360 = 1200.0000
    //   open shortfall  (40 − 30) × 12.0000                                                    =  120.0000
    //   closing layers  20 @ 18                                                                =  360.0000
    //
    // (1) The consumption side plus the shortfall is the line side. NON-VACUOUS: the shortfall came from
    //     `(|movement.quantity| − Σ consumed quantity) × the average it was consumed at`, so this fails if
    //     the engine values a shortfall at anything other than the running average, if a consumption row is
    //     missing, or if document_line.cost is not the engine's own answer.  1200 + 120 = 1320.
    expect(await ctx.plus(db, fromConsumptions, shortfall)).toBe(fromLines);
    // (2) Closing value + what was issued − the unconsumed shortfall = what came in. That last term is the
    //     one ADR 0038 note 7 makes necessary: the shortfall is on the LINE (and so in `fromLines`) but was
    //     never in stock, so it is not part of what the receipts brought in.  360 + 1320 − 120 = 1560.
    expect(await ctx.minus(db, await ctx.plus(db, valuation.value, fromLines), shortfall)).toBe(receipts);
    expect(receipts).toBe("1560.0000");        // pin the fixture itself, so a drifted seed is not a drifted rule
  });
});
```

`ctx.plus(db, a, b)` does the addition in **SQL** — `select ($1::numeric + $2::numeric)::text` — so no JavaScript number touches money even here, where `tests/` being outside the lint roots (§3.7.5) would have permitted it. A tie-out asserted through `Number` is a tie-out that can be off by a float epsilon, which is the class of defect this whole file exists to prevent.

**What 3D completes.** This file's second case has no *transfer* — `TRANSFER`/`TRANSFER_RECEIPT` are 3D's document types, and test 7's full clause is "transferred, gone negative, and had a supplier return". 3D appends its block with the transfer leg and 7B appends the revenue-bearing half over 4B's `item_profitability`. The append leaves this block untouched (§3.7.3).

- [ ] **Step 3: Write the five invalidation-and-replay files — 005 (append), 010, 054, 061, 062**

`legacy-005.test.ts` — **append**:

```ts
describe("LEGACY-005 CstChanged never set on INSERT, so back-dated documents were never recosted — 3B", () => {          // first proven by spec:242, spec:1220
  it("invalidation is STRUCTURAL — a row's own invalidated_at, never a flag set from three of four paths", async () => {
    const { db } = await ctx.inventory();
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name in ('cost_layer', 'cost_consumption') and column_name like '%changed%'`;
    expect(cols).toEqual([]);          // there is no dirty flag to forget to set
  });
  it("a back-dated post enqueues the replay in the SAME transaction, or refuses to post", async () => {
    const { db, s, item, warehouse, receipt } = await ctx.inventory();
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-03-01",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "5.000000", unitPrice: "5.0000" }] });
    await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-02-01",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "5.000000", unitPrice: "9.0000" }] });
    expect(jobs.enqueued.map((j) => j.name)).toEqual(["inventory.cost.replay"]);
  });
});
```

`legacy-010.test.ts` — *`procCalcJobCosts` cannot compute per-job cost: the dimension was added to the SELECT list but not to the ordering or the group break.*

```ts
describe("LEGACY-010 A costing dimension in the SELECT list but not in the sort or the group break — 3B", () => {          // first proven by spec:302, spec:1225
  it("the chronological key is all four columns, spelled out, in every costing ordering", async () => {
    const files = await ctx.sourceFiles(["packages/db/src/costing", "packages/domain/src/costing"]);
    const orderings = files.flatMap((f) => f.text.split("\n").filter((l) => /order by/i.test(l)));
    expect(orderings.length).toBeGreaterThan(0);
    for (const line of orderings) {
      // Every ordering names a date, a sequence, a line and a movement — or it is not the costing key.
      expect(line).toMatch(/effective_(date|at).*(sequence|posting_seq).*line_no.*movement_no/);
    }
  });
  it("a layer's scope is (company, item, warehouse) in the read AND in the group, so the two cannot disagree", async () => {
    const { db, s, item, warehouse } = await ctx.inventory();
    const layers = await ctx.openLayers(db, s, item, warehouse);
    expect(layers.every((l) => l.itemId === item && l.warehouseId === warehouse)).toBe(true);
  });
});
```

`legacy-054.test.ts` — *A full recost aborts on the first historical below-cost sale, rolling back every material already processed.*

```ts
describe("LEGACY-054 A full recost aborts on the first historical below-cost sale — 3B", () => {          // first proven by spec:674, spec:1368
  it("the replay is many bounded transactions, and a below-cost historical sale does not abort it", async () => {
    const { db, s, item, warehouse, receipt, issueType } = await ctx.inventory();
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-01-10",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "10.000000", unitPrice: "10.0000" }] });
    // Sold at 4.0000 — below what it will cost after the back-dated purchase lands. The old system raised
    // MatOvercost here, from an ENTRY-TIME guard applied to a system-generated correction, and lost the run.
    await postInventoryDocument(db, s, { documentTypeId: issueType, warehouseId: warehouse, jobs, effectiveDate: "2026-01-12",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "10.000000", unitPrice: "4.0000" }] });
    await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-01-05",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "10.000000", unitPrice: "90.0000" }] });
    const out = await ctx.runReplay(db, s);
    expect(out.movementsReplayed).toBeGreaterThan(0);
    expect(out.adjustmentsPosted).toHaveLength(1);
  });
  it("MOVEMENTS_PER_BATCH is finite, so no recost is one all-or-nothing transaction", () => {
    expect(MOVEMENTS_PER_BATCH).toBe(500);
  });
});
```

`legacy-061.test.ts` — *`procUpdateMatCosts` resets every material's cost to its opening value, permanently.*

```ts
describe("LEGACY-061 A repair that reset every cost to its opening value, permanently — 3B", () => {          // first proven by spec:721, spec:1210
  it("the replay recomputes from the movements — there is no 'reset to opening' path at all", async () => {
    const files = await ctx.sourceFiles(["packages/db/src/costing"]);
    // No statement sets a layer's unit_cost from anything but the movement it derives from.
    for (const f of files) {
      for (const line of f.text.split("\n").filter((l) => /set\s+unit_cost/.test(l))) {
        expect(line).not.toMatch(/opening|initial|seed/i);
      }
    }
  });
});
```

`legacy-062.test.ts` — *`procCalcCosts` writes the wrong watermark document at every group break.*

```ts
describe("LEGACY-062 The watermark written at a group break pointed at another material's document — 3B", () => {          // first proven by spec:724
  it("there is no watermark column to point at the wrong row", async () => {
    const { db } = await ctx.inventory();
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'cost_layer'`;
    expect(cols.map((c) => c.column_name)).not.toContain("master_document_id");
    // The resume point is derived from committed row state each run (ADR 0038), so a group break cannot
    // attribute it to the wrong item: it is a per-row invalidated_at, not a per-item scalar.
    expect(cols.map((c) => c.column_name)).toContain("invalidated_at");
  });
});
```

- [ ] **Step 4: Write the seven aggregate-and-duplication files — 006, 015, 016, 017, 022, 060, 076**

`legacy-006.test.ts` — *Editing a bill line's material permanently desynchronises cost aggregates: `−old + new` keyed on the OLD key.*

```ts
describe("LEGACY-006 An edit keyed on the OLD key desynchronised two aggregates for ever — 3B", () => {          // first proven by spec:251, spec:1210
  it("there is no in-place aggregate maintenance to key wrongly — movements are append-only and signed", async () => {
    const { db } = await ctx.inventory();
    const [triggers] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relname = 'inventory_movement' and t.tgname = 'inventory_movement_immutable'`;
    expect(triggers!.n).toBe(1);          // an UPDATE is refused outright, so there is no edit path to get wrong
  });
  it("re-pointing an item means reversing the document and posting a new one, which nets to zero", async () => {
    const { db, s, item, warehouse, receipt } = await ctx.inventory();
    const jobs = recordingJobs();
    const first = await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-01-10",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "100.000000", unitPrice: "10.0000" }] });
    await ctx.reverse(db, s, first.documentId, "2026-01-11");
    // `valuationOrNone`, not `valuation`: absence IS the assertion here, and `valuation` throws on it.
    expect(await ctx.valuationOrNone(db, s, "2026-01-31")).toBeUndefined();   // 100 in, 100 out, nothing left
  });
});
```

`legacy-015.test.ts` — *A date window computed with a predicate that can never be satisfied, driving a time-weighted average to NULL.*

```ts
describe("LEGACY-015 A date window computed from a predicate that can never be satisfied — 3B", () => {          // first proven by spec:347, spec:2039
  it("the as-of window is the ONE parameter, and it filters the same set the body sums", async () => {
    const { db, s, item, warehouse, receipt } = await ctx.inventory();
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-05-10",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "10.000000", unitPrice: "10.0000" }] });
    // Before the receipt: no row at all — never a NULL average, never a blank figure with no error.
    expect(await ctx.valuationOrNone(db, s, "2026-04-30")).toBeUndefined();
    expect((await ctx.valuation(db, s, "2026-05-31")).unitCost).toBe("10.0000");
  });
});
```

`legacy-016.test.ts` — *`MatStatus` min/max prices ratchet permanently and are maintained only on INSERT.*

```ts
describe("LEGACY-016 Min/max prices that ratchet permanently, maintained on INSERT only — 3B", () => {          // first proven by spec:354, spec:1210
  it("no ratcheting extreme is stored anywhere in the costing tables", async () => {
    const { db } = await ctx.inventory();
    const cols = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app' and table_name in ('cost_layer', 'cost_consumption', 'stock_valuation')`;
    for (const c of cols) expect(c.column_name).not.toMatch(/min|max|latest|lowest|highest/i);
  });
  it("a mis-keyed price is corrected by reversing the document, and the layer follows", async () => {
    const { db, s, item, warehouse, receipt } = await ctx.inventory();
    const jobs = recordingJobs();
    const fat = await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-01-10",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "1.000000", unitPrice: "0.0100" }] });
    await ctx.reverse(db, s, fat.documentId, "2026-01-10");
    await postInventoryDocument(db, s, { documentTypeId: receipt, warehouseId: warehouse, jobs, effectiveDate: "2026-01-10",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "1.000000", unitPrice: "1.0000" }] });
    expect((await ctx.valuation(db, s, "2026-01-31")).unitCost).toBe("1.0000");
  });
});
```

`legacy-017.test.ts` — *Order-delivery tracking double-adds bonus on edit and never reverses on re-pointing.* 3B's share is the open-quantity **projection** clause the card names (with 3C and 3D):

```ts
describe("LEGACY-017 Delivery tracking double-added on edit and never reversed on re-pointing — 3B", () => {          // first proven by spec:361, spec:1204
  it("every quantity aggregate in this slice is a SUM over append-only rows, never an incremental += ", async () => {
    const files = await ctx.sourceFiles(["packages/db/src/costing"]);
    for (const f of files) {
      // No statement adds a delta to a stored quantity; the two that write one write a computed total.
      expect(f.text).not.toMatch(/set\s+qty_remaining\s*=\s*qty_remaining\s*[+-]/);
    }
  });
});
```

The `qty_remaining = qty_remaining ±` form is exactly what ADR 0038's restore pass avoids, and this assertion is why: the restore is `qty_in − Σ valid`, a total, so a re-run is idempotent. 3C and 3D append their `document_link` fulfilment-quantity blocks to this file.

`legacy-022.test.ts` — *A `SELECT … INTO` that ignores a key column and hard-fails on any multi-job opening balance.*

```ts
describe("LEGACY-022 A singleton SELECT that omitted a key column and raised -811 — 3B", () => {          // first proven by spec:412
  it("every costing read is keyed on its full primary key, and two rows are two rows", async () => {
    const { db, s, item, warehouse } = await ctx.inventory();
    const second = await ctx.secondWarehouse(db, s);
    const jobs = recordingJobs();
    for (const w of [warehouse, second]) {
      await postInventoryDocument(db, s, { documentTypeId: (await ctx.inventory()).receipt, warehouseId: w, jobs, effectiveDate: "2026-01-10",
        lines: [{ itemId: item, warehouseId: w, quantity: "1.000000", unitPrice: "7.0000" }] });
    }
    // One item in two warehouses is TWO valuation rows, never a -811 and never a silent first-of-many.
    const rows = await ctx.valuationRows(db, s, "2026-01-31");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.warehouseId)).size).toBe(2);
  });
});
```

`legacy-060.test.ts` — *`procFixMatStatus` uses two different sort orders and drops columns it rebuilds.*

```ts
describe("LEGACY-060 A repair with two different sort orders that dropped columns it rebuilt — 3B", () => {          // first proven by spec:718, spec:1204
  it("the rebuild writes every column of stock_valuation, and reading it twice gives one answer", async () => {
    const { db, s } = await ctx.inventory();
    const first = await ctx.rebuild(db, s, "2026-01-31");
    const second = await ctx.rebuild(db, s, "2026-01-31");
    expect(second).toEqual(first);
    const [row] = await ctx.storedValuation(db, s, "2026-01-31");
    // Every non-key column is written by the rebuild — none is dropped from the insert list.
    expect(Object.keys(row ?? {}).sort()).toEqual(["quantity", "updated_at", "value"]);
  });
});
```

`legacy-076.test.ts` — *9% of the corpus is duplicate or near-duplicate code; the 0.77-similar costing pair is the source of LEGACY-010.*

```ts
describe("LEGACY-076 Duplicate and near-duplicate costing procedures — 3B", () => {          // first proven by spec:841, spec:1228
  it("costingEngine is the only export any consumer imports, and there is exactly one of it", async () => {
    const files = await ctx.sourceFiles(["packages", "apps"]);
    const definitions = files.filter((f) => /export const costingEngine\b/.test(f.text));
    expect(definitions.map((f) => f.path)).toEqual(["packages/domain/src/costing/engine.ts"]);
    const consumers = files.filter((f) => /\bcostingEngine\b/.test(f.text) && f.path !== definitions[0]!.path);
    expect(consumers.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 5: Run every regression file**

Run: `bun run --cwd tests test -- regression`
Expected: **PASS** — the fourteen new files, the two appended ones, and every earlier slice's file untouched.

- [ ] **Step 6: Write `scripts/reseed-verify.ts` and its package script**

Step 7 runs this; it does not exist yet. Four checks, one line of output each, exit 1 on any line that is not `ok`. It lives under `scripts/`, which **is** inside the lint runner's `ROOTS` (§3.7.5) — so every query goes through `withTenant` and no `db.`-tagged template appears (`no-bare-db` allow-lists `scripts/lint/**` only, not `scripts/`).

```ts
// scripts/reseed-verify.ts — the four-line staging check §4.7.2's closing paragraph requires.
// `--tenant <uuid>` runs against DATABASE_URL_MIGRATOR; `--local` starts a container and seeds one tenant,
// which is this slice's definition of done when the owner has not yet provided staging access (hazard 5).
import { createDb, systemContext, withTenant } from "@dulja/db";
import { loadDocumentTypes } from "@dulja/db/seed";
import { PERMISSIONS } from "@dulja/contracts";
import { seedItem, seedTenantV2, startDb } from "@dulja/db/test";
import type { Sql } from "postgres";

interface Check { name: string; detail: string; ok: boolean }

/** Every check is a READ. This script never repairs anything: a non-zero count means "drop and re-seed". */
async function checks(tx: Sql, companyId: string): Promise<Check[]> {
  const [provisional] = await tx<{ n: number }[]>`
    select count(*)::int as n
      from app.inventory_movement m
      left join app.cost_layer l on l.tenant_id = m.tenant_id and l.movement_id = m.id
     where m.company_id = ${companyId} and m.quantity > 0 and l.id is null`;

  const [drift] = await tx<{ n: number }[]>`
    select count(*)::int as n from app.cost_layer l
     where l.company_id = ${companyId} and l.invalidated_at is null
       and l.qty_remaining <> l.qty_in - coalesce((
             select sum(c.quantity) from app.cost_consumption c
              where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is null), 0)`;

  const [accounts] = await tx<{ inventory: boolean; cogs: boolean }[]>`
    select exists (select 1 from app.account where company_id = ${companyId} and code = '1300' and archived_at is null) as inventory,
           exists (select 1 from app.account where company_id = ${companyId} and code = '5000' and archived_at is null) as cogs`;

  const [type] = await tx<{ series: string; module: string }[]>`
    select t.series, t.module from app.document_type t
     where t.company_id = ${companyId} and t.code = 'COST_ADJUSTMENT' and t.archived_at is null`;

  return [
    { name: "provisional-movements", ok: provisional!.n === 0,
      detail: `${provisional!.n} rows with a cost_layer-less receipt` },
    { name: "cost-layer-invariant", ok: drift!.n === 0,
      detail: `${drift!.n} layers where qty_remaining <> qty_in - sum(valid consumptions)` },
    { name: "account-codes", ok: accounts!.inventory && accounts!.cogs,
      detail: `1300 ${accounts!.inventory ? "ok" : "MISSING"}, 5000 ${accounts!.cogs ? "ok" : "MISSING"}` },
    { name: "document-types", ok: type?.series === "CA" && type?.module === "accounting",
      detail: type ? `COST_ADJUSTMENT ok (series ${type.series}, module ${type.module})` : "COST_ADJUSTMENT MISSING" },
  ];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const local = argv.includes("--local");
  const tenantId = argv[argv.indexOf("--tenant") + 1];
  if (!local && (argv.indexOf("--tenant") < 0 || !tenantId)) {
    throw new Error("usage: reseed:verify --tenant <tenant uuid> | reseed:verify --local");
  }

  let failures = 0;
  const report = (rows: Check[]): void => {
    for (const r of rows) {
      // eslint-disable-next-line no-console -- this script's entire purpose is four lines of output
      console.log(`${`${r.name}:`.padEnd(23)}${r.ok ? "ok — " : "FAILED — "}${r.detail}`);
      if (!r.ok) failures += 1;
    }
  };

  if (local) {
    const db = await startDb();
    try {
      const s = await seedTenantV2(db, "ReseedVerify");
      const ctx = { tenantId: s.tenant, actorId: s.system, requestId: crypto.randomUUID() };
      // The two things a staging re-seed does, done here so the local run checks the same four facts rather
      // than four vacuous ones: 3A's `seedItem` seeds 1300/5000/5900 idempotently, and the document-types
      // sub-pack carries COST_ADJUSTMENT (Task 8). `seedTenantV2` alone seeds 1000/4000 (plan0A:1592-1594).
      await seedItem(db, s, { code: "RESEED-VERIFY" });
      await withTenant(db.migrator, ctx, (tx) =>
        loadDocumentTypes(tx, ctx, "packages/db/seed/my/document-types", PERMISSIONS.map((p) => p.code)));
      report(await withTenant(db.rw, ctx, (tx) => checks(tx, s.company)));
    } finally {
      await db.stop();
    }
  } else {
    const url = process.env.DATABASE_URL_MIGRATOR;
    if (!url) throw new Error("DATABASE_URL_MIGRATOR is not set (§3.11)");
    const sql = createDb(url);
    try {
      const ctx = await systemContext(sql, tenantId!, crypto.randomUUID());
      const companies = await withTenant(sql, ctx, (tx) =>
        tx<{ id: string; code: string }[]>`select id::text as id, code from app.company order by code`);
      for (const c of companies) {
        // eslint-disable-next-line no-console -- one header per company, then its four lines
        console.log(`company ${c.code}:`);
        report(await withTenant(sql, ctx, (tx) => checks(tx, c.id)));
      }
    } finally {
      await sql.end();
    }
  }

  if (failures > 0) process.exit(1);
}

await main();
```

`packages/db/package.json` gains one script — the only edit to that file in this slice:

```json
    "reseed:verify": "bun ../../scripts/reseed-verify.ts"
```

Run it now against a container, before touching staging:

Run: `bun run --cwd packages/db reseed:verify --local`
Expected: exactly these four lines, and exit 0:

```
provisional-movements: ok — 0 rows with a cost_layer-less receipt
cost-layer-invariant:  ok — 0 layers where qty_remaining <> qty_in - sum(valid consumptions)
account-codes:         ok — 1300 ok, 5000 ok
document-types:        ok — COST_ADJUSTMENT ok (series CA, module accounting)
```

The `--local` tenant has no movements, so the first two counts are zero *vacuously*; the last two are real, which is why the local branch seeds the chart and loads the pack rather than reporting `MISSING` and exiting 1. Step 7's staging run is the one where the first two counts can be non-zero.

- [ ] **Step 7: Re-seed staging (§4.7.2's closing requirement)**

§4.7.2 states it plainly: `inventory_movement` is immutable, so a value written by 3A's provisional body can never be corrected in place, and "rows posted between 3A and 3B are test data only … 3B's task list ends with a re-seed of staging". This is the task.

**Owner provides:** the staging `DATABASE_URL_MIGRATOR` and the tenant id (OD-19, OD-21).
**Verify:**

```bash
bun run --cwd packages/db migrate:up                       # applies 0034-0036
bun run seed --tenant "$DULJA_STAGING_TENANT" --only chart-of-accounts --only document-types
bun run --cwd packages/db reseed:verify --tenant "$DULJA_STAGING_TENANT"
```

`reseed:verify` prints four lines **per company** and every one must read `ok` (the script exits 1 otherwise):

```
company HQ:
provisional-movements: ok — 0 rows with a cost_layer-less receipt
cost-layer-invariant:  ok — 0 layers where qty_remaining <> qty_in - sum(valid consumptions)
account-codes:         ok — 1300 ok, 5000 ok
document-types:        ok — COST_ADJUSTMENT ok (series CA, module accounting)
```

**Until provided:** Step 6's `bun run --cwd packages/db reseed:verify --local` is the standing equivalent and prints the same four lines against a container. The slice never blocks on the owner (hazard 5); the local run is the definition of done and the staging run is a release-runbook step (§3.4.8).

If `provisional-movements` reports a non-zero count on staging, a receipt exists with no layer — a movement posted between 3A and 3B. **Do not back-fill it.** Drop the staging tenant and re-seed: that is what "test data only" means, and §4.7.2 says a plan proposing a back-fill has misread it.

- [ ] **Step 8: Commit**

```bash
git add tests/regression/legacy-004.test.ts tests/regression/legacy-005.test.ts tests/regression/legacy-006.test.ts \
        tests/regression/legacy-007.test.ts tests/regression/legacy-008.test.ts tests/regression/legacy-009.test.ts \
        tests/regression/legacy-010.test.ts tests/regression/legacy-015.test.ts tests/regression/legacy-016.test.ts \
        tests/regression/legacy-017.test.ts tests/regression/legacy-022.test.ts tests/regression/legacy-054.test.ts \
        tests/regression/legacy-060.test.ts tests/regression/legacy-061.test.ts tests/regression/legacy-062.test.ts \
        tests/regression/legacy-076.test.ts tests/regression/support/costing.ts \
        tests/invariants/support/post-inventory.ts packages/db/package.json scripts/reseed-verify.ts
git commit -m "$(cat <<'EOF'
test(regression): the fourteen 3B defect files and test 7's cost side [3B T13]

§3.7.3's rule applied: 3B is first in execution order for 004, 006, 007, 009,
010, 015, 016, 017, 022, 054, 060, 061, 062 and 076, so it creates those
files; 005 and 008 are 0B's and get an appended block.

legacy-009 carries acceptance test 7's cost side — an item bought twice, sold,
gone negative through a second principal's inventory.negative_stock.override,
and supplier-returned, whose valuation and whose profit-report cost are the
same number to the cent. 3D appends the transfer leg and 7B the revenue half.

The helpers live in tests/regression/support/costing.ts, this slice's own
module (amendment A21(a)) — §4.17.1 registers only
sharedDb/ThinContext/thinRegression in 0B's file, and adding a dozen costing
helpers to another slice's shared file is the merge hotspot §4.17 exists to
prevent. costingContext takes the file's LEGACY number and seeds that file its own
tenant: these files assert absolute figures, and sharing one company makes
several of them false in some file order.

Each file is a plain describe titled "LEGACY-NNN <heading> — 3B", not a
thinRegression call: 0B's wrapper invokes its body inside a single it(), which
a two-case costing file cannot use, and 2A set the precedent when it appended
to legacy-013.

legacy-017's assertion is the one worth reading twice: no statement in this slice
writes `qty_remaining = qty_remaining ± delta`. Every aggregate is a computed
total over append-only rows, which is what makes ADR 0038's restore pass
idempotent and LEGACY-006's -old+new impossible to express.

Staging is re-seeded rather than back-filled: inventory_movement is immutable,
so a provisional 3A value cannot be corrected in place, and §4.7.2 makes those
rows test data by construction.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

Reviewed against `writing-plans/SKILL.md`, the contracts §2 card for 3B, all of §3, every §4 subsection this slice touches, §5's thirty-five hazards, and §6.1/§6.2's rows. What follows is what the review found and what was done about it — the fixes are already in the text above.

**Fixed while reviewing.**

1. **Amendments A14–A23 were missing.** Tasks 6–13 needed ten names and behaviours the contracts document does not carry: the rule that a test-only code's *policy* is a `seedDocumentType` parameter (A14), `reverseDocument`'s `jobs?` (A15), the replay's branch grouping, closed-period carry-forward and `document_line.cost` rewrite (A16), the golden harness's per-case `policies.json` map and bigint handling (A17), the `inventory/valuation.ts` contracts module (A18), the **nine module exports §4.7.2 omits** — `openLayersFor` above all, which is the one open-layer definition 3C, 3D, 4B and 7B will each look for in the registry (A19), `COST_LAYER_CHECK`'s name and file (A20), the test tier's `costingContext`/`postOverriddenIssue` rows **and the third `dependency-rule` allowance** without which three DB-tier suites cannot import the shared helper and `lint:rules` fails from Task 7 onward (A21), the divisor being *refused* rather than *clamped* (A22), and `cost_consumption`'s three CHECKs and its composite `(tenant_id, company_id)` FK (A23). Each is now a table row landing before the task that needs it, and each is in `contract_additions`.
2. **The File Structure's regression row was a placeholder** — "`legacy-004.test.ts` … and the other thirteen created files" is exactly the kind of elision hazard 35 rejects. All fourteen are now enumerated with their defect and owning task, plus `legacy-055` from Task 4.
3. **Nine created and eleven modified files were absent from the File Structure** (`guards.test.ts`, `method.test.ts`, `cost-lines.test.ts`, `apply-movements.test.ts`, `cost-adjustment.ts` and its test, `cost-layer-check.ts`, the three `policies.json` files, `reseed-verify.ts`, `tests/regression/support/costing.ts`; and `reverse.ts`, `errors.ts`, `schema/company.ts`, `openapi.json`, `document.ts`, `ledger-balance.test.ts`, `support/regression.ts`, both `package.json`s, the two appended `legacy-` files). Added.
4. **`reverseDocument` would have fail-closed on an ordinary reversal.** The review caught this working through Task 7: `reverseDocument` posts the reversal document it creates, and a reversal dated before later movements of the same items satisfies Task 7's back-dating predicate exactly. Without the `jobs?` pass-through, every reversal of an inventory document after Phase 3 raises `ERR_INTERNAL`. That is amendment A15 and Task 7 Step 6.
5. **The engine would have refused a free-of-charge line *and* an authorised negative-stock excursion.** Task 2's `costIssue` raises `ERR_COST_VALUE_MISSING` when there is no layer to borrow a currency from and no value on the movement — which is the shape of both an FOC line at zero stock and an `inventory.negative_stock.override` issue against no layers, the very path `allowShortfall` exists for. Task 7 note 3 therefore substitutes `Money.zero(baseCurrency)` for **every issue's** value, keyed on `effect` and not on `costing`, and Task 12's golden driver uses the identical rule so the fixture cannot diverge from the hook. Task 3's guards file carries the override-at-zero-layers case as its own assertion.
6. **`openLayersFor` was nearly given a date filter.** Reading only layers at or before the posting key looks obviously right and is a defect: a back-dated issue would consume a layer a later posted issue has already emptied and die on `cost_layer_qty_remaining_check`. Task 7 note 2 states the post-now-replay-later rule and says why the filter is wrong.
7. **Every regression file was routed through 0B's `thinRegression`, which cannot carry them.** The wrapper invokes its body *inside one `it`* (0b:5317–5326), takes `cites` as a `string`, and hands the body a `ThinContext` — so seventeen files would have failed at run time with a nested-`test` error, at compile time on the array, and on every `ctx.*` call. Task 4's `legacy-055` plus Task 13's **fourteen new files and two appended blocks** — the one phrasing this plan now uses everywhere for that set — are all plain `describe` blocks titled as §3.7.3 requires, which is the shape 2A already used to append to 0B's files.
8. **Every regression file shared one company, and several of their assertions are absolute.** `legacy-006` expects a valuation of `undefined`, `legacy-016` a unit cost of exactly `1.0000` — both false once `legacy-004` has left stock on the shelf, in any file order, and `legacy-005` deliberately leaves invalidated layers behind. `costingContext(legacyDefect)` now seeds each file its own `seedTenantV2` tenant on the shared container, which also gives each one the `fx_rounding_account_id` that `sharedDb()`'s Plan 0A seed lacks.
9. **The override fixture would have been refused by 2B's own guard.** `app.assert_override_authorised` raises when the attributed principal is the document's creator, and `recordOverride` takes `actor_id` from `app.current_actor()` — so posting *as* the supervisor and attributing to them, which is the obvious shaping, cannot work, and neither can a second *actor* inside one transaction. The sequence is now written once, in Task 6's `postOverriddenIssue`, with the supervisor as the **attributed** principal and `s.human` as the poster; Task 11's exclusion case and Task 13's `legacy-009` both call it.
10. **`legacy-009`'s tie-out was one tautology and one false assertion.** `openShortfallValue` was `Σ document_line.cost − Σ cost_consumption.value`, so the first assertion held over any data at all — including broken data — and the second (`valuation + Σ cost = Σ receipts`) is arithmetically false by exactly the shortfall: 360 + 1320 ≠ 1560. The shortfall is now derived from quantities and the unit cost they were consumed at, which makes assertion (1) real, and assertion (2) subtracts it. Every figure in the fixture is worked out in a comment beside the assertions.
11. **`scripts/reseed-verify.ts` was listed, committed and described, and no step wrote it.** It is now Task 13 Step 6 in full — four checks, four lines of output, `--tenant` and `--local`, exit 1 on any failure — with the `reseed:verify` script entry beside it.
12. **Every `packages/db/test` file broke `dependency-rule`, and two of them could not have found their seed pack.** All eight suites imported `@dulja/db`, `@dulja/db/test`, `@dulja/db/seed` or `@dulja/contracts`; 0B pins `"packages/db": ["@dulja/domain"]` and matches the owner on the path prefix `packages/db/` with no `test/` exclusion (0b:5052, 0b:5091), so `bun run lint:rules` would have failed at **Task 1**, not Task 7, and every later "Expected: PASS" was false. They now import `../fixtures`, `../harness` and `../../src/**` as 1A and 3A do, and the permission catalogue is read from `app.permission` instead of imported — 1A documents that exact substitution (1a:5105) and reads it the same way (1a:5131–5132). Found with it: three bare pack paths (`"packages/db/seed/my/document-types"`) that resolve under `packages/db` because Vitest runs the package from there, now `fileURLToPath(new URL("../../seed/my…", import.meta.url))` as at 1a:5114. **And three places ran the replay with no `COST_ADJUSTMENT` row at all** — `costingContext.inventory()`, Task 11’s shortfall case and the worker suite (`startWorker()` applies migrations and pg-boss, never the seed packs, 0d:2350) — while `replay` resolves the adjustment accounts unconditionally the moment anything is in scope, so all three would have died on `ERR_NOT_FOUND` before any arithmetic. Each now loads the pack into its own tenant. The worker suite's two assertions also read `l.movementsReplayed` off a `CapturedLog`, whose shape is `{ level, fields, msg }` (0d:2340); they read `fields` now.

**Fixed after the independent audit** (a second reader took this plan against the contracts document, plan 0A and the spec; every item below is a change already made in the text above, not a note about one).

13. **Three build-breaking references, all in code this plan ships.** (a) `COST_LAYER_CHECK.run` (Task 12 Step 3) closed over a `companyId` its own doc comment had just argued cannot exist — `ProjectionCheck.run` is `(tx: Sql) => Promise<…>` and an extra required parameter makes `registerProjectionCheck(COST_LAYER_CHECK)` fail to compile, so the predicate was a `TS2304` against a `bun run typecheck` the same task claimed passes. The predicate is deleted and the comment now says in so many words that the statement carries no `company_id` clause and why RLS is the scope. (b) `apps/api/src/routes/inventory/valuation.ts` imported `requirePermission` from `@dulja/contracts`; §4.2.5 puts it in `apps/api/src/middleware/require-permission.ts` and the contracts module exports only `PERMISSIONS`, `PERMISSION`, `PermissionCode` and `isMutating`, so both `.openapi(...)` registrations would have failed to resolve. It is the relative middleware import 0B, 0D, 1A and 1B all use now. (c) The same two handlers read `c.var.db`, which is not one of the eight `Variables` members §4.2.3 pins — this slice's own amendment A5 adds the eighth (`jobs`) and states that a ninth must amend the block first. Both handlers use the request-scoped `c.var.withTenant((tx) => …)` now, and `withTenant` is gone from the file's `@dulja/db` import.
14. **Acceptance test 5's issue dates were computed with `String.prototype.replace`.** `day.replace("-05", "-06")` replaces the FIRST occurrence, so `2026-05-05` became `2026-06-05`: May would have received a receipt and no issue, June two issues in one period, and every count in the suite — `toHaveLength(10)`, `toHaveLength(9)`, the closed-period case's `carried` filter and its `2026-06` pair — would have been one short. The date is built as `` `${day.slice(0, 8)}06` `` now, with the trap named in a comment.
15. **The same suite's March and April figures ignored layers the fixture actually produces.** The comment computed March's post-recost average as `(100×10 + 100×30) ÷ 200`, counting the back-dated receipt and nothing else, while the monthly 2026-03-05 receipt *and* the January/February proportional residue were also open at the 2026-03-06 issue; the April figure repeated the omission. Rather than restate a twelve-term proportional chain, the **fixture is simplified so the stated arithmetic is true**: each month now issues 100 against its own receipt of 100, so in the forward build — before any back-dating — every month closes at zero on hand, `openLayersFor` (which filters `qty_remaining > 0`) returns exactly the two March layers, the average really is 20.0000 and March's delta is 1000.0000. April's double-count figure is re-derived the same way — run 1 moves April from 1000.0000 to 1500.0000, and the 10 @ 50.0000 back-dated receipt makes it `3500.0000 ÷ 210.000000 = 16.6667`, so the second run's delta is **166.6700**, not 666.6700. Both derivations are written out beside their assertions.
16. **That suite's last case could not have produced the incident it asserts.** It hand-invalidated every consumption and replayed with nothing new posted — but the engine is pure and the layer set was unchanged, so the forward pass recomputes byte-identical values, the delta query's `having sum(after_value − before_value) <> 0` drops every group, and the run never reaches the `target` lookup that records an incident. It back-dates a real 2026-07-02 receipt while July is still open now, then closes June onward, then replays: six (period, branch) groups find no open period, `adjustmentsPosted` is exactly `[]` and six incidents are written. The summary's operator instruction is asserted too, off `app.audit_log.after` — 1B's column is `after`, not `new_data` (1b:1610–1614). **This case was not in the audit; it was found while re-deriving the fixture for item 15.**
17. **Task 11's `stock_valuation` mismatch case broke a column the derivation never reads.** It moved `cost_layer.qty_remaining`, but `valuationAsOf` derives a layer's residue as `qty_in − Σ(valid consumptions on or before asOf)` and never selects `qty_remaining` — so both sides of the drift comparison still said 50.000000, the `where coalesce(l.qty,0) <> coalesce(m.qty,0)` filter dropped the pair, and the only effect was to set `live.gap = 5`, silently classifying the pair as an open shortfall. It moves `qty_in` now, asserts `side` and an empty `excluded` beside the detail string, repairs the same column and re-runs the rebuild so ADR 0039's invariant and Task 12's `COST_LAYER_CHECK` start from a clean company.
18. **Two `Money.zero(MYR)` reduce seeds would not have type-checked.** `currency()` has a `const` type parameter, so a bare seed is `Money<CurrencyCode & "MYR">` while `Consumption.value` is the wide `Money<CurrencyCode>`, and `a.add(c.value)` is then a compile error — the trap 1A hit and documented at 1a:1572–1577. Both sites are `Money.zero<CurrencyCode>(MYR)` now, with `type CurrencyCode` added to that file's import list. (The other `Money.zero(MYR)` in this plan, in Task 13's movement literal, is a narrow-to-wide *assignment* and is correct as written.)
19. **A `@dulja/db` self-import survived item 12's sweep by hiding inside a dynamic `import()`.** `packages/db/test/posting/cost-lines.test.ts` reached `loadSnapshot` through `await import("@dulja/db")` in a callback — which escapes 0B's `dependency-rule` IMPORT regex rather than satisfying it, and contradicts this plan's own Global Constraints, Task 1 Step 7 and item 12 above. `loadSnapshot` comes from `../../src/posting` at the top of the file beside `postDocument` now, exactly as 1A's loader suite spells it (1a:2079).
20. **Three smaller corrections.** (a) `cost_consumption` carried no composite FK to `app.company` while `cost_layer` and `stock_valuation` both did, and Plan 0A's `composite_fk` rule only inspects FKs that exist, so nothing would have caught it. Amendment A23 records the key now, migration 0034 carries it, and Task 1's suite asserts all three by name. (b) Task 3 Step 3 told the reader the same-key ordering case fails "because `openLayers` is used in caller order" — at that point Task 2's `else` branch still throws the scaffolding `Error`, so all four FIFO cases fail with that one message; the step says so, and says when the ordering failure would actually appear. (c) The regression-file count was stated three ways ("fifteen files Task 13 writes", "fourteen created", "sixteen files would have failed"); it is **fourteen new files and two appended blocks** in all of them, and Task 1 Step 2's expected failure lists all four failing cases rather than two.

**Checked and confirmed.**

- **Every task heading is exactly `### Task N: <title>`**, thirteen of them, numbered 1–13 with no gaps. The three ADRs inside Tasks 3, 9 and 11 use `#`/`##` inside fenced markdown blocks and do not collide.
- **TDD in every task**: a failing test first, the command that runs it, the *exact* expected failure (Task 6's two informative failures, Task 11's deliberately-red registry assertion, Task 12's three-name array), the minimal implementation, the command that proves it, and a commit ending in the required trailer.
- **No placeholders.** No "TBD", "TODO", "implement later", "similar to Task N", "etc.", "and so on", and no ellipsis standing in for content. Task 12's three golden documents are written out **in full** — the earlier draft described `d2` and `d3` in prose, which is exactly the elision the skill forbids and matters doubly here because `expected.json` is generated from that file. The only remaining `…` are three kinds, all of them pointing at text a task does not change: `// … steps 1–8 unchanged …` inside a code block that replaces one region of an existing function, `z.ZodObject<…>` in a Produces block whose full shape is written out in the task's own step, and prose abbreviations of a mounted route path (`GET …/valuation/layers`) whose literal is in the `RouteModule`.
- **Hazard 1**: no statutory rate, threshold or formula anywhere. Every number in this plan is a quantity, a unit cost or a rounding scale.
- **Hazard 2**: no MyInvois detail. Nothing in costing touches it.
- **Hazard 5**: the one owner-account task (Task 13 Step 7) is "owner provides X; verify with `<exact command>`" with a local equivalent (Step 6) that prints the same four lines.
- **Hazard 6**: OD-06 is one isolated task (Task 4) stating the default (`'avco'`) and exactly what changes otherwise.
- **Hazard 7**: D1–D27 untouched; nothing in §2.12 re-decided.
- **Hazard 8/9**: Plan 0A's helpers cited by exact name and never renamed; `fixtures.ts` gains **nothing** (§4.17 assigns 3B no helper), and the test-tier helper goes in §4.17.1's register under A11's first-lands-commits rule.
- **Hazard 10**: only `app.permission` is written by a migration (0036). Document types and policies are seed-pack data.
- **Hazard 11**: no enum label added — `costing_method` is `text` + a named CHECK.
- **Hazard 13**: `lint-schema.ts` is edited to exactly §3.5.3's pre-declared state and nothing else.
- **Hazard 14**: 0034–0036 and ADR 0037–0039, the ranges the card allocates; no `max(version)` assertion anywhere. The shortfall-netting proposal is recorded *inside* ADR 0038 note 7 for exactly this reason: taking 0040 would be taking 3C's number.
- **§4.17.1's importer list**: this slice makes it three (`apps/worker/test/**`, `apps/api/test/**`, `packages/db/test/**`) through one named allowance and one tsconfig `include` — Task 7 Step 9, amendment A21(c). No `package.json` dependency is added in that direction, so the workspace graph turbo walks gains no cycle.
- **Hazard 15**: root `tests/` uses the production `withTenant(sql, ctx, fn)`; `packages/db/test` uses the four-argument one. Task 6's helper takes the production form.
- **Hazard 17**: test 7's "gone negative" (Task 13, `legacy-009`) and Task 11's exclusion case are both produced only through `recordOverride` with a second **attributed** principal, in the one shape `app.assert_override_authorised` admits. No flag is toggled and no movement is written directly.
- **Hazard 20**: both job handlers run under `systemContext` and fan out through `eachTenant`.
- **Hazard 21**: no `sql.unsafe` in this slice.
- **Hazard 22**: every ledger, movement, layer and projection write is inside `packages/db/src/costing/**` or `packages/db/src/posting/**`. `stock_valuation` is not on `posting-only-tables`' list by §3.7.5's own text, and its `merge` sits in `costing/valuation.ts` regardless.
- **Hazard 23**: `HALF_AWAY_FROM_ZERO` at scale 4 for every money operation, including the unit-cost division.
- **Hazard 24**: no handler inserts `document_event`; the override is read, never written, by `applyMovements`.
- **Hazard 25**: the DELETE grant list is untouched. A superseded consumption is marked `invalidated_at`; a zeroed `stock_valuation` row is zeroed, not deleted.
- **Hazard 26**: one permission code, `inventory.cost.read`, which §3.6.2 already allocates to 3B.
- **Hazard 29**: 3B has **no screen**, so OD-24 does not apply — the Assumptions block says so.
- **Hazard 31**: one `PROBES` entry keyed by the exact `RouteModule.path`, two `JOB_PROBES` entries, `TENANT_FREE` untouched.
- **Hazard 32/33**: one document-type code (`COST_ADJUSTMENT`), two consumed account codes (`1300`, `5000`) with Task 8's resolution assertion, no report code, no `DatasetId` member, no `fixtures.ts` helper.
- **Hazard 34**: `COST_ADJUSTMENT.json` is an envelope with `module` outside `policy`.
- **§4.4.2's ⚠️ naming 3B first**: every direction in this slice is read from `effect` or `side`, never from a sign. Task 9's adjustment reads `rose`, a boolean over the delta, and moves the sign into *which account is debited*.
- **§6.1**: tests 5 (Task 9) and 6 (Task 3) owned; 1 (Task 6), 2 (Tasks 11, 12), 7-partial (Task 13), 12/13/36 for the three new tables. **§6.2**: row spec:1055 owned in full — cost layers, AVCO ⚠️, recost forward, one implementation, free-of-charge lines.

**Two notes for the reviewer, deliberately left as they are.**

- The `…/valuation` path prefixes in prose (`GET …/valuation/layers`) follow the contracts document's own abbreviation style for a mounted module path; the full literal is in the `RouteModule` and in every `api.app.request` call, so no reader has to reconstruct one.
- Task 11's registry case is **expected to fail** until Task 12 registers `COST_LAYER_CHECK`, and the plan says so rather than reordering the tasks or marking it `it.skip`. That is what makes Task 12's registration non-optional.
- The engine's `unitCostOf` refusal below `MIN_MEANINGFUL_QTY` is **unreachable from a constructed `Quantity`** (0D's `Quantity.of` rejects more than six decimal places), and it stays in the code anyway, with the Assumptions block and Task 3 guards case (b) saying so. It is the guard that catches a future `QUANTITY_SCALE` change, and deleting it would leave spec:1227 enforced only by a regex in another package.

**Four questions for the architect; the second is the one that matters, and the fourth needs the same answer-before-3C timing.** All four are in `spec_questions`.

1. §4.7.2 freezes `invalidateFrom`'s input as `{ companyId; itemIds; effectiveDate; postingSeq }` — item-scoped, with no warehouse. A back-dated document affecting one warehouse of an item therefore invalidates that item's layers in *every* warehouse, and the replay recomputes more than it must. It is correct and it is bounded; a `warehouseIds` member would make it tighter. Amendment A6 already touches the signature, so adding one now is cheap and later is not.
2. **Should an authorised negative-stock shortfall be netted into the next receipt's layer?** ADR 0038 note 7 records the v1 answer as *no* — the shortfall is valued, unconsumed, and the nightly quantity compare excludes that `(item, warehouse)` pair until a **back-dated** receipt makes the replay recompute the issue (a later receipt does not close it; nothing re-consumes a historical shortfall). Netting (`qty_remaining = qty_in − open shortfall`, with `(new unit cost − the shortfall's provisional cost) × shortfall` booked into the adjustment) would make both compares unconditional and is almost certainly the right long-term rule, but it adds `shortfall: { quantity; value } | null` to `CostingOutput` (§4.7.1), so it changes a frozen interface and hazard 7 makes it a proposal rather than a task. It is written as a **proposal block inside ADR 0038 note 7** rather than as its own ADR because §3.9 gives 3B exactly 0037–0039 and all three are spent. **This is the one design hole this slice ships with and it sits exactly on test 7 ∩ test 2 — so the carve-out is now bounded by a test** (Task 11 Step 1 asserts the pair is `excluded` and not `mismatches`, and that it returns to the compared set once the replay closes the gap) **rather than by prose. The architect should answer before 3C, which extends a receipt's value and would otherwise inherit the hole.**
3. `PostResult.enqueuedJobIds` carries `"inventory.cost.replay:<companyId>"` rather than a pg-boss job id, because `singletonKey` collapses a burst and the key is the stable identity. If a caller is ever expected to poll `/v1/jobs/{jobId}` (§4.2.7) with that value, the shape needs settling — 9B's `admin.import.run` is the first slice that will care.
4. **Should `app.cost_layer` carry a `value` column?** §4.7.3 gives it `qty_in` and `unit_cost` and no `value`, so a layer's worth is only ever `round(qty_remaining × unit_cost, 4)` while the ledger's inventory debit is the movement's exact value, and the two part company by a sub-cent residue on any receipt whose value does not divide by its quantity (3 units for `10.0000` → a `9.9999` layer against a `10.0000` debit). Every fixture in this slice divides evenly, so nothing here can show it; it becomes reachable at **3C's landed cost and 3D's `TRANSFER_RECEIPT`**, which is why it wants the same answer-before-3C as question 2. The Execution handoff's fourth blocker states the symptom, the three non-fixes and the proposal shape (`value numeric(19,4) not null` on the layer, `unit_cost` demoted to the derived read), and says the proposal belongs inside **ADR 0039** because §3.9 gives this slice only 0037–0039 and all three are spent. 3D raised it against this slice rather than absorbing it; **it is not amended into §4.7.3 by this plan** — hazard 7 makes it a proposal, not a task.

---

## Execution handoff

**Before Task 1.** 3A must be merged with its tests green on the head, and the Phase 2 definition of done (spec:2288) green in CI. Two specific things to confirm rather than assume, because every later task depends on them and both are cheap to check:

```bash
grep -n '"account_balance"\|"stock_on_hand"' packages/db/src/lint-schema.ts   # 1A's and 3A's NO_ID_TABLES members
grep -rn "export async function applyMovements" packages/db/src/costing/      # 3A's provisional hook, signature frozen
```

If either is absent, stop: the phase gate is not met and Task 1 Step 5 says so explicitly.

**Order.** Strictly 1 → 13. The dependencies are real, not stylistic:

- **1** creates the tables everything writes to. **2 → 3** build the engine; 3 needs 2's `costIssue` to exist before it can replace its FIFO branch.
- **4** is OD-06 and is **droppable without renumbering** — if the owner rejects AVCO, only Task 4's default and `legacy-055` move. Nothing else in the plan reads `costing_method` except through `snapshot.company.costingMethod`.
- **5** must land before **6**, or Task 6's block fails with `ERR_MONEY_CURRENCY_MISMATCH` from `toBase`.
- **6** must land before **7**, **9**, **10**, **11** and **13** — every one of them posts through `postInventoryDocument`.
- **7** is the hinge: it deletes 2A's step-9b guard, so Task 6's red block goes green here and 2A's guard test is deleted in this commit. **8** must land before **9** (the replay resolves what 8 seeds).
- **11** leaves one case red until **12** registers `COST_LAYER_CHECK`. Do not reorder to hide it.
- **13** ends with the staging re-seed, which is the slice's last act; its Step 6 writes the script Step 7 runs.

**Inside `packages/db`, import by relative path.** `dependency-rule` pins that package to `["@dulja/domain"]`
and keys the owner on the path prefix, so `test/**` is in scope too: `../fixtures`, `../harness`,
`../../src/**`, and `@dulja/domain` when a domain name is needed — never `@dulja/db`, `@dulja/db/test`,
`@dulja/db/seed` or `@dulja/contracts`, and never `PERMISSIONS` (read `select code from app.permission`
instead, as 1A does at 1a:5131–5132). The same names ARE legal in `tests/**`, `apps/**` and `scripts/**`, so
an import block moved between tiers is the one edit that will surprise you. `bun run lint:rules` catches it
at Task 1 Step 7 — but **only for a static import**. 0B's rule matches
`/^\s*(?:import|export)[^"']*from\s*["']([^"']+)["']/`, so a `const { x } = await import("@dulja/db")` slips
straight past it. The rule is the constraint, not the linter: reach for `../../src/**`, never for a dynamic
import of the package you are inside (Self-Review item 19).

**Read the four re-derived figures before you touch acceptance test 5 (Task 9).** Its fixture buys 100 @ 10
on the 5th and issues **100** on the 6th of every month — not 50 — precisely so that in the forward build,
before any back-dating, each month closes at zero on hand and March's average is the two-layer
`(100×30 + 100×10) ÷ 200 = 20.0000` a reader can check by hand.
Change the 100 back to a partial issue and four figures move at once: March's legs (1000.0000 each side),
run 2's April delta (166.6700), and the two counts that depend on every month's COGS moving. The issue date
is built with `slice`, never `replace` (Self-Review item 14).

**One cross-slice edit, and it lands in Task 7 Step 9 rather than at the end.** `scripts/lint/rules/dependency-rule.ts` gains a third named allowance (`packages/db/test/**` → `tests/invariants/support/**`) and `packages/db/tsconfig.json` an `include` entry. Three of this slice's DB-tier suites import the shared helper, so from Task 7 onward every "Expected: PASS" on `bun run lint:rules` depends on it. If a later task's lint step reports a `dependency-rule` violation naming one of those test files, that step was skipped — do not "fix" it by copying the helper into `packages/db`.

**Six commands to run at the end of every task**, in this order, before the commit:

```bash
bun run --cwd packages/db test -- test/costing        # this slice's DB tier
bun run --cwd packages/domain test -- test/costing    # the pure engine
bun run --cwd tests test                              # invariants, regression, golden
bun run typecheck
bun run lint
bun run lint:rules                                    # no-number-money, posting-only-tables, permission-catalogue, role-seed, error-codes
```

**The three commits that will be the largest, and what to watch in each.** Task 7 touches twelve files, deletes a guard another slice wrote — read 2A's step-9b block and its test together before deleting either, and delete both — and carries the one edit outside this slice's own directories: Step 9's `dependency-rule` allowance, without which every later task's `bun run lint:rules` claim is false. Task 9 is one long function; write it in the order of its numbered comment banners and run the test after each banner rather than at the end. Task 13 touches eighteen files — **fourteen new regression files and two appended blocks**, plus `tests/regression/support/costing.ts` and `scripts/reseed-verify.ts` (the one-line `package.json` edit and the verify-only `post-inventory.ts` are not counted) — and its Step 1, `tests/regression/support/costing.ts`, is the shared surface every other file in the task imports; write it first, then `legacy-004` alone against it, and only then the remaining thirteen new files and the two appended blocks. Its Step 6 (`scripts/reseed-verify.ts`) is independent of all of them and can be written first if you prefer a shorter first commit.

**If something is genuinely blocked**, the pattern is contracts §5 item 7: write an ADR **proposal** naming the conflict and stop. Do not implement a deviation. The four most likely blockers and their answers: `openLayersFor` returning a layer whose `line_no` is null means 3A's `inventory_movement` insert omitted it (fix 3A, not this plan); `projectionChecks()` returning an unsorted array means 1B's registry does not sort and amendment A10's alphabetical claim is wrong (fix the assertion, not the registry — hazard 7); a `document_line` BEFORE UPDATE guard appearing from a later slice would refuse Task 9's `cost` rewrite, which is 3A assumption 5 and the place to look; and the fourth is the one this slice owns and cannot make fire, so it is written out in full.

**The fourth blocker: a sub-cent gap between `valuationAsOf` and the `1300` (or 3D's `1310`) control balance. Stop and raise it; do not round it away.** `app.cost_layer` stores `qty_in numeric(19,6)` and `unit_cost numeric(19,4)` and **no `value` column** (§4.7.3, contracts:3076–3079), so a layer's value is only ever `round(qty_remaining × unit_cost, 4)` while the ledger's inventory debit is the movement's own exact `value`. Whenever a receipt's value does not divide by its quantity at four decimals the two disagree by a residue: 3 units for `10.0000` gives `unit_cost = round(10 ÷ 3, 4) = 3.3333` and a layer worth `9.9999` against a `10.0000` debit. **This is every document type, not only a transfer** — 3D says the same thing in its own handoff and points here, and its Task 4 equal-quantity branch in `priceTransferReceipt` closes only the 3D-owned part (two legs of one line disagreeing with each other), not this.

*It cannot fire inside this slice*, which is why no task tests it: every fixture here builds a receipt's value as an integer quantity times a 4-decimal `unitPrice`, so `round(value ÷ quantity, 4)` returns that price and `qty_in × unit_cost` is the movement value exactly. It first becomes reachable when a receipt's value stops being that product — **3C's landed cost, which extends a receipt's value after the fact, and 3D's `TRANSFER_RECEIPT`, whose value is the sum of the consumptions the issue leg made.**

Three things that are **not** the fix, each of which hides the discrepancy somewhere worse. Do not round inside `valuationAsOf` — the compare would pass and `stock_valuation`, 3D's `inventory.valuation` report and 4B's `item_profitability` would then carry a figure no layer supports. Do not have the engine push the residue onto the last open layer — that makes a layer's `unit_cost` depend on the order in which it is read, which is LEGACY-009's shape. And do not add a `value` column to `cost_layer` in migration 0034: §4.7.3's block is frozen and a plan implements it verbatim (contracts:1261), so widening it is an amendment nobody has agreed and hazard 7 makes it a **proposal, not a task**.

The proposal to write, if you are the one who meets it: `app.cost_layer` gains `value numeric(19,4) not null`, carrying the movement's exact value, with `unit_cost` kept as the derived read and every layer value read from `value × (qty_remaining ÷ qty_in)` rather than from `unit_cost`. It belongs as a **proposal block inside ADR 0039** — that ADR is already about `cost_layer` being the checked projection, and §3.9 gives this slice exactly 0037–0039 with all three spent, which is the same reason architect question 2 lives inside ADR 0038 note 7 rather than in an ADR of its own.

**What this slice does not do, so the next reader does not go looking.** No screen (OD-24 does not apply). No report code — `inventory.valuation`, `inventory.stock_on_hand` and `inventory.sales_by_item` are **3D's** minimal set, and 3D's report reads `valuationAsOf` rather than re-deriving anything. No landed cost (3C, which extends a receipt's value and re-runs test 5). No transfer (3D, which completes test 7). No `item_profitability` (4B — it needs revenue, and no document type produces any before 4A). `CLAUDE.md` is not touched: 3D completes Phase 3 and rewrites the "Current phase" section (§3.8).

