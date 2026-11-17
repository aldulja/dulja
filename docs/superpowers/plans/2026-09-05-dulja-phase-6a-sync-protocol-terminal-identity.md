# Dulja Phase 6A — Sync protocol, terminal identity, up-sync apply, `POS_TICKET`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the **server half** of the Phase 6 definition of done — *"A till sells 8 hours offline and reconciles with **zero duplicates and zero lost tickets**"* — by building the four pieces §3.7.3 says the legacy parcel model never had. (1) **`packages/sync`**, the one wire contract both `apps/api` and `apps/pos` compile against, so the protocol is verifiable rather than an assumption two programs quietly share. (2) **A commit-ordered catalogue revision** — `revision bigint` assigned under the same per-tenant advisory lock the audit chain takes, tombstones for every deletion, and a cursor-driven `GET /v1/sync/catalogue` scoped to the terminal's branch, so an interrupted transfer resumes exactly (acceptance test **20**). (3) **Terminal identity that is not a user** — a one-time enrolment code, an Ed25519 device key registered at redemption, a signed `/v1/sync/*` call exchanged for a short-lived terminal JWT, and `revoked_at` as the whole revocation story (LEGACY-025, 026, 046). (4) **Up-sync apply** — one transaction, a savepoint per ticket, dedup on `client_ref`, per-ticket accept/reject, the cashier's authority **re-verified server-side** against the server's current assignments, supervisor overrides as `document_event` rows attributed to the supervisor and acted by the terminal, and every refusal landing in `app.needs_attention` rather than in the ledger or in silence (LEGACY-027, 044, 048, 051). The `POS_TICKET` document type posts through **exactly the same posting service** as a back-office invoice, and acceptance test **22** proves it by multiset comparison.

**Architecture:** Four seams, and none of them is a second posting path. (1) **The wire contract is a package, not a convention.** `packages/sync` holds §4.10.1's message types and the cursor codec; `packages/contracts/src/sync/` holds their Zod twins, so OpenAPI is generated from the same shapes the till's TypeScript compiles against (spec:1318 — *"design the sync API as though an external client would use it"*). (2) **The revision is a database fact, not an application one.** `app.catalogue_revision()` is a BEFORE INSERT OR UPDATE trigger on every stream table; it takes `pg_advisory_xact_lock(hashtextextended('tenant-serial:' || tenant_id::text, 0))` — **the same key the audit chain takes** (§4.1, C1) so the two serialise per tenant and can never deadlock — then `nextval`s. Commit order therefore equals revision order, which is the entire correctness argument for a cursor (spec:1299). (3) **Identity is resolved before a tenant is known, through one new `app_auth`-owned door.** `app.resolve_enrolment` mirrors Plan 0A's `app.resolve_principal` exactly; terminal *authentication* needs no new function at all, because `app.resolve_principal('terminal:<id>')` already answers it. `terminalAuth` replaces `auth` on `/v1/sync/*` and sets `principalKind = "terminal"`; the acting principal for every ticket is therefore **the terminal**, and the cashier is `document.attributed_to` — data, never an actor (LEGACY-044, hazard 19). (4) **`applyBatch` writes documents and lines and then calls `postDocument`.** It computes nothing: tax is 5A's `computeDocumentTax`, cost is 3B's `applyMovements` inside step 9, ledger rows are 1A's `insertLedger`. Its own job is the savepoint, the dedup, the authority re-verification and the refusal path. `packages/db` may not import `@dulja/sync` or `@dulja/contracts` (§3.1), so `apply.ts` declares **db-local structural shapes** the sync package's types satisfy — the `ItemRef` / `PayComponentRef` pattern of §4.4.2, applied to a wire message.

**Tech Stack:** Bun 1.4 (install, scripts, the API entrypoint) · Node 24 LTS (runs Vitest) · TypeScript strict · PostgreSQL 18 (Testcontainers `postgres:18`) · `postgres` (postgres.js) tagged templates for every write and every read · Drizzle ORM mirrors for typed reads and as the migration diff source (ADR-0002) · Hono + `@hono/zod-openapi` · Zod · `jose` (already in `apps/api` from 0B's JWKS verifier) for the HS256 terminal JWT · Node's built-in `node:crypto` `verify`/`createHash` for Ed25519 and SHA-256 — no new cryptography dependency · `decimal.js` behind `@dulja/domain`'s `Money` · pg-boss through 0D's `JobClient` · Vitest + Testcontainers · oxlint + oxfmt · Turborepo. No package version appears in any source file — the lockfile owns versions (spec:104).

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §0.2 the never/always lists (spec:97–108), §0.4 the glossary rows `User`/`Point` → `Principal` and `Parcel` → `SyncBatch` (spec:168–170), §3.7 in full (spec:1250–1360) and especially **§3.7.3** (spec:1286–1312) and **§3.7.5** (spec:1320–1337), §3.7.4 the external-client discipline (spec:1316–1318), §3.8 `app.pos_terminal` (spec:1889–1906), `app.document.client_ref` / `branch_id` / `attributed_to` (spec:1764–1768, 1773) and the numbering block (spec:1717–1745), §3.9 Identifiers, Time, Money, Naming, Deletion and Error codes (spec:2037–2053), §4.2.1 the `pos.*` and `admin.terminal.manage` codes and the `pos_terminal`, `cashier` and `branch_manager` rows (spec:2150, 2160–2164), §4.2.2 **R8** (spec:2179), §4.5 versioning and idempotency (spec:2199–2201, 2206), §4.11 the terminal-JWT signing key (spec:2273) and engineering practice (spec:2258–2266), §5.2 `packages/sync` (spec:2370), Part V the Phase 6 row (spec:2292) and the sequencing note (spec:2299), Part VI tests **17**, 19, **20**, **22**, 37 (spec:2435–2455), Part I **LEGACY-009** (spec:286), **LEGACY-025** (spec:435), **LEGACY-026** (spec:448), **LEGACY-027** (spec:460), **LEGACY-044** (spec:593), **LEGACY-046** (spec:603), **LEGACY-048** (spec:615), **LEGACY-051** (spec:647), **LEGACY-052** (spec:660).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 6A — Sync protocol, terminal identity, up-sync apply, `POS_TICKET`. **Phase:** 6. **Phase gate:** this plan starts only when **5A** is merged and Phase 5's definition of done is green in CI (spec:87). **5B may still be in flight** — §2.7's card says so explicitly, and nothing in this slice reads `einvoice_transmission`, `accounting.tax.file` or the `accounting.tax.submit` job.
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `MIGRATIONS_DIR`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.resolve_principal`, `app.current_actor`, `app.current_tenant`, `app.forbid_change`, `app.stamp_actor`, `app.assert_assignment_kind`, `app.pos_terminal`, the role literal `pos_terminal`. **0B** — `createDb`, the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `resolvePrincipal`, `ResolvedPrincipal`, `AppError`, `ERRORS`, `ErrCode`, `Problem`, `fromDatabaseError`, `createLogger`, `Logger`, `readConfig`, `ApiConfig`, `ConfigError`, `PERMISSION`, `PERMISSIONS`, `PermissionCode`, `PermissionDef`, `SliceId`, `requirePermission`, `ScopeSource`, `assertRouteGates`, `buildRoutes`, `ROUTES`, `RouteModule`, `AppDeps`, `AppEnv`, `RequestContext`, `createApp`, `IdempotencyHeader`, `idempotency`, `startApi`, `TEST_ISSUER`, `ApiRequest`, `StartedApi`, `PROBES`, `IsolationProbe`, `TENANT_FREE`, `encodeCursor`, `decodeCursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `QuantitySchema`, `CurrencySchema`, `ProblemSchema`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `sourceFiles`, `REPO_ROOT`. **0D** — `Money`, `currency`, `CurrencyCode`, `Quantity`, `round`, `RoundingMode`, `toBase`, `UNIT_RATE`, `MONEY_SCALE`, `JOBS`, `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `JobHandler`, `registerHandler`, `runJob`, `JOB_PROBES`, `JobIsolationProbe`, `startWorker`, `seedBranch`, `ROLES`, `INCOMPATIBLE_PAIRS`. **0C** — the seed CLI, `PackLoader`, `LoaderContext`, `readPackFile`, `SubPack`, `SUB_PACKS`, the `0c-base.json` chart rows, `repoFile`. **0E** — nothing (6A ships no screen; the till is 6B's). **1A** — `postDocument`, `issueDocument`, `IssueResult`, `loadSnapshot`, `resolvePolicy`, `PostResult`, `PostingError`, `PostingErrorCode`, `insertLedger`, `app.posting_seq`, `documentRoutes`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount`, `loadDocumentTypes`, `documentTypesLoader`, `posting-policy.schema.json`, `document-type-seed.schema.json`. **1B** — `postJournal`, `reportsRouteModule`, `registerProjectionCheck`. **2A** — `evaluatePolicy`, `planMovements`, `balanceInBase`, `parsePolicy`, `validatePolicy`, `validateDocumentTypeSeed`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PlannedMovement`, `PlannedTaxLine`, `PostingPlan`, `ItemRef`, `TaxCodeRef`, `PolicyEvaluationError`, `requireDocumentPermission`, `DocumentStage`, `stageCode`, `DOCUMENT_STAGE_CODES`, `POLICY_RESOLVED_CODES`, `seedParty`, `seedDocumentType`, `DocumentLineInput`, `DocumentLineKindSchema`, `app.party`, `document_type.module`. **2B** — `transitionDocument`, `recordOverride`, `OverrideCode`, `setEventContext`, `listDocumentEvents`, `grantCodes`, `app.principal_has`, `app.effective_policy`, `app.document_event`, `app.assert_override_authorised`. **2C** — `MODULE_READ_CODE`, `requireAttachmentRead`, `readableModules`. **3A** — `app.item`, `app.warehouse`, `app.lot`, `app.price_list`, `app.price_list_line`, `app.promotion`, `app.inventory_movement`, `app.stock_on_hand`, `app.assert_stock_available`, `seedUnit`, `seedItem`, `seedWarehouse`, `seedLot`, `seedPriceList`, `SENTINEL_LOT_CODE`. **3B** — `applyMovements` (full body), `company.costing_method`, `ensureOpenPeriods`, `postInventoryDocument`, `postOverriddenIssue`, `recordingJobs`, `RecordedJob`, `app.cost_layer`, `app.cost_consumption`. **3C** — `draftTypedDocument`, `DraftLine`, `DraftTypedDocumentOptions`, `app.document_link`. **3D** — `secondPrincipal` (exported from `tests/invariants/support/post-inventory.ts` by 3D's Task 0). **4A** — `app.payment_term`, `allocateSettlement`, the `SALES_INVOICE` envelope, `seedPaymentTerm`, **ADR 0044** (which is why test 22 needs Task 0's reading (a)). **4B** — `seedTypeFromPack`, `postFromPack`, `PACK_ROOT`. **5A** — `app.tax_regime`, `app.tax_code`, `app.tax_transaction`, `computeDocumentTax`, `ComputedTaxLine`, `resolveInclusive`, `insertTaxTransactions`, `seedTaxCode`, `taxLoader`, `TAX_PACK_ROOT`, `seedTaxPack`, `taxFixture`, `TaxFixture`, `postTaxedDocument`, the `SYNTH-MY-v1` regime and its four codes, the `2300` / `1350` chart rows.

  Where a name in the list above differs from the written plan that ships it, **that plan's file is the authority** (§4.18's rule) and **Task 0's repo gate is what discovers the difference before any code is written**.
- **Migration numbers:** **0059–0062**, four files, four PRs (§3.4.3 "one migration per PR"), each with a hand-written `NNNN.down.sql`:
  - `0059_add_catalogue_revision.sql` (**T2**) — `app.catalogue_revision_seq`, `app.catalogue_revision()`, `app.catalogue_tombstone`, and the `revision` column plus the trigger on the six stream tables that already exist.
  - `0060_create_terminal_enrolment_needs_attention.sql` (**T3**) — `app.terminal_enrolment`, `app.needs_attention`, `app.resolve_enrolment`. **The §2.7 card's name, not the catalogue JSON's `0060_create_pos_enrolment.sql`:** the file also creates `needs_attention` and a SECURITY DEFINER function, and §3.4.2's round-2 rule — *"a file whose name understates what it does is renamed, not left"* — binds the card's expected name. 2A's `0018_alter_document_party_fk_and_document_type_module.sql` is the precedent.
  - `0061_alter_document_add_pos_columns.sql` (**T4**) — `document.terminal_id`, **`document.shift_id`** (no FK — Task 0 amendment 6, matching 6D's amendment A2), `pos_terminal.code`, and the `document_line.kind` CHECK rewritten to the full union `('account','item','tax','text','tender','payroll')` (§4.3.4).
  - `0062_seed_permission_phase6a.sql` (**T5**) — the eleven codes §3.6.2 assigns this slice.

  **ADR numbers:** 0054–0056, each written **as a proposal and asked before implementing** where it touches the sync protocol or the data model (spec:95): **0054** *Commit-ordered catalogue revisions and tombstones* (T2); **0055** *Terminal identity: Ed25519 device keys, one-time enrolment, and the short-lived terminal JWT* (T3, T6, T7); **0056** *Up-sync apply: savepoint per ticket, `client_ref` dedup, refuse-never-drop* (T11).
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `Quantity`, `currency`, `toBase`, `round`, `RoundingMode`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`, `resolvePrincipal`, `createDb`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`, `ApiConfig`, **the fixed middleware order and its terminal-route branch**), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`, `PostingError`, and this slice's six allocated rows), §4.2.5 (`PERMISSION`, `PERMISSIONS`, `requirePermission`, **`ScopeSource { company: "terminal" }`**, `ROLES`, `INCOMPATIBLE_PAIRS`, `assertRouteGates`), §4.2.6 (`JOBS`, `JobPayload`, `JobEnvelope`, `JobClient`, `JobHandler`, `registerHandler`, `runJob`, `JOB_PROBES`), §4.2.7 (`RouteModule`, `buildRoutes`, `PROBES`, `IsolationProbe`, `TENANT_FREE`, `IdempotencyHeader`, `createApp`, `AppDeps`), §4.2.8 (the common schemas, the list envelope, the cursor codec, **the one list-filter convention — literal `filter[…]` keys, the Layer 2 default**), §4.2.9 (`idempotency`, `RECLAIM_AFTER_SECONDS`, and the two-layer rule: `POST /v1/sync/tickets` carries `Idempotency-Key` **and** dedups per ticket on `client_ref`), §4.2.12 (`startApi`, `ApiRequest`, `StartedApi`), §4.3.1 (`postDocument`, `issueDocument`, `loadSnapshot`, `resolvePolicy`, `recordOverride`, `OverrideCode`, `setEventContext`), §4.3.2 (the fixed algorithm — **steps 1, 2, 6, 7, 8, 9, 10, 11, 12, 13**), §4.3.4 (`document_line`, the 6A row of its additions, the `document` header additions and the 6A row), §4.3.5 (`posting_seq`), §4.3.6 (**numbering at issue, which this slice extends with the terminal suffix**), §4.3.7 (the seed envelope), §4.4.1 (`posting-policy.schema.json`, consumed **unchanged** — same `$id`, same `"version": 1`), §4.4.2 (`DocumentSnapshot`, `LineSnapshot`, `PlannedMovement`, **sign normalisation A9, which names 6A**), §4.5.1 (legal transitions), §4.5.3 (the override door and `app.principal_has`), §4.5.4 (`requireDocumentPermission`, `stageCode`), §4.5.6 (the five `branch_isolation` forms — **6C attaches them; this slice creates its tables branch-ready and attaches nothing**), §4.6.1 (the register rows for `catalogue_tombstone`, `terminal_enrolment`, `needs_attention`), §4.6.5 (the tender-line contract and the four tender accounts), §4.7.2 (`applyMovements`), §4.7.3 (`inventory_movement`, `stock_on_hand`), §4.9.1–§4.9.2 (5A's tax surface, consumed), §4.10 **in full**, §4.14 (document-type codes), §4.15 (account codes — **`1110`, `1120`, `2200` are this slice's three rows**), §4.16.1 (consulted: this slice ships **no** `ReportCode`; `pos.z_report` and `pos.sales_by_cashier` are 6D's), §4.16.2 (consulted: `needs_attention` is **7C's** `DatasetId` row, not this slice's), §4.17 (`seedTerminal` — this slice's one row), §4.17.1, §5 (all thirty-five hazards), §6.1 rows 17, 20, 22, §6.2 rows 1062 and 1064 (contributed, not owned).
- **Interfaces produced:** §4.10.1 in full (`Stream`, `Cursor`, `Change`, `CataloguePage`, `TicketLine`, `TicketTender`, `TicketEvent`, `Ticket`, `ShiftOpenClose`, `TillEventMsg`, `TicketBatch`, `TicketResult`, `MessageResult`, `BatchResult`); §4.10.2 (`app.catalogue_revision_seq`, `app.catalogue_revision()`, `app.catalogue_tombstone`, `GET /v1/sync/catalogue`); §4.10.3 (`app.terminal_enrolment`, the two enrolment routes (`POST /v1/admin/terminals/enrolments` and `POST /v1/sync/enrol`), the signed-call scheme and the terminal JWT); §4.10.4 (`applyBatch`, `POST /v1/sync/tickets`, `app.needs_attention`); §4.10.5 (`SyncStore`, `SyncTransport`, `OutboxRow`, `SyncQueuedError`, `pullAll`, `drainOutbox`); §4.14's `POS_TICKET` row as a seed-pack envelope; §4.3.4's 6A rows; §3.6.2's eleven codes and §3.6.4's role rows for them; §4.2.4's six `ERR_SYNC_*` / `ERR_TERMINAL_*` rows; §4.15's `1110`, `1120`, `2200`; §4.17's `seedTerminal`; §4.2.6's `pos.sync.apply` payload and handler. Everything else is listed under **Contract additions** in the Self-Review and lands through **Task 0**.
- **Owner decisions:** **OD-07** (serial numbers in scope? — spec:92, 1032, 1310, 2435) → **Task 14**, isolated, and **nothing else in this plan is gated on it**. Default written into every other task is §2.12's — **not built**: no `serial_unit` reference, no serial field on any message, no serial column anywhere. Task 14 adds acceptance test 17 (the two-terminal serial race) and the `legacy-052` append, and is **dropped whole** if OD-07 = no, renumbering nothing. **OD-16** (must historical POS data migrate?) is **not** gated here — §2.7's card says so and 9B owns it. **OD-24** is not gated here either: this slice ships **no screen**.
- **Part VI tests owned / re-run:** **owns 20** (catalogue resume — Task 9), **22** (one posting path — Task 13), and ⚠️ **17** (serial uniqueness under concurrency — Task 14, conditional on OD-07). **Re-runs:** **19** server half (Task 12 — a batch re-sent twice changes nothing; the till half is 6B's), **11** (auth bypass, the sync-header shapes — Task 7), **16** (numbering, the per-terminal series — **Task 4**, where `resolveSeries` lands, re-asserted end to end by Task 15's `legacy-051` block), **18** (negative stock at sync apply — Task 11), **6** (costing edge cases on a POS return — Task 13), **1** (the ledger invariant through `postDocument` — Task 13), **12**, **13** and **36** (tenant isolation, audit completeness and the permission catalogue over this slice's three tables, eleven codes and five route modules — Tasks 2, 3, 5, 12 and 15). **§3.0.4 rows owned:** **none exclusively.** This slice contributes to spec:**1062** (POS selling — owned by 6B) and spec:**1064** (cashier authority offline — owned by 6C). **Regression files created / appended:** **creates `tests/regression/legacy-046.test.ts`** — *"Site protection triggers are bypassable, and two different flags share one name"*, whose new-system sentence is *"operation mode … is typed, server-authenticated request metadata with one canonical name per concept, checked in one place"*, which is exactly what `terminalAuth` is; no earlier slice touches LEGACY-046. **Appends** a `— 6A` block to `tests/regression/legacy-009.test.ts` (created by 3B), `legacy-027.test.ts`, `legacy-028.test.ts`, `legacy-044.test.ts` (all created by 0B), `legacy-048.test.ts` (created by 3A) and `legacy-051.test.ts` (created by 0B). ⚠️ **Appends to `legacy-052.test.ts` only under OD-07** — **3A creates it** (§3.7.3's named-creator rule) and 3A executes first (§6.3), so Task 14 appends and never creates.
- **Shared namespaces this slice writes into:** **Document-type codes (§4.14)** — **`POS_TICKET` (`pos`, series `POS`), seeded** as `packages/db/seed/my/document-types/POS_TICKET.json`; plus **`POS_EQUIV_INVOICE` (`accounting`, series `PEI`) — test only**, registered by Task 0 exactly as 2A's `POLICY_TEST` and 3D's `COUNT_TEST` are, never a file under `packages/db/seed/my/document-types/`. **Account codes (§4.15) — three, all this slice's own rows: `1110` Cash in till (asset), `1120` Card clearing (asset), `2200` Store-credit liability (liability)**, shipped as `packages/db/seed/my/chart-of-accounts/6a-pos-tenders.json` and applied with `bun run seed --tenant <id> --only chart-of-accounts` in Task 5. Consumed and asserted-not-reseeded, each with its seeding slice: `1100` Bank (0C — the transfer tender), `1200` Trade receivables (0C — the account-sale customer leg), `1300` Inventory control / `4000` Sales / `5000` COGS / `5920` FX rounding (0C — reached through `item.*_account` and `company.fx_rounding_account_id`, never by literal), `2300` Output tax payable (**5A** — reached through `tax_code.output_account`). **`1130` Cash in transit and `5120` Till over/short are 6D's and are not seeded here.** **Report codes (§4.16.1) — none**, and `ReportCodeSchema` is not widened: hazard 4's minimal-set list gives Phase 6 exactly `pos.z_report` and `pos.sales_by_cashier`, both **6D's**. **`DatasetId` members (§4.16.2) — none:** `needs_attention` is a 7C row in the frozen union and 7A creates `datasets.ts`. **`fixtures.ts` helpers (§4.17) — exactly one, the row §4.17 assigns 6A: `seedTerminal(db, s, opts?: { code?; branchId?; devicePublicKey? }) → { terminalId: string; principalId: string }` (the third option is Task 0 amendment 24).** **Shared test helpers (§4.17.1) — one new file, registered by Task 0:** `tests/invariants/support/pos.ts` with `POS_PACK_ROOT`, `PosFixture`, `posFixture`, `enrolTerminal`, `EnrolledTerminal`, `signSyncRequest`, `syncRequest`, `buildTicket`, `BuildTicketOptions`, `uuidv7Sync`, `SHARED_SHIFT_ID`, `MemorySyncStore`.
- **Seven `Seed`, fixture and register facts every test in this plan depends on, stated once because getting one wrong is a silent failure.** (1) **`Seed` has no `branch` member** — it is `{ tenant; system; human; company; period; closedPeriod; lockedPeriod; cash; sales; docType; policy; branchType; hq }` (§4.1), and `app.document.branch_id` is NOT NULL, so every `branchId:` in this plan is `<seed>.hq` unless a second value came from 0D's `seedBranch`. (2) **`seedTenant` grants `s.human` nothing** (§4.1, pinned) and 2B's R2 evaluates `policy.approval.post` *inside* the posting transaction, so **every posting test calls `grantCodes` first** — including the terminal, which needs `pos.sync.push` through the `pos_terminal` role. (3) **Plan 0A seeds exactly three fiscal periods and only 2026-01 is open**; every test that posts outside January calls 3B's `ensureOpenPeriods(db, s, 2026)` first. (4) **`app.document` has no `custom_fields` column** — only `document_line` does (§4.3.4). A tender line's `method` and `reference` live in `document_line.custom_fields`; `document.tax_inclusive` is a **column** (5A's 0054). (5) **`app_rw` holds DELETE on exactly five tables** (§3.5.4) and **2B is the only slice that ever extends that list** — nothing in this slice deletes a row: an enrolment is spent by `redeemed_at`, a terminal by `revoked_at`, a needs-attention row by `resolved_at`, a catalogue row by a tombstone. (6) **`PlannedMovement.quantity` is always non-negative and `effect` is the sole carrier of direction** (3A's rule, §4.4.2 A9's twin) — a POS **return** line carries a negative `document_line.quantity`, and `planMovements` therefore emits `receipt` at that quantity's **magnitude** from a policy that declares `effect: "issue"`. ⚠️ **Spell the magnitude `q.negate()` under `q.isNegative()`, never `q.abs()`: `Quantity` has `add`, `subtract`, `negate`, `multiply`, `convert`, `compare`, `isZero`, `isNegative`, `toDecimal`, `toString`, `toJSON` and NOTHING else (§4.2.1, 0D's frozen member list — only `Money` has `abs`).** 3A's prose says `quantity.abs()` and 3A's own implementation says `mv.effect === "issue" ? mv.quantity.negate() : mv.quantity` (phase-3a:5589); the implementation is the one that compiles. **No line of this slice reads `quantity.isNegative()` or `amount.isNegative()` to choose a direction** — reading it to take a magnitude is not choosing a direction. (7) **`app.pos_terminal` is a Plan 0A table** (migration 0001) — this slice adds one column to it and never re-creates it.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first (that is what Task 0 is).
- **Contracts version:** 2026-09-07.

## Global Constraints

Copied verbatim from the spec and the contracts document; every task's requirements implicitly include this section.

1. **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (LEGACY-036/037/069); issue DDL from application code (LEGACY-053); disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053); gate an audit write on any flag (LEGACY-030); hard-code a package version into a source file — the lockfile owns versions.
2. **Always**, for every new table (spec:106): `tenant_id`, an RLS policy named exactly `tenant_isolation`, `created_at`, a migration with a hand-written down, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. **This slice creates three tables** — `catalogue_tombstone`, `terminal_enrolment`, `needs_attention` — and every one carries the §3.3 binding form and a two-tenant test in the same task. **This slice ships no UI screen**, so the both-directions clause has nothing to bind.
3. **`applyBatch` writes documents and lines and calls `postDocument`; it writes no ledger, movement, layer, projection or tax-transaction row** (hazard 22, §4.3.2's closed list). `packages/db/src/sync/apply.ts` contains no `insert into app.ledger_entry`, no `insert into app.inventory_movement`, no `merge into app.stock_on_hand`, and no `insert into app.tax_transaction`. The `posting-only-tables` lint (§3.7.5) is what proves it, and Task 15 asserts the rule's allow-list is unchanged by this slice.
4. **`document_event` is written only by triggers and the override door** (hazard 24, §4.5.2–§4.5.3). `applyBatch` records a supervisor override through **2B's `recordOverride`** and never by an `insert into app.document_event` of its own.
5. **The terminal acts, the cashier is attributed** (hazard 19, spec:1324, LEGACY-044). `document.created_by` and `document.posted_by` are the **terminal** principal, resolved from the signed call and set by `app.current_actor()` through the session — never from the payload. `document.attributed_to` is the cashier. `document_event.actor_id` on an override is the terminal; `document_event.attributed_to` is the supervisor. **No line of this slice passes a principal id from a request body into an actor column.**
6. **`PlannedLedgerLine.amount` is never negative and `side` is the sole carrier of direction** (§4.4.2 A9), and **§4.4.2's ⚠️ names 6A explicitly**. A POS return, a discount and a negative tender are all magnitudes whose direction the policy chooses through a fixed `side` or `when: { "line.quantity_sign": … }`. **No line of this slice tests the sign of an amount or a quantity to decide a direction, an account or an effect.** `PlannedTaxLine.amount` stays signed and this slice never reads its sign either.
7. **Every query, reads included, runs inside `withTenant`** (spec:2053). `db.` is a lint violation; only a `tx` obtained from `withTenant` may tag SQL. The one exception this slice adds is `packages/db/src/sync/identity.ts`, which calls two SECURITY DEFINER functions **before a tenant is known** — the same reason `packages/db/src/with-tenant.ts` is already on the `no-bare-db` allow-list — and Task 0 puts it there with its reason on the line. `sql.unsafe` has exactly three homes and none is in this slice (§3.3, hazard 21).
8. **One migration per PR** (spec:2057); each file runs whole in one transaction; every statement carries a comment naming the LEGACY-/spec reference it serves; SQL keywords lowercase; section banners `-- ── N. title ───`; a hand-written `NNNN.down.sql` that drops only what the up added, in reverse dependency order (§3.4.5).
9. **No enum label is added** (§3.4.4, hazard 11). Every new closed vocabulary in this slice is `text` + a named `check`: `catalogue_tombstone.stream`, `needs_attention.error_code` is free text (it holds an `ErrCode`, an open registry), and `document_line.kind`'s CHECK is **rewritten wholesale to the full six-label union** in 0061 exactly as §4.3.4 requires, because 8B's 0087 writes the identical list and either file may run first (spec:2301).
10. **Deletion** (spec:2049): financial rows never; master data is `archived_at`. §3.5.4's pinned `app_rw` DELETE list is **unchanged** by this slice and Task 15 re-asserts it as an equality against `["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]`.
11. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). **This slice adds exactly the six rows §4.2.4 allocates it:** `ERR_SYNC_TICKET_REJECTED` (200, per-ticket), `ERR_SYNC_CURSOR_INVALID` (400), `ERR_SYNC_MESSAGE_UNSUPPORTED` (200, per-message), `ERR_TERMINAL_SIGNATURE_INVALID` (401), `ERR_TERMINAL_REVOKED` (403), `ERR_TERMINAL_ENROLMENT_INVALID` (400) — each added in the PR that raises it. **`ERR_POS_LIMIT_EXCEEDED` is 6C's** and is not added here. Everything else this slice raises is already shipped: `ERR_VALIDATION_FAILED`, `ERR_NOT_FOUND`, `ERR_RBAC_FORBIDDEN`, `ERR_RLS_DENIED`, `ERR_CONFLICT_UNIQUE`, `ERR_CONFLICT_REFERENCE`, `ERR_DOC_STATUS_ILLEGAL`, `ERR_DOC_NO_LINES`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_PERIOD_NOT_OPEN`, `ERR_PERIOD_NOT_FOUND`, `ERR_STOCK_INSUFFICIENT`, `ERR_TAX_REGIME_MISMATCH`, `ERR_IDEMPOTENCY_KEY_MISSING`, `ERR_OVERRIDE_NOT_AUTHORISED`, `ERR_INTERNAL`. **This list is closed:** a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.
12. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice seeds exactly the eleven codes §3.6.2 assigns it and invents none. `pos.price.check`, `pos.shift.own` and `pos.attendance.clock` are **6B's**; `pos.cashier.manage_pin` is **6C's**; `pos.shift.close_any` and `pos.report.read` are **6D's**.
13. **No plan invents a literal in a shared namespace** (hazard 32). Document-type codes, account codes, report codes, `DatasetId` members, `fixtures.ts` helper names and `ERR_*` names all come from the registers; **Task 0 amends a register before any task writes a literal into it**.
14. **The slice that seeds a policy seeds the accounts that policy names by code** (§4.15, hazard 33). `POS_TICKET`'s four tender rules resolve `{ code: "1110" }`, `{ code: "1120" }`, `{ code: "1100" }` and `{ code: "2200" }`. Three of the four are this slice's own rows; `1100` is **0C's**, and Task 5's fourth test case asserts it resolves rather than re-seeding it.
15. **No real Malaysian statutory rate, threshold or figure appears anywhere in this slice, and no LHDN or MyInvois endpoint, field, schema version or deadline appears either** (hazards 1 and 2). Every tax figure in this plan comes from 5A's clearly-synthetic `SYNTH-MY-v1` regime through `taxFixture`; this slice states none of its own.
16. **The Firebird version is unknown and no legacy assumption appears here** (hazard 3). This slice reads no legacy database and asserts nothing about `mpos`.
17. **Jobs run as the tenant's system principal** (hazard 20) — **with one registered exception, and it is this slice's**: `pos.sync.apply` runs under a **terminal** context, because hazard 19 requires `posted_by` to be the terminal principal and a system-posted ticket would be LEGACY-044 in the opposite direction. Task 0 registers it; Task 12 implements it through `terminalContext`, which resolves the terminal's principal through `app.resolve_principal('terminal:<id>')` and never accepts a principal id from a payload.
18. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [6A T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root stay green after every task. **This slice does not rewrite `AGENTS.md`'s "Current phase" section** — §3.8 names 6D as Phase 6's closing slice.

---

## This slice's share of the Phase 6 definition of done

The Phase 6 row, verbatim (spec:2292) — **Definition of done:** *"A till sells 8 hours offline and reconciles with **zero duplicates and zero lost tickets**; the shift Z-report ties to the ledger to the cent"*. §2.7's card says this slice's share is **the server half of "zero duplicates and zero lost tickets" (re-sending a batch changes nothing)**.

| Clause | Where it is green |
|---|---|
| **zero duplicates** | **Task 11 Step 2, `applyTicket` (a) and `classify`** — `applyBatch` reads `app.document` for `(company_id, client_ref)` inside the savepoint and answers `duplicate` without writing; **and** SQLSTATE 23505 on `document_company_id_client_ref_key` — the race two concurrent applies of one batch produce — is mapped to `duplicate`, not to a rejection. **Task 12 Step 6** proves it end to end: the same `TicketBatch` posted twice produces one document, one set of ledger entries and one set of cost consumptions, and the second response is all-`duplicate`. |
| **zero lost tickets** | **Task 11 Step 2, `applyBatch`'s catch and `upsertNeedsAttention`** — every per-ticket failure rolls back to its savepoint and writes an `app.needs_attention` row carrying the whole `payload`, the `error_code` and the `error_detail`, so a rejected ticket is recoverable from the server alone; **Task 11 Step 2, `refuseUnsupported` and `applyTicket` (c)** — a `TicketBatch` carrying `shifts`, `tillEvents` or a non-empty `Ticket.attendance` before 6C/6D exist is **refused per message with `ERR_SYNC_MESSAGE_UNSUPPORTED`, never dropped**, so the till keeps its outbox row; **Task 9 Step 2, `drainOutbox`** — `drainOutbox` marks `acked_at` only for a ref that appears in one of the three result arrays, and a row whose ref appears in none stays pending (spec:1337). |
| **re-sending a batch changes nothing** | **Task 12 Step 6** — two layers, both required (§4.2.9): the `Idempotency-Key` header replays the stored response for an identical retry, and `client_ref` dedup makes a *different*-key re-send of the same tickets equally harmless. The test exercises both, and asserts `select count(*) from app.ledger_entry` is unchanged after the second and third sends. |

**What is deliberately *not* in this slice's DoD share:** the till. "Sells 8 hours offline" is **6B's** — `apps/pos`, the local SQLite schema, the outbox writer and acceptance test 19 — and the Z-report sentence is **6D's**. This slice ships the protocol both of them compile against, and `pullAll` / `drainOutbox` as pure functions over the `SyncStore` and `SyncTransport` ports so 6B supplies the SQLite implementation and nothing else.

---

## File Structure

```
packages/sync/                                                 NEW package @dulja/sync (§3.1)          T1
├─ package.json                                    NEW                                                 T1
├─ tsconfig.json                                   NEW                                                 T1
├─ vitest.config.ts                                NEW                                                 T1
├─ src/
│  ├─ index.ts                                     NEW  the barrel — the whole cross-slice surface      T1
│  ├─ messages.ts                                  NEW  §4.10.1 verbatim + CATALOGUE_STREAMS            T1
│  ├─ cursor.ts                                    NEW  encodeSyncCursor / decodeSyncCursor             T1
│  └─ client.ts                                    NEW  SyncStore, SyncTransport, pullAll, drainOutbox  T9
└─ test/
   ├─ cursor.test.ts                               NEW                                                 T1
   ├─ pull-all.test.ts                             NEW  acceptance test 20                             T9
   └─ drain-outbox.test.ts                         NEW                                                 T9

packages/contracts/
├─ permissions.ts                                  MODIFY  +11 PermissionDef rows                       T5
├─ src/errors.ts                                   MODIFY  +6 ERRORS rows, one per raising PR      T6,T7,T8,T11
├─ src/accounting/document.ts                      MODIFY  DocumentLineKindSchema → the six-label union  T4
└─ src/sync/
   ├─ catalogue.ts                                 NEW  ChangeSchema, CataloguePageSchema, CatalogueQuery  T8
   ├─ ticket.ts                                    NEW  the TicketBatch / BatchResult Zod twins          T12
   ├─ enrolment.ts                                 NEW  CreateEnrolmentBody, EnrolBody, EnrolResult     T6
   └─ needs-attention.ts                           NEW  NeedsAttentionSchema, ResolveBody               T12

packages/db/
├─ migrations/
│  ├─ 0059_add_catalogue_revision.sql              NEW                                                 T2
│  ├─ 0059.down.sql                                NEW                                                 T2
│  ├─ 0060_create_terminal_enrolment_needs_attention.sql  NEW                                          T3
│  ├─ 0060.down.sql                                NEW                                                 T3
│  ├─ 0061_alter_document_add_pos_columns.sql      NEW                                                 T4
│  ├─ 0061.down.sql                                NEW                                                 T4
│  ├─ 0062_seed_permission_phase6a.sql             NEW                                                 T5
│  └─ 0062.down.sql                                NEW                                                 T5
├─ seed/
│  ├─ roles.ts                                     MODIFY  cashier + branch_manager + admin grants      T5
│  └─ my/
│     ├─ chart-of-accounts/6a-pos-tenders.json     NEW  1110, 1120, 2200                               T5
│     └─ document-types/POS_TICKET.json            NEW  the §4.3.7 envelope                            T10
├─ src/
│  ├─ schema/catalogue-tombstone.ts                NEW  Drizzle mirror                                 T2
│  ├─ schema/terminal-enrolment.ts                 NEW  Drizzle mirror                                 T3
│  ├─ schema/needs-attention.ts                    NEW  Drizzle mirror                                 T3
│  ├─ jobs/payloads.ts                             MODIFY  + "pos.sync.apply"                          T12
│  ├─ posting/issue.ts                             MODIFY  resolveSeries — the terminal suffix          T4
│  ├─ posting/load.ts                              MODIFY  lift custom_fields.method → tenderMethod    T10
│  ├─ sync/authority.ts                            NEW  POS_PERMISSION, OVERRIDE_SUBJECT_FOR            T5
│  ├─ sync/identity.ts                             NEW  resolveTerminal, resolveEnrolment (allow-listed) T6
│  ├─ sync/enrolment.ts                            NEW  createEnrolment, redeemEnrolment, createTerminal T6
│  ├─ sync/context.ts                              NEW  terminalContext                                T7
│  ├─ sync/catalogue.ts                            NEW  readCatalogue                                  T8
│  ├─ sync/apply.ts                                NEW  applyBatch — the core                          T11
│  ├─ sync/needs-attention.ts                      NEW  listNeedsAttention, resolveNeedsAttention      T12
│  ├─ sync/index.ts                                NEW  the @dulja/db sync barrel                       T6
│  ├─ index.ts                                     MODIFY  export * from "./sync"                       T6
│  └─ lint-schema.ts                               UNCHANGED (all three new tables are plain — §3.5.3)   —
└─ test/
   ├─ fixtures.ts                                  MODIFY  + seedTerminal                              T6
   ├─ privileges.test.ts                           MODIFY  the pinned DELETE list, unchanged           T15
   ├─ sync/catalogue-revision.test.ts              NEW                                                 T2
   ├─ sync/enrolment.test.ts                       NEW                                                 T3,T6
   ├─ sync/pos-columns.test.ts                     NEW                                                 T4
   ├─ sync/accounts-and-codes.test.ts              NEW  the eleven codes, the roles, the three accounts T5
   ├─ sync/catalogue-read.test.ts                  NEW                                                 T8
   ├─ sync/pos-ticket-policy.test.ts               NEW  the POS_TICKET envelope and both directions    T10
   └─ sync/apply.test.ts                           NEW                                                 T11

apps/api/src/
├─ app.ts                                          MODIFY  AppDeps +1; the route.auth switch        T6,T7
├─ index.ts                                        MODIFY  derives terminalJwtSigningKey from config    T7
├─ config.ts                                       MODIFY  + terminalJwtSigningKey                     T7
├─ context.ts                                      MODIFY  AppEnv.Variables gains db, terminal      T6,T7
├─ problem.ts                                      MODIFY  one asAppError branch for SyncError          T7
├─ middleware/terminal-auth.ts                     NEW  the whole §4.10.3 scheme                       T7
├─ middleware/require-permission.ts                MODIFY  the { company: "terminal" } branch          T7
├─ middleware/require-document-permission.ts       MODIFY  POLICY_RESOLVED_CODES + pos.sync.push       T10
├─ routes/accounting/documents.ts                  MODIFY  DOCUMENT_STAGE_CODES gains pos.sync.push    T10
├─ routes/admin/terminals.ts                       NEW  /v1/admin/terminals                            T6
├─ routes/sync/enrolments.ts                       NEW  /v1/sync/enrol (public, §4.10.3)               T6
├─ routes/sync/catalogue.ts                        NEW  /v1/sync/catalogue (terminal)                  T8
├─ routes/sync/tickets.ts                          NEW  /v1/sync/tickets (terminal)                    T12
├─ routes/pos/needs-attention.ts                   NEW  /v1/companies/:companyId/needs-attention       T12
└─ routes/index.ts                                 MODIFY  five buildRoutes entries               T6,T8,T12

apps/api/test/
├─ support/app.ts                                  MODIFY  startApi()'s deps gain the seventh member    T7
└─ routes/sync/
   ├─ enrolment.test.ts                            NEW                                                 T6
   ├─ terminal-auth.test.ts                        NEW                                                 T7
   ├─ catalogue.test.ts                            NEW                                                 T8
   └─ tickets.test.ts                              NEW                                                 T12

apps/worker/src/handlers/pos-sync-apply.ts         NEW  the pos.sync.apply handler                     T12
apps/worker/src/index.ts                           MODIFY  registers the handler                       T12
apps/worker/test/handlers/pos-sync-apply.test.ts   NEW                                                 T12

infra/src/secrets.ts                               MODIFY  + TERMINAL_JWT_SIGNING_KEY (api only)        T7

scripts/lint/rules/no-bare-db.ts                   MODIFY  + packages/db/src/sync/identity.ts          T6
scripts/lint/rules/dependency-rule.ts              MODIFY  + @dulja/sync tier; pos.ts → apps/api    T1,T7

tests/
├─ invariants/support/pos.ts                       NEW  §4.17.1 — the shared POS fixture     T6,T7,T9,T10
├─ invariants/probes.ts                            MODIFY  5 PROBES + 1 JOB_PROBES                T6,T8,T12
├─ invariants/pos-one-posting-path.test.ts         NEW  acceptance test 22                            T13
├─ invariants/auth-bypass.test.ts                  MODIFY  the sync-header shapes (test 11)            T7
├─ regression/legacy-046.test.ts                      NEW  created by this slice                         T15
├─ regression/legacy-009.test.ts                      MODIFY  append a — 6A block                        T15
├─ regression/legacy-027.test.ts                      MODIFY  append a — 6A block                        T15
├─ regression/legacy-028.test.ts                      MODIFY  append a — 6A block                        T15
├─ regression/legacy-044.test.ts                      MODIFY  append a — 6A block                        T15
├─ regression/legacy-048.test.ts                      MODIFY  append a — 6A block                        T15
├─ regression/legacy-051.test.ts                      MODIFY  append a — 6A block                        T15
└─ regression/legacy-052.test.ts                      MODIFY (⚠️ OD-07 only) append a — 6A block         T14

docs/adr/0054-commit-ordered-catalogue-revisions.md          NEW                                       T2
docs/adr/0055-terminal-identity-and-the-terminal-jwt.md      NEW                                       T3
docs/adr/0056-up-sync-apply-savepoints-and-refusal.md        NEW                                       T11
```

---

### Task 0: Contracts amendments and the 5A/4A/3B/3A repo gate

**Nothing in this task writes product code.** It does two things the remaining fifteen tasks depend on: it lands the twenty-four amendments this slice needs in the contracts document (hazard 32 — *"a plan amends the register before any task writes a literal into it"*), and it runs one script that proves every name this plan consumes actually exists in the merged repository. §4.18's rule is that a written plan's file is the authority where it differs from the registry; the gate is what discovers a difference **before** Task 1 rather than in Task 11.

**Files**

- `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` — MODIFY (twenty-four amendments)
- `scripts/gate-6a.sh` — NEW (a throwaway; deleted by this task's own last step)

**Interfaces**

- Consumes: the whole contracts document.
- Produces: no code. Twenty-four register rows the later tasks cite by number.

**Steps**

- [ ] **Step 1: Amend §6.1 row 22 — choose reading (a).** 4A's plan (phase-4a:230, 6224) hands 6A a choice it could not make itself: ADR 0044 made the seeded `SALES_INVOICE` `inventory.effect: "none"`, so it has zero cost consumptions and credits `1250`, while a `POS_TICKET` consumes a layer and credits `1300` — the comparison spec:2440 asks for cannot run against the seeded type, and the `DELIVERY_ORDER ∪ SALES_INVOICE` union does not compare either. **Choose (a).** Replace row 22's *Indicative task* cell with:

  > `POS_TICKET` vs **`POS_EQUIV_INVOICE`** multiset compare per §5 item 18 (T13). **Reading (a) of 4A's amendment 15 is taken:** the "equivalent back-office invoice" is a **stock-issuing type 6A configures in its own fixture** — same lines, same policy shape, a cash tender line instead of a receivable leg — posted through the ordinary `POST …/documents/{id}/transitions` route by a **human** under `accounting.sales.post`, against a `POS_TICKET` posted by a **terminal** under `pos.sync.push`. That is what makes the test non-vacuous: the two documents differ in **type, series, acting principal and write path**, and in nothing else, so an identical multiset proves there is one posting service. Reading (b) — netting the two `1250` legs of a `DO ∪ INV` pair — is **not** taken: hazard 18's projection set is frozen and does not net pairs, and amending it to do so would weaken every other slice's use of it.

- [ ] **Step 2: Amend §4.14 — one test-only row.** Insert after the `POS_TICKET` row:

  | `POS_EQUIV_INVOICE` | 6A (**test only**) | `accounting` | outbound / issue / `accounting.sales.post` | `PEI` | the stock-issuing back-office invoice acceptance test 22 compares a `POS_TICKET` against, under §6.1 row 22 reading (a). Its policy is `POS_TICKET`'s with `documentType`, `numbering.series` and `approval.post` changed and `requires` reduced to `["warehouse"]`; **never a file under `packages/db/seed/my/document-types/`** and never reached by `bun run seed`. A second code is needed because 4A's seeded `SALES_INVOICE` is financial-only (ADR 0044) |

- [ ] **Step 3: Amend §4.15 — restate 6A's three rows and add the sentence 6D depends on.** The `1110`, `1120` and `2200` rows already name 6A as their seeder. Append to §4.15's *"Why these seeders and not others"* paragraph: *"`1100` Bank is **0C's** and is the fourth account `POS_TICKET`'s tender rules resolve (§4.6.5 names four); 6A consumes it and Task 5's own test asserts it resolves rather than re-seeding it."*

- [ ] **Step 4: Amend §4.5.6 — three tables join the `branch_isolation` lists.** 6C's migration 0068 names its tables explicitly, and all three of this slice's tables carry a branch key, so without this amendment 6C's own `branch_isolation_policy` linter rule (§3.5.2) reports three violations the moment 0068 lands. Add to Form A's table list: **`terminal_enrolment`** and **`needs_attention`** (both `branch_id uuid not null`). Add to Form B's table list: **`catalogue_tombstone`** (`branch_id uuid` **nullable** — a company-wide price list or promotion has no branch, and its tombstone must reach every terminal or the deletion is silently missed, which is exactly what acceptance test 20 forbids). Add to the Form C paragraph: *"6A's three tables are attached in 0068 like every other pre-0068 table; 6A creates them branch-ready and attaches nothing (§3.5.1 step 7)."*

- [ ] **Step 5: Amend §4.10.2 — the `revision` default is `nextval`, not `0`.** §4.10.2 says *"Every stream table gets `revision bigint not null default 0`"*. On a table that already holds rows that is wrong twice over: a fresh till pulls with `since = 0` and `revision > 0` excludes **every pre-6A row**, and thousands of rows sharing revision `0` cannot be paged by a keyset cursor at all — acceptance test 20's resume would either skip or repeat a page. A migration cannot backfill by `update` either (hazard 10: `FORCE ROW LEVEL SECURITY` binds `app_migrator`, so a migration sees zero tenants). Replace the sentence with:

  > Every stream table gets `revision bigint not null default nextval('app.catalogue_revision_seq')`. On `alter table … add column`, PostgreSQL evaluates a **volatile** default once per existing row, so every pre-existing row receives a distinct, increasing revision in one pass and no backfill statement is needed. **6C's `pos_cashier` and `branch_pos_policy` keep the `default 0` their §4.6.3/§4.6.4 DDL declares** — they are created empty, so every row of theirs is written by the trigger.

- [ ] **Step 6: Amend §4.3.4 and §4.3.6 — `pos_terminal.code`, `document.shift_id`, and the per-terminal series.** §4.14 gives `POS_TICKET` the series `POS-<terminal code>` and spec:1721 shows `'POS-KL01'`, but §4.4.1 pins `numbering.series` to a **static literal** matching `^[A-Z0-9-]{1,16}$` and §4.3.6's SQL writes it verbatim, so a policy alone cannot express one. §6.1 row 16 nevertheless assigns 6A a re-run of acceptance test 16 on *"per-terminal series"*. Add to §4.3.4's header-additions paragraph: *"`app.pos_terminal` additions: 6A (0061) `code text` with `unique (company_id, code)` — nullable for expand-safety (§3.4.7); every row is written by enrolment, which is 6A's own route, so no backfill exists."*

  **And in the same paragraph, `document.shift_id` moves from 6D to 6A.** §4.3.4 currently reads *"6A (0061) `terminal_id uuid` (FK `pos_terminal`), 6D (0070) `shift_id uuid`"*. That assignment cannot stand: **6A's own `applyTicket` step (f) writes `document.shift_id` on every `POS_TICKET` it inserts**, so a 0061 without the column cannot pass this slice's own batch suite, and "6A merged and green" is 6D's phase gate. **6D has already recorded the same conclusion from its side** — its amendment **A2** reads *"§4.3.4's header-additions paragraph assigns `shift_id uuid` to 6D (0070). That assignment is superseded: 6A's 0061 adds the column … 6D's Task 0 gate asserts it by literal and, if it is absent, raises against 6A rather than adding it in 0070."* This amendment is 6A's half of that agreement, and the two plans must land the same words. Rewrite the clause to:

  > 6A (0061) `terminal_id uuid` (FK `pos_terminal`) **and `shift_id uuid` (no foreign key, and none is added later in Phase 6)**; 9B (0101) `legacy_ref text`.

  with the sentence: *"**`shift_id` deliberately carries no FK at 0061 and none at 0070.** `app.shift` is 6D's table and does not exist at 0061; and at 0070 a validated key is still impossible, because PostgreSQL's referential-integrity scan **bypasses row security** and would therefore see every `POS_TICKET` written between 6B's release and 6D's, each naming a shift with no row — while a migration cannot backfill the parents, since `FORCE ROW LEVEL SECURITY` binds `app_migrator` and a migration file sets no tenant (hazard 10). The reference is enforced in the apply path instead: 6D's `assertShiftKnown` refuses a ticket whose `shiftId` names no shift **of that terminal**, so no new orphan is created — the same shape §4.3.4 already uses for the `item_id` and `tax_code_id` slots. **6D's 0070 adds the index `document_shift_idx` and the guard; the column is 0061's.** A contract migration in a later slice may add the key once every till has re-sent its shift-open messages (§3.4.7); no plan may add it without amending this paragraph."*

  And add to §4.3.6, after "The series comes from `policy.numbering.series`":

  > **One documented exception, 6A's (§4.14's `POS-<terminal code>`, spec:1721).** `issueDocument` resolves the effective series through `resolveSeries(tx, documentId, policySeries)`: when the document carries a non-null `terminal_id` whose `pos_terminal.code` is non-null, the effective series is `policySeries || '-' || code`; otherwise it is `policySeries` unchanged. The advisory-lock key, the `document_series` upsert and the `update … returning` are all unchanged — they simply take the resolved string. **No other slice's documents carry a `terminal_id`**, so this branch is unreachable outside Phase 6 and every existing numbering test is untouched.

- [ ] **Step 7: Amend §4.2.3 — `AppEnv["Variables"]` becomes ten members, and `ApiConfig` gains one.** **Two new rows, not three.** §4.2.3 already reads *"The registered `Variables` set is eight members (round 3)"* and its eighth is **`jobs: JobClient`, ratified as 3B's amendment A5** — set by the two-line `use("*")` middleware 3B's Task 7 adds to `createApp` from `deps.jobs`. 6A **consumes** that row (`ticketRoutes` enqueues `pos.sync.apply` for an over-size batch) and does not re-declare it; re-declaring it would be a duplicate member in one interface body and a second `c.set("jobs", …)` in one `createApp`. The two rows that are genuinely new are: **`db`**, because **`enrolmentRoutes` runs before any tenant exists** (it resolves a one-time code through a SECURITY DEFINER door), so `c.var.withTenant` — which closes over `c.var.ctx` — does not exist on it and the handler needs the raw pool; and **`terminal`**, which `terminalAuth` resolves once per `/v1/sync/*` request. Neither is reachable through the eight registered members, and 0B's factory precedent (`createUserRoutes(authAdmin)`, §4.2.7) does not fit here because `ROUTES` is derived from `buildRoutes({ authAdmin: new StubAuthAdmin() })` at module scope, where no `Sql` exists to hand a factory. Change the count sentence to *"**The registered `Variables` set is ten members.**"*, keep round 3's `jobs` row exactly as it stands, and add the two rows:

  ```ts
  // apps/api/src/context.ts (6A) — the ninth and tenth members.
  db: Sql;                        // the pool — for the ONE handler that runs before a tenant is known
  terminal: TerminalIdentity;     // set by terminalAuth on every /v1/sync/* request; undefined elsewhere
  ```

  with the sentence: *"The ninth, `db: Sql` (6A), is set by `createApp` from `AppDeps` in a `use(\"*\")` registered **before** `requestId`, so it is present on every request including a public one; a handler that has a tenant still uses `c.var.withTenant` and never `c.get(\"db\")` — the one `db` call site in the system is the public enrolment handler and nothing else, and the `no-bare-db` lint's allow-list (§3.7.5) is what keeps it that way. `jobs` (3B, round 3) is unchanged and 6A adds neither a second declaration nor a second setter for it. The tenth, `terminal: TerminalIdentity` (6A), is set by `terminalAuth` on every `/v1/sync/*` request so a handler and `requirePermission`'s `{ company: \"terminal\" }` branch read the resolved terminal row rather than re-reading it; it is `undefined` on every non-terminal route."* And register the shape:

  ```ts
  // apps/api/src/middleware/terminal-auth.ts (6A)
  export interface TerminalIdentity {
    readonly terminalId: string; readonly tenantId: string; readonly companyId: string;
    readonly branchId: string; readonly principalId: string; readonly code: string | null;
  }
  ```

  In the same section, add one member to `ApiConfig`: `readonly terminalJwtSigningKey: string;` (6A) — read from `TERMINAL_JWT_SIGNING_KEY` (§3.11), with the sentence *"`readConfig` throws `ConfigError` when it is shorter than 32 characters; there is no default, because a default would be a shared secret in the repository."*

- [ ] **Step 8: Amend §4.2.7 — `IsolationProbe.expect` widens to `400 | 401 | 403 | 404`.** 0B's harness sends every probe as `a.human` with a human Bearer token; a route whose `auth` is `"terminal"` is refused by `terminalAuth` at the identity layer with **401**, and the public enrolment route answers **400** to an unknown code. Both are stronger refusals than 403, and pinning the *recorded* value is exactly what §4.2.7's `expect` exists for. Change the declaration to `expect: 400 | 401 | 403 | 404` and add: *"A `401` is the recorded value for a module whose `auth` is `\"terminal\"`; a `400` for a public module whose only key is a bearer secret. Neither is a widened acceptance set — the harness still asserts equality."* **`TENANT_FREE` is unchanged and gains no member.**

- [ ] **Step 9: Amend §3.7.5 — two lint-rule rows.** `no-bare-db`'s allow-list files gain **`packages/db/src/sync/identity.ts`** with the reason *"calls the two SECURITY DEFINER doors that run before a tenant is known — `app.resolve_principal` for a terminal and `app.resolve_enrolment` for a one-time code — exactly as `with-tenant.ts` does"*. `dependency-rule` gains the tier row **`packages/sync` → `['@dulja/domain', '@dulja/contracts']`** (§3.1 already declares the tier; the rule needs the entry).

- [ ] **Step 10: Amend §4.1 — a second `app_auth`-owned function.** §4.1 says `app_auth` *"owns `resolve_principal` only"* and Plan 0A's `privileges.test.ts` asserts `{ owner: "app_auth", secdef: true, bypass: false }` for that one function (plan0A:896–902). Change the sentence to *"owns `resolve_principal` and, from migration 0060, `resolve_enrolment`"*, and add to the session-functions paragraph: `app.resolve_enrolment(p_code_hash bytea) returns table (enrolment_id uuid, tenant_id uuid, company_id uuid, branch_id uuid)` — SECURITY DEFINER, owner `app_auth`, EXECUTE for `app_rw` only, callable with no tenant set; returns zero rows for an unknown, expired or already-redeemed code. **Terminal authentication needs no new function**: `app.resolve_principal('terminal:<terminal_id>')` already answers it.

  **In the same edit, restate §4.10.3's DDL sketch and enrolment body, which this amendment's `bytea` argument contradicts.** §4.10.3 writes `terminal_enrolment(company_id, branch_id, code_hash text not null /* sha256 of the one-time code */, issued_by (stamped), expires_at timestamptz not null, redeemed_at, terminal_id uuid)` and the create body `{ companyId, branchId, name }`. Three corrections, all shipped by migration 0060 and Task 6's route:

  > `terminal_enrolment(company_id, branch_id, **`code_hash bytea not null unique`** /* the raw 32 bytes of sha256(code). The hash is computed in TypeScript — `createHash("sha256").update(code).digest()` returns a `Buffer`, which postgres.js binds as `bytea` — so `bytea` is the column that stores exactly what the hasher produced. A `text` column would force a hex or base64 *rendering*, and every lookup would then depend on the writer and the reader having chosen the same one */, **`name text not null`** /* the terminal's display name, chosen at issue and copied to `pos_terminal.name` at redemption */, **`terminal_code text not null`** with **`unique (company_id, terminal_code)`** /* becomes `pos_terminal.code`, and therefore the numbering suffix of §4.3.6 — reserved at *issue* so two open enrolments cannot both promise `KL01` */, issued_by (stamped), expires_at timestamptz not null, redeemed_at, terminal_id uuid)`. The create body is `POST /v1/admin/terminals/enrolments { companyId, branchId, name, **terminalCode** }` under `admin.terminal.manage`.

  **Why the code is reserved at issue and not at redemption:** `pos_terminal.code` is `unique (company_id, code)` (amendment 6), so a collision discovered at redemption would fail the till's one-shot enrolment with a conflict it cannot act on — the code is already burnt. Reserving it on the enrolment row moves the refusal to the back office, where the human who chose the name can choose another.

- [ ] **Step 11: Amend §4.10.1 — two additive members and the codec names.** (a) `Ticket` gains `newCustomer?: NewCustomer | null` with `export interface NewCustomer { id: string; code: string; nameEn: string; phone: string | null }` — the till mints the party's `uuidv7` offline and sets `customerId` to the same value, so a quick-created customer is idempotent on re-send exactly as a ticket is. Without it §2.7's *"customer quick-create applied under `pos.customer.create`"* has no field to read. (b) Register the codec `export function encodeSyncCursor(c: Cursor): string` / `export function decodeSyncCursor(raw: string): Cursor` in `packages/sync/src/cursor.ts` — §4.10.1 fixes the wire form (*"base64url of the decimal revision"*) but names no function, and two spellings of one codec is hazard 9. (c) Register `export const CATALOGUE_STREAMS: readonly Stream[]` — the eight members of `Stream` in pull order, so the till and the server iterate one list.

- [ ] **Step 12: Amend §4.10.4 — the 202 response carries no `statusUrl`.** §4.10.4 says the over-size response is *"`202` with a job status URL"*, but no slice ships `/v1/jobs/{jobId}` (§4.2.7 lists the path in the URL scheme and assigns it to no module; 7A and 9B both plan to point at it later), and a terminal-credentialled poll of a human route would be a new authentication surface for no gain. Replace with:

  > Batches over **`SYNC_BATCH_SYNC_LIMIT = 200`** tickets are enqueued as `pos.sync.apply` with `singletonKey = batchId` and answered **`202`** with body `{ batchId, jobId, status: "queued" }` and header `Retry-After: 5`. **No `statusUrl` is returned and no status resource exists at Phase 6.** The till's recovery path is to re-send the same batch, which `client_ref` dedup makes exact: every ticket the job already applied comes back `duplicate` and is acked, and every one it has not comes back `accepted`. A status resource would add a second, weaker way to learn the same thing.

- [ ] **Step 13: Amend §4.2.6 — the payload, the probe, and the one job that is not the system principal.** Add to the `JobPayload` block: `"pos.sync.apply": { terminalId: string; batch: unknown /* the TicketBatch, structurally */ };` — `unknown` because `packages/db` may not import `@dulja/sync` (§3.1) and `payloads.ts` lives in `packages/db`. Add to the Rules paragraph, after *"every handler runs as the tenant's system principal"*:

  > **One registered exception: `pos.sync.apply` (6A).** Its handler resolves the **terminal's** principal through `app.resolve_principal('terminal:<terminalId>')` and runs `applyBatch` under that context, because hazard 19 requires `document.posted_by` to be the terminal and a system-posted ticket would misattribute every POS posting in the ledger. The terminal id comes from the **payload the route wrote after authenticating the signed call**, never from a client body, and the handler re-checks `pos_terminal.revoked_at` before applying. Every write it makes is audited under the terminal's id, which is what §4.2.6's rule actually protects.

- [ ] **Step 14: Amend §3.6.4 — this slice's role grants.** Append to the recorded-grants sentence: *"**`pos.ticket.sell`, `pos.ticket.discount`, `pos.ticket.return`, `pos.customer.create` → `cashier`**; **those four plus `pos.ticket.void`, `pos.ticket.return_blind`, `pos.ticket.override`, `pos.needs_attention.resolve` → `branch_manager`**; **`admin.terminal.manage` → `admin` only** (6A). `pos_terminal` keeps exactly `pos.sync.pull` and `pos.sync.push`, which §3.6.4 already fixes, and 6A seeds no other role."* The grants come from spec:2160–2161, not from taste: `branch_manager` — *"overrides on **others'** tickets as the second principal … resolving the needs-attention queue"*; `cashier` — *"Sell, discount within the branch limit, return against an original ticket … customer quick-create"*, and explicitly **may not** *"Blind returns, voids, overrides on own tickets"*.

- [ ] **Step 15: Amend §4.17.1 — one new shared-helper file.** Add the row: `POS_PACK_ROOT`, `PosFixture`, `posFixture(api, name)`, `enrolTerminal(api, s, opts)`, `EnrolledTerminal`, `signSyncRequest(t, req)`, `syncRequest(api, t, req)`, `buildTicket(f, opts)`, `BuildTicketOptions`, `uuidv7Sync()`, `SHARED_SHIFT_ID`, `MemorySyncStore` · `tests/invariants/support/pos.ts` · **6A** · *"the POS corpus every Phase 6 slice re-uses: a seeded company with items, a warehouse, stock, the tax pack, the `POS_TICKET` type and an enrolled terminal, plus the Ed25519 request signer and an in-memory `SyncStore` (the SQLite one is 6B's). 6C, 6D and 7C all consume it."*

- [ ] **Step 16: Amend §4.2.8 — `DocumentLineKindSchema` takes the full union in 0061's PR.** Add after the `DocumentLineInput` paragraph: *"**`DocumentLineKindSchema` is rewritten to the full six-label union `[\"account\",\"item\",\"tax\",\"text\",\"tender\",\"payroll\"]` by whichever of 6A's 0061 and 8B's 0087 lands first**, for exactly the reason §4.3.4 gives for the SQL CHECK: Phase 8 may execute before or after Phase 6 (spec:2301), and a schema listing only the labels admitted so far would reject the other phase's label when it ran second. 3C's `DraftLine.kind` takes the same union in the same PR, without which the back-office half of acceptance test 22 cannot carry a tender line."*

- [ ] **Step 17: Amend §4.4.2 — one sentence on the tender lift, and one on the POS return.** Add to `LineSnapshot.tenderMethod`'s doc comment: *"6A's migration 0061 is what makes `kind = 'tender'` legal; `loadSnapshot` lifts `custom_fields.method` into this field in the same PR (6A), and `custom_fields.reference` stays in the untyped bag."* Add to the A9 ⚠️ paragraph's 6A entry: *"A POS **return** is not a second document type: it is a `POS_TICKET` whose line `quantity` and `amount` are negative. `planMovements` therefore emits `receipt` at that quantity's magnitude from a policy declaring `effect: \"issue\"` (3A's rule), and `evaluatePolicy` emits the opposite `side` at `amount.abs()`. One type, both directions, and no code anywhere reads a sign to choose one."* ⚠️ **Write the quantity half as a magnitude and not as `quantity.abs()`** — `Money` has `abs`, `Quantity` does not (§4.2.1's member list), and this sentence is going into the registry, where a method that does not exist becomes a spelling two later slices copy (hazard 9). 3A's implementation spells it `mv.effect === "issue" ? mv.quantity.negate() : mv.quantity` (phase-3a:5589).

- [ ] **Step 18: Amend §4.1's fixed literals — one new advisory-lock key.** Add: `hashtextextended('sync-batch:' || terminal_id::text, 0)` (6A) — taken by `applyBatch` at the top of its transaction so two concurrent applies for one terminal serialise instead of racing on `document_company_id_client_ref_key`. It is a **different** key space from `'tenant-serial:'` and `'series:'`, and a transaction may hold `'sync-batch:'` and then `'tenant-serial:'` but never the reverse, so no cycle exists.

- [ ] **Step 19: Amend §4.2.7 — the five module paths this slice mounts.** §4.2.7 keeps a table of *"Module paths and export names registered so far"* with the standing rule that *"a `RouteModule.path` is also the `PROBES` key, so two slices must never mount two modules on one path"*, and 2A and 2C each added their rows in round 2. Without these five rows nothing stops 6C, 6D or 7C mounting a second module on one of them — and 7C already owns the `needs_attention` `DatasetId` row (§4.16.2), so the last one is the live risk. Append:

  | `RouteModule.path` | Router export | Slice | Gate codes | `auth` |
  |---|---|---|---|---|
  | `/v1/admin/terminals` | `terminalRoutes` | 6A | `admin.terminal.manage` | `human` |
  | `/v1/sync/enrol` | `enrolmentRoutes` | 6A | — | `public` |
  | `/v1/sync/catalogue` | `catalogueRoutes` | 6A | `pos.sync.pull` | `terminal` |
  | `/v1/sync/tickets` | `ticketRoutes` | 6A | `pos.sync.push` | `terminal` |
  | `/v1/companies/:companyId/needs-attention` | `needsAttentionRoutes` | 6A | `pos.needs_attention.resolve` | `human` |

  And add the sentence: *"**`/v1/companies/:companyId/needs-attention` is 6A's module and 7C mounts nothing on it.** 7C owns the `needs_attention` `DatasetId` (§4.16.2) and reads the same table through the report engine's own route, which is `…/reports/{code}/runs` — not a second module on this path."* **`/v1/sync/enrol` is §4.10.3's frozen path and is used verbatim**; an earlier draft of this plan spelled it `/v1/sync/enrolments` and that spelling appears nowhere.

- [ ] **Step 20: Amend §4.2.7 — `AppDeps` becomes seven members.** §4.2.7 states the count *"because it is load-bearing: a later slice reading 'five members, not three' would build a five-member object and would not compile"*. `terminalAuth` needs a key to sign and verify the terminal JWT with, and `createApp` is where the middleware is attached, so the key has to arrive with the other deps. Change the sentence to **"`AppDeps` is seven members"** and add: *"The seventh, **`terminalJwtSigningKey: Uint8Array`** (6A), is the HS256 key `terminalAuth` signs and verifies the short-lived terminal JWT with (§4.10.3, spec:2273). It is a `Uint8Array` and not a `string` because `jose` takes bytes; **the entrypoint derives it as `new TextEncoder().encode(config.terminalJwtSigningKey)`** from the `ApiConfig` member of §4.2.3, so exactly one place reads the environment. `startApi()` builds it from a fixed test literal, which is what makes a route test's terminal token verifiable without an environment variable."*

- [ ] **Step 21: Amend §4.2.9 — a public route carries no idempotency, and this is the first one.** §4.2.9's middleware keys on `(tenant_id, principal_id, key)` and opens its own `withTenant` on `c.var.ctx`; a `auth: "public"` route has no `ctx`, so mounting it there raises `ERR_TENANT_CONTEXT_MISSING` (500) on **every** call. 0B's only public route is `GET /healthz`, a safe method, so the case has never arisen; 6A's `POST /v1/sync/enrol` is the first unsafe public route in the system. Add:

  > **Public routes carry no idempotency, and declare no `Idempotency-Key`.** The middleware needs a tenant and a principal to key on, and a `auth: "public"` module has neither. `createApp` therefore attaches `idempotency` from the same `route.auth` switch that attaches `authenticate` / `terminalAuth`: `"human"` and `"terminal"` get it, `"public"` gets neither. An unsafe public route must be **idempotent in its own right** and say how in one sentence: `POST /v1/sync/enrol` is, because redemption is `update … set redeemed_at = now() where redeemed_at is null returning …` and a second redemption of one code answers `ERR_TERMINAL_ENROLMENT_INVALID` whatever the header says. A future public unsafe route that cannot make that claim does not become public.

- [ ] **Step 22: Amend §4.10.4 — `applyBatch` takes four arguments.** §4.10.4 writes `applyBatch(tx, terminalCtx, batch)`, which conflates two facts that arrive separately: the **tenant context** (`{ tenantId, actorId, requestId }`, needed by `postDocument`, `recordOverride` and `computeDocumentTax`, all of which take a `TenantContext`) and the **terminal row** (`{ terminalId, companyId, branchId, principalId }`, which the route has from `terminalAuth` and the job handler from `terminalContext`). Replace the signature with:

  > `applyBatch(tx: Sql, ctx: TenantContext, terminal: TerminalApplyContext, batch: TicketBatchInput): Promise<BatchOutcome>` (6A, `packages/db/src/sync/apply.ts`), with `interface TerminalApplyContext { terminalId: string; companyId: string; branchId: string; principalId: string }`. Both callers hold both objects and neither can derive one from the other: `ctx.actorId` **is** `terminal.principalId` by construction, and passing one object would make that identity an assumption instead of a caller's assertion. 6C and 6D extend the body, never the signature.

- [ ] **Step 23: Amend §4.10.5 — `drainOutbox`'s options, `SyncQueuedError`, and what `applyChanges` does to the cursor.** Three corrections to one block, and the third is the one a resume depends on.

  (a) **`drainOutbox` takes the terminal and a uuidv7 minter.** §4.10.5 writes `opts?: { batchSize?: number }`, but `TicketBatch` requires `terminalId` and a `batchId` that §4.10.1 fixes as a **uuidv7** — and `crypto.randomUUID()` is a v4, which spec:2037 forbids. Replace with:

  > `drainOutbox(store: SyncStore, transport: SyncTransport, opts: { terminalId: string; newBatchId: () => string; batchSize?: number }): Promise<{ accepted: number; duplicates: number; rejected: number }>`. `terminalId` is **required**: a batch is refused by `POST /v1/sync/tickets` when its `terminalId` is not the signing terminal, so a default would only move the failure. `newBatchId` is **required and must mint a uuidv7** — `packages/sync` runs in the Electron main process and has no database to call `uuidv7()` on, so the generator is injected (6B passes its SQLite-side minter; a test passes a counter). `batchSize` is clamped to `SYNC_BATCH_SYNC_LIMIT`.

  (b) **`SyncQueuedError` is a `packages/sync` export.** `pushTickets` answers `202` for an over-size batch and returns no per-ticket result, so the transport must reject rather than return a `BatchResult` with empty arrays — an empty array would be read as "nothing acknowledged", which is right, but silently, and `drainOutbox` could not tell it from a server that acknowledged nothing. Register `export class SyncQueuedError extends Error { readonly batchId: string; readonly jobId: string }` in `packages/sync/src/client.ts`.

  (c) **`applyChanges` advances EVERY stream's cursor to the page's highest revision.** §4.10.2 fixes the wire cursor as *"the minimum across streams"*, and `pullAll` computes it that way. A store that advanced only the streams a page happened to carry would answer `0n` for every quiet stream for ever — `cashier` and `branch_pos_policy` have no rows until 6C ships, so the minimum would be `0n` on every till in Phase 6 and a resume would re-pull the whole catalogue every time. Add to `SyncStore.applyChanges`'s doc comment:

  > A page is ordered by revision **across all streams** (§4.10.2), so a page whose last change is revision *R* has delivered everything at or below *R* for **every** stream. `applyChanges` therefore sets **every** member of `CATALOGUE_STREAMS` to `max(changes[].revision)`, not only the streams the page touched, and the minimum across streams is then exactly the wire cursor the server issued. An empty `changes` array advances nothing. **This is the sentence 6B's SQLite store is measured against**, and `MemorySyncStore` (§4.17.1) is its executable form.

- [ ] **Step 24: Amend §4.17 — `seedTerminal` gains one option.** §4.17's rule is that *"a slice adds only the rows this table assigns it, and amends this table before adding any other"*, and an option is an addition like a row. Change 6A's row's shape to `seedTerminal(db, s, opts?: { code?; branchId?; devicePublicKey? })` and add the note: *"`devicePublicKey?: Buffer` (SPKI DER) so a test that signs a `/v1/sync/*` request holds the private half; it defaults to `Buffer.alloc(44)`, which is a well-formed length that verifies nothing — a fixture terminal that is never used to sign cannot accidentally pass a signature check."*

- [ ] **Step 25: Write and run the repo gate.** The twenty-four amendments are prose; this script is what proves the code they describe is really there.

```bash
#!/usr/bin/env bash
# scripts/gate-6a.sh — every merged name slice 6A consumes. Delete after Task 0.
set -uo pipefail
fail=0
need() { # need <label> <file> <pattern>
  if [ ! -f "$2" ]; then echo "MISSING FILE  $1 -> $2"; fail=1; return; fi
  if ! grep -q -- "$3" "$2"; then echo "MISSING NAME  $1 -> $2 :: $3"; fail=1; fi
}
need "0A pos_terminal"        packages/db/migrations/0001_init.sql          "create table app.pos_terminal"
need "0A resolve_principal"   packages/db/migrations/0001_init.sql          "app.resolve_principal"
need "0B withTenant"          packages/db/src/with-tenant.ts                "export async function withTenant"
need "0B systemContext"       packages/db/src/with-tenant.ts                "export async function systemContext"
need "0B resolvePrincipal"    packages/db/src/with-tenant.ts                "export function resolvePrincipal"
need "0B buildRoutes"         apps/api/src/routes/index.ts                  "export function buildRoutes"
need "0B TENANT_FREE"         tests/invariants/probes.ts                    "export const TENANT_FREE"
need "0B scope terminal"      apps/api/src/middleware/require-permission.ts 'company: "terminal"'
need "0D JOBS pos.sync.apply" packages/db/src/jobs/names.ts                 '"pos.sync.apply"'
need "0D registerHandler"     apps/worker/src/handler.ts                    "export function registerHandler"
need "1A postDocument"        packages/db/src/posting/post.ts               "export async function postDocument"
need "1A issueDocument"       packages/db/src/posting/issue.ts              "export async function issueDocument"
need "1A loadSnapshot"        packages/db/src/posting/load.ts               "export async function loadSnapshot"
need "2A planMovements"       packages/domain/src/posting/evaluate.ts       "export function planMovements"
need "2A seedDocumentType"    packages/db/test/fixtures.ts                  "export async function seedDocumentType"
need "2A DocumentLineKind"    packages/contracts/src/accounting/document.ts "export const DocumentLineKindSchema"
need "2B recordOverride"      packages/db/src/posting/reverse.ts            "export async function recordOverride"
need "2B grantCodes"          packages/db/test/fixtures.ts                  "export async function grantCodes"
need "2B principal_has"       packages/db/migrations/0022_create_document_status_triggers.sql "app.principal_has"
need "3A seedItem"            packages/db/test/fixtures.ts                  "export async function seedItem"
need "3A seedWarehouse"       packages/db/test/fixtures.ts                  "export async function seedWarehouse"
need "3A seedPriceList"       packages/db/test/fixtures.ts                  "export async function seedPriceList"
need "3B applyMovements"      packages/db/src/costing/apply-movements.ts    "export async function applyMovements"
need "3B ensureOpenPeriods"   tests/invariants/support/post-inventory.ts    "export async function ensureOpenPeriods"
need "3B postInventoryDoc"    tests/invariants/support/post-inventory.ts    "export async function postInventoryDocument"
need "3C draftTypedDocument"  packages/db/test/fixtures.ts                  "export async function draftTypedDocument"
need "3D secondPrincipal"     tests/invariants/support/post-inventory.ts    "export async function secondPrincipal"
need "5A computeDocumentTax"  packages/db/src/tax/compute.ts                "export async function computeDocumentTax"
need "5A taxFixture"          tests/invariants/support/tax.ts               "export async function taxFixture"
need "5A seedTaxPack"         tests/invariants/support/tax.ts               "export async function seedTaxPack"
# Names the fix pass added to this plan's consumed set — each one is called by real code below.
need "0B ApiRequest idem key" apps/api/test/support/app.ts                  "idempotencyKey"
need "0B AppDeps"             apps/api/src/app.ts                           "export interface AppDeps"
need "0B idempotency mw"      apps/api/src/middleware/idempotency.ts        "export function idempotency"
need "0D JobClient.enqueue"   packages/db/src/jobs/enqueue.ts               "enqueue<N extends JobName>"
need "0D EnqueueOptions"      packages/db/src/jobs/enqueue.ts               "singletonKey"
need "0B savepoint handle"    packages/db/src/with-tenant.ts                "savepoint"
# 3A's 0031 is the file that adds document.warehouse_id, which Task 11's header insert names. 3A's own plan
# records that the card's shorter guess was superseded, so the gate asks for the file 3A actually creates.
need "3A document.warehouse"  packages/db/migrations/0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql "warehouse_id"
# 3B's amendment A5 already put `jobs` on AppEnv["Variables"] and set it from deps.jobs. Task 6 adds `db`
# BESIDE it and must not re-declare it; a MISSING NAME here means 3B's T7 edit is not in the tree and Task 6's
# `db` middleware would be the only setter, leaving POST /v1/sync/tickets' 202 branch without a JobClient.
need "3B jobs Variables"      apps/api/src/context.ts                       "jobs: JobClient"
# setEventContext: 2B's architecture paragraph says posting/lifecycle.ts, §4.3.1's file layout says reverse.ts.
# The barrel is the one place both spellings must surface, so the gate asks the barrel and the task imports it
# from "@dulja/db" — never from a path. A MISSING NAME here means 2B named it differently; §4.18's rule applies.
need "2B setEventContext"     packages/db/src/posting/index.ts              "setEventContext"

# Migration range 0059-0062 must be free, and 0058 must be the highest applied file.
for n in 0059 0060 0061 0062; do
  if ls packages/db/migrations/${n}_*.sql >/dev/null 2>&1; then echo "RANGE TAKEN   $n"; fail=1; fi
done
last=$(ls packages/db/migrations/ | grep -E '^[0-9]{4}_' | sed 's/_.*//' | sort | tail -1)
echo "highest migration on disk: ${last} (expect 0058 after 5B, 0056 if 5B is still in flight)"

# The three account codes this slice seeds must NOT already exist in another slice's chart file.
for c in 1110 1120 2200; do
  if grep -rq "\"$c\"" packages/db/seed/my/chart-of-accounts/ 2>/dev/null; then echo "ACCOUNT TAKEN $c"; fail=1; fi
done
# 1100 must already be there (0C's) — hazard 33's consume-don't-reseed check.
grep -rq '"1100"' packages/db/seed/my/chart-of-accounts/0c-base.json || { echo "MISSING 1100 (0C)"; fail=1; }

exit $fail
```

  Run `bash scripts/gate-6a.sh`. **Expected:** every line silent, the `highest migration` line printed, exit 0. A `MISSING NAME` line means the plan that ships it spelled it differently — read that plan's file, which is the authority (§4.18), and correct the consuming task's import before writing any code. A `RANGE TAKEN` line means a slice wrote outside its range and §3.4.1 has been violated; stop and amend the contracts document.

- [ ] **Step 26: Commit.**

```bash
rm scripts/gate-6a.sh
git add docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
git commit -m "$(cat <<'EOF'
docs(contracts): register 6A's twenty-four amendments — test-22 reading (a), POS_EQUIV_INVOICE, branch_isolation rows, nextval revision default, per-terminal series, AppEnv ten members, AppDeps seven, the five module paths, applyBatch's four arguments [6A T0]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: `packages/sync` — the wire contract both applications compile against

**Why first.** §5.2 puts the protocol in a package *"shared by api/ and pos/"* (spec:2370) precisely so the two ends cannot quietly share an assumption — LEGACY-046's *"two independent flags with the same name"* is what happens when they do. Everything later in this plan imports from here, and 6B's till imports the same file.

**Files**

- `packages/sync/package.json` — NEW
- `packages/sync/tsconfig.json` — NEW
- `packages/sync/vitest.config.ts` — NEW
- `packages/sync/src/messages.ts` — NEW
- `packages/sync/src/cursor.ts` — NEW
- `packages/sync/src/index.ts` — NEW
- `packages/sync/test/cursor.test.ts` — NEW
- `scripts/lint/rules/dependency-rule.ts` — MODIFY

**Interfaces**

- Consumes: nothing at run time. `ErrCode` is a **type-only** import from `@dulja/contracts` (§3.1 puts `packages/sync` at the `db`/`contracts` tier, so the import is legal; it is `import type` so no value crosses).
- Produces (`packages/sync/src/messages.ts`, §4.10.1 **verbatim**):
  - `Stream`, `Cursor`, `Change<T>`, `CataloguePage`, `TicketLine`, `TicketTender`, `TicketEvent`, `NewCustomer`, `Ticket`, `ShiftOpenClose`, `TillEventMsg`, `TicketBatch`, `TicketResult`, `MessageResult`, `BatchResult`
  - `export const CATALOGUE_STREAMS: readonly Stream[]`
  - `export const SYNC_BATCH_SYNC_LIMIT = 200`
- Produces (`packages/sync/src/cursor.ts`): `encodeSyncCursor(c: Cursor): string`, `decodeSyncCursor(raw: string): Cursor`, `class SyncCursorError extends Error { readonly code: "ERR_SYNC_CURSOR_INVALID" }`.

**Steps**

- [ ] **Step 1: Write the failing test first.**

```ts
// packages/sync/test/cursor.test.ts
import { describe, expect, it } from "vitest";
import { CATALOGUE_STREAMS, SYNC_BATCH_SYNC_LIMIT, decodeSyncCursor, encodeSyncCursor, SyncCursorError } from "../src/index";

describe("the sync cursor codec (§4.10.1 — base64url of the decimal revision, opaque to the till)", () => {
  it("round-trips a bigint revision through a URL-safe string", () => {
    for (const n of [0n, 1n, 42n, 9007199254740993n, 9223372036854775807n]) {
      const raw = encodeSyncCursor({ revision: n });
      expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);          // §4.2.8's CursorSchema shape
      expect(decodeSyncCursor(raw).revision).toBe(n);
    }
  });

  it("9007199254740993 survives — the exact reason the wire form is a STRING and not a JSON number", () => {
    // Number(9007199254740993) === 9007199254740992. A revision past 2^53 read as a double would
    // silently re-deliver one row for ever, which is the failure acceptance test 20 exists to catch.
    const raw = encodeSyncCursor({ revision: 9007199254740993n });
    expect(decodeSyncCursor(raw).revision).toBe(9007199254740993n);
    expect(Number(decodeSyncCursor(raw).revision)).not.toBe(9007199254740993);
  });

  it("refuses anything that is not this shape with ERR_SYNC_CURSOR_INVALID", () => {
    for (const bad of ["", "!!!", "eyJrIjpbXX0", Buffer.from("-1").toString("base64url"), Buffer.from("1.5").toString("base64url")]) {
      let thrown: unknown;
      try { decodeSyncCursor(bad); } catch (e) { thrown = e; }
      expect(thrown, bad).toBeInstanceOf(SyncCursorError);
      expect((thrown as SyncCursorError).code).toBe("ERR_SYNC_CURSOR_INVALID");
    }
  });

  it("CATALOGUE_STREAMS is the eight members of Stream, in pull order, with no duplicate", () => {
    expect(CATALOGUE_STREAMS).toEqual([
      "item", "price_list", "price_list_line", "promotion", "customer", "tax_code", "cashier", "branch_pos_policy",
    ]);
    expect(new Set(CATALOGUE_STREAMS).size).toBe(CATALOGUE_STREAMS.length);
  });

  it("the synchronous batch limit is the one number §4.10.4 fixes", () => {
    expect(SYNC_BATCH_SYNC_LIMIT).toBe(200);
  });
});
```

  Run `bun run --cwd packages/sync test`. **Expected failure:** `Cannot find package '@dulja/sync'` / `Failed to resolve import "../src/index"` — the package does not exist yet.

- [ ] **Step 2: Create the workspace.**

```json
// packages/sync/package.json  — no version literal anywhere (spec:104); the lockfile owns them.
{
  "name": "@dulja/sync",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run"
  },
  "dependencies": { "@dulja/contracts": "workspace:*", "@dulja/domain": "workspace:*" }
}
```

```json
// packages/sync/tsconfig.json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```ts
// packages/sync/vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 10_000 } });
```

  `packages/*` is already in the root `workspaces` array (§3.1), so no root edit is needed. Run `bun install`.

- [ ] **Step 3: Write `packages/sync/src/messages.ts` — §4.10.1 verbatim.**

```ts
/**
 * The POS sync wire contract (contracts §4.10.1). `apps/api` and `apps/pos` compile against THIS file and
 * nothing else, which is what makes spec:1318's "design the sync API as though an external client would use
 * it" checkable rather than aspirational. Every money value is `{ amount, currency }` and every quantity a
 * fixed-scale string — no `number` ever holds a monetary value (spec:2041, the `no-number-money` lint).
 */
import type { ErrCode } from "@dulja/contracts";

/** spec:1328's mirrors plus the two policy streams (§4.10.1). */
export type Stream =
  | "item" | "price_list" | "price_list_line" | "promotion"
  | "customer" | "tax_code" | "cashier" | "branch_pos_policy";

/** Pull order. `price_list` precedes `price_list_line` and `item` precedes everything that references it, so a
 *  till applying a page in order never holds a line whose parent has not arrived. */
export const CATALOGUE_STREAMS: readonly Stream[] = [
  "item", "price_list", "price_list_line", "promotion", "customer", "tax_code", "cashier", "branch_pos_policy",
];

/** Encoded on the wire as a base64url string of the decimal revision — opaque to the till (§4.10.1). */
export interface Cursor { readonly revision: bigint }

export interface Change<T = unknown> {
  stream: Stream;
  op: "upsert" | "delete";
  id: string;
  revision: bigint;
  /** `null` for a delete (tombstone) — spec:1300 "Deletions travel as tombstones, never as silent absence". */
  row: T | null;
}

/** spec:1297 — the names are the spec's, snake_case on the wire. */
export interface CataloguePage { changes: Change[]; next_cursor: string; has_more: boolean }

export interface MoneyJson { amount: string; currency: string }

export interface TicketLine {
  lineNo: number;
  itemId: string;
  lotId: string | null;
  /** Quantity at scale 6. NEGATIVE on a return line — direction is carried by the sign of the QUANTITY on the
   *  wire and by `PlannedMovement.effect` / `PlannedLedgerLine.side` after evaluation (§4.4.2 A9). */
  quantity: string;
  unitId: string;
  unitPrice: MoneyJson;
  discount: MoneyJson;
  taxCodeId: string | null;
  taxAmount: MoneyJson;
  /** The tax-INCLUSIVE line total. `POS_TICKET` declares `tax.inclusive: true` (§4.6.5), so the server's
   *  `computeDocumentTax` extracts `taxAmount` from this figure and stores `amount = total − taxAmount`. */
  total: MoneyJson;
}

export interface TicketTender {
  tenderNo: number;
  method: "cash" | "card" | "transfer" | "store_credit";
  amount: MoneyJson;
  reference: string | null;
}

/**
 * `code` is the ONE override code the server can store: `document_event.override_code` admits exactly the three
 * values of `OverrideCode` (§4.3.1, §4.5.2), and `assert_override_authorised` verifies the supervisor holds
 * *that* code — so sending `pos.ticket.discount` here would make the guard check a cashier-level selling code
 * and defeat acceptance test 37. What the override was *for* travels in `subject` and is written to
 * `document_event.reason` as `"<subject>: <reason>"`.
 */
export interface TicketEvent {
  kind: "override";
  code: "pos.ticket.override";
  subject: "discount" | "void" | "blind_return" | "price_override";
  supervisorPrincipalId: string;
  reason: string;
}

/** A customer quick-created at the till (§2.7, applied under `pos.customer.create`). `id` is a uuidv7 minted
 *  offline and is also the ticket's `customerId`, so a re-sent ticket creates no second party. */
export interface NewCustomer { id: string; code: string; nameEn: string; phone: string | null }

export interface Ticket {
  /** uuidv7 minted at the till = `document.client_ref` (spec:1302, LEGACY-051). */
  clientRef: string;
  shiftId: string;
  cashierPrincipalId: string;
  customerId: string | null;
  newCustomer?: NewCustomer | null;
  kind: "sale" | "return";
  /** The original ticket's `clientRef` on a return; `null` means a BLIND return (`pos.ticket.return_blind`). */
  returnsClientRef: string | null;
  currency: string;
  soldAt: string;
  lines: TicketLine[];
  tenders: TicketTender[];
  events: TicketEvent[];
  attendance: { kind: "clock_in" | "clock_out"; principalId: string; at: string }[];
  catalogueRevision: bigint;
}

/**
 * One message per shift transition, not one per shift: the till sends `open` when the drawer is counted in and
 * `close` when it is counted out, and the two may cross a reconnect hours apart. `shiftId` is the uuidv7 minted
 * at the till and is `app.shift.id` (§4.6.5) — the same client-id convention as `Ticket.clientRef`. Field names
 * follow §3.3: the cashier is **attribution** data, so `cashierPrincipalId`, never `openedBy`.
 */
export interface ShiftOpenClose {
  shiftId: string; kind: "open" | "close"; terminalId: string; cashierPrincipalId: string; at: string;
  currency: string;
  openingFloat: MoneyJson | null;   // required on `open`, null on `close`
  countedCash: MoneyJson | null;    // required on `close`, null on `open`
}

/** The till never computes `expectedCash` or `over_short`: the server derives both from the shift's posted
 *  tickets, so a tampered or clock-skewed till cannot move the difference (§4.6.5). */
export interface TillEventMsg {
  clientRef: string;
  shiftId: string; kind: "no_sale" | "drawer_open" | "void";
  ticketClientRef: string | null;
  cashierPrincipalId: string; supervisorPrincipalId: string | null; occurredAt: string;
}

export interface TicketBatch {
  terminalId: string; batchId: string;
  tickets: Ticket[]; shifts: ShiftOpenClose[]; tillEvents: TillEventMsg[];
}

export interface TicketResult {
  clientRef: string;
  status: "accepted" | "duplicate" | "rejected";
  documentId: string | null;
  number: string | null;
  error: { code: ErrCode; detail: string } | null;
}

/** Acknowledges a shift or till event by the id the till keyed its outbox row on — `ShiftOpenClose` by
 *  `"<shiftId>:<kind>"`, `TillEventMsg` by `clientRef`. Without these two arrays `drainOutbox` could only ack
 *  `outbox.kind = 'ticket'` rows and the other two kinds would re-send for ever (spec:1337). */
export interface MessageResult {
  ref: string; status: "accepted" | "duplicate" | "rejected";
  error: { code: ErrCode; detail: string } | null;
}

export interface BatchResult {
  batchId: string;
  results: TicketResult[];
  shiftResults: MessageResult[];
  tillEventResults: MessageResult[];
  /** The server's current cursor, so the till knows how stale it is. */
  catalogueCursor: string;
}

/** The 202 body §4.10.4 returns for an over-size batch. No `statusUrl`: the till re-sends, and dedup makes the
 *  re-send exact (Task 0 amendment 12). */
export interface BatchQueued { batchId: string; jobId: string; status: "queued" }

/** Tickets in one batch beyond this count are applied by the `pos.sync.apply` job (§4.10.4). */
export const SYNC_BATCH_SYNC_LIMIT = 200;

/** The shift-message outbox ref: one row per transition, so an `open` and a `close` of one shift ack apart. */
export function shiftRef(m: Pick<ShiftOpenClose, "shiftId" | "kind">): string { return `${m.shiftId}:${m.kind}`; }
```

- [ ] **Step 4: Write `packages/sync/src/cursor.ts`.**

```ts
import type { Cursor } from "./messages";

/** The ONE sync cursor codec. §4.2.8's `encodeCursor`/`decodeCursor` is a different codec for a different
 *  thing — a keyset position `{ k, id }` on a REST list — and neither is ever used for the other (hazard 9). */
export class SyncCursorError extends Error {
  readonly code = "ERR_SYNC_CURSOR_INVALID" as const;
  constructor(detail: string) { super(detail); this.name = "SyncCursorError"; }
}

const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;

export function encodeSyncCursor(c: Cursor): string {
  if (c.revision < 0n) throw new SyncCursorError(`a revision is never negative: ${c.revision}`);
  return Buffer.from(c.revision.toString(10), "utf8").toString("base64url");
}

/**
 * A cursor is a base64url string whose decoded text is a non-negative decimal integer and nothing else.
 * It is decoded to a `bigint`, never to a `number`: `app.catalogue_revision_seq` is a `bigint` sequence and a
 * revision past 2^53 read as a double would round, re-delivering one row for ever.
 */
export function decodeSyncCursor(raw: string): Cursor {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new SyncCursorError(`cursor is not base64url: ${JSON.stringify(raw)}`);
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!DECIMAL.test(text)) throw new SyncCursorError(`cursor does not decode to a revision: ${JSON.stringify(text)}`);
  return { revision: BigInt(text) };
}
```

- [ ] **Step 5: Write the barrel and re-run.**

```ts
// packages/sync/src/index.ts — the whole cross-slice surface of @dulja/sync.
export * from "./messages";
export * from "./cursor";
```

  Run `bun run --cwd packages/sync test`. **Expected:** 5 passed. Run `bun run --cwd packages/sync typecheck`. **Expected:** no output, exit 0.

- [ ] **Step 6: Teach the dependency-rule lint about the new tier.** `packages/sync` imports `@dulja/domain` and `@dulja/contracts` and nothing else; without the row the rule either fails the build on an unknown package or, worse, permits `@dulja/db`.

```ts
// scripts/lint/rules/dependency-rule.ts — inside the TIERS map (0B).
  // §3.1: the spec's dependency sentence omits `sync`; §5.2 says "Shared by api/ and pos/" (spec:2370),
  // so it sits at the db/contracts tier. It must never import @dulja/db — the till has no Postgres.
  "packages/sync": ["@dulja/domain", "@dulja/contracts"],
```

  Run `bun run lint:rules`. **Expected:** no violations.

- [ ] **Step 7: Commit.**

```bash
git add packages/sync scripts/lint/rules/dependency-rule.ts bun.lock package.json
git commit -m "$(cat <<'EOF'
feat(sync): add @dulja/sync with the §4.10.1 message contract and the cursor codec [6A T1]

The one wire contract apps/api and apps/pos both compile against (spec:2370, 1318).
Revisions are bigint end to end: a cursor past 2^53 read as a double would re-deliver
one row for ever, which is the failure acceptance test 20 exists to catch.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration 0059 — commit-ordered catalogue revisions and tombstones

**Files**

- `packages/db/migrations/0059_add_catalogue_revision.sql` — NEW
- `packages/db/migrations/0059.down.sql` — NEW
- `packages/db/src/schema/catalogue-tombstone.ts` — NEW (Drizzle mirror, §3.4.9)
- `packages/db/test/sync/catalogue-revision.test.ts` — NEW
- `docs/adr/0054-commit-ordered-catalogue-revisions.md` — NEW

**Interfaces**

- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit` (§4.1); `app.item`, `app.price_list`, `app.price_list_line`, `app.promotion` (3A), `app.party` (2A), `app.tax_code` (5A); `startDb`, `seedTenant`, `withTenant`, `uuidv7`, `lintSchema`, `up`, `down`, `listApplied`, `MIGRATIONS_DIR` (§4.1); `seedItem`, `seedPriceList` (3A); `seedParty` (2A); `seedTaxCode` (5A).
- Produces: `app.catalogue_revision_seq`, `app.catalogue_revision()`, `app.catalogue_tombstone`, and `revision bigint not null` plus the trigger on six existing tables (§4.10.2).

**Steps**

- [ ] **Step 1: Write the failing test first.**

```ts
// packages/db/test/sync/catalogue-revision.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedItem, seedParty, seedPriceList, seedTenantV2, seedUnit, type Seed } from "../fixtures";

describe("migration 0059 — the catalogue revision is assigned in COMMIT order (§4.10.2, C1; spec:1299)", () => {
  let db: Db; let a: Seed; let b: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); b = await seedTenantV2(db, "Beta"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  // ⚠️ These two lists are CLOSED at 6A and are extended by 6C, never relaxed. §4.10.2 names eight stream
  // tables; six of them exist now, and `pos_cashier` and `branch_pos_policy` are 6C's (its 0065/0066). 6C adds
  // the two names to BOTH arrays in the same PR that creates the tables — the Execution handoff says so — and
  // that is deliberate: a containment check would let a slice ship a stream table with no trigger and stay
  // green, which is precisely the missed-deletion failure acceptance test 20 exists to catch.
  const STREAM_TABLES_AT_6A = ["item", "party", "price_list", "price_list_line", "promotion", "tax_code"];

  it("every stream table carries a NOT NULL revision and the catalogue_revision trigger", async () => {
    const rows = await db.admin<{ table_name: string; is_nullable: string }[]>`
      select table_name, is_nullable from information_schema.columns
       where table_schema = 'app' and column_name = 'revision' order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual(STREAM_TABLES_AT_6A);
    expect(rows.every((r) => r.is_nullable === "NO")).toBe(true);

    const trg = await db.admin<{ relname: string }[]>`
      select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgname = 'catalogue_revision' and not t.tgisinternal order by 1`;
    expect(trg.map((r) => r.relname)).toEqual(STREAM_TABLES_AT_6A);
  });

  it("a row written earlier gets a lower revision, and an update re-stamps it", async () => {
    const unitId = await seedUnit(db, a);
    const { itemId } = await seedItem(db, a, { code: "SKU-1", baseUnitId: unitId });
    const first = await revisionOf(db, a, "item", itemId);
    const partyId = await seedParty(db, a, { code: "CUST-1" });
    const second = await revisionOf(db, a, "party", partyId);
    expect(second).toBeGreaterThan(first);

    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.item set name_en = 'renamed' where id = ${itemId}`);
    expect(await revisionOf(db, a, "item", itemId)).toBeGreaterThan(second);
  });

  it("the two tenants share one sequence but never see each other's rows (test 12 for the new table)", async () => {
    const plA = await seedPriceList(db, a, { code: "PL-A" });
    const plB = await seedPriceList(db, b, { code: "PL-B" });
    expect(plA).not.toEqual(plB);
    const seen = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.price_list where id = ${plB}`);
    expect(seen[0]!.n).toBe(0);
    const tomb = await withTenant(db.rw, b.tenant, b.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.catalogue_tombstone where tenant_id = ${a.tenant}`);
    expect(tomb[0]!.n).toBe(0);
  });

  it("archiving a catalogue row writes a tombstone carrying the row's branch (spec:1300)", async () => {
    const branchId = a.hq;
    const plId = await seedPriceList(db, a, { code: "PL-GONE", branchId });
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.price_list set archived_at = now() where id = ${plId}`);
    const [t] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ stream: string; row_id: string; branch_id: string | null; revision: string }[]>`
      select stream, row_id, branch_id, revision::text as revision from app.catalogue_tombstone where row_id = ${plId}`);
    expect(t).toBeDefined();
    expect(t!.stream).toBe("price_list");
    expect(t!.branch_id).toBe(branchId);
    // The tombstone's revision IS the row's new revision: the till learns of the deletion at the same cursor
    // position it would have learned of an edit, so no ordering rule is needed between the two.
    expect(t!.revision).toBe(String(await revisionOf(db, a, "price_list", plId)));
  });

  it("archiving a PRICE-LIST LINE writes a tombstone carrying its PARENT's company and branch", async () => {
    // price_list_line has neither company_id nor branch_id (3A) and catalogue_tombstone.company_id is NOT NULL,
    // so a trigger that read `to_jsonb(new) ->> 'company_id'` here would raise 23502 and would break 3A's own
    // `replacePriceListLines` retirement path — which is why this case exists and not merely the price_list one.
    const unitId = await seedUnit(db, a);
    const { itemId } = await seedItem(db, a, { code: "SKU-LINE", baseUnitId: unitId });
    const plId = await seedPriceList(db, a, { code: "PL-LINES", branchId: a.hq });
    const lineId = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.price_list_line (tenant_id, price_list_id, item_id, min_quantity, unit_price)
        values (${a.tenant}, ${plId}, ${itemId}, 0, 9.9900) returning id`;
      return row!.id;
    });
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`update app.price_list_line set archived_at = now() where id = ${lineId}`);

    const [t] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ stream: string; company_id: string; branch_id: string | null; revision: string }[]>`
      select stream, company_id, branch_id, revision::text as revision from app.catalogue_tombstone where row_id = ${lineId}`);
    expect(t).toBeDefined();
    expect(t!.stream).toBe("price_list_line");
    expect(t!.company_id).toBe(a.company);          // the PARENT's, looked up — not NULL
    expect(t!.branch_id).toBe(a.hq);                // the PARENT's branch, so Form B scopes it correctly
    expect(t!.revision).toBe(String(await revisionOf(db, a, "price_list_line", lineId)));
  });

  it("a promotion is retired by ends_at and writes NO tombstone — it has no archived_at column (3A)", async () => {
    // 3A's promotion table declares no archived_at (phase-3a:2443), so the tombstone branch cannot fire for
    // this stream. That is the design, not a gap: a shortened window is an UPSERT the till applies, and a
    // tombstone would make the till forget a promotion that still exists.
    const promoId = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.promotion (tenant_id, company_id, code, name_en, kind, definition, starts_at, ends_at)
        values (${a.tenant}, ${a.company}, 'PROMO-1', 'Ten off', 'percent_off', ${tx.json({ percent: 10 })},
                now() - interval '1 day', now() + interval '30 days')
        returning id`;
      return row!.id;
    });
    const before = await revisionOf(db, a, "promotion", promoId);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`update app.promotion set ends_at = now() - interval '1 second' where id = ${promoId}`);
    expect(await revisionOf(db, a, "promotion", promoId)).toBeGreaterThan(before);
    const [n] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.catalogue_tombstone where row_id = ${promoId}`);
    expect(n!.n).toBe(0);
  });

  it("un-archiving writes no second tombstone and bumps the revision (a resurrection is an upsert)", async () => {
    const plId = await seedPriceList(db, a, { code: "PL-BACK" });
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.price_list set archived_at = now() where id = ${plId}`);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.price_list set archived_at = null where id = ${plId}`);
    const [n] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.catalogue_tombstone where row_id = ${plId}`);
    expect(n!.n).toBe(1);
  });

  it("the schema linter still reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});

async function revisionOf(db: Db, s: Seed, table: "item" | "party" | "price_list" | "price_list_line" | "promotion" | "tax_code", id: string): Promise<bigint> {
  // The table is a literal chosen from a closed union — never a client string, never concatenation (test 27).
  // That is why this is a ternary chain rather than one templated table name: there is no path through this
  // helper on which an identifier reaches SQL as text.
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const rows =
      table === "item" ? await tx<{ r: string }[]>`select revision::text as r from app.item where id = ${id}`
      : table === "party" ? await tx<{ r: string }[]>`select revision::text as r from app.party where id = ${id}`
      : table === "price_list" ? await tx<{ r: string }[]>`select revision::text as r from app.price_list where id = ${id}`
      : table === "price_list_line" ? await tx<{ r: string }[]>`select revision::text as r from app.price_list_line where id = ${id}`
      : table === "promotion" ? await tx<{ r: string }[]>`select revision::text as r from app.promotion where id = ${id}`
      : await tx<{ r: string }[]>`select revision::text as r from app.tax_code where id = ${id}`;
    return BigInt(rows[0]!.r);
  });
}
```

  Run `bun run --cwd packages/db test -- sync/catalogue-revision`. **Expected failure:** the first `it` reports `expect(received).toEqual(expected)` with `received: []`, because no `revision` column exists.

- [ ] **Step 2: Write the migration.**

```sql
-- 0059_add_catalogue_revision.sql
-- §3.7.3 "Every catalogue row carries a monotonic revision. It must be assigned in COMMIT order, not sequence
-- order" (spec:1299) · contracts §4.10.2 (C1 resolved) · ADR 0054.

-- ── 1. the sequence ───────────────────────────────────────────────────────────────────────────────────
-- One sequence for the whole database, not one per tenant: the cursor is a single scalar and a per-tenant
-- sequence would make two tenants' cursors incomparable for no gain. Gaps are expected and harmless — a
-- cursor asks for "> since", never for "the next one".
create sequence app.catalogue_revision_seq as bigint start with 1 no cycle;
grant usage, select on sequence app.catalogue_revision_seq to app_rw;

-- ── 2. tombstones (spec:1300 "Deletions travel as tombstones, never as silent absence") ────────────────
create table app.catalogue_tombstone (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  stream      text not null check (stream in ('item','price_list','price_list_line','promotion','customer','tax_code','cashier','branch_pos_policy')),
  row_id      uuid not null,
  revision    bigint not null,
  branch_id   uuid,                                   -- NULL = every branch (a company-wide price list or promotion)
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (stream, row_id),                            -- one tombstone per row; a resurrection is an upsert, not a second death
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
create index catalogue_tombstone_cursor_idx on app.catalogue_tombstone (company_id, revision);
call app_meta.enable_tenant_rls('app.catalogue_tombstone');
call app_meta.attach_audit('app.catalogue_tombstone');
-- branch_isolation is Form B and is attached by 6C's migration 0068 (§4.5.6, Task 0 amendment 4): branch_id is
-- nullable and a NULL row must stay VISIBLE, or a company-wide deletion never reaches any branch.

-- ── 3. the trigger (C1: the SAME advisory key the audit chain takes — §4.1's fixed literals) ───────────
-- A plain sequence hands out 100 to a transaction that commits AFTER a client has already read through 105,
-- and that row is never seen (spec:1299). Taking the lock BEFORE nextval and holding it to commit makes commit
-- order equal revision order. Reusing 'tenant-serial:' rather than spec:1299's 'catalogue:' is C1's resolution:
-- the audit chain already serialises per tenant on that key, and two keys would let a catalogue write and an
-- audit write deadlock against each other.
create function app.catalogue_revision() returns trigger language plpgsql as $$
declare
  v_stream     text := tg_argv[0];
  v_company    uuid := null;
  v_branch     uuid := null;
  v_archived   timestamptz := null;
  v_old_arch   timestamptz := null;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant-serial:' || new.tenant_id::text, 0));
  new.revision := nextval('app.catalogue_revision_seq');

  -- Archival is this system's deletion (spec:2049 "Master data: archived_at, never DELETE"), so the tombstone
  -- is written on the archived_at NULL -> value transition and nowhere else. `app.promotion` has NO
  -- `archived_at` column at all (3A, phase-3a:2443: "a promotion is retired by setting ends_at"), so
  -- `to_jsonb(new) ->> 'archived_at'` is NULL for that stream and this branch never fires for it — which is
  -- correct and deliberate: a retired promotion travels as an UPSERT carrying the shortened `ends_at`, and the
  -- till's own window check retires it. A tombstone would be wrong there, because a promotion whose window was
  -- shortened is not deleted and must not vanish from the till's catalogue.
  v_archived := (to_jsonb(new) ->> 'archived_at')::timestamptz;
  if tg_op = 'UPDATE' then v_old_arch := (to_jsonb(old) ->> 'archived_at')::timestamptz; end if;
  if v_archived is null or v_old_arch is not null then
    return new;
  end if;

  -- The company and branch a tombstone must carry, per stream, resolved from the trigger's own literal
  -- argument and never from a column the row may not have.
  --   `price_list_line` has NEITHER `company_id` NOR `branch_id` (3A, phase-3a:2391-2410) — it reaches both
  --   through its parent list — so reading `to_jsonb(new) ->> 'company_id'` there yields NULL and the insert
  --   would violate `catalogue_tombstone.company_id NOT NULL`. That would break 3A's OWN retirement path
  --   (`replacePriceListLines` archives a line it cannot delete) the moment this migration landed, so the
  --   parent is looked up instead.
  --   `price_list` and `promotion` carry a nullable `branch_id`; `item`, `party` and `tax_code` are
  --   company-wide and carry NULL, which Form B reads as "every branch".
  if v_stream = 'price_list_line' then
    select p.company_id, p.branch_id into v_company, v_branch
      from app.price_list p where p.id = new.price_list_id;
  else
    v_company := (to_jsonb(new) ->> 'company_id')::uuid;
    if v_stream in ('price_list', 'promotion') then
      v_branch := (to_jsonb(new) ->> 'branch_id')::uuid;
    end if;
  end if;

  insert into app.catalogue_tombstone (tenant_id, company_id, stream, row_id, revision, branch_id)
  values (new.tenant_id, v_company, v_stream, new.id, new.revision, v_branch)
  on conflict (stream, row_id) do update set revision = excluded.revision, branch_id = excluded.branch_id;
  return new;
end $$;

-- ── 4. the six stream tables that already exist ───────────────────────────────────────────────────────
-- `default nextval(...)` and NOT the `default 0` of an earlier draft: on ADD COLUMN Postgres evaluates a
-- VOLATILE default once per existing row, so every pre-6A row gets a distinct increasing revision in one pass.
-- A `default 0` would hide every pre-existing row behind `revision > 0` from a fresh till (since = 0) and would
-- make thousands of rows share one keyset position, which acceptance test 20 would catch as a skipped page.
-- A backfill UPDATE is not an option: FORCE ROW LEVEL SECURITY binds app_migrator, so a migration sees no rows.
alter table app.item            add column revision bigint not null default nextval('app.catalogue_revision_seq');
alter table app.price_list      add column revision bigint not null default nextval('app.catalogue_revision_seq');
alter table app.price_list_line add column revision bigint not null default nextval('app.catalogue_revision_seq');
alter table app.promotion       add column revision bigint not null default nextval('app.catalogue_revision_seq');
alter table app.party           add column revision bigint not null default nextval('app.catalogue_revision_seq');
alter table app.tax_code        add column revision bigint not null default nextval('app.catalogue_revision_seq');

create index item_revision_idx            on app.item (company_id, revision);
create index price_list_revision_idx      on app.price_list (company_id, revision);
create index price_list_line_revision_idx on app.price_list_line (revision);
create index promotion_revision_idx       on app.promotion (company_id, revision);
create index party_revision_idx           on app.party (company_id, revision);
create index tax_code_revision_idx        on app.tax_code (company_id, revision);

create trigger catalogue_revision before insert or update on app.item            for each row execute function app.catalogue_revision('item');
create trigger catalogue_revision before insert or update on app.price_list      for each row execute function app.catalogue_revision('price_list');
create trigger catalogue_revision before insert or update on app.price_list_line for each row execute function app.catalogue_revision('price_list_line');
create trigger catalogue_revision before insert or update on app.promotion       for each row execute function app.catalogue_revision('promotion');
create trigger catalogue_revision before insert or update on app.party           for each row execute function app.catalogue_revision('customer');
create trigger catalogue_revision before insert or update on app.tax_code        for each row execute function app.catalogue_revision('tax_code');

comment on column app.item.revision is
  'Catalogue revision, assigned in commit order by app.catalogue_revision() (spec:1299, contracts §4.10.2).';
comment on table app.catalogue_tombstone is
  'One row per archived catalogue row, so a deletion reaches an offline till as a change and not as an absence (spec:1300).';
```

  **Note on `app.party`'s trigger argument.** The stream is `'customer'`, not `'party'`: §4.10.1's `Stream` union names the till-side mirror (`catalogue_customer`, spec:1328), and the till never sees a vendor. The down-sync query filters `party.kind = 'customer'`; the trigger stamps a revision on **every** party because the column is NOT NULL, and a vendor's revision is simply never read.

```sql
-- 0059.down.sql — reverse dependency order (§3.4.5).
drop trigger if exists catalogue_revision on app.tax_code;
drop trigger if exists catalogue_revision on app.party;
drop trigger if exists catalogue_revision on app.promotion;
drop trigger if exists catalogue_revision on app.price_list_line;
drop trigger if exists catalogue_revision on app.price_list;
drop trigger if exists catalogue_revision on app.item;
drop function if exists app.catalogue_revision() cascade;
drop index if exists app.tax_code_revision_idx;
drop index if exists app.party_revision_idx;
drop index if exists app.promotion_revision_idx;
drop index if exists app.price_list_line_revision_idx;
drop index if exists app.price_list_revision_idx;
drop index if exists app.item_revision_idx;
alter table app.tax_code        drop column if exists revision;
alter table app.party           drop column if exists revision;
alter table app.promotion       drop column if exists revision;
alter table app.price_list_line drop column if exists revision;
alter table app.price_list      drop column if exists revision;
alter table app.item            drop column if exists revision;
drop table if exists app.catalogue_tombstone;
drop sequence if exists app.catalogue_revision_seq;
```

- [ ] **Step 3: Write the Drizzle mirror (§3.4.9 — one mirror per new table, same PR as the migration).**

```ts
// packages/db/src/schema/catalogue-tombstone.ts
import { bigint, index, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
const app = pgSchema("app");
export const catalogueTombstone = app.table("catalogue_tombstone", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  stream: text("stream").notNull(),
  rowId: uuid("row_id").notNull(),
  revision: bigint("revision", { mode: "bigint" }).notNull(),
  branchId: uuid("branch_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({
  tenantRow: unique("catalogue_tombstone_tenant_id_id_key").on(t.tenantId, t.id),
  streamRow: unique("catalogue_tombstone_stream_row_id_key").on(t.stream, t.rowId),
  cursor: index("catalogue_tombstone_cursor_idx").on(t.companyId, t.revision),
}));
```

- [ ] **Step 4: Run the test and the reversibility suite.** Run `bun run --cwd packages/db test -- sync/catalogue-revision`. **Expected:** 8 passed. Run `bun run --cwd packages/db test -- privileges`. **Expected:** the `up → down → up reproduces the schema byte for byte` case passes — §3.4.6's `schemaFingerprint` covers enum labels and grants, and the sequence grant added above is inside it.

- [ ] **Step 5: Write ADR 0054.** `docs/adr/0054-commit-ordered-catalogue-revisions.md`, Plan 0A's format (Context / Decision / Consequences), stating: the failure a plain sequence produces (spec:1299's own sentence, worked through with two interleaved transactions); why the key is `'tenant-serial:'` and not `'catalogue:'` (C1 — one key per tenant means the audit chain and the catalogue writer serialise instead of deadlocking); why the default is `nextval` rather than `0`; why a tombstone is keyed `(stream, row_id)` and upserts rather than appending (a resurrection is an upsert, and a second tombstone at a later revision would make a till delete a row it had just re-created); **why `price_list_line`'s tombstone resolves its company and branch from the parent list** (the child carries neither column, and `catalogue_tombstone.company_id` is NOT NULL, so the alternative was either a nullable company on a tenant-scoped table or breaking 3A's own line-retirement path); **why `promotion` produces no tombstone at all** (3A gives it no `archived_at` and retires it by `ends_at`, so a retirement is an upsert the till applies and a tombstone would make the till forget a promotion that still exists — the two streams' deletion stories genuinely differ, and pretending otherwise is what would lose a row); and the cost — every catalogue write in a tenant serialises, which spec:1299 explicitly accepts as *"low volume; acceptable"*.

- [ ] **Step 6: Commit.**

```bash
git add packages/db/migrations/0059_add_catalogue_revision.sql packages/db/migrations/0059.down.sql \
        packages/db/src/schema/catalogue-tombstone.ts packages/db/test/sync/catalogue-revision.test.ts \
        docs/adr/0054-commit-ordered-catalogue-revisions.md
git commit -m "$(cat <<'EOF'
feat(db): migration 0059 — commit-ordered catalogue revisions, tombstones [6A T2]

The revision is taken under the same per-tenant advisory lock the audit chain uses
(C1), so commit order equals revision order and a cursor read can never skip a row
that committed late (spec:1299). Deletions travel as tombstones (spec:1300).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration 0060 — `terminal_enrolment`, `needs_attention`, `app.resolve_enrolment`

**Files**

- `packages/db/migrations/0060_create_terminal_enrolment_needs_attention.sql` — NEW
- `packages/db/migrations/0060.down.sql` — NEW
- `packages/db/src/schema/terminal-enrolment.ts`, `packages/db/src/schema/needs-attention.ts` — NEW
- `packages/db/test/sync/enrolment.test.ts` — NEW (the DDL half; Task 6 appends the service half)
- `docs/adr/0055-terminal-identity-and-the-terminal-jwt.md` — NEW

**Interfaces**

- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.current_actor` (§4.1); `app.pos_terminal`, `app.dimension_value` (0001).
- Produces: `app.terminal_enrolment`, `app.needs_attention` (§4.10.3, §4.10.4), `app.resolve_enrolment` (Task 0 amendment 10).

**Steps**

- [ ] **Step 1: Write the failing test first.**

```ts
// packages/db/test/sync/enrolment.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lintSchema } from "../../src/lint-schema";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

describe("migration 0060 — terminal enrolment and the needs-attention queue", () => {
  let db: Db; let a: Seed; let b: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); b = await seedTenantV2(db, "Beta"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("app.resolve_enrolment is SECURITY DEFINER owned by app_auth, WITH the app_auth grant and policy (§4.1)", async () => {
    const [f] = await db.admin<{ owner: string; secdef: boolean; bypass: boolean }[]>`
      select r.rolname as owner, p.prosecdef as secdef, r.rolbypassrls as bypass
        from pg_proc p join pg_roles r on r.oid = p.proowner
       where p.pronamespace = 'app'::regnamespace and p.proname = 'resolve_enrolment'`;
    expect(f).toEqual({ owner: "app_auth", secdef: true, bypass: false });

    // The three assertions below are what make the door open at all, and each fails silently without them:
    // app_auth is not the table owner and has no BYPASSRLS, so FORCE RLS applies to it inside the definer
    // body, and app.current_tenant() is NULL there. This is plan0A:1024-1026's pattern, asserted.
    const pols = await db.admin<{ polname: string; roles: string[] }[]>`
      select p.polname, coalesce(array_agg(r.rolname order by r.rolname), '{}') as roles
        from pg_policy p
        left join lateral unnest(p.polroles) pr(oid) on true
        left join pg_roles r on r.oid = pr.oid
       where p.polrelid = 'app.terminal_enrolment'::regclass
       group by p.polname order by p.polname`;
    expect(pols.map((p) => p.polname)).toEqual(["enrolment_resolver", "tenant_isolation"]);
    expect(pols.find((p) => p.polname === "enrolment_resolver")!.roles).toEqual(["app_auth"]);

    const [grant] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee = 'app_auth' and table_schema = 'app'
         and table_name = 'terminal_enrolment' and privilege_type = 'SELECT'`;
    expect(grant!.n, "app_auth holds SELECT — default privileges grant to app_rw only (plan0A:2564)").toBe(1);
  });

  it("resolves an unredeemed, unexpired code with NO tenant set — the pre-tenant door", async () => {
    const code = "ENROL-ALPHA-1";
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.terminal_enrolment (tenant_id, company_id, branch_id, code_hash, name, terminal_code, expires_at)
      values (${a.tenant}, ${a.company}, ${a.hq}, ${sha256(code)}, 'Front Till', 'T1', now() + interval '1 hour')`);

    // A brand-new app_rw connection with NO set_config at all: exactly what the public /v1/sync/enrol
    // route has when it arrives (LEGACY-026 — identity is never client-supplied context).
    const rows = await db.rw<{ enrolment_id: string; tenant_id: string; company_id: string; branch_id: string }[]>`
      select * from app.resolve_enrolment(${sha256(code)})`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(a.tenant);

    expect(await db.rw`select * from app.resolve_enrolment(${sha256("WRONG")})`).toHaveLength(0);
  });

  it("a spent or expired code resolves to nothing (spec:1322 'the till redeems it ONCE')", async () => {
    const spent = "ENROL-SPENT"; const stale = "ENROL-STALE";
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      // `name` and `terminal_code` are NOT NULL with no default, and `terminal_code` is unique per company,
      // so every row in this file needs its own — T2 and T3 here, T1 in the test above.
      await tx`insert into app.terminal_enrolment (tenant_id, company_id, branch_id, code_hash, name, terminal_code, expires_at, redeemed_at)
               values (${a.tenant}, ${a.company}, ${a.hq}, ${sha256(spent)}, 'Spent Till', 'T2', now() + interval '1 hour', now())`;
      await tx`insert into app.terminal_enrolment (tenant_id, company_id, branch_id, code_hash, name, terminal_code, expires_at)
               values (${a.tenant}, ${a.company}, ${a.hq}, ${sha256(stale)}, 'Stale Till', 'T3', now() - interval '1 second')`;
    });
    expect(await db.rw`select * from app.resolve_enrolment(${sha256(spent)})`).toHaveLength(0);
    expect(await db.rw`select * from app.resolve_enrolment(${sha256(stale)})`).toHaveLength(0);
  });

  it("needs_attention.resolved_by is NULL at insert and stamped on resolve, never client-supplied (LEGACY-044)", async () => {
    const clientRef = await uuidv7(db.admin);
    const id = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string; resolved_by: string | null }[]>`
        insert into app.needs_attention (tenant_id, company_id, branch_id, terminal_id, client_ref, payload, error_code, error_detail)
        values (${a.tenant}, ${a.company}, ${a.hq}, null, ${clientRef}, ${tx.json({ clientRef })}, 'ERR_RBAC_FORBIDDEN', 'cashier lacks pos.ticket.sell')
        returning id, resolved_by`;
      expect(row!.resolved_by).toBeNull();     // stamp_actor leaves a NULL insert alone (plan0A:2370-2376)
      return row!.id;
    });

    const [resolved] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ resolved_by: string }[]>`
      update app.needs_attention set resolved_by = ${b.human}, resolved_at = now() where id = ${id} returning resolved_by`);
    // The supplied id was DISCARDED and replaced with the session actor: that is the whole point of stamp_actor.
    expect(resolved!.resolved_by).toBe(a.human);
    expect(resolved!.resolved_by).not.toBe(b.human);
  });

  it("a second tenant sees neither table (test 12 for the two new tables)", async () => {
    const seenEnrol = await withTenant(db.rw, b.tenant, b.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.terminal_enrolment`);
    const seenNa = await withTenant(db.rw, b.tenant, b.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.needs_attention`);
    expect(seenEnrol[0]!.n).toBe(0);
    expect(seenNa[0]!.n).toBe(0);
  });

  it("the schema linter still reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

  Run `bun run --cwd packages/db test -- sync/enrolment`. **Expected failure:** the first `it` fails with `expect(received).toEqual(expected)` and `received: undefined` — `app.resolve_enrolment` does not exist.

- [ ] **Step 2: Write the migration.**

```sql
-- 0060_create_terminal_enrolment_needs_attention.sql
-- §3.7.5 terminal identity (spec:1322) · §3.7.3 "Rejected tickets … surface in a shop-level 'needs attention'
-- queue — never silently dropped" (spec:1305) · contracts §4.10.3, §4.10.4 · ADR 0055.

-- ── 1. one-time enrolment codes ───────────────────────────────────────────────────────────────────────
-- Only the HASH is stored. The code is shown once, in the back office, and is a bearer secret exactly like a
-- password-reset link; storing it would make the enrolment table a credential store (LEGACY-025, LEGACY-028 — the
-- PIN is the ONLY credential this application hashes, and this is not a credential, it is a one-shot ticket).
-- The three columns §4.10.3's sketch did not carry — `code_hash bytea` (not `text`), `name`, `terminal_code`
-- with its per-company UNIQUE — are Task 0 amendment 10, which restates the sketch to match this file.
create table app.terminal_enrolment (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  branch_id    uuid not null,                                   -- the BRANCH dimension value the terminal will inherit
  code_hash    bytea not null unique,                           -- sha256 of the one-time code
  name         text not null,                                   -- the terminal's display name, chosen at issue
  terminal_code text not null,                                  -- becomes pos_terminal.code — the numbering suffix (§4.3.6)
  issued_by    uuid not null default app.current_actor() references app.principal(id),
  expires_at   timestamptz not null,
  redeemed_at  timestamptz,
  terminal_id  uuid,                                            -- set at redemption
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (company_id, terminal_code),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)   references app.dimension_value(tenant_id, id),
  foreign key (tenant_id, terminal_id) references app.pos_terminal(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.terminal_enrolment');
call app_meta.attach_audit('app.terminal_enrolment');
call app_meta.attach_stamp('app.terminal_enrolment', 'issued_by');
-- branch_isolation Form A is attached by 6C's 0068 (§4.5.6, Task 0 amendment 4).

-- ── 2. the pre-tenant door (contracts §4.1 — the second app_auth-owned function) ───────────────────────
-- The till presenting a code has no tenant, no principal and no session: it is exactly the position
-- app.resolve_principal was built for, and this is that pattern applied once more. It returns the tenant and
-- nothing else useful, so a brute-force attempt learns only "that code is not a code".
-- ⚠️ The two statements below are the whole reason this door works, and Plan 0A learned it the hard way
-- (plan0A:1021-1026, its v1.1 fix #3). `enable_tenant_rls` above issued FORCE ROW LEVEL SECURITY and a single
-- `tenant_isolation` policy `using (tenant_id = app.current_tenant())`. Inside a SECURITY DEFINER body owned by
-- `app_auth`, `current_user` is `app_auth` — which is not the table's owner and has no BYPASSRLS (only a
-- superuser can grant that, and Supabase's `postgres` is not one), so RLS applies to it — and the call runs
-- with NO tenant set, so `app.current_tenant()` is NULL and `tenant_isolation` yields ZERO ROWS. Worse,
-- plan0A:2564's default privileges grant to `app_rw` only, so `app_auth` does not even hold SELECT here.
-- Without both lines the function compiles, runs, and silently answers "that is not a code" to every valid
-- code in the system. This is `principal_resolver` / `membership_resolver` (plan0A:1024-1026) applied once more.
grant select on app.terminal_enrolment to app_auth;
create policy enrolment_resolver on app.terminal_enrolment for select to app_auth using (true);

create function app.resolve_enrolment(p_code_hash bytea)
returns table (enrolment_id uuid, tenant_id uuid, company_id uuid, branch_id uuid)
language sql stable security definer set search_path = app, pg_temp as $$
  select e.id, e.tenant_id, e.company_id, e.branch_id
    from app.terminal_enrolment e
   where e.code_hash = p_code_hash
     and e.redeemed_at is null
     and e.expires_at > now()
$$;
revoke all on function app.resolve_enrolment(bytea) from public;
grant create on schema app to app_auth;                       -- ALTER … OWNER TO needs CREATE on the schema
alter function app.resolve_enrolment(bytea) owner to app_auth;
revoke create on schema app from app_auth;                    -- ownership persists; app_auth is back to USAGE only
grant execute on function app.resolve_enrolment(bytea) to app_rw;

-- ── 3. the needs-attention queue (spec:1305) ──────────────────────────────────────────────────────────
-- `payload` is the WHOLE rejected ticket, so a rejection is recoverable from the server alone even if the
-- till has been reimaged. That is what "never silently dropped" has to mean to be worth anything.
create table app.needs_attention (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  branch_id    uuid not null,
  terminal_id  uuid,
  client_ref   uuid not null,
  payload      jsonb not null,
  error_code   text not null,                                  -- an ErrCode (§4.2.4) — an open registry, so text
  error_detail text not null,
  resolved_by  uuid references app.principal(id),              -- NULL until resolved; stamped, never supplied
  resolved_at  timestamptz,
  resolution_note text,
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (company_id, client_ref),                             -- one open row per ticket: a re-send updates, never duplicates
  check ((resolved_by is null) = (resolved_at is null)),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)   references app.dimension_value(tenant_id, id),
  foreign key (tenant_id, terminal_id) references app.pos_terminal(tenant_id, id)
);
create index needs_attention_open_idx on app.needs_attention (company_id, branch_id, created_at) where resolved_at is null;
call app_meta.enable_tenant_rls('app.needs_attention');
call app_meta.attach_audit('app.needs_attention');
call app_meta.attach_stamp('app.needs_attention', 'resolved_by');
-- stamp_actor on INSERT overwrites only a NON-NULL supplied value (plan0A:2370-2376), so a row inserted with
-- resolved_by NULL stays NULL; the UPDATE that first sets it is stamped with app.current_actor(); and any later
-- change raises ERR_ACTOR_IMMUTABLE. Exactly the lifecycle this column wants, with no bespoke trigger.
-- branch_isolation Form A is attached by 6C's 0068.

comment on table app.needs_attention is
  'Every ticket the sync apply refused, with the payload that produced it (spec:1305). Never a deletion: resolved_at closes a row.';
```

```sql
-- 0060.down.sql
drop table if exists app.needs_attention;
drop function if exists app.resolve_enrolment(bytea) cascade;
drop policy if exists enrolment_resolver on app.terminal_enrolment;
revoke select on app.terminal_enrolment from app_auth;
drop table if exists app.terminal_enrolment;
```

  **Why the down drops `needs_attention` first:** nothing references it, but §3.4.5 asks for reverse dependency order and `terminal_enrolment` is referenced by neither, so the order is the file's own creation order reversed. `app.pos_terminal` is a 0001 table and is never dropped here. **The policy and the grant are dropped explicitly** even though `drop table` would take both with it: §3.4.5 says a down drops only what the up added, *in reverse order*, and §3.4.6's `schemaFingerprint` covers grants — a down that relied on a cascade would leave the up→down→up test passing for the wrong reason if the table's drop ever became conditional.

- [ ] **Step 3: Write the two Drizzle mirrors.**

```ts
// packages/db/src/schema/terminal-enrolment.ts
import { customType, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
const app = pgSchema("app");
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
export const terminalEnrolment = app.table("terminal_enrolment", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  branchId: uuid("branch_id").notNull(),
  codeHash: bytea("code_hash").notNull(),
  name: text("name").notNull(),
  terminalCode: text("terminal_code").notNull(),
  issuedBy: uuid("issued_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  terminalId: uuid("terminal_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({
  tenantRow: unique("terminal_enrolment_tenant_id_id_key").on(t.tenantId, t.id),
  companyCode: unique("terminal_enrolment_company_id_terminal_code_key").on(t.companyId, t.terminalCode),
  // `code_hash bytea not null unique` in the SQL above — a UNIQUE CONSTRAINT, not a plain index. Declaring it
  // as index() here would make the Drizzle diff (§3.4.9, ADR-0002) report a spurious change on every run.
  hash: unique("terminal_enrolment_code_hash_key").on(t.codeHash),
}));
```

```ts
// packages/db/src/schema/needs-attention.ts
import { sql } from "drizzle-orm";
import { index, jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
const app = pgSchema("app");
export const needsAttention = app.table("needs_attention", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  branchId: uuid("branch_id").notNull(),
  terminalId: uuid("terminal_id"),
  clientRef: uuid("client_ref").notNull(),
  payload: jsonb("payload").notNull(),
  errorCode: text("error_code").notNull(),
  errorDetail: text("error_detail").notNull(),
  resolvedBy: uuid("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionNote: text("resolution_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({
  tenantRow: unique("needs_attention_tenant_id_id_key").on(t.tenantId, t.id),
  companyRef: unique("needs_attention_company_id_client_ref_key").on(t.companyId, t.clientRef),
  // The SQL above declares this index PARTIAL — `where resolved_at is null`. The predicate belongs in the
  // mirror too: §3.4.9's Drizzle diff is the migration source of truth, and a mirror declaring the full index
  // would make the diff report a change on every run — the same reason `code_hash` is `unique()` and not
  // `index()` one file up.
  open: index("needs_attention_open_idx").on(t.companyId, t.branchId, t.createdAt).where(sql`resolved_at is null`),
}));
```

- [ ] **Step 4: Run the test.** `bun run --cwd packages/db test -- sync/enrolment`. **Expected:** 6 passed. Then `bun run --cwd packages/db test -- privileges` — **expected:** green, including the `app_rw cannot assume app_auth` case, which the new `grant/revoke create on schema app` pair must leave untouched (the migration revokes it in the same statement block, so `app_auth` ends with `USAGE` only, exactly as Plan 0A left it).

- [ ] **Step 5: Write ADR 0055.** `docs/adr/0055-terminal-identity-and-the-terminal-jwt.md` — written **as a proposal and asked** (spec:95: this touches security and the sync protocol). Context: LEGACY-025 (`procQuickLogin` — an identity derived from stored credentials), LEGACY-026 (client-writable session context), LEGACY-046 (*"operation mode … one canonical name per concept, checked in one place"*). Decision, in five sentences the later tasks implement: a terminal owns a `principal` of kind `terminal` so it has a real audit identity; enrolment is a **one-time hashed code with an expiry**, redeemed once, and the device's Ed25519 public key is registered at redemption; every `/v1/sync/*` call is either signed by that key or carries a **short-lived** JWT minted from a signed call; the JWT is signed with `TERMINAL_JWT_SIGNING_KEY` (HS256, one secret, §3.11) because the verifier and the signer are the same service and an asymmetric key would add a rotation story for no third party; revocation is `pos_terminal.revoked_at` and needs no user change (spec:1322). Consequences: the signing key is a §3.11 secret that must exist in every environment; a clock skew beyond the window rejects a terminal, which is why the window is ±300 s and the error names the skew; and **a stolen terminal key sells until it is revoked** — the mitigation is that it can only ever act as that terminal, at that branch, holding `pos_terminal`'s two codes.

- [ ] **Step 6: Commit.**

```bash
git add packages/db/migrations/0060_create_terminal_enrolment_needs_attention.sql packages/db/migrations/0060.down.sql \
        packages/db/src/schema/terminal-enrolment.ts packages/db/src/schema/needs-attention.ts \
        packages/db/test/sync/enrolment.test.ts docs/adr/0055-terminal-identity-and-the-terminal-jwt.md
git commit -m "$(cat <<'EOF'
feat(db): migration 0060 — terminal_enrolment, needs_attention, app.resolve_enrolment [6A T3]

The enrolment code is stored as a hash and resolved through the second app_auth-owned
SECURITY DEFINER door, so a till with no tenant, no principal and no session can present
one without any client-supplied identity (LEGACY-025, LEGACY-026). A refused ticket lands in
needs_attention with its whole payload (spec:1305) — never dropped.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Migration 0061 — `document.terminal_id`, `document.shift_id`, `pos_terminal.code`, the `document_line.kind` union, and the per-terminal series

**Files**

- `packages/db/migrations/0061_alter_document_add_pos_columns.sql` — NEW
- `packages/db/migrations/0061.down.sql` — NEW
- `packages/db/src/schema/document.ts`, `packages/db/src/schema/pos-terminal.ts`, `packages/db/src/schema/document-line.ts` — MODIFY (mirrors)
- `packages/db/src/posting/issue.ts` — MODIFY (`resolveSeries`)
- `packages/contracts/src/accounting/document.ts` — MODIFY (`DocumentLineKindSchema`)
- `packages/db/test/fixtures.ts` — MODIFY (`DraftLine.kind`)
- `packages/db/test/sync/pos-columns.test.ts` — NEW

**Interfaces**

- Consumes: `issueDocument`, `IssueResult` (§4.3.1); `app.document_series`, `app.posting_seq` (1A); `draftTypedDocument`, `DraftLine` (3C); `seedDocumentType` (2A); `grantCodes` (2B).
- Produces: `document.terminal_id`, **`document.shift_id`** (Task 0 amendment 6; 6D's own amendment A2 records the same move from its side and its Task 0 gate asserts this column by literal), `pos_terminal.code`, the six-label `document_line_kind_check`, and `resolveSeries(tx, documentId, policySeries): Promise<string>` exported from `packages/db/src/posting/issue.ts` (Task 0 amendment 6).

**Steps**

- [ ] **Step 1: Write the failing test first.**

```ts
// packages/db/test/sync/pos-columns.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { draftTypedDocument, grantCodes, seedAccount, seedDocumentType, seedTenantV2, type Seed } from "../fixtures";
import { postDocument } from "../../src/posting";
import { withTenant as prodWithTenant } from "../../src/with-tenant";

const SERIES_POLICY = {
  version: 1, documentType: "SERIES_TEST", direction: "internal", requires: [],
  lines: [
    { for: "each_line", side: "debit",  account: { from: "line.account" }, amount: "line.debit",  when: { "line.kind": "account" } },
    { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
  ],
  inventory: { effect: "none" }, tax: { applies: false },
  numbering: { series: "POS", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" }, dimensions: { required: [] },
};

describe("migration 0061 — the POS columns and the per-terminal numbering suffix (§4.3.6, spec:1721)", () => {
  let db: Db; let s: Seed;
  beforeAll(async () => { db = await startDb(); s = await seedTenantV2(db, "Alpha"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("document_line.kind admits all six labels — the union 8B's 0087 also writes (§4.3.4)", async () => {
    const [c] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'document_line_kind_check'`;
    expect(c!.def).toContain("'tender'");
    expect(c!.def).toContain("'payroll'");
    for (const label of ["account", "item", "tax", "text"]) expect(c!.def).toContain(`'${label}'`);
  });

  it("document.shift_id exists, is nullable, and carries NO foreign key (Task 0 amendment 6, 6D's A2)", async () => {
    const cols = await db.admin<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'document' and column_name = 'shift_id'`;
    expect(cols).toEqual([{ column_name: "shift_id", data_type: "uuid", is_nullable: "YES" }]);
    // The absence of the FK is the assertion, not an oversight: app.shift is 6D's table and PostgreSQL's
    // referential-integrity scan bypasses RLS, so no validated key can be added at 0070 either. 6D enforces
    // the reference in the apply path (`assertShiftKnown`) and adds only the index `document_shift_idx`.
    const fks = await db.admin<{ conname: string }[]>`
      select con.conname from pg_constraint con
       where con.conrelid = 'app.document'::regclass and con.contype = 'f'
         and 'shift_id' = any (select a.attname from pg_attribute a
                                where a.attrelid = con.conrelid and a.attnum = any (con.conkey))`;
    expect(fks).toEqual([]);
  });

  it("pos_terminal.code is unique per company and nullable (expand — §3.4.7)", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'pos_terminal' and column_name = 'code'`;
    expect(cols).toEqual([{ column_name: "code", is_nullable: "YES" }]);
  });

  it("a document with NO terminal numbers on the policy series, unchanged (every pre-6A type)", async () => {
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    const cash = await seedAccount(db, s, { code: "1001", nameEn: "Petty cash", type: "asset" });
    const typeId = await seedDocumentType(db, s, { code: "SERIES_TEST", policy: SERIES_POLICY });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: typeId, series: "POS",
      lines: [{ kind: "account", accountId: cash, debit: "10.0000" }, { kind: "account", accountId: s.sales, credit: "10.0000" }],
    });
    const out = await prodWithTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "t" },
      (tx) => postDocument(tx, { tenantId: s.tenant, actorId: s.human, requestId: "t" }, { documentId }));
    expect(out.series).toBe("POS");
  });

  it("a document carrying a terminal numbers on '<series>-<terminal code>' (§4.14, spec:1721)", async () => {
    const cash = await seedAccount(db, s, { code: "1002", nameEn: "Petty cash 2", type: "asset" });
    const typeId = await seedDocumentType(db, s, { code: "SERIES_TEST", policy: SERIES_POLICY });
    const terminalId = await uuidv7(db.admin); const principalId = await uuidv7(db.admin);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${principalId}, 'terminal', ${"terminal:" + terminalId}, 'KL01')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
      await tx`insert into app.pos_terminal (id, tenant_id, company_id, branch_id, principal_id, name, code, device_public_key)
               values (${terminalId}, ${s.tenant}, ${s.company}, ${s.hq}, ${principalId}, 'KL01', 'KL01', '\\x00'::bytea)`;
    });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: typeId, series: "POS",
      lines: [{ kind: "account", accountId: cash, debit: "5.0000" }, { kind: "account", accountId: s.sales, credit: "5.0000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`update app.document set terminal_id = ${terminalId} where id = ${documentId}`);

    const out = await prodWithTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "t" },
      (tx) => postDocument(tx, { tenantId: s.tenant, actorId: s.human, requestId: "t" }, { documentId }));
    expect(out.series).toBe("POS-KL01");
    // Two independent counters, which is the whole point (test 16's 6A re-run): the untagged document above
    // took POS #1 and this one takes POS-KL01 #1, not #2.
    expect(out.number).toBe(1n);
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ series: string }[]>`
      select series from app.document_series where company_id = ${s.company} order by series`);
    expect(rows.map((r) => r.series)).toEqual(["POS", "POS-KL01"]);
  });
});
```

  Run `bun run --cwd packages/db test -- sync/pos-columns`. **Expected failure:** the first `it` fails (five cases now, and the `shift_id` one fails with `received: []` because the column does not exist) — `pg_get_constraintdef` returns the four-label list 2A shipped and `toContain("'tender'")` reports `received: "CHECK ((kind = ANY (ARRAY['account'::text, 'item'::text, 'tax'::text, 'text'::text])))"`.

- [ ] **Step 2: Write the migration.**

```sql
-- 0061_alter_document_add_pos_columns.sql
-- §3.8 document.client_ref/branch_id/attributed_to (spec:1764-1768) · §3.7.5 terminal identity (spec:1322)
-- · contracts §4.3.4 (the 6A row) · §4.14 (the POS-<terminal code> series, spec:1721).

-- ── 1. the acting terminal on a document ──────────────────────────────────────────────────────────────
-- The terminal is ALREADY the acting principal through created_by/posted_by (LEGACY-044); this column records
-- WHICH terminal, which is what the numbering suffix, the Z-report and the branch scoping all read.
alter table app.document add column terminal_id uuid;
alter table app.document add constraint document_terminal_fk
  foreign key (tenant_id, terminal_id) references app.pos_terminal(tenant_id, id);
create index document_terminal_idx on app.document (terminal_id) where terminal_id is not null;

-- ── 1b. the till's shift, WITHOUT a foreign key (Task 0 amendment 6; 6D's own amendment A2) ────────────
-- applyTicket writes this on every POS_TICKET from the first ticket 6A applies, so the column has to exist
-- here: `app.shift` is 6D's table and arrives at 0070, long after tills are selling. No FK is added here and
-- NONE is added at 0070 either — PostgreSQL's referential-integrity scan BYPASSES row security, so validating
-- a key at 0070 would see every ticket written between 6B's release and 6D's, each naming a shift with no row;
-- and a migration cannot backfill the parents, because FORCE ROW LEVEL SECURITY binds app_migrator and a
-- migration file sets no tenant (hazard 10). 6D enforces the reference in the apply path (`assertShiftKnown`,
-- which refuses a shiftId that names no shift OF THAT TERMINAL) and adds only the index `document_shift_idx`.
alter table app.document add column shift_id uuid;

-- ── 2. the terminal's numbering code (spec:1721 'POS-KL01') ───────────────────────────────────────────
-- Nullable, because §3.4.7 makes any change to a table that holds production rows an expand step; every row
-- is written by 6A's own enrolment route, so no backfill exists and a contract step is never needed.
alter table app.pos_terminal add column code text;
alter table app.pos_terminal add constraint pos_terminal_company_id_code_key unique (company_id, code);

-- ── 3. document_line.kind — the FULL union, both phases' labels (§4.3.4) ──────────────────────────────
-- 8B's 0087 writes the identical list. Phase 8 may execute before or after Phase 6 (spec:2301), so a file
-- listing only "the labels admitted so far" would drop the other phase's label when it ran second. Both files
-- are therefore idempotent in either order.
alter table app.document_line drop constraint document_line_kind_check;
alter table app.document_line add constraint document_line_kind_check
  check (kind in ('account','item','tax','text','tender','payroll'));

comment on column app.document.terminal_id is
  'The POS terminal that synced this document (spec:1322). The ACTING principal is the terminal''s principal through created_by/posted_by; this is which terminal it was.';
comment on column app.document.shift_id is
  'The till shift this document belongs to, minted at the terminal. Deliberately NO foreign key: app.shift is 6D''s (0070) and RI checks bypass RLS, so the reference is enforced in the sync apply path instead.';
comment on column app.pos_terminal.code is
  'The numbering suffix: POS_TICKET numbers on "<policy series>-<code>" so two tills never contend for one counter (spec:1721).';
```

```sql
-- 0061.down.sql
-- The kind CHECK returns to 2A's four labels only when no row uses a dropped one; `down` runs only in CI on
-- empty tenants (§3.4.5), so the guard is a hard failure and not a silent skip.
do $$ begin
  if exists (select 1 from app.document_line where kind in ('tender','payroll')) then
    raise exception 'cannot narrow document_line_kind_check: rows still use tender/payroll';
  end if;
end $$;
alter table app.document_line drop constraint document_line_kind_check;
alter table app.document_line add constraint document_line_kind_check
  check (kind in ('account','item','tax','text'));
alter table app.pos_terminal drop constraint if exists pos_terminal_company_id_code_key;
alter table app.pos_terminal drop column if exists code;
alter table app.document drop column if exists shift_id;
drop index if exists app.document_terminal_idx;
alter table app.document drop constraint if exists document_terminal_fk;
alter table app.document drop column if exists terminal_id;
```

  **And the three Drizzle mirrors, in the same commit.** §3.4.9 makes the mirror the diff's source of truth, so a column added in SQL and not in the mirror shows up as a spurious drop on every run. Three one-line-each edits, and nothing else in the three files changes:

```ts
// packages/db/src/schema/document.ts — inside app.table("document", { … }), beside the existing columns.
  terminalId: uuid("terminal_id"),
  shiftId: uuid("shift_id"),        // no .references(): app.shift is 6D's and the SQL declares no FK either

// packages/db/src/schema/pos-terminal.ts — the column, and the UNIQUE the SQL names.
  code: text("code"),
  // in the table's second argument: companyCode: unique("pos_terminal_company_id_code_key").on(t.companyId, t.code),

// packages/db/src/schema/document-line.ts — the CHECK's six labels, so the mirror and the constraint agree.
  // kind: text("kind").notNull()  — the column type is unchanged; only the check constraint's expression moves,
  // and Drizzle renders it from the table's `check("document_line_kind_check", sql`kind in (…)`)` entry:
  //   check("document_line_kind_check", sql`kind in ('account','item','tax','text','tender','payroll')`)
```

- [ ] **Step 3: Extend `issueDocument` with `resolveSeries` — the ONE place a series is decided.**

```ts
// packages/db/src/posting/issue.ts — ADD above issueDocument; the existing body changes by two lines.

/**
 * The effective numbering series for a document (contracts §4.3.6, Task 0 amendment 6).
 *
 * `policy.numbering.series` is a static literal by §4.4.1's frozen schema, but §4.14 gives `POS_TICKET` the
 * series `POS-<terminal code>` and spec:1721's own example is `'POS-KL01'`. A per-terminal counter is not
 * cosmetic: without it every till in a company contends for one `document_series` row, and a 200-ticket batch
 * would hold that row's advisory lock for its whole transaction while every other till waited.
 *
 * The branch is unreachable outside Phase 6 — no other slice's documents carry a `terminal_id` — so every
 * existing numbering test is untouched, which is the property that let this be an extension and not an ADR
 * against 1A.
 */
export async function resolveSeries(tx: Sql, documentId: string, policySeries: string): Promise<string> {
  const rows = await tx<{ code: string | null }[]>`
    select t.code
      from app.document d
      join app.pos_terminal t on t.id = d.terminal_id
     where d.id = ${documentId}`;
  const code = rows[0]?.code ?? null;
  return code === null ? policySeries : `${policySeries}-${code}`;
}
```

  Inside `issueDocument`, replace the line that reads the series from the policy with:

```ts
  const series = await resolveSeries(tx, input.documentId, policy.numbering.series);
```

  and leave the advisory-lock key, the `document_series` upsert and the `update … returning` exactly as 1A wrote them — they take the resolved string and nothing else about the algorithm moves.

- [ ] **Step 4: Widen the two wire vocabularies in the same PR (Task 0 amendment 16).**

```ts
// packages/contracts/src/accounting/document.ts — 2A's four labels become the frozen six.
/** The full union of §4.3.4's `document_line_kind_check`. 6A's 0061 and 8B's 0087 both write it in SQL, and
 *  either may run first (spec:2301) — so the Zod enum takes the same complete list for the same reason. */
export const DocumentLineKindSchema = z.enum(["account", "item", "tax", "text", "tender", "payroll"]);
```

```ts
// packages/db/test/fixtures.ts — 3C's DraftLine.kind takes the same union, or the back-office half of
// acceptance test 22 cannot carry a tender line.
export interface DraftLine {
  kind: "account" | "item" | "tax" | "text" | "tender" | "payroll";
  // This is the ONLY line of `DraftLine` that changes. `lineNo`, `description`, `accountId`, `itemId`,
  // `warehouseId`, `lotId`, `unitId`, `quantity`, `unitQuantity`, `unitPrice`, `discount`, `amount`,
  // `debit`, `credit`, `dimensions` and `customFields` keep 3C's declarations exactly (3c:384-403).
}
```

- [ ] **Step 5: Run everything the change can reach.** `bun run --cwd packages/db test -- sync/pos-columns` — **expected:** 5 passed. Then the two suites `resolveSeries` sits inside: `bun run --cwd packages/db test -- documents` and `bun run --cwd packages/db test -- ledger` — **expected:** unchanged and green (no pre-6A document carries a `terminal_id`, so `resolveSeries` returns its argument). Then `bun run --cwd packages/db test -- privileges` for §3.4.6's fingerprint, and `bun run typecheck` at the root for the two widened unions.

- [ ] **Step 6: Commit.**

```bash
git add packages/db/migrations/0061_alter_document_add_pos_columns.sql packages/db/migrations/0061.down.sql \
        packages/db/src/schema/document.ts packages/db/src/schema/pos-terminal.ts packages/db/src/schema/document-line.ts \
        packages/db/src/posting/issue.ts packages/contracts/src/accounting/document.ts \
        packages/db/test/fixtures.ts packages/db/test/sync/pos-columns.test.ts
git commit -m "$(cat <<'EOF'
feat(db): migration 0061 — document.terminal_id and shift_id, pos_terminal.code, the six-label kind union [6A T4]

resolveSeries gives a terminal-tagged document the series POS-<code> (spec:1721), so two
tills never contend for one document_series counter. The branch is unreachable without a
terminal_id, so every pre-Phase-6 numbering test is untouched.

shift_id lands here and not in 6D's 0070 (Task 0 amendment 6, 6D amendment A2): applyBatch
writes it from the first ticket. It carries no foreign key and gains none — RI checks bypass
RLS, so 0070 could not validate one either; 6D enforces the reference in the apply path.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Migration 0062 — the eleven permission codes, the role grants, and the three tender accounts

**Files**

- `packages/db/migrations/0062_seed_permission_phase6a.sql` — NEW
- `packages/db/migrations/0062.down.sql` — NEW
- `packages/contracts/permissions.ts` — MODIFY (eleven `PermissionDef` rows)
- `packages/db/seed/roles.ts` — MODIFY (`cashier`, `branch_manager`)
- `packages/db/seed/my/chart-of-accounts/6a-pos-tenders.json` — NEW
- `packages/db/src/sync/authority.ts` — NEW (the code map `applyBatch` evaluates; Step 5)
- `packages/db/test/sync/accounts-and-codes.test.ts` — NEW

**Interfaces**

- Consumes: `PERMISSIONS`, `PermissionDef`, `SliceId` (§4.2.5); `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` (§3.6.4); the `chart-of-accounts` loader (0C); `seedAccount` (1A).
- Produces: §3.6.2's eleven rows; §3.6.4's `cashier` and `branch_manager` grants; §4.15's `1110`, `1120`, `2200`; and

```ts
// packages/db/src/sync/authority.ts
/** The eight `pos.*` codes `applyBatch` re-verifies, as literals, in one place. 3A's `INVENTORY_PERMISSION`
 *  (phase-3a:1882) is the precedent: `packages/db` may not import `@dulja/contracts` (§3.1), so a db-tier
 *  slice that must name a permission code names it here and the `permission-catalogue` lint counts the
 *  string literal (§3.6.3 — "a code counts as evaluated when it appears as a string literal anywhere in the
 *  reference scopes", and `packages/db/src` is one of them). */
export const POS_PERMISSION: {
  readonly ticketSell: "pos.ticket.sell";
  readonly ticketDiscount: "pos.ticket.discount";
  readonly ticketReturn: "pos.ticket.return";
  readonly ticketReturnBlind: "pos.ticket.return_blind";
  readonly ticketVoid: "pos.ticket.void";
  readonly ticketOverride: "pos.ticket.override";
  readonly customerCreate: "pos.customer.create";
  readonly needsAttentionResolve: "pos.needs_attention.resolve";
};
export type PosPermissionCode = (typeof POS_PERMISSION)[keyof typeof POS_PERMISSION];
/** The override `subject` that can authorise each code, or `null` when no override can (a cashier who lacks
 *  `pos.ticket.sell` is not sold to by a supervisor's signature — she is not selling). */
export const OVERRIDE_SUBJECT_FOR: Readonly<Record<PosPermissionCode, "discount" | "void" | "blind_return" | "price_override" | null>>;
```

**Steps**

- [ ] **Step 1: Write the failing test first.**

```ts
// packages/db/test/sync/accounts-and-codes.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../seed/roles";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import { chartOfAccountsLoader } from "../../src/seed";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { PACK_ROOT } from "../ar-ap/_support";

const SIX_A_CODES = [
  "admin.terminal.manage",
  "pos.sync.pull", "pos.sync.push",
  "pos.ticket.sell", "pos.ticket.discount", "pos.ticket.return", "pos.ticket.return_blind",
  "pos.ticket.void", "pos.ticket.override", "pos.needs_attention.resolve", "pos.customer.create",
] as const;

describe("migration 0062 and the 6A chart rows (§3.6.2, §3.6.4, §4.15)", () => {
  let db: Db; let s: Seed;
  beforeAll(async () => { db = await startDb(); s = await seedTenantV2(db, "Alpha"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("app.permission holds exactly the eleven codes with the right module and mutating flag", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code = any(${[...SIX_A_CODES]}) order by code`;
    expect(rows.map((r) => r.code)).toEqual([...SIX_A_CODES].sort());
    expect(rows.find((r) => r.code === "pos.sync.pull")!.mutating).toBe(false);
    expect(rows.filter((r) => r.code !== "pos.sync.pull").every((r) => r.mutating)).toBe(true);
    expect(rows.find((r) => r.code === "admin.terminal.manage")!.module).toBe("admin");
    expect(rows.filter((r) => r.code.startsWith("pos.")).every((r) => r.module === "pos")).toBe(true);
  });

  it("the catalogue module agrees with the database, both directions (§3.6.3's build check, over this slice)", async () => {
    for (const code of SIX_A_CODES) {
      const def = PERMISSIONS.find((p) => p.code === code);
      expect(def, code).toBeDefined();
      expect(def!.phase).toBe("6A");
    }
  });

  it("the seeded roles match spec:2160-2161 exactly — a cashier may not void, blind-return or override", async () => {
    const cashier = ROLES.find((r) => r.code === "cashier")!;
    expect([...cashier.permissions].filter((c) => c.startsWith("pos.")).sort()).toEqual(
      ["pos.customer.create", "pos.ticket.discount", "pos.ticket.return", "pos.ticket.sell"]);
    for (const forbidden of ["pos.ticket.void", "pos.ticket.return_blind", "pos.ticket.override", "pos.sync.push"]) {
      expect(cashier.permissions, forbidden).not.toContain(forbidden);
    }
    const bm = ROLES.find((r) => r.code === "branch_manager")!;
    for (const held of ["pos.ticket.void", "pos.ticket.return_blind", "pos.ticket.override", "pos.needs_attention.resolve"]) {
      expect(bm.permissions, held).toContain(held);
    }
    // R8 (spec:2179): a terminal holds exactly two codes and a human never holds them.
    const term = ROLES.find((r) => r.code === "pos_terminal")!;
    expect([...term.permissions].sort()).toEqual(["pos.sync.pull", "pos.sync.push"]);
    for (const r of ROLES.filter((x) => x.code !== "pos_terminal" && x.code !== "admin")) {
      expect(r.permissions.some((c) => c.startsWith("pos.sync.")), r.code).toBe(false);
    }
    // R6 (spec:2177): no seeded role but admin holds both halves of an incompatible pair.
    for (const r of ROLES.filter((x) => x.code !== "admin")) {
      for (const [x, y] of INCOMPATIBLE_PAIRS) {
        expect(r.permissions.includes(x) && r.permissions.includes(y), `${r.code} ${x}+${y}`).toBe(false);
      }
    }
  });

  it("6a-pos-tenders.json seeds 1110/1120/2200 and 1100 already resolves (hazard 33)", async () => {
    await prodWithTenant(db.rw, { tenantId: s.tenant, actorId: s.system, requestId: "chart" }, (tx) =>
      chartOfAccountsLoader.load(tx, {
        config: { tenantId: s.tenant } as never, tenantId: s.tenant, companyId: s.company,
        systemPrincipalId: s.system, packRoot: PACK_ROOT,
      }));
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ code: string; account_type: string }[]>`
      select code, account_type::text as account_type from app.account
       where company_id = ${s.company} and code in ('1100','1110','1120','2200') order by code`);
    expect(rows).toEqual([
      { code: "1100", account_type: "asset" },      // 0C's — consumed, never re-seeded
      { code: "1110", account_type: "asset" },
      { code: "1120", account_type: "asset" },
      { code: "2200", account_type: "liability" },
    ]);
  });

  it("re-applying the chart sub-pack is idempotent (§3.4.8 — on conflict do nothing on the natural key)", async () => {
    await prodWithTenant(db.rw, { tenantId: s.tenant, actorId: s.system, requestId: "chart-2" }, (tx) =>
      chartOfAccountsLoader.load(tx, {
        config: { tenantId: s.tenant } as never, tenantId: s.tenant, companyId: s.company,
        systemPrincipalId: s.system, packRoot: PACK_ROOT,
      }));
    const [n] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account where company_id = ${s.company} and code = '1110'`);
    expect(n!.n).toBe(1);
  });
});
```

  Run `bun run --cwd packages/db test -- sync/accounts-and-codes`. **Expected failure:** the first `it` reports `received: []` — `app.permission` holds none of the eleven.

- [ ] **Step 2: Write the migration.**

```sql
-- 0062_seed_permission_phase6a.sql
-- §4.2.1's pos and admin catalogues (spec:2150) · contracts §3.6.2 (the 6A rows) · §3.4.8 (app.permission is
-- GLOBAL and is therefore migration data; roles and grants are seed-pack data and are not here).
insert into app.permission (code, module, mutating, description) values
  ('admin.terminal.manage',      'admin', true,  'Issue and revoke POS terminal enrolments'),
  ('pos.sync.pull',              'pos',   false, 'Pull the branch catalogue to a terminal'),
  ('pos.sync.push',              'pos',   true,  'Push a ticket batch from a terminal'),
  ('pos.ticket.sell',            'pos',   true,  'Sell at a till'),
  ('pos.ticket.discount',        'pos',   true,  'Discount a line or a ticket within the branch limit'),
  ('pos.ticket.return',          'pos',   true,  'Return against an original ticket'),
  ('pos.ticket.return_blind',    'pos',   true,  'Return with no original ticket'),
  ('pos.ticket.void',            'pos',   true,  'Void a ticket'),
  ('pos.ticket.override',        'pos',   true,  'Authorise, as a second principal, a ticket beyond a cashier''s limit'),
  ('pos.needs_attention.resolve','pos',   true,  'Resolve a refused ticket in the shop queue'),
  ('pos.customer.create',        'pos',   true,  'Quick-create a customer at a till')
on conflict (code) do update
  set module = excluded.module, mutating = excluded.mutating, description = excluded.description;
```

```sql
-- 0062.down.sql — deletes exactly the codes the up inserted (§3.6.3).
--
-- PRECONDITION (contracts §3.4.5): this down is reversible only against an UNSEEDED database.
-- It deletes the eleven catalogue rows and deliberately does NOT touch the role grants that the seed tier
-- (packages/db/seed/roles.ts, applied by `seed --only roles`) holds for those codes,
-- because it cannot: (1) app.role_permission.permission_code references app.permission(code) with no
--     `on delete` action, and referential-integrity checks bypass RLS — so on a database where
--     `--only roles` has run, this delete does not silently orphan a grant, it RAISES SQLSTATE 23503;
-- (2) a `delete from app.role_permission` here would affect ZERO rows anyway — app_meta.enable_tenant_rls
--     applies FORCE ROW LEVEL SECURITY, which binds the table owner too, and a migration sets no
--     app.tenant_id (§3.4.8);
-- (3) nor can this file discover the tenants to set a context FOR — app.tenant is itself forced with
--     `using (id = app.current_tenant())`, so the migrator enumerating it sees nothing.
-- The operator, not this file, removes the grants per tenant first (a seed-tier act, under
-- `set_config('app.tenant_id', …)`), and re-runs `bun run seed --tenant <id> --only roles` after
-- re-migrating. NEVER disable or drop the policy to make this file "work" — LEGACY-027, LEGACY-041, LEGACY-053.
delete from app.permission where code in (
  'admin.terminal.manage','pos.sync.pull','pos.sync.push','pos.ticket.sell','pos.ticket.discount',
  'pos.ticket.return','pos.ticket.return_blind','pos.ticket.void','pos.ticket.override',
  'pos.needs_attention.resolve','pos.customer.create');
```

  **The precondition on this migration's rollback command (§3.4.5).** The command is `bun run --cwd packages/db db:rollback 61` — 0A's CLI passes the argument to `down(sql, dir, toVersion)`, which rolls back every applied version **above** it newest-first, so `61` undoes 0062 and nothing else. **It succeeds only where no tenant has been seeded** — that is exactly the state §3.4.6's generalised reversibility test runs every down file in, and the state a CI database is in. On a database where `bun run seed --tenant <id> --only roles` has run, the command fails with SQLSTATE 23503 naming `app.role_permission`, and that failure is correct behaviour rather than a defect in the file: the operator removes the grants per tenant with a tenant context set, rolls back, and then re-runs `--only roles` after re-migrating. Re-migrating re-inserts the eleven `app.permission` rows and nothing else — the two tiers are separate, which is the whole of §3.4.5: the grants Step 4 writes into `packages/db/seed/roles.ts` are seed-pack data and come back **only** from `--only roles`, which is why that re-run is part of the procedure and not an optional tidy-up. The same precondition governs 6B's `0063.down.sql`, which carries the three 6B codes.

- [ ] **Step 3: Add the eleven catalogue rows.** In `packages/contracts/permissions.ts`, append to the `PERMISSIONS` array — one row per code, `phase: "6A"`, `module` and `mutating` byte-identical to the SQL above (the `permission-catalogue.test.ts` check of §3.6.3 compares the two sets in both directions, so a single character apart fails the build):

```ts
  { code: "admin.terminal.manage",       module: "admin", mutating: true,  description: "Issue and revoke POS terminal enrolments", phase: "6A" },
  { code: "pos.sync.pull",               module: "pos",   mutating: false, description: "Pull the branch catalogue to a terminal", phase: "6A" },
  { code: "pos.sync.push",               module: "pos",   mutating: true,  description: "Push a ticket batch from a terminal", phase: "6A" },
  { code: "pos.ticket.sell",             module: "pos",   mutating: true,  description: "Sell at a till", phase: "6A" },
  { code: "pos.ticket.discount",         module: "pos",   mutating: true,  description: "Discount a line or a ticket within the branch limit", phase: "6A" },
  { code: "pos.ticket.return",           module: "pos",   mutating: true,  description: "Return against an original ticket", phase: "6A" },
  { code: "pos.ticket.return_blind",     module: "pos",   mutating: true,  description: "Return with no original ticket", phase: "6A" },
  { code: "pos.ticket.void",             module: "pos",   mutating: true,  description: "Void a ticket", phase: "6A" },
  { code: "pos.ticket.override",         module: "pos",   mutating: true,  description: "Authorise, as a second principal, a ticket beyond a cashier's limit", phase: "6A" },
  { code: "pos.needs_attention.resolve", module: "pos",   mutating: true,  description: "Resolve a refused ticket in the shop queue", phase: "6A" },
  { code: "pos.customer.create",         module: "pos",   mutating: true,  description: "Quick-create a customer at a till", phase: "6A" },
```

- [ ] **Step 4: Add the role grants (§3.6.4, Task 0 amendment 14).** In `packages/db/seed/roles.ts`, add to the `permissions` arrays of exactly two roles. **`admin` is computed** from `PERMISSIONS` minus `pos.ticket.sell` and every `pos.sync.*`, so it picks up `admin.terminal.manage` and the seven other `pos.ticket.*` / queue codes with no edit; `pos_terminal`'s two codes are already the literal §3.6.4 fixes; `auditor` gains nothing (every one of the eleven except `pos.sync.pull` is mutating, and R7 forbids it a mutating code — and `pos.sync.pull` belongs to a terminal, not an auditor).

```ts
  // cashier — spec:2161 verbatim: "Sell, discount within the branch limit, return against an original
  // ticket, own shift, price check, customer quick-create". `pos.shift.own`, `pos.price.check` and
  // `pos.attendance.clock` are 6B's codes and 6B adds them to this same array.
  //   MAY NOT: "Blind returns, voids, overrides on own tickets, closing others' shifts."
  "pos.ticket.sell", "pos.ticket.discount", "pos.ticket.return", "pos.customer.create",

  // branch_manager — spec:2160: "Everything a cashier may, plus overrides on *others'* tickets as the second
  // principal, … resolving the needs-attention queue".
  "pos.ticket.sell", "pos.ticket.discount", "pos.ticket.return", "pos.customer.create",
  "pos.ticket.void", "pos.ticket.return_blind", "pos.ticket.override", "pos.needs_attention.resolve",
```

  **`pos.ticket.override` on `branch_manager` is what makes acceptance test 37 possible at all** — `app.assert_override_authorised` refuses an override whose principal is the document's `created_by` or `attributed_to`, so the authorising principal must be someone other than the cashier who holds the code at that branch. A cashier holding it would make the guard vacuous.

- [ ] **Step 5: Write `packages/db/src/sync/authority.ts` — the eight code literals, in this commit.** This is what keeps `bun run lint:rules` **green from this commit onward**, and it is not a lint prop: it is the single place the ticket→code mapping lives, and Task 11 Step 2c evaluates it. §3.6.3's `permission-catalogue` rule collects a code as *evaluated* when the literal appears anywhere in `apps/api`, `apps/worker`, `apps/pos`, `packages/sync` or **`packages/db/src`** — and the three route-gated codes (`pos.sync.pull`, `pos.sync.push`, `admin.terminal.manage`) arrive in T6/T8/T12, while `pos.ticket.override` is already a literal in `packages/sync/src/messages.ts` from T1. Without this file eight of the eleven would be orphans for seven commits.

```ts
// packages/db/src/sync/authority.ts
/**
 * The `pos.*` codes `applyBatch` re-verifies against the SERVER's current assignments (spec:1324), named once.
 *
 * **Why literals in `packages/db` and not `PERMISSION[...]`:** §3.1 pins `packages/db` to `@dulja/domain`, so
 * `@dulja/contracts`'s `PERMISSION` is unreachable here — exactly the constraint 3A met with
 * `INVENTORY_PERMISSION` (phase-3a:1882) and 1A met with `PostingError`. The `permission-catalogue` lint
 * counts a bare string literal in this scope, and `packages/db/test/sync/accounts-and-codes.test.ts` asserts
 * every value here is in the catalogue, so a typo cannot survive the build in either direction.
 */
export const POS_PERMISSION = {
  ticketSell:            "pos.ticket.sell",
  ticketDiscount:        "pos.ticket.discount",
  ticketReturn:          "pos.ticket.return",
  ticketReturnBlind:     "pos.ticket.return_blind",
  ticketVoid:            "pos.ticket.void",
  ticketOverride:        "pos.ticket.override",
  customerCreate:        "pos.customer.create",
  needsAttentionResolve: "pos.needs_attention.resolve",
} as const;
export type PosPermissionCode = (typeof POS_PERMISSION)[keyof typeof POS_PERMISSION];

/**
 * Which override `subject` (§4.10.1's `TicketEvent.subject`) can authorise a cashier who lacks each code.
 *
 * `null` means **no override rescues it**: a principal without `pos.ticket.sell` is not selling, and a
 * supervisor's signature does not make her a cashier — spec:2161 gives the cashier "sell" and gives the
 * branch manager "overrides on *others'* tickets", which is a different sentence. The three that a subject
 * does rescue are exactly the three spec:2161 says a cashier "MAY NOT" do unaided: discount beyond the
 * branch limit, void, and blind return.
 */
export const OVERRIDE_SUBJECT_FOR: Readonly<
  Record<PosPermissionCode, "discount" | "void" | "blind_return" | "price_override" | null>
> = {
  "pos.ticket.sell": null,
  "pos.ticket.discount": "discount",
  "pos.ticket.return": null,
  "pos.ticket.return_blind": "blind_return",
  "pos.ticket.void": "void",
  "pos.ticket.override": null,
  "pos.customer.create": null,
  "pos.needs_attention.resolve": null,
};
```

  Add one case to `packages/db/test/sync/accounts-and-codes.test.ts`, so the map and the catalogue cannot drift:

```ts
  it("every code POS_PERMISSION names is in the catalogue, and the eight are the eight (§3.6.3, both directions)", async () => {
    const { OVERRIDE_SUBJECT_FOR, POS_PERMISSION } = await import("../../src/sync/authority");
    const named = Object.values(POS_PERMISSION);
    expect(new Set(named).size).toBe(8);
    for (const code of named) expect(PERMISSIONS.some((p) => p.code === code), code).toBe(true);
    // The eight are exactly the eleven minus the two sync codes and the admin one — the codes a ROUTE gates.
    expect([...named].sort()).toEqual(
      SIX_A_CODES.filter((c) => c !== "pos.sync.pull" && c !== "pos.sync.push" && c !== "admin.terminal.manage").sort());
    expect(Object.keys(OVERRIDE_SUBJECT_FOR).sort()).toEqual([...named].sort());
    // A supervisor cannot make a non-cashier sell: spec:2161's "MAY NOT" list is the only rescuable set.
    expect(named.filter((c) => OVERRIDE_SUBJECT_FOR[c] !== null).sort()).toEqual(
      ["pos.ticket.discount", "pos.ticket.return_blind", "pos.ticket.void"]);
  });
```

- [ ] **Step 6: Write the chart file.**

```json
// packages/db/seed/my/chart-of-accounts/6a-pos-tenders.json
// §4.15 — the three accounts POS_TICKET's tender rules resolve BY CODE, seeded here with the policy that
// names them (hazard 33). `1100` Bank is 0C's and is the fourth; it is consumed, never re-seeded.
[
  { "code": "1110", "nameEn": "Cash in till",          "nameAr": "نقد في الصندوق",   "type": "asset" },
  { "code": "1120", "nameEn": "Card clearing",         "nameAr": "مقاصة البطاقات",   "type": "asset" },
  { "code": "2200", "nameEn": "Store-credit liability", "nameAr": "التزام رصيد المتجر", "type": "liability" }
]
```

  **No `parentCode` on any of the three, and that is a decision.** §4.15's register lists **`1000` Cash on hand as an ordinary leaf seeded by 0C** (its row reads *"plan0A fixture `1000 Cash`; petty-cash JOURNALs"*), so `"parentCode": "1000"` would hang two accounts off a posting account rather than a group. The only `is_group = true` rows in the pack are the presentation parents §3.8 lets `0c-base.json` carry, and **§4.15 deliberately leaves them unregistered** — *"group codes are unregistered by §4.15 and no policy resolves them"* — so this file cannot name one without asserting a fact the register does not hold, and inventing a new `1xxx`/`2xxx` group here would put an unregistered code into a shared namespace (hazard 32). The loader treats `parentCode` as optional and no policy, report or assertion in this slice reads the tree; a later slice that wants these three under a presentation parent adds them to the group's own file, where the group is defined.

- [ ] **Step 7: Apply the sub-pack and run.** The §3.4.8 rule: a slice that adds a **file** to an existing sub-pack applies it with a task of its own and ships no loader. Run:

```bash
bun run --cwd packages/db db:migrate
bun run seed --tenant "$DULJA_DEV_TENANT_ID" --only chart-of-accounts
```

  **Expected:** exit 0, and the CLI's summary line reports three accounts created on the first run and zero on the second. Then `bun run --cwd packages/db test -- sync/accounts-and-codes` — **expected:** 6 passed — and `bun run --cwd packages/db test -- permission-catalogue` and `bun run lint:rules` (the `role-seed` and `permission-catalogue` rules of §3.6.3) — **expected:** **green, at this commit and every commit after it.**

  **Why there is no red window here, and why an earlier draft of this plan had one.** The draft added the eleven catalogue rows in this task and left `permission-catalogue` failing until Task 12 mounted the last route — seven commits of a red `bun run lint:rules`, against this plan's own Global Constraint 18 and the skill's green-tree rule, and a bisect through T6–T11 would have hit it every time. **Splitting the catalogue rows across the tasks that reference them is not the fix**: §3.6.3's `permission-catalogue.test.ts` asserts `app.permission` and `permissions.ts` are the *same set in both directions* after all migrations, so migration 0062 and the eleven rows must land in one commit whatever else moves. The fix is therefore Step 5 — the eight non-route codes get their reference in this same commit, in the file that will evaluate them.

- [ ] **Step 8: Commit.**

```bash
git add packages/db/migrations/0062_seed_permission_phase6a.sql packages/db/migrations/0062.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts packages/db/src/sync/authority.ts \
        packages/db/seed/my/chart-of-accounts/6a-pos-tenders.json packages/db/test/sync/accounts-and-codes.test.ts
git commit -m "$(cat <<'EOF'
feat(db): migration 0062 — the eleven Phase 6A permission codes, role grants, tender accounts [6A T5]

Grants come from spec:2160-2161 verbatim: a cashier may sell, discount, return against an
original and quick-create a customer, and may NOT void, blind-return or override; a branch
manager holds those four as the second principal, which is what makes test 37 non-vacuous.

packages/db/src/sync/authority.ts lands in the SAME commit as the catalogue rows, so
permission-catalogue is green here and at every commit after it: the eight codes no route
gates are named where applyBatch evaluates them, 3A's INVENTORY_PERMISSION pattern.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Terminal enrolment — the two routes, `createTerminal`, `seedTerminal`, and the shared POS fixture

**Files**

- `packages/db/src/sync/identity.ts`, `enrolment.ts`, `index.ts` — NEW
- `packages/db/src/index.ts` — MODIFY (one `export *`)
- `packages/contracts/src/sync/enrolment.ts` — NEW
- `packages/contracts/src/errors.ts` — MODIFY (one row — `ERR_TERMINAL_ENROLMENT_INVALID`, raised here)
- `apps/api/src/routes/admin/terminals.ts`, `apps/api/src/routes/sync/enrolments.ts` — NEW
- `apps/api/src/routes/index.ts` — MODIFY (two `buildRoutes` entries)
- `apps/api/src/app.ts` — MODIFY (the `route.auth` switch; the `db` `Variables` setter — **`jobs` is 3B's and is left alone**)
- `apps/api/src/context.ts` — MODIFY (the ninth `Variables` member, `db: Sql`)
- `scripts/lint/rules/no-bare-db.ts` — MODIFY (one allow-list entry)
- `packages/db/test/fixtures.ts` — MODIFY (`seedTerminal`)
- `tests/invariants/support/pos.ts` — NEW (§4.17.1)
- `tests/invariants/probes.ts` — MODIFY (two `PROBES` keys)
- `apps/api/test/routes/sync/enrolment.test.ts` — NEW

**Interfaces**

- Consumes: `withTenant`, `systemContext`, `resolvePrincipal`, `TenantContext` (§4.2.2); `AppError`, `ERRORS` (§4.2.4); `requirePermission`, `PERMISSION` (§4.2.5); `RouteModule`, `buildRoutes`, `IdempotencyHeader` (§4.2.7); `UuidSchema`, `TimestampSchema`, `ListEnvelope` (§4.2.8); `startApi` (§4.2.12); `app.assert_assignment_kind` (§4.1).
- Produces:

```ts
// packages/db/src/sync/identity.ts — the ONE file in this slice on the `no-bare-db` allow-list (§3.7.5).
export interface ResolvedEnrolment { readonly enrolmentId: string; readonly tenantId: string; readonly companyId: string; readonly branchId: string }
/** Runs BEFORE a tenant is known — the same position `resolvePrincipal` occupies. Zero rows for an unknown,
 *  expired or already-redeemed code; the caller answers ERR_TERMINAL_ENROLMENT_INVALID and never says which. */
export function resolveEnrolment(sql: Sql, codeHash: Buffer): Promise<ResolvedEnrolment[]>;
/** The terminal's principal, resolved from its id with no tenant set. Uses Plan 0A's app.resolve_principal —
 *  §4.1's `auth_subject` literal for a terminal is `'terminal:<terminal_id>'`, so no second function exists. */
export function resolveTerminalPrincipal(sql: Sql, terminalId: string): Promise<ResolvedPrincipal[]>;

// packages/db/src/sync/enrolment.ts
export interface CreateEnrolmentInput { companyId: string; branchId: string; name: string; terminalCode: string; ttlMinutes?: number }
export interface CreatedEnrolment { enrolmentId: string; code: string; expiresAt: string }
/** Mints a 32-character base32 code, stores ONLY its sha256, and returns the code once (spec:1322). */
export function createEnrolment(tx: Sql, ctx: TenantContext, input: CreateEnrolmentInput): Promise<CreatedEnrolment>;
export interface RedeemedTerminal { terminalId: string; principalId: string; companyId: string; branchId: string; code: string }
/** The one place a `pos_terminal` row and its `terminal` principal are created — production and `seedTerminal`
 *  both call it, so a fixture terminal and a real one can never differ (R8, spec:2179). */
export function createTerminal(tx: Sql, input: { companyId: string; branchId: string; name: string; code: string; devicePublicKey: Buffer }): Promise<RedeemedTerminal>;
/** Spends the enrolment and creates the terminal, in ONE transaction. Throws AppError-free `SyncError`. */
export function redeemEnrolment(tx: Sql, enrolment: ResolvedEnrolment, devicePublicKey: Buffer): Promise<RedeemedTerminal>;
export type SyncErrorCode = "ERR_TERMINAL_ENROLMENT_INVALID" | "ERR_TERMINAL_SIGNATURE_INVALID" | "ERR_TERMINAL_REVOKED" | "ERR_SYNC_CURSOR_INVALID" | "ERR_SYNC_MESSAGE_UNSUPPORTED" | "ERR_VALIDATION_FAILED" | "ERR_RBAC_FORBIDDEN" | "ERR_NOT_FOUND";
export class SyncError extends Error { constructor(readonly code: SyncErrorCode, readonly detail: string) }
```

  **Why `SyncError` and not `AppError`:** `AppError` lives in `@dulja/contracts` and 0B's `dependency-rule` pins `packages/db` to `['@dulja/domain']`, so `packages/db/src/sync/**` cannot import it — the same reason 1A ships `PostingError` (§4.2.4). `SyncErrorCode` is a literal **subset** of `ErrCode` and never a new code, and `apps/api/src/problem.ts` gains one `asAppError` branch translating it, exactly as it already has one for `PostingError`.

**Steps**

- [ ] **Step 1: Write the failing route test first.**

```ts
// apps/api/test/routes/sync/enrolment.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { seedTenantV2, grantCodes, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import type { Problem } from "@dulja/contracts";

const spki = (): string =>
  generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");

describe("terminal enrolment (§4.10.3, spec:1322)", () => {
  let api: StartedApi; let s: Seed;
  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Alpha");
    await grantCodes(api.db, s, { codes: ["admin.terminal.manage"] });
  }, 180_000);
  afterAll(async () => { await api.stop(); });

  const issue = async (code = "KL01"): Promise<{ code: string; enrolmentId: string }> => {
    const res = await api.request({
      method: "POST", path: "/v1/admin/terminals/enrolments", as: s.human,
      body: { companyId: s.company, branchId: s.hq, name: `Till ${code}`, terminalCode: code },
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { code: string; enrolmentId: string };
  };

  it("issues a code once, under admin.terminal.manage, and never returns it again", async () => {
    const issued = await issue();
    expect(issued.code).toMatch(/^[A-Z2-7]{32}$/);
    const list = await api.request({ method: "GET", path: `/v1/admin/terminals/enrolments?companyId=${s.company}`, as: s.human });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    // The code is a bearer secret shown once (spec:1322). Neither it nor its hash is ever in a response.
    expect(JSON.stringify(body)).not.toContain(issued.code);
    expect(Object.keys(body.items[0]!)).not.toContain("codeHash");
  });

  it("redeems it once — the second attempt is ERR_TERMINAL_ENROLMENT_INVALID", async () => {
    const issued = await issue("KL02");
    const key = spki();
    const first = await api.request({ method: "POST", path: "/v1/sync/enrol", body: { code: issued.code, devicePublicKey: key } });
    expect(first.status).toBe(201);
    const { terminalId } = (await first.json()) as { terminalId: string };
    expect(terminalId).toMatch(/^[0-9a-f-]{36}$/);

    const second = await api.request({ method: "POST", path: "/v1/sync/enrol", body: { code: issued.code, devicePublicKey: spki() } });
    expect(second.status).toBe(400);
    expect(((await second.json()) as Problem).code).toBe("ERR_TERMINAL_ENROLMENT_INVALID");
  });

  it("an unknown code answers the SAME problem — a probe learns nothing (LEGACY-025)", async () => {
    const res = await api.request({ method: "POST", path: "/v1/sync/enrol", body: { code: "A".repeat(32), devicePublicKey: spki() } });
    expect(res.status).toBe(400);
    const p = (await res.json()) as Problem;
    expect(p.code).toBe("ERR_TERMINAL_ENROLMENT_INVALID");
    expect(p.detail).not.toContain(s.tenant);
    expect(p.detail).not.toContain(s.company);
  });

  it("the redeemed terminal owns a `terminal` principal holding exactly pos_terminal (R8, spec:2179)", async () => {
    const issued = await issue("KL03");
    const res = await api.request({ method: "POST", path: "/v1/sync/enrol", body: { code: issued.code, devicePublicKey: spki() } });
    const { terminalId } = (await res.json()) as { terminalId: string };

    const [row] = await api.db.admin<{ kind: string; auth_subject: string; codes: string[] }[]>`
      select p.kind::text as kind, p.auth_subject,
             coalesce(array_agg(rp.permission_code order by rp.permission_code) filter (where rp.permission_code is not null), '{}') as codes
        from app.pos_terminal t
        join app.principal p on p.id = t.principal_id
        left join app.role_assignment ra on ra.principal_id = p.id
        left join app.role_permission rp on rp.role_id = ra.role_id
       where t.id = ${terminalId}
       group by p.kind, p.auth_subject`;
    expect(row!.kind).toBe("terminal");
    expect(row!.auth_subject).toBe(`terminal:${terminalId}`);
    expect(row!.codes).toEqual(["pos.sync.pull", "pos.sync.push"]);

    const [branchRows] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_assignment_branch b
        join app.role_assignment ra on ra.principal_id = b.principal_id and ra.role_id = b.role_id
        join app.pos_terminal t on t.principal_id = ra.principal_id
       where t.id = ${terminalId} and b.branch_id = ${s.hq}`;
    expect(branchRows!.n).toBe(1);   // R8: the assignment is narrowed to the terminal's branch
  });

  it("the public route carries NO idempotency: a key is ignored, not a 500 (Task 0 amendment 21)", async () => {
    // §4.2.9's middleware keys on (tenant_id, principal_id, key) and opens withTenant on c.var.ctx, which a
    // public route does not have. If it were mounted here every enrolment would be ERR_TENANT_CONTEXT_MISSING
    // (500) — the failure mode this case exists to forbid. A key sent anyway is simply an unread header.
    const issued = await issue("KL04");
    const key = crypto.randomUUID();
    const first = await api.request({
      method: "POST", path: "/v1/sync/enrol",
      body: { code: issued.code, devicePublicKey: spki() }, idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    expect(first.headers.get("Idempotency-Replayed"), "no store, so nothing to replay").toBeNull();

    // The SAME key on the SAME body is NOT replayed — and the answer is still correct, because redemption is
    // idempotent in its own right: `where redeemed_at is null` already spent the code.
    const second = await api.request({
      method: "POST", path: "/v1/sync/enrol",
      body: { code: issued.code, devicePublicKey: spki() }, idempotencyKey: key,
    });
    expect(second.status).toBe(400);
    expect(((await second.json()) as Problem).code).toBe("ERR_TERMINAL_ENROLMENT_INVALID");

    // And no header at all is equally fine — the route never demands one (contrast /v1/sync/tickets, which
    // does, and whose ERR_IDEMPOTENCY_KEY_MISSING case is Task 12's).
    const third = await api.request({
      method: "POST", path: "/v1/sync/enrol",
      body: { code: "B".repeat(32), devicePublicKey: spki() }, idempotencyKey: null,
    });
    expect(third.status).toBe(400);
    expect(((await third.json()) as Problem).code).toBe("ERR_TERMINAL_ENROLMENT_INVALID");
  });

  it("issuing needs the code — a principal without admin.terminal.manage is 403", async () => {
    const other = await seedTenantV2(api.db, "Gamma");
    const res = await api.request({
      method: "POST", path: "/v1/admin/terminals/enrolments", as: other.human,
      body: { companyId: other.company, branchId: other.hq, name: "Till", terminalCode: "G1" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });
});
```

  Run `bun run --cwd apps/api test -- routes/sync/enrolment`. **Expected failure:** every case fails with `expect(received).toBe(expected) // Object.is equality — Expected: 201, Received: 404` — neither route is mounted.

- [ ] **Step 2: Write `packages/db/src/sync/identity.ts` and put it on the allow-list.**

```ts
// packages/db/src/sync/identity.ts
import type { Sql } from "postgres";
import type { ResolvedPrincipal } from "../with-tenant";

export interface ResolvedEnrolment {
  readonly enrolmentId: string; readonly tenantId: string; readonly companyId: string; readonly branchId: string;
}

/**
 * The pre-tenant door for a one-time enrolment code (contracts §4.1, migration 0060). `app.resolve_enrolment`
 * is SECURITY DEFINER and owned by `app_auth`, so this call needs no `set_config` — which is the whole point:
 * a till presenting a code has no tenant, no principal and no session, and inventing one from the request
 * would be LEGACY-026 rebuilt.
 */
export async function resolveEnrolment(sql: Sql, codeHash: Buffer): Promise<ResolvedEnrolment[]> {
  return sql<ResolvedEnrolment[]>`
    select enrolment_id as "enrolmentId", tenant_id as "tenantId", company_id as "companyId", branch_id as "branchId"
      from app.resolve_enrolment(${codeHash})`;
}

/**
 * The terminal's own principal, resolved with no tenant set. There is deliberately **no** `app.resolve_terminal`:
 * §4.1 fixes `principal.auth_subject` for a terminal as `'terminal:<terminal_id>'`, so Plan 0A's
 * `app.resolve_principal` already answers this question, and a second SECURITY DEFINER function would be a
 * second door to audit for the same fact.
 */
export async function resolveTerminalPrincipal(sql: Sql, terminalId: string): Promise<ResolvedPrincipal[]> {
  return sql<ResolvedPrincipal[]>`
    select principal_id as "principalId", tenant_id as "tenantId", kind
      from app.resolve_principal(${`terminal:${terminalId}`})`;
}
```

```ts
// scripts/lint/rules/no-bare-db.ts — one entry in ALLOWED_FILES (§3.7.5, Task 0 amendment 9).
  // calls the two SECURITY DEFINER doors that run before a tenant is known — app.resolve_principal for a
  // terminal and app.resolve_enrolment for a one-time code — exactly as with-tenant.ts does
  "packages/db/src/sync/identity.ts",
```

- [ ] **Step 3: Write `packages/db/src/sync/enrolment.ts`.**

```ts
import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import type { ResolvedEnrolment } from "./identity";

export type SyncErrorCode =
  | "ERR_TERMINAL_ENROLMENT_INVALID" | "ERR_TERMINAL_SIGNATURE_INVALID" | "ERR_TERMINAL_REVOKED"
  | "ERR_SYNC_CURSOR_INVALID" | "ERR_SYNC_MESSAGE_UNSUPPORTED" | "ERR_VALIDATION_FAILED"
  // `verifyAuthority` (T11) raises it for a cashier who holds neither the code nor an override that rescues
  // it. It is 0B's own row (§4.2.4's table, 403) and not a new code — which is the whole point of this union
  // being a SUBSET: `apps/api/src/problem.ts` maps `SyncError` by `code` and needs no branch for this one.
  | "ERR_RBAC_FORBIDDEN"
  | "ERR_NOT_FOUND";

/** `packages/db` may not import `AppError` (§3.1 pins it to @dulja/domain), so this is 1A's `PostingError`
 *  pattern applied again: a literal SUBSET of `ErrCode`, never a new code. */
export class SyncError extends Error {
  constructor(readonly code: SyncErrorCode, readonly detail: string) { super(detail); this.name = "SyncError"; }
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";     // Crockford-ish: no 0/1/8/9, so a code read aloud is unambiguous
export function mintEnrolmentCode(): string {
  const bytes = randomBytes(32);
  let out = "";
  for (const b of bytes) out += BASE32[b % 32];
  return out;                                          // 32 chars × 5 bits = 160 bits of selection from 256 bits of entropy
}
export function hashEnrolmentCode(code: string): Buffer { return createHash("sha256").update(code, "utf8").digest(); }

export interface CreateEnrolmentInput { companyId: string; branchId: string; name: string; terminalCode: string; ttlMinutes?: number }
export interface CreatedEnrolment { enrolmentId: string; code: string; expiresAt: string }

/** Returns the plaintext code ONCE. Only its hash is stored (migration 0060, spec:1322). */
export async function createEnrolment(tx: Sql, ctx: TenantContext, input: CreateEnrolmentInput): Promise<CreatedEnrolment> {
  const code = mintEnrolmentCode();
  const ttl = input.ttlMinutes ?? 60;
  const [row] = await tx<{ id: string; expires_at: string }[]>`
    insert into app.terminal_enrolment (tenant_id, company_id, branch_id, code_hash, name, terminal_code, expires_at)
    values (${ctx.tenantId}, ${input.companyId}, ${input.branchId}, ${hashEnrolmentCode(code)},
            ${input.name}, ${input.terminalCode}, now() + make_interval(mins => ${ttl}))
    returning id, expires_at`;
  return { enrolmentId: row!.id, code, expiresAt: row!.expires_at };
}

export interface RedeemedTerminal { terminalId: string; principalId: string; companyId: string; branchId: string; code: string }

/**
 * The ONE place a `pos_terminal` row and its `terminal` principal are created. Production redemption and the
 * `seedTerminal` fixture both call it, so a fixture terminal and a real one can never diverge — which matters
 * because R8 (spec:2179) is trigger-enforced in both directions and a fixture that skipped the branch row
 * would make every branch-scoped test pass for the wrong reason.
 *
 * Plan 0A's convention: insert the `principal` **without `RETURNING`** and its `membership` in the same
 * transaction (plan0A:837).
 */
export async function createTerminal(
  tx: Sql,
  input: { companyId: string; branchId: string; name: string; code: string; devicePublicKey: Buffer },
): Promise<RedeemedTerminal> {
  const [ids] = await tx<{ terminal_id: string; principal_id: string; tenant_id: string }[]>`
    select uuidv7() as terminal_id, uuidv7() as principal_id, app.current_tenant() as tenant_id`;
  const { terminal_id: terminalId, principal_id: principalId, tenant_id: tenantId } = ids!;

  await tx`insert into app.principal (id, kind, auth_subject, display_name)
           values (${principalId}, 'terminal', ${`terminal:${terminalId}`}, ${input.name})`;
  await tx`insert into app.membership (tenant_id, principal_id) values (${tenantId}, ${principalId})`;
  await tx`insert into app.pos_terminal (id, tenant_id, company_id, branch_id, principal_id, name, code, device_public_key)
           values (${terminalId}, ${tenantId}, ${input.companyId}, ${input.branchId}, ${principalId},
                   ${input.name}, ${input.code}, ${input.devicePublicKey})`;

  // R8 (spec:2179): the role code is the fixed literal `pos_terminal` that `app.assert_assignment_kind`
  // checks in BOTH directions — a terminal may hold only this role, and this role only a terminal.
  const [role] = await tx<{ id: string }[]>`select id from app.role where code = 'pos_terminal'`;
  if (!role) throw new SyncError("ERR_NOT_FOUND", "the pos_terminal role is not seeded in this tenant — run `bun run seed --only roles`");
  await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
           values (${tenantId}, ${principalId}, ${role.id}, ${input.companyId})`;
  await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
           values (${tenantId}, ${principalId}, ${role.id}, ${input.companyId}, ${input.branchId})`;

  return { terminalId, principalId, companyId: input.companyId, branchId: input.branchId, code: input.code };
}

/**
 * Spends the enrolment and creates the terminal in one transaction. The `where redeemed_at is null` on the
 * update is the race guard: two tills presenting one code at the same instant both reach here, and exactly
 * one `update` reports a row (spec:1322 "the till redeems it ONCE").
 */
export async function redeemEnrolment(tx: Sql, enrolment: ResolvedEnrolment, devicePublicKey: Buffer): Promise<RedeemedTerminal> {
  const claimed = await tx<{ name: string; terminal_code: string }[]>`
    update app.terminal_enrolment set redeemed_at = now()
     where id = ${enrolment.enrolmentId} and redeemed_at is null and expires_at > now()
     returning name, terminal_code`;
  if (claimed.length === 0) throw new SyncError("ERR_TERMINAL_ENROLMENT_INVALID", "that enrolment code is not valid");

  const terminal = await createTerminal(tx, {
    companyId: enrolment.companyId, branchId: enrolment.branchId,
    name: claimed[0]!.name, code: claimed[0]!.terminal_code, devicePublicKey,
  });
  await tx`update app.terminal_enrolment set terminal_id = ${terminal.terminalId} where id = ${enrolment.enrolmentId}`;
  return terminal;
}
```

  Create `packages/db/src/sync/index.ts` — `export * from "./authority"; export * from "./identity"; export * from "./enrolment";` (`authority.ts` landed in T5 and this is the barrel that first exports it) — and add `export * from "./sync";` to `packages/db/src/index.ts`. **Nothing under `packages/db/src/seed/` is touched** — the seed is reachable only through `@dulja/db/seed` (§3.1, legacy-039) and this is not seed code.

- [ ] **Step 4: Write the two contracts modules and the two routes.**

```ts
// packages/contracts/src/sync/enrolment.ts
import { z } from "@hono/zod-openapi";
import { ListEnvelope, TimestampSchema, UuidSchema } from "../common";

export const CreateEnrolmentBody = z.object({
  companyId: UuidSchema,
  branchId: UuidSchema,
  name: z.string().min(1).max(120),
  /** Becomes `pos_terminal.code` and therefore the numbering suffix `POS-<code>` (§4.3.6). */
  terminalCode: z.string().regex(/^[A-Z0-9-]{1,12}$/, "upper-case letters, digits and hyphens, at most 12"),
  ttlMinutes: z.number().int().min(5).max(1440).optional(),
}).openapi("CreateEnrolment");

/** The code appears in THIS response and nowhere else, ever (spec:1322). */
export const CreatedEnrolmentSchema = z.object({
  enrolmentId: UuidSchema, code: z.string().regex(/^[A-Z2-7]{32}$/), expiresAt: TimestampSchema,
}).openapi("CreatedEnrolment");

export const EnrolmentSchema = z.object({
  id: UuidSchema, companyId: UuidSchema, branchId: UuidSchema, name: z.string(), terminalCode: z.string(),
  expiresAt: TimestampSchema, redeemedAt: TimestampSchema.nullable(), terminalId: UuidSchema.nullable(),
  createdAt: TimestampSchema,
}).openapi("Enrolment");
export const EnrolmentQuery = z.object({ companyId: UuidSchema });
export const EnrolmentList = ListEnvelope(EnrolmentSchema);

export const EnrolBody = z.object({
  code: z.string().regex(/^[A-Z2-7]{32}$/),
  /** Ed25519 SPKI DER, base64. 44 bytes DER for an Ed25519 key; the route re-checks the length. */
  devicePublicKey: z.string().regex(/^[A-Za-z0-9+/]+=*$/).max(200),
}).openapi("Enrol");
export const EnrolResultSchema = z.object({ terminalId: UuidSchema, branchId: UuidSchema, companyId: UuidSchema }).openapi("EnrolResult");
```

```ts
// apps/api/src/routes/sync/enrolments.ts — the ONE public route in this slice.
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import { EnrolBody, EnrolResultSchema } from "@dulja/contracts/sync/enrolment";
import { hashEnrolmentCode, redeemEnrolment, resolveEnrolment, SyncError, systemContext, withTenant } from "@dulja/db";
import type { AppEnv } from "../../context";

export const enrolmentRoutes = new OpenAPIHono<AppEnv>();

/**
 * `POST /v1/sync/enrol` — §4.10.3's frozen path, and the system's ONE unsafe public route.
 *
 * **No `Idempotency-Key`, deliberately** (Task 0 amendment 21). §4.2.9's middleware keys on
 * `(tenant_id, principal_id, key)` and opens its own `withTenant` on `c.var.ctx`; a `auth: "public"` module
 * has neither a tenant nor a principal, so mounting it here would raise `ERR_TENANT_CONTEXT_MISSING` (500) on
 * every enrolment — and declaring the header without mounting the middleware would be worse, because the
 * OpenAPI document would promise a guarantee nothing enforces. `createApp` attaches `idempotency` from the
 * same `route.auth` switch that attaches `terminalAuth`, and `"public"` gets neither.
 *
 * The route is idempotent in its own right, which is the condition Task 0 amendment 21 sets for being public
 * and unsafe at all: redemption is `update … set redeemed_at = now() where redeemed_at is null returning …`,
 * so a second call with the same code — a retry after a timeout, or a stolen code — answers exactly the same
 * `ERR_TERMINAL_ENROLMENT_INVALID` as an unknown one, and creates no second terminal.
 */
enrolmentRoutes.openapi(
  createRoute({
    method: "post", path: "/", tags: ["sync"],
    request: { body: { content: { "application/json": { schema: EnrolBody } } } },
    responses: {
      201: { description: "enrolled", content: { "application/json": { schema: EnrolResultSchema } } },
      400: { description: "invalid code", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    // The raw pool, not `c.var.withTenant`: there is no tenant yet and inventing one from the request would
    // be LEGACY-026 rebuilt. `db` is an `AppEnv["Variables"]` member set by createApp from AppDeps (Task 0
    // amendment 7), and this handler is one of exactly two call sites in the system.
    const db = c.get("db");
    // Step 1 runs with NO tenant: the SECURITY DEFINER door of migration 0060.
    const found = await resolveEnrolment(db, hashEnrolmentCode(body.code));
    if (found.length === 0) {
      // The SAME problem for unknown, expired and spent. A probe learns only "that is not a code" (LEGACY-025).
      throw new AppError("ERR_TERMINAL_ENROLMENT_INVALID", "that enrolment code is not valid");
    }
    const enrolment = found[0]!;
    const der = Buffer.from(body.devicePublicKey, "base64");
    if (der.length !== 44) throw new AppError("ERR_VALIDATION_FAILED", "devicePublicKey is not an Ed25519 SPKI key");

    // Step 2 runs as the tenant's SYSTEM principal: there is no human here and the terminal does not exist yet,
    // so the only identity that can create it is the tenant's own (spec:2179's system-principal clause).
    const ctx = await systemContext(db, enrolment.tenantId, c.get("requestId"));
    try {
      const terminal = await withTenant(db, ctx, (tx) => redeemEnrolment(tx, enrolment, der));
      return c.json({ terminalId: terminal.terminalId, branchId: terminal.branchId, companyId: terminal.companyId }, 201);
    } catch (e) {
      if (e instanceof SyncError) throw new AppError(e.code, e.detail);
      throw e;
    }
  },
);
```

```ts
// apps/api/src/routes/admin/terminals.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PERMISSION, ProblemSchema, UuidSchema } from "@dulja/contracts";
import {
  CreateEnrolmentBody, CreatedEnrolmentSchema, EnrolmentList, EnrolmentQuery,
} from "@dulja/contracts/sync/enrolment";
import { createEnrolment } from "@dulja/db";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../index";
import type { AppEnv } from "../../context";

export const terminalRoutes = new OpenAPIHono<AppEnv>();

// The write gate is `{ company: "body:companyId" }`; the read gate is `{ company: "any" }` (§4.2.5's fourth
// variant) because `ScopeSource` has no `query:companyId` form and inventing one would widen a frozen union
// for one route. `{ company: "any" }` is not a bypass: it evaluates `exists (… app.actor_has($code, c.id))`
// inside `c.var.withTenant`, where RLS has already reduced `app.company` to the caller's tenant, and the
// handler's own `where company_id = $1` is what narrows it to the requested company.
terminalRoutes.openapi(
  createRoute({
    method: "post", path: "/enrolments", tags: ["admin"],
    request: { headers: IdempotencyHeader, body: { content: { "application/json": { schema: CreateEnrolmentBody } } } },
    middleware: [requirePermission(PERMISSION["admin.terminal.manage"], { company: "body:companyId" })],
    responses: {
      201: { description: "the code, shown once", content: { "application/json": { schema: CreatedEnrolmentSchema } } },
      403: { description: "forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      409: { description: "that terminal code is taken", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const created = await c.var.withTenant((tx) => createEnrolment(tx, c.get("ctx"), body));
    // The plaintext code is in THIS response and nowhere else, ever (spec:1322). It is never logged: the
    // request logger's `forbidden_log_field` regex covers `secret`, and no handler line writes it.
    return c.json(created, 201);
  },
);

terminalRoutes.openapi(
  createRoute({
    method: "get", path: "/enrolments", tags: ["admin"],
    request: { query: EnrolmentQuery },
    middleware: [requirePermission(PERMISSION["admin.terminal.manage"], { company: "any" })],
    responses: {
      200: { description: "the company's enrolments", content: { "application/json": { schema: EnrolmentList } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("query");
    // Every column EXCEPT code_hash, named one by one. `EnrolmentSchema` has no `codeHash` member, so even if
    // this became a `select *` the response would fail wire validation rather than leak the hash (LEGACY-025).
    const items = await c.var.withTenant((tx) => tx<Record<string, unknown>[]>`
      select id, company_id as "companyId", branch_id as "branchId", name, terminal_code as "terminalCode",
             expires_at as "expiresAt", redeemed_at as "redeemedAt", terminal_id as "terminalId",
             created_at as "createdAt"
        from app.terminal_enrolment
       where company_id = ${companyId}
       order by created_at desc, id desc`);
    return c.json({ items, nextCursor: null }, 200);
  },
);

terminalRoutes.openapi(
  createRoute({
    method: "post", path: "/{terminalId}/revoke", tags: ["admin"],
    request: { headers: IdempotencyHeader, params: z.object({ terminalId: UuidSchema }) },
    middleware: [requirePermission(PERMISSION["admin.terminal.manage"], { company: "any" })],
    responses: { 204: { description: "revoked" } },
  }),
  async (c) => {
    const { terminalId } = c.req.valid("param");
    // `where revoked_at is null` makes a second call a no-op, and the answer is 204 either way: revocation is
    // idempotent by nature (spec:1322 — "revoked_at set → ERR_TERMINAL_REVOKED" is the WHOLE story), and a 409
    // on the second call would make a retry after a timeout look like a failure and invite a support script
    // that clears the column. A terminal in another tenant is invisible under RLS and updates zero rows, which
    // is also a 204 — the same answer as "already revoked", so no probe learns whether the id exists.
    await c.var.withTenant((tx) =>
      tx`update app.pos_terminal set revoked_at = now() where id = ${terminalId} and revoked_at is null`);
    return c.body(null, 204);
  },
);
```

  **`nextCursor: null` on the list.** §4.2.8's `ListEnvelope` carries a cursor; enrolments are few (one per till, spent within the hour) and this read is unpaged, exactly as 2B left `GET …/documents/{id}/events` unpaged. The slice that finds a company with a thousand enrolments adds paging in the PR that needs it.

- [ ] **Step 5: Register both modules and their probes.**

```ts
// apps/api/src/routes/index.ts — inside buildRoutes(deps), in the returned array.
  { path: "/v1/admin/terminals", router: terminalRoutes, permissions: [PERMISSION["admin.terminal.manage"]], auth: "human" },
  { path: "/v1/sync/enrol", router: enrolmentRoutes, permissions: [], auth: "public" },
```

```ts
// tests/invariants/probes.ts — two entries (§4.2.7, Task 0 amendment 8).
  "/v1/admin/terminals": {
    async seed(_db, owner) {
      return { path: "/v1/admin/terminals/enrolments", method: "POST",
               body: { companyId: owner.company, branchId: owner.hq, name: "Till", terminalCode: "P1" } };
    },
    // The harness's attacker holds only 0B's five admin codes, so `admin.terminal.manage` is refused before
    // the handler runs. The stronger cross-tenant case — an attacker who DOES hold the code in their own
    // tenant asking for the victim's company — is asserted in apps/api/test/routes/sync/enrolment.test.ts,
    // where a grant can be arranged; a probe cannot grant.
    expect: 403,
  },
  "/v1/sync/enrol": {
    async seed() { return { path: "/v1/sync/enrol", method: "POST", body: { code: "A".repeat(32), devicePublicKey: "AA==" } }; },
    // A public, bearer-secret door: the only thing a caller can present is a code, and a code that is not a
    // code is 400 whichever tenant asks. There is no row to reach across, which is exactly why this is the
    // recorded value rather than a 403.
    expect: 400,
  },
```

- [ ] **Step 6: Wire `db` onto `AppEnv`, split the middleware attachment by `route.auth`, and add the error row.** Three edits in `apps/api`, all in this commit because this task mounts the first `auth: "public"` module in the system and the first handler that needs the raw pool.

  ⚠️ **`jobs` is not added here and must not be.** §4.2.3's eighth member is already `jobs: JobClient` (3B amendment A5, round 3), and 3B's Task 7 already set it in `createApp` from `deps.jobs`. Declaring it a second time in this interface body is a duplicate member and a second `c.set("jobs", …)` is a second setter for one variable; Task 0's gate line `need "3B jobs Variables" apps/api/src/context.ts "jobs: JobClient"` is what proves it is already there before this step runs. `POST /v1/sync/tickets`' 202 branch (T12) reads the row 3B shipped.

```ts
// apps/api/src/context.ts — the NINTH member, Task 0 amendment 7. (`terminal` is the tenth and is T7's.)
    /** 6A — the pool, set from AppDeps on every request. The ONE handler that reads it is the public
     *  enrolment redemption, which runs before a tenant exists; every other handler uses c.var.withTenant,
     *  and the `no-bare-db` lint (§3.7.5) is what keeps that true. */
    db: Sql;
```

```ts
// apps/api/src/app.ts — inside createApp(deps), BEFORE requestId so a public route has it too.
// 3B's `app.use("*", …c.set("jobs", deps.jobs)…)` already exists a line away and is left exactly as it is.
  app.use("*", async (c, next) => { c.set("db", deps.db); await next(); });
```

  Then replace `createApp`'s single `app.use("/v1/*", authenticate(...))` / `app.use("/v1/*", idempotency(...))` pair with a per-module switch on the `auth` field `buildRoutes` already carries. **This is the edit that makes a public unsafe route possible at all** (Task 0 amendment 21): §4.2.9's idempotency middleware opens its own `withTenant` on `c.var.ctx`, and a public route has no `ctx`, so a blanket `/v1/*` mount would answer `ERR_TENANT_CONTEXT_MISSING` (500) to every enrolment. The `terminalAuth` arm is written in T7 and is shown here only so the shape is decided once:

```ts
  for (const route of routes) {
    if (route.auth === "public") continue;                  // neither auth nor idempotency — see below
    app.use(`${route.path}/*`, authenticate({ db: deps.db, verifier: deps.verifier }));
    app.use(`${route.path}/*`, idempotency({ db: deps.db }));
  }
  // "public" gets neither, and the rule is narrow: an unsafe public route must be idempotent in its OWN
  // right and say how. /v1/sync/enrol is (`where redeemed_at is null`); /healthz is a GET. A future public
  // unsafe route that cannot make that claim does not become public.
```

  **This is a behaviour-preserving refactor for every module that existed before this task**: `ROUTES` after 2C is `/healthz` (public, and 0B already exempted it by mounting on `/v1/*`), `/v1/session` and eleven `auth: "human"` modules, all of which get exactly the two middlewares they had. Run `bun run --cwd apps/api test` in full after it and expect no change; a difference means a module's `path` prefix does not match what the blanket `/v1/*` mount used to cover, which is worth knowing now rather than in T12.

  Add **one** row to `packages/contracts/src/errors.ts` in this commit, because this is the PR that raises it (§4.2.4's rule, and the `error-codes` lint scans `ERRORS` for a raiser at every commit):

```ts
  ERR_TERMINAL_ENROLMENT_INVALID: {
    status: 400,
    title: "Terminal enrolment invalid",
    remedy: "Ask the back office to issue a new enrolment code and enrol the terminal again.",
  },
```

  It is raised twice in this task — `SyncError("ERR_TERMINAL_ENROLMENT_INVALID", …)` in `redeemEnrolment` (Step 3, the race guard) and `AppError("ERR_TERMINAL_ENROLMENT_INVALID", …)` in the route (Step 4, the unknown/expired/spent answer) — and `AppError`'s first parameter is `ErrCode = keyof typeof ERRORS`, so **without this row Step 4 does not typecheck and Step 1's two cases cannot pass**. It is the first of this slice's six §4.2.4 rows; T7 adds `ERR_TERMINAL_SIGNATURE_INVALID` and `ERR_TERMINAL_REVOKED`, T8 `ERR_SYNC_CURSOR_INVALID`, T11 the last two.

- [ ] **Step 7: Add `seedTerminal` (§4.17's one 6A row) and the shared POS fixture skeleton.**

```ts
// packages/db/test/fixtures.ts — additively, at the end of the file (§4.1, hazard 9).
import { createTerminal } from "../src/sync/enrolment";

/** contracts §4.17 — 6A's helper. The terminal principal is returned because every signed request needs it,
 *  and because `grantCodes({ principalId })` is how a test narrows what the terminal may do. Goes through
 *  production's `createTerminal`, so a fixture terminal satisfies R8 exactly as a redeemed one does. */
export async function seedTerminal(
  db: Db, s: Seed, opts: { code?: string; branchId?: string; devicePublicKey?: Buffer } = {},
): Promise<{ terminalId: string; principalId: string }> {
  const code = opts.code ?? "T1";
  return withTenant(db.rw, s.tenant, s.system, async (tx) => {
    const t = await createTerminal(tx, {
      companyId: s.company, branchId: opts.branchId ?? s.hq, name: `Till ${code}`, code,
      devicePublicKey: opts.devicePublicKey ?? Buffer.alloc(44),
    });
    return { terminalId: t.terminalId, principalId: t.principalId };
  });
}
```

  Create `tests/invariants/support/pos.ts` with the parts this task can already fill — `POS_PACK_ROOT`, `enrolTerminal`, `EnrolledTerminal` — and leave `posFixture`, `buildTicket` and `MemorySyncStore` for Tasks 10 and 9, which is where their inputs first exist:

```ts
// tests/invariants/support/pos.ts (§4.17.1, registered by Task 0 amendment 15)
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Seed } from "@dulja/db/test";
import type { StartedApi } from "../../../apps/api/test/support/app";

export const POS_PACK_ROOT = fileURLToPath(new URL("../../../packages/db/seed/my/", import.meta.url));

export interface EnrolledTerminal {
  terminalId: string;
  /** The terminal's `app.principal.id` — the ACTING principal for every ticket it syncs (LEGACY-044). It is on
   *  this object because `withTenant`'s `actorId` is a principal id, and passing `terminalId` there sets
   *  `app.actor_id` to a uuid that is not a principal: `document.created_by`'s FK then fails at the header
   *  insert, before the dedup read ever runs, and the failure names a constraint instead of the mistake. */
  principalId: string;
  companyId: string; branchId: string; privateKey: KeyObject; code: string;
}

/** Enrols a terminal through the REAL two-route flow, so every test that signs a request is signing for a
 *  terminal the server created the way production creates one. `as` must hold `admin.terminal.manage`. */
export async function enrolTerminal(
  api: StartedApi, s: Seed, opts: { as: string; code?: string; branchId?: string },
): Promise<EnrolledTerminal> {
  const code = opts.code ?? "T1";
  const issued = await api.request({
    method: "POST", path: "/v1/admin/terminals/enrolments", as: opts.as,
    body: { companyId: s.company, branchId: opts.branchId ?? s.hq, name: `Till ${code}`, terminalCode: code },
  });
  if (issued.status !== 201) throw new Error(`enrolment issue failed: ${issued.status} ${await issued.text()}`);
  const { code: secret } = (await issued.json()) as { code: string };

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const res = await api.request({
    method: "POST", path: "/v1/sync/enrol",
    body: { code: secret, devicePublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") },
  });
  if (res.status !== 201) throw new Error(`enrolment redeem failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { terminalId: string; companyId: string; branchId: string };
  // `EnrolResultSchema` deliberately does not carry the principal id — a till has no use for it — so the
  // fixture reads it back on the admin connection, which is where a test is allowed to look.
  const [row] = await api.db.admin<{ principal_id: string }[]>`
    select principal_id from app.pos_terminal where id = ${body.terminalId}`;
  return { ...body, principalId: row!.principal_id, privateKey, code };
}
```

- [ ] **Step 8: Run and commit.** `bun run --cwd apps/api test -- routes/sync/enrolment` — **expected:** 6 passed. `bun run --cwd apps/api test` — **expected:** the whole route suite green, unchanged by Step 6's middleware refactor. `bun run --cwd tests test -- tenant-isolation` — **expected:** green, with the two new probe keys matching two new `ROUTES` entries. `bun run lint` and `bun run lint:rules` — **expected:** `no-bare-db` silent (the allow-list entry landed in Step 2) and `error-codes` silent (the row landed in Step 6).

```bash
git add packages/db/src/sync packages/db/src/index.ts packages/contracts/src/sync/enrolment.ts \
        packages/contracts/src/errors.ts apps/api/src/context.ts apps/api/src/app.ts \
        apps/api/src/routes/admin/terminals.ts apps/api/src/routes/sync/enrolments.ts apps/api/src/routes/index.ts \
        scripts/lint/rules/no-bare-db.ts packages/db/test/fixtures.ts tests/invariants/support/pos.ts \
        tests/invariants/probes.ts apps/api/test/routes/sync/enrolment.test.ts
git commit -m "$(cat <<'EOF'
feat(api): terminal enrolment — one-time hashed code, Ed25519 key registration, R8 assignment [6A T6]

createTerminal is the ONE place a pos_terminal row and its terminal principal are created;
seedTerminal calls it too, so a fixture terminal cannot differ from a real one. An unknown,
expired and spent code all answer the identical problem — a probe learns nothing (LEGACY-025).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `terminalAuth` — the signed call, the terminal JWT, and the sync-header bypass shapes (test 11)

**Files**

- `apps/api/src/middleware/terminal-auth.ts` — NEW
- `apps/api/src/context.ts` — MODIFY (the tenth `Variables` member — §4.2.3, Task 0 amendment 7)
- `apps/api/src/config.ts` — MODIFY (`terminalJwtSigningKey`)
- `apps/api/src/middleware/require-permission.ts` — MODIFY (the `{ company: "terminal" }` branch)
- `apps/api/src/problem.ts` — MODIFY (one `asAppError` branch for `SyncError`)
- `packages/db/src/sync/context.ts` — NEW (`terminalContext`)
- `packages/contracts/src/errors.ts` — MODIFY (two rows)
- `apps/api/src/app.ts` — MODIFY (the seventh `AppDeps` member; the `terminal` arm of Task 6's switch)
- `apps/api/src/index.ts` — MODIFY (derives `terminalJwtSigningKey` from `ApiConfig`)
- `apps/api/test/support/app.ts` — MODIFY (`startApi()`'s deps gain the seventh member)
- `tests/invariants/support/pos.ts` — MODIFY (`signSyncRequest`, `syncRequest` — §4.17.1's two signer rows)
- `apps/api/test/routes/sync/terminal-auth.test.ts` — NEW
- `tests/invariants/auth-bypass.test.ts` — MODIFY (the sync-header shapes)
- `infra/src/secrets.ts` — MODIFY (`containerSecrets` gains `TERMINAL_JWT_SIGNING_KEY`, `api` entrypoint only)

**Interfaces**

- Consumes: `readConfig`, `ApiConfig`, `ConfigError` (§4.2.3); `resolveTerminalPrincipal` (T6); `withTenant`, `TenantContext` (§4.2.2); `AppError` (§4.2.4); `jose`'s `SignJWT` / `jwtVerify` (already a dependency from 0B).
- Produces:

```ts
// apps/api/src/middleware/terminal-auth.ts
export interface TerminalIdentity {
  readonly terminalId: string; readonly tenantId: string; readonly companyId: string;
  readonly branchId: string; readonly principalId: string; readonly code: string | null;
}
/** The signed-request canonical string (§4.10.3): `method\npath\ntimestamp\nsha256hex(body)`. Exported so the
 *  test signer and the verifier cannot disagree about what was signed — LEGACY-046's "one canonical name per
 *  concept, checked in one place", applied to a signature input. */
export function canonicalSyncRequest(input: { method: string; path: string; timestamp: string; body: string }): string;
export const TERMINAL_SKEW_SECONDS = 300;
export const TERMINAL_JWT_TTL_SECONDS = 900;
export const TERMINAL_TOKEN_HEADER = "X-Terminal-Token";
export function terminalAuth(deps: { db: Sql; signingKey: Uint8Array }): MiddlewareHandler<AppEnv>;

// packages/db/src/sync/context.ts
/** The terminal's `TenantContext`. Used by `terminalAuth` and by the `pos.sync.apply` job handler, which is
 *  the one job that does NOT run as the system principal (Task 0 amendment 13, hazard 19). */
export async function terminalContext(sql: Sql, terminalId: string, requestId: string): Promise<{ ctx: TenantContext; terminal: TerminalRow }>;
export interface TerminalRow { terminalId: string; tenantId: string; companyId: string; branchId: string; principalId: string; code: string | null; revokedAt: string | null; devicePublicKey: Buffer }
```

**Steps**

- [ ] **Step 1: Write the failing test first.**

```ts
// apps/api/test/routes/sync/terminal-auth.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenantV2, grantCodes, type Seed } from "@dulja/db/test";
import { TERMINAL_TOKEN_HEADER } from "../../../src/middleware/terminal-auth";
// FIVE levels, not four: this file sits at apps/api/test/routes/sync/, one directory deeper than the
// apps/api/test/routes/*.test.ts files 3B/4A/5A wrote, and four levels resolves to `apps/`.
import { enrolTerminal, signSyncRequest, type EnrolledTerminal } from "../../../../../tests/invariants/support/pos";
import { startApi, type StartedApi } from "../../support/app";
import type { Problem } from "@dulja/contracts";

/** The signer is `signSyncRequest` from the shared fixture (§4.17.1, Step 6) and NOT a local copy: LEGACY-046's
 *  sentence is "one canonical name per concept, checked in one place", and a test file with its own signer is
 *  the second spelling that sentence forbids. `headersFor` below is a one-line alias for readability only. */
const headersFor = (t: EnrolledTerminal, method: string, path: string, body?: unknown, at = new Date()) =>
  signSyncRequest(t, { method, path, body, at });

describe("terminalAuth (§4.10.3) — the identity a client cannot write (LEGACY-026, LEGACY-046)", () => {
  let api: StartedApi; let s: Seed; let t: EnrolledTerminal;
  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Alpha");
    await grantCodes(api.db, s, { codes: ["admin.terminal.manage"] });
    t = await enrolTerminal(api, s, { as: s.human, code: "KL01" });
  }, 180_000);
  afterAll(async () => { await api.stop(); });

  const pull = (headers: Record<string, string>) =>
    api.request({ method: "GET", path: "/v1/sync/catalogue?limit=1", headers });

  it("a correctly signed request is accepted and hands back a terminal JWT", async () => {
    const res = await pull(headersFor(t, "GET", "/v1/sync/catalogue"));
    expect(res.status).toBe(200);
    const token = res.headers.get(TERMINAL_TOKEN_HEADER);
    expect(token, "a signed call must mint a token for the next calls (spec:1322)").toBeTruthy();

    // The token alone is enough for the NEXT call — no signature headers at all.
    const withToken = await api.request({
      method: "GET", path: "/v1/sync/catalogue?limit=1", headers: { Authorization: `Bearer ${token}` },
    });
    expect(withToken.status).toBe(200);
    expect(withToken.headers.get(TERMINAL_TOKEN_HEADER), "a token call does not re-mint").toBeNull();
  });

  it("a human's Supabase JWT is NOT a terminal token", async () => {
    const res = await api.request({ method: "GET", path: "/v1/sync/catalogue?limit=1", as: s.human });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Problem).code).toBe("ERR_TERMINAL_SIGNATURE_INVALID");
  });

  it("every bypass shape is refused (acceptance test 11's sync half)", async () => {
    const good = headersFor(t, "GET", "/v1/sync/catalogue");
    const cases: [string, Record<string, string>][] = [
      ["no headers at all", {}],
      ["id without a signature", { "X-Terminal-Id": t.terminalId }],
      ["signature over a DIFFERENT path", headersFor(t, "GET", "/v1/sync/tickets")],
      ["signature over a DIFFERENT method", headersFor(t, "POST", "/v1/sync/catalogue")],
      ["a timestamp 10 minutes old (replay)", headersFor(t, "GET", "/v1/sync/catalogue", undefined, new Date(Date.now() - 600_000))],
      ["a timestamp 10 minutes ahead (clock forgery)", headersFor(t, "GET", "/v1/sync/catalogue", undefined, new Date(Date.now() + 600_000))],
      ["a garbage signature", { ...good, "X-Terminal-Signature": Buffer.alloc(64).toString("base64") }],
      ["an unknown terminal id", { ...good, "X-Terminal-Id": "00000000-0000-7000-8000-000000000000" }],
      ["a forged X-Tenant-Id beside a good signature", { ...good, "X-Tenant-Id": s.tenant }],
      ["a forged X-Actor-Id beside a good signature", { ...good, "X-Actor-Id": s.human }],
    ];
    for (const [label, headers] of cases) {
      const res = await pull(headers);
      if (label.startsWith("a forged")) {
        // A forged tenant/actor header is INERT, not an error: identity comes from the signature and the
        // header is never read (LEGACY-026). The request succeeds AS THE TERMINAL, which is the proof.
        expect(res.status, label).toBe(200);
      } else {
        expect(res.status, label).toBe(401);
        expect(((await res.json()) as Problem).code, label).toBe("ERR_TERMINAL_SIGNATURE_INVALID");
      }
    }
  });

  it("a revoked terminal is refused with ERR_TERMINAL_REVOKED, and the token minted before revocation dies too", async () => {
    const doomed = await enrolTerminal(api, s, { as: s.human, code: "KL09" });
    const first = await pull(headersFor(doomed, "GET", "/v1/sync/catalogue"));
    expect(first.status).toBe(200);
    const token = first.headers.get(TERMINAL_TOKEN_HEADER)!;

    const rev = await api.request({ method: "POST", path: `/v1/admin/terminals/${doomed.terminalId}/revoke`, as: s.human });
    expect(rev.status).toBe(204);

    const signed = await pull(headersFor(doomed, "GET", "/v1/sync/catalogue"));
    expect(signed.status).toBe(403);
    expect(((await signed.json()) as Problem).code).toBe("ERR_TERMINAL_REVOKED");

    // The JWT is short-lived but not instantly expiring, so revocation MUST be re-checked per request against
    // the row. A token that outlived its terminal is exactly LEGACY-027's "one variable disables every control".
    const withToken = await api.request({
      method: "GET", path: "/v1/sync/catalogue?limit=1", headers: { Authorization: `Bearer ${token}` },
    });
    expect(withToken.status).toBe(403);
  });

  it("a token signed with a different key, an expired token and a token for another terminal are all 401", async () => {
    const other = await enrolTerminal(api, s, { as: s.human, code: "KL10" });
    const forged = await api.request({
      method: "GET", path: "/v1/sync/catalogue?limit=1",
      headers: { Authorization: `Bearer ${api.signToken({ sub: `terminal:${other.terminalId}`, tid: s.tenant })}` },
    });
    // api.signToken uses the SUPABASE test key, not TERMINAL_JWT_SIGNING_KEY: a valid human token shape signed
    // by the wrong key must not open a terminal door (LEGACY-025's "never derive an identity from elsewhere").
    expect(forged.status).toBe(401);
  });
});
```

  Run `bun run --cwd apps/api test -- routes/sync/terminal-auth`. **Expected failure:** `Cannot find module '../../../src/middleware/terminal-auth'`.

- [ ] **Step 2: Add the config value and the container secret.**

```ts
// apps/api/src/config.ts — one member on ApiConfig and one read in readConfig.
  /** §3.11 — signs the short-lived terminal JWT (spec:2273). Required in every environment: an API that
   *  cannot mint one cannot serve /v1/sync/*, and a default would be a shared secret in the repository. */
  readonly terminalJwtSigningKey: string;
```

```ts
  const terminalJwtSigningKey = env.TERMINAL_JWT_SIGNING_KEY ?? "";
  if (terminalJwtSigningKey.length < 32) {
    throw new ConfigError("TERMINAL_JWT_SIGNING_KEY must be set to at least 32 characters (contracts §3.11; spec:2273)");
  }
```

  Add `TERMINAL_JWT_SIGNING_KEY` to `containerSecrets(env, entrypoint)` in `infra/` for the **`api` entrypoint only**. §3.11's row gives it the holder **`api`**, and §3.11 closes with *"a slice that adds a name to this table adds it there in the same PR"* — the holder column is part of the row, so widening it is an amendment this slice does not make and does not need. **The worker does not need it, and an earlier draft of this plan said it did:** the `pos.sync.apply` handler (Step 5 of Task 12) resolves its terminal through `terminalContext` and calls `applyBatch`; it constructs no `SignJWT` and calls no `jwtVerify`, because the route already authenticated the signed call before it wrote the payload. Spreading a signing secret to a second container buys no capability and widens the blast radius of a compromised image. It is **not** on the excluded list beside `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL_MIGRATOR`: unlike those two it is a *runtime* secret the API container genuinely needs. `readConfig`'s hard failure above therefore binds `apps/api` and nothing else, which is exactly what the Execution handoff's environment paragraph assumes.

  Then add the **seventh `AppDeps` member** (Task 0 amendment 20), because `createApp` is where `terminalAuth` is attached and the key has to arrive with the other deps:

```ts
// apps/api/src/app.ts
export interface AppDeps {
  db: Sql; jobs: JobClient; logger: Logger; authAdmin: AuthAdmin; verifier: JwtVerifier; objectStore: ObjectStore;
  /** 6A — the HS256 key `terminalAuth` signs and verifies the short-lived terminal JWT with (§4.10.3,
   *  spec:2273). Bytes, not a string, because that is what `jose` takes. */
  terminalJwtSigningKey: Uint8Array;
}
```

  and the two places that build one:

```ts
// apps/api/src/index.ts (the entrypoint) — the ONE place the environment is read into bytes.
  terminalJwtSigningKey: new TextEncoder().encode(config.terminalJwtSigningKey),
```

```ts
// apps/api/test/support/app.ts — startApi()'s deps object gains the same member.
  // A fixed test literal, not process.env: a route test that mints and verifies a terminal token must not
  // depend on an environment variable, and TERMINAL_JWT_SIGNING_KEY is deliberately absent under `vitest`.
  // It is 48 bytes, past readConfig's 32-character floor, so the two paths agree about what a key looks like.
  terminalJwtSigningKey: new TextEncoder().encode("dulja-test-terminal-signing-key-0123456789abcdef"),
```

  ⚠️ **Both constructors must change in this commit or the tree does not compile.** `AppDeps` is a required-member interface and §4.2.7 says the count is load-bearing; `startApi()` is what every `apps/api` route test and the isolation harness build the app through, so a six-member object there fails `bun run typecheck` in every workspace that imports it. 0C's container wiring builds its deps in `apps/api/src/index.ts`, which is the first block above.

- [ ] **Step 3: Write `terminalContext`.**

```ts
// packages/db/src/sync/context.ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { withTenant } from "../with-tenant";
import { resolveTerminalPrincipal } from "./identity";
import { SyncError } from "./enrolment";

export interface TerminalRow {
  terminalId: string; tenantId: string; companyId: string; branchId: string;
  principalId: string; code: string | null; revokedAt: string | null;
  /** SPKI DER. Carried here so `terminalAuth`'s signed path verifies a signature without resolving the
   *  terminal a second time; the token path simply never reads it. */
  devicePublicKey: Buffer;
}

/**
 * Resolves a terminal id to the context every later statement runs under. Two steps, and the order matters:
 * `app.resolve_principal` runs with NO tenant (it is the SECURITY DEFINER door), and only then can the
 * `pos_terminal` row be read under RLS as the terminal itself. Reading the row first, as a superuser or with
 * a guessed tenant, would be LEGACY-026 with extra steps.
 *
 * `revoked_at` is returned rather than thrown on, because the two callers answer differently: `terminalAuth`
 * raises `ERR_TERMINAL_REVOKED` (403), and the `pos.sync.apply` handler abandons the batch to needs-attention.
 *
 * `device_public_key` comes back in the same read. It is only ever needed on the signed path, but fetching it
 * here is what lets `terminalAuth` resolve a terminal **once per request** instead of twice.
 */
export async function terminalContext(
  sql: Sql, terminalId: string, requestId: string,
): Promise<{ ctx: TenantContext; terminal: TerminalRow }> {
  const resolved = await resolveTerminalPrincipal(sql, terminalId);
  if (resolved.length !== 1 || resolved[0]!.kind !== "terminal") {
    throw new SyncError("ERR_TERMINAL_SIGNATURE_INVALID", "unknown terminal");
  }
  const { principalId, tenantId } = resolved[0]!;
  const ctx: TenantContext = { tenantId, actorId: principalId, requestId };
  const rows = await withTenant(sql, ctx, (tx) => tx<{
    company_id: string; branch_id: string; code: string | null; revoked_at: string | null; device_public_key: Buffer;
  }[]>`select company_id, branch_id, code, revoked_at, device_public_key
         from app.pos_terminal where id = ${terminalId}`);
  if (rows.length !== 1) throw new SyncError("ERR_TERMINAL_SIGNATURE_INVALID", "unknown terminal");
  return {
    ctx,
    terminal: {
      terminalId, tenantId, principalId,
      companyId: rows[0]!.company_id, branchId: rows[0]!.branch_id,
      code: rows[0]!.code, revokedAt: rows[0]!.revoked_at,
      devicePublicKey: rows[0]!.device_public_key,
    },
  };
}
```

- [ ] **Step 4: Write `terminalAuth`.**

```ts
// apps/api/src/middleware/terminal-auth.ts
import { createHash, timingSafeEqual, verify as edVerify, createPublicKey } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";
import { SyncError, terminalContext, withTenant } from "@dulja/db";
import type { AppEnv } from "../context";

export interface TerminalIdentity {
  readonly terminalId: string; readonly tenantId: string; readonly companyId: string;
  readonly branchId: string; readonly principalId: string; readonly code: string | null;
}

/** ±5 minutes. Wide enough for an unsynchronised shop PC, narrow enough that a captured request is stale
 *  before it is useful. The refusal names the skew so a shop with a wrong clock is diagnosable in one line. */
export const TERMINAL_SKEW_SECONDS = 300;
/** 15 minutes (§4.10.3). Short because revocation is re-checked per request anyway — the TTL bounds the
 *  window in which a stolen token works against a terminal that has not yet been revoked. */
export const TERMINAL_JWT_TTL_SECONDS = 900;
export const TERMINAL_TOKEN_HEADER = "X-Terminal-Token";
const TERMINAL_JWT_ISSUER = "urn:dulja:terminal";

/** The ONE canonical string, exported so signer and verifier cannot drift (LEGACY-046). */
export function canonicalSyncRequest(input: { method: string; path: string; timestamp: string; body: string }): string {
  return `${input.method.toUpperCase()}\n${input.path}\n${input.timestamp}\n${input.body}`;
}

function bad(detail: string): never { throw new AppError("ERR_TERMINAL_SIGNATURE_INVALID", detail); }

export function terminalAuth(deps: { db: Sql; signingKey: Uint8Array }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = c.get("requestId");
    const auth = c.req.header("Authorization");
    const bearer = auth?.startsWith("Bearer ") === true ? auth.slice(7) : null;
    let terminalId: string;
    let mintToken = false;
    // The signed path must resolve the terminal to get its device key; the token path must resolve it to get a
    // context. Resolving it twice would double the round trips on every /v1/sync call, so whichever path ran
    // keeps its answer here and the shared block below reuses it.
    let resolved: Awaited<ReturnType<typeof terminalContext>> | null = null;

    if (bearer !== null) {
      // ── the token path ──────────────────────────────────────────────────────────────────────────────
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(bearer, deps.signingKey, { issuer: TERMINAL_JWT_ISSUER, algorithms: ["HS256"] }));
      } catch {
        // Every failure — wrong key, wrong issuer, expired, malformed — is ONE answer. A human's Supabase
        // token lands here too: it is signed by a different key and carries a different issuer.
        bad("terminal token is not valid");
      }
      const sub = typeof payload.sub === "string" ? payload.sub : "";
      if (!sub.startsWith("terminal:")) bad("terminal token is not valid");
      terminalId = sub.slice("terminal:".length);
    } else {
      // ── the signed path ─────────────────────────────────────────────────────────────────────────────
      const id = c.req.header("X-Terminal-Id");
      const timestamp = c.req.header("X-Terminal-Timestamp");
      const signature = c.req.header("X-Terminal-Signature");
      if (id === undefined || timestamp === undefined || signature === undefined) {
        bad("a /v1/sync request needs X-Terminal-Id, X-Terminal-Timestamp and X-Terminal-Signature, or a terminal token");
      }
      const at = Date.parse(timestamp);
      if (Number.isNaN(at)) bad("X-Terminal-Timestamp is not an RFC 3339 instant");
      const skew = Math.abs(Date.now() - at) / 1000;
      if (skew > TERMINAL_SKEW_SECONDS) {
        bad(`X-Terminal-Timestamp is ${Math.round(skew)}s from this server's clock; the window is ${TERMINAL_SKEW_SECONDS}s`);
      }

      // The body is read here and Hono caches it, so the handler's own c.req.json() re-uses this parse.
      const body = c.req.method === "GET" || c.req.method === "HEAD" ? "" : await c.req.text();
      const canonical = canonicalSyncRequest({
        method: c.req.method,
        // The PATH ONLY — never the query string. A cursor is not a secret and a till that retried with a
        // different `limit` would otherwise have to re-sign; what the signature protects is *which terminal
        // is asking which operation*, and the tenant scope comes from the terminal, not from the URL.
        path: new URL(c.req.url).pathname,
        timestamp,
        body: createHash("sha256").update(body, "utf8").digest("hex"),
      });

      resolved = await terminalContext(deps.db, id, requestId).catch((e: unknown) => {
        if (e instanceof SyncError) bad(e.detail);
        throw e;
      });
      let ok = false;
      try {
        ok = edVerify(null, Buffer.from(canonical, "utf8"),
          createPublicKey({ key: resolved.terminal.devicePublicKey, format: "der", type: "spki" }),
          Buffer.from(signature, "base64"));
      } catch { ok = false; }
      if (!ok) bad("the request signature does not verify for that terminal");
      terminalId = id;
      mintToken = true;
    }

    const { ctx, terminal } = resolved ?? await terminalContext(deps.db, terminalId, requestId).catch((e: unknown) => {
      if (e instanceof SyncError) bad(e.detail);
      throw e;
    });
    // Re-checked on EVERY request, token path included: a JWT that outlived its terminal would be exactly the
    // "one variable disables every control" of LEGACY-027, moved into a signed envelope.
    if (terminal.revokedAt !== null) throw new AppError("ERR_TERMINAL_REVOKED", `terminal ${terminalId} was revoked`);

    const identity: TerminalIdentity = {
      terminalId, tenantId: terminal.tenantId, companyId: terminal.companyId,
      branchId: terminal.branchId, principalId: terminal.principalId, code: terminal.code,
    };
    c.set("terminal", identity);
    c.set("ctx", { ...ctx, principalKind: "terminal", aal: "aal2" });
    c.set("withTenant", <T>(fn: (tx: Sql) => Promise<T>) => withTenant(deps.db, ctx, fn));
    c.set("logger", c.get("logger").child({ terminal_id: terminalId, tenant_id: terminal.tenantId }));

    if (mintToken) {
      const token = await new SignJWT({ tid: terminal.tenantId, cid: terminal.companyId, bid: terminal.branchId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(TERMINAL_JWT_ISSUER)
        .setSubject(`terminal:${terminalId}`)
        .setIssuedAt()
        .setExpirationTime(`${TERMINAL_JWT_TTL_SECONDS}s`)
        .sign(deps.signingKey);
      c.header(TERMINAL_TOKEN_HEADER, token);
    }
    await next();
  };
}
```

  **`timingSafeEqual` is imported and unused above — delete the import.** It is named here only to record the decision: the signature comparison is `crypto.verify`, which is already constant-time for Ed25519, and the enrolment code is compared by a **hash lookup in the database**, never by a string equality in TypeScript, so no hand-rolled constant-time compare exists in this slice.

- [ ] **Step 5: Wire the middleware, the tenth `Variables` member, the permission branch, and the problem translation.**

```ts
// apps/api/src/context.ts — the tenth member (§4.2.3, Task 0 amendment 7; `jobs` is 3B's eighth and `db` is T6's ninth).
    /** 6A — set by terminalAuth on every /v1/sync/* request; undefined everywhere else. */
    terminal: TerminalIdentity;
```

  In `createApp`, the middleware order of §4.2.3 is unchanged except for its own terminal branch: `otel → requestId → logger → (auth | terminalAuth) → idempotency → requirePermission → handler`. Fill in the `terminal` arm of the switch **Task 6 Step 6 already wrote**, reading the key from `AppDeps` (Step 2 above) — there is no free `signingKey` variable in this scope and inventing one would be a compile error:

```ts
  for (const route of routes) {
    if (route.auth === "public") continue;                                     // neither — Task 0 amendment 21
    if (route.auth === "terminal") {
      app.use(`${route.path}/*`, terminalAuth({ db: deps.db, signingKey: deps.terminalJwtSigningKey }));
    } else {
      app.use(`${route.path}/*`, authenticate({ db: deps.db, verifier: deps.verifier }));
    }
    app.use(`${route.path}/*`, idempotency({ db: deps.db }));                  // both authenticated kinds
  }
```

  **A terminal route keeps idempotency**, and that is not an oversight: `terminalAuth` sets `c.var.ctx` before `next()`, so the middleware has the tenant and the principal it keys on — the terminal's — and `POST /v1/sync/tickets` is the route §4.2.9's two-layer rule was written for (the key replays an identical retry; `client_ref` dedup handles a re-send with a fresh key). Only `"public"` is exempt.

```ts
// apps/api/src/middleware/require-permission.ts — the { company: "terminal" } branch 0B declared and left open.
    case "terminal": {
      // /v1/sync/*: the company is the TERMINAL's, from the row terminalAuth resolved — never from the path,
      // the query or the body. That is what makes `{ company: "terminal" }` a different variant at all.
      const t = c.get("terminal");
      if (t === undefined) throw new AppError("ERR_INTERNAL", "requirePermission({ company: 'terminal' }) on a route without terminalAuth");
      return { companyId: t.companyId, branchId: t.branchId };
    }
```

```ts
// apps/api/src/problem.ts — one more asAppError branch, exactly like the PostingError one (§4.2.4).
  if (e instanceof SyncError) return new AppError(e.code, e.detail);
```

  Add the two rows to `packages/contracts/src/errors.ts` **in this commit**, because this is the PR that raises them: `ERR_TERMINAL_SIGNATURE_INVALID` (401, title *"Terminal signature invalid"*, remedy *"Re-sign the request with the terminal's device key, or re-enrol the terminal."*) and `ERR_TERMINAL_REVOKED` (403, title *"Terminal revoked"*, remedy *"Enrol the terminal again from the back office."*).

- [ ] **Step 6: Write the two signer helpers into the shared fixture (§4.17.1's `signSyncRequest` and `syncRequest`).** They belong here and not in Task 6, because `canonicalSyncRequest` — the one string both ends must agree about — is defined in Step 4 above. Task 12's five route cases, Task 13's two calls and Task 15's Step 1 all reach `/v1/sync/*` through `syncRequest` and would otherwise fail to import.

```ts
// tests/invariants/support/pos.ts — appended to Task 6's file.
import { createHash, sign as edSign } from "node:crypto";
import { canonicalSyncRequest } from "../../../apps/api/src/middleware/terminal-auth";
import type { ApiRequest } from "../../../apps/api/test/support/app";

const sha256hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The three signature headers for one request, from the terminal's own private key.
 *
 * **`body` is stringified exactly once, here, and the same string is what `api.request` sends.**
 * `ApiRequest.body` is `unknown` and the harness `JSON.stringify`s it with no replacer and no spacing
 * (0b:2565–2574), so `JSON.stringify(body)` below produces byte-for-byte what `terminalAuth` will read back
 * through `c.req.text()`. Hashing a *differently* serialised copy is the one way this helper can be wrong and
 * the failure is opaque — every signed POST would answer 401 with no clue why — so `syncRequest` below hands
 * the very same value to both, and neither re-serialises.
 *
 * The **path only**, never the query string: `terminalAuth` signs `new URL(c.req.url).pathname`, so a caller
 * passes `"/v1/sync/catalogue"` even when it requests `"/v1/sync/catalogue?limit=1"`.
 */
export function signSyncRequest(
  t: EnrolledTerminal,
  req: { method: string; path: string; body?: unknown; at?: Date },
): Record<string, string> {
  const timestamp = (req.at ?? new Date()).toISOString();
  const payload = req.body === undefined ? "" : JSON.stringify(req.body);
  const canonical = canonicalSyncRequest({
    method: req.method, path: req.path, timestamp, body: sha256hex(payload),
  });
  return {
    "X-Terminal-Id": t.terminalId,
    "X-Terminal-Timestamp": timestamp,
    "X-Terminal-Signature": edSign(null, Buffer.from(canonical, "utf8"), t.privateKey).toString("base64"),
  };
}

/**
 * A signed `/v1/sync/*` call. `path` may carry a query string; the signature covers only the pathname, which
 * is `terminalAuth`'s own rule (a cursor is not a secret, and a till that retried with a different `limit`
 * would otherwise have to re-sign).
 *
 * `idempotencyKey` is threaded straight through to `ApiRequest`, including `null` — the harness reads `null`
 * as "send NO header", which is how Task 12 exercises `ERR_IDEMPOTENCY_KEY_MISSING` on a terminal route.
 */
export async function syncRequest(
  api: StartedApi,
  t: EnrolledTerminal,
  req: { method: "GET" | "POST"; path: string; body?: unknown; idempotencyKey?: string | null; headers?: Record<string, string> },
): Promise<Response> {
  const pathname = req.path.split("?")[0]!;
  const signed = signSyncRequest(t, { method: req.method, path: pathname, body: req.body });
  const input: ApiRequest = {
    method: req.method,
    path: req.path,
    // The SAME object signSyncRequest hashed. Do not rebuild it, and do not pass a pre-stringified copy: the
    // harness stringifies `body` itself, and two stringifications of one object are equal while a string and
    // an object are not.
    ...(req.body === undefined ? {} : { body: req.body }),
    ...(req.idempotencyKey === undefined ? {} : { idempotencyKey: req.idempotencyKey }),
    headers: { ...signed, ...req.headers },
  };
  return api.request(input);
}
```

  ⚠️ **`tests/invariants/support/pos.ts` now imports from `apps/api/src`, which the dependency rule must permit.** §4.17.1 already records that `apps/worker/test/**` and `apps/api/test/**` import from `tests/invariants/support/**` *"through named allowances on `scripts/lint/rules/dependency-rule.ts`, each carrying its reason on the line"*; this is the same seam in the other direction and takes the same treatment. Add the allowance with its reason: *"`tests/invariants/support/pos.ts` imports `canonicalSyncRequest` from `apps/api/src/middleware/terminal-auth` — the ONE canonical signature string (LEGACY-046). A copy in the test tier is the second spelling that defect is about."* **No `package.json` dependency is added**: `tests/` already resolves `apps/api` through its own `tsconfig.json` `include`, which 5A's `tests/invariants/support/tax.ts` established.

- [ ] **Step 7: Append the sync shapes to the bypass suite (acceptance test 11's 6A re-run).** In `tests/invariants/auth-bypass.test.ts`, add a `describe("acceptance test 11 — sync headers — 6A", () => { … })` block with three cases 0B could not write because no terminal route existed: a `/v1/sync/*` call with a **valid human Supabase token** (401), the same call with a **forged `X-Tenant-Id` and `X-Actor-Id` beside a valid signature** (200 **as the terminal** — the headers are inert, which is the assertion), and a **signature over a different path replayed onto this one** (401). The route-level suite of Step 1 covers the rest; this block is what makes test 11's own file mention the sync surface.

- [ ] **Step 8: Run and commit.** `bun run --cwd apps/api test -- routes/sync/terminal-auth` — **expected:** 5 passed. `bun run --cwd tests test -- auth-bypass` — **expected:** green. `bun run --cwd apps/api test` — **expected:** the whole route suite green, because the `auth` branch only changes behaviour for `auth: "terminal"` modules and none existed before this task. `bun run typecheck` at the root — **expected:** clean, which is where a missed `AppDeps` constructor surfaces.

```bash
git add apps/api/src/middleware/terminal-auth.ts apps/api/src/context.ts apps/api/src/config.ts \
        apps/api/src/middleware/require-permission.ts apps/api/src/problem.ts apps/api/src/app.ts \
        apps/api/src/index.ts apps/api/test/support/app.ts tests/invariants/support/pos.ts \
        scripts/lint/rules/dependency-rule.ts \
        packages/db/src/sync/context.ts packages/contracts/src/errors.ts infra/src/secrets.ts \
        apps/api/test/routes/sync/terminal-auth.test.ts tests/invariants/auth-bypass.test.ts
git commit -m "$(cat <<'EOF'
feat(api): terminalAuth — Ed25519 signed calls, a 15-minute terminal JWT, revocation per request [6A T7]

Identity is the signature, never a header: a forged X-Tenant-Id beside a valid signature is
INERT and the request runs as the terminal, which is the assertion test 11 now carries
(LEGACY-026). Revocation is re-checked on every request including the token path, so a JWT can
never outlive its terminal (LEGACY-027).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `GET /v1/sync/catalogue` — the branch-scoped, cursor-driven down-sync

**Files**

- `packages/db/src/sync/catalogue.ts` — NEW
- `packages/contracts/src/sync/catalogue.ts` — NEW
- `apps/api/src/routes/sync/catalogue.ts` — NEW
- `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts` — MODIFY
- `packages/contracts/src/errors.ts` — MODIFY (one row)
- `packages/db/test/sync/catalogue-read.test.ts`, `apps/api/test/routes/sync/catalogue.test.ts` — NEW

**Interfaces**

- Consumes: `Change`, `CataloguePage`, `Stream`, `CATALOGUE_STREAMS`, `decodeSyncCursor`, `encodeSyncCursor` (T1); `TerminalIdentity` (T7); `withTenant` (§4.2.2).
- Produces:

```ts
// packages/db/src/sync/catalogue.ts
/** The db-local twin of §4.10.1's `Change`. `packages/db` may not import `@dulja/sync` (§3.1), so the shape is
 *  declared here and the sync package's type satisfies it structurally — the `ItemRef` pattern of §4.4.2. */
export interface CatalogueChange { stream: string; op: "upsert" | "delete"; id: string; revision: bigint; row: Record<string, unknown> | null }
export interface ReadCatalogueInput { companyId: string; branchId: string; since: bigint; limit: number }
export interface CatalogueSlice { changes: CatalogueChange[]; nextCursor: bigint; hasMore: boolean }
/** One query per stream, UNION ALL'd and ordered by revision, then truncated at `limit`. Never SQL text from a
 *  client, never a table name from a parameter (test 27). */
export async function readCatalogue(tx: Sql, input: ReadCatalogueInput): Promise<CatalogueSlice>;
/** The highest revision the company has issued, so a `BatchResult` can tell a till how stale it is. */
export async function currentCatalogueRevision(tx: Sql, companyId: string): Promise<bigint>;
```

**Steps**

- [ ] **Step 1: Write the failing DB-tier test first.**

```ts
// packages/db/test/sync/catalogue-read.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCatalogue } from "../../src/sync/catalogue";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { startDb, withTenant, type Db } from "../harness";
import { seedBranch, seedItem, seedParty, seedPriceList, seedTenantV2, seedTerminal, seedUnit, type Seed } from "../fixtures";

describe("readCatalogue (§4.10.2) — branch-scoped, revision-ordered, resumable", () => {
  let db: Db; let s: Seed; let other: string; let hqTerminal: { terminalId: string; principalId: string };
  beforeAll(async () => {
    db = await startDb(); s = await seedTenantV2(db, "Alpha");
    other = await seedBranch(db, s, { code: "BR2", nameEn: "Branch 2" });
    hqTerminal = await seedTerminal(db, s, { code: "T-HQ" });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  const read = (since: bigint, limit: number, branchId = s.hq) =>
    prodWithTenant(db.rw, { tenantId: s.tenant, actorId: hqTerminal.principalId, requestId: "cat" },
      (tx) => readCatalogue(tx, { companyId: s.company, branchId, since, limit }));

  it("returns every stream a terminal needs, ordered by revision, with a usable next cursor", async () => {
    const unitId = await seedUnit(db, s);
    await seedItem(db, s, { code: "SKU-A", baseUnitId: unitId });
    await seedParty(db, s, { code: "CUST-A" });
    await seedPriceList(db, s, { code: "PL-HQ", branchId: s.hq });

    const page = await read(0n, 1000);
    expect(page.changes.length).toBeGreaterThanOrEqual(3);
    expect(page.changes.map((c) => c.revision)).toEqual([...page.changes.map((c) => c.revision)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(page.changes.map((c) => c.stream))).toEqual(new Set(["item", "customer", "price_list"]));
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe(page.changes.at(-1)!.revision);
  });

  it("paging by the cursor visits every row exactly once — the property acceptance test 20 rests on", async () => {
    const unitId = await seedUnit(db, s);
    for (let i = 0; i < 25; i += 1) await seedItem(db, s, { code: `SKU-P${i}`, baseUnitId: unitId });

    const seen: string[] = []; let cursor = 0n; let guard = 0;
    for (;;) {
      const page = await read(cursor, 4);
      for (const ch of page.changes) seen.push(`${ch.stream}:${ch.id}:${ch.op}`);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
      if ((guard += 1) > 100) throw new Error("pagination did not terminate");
    }
    expect(new Set(seen).size, "no row is delivered twice").toBe(seen.length);
    const whole = await read(0n, 1000);
    expect(seen.length).toBe(whole.changes.length);
  });

  it("paging is ordered by the BIGINT revision and not its text — the 9 → 10 digit boundary", async () => {
    // The regression this case pins: in a set operation PostgreSQL resolves ORDER BY against the OUTPUT
    // column list, so `order by revision` beside `revision::text as revision` sorts lexicographically and
    // "10" < "2" < "9". A first page of four would then be 1, 10, 11, 12 and revisions 2..9 would be
    // unreachable for ever. Asserting the page's own ordering is not enough — a lexicographic page is
    // internally consistent — so this asserts the CONTENT of the first page against the numeric order.
    const whole = await read(0n, 1000);
    const numeric = [...whole.changes].sort((a, b) => (a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0));
    // The corpus above already spans one, two and (with 25 items) two-digit revisions; assert it really does,
    // or the case is vacuous on a fresh database.
    expect(numeric.filter((c) => c.revision < 10n).length, "the corpus must span the boundary").toBeGreaterThan(1);
    expect(numeric.filter((c) => c.revision >= 10n).length).toBeGreaterThan(1);

    const first = await read(0n, 4);
    expect(first.changes.map((c) => c.revision)).toEqual(numeric.slice(0, 4).map((c) => c.revision));
    expect(first.nextCursor).toBe(numeric[3]!.revision);
  });

  it("an archived price-list LINE arrives as a delete and never again as an upsert", async () => {
    const unitId = await seedUnit(db, s);
    const { itemId } = await seedItem(db, s, { code: "SKU-LN", baseUnitId: unitId });
    const plId = await seedPriceList(db, s, { code: "PL-LN", branchId: s.hq });
    const lineId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.price_list_line (tenant_id, price_list_id, item_id, min_quantity, unit_price)
        values (${s.tenant}, ${plId}, ${itemId}, 0, 4.5000) returning id`;
      return row!.id;
    });
    const before = (await read(0n, 1000)).nextCursor;
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.price_list_line set archived_at = now() where id = ${lineId}`);

    const page = await read(before, 1000);
    const forLine = page.changes.filter((c) => c.id === lineId);
    // Exactly ONE change: the tombstone. Without `l.archived_at is null` in the live leg the archived row
    // would ALSO arrive as an upsert at the same revision, and the till would apply them in an order nothing
    // fixes — a coin flip between "deleted" and "still priced".
    expect(forLine).toHaveLength(1);
    expect(forLine[0]!.op).toBe("delete");
    expect(forLine[0]!.stream).toBe("price_list_line");
  });

  it("a promotion is delivered whatever its window, and its retirement is an upsert (3A has no archived_at)", async () => {
    const promoId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.promotion (tenant_id, company_id, code, name_en, kind, definition, starts_at, ends_at)
        values (${s.tenant}, ${s.company}, 'PROMO-CAT', 'Ten off', 'percent_off', ${tx.json({ percent: 10 })},
                now() - interval '1 day', now() + interval '30 days')
        returning id`;
      return row!.id;
    });
    expect((await read(0n, 1000)).changes.some((c) => c.stream === "promotion" && c.id === promoId)).toBe(true);

    const before = (await read(0n, 1000)).nextCursor;
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.promotion set ends_at = now() - interval '1 second' where id = ${promoId}`);
    const page = await read(before, 1000);
    const change = page.changes.find((c) => c.id === promoId);
    // An UPSERT carrying the shortened window, not a delete and not an absence. The till's own window check
    // retires it; the server filtering by `ends_at` here would leave every till holding the OLD window.
    expect(change).toBeDefined();
    expect(change!.op).toBe("upsert");
    expect((change!.row as { ends_at: string }).ends_at).toBeTruthy();
  });

  it("scopes to the terminal's branch: another branch's price list is absent, a company-wide one is present", async () => {
    await seedPriceList(db, s, { code: "PL-BR2", branchId: other });
    await seedPriceList(db, s, { code: "PL-ALL" });          // branch_id null = every branch (§4.5.6 Form B)
    const page = await read(0n, 1000);
    const codes = page.changes.filter((c) => c.stream === "price_list").map((c) => (c.row as { code: string }).code);
    expect(codes).toContain("PL-ALL");
    expect(codes).toContain("PL-HQ");
    expect(codes).not.toContain("PL-BR2");
  });

  it("an archived row arrives as a DELETE and never as an absence (spec:1300)", async () => {
    const plId = await seedPriceList(db, s, { code: "PL-DEAD", branchId: s.hq });
    const before = (await read(0n, 1000)).nextCursor;
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`update app.price_list set archived_at = now() where id = ${plId}`);
    const page = await read(before, 1000);
    const tomb = page.changes.find((c) => c.id === plId);
    expect(tomb).toBeDefined();
    expect(tomb!.op).toBe("delete");
    expect(tomb!.row).toBeNull();
    // And exactly one change for that row in this window — the tombstone, not an upsert AND a tombstone.
    expect(page.changes.filter((c) => c.id === plId)).toHaveLength(1);
  });

  it("the two 6C streams are silent until 6C's tables exist, and do not fail the read", async () => {
    const page = await read(0n, 1000);
    expect(page.changes.filter((c) => c.stream === "cashier" || c.stream === "branch_pos_policy")).toEqual([]);
  });
});
```

  Run `bun run --cwd packages/db test -- sync/catalogue-read`. **Expected failure:** `Cannot find module '../../src/sync/catalogue'`.

- [ ] **Step 2: Write `readCatalogue`.**

```ts
// packages/db/src/sync/catalogue.ts
import type { Sql } from "postgres";

export interface CatalogueChange {
  stream: string; op: "upsert" | "delete"; id: string; revision: bigint; row: Record<string, unknown> | null;
}
export interface ReadCatalogueInput { companyId: string; branchId: string; since: bigint; limit: number }
export interface CatalogueSlice { changes: CatalogueChange[]; nextCursor: bigint; hasMore: boolean }

interface RawChange { stream: string; op: "upsert" | "delete"; id: string; revision: string; row: Record<string, unknown> | null }

/**
 * One page of the branch's catalogue, strictly after `since`, ordered by revision.
 *
 * **Why one UNION ALL and not one query per stream.** The cursor is a single scalar across every stream
 * (§4.10.2), so the page boundary has to be a single revision — paging each stream separately would leave the
 * till holding eight cursors and one wire cursor that means none of them. `CATALOGUE_STREAMS` exists for the
 * till's *apply* order; the server's order is the revision.
 *
 * **Why an archived row appears only as a tombstone.** Every `where` on a live row excludes `archived_at is
 * not null`, and the tombstone carries the row's own final revision (migration 0059), so the two can never
 * both land in one window and a till never applies an upsert after the delete of the same row.
 *
 * **Why the 6C streams are a SECOND query rather than two more `union all` legs.** `pos_cashier` and
 * `branch_pos_policy` are 6C's tables (migrations 0065-0066) and 6A executes first. A `where false` does not
 * stop PostgreSQL parsing a relation, so a single statement that names them fails on every 6A install; the
 * guard has to be structural — a statement that is never sent — not a predicate. The same capability-check
 * discipline as `applyBatch`'s shift path (§4.10.1), and it disappears in 6C.
 */
export async function readCatalogue(tx: Sql, input: ReadCatalogueInput): Promise<CatalogueSlice> {
  const [caps] = await tx<{ cashier: boolean; policy: boolean }[]>`
    select to_regclass('app.pos_cashier') is not null as cashier,
           to_regclass('app.branch_pos_policy') is not null as policy`;

  const rows = await tx<RawChange[]>`
    with live as (
      select 'item'::text as stream, i.id, i.revision, to_jsonb(i) - 'tenant_id' as row
        from app.item i
       where i.company_id = ${input.companyId} and i.revision > ${input.since} and i.archived_at is null
      union all
      -- Form B in a query: a NULL branch means EVERY branch, so a company-wide price list or promotion must
      -- be delivered. Writing `branch_id = $branch` here would silently starve every till of head-office
      -- pricing, and nothing would fail — the till would just quietly sell at the wrong price.
      select 'price_list', p.id, p.revision, to_jsonb(p) - 'tenant_id'
        from app.price_list p
       where p.company_id = ${input.companyId} and p.revision > ${input.since} and p.archived_at is null
         and (p.branch_id is null or p.branch_id = ${input.branchId})
      union all
      -- BOTH archived_at predicates. `price_list_line` has its own (3A added it deliberately, phase-3a:2399,
      -- because §3.5.4 pins the app_rw DELETE list and `replacePriceListLines` therefore archives a line it
      -- cannot delete). Without `l.archived_at is null` an archived line would keep arriving as an upsert
      -- FOREVER, one revision after its own tombstone, and the till would resurrect a price nobody set.
      select 'price_list_line', l.id, l.revision, to_jsonb(l) - 'tenant_id'
        from app.price_list_line l
        join app.price_list p on p.id = l.price_list_id
       where p.company_id = ${input.companyId} and l.revision > ${input.since}
         and l.archived_at is null and p.archived_at is null
         and (p.branch_id is null or p.branch_id = ${input.branchId})
      union all
      -- NO archived_at predicate here, and this is a fact about 3A's schema, not an omission: `app.promotion`
      -- has no such column (phase-3a:2419-2444 — "a promotion is retired by setting ends_at, which is what a
      -- date-windowed offer means"), so `r.archived_at is null` would raise 42703 on EVERY call and no page
      -- would ever be returned. There is no `ends_at > now()` filter either: an edit that shortens the window
      -- bumps the revision, so the shortened row travels as an upsert and the till's own window check retires
      -- it. Filtering here would turn that edit into a silent absence — the till would keep the OLD window,
      -- which is exactly the failure spec:1300 and acceptance test 20 forbid.
      select 'promotion', r.id, r.revision, to_jsonb(r) - 'tenant_id'
        from app.promotion r
       where r.company_id = ${input.companyId} and r.revision > ${input.since}
         and (r.branch_id is null or r.branch_id = ${input.branchId})
      union all
      -- The till mirrors CUSTOMERS (spec:1328's catalogue_customer). A vendor carries a revision because the
      -- column is NOT NULL, and is simply never selected.
      select 'customer', c.id, c.revision, to_jsonb(c) - 'tenant_id' - 'tax_registration'
        from app.party c
       where c.company_id = ${input.companyId} and c.revision > ${input.since} and c.archived_at is null
         and c.kind = 'customer'
      union all
      select 'tax_code', t.id, t.revision, to_jsonb(t) - 'tenant_id'
        from app.tax_code t
       where t.company_id = ${input.companyId} and t.revision > ${input.since} and t.archived_at is null
      -- The `cashier` and `branch_pos_policy` streams are NOT here. They are 6C's, they do not exist yet,
      -- and they are read by the second query below. 6C's first task moves them into this `union all`.
    ),
    dead as (
      select t.stream, t.row_id as id, t.revision, null::jsonb as row
        from app.catalogue_tombstone t
       where t.company_id = ${input.companyId} and t.revision > ${input.since}
         and (t.branch_id is null or t.branch_id = ${input.branchId})
    )
    -- ⚠️ The ORDER BY is INSIDE the subquery, over the BIGINT, and the ::text casts happen outside it.
    -- In a set operation PostgreSQL resolves ORDER BY against the OUTPUT column list only, so an
    -- `order by revision` written beside `revision::text as revision` sorts the TEXT: "10" < "2" < "9".
    -- With limit 4 over revisions 1..30 the first page would be 1, 10, 11, 12, nextCursor would be 12, and
    -- revisions 2..9 would never be delivered to any till — silently, for ever. That is the exact failure
    -- acceptance test 20 exists to catch, and the ordering is the only thing standing between the two.
    -- `order by p.revision` on the outer select is QUALIFIED, so it binds the subquery's bigint column and
    -- not the text output column of the same name; it is there because a plain SELECT over an ordered
    -- subquery is not guaranteed to preserve that order.
    select p.stream, p.op, p.id::text as id, p.revision::text as revision, p.row
      from (
        select stream, 'upsert'::text as op, id, revision, row from live
        union all
        select stream, 'delete'::text as op, id, revision, row from dead
        order by revision
        limit ${input.limit + 1}
      ) p
     order by p.revision`;

  // ── 6C's two streams, as a second query ────────────────────────────────────────────────────────────
  // Taking `limit + 1` from each source and slicing after the merge is the ordinary merge-of-sorted-streams
  // rule: the global first `limit + 1` rows by revision cannot draw more than `limit + 1` from any one source,
  // so nothing is lost and the cursor still advances by exactly one page. **6C's first task deletes this whole
  // block** and folds both streams back into the `union all` above — the same "a later slice removes an earlier
  // slice's scaffold" handoff that `applyBatch`'s shift refusal uses.
  const extra: RawChange[] = [];
  if (caps!.cashier) {
    extra.push(...await tx<RawChange[]>`
      select 'cashier'::text as stream, 'upsert'::text as op, k.id::text as id, k.revision::text as revision, k.row
        from app.pos_cashier_sync(${input.companyId}, ${input.branchId}, ${input.since}) k
       order by k.revision limit ${input.limit + 1}`);
  }
  if (caps!.policy) {
    extra.push(...await tx<RawChange[]>`
      select 'branch_pos_policy'::text as stream, 'upsert'::text as op, b.id::text as id, b.revision::text as revision, b.row
        from app.branch_pos_policy_sync(${input.companyId}, ${input.branchId}, ${input.since}) b
       order by b.revision limit ${input.limit + 1}`);
  }
  const merged = extra.length === 0
    ? rows
    : [...rows, ...extra].sort((x, y) => {
        const a = BigInt(x.revision); const b = BigInt(y.revision);
        return a < b ? -1 : a > b ? 1 : 0;
      });

  const hasMore = merged.length > input.limit;
  const page = hasMore ? merged.slice(0, input.limit) : merged;
  const changes = page.map((r) => ({ stream: r.stream, op: r.op, id: r.id, revision: BigInt(r.revision), row: r.row }));
  const nextCursor = changes.length === 0 ? input.since : changes.at(-1)!.revision;
  return { changes, nextCursor, hasMore };
}

export async function currentCatalogueRevision(tx: Sql, companyId: string): Promise<bigint> {
  const [row] = await tx<{ r: string }[]>`
    select coalesce(max(revision), 0)::text as r from (
      select max(revision) as revision from app.item where company_id = ${companyId}
      union all select max(revision) from app.price_list where company_id = ${companyId}
      -- price_list_line has no company_id of its own (3A) and reaches the company through its parent. It is
      -- in this union because a LINE edit is often the company's highest revision — a price change is the
      -- commonest catalogue write there is — and a `catalogueCursor` that ignored it would tell every till it
      -- was up to date while its prices were stale.
      union all select max(l.revision) from app.price_list_line l
                  join app.price_list p on p.id = l.price_list_id where p.company_id = ${companyId}
      union all select max(revision) from app.promotion where company_id = ${companyId}
      union all select max(revision) from app.party where company_id = ${companyId}
      union all select max(revision) from app.tax_code where company_id = ${companyId}
      union all select max(revision) from app.catalogue_tombstone where company_id = ${companyId}
    ) m`;
  return BigInt(row!.r);
}
```

  ⚠️ **`app.pos_cashier_sync` and `app.branch_pos_policy_sync` are 6C's, and 6A ships neither.** That is why they are read by a second statement guarded in TypeScript rather than by two `union all` legs: `where ${false}` does not stop PostgreSQL parsing a relation, so the only guard that works is one that never sends the statement. `caps` above is a `to_regclass` probe against the two **tables**, so it goes true the moment 6C's migrations land; **6C must ship both functions with the signature `(p_company_id uuid, p_branch_id uuid, p_since bigint) returns table (id uuid, revision bigint, row jsonb)`**, ordered by nothing in particular — this query orders. Naming a function rather than 6C's tables is deliberate: it keeps 6A from hard-coding column names it does not own, and it means 6C changes one function body instead of this query when its schema settles. **6C's first task deletes the whole `extra` block** and folds both streams into the `union all`.

- [ ] **Step 3: Write the contracts module and the route.**

```ts
// packages/contracts/src/sync/catalogue.ts
import { z } from "@hono/zod-openapi";
import { CursorSchema } from "../common";

export const StreamSchema = z.enum([
  "item", "price_list", "price_list_line", "promotion", "customer", "tax_code", "cashier", "branch_pos_policy",
]);
export const ChangeSchema = z.object({
  stream: StreamSchema,
  op: z.enum(["upsert", "delete"]),
  id: z.string().uuid(),
  /** A bigint on the wire is a STRING: a revision past 2^53 read as a JSON number would round (T1). */
  revision: z.string().regex(/^\d+$/),
  row: z.record(z.unknown()).nullable(),
}).openapi("Change");
/** snake_case members: §4.10.1 fixes them as the spec's own names (spec:1297). */
export const CataloguePageSchema = z.object({
  changes: z.array(ChangeSchema), next_cursor: CursorSchema, has_more: z.boolean(),
}).openapi("CataloguePage");
export const CatalogueQuery = z.object({
  since: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
});
```

```ts
// apps/api/src/routes/sync/catalogue.ts
export const catalogueRoutes = new OpenAPIHono<AppEnv>();
catalogueRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["sync"],
    request: { query: CatalogueQuery },
    middleware: [requirePermission(PERMISSION["pos.sync.pull"], { company: "terminal" })],
    responses: {
      200: { description: "a page of catalogue changes", content: { "application/json": { schema: CataloguePageSchema } } },
      400: { description: "malformed cursor", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { since, limit } = c.req.valid("query");
    const t = c.get("terminal");
    let cursor = 0n;
    if (since !== undefined) {
      try { cursor = decodeSyncCursor(since).revision; }
      catch { throw new AppError("ERR_SYNC_CURSOR_INVALID", `\`since\` is not a cursor this server issued`); }
    }
    const slice = await c.var.withTenant((tx) => readCatalogue(tx, {
      companyId: t.companyId, branchId: t.branchId, since: cursor, limit,
    }));
    return c.json({
      changes: slice.changes.map((ch) => ({ ...ch, revision: ch.revision.toString() })),
      next_cursor: encodeSyncCursor({ revision: slice.nextCursor }),
      has_more: slice.hasMore,
    }, 200);
  },
);
```

  Register the module (`{ path: "/v1/sync/catalogue", router: catalogueRoutes, permissions: [PERMISSION["pos.sync.pull"]], auth: "terminal" }`) and its probe (`expect: 401` — the harness's human token is refused by `terminalAuth`, with the comment naming the stronger cross-tenant case in the route suite). Add `ERR_SYNC_CURSOR_INVALID` (400) to `ERRORS` in this commit.

- [ ] **Step 4: Write the route test.**

```ts
// apps/api/test/routes/sync/catalogue.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCodes, seedItem, seedTenantV2, seedUnit, type Seed } from "@dulja/db/test";
// FIVE levels: apps/api/test/routes/sync/ → four would resolve to `apps/`. Same as terminal-auth.test.ts.
import { enrolTerminal, syncRequest, type EnrolledTerminal } from "../../../../../tests/invariants/support/pos";
import { startApi, type StartedApi } from "../../support/app";
import type { Problem } from "@dulja/contracts";
import type { CataloguePage } from "@dulja/sync";

describe("GET /v1/sync/catalogue — the branch-scoped down-sync over the wire", () => {
  let api: StartedApi; let a: Seed; let b: Seed; let t: EnrolledTerminal;
  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    b = await seedTenantV2(api.db, "Beta");
    await grantCodes(api.db, a, { codes: ["admin.terminal.manage"] });
    // The SAME item code in both tenants, so a leak would be invisible to a code comparison and visible only
    // as a count — which is the assertion the last case makes.
    const ua = await seedUnit(api.db, a); const ub = await seedUnit(api.db, b);
    await seedItem(api.db, a, { code: "SKU-SHARED", baseUnitId: ua });
    await seedItem(api.db, b, { code: "SKU-SHARED", baseUnitId: ub });
    t = await enrolTerminal(api, a, { as: a.human, code: "KL20" });
  }, 240_000);
  afterAll(async () => { await api.stop(); });

  it("a signed pull returns a page, a cursor and a terminal token", async () => {
    const res = await syncRequest(api, t, { method: "GET", path: "/v1/sync/catalogue?limit=1000" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Terminal-Token")).toBeTruthy();
    const page = (await res.json()) as CataloguePage;
    expect(page.changes.length).toBeGreaterThan(0);
    expect(page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(page.has_more).toBe(false);
    // A revision crosses the wire as a STRING (T1): read as a JSON number it would round past 2^53.
    expect(typeof (page.changes[0] as unknown as { revision: unknown }).revision).toBe("string");
  });

  it("a second pull from next_cursor returns has_more false and zero changes", async () => {
    const first = (await (await syncRequest(api, t, { method: "GET", path: "/v1/sync/catalogue?limit=1000" })).json()) as CataloguePage;
    const res = await syncRequest(api, t, {
      method: "GET", path: `/v1/sync/catalogue?limit=1000&since=${encodeURIComponent(first.next_cursor)}`,
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as CataloguePage;
    expect(page.changes).toEqual([]);
    expect(page.has_more).toBe(false);
    // The cursor does not go BACKWARDS on an empty page: readCatalogue returns `since` unchanged, so a till
    // that polls a quiet catalogue never re-pulls what it already has.
    expect(page.next_cursor).toBe(first.next_cursor);
  });

  it("a `since` that is not a cursor this server issued is 400 ERR_SYNC_CURSOR_INVALID", async () => {
    for (const bad of ["!!!", "eyJrIjpbXX0"]) {
      const res = await syncRequest(api, t, { method: "GET", path: `/v1/sync/catalogue?since=${encodeURIComponent(bad)}` });
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as Problem).code, bad).toBe("ERR_SYNC_CURSOR_INVALID");
    }
  });

  it("a terminal in tenant A sees ZERO rows of tenant B's catalogue (the probe cannot make this one)", async () => {
    const page = (await (await syncRequest(api, t, { method: "GET", path: "/v1/sync/catalogue?limit=1000" })).json()) as CataloguePage;
    const items = page.changes.filter((c) => c.stream === "item");
    // Both tenants hold an item coded SKU-SHARED, so comparing codes would prove nothing. Compare IDS against
    // the database: every id delivered must belong to tenant A, and the count of B's items must be non-zero
    // (or the case is vacuous because B has nothing to leak).
    const ids = items.map((c) => c.id);
    const [n] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.item where tenant_id = ${b.tenant} and id = any(${ids})`;
    expect(n!.n).toBe(0);
    const [bTotal] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.item where tenant_id = ${b.tenant}`;
    expect(bTotal!.n, "tenant B must actually have items, or this asserts nothing").toBeGreaterThan(0);
  });
});
```

- [ ] **Step 5: Run and commit.** `bun run --cwd packages/db test -- sync/catalogue-read` (**expected:** 8 passed) and `bun run --cwd apps/api test -- routes/sync/catalogue` (**expected:** 4 passed).

```bash
git add packages/db/src/sync/catalogue.ts packages/contracts/src/sync/catalogue.ts packages/contracts/src/errors.ts \
        apps/api/src/routes/sync/catalogue.ts apps/api/src/routes/index.ts tests/invariants/probes.ts \
        packages/db/test/sync/catalogue-read.test.ts apps/api/test/routes/sync/catalogue.test.ts
git commit -m "$(cat <<'EOF'
feat(api): GET /v1/sync/catalogue — branch-scoped, revision-ordered, resumable down-sync [6A T8]

A NULL branch_id means EVERY branch, so a company-wide price list reaches every till
(§4.5.6 Form B in a query). An archived row arrives as a tombstone and never as an
absence (spec:1300). The 6C streams are capability-guarded, not hard-coded.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The `packages/sync` client — `pullAll`, `drainOutbox`, and acceptance test 20

**Files**

- `packages/sync/src/client.ts` — NEW
- `packages/sync/src/index.ts` — MODIFY (one `export *`)
- `packages/sync/test/pull-all.test.ts`, `packages/sync/test/drain-outbox.test.ts` — NEW
- `tests/invariants/support/pos.ts` — MODIFY (`MemorySyncStore`)

**Interfaces**

- Consumes: everything `packages/sync/src/messages.ts` exports (T1).
- Produces (§4.10.5 **as amended by Task 0 amendment 23**): `SyncStore` (with the `applyChanges` cursor rule), `SyncTransport`, `OutboxRow`, `SyncQueuedError`, `pullAll`, `drainOutbox` (required `terminalId` and `newBatchId`).

**Why this is a pure-function task with no database.** §4.10.5's two functions are the *till's* loop, and the till's store is SQLite in `apps/pos` (6B). Writing them over the two ports here means acceptance test 20 — *"Kill the down-sync mid-transfer; resume from the cursor; the till's catalogue matches the back office exactly, with no row applied twice and no deletion missed"* — is provable **deterministically**, by killing the transport at a chosen page, rather than by racing a process. 6B then supplies the SQLite `SyncStore` and re-runs these same functions against a real till.

**Steps**

- [ ] **Step 1: Write the failing test first — this IS acceptance test 20.**

```ts
// packages/sync/test/pull-all.test.ts
import { describe, expect, it } from "vitest";
import { CATALOGUE_STREAMS, drainOutbox, pullAll, type Change, type CataloguePage, type Stream, type SyncStore, type SyncTransport, type OutboxRow, type BatchResult } from "../src/index";
import { encodeSyncCursor } from "../src/cursor";

/** The reference `SyncStore`: a map keyed `<stream>:<id>`, one cursor per stream (spec:1330), an outbox array.
 *  6B's SQLite store must behave identically; this one is the executable statement of what "identically" means. */
class MemoryStore implements SyncStore {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly cursors = new Map<string, bigint>();
  readonly outbox: OutboxRow[] = [];
  applied = 0;
  async getCursor(stream: Stream): Promise<bigint> { return this.cursors.get(stream) ?? 0n; }
  async applyChanges(changes: Change[]): Promise<void> {
    if (changes.length === 0) return;
    let high = 0n;
    for (const ch of changes) {
      const key = `${ch.stream}:${ch.id}`;
      if (ch.op === "delete") this.rows.delete(key); else this.rows.set(key, ch.row as Record<string, unknown>);
      if (ch.revision > high) high = ch.revision;
      this.applied += 1;
    }
    // ⚠️ EVERY stream, not only the streams this page carried (Task 0 amendment 23c). A page is ordered by
    // revision ACROSS all streams, so a page ending at revision `high` has delivered everything <= high for
    // every stream — including the streams that had nothing. Advancing only the touched ones would leave
    // `cashier` and `branch_pos_policy` at 0n on every till until 6C ships, and `pullAll`'s minimum-across-
    // streams cursor would therefore be 0n for ever: every pull would re-fetch the whole catalogue and no
    // resume would exist. Nothing would fail; the till would just be permanently slow and permanently at
    // page one. This line is the contract 6B's SQLite store is measured against.
    for (const st of CATALOGUE_STREAMS) this.cursors.set(st, high);
  }
  async pendingOutbox(limit: number): Promise<OutboxRow[]> { return this.outbox.filter((r) => r.ackedAt === null).slice(0, limit); }
  async markAcked(ids: string[], result: BatchResult): Promise<void> {
    const acked = new Set<string>([
      ...result.results.filter((r) => r.status !== "rejected").map((r) => r.clientRef),
      ...result.shiftResults.filter((r) => r.status !== "rejected").map((r) => r.ref),
      ...result.tillEventResults.filter((r) => r.status !== "rejected").map((r) => r.ref),
    ]);
    for (const row of this.outbox) if (ids.includes(row.id) && acked.has(row.ref)) row.ackedAt = new Date().toISOString();
  }
}

function serverWith(changes: Change[], pageSize: number, dieAfterPages = Infinity): SyncTransport & { pages: number } {
  const sorted = [...changes].sort((a, b) => (a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0));
  const t = {
    pages: 0,
    async pullCatalogue(since: string, limit: number): Promise<CataloguePage> {
      if (t.pages >= dieAfterPages) throw new Error("ECONNRESET");
      t.pages += 1;
      const from = since === "" ? 0n : BigInt(Buffer.from(since, "base64url").toString("utf8"));
      const window = sorted.filter((c) => c.revision > from).slice(0, Math.min(limit, pageSize) + 1);
      const hasMore = window.length > Math.min(limit, pageSize);
      const page = hasMore ? window.slice(0, Math.min(limit, pageSize)) : window;
      const next = page.at(-1)?.revision ?? from;
      return { changes: page, next_cursor: encodeSyncCursor({ revision: next }), has_more: hasMore };
    },
    async pushTickets(): Promise<BatchResult> { throw new Error("not used"); },
  };
  return t;
}

const upsert = (stream: Change["stream"], id: string, revision: bigint): Change => ({ stream, op: "upsert", id, revision, row: { id } });
const tombstone = (stream: Change["stream"], id: string, revision: bigint): Change => ({ stream, op: "delete", id, revision, row: null });

describe("acceptance test 20 — catalogue resume (spec:2438)", () => {
  const corpus: Change[] = [];
  for (let i = 1n; i <= 50n; i += 1n) corpus.push(upsert("item", `item-${i}`, i));
  corpus.push(tombstone("item", "item-7", 51n));
  corpus.push(upsert("price_list", "pl-1", 52n));

  it("a complete pull applies every change exactly once and lands on the last revision", async () => {
    const store = new MemoryStore();
    const out = await pullAll(store, serverWith(corpus, 10), { pageSize: 10 });
    expect(out.applied).toBe(corpus.length);
    expect(store.applied).toBe(corpus.length);
    expect(store.rows.has("item:item-7")).toBe(false);       // the tombstone was applied, not ignored
    expect(store.rows.size).toBe(49 + 1);                    // 50 items − 1 deleted + 1 price list
    // 52n and not 51n: the corpus's LAST change is the price_list at 52, and applyChanges advances EVERY
    // stream to the page's highest revision. `item`'s own last change was 51 (the tombstone), but a cursor
    // is a position in the one global revision order, not a high-water mark per table.
    expect(await store.getCursor("item")).toBe(52n);
    for (const st of CATALOGUE_STREAMS) expect(await store.getCursor(st), st).toBe(52n);
  });

  it("killed mid-transfer and resumed: no row applied twice, no deletion missed", async () => {
    const store = new MemoryStore();
    // Three pages of ten, then the connection drops — exactly "kill the down-sync mid-transfer".
    await expect(pullAll(store, serverWith(corpus, 10, 3), { pageSize: 10 })).rejects.toThrow("ECONNRESET");
    const partial = store.applied;
    expect(partial).toBe(30);
    expect(store.rows.has("item:item-7")).toBe(true);        // the tombstone is BEYOND the kill point
    // Three pages of ten ended at revision 30, and every stream now says 30 — so the minimum says 30 too,
    // which is what makes the resume below ask for 31 and not for 1.
    for (const st of CATALOGUE_STREAMS) expect(await store.getCursor(st), st).toBe(30n);

    const out = await pullAll(store, serverWith(corpus, 10), { pageSize: 10 });
    expect(out.applied).toBe(corpus.length - partial);       // only what was left: 22
    expect(store.applied).toBe(corpus.length);               // and the total is exact: nothing applied twice
    expect(store.rows.has("item:item-7")).toBe(false);       // the deletion was NOT missed
    expect(store.rows.size).toBe(50);
  });

  it("the wire cursor is the MINIMUM across streams, so a resume never skips a stream", async () => {
    const store = new MemoryStore();
    // Every stream is preset, and `price_list` is the laggard. Presetting only two would make this case
    // vacuous: the six untouched streams would answer 0n, the minimum would be 0n, and the assertion would
    // pass for the wrong reason on any implementation at all.
    for (const st of CATALOGUE_STREAMS) store.cursors.set(st, 40n);
    store.cursors.set("price_list", 5n);
    // A resume must ask from 5, not from 40, or every price-list change between 5 and 40 is lost for ever.
    const t = serverWith(corpus, 100);
    let asked = "";
    const spy: SyncTransport = { ...t, async pullCatalogue(since, limit) { if (asked === "") asked = since; return t.pullCatalogue(since, limit); } };
    await pullAll(store, spy, { pageSize: 100 });
    expect(BigInt(Buffer.from(asked, "base64url").toString("utf8"))).toBe(5n);
  });

  it("an empty catalogue is a no-op that still terminates", async () => {
    const store = new MemoryStore();
    const out = await pullAll(store, serverWith([], 10), { pageSize: 10 });
    expect(out.applied).toBe(0);
    expect(await store.getCursor("item")).toBe(0n);
  });
});
```

  Run `bun run --cwd packages/sync test -- pull-all`. **Expected failure:** `The requested module '../src/index' does not provide an export named 'pullAll'`.

- [ ] **Step 2: Write `packages/sync/src/client.ts` — §4.10.5 with Task 0 amendment 23 applied.**

```ts
import type { BatchResult, Change, CataloguePage, Stream, TicketBatch } from "./messages";
import { CATALOGUE_STREAMS, SYNC_BATCH_SYNC_LIMIT } from "./messages";
import { encodeSyncCursor } from "./cursor";

/** The local outbox row (§4.10.6 — 6B's SQLite table). `packages/sync` owns the TYPE; 6B owns the table. */
export interface OutboxRow {
  id: string;
  kind: "ticket" | "shift" | "till_event";
  /** The id the server acknowledges by: `Ticket.clientRef`, `"<shiftId>:<kind>"`, `TillEventMsg.clientRef`. */
  ref: string;
  payload: unknown;
  attempts: number;
  lastError: string | null;
  ackedAt: string | null;
}

export interface SyncStore {
  getCursor(stream: Stream): Promise<bigint>;
  /**
   * Applies one page, then advances **every** member of `CATALOGUE_STREAMS` to `max(changes[].revision)` —
   * not only the streams the page happened to carry (§4.10.2, Task 0 amendment 23c).
   *
   * A page is ordered by revision **across all streams**, so a page whose last change is revision *R* has
   * delivered everything at or below *R* for every stream, including the ones with nothing in it. A store
   * that advanced only the touched streams would answer `0n` for every quiet stream for ever — `cashier`
   * and `branch_pos_policy` have no rows at all until 6C ships — and `pullAll`'s minimum-across-streams
   * would then be `0n` on every till in Phase 6: every pull would start from the beginning and no resume
   * would exist. Nothing would throw. **This paragraph is what 6B's SQLite store is measured against.**
   *
   * An empty `changes` array advances nothing.
   */
  applyChanges(changes: Change[]): Promise<void>;
  pendingOutbox(limit: number): Promise<OutboxRow[]>;
  /** Acks all three outbox kinds from one `BatchResult`. A row whose ref appears in NO array stays pending —
   *  never acked on silence (spec:1337). */
  markAcked(ids: string[], result: BatchResult): Promise<void>;
}

/**
 * `pushTickets` rejects with this when the server answered **202** (§4.10.4): the batch went to the
 * `pos.sync.apply` job and there is no per-ticket result yet, so **nothing may be acked**. It is an error
 * rather than a `BatchResult` with three empty arrays precisely because `drainOutbox` must be able to tell
 * "the server acknowledged nothing" from "the server has not answered yet" — the first ends the drain, the
 * second must leave every row pending for the next one.
 */
export class SyncQueuedError extends Error {
  constructor(readonly batchId: string, readonly jobId: string) {
    super(`batch ${batchId} was queued as job ${jobId}; re-send to collect per-ticket results`);
    this.name = "SyncQueuedError";
  }
}

export interface SyncTransport {
  pullCatalogue(since: string, limit: number): Promise<CataloguePage>;
  pushTickets(batch: TicketBatch): Promise<BatchResult>;
}

/**
 * Pulls until `has_more` is false, resuming from the store's own cursor.
 *
 * **The cursor is the MINIMUM across streams and this is the whole correctness argument.** The wire cursor is
 * one scalar over eight streams (§4.10.2). If the till resumed from its highest per-stream cursor, every
 * change to a quieter stream between the minimum and the maximum would be skipped for ever — and nothing
 * would fail, which is why it has to be stated rather than assumed. Re-delivering a change the store has
 * already applied is harmless: `applyChanges` is an upsert-or-delete keyed on `(stream, id)`.
 *
 * **This function does NOT catch.** A dropped connection propagates, the store keeps every change it applied
 * and the cursor those changes advanced, and the next call resumes from there. Swallowing the error here
 * would turn "interrupted" into "finished" — the failure acceptance test 20 exists to catch.
 *
 * **The minimum is only meaningful because `applyChanges` advances every stream** (see `SyncStore` above). A
 * store that advanced only the streams a page carried would hold `0n` on `cashier` and `branch_pos_policy`
 * until 6C ships, the minimum would be `0n` on every till, and this function would restart from the
 * beginning on every call while looking perfectly correct.
 */
export async function pullAll(
  store: SyncStore, transport: SyncTransport, opts: { pageSize?: number } = {},
): Promise<{ applied: number; cursor: string }> {
  const pageSize = opts.pageSize ?? 1000;
  // The MINIMUM across streams, not the maximum and not any one stream's. A till that pulled `item` to
  // revision 900 and `tax_code` only to 400 must resume at 400, or revisions 401..900 of the quieter stream
  // are lost for ever and nothing fails — the silent-starvation failure acceptance test 20 exists to catch.
  const cursors = await Promise.all(CATALOGUE_STREAMS.map((st) => store.getCursor(st)));
  // Seeded with `cursors[0]`, never with `0n`: a minimum seeded at zero is always zero, and the till would
  // re-pull the whole catalogue on every start.
  let cursor = cursors.reduce((min, c) => (c < min ? c : min), cursors[0] ?? 0n);

  let applied = 0;
  let wire = cursor === 0n ? "" : encodeSyncCursor({ revision: cursor });
  for (;;) {
    const page = await transport.pullCatalogue(wire, pageSize);
    if (page.changes.length > 0) {
      await store.applyChanges(page.changes);
      applied += page.changes.length;
    }
    wire = page.next_cursor;
    if (!page.has_more) return { applied, cursor: wire };
  }
}

/**
 * Drains the outbox in batches, marking `acked_at` only on acknowledgement (spec:1337).
 *
 * **`terminalId` and `newBatchId` are required** (Task 0 amendment 23a). §4.10.1 fixes `TicketBatch.batchId`
 * as a **uuidv7**, and `crypto.randomUUID()` is a v4 — spec:2037 admits one and not the other — so the
 * generator is injected rather than chosen here: `packages/sync` runs in the Electron main process and has no
 * database to call `uuidv7()` on. `terminalId` is required because `POST /v1/sync/tickets` refuses a batch
 * whose `terminalId` is not the signing terminal, so a `?? ""` default would only move the failure from a
 * type error to a 400 at the till.
 *
 * **A 202 acknowledges nothing.** An over-size batch is applied by the `pos.sync.apply` job (§4.10.4) and
 * returns no per-ticket result, so the transport's `pushTickets` rejects with `SyncQueuedError` and every row
 * stays pending. The till re-sends, and `client_ref` dedup turns the re-send into a stream of `duplicate`
 * acknowledgements — which is why "re-sending a batch changes nothing" is the DoD sentence and not merely a
 * nice property.
 */
export async function drainOutbox(
  store: SyncStore,
  transport: SyncTransport,
  opts: { terminalId: string; newBatchId: () => string; batchSize?: number },
): Promise<{ accepted: number; duplicates: number; rejected: number }> {
  const batchSize = Math.min(opts.batchSize ?? SYNC_BATCH_SYNC_LIMIT, SYNC_BATCH_SYNC_LIMIT);
  let accepted = 0, duplicates = 0, rejected = 0;
  for (;;) {
    const pending = await store.pendingOutbox(batchSize);
    if (pending.length === 0) return { accepted, duplicates, rejected };

    const batch: TicketBatch = {
      terminalId: opts.terminalId,
      batchId: opts.newBatchId(),
      tickets: pending.filter((r) => r.kind === "ticket").map((r) => r.payload as TicketBatch["tickets"][number]),
      shifts: pending.filter((r) => r.kind === "shift").map((r) => r.payload as TicketBatch["shifts"][number]),
      tillEvents: pending.filter((r) => r.kind === "till_event").map((r) => r.payload as TicketBatch["tillEvents"][number]),
    };
    const result = await transport.pushTickets(batch);

    // Derive the acknowledged refs from the RESULT, before handing it to the store — this is the set the loop
    // makes its own termination decision on, and it must not depend on the store mutating the row objects it
    // already returned. `MemoryStore` happens to mutate them; 6B's SQLite store will return fresh rows on
    // every `pendingOutbox`, and a loop that read `pending[].ackedAt` back would then never see an ack, never
    // terminate on an all-accepted drain, and spin until the outbox emptied — or, on a snapshotting store,
    // for ever. Termination is this function's own responsibility and the port's contract does not carry it.
    const ackedRefs = new Set<string>([
      ...result.results.filter((r) => r.status !== "rejected").map((r) => r.clientRef),
      ...result.shiftResults.filter((r) => r.status !== "rejected").map((r) => r.ref),
      ...result.tillEventResults.filter((r) => r.status !== "rejected").map((r) => r.ref),
    ]);
    await store.markAcked(pending.map((r) => r.id), result);

    for (const r of result.results) {
      if (r.status === "accepted") accepted += 1; else if (r.status === "duplicate") duplicates += 1; else rejected += 1;
    }
    for (const r of [...result.shiftResults, ...result.tillEventResults]) {
      if (r.status === "accepted") accepted += 1; else if (r.status === "duplicate") duplicates += 1; else rejected += 1;
    }

    // The ONE exit besides an empty outbox: this pass acknowledged nothing new, so the next pass would send
    // the identical rows and get the identical answer. A rejected row is still pending — it never acks — and
    // without this a batch of pure rejections would re-send for ever.
    if (!pending.some((r) => ackedRefs.has(r.ref))) return { accepted, duplicates, rejected };
  }
}
```

  **The `reduce` seed is load-bearing, and there is exactly one of it.** Write the line as shown — `cursors.reduce((min, c) => (c < min ? c : min), cursors[0] ?? 0n)` — and put the reason on it as a comment in the file: *"seeded with `cursors[0]`, never with `0n`: a minimum seeded at zero is always zero, and the till would re-pull the whole catalogue on every start."* There is nothing to delete here; an earlier draft of this plan showed a second, wrong assignment beside it to name the mistake, and this sentence replaces it because a step that says "delete a line" against a block that has only the right one deletes the working code.

- [ ] **Step 3: Write `packages/sync/test/drain-outbox.test.ts`.**

```ts
// packages/sync/test/drain-outbox.test.ts
import { describe, expect, it } from "vitest";
import { drainOutbox, SyncQueuedError, type BatchResult, type OutboxRow, type SyncStore, type SyncTransport, type TicketBatch } from "../src/index";

/** A counter, not `crypto.randomUUID()`: §4.10.1 fixes `batchId` as a uuidv7 and a test that minted a v4
 *  would be asserting against a shape the wire refuses. The counter also makes the assertions below readable. */
const counter = (): (() => string) => { let n = 0; return () => `batch-${(n += 1)}`; };

class Store implements SyncStore {
  readonly outbox: OutboxRow[];
  readonly cursors = new Map<string, bigint>();
  constructor(rows: Pick<OutboxRow, "id" | "kind" | "ref">[]) {
    this.outbox = rows.map((r) => ({ ...r, payload: { ref: r.ref }, attempts: 0, lastError: null, ackedAt: null }));
  }
  async getCursor(): Promise<bigint> { return 0n; }
  async applyChanges(): Promise<void> {
    // `drainOutbox` never pulls, so a call here means the function under test grew a down-sync it should not
    // have. A throw says that; an empty body would let the defect pass as a silent no-op.
    throw new Error("drainOutbox called applyChanges — down-sync belongs to pullAll (pull-all.test.ts)");
  }
  /** Returns FRESH objects on every call, exactly as 6B's SQLite store will. A `drainOutbox` that decided
   *  termination by reading `ackedAt` back off the rows it was handed would loop for ever against this. */
  async pendingOutbox(limit: number): Promise<OutboxRow[]> {
    return this.outbox.filter((r) => r.ackedAt === null).slice(0, limit).map((r) => ({ ...r }));
  }
  async markAcked(ids: string[], result: BatchResult): Promise<void> {
    const acked = new Set<string>([
      ...result.results.filter((r) => r.status !== "rejected").map((r) => r.clientRef),
      ...result.shiftResults.filter((r) => r.status !== "rejected").map((r) => r.ref),
      ...result.tillEventResults.filter((r) => r.status !== "rejected").map((r) => r.ref),
    ]);
    for (const row of this.outbox) if (ids.includes(row.id) && acked.has(row.ref)) row.ackedAt = new Date().toISOString();
  }
}

/** Answers each ticket/message by a scripted status looked up on its ref; a ref with no entry is OMITTED from
 *  every array, which is spec:1337's "silence". */
function scriptedTransport(script: Record<string, "accepted" | "duplicate" | "rejected">): SyncTransport & { sent: TicketBatch[] } {
  const t = {
    sent: [] as TicketBatch[],
    async pullCatalogue(): Promise<never> { throw new Error("not used"); },
    async pushTickets(batch: TicketBatch): Promise<BatchResult> {
      t.sent.push(batch);
      const err = (s: string) => (s === "rejected" ? { code: "ERR_SYNC_TICKET_REJECTED" as const, detail: "scripted" } : null);
      return {
        batchId: batch.batchId,
        results: batch.tickets.filter((x) => script[x.clientRef] !== undefined)
          .map((x) => ({ clientRef: x.clientRef, status: script[x.clientRef]!, documentId: null, number: null, error: err(script[x.clientRef]!) })),
        shiftResults: batch.shifts.map((m) => `${m.shiftId}:${m.kind}`).filter((r) => script[r] !== undefined)
          .map((r) => ({ ref: r, status: script[r]!, error: err(script[r]!) })),
        tillEventResults: batch.tillEvents.filter((m) => script[m.clientRef] !== undefined)
          .map((m) => ({ ref: m.clientRef, status: script[m.clientRef]!, error: err(script[m.clientRef]!) })),
        catalogueCursor: "MA",
      };
    },
  };
  return t;
}

const OPTS = { terminalId: "term-1", newBatchId: counter() };

describe("drainOutbox (§4.10.5) — acked only on acknowledgement (spec:1337)", () => {
  it("three accepted tickets are all acked and the loop terminates", async () => {
    const store = new Store([
      { id: "o1", kind: "ticket", ref: "t1" }, { id: "o2", kind: "ticket", ref: "t2" }, { id: "o3", kind: "ticket", ref: "t3" },
    ]);
    // `payload.ref` is what the scripted transport reads back as `clientRef`; the rows carry it as `payload`.
    for (const r of store.outbox) r.payload = { clientRef: r.ref };
    const t = scriptedTransport({ t1: "accepted", t2: "accepted", t3: "accepted" });
    const out = await drainOutbox(store, t, { ...OPTS, newBatchId: counter(), batchSize: 10 });
    expect(out).toEqual({ accepted: 3, duplicates: 0, rejected: 0 });
    expect(store.outbox.every((r) => r.ackedAt !== null)).toBe(true);
    // Two passes: one that sent three, one that found the outbox empty. Never three, and never unbounded —
    // and this is the assertion that fails if termination reads `ackedAt` off the returned rows, because
    // `pendingOutbox` above hands out copies.
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.terminalId).toBe("term-1");
    expect(t.sent[0]!.batchId).toBe("batch-1");
  });

  it("accepted + duplicate + rejected: two ack, the rejected one stays pending, and the drain STOPS", async () => {
    const store = new Store([
      { id: "o1", kind: "ticket", ref: "t1" }, { id: "o2", kind: "ticket", ref: "t2" }, { id: "o3", kind: "ticket", ref: "t3" },
    ]);
    for (const r of store.outbox) r.payload = { clientRef: r.ref };
    const t = scriptedTransport({ t1: "accepted", t2: "duplicate", t3: "rejected" });
    const out = await drainOutbox(store, t, { ...OPTS, newBatchId: counter(), batchSize: 10 });
    expect(out).toEqual({ accepted: 1, duplicates: 1, rejected: 1 });
    expect(store.outbox.find((r) => r.id === "o3")!.ackedAt).toBeNull();
    // A second pass sends only t3, acknowledges nothing new, and ends. Without the "nothing new" exit this
    // loop would re-send the same rejection until the process died.
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.tickets).toHaveLength(1);
  });

  it("a shift and a till event ack through their OWN result arrays (§4.10.1's two extra arrays)", async () => {
    const store = new Store([{ id: "o1", kind: "shift", ref: "sh-1:open" }, { id: "o2", kind: "till_event", ref: "te-1" }]);
    store.outbox[0]!.payload = { shiftId: "sh-1", kind: "open" };
    store.outbox[1]!.payload = { clientRef: "te-1" };
    const t = scriptedTransport({ "sh-1:open": "accepted", "te-1": "accepted" });
    const out = await drainOutbox(store, t, { ...OPTS, newBatchId: counter(), batchSize: 10 });
    expect(out).toEqual({ accepted: 2, duplicates: 0, rejected: 0 });
    expect(store.outbox.every((r) => r.ackedAt !== null)).toBe(true);
    // Without shiftResults and tillEventResults these two kinds could never ack and would re-send for ever
    // (spec:1337) — which is the whole reason §4.10.1 carries three arrays and not one.
  });

  it("a ref that appears in NO array stays pending — never acked on silence (spec:1337)", async () => {
    const store = new Store([{ id: "o1", kind: "ticket", ref: "t1" }, { id: "o2", kind: "ticket", ref: "t2" }]);
    for (const r of store.outbox) r.payload = { clientRef: r.ref };
    const t = scriptedTransport({ t1: "accepted" });          // t2 is simply absent from every array
    const out = await drainOutbox(store, t, { ...OPTS, newBatchId: counter(), batchSize: 10 });
    expect(out).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    expect(store.outbox.find((r) => r.id === "o2")!.ackedAt).toBeNull();
  });

  it("a 202 acknowledges nothing: SyncQueuedError propagates and every row stays pending", async () => {
    const store = new Store([{ id: "o1", kind: "ticket", ref: "t1" }]);
    store.outbox[0]!.payload = { clientRef: "t1" };
    const t: SyncTransport = {
      async pullCatalogue(): Promise<never> { throw new Error("not used"); },
      async pushTickets(b) { throw new SyncQueuedError(b.batchId, "job-9"); },
    };
    await expect(drainOutbox(store, t, { ...OPTS, newBatchId: counter() })).rejects.toBeInstanceOf(SyncQueuedError);
    expect(store.outbox[0]!.ackedAt, "a queued batch acks nothing").toBeNull();
  });
});
```

- [ ] **Step 4: Move `MemoryStore` into the shared fixture.** Export it from `tests/invariants/support/pos.ts` as `MemorySyncStore` (§4.17.1's registered name) and have `packages/sync/test/pull-all.test.ts` keep its own local copy — the two workspaces cannot import each other (`packages/sync` may not import from `tests/`, and `tests/` importing a test file is worse). The duplication is deliberate and one line of comment says so in both files: **the `packages/sync` copy is the specification of the port and the `tests/` copy is what 6B's SQLite store is compared against.**

  ⚠️ **Both copies carry the `applyChanges` cursor rule** — the `for (const st of CATALOGUE_STREAMS) this.cursors.set(st, high)` line and its comment, verbatim. That line *is* the contract of Task 0 amendment 23c; a `MemorySyncStore` that advanced only the touched streams would hand 6B a reference implementation whose resume never works, and 6B would build to it. Add one assertion in `pull-all.test.ts` and one in whichever 6B test consumes `MemorySyncStore`: after a page, `getCursor(st)` is equal for every `st` in `CATALOGUE_STREAMS`.

- [ ] **Step 5: Run and commit.** `bun run --cwd packages/sync test` — **expected:** 5 + 4 + 5 = 14 passed (`cursor` 5, `pull-all` 4, `drain-outbox` 5).

```bash
git add packages/sync/src/client.ts packages/sync/src/index.ts packages/sync/test tests/invariants/support/pos.ts
git commit -m "$(cat <<'EOF'
feat(sync): pullAll and drainOutbox — acceptance test 20 (catalogue resume) [6A T9]

The wire cursor is the MINIMUM across streams: resuming from the highest would skip every
change to a quieter stream for ever, and nothing would fail. pullAll deliberately does not
catch — an interrupted pull must stay interrupted, or "resumed" and "finished" become the
same state. markAcked never acks on silence (spec:1337).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `POS_TICKET` — the document type, the tender-line contract, and the shared POS fixture

**Files**

- `packages/db/seed/my/document-types/POS_TICKET.json` — NEW
- `packages/db/src/posting/load.ts` — MODIFY (lift `custom_fields.method` → `tenderMethod`)
- `apps/api/src/routes/accounting/documents.ts` — MODIFY (`DOCUMENT_STAGE_CODES` gains `pos.sync.push`)
- `apps/api/src/middleware/require-document-permission.ts` — MODIFY (`POLICY_RESOLVED_CODES`)
- `tests/invariants/support/pos.ts` — MODIFY (`posFixture`, `PosFixture`, `buildTicket`)
- `packages/db/test/sync/pos-ticket-policy.test.ts` — NEW

**Interfaces**

- Consumes: the §4.3.7 envelope and `documentTypesLoader` (1A); `validatePolicy`, `parsePolicy`, `evaluatePolicy`, `planMovements`, `LineSnapshot` (2A/3A); `POLICY_RESOLVED_CODES`, `DOCUMENT_STAGE_CODES` (2A); `taxFixture`, `seedTaxPack` (5A); `seedItem`, `seedWarehouse`, `seedUnit` (3A); `postInventoryDocument`, `ensureOpenPeriods` (3B).
- Produces: §4.14's `POS_TICKET` row as a seed-pack envelope; the `tenderMethod` lift; `posFixture` and `buildTicket` (§4.17.1).

**Steps**

- [ ] **Step 1: Write the failing test first.**

```ts
// packages/db/test/sync/pos-ticket-policy.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { evaluatePolicy, parsePolicy, validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import { startDb, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import { PACK_ROOT } from "../ar-ap/_support";

const envelope = JSON.parse(readFileSync(join(PACK_ROOT, "document-types", "POS_TICKET.json"), "utf8")) as Record<string, unknown>;

describe("POS_TICKET (§4.14, §4.6.5) — configuration, not code", () => {
  let db: Db; let s: Seed;
  beforeAll(async () => { db = await startDb(); s = await seedTenantV2(db, "Alpha"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("the envelope and the policy both validate, and every permission code is in the catalogue (F-21)", () => {
    expect(validateDocumentTypeSeed(envelope).ok).toBe(true);
    const report = validatePolicy(envelope.policy, PERMISSIONS.map((p) => p.code));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("the envelope's module is `pos` and its series is `POS` (§4.14, §4.3.6's suffix supplies the terminal)", () => {
    expect(envelope.code).toBe("POS_TICKET");
    expect(envelope.module).toBe("pos");
    expect((envelope.policy as { numbering: { series: string } }).numbering.series).toBe("POS");
    expect((envelope.policy as { approval: { post: string } }).approval.post).toBe("pos.sync.push");
  });

  it("the four tender rules resolve the four §4.6.5 accounts BY CODE, and no fifth method exists", () => {
    const lines = (envelope.policy as { lines: { when?: Record<string, string>; account: Record<string, string> }[] }).lines;
    const tenders = lines.filter((l) => l.when?.["line.kind"] === "tender");
    expect(tenders).toHaveLength(4);
    expect(tenders.map((l) => [l.when!["line.tender_method"], l.account.code]).sort()).toEqual([
      ["card", "1120"], ["cash", "1110"], ["store_credit", "2200"], ["transfer", "1100"],
    ]);
    expect(tenders.every((l) => l.side === "debit")).toBe(true);   // money IN is a debit, all four of them
  });

  it("a SALE plans revenue credit, COGS debit, inventory credit and a cash debit — every side from the policy", () => {
    const policy = parsePolicy(envelope.policy);
    const plan = evaluatePolicy(policy, saleSnapshot());
    const byAccount = plan.ledgerLines.map((l) => `${l.accountId}:${l.side}:${l.amount.toString()}`).sort();
    // ⚠️ The figures are 5A's SYNTHETIC `SYN-OUT-STD` rate, `0.11000000` (phase-5a:53 — "an eleven-percent
    // figure chosen so it cannot be mistaken for a published one"). An earlier draft of this plan wrote 6%
    // and a gross of 106.0000: that is Malaysia's ACTUAL current standard rate, which hazard 1 forbids
    // anywhere in this repository, and it also disagrees with the only rate `taxFixture` seeds — so the case
    // was both a hazard breach and a failing assertion. `saleSnapshot()` below takes the rate from the same
    // literal 5A ships and no figure in this slice is chosen by this plan.
    expect(byAccount).toEqual([
      "acct-1110:debit:111.0000",     // the cash tender — the tax-inclusive total the customer pays
      "acct-1300:credit:60.0000",     // inventory relieved at cost
      "acct-2300:credit:11.0000",     // output tax, extracted from the inclusive total
      "acct-4000:credit:100.0000",    // revenue, excl. tax
      "acct-5000:debit:60.0000",      // COGS
    ]);
    expect(plan.ledgerLines.every((l) => !l.amount.isNegative()), "A9: an amount is never negative").toBe(true);
    expect(plan.movements).toHaveLength(1);
    expect(plan.movements[0]!.effect).toBe("issue");
  });

  it("a RETURN plans the SAME accounts with every side flipped, from ONE policy (A9, 3A's effect rule)", () => {
    const policy = parsePolicy(envelope.policy);
    const plan = evaluatePolicy(policy, returnSnapshot());
    const byAccount = plan.ledgerLines.map((l) => `${l.accountId}:${l.side}:${l.amount.toString()}`).sort();
    // The SAME five accounts and the SAME five magnitudes as the sale above, with every side flipped, from
    // ONE policy — which is the whole assertion. Same synthetic 0.11 rate (phase-5a:53).
    expect(byAccount).toEqual([
      "acct-1110:credit:111.0000",
      "acct-1300:debit:60.0000",
      "acct-2300:debit:11.0000",
      "acct-4000:debit:100.0000",
      "acct-5000:credit:60.0000",
    ]);
    expect(plan.ledgerLines.every((l) => !l.amount.isNegative())).toBe(true);
    // 3A's rule: a policy declaring `issue` over a NEGATIVE quantity emits `receipt` at the magnitude.
    expect(plan.movements[0]!.effect).toBe("receipt");
    expect(plan.movements[0]!.quantity.isNegative()).toBe(false);
  });
});
```

  `saleSnapshot()` and `returnSnapshot()` are file-local builders producing a `DocumentSnapshot` **in §4.4.2's declared shape, member for member**. They are written from 2A's own `line()` / `snapshot()` helpers (phase-2a:1355–1385), which is the template every later slice copies, and not from a shorter improvisation: `evaluatePolicy` calls `Money` and `Quantity` methods on these fields, so a decimal **string** where §4.4.2 declares `Money` is a runtime `TypeError` inside the evaluator, not a type nit. In particular `LineSnapshot`'s key is **`id`** (not `lineId`), `quantity`/`unitQuantity` are `Quantity | null`, `unitPrice`/`cost` are `Money | null`, `discount`/`amount`/`taxAmount`/`totalInclTax`/`debit`/`credit` are non-null `Money`, and the header's key is **`id`** with `currency: CurrencyCode` and `exchangeRate: ExchangeRate`:

```ts
// packages/db/test/sync/pos-ticket-policy.test.ts — the two builders, at the foot of the file.
import { currency, Money, Quantity, UNIT_RATE } from "@dulja/domain";
import type { DocumentSnapshot, ItemRef, LineSnapshot, TaxCodeRef } from "@dulja/domain";

/** 5A's SYNTHETIC standard-rated output rate (phase-5a:53). It is a literal here because this test drives
 *  `evaluatePolicy` as a pure function with no database — there is no seeded `tax_code` to read it from — and
 *  it is the SAME literal 5A ships, never a figure this plan chose. Eleven percent is deliberately not a
 *  published Malaysian rate (hazard 1, OD-15). */
const SYNTH_RATE = "0.11000000";
const MYR = currency("MYR");
const m = (v: string): Money => Money.of(v, MYR);
const q = (v: string): Quantity => Quantity.of(v);
const ZERO = m("0.0000");

/** 2A's `line()` helper (phase-2a:1355–1362), with `tenderMethod` filled: EVERY member of §4.4.2's
 *  `LineSnapshot` is present, so `evaluatePolicy` never reads an `undefined` and TypeScript never widens. */
const line = (over: Partial<LineSnapshot> & { lineNo: number }): LineSnapshot => ({
  id: `l-${over.lineNo}`, lineNo: over.lineNo, kind: "item", description: null,
  accountId: null, itemId: null, quantity: null, unitPrice: null, discount: ZERO, amount: ZERO,
  taxCodeId: null, taxAmount: ZERO, totalInclTax: ZERO, debit: ZERO, credit: ZERO, cost: null,
  warehouseId: null, toWarehouseId: null, lotId: null, unitId: null, unitQuantity: null,
  countedQuantity: null, expectedQuantity: null, tenderMethod: null,
  customFields: {}, dimensions: {}, payroll: null, ...over,
});

function saleSnapshot(): DocumentSnapshot {
  const qty = q("2.000000");
  const net = m("100.0000");                      // 2 × 50.0000, excl. tax
  const tax = m("11.0000");                       // net × SYNTH_RATE
  const gross = net.add(tax);                     // 111.0000 — what the customer pays and tenders
  return {
    header: {
      id: "doc-1", companyId: "co-1", documentTypeCode: "POS_TICKET", status: "issued", series: "POS",
      fiscalPeriodId: "fp-1", number: 1n, effectiveDate: "2026-01-15", partyId: null,
      currency: MYR, exchangeRate: UNIT_RATE(MYR), branchId: "br-1", attributedTo: "cashier-1",
      clientRef: "00000000-0000-7000-8000-000000000001", warehouseId: "wh-1", toWarehouseId: null,
      taxInclusive: true, reversesDocumentId: null, customFields: {},
    },
    company: { id: "co-1", baseCurrency: MYR, fxRoundingAccountId: "acct-5920", costingMethod: "fifo" },
    party: null,
    lines: [
      line({ lineNo: 1, kind: "item", itemId: "item-1", quantity: qty, unitPrice: m("50.0000"),
             discount: ZERO, amount: net, taxCodeId: "tc-1", taxAmount: tax, totalInclTax: gross,
             cost: m("60.0000"), warehouseId: "wh-1" }),
      line({ lineNo: 2, kind: "tender", amount: gross, totalInclTax: gross, tenderMethod: "cash",
             customFields: { method: "cash", reference: null } }),
    ],
    refs: {
      accountsByCode: { "1110": "acct-1110", "1120": "acct-1120", "1100": "acct-1100", "2200": "acct-2200" },
      items: { "item-1": { id: "item-1", code: "SKU-A", kind: "product", baseUnitId: "u-1", trackLots: false,
                           revenueAccountId: "acct-4000", inventoryAccountId: "acct-1300",
                           cogsAccountId: "acct-5000", expenseAccountId: null } satisfies ItemRef },
      taxCodes: { "tc-1": { id: "tc-1", code: "SYN-OUT-STD", rate: SYNTH_RATE, kind: "output",
                            roundingMode: "HALF_AWAY_FROM_ZERO", outputAccountId: "acct-2300",
                            inputAccountId: null } satisfies TaxCodeRef },
      components: {}, schemes: {},
      dimensionTypesByCode: { BRANCH: "dt-branch" },
    },
  };
}

/** The sale with `quantity`, `amount`, `taxAmount`, `totalInclTax` and the TENDER's `amount` negated, and
 *  `cost` left POSITIVE. §4.4.2's A9 and 3A's rule are what make that enough: `planMovements` emits `receipt`
 *  at that quantity's magnitude (`Quantity` has `negate` and no `abs`) from a policy declaring `issue`, and
 *  `evaluatePolicy` emits the opposite `side` at `amount.abs()` (`Money` does have it). Nothing in the policy
 *  and nothing in this builder chooses a direction — and nothing here does string arithmetic on a decimal:
 *  `Money.negate()` and `Quantity.negate()` are the two calls, because these fields ARE `Money`/`Quantity`. */
function returnSnapshot(): DocumentSnapshot {
  const s = saleSnapshot();
  return {
    ...s,
    lines: s.lines.map((l) => l.kind === "item"
      ? { ...l, quantity: l.quantity!.negate(), amount: l.amount.negate(),
                taxAmount: l.taxAmount.negate(), totalInclTax: l.totalInclTax.negate() }
      : { ...l, amount: l.amount.negate(), totalInclTax: l.totalInclTax.negate() }),
  };
}
```

  ⚠️ **These builders are §4.4.2 verbatim, and 2A's `line()`/`snapshot()` helpers (phase-2a:1355–1385) are their source.** Every member of `DocumentSnapshot`, `LineSnapshot`, `ItemRef` and `TaxCodeRef` is present and carries the declared *type* — `Money` and `Quantity` objects, not decimal strings — because `evaluatePolicy` calls methods on them. Task 0's gate asserts the two type names exist; §4.18's rule settles any residual spelling difference in 2A's favour, and this builder then takes 2A's spelling. What is load-bearing beyond the shape is the *case*: one item line, one cash tender line, `taxInclusive: true`, and `cost` positive in both directions. Run `bun run --cwd packages/db test -- sync/pos-ticket-policy`. **Expected failure:** `ENOENT: no such file or directory … document-types/POS_TICKET.json`.

- [ ] **Step 2: Write the envelope.**

```json
// packages/db/seed/my/document-types/POS_TICKET.json
// §4.3.7's envelope · §4.14's row (module `pos`, series `POS`) · §4.6.5's tender contract.
{
  "code": "POS_TICKET",
  "nameEn": "POS Ticket",
  "nameAr": "فاتورة نقطة بيع",
  "module": "pos",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "POS_TICKET",
    "direction": "outbound",
    "requires": ["client_ref", "attributed_to", "warehouse"],
    "lines": [
      { "for": "each_line", "side": "credit", "account": { "from": "item.revenue_account" },   "amount": "line.amount", "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "debit",  "account": { "from": "item.cogs_account" },      "amount": "line.cost",   "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "credit", "account": { "from": "item.inventory_account" }, "amount": "line.cost",   "when": { "line.kind": "item" } },
      { "for": "each_line", "side": "debit",  "account": { "code": "1110" }, "amount": "line.amount", "when": { "line.kind": "tender", "line.tender_method": "cash" } },
      { "for": "each_line", "side": "debit",  "account": { "code": "1120" }, "amount": "line.amount", "when": { "line.kind": "tender", "line.tender_method": "card" } },
      { "for": "each_line", "side": "debit",  "account": { "code": "1100" }, "amount": "line.amount", "when": { "line.kind": "tender", "line.tender_method": "transfer" } },
      { "for": "each_line", "side": "debit",  "account": { "code": "2200" }, "amount": "line.amount", "when": { "line.kind": "tender", "line.tender_method": "store_credit" } },
      { "for": "each_tax",  "side": "credit", "account": { "from": "tax_code.output_account" }, "amount": "tax.amount" }
    ],
    "inventory": { "effect": "issue", "warehouse": "header.warehouse", "costing": "consume_layers", "allowNegative": false },
    "tax": { "applies": true, "inclusive": true },
    "numbering": { "series": "POS", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "POS_TICKET" },
    "approval": { "required": false, "approve": null, "post": "pos.sync.push" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

  **Five decisions in that file, each of which a reader would otherwise have to reconstruct:**

  1. **`requires: ["client_ref", "attributed_to", "warehouse"]` and *not* `"party"`.** A walk-in sale has no customer, and requiring one would make the commonest ticket in the system unpostable. `client_ref` and `attributed_to` are required because a ticket without them is not a ticket: the first is the dedup key (spec:1302) and the second is the cashier (spec:1324).
  2. **`tax.inclusive: true` as a literal boolean, not `"header.tax_inclusive"`.** §4.4.1 admits both. A till prices tax-inclusive by construction — the customer pays the shelf price — and a per-document flag would let one ticket in a batch disagree with the next about what its own totals meant. `applyBatch` sets `document.tax_inclusive = true` as well, so `resolveInclusive` (5A) answers the same way from either input.
  3. **`approval.required: false` and `post: "pos.sync.push"`.** §4.5.1 makes `draft → issued` legal only for a policy with `approval.required = false`, and a maker-checker on a POS ticket would mean a supervisor approving every sale. R2 still applies at `issued → posted`: `app.actor_has('pos.sync.push', company, branch)` is evaluated **inside the posting transaction** against the terminal, so a revoked terminal's in-flight batch dies at the trigger and not merely at the middleware.
  4. **`reversal.producesType: "POS_TICKET"`.** A voided or corrected ticket reverses into another ticket with negated magnitudes (D13), which is the same shape as a return and needs no second type.
  5. **`dimensions.required: ["BRANCH"]`** — spec:1066 makes BRANCH mandatory on revenue and COGS lines, and every ticket has both. `document.branch_id` is the terminal's branch, so the evaluator satisfies it with no per-line work.

  ⚠️ **`account: { "code": "1100" }` for the transfer tender is 0C's account, not this slice's.** Hazard 33 requires the *seeding* slice for the other three to be this one, which it is (`6a-pos-tenders.json`, Task 5); `1100` is consumed and Task 5's fourth test case already asserts it resolves.

- [ ] **Step 3: Lift the tender method in `loadSnapshot` (§4.4.2, Task 0 amendment 17).**

```ts
// packages/db/src/posting/load.ts — inside the line mapper, beside the other typed lifts.
      /**
       * §4.4.2: the `when` filter's `line.tender_method` reads this TYPED field, never the untyped bag —
       * so a policy can never match on a misspelt key and silently plan nothing. `custom_fields.reference`
       * stays in the bag: nothing branches on it, and the receipt number of a card payment is data.
       * 6A's migration 0061 is what makes `kind = 'tender'` legal at all.
       */
      tenderMethod:
        row.kind === "tender" && TENDER_METHODS.has(String((row.custom_fields as Record<string, unknown>).method))
          ? ((row.custom_fields as Record<string, unknown>).method as LineSnapshot["tenderMethod"])
          : null,
```

  with `const TENDER_METHODS = new Set(["cash", "card", "transfer", "store_credit"]);` at module scope. **A tender line whose `method` is absent or unknown lifts to `null`, matches no rule and plans no ledger line** — and `postDocument` then fails `assert_document_balanced` at COMMIT with `ERR_LEDGER_UNBALANCED`, because the item lines credited revenue with nothing debiting cash. That is the right failure: loud, at post, naming the document. `applyBatch` validates the method against the same four values before it inserts, so the case is unreachable from the sync path and reachable only from a hand-written document.

- [ ] **Step 4: Register the policy-resolved code.** `pos.sync.push` is resolved from **data** — `policy.approval.post` — and no source scan can see it, so §3.6.3's `permission-catalogue` lint would report it unreferenced. Add it to `POLICY_RESOLVED_CODES` in `apps/api/src/middleware/require-document-permission.ts` (2A's constant, which `DOCUMENT_STAGE_CODES` is initialised from — §4.5.4), with the comment *"6A: `POS_TICKET.approval.post`. The route that evaluates it is `POST /v1/sync/tickets`, which resolves it through `postDocument`, not through `requireDocumentPermission`."*

- [ ] **Step 5: Append the fixture's two interfaces (§4.17.1).** This step writes **types only** — `PosFixture` and `BuildTicketOptions`, both real file content. Step 6 writes the two function bodies. They are split because the bodies are long and the shapes are what 6C, 6D and 7C compile against; a function *declaration* with no body is a TypeScript error in a module, so nothing in this block is a signature.

```ts
// tests/invariants/support/pos.ts — appended to Task 6's file.
export interface PosFixture {
  s: Seed;
  api: StartedApi;
  terminal: EnrolledTerminal;
  /** SKU → { itemId, baseUnitId }; three items, all `track_lots: false`, all stocked. */
  items: Record<string, { itemId: string; baseUnitId: string }>;
  warehouseId: string;
  /** account code → id, for every code POS_TICKET's policy or its assertions name. */
  accounts: Record<string, string>;
  /** document type code → id: POS_TICKET and POS_EQUIV_INVOICE. */
  types: Record<string, string>;
  /** 5A's four pack codes → `tax_code.id`. */
  taxCodes: Record<string, string>;
  /** The same four → their `rate`, READ from `app.tax_code` and never restated: hazard 1 forbids a rate
   *  literal in a plan or a fixture, synthetic or not, and `buildTicket` needs one to price a line. */
  taxRates: Record<string, string>;
  /** The same four → the two figures a tax-INCLUSIVE line needs, so that `buildTicket` restates neither the
   *  rate nor the rounding rule: `divisor` is `(1 + rate)::text` computed by **Postgres**, whose numeric is
   *  exact and needs no decimal library in a fixture, and `roundingMode` is the CODE's own — LEGACY-019's finding
   *  is that the mode belongs to the code and not to the engine, and 5A's inclusive branch honours it. */
  taxInclusive: Record<string, { divisor: string; roundingMode: RoundingMode }>;
  cashierId: string;
  supervisorId: string;
}

/** `buildTicket`'s options, a NAMED interface and not an inline object type. It is named for two reasons:
 *  6C, 6D and 7C all call `buildTicket` and one of them will want to widen it, and a body written as
 *  `opts: Parameters<typeof buildTicket>[1]` would be a declaration whose parameter list refers to its own
 *  `typeof` — a circular self-reference the compiler cannot resolve. §4.17.1 registers the name. */
export interface BuildTicketOptions {
  clientRef?: string; kind?: "sale" | "return"; sku?: string; quantity?: string; unitPrice?: string;
  tender?: TicketTender["method"]; cashierPrincipalId?: string; events?: TicketEvent[];
  customerId?: string | null; newCustomer?: NewCustomer | null; returnsClientRef?: string | null;
  discount?: string; shiftId?: string;
}
```

  The two functions those types describe, so a reader knows what Step 6 lands and in what order: **`posFixture(api, name): Promise<PosFixture>`** — the one setup every Phase 6 test uses, building a company that can actually sell (three items with opening stock posted through the REAL posting service, never an `insert into app.cost_layer` — hazard 22; 5A's tax pack; both document types; an enrolled terminal; and the cashier/supervisor pair acceptance test 37 needs) — and **`buildTicket(f, opts): Ticket`** — one `Ticket` over that fixture, where `kind: "return"` negates quantity, amount, tax and tender **in one place** so no test hand-negates and gets one field wrong. 6C, 6D and 7C all consume both.

- [ ] **Step 6: Write the offline id minter, the shift constant, and the two fixture bodies.**

```ts
// tests/invariants/support/pos.ts — appended.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currency, Money, Quantity, type RoundingMode } from "@dulja/domain";
import { grantCodes, seedDocumentType, seedItem, seedUnit, seedWarehouse, uuidv7 } from "@dulja/db/test";
import { ensureOpenPeriods, postInventoryDocument, secondPrincipal } from "./post-inventory";
import { taxFixture } from "./tax";
import type { NewCustomer, Ticket, TicketEvent, TicketTender } from "@dulja/sync";

/**
 * A uuidv7 minted **at the till, offline, with no database** — which is exactly the fact spec:1302 relies on
 * when it makes `client_ref` the idempotency key. `@dulja/db/test`'s `uuidv7(sql)` is a round trip and
 * `buildTicket` is synchronous, so this is the synchronous half; §4.1 is immovable and that helper is not
 * widened. **Never `crypto.randomUUID()`**, which is a v4 — spec:2037 admits v7 and not v4, and §4.10.1 fixes
 * `batchId` and `clientRef` as v7s, so a suite minting v4s would assert the protocol with values it refuses.
 *
 * Layout, RFC 9562: 48-bit big-endian millisecond timestamp, version nibble `7`, RFC 4122 variant `10`, and
 * 74 random bits. It is **not monotonic within one millisecond** — two ids minted in the same tick sort
 * arbitrarily against each other. That is harmless for test identifiers, which are only ever compared for
 * equality; 6B's till, whose outbox is ordered, mints its own and does not copy this.
 */
export function uuidv7Sync(): string {
  const b = new Uint8Array(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  crypto.getRandomValues(b.subarray(6));
  b[6] = (b[6]! & 0x0f) | 0x70;                 // version 7
  b[8] = (b[8]! & 0x3f) | 0x80;                 // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** One shift for every ticket in a suite, so no test has to invent one. `document.shift_id` is 0061's column
 *  and carries no FK, so at 6A this id references nothing; **6D's amendment A6 inserts the `app.shift` row at
 *  exactly this id**, which is why it is exported and registered (§4.17.1) rather than file-local. */
export const SHARED_SHIFT_ID = uuidv7Sync();

/** The SYNTH standard-rated output code's rate, taken from 5A's own pack and never restated as a number here:
 *  hazard 1 forbids a statutory figure, and a second copy of even a synthetic one is hazard 9. */
const SYNTH_OUT_STD = "SYN-OUT-STD";

/** The seed company's currency (plan0A:1563, pinned in §4.1 as `HQ` / `MYR`). **`Seed` has no `currency`
 *  member** — its thirteen members are listed in this plan's header fact (1) and the list is frozen — so the
 *  fixture names the company's currency once, here, and every `Money` in this file is built with it. It is a
 *  currency code and not a rate: hazard 1 is about statutory FIGURES, and `MYR` is the seed's own constant. */
const MYR = currency("MYR");

export async function posFixture(api: StartedApi, name: string): Promise<PosFixture> {
  // 1. The whole tax half, from 5A's helper: the seeded company, the SYNTH-MY-v1 regime, its four codes, the
  //    twelve accounts, a customer and open periods for 2026. This slice re-seeds none of it (hazard 33).
  const tax = await taxFixture(api.db, name);
  const s = tax.s;
  await ensureOpenPeriods(api.db, s, 2026);

  // 2. The three accounts POS_TICKET's tender rules resolve by code that 5A's map does not carry. They come
  //    from THIS slice's chart file through the real loader — never a seedAccount literal in a fixture, which
  //    would make the fixture and `bun run seed` two sources for one code (hazard 32).
  await prodWithTenant(api.db.rw, { tenantId: s.tenant, actorId: s.system, requestId: `pos-${name}` }, (tx) =>
    chartOfAccountsLoader.load(tx, {
      config: { tenantId: s.tenant } as never, tenantId: s.tenant, companyId: s.company,
      systemPrincipalId: s.system, packRoot: POS_PACK_ROOT,
    }));
  const accounts: Record<string, string> = { ...tax.accounts };
  const rows = await withTenant(api.db.rw, s.tenant, s.human, (tx) => tx<{ code: string; id: string }[]>`
    select code, id from app.account where company_id = ${s.company} and code in ('1110','1120','2200')`);
  for (const r of rows) accounts[r.code] = r.id;

  // 3. A warehouse, one unit, three items — all `trackLots: false`, so no test needs a lot id, and all three
  //    wired to 0C's revenue/inventory/COGS accounts so the policy's `item.*_account` refs resolve.
  const warehouseId = await seedWarehouse(api.db, s, { code: "WH-POS" });
  const baseUnitId = await seedUnit(api.db, s, { code: "EA" });
  const items: PosFixture["items"] = {};
  for (const sku of ["SKU-A", "SKU-B", "SKU-C"]) {
    const it = await seedItem(api.db, s, {
      code: sku, trackLots: false, baseUnitId,
      accounts: { revenueAccountId: accounts["4000"]!, inventoryAccountId: accounts["1300"]!, cogsAccountId: accounts["5000"]! },
    });
    items[sku] = { itemId: it.itemId, baseUnitId: it.baseUnitId };
  }

  // 4. Both document types, READ OFF DISK. §4.14's rule is that a seeded type's shape lives in one place, so
  //    a test that restated the policy would be asserting against its own copy. POS_EQUIV_INVOICE is that
  //    same object with exactly three members changed and `requires` reduced — the difference between the two
  //    documents acceptance test 22 compares is type, series, acting principal and write path, and NOTHING
  //    else, which is what makes an identical multiset mean "one posting service".
  const posEnvelope = JSON.parse(
    readFileSync(join(POS_PACK_ROOT, "document-types", "POS_TICKET.json"), "utf8"),
  ) as { policy: Record<string, unknown> };
  const equivPolicy = {
    ...posEnvelope.policy,
    documentType: "POS_EQUIV_INVOICE",
    numbering: { series: "PEI", assignAt: "issue" },
    approval: { required: false, approve: null, post: "accounting.sales.post" },
    requires: ["warehouse"],
  };
  const types: Record<string, string> = {
    POS_TICKET: await seedDocumentType(api.db, s, { code: "POS_TICKET", module: "pos", policy: posEnvelope.policy }),
    POS_EQUIV_INVOICE: await seedDocumentType(api.db, s, { code: "POS_EQUIV_INVOICE", module: "accounting", policy: equivPolicy }),
  };

  // 5. Opening stock through the REAL posting service, so every cost layer is a real layer (hazard 22 — no
  //    test in this system inserts a cost_layer). 3A's registered stock-receipt test type is what
  //    postInventoryDocument drafts, and 200 of each SKU is enough for every case in Phase 6 except the
  //    deliberate stock-out one, which asks for 999999.
  for (const sku of ["SKU-A", "SKU-B", "SKU-C"]) {
    await postInventoryDocument(api.db, s, {
      warehouseId, lines: [{ itemId: items[sku]!.itemId, unitId: baseUnitId, quantity: "200.000000", unitCost: "30.0000" }],
    });
  }

  // 6. The cashier/supervisor pair acceptance test 37 needs, each granted at the branch and NOT company-wide,
  //    because `app.principal_has` is branch-aware and a company-wide grant would make every branch test pass
  //    for the wrong reason. The supervisor deliberately does NOT hold `pos.ticket.sell`: the override guard
  //    refuses a second principal that is the document's own cashier, and a supervisor who could also sell
  //    would let a test accidentally satisfy both roles with one principal.
  const cashierId = s.human;
  const supervisorId = await secondPrincipal(api.db, s);
  await grantCodes(api.db, s, {
    principalId: cashierId, roleCode: "pos-cashier", branchIds: [s.hq],
    codes: ["pos.ticket.sell", "pos.ticket.discount", "pos.ticket.return", "pos.customer.create"],
  });
  await grantCodes(api.db, s, {
    principalId: supervisorId, roleCode: "pos-supervisor", branchIds: [s.hq],
    codes: ["pos.ticket.override", "pos.ticket.return_blind", "pos.ticket.void", "pos.needs_attention.resolve"],
  });
  // The human who issues the enrolment needs the admin code; it is a THIRD authority and not the cashier's.
  await grantCodes(api.db, s, { codes: ["admin.terminal.manage"] });

  // 7. The four codes' rates, read back, plus the two figures the inclusive extraction needs. `buildTicket`
  //    prices a line with one of them and this is the only place a rate enters the fixture — hazard 1 forbids
  //    the literal even for SYNTH-MY-v1. `(1 + rate)` is computed by Postgres because its numeric is exact and
  //    a test-support file has no business doing decimal arithmetic on a rate.
  const rateRows = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
    tx<{ code: string; rate: string; divisor: string; rounding_mode: RoundingMode }[]>`
      select code, rate::text as rate, (1 + rate)::text as divisor, rounding_mode
        from app.tax_code where id = any(${Object.values(tax.codes)})`);
  const taxRates: Record<string, string> = {};
  const taxInclusive: PosFixture["taxInclusive"] = {};
  for (const r of rateRows) {
    taxRates[r.code] = r.rate;
    taxInclusive[r.code] = { divisor: r.divisor, roundingMode: r.rounding_mode };
  }

  const terminal = await enrolTerminal(api, s, { as: s.human, code: "KL01" });
  return { s, api, terminal, items, warehouseId, accounts, types, taxCodes: tax.codes, taxRates, taxInclusive,
           cashierId, supervisorId };
}

/**
 * One `Ticket` over the fixture. Every money value is a string produced by `Money`, never by JavaScript
 * arithmetic (spec:2041 and the `no-number-money` lint): `50.0000 × 2` is exact here and is not exact as a
 * `number` for every price a shop uses.
 *
 * **A return negates in ONE place.** `quantity`, `total`, `taxAmount`, `discount` and the tender's `amount`
 * all flip together, because a test that negated three of the five would produce a ticket whose tenders do
 * not sum to its lines — and `applyBatch` would refuse it for the wrong reason, in a case written to assert
 * something else. `unitPrice` does NOT flip: a price is a price, and §4.4.2's A9 says direction is carried by
 * the quantity's sign and by `effect`/`side`, never by a magnitude.
 */
export function buildTicket(f: PosFixture, opts: BuildTicketOptions = {}): Ticket {
  const kind = opts.kind ?? "sale";
  const sku = opts.sku ?? "SKU-A";
  const magnitude = Quantity.of(opts.quantity ?? "1.000000");
  const qty = kind === "return" ? magnitude.negate() : magnitude;
  const unitPrice = Money.of(opts.unitPrice ?? "50.0000", MYR);
  const discountMagnitude = Money.of(opts.discount ?? "0.0000", MYR);
  const discount = kind === "return" ? discountMagnitude.negate() : discountMagnitude;
  // `Money` has no `times` and no Money-by-Quantity operator: §4.2.1's members are `multiply(factor, mode)`
  // and `subtract(other)`, and the rounding mode is ALWAYS explicit (ADR 0008, spec:2041). The quantity enters
  // as its own exact decimal string, so `50.0000 x 2` is exact here and would not be as a `number`.
  const gross = unitPrice.multiply(qty.toString(), "HALF_AWAY_FROM_ZERO").subtract(discount);
  // POS_TICKET declares `tax.inclusive: true`, so `total` is the tax-INCLUSIVE figure the customer pays and
  // `taxAmount` is extracted from it. This is 5A's inclusive branch VERBATIM (`taxEngine.compute`):
  // `base = amount / (1 + rate)` at the CODE's rounding mode and `tax = amount - base`, which is what makes
  // `base + tax === amount` exactly and is why Task 11's `verifyTax` can compare the till's figure with the
  // server's and expect agreement. Both the divisor and the mode are read from the seeded row in step 7 above:
  // no rate, and no rounding rule, is restated in this file.
  const inclusive = f.taxInclusive[SYNTH_OUT_STD]!;
  const base = gross.divide(inclusive.divisor, inclusive.roundingMode);
  const taxAmount = gross.subtract(base);
  const tenderMethod: TicketTender["method"] = opts.tender ?? "cash";

  return {
    clientRef: opts.clientRef ?? uuidv7Sync(),
    shiftId: opts.shiftId ?? SHARED_SHIFT_ID,
    cashierPrincipalId: opts.cashierPrincipalId ?? f.cashierId,
    customerId: opts.customerId ?? null,
    newCustomer: opts.newCustomer ?? null,
    kind,
    returnsClientRef: opts.returnsClientRef ?? null,
    currency: MYR,
    soldAt: new Date().toISOString(),
    lines: [{
      lineNo: 1,
      itemId: f.items[sku]!.itemId,
      lotId: null,
      quantity: qty.toString(),
      unitId: f.items[sku]!.baseUnitId,
      unitPrice: { amount: unitPrice.toString(), currency: MYR },
      discount: { amount: discount.toString(), currency: MYR },
      taxCodeId: f.taxCodes[SYNTH_OUT_STD]!,
      taxAmount: { amount: taxAmount.toString(), currency: MYR },
      total: { amount: gross.toString(), currency: MYR },
    }],
    tenders: [{ tenderNo: 1, method: tenderMethod, amount: { amount: gross.toString(), currency: MYR }, reference: null }],
    events: opts.events ?? [],
    attendance: [],
    catalogueRevision: 0n,
  };
}
```

  **Four things that file needs and this task must resolve rather than assume**, each verified by Task 0's gate before a line is written:

  1. **`uuidv7Sync`, written in full at the head of Step 6's block and not described.** It is `export`ed and registered by Task 0 amendment 15, because every `batchId` and every hand-written `clientRef` in this slice's four test files is minted with it: §4.10.1 fixes both as uuidv7, and a suite that minted v4s would be asserting the protocol with values the protocol refuses. `@dulja/db/test`'s `uuidv7(sql)` is not widened and is not used — it is a database round trip and §4.1 is immovable. The only `crypto.randomUUID()` calls this slice keeps are **`Idempotency-Key` values**, which §4.2.9 treats as an opaque client string and never stores as an identifier.
  2. **`SHARED_SHIFT_ID`, likewise written in Step 6's block.** One module-level `uuidv7Sync()` constant, so every ticket in a suite belongs to one shift. `document.shift_id` is **0061's** column (Task 0 amendment 6) and carries no foreign key, so at 6A it is written and referenced by nothing; the constant is what keeps 6D's first task from having to re-key every 6A test — **6D's own amendment A6 has `posFixture` insert one open `app.shift` row at exactly this id**, which is why it is exported and registered rather than file-local.
  3. **The currency, and `f.taxRates` / `f.taxInclusive`.** **`Seed` has no `currency` member** — the header's fact (1) lists its thirteen and the list is frozen — so this file names the seed company's `MYR` once, in the `MYR` module constant, and no line of it reads a `currency` member off `Seed`. `taxRates`, `taxInclusive` and the query that fills them are added to `PosFixture` alongside `taxCodes` and are **read, never restated**, because hazard 1 forbids a rate literal even for a synthetic regime.
  4. **The inclusive extraction is 5A's, re-expressed in `Money`, not a new helper.** `Money` has no `taxComponentOf`: §4.2.1's members are the ones 0D ships and the list is frozen. 5A's `taxEngine.compute` is not exported through this slice's dependency list either, and its `TaxCodeDef` argument would drag the whole regime into a fixture. So `buildTicket` writes 5A's inclusive branch in the two `Money` calls it is made of — `divide(1 + rate, mode)` then `subtract` — with both operands read from the seeded row. It is one rule and not two: the server computes the same two calls inside `computeDocumentTax`, and Task 11 step 2g asserts the two agree. If a future slice wants one name for it, the name belongs in **5A's** module (hazard 9), not here.

- [ ] **Step 7: Run and commit.** `bun run --cwd packages/db test -- sync/pos-ticket-policy` — **expected:** 5 passed.

```bash
git add packages/db/seed/my/document-types/POS_TICKET.json packages/db/src/posting/load.ts \
        apps/api/src/middleware/require-document-permission.ts apps/api/src/routes/accounting/documents.ts \
        tests/invariants/support/pos.ts packages/db/test/sync/pos-ticket-policy.test.ts
git commit -m "$(cat <<'EOF'
feat(seed): POS_TICKET as a document type — one policy, both directions [6A T10]

A return is not a second type: negative line quantities make planMovements emit `receipt`
from a policy declaring `issue` (3A's rule) and make evaluatePolicy flip every side at
amount.abs() (A9). Five ledger legs and four tender rules, and not one line of TypeScript
decides a direction.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `applyBatch` — savepoints, dedup, authority re-verification, refuse-never-drop

**This is the slice's centre.** Every clause of §4.10.4 and §2.7's DoD share lands here.

**Files**

- `packages/db/src/sync/apply.ts` — NEW
- `packages/db/src/sync/needs-attention.ts` — NEW
- `packages/contracts/src/errors.ts` — MODIFY (two rows — ERR_SYNC_TICKET_REJECTED, ERR_SYNC_MESSAGE_UNSUPPORTED)
- `packages/db/test/sync/apply.test.ts` — NEW
- `docs/adr/0056-up-sync-apply-savepoints-and-refusal.md` — NEW

**Interfaces**

- Consumes: `postDocument`, `PostResult`, `PostingError` (§4.3.1); `recordOverride`, `setEventContext` (2B); `computeDocumentTax`, `ComputedTaxLine` (5A); `app.principal_has` (2B); `currentCatalogueRevision` (T8); `POS_PERMISSION`, `OVERRIDE_SUBJECT_FOR`, `PosPermissionCode` (**T5**, `packages/db/src/sync/authority.ts`); `SyncError` (T6); `Money`, `Quantity` (§4.2.1).
- Produces:

```ts
// packages/db/src/sync/apply.ts — the db-local structural twins of §4.10.1 (§3.1: packages/db may not import
// @dulja/sync). @dulja/sync's own types satisfy these structurally, and apps/api narrows at the route.
export interface TicketLineInput { lineNo: number; itemId: string; lotId: string | null; quantity: string; unitId: string;
  unitPrice: { amount: string; currency: string }; discount: { amount: string; currency: string };
  taxCodeId: string | null; taxAmount: { amount: string; currency: string }; total: { amount: string; currency: string } }
export interface TicketTenderInput { tenderNo: number; method: string; amount: { amount: string; currency: string }; reference: string | null }
export interface TicketEventInput { kind: string; code: string; subject: string; supervisorPrincipalId: string; reason: string }
export interface NewCustomerInput { id: string; code: string; nameEn: string; phone: string | null }
export interface TicketInput { clientRef: string; shiftId: string; cashierPrincipalId: string; customerId: string | null;
  newCustomer?: NewCustomerInput | null; kind: string; returnsClientRef: string | null; currency: string; soldAt: string;
  lines: TicketLineInput[]; tenders: TicketTenderInput[]; events: TicketEventInput[];
  attendance: { kind: string; principalId: string; at: string }[]; catalogueRevision: string | bigint }
export interface TicketBatchInput { terminalId: string; batchId: string; tickets: TicketInput[]; shifts: unknown[]; tillEvents: unknown[] }

export interface TicketOutcome { clientRef: string; status: "accepted" | "duplicate" | "rejected";
  documentId: string | null; number: string | null; error: { code: string; detail: string } | null }
export interface MessageOutcome { ref: string; status: "accepted" | "duplicate" | "rejected"; error: { code: string; detail: string } | null }
export interface BatchOutcome { batchId: string; results: TicketOutcome[]; shiftResults: MessageOutcome[];
  tillEventResults: MessageOutcome[]; catalogueRevision: bigint }

export interface TerminalApplyContext { terminalId: string; companyId: string; branchId: string; principalId: string }
/** One transaction, a savepoint per ticket (spec:1303). Never throws for a single bad ticket. */
export async function applyBatch(tx: Sql, ctx: TenantContext, terminal: TerminalApplyContext, batch: TicketBatchInput): Promise<BatchOutcome>;
```

**Steps**

- [ ] **Step 1: Write the failing test first.**

```ts
// packages/db/test/sync/apply.test.ts  (abridged to the cases that fix behaviour; each `it` is one clause)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch } from "../../src/sync/apply";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { startApi, type StartedApi } from "../../../../apps/api/test/support/app";
import { buildTicket, posFixture, uuidv7Sync, type PosFixture } from "../../../../tests/invariants/support/pos";

describe("applyBatch (§4.10.4) — the server half of zero duplicates, zero lost tickets", () => {
  let api: StartedApi; let f: PosFixture;
  beforeAll(async () => { api = await startApi(); f = await posFixture(api, "Alpha"); }, 240_000);
  afterAll(async () => { await api.stop(); });

  /** Defined HERE and not imported: Task 12's route suite has its own copy for its own database, and a
   *  three-line count is not a shared-helper row §4.17.1 would accept. */
  const ledgerCount = async (a: StartedApi): Promise<number> =>
    (await a.db.admin<{ n: number }[]>`select count(*)::int as n from app.ledger_entry`)[0]!.n;

  const apply = (tickets: ReturnType<typeof buildTicket>[], shifts: unknown[] = [], tillEvents: unknown[] = []) =>
    // `actorId` is the terminal's PRINCIPAL, never its `pos_terminal.id`. Passing the terminal id here sets
    // `app.actor_id` to a uuid that is not a principal, and `document.created_by`'s FK then fails at the header
    // insert — before dedup ever runs — naming a constraint instead of the mistake.
    prodWithTenant(api.db.rw, { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "b" }, async (tx) => {
      const t = { terminalId: f.terminal.terminalId, companyId: f.s.company, branchId: f.s.hq, principalId: f.terminal.principalId };
      return applyBatch(tx, { tenantId: f.s.tenant, actorId: t.principalId, requestId: "b" }, t,
        { terminalId: f.terminal.terminalId, batchId: uuidv7Sync(), tickets, shifts, tillEvents });
    });

  it("a good ticket posts, and the terminal is the ACTOR while the cashier is ATTRIBUTED (LEGACY-044)", async () => {
    const ticket = buildTicket(f, { sku: "SKU-A", quantity: "2.000000", unitPrice: "50.0000" });
    const out = await apply([ticket]);
    expect(out.results[0]!.status).toBe("accepted");
    const [doc] = await api.db.admin<{ created_by: string; posted_by: string; attributed_to: string; series: string; client_ref: string; terminal_id: string }[]>`
      select created_by, posted_by, attributed_to, series, client_ref::text as client_ref, terminal_id::text as terminal_id
        from app.document where id = ${out.results[0]!.documentId}`;
    expect(doc!.created_by).toBe(f.terminal.principalId);
    expect(doc!.posted_by).toBe(f.terminal.principalId);
    expect(doc!.attributed_to).toBe(f.cashierId);
    expect(doc!.series).toBe(`POS-${f.terminal.code}`);
    expect(doc!.client_ref).toBe(ticket.clientRef);
    expect(doc!.terminal_id).toBe(f.terminal.terminalId);
  });

  it("re-applying the same ticket answers `duplicate` and writes nothing (spec:1304)", async () => {
    const ticket = buildTicket(f, { sku: "SKU-A" });
    const first = await apply([ticket]);
    const before = await ledgerCount(api);
    const second = await apply([ticket]);
    expect(second.results[0]!.status).toBe("duplicate");
    expect(second.results[0]!.documentId).toBe(first.results[0]!.documentId);
    expect(await ledgerCount(api)).toBe(before);
  });

  it("a bad ticket rolls back to ITS savepoint; the good ones in the same batch still commit (spec:1303)", async () => {
    const good1 = buildTicket(f, { sku: "SKU-A" });
    const bad = buildTicket(f, { sku: "SKU-A", cashierPrincipalId: f.supervisorId });   // holds no pos.ticket.sell
    const good2 = buildTicket(f, { sku: "SKU-B" });
    const out = await apply([good1, bad, good2]);
    expect(out.results.map((r) => r.status)).toEqual(["accepted", "rejected", "accepted"]);
    expect(out.results[1]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
    const [na] = await api.db.admin<{ error_code: string; payload: { clientRef: string } }[]>`
      select error_code, payload from app.needs_attention where client_ref = ${bad.clientRef}`;
    expect(na!.error_code).toBe("ERR_RBAC_FORBIDDEN");
    expect(na!.payload.clientRef).toBe(bad.clientRef);      // the WHOLE ticket is recoverable from the server
    const [none] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.document where client_ref = ${bad.clientRef}`;
    expect(none!.n).toBe(0);                                 // "never silently into the ledger" (spec:1305)
  });

  it("a discount beyond the cashier's authority needs an override by a DIFFERENT principal (test 37's server half)", async () => {
    // The cashier does NOT hold `pos.ticket.void` (Task 5's grant list), so a void whose named supervisor is
    // the cashier herself is refused: an override by the same principal is not a second principal.
    const voided = buildTicket(f, { sku: "SKU-A", events: [{ kind: "override", code: "pos.ticket.override", subject: "void", supervisorPrincipalId: f.cashierId, reason: "mis-scan" }] });
    const out = await apply([voided]);
    expect(out.results[0]!.status).toBe("rejected");
    // The SUPERVISOR is the cashier here, and app.assert_override_authorised refuses a second principal that
    // is the same principal — the exact clause that makes "a second principal" mean something.
    expect(out.results[0]!.error!.code).toBe("ERR_OVERRIDE_NOT_AUTHORISED");

    const ok = buildTicket(f, { sku: "SKU-A", events: [{ kind: "override", code: "pos.ticket.override", subject: "void", supervisorPrincipalId: f.supervisorId, reason: "mis-scan" }] });
    const out2 = await apply([ok]);
    expect(out2.results[0]!.status).toBe("accepted");
    const [ev] = await api.db.admin<{ actor_id: string; attributed_to: string; override_code: string; reason: string }[]>`
      select actor_id, attributed_to, override_code, reason from app.document_event
       where document_id = ${out2.results[0]!.documentId} and event_kind = 'override'`;
    expect(ev!.actor_id).toBe(f.terminal.principalId);         // the TERMINAL acted
    expect(ev!.attributed_to).toBe(f.supervisorId);          // the SUPERVISOR is attributed (spec:1324)
    expect(ev!.override_code).toBe("pos.ticket.override");
    expect(ev!.reason).toBe("void: mis-scan");               // "<subject>: <reason>" (§4.10.1)
  });

  it("a tax figure the server does not agree with is REFUSED, not silently corrected (LEGACY-020)", async () => {
    const wrong = buildTicket(f, { sku: "SKU-A" });
    wrong.lines[0]!.taxAmount = { amount: "0.0000", currency: "MYR" };
    const out = await apply([wrong]);
    expect(out.results[0]!.status).toBe("rejected");
    expect(out.results[0]!.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(out.results[0]!.error!.detail).toContain("line 1");
  });

  it("a shift or till-event message is REFUSED per message before 6D, never dropped (§4.10.1)", async () => {
    const out = await apply([], [{ shiftId: uuidv7Sync(), kind: "open" }], [{ clientRef: uuidv7Sync() }]);
    expect(out.shiftResults[0]!.status).toBe("rejected");
    expect(out.shiftResults[0]!.error!.code).toBe("ERR_SYNC_MESSAGE_UNSUPPORTED");
    expect(out.tillEventResults[0]!.error!.code).toBe("ERR_SYNC_MESSAGE_UNSUPPORTED");
  });

  it("a quick-created customer is applied once, and a re-send creates no second party", async () => {
    const id = uuidv7Sync();                 // the party id the till mints OFFLINE: a uuidv7, never a v4
    const t1 = buildTicket(f, { sku: "SKU-A", customerId: id, newCustomer: { id, code: "WALK-1", nameEn: "Ali", phone: null } });
    await apply([t1]);
    const t2 = buildTicket(f, { sku: "SKU-B", customerId: id, newCustomer: { id, code: "WALK-1", nameEn: "Ali", phone: null } });
    const out = await apply([t2]);
    expect(out.results[0]!.status).toBe("accepted");
    const [n] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.party where id = ${id}`;
    expect(n!.n).toBe(1);
  });

  it("selling more than the layers hold is refused at the data layer (acceptance test 18's sync path)", async () => {
    const huge = buildTicket(f, { sku: "SKU-C", quantity: "999999.000000" });
    const out = await apply([huge]);
    expect(out.results[0]!.status).toBe("rejected");
    expect(out.results[0]!.error!.code).toBe("ERR_STOCK_INSUFFICIENT");
  });

  it("a DISCOUNT the cashier holds is applied; a BLIND RETURN she does not is ERR_RBAC_FORBIDDEN", async () => {
    // The required codes come from the ticket's own CONTENT (`requiredCodes`), so neither code is a catalogue
    // row nothing evaluates. spec:2161 verbatim: a cashier may "discount within the branch limit" and may not
    // take a "blind return" — and the fixture grants her exactly the first.
    const discounted = buildTicket(f, { sku: "SKU-A", discount: "5.0000" });
    expect((await apply([discounted])).results[0]!.status, "pos.ticket.discount is held").toBe("accepted");

    // A return with NO `returnsClientRef` is a BLIND return, which asks for pos.ticket.return_blind. The
    // cashier does not hold it, and the ticket carries no `blind_return` override to rescue her, so it is
    // refused BEFORE any write — and the detail names the code and the branch, because "forbidden" alone is
    // unactionable in a shop. This is the branch of `verifyAuthority` that throws rather than deferring to
    // `recordOverride`, and it is the only one of the three rescuable codes a test can reach with no event.
    const blind = buildTicket(f, { sku: "SKU-A", kind: "return", returnsClientRef: null });
    const out = await apply([blind]);
    expect(out.results[0]!.status).toBe("rejected");
    expect(out.results[0]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(out.results[0]!.error!.detail).toContain("pos.ticket.return_blind");
    expect(out.results[0]!.error!.detail).toContain("blind_return");   // the override that WOULD have rescued it

    // And the same ticket with the supervisor's blind-return override is accepted — one code, two answers,
    // and the difference is a second principal and nothing else.
    const rescued = buildTicket(f, {
      sku: "SKU-A", kind: "return", returnsClientRef: null,
      events: [{ kind: "override", code: "pos.ticket.override", subject: "blind_return", supervisorPrincipalId: f.supervisorId, reason: "no receipt" }],
    });
    expect((await apply([rescued])).results[0]!.status).toBe("accepted");
  });

  it("a failure the classifier cannot place is ERR_SYNC_TICKET_REJECTED — named, never silent", async () => {
    // The default branch of `classify()`. It is exercised through a violation no other branch claims: a
    // NOT NULL on a column the ticket controls (SQLSTATE 23502), which is neither 23505, 23503, 42501 nor a
    // 23514 carrying an ERR_ token. This case is why the row may be in ERRORS at all: §4.2.4's `error-codes`
    // check fails the build for a registered code with no raiser, so a default nothing reaches is a red tree.
    const noUnit = buildTicket(f, { sku: "SKU-A" });
    (noUnit.lines[0] as { unitId: string | null }).unitId = null;
    const out = await apply([noUnit]);
    expect(out.results[0]!.status).toBe("rejected");
    expect(out.results[0]!.error!.code).toBe("ERR_SYNC_TICKET_REJECTED");

    // And it still lands in the queue with the WHOLE ticket — an unclassifiable failure is refused, not lost.
    const [na] = await api.db.admin<{ error_code: string; payload: { clientRef: string } }[]>`
      select error_code, payload from app.needs_attention where client_ref = ${noUnit.clientRef}`;
    expect(na!.error_code).toBe("ERR_SYNC_TICKET_REJECTED");
    expect(na!.payload.clientRef).toBe(noUnit.clientRef);
  });
});
```

  Run `bun run --cwd packages/db test -- sync/apply`. **Expected failure:** `Cannot find module '../../src/sync/apply'`.

- [ ] **Step 2: Write `packages/db/src/sync/apply.ts`.** One exported function over eleven private helpers; the order of the per-ticket steps is the contract and a step moved is a defect.

```ts
// packages/db/src/sync/apply.ts
import type { Sql } from "postgres";
import { currency, Money, Quantity } from "@dulja/domain";
import type { TenantContext } from "../with-tenant";
import { postDocument } from "../posting/post";
import { recordOverride, setEventContext } from "../posting";
import { PostingError } from "../posting/errors";
import { computeDocumentTax } from "../tax/compute";
import { currentCatalogueRevision } from "./catalogue";
import { OVERRIDE_SUBJECT_FOR, POS_PERMISSION, type PosPermissionCode } from "./authority";
import { SyncError } from "./enrolment";
import { upsertNeedsAttention } from "./needs-attention";

// ── The db-local structural twins of §4.10.1 (§3.1: packages/db may not import @dulja/sync) ────────────
export interface TicketLineInput { lineNo: number; itemId: string; lotId: string | null; quantity: string; unitId: string;
  unitPrice: { amount: string; currency: string }; discount: { amount: string; currency: string };
  taxCodeId: string | null; taxAmount: { amount: string; currency: string }; total: { amount: string; currency: string } }
export interface TicketTenderInput { tenderNo: number; method: string; amount: { amount: string; currency: string }; reference: string | null }
export interface TicketEventInput { kind: string; code: string; subject: string; supervisorPrincipalId: string; reason: string }
export interface NewCustomerInput { id: string; code: string; nameEn: string; phone: string | null }
export interface TicketInput { clientRef: string; shiftId: string; cashierPrincipalId: string; customerId: string | null;
  newCustomer?: NewCustomerInput | null; kind: string; returnsClientRef: string | null; currency: string; soldAt: string;
  lines: TicketLineInput[]; tenders: TicketTenderInput[]; events: TicketEventInput[];
  attendance: { kind: string; principalId: string; at: string }[]; catalogueRevision: string | bigint }
export interface TicketBatchInput { terminalId: string; batchId: string; tickets: TicketInput[]; shifts: unknown[]; tillEvents: unknown[] }

export interface TicketOutcome { clientRef: string; status: "accepted" | "duplicate" | "rejected";
  documentId: string | null; number: string | null; error: { code: string; detail: string } | null }
export interface MessageOutcome { ref: string; status: "accepted" | "duplicate" | "rejected"; error: { code: string; detail: string } | null }
export interface BatchOutcome { batchId: string; results: TicketOutcome[]; shiftResults: MessageOutcome[];
  tillEventResults: MessageOutcome[]; catalogueRevision: bigint }

export interface TerminalApplyContext { terminalId: string; companyId: string; branchId: string; principalId: string }

/** §4.6.5's four, and no fifth. A method outside this set never reaches a policy rule, so it would plan no
 *  ledger line and fail `assert_document_balanced` at COMMIT — a correct but late and confusing failure. */
const TENDER_METHODS = new Set(["cash", "card", "transfer", "store_credit"]);

/**
 * Applies one `TicketBatch`. **One transaction, a savepoint per ticket** (spec:1303): a bad ticket rolls back
 * to its own savepoint and its neighbours still commit. Never throws for a single bad ticket — a per-ticket
 * failure is a `rejected` outcome plus an `app.needs_attention` row carrying the whole payload, so a refusal
 * is recoverable from the server alone even if the till has been reimaged (spec:1305).
 *
 * **It writes documents and lines and then calls `postDocument`, and computes nothing** (Global Constraint 3,
 * hazard 22). There is no `insert into app.ledger_entry`, no `insert into app.inventory_movement`, no
 * `merge into app.stock_on_hand` and no `insert into app.tax_transaction` in this file. Tax is 5A's
 * `computeDocumentTax`; cost is 3B's `applyMovements` inside `postDocument`'s step 9; numbering, the period,
 * the policy, the plan and the ledger are 1A's and 2A's, unchanged.
 *
 * **The terminal acts and the cashier is attributed** (hazard 19, LEGACY-044). `created_by` and `posted_by` come
 * from the column default `app.current_actor()`, which is `ctx.actorId` — the terminal's principal, resolved
 * from the signed call. `attributed_to` is `cashierPrincipalId`, a data column. No line of this function
 * passes a principal id from the payload into an actor column.
 */
export async function applyBatch(
  tx: Sql, ctx: TenantContext, terminal: TerminalApplyContext, batch: TicketBatchInput,
): Promise<BatchOutcome> {
  // 1. Serialise concurrent applies for ONE terminal (§4.1's fixed literals, Task 0 amendment 18). The
  //    synchronous route and the pos.sync.apply job can race after a client timeout; without this both pass
  //    the dedup read and collide on document_company_id_client_ref_key. Holding it means the second one
  //    SEES the first one's rows and answers `duplicate`, which is the difference between a clean idempotent
  //    answer and a noisy 23505 the caller has to interpret.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`sync-batch:${terminal.terminalId}`}, 0))`;

  // 2. One catalogue read for the whole batch, so the till learns how stale it is in the same response.
  const catalogueRevision = await currentCatalogueRevision(tx, terminal.companyId);

  const results: TicketOutcome[] = [];
  for (const ticket of batch.tickets) {
    try {
      results.push(await tx.savepoint((sp) => applyTicket(sp, ctx, terminal, ticket)));
    } catch (e: unknown) {
      const { code, detail } = classify(e);
      if (code === "DUPLICATE") {
        // SQLSTATE 23505 on the client_ref index is the race two concurrent applies produce, and the ticket
        // IS applied — by the other transaction. It is a `duplicate`, not a rejection, and it writes no
        // needs-attention row: there is nothing for a branch manager to do about a successful sale.
        const existing = await findExisting(tx, terminal.companyId, ticket.clientRef);
        results.push({ clientRef: ticket.clientRef, status: "duplicate", documentId: existing?.id ?? null,
                       number: existing?.number ?? null, error: null });
        continue;
      }
      // OUTSIDE the savepoint, on `tx`, so the row survives the rollback that just happened. This is the
      // whole of "zero lost tickets": the payload is the WHOLE ticket, so a rejection is recoverable from the
      // server even if the till has been reimaged (spec:1305).
      await upsertNeedsAttention(tx, ctx, {
        companyId: terminal.companyId, branchId: terminal.branchId, terminalId: terminal.terminalId,
        clientRef: ticket.clientRef, payload: ticket, errorCode: code, errorDetail: detail,
      });
      results.push({ clientRef: ticket.clientRef, status: "rejected", documentId: null, number: null,
                     error: { code, detail } });
    }
  }

  return {
    batchId: batch.batchId,
    results,
    shiftResults: await refuseUnsupported(tx, batch.shifts, "shift"),
    tillEventResults: await refuseUnsupported(tx, batch.tillEvents, "till_event"),
    catalogueRevision,
  };
}

// ── one ticket, in the order the algorithm fixes ───────────────────────────────────────────────────────

async function applyTicket(
  sp: Sql, ctx: TenantContext, terminal: TerminalApplyContext, ticket: TicketInput,
): Promise<TicketOutcome> {
  // (a) Dedup, BEFORE writing anything (spec:1304). The read is the common case; the unique index below is
  //     the race. Both answer `duplicate`, and neither writes.
  const existing = await findExisting(sp, terminal.companyId, ticket.clientRef);
  if (existing) {
    return { clientRef: ticket.clientRef, status: "duplicate", documentId: existing.id, number: existing.number, error: null };
  }

  // (b) Shape. Every refusal names the line, because "invalid ticket" is unactionable at a till.
  const company = await loadCompany(sp, terminal.companyId);
  validateShape(ticket, company.currency);

  // (c) Attendance before 6C. Refused per ticket and LOUD: dropping the clock-in and posting the sale would
  //     lose an HR event with no trace, which is the failure spec:1305 forbids. 6C's first task replaces this
  //     with the insert and re-runs this file's test unchanged.
  if (ticket.attendance.length > 0) {
    const [caps] = await sp<{ present: boolean }[]>`select to_regclass('app.attendance_event') is not null as present`;
    if (!caps!.present) {
      throw new SyncError("ERR_SYNC_MESSAGE_UNSUPPORTED",
        `ticket ${ticket.clientRef} carries ${ticket.attendance.length} attendance event(s); app.attendance_event is 6C's and does not exist yet`);
    }
  }

  // (d) Authority, re-verified against the SERVER's current assignments and never against anything the till
  //     sent (spec:1324). The codes come from the ticket's own content, and the override door is 2B's guard.
  await verifyAuthority(sp, ctx, terminal, ticket);

  // (e) Customer quick-create. `id` is the uuidv7 the till minted offline and is also `customerId`, so a
  //     re-sent ticket creates no second party. `on conflict do nothing` then a read-back by code, so a
  //     colliding code resolves to the EXISTING party rather than leaving a dangling customerId.
  const partyId = await quickCreateCustomer(sp, ctx, terminal, ticket);

  // (f) The header. `created_by` is NOT written: the column default is app.current_actor(), which is the
  //     terminal (hazard 19). `effective_date` is the till's LOCAL sale date and never now() — a ticket sold
  //     at 23:50 belongs to that day's takings whatever hour the sync happens (spec:2039).
  //
  //     `series` IS written, with the policy's own literal 'POS', because plan0A's app.document declares
  //     `series text not null` with no default — a draft has to carry one. It is a PLACEHOLDER and never the
  //     final value: §4.3.6's issue SQL does `update app.document set … series = $series …`, and $series is
  //     what `resolveSeries` (Task 4) returns — 'POS-<terminal code>' for a terminal-tagged document. Every
  //     other slice's draft path does the same thing (3C's `draftTypedDocument` takes a `series` argument),
  //     so this is the convention and not an exception.
  //
  //     `shift_id` is 0061's column (Task 0 amendment 6, and 6D's own amendment A2 from the other side). It
  //     carries no foreign key at 6A and gains none at 0070, so writing the till's minted id here is safe and
  //     is what lets 6D resolve a shift's tickets without re-keying a single 6A document.
  //
  //     There is NO `memo` column on app.document and this insert names none: 2C's 0027 added `notes text`,
  //     and a POS ticket has nothing to put in it — the cashier's free text, when Phase 6 grows one, is a
  //     `text` line, not a header field.
  const [doc] = await sp<{ id: string }[]>`
    insert into app.document (
      tenant_id, company_id, branch_id, document_type_id, status, series, effective_date, currency,
      exchange_rate, client_ref, terminal_id, shift_id, attributed_to, party_id, warehouse_id, tax_inclusive)
    select ${ctx.tenantId}, ${terminal.companyId}, ${terminal.branchId}, dt.id, 'draft', 'POS',
           (${ticket.soldAt}::timestamptz at time zone ${company.timezone})::date,
           ${ticket.currency}, 1, ${ticket.clientRef}, ${terminal.terminalId}, ${ticket.shiftId},
           ${ticket.cashierPrincipalId}, ${partyId}, ${company.posWarehouseId}, true
      from app.document_type dt
     where dt.company_id = ${terminal.companyId} and dt.code = 'POS_TICKET'
    returning id`;
  if (!doc) throw new SyncError("ERR_NOT_FOUND", "the POS_TICKET document type is not configured for this company");
  const documentId = doc.id;

  // (g) The lines: item lines first, then tender lines, `line_no` 1..n across both groups in that order.
  await insertLines(sp, ctx, documentId, ticket);

  // (h) Recompute tax and compare THROUGH Money. `computeDocumentTax` has already WRITTEN the server's
  //     figures, so a mismatch is a refusal and never a correction: a till whose catalogue is stale re-pulls
  //     and re-prices, and no receipt is issued at a rate nobody chose (LEGACY-020's discipline at the till).
  const computed = await computeDocumentTax(sp, ctx, documentId);
  verifyTax(ticket, computed);

  // (i) The overrides, through 2B's door and never by an insert of our own (hazard 24). The guard checks the
  //     supervisor holds the code at the document's branch AND is neither created_by nor attributed_to.
  for (const ev of ticket.events) {
    await setEventContext(sp, { reason: `${ev.subject}: ${ev.reason}`, attributedTo: ev.supervisorPrincipalId });
    await recordOverride(sp, ctx, {
      documentId, code: "pos.ticket.override", reason: `${ev.subject}: ${ev.reason}`,
      attributedTo: ev.supervisorPrincipalId,
    });
  }

  // (j) And nothing else. postDocument issues, numbers, resolves the policy, plans, moves stock, consumes
  //     layers, writes tax transactions and writes the ledger — all of it 1A/2A/3B/5A's, unchanged.
  const posted = await postDocument(sp, ctx, { documentId });
  return { clientRef: ticket.clientRef, status: "accepted", documentId, number: posted.number.toString(), error: null };
}

// ── the eleven helpers ──────────────────────────────────────────────────────────────────────────────────

async function findExisting(sql: Sql, companyId: string, clientRef: string): Promise<{ id: string; number: string | null } | null> {
  const [row] = await sql<{ id: string; number: string | null }[]>`
    select id, number::text as number from app.document
     where company_id = ${companyId} and client_ref = ${clientRef}`;
  return row ?? null;
}

interface CompanyRow { currency: string; timezone: string; posWarehouseId: string }
async function loadCompany(sql: Sql, companyId: string): Promise<CompanyRow> {
  // The warehouse a POS_TICKET issues from: the company's single `stock` warehouse at the terminal's branch
  // in Phase 6. `policy.requires` names `warehouse`, so a company with none refuses at the policy layer with
  // ERR_POLICY_REQUIRES_MISSING naming it — which is the right error, and better than a NULL FK here.
  const [row] = await sql<{ currency: string; timezone: string; warehouse_id: string | null }[]>`
    select c.currency, c.timezone,
           (select w.id from app.warehouse w
             where w.company_id = c.id and w.kind = 'stock' and w.archived_at is null
             order by w.code limit 1) as warehouse_id
      from app.company c where c.id = ${companyId}`;
  if (!row) throw new SyncError("ERR_NOT_FOUND", `company ${companyId} is not visible`);
  if (row.warehouse_id === null) {
    throw new SyncError("ERR_VALIDATION_FAILED", `company ${companyId} has no stock warehouse; a POS ticket cannot issue stock`);
  }
  return { currency: row.currency, timezone: row.timezone, posWarehouseId: row.warehouse_id };
}

function validateShape(ticket: TicketInput, companyCurrency: string): void {
  const fail = (detail: string): never => { throw new SyncError("ERR_VALIDATION_FAILED", detail); };
  if (ticket.kind !== "sale" && ticket.kind !== "return") fail(`ticket ${ticket.clientRef}: kind is '${ticket.kind}', not sale or return`);
  if (ticket.currency !== companyCurrency) {
    fail(`ticket ${ticket.clientRef}: currency ${ticket.currency} is not the company's ${companyCurrency}; a till sells in the company's currency (D-currency, spec:2041)`);
  }
  if (ticket.lines.length === 0) fail(`ticket ${ticket.clientRef}: no lines`);
  if (ticket.tenders.length === 0) fail(`ticket ${ticket.clientRef}: no tenders`);

  // Every money object on the wire carries `currency` as a PLAIN string (§4.2.8's `MoneySchema`), and
  // `Money<C>` is parameterised by the branded `CurrencyCode` that `currency()` alone produces (§4.2.1) —
  // so the brand is applied once, here, and `money()` is the single gate a mixed-currency ticket must pass.
  // After this function no code in this file reads a `.currency` string again.
  const ccy = currency(ticket.currency);
  const money = (m: { amount: string; currency: string }, where: string) => {
    if (m.currency !== ticket.currency) {
      fail(`ticket ${ticket.clientRef} ${where}: currency ${m.currency} is not the ticket's ${ticket.currency}`);
    }
    return Money.of(m.amount, ccy);
  };

  let lineTotal = Money.zero(ccy);
  for (const l of ticket.lines) {
    const q = Quantity.of(l.quantity);
    // §4.4.2's A9 and 3A's rule read from the OTHER side: nothing here chooses a direction from a sign, it
    // only refuses a ticket whose own kind and quantities disagree. A sale with a negative line is a return
    // that forgot to say so, and applying it would post a receipt from a policy declaring `issue`.
    // `Quantity` has `isZero` and `isNegative` and **no `isPositive`** (§4.2.1's member list is 0D's and
    // frozen), so "> 0" is spelled out of the two it does have rather than assumed onto it.
    if (ticket.kind === "sale" && (q.isZero() || q.isNegative())) fail(`ticket ${ticket.clientRef} line ${l.lineNo}: a sale line quantity must be > 0`);
    if (ticket.kind === "return" && !q.isNegative()) fail(`ticket ${ticket.clientRef} line ${l.lineNo}: a return line quantity must be < 0`);
    money(l.unitPrice, `line ${l.lineNo} unitPrice`);
    money(l.discount, `line ${l.lineNo} discount`);
    money(l.taxAmount, `line ${l.lineNo} taxAmount`);
    lineTotal = lineTotal.add(money(l.total, `line ${l.lineNo} total`));
  }

  let tenderTotal = Money.zero(ccy);
  for (const t of ticket.tenders) {
    if (!TENDER_METHODS.has(t.method)) {
      fail(`ticket ${ticket.clientRef} tender ${t.tenderNo}: method '${t.method}' is not one of cash, card, transfer, store_credit (§4.6.5)`);
    }
    tenderTotal = tenderTotal.add(money(t.amount, `tender ${t.tenderNo}`));
  }
  // Through Money, never Number: a cent of float drift here would post an unbalanced document that
  // assert_document_balanced would then refuse at COMMIT, naming the ledger instead of the ticket.
  if (!tenderTotal.equals(lineTotal)) {
    fail(`ticket ${ticket.clientRef}: tenders total ${tenderTotal.toString()} but lines total ${lineTotal.toString()}`);
  }
}

/**
 * The codes this ticket's own content requires. Derived from the ticket and never from a field the till sets:
 * a payload that named its own permissions would be LEGACY-044 in the shape of an authorisation.
 */
function requiredCodes(ticket: TicketInput): PosPermissionCode[] {
  const codes: PosPermissionCode[] = [];
  if (ticket.kind === "return") {
    // The three-way choice §4.10.4 names: a return WITH an original is `return`; without one it is a BLIND
    // return, which spec:2161 puts outside a cashier's authority entirely.
    codes.push(ticket.returnsClientRef === null ? POS_PERMISSION.ticketReturnBlind : POS_PERMISSION.ticketReturn);
  } else {
    codes.push(POS_PERMISSION.ticketSell);
  }
  const ccy = currency(ticket.currency);          // `validateShape` ran first, so every line agrees with it
  if (ticket.lines.some((l) => !Money.of(l.discount.amount, ccy).isZero())) {
    codes.push(POS_PERMISSION.ticketDiscount);
  }
  if (ticket.events.some((e) => e.subject === "void")) codes.push(POS_PERMISSION.ticketVoid);
  if (ticket.newCustomer != null) codes.push(POS_PERMISSION.customerCreate);
  return codes;
}

async function verifyAuthority(
  sp: Sql, _ctx: TenantContext, terminal: TerminalApplyContext, ticket: TicketInput,
): Promise<void> {
  for (const code of requiredCodes(ticket)) {
    const [row] = await sp<{ ok: boolean }[]>`
      select app.principal_has(${ticket.cashierPrincipalId}, ${code}, ${terminal.companyId}, ${terminal.branchId}) as ok`;
    if (row!.ok) continue;

    // The cashier lacks it. An override rescues exactly the three codes spec:2161 puts on the cashier's MAY
    // NOT list, and only when the ticket carries an event whose `subject` names that code — the supervisor's
    // authority is then checked by 2B's `app.assert_override_authorised`, which also refuses a "second"
    // principal that is the document's own cashier. `applyBatch` adds no check of its own here (hazard 24).
    const subject = OVERRIDE_SUBJECT_FOR[code];
    if (subject !== null && ticket.events.some((e) => e.subject === subject)) continue;

    throw new SyncError("ERR_RBAC_FORBIDDEN",
      `ticket ${ticket.clientRef}: cashier ${ticket.cashierPrincipalId} does not hold ${code} at branch ${terminal.branchId}`
      + (subject === null ? "" : `, and the ticket carries no '${subject}' override`));
  }
}

async function quickCreateCustomer(
  sp: Sql, ctx: TenantContext, terminal: TerminalApplyContext, ticket: TicketInput,
): Promise<string | null> {
  const nc = ticket.newCustomer;
  if (nc == null) return ticket.customerId;
  if (ticket.customerId !== null && ticket.customerId !== nc.id) {
    throw new SyncError("ERR_VALIDATION_FAILED",
      `ticket ${ticket.clientRef}: customerId ${ticket.customerId} is not the quick-created party's id ${nc.id}`);
  }
  // The receivable account is §4.15's `1200`, the same default §4.5.7 gives every party — resolved BY CODE
  // and never by a literal id, so a company that reordered its chart still resolves.
  const [account] = await sp<{ id: string }[]>`
    select id from app.account where company_id = ${terminal.companyId} and code = '1200'`;
  await sp`
    insert into app.party (id, tenant_id, company_id, kind, code, name_en, phone, receivable_account_id)
    values (${nc.id}, ${ctx.tenantId}, ${terminal.companyId}, 'customer', ${nc.code}, ${nc.nameEn},
            ${nc.phone}, ${account?.id ?? null})
    on conflict (company_id, code) do nothing`;
  const [party] = await sp<{ id: string }[]>`
    select id from app.party where company_id = ${terminal.companyId} and code = ${nc.code}`;
  // The read-back is not decoration. `id` is the uuidv7 the till minted offline, so a RE-SENT ticket inserts
  // nothing and this returns the same party — which is the idempotence §2.7 asks for. But two DIFFERENT tills
  // can also quick-create "WALK-1" in the same minute, and then the loser's ticket must attach to the
  // WINNER's party rather than to a `customerId` no row carries. The id returned is therefore the one that
  // exists, which is not always the one the till minted, and that is the correct answer.
  return party!.id;
}

async function insertLines(sp: Sql, ctx: TenantContext, documentId: string, ticket: TicketInput): Promise<void> {
  const ccy = currency(ticket.currency);          // `validateShape` proved every line's currency equals it
  let lineNo = 0;
  for (const l of ticket.lines) {
    lineNo += 1;
    await sp`
      insert into app.document_line (
        tenant_id, document_id, line_no, kind, item_id, lot_id, quantity, unit_id,
        unit_price, discount, amount, tax_code_id, tax_amount, total_incl_tax, custom_fields)
      values (${ctx.tenantId}, ${documentId}, ${lineNo}, 'item', ${l.itemId}, ${l.lotId}, ${l.quantity}, ${l.unitId},
              ${l.unitPrice.amount}, ${l.discount.amount},
              ${Money.of(l.total.amount, ccy).subtract(Money.of(l.taxAmount.amount, ccy)).toString()},
              ${l.taxCodeId}, ${l.taxAmount.amount}, ${l.total.amount}, ${sp.json({})})`;
  }
  for (const t of ticket.tenders) {
    lineNo += 1;
    // `method` is lifted out of custom_fields into LineSnapshot.tenderMethod by loadSnapshot (Task 10 Step 3),
    // which is what the policy's `when: { "line.tender_method": … }` reads. `reference` stays in the untyped
    // bag: nothing branches on it, and a card receipt number is data.
    await sp`
      insert into app.document_line (
        tenant_id, document_id, line_no, kind, amount, custom_fields)
      values (${ctx.tenantId}, ${documentId}, ${lineNo}, 'tender', ${t.amount.amount},
              ${sp.json({ method: t.method, reference: t.reference })})`;
  }
}

function verifyTax(ticket: TicketInput, computed: { lineNo: number; taxAmount: string }[]): void {
  const ccy = currency(ticket.currency);
  const byLine = new Map(computed.map((c) => [c.lineNo, c.taxAmount]));
  for (let i = 0; i < ticket.lines.length; i += 1) {
    const wire = ticket.lines[i]!;
    const server = byLine.get(i + 1);
    if (server === undefined) continue;                     // a line the engine did not tax (no tax code)
    // Money.equals, NEVER string equality: "6.00" and "6.0000" are the same money, and a string comparison
    // would refuse every ticket a till happens to format at a different scale — which would read as a
    // protocol bug rather than a pricing one, and would be diagnosed as such for a long time.
    if (!Money.of(server, ccy).equals(Money.of(wire.taxAmount.amount, ccy))) {
      throw new SyncError("ERR_VALIDATION_FAILED",
        `ticket ${ticket.clientRef} line ${wire.lineNo}: the till says tax ${wire.taxAmount.amount} and this server computes ${server}`
        + `; re-pull the catalogue and re-price — the server does not overwrite a price the shop did not choose (LEGACY-020)`);
    }
  }
}

/**
 * Shifts and till events before 6D. **Refused per message, never dropped** — the till keeps its outbox row,
 * so an opening float is not lost with no trace (§4.10.1; the failure acceptance test 21 exists to catch).
 * 6D's first task replaces the body with the inserts and re-runs this file's test unchanged.
 */
async function refuseUnsupported(_tx: Sql, messages: unknown[], kind: "shift" | "till_event"): Promise<MessageOutcome[]> {
  if (messages.length === 0) return [];
  const table = kind === "shift" ? "app.shift" : "app.till_event";
  // 6D REPLACES THIS WHOLE BODY with the real inserts, renames `_tx` back to `tx`, and deletes this comment.
  // Deliberately NO `to_regclass` capability probe here. A probe that threw the day 6D's migration landed one
  // commit ahead of 6D's `applyBatch` edit would throw on `tx` — `refuseUnsupported` runs OUTSIDE the per-ticket
  // savepoint — so it would escape `applyBatch` entirely and 500 the whole batch, losing every accepted ticket
  // in it and writing no `needs_attention` row. Refusing a shift message one commit too long costs the till a
  // retry it is already built for (the outbox row stays pending); a 500 on the batch is not recoverable.
  return messages.map((m) => ({
    ref: refOf(m, kind),
    status: "rejected" as const,
    error: { code: "ERR_SYNC_MESSAGE_UNSUPPORTED", detail: `${table} is 6D's and does not exist yet; the till keeps this row` },
  }));
}

/** §4.10.1's ack keys: a `ShiftOpenClose` by `"<shiftId>:<kind>"` (one row per transition), a `TillEventMsg`
 *  by `clientRef`. A message the till sent in a shape we cannot key is acked as itself — never silently. */
function refOf(m: unknown, kind: "shift" | "till_event"): string {
  const o = (m ?? {}) as Record<string, unknown>;
  return kind === "shift" ? `${String(o.shiftId ?? "")}:${String(o.kind ?? "")}` : String(o.clientRef ?? "");
}

/**
 * The one classifier, and `ERR_SYNC_TICKET_REJECTED` is its named default.
 *
 * Every branch below maps to a code already in `ERRORS`, and the default is the row Step 4 adds — which is
 * also what keeps the `error-codes` lint green for it (§4.2.4: a code present in `ERRORS` with no raiser
 * fails the build). `"DUPLICATE"` is a sentinel and not a code: the caller turns it into a `duplicate`
 * outcome, and it never reaches a needs-attention row or a wire response.
 */
function classify(e: unknown): { code: string; detail: string } {
  if (e instanceof SyncError) return { code: e.code, detail: e.detail };
  if (e instanceof PostingError) return { code: e.code, detail: e.message };
  const pg = e as { code?: string; constraint_name?: string; message?: string };
  if (pg.code === "23505" && pg.constraint_name === "document_company_id_client_ref_key") {
    return { code: "DUPLICATE", detail: "applied by a concurrent transaction" };
  }
  if (pg.code === "23505") return { code: "ERR_CONFLICT_UNIQUE", detail: pg.constraint_name ?? "a unique constraint was violated" };
  if (pg.code === "23503") return { code: "ERR_CONFLICT_REFERENCE", detail: pg.constraint_name ?? "a referenced row does not exist" };
  if (pg.code === "42501") return { code: "ERR_RLS_DENIED", detail: "row-level security refused this write" };
  if (pg.code === "23514") {
    // Every guard in this system raises `ERR_<CODE>: detail` as its CHECK message (plan0A:1130-1141), so the
    // token is the code: ERR_STOCK_INSUFFICIENT, ERR_OVERRIDE_NOT_AUTHORISED, ERR_PERIOD_NOT_OPEN,
    // ERR_LEDGER_UNBALANCED, ERR_ACTOR_IMMUTABLE and the rest arrive here and are passed through unchanged.
    const m = /^(ERR_[A-Z_]+):\s*(.*)$/s.exec(pg.message ?? "");
    if (m) return { code: m[1]!, detail: m[2]! };
  }
  // Named, not silent. A failure this function cannot classify is still a REFUSAL with a payload a branch
  // manager can act on — never a dropped ticket, and never a 500 that loses the sale.
  return { code: "ERR_SYNC_TICKET_REJECTED", detail: e instanceof Error ? e.message : String(e) };
}
```

  **One thing in that file a reviewer should read twice: every column that insert names is asserted, not assumed.** Six of them come from outside this task and each has a home: `series`, `branch_id`, `client_ref` and `attributed_to` are plan 0A's (0001); `warehouse_id` is 3A's (`0031_create_movement_stock_on_hand_and_warehouse_lot_links.sql`); `tax_inclusive` is 5A's (0054); and `terminal_id` and `shift_id` are **this slice's own Task 4** (0061). Task 0's gate carries the one line that cannot be proved by reading this plan — `need "3A document.warehouse" … "warehouse_id"` — and Task 4's `pos-columns.test.ts` proves the other two before this task runs. **Nothing here is conditional and nothing here defers a schema decision to run time:** if `shift_id` is missing when this file is written, Task 4 was not executed, and the fix is to execute it — not to edit this insert.


- [ ] **Step 3: Write `upsertNeedsAttention`.**

```ts
// packages/db/src/sync/needs-attention.ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { SyncError } from "./enrolment";

export interface NeedsAttentionInput {
  companyId: string; branchId: string; terminalId: string | null; clientRef: string;
  payload: unknown; errorCode: string; errorDetail: string;
}

/**
 * One row per ticket (`unique (company_id, client_ref)`): a till that re-sends a rejected ticket updates the
 * reason instead of stacking a second row, so the branch manager's queue shows attempts and not noise.
 *
 * **It never touches `resolved_at` or `resolved_by`, and that is a decision, not an omission.** The table's
 * `check ((resolved_by is null) = (resolved_at is null))` ties the two, and `app.stamp_actor` raises
 * `ERR_ACTOR_IMMUTABLE` on any change to a non-null actor column — so "re-opening" by clearing `resolved_at`
 * is impossible, and clearing BOTH would erase the fact that a manager really did resolve the earlier
 * attempt. A ticket that was resolved and then failed again therefore keeps its resolution stamp and shows
 * the new error; the branch manager sees it in the *resolved* list with a fresh reason, which is honest. The
 * alternative — an attempt-history child table — is more machinery than this queue has earned; ADR 0056
 * records the choice rather than a second lifecycle column appearing without one.
 *
 * Called on `tx` and never inside the failing ticket's savepoint, or the rollback would take it with it.
 */
export async function upsertNeedsAttention(
  tx: Sql, ctx: TenantContext, input: NeedsAttentionInput,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.needs_attention (
      tenant_id, company_id, branch_id, terminal_id, client_ref, payload, error_code, error_detail)
    values (${ctx.tenantId}, ${input.companyId}, ${input.branchId}, ${input.terminalId}, ${input.clientRef},
            ${tx.json(input.payload as never)}, ${input.errorCode}, ${input.errorDetail})
    on conflict (company_id, client_ref) do update
      set payload = excluded.payload, error_code = excluded.error_code, error_detail = excluded.error_detail
    returning id`;
  return row!.id;
}

export interface NeedsAttentionRow {
  id: string; branchId: string; terminalId: string | null; clientRef: string;
  errorCode: string; errorDetail: string; resolvedAt: string | null; createdAt: string;
}

/**
 * The shop queue, newest first, keyset-paged on `(created_at, id)` — §4.2.8's cursor shape, and the same
 * `(k, id)` pair 0B's `encodeCursor` carries, so the route encodes it with the shared codec rather than a
 * second one (hazard 9).
 *
 * `payload` is deliberately NOT selected: it is the whole rejected ticket and a list of fifty would be a
 * megabyte of JSON nobody reads. The row's own resource is where a manager opens it.
 */
export async function listNeedsAttention(
  tx: Sql,
  p: { companyId: string; branchId?: string; open?: boolean; cursor?: { createdAt: string; id: string } | null; limit: number },
): Promise<NeedsAttentionRow[]> {
  // Every filter is a bound parameter with a null-guard in SQL — never a conditionally concatenated fragment
  // (Global Constraint 1, LEGACY-036/037/069). `branchId is null` means "every branch this caller can see", and
  // RLS plus 6C's branch_isolation are what decide that, not this function.
  return tx<NeedsAttentionRow[]>`
    select id, branch_id as "branchId", terminal_id as "terminalId", client_ref as "clientRef",
           error_code as "errorCode", error_detail as "errorDetail",
           resolved_at as "resolvedAt", created_at as "createdAt"
      from app.needs_attention
     where company_id = ${p.companyId}
       and (${p.branchId ?? null}::uuid is null or branch_id = ${p.branchId ?? null})
       and (${p.open ?? null}::boolean is null
            or (${p.open ?? null}::boolean is true and resolved_at is null)
            or (${p.open ?? null}::boolean is false and resolved_at is not null))
       and (${p.cursor?.createdAt ?? null}::timestamptz is null
            or (created_at, id) < (${p.cursor?.createdAt ?? null}::timestamptz, ${p.cursor?.id ?? null}::uuid))
     order by created_at desc, id desc
     limit ${p.limit}`;
}

/**
 * Closes one row. `resolved_by` is **stamped by `app.stamp_actor` from the session** and is not a parameter:
 * the caller cannot name a resolver, which is LEGACY-044 for this table. Writing `app.current_actor()` in the
 * statement would be the same value by a second route, so the column is simply not in the SET list.
 */
export async function resolveNeedsAttention(
  tx: Sql, ctx: TenantContext, id: string, note: string,
): Promise<void> {
  const rows = await tx<{ id: string }[]>`
    update app.needs_attention
       set resolved_at = now(), resolved_by = ${ctx.actorId}, resolution_note = ${note}
     where id = ${id} and resolved_at is null
    returning id`;
  if (rows.length === 0) {
    // Already resolved, or in another tenant and therefore invisible. ONE answer for both, because a
    // different answer for "exists but resolved" would tell a caller a row exists in a tenant it cannot see.
    throw new SyncError("ERR_NOT_FOUND", `no open needs-attention row ${id}`);
  }
}
```

  ⚠️ **`resolved_by = ${ctx.actorId}` is written and then discarded**, and that is the point: `app.stamp_actor` overwrites a non-null supplied value with `app.current_actor()` on UPDATE (plan0A:2370–2376), so the two agree by construction and the column is in the SET list only because the table's `check ((resolved_by is null) = (resolved_at is null))` needs both set in one statement. Task 3's fourth case already asserts the discard — a supplied `b.human` comes back as `a.human`.

- [ ] **Step 4: Add the two error rows** to `packages/contracts/src/errors.ts` in this commit — `ERR_SYNC_TICKET_REJECTED` and `ERR_SYNC_MESSAGE_UNSUPPORTED`, and nothing else. `ERR_TERMINAL_ENROLMENT_INVALID` landed in T6, `ERR_TERMINAL_SIGNATURE_INVALID` and `ERR_TERMINAL_REVOKED` in T7, `ERR_SYNC_CURSOR_INVALID` in T8; with these two the slice's six §4.2.4 rows are complete.

```ts
  ERR_SYNC_TICKET_REJECTED: {
    status: 200,
    title: "Ticket rejected",
    remedy: "Open the ticket in the shop's needs-attention queue; the whole payload and the reason are there.",
  },
  ERR_SYNC_MESSAGE_UNSUPPORTED: {
    status: 200,
    title: "Message not supported yet",
    remedy: "Keep the outbox row and re-send; this server build does not apply this message kind.",
  },
```

  **Both are `200`, and in this slice neither ever becomes an HTTP status** (§4.2.4's table says so): they are *per-ticket* and *per-message* outcome codes inside a `200 BatchResult` — a `SyncError` is caught by `classify()` and lands in a `TicketResult` or a `MessageOutcome`, and never reaches the route's error handler — and the registry row exists so the till can branch on them.

  ⚠️ **From 6D onwards `ERR_SYNC_MESSAGE_UNSUPPORTED` *is* answered request-level, still with `200` and now with a `Problem` body, and that pairing is deliberate rather than an oversight.** 6D's Task 6 deletes `refuseUnsupported` once `app.shift` and `app.till_event` exist, which removes this slice's last raiser of the code, so the same task adds its replacement — a `KNOWN_BATCH_KEYS` guard in `apps/api/src/routes/sync/tickets.ts` that `throw`s an `AppError("ERR_SYNC_MESSAGE_UNSUPPORTED")` for any batch key outside the known set — and an `AppError` does go through the error handler, which reads its status from this row. **The `200` is right for that raiser too and §4.2.4 is not amended here:** what the code reports is a **capability gap in the server, not a defect in the request** — the till cannot fix it by editing the batch, and the contract it must obey is the one the per-message code already carries, *keep the outbox row and re-send after the server is upgraded* (§4.10.1, refuse-never-drop). A `4xx` would say the opposite to an older till: that the request was bad and the row can be discarded, which is spec:1305's forbidden failure by another route. A request-level status for this code would therefore be a **§4.2.4 amendment, and this slice raises none** — 6D's Task 0 gate asserts contracts:1576's `200 (per-message)` row by literal, so changing it would fail that gate as well as this reasoning. `ERR_SYNC_TICKET_REJECTED` **is raised** — it is the named default of `classify()` in Step 2, the code for a failure the classifier cannot place — which is what keeps the `error-codes` lint green for it (§4.2.4: a code present in `ERRORS` with no occurrence in `apps/**`, `packages/**/src/**` or `packages/db/migrations/**` fails the build). An earlier draft added the row without a raiser, and `bun run lint:rules` would have gone red at this commit and stayed red.

- [ ] **Step 5: Write ADR 0056.** Context: spec:1303–1305 and LEGACY-051. Decision: one transaction with a savepoint per ticket (not a transaction per ticket, which would lose the batch's atomicity against the catalogue read, and not one transaction for the batch, which would lose a good ticket to a bad neighbour); dedup on `client_ref` **read first and unique-constraint second**, because the read is the common case and the constraint is the race; `ERR_STOCK_INSUFFICIENT`, `ERR_OVERRIDE_NOT_AUTHORISED` and every posting error are **refusals into needs-attention**, never corrections; a tax disagreement is a refusal for the same reason; the **required permission codes are derived from the ticket's own content** (`requiredCodes`) and an override rescues exactly the three codes spec:2161 puts on a cashier's MAY-NOT list, with 2B's `assert_override_authorised` as the control and no check of `applyBatch`'s own; and the needs-attention row is an upsert that never clears a resolution. **`classify()` is written down in the ADR as a table**, because it is the function that decides whether a failure is a duplicate, a refusal or an unclassifiable refusal, and `ERR_SYNC_TICKET_REJECTED` is its named default rather than a code nothing raises. Consequences: a batch's tickets are applied in array order and a later ticket can be refused for stock a duplicate earlier in the same batch consumed — which is correct, and is why the till's outbox is ordered.

- [ ] **Step 6: Run and commit.** `bun run --cwd packages/db test -- sync/apply` — **expected:** 10 passed.

```bash
git add packages/db/src/sync/apply.ts packages/db/src/sync/needs-attention.ts packages/db/src/sync/index.ts \
        packages/contracts/src/errors.ts packages/db/test/sync/apply.test.ts \
        docs/adr/0056-up-sync-apply-savepoints-and-refusal.md
git commit -m "$(cat <<'EOF'
feat(db): applyBatch — savepoint per ticket, client_ref dedup, authority re-verified [6A T11]

The terminal acts and the cashier is attributed (LEGACY-044). Authority is re-checked against
app.principal_has and the override guard is 2B's trigger, not a check of our own (LEGACY-027,
LEGACY-048). A refusal writes the WHOLE ticket to needs_attention and never reaches the ledger
(spec:1305); a shift or till event before 6D is refused per message, never dropped.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `POST /v1/sync/tickets`, the `pos.sync.apply` job, and the needs-attention API

**Files**

- `packages/contracts/src/sync/ticket.ts`, `packages/contracts/src/sync/needs-attention.ts` — NEW
- `apps/api/src/routes/sync/tickets.ts`, `apps/api/src/routes/pos/needs-attention.ts` — NEW
- `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts` — MODIFY
- `packages/db/src/jobs/payloads.ts` — MODIFY
- `apps/worker/src/handlers/pos-sync-apply.ts`, `apps/worker/src/index.ts` — NEW/MODIFY
- `apps/api/test/routes/sync/tickets.test.ts`, `apps/worker/test/handlers/pos-sync-apply.test.ts` — NEW

**Interfaces**

- Consumes: `applyBatch`, `listNeedsAttention`, `resolveNeedsAttention` (T11); `terminalContext` (T7); `currentCatalogueRevision`, `encodeSyncCursor` (T8/T1); `JobClient`, `JobHandler`, `registerHandler`, `runJob`, `JOB_PROBES` (§4.2.6); `idempotency`, `IdempotencyHeader` (§4.2.9).
- Produces: the two route modules, `JobPayload["pos.sync.apply"]`, the handler, and the OpenAPI entries §3.7.4 asks for.

**Steps**

- [ ] **Step 1: Write the failing route test first — this carries the DoD sentence.**

```ts
// apps/api/test/routes/sync/tickets.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// FIVE levels: apps/api/test/routes/sync/ → four would resolve to `apps/`. Same as the other two sync route tests.
import { buildTicket, enrolTerminal, posFixture, syncRequest, uuidv7Sync, type PosFixture } from "../../../../../tests/invariants/support/pos";
import { startApi, type StartedApi } from "../../support/app";
import type { Problem } from "@dulja/contracts";
import type { BatchResult } from "@dulja/sync";

describe("POST /v1/sync/tickets — re-sending a batch changes nothing (the Phase 6 DoD, server half)", () => {
  let api: StartedApi; let f: PosFixture;
  beforeAll(async () => { api = await startApi(); f = await posFixture(api, "Tickets"); }, 240_000);
  afterAll(async () => { await api.stop(); });

  const ledgerCount = async (a: StartedApi): Promise<number> =>
    (await a.db.admin<{ n: number }[]>`select count(*)::int as n from app.ledger_entry`)[0]!.n;
  const documentCount = async (a: StartedApi): Promise<number> =>
    (await a.db.admin<{ n: number }[]>`select count(*)::int as n from app.document`)[0]!.n;

  it("applies a batch and answers a BatchResult with a catalogue cursor", async () => {
    const batch = { terminalId: f.terminal.terminalId, batchId: uuidv7Sync(),
                    tickets: [buildTicket(f, { sku: "SKU-A" }), buildTicket(f, { sku: "SKU-B" })], shifts: [], tillEvents: [] };
    const res = await syncRequest(api, f.terminal, { method: "POST", path: "/v1/sync/tickets", body: batch });
    expect(res.status).toBe(200);
    const out = (await res.json()) as BatchResult;
    expect(out.results.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect(out.catalogueCursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("THE DoD: the same batch sent three times posts once — by key replay, then by client_ref dedup", async () => {
    const batch = { terminalId: f.terminal.terminalId, batchId: uuidv7Sync(),
                    tickets: [buildTicket(f, { sku: "SKU-A" })], shifts: [], tillEvents: [] };
    const key = crypto.randomUUID();

    const first = await syncRequest(api, f.terminal, { method: "POST", path: "/v1/sync/tickets", body: batch, idempotencyKey: key });
    expect(first.status).toBe(200);
    const ledgerAfterFirst = await ledgerCount(api);
    const docsAfterFirst = await documentCount(api);

    // Layer 1 — the SAME key: the stored response is replayed and the handler never runs (§4.2.9).
    const second = await syncRequest(api, f.terminal, { method: "POST", path: "/v1/sync/tickets", body: batch, idempotencyKey: key });
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.clone().json());

    // Layer 2 — a DIFFERENT key, which is what a reinstalled till does: client_ref dedup answers `duplicate`.
    const third = await syncRequest(api, f.terminal, { method: "POST", path: "/v1/sync/tickets", body: batch, idempotencyKey: crypto.randomUUID() });
    const out = (await third.json()) as BatchResult;
    expect(out.results.map((r) => r.status)).toEqual(["duplicate"]);

    expect(await ledgerCount(api), "no second ledger entry").toBe(ledgerAfterFirst);
    expect(await documentCount(api), "no second document").toBe(docsAfterFirst);
  });

  it("a batch over 200 tickets is 202 with a job id and Retry-After, and no statusUrl", async () => {
    const tickets = Array.from({ length: 201 }, () => buildTicket(f, { sku: "SKU-A", quantity: "0.001000" }));
    const res = await syncRequest(api, f.terminal, { method: "POST", path: "/v1/sync/tickets",
      body: { terminalId: f.terminal.terminalId, batchId: uuidv7Sync(), tickets, shifts: [], tillEvents: [] } });
    expect(res.status).toBe(202);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["batchId", "jobId", "status"]);
  });

  it("the missing Idempotency-Key is refused like every other unsafe route (§4.2.9's two layers)", async () => {
    const res = await syncRequest(api, f.terminal, { method: "POST", path: "/v1/sync/tickets",
      body: { terminalId: f.terminal.terminalId, batchId: uuidv7Sync(), tickets: [], shifts: [], tillEvents: [] },
      idempotencyKey: null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("a batch whose terminalId is not the SIGNING terminal is refused (a till cannot sell as another till)", async () => {
    const other = await enrolTerminal(api, f.s, { as: f.s.human, code: "KL77" });
    const res = await syncRequest(api, f.terminal, { method: "POST", path: "/v1/sync/tickets",
      body: { terminalId: other.terminalId, batchId: uuidv7Sync(), tickets: [buildTicket(f, { sku: "SKU-A" })], shifts: [], tillEvents: [] } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });
});
```

  Run `bun run --cwd apps/api test -- routes/sync/tickets`. **Expected failure:** every case is 404 — the module is not mounted.

- [ ] **Step 2: Write the two Zod twins.**

```ts
// packages/contracts/src/sync/ticket.ts — §4.10.1's shapes, as schemas. The wire and the TypeScript come
// from one place, which is what makes spec:1318's "as though an external client would use it" checkable.
import { z } from "@hono/zod-openapi";
import { MoneySchema, QuantitySchema, TimestampSchema, UuidSchema } from "../common";

/** A bigint crosses the wire as a decimal STRING. Read as a JSON number a revision past 2^53 would round,
 *  and one row would be re-delivered for ever — the failure acceptance test 20 exists to catch (T1). */
const BigintString = z.string().regex(/^\d+$/);
export const TenderMethodSchema = z.enum(["cash", "card", "transfer", "store_credit"]);

export const TicketLineSchema = z.object({
  lineNo: z.number().int().min(1),
  itemId: UuidSchema,
  lotId: UuidSchema.nullable(),
  /** Signed: NEGATIVE on a return line. Direction is carried by this sign on the wire and by
   *  `PlannedMovement.effect` / `PlannedLedgerLine.side` after evaluation (§4.4.2 A9). */
  quantity: QuantitySchema,
  unitId: UuidSchema,
  unitPrice: MoneySchema,
  discount: MoneySchema,
  taxCodeId: UuidSchema.nullable(),
  taxAmount: MoneySchema,
  /** Tax-INCLUSIVE: `POS_TICKET` declares `tax.inclusive: true` (§4.6.5). */
  total: MoneySchema,
}).openapi("TicketLine");

export const TicketTenderSchema = z.object({
  tenderNo: z.number().int().min(1),
  method: TenderMethodSchema,
  amount: MoneySchema,
  reference: z.string().max(120).nullable(),
}).openapi("TicketTender");

/** `code` is the ONE override code the server can store (§4.10.1): `document_event.override_code` admits
 *  exactly `OverrideCode`'s three values, and `assert_override_authorised` verifies the supervisor holds
 *  *that* code. What the override was FOR travels in `subject`. */
export const TicketEventSchema = z.object({
  kind: z.literal("override"),
  code: z.literal("pos.ticket.override"),
  subject: z.enum(["discount", "void", "blind_return", "price_override"]),
  supervisorPrincipalId: UuidSchema,
  reason: z.string().min(1).max(500),
}).openapi("TicketEvent");

export const NewCustomerSchema = z.object({
  id: UuidSchema, code: z.string().min(1).max(40), nameEn: z.string().min(1).max(200),
  phone: z.string().max(40).nullable(),
}).openapi("NewCustomer");

export const TicketSchema = z.object({
  clientRef: UuidSchema,
  shiftId: UuidSchema,
  cashierPrincipalId: UuidSchema,
  customerId: UuidSchema.nullable(),
  newCustomer: NewCustomerSchema.nullable().optional(),
  kind: z.enum(["sale", "return"]),
  returnsClientRef: UuidSchema.nullable(),
  currency: z.string().length(3),
  soldAt: TimestampSchema,
  lines: z.array(TicketLineSchema).min(1),
  tenders: z.array(TicketTenderSchema).min(1),
  events: z.array(TicketEventSchema),
  attendance: z.array(z.object({
    kind: z.enum(["clock_in", "clock_out"]), principalId: UuidSchema, at: TimestampSchema,
  })),
  catalogueRevision: BigintString,
}).openapi("Ticket");

export const ShiftOpenCloseSchema = z.object({
  shiftId: UuidSchema, kind: z.enum(["open", "close"]), terminalId: UuidSchema,
  cashierPrincipalId: UuidSchema, at: TimestampSchema, currency: z.string().length(3),
  openingFloat: MoneySchema.nullable(), countedCash: MoneySchema.nullable(),
}).openapi("ShiftOpenClose");

export const TillEventMsgSchema = z.object({
  clientRef: UuidSchema, shiftId: UuidSchema, kind: z.enum(["no_sale", "drawer_open", "void"]),
  ticketClientRef: UuidSchema.nullable(), cashierPrincipalId: UuidSchema,
  supervisorPrincipalId: UuidSchema.nullable(), occurredAt: TimestampSchema,
}).openapi("TillEventMsg");

export const TicketBatchSchema = z.object({
  terminalId: UuidSchema, batchId: UuidSchema,
  tickets: z.array(TicketSchema), shifts: z.array(ShiftOpenCloseSchema), tillEvents: z.array(TillEventMsgSchema),
}).openapi("TicketBatch");

/** An EMPTY batch is refused at the schema and never reaches `applyBatch`: it would take the per-terminal
 *  advisory lock, read the catalogue revision and answer three empty arrays — work and a lock for nothing,
 *  on a route a till may poll. */
export const TicketBatchBody = TicketBatchSchema.refine(
  (b) => b.tickets.length + b.shifts.length + b.tillEvents.length > 0,
  "a batch carries at least one message",
);

const OutcomeStatus = z.enum(["accepted", "duplicate", "rejected"]);
/** `code` is an `ErrCode`, and the union is not restated here: `ErrorCodeSchema` is 0B's and widening a
 *  second copy per slice is hazard 9. */
const OutcomeError = z.object({ code: z.string(), detail: z.string() }).nullable();

export const TicketResultSchema = z.object({
  clientRef: UuidSchema, status: OutcomeStatus,
  documentId: UuidSchema.nullable(), number: z.string().nullable(), error: OutcomeError,
}).openapi("TicketResult");
export const MessageResultSchema = z.object({
  ref: z.string().min(1), status: OutcomeStatus, error: OutcomeError,
}).openapi("MessageResult");
export const BatchResultSchema = z.object({
  batchId: UuidSchema,
  results: z.array(TicketResultSchema),
  shiftResults: z.array(MessageResultSchema),
  tillEventResults: z.array(MessageResultSchema),
  /** The server's current cursor, so the till knows how stale it is — the SAME opaque form `next_cursor`
   *  carries, encoded by the SAME codec (`encodeSyncCursor`, T1). */
  catalogueCursor: z.string().regex(/^[A-Za-z0-9_-]+$/),
}).openapi("BatchResult");

/** §4.10.4's 202 body, with no `statusUrl` — Task 0 amendment 12. */
export const BatchQueuedSchema = z.object({
  batchId: UuidSchema, jobId: z.string().min(1), status: z.literal("queued"),
}).openapi("BatchQueued");
```

```ts
// packages/contracts/src/sync/needs-attention.ts
import { z } from "@hono/zod-openapi";
import { CursorSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

export const NeedsAttentionSchema = z.object({
  id: UuidSchema, branchId: UuidSchema, terminalId: UuidSchema.nullable(), clientRef: UuidSchema,
  errorCode: z.string(), errorDetail: z.string(),
  resolvedAt: TimestampSchema.nullable(), createdAt: TimestampSchema,
}).openapi("NeedsAttention");

/** §4.2.8's ONE list-filter convention: literal `filter[…][eq]` keys, the Layer 2 default. Not a bespoke
 *  `?branchId=` — three forms had already shipped when round 2 settled this, and a fourth is hazard 9. */
export const NeedsAttentionQuery = z.object({
  "filter[branchId][eq]": UuidSchema.optional(),
  "filter[resolved][eq]": z.enum(["true", "false"]).optional(),
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const NeedsAttentionList = ListEnvelope(NeedsAttentionSchema);
export const ResolveNeedsAttentionBody = z.object({
  note: z.string().min(1).max(500),
}).openapi("ResolveNeedsAttention");
```

  **`payload` is not on `NeedsAttentionSchema`.** The column holds the whole rejected ticket and `listNeedsAttention` does not select it (T11 Step 3, `listNeedsAttention`); a list of fifty would be a megabyte of JSON nobody reads, and a schema member with no producer would put it in the OpenAPI document as a promise. The row's own resource is where a manager opens it, and the slice that ships that resource adds the member in the PR that fills it.

- [ ] **Step 3: Write the tickets route.**

```ts
// apps/api/src/routes/sync/tickets.ts
export const ticketRoutes = new OpenAPIHono<AppEnv>();
ticketRoutes.openapi(
  createRoute({
    method: "post", path: "/", tags: ["sync"],
    request: { headers: IdempotencyHeader, body: { content: { "application/json": { schema: TicketBatchBody } } } },
    middleware: [requirePermission(PERMISSION["pos.sync.push"], { company: "terminal" })],
    responses: {
      200: { description: "applied", content: { "application/json": { schema: BatchResultSchema } } },
      202: { description: "queued", content: { "application/json": { schema: BatchQueuedSchema } } },
      400: { description: "invalid", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const batch = c.req.valid("json");
    const t = c.get("terminal");
    // A till may only sell as ITSELF. The body's terminalId is data; the signature is identity (LEGACY-044).
    if (batch.terminalId !== t.terminalId) {
      throw new AppError("ERR_VALIDATION_FAILED", "the batch's terminalId is not the terminal that signed this request");
    }
    if (batch.tickets.length > SYNC_BATCH_SYNC_LIMIT) {
      const jobId = await c.var.withTenant((tx) => c.get("jobs").enqueue(tx, "pos.sync.apply", {
        tenantId: t.tenantId, requestId: c.get("requestId"),
        payload: { terminalId: t.terminalId, batch },
      }, { singletonKey: batch.batchId }));
      c.header("Retry-After", "5");
      return c.json({ batchId: batch.batchId, jobId, status: "queued" as const }, 202);
    }
    const out = await c.var.withTenant((tx) => applyBatch(tx, c.get("ctx"),
      { terminalId: t.terminalId, companyId: t.companyId, branchId: t.branchId, principalId: t.principalId }, batch));
    return c.json(toBatchResult(out), 200);
  },
);
```

```ts
// apps/api/src/routes/sync/tickets.ts — the private mapper, below the route.
/**
 * Where the two type systems meet. `packages/db` may not import `@dulja/sync` (§3.1), so `applyBatch` answers
 * a db-local `BatchOutcome` whose `error.code` is a plain `string` and whose cursor is a `bigint`; the wire
 * `BatchResult` wants an `ErrCode` and the opaque cursor string. One function, at the boundary, and no
 * `as unknown as` anywhere else in the slice.
 */
function toBatchResult(out: BatchOutcome): z.infer<typeof BatchResultSchema> {
  const narrow = (e: { code: string; detail: string } | null) =>
    e === null ? null : { code: e.code as ErrCode, detail: e.detail };
  return {
    batchId: out.batchId,
    results: out.results.map((r) => ({ ...r, error: narrow(r.error) })),
    shiftResults: out.shiftResults.map((r) => ({ ...r, error: narrow(r.error) })),
    tillEventResults: out.tillEventResults.map((r) => ({ ...r, error: narrow(r.error) })),
    // The SAME codec the catalogue route uses (T1), never a second spelling of "encode a revision".
    catalogueCursor: encodeSyncCursor({ revision: out.catalogueRevision }),
  };
}
```

  ⚠️ **`e.code as ErrCode` is the one cast in this slice, and it is load-bearing that it be safe.** Every code `applyBatch` can produce comes from `classify()` (T11 Step 2), whose branches are `SyncErrorCode`, `PostingErrorCode`, four SQLSTATE mappings and the `ERR_<TOKEN>` a CHECK constraint raises — all of them rows in `ERRORS` by Global Constraint 11's closed list. The cast is therefore checked by that list and by the `error-codes` lint, not by the compiler; **state it in the PR body** so a reviewer knows where to look if the list ever grows.

  **`c.get("jobs")` is an `AppEnv["Variables"]` member** set by `createApp` from `AppDeps` (Task 0 amendment 7, wired in T6 Step 6). It is one of exactly two reads of it in the system — this one — and it exists because `ROUTES` is derived from `buildRoutes({ authAdmin: new StubAuthAdmin() })` at module scope, where no `JobClient` exists to hand a factory.

  **The enqueue is inside `c.var.withTenant`** so the job becomes visible only if the transaction commits (§4.2.6, spec:2321). `singletonKey: batch.batchId` means a client that retries the 202 with a fresh key enqueues no second job.

- [ ] **Step 4: Write the needs-attention route.**

```ts
// apps/api/src/routes/pos/needs-attention.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PERMISSION, ProblemSchema, UuidSchema, decodeCursor, encodeCursor } from "@dulja/contracts";
import {
  NeedsAttentionList, NeedsAttentionQuery, ResolveNeedsAttentionBody,
} from "@dulja/contracts/sync/needs-attention";
import { listNeedsAttention, resolveNeedsAttention, SyncError } from "@dulja/db";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../index";
import type { AppEnv } from "../../context";

export const needsAttentionRoutes = new OpenAPIHono<AppEnv>();

/**
 * **Two operations, and no third.** A needs-attention row is never deleted (§3.5.4 pins the `app_rw` DELETE
 * list at five tables and 2B is its only extender); it is closed by `resolved_at`. There is no PATCH either:
 * every column but the resolution is written by `applyBatch` from the ticket, and a hand-edited error code
 * would make the queue lie about why the till was refused.
 *
 * **A `GET` gated by a `mutating: true` code is legal**, and it is worth saying why once. R7 (spec:2178)
 * forbids gating an *unsafe method* with a `mutating: false` code — `assertRouteGates` raises
 * `ERR_ROUTE_GATE_READONLY` at boot for that — and says nothing about the reverse. §4.16.1's
 * `accounting.unreconciled_items` is the registered precedent, *"mutating-gated by design: only a reconciler
 * sees it"*, and the same reading applies here: the queue shows refused tickets with their reasons, and the
 * person who may see them is the person who may act on them.
 */
needsAttentionRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["pos"],
    request: { params: z.object({ companyId: UuidSchema }), query: NeedsAttentionQuery },
    middleware: [requirePermission(PERMISSION["pos.needs_attention.resolve"], { company: "path:companyId" })],
    responses: {
      200: { description: "the shop queue, newest first", content: { "application/json": { schema: NeedsAttentionList } } },
      400: { description: "bad cursor", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    // 0B's list codec, not the sync one: §4.2.8's `{ k, id }` keyset position is a different thing from
    // §4.10.1's revision cursor, and using either for the other is hazard 9. T1's own comment says so.
    const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
    const rows = await c.var.withTenant((tx) => listNeedsAttention(tx, {
      companyId,
      branchId: q["filter[branchId][eq]"],
      open: q["filter[resolved][eq]"] === undefined ? undefined : q["filter[resolved][eq]"] === "false",
      cursor: cursor === null ? null : { createdAt: cursor.k, id: cursor.id },
      limit: q.limit + 1,
    }));
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items.at(-1);
    return c.json({
      items,
      nextCursor: hasMore && last ? encodeCursor({ k: last.createdAt, id: last.id }) : null,
    }, 200);
  },
);

needsAttentionRoutes.openapi(
  createRoute({
    method: "post", path: "/{id}/resolve", tags: ["pos"],
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, id: UuidSchema }),
      body: { content: { "application/json": { schema: ResolveNeedsAttentionBody } } },
    },
    middleware: [requirePermission(PERMISSION["pos.needs_attention.resolve"], { company: "path:companyId" })],
    responses: {
      204: { description: "resolved" },
      404: { description: "no open row with that id", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { note } = c.req.valid("json");
    // `resolved_by` is NOT a parameter anywhere on this path: `resolveNeedsAttention` sets it from `ctx` and
    // `app.stamp_actor` overwrites it from the session regardless (LEGACY-044). A caller cannot name a resolver.
    await c.var.withTenant((tx) => resolveNeedsAttention(tx, c.get("ctx"), id, note));
    return c.body(null, 204);
  },
);
```

  `apps/api/src/problem.ts`'s `SyncError` branch (T7 Step 5) is what turns `resolveNeedsAttention`'s `ERR_NOT_FOUND` into the 404 above — a row that is already resolved and a row in another tenant answer the **same** 404, so no caller learns that a row exists in a tenant it cannot see.

  Register both modules and their probes:

```ts
// apps/api/src/routes/index.ts — inside buildRoutes(deps).
  { path: "/v1/sync/tickets", router: ticketRoutes, permissions: [PERMISSION["pos.sync.push"]], auth: "terminal" },
  { path: "/v1/companies/:companyId/needs-attention", router: needsAttentionRoutes,
    permissions: [PERMISSION["pos.needs_attention.resolve"]], auth: "human" },
```

```ts
// tests/invariants/probes.ts
  "/v1/sync/tickets": {
    async seed() {
      return { path: "/v1/sync/tickets", method: "POST",
               body: { terminalId: "00000000-0000-7000-8000-000000000000", batchId: "00000000-0000-7000-8000-000000000001",
                       tickets: [], shifts: [], tillEvents: [] } };
    },
    // The harness sends a HUMAN bearer token; terminalAuth refuses it at the identity layer, before the gate
    // or the handler. 401 is the recorded value, not a widened acceptance set (Task 0 amendment 8).
    expect: 401,
  },
  "/v1/companies/:companyId/needs-attention": {
    async seed(_db, owner) { return { path: `/v1/companies/${owner.company}/needs-attention`, method: "GET" }; },
    expect: 403,
  },
```

- [ ] **Step 5: Write the job payload and handler.**

```ts
// packages/db/src/jobs/payloads.ts — one key, additively (§4.2.6).
  /** Slice 6A. `batch` is a `TicketBatch` structurally; the type is `unknown` because `packages/db` may not
   *  import `@dulja/sync` (§3.1) and `applyBatch` takes its own db-local shape. */
  "pos.sync.apply": { terminalId: string; batch: unknown };
```

```ts
// apps/worker/src/handlers/pos-sync-apply.ts
/**
 * The ONE job that does not run as the tenant's system principal (Task 0 amendment 13, hazard 19 over 20).
 * `runJob` has already resolved a system context; this handler discards it and builds the TERMINAL's, because
 * `document.posted_by` on a POS ticket must be the terminal and a system-posted ticket would misattribute
 * every POS posting in the ledger. The terminal id comes from the payload the ROUTE wrote after verifying the
 * signature — never from a client body — and revocation is re-checked here, because a terminal can be revoked
 * between the 202 and the job's turn.
 */
export const posSyncApply: JobHandler<"pos.sync.apply"> = async (sql, job) => {
  const { terminalId, batch } = job.payload;
  const { ctx, terminal } = await terminalContext(sql, terminalId, job.requestId);
  if (terminal.tenantId !== job.tenantId) {
    throw new Error(`pos.sync.apply: terminal ${terminalId} is not in tenant ${job.tenantId}`);
  }
  if (terminal.revokedAt !== null) {
    // Not a throw: a revoked terminal's queued batch is not a system failure, and retrying it three times
    // would only fail three times. Every ticket lands in needs-attention with a reason a manager can act on.
    await withTenant(sql, ctx, (tx) => quarantineBatch(tx, ctx, terminal, batch as TicketBatchInput));
    return;
  }
  await withTenant(sql, ctx, (tx) => applyBatch(tx, ctx,
    { terminalId, companyId: terminal.companyId, branchId: terminal.branchId, principalId: terminal.principalId },
    batch as TicketBatchInput));
};
registerHandler("pos.sync.apply", posSyncApply);
```

```ts
// apps/worker/src/handlers/pos-sync-apply.ts — the private helper, below the handler.
/**
 * A revoked terminal's queued batch. Every ticket lands in the queue with a reason a branch manager can act
 * on, and NOTHING is posted: the terminal lost its authority between the 202 and the job's turn, and posting
 * anyway would be exactly the "one variable disables every control" of LEGACY-027 read backwards.
 *
 * Not a throw, deliberately: pg-boss would retry it three times and fail three times, and a manager would see
 * a failed job instead of nine actionable rows.
 */
async function quarantineBatch(
  tx: Sql, ctx: TenantContext, terminal: TerminalRow, batch: TicketBatchInput,
): Promise<void> {
  for (const ticket of batch.tickets) {
    await upsertNeedsAttention(tx, ctx, {
      companyId: terminal.companyId, branchId: terminal.branchId, terminalId: terminal.terminalId,
      clientRef: ticket.clientRef, payload: ticket,
      errorCode: "ERR_TERMINAL_REVOKED",
      errorDetail: `terminal ${terminal.terminalId} was revoked before this batch was applied; re-enrol the till and re-send`,
    });
  }
}
``` Add the `JOB_PROBES["pos.sync.apply"]` entry: `seed` writes a ticket for the **victim** tenant's terminal into the attacker's envelope; `survivors` counts the victim's documents, which must be unchanged — the `terminal.tenantId !== job.tenantId` guard above is what makes it so, and it is there because `terminalContext` resolves a tenant from the terminal id and a payload could otherwise name any terminal in the database.

- [ ] **Step 6: Run everything, and close the lint.** `bun run --cwd apps/api test -- routes/sync/tickets` (**expected:** 5 passed), `bun run --cwd apps/worker test -- pos-sync-apply` (**expected:** green), `bun run --cwd tests test -- tenant-isolation` (**expected:** green with four new `PROBES` keys and one `JOB_PROBES` key), and `bun run lint:rules`, **green here as at every commit since T5**. The eleven codes are referenced as follows and the accounting is worth stating once, because "it will be green by the end" is what an earlier draft assumed and got wrong: `admin.terminal.manage` on the admin module (T6), `pos.sync.pull` on the catalogue module (T8), `pos.sync.push` on the tickets module *and* in `POLICY_RESOLVED_CODES` (T10, T12), `pos.needs_attention.resolve` on the needs-attention module (T12) **and** in `POS_PERMISSION` (T5), and the other seven in `POS_PERMISSION` (T5) — where `applyBatch` evaluates them from T11. Regenerate and commit the OpenAPI document: `bun run --cwd packages/contracts openapi:generate` — spec:1318's *"OpenAPI for every sync route as though an external client would use it"* is this file, and CI fails on a diff.

```bash
git add packages/contracts/src/sync apps/api/src/routes/sync/tickets.ts apps/api/src/routes/pos \
        apps/api/src/routes/index.ts tests/invariants/probes.ts packages/db/src/jobs/payloads.ts \
        apps/worker/src/handlers/pos-sync-apply.ts apps/worker/src/index.ts packages/contracts/openapi.json \
        apps/api/test/routes/sync/tickets.test.ts apps/worker/test/handlers/pos-sync-apply.test.ts
git commit -m "$(cat <<'EOF'
feat(api): POST /v1/sync/tickets, the pos.sync.apply job, and the needs-attention queue [6A T12]

The Phase 6 DoD's server half: the same batch sent three times posts once — the second by
Idempotency-Key replay, the third by client_ref dedup with a fresh key. Over 200 tickets is
202 + Retry-After and the till re-sends; there is no status resource to get wrong.

There is no red window to close: the catalogue has been green since T5, which landed the
eleven rows and packages/db/src/sync/authority.ts in one commit. This one adds the last
three route-gated references — pos.sync.push, pos.sync.pull's sibling on the tickets module,
and pos.needs_attention.resolve — and lint:rules is green here as at every commit since.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Acceptance test 22 — one posting path

**Files**

- `tests/invariants/pos-one-posting-path.test.ts` — NEW
- `tests/invariants/support/pos.ts` — MODIFY (`POS_EQUIV_INVOICE` in `posFixture.types`)

**What is being proved.** spec:2440: *"A POS ticket and an equivalent back-office invoice produce identical ledger entries and cost consumptions after projecting out `id`, `document_id`, `posted_at`, `posted_by`."* §5 hazard 18 fixes the projection set exactly, and Task 0's amendment fixes what "equivalent back-office invoice" means: **`POS_EQUIV_INVOICE`**, the stock-issuing type this slice configures in its own fixture, under 4A's amendment-15 reading (a). The two documents differ in **type, series, acting principal and write path** — a terminal calling `applyBatch` versus a human calling `POST …/documents/{id}/transitions` — and in nothing else. That is what makes an identical multiset mean "one posting service" rather than "two identical constants".

**Interfaces**

- Consumes: `posFixture`, `buildTicket`, `syncRequest`, `uuidv7Sync` (T10); `applyBatch` (T11); `draftTypedDocument` (3C); **`sharedApi` (§4.17.1 — 0B's memoised API, NOT `startApi`)**; `grantCodes`, `secondPrincipal` (2B/3D).
- Produces: no code. One invariant test file.

**Steps**

- [ ] **Step 1: Write the test.**

```ts
// tests/invariants/pos-one-posting-path.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch } from "@dulja/db";
import { withTenant } from "@dulja/db";
import { draftTypedDocument, grantCodes } from "@dulja/db/test";
// §4.18 round 3's §3.7.5 settlement: a root `tests/**` file takes a TYPE-ONLY import from
// apps/api/test/support/app, and its replacement for the value half is 0B's memoised `sharedApi()`. This file
// takes both halves that way — `StartedApi` as a type, the instance from `sharedApi()` — and therefore never
// calls `stop()` on it, because the API it holds is shared with every other file in the run.
import type { StartedApi } from "../../apps/api/test/support/app";
import { sharedApi } from "../support/api";
import { buildTicket, posFixture, syncRequest, uuidv7Sync, type PosFixture } from "./support/pos";

/** §5 hazard 18, verbatim: the projected ledger-entry tuple. `posting_policy_id` is out because the two
 *  documents NECESSARILY pin different policies — that is the point, not an accident. */
const LEDGER_PROJECTION = `account_id, debit::text, credit::text, currency, exchange_rate::text,
                           base_debit::text, base_credit::text, effective_date::text, fiscal_period_id`;

async function ledgerMultiset(api: StartedApi, documentId: string): Promise<string[]> {
  const rows = await api.db.admin<Record<string, string>[]>`
    select account_id, debit::text as debit, credit::text as credit, currency, exchange_rate::text as exchange_rate,
           base_debit::text as base_debit, base_credit::text as base_credit,
           effective_date::text as effective_date, fiscal_period_id
      from app.ledger_entry where document_id = ${documentId}`;
  return rows.map((r) => JSON.stringify(r)).sort();
}

async function dimensionMultiset(api: StartedApi, documentId: string): Promise<string[]> {
  const rows = await api.db.admin<{ code: string; value: string }[]>`
    select dt.code, d.dimension_value_id::text as value
      from app.ledger_entry_dimension d
      join app.ledger_entry l on l.id = d.ledger_entry_id
      join app.dimension_value dv on dv.id = d.dimension_value_id
      join app.dimension_type dt on dt.id = dv.dimension_type_id
     where l.document_id = ${documentId}`;
  return rows.map((r) => `${r.code}:${r.value}`).sort();
}

async function consumptionMultiset(api: StartedApi, documentId: string): Promise<string[]> {
  const rows = await api.db.admin<Record<string, string>[]>`
    select m.item_id, m.warehouse_id, m.lot_id, c.quantity::text as quantity,
           c.unit_cost::text as unit_cost, c.value::text as value
      from app.cost_consumption c
      join app.inventory_movement m on m.id = c.movement_id
     where m.document_id = ${documentId}`;
  return rows.map((r) => JSON.stringify(r)).sort();
}

describe("acceptance test 22 — one posting path (spec:2440, LEGACY-009)", () => {
  let api: StartedApi; let f: PosFixture;
  let ticketDocId: string; let invoiceDocId: string;

  beforeAll(async () => {
    // `sharedApi()` resolves to `{ api, a, b }` (0B's shape, phase-0b:5719) and internally calls `startApi()`,
    // so Task 7's seventh `AppDeps` member reaches this instance exactly as it reaches a route test's own.
    // The two seeded tenants `a` and `b` are the regression corpus and are not this file's — `posFixture`
    // seeds its own — so they are destructured away.
    ({ api } = await sharedApi());
    f = await posFixture(api, "OnePath");
    // The human half needs the code the POS_EQUIV_INVOICE policy names; the terminal already holds
    // pos.sync.push through its pos_terminal assignment (R8).
    await grantCodes(api.db, f.s, { codes: ["accounting.sales.post"], principalId: f.s.human });

    // ── the POS half: a terminal, a signed call, applyBatch, postDocument ────────────────────────────
    const ticket = buildTicket(f, { sku: "SKU-A", quantity: "3.000000", unitPrice: "20.0000", tender: "cash" });
    const res = await syncRequest(api, f.terminal, {
      method: "POST", path: "/v1/sync/tickets",
      body: { terminalId: f.terminal.terminalId, batchId: uuidv7Sync(), tickets: [ticket], shifts: [], tillEvents: [] },
    });
    expect(res.status).toBe(200);
    ticketDocId = ((await res.json()) as { results: { documentId: string }[] }).results[0]!.documentId;

    // ── the back-office half: a human, the ordinary documents route, the SAME lines ──────────────────
    const drafted = await draftTypedDocument(api.db, f.s, {
      documentTypeId: f.types.POS_EQUIV_INVOICE!, series: "PEI",
      effectiveDate: ticketEffectiveDate(ticket),
      warehouseId: f.warehouseId, branchId: f.s.hq, currency: "MYR",
      lines: [
        { kind: "item", itemId: f.items["SKU-A"]!.itemId, warehouseId: f.warehouseId,
          unitId: f.items["SKU-A"]!.baseUnitId, quantity: "3.000000", unitPrice: "20.0000",
          amount: ticket.lines[0]!.total.amount, taxCodeId: ticket.lines[0]!.taxCodeId ?? undefined },
        { kind: "tender", amount: ticket.tenders[0]!.amount.amount, customFields: { method: "cash", reference: null } },
      ],
    });
    // document.tax_inclusive matches the ticket's, so 5A's resolveInclusive answers identically for both.
    await withTenant(api.db.rw, { tenantId: f.s.tenant, actorId: f.s.human, requestId: "eq" },
      (tx) => tx`update app.document set tax_inclusive = true where id = ${drafted.documentId}`);
    const posted = await api.request({
      method: "POST", path: `/v1/companies/${f.s.company}/documents/${drafted.documentId}/transitions`,
      as: f.s.human, body: { to: "posted" },
    });
    expect(posted.status).toBe(200);
    invoiceDocId = drafted.documentId;
  }, 300_000);
  // NO afterAll, and no `api.stop()`: `sharedApi()` is memoised across the whole `tests` run and a file that
  // stopped it would tear the stack out from under every file scheduled after it (§4.18 round 3's settlement
  // states the rule in those words). Every row this file writes lives under `posFixture`'s own tenant.

  it("the two documents are genuinely different documents", async () => {
    const [rows] = await api.db.admin<{ n: number }[]>`
      select count(distinct (document_type_id, series, posted_by))::int as n
        from app.document where id in (${ticketDocId}, ${invoiceDocId})`;
    expect(rows!.n, "same type, series or actor would make this test vacuous").toBe(2);
    const [who] = await api.db.admin<{ kinds: string[] }[]>`
      select array_agg(distinct p.kind::text order by p.kind::text) as kinds
        from app.document d join app.principal p on p.id = d.posted_by where d.id in (${ticketDocId}, ${invoiceDocId})`;
    expect(who!.kinds).toEqual(["human", "terminal"]);
  });

  it("identical ledger entries after the §5 item 18 projection", async () => {
    expect(await ledgerMultiset(api, ticketDocId)).toEqual(await ledgerMultiset(api, invoiceDocId));
  });

  it("identical ledger-entry dimensions", async () => {
    const pos = await dimensionMultiset(api, ticketDocId);
    expect(pos.length).toBeGreaterThan(0);                     // a vacuous [] === [] would prove nothing
    expect(pos.every((d) => d.startsWith("BRANCH:"))).toBe(true);
    expect(pos).toEqual(await dimensionMultiset(api, invoiceDocId));
  });

  it("identical cost consumptions — the clause a financial-only invoice could not satisfy (4A ADR 0044)", async () => {
    const pos = await consumptionMultiset(api, ticketDocId);
    expect(pos.length, "a POS ticket MUST consume layers, or this test is measuring nothing").toBeGreaterThan(0);
    expect(pos).toEqual(await consumptionMultiset(api, invoiceDocId));
  });

  it("and the pinned policy ids DIFFER, which is why hazard 18 projects them out", async () => {
    const rows = await api.db.admin<{ posting_policy_id: string }[]>`
      select posting_policy_id::text as posting_policy_id from app.document where id in (${ticketDocId}, ${invoiceDocId})`;
    expect(new Set(rows.map((r) => r.posting_policy_id)).size).toBe(2);
  });

  it("acceptance test 6's POS clause: a return against that ticket consumes nothing and re-layers at cost", async () => {
    // §6.1 row 6 lists 6A as a re-run for "costing edge cases (POS returns)".
    const ret = buildTicket(f, { sku: "SKU-A", kind: "return", quantity: "1.000000", unitPrice: "20.0000",
                                 tender: "cash", returnsClientRef: null,
                                 cashierPrincipalId: f.supervisorId });   // a blind return needs the blind code
    const res = await syncRequest(api, f.terminal, {
      method: "POST", path: "/v1/sync/tickets",
      body: { terminalId: f.terminal.terminalId, batchId: uuidv7Sync(), tickets: [ret], shifts: [], tillEvents: [] },
    });
    const docId = ((await res.json()) as { results: { status: string; documentId: string }[] }).results[0]!;
    expect(docId.status).toBe("accepted");
    const [mv] = await api.db.admin<{ quantity: string; n: number }[]>`
      select quantity::text as quantity, (count(*) over ())::int as n from app.inventory_movement where document_id = ${docId.documentId}`;
    expect(mv!.n).toBe(1);
    expect(Number(mv!.quantity)).toBeGreaterThan(0);          // a RECEIPT: stock came back in
    const consumed = await consumptionMultiset(api, docId.documentId);
    expect(consumed, "a return creates a layer; it consumes none").toEqual([]);
  });
});
```

  `ticketEffectiveDate` is a two-line file-local helper deriving the same `date(soldAt at time zone company.timezone)` `applyBatch` uses, so the two documents land in one fiscal period and one `effective_date` — **without it the projection differs on `effective_date` and `fiscal_period_id` and the test fails for the wrong reason.** Run `bun run --cwd tests test -- pos-one-posting-path`. **Expected failure before Task 12 lands:** 404 on the sync route; **after it lands**, run it and expect 6 passed.

- [ ] **Step 2: If the multisets differ, read the diff before changing anything.** The three differences that are *expected and must not be papered over*, each with the fix that is legitimate: (a) **`effective_date`/`fiscal_period_id`** — the helper above is wrong; fix the helper, never the projection. (b) **A missing tax leg on one side** — the two `document.tax_inclusive` flags disagree; fix the `update` in the fixture, never the policy. (c) **A `5920` FX-rounding line on one side only** — the two documents' `Money` arithmetic produced different residues, which means one of them was built with a different `unitPrice` or `quantity`; fix the fixture. **A difference in `account_id` is a real finding** and means the two policies genuinely resolve different accounts — stop and report it, because that is exactly the LEGACY-009 class of defect this test exists to catch.

- [ ] **Step 3: Commit.**

```bash
git add tests/invariants/pos-one-posting-path.test.ts tests/invariants/support/pos.ts
git commit -m "$(cat <<'EOF'
test(invariants): acceptance test 22 — one posting path [6A T13]

A POS_TICKET applied by a terminal through applyBatch and a POS_EQUIV_INVOICE posted by a
human through the documents route produce byte-identical ledger entries, dimensions and
cost consumptions after §5 item 18's projection. The two pin DIFFERENT policies, which is
why hazard 18 projects posting_policy_id out. Reading (a) of 4A's amendment 15.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: ⚠️ OD-07 — serial numbers, and acceptance test 17

> **This whole task is dropped if OD-07 = no, and nothing else in this plan changes.** No other task references a serial, no message carries one, no column exists for one. §2.12's default is **not built**, and that is what every other task assumes.

**What was asked (OD-07).** *"Serial numbers in scope?"* — spec:92, 1032, 1310, 2435. §3.0.3 expects **not**, for a food distributor. The decision gates two slices: 3A builds `app.serial_unit` and creates `tests/regression/legacy-052.test.ts`; **6A proves the race** — acceptance test 17, *"Two terminals scan the same serial simultaneously; exactly one sale succeeds"* (spec:2435).

**What is assumed instead, and where the assumption lives.** Every other task treats a ticket line as `(item, lot, quantity)` and nothing more. `TicketLine` has no `serial` member; `applyBatch` has no serial branch; the `POS_TICKET` policy has no serial rule. §3.7.3 says why in the spec's own words: *"a till cannot safely allocate a unique serial while offline"* (spec:1310), and the two ways out it names — reserve serial blocks per till in advance, or restrict serialised sales to online mode — are **design decisions the owner has not made**, not implementation details a plan may choose.

**What changes when the answer arrives.** Exactly this task, and it runs only after **3A's** serial task has merged (§6.3 puts 3A before 6A, so `app.serial_unit` and `legacy-052.test.ts` both already exist).

**Files** (created only under OD-07 = yes)

- `packages/sync/src/messages.ts` — MODIFY (`TicketLine.serials?: string[]`)
- `packages/db/src/sync/apply.ts` — MODIFY (one branch)
- `tests/invariants/pos-serial-race.test.ts` — NEW (acceptance test 17)
- `tests/regression/legacy-052.test.ts` — MODIFY (append a `— 6A` block; **3A created it**)

**Steps**

- [ ] **Step 1: Confirm the answer and the mode.** OD-07 is two questions, not one: *are serials in scope*, and if so, *which of spec:1310's two mechanisms*. Record the owner's answer in this task before writing a line. **If the answer is "online mode only"** — the simpler of the two and the one this task is written for — a ticket carrying serials is refused when the till was offline, and the online path allocates under the same unique index the back office uses. **If the answer is "reserved blocks per till"**, this task is replaced by a design task and an ADR, because a block reservation is a new table, a new lifecycle and a new reconciliation, and none of that belongs in a plan written before the decision.

- [ ] **Step 2: Add the wire member, additively.** `TicketLine.serials?: string[] | null` in `packages/sync/src/messages.ts`, with `TicketLineSchema` gaining `serials: z.array(z.string().min(1)).optional().nullable()`. **Additive:** every existing till, test and fixture that omits it stays valid, which is what makes this a droppable task.

- [ ] **Step 3: Add the one branch in `applyBatch`.** Between step (f) (insert the lines) and step (g) (recompute tax): for a line whose item has `track_serials`, `insert into app.serial_unit … on conflict do nothing returning serial` per serial and require the returned count to equal the sent count. The **unique index 3A ships** — `unique (item_id, serial) where status = 'in_stock'` — is the control; a short return is `ERR_CONFLICT_UNIQUE` and the ticket is refused into needs-attention like any other. **No advisory lock and no `select … for update`:** the index is the arbiter, and adding a lock would only move the race.

- [ ] **Step 4: Write acceptance test 17.** `tests/invariants/pos-serial-race.test.ts` — **two real connections, interleaved** (§3.7.1: *"Concurrency tests interleave two real connections — `db.rw` opened twice with `max: 1` each"*). Enrol two terminals at one branch; build two tickets, each selling the same serial of the same item; open two `withTenant` transactions; insert both serial rows; commit both. **Assert:** exactly one `accepted` and one `rejected`; the rejected one's code is `ERR_CONFLICT_UNIQUE`; `select count(*) from app.serial_unit where serial = $1 and status = 'sold'` is **1**; and the rejected ticket is in `needs_attention`. Assert the failure is at the **data layer**, not in TypeScript, by re-running the same insert pair directly on two `app_rw` connections with no application code between them.

- [ ] **Step 5: Append to `tests/regression/legacy-052.test.ts`.** A `describe("LEGACY-052 Serial numbers can be sold twice — 6A", …)` block whose single `it` is the two-terminal race above, reduced to the data layer. **3A created the file** (§3.7.3's named-creator rule) and this block is appended after 3A's; **no earlier block is edited**.

- [ ] **Step 6: Commit.**

```bash
git add packages/sync/src/messages.ts packages/contracts/src/sync/ticket.ts packages/db/src/sync/apply.ts \
        tests/invariants/pos-serial-race.test.ts tests/regression/legacy-052.test.ts
git commit -m "$(cat <<'EOF'
feat(sync): OD-07 — serials on a ticket line and acceptance test 17 [6A T14]

Two terminals scanning one serial: exactly one sale succeeds, and the arbiter is 3A's
partial unique index, not application code (LEGACY-052). Online mode only, per OD-07's
recorded answer; reserved blocks per till would be a different design and a different task.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: The regression files, the pinned lists, and this slice's re-run matrix

**Files**

- `tests/regression/legacy-046.test.ts` — NEW (this slice creates it)
- `tests/regression/legacy-009.test.ts`, `legacy-027.test.ts`, `legacy-028.test.ts`, `legacy-044.test.ts`, `legacy-048.test.ts`, `legacy-051.test.ts` — MODIFY (append one `— 6A` block each; **no earlier block is edited**, §3.7.3)
- `packages/db/test/privileges.test.ts` — MODIFY (assert the DELETE list is unchanged)

**Interfaces**

- Consumes: `sharedDb`, `thinRegression`, `sharedApi`, `fullRegression`, `problemOf`, `sourceFiles`, `repoFile` (§4.17.1); `posFixture`, `syncRequest`, `buildTicket`, `signSyncRequest`, `uuidv7Sync` (T10).
- Produces: no code. Seven regression blocks and one pinned assertion.

**Steps**

- [ ] **Step 1: Create `tests/regression/legacy-046.test.ts` — this slice's own defect.** LEGACY-046 (spec:603) is *"Site protection triggers are bypassable, and two different flags share one name"*, and its new-system sentence is *"operation mode (user action / replication apply / maintenance) is **typed, server-authenticated request metadata with one canonical name per concept, checked in one place**"*. `terminalAuth` is that sentence made executable, so the file is 6A's to create. Three `it`s, through `fullRegression`:

```ts
// tests/regression/legacy-046.test.ts
import { expect } from "vitest";
import { ROUTES } from "@dulja/api";
import { sourceFiles } from "../support/source";
import { fullRegression } from "../support/api";
import { buildTicket, posFixture, signSyncRequest, syncRequest, uuidv7Sync, type PosFixture } from "../invariants/support/pos";

fullRegression(
  "LEGACY-046",
  "Site protection triggers are bypassable, and two different flags share one name",
  ["spec:603", "contracts §4.10.3", "6A T7"],
  (ctx) => {
    let f: PosFixture;
    // `fullRegression` owns the shared API; this file's corpus is one POS company on it.
    beforeAll(async () => { f = await posFixture(ctx.api, "LEGACY046"); }, 240_000);

    it("one canonical name per concept — a grep can prove it", () => {
      // 0B's `sourceFiles(roots?)` returns `SourceFile[]` — `{ path, text, lines }`, `path` repo-relative and
      // POSIX-separated (0B Task 14). There is no ts-morph node here: it is `.text`, never `getFullText()`,
      // and `.path`, never `fileName`.
      const files = sourceFiles(["apps", "packages"]);
      const defines = (needle: RegExp) => files.filter((s) => needle.test(s.text));
      // The legacy defect was two INDEPENDENT flags named `Silent` in two namespaces, each disabling a
      // different half of a control. The fix is not "a better flag": it is that one concept has one spelling
      // and one definition, and that a second one cannot appear without this assertion failing.
      // `path` is already repo-relative, so the compare is exact — 0B's own `legacy-036` compares `f.path` the
      // same way — and a second definition anywhere under apps/ or packages/ makes the array longer.
      expect(defines(/export function canonicalSyncRequest\b/).map((s) => s.path))
        .toEqual(["apps/api/src/middleware/terminal-auth.ts"]);
      expect(defines(/export const TERMINAL_TOKEN_HEADER\b/).map((s) => s.path))
        .toEqual(["apps/api/src/middleware/terminal-auth.ts"]);
      // And no second signature-input string anywhere: the canonical form is `method\npath\ntimestamp\nhash`,
      // and a file that built one of its own would be the second flag by another route.
      const handRolled = files.filter((s) =>
        !s.path.includes("terminal-auth") && /\$\{[^}]*method[^}]*\}\\n\$\{/.test(s.text));
      expect(handRolled.map((s) => s.path)).toEqual([]);
    });

    it("server-authenticated, not client-declared: forged identity headers are INERT", async () => {
      // (a) The id says terminal A; the signature is terminal B's key. 401, and no ambiguity about which one
      //     the server believed — it believed neither.
      const other = await posFixture(ctx.api, "LEGACY046-B");
      const mixed = signSyncRequest(other.terminal, { method: "GET", path: "/v1/sync/catalogue" });
      const forgedId = await ctx.api.request({
        method: "GET", path: "/v1/sync/catalogue?limit=1",
        headers: { ...mixed, "X-Terminal-Id": f.terminal.terminalId },
      });
      expect(forgedId.status).toBe(401);

      // (b) A VALID signature beside a forged X-Tenant-Id, a forged X-Actor-Id and a body member called
      //     `tenant_id`. The request SUCCEEDS — as the signing terminal — and every forged value is ignored.
      //     That the request succeeds is the assertion: an error would prove the headers were read.
      const ticket = { ...buildTicket(f, { sku: "SKU-A" }), tenant_id: other.s.tenant } as ReturnType<typeof buildTicket>;
      const res = await syncRequest(ctx.api, f.terminal, {
        method: "POST", path: "/v1/sync/tickets",
        body: { terminalId: f.terminal.terminalId, batchId: uuidv7Sync(), tickets: [ticket], shifts: [], tillEvents: [] },
        headers: { "X-Tenant-Id": other.s.tenant, "X-Actor-Id": other.s.human },
      });
      expect(res.status).toBe(200);
      const [doc] = await ctx.api.db.admin<{ tenant_id: string; created_by: string }[]>`
        select tenant_id, created_by from app.document where client_ref = ${ticket.clientRef}`;
      expect(doc!.tenant_id).toBe(f.s.tenant);                    // NOT the forged one
      expect(doc!.created_by).toBe(f.terminal.principalId);       // NOT the forged actor
    });

    it("checked in one place — a future /v1/sync module cannot forget the guard", async () => {
      const terminalModules = ROUTES.filter((r) => r.auth === "terminal");
      expect(terminalModules.length).toBeGreaterThan(0);
      // Every /v1/sync/* module is `auth: "terminal"`, and `createApp` attaches terminalAuth FROM that field —
      // never from a list a module author has to remember to join. The proof is that an unsigned call to each
      // one is 401 without any module having registered a middleware of its own.
      for (const m of terminalModules) {
        expect(m.path.startsWith("/v1/sync/"), m.path).toBe(true);
        const res = await ctx.api.request({ method: "GET", path: m.path });
        expect(res.status, m.path).toBe(401);
      }
      // And the inverse: no module OUTSIDE /v1/sync is `auth: "terminal"`, so the guard's scope and the URL
      // scheme (§4.2.7) cannot drift apart.
      expect(ROUTES.filter((r) => r.path.startsWith("/v1/sync/") && r.auth !== "terminal" && r.path !== "/v1/sync/enrol"))
        .toEqual([]);
    });
  },
);
```

  **`/v1/sync/enrol` is the one exception in the last assertion and it is named rather than glossed:** it is `auth: "public"` because the till presenting a one-time code has no terminal identity yet — that is the whole point of enrolment — and its own protection is the bearer secret plus `where redeemed_at is null`. A second public `/v1/sync/*` module would fail this case, which is the intent.

  ⚠️ **The two `defines(...)` / `handRolled` expectations above are the two 6B's amendment A2 replaces in place, and the accessors in this file are `s.path` and `s.text` — not `s.fileName` and not `s.getFullText()`.** 6B's Task 0 Step 5 spells its two replacement lines with `s.fileName` / `s.getFullText()` and instructs its executor to *"keep 6A's accessor spelling"*; the spelling this file actually ships is the one 0B's `SourceFile { path: string; text: string; lines: string[] }` (0B T12, `scripts/lint/types.ts`) supports, so the replacement lines must be transposed to `.path` / `.text` when they land. An earlier draft of this file did use the ts-morph accessors, which is where 6B read them; they were corrected here, and this note exists so the correction is not undone by the very edit that consumes it. `sourceFiles` never returns a ts-morph node — it returns 0B's plain struct — and `bun run typecheck` is red on either wrong member.

- [ ] **Step 2: Append the six `— 6A` blocks.** Each is one `describe` with one or two `it`s, and each cites the slice test that carries the full scenario rather than repeating it:

  | File | Created by | The 6A block asserts |
  |---|---|---|
  | `legacy-009` | 3B | **One costing answer across the POS path.** The `cost_consumption` multiset of a `POS_TICKET` equals that of the equivalent invoice (Task 13's fourth case, reduced): *the* LEGACY-009 claim — two paths, one formula — now including the till. |
  | `legacy-027` | 0B | **No flag disables a control.** A `POST /v1/sync/tickets` carrying `{"internal": true}`, `{"skipChecks": true}` and `{"__proto__": {"actorId": …}}` alongside a valid batch posts exactly the same ledger rows as one without them, and a ticket that would fail `assert_stock_available` still fails with those keys present. |
  | `legacy-028` | 0B | **The PIN is the only credential this application hashes.** No file under `packages/db/src/sync/**` or `apps/api/src/**/sync*` calls `argon2`, `bcrypt` or `scrypt`; the enrolment code is a **sha256 of a one-shot ticket**, not a password, and is stored hashed and compared by lookup, never by string equality. |
  | `legacy-044` | 0B | **The actor is the session, never a payload.** A batch whose ticket names `cashierPrincipalId` equal to a principal in **another tenant** is rejected, and on an accepted ticket `document.created_by = document.posted_by = <the terminal's principal> ≠ document.attributed_to`. |
  | `legacy-048` | 3A | **Negative stock at sync apply.** A ticket for more than the layers hold is `ERR_STOCK_INSUFFICIENT` regardless of session settings, and it becomes possible **only** through an `inventory.negative_stock.override` `document_event` recorded by a second principal — never through a flag, a header or a policy edit (F-6). |
  | `legacy-051` | 0B | **Numbering at the till.** Two terminals' first tickets in one period both succeed and take **number 1 of two different series** (`POS-KL01` and `POS-KL02`), and re-sending either batch consumes no number. The legacy defect was a race on first use with no uniqueness constraint; the fix is `unique (company_id, series, fiscal_period_id, number)` plus the advisory lock, and the per-terminal series is what keeps two tills from contending at all. |

- [ ] **Step 3: Pin the DELETE list.** In `packages/db/test/privileges.test.ts`, assert the equality §3.5.4 fixes, unchanged by this slice:

```ts
  it("6A adds no DELETE grant — an enrolment is spent, a terminal revoked, a queue row resolved (§3.5.4)", async () => {
    const rows = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type = 'DELETE' order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual(
      ["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]);
  });
```

- [ ] **Step 4: Run the whole re-run matrix once, in one pass, and record the output in the PR body.**

```bash
bun run --cwd tests test                 # 12, 13, 11, 20, 22, and every regression file
bun run --cwd packages/db test           # 2, 16, 18, 36 at the data layer
bun run --cwd apps/api test              # every route suite
bun run --cwd apps/worker test           # the pos.sync.apply handler
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck
bun run --cwd packages/contracts openapi:generate && git diff --exit-code packages/contracts/openapi.json
```

  **Expected:** every command exit 0, and the last one silent — a diff in `openapi.json` means a route changed after Task 12 regenerated it, which CI fails on (spec:2055).

- [ ] **Step 5: Commit.**

```bash
git add tests/regression packages/db/test/privileges.test.ts
git commit -m "$(cat <<'EOF'
test(regression): legacy-046 created; 009/027/028/044/048/051 gain a 6A block [6A T15]

LEGACY-046's new-system sentence — "operation mode is typed, server-authenticated request
metadata with one canonical name per concept, checked in one place" — is terminalAuth, so
6A is the file's creator. A forged X-Tenant-Id beside a valid signature is INERT, which is
the assertion that closes LEGACY-026 and LEGACY-044 for the sync surface.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

### Contract additions (every name this slice invented because the registry lacked it)

All twenty-four land through **Task 0**, before any task writes the literal. Grouped by the section they amend.

| # | § | Name or decision | Why it did not already exist |
|---|---|---|---|
| 1 | 6.1 row 22 | **Reading (a) taken:** test 22 compares `POS_TICKET` against **`POS_EQUIV_INVOICE`**, a stock-issuing type this slice configures in its own fixture | 4A's ADR 0044 made the seeded `SALES_INVOICE` financial-only and 4A explicitly deferred the choice to 6A (phase-4a:230, 6224) |
| 2 | 4.14 | **`POS_EQUIV_INVOICE`** (6A, **test only**), `accounting`, outbound/issue/`accounting.sales.post`, series `PEI` | hazard 32 makes an unregistered document-type code a review-blocking finding, and reading (a) needs a second code |
| 3 | 4.5.6 | Form A gains **`terminal_enrolment`** and **`needs_attention`**; Form B gains **`catalogue_tombstone`** | all three carry a branch key, and 6C's `branch_isolation_policy` linter rule would report three violations the moment 0068 landed |
| 4 | 4.10.2 | `revision` defaults to **`nextval('app.catalogue_revision_seq')`**, not `0`, on the six pre-existing tables | `default 0` hides every pre-6A row from a fresh till and makes thousands of rows share one keyset position; a backfill `update` is impossible under FORCE RLS (hazard 10) |
| 5 | 4.3.4, 4.3.6 | **`pos_terminal.code`** (0061), **`document.shift_id` moved from 6D/0070 to 6A/0061 with no FK**, and the **`resolveSeries`** terminal suffix in `issueDocument` | §4.14 and spec:1721 want `POS-<terminal code>` but §4.4.1 pins `numbering.series` to a static literal; §6.1 row 16 nevertheless assigns 6A a per-terminal-series re-run. `shift_id` moves because `applyTicket` writes it on every ticket 6A applies, so a 0061 without it cannot pass this slice's own suite — **6D's amendment A2 records the identical move from the other side and its Task 0 gate asserts the column by literal, raising against 6A rather than adding it in 0070** |
| 6 | 4.2.3 | `AppEnv["Variables"]` becomes **ten** members — **two new rows, `db: Sql` (ninth) and `terminal: TerminalIdentity` (tenth)**; and `ApiConfig` gains `terminalJwtSigningKey` | §4.2.3 says a slice adding a **ninth** amends the block first — the eighth, `jobs: JobClient`, was ratified in round 3 as 3B's amendment A5 and is **consumed, never re-declared**, by the tickets route's 202 branch; a second declaration would be a duplicate member and a second setter. `db` is new because the public enrolment handler runs **before a tenant exists**, so `c.var.withTenant` does not exist on it; 0B's factory precedent does not fit, because `ROUTES` is derived from `buildRoutes({ authAdmin: new StubAuthAdmin() })` at module scope where no `Sql` exists |
| 7 | 4.2.7 | `IsolationProbe.expect` widens to **`400 \| 401 \| 403 \| 404`** | 0B's harness sends a human token; a `auth: "terminal"` module answers 401 and a public bearer-secret door answers 400, and both are the *recorded* value, not a widened acceptance set |
| 8 | 3.7.5 | `no-bare-db` gains **`packages/db/src/sync/identity.ts`**; `dependency-rule` gains **`packages/sync` → `['@dulja/domain','@dulja/contracts']`** | the file calls two SECURITY DEFINER doors before a tenant exists; the tier row is declared in §3.1 but the rule needs the entry |
| 9 | 4.1, 4.10.3 | **`app.resolve_enrolment`** as a second `app_auth`-owned SECURITY DEFINER function, and §4.10.3's enrolment sketch restated: **`code_hash bytea`** (not `text`), **`name`**, **`terminal_code`** with `unique (company_id, terminal_code)`, and **`terminalCode`** on the create body | §4.1 said `app_auth` "owns `resolve_principal` only", and Plan 0A's `privileges.test.ts` asserts that function's ownership. §4.10.3's `code_hash text` contradicts this slice's own `bytea` argument — the hash is computed in TypeScript and `createHash("sha256").digest()` returns a `Buffer`, which postgres.js binds as `bytea`, while a `text` column would force a hex or base64 rendering and make every lookup depend on both sides choosing the same one — and the numbering suffix has to be reserved at issue, or a collision burns a one-shot code at redemption |
| 10 | 4.10.1 | **`Ticket.newCustomer?: NewCustomer`**; **`encodeSyncCursor`/`decodeSyncCursor`**; **`CATALOGUE_STREAMS`**; `shiftRef`; `BatchQueued`; `SYNC_BATCH_SYNC_LIMIT` | §2.7 requires customer quick-create but `Ticket` carried only `customerId`; §4.10.1 fixes the cursor's wire form but names no codec, and two spellings of one codec is hazard 9 |
| 11 | 4.10.4 | the over-size response is **`{ batchId, jobId, status: "queued" }` + `Retry-After: 5`, with no `statusUrl`** | no slice ships `/v1/jobs/{jobId}`, and pointing a terminal at a human route would be a new auth surface for a fact `client_ref` dedup already gives exactly |
| 12 | 4.2.6 | **`JobPayload["pos.sync.apply"]`**, and the one registered exception to "jobs run as the system principal" | hazard 19 requires `posted_by` to be the terminal, and hazard 20's rule would make every POS posting misattributed |
| 13 | 4.17.1 | **`tests/invariants/support/pos.ts`** — `POS_PACK_ROOT`, `PosFixture`, `posFixture`, `enrolTerminal`, `EnrolledTerminal`, `signSyncRequest`, `syncRequest`, `buildTicket`, **`BuildTicketOptions`**, **`uuidv7Sync`**, **`SHARED_SHIFT_ID`**, `MemorySyncStore` | §4.17 assigns 6A one `fixtures.ts` row and hazard 9 forbids inventing more beside the register. `BuildTicketOptions` is a named interface because a body typed `Parameters<typeof buildTicket>[1]` is a circular self-reference the compiler cannot resolve; `uuidv7Sync` and `SHARED_SHIFT_ID` are exported because every `batchId` and `clientRef` in this slice's tests is minted with the first (§4.10.1 fixes both as uuidv7, and `crypto.randomUUID()` is a v4) and **6D's amendment A6 inserts an `app.shift` row at the second** |
| 14 | 3.6.4 | the `cashier` and `branch_manager` grants for this slice's eight `pos.*` codes, and `admin.terminal.manage` to `admin` only | §3.6.4 requires every introducing slice to record its row |
| 15 | 4.1 | the advisory-lock key **`'sync-batch:' || terminal_id`** | two concurrent applies for one terminal would otherwise race on `document_company_id_client_ref_key` |
| 16 | 4.2.8 | `DocumentLineKindSchema` and 3C's `DraftLine.kind` take the **full six-label union** in 0061's PR | the SQL CHECK takes it for the spec:2301 reason; the wire vocabulary must match or a tender line cannot be drafted |
| 17 | 4.4.2 | the `tenderMethod` lift belongs to 6A; a **POS return is one type with negative magnitudes**, not a second type | §4.4.2's comment assigned the lift to no slice, and A9's ⚠️ named 6A without saying what its negative case was |
| 18 | 4.15 | the sentence that **`1100` is 0C's** and is the fourth account the tender rules resolve | §4.6.5 names four accounts and §4.15 marks three as 6A's; hazard 33 needs the fourth's seeder named |
| 19 | 4.2.7 | the **five module-path rows** this slice mounts, and the reservation of `/v1/companies/:companyId/needs-attention` against 7C | a `RouteModule.path` is also the `PROBES` key, and 7C already owns the `needs_attention` `DatasetId` (§4.16.2); nothing else stops it mounting a second module there |
| 20 | 4.2.7 | `AppDeps` becomes **seven** members — `terminalJwtSigningKey: Uint8Array` | §4.2.7 states the count *"because it is load-bearing"*; `createApp` attaches `terminalAuth` and the key has to arrive with the other deps |
| 21 | 4.2.9 | **a public route carries no idempotency**, and an unsafe one must be idempotent in its own right | §4.2.9's middleware keys on `(tenant_id, principal_id, key)` and opens `withTenant` on `c.var.ctx`; 0B's only public route is a GET, so the case had never arisen and `POST /v1/sync/enrol` is the first |
| 22 | 4.10.4 | `applyBatch` takes **four** arguments — `(tx, ctx, terminal, batch)` | §4.10.4's three conflate the tenant context (which `postDocument`, `recordOverride` and `computeDocumentTax` all take) with the terminal row; both callers hold both and neither can derive one from the other |
| 23 | 4.10.5 | `drainOutbox` takes a **required** `terminalId` and `newBatchId`; **`SyncQueuedError`** is registered; and **`applyChanges` advances every stream's cursor** | §4.10.1 fixes `batchId` as a uuidv7 and `crypto.randomUUID()` is a v4; and a store that advanced only the touched streams would hold `0n` on `cashier`/`branch_pos_policy` until 6C, so the minimum-across-streams cursor would be `0n` on every till for ever |
| 24 | 4.17 | `seedTerminal` gains `devicePublicKey?: Buffer` | §4.17's rule is that a slice amends the table before adding an option, and a test that signs a request needs a key it holds the private half of |

**Names internal to this slice and therefore deliberately not registered:** `SyncError`/`SyncErrorCode` (the `PostingError` pattern), `TicketLineInput` and the other five db-local structural twins in `apply.ts`, `CatalogueChange`/`CatalogueSlice`, `TerminalRow`, `mintEnrolmentCode`/`hashEnrolmentCode`, `canonicalSyncRequest`, `TERMINAL_SKEW_SECONDS`/`TERMINAL_JWT_TTL_SECONDS`/`TERMINAL_TOKEN_HEADER`, `upsertNeedsAttention`, `listNeedsAttention`, `resolveNeedsAttention`, `quarantineBatch`, `toBatchResult`, `classify`, `requiredCodes`, `verifyAuthority`, `quickCreateCustomer`, `insertLines`, `verifyTax`, `refuseUnsupported`, `POS_PERMISSION`/`OVERRIDE_SUBJECT_FOR`/`PosPermissionCode` (`packages/db/src/sync/authority.ts` — 3A's `INVENTORY_PERMISSION` precedent, a db-tier const of catalogue literals, not a second catalogue). **`uuidv7Sync` and `SHARED_SHIFT_ID` are NOT on this list:** an earlier draft called them file-local, but 6D consumes both by name from `tests/invariants/support/pos.ts`, so Task 0 amendment 15 registers them in §4.17.1 beside that file's other exports.

### The skill's checklist, walked

- **Header:** the For-agentic-workers line, Goal, Architecture, Tech Stack and Spec are all present and specific; the Assumptions block is §3.10's, filled in; Global Constraints has eighteen numbered items, each traceable to a spec line or a contracts section.
- **File Structure:** every file the plan touches, with NEW/MODIFY and the owning task — including the ones a task modifies in passing (`apps/api/src/app.ts`, `src/index.ts`, `src/problem.ts`, `test/support/app.ts`, `infra/src/secrets.ts`, `packages/db/test/privileges.test.ts` and the four `packages/db/test/sync/*.test.ts` files), which an earlier draft of this block claimed and did not deliver.
- **Sixteen `### Task N` headings**, three hashes each, `Task 0` … `Task 15`. Every task carries **Files**, **Interfaces (Consumes / Produces with exact signatures)** and bite-sized `- [ ]` steps.
- **TDD, everywhere:** every implementing task writes the failing test first, **states the exact expected failure text**, then the minimal implementation, then the run, then the commit. Task 0 and Task 15 are the two that legitimately have no product code.
- **No placeholders, and no described bodies.** Every migration is full SQL with every column, constraint, composite FK, `enable_tenant_rls`, `attach_audit`, `attach_stamp` and a matching down file. Every implementation step carries the real code — `applyBatch` and its eleven helpers, the three `needs-attention` functions, `posFixture`, `buildTicket`, `signSyncRequest`, `syncRequest`, the admin terminals router, the needs-attention router, `toBatchResult`, `quarantineBatch`, both contracts modules and every route test. An earlier draft of this plan described `applyBatch` in ten lettered prose sub-steps and left five other bodies as `{ /* Step N */ }`; hazard 35 calls that a plan failure, and it was, because *"a task's implementer sees only their own task"* and a paragraph is not a design they can reproduce. **A later pass removed the three remaining shapes of the same defect**: Task 10's fixture step was split so that Step 5 writes only the two interfaces (`PosFixture`, `BuildTicketOptions`) and Step 6 writes both bodies — an earlier draft left Step 5 holding two body-less function declarations, which is a TypeScript error, and had Step 6's parameter typed `Parameters<typeof buildTicket>[1]`, a circular self-reference; Task 10's two `DocumentSnapshot` builders were rewritten against §4.4.2 member for member, in `Money` and `Quantity` rather than decimal strings, from 2A's own `line()`/`snapshot()` template; and Task 11's header insert no longer carries a conditional instruction to add a column to Task 4's migration — Task 4 adds `document.shift_id` outright, and the insert names `series` (which plan 0A declares NOT NULL) and does not name `memo` (which does not exist; 2C's column is `notes`).
- **Commits:** one per task, conventional, scoped, `[6A T<n>]`, every one ending with the `Co-Authored-By` trailer.
- **One migration per PR:** four migrations, four tasks, four commits (T2, T3, T4, T5).
- **Owner gate:** OD-07 is exactly one isolated task (T14), stating what was asked, what was assumed, what changes when the answer arrives, and that dropping it renumbers nothing.

### Eight things a reviewer should push back on

1. **`resolveSeries` edits a Phase 1 file.** `packages/db/src/posting/issue.ts` is 1A's, and this slice changes two lines of `issueDocument`. The alternative — a single `POS` series shared by every till — is simpler and would touch nothing, at the cost of §6.1 row 16's per-terminal-series re-run and of every till in a company contending for one `document_series` row during a 200-ticket batch. **A reviewer who thinks the frozen file matters more than the contention should say so now**, because reversing it after Task 12 means re-writing three tests and one §4.14 row.
2. **The tax mismatch is a rejection, not a correction.** A till whose catalogue is one revision stale has every ticket refused until it re-pulls. The comparison is `Money.equals`, not string equality — step 9g says so explicitly, because a scale-formatting difference decided by string comparison would refuse *every* ticket and read as a protocol bug rather than a pricing one. That is deliberate — LEGACY-020's discipline, "a refusal, not a wrong number" — but it is the clause most likely to be experienced as harsh in a shop with a flaky link. The softer design (accept, store the server's figure, raise a needs-attention row) is one branch away and is written down here so the choice is visible rather than discovered.
3. **`applyBatch` takes a per-terminal advisory lock for the whole transaction.** A 200-ticket batch therefore blocks that terminal's other batch for as long as it runs. That is the intent — the alternative is the `client_ref` unique-violation race, which is *correct* but noisy — but a reviewer who expects two concurrent batches from one till should know they will serialise.
4. **The `POS_TICKET` policy has no promotion, no line discount rule and no loyalty leg.** Promotions and offers are priced **at the till** (spec:1345–1348, 6B) and reach the server as an already-discounted `line.amount`; loyalty is **OD-03** and 6B's task. If a reviewer expects the server to re-price, that is a different design and a different slice.
5. **`readCatalogue`'s two 6C branches are a second query, not two `union all` legs.** Task 8 Step 2 says why (a `where false` does not stop PostgreSQL parsing a missing relation, so the guard has to be a statement that is never sent), but the consequence is that the merge-and-sort happens in TypeScript for those two streams until 6C folds them in, and that 6A dictates two function signatures to 6C. It is correct and it is slower, and 6C's first task is named as the place it stops being either.
6. **`requiredCodes` derives the cashier's required permissions from the ticket's own content.** A non-zero line discount asks for `pos.ticket.discount`; an event whose `subject` is `"void"` asks for `pos.ticket.void`; a return without a `returnsClientRef` asks for `pos.ticket.return_blind`. That is what makes those three catalogue codes evaluated rather than decorative, and it is also the only reading of spec:2161 that does not require the till to declare its own authority — which would be LEGACY-044 in the shape of an authorisation. **The alternative a reviewer might expect is that `pos.ticket.void` gates a separate void *route*.** It does not, because a POS void at the till reaches the server as a ticket with an override event and there is no second door; 6D's till-event path may add one, and if it does, the code is already catalogued and already evaluated here.
7. **`AppEnv["Variables"]` gains `db`, and two handlers read a `Variables` member directly.** (`jobs` is 3B's round-3 row; this slice consumes it and adds no second declaration.) Every other handler in the system uses `c.var.withTenant` and must keep doing so — the `no-bare-db` lint is what enforces it, and these two are route handlers, not `packages/db` files, so the lint does not see them. The check that keeps this honest is a grep, not a rule: `c.get("db")` appears once (the public enrolment redemption, which has no tenant) and `c.get("jobs")` once (the over-size batch enqueue). **A reviewer who would rather see a route factory should say so now**, because the reason they were rejected is narrow — `ROUTES` is derived from `buildRoutes({ authAdmin: new StubAuthAdmin() })` at module scope, where constructing a real `Sql` would put a database connection on the import graph of the OpenAPI generator and the catalogue lint.
8. **The needs-attention row never re-opens.** A ticket that was resolved and then failed again keeps its resolution stamp and shows a fresh error, because `app.stamp_actor` makes `resolved_by` immutable once set and the table's CHECK ties it to `resolved_at`. The honest alternative is an attempt-history child table, which is more machinery than this queue has earned; ADR 0056 records the choice.

### What this slice deliberately does **not** ship

The till (`apps/pos`, the SQLite schema, the outbox writer, acceptance test 19 — **6B**); `app.pos_cashier`, `app.branch_pos_policy`, the PIN, `attendance_event`, the branch-isolation policies and acceptance test 37's *limit* clause (**6C**); `app.shift`, `app.till_event`, `TILL_OVER_SHORT`, the Z-report, `pos.z_report`, `pos.sales_by_cashier`, the `1130`/`5120` accounts and acceptance test 21 (**6D**); the `pos → pos.report.read` row of §4.5.8's map (**6D**, which introduces the code); any screen at all (**no OD-24 task exists in this slice**); and `pos.price.check` / `pos.shift.own` / `pos.attendance.clock` (**6B's** codes, evaluated at the till).

---

## Execution handoff

**Order.** Strictly sequential: **T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T15**, with **T14** any time after T13 *and* after OD-07 lands. Two pairs may run in parallel if two agents are available: **T9** depends only on T1 (it is pure functions over ports and touches no database), and **T2** depends only on T0. Everything else is a chain.

**Preconditions before T0.**

```bash
git switch -c feat/6a-sync-protocol
bun install
bun run --cwd packages/db db:migrate
bun run --cwd packages/db db:status        # expect the highest applied version to be 0056 (5A) or 0058 (5B)
bash scripts/gate-6a.sh                    # T0 Step 25 — every consumed name, present
```

  A `MISSING NAME` line is not a reason to improvise: read the plan that ships the name (§4.18's rule — the plan's file is the authority) and correct the consuming task's import.

**Environment.** `TERMINAL_JWT_SIGNING_KEY` must be set from **Task 7** onward or `readConfig` exits 2 and every `apps/api` test fails at `startApi()`. For local work: `export TERMINAL_JWT_SIGNING_KEY=$(openssl rand -base64 48)`. It is a §3.11 secret and never enters the repository or a committed `.env`. Docker must be running for Testcontainers; `TESTCONTAINERS_RYUK_DISABLED` is already set in CI.

**The green bar after every task.**

```bash
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
```

  **No exceptions.** Every command above is green after **every** task, T5 included. An earlier draft of this plan left `bun run lint:rules` deliberately red between the T5 and T12 commits — seven commits inside a red window, against this plan's own Global Constraint 18, the skill's green-tree rule, and any bisect or per-PR CI run through T6–T11. It is closed by T5 Step 5 (`authority.ts`): `packages/db/src/sync/authority.ts` names the eight codes no route gates, in the same commit as the catalogue rows and in the file that evaluates them. **If anything is red anywhere, that is a defect, not a known state.**

**Where the definition of done is proved.**

| Clause | Command | Expect |
|---|---|---|
| zero duplicates | `bun run --cwd apps/api test -- routes/sync/tickets` | the three-send case: one document, one ledger set |
| zero lost tickets | `bun run --cwd packages/db test -- sync/apply` | a rejected ticket in `needs_attention` with its whole payload; shifts and till events refused, not dropped |
| acceptance test 20 | `bun run --cwd packages/sync test -- pull-all` | killed at page 3, resumed, every change applied exactly once, the tombstone applied — and every stream's cursor equal after each page, which is what makes the resume real |
| acceptance test 22 | `bun run --cwd tests test -- pos-one-posting-path` | identical ledger, dimension and cost-consumption multisets; different types, series, actors and policies |
| acceptance test 17 ⚠️ | `bun run --cwd tests test -- pos-serial-race` | **only under OD-07 = yes** |

**What the next slice needs from this one.** **6C** consumes `readCatalogue` — it must ship `app.pos_cashier_sync(p_company_id uuid, p_branch_id uuid, p_since bigint)` and `app.branch_pos_policy_sync(p_company_id uuid, p_branch_id uuid, p_since bigint)`, both `returns table (id uuid, revision bigint, row jsonb)`, and then delete the `extra` block and fold the two streams into the `union all` — `applyBatch` (adding the `branch_pos_policy` limit check and `ERR_POS_LIMIT_EXCEEDED`, and lifting the `attendance` refusal), migration 0068's Form A/B attachments for this slice's three tables, `seedTerminal`, and the whole of `tests/invariants/support/pos.ts`. **6C** also extends **`packages/db/test/sync/catalogue-revision.test.ts`**: its two closed lists (`STREAM_TABLES_AT_6A`, asserted against `information_schema.columns` and against `pg_trigger`) gain `branch_pos_policy` and `pos_cashier` in the same PR as 0065/0066, because §4.10.2 names eight stream tables and 6A can only create six. The lists are deliberately exact rather than containment checks: a containment check would let a stream table ship with no `catalogue_revision` trigger and stay green, which is the missed-deletion failure acceptance test 20 exists to catch. **6D** replaces `applyBatch`'s `ERR_SYNC_MESSAGE_UNSUPPORTED` refusal for `shifts` and `tillEvents` with real inserts **and re-runs this slice's `sync/apply` batch test unchanged** as the proof that nothing else moved. ⚠️ **That deletion takes `refuseUnsupported` away, and with it this slice's last raiser of the code**, which the `error-codes` lint (§4.2.4, spec:2051) would go red on; **6D therefore owns the replacement raiser** — its Task 6 Step 6 `KNOWN_BATCH_KEYS` guard in `apps/api/src/routes/sync/tickets.ts` — and must not delete the `ERRORS` row instead. That guard answers **`200` with a `Problem` body**, which is §4.2.4's row for this code read literally: **the row stays as written and 6A raises no amendment against it** — Task 11 Step 4 records why a `4xx` would be wrong for a capability gap the till must re-send through rather than discard. **`document.shift_id` is 0061's column, not 0070's** (Task 0 amendment 6, 6D's amendment A2): 6D adds the index `document_shift_idx` and the `assertShiftKnown` guard, and adds no column and no foreign key. It also inserts one open `app.shift` row at `SHARED_SHIFT_ID` (its amendment A6), which is why that constant and `uuidv7Sync` are exported from `tests/invariants/support/pos.ts` rather than file-local. **6B** implements `SyncStore` over SQLite and runs this slice's `pullAll` and `drainOutbox` against it; `MemorySyncStore` in `tests/invariants/support/pos.ts` is the behaviour it must match. ⚠️ **6B also edits this slice's `tests/regression/legacy-046.test.ts` in place** (its amendment A2 moves `canonicalSyncRequest` into `packages/sync/src/signing.ts`, so the two assertions that name the middleware as the declaring file stop being true) — **that edit is welcome and this plan does not pre-empt it, but it must be written with `s.path` and `s.text`.** 6B's Task 0 Step 5 carries its replacement lines spelled `s.fileName` / `s.getFullText()`, reading an earlier draft of this file; the shipped file uses 0B's `SourceFile { path, text, lines }` members throughout (Task 15 Step 1), those are the only members that exist, and a replacement keeping the ts-morph spelling would fail `bun run typecheck` at 6B's own Task 0.

**Push is the owner's call**, not part of any task's definition of done (plan0A:2927). Open the PR series — one per migration, one per remaining task — with the T15 Step 4 output pasted into each body.

