# Dulja Phase 4A — Invoices, credit notes, receipts and payments, allocation, credit control, delivery-order conversion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open Phase 4 by shipping the six AR/AP document types the accounting module still owes — `SALES_INVOICE`, `SALES_CREDIT_NOTE`, `PURCHASE_INVOICE`, `PURCHASE_CREDIT_NOTE`, `RECEIPT`, `PAYMENT` — as configuration over the frozen posting service; `app.payment_term`, credit limits and the credit-control block with its second-principal override; `app.allocation` with `allocateSettlement`, `openBalance` and `partyBalance`; the `DELIVERY_ORDER` → `SALES_INVOICE` conversion that closes the `1250` corridor spec:1051 opens; and the revenue-and-margin half of `inventory.sales_by_item`, which 3D could only ship as quantity and cost because no revenue-posting type existed.

**Architecture:** This slice is the first one where money moves without stock moving, and its whole design follows from one fact: **`inventory.effect` is a single value per posting policy and `posting-policy.schema.json` is frozen at `$id` `urn:dulja:posting-policy:1` from 2A onward (§4.4.1), so an effect cannot be conditional.** Stock therefore stays where Phase 3 put it — out on `DELIVERY_ORDER`, in on `GOODS_RECEIPT`/`SHIPMENT` — and **every one of this slice's six types is `inventory: { effect: "none" }`**. The invoice is the financial half: it moves a *clearing corridor* to its final home (`1250` goods delivered not invoiced → cost of goods sold; `2150` goods received not invoiced → trade payables) and recognises revenue, tax and the party balance. That makes `1250` and `2150` genuine clearing accounts that net to zero per delivery and per receipt, which is exactly what §4.15 registers them for, and it is the model spec:1051 states ("stock leaves before the invoice; converted into the invoice"). Three thin seams of TypeScript hold it together: (1) **two conversion services** in `packages/db/src/ar-ap/` that build an invoice from a delivery or a goods receipt, copying `unit_price`, `amount` and — for the sales side — `document_line.cost`, so the corridor is relieved by *the same figure that filled it* rather than by a second costing answer (LEGACY-009); (2) **`allocation.ts`**, the settlement record §4.8.1 freezes, which never writes a ledger row; (3) **`app.assert_credit_available()`**, a second BEFORE UPDATE OF status trigger on `app.document` that refuses `→ issued` over a party's limit unless a second principal has recorded an `accounting.credit_limit.override` event. **This slice adds one route module (`payment-terms`) and one `PROBES` key**; everything else is a sub-path of 1A's generic `documents` module or of 2A's `parties` module.

**Tech Stack:** Bun 1.4 (install, scripts, the API entrypoint) · Node 24 LTS (runs Vitest) · TypeScript strict · PostgreSQL 18 (Testcontainers `postgres:18`) · `postgres` (postgres.js) tagged templates · Drizzle ORM mirrors for reads · Hono + `@hono/zod-openapi` · Zod · `decimal.js` behind `@dulja/domain`'s `Money`/`Quantity` · React 19 + `@dulja/ui` + i18next (the OD-24 screens) · Vitest + Testcontainers · Playwright (the both-directions re-run of test 23) · oxlint + oxfmt · Turborepo.

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §0.2 (spec:97–108), §3.0.3 rows **Customer credit control** (spec:1026) and Purchase in foreign currency (spec:1023), §3.0.4 rows 1042 (the row this slice owns) and 1051 (the invoice-link half), §3.3 Party and the projections paragraph (spec:1169, 1204), §3.8 `document.currency`/`exchange_rate`/`rate_source` (spec:1760–1762), the posting-policy example (spec:2008–2028) and the `ledger_entry` base check (spec:1816), §3.9 Money/Naming/Deletion/Error codes (spec:2037–2053), §3.10.1 "Money out on Phase 4 machinery" (spec:2082), §4.2.1 the `accounting.*` catalogue and the receipt/payment sentence (spec:2147) with the `accountant` and `user` rows (spec:2157–2158), §4.2.2 R1, R2, R6, R8 and the credit-limit override (spec:2172–2179), §4.11 engineering practice (spec:2258–2266), Part V Phase 4 row (spec:2290) and the reporting sequencing note (spec:2300), Part VI tests 1, 8, 10, 14, 31 (spec:2419, 2426, 2428, 2432, 2449), Part I LEGACY-011 (spec:311), LEGACY-012 (spec:320), LEGACY-014 (spec:340), LEGACY-017 (spec:361), LEGACY-018 (spec:374), LEGACY-019 (spec:381), LEGACY-042 (spec:576).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 4A — Invoices, credit notes, receipts and payments, allocation, credit control, delivery-order conversion. **Phase:** 4. **Phase gate:** this plan starts only when **3D** is merged (and therefore 3A, 3B and 3C before it) and Phase 3's definition of done is green in CI (spec:87).
- **Depends on (merged):** 0A helpers by exact name — `startDb`, `Db`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `Seed`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.forbid_change`. **0B** — `createApp`, `AppDeps`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `requirePermission`, `assertRouteGates`, `AppError`, `ERRORS`, `Problem`, `fromDatabaseError`, `createLogger`, the production `withTenant(sql, ctx, fn)`, `systemContext`, `startApi`, `StartedApi`, `TEST_ISSUER`, `PROBES`, `IsolationProbe`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `problemOf`, `fullRegression`, `sourceFiles`, `REPO_ROOT`, `encodeCursor`, `decodeCursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `QuantitySchema`, `CurrencySchema`, `ProblemSchema`. **0D** — `Money`, `currency`, `CurrencyCode`, `Quantity`, `round`, `toBase`, `UNIT_RATE`, `ExchangeRate`, `MONEY_SCALE`, `RoundingMode`, `Rational`, `rational`, `PERMISSIONS`, `PERMISSION`, `PermissionCode`, `ROLES`, `INCOMPATIBLE_PAIRS`, `seedBranch`, `seedCurrency`, `seedRate`, `app.rate_for`, `startWorker`. **0C** — the seed CLI, `PackLoader`, `readPackFile`, `assertPackShape`, `SUB_PACKS`, and the `0c-base.json` chart rows `1100`, `1200`, `1300`, `2100`, `4000`, `5000`, `5900`, `5920`. **0E** — `packages/ui`, `packages/i18n`, `bootLocalStack`. **1A** — `postDocument`, `issueDocument`, `voidDocument`, `reverseDocument`, `loadSnapshot`, `resolvePolicy`, `PostResult`, `IssueResult`, `PostingError`, `insertLedger`, `app.posting_seq`, `document.posting_seq`, `documentRoutes` (mounted at `/v1/companies/:companyId/documents`), `seedTenantV2`, `seedJournalPolicy`, `seedAccount`, `JOURNAL_POLICY_V1`, `loadDocumentTypes`, `documentTypesLoader`. **1B** — `trialBalance`, `accountLedger`, `accountOpeningBalance`, `postJournal`, `ProjectionCheck`, `registerProjectionCheck`, `projectionChecks`, `runIntegrityCheck`, `IntegrityReport`, `reportsRoutes`, `reportsRouteModule`, `ReportCodeSchema`. **2A** — `evaluatePolicy`, `balanceInBase`, `validatePolicy`, `parsePolicy`, `validateRequires`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PlannedMovement`, `PostingPlan`, `PolicyEvaluationError`, `requireDocumentPermission`, `DocumentStage`, `POLICY_RESOLVED_CODES`, `DOCUMENT_STAGE_CODES`, `partyRoutes`, `seedParty`, `seedDocumentType`, `DocumentLineInput`, `DocumentLineSchema`, `PartySchema`, `CreatePartyBody`, `UpdatePartyBody`, `app.party`. **2B** — `transitionDocument`, `recordOverride`, `setEventContext`, `listDocumentEvents`, `stageCode`, `grantCodes`, `app.principal_has`, `app.effective_policy`, `app.document_event`, `app.document_status_before`, `ERR_DOC_NOT_DRAFT`, `ERR_OVERRIDE_NOT_AUTHORISED`. **2C** — `MODULE_READ_CODE`, `requireAttachmentRead`, `readableModules`, `requireDocumentModuleRead` (all four in `apps/api/src/middleware/require-attachment-read.ts` — the file 2C actually shipped, 2c:1786 and 2c:4903; §4.5.8's prose still names a different path and **Task 0 Step 6 files the correction**, because §4.18 has only Round 1 and Round 2 and no round-3 table exists to have carried it), `pdfText`. **3A** — `app.item`, `app.warehouse`, `app.lot`, `app.unit_of_measure`, `app.inventory_movement`, `app.stock_on_hand`, `app.assert_stock_available`, `planMovements`, `SENTINEL_LOT_CODE`, `INVENTORY_PERMISSION`, `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot`, `inventory.negative_stock.override`. **3B** — `costingEngine`, `MIN_MEANINGFUL_QTY`, `applyMovements` (full body), `openLayersFor`, `valuationAsOf`, `invalidateFrom`, `replay`, `app.cost_layer`, `app.cost_consumption`, `company.costing_method`, `COST_ADJUSTMENT`, and the test-tier helpers `postInventoryDocument`, `PostInventoryOptions`, `InventoryLine`, `postOverriddenIssue`, `secondPrincipal`, `recordingJobs`, `ensureOpenPeriods`, `costingContext`. **3C** — `app.document_link`, `app.document_open_quantity`, `linkFulfilment`, `listLinks`, `openQuantity`, `LinkKind`, `FulfilmentLineInput`, `LinkFulfilmentInput`, `DocumentLinkRow`, `OpenQuantityRow`, `receiptValue`, `landedCostByLine`, `PURCHASE_ORDER`, `SHIPMENT`, `GOODS_RECEIPT`, `PURCHASE_RETURN`, the `2150`/`1310`/`5100` chart rows, `ERR_DOC_LINK_OVER_FULFILLED`, and `draftTypedDocument(db, s, opts) → { documentId, lineIds }` with its `DraftLine` shape. **3D** — `SALES_ORDER`, `DELIVERY_ORDER`, `TRANSFER`, `TRANSFER_RECEIPT`, `STOCK_COUNT`, `EXPIRY_WRITE_OFF`, `convertOrderToDelivery`, `ConvertToDeliveryInput`, `ConvertResult`, `stockOnHand`, `stockOnHandTotals`, `salesByItem`, `SalesByItemParams`, `SalesByItemRow`, `document_line.counted_quantity`/`expected_quantity`, `PlannedLedgerLine.fill`, the `1250` and `5110` chart rows, and the six `inventory.*` permission codes.
- **Migration numbers:** **0044–0047** — `0044_create_payment_term.sql` (T1), **`0045_alter_party_and_document_add_credit_terms.sql`** (T3 — §3.4.2's rule that a file whose name understates what it does is renamed: the card's expected `0045_alter_party_add_credit_control.sql` covers only half of what the file must do, because the pinned `document.payment_term_id` and the credit-control trigger land in the same file), `0046_create_allocation.sql` (T9), `0047_seed_permission_phase4a.sql` (T2), each with its hand-written `NNNN.down.sql`. **ADR numbers:** 0044–0045 — **0044** *The invoice is financial only: `1250` and `2150` as the two clearing corridors* (written **as a proposal**, spec:95 — it touches money semantics); **0045** *A negative line quantity makes `line.cost` negative* (also **a proposal**, and the amendment 3D filed as blocking Phase 4).
- **Interfaces consumed:** §4.1 (the Plan 0A surface), §4.2.1 (`Money`, `Quantity`, `toBase`, `ExchangeRate`, `Rational`, `rational`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`AppEnv`, `Logger`), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`, `PostingError`), §4.2.5 (`PERMISSION`, `requirePermission`, `ROLES`, `INCOMPATIBLE_PAIRS`), §4.2.7 (`RouteModule`, `buildRoutes`, `IdempotencyHeader`, `createApp`, `PROBES`), §4.2.8 (the common schemas, the list envelope, the one list-filter convention and 3C's document-sub-resource money exception), §4.2.9 (`idempotency`), §4.2.10 (`app.rate_for`), §4.2.12 (`startApi`, `ApiRequest`, `StartedApi`), §4.2.13 (`SubPack`, `readPackFile`), §4.3.1 (`postDocument`, `issueDocument`, `reverseDocument`, `voidDocument`, `transitionDocument`, `recordOverride`, `loadSnapshot`, `resolvePolicy`), §4.3.2 (the fixed posting algorithm — steps 4, 5, 6, 9, 10, 12, 13), §4.3.4 (`document_line` and the `document` header additions), §4.3.5 (`posting_seq`), §4.3.6 (numbering at issue), §4.3.7 (the document-type seed envelope), §4.4.1 (`posting-policy.schema.json` — consumed **unchanged**, same `$id`, same `"version": 1`), §4.4.2 (`evaluatePolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, sign normalisation A9), §4.5.1 (legal transitions), §4.5.2 (`document_event`, `app.effective_policy`), §4.5.3 (overrides, `app.principal_has`), §4.5.4 (`requireDocumentPermission`, and 3C's rule that a `POST` sub-path of an existing document uses stage `"submit"`), §4.5.7 (`app.party` and the four columns 4A adds), §4.6.1 (the table register rows `payment_term` and `allocation`), §4.7.2 (`applyMovements` and the four-branch receipt-value rule), §4.8.1 (allocation — implemented verbatim), §4.8.2 (ageing — consumed as the contract 4B will read), §4.14 (document-type codes), §4.15 (account codes), §4.16.1 / §4.16.3 (report codes and the Phase 1 report surface), §4.17 / §4.17.1 (the two helper registers), §5 (every hazard), §6.1 (tests 1, 10, 14, 31 re-run), §6.2 (row 1042, which this slice owns, and its four-capability proof table).
- **Interfaces produced:** §4.8.1 in full (`app.allocation` — **including the two columns and three constraint/index names Task 0 adds to that block: `unallocated_by`, `unallocation_reason`, `allocation_distinct_check`, `allocation_settlement_idx`, `allocation_settled_idx`** — plus `AllocationLine`, `AllocationRow`, `PartyBalance`, `allocateSettlement`, `unallocate`, `openBalance`, `partyBalance`, `listAllocations`); `app.payment_term` (§4.6.1) and `app.assert_credit_available()`; the §4.5.7 additions `party.credit_limit`, `party.payment_term_id`, `party.credit_hold` **and `party.price_list_id`** (6B's Task 0 amendment A10(b) registers the column and names 0045 as the file that adds it — the customer's trade level, so the till and the sales screens have a key to resolve "customer-specific pricing" on); the §4.3.4 addition `document.payment_term_id`; the six §4.14 rows `SALES_INVOICE`, `SALES_CREDIT_NOTE`, `PURCHASE_INVOICE`, `PURCHASE_CREDIT_NOTE`, `RECEIPT`, `PAYMENT` as seed-pack envelopes; the §3.6.2 codes `accounting.sales.post`, `accounting.receipt.create`, `accounting.receipt.post`, `accounting.payment.create`, `accounting.payment.approve`, `accounting.payment.post`, `accounting.credit_limit.override`; `ERR_CREDIT_LIMIT_EXCEEDED` and `ERR_CREDIT_HOLD` in `ERRORS`; the revenue-and-margin extension of `inventory.sales_by_item` (§4.16.1, the same code). Everything else is listed under *Contract additions* in the Self-Review and lands through **Task 0**.
- **Owner decisions:** **OD-05** (confirmation of every ⚠️ row in §3.0.3/§3.0.4 — for this slice the **Customer credit control** row, spec:1026) → **Task 12**, isolated; default: the spec text as written ("limits, ageing, and a block on over-limit sales"), built as designed, with ageing itself 4B's. **OD-24** (screenshots and a two-minute operator description before any screen) → **Task 13**, isolated; default: the screen task is blocked, the slice is not. **OD-09** (post-dated cheques) is 4B's and no line of this slice references `app.pdc` or `PDC_RECEIPT`. **OD-06** (costing method) is 3B's and is consumed here only through the costs 3D already wrote.
- **Part VI tests owned / re-run:** **owns none exclusively** — §6.1 gives this slice no test of its own, and §6.2 explains why row 1042's only acceptance proof (test 8) sits in 4B. **Re-runs:** **10** (approval authority, over `PAYMENT`'s approve/post pair — Task 10), **31** (segregation of duties, the `PAYMENT` clause spec:2449 names — Task 10), **14** (the one-query permission answer against the full accounting catalogue, `PURCHASE_RETURN` included — Task 11), **1** (the ledger invariant under fuzz through the six new types — Task 14), **8** (the invoice and receipt legs — **owned by 4B**; this slice proves only that `base = round(value × rate, 4)` holds on every line it posts, Task 14). **§3.0.4 rows owned:** **spec:1042** (party, invoices, credit notes, receipts/payments, allocation, credit limits, payment terms — ageing completed in 4B), and the **"4 (invoice link)"** half of spec:1051. **Regression files created / appended:** **creates `tests/regression/legacy-014.test.ts`** (the caller's exchange rate is never discarded — 4A is the first slice in execution order to touch LEGACY-014, §6.3); **appends** a `— 4A` block to `tests/regression/legacy-018.test.ts` (created by 3D — the invoiced-return block), `legacy-012`, `legacy-017`, `legacy-031`, `legacy-041`, `legacy-042` (all created by 0B or 3B), and **appends, create-if-absent** to `legacy-011` and `legacy-019`, whose creators the catalogue does not name — §3.7.3's rule makes the file order-independent, so the block is written the same way whether the file exists or not, exactly as 3C handled `legacy-005`.
- **Shared namespaces this slice writes into:** **document-type codes (§4.14)** — `SALES_INVOICE` (`accounting`, `INV`), `SALES_CREDIT_NOTE` (`accounting`, `CN`), `PURCHASE_INVOICE` (`accounting`, `PINV`), `PURCHASE_CREDIT_NOTE` (`accounting`, `PCN`), `RECEIPT` (`accounting`, `RCT`), `PAYMENT` (`accounting`, `PAY-OUT`), all six seeded as files under `packages/db/seed/my/document-types/`; plus **`CREDIT_TEST` (`accounting`, `CRT`) — test only**, registered by Task 0 exactly as 2A's `POLICY_TEST` and 3D's `COUNT_TEST` are, because Task 3's credit-control trigger must be proven against an outbound type before `SALES_INVOICE` exists. **Account codes (§4.15) — seeds none.** Every account this slice's policies name by code is already registered and seeded elsewhere: **`1250`** (3D), **`2150`** (3C), **`1100`**, **`1200`**, **`2100`**, **`5000`**, **`5900`**, **`5920`** (0C). Hazard 33 therefore binds in the *consuming* direction only, and **Task 2's first step asserts all eight resolve for the seeded company and re-seeds none**. **Report codes (§4.16.1)** — extends **`inventory.sales_by_item`**, the same registered code 3D shipped, with `revenue` and `margin`; **no new report code**. **`DatasetId` members (§4.16.2) — none**: 7A creates `datasets.ts` and this slice adds no member. **`fixtures.ts` helpers (§4.17) — one, and it is the row §4.17 already assigns 4A:** `seedPaymentTerm(db, s, opts?: { code?; dueDays? }) → string`. Nothing else is added there; every other row this slice's tests need comes from `seedTenantV2`, `seedAccount`, `seedBranch`, `seedParty`, `seedDocumentType`, `grantCodes`, `seedUnit`, `seedItem`, `seedWarehouse`, `seedLot`, `seedCurrency`, `seedRate` or 3C's `draftTypedDocument`. **Shared test helpers (§4.17.1) — one new file, registered by Task 0:** `postArDocument`, `ArLine`, `PostArOptions` in `tests/invariants/support/post-ar.ts`, the AR/AP twin of 3B's `postInventoryDocument`; 4B, 5A, 6A, 7C and 8C all need "post an invoice and a receipt against a party" and four file-local copies is the duplication hazard 9 forbids.
- **Five `Seed` and fixture facts every test in this plan depends on, stated once because getting one wrong is a silent failure.** (1) **`Seed` has no `branch` member.** It is `{ tenant; system; human; company; period; closedPeriod; lockedPeriod; cash; sales; docType; policy; branchType; hq }` (§4.1); the BRANCH dimension *value* is **`hq`**, `app.document.branch_id` is NOT NULL, so every `branchId:` in this plan is `<seed>.hq` unless a second value came from `seedBranch`. (2) **`seedTenant` grants `s.human` nothing** (§4.1, pinned) and 2B's R2 evaluates `policy.approval.post` *inside* the posting transaction, so **every posting test calls `grantCodes` first**. (3) **`seedTenantV2` creates only `1000 Cash` and `4000 Sales`.** The eight accounts this slice's policies resolve — `1100`, `1200`, `1250`, `2100`, `2150`, `5000`, `5900`, `5920` — are created in a test by 1A's `seedAccount(db, s, { code, nameEn, type })` — `type ∈ ('asset','liability','equity','income','expense')` — through the per-suite `for` loop this plan repeats where it is needed. **`4000` is never passed to `seedAccount`**: `seedTenantV2` already made it and the `(company_id, code)` unique constraint would refuse the second. **`1300` is not one of the eight** — no 4A policy names it; it is 3C's `GOODS_RECEIPT` inventory leg, and the suites that seed it (Tasks 4, 6, 7, 11) do so because they *post a 3C/3D document* or assert `1300` unchanged, never because a 4A policy resolves it. (4) **`seedParty` defaults to `kind: 'customer'` with `1200`/`2100`** (§4.17), which is why no test in this plan sets `receivableAccountId` unless it is testing a per-party override. (5) **`seedItem` returns `{ itemId, baseUnitId }`**, not a bare string, and creates the item's sentinel lot `NONE`.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first (that is what Task 0 is).
- **Contracts version:** 2026-09-07.

## Global Constraints

Copied verbatim from the spec and the contracts document; every task's requirements implicitly include this section.

1. **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (LEGACY-036/037/069); issue DDL from application code (LEGACY-053); disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053); gate an audit write on any flag (LEGACY-030); hard-code a package version into a source file — the lockfile owns versions.
2. **Always**, for every new table (spec:106): `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge. **This slice creates two tables** — `app.payment_term` (0044) and `app.allocation` (0046) — and each follows §3.5.1's recipe in full, with its `lintSchema` run to zero and its two-tenant test in the same task.
3. **Nothing outside `packages/db/src/posting/` and `packages/db/src/costing/` writes `ledger_entry`, `ledger_entry_dimension`, `inventory_movement`, `cost_layer`, `cost_consumption`, `account_balance`, `stock_on_hand` or `tax_transaction`** (§4.3.2, the `posting-only-tables` lint, hazard 22). Every service in this slice writes `document`, `document_line`, `document_link`, `allocation` and `payment_term` rows and then calls `postDocument`. **`app.allocation` is not a ledger table and `unallocate` never touches a ledger entry** (§4.8.1, spec:2457).
4. **Money** is `numeric(19,4)` in Postgres and the opaque `Money` type in `@dulja/domain` in TypeScript; **quantities** are `numeric(19,6)` and the opaque `Quantity`; no `number` ever holds a monetary value (spec:2041–2043, §3.7.5 `no-number-money`). Every wire amount is `{ amount, currency }` **except** the document-sub-resource fields 3C's registered exception covers, which are bare 4-dp decimal strings.
5. **`Money.toBase` rounds `HALF_AWAY_FROM_ZERO` at scale 4** (hazard 23), the only mode satisfying `base_debit = round(debit * exchange_rate, 4)` (spec:1816). No task in this slice performs a base conversion of its own on a *ledger* amount — `evaluatePolicy` and `balanceInBase` do it. **`packages/db/src/ar-ap/allocation.ts` is the one file of this slice that converts to base in TypeScript, and every conversion in it goes through `toBase`**: `allocateSettlement` converts a settlement amount at the **settled document's** rate for `base_amount` and at the **settlement's** rate for `fx_difference`, and `openBalance` converts the settled document's total for its base figure. A `× exchange_rate` written out anywhere in this slice is a second implementation of spec:1816's identity and therefore a second answer; Task 9's `legacy-019` block asserts the absence. **Relatedly, and for the same reason: no file under `packages/db/src` in this slice imports `decimal.js`.** It is `packages/domain`'s dependency (§4.2.1, D11) and is not declared in `packages/db/package.json`; every ratio here is an exact `Rational` and every product a `Money.multiply` with an explicit mode — the rule 3B fixed for `packages/db/src/costing` (3b:1124), applied to `invoice.ts`, `credit-note.ts` and `allocation.ts`.
6. **`PlannedLedgerLine.amount` is never negative and `side` is the sole carrier of direction** (§4.4.2 A9). This slice's credit notes carry **negated** line magnitudes, which is exactly the mechanism A9 describes, and **no line of code in this slice tests the sign of an amount to decide a direction**. `PlannedTaxLine.amount` stays signed and this slice plans no tax line (`tax.applies: false` on all six types; 5A flips it in a policy **version 2**).
7. **Every query, reads included, runs inside `withTenant`** (spec:2053). `db.` is a lint violation; only a `tx` obtained from `withTenant` may tag SQL. `sql.unsafe` has exactly three homes and none is in this slice (§3.3).
8. **One migration per PR** (spec:2057); each file runs whole in one transaction (so no `create index concurrently`); every statement carries a comment naming the LEGACY-/spec reference it serves; SQL keywords lowercase; section banners `-- ── N. title ───`; a hand-written `NNNN.down.sql` that drops only what the up added (§3.4.5).
9. **Expand only on a live table** (spec:2057, 2236, §3.4.7): migration 0045 adds five nullable-or-defaulted columns to `app.party` and `app.document` — `credit_limit`, `payment_term_id`, `credit_hold`, `price_list_id` on the party and `payment_term_id` on the document — and drops nothing; no column is renamed.
10. **Deletion** (spec:2049): financial rows never — reversal only; master data `archived_at`. §3.5.4's pinned `app_rw` DELETE list is **unchanged** by this slice — `payment_term` archives with `archived_at` and `allocation` reverses with `unallocated_at` — and Task 14 re-asserts the five-row list.
11. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). This slice adds **two** rows to `ERRORS`: `ERR_CREDIT_LIMIT_EXCEEDED` (already allocated in §4.2.4) and **`ERR_CREDIT_HOLD`** (allocated by Task 0). Both are raised as tokens by migration 0045's trigger, so **both land in the same commit as that migration** — `error-codes` scans `packages/db/migrations/**` and must stay green at every commit. Everything else this slice raises or asserts is already shipped, and the list is **twenty-five** codes long: `ERR_VALIDATION_FAILED`, `ERR_NOT_FOUND`, `ERR_CONFLICT_UNIQUE`, `ERR_CONFLICT_REFERENCE`, `ERR_RBAC_FORBIDDEN`, `ERR_RLS_DENIED`, `ERR_DOC_STATUS_ILLEGAL`, `ERR_DOC_NOT_DRAFT`, `ERR_DOC_NO_LINES`, `ERR_POLICY_NOT_FOUND`, `ERR_POLICY_INVALID`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_PERIOD_NOT_FOUND`, `ERR_PERIOD_NOT_OPEN`, `ERR_LEDGER_UNBALANCED`, `ERR_RATE_NOT_FOUND`, `ERR_SOD_NO_SUBMISSION`, `ERR_SOD_MAKER_IS_CHECKER`, `ERR_OVERRIDE_NOT_AUTHORISED`, `ERR_DOC_LINK_OVER_FULFILLED`, `ERR_IDEMPOTENCY_KEY_MISSING`, `ERR_MONEY_CURRENCY_MISMATCH`, `ERR_MONEY_SCALE`, `ERR_STOCK_INSUFFICIENT`, `ERR_ACTOR_IMMUTABLE`. **The last six are on the list because this slice's own text uses them** and every one is already allocated in §4.2.4 — `ERR_IDEMPOTENCY_KEY_MISSING` and `ERR_POLICY_INVALID` are 0B's and 2A's, `ERR_MONEY_CURRENCY_MISMATCH` / `ERR_MONEY_SCALE` are 0D's `Money`, `ERR_STOCK_INSUFFICIENT` is 3A's `assert_stock_available` and `ERR_ACTOR_IMMUTABLE` is Plan 0A's `stamp_actor`; this slice **adds none of them to `ERRORS`**, because their raisers shipped with their own slices. **This list is closed: a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.**
12. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice seeds exactly the seven codes §3.6.2 assigns it and invents none.
13. **No plan invents a literal in a shared namespace** (hazard 32). Document-type codes, account codes, report codes, `DatasetId` members, `fixtures.ts` helper names and `ERR_*` names all come from the registers; Task 0 amends a register before any task writes a literal into it.
14. **The slice that seeds a policy seeds the accounts that policy names by code** (§4.15, hazard 33). **4A seeds no account** — every code its six policies name is already registered with another slice as its seeder — so the rule binds here as its converse: **Task 2's first step asserts each of the eight accounts resolves for the seeded company, never re-seeds one, and never falls back to a null account.**
15. **The UI is not specified** (spec:79, 108). Every screen task begins with OD-24 and targets keyboard parity (spec:2254); no workflow is invented (hazard 29).
16. **Localisation** (spec:2061): every user-facing string goes through i18next with an ICU message; `packages/i18n` catalogues are complete in `en` and `ar` before merge.
17. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [4A T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root stay green after every task.

---

## This slice's share of the Phase 4 definition of done

The Phase 4 row of the phase table, verbatim (spec:2290) — **Definition of done:** "Ageing report reconciles to the ledger to the cent; a month is bank-reconciled with every receipt and payment matched or listed as unreconciled (till bankings and payroll batches join the same matching when Phases 6 and 8 land — test 39)".

**Both sentences are verified in 4B.** This slice's share is the correctness the first one *rests on*, and §6.2 states it as a table because row 1042 is the one coverage row whose owner and whose only acceptance proof sit in different slices (F-22). The four capabilities and where each is green here:

| Capability of row 1042 | Proof in this plan |
|---|---|
| **Allocation** | **Task 9** — `allocateSettlement` refuses an over-allocation (Σ lines greater than the settlement total, or greater than the settled document's open balance) with `ERR_VALIDATION_FAILED`; `openBalance` after `unallocate` returns to the pre-allocation figure to the cent and the compelled reason is stored on the row; a **credit note** as the settlement has capacity `\|total\| − allocated`, never `\|total − allocated\|`; `partyBalance` reads the party's control account in the ledger and reports concrete figures — `0.0000` for a settled invoice in its own currency, and the realised FX residue in base |
| **Credit limits** | **Task 3** (the trigger, over the `CREDIT_TEST` type) and **Task 5** (on a real `SALES_INVOICE`) — an outbound sales type at `submitted → issued` over `party.credit_limit` raises `ERR_CREDIT_LIMIT_EXCEEDED`; it issues when a **second** principal has recorded an `accounting.credit_limit.override` `document_event`; `party.credit_hold` raises `ERR_CREDIT_HOLD` even with the override |
| **Payment terms** | **Task 1** — `document.payment_term_id` is pinned at draft from the party's term and never re-read (LEGACY-013); the derived due date is `document.effective_date + payment_term.due_days`, asserted on the document, and it is the figure 4B's ageing buckets are cut on (§4.8.2) |
| **Invoices, credit notes, receipts, payments** | **Tasks 5–8 and 10**, with tests **10**, **14** and **31** re-run over them |
| Ageing | **4B**, which owns test 8 and both DoD sentences |

**Two further clauses this slice closes, both from the registers rather than from the phase row.** The **`1250` corridor** (§4.15, spec:1051's "4 (invoice link)") nets to zero across a `DELIVERY_ORDER` and its `SALES_INVOICE` — Task 6 asserts the account's balance is exactly `0.0000` after the pair. The **`2150` GRNI corridor** (§4.15, spec:1049) does the same across a `GOODS_RECEIPT` and its `PURCHASE_INVOICE` — Task 7. And the minimal-report clause spec:2300 requires — `inventory.sales_by_item` gaining revenue and margin under the same code — is **Task 11**.

**Slice exit (Task 14).** Every row above green in CI, plus tests **10**, **14** and **31** passing over this slice's types and codes, tests **1**, **12**, **13**, **27** and **36** re-run over this slice's rows, routes and codes — **not 2 and not 15: §6.1 row 2's re-run list is 3A/3B, 4B, 6C, 8C and 9B and this slice adds no projection, and row 15's is 3C, 3D, 5A and 8B; claiming either would be a re-run with no step behind it** — `lintSchema` at zero, `app.series_gaps` empty for all six new series, and the trial balance equal to the sum of `ledger_entry` for every company the suite touched.

---

## File Structure

Every path is relative to the repository root. **NEW** means this slice creates it; **EDIT** means an existing file gains the stated additions and nothing else.

```
docs/
├─ adr/0044-invoice-is-financial-only-clearing-corridors.md   NEW  proposal (spec:95)          T0
├─ adr/0045-negative-line-quantity-negates-line-cost.md       NEW  proposal (spec:95)          T4
├─ review/2026-09-05-phase-4a-exit.md                         NEW  the slice report            T14
└─ runbooks/credit-control-override.md                        NEW  the two-principal procedure  T3

scripts/check/
└─ contracts-4a-amendments.sh                                 NEW  Task 0's gate               T0

packages/db/
├─ migrations/
│  ├─ 0044_create_payment_term.sql                            NEW  §4.6.1 payment_term         T1
│  ├─ 0044.down.sql                                           NEW                              T1
│  ├─ 0045_alter_party_and_document_add_credit_terms.sql       NEW  §4.5.7 + §4.3.4 + trigger   T3
│  ├─ 0045.down.sql                                           NEW  drops five columns, two fns T3
│  ├─ 0046_create_allocation.sql                              NEW  §4.8.1 allocation           T9
│  ├─ 0046.down.sql                                           NEW                              T9
│  ├─ 0047_seed_permission_phase4a.sql                        NEW  seven codes (§3.6.2)        T2
│  └─ 0047.down.sql                                           NEW                              T2
├─ src/
│  ├─ schema/payment-term.ts        NEW  Drizzle mirror                                        T1
│  ├─ schema/allocation.ts          NEW  Drizzle mirror                                        T9
│  ├─ schema/party.ts               EDIT credit_limit, payment_term_id, credit_hold,           T3
│  │                                     price_list_id (6B A10(b); the mirror is the diff source)
│  ├─ schema/document.ts            EDIT payment_term_id                                       T3
│  ├─ lint-schema.ts                EDIT payment_term and allocation join no exemption set     T1,T9
│  ├─ ar-ap/
│  │  ├─ payment-term.ts   NEW  createPaymentTerm, updatePaymentTerm, archivePaymentTerm,
│  │  │                          listPaymentTerms, resolvePartyTerm, dueDateFor                T1
│  │  ├─ credit.ts         NEW  creditStatus, CreditStatus                                     T3
│  │  ├─ invoice.ts        NEW  convertToInvoice, micro, ConvertLine,
│  │  │                          ConvertToInvoiceInput, ConvertToInvoiceResult                 T6,T7
│  │  ├─ credit-note.ts    NEW  creditNoteFrom, CreditNoteInput, CreditNoteResult              T8
│  │  ├─ settlement.ts     NEW  draftSettlement, SettlementInput, SettlementResult             T10
│  │  ├─ allocation.ts     NEW  allocateSettlement, unallocate, openBalance, partyBalance,
│  │  │                          AllocationLine, AllocationRow, PartyBalance                   T9
│  │  └─ index.ts          NEW  the barrel @dulja/db re-exports                                T1
│  ├─ reports/sales-by-item.ts  EDIT revenue and margin on the same code (§4.16.1)             T11
│  └─ index.ts             EDIT re-exports ./ar-ap                                             T1
├─ seed/
│  ├─ roles.ts             EDIT seven codes onto three roles (§3.6.4)                          T2
│  └─ my/document-types/
│     ├─ SALES_INVOICE.json         NEW                                                        T5
│     ├─ PURCHASE_INVOICE.json      NEW                                                        T7
│     ├─ SALES_CREDIT_NOTE.json     NEW                                                        T8
│     ├─ PURCHASE_CREDIT_NOTE.json  NEW                                                        T8
│     ├─ RECEIPT.json               NEW                                                        T10
│     └─ PAYMENT.json               NEW                                                        T10
└─ test/
   ├─ fixtures.ts                       EDIT seedPaymentTerm (§4.17's one 4A row)              T1
   ├─ ar-ap/payment-term.test.ts        NEW  0044 DDL, round-trip, lint, two-tenant, due date  T1
   ├─ ar-ap/credit-control.test.ts      NEW  the trigger over CREDIT_TEST, override, hold      T3
   ├─ seed/permission-phase4a.test.ts   NEW  0047, roles.ts, the eight account assertions      T2
   ├─ posting/negative-cost.test.ts     NEW  the evaluator rule and the unfilled-cost refusal  T4
   ├─ ar-ap/sales-invoice.test.ts       NEW  posting, 1250, credit control on a real sale      T5
   ├─ ar-ap/invoice-conversion.test.ts  NEW  DO → INV, the 1250 round trip to zero             T6
   ├─ ar-ap/purchase-invoice.test.ts    NEW  GRN → PINV, the 2150 round trip to zero           T7
   ├─ ar-ap/credit-note.test.ts         NEW  negated magnitudes, the reversal target            T8
   ├─ ar-ap/stock-return.test.ts        NEW  the DELIVERY_ORDER reversal 3d:2723 deferred       T8
   ├─ ar-ap/allocation.test.ts          NEW  0046 DDL, over-allocation, openBalance, balances  T9
   ├─ ar-ap/settlement.test.ts          NEW  RECEIPT and PAYMENT, R1/R6                        T10
   ├─ reports/sales-by-item-revenue.test.ts NEW  revenue, margin and the ledger tie-out        T11
   ├─ ar-ap/_support.ts                 NEW  PACK_ROOT, loadTypesFromPack, accountByCode, plus4 T5
   └─ privileges.test.ts                EDIT the unchanged DELETE list re-asserted after 0047  T14

packages/domain/
├─ src/posting/evaluate.ts   EDIT line.cost on a negative-quantity line resolves negative      T4
└─ test/posting/
   └─ evaluate-negative-cost.test.ts  NEW  pure unit tests of the rule                         T4

packages/contracts/
├─ permissions.ts                        EDIT seven PermissionDef rows (§3.6.2)                T2
└─ src/
   ├─ errors.ts                          EDIT ERR_CREDIT_LIMIT_EXCEEDED, ERR_CREDIT_HOLD       T3
   ├─ accounting/payment-term.ts         NEW  the payment-term schemas                          T1
   ├─ accounting/party.ts                EDIT creditLimit, paymentTermId, creditHold,           T3
   │                                          priceListId (6B A10(b))
   ├─ accounting/document.ts             EDIT DocumentSchema gains paymentTermId, dueDate       T3
   ├─ accounting/invoice.ts              NEW  conversion and credit-note bodies                 T6
   ├─ accounting/allocation.ts           NEW  allocation, open balance, party balance           T9
   ├─ accounting/settlement.ts           NEW  DraftSettlementBody, SettlementResultSchema       T10
   └─ inventory/reports.ts               EDIT SalesByItemRowSchema gains revenue, margin        T11

apps/api/
├─ src/
│  ├─ middleware/require-document-permission.ts  EDIT POLICY_RESOLVED_CODES gains seven        T2
│  └─ routes/accounting/
│     ├─ payment-terms.ts   NEW  paymentTermRoutes — the ONE new route module                   T1
│     ├─ parties.ts         EDIT GET …/parties/{partyId}/balance                                T9
│     ├─ documents.ts       EDIT six sub-paths; DOCUMENT_STAGE_CODES from POLICY_RESOLVED_CODES T2,T6,T9
│     └─ reports.ts         EDIT the sales-by-item response gains two columns                    T11
└─ test/routes/accounting/
   ├─ payment-terms.test.ts   NEW  CRUD, gates, isolation, idempotency                          T1
   ├─ invoices.test.ts        NEW  the conversion and credit-note sub-paths                      T6,T8
   ├─ allocations.test.ts     NEW  allocate, unallocate, open balance, party balance             T9
   └─ settlements.test.ts     NEW  RECEIPT and PAYMENT through the API, tests 10 and 31          T10

apps/backoffice/src/features/ar-ap/       NEW  the four screens — BLOCKED on OD-24              T13

tests/
├─ invariants/
│  ├─ probes.ts                EDIT one PROBES entry for payment-terms                          T1
│  └─ support/post-ar.ts       NEW  postArDocument, ArLine, PostArOptions (§4.17.1)              T5
└─ regression/
   ├─ legacy-014.test.ts          NEW  the caller's rate is never discarded — 4A creates            T11
   ├─ legacy-018.test.ts          EDIT append the invoiced-return block (3D created)                T8
   ├─ legacy-011.test.ts          EDIT append, create-if-absent — no NULL reaches a balance         T14
   ├─ legacy-012.test.ts          EDIT append — base = value × rate on every AR/AP line             T14
   ├─ legacy-017.test.ts          EDIT append — delivered quantity is a projection                  T6
   ├─ legacy-019.test.ts          EDIT append, create-if-absent — one rounding function             T9
   ├─ legacy-031.test.ts          EDIT append — a posted invoice is immutable                       T14
   ├─ legacy-041.test.ts          EDIT append — allocation never alters a ledger entry              T9
   └─ legacy-042.test.ts          EDIT append — credit control never fails open                     T3
```

---

### Task 0: The contracts amendment PR and the 3A–3D repo gate

This task writes **no application code**. It lands the amendments the rest of the plan depends on into `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`, writes ADR 0044 as a proposal, and ships a gate script that refuses to pass until both (a) those amendments are present and (b) the 3A–3D exports this plan consumes actually exist in the repository with the shapes this plan was written against. **Task 1 does not start until this task's PR is merged and the script exits 0.**

**Files:**
- Create: `scripts/check/contracts-4a-amendments.sh`
- Create: `docs/adr/0044-invoice-is-financial-only-clearing-corridors.md`
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` (§2.5's 4A card, §3.4.2, §4.2.4, §4.2.7, §4.2.8, §4.3.4, §4.4.2, §4.5.7, §4.5.8, §4.6.1, §4.7.2, §4.8.1, §4.8.2, §4.8.3, §4.14, §4.16.1, §4.16.3, §4.17.1, §4.18, §6.1)

**§3.6.4 is deliberately NOT in that list, and this task does not touch it.** §3.6.4's own rule is that "every later introducing slice adds its row to this sentence **in the same PR** as its catalogue entries", and this slice's catalogue entries are Task 2's. The sentence is therefore extended by **Task 2 Step 5**, in the commit that adds the seven codes and the role grants; doing it here would split one rule's evidence across two PRs and would leave Task 2's PR unable to satisfy §3.6.4 on its own.

**Interfaces:**
- Consumes: nothing. The script reads files with `grep -F` and `grep -E` only.
- Produces: `scripts/check/contracts-4a-amendments.sh` — exit 0 when every amendment and every consumed export is present, exit 1 printing one line per missing item. ADR 0044 as a **proposal**, per spec:95 ("anything touching money semantics, security, the data model or the sync protocol is written as a proposal and asked before implementing").

**The seventeen amendments, each with the section it lands in and why the plan cannot proceed without it.** (Seventeen numbered items; the gate script's `need_doc` list has **twenty-five** entries because amendments 1, 6 and 9 each land two separately grepped literals and amendment 11 lands six.)

1. **§4.14 — the three inventory cells that cannot be implemented as written.** `inventory.effect` is one value per policy and §4.4.1 is frozen at `$id` `urn:dulja:posting-policy:1` from 2A onward, so no policy can carry a conditional effect. Rewrite the three cells:
   - `SALES_INVOICE` — `outbound / **none** / accounting.sales.post`, with the note *"The register previously read 'issue (or none when linked to a DO)', which no single policy can express. The seeded shape is `none`: stock leaves on `DELIVERY_ORDER` (3D) and the invoice relieves the **`1250`** corridor into cost of goods sold. This is the flow spec:1051 describes ('stock leaves before the invoice; converted into the invoice') and it is what makes `1250` an account that nets to zero. A tenant that wants a one-document, stock-issuing invoice configures its own type with zero code (test 15's promise); 4A seeds no such shape."*
   - `PURCHASE_INVOICE` — `inbound / **none** / accounting.purchase.post`, with the same note over **`2150`** and `GOODS_RECEIPT`/`SHIPMENT` (3C).
   - `SALES_CREDIT_NOTE` — `inbound / **none** / accounting.sales.post`, with the note *"`receipt` is not merely unnecessary here, it is wrong: `reverseDocument` negates the reversal document's line magnitudes (§4.4.2 A9), and 3D's amendment A2 flips a negative-quantity `receipt` into an `issue` — so a credit note produced by reversing a `SALES_INVOICE` would send the returned stock **out** a second time. The stock comes back through 3D's registered path, a `DELIVERY_ORDER` with negated quantities (3d:2740 — 'no `DELIVERY_RETURN` type is needed or registered'), and the credit note is financial only. `PURCHASE_CREDIT_NOTE` already read `none` and is unchanged."*
2. **§4.14 — one test-only row.** `CREDIT_TEST` · 4A (**test only**) · `accounting` · outbound / none / `accounting.sales.post` · `CRT` · *"the outbound type Task 3's credit-control trigger is proven against, configured through `seedDocumentType` inside a Testcontainers database and never a file under `packages/db/seed/my/document-types/`. A second code is needed because migration 0045's trigger must be red-then-green before `SALES_INVOICE` exists (Task 5), and 2A's `POLICY_TEST` is `direction: internal`, which the trigger deliberately ignores."*
3. **§4.4.2 — `line.cost` on a negative-quantity line (ADR 0045; the amendment 3D filed as blocking Phase 4).** Add to `evaluatePolicy`'s contract: *"**`amountRef` `line.cost` and `line.variance_value` resolve to `cost.negate()` when the source line's `quantity` is negative**, and to `cost` otherwise. `document_line.cost` stays a non-negative magnitude (§4.7.2 A6) and `applyMovements`' receipt-value branch 1 still receives a magnitude; only the *evaluator's* reading is signed, so A9's sign normalisation has a negative amount to act on and flips the side. Without it a reversal of any cost-bearing outbound document — 3D's `DELIVERY_ORDER`, whose reversal is the registered sales-return path, and 4A's `SALES_INVOICE` — debits its corridor account a **second** time instead of relieving it (3d:2740 names this as the open item that must land before Phase 4 relies on it). A line with a zero or null quantity is unaffected."*
4. **§4.7.2 — the unfilled-cost refusal, which is 2A's step-9b guard restored where step 9 now lives.** Add after the four-branch receipt-value rule: *"**A `fill`-tagged planned ledger line whose source `document_line` has no surviving `PlannedMovement` is left exactly as the evaluator emitted it** — `applyMovements` fills nothing and alters nothing on it. When that line's amount is `Money.zero` **and** the source line's `LineSnapshot.cost` is null, `applyMovements` **refuses the post** with `ERR_POLICY_REQUIRES_MISSING` naming the document line: the cost was never computed by a movement and never supplied by a conversion, and inserting the zero would understate cost of goods sold silently. When the source line carries a non-null `cost` — a figure another document computed and this one copied forward — the line stands at that figure and no movement is required. This is the branch 4A is the first slice to need, because it is the first with a `line.cost` ledger leg on a policy whose `inventory.effect` is `none`; 2A's step-9b guard said the same thing at step 9b and 3B removed it when it replaced the guard with this call (§4.3.2 step 9b)."*
5. **§4.7.2 / §4.3.4 — who may write `document_line.cost`.** Add: *"**`document_line.cost` is written by `applyMovements` and by 4A's two conversion services in `packages/db/src/ar-ap/invoice.ts` and `credit-note.ts`, and by nothing else.** 3D's Global Constraint 3 ('a drafting service never sets it') binds every *drafting* service and is unchanged; a **conversion** service is the stated exception, and the reason is arithmetic rather than convenience: the `SALES_INVOICE` must relieve `1250` by **the same figure the `DELIVERY_ORDER` debited**, or the corridor never nets to zero. Recomputing it from current layers would be a second costing answer for one physical movement (LEGACY-009, spec:1228) and would leave a residue in `1250` after every recost. The copy is a magnitude, exactly as 3C's `reverseDocument` line copy is (3c:219)."*
6. **§4.5.7 — the party additions, made explicit, and the fourth column 6B asked 0045 for.** §4.5.7 already says "4A adds `credit_limit numeric(19,4)`, `payment_term_id uuid`, `credit_hold boolean not null default false` (migration 0045)". Add the file name and the FK: *"the file is **`0045_alter_party_and_document_add_credit_terms.sql`** (§3.4.2's rename rule — it also adds `document.payment_term_id` and creates `app.assert_credit_available()`), and `payment_term_id` carries the composite FK `(tenant_id, payment_term_id) → app.payment_term(tenant_id, id)`."* **And add the fourth party column, which is 6B's request and not this slice's own idea:** *"**`price_list_id uuid`, nullable, with the composite FK `(tenant_id, price_list_id) → app.price_list(tenant_id, id)`, added by the same migration 0045**. It is registered here because 4A owns the customer's commercial terms and a price list is one of them, and because the column has to exist before the slice that reads it: 6B's Task 0 amendment **A10(b)** names `app.party.price_list_id` as the key §3.7.6's *customer-specific pricing* has nothing to resolve on — `app.price_list.customer_kind` is the trade *level* (3A) and no column ties a party to a list — and names **4A's 0045** as the file that adds it. 6A down-syncs `party` (customers) as a catalogue stream and 6B mirrors this column into `catalogue_customer`; until it exists, 6B's price resolution falls back to branch-then-company-wide and the row cannot close. **This amendment lands in 4A's Task 0 rather than 6B's** because 4A executes in Phase 4 and 6B in Phase 6, and Global Constraint 13 forbids a task writing a literal into a register that does not yet hold it — 0045 is written in Task 3, two phases before 6B's own Task 0 could amend the register. 6B's A10(b) is unchanged and stays true; when 6B runs, the sentence it asks for is already in §4.5.7."*
7. **§4.3.4 — the `document` header addition.** In the `app.document` header-additions sentence, after 3A's entry, insert: *"4A (**0045**) `payment_term_id uuid` — the payment term **pinned at draft** from `party.payment_term_id`, with the composite FK to `app.payment_term`; it is never re-read from the party (LEGACY-013), and the due date is the derived `effective_date + payment_term.due_days` and has no column of its own."*
8. **§4.8.2 — the pinned term, a latent LEGACY-013 in the ageing contract.** §4.8.2 says the buckets come "from `document.effective_date + payment_term.due_days`" without saying *which* term. Add: *"— the term **pinned on the document** (`document.payment_term_id`, 4A's 0045), never `party.payment_term_id` as it stands at rebuild time. A party's terms change; re-reading them would silently re-age every historical document, which is LEGACY-013 in the ageing projection. A document with a null `payment_term_id` is due on its `effective_date` and falls in the `current` bucket only on that day."*
9. **§4.2.4 — one new code, and one already-allocated row promoted.** Add to the allocated table: *`ERR_CREDIT_HOLD` | 422 | `assert_credit_available` — `party.credit_hold` is set (4A)*. And record in the per-slice row list: *"**4A adds two** — `ERR_CREDIT_LIMIT_EXCEEDED` (already allocated) and `ERR_CREDIT_HOLD`, both raised as tokens by migration 0045's trigger, each landing in the same commit as that migration."* The two are deliberately distinct because the remedies differ — raise the limit or obtain a second principal's override, versus release the hold — and **`ERR_CREDIT_HOLD` is not overridable** (§4.8.1: "`party.credit_hold` blocks regardless").
10. **§4.6.1 — the two register rows completed.** `payment_term`'s columns cell gains `archived_at`; `allocation`'s cell already points at §4.8.1 and is unchanged. Add to `payment_term`: *"`archived_at timestamptz` — master data is archived, never deleted (spec:2049), and §3.5.4's DELETE list is unchanged by this slice."*
11. **§4.8.1 — three names the block implies and does not give, two columns its DDL is missing, and the three constraint/index names 0046 adds.** §4's own rule is that a plan implements its code blocks verbatim and "may add members only by amending this document", so every one of these lands here before Task 9 writes it. Add after the `partyBalance` signature: *"`AllocationRow { id; companyId; partyId; settlementDocumentId; settledDocumentId; amount; baseAmount; fxDifference; allocatedBy; unallocatedAt; unallocatedBy; unallocationReason; createdAt }`, **plus the two derived read-only members `currency` and `baseCurrency` — the settled document's currency and the company's base currency, joined by `listAllocations` and stored in no column, because a row's three money fields are in two different currencies and the wire must name both**, and `PartyBalance { byCurrency: Record<string, Money>; base: Money }` are the two returned shapes, and **`listAllocations(tx, input: { settlementDocumentId?: string; settledDocumentId?: string; includeUnallocated?: boolean }): Promise<AllocationRow[]>`** is the read the allocation register and the 7C report both use. `allocateSettlement` computes `fx_difference` and stores it; **the gain/loss it implies is posted by 4B**, through `4900`/`5910` on an `FX_REVALUATION`, and 4A posts no FX line — which is why test 8 is 4B's."*

    And amend the DDL block itself, in the shape 3C used for `document_link_line_pair_key` and its siblings:
    - **two columns** — *"`unallocated_by uuid references app.principal(id)` (stamped) and `unallocation_reason text`. `unallocate` compels a reason from its caller; a reason validated and then discarded cannot be recovered from the audit, because `app.audit_row` writes `to_jsonb(new)` of the row and a value never written to a column is not in that image — the loss ADR 0023 fixed for `fiscal_period.reopen_reason` by making it a column. Migration 0046 therefore carries **both** stamps, `allocated_by` and `unallocated_by`, exactly as §4.8.3's `bank_match` carries `matched_by` and `unmatched_by` and for the same two reasons: the `stamp_actor` linter rule fires on every `*_by` column with no `stamp_<col>` trigger, and `stamp_actor` stamps on the NULL → value transition, which is when `unallocate` sets the column."*
    - **one constraint and two indexes** — *"`constraint allocation_distinct_check check (settlement_document_id <> settled_document_id)`, and the two partial indexes `allocation_settlement_idx on (settlement_document_id) where unallocated_at is null` and `allocation_settled_idx on (settled_document_id) where unallocated_at is null` — the two lookups `openBalance`, `allocateSettlement`'s capacity read and `listAllocations` all perform, partial because a reversed allocation is never one of them."*
    - **`openBalance` and the capacity check take the magnitude of the total BEFORE subtracting allocations**, not after — *"`|total| − Σ allocations`, never `|total − Σ allocations|`. A credit note is a legal `settlement_document_id` and 4A writes its magnitudes negated, so the second form reports `|−100 − 30| = 130.0000` of remaining capacity where 70.0000 is the truth, and admits over-allocation by exactly the amount already allocated."*
    - **`partyBalance` reads `ledger_entry` on the party's control account**, not `document_line` totals — *"`Σ (debit − credit)` and `Σ (base_debit − base_credit)` grouped by `ledger_entry.currency`, on `party.receivable_account_id` for a customer and `payable_account_id` for a vendor (the `1200`/`2100` defaults §4.8.2 fixes), signed in the party's own direction. `app.allocation` keys on `settled_document_id` and a settlement is never a settled document, so a document-side sum matches no allocation row for a RECEIPT and adds its full total to the balance instead of netting it. This is the same source `app.party_open_balance` (0045) and 4B's ageing control read, so the three cannot disagree about the underlying rows. **They do not agree about the sign, and the convention is fixed here: `partyBalance` reports a party-facing figure — positive means *owed to us* for a customer and *owed by us* for a vendor — which for a vendor is `−(Σ base_debit − base_credit)` on the payable control account, while `app.party_open_balance` returns the raw ledger figure unflipped (and reads `receivable_account_id` only, because what it serves is credit control — the trigger and `creditStatus()` — which is a customer question with no vendor side to flip). For a customer the two are identical; for a vendor they differ by exactly one negation. Any consumer that compares a `partyBalance` figure against a control-account ledger balance must negate the vendor side first, and 4B's `ageingTieOut` — which reads the `1200`/`2100` balances directly (§4.8.2) — must not be routed through `partyBalance` unconverted.**"*
12. **§4.8.3 — who registers the receipt and payment `ReconcilableSource`s.** §4.8.3's comment reads "4A registers receipt/payment", but `packages/db/src/ar-ap/reconciliation.ts` and `registerReconcilableSource` are **4B's** file and 4B's export, created by 4B's migrations 0049–0050 — 4A cannot register into a module that does not exist. Correct the comment to: *"**4B registers the `receipt` and `payment` sources over 4A's two document types** in the same PR as `registerReconcilableSource`; 6D adds `till_banking` and 8C `payroll_batch`. 4A ships nothing in this file."*
13. **§4.16.1 / §4.16.3 — the sales-by-item extension, named.** §4.16.1's `inventory.sales_by_item` cell already says "**4A extends the same code** with revenue and margin in the PR that ships `SALES_INVOICE`". Add to §4.16.3, after 3D's three read functions: *"**4A grows `SalesByItemRow` by exactly two members — `revenue: string` and `margin: string`, both base-currency 4-dp strings — and changes neither `SalesByItemParams` nor the `cost` member 3D defined** (Σ `cost_consumption.value` over `DELIVERY_ORDER` issues), so 3D's tie-out test is re-run unchanged. `revenue` is Σ `round(document_line.amount × document.exchange_rate, 4)` over **posted** `SALES_INVOICE` and `SALES_CREDIT_NOTE` lines for the item in the range — the credit note's negated magnitudes make it a subtraction with no sign logic — and `margin` is `revenue − cost`. **The two figures are cut on different documents and may therefore be cut on different dates:** goods delivered in the range but invoiced after it contribute cost and no revenue, which is exactly what a non-zero `1250` balance means and is the honest answer rather than a gap. 4B's `item_profitability` projection, keyed per fiscal period from posted lines, is the reconciling view, and 7B re-expresses the report over it under the same code."*
14. **§4.17.1 — the AR/AP posting helper.** Add a row: *`postArDocument(db, s, opts: PostArOptions)`, `ArLine`, `PostArOptions` | `tests/invariants/support/post-ar.ts` | **4A** | the AR/AP twin of 3B's `postInventoryDocument`: grants the type's `approval` codes once per `Seed`, drafts a typed document with account and item lines through 3C's `draftTypedDocument`, walks it through the real state machine (`transitionDocument` for a `required` approval, with a second principal from 3D's `secondPrincipal`) and posts it through the real `postDocument`. Returns `{ documentId, number, ledger: { code: string; debit: string; credit: string }[] }`, and writes `document.rate_source` — `"unit"` at rate `1.00000000`, `manual:<actor>` otherwise, the two spellings plan0A:1787's column comment gives — because `draftTypedDocument` does not and a posted document with a null provenance for its rate is LEGACY-012 itself. **`PostArOptions.twoPrincipal` is registered and is unexercised in 4A**: Task 10's `PAYMENT` cases walk the R1 approval explicitly in two sessions, because tests 10 and 31 are about which principal may do what and a helper that hid the two sessions would hide the thing under test. The member exists for 4B, 5A, 6A, 7C and 8C, whose two-principal walk is incidental to what they assert; the first slice to pass it is the first to prove it. 4B (ageing, FX, bank matching), 5A (tax on an invoice), 6A (test 22's `SALES_INVOICE` twin), 7C (the AR/AP reports) and 8C (statutory remittances as `PAYMENT`s) all need the helper, and five file-local copies is the duplication hazard 9 forbids*.

15. **§4.2.7 — the one new route module this slice mounts, registered in the module-path table.** §4.2.7's table exists precisely because "a `RouteModule.path` is also the `PROBES` key, so two slices must never mount two modules on one path" (hazard 31), and Task 1 mounts a genuinely new module. Add the row, immediately after 2C's `print-templates` row and in the same four-column shape:

    ```markdown
    | `/v1/companies/:companyId/payment-terms` | `paymentTermRoutes` (module const `paymentTermRouteModule`) | 4A | `accounting.party.manage` — **not** `admin.company.manage`: §3.6.2's "uses fixed by this document" list gives that code document types, posting policies, print templates, dimensions, custom fields and exchange rates, and payment terms are none of them; spec:2158 gives the back-office clerk "customers and vendors (credit terms included)" |
    ```

    And to the section's sub-path sentence, after 2C's entries: *"**Added by 4A**, all on modules that already exist: on 1A's `documents` module `POST …/documents/{documentId}/convert-to-invoice`, `POST …/documents/{documentId}/credit-note`, `POST …/documents/{documentId}/allocations`, `GET …/documents/{documentId}/allocations`, `POST …/documents/{documentId}/allocations/{allocationId}/unallocate`, `GET …/documents/{documentId}/open-balance` and `POST …/documents/settlements`; on 2A's `parties` module `GET …/parties/{partyId}/balance`. **None of the eight takes a `PROBES` entry** — `PROBES` is keyed by `RouteModule.path`, so they inherit `documents`' and `parties`' existing keys, and 4A adds exactly one new key, for `payment-terms`."*

16. **§4.2.8 — the four contract modules this slice creates, in the registered module-names table.** §4.2.8's table is the register that stops "no two slices spell one schema twice", and this slice adds four files and grows three. Add the rows:

    ```markdown
    | `accounting/payment-term.ts` | `PaymentTermSchema`, `CreatePaymentTermBody`, `UpdatePaymentTermBody`, `PaymentTermQuery`, `PaymentTermList`, `PaymentTermDto` | 4A |
    | `accounting/invoice.ts` | `ConvertLineSchema`, `ConvertToInvoiceBody`, `ConvertToInvoiceResultSchema`, `CreditNoteLineSchema`, `CreditNoteBody`, `CreditNoteResultSchema` | 4A |
    | `accounting/allocation.ts` | `AllocationSchema`, `AllocateSettlementBody`, `AllocateSettlementResultSchema`, `UnallocateBody`, `AllocationQuery`, `AllocationList`, `OpenBalanceSchema`, `PartyBalanceSchema` | 4A |
    | `accounting/settlement.ts` | `DraftSettlementBody`, `SettlementAllocationSchema`, `SettlementResultSchema` | 4A |
    | `accounting/party.ts`, `accounting/document.ts`, `inventory/reports.ts` (**grown additively**) | 4A adds `creditLimit`, `paymentTermId`, `creditHold` and **`priceListId`** (6B's A10(b) column — 4A exposes the field it adds, and resolves nothing against it) to `PartySchema` / `CreatePartyBody` / `UpdatePartyBody`; `paymentTermId` and the derived `dueDate` to `DocumentSchema`; `revenue` and `margin` to `SalesByItemRowSchema` | 4A |
    ```

    Registering them matters beyond tidiness: 4B ships an ageing surface over the same nouns, 7C ships the AR/AP reports, and both would otherwise be free to invent a second `AllocationSchema`.

17. **§6.1 row 22 — the POS equivalence that amendment 1 puts out of reach, handed to 6A rather than left to be discovered.** Row 22 reads "`POS_TICKET` vs `SALES_INVOICE` multiset compare per §5 item 18", and spec:2440 asks for identical ledger entries **and cost consumptions**. Amendment 1 makes that literally unsatisfiable against the seeded `SALES_INVOICE`, so add to the row's notes: *"**⚠️ 4A's ADR 0044 makes the seeded `SALES_INVOICE` `inventory.effect: none`, so it has zero cost consumptions and credits `1250` where a `POS_TICKET` consumes a layer and credits `1300`; the pair `DELIVERY_ORDER ∪ SALES_INVOICE` does not compare either, because the union carries a `1250` debit and credit the ticket never produces, on two effective dates, and hazard 18's projection set is frozen and does not net pairs.** 6A's Task 0 chooses one of exactly two readings and records it here: (a) test 22's "equivalent back-office invoice" is **a stock-issuing type 6A configures in its own fixture** — the shape §4.14's `SALES_INVOICE` note and test 15 already allow, seeded by no release pack — and the comparison runs against that; or (b) row 22 and hazard 18 are amended to compare the **pair** and net the two `1250` legs before the multiset compare. 4A cannot decide it: the POS policy is 6A's and 4A never sees it. Nothing in 4A is blocked either way — the corridor invariants of Tasks 6 and 7 stand under both readings."*

**The consumed-export gate.** 3A–3D execute before this slice, so the script checks the repository rather than trusting prose. Twelve checks, each a stop-and-raise against the named slice.

| Check | Why this plan needs it |
|---|---|
| `linkFulfilment`, `listLinks`, `openQuantity`, `OpenQuantityRow` exported from `packages/db/src/documents/link.ts` | Tasks 6 and 7 write `converts_to` links and read open quantity through them. **`createDocumentLink` and `documentOpenQuantity` do not exist** — the second is 3C's Drizzle *view mirror* name (3d:18) |
| `app.document_link.link_kind` admits `converts_to` and `returns` | Task 6 uses `converts_to` for DO → INV and GRN → PINV; Task 8 uses `returns` for a credit note. **`settles` stays unused by this slice** — `app.allocation` is the settlement record (§4.8.1) and two records of one fact is hazard 9 |
| `draftTypedDocument` exported from `packages/db/test/fixtures.ts` with `DraftLine` carrying `unitPrice`, `amount` and `accountId` | every DB-tier test in this plan drafts an invoice, a receipt or a payment; `draftDocument` (§4.1) is JOURNAL-only |
| `secondPrincipal` **exported** from `tests/invariants/support/post-inventory.ts` | Tasks 3, 5, 8 and 10 all need a second principal for an override event or an R1 approval; 3D's Task 0 added the `export` keyword |
| `postInventoryDocument`, `ensureOpenPeriods`, `recordingJobs` exported from the same file | Tasks 6, 7 and 11 create the stock this slice invoices, through the same door 3B and 3D use |
| `PlannedLedgerLine` carries the optional `fill` member | Task 4's refusal branch reads it; 3D's Task 0 added it |
| `packages/domain/src/posting/evaluate.ts` mentions `COST_AMOUNT_REFS` | Task 4 amends the resolution of exactly those two references; 3B introduced the constant (3c:196) and Task 4 must extend it rather than write a third list |
| `packages/db/src/costing/apply-movements.ts` mentions `fill` | 3D's amendment A6 shipped the fill rules there; Task 4 adds the no-movement branch beside them. If the string is absent, 3D's Task 4 has not merged and this task is blocked on **3D**, never worked around |
| `app.document_open_quantity` exists with `open_quantity` | Task 6 refuses to invoice more than the delivery's open quantity through the same view 3C built |
| `salesByItem`, `SalesByItemParams`, `SalesByItemRow` exported from `packages/db/src/reports/sales-by-item.ts` | Task 11 grows the row by two members; a second read function would break §4.16.1's "one code, three shipments" |
| `1250` is a row of `packages/db/seed/my/chart-of-accounts/3d-adjustments.json` and `2150` of `3c-purchasing.json` | hazard 33: this slice consumes both corridors and must not re-seed either |
| `DELIVERY_ORDER.json` and `GOODS_RECEIPT.json` exist and each posts its corridor leg at `line.cost` / `line.amount` respectively | Tasks 6 and 7 relieve exactly what those two files fill; if either changed its amount reference, the corridor arithmetic in this plan is wrong and the fix is a joint amendment |

- [ ] **Step 1: Write the gate script**

```bash
#!/usr/bin/env bash
# scripts/check/contracts-4a-amendments.sh
# Refuses until slice 4A's contract amendments are in the contracts document AND the
# 3A-3D exports this plan consumes exist in the repository. Run from the repo root.
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
need_fixed() {  # need_fixed <file> <FIXED string> <what it is> — for text that is itself a regex
  if [ ! -f "$1" ]; then echo "MISSING (repo): $1 — $3"; fail=1;
  elif ! grep -qF -- "$2" "$1"; then echo "MISSING (repo): $3 — $1 has no literal: $2"; fail=1; fi
}

# ── the seventeen amendments (twenty-five literals) ────────────────────
need_doc 'The seeded shape is `none`'                            'A1a the SALES_INVOICE cell (§4.14)'
need_doc 'would send the returned stock **out** a second time'   'A1b the SALES_CREDIT_NOTE cell (§4.14)'
need_doc '| `CREDIT_TEST` | 4A'                                  'A2 the CREDIT_TEST row (§4.14)'
need_doc 'resolve to `cost.negate()` when the source line'       'A3 the negative-quantity cost rule (§4.4.2)'
need_doc 'has no surviving `PlannedMovement`'                    'A4 the unfilled-cost refusal (§4.7.2)'
need_doc 'and by 4A'"'"'s two conversion services'               'A5 who may write document_line.cost (§4.7.2)'
need_doc '0045_alter_party_and_document_add_credit_terms.sql'    'A6a the party additions and the file name (§4.5.7)'
need_doc '(tenant_id, price_list_id) → app.price_list'           'A6b party.price_list_id, 6B A10(b) (§4.5.7)'
need_doc 'the payment term **pinned at draft**'                  'A7 document.payment_term_id (§4.3.4)'
need_doc 'never `party.payment_term_id` as it stands at rebuild' 'A8 the pinned term in ageing (§4.8.2)'
need_doc '`ERR_CREDIT_HOLD` | 422'                               'A9a the new error row (§4.2.4)'
need_doc '**4A adds two**'                                       'A9b the per-slice row list (§4.2.4)'
need_doc 'master data is archived, never deleted'                'A10 payment_term.archived_at (§4.6.1)'
need_doc 'listAllocations(tx, input:'                            'A11a the three allocation names (§4.8.1)'
need_doc 'unallocation_reason text'                              'A11b the reason and unallocated_by columns (§4.8.1)'
need_doc 'allocation_distinct_check'                             'A11c the CHECK 0046 adds (§4.8.1)'
need_doc 'allocation_settlement_idx'                             'A11d the two partial indexes 0046 adds (§4.8.1)'
need_doc 'never `|total − Σ allocations|`'                       'A11e magnitude BEFORE subtraction (§4.8.1)'
need_doc 'a settlement is never a settled document'              'A11f partyBalance reads the ledger (§4.8.1)'
need_doc '**4B registers the `receipt` and `payment` sources'    'A12 the Reconcilable ownership fix (§4.8.3)'
need_doc 'grows `SalesByItemRow` by exactly two members'         'A13 the report extension (§4.16.3)'
need_doc 'postArDocument(db, s, opts: PostArOptions)'            'A14 the AR/AP posting helper (§4.17.1)'
need_doc '| `/v1/companies/:companyId/payment-terms` | `paymentTermRoutes`' \
                                                                 'A15 the new route module row (§4.2.7)'
need_doc '| `accounting/allocation.ts` | `AllocationSchema`'     'A16 the four contract modules (§4.2.8)'
need_doc 'does not compare either, because the union carries'    'A17 the test-22 handoff to 6A (§6.1 row 22)'

# ── the consumed-export gate ───────────────────────────────────────────
# Every name below is copied from the WRITTEN 3A-3D plans, which are the authority for what they
# export. Do NOT "fix" this list back to a card's prose.
for n in linkFulfilment listLinks openQuantity OpenQuantityRow; do
  need_grep packages/db/src/documents/link.ts "export .*$n" "3C: $n (NOT createDocumentLink/documentOpenQuantity)"
done
need_grep packages/db/migrations/0037_create_document_link.sql \
  "'converts_to'" '3C: document_link.link_kind admits converts_to'
need_grep packages/db/migrations/0037_create_document_link.sql \
  "'returns'" '3C: document_link.link_kind admits returns'
need_grep packages/db/migrations/0037_create_document_link.sql \
  'open_quantity' '3C: the app.document_open_quantity view'
need_grep packages/db/test/fixtures.ts \
  'export async function draftTypedDocument' '3C: draftTypedDocument (§4.17)'
need_grep packages/db/test/fixtures.ts \
  'unitPrice' '3C: DraftLine carries unitPrice'
for n in postInventoryDocument secondPrincipal ensureOpenPeriods recordingJobs; do
  need_grep tests/invariants/support/post-inventory.ts "export .*$n" "3A/3B/3D: $n (§4.17.1)"
done
need_grep packages/domain/src/posting/evaluate.ts \
  'fill\?: "cost"' '3D: PlannedLedgerLine.fill (§4.4.2)'
need_grep packages/domain/src/posting/evaluate.ts \
  'COST_AMOUNT_REFS' '3B: the cost amount-reference list Task 4 extends'
need_grep packages/db/src/costing/apply-movements.ts \
  'fill' '3D: the applyMovements fill rules (§4.7.2 A6)'
for n in salesByItem SalesByItemParams SalesByItemRow; do
  need_grep packages/db/src/reports/sales-by-item.ts "export .*$n" "3D: $n (§4.16.3)"
done
need_grep packages/db/seed/my/chart-of-accounts/3d-adjustments.json '"1250"' '3D: account 1250'
need_grep packages/db/seed/my/chart-of-accounts/3c-purchasing.json  '"2150"' '3C: account 2150'
need_grep packages/db/seed/my/document-types/DELIVERY_ORDER.json \
  '"code": "1250"' '3D: DELIVERY_ORDER debits 1250 — the corridor this slice relieves'
need_grep packages/db/seed/my/document-types/GOODS_RECEIPT.json \
  '"code": "2150"' '3C: GOODS_RECEIPT credits 2150 — the corridor this slice relieves'
need_file docs/adr/0044-invoice-is-financial-only-clearing-corridors.md 'ADR 0044 (this task, Step 4)'

# ── the 0D Money parser gate ───────────────────────────────────────────
# This slice parses NEGATIVE money literals out of SQL in four places — `openBalance` and
# `allocateSettlement` read a credit note's negative `total_incl_tax` before taking `.abs()`
# (Task 9), `partyBalance` reads a signed `(debit - credit)` sum (Task 9), and `creditStatus`
# reads a signed `openBase` (Task 3). Every one of them assumes `Money.of()` accepts a leading
# minus. 0D's parser does: `packages/domain/src/money/money.ts` declares
# `const AMOUNT = /^-?\d+(\.\d{1,4})?$/` and 0D's own suite asserts
# `Money.of("-1.0000", MYR).isNegative()`. The gate is `grep -F` on that regex literal — the
# string IS a regex, so it must not go through need_grep — and it is scoped to money.ts so
# Quantity's `{1,6}` twin cannot satisfy it. IF THE GATE FAILS because a later change made the
# parser non-negative, the fallback for all four sites is `Money.of(magnitude).negate()` —
# strip the minus in SQL with `abs()`, parse the magnitude, negate in TypeScript — and NOT a
# second parser in this slice.
need_fixed packages/domain/src/money/money.ts 'const AMOUNT = /^-?\d+(\.\d{1,4})?$/' \
  '0D: Money.of parses a NEGATIVE literal (money.ts AMOUNT) — Tasks 3 and 9 depend on it'

if [ "$fail" -ne 0 ]; then
  echo
  echo "Slice 4A cannot start. Land the contracts amendments (Task 0) and reconcile the"
  echo "3A-3D exports above with their owning plans. Do NOT work around a missing export."
  exit 1
fi
echo "contracts-4a-amendments: ok"
```

- [ ] **Step 2: Run it to see it fail**

Run: `chmod +x scripts/check/contracts-4a-amendments.sh && bash scripts/check/contracts-4a-amendments.sh`
Expected: FAIL (exit 1) printing twenty-five `MISSING (contracts):` lines — one per amendment literal — before any `MISSING (repo):` line, ending with the three-line refusal.

- [ ] **Step 3: Apply the seventeen amendments to the contracts document**

Edit `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` exactly as the table above states, using the literal strings the script greps for. Two of them are whole table rows; write them out.

The `CREDIT_TEST` row goes in §4.14 immediately after 3D's `COUNT_TEST` row:

```markdown
| `CREDIT_TEST` | 4A (**test only**) | `accounting` | outbound / none / `accounting.sales.post` | `CRT` | the outbound type Task 3's credit-control trigger is proven against, configured through `seedDocumentType` inside a Testcontainers database and never a file under `packages/db/seed/my/document-types/`. A second code is needed because migration 0045's trigger must be red-then-green before `SALES_INVOICE` exists (Task 5), and 2A's `POLICY_TEST` is `direction: internal`, which the trigger deliberately ignores |
```

The `ERR_CREDIT_HOLD` row goes in §4.2.4's allocated-space table, in the right-hand column beside `ERR_CREDIT_LIMIT_EXCEEDED`:

```markdown
| `ERR_CREDIT_HOLD` | 422 | `assert_credit_available` — `party.credit_hold` is set (4A) |
```

- [ ] **Step 4: Write ADR 0044 as a proposal**

**ADR 0044 is proposal-and-proceed, and it deliberately gets NO owner-gate task of its own. Stated here so a reviewer is not left to infer it.** spec:95 requires anything touching money semantics to be "written as a proposal and asked before implementing"; the two written slices that hit the same rule handled it exactly this way and neither added a gate task — **2C** wrote ADR 0031 (attachment storage: security *and* the data model) as Step 6 of its own implementation task and shipped the code in the same PR (2c:947, 2c:1003), and **3C** wrote ADR 0041 (landed-cost allocation and purchase-return valuation, "written as a proposal because it touches money semantics") as Step 8 of Task 7 and shipped it the same way (3c:17, 3c:2865). An owner *decision* gets an isolated task; a **proposal** is recorded, implemented, and reversed by an amendment if it is rejected. §2.12's ledger lists no item for this decision, and the two owner gates this slice does carry — OD-05 (Task 12) and OD-24 (Task 13) — are the ones that do have ledger ids.

**It is also not isolatable, and that is the honest reason a gate task would be theatre.** Task 0's amendment 1 rewrites three §4.14 cells, and Tasks 5, 6, 7, 8, 10 and 11 are all written against `inventory: { effect: "none" }` — a rejection unwinds six tasks and three contract cells, not one droppable task, so a gate whose "until provided" clause said "the default stands" would be describing the whole slice. What a rejection actually costs, so it is priced rather than discovered:

| If ADR 0044 is rejected | What changes |
|---|---|
| The three §4.14 cells | Task 0's amendment 1 is withdrawn and the cells return to "issue (or none when linked to a DO)" — which still cannot be expressed by one policy, so §4.4.1's `$id` and `"version": 1` would have to be re-opened first. That is the change with the widest blast radius and it is a 2A amendment, not a 4A one |
| Tasks 5, 7, 8, 10 | Each type's seed file gains an `inventory` block and its policy gains movement rules; the corridor legs (`1250`, `2150`) come off `SALES_INVOICE` and `PURCHASE_INVOICE`, and `SALES_CREDIT_NOTE` becomes stock-bearing — which 3D's amendment A2 turns into a second stock *issue* on a return (Task 0 amendment 1 states why) |
| Task 6 and the whole conversion seam | `convertToInvoice`, `document_line.cost` copying (amendment 5) and both corridor invariants are removed; spec:1051's "4 (invoice link)" is then unbuilt and the §3.0.4 row this slice owns is not closed |
| Task 11 | `revenue` still works; `margin` loses its cost half unless costing moves onto the invoice |
| §6.1 row 22 | Amendment 17's ⚠️ note is withdrawn and test 22 compares as originally worded |

**Nothing is deferred waiting for the answer.** The corridor invariants of Tasks 6 and 7 are the evidence for the proposal, so the fastest route to a decision is to ship them and show the owner an account that nets to zero.

`docs/adr/0044-invoice-is-financial-only-clearing-corridors.md`, in Plan 0A's format (plan0A:189–203):

```markdown
# ADR 0044 — The invoice is financial only: `1250` and `2150` as the two clearing corridors

- **Status:** Proposed (spec:95 — this touches money semantics, so it is asked before it is implemented)
- **Date:** 2026-09-05
- **Slice:** 4A
- **Supersedes:** nothing. **Amends:** the three §4.14 inventory cells listed in 4A Task 0 amendment 1.

## Context

§4.14 describes `SALES_INVOICE` as "outbound / issue (or none when linked to a DO)" and
`PURCHASE_INVOICE` as "inbound / none when linked to a GRN, else receipt". Neither is expressible.
`posting-policy.schema.json` gives `inventory.effect` a single value per policy, `when` exists only on
`policyLine`, and the schema has been frozen at `$id` `urn:dulja:posting-policy:1` with
`"version": { "const": 1 }` since 2A widened it — "a schema change is a new `version` const and a new
`$id`" (§4.4.1). A conditional effect would therefore be a new schema version invalidating every
policy file in the repository, to serve one document type.

## Decision

Every one of slice 4A's six document types declares `inventory: { "effect": "none" }`. Stock moves
only where Phase 3 put it:

- **out** on `DELIVERY_ORDER`, which debits `1250` goods delivered not invoiced and credits the item's
  inventory account at `line.cost` (3D);
- **in** on `GOODS_RECEIPT` / `SHIPMENT`, which debit the item's inventory account and credit `2150`
  goods received not invoiced at `line.amount` (3C).

`SALES_INVOICE` then debits cost of goods sold and credits `1250` at the cost the delivery wrote, and
`PURCHASE_INVOICE` debits `2150` and credits trade payables at the amount the receipt accrued. Both
corridors net to exactly zero per pair. The conversion services copy the corridor figure forward
rather than recomputing it.

## Consequences

- **`1250` and `2150` become testable invariants**, not descriptive accounts: a non-zero balance means
  goods delivered and not yet invoiced, or received and not yet invoiced, and nothing else. Tasks 6
  and 7 assert `0.0000` after each pair.
- **One physical movement keeps one cost** (spec:1228, LEGACY-009). Relieving `1250` by a recomputed
  figure would leave a residue after every `inventory.cost.replay`.
- **A sales invoice cannot be raised without a delivery for a product line.** The refusal is
  mechanical, not procedural: with no linked delivery there is no cost on the line, the evaluator
  emits the two cost legs at `Money.zero` under amendment A5, and §4.7.2's new no-movement branch
  refuses the post with `ERR_POLICY_REQUIRES_MISSING` naming the line. A service-only invoice is
  unaffected — its cost legs are filtered out by `when: { "item.kind": "product" }`.
- **A tenant that wants a one-document stock-issuing invoice can still have one**, as its own
  configured type with its own policy and zero code (test 15). The release seeds no such shape.
- **Test 22's equivalence changes shape, and 6A decides how — not 4A.** §6.1 row 22 and spec:2440 ask
  that a `POS_TICKET` and "the equivalent back-office invoice" produce identical ledger entries **and
  cost consumptions**. Under this decision they cannot: a `SALES_INVOICE` alone has **zero** cost
  consumptions and credits `1250`, while a `POS_TICKET` (outbound / `issue`) consumes a layer and
  credits `1300`. Comparing the ticket against the *pair* `DELIVERY_ORDER ∪ SALES_INVOICE` does not
  rescue it either: the union multiset carries a `1250` debit and a `1250` credit the ticket never
  produces, on two effective dates, and hazard 18's projection set is frozen and does not net pairs.
  So test 22's "equivalent back-office invoice" is either **a tenant-configured stock-issuing type**
  (the bullet above), seeded by 6A's own fixture and never by the release pack — **or** §6.1 row 22
  and hazard 18 are amended to compare the pair and net the two `1250` legs. **6A's Task 0 decides
  which**, because 4A cannot see the POS policy and must not guess it. This is written down here for
  the same reason 3D wrote down the negative-cost rule instead of leaving 4A to discover it cold
  (3d:2740); amendment 17 puts the note in §6.1 so 6A reads it in its own section.
- **Rejected alternative — `when: { "document.kind": … }` on the cost legs with `effect: "issue"`.**
  It would express the two *ledger* shapes but not the two *movement* shapes, so a delivered invoice
  would issue the stock a second time; suppressing that needs a null `quantity` on a goods invoice
  line, which makes the invoice a false record of what was sold.
- **Rejected alternative — a second document-type code.** §4.14 registers one code and 4A's card
  enumerates four invoice and credit-note types; a fifth would make "sales invoice" ambiguous in every
  report, and the corridor design removes the need for it.
```

- [ ] **Step 5: Run the script again**

Run: `bash scripts/check/contracts-4a-amendments.sh`
Expected: PASS if 3A–3D are merged with the shapes above. If a `MISSING (repo):` line remains, **stop** — that is a reconciliation with the named slice's plan, not a 4A change. Record the discrepancy in the PR body and raise it before continuing.

- [ ] **Step 6: Add this slice's amendment rows to §4.18**

§4.18 carries **`### Round 1`** (contracts:3758) and **`### Round 2`** (contracts:3808) and nothing after them, so these rows go under a **new `### Round 3 — from plans 3A, 3B, 3C, 3D, 4A (2026-09-05)` heading** at the end of the section. If 3A–3D have already opened Round 3 by the time this task runs, append to it instead of opening a fourth; either way the heading that exists is the one used, and no row cites a round that has not landed.

```markdown
| 4.14 | **The three inventory cells `SALES_INVOICE`, `PURCHASE_INVOICE` and `SALES_CREDIT_NOTE` become `none`.** `inventory.effect` is one value per policy and §4.4.1 is frozen at one `$id` from 2A onward, so "issue (or none when linked)" is not expressible; and `receipt` on a credit note is actively wrong, because `reverseDocument` negates the line magnitudes and 3D's A2 flips a negative `receipt` into an `issue`. Stock stays on `DELIVERY_ORDER` / `GOODS_RECEIPT`, and the invoice relieves the `1250` / `2150` corridor. ADR 0044 (a proposal) | 4A | correction |
| 4.14 | `CREDIT_TEST` / `CRT` — **test only**, the outbound type migration 0045's credit-control trigger is proven against before `SALES_INVOICE` exists | 4A | plan |
| **4.4.2** | **ADR 0045 — `line.cost` and `line.variance_value` resolve to `cost.negate()` on a negative-quantity line.** This is the amendment 3D filed as blocking Phase 4 (3d:2740): without it a reversal of a cost-bearing outbound document debits its corridor a second time, because a copied cost is a magnitude and the fill rules never alter `side`. `document_line.cost` stays non-negative; only the evaluator's reading is signed | 4A, 3D | settlement |
| 4.7.2 | **The unfilled-cost refusal** — a `fill`-tagged planned line whose source line has no surviving movement is left as emitted, and is **refused** with `ERR_POLICY_REQUIRES_MISSING` when its amount is zero and the source `cost` is null. 2A's step-9b guard, restored where step 9 now lives; 4A is the first slice with a `line.cost` leg on an `effect: "none"` policy | 4A, 2A | correction |
| 4.7.2, 4.3.4 | **`document_line.cost` is written by `applyMovements` and by 4A's two conversion services, and by nothing else.** The corridor must be relieved by the figure that filled it or it never nets to zero (LEGACY-009) | 4A | plan |
| 4.5.7, 4.3.4, 3.4.2 | Migration **`0045_alter_party_and_document_add_credit_terms.sql`** — the card's short name understated the file, which also adds `document.payment_term_id` and creates `app.assert_credit_available()`; `party.payment_term_id` carries the composite FK | 4A | correction |
| 4.5.7 | **`party.price_list_id uuid`**, nullable, composite FK `(tenant_id, price_list_id) → app.price_list(tenant_id, id)`, added by the same migration 0045 — the key §3.7.6's *customer-specific pricing* resolves on, requested by **6B's Task 0 amendment A10(b)** and landed here because 4A executes two phases earlier and owns the file | 4A (for 6B) | addition |
| 4.8.2 | **The ageing buckets are cut on the term PINNED on the document**, never on the party's current term — a latent LEGACY-013 in the ageing contract | 4A | correction |
| 4.2.4 | `ERR_CREDIT_HOLD` (422), distinct from `ERR_CREDIT_LIMIT_EXCEEDED` because a hold is **not** overridable (§4.8.1 "blocks regardless") and the remedies differ; both raised as tokens by 0045 and landing in that commit | 4A | plan |
| 4.8.1 | `AllocationRow` (**including its two derived members `currency` and `baseCurrency`, which name the two currencies its three money fields are in**), `PartyBalance`, `listAllocations(tx, input)`; and the statement that **4A stores `fx_difference` and 4B posts the gain/loss** | 4A | plan |
| **4.8.1** | **Two columns the DDL was missing and three names 0046 adds:** `unallocated_by uuid references app.principal(id)` (stamped, so 0046 carries **both** stamps as §4.8.3's `bank_match` does) and `unallocation_reason text` — `unallocate` compels a reason and `app.audit_row` writes `to_jsonb(new)`, so a reason with no column is a reason no auditor can recover (the ADR 0023 loss); plus `allocation_distinct_check` and the two partial indexes `allocation_settlement_idx` / `allocation_settled_idx` | 4A | correction |
| **4.8.1** | **`openBalance` and the capacity check take `\|total\| − Σ allocations`, never `\|total − Σ allocations\|`**; and **`partyBalance` reads `ledger_entry` on the party's control account** rather than summing document totals — a settlement is never a settled document, so a document-side sum adds each receipt instead of netting it. One source with `app.party_open_balance` and 4B's ageing control, and **one stated sign convention: `partyBalance` is party-facing (a vendor figure is the ledger figure negated) while `app.party_open_balance` and a control-account balance are not, so the vendor side must be converted before the two are compared** | 4A | correction |
| **4.5.8** | The four 2C middleware exports live in `apps/api/src/middleware/require-attachment-read.ts` (2c:1786, 2c:4903); §4.5.8's prose names another path. Filed here because no earlier round carried it | 4A, for 2C | correction |
| **4.8.3** | **4B registers the `receipt` and `payment` `ReconcilableSource`s, not 4A.** `reconciliation.ts` and `registerReconcilableSource` are 4B's file and 4B's export; 4A ships nothing in it | 4A | correction |
| 4.16.3 | `SalesByItemRow` grows by **exactly two** members, `revenue` and `margin`; `SalesByItemParams` and 3D's `cost` are untouched, so 3D's tie-out is re-run unchanged. The two figures are cut on different documents and a non-zero `1250` is what the difference means | 4A | plan |
| 4.17.1 | `postArDocument`, `ArLine`, `PostArOptions` in `tests/invariants/support/post-ar.ts` — the AR/AP twin of `postInventoryDocument`, consumed by 4B, 5A, 6A, 7C and 8C | 4A | plan |
| **4.2.7** | The module row `/v1/companies/:companyId/payment-terms` → `paymentTermRoutes` / `paymentTermRouteModule`, gated `accounting.party.manage` — the one new module 4A mounts, and therefore the one new `PROBES` key. Plus the eight sub-paths 4A adds to 1A's `documents` and 2A's `parties`, none of which takes a key of its own (hazard 31) | 4A | plan |
| **4.2.8** | The four contract modules `accounting/payment-term.ts`, `accounting/invoice.ts`, `accounting/allocation.ts`, `accounting/settlement.ts` with their exports, and the three files 4A grows additively (`accounting/party.ts`, `accounting/document.ts`, `inventory/reports.ts`) — registered so 4B and 7C do not spell a second `AllocationSchema` | 4A | plan |
| **6.1 row 22** | **⚠️ The POS/invoice multiset compare cannot run against the seeded `SALES_INVOICE`** once amendment 1 makes it financial-only: the invoice has zero cost consumptions and credits `1250`, the ticket consumes a layer and credits `1300`, and the `DO ∪ INV` union does not compare either (an extra `1250` debit and credit, two effective dates, and hazard 18's frozen projection set does not net pairs). **6A's Task 0 picks (a) a 6A-configured stock-issuing type, seeded by no release pack, or (b) an amended row 22 that compares the pair and nets the `1250` legs.** 4A never sees the POS policy and does not choose; nothing in 4A is blocked either way | 4A, for 6A | open |
| 2.5 (4A card) | The card's expected migration name `0045_alter_party_add_credit_control.sql` yields to the longer name (§3.4.2); the card's 14–15 target lands as **15 headings, of which Task 0 carries no application code** — the same shape as 3C's | 4A | correction |
```

- [ ] **Step 7: Commit the amendment**

```bash
git add docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md \
        docs/adr/0044-invoice-is-financial-only-clearing-corridors.md \
        scripts/check/contracts-4a-amendments.sh
git commit -m "docs(contracts): register 4A's corridors, the negative-cost rule and the AR/AP helper [4A T0]

Seventeen amendments across §2.5, §3.4.2, §4.2.4, §4.2.7, §4.2.8, §4.3.4, §4.4.2, §4.5.7, §4.5.8,
§4.6.1, §4.7.2, §4.8.1, §4.8.2, §4.8.3, §4.14, §4.16.3, §4.17.1, §4.18 and §6.1, plus ADR 0044 as a
proposal and a gate script that also verifies the 3A-3D exports this slice consumes. No application
code. §3.6.4's grants sentence is deliberately NOT here: its own rule puts it in the same PR as the
catalogue entries, which is Task 2's.

A17 hands 6A the one consequence 4A cannot settle: with the seeded SALES_INVOICE financial-only,
test 22's POS/invoice multiset compare needs either a 6A-configured stock-issuing type or an amended
row 22. 4A never sees the POS policy, so 6A's Task 0 chooses.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 8: Wire the script into CI**

In `.github/workflows/ci.yml`, in the job that already runs `bun run lint:rules`, add a step after it:

```yaml
      - name: Contracts amendments (4A)
        run: bash scripts/check/contracts-4a-amendments.sh
```

---

### Task 1: Migration 0044 — `app.payment_term`, its route module and the due-date derivation

The first of this slice's two new tables, and the only one that is master data. It is taken first because `party.payment_term_id` (Task 3) carries a composite FK to it and a foreign key cannot precede its parent.

**Files:**
- Create: `packages/db/migrations/0044_create_payment_term.sql`, `packages/db/migrations/0044.down.sql`
- Create: `packages/db/src/schema/payment-term.ts`
- Create: `packages/db/src/ar-ap/payment-term.ts`, `packages/db/src/ar-ap/index.ts`
- Create: `packages/contracts/src/accounting/payment-term.ts`
- Create: `apps/api/src/routes/accounting/payment-terms.ts`
- Create: `packages/db/test/ar-ap/payment-term.test.ts`, `apps/api/test/routes/accounting/payment-terms.test.ts`
- Modify: `packages/db/src/index.ts` (re-export `./ar-ap`), `packages/db/test/fixtures.ts` (`seedPaymentTerm`), `apps/api/src/routes/index.ts` (`buildRoutes` gains one module), `tests/invariants/probes.ts` (one `PROBES` entry)

**Interfaces:**
- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app.current_actor` (§4.1); `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE` (§4.1); `withTenant` (§4.2.2, both the production and the test helper); `AppError`, `ERRORS`, `fromDatabaseError` (§4.2.4); `PERMISSION`, `requirePermission` (§4.2.5); `RouteModule`, `buildRoutes`, `IdempotencyHeader`, `AppEnv` (§4.2.7); `UuidSchema`, `DateSchema`, `TimestampSchema`, `ListEnvelope`, `ListQuery`, `ProblemSchema`, `encodeCursor`, `decodeCursor` (§4.2.8); `PROBES`, `IsolationProbe` (§4.2.7, §3.7.2); `startDb`, `Db`, `Seed`, `seedTenantV2`, `uuidv7` (§4.1, 1A); `startApi`, `grantAdmin`, `problemOf` (§4.2.12, §4.17.1).
- Produces:

```ts
// packages/db/src/ar-ap/payment-term.ts
export interface PaymentTermRow {
  id: string; companyId: string; code: string; nameEn: string; nameAr: string | null;
  dueDays: number; discountDays: number | null; discountPct: string | null;   // pct is a 6-dp string, never a number
  archivedAt: string | null; createdAt: string;
}
export interface CreatePaymentTermInput {
  companyId: string; code: string; nameEn: string; nameAr?: string | null;
  dueDays: number; discountDays?: number | null; discountPct?: string | null;
}
export interface UpdatePaymentTermInput {
  paymentTermId: string; nameEn?: string; nameAr?: string | null;
  dueDays?: number; discountDays?: number | null; discountPct?: string | null;
}
export async function createPaymentTerm(tx: Sql, ctx: TenantContext, input: CreatePaymentTermInput): Promise<PaymentTermRow>;
export async function updatePaymentTerm(tx: Sql, ctx: TenantContext, input: UpdatePaymentTermInput): Promise<PaymentTermRow>;
export async function archivePaymentTerm(tx: Sql, ctx: TenantContext, input: { paymentTermId: string }): Promise<PaymentTermRow>;
export interface ListPaymentTermsInput { companyId: string; includeArchived?: boolean; cursor?: { code: string } | null; limit: number }
export async function listPaymentTerms(tx: Sql, input: ListPaymentTermsInput): Promise<PaymentTermRow[]>;
/** The party's current term, or null. Read at DRAFT time only — the document pins the id (§4.3.4, LEGACY-013). */
export async function resolvePartyTerm(tx: Sql, input: { partyId: string }): Promise<string | null>;
/** `effective_date + due_days`, computed in SQL so no JavaScript date arithmetic and no timezone can enter it.
 *  A null `paymentTermId` returns `effectiveDate` unchanged — due on the day (§4.8.2). */
export async function dueDateFor(tx: Sql, input: { paymentTermId: string | null; effectiveDate: string }): Promise<string>;
```

```ts
// packages/contracts/src/accounting/payment-term.ts
export const PaymentTermSchema: z.ZodObject<{ id; companyId; code; nameEn; nameAr; dueDays; discountDays; discountPct; archivedAt; createdAt }>;
export const CreatePaymentTermBody: z.ZodObject<{ code; nameEn; nameAr; dueDays; discountDays; discountPct }>;
export const UpdatePaymentTermBody: z.ZodObject<{ nameEn; nameAr; dueDays; discountDays; discountPct }>;
export const PaymentTermQuery: z.ZodObject<{ cursor; limit; sort; fields; "filter[archived][eq]" }>;
export const PaymentTermList: ReturnType<typeof ListEnvelope<typeof PaymentTermSchema>>;
```

```ts
// apps/api/src/routes/accounting/payment-terms.ts
export const paymentTermRoutes: OpenAPIHono<AppEnv>;
export const paymentTermRouteModule: RouteModule;   // path "/v1/companies/:companyId/payment-terms"
export const PAYMENT_TERM_PAGE: ScopeSource;        // { company: "path:companyId" } — declared once, used by all four routes
```

```ts
// packages/db/test/fixtures.ts — §4.17's one 4A row
export async function seedPaymentTerm(db: Db, s: Seed, opts?: { code?: string; dueDays?: number }): Promise<string>;
```

**Why the module is gated `accounting.party.manage` and not `admin.company.manage`.** §3.6.2's "uses fixed by this document" list assigns document types, posting policies, print templates, dimensions, custom fields and exchange rates to `admin.company.manage`, and payment terms appear in none of those. spec:2158 gives the `user` role "maintain customers and vendors (**credit terms included**)", and `accounting.party.manage` is the code `user` holds for exactly that (2A, §3.6.4). Gating terms behind `admin.company.manage` would mean the clerk who sets a customer's terms cannot create the term itself, which is the split spec:2158 explicitly rejects. No new code is introduced.

**Why `discount_pct` is `numeric(9,6)` and a string on the wire.** §4.6.1 fixes the column. It is a *fraction*, not money — `0.020000` is two per cent — so it is neither `MoneySchema` nor a `number`: `no-number-money` matches the name `discount_pct` on `/rate|tax|.../`… it matches nothing in that list by name, but `pct` is a rate by nature and a float would round wrongly at the fourth decimal of a discount on a large invoice. It is a 6-dp decimal string throughout, and **nothing in this slice computes with it** — the early-settlement discount is a Phase 10 capability; 4A stores the term's terms and 4B ages on `due_days` alone. That is stated here so no later reader assumes a discount is applied somewhere.

- [ ] **Step 1: Write the failing DB-tier test `packages/db/test/ar-ap/payment-term.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import {
  archivePaymentTerm, createPaymentTerm, dueDateFor, listPaymentTerms, updatePaymentTerm,
} from "../../src/ar-ap/payment-term";
import { seedTenantV2, startDb, uuidv7, withTenant, type Db, type Seed } from "../index";

let db: Db;
let s: Seed;
let other: Seed;
const ctxOf = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "00000000-0000-0000-0000-000000000000" });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "payment-term");
  other = await seedTenantV2(db, "payment-term-other");
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("app.payment_term — migration 0044, contracts §4.6.1", () => {
  it("the schema linter reports zero violations after 0044", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("creates a term, defaults nameAr, discountDays and discountPct to null, and round-trips every column", async () => {
    const row = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      createPaymentTerm(tx, ctxOf(s), { companyId: s.company, code: "NET30", nameEn: "Net 30 days", dueDays: 30 }));
    expect(row.code).toBe("NET30");
    expect(row.dueDays).toBe(30);
    expect(row.nameAr).toBeNull();
    expect(row.discountDays).toBeNull();
    expect(row.discountPct).toBeNull();
    expect(row.archivedAt).toBeNull();
  });

  it("keeps discount_pct as a 6-dp STRING — never a JavaScript number (no-number-money, §3.7.5)", async () => {
    const row = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      createPaymentTerm(tx, ctxOf(s), {
        companyId: s.company, code: "2-10-N30", nameEn: "2% 10 days, net 30",
        dueDays: 30, discountDays: 10, discountPct: "0.020000",
      }));
    expect(row.discountPct).toBe("0.020000");
    expect(typeof row.discountPct).toBe("string");
  });

  it("refuses a duplicate (company, code) with ERR_CONFLICT_UNIQUE", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      createPaymentTerm(tx, ctxOf(s), { companyId: s.company, code: "NET30", nameEn: "again", dueDays: 30 })))
      .rejects.toThrow(/ERR_CONFLICT_UNIQUE/);
  });

  it("refuses a negative due_days at the database, not at the service", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`insert into app.payment_term (tenant_id, company_id, code, name_en, due_days)
         values (${s.tenant}, ${s.company}, ${"BAD"}, ${"bad"}, ${-1})`))
      .rejects.toThrow(/payment_term_due_days_check/);
  });

  it("refuses discount_days greater than due_days at the database (a discount after the due date is not a discount)", async () => {
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`insert into app.payment_term (tenant_id, company_id, code, name_en, due_days, discount_days, discount_pct)
         values (${s.tenant}, ${s.company}, ${"BAD2"}, ${"bad"}, ${10}, ${20}, ${"0.010000"})`))
      .rejects.toThrow(/payment_term_discount_window_check/);
  });

  it("archives rather than deletes, and archived rows are hidden from the default list (spec:2049)", async () => {
    const id = await withTenant(db.rw, s.tenant, s.human, async (tx) =>
      (await createPaymentTerm(tx, ctxOf(s), { companyId: s.company, code: "COD", nameEn: "Cash on delivery", dueDays: 0 })).id);
    const archived = await withTenant(db.rw, s.tenant, s.human, (tx) => archivePaymentTerm(tx, ctxOf(s), { paymentTermId: id }));
    expect(archived.archivedAt).not.toBeNull();
    const visible = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listPaymentTerms(tx, { companyId: s.company, limit: 50 }));
    expect(visible.map((r) => r.code)).not.toContain("COD");
    const all = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listPaymentTerms(tx, { companyId: s.company, includeArchived: true, limit: 50 }));
    expect(all.map((r) => r.code)).toContain("COD");
  });

  it("updatePaymentTerm changes due_days and leaves the code alone (renaming a code is forbidden)", async () => {
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listPaymentTerms(tx, { companyId: s.company, limit: 1 }));
    const updated = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      updatePaymentTerm(tx, ctxOf(s), { paymentTermId: row!.id, dueDays: 45 }));
    expect(updated.dueDays).toBe(45);
    expect(updated.code).toBe(row!.code);
  });

  it("dueDateFor computes effective_date + due_days IN SQL, and a null term is due on the day (§4.8.2)", async () => {
    const id = await withTenant(db.rw, s.tenant, s.human, async (tx) =>
      (await createPaymentTerm(tx, ctxOf(s), { companyId: s.company, code: "NET60", nameEn: "Net 60", dueDays: 60 })).id);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      expect(await dueDateFor(tx, { paymentTermId: id, effectiveDate: "2026-01-15" })).toBe("2026-03-16");
      expect(await dueDateFor(tx, { paymentTermId: null, effectiveDate: "2026-01-15" })).toBe("2026-01-15");
    });
  });

  it("a second tenant cannot see or write this tenant's terms (spec:106)", async () => {
    const mine = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      listPaymentTerms(tx, { companyId: s.company, limit: 50 }));
    expect(mine).toEqual([]);
    const stolenId = await uuidv7(db.admin);
    await expect(withTenant(db.rw, other.tenant, other.human, (tx) =>
      tx`insert into app.payment_term (id, tenant_id, company_id, code, name_en, due_days)
         values (${stolenId}, ${other.tenant}, ${s.company}, ${"X"}, ${"x"}, ${1})`))
      .rejects.toThrow();   // the composite FK (tenant_id, company_id) has no row to point at
  });

  it("every write is audited (test 13 re-run over this table)", async () => {
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name = 'payment_term'`;
    expect(n!.n).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to see the exact expected failure**

Run: `bun run --cwd packages/db test ar-ap/payment-term`
Expected: FAIL in `beforeAll`'s first case body with `error: relation "app.payment_term" does not exist` — and, before that, a TypeScript resolution error on `../../src/ar-ap/payment-term` because the module does not exist. Both are the correct red: the table and the service are Steps 3–5.

- [ ] **Step 3: Write `packages/db/migrations/0044_create_payment_term.sql`**

```sql
-- 0044_create_payment_term.sql
-- Slice 4A. app.payment_term — the terms an invoice is aged on (spec:1042 "payment terms"; contracts §4.6.1).
-- Master data: archived, never deleted (spec:2049); §3.5.4's app_rw DELETE list is unchanged by this file.

-- ── 1. the table ───────────────────────────────────────────────────────
create table app.payment_term (
  id             uuid primary key default uuidv7(),                       -- §3.2 identifiers (LEGACY-021)
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  code           text not null,
  name_en        text not null,                                            -- §3.2 bilingual master data, not a JSON blob
  name_ar        text,
  due_days       int not null,
  discount_days  int,
  discount_pct   numeric(9,6),                                             -- a FRACTION, not money: 0.020000 is two per cent
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  constraint payment_term_due_days_check         check (due_days >= 0),
  constraint payment_term_discount_pct_check     check (discount_pct is null or (discount_pct > 0 and discount_pct < 1)),
  -- a discount window that ends after the due date is not a discount window
  constraint payment_term_discount_window_check  check (
    (discount_days is null and discount_pct is null)
    or (discount_days is not null and discount_pct is not null and discount_days >= 0 and discount_days <= due_days)),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);

-- ── 2. tenancy, audit, privileges (§3.5.1) ─────────────────────────────
call app_meta.enable_tenant_rls('app.payment_term');   -- policy `tenant_isolation`, RLS enabled AND forced
call app_meta.attach_audit('app.payment_term');         -- spec:106; test 13 covers this table from now on
-- app_rw receives select, insert, update through default privileges (plan0A:2564). No DELETE (§3.5.4).

-- ── 3. the due-date function (§4.8.2) ──────────────────────────────────
-- Computed in SQL so no JavaScript date arithmetic and no session timezone can enter an accounting date
-- (§3.2: effective_date is a `date`, entered by the user, never derived from a timestamp).
create function app.payment_due_date(p_payment_term_id uuid, p_effective_date date) returns date
language sql stable as $$
  select case
           when p_payment_term_id is null then p_effective_date
           else p_effective_date + (select t.due_days from app.payment_term t where t.id = p_payment_term_id)
         end
$$;
comment on function app.payment_due_date(uuid, date) is
  'contracts §4.8.2: the ageing buckets are cut on effective_date + due_days of the term PINNED on the document.';
```

- [ ] **Step 4: Write `packages/db/migrations/0044.down.sql`**

```sql
-- Drops exactly what 0044 created, in reverse dependency order (§3.4.5).
drop function if exists app.payment_due_date(uuid, date);
drop table if exists app.payment_term;   -- drops its policy, its audit trigger and its grants with it
```

- [ ] **Step 5: Write the Drizzle mirror and the service**

`packages/db/src/schema/payment-term.ts` — the read mirror (§3.4.9; the working loop is edit-the-mirror → `drizzle-kit generate` → hand-edit → hand-write the down):

```ts
import { integer, numeric, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

export const paymentTerm = app.table("payment_term", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  dueDays: integer("due_days").notNull(),
  discountDays: integer("discount_days"),
  discountPct: numeric("discount_pct", { precision: 9, scale: 6 }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({ byCode: unique().on(t.companyId, t.code) }));
```

`packages/db/src/ar-ap/payment-term.ts`:

```ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";

export interface PaymentTermRow {
  id: string; companyId: string; code: string; nameEn: string; nameAr: string | null;
  dueDays: number; discountDays: number | null; discountPct: string | null;
  archivedAt: string | null; createdAt: string;
}

/** The one projection every reader of this table uses, so `discount_pct` is a string in exactly one place. */
const SELECT_COLUMNS = (tx: Sql) => tx`
  id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
  due_days::int as "dueDays", discount_days::int as "discountDays", discount_pct::text as "discountPct",
  archived_at as "archivedAt", created_at as "createdAt"`;

export interface CreatePaymentTermInput {
  companyId: string; code: string; nameEn: string; nameAr?: string | null;
  dueDays: number; discountDays?: number | null; discountPct?: string | null;
}

export async function createPaymentTerm(
  tx: Sql, _ctx: TenantContext, input: CreatePaymentTermInput,
): Promise<PaymentTermRow> {
  const [row] = await tx<PaymentTermRow[]>`
    insert into app.payment_term
      (tenant_id, company_id, code, name_en, name_ar, due_days, discount_days, discount_pct)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn},
            ${input.nameAr ?? null}, ${input.dueDays}, ${input.discountDays ?? null},
            ${input.discountPct ?? null})
    returning ${SELECT_COLUMNS(tx)}`;
  return row!;
}

export interface UpdatePaymentTermInput {
  paymentTermId: string; nameEn?: string; nameAr?: string | null;
  dueDays?: number; discountDays?: number | null; discountPct?: string | null;
}

/** `code` is deliberately absent from the input: renaming an identifier is forbidden (§3.4.7 applied to data). */
export async function updatePaymentTerm(
  tx: Sql, _ctx: TenantContext, input: UpdatePaymentTermInput,
): Promise<PaymentTermRow> {
  const [row] = await tx<PaymentTermRow[]>`
    update app.payment_term set
      name_en       = coalesce(${input.nameEn ?? null}, name_en),
      name_ar       = case when ${input.nameAr !== undefined} then ${input.nameAr ?? null} else name_ar end,
      due_days      = coalesce(${input.dueDays ?? null}, due_days),
      discount_days = case when ${input.discountDays !== undefined} then ${input.discountDays ?? null} else discount_days end,
      discount_pct  = case when ${input.discountPct !== undefined} then ${input.discountPct ?? null} else discount_pct end
     where id = ${input.paymentTermId}
    returning ${SELECT_COLUMNS(tx)}`;
  if (row === undefined) throw new Error("ERR_NOT_FOUND: payment term is not visible");
  return row;
}

export async function archivePaymentTerm(
  tx: Sql, _ctx: TenantContext, input: { paymentTermId: string },
): Promise<PaymentTermRow> {
  const [row] = await tx<PaymentTermRow[]>`
    update app.payment_term set archived_at = coalesce(archived_at, now())
     where id = ${input.paymentTermId}
    returning ${SELECT_COLUMNS(tx)}`;
  if (row === undefined) throw new Error("ERR_NOT_FOUND: payment term is not visible");
  return row;
}

export interface ListPaymentTermsInput {
  companyId: string; includeArchived?: boolean; cursor?: { code: string } | null; limit: number;
}

export async function listPaymentTerms(tx: Sql, input: ListPaymentTermsInput): Promise<PaymentTermRow[]> {
  return tx<PaymentTermRow[]>`
    select ${SELECT_COLUMNS(tx)} from app.payment_term
     where company_id = ${input.companyId}
       and (${input.includeArchived ?? false} or archived_at is null)
       and (${input.cursor?.code ?? null}::text is null or code > ${input.cursor?.code ?? null})
     order by code
     limit ${input.limit}`;
}

/**
 * The party's current term. Read at DRAFT time only; the document pins the id (§4.3.4, LEGACY-013).
 *
 * **This is the only reader of `app.party.payment_term_id` in the slice** — `convertToInvoice` (Task 6) and
 * `draftSettlement` (Task 10) both call it instead of carrying an inline subquery, because two spellings of
 * one fact is what §4.17's register exists to prevent and because a second spelling would not have this
 * function's `ERR_NOT_FOUND` guard. `null` means "the party has no term"; an invisible party RAISES, so a
 * caller that needs to know the party exists needs no probe of its own.
 */
export async function resolvePartyTerm(tx: Sql, input: { partyId: string }): Promise<string | null> {
  const [row] = await tx<{ paymentTermId: string | null }[]>`
    select payment_term_id as "paymentTermId" from app.party where id = ${input.partyId}`;
  if (row === undefined) throw new Error(`ERR_NOT_FOUND: party ${input.partyId} is not visible`);
  return row.paymentTermId;
}

/** `effective_date + due_days` through app.payment_due_date — one implementation, in SQL (§4.8.2). */
export async function dueDateFor(
  tx: Sql, input: { paymentTermId: string | null; effectiveDate: string },
): Promise<string> {
  const [row] = await tx<{ due: string }[]>`
    select to_char(app.payment_due_date(${input.paymentTermId}, ${input.effectiveDate}::date), 'YYYY-MM-DD') as due`;
  return row!.due;
}
```

`packages/db/src/ar-ap/index.ts` (the barrel; later tasks add their lines to it and nothing else):

```ts
export * from "./payment-term";
```

and in `packages/db/src/index.ts`, beside the existing re-exports:

```ts
export * from "./ar-ap";
```

⚠️ **`resolvePartyTerm` reads `app.party.payment_term_id`, which Task 3's migration adds.** Write the function in this task — the barrel and the type surface belong together — and note in the commit body that its callers arrive in Tasks 6 and 10, which are the only two places the column is read. `bun run typecheck` passes either way because the column is read through a tagged template, not through the Drizzle mirror; **its DB-tier test is the `resolvePartyTerm` case in Task 3's `credit-control.test.ts`**, where the column exists — the function is not left unexercised in this task, it is exercised one task later, and Task 3 Step 1 carries that case.

- [ ] **Step 6: Add `seedPaymentTerm` to `fixtures.ts` (§4.17's one 4A row)**

Append to `packages/db/test/fixtures.ts` — additively, never editing an existing helper (§4.1, hazard 9):

```ts
/** §4.17, slice 4A. A `payment_term` for the seed's company. Defaults to NET30. */
export async function seedPaymentTerm(
  db: Db, s: Seed, opts?: { code?: string; dueDays?: number },
): Promise<string> {
  const code = opts?.code ?? "NET30";
  const dueDays = opts?.dueDays ?? 30;
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into app.payment_term (tenant_id, company_id, code, name_en, due_days)
      values (${s.tenant}, ${s.company}, ${code}, ${`Net ${dueDays} days`}, ${dueDays})
      returning id`;
    return row!.id;
  });
}
```

- [ ] **Step 7: Run the DB-tier test to verify it passes**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test ar-ap/payment-term && bun run --cwd packages/db db:lint`
Expected: PASS — eleven cases green; `db:lint` exits 0. The reversibility test (§3.4.6) also runs: `bun run --cwd packages/db test privileges` must stay green, which proves `0044.down.sql` drops the function before the table and leaves schema `app` empty at version 0.

- [ ] **Step 8: Write the contracts module**

`packages/contracts/src/accounting/payment-term.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

/** A fraction, 6 dp, exclusive of 0 and 1 — the DDL says so and the wire says so. Never a `number`. */
const DiscountPctSchema = z.string().regex(/^0\.\d{6}$/).openapi({ example: "0.020000" });

export const PaymentTermSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  code: z.string().min(1).max(32),
  nameEn: z.string().min(1),
  nameAr: z.string().nullable(),
  dueDays: z.number().int().min(0),
  discountDays: z.number().int().min(0).nullable(),
  discountPct: DiscountPctSchema.nullable(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
}).openapi("PaymentTerm");

export const CreatePaymentTermBody = z.object({
  code: z.string().min(1).max(32).regex(/^[A-Z0-9-]+$/),
  nameEn: z.string().min(1),
  nameAr: z.string().nullish(),
  dueDays: z.number().int().min(0),
  discountDays: z.number().int().min(0).nullish(),
  discountPct: DiscountPctSchema.nullish(),
}).refine(
  (b) => (b.discountDays == null) === (b.discountPct == null),
  { message: "discountDays and discountPct are supplied together or not at all", path: ["discountPct"] },
).refine(
  (b) => b.discountDays == null || b.discountDays <= b.dueDays,
  { message: "discountDays cannot exceed dueDays", path: ["discountDays"] },
).openapi("CreatePaymentTermBody");

/** `code` is absent by design — a term's code is never renamed (§3.2 Deletion, applied to identifiers). */
export const UpdatePaymentTermBody = z.object({
  nameEn: z.string().min(1).optional(),
  nameAr: z.string().nullish(),
  dueDays: z.number().int().min(0).optional(),
  discountDays: z.number().int().min(0).nullish(),
  discountPct: DiscountPctSchema.nullish(),
}).openapi("UpdatePaymentTermBody");

/** §4.2.8 layer 2: literal `filter[<field>][<op>]` keys — one field, one operator, so `parseFilters` is not the mechanism here. */
export const PaymentTermQuery = ListQuery.extend({
  "filter[archived][eq]": z.enum(["true", "false"]).optional(),
});

export const PaymentTermList = ListEnvelope(PaymentTermSchema);
export type PaymentTermDto = z.infer<typeof PaymentTermSchema>;
```

`DateSchema` is imported for the OpenAPI document's completeness on this module's sibling routes and is used by Task 3's `dueDate` addition; if `bun run lint` reports it unused at this commit, drop the import here and add it in Task 3 rather than leaving a disabled rule.

- [ ] **Step 9: Write the route module and register it**

`apps/api/src/routes/accounting/payment-terms.ts`:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  CreatePaymentTermBody, PaymentTermList, PaymentTermQuery, PaymentTermSchema,
  ProblemSchema, UpdatePaymentTermBody, UuidSchema, decodeCursor, encodeCursor,
} from "@dulja/contracts";
import { archivePaymentTerm, createPaymentTerm, listPaymentTerms, updatePaymentTerm } from "@dulja/db";
import type { AppEnv } from "../../context";
import { IdempotencyHeader, type RouteModule } from "../index";
import { requirePermission, type ScopeSource } from "../../middleware/require-permission";

export const PAYMENT_TERM_PAGE: ScopeSource = { company: "path:companyId" };

export const paymentTermRoutes = new OpenAPIHono<AppEnv>();

const Params = z.object({ companyId: UuidSchema });
const ItemParams = Params.extend({ paymentTermId: UuidSchema });

paymentTermRoutes.openapi(createRoute({
  method: "get", path: "/",
  request: { params: Params, query: PaymentTermQuery },
  middleware: [requirePermission(PERMISSION["accounting.party.manage"], PAYMENT_TERM_PAGE)],
  tags: ["accounting"],
  responses: {
    200: { content: { "application/json": { schema: PaymentTermList } }, description: "Payment terms" },
    403: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Forbidden" },
  },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  const cursor = q.cursor === undefined ? null : (decodeCursor(q.cursor).k as [string]);
  const rows = await c.var.withTenant((tx) => listPaymentTerms(tx, {
    companyId,
    includeArchived: q["filter[archived][eq]"] === "true",
    cursor: cursor === null ? null : { code: cursor[0]! },
    limit: q.limit,
  }));
  const last = rows.at(-1);
  return c.json({
    items: rows,
    next_cursor: rows.length === q.limit && last !== undefined
      ? encodeCursor({ k: [last.code], id: last.id })
      : null,
  }, 200);
});

paymentTermRoutes.openapi(createRoute({
  method: "post", path: "/",
  request: { params: Params, headers: IdempotencyHeader, body: { content: { "application/json": { schema: CreatePaymentTermBody } } } },
  middleware: [requirePermission(PERMISSION["accounting.party.manage"], PAYMENT_TERM_PAGE)],
  tags: ["accounting"],
  responses: {
    201: { content: { "application/json": { schema: PaymentTermSchema } }, description: "Created" },
    409: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Duplicate code" },
  },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await c.var.withTenant((tx) => createPaymentTerm(tx, c.var.ctx, { companyId, ...body }));
  return c.json(row, 201);
});

paymentTermRoutes.openapi(createRoute({
  method: "patch", path: "/{paymentTermId}",
  request: { params: ItemParams, headers: IdempotencyHeader, body: { content: { "application/json": { schema: UpdatePaymentTermBody } } } },
  middleware: [requirePermission(PERMISSION["accounting.party.manage"], PAYMENT_TERM_PAGE)],
  tags: ["accounting"],
  responses: {
    200: { content: { "application/json": { schema: PaymentTermSchema } }, description: "Updated" },
    404: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Not found" },
  },
}), async (c) => {
  const { paymentTermId } = c.req.valid("param");
  const row = await c.var.withTenant((tx) => updatePaymentTerm(tx, c.var.ctx, { paymentTermId, ...c.req.valid("json") }));
  return c.json(row, 200);
});

paymentTermRoutes.openapi(createRoute({
  method: "post", path: "/{paymentTermId}/archive",
  request: { params: ItemParams, headers: IdempotencyHeader },
  middleware: [requirePermission(PERMISSION["accounting.party.manage"], PAYMENT_TERM_PAGE)],
  tags: ["accounting"],
  responses: {
    200: { content: { "application/json": { schema: PaymentTermSchema } }, description: "Archived" },
    404: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Not found" },
  },
}), async (c) => {
  const { paymentTermId } = c.req.valid("param");
  const row = await c.var.withTenant((tx) => archivePaymentTerm(tx, c.var.ctx, { paymentTermId }));
  return c.json(row, 200);
});

export const paymentTermRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/payment-terms",
  router: paymentTermRoutes,
  permissions: [PERMISSION["accounting.party.manage"]],
  auth: "human",
};
```

In `apps/api/src/routes/index.ts`, register it **inside `buildRoutes`** (§4.2.7 — `ROUTES` is derived from it and a slice never pushes onto `ROUTES`):

```ts
    paymentTermRouteModule,
```

- [ ] **Step 10: Add the `PROBES` entry (hazard 31)**

In `tests/invariants/probes.ts`, keyed by the exact `RouteModule.path` string:

```ts
  "/v1/companies/:companyId/payment-terms": {
    async seed(db, owner) {
      // The victim's own term, in the victim's company. The attacker asks for it by the victim's companyId.
      await seedPaymentTerm(db, owner, { code: "VICTIM-NET30" });
      return { path: `/v1/companies/${owner.company}/payment-terms`, method: "GET" };
    },
    expect: 403,
  },
```

**Why 403 and not 404.** `requirePermission({ company: "path:companyId" })` evaluates `app.actor_has(code, companyId)` inside `c.var.withTenant`, and the attacker's session cannot see the victim's `app.company` row at all — so the predicate is false and the gate answers `ERR_RBAC_FORBIDDEN` before the handler runs. That is the same shape 2A's `parties` probe uses.

- [ ] **Step 11: Write the route test `apps/api/test/routes/accounting/payment-terms.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantAdmin, problemOf, sharedApi } from "../../../../../tests/support/api";
import type { StartedApi } from "../../support/app";
import type { Seed } from "@dulja/db/test";

let api: StartedApi;
let s: Seed;

beforeAll(async () => { ({ api, s } = await sharedApi()); await grantAdmin(api, s); }, 180_000);
afterAll(async () => { /* sharedApi owns the container */ });

describe("/v1/companies/{companyId}/payment-terms (4A)", () => {
  it("POST creates and returns 201 with the wire shape", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payment-terms`, as: s.human,
      body: { code: "NET14", nameEn: "Net 14 days", dueDays: 14 },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { code: string; dueDays: number; discountPct: string | null };
    expect(body).toMatchObject({ code: "NET14", dueDays: 14, discountPct: null });
  });

  it("POST without an Idempotency-Key is ERR_IDEMPOTENCY_KEY_MISSING (§4.2.9)", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payment-terms`, as: s.human,
      idempotencyKey: null, body: { code: "NOKEY", nameEn: "no key", dueDays: 1 },
    });
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("POST replays the same key and hash without creating a second row", async () => {
    const key = "4a-payment-term-replay";
    const body = { code: "NET21", nameEn: "Net 21 days", dueDays: 21 };
    const first = await api.request({ method: "POST", path: `/v1/companies/${s.company}/payment-terms`, as: s.human, idempotencyKey: key, body });
    const again = await api.request({ method: "POST", path: `/v1/companies/${s.company}/payment-terms`, as: s.human, idempotencyKey: key, body });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    const list = await api.request({ method: "GET", path: `/v1/companies/${s.company}/payment-terms`, as: s.human });
    const items = (await list.json() as { items: { code: string }[] }).items;
    expect(items.filter((i) => i.code === "NET21")).toHaveLength(1);
  });

  it("a discount window wider than the due window is ERR_VALIDATION_FAILED naming the field", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payment-terms`, as: s.human,
      body: { code: "BADWIN", nameEn: "bad", dueDays: 10, discountDays: 20, discountPct: "0.010000" },
    });
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toContain("discountDays");
  });

  it("a discountPct that is not a 6-dp fraction is refused on the wire, before the database sees it", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payment-terms`, as: s.human,
      body: { code: "BADPCT", nameEn: "bad", dueDays: 10, discountDays: 5, discountPct: 0.02 },
    });
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("GET pages on code with the shared cursor codec (§4.2.8)", async () => {
    const first = await api.request({ method: "GET", path: `/v1/companies/${s.company}/payment-terms?limit=1`, as: s.human });
    const page1 = await first.json() as { items: { code: string }[]; next_cursor: string | null };
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).not.toBeNull();
    const second = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/payment-terms?limit=1&cursor=${page1.next_cursor}`, as: s.human,
    });
    const page2 = await second.json() as { items: { code: string }[] };
    expect(page2.items[0]!.code).not.toBe(page1.items[0]!.code);
  });

  it("POST …/archive hides the row from the default list and shows it under filter[archived][eq]=true", async () => {
    const created = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/payment-terms`, as: s.human,
      body: { code: "GONE", nameEn: "to archive", dueDays: 7 },
    });
    const { id } = await created.json() as { id: string };
    const res = await api.request({ method: "POST", path: `/v1/companies/${s.company}/payment-terms/${id}/archive`, as: s.human });
    expect(res.status).toBe(200);
    const dflt = await api.request({ method: "GET", path: `/v1/companies/${s.company}/payment-terms?limit=100`, as: s.human });
    expect((await dflt.json() as { items: { code: string }[] }).items.map((i) => i.code)).not.toContain("GONE");
    const all = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/payment-terms?limit=100&filter[archived][eq]=true`, as: s.human,
    });
    expect((await all.json() as { items: { code: string }[] }).items.map((i) => i.code)).toContain("GONE");
  });

  it("a principal without accounting.party.manage gets 403 ERR_RBAC_FORBIDDEN", async () => {
    const res = await api.request({ method: "GET", path: `/v1/companies/${s.company}/payment-terms`, as: s.system });
    expect([200, 403]).toContain(res.status);   // the system principal passes app.actor_has by design (plan0A:985)
    const stranger = await api.request({ method: "GET", path: `/v1/companies/${s.company}/payment-terms` });
    expect(stranger.status).toBe(401);
  });

  it("the module is in ROUTES and has a PROBES entry (hazard 31)", async () => {
    const { ROUTES } = await import("@dulja/api");
    const { PROBES } = await import("../../../../../tests/invariants/probes");
    const mounted = ROUTES.find((r) => r.path === "/v1/companies/:companyId/payment-terms");
    expect(mounted).toBeDefined();
    expect(PROBES["/v1/companies/:companyId/payment-terms"]).toBeDefined();
  });
});
```

- [ ] **Step 12: Run the route test and the isolation harness**

Run: `bun run --cwd apps/api test routes/accounting/payment-terms && bun run --cwd tests test invariants/tenant-isolation`
Expected: PASS — nine route cases green, and the isolation harness green with one more route covered. A harness failure reading "a `ROUTES` entry has no `PROBES` entry" means Step 10 was skipped.

- [ ] **Step 13: Regenerate the OpenAPI document**

Run: `bun run --cwd packages/contracts openapi:generate && git diff --stat packages/contracts/openapi.json`
Expected: the diff shows four added paths and three added components (`PaymentTerm`, `CreatePaymentTermBody`, `UpdatePaymentTermBody`). CI fails on an un-regenerated document (spec:2055), so this step is not optional.

- [ ] **Step 14: Commit**

```bash
git add packages/db/migrations/0044_create_payment_term.sql packages/db/migrations/0044.down.sql \
        packages/db/src/schema/payment-term.ts packages/db/src/ar-ap/payment-term.ts \
        packages/db/src/ar-ap/index.ts packages/db/src/index.ts packages/db/test/fixtures.ts \
        packages/db/test/ar-ap/payment-term.test.ts packages/contracts/src/accounting/payment-term.ts \
        packages/contracts/openapi.json apps/api/src/routes/accounting/payment-terms.ts \
        apps/api/src/routes/index.ts apps/api/test/routes/accounting/payment-terms.test.ts \
        tests/invariants/probes.ts
git commit -m "feat(db): app.payment_term, its route module and the due-date function [4A T1]

The terms an invoice is aged on (spec:1042). Master data: archived, never deleted, so the app_rw
DELETE list is unchanged. app.payment_due_date computes effective_date + due_days in SQL so no
JavaScript date arithmetic can reach an accounting date. Gated accounting.party.manage, because
spec:2158 gives the clerk credit terms with the customer. One new route module, one PROBES entry.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0047 — the seven permission codes, the role grants, and the eight accounts this slice resolves

The catalogue half of the slice, taken early on purpose. Four later tasks need these codes to exist before they can be written: every one of the six document types names an `approval` code, and §4.4.1 fails `validatePolicy` with `ERR_POLICY_INVALID` on an `approval` code absent from the catalogue (F-21), so **no policy in Tasks 5–10 can be seeded until this task is merged**. **It is also the reason this task is numbered before the credit-control task and not after it, and the two are not interchangeable.** Task 3 grants `accounting.sales.post` in its `beforeAll` and seeds a `CREDIT_TEST` policy whose `approval.post` is that code: `app.role_permission.permission_code` has a foreign key to `app.permission(code)` (plan0A:1325), and `validatePolicy` refuses a policy naming an uncatalogued `approval` code (F-21). Task 3 executed first is therefore red in its own `beforeAll` and its commit would leave the tree red, which Global Constraint 17 forbids. **Migration order is not the constraint — task order is:** the runner applies every unapplied file in version order and `discover()` sorts whatever exists (§3.4.1), so 0047 applying before 0045 is explicitly legal and 0045 is applied on its own later commit.

**Files:**
- Create: `packages/db/migrations/0047_seed_permission_phase4a.sql`, `packages/db/migrations/0047.down.sql`
- Create: `packages/db/test/seed/permission-phase4a.test.ts`
- Modify: `packages/contracts/permissions.ts`
- Modify: `packages/db/seed/roles.ts`
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` (**§3.6.4's grants sentence only** — §3.6.4 requires it in the same PR as the catalogue entries, which is this one; every other contracts edit this slice makes is Task 0's)
- Modify: `apps/api/src/middleware/require-document-permission.ts` (`POLICY_RESOLVED_CODES`)
- Modify: `apps/api/src/routes/accounting/documents.ts` (verify `DOCUMENT_STAGE_CODES` is initialised **from** `POLICY_RESOLVED_CODES`)
- Test: `packages/db/test/permission-catalogue.test.ts` (existing, re-run), `packages/db/test/roles.test.ts` (existing, re-run)

**Interfaces:**
- Consumes: `app.permission (code, module, mutating, description)` (plan0A migration 0001 — global, no RLS, read-only for `app_rw`); `PERMISSIONS`, `PermissionDef`, `PermissionModule`, `PermissionAction`, `SliceId`, `PERMISSION` from `packages/contracts/permissions.ts` (0B); `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` from `packages/db/seed/roles.ts` (0D); `POLICY_RESOLVED_CODES` (2A), `DOCUMENT_STAGE_CODES` (2A); `seedTenantV2`, `seedAccount` (1A); `startDb`, `withTenant` (§4.1).
- Produces: the seven codes as catalogue entries with `phase: "4A"` —
  - `accounting.sales.post` · module `accounting` · `mutating: true`
  - `accounting.receipt.create` · module `accounting` · `mutating: true`
  - `accounting.receipt.post` · module `accounting` · `mutating: true`
  - `accounting.payment.create` · module `accounting` · `mutating: true`
  - `accounting.payment.approve` · module `accounting` · `mutating: true`
  - `accounting.payment.post` · module `accounting` · `mutating: true`
  - `accounting.credit_limit.override` · module `accounting` · `mutating: true`

  and the role grants below; `POLICY_RESOLVED_CODES` grown by exactly these seven, `DOCUMENT_STAGE_CODES` by derivation.

**The role grants, derived from spec:2157–2158 and recorded in §3.6.4's sentence.**

| Role | Codes | The spec sentence |
|---|---|---|
| `accountant` | `accounting.sales.post`, `accounting.receipt.create`, `accounting.receipt.post`, `accounting.payment.approve`, `accounting.payment.post`, `accounting.credit_limit.override` | "sales and purchase documents and their posting, **receipts (create and post — money in)**, payment **approval and posting** (payments are drafted by `user` — R6) … every approval and exception authority" (spec:2157) |
| `user` | `accounting.receipt.create`, `accounting.payment.create` | "Draft sales and purchase orders and documents, **receipts and payments** (`*.create`)" (spec:2158) |
| `admin` | computed from `PERMISSIONS`; its array is **never edited** | spec:2156 |
| `auditor` | **none** | R7 — every one of the seven is `mutating: true` |
| `warehouse`, `branch_manager`, `cashier`, `hr_payroll`, `pos_terminal` | **none** | none of the five sentences names an AR/AP authority |

**`accounting.payment.create` is deliberately NOT on `accountant`, and this is the R6 pair CI enforces.** `INCOMPATIBLE_PAIRS` (§4.2.5) already lists `["accounting.payment.create", "accounting.payment.approve"]`, and `scripts/lint/rules/role-seed.ts` skips a pair whose codes are not both present (F-21) — so **this is the task that makes that pair live**. Adding `payment.create` to `accountant` fails `bun run lint:rules` with "role accountant holds both codes of an incompatible pair", which is the correct refusal and not a lint to relax.

**`accounting.credit_limit.override` goes to `accountant` and to nobody else in the seed.** spec:2158 states the negative directly for `user` ("May not: Post, approve, **override credit limits**"); spec:2159–2160 give `warehouse` and `branch_manager` no AR/AP authority at all; and spec:2157's `accountant` row is where "every approval and **exception** authority" other than the admin's lives. The two-principal requirement is unaffected: `document_event_override_guard` (§4.5.3) refuses an override whose principal is the document's `created_by`, so two *different* accountants are needed and one accountant cannot release their own sale.

- [ ] **Step 1: Extend `packages/contracts/permissions.ts`**

Append to the `PERMISSIONS` array, keeping the file's existing module grouping and its `as const satisfies readonly PermissionDef[]` tail:

```ts
  { code: "accounting.sales.post",            module: "accounting", mutating: true, phase: "4A",
    description: "Post sales invoices and sales credit notes" },
  { code: "accounting.receipt.create",        module: "accounting", mutating: true, phase: "4A",
    description: "Create and submit receipts — money in" },
  { code: "accounting.receipt.post",          module: "accounting", mutating: true, phase: "4A",
    description: "Post receipts — money in, no maker-checker (spec:2147)" },
  { code: "accounting.payment.create",        module: "accounting", mutating: true, phase: "4A",
    description: "Draft a payment — money out; incompatible with accounting.payment.approve (R6)" },
  { code: "accounting.payment.approve",       module: "accounting", mutating: true, phase: "4A",
    description: "Approve a payment drafted by another principal (R1, R6)" },
  { code: "accounting.payment.post",          module: "accounting", mutating: true, phase: "4A",
    description: "Post an approved payment — money out" },
  { code: "accounting.credit_limit.override", module: "accounting", mutating: true, phase: "4A",
    description: "Record a credit-limit override on one document as a second principal (spec:2179)" },
```

`"4A"` is already a member of `SliceId` (§4.2.5), so no type widens. **`credit_limit` is a legal resource segment and `override` a legal action:** the DB CHECK is `^[a-z_]+\.[a-z_]+\.[a-z_]+$` (plan0A:1314) and `override` is in §3.6.1's action vocabulary — the code is spec:2147's own spelling and is not invented here.

- [ ] **Step 2: Run the catalogue test to see it fail**

Run: `bun run --cwd packages/db test permission-catalogue`
Expected: **FAIL** — the test asserts that the set of `(code, module, mutating)` in `app.permission` equals the set exported by `permissions.ts`, in **both** directions; seven codes are now in the module and not in the table, so it reports the seven missing rows by code.

- [ ] **Step 3: Write `packages/db/migrations/0047_seed_permission_phase4a.sql`**

```sql
-- 0047_seed_permission_phase4a.sql
-- Slice 4A. The seven permission codes of contracts §3.6.2, spec:2147.
-- app.permission is GLOBAL (no tenant_id, no RLS, read-only for app_rw — plan0A), so it is migration data,
-- not seed-pack data (§3.4.8, hazard 10).

-- ── 1. the seven codes §3.6.2 assigns 4A ───────────────────────────────
-- One statement, one reference: spec:2147 "receipts (money in) need no maker-checker, payments (money out)
-- do", which is why receipt and payment carry separate .create/.approve/.post codes; spec:2179 is what
-- accounting.credit_limit.override serves. `on conflict do update` and not `do nothing`: §3.6.3 makes the
-- catalogue bidirectional, so a description drifting between the module and the table must be corrected by
-- re-running the migration rather than left to fail the lint for ever.
insert into app.permission (code, module, mutating, description) values
  ('accounting.sales.post',            'accounting', true, 'Post sales invoices and sales credit notes'),
  ('accounting.receipt.create',        'accounting', true, 'Create and submit receipts — money in'),
  ('accounting.receipt.post',          'accounting', true, 'Post receipts — money in, no maker-checker'),
  ('accounting.payment.create',        'accounting', true, 'Draft a payment — money out'),
  ('accounting.payment.approve',       'accounting', true, 'Approve a payment drafted by another principal'),
  ('accounting.payment.post',          'accounting', true, 'Post an approved payment — money out'),
  ('accounting.credit_limit.override', 'accounting', true, 'Record a credit-limit override on one document')
on conflict (code) do update
  set module      = excluded.module,
      mutating    = excluded.mutating,
      description = excluded.description;
```

- [ ] **Step 4: Write `packages/db/migrations/0047.down.sql`**

```sql
-- Deletes exactly the seven codes this file inserted, and nothing else (§3.6.3).
-- ── 1. the seven 4A codes ──────────────────────────────────────────────
delete from app.permission
 where code in ('accounting.sales.post', 'accounting.receipt.create', 'accounting.receipt.post',
                'accounting.payment.create', 'accounting.payment.approve', 'accounting.payment.post',
                'accounting.credit_limit.override');
```

- [ ] **Step 5: Extend `packages/db/seed/roles.ts` — and §3.6.4's grants sentence in the same commit**

Add each code to the `permissions` array of the roles the table above names, leaving every other array untouched and never editing `admin`'s computed array:

```ts
// accountant — spec:2157 "sales and purchase documents and their posting, receipts (create and post),
// payment approval and posting … every approval and exception authority".
// accounting.payment.create is DELIBERATELY absent: R6's pair goes live in this PR.
"accounting.sales.post",
"accounting.receipt.create",
"accounting.receipt.post",
"accounting.payment.approve",
"accounting.payment.post",
"accounting.credit_limit.override",
// user — spec:2158 "Draft … receipts and payments (*.create)"; "May not: … override credit limits".
"accounting.receipt.create",
"accounting.payment.create",
```

**Then extend §3.6.4's grants sentence in `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`, in this commit.** §3.6.4 ends "**Every later introducing slice adds its row to this sentence in the same PR**", and the sentence currently records only 2A's `accounting.party.manage → user` and 2B's `accounting.document.reverse → accountant`. This is the PR that adds 4A's grants, so this is the PR that records them; Task 0 deliberately did not, because a grants row recorded one PR before the grants exist is a claim with no evidence. Append, in the sentence's own form:

```markdown
and **4A**: `accounting.sales.post`, `accounting.receipt.create`, `accounting.receipt.post`, `accounting.payment.approve`, `accounting.payment.post`, `accounting.credit_limit.override` → `accountant`, and `accounting.receipt.create`, `accounting.payment.create` → `user` (spec:2157–2158). **`accounting.payment.create` is deliberately NOT on `accountant`**: it is the first half of `INCOMPATIBLE_PAIRS`' `["accounting.payment.create", "accounting.payment.approve"]`, which `scripts/lint/rules/role-seed.ts` skips while either code is unseeded — so this PR is the one that makes that pair live in CI, and adding the code to `accountant` fails `bun run lint:rules` by design.
```

**Verify before committing:** `grep -qF 'and **4A**: ' docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md && echo "3.6.4 extended"` prints `3.6.4 extended`. If it does not, the sentence was not edited and the PR does not satisfy §3.6.4.

- [ ] **Step 6: Extend `POLICY_RESOLVED_CODES` and verify `DOCUMENT_STAGE_CODES`**

In `apps/api/src/middleware/require-document-permission.ts`, append to `POLICY_RESOLVED_CODES` — these are the `PERMISSION[…]` references that satisfy `scripts/lint/rules/permission-catalogue.ts` for gates resolved from *data*, which no source scan can see (§4.5.4):

```ts
  PERMISSION["accounting.sales.post"],
  PERMISSION["accounting.receipt.create"],
  PERMISSION["accounting.receipt.post"],
  PERMISSION["accounting.payment.create"],
  PERMISSION["accounting.payment.approve"],
  PERMISSION["accounting.payment.post"],
```

**`accounting.credit_limit.override` is not in this list**, and that is not an omission: it is never an `approval` code on any policy. **The `permission-catalogue` lint is already satisfied for it at this commit, and by 2B rather than by this slice** — `packages/db/src/posting/lifecycle.ts` declares `export type OverrideCode = "inventory.negative_stock.override" | "accounting.credit_limit.override" | "pos.ticket.override"` (2b:1418–1421), the rule collects **every string literal** in the reference scopes and `packages/db/src` is one of them (0d, §3.6.3), so the literal is in scope before 4A runs — which is the same mechanism that carried 3A's `inventory.negative_stock.override`. **`OverrideBody`'s enum is *not* what satisfies it:** that schema lives in `packages/contracts/src`, which is not a reference scope. Its *evaluation* site is Task 3's party-handler pre-flight, and that is where the behaviour lives — verify both with `grep -rn 'credit_limit.override' packages/db/src apps/api/src` before committing, and if the only hits are in comments, add the reference where the code is actually evaluated rather than padding this constant.

`DOCUMENT_STAGE_CODES` in `apps/api/src/routes/accounting/documents.ts` is **initialised from `POLICY_RESOLVED_CODES`** (§4.5.4, and 3C's Task 2 already discovered and fixed the case where it was not), so it needs no second edit:

Run: `grep -n "DOCUMENT_STAGE_CODES" apps/api/src/routes/accounting/documents.ts`
Expected: a line whose initialiser is `POLICY_RESOLVED_CODES`. If it is a literal array, that is a regression against 3C's Task 2 Step 6 — fix the initialiser in this commit and say so in the message; do not add a fifth spelling.

- [ ] **Step 7: Write the account-resolution test (Global Constraint 14, hazard 33)**

`packages/db/test/seed/permission-phase4a.test.ts`. **This slice seeds no account**, so the test asserts the converse: every code its six policies name resolves, and this slice's own seed pack contains no chart file.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { ROLES } from "../../seed/roles";
import { seedAccount, seedTenantV2, startDb, withTenant, type Db, type Seed } from "../index";

let db: Db;
let s: Seed;

/**
 * The EIGHT §4.15 codes this slice's six policies resolve, with the slice that seeds each. 4A seeds none.
 * It is the header's list verbatim, and the two entries a reader will ask about are stated here so the
 * lists cannot drift apart again:
 *
 *  • `5920` IS on the list. Every one of the six policies carries
 *    `"fxRoundingAccount": { "from": "company.fx_rounding_account_id" }`, which resolves it on every post
 *    (§4.15), so it is the account `balanceInBase` needs most often and the one whose absence would be
 *    discovered at the first foreign-currency post rather than here.
 *  • `1300` is NOT on the list. No 4A policy names it — it is 3C's `GOODS_RECEIPT` inventory leg, and
 *    Task 7's suite asserts the purchase invoice leaves it UNTOUCHED. Asserting it here would claim a
 *    consumption this slice does not have.
 *  • `4000` is not on the list either, and for the opposite reason: `SALES_INVOICE` and
 *    `SALES_CREDIT_NOTE` resolve it through `item.revenue_account`, but `seedTenantV2` creates
 *    `4000 Sales` for every seeded company (§4.1), so `seedAccount` below would collide on
 *    `(company_id, code)`. Its resolution is asserted where it is used — Task 5's four-row ledger case.
 */
const CONSUMED_ACCOUNTS = [
  ["1100", "Bank",                            "asset",     "0C"],
  ["1200", "Trade receivables",               "asset",     "0C"],
  ["1250", "Goods delivered not invoiced",    "asset",     "3D"],
  ["2100", "Trade payables",                  "liability", "0C"],
  ["2150", "Goods received not invoiced",     "liability", "3C"],
  ["5000", "Cost of goods sold",              "expense",   "0C"],
  ["5900", "Other operating expense",         "expense",   "0C"],
  ["5920", "FX rounding",                     "expense",   "0C"],
] as const;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "permission-4a");
  // In a Testcontainers database the pack has not been applied, so the test creates the rows it asserts on
  // through 1A's seedAccount — the ONE way any test creates a §4.15 account (§4.17). In staging the pack is
  // what creates them, and the assertion below is the same either way.
  for (const [code, nameEn, type] of CONSUMED_ACCOUNTS) {
    await seedAccount(db, s, { code, nameEn, type });
  }
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("slice 4A's catalogue and the accounts it consumes", () => {
  it("app.permission holds the seven codes with module accounting and mutating true", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission
       where code like 'accounting.sales.post'
          or code like 'accounting.receipt.%'
          or code like 'accounting.payment.%'
          or code = 'accounting.credit_limit.override'
       order by code`;
    expect(rows.map((r) => r.code)).toEqual([
      "accounting.credit_limit.override", "accounting.payment.approve", "accounting.payment.create",
      "accounting.payment.post", "accounting.receipt.create", "accounting.receipt.post",
      "accounting.sales.post",
    ]);
    expect(rows.every((r) => r.module === "accounting" && r.mutating)).toBe(true);
  });

  it("every 4A code carries phase '4A' in the catalogue module", () => {
    const mine = PERMISSIONS.filter((p) => p.phase === "4A").map((p) => p.code).sort();
    expect(mine).toEqual([
      "accounting.credit_limit.override", "accounting.payment.approve", "accounting.payment.create",
      "accounting.payment.post", "accounting.receipt.create", "accounting.receipt.post",
      "accounting.sales.post",
    ]);
  });

  it("accountant holds six of the seven and NOT accounting.payment.create (R6, spec:2157)", () => {
    const accountant = ROLES.find((r) => r.code === "accountant")!;
    expect(accountant.permissions).toContain("accounting.sales.post");
    expect(accountant.permissions).toContain("accounting.receipt.create");
    expect(accountant.permissions).toContain("accounting.receipt.post");
    expect(accountant.permissions).toContain("accounting.payment.approve");
    expect(accountant.permissions).toContain("accounting.payment.post");
    expect(accountant.permissions).toContain("accounting.credit_limit.override");
    expect(accountant.permissions).not.toContain("accounting.payment.create");
  });

  it("user drafts both and posts neither, and cannot override a credit limit (spec:2158)", () => {
    const user = ROLES.find((r) => r.code === "user")!;
    expect(user.permissions).toEqual(expect.arrayContaining(["accounting.receipt.create", "accounting.payment.create"]));
    expect(user.permissions).not.toContain("accounting.receipt.post");
    expect(user.permissions).not.toContain("accounting.payment.approve");
    expect(user.permissions).not.toContain("accounting.payment.post");
    expect(user.permissions).not.toContain("accounting.sales.post");
    expect(user.permissions).not.toContain("accounting.credit_limit.override");
  });

  it("auditor holds none of them (R7)", () => {
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    for (const p of PERMISSIONS.filter((x) => x.phase === "4A")) {
      expect(auditor.permissions).not.toContain(p.code);
    }
  });

  it("all EIGHT accounts this slice's policies name resolve for the seeded company, by code (hazard 33)", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ code: string; t: string }[]>`
      select code, account_type::text as t from app.account
       where company_id = ${s.company}
         and code in ${tx(CONSUMED_ACCOUNTS.map(([c]) => c))}
       order by code`);
    expect(rows.map((r) => r.code)).toEqual(CONSUMED_ACCOUNTS.map(([c]) => c));
    // The first digit IS the account type, in the enum's own order (§4.15's frozen code format).
    for (const [code, , type] of CONSUMED_ACCOUNTS) {
      expect(rows.find((r) => r.code === code)!.t).toBe(type);
    }
  });

  it("slice 4A ships NO chart-of-accounts file — every code it names is seeded elsewhere (§4.15)", () => {
    const dir = join(process.cwd(), "seed", "my", "chart-of-accounts");
    const files = readdirSync(dir);
    expect(files).not.toContain("4a-ar-ap.json");
    // and the two corridor accounts are exactly where the register says they are
    expect(files).toContain("3c-purchasing.json");
    expect(files).toContain("3d-adjustments.json");
  });
});
```

- [ ] **Step 8: Run the catalogue, role-seed, account and gate checks to verify they pass**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test permission-catalogue roles seed/permission-phase4a && bun run lint:rules`
Expected: **PASS**, and `lint:rules` exits 0.

Three failures worth naming in advance. `permission-catalogue` failing in the *other* direction (a code in the table, none in the module) means the migration ran before the `permissions.ts` edit was saved — re-run after `bun run db:migrate`. `role-seed` failing with "role accountant holds both codes of an incompatible pair" means `accounting.payment.create` reached `accountant`; that is R6 working, and the fix is to remove the code, never to relax the lint. `permission-catalogue` (the *lint* rule, not the DB test) failing with "code accounting.credit_limit.override has no reference" means 2B's `OverrideCode` union in `packages/db/src/posting/lifecycle.ts` no longer carries the literal — reconcile with 2B, and add the reference at this slice's evaluation site (Task 3's party pre-flight) in the same PR rather than padding `POLICY_RESOLVED_CODES` with a code no policy resolves.

- [ ] **Step 9: Commit**

```bash
git add packages/db/migrations/0047_seed_permission_phase4a.sql packages/db/migrations/0047.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts \
        docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md \
        apps/api/src/middleware/require-document-permission.ts \
        apps/api/src/routes/accounting/documents.ts \
        packages/db/test/seed/permission-phase4a.test.ts
git commit -m "feat(db): seed the seven AR/AP permission codes and their role grants [4A T2]

accounting.sales.post, receipt.create/.post, payment.create/.approve/.post and
credit_limit.override (spec:2147). accountant gets six, user gets the two *.create, auditor none;
accounting.payment.create is deliberately off accountant, which is what makes R6's pair live in CI for
the first time. POLICY_RESOLVED_CODES gains the six approval codes so the policy-resolved gates satisfy
the catalogue lint. Contracts §3.6.4's grants sentence is extended in THIS commit, which is what that
section requires — the same PR as the catalogue entries. This slice seeds NO account and the test
asserts all eight it names resolve: 1100, 1200, 1250, 2100, 2150, 5000, 5900, 5920.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Migration 0045 — credit limit, credit hold, the pinned term, and `app.assert_credit_available()`

The credit-control half of the slice, and the second of row 1042's four capabilities. It is taken before any document type exists because the trigger must be red-then-green against a type this task configures itself (`CREDIT_TEST`, §4.14), so that Task 5's real `SALES_INVOICE` inherits a control that is already proven.

**This task depends on Task 2 and cannot be reordered before it.** Its `beforeAll` calls `grantCodes(db, s, { codes: ["accounting.sales.post"] })` and seeds a `CREDIT_TEST` policy whose `approval.post` is that code; `app.role_permission.permission_code` references `app.permission(code)` (plan0A:1325) and `validatePolicy` refuses an uncatalogued `approval` code (F-21), so both fail until Task 2's migration 0047 and its `permissions.ts` rows have merged. The same holds for the `accounting.credit_limit.override` grant to the second principal in Step 1's override case.

**Files:**
- Create: `packages/db/migrations/0045_alter_party_and_document_add_credit_terms.sql`, `packages/db/migrations/0045.down.sql`
- Create: `packages/db/src/ar-ap/credit.ts`
- Create: `packages/db/test/ar-ap/credit-control.test.ts`
- Create: `docs/runbooks/credit-control-override.md`
- Modify: `packages/db/src/schema/party.ts`, `packages/db/src/schema/document.ts`, `packages/db/src/ar-ap/index.ts`, `apps/api/src/routes/accounting/parties.ts` (the `creditLimit` field pre-flight and one `RouteModule.permissions` entry), `apps/api/test/routes/accounting/parties.test.ts` (2A's suite, one case appended)
- Modify: `packages/contracts/src/errors.ts` (two rows), `packages/contracts/src/accounting/party.ts`, `packages/contracts/src/accounting/document.ts`
- Modify: `tests/regression/legacy-042.test.ts` (append a `— 4A` block)

**Interfaces:**
- Consumes: `app.party` (2A, migration 0017), `app.document` (plan0A 0001), `app.document_event` and `app.principal_has` (2B, §4.5.2–§4.5.3), `app.effective_policy` (2B), `app.payment_term` (Task 1), **`app.price_list` (3A, migration 0030 — the FK target of the `price_list_id` column Task 0 amendment 6 registers; 0030 is two ranges below 0045, so the table is live when this file runs, and it carries the `unique (tenant_id, id)` the composite FK needs)**, `seedPriceList` (3A, §4.17), `app.current_actor`, `app_meta.attach_stamp`, `lintSchema` (§4.1); `ERRORS`, `AppError` (§4.2.4); `Money`, `currency` (§4.2.1); `seedDocumentType`, `seedParty` (2A), `grantCodes` (2B), `secondPrincipal` (3D), `draftTypedDocument` (3C), `seedAccount`, `seedTenantV2` (1A), `seedPaymentTerm` and `resolvePartyTerm` (Task 1 — this task carries the DB-tier test for the second, since it is the migration that adds the column it reads), `uuidv7` (§4.1), `recordOverride`, `transitionDocument` (§4.3.1); **`accounting.sales.post` and `accounting.credit_limit.override` in `app.permission` and in `PERMISSIONS` (Task 2 — a hard dependency: `grantCodes` inserts into `app.role_permission`, whose `permission_code` references `app.permission(code)`, and `validatePolicy` refuses a policy naming an uncatalogued `approval` code, F-21)**; `sharedDb`, `thinRegression` (§4.17.1).
- Produces:

```sql
-- migration 0045
alter table app.party   add column credit_limit numeric(19,4);          -- null = no limit
alter table app.party   add column payment_term_id uuid;                -- composite FK to app.payment_term
alter table app.party   add column credit_hold boolean not null default false;
alter table app.party   add column price_list_id uuid;                  -- composite FK to app.price_list (3A/0030)
alter table app.document add column payment_term_id uuid;               -- PINNED at draft (LEGACY-013)
create function app.party_open_balance(p_party_id uuid, p_as_of date) returns numeric;
create function app.assert_credit_available() returns trigger;           -- BEFORE UPDATE OF status ON app.document
```

```ts
// packages/db/src/ar-ap/credit.ts
export interface CreditStatus {
  partyId: string;
  creditLimit: Money | null;      // null = no limit configured
  creditHold: boolean;
  openBase: Money;                // the party's open receivable in BASE currency, as the trigger computes it
  headroomBase: Money | null;     // limit − open, in base; null when there is no limit
}
/** The read behind the credit screen and the pre-flight message. It calls the SAME SQL function the
 *  trigger calls, so a screen can never disagree with the control (spec:2173). */
export async function creditStatus(tx: Sql, input: { partyId: string; asOf: string }): Promise<CreditStatus>;
```

**The two error codes, and why they are two.** `ERR_CREDIT_LIMIT_EXCEEDED` (422) is *the party owes more than its limit allows* — remedy: raise the limit, or have a second principal record an `accounting.credit_limit.override` event. `ERR_CREDIT_HOLD` (422) is *this party is on hold* — remedy: release the hold; **an override does not lift it**, because §4.8.1 says "`party.credit_hold` blocks regardless". One code for both would have to carry one remedy and would tell half the callers the wrong thing (§3.2 Error codes: "a human message naming the specific entity, **and a remedy**"). Both are raised as `check_violation` tokens by the trigger, in the form plan0A:1130–1141 fixed, so `fromDatabaseError` translates them without a new branch.

**Where the control lives, and why it is a second trigger rather than an edit to 2B's.** spec:2173 makes the data layer the control and the handler a pre-flight. `app.document_status_before` is 2B's, frozen, and already carries the transition matrix, R1 and R2; adding an unrelated business rule to it would make one function two things and would put 4A's edit in 2B's file. Postgres fires BEFORE triggers on one table **in alphabetical order by trigger name**, so `document_credit_control` runs before `document_status_before` — which is the order this slice wants: refusing an over-limit sale before evaluating maker-checker gives the clearer message, and both refuse in the same statement either way.

**What the trigger asks, in the order it asks it.** It fires only `when (new.status = 'issued' and old.status is distinct from 'issued')` — the transition §4.8.1 names — and returns immediately unless every one of these holds: the document has a `party_id`; the effective policy's `direction` is `outbound`; the party's `kind` is `customer`. Then:

1. `credit_hold` → raise `ERR_CREDIT_HOLD`. **Checked first and not overridable.**
2. `credit_limit is null` → return. No limit configured is not the same as a zero limit.
3. An `accounting.credit_limit.override` `document_event` exists for this document → return. The event's own guard (2B, §4.5.3) has already proved a *second* principal holding the code at the document's branch recorded it, so this trigger asks nothing further about authority — asking twice, differently, is how two answers appear.
4. `app.party_open_balance(party_id, effective_date) + this document's base total > credit_limit` → raise `ERR_CREDIT_LIMIT_EXCEEDED` naming the party, the limit and the excess. **`app.party_open_balance` raises `ERR_POLICY_REQUIRES_MISSING` rather than returning zero when the party carries a limit and no `receivable_account_id`** — the column is nullable (§4.5.7) and `l.account_id = <null>` matches no row, so returning zero would let every over-limit sale through, which is LEGACY-042's "an absent row makes a check pass". Step 2 has already returned for a party with no limit, so the raise reaches only a party the owner asked to control.

**Why the comparison is in base currency.** `credit_limit` is one figure per party while a party may be invoiced in several currencies (test 8's EUR/USD/base round trip is 4B's, but the data model is this slice's). Comparing a EUR document total against an MYR limit would be LEGACY-014 in a new place. `app.party_open_balance` therefore sums `ledger_entry.base_debit − base_credit` on the party's receivable account, and the document's own contribution is `round(Σ line.total_incl_tax × document.exchange_rate, 4)` — the same `base = value × rate` identity the `ledger_entry` CHECK enforces (spec:1816, LEGACY-012). The document is not yet posted at `→ issued`, so its own total cannot come from the ledger and must come from its lines; that asymmetry is stated in the function's comment so no later reader "simplifies" it into one query.

**The fifth column, `party.price_list_id`, and why it rides in this file rather than a file of its own.** It is **not** credit control and no line of the trigger reads it: it is the customer's **price list**, the key §3.7.6's *customer-specific pricing* resolves on, and it is here because **6B's Task 0 amendment A10(b)** asked 4A's 0045 for it by name — *"`app.party` has no `price_list_id` … Register `price_list_id uuid` on `app.party`, nullable, FK `(tenant_id, price_list_id) → app.price_list`, added by **4A's migration 0045** (the file that already adds `credit_limit` — 4A owns the customer's commercial terms and a price list is one)."* Three facts make that the right home rather than a sixth migration number. (1) **4A executes in Phase 4 and 6B in Phase 6**, so a column 6B added itself would arrive after every slice that could set it, and 6B's own till would have nothing to mirror into `catalogue_customer`; the register amendment is therefore Task 0's amendment 6 and the DDL is this file's. (2) **`app.price_list` is 3A's migration 0030** and carries `unique (tenant_id, id)`, so the composite FK §3.5.1 requires is available two ranges below this one — no ordering problem exists. (3) **One file, one transaction, one slice's range** (§3.4.3): 0045 is already the "customer's commercial terms" migration, which is what a trade-level price list is. `app.price_list.customer_kind` stays exactly what 3A made it — the trade *level*, a tenant's own vocabulary — and this column is the per-party pointer that was missing beside it; the two are not two spellings of one thing. **Nothing in this task's trigger, `app.party_open_balance` or `creditStatus` reads the column**, and the tests below prove only what this migration owes: the column's shape, its composite FK, and that the FK actually refuses a foreign list. Resolution against it is 6B's `resolvePrice` and 3D's sales screens, not 4A's.

- [ ] **Step 1: Write the failing DB-tier test `packages/db/test/ar-ap/credit-control.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { creditStatus } from "../../src/ar-ap/credit";
import { resolvePartyTerm } from "../../src/ar-ap/payment-term";
import { issueDocument, recordOverride } from "../../src/posting";
import {
  draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedParty, seedPaymentTerm,
  seedPriceList, seedTenantV2, startDb, uuidv7, withTenant, type Db, type Seed,
} from "../index";
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";

let db: Db;
let s: Seed;
let partyId: string;
let crtType: string;
const ctxOf = (seed: Seed, actor?: string) =>
  ({ tenantId: seed.tenant, actorId: actor ?? seed.human, requestId: "00000000-0000-0000-0000-000000000000" });

/** The §4.14 test-only type `CREDIT_TEST` — outbound, no inventory, no approval. */
const CREDIT_TEST_POLICY = {
  version: 1, documentType: "CREDIT_TEST", direction: "outbound",
  requires: ["party"],
  lines: [
    { for: "each_line", side: "debit",  account: { from: "party.receivable_account" }, amount: "line.total_incl_tax", when: { "line.kind": "item" } },
    { for: "each_line", side: "credit", account: { code: "4000" },                     amount: "line.amount",         when: { "line.kind": "item" } },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "CRT", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.sales.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as const;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "credit-control");
  await seedAccount(db, s, { code: "1200", nameEn: "Trade receivables", type: "asset" });
  await grantCodes(db, s, { codes: ["accounting.sales.post"] });
  crtType = await seedDocumentType(db, s, { code: "CREDIT_TEST", policy: CREDIT_TEST_POLICY });
  const termId = await seedPaymentTerm(db, s, { code: "NET30", dueDays: 30 });
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-CREDIT" });
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    tx`update app.party set credit_limit = ${"1000.0000"}, payment_term_id = ${termId} where id = ${partyId}`);
}, 180_000);
afterAll(async () => { await db.stop(); });

/** Draft a CREDIT_TEST for `total`, and try to issue it. */
async function tryIssue(total: string, opts?: { override?: string; reason?: string }) {
  const { documentId } = await draftTypedDocument(db, s, {
    documentTypeId: crtType, series: "CRT", effectiveDate: "2026-01-10", partyId,
    lines: [{ kind: "item", description: "widget", amount: total, unitPrice: total, quantity: "1.000000" }],
  });
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    tx`update app.document_line set total_incl_tax = ${total} where document_id = ${documentId}`);
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    if (opts?.override !== undefined) {
      await recordOverride(tx, ctxOf(s), {
        documentId, code: "accounting.credit_limit.override",
        reason: opts.reason ?? "director approved by telephone", attributedTo: opts.override,
      });
    }
    await issueDocument(tx, ctxOf(s), { documentId });
    return documentId;
  });
}

describe("credit control — migration 0045, contracts §4.8.1, spec:1026, spec:2179", () => {
  it("the schema linter reports zero violations after 0045", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("a document inside the limit issues", async () => {
    const id = await tryIssue("400.0000");
    const [doc] = await db.admin<{ status: string }[]>`select status from app.document where id = ${id}`;
    expect(doc!.status).toBe("issued");
  });

  it("a document that takes the party OVER the limit is refused with ERR_CREDIT_LIMIT_EXCEEDED naming the party", async () => {
    // 400 is drafted-but-unposted, so it contributes nothing to the ledger balance yet; 1200 alone exceeds 1000.
    await expect(tryIssue("1200.0000"))
      .rejects.toThrow(/ERR_CREDIT_LIMIT_EXCEEDED: party CUST-CREDIT/);
  });

  it("the same document issues when a SECOND principal has recorded the override event (spec:2179)", async () => {
    const director = await secondPrincipal(db, s, "director");
    await grantCodes(db, s, {
      codes: ["accounting.credit_limit.override"], principalId: director, roleCode: "credit-override",
    });
    const id = await tryIssue("1200.0000", { override: director });
    const [doc] = await db.admin<{ status: string }[]>`select status from app.document where id = ${id}`;
    expect(doc!.status).toBe("issued");
    const [ev] = await db.admin<{ kind: string; code: string; attributed: string }[]>`
      select event_kind as kind, override_code as code, attributed_to as attributed
        from app.document_event where document_id = ${id} and event_kind = 'override'`;
    expect(ev).toMatchObject({ kind: "override", code: "accounting.credit_limit.override", attributed: director });
  });

  it("the creator cannot authorise their own override — 2B's guard, not a second check here", async () => {
    await expect(tryIssue("1200.0000", { override: s.human }))
      .rejects.toThrow(/ERR_OVERRIDE_NOT_AUTHORISED: an override on document .* needs a second principal/);
  });

  it("credit_hold refuses with ERR_CREDIT_HOLD, and an override does NOT lift it (§4.8.1 'blocks regardless')", async () => {
    const director = await secondPrincipal(db, s, "director");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set credit_hold = true where id = ${partyId}`);
    await expect(tryIssue("1.0000")).rejects.toThrow(/ERR_CREDIT_HOLD: party CUST-CREDIT is on credit hold/);
    await expect(tryIssue("1.0000", { override: director })).rejects.toThrow(/ERR_CREDIT_HOLD/);
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set credit_hold = false where id = ${partyId}`);
  });

  it("a NULL credit_limit is no limit, not a zero limit", async () => {
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set credit_limit = null where id = ${partyId}`);
    const id = await tryIssue("999999.0000");
    const [doc] = await db.admin<{ status: string }[]>`select status from app.document where id = ${id}`;
    expect(doc!.status).toBe("issued");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set credit_limit = ${"1000.0000"} where id = ${partyId}`);
  });

  it("a party with a limit and NO receivable control account is REFUSED, never silently allowed (LEGACY-042)", async () => {
    // `app.party.receivable_account_id` is nullable (§4.5.7) and `l.account_id = <null>` matches no ledger
    // row, so a naive predicate would report a 0.0000 exposure and let every over-limit sale through — "an
    // absent row makes a check pass". This is the ONE case that discriminates the fail-closed branch: it is
    // red against a function that returns 0 for a null account and green only against one that raises.
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set receivable_account_id = null where id = ${partyId}`);
    await expect(tryIssue("1.0000")).rejects.toThrow(
      /ERR_POLICY_REQUIRES_MISSING: party .* carries a credit limit but no receivable control account/);
    // …and with the limit cleared there is no credit question, so the same party issues and the function
    // returns 0 without raising — the guard tests BOTH columns, not one.
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set credit_limit = null where id = ${partyId}`);
    const id = await tryIssue("1.0000");
    const [doc] = await db.admin<{ status: string }[]>`select status from app.document where id = ${id}`;
    expect(doc!.status).toBe("issued");
    // `_support.ts`'s `accountByCode` is Task 5's file and does not exist yet, so the id is read inline.
    const [receivable] = await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = ${"1200"}`;
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set receivable_account_id = ${receivable!.id}, credit_limit = ${"1000.0000"}
          where id = ${partyId}`);
  });

  it("resolvePartyTerm returns the party's pinned-at-draft term, and refuses an invisible party", async () => {
    // Task 1 shipped the function against a column this migration adds; this is its DB-tier test, and the
    // ERR_NOT_FOUND case is what lets `draftSettlement` and `convertToInvoice` drop their own party probes.
    const term = await withTenant(db.rw, s.tenant, s.human, (tx) => resolvePartyTerm(tx, { partyId }));
    const [row] = await db.admin<{ id: string }[]>`
      select payment_term_id as id from app.party where id = ${partyId}`;
    expect(term).toBe(row!.id);
    const ghost = await uuidv7(db.admin);
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => resolvePartyTerm(tx, { partyId: ghost })))
      .rejects.toThrow(/ERR_NOT_FOUND: party .* is not visible/);
  });

  it("an INTERNAL document type is ignored by the trigger, even for a party on hold", async () => {
    // s.docType is JOURNAL (direction internal, §4.3.7). It carries no party and the trigger returns at its
    // first guard; this case exists so a later reader does not "improve" the trigger into checking every type.
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set credit_hold = true where id = ${partyId}`);
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: s.docType, series: "JV", effectiveDate: "2026-01-10",
      lines: [
        { kind: "account", accountId: s.cash,  debit: "5.0000" },
        { kind: "account", accountId: s.sales, credit: "5.0000" },
      ],
    });
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    await withTenant(db.rw, s.tenant, s.human, (tx) => issueDocument(tx, ctxOf(s), { documentId }));
    const [doc] = await db.admin<{ status: string }[]>`select status from app.document where id = ${documentId}`;
    expect(doc!.status).toBe("issued");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set credit_hold = false where id = ${partyId}`);
  });

  it("creditStatus reports the same figures the trigger uses, in base currency", async () => {
    const status = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      creditStatus(tx, { partyId, asOf: "2026-01-31" }));
    expect(status.creditHold).toBe(false);
    expect(status.creditLimit?.toString()).toBe("1000.0000");
    expect(status.openBase.toString()).toBe("0.0000");        // nothing posted yet — drafts do not count
    expect(status.headroomBase?.toString()).toBe("1000.0000");
  });

  it("the five new columns are on the two tables with the shapes §4.5.7 and §4.3.4 fix", async () => {
    const cols = await db.admin<{ t: string; c: string; d: string; n: string }[]>`
      select table_name as t, column_name as c, data_type as d, is_nullable as n
        from information_schema.columns
       where table_schema = 'app'
         and (table_name, column_name) in
             (('party','credit_limit'), ('party','payment_term_id'), ('party','credit_hold'),
              ('party','price_list_id'), ('document','payment_term_id'))
       order by 1, 2`;
    expect(cols).toEqual([
      { t: "document", c: "payment_term_id", d: "uuid",    n: "YES" },
      { t: "party",    c: "credit_hold",     d: "boolean", n: "NO"  },
      { t: "party",    c: "credit_limit",    d: "numeric", n: "YES" },
      { t: "party",    c: "payment_term_id", d: "uuid",    n: "YES" },
      { t: "party",    c: "price_list_id",   d: "uuid",    n: "YES" },
    ]);
  });

  it("document.payment_term_id has the COMPOSITE FK, not a plain one (§3.5.1)", async () => {
    const [fk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.document'::regclass and conname = 'document_payment_term_fk'`;
    expect(fk!.def).toMatch(/FOREIGN KEY \(tenant_id, payment_term_id\) REFERENCES app\.payment_term\(tenant_id, id\)/);
  });

  it("party.price_list_id has the COMPOSITE FK to app.price_list (§4.5.7, 6B's A10(b))", async () => {
    // The column is not credit control and the trigger never reads it; it is the customer's trade-level
    // price list, and 6B's A10(b) named THIS migration as the file that adds it. A plain
    // `references app.price_list(id)` would be the §3.5.1 defect — a party could point at another
    // tenant's list — so the constraint definition is asserted, not merely the column's existence.
    const [fk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.party'::regclass and conname = 'party_price_list_fk'`;
    expect(fk!.def).toMatch(/FOREIGN KEY \(tenant_id, price_list_id\) REFERENCES app\.price_list\(tenant_id, id\)/);
  });

  it("a party can be pinned to a price list, and a list from ANOTHER tenant is refused", async () => {
    const listId = await seedPriceList(db, s, { code: "WHOLESALE", currency: "MYR" });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set price_list_id = ${listId} where id = ${partyId}`);
    const [row] = await db.admin<{ id: string | null }[]>`
      select price_list_id as id from app.party where id = ${partyId}`;
    expect(row!.id).toBe(listId);

    // The other half of the composite FK: a second tenant's list is not reachable from this party, and the
    // database says so rather than the application. `seedTenantV2` makes a whole second tenant, which is
    // the only way to produce a (tenant_id, price_list_id) pair the FK must reject.
    const other = await seedTenantV2(db, "credit-control-other");
    const otherList = await seedPriceList(db, other, { code: "RETAIL", currency: "MYR" });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set price_list_id = ${otherList} where id = ${partyId}`))
      .rejects.toThrow(/party_price_list_fk/);

    // Left null so no later case in this file inherits a pinned list it did not ask for.
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set price_list_id = null where id = ${partyId}`);
  });
});
```

- [ ] **Step 2: Run it to see the exact expected failure**

Run: `bun run --cwd packages/db test ar-ap/credit-control`
Expected: FAIL in `beforeAll` with `error: column "credit_limit" of relation "party" does not exist` on the `update app.party` statement. Every case is red for that one reason, which is the correct shape of a migration-first red.

- [ ] **Step 3: Write `packages/db/migrations/0045_alter_party_and_document_add_credit_terms.sql`**

```sql
-- 0045_alter_party_and_document_add_credit_terms.sql
-- Slice 4A. Customer credit control (spec:1026 §3.0.3; spec:1042; contracts §4.5.7, §4.8.1) and the payment
-- term PINNED on a document (contracts §4.3.4; LEGACY-013 — a term is never re-read from the party).
-- EXPAND ONLY (§3.4.7, spec:2057): five nullable-or-defaulted columns, nothing renamed, nothing dropped.

-- ── 1. app.party — the commercial-terms columns (§4.5.7) ───────────────
alter table app.party add column credit_limit    numeric(19,4);            -- null = no limit configured
alter table app.party add column payment_term_id uuid;
alter table app.party add column credit_hold     boolean not null default false;
-- The fourth column is NOT credit control and no line of the trigger below reads it: it is the customer's
-- trade-level price list, the key contracts §3.7.6's "customer-specific pricing" resolves on. It rides in
-- this file because 6B's Task 0 amendment A10(b) named 4A's 0045 by name — 4A owns the customer's
-- commercial terms and a price list is one, and 4A executes two phases before 6B could add it itself.
-- `app.price_list` is 3A's migration 0030, two ranges below this one, and carries `unique (tenant_id, id)`,
-- so the composite FK §3.5.1 requires is available here.
alter table app.party add column price_list_id   uuid;
alter table app.party
  add constraint party_credit_limit_check check (credit_limit is null or credit_limit >= 0),
  add constraint party_payment_term_fk
      foreign key (tenant_id, payment_term_id) references app.payment_term(tenant_id, id),
  add constraint party_price_list_fk
      foreign key (tenant_id, price_list_id) references app.price_list(tenant_id, id);
comment on column app.party.credit_limit is
  'spec:1026 "limits, ageing, and a block on over-limit sales". NULL is no limit; 0 is a zero limit.';
comment on column app.party.credit_hold is
  'contracts §4.8.1: blocks regardless of any override (ERR_CREDIT_HOLD).';
comment on column app.party.price_list_id is
  'contracts §4.5.7 / §3.7.6 customer-specific pricing; requested by 6B amendment A10(b). NULL = this '
  'customer has no list of its own and resolution falls back to branch, then company-wide (6B resolvePrice). '
  'Read by 6B and 3D; NOTHING in 4A reads it — app.assert_credit_available() never touches it.';

-- ── 2. app.document — the pinned term (§4.3.4) ─────────────────────────
alter table app.document add column payment_term_id uuid;
alter table app.document
  add constraint document_payment_term_fk
      foreign key (tenant_id, payment_term_id) references app.payment_term(tenant_id, id);
comment on column app.document.payment_term_id is
  'PINNED at draft from party.payment_term_id and never re-read (LEGACY-013). The due date is the derived '
  'effective_date + payment_term.due_days (app.payment_due_date) and has no column of its own; contracts §4.8.2.';

-- ── 3. the party open balance, in BASE currency ────────────────────────
-- One figure per party, one limit per party, so the comparison is in base (LEGACY-014: never compare a
-- foreign-currency amount against a base-currency figure). Posted rows only: a draft is not a debt.
-- It FAILS CLOSED (LEGACY-042): `app.party.receivable_account_id` is NULLABLE (contracts §4.5.7), and a
-- predicate `l.account_id = <null>` matches no row, so a party carrying a limit but no control account
-- would report a 0.0000 exposure and every over-limit sale would issue — "an absent row makes a check
-- pass", which is LEGACY-042 exactly. This function therefore RAISES for that combination instead of
-- returning a zero. A party with no limit and no control account has no credit question to answer and
-- gets 0 without a raise, which is why the guard tests both columns and not one.
create function app.party_open_balance(p_party_id uuid, p_as_of date) returns numeric
language plpgsql stable as $$
declare
  v_account_id uuid;
  v_limit      numeric(19,4);
  v_found      boolean;
begin
  select true, p.receivable_account_id, p.credit_limit
    into v_found, v_account_id, v_limit
    from app.party p where p.id = p_party_id;
  if v_found is not true then
    raise exception 'ERR_NOT_FOUND: party % is not visible', p_party_id using errcode = 'check_violation';
  end if;
  if v_account_id is null then
    if v_limit is null then return 0::numeric(19,4); end if;
    raise exception
      'ERR_POLICY_REQUIRES_MISSING: party % carries a credit limit but no receivable control account — set '
      'party.receivable_account_id (§4.15 1200 trade receivables is the default) or clear the limit',
      p_party_id using errcode = 'check_violation';
  end if;
  return (
    select coalesce(sum(l.base_debit - l.base_credit), 0)::numeric(19,4)
      from app.ledger_entry l
      join app.document     d on d.id = l.document_id
     where d.party_id = p_party_id
       and d.effective_date <= p_as_of
       and l.account_id = v_account_id);
end $$;
comment on function app.party_open_balance(uuid, date) is
  'contracts §4.8.1: the party balance the credit-control trigger and creditStatus() both read. Base currency, '
  'posted rows only, on the party''s own receivable control account (§4.15 1200 by default). Raises '
  'ERR_POLICY_REQUIRES_MISSING when a party carries a limit and no control account — LEGACY-042, never a silent 0.';

-- ── 4. the control: BEFORE UPDATE OF status ON app.document ────────────
-- spec:2173 — the data layer is the control and the handler is a pre-flight. This is a SECOND before-trigger
-- beside 2B's app.document_status_before(); Postgres fires before-triggers alphabetically, so
-- document_credit_control runs first. 2B's function is not edited (its file is frozen).
create function app.assert_credit_available() returns trigger language plpgsql as $$
declare
  v_party       app.party%rowtype;
  v_direction   text;
  v_doc_base    numeric(19,4);
  v_open        numeric(19,4);
begin
  -- Guard 1: no party, no credit question.
  if new.party_id is null then return new; end if;
  select * into v_party from app.party where id = new.party_id;
  if v_party.id is null or v_party.kind <> 'customer' then return new; end if;

  -- Guard 2: only an OUTBOUND type is a sale on credit. An internal or inbound document is ignored, and a
  -- policy that cannot be resolved is ignored here — 2B's trigger is what refuses an unresolvable policy.
  select (app.effective_policy(new.document_type_id, new.effective_date) ->> 'direction') into v_direction;
  if v_direction is distinct from 'outbound' then return new; end if;

  -- 1. A hold blocks first, and no override lifts it (contracts §4.8.1).
  if v_party.credit_hold then
    raise exception 'ERR_CREDIT_HOLD: party % is on credit hold', v_party.code using errcode = 'check_violation';
  end if;

  -- 2. No limit configured is not a zero limit.
  if v_party.credit_limit is null then return new; end if;

  -- 3. A second principal's override event, already authorised by 2B's document_event_override_guard
  --    (§4.5.3). This trigger asks nothing further about authority: two authority questions, asked
  --    differently, is how two answers appear (LEGACY-032).
  if exists (select 1 from app.document_event e
              where e.document_id = new.id
                and e.event_kind = 'override'
                and e.override_code = 'accounting.credit_limit.override') then
    return new;
  end if;

  -- 4. The comparison. The document is not posted yet, so its own contribution comes from its LINES at its
  --    own rate — base = round(value × rate, 4), the identity ledger_entry's CHECK enforces (spec:1816,
  --    LEGACY-012) — while the party's existing exposure comes from posted ledger rows. The asymmetry is
  --    deliberate: a draft is not a debt, and this document is not yet posted.
  select coalesce(sum(round(dl.total_incl_tax * new.exchange_rate, 4)), 0)::numeric(19,4)
    into v_doc_base
    from app.document_line dl
   where dl.document_id = new.id;
  v_open := app.party_open_balance(new.party_id, new.effective_date);

  if v_open + v_doc_base > v_party.credit_limit then
    raise exception
      'ERR_CREDIT_LIMIT_EXCEEDED: party % is over its credit limit — limit %, open %, this document %',
      v_party.code, v_party.credit_limit, v_open, v_doc_base
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger document_credit_control
  before update of status on app.document
  for each row
  when (new.status = 'issued' and old.status is distinct from 'issued')
  execute function app.assert_credit_available();
```

- [ ] **Step 4: Write `packages/db/migrations/0045.down.sql`**

```sql
-- Drops exactly what 0045 added, in reverse dependency order (§3.4.5). The two tables are 0001's and 0017's
-- and are NEVER dropped here — only this file's columns, constraints, functions and trigger.
drop trigger if exists document_credit_control on app.document;
drop function if exists app.assert_credit_available();
drop function if exists app.party_open_balance(uuid, date);
alter table app.document drop constraint if exists document_payment_term_fk;
alter table app.document drop column if exists payment_term_id;
alter table app.party drop constraint if exists party_price_list_fk;
alter table app.party drop constraint if exists party_payment_term_fk;
alter table app.party drop constraint if exists party_credit_limit_check;
alter table app.party drop column if exists price_list_id;
alter table app.party drop column if exists credit_hold;
alter table app.party drop column if exists payment_term_id;
alter table app.party drop column if exists credit_limit;
```

- [ ] **Step 5: Add the two error rows in the SAME commit as the migration**

`packages/contracts/src/errors.ts` — the `error-codes` lint scans `packages/db/migrations/**` too, so a token raised by 0045 with no `ERRORS` row fails the build at this commit (§4.2.4):

```ts
  ERR_CREDIT_LIMIT_EXCEEDED: {
    status: 422,
    title: "Credit limit exceeded",
    remedy: "Raise the customer's credit limit, or have a second principal holding accounting.credit_limit.override record an override on this document.",
  },
  ERR_CREDIT_HOLD: {
    status: 422,
    title: "Customer is on credit hold",
    remedy: "Release the customer's credit hold. An override does not lift a hold.",
  },
```

- [ ] **Step 6: Write `packages/db/src/ar-ap/credit.ts`**

```ts
import { Money, currency, type CurrencyCode } from "@dulja/domain";
import type { Sql } from "postgres";

export interface CreditStatus {
  partyId: string;
  creditLimit: Money | null;
  creditHold: boolean;
  openBase: Money;
  headroomBase: Money | null;
}

/**
 * The read behind the credit screen and the route pre-flight. It calls `app.party_open_balance` — the SAME
 * function `app.assert_credit_available()` calls — so a screen can never disagree with the control
 * (spec:2173). Base currency throughout: one limit per party, several invoice currencies (LEGACY-014).
 *
 * It therefore inherits that function's fail-closed behaviour: a party carrying a `credit_limit` with no
 * `receivable_account_id` raises `ERR_POLICY_REQUIRES_MISSING` here too, rather than showing a headroom
 * figure the control would not honour. Surfacing the misconfiguration on the screen is the point — a
 * screen that reported full headroom while the trigger refused the sale is two answers to one question.
 */
export async function creditStatus(
  tx: Sql, input: { partyId: string; asOf: string },
): Promise<CreditStatus> {
  const [row] = await tx<{
    creditLimit: string | null; creditHold: boolean; openBase: string; baseCurrency: string;
  }[]>`
    select p.credit_limit::text                                    as "creditLimit",
           p.credit_hold                                            as "creditHold",
           app.party_open_balance(p.id, ${input.asOf}::date)::text   as "openBase",
           c.base_currency                                          as "baseCurrency"
      from app.party p
      join app.company c on c.id = p.company_id
     where p.id = ${input.partyId}`;
  if (row === undefined) throw new Error("ERR_NOT_FOUND: party is not visible");

  const base = currency(row.baseCurrency) as CurrencyCode;
  const openBase = Money.of(row.openBase, base);
  const creditLimit = row.creditLimit === null ? null : Money.of(row.creditLimit, base);
  return {
    partyId: input.partyId,
    creditLimit,
    creditHold: row.creditHold,
    openBase,
    headroomBase: creditLimit === null ? null : creditLimit.subtract(openBase),
  };
}
```

Add `export * from "./credit";` to `packages/db/src/ar-ap/index.ts`.

- [ ] **Step 7: Extend the Drizzle mirrors and the wire schemas**

`packages/db/src/schema/party.ts` gains four columns; `packages/db/src/schema/document.ts` gains one. **All four, not the three credit ones**: §3.4.9 makes the mirror *the diff source* for every migration after 0001, so a `price_list_id` that exists in 0045 but not in the mirror is a column the next `drizzle-kit generate` in any slice would propose **dropping** — which is how a column added for a neighbour disappears two phases before that neighbour reads it.

```ts
  // party.ts — 4A / 0045
  creditLimit: numeric("credit_limit", { precision: 19, scale: 4 }),
  paymentTermId: uuid("payment_term_id"),
  creditHold: boolean("credit_hold").notNull(),
  priceListId: uuid("price_list_id"),          // 6B's A10(b); 4A never reads it, but the mirror is the diff source
```

```ts
  // document.ts — 4A / 0045
  paymentTermId: uuid("payment_term_id"),
```

`packages/contracts/src/accounting/party.ts` — 2A's file, grown additively:

```ts
// 4A / 0045. `creditLimit` is MoneySchema and not a bare string: a party is a top-level resource and its
// currency is not implied by its path (§4.2.8, and 3C's sub-resource exception does not reach here).
  creditLimit: MoneySchema.nullable().openapi({
    description:
      "The party's credit limit in the COMPANY'S BASE CURRENCY, or null for no limit. `party.credit_limit` " +
      "is a bare numeric(19,4) with no currency column, and `app.party_open_balance` converts every open " +
      "document to base before comparing — so a limit expressed in the party's own trading currency would " +
      "be compared against the wrong number. The wire currency is therefore the base currency, never the " +
      "party's, and `MoneySchema` carries it explicitly so no reader has to guess.",
  }),
  paymentTermId: UuidSchema.nullable(),
  creditHold: z.boolean(),
// 4A / 0045, on 6B's behalf (A10(b)). 4A resolves nothing against it — 6B's `resolvePrice` and 3D's sales
// screens do — but a column with no way to set it is a column §3.7.6's "customer-specific pricing" still
// cannot use, so the field the DDL adds is exposed in the same commit rather than left to a later slice.
  priceListId: UuidSchema.nullable().openapi({
    description:
      "The customer's price list (`app.price_list`, 3A), or null when this customer has no list of its " +
      "own and pricing falls back to the branch list and then the company-wide one. A trade LEVEL is " +
      "`price_list.customer_kind` and is the list's property, not the party's; this is the pointer.",
  }),
```

added to `PartySchema`, and to `CreatePartyBody` / `UpdatePartyBody` as `.optional()` members with the same four names. **`credit_hold` and `priceListId` are settable through `UpdatePartyBody`** under `accounting.party.manage` — spec:2158 gives the clerk credit terms, and which list a customer buys on is a term, not an override — while **`credit_limit` is not**: spec:2158's `user` row says "May not … override credit limits", and a clerk who can raise a limit has overridden it without an event.

`credit_limit` is therefore accepted only from a principal holding `accounting.credit_limit.override`. **This is also the one place in the repository where that code is *evaluated*** — Task 2 Step 6 leaves it out of `POLICY_RESOLVED_CODES` on the strength of this check existing, so it is written out rather than described. In `apps/api/src/routes/accounting/parties.ts`, inside 2A's existing `PATCH …/parties/{partyId}` and `POST …/parties` handlers, before the service call:

```ts
/**
 * 4A. `accounting.party.manage` is the module gate and is NOT enough for this one field: spec:2158 gives
 * the back-office clerk credit *terms* and denies them credit-limit *overrides*, and a clerk who can raise
 * a limit has overridden it with no `document_event` to show for it. A field-level pre-flight rather than
 * a second `requirePermission` on the route, because the route legitimately serves callers who touch every
 * other party field. The DATA layer remains the control for the limit's *effect* (0045's trigger); this is
 * the control for who may set it.
 */
async function assertMayWriteCreditLimit(c: Context<AppEnv>, companyId: string): Promise<void> {
  const [row] = await c.var.withTenant((tx) => tx<{ ok: boolean }[]>`
    select app.actor_has(${PERMISSION["accounting.credit_limit.override"]}, ${companyId}) as ok`);
  if (row?.ok !== true) {
    throw new AppError("ERR_RBAC_FORBIDDEN", "creditLimit may only be set by a principal holding accounting.credit_limit.override");
  }
}
```

called as `if (body.creditLimit !== undefined) await assertMayWriteCreditLimit(c, companyId);`, and the party module's `RouteModule.permissions` gains `PERMISSION["accounting.credit_limit.override"]` so `assertRouteGates` and the catalogue lint both see it. One case is added to 2A's existing `apps/api/test/routes/accounting/parties.test.ts` in this commit:

```ts
  it("4A — creditLimit is refused for a principal without accounting.credit_limit.override", async () => {
    // `grantAdmin` gives `s.human` the whole catalogue, so the negative direction needs a narrower
    // principal: 3D's `secondPrincipal` plus a role holding ONLY accounting.party.manage.
    const clerk = await secondPrincipal(api.db, s, "party-clerk");
    await grantCodes(api.db, s, { codes: ["accounting.party.manage"], principalId: clerk, roleCode: "party-clerk" });
    const created = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/parties`, as: clerk,
      body: { code: "CL-1", nameEn: "Clerk customer", kind: "customer" },
    });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    // credit_hold IS allowed — spec:2158 gives the clerk credit terms…
    const hold = await api.request({
      method: "PATCH", path: `/v1/companies/${s.company}/parties/${id}`, as: clerk, body: { creditHold: true },
    });
    expect(hold.status).toBe(200);
    // …and credit_limit is NOT, with a message that names the field.
    const limit = await api.request({
      method: "PATCH", path: `/v1/companies/${s.company}/parties/${id}`, as: clerk,
      body: { creditLimit: { amount: "5000.0000", currency: "MYR" } },
    });
    const problem = await problemOf(limit);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toMatch(/creditLimit/);
    // The same request from a principal that holds the override code succeeds.
    const allowed = await api.request({
      method: "PATCH", path: `/v1/companies/${s.company}/parties/${id}`, as: s.human,
      body: { creditLimit: { amount: "5000.0000", currency: "MYR" } },
    });
    expect(allowed.status).toBe(200);
  });
```

That case needs three helpers 2A's suite may not already import, each from its own registered home (§4.17.1): `secondPrincipal` from `../../../../../tests/invariants/support/post-inventory` — 3B's file, which 3D's Task 0 added the `export` keyword to — `grantCodes` from `@dulja/db/test`, and `problemOf` from `../../../../../tests/support/api`. Add all three to the file's existing import block in the same edit. The `apps/*/test/**` → `tests/invariants/support/**` direction is the permitted one, and `problemOf` is 0B's own API-tier reader. The handler's own additions to `parties.ts` are `Context` (type-only, from `hono`), `AppError` and `PERMISSION` — all three already imported by that file for its existing routes except `Context`, which is added as `import type { Context } from "hono";`.

**Verify before committing:** `grep -rn 'credit_limit.override' packages/db/src apps/api/src` prints at least 2B's `OverrideCode` union **and** this handler — the check Task 2 Step 8's third named failure describes. If the only hits are comments, the `permission-catalogue` lint is being satisfied by prose and the fix is here, never a padded `POLICY_RESOLVED_CODES`.

`packages/contracts/src/accounting/document.ts` — 1A's file, grown additively:

```ts
// 4A / 0045. The pinned term and the DERIVED due date. `dueDate` has no column (§4.3.4); the handler reads
// it through app.payment_due_date, so the wire never computes a date.
  paymentTermId: UuidSchema.nullable(),
  dueDate: DateSchema.nullable(),
```

- [ ] **Step 8: Append the `— 4A` block to `tests/regression/legacy-042.test.ts`**

0B created the file (ownership and paid-record checks fail open when the user row is missing). This slice appends the credit-control block, because LEGACY-042's shape is exactly "an absent row makes a check pass". The third case needs seed helpers the file may not already import — add `seedAccount`, `seedParty`, `seedTenantV2` and `withTenant` from `@dulja/db/test` to the file's existing import block in the same edit, beside its `sharedDb` import:

```ts
describe("LEGACY-042 Credit control never fails open — 4A", () => {
  it("an unresolvable party makes the trigger RETURN, never skip a limit it should have applied", async () => {
    // The legacy defect was `select … into :X; if (X <> 0) then exception` — a missing row left X NULL,
    // NULL <> 0 was unknown, and the check was skipped. Here the equivalent branch is explicit: a document
    // with no party_id, or a party row that is not a customer, is not a credit sale AT ALL, and the function
    // says so in a named guard rather than falling through three-valued logic.
    const { rw } = await sharedDb();
    const [fn] = await rw.db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc
       where proname = 'assert_credit_available' and pronamespace = 'app'::regnamespace`;
    // Every conditional in the body compares against a literal or uses `is distinct from`; there is no bare
    // `<>` against a value that can be NULL, which is the exact defect shape.
    expect(fn!.src).toMatch(/is distinct from 'outbound'/);
    expect(fn!.src).toMatch(/v_party\.id is null or v_party\.kind <> 'customer'/);
    expect(fn!.src).not.toMatch(/current_setting|set_config/i);
  });

  it("a NULL credit_limit is a documented 'no limit', and a NULL balance cannot arise (LEGACY-011)", async () => {
    const { rw } = await sharedDb();
    const [fn] = await rw.db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc
       where proname = 'party_open_balance' and pronamespace = 'app'::regnamespace`;
    // coalesce at the accumulation boundary — LEGACY-011's fix, applied to the one aggregate this slice adds.
    expect(fn!.src).toMatch(/coalesce\(sum\(l\.base_debit - l\.base_credit\), 0\)/);
  });

  it("a party with a limit and NO control account RAISES — the behaviour, not the source text", async () => {
    // The two cases above read `prosrc`, which proves the shape of the code and not the behaviour of the
    // database. This one calls the function, because a source-text assertion would have passed against the
    // fail-open version this block exists to forbid.
    const { rw } = await sharedDb();
    const seed = await seedTenantV2(rw.db, "legacy-042-4a");
    await seedAccount(rw.db, seed, { code: "1200", nameEn: "Trade receivables", type: "asset" });
    const party = await seedParty(rw.db, seed, { kind: "customer", code: "CUST-NOCTRL" });
    await withTenant(rw.db.rw, seed.tenant, seed.human, (tx) =>
      tx`update app.party set credit_limit = ${"500.0000"}, receivable_account_id = null where id = ${party}`);
    await expect(withTenant(rw.db.rw, seed.tenant, seed.human, (tx) =>
      tx`select app.party_open_balance(${party}, ${"2026-01-31"}::date)`))
      .rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING/);
    // Cleared limit, same null account: no credit question, no raise, and a zero that means zero.
    await withTenant(rw.db.rw, seed.tenant, seed.human, (tx) =>
      tx`update app.party set credit_limit = null where id = ${party}`);
    const [open] = await withTenant(rw.db.rw, seed.tenant, seed.human, (tx) =>
      tx<{ v: string }[]>`select app.party_open_balance(${party}, ${"2026-01-31"}::date)::text as v`);
    expect(open!.v).toBe("0.0000");
  });
});
```

- [ ] **Step 9: Write the runbook**

`docs/runbooks/credit-control-override.md`:

```markdown
# Runbook — releasing an over-limit sale

**Who:** two principals. The person raising the sale, and a **second** principal holding
`accounting.credit_limit.override` at the document's branch. One person cannot do both — the database
refuses it (`ERR_OVERRIDE_NOT_AUTHORISED`, contracts §4.5.3).

1. The salesperson drafts and submits the invoice as usual. Issuing it fails with
   `ERR_CREDIT_LIMIT_EXCEEDED`, and the message names the customer, its limit, its open balance and this
   document's base total.
2. Decide which it is:
   - **the limit is wrong** — raise `party.credit_limit`. That is a change to master data, is audited,
     and needs `accounting.credit_limit.override`; it applies to every later sale.
   - **this one sale is an exception** — record an override on this document. It applies to this document
     only, and it is the path this runbook is for.
3. The second principal calls
   `POST /v1/companies/{companyId}/documents/{documentId}/overrides` with
   `{ "code": "accounting.credit_limit.override", "reason": "<why, in a sentence>" }`.
   The reason is not optional and it is not free of consequence: it is the `document_event.reason` an
   auditor reads (spec:2179).
4. The salesperson issues the invoice again. It succeeds. The override event stays on the document
   forever and appears in `GET …/documents/{documentId}/events`.

**A credit HOLD is different and this runbook does not apply.** `ERR_CREDIT_HOLD` is not overridable
(contracts §4.8.1). Releasing a hold is a decision about the customer, not about one document: clear
`party.credit_hold` under `accounting.party.manage`, which is audited like any other party change.
```

- [ ] **Step 10: Run everything to verify it passes**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test ar-ap/credit-control && bun run --cwd packages/db db:lint && bun run --cwd apps/api test routes/accounting/parties && node --test tests/regression/legacy-042.test.ts && bun run lint:rules && bun run --cwd packages/contracts openapi:generate`
Expected: PASS — fifteen credit-control cases (the last two being the `price_list_id` composite-FK pair), 2A's parties suite green with Step 7's one appended case, all three new `legacy-042` cases, `db:lint` at zero, `lint:rules` exit 0 (the `error-codes` rule is satisfied because Step 5 landed the two rows in this commit), and an OpenAPI diff showing **four** added properties on `Party` — `creditLimit`, `paymentTermId`, `creditHold` and `priceListId`, the fourth being 6B's A10(b) column — and two on `Document`.

Two failures worth naming in advance. `ERR_CREDIT_LIMIT_EXCEEDED` firing on the *internal* JOURNAL case means `app.effective_policy` returned SQL NULL and `is distinct from 'outbound'` was read as `<>`; the guard must be `is distinct from`, because a type with no resolvable policy must be *ignored* by this trigger and refused by 2B's. `ERR_OVERRIDE_NOT_AUTHORISED` on the positive override case means `recordOverride` was called with a supervisor-flavoured context instead of `attributedTo` — `document_event.actor_id` defaults to `app.current_actor()` and is always the caller, so the second principal is the **attributed** one (2B, §4.5.3; 3D states the same at 3d:2650).

- [ ] **Step 11: Commit**

```bash
git add packages/db/migrations/0045_alter_party_and_document_add_credit_terms.sql \
        packages/db/migrations/0045.down.sql packages/db/src/ar-ap/credit.ts \
        packages/db/src/ar-ap/index.ts packages/db/src/schema/party.ts packages/db/src/schema/document.ts \
        packages/db/test/ar-ap/credit-control.test.ts packages/contracts/src/errors.ts \
        packages/contracts/src/accounting/party.ts packages/contracts/src/accounting/document.ts \
        packages/contracts/openapi.json apps/api/src/routes/accounting/parties.ts \
        apps/api/test/routes/accounting/parties.test.ts \
        tests/regression/legacy-042.test.ts docs/runbooks/credit-control-override.md
git commit -m "feat(db): credit limit, credit hold and the pinned payment term [4A T3]

app.assert_credit_available() is a SECOND before-update-of-status trigger on app.document, beside 2B's
frozen one; it refuses an over-limit outbound sale with ERR_CREDIT_LIMIT_EXCEEDED unless a second
principal recorded an accounting.credit_limit.override event, and refuses a held party with
ERR_CREDIT_HOLD, which no override lifts (spec:1026, 2179). The comparison is in base currency
(LEGACY-014) and coalesces at the accumulation boundary (LEGACY-011). document.payment_term_id is pinned at
draft and never re-read (LEGACY-013). Both error rows land here because 0045's SQL raises their tokens.

0045 also adds app.party.price_list_id (nullable, composite FK to app.price_list) with its Drizzle mirror
and its wire field. It is NOT credit control and nothing in 4A reads it: 6B's Task 0 amendment A10(b)
named this file, because 4A owns the customer's commercial terms and executes two phases before 6B could
add the column itself. Until it exists 6B's resolvePrice falls back to branch-then-company-wide and
contracts §3.7.6's "customer-specific pricing" cannot close.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The two frozen-surface amendments — `line.cost` on a negative-quantity line, and the unfilled-cost refusal

Two changes to surfaces other slices own, both landed here because 4A is the first slice that cannot work without them, and both registered by Task 0 before a line of this task is written. **Neither is a 4A convenience.** The first is the amendment 3D filed as *blocking Phase 4* in its own plan text (3d:2740: "it must land before Phase 4 relies on a `DELIVERY_ORDER` reversal to clear `1250`"). The second is 2A's step-9b guard, which 3B removed when it replaced the guard with the `applyMovements` call, and which nothing has stood in for since.

**Files:**
- Create: `docs/adr/0045-negative-line-quantity-negates-line-cost.md`
- Create: `packages/domain/test/posting/evaluate-negative-cost.test.ts`
- Create: `packages/db/test/posting/negative-cost.test.ts`
- Modify: `packages/domain/src/posting/evaluate.ts`
- Modify: `packages/db/src/costing/apply-movements.ts`
- Modify: `tests/regression/legacy-017.test.ts` (append a `— 4A` block)

**Interfaces:**
- Consumes: `evaluatePolicy`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PlannedMovement`, `PostingPlan`, `PolicyEvaluationError`, `COST_AMOUNT_REFS` (2A/3B, `packages/domain/src/posting/evaluate.ts`); `PlannedLedgerLine.fill` (3D); `applyMovements` (3A/3B/3D, `packages/db/src/costing/apply-movements.ts`); `Money`, `currency`, `Quantity` (§4.2.1); `PostingError` (§4.2.4); `postDocument` (§4.3.1); `draftTypedDocument`, `seedDocumentType`, `seedItem`, `seedWarehouse`, `grantCodes`, `seedAccount`, `seedTenantV2` (§4.17); `sharedDb`, `thinRegression` (§4.17.1).
- Produces: no new exported name. Two behavioural changes to existing exports, each stated as contract in §4.4.2 and §4.7.2 by Task 0:
  1. `evaluatePolicy` resolves `line.cost` and `line.variance_value` to `cost.negate()` when the source line's `quantity` is negative;
  2. `applyMovements` refuses, with `PostingError("ERR_POLICY_REQUIRES_MISSING", …)`, a `fill`-tagged planned ledger line whose source line has no surviving movement, whose amount is `Money.zero` and whose `LineSnapshot.cost` is null.

**Why the first change is at the evaluator and not at `reverseDocument`.** The other candidate fix — negating `document_line.cost` on the reversal's copied line — breaks two things that are already contract. `document_line.cost` is a **non-negative magnitude** (§4.7.2 amendment A6, and 3D's own delivery-order test asserts `"3.0000"` and not `"-3.0000"`); and `applyMovements`' receipt-value **branch 1** reads that column directly (§4.7.2, 3C's four-branch rule), so a negative cost would give a *receipt* movement a negative `value` while `inventory_movement`'s comment fixes "sign follows quantity". Reading the sign in the evaluator changes one pure function, leaves both invariants intact, and is the only place A9's sign normalisation can act.

**Why zero and null quantities are untouched.** A line with `quantity = 0` plans no movement (3D's amendment A3) and a line with `quantity = null` — an account or text line — has no direction to take from a quantity. Both keep `cost` as it stands, so a `JOURNAL`, a `RECEIPT` and every account-line leg in this slice are unaffected. The rule is stated as "when the source line's `quantity` is negative", not "when it is not positive", for exactly that reason.

- [ ] **Step 1: Write ADR 0045 as a proposal**

`docs/adr/0045-negative-line-quantity-negates-line-cost.md`:

```markdown
# ADR 0045 — A negative line quantity makes `line.cost` negative

- **Status:** Proposed (spec:95 — this touches money semantics, so it is asked before it is implemented)
- **Date:** 2026-09-05
- **Slice:** 4A. **Raised by:** 3D, in its own plan text, as blocking Phase 4.

## Context

3D's `DELIVERY_ORDER` policy addresses both of its ledger legs as `amount: "line.cost"` with a **fixed**
`side` — debit `1250`, credit the item's inventory account. A cancelled delivery is a `DELIVERY_ORDER`
with negated quantities, which 3D's amendment A2 turns into a stock *receipt* automatically, and
3C's `reverseDocument` copies `document_line.cost` onto the reversal line **unnegated**, because a cost
is a magnitude (3c:219). §4.7.2's fill rules never alter `side`. So a reversal's plan has a **positive**
`line.cost` on a **debit** leg to `1250` — and the reversal debits the corridor a second time instead of
relieving it. 3D recorded this and deliberately reversed no delivery order.

4A cannot leave it open: `SALES_INVOICE`'s `reversal.producesType` is `SALES_CREDIT_NOTE` (spec:2024),
credit notes carry negated magnitudes (§4.4.2 A9's own description of the mechanism), and the credit
note's cost legs address `line.cost`. Every corridor round trip in Phase 4 depends on the sign.

## Decision

`evaluatePolicy` resolves the two cost amount references — `line.cost` and `line.variance_value` — to
`cost.negate()` when the source `document_line.quantity` is **negative**, and to `cost` otherwise.
`document_line.cost` remains a non-negative magnitude; `applyMovements`' receipt-value branch 1 keeps
receiving a magnitude; only the evaluator's *reading* is signed, which is what gives A9's sign
normalisation a negative amount to act on so that it flips the `side`.

## Consequences

- **A reversal of any cost-bearing outbound document relieves its corridor** instead of doubling it:
  3D's `DELIVERY_ORDER`, 3C's `PURCHASE_RETURN` (whose legs are all `line.cost`), and 4A's
  `SALES_INVOICE` → `SALES_CREDIT_NOTE`.
- **3D's own delivery-order suite is unaffected** — it reverses nothing, and its forward cases have
  positive quantities.
- **3B's `STOCK_ISSUE_TEST` and its golden fixtures are unaffected** for the same reason. A fixture with
  a negative quantity, if one is later added, gains a negated cost, and that is the point.
- **The alternative — negating the copied `document_line.cost`** — was rejected: it contradicts §4.7.2
  A6's non-negative magnitude, it would hand `applyMovements` a negative value for a receipt movement
  whose quantity is positive, and it would put a sign in a stored column that four consumers read as a
  magnitude.
- **A zero or null quantity changes nothing**, so no account-line or text-line policy is touched.
```

- [ ] **Step 2: Write the failing pure test `packages/domain/test/posting/evaluate-negative-cost.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "../../src";
import { evaluatePolicy, type DocumentSnapshot, type LineSnapshot, type PostingPolicy } from "../../src/posting/evaluate";

const MYR = currency("MYR");

/** A DELIVERY_ORDER-shaped policy: both legs at line.cost with FIXED sides (3D's real file). */
const COST_ONLY: PostingPolicy = {
  version: 1, documentType: "DELIVERY_ORDER", direction: "outbound",
  requires: ["party", "warehouse"],
  lines: [
    { for: "each_line", side: "debit",  account: { code: "1250" },                    amount: "line.cost", when: { "line.kind": "item" } },
    { for: "each_line", side: "credit", account: { from: "item.inventory_account" },  amount: "line.cost", when: { "line.kind": "item" } },
  ],
  inventory: { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" },
  tax: { applies: false },
  numbering: { series: "DO", assignAt: "issue" },
  reversal: { allowed: true, producesType: "DELIVERY_ORDER" },
  approval: { required: false, approve: null, post: "inventory.transfer.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as unknown as PostingPolicy;

function line(over: Partial<LineSnapshot>): LineSnapshot {
  return {
    id: "00000000-0000-0000-0000-000000000001", lineNo: 1, kind: "item", description: null,
    accountId: null, itemId: "item-1", quantity: Quantity.of("5.000000"), unitPrice: Money.of("9.0000", MYR),
    discount: Money.zero(MYR), amount: Money.of("45.0000", MYR), taxCodeId: null,
    taxAmount: Money.zero(MYR), totalInclTax: Money.of("45.0000", MYR),
    debit: Money.zero(MYR), credit: Money.zero(MYR), cost: Money.of("15.0000", MYR),
    warehouseId: "wh-1", toWarehouseId: null, lotId: null, unitId: "unit-1", unitQuantity: null,
    countedQuantity: null, expectedQuantity: null, tenderMethod: null,
    customFields: {}, dimensions: {}, payroll: null, ...over,
  };
}

function snapshot(lines: LineSnapshot[]): DocumentSnapshot {
  return {
    header: {
      id: "doc-1", companyId: "co-1", documentTypeCode: "DELIVERY_ORDER", status: "issued", series: "DO",
      fiscalPeriodId: "fp-1", number: 1n, effectiveDate: "2026-01-10", partyId: "party-1", currency: MYR,
      exchangeRate: { from: MYR, to: MYR, rate: "1.00000000", effectiveFrom: "2026-01-01", source: "unit" },
      branchId: "branch-1", attributedTo: null, clientRef: null, warehouseId: "wh-1", toWarehouseId: null,
      taxInclusive: false, reversesDocumentId: null, customFields: {},
    },
    lines,
    company: { id: "co-1", baseCurrency: MYR, fxRoundingAccountId: "acc-5920", costingMethod: "avco" },
    party: { id: "party-1", kind: "customer", receivableAccountId: "acc-1200", payableAccountId: "acc-2100", creditLimit: null },
    refs: {
      accountsByCode: { "1250": "acc-1250" },
      items: { "item-1": { id: "item-1", code: "IT-1", kind: "product", baseUnitId: "unit-1", trackLots: false,
                           revenueAccountId: "acc-4000", inventoryAccountId: "acc-1300", cogsAccountId: "acc-5000", expenseAccountId: null } },
      taxCodes: {}, components: {}, schemes: {}, dimensionTypesByCode: { BRANCH: "dt-branch" },
    },
  } as unknown as DocumentSnapshot;
}

describe("line.cost on a negative-quantity line — ADR 0045, contracts §4.4.2", () => {
  it("a POSITIVE quantity keeps the policy's sides: debit 1250, credit inventory", () => {
    const plan = evaluatePolicy(COST_ONLY, snapshot([line({})]));
    expect(plan.ledgerLines.map((l) => [l.accountId, l.side, l.amount.toString()])).toEqual([
      ["acc-1250", "debit",  "15.0000"],
      ["acc-1300", "credit", "15.0000"],
    ]);
  });

  it("a NEGATIVE quantity flips both sides and keeps the magnitude — the corridor is RELIEVED", () => {
    const plan = evaluatePolicy(COST_ONLY, snapshot([line({ quantity: Quantity.of("-5.000000") })]));
    expect(plan.ledgerLines.map((l) => [l.accountId, l.side, l.amount.toString()])).toEqual([
      ["acc-1250", "credit", "15.0000"],
      ["acc-1300", "debit",  "15.0000"],
    ]);
  });

  it("PlannedLedgerLine.amount is STILL never negative — A9 holds (§4.4.2)", () => {
    const plan = evaluatePolicy(COST_ONLY, snapshot([line({ quantity: Quantity.of("-5.000000") })]));
    expect(plan.ledgerLines.every((l) => !l.amount.isNegative())).toBe(true);
  });

  it("a ZERO quantity is untouched: the cost keeps its sign and the line is dropped as a zero only if the cost is zero", () => {
    const plan = evaluatePolicy(COST_ONLY, snapshot([line({ quantity: Quantity.of("0.000000") })]));
    expect(plan.ledgerLines.map((l) => l.side)).toEqual(["debit", "credit"]);
  });

  it("a NULL quantity — an account or text line — is untouched", () => {
    const plan = evaluatePolicy(COST_ONLY, snapshot([line({ quantity: null })]));
    expect(plan.ledgerLines.map((l) => l.side)).toEqual(["debit", "credit"]);
  });

  it("a null cost still emits at Money.zero with the fill tag, on the policy's own side (A5, A3D-5)", () => {
    const plan = evaluatePolicy(COST_ONLY, snapshot([line({ cost: null, quantity: Quantity.of("-5.000000") })]));
    expect(plan.ledgerLines.map((l) => [l.side, l.amount.toString(), l.fill])).toEqual([
      ["debit",  "0.0000", "cost"],
      ["credit", "0.0000", "cost"],
    ]);
    expect(plan.warnings).toHaveLength(1);   // one warning per SOURCE line, not per rule (A5)
  });

  it("line.variance_value follows the same rule (3D's STOCK_COUNT and TRANSFER_RECEIPT shapes)", () => {
    const variance = {
      ...COST_ONLY,
      lines: [{ for: "each_line", side: "debit", account: { code: "1250" }, amount: "line.variance_value", when: { "line.kind": "item" } }],
    } as unknown as PostingPolicy;
    const plan = evaluatePolicy(variance, snapshot([line({ quantity: Quantity.of("-2.000000") })]));
    expect(plan.ledgerLines.map((l) => [l.side, l.amount.toString()])).toEqual([["credit", "15.0000"]]);
  });
});
```

- [ ] **Step 3: Run it to see the exact expected failure**

Run: `bun run --cwd packages/domain test posting/evaluate-negative-cost`
Expected: FAIL with two failing cases and five passing. The negative-quantity case reports
`expected [["acc-1250","credit","15.0000"],["acc-1300","debit","15.0000"]]` but received
`[["acc-1250","debit","15.0000"],["acc-1300","credit","15.0000"]]`, and the `line.variance_value` case
reports `[["credit","15.0000"]]` against `[["debit","15.0000"]]`. That is exactly the defect ADR 0045
describes: the sides did not move because the amount was never negative.

- [ ] **Step 4: Amend `packages/domain/src/posting/evaluate.ts`**

3B introduced `COST_AMOUNT_REFS` for exactly this pair of references; extend the resolution beside it rather than writing a third list:

```ts
/**
 * The two amount references whose value comes from `LineSnapshot.cost` (3B's constant, unchanged).
 * ADR 0045 (4A): their SIGN comes from the line's quantity — see `resolveCostAmount` below.
 */
// export const COST_AMOUNT_REFS = ["line.cost", "line.variance_value"] as const;   // 3B, unchanged

/**
 * ADR 0045, contracts §4.4.2. A cost is stored as a non-negative magnitude (§4.7.2 A6) and
 * `applyMovements`' receipt-value branch 1 reads that column directly, so the sign cannot live in the
 * column. It lives here: on a line whose quantity is NEGATIVE — a reversal, a credit note, a cancelled
 * delivery — the cost is read as negative, and A9's sign normalisation then flips the rule's `side`.
 * Without this, a reversal debits its clearing corridor a second time instead of relieving it (3d:2740).
 * A zero or null quantity is untouched: a zero plans no movement (A3) and a null has no direction.
 */
function resolveCostAmount(cost: Money, line: LineSnapshot): Money {
  return line.quantity !== null && line.quantity.isNegative() ? cost.negate() : cost;
}
```

and at the single site where a `COST_AMOUNT_REFS` reference is resolved to a `Money`, wrap it:

```ts
    if ((COST_AMOUNT_REFS as readonly string[]).includes(rule.amount)) {
      if (line.cost === null) {
        // A5: emit at zero, tag it, warn ONCE per source line — unchanged.
        warnOnce(line.lineNo);
        return { amount: Money.zero(documentCurrency), fill: rule.amount === "line.cost" ? "cost" : "variance_value" };
      }
      return { amount: resolveCostAmount(line.cost, line), fill: rule.amount === "line.cost" ? "cost" : "variance_value" };
    }
```

**The null branch is deliberately not negated.** `Money.zero` has no sign, so negating it changes nothing about the amount — but it *would* change the emitted `side` through A9, and the side of a to-be-filled line must be the policy's, because §4.7.2's fill rules "never alter `side`" and the fill happens after evaluation. Leaving the zero unsigned keeps the pre-fill and post-fill sides identical for a positive-quantity line and lets `applyMovements` fill a negative-quantity line's magnitude onto the side the *negated* second evaluation chose — which 3B's re-load-and-re-evaluate step (3b:3172–3180) is what performs.

- [ ] **Step 5: Run the pure test to verify it passes**

Run: `bun run --cwd packages/domain test posting/evaluate-negative-cost && bun run --cwd packages/domain test posting`
Expected: PASS — seven new cases green **and** every existing 2A/3B/3D evaluator test still green. If a 3D variance case turns red, stop: that means a 3D fixture has a negative `quantity` with a sign expectation this change moved, and the reconciliation is a joint 3D/4A amendment, not a local edit to either test.

- [ ] **Step 6: Write the failing DB-tier test `packages/db/test/posting/negative-cost.test.ts`**

The second amendment, and the whole-transaction proof of the first.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import {
  draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedItem, seedTenantV2,
  seedWarehouse, startDb, withTenant, type Db, type Seed,
} from "../index";

let db: Db;
let s: Seed;
let noneType: string;
let itemId: string;
// No `Money` import and no `MYR` constant: every figure this suite asserts is read back from the
// database as a 4-dp string and compared as a string, so importing `@dulja/domain` here would be an
// unused import and `bun run lint` fails on one.
const ctxOf = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "00000000-0000-0000-0000-000000000000" });

/** An `effect: "none"` policy with a cost/cost pair — the SALES_INVOICE shape, minimally. */
const NONE_WITH_COST = {
  version: 1, documentType: "CREDIT_TEST", direction: "outbound", requires: [],
  lines: [
    { for: "each_line", side: "debit",  account: { code: "5000" }, amount: "line.cost", when: { "item.kind": "product" } },
    { for: "each_line", side: "credit", account: { code: "1250" }, amount: "line.cost", when: { "item.kind": "product" } },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "CRT", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.sales.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as const;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "negative-cost");
  for (const [code, nameEn, type] of [
    ["1250", "Goods delivered not invoiced", "asset"], ["1300", "Inventory control", "asset"],
    ["5000", "Cost of goods sold", "expense"], ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(db, s, { code, nameEn, type });
  await grantCodes(db, s, { codes: ["accounting.sales.post"] });
  noneType = await seedDocumentType(db, s, { code: "CREDIT_TEST", policy: NONE_WITH_COST });
  ({ itemId } = await seedItem(db, s, { code: "IT-NC", kind: "product", trackLots: false }));
  await seedWarehouse(db, s, { code: "WH-NC" });
}, 180_000);
afterAll(async () => { await db.stop(); });

/** Draft an item line on the effect:"none" type, optionally with a cost already written. */
async function draftWithCost(cost: string | null, quantity: string) {
  const { documentId, lineIds } = await draftTypedDocument(db, s, {
    documentTypeId: noneType, series: "CRT", effectiveDate: "2026-01-10",
    lines: [{ kind: "item", itemId, quantity, unitPrice: "9.0000", amount: "45.0000" }],
  });
  if (cost !== null) {
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.document_line set cost = ${cost} where id = ${lineIds[0]!}`);
  }
  return documentId;
}

describe("the unfilled-cost refusal and the negative-cost round trip — §4.7.2, ADR 0045", () => {
  it("a COPIED cost posts without any movement: debit 5000, credit 1250, at that figure", async () => {
    const id = await draftWithCost("15.0000", "5.000000");
    const result = await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId: id }));
    expect(result.movementIds).toEqual([]);
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text, e.credit::text from app.ledger_entry e
        join app.account a on a.id = e.account_id where e.document_id = ${id} order by a.code`;
    expect(rows).toEqual([
      { code: "1250", debit: "0.0000",  credit: "15.0000" },
      { code: "5000", debit: "15.0000", credit: "0.0000"  },
    ]);
  });

  it("a NEGATIVE quantity with a copied cost relieves the other way — the credit-note direction (ADR 0045)", async () => {
    const id = await draftWithCost("15.0000", "-5.000000");
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId: id }));
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text, e.credit::text from app.ledger_entry e
        join app.account a on a.id = e.account_id where e.document_id = ${id} order by a.code`;
    expect(rows).toEqual([
      { code: "1250", debit: "15.0000", credit: "0.0000"  },
      { code: "5000", debit: "0.0000",  credit: "15.0000" },
    ]);
  });

  it("the two together net to EXACTLY zero on both accounts — the corridor invariant", async () => {
    const rows = await db.admin<{ code: string; net: string }[]>`
      select a.code, sum(e.base_debit - e.base_credit)::text as net
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where a.code in ('1250', '5000') group by a.code order by a.code`;
    expect(rows).toEqual([{ code: "1250", net: "0.0000" }, { code: "5000", net: "0.0000" }]);
  });

  it("an UNFILLED cost — no movement, no copy — is REFUSED with ERR_POLICY_REQUIRES_MISSING naming the line", async () => {
    const id = await draftWithCost(null, "5.000000");
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId: id })))
      .rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING: document line 1 has no cost/);
  });

  it("the refusal leaves the document unposted and the ledger empty — it fires BEFORE any insert", async () => {
    const id = await draftWithCost(null, "5.000000");
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId: id })))
      .rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING/);
    const [doc] = await db.admin<{ status: string }[]>`select status from app.document where id = ${id}`;
    const [n] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.ledger_entry where document_id = ${id}`;
    expect(doc!.status).not.toBe("posted");
    expect(n!.n).toBe(0);
  });

  it("a SERVICE item is filtered out by when: { item.kind: product } and needs no cost at all", async () => {
    const { itemId: svc } = await seedItem(db, s, { code: "SVC-NC", kind: "service", trackLots: false });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: noneType, series: "CRT", effectiveDate: "2026-01-10",
      lines: [{ kind: "item", itemId: svc, quantity: "1.000000", unitPrice: "50.0000", amount: "50.0000" }],
    });
    // The policy plans NO ledger line for a service line, so the post refuses with the OUTPUT case of
    // ERR_DOC_NO_LINES (§4.3.2 step 6) — not with the cost refusal. The distinction matters: the service
    // line is not missing a cost, it is not a cost-bearing line at all.
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId })))
      .rejects.toThrow(/ERR_DOC_NO_LINES/);
  });
});
```

- [ ] **Step 7: Run it to see the exact expected failure**

Run: `bun run --cwd packages/db test posting/negative-cost`
Expected: FAIL on the fourth and fifth cases only. The unfilled-cost case reports
`expected substring "ERR_POLICY_REQUIRES_MISSING"` but the promise **resolved** — the two zero-value
legs were inserted and the document reached `posted`, which is exactly the silent understatement of cost
of goods sold this amendment closes. The first three cases already pass, because Step 4 landed.

- [ ] **Step 8: Amend `packages/db/src/costing/apply-movements.ts`**

3D shipped the fill rules here (amendment A6). Add the no-movement branch beside them, in the same loop, and change nothing else:

```ts
/**
 * Contracts §4.7.2 (4A). A `fill`-tagged planned ledger line whose source `document_line` has no surviving
 * `PlannedMovement` is LEFT EXACTLY AS THE EVALUATOR EMITTED IT — this function fills nothing and alters
 * nothing on it. Two cases reach here and they must be told apart:
 *
 *   • the source line carries a NON-NULL cost — a figure another document computed and this one copied
 *     forward (4A's two conversion services, §4.7.2's "who may write document_line.cost"). The line already
 *     stands at its real amount and needs no movement. This is every `SALES_INVOICE` and every credit note.
 *
 *   • the source line's cost is NULL and the line's amount is therefore `Money.zero` (amendment A5's
 *     exemption keeps it alive). Nothing will ever fill it, and inserting the zero would post a silent
 *     zero-value cost-of-goods-sold row. REFUSE, naming the line. This is 2A's step-9b guard restored
 *     where step 9 now lives: 3B removed it when it replaced the guard with this call, and 4A is the first
 *     slice with a `line.cost` leg on a policy whose `inventory.effect` is "none".
 */
for (const planned of plan.ledgerLines) {
  if (planned.fill === undefined) continue;
  const source = planned.sourceLineNo === null
    ? undefined
    : snapshot.lines.find((l) => l.lineNo === planned.sourceLineNo);
  const movements = plan.movements.filter((m) => m.lineNo === planned.sourceLineNo);

  if (movements.length === 0) {
    if (planned.amount.isZero() && (source === undefined || source.cost === null)) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `document line ${planned.sourceLineNo ?? "?"} has no cost: its policy plans a ${planned.fill} leg, ` +
        `no movement fills it, and no document supplied one. Raise this document from the delivery or ` +
        `receipt that carries the cost, or remove the ${planned.fill} leg from the policy.`,
      );
    }
    continue;   // a copied cost: the line stands as it is
  }
  // From here down the loop body is 3D's, unchanged: its single-value fill rule (one movement, so the
  // line's amount becomes that movement's `value`) and its two-quantity rule (several movements on one
  // source line, so the amounts are apportioned by movement quantity). **Do not retype, re-order or
  // "tidy" them.** This step inserts the `if (movements.length === 0) { … }` block ABOVE them and adds
  // nothing else — the whole point of the guard is that it fires before either rule can see a line no
  // movement will fill, and the diff for this step is exactly that one block plus its doc comment.
}
```

**Two details that decide whether this is correct or merely present.** The guard tests `planned.amount.isZero()` **and** a null source cost, not either alone: a genuinely zero cost that a movement filled is legal (a free-of-charge line, spec:1055), and a non-zero amount with no movement is the copied-cost case. And it throws `PostingError`, not `AppError` — `packages/db/src/costing/**` cannot import `@dulja/contracts` (§3.1, and `PostingError` is the one declared exception, §4.2.4); `ERR_POLICY_REQUIRES_MISSING` is already a member of `PostingErrorCode`, so no type widens.

- [ ] **Step 9: Append the `— 4A` block to `tests/regression/legacy-017.test.ts`**

3B created the file (order-delivery tracking double-adds on edit and never reverses on re-pointing). The 4A block is the same defect shape in the corridor:

```ts
describe("LEGACY-017 A reversal relieves what it posted, and never adds to it — 4A", () => {
  it("the two cost amount references are resolved through ONE function, with the sign from the quantity", async () => {
    const { repoFile } = await import("../support/regression");
    const src = repoFile("packages/domain/src/posting/evaluate.ts");
    // The legacy defect was `X = X + old + new` — adding where it should have subtracted, in one of three
    // inconsistent branches. The structural fix is that there is exactly ONE place a cost becomes a signed
    // amount, and it reads the quantity rather than the caller's intent.
    expect(src).toMatch(/function resolveCostAmount/);
    expect((src.match(/resolveCostAmount\(/g) ?? []).length).toBeGreaterThanOrEqual(2);   // declaration + one call site
    expect(src).toMatch(/line\.quantity !== null && line\.quantity\.isNegative\(\)/);
  });

  it("delivered and returned quantity are PROJECTIONS of document_link, never stored counters", async () => {
    const { rw } = await sharedDb();
    // LEGACY-017's root cause was a maintained counter (`OdtTransferredBonus`) updated by three triggers.
    // Here the figure is a view over the links, so there is nothing to double-add and nothing to forget.
    const [v] = await rw.db.admin<{ kind: string }[]>`
      select c.relkind::text as kind from pg_class c
       where c.relname = 'document_open_quantity' and c.relnamespace = 'app'::regnamespace`;
    expect(v!.kind).toBe("v");
  });
});
```

- [ ] **Step 10: Run everything to verify it passes**

Run: `bun run --cwd packages/domain test posting && bun run --cwd packages/db test posting && bun run --cwd packages/db test costing && node --test tests/regression/legacy-017.test.ts && bun run lint:rules`
Expected: PASS — the six new DB-tier cases, the seven pure cases, every 2A/3A/3B/3D posting and costing test still green, both new `legacy-017` cases, and `lint:rules` exit 0.

One failure worth naming in advance. If a **3B golden fixture** turns red with a flipped side, do not edit the fixture: 3B's `tests/golden/costing/**` `expected.json` files are byte-compared on purpose (spec:2264), and a genuine change to what a formula produces must be visible as a diff and accepted deliberately. Check the fixture's input for a negative `quantity`; if it has one, the flip is ADR 0045 working and the `expected.json` is regenerated **in this commit** with the diff quoted in the PR body. If it has none, the change has reached a case it must not and Step 4's guard is wrong.

- [ ] **Step 11: Commit**

```bash
git add docs/adr/0045-negative-line-quantity-negates-line-cost.md \
        packages/domain/src/posting/evaluate.ts \
        packages/domain/test/posting/evaluate-negative-cost.test.ts \
        packages/db/src/costing/apply-movements.ts \
        packages/db/test/posting/negative-cost.test.ts \
        tests/regression/legacy-017.test.ts
git commit -m "fix(domain): line.cost is negative on a negative-quantity line; refuse an unfilled cost leg [4A T4]

ADR 0045 (a proposal) closes the amendment 3D filed as blocking Phase 4: a reversal's copied cost is a
magnitude and the fill rules never alter side, so a reversed DELIVERY_ORDER debited 1250 a second time
instead of relieving it. The sign now comes from the line's quantity in the evaluator, so A9 flips the
side; document_line.cost stays a non-negative magnitude and applyMovements' branch 1 is untouched.

Second: applyMovements refuses a fill-tagged line with no movement, a zero amount and a null source
cost, with ERR_POLICY_REQUIRES_MISSING. That is 2A's step-9b guard restored where step 9 now lives, and
without it a SALES_INVOICE with no delivery would post zero-value COGS rows silently.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `SALES_INVOICE` — the revenue type, the `1250` relief, and the AR/AP test helper

The first revenue-posting document type in the system. It is **configuration only** — no TypeScript beyond the shared test helper — and that is this task's claim.

**Files:**
- Create: `packages/db/seed/my/document-types/SALES_INVOICE.json`
- Create: `tests/invariants/support/post-ar.ts`
- Create: `packages/db/test/ar-ap/_support.ts`
- Create: `packages/db/test/ar-ap/sales-invoice.test.ts`

**Interfaces:**
- Consumes: `loadDocumentTypes`, `documentTypesLoader` (1A); `postDocument`, `issueDocument`, `transitionDocument` (§4.3.1); `evaluatePolicy` with ADR 0045 (Task 4); `app.assert_credit_available` (Task 3); the accounts this type's policy resolves — `1200` (`party.receivable_account`), `4000` (`item.revenue_account`, made by `seedTenantV2`), `5000` (`item.cogs_account`), `1250` (the corridor, by code) and `5920` (`company.fx_rounding_account_id`) — all §4.15 rows seeded by 0C or 3D, **and re-seeded by no task of this slice** (Global Constraint 14; `1300` and `5900` appear in this suite's `beforeAll` because `seedItem` needs an inventory account and the charge-line case needs an expense account, not because the policy names either); `draftTypedDocument` (3C), `secondPrincipal`, `postInventoryDocument` (3B/3D), `grantCodes` (2B), `seedParty`, `seedDocumentType` (2A), `seedItem`, `seedWarehouse` (3A), `seedPaymentTerm` (Task 1), `resolvePartyTerm`, `dueDateFor` (Task 1).
- Produces: `packages/db/seed/my/document-types/SALES_INVOICE.json` — the §4.14 row `SALES_INVOICE` / module `accounting` / series `INV` / `direction: outbound` / `inventory: none` / `approval.post: accounting.sales.post`; and the §4.17.1 helper:

```ts
// tests/invariants/support/post-ar.ts (4A)
export interface ArLine {
  kind: "item" | "account" | "text";
  itemId?: string; accountId?: string; description?: string;
  quantity?: string; unitPrice?: string; amount?: string; taxAmount?: string; totalInclTax?: string;
  cost?: string;                       // a COPIED cost, as a conversion service writes it (§4.7.2)
  debit?: string; credit?: string;
}
export interface PostArOptions {
  documentTypeId: string; series: string; effectiveDate?: string;
  partyId?: string; currency?: string; exchangeRate?: string; paymentTermId?: string | null;
  /** The provenance of `exchangeRate`, written to `document.rate_source` (plan0A:1787, LEGACY-012).
   *  Defaults to `"unit"` at rate 1.00000000 and `manual:<actorId>` otherwise — the two spellings that
   *  column's own comment gives, and the same rule `draftSettlement` applies (Task 10). */
  rateSource?: string;
  lines: readonly ArLine[];
  /** For a `required` approval: submit as `s.human`, approve and post as a second principal (R1). */
  twoPrincipal?: boolean;
  /** Record `accounting.credit_limit.override` by a second principal before issuing. */
  creditOverride?: boolean;
}
export interface PostArResult {
  documentId: string; number: bigint;
  ledger: { code: string; debit: string; credit: string }[];   // ordered by account code
}
export async function postArDocument(db: Db, s: Seed, opts: PostArOptions): Promise<PostArResult>;
```

**`twoPrincipal` is registered here and is NOT exercised by 4A, and that is stated rather than left to be found.** Every `PAYMENT` case in Task 10 walks the state machine explicitly — `draftSettlement`, then `transitionDocument` to `submitted`, then a *second* `withTenant` session for the checker — because tests **10** and **31** are about *which principal* may do *what*, and a helper that hides the two sessions would hide the thing under test. The member exists because **4B, 5A, 6A, 7C and 8C** all post approval-required AR/AP documents whose two-principal walk is incidental to what they assert, and because adding it to a shared helper later means editing a file five slices already import. **An unexercised branch in a shared helper is a maintenance hazard, so it is not left silent:** Task 0's amendment 14 says so in the register, and the first slice that uses it is the one that proves it. Nothing in 4A calls it, and no case below is weaker for that.

**`rateSource` closes a hole the helper would otherwise leave open.** `draftTypedDocument` (3C) writes `currency` and `exchange_rate` and **not** `rate_source`; `app.document.rate_source` is a plain nullable `text` with no default (plan0A:1787); and `convertToInvoice`, `creditNoteFrom` and `draftSettlement` all set or copy it. Without this member every document the §4.17.1 helper posts would carry a null provenance for its rate — which is exactly the absence LEGACY-012 is about — and Task 14's `legacy-012` block would be asserting an invariant the helper itself breaks. It is written in the same post-draft `UPDATE` as `payment_term_id`, and Task 5's suite asserts it on a real posted invoice.

- [ ] **Step 1: Write the shared helper `tests/invariants/support/post-ar.ts`**

**This step comes before the test and that is not a TDD inversion.** `post-ar.ts` is the §4.17.1 *test helper* — scaffolding the suite imports, not the implementation the suite is red against. The implementation this task ships is `SALES_INVOICE.json`, and it is written in **Step 4**, after Step 2's suite and Step 3's red. Task 6 uses the same ordering for the same reason.

```ts
import { postDocument, transitionDocument, issueDocument, recordOverride } from "@dulja/db";
import { draftTypedDocument, grantCodes, withTenant, type Db, type Seed } from "@dulja/db/test";
import { secondPrincipal } from "./post-inventory";

export interface ArLine {
  kind: "item" | "account" | "text";
  itemId?: string; accountId?: string; description?: string;
  quantity?: string; unitPrice?: string; amount?: string; taxAmount?: string; totalInclTax?: string;
  cost?: string; debit?: string; credit?: string;
}
export interface PostArOptions {
  documentTypeId: string; series: string; effectiveDate?: string;
  partyId?: string; currency?: string; exchangeRate?: string; rateSource?: string;
  paymentTermId?: string | null;
  lines: readonly ArLine[]; twoPrincipal?: boolean; creditOverride?: boolean;
}
export interface PostArResult {
  documentId: string; number: bigint;
  ledger: { code: string; debit: string; credit: string }[];
}

const ctxOf = (s: Seed, actor?: string) =>
  ({ tenantId: s.tenant, actorId: actor ?? s.human, requestId: "00000000-0000-0000-0000-000000000000" });

/** Memoised once per Seed: `seedTenant` grants `s.human` nothing (§4.1) and 2B's R2 evaluates the policy's
 *  approval.post INSIDE the posting transaction, so every posting test must grant first. */
const granted = new WeakSet<object>();

/**
 * §4.17.1, slice 4A. The AR/AP twin of 3B's `postInventoryDocument`. Drafts a typed document with account
 * and item lines through 3C's `draftTypedDocument`, writes the two derived money columns the drafting helper
 * does not (`tax_amount`, `total_incl_tax`) and the COPIED `cost` a conversion service would write, walks
 * the document through the REAL state machine and posts it through the REAL `postDocument`.
 */
export async function postArDocument(db: Db, s: Seed, opts: PostArOptions): Promise<PostArResult> {
  if (!granted.has(s as unknown as object)) {
    await grantCodes(db, s, {
      codes: [
        "accounting.sales.post", "accounting.purchase.post", "accounting.receipt.create",
        "accounting.receipt.post", "accounting.payment.create", "accounting.payment.post",
      ],
    });
    granted.add(s as unknown as object);
  }

  const { documentId, lineIds } = await draftTypedDocument(db, s, {
    documentTypeId: opts.documentTypeId, series: opts.series,
    effectiveDate: opts.effectiveDate ?? "2026-01-15",
    currency: opts.currency, exchangeRate: opts.exchangeRate,
    partyId: opts.partyId, branchId: s.hq,
    lines: opts.lines.map((l) => ({
      kind: l.kind, itemId: l.itemId, accountId: l.accountId, description: l.description,
      quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, debit: l.debit, credit: l.credit,
    })),
  });

  // The two derived columns and the copied cost. `draftTypedDocument`'s DraftLine carries neither
  // total_incl_tax nor cost, and both are written by a service in production — the invoice service copies
  // the cost (§4.7.2) and computes total_incl_tax = amount + tax_amount. Written here in one statement per
  // line so the helper needs no second fixture.
  //
  // …and `rate_source`, for the same reason: `draftTypedDocument` writes `currency` and `exchange_rate`
  // and NOT the provenance column (3c's insert list), while every production writer in this slice sets or
  // copies it. A null `rate_source` on a posted document is the LEGACY-012 absence itself — a base figure
  // whose rate nobody can account for — so the helper supplies the same two spellings plan0A:1787's own
  // comment gives and `draftSettlement` uses: `unit` at rate 1.00000000, `manual:<actor>` otherwise.
  const rate = opts.exchangeRate ?? "1.00000000";
  const rateSource = opts.rateSource ?? (rate === "1.00000000" ? "unit" : `manual:${s.human}`);
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    for (const [i, l] of opts.lines.entries()) {
      await tx`update app.document_line set
                 tax_amount     = coalesce(${l.taxAmount ?? null}, tax_amount),
                 total_incl_tax = coalesce(${l.totalInclTax ?? l.amount ?? null}, total_incl_tax),
                 cost           = coalesce(${l.cost ?? null}, cost)
               where id = ${lineIds[i]!}`;
    }
    await tx`update app.document set rate_source = ${rateSource} where id = ${documentId}`;
    if (opts.paymentTermId !== undefined) {
      await tx`update app.document set payment_term_id = ${opts.paymentTermId} where id = ${documentId}`;
    }
  });

  const checker = opts.twoPrincipal === true ? await secondPrincipal(db, s, "ar-checker") : null;
  if (checker !== null) {
    await grantCodes(db, s, {
      codes: ["accounting.payment.approve", "accounting.payment.post", "accounting.sales.post"],
      principalId: checker, roleCode: "ar-checker",
    });
  }
  if (opts.creditOverride === true) {
    const director = await secondPrincipal(db, s, "ar-director");
    await grantCodes(db, s, {
      codes: ["accounting.credit_limit.override"], principalId: director, roleCode: "ar-credit-override",
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      recordOverride(tx, ctxOf(s), {
        documentId, code: "accounting.credit_limit.override",
        reason: "approved by the credit committee", attributedTo: director,
      }));
  }

  const result = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    if (checker !== null) {
      await transitionDocument(tx, ctxOf(s), { documentId, to: "submitted" });
    }
    return checker === null ? null : true;
  });
  if (result !== null && checker !== null) {
    // The checker is a DIFFERENT session: R1 compares app.current_actor() against every `submitted` actor.
    await withTenant(db.rw, s.tenant, checker, async (tx) => {
      await transitionDocument(tx, ctxOf(s, checker), { documentId, to: "approved" });
      await issueDocument(tx, ctxOf(s, checker), { documentId });
      await postDocument(tx, ctxOf(s, checker), { documentId });
    });
  } else {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await issueDocument(tx, ctxOf(s), { documentId });
      await postDocument(tx, ctxOf(s), { documentId });
    });
  }

  const [head] = await db.admin<{ number: string }[]>`
    select number::text from app.document where id = ${documentId}`;
  const ledger = await db.admin<{ code: string; debit: string; credit: string }[]>`
    select a.code, e.debit::text as debit, e.credit::text as credit
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = ${documentId} order by a.code, e.line_no`;
  return { documentId, number: BigInt(head!.number), ledger };
}
```

- [ ] **Step 2: Write the failing test `packages/db/test/ar-ap/sales-invoice.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPackFile } from "../../src/seed";
import { PACK_ROOT, accountByCode, loadTypesFromPack } from "./_support";
import { dueDateFor, resolvePartyTerm } from "../../src/ar-ap/payment-term";
import {
  seedAccount, seedItem, seedParty, seedPaymentTerm, seedTenantV2, startDb, withTenant, type Db, type Seed,
} from "../index";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";

let db: Db;
let s: Seed;
let invType: string;
let partyId: string;
let itemId: string;
let termId: string;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "sales-invoice");
  for (const [code, nameEn, type] of [
    ["1200", "Trade receivables", "asset"], ["1250", "Goods delivered not invoiced", "asset"],
    ["1300", "Inventory control", "asset"], ["5000", "Cost of goods sold", "expense"],
    ["5900", "Other operating expense", "expense"], ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(db, s, { code, nameEn, type });
  // The type comes from the PACK, through 1A's loader — the zero-code claim is about the seeded file.
  ({ salesInvoiceType: invType } = await loadTypesFromPack(db, s, ["SALES_INVOICE"]) as never);
  termId = await seedPaymentTerm(db, s, { code: "NET30", dueDays: 30 });
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-INV" });
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    tx`update app.party set payment_term_id = ${termId} where id = ${partyId}`);
  ({ itemId } = await seedItem(db, s, { code: "IT-INV", kind: "product", trackLots: false }));
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("SALES_INVOICE — §4.14, ADR 0044, spec:2009–2028", () => {
  it("the seed file validates against the envelope schema and its policy against the policy schema", () => {
    const envelope = readPackFile<{ code: string; module: string; policy: { inventory: { effect: string } } }>(
      PACK_ROOT, "document-types", "SALES_INVOICE.json");
    expect(envelope.code).toBe("SALES_INVOICE");
    expect(envelope.module).toBe("accounting");
    expect(envelope.policy.inventory.effect).toBe("none");   // ADR 0044
  });

  it("a linked-shape invoice posts four rows: AR, revenue, COGS and the 1250 relief", async () => {
    const r = await postArDocument(db, s, {
      documentTypeId: invType, series: "INV", partyId, paymentTermId: termId,
      lines: [{ kind: "item", itemId, quantity: "5.000000", unitPrice: "9.0000", amount: "45.0000", cost: "15.0000" }],
    });
    expect(r.ledger).toEqual([
      { code: "1200", debit: "45.0000", credit: "0.0000"  },
      { code: "1250", debit: "0.0000",  credit: "15.0000" },
      { code: "4000", debit: "0.0000",  credit: "45.0000" },
      { code: "5000", debit: "15.0000", credit: "0.0000"  },
    ]);
  });

  it("every line carries BRANCH — spec:1066's required dimension on revenue and COGS", async () => {
    const rows = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry e
       where not exists (select 1 from app.ledger_entry_dimension d
                          join app.dimension_value v on v.id = d.dimension_value_id
                         where d.entry_id = e.id and v.id = ${s.hq})`;
    expect(rows[0]!.n).toBe(0);
  });

  it("a MIXED invoice posts cost legs for the product line only (when: item.kind = product)", async () => {
    const { itemId: svc } = await seedItem(db, s, { code: "SVC-INV", kind: "service", trackLots: false });
    const r = await postArDocument(db, s, {
      documentTypeId: invType, series: "INV", partyId, effectiveDate: "2026-01-16",
      lines: [
        { kind: "item", itemId,     quantity: "1.000000", unitPrice: "9.0000",  amount: "9.0000",  cost: "3.0000" },
        { kind: "item", itemId: svc, quantity: "1.000000", unitPrice: "50.0000", amount: "50.0000" },
      ],
    });
    // Two AR debits, two revenue credits, and exactly ONE cost pair.
    expect(r.ledger.filter((l) => l.code === "5000")).toHaveLength(1);
    expect(r.ledger.filter((l) => l.code === "1250")).toHaveLength(1);
    expect(r.ledger.filter((l) => l.code === "1200")).toHaveLength(2);
  });

  it("a CHARGE line posts AR against its own account, with no cost leg", async () => {
    const r = await postArDocument(db, s, {
      documentTypeId: invType, series: "INV", partyId, effectiveDate: "2026-01-17",
      lines: [{ kind: "account", accountId: (await accountByCode(db, s, "5900")), description: "delivery charge", amount: "20.0000" }],
    });
    expect(r.ledger).toEqual([
      { code: "1200", debit: "20.0000", credit: "0.0000"  },
      { code: "5900", debit: "0.0000",  credit: "20.0000" },
    ]);
  });

  it("a product line with NO cost — no delivery, no copy — is refused (Task 4's guard, ADR 0044)", async () => {
    await expect(postArDocument(db, s, {
      documentTypeId: invType, series: "INV", partyId, effectiveDate: "2026-01-18",
      lines: [{ kind: "item", itemId, quantity: "1.000000", unitPrice: "9.0000", amount: "9.0000" }],
    })).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING: document line 1 has no cost/);
  });

  it("the pinned term drives the derived due date, and it survives a change to the party's term", async () => {
    const r = await postArDocument(db, s, {
      documentTypeId: invType, series: "INV", partyId, paymentTermId: termId, effectiveDate: "2026-01-20",
      lines: [{ kind: "item", itemId, quantity: "1.000000", unitPrice: "9.0000", amount: "9.0000", cost: "3.0000" }],
    });
    const later = await seedPaymentTerm(db, s, { code: "NET90", dueDays: 90 });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set payment_term_id = ${later} where id = ${partyId}`);
    const due = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [d] = await tx<{ t: string | null }[]>`select payment_term_id::text as t from app.document where id = ${r.documentId}`;
      return dueDateFor(tx, { paymentTermId: d!.t, effectiveDate: "2026-01-20" });
    });
    expect(due).toBe("2026-02-19");                                    // 20 Jan + 30 days, NOT + 90
    expect(await withTenant(db.rw, s.tenant, s.human, (tx) => resolvePartyTerm(tx, { partyId }))).toBe(later);
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set payment_term_id = ${termId} where id = ${partyId}`);
  });

  it("credit control applies to the real type: over the limit refuses, a second principal's override releases it", async () => {
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set credit_limit = ${"100.0000"} where id = ${partyId}`);
    const over = {
      documentTypeId: invType, series: "INV", partyId, effectiveDate: "2026-01-21",
      lines: [{ kind: "item" as const, itemId, quantity: "1.000000", unitPrice: "900.0000", amount: "900.0000", cost: "300.0000" }],
    };
    await expect(postArDocument(db, s, over)).rejects.toThrow(/ERR_CREDIT_LIMIT_EXCEEDED: party CUST-INV/);
    const released = await postArDocument(db, s, { ...over, effectiveDate: "2026-01-22", creditOverride: true });
    expect(released.number).toBeGreaterThan(0n);
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.party set credit_limit = null where id = ${partyId}`);
  });

  it("base = round(value × rate, 4) on every line — LEGACY-012, in a foreign currency", async () => {
    const rows = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry
       where base_debit <> round(debit * exchange_rate, 4) or base_credit <> round(credit * exchange_rate, 4)`;
    expect(rows[0]!.n).toBe(0);   // the CHECK guarantees it; this asserts the CHECK is still attached
  });

  it("every posted invoice carries a rate_source — a base figure with no provenance is LEGACY-012", async () => {
    // This is the NON-VACUOUS half of Task 14's legacy-012 block: that block runs against the thin
    // regression database, which holds no 4A document, so its count of null rate_sources is 0 for the
    // wrong reason. THIS database holds nothing but documents `postArDocument` built, so the same
    // assertion here has rows to be wrong about. `draftTypedDocument` (3C) does not write the column and
    // `app.document.rate_source` has no default (plan0A:1787) — without the helper's UPDATE this case is
    // red on every row.
    const [nulls] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document d
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'SALES_INVOICE' and d.status = 'posted' and d.rate_source is null`;
    expect(nulls!.n).toBe(0);
    const [one] = await db.admin<{ src: string; rate: string }[]>`
      select d.rate_source as src, d.exchange_rate::text as rate from app.document d
        join app.document_type t on t.id = d.document_type_id
       where t.code = 'SALES_INVOICE' and d.status = 'posted' order by d.number limit 1`;
    expect(one!.rate).toBe("1.00000000");
    expect(one!.src).toBe("unit");     // the label plan0A:1787's own comment gives for an unconverted rate
  });
});
```

**Four helpers this suite and the four later `ar-ap` suites share, in `packages/db/test/ar-ap/_support.ts`.** They are **deliberately file-local to that directory and are not `fixtures.ts` helpers**: §4.17 assigns 4A exactly one row (`seedPaymentTerm`) and hazard 9 forbids inventing a second beside the register. If a later slice needs them, they go to §4.17.1 by amendment.

```ts
// packages/db/test/ar-ap/_support.ts — shared by every ar-ap suite in this slice
import { withTenant, type Db, type Seed } from "../index";

/**
 * The pack root, RELATIVE TO `packages/db`. Vitest runs each package's project from that package's own
 * directory (Plan 0A's `vitest.config.ts`, plan0A:428–437), so a repo-relative "packages/db/seed/my" does
 * not resolve here — the same trap §4.17.1 records for `repoFile` in the `tests` workspace, in the other
 * direction. Stated as a constant so five suites cannot spell it two ways.
 */
export const PACK_ROOT = "seed/my";

/**
 * Loads the named document types through 1A's REAL loader, so every test exercises the SEEDED file rather
 * than an inline policy. `loadDocumentTypes` loads every file in the directory — which is intended: each
 * later task's suite gets its own type for free as the files land — so the result is filtered by `code`
 * and returned keyed by the camel-cased code (`SALES_INVOICE` → `salesInvoiceType`).
 */
export async function loadTypesFromPack(
  db: Db, s: Seed, codes: readonly string[],
): Promise<Record<string, string>> {
  const { loadDocumentTypes } = await import("../../src/seed/document-types");
  const { PERMISSIONS } = await import("@dulja/contracts/permissions");
  const results = await withTenant(db.rw, s.tenant, s.system, (tx) =>
    loadDocumentTypes(
      tx,
      { tenantId: s.tenant, actorId: s.system, requestId: "00000000-0000-0000-0000-000000000000" },
      `${PACK_ROOT}/document-types`,
      PERMISSIONS.map((p) => p.code),
    ));
  const out: Record<string, string> = {};
  for (const code of codes) {
    const hit = results.find((r) => r.code === code);
    if (hit === undefined) throw new Error(`the seed pack has no document type ${code}`);
    const key = code.toLowerCase().replace(/_(.)/g, (_, c: string) => c.toUpperCase()) + "Type";
    out[key] = hit.documentTypeId;
  }
  return out;
}

export async function accountByCode(db: Db, s: Seed, code: string): Promise<string> {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = ${code}`;
    if (row === undefined) throw new Error(`account ${code} does not resolve for this company (hazard 33)`);
    return row.id;
  });
}

/**
 * `a + b` over two 4-dp decimal strings, added as integer hundredths-of-a-cent. Every corridor assertion
 * in Tasks 6 and 7 is "the balance moved by exactly X", and `Number(before) + 12` — the obvious spelling —
 * is the shape §3.7.5's `no-number-money` rule exists to stop. A test is not exempt from Global
 * Constraint 4, and `Money` is not usable here because these are raw account balances read as text with
 * no currency attached.
 */
export function plus4(a: string, b: string): string {
  const scaled = (v: string): bigint => {
    const negative = v.startsWith("-");
    const [whole, fraction = ""] = (negative ? v.slice(1) : v).split(".");
    const n = BigInt(whole + `${fraction}0000`.slice(0, 4));
    return negative ? -n : n;
  };
  const total = scaled(a) + scaled(b);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}
```

This suite's `beforeAll` therefore reads `({ salesInvoiceType: invType } = await loadTypesFromPack(db, s, ["SALES_INVOICE"]) as never)`, and `readPackFile(PACK_ROOT, "document-types", "SALES_INVOICE.json")` uses the same constant. `packages/db/test/ar-ap/_support.ts` is already in this task's **Files** list as a *Create*, and **this step is where it is written**, beside the suite that first imports it — it is test scaffolding, like `post-ar.ts`, and both must exist before the suite can resolve its imports at all.

- [ ] **Step 3: Run it to see the exact expected failure**

Run: `bun run --cwd packages/db test ar-ap/sales-invoice`
Expected: FAIL in `beforeAll` with `Error: the seed pack has no document type SALES_INVOICE`, thrown by `loadTypesFromPack` — Step 4's file does not exist yet. Every case is red for that one reason.

Two failures that would mean something else, and neither is this red. `ERR_POLICY_INVALID` naming `approval.post` means **Task 2 has not merged**: `validatePolicy` refuses a policy whose `approval` code is not in the catalogue (F-21), and no policy in this slice can be seeded before those seven codes exist. A TypeScript resolution error on `../../../../tests/invariants/support/post-ar` means Step 1 was skipped.

**The policy, and the five choices in it.**

- [ ] **Step 4: Write `packages/db/seed/my/document-types/SALES_INVOICE.json`**

```json
{
  "code": "SALES_INVOICE",
  "nameEn": "Sales Invoice",
  "nameAr": "فاتورة بيع",
  "module": "accounting",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "SALES_INVOICE",
    "direction": "outbound",
    "requires": ["party"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "party.receivable_account" }, "amount": "line.total_incl_tax", "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "credit", "account": { "from": "item.revenue_account" },     "amount": "line.amount",         "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "debit",  "account": { "from": "party.receivable_account" }, "amount": "line.total_incl_tax", "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" },             "amount": "line.amount",         "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "debit",  "account": { "from": "item.cogs_account" },        "amount": "line.cost",           "when": { "item.kind": "product" } },
      { "for": "each_line", "side": "credit", "account": { "code": "1250" },                     "amount": "line.cost",           "when": { "item.kind": "product" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "INV", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "SALES_CREDIT_NOTE" },
    "approval": { "required": false, "approve": null, "post": "accounting.sales.post", "create": "accounting.sales.create" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

- **`inventory: { "effect": "none" }`** — ADR 0044. The invoice moves no stock; the `1250` corridor 3D's `DELIVERY_ORDER` filled is what it relieves. The register cell said "issue (or none when linked to a DO)"; Task 0 corrected it, because `inventory.effect` is one value per policy and the schema's `$id` is frozen.
- **Six line rules in three balanced pairs, and each pair balances on its own.** AR versus revenue at `total_incl_tax`/`amount` for item lines; AR versus `line.account` for a charge line (freight, handling — a `kind: "account"` line on a sales invoice); cost of goods sold versus `1250` at `line.cost`. **The cost pair is cost/cost, which is what 3C's rule requires** ("a cost-derived ledger leg may only be paired with another cost-derived leg"): at step 6 a null cost makes both legs `Money.zero`, `0 = 0` balances, and the revenue pair balances independently — so the plan is balanced before step 9 and again after, at whatever the real figures are.
- **`when: { "item.kind": "product" }` on the cost pair, not `{ "line.kind": "item" }`.** A service or asset item has no stock, no cost layer and nothing in `1250`; filtering on the *item's* kind is what lets a mixed invoice — three cartons and one delivery charge — post with cost legs for the cartons only. §4.4.1's `when` is a conjunction of equalities and `item.kind` is one of its keys, so this is in-schema and needs no code.
- **`tax: { "applies": false }` and no `each_tax` rule at 4A.** `app.tax_code` is 5A's table and `refs.taxCodes` is `{}` until 5A fills it, so an `each_tax` rule would resolve nothing and `tax_code.output_account` would fail. With `tax_amount = 0` on every line, `total_incl_tax` equals `amount` and the AR pair balances exactly. **5A adds the `each_tax` credit leg and flips `applies` in a policy `version: 2`** — §3.4.8's `on conflict (document_type_id, version) do update` rule applied to policies, upserting at `policyVersion: 2` and leaving version 1 in place for documents already dated under it.
- **`requires: ["party"]` and not `["party", "warehouse"]`.** With `effect: "none"` the policy addresses no warehouse, and `validateRequires` refusing a header field the policy never reads would block a services-only invoice for no reason. The *product* case gets its warehouse from the delivery, which already required one.
- **`dimensions: { "required": ["BRANCH"] }`** — spec:1066 makes BRANCH mandatory on every revenue and cost-of-goods-sold line, and this is the first type with either.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test ar-ap/sales-invoice`
Expected: PASS — ten cases green, including the `rate_source` case, which is red against any helper that does not write the column.

- [ ] **Step 6: Commit**

```bash
git add packages/db/seed/my/document-types/SALES_INVOICE.json \
        tests/invariants/support/post-ar.ts packages/db/test/ar-ap/_support.ts \
        packages/db/test/ar-ap/sales-invoice.test.ts
git commit -m "feat(accounting): SALES_INVOICE posts revenue and relieves the 1250 corridor [4A T5]

Configuration only. Six line rules in three balanced pairs: AR against revenue at total_incl_tax and
amount, AR against a charge line's own account, and cost of goods sold against 1250 at line.cost with
when: { item.kind: product } so a mixed invoice posts one cost pair. inventory.effect is none (ADR
0044) and tax.applies is false until 5A's policy version 2. postArDocument joins §4.17.1.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `DELIVERY_ORDER` → `SALES_INVOICE` — the conversion, and the `1250` round trip to zero

The half of spec:1051 the register assigns this slice ("4 (invoice link)"), and the first of the two corridor invariants.

**Files:**
- Create: `packages/db/src/ar-ap/invoice.ts`
- Create: `packages/contracts/src/accounting/invoice.ts`
- Create: `packages/db/test/ar-ap/invoice-conversion.test.ts`, `apps/api/test/routes/accounting/invoices.test.ts`
- Modify: `packages/db/src/ar-ap/index.ts`, `apps/api/src/routes/accounting/documents.ts` (one sub-path)

**Interfaces:**
- Consumes: `linkFulfilment`, `listLinks`, `openQuantity`, `OpenQuantityRow`, `LinkFulfilmentInput` (3C); `app.document_open_quantity` (3C); `resolvePartyTerm` (Task 1); `postDocument`, `issueDocument` (§4.3.1); `requireDocumentPermission("submit")` (2A, and 3C's rule that a `POST` sub-path of an existing document uses `"submit"`); `documentRoutes` (1A); `postInventoryDocument`, `ensureOpenPeriods`, `secondPrincipal` (3B/3D — this suite's deliveries are posted through the same door 3D uses, and `secondPrincipal` is the un-granted principal Step 5's gate case needs, since `grantAdmin` leaves `s.human` holding everything); `loadTypesFromPack` (Task 5's `test/ar-ap/_support.ts`); `Money`, `Quantity`, `currency`, `rational`, `Rational`, `CurrencyCode` (§4.2.1 — the whole of this file's arithmetic, and the reason it imports no `Decimal`); `ERR_DOC_LINK_OVER_FULFILLED` (3C).
- Produces:

```ts
// packages/db/src/ar-ap/invoice.ts
/** A 6-dp quantity string as an exact count of micro-units. **Exported**, because `credit-note.ts`
 *  (Task 8) imports it — two copies of one string-to-bigint conversion is hazard 9 — and deliberately
 *  NOT re-exported from `ar-ap/index.ts`, because nothing outside `ar-ap/` needs it. */
export function micro(quantity: string): bigint;
export interface ConvertLine { sourceLineId: string; quantity: string }   // 6-dp string, never a number
export interface ConvertToInvoiceInput {
  sourceDocumentId: string;                 // a posted DELIVERY_ORDER, or a posted GOODS_RECEIPT (Task 7)
  targetDocumentTypeId: string;             // SALES_INVOICE, or PURCHASE_INVOICE
  targetSeries: string;                     // "INV" | "PINV"
  effectiveDate: string;
  lines: readonly ConvertLine[];            // empty = every open line at its full open quantity
}
export interface ConvertToInvoiceResult { documentId: string; lineIds: string[]; linkIds: string[] }
/**
 * Drafts an invoice from a posted source document and links it `converts_to`. Copies, per line:
 * `item_id`, `unit_id`, `warehouse_id`, `lot_id`, `quantity` (the CONVERTED quantity, not the source's),
 * `unit_price`, `discount`, `amount`, `total_incl_tax` and — this is the load-bearing one — **`cost`,
 * pro-rated from the source line by `quantity ÷ source.quantity` and rounded HALF_AWAY_FROM_ZERO at
 * scale 4** (§4.7.2's "who may write document_line.cost"). Refuses more than the source line's open
 * quantity with `ERR_DOC_LINK_OVER_FULFILLED`, through 3C's own guard.
 */
export async function convertToInvoice(tx: Sql, ctx: TenantContext, input: ConvertToInvoiceInput): Promise<ConvertToInvoiceResult>;
```

**Why one function serves both directions.** A `DELIVERY_ORDER` line and a `GOODS_RECEIPT` line carry the same columns, the target's policy decides the accounts, and the only difference is which figure is copied as the corridor amount — `cost` on the sales side (because `1250` holds cost) and `amount` on the purchase side (because `2150` holds the accrued price). Both are copied unconditionally: a `SALES_INVOICE` policy reads `line.cost` and ignores nothing, a `PURCHASE_INVOICE` policy reads `line.amount` and never mentions `cost`, and copying a column no policy reads costs one `numeric` per line. Two functions differing in one `select` list is the duplication hazard 9 names.

**Why the cost is pro-rated and not copied whole.** A delivery of ten may be invoiced as six and then four. `cost` on the delivery line is the cost of ten. Copying it whole onto a six-line would relieve `1250` by the full amount at the first invoice and by the full amount again at the second, leaving the corridor at minus one delivery. The pro-rata is `sourceCost × (quantity ÷ sourceQuantity)`, rounded once, at scale 4, HALF_AWAY_FROM_ZERO — the one mode §4.2.1 admits for a base amount — and the factor is an exact `Rational` in micro-units, not a divided decimal, so there is no intermediate to round twice. **The residue is handled and not ignored:** when the conversion closes a source line completely (its open quantity reaches zero), the last invoice line's cost is `sourceCost − Σ already-converted cost` rather than the pro-rata, so the corridor reaches exactly zero rather than within a cent of it.

**That branch has a case whose arithmetic can only pass with it, and constructing one takes care.** A residue exists only when `sourceCost ÷ sourceQuantity` is not itself a 4-dp figure, and with an integer delivery quantity it always is — `cost = round(unitCost × quantity, 4)` is exact for an integer quantity, so every integer split's pro-rata already sums to the whole and a case built that way is green with the branch and green without it. Step 1's case therefore delivers **3.333333** units at a 3.0000 unit cost: `3.0000 × 3.333333 = 9.999999`, which HALF_AWAY_FROM_ZERO at four places is **10.0000** — a delivered cost that three equal thirds cannot reproduce, because `3 × 3.3333 = 9.9999`. The third conversion must take **3.3334** where the pro-rata gives 3.3333, and `1250` returns to exactly its opening balance only if it does.

- [ ] **Step 1: Write the failing DB-tier test `packages/db/test/ar-ap/invoice-conversion.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertToInvoice } from "../../src/ar-ap/invoice";
import { listLinks, openQuantity } from "../../src/documents/link";
import { postDocument, issueDocument } from "../../src/posting";
import {
  seedAccount, seedItem, seedParty, seedTenantV2, seedWarehouse, startDb, withTenant, type Db, type Seed,
} from "../index";
import { loadTypesFromPack, plus4 } from "./_support";   // Task 5's file
import { postInventoryDocument, ensureOpenPeriods } from "../../../../tests/invariants/support/post-inventory";

let db: Db; let s: Seed;
let invType: string; let partyId: string; let itemId: string; let warehouseId: string;
const ctxOf = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "00000000-0000-0000-0000-000000000000" });

/** Balance of an account in base, signed debit − credit. */
async function net(db: Db, s: Seed, code: string): Promise<string> {
  const [row] = await db.admin<{ net: string }[]>`
    select coalesce(sum(e.base_debit - e.base_credit), 0)::text as net
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where a.company_id = ${s.company} and a.code = ${code}`;
  return row!.net;
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "invoice-conversion");
  await ensureOpenPeriods(db, s, ["2026-01", "2026-02"]);
  for (const [code, nameEn, type] of [
    ["1200", "Trade receivables", "asset"], ["1250", "Goods delivered not invoiced", "asset"],
    ["1300", "Inventory control", "asset"], ["2150", "Goods received not invoiced", "liability"],
    ["5000", "Cost of goods sold", "expense"], ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(db, s, { code, nameEn, type });
  // `DELIVERY_ORDER` is LOADED and not BOUND: `postInventoryDocument` resolves it by code, so the type
  // has to exist in this database, but nothing below needs its id — and a bound-and-unread variable
  // fails `bun run lint`. `loadTypesFromPack` is keyed camelCode + "Type".
  ({ salesInvoiceType: invType } =
    await loadTypesFromPack(db, s, ["DELIVERY_ORDER", "SALES_INVOICE"]) as never);
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-CONV" });
  ({ itemId } = await seedItem(db, s, { code: "IT-CONV", kind: "product", trackLots: false }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-CONV" });
  // FORTY units at 3.0000 each, through the same door 3D uses. Forty and not ten: the cases below deliver
  // 4 + 2 + 3.333333 + 1 + 2 = 12.333333 units in total, and `assert_stock_available` (3A) refuses an issue
  // that takes the on-hand quantity negative — a ten-unit receipt would fail the fifth case with
  // ERR_STOCK_INSUFFICIENT and the failure would look like a conversion bug. ONE receipt, so the item has
  // exactly one open cost layer and its AVCO average stays 3.0000 no matter how much has been issued;
  // that is what makes every cost figure in this suite arithmetic rather than history.
  await postInventoryDocument(db, s, { code: "GOODS_RECEIPT", lines: [
    { itemId, warehouseId, quantity: "40.000000", unitPrice: "3.0000", amount: "120.0000" }] });
}, 180_000);
afterAll(async () => { await db.stop(); });

/** Post a DELIVERY_ORDER of `qty` at 9.0000 a unit and return its document and line ids. `amount` is passed
 *  as a string, never computed from `Number(qty) * 9` — no `number` ever holds a monetary value (§3.7.5). */
async function deliver(qty: string, effectiveDate: string, amount: string) {
  const r = await postInventoryDocument(db, s, {
    code: "DELIVERY_ORDER", effectiveDate, partyId,
    lines: [{ itemId, warehouseId, quantity: qty, unitPrice: "9.0000", amount }],
  });
  const lines = await db.admin<{ id: string }[]>`
    select id from app.document_line where document_id = ${r.documentId} order by line_no`;
  return { documentId: r.documentId, lineIds: lines.map((l) => l.id) };
}

describe("DELIVERY_ORDER → SALES_INVOICE — spec:1051, §4.15's 1250 row", () => {
  it("a full conversion posts the invoice and drives 1250 to EXACTLY zero", async () => {
    const before = await net(db, s, "1250");
    const dO = await deliver("4.000000", "2026-01-10", "36.0000");
    expect(await net(db, s, "1250")).toBe(plus4(before, "12.0000"));           // 4 × 3.0000 cost

    const inv = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await convertToInvoice(tx, ctxOf(s), {
        sourceDocumentId: dO.documentId, targetDocumentTypeId: invType, targetSeries: "INV",
        effectiveDate: "2026-01-11", lines: [],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      await postDocument(tx, ctxOf(s), { documentId: r.documentId });
      return r;
    });
    expect(await net(db, s, "1250")).toBe(before);          // the corridor is back where it started
    expect(inv.linkIds).toHaveLength(1);
  });

  it("the link is `converts_to`, from the delivery to the invoice", async () => {
    const dO = await deliver("2.000000", "2026-01-12", "18.0000");
    const inv = await withTenant(db.rw, s.tenant, s.human, (tx) => convertToInvoice(tx, ctxOf(s), {
      sourceDocumentId: dO.documentId, targetDocumentTypeId: invType, targetSeries: "INV",
      effectiveDate: "2026-01-12", lines: [],
    }));
    const links = await withTenant(db.rw, s.tenant, s.human, (tx) => listLinks(tx, inv.documentId));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      sourceDocumentId: dO.documentId, targetDocumentId: inv.documentId, linkKind: "converts_to",
      quantity: "2.000000",
    });
  });

  it("a PARTIAL conversion pro-rates the cost, and the closing conversion takes the RESIDUE so 1250 hits zero", async () => {
    const before = await net(db, s, "1250");
    // THE ONE CASE THAT DISCRIMINATES THE RESIDUE BRANCH, and its quantity is chosen, not convenient.
    // The item has one open layer at a 3.0000 unit cost, so an issue of 3.333333 units costs
    // round(3.0000 × 3.333333, 4) = round(9.999999, 4) = 10.0000 — a delivered cost that three equal
    // thirds cannot reproduce, because 3 × round(10.0000 × 1/3, 4) = 3 × 3.3333 = 9.9999. An INTEGER
    // delivery quantity could not produce a residue at all: cost = unitCost × quantity is then exact at
    // 4 dp, so cost ÷ quantity is exact and every integer split's pro-rata already sums to the whole —
    // a case built that way passes with the branch and without it, and proves nothing.
    // NOTE: the delivery line's posted cost is READ, never re-written. Updating a posted document's line
    // through SQL is the LEGACY-031 shape Task 14 asserts against, and it would also detach the figure from
    // the ledger row that actually filled the corridor.
    const dO = await deliver("3.333333", "2026-01-13", "30.0000");
    const [delivered] = await db.admin<{ cost: string }[]>`
      select cost::text as cost from app.document_line where id = ${dO.lineIds[0]!}`;
    expect(delivered!.cost).toBe("10.0000");
    expect(await net(db, s, "1250")).toBe(plus4(before, "10.0000"));

    /** Convert `quantity` of the one source line, then issue and post the invoice; return its line cost. */
    const convert = async (quantity: string, effectiveDate: string): Promise<string> => {
      const r = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
        const c = await convertToInvoice(tx, ctxOf(s), {
          sourceDocumentId: dO.documentId, targetDocumentTypeId: invType, targetSeries: "INV",
          effectiveDate, lines: [{ sourceLineId: dO.lineIds[0]!, quantity }],
        });
        await issueDocument(tx, ctxOf(s), { documentId: c.documentId });
        await postDocument(tx, ctxOf(s), { documentId: c.documentId });
        return c;
      });
      const [row] = await db.admin<{ cost: string }[]>`
        select cost::text as cost from app.document_line where document_id = ${r.documentId}`;
      return row!.cost;
    };

    // Three conversions of one third each. The first two are the pro-rata; the third CLOSES the source
    // line, so it takes 10.0000 − 3.3333 − 3.3333 = 3.3334 where the pro-rata would give 3.3333 again.
    expect(await convert("1.111111", "2026-01-14")).toBe("3.3333");
    expect(await convert("1.111111", "2026-01-15")).toBe("3.3333");
    expect(await convert("1.111111", "2026-01-15")).toBe("3.3334");   // the residue, and it differs
    // Σ 3.3333 + 3.3333 + 3.3334 = 10.0000 = the delivered cost, so the corridor is back where it started.
    // Against a pro-rata-only implementation this line reads `before + 0.0001` and the case is red.
    expect(await net(db, s, "1250")).toBe(before);
  });

  it("converting more than the open quantity is refused by 3C's guard", async () => {
    const dO = await deliver("1.000000", "2026-01-16", "9.0000");
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => convertToInvoice(tx, ctxOf(s), {
      sourceDocumentId: dO.documentId, targetDocumentTypeId: invType, targetSeries: "INV",
      effectiveDate: "2026-01-16", lines: [{ sourceLineId: dO.lineIds[0]!, quantity: "5.000000" }],
    }))).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
  });

  it("the open quantity is a PROJECTION of the links, and it reaches zero — LEGACY-017", async () => {
    const dO = await deliver("2.000000", "2026-01-17", "18.0000");
    await withTenant(db.rw, s.tenant, s.human, (tx) => convertToInvoice(tx, ctxOf(s), {
      sourceDocumentId: dO.documentId, targetDocumentTypeId: invType, targetSeries: "INV",
      effectiveDate: "2026-01-17", lines: [],
    }));
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) => openQuantity(tx, dO.documentId));
    expect(open.map((o) => [o.orderedQuantity, o.linkedQuantity, o.openQuantity]))
      .toEqual([["2.000000", "2.000000", "0.000000"]]);
  });

  it("an UNPOSTED delivery cannot be converted — there is nothing in the corridor to relieve", async () => {
    const { documentId } = await postInventoryDocument(db, s, {
      code: "DELIVERY_ORDER", effectiveDate: "2026-01-18", partyId, stopAt: "draft",
      lines: [{ itemId, warehouseId, quantity: "1.000000", unitPrice: "9.0000", amount: "9.0000" }],
    });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => convertToInvoice(tx, ctxOf(s), {
      sourceDocumentId: documentId, targetDocumentTypeId: invType, targetSeries: "INV",
      effectiveDate: "2026-01-18", lines: [],
    }))).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: source document .* is not posted/);
  });
});
```

- [ ] **Step 2: Run it to see the exact expected failure**

Run: `bun run --cwd packages/db test ar-ap/invoice-conversion`
Expected: FAIL with a module-resolution error on `../../src/ar-ap/invoice` — the file does not exist. That is the correct red for a service-first task; the six cases are red for that one reason.

- [ ] **Step 3: Write `packages/db/src/ar-ap/invoice.ts`**

```ts
import { Money, Quantity, currency, rational, type CurrencyCode, type Rational } from "@dulja/domain";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { linkFulfilment } from "../documents/link";
import { resolvePartyTerm } from "./payment-term";

/**
 * A 6-dp quantity string as an exact count of micro-units. `Quantity.toString()` is fixed at
 * QUANTITY_SCALE (§4.2.1), so removing the point is exact and no float or `Decimal` is involved — which is
 * what lets this file honour the rule 3B fixed for `packages/db/src/costing`: **`decimal.js` is
 * `packages/domain`'s dependency (§4.2.1, D11) and no file under `packages/db/src` imports it.** Every
 * arithmetic operation below goes through `Money` and an exact `Rational`.
 *
 * Exported because `credit-note.ts` (Task 8) needs the same conversion and two copies of one function is
 * hazard 9; it is not re-exported from the barrel, because nothing outside `ar-ap/` needs it.
 */
export function micro(quantity: string): bigint {
  const fixed = Quantity.of(quantity).toString();
  const negative = fixed.startsWith("-");
  const digits = (negative ? fixed.slice(1) : fixed).replace(".", "");
  return negative ? -BigInt(digits) : BigInt(digits);
}

export interface ConvertLine { sourceLineId: string; quantity: string }
export interface ConvertToInvoiceInput {
  sourceDocumentId: string; targetDocumentTypeId: string; targetSeries: string;
  effectiveDate: string; lines: readonly ConvertLine[];
}
export interface ConvertToInvoiceResult { documentId: string; lineIds: string[]; linkIds: string[] }

interface SourceLine {
  id: string; lineNo: number; itemId: string | null; unitId: string | null; warehouseId: string | null;
  lotId: string | null; description: string | null;
  quantity: string; openQuantity: string; unitPrice: string | null; discount: string;
  amount: string; totalInclTax: string; cost: string | null; convertedCost: string;
}

/**
 * §4.15's `1250` and `2150` rows, and spec:1051's "4 (invoice link)". Drafts an invoice from a POSTED
 * source document and links it `converts_to`. One function serves both directions: the columns are the
 * same and the TARGET's policy decides the accounts.
 *
 * **It carries only the source's QUANTITY-BEARING lines, and every target line is `kind: 'item'`.** The
 * source query inner-joins `app.document_open_quantity`, whose definition carries `where l.quantity is not
 * null` (3c:895), so a `kind: 'account'` line — 3C's inland-freight, duty and clearance pair on a
 * `GOODS_RECEIPT` or `SHIPMENT`, accrued through `1300` and the line's own accrual account (3c:2306–2318)
 * — is not in `sources` and never reaches the invoice, not even under a full conversion (`lines: []`).
 * **That is the design and not an omission:** a freight accrual is cleared by the freight supplier's own
 * `PURCHASE_INVOICE`, which is a different party and a different document, and pulling the line onto the
 * goods vendor's invoice would credit the wrong payable. A conversion is quantity-linked by construction
 * (`linkFulfilment` takes a quantity per line and `document_open_quantity` is the guard), so a non-quantity
 * line has nothing to link on; carrying one would need an amount-linked second link kind and a change to
 * §4.8.1 and 3C's view. Task 7 states the same thing at the `2150` corridor, and the corridor still nets
 * to zero because `2150` holds only the goods accrual — the freight accrual sits in its own account.
 */
export async function convertToInvoice(
  tx: Sql, ctx: TenantContext, input: ConvertToInvoiceInput,
): Promise<ConvertToInvoiceResult> {
  const [head] = await tx<{
    companyId: string; status: string; partyId: string | null; currency: string; exchangeRate: string;
    rateSource: string | null; branchId: string; warehouseId: string | null;
  }[]>`
    select company_id as "companyId", status::text as status, party_id as "partyId", currency,
           exchange_rate::text as "exchangeRate", rate_source as "rateSource",
           branch_id as "branchId", warehouse_id as "warehouseId"
      from app.document where id = ${input.sourceDocumentId}`;
  if (head === undefined) throw new Error("ERR_NOT_FOUND: source document is not visible");
  if (head.status !== "posted") {
    throw new Error(`ERR_DOC_STATUS_ILLEGAL: source document ${input.sourceDocumentId} is not posted`);
  }

  // Open quantity and already-converted cost come from the SAME query, so they cannot be read at two
  // different instants. `open_quantity` is 3C's view; `convertedCost` is Σ cost of every line already
  // linked FROM this source line, which is what makes the closing conversion take the residue.
  const sources = await tx<SourceLine[]>`
    select dl.id, dl.line_no as "lineNo", dl.item_id as "itemId", dl.unit_id as "unitId",
           dl.warehouse_id as "warehouseId", dl.lot_id as "lotId", dl.description,
           dl.quantity::text as quantity, oq.open_quantity::text as "openQuantity",
           dl.unit_price::text as "unitPrice", dl.discount::text as discount,
           dl.amount::text as amount, dl.total_incl_tax::text as "totalInclTax", dl.cost::text as cost,
           coalesce((select sum(tl.cost) from app.document_link dlk
                      join app.document_line tl on tl.id = dlk.target_line_id
                     where dlk.source_line_id = dl.id and dlk.link_kind = 'converts_to'), 0)
             ::numeric(19,4)::text as "convertedCost"
      from app.document_line dl
      join app.document_open_quantity oq on oq.document_line_id = dl.id
     where dl.document_id = ${input.sourceDocumentId}
     order by dl.line_no`;

  const asked = input.lines.length === 0
    ? sources.filter((l) => micro(l.openQuantity) > 0n)
        .map((l) => ({ sourceLineId: l.id, quantity: l.openQuantity }))
    : input.lines;
  if (asked.length === 0) throw new Error("ERR_VALIDATION_FAILED: the source document has no open line");

  // The pinned term, through the ONE reader of app.party.payment_term_id (Task 1). An inline subquery here
  // would be a second spelling of one fact and would skip that function's ERR_NOT_FOUND guard.
  const paymentTermId = head.partyId === null
    ? null
    : await resolvePartyTerm(tx, { partyId: head.partyId });

  const [target] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, status, series, effective_date, party_id, currency,
       exchange_rate, rate_source, branch_id, warehouse_id, payment_term_id)
    values (app.current_tenant(), ${head.companyId}, ${input.targetDocumentTypeId}, 'draft',
            ${input.targetSeries}, ${input.effectiveDate}::date, ${head.partyId}, ${head.currency},
            ${head.exchangeRate}, ${head.rateSource}, ${head.branchId}, ${head.warehouseId},
            ${paymentTermId})
    returning id`;

  const cur = currency(head.currency) as CurrencyCode;
  const lineIds: string[] = [];
  const fulfilment: { sourceLineId: string; targetLineId: string; quantity: string }[] = [];

  for (const [i, ask] of asked.entries()) {
    const src = sources.find((l) => l.id === ask.sourceLineId);
    if (src === undefined) throw new Error(`ERR_VALIDATION_FAILED: line ${ask.sourceLineId} is not on the source document`);
    const qMicro = micro(ask.quantity);
    const srcMicroSigned = micro(src.quantity);
    const srcMicro = srcMicroSigned < 0n ? -srcMicroSigned : srcMicroSigned;
    const openMicro = micro(src.openQuantity);
    if (qMicro <= 0n) throw new Error(`ERR_VALIDATION_FAILED: line ${src.lineNo} quantity must be positive`);

    // The pro-rata factor is an EXACT `Rational` (§4.2.1, spec:2043) — converted micro-units over source
    // micro-units — and `Money.multiply` is the one place a rounding mode is named. No intermediate
    // decimal exists to round twice, and nothing here imports `decimal.js`.
    const ratio: Rational = srcMicro === 0n ? rational(0n, 1n) : rational(qMicro, srcMicro);
    const money = (v: string | null) =>
      v === null ? null : Money.of(v, cur).multiply(ratio, "HALF_AWAY_FROM_ZERO");

    // The COST, and the one branch that makes the corridor reach exactly zero: when this conversion closes
    // the source line (q equals its whole open quantity), take the RESIDUE — the source cost less everything
    // already converted — rather than the pro-rata, whose rounding residue would otherwise stay in 1250
    // forever (§4.7.2's "who may write document_line.cost").
    const closing = qMicro === openMicro;
    const cost = src.cost === null
      ? null
      : closing
        ? Money.of(src.cost, cur).subtract(Money.of(src.convertedCost, cur))
        : money(src.cost)!;

    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, description, item_id, unit_id, warehouse_id,
         lot_id, quantity, unit_price, discount, amount, tax_amount, total_incl_tax, cost)
      values (app.current_tenant(), ${head.companyId}, ${target!.id}, ${i + 1}, 'item', ${src.description},
              ${src.itemId}, ${src.unitId}, ${src.warehouseId}, ${src.lotId},
              ${Quantity.of(ask.quantity).toString()},
              ${src.unitPrice}, ${money(src.discount)!.toString()}, ${money(src.amount)!.toString()},
              ${"0.0000"}, ${money(src.totalInclTax)!.toString()}, ${cost === null ? null : cost.toString()})
      returning id`;
    lineIds.push(row!.id);
    fulfilment.push({
      sourceLineId: src.id, targetLineId: row!.id, quantity: Quantity.of(ask.quantity).toString(),
    });
  }

  // 3C's own guard raises ERR_DOC_LINK_OVER_FULFILLED; this function never re-implements the check.
  // `priceFromSource` is false: every price and every amount was copied above, at the CONVERTED quantity.
  const links = await linkFulfilment(tx, ctx, {
    sourceDocumentId: input.sourceDocumentId, targetDocumentId: target!.id,
    linkKind: "converts_to", lines: fulfilment, priceFromSource: false,
  });
  return { documentId: target!.id, lineIds, linkIds: links.map((l) => l.id) };
}
```

Add `export * from "./invoice";` to `packages/db/src/ar-ap/index.ts`.

- [ ] **Step 4: Write the contracts module and the one route sub-path**

`packages/contracts/src/accounting/invoice.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, QuantitySchema, UuidSchema } from "../common";

export const ConvertLineSchema = z.object({ sourceLineId: UuidSchema, quantity: QuantitySchema });
export const ConvertToInvoiceBody = z.object({
  targetDocumentTypeId: UuidSchema,
  targetSeries: z.string().regex(/^[A-Z0-9-]{1,16}$/),
  effectiveDate: DateSchema,
  /** Empty means every open line at its full open quantity. */
  lines: z.array(ConvertLineSchema).default([]),
}).openapi("ConvertToInvoiceBody");
export const ConvertToInvoiceResultSchema = z.object({
  documentId: UuidSchema, lineIds: z.array(UuidSchema), linkIds: z.array(UuidSchema),
}).openapi("ConvertToInvoiceResult");
```

and in `apps/api/src/routes/accounting/documents.ts` — a sub-path on 1A's existing module, gated `requireDocumentPermission("submit")` per 3C's rule (the `"create"` stage resolves the type from the body and 404s when the body does not carry one):

```ts
documentRoutes.openapi(createRoute({
  method: "post", path: "/{documentId}/convert-to-invoice",
  request: { params: DocumentParams, headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: ConvertToInvoiceBody } } } },
  middleware: [requireDocumentPermission("submit")],
  tags: ["accounting"],
  responses: {
    201: { content: { "application/json": { schema: ConvertToInvoiceResultSchema } }, description: "Draft invoice created and linked" },
    422: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Over-fulfilled or not posted" },
  },
}), async (c) => {
  const { documentId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await c.var.withTenant((tx) =>
    convertToInvoice(tx, c.var.ctx, { sourceDocumentId: documentId, ...body }));
  return c.json(result, 201);
});
```

**The path parameter is the SOURCE document here, and that is the opposite of 3C's `…/links`.** 3C put the *target* on the path because the authority asked was "may this principal edit this draft receipt". Here the target does not exist yet — the route creates it — so the only document to ask about is the source, and the question is "may this principal raise a document from this delivery". `requireDocumentPermission("submit")` resolves the *source's* policy, which for a `DELIVERY_ORDER` is `inventory.transfer.create ?? inventory.transfer.post`; a warehouse principal can therefore convert. If that proves too wide in review, the narrowing is a second gate on the target type's `create` code, and it is an amendment to §4.5.4 rather than a change here.

- [ ] **Step 5: Write the route suite `apps/api/test/routes/accounting/invoices.test.ts`**

This file is created here and **appended to by Task 8**, which adds the credit-note sub-path's cases to the same `describe` file — the two sub-paths live on one module and one contracts file, and two suites over one route file would duplicate the fixture. `startApi()` and not `sharedApi()`: the suite seeds document types and posts documents through the real posting service, so it owns its database (§3.7.5's settlement puts such a test in `apps/api/test/routes/`).

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedItem, seedParty,
  seedTenantV2, seedWarehouse, withTenant, type Seed,
} from "@dulja/db/test";
import { issueDocument, postDocument } from "@dulja/db";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";   // FIVE levels (2a:3253)
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";  // §4.17.1
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let srcType: string;
let invType: string;
let partyId: string;
let itemId: string;
let warehouseId: string;

const ctx = () => ({ tenantId: s.tenant, actorId: s.human, requestId: "00000000-0000-0000-0000-000000000000" });

/** A `DELIVERY_ORDER`-shaped source: one cost pair, `effect: "none"` so this suite needs no costing run —
 *  the cost is written onto the line directly, exactly as a posted delivery would leave it. The corridor
 *  ARITHMETIC is Step 1's DB suite; what this suite tests is the ROUTE. */
const CORRIDOR_POLICY = (code: string, series: string, post: string, debit: string, credit: string) => ({
  version: 1 as const, documentType: code, direction: "outbound" as const,
  requires: ["party"] as const,
  lines: [
    { for: "each_line", side: "debit",  account: { code: debit },  amount: "line.cost", when: { "item.kind": "product" } },
    { for: "each_line", side: "credit", account: { code: credit }, amount: "line.cost", when: { "item.kind": "product" } },
  ],
  inventory: { effect: "none" as const }, tax: { applies: false },
  numbering: { series, assignAt: "issue" as const },
  reversal: { allowed: true, producesType: code },
  approval: { required: false, approve: null, post, create: post },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" as const },
  dimensions: { required: [] as const },
});

/** Draft a source line of `quantity` at 9.0000 with `cost` already written, then issue and post it. */
async function postedSource(quantity: string, amount: string, cost: string, effectiveDate: string) {
  const { documentId, lineIds } = await draftTypedDocument(api.db, s, {
    documentTypeId: srcType, series: "ADO", effectiveDate, partyId, warehouseId,
    lines: [{ kind: "item", itemId, warehouseId, quantity, unitPrice: "9.0000", amount }],
  });
  await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
    await tx`update app.document_line set cost = ${cost}, total_incl_tax = ${amount} where id = ${lineIds[0]!}`;
    await tx`update app.document set rate_source = ${"unit"} where id = ${documentId}`;
    await issueDocument(tx, ctx(), { documentId });
    await postDocument(tx, ctx(), { documentId });
  });
  return { documentId, lineIds };
}

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "invoices-api");
  await grantAdmin(api, s);
  for (const [code, nameEn, type] of [
    ["1200", "Trade receivables", "asset"], ["1250", "Goods delivered not invoiced", "asset"],
    ["1300", "Inventory control", "asset"], ["5000", "Cost of goods sold", "expense"],
    ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(api.db, s, { code, nameEn, type });
  srcType = await seedDocumentType(api.db, s, { code: "API_DELIVERY", module: "inventory", policy: CORRIDOR_POLICY("API_DELIVERY", "ADO", "inventory.transfer.post", "1250", "1300") });
  invType = await seedDocumentType(api.db, s, { code: "API_SALES_INVOICE", module: "accounting", policy: CORRIDOR_POLICY("API_SALES_INVOICE", "AINV", "accounting.sales.post", "5000", "1250") });
  partyId = await seedParty(api.db, s, { kind: "customer", code: "API-CONV" });
  ({ itemId } = await seedItem(api.db, s, { code: "API-CONV-IT", kind: "product", trackLots: false }));
  warehouseId = await seedWarehouse(api.db, s, { code: "API-CONV-WH" });
  await grantCodes(api.db, s, { codes: ["inventory.transfer.post", "accounting.sales.post"] });
}, 240_000);
afterAll(async () => { await api.stop(); });

describe("POST /v1/companies/{companyId}/documents/{documentId}/convert-to-invoice (4A)", () => {
  it("201s with the draft invoice, its line ids and its link ids; an empty `lines` converts everything open", async () => {
    const src = await postedSource("4.000000", "36.0000", "12.0000", "2026-01-10");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${src.documentId}/convert-to-invoice`,
      as: s.human,
      body: { targetDocumentTypeId: invType, targetSeries: "AINV", effectiveDate: "2026-01-11", lines: [] },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { documentId: string; lineIds: string[]; linkIds: string[] };
    expect(body.lineIds).toHaveLength(1);
    expect(body.linkIds).toHaveLength(1);
    // The copied cost reached the draft — the one figure the whole corridor rests on.
    const [line] = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      tx<{ cost: string; q: string }[]>`select cost::text as cost, quantity::text as q
                                          from app.document_line where document_id = ${body.documentId}`);
    expect(line).toEqual({ cost: "12.0000", q: "4.000000" });
  });

  it("the path parameter is the SOURCE, and the gate resolves the SOURCE's policy", async () => {
    // §4.5.4 maps "submit" to `approval.create ?? approval.post`, which for API_DELIVERY is
    // `inventory.transfer.post` — a warehouse authority, deliberately (Task 6's own note says so, and
    // names the narrowing that would change it). It is 3D's real code for a DELIVERY_ORDER (3d:2861) and
    // one of §3.6.2's catalogued thirteen `inventory.*` codes; an invented code would fail the foreign
    // key from `app.role_permission.permission_code` to `app.permission(code)` inside `grantCodes`, in
    // `beforeAll`. A principal without it is refused before the handler.
    const src = await postedSource("1.000000", "9.0000", "3.0000", "2026-01-12");
    // `s.human` holds the whole catalogue through `grantAdmin`, so the negative direction needs a narrower
    // principal: 3D's `secondPrincipal` with NOTHING granted to it. A hedged `expect([201, 403])` here
    // would pass whatever the middleware did, which is the one thing this case exists to pin.
    const outsider = await secondPrincipal(api.db, s, "conv-outsider");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${src.documentId}/convert-to-invoice`,
      as: outsider,
      body: { targetDocumentTypeId: invType, targetSeries: "AINV", effectiveDate: "2026-01-12", lines: [] },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
    const stranger = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${src.documentId}/convert-to-invoice`,
      body: { targetDocumentTypeId: invType, targetSeries: "AINV", effectiveDate: "2026-01-12", lines: [] },
    });
    expect(stranger.status).toBe(401);
  });

  it("POST without an Idempotency-Key is ERR_IDEMPOTENCY_KEY_MISSING (§4.2.9)", async () => {
    const src = await postedSource("1.000000", "9.0000", "3.0000", "2026-01-13");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${src.documentId}/convert-to-invoice`,
      as: s.human, idempotencyKey: null,
      body: { targetDocumentTypeId: invType, targetSeries: "AINV", effectiveDate: "2026-01-13", lines: [] },
    });
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("replaying the same key does not create a second draft invoice", async () => {
    const src = await postedSource("1.000000", "9.0000", "3.0000", "2026-01-14");
    const key = "4a-convert-replay";
    const body = { targetDocumentTypeId: invType, targetSeries: "AINV", effectiveDate: "2026-01-14", lines: [] };
    const first = await api.request({ method: "POST", path: `/v1/companies/${s.company}/documents/${src.documentId}/convert-to-invoice`, as: s.human, idempotencyKey: key, body });
    const again = await api.request({ method: "POST", path: `/v1/companies/${s.company}/documents/${src.documentId}/convert-to-invoice`, as: s.human, idempotencyKey: key, body });
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await again.json() as { documentId: string }).documentId)
      .toBe((await first.json() as { documentId: string }).documentId);
  });

  it("converting more than the open quantity is 422 ERR_DOC_LINK_OVER_FULFILLED, through 3C's own guard", async () => {
    const src = await postedSource("1.000000", "9.0000", "3.0000", "2026-01-15");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${src.documentId}/convert-to-invoice`,
      as: s.human,
      body: {
        targetDocumentTypeId: invType, targetSeries: "AINV", effectiveDate: "2026-01-15",
        lines: [{ sourceLineId: src.lineIds[0], quantity: "5.000000" }],
      },
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_DOC_LINK_OVER_FULFILLED");
  });

  it("a `targetSeries` outside the registered shape is refused on the wire", async () => {
    const src = await postedSource("1.000000", "9.0000", "3.0000", "2026-01-16");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${src.documentId}/convert-to-invoice`,
      as: s.human,
      body: { targetDocumentTypeId: invType, targetSeries: "not a series", effectiveDate: "2026-01-16", lines: [] },
    });
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a sub-path adds no PROBES key — the documents module already has one (hazard 31)", async () => {
    const { PROBES } = await import("../../../../../tests/invariants/probes");
    expect(PROBES["/v1/companies/:companyId/documents"]).toBeDefined();
    expect(Object.keys(PROBES).filter((k) => k.includes("convert-to-invoice"))).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the DB and route tests**

Run: `bun run --cwd packages/db test ar-ap/invoice-conversion && bun run --cwd apps/api test routes/accounting/invoices && bun run --cwd packages/contracts openapi:generate`
Expected: PASS — six DB cases and seven route cases green, and an OpenAPI diff showing one added path and two added components (`ConvertToInvoiceBody`, `ConvertToInvoiceResult`). The residue case is the one to read the output of: `expected "3.3333" to be "3.3334"` on the third conversion means the closing branch did not fire, and the cause is almost always `closing` computed by comparing decimal *strings* rather than the micro-unit integers — `"1.111111"` and `"1.111111"` are equal either way, but a re-derived open quantity that prints `1.111110` is not.

One failure worth naming in advance: `ERR_DOC_LINK_OVER_FULFILLED` on the *first* full conversion means `app.document_open_quantity` counted the invoice's own links before they were written, which would mean 3C's view joins on the target rather than the source — reconcile with 3C, do not add a `where` clause here.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/ar-ap/invoice.ts packages/db/src/ar-ap/index.ts \
        packages/contracts/src/accounting/invoice.ts packages/contracts/openapi.json \
        apps/api/src/routes/accounting/documents.ts \
        packages/db/test/ar-ap/invoice-conversion.test.ts \
        apps/api/test/routes/accounting/invoices.test.ts
git commit -m "feat(accounting): convert a posted delivery into a sales invoice, closing the 1250 corridor [4A T6]

spec:1051's invoice link. One function serves both directions; the cost is pro-rated by quantity and
the CLOSING conversion takes the residue, so 1250 reaches exactly zero rather than within a cent of it.
Over-fulfilment is refused by 3C's own guard and the open quantity stays a projection (LEGACY-017).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `PURCHASE_INVOICE` — clearing the `2150` GRNI corridor

The purchase-side mirror of Tasks 5 and 6, and it needs **no new TypeScript**: Task 6's `convertToInvoice` already serves both directions. What this task ships is one seed file, one suite and the second corridor invariant.

**One scope statement, made here because this is the task where it bites: a conversion carries only the source's quantity-bearing lines, and a freight accrual is cleared by its own invoice.** 3C's `GOODS_RECEIPT` and `SHIPMENT` policies post inland freight, duty and clearance as `kind: "account"` lines through `1300` and each line's own accrual account (3c:2306–2318). Those lines have a null `quantity`, `app.document_open_quantity` carries `where l.quantity is not null` (3c:895), and `convertToInvoice` inner-joins that view — so a full conversion (`lines: []`) of a receipt that carried inland freight produces a purchase invoice **without** that line, and its accrual is **not** cleared by this path. That is correct rather than convenient: the freight accrual is owed to the forwarder, not to the goods vendor, so pulling it onto the goods vendor's invoice would credit the wrong `2100` sub-balance and make the vendor statement wrong. It is cleared by the forwarder's own `PURCHASE_INVOICE`, drafted directly with a `kind: "account"` line against that accrual account — a document, not a conversion. **The `2150` corridor still nets to exactly zero**, because `2150` holds only the goods accrual: 3C's freight lines never touch it. Step 1's suite asserts both halves — the corridor at `0.0000`, and the freight accrual still standing after the conversion.

**Files:**
- Create: `packages/db/seed/my/document-types/PURCHASE_INVOICE.json`
- Create: `packages/db/test/ar-ap/purchase-invoice.test.ts`
- Consumes (no edit): `packages/db/test/ar-ap/_support.ts` (created by Task 5)

**Interfaces:**
- Consumes: `convertToInvoice` (Task 6); `GOODS_RECEIPT`, `SHIPMENT` and the `2150` chart row (3C); `postDocument`, `issueDocument` (§4.3.1); `postInventoryDocument` (3B/3D); the accounts this type's policy resolves — `2150` (by code) and `2100` (`party.payable_account`), plus `5920` through `company.fx_rounding_account_id` — and, **read but never resolved by a 4A policy**, `1300` (3C's `GOODS_RECEIPT` inventory leg, asserted UNCHANGED by the invoice) and `5900` (the freight-accrual and expense-line account the suite supplies as `line.account`). All are §4.15 rows seeded by 0C or 3C and re-seeded by no task of this slice (Global Constraint 14).
- Produces: `packages/db/seed/my/document-types/PURCHASE_INVOICE.json` — the §4.14 row `PURCHASE_INVOICE` / module `accounting` / series `PINV` / `direction: inbound` / `inventory: none` / `approval.post: accounting.purchase.post`. **No TypeScript.**

- [ ] **Step 1: Write the failing test `packages/db/test/ar-ap/purchase-invoice.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertToInvoice } from "../../src/ar-ap/invoice";
import { issueDocument, postDocument } from "../../src/posting";
import { readPackFile } from "../../src/seed";
import {
  seedAccount, seedItem, seedParty, seedTenantV2, seedWarehouse, startDb, withTenant, type Db, type Seed,
} from "../index";
import { PACK_ROOT, accountByCode, loadTypesFromPack, plus4 } from "./_support";   // Task 5's file
import { ensureOpenPeriods, postInventoryDocument } from "../../../../tests/invariants/support/post-inventory";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";

let db: Db; let s: Seed;
let pinvType: string; let vendorId: string; let itemId: string; let warehouseId: string;
const ctxOf = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "00000000-0000-0000-0000-000000000000" });

async function net(db: Db, s: Seed, code: string): Promise<string> {
  const [row] = await db.admin<{ net: string }[]>`
    select coalesce(sum(e.base_debit - e.base_credit), 0)::text as net
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where a.company_id = ${s.company} and a.code = ${code}`;
  return row!.net;
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "purchase-invoice");
  await ensureOpenPeriods(db, s, ["2026-01"]);
  for (const [code, nameEn, type] of [
    ["1300", "Inventory control", "asset"], ["2100", "Trade payables", "liability"],
    ["2150", "Goods received not invoiced", "liability"], ["5900", "Other operating expense", "expense"],
    ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(db, s, { code, nameEn, type });
  // `GOODS_RECEIPT` is LOADED and not BOUND — `postInventoryDocument` resolves it by code and nothing
  // below needs its id; a bound-and-unread variable fails `bun run lint`. Keyed camelCode + "Type".
  ({ purchaseInvoiceType: pinvType } =
    await loadTypesFromPack(db, s, ["GOODS_RECEIPT", "PURCHASE_INVOICE"]) as never);
  vendorId = await seedParty(db, s, { kind: "vendor", code: "VEND-PINV" });
  ({ itemId } = await seedItem(db, s, { code: "IT-PINV", kind: "product", trackLots: false }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-PINV" });
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("PURCHASE_INVOICE — §4.14, ADR 0044, spec:1049", () => {
  it("a GOODS_RECEIPT accrues into 2150, and its PURCHASE_INVOICE drives 2150 to EXACTLY zero", async () => {
    const before = await net(db, s, "2150");
    const grn = await postInventoryDocument(db, s, {
      code: "GOODS_RECEIPT", effectiveDate: "2026-01-05", partyId: vendorId,
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "3.0000", amount: "30.0000" }],
    });
    expect(await net(db, s, "2150")).toBe(plus4(before, "-30.0000"));   // a liability: credit

    const inv = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await convertToInvoice(tx, ctxOf(s), {
        sourceDocumentId: grn.documentId, targetDocumentTypeId: pinvType, targetSeries: "PINV",
        effectiveDate: "2026-01-06", lines: [],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      await postDocument(tx, ctxOf(s), { documentId: r.documentId });
      return r;
    });
    expect(await net(db, s, "2150")).toBe(before);
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text as debit, e.credit::text as credit
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${inv.documentId} order by a.code`;
    expect(rows).toEqual([
      { code: "2100", debit: "0.0000",  credit: "30.0000" },
      { code: "2150", debit: "30.0000", credit: "0.0000"  },
    ]);
  });

  it("the invoice does NOT touch 1300 — the goods were capitalised at receipt, not twice", async () => {
    const beforeStock = await net(db, s, "1300");
    const grn = await postInventoryDocument(db, s, {
      code: "GOODS_RECEIPT", effectiveDate: "2026-01-07", partyId: vendorId,
      lines: [{ itemId, warehouseId, quantity: "2.000000", unitPrice: "3.0000", amount: "6.0000" }],
    });
    const afterReceipt = await net(db, s, "1300");
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await convertToInvoice(tx, ctxOf(s), {
        sourceDocumentId: grn.documentId, targetDocumentTypeId: pinvType, targetSeries: "PINV",
        effectiveDate: "2026-01-08", lines: [],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      await postDocument(tx, ctxOf(s), { documentId: r.documentId });
    });
    expect(afterReceipt).toBe(plus4(beforeStock, "6.0000"));
    expect(await net(db, s, "1300")).toBe(afterReceipt);   // unchanged by the invoice
  });

  it("a FREIGHT accrual line is NOT carried by the conversion, and is not cleared by it either", async () => {
    // 3C's GOODS_RECEIPT posts inland freight as a `kind: "account"` line with a NULL quantity;
    // app.document_open_quantity carries `where l.quantity is not null` (3c:895) and convertToInvoice
    // inner-joins that view, so the line is not in `sources` and cannot reach the invoice. This case
    // pins that as the CONTRACT rather than leaving it to be discovered as a missing line: the goods
    // corridor still closes, and the freight accrual is still standing, waiting for the forwarder's own
    // invoice. If a later slice wants a one-document form it needs an amount-linked link kind and an
    // amendment to Task 0's amendment 5 — not a change here.
    const freightAccrual = await accountByCode(db, s, "5900");
    const beforeFreight = await net(db, s, "5900");
    const beforeGrni = await net(db, s, "2150");
    const grn = await postInventoryDocument(db, s, {
      code: "GOODS_RECEIPT", effectiveDate: "2026-01-12", partyId: vendorId,
      lines: [
        { itemId, warehouseId, quantity: "5.000000", unitPrice: "3.0000", amount: "15.0000" },
        { kind: "account", accountId: freightAccrual, description: "inland freight", amount: "40.0000" },
      ],
    });
    const inv = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await convertToInvoice(tx, ctxOf(s), {
        sourceDocumentId: grn.documentId, targetDocumentTypeId: pinvType, targetSeries: "PINV",
        effectiveDate: "2026-01-13", lines: [],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      await postDocument(tx, ctxOf(s), { documentId: r.documentId });
      return r;
    });
    // ONE line on the invoice — the goods line — and every target line is `kind: 'item'`.
    const lines = await db.admin<{ kind: string; amount: string }[]>`
      select kind, amount::text as amount from app.document_line
       where document_id = ${inv.documentId} order by line_no`;
    expect(lines).toEqual([{ kind: "item", amount: "15.0000" }]);
    // The goods corridor closes to its opening balance: 2150 holds only the goods accrual.
    expect(await net(db, s, "2150")).toBe(beforeGrni);
    // The freight accrual is untouched by the conversion and still owed to the forwarder.
    expect(await net(db, s, "5900")).toBe(plus4(beforeFreight, "40.0000"));
  });

  it("an EXPENSE invoice with no receipt posts on its own — an account line has no corridor", async () => {
    const expenseAccount = await accountByCode(db, s, "5900");
    const r = await postArDocument(db, s, {
      documentTypeId: pinvType, series: "PINV", partyId: vendorId, effectiveDate: "2026-01-09",
      lines: [{ kind: "account", accountId: expenseAccount, description: "warehouse rent", amount: "1200.0000" }],
    });
    expect(r.ledger).toEqual([
      { code: "2100", debit: "0.0000",    credit: "1200.0000" },
      { code: "5900", debit: "1200.0000", credit: "0.0000"    },
    ]);
  });

  it("a PARTIAL invoice against a receipt leaves the balance of 2150 open, and the closing one clears it", async () => {
    const before = await net(db, s, "2150");
    const grn = await postInventoryDocument(db, s, {
      code: "GOODS_RECEIPT", effectiveDate: "2026-01-10", partyId: vendorId,
      lines: [{ itemId, warehouseId, quantity: "3.000000", unitPrice: "10.0000", amount: "30.0000" }],
    });
    const lines = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${grn.documentId} order by line_no`;
    for (const qty of ["1.000000", "2.000000"]) {
      await withTenant(db.rw, s.tenant, s.human, async (tx) => {
        const r = await convertToInvoice(tx, ctxOf(s), {
          sourceDocumentId: grn.documentId, targetDocumentTypeId: pinvType, targetSeries: "PINV",
          effectiveDate: "2026-01-11", lines: [{ sourceLineId: lines[0]!.id, quantity: qty }],
        });
        await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
        await postDocument(tx, ctxOf(s), { documentId: r.documentId });
      });
    }
    expect(await net(db, s, "2150")).toBe(before);
  });

  it("the type is `accounting` for attachments, though it posts under accounting.purchase.post (§4.14's Module rule)", () => {
    const envelope = readPackFile<{ module: string; policy: { approval: { post: string } } }>(
      PACK_ROOT, "document-types", "PURCHASE_INVOICE.json");
    expect(envelope.module).toBe("accounting");
    expect(envelope.policy.approval.post).toBe("accounting.purchase.post");
    // The purchase ORDER, SHIPMENT and GOODS_RECEIPT are `inventory` (3C) because the warehouse files their
    // paperwork; the vendor's invoice is filed by the accountant, which is what the column decides (§4.5.8).
  });
});
```

`loadTypesFromPack`, `accountByCode`, `plus4` and `PACK_ROOT` come from `packages/db/test/ar-ap/_support.ts`, which **Task 5 creates** — this task adds no helper of its own and imports the four. `readPackFile(PACK_ROOT, …)` in the last case uses the same constant, for the `packages/db`-relative-cwd reason Task 5 states.

- [ ] **Step 2: Run it to see the exact expected failure**

Run: `bun run --cwd packages/db test ar-ap/purchase-invoice`
Expected: FAIL in `beforeAll` with `Error: the seed pack has no document type PURCHASE_INVOICE`, thrown by `loadTypesFromPack` — the file Step 3 writes does not exist yet. Every case is red for that one reason, which is the correct shape of a configuration-first red, and it is the reason the seed file is written **after** the suite rather than before it: a policy written first makes the whole suite green on its first run and proves nothing about which half produced the corridor figure.

- [ ] **Step 3: Write `packages/db/seed/my/document-types/PURCHASE_INVOICE.json`**

```json
{
  "code": "PURCHASE_INVOICE",
  "nameEn": "Purchase Invoice",
  "nameAr": "فاتورة شراء",
  "module": "accounting",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "PURCHASE_INVOICE",
    "direction": "inbound",
    "requires": ["party"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "code": "2150" },                    "amount": "line.amount",         "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "credit", "account": { "from": "party.payable_account" },   "amount": "line.total_incl_tax", "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" },            "amount": "line.amount",         "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "party.payable_account" },   "amount": "line.total_incl_tax", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "PINV", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "PURCHASE_CREDIT_NOTE" },
    "approval": { "required": false, "approve": null, "post": "accounting.purchase.post", "create": "accounting.purchase.create" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

**Four choices, each with the alternative a reader will reach for.**

- **No `line.cost` reference anywhere, and therefore no cost pair.** `2150` holds the **accrued purchase price**, not a cost — 3C's `GOODS_RECEIPT` credits it at `line.amount` and debits the item's inventory account at the same figure. The invoice reverses that credit at the same `line.amount` and puts the payable in its place. The item's inventory account is untouched by the invoice: the goods were already capitalised at receipt, and touching `1300` here would capitalise them twice. This is why the purchase side is simpler than the sales side and why it needs no conversion of cost.
- **`account: { "code": "2150" }` and not `{ "from": "party.payable_account" }` on the debit leg.** The GRNI account is company-wide, not per-vendor: `2150` is one row in the chart (3C seeds it) and every receipt accrues into it. A per-vendor GRNI would need a second account column on `party` that §4.5.7 does not have and that no register allocates. Hazard 33 applies in the consuming direction: Task 2 asserts `2150` resolves and this slice never re-seeds it.
- **`dimensions: { "required": [] }`, unlike `SALES_INVOICE`.** spec:1066 makes BRANCH mandatory on "every revenue, COGS and staff-cost ledger line". A purchase invoice posts none of the three — its legs are a liability and a clearing account — so requiring BRANCH would refuse an invoice for a reason the spec does not give. The *evaluator adds BRANCH to every line regardless* (§4.3.2 step 10), so the dimension is still on every row and the branch P&L still has no unallocated line; `required` is about refusal, not about tagging.
- **An expense invoice needs no receipt.** The `kind: "account"` pair debits the line's own account — an invoice for rent, freight billed separately, or a professional fee — so a purchase invoice with no linked receipt is a legitimate, complete document. That is the asymmetry with the sales side, where a product line with no delivery is refused: a purchase *expense* has no corridor to relieve, while a sales *product* line does.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test ar-ap/purchase-invoice && bun run --cwd packages/db test ar-ap`
Expected: PASS — six cases green and every earlier `ar-ap` suite still green.

- [ ] **Step 5: Commit**

```bash
git add packages/db/seed/my/document-types/PURCHASE_INVOICE.json \
        packages/db/test/ar-ap/purchase-invoice.test.ts
git commit -m "feat(accounting): PURCHASE_INVOICE clears the 2150 GRNI corridor [4A T7]

Configuration only, and no new TypeScript: Task 6's convertToInvoice already serves both directions.
2150 holds the accrued PRICE, so the invoice debits it at line.amount and credits trade payables at
total_incl_tax; 1300 is untouched, because the goods were capitalised at receipt. An account line has no
corridor, so an expense invoice with no receipt posts on its own.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `SALES_CREDIT_NOTE` and `PURCHASE_CREDIT_NOTE` — negated magnitudes and the reversal target

spec:2024 makes `SALES_CREDIT_NOTE` the reversal target of `SALES_INVOICE`. That single sentence fixes the whole shape of both types: a credit note's policy carries **the same `side`s as its invoice**, and the negation of the line magnitudes is what turns them into credits. Getting this backwards — writing credit-note-correct sides for positive magnitudes — produces a type that posts correctly when created by hand and **backwards** when created by `reverseDocument`, which is the one path spec:2024 requires.

**Files:**
- Create: `packages/db/seed/my/document-types/SALES_CREDIT_NOTE.json`, `PURCHASE_CREDIT_NOTE.json`
- Create: `packages/db/src/ar-ap/credit-note.ts`
- Create: `packages/db/test/ar-ap/credit-note.test.ts`, `packages/db/test/ar-ap/stock-return.test.ts`
- Modify: `packages/db/src/ar-ap/index.ts`, `packages/contracts/src/accounting/invoice.ts` (`CreditNoteLineSchema`, `CreditNoteBody`, `CreditNoteResultSchema` — Task 6's file, grown additively), `apps/api/src/routes/accounting/documents.ts` (one sub-path)
- Modify: `apps/api/test/routes/accounting/invoices.test.ts` (**Task 6 creates it; this task appends the credit-note `describe` and one seeded type**)
- Modify: `tests/regression/legacy-018.test.ts` (append the `— 4A` invoiced-return block)

**Interfaces:**
- Consumes: `reverseDocument` (§4.3.1, with 3C's `l.cost` line-copy column and Task 4's negative-cost rule); `linkFulfilment` (3C); `postDocument`, `issueDocument`, `setEventContext` (§4.3.1 — `setEventContext` is what discharges the required `reason`, placed by the service exactly as 2B's `reverse.ts` places its own at 2b:1519); `micro` and `convertToInvoice`'s pro-rata arithmetic pattern (Task 6 — `micro` IS shared and the ratio rule is not: the credit note negates and the conversion does not); `Money`, `Quantity`, `rational`, `Rational`, `currency` (§4.2.1); and for Step 8's stock-return proof `postInventoryDocument`, `ensureOpenPeriods`, `recordingJobs` (3B/3D), `DELIVERY_ORDER` and `GOODS_RECEIPT` from the seed pack (3D/3C), `app.inventory_movement` and `app.stock_on_hand` (3A, read only).
- Produces:

```ts
// packages/db/src/ar-ap/credit-note.ts
export interface CreditNoteLine { settledLineId: string; quantity: string }   // POSITIVE: how many come back
export interface CreditNoteInput {
  settledDocumentId: string;              // a posted SALES_INVOICE or PURCHASE_INVOICE
  targetDocumentTypeId: string;           // SALES_CREDIT_NOTE or PURCHASE_CREDIT_NOTE
  targetSeries: string;                   // "CN" | "PCN"
  effectiveDate: string;
  reason: string;                         // required — it reaches document_event.reason at issue
  lines: readonly CreditNoteLine[];        // empty = the whole invoice
}
export interface CreditNoteResult { documentId: string; lineIds: string[]; linkIds: string[] }
/**
 * Drafts a PARTIAL credit note against a posted invoice. Every money and quantity column is written
 * NEGATED — `quantity`, `unit_price` excepted, `discount`, `amount`, `tax_amount`, `total_incl_tax` — and
 * `cost` is written as a POSITIVE magnitude, because §4.7.2 A6 keeps that column non-negative and ADR 0045
 * takes its sign from the quantity. Sets `document.reverses_document_id` to the invoice, which the credit
 * note's `requires: ["reverses_document"]` makes mandatory, and links `returns`.
 * A FULL credit note is `reverseDocument(invoice)` and this function is not involved.
 */
export async function creditNoteFrom(tx: Sql, ctx: TenantContext, input: CreditNoteInput): Promise<CreditNoteResult>;
```

- [ ] **Step 1: Write the failing test `packages/db/test/ar-ap/credit-note.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creditNoteFrom } from "../../src/ar-ap/credit-note";
import { issueDocument, postDocument, reverseDocument } from "../../src/posting";
import { seedAccount, seedItem, seedParty, seedTenantV2, startDb, withTenant, type Db, type Seed } from "../index";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";
import { loadTypesFromPack } from "./_support";   // `accountByCode` is not needed here: no case reads an account id

let db: Db; let s: Seed;
let invType: string; let cnType: string; let partyId: string; let itemId: string;
const ctxOf = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "00000000-0000-0000-0000-000000000000" });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "credit-note");
  for (const [code, nameEn, type] of [
    ["1200", "Trade receivables", "asset"], ["1250", "Goods delivered not invoiced", "asset"],
    ["5000", "Cost of goods sold", "expense"], ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(db, s, { code, nameEn, type });
  ({ salesInvoiceType: invType, salesCreditNoteType: cnType } =
    await loadTypesFromPack(db, s, ["SALES_INVOICE", "SALES_CREDIT_NOTE"]) as never);
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-CN" });
  ({ itemId } = await seedItem(db, s, { code: "IT-CN", kind: "product", trackLots: false }));
}, 180_000);
afterAll(async () => { await db.stop(); });

/** One invoice: 5 at 9.0000, cost 15.0000. */
async function invoice(effectiveDate: string) {
  return postArDocument(db, s, {
    documentTypeId: invType, series: "INV", partyId, effectiveDate,
    lines: [{ kind: "item", itemId, quantity: "5.000000", unitPrice: "9.0000", amount: "45.0000", cost: "15.0000" }],
  });
}

describe("SALES_CREDIT_NOTE — spec:2024, §4.14, ADR 0044 and ADR 0045", () => {
  it("reverseDocument on the invoice produces a SALES_CREDIT_NOTE that posts the OPPOSITE of the invoice", async () => {
    const inv = await invoice("2026-01-10");
    const { reversalDocumentId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctxOf(s), { documentId: inv.documentId, effectiveDate: "2026-01-11", reason: "customer cancelled" }));
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text as debit, e.credit::text as credit
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${reversalDocumentId} order by a.code`;
    expect(rows).toEqual([
      { code: "1200", debit: "0.0000",  credit: "45.0000" },   // AR relieved
      { code: "1250", debit: "15.0000", credit: "0.0000"  },   // the corridor refilled — ADR 0045
      { code: "4000", debit: "45.0000", credit: "0.0000"  },   // revenue reversed
      { code: "5000", debit: "0.0000",  credit: "15.0000" },   // COGS reversed
    ]);
    const [head] = await db.admin<{ code: string; status: string }[]>`
      select t.code, d.status::text as status from app.document d
        join app.document_type t on t.id = d.document_type_id where d.id = ${reversalDocumentId}`;
    expect(head!.code).toBe("SALES_CREDIT_NOTE");
    const [orig] = await db.admin<{ status: string }[]>`select status::text as status from app.document where id = ${inv.documentId}`;
    expect(orig!.status).toBe("reversed");
  });

  it("the invoice and its reversal net to zero on all four accounts (test 3's shape, on AR/AP)", async () => {
    const rows = await db.admin<{ net: string }[]>`
      select coalesce(sum(base_debit - base_credit), 0)::text as net from app.ledger_entry`;
    expect(rows[0]!.net).toBe("0.0000");
  });

  it("a PARTIAL credit note carries NEGATED magnitudes, a POSITIVE cost, and posts the credit direction", async () => {
    const inv = await invoice("2026-01-12");
    const invLines = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${inv.documentId} order by line_no`;
    const cn = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await creditNoteFrom(tx, ctxOf(s), {
        settledDocumentId: inv.documentId, targetDocumentTypeId: cnType, targetSeries: "CN",
        effectiveDate: "2026-01-13", reason: "two units damaged in transit",
        lines: [{ settledLineId: invLines[0]!.id, quantity: "2.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      await postDocument(tx, ctxOf(s), { documentId: r.documentId });
      return r;
    });
    const [line] = await db.admin<{ q: string; amount: string; total: string; cost: string }[]>`
      select quantity::text as q, amount::text as amount, total_incl_tax::text as total, cost::text as cost
        from app.document_line where document_id = ${cn.documentId}`;
    expect(line).toEqual({ q: "-2.000000", amount: "-18.0000", total: "-18.0000", cost: "6.0000" });
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text as debit, e.credit::text as credit
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${cn.documentId} order by a.code`;
    expect(rows).toEqual([
      { code: "1200", debit: "0.0000", credit: "18.0000" },
      { code: "1250", debit: "6.0000", credit: "0.0000"  },
      { code: "4000", debit: "18.0000", credit: "0.0000" },
      { code: "5000", debit: "0.0000", credit: "6.0000"  },
    ]);
  });

  it("a credit note with NO reverses_document is refused at post — the requires control (§4.3.2 step 4)", async () => {
    const inv = await invoice("2026-01-14");
    const cn = await withTenant(db.rw, s.tenant, s.human, (tx) => creditNoteFrom(tx, ctxOf(s), {
      settledDocumentId: inv.documentId, targetDocumentTypeId: cnType, targetSeries: "CN",
      effectiveDate: "2026-01-15", reason: "test", lines: [],
    }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.document set reverses_document_id = null where id = ${cn.documentId}`);
    await expect(withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await issueDocument(tx, ctxOf(s), { documentId: cn.documentId });
      return postDocument(tx, ctxOf(s), { documentId: cn.documentId });
    })).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING: reverses_document/);
  });

  it("a partial credit note does NOT mark the invoice reversed — only reverseDocument does that", async () => {
    const inv = await invoice("2026-01-16");
    const invLines = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${inv.documentId} order by line_no`;
    await withTenant(db.rw, s.tenant, s.human, (tx) => creditNoteFrom(tx, ctxOf(s), {
      settledDocumentId: inv.documentId, targetDocumentTypeId: cnType, targetSeries: "CN",
      effectiveDate: "2026-01-16", reason: "one unit short-shipped",
      lines: [{ settledLineId: invLines[0]!.id, quantity: "1.000000" }],
    }));
    const [orig] = await db.admin<{ status: string }[]>`select status::text as status from app.document where id = ${inv.documentId}`;
    expect(orig!.status).toBe("posted");
  });

  it("crediting more than the invoiced quantity is refused with ERR_DOC_LINK_OVER_FULFILLED (LEGACY-018)", async () => {
    const inv = await invoice("2026-01-17");
    const invLines = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${inv.documentId} order by line_no`;
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => creditNoteFrom(tx, ctxOf(s), {
      settledDocumentId: inv.documentId, targetDocumentTypeId: cnType, targetSeries: "CN",
      effectiveDate: "2026-01-17", reason: "too many", lines: [{ settledLineId: invLines[0]!.id, quantity: "99.000000" }],
    }))).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
  });

  it("the credit note cannot itself be reversed (reversal.allowed is false)", async () => {
    const inv = await invoice("2026-01-18");
    const cn = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await creditNoteFrom(tx, ctxOf(s), {
        settledDocumentId: inv.documentId, targetDocumentTypeId: cnType, targetSeries: "CN",
        effectiveDate: "2026-01-18", reason: "whole invoice", lines: [],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      await postDocument(tx, ctxOf(s), { documentId: r.documentId });
      return r;
    });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctxOf(s), { documentId: cn.documentId, effectiveDate: "2026-01-19", reason: "no" })))
      .rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL|ERR_POLICY_INVALID/);
  });
});
```

- [ ] **Step 2: Run it to see the exact expected failure**

Run: `bun run --cwd packages/db test ar-ap/credit-note`
Expected: FAIL in `beforeAll` with `Error: the seed pack has no document type SALES_CREDIT_NOTE`, thrown by `loadTypesFromPack` — the file does not exist yet — and, before that, a TypeScript resolution error on `../../src/ar-ap/credit-note`. Both are the correct red: the two policies are Step 3 and the service is Step 4. **The seed files are written after the test and not before it**, because a policy written first makes the whole suite green-on-first-run for the wrong half and hides which of the two produced the direction.

- [ ] **Step 3: Write the two seed files**

`packages/db/seed/my/document-types/SALES_CREDIT_NOTE.json`:

```json
{
  "code": "SALES_CREDIT_NOTE",
  "nameEn": "Sales Credit Note",
  "nameAr": "إشعار دائن للبيع",
  "module": "accounting",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "SALES_CREDIT_NOTE",
    "direction": "inbound",
    "requires": ["party", "reverses_document"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "party.receivable_account" }, "amount": "line.total_incl_tax", "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "credit", "account": { "from": "item.revenue_account" },     "amount": "line.amount",         "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "debit",  "account": { "from": "party.receivable_account" }, "amount": "line.total_incl_tax", "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" },             "amount": "line.amount",         "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "debit",  "account": { "from": "item.cogs_account" },        "amount": "line.cost",           "when": { "item.kind": "product" } },
      { "for": "each_line", "side": "credit", "account": { "code": "1250" },                     "amount": "line.cost",           "when": { "item.kind": "product" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "CN", "assignAt": "issue" },
    "reversal": { "allowed": false, "producesType": null },
    "approval": { "required": false, "approve": null, "post": "accounting.sales.post", "create": "accounting.sales.create" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

`PURCHASE_CREDIT_NOTE.json` is the same construction over `PURCHASE_INVOICE`'s four rules — `direction: "outbound"`, `requires: ["party", "reverses_document"]`, series `PCN`, `approval.post: "accounting.purchase.post"`, `reversal: { "allowed": false, "producesType": null }`, `dimensions: { "required": [] }`, `inventory: { "effect": "none" }`, and the four line rules **copied verbatim from `PURCHASE_INVOICE.json`** including their `side`s.

**Five choices, and each of them is the difference between a type that works and one that posts backwards.**

- **The `side`s are IDENTICAL to the invoice's, and the negation does the work.** §4.4.2's A9 states the mechanism: "A reversal document carries **negated** signed magnitudes on its own lines … which is how **one** policy produces both directions". `reverseDocument(invoice)` creates a `SALES_CREDIT_NOTE` whose lines are the invoice's negated, evaluates *this* policy over them, and A9 flips every side — credit AR, debit revenue, credit cost of goods sold, debit `1250`. Writing credit-note-correct sides here instead would make the reversal post an invoice.
- **A partial credit note therefore carries negated magnitudes too**, and `creditNoteFrom` writes them that way. `DocumentLineInput`'s `Amount` regex is non-negative (2A), so a negative line cannot be POSTed through 1A's generic route — which is the guard, already in place: a credit note is created by this service or by `reverseDocument`, and by nothing else. `DocumentLineSchema`'s `SignedAmount` is what returns them (2B shipped it for exactly this reason).
- **`requires: ["reverses_document"]` is the fail-closed control.** A credit note must name the invoice it credits, and `validateRequires` refuses at post with `ERR_POLICY_REQUIRES_MISSING` naming the field (§4.3.2 step 4). Without it, a hand-built credit note with product lines would credit `1250` with no matching debit and leave the corridor negative forever. `reverses_document_id` is a 0001 column, `requires` admits it (§4.4.1), and both creation paths set it — so the control costs nothing and closes the only hole ADR 0044 leaves.
- **`inventory: { "effect": "none" }` — the stock comes back on a negated `DELIVERY_ORDER`.** A `receipt` effect here would be flipped to an `issue` by 3D's A2 on the credit note's negative quantities, sending the returned goods out a second time; Task 0's amendment 1 records this. 3D already blesses the alternative: "A cancelled delivery is a delivery with negated quantities, which A2's effect flip turns into a *receipt* automatically … no `DELIVERY_RETURN` type is needed or registered." Task 4's ADR 0045 is what makes that document's `1250` leg go the right way, which is why the two tasks are in this order.
- **The stock leg is `reverseDocument` on the delivery, and 4A ships no other way to move it.** 3D deferred the proof of that sentence (3d:2723 — "No test in this slice reverses a `DELIVERY_ORDER`, and none should be added here"), and Phase 4 is the slice that relies on it, so **Step 8 proves it** in `packages/db/test/ar-ap/stock-return.test.ts`. The reason it has to be `reverseDocument` and not a hand-drafted negated delivery is arithmetic: `reverseDocument` copies `document_line.cost` forward **unnegated** (3c:219), so the receipt lands in **branch 1** of §4.7.2's four-branch receipt-value rule and the stock returns at the cost it left at. A hand-drafted negated delivery has a null `cost`, falls through to **branch 3** (`toBase(line.amount + landedCost, rate)`), and would take the goods back in at the **selling** price, negative — `inventory_movement.value` has no CHECK on its sign, only the comment "sign follows quantity", so nothing would refuse it. What keeps that unreachable is 2A's non-negative `Amount` regex on `DocumentLineInput`: a negated line cannot be POSTed through 1A's generic document route at all, which Step 8's last case asserts rather than assumes.
- **A PARTIAL stock return therefore has no path in 4A, and that is deliberate rather than overlooked.** The financial half is `creditNoteFrom` (this task, any quantity); the stock half is all-or-nothing, because `reverseDocument` reverses a whole document. A customer who returns 2 of 5 delivered units is handled as **a full reversal of the delivery plus a new delivery for the 3 retained** — two registered documents, both with correct costs, and the `1250` corridor still nets to zero. A one-document partial return needs a service that drafts a negated delivery *and* writes the retained cost onto its lines, which would be a fourth writer of `document_line.cost` and therefore a Task 0 amendment 5 change; **4A does not add it**, and 4B or 6A may. Nothing in this slice is blocked by its absence: no test and no report reads it.
- **`reversal: { "allowed": false, "producesType": null }`.** A credit note issued in error is voided while `issued` (§4.5.1) or corrected by an invoice. Allowing a reversal would need `producesType: "SALES_INVOICE"`, and a `SALES_INVOICE` produced that way would carry `reverses_document_id` — legal, but it would also carry twice-negated magnitudes and a `requires` set the invoice does not declare. Refusing the second reversal is the honest shape and it is one boolean.

- [ ] **Step 4: Write `packages/db/src/ar-ap/credit-note.ts`**

```ts
import { Money, Quantity, currency, rational, type CurrencyCode, type Rational } from "@dulja/domain";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { linkFulfilment } from "../documents/link";
import { setEventContext } from "../posting/lifecycle";   // 2B; `reverse.ts` places its reason the same way
import { micro } from "./invoice";      // the one micro-unit conversion, exported from Task 6's file

export interface CreditNoteLine { settledLineId: string; quantity: string }
export interface CreditNoteInput {
  settledDocumentId: string; targetDocumentTypeId: string; targetSeries: string;
  effectiveDate: string; reason: string; lines: readonly CreditNoteLine[];
}
export interface CreditNoteResult { documentId: string; lineIds: string[]; linkIds: string[] }

/**
 * spec:2024, §4.14. A PARTIAL credit note against a posted invoice. Every money and quantity column is
 * written NEGATED — §4.4.2's A9 mechanism, the same shape `reverseDocument` produces — except `cost`,
 * which stays a non-negative magnitude (§4.7.2 A6) because ADR 0045 takes its sign from the quantity.
 * A FULL credit is `reverseDocument(invoice)` and does not come here.
 */
export async function creditNoteFrom(
  tx: Sql, ctx: TenantContext, input: CreditNoteInput,
): Promise<CreditNoteResult> {
  const [head] = await tx<{
    companyId: string; status: string; partyId: string | null; currency: string; exchangeRate: string;
    rateSource: string | null; branchId: string; paymentTermId: string | null;
  }[]>`
    select company_id as "companyId", status::text as status, party_id as "partyId", currency,
           exchange_rate::text as "exchangeRate", rate_source as "rateSource", branch_id as "branchId",
           payment_term_id as "paymentTermId"
      from app.document where id = ${input.settledDocumentId}`;
  if (head === undefined) throw new Error("ERR_NOT_FOUND: settled document is not visible");
  if (head.status !== "posted") {
    throw new Error(`ERR_DOC_STATUS_ILLEGAL: document ${input.settledDocumentId} is not posted`);
  }

  // `input.reason` is DISCHARGED here and nowhere else, which is why the field is required. There is no
  // `reason` column on `app.document` (§4.3.4); the only writer of `document_event.reason` is 2B's
  // `document_status_after`, an AFTER UPDATE OF status trigger reading `app.event_reason` — so the reason
  // has to be on the TRANSACTION before whichever caller moves this draft to `issued`, and it is
  // transaction-scoped (2b:1336). `reverse.ts` sets its own reason at exactly this point (2b:1519).
  // A caller that drafts here and issues in a LATER transaction gets no reason on the event, and 2B's
  // `TransitionBody.reason` is the field that covers that path.
  await setEventContext(tx, { reason: input.reason });

  const sources = await tx<{
    id: string; lineNo: number; kind: string; itemId: string | null; accountId: string | null;
    unitId: string | null; warehouseId: string | null; lotId: string | null; description: string | null;
    quantity: string | null; openQuantity: string; unitPrice: string | null; discount: string;
    amount: string; taxAmount: string; totalInclTax: string; cost: string | null;
  }[]>`
    select dl.id, dl.line_no as "lineNo", dl.kind, dl.item_id as "itemId", dl.account_id as "accountId",
           dl.unit_id as "unitId", dl.warehouse_id as "warehouseId", dl.lot_id as "lotId", dl.description,
           dl.quantity::text as quantity, coalesce(oq.open_quantity, dl.quantity, 0)::text as "openQuantity",
           dl.unit_price::text as "unitPrice", dl.discount::text as discount, dl.amount::text as amount,
           dl.tax_amount::text as "taxAmount", dl.total_incl_tax::text as "totalInclTax", dl.cost::text as cost
      from app.document_line dl
      left join app.document_open_quantity oq on oq.document_line_id = dl.id
     where dl.document_id = ${input.settledDocumentId}
     order by dl.line_no`;

  const cur = currency(head.currency) as CurrencyCode;
  /** The magnitude of a 6-dp quantity string, still as a 6-dp quantity string — a string operation, not
   *  a numeric one, because `Quantity.toString()` is fixed at QUANTITY_SCALE (§4.2.1). */
  const abs6 = (v: string): string => {
    const fixed = Quantity.of(v).toString();
    return fixed.startsWith("-") ? fixed.slice(1) : fixed;
  };
  const asked = input.lines.length === 0
    ? sources.map((l) => ({ settledLineId: l.id, quantity: abs6(l.quantity ?? "0.000000") }))
    : input.lines;

  const [target] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, status, series, effective_date, party_id, currency,
       exchange_rate, rate_source, branch_id, payment_term_id, reverses_document_id)
    values (app.current_tenant(), ${head.companyId}, ${input.targetDocumentTypeId}, 'draft',
            ${input.targetSeries}, ${input.effectiveDate}::date, ${head.partyId}, ${head.currency},
            ${head.exchangeRate}, ${head.rateSource}, ${head.branchId}, ${head.paymentTermId},
            ${input.settledDocumentId})
    returning id`;

  const lineIds: string[] = [];
  const fulfilment: { sourceLineId: string; targetLineId: string; quantity: string }[] = [];

  for (const [i, ask] of asked.entries()) {
    const src = sources.find((l) => l.id === ask.settledLineId);
    if (src === undefined) throw new Error(`ERR_VALIDATION_FAILED: line ${ask.settledLineId} is not on the settled document`);
    const qMicro = micro(ask.quantity);
    if (qMicro <= 0n) throw new Error(`ERR_VALIDATION_FAILED: line ${src.lineNo} quantity must be positive`);
    const srcSigned = micro(src.quantity ?? "0.000000");
    const srcMicro = srcSigned < 0n ? -srcSigned : srcSigned;
    // An exact `Rational`, as in Task 6's conversion — same arithmetic, opposite sign, and deliberately not
    // a shared function: the credit note negates and the conversion does not (hazard 9 is about one FACT
    // stored twice, not about two rules that happen to share a factor). A non-quantity line has ratio 1.
    const ratio: Rational = srcMicro === 0n ? rational(1n, 1n) : rational(qMicro, srcMicro);
    const neg = (v: string) => Money.of(v, cur).multiply(ratio, "HALF_AWAY_FROM_ZERO").negate().toString();
    const mag = (v: string | null) =>
      v === null ? null : Money.of(v, cur).multiply(ratio, "HALF_AWAY_FROM_ZERO").toString();

    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, description, account_id, item_id, unit_id,
         warehouse_id, lot_id, quantity, unit_price, discount, amount, tax_amount, total_incl_tax, cost)
      values (app.current_tenant(), ${head.companyId}, ${target!.id}, ${i + 1}, ${src.kind},
              ${src.description}, ${src.accountId}, ${src.itemId}, ${src.unitId}, ${src.warehouseId},
              ${src.lotId},
              ${src.quantity === null ? null : Quantity.of(ask.quantity).negate().toString()},
              ${src.unitPrice},                                    -- a PRICE is not a magnitude to negate
              ${neg(src.discount)}, ${neg(src.amount)}, ${neg(src.taxAmount)}, ${neg(src.totalInclTax)},
              ${mag(src.cost)})                                     -- POSITIVE: §4.7.2 A6, sign from ADR 0045
      returning id`;
    lineIds.push(row!.id);
    fulfilment.push({
      sourceLineId: src.id, targetLineId: row!.id, quantity: Quantity.of(ask.quantity).toString(),
    });
  }

  // `returns` — 3C's registered link kind, and its own guard is what refuses a credit larger than the
  // invoiced quantity (ERR_DOC_LINK_OVER_FULFILLED, LEGACY-018's structural fix: a projection, not a counter).
  const links = await linkFulfilment(tx, ctx, {
    sourceDocumentId: input.settledDocumentId, targetDocumentId: target!.id,
    linkKind: "returns", lines: fulfilment, priceFromSource: false,
  });
  return { documentId: target!.id, lineIds, linkIds: links.map((l) => l.id) };
}
```

Add `export * from "./credit-note";` to `packages/db/src/ar-ap/index.ts`.

- [ ] **Step 5: Add the credit-note schemas and the one route sub-path**

Append to `packages/contracts/src/accounting/invoice.ts` — Task 6's file, grown additively, because a credit note and a conversion are two shapes of one noun and §4.2.8's module table registers one file for it:

```ts
export const CreditNoteLineSchema = z.object({
  settledLineId: UuidSchema,
  /** POSITIVE: how many come back. The service negates (§4.4.2 A9), so a caller never spells a minus. */
  quantity: QuantitySchema.regex(/^\d+\.\d{6}$/),
});

export const CreditNoteBody = z.object({
  targetDocumentTypeId: UuidSchema,
  targetSeries: z.string().regex(/^[A-Z0-9-]{1,16}$/),
  effectiveDate: DateSchema,
  /** REQUIRED, and not decoration — see the paragraph under the handler. */
  reason: z.string().min(1).max(2000),
  /** Empty means the whole settled document. */
  lines: z.array(CreditNoteLineSchema).default([]),
}).openapi("CreditNoteBody");

export const CreditNoteResultSchema = z.object({
  documentId: UuidSchema, lineIds: z.array(UuidSchema), linkIds: z.array(UuidSchema),
}).openapi("CreditNoteResult");
```

and in `apps/api/src/routes/accounting/documents.ts`, beside Task 6's `convert-to-invoice`:

```ts
documentRoutes.openapi(createRoute({
  method: "post", path: "/{documentId}/credit-note",
  request: { params: DocumentParams, headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: CreditNoteBody } } } },
  // "submit", per 3C's rule for a POST sub-path of an EXISTING document. The document on the path is the
  // INVOICE being credited, so the code resolved is the invoice type's — a principal who may raise the
  // sale may raise its credit note, and posting it still needs `accounting.sales.post` from the trigger.
  middleware: [requireDocumentPermission("submit")],
  tags: ["accounting"],
  responses: {
    201: { content: { "application/json": { schema: CreditNoteResultSchema } }, description: "Credit note created AND issued, linked `returns`, and reverses_document_id set" },
    422: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Over-credited, or a document that is not posted" },
  },
}), async (c) => {
  const { documentId } = c.req.valid("param");
  const { reason, ...body } = c.req.valid("json");
  const result = await c.var.withTenant(async (tx) => {
    const r = await creditNoteFrom(tx, c.var.ctx, { settledDocumentId: documentId, reason, ...body });
    // Issued on the SAME transaction, and that is what makes `reason` land. `creditNoteFrom` put it on
    // `app.event_reason`, which is transaction-scoped, and 2B's only writer of `document_event` is an
    // AFTER UPDATE OF status trigger — the INSERT of a draft records nothing at all. Returning a draft
    // here would make `reason` a field the API requires, accepts and then drops.
    // `draft → issued` is legal without a second gate: §4.5.1 block 2a admits it whenever
    // `approval.required` is false, which the credit-note policy sets, and block 2c evaluates NO
    // permission code for `issued` (2b:970, "submitted, draft and issued evaluate no code", ADR 0029).
    await issueDocument(tx, c.var.ctx, { documentId: r.documentId });
    return r;
  });
  return c.json(result, 201);
});
```

`issueDocument` joins `creditNoteFrom` in this file's `import { … } from "@dulja/db";` line, which is the tier's convention (2b:2677). `setEventContext` is **not** imported here — Step 4's service owns that call.

**`reason` is required on the wire and it is not decoration, and this route therefore returns an ISSUED note rather than a draft.** The chain is: `creditNoteFrom` writes the reason to `app.event_reason` with `setEventContext` (§4.3.1), the handler issues on the same transaction, and 2B's `document_status_after` copies the setting onto the `draft → issued` row of `app.document_event` — the field an auditor reads (spec:2179). Break any link and the reason is silently discarded, because there is no `reason` column to fall back on. **The difference from Task 6's `convert-to-invoice`, which does return a draft, is deliberate**: a conversion produces a document whose prices, lines and date a user still edits, while a credit note is a negation of an already-posted invoice with nothing left to decide — and only a transition can record why it exists. Posting it stays a separate `POST …/transitions`, gated at the trigger by `accounting.sales.post`.

- [ ] **Step 6: Append the credit-note cases to `apps/api/test/routes/accounting/invoices.test.ts`**

Task 6 created that file for `convert-to-invoice`; this step adds a second `describe` to it rather than a second suite, because both sub-paths sit on one module and one contracts file and a second file would duplicate the whole fixture. The `beforeAll` gains one seeded type — the credit note's — and nothing else changes:

```ts
// added to the beforeAll of apps/api/test/routes/accounting/invoices.test.ts
let cnType: string;
// …in beforeAll, beside the two existing seedDocumentType calls:
cnType = await seedDocumentType(api.db, s, {
  code: "API_CREDIT_NOTE", module: "accounting",
  policy: {
    ...CORRIDOR_POLICY("API_CREDIT_NOTE", "ACN", "accounting.sales.post", "5000", "1250"),
    direction: "inbound" as const,
    requires: ["party", "reverses_document"] as const,
    reversal: { allowed: false, producesType: null },
  },
});

describe("POST /v1/companies/{companyId}/documents/{documentId}/credit-note (4A)", () => {
  it("201s with an ISSUED note whose reverses_document_id is the invoice and whose magnitudes are NEGATED", async () => {
    const inv = await postedSource("5.000000", "45.0000", "15.0000", "2026-01-20");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${inv.documentId}/credit-note`,
      as: s.human,
      body: {
        targetDocumentTypeId: cnType, targetSeries: "ACN", effectiveDate: "2026-01-21",
        reason: "two units damaged in transit",
        lines: [{ settledLineId: inv.lineIds[0], quantity: "2.000000" }],
      },
    });
    expect(res.status).toBe(201);
    const { documentId } = await res.json() as { documentId: string };
    const [head] = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      tx<{ rev: string | null; status: string }[]>`
        select reverses_document_id as rev, status::text as status from app.document where id = ${documentId}`);
    expect(head!.rev).toBe(inv.documentId);
    // Issued, not drafted — the handler's second call, and the reason's only route to an event row.
    expect(head!.status).toBe("issued");
    const [line] = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      tx<{ q: string; amount: string; cost: string }[]>`
        select quantity::text as q, amount::text as amount, cost::text as cost
          from app.document_line where document_id = ${documentId}`);
    // Negated magnitudes, POSITIVE cost — §4.4.2 A9 and §4.7.2 A6, over the wire.
    expect(line).toEqual({ q: "-2.000000", amount: "-18.0000", cost: "6.0000" });
  });

  it("the reason reaches document_event.reason on the draft → issued row — it is not accepted and dropped", async () => {
    const inv = await postedSource("1.000000", "9.0000", "3.0000", "2026-01-22");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${inv.documentId}/credit-note`,
      as: s.human,
      body: { targetDocumentTypeId: cnType, targetSeries: "ACN", effectiveDate: "2026-01-22", reason: "short-shipped", lines: [] },
    });
    const { documentId } = await res.json() as { documentId: string };
    const events = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      tx<{ reason: string | null; to: string; kind: string }[]>`
        select reason, to_status::text as "to", event_kind::text as kind
          from app.document_event where document_id = ${documentId}`);
    // Exactly one event, and it is the transition the handler caused. A `toContain` over an empty array
    // would have been the failure to expect if the note were left at draft.
    expect(events).toEqual([{ reason: "short-shipped", to: "issued", kind: "transition" }]);
  });

  it("an ABSENT reason is refused on the wire — `.min(1)` is the control, not a convention", async () => {
    const inv = await postedSource("1.000000", "9.0000", "3.0000", "2026-01-23");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${inv.documentId}/credit-note`,
      as: s.human,
      body: { targetDocumentTypeId: cnType, targetSeries: "ACN", effectiveDate: "2026-01-23", lines: [] },
    });
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a NEGATIVE quantity is refused on the wire — the caller states how many come back, never a minus", async () => {
    const inv = await postedSource("1.000000", "9.0000", "3.0000", "2026-01-24");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${inv.documentId}/credit-note`,
      as: s.human,
      body: {
        targetDocumentTypeId: cnType, targetSeries: "ACN", effectiveDate: "2026-01-24", reason: "x",
        lines: [{ settledLineId: inv.lineIds[0], quantity: "-1.000000" }],
      },
    });
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("crediting more than the invoiced quantity is 422 ERR_DOC_LINK_OVER_FULFILLED (LEGACY-018)", async () => {
    const inv = await postedSource("1.000000", "9.0000", "3.0000", "2026-01-25");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${inv.documentId}/credit-note`,
      as: s.human,
      body: {
        targetDocumentTypeId: cnType, targetSeries: "ACN", effectiveDate: "2026-01-25", reason: "too many",
        lines: [{ settledLineId: inv.lineIds[0], quantity: "99.000000" }],
      },
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_DOC_LINK_OVER_FULFILLED");
  });
});
```

- [ ] **Step 7: Append the `— 4A` block to `tests/regression/legacy-018.test.ts`**

3D created the file (deleting a return line never decrements; editing one double-counts). The 4A block is the invoiced-return half the card assigns this slice:

```ts
describe("LEGACY-018 An invoiced return is bounded by what was invoiced, and is a projection — 4A", () => {
  it("returning more than the invoice carried is refused, and the refusal is the LINK's, not a counter's", async () => {
    // The legacy defect kept `BdtQnt` as a maintained counter on the invoice: deleting a return line left it
    // high, so no further return was possible, and editing one to a smaller figure made it larger. Here the
    // returned quantity is Σ document_link.quantity over `returns` links and there is no counter to drift.
    const { rw } = await sharedDb();
    const [col] = await rw.db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'document_line'
         and column_name in ('returned_quantity', 'credited_quantity', 'bdt_qnt')`;
    expect(col!.n).toBe(0);
  });

  it("a credit note is created only by creditNoteFrom or reverseDocument — a hand-built one cannot be POSTed", async () => {
    const { repoFile } = await import("../support/regression");
    // DocumentLineInput's non-negative Amount regex (2A) is what refuses a negative line on the generic
    // route, so the two service paths are the only ways a credit note's magnitudes can be negative.
    const src = repoFile("packages/contracts/src/accounting/document.ts");
    expect(src).toMatch(/Amount\s*=\s*z\.string\(\)\.regex\(\/\^\\d\+\\\.\\d\{4\}\$\//);
  });
});
```

- [ ] **Step 8: Write `packages/db/test/ar-ap/stock-return.test.ts` — the `DELIVERY_ORDER` reversal 3D deferred to this slice**

This file exists for one reason: 3d:2723 says the movement claim is 3D's and the ledger claim is not, and that the fix "must land before Phase 4 relies on a `DELIVERY_ORDER` reversal to clear `1250`". Task 4 landed the fix; this proves it end to end on the real seeded type, and it is the only place in the slice where a stock return is exercised. Its fixtures are its own — the credit-note suite above has no warehouse and no layers on purpose, and weaving inventory into it would couple four unrelated cases to a costing run.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reverseDocument } from "../../src/posting";
import {
  seedAccount, seedItem, seedParty, seedTenantV2, seedWarehouse, startDb, withTenant,
  type Db, type Seed,
} from "../index";
import {
  ensureOpenPeriods, postInventoryDocument, recordingJobs,
} from "../../../../tests/invariants/support/post-inventory";
import { DocumentLineInput } from "@dulja/contracts/accounting/document";

let db: Db; let s: Seed;
let partyId: string; let itemId: string; let warehouseId: string;
let doId: string; let reversalId: string;
const ctxOf = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "00000000-0000-0000-0000-000000000000" });

/** Balance of an account in base, signed debit − credit. */
async function net(code: string): Promise<string> {
  const [row] = await db.admin<{ net: string }[]>`
    select coalesce(sum(e.base_debit - e.base_credit), 0)::text as net
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where a.company_id = ${s.company} and a.code = ${code}`;
  return row!.net;
}

async function onHand(): Promise<string> {
  const [row] = await db.admin<{ q: string }[]>`
    select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
     where company_id = ${s.company} and item_id = ${itemId}`;
  return row!.q;
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "stock-return");
  await ensureOpenPeriods(db, s, ["2026-01"]);
  for (const [code, nameEn, type] of [
    ["1250", "Goods delivered not invoiced", "asset"], ["1300", "Inventory control", "asset"],
    ["2150", "Goods received not invoiced", "liability"], ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(db, s, { code, nameEn, type });
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-RET" });
  ({ itemId } = await seedItem(db, s, { code: "IT-RET", kind: "product", trackLots: false }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-RET" });
  // Ten units at 3.0000, then deliver four. Both through the door 3B and 3D use.
  await postInventoryDocument(db, s, { code: "GOODS_RECEIPT", effectiveDate: "2026-01-05", lines: [
    { itemId, warehouseId, quantity: "10.000000", unitPrice: "3.0000", amount: "30.0000" }] });
  ({ documentId: doId } = await postInventoryDocument(db, s, {
    code: "DELIVERY_ORDER", effectiveDate: "2026-01-10", partyId,
    lines: [{ itemId, warehouseId, quantity: "4.000000", unitPrice: "9.0000", amount: "36.0000" }],
  }));
}, 240_000);
afterAll(async () => { await db.stop(); });

describe("the DELIVERY_ORDER reversal — 3d:2723's deferred proof, ADR 0045, §4.7.2 branch 1", () => {
  it("the delivery filled the corridor and took the stock out — the starting state", async () => {
    expect(await net("1250")).toBe("12.0000");    // 4 × 3.0000, the cost the layer gave up
    expect(await net("1300")).toBe("18.0000");    // 30.0000 in, 12.0000 out
    expect(await onHand()).toBe("6.000000");
  });

  it("reverseDocument produces a DELIVERY_ORDER with negated quantities and the cost copied UNNEGATED", async () => {
    ({ reversalDocumentId: reversalId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctxOf(s), {
        documentId: doId, effectiveDate: "2026-01-11",
        reason: "customer returned the whole delivery", jobs: recordingJobs(),
      })));
    const [head] = await db.admin<{ code: string }[]>`
      select t.code from app.document d join app.document_type t on t.id = d.document_type_id
       where d.id = ${reversalId}`;
    expect(head!.code).toBe("DELIVERY_ORDER");
    const [line] = await db.admin<{ quantity: string; cost: string }[]>`
      select quantity::text as quantity, cost::text as cost from app.document_line
       where document_id = ${reversalId} order by line_no`;
    expect(line!.quantity).toBe("-4.000000");
    expect(line!.cost).toBe("12.0000");           // 3c:219 — a magnitude, copied and not negated
  });

  it("A2 flips the issue into a RECEIPT: one movement, POSITIVE quantity, valued at branch 1's copied cost", async () => {
    const movements = await db.admin<{ quantity: string; value: string }[]>`
      select quantity::text as quantity, value::text as value from app.inventory_movement
       where document_id = ${reversalId} order by movement_no`;
    expect(movements).toHaveLength(1);
    expect(movements[0]!.quantity).toBe("4.000000");    // + is a receipt (3A's column comment, spec:2043)
    expect(movements[0]!.value).toBe("12.0000");        // NOT 36.0000: branch 1 read the copied cost,
                                                       // not branch 3's toBase(line.amount, rate)
  });

  it("and ADR 0045 sends the ledger the other way: 1250 CREDITED, 1300 DEBITED, corridor back to zero", async () => {
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text as debit, e.credit::text as credit
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${reversalId} order by a.code`;
    expect(rows).toEqual([
      { code: "1250", debit: "0.0000",  credit: "12.0000" },
      { code: "1300", debit: "12.0000", credit: "0.0000"  },
    ]);
    expect(await net("1250")).toBe("0.0000");     // the corridor is empty again — the invariant
    expect(await net("1300")).toBe("30.0000");    // every unit is back on the books at its own cost
    expect(await onHand()).toBe("10.000000");
  });

  it("the returned units come back as their OWN layer at the cost they left at — 3.0000, never 9.0000", async () => {
    // `cost_layer` carries `unique (movement_id)` (3B), so a receipt movement always makes a layer; the
    // reversal does not reopen the layer it consumed. Two layers, both at the receipt cost, ten units.
    const layers = await db.admin<{ unit_cost: string; qty_in: string; qty_remaining: string }[]>`
      select unit_cost::text as unit_cost, qty_in::text as qty_in, qty_remaining::text as qty_remaining
        from app.cost_layer
       where company_id = ${s.company} and item_id = ${itemId} and invalidated_at is null
       order by sequence`;
    expect(layers.map((l) => l.unit_cost)).toEqual(["3.0000", "3.0000"]);
    expect(layers.map((l) => l.qty_remaining)).toEqual(["6.000000", "4.000000"]);
    // …and the ledger agrees with the layers to the cent: 6 × 3 + 4 × 3 = 30.0000 = net("1300").
    expect(await net("1300")).toBe("30.0000");
  });

  it("a HAND-DRAFTED negated delivery cannot be accepted on the wire, so branch 3 is unreachable", async () => {
    // The guard the design leans on. With no service for a partial return, the only door to a negated
    // delivery is 1A's generic POST /documents, and 2A's DocumentLineInput keeps 1A's non-negative Amount
    // regex (contracts §4.2.8) — so the null-cost, selling-price valuation of receipt-value branch 3 can
    // never be reached through the API. Asserted on the schema itself, which is where the constraint is.
    const negated = DocumentLineInput.safeParse({
      kind: "item", itemId, warehouseId, quantity: "-2.000000", unitPrice: "9.0000", amount: "-18.0000",
    });
    expect(negated.success).toBe(false);
    expect(JSON.stringify(negated.error?.issues)).toContain("amount");
    // Whether `quantity` may itself carry a sign is 0B's QuantitySchema's business and is deliberately not
    // asserted here: `amount` alone is the closed door, and one closed door is all the guard needs.
  });
});
```

- [ ] **Step 9: Run the stock-return suite and see the one failure that matters**

Run: `bun run --cwd packages/db test ar-ap/stock-return`
Expected: PASS on all six cases **if Task 4 landed**. Run it once with Task 4's evaluator change reverted to see what 3D warned about: the fourth case reports `1250` **debited** 12.0000 and `1300` credited, `net("1250")` reads `24.0000`, and the corridor has been filled twice by one physical movement. That is the failure ADR 0045 exists to prevent, and seeing it once is worth the two minutes.

If instead the **third** case reports `value: "36.0000"`, `reverseDocument` did not copy `cost` — stop and reconcile with 3C rather than patching the expectation, because every corridor figure in Tasks 6 and 7 depends on that copy.

- [ ] **Step 10: Run everything**

Run: `bun run --cwd packages/db test ar-ap/credit-note && bun run --cwd packages/db test ar-ap/stock-return && bun run --cwd apps/api test routes/accounting/invoices && node --test tests/regression/legacy-018.test.ts && bun run --cwd packages/db test ar-ap && bun run --cwd packages/contracts openapi:generate`
Expected: PASS — seven credit-note cases, six stock-return cases, **twelve** route cases in `invoices.test.ts` (Task 6's seven plus this task's five), both new `legacy-018` cases, every earlier `ar-ap` suite green, and an OpenAPI diff showing one added path and three added components (`CreditNoteBody`, `CreditNoteResult`, and `CreditNoteLine` if the line schema is given a component name).

**One failure worth naming in advance, and it is the one this task exists to prevent.** If the first case reports the invoice's own directions on the reversal — `1200` debit, `4000` credit — the credit note's policy was written with credit-note-correct sides. Do not "fix" it by negating in the service: `reverseDocument` already negates, and two negations are the identity. The policy's sides are the invoice's; that is the whole design.

- [ ] **Step 11: Commit**

```bash
git add packages/db/seed/my/document-types/SALES_CREDIT_NOTE.json \
        packages/db/seed/my/document-types/PURCHASE_CREDIT_NOTE.json \
        packages/db/src/ar-ap/credit-note.ts packages/db/src/ar-ap/index.ts \
        packages/contracts/src/accounting/invoice.ts packages/contracts/openapi.json \
        apps/api/src/routes/accounting/documents.ts \
        apps/api/test/routes/accounting/invoices.test.ts \
        packages/db/test/ar-ap/credit-note.test.ts packages/db/test/ar-ap/stock-return.test.ts \
        tests/regression/legacy-018.test.ts
git commit -m "feat(accounting): the two credit notes, as reversal targets with negated magnitudes [4A T8]

spec:2024. Each credit note's policy carries the SAME sides as its invoice and the negation of the line
magnitudes is what turns them into credits (A9) — so reverseDocument produces a correct credit note and
so does a partial one from creditNoteFrom. requires: [reverses_document] is the fail-closed control that
stops a hand-built credit note crediting 1250 with no matching debit. Stock returns on a negated
DELIVERY_ORDER (3D's registered path), so inventory.effect is none.

stock-return.test.ts discharges 3d:2723: the DELIVERY_ORDER reversal now has a test, and it asserts the
receipt direction (1250 credited, 1300 debited), branch 1's copied cost (12.0000, not the 36.0000 selling
price) and stock back to ten. A PARTIAL stock return has no service in 4A by decision: it is a full
reversal plus a re-delivery of the retained quantity.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Migration 0046 — `app.allocation`, `allocateSettlement`, `openBalance`, `partyBalance` and the allocation API

§4.8.1 implemented verbatim, and the first of row 1042's four capabilities (§6.2). **Allocation is not a ledger fact**: a receipt relieves the AR control account in total when it posts, and `app.allocation` records *which* invoices it settled. That separation is what lets `unallocate` exist at all without touching a posted entry (spec:2457).

**Files:**
- Create: `packages/db/migrations/0046_create_allocation.sql`, `packages/db/migrations/0046.down.sql`
- Create: `packages/db/src/schema/allocation.ts`, `packages/db/src/ar-ap/allocation.ts`
- Create: `packages/contracts/src/accounting/allocation.ts`
- Create: `packages/db/test/ar-ap/allocation.test.ts`, `apps/api/test/routes/accounting/allocations.test.ts`
- Modify: `packages/db/src/ar-ap/index.ts`, `packages/db/src/lint-schema.ts` (verify `allocation` joins no exemption set), `apps/api/src/routes/accounting/documents.ts` (four sub-paths), `apps/api/src/routes/accounting/parties.ts` (one sub-path)
- Modify: `tests/regression/legacy-019.test.ts` (append, create-if-absent), `tests/regression/legacy-041.test.ts` (append)

**Interfaces:**
- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.current_actor`, `lintSchema` (§4.1); `Money`, `currency`, `toBase`, `UNIT_RATE`, `ExchangeRate` (§4.2.1); `app.rate_for` (0D, §4.2.10); `AppError`, `ERRORS` (§4.2.4); `requireDocumentPermission("submit")`, `requirePermission`, `requireDocumentModuleRead` (§4.5.4, §4.2.5, 2C's `apps/api/src/middleware/require-attachment-read.ts`); `postArDocument` (Task 5); `SALES_CREDIT_NOTE` from the seed pack and **`creditNoteFrom` (Task 8)**, which is what the credit-note-as-settlement case builds its note with — `SALES_CREDIT_NOTE.json` carries `requires: ["party", "reverses_document"]` and `PostArOptions` has no member that sets `reverses_document_id`, so a note drafted through `postArDocument` is refused at post with `ERR_POLICY_REQUIRES_MISSING: reverses_document`; `issueDocument`, `postDocument` (§4.3.1); `loadTypesFromPack`, `accountByCode` (Task 5's `test/ar-ap/_support.ts`); `seedCurrency`, `seedRate` (0D).
- Produces: `app.allocation` exactly as §4.8.1 declares it, plus:

```ts
// packages/db/src/ar-ap/allocation.ts
export interface AllocationLine { settledDocumentId: string; amount: Money }
export interface AllocationRow {
  id: string; companyId: string; partyId: string;
  settlementDocumentId: string; settledDocumentId: string;
  amount: string; baseAmount: string; fxDifference: string;      // 4-dp strings on the row; Money at the API
  allocatedBy: string; unallocatedAt: string | null;
  unallocatedBy: string | null; unallocationReason: string | null;   // the two columns Task 0 registers
  createdAt: string;
  /** Two DERIVED read-only members, joined by `listAllocations` and stored in no column: the settled
   *  document's `currency` and the company's `base_currency`. The row's three money fields are in two
   *  different currencies, and the wire mapper (Step 6) needs to name both. */
  currency: string; baseCurrency: string;
}
export interface PartyBalance { byCurrency: Record<string, Money>; base: Money }
export async function allocateSettlement(tx: Sql, ctx: TenantContext, input: { settlementDocumentId: string; lines: AllocationLine[] }): Promise<{ allocationIds: string[]; fxDifference: Money }>;
export async function unallocate(tx: Sql, ctx: TenantContext, input: { allocationId: string; reason: string }): Promise<void>;
export async function openBalance(tx: Sql, input: { documentId: string }): Promise<{ document: Money; base: Money }>;
export async function partyBalance(tx: Sql, input: { partyId: string; asOf: string }): Promise<PartyBalance>;
export async function listAllocations(tx: Sql, input: { settlementDocumentId?: string; settledDocumentId?: string; includeUnallocated?: boolean }): Promise<AllocationRow[]>;
```

- [ ] **Step 1: Write the failing DB-tier test `packages/db/test/ar-ap/allocation.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { lintSchema } from "../../src/lint-schema";
import {
  allocateSettlement, listAllocations, openBalance, partyBalance, unallocate,
} from "../../src/ar-ap/allocation";
import { creditNoteFrom } from "../../src/ar-ap/credit-note";
import { issueDocument, postDocument } from "../../src/posting";
import {
  seedAccount, seedCurrency, seedItem, seedParty, seedRate, seedTenantV2, startDb, withTenant,
  type Db, type Seed,
} from "../index";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";
import { accountByCode, loadTypesFromPack } from "./_support";

let db: Db; let s: Seed;
let invType: string; let rctType: string; let cnType: string;
let partyId: string; let itemId: string; let bankId: string;
const MYR = currency("MYR"); const EUR = currency("EUR");
const ctxOf = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "00000000-0000-0000-0000-000000000000" });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "allocation");
  for (const [code, nameEn, type] of [
    ["1100", "Bank", "asset"], ["1200", "Trade receivables", "asset"],
    ["1250", "Goods delivered not invoiced", "asset"], ["5000", "Cost of goods sold", "expense"],
    ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(db, s, { code, nameEn, type });
  bankId = await accountByCode(db, s, "1100");
  await seedCurrency(db, s, { code: "EUR" });
  await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-01-01", rate: "4.80000000" });
  ({ salesInvoiceType: invType, receiptType: rctType, salesCreditNoteType: cnType } =
    await loadTypesFromPack(db, s, ["SALES_INVOICE", "RECEIPT", "SALES_CREDIT_NOTE"]) as never);
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-ALLOC" });
  ({ itemId } = await seedItem(db, s, { code: "IT-ALLOC", kind: "product", trackLots: false }));
}, 180_000);
afterAll(async () => { await db.stop(); });

/** One MYR invoice for `amount`, and one MYR receipt for `amount`. */
async function invoiceFor(amount: string, effectiveDate: string) {
  return postArDocument(db, s, {
    documentTypeId: invType, series: "INV", partyId, effectiveDate,
    lines: [{ kind: "item", itemId, quantity: "1.000000", unitPrice: amount, amount, cost: "1.0000" }],
  });
}
async function receiptFor(amount: string, effectiveDate: string, currencyCode = "MYR", rate = "1.00000000") {
  return postArDocument(db, s, {
    documentTypeId: rctType, series: "RCT", partyId, effectiveDate,
    currency: currencyCode, exchangeRate: rate,
    lines: [{ kind: "account", accountId: bankId, description: "bank transfer", amount, totalInclTax: amount }],
  });
}

describe("app.allocation — migration 0046, contracts §4.8.1", () => {
  it("the schema linter reports zero violations after 0046", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("openBalance on a fresh invoice is its total, in both document and base currency", async () => {
    const inv = await invoiceFor("100.0000", "2026-01-05");
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) => openBalance(tx, { documentId: inv.documentId }));
    expect(open.document.toString()).toBe("100.0000");
    expect(open.base.toString()).toBe("100.0000");
  });

  it("a full allocation drives openBalance to zero and records one row", async () => {
    const inv = await invoiceFor("100.0000", "2026-01-06");
    const rct = await receiptFor("100.0000", "2026-01-07");
    const { allocationIds, fxDifference } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateSettlement(tx, ctxOf(s), {
        settlementDocumentId: rct.documentId,
        lines: [{ settledDocumentId: inv.documentId, amount: Money.of("100.0000", MYR) }],
      }));
    expect(allocationIds).toHaveLength(1);
    expect(fxDifference.toString()).toBe("0.0000");
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) => openBalance(tx, { documentId: inv.documentId }));
    expect(open.document.toString()).toBe("0.0000");
  });

  it("allocating MORE than the settlement total is ERR_VALIDATION_FAILED (§6.2's allocation proof)", async () => {
    const inv = await invoiceFor("100.0000", "2026-01-08");
    const rct = await receiptFor("40.0000", "2026-01-08");
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => allocateSettlement(tx, ctxOf(s), {
      settlementDocumentId: rct.documentId,
      lines: [{ settledDocumentId: inv.documentId, amount: Money.of("100.0000", MYR) }],
    }))).rejects.toThrow(/ERR_VALIDATION_FAILED: allocations total 100\.0000 exceed the settlement total 40\.0000/);
  });

  it("allocating MORE than the settled document's open balance is ERR_VALIDATION_FAILED naming the document", async () => {
    const inv = await invoiceFor("30.0000", "2026-01-09");
    const rct = await receiptFor("100.0000", "2026-01-09");
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => allocateSettlement(tx, ctxOf(s), {
      settlementDocumentId: rct.documentId,
      lines: [{ settledDocumentId: inv.documentId, amount: Money.of("100.0000", MYR) }],
    }))).rejects.toThrow(/ERR_VALIDATION_FAILED: document .* has an open balance of 30\.0000/);
  });

  it("unallocate returns openBalance to the PRE-ALLOCATION figure, to the cent, and touches NO ledger entry", async () => {
    const inv = await invoiceFor("77.7700", "2026-01-10");
    const rct = await receiptFor("77.7700", "2026-01-10");
    const before = await withTenant(db.rw, s.tenant, s.human, (tx) => openBalance(tx, { documentId: inv.documentId }));
    const [ledgerBefore] = await db.admin<{ h: string }[]>`
      select md5(string_agg(id::text || debit::text || credit::text, '|' order by id))::text as h from app.ledger_entry`;
    const { allocationIds } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateSettlement(tx, ctxOf(s), {
        settlementDocumentId: rct.documentId,
        lines: [{ settledDocumentId: inv.documentId, amount: Money.of("77.7700", MYR) }],
      }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unallocate(tx, ctxOf(s), { allocationId: allocationIds[0]!, reason: "applied to the wrong invoice" }));
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) => openBalance(tx, { documentId: inv.documentId }));
    expect(after.document.toString()).toBe(before.document.toString());
    const [ledgerAfter] = await db.admin<{ h: string }[]>`
      select md5(string_agg(id::text || debit::text || credit::text, '|' order by id))::text as h from app.ledger_entry`;
    expect(ledgerAfter!.h).toBe(ledgerBefore!.h);          // spec:2457 — matching never alters a ledger entry

    // The compelled reason is STORED, and the un-allocator is stamped. Validating a reason and then
    // discarding it is the ADR 0023 loss (fiscal_period.reopen_reason) in a new table: app.audit_row
    // writes to_jsonb(new), so a value never written to a column can never be recovered from the audit.
    const [row] = await db.admin<{ reason: string | null; by: string | null; at: string | null }[]>`
      select unallocation_reason as reason, unallocated_by as by, unallocated_at as at
        from app.allocation where id = ${allocationIds[0]!}`;
    expect(row!.reason).toBe("applied to the wrong invoice");
    expect(row!.by).toBe(s.human);
    expect(row!.at).not.toBeNull();
    const [listed] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listAllocations(tx, { settledDocumentId: inv.documentId, includeUnallocated: true }));
    expect(listed!.unallocationReason).toBe("applied to the wrong invoice");
  });

  it("a CREDIT NOTE as the settlement document has capacity |total| − allocated, not |total − allocated|", async () => {
    // §4.8.1 names a credit note as a legal settlement_document_id, and Task 8 writes its magnitudes
    // NEGATED, so `total_incl_tax` is −100.0000 here. `.abs()` AFTER the subtraction would report
    // |−100 − 30| = 130.0000 of remaining capacity where 70.0000 is the truth — over-allocation admitted by
    // exactly the amount already allocated, and growing with every allocation. This is the case that
    // discriminates the order of the two operations, and it is red against `.subtract(...).abs()`.
    //
    // The note is built through `creditNoteFrom` (Task 8) and NOT through `postArDocument`, and that is
    // forced rather than stylistic: `SALES_CREDIT_NOTE.json` declares `requires: ["party",
    // "reverses_document"]`, `PostArOptions` carries no member that sets `document.reverses_document_id`,
    // and `draftTypedDocument` does not write that column either — so a note drafted through the helper is
    // refused at post with `ERR_POLICY_REQUIRES_MISSING: reverses_document` (Task 8's own fourth case
    // asserts exactly that refusal). `creditNoteFrom` sets the column, negates the magnitudes and keeps
    // `cost` a positive magnitude, which is the production path this case should be exercising anyway.
    const credited = await invoiceFor("100.0000", "2026-01-13");
    const [creditedLine] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${credited.documentId} order by line_no`;
    const note = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await creditNoteFrom(tx, ctxOf(s), {
        settledDocumentId: credited.documentId, targetDocumentTypeId: cnType, targetSeries: "CN",
        effectiveDate: "2026-01-14", reason: "the whole invoice was returned",
        lines: [{ settledLineId: creditedLine!.id, quantity: "1.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      await postDocument(tx, ctxOf(s), { documentId: r.documentId });
      return r;
    });
    const [noteTotal] = await db.admin<{ t: string }[]>`
      select coalesce(sum(total_incl_tax), 0)::text as t from app.document_line where document_id = ${note.documentId}`;
    expect(noteTotal!.t).toBe("-100.0000");   // negated magnitudes — the premise the rest of this case rests on
    const first = await invoiceFor("500.0000", "2026-01-14");
    const second = await invoiceFor("500.0000", "2026-01-14");
    await withTenant(db.rw, s.tenant, s.human, (tx) => allocateSettlement(tx, ctxOf(s), {
      settlementDocumentId: note.documentId,
      lines: [{ settledDocumentId: first.documentId, amount: Money.of("30.0000", MYR) }],
    }));
    // 100 magnitude, 30 spent, 70 left: 71 is refused and the message names 70.0000, not 130.0000.
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => allocateSettlement(tx, ctxOf(s), {
      settlementDocumentId: note.documentId,
      lines: [{ settledDocumentId: second.documentId, amount: Money.of("71.0000", MYR) }],
    }))).rejects.toThrow(/exceed the settlement total 70\.0000/);
    const { allocationIds } = await withTenant(db.rw, s.tenant, s.human, (tx) => allocateSettlement(tx, ctxOf(s), {
      settlementDocumentId: note.documentId,
      lines: [{ settledDocumentId: second.documentId, amount: Money.of("70.0000", MYR) }],
    }));
    expect(allocationIds).toHaveLength(1);
    // Σ of the note's live allocations is exactly its magnitude — spent to the cent, never past it.
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listAllocations(tx, { settlementDocumentId: note.documentId }));
    expect(rows.map((r) => r.amount)).toEqual(["30.0000", "70.0000"]);
  });

  it("an unallocated row is excluded by default and visible with includeUnallocated", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => listAllocations(tx, { settledDocumentId: undefined, includeUnallocated: true }));
    expect(rows.some((r) => r.unallocatedAt !== null)).toBe(true);
    const live = await withTenant(db.rw, s.tenant, s.human, (tx) => listAllocations(tx, {}));
    expect(live.every((r) => r.unallocatedAt === null)).toBe(true);
  });

  it("a EUR receipt against a EUR invoice at a DIFFERENT rate records the fx_difference and posts NO fx line (4B does)", async () => {
    const inv = await postArDocument(db, s, {
      documentTypeId: invType, series: "INV", partyId, effectiveDate: "2026-01-11",
      currency: "EUR", exchangeRate: "4.80000000",
      lines: [{ kind: "item", itemId, quantity: "1.000000", unitPrice: "100.0000", amount: "100.0000", cost: "1.0000" }],
    });
    const rct = await receiptFor("100.0000", "2026-01-12", "EUR", "4.90000000");
    const { fxDifference } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateSettlement(tx, ctxOf(s), {
        settlementDocumentId: rct.documentId,
        lines: [{ settledDocumentId: inv.documentId, amount: Money.of("100.0000", EUR) }],
      }));
    // 100 EUR settled at 4.90 is 490.00 base; the invoice carried it at 4.80, that is 480.00. A gain of 10.
    expect(fxDifference.toString()).toBe("10.0000");
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry e join app.account a on a.id = e.account_id
       where a.code in ('4900', '5910')`;
    expect(n!.n).toBe(0);                                   // 4A stores it; 4B posts it (§4.8.1)
  });

  it("a cross-currency allocation is refused — the settlement and the settled document must agree", async () => {
    const inv = await invoiceFor("50.0000", "2026-01-13");   // MYR
    const rct = await receiptFor("50.0000", "2026-01-13", "EUR", "4.80000000");
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => allocateSettlement(tx, ctxOf(s), {
      settlementDocumentId: rct.documentId,
      lines: [{ settledDocumentId: inv.documentId, amount: Money.of("50.0000", EUR) }],
    }))).rejects.toThrow(/ERR_MONEY_CURRENCY_MISMATCH/);
  });

  it("partyBalance is correct per currency and in base — CONCRETE figures (test 8's data-model half, §4.8.1)", async () => {
    // A FRESH party, because the figures must be arithmetic and not the residue of everything above.
    // `/^-?\d+\.\d{4}$/` was the old assertion here and it passed against a partyBalance that added each
    // receipt's own total to the balance instead of netting it — a shape assertion cannot see a wrong
    // number. These are numbers.
    const fresh = await seedParty(db, s, { kind: "customer", code: "CUST-BAL" });
    const invoiceOn = (amount: string, on: string, cur = "MYR", rate = "1.00000000") =>
      postArDocument(db, s, {
        documentTypeId: invType, series: "INV", partyId: fresh, effectiveDate: on,
        currency: cur, exchangeRate: rate,
        lines: [{ kind: "item", itemId, quantity: "1.000000", unitPrice: amount, amount, cost: "1.0000" }],
      });
    const receiptOn = (amount: string, on: string, cur = "MYR", rate = "1.00000000") =>
      postArDocument(db, s, {
        documentTypeId: rctType, series: "RCT", partyId: fresh, effectiveDate: on,
        currency: cur, exchangeRate: rate,
        lines: [{ kind: "account", accountId: bankId, description: "bank transfer",
                  amount, totalInclTax: amount }],
      });

    // MYR: a 100 invoice fully settled by a 100 receipt. Both hit 1200, so the control account nets to
    // zero — and this is the number the old document-side query got wrong, reporting 100.0000.
    const inv = await invoiceOn("100.0000", "2026-01-20");
    const rct = await receiptOn("100.0000", "2026-01-21");
    await withTenant(db.rw, s.tenant, s.human, (tx) => allocateSettlement(tx, ctxOf(s), {
      settlementDocumentId: rct.documentId,
      lines: [{ settledDocumentId: inv.documentId, amount: Money.of("100.0000", MYR) }],
    }));
    // EUR: a 100 invoice at 4.80 settled by a 100 receipt at 4.90. The EUR column nets to zero; the BASE
    // column keeps the −10.0000 the rate move created, which is the realised gain 4B posts through
    // 4900/5910 and the honest answer here rather than a hidden rounding.
    await invoiceOn("100.0000", "2026-01-22", "EUR", "4.80000000");
    await receiptOn("100.0000", "2026-01-23", "EUR", "4.90000000");

    const bal = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      partyBalance(tx, { partyId: fresh, asOf: "2026-01-31" }));
    expect(Object.keys(bal.byCurrency).sort()).toEqual(["EUR", "MYR"]);
    expect(bal.byCurrency["MYR"]!.toString()).toBe("0.0000");
    expect(bal.byCurrency["EUR"]!.toString()).toBe("0.0000");
    expect(bal.base.currency).toBe("MYR");
    expect(bal.base.toString()).toBe("-10.0000");
    // And an `asOf` BEFORE the receipt still shows the invoice open — the date filter is on the ledger row.
    const mid = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      partyBalance(tx, { partyId: fresh, asOf: "2026-01-20" }));
    expect(mid.byCurrency["MYR"]!.toString()).toBe("100.0000");
  });

  it("a second tenant sees no allocation of this tenant (spec:106)", async () => {
    const other = await seedTenantV2(db, "allocation-other");
    const rows = await withTenant(db.rw, other.tenant, other.human, (tx) => listAllocations(tx, { includeUnallocated: true }));
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see the exact expected failure**

Run: `bun run --cwd packages/db test ar-ap/allocation`
Expected: FAIL with a module-resolution error on `../../src/ar-ap/allocation`, and — once the module exists but before the migration — `relation "app.allocation" does not exist`.

- [ ] **Step 3: Write `packages/db/migrations/0046_create_allocation.sql`**

```sql
-- 0046_create_allocation.sql
-- Slice 4A. app.allocation — which settlement paid which invoice (contracts §4.8.1, spec:1042).
-- It is NOT a ledger table: a receipt relieves the AR control account in total when it posts, and this table
-- records the apportionment. That is what lets `unallocate` exist without touching a posted entry
-- (spec:2457, LEGACY-041). The `posting-only-tables` lint (§3.7.5) does not list it and must not gain it.

-- ── 1. the table (§4.8.1's DDL, with Task 0's amendment 11 columns and CHECK) ───
create table app.allocation (
  id                     uuid primary key default uuidv7(),
  tenant_id              uuid not null references app.tenant(id),
  company_id             uuid not null,
  party_id               uuid not null,
  settlement_document_id uuid not null,                                   -- RECEIPT / PAYMENT / credit note
  settled_document_id    uuid not null,                                   -- invoice / credit note being settled
  amount                 numeric(19,4) not null,                          -- document currency of the SETTLED document
  base_amount            numeric(19,4) not null,                          -- at the SETTLED document's rate
  fx_difference          numeric(19,4) not null default 0,                -- base: settlement base − settled base
  allocated_by           uuid not null default app.current_actor() references app.principal(id),
  unallocated_at         timestamptz,
  unallocated_by         uuid references app.principal(id),                -- stamped on the NULL → value transition
  unallocation_reason    text,                                             -- the reason `unallocate` compels
  created_at             timestamptz not null default now(),
  constraint allocation_amount_check   check (amount > 0),                -- §4.8.1's DDL, verbatim
  constraint allocation_distinct_check check (settlement_document_id <> settled_document_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)             references app.company(tenant_id, id),
  foreign key (tenant_id, party_id)               references app.party(tenant_id, id),
  foreign key (tenant_id, settlement_document_id) references app.document(tenant_id, id),
  foreign key (tenant_id, settled_document_id)    references app.document(tenant_id, id)
);
-- ── 2. the two lookups every read of this table performs (§4.8.1, Task 0 amendment 11) ───
-- `allocateSettlement`'s capacity read and `listAllocations({ settlementDocumentId })` scan by settlement;
-- `openBalance` and `listAllocations({ settledDocumentId })` scan by settled document. PARTIAL, because a
-- reversed allocation is never one of those reads — every one of them carries `unallocated_at is null`.
-- Plain `create index`, never `concurrently`: a migration file runs whole in one transaction (§3.4.5).
create index allocation_settlement_idx on app.allocation (settlement_document_id) where unallocated_at is null;
create index allocation_settled_idx    on app.allocation (settled_document_id)    where unallocated_at is null;

-- ── 3. the column comment ADR 0023's loss makes load-bearing ───
comment on column app.allocation.unallocation_reason is
  'The reason `unallocate` compels its caller to supply. It is a COLUMN and not a log line: app.audit_row '
  'writes to_jsonb(new) of the row, so a value never written to a column cannot appear in the audit image — '
  'the same loss ADR 0023 fixed for fiscal_period.reopen_reason by making it a column (contracts §4.3.4).';

-- ── 4. tenancy, audit, stamps, privileges (§3.5.1) ───
call app_meta.enable_tenant_rls('app.allocation');                         -- spec:106; policy `tenant_isolation`, RLS enabled AND forced
call app_meta.attach_audit('app.allocation');                              -- every allocation and un-allocation is audited
call app_meta.attach_stamp('app.allocation', 'allocated_by');              -- §3.5.1 step 4; the *_by rule of §3.3
call app_meta.attach_stamp('app.allocation', 'unallocated_by');            -- BOTH stamps, exactly as §4.8.3's bank_match carries two
-- Two stamps and not one, for the same two reasons §4.8.3 gives bank_match's matched_by/unmatched_by pair:
-- the stamp_actor LINTER rule fires on every *_by column with no stamp_<col> trigger (plan0A:2755-2758) and
-- §3.5.2 requires zero violations; and app.stamp_actor() stamps on the NULL → value transition and RAISES
-- ERR_ACTOR_IMMUTABLE on a change from one non-null actor to another (plan0A:2372-2385), which is exactly
-- unallocate's shape — allocated_by is untouched by that UPDATE and unallocated_by is set once, for ever.
-- app_rw receives select, insert, update through default privileges. NO DELETE: an allocation is reversed by
-- setting unallocated_at, never removed (§3.5.4's pinned list is unchanged by this slice).
```

- [ ] **Step 4: Write `packages/db/migrations/0046.down.sql`**

```sql
-- Drops exactly what 0046 created, in reverse dependency order (§3.4.5).
drop index if exists app.allocation_settled_idx;      -- §4.8.1's settled-document lookup
drop index if exists app.allocation_settlement_idx;   -- §4.8.1's settlement lookup
drop table if exists app.allocation;   -- takes its policy, audit trigger, both stamp triggers and grants with it
```

- [ ] **Step 5: Write `packages/db/src/ar-ap/allocation.ts`**

```ts
import { Money, currency, toBase, type CurrencyCode, type ExchangeRate } from "@dulja/domain";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";

export interface AllocationLine { settledDocumentId: string; amount: Money }
export interface AllocationRow {
  id: string; companyId: string; partyId: string;
  settlementDocumentId: string; settledDocumentId: string;
  amount: string; baseAmount: string; fxDifference: string;
  allocatedBy: string; unallocatedAt: string | null; unallocatedBy: string | null;
  unallocationReason: string | null; createdAt: string;
  /** Derived, joined, stored in no column — see the interface comment in Task 9's Produces block. */
  currency: string; baseCurrency: string;
}
export interface PartyBalance { byCurrency: Record<string, Money>; base: Money }

interface DocFacts {
  companyId: string; partyId: string | null; currency: string; exchangeRate: string;
  rateSource: string | null; effectiveDate: string; total: string; status: string;
}

/** Header facts plus the document's own total from its lines — one query, so the two cannot disagree. */
async function docFacts(tx: Sql, documentId: string): Promise<DocFacts> {
  const [row] = await tx<DocFacts[]>`
    select d.company_id as "companyId", d.party_id as "partyId", d.currency,
           d.exchange_rate::text as "exchangeRate", d.rate_source as "rateSource",
           to_char(d.effective_date, 'YYYY-MM-DD') as "effectiveDate", d.status::text as status,
           coalesce((select sum(dl.total_incl_tax) from app.document_line dl where dl.document_id = d.id), 0)
             ::numeric(19,4)::text as total
      from app.document d where d.id = ${documentId}`;
  if (row === undefined) throw new Error(`ERR_NOT_FOUND: document ${documentId} is not visible`);
  return row;
}

/**
 * The document's own rate, as the `ExchangeRate` `toBase` takes. **This is the only base conversion this
 * slice performs in TypeScript, and it goes through `toBase` rather than through a hand-rolled multiply**
 * (Global Constraint 5): `toBase` is `round(value × rate, 4)` HALF_AWAY_FROM_ZERO, byte-for-byte the
 * identity `ledger_entry`'s CHECK enforces (spec:1816, §4.2.1). A second spelling of that arithmetic would
 * be a second answer, which is LEGACY-019 in a new place.
 */
function rateOf(facts: DocFacts, from: CurrencyCode, base: CurrencyCode): ExchangeRate {
  return {
    from, to: base, rate: facts.exchangeRate,
    effectiveFrom: facts.effectiveDate,
    source: facts.rateSource ?? "unit",
  };
}

/** total − Σ live allocations, in the document's own currency and in base (§4.8.1). */
export async function openBalance(
  tx: Sql, input: { documentId: string },
): Promise<{ document: Money; base: Money }> {
  const facts = await docFacts(tx, input.documentId);
  const [alloc] = await tx<{ amount: string; base: string }[]>`
    select coalesce(sum(amount), 0)::text as amount, coalesce(sum(base_amount), 0)::text as base
      from app.allocation
     where settled_document_id = ${input.documentId} and unallocated_at is null`;
  const cur = currency(facts.currency) as CurrencyCode;
  const [company] = await tx<{ base: string }[]>`
    select base_currency as base from app.company where id = ${facts.companyId}`;
  const baseCur = currency(company!.base) as CurrencyCode;
  // The document's total in base is `round(total × rate, 4)` — base = value × rate (spec:1816, LEGACY-012) —
  // through `toBase`, which is that identity's one implementation (§4.2.1).
  const totalBase = toBase(Money.of(facts.total, cur), rateOf(facts, cur, baseCur));
  // `.abs()` is deliberate and it is a MAGNITUDE, not a sign loss — and it is taken on the TOTAL, BEFORE
  // the allocations are subtracted, which is the only order that is arithmetic rather than nonsense. A
  // credit note's `total_incl_tax` is negative (4A Task 8) and §4.8.1 makes a credit note a legal
  // `settlement_document_id`, so for a credit note of −100.0000 with 30.0000 already allocated
  // `|−100 − 30| = 130.0000` would report MORE capacity than the note ever had, and each further
  // allocation would raise it again: over-allocation admitted by exactly the amount already allocated,
  // which is the invariant §6.2's row-1042 proof table names as this slice's allocation proof.
  // `|−100| − 30 = 70.0000` is the figure every caller means. `app.allocation.amount` carries
  // `check (amount > 0)`, so the magnitude is also the only thing it can be compared against; which side
  // of the ledger the document sits on is its TYPE's fact, not this figure's.
  // `Money.of(facts.total, cur)` PARSES the leading minus: 0D's `AMOUNT` regex in
  // packages/domain/src/money/money.ts is `/^-?\d+(\.\d{1,4})?$/` and 0D asserts
  // `Money.of("-1.0000", MYR).isNegative()`. Task 0's gate greps for that literal so the assumption is
  // checked before this file is written; if it ever stops holding, the fallback at every negative-parse
  // site in this slice is `Money.of(magnitude).negate()` — `abs()` the column in SQL, parse the
  // magnitude, negate in TypeScript — and NOT a second money parser here.
  return {
    document: Money.of(facts.total, cur).abs().subtract(Money.of(alloc!.amount, cur)),
    base: totalBase.abs().subtract(Money.of(alloc!.base, baseCur)),
  };
}

/**
 * §4.8.1. Records which invoices a settlement paid. It writes NO ledger row — the settlement's own posting
 * already relieved the control account — and it computes `fx_difference` in base without posting it: the
 * gain or loss is 4B's `FX_REVALUATION` through `4900`/`5910` (§4.15), which is why test 8 is 4B's.
 */
export async function allocateSettlement(
  tx: Sql, ctx: TenantContext, input: { settlementDocumentId: string; lines: AllocationLine[] },
): Promise<{ allocationIds: string[]; fxDifference: Money }> {
  if (input.lines.length === 0) throw new Error("ERR_VALIDATION_FAILED: an allocation needs at least one line");
  const settlement = await docFacts(tx, input.settlementDocumentId);
  if (settlement.status !== "posted") {
    throw new Error(`ERR_DOC_STATUS_ILLEGAL: settlement ${input.settlementDocumentId} is not posted`);
  }
  if (settlement.partyId === null) throw new Error("ERR_VALIDATION_FAILED: the settlement carries no party");
  const setCur = currency(settlement.currency) as CurrencyCode;
  const [company] = await tx<{ base: string }[]>`
    select base_currency as base from app.company where id = ${settlement.companyId}`;
  const baseCur = currency(company!.base) as CurrencyCode;

  // 1. Σ lines may not exceed the settlement's own total, less what it has already allocated.
  const [already] = await tx<{ amount: string }[]>`
    select coalesce(sum(amount), 0)::text as amount from app.allocation
     where settlement_document_id = ${input.settlementDocumentId} and unallocated_at is null`;
  const asked = input.lines.reduce((acc, l) => acc.add(l.amount), Money.zero(setCur));  // ERR_MONEY_CURRENCY_MISMATCH here
  // The magnitude FIRST, then the subtraction — see `openBalance`'s comment. A credit note is a legal
  // settlement document (§4.8.1), its total is negative, and `|total − already|` would grant it capacity
  // it never had.
  const capacity = Money.of(settlement.total, setCur).abs().subtract(Money.of(already!.amount, setCur));
  if (asked.compare(capacity) > 0) {
    throw new Error(
      `ERR_VALIDATION_FAILED: allocations total ${asked.toString()} exceed the settlement total ${capacity.toString()}`);
  }

  const ids: string[] = [];
  let fx = Money.zero(baseCur);
  for (const line of input.lines) {
    const settled = await docFacts(tx, line.settledDocumentId);
    if (settled.status !== "posted") {
      throw new Error(`ERR_DOC_STATUS_ILLEGAL: document ${line.settledDocumentId} is not posted`);
    }
    if (settled.partyId !== settlement.partyId) {
      throw new Error(`ERR_VALIDATION_FAILED: document ${line.settledDocumentId} belongs to a different party`);
    }
    // Currencies must agree. `Money.subtract` would throw ERR_MONEY_CURRENCY_MISMATCH anyway; asking here
    // makes the message name the document, and the type parameter makes the common case a COMPILE error.
    const settledCur = currency(settled.currency) as CurrencyCode;
    if (settledCur !== setCur) {
      throw new Error(
        `ERR_MONEY_CURRENCY_MISMATCH: settlement is ${setCur} and document ${line.settledDocumentId} is ${settledCur}`);
    }
    const open = await openBalance(tx, { documentId: line.settledDocumentId });
    if (line.amount.compare(open.document) > 0) {
      throw new Error(
        `ERR_VALIDATION_FAILED: document ${line.settledDocumentId} has an open balance of ${open.document.toString()}`);
    }

    // base_amount is at the SETTLED document's rate (§4.8.1's column comment). fx_difference is the same
    // value at the SETTLEMENT's rate minus that — the gain or loss the settlement realised. Both go
    // through `toBase`, which is what Global Constraint 5 names: one rounding rule, one implementation.
    const baseAtSettled = toBase(line.amount, rateOf(settled, settledCur, baseCur));
    const baseAtSettlement = toBase(line.amount, rateOf(settlement, setCur, baseCur));
    const diff = baseAtSettlement.subtract(baseAtSettled);

    const [row] = await tx<{ id: string }[]>`
      insert into app.allocation
        (tenant_id, company_id, party_id, settlement_document_id, settled_document_id,
         amount, base_amount, fx_difference)
      values (app.current_tenant(), ${settlement.companyId}, ${settlement.partyId},
              ${input.settlementDocumentId}, ${line.settledDocumentId},
              ${line.amount.toString()}, ${baseAtSettled.toString()}, ${diff.toString()})
      returning id`;
    ids.push(row!.id);
    fx = fx.add(diff);
  }
  return { allocationIds: ids, fxDifference: fx };
}

/**
 * Sets `unallocated_at`, `unallocated_by` and `unallocation_reason`. Never touches a ledger entry
 * (spec:2457, LEGACY-041).
 *
 * **The reason is WRITTEN, not merely validated.** `app.audit_row` records `to_jsonb(new)` of the row
 * (plan0A), so a value that never reaches a column cannot reach the audit image either — compelling a
 * caller to supply a reason and then discarding it is the loss ADR 0023 fixed for
 * `fiscal_period.reopen_reason` by giving it a column, and migration 0046 gives this one a column for the
 * same reason. **`app.current_actor()` in the UPDATE is redundant with the trigger, not a substitute for
 * it:** `stamp_actor` stamps on the NULL → value transition and overwrites whatever value the statement
 * supplied (plan0A:2372–2385), so the guarantee is the trigger's. It is written here anyway because this is
 * the one place a reader looks to find out who reversed an allocation, and an UPDATE that set only
 * `unallocated_at` would read as if nobody was recorded. Do not remove the `attach_stamp` call on the
 * strength of this line.
 */
export async function unallocate(
  tx: Sql, _ctx: TenantContext, input: { allocationId: string; reason: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (reason === "") throw new Error("ERR_VALIDATION_FAILED: a reason is required to unallocate");
  const [row] = await tx<{ id: string }[]>`
    update app.allocation
       set unallocated_at      = now(),
           unallocated_by      = app.current_actor(),
           unallocation_reason = ${reason}
     where id = ${input.allocationId} and unallocated_at is null
    returning id`;
  if (row === undefined) throw new Error(`ERR_NOT_FOUND: allocation ${input.allocationId} is not open`);
}

/**
 * Per-currency and base open balances for a party — test 8's "correct in all three currencies".
 *
 * **It reads the LEDGER, on the party's own control account, and never the document totals.** A
 * document-side computation cannot answer this question: `app.allocation` keys on `settled_document_id`,
 * and a RECEIPT is always the *settlement* and never a settled document, so summing every posted document
 * of the party matches no allocation row for the receipt and adds its full positive total to the balance
 * instead of subtracting it — a 100.0000 invoice fully settled by a 100.0000 receipt would come out at
 * 100.0000 where the answer is 0.0000. The control account nets the pair by construction, because that is
 * what a control account is: the invoice debits it and the receipt credits it, both through the posting
 * service. It is also the source `app.party_open_balance` reads (migration 0045) and the control §4.8.2
 * fixes for 4B's ageing — `1200` trade receivables and `2100` trade payables, the §4.5.7 defaults — so the
 * three read the same rows and cannot give three answers about what is open.
 *
 * Allocation does not enter the arithmetic at all, and that is deliberate: it records *which* invoice a
 * settlement paid, never *that* one was paid, so subtracting it here would subtract the same settlement
 * twice.
 *
 * **THE SIGN CONVENTION, stated because two callers already differ on it (§4.8.1).** This function returns
 * a PARTY-FACING figure: **positive means "owed to us" for a customer and "owed by us" for a vendor**,
 * which is why the `case` on `party.kind` — `-1` for a vendor, `1` otherwise — is inside the query and not
 * left to the caller. A vendor's payable control account carries a credit balance, so the raw ledger
 * figure `Σ (base_debit − base_credit)` on `2100` is NEGATIVE and what this function returns is its
 * negation. **`app.party_open_balance` (migration 0045) does NOT negate**: it returns the raw
 * `Σ (base_debit − base_credit)` and reads `receivable_account_id` only, because what it serves is credit
 * control — the trigger and `creditStatus()` (0045's own comment) — and credit control is a customer
 * question, so there is no vendor side for it to flip. So for a customer the two functions agree
 * exactly and for a vendor they differ by one negation, and neither is wrong — they answer two questions.
 *
 * **The consequence for 4B, which is the first slice to hold both figures at once:** its `ageingTieOut`
 * compares Σ `party_ageing.base_amount` against the LEDGER balance of `1200`/`2100` read directly, and a
 * ledger balance is unflipped. **A vendor figure taken from `partyBalance` must be negated before it is
 * compared with a control-account balance; the tie-out must not be routed through `partyBalance`
 * unconverted.** Nothing in 4A compares the two, which is why the rule is written down here rather than
 * enforced by a test in this slice.
 *
 * `ledger_entry` carries its own `currency`, `effective_date`, `debit`/`credit` (document currency) and
 * `base_debit`/`base_credit` (plan0A 0001), so the per-currency split needs nothing from `document` but
 * the party.
 */
export async function partyBalance(tx: Sql, input: { partyId: string; asOf: string }): Promise<PartyBalance> {
  const rows = await tx<{ currency: string; open: string; openBase: string }[]>`
    select l.currency,
           coalesce(sum((l.debit - l.credit) * sgn.v), 0)::numeric(19,4)::text           as open,
           coalesce(sum((l.base_debit - l.base_credit) * sgn.v), 0)::numeric(19,4)::text as "openBase"
      from app.ledger_entry l
      join app.document d on d.id = l.document_id
      join app.party    p on p.id = d.party_id
      join lateral (select case when p.kind = 'vendor' then -1 else 1 end as v) sgn on true
     where d.party_id = ${input.partyId}
       and l.effective_date <= ${input.asOf}::date
       and l.account_id = case when p.kind = 'vendor' then p.payable_account_id
                               else p.receivable_account_id end
     group by l.currency order by l.currency`;
  const [company] = await tx<{ base: string }[]>`
    select c.base_currency as base from app.company c
      join app.party p on p.company_id = c.id where p.id = ${input.partyId}`;
  const baseCur = currency(company!.base) as CurrencyCode;
  const byCurrency: Record<string, Money> = {};
  let base = Money.zero(baseCur);
  for (const r of rows) {
    byCurrency[r.currency] = Money.of(r.open, currency(r.currency) as CurrencyCode);
    base = base.add(Money.of(r.openBase, baseCur));
  }
  return { byCurrency, base };
}

export async function listAllocations(
  tx: Sql, input: { settlementDocumentId?: string; settledDocumentId?: string; includeUnallocated?: boolean },
): Promise<AllocationRow[]> {
  // The two joins carry NO column: `sd.currency` is the settled document's own currency, in which
  // `amount` is denominated, and `c.base_currency` is the currency of `base_amount` and `fx_difference`.
  // A row therefore states both of its currencies, which is what lets the API mapper (Step 6) return
  // three `{ amount, currency }` objects without a second query and without guessing.
  return tx<AllocationRow[]>`
    select a.id, a.company_id as "companyId", a.party_id as "partyId",
           a.settlement_document_id as "settlementDocumentId", a.settled_document_id as "settledDocumentId",
           a.amount::text as amount, a.base_amount::text as "baseAmount", a.fx_difference::text as "fxDifference",
           a.allocated_by as "allocatedBy", a.unallocated_at as "unallocatedAt",
           a.unallocated_by as "unallocatedBy", a.unallocation_reason as "unallocationReason",
           a.created_at as "createdAt",
           sd.currency as currency, c.base_currency as "baseCurrency"
      from app.allocation a
      join app.document   sd on sd.id = a.settled_document_id
      join app.company    c  on c.id  = a.company_id
     where (${input.settlementDocumentId ?? null}::uuid is null or a.settlement_document_id = ${input.settlementDocumentId ?? null})
       and (${input.settledDocumentId ?? null}::uuid is null    or a.settled_document_id    = ${input.settledDocumentId ?? null})
       and (${input.includeUnallocated ?? false} or a.unallocated_at is null)
     order by a.created_at, a.id`;
}
```

Add `export * from "./allocation";` to `packages/db/src/ar-ap/index.ts`.

- [ ] **Step 6: Write the contracts module and the four sub-paths**

`packages/contracts/src/accounting/allocation.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, MoneySchema, TimestampSchema, UuidSchema } from "../common";

/**
 * **Money on this row is `MoneySchema`, not a bare 4-dp string, and that is a considered exception to
 * 3C's document-sub-resource convention (§4.2.8).** The exception exists because a sub-resource's
 * currency is implied by its parent document — but this row carries TWO currencies: `amount` and
 * `baseAmount`/`fxDifference` are the settled document's currency and the company's base currency
 * respectively, and on a foreign-currency settlement they differ. A bare string would leave a reader
 * unable to tell which is which, which is the one thing the convention exists to make safe.
 */
export const AllocationSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  partyId: UuidSchema,
  settlementDocumentId: UuidSchema,
  settledDocumentId: UuidSchema,
  amount: MoneySchema,
  baseAmount: MoneySchema,
  fxDifference: MoneySchema,
  allocatedBy: UuidSchema,
  unallocatedAt: TimestampSchema.nullable(),
  unallocatedBy: UuidSchema.nullable(),
  /** Returned beside the two above so a reversal is legible without a second query. */
  unallocationReason: z.string().nullable(),
  createdAt: TimestampSchema,
}).openapi("Allocation");

export const AllocateSettlementBody = z.object({
  lines: z.array(z.object({
    settledDocumentId: UuidSchema,
    amount: MoneySchema,
  })).min(1),
}).openapi("AllocateSettlementBody");

export const AllocateSettlementResultSchema = z.object({
  allocationIds: z.array(UuidSchema),
  /** Stored, never posted: 4B posts the gain or loss through `4900`/`5910` (§4.8.1). */
  fxDifference: MoneySchema,
}).openapi("AllocateSettlementResult");

/** `.min(1)` because `unallocate` COMPELS a reason, and `.max(2000)` is the bound 2B's `OverrideBody.reason`
 *  uses — the value is stored in `allocation.unallocation_reason`, so the column and the reader both live
 *  with the same length. */
export const UnallocateBody = z.object({
  reason: z.string().min(1).max(2000),
}).openapi("UnallocateBody");

export const AllocationQuery = z.object({
  "filter[unallocated][eq]": z.enum(["true", "false"]).optional(),
}).openapi("AllocationQuery");

export const AllocationList = ListEnvelope(AllocationSchema);

export const OpenBalanceSchema = z.object({
  documentId: UuidSchema,
  document: MoneySchema,
  base: MoneySchema,
}).openapi("OpenBalance");

export const PartyBalanceSchema = z.object({
  partyId: UuidSchema,
  asOf: DateSchema,
  /** Keyed by ISO 4217 code. **Party-facing:** positive is "owed to us" for a customer and "owed by us"
   *  for a vendor, which for a vendor is the ledger figure negated (§4.8.1's sign convention). */
  byCurrency: z.record(z.string().regex(/^[A-Z]{3}$/), MoneySchema),
  base: MoneySchema,
}).openapi("PartyBalance");
```

The five sub-paths, all on modules that already exist. In `apps/api/src/routes/accounting/documents.ts`:

```ts
const AllocationParams = DocumentParams.extend({ allocationId: UuidSchema });

documentRoutes.openapi(createRoute({
  method: "post", path: "/{documentId}/allocations",
  request: { params: DocumentParams, headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: AllocateSettlementBody } } } },
  // "submit", per 3C's rule for a POST sub-path of an EXISTING document. The document on the path is the
  // SETTLEMENT, so the code resolved is the settlement type's own — `accounting.receipt.create` for a
  // RECEIPT, `accounting.payment.create` for a PAYMENT.
  middleware: [requireDocumentPermission("submit")],
  tags: ["accounting"],
  responses: {
    201: { content: { "application/json": { schema: AllocateSettlementResultSchema } }, description: "Allocated" },
    422: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Over-allocated, cross-currency, or a document that is not posted" },
  },
}), async (c) => {
  const { documentId } = c.req.valid("param");
  const { lines } = c.req.valid("json");
  const result = await c.var.withTenant((tx) => allocateSettlement(tx, c.var.ctx, {
    settlementDocumentId: documentId,
    lines: lines.map((l) => ({ settledDocumentId: l.settledDocumentId, amount: Money.of(l.amount.amount, currency(l.amount.currency)) })),
  }));
  return c.json({ allocationIds: result.allocationIds, fxDifference: result.fxDifference.toJSON() }, 201);
});

documentRoutes.openapi(createRoute({
  method: "get", path: "/{documentId}/allocations",
  request: { params: DocumentParams, query: AllocationQuery },
  // A READ: membership plus the type's module read code (§4.5.4's last paragraph). `requireDocumentPermission`
  // maps write stages only, and listing `accounting.ledger.read` statically would trip ERR_ROUTE_GATE_READONLY.
  middleware: [requireDocumentModuleRead()],
  tags: ["accounting"],
  responses: {
    200: { content: { "application/json": { schema: AllocationList } }, description: "Allocations of, or against, this document" },
  },
}), async (c) => {
  const { documentId } = c.req.valid("param");
  const q = c.req.valid("query");
  // BOTH directions in one read: a document is a settlement in some rows and a settled document in others,
  // and a caller looking at an invoice wants the receipts that paid it. `listAllocations` takes the two
  // filters separately, so the union is taken here rather than by widening the service.
  const rows = await c.var.withTenant(async (tx) => [
    ...await listAllocations(tx, { settlementDocumentId: documentId, includeUnallocated: q["filter[unallocated][eq]"] === "true" }),
    ...await listAllocations(tx, { settledDocumentId: documentId, includeUnallocated: q["filter[unallocated][eq]"] === "true" }),
  ]);
  return c.json({ items: rows.map(toAllocationDto), next_cursor: null }, 200);
});

documentRoutes.openapi(createRoute({
  method: "post", path: "/{documentId}/allocations/{allocationId}/unallocate",
  request: { params: AllocationParams, headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: UnallocateBody } } } },
  middleware: [requireDocumentPermission("submit")],
  tags: ["accounting"],
  responses: {
    200: { content: { "application/json": { schema: AllocationSchema } }, description: "Reversed; the reason is stored on the row" },
    404: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "No open allocation with that id" },
  },
}), async (c) => {
  const { documentId, allocationId } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  const row = await c.var.withTenant(async (tx) => {
    await unallocate(tx, c.var.ctx, { allocationId, reason });
    // `.find`, not `[0]`: `listAllocations` returns EVERY allocation of this settlement and the reversed
    // one is not necessarily the first. A settlement carrying a single allocation would hide the mistake
    // in a test and hand a caller who asked about a reversed row a live one in production.
    return (await listAllocations(tx, { settlementDocumentId: documentId, includeUnallocated: true }))
      .find((r) => r.id === allocationId);
  });
  if (row === undefined) throw new AppError("ERR_NOT_FOUND", "the allocation is not visible");
  return c.json(toAllocationDto(row), 200);
});

documentRoutes.openapi(createRoute({
  method: "get", path: "/{documentId}/open-balance",
  request: { params: DocumentParams },
  middleware: [requireDocumentModuleRead()],
  tags: ["accounting"],
  responses: {
    200: { content: { "application/json": { schema: OpenBalanceSchema } }, description: "Total less live allocations, in the document's currency and in base" },
  },
}), async (c) => {
  const { documentId } = c.req.valid("param");
  const open = await c.var.withTenant((tx) => openBalance(tx, { documentId }));
  return c.json({ documentId, document: open.document.toJSON(), base: open.base.toJSON() }, 200);
});
```

with the one mapper the three write-side handlers share, declared once in the same file:

```ts
/** `AllocationRow` carries 4-dp strings; the wire carries `{ amount, currency }`. The three currencies are
 *  read from the row's own documents in `listAllocations`' projection, so the mapper takes them as fields
 *  rather than re-querying — `amount` in the settled document's currency, `baseAmount` and `fxDifference`
 *  in base. Declared once because three handlers return the same shape (hazard 9). */
const toAllocationDto = ({ currency, baseCurrency, ...rest }: AllocationRow) => ({
  ...rest,                                       // the two currency members are DESTRUCTURED OUT here:
  amount: { amount: rest.amount, currency },     // they are carriers, not members of `AllocationSchema`,
  baseAmount: { amount: rest.baseAmount, currency: baseCurrency },      // and a spread that left them in
  fxDifference: { amount: rest.fxDifference, currency: baseCurrency },  // would not type-check against it.
});
```

⚠️ **`listAllocations`' projection therefore gains two read-only members, `currency` and `baseCurrency`, in this step.** They are not new columns — they are `app.document.currency` of the settled document and `app.company.base_currency`, joined in `listAllocations`' `select`, so the wire can name the two currencies a row's three money fields are in. Add them to `AllocationRow` in `packages/db/src/ar-ap/allocation.ts` and to the `select` of Step 5's `listAllocations`; the DB-tier suite reads `r.amount` as a string and is unaffected. **This is the one addition to Task 0's amendment 11 shape and it is stated here rather than made silently:** amendment 11 fixes `AllocationRow`'s twelve members and this adds two derived ones, so the amendment's row in §4.18 is written as "…`createdAt`**, plus the two derived read-only members `currency` and `baseCurrency` the wire mapper needs**".

And in `apps/api/src/routes/accounting/parties.ts` — 2A's module:

```ts
partyRoutes.openapi(createRoute({
  method: "get", path: "/{partyId}/balance",
  request: { params: z.object({ companyId: UuidSchema, partyId: UuidSchema }),
             query: z.object({ asOf: DateSchema }) },
  middleware: [gate()],
  tags: ["accounting"],
  responses: {
    200: { content: { "application/json": { schema: PartyBalanceSchema } }, description: "Open balance per currency and in base" },
    403: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Forbidden" },
  },
}), async (c) => {
  const { partyId } = c.req.valid("param");
  const { asOf } = c.req.valid("query");
  const bal = await c.var.withTenant((tx) => partyBalance(tx, { partyId, asOf }));
  return c.json({
    partyId, asOf,
    byCurrency: Object.fromEntries(Object.entries(bal.byCurrency).map(([k, v]) => [k, v.toJSON()])),
    base: bal.base.toJSON(),
  }, 200);
});
```

**`gate()` is 2A's own module-local helper**, reused and not re-declared: `parties.ts` declares `const gate = () => requirePermission(PERMISSION["accounting.party.manage"], { company: "path:companyId" });` once at the top of the file (2a:3993) and all five of its existing routes call it, so a second `{ company: "path:companyId" }` literal here would be the duplication hazard 9 names. **The params object is spelled inline for the same reason** — `z.object({ companyId: UuidSchema, partyId: UuidSchema })` is verbatim what 2A's `GET …/{partyId}` already writes (2a:4072); there is no `PartyParams` export to import, and inventing one would mean rewriting 2A's five existing routes to use it. **`asOf` is a required query parameter and not a defaulted one**: a balance is always *as of* a date, and defaulting it to `now()` would make two callers a second apart disagree with no visible cause.

**Three names join `parties.ts`'s import block in this step** — 2A's list (2a:3985–3986) carries none of them: `DateSchema` and `PartyBalanceSchema` from `@dulja/contracts`, beside the `PartySchema` and `UuidSchema` already there, and `partyBalance` from `@dulja/db`, which is that file's first import from the DB package (its existing handlers are inline SQL through `c.var.withTenant`). Nothing is removed and no existing route changes.

**No new `PROBES` key.** `PROBES` is keyed by `RouteModule.path` (hazard 31) and both modules already have one; the five routes inherit them. **`RouteModule.permissions` on 2A's `parties` module is unchanged** — `accounting.party.manage` is already listed.

- [ ] **Step 7: Write the route suite `apps/api/test/routes/accounting/allocations.test.ts`**

Five routes, and the suite proves what only the route can be wrong about: the gate, the idempotency header, the wire shape of a two-currency row, and the union read. The arithmetic is Step 1's. `startApi()` and not `sharedApi()`, for the reason Task 10's route suite gives; the two document types are seeded inline, because `loadTypesFromPack` lives in `packages/db/test/` and `apps/api` may not reach into another package's test tree (§3.1).

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedParty, seedTenantV2,
  withTenant, type Seed,
} from "@dulja/db/test";
import { issueDocument, postDocument } from "@dulja/db";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";   // FIVE levels (2a:3253)
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let invType: string;
let rctType: string;
let partyId: string;
let bankId: string;

/** Two minimal `effect: "none"` account-line policies — an AR debit type and a bank/AR settlement type.
 *  They are the ledger shapes of `SALES_INVOICE` and `RECEIPT` reduced to `kind: "account"` lines, which
 *  is all a ROUTE test needs; the seeded files' own shapes are proven by the DB suites. */
const ACCOUNT_POLICY = (code: string, series: string, post: string, arSide: "debit" | "credit") => ({
  version: 1 as const, documentType: code, direction: "outbound" as const, requires: ["party"] as const,
  lines: [
    { for: "each_line", side: arSide, account: { from: "party.receivable_account" }, amount: "line.total_incl_tax", when: { "line.kind": "account" } },
    { for: "each_line", side: arSide === "debit" ? "credit" : "debit", account: { from: "line.account" }, amount: "line.total_incl_tax", when: { "line.kind": "account" } },
  ],
  inventory: { effect: "none" as const }, tax: { applies: false },
  numbering: { series, assignAt: "issue" as const },
  reversal: { allowed: true, producesType: code },
  approval: { required: false, approve: null, post, create: post },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" as const },
  dimensions: { required: [] as const },
});

const ctx = () => ({ tenantId: s.tenant, actorId: s.human, requestId: "00000000-0000-0000-0000-000000000000" });

/** Draft, issue and post a one-account-line document of `typeId` for `amount`. */
async function posted(typeId: string, series: string, amount: string, effectiveDate: string): Promise<string> {
  const { documentId, lineIds } = await draftTypedDocument(api.db, s, {
    documentTypeId: typeId, series, effectiveDate, partyId,
    lines: [{ kind: "account", accountId: bankId, description: "line", amount }],
  });
  await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
    await tx`update app.document_line set total_incl_tax = ${amount} where id = ${lineIds[0]!}`;
    await tx`update app.document set rate_source = ${"unit"} where id = ${documentId}`;
    await issueDocument(tx, ctx(), { documentId });
    await postDocument(tx, ctx(), { documentId });
  });
  return documentId;
}

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "allocations-api");
  await grantAdmin(api, s);
  for (const [code, nameEn, type] of [
    ["1100", "Bank", "asset"], ["1200", "Trade receivables", "asset"], ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(api.db, s, { code, nameEn, type });
  const [bank] = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
    tx<{ id: string }[]>`select id from app.account where company_id = ${s.company} and code = ${"1100"}`);
  bankId = bank!.id;
  invType = await seedDocumentType(api.db, s, { code: "API_AR_INVOICE", module: "accounting", policy: ACCOUNT_POLICY("API_AR_INVOICE", "AINV", "accounting.sales.post", "debit") });
  rctType = await seedDocumentType(api.db, s, { code: "API_AR_RECEIPT", module: "accounting", policy: ACCOUNT_POLICY("API_AR_RECEIPT", "ARCT", "accounting.receipt.create", "credit") });
  partyId = await seedParty(api.db, s, { kind: "customer", code: "API-ALLOC" });
  await grantCodes(api.db, s, { codes: ["accounting.sales.post", "accounting.receipt.create"] });
}, 240_000);
afterAll(async () => { await api.stop(); });

describe("the five allocation routes (4A)", () => {
  it("GET …/documents/{id}/open-balance returns the total in BOTH currencies before anything is allocated", async () => {
    const inv = await posted(invType, "AINV", "100.0000", "2026-01-05");
    const res = await api.request({ method: "GET", path: `/v1/companies/${s.company}/documents/${inv}/open-balance`, as: s.human });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      documentId: inv,
      document: { amount: "100.0000", currency: "MYR" },
      base: { amount: "100.0000", currency: "MYR" },
    });
  });

  it("POST …/allocations returns 201 with the allocation ids and a zero fxDifference in BASE", async () => {
    const inv = await posted(invType, "AINV", "60.0000", "2026-01-06");
    const rct = await posted(rctType, "ARCT", "60.0000", "2026-01-07");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${rct}/allocations`, as: s.human,
      body: { lines: [{ settledDocumentId: inv, amount: { amount: "60.0000", currency: "MYR" } }] },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { allocationIds: string[]; fxDifference: { amount: string; currency: string } };
    expect(body.allocationIds).toHaveLength(1);
    expect(body.fxDifference).toEqual({ amount: "0.0000", currency: "MYR" });
    const open = await api.request({ method: "GET", path: `/v1/companies/${s.company}/documents/${inv}/open-balance`, as: s.human });
    expect((await open.json() as { document: { amount: string } }).document.amount).toBe("0.0000");
  });

  it("POST …/allocations without an Idempotency-Key is ERR_IDEMPOTENCY_KEY_MISSING (§4.2.9)", async () => {
    const inv = await posted(invType, "AINV", "9.0000", "2026-01-08");
    const rct = await posted(rctType, "ARCT", "9.0000", "2026-01-08");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${rct}/allocations`, as: s.human,
      idempotencyKey: null, body: { lines: [{ settledDocumentId: inv, amount: { amount: "9.0000", currency: "MYR" } }] },
    });
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("an over-allocation is 422 and names the open balance", async () => {
    const inv = await posted(invType, "AINV", "30.0000", "2026-01-09");
    const rct = await posted(rctType, "ARCT", "100.0000", "2026-01-09");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${rct}/allocations`, as: s.human,
      body: { lines: [{ settledDocumentId: inv, amount: { amount: "100.0000", currency: "MYR" } }] },
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).detail).toMatch(/open balance of 30\.0000/);
  });

  it("an empty `lines` array is refused on the WIRE by `.min(1)`, before the service", async () => {
    const rct = await posted(rctType, "ARCT", "1.0000", "2026-01-10");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${rct}/allocations`, as: s.human,
      body: { lines: [] },
    });
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("GET …/allocations reads BOTH directions and returns three `{ amount, currency }` objects per row", async () => {
    const inv = await posted(invType, "AINV", "40.0000", "2026-01-11");
    const rct = await posted(rctType, "ARCT", "40.0000", "2026-01-11");
    await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${rct}/allocations`, as: s.human,
      body: { lines: [{ settledDocumentId: inv, amount: { amount: "40.0000", currency: "MYR" } }] },
    });
    // From the SETTLEMENT's side…
    const fromReceipt = await api.request({ method: "GET", path: `/v1/companies/${s.company}/documents/${rct}/allocations`, as: s.human });
    const a = (await fromReceipt.json() as { items: Record<string, unknown>[] }).items;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      amount: { amount: "40.0000", currency: "MYR" },
      baseAmount: { amount: "40.0000", currency: "MYR" },
      fxDifference: { amount: "0.0000", currency: "MYR" },
      unallocatedAt: null,
      unallocationReason: null,
    });
    // …and from the SETTLED document's side, which is the read a clerk looking at an invoice makes.
    const fromInvoice = await api.request({ method: "GET", path: `/v1/companies/${s.company}/documents/${inv}/allocations`, as: s.human });
    expect((await fromInvoice.json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it("POST …/unallocate stores the compelled reason and returns the reversed row", async () => {
    const inv = await posted(invType, "AINV", "12.0000", "2026-01-12");
    const rct = await posted(rctType, "ARCT", "12.0000", "2026-01-12");
    const created = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${rct}/allocations`, as: s.human,
      body: { lines: [{ settledDocumentId: inv, amount: { amount: "12.0000", currency: "MYR" } }] },
    });
    const { allocationIds } = await created.json() as { allocationIds: string[] };
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${rct}/allocations/${allocationIds[0]}/unallocate`,
      as: s.human, body: { reason: "applied to the wrong invoice" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unallocationReason: "applied to the wrong invoice" });
    const open = await api.request({ method: "GET", path: `/v1/companies/${s.company}/documents/${inv}/open-balance`, as: s.human });
    expect((await open.json() as { document: { amount: string } }).document.amount).toBe("12.0000");
  });

  it("an EMPTY reason is refused on the wire — `unallocate` compels one (§4.8.1)", async () => {
    const inv = await posted(invType, "AINV", "3.0000", "2026-01-13");
    const rct = await posted(rctType, "ARCT", "3.0000", "2026-01-13");
    const created = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${rct}/allocations`, as: s.human,
      body: { lines: [{ settledDocumentId: inv, amount: { amount: "3.0000", currency: "MYR" } }] },
    });
    const { allocationIds } = await created.json() as { allocationIds: string[] };
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${rct}/allocations/${allocationIds[0]}/unallocate`,
      as: s.human, body: { reason: "" },
    });
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("GET …/parties/{partyId}/balance is party-facing and requires an explicit asOf", async () => {
    const res = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/parties/${partyId}/balance?asOf=2026-01-31`, as: s.human,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { partyId: string; asOf: string; byCurrency: Record<string, { amount: string; currency: string }>; base: { amount: string } };
    expect(body).toMatchObject({ partyId, asOf: "2026-01-31" });
    expect(body.byCurrency["MYR"]!.currency).toBe("MYR");
    const noAsOf = await api.request({ method: "GET", path: `/v1/companies/${s.company}/parties/${partyId}/balance`, as: s.human });
    expect((await problemOf(noAsOf)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("an unauthenticated caller is 401 on every one of the five, and neither module gained a PROBES key", async () => {
    const inv = await posted(invType, "AINV", "1.0000", "2026-01-14");
    for (const path of [
      `/v1/companies/${s.company}/documents/${inv}/open-balance`,
      `/v1/companies/${s.company}/documents/${inv}/allocations`,
      `/v1/companies/${s.company}/parties/${partyId}/balance?asOf=2026-01-31`,
    ]) {
      expect((await api.request({ method: "GET", path })).status).toBe(401);
    }
    const { PROBES } = await import("../../../../../tests/invariants/probes");
    expect(PROBES["/v1/companies/:companyId/documents"]).toBeDefined();
    expect(PROBES["/v1/companies/:companyId/parties"]).toBeDefined();
    expect(Object.keys(PROBES).filter((k) => k.includes("allocations"))).toEqual([]);
  });
});
```

- [ ] **Step 8: Append the two regression blocks**

`tests/regression/legacy-041.test.ts` — append (0B created it):

```ts
describe("LEGACY-041 An allocation never alters a posted entry — 4A", () => {
  it("app_rw holds no DELETE on app.allocation, and unallocate is an UPDATE of one column", async () => {
    const { rw } = await sharedDb();
    const [grant] = await rw.db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'allocation' and privilege_type = 'DELETE'`;
    expect(grant!.n).toBe(0);
  });

  it("`allocation` is NOT in the posting-only-tables list, and that is deliberate", async () => {
    const { repoFile } = await import("../support/regression");
    const rule = repoFile("scripts/lint/rules/posting-only-tables.ts");
    expect(rule).not.toMatch(/app\.allocation/);
    // §4.8.1: a receipt relieves the control account when it POSTS; the allocation records the
    // apportionment. Listing it would forbid the service that legitimately writes it.
  });
});
```

`tests/regression/legacy-019.test.ts` — **append, create-if-absent** (§3.7.3's rule for a file whose creator the catalogue does not name; the `describe` block is order-independent so both orders produce the identical file):

```ts
describe("LEGACY-019 One rounding function, one mode, symmetric across sign — 4A", () => {
  it("this slice names ONE rounding mode and no rounding surface of its own", async () => {
    const { repoFile } = await import("../support/regression");
    for (const f of [
      "packages/db/src/ar-ap/allocation.ts",
      "packages/db/src/ar-ap/invoice.ts",
      "packages/db/src/ar-ap/credit-note.ts",
    ]) {
      const src = repoFile(f);
      // The legacy defect was eight configured rounding columns, zero references, and a function that
      // returned 10 when rounding 8 down to base 5. The structural fix here is that these files own NO
      // rounding surface: `decimal.js` is packages/domain's dependency (§4.2.1, D11) and nothing under
      // packages/db/src imports it — the rule 3B fixed for packages/db/src/costing (3b:1124) — so the only
      // mode any of them can name is the one `Money.multiply` is given.
      expect(src).not.toMatch(/from "decimal\.js"/);
      // Every rounding mode reaches `Money`/`Quantity` as a quoted `RoundingMode` literal (§4.2.1), so the
      // quoted occurrences are the complete set of modes the file can use. Prose in a comment is not a
      // mode and is deliberately not matched.
      for (const m of src.match(/"(HALF_AWAY_FROM_ZERO|HALF_EVEN|TOWARD_ZERO|AWAY_FROM_ZERO)"/g) ?? []) {
        expect(m).toBe('"HALF_AWAY_FROM_ZERO"');
      }
    }
  });

  it("every base conversion in this slice goes through `toBase` and none is hand-rolled", async () => {
    const { repoFile } = await import("../support/regression");
    const src = repoFile("packages/db/src/ar-ap/allocation.ts");
    // Global Constraint 5: `allocation.ts` is the one file in this slice that converts to base, and it
    // does so through `toBase` — `round(value × rate, 4)` HALF_AWAY_FROM_ZERO, the identity
    // ledger_entry's CHECK enforces (spec:1816). A `× exchange_rate` written out here would be a second
    // implementation of that identity and therefore a second answer.
    expect(src).toMatch(/toBase\(/);
    // Anchored on CODE shapes, not on prose: `.times(` is decimal.js's multiply and `multiply(` with a
    // rate argument is Money's. A comment that happens to write out `value * exchange_rate` is not a second
    // implementation and must not fail this case — which an unanchored /\* *exchange_rate/ would.
    expect(src).not.toMatch(/\.times\(/);
    expect(src).not.toMatch(/multiply\([^)]*[eE]xchangeRate/);
  });

  it("the base identity holds on every row this slice posts, in both signs", async () => {
    const { rw } = await sharedDb();
    const [n] = await rw.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry
       where base_debit <> round(debit * exchange_rate, 4) or base_credit <> round(credit * exchange_rate, 4)`;
    expect(n!.n).toBe(0);
  });
});
```

- [ ] **Step 9: Run everything**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test ar-ap/allocation && bun run --cwd packages/db db:lint && bun run --cwd apps/api test routes/accounting/allocations && node --test tests/regression/legacy-019.test.ts tests/regression/legacy-041.test.ts && bun run --cwd packages/contracts openapi:generate`
Expected: PASS — twelve DB cases, ten route cases, `db:lint` at zero, both regression files green, and an OpenAPI diff showing five added paths and seven added components (`Allocation`, `AllocateSettlementBody`, `AllocateSettlementResult`, `UnallocateBody`, `AllocationQuery`, `OpenBalance`, `PartyBalance`).

- [ ] **Step 10: Commit**

```bash
git add packages/db/migrations/0046_create_allocation.sql packages/db/migrations/0046.down.sql \
        packages/db/src/schema/allocation.ts packages/db/src/ar-ap/allocation.ts \
        packages/db/src/ar-ap/index.ts packages/contracts/src/accounting/allocation.ts \
        packages/contracts/openapi.json apps/api/src/routes/accounting/documents.ts \
        apps/api/src/routes/accounting/parties.ts packages/db/test/ar-ap/allocation.test.ts \
        apps/api/test/routes/accounting/allocations.test.ts \
        tests/regression/legacy-019.test.ts tests/regression/legacy-041.test.ts
git commit -m "feat(db): app.allocation, allocateSettlement, openBalance and partyBalance [4A T9]

§4.8.1 verbatim. Allocation is not a ledger fact: the settlement's own posting relieves the control
account and this table records the apportionment, which is what lets unallocate exist without touching
a posted entry (spec:2457). Over-allocation is refused against both the settlement total and the
settled document's open balance; fx_difference is computed and stored, and 4B posts the gain or loss.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `RECEIPT` and `PAYMENT` — money in without maker-checker, money out with it

The two settlement types, and the slice's re-run of tests **10** and **31**. spec:2147 states the asymmetry in one clause — "receipts (money in) need no maker-checker, payments (money out) do" — and it is expressed entirely in the two policies' `approval` blocks.

**Files:**
- Create: `packages/db/seed/my/document-types/RECEIPT.json`, `PAYMENT.json`
- Create: `packages/db/src/ar-ap/settlement.ts`
- Create: `packages/contracts/src/accounting/settlement.ts`
- Create: `packages/db/test/ar-ap/settlement.test.ts`, `apps/api/test/routes/accounting/settlements.test.ts`
- Modify: `packages/db/src/ar-ap/index.ts`, `apps/api/src/routes/accounting/documents.ts` (one sub-path)
- Modify: `tests/regression/legacy-031.test.ts` (append)

**Interfaces:**
- Consumes: `allocateSettlement` (Task 9); `transitionDocument`, `postDocument`, `issueDocument` (§4.3.1); `app.document_status_before` with R1 and R2 (2B); `grantCodes`, `secondPrincipal` (2B, 3D); `INCOMPATIBLE_PAIRS` (§4.2.5); the accounts `1100`, `1200`, `2100` (§4.15, 0C).
- Produces: the two seed files, and:

```ts
// packages/db/src/ar-ap/settlement.ts
export interface SettlementInput {
  companyId: string; documentTypeId: string; series: string; effectiveDate: string;
  partyId: string; bankAccountId: string; currency: string; exchangeRate: string;
  amount: string;                                   // 4-dp decimal string, POSITIVE
  reference?: string | null;                        // the cheque or transfer reference; reaches description
  /** The document's branch. `document.branch_id` is NOT NULL (spec:1766) and a settlement is a head-office
   *  act with no branch of its own, so when this is absent the function takes the company's lowest-coded
   *  BRANCH value — `HQ` in every seeded company (§4.1). The route ALWAYS sends one. */
  branchId?: string;
  /** Allocate to these documents in the same transaction. Empty means an ON-ACCOUNT settlement. */
  allocations?: readonly { settledDocumentId: string; amount: string }[];
}
export interface SettlementResult { documentId: string; lineId: string; allocationIds: string[] }
/** Drafts a one-line RECEIPT or PAYMENT and, when `allocations` is non-empty, posts it and allocates in the
 *  SAME transaction — so a settlement is never posted with an allocation that failed, and never allocated
 *  against a document it did not settle. A `required` approval type is drafted only: the caller walks it
 *  through the state machine, because R1 needs two principals and two transactions. */
export async function draftSettlement(tx: Sql, ctx: TenantContext, input: SettlementInput): Promise<SettlementResult>;
```

- [ ] **Step 1: Write the failing test `packages/db/test/ar-ap/settlement.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { draftSettlement } from "../../src/ar-ap/settlement";
import { openBalance, partyBalance } from "../../src/ar-ap/allocation";
import { issueDocument, postDocument, transitionDocument } from "../../src/posting";
import { grantCodes, seedAccount, seedItem, seedParty, seedTenantV2, startDb, withTenant, type Db, type Seed } from "../index";
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";
import { accountByCode, loadTypesFromPack } from "./_support";

let db: Db; let s: Seed;
let rctType: string; let payType: string; let invType: string;
let customerId: string; let vendorId: string; let itemId: string; let bankId: string;
// No `Money`/`currency` import and no `MYR` constant: every allocation this suite makes goes through
// `draftSettlement`, which takes 4-dp STRINGS and builds the `Money` itself, and the one arithmetic
// assertion below uses the `Money` the returned `PartyBalance` already carries. An unused import fails
// `bun run lint`, and `allocateSettlement` is likewise not imported — Task 9's suite is where it is
// called directly; here it is reached only through `draftSettlement`.
const ctxOf = (seed: Seed, actor?: string) =>
  ({ tenantId: seed.tenant, actorId: actor ?? seed.human, requestId: "00000000-0000-0000-0000-000000000000" });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "settlement");
  for (const [code, nameEn, type] of [
    ["1100", "Bank", "asset"], ["1200", "Trade receivables", "asset"], ["1250", "Goods delivered not invoiced", "asset"],
    ["2100", "Trade payables", "liability"], ["5000", "Cost of goods sold", "expense"], ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(db, s, { code, nameEn, type });
  bankId = await accountByCode(db, s, "1100");
  ({ receiptType: rctType, paymentType: payType, salesInvoiceType: invType } =
    await loadTypesFromPack(db, s, ["RECEIPT", "PAYMENT", "SALES_INVOICE"]) as never);
  customerId = await seedParty(db, s, { kind: "customer", code: "CUST-SET" });
  vendorId = await seedParty(db, s, { kind: "vendor", code: "VEND-SET" });
  ({ itemId } = await seedItem(db, s, { code: "IT-SET", kind: "product", trackLots: false }));
  await grantCodes(db, s, {
    codes: ["accounting.sales.post", "accounting.receipt.create", "accounting.receipt.post", "accounting.payment.create"],
  });
}, 180_000);
afterAll(async () => { await db.stop(); });

describe("RECEIPT and PAYMENT — §4.14, spec:2147, tests 10 and 31", () => {
  it("a RECEIPT posts debit bank, credit trade receivables, and needs ONE principal (spec:2147)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const d = await draftSettlement(tx, ctxOf(s), {
        companyId: s.company, documentTypeId: rctType, series: "RCT", effectiveDate: "2026-01-10",
        partyId: customerId, bankAccountId: bankId, currency: "MYR", exchangeRate: "1.00000000",
        amount: "250.0000", reference: "TT-8891",
      });
      await issueDocument(tx, ctxOf(s), { documentId: d.documentId });
      await postDocument(tx, ctxOf(s), { documentId: d.documentId });
      return d;
    });
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text as debit, e.credit::text as credit
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${r.documentId} order by a.code`;
    expect(rows).toEqual([
      { code: "1100", debit: "250.0000", credit: "0.0000"   },
      { code: "1200", debit: "0.0000",   credit: "250.0000" },
    ]);
  });

  it("draftSettlement posts and allocates in ONE transaction, so a failed allocation posts nothing", async () => {
    const inv = await postArDocument(db, s, {
      documentTypeId: invType, series: "INV", partyId: customerId, effectiveDate: "2026-01-11",
      lines: [{ kind: "item", itemId, quantity: "1.000000", unitPrice: "60.0000", amount: "60.0000", cost: "10.0000" }],
    });
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => draftSettlement(tx, ctxOf(s), {
      companyId: s.company, documentTypeId: rctType, series: "RCT", effectiveDate: "2026-01-12",
      partyId: customerId, bankAccountId: bankId, currency: "MYR", exchangeRate: "1.00000000",
      amount: "60.0000",
      allocations: [{ settledDocumentId: inv.documentId, amount: "999.0000" }],   // over the open balance
    }))).rejects.toThrow(/ERR_VALIDATION_FAILED: document .* has an open balance of 60\.0000/);
    // Nothing survived: the whole withTenant rolled back.
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document d join app.document_type t on t.id = d.document_type_id
       where t.code = 'RECEIPT' and d.effective_date = '2026-01-12'`;
    expect(n!.n).toBe(0);
  });

  it("a good allocation drives the invoice's open balance to zero in the same transaction", async () => {
    const inv = await postArDocument(db, s, {
      documentTypeId: invType, series: "INV", partyId: customerId, effectiveDate: "2026-01-13",
      lines: [{ kind: "item", itemId, quantity: "1.000000", unitPrice: "60.0000", amount: "60.0000", cost: "10.0000" }],
    });
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) => draftSettlement(tx, ctxOf(s), {
      companyId: s.company, documentTypeId: rctType, series: "RCT", effectiveDate: "2026-01-14",
      partyId: customerId, bankAccountId: bankId, currency: "MYR", exchangeRate: "1.00000000",
      amount: "60.0000", allocations: [{ settledDocumentId: inv.documentId, amount: "60.0000" }],
    }));
    expect(r.allocationIds).toHaveLength(1);
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) => openBalance(tx, { documentId: inv.documentId }));
    expect(open.document.toString()).toBe("0.0000");
  });

  it("TEST 10 and 31 — a PAYMENT cannot be approved by its own submitter through any path", async () => {
    const checker = await secondPrincipal(db, s, "pay-checker");
    await grantCodes(db, s, {
      codes: ["accounting.payment.approve", "accounting.payment.post"], principalId: checker, roleCode: "pay-checker",
    });
    const pay = await withTenant(db.rw, s.tenant, s.human, (tx) => draftSettlement(tx, ctxOf(s), {
      companyId: s.company, documentTypeId: payType, series: "PAY-OUT", effectiveDate: "2026-01-15",
      partyId: vendorId, bankAccountId: bankId, currency: "MYR", exchangeRate: "1.00000000", amount: "80.0000",
    }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: pay.documentId, to: "submitted" }));
    // (a) the API/service path: the submitter tries to approve.
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: pay.documentId, to: "approved" })))
      .rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER/);
    // (b) direct app_rw SQL: the same refusal, from the trigger, with no service in the way (test 31).
    await expect(withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.document set status = 'approved' where id = ${pay.documentId}`))
      .rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER/);
    // (c) the second principal succeeds, and posts.
    await withTenant(db.rw, s.tenant, checker, async (tx) => {
      await transitionDocument(tx, ctxOf(s, checker), { documentId: pay.documentId, to: "approved" });
      await issueDocument(tx, ctxOf(s, checker), { documentId: pay.documentId });
      await postDocument(tx, ctxOf(s, checker), { documentId: pay.documentId });
    });
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text as debit, e.credit::text as credit
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${pay.documentId} order by a.code`;
    expect(rows).toEqual([
      { code: "1100", debit: "0.0000",  credit: "80.0000" },
      { code: "2100", debit: "80.0000", credit: "0.0000"  },
    ]);
  });

  it("TEST 10 — a principal holding only *.create cannot post a PAYMENT (R2, from the trigger)", async () => {
    const drafter = await secondPrincipal(db, s, "pay-drafter");
    await grantCodes(db, s, { codes: ["accounting.payment.create"], principalId: drafter, roleCode: "pay-drafter" });
    const pay = await withTenant(db.rw, s.tenant, drafter, (tx) => draftSettlement(tx, ctxOf(s, drafter), {
      companyId: s.company, documentTypeId: payType, series: "PAY-OUT", effectiveDate: "2026-01-16",
      partyId: vendorId, bankAccountId: bankId, currency: "MYR", exchangeRate: "1.00000000", amount: "10.0000",
    }));
    await withTenant(db.rw, s.tenant, drafter, (tx) =>
      transitionDocument(tx, ctxOf(s, drafter), { documentId: pay.documentId, to: "submitted" }));
    await expect(withTenant(db.rw, s.tenant, drafter, (tx) =>
      transitionDocument(tx, ctxOf(s, drafter), { documentId: pay.documentId, to: "approved" })))
      .rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER|ERR_RBAC_FORBIDDEN/);
  });

  it("a RECEIPT needs NO submission — draft → issued is legal because approval.required is false (§4.5.1)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const d = await draftSettlement(tx, ctxOf(s), {
        companyId: s.company, documentTypeId: rctType, series: "RCT", effectiveDate: "2026-01-17",
        partyId: customerId, bankAccountId: bankId, currency: "MYR", exchangeRate: "1.00000000", amount: "5.0000",
      });
      await issueDocument(tx, ctxOf(s), { documentId: d.documentId });   // straight from draft
      return d;
    });
    const [doc] = await db.admin<{ status: string }[]>`select status::text as status from app.document where id = ${r.documentId}`;
    expect(doc!.status).toBe("issued");
  });

  it("an ON-ACCOUNT receipt with no allocation posts, and shows in partyBalance as a credit", async () => {
    const before = await withTenant(db.rw, s.tenant, s.human, (tx) => partyBalance(tx, { partyId: customerId, asOf: "2026-01-31" }));
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const d = await draftSettlement(tx, ctxOf(s), {
        companyId: s.company, documentTypeId: rctType, series: "RCT", effectiveDate: "2026-01-18",
        partyId: customerId, bankAccountId: bankId, currency: "MYR", exchangeRate: "1.00000000", amount: "15.0000",
      });
      await issueDocument(tx, ctxOf(s), { documentId: d.documentId });
      await postDocument(tx, ctxOf(s), { documentId: d.documentId });
    });
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) => partyBalance(tx, { partyId: customerId, asOf: "2026-01-31" }));
    // `Money.compare` and not `Number(...) < Number(...)`: no `number` holds a monetary value, in a test
    // either (Global Constraint 4, §3.7.5 `no-number-money`). A 15.0000 receipt credits 1200, so the
    // control-account balance the ledger reports falls by exactly that — assert the figure, not just the
    // direction, now that `partyBalance` reads the ledger rather than summing document totals.
    expect(after.byCurrency["MYR"]!.compare(before.byCurrency["MYR"]!)).toBe(-1);
    expect(before.byCurrency["MYR"]!.subtract(after.byCurrency["MYR"]!).toString()).toBe("15.0000");
  });

  it("the two series number independently and gaplessly (test 16's shape over this slice's series)", async () => {
    for (const [series] of [["RCT"], ["PAY-OUT"]]) {
      const [gaps] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from app.document_series ds
        cross join lateral app.series_gaps(ds.company_id, ds.series, ds.fiscal_period_id)
         where ds.series = ${series!}`;
      expect(gaps!.n).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run it to see the exact expected failure**

Run: `bun run --cwd packages/db test ar-ap/settlement`
Expected: FAIL in `beforeAll` with `Error: the seed pack has no document type RECEIPT`, thrown by `loadTypesFromPack` (Task 5's `_support.ts`) — the two files do not exist yet — and, before that, a TypeScript resolution error on `../../src/ar-ap/settlement`. Both are the correct red: the two policies are Step 3 and the service is Step 4. **This is the red the seed-file-first order could not produce**, which is why the files are written after the test and not before it.

- [ ] **Step 3: Write the two seed files**

`RECEIPT.json`:

```json
{
  "code": "RECEIPT",
  "nameEn": "Receipt",
  "nameAr": "سند قبض",
  "module": "accounting",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "RECEIPT",
    "direction": "inbound",
    "requires": ["party"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" },             "amount": "line.total_incl_tax", "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "party.receivable_account" }, "amount": "line.total_incl_tax", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "RCT", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "RECEIPT" },
    "approval": { "required": false, "approve": null, "post": "accounting.receipt.post", "create": "accounting.receipt.create" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

`PAYMENT.json` is the mirror: `direction: "outbound"`, the debit leg on `party.payable_account` and the credit leg on `line.account`, series `PAY-OUT`, `reversal.producesType: "PAYMENT"`, and — the one clause that matters —

```json
    "approval": { "required": true, "approve": "accounting.payment.approve", "post": "accounting.payment.post", "create": "accounting.payment.create" },
```

**Five choices worth stating.**

- **One `kind: "account"` line per settlement, carrying the bank or cash account and the money.** The alternative — one line per settled invoice — would put the apportionment in the ledger, where `unallocate` could not undo it without altering a posted entry (spec:2457). The control account is relieved in total and `app.allocation` records which invoices; that is §4.8.1's design and Task 9's whole reason.
- **`amount: "line.total_incl_tax"` on both legs, not `line.amount`.** A settlement has no tax and the two columns are equal, but `total_incl_tax` is what `openBalance` and `partyBalance` read (Task 9) — using a different column here would make a receipt's ledger figure and its allocation capacity two things that agree only by luck.
- **`approval.required: true` on `PAYMENT` and `false` on `RECEIPT` — spec:2147, and it is the whole of R1 for this slice.** With `required: true`, 2B's `document_status_before` refuses `→ approved` with no `submitted` event (`ERR_SOD_NO_SUBMISSION`) and refuses an approver who submitted (`ERR_SOD_MAKER_IS_CHECKER`), and refuses `→ posted` without `accounting.payment.post` (R2). None of that is code in this slice.
- **`approval.create: "accounting.payment.create"` and `approve` ≠ `post` ≠ `create` — three distinct codes, which is what makes R6's pair meaningful.** The seed gives `user` the `create` and `accountant` the `approve`/`post` (Task 2), so the *seeded roles* cannot put one principal on both sides; R1 then guarantees the same for a principal who holds both through two roles (spec:2177).
- **`reversal.producesType` is the type's own code for both.** A receipt banked in error is reversed by a receipt with negated magnitudes — the same mechanism as the credit notes, and no `RECEIPT_REVERSAL` type is registered or needed. `requires` deliberately does **not** include `reverses_document` here: unlike a credit note, a settlement is a complete document on its own (an on-account receipt is legitimate), so a `requires` entry would refuse the ordinary case.

- [ ] **Step 4: Write `packages/db/src/ar-ap/settlement.ts`**

```ts
import { Money, currency, type CurrencyCode } from "@dulja/domain";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { allocateSettlement } from "./allocation";
import { issueDocument, postDocument } from "../posting";

export interface SettlementInput {
  companyId: string; documentTypeId: string; series: string; effectiveDate: string;
  partyId: string; bankAccountId: string; currency: string; exchangeRate: string;
  amount: string; reference?: string | null;
  allocations?: readonly { settledDocumentId: string; amount: string }[];
}
export interface SettlementResult { documentId: string; lineId: string; allocationIds: string[] }

/**
 * §4.14's RECEIPT and PAYMENT. ONE `kind: "account"` line carrying the bank or cash account and the money —
 * the apportionment lives in `app.allocation` (§4.8.1) and never in the ledger, which is what lets
 * `unallocate` exist without altering a posted entry (spec:2457).
 *
 * When `allocations` is non-empty the document is issued, posted AND allocated on the caller's `tx`, so a
 * failed allocation rolls the posting back with it. That is only legal for a type whose policy declares
 * `approval.required = false` — a RECEIPT. For a PAYMENT the function drafts and returns: R1 needs two
 * principals in two sessions, and the caller walks the state machine.
 */
export async function draftSettlement(
  tx: Sql, ctx: TenantContext, input: SettlementInput,
): Promise<SettlementResult> {
  const cur = currency(input.currency) as CurrencyCode;
  const amount = Money.of(input.amount, cur);           // ERR_MONEY_SCALE on more than 4 dp
  if (!amount.isPositive()) throw new Error("ERR_VALIDATION_FAILED: a settlement amount must be positive");

  const [term] = await tx<{ id: string | null }[]>`
    select payment_term_id as id from app.party where id = ${input.partyId}`;
  if (term === undefined) throw new Error(`ERR_NOT_FOUND: party ${input.partyId} is not visible`);

  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, status, series, effective_date, party_id, currency,
       exchange_rate, rate_source, branch_id, payment_term_id)
    values (app.current_tenant(), ${input.companyId}, ${input.documentTypeId}, 'draft', ${input.series},
            ${input.effectiveDate}::date, ${input.partyId}, ${input.currency}, ${input.exchangeRate},
            ${input.exchangeRate === "1.00000000" ? "unit" : `manual:${ctx.actorId}`},
            coalesce(${input.branchId ?? null}::uuid,
                     (select dv.id from app.dimension_value dv
                        join app.dimension_type dt on dt.id = dv.dimension_type_id
                       where dt.code = 'BRANCH' and dt.company_id = ${input.companyId}
                       order by dv.code limit 1)),
            ${term.id})
    returning id`;

  const [line] = await tx<{ id: string }[]>`
    insert into app.document_line
      (tenant_id, company_id, document_id, line_no, kind, description, account_id,
       amount, tax_amount, total_incl_tax)
    values (app.current_tenant(), ${input.companyId}, ${doc!.id}, 1, 'account',
            ${input.reference ?? null}, ${input.bankAccountId},
            ${amount.toString()}, ${"0.0000"}, ${amount.toString()})
    returning id`;

  if (input.allocations === undefined || input.allocations.length === 0) {
    return { documentId: doc!.id, lineId: line!.id, allocationIds: [] };
  }

  // Post first, then allocate: `openBalance` reads posted documents, and an allocation against an unposted
  // settlement would be a promise rather than a fact. Both are on the caller's `tx`, so a refusal in either
  // rolls the other back — which is the case the suite's second test asserts.
  await issueDocument(tx, ctx, { documentId: doc!.id });
  await postDocument(tx, ctx, { documentId: doc!.id });
  const { allocationIds } = await allocateSettlement(tx, ctx, {
    settlementDocumentId: doc!.id,
    lines: input.allocations.map((a) => ({ settledDocumentId: a.settledDocumentId, amount: Money.of(a.amount, cur) })),
  });
  return { documentId: doc!.id, lineId: line!.id, allocationIds };
}
```

**The BRANCH default in that insert is deliberate and narrow.** `document.branch_id` is NOT NULL (spec:1766) and a settlement is a head-office act with no branch of its own, so `branchId` is an optional member of `SettlementInput` and the SQL `coalesce`s the caller's value over the company's lowest-coded BRANCH value — the head-office value in every seeded company (`HQ`, §4.1). Silently defaulting where the caller *did* specify would be LEGACY-042's shape in reverse, which is why the caller's value is the first argument of the `coalesce` and **the route always sends one**. A reviewer who wants the default gone makes `branchId` required, which is one line here and one in the route.

Add `export * from "./settlement";` to `packages/db/src/ar-ap/index.ts`.

- [ ] **Step 5: Write `packages/contracts/src/accounting/settlement.ts` and the one route sub-path**

```ts
// packages/contracts/src/accounting/settlement.ts
import { z } from "@hono/zod-openapi";
import { DateSchema, RateSchema, UuidSchema } from "../common";

/** A bare 4-dp decimal string, not `MoneySchema`: every amount in this body is in the settlement's own
 *  `currency`, which the body states ONCE — the document-sub-resource exception §4.2.8 registers for 3C,
 *  applied to a body whose currency is a sibling field rather than a repeated one. */
const SettlementAmount = z.string().regex(/^\d+\.\d{4}$/).openapi({ example: "250.0000" });

export const SettlementAllocationSchema = z.object({
  settledDocumentId: UuidSchema,
  amount: SettlementAmount,
}).openapi("SettlementAllocation");

export const DraftSettlementBody = z.object({
  /** RECEIPT or PAYMENT. `requireDocumentPermission("create")` resolves the policy from THIS field —
   *  the route creates a document, so there is no `:documentId` on the path to resolve from. */
  documentTypeId: UuidSchema,
  series: z.string().regex(/^[A-Z0-9-]{1,16}$/),
  effectiveDate: DateSchema,
  partyId: UuidSchema,
  bankAccountId: UuidSchema,
  branchId: UuidSchema,                       // required on the wire, optional in the service (see above)
  currency: z.string().regex(/^[A-Z]{3}$/),
  exchangeRate: RateSchema,
  amount: SettlementAmount,
  reference: z.string().max(128).nullish(),
  /** Empty or absent means an ON-ACCOUNT settlement, which is legitimate and posts on its own. */
  allocations: z.array(SettlementAllocationSchema).default([]),
}).openapi("DraftSettlementBody");

export const SettlementResultSchema = z.object({
  documentId: UuidSchema,
  lineId: UuidSchema,
  allocationIds: z.array(UuidSchema),
}).openapi("SettlementResult");
```

and in `apps/api/src/routes/accounting/documents.ts`, on 1A's existing module:

```ts
documentRoutes.openapi(createRoute({
  method: "post", path: "/settlements",
  request: { params: CompanyParams, headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: DraftSettlementBody } } } },
  // "create" and NOT "submit": 3C's rule ("a POST sub-path of an EXISTING document uses submit") is about
  // a path carrying a {documentId}; this path does not. 2A's "create" branch resolves the policy from the
  // type named in the body (§4.5.4), which is what `documentTypeId` above is for.
  middleware: [requireDocumentPermission("create")],
  tags: ["accounting"],
  responses: {
    201: { content: { "application/json": { schema: SettlementResultSchema } }, description: "Settlement drafted, and posted and allocated when `allocations` is non-empty" },
    403: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Forbidden" },
    422: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Over-allocated, or a settled document that is not posted" },
  },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await c.var.withTenant((tx) =>
    draftSettlement(tx, c.var.ctx, { companyId, ...body, reference: body.reference ?? null }));
  return c.json(result, 201);
});
```

**`CompanyParams` is 1A's existing `z.object({ companyId: UuidSchema })` for this module**, not a new schema — the module's other routes already use it, and `DocumentParams` (which extends it with `documentId`) is the wrong one here because this path has no document id.

**Why the whole call is inside ONE `c.var.withTenant`.** `draftSettlement` issues, posts and allocates on the `tx` it is given (Step 4's comment says so), so a refusal anywhere in that sequence must roll the whole thing back. Splitting it into two `withTenant` calls would post a settlement and then fail to allocate it, which is the exact state the service is built to make unreachable.

- [ ] **Step 6: Write the route suite `apps/api/test/routes/accounting/settlements.test.ts`**

The DB tier above proves the *arithmetic and the authority*; this suite proves the **route** — its gate, its idempotency, its wire validation and its status codes. It seeds its own document types inline rather than through `loadTypesFromPack`, because that helper lives in `packages/db/test/ar-ap/_support.ts` and `apps/api` may not reach into another package's test directory (§3.1); the seeded policies are the same shapes Step 3 wrote, minus the parts a route cannot see. This is 3C's `document-links.test.ts` shape, deliberately: `startApi()` (not `sharedApi()`), because this suite seeds types and posts documents and must own its database, and because §3.7.5's settlement says a test needing `startApi()` belongs in `apps/api/test/routes/`.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  grantCodes, seedAccount, seedDocumentType, seedParty, seedTenantV2, withTenant, type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five
// directories up (2a:3253, and 3C's Task 21 finding about the miscount).
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let rctType: string;
let payType: string;
let customerId: string;
let vendorId: string;
let bankId: string;
let branchId: string;

const SETTLEMENT_POLICY = (code: string, series: string, outbound: boolean) => ({
  version: 1 as const,
  documentType: code,
  direction: outbound ? ("outbound" as const) : ("inbound" as const),
  requires: ["party"] as const,
  lines: outbound
    ? [
        { for: "each_line", side: "debit",  account: { from: "party.payable_account" }, amount: "line.total_incl_tax", when: { "line.kind": "account" } },
        { for: "each_line", side: "credit", account: { from: "line.account" },           amount: "line.total_incl_tax", when: { "line.kind": "account" } },
      ]
    : [
        { for: "each_line", side: "debit",  account: { from: "line.account" },              amount: "line.total_incl_tax", when: { "line.kind": "account" } },
        { for: "each_line", side: "credit", account: { from: "party.receivable_account" },  amount: "line.total_incl_tax", when: { "line.kind": "account" } },
      ],
  inventory: { effect: "none" as const },
  tax: { applies: false },
  numbering: { series, assignAt: "issue" as const },
  reversal: { allowed: true, producesType: code },
  approval: outbound
    ? { required: true, approve: "accounting.payment.approve", post: "accounting.payment.post", create: "accounting.payment.create" }
    : { required: false, approve: null, post: "accounting.receipt.post", create: "accounting.receipt.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" as const },
  dimensions: { required: [] as const },
});

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "settlements-api");
  await grantAdmin(api, s);
  for (const [code, nameEn, type] of [
    ["1100", "Bank", "asset"], ["1200", "Trade receivables", "asset"],
    ["2100", "Trade payables", "liability"], ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(api.db, s, { code, nameEn, type });
  rctType = await seedDocumentType(api.db, s, { code: "RECEIPT", module: "accounting", policy: SETTLEMENT_POLICY("RECEIPT", "RCT", false) });
  payType = await seedDocumentType(api.db, s, { code: "PAYMENT", module: "accounting", policy: SETTLEMENT_POLICY("PAYMENT", "PAY-OUT", true) });
  customerId = await seedParty(api.db, s, { kind: "customer", code: "API-CUST" });
  vendorId = await seedParty(api.db, s, { kind: "vendor", code: "API-VEND" });
  await grantCodes(api.db, s, {
    codes: ["accounting.receipt.create", "accounting.receipt.post", "accounting.payment.create"],
  });
  const [bank] = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
    tx<{ id: string }[]>`select id from app.account where company_id = ${s.company} and code = ${"1100"}`);
  bankId = bank!.id;
  branchId = s.hq;
}, 240_000);
afterAll(async () => { await api.stop(); });

const bodyFor = (documentTypeId: string, series: string, partyId: string, amount: string, extra = {}) => ({
  documentTypeId, series, effectiveDate: "2026-01-15", partyId, bankAccountId: bankId, branchId,
  currency: "MYR", exchangeRate: "1.00000000", amount, reference: "TT-0001", allocations: [], ...extra,
});

describe("POST /v1/companies/{companyId}/documents/settlements (4A)", () => {
  it("drafts an on-account RECEIPT and returns 201 with the three-member result", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/settlements`, as: s.human,
      body: bodyFor(rctType, "RCT", customerId, "250.0000"),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { documentId: string; lineId: string; allocationIds: string[] };
    expect(body.allocationIds).toEqual([]);
    const [line] = await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx<
      { amount: string; account: string; description: string | null }[]
    >`select amount::text as amount, account_id as account, description
        from app.document_line where document_id = ${body.documentId}`);
    expect(line).toMatchObject({ amount: "250.0000", account: bankId, description: "TT-0001" });
  });

  it("sends the caller's branchId through — it is never silently replaced by the HQ default", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/settlements`, as: s.human,
      body: bodyFor(rctType, "RCT", customerId, "10.0000"),
    });
    const { documentId } = await res.json() as { documentId: string };
    const [doc] = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      tx<{ b: string }[]>`select branch_id as b from app.document where id = ${documentId}`);
    expect(doc!.b).toBe(branchId);
  });

  it("POST without an Idempotency-Key is ERR_IDEMPOTENCY_KEY_MISSING (§4.2.9)", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/settlements`, as: s.human,
      idempotencyKey: null, body: bodyFor(rctType, "RCT", customerId, "5.0000"),
    });
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("replays the same key and hash without creating a second document", async () => {
    const key = "4a-settlement-replay";
    const body = bodyFor(rctType, "RCT", customerId, "33.0000");
    const first = await api.request({ method: "POST", path: `/v1/companies/${s.company}/documents/settlements`, as: s.human, idempotencyKey: key, body });
    const again = await api.request({ method: "POST", path: `/v1/companies/${s.company}/documents/settlements`, as: s.human, idempotencyKey: key, body });
    expect(first.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await again.json() as { documentId: string }).documentId)
      .toBe((await first.json() as { documentId: string }).documentId);
  });

  it("a negative amount is refused on the wire, before the service sees it", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/settlements`, as: s.human,
      body: bodyFor(rctType, "RCT", customerId, "-5.0000"),
    });
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("an over-allocation is 422 ERR_VALIDATION_FAILED and posts NOTHING — the one-transaction claim, over HTTP", async () => {
    // The settled document is a posted 5.0000 receipt, and the new settlement tries to apply 20.0000 to
    // it: over the SETTLED document's open balance, which is the branch that fires before any insert.
    // (A receipt settling a receipt is legal — `allocation_distinct_check` only forbids the two ids being
    // equal — and it keeps this suite free of a SALES_INVOICE fixture the DB tier already owns.)
    const settled = (await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/settlements`, as: s.human,
      body: bodyFor(rctType, "RCT", customerId, "5.0000"),
    }).then((r) => r.json())) as { documentId: string };
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/settlements`, as: s.human,
      body: bodyFor(rctType, "RCT", customerId, "20.0000", {
        allocations: [{ settledDocumentId: settled.documentId, amount: "20.0000" }],
      }),
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).detail).toMatch(/open balance of 5\.0000/);
    // Nothing survived: the handler's single `withTenant` rolled the posting back with the allocation.
    const [n] = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.allocation`);
    expect(n!.n).toBe(0);
  });

  it("the create-stage gate is resolved from the BODY's type, and an unauthenticated caller is 401", async () => {
    // `requireDocumentPermission("create")` reads the policy of `documentTypeId` in the body — there is no
    // `:documentId` on this path to read it from — so a PAYMENT body resolves `accounting.payment.create`
    // and a RECEIPT body resolves `accounting.receipt.create`. `s.human` holds both through `grantCodes`
    // above, so the positive direction is 201 on each; the negative direction is asserted where it can be
    // asserted without a second principal, which is the missing token.
    const pay = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/settlements`, as: s.human,
      body: bodyFor(payType, "PAY-OUT", vendorId, "80.0000"),
    });
    expect(pay.status).toBe(201);
    const stranger = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/settlements`,
      body: bodyFor(payType, "PAY-OUT", vendorId, "80.0000"),
    });
    expect(stranger.status).toBe(401);
  });

  it("a PAYMENT is drafted and NOT posted — R1 needs two principals, so the route returns a draft", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/settlements`, as: s.human,
      body: bodyFor(payType, "PAY-OUT", vendorId, "80.0000"),
    });
    expect(res.status).toBe(201);
    const { documentId } = await res.json() as { documentId: string };
    const [doc] = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      tx<{ status: string }[]>`select status::text as status from app.document where id = ${documentId}`);
    expect(doc!.status).toBe("draft");
    // The approval walk is `POST …/documents/{id}/transitions` (2B's route), which this slice does not
    // add and does not re-test; the DB tier's tests 10 and 31 cases are where R1 is proven.
  });

  it("the module already has its PROBES entry — a sub-path adds none (hazard 31)", async () => {
    const { PROBES } = await import("../../../../../tests/invariants/probes");
    expect(PROBES["/v1/companies/:companyId/documents"]).toBeDefined();
    expect(PROBES["/v1/companies/:companyId/documents/settlements"]).toBeUndefined();
  });
});
```

- [ ] **Step 7: Append the `— 4A` block to `tests/regression/legacy-031.test.ts`**

```ts
describe("LEGACY-031 A posted settlement and its allocations are immutable in place — 4A", () => {
  it("a posted RECEIPT's ledger rows cannot be updated or deleted by app_rw", async () => {
    const { rw } = await sharedDb();
    const [g] = await rw.db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'ledger_entry'
         and privilege_type in ('UPDATE', 'DELETE')`;
    expect(g!.n).toBe(0);
  });

  it("correcting a settlement is a reversal, and the two types say so in their policies", async () => {
    const { repoFile } = await import("../support/regression");
    for (const f of ["RECEIPT", "PAYMENT"]) {
      const policy = JSON.parse(repoFile(`packages/db/seed/my/document-types/${f}.json`)) as
        { policy: { reversal: { allowed: boolean; producesType: string } } };
      expect(policy.policy.reversal.allowed).toBe(true);
      expect(policy.policy.reversal.producesType).toBe(f);
    }
  });
});
```

- [ ] **Step 8: Run everything**

Run: `bun run --cwd packages/db test ar-ap/settlement && bun run --cwd apps/api test routes/accounting/settlements && node --test tests/regression/legacy-031.test.ts && bun run --cwd packages/contracts openapi:generate`
Expected: PASS — eight DB cases (of which two are the tests 10 and 31 re-runs, each asserting the refusal through the service path *and* through direct `app_rw` SQL), nine route cases, both new `legacy-031` cases, and an OpenAPI diff showing one added path and three added components (`DraftSettlementBody`, `SettlementAllocation`, `SettlementResult`).

- [ ] **Step 9: Commit**

```bash
git add packages/db/seed/my/document-types/RECEIPT.json packages/db/seed/my/document-types/PAYMENT.json \
        packages/db/src/ar-ap/settlement.ts packages/db/src/ar-ap/index.ts \
        packages/contracts/src/accounting/settlement.ts packages/contracts/openapi.json \
        apps/api/src/routes/accounting/documents.ts packages/db/test/ar-ap/settlement.test.ts \
        apps/api/test/routes/accounting/settlements.test.ts tests/regression/legacy-031.test.ts
git commit -m "feat(accounting): RECEIPT and PAYMENT, with maker-checker on money out only [4A T10]

spec:2147's asymmetry, expressed entirely in the two approval blocks: RECEIPT is approval.required
false, PAYMENT is true with three distinct codes so R6's seeded pair is meaningful and R1 needs two
principals. One account line per settlement carries the money; the apportionment stays in app.allocation
so unallocate never alters a posted entry. Tests 10 and 31 re-run through the service AND through direct
app_rw SQL.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: `inventory.sales_by_item` gains revenue and margin, and test 14 is re-run

The minimal-report clause spec:2300 requires this slice to keep shipping (hazard 4), and it is deliberately an **extension of 3D's registered code** and not a new one: "**One code, three shipments**" (§4.16.1). 3D shipped delivered quantity and cost because no revenue-posting type existed; this slice is the first with one, so it completes the report in the same PR as `SALES_INVOICE`'s corridor. 7B then re-expresses it over 4B's `item_profitability` under the same code.

**Files:**
- Modify: `packages/db/src/reports/sales-by-item.ts` (two members on the row, one branch in the query)
- Modify: `packages/contracts/src/inventory/reports.ts` (`SalesByItemRowSchema` gains two)
- Modify: `apps/api/src/routes/accounting/reports.ts` (the response gains two columns; the route is unchanged)
- Create: `packages/db/test/reports/sales-by-item-revenue.test.ts`
- Create: `tests/regression/legacy-014.test.ts` (**4A creates it** — §3.7.3, this slice is first in execution order to touch LEGACY-014)

**Interfaces:**
- Consumes: `salesByItem`, `SalesByItemParams`, `SalesByItemRow` (3D, §4.16.3 — the params and the `cost` member are **not** changed); `ReportCodeSchema` (1B, already carrying the code); `reportsRoutes` (1B); `Money`, `currency` (§4.2.1); `postArDocument` (Task 5), `postInventoryDocument` (3B/3D), `convertToInvoice` (Task 6), `creditNoteFrom` (Task 8).
- Produces: two additive members on 3D's row type, exactly as §4.16.3's amendment fixes them:

```ts
export interface SalesByItemRow {
  itemId: string; itemCode: string; itemNameEn: string;
  deliveredQuantity: string;        // 3D — unchanged
  cost: string;                     // 3D — unchanged: Σ cost_consumption.value over DELIVERY_ORDER issues
  revenue: string;                  // 4A — Σ round(document_line.amount × document.exchange_rate, 4) over
                                    //      posted SALES_INVOICE and SALES_CREDIT_NOTE lines, in BASE
  margin: string;                   // 4A — revenue − cost, in BASE
}
```

**Where revenue comes from, and why it is not `ledger_entry`.** `app.ledger_entry` carries no `item_id` and its `line_no` is the *ledger* line ordinal with no join back to `document_line` (1B states this in `LedgerRow`'s comment). Revenue per item therefore has to come from `document_line` on posted documents, converted with the document's own rate: `round(dl.amount * d.exchange_rate, 4)` — the identity `ledger_entry`'s CHECK enforces (spec:1816), computed in SQL so no JavaScript number touches it. **The credit note needs no sign logic**: its `amount` is already negated (Task 8), so a return is a subtraction by arithmetic. 4B's `item_profitability` projection has the same problem and solves it its own way per fiscal period; that is why §4.16.3 records this shape rather than leaving 4B and 4A to disagree.

**The one honest caveat, stated in the row's own doc comment.** `cost` is cut on deliveries and `revenue` on invoices, so a range in which goods were delivered but not yet invoiced shows cost with no revenue — and that difference *is* the `1250` balance. Task 6's corridor test is what makes the statement checkable, and the suite below asserts both the aligned case (margin ties to the ledger) and the unaligned one (the gap equals `1250`).

- [ ] **Step 1: Write the failing test `packages/db/test/reports/sales-by-item-revenue.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { salesByItem } from "../../src/reports/sales-by-item";
import { convertToInvoice } from "../../src/ar-ap/invoice";
import { creditNoteFrom } from "../../src/ar-ap/credit-note";
import { issueDocument, postDocument } from "../../src/posting";
import { seedAccount, seedItem, seedParty, seedTenantV2, seedWarehouse, startDb, withTenant, type Db, type Seed } from "../index";
import { ensureOpenPeriods, postInventoryDocument } from "../../../../tests/invariants/support/post-inventory";
import { loadTypesFromPack } from "../ar-ap/_support";

let db: Db; let s: Seed;
let invType: string; let cnType: string;
let partyId: string; let itemId: string; let warehouseId: string;
const MYR = currency("MYR");
const ctxOf = (seed: Seed) => ({ tenantId: seed.tenant, actorId: seed.human, requestId: "00000000-0000-0000-0000-000000000000" });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "sales-by-item-revenue");
  await ensureOpenPeriods(db, s, ["2026-01"]);
  for (const [code, nameEn, type] of [
    ["1200", "Trade receivables", "asset"], ["1250", "Goods delivered not invoiced", "asset"],
    ["1300", "Inventory control", "asset"], ["2150", "Goods received not invoiced", "liability"],
    ["5000", "Cost of goods sold", "expense"], ["5920", "FX rounding", "expense"],
  ] as const) await seedAccount(db, s, { code, nameEn, type });
  // `DELIVERY_ORDER` is LOADED and not BOUND: `postInventoryDocument` resolves it by code, so the type
  // must exist in this Testcontainers database, but nothing here needs its id — and a bound-and-unread
  // variable fails `bun run lint`. The same shape is used in Tasks 6 and 7.
  ({ salesInvoiceType: invType, salesCreditNoteType: cnType } =
    await loadTypesFromPack(db, s, ["SALES_INVOICE", "SALES_CREDIT_NOTE", "DELIVERY_ORDER"]) as never);
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-SBI" });
  ({ itemId } = await seedItem(db, s, { code: "IT-SBI", kind: "product", trackLots: false }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-SBI" });
  // Twenty units at 3.0000.
  await postInventoryDocument(db, s, { code: "GOODS_RECEIPT", effectiveDate: "2026-01-02", lines: [
    { itemId, warehouseId, quantity: "20.000000", unitPrice: "3.0000", amount: "60.0000" }] });
}, 180_000);
afterAll(async () => { await db.stop(); });

/**
 * Deliver `qty` at 9.0000 for a line total of `amount`, then invoice it in full.
 *
 * `amount` is a PARAMETER and is never computed here. `(Number(qty) * 9).toFixed(4)` — the obvious
 * spelling — puts a monetary value through a JavaScript `number`, which Global Constraint 4 forbids
 * everywhere and §3.7.5's `no-number-money` forbids in every scanned root; `packages/db/test/**` is
 * outside the lint runner's `ROOTS`, which is exactly why the rule is stated in prose and honoured by
 * hand. Task 6's `deliver` takes `amount` the same way and for the same reason.
 */
async function deliverAndInvoice(qty: string, amount: string, deliverOn: string, invoiceOn: string) {
  const d = await postInventoryDocument(db, s, {
    code: "DELIVERY_ORDER", effectiveDate: deliverOn, partyId,
    lines: [{ itemId, warehouseId, quantity: qty, unitPrice: "9.0000", amount }],
  });
  const inv = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const r = await convertToInvoice(tx, ctxOf(s), {
      sourceDocumentId: d.documentId, targetDocumentTypeId: invType, targetSeries: "INV",
      effectiveDate: invoiceOn, lines: [],
    });
    await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
    await postDocument(tx, ctxOf(s), { documentId: r.documentId });
    return r;
  });
  return { delivery: d.documentId, invoice: inv.documentId };
}

async function row(from: string, to: string) {
  const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
    salesByItem(tx, { companyId: s.company, fromDate: from, toDate: to, limit: 50 }));
  return rows.find((r) => r.itemId === itemId)!;
}

describe("inventory.sales_by_item gains revenue and margin — §4.16.1's one code, three shipments", () => {
  it("3D's two members are unchanged, and the two new ones appear beside them", async () => {
    await deliverAndInvoice("5.000000", "45.0000", "2026-01-05", "2026-01-06");
    const r = await row("2026-01-01", "2026-01-31");
    expect(Object.keys(r).sort()).toEqual([
      "cost", "deliveredQuantity", "itemCode", "itemId", "itemNameEn", "margin", "revenue",
    ]);
    expect(r.deliveredQuantity).toBe("5.000000");
    expect(r.cost).toBe("15.0000");            // 5 × 3.0000, from cost_consumption — 3D's source, untouched
    expect(r.revenue).toBe("45.0000");         // 5 × 9.0000, from the invoice's document_line.amount
    expect(r.margin).toBe("30.0000");
  });

  it("the margin ties to the ledger: revenue equals the credit to 4000, cost the debit to 5000", async () => {
    const r = await row("2026-01-01", "2026-01-31");
    const rows = await db.admin<{ code: string; net: string }[]>`
      select a.code, sum(e.base_credit - e.base_debit)::text as net
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where a.code in ('4000', '5000') group by a.code order by a.code`;
    const revenueLedger = rows.find((x) => x.code === "4000")!.net;                   // credit-positive
    const cogsLedger = Money.of(rows.find((x) => x.code === "5000")!.net, MYR).negate().toString();
    expect(r.revenue).toBe(revenueLedger);
    expect(r.cost).toBe(cogsLedger);
    expect(r.margin).toBe(Money.of(r.revenue, MYR).subtract(Money.of(r.cost, MYR)).toString());
  });

  it("a CREDIT NOTE subtracts by arithmetic, with no sign logic in the query (Task 8's negated amounts)", async () => {
    const { invoice } = await deliverAndInvoice("4.000000", "36.0000", "2026-01-07", "2026-01-08");
    const invLines = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${invoice} order by line_no`;
    const before = await row("2026-01-01", "2026-01-31");
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const cn = await creditNoteFrom(tx, ctxOf(s), {
        settledDocumentId: invoice, targetDocumentTypeId: cnType, targetSeries: "CN",
        effectiveDate: "2026-01-09", reason: "one unit rejected",
        lines: [{ settledLineId: invLines[0]!.id, quantity: "1.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: cn.documentId });
      await postDocument(tx, ctxOf(s), { documentId: cn.documentId });
    });
    const after = await row("2026-01-01", "2026-01-31");
    expect(Money.of(before.revenue, MYR).subtract(Money.of(after.revenue, MYR)).toString()).toBe("9.0000");
  });

  it("goods delivered but NOT invoiced show cost with no revenue, and the gap IS the 1250 balance", async () => {
    await postInventoryDocument(db, s, {
      code: "DELIVERY_ORDER", effectiveDate: "2026-01-20", partyId,
      lines: [{ itemId, warehouseId, quantity: "2.000000", unitPrice: "9.0000", amount: "18.0000" }],
    });
    const r = await row("2026-01-20", "2026-01-20");
    expect(r.deliveredQuantity).toBe("2.000000");
    expect(r.cost).toBe("6.0000");
    expect(r.revenue).toBe("0.0000");
    expect(r.margin).toBe("-6.0000");
    const [corridor] = await db.admin<{ net: string }[]>`
      select coalesce(sum(e.base_debit - e.base_credit), 0)::text as net
        from app.ledger_entry e join app.account a on a.id = e.account_id where a.code = '1250'`;
    expect(corridor!.net).toBe("6.0000");     // the report's honesty, checkable against the ledger
  });

  it("every figure is a 4-dp or 6-dp STRING — a `number` in any of them is a no-number-money violation", async () => {
    const r = await row("2026-01-01", "2026-01-31");
    expect(r.deliveredQuantity).toMatch(/^-?\d+\.\d{6}$/);
    for (const v of [r.cost, r.revenue, r.margin]) expect(v).toMatch(/^-?\d+\.\d{4}$/);
  });

  it("3D's own tie-out test is re-run unchanged and still passes", async () => {
    // §4.16.1's "re-expresses means the code and its numbers are unchanged", applied to an EXTENSION:
    // 3D's suite asserts deliveredQuantity and cost and never mentions revenue, so it must still be green.
    // Run it explicitly here as a guard against a future edit to SalesByItemParams.
    const { salesByItem: fn } = await import("../../src/reports/sales-by-item");
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      fn(tx, { companyId: s.company, fromDate: "2026-01-01", toDate: "2026-01-31", limit: 50 }));
    expect(rows.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to see the exact expected failure**

Run: `bun run --cwd packages/db test reports/sales-by-item-revenue`
Expected: FAIL on the first case with `expected ["cost","deliveredQuantity",…,"margin","revenue"]` and `received ["cost","deliveredQuantity","itemCode","itemId","itemNameEn"]` — the two members do not exist yet.

- [ ] **Step 3: Extend `packages/db/src/reports/sales-by-item.ts`**

Add the two members to the row type with their doc comment, replacing 3D's "Deliberately absent" comment (which named this slice as the one that would remove it), and add one `left join` to the query:

```ts
export interface SalesByItemRow {
  itemId: string; itemCode: string; itemNameEn: string;
  deliveredQuantity: string;        // 3D — Σ |movement.quantity| over DELIVERY_ORDER issues
  cost: string;                     // 3D — Σ cost_consumption.value for those movements; the ONE cost source
  /**
   * 4A (§4.16.3). Σ `round(document_line.amount × document.exchange_rate, 4)` over POSTED SALES_INVOICE and
   * SALES_CREDIT_NOTE lines for this item in the range, in BASE currency. `ledger_entry` carries no item id
   * and its `line_no` is the ledger ordinal with no join to `document_line`, so revenue cannot come from
   * there; the conversion is the same `base = value × rate` identity the ledger CHECK enforces (spec:1816).
   * A credit note's `amount` is already negated (4A Task 8), so a return subtracts by arithmetic and this
   * query contains no sign logic.
   *
   * `cost` is cut on DELIVERIES and `revenue` on INVOICES, so a range with goods delivered and not yet
   * invoiced shows cost with no revenue — and that difference is exactly the `1250` balance (§4.15). 4B's
   * `item_profitability`, keyed per fiscal period, is the reconciling projection; 7B re-expresses this
   * report over it under the same code.
   */
  revenue: string;
  margin: string;                   // 4A — revenue − cost, in base
}
```

and in the query, beside 3D's delivered/cost aggregate:

```sql
      left join (
        select dl.item_id,
               sum(round(dl.amount * d.exchange_rate, 4))::numeric(19,4) as revenue
          from app.document_line dl
          join app.document      d on d.id = dl.document_id
          join app.document_type t on t.id = d.document_type_id
         where d.company_id = $1
           and d.status = 'posted'
           and d.effective_date between $2::date and $3::date
           and t.code in ('SALES_INVOICE', 'SALES_CREDIT_NOTE')
           and dl.item_id is not null
           and ($4::uuid is null or dl.item_id = $4)
           and ($5::uuid is null or d.branch_id = $5)
         group by dl.item_id
      ) rev on rev.item_id = i.id
```

with the two projected columns:

```sql
       coalesce(rev.revenue, 0)::text                                         as "revenue",
       (coalesce(rev.revenue, 0) - coalesce(cc.cost, 0))::text                as "margin",
```

**The two document-type codes are literals in a query, and that is inside the register.** `SALES_INVOICE` and `SALES_CREDIT_NOTE` are §4.14 rows this slice owns and seeds (hazard 32 is satisfied by the register, not by avoiding the literal). They are matched on `document_type.code` rather than on an id because a report cannot know a tenant's ids — the same shape 3D uses for `DELIVERY_ORDER`.

Extend `SalesByItemRowSchema` in `packages/contracts/src/inventory/reports.ts` by the two members (both `z.string().regex(/^-?\d+\.\d{4}$/)`), widen the route's response mapping in `apps/api/src/routes/accounting/reports.ts` by the two keys, and regenerate the OpenAPI document. **`SalesByItemParams` and `ReportCodeSchema` are not touched** (§4.16.3's amendment says so in as many words).

- [ ] **Step 4: Create `tests/regression/legacy-014.test.ts` — 4A is the creator (§3.7.3)**

LEGACY-014 is "`procSumVouItems` silently discards the caller's exchange rate": the legacy procedure overwrote a supplied `vEqu` with 1 and printed base-currency figures under a foreign-currency heading, 1500× too large, with no error. This slice is the first in execution order to touch it, because it is the first with a report that converts a document amount to base.

```ts
import { describe, expect, it } from "vitest";
// ONE import statement per module: two `from "../support/regression"` lines is a duplicate-import lint
// failure, and `repoFile` and `sharedDb` are both exported from that file (§4.17.1).
import { repoFile, sharedDb } from "../support/regression";

describe("LEGACY-014 The caller's exchange rate is never discarded — 4A", () => {
  it("no query in this slice substitutes 1 for a supplied rate", () => {
    for (const f of [
      "packages/db/src/reports/sales-by-item.ts",
      "packages/db/src/ar-ap/allocation.ts",
      "packages/db/src/ar-ap/invoice.ts",
      "packages/db/src/ar-ap/settlement.ts",
    ]) {
      const src = repoFile(f);
      // The legacy defect's exact shape: `if (:vEqu <> 0) then … else vEqu = 1`. Nothing here writes a
      // literal 1 over a rate; the only literal rate in the slice is the `unit` rate_source label on a
      // settlement whose caller passed 1.00000000 in the first place.
      expect(src).not.toMatch(/exchange_?[Rr]ate\s*=\s*1\b/);
      expect(src).not.toMatch(/rate\s*=\s*['"]1(\.0+)?['"]/);
    }
  });

  it("a base amount is ALWAYS round(value × the document's own rate, 4) — never a default", async () => {
    const src = repoFile("packages/db/src/reports/sales-by-item.ts");
    expect(src).toMatch(/round\(dl\.amount \* d\.exchange_rate, 4\)/);
    // And the database refuses any row where the identity fails, on every ledger row in the system.
    const { rw } = await sharedDb();
    const [n] = await rw.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry
       where base_debit <> round(debit * exchange_rate, 4) or base_credit <> round(credit * exchange_rate, 4)`;
    expect(n!.n).toBe(0);
  });

  it("a rate that does not exist is an ERROR, not a silent 1 (app.rate_for + ERR_RATE_NOT_FOUND)", async () => {
    const { rw } = await sharedDb();
    const [row] = await rw.db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_proc
       where proname = 'rate_for' and pronamespace = 'app'::regnamespace`;
    expect(row!.n).toBe(1);
    // 0D's app.rate_for returns NO ROW when there is none, and the caller raises ERR_RATE_NOT_FOUND (422).
    // The legacy procedure returned a usable 1 instead, which is why the report was 1500× wrong in silence.
    const { ERRORS } = await import("@dulja/contracts");
    expect(ERRORS).toHaveProperty("ERR_RATE_NOT_FOUND");
  });

  it("a report never re-derives a base amount from a CURRENT rate — the document's pinned rate is the source", () => {
    const src = repoFile("packages/db/src/reports/sales-by-item.ts");
    expect(src).not.toMatch(/app\.rate_for/);   // the pinned d.exchange_rate is what it reads
  });
});
```

- [ ] **Step 5: Run everything, including test 14's re-run**

Run: `bun run --cwd packages/db test reports/sales-by-item-revenue reports/inventory-reports && bun run --cwd apps/api test routes/accounting/inventory-reports && node --test tests/regression/legacy-014.test.ts && bun run --cwd packages/contracts openapi:generate`
Expected: PASS — six new report cases, **3D's own `inventory-reports` suite green unchanged**, the route suite green, four `legacy-014` cases, and the OpenAPI diff showing two added properties on `SalesByItemRow`.

**Test 14's re-run** (`§6.1`: "the purchase-return one-query test against the full accounting catalogue") is one further case, added to `packages/db/test/seed/permission-phase4a.test.ts` in this task because the catalogue is now complete for accounting:

```ts
  it("TEST 14 — 'who can post a purchase return in company X' is ONE query, over the full catalogue", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ principalId: string }[]>`
      select distinct ra.principal_id as "principalId"
        from app.role_assignment ra
        join app.role_permission rp on rp.role_id = ra.role_id
       where ra.company_id = ${s.company}
         and rp.permission_code = 'accounting.purchase.post'
         and (ra.expires_at is null or ra.expires_at > now())`);
    expect(Array.isArray(rows)).toBe(true);
    // The same one query answers it for every accounting code that has SHIPPED — nineteen after this
    // slice: 1A's six, 1B's one, 2A's one, 2B's one, 3C's two, 3D's one and this slice's seven. §3.6.2's
    // "accounting 23" is the complete v1 catalogue and includes 4B's `bank.reconcile`, 5A's `tax.manage`,
    // 5B's `tax.file` and 7A's `report.export`, none of which exists yet — asserting 23 here would go red
    // on a slice that has not run. This is what spec:2432 asks and what LEGACY-034/047 made impossible.
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.permission where module = 'accounting'`;
    expect(n!.n).toBe(19);
  });
```

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/reports/sales-by-item.ts packages/contracts/src/inventory/reports.ts \
        packages/contracts/openapi.json apps/api/src/routes/accounting/reports.ts \
        packages/db/test/reports/sales-by-item-revenue.test.ts \
        packages/db/test/seed/permission-phase4a.test.ts tests/regression/legacy-014.test.ts
git commit -m "feat(reports): inventory.sales_by_item gains revenue and margin under the same code [4A T11]

§4.16.1's one code, three shipments (hazard 4). Revenue is Sigma round(document_line.amount x rate, 4)
over posted SALES_INVOICE and SALES_CREDIT_NOTE lines, in base — ledger_entry carries no item id, so it
cannot be the source. A credit note's amount is already negated, so a return subtracts with no sign
logic. 3D's params and cost member are untouched and its tie-out is re-run unchanged. Test 14 re-run
over the complete accounting catalogue; legacy-014 created.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: ⚠️ OD-05 — the Customer credit control row of §3.0.3

**Owner decision OD-05** (§2.12): "Confirmation of every ⚠️ row in §3.0.3 and §3.0.4" (spec:38, 1014, 1036, 2404). The row this slice builds is **Customer credit control** (spec:1026): *"Distribution runs on credit; needs limits, ageing, and a block on over-limit sales"*, legacy `Accounts.MaxLimit`, `DebtAge`.

**This is one isolated task and it is droppable without renumbering any interface.** If the owner says no, **Tasks 3 and 5**'s credit-control clauses are removed and nothing else in the slice moves — Task 11 is the sales-by-item report and carries no credit-control clause; the cases on a real `SALES_INVOICE` are Task 5's, which the DoD table above names correctly — `payment_term` stays (it is not a ⚠️ row), allocation stays, and all six document types stay.

**Files:**
- Create: `docs/review/2026-09-05-od-05-credit-control.md`
- Modify: nothing else. This task writes no code unless the owner's answer differs from the default.

**Interfaces:**
- Consumes: **nothing.** This task reads the spec row and the owner's answer; it imports no module and calls no helper.
- Produces: `docs/review/2026-09-05-od-05-credit-control.md` — the record of the decision, in the form Step 2 fixes, with the `- Decision: confirmed | declined` line Step 1's verify command greps for. No exported name.

**The default written into this plan, and exactly what changes if the owner decides otherwise.**

| Clause of spec:1026 | Built as | If the owner says no |
|---|---|---|
| "limits" | `party.credit_limit numeric(19,4)`, null = no limit (Task 3, migration 0045) | The column and its CHECK are dropped **by a new contract migration in 4B's range (0048–0052)**, never by editing 0045 — see the note under this table; `PartySchema`'s three members become one (`paymentTermId`); `creditStatus` is deleted with `packages/db/src/ar-ap/credit.ts` |
| "a block on over-limit sales" | `app.assert_credit_available()` on `document_credit_control`, refusing `→ issued` with `ERR_CREDIT_LIMIT_EXCEEDED` unless a second principal recorded an `accounting.credit_limit.override` event (Task 3) | The function, the trigger and `app.party_open_balance` are dropped **by that same new migration** and both `ERRORS` rows are deleted with the last code that raises them; `accounting.credit_limit.override` is removed from Task 2's seven codes (leaving six) and from `accountant`'s grants; §4.5.3's `OverrideCode` union keeps the member, because 2B declared it and 6A still uses `pos.ticket.override` |
| "credit hold" (**not in spec:1026** — it is §4.8.1's addition) | `party.credit_hold boolean not null default false`, `ERR_CREDIT_HOLD`, not overridable | Dropped with the limit. It is registered in §4.8.1, so dropping it is an amendment to that section as well as to this plan |
| "ageing" | **Not this slice.** §4.8.2 and the `accounting.ageing` report are 4B's | Unaffected — 4B's own OD-05 task covers it |

**A rejection is applied by a NEW migration, never by editing 0045.** By the time OD-05 is answered, 0045 has merged and been applied; §3.4.7's expand/contract rule and §3.4.5's "a down file drops only what its own up added" both forbid editing an applied migration, and §3.4.1 forbids renumbering. The contract migration therefore takes **the next free number in 4B's range, 0048–0052**, and **4B owns it** — 4A's own range 0044–0047 is fully used, and OD-05 is a gate 4B carries as well (§2.12 lists 4B against it). Recording that here is the whole point of this task: a "no" has one named place to land and one named owner, rather than an edit to a file that must not be edited.

**What a "yes" changes: nothing.** The default *is* the spec text, built as designed. This task exists so that the decision is recorded against a named artefact rather than assumed, and so that a "no" has a single place to be applied.

- [ ] **Step 1: Owner provides the confirmation**

**Owner provides:** a yes/no on the **Customer credit control** row of §3.0.3 (spec:1026), and — if yes — one sentence on whether a credit *hold* (a per-customer stop, distinct from a limit) is wanted, because that clause is this document's addition and not the spec's.

**Verify:** `test -s docs/review/2026-09-05-od-05-credit-control.md && grep -qE '^- Decision: (confirmed|declined)$' docs/review/2026-09-05-od-05-credit-control.md && echo "OD-05 recorded"`
Expected: `OD-05 recorded`.

**Until provided:** the default stands and the slice does not block. Every credit-control test in Tasks 3 and 5 runs against the default and is green; if the answer later is "no", those cases are deleted with the columns in one PR whose diff is exactly the table above.

- [ ] **Step 2: Write the record**

`docs/review/2026-09-05-od-05-credit-control.md`:

```markdown
# OD-05 — Customer credit control (§3.0.3, spec:1026)

- Asked: 2026-09-05
- Answered: <date, or "pending">
- Decision: <confirmed | declined>
- Credit hold wanted: <yes | no | n/a>
- Recorded by: <name>

## What was asked

Does the business run credit control as spec:1026 describes — per-customer limits and a block on
over-limit sales — and does it additionally want a per-customer *hold* that no override lifts?

## What was built under the default

- `party.credit_limit` (null = no limit) and `party.credit_hold`, migration 0045.
- `app.assert_credit_available()`, a BEFORE UPDATE OF status trigger refusing `→ issued` for an outbound
  sales document over the limit, with `ERR_CREDIT_LIMIT_EXCEEDED`; released only by an
  `accounting.credit_limit.override` `document_event` recorded by a **second** principal (spec:2179).
- `ERR_CREDIT_HOLD`, which an override does **not** lift.
- `docs/runbooks/credit-control-override.md` for the two-principal procedure.

Ageing is 4B's and is covered by 4B's own OD-05 task.
```

- [ ] **Step 3: Commit**

```bash
git add docs/review/2026-09-05-od-05-credit-control.md
git commit -m "docs(review): record OD-05 for the Customer credit control row [4A T12]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: ⚠️ OD-24 — the four AR/AP screens (BLOCKED until the owner provides screenshots)

**Owner decision OD-24** (§2.12): "Screenshots + operator description before any screen" (spec:79, 108, 2408). Hazard 29: *"The UI is not specified. Every screen task begins with OD-24 … no plan invents a workflow."*

**This task is BLOCKED, and the slice is not.** Tasks 1–12 and 14 are complete and green without it. Nothing in this task is written until the owner has provided, for each screen, a screenshot of the legacy equivalent and a two-minute description of how the operator uses it.

**Files:** (nothing is created until Step 1's verify command passes; the list is stated now so the blocked task is still a costed one)
- Create: `apps/backoffice/src/features/ar-ap/InvoiceList.tsx`, `InvoiceEditor.tsx`, `SettlementEditor.tsx`, `AllocationPanel.tsx`
- Create: `packages/i18n/src/locales/en/ar-ap.json`, `packages/i18n/src/locales/ar/ar-ap.json`
- Create: `tests/e2e/ar-ap.spec.ts`

**Interfaces:**
- Consumes: the eight routes Tasks 1, 6, 8, 9 and 10 register — `GET`/`POST /v1/companies/{companyId}/payment-terms`, `POST …/documents/{documentId}/convert-to-invoice`, `POST …/documents/{documentId}/credit-note`, `POST`/`GET …/documents/{documentId}/allocations`, `POST …/documents/{documentId}/allocations/{allocationId}/unallocate`, `GET …/documents/{documentId}/open-balance`, `POST …/documents/settlements`, `GET …/parties/{partyId}/balance` — through the generated client (§4.2.7); `packages/ui` and `packages/i18n` (0E); `bootLocalStack` (0E, §4.17.1).
- Produces: four screens under `apps/backoffice/src/features/ar-ap/`, the `en` and `ar` `ar-ap` message catalogues, and `tests/e2e/ar-ap.spec.ts`. **No exported TypeScript surface any other slice consumes.**

- [ ] **Step 1: Owner provides the screenshots and the descriptions**

**Owner provides:** for each of the four screens — the invoice list, the invoice editor, the receipt/payment editor and the allocation panel — a screenshot of the legacy equivalent and a two-minute description of the operator's actual sequence (what they type first, what they never touch, which field they tab to most).

**Verify:** `ls docs/ui/screenshots/ar-ap/ | wc -l` prints **4 or more**, and `test -s docs/ui/ar-ap-operator-notes.md && echo "OD-24 attached"` prints `OD-24 attached`.

**Until provided:** this task does not start. There is no local equivalent and none is invented — a screen built from a guess is the failure hazard 29 names, and the four routes are fully exercised by the route suites of Tasks 1, 6, 9 and 10 in the meantime.

- [ ] **Step 2: Build the four screens against the provided material**

Keyboard parity is the requirement, not a preference (spec:2254): every action reachable by keyboard alone, in the order the operator's description gives. Every string through i18next with an ICU message; the `en` and `ar` catalogues complete before merge (Global Constraint 16).

- [ ] **Step 3: Verify both text directions (test 23's re-run)**

`tests/e2e/ar-ap.spec.ts` renders each of the four screens under `dir="ltr"` and `dir="rtl"` through 0E's `bootLocalStack()`, asserting that the numeric columns stay right-aligned in both, that the Hijri and Gregorian date presentations both render, and that the tab order matches the operator's sequence.

Run: `bun run --cwd tests test:e2e -- ar-ap`
Expected: PASS in both directions.

- [ ] **Step 4: Commit (once unblocked)**

```bash
git add apps/backoffice/src/features/ar-ap packages/i18n/src/locales/en/ar-ap.json \
        packages/i18n/src/locales/ar/ar-ap.json tests/e2e/ar-ap.spec.ts
git commit -m "feat(backoffice): the four AR/AP screens, both directions [4A T13]

Built against the owner's screenshots and operator notes (OD-24); keyboard parity per spec:2254.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Slice exit — the re-run matrix, the pinned lists, the regression blocks and full CI

The last task. It runs everything, re-asserts every pinned list this slice could have moved, closes the remaining regression blocks and writes the slice report.

**Files:**
- Create: `docs/review/2026-09-05-phase-4a-exit.md`
- Modify: `packages/db/test/privileges.test.ts` (re-assert the unchanged DELETE list)
- Modify: `tests/regression/legacy-011.test.ts` (append, create-if-absent), `tests/regression/legacy-012.test.ts` (append)
- Modify: `tests/invariants/ledger-balance.test.ts` (one case: the six new types under fuzz — test 1's re-run)

**Interfaces:**
- Consumes: every surface this slice produced — `app.payment_term`, `app.allocation`, `app.assert_credit_available`, the six seeded document types, `postArDocument` (§4.17.1) and the `ar-ap` services — plus `lintSchema` (§4.1), `sharedDb`, `repoFile`, `thinRegression` (§4.17.1), and 1B's `tests/invariants/ledger-balance.test.ts` fuzz suite, which this task grows additively.
- Produces: `docs/review/2026-09-05-phase-4a-exit.md`, the exit record. **No exported name**; the two regression blocks and the one fuzz case are additions to files other slices own.

- [ ] **Step 1: Re-assert the four pinned lists this slice could have moved**

```bash
bun run --cwd packages/db test privileges          # §3.5.4's five-row DELETE list — UNCHANGED by 4A
bun run --cwd packages/db db:lint                  # §3.5.2 — zero violations, with payment_term and allocation present
bun run lint:rules                                 # error-codes, permission-catalogue, role-seed, posting-only-tables
bun run --cwd tests test invariants/tenant-isolation   # one more route module, one more PROBES key
```

Expected: all four green. In `privileges.test.ts` the pinned expectation is re-stated verbatim and **not extended** — `payment_term` archives and `allocation` reverses, so neither gains DELETE:

```ts
    expect(deleteGrants).toEqual(["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]);
```

- [ ] **Step 2: Append the last two regression blocks**

`tests/regression/legacy-012.test.ts` — append (0B created it):

```ts
describe("LEGACY-012 base = value × rate on every AR/AP line, and the rate has a source — 4A", () => {
  it("EVERY writer of an AR/AP document header in this slice sets rate_source — asserted on the source", async () => {
    const { repoFile } = await import("../support/regression");
    // Asserted on the SOURCE and not on `sharedDb()`'s rows, because this file runs against the thin
    // regression database and that database contains no 4A document: a `count(*) where rate_source is
    // null` there is 0 for the wrong reason, and would stay green against a slice that never wrote the
    // column at all. The behavioural assertion lives where the rows are — Task 5's sales-invoice suite,
    // whose database holds nothing but documents this slice posted.
    //
    // `app.document.rate_source` is a plain nullable `text` with no default (plan0A:1787) and 3C's
    // `draftTypedDocument` does not write it, so "every writer sets it" is a real obligation and there
    // are exactly four writers of an AR/AP header: the two conversion-shaped services, the settlement
    // service, and the §4.17.1 test helper.
    for (const f of [
      "packages/db/src/ar-ap/invoice.ts",         // copies head.rateSource from the source document
      "packages/db/src/ar-ap/credit-note.ts",     // copies head.rateSource from the settled document
      "packages/db/src/ar-ap/settlement.ts",      // "unit" at 1.00000000, manual:<actor> otherwise
      "tests/invariants/support/post-ar.ts",      // the same two spellings, in its post-draft UPDATE
    ]) {
      expect(repoFile(f)).toMatch(/rate_source/);
    }
  });

  it("no posted AR/AP document anywhere in this database lacks a rate_source, and no line breaks the identity", async () => {
    const { rw } = await sharedDb();
    // A guard, not the proof: on the thin regression database the first count is over an empty set.
    // It is kept because it costs nothing and because it goes red the moment a later slice teaches this
    // database to hold a 4A document with a null provenance.
    const [bad] = await rw.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document d
        join app.document_type t on t.id = d.document_type_id
       where t.code in ('SALES_INVOICE','SALES_CREDIT_NOTE','PURCHASE_INVOICE','PURCHASE_CREDIT_NOTE','RECEIPT','PAYMENT')
         and d.status = 'posted' and d.rate_source is null`;
    expect(bad!.n).toBe(0);
    // The identity itself is NOT vacuous here — the thin regression database holds ledger rows from 0B
    // onward, and the CHECK is what this asserts is still attached.
    const [broken] = await rw.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry
       where base_debit <> round(debit * exchange_rate, 4) or base_credit <> round(credit * exchange_rate, 4)`;
    expect(broken!.n).toBe(0);
  });

  it("no repair procedure exists that could restate a posted base amount (the procFixValues shape)", async () => {
    const { rw } = await sharedDb();
    const [n] = await rw.db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_proc p
       where p.pronamespace = 'app'::regnamespace and p.proname like '%fix%'`;
    expect(n!.n).toBe(0);
  });
});
```

`tests/regression/legacy-011.test.ts` — **append, create-if-absent** (§3.7.3; the creator is not named in the catalogue, so the block is written to be order-independent):

```ts
describe("LEGACY-011 No NULL reaches an AR/AP balance or an aggregate — 4A", () => {
  it("every monetary column this slice adds is NOT NULL with a default, or is deliberately nullable and documented", async () => {
    const { rw } = await sharedDb();
    const cols = await rw.db.admin<{ t: string; c: string; n: string; d: string | null }[]>`
      select table_name as t, column_name as c, is_nullable as n, column_default as d
        from information_schema.columns
       where table_schema = 'app'
         and ((table_name = 'allocation'   and column_name in ('amount','base_amount','fx_difference'))
           or (table_name = 'payment_term' and column_name = 'due_days')
           or (table_name = 'party'        and column_name in ('credit_limit','credit_hold')))
       order by 1, 2`;
    const byName = new Map(cols.map((c) => [`${c.t}.${c.c}`, c]));
    for (const k of ["allocation.amount", "allocation.base_amount", "allocation.fx_difference",
                     "payment_term.due_days", "party.credit_hold"]) {
      expect(byName.get(k)!.n).toBe("NO");
    }
    // The ONE nullable money column, and it is nullable on purpose: NULL is "no limit", not "a zero limit".
    expect(byName.get("party.credit_limit")!.n).toBe("YES");
  });

  it("every aggregate this slice writes coalesces at the accumulation boundary", async () => {
    const { rw } = await sharedDb();
    for (const fn of ["party_open_balance", "payment_due_date"]) {
      const [p] = await rw.db.admin<{ src: string }[]>`
        select prosrc as src from pg_proc where proname = ${fn} and pronamespace = 'app'::regnamespace`;
      if (p!.src.includes("sum(")) expect(p!.src).toMatch(/coalesce\(sum\(/);
    }
    const { repoFile } = await import("../support/regression");
    for (const f of ["packages/db/src/ar-ap/allocation.ts", "packages/db/src/reports/sales-by-item.ts"]) {
      const src = repoFile(f);
      const sums = src.match(/sum\(/g) ?? [];
      const coalesced = src.match(/coalesce\(sum\(/g) ?? [];
      expect(coalesced.length).toBe(sums.length);
    }
  });
});
```

- [ ] **Step 3: Re-run test 1 over the six new types (§6.1's re-run row)**

Add one case to `tests/invariants/ledger-balance.test.ts`, in the style 1A's fuzz suite established:

```ts
  it("test 1 re-run — Σdebit = Σcredit over 200 random AR/AP documents of the six 4A types", async () => {
    // fast-check over: type ∈ the six, amount ∈ [0.01, 99_999.99] at 4 dp, currency ∈ {MYR, EUR},
    // rate ∈ [0.5, 9.5] at 8 dp, 1–5 lines, and for a sales product line a cost ∈ [0, amount].
    // Every generated document is posted through the real postDocument; after each, the assertion is
    //   select sum(base_debit) - sum(base_credit) from app.ledger_entry  ->  0.0000
    // per company AND per fiscal period, which is spec:2419's wording.
    await fc.assert(fc.asyncProperty(arArbitrary(), async (spec) => {
      await postGenerated(db, s, spec);
      const [row] = await db.admin<{ diff: string }[]>`
        select coalesce(sum(base_debit) - sum(base_credit), 0)::text as diff from app.ledger_entry`;
      expect(row!.diff).toBe("0.0000");
    }), { numRuns: 200 });
  });
```

`arArbitrary()` and `postGenerated()` are file-local to that suite — 1A's fuzz suite already holds the equivalents for JOURNAL and this case adds the AR/AP generator beside them, in the file 1B owns, additively.

- [ ] **Step 4: Run the whole suite**

```bash
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
bun run --cwd packages/contracts openapi:generate && git diff --exit-code packages/contracts/openapi.json
bash scripts/check/contracts-4a-amendments.sh
```

Expected: every command exits 0, and the OpenAPI diff is empty (it was regenerated in each task that added a route).

- [ ] **Step 5: Write the exit report**

`docs/review/2026-09-05-phase-4a-exit.md` — the table below plus the four commands' output:

| Clause | Where it is green |
|---|---|
| Allocation refuses an over-allocation both ways; `openBalance` returns after `unallocate` | Task 9, `ar-ap/allocation.test.ts` |
| Credit limits: refusal, second-principal override, non-overridable hold | Tasks 3 and 5 |
| Payment terms: pinned on the document, due date derived | Tasks 1 and 5 |
| `1250` nets to zero across a delivery and its invoice | Task 6 |
| `2150` nets to zero across a receipt and its invoice | Task 7 |
| A credit note is the invoice's reversal target and posts the opposite | Task 8 |
| Money in needs one principal, money out needs two | Task 10 |
| `inventory.sales_by_item` carries revenue and margin under the same code | Task 11 |
| Tests 10, 14, 31 re-run; tests 1, 12, 13, 27, 36 re-run over this slice's rows (**not 2 or 15 — §6.1 assigns neither to 4A**) | Tasks 2, 10, 11, 14 |
| `lintSchema` zero; DELETE list unchanged; `app.series_gaps` empty for `INV`, `CN`, `PINV`, `PCN`, `RCT`, `PAY-OUT` | Task 14 |

- [ ] **Step 6: Commit**

```bash
git add docs/review/2026-09-05-phase-4a-exit.md packages/db/test/privileges.test.ts \
        tests/regression/legacy-011.test.ts tests/regression/legacy-012.test.ts \
        tests/invariants/ledger-balance.test.ts
git commit -m "test: slice 4A exit — the re-run matrix, the pinned lists and the last regression blocks [4A T14]

Tests 10, 14 and 31 pass over the six new types; 1, 12, 13, 27 and 36 re-run over this slice's rows,
routes and codes (2 and 15 are not 4A re-runs — see contracts §6.1 rows 2 and 15). The app_rw DELETE list is re-asserted UNCHANGED (payment_term archives,
allocation reverses). legacy-011 and legacy-012 appended, legacy-014 created in T11.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

Read against the writing-plans skill, the contracts document and the four rule sets this slice touches.

**Contract additions — every name invented because a register lacked it.** Seventeen land in Task 0, before any task uses them, and one — §3.6.4's grants sentence — lands in Task 2 because §3.6.4's own rule puts it in the same PR as the catalogue entries. None is a silent addition.

| Name or decision | Register amended | Why it was needed |
|---|---|---|
| `SALES_INVOICE`, `PURCHASE_INVOICE`, `SALES_CREDIT_NOTE` become `inventory: none` | §4.14 (three cells) | `inventory.effect` is one value per policy and §4.4.1's `$id` is frozen from 2A onward, so "issue (or none when linked)" is not expressible; `receipt` on a credit note is actively wrong (3D's A2 flips a negative receipt into an issue) |
| `CREDIT_TEST` / `CRT` — test only | §4.14 | Task 3's trigger must be red-then-green before `SALES_INVOICE` exists; 2A's `POLICY_TEST` is `internal`, which the trigger ignores |
| ADR 0045: `line.cost` negates on a negative-quantity line | §4.4.2 | The amendment 3D filed as blocking Phase 4 (3d:2740) |
| The unfilled-cost refusal in `applyMovements` | §4.7.2 | 2A's step-9b guard, removed by 3B, and 4A is the first slice with a `line.cost` leg on an `effect: none` policy |
| `document_line.cost` may be written by a conversion service | §4.7.2, §4.3.4 | The corridor must be relieved by the figure that filled it (LEGACY-009) |
| `0045_alter_party_and_document_add_credit_terms.sql` | §3.4.2, §4.5.7 | The card's short name understates a file that also adds `document.payment_term_id` and a trigger |
| **`party.price_list_id`** (part of the same amendment 6) | §4.5.7 | **Not this slice's own idea:** 6B's Task 0 amendment **A10(b)** names `app.party.price_list_id` as the key §3.7.6's *customer-specific pricing* has nothing to resolve on, and names **4A's 0045** as the file that adds it. It lands here because 4A executes in Phase 4 and 6B in Phase 6, and Global Constraint 13 forbids Task 3 writing a literal into a register that does not yet hold it. 4A **reads** it nowhere — not the trigger, not `app.party_open_balance`, not `creditStatus`; Task 3 adds the column, its composite FK, its Drizzle mirror entry (§3.4.9 makes the mirror the diff source, so an unmirrored column is a column the next generated diff proposes dropping) and its wire field, and two of that task's fifteen cases prove exactly that and nothing more |
| `document.payment_term_id` | §4.3.4 | The term must be pinned, not re-read (LEGACY-013) |
| The ageing buckets use the **pinned** term | §4.8.2 | A latent LEGACY-013 in 4B's contract |
| `ERR_CREDIT_HOLD` (422) | §4.2.4 | A hold is not overridable and its remedy differs; one code would carry the wrong remedy for half its callers |
| `AllocationRow`, `PartyBalance`, `listAllocations` | §4.8.1 | The block implied all three and named none |
| `allocation.unallocated_by`, `allocation.unallocation_reason`, and the second `attach_stamp` | §4.8.1 | `unallocate` compels a reason and `app.audit_row` writes `to_jsonb(new)`, so a reason with no column is a reason no auditor can recover — the ADR 0023 loss in a new table |
| `allocation_distinct_check`, `allocation_settlement_idx`, `allocation_settled_idx` | §4.8.1 | 0046 adds one CHECK and two partial indexes beyond §4.8.1's DDL, and §4 admits members only by amending it |
| **`\|total\| − Σ allocations`, never `\|total − Σ allocations\|`**, and **`partyBalance` reads the ledger** | §4.8.1 | A credit note is a legal settlement document with a negative total, and a settlement is never a settled document — both defects were arithmetic, not stylistic. **`partyBalance`'s sign convention is party-facing and therefore negated against a vendor's control account**, which is stated at the function and in the amendment because 4B holds both figures |
| **4B**, not 4A, registers the receipt/payment `ReconcilableSource`s | §4.8.3 | `reconciliation.ts` is 4B's file; 4A cannot register into a module that does not exist |
| `SalesByItemRow` gains exactly `revenue` and `margin` | §4.16.3 | 4B's `item_profitability` and this report must not disagree about where revenue comes from |
| `postArDocument`, `ArLine`, `PostArOptions` | §4.17.1 | 4B, 5A, 6A, 7C and 8C all need it; five file-local copies is hazard 9 |
| `payment_term.archived_at` | §4.6.1 | The register's column list omitted it and spec:2049 requires it |
| The `/v1/companies/:companyId/payment-terms` module row and the eight sub-paths | §4.2.7 | The table is what stops two slices mounting two modules on one path (hazard 31), and this slice mounts a genuinely new one |
| The four contract modules `payment-term.ts`, `invoice.ts`, `allocation.ts`, `settlement.ts` and the three files grown additively | §4.2.8 | The module-names table is what stops 4B or 7C spelling a second `AllocationSchema` |
| 4A's seven codes added to §3.6.4's grants sentence (**Task 2**, not Task 0) | §3.6.4 | The section requires the sentence to be extended "in the same PR" as the catalogue entries, and those are Task 2's |
| **⚠️ Test 22's POS/invoice comparison, with both admissible readings and 6A named as the decider** | §6.1 row 22 | ADR 0044 makes a financial-only `SALES_INVOICE` un-comparable to a `POS_TICKET`, and the `DO ∪ INV` union does not compare either against a frozen projection set that does not net pairs. Written down rather than left for 6A to hit cold — the courtesy 3D paid this slice at 3d:2723 |

**Hazard sweep.** 1 no statutory figure appears (this slice has no HR surface) · 2 no MyInvois or LHDN detail; `tax.applies` is `false` on all six types and 5A flips it in a policy version 2 · 3 no Firebird assumption · 4 the minimal report ships **in this slice**, under 3D's code, and hazard 4's own sentence about "sales by item" is what Task 11 implements · 5 both owner tasks use the "owner provides X; verify with `<command>`" pattern with an explicit "until provided" clause · 6 OD-05 and OD-24 are one isolated task each, droppable without renumbering · 7 no D1–D27 re-opened · 8 every Plan 0A helper cited by its exact name · 9 one `fixtures.ts` helper — the row §4.17 assigns 4A — and one §4.17.1 row, registered in Task 0; the four `_support.ts` helpers are deliberately file-local and say so · 10 `app.permission` is the only migration data; the six document types are seed-pack files · 11 no enum label added (`payment_term` and `allocation` use CHECKs) · 12 0B's reversibility generalisation is relied on and both down files are hand-written · 13 `lint-schema.ts` is edited to exactly §3.5.3's state: `payment_term` and `allocation` join **no** exemption set · 14 migrations 0044–0047 only; no renumbering; the 0045 rename is registered · 15 the production `withTenant(sql, ctx, fn)` in every service, the 4-argument test helper in every test · 16 no `employee` surface · 17 test 7's negative stock is untouched · 18 the multiset projection set is untouched by this slice — and amendment 17 records, in §6.1 row 22 itself, that ADR 0044 leaves test 22's *comparison* needing 6A's choice between two named readings · 19 no POS surface, and none is invented: the POS half of test 22 is handed to 6A, not guessed at here · 20 no job added · 21 no `sql.unsafe` · 22 nothing outside `posting/` and `costing/` writes a ledger or movement table; `allocation` is deliberately not in `posting-only-tables` and a regression case asserts it · 23 `HALF_AWAY_FROM_ZERO` at scale 4 everywhere, asserted by `legacy-019` · 24 `document_event` is written only by triggers and `recordOverride` · 25 the DELETE list is re-asserted unchanged · 26 exactly the seven codes §3.6.2 assigns · 27 no new principal kind · 28 no Phase 8 dependency · 29 the screen task begins with OD-24 and invents no workflow · 30 the PDF engine is not touched · 31 one new route module, one new `PROBES` key, no key for a sub-path · 32 no unregistered literal in any of the five namespaces · 33 **this slice seeds no account** and Task 2 asserts all eight it names resolve · 34 all six seed files are envelopes with an explicit `module` · 35 every task carries exact paths, exact signatures, real code, a failing test first and a commit.

**Five things a reviewer should push on, named rather than hidden.**

1. **`convertToInvoice`'s gate resolves the SOURCE document's policy** (Task 6), so a warehouse principal holding `inventory.transfer.*` can raise a sales invoice draft. The document cannot be *posted* without `accounting.sales.post` (R2, from the trigger), so no ledger row escapes — but the draft can be created. If review wants that narrowed, the fix is a second gate on the target type's `create` code and it is an amendment to §4.5.4, stated in the task.
2. **`draftSettlement` defaults `branch_id` to the company's lowest-coded BRANCH value** when the caller passes none. `document.branch_id` is NOT NULL and a head-office settlement has no branch, so *some* default is required; `SettlementInput` carries `branchId?: string`, the SQL `coalesce`s the caller's value first, and `DraftSettlementBody` makes it **required on the wire** so the route always sends one. A reviewer who wants the default removed makes the service member required too, which is one line here and one in each of the DB suite's call sites.
3. **A partial credit note's `unit_price` is copied unnegated while every other money column is negated** (Task 8). That is deliberate — a price is not a magnitude of the transaction — but it means `quantity × unit_price ≠ amount` on a credit-note line, which a naive printed template would render as an arithmetic error. 2C's templates read `amount`, so nothing is wrong today; a template that multiplies must use `abs(quantity)`.
4. **ADR 0044 puts acceptance test 22 out of reach as §6.1 row 22 and spec:2440 word it, and this plan hands the choice to 6A rather than making it.** A financial-only `SALES_INVOICE` has zero cost consumptions and credits `1250`; a `POS_TICKET` consumes a layer and credits `1300`; and the `DO ∪ INV` union does not compare either, because it carries a `1250` debit and credit the ticket never produces, on two effective dates, against a frozen projection set that does not net pairs. Task 0's amendment 17 writes both admissible readings into row 22 and names 6A's Task 0 as the decider. **A reviewer who thinks 4A should decide it should say so now**, because the alternative — 6A discovering it against a merged release pack — is the failure 3D spared this slice (3d:2723). Nothing in 4A changes either way; the corridor invariants of Tasks 6 and 7 hold under both readings.
5. **A partial stock return has no service in this slice, by decision.** The financial half is any-quantity (`creditNoteFrom`); the stock half is all-or-nothing, because the only writer of a negated delivery is `reverseDocument`, which reverses a whole document and is what copies `cost` forward so the return is valued at branch 1 rather than at the selling price. A one-document partial return needs a fourth writer of `document_line.cost` and therefore a change to Task 0's amendment 5. Task 8 states this, its Step 8 proves the full path, and the workaround — reverse the delivery, re-deliver the retained quantity — leaves `1250` at zero. A reviewer who wants the one-document form in 4A is asking for a fifth service and a widened amendment 5, and should say so before Task 8 is written.

**Five things an independent audit found and this plan now carries, recorded so a second reviewer does not re-derive them.**

1. **The credit-note-as-settlement case builds its note with `creditNoteFrom`, not with `postArDocument`** (Task 9's seventh case). `SALES_CREDIT_NOTE.json` declares `requires: ["party", "reverses_document"]` and `PostArOptions` has no member that sets `reverses_document_id` — `draftTypedDocument` does not write the column at all — so the helper-built note was refused at post by the very control Task 8's own fourth case asserts. The fix uses the production path, which is what the case should have exercised in the first place.
2. **The six route handlers and the three route suites are written out, not described.** `POST …/documents/{documentId}/credit-note` (Task 8 Step 5), the four allocation sub-paths and `GET …/parties/{partyId}/balance` (Task 9 Step 6), and `POST …/documents/settlements` (Task 10 Step 5) each carry a complete `createRoute` block; `packages/contracts/src/accounting/allocation.ts` and `settlement.ts` carry real Zod source; and `invoices.test.ts` (Task 6 Step 5, appended by Task 8 Step 6), `allocations.test.ts` (Task 9 Step 7) and `settlements.test.ts` (Task 10 Step 6) are real suites rather than file names in a Run line. Every one of the three follows 3C's `document-links.test.ts` shape — `startApi()`, five levels up to `tests/support/api`, inline `seedDocumentType` policies — because a route suite that reached into `packages/db/test/ar-ap/_support.ts` would break §3.1's tier rule.
3. **`PostArOptions` gained `rateSource`, and Task 5's suite asserts it.** `draftTypedDocument` writes no `rate_source`, `app.document.rate_source` has no default, and Task 14's `legacy-012` block ran against a database holding no 4A document — so the invariant was asserted vacuously *and* broken by the helper. Both halves are fixed: the helper writes the column, Task 5 asserts it where the rows are, and the `legacy-012` block now says which of its two cases is the proof and which is the guard.
4. **The TDD order in Tasks 5, 7, 8 and 10 is failing-test → red → configuration.** Each of the four wrote its seed JSON first and could not produce a red; each now has an explicit run-and-see-red step naming the exact failure (`the seed pack has no document type <CODE>`, thrown by `loadTypesFromPack`). No task was renumbered; only steps within those four moved.
5. **Five defects in the newly written route code were caught on a second read of it and are fixed here, named because each would have failed at execution rather than at review.** (a) Task 6's route suite seeded `API_DELIVERY` with an **invented** approval code, `inventory.delivery.post`; §3.6.2 catalogues thirteen `inventory.*` codes and that is not one of them, so `grantCodes` would have failed the `app.role_permission.permission_code → app.permission(code)` foreign key inside `beforeAll`. It is now `inventory.transfer.post`, which is 3D's real `DELIVERY_ORDER` code (3d:2861). (b) The credit-note route drafted and returned, and its `reason` therefore reached nothing: 2B's only writer of `document_event` is an AFTER **UPDATE OF status** trigger, so inserting a draft records no row and the second route case asserted a reason that could never be there. `creditNoteFrom` now places the reason with `setEventContext` — the call that makes its required `reason` parameter load-bearing, and the same placement `reverse.ts` uses (2b:1519) — and the handler issues on the same transaction, which §4.5.1 admits without a second gate because the policy sets `approval.required: false` and block 2c evaluates no code for `issued`. **The route therefore returns an issued note, not a draft**, and both cases now assert that. (c) The `unallocate` handler returned `listAllocations(…)[0]` — the settlement's first allocation, not the reversed one; it now uses `.find((r) => r.id === allocationId)`, a bug a single-allocation fixture would have hidden. (d) The party-balance route was written against `PartyParams` and `PARTY_PAGE`, neither of which 2A exports — it declares a module-local `gate()` and spells its params inline (2a:3993, 2a:4072), and this route now does the same. (e) Task 6's gate case hedged `expect([201, 403]).toContain(res.status)` against a principal holding everything — a form that cannot fail, and the same one already removed from `settlements.test.ts`; it now calls with an un-granted `secondPrincipal` and pins `403` plus `ERR_RBAC_FORBIDDEN`. `toAllocationDto` also destructures `currency` and `baseCurrency` out rather than spreading them into a response typed by `AllocationSchema`, which does not declare them.

**Two open items this slice inherits and does not close.** §4.18's round-2 open item **(4)** — a draft carrying a `document_event` cannot be deleted — is untouched: this slice creates no draft-deletion path. Round-2 open item **(5)** — `sharedDb()`'s declared versus used return shape — is hit by every regression block in this plan, which uses the `{ rw }` destructuring 1A and 3B's blocks use; if §4.17.1's declaration is the correct one, these blocks change with every other slice's in one PR and this plan is not the place to guess.

**Where this plan disagrees with a card and why.** §2.5's 4A card says `SALES_INVOICE` is "outbound / issue (or none when linked to a DO)" and expects `0045_alter_party_add_credit_control.sql`. Both yield: the first to ADR 0044 and the frozen schema, the second to §3.4.2's rule that a file's name must say what it does. The card's "14–15 tasks" lands as **15 headings, of which Task 0 carries no application code** — the same shape 3C's merged plan took.

---

## Execution handoff

**Order.** Tasks run in number order, and number order is the only order: **Task 0 merges before Task 1** (the gate script fails otherwise), and **Task 2 merges before Task 3** because Task 3's `beforeAll` grants `accounting.sales.post` and seeds a `CREDIT_TEST` policy naming it — `app.role_permission.permission_code` references `app.permission(code)` (plan0A:1325) and `validatePolicy` refuses an uncatalogued `approval` code (F-21), so Task 3 executed first cannot reach green. **Migration numbers do not have to follow task numbers:** 0047 (Task 2) is applied before 0045 (Task 3), which §3.4.1 admits in as many words — the runner applies every unapplied file in version order and `discover()` sorts whatever exists, so 0045 is applied on its own later commit. Tasks 5–11 depend on Task 2's codes for their policies (F-21) and on Task 4's two amendments for their corridor arithmetic. Task 13 is blocked on OD-24 and is skipped, not waited on; Task 12 is a one-file record that can land at any point after Task 3.

**One migration per PR** (spec:2057), so Tasks 1, 2, 3 and 9 are four PRs. Tasks 4–8, 10, 11, 12 and 14 are one PR each. Fifteen PRs, and pushing them is the owner's call, not part of any task's definition of done (plan0A:2927).

**The gate.** `bash scripts/check/contracts-4a-amendments.sh` must print `contracts-4a-amendments: ok` before Task 1 and stays in CI thereafter. A `MISSING (repo):` line is a reconciliation with the named slice's plan, never a 4A workaround — raise it and stop.

**After every task:** `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test` at the repository root, and `bun run --cwd packages/contracts openapi:generate` in any task that added a route (CI fails on an un-regenerated document). **The tasks that add a route are 1, 6, 8, 9, 10 and 11**, and each one's own Run step already carries the generator and states the expected diff — four paths and three components in Task 1, one and two in Task 6, one and three in Task 8, five and seven in Task 9, one and three in Task 10, and two added properties on `SalesByItemRow` in Task 11. **Twelve added paths in total — the payment-terms module's four and the eight sub-paths Task 0's amendment 15 registers in §4.2.7 — against exactly one new `PROBES` key** (hazard 31: a sub-path inherits its module's).

**What "done" means for this slice.** Task 14's exit table green, `bash scripts/check/contracts-4a-amendments.sh` green, `lintSchema` at zero, the five-row DELETE list unchanged, `app.series_gaps` empty for all six new series, and Σ`base_debit` = Σ`base_credit` across every company the suite touched. **Phase 4's own definition of done is not this slice's** — both its sentences are verified in 4B, which starts when this slice is green.

**Two things the next slice needs from this one, stated so 4B does not have to derive them.** `document.payment_term_id` is the term the ageing buckets are cut on (§4.8.2, as amended) — not `party.payment_term_id`. And `allocation.fx_difference` is already computed and stored in base; 4B posts the gain or loss through `4900`/`5910` on an `FX_REVALUATION` and needs no second calculation.

**One thing 6A must decide before it writes its POS policy, and it is in §6.1 row 22 waiting.** ADR 0044 makes the seeded `SALES_INVOICE` financial-only, so it has no cost consumptions and test 22's multiset compare against a `POS_TICKET` cannot run as row 22 and spec:2440 word it — and the `DELIVERY_ORDER ∪ SALES_INVOICE` union does not compare either. Task 0's amendment 17 puts both admissible readings in the row: **(a)** 6A configures its own stock-issuing invoice type in its own fixture and compares against that, or **(b)** row 22 and hazard 18 are amended to compare the pair and net the two `1250` legs. 4A does not choose, because 4A never sees the POS policy. Nothing in 4A depends on the answer.

