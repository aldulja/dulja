# Dulja Phase 5A — Tax engine, Malaysia jurisdiction pack, returns

**Execution record — 2026-10-02:** The owner authorized this plan's documented defaults and best-practice choices for missing inputs. The implementation uses the synthetic regime and Task 10's provenance/default path, with the conditional statutory steps deferred, and the separately approved Task 12 default workflow. The complete task checklist and verification evidence live in [the Phase 5 exit review](../../review/2026-09-05-phase-5-exit.md) and [implementation report](../../reports/phase-5.md). The task text below remains the implementation specification; its sample commands are not proof of execution.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the whole Phase 5 definition of done — *"The return is generated, validated and reconciled end-to-end against a golden fixture"* — by shipping the four pieces LEGACY-020 says the legacy system never had. (1) A **pure tax engine** in `packages/domain/src/tax/`: versioned regimes with rate-effective-date tables, every tax code declaring its regime, inclusive and exclusive bases, one rounding function with a mode declared **per tax code**, and a wrong-regime refusal that raises `ERR_TAX_REGIME_MISMATCH` instead of producing a wrong number. (2) The four tables §4.9.2 pins — `app.tax_regime`, `app.tax_code`, the append-only `app.tax_transaction` written **only** by the posting service at step 11, and `app.tax_return` — plus `document_line.tax_code_id` and the `document.tax_inclusive` header field. (3) The **Malaysia jurisdiction pack** as seed data under `packages/db/seed/my/tax/`, applied by a new `--only tax` loader, linking its codes to the two account codes this slice seeds (`2300` output tax payable, `1350` input tax receivable) — with **no published Malaysian rate, code name, box name or threshold anywhere in it**: the shipped regime is the clearly-synthetic `SYNTH-MY-v1`, and the verified one arrives through **OD-15** as a reviewed seed PR under ADR 0049. (4) **Return generation from `tax_transaction` and nothing else**, byte-identical across runs against `tests/golden/tax/`, with the generated boxes tying to `account_balance` on `2300` and `1350` to the cent — acceptance test **26**.

**Architecture:** Three seams, and none of them is a new posting path. (1) **The engine is pure and the jurisdiction pack is data-shaped.** `packages/domain/src/tax/` imports `decimal.js` through `@dulja/domain`'s own money module and nothing else — no database, no clock, no network — which is what makes `tests/golden/tax/` byte-comparable (spec:2264) and what makes LEGACY-020 unrepeatable: there is one rate source (`app.tax_code`, seeded from a reviewed file), one rounding call (`Money.multiply` with the code's declared `RoundingMode`), and one regime discriminator that every code carries. `malaysiaPack` holds **regime definitions keyed `(code, version)`** carrying their box layout; `buildReturn` matches the database's `TaxRegime` row to a definition by that pair and refuses an unknown pair — a regime the pack does not know *is* a mismatch. (2) **Tax is computed at persist time, once** (spec:2228). `packages/db/src/tax/compute.ts` runs inside 1A's `PUT …/documents/{documentId}/lines` and `POST …/documents` handlers, resolves each line's code, calls the pure engine and writes `document_line.tax_amount` / `total_incl_tax`. The evaluator then reads those stored columns — 2A already ships `each_tax` grouping and `PostingPlan.taxLines` in full — so draft and post can never disagree, provided `compute.ts` resolves `policy.tax.inclusive` with the **same one-line rule** the evaluator uses. (3) **`app.tax_transaction` has exactly one writer**: `packages/db/src/posting/tax.ts`, called from `post.ts` at step 11, inserting `plan.taxLines` with their **signed** magnitudes (A9's one exception) and their base twins from `toBase`. Returns read that table and never a document. **This slice adds two route modules** (`tax-codes`, `tax-returns`) and therefore exactly two `PROBES` keys.

**Tech Stack:** Bun 1.4 (install, scripts, the API entrypoint) · Node 24 LTS (runs Vitest) · TypeScript strict · PostgreSQL 18 (Testcontainers `postgres:18`) · `postgres` (postgres.js) tagged templates for every write and every read · Drizzle ORM mirrors for typed reads and as the migration diff source (ADR-0002) · Hono + `@hono/zod-openapi` · Zod · `decimal.js` behind `@dulja/domain`'s `Money` · Ajv (already in `packages/domain` from 1A) for the two new pack schemas · React 19 + `@dulja/ui` + i18next (the OD-24 screen) · Vitest + Testcontainers · Playwright (the both-directions re-run of test 23) · oxlint + oxfmt · Turborepo. No package version appears in any source file — the lockfile owns versions (spec:104).

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §0.2 the never/always lists (spec:97–108), §3.0.3 the **Malaysian tax + e-invoicing** row (spec:1027), §3.3 the entity map's `TaxTransaction ── TaxReturn (pluggable jurisdiction packs)` line (spec:1199), §3.5 country seed-data packs (spec:1242), §3.8 the posting-policy `tax` block and the `each_tax` line of the worked example (spec:2017, 2022), §3.9 Enumerations, Money, Time, Deletion and Error codes (spec:2037–2053), §4.2.1 `accounting.tax.manage` / `accounting.tax.file` and the `accountant` row (spec:2147, 2157), §4.7 the tax-engine and rounding bullets (spec:2227–2228) and the e-invoicing bullet's ⚠️ (spec:2225–2226), §4.11 engineering practice and golden-file tests (spec:2258–2267), §5.0 bootstrap step 5 (spec:2001), §5.2 `packages/domain` and `tests/golden/` (spec:2352–2389), §5.3 the "Phase 5" owner row (spec:2405), Part V the Phase 5 row (spec:2291), Part VI test **26** (spec:2444), Part VII **#3** (spec:2463), Part I **LEGACY-011** (spec:311 — the VAT half), **LEGACY-019** (spec:381), **LEGACY-020** (spec:388), **LEGACY-058** (spec:708), **LEGACY-059** (spec:713).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 5A — Tax engine, Malaysia jurisdiction pack, returns. **Phase:** 5. **Phase gate:** this plan starts only when **4A** and **4B** are merged and Phase 4's definition of done is green in CI (spec:87) — both of its sentences, which 4B owns.
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.forbid_change`, `app.stamp_actor`. **0B** — `createDb`, the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `AppError`, `ERRORS`, `ErrCode`, `Problem`, `fromDatabaseError`, `createLogger`, `PERMISSION`, `PermissionCode`, `PERMISSIONS`, `PermissionDef`, `SliceId`, `requirePermission`, `assertRouteGates`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `createApp`, `AppDeps`, `AppEnv`, `startApi`, `TEST_ISSUER`, `ApiRequest`, `StartedApi`, `PROBES`, `IsolationProbe`, `encodeCursor`, `decodeCursor`, `Cursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `CurrencySchema`, `RateSchema`, `ProblemSchema`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `sourceFiles`, `REPO_ROOT`, `repoFile`. **0D** — `Money`, `currency`, `CurrencyCode`, `round`, `RoundingMode`, `toBase`, `UNIT_RATE`, `ExchangeRate`, `MONEY_SCALE`, `RATE_SCALE`, `JobClient`, `startWorker`, `seedBranch`, `seedCurrency`, `seedRate`, `ROLES`, `INCOMPATIBLE_PAIRS`. **0C** — the seed CLI, `PackLoader`, `LoaderContext`, `SeedConfig`, `SeedError`, `readPackFile`, `assertPackShape`, `SubPack`, `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES`, `OWNED_ELSEWHERE`, the `0c-base.json` chart rows. **0E** — `packages/ui`, `packages/i18n`, `MoneyJson`, `bootLocalStack`, `grantAdminRole`, ADR 0016. **1A** — `postDocument`, `issueDocument`, `loadSnapshot`, `resolvePolicy`, `reverseDocument`, `PostResult`, `PostingError`, `PostingErrorCode`, `insertLedger`, `app.posting_seq`, `document.posting_seq`, `documentRoutes`, `CreateDocumentBody`, `ReplaceLinesBody`, `DocumentSchema`, `DocumentLineSchema`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount`, `JOURNAL_POLICY_V1`, `loadDocumentTypes`, `documentTypesLoader`, `posting-policy.schema.json`, `document-type-seed.schema.json`, `policy:types`. **1B** — `trialBalance`, `accountLedger`, `postJournal`, `reportsRoutes`, `reportsRouteModule`, `ReportCodeSchema`, `registerProjectionCheck`. **2A** — `evaluatePolicy`, `balanceInBase`, `parsePolicy`, `validatePolicy`, `validateDocumentTypeSeed`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, **`PlannedTaxLine`**, `PostingPlan`, `TaxCodeRef`, `PolicyEvaluationError`, `requireDocumentPermission`, `DocumentStage`, `DOCUMENT_STAGE_CODES`, `POLICY_RESOLVED_CODES`, `seedParty`, `seedDocumentType`, `DocumentLineInput`, `DocumentTypeModuleSchema`, `app.party`, `document_type.module`. **2B** — `transitionDocument`, `setEventContext`, `grantCodes`, `app.principal_has`, `app.effective_policy`, `app.document_event`. **2C** — `MODULE_READ_CODE`, `requireDocumentModuleRead`, `app.attachment`, `pdfText`, `readPackText`, `SUB_PACK_DIRECTORIES`, `templatesLoader`. **3A** — `app.item` (with its four account columns), `app.warehouse`, `seedItem`, `seedUnit`, `seedWarehouse`. **3B** — `applyMovements` (full body), `company.costing_method`, `ensureOpenPeriods`, `postInventoryDocument`, `recordingJobs`. **3C** — `app.document_link`, `draftTypedDocument`, `DraftLine`, the `2150` chart row. **3D** — `secondPrincipal`, the `1250` chart row. **4A** — `app.payment_term`, `app.allocation`, `allocateSettlement`, `openBalance`, `partyBalance`, the six document-type envelopes `SALES_INVOICE`, `SALES_CREDIT_NOTE`, `PURCHASE_INVOICE`, `PURCHASE_CREDIT_NOTE`, `RECEIPT`, `PAYMENT`, `seedPaymentTerm`, and **`packages/db/test/ar-ap/_support.ts`'s `PACK_ROOT`, `loadTypesFromPack`, `accountByCode`**. **4B** — `ageingRows`, `ageingTieOut`, `settleWithFx`, `registerReconcilableSource`, `arApFixture`, `seedTypeFromPack`, `postFromPack` (**`packApproval` is 4B-internal to it and this slice never calls it**), **`PACK_DIR`** (the `tests/invariants/support/ar-ap.ts` one — **`PACK_DIR` and NOT `PACK_ROOT`**, by 4B's own amendment 9, which registers the name and says in terms it is "named `PACK_DIR` and **not** `PACK_ROOT`" (phase-4b:253): 4A's `PACK_ROOT` above is the **relative** `"seed/my"` that `readPackFile` takes as its first argument, 4B's `PACK_DIR` is an **absolute** directory with a trailing separator consumed by a bare `readFileSync` concatenation and a `readdirSync` glob, and the two shapes are not interchangeable — substituting either for the other fails as a missing file at run time, not as a type error. **This slice imports neither**: `tests/invariants/support/tax.ts` resolves its own `TAX_PACK_ROOT` from `import.meta.url` because `tests/` resolves neither of the other two relatively, and this slice takes only `seedTypeFromPack`, `postFromPack` and `arApFixture` from 4B's file), the `FX_REVALUATION` envelope.

  ⚠️ **4A's plan explicitly hands this slice one edit and names it**: "`tax: { "applies": false }` and no `each_tax` rule at 4A … **5A adds the `each_tax` credit leg and flips `applies` in a policy `version: 2`**" (phase-4a:2762). That sentence is the contract for Task 8's four envelope upserts, and it is the reason this slice registers **no document-type code of its own**. Where a 4A or 4B name in the list above differs from the written plan, **that plan's file is the authority** (§4.18's rule) and **Task 0's gate script is what discovers the difference before any code is written**.
- **Migration numbers:** **0053–0056**, four files, four PRs (§3.4.3 "one migration per PR"), each with a hand-written `NNNN.down.sql`:
  - `0053_create_tax_regime_code.sql` (**T1**) — `app.tax_regime` and `app.tax_code`.
  - `0054_create_tax_transaction_return_and_document_tax_inclusive.sql` (**T2**) — `app.tax_transaction` (immutable, audit-exempt), `app.tax_return`, and the `document.tax_inclusive` header column §4.3.4 assigns to **0054**. **The name is longer than the §2.6 card's `0054_create_tax_transaction_return.sql` because the file also alters `app.document`, and §3.4.2's round-2 rule — "a file whose name understates what it does is renamed, not left" — binds the card's expected name.** 2A's `0018_alter_document_party_fk_and_document_type_module.sql` is the precedent.
  - `0055_alter_document_line_add_tax_fk.sql` (**T3**) — the `(tenant_id, tax_code_id) → app.tax_code` composite FK §4.3.4 assigns to 0055.
  - `0056_seed_permission_phase5a.sql` (**T4**) — the one code `accounting.tax.manage`.

  **ADR numbers:** 0049–0050, both written **as a proposal and asked before implementing** (spec:95 — both touch the data model and one touches money semantics): **0049** *The verified LHDN return format* (**T10**, the OD-15 gate — the ADR is created `proposed` and empty of any figure until the owner's material arrives); **0050** *One tax computation at persist time; `tax_regime.source` as the provenance column* (T1, T5, T7).
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `currency`, `round`, `RoundingMode`, `toBase`, `MONEY_SCALE`, `RATE_SCALE`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`, `createDb`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`, the middleware order), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`, `PostingError` — and `ERR_TAX_REGIME_MISMATCH`, this slice's one registry row), §4.2.5 (`PERMISSION`, `requirePermission`, `ScopeSource`, `ROLES`, `INCOMPATIBLE_PAIRS`, `assertRouteGates`), §4.2.7 (`RouteModule`, `buildRoutes`, `IdempotencyHeader`, `createApp`, `PROBES`, `TENANT_FREE`), §4.2.8 (the common schemas, the list envelope, the cursor codec, **the one list-filter convention — literal `filter[…]` keys, the Layer 2 default**), §4.2.9 (`idempotency`, `RECLAIM_AFTER_SECONDS`), §4.2.12 (`startApi`, `ApiRequest`, `StartedApi`), §4.2.13 (`PackLoader`, `LoaderContext`, `readPackFile`, `assertPackShape`, `SubPack`, `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES`, the four exit codes), §4.3.1 (`postDocument`, `loadSnapshot`, `resolvePolicy`, `PostResult`), §4.3.2 (the fixed algorithm — **steps 6, 8, 10, 11, 12**), §4.3.4 (`document_line` and its 5A row, the `document` header additions and its 5A row), §4.3.5 (`posting_seq`), §4.3.7 (the seed envelope, `loadDocumentTypes`, the two-numbers-one-word paragraph), §4.4.1 (`posting-policy.schema.json` — consumed **unchanged**, same `$id`, same `"version": 1`; the `tax` block, `each_tax`, `tax_code.output_account` / `tax_code.input_account`, `amountRef` `tax.amount`), §4.4.2 (`evaluatePolicy`, `DocumentSnapshot`, `LineSnapshot`, `TaxCodeRef`, `PlannedTaxLine`, **sign normalisation A9 and its one exception**), §4.5.1 (legal transitions), §4.5.4 (`requireDocumentPermission`), §4.6.1 (the register rows for `tax_regime`, `tax_code`, `tax_transaction`, `tax_return`), §4.9.1 and §4.9.2 **in full**, §4.9.3 (only for the `hash` sentence Task 5's canonicaliser must satisfy), §4.14 (document-type codes — consumed, none added), §4.15 (account codes — **`2300` and `1350` are this slice's two rows**), §4.16.1 (consulted to establish that `accounting.tax_return_view` is **7C's** and this slice ships no `ReportCode`), §4.16.2 (`tax_transaction` is already in 7A's ≤ 0058 `DatasetId` set — this slice adds no member and never edits that file), §4.17 (`seedTaxCode` — this slice's one row), §4.17.1, §5 (all thirty-five hazards), §6.1 row 26, §6.2 row 1046.
- **Interfaces produced:** §4.9.1 in full (`TaxRegime`, `TaxCodeDef`, `TaxLineInput`, `TaxLineResult`, `TaxEngine`, `ReturnBox`, `JurisdictionPack`, `malaysiaPack`, and the `TaxTransactionRow` §4 leaves open as 5A's own); §4.9.2 in full (`app.tax_regime`, `app.tax_code`, `app.tax_transaction`, `app.tax_return`); §4.3.4's 5A rows (`document_line.tax_code_id` FK in 0055, `document.tax_inclusive` in 0054); §3.6.2's one code `accounting.tax.manage`; §4.2.4's `ERR_TAX_REGIME_MISMATCH`; §4.15's `2300` and `1350`; §4.17's `seedTaxCode`; §4.2.13's `tax` sub-pack loader. Everything else is listed under **Contract additions** in the Self-Review and lands through **Task 0**.
- **Owner decisions:** **OD-15** (LHDN MyInvois credentials and the current requirement set — spec:92, 982, 2226, 2405, 2467; Part VII #3) → **Task 10**, isolated, and **nothing else in this plan is gated on it**. §2.6's card scopes 5A's half precisely: *"'current requirement set' for the **return** format is verified from the authority's own documentation before the return task"*. The default written into every other task is §2.12's — **abstract interface only** — realised here as the synthetic `SYNTH-MY-v1` regime definition, which is a complete, testable jurisdiction pack that names no published figure. Task 10 adds the verified definition beside it and changes no signature. **OD-24** (screenshots + a two-minute operator description before any screen) → **Task 12**, isolated; default: the screen task is blocked, the slice is not.
- **Part VI tests owned / re-run:** **owns 26** (tax return determinism — Task 9; 5B re-runs it with e-invoicing hooks on). **Re-runs:** **15** (new document type, zero code — Task 8 flips the `tax` block of four *configured* types through a seed PR and no TypeScript change), **12**, **13** and **36** (tenant isolation, audit completeness and the permission catalogue over this slice's four tables, one code and two route modules — Tasks 1, 2, 4, 8 and 11), **27** (no SQL text across the API — Task 11), **1** and **2** are untouched by this slice and are not re-run. **§3.0.4 rows owned:** spec:**1046** Tax — the "Malaysia pack, returns" half; 5B completes the "e-invoicing hooks" clause. **Regression files created / appended:** **creates** `tests/regression/legacy-020.test.ts`, `legacy-058.test.ts`, `legacy-059.test.ts` (Task 11 — none of the three is in 0B's Plan 0A-proven or structural list, and no earlier slice touches them). **Appends** a `— 5A` block to `tests/regression/legacy-011.test.ts` (the VAT-box half) and `legacy-019.test.ts` (rounding per tax code); both are 0B's thin files and this slice never edits an earlier block.
- **Shared namespaces this slice writes into:** **document-type codes (§4.14) — none, and no test-only code either.** Every type this slice's tests configure is a **4A envelope read off disk** through 4B's `seedTypeFromPack`, and Task 8's four upserts change the `policy` member of files 4A already shipped, at `policyVersion: 2`. **Account codes (§4.15) — two, both this slice's own rows: `2300` Output tax payable (liability) and `1350` Input tax receivable (asset)**, shipped as `packages/db/seed/my/chart-of-accounts/5a-tax.json` and applied with `bun run seed --tenant <id> --only chart-of-accounts` in Task 4. Consumed and asserted-not-reseeded, each with its seeding slice: `1000` Cash (0C), `1100` Bank (0C), `1200` trade receivables (0C), `1300` Inventory control (0C), `2100` trade payables (0C), `4000` Sales (0C), `5000` COGS (0C), `5900` Other operating expense (0C), `5920` FX rounding (0C), `2150` GRNI (**3C**), `1250` goods delivered not invoiced (**3D**). **Report codes (§4.16.1) — none.** `accounting.tax_return_view` is **7C's** row and this slice does not ship it: the *filed return* is a `tax_return` row served by this slice's own route module, and hazard 4's minimal-set list (spec:2300) names no Phase 5 report. `ReportCodeSchema` is therefore **not** widened here. **`DatasetId` members (§4.16.2) — none:** 7A creates `datasets.ts` with `tax_transaction` already in its ≤ 0058 set. **`fixtures.ts` helpers (§4.17) — exactly one, the row §4.17 assigns 5A: `seedTaxCode(db, s, opts?: { code?; rate?; kind?; regimeId? }) → { taxCodeId: string; regimeId: string }`, creating the regime on first call.** **Shared test helpers (§4.17.1) — one new file and one recorded additive edit to another slice's, both registered in Task 0:** `tests/invariants/support/tax.ts` with `TAX_PACK_ROOT`, `seedTaxPack`, `TaxFixture`, `taxFixture`, `TaxedLine` and `postTaxedDocument` — **six exports** (amendment A9); and **4B's `tests/invariants/support/ar-ap.ts`, whose `PostFromPackOptions` gains `taxInclusive?: boolean` and `computeTax?: boolean`** and whose `postFromPack` body gains one block — additive, optional, defaulted `false`, no signature changed, amendment **A13a**, made in Task 7.
- **Six `Seed`, fixture and register facts every test in this plan depends on, stated once because getting one wrong is a silent failure.** (1) **`Seed` has no `branch` member** — it is `{ tenant; system; human; company; period; closedPeriod; lockedPeriod; cash; sales; docType; policy; branchType; hq }` (§4.1), and `app.document.branch_id` is NOT NULL, so every `branchId:` in this plan is `<seed>.hq` unless a second value came from `seedBranch`. (2) **`seedTenant` grants `s.human` nothing** (§4.1, pinned) and 2B's R2 evaluates `policy.approval.post` *inside* the posting transaction, so **every posting test calls `grantCodes` first**. (3) **`seedTenantV2` creates `1000 Cash`, `4000 Sales` and `5920 FX rounding` and nothing else** — every other account this slice's tests touch, `2300` and `1350` included, is created in the test through 1A's `seedAccount(db, s, { code, nameEn, type })`. (4) **Plan 0A seeds exactly three fiscal periods and only 2026-01 is open** (`s.period` open, `s.closedPeriod` 2026-02 **closed**, `s.lockedPeriod` 2026-03 **locked**); every test that posts outside January calls **3B's `ensureOpenPeriods(db, s, 2026)`** first. (5) **`app.document` has no `custom_fields` column** — only `document_line` does (§4.3.4), and `DocumentSnapshot.header.customFields` is assembled by `loadSnapshot` from `app.custom_field_value` (§4.2.11). This slice writes no header custom field: `tax_inclusive` is a **column** (0054), which is why 4A's policies can name it as `"header.tax_inclusive"`. (6) **`app_rw` holds DELETE on exactly five tables** (§3.5.4) and **2B is the only slice that ever extends that list** — so nothing in this slice deletes a row: `tax_code` is archived with `archived_at`, `tax_transaction` is immutable, and a regenerated `tax_return` is an UPDATE of the same row.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first (that is what Task 0 is).
- **Contracts version:** 2026-09-07.

## Global Constraints

Copied verbatim from the spec and the contracts document; every task's requirements implicitly include this section.

1. **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (LEGACY-036/037/069); issue DDL from application code (LEGACY-053); disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053); gate an audit write on any flag (LEGACY-030); hard-code a package version into a source file — the lockfile owns versions.
2. **Always**, for every new table (spec:106): `tenant_id`, an RLS policy named exactly `tenant_isolation`, `created_at`, a migration with a hand-written down, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge. **This slice creates four tables** and every one carries the §3.3 binding form and a two-tenant test in the same task.
3. **`app.tax_transaction` is on the `posting-only-tables` list 1A shipped** (§3.7.5 names it explicitly), so an `insert`, `update`, `delete` or `merge` naming it is legal **only** in `packages/db/src/posting/**`, `packages/db/src/costing/**`, `packages/db/test/**` and `scripts/lint/rules/**`. `packages/db/src/tax/returns.ts` **reads** it and never writes it; `packages/db/src/posting/tax.ts` is its one writer. **This is the mechanical half of hazard 22 and this slice is the first to be bound by that particular table name.**
4. **Money** is `numeric(19,4)` in Postgres and the opaque `Money` type in `@dulja/domain` in TypeScript; **a tax rate is `numeric(19,8)` in Postgres and an 8-dp decimal string in TypeScript, never a `number`** (`no-number-money` matches `/rate|tax/i`, §3.7.5). Every wire amount is `{ amount, currency }`; every date `YYYY-MM-DD`. Every tie-out in this slice sums through `Money.add` or SQL `sum(...)::text` — never `Number()`, never `.toFixed()`.
5. **One rounding function, one mode, declared per tax code** (spec:2228, LEGACY-019). Tax is `Money.multiply(rate, code.roundingMode)` and nothing else; there is no local `round`, no `Math.round`, and no second rounding of an already-rounded figure. `toBase` stays `HALF_AWAY_FROM_ZERO` at scale 4 (hazard 23) and is the only place a rate applies to a base amount.
6. **`PlannedLedgerLine.amount` is never negative and `side` is the sole carrier of direction** (§4.4.2 A9) — **and `PlannedTaxLine.amount` is the one registered exception and stays signed.** This slice is named in A9's ⚠️ warning list. **No line of this slice tests `amount.isNegative()` — or any sign — to choose a ledger direction, an account or a box.** The two places a **signed magnitude flows through** are declared in the Self-Review, both over `tax_transaction.tax`, and in both of them a credit note's negative tax is a *subtraction* with no sign logic at all.
7. **Every query, reads included, runs inside `withTenant`** (spec:2053). `db.` is a lint violation; only a `tx` obtained from `withTenant` may tag SQL. `sql.unsafe` has exactly three homes and none is in this slice (§3.3, hazard 21).
8. **One migration per PR** (spec:2057); each file runs whole in one transaction; every statement carries a comment naming the LEGACY-/spec reference it serves; SQL keywords lowercase; section banners `-- ── N. title ───`; a hand-written `NNNN.down.sql` that drops only what the up added, in reverse dependency order (§3.4.5).
9. **No enum label is added** (§3.4.4, hazard 11); every new closed vocabulary in this slice is `text` + a named `check` — `tax_code.kind`, `tax_code.rounding_mode`, `tax_return.status`.
10. **Deletion** (spec:2049): financial rows never; master data is `archived_at`. §3.5.4's pinned `app_rw` DELETE list is **unchanged** by this slice and Task 11 re-asserts it as an equality.
11. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). **This slice adds exactly one row to `ERRORS`: `ERR_TAX_REGIME_MISMATCH` (422), allocated by §4.2.4 to 5A, added in the PR that raises it (Task 5).** Everything else it raises is already shipped: `ERR_VALIDATION_FAILED`, `ERR_NOT_FOUND`, `ERR_RBAC_FORBIDDEN`, `ERR_RLS_DENIED`, `ERR_CONFLICT_UNIQUE`, `ERR_CONFLICT_REFERENCE`, `ERR_DOC_STATUS_ILLEGAL`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_PERIOD_NOT_OPEN`, `ERR_TABLE_IMMUTABLE`, `ERR_ACTOR_IMMUTABLE`, `ERR_INTERNAL`. **This list is closed: a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.**
12. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice seeds exactly the one code §3.6.2 assigns it — `accounting.tax.manage`, `mutating: true` — and invents none. **`accounting.tax.file` is 5B's and this slice does not seed it.**
13. **No plan invents a literal in a shared namespace** (hazard 32). Document-type codes, account codes, report codes, `DatasetId` members, `fixtures.ts` helper names and `ERR_*` names all come from the registers; **Task 0 amends a register before any task writes a literal into it**.
14. **The slice that seeds a policy seeds the accounts that policy names by code** (§4.15, hazard 33). Task 8's four policy upserts resolve their tax accounts as `{ from: "tax_code.output_account" }` and `{ from: "tax_code.input_account" }` — **references, not code literals** — and those references resolve through `tax_code.output_account_id` / `input_account_id`, which Task 6's loader sets from `2300` and `1350`. This slice seeds both accounts, so the rule is satisfied at its source rather than at the policy.
15. **No real Malaysian statutory rate, code name, box name, threshold or deadline appears anywhere in this slice, and no LHDN or MyInvois endpoint, field, schema version or deadline appears either** (hazards 1 and 2, spec:2226, 2467). The shipped regime is **`SYNTH-MY-v1`**, its codes are `SYN-OUT-STD`, `SYN-OUT-ZERO`, `SYN-IN-STD` and `SYN-EXEMPT`, its two rates are `0.11000000` (the two standard-rated codes) and `0.00000000` (the zero-rated and exempt codes) — an eleven-percent figure chosen so it cannot be mistaken for a published one — and every file carries `"source": "SYNTHETIC-TEST-v1 — not a published figure (OD-15)"`. Task 10 is the only door the verified set comes through.
16. **The UI is not specified** (spec:79, 108). Task 12 begins with OD-24 and targets keyboard parity (spec:2254); no workflow is invented (hazard 29).
17. **Localisation** (spec:2061): every user-facing string goes through i18next with an ICU message; `packages/i18n` catalogues are complete in `en` and `ar` before merge; every screen is verified in both text directions (test 23).
18. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [5A T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root stay green after every task. **This slice does not rewrite `AGENTS.md`'s "Current phase" section — §3.8 names 5B as Phase 5's closing slice.**

---

## This slice's share of the Phase 5 definition of done

The Phase 5 row, verbatim (spec:2291) — **Definition of done:** *"The return is generated, validated and reconciled end-to-end against a golden fixture"*. §2.6's card says this slice's share is **the whole sentence**.

| Clause | Where it is green |
|---|---|
| **"generated"** | **Task 8 Step 6** — `generateTaxReturn` builds the payload from `app.tax_transaction` rows alone (never from a document, never from `ledger_entry`), writes `payload`, `payload_sha256` and `status = 'generated'`, and stamps `generated_by` on the NULL → value transition. **Task 9 Step 5** proves the byte-identity: two generations of the same period produce the identical `payload_sha256`, and a third after an unrelated document in a *different* period changes nothing. |
| **"validated"** | **Task 6 Step 4** — `malaysiaPack.validateReturn(payload)` re-parses the canonical payload against the regime definition's box list and returns `{ ok, errors }`; **Task 8 Step 6** refuses to move a return to `generated` when `validateReturn` fails, and **Task 9 Step 6** exercises the refusal by generating against a period whose transactions carry a code from a second regime — `ERR_TAX_REGIME_MISMATCH`, *"a refusal, not a wrong number"* (spec:2444). |
| **"reconciled"** | **Task 9 Step 7** — `taxReturnTieOut` returns one row per control account with `boxBase`, `ledgerBase` and `difference`, and the DoD test asserts `difference === "0.0000"` for **`2300`** (the output box against `account_balance`'s credit-minus-debit on the output-tax account) and **`1350`** (the input box against its debit-minus-credit), over a fixture containing an invoice, a credit note, a purchase invoice, a zero-rated sale and an exempt sale. |
| **"end-to-end against a golden fixture"** | **Task 9 Steps 2–4** — `tests/golden/tax/<case>/input.json` is a document set in the `DocumentSnapshot` shape (§3.7.4) and `expected.json` is the **rendered return** (§3.7.4's tax clause), byte-compared. Two cases: `synth-my-quarter` (the five-document quarter) and `synth-my-inclusive` (the same figures entered tax-inclusive, proving the inclusive extraction reaches the same boxes). |

**What is deliberately *not* in this slice's DoD share:** the transmission of that return. `accounting.tax.file`, `app.einvoice_transmission`, the `accounting.tax.submit` job and every MyInvois detail are **5B's**, behind OD-15's second half and ADR 0051.

---

## File Structure

Every path is relative to the repository root. **NEW** means this slice creates it; **EDIT** means an existing file gains the stated additions and nothing else.

```
docs/
├─ adr/0049-verified-lhdn-return-format.md              NEW  proposal, empty of figures  T10
├─ adr/0050-tax-computation-at-persist-time.md          NEW  proposal (spec:95)          T1,T5,T7
├─ decisions/od-15-5a-return-format.md                  NEW  the OD-15 record            T10
├─ runbooks/tax-return.md                               NEW  the periodic procedure      T8
└─ owner/od-24/5a/                                      NEW  the OD-24 gate directory    T12

scripts/check/
└─ contracts-5a-amendments.sh                           NEW  Task 0's gate               T0

packages/domain/
├─ tax-pack.schema.json                                 NEW  the tax sub-pack envelope   T6
├─ src/tax/
│  ├─ engine.ts        NEW  TaxRegime, TaxCodeDef, TaxLineInput/Result, TaxEngine, taxEngine, TaxError  T5
│  ├─ canonical.ts     NEW  canonicalJson — the one canonicaliser 5B's hash also uses                   T5
│  ├─ jurisdiction.ts  NEW  ReturnBox, ReturnBoxDef, RegimeDefinition, TaxTransactionRow, JurisdictionPack T6
│  ├─ pack-schema.ts   NEW  validateTaxPack — the Ajv wiring for tax-pack.schema.json                   T6
│  ├─ malaysia.ts      NEW  malaysiaPack — SYNTH-MY-v1 only until OD-15                                 T6,T10
│  └─ index.ts         NEW  the barrel                                                                  T5
├─ src/index.ts        EDIT  export * from "./tax"                                                      T5
└─ test/tax/{engine,canonical,malaysia}.test.ts         NEW                                             T5,T6

packages/db/
├─ migrations/
│  ├─ 0053_create_tax_regime_code.sql                                          NEW  T1
│  ├─ 0053.down.sql                                                            NEW  T1
│  ├─ 0054_create_tax_transaction_return_and_document_tax_inclusive.sql        NEW  T2
│  ├─ 0054.down.sql                                                            NEW  T2
│  ├─ 0055_alter_document_line_add_tax_fk.sql                                  NEW  T3
│  ├─ 0055.down.sql                                                            NEW  T3
│  ├─ 0056_seed_permission_phase5a.sql                                         NEW  T4
│  └─ 0056.down.sql                                                            NEW  T4
├─ src/
│  ├─ lint-schema.ts        EDIT  tax_transaction into AUDIT_EXEMPT and IMMUTABLE — §3.5.3's
│  │                              exact state, and nothing else. **T2 ONLY** (T1's and T3's
│  │                              rows are dashes, so neither may touch this file)          T2
│  ├─ schema/
│  │  ├─ tax-regime.ts      NEW  Drizzle mirror                                             T1
│  │  ├─ tax-code.ts        NEW  Drizzle mirror                                             T1
│  │  ├─ tax-transaction.ts NEW  Drizzle mirror                                             T2
│  │  └─ tax-return.ts      NEW  Drizzle mirror                                             T2
│  ├─ tax/
│  │  ├─ codes.ts     NEW  TaxCodeRow, listTaxCodes, createTaxCode, archiveTaxCode,
│  │  │                    loadTaxCodeRefs, resolveRegimeFor                                T5,T7
│  │  ├─ compute.ts   NEW  computeDocumentTax, resolveInclusive                             T7
│  │  ├─ returns.ts   NEW  TaxReturnRow, createTaxReturn, generateTaxReturn, listTaxReturns,
│  │  │                    getTaxReturn, taxReturnTieOut, TaxReturnTieOutRow                T8
│  │  └─ index.ts     NEW  the barrel packages/db/src/index.ts re-exports                   T5
│  ├─ posting/
│  │  ├─ tax.ts       NEW  insertTaxTransactions — the ONE writer of app.tax_transaction    T7
│  │  ├─ post.ts      EDIT step 11 calls insertTaxTransactions                              T7
│  │  ├─ load.ts      EDIT fills refs.taxCodes and header.taxInclusive                      T7
│  │  ├─ index.ts     EDIT re-exports insertTaxTransactions                                 T7
│  │  └─ errors.ts    EDIT PostingErrorCode gains "ERR_TAX_REGIME_MISMATCH" (A4)            T5
│  ├─ seed/
│  │  ├─ tax.ts       NEW  taxLoader, TaxRegimeManifest, TaxCodeManifest, taxFileNames      T6
│  │  ├─ types.ts     EDIT SubPack and SUB_PACKS gain "tax", last                           T6
│  │  ├─ packs.ts     EDIT PHASE_0_SUB_PACK_DIRECTORIES gains "tax"; OWNED_ELSEWHERE loses it T6
│  │  └─ index.ts     EDIT registers taxLoader in LOADERS; re-exports the module            T6
│  └─ index.ts        EDIT export * from "./tax"                                            T5
├─ seed/my/
│  ├─ chart-of-accounts/5a-tax.json                     NEW  2300 and 1350                  T4
│  ├─ tax/
│  │  ├─ SYNTH-MY-v1.regime.json                        NEW  the regime manifest            T6
│  │  ├─ SYNTH-MY-v1.codes.json                         NEW  the four synthetic codes       T6
│  │  └─ README.md                                      NEW  what OD-15 replaces            T6,T10
│  └─ document-types/
│     ├─ SALES_INVOICE.json          EDIT  policyVersion 2, tax.applies true, each_tax leg  T8
│     ├─ SALES_CREDIT_NOTE.json      EDIT  same                                             T8
│     ├─ PURCHASE_INVOICE.json       EDIT  same, input side                                 T8
│     └─ PURCHASE_CREDIT_NOTE.json   EDIT  same, input side                                 T8
└─ test/
   ├─ fixtures.ts                    EDIT  seedTaxCode — the ONE §4.17 row this slice owns  T1
   │                                 EDIT  DraftLine.taxCodeId + the insert column (A12)    T3
   ├─ tax/{regime-code,transaction-return,line-fk,compute,returns}.test.ts   NEW  T1,T2,T3,T7,T8
   ├─ seed/permission-phase5a.test.ts                                        NEW  T4
   ├─ seed/tax-pack.test.ts                     NEW T6; EDIT the OD-15 provenance guard  T6,T10
   └─ posting/tax-transaction.test.ts                                        NEW  T7

packages/contracts/
├─ src/accounting/tax.ts     NEW  every tax Zod schema (T5's error row lands in errors.ts)  T8
├─ src/accounting/document.ts EDIT DocumentLineInput gains taxCodeId (T3, A7);
│                                  CreateDocumentBody gains taxInclusive (T2, A7);
│                                  DocumentSchema gains taxInclusive (T2, A13b)             T2,T3
├─ src/errors.ts             EDIT ERR_TAX_REGIME_MISMATCH                                   T5
└─ permissions.ts            EDIT one PermissionDef row                                     T4

apps/api/
├─ src/routes/accounting/
│  ├─ tax-codes.ts     NEW  TAX_PERMISSION (T4), taxCodeRoutes + module (T8)                T4,T8
│  ├─ tax-returns.ts   NEW  taxReturnRoutes + module                                        T8
│  └─ documents.ts     EDIT 1A's file, two tasks, nothing else in it: T2 adds the
│                           tax_inclusive column to the create handler's insert, to its
│                           returning/DTO mapping and to every select that feeds
│                           DocumentSchema (A13b's member is required); T7 calls
│                           computeDocumentTax in the lines handler (and in create too,
│                           if Task 0's first informational probe says
│                           CreateDocumentBody takes lines)                                 T2,T7
├─ src/routes/index.ts EDIT buildRoutes registers both modules                              T8
└─ test/routes/accounting/{tax-codes,tax-returns}.test.ts                     NEW           T8

apps/backoffice/                                        ⚠️ OD-24 — dropped whole with T12
├─ src/lib/ar-ap-api.ts                                 EDIT one word: `filterQuery` gains
│                                                            `export` (4B's "ONE place")     T12
├─ src/lib/tax-api.ts                                   NEW                                 T12
├─ src/routes/accounting/tax-returns.tsx                NEW                                 T12
├─ src/router.tsx                                       EDIT one route entry                T12
├─ src/components/app-shell.tsx                         EDIT one nav entry                  T12
└─ test/tax-returns.test.tsx                            NEW                                 T12

packages/i18n/src/locales/{en,ar}.json                  EDIT the accounting.tax.* keys ⚠️T12

packages/db/seed/roles.ts                               EDIT one grant: accountant          T4

tests/
├─ invariants/
│  ├─ probes.ts                      EDIT  two PROBES entries                               T8
│  ├─ phase-5a-pinned.test.ts        NEW   the pinned lists and the re-run matrix           T11
│  ├─ support/tax.ts                 NEW   TAX_PACK_ROOT, seedTaxPack, taxFixture,
│  │                                       TaxFixture, TaxedLine, postTaxedDocument
│  │                                       (§4.17.1, A9)                                    T7
│  └─ support/ar-ap.ts               EDIT  4B's file: PostFromPackOptions gains
│                                          taxInclusive? and computeTax?, and postFromPack's
│                                          body gains one block (§4.17.1, A13a)             T7
├─ golden/
│  ├─ tax.test.ts                    NEW   the byte-compare harness, TaxGoldenExpectation,
│  │                                       GoldenBox, GoldenCase, GoldenDocument, GoldenLine,
│  │                                       runGoldenCase, CASES                                T9
│  ├─ tax/synth-my-quarter/{input,expected}.json              NEW   (no policies.json — A10)  T9
│  └─ tax/synth-my-inclusive/{input,expected}.json            NEW                             T9
├─ regression/
│  ├─ legacy-020.test.ts                NEW   created by this slice                            T11
│  ├─ legacy-058.test.ts                NEW   created by this slice                            T11
│  ├─ legacy-059.test.ts                NEW   created by this slice                            T11
│  ├─ legacy-011.test.ts                EDIT  append a `— 5A` block                            T11
│  └─ legacy-019.test.ts                EDIT  append a `— 5A` block                            T11
└─ e2e/tax-return.spec.ts            NEW   ⚠️ OD-24 — dropped with T12                      T12
```

---

### Task 0: Contracts amendments and the 4A/4B/3B/2A repo gate

**No application code.** This task does two things and stops. First, it lists the **thirteen** amendments the architect makes to `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` in one PR, so no later task writes a literal into a register that does not yet hold it (hazard 32). Second, it runs a gate script that checks the **repository**, not the document: nine names this plan imports from 1A, 2A, 3B, 3C, 4A and 4B, and two informational probes whose answers change what Tasks 7 and 8 do. **Task 1 does not start until `bash scripts/check/contracts-5a-amendments.sh` exits 0.**

The project folder is read-only to this plan's writer except this file, so the architect makes the amendments; the script is what proves they landed.

**Files:**
- Create: `scripts/check/contracts-5a-amendments.sh`
- Modify (architect, separate PR): `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`

**Interfaces**

- Consumes: nothing at run time. The script uses `grep`, `test` and `git`.
- Produces: the gate script, and the thirteen register rows below.

- [ ] **Step 1: The thirteen contract amendments**

| # | § | Amendment | Blocks |
|---|---|---|---|
| **A1** | 2.6, 3.4.2 | The 5A card's expected migration name **`0054_create_tax_transaction_return.sql` becomes `0054_create_tax_transaction_return_and_document_tax_inclusive.sql`**. §4.3.4 already assigns `document.tax_inclusive` to 0054 and §3.4.2's round-2 rule binds the card's short name to the longer one the contents require (2A's `0018_…` and 2B's `0023_…` are the two recorded instances; this is the third). | **T2** |
| **A2** | 4.9.2 | **`app.tax_regime` gains one column: `source text not null`** — where the regime's rates and box layout came from, in the form `'<publication or file> <date>'`, exactly as `exchange_rate.source` (§4.2.10) and `statutory_rate_table.source` (§4.6.1) already record provenance. LEGACY-020's root cause is a rate with no provenance and no regime discriminator; the discriminator is already in §4.9.2 and this is the other half. **No column is added to `tax_code`** — §4.9.2's `tax_code` ships exactly as pinned. ADR 0050 proposes it. | **T1** |
| **A3** | 4.9.1 | **`JurisdictionPack.regimes` is `readonly RegimeDefinition[]`, not `TaxRegime[]`.** `TaxRegime.id` is a per-tenant uuid and `malaysiaPack` is a pure module-level const, so it cannot hold database rows. A `RegimeDefinition` is `{ code; version; jurisdiction; boxes: ReturnBoxDef[] }` and `buildReturn` matches the **passed** `TaxRegime` row to a definition by `(code, version)`, refusing an unknown pair with `ERR_TAX_REGIME_MISMATCH` — a regime the pack does not know *is* a mismatch. The `compute`, `buildReturn` and `validateReturn` signatures are otherwise §4.9.1 verbatim. | **T6** |
| **A4** | 4.2.4, 4.3.8 | **`PostingErrorCode` gains `"ERR_TAX_REGIME_MISMATCH"`** — a tenth member. §4.3.8 has listed the code among the posting service's errors since the registry was written, but 1A's union (phase-1a:2051) has nine members and no plan has widened it; `packages/db/src/posting/**` cannot import `AppError` (§3.1), so the code must be in the union or `postDocument` cannot raise it. **4B hit the identical gap with `ERR_RATE_NOT_FOUND` and widened it the same way** (its third-pass item 4). No cast, no second error class, and `ERRORS` gains its own row in T5. | **T5, T7** |
| **A5** | 4.9.1 | **`TaxTransactionRow` is declared** — §4 leaves it open as one of the five bodies 5A owns outright, and this fixes its shape so `buildReturn`'s input type is not written twice: `{ documentId; documentTypeCode; lineNo; taxCodeId; taxCode: string; regimeId: string; kind: TaxCodeDef["kind"]; rate: string; base: Money; tax: Money; baseBase: Money; taxBase: Money; effectiveDate: string; postingSeq: string }`. It is declared **in `packages/domain/src/tax/jurisdiction.ts`** — a pure shape a pure `buildReturn` consumes — and `packages/db/src/tax/returns.ts` builds it from the §4.9.2 row. | **T6, T8** |
| **A6** | 4.2.13, 3.4.8 | **`SubPack` and `SUB_PACKS` gain `"tax"`, appended last** (application order: the codes link to accounts by code, so `chart-of-accounts` must have run); `PHASE_0_SUB_PACK_DIRECTORIES` gains `"tax"`; `OWNED_ELSEWHERE` **loses** its `tax` entry, keeping `reports` (7A) and `statutory` (8A). Five edits, exactly the shape 2C used for `templates` (2c:3028). | **T6** |
| **A7** | 4.3.4, 4.2.8 | The already-registered rule *"3A adds `warehouseId`… and 5A adds `taxCodeId` to `DocumentLineInput` in the same PR as the foreign key each adds, never before"* is joined by its header twin: **`CreateDocumentBody` gains `taxInclusive: z.boolean().optional()` in the same PR as `document.tax_inclusive` (0054)**, for the same reason — a wire field for a column that does not exist is how a value gets silently dropped. | **T2, T3** |
| **A8** | 4.11.2, 4.16.1 | **Recorded, not changed:** 5A ships **no** `ReportCode` and does not widen `ReportCodeSchema`. `accounting.tax_return_view` is 7C's row, hazard 4's minimal set (spec:2300) names no Phase 5 report, and the return itself is a `tax_return` row served by this slice's own route module. The line is added to §4.16.1's prose so a later reader does not go looking for the report 5A "should" have shipped. | — |
| **A9** | 4.17.1 | **`tests/invariants/support/tax.ts` is registered to 5A** with `TAX_PACK_ROOT`, `seedTaxPack`, `TaxFixture`, `taxFixture`, **`TaxedLine`** and `postTaxedDocument` — **six exports, and `TaxedLine` is one of them**: it is the line shape `postTaxedDocument` takes, so a consumer that builds a line array cannot type it without the name, and a register that lists five of six invites a sixth spelling. Four test files need the same seeded regime, four codes, two accounts and a taxed `SALES_INVOICE`, and hazard 9 forbids four spellings of it. | **T7** |
| **A10** | 3.7.4 | For the **tax** area only, `expected.json` is a `TaxGoldenExpectation`: `{ boxes: GoldenBox[]; payload: string; payloadSha256: string; tieOut: TaxReturnTieOutRow[] }`. §3.7.4's sentence — "`expected.json` is … the rendered return (tax)" — still holds; the wrapper adds the sha and the tie-out beside it, because the DoD's three verbs are three assertions and a bare payload proves only one. **`GoldenBox` is `ReturnBox` with `amount` as a 4-dp STRING** — `ReturnBox.amount` is a `Money`, `Money` is not JSON, and the harness re-wraps with `Money.of` on read. **And `input.json` for this area is a `GoldenCase`** — the return's regime, version and period, plus a `GoldenDocument[]` naming its tax codes, accounts and parties **symbolically** (`"SYN-OUT-STD"`, `"4000"`, `"customer"`), not a `DocumentSnapshot[]`: every id in this fixture is a per-run uuid, and the return is proved end-to-end through the database because the tie-out reads `account_balance`. **A tax case therefore carries no `policies.json`** — 3B's A17 file exists because 3B's harness is a pure `evaluatePolicy` driver with no database; this harness posts through `taxFixture`, which reads the four 4A envelopes off disk through `seedTypeFromPack`, and a second copy of those policies would be exactly the two-spellings hazard 9 forbids. **3B took the same shape of amendment for costing** (its A7 and A17). | **T9** |

| **A11** | 4.4.2, 4.3.2 step 6 | **Recorded, not changed — and load-bearing for this slice.** §4.4.2 must state what 2A's evaluator already does: **the `each_tax` path pushes the group's `PlannedTaxLine` unconditionally and then drops a zero-amount group *before* resolving that rule's `accountRef`.** 2A's shipped body is exactly that order — `taxLines.push({ … })`, then `if (g.amount.isZero()) continue;`, then `normalise` and `resolveAccount` (phase-2a:1843–1855). **5A is the first slice that depends on it**, and depends on it totally: `tax_code_account_for_kind_check` (T1's DDL) and the T6 loader put an account id on `kind = 'output'` and `kind = 'input'` **only**, so a `zero`, `exempt` or `out_of_scope` code has both account columns null — correctly, because a zero-rated supply has no tax account. Resolve-then-drop would refuse an ordinary zero-rated sale with `ERR_POLICY_REQUIRES_MISSING` naming an account that is *right* to be absent, and the pack would ship a box (`S3`, `kinds ["zero","exempt"], measure "base"`) that nothing could fill. Writing the ordering into §4.4.2 is what stops a later refactor of `evaluate.ts` reordering two lines and silently breaking every zero-rated document. **No code changes in any slice.** | **T7, T8, T9** |

| **A12** | 4.17.1, 4.3.4 | **3C's `DraftLine` gains `taxCodeId?: string` and `draftTypedDocument`'s `insert into app.document_line` column list gains `tax_code_id` with `${l.taxCodeId ?? null}`** — the test-tier twin of A7, in the same PR as the foreign key (0055). 3C's frozen shape (phase-3c:384-402, 444-453) carries **no** `taxCodeId` and its insert omits the column, so every taxed line in this slice — five direct `draftTypedDocument` calls and every line that reaches it through 4B's `postFromPack`, whose `lines` is `readonly DraftLine[]` — would be an excess property at compile time and a dropped value at run time: no line would carry a code, `computeDocumentTax` would write zeros, `plan.taxLines` would be empty and every box, tie-out and golden assertion in T7/T8/T9 would fail. The addition is **additive and optional**; 3C's, 3D's, 4A's and 4B's own callers are unaffected. **The one edit is 5A's, in Task 3**, and Task 3's own test proves it by drafting a line with `taxCodeId` and reading `document_line.tax_code_id` back. **`fixtures.ts` is therefore opened by two tasks in this slice — T1 for `seedTaxCode` and T3 for this one member — and by no others.** | **T3, T7, T8, T9** |

| **A13** | 4.17.1, 4.2.8 | **The two other shared surfaces this slice extends additively, registered here because A12 registered its twin and leaving these two out is the inconsistency, not the economy.** (a) **4B's `PostFromPackOptions` gains `taxInclusive?: boolean` and `computeTax?: boolean`**, and `postFromPack`'s body gains one block between the draft and the approval path (the `tax_inclusive` `UPDATE`, then `computeDocumentTax`). 4B's own amendment 9 registers `tests/invariants/support/ar-ap.ts` to 4B with `postFromPack(db, s, opts)` and `PostFromPackOptions` by name (phase-4b:250, 1861), so this is the same class of edit as A12's to 3C's `DraftLine`: **additive, both members optional and defaulted `false`, every 4A/4B call site behaves exactly as it did**, and no signature changes. It is registered because **6A owns the next re-run of test 15 and posts taxed `POS_TICKET`s through the same helper** — a plan writer who reads §4.17.1 and does not find `computeTax` there writes a second posting helper, which is hazard 9 exactly. **The one edit is 5A's, in Task 7.** (b) **1A's `DocumentSchema` gains `taxInclusive: z.boolean()`** — the read twin of A7's `CreateDocumentBody` member, in the same PR as the column (0054), so a `GET` round-trips the flag a `POST` accepted. §4.2.8 registers `DocumentSchema` to 1A (contracts:1862), and A7 names only the write body, so the read body needs its own row. Not optional and not defaulted: the column is `not null default false`, so every document has a value. **The one edit is 5A's, in Task 2.** | **T2, T7** |

- [ ] **Step 2: Write the gate script**

`scripts/check/contracts-5a-amendments.sh`:

```bash
#!/usr/bin/env bash
# Gate for slice 5A. Exits 0 only when every contracts amendment has landed and every repo name this
# plan imports exists with the spelling this plan uses. Run from the repository root.
set -uo pipefail
C="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0

need_doc() {  # need_doc <label> <fixed-string>
  if grep -qF -- "$2" "$C"; then printf 'ok   (contracts) %s\n' "$1"
  else printf 'MISSING (contracts) %s -- expected the literal: %s\n' "$1" "$2"; fail=1; fi
}
need_repo() {  # need_repo <label> <file> <fixed-string>
  if [ -f "$2" ] && grep -qF -- "$3" "$2"; then printf 'ok   (repo) %s\n' "$1"
  else printf 'MISSING (repo) %s -- %s does not carry: %s\n' "$1" "$2" "$3"; fail=1; fi
}

need_doc "A1 0054 long file name"      "0054_create_tax_transaction_return_and_document_tax_inclusive.sql"
need_doc "A2 tax_regime.source"        "source text not null"
need_doc "A3 RegimeDefinition"         "RegimeDefinition"
need_doc "A4 PostingErrorCode widened" '"ERR_TAX_REGIME_MISMATCH"'
need_doc "A5 TaxTransactionRow body"   "documentTypeCode; lineNo; taxCodeId"
need_doc "A6 SubPack gains tax"        '"document-types" | "templates" | "tax"'
need_doc "A7 CreateDocumentBody"       "taxInclusive: z.boolean().optional()"
need_doc "A8 5A ships no ReportCode"   "5A ships no ReportCode"
need_doc "A9 support/tax.ts"           "tests/invariants/support/tax.ts"
need_doc "A10 TaxGoldenExpectation"    "TaxGoldenExpectation"
need_doc "A11 zero each_tax group"     "before resolving that rule's \`accountRef\`"
need_doc "A12 DraftLine taxCodeId"     'DraftLine` gains `taxCodeId?: string`'
# A13 carries TWO literals because it registers two independent surfaces, and a half-applied amendment
# is what this gate exists to catch. The second literal NAMES the schema on purpose: a bare
# `taxInclusive: z.boolean()` is a prefix of A7's `taxInclusive: z.boolean().optional()` and would go
# green the moment A7 landed, proving nothing about the READ body.
need_doc "A13a postFromPack options"   'PostFromPackOptions` gains `taxInclusive?: boolean` and `computeTax?: boolean`'
need_doc "A13b DocumentSchema"         'DocumentSchema` gains `taxInclusive: z.boolean()`'

# ── Repository names this plan imports. The OWNING plan is the authority for what it exports (§4.18):
#    a MISSING line here is a reconciliation with that slice, never a second spelling invented locally.
need_repo "2A each_tax + plan.taxLines" packages/domain/src/posting/evaluate.ts 'rule.for === "each_tax"'
need_repo "2A PlannedTaxLine signed"    packages/domain/src/posting/evaluate.ts "taxLines.push"
need_repo "1A lines route"              apps/api/src/routes/accounting/documents.ts "ReplaceLinesBody"
# 3B ships ensureOpenPeriods in post-inventory.ts, NOT in a costing.ts — §4.17.1's row for
# `tests/invariants/support/post-inventory.ts` lists it beside postInventoryDocument and recordingJobs.
need_repo "3B ensureOpenPeriods"        tests/invariants/support/post-inventory.ts "export async function ensureOpenPeriods"
# A12 extends 3C's helper additively; this line proves the helper exists to be extended, exactly as the
# postFromPack line below does for 4B's. It does NOT check for `taxCodeId` — Task 3 is what adds it, so a
# gate that demanded it would exit 1 forever and Task 1 would never start.
need_repo "3C draftTypedDocument"       packages/db/test/fixtures.ts "export async function draftTypedDocument"
need_repo "4A PACK_ROOT"                packages/db/test/ar-ap/_support.ts "export const PACK_ROOT"
need_repo "4A loadTypesFromPack"        packages/db/test/ar-ap/_support.ts "export async function loadTypesFromPack"
need_repo "4B seedTypeFromPack"         tests/invariants/support/ar-ap.ts "export async function seedTypeFromPack"
need_repo "4B postFromPack"             tests/invariants/support/ar-ap.ts "export async function postFromPack"

# ── Two INFORMATIONAL probes. They never fail the gate; they change what T7 and T8 do. Read them.
printf '\n-- informational --\n'
if grep -qF "lines: z.array" packages/contracts/src/accounting/document.ts; then
  printf 'INFO CreateDocumentBody accepts lines at CREATE -- T7 hooks computeDocumentTax in BOTH the\n'
  printf '     create handler and the replace-lines handler, not only the second.\n'
else
  printf 'INFO CreateDocumentBody takes no lines -- T7 hooks computeDocumentTax in the lines handler only.\n'
fi
if grep -nE 'patch\(|method: "patch"' apps/api/src/routes/accounting/documents.ts >/dev/null 2>&1; then
  printf 'INFO a PATCH exists on the documents module -- if it can change effective_date or currency,\n'
  printf '     T7 must recompute tax there too. Read the handler before writing compute.ts.\n'
else
  printf 'INFO no header PATCH on documents (§4.2.7 lists none) -- effective_date and currency are fixed\n'
  printf '     at create, so computing tax when LINES are saved is sufficient and complete.\n'
fi
printf -- '-- step 11 landing site --\n'
grep -n "step 1[012]\|MERGE into\|account_balance" packages/db/src/posting/post.ts | head -20 || true
printf '     ^ read these: T7 inserts tax transactions AFTER the ledger_entry insert and BEFORE the\n'
printf '       account_balance MERGE, as post.ts stands after 3B/4A/4B -- not as §4.3.2 renumbers it.\n'

exit "$fail"
```

- [ ] **Step 3: Run it and record the result**

```bash
chmod +x scripts/check/contracts-5a-amendments.sh
bash scripts/check/contracts-5a-amendments.sh
```

Expected **after** the architect's PR: **fourteen** `ok (contracts)` lines — thirteen amendments, of which **A13 carries two literals** because it registers two independent surfaces — **nine** `ok (repo)` lines, the three informational blocks, exit 0.

**Before that PR, expect *some* of the fourteen to be `MISSING` and the script to exit 1 — not necessarily all fourteen.** Round 3 of §4.18 folded parts of several slices' amendments in ahead of their own Task 0 (A12's literal is already in the contracts document today), and a few of the literals are single words a neighbouring paragraph may already contain. **The gate's contract is the exit code, never a count**: any `MISSING (contracts)` line is the architect's PR not yet landed, and zero of them with exit 0 is the go signal. Do not "reconcile" a count.

**A `MISSING (repo)` line is a stop-and-raise, not a workaround.** It means this plan and the owning slice disagree about a name; correct **this** plan's import, never add a second spelling (§4.18, hazard 9).

- [ ] **Step 4: Commit**

```bash
git add scripts/check/contracts-5a-amendments.sh
git commit -m "$(cat <<'EOF'
chore(ci): add the 5A contracts-and-repo gate [5A T0]

Thirteen register amendments (A1-A13, fourteen grep literals -- A13 registers two surfaces)
and nine repo names this slice imports from 1A, 2A, 3B, 3C, 4A and 4B. Task 1 does not
start until this exits 0.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: Migration 0053 — `app.tax_regime` and `app.tax_code`

**PR 1 of 4.** The two master tables of §4.9.2, with A2's one added column. `tax_regime` is the discriminator LEGACY-020's GST/VAT enum collision lacked: two procedures read `TaxCodes.Kind` with incompatible meanings and nothing said which regime a code belonged to. Here every code carries `regime_id` NOT NULL, and a return names its regime.

This task also ships the one `fixtures.ts` helper §4.17 assigns 5A. **It is one of exactly two tasks that touch `fixtures.ts`** — the other is **T3**, which adds amendment A12's single `taxCodeId` member to 3C's `DraftLine` and its column to `draftTypedDocument`'s insert, in the same PR as the foreign key. Neither task edits anything the other wrote and no third task opens the file (hazard 9).

**Files:**
- Create: `packages/db/migrations/0053_create_tax_regime_code.sql`, `packages/db/migrations/0053.down.sql`
- Create: `packages/db/src/schema/tax-regime.ts`, `packages/db/src/schema/tax-code.ts`
- Create: `packages/db/test/tax/regime-code.test.ts`
- Modify: `packages/db/test/fixtures.ts` (append `seedTaxCode` — nothing existing is edited)
- Create: `docs/adr/0050-tax-computation-at-persist-time.md` (proposal; T5 and T7 extend its Consequences)

**Interfaces**

- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app.tenant`, `app.company`, `app.account`, `uuidv7()` (§4.1); `startDb`, `Db`, `Seed`, the 4-argument test `withTenant`, `uuidv7(sql)`, `lintSchema`, `listApplied`, `up`, `down`, `discover`, `schemaFingerprint` (§4.1); `seedTenantV2`, `seedAccount` (§4.17, 1A).
- Produces:
  - `app.tax_regime` and `app.tax_code` — §4.9.2 verbatim plus A2's `source`.
  - Drizzle mirrors `taxRegime`, `taxCode` (§3.4.9).
  - `fixtures.ts` — the §4.17 row:
    ```ts
    export async function seedTaxCode(
      db: Db, s: Seed,
      opts?: { code?: string; rate?: string; kind?: "output" | "input" | "exempt" | "zero" | "out_of_scope"; regimeId?: string },
    ): Promise<{ taxCodeId: string; regimeId: string }>;   // creates the SYNTH-MY-v1 regime on first call
    ```
  - **Neither table joins any `lint-schema.ts` set** — §3.5.3's rows for `tax_regime` and `tax_code` are all dashes. **This task does not open that file.**

- [ ] **Step 1: Write the failing test**

`packages/db/test/tax/regime-code.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, down, lintSchema, listApplied, up } from "../../src";
import { MIGRATIONS_DIR, startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedAccount, seedTaxCode, seedTenantV2, type Seed } from "../fixtures";

let db: Db;
let a: Seed;
let b: Seed;
let outAccount: string;
let inpAccount: string;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "tax-a");
  b = await seedTenantV2(db, "tax-b");
  // `seedTaxCode`'s `kind` defaults to "output" and it resolves `output_account_id` by looking up account
  // code 2300, leaving it null when the account is absent — at which point `tax_code_account_for_kind_check`
  // refuses the insert. Vitest runs `it` blocks in file order, so the two §4.15 accounts are seeded HERE,
  // once, and not inside whichever case happens to be first. `seedTenantV2` creates 1000, 4000 and 5920 and
  // nothing else (§4.1, this plan's header fact 3).
  outAccount = await seedAccount(db, a, { code: "2300", nameEn: "Output tax payable", type: "liability" });
  inpAccount = await seedAccount(db, a, { code: "1350", nameEn: "Input tax receivable", type: "asset" });
}, 180_000);
afterAll(async () => { await db?.stop(); });

describe("migration 0053 — tax_regime and tax_code (§4.9.2, LEGACY-020)", () => {
  it("applies as version 53 and lintSchema reports zero violations", async () => {
    expect(await listApplied(db.migrator)).toContain(53);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("tax_regime carries the columns §4.9.2 pins plus A2's source", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string; data_type: string }[]>`
      select column_name, is_nullable, data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_regime' order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "code", "created_at", "company_id", "effective_from", "effective_to", "id",
      "jurisdiction", "name_ar", "name_en", "source", "tenant_id", "version",
    ].sort());
    expect(cols.find((c) => c.column_name === "source")!.is_nullable).toBe("NO");
    expect(cols.find((c) => c.column_name === "jurisdiction")!.data_type).toBe("character");
  });

  it("a code cannot exist without a regime — regime_id is NOT NULL (LEGACY-020's missing discriminator)", async () => {
    const [c] = await db.admin<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_code' and column_name = 'regime_id'`;
    expect(c!.is_nullable).toBe("NO");
  });

  it("the five kinds and the four rounding modes are text + CHECK, not enum labels (§3.4.4)", async () => {
    const rows = await db.admin<{ conname: string; def: string }[]>`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.tax_code'::regclass and contype = 'c' order by conname`;
    const kind = rows.find((r) => r.conname === "tax_code_kind_check")!;
    for (const k of ["output", "input", "exempt", "zero", "out_of_scope"]) expect(kind.def).toContain(`'${k}'`);
    const mode = rows.find((r) => r.conname === "tax_code_rounding_mode_check")!;
    for (const m of ["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"]) expect(mode.def).toContain(`'${m}'`);
    // No new enum TYPE was created by this migration.
    const enums = await db.admin<{ typname: string }[]>`
      select t.typname from pg_type t where t.typnamespace = 'app'::regnamespace and t.typtype = 'e' order by 1`;
    expect(enums.map((e) => e.typname)).toEqual(["account_type", "document_status", "period_status", "principal_kind"]);
  });

  it("a rate is numeric(19,8) and cannot be negative (LEGACY-019's NULL/overflow class)", async () => {
    const [r] = await db.admin<{ numeric_precision: number; numeric_scale: number; is_nullable: string }[]>`
      select numeric_precision, numeric_scale, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_code' and column_name = 'rate'`;
    expect(r).toMatchObject({ numeric_precision: 19, numeric_scale: 8, is_nullable: "NO" });
    // A distinct `code`, because the SYN- codes below are asserted as an exact list and
    // `unique (company_id, code, effective_from)` would refuse a second row at the default code and date.
    const { regimeId } = await seedTaxCode(db, a, { code: "RATE-CHK" });
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, rate, kind, rounding_mode,
                                effective_from)
      values (${a.tenant}, ${a.company}, ${regimeId}, 'NEG', 'Negative', -0.01, 'output', 'HALF_EVEN', '2026-01-01')`),
    ).rejects.toThrow(/tax_code_rate_check/);
  });

  it("seedTaxCode creates the regime once and links the two accounts by id", async () => {
    // The accounts are `beforeAll`'s — `app.account` carries `unique (company_id, code)`, so a second
    // `seedAccount` at the same code would be a conflict rather than a second row.
    const first = await seedTaxCode(db, a, { code: "SYN-OUT-STD", rate: "0.11000000", kind: "output" });
    const second = await seedTaxCode(db, a, { code: "SYN-IN-STD", rate: "0.11000000", kind: "input" });
    expect(second.regimeId).toBe(first.regimeId);         // created on the FIRST call only
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const rows = await tx<{ code: string; output_account_id: string | null; input_account_id: string | null }[]>`
        select code, output_account_id, input_account_id from app.tax_code
         where company_id = ${a.company} and code like 'SYN-%' order by code`;
      expect(rows.map((r) => r.code)).toEqual(["SYN-IN-STD", "SYN-OUT-STD"]);
      expect(rows.find((r) => r.code === "SYN-OUT-STD")!.output_account_id).toBe(outAccount);
      expect(rows.find((r) => r.code === "SYN-IN-STD")!.input_account_id).toBe(inpAccount);
    });
  });

  it("unique (company_id, code, version) on the regime and (company_id, code, effective_from) on the code", async () => {
    const idx = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and tablename in ('tax_regime', 'tax_code')
       order by indexname`;
    const all = idx.map((i) => i.indexdef).join("\n");
    expect(all).toMatch(/UNIQUE INDEX .* ON app\.tax_regime USING btree \(company_id, code, version\)/);
    expect(all).toMatch(/UNIQUE INDEX .* ON app\.tax_code USING btree \(company_id, code, effective_from\)/);
  });

  it("tenant B sees neither of tenant A's rows (spec:106, test 12)", async () => {
    await seedTaxCode(db, a, { code: "ISO-ONLY" });
    const mine = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.tax_code where code = 'ISO-ONLY'`);
    expect(mine[0]!.n).toBe(1);
    const theirs = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.tax_code where code = 'ISO-ONLY'`);
    expect(theirs[0]!.n).toBe(0);
    // …and a cross-tenant INSERT is refused by the WITH CHECK half of tenant_isolation.
    const stolen = await uuidv7(db.admin);
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) => tx`
      insert into app.tax_regime (id, tenant_id, company_id, code, jurisdiction, version, effective_from, name_en, source)
      values (${stolen}, ${a.tenant}, ${a.company}, 'X', 'MY', 1, '2026-01-01', 'X', 'test')`),
    ).rejects.toThrow();
  });

  it("both tables are audited — §3.5.3 gives neither an AUDIT_EXEMPT row", async () => {
    const trg = await db.admin<{ relname: string; tgname: string }[]>`
      select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relnamespace = 'app'::regnamespace and c.relname in ('tax_regime', 'tax_code')
         and not t.tgisinternal order by 1, 2`;
    expect(trg.map((t) => `${t.relname}.${t.tgname}`)).toEqual(["tax_code.audit_row", "tax_regime.audit_row"]);
  });

  it("up → down → up is byte-identical through 0053 (§3.4.6)", async () => {
    const before = await (await import("../privileges.test")).schemaFingerprint(db.admin);
    const applied = await listApplied(db.migrator);
    expect(await down(db.migrator, MIGRATIONS_DIR)).toEqual([...applied].reverse());
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(applied);
    expect(await (await import("../privileges.test")).schemaFingerprint(db.admin)).toBe(before);
    expect(discover(MIGRATIONS_DIR).find((m) => m.version === 53)!.name).toBe("create_tax_regime_code");
  });
});
```

- [ ] **Step 2: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- tax/regime-code
```

Expected:

```
FAIL  test/tax/regime-code.test.ts > … > applies as version 53 …
AssertionError: expected [ 1, 2, …, 52 ] to include 53

FAIL  test/tax/regime-code.test.ts > … > tax_regime carries the columns §4.9.2 pins …
AssertionError: expected [] to deeply equal [ 'code', 'company_id', … ]

FAIL  test/tax/regime-code.test.ts > … > seedTaxCode creates the regime once …
TypeError: seedTaxCode is not a function
```

- [ ] **Step 3: Write migration 0053 and its down**

`packages/db/migrations/0053_create_tax_regime_code.sql`:

```sql
-- 0053_create_tax_regime_code.sql
-- Contracts §4.9.2 (tax_regime, tax_code) plus amendment A2 (tax_regime.source).
--
-- LEGACY-020: procCalculateVATReturn and procCalculateGSTReturn read the SAME TaxCodes.Kind column with
-- incompatible meanings (1 = standard-rated output vs 1 = TX input) and nothing said which regime a code
-- belonged to, so a VAT tenant running the GST return reported sales as purchases with no warning. Here
-- every code carries regime_id NOT NULL, a regime is versioned and effective-dated, and a return names the
-- regime it was built for (0054). LEGACY-019: the rounding rule is a column ON THE CODE, applied by the one
-- rounding function at persist time (spec:2228, ADR 0050) rather than configured in ten columns nothing reads.

-- ── 1. tax_regime ─────────────────────────────────────────────────────────────────────────────────────
create table app.tax_regime (
  id              uuid primary key default uuidv7(),
  tenant_id       uuid not null references app.tenant(id),
  company_id      uuid not null,
  code            text not null,                                   -- 'SYNTH-MY-v1' until OD-15 (hazard 2)
  jurisdiction    char(2) not null,                                -- ISO 3166-1 alpha-2; 'MY' for v1 (D21)
  version         int not null check (version > 0),                 -- spec:2227 "versioned regimes"
  effective_from  date not null,
  effective_to    date,
  name_en         text not null,
  name_ar         text,
  source          text not null,                                    -- A2: where the rates and boxes came from
  created_at      timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (company_id, code, version),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.tax_regime');
call app_meta.attach_audit('app.tax_regime');
comment on column app.tax_regime.source is
  'Provenance of this regime version: the publication or seed file its rates and boxes came from. LEGACY-020.';

-- ── 2. tax_code ───────────────────────────────────────────────────────────────────────────────────────
create table app.tax_code (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references app.tenant(id),
  company_id         uuid not null,
  regime_id          uuid not null,                                 -- LEGACY-020: the discriminator, never null
  code               text not null,
  name_en            text not null,
  name_ar            text,
  rate               numeric(19,8) not null check (rate >= 0),      -- decimal fraction: 0.11000000 is 11%
  kind               text not null,
  rounding_mode      text not null default 'HALF_AWAY_FROM_ZERO',   -- spec:2228, LEGACY-019
  output_account_id  uuid,                                          -- §4.15 2300; §4.4.1 tax_code.output_account
  input_account_id   uuid,                                          -- §4.15 1350; §4.4.1 tax_code.input_account
  effective_from     date not null,
  effective_to       date,
  archived_at        timestamptz,                                   -- spec:2049: master data is archived
  created_at         timestamptz not null default now(),
  constraint tax_code_kind_check
    check (kind in ('output', 'input', 'exempt', 'zero', 'out_of_scope')),
  constraint tax_code_rounding_mode_check
    check (rounding_mode in ('HALF_AWAY_FROM_ZERO', 'HALF_EVEN', 'TOWARD_ZERO', 'AWAY_FROM_ZERO')),
  -- An output code needs an output account and an input code an input account, or postDocument would
  -- resolve tax_code.output_account to null at post (§4.4.1) instead of failing at configuration time.
  constraint tax_code_account_for_kind_check
    check ((kind <> 'output' or output_account_id is not null)
       and (kind <> 'input'  or input_account_id  is not null)),
  check (effective_to is null or effective_to >= effective_from),
  unique (company_id, code, effective_from),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)        references app.company(tenant_id, id),
  foreign key (tenant_id, regime_id)         references app.tax_regime(tenant_id, id),
  foreign key (tenant_id, output_account_id) references app.account(tenant_id, id),
  foreign key (tenant_id, input_account_id)  references app.account(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.tax_code');
call app_meta.attach_audit('app.tax_code');
create index tax_code_regime_idx on app.tax_code (regime_id, effective_from desc);
-- app_rw receives select, insert, update through default privileges (plan0A:2564); no DELETE (§3.5.4).
```

`packages/db/migrations/0053.down.sql`:

```sql
-- 0053.down.sql — reverse dependency order (§3.4.5).
drop index if exists app.tax_code_regime_idx;
drop table if exists app.tax_code;
drop table if exists app.tax_regime;
```

- [ ] **Step 4: Write the Drizzle mirrors**

`packages/db/src/schema/tax-regime.ts`:

```ts
import { char, date, integer, pgSchema, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** Mirror of app.tax_regime (migration 0053). Reads only — every write is a postgres.js tagged template. */
export const taxRegime = app.table("tax_regime", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  code: text("code").notNull(),
  jurisdiction: char("jurisdiction", { length: 2 }).notNull(),
  version: integer("version").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({ byCode: unique("tax_regime_company_id_code_version_key").on(t.companyId, t.code, t.version) }));
```

`packages/db/src/schema/tax-code.ts`:

```ts
import { date, numeric, pgSchema, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** Mirror of app.tax_code (migration 0053). `rate` is `numeric(19,8)`; Drizzle returns it as a STRING and
 *  every consumer keeps it a string — `no-number-money` (§3.7.5) matches /rate|tax/i. */
export const taxCode = app.table("tax_code", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  regimeId: uuid("regime_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  rate: numeric("rate", { precision: 19, scale: 8 }).notNull(),
  kind: text("kind").notNull().$type<"output" | "input" | "exempt" | "zero" | "out_of_scope">(),
  roundingMode: text("rounding_mode").notNull()
    .$type<"HALF_AWAY_FROM_ZERO" | "HALF_EVEN" | "TOWARD_ZERO" | "AWAY_FROM_ZERO">(),
  outputAccountId: uuid("output_account_id"),
  inputAccountId: uuid("input_account_id"),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({ byCode: unique("tax_code_company_id_code_effective_from_key").on(t.companyId, t.code, t.effectiveFrom) }));
```

- [ ] **Step 5: Append `seedTaxCode` to `fixtures.ts`**

Appended at the end of `packages/db/test/fixtures.ts`. **Nothing existing in that file is edited** (§4.1, hazard 9).

```ts
/**
 * §4.17's one 5A row. Creates the SYNTH-MY-v1 regime on the FIRST call for this seed's company and reuses it
 * afterwards, so a test that wants two codes in one regime writes two plain calls. Pass `regimeId` for the
 * second regime the wrong-regime cases need.
 *
 * The rate defaults to `0.11000000` and the code to `SYN-OUT-STD`: **no published Malaysian figure or code
 * name appears in any fixture** (hazard 1, §2.6's card). Accounts are looked up by the §4.15 codes `2300`
 * and `1350` and left null when the test has not seeded them — `tax_code_account_for_kind_check` then
 * refuses an `output`/`input` code, which is the intended, loud failure.
 */
export async function seedTaxCode(
  db: Db,
  s: Seed,
  opts?: { code?: string; rate?: string; kind?: "output" | "input" | "exempt" | "zero" | "out_of_scope"; regimeId?: string },
): Promise<{ taxCodeId: string; regimeId: string }> {
  const kind = opts?.kind ?? "output";
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    let regimeId = opts?.regimeId;
    if (!regimeId) {
      const [existing] = await tx<{ id: string }[]>`
        select id from app.tax_regime where company_id = ${s.company} and code = 'SYNTH-MY-v1' and version = 1`;
      if (existing) regimeId = existing.id;
      else {
        const [made] = await tx<{ id: string }[]>`
          insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                      name_en, name_ar, source)
          values (${s.tenant}, ${s.company}, 'SYNTH-MY-v1', 'MY', 1, '2026-01-01',
                  'Synthetic test regime', 'نظام اختباري', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
          returning id`;
        regimeId = made!.id;
      }
    }
    const [acct] = await tx<{ output_id: string | null; input_id: string | null }[]>`
      select max(id) filter (where code = '2300') as output_id,
             max(id) filter (where code = '1350') as input_id
        from app.account where company_id = ${s.company}`;
    const [row] = await tx<{ id: string }[]>`
      insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, rate, kind, rounding_mode,
                                output_account_id, input_account_id, effective_from)
      values (${s.tenant}, ${s.company}, ${regimeId}, ${opts?.code ?? "SYN-OUT-STD"},
              ${opts?.code ?? "SYN-OUT-STD"}, ${opts?.rate ?? "0.11000000"}, ${kind}, 'HALF_AWAY_FROM_ZERO',
              ${kind === "output" ? acct?.output_id ?? null : null},
              ${kind === "input" ? acct?.input_id ?? null : null},
              '2026-01-01')
      returning id`;
    return { taxCodeId: row!.id, regimeId };
  });
}
```

- [ ] **Step 6: Write ADR 0050 as a proposal**

`docs/adr/0050-tax-computation-at-persist-time.md` — status `proposed`, and **it blocks its own tasks' merge, not the plan** (spec:95). Context: LEGACY-019 (ten rounding columns, zero references, one wrong function) and LEGACY-020 (a rate hardcoded in a procedure, no provenance). Decision, in four sentences: a rate lives only in `app.tax_code`, seeded from a reviewed file; each code declares its own `rounding_mode` and tax is `Money.multiply(rate, mode)` and nothing else; the figure is computed **when the lines are saved** and stored on `document_line.tax_amount` / `total_incl_tax`, so the evaluator, the ledger and the return all read one number; and `tax_regime.source` records where the rates came from, so a filed return can be traced to a publication. Consequences: a rate change is a seed PR, never a release (spec:2229 says payroll follows this discipline, so it must exist here first); recomputation of an already-issued document is impossible because `document_line` is only writable while the document is a draft (2B's `document_line_delete_draft_only` and the status triggers); and T5's and T7's steps extend this file's Consequences rather than writing a second ADR.

- [ ] **Step 7: Run the test and see it pass, then commit**

```bash
bun run --cwd packages/db test -- tax/regime-code && bun run typecheck && bun run lint && bun run lint:rules
```

```bash
git add packages/db/migrations/0053_create_tax_regime_code.sql packages/db/migrations/0053.down.sql \
        packages/db/src/schema/tax-regime.ts packages/db/src/schema/tax-code.ts \
        packages/db/test/tax/regime-code.test.ts packages/db/test/fixtures.ts \
        docs/adr/0050-tax-computation-at-persist-time.md
git commit -m "$(cat <<'EOF'
feat(db): add tax_regime and tax_code [5A T1]

Contracts §4.9.2 plus amendment A2 (tax_regime.source). Every code carries regime_id
NOT NULL — the discriminator LEGACY-020's two return procedures did not have — and its own
rounding_mode, which LEGACY-019 configured in ten columns and never applied. fixtures.ts
gains seedTaxCode, the one §4.17 helper this slice owns.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration 0054 — `app.tax_transaction`, `app.tax_return`, `document.tax_inclusive`

**PR 2 of 4.** The append-only record the return is built from, the return row itself, and the header flag 4A's policies already name as `"header.tax_inclusive"`. §3.4.3 permits one file to create tables and alter one; §4.3.4 assigns `document.tax_inclusive` to **0054** by number, and A1 renames the file so its name says so.

**`tax_transaction` is the one table in this slice with linter set memberships** — `AUDIT_EXEMPT` and `IMMUTABLE`, §3.5.3's exact state — and **this is the only task that opens `lint-schema.ts`**. It is written only by the posting service (T7), is immutable to `app_rw`, and an audit copy of an append-only table is a second copy of the same rows.

**Files:**
- Create: `packages/db/migrations/0054_create_tax_transaction_return_and_document_tax_inclusive.sql`, `packages/db/migrations/0054.down.sql`
- Create: `packages/db/src/schema/tax-transaction.ts`, `packages/db/src/schema/tax-return.ts`
- Create: `packages/db/test/tax/transaction-return.test.ts`
- Modify: `packages/db/src/lint-schema.ts` (two set memberships), `packages/contracts/src/accounting/document.ts` (`CreateDocumentBody` gains `taxInclusive` — amendment A7; `DocumentSchema` gains `taxInclusive` — amendment A13b), `apps/api/src/routes/accounting/documents.ts` (one column, `tax_inclusive`, on the create handler's `insert into app.document`, and nothing else in the file)

**Interfaces**

- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.forbid_change`, `app.stamp_actor`, `app.document`, `app.document_line`, `app.fiscal_period`, `app.attachment` (2C) (§4.1, §4.5.8); `AUDIT_EXEMPT`, `IMMUTABLE`, `lintSchema` (§4.1); `seedTenantV2`, `draftDocument`, `seedTaxCode` (T1).
- Produces:
  - `app.tax_transaction` — §4.9.2 verbatim; immutable, audit-exempt; `unique (document_id, line_no, tax_code_id)`.
  - `app.tax_return` — §4.9.2 verbatim; `generated_by` **nullable with no default and a SINGLE-column `references app.principal(id)`** (`app.principal` is global and carries no `unique (tenant_id, id)`), stamped on the NULL → value transition.
  - `app.document.tax_inclusive boolean not null default false` (§4.3.4's 5A row).
  - `lint-schema.ts` — `AUDIT_EXEMPT` and `IMMUTABLE` each gain `"tax_transaction"` and nothing else moves.
  - `CreateDocumentBody` gains `taxInclusive: z.boolean().optional()` (A7); `DocumentSchema` gains `taxInclusive: z.boolean()` — **not** optional, because the column is `not null default false` and every document therefore has a value (A13b).
  - Drizzle mirrors `taxTransaction`, `taxReturn`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/tax/transaction-return.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema, listApplied } from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { draftDocument, seedAccount, seedTaxCode, seedTenantV2, type Seed } from "../fixtures";

let db: Db;
let a: Seed;
let b: Seed;
let taxCodeId: string;
let regimeId: string;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "txn-a");
  b = await seedTenantV2(db, "txn-b");
  await seedAccount(db, a, { code: "2300", nameEn: "Output tax payable", type: "liability" });
  ({ taxCodeId, regimeId } = await seedTaxCode(db, a));
}, 180_000);
afterAll(async () => { await db?.stop(); });

/** The one insert path a DB-tier test may use: this file is inside `packages/db/test/**`, which is on the
 *  `posting-only-tables` allow-list (§3.7.5). Every OTHER file writes tax transactions through postDocument. */
async function insertTxn(s: Seed, docId: string, lineNo: number, tax: string) {
  return withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ id: string }[]>`
    insert into app.tax_transaction (tenant_id, company_id, document_id, line_no, tax_code_id, regime_id,
                                     base, tax, base_base, tax_base, effective_date, fiscal_period_id, posting_seq)
    values (${s.tenant}, ${s.company}, ${docId}, ${lineNo}, ${taxCodeId}, ${regimeId},
            100.0000, ${tax}, 100.0000, ${tax}, '2026-01-15', ${s.period}, 1)
    returning id`);
}

describe("migration 0054 — tax_transaction, tax_return, document.tax_inclusive (§4.9.2, §4.3.4)", () => {
  it("applies as version 54 and lintSchema reports zero violations", async () => {
    expect(await listApplied(db.migrator)).toContain(54);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("tax_transaction is in AUDIT_EXEMPT and IMMUTABLE, and nothing else moved (§3.5.3)", () => {
    expect(AUDIT_EXEMPT.has("tax_transaction")).toBe(true);
    expect(IMMUTABLE.has("tax_transaction")).toBe(true);
    expect(AUDIT_EXEMPT.has("tax_return")).toBe(false);
    expect(IMMUTABLE.has("tax_return")).toBe(false);
    expect(AUDIT_EXEMPT.has("tax_code")).toBe(false);
    expect(AUDIT_EXEMPT.has("tax_regime")).toBe(false);
  });

  it("all four monetary columns are NOT NULL — a return can never carry tax without base (LEGACY-011)", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string; numeric_scale: number }[]>`
      select column_name, is_nullable, numeric_scale from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_transaction'
         and column_name in ('base', 'tax', 'base_base', 'tax_base') order by column_name`;
    expect(cols).toHaveLength(4);
    for (const c of cols) { expect(c.is_nullable).toBe("NO"); expect(c.numeric_scale).toBe(4); }
    // …and none of them has a DEFAULT that could quietly stand in for a missing figure.
    const [d] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_transaction'
         and column_name in ('base','tax','base_base','tax_base') and column_default is not null`;
    expect(d!.n).toBe(0);
  });

  it("tax_transaction is append-only: UPDATE and DELETE raise ERR_TABLE_IMMUTABLE, and app_rw holds neither", async () => {
    const docId = await draftDocument(db, a);
    const [row] = await insertTxn(a, docId, 1, "11.0000");
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`update app.tax_transaction set tax = 12.0000 where id = ${row!.id}`),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`delete from app.tax_transaction where id = ${row!.id}`),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE|permission denied/);
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'tax_transaction' order by 1`;
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(["INSERT", "SELECT"]);
  });

  it("one code may appear once per document line — unique (document_id, line_no, tax_code_id)", async () => {
    const docId = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await insertTxn(a, docId, 1, "11.0000");
    await expect(insertTxn(a, docId, 1, "11.0000")).rejects.toThrow(/tax_transaction_document_id_line_no_tax_code_id_key/);
    await expect(insertTxn(a, docId, 2, "11.0000")).resolves.toBeDefined();   // a second LINE is fine
  });

  it("tax_return.generated_by is nullable with NO default, so a draft carries none", async () => {
    const [c] = await db.admin<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_return' and column_name = 'generated_by'`;
    expect(c).toMatchObject({ is_nullable: "YES", column_default: null });
    const [t] = await db.admin<{ tgname: string }[]>`
      select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relname = 'tax_return' and t.tgname = 'stamp_generated_by' and not t.tgisinternal`;
    expect(t).toBeDefined();
    // The key is the SINGLE-column form every earlier slice uses for app.principal, which is GLOBAL and
    // has no `unique (tenant_id, id)` for a composite key to target (plan0A:988-998, §3.5.3).
    const fks = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.tax_return'::regclass and contype = 'f'
         and pg_get_constraintdef(oid) like '%principal%'`;
    expect(fks.map((f) => f.def)).toEqual(["FOREIGN KEY (generated_by) REFERENCES app.principal(id)"]);
  });

  it("generated_by is stamped on the NULL → value transition and immutable afterwards (plan0A:2365)", async () => {
    const id = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        insert into app.tax_return (tenant_id, company_id, regime_id, period_start, period_end, status)
        values (${a.tenant}, ${a.company}, ${regimeId}, '2026-01-01', '2026-03-31', 'draft') returning id`;
      return r!.id;
    });
    const [drafted] = await db.admin<{ generated_by: string | null }[]>`
      select generated_by from app.tax_return where id = ${id}`;
    expect(drafted!.generated_by).toBeNull();
    // The NULL → value transition: a supplied value is REPLACED with the session actor, never trusted (LEGACY-044).
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.tax_return set status = 'generated', payload = '{}', payload_sha256 = sha256(''::bytea),
                                generated_by = ${b.human} where id = ${id}`);
    const [gen] = await db.admin<{ generated_by: string }[]>`select generated_by from app.tax_return where id = ${id}`;
    expect(gen!.generated_by).toBe(a.human);
    // A regeneration keeps the FIRST generator — 1A's closed_by decision (§4.3.4); app.audit_log is the
    // per-generation record with its own stamped actor.
    await expect(withTenant(db.rw, a.tenant, a.system, (tx) =>
      tx`update app.tax_return set generated_by = ${a.system} where id = ${id}`),
    ).rejects.toThrow(/ERR_ACTOR_IMMUTABLE/);
    await expect(withTenant(db.rw, a.tenant, a.system, (tx) =>
      tx`update app.tax_return set payload = '{"v":2}' where id = ${id}`),
    ).resolves.toBeDefined();
  });

  it("the return's status vocabulary is text + CHECK and already admits 'filed' for 5B", async () => {
    const [c] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.tax_return'::regclass and conname = 'tax_return_status_check'`;
    for (const s of ["draft", "generated", "filed"]) expect(c!.def).toContain(`'${s}'`);
  });

  it("one return per company, regime and period start", async () => {
    const idx = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and tablename = 'tax_return'`;
    expect(idx.map((i) => i.indexdef).join("\n"))
      .toMatch(/UNIQUE INDEX .* ON app\.tax_return USING btree \(company_id, regime_id, period_start\)/);
  });

  it("document.tax_inclusive exists, is NOT NULL and defaults false (§4.3.4's 5A row)", async () => {
    const [c] = await db.admin<{ is_nullable: string; column_default: string }[]>`
      select is_nullable, column_default from information_schema.columns
       where table_schema = 'app' and table_name = 'document' and column_name = 'tax_inclusive'`;
    expect(c).toMatchObject({ is_nullable: "NO", column_default: "false" });
    const docId = await draftDocument(db, a);
    const [d] = await db.admin<{ tax_inclusive: boolean }[]>`
      select tax_inclusive from app.document where id = ${docId}`;
    expect(d!.tax_inclusive).toBe(false);        // every document posted in Phases 1-4 reads false
  });

  it("tenant B sees neither table's rows (spec:106, test 12)", async () => {
    const docId = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await insertTxn(a, docId, 9, "11.0000");
    const theirs = await withTenant(db.rw, b.tenant, b.human, (tx) => tx<{ t: number; r: number }[]>`
      select (select count(*)::int from app.tax_transaction) as t,
             (select count(*)::int from app.tax_return) as r`);
    expect(theirs[0]).toEqual({ t: 0, r: 0 });
  });
});
```

- [ ] **Step 2: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- tax/transaction-return
```

Expected:

```
FAIL  … > applies as version 54 …
AssertionError: expected [ 1, …, 53 ] to include 54

FAIL  … > tax_transaction is in AUDIT_EXEMPT and IMMUTABLE …
AssertionError: expected false to be true

FAIL  … > all four monetary columns are NOT NULL …
AssertionError: expected [] to have a length of 4 but got +0
```

- [ ] **Step 3: Write migration 0054 and its down**

`packages/db/migrations/0054_create_tax_transaction_return_and_document_tax_inclusive.sql`:

```sql
-- 0054_create_tax_transaction_return_and_document_tax_inclusive.sql
-- Contracts §4.9.2 (tax_transaction, tax_return) and §4.3.4's 5A row (document.tax_inclusive).
-- The file name states all three because §3.4.2 requires it (amendment A1; 2A's 0018_… is the precedent).
--
-- LEGACY-011 (VAT half): procCalculateVATReturn accumulated without coalesce, so ONE bill line with a NULL
-- base nulled Output_Total for the whole period while Output_Tax still reported a figure — a return filed
-- with tax and no base. Here all four monetary columns are NOT NULL with no default, so a tax without a
-- base is not representable. LEGACY-059: the return reads THIS table with both period bounds always bound
-- (packages/db/src/tax/returns.ts), never a concatenated query that can lose its date filter.

-- ── 1. tax_transaction — one row per posted tax line, written ONLY by the posting service at step 11 ───
create table app.tax_transaction (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  document_id       uuid not null,
  line_no           int not null check (line_no > 0),           -- the SOURCE document_line.line_no
  tax_code_id       uuid not null,
  regime_id         uuid not null,                              -- denormalised from the code: the code may be
                                                                -- archived later; a filed return must not move
  base              numeric(19,4) not null,                     -- document currency, SIGNED (a credit note is
  tax               numeric(19,4) not null,                     -- genuinely negative tax — §4.4.2 A9's exception)
  base_base         numeric(19,4) not null,                     -- company base currency, via toBase
  tax_base          numeric(19,4) not null,
  effective_date    date not null,                              -- the ACCOUNTING date, never posted_at (spec:2039)
  fiscal_period_id  uuid not null,
  posting_seq       bigint not null,                            -- §4.3.5; assigned at §4.3.2 step 8
  created_at        timestamptz not null default now(),
  unique (document_id, line_no, tax_code_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)       references app.company(tenant_id, id),
  foreign key (tenant_id, document_id)      references app.document(tenant_id, id),
  foreign key (tenant_id, tax_code_id)      references app.tax_code(tenant_id, id),
  foreign key (tenant_id, regime_id)        references app.tax_regime(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.tax_transaction');
-- No attach_audit: AUDIT_EXEMPT (§3.5.3). The table is append-only, so an audit copy is a second copy of
-- the same rows; correction is a reversing document, which writes its own negative rows (LEGACY-041).
create trigger tax_transaction_immutable before update or delete on app.tax_transaction
  for each row execute function app.forbid_change();
revoke update, delete on app.tax_transaction from app_rw;
create index tax_transaction_period_idx
  on app.tax_transaction (company_id, regime_id, effective_date);   -- the return's one read path

-- ── 2. tax_return ─────────────────────────────────────────────────────────────────────────────────────
create table app.tax_return (
  id              uuid primary key default uuidv7(),
  tenant_id       uuid not null references app.tenant(id),
  company_id      uuid not null,
  regime_id       uuid not null,                                -- LEGACY-020: a return NAMES its regime
  period_start    date not null,
  period_end      date not null check (period_end >= period_start),
  status          text not null default 'draft',
  payload         text,                                          -- the canonical JSON the pack produced
  payload_sha256  bytea,                                         -- sha256(payload); test 26's byte-identity
  -- SINGLE-column reference, exactly as plan0A:1474 `closed_by`, plan0A:1794 `posted_by`, 4A's
  -- `unallocated_by` and 4B's `unmatched_by`. `app.principal` is GLOBAL (§3.5.3, §3.6.1) and carries no
  -- `unique (tenant_id, id)`, so a composite `(tenant_id, generated_by)` key has nothing to point at and
  -- PostgreSQL refuses the DDL outright: "number of referencing and referenced columns for foreign key
  -- disagree". §3.5.1's composite rule is about tenant-SCOPED parents; a global parent is the exception
  -- every earlier slice already takes.
  generated_by    uuid references app.principal(id),             -- NULL until generated; stamped then (LEGACY-044)
  filed_at        timestamptz,                                   -- written by 5B under accounting.tax.file
  attachment_id   uuid,                                          -- 5B or the print path; NULL in 5A
  created_at      timestamptz not null default now(),
  constraint tax_return_status_check check (status in ('draft', 'generated', 'filed')),
  -- A generated return has both halves or neither: the LEGACY-011 shape applied to the return row itself.
  constraint tax_return_payload_pair_check
    check ((payload is null) = (payload_sha256 is null)),
  constraint tax_return_generated_has_payload_check
    check (status = 'draft' or (payload is not null and generated_by is not null)),
  unique (company_id, regime_id, period_start),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)    references app.company(tenant_id, id),
  foreign key (tenant_id, regime_id)     references app.tax_regime(tenant_id, id),
  foreign key (tenant_id, attachment_id) references app.attachment(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.tax_return');
call app_meta.attach_audit('app.tax_return');
call app_meta.attach_stamp('app.tax_return', 'generated_by');   -- NULL while draft; stamped at generation

-- ── 3. document.tax_inclusive (§4.3.4's 5A row) ───────────────────────────────────────────────────────
-- §4.4.1's tax.inclusive may be the literal "header.tax_inclusive", which every 4A invoice policy already
-- names (phase-4a:2762). Documents posted in Phases 1-4 read false, which is what they were computed as.
alter table app.document add column tax_inclusive boolean not null default false;
comment on column app.document.tax_inclusive is
  'Line amounts include tax when true. Resolved by policy.tax.inclusive = "header.tax_inclusive" (§4.4.1).';
```

`packages/db/migrations/0054.down.sql`:

```sql
-- 0054.down.sql — reverse dependency order (§3.4.5). The ALTER drops only its own COLUMN, never app.document.
alter table app.document drop column if exists tax_inclusive;
drop table if exists app.tax_return;
drop index if exists app.tax_transaction_period_idx;
drop table if exists app.tax_transaction;        -- drops its own immutable trigger with it
```

- [ ] **Step 4: Edit `lint-schema.ts` to exactly §3.5.3's state**

Two set literals gain one member each, and **nothing else in the file moves** (hazard 13):

```ts
// packages/db/src/lint-schema.ts
export const AUDIT_EXEMPT = new Set([
  /* … every existing member, unchanged … */
  "tax_transaction",     // 5A/0054 — append-only, written only by the posting service (§3.5.3)
]);

export const IMMUTABLE = new Set([
  /* … every existing member, unchanged … */
  "tax_transaction",     // 5A/0054 — forbid_change + revoke update, delete (§3.5.3)
]);
```

`NO_ID_TABLES` and therefore `NO_CREATED_AT_TABLES` are **not** touched: `tax_transaction` keeps its `id` and its `created_at`. §3.5.3's row gives it dashes in both columns, and `NO_CREATED_AT_TABLES` is derived from `NO_ID_TABLES` (plan0A:2702) — a slice that edits the derivation has misread the section.

- [ ] **Step 5: Add `taxInclusive` to `CreateDocumentBody` (A7) and to `DocumentSchema` (A13b)**

`packages/contracts/src/accounting/document.ts` — one optional member, in the same PR as the column:

```ts
export const CreateDocumentBody = z.object({
  documentTypeCode: DocumentTypeCodeSchema,
  effectiveDate: DateSchema,
  currency: CurrencySchema,
  branchId: UuidSchema,
  clientRef: UuidSchema.optional(),
  partyId: UuidSchema.optional(),
  /** 5A / migration 0054 (§4.3.4). Line amounts INCLUDE tax when true; the policy reads it as
   *  `tax.inclusive: "header.tax_inclusive"` (§4.4.1). Omitted means false — every Phase 1-4 document. */
  taxInclusive: z.boolean().optional(),
  lines: z.array(DocumentLineInput).min(1),
}).openapi("CreateDocument");
```

And its read twin, **amendment A13b**, in the same file and the same PR — `DocumentSchema` is 1A's row in §4.2.8 (contracts:1862), so a member added to it is a register edit exactly as `CreateDocumentBody`'s is, and A7 names only the write body:

```ts
export const DocumentSchema = z.object({
  /* … every existing member, unchanged … */
  /** 5A / migration 0054 (§4.3.4), amendment A13b. NOT optional: the column is
   *  `boolean not null default false`, so every document — including every Phase 1-4 document
   *  written before 0054 — reads back a value. A `POST` that omitted `taxInclusive` round-trips `false`. */
  taxInclusive: z.boolean(),
}).openapi("Document");
```

The handler in `apps/api/src/routes/accounting/documents.ts` adds `tax_inclusive` to its one `insert into app.document` column list with `${body.taxInclusive ?? false}` and to the `returning` / row-to-DTO mapping so `DocumentSchema`'s new member has a source. **Because A13b's member is required rather than optional, every `select` in that file that feeds `DocumentSchema` must select the column too** — the GET-by-id handler and the list handler, wherever they name columns explicitly rather than going through one shared row mapper; a missed one is a `typecheck` failure at `c.json(dto)` against the response schema, not a run-time surprise. **Nothing else in that file changes** — this task does not touch the lines handler, which is Task 7's.

- [ ] **Step 6: Write the two Drizzle mirrors**

`packages/db/src/schema/tax-transaction.ts`:

```ts
import { bigint, customType, date, integer, numeric, pgSchema, timestamp, uuid, unique } from "drizzle-orm/pg-core";

const app = pgSchema("app");
/** `bytea` has no first-class Drizzle type; the return's sha is read as a Buffer. Declared once, here,
 *  because tax-return.ts imports it rather than declaring a second one. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Mirror of app.tax_transaction (0054). READ ONLY from every module except packages/db/src/posting/tax.ts —
 *  the table is on the `posting-only-tables` list (§3.7.5) and immutable in the database besides. */
export const taxTransaction = app.table("tax_transaction", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  documentId: uuid("document_id").notNull(),
  lineNo: integer("line_no").notNull(),
  taxCodeId: uuid("tax_code_id").notNull(),
  regimeId: uuid("regime_id").notNull(),
  base: numeric("base", { precision: 19, scale: 4 }).notNull(),
  tax: numeric("tax", { precision: 19, scale: 4 }).notNull(),
  baseBase: numeric("base_base", { precision: 19, scale: 4 }).notNull(),
  taxBase: numeric("tax_base", { precision: 19, scale: 4 }).notNull(),
  effectiveDate: date("effective_date").notNull(),
  fiscalPeriodId: uuid("fiscal_period_id").notNull(),
  postingSeq: bigint("posting_seq", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({ perLine: unique("tax_transaction_document_id_line_no_tax_code_id_key")
  .on(t.documentId, t.lineNo, t.taxCodeId) }));
```

`packages/db/src/schema/tax-return.ts`:

```ts
import { date, pgSchema, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { bytea } from "./tax-transaction";

const app = pgSchema("app");

/** Mirror of app.tax_return (0054). */
export const taxReturn = app.table("tax_return", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  regimeId: uuid("regime_id").notNull(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  status: text("status").notNull().$type<"draft" | "generated" | "filed">(),
  payload: text("payload"),
  payloadSha256: bytea("payload_sha256"),
  generatedBy: uuid("generated_by"),
  filedAt: timestamp("filed_at", { withTimezone: true }),
  attachmentId: uuid("attachment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({ perPeriod: unique("tax_return_company_id_regime_id_period_start_key")
  .on(t.companyId, t.regimeId, t.periodStart) }));
```

- [ ] **Step 7: Run to pass, then commit**

```bash
bun run --cwd packages/db test -- tax/transaction-return && bun run typecheck && bun run lint:rules
```

```bash
git add packages/db/migrations/0054_create_tax_transaction_return_and_document_tax_inclusive.sql \
        packages/db/migrations/0054.down.sql packages/db/src/schema/tax-transaction.ts \
        packages/db/src/schema/tax-return.ts packages/db/src/lint-schema.ts \
        packages/contracts/src/accounting/document.ts apps/api/src/routes/accounting/documents.ts \
        packages/db/test/tax/transaction-return.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add tax_transaction, tax_return and document.tax_inclusive [5A T2]

§4.9.2 verbatim. All four monetary columns NOT NULL with no default, so LEGACY-011's
"a return filed with tax but no base" is not representable. tax_transaction joins
AUDIT_EXEMPT and IMMUTABLE — §3.5.3's exact state, and the only lint-schema edit in
this slice. generated_by is nullable with no default and stamped on the NULL -> value
transition, so a draft return carries no generator.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration 0055 — `document_line.tax_code_id`'s foreign key and its wire field

**PR 3 of 4.** The smallest migration in the slice and the one §4.3.4 is most explicit about. 2A added `tax_code_id uuid` in 0019 as an **unconstrained FK slot** and 2A's own tests write arbitrary uuids into it — legal exactly until this file lands. §4.3.4's round-2 correction is the rule this task implements verbatim: *"3A adds `(tenant_id, item_id) → app.item` and 5A adds `(tenant_id, tax_code_id) → app.tax_code`, and each adds its field to `DocumentLineInput` in the same PR as its key, never before — a wire field for a column no parent yet guards is how a bad id gets stored."*

**Files:**
- Create: `packages/db/migrations/0055_alter_document_line_add_tax_fk.sql`, `packages/db/migrations/0055.down.sql`
- Create: `packages/db/test/tax/line-fk.test.ts`
- Modify: `packages/contracts/src/accounting/document.ts` (`DocumentLineInput` and `DocumentLineSchema` gain `taxCodeId`), `packages/db/src/schema/document-line.ts` (the mirror gains the reference), `packages/db/test/fixtures.ts` (**amendment A12** — 3C's `DraftLine` gains one optional member and `draftTypedDocument`'s insert gains one column)

**Interfaces**

- Consumes: `app.document_line` (1A/0011, 2A/0019, 3A/0032, 3D/0040), `app.tax_code` (T1); `DocumentLineInput`, `DocumentLineSchema` (§4.2.8, 2A/1A); `draftTypedDocument`, `DraftLine` (3C — **extended here by A12, not redefined**); `seedTaxCode` (T1).
- Produces:
  - `alter table app.document_line add constraint document_line_tax_code_fk foreign key (tenant_id, tax_code_id) references app.tax_code(tenant_id, id)`.
  - `DocumentLineInput` gains `taxCodeId: UuidSchema.optional()`; `DocumentLineSchema` gains `taxCodeId: UuidSchema.nullable()`.
  - **`DraftLine` gains `taxCodeId?: string` and `draftTypedDocument` writes `tax_code_id`** (amendment A12) — the test-tier twin of the wire field, in this same PR.
  - **No `lint-schema.ts` edit** — `composite_fk` is a 0A rule that already fires on every tenant-scoped parent, and this file is what makes it stop firing for `tax_code_id`. Task 1's `lintSchema` assertion was green because the column had no parent to point at; Step 1 below proves the rule sees the new one.

- [ ] **Step 1: Write the failing test**

`packages/db/test/tax/line-fk.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema, listApplied } from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { draftDocument, draftTypedDocument, seedAccount, seedTaxCode, seedTenantV2, type Seed } from "../fixtures";
import { DocumentLineInput } from "@dulja/contracts/accounting/document";

let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "linefk-a");
  b = await seedTenantV2(db, "linefk-b");
  await seedAccount(db, a, { code: "2300", nameEn: "Output tax payable", type: "liability" });
  await seedAccount(db, b, { code: "2300", nameEn: "Output tax payable", type: "liability" });
}, 180_000);
afterAll(async () => { await db?.stop(); });

async function insertLine(s: Seed, docId: string, taxCodeId: string | null) {
  return withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id,
                                   amount, tax_code_id)
    values (${s.tenant}, ${s.company}, ${docId}, 1, 'account', ${s.cash}, 100.0000, ${taxCodeId})`);
}

describe("migration 0055 — document_line.tax_code_id foreign key (§4.3.4)", () => {
  it("applies as version 55 and lintSchema reports zero violations", async () => {
    expect(await listApplied(db.migrator)).toContain(55);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("the key is COMPOSITE (tenant_id, tax_code_id), not a plain reference (§3.5.1)", async () => {
    const [c] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.document_line'::regclass and conname = 'document_line_tax_code_fk'`;
    expect(c!.def).toBe("FOREIGN KEY (tenant_id, tax_code_id) REFERENCES app.tax_code(tenant_id, id)");
  });

  it("a null tax_code_id is still legal — every document posted in Phases 1-4 carries one (§4.9.2)", async () => {
    const docId = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await expect(insertLine(a, docId, null)).resolves.toBeDefined();
  });

  it("an arbitrary uuid is now refused — what 2A's tests could legally write until this file landed", async () => {
    const docId = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await expect(insertLine(a, docId, await uuidv7(db.admin))).rejects.toThrow(/document_line_tax_code_fk/);
  });

  it("tenant B's tax code cannot be attached to tenant A's line — the composite half of the key", async () => {
    const foreign = await seedTaxCode(db, b, { code: "SYN-OUT-STD" });
    const docId = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await expect(insertLine(a, docId, foreign.taxCodeId)).rejects.toThrow(/document_line_tax_code_fk/);
    const mine = await seedTaxCode(db, a, { code: "SYN-OUT-STD" });
    await expect(insertLine(a, docId, mine.taxCodeId)).resolves.toBeDefined();
  });

  it("DocumentLineInput accepts taxCodeId, and keeps every 1A constraint it already had", () => {
    const ok = DocumentLineInput.safeParse({
      lineNo: 1, kind: "account", accountId: "00000000-0000-7000-8000-000000000001",
      debit: "100.0000", taxCodeId: "00000000-0000-7000-8000-000000000002",
    });
    expect(ok.success).toBe(true);
    // Omitted is still valid — the field is optional and the column is nullable.
    expect(DocumentLineInput.safeParse({ lineNo: 1, kind: "account",
      accountId: "00000000-0000-7000-8000-000000000001", debit: "100.0000" }).success).toBe(true);
    // A non-uuid is ERR_VALIDATION_FAILED before the handler runs, so no bad id reaches the FK.
    expect(DocumentLineInput.safeParse({ lineNo: 1, kind: "account",
      accountId: "00000000-0000-7000-8000-000000000001", debit: "100.0000", taxCodeId: "SST" }).success).toBe(false);
    // 1A's debit-or-credit refine survives the addition.
    expect(DocumentLineInput.safeParse({ lineNo: 1, kind: "account",
      accountId: "00000000-0000-7000-8000-000000000001", debit: "1.0000", credit: "1.0000" }).success).toBe(false);
  });

  it("draftTypedDocument WRITES tax_code_id — amendment A12, the test-tier twin of the wire field", async () => {
    // Every taxed line in Tasks 7-9 reaches the database through this helper, directly or through 4B's
    // postFromPack (whose `lines` is `readonly DraftLine[]`). Before A12, `DraftLine` had no `taxCodeId`
    // and the helper's insert omitted the column, so a passed code was an excess property at compile time
    // and a dropped value at run time: no line would carry a code, computeDocumentTax would write zeros,
    // plan.taxLines would be empty and every box in T7/T8/T9 would read 0.0000 with nothing to say why.
    const mine = await seedTaxCode(db, a, { code: "A12-CHECK" });
    const { documentId, lineIds } = await draftTypedDocument(db, a, {
      documentTypeId: a.docType, series: "JV", effectiveDate: "2026-01-15",
      lines: [
        { kind: "account", lineNo: 1, accountId: a.cash, amount: "100.0000", taxCodeId: mine.taxCodeId },
        { kind: "account", lineNo: 2, accountId: a.sales, amount: "100.0000" },
      ],
    });
    expect(lineIds).toHaveLength(2);
    const rows = await db.admin<{ line_no: number; tax_code_id: string | null }[]>`
      select line_no, tax_code_id from app.document_line where document_id = ${documentId} order by line_no`;
    expect(rows).toEqual([{ line_no: 1, tax_code_id: mine.taxCodeId }, { line_no: 2, tax_code_id: null }]);
  });
});
```

- [ ] **Step 2: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- tax/line-fk
```

Expected:

```
FAIL  … > applies as version 55 …
AssertionError: expected [ 1, …, 54 ] to include 55

FAIL  … > the key is COMPOSITE (tenant_id, tax_code_id) …
TypeError: Cannot read properties of undefined (reading 'def')

FAIL  … > an arbitrary uuid is now refused …
AssertionError: promise resolved instead of rejecting

FAIL  … > draftTypedDocument WRITES tax_code_id …
error TS2353: Object literal may only specify known properties, and 'taxCodeId' does not exist in type 'DraftLine'.
```

- [ ] **Step 3: Write migration 0055 and its down**

`packages/db/migrations/0055_alter_document_line_add_tax_fk.sql`:

```sql
-- 0055_alter_document_line_add_tax_fk.sql
-- Contracts §4.3.4: 2A's migration 0019 added `tax_code_id uuid` as an unconstrained FK SLOT, deliberately,
-- because app.tax_code does not exist until 0053. This file closes it. The column stays NULLABLE — every
-- document posted in Phases 1-4 carries tax_code_id = null and §4.9.2 says so explicitly.
--
-- The key is COMPOSITE (§3.5.1): a plain reference would let one tenant attach another tenant's tax code to
-- its own line, which is the shape RLS alone does not stop because the FK is checked by the system, not by
-- the caller's policy.
alter table app.document_line
  add constraint document_line_tax_code_fk
  foreign key (tenant_id, tax_code_id) references app.tax_code(tenant_id, id);

-- The return never reads document_line, but the draft-time tax computation (packages/db/src/tax/compute.ts)
-- reads every line of one document, and the archive check reads every line naming one code.
create index document_line_tax_code_idx on app.document_line (tax_code_id) where tax_code_id is not null;
```

`packages/db/migrations/0055.down.sql`:

```sql
-- 0055.down.sql — drops only what the up added. The COLUMN is 2A's (0019) and is not touched (§3.4.5).
drop index if exists app.document_line_tax_code_idx;
alter table app.document_line drop constraint if exists document_line_tax_code_fk;
```

- [ ] **Step 4: Add `taxCodeId` to the two document-line schemas**

`packages/contracts/src/accounting/document.ts` — one optional member on the **accepted** shape and one nullable member on the **returned** shape, in the same PR as the key (§4.3.4, §4.2.8's round-2 row):

```ts
export const DocumentLineInput = z.object({
  lineNo: z.number().int().positive(),
  kind: DocumentLineKindSchema.default("account"),
  description: z.string().max(500).optional(),
  accountId: UuidSchema.optional(),
  debit: Amount.optional(),
  credit: Amount.optional(),
  itemId: UuidSchema.optional(),
  quantity: QuantitySchema.optional(),
  unitPrice: Amount.optional(),
  discount: Amount.optional(),
  amount: Amount.optional(),
  /** 5A / migration 0055 (§4.3.4). The code whose rate produces this line's tax; `tax_amount` and
   *  `total_incl_tax` are computed SERVER-SIDE from it (spec:2228, ADR 0050) and are never accepted. */
  taxCodeId: UuidSchema.optional(),
  warehouseId: UuidSchema.optional(),
  lotId: UuidSchema.optional(),
  unitId: UuidSchema.optional(),
  unitQuantity: QuantitySchema.optional(),
  dimensions: z.record(z.string(), UuidSchema).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
})
  .refine((l) => l.kind !== "account" || !!l.accountId, { message: "an account line needs accountId" })
  .refine((l) => !(l.debit && l.credit && l.debit !== "0.0000" && l.credit !== "0.0000"),
          { message: "a line is a debit or a credit, never both" })
  .openapi("DocumentLineInput");
```

and on the returned schema, beside the `SignedAmount` members 2B added:

```ts
  taxCodeId: UuidSchema.nullable(),
```

**`taxAmount` and `totalInclTax` are *not* added to `DocumentLineInput`.** They are already on `DocumentLineSchema` (2A) as returned figures, and accepting them would mean the client could state a tax the server did not compute — LEGACY-020's "the actual per-transaction tax is commented out" in the opposite direction. Task 7 is what fills them.

- [ ] **Step 5: Extend 3C's `DraftLine` and `draftTypedDocument` (amendment A12)**

`packages/db/test/fixtures.ts` — **two additions and nothing else** (§4.1, hazard 9). This is the second and last task in this slice that opens that file; T1 appended `seedTaxCode` and neither task edits anything the other wrote.

On 3C's `DraftLine` interface, one optional member beside `itemId` — the same optionality `document_line.tax_code_id` has had since 2A/0019:

```ts
export interface DraftLine {
  kind: "account" | "item" | "tax" | "text";
  lineNo?: number;
  description?: string;
  accountId?: string;
  itemId?: string;
  /** 5A / migration 0055 (amendment A12). The tax code whose rate produces this line's tax. Optional and
   *  nullable in the column, because every document drafted in Phases 1-4 carries none. The helper writes
   *  it; `computeDocumentTax` is what turns it into `tax_amount` and `total_incl_tax`. */
  taxCodeId?: string;
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
```

and in `draftTypedDocument`'s one `insert into app.document_line`, the column and its value, in the position the column occupies in the table (after `item_id`, before `warehouse_id`) — **nothing else in that statement or that function moves**:

```ts
      await tx`
        insert into app.document_line
          (id, tenant_id, company_id, document_id, line_no, kind, description, account_id, item_id,
           tax_code_id, warehouse_id, lot_id, unit_id, quantity, unit_quantity, unit_price, discount,
           amount, debit, credit, dimensions, custom_fields)
        values (${lineIds[i]!}, ${s.tenant}, ${s.company}, ${documentId}, ${l.lineNo ?? i + 1},
                ${l.kind}, ${l.description ?? null}, ${l.accountId ?? null}, ${l.itemId ?? null},
                ${l.taxCodeId ?? null}, ${l.warehouseId ?? null}, ${l.lotId ?? null}, ${l.unitId ?? null},
                ${l.quantity ?? null}, ${l.unitQuantity ?? null}, ${l.unitPrice ?? null},
                ${l.discount ?? "0"}, ${l.amount ?? "0"}, ${l.debit ?? "0"}, ${l.credit ?? "0"},
                ${JSON.stringify(l.dimensions ?? {})}::jsonb, ${JSON.stringify(l.customFields ?? {})}::jsonb)`;
```

**Why this lands in *this* PR and not in Task 7.** §4.3.4's rule is that the wire field and the foreign key arrive together, "never before — a wire field for a column no parent yet guards is how a bad id gets stored". The same argument binds the test-tier writer: a helper that could write an arbitrary uuid into `tax_code_id` is the same defect one workspace over, and this migration is what closes it. **4B's `postFromPack` needs no change for this** — its `lines` is already `readonly DraftLine[]` and it passes them straight through (phase-4b:1959).

- [ ] **Step 6: Point the Drizzle mirror at the parent**

`packages/db/src/schema/document-line.ts` — the existing `taxCodeId: uuid("tax_code_id")` column gains `.references(() => taxCode.id)` so a typed read can join it. The composite key stays the database's; Drizzle's single-column reference is the read-side hint, exactly as 3A's `itemId` mirror does.

- [ ] **Step 7: Run to pass, then commit**

```bash
bun run --cwd packages/db test -- tax/line-fk && bun run --cwd packages/contracts test && bun run typecheck
```

```bash
git add packages/db/migrations/0055_alter_document_line_add_tax_fk.sql packages/db/migrations/0055.down.sql \
        packages/db/src/schema/document-line.ts packages/contracts/src/accounting/document.ts \
        packages/db/test/fixtures.ts packages/db/test/tax/line-fk.test.ts
git commit -m "$(cat <<'EOF'
feat(db): close document_line.tax_code_id's foreign key [5A T3]

§4.3.4's 5A row: 2A left the column as an unconstrained slot because app.tax_code did
not exist. The key is composite (tenant_id, tax_code_id) so one tenant cannot attach
another's code, and DocumentLineInput gains taxCodeId in this same PR -- never before
the key, which is how a bad id gets stored. 3C's DraftLine and draftTypedDocument gain
the same field and column by amendment A12, for the same reason and in the same PR:
without them no test in Tasks 7-9 can put a code on a line at all.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Migration 0056 — `accounting.tax.manage`, the `accountant` grant, and the `2300` / `1350` chart rows

**PR 4 of 4.** The one permission code §3.6.2 assigns 5A, its single role grant, and the two account codes §4.15 assigns 5A — the only two rows this slice writes into that register.

**Why the permission reference lands in `apps/api` in this task and not in Task 8.** `scripts/lint/rules/permission-catalogue.ts` (§3.6.3) scans `apps/api`, `apps/worker`, `apps/pos`, `packages/sync` and `packages/db/src` — **not** `packages/contracts/src` — and fails when a catalogue code has no reference. `packages/db` may not import `@dulja/contracts` (§3.1), so the only legal home for `PERMISSION["accounting.tax.manage"]` is `apps/api`. This task therefore creates `apps/api/src/routes/accounting/tax-codes.ts` carrying **only** `TAX_PERMISSION` (3A's `INVENTORY_PERMISSION` and 4B's `BANK_PERMISSION` precedent); Task 8 adds the routers, the modules and the probes. The file is not registered in `buildRoutes` here, so the isolation harness sees no `ROUTES` entry without a `PROBES` key. The reference is the **bracket** form — a dotted code cannot be reached by dot access.

**Files:**
- Create: `packages/db/migrations/0056_seed_permission_phase5a.sql`, `packages/db/migrations/0056.down.sql`
- Create: `packages/db/seed/my/chart-of-accounts/5a-tax.json`
- Create: `apps/api/src/routes/accounting/tax-codes.ts` (the constant only)
- Create: `packages/db/test/seed/permission-phase5a.test.ts`
- Modify: `packages/contracts/permissions.ts` (one `PermissionDef` row), `packages/db/seed/roles.ts` (one grant)

**Interfaces**

- Consumes: `app.permission` (plan0A, global, no RLS); `PERMISSIONS`, `PermissionDef`, `PERMISSION`, `PermissionCode`, `SliceId` (§4.2.5, 0B); `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` (§4.2.5, 0D); `readPackFile` (§4.2.13, 0C); `seedTenantV2`, `seedAccount` (§4.17, 1A); `startDb`, `Db`, `Seed`, the test `withTenant`, `lintSchema`, `listApplied` (§4.1).
- Produces:
  - `app.permission` row `('accounting.tax.manage', 'accounting', true, …)`.
  - `PERMISSIONS` gains `{ code: "accounting.tax.manage", module: "accounting", mutating: true, description: "Maintain tax regimes and codes, and generate periodic tax returns", phase: "5A" }`.
  - `ROLES` — `accountant.permissions` gains `"accounting.tax.manage"`. **§3.6.4's recorded sentence gains its row: `accounting.tax.manage` → `accountant` (5A).**
  - `packages/db/seed/my/chart-of-accounts/5a-tax.json` — the two §4.15 rows `2300` and `1350`.
  - `apps/api/src/routes/accounting/tax-codes.ts` — `export const TAX_PERMISSION = { manage: PERMISSION["accounting.tax.manage"] } as const;`

- [ ] **Step 1: Write the failing test**

`packages/db/test/seed/permission-phase5a.test.ts`:

```ts
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../seed/roles";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { lintSchema, listApplied } from "../../src";
import { readPackFile } from "../../src/seed";
import { startDb, withTenant, type Db } from "../harness";
import { seedAccount, seedTenantV2, type Seed } from "../fixtures";

type AccountSeed = { code: string; nameEn: string; nameAr?: string; type: string; parentCode?: string; isGroup?: boolean };

/** The two §4.15 rows this slice SEEDS. */
const SEEDED = [
  { code: "2300", nameEn: "Output tax payable",   type: "liability" },
  { code: "1350", nameEn: "Input tax receivable",  type: "asset" },
] as const;

/** Codes this slice's policies, services and tests RESOLVE and never re-seed (hazard 33), with the owner. */
const CONSUMED = [
  { code: "1200", type: "asset",     seededBy: "0C" },   // party.receivable_account, the AR leg
  { code: "2100", type: "liability", seededBy: "0C" },   // party.payable_account, the AP leg
  { code: "4000", type: "income",    seededBy: "0C" },   // item.revenue_account
  { code: "5000", type: "expense",   seededBy: "0C" },   // item.cogs_account
  { code: "1300", type: "asset",     seededBy: "0C" },   // item.inventory_account
  { code: "5920", type: "expense",   seededBy: "0C" },   // company.fx_rounding_account_id, via balanceInBase
] as const;

let db: Db;
let s: Seed;

beforeAll(async () => { db = await startDb(); s = await seedTenantV2(db, "perm-5a"); }, 180_000);
afterAll(async () => { await db?.stop(); });

describe("migration 0056 — accounting.tax.manage (§3.6.2, §3.6.3)", () => {
  it("applies as version 56", async () => { expect(await listApplied(db.migrator)).toContain(56); });

  it("app.permission carries exactly one 5A row, and it is mutating", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code like 'accounting.tax.%' order by code`;
    expect(rows).toEqual([{ code: "accounting.tax.manage", module: "accounting", mutating: true }]);
  });

  it("accounting.tax.file is NOT seeded here — it is 5B's row (§3.6.2)", async () => {
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.permission where code = 'accounting.tax.file'`;
    expect(n!.n).toBe(0);
    expect(PERMISSIONS.some((p) => p.code === "accounting.tax.file")).toBe(false);
  });

  it("the catalogue module agrees with the database, both directions", () => {
    expect(PERMISSIONS.find((p) => p.code === "accounting.tax.manage"))
      .toMatchObject({ module: "accounting", mutating: true, phase: "5A" });
  });

  it("accountant holds it; auditor does not, because it is mutating (R7, spec:2163)", () => {
    const role = (code: string) => ROLES.find((r) => r.code === code)!;
    expect(role("accountant").permissions).toContain("accounting.tax.manage");
    for (const other of ["auditor", "user", "warehouse", "cashier", "branch_manager", "hr_payroll", "pos_terminal"]) {
      expect(role(other).permissions, other).not.toContain("accounting.tax.manage");
    }
  });

  it("no seeded role other than admin holds an incompatible pair (R6, spec:2177)", () => {
    for (const role of ROLES.filter((r) => r.code !== "admin")) {
      for (const [x, y] of INCOMPATIBLE_PAIRS) {
        expect(role.permissions.includes(x) && role.permissions.includes(y),
          `${role.code} holds both ${x} and ${y}`).toBe(false);
      }
    }
  });

  it("5a-tax.json is this slice's OWN chart file and holds exactly the two §4.15 rows", () => {
    const packRoot = join(process.cwd(), "seed", "my");     // packages/db is this workspace's cwd
    const rows = readPackFile<AccountSeed[]>(packRoot, "chart-of-accounts", "5a-tax.json");
    expect(rows.map((r) => r.code).sort()).toEqual(["1350", "2300"]);
    for (const want of SEEDED) {
      const got = rows.find((r) => r.code === want.code)!;
      expect(got.nameEn).toBe(want.nameEn);
      expect(got.type).toBe(want.type);
      expect(got.isGroup).toBeUndefined();
      expect(got.nameAr, `${want.code} needs an Arabic label (spec:2045)`).toBeTruthy();
      // §4.15's first-digit rule: the code and the type can never disagree.
      expect(got.code[0]).toBe({ asset: "1", liability: "2", equity: "3", income: "4", expense: "5" }[got.type]);
    }
  });

  it("0C's shipped chart pack declares every code this slice CONSUMES, and neither of the two it seeds", () => {
    // Reading 0C's own file is what makes hazard 33 bind: seeding the accounts in the test and then
    // asserting they resolve is self-fulfilling and could never detect 0C dropping a row.
    const packRoot = join(process.cwd(), "seed", "my");
    const base = readPackFile<AccountSeed[]>(packRoot, "chart-of-accounts", "0c-base.json");
    const leaves = new Map(base.filter((r) => r.isGroup !== true).map((r) => [r.code, r]));
    for (const c of CONSUMED) {
      expect(leaves.has(c.code), `0c-base.json has no leaf ${c.code} — ${c.seededBy} dropped a §4.15 row`).toBe(true);
      expect(leaves.get(c.code)!.type, c.code).toBe(c.type);
    }
    for (const mine of SEEDED) {
      expect(leaves.has(mine.code), `${mine.code} is 5A's row and must not be in 0c-base.json`).toBe(false);
    }
  });

  it("every consumed code resolves for a seeded company, and this slice re-seeds none (hazard 33)", async () => {
    for (const c of CONSUMED) await seedAccount(db, s, { code: c.code, nameEn: c.code, type: c.type as never });
    for (const m of SEEDED) await seedAccount(db, s, { code: m.code, nameEn: m.nameEn, type: m.type as never });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await tx<{ code: string; type: string }[]>`
        select code, type from app.account where company_id = ${s.company}
           and code = any(${[...CONSUMED, ...SEEDED].map((c) => c.code)}::text[]) order by code`;
      expect(rows.map((r) => r.code)).toEqual(["1200", "1300", "1350", "2100", "2300", "4000", "5000", "5920"]);
      expect(rows.find((r) => r.code === "2300")!.type).toBe("liability");
      expect(rows.find((r) => r.code === "1350")!.type).toBe("asset");
    });
  });

  it("no other 5a chart file exists — one file per contributing slice (§4.15)", async () => {
    const { readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../../seed/my/chart-of-accounts/", import.meta.url));
    expect(readdirSync(dir).filter((f) => f.startsWith("5a-"))).toEqual(["5a-tax.json"]);
  });

  it("lintSchema reports zero violations after 0056", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- seed/permission-phase5a
```

Expected:

```
FAIL  … > applies as version 56
AssertionError: expected [ 1, …, 55 ] to include 56

FAIL  … > app.permission carries exactly one 5A row …
AssertionError: expected [] to deeply equal [ { code: 'accounting.tax.manage', … } ]

FAIL  … > 5a-tax.json is this slice's OWN chart file …
SeedError: seed pack file not found: chart-of-accounts/5a-tax.json (looked in …/packages/db/seed/my)
```

- [ ] **Step 3: Write the migration and its down**

`packages/db/migrations/0056_seed_permission_phase5a.sql`:

```sql
-- 0056_seed_permission_phase5a.sql
-- app.permission is GLOBAL (no RLS, read-only for app_rw — plan0A:1254), so it is migration data and not
-- seed-pack data (§3.4.8). Slice 5A introduces exactly one code (§3.6.2, spec:2147).
-- accounting.tax.file is 5B's and is deliberately absent: §3.6.3's catalogue test compares both directions,
-- so seeding a code whose handler has not shipped would fail the build.
insert into app.permission (code, module, mutating, description) values
  ('accounting.tax.manage', 'accounting', true,
   'Maintain tax regimes and codes, and generate periodic tax returns')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;
```

`packages/db/migrations/0056.down.sql`:

```sql
-- 0056.down.sql — delete exactly the code this file inserted (§3.6.3).
delete from app.permission where code = 'accounting.tax.manage';
```

- [ ] **Step 4: Add the catalogue row, the role grant and the one `PERMISSION[...]` reference**

`packages/contracts/permissions.ts` — one row appended to `PERMISSIONS`, nothing else touched:

```ts
  {
    code: "accounting.tax.manage",
    module: "accounting",
    mutating: true,
    description: "Maintain tax regimes and codes, and generate periodic tax returns",
    phase: "5A",
  },
```

`packages/db/seed/roles.ts` — one string appended to `accountant.permissions`. `admin.permissions` is computed from `PERMISSIONS` and is never edited (§3.6.4). `auditor` cannot hold it (R7: `mutating: true`), and no `INCOMPATIBLE_PAIRS` entry names it — a tax code's maintenance and a return's generation are one accountant's job in a business this size, and separating them would need a second code the closed vocabulary does not have (§3.6.1).

`apps/api/src/routes/accounting/tax-codes.ts` — the constant only, so `permission-catalogue` is green inside this task's own commit:

```ts
import { PERMISSION } from "@dulja/contracts/permissions";

/**
 * Slice 5A's one permission code (§3.6.2). Declared here rather than in `packages/contracts` because
 * `scripts/lint/rules/permission-catalogue.ts` scans `apps/**`, `packages/sync` and `packages/db/src` and
 * NOT `packages/contracts/src` — and `packages/db` may not import `@dulja/contracts` (§3.1). Task 8 adds
 * `taxCodeRoutes` and `taxCodeRouteModule` to this file; the module is not registered in `buildRoutes`
 * until then, so the isolation harness never sees a ROUTES entry without a PROBES key.
 *
 * The BRACKET form is required: a dotted code cannot be reached by dot access.
 */
export const TAX_PERMISSION = { manage: PERMISSION["accounting.tax.manage"] } as const;
```

- [ ] **Step 5: Write `5a-tax.json` and apply it**

`packages/db/seed/my/chart-of-accounts/5a-tax.json` — a flat array in §4.15's shape. **One file per contributing slice, never a shared file**; eight parallel writers must not edit one JSON document.

```json
[
  {
    "code": "2300",
    "nameEn": "Output tax payable",
    "nameAr": "ضريبة المخرجات المستحقة",
    "type": "liability",
    "parentCode": "2000"
  },
  {
    "code": "1350",
    "nameEn": "Input tax receivable",
    "nameAr": "ضريبة المدخلات المستحقة القبض",
    "type": "asset",
    "parentCode": "1000"
  }
]
```

`parentCode` names the presentation group 0C's `0c-base.json` already carries as `isGroup: true`; if the gate script reports 0C shipped no `2000`/`1000` group, **drop the two `parentCode` members rather than adding group rows** — a group row in a slice file is an unregistered §4.15 literal, and the field is optional in the pack shape for exactly this reason.

Applied as a task step, per §3.4.8's rule that the slice which introduces rows applies them:

```bash
bun run --cwd packages/db seed --tenant "$TENANT_ID" --only chart-of-accounts
```

Idempotent on `(company_id, code)`, so re-running it changes nothing. **Owner-account shape (hazard 5):** *Owner provides: the staging tenant id (OD-21's tenant, already provisioned by 0C). Verify: the command above prints `chart-of-accounts: 2 inserted` on the first run and `0 inserted` on the second. Until provided: the same command runs against `startDb()` through `packages/db/test/seed/permission-phase5a.test.ts`, whose `5a-tax.json` case asserts the same two rows.*

- [ ] **Step 6: Run to pass, then commit**

```bash
bun run --cwd packages/db test -- seed/permission-phase5a && bun run lint:rules && bun run typecheck
```

```bash
git add packages/db/migrations/0056_seed_permission_phase5a.sql packages/db/migrations/0056.down.sql \
        packages/db/seed/my/chart-of-accounts/5a-tax.json packages/db/seed/roles.ts \
        packages/contracts/permissions.ts apps/api/src/routes/accounting/tax-codes.ts \
        packages/db/test/seed/permission-phase5a.test.ts
git commit -m "$(cat <<'EOF'
feat(db): seed accounting.tax.manage and the 2300/1350 chart rows [5A T4]

§3.6.2's one code for this slice, granted to accountant only (auditor cannot hold a
mutating code -- R7). §4.15's two 5A rows in their own slice file. The hazard-33 case
reads 0C's shipped 0c-base.json rather than the rows the test just made, so a dropped
0C row fails here instead of at post.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The pure tax engine — `packages/domain/src/tax/`

**No migration.** §4.9.1's `TaxRegime`, `TaxCodeDef`, `TaxLineInput`, `TaxLineResult` and `TaxEngine`, verbatim, plus the one canonicaliser §4.9.3's `hash` sentence needs. This module imports `decimal.js` through `@dulja/domain`'s own money module and **nothing else** — no database, no clock, no network, no `Date.now()` — which is what makes Task 9's fixture byte-comparable and what makes LEGACY-019 and LEGACY-020 unrepeatable: one rate source, one rounding call, one regime discriminator.

**Three decisions this task fixes, each of which the legacy system got wrong.**

- **Rounding is `Money.multiply(rate, code.roundingMode)` and nothing else.** LEGACY-019's `RoundTo.sql` was asymmetric across sign (+6 → 10, −6 → −5, "leaving a permanent 5-unit imbalance per rounded credit note"), returned NULL on a NULL base, and overflowed its integer. `Money.multiply` takes an explicit `RoundingMode` (§4.2.1), is symmetric by construction, and cannot see a null.
- **Inclusive extraction is `amount − amount / (1 + rate)`, computed once, with the code's mode.** The base is derived from the entered figure and the tax is the remainder, so `base + tax === amount` exactly — asserted below. Computing the tax first and subtracting would leave a residue on every line.
- **A wrong-regime code is a refusal, not a wrong number.** `compute` refuses a `TaxLineInput` whose `taxCode.regimeId` is not the passed regime's `id`, or whose own `[effectiveFrom, effectiveTo]` falls **outside** the regime's window — starting after the regime **ended**, or lapsing before it began — with `ERR_TAX_REGIME_MISMATCH` naming the line and both codes. **The regime's upper bound is open when `effectiveTo` is null**, which is what lets one live regime carry successive rates as successive codes (spec:2227's rate-effective-date tables, and 0053's `unique (company_id, code, effective_from)`). That is spec:2444's clause and LEGACY-020's fix in one function.

**Files:**
- Create: `packages/domain/src/tax/engine.ts`, `packages/domain/src/tax/canonical.ts`, `packages/domain/src/tax/index.ts`
- Create: `packages/domain/test/tax/engine.test.ts`, `packages/domain/test/tax/canonical.test.ts`
- Modify: `packages/domain/src/index.ts` (`export * from "./tax";`), `packages/contracts/src/errors.ts` (one `ERRORS` row), `packages/db/src/posting/errors.ts` (`PostingErrorCode` gains one member — amendment A4), `packages/db/src/index.ts` and `packages/db/src/tax/index.ts` (the barrel Task 7 and 8 fill)

**Interfaces**

- Consumes: `Money`, `CurrencyCode`, `currency`, `RoundingMode`, `MONEY_SCALE`, `RATE_SCALE`, `round` (§4.2.1, 0D); `Decimal` (via `decimal.js`, the one dependency D11 admits for the money module and, per ADR 0022's reading, for the package).
- Produces:

```ts
// packages/domain/src/tax/engine.ts — §4.9.1 verbatim
export interface TaxRegime {
  id: string; code: string; jurisdiction: "MY"; version: number;
  effectiveFrom: string; effectiveTo: string | null;
}
export interface TaxCodeDef {
  id: string; regimeId: string; code: string;
  rate: string;                     // decimal fraction, 8 dp, e.g. "0.11000000" — a STRING, never a number
  kind: "output" | "input" | "exempt" | "zero" | "out_of_scope";
  roundingMode: RoundingMode;
  outputAccountId: string | null; inputAccountId: string | null;
  effectiveFrom: string; effectiveTo: string | null;
}
export interface TaxLineInput { lineNo: number; amount: Money; taxCode: TaxCodeDef; inclusive: boolean }
export interface TaxLineResult { lineNo: number; base: Money; tax: Money; taxCode: TaxCodeDef }
export interface TaxEngine { compute(regime: TaxRegime, lines: TaxLineInput[]): TaxLineResult[] }
export const taxEngine: TaxEngine;
/** The engine's one error class. `packages/domain` may not import `AppError` (§3.1), so the token is carried
 *  on a plain class and `apps/api`'s existing `PolicyEvaluationError` branch pattern translates it. */
export class TaxError extends Error { constructor(readonly code: "ERR_TAX_REGIME_MISMATCH", readonly detail: string) }
/** `true` when a code produces no tax at all — `exempt`, `zero` and `out_of_scope`. Exported because the
 *  return needs the distinction (an exempt sale appears in its own box; an out-of-scope sale appears in none)
 *  and two spellings of it would put a sale in two boxes. */
export function producesNoTax(kind: TaxCodeDef["kind"]): boolean;

// packages/domain/src/tax/canonical.ts
/** Deterministic JSON: object keys sorted lexicographically at every depth, no whitespace, no `undefined`
 *  members, arrays in their given order. The ONE canonicaliser — §4.9.3's `hash: sha256 of the canonical
 *  payload` is the same function, so 5B imports it rather than writing a second one. */
export function canonicalJson(value: unknown): string;
```

- [ ] **Step 1: Write the failing test**

`packages/domain/test/tax/engine.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money, currency } from "../../src";
import { producesNoTax, TaxError, taxEngine, type TaxCodeDef, type TaxRegime } from "../../src/tax";

const MYR = currency("MYR");
const m = (v: string) => Money.of(v, MYR);

const REGIME: TaxRegime = {
  id: "r-1", code: "SYNTH-MY-v1", jurisdiction: "MY", version: 1,
  effectiveFrom: "2026-01-01", effectiveTo: null,
};
/** Every figure below is invented. No published Malaysian rate, code name or box name appears anywhere in
 *  this slice (hazard 1, §2.6's card): 0.11 and 0.045 are chosen so they cannot be mistaken for one. */
const code = (over: Partial<TaxCodeDef> = {}): TaxCodeDef => ({
  id: "c-1", regimeId: REGIME.id, code: "SYN-OUT-STD", rate: "0.11000000", kind: "output",
  roundingMode: "HALF_AWAY_FROM_ZERO", outputAccountId: "a-out", inputAccountId: null,
  effectiveFrom: "2026-01-01", effectiveTo: null, ...over,
});

describe("taxEngine.compute (§4.9.1, spec:2227-2228)", () => {
  it("exclusive: tax = round(amount x rate) with the CODE's mode; base is the entered amount", () => {
    const [r] = taxEngine.compute(REGIME, [{ lineNo: 1, amount: m("300.0000"), taxCode: code(), inclusive: false }]);
    expect(r!.base.toString()).toBe("300.0000");
    expect(r!.tax.toString()).toBe("33.0000");            // 300 x 0.11
    expect(r!.taxCode.code).toBe("SYN-OUT-STD");
  });

  it("inclusive: base = amount / (1 + rate); base + tax === amount EXACTLY, with no residue", () => {
    const [r] = taxEngine.compute(REGIME, [{ lineNo: 1, amount: m("333.0000"), taxCode: code(), inclusive: true }]);
    expect(r!.base.add(r!.tax).toString()).toBe("333.0000");
    expect(r!.base.toString()).toBe("300.0000");
    expect(r!.tax.toString()).toBe("33.0000");
  });

  it("the rounding MODE is the code's, not the engine's — LEGACY-019's whole finding", () => {
    // 100.05 x 0.045 = 4.50225. HALF_AWAY_FROM_ZERO -> 4.5023 (fourth dp); TOWARD_ZERO -> 4.5022.
    const away = taxEngine.compute(REGIME, [{ lineNo: 1, amount: m("100.0500"),
      taxCode: code({ rate: "0.04500000", roundingMode: "HALF_AWAY_FROM_ZERO" }), inclusive: false }]);
    const toward = taxEngine.compute(REGIME, [{ lineNo: 1, amount: m("100.0500"),
      taxCode: code({ rate: "0.04500000", roundingMode: "TOWARD_ZERO" }), inclusive: false }]);
    expect(away[0]!.tax.toString()).toBe("4.5023");
    expect(toward[0]!.tax.toString()).toBe("4.5022");
  });

  it("rounding is SYMMETRIC across sign — LEGACY-019's +6 -> 10 / -6 -> -5 asymmetry cannot recur", () => {
    const pos = taxEngine.compute(REGIME, [{ lineNo: 1, amount: m("100.0500"),
      taxCode: code({ rate: "0.04500000" }), inclusive: false }]);
    const neg = taxEngine.compute(REGIME, [{ lineNo: 1, amount: m("-100.0500"),
      taxCode: code({ rate: "0.04500000" }), inclusive: false }]);
    expect(neg[0]!.tax.toString()).toBe(`-${pos[0]!.tax.toString()}`);
    expect(neg[0]!.base.toString()).toBe("-100.0500");
  });

  it("a credit note's negative amount yields negative tax, and the sign is kept (§4.4.2 A9's exception)", () => {
    const [r] = taxEngine.compute(REGIME, [{ lineNo: 1, amount: m("-300.0000"), taxCode: code(), inclusive: false }]);
    expect(r!.tax.toString()).toBe("-33.0000");
    expect(r!.tax.isNegative()).toBe(true);
  });

  it("exempt, zero and out_of_scope produce zero tax and the full base — never a null", () => {
    for (const kind of ["exempt", "zero", "out_of_scope"] as const) {
      expect(producesNoTax(kind)).toBe(true);
      const [r] = taxEngine.compute(REGIME, [{ lineNo: 1, amount: m("300.0000"),
        taxCode: code({ kind, rate: "0.00000000", outputAccountId: null }), inclusive: false }]);
      expect(r!.tax.toString(), kind).toBe("0.0000");
      expect(r!.base.toString(), kind).toBe("300.0000");
    }
    expect(producesNoTax("output")).toBe(false);
    expect(producesNoTax("input")).toBe(false);
  });

  it("a zero-rated code entered INCLUSIVE still yields base === amount", () => {
    const [r] = taxEngine.compute(REGIME, [{ lineNo: 1, amount: m("300.0000"),
      taxCode: code({ kind: "zero", rate: "0.00000000", outputAccountId: null }), inclusive: true }]);
    expect(r!.base.toString()).toBe("300.0000");
    expect(r!.tax.toString()).toBe("0.0000");
  });

  it("a code from another regime is REFUSED, not silently applied (LEGACY-020, spec:2444)", () => {
    const foreign = code({ id: "c-9", regimeId: "r-OTHER", code: "SYN-OTHER" });
    try {
      taxEngine.compute(REGIME, [{ lineNo: 4, amount: m("1.0000"), taxCode: foreign, inclusive: false }]);
      throw new Error("compute should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(TaxError);
      expect((e as TaxError).code).toBe("ERR_TAX_REGIME_MISMATCH");
      // The message names the LINE and BOTH regimes — LEGACY-020's failure was silence.
      expect((e as TaxError).detail)
        .toBe('line 4: tax code SYN-OTHER belongs to regime r-OTHER, not to SYNTH-MY-v1 v1 (r-1)');
    }
  });

  it("a code outside the regime's WINDOW is refused — and the upper bound is open when effectiveTo is null", () => {
    // A CLOSED regime refuses a code that starts after it ended.
    const closed: TaxRegime = { ...REGIME, effectiveTo: "2026-12-31" };
    const late = code({ effectiveFrom: "2027-01-01" });
    expect(() => taxEngine.compute(closed, [{ lineNo: 2, amount: m("1.0000"), taxCode: late, inclusive: false }]))
      .toThrow(/line 2: tax code SYN-OUT-STD is effective from 2027-01-01, after regime SYNTH-MY-v1 v1 ended \(2026-12-31\)/);
    // Either regime refuses a code that lapsed before it opened.
    const lapsed = code({ effectiveTo: "2025-12-31" });
    expect(() => taxEngine.compute(REGIME, [{ lineNo: 3, amount: m("1.0000"), taxCode: lapsed, inclusive: false }]))
      .toThrow(/line 3: tax code SYN-OUT-STD lapsed on 2025-12-31/);
  });

  it("a code effective MID-regime is accepted — spec:2227's rate-effective-date table needs it", () => {
    // `SYNTH-MY-v1` has `effectiveTo: null`, and a live regime runs indefinitely. A second rate arrives as
    // a new code at a new `effective_from` INSIDE that window — the `unique (company_id, code,
    // effective_from)` shape of 0053 — and refusing it would make every rate change a new REGIME, which is
    // the thing LEGACY-020's hardcoded literal was the alternative to. T11 Step 1 posts exactly this case.
    const later = code({ code: "SYN-OUT-STD-2", effectiveFrom: "2026-07-01", rate: "0.20000000" });
    const [r] = taxEngine.compute(REGIME, [{ lineNo: 1, amount: m("1000.0000"), taxCode: later, inclusive: false }]);
    expect(r!.tax.toString()).toBe("200.0000");
  });

  it("compute is pure: the same input twice gives the identical figures, and inputs are not mutated", () => {
    const line = { lineNo: 1, amount: m("123.4500"), taxCode: code({ rate: "0.04500000" }), inclusive: false };
    const a = taxEngine.compute(REGIME, [line]);
    const b = taxEngine.compute(REGIME, [line]);
    expect(a[0]!.tax.toString()).toBe(b[0]!.tax.toString());
    expect(line.amount.toString()).toBe("123.4500");
    expect(line.taxCode.rate).toBe("0.04500000");
  });

  it("property: base + tax === amount for every inclusive line, at every rate (10^4 cases)", () => {
    fc.assert(fc.property(
      fc.integer({ min: -9_999_999, max: 9_999_999 }),
      fc.integer({ min: 0, max: 40_000_000 }),
      (cents, rateE8) => {
        const amount = Money.of((cents / 10_000).toFixed(4), MYR);
        const rate = (rateE8 / 100_000_000).toFixed(8);
        const [r] = taxEngine.compute(REGIME, [{ lineNo: 1, amount, taxCode: code({ rate }), inclusive: true }]);
        return r!.base.add(r!.tax).equals(amount);
      },
    ), { numRuns: 10_000 });
  });

  it("property: an exclusive line's base is the entered amount, untouched, at every rate", () => {
    fc.assert(fc.property(
      fc.integer({ min: -9_999_999, max: 9_999_999 }),
      fc.integer({ min: 0, max: 40_000_000 }),
      (cents, rateE8) => {
        const amount = Money.of((cents / 10_000).toFixed(4), MYR);
        const [r] = taxEngine.compute(REGIME, [{ lineNo: 1, amount,
          taxCode: code({ rate: (rateE8 / 100_000_000).toFixed(8) }), inclusive: false }]);
        return r!.base.equals(amount);
      },
    ), { numRuns: 10_000 });
  });

  it("an empty line list is an empty result, not a throw", () => {
    expect(taxEngine.compute(REGIME, [])).toEqual([]);
  });
});
```

`packages/domain/test/tax/canonical.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/tax";

describe("canonicalJson (§4.9.3's hash input; test 26's byte-identity)", () => {
  it("sorts keys at every depth and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it("two objects differing only in key order are byte-identical", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("array order is PRESERVED — a return's boxes are a sequence, not a set", () => {
    expect(canonicalJson([{ code: "B" }, { code: "A" }])).toBe('[{"code":"B"},{"code":"A"}]');
  });

  it("undefined members are dropped and null is kept — the two are different facts", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("a nested array of objects is stable across 100 shuffles of one object's keys", () => {
    const first = canonicalJson({ boxes: [{ amount: "1.0000", code: "A", label: "A" }] });
    for (let i = 0; i < 100; i++) {
      const keys = ["amount", "code", "label"].sort(() => Math.random() - 0.5);
      const box: Record<string, string> = {};
      for (const k of keys) box[k] = { amount: "1.0000", code: "A", label: "A" }[k]!;
      expect(canonicalJson({ boxes: [box] })).toBe(first);
    }
  });

  it("refuses a value JSON cannot represent, rather than emitting a lossy string", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/canonicalJson: NaN/);
    expect(() => canonicalJson({ n: 1 } as never)).not.toThrow();   // a plain number is fine (a box COUNT)
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/canonicalJson: cycle/);
  });
});
```

- [ ] **Step 2: Run them and see the exact expected failure**

```bash
bun run --cwd packages/domain test -- tax/
```

Expected:

```
FAIL  test/tax/engine.test.ts
Error: Failed to load url ../../src/tax (resolved id: …/packages/domain/src/tax) — does the file exist?

FAIL  test/tax/canonical.test.ts
Error: Failed to load url ../../src/tax
```

- [ ] **Step 3: Write `engine.ts`**

```ts
// packages/domain/src/tax/engine.ts
import Decimal from "decimal.js";
import { Money } from "../money/money";
import type { RoundingMode } from "../money/rounding";

/** Contracts §4.9.1, verbatim. */
export interface TaxRegime {
  readonly id: string;
  readonly code: string;
  readonly jurisdiction: "MY";
  readonly version: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/** Contracts §4.9.1, verbatim. A field-for-field superset of §4.4.2's `TaxCodeRef`, which it therefore
 *  satisfies STRUCTURALLY — `loadSnapshot` puts these objects straight into `snapshot.refs.taxCodes` and
 *  nothing converts between the two (§4.4.2's closing note). */
export interface TaxCodeDef {
  readonly id: string;
  readonly regimeId: string;
  readonly code: string;
  /** Decimal fraction at RATE_SCALE (8 dp): "0.11000000" is eleven per cent. A STRING, never a number —
   *  `no-number-money` (§3.7.5) matches /rate|tax/i and a float rate is LEGACY-019's arithmetic. */
  readonly rate: string;
  readonly kind: "output" | "input" | "exempt" | "zero" | "out_of_scope";
  readonly roundingMode: RoundingMode;
  readonly outputAccountId: string | null;
  readonly inputAccountId: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface TaxLineInput {
  readonly lineNo: number;
  /** Excl. or incl. of tax per `inclusive`. Signed: a credit note's line is negative. */
  readonly amount: Money;
  readonly taxCode: TaxCodeDef;
  readonly inclusive: boolean;
}
export interface TaxLineResult {
  readonly lineNo: number;
  readonly base: Money;
  readonly tax: Money;
  readonly taxCode: TaxCodeDef;
}

export interface TaxEngine {
  /** Pure. Applies each code's rate with its own declared rounding mode (spec:2228) and refuses a code whose
   *  regime is not the document's regime, or whose effective range falls outside the regime's window —
   *  which has an OPEN upper bound while `regime.effectiveTo` is null, so successive rates inside one live
   *  regime are accepted and only a code past a CLOSED regime's end is refused (LEGACY-020, spec:2227). */
  compute(regime: TaxRegime, lines: TaxLineInput[]): TaxLineResult[];
}

export class TaxError extends Error {
  constructor(readonly code: "ERR_TAX_REGIME_MISMATCH", readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "TaxError";
  }
}

/** `exempt`, `zero` and `out_of_scope` produce no tax. Exported because the RETURN needs the distinction —
 *  an exempt supply has its own box and an out-of-scope one has none — and two spellings of this predicate
 *  would put one sale in two boxes. */
export function producesNoTax(kind: TaxCodeDef["kind"]): boolean {
  return kind === "exempt" || kind === "zero" || kind === "out_of_scope";
}

const ONE = new Decimal(1);

function assertRegime(regime: TaxRegime, line: TaxLineInput): void {
  const c = line.taxCode;
  if (c.regimeId !== regime.id) {
    throw new TaxError("ERR_TAX_REGIME_MISMATCH",
      `line ${line.lineNo}: tax code ${c.code} belongs to regime ${c.regimeId}, ` +
      `not to ${regime.code} v${regime.version} (${regime.id})`);
  }
  // A code must fall INSIDE the regime's window: not starting after the window CLOSES, and not lapsed
  // before it opens. Dates are ISO `YYYY-MM-DD`, so a lexicographic comparison IS a chronological one.
  //
  // The upper bound is OPEN when `effectiveTo` is null, and that is the whole point of spec:2227's
  // "versioned regimes with rate-effective-date tables": a live regime runs indefinitely and a rate change
  // is a NEW code at a NEW `effective_from` inside it — which is what `unique (company_id, code,
  // effective_from)` (0053) exists for and what makes January's return unmovable after February's rate
  // lands (T11 Step 1). Comparing against `effectiveTo ?? effectiveFrom` would collapse an open regime's
  // window to its first day and refuse every code effective after it, so `SYNTH-MY-v1` — whose
  // `effective_to` IS null — could never carry a second rate at all.
  const until = regime.effectiveTo;
  if (until !== null && c.effectiveFrom > until) {
    throw new TaxError("ERR_TAX_REGIME_MISMATCH",
      `line ${line.lineNo}: tax code ${c.code} is effective from ${c.effectiveFrom}, ` +
      `after regime ${regime.code} v${regime.version} ended (${until})`);
  }
  if (c.effectiveTo !== null && c.effectiveTo < regime.effectiveFrom) {
    throw new TaxError("ERR_TAX_REGIME_MISMATCH",
      `line ${line.lineNo}: tax code ${c.code} lapsed on ${c.effectiveTo}, ` +
      `before regime ${regime.code} v${regime.version} (${regime.effectiveFrom})`);
  }
}

/**
 * The ONE tax computation in the system.
 *
 * Exclusive: `base` is the entered amount and `tax = round(base x rate, 4, code.roundingMode)`.
 * Inclusive: `base = round(amount / (1 + rate), 4, code.roundingMode)` and `tax = amount - base`, so
 * `base + tax === amount` EXACTLY at 4 dp for every rate. Deriving the tax first and subtracting would
 * leave a residue on every line, which is what makes an inclusive invoice fail to balance.
 *
 * `Money.multiply` / `Money.divide` require an explicit `RoundingMode` (§4.2.1) and are symmetric across
 * sign, so LEGACY-019's `+6 -> 10 / -6 -> -5` asymmetry cannot recur and a negative credit-note line produces
 * exactly the negated figures of its positive twin.
 */
export const taxEngine: TaxEngine = {
  compute(regime, lines) {
    const out: TaxLineResult[] = [];
    for (const line of lines) {
      assertRegime(regime, line);
      const c = line.taxCode;
      if (producesNoTax(c.kind)) {
        out.push({ lineNo: line.lineNo, base: line.amount, tax: Money.zero(line.amount.currency), taxCode: c });
        continue;
      }
      const rate = new Decimal(c.rate);
      if (rate.isZero()) {
        out.push({ lineNo: line.lineNo, base: line.amount, tax: Money.zero(line.amount.currency), taxCode: c });
        continue;
      }
      if (line.inclusive) {
        const base = line.amount.divide(ONE.plus(rate), c.roundingMode);
        out.push({ lineNo: line.lineNo, base, tax: line.amount.subtract(base), taxCode: c });
      } else {
        out.push({ lineNo: line.lineNo, base: line.amount, tax: line.amount.multiply(rate, c.roundingMode), taxCode: c });
      }
    }
    return out;
  },
};
```

- [ ] **Step 4: Write `canonical.ts`**

```ts
// packages/domain/src/tax/canonical.ts

/**
 * Deterministic JSON. Object keys are sorted lexicographically at every depth, arrays keep their given
 * order, there is no whitespace, and `undefined` members are dropped while `null` is kept.
 *
 * This is the ONE canonicaliser. Test 26 compares a return's bytes across runs, and §4.9.3's
 * `hash: sha256 of the canonical payload` is a hash of THIS output — so 5B imports this function rather
 * than writing a second one, and a second one would let a document hash and a stored return disagree.
 *
 * `JSON.stringify`'s own key order is insertion order, which depends on how the object was built. Two
 * honest generations of the same return would therefore differ byte for byte, and test 26 would fail for a
 * reason that has nothing to do with tax.
 */
export function canonicalJson(value: unknown): string {
  return write(value, new Set());
}

function write(v: unknown, seen: Set<object>): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string": return JSON.stringify(v);
    case "boolean": return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error(`canonicalJson: NaN or Infinity is not representable (${v})`);
      return JSON.stringify(v);
    case "bigint": return JSON.stringify(v.toString());
    case "undefined": case "function": case "symbol":
      throw new Error(`canonicalJson: ${typeof v} is not representable`);
    default: break;
  }
  const o = v as object;
  if (seen.has(o)) throw new Error("canonicalJson: cycle detected");
  seen.add(o);
  try {
    if (Array.isArray(o)) return `[${o.map((x) => write(x === undefined ? null : x, seen)).join(",")}]`;
    const entries = Object.entries(o as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${write(x, seen)}`).join(",")}}`;
  } finally {
    seen.delete(o);
  }
}
```

- [ ] **Step 5: Write the barrels and register the error code**

`packages/domain/src/tax/index.ts`:

```ts
export { producesNoTax, TaxError, taxEngine,
         type TaxCodeDef, type TaxEngine, type TaxLineInput, type TaxLineResult, type TaxRegime } from "./engine";
export { canonicalJson } from "./canonical";
// jurisdiction.ts and malaysia.ts are added by Task 6.
```

`packages/domain/src/index.ts` gains one line: `export * from "./tax";`.

`packages/contracts/src/errors.ts` — one `ERRORS` row, in the PR that raises it (§4.2.4):

```ts
  ERR_TAX_REGIME_MISMATCH: {
    status: 422,
    title: "Tax code does not belong to this regime",
    remedy: "Use a tax code of the document's tax regime, or select the regime the code belongs to.",
  },
```

The `error-codes` build check is satisfied from this commit onward because the token occurs as a string literal in `packages/domain/src/tax/engine.ts`, which is inside `packages/**/src/**`.

`packages/db/src/posting/errors.ts` — **amendment A4**, one member added to the union and nothing else in the file:

```ts
export type PostingErrorCode =
  | "ERR_NOT_FOUND" | "ERR_DOC_STATUS_ILLEGAL" | "ERR_DOC_NO_LINES" | "ERR_POLICY_NOT_FOUND"
  | "ERR_POLICY_INVALID" | "ERR_POLICY_REQUIRES_MISSING" | "ERR_PERIOD_NOT_FOUND" | "ERR_PERIOD_NOT_OPEN"
  | "ERR_LEDGER_UNBALANCED"
  | "ERR_RATE_NOT_FOUND"                 // 4B, amendment 11
  | "ERR_TAX_REGIME_MISMATCH";           // 5A, amendment A4 — §4.3.8 has listed it since the registry
```

`packages/db/src/tax/index.ts` is created as an **empty module** — a comment naming Tasks 7 and 8 plus `export {};` — and `packages/db/src/index.ts` gains `export * from "./tax";`, so the barrel edit happens once, here, rather than twice:

```ts
// packages/db/src/tax/index.ts — the barrel `packages/db/src/index.ts` re-exports.
// Task 7 fills it with `./codes` and `./compute`; Task 8 adds `./returns`. Until then it is
// deliberately empty.
//
// `export {}` is NOT decorative. A .ts file containing only comments is a global SCRIPT, not a
// module, and `export * from "./tax"` against a script is TS2306 ("File … is not a module") — so
// without this line Step 6's `bun run typecheck` cannot go green and the loop this task closes
// would not close.
export {};
```

Task 7 **replaces** `export {};` with its two named re-export lines from `./codes` and `./compute` (Step 8 of that task), and Task 8 adds `./returns`; the stub does not linger beside them.

- [ ] **Step 6: Run to pass, then commit**

```bash
bun run --cwd packages/domain test -- tax/ && bun run typecheck && bun run lint:rules
```

The two property cases run 10⁴ times each; if `bun run --cwd packages/domain test` exceeds its timeout on a slow machine, **do not lower `numRuns`** — raise the file's `testTimeout`. The count is what makes the inclusive identity a claim rather than an anecdote.

```bash
git add packages/domain/src/tax/ packages/domain/src/index.ts packages/domain/test/tax/ \
        packages/contracts/src/errors.ts packages/db/src/posting/errors.ts \
        packages/db/src/tax/index.ts packages/db/src/index.ts
git commit -m "$(cat <<'EOF'
feat(domain): add the pure tax engine and the one canonicaliser [5A T5]

§4.9.1 verbatim. One rounding call with the CODE's declared mode (LEGACY-019), one regime
discriminator that refuses a foreign code instead of applying it (LEGACY-020), and an
inclusive extraction whose base + tax equals the entered amount exactly -- asserted over
10^4 rates. canonicalJson is the byte-identity test 26 needs and the hash input §4.9.3
gives 5B. PostingErrorCode gains ERR_TAX_REGIME_MISMATCH (amendment A4).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The Malaysia jurisdiction pack, the `tax` sub-pack and its loader

**No migration.** §4.9.1's `JurisdictionPack` with amendment A3's `RegimeDefinition`, the `malaysiaPack` const, the `packages/db/seed/my/tax/` sub-pack and the `--only tax` loader §3.4.8 assigns 5A. This is the "pluggable jurisdiction pack" the Phase 5 row demands (spec:2291) and the extension of spec:1242's "country seed-data packs … the Syria/Lebanon/Simple pattern is exactly right".

**The one thing to understand before writing a line of it.** `malaysiaPack` is a **pure module-level const** and `TaxRegime.id` is a **per-tenant uuid**, so the pack cannot hold database rows — which is what amendment A3 fixes. The pack holds **regime definitions** keyed `(code, version)`, each carrying its box layout; `buildReturn` receives the tenant's `TaxRegime` **row** and matches it to a definition by that pair. A regime the pack does not know is refused with `ERR_TAX_REGIME_MISMATCH`: **a regime with no box layout is a mismatch, not an empty return.**

**And the second: `SYNTH-MY-v1` is the only definition that ships.** Hazard 1 and §2.6's card forbid a published Malaysian rate, code name, box name or threshold in any plan, test, fixture, seed file or comment. The shipped definition is therefore a complete, testable, obviously-synthetic regime — four codes, two invented rates, five boxes with generic labels — and **Task 10 (OD-15) is the only door the verified definition comes through**. Nothing about the interfaces changes when it does: a second entry in `MALAYSIA_REGIMES` and a second pair of files under `seed/my/tax/`.

**Files:**
- Create: `packages/domain/src/tax/jurisdiction.ts`, `packages/domain/src/tax/malaysia.ts`, `packages/domain/src/tax/pack-schema.ts`, `packages/domain/tax-pack.schema.json`
- Create: `packages/db/src/seed/tax.ts`
- Create: `packages/db/seed/my/tax/SYNTH-MY-v1.regime.json`, `packages/db/seed/my/tax/SYNTH-MY-v1.codes.json`, `packages/db/seed/my/tax/README.md`
- Create: `packages/domain/test/tax/malaysia.test.ts`, `packages/db/test/seed/tax-pack.test.ts`
- Modify: `packages/domain/src/tax/index.ts`, `packages/db/src/seed/types.ts`, `packages/db/src/seed/packs.ts`, `packages/db/src/seed/index.ts`

**Interfaces**

- Consumes: `Money`, `currency`, `CurrencyCode` (§4.2.1); `taxEngine`, `TaxRegime`, `TaxCodeDef`, `canonicalJson`, `producesNoTax`, `TaxError` (T5); `PackLoader`, `LoaderContext`, `SubPack`, `SUB_PACKS`, `SUB_PACK_DIRECTORIES`, `PHASE_0_SUB_PACK_DIRECTORIES`, `OWNED_ELSEWHERE`, `readPackFile`, `assertPackShape`, `SeedError` (§4.2.13, 0C + 2C); `app.tax_regime`, `app.tax_code`, `app.account` (T1); `Ajv` (1A added it to `packages/domain`).
- Produces:

```ts
// packages/domain/src/tax/jurisdiction.ts
export interface ReturnBox { readonly code: string; readonly label: string; readonly amount: Money }   // §4.9.1
/** A box's RULE, in the definition rather than in code: which transaction kinds feed it, and which of the
 *  two measures. `codes` empty means "every code of that kind". */
export interface ReturnBoxDef {
  readonly code: string; readonly label: string;
  readonly kinds: readonly TaxCodeDef["kind"][];
  readonly measure: "base" | "tax";
  readonly codes?: readonly string[];
}
/** Amendment A3: the pack holds DEFINITIONS keyed (code, version), never database rows. */
export interface RegimeDefinition {
  readonly code: string; readonly version: number; readonly jurisdiction: "MY";
  readonly boxes: readonly ReturnBoxDef[];
}
/** Amendment A5 — the row shape §4 leaves open as 5A's own. Declared HERE, in core, because a pure
 *  `buildReturn` consumes it; `packages/db/src/tax/returns.ts` builds it from the §4.9.2 table. */
export interface TaxTransactionRow {
  readonly documentId: string; readonly documentTypeCode: string; readonly lineNo: number;
  readonly taxCodeId: string; readonly taxCode: string; readonly regimeId: string;
  readonly kind: TaxCodeDef["kind"]; readonly rate: string;
  readonly base: Money; readonly tax: Money; readonly baseBase: Money; readonly taxBase: Money;
  readonly effectiveDate: string; readonly postingSeq: string;
}
export interface JurisdictionPack {                                                            // §4.9.1
  readonly jurisdiction: "MY";
  readonly regimes: readonly RegimeDefinition[];
  buildReturn(input: { regime: TaxRegime; periodStart: string; periodEnd: string;
                       transactions: readonly TaxTransactionRow[] }): { boxes: ReturnBox[]; payload: string };
  validateReturn(payload: string): { ok: boolean; errors: string[] };
}

// packages/domain/src/tax/pack-schema.ts
export interface TaxPackValidation { ok: boolean; errors: { path: string; message: string }[] }
/** One tax sub-pack file against `tax-pack.schema.json`. A report, never a throw — `taxLoader` turns it
 *  into a `SeedError` naming the file and the JSON path. */
export function validateTaxPack(file: unknown): TaxPackValidation;

// packages/domain/src/tax/malaysia.ts
export const SYNTH_MY_V1: RegimeDefinition;          // the only definition until OD-15 (Task 10)
export const MALAYSIA_REGIMES: readonly RegimeDefinition[];
export const malaysiaPack: JurisdictionPack;          // §4.9.1's one v1 pack (D21; GCC deferred)

// packages/db/src/seed/tax.ts
export interface TaxRegimeManifest {
  code: string; version: number; jurisdiction: "MY"; effectiveFrom: string; effectiveTo?: string | null;
  nameEn: string; nameAr?: string; source: string;
}
export interface TaxCodeManifest {
  regimeCode: string; regimeVersion: number;
  codes: { code: string; nameEn: string; nameAr?: string; rate: string;
           kind: "output" | "input" | "exempt" | "zero" | "out_of_scope";
           roundingMode: "HALF_AWAY_FROM_ZERO" | "HALF_EVEN" | "TOWARD_ZERO" | "AWAY_FROM_ZERO";
           accountCode: string | null; effectiveFrom: string; effectiveTo?: string | null }[];
}
export function taxFileNames(regimeCode: string): { regime: string; codes: string };
export const taxLoader: PackLoader;                   // name: "tax"; returns the number of ROWS INSERTED
```

- [ ] **Step 1: Write the failing tests**

`packages/domain/test/tax/malaysia.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Money, currency } from "../../src";
import { MALAYSIA_REGIMES, malaysiaPack, SYNTH_MY_V1,
         type TaxRegime, type TaxTransactionRow } from "../../src/tax";

const MYR = currency("MYR");
const m = (v: string) => Money.of(v, MYR);
const REGIME: TaxRegime = { id: "r-1", code: "SYNTH-MY-v1", jurisdiction: "MY", version: 1,
                            effectiveFrom: "2026-01-01", effectiveTo: null };

const txn = (over: Partial<TaxTransactionRow>): TaxTransactionRow => ({
  documentId: "d-1", documentTypeCode: "SALES_INVOICE", lineNo: 1, taxCodeId: "c-1",
  taxCode: "SYN-OUT-STD", regimeId: "r-1", kind: "output", rate: "0.11000000",
  base: m("300.0000"), tax: m("33.0000"), baseBase: m("300.0000"), taxBase: m("33.0000"),
  effectiveDate: "2026-01-15", postingSeq: "1", ...over,
});

describe("malaysiaPack (§4.9.1, amendment A3)", () => {
  it("ships exactly ONE regime definition until OD-15 — and no published figure or name (hazard 1)", () => {
    expect(MALAYSIA_REGIMES).toEqual([SYNTH_MY_V1]);
    expect(SYNTH_MY_V1.code).toBe("SYNTH-MY-v1");
    expect(malaysiaPack.jurisdiction).toBe("MY");
    // No box label, box code or regime code may resemble a published Malaysian one (hazard 1, §2.6).
    const text = JSON.stringify(MALAYSIA_REGIMES);
    for (const forbidden of ["SST", "GST", "TX", "ZRL", "ES43", "MyInvois", "LHDN", "0.06", "0.08", "0.1000"]) {
      expect(text, `${forbidden} must not appear in a shipped definition`).not.toContain(forbidden);
    }
  });

  it("the five synthetic boxes cover every kind exactly once per measure", () => {
    expect(SYNTH_MY_V1.boxes.map((b) => b.code)).toEqual(["S1", "S2", "S3", "P1", "P2"]);
    expect(SYNTH_MY_V1.boxes.map((b) => b.measure)).toEqual(["base", "tax", "base", "base", "tax"]);
  });

  it("buildReturn sums each box from the transactions and NOTHING else", () => {
    const { boxes } = malaysiaPack.buildReturn({
      regime: REGIME, periodStart: "2026-01-01", periodEnd: "2026-03-31",
      // ⚠️ Every override sets the BASE-CURRENCY twins as well as the document-currency figures.
      // `buildReturnFrom` sums `baseBase` / `taxBase` — a return is filed in base currency — so overriding
      // only `base` / `tax` would leave the `txn()` defaults (300 / 33) in the columns the boxes actually
      // read, and every assertion below would be measuring the default rather than the case.
      transactions: [
        txn({}),                                                                       // output 300 / 33
        txn({ documentId: "d-2", base: m("100.0000"), tax: m("11.0000"),
              baseBase: m("100.0000"), taxBase: m("11.0000") }),                       // output 100 / 11
        txn({ documentId: "d-3", documentTypeCode: "SALES_CREDIT_NOTE",
              base: m("-50.0000"), tax: m("-5.5000"),
              baseBase: m("-50.0000"), taxBase: m("-5.5000") }),                       // credit note, signed
        txn({ documentId: "d-4", taxCode: "SYN-OUT-ZERO", taxCodeId: "c-2", kind: "zero",
              rate: "0.00000000", base: m("70.0000"), tax: m("0.0000"),
              baseBase: m("70.0000"), taxBase: m("0.0000") }),
        txn({ documentId: "d-5", documentTypeCode: "PURCHASE_INVOICE", taxCode: "SYN-IN-STD",
              taxCodeId: "c-3", kind: "input", base: m("200.0000"), tax: m("22.0000"),
              baseBase: m("200.0000"), taxBase: m("22.0000") }),
      ],
    });
    const box = (c: string) => boxes.find((b) => b.code === c)!.amount.toString();
    expect(box("S1")).toBe("350.0000");     // 300 + 100 - 50 : output baseBase, signed
    expect(box("S2")).toBe("38.5000");      // 33 + 11 - 5.5   : output taxBase, signed
    expect(box("S3")).toBe("70.0000");      // zero-rated baseBase
    expect(box("P1")).toBe("200.0000");
    expect(box("P2")).toBe("22.0000");
  });

  it("the boxes read the BASE-currency twins, not the document-currency figures", () => {
    // The one case that separates them. A foreign-currency invoice carries `base`/`tax` in the document's
    // currency and `baseBase`/`taxBase` in the company's; a return is filed in the company's, so a box that
    // summed `base` would add EUR to MYR. Written as its own case because the case above sets the two pairs
    // equal on every row, which is exactly the shape that cannot tell them apart.
    const { boxes } = malaysiaPack.buildReturn({
      regime: REGIME, periodStart: "2026-01-01", periodEnd: "2026-03-31",
      transactions: [txn({ base: m("100.0000"), tax: m("11.0000"),
                           baseBase: m("470.0000"), taxBase: m("51.7000") })],
    });
    expect(boxes.find((b) => b.code === "S1")!.amount.toString()).toBe("470.0000");
    expect(boxes.find((b) => b.code === "S2")!.amount.toString()).toBe("51.7000");
  });

  it("a box with no matching transaction is present and ZERO, never absent (LEGACY-011's shape)", () => {
    const { boxes } = malaysiaPack.buildReturn({
      regime: REGIME, periodStart: "2026-01-01", periodEnd: "2026-03-31", transactions: [],
    });
    expect(boxes).toHaveLength(5);
    for (const b of boxes) expect(b.amount.toString(), b.code).toBe("0.0000");
  });

  it("the payload is canonical, carries the regime and the period, and is byte-identical across calls", () => {
    const input = { regime: REGIME, periodStart: "2026-01-01", periodEnd: "2026-03-31",
                    transactions: [txn({})] };
    const a = malaysiaPack.buildReturn(input);
    const b = malaysiaPack.buildReturn({ ...input, transactions: [txn({})] });
    expect(a.payload).toBe(b.payload);
    expect(a.payload).toContain('"regimeCode":"SYNTH-MY-v1"');
    expect(a.payload).toContain('"periodStart":"2026-01-01"');
    expect(a.payload.startsWith("{")).toBe(true);
    expect(a.payload).not.toMatch(/\s/);                          // no whitespace at all
  });

  it("transaction ORDER does not change the payload — a return is not a report of rows", () => {
    const one = txn({ documentId: "d-1" });
    const two = txn({ documentId: "d-2", base: m("100.0000"), tax: m("11.0000") });
    const fwd = malaysiaPack.buildReturn({ regime: REGIME, periodStart: "2026-01-01",
      periodEnd: "2026-03-31", transactions: [one, two] });
    const rev = malaysiaPack.buildReturn({ regime: REGIME, periodStart: "2026-01-01",
      periodEnd: "2026-03-31", transactions: [two, one] });
    expect(fwd.payload).toBe(rev.payload);
  });

  it("a transaction outside the period is REFUSED, not silently included (LEGACY-059)", () => {
    expect(() => malaysiaPack.buildReturn({
      regime: REGIME, periodStart: "2026-01-01", periodEnd: "2026-03-31",
      transactions: [txn({ effectiveDate: "2026-04-01" })],
    })).toThrow(/ERR_TAX_REGIME_MISMATCH: document d-1 line 1 is dated 2026-04-01, outside 2026-01-01\.\.2026-03-31/);
  });

  it("a transaction of another regime is REFUSED (LEGACY-020, spec:2444's clause)", () => {
    expect(() => malaysiaPack.buildReturn({
      regime: REGIME, periodStart: "2026-01-01", periodEnd: "2026-03-31",
      transactions: [txn({ regimeId: "r-OTHER" })],
    })).toThrow(/ERR_TAX_REGIME_MISMATCH: document d-1 line 1 carries regime r-OTHER/);
  });

  it("a regime the pack does not KNOW is a mismatch, not an empty return (amendment A3)", () => {
    expect(() => malaysiaPack.buildReturn({
      regime: { ...REGIME, code: "SYNTH-MY-v9", version: 9 },
      periodStart: "2026-01-01", periodEnd: "2026-03-31", transactions: [],
    })).toThrow(/ERR_TAX_REGIME_MISMATCH: this pack has no definition for SYNTH-MY-v9 v9/);
  });

  it("validateReturn accepts what buildReturn produced and names what it refuses", () => {
    const { payload } = malaysiaPack.buildReturn({ regime: REGIME, periodStart: "2026-01-01",
      periodEnd: "2026-03-31", transactions: [txn({})] });
    expect(malaysiaPack.validateReturn(payload)).toEqual({ ok: true, errors: [] });
    expect(malaysiaPack.validateReturn("not json")).toMatchObject({ ok: false });
    const missing = JSON.parse(payload) as { boxes: unknown[] };
    missing.boxes = missing.boxes.slice(1);
    expect(malaysiaPack.validateReturn(JSON.stringify(missing)))
      .toEqual({ ok: false, errors: ["box S1 is missing"] });
    const bad = JSON.parse(payload) as { boxes: { code: string; amount: string }[] };
    bad.boxes[0]!.amount = "300";
    expect(malaysiaPack.validateReturn(JSON.stringify(bad)))
      .toEqual({ ok: false, errors: ['box S1 amount "300" is not a 4-dp figure'] });
  });
});
```

`packages/db/test/seed/tax-pack.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { assertPackShape, PHASE_0_SUB_PACK_DIRECTORIES, SUB_PACKS, taxLoader,
         type LoaderContext } from "../../src/seed";
import { startDb, withTenant, type Db } from "../harness";
import { seedAccount, seedTenantV2, type Seed } from "../fixtures";

const PACK = fileURLToPath(new URL("../../seed/my/", import.meta.url));

let db: Db;
let a: Seed;
const ctx = (over: Partial<LoaderContext> = {}): LoaderContext => ({
  config: { tenantId: a.tenant } as never, tenantId: a.tenant, companyId: a.company,
  systemPrincipalId: a.system, packRoot: PACK, ...over,
});

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "taxpack");
  await seedAccount(db, a, { code: "2300", nameEn: "Output tax payable", type: "liability" });
  await seedAccount(db, a, { code: "1350", nameEn: "Input tax receivable", type: "asset" });
}, 180_000);
afterAll(async () => { await db?.stop(); });

describe("the tax sub-pack and its loader (§3.4.8, §4.2.13, amendment A6)", () => {
  it("SUB_PACKS carries tax LAST, in application order", () => {
    expect(SUB_PACKS).toEqual(["roles", "dimensions", "fiscal-periods", "chart-of-accounts",
                               "document-types", "templates", "tax"]);
    expect(PHASE_0_SUB_PACK_DIRECTORIES).toContain("tax");
  });

  it("assertPackShape now admits the tax directory and still names an unshipped owner", () => {
    expect(() => assertPackShape(PACK)).not.toThrow();
    const { mkdtempSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const fake = mkdtempSync(join(tmpdir(), "pack-"));
    for (const d of PHASE_0_SUB_PACK_DIRECTORIES) mkdirSync(join(fake, d));
    expect(() => assertPackShape(fake)).not.toThrow();
    mkdirSync(join(fake, "reports"));
    expect(() => assertPackShape(fake)).toThrow(/reports\/ is slice 7A's and its loader has not shipped/);
  });

  it("the loader inserts the regime, then its codes, and links each account by §4.15 code", async () => {
    const inserted = await withTenant(db.rw, a.tenant, a.system, (tx) => taxLoader.load(tx, ctx()));
    expect(inserted).toBe(5);                                        // 1 regime + 4 codes
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [r] = await tx<{ code: string; version: number; source: string; jurisdiction: string }[]>`
        select code, version, source, jurisdiction from app.tax_regime where company_id = ${a.company}`;
      expect(r).toMatchObject({ code: "SYNTH-MY-v1", version: 1, jurisdiction: "MY" });
      expect(r!.source).toContain("SYNTHETIC-TEST-v1");
      const codes = await tx<{ code: string; kind: string; rate: string;
                              output_account_id: string | null; input_account_id: string | null }[]>`
        select c.code, c.kind, c.rate::text as rate, c.output_account_id, c.input_account_id
          from app.tax_code c where c.company_id = ${a.company} order by c.code`;
      expect(codes.map((c) => c.code))
        .toEqual(["SYN-EXEMPT", "SYN-IN-STD", "SYN-OUT-STD", "SYN-OUT-ZERO"]);
      expect(codes.find((c) => c.code === "SYN-OUT-STD")!.rate).toBe("0.11000000");
      expect(codes.find((c) => c.code === "SYN-OUT-STD")!.output_account_id).not.toBeNull();
      expect(codes.find((c) => c.code === "SYN-IN-STD")!.input_account_id).not.toBeNull();
      expect(codes.find((c) => c.code === "SYN-EXEMPT")!.output_account_id).toBeNull();
    });
  });

  it("is idempotent — a second load inserts zero rows (§3.4.8, spec:2002)", async () => {
    expect(await withTenant(db.rw, a.tenant, a.system, (tx) => taxLoader.load(tx, ctx()))).toBe(0);
  });

  it("every rate and every code name in the shipped pack is synthetic (hazard 1, §2.6)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = `${PACK}tax/`;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(["SYNTH-MY-v1.codes.json", "SYNTH-MY-v1.regime.json"]);
    const text = files.map((f) => readFileSync(`${dir}${f}`, "utf8")).join("\n");
    for (const forbidden of ["SST", "GST", "\"TX\"", "ZRL", "ES43", "0.06", "0.08", "MyInvois", "LHDN"]) {
      expect(text, `${forbidden} must not appear in a shipped seed file`).not.toContain(forbidden);
    }
    expect(text).toContain("SYNTHETIC-TEST-v1 — not a published figure (OD-15)");
  });

  it("a missing chart account fails LOUDLY, naming §3.4.8's ordering rule", async () => {
    const b = await seedTenantV2(db, "taxpack-noacct");   // no 2300, no 1350
    await expect(withTenant(db.rw, b.tenant, b.system,
      (tx) => taxLoader.load(tx, ctx({ tenantId: b.tenant, companyId: b.company, systemPrincipalId: b.system }))),
    ).rejects.toThrow(/account 2300 is not seeded for this company — seed --only chart-of-accounts first/);
  });

  it("a pack directory with no tax/ names the directory rather than throwing ENOENT", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const empty = mkdtempSync(join(tmpdir(), "notax-"));
    await expect(withTenant(db.rw, a.tenant, a.system,
      (tx) => taxLoader.load(tx, ctx({ packRoot: empty }))),
    ).rejects.toThrow(/is not a readable directory — a tax pack needs it/);
  });
});
```

- [ ] **Step 2: Run them and see the exact expected failure**

```bash
bun run --cwd packages/domain test -- tax/malaysia && bun run --cwd packages/db test -- seed/tax-pack
```

Expected: `Error: Failed to load url ../../src/tax` is gone (T5 created the barrel) and instead

```
FAIL  test/tax/malaysia.test.ts
SyntaxError: The requested module '../../src/tax' does not provide an export named 'malaysiaPack'

FAIL  test/seed/tax-pack.test.ts > … > SUB_PACKS carries tax LAST …
AssertionError: expected [ 'roles', …, 'templates' ] to deeply equal [ …, 'tax' ]
```

- [ ] **Step 3: Write `jurisdiction.ts`**

```ts
// packages/domain/src/tax/jurisdiction.ts
import { Money } from "../money/money";
import type { CurrencyCode } from "../money/money";
import { canonicalJson } from "./canonical";
import { TaxError, type TaxCodeDef, type TaxRegime } from "./engine";

export interface ReturnBox { readonly code: string; readonly label: string; readonly amount: Money }

/** A box's RULE lives in the DEFINITION, not in code: which code kinds feed it, which measure it sums, and
 *  optionally which specific codes. `codes` omitted means "every code of those kinds". A box whose rule is
 *  in TypeScript is LEGACY-020's hardcoded 0.06 in a different coat. */
export interface ReturnBoxDef {
  readonly code: string;
  readonly label: string;
  readonly kinds: readonly TaxCodeDef["kind"][];
  readonly measure: "base" | "tax";
  readonly codes?: readonly string[];
}

/** Amendment A3. A pack is a pure const and `TaxRegime.id` is a per-tenant uuid, so the pack holds
 *  DEFINITIONS keyed `(code, version)` and `buildReturn` matches the tenant's row to one of them. */
export interface RegimeDefinition {
  readonly code: string;
  readonly version: number;
  readonly jurisdiction: "MY";
  readonly boxes: readonly ReturnBoxDef[];
}

/** Amendment A5. `packages/db/src/tax/returns.ts` builds these from the §4.9.2 table. */
export interface TaxTransactionRow {
  readonly documentId: string; readonly documentTypeCode: string; readonly lineNo: number;
  readonly taxCodeId: string; readonly taxCode: string; readonly regimeId: string;
  readonly kind: TaxCodeDef["kind"]; readonly rate: string;
  readonly base: Money; readonly tax: Money; readonly baseBase: Money; readonly taxBase: Money;
  readonly effectiveDate: string; readonly postingSeq: string;
}

export interface JurisdictionPack {
  readonly jurisdiction: "MY";
  readonly regimes: readonly RegimeDefinition[];
  /** Deterministic: the same `tax_transaction` rows produce a byte-identical return (test 26). */
  buildReturn(input: { regime: TaxRegime; periodStart: string; periodEnd: string;
                       transactions: readonly TaxTransactionRow[] }):
    { boxes: ReturnBox[]; payload: string };
  validateReturn(payload: string): { ok: boolean; errors: string[] };
}

const AMOUNT_4DP = /^-?\d+\.\d{4}$/;

/**
 * The shared implementation every jurisdiction pack uses. Exported inside the module only — a pack is the
 * public surface (§4.9.1 names `malaysiaPack`), and a second jurisdiction (GCC, deferred by D21) would call
 * this with its own definitions rather than writing a second summing loop.
 *
 * **The three refusals, all of them LEGACY-020 or LEGACY-059:** a regime the pack does not define; a transaction
 * carrying another regime's id; a transaction dated outside the requested period. Every one is a
 * `TaxError("ERR_TAX_REGIME_MISMATCH")` naming the document and line — never a filtered-out row, because a
 * silently dropped transaction is exactly the "valid query with the period filter missing" of LEGACY-059 in
 * reverse, and the caller's own SQL is what bounds the period (§4.9.2's index).
 */
export function buildReturnFrom(
  definitions: readonly RegimeDefinition[],
  input: { regime: TaxRegime; periodStart: string; periodEnd: string;
           transactions: readonly TaxTransactionRow[] },
  currencyOf: (rows: readonly TaxTransactionRow[]) => CurrencyCode,
): { boxes: ReturnBox[]; payload: string } {
  const { regime, periodStart, periodEnd, transactions } = input;
  const def = definitions.find((d) => d.code === regime.code && d.version === regime.version);
  if (!def) {
    throw new TaxError("ERR_TAX_REGIME_MISMATCH",
      `this pack has no definition for ${regime.code} v${regime.version} — ` +
      `it defines ${definitions.map((d) => `${d.code} v${d.version}`).join(", ") || "nothing"}`);
  }
  for (const t of transactions) {
    if (t.regimeId !== regime.id) {
      throw new TaxError("ERR_TAX_REGIME_MISMATCH",
        `document ${t.documentId} line ${t.lineNo} carries regime ${t.regimeId}, not ${regime.id}`);
    }
    if (t.effectiveDate < periodStart || t.effectiveDate > periodEnd) {
      throw new TaxError("ERR_TAX_REGIME_MISMATCH",
        `document ${t.documentId} line ${t.lineNo} is dated ${t.effectiveDate}, ` +
        `outside ${periodStart}..${periodEnd}`);
    }
  }
  const ccy = currencyOf(transactions);
  const boxes: ReturnBox[] = def.boxes.map((b) => {
    let sum = Money.zero(ccy);
    for (const t of transactions) {
      if (!b.kinds.includes(t.kind)) continue;
      if (b.codes && !b.codes.includes(t.taxCode)) continue;
      // The BASE-currency measure is what a return is filed in: baseBase / taxBase, never the document
      // currency's base / tax, which would add MYR to EUR (spec:2041 makes that a compile error anyway).
      sum = sum.add(b.measure === "base" ? t.baseBase : t.taxBase);
    }
    return { code: b.code, label: b.label, amount: sum };
  });
  const payload = canonicalJson({
    regimeCode: regime.code,
    regimeVersion: regime.version,
    jurisdiction: def.jurisdiction,
    periodStart,
    periodEnd,
    currency: ccy,
    boxes: boxes.map((b) => ({ code: b.code, label: b.label, amount: b.amount.toString() })),
  });
  return { boxes, payload };
}

/** The other half: re-parse a payload and check it against the definitions. Returns a REPORT rather than
 *  throwing, because the caller names every fault at once (the `validatePolicy` shape of §4.4.2). */
export function validateReturnAgainst(
  definitions: readonly RegimeDefinition[],
  payload: string,
): { ok: boolean; errors: string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(payload); }
  catch (e) { return { ok: false, errors: [`payload is not JSON: ${String(e)}`] }; }
  const p = parsed as { regimeCode?: unknown; regimeVersion?: unknown; periodStart?: unknown;
                        periodEnd?: unknown; currency?: unknown; boxes?: unknown };
  const errors: string[] = [];
  if (typeof p.regimeCode !== "string") errors.push("regimeCode is missing");
  if (typeof p.regimeVersion !== "number") errors.push("regimeVersion is missing");
  for (const k of ["periodStart", "periodEnd", "currency"] as const) {
    if (typeof p[k] !== "string") errors.push(`${k} is missing`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const def = definitions.find((d) => d.code === p.regimeCode && d.version === p.regimeVersion);
  if (!def) return { ok: false, errors: [`no definition for ${String(p.regimeCode)} v${String(p.regimeVersion)}`] };
  if (!Array.isArray(p.boxes)) return { ok: false, errors: ["boxes is not an array"] };
  const seen = new Map((p.boxes as { code?: unknown; amount?: unknown }[])
    .map((b) => [String(b.code), b] as const));
  for (const b of def.boxes) {
    const got = seen.get(b.code);
    if (!got) { errors.push(`box ${b.code} is missing`); continue; }
    if (typeof got.amount !== "string" || !AMOUNT_4DP.test(got.amount)) {
      errors.push(`box ${b.code} amount ${JSON.stringify(got.amount)} is not a 4-dp figure`);
    }
  }
  for (const code of seen.keys()) {
    if (!def.boxes.some((b) => b.code === code)) errors.push(`box ${code} is not in ${def.code} v${def.version}`);
  }
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4: Write `malaysia.ts`**

```ts
// packages/domain/src/tax/malaysia.ts
import { currency, type CurrencyCode } from "../money/money";
import { buildReturnFrom, validateReturnAgainst,
         type JurisdictionPack, type RegimeDefinition, type TaxTransactionRow } from "./jurisdiction";

/**
 * **The only regime definition that ships, and it is deliberately synthetic.**
 *
 * Contracts hazard 1 and §2.6's 5A card forbid a published Malaysian rate, code name, box name, threshold
 * or deadline in any plan, test, fixture, seed file or comment; hazard 2 forbids any LHDN or MyInvois
 * detail until an ADR records it from the authority's own current documentation. `SYNTH-MY-v1` is therefore
 * a complete, testable regime whose every literal is invented: five generic boxes, four synthetic code
 * names, and the two rates `0.11000000` and `0.00000000` that `SYNTH-MY-v1.codes.json` ships — an
 * eleven-per-cent figure chosen so it cannot be mistaken for a published one (Global Constraint 15).
 *
 * **OD-15 is the only door the verified definition comes through** (this slice's Task 10, ADR 0049). When it
 * lands, a second `RegimeDefinition` joins `MALAYSIA_REGIMES` and a second pair of files joins
 * `packages/db/seed/my/tax/`. No interface, no signature and no test in this file changes: `buildReturn`
 * matches the tenant's regime row to a definition by `(code, version)` and a tenant on the verified regime
 * simply matches the other entry.
 */
export const SYNTH_MY_V1: RegimeDefinition = {
  code: "SYNTH-MY-v1",
  version: 1,
  jurisdiction: "MY",
  boxes: [
    { code: "S1", label: "Standard-rated supplies (value)", kinds: ["output"], measure: "base" },
    { code: "S2", label: "Tax on standard-rated supplies", kinds: ["output"], measure: "tax" },
    { code: "S3", label: "Zero-rated and exempt supplies (value)", kinds: ["zero", "exempt"], measure: "base" },
    { code: "P1", label: "Taxable purchases (value)", kinds: ["input"], measure: "base" },
    { code: "P2", label: "Tax on taxable purchases", kinds: ["input"], measure: "tax" },
  ],
};

/** Grown by Task 10 (OD-15) and by nothing else. */
export const MALAYSIA_REGIMES: readonly RegimeDefinition[] = [SYNTH_MY_V1];

/** Every transaction of one return is in the company's base currency (`baseBase` / `taxBase`), so the
 *  currency is one value. An empty period still needs one for `Money.zero`, and MYR is the first customer's
 *  base (spec:2039's `Asia/Kuala_Lumpur` company) — the caller passes real rows in every other case. */
function returnCurrency(rows: readonly TaxTransactionRow[]): CurrencyCode {
  return rows[0]?.baseBase.currency ?? currency("MYR");
}

/** §4.9.1's one v1 pack. The GCC pack is deferred until a customer there exists (D21, spec:2226). */
export const malaysiaPack: JurisdictionPack = {
  jurisdiction: "MY",
  regimes: MALAYSIA_REGIMES,
  buildReturn: (input) => buildReturnFrom(MALAYSIA_REGIMES, input, returnCurrency),
  validateReturn: (payload) => validateReturnAgainst(MALAYSIA_REGIMES, payload),
};
```

`packages/domain/src/tax/index.ts` gains:

```ts
export { buildReturnFrom, validateReturnAgainst,
         type JurisdictionPack, type RegimeDefinition, type ReturnBox, type ReturnBoxDef,
         type TaxTransactionRow } from "./jurisdiction";
export { MALAYSIA_REGIMES, malaysiaPack, SYNTH_MY_V1 } from "./malaysia";
```

- [ ] **Step 5: Write the two pack files, the pack schema and the README**

`packages/db/seed/my/tax/SYNTH-MY-v1.regime.json`:

```json
{
  "code": "SYNTH-MY-v1",
  "version": 1,
  "jurisdiction": "MY",
  "effectiveFrom": "2026-01-01",
  "effectiveTo": null,
  "nameEn": "Synthetic Malaysia regime v1 (placeholder)",
  "nameAr": "نظام ضريبي ماليزي اختباري ١ (مؤقت)",
  "source": "SYNTHETIC-TEST-v1 — not a published figure (OD-15)"
}
```

`packages/db/seed/my/tax/SYNTH-MY-v1.codes.json`:

```json
{
  "regimeCode": "SYNTH-MY-v1",
  "regimeVersion": 1,
  "codes": [
    {
      "code": "SYN-OUT-STD", "nameEn": "Standard-rated supply (synthetic)",
      "nameAr": "توريد بالنسبة القياسية (اختباري)", "rate": "0.11000000", "kind": "output",
      "roundingMode": "HALF_AWAY_FROM_ZERO", "accountCode": "2300", "effectiveFrom": "2026-01-01"
    },
    {
      "code": "SYN-OUT-ZERO", "nameEn": "Zero-rated supply (synthetic)",
      "nameAr": "توريد بنسبة صفرية (اختباري)", "rate": "0.00000000", "kind": "zero",
      "roundingMode": "HALF_AWAY_FROM_ZERO", "accountCode": null, "effectiveFrom": "2026-01-01"
    },
    {
      "code": "SYN-IN-STD", "nameEn": "Taxable purchase (synthetic)",
      "nameAr": "شراء خاضع للضريبة (اختباري)", "rate": "0.11000000", "kind": "input",
      "roundingMode": "HALF_AWAY_FROM_ZERO", "accountCode": "1350", "effectiveFrom": "2026-01-01"
    },
    {
      "code": "SYN-EXEMPT", "nameEn": "Exempt supply (synthetic)",
      "nameAr": "توريد معفى (اختباري)", "rate": "0.00000000", "kind": "exempt",
      "roundingMode": "HALF_AWAY_FROM_ZERO", "accountCode": null, "effectiveFrom": "2026-01-01"
    }
  ]
}
```

`packages/db/seed/my/tax/README.md` — six sentences, no figures: this directory is the Malaysia tax sub-pack (§3.4.8, slice 5A); the only regime here is `SYNTH-MY-v1`, whose rates, code names and box labels are invented and whose `source` says so; contracts hazards 1 and 2 forbid a published Malaysian rate, code name or MyInvois detail in this repository until ADR 0049 records the verified set from the authority's own current documentation; when OD-15 lands, add `<REGIME>.regime.json` and `<REGIME>.codes.json` beside these two and a `RegimeDefinition` to `packages/domain/src/tax/malaysia.ts` — **replace nothing**, because a tenant already on the synthetic regime keeps its filed returns readable; the loader is idempotent, so `bun run seed --tenant <id> --only tax` may be re-run after each change; and a rate change is a **seed PR**, never a release (ADR 0050).

`packages/domain/tax-pack.schema.json` — the envelope for the two files above, in full. **`REGIME_CODE` admits a lower-case letter after the first character**: the shipped regime is `SYNTH-MY-v1`, whose `v` is what carries the version in the name (`taxFileNames`), and a pattern of `^[A-Z][A-Z0-9-]{1,31}$` would reject the only pack this slice ships. The **tax-code** pattern stays all-caps — `SYN-OUT-STD`, `SYN-IN-STD` — because a code is an accountant-facing token and mixed case in it is a typo class.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:dulja:tax-pack:1",
  "title": "Dulja tax sub-pack file (5A)",
  "$defs": {
    "regimeCode": { "type": "string", "pattern": "^[A-Z][A-Za-z0-9-]{1,31}$" },
    "taxCode": { "type": "string", "pattern": "^[A-Z][A-Z0-9-]{1,31}$" },
    "date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
    "dateOrNull": {
      "oneOf": [{ "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }, { "type": "null" }]
    }
  },
  "oneOf": [
    {
      "title": "regime manifest — <CODE>.regime.json",
      "type": "object",
      "required": ["code", "version", "jurisdiction", "effectiveFrom", "nameEn", "source"],
      "additionalProperties": false,
      "properties": {
        "code": { "$ref": "#/$defs/regimeCode" },
        "version": { "type": "integer", "minimum": 1 },
        "jurisdiction": { "const": "MY" },
        "effectiveFrom": { "$ref": "#/$defs/date" },
        "effectiveTo": { "$ref": "#/$defs/dateOrNull" },
        "nameEn": { "type": "string", "minLength": 1, "maxLength": 200 },
        "nameAr": { "oneOf": [{ "type": "string", "maxLength": 200 }, { "type": "null" }] },
        "source": { "type": "string", "minLength": 1, "maxLength": 500 }
      }
    },
    {
      "title": "codes manifest — <CODE>.codes.json",
      "type": "object",
      "required": ["regimeCode", "regimeVersion", "codes"],
      "additionalProperties": false,
      "properties": {
        "regimeCode": { "$ref": "#/$defs/regimeCode" },
        "regimeVersion": { "type": "integer", "minimum": 1 },
        "codes": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "required": ["code", "nameEn", "rate", "kind", "roundingMode", "accountCode", "effectiveFrom"],
            "additionalProperties": false,
            "properties": {
              "code": { "$ref": "#/$defs/taxCode" },
              "nameEn": { "type": "string", "minLength": 1, "maxLength": 200 },
              "nameAr": { "oneOf": [{ "type": "string", "maxLength": 200 }, { "type": "null" }] },
              "rate": { "type": "string", "pattern": "^\\d+\\.\\d{8}$" },
              "kind": { "enum": ["output", "input", "exempt", "zero", "out_of_scope"] },
              "roundingMode": {
                "enum": ["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"]
              },
              "accountCode": {
                "oneOf": [{ "type": "string", "pattern": "^[1-5][0-9]{3}$" }, { "type": "null" }]
              },
              "effectiveFrom": { "$ref": "#/$defs/date" },
              "effectiveTo": { "$ref": "#/$defs/dateOrNull" }
            }
          }
        }
      }
    }
  ]
}
```

**The `rate` pattern is what stops a float or a percentage reaching the column**: `"11"` and `"11%"` both fail at seed time rather than becoming an 1100 % tax. `additionalProperties: false` on both shapes is what makes a mistyped key a seed failure rather than a silently ignored line, which is how `roundingMode` would quietly become `HALF_AWAY_FROM_ZERO` for a code that meant `HALF_EVEN`.

`packages/domain/src/tax/pack-schema.ts` — the validator, wired exactly as 1A wired `validatePolicy` and `validateDocumentTypeSeed` (phase-1a:1760-1762), so the CLI's exit code and message form are unchanged:

```ts
// packages/domain/src/tax/pack-schema.ts
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import taxPackSchema from "../../tax-pack.schema.json" with { type: "json" };

export interface TaxPackValidation { ok: boolean; errors: { path: string; message: string }[] }

const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: false });
const taxPackValidator: ValidateFunction = ajv.compile(taxPackSchema);

const toErrors = (errors: ErrorObject[] | null | undefined): { path: string; message: string }[] =>
  (errors ?? []).map((e) => ({
    path: e.instancePath,
    message: `${e.message ?? "is invalid"}${e.params && "additionalProperty" in e.params
      ? ` (${String(e.params.additionalProperty)})` : ""}`,
  }));

/**
 * Validates ONE tax sub-pack file — a regime manifest or a codes manifest — against
 * `tax-pack.schema.json`'s `oneOf`. Returns a report rather than throwing, the `PolicyValidation` shape
 * §4.4.2 already uses, so `taxLoader` can name the file and the JSON path in one `SeedError`.
 *
 * The `oneOf` means a file that satisfies NEITHER branch reports both branches' failures. That is the
 * intended noise: the commonest fault is a codes manifest saved under a `.regime.json` name, and a reader
 * needs to see which shape was expected.
 */
export function validateTaxPack(file: unknown): TaxPackValidation {
  if (!taxPackValidator(file)) return { ok: false, errors: toErrors(taxPackValidator.errors) };
  return { ok: true, errors: [] };
}
```

`packages/domain/src/tax/index.ts` gains `export { validateTaxPack, type TaxPackValidation } from "./pack-schema";`.

- [ ] **Step 6: Write the loader and the four `SubPack` edits**

`packages/db/src/seed/types.ts` — `"tax"` appended **last** (application order: the codes link to accounts by code, so `chart-of-accounts` must already have run):

```ts
export type SubPack =
  | "roles" | "dimensions" | "fiscal-periods" | "chart-of-accounts" | "document-types" | "templates" | "tax";
export const SUB_PACKS: readonly SubPack[] =
  ["roles", "dimensions", "fiscal-periods", "chart-of-accounts", "document-types", "templates", "tax"];
```

`packages/db/src/seed/packs.ts` — `PHASE_0_SUB_PACK_DIRECTORIES` gains `"tax"` (it is the *required-presence* list, widened additively by each loader-owning slice — §4.2.13's settled meaning), and `OWNED_ELSEWHERE` **loses** its `tax` entry, keeping `reports` (7A) and `statutory` (8A). `SUB_PACK_DIRECTORIES` is derived from `SUB_PACKS` (2C) and needs no edit.

`packages/db/src/seed/tax.ts`:

```ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import { validateTaxPack } from "@dulja/domain";
import { SeedError } from "./types";
import { readPackFile } from "./packs";
import type { LoaderContext, PackLoader } from "./types";

export interface TaxRegimeManifest {
  code: string; version: number; jurisdiction: "MY";
  effectiveFrom: string; effectiveTo?: string | null;
  nameEn: string; nameAr?: string; source: string;
}
export interface TaxCodeManifest {
  regimeCode: string; regimeVersion: number;
  codes: {
    code: string; nameEn: string; nameAr?: string; rate: string;
    kind: "output" | "input" | "exempt" | "zero" | "out_of_scope";
    roundingMode: "HALF_AWAY_FROM_ZERO" | "HALF_EVEN" | "TOWARD_ZERO" | "AWAY_FROM_ZERO";
    accountCode: string | null; effectiveFrom: string; effectiveTo?: string | null;
  }[];
}

/**
 * One regime is two files, named from its own **code**, so a second regime cannot overwrite a first.
 *
 * **The code alone must be unique within a pack directory**, and the shipped convention is what makes that
 * true: a regime's version is carried *in* its code (`SYNTH-MY-v1`), so a second version is a second code
 * and a second file pair. The manifest's `version` field is still checked — `taxLoader` refuses a
 * `*.codes.json` whose `regimeVersion` disagrees with its `*.regime.json` — but it is not part of the file
 * name, because `SYNTH-MY-v1-v1.regime.json` would say the same thing twice.
 */
export function taxFileNames(regimeCode: string): { regime: string; codes: string } {
  return { regime: `${regimeCode}.regime.json`, codes: `${regimeCode}.codes.json` };
}

/**
 * The `--only tax` loader (§3.4.8, §4.2.13, amendment A6). Reads every `*.regime.json` under
 * `<packRoot>/tax/`, inserts the regime, then inserts its codes from the matching `*.codes.json`, linking
 * `output_account_id` / `input_account_id` by the §4.15 account CODE.
 *
 * **Returns the number of ROWS INSERTED**, which is `PackLoader.load`'s contract verbatim — zero on a
 * re-run, which is what "changes nothing" means (spec:2002). `on conflict … do nothing` returns no row on a
 * hit, so counting `returning id` results is exact. **`do nothing`, not `do update`:** §3.4.8 reserves
 * `do update` for `posting_policy` alone, and a changed rate is a NEW regime version or a new
 * `effective_from` — never an edit of a row a filed return already points at (LEGACY-020, ADR 0050).
 *
 * **A missing account fails loudly.** `chart-of-accounts` runs earlier in application order, so an absent
 * `2300` is the PACK's problem and not the tenant's; letting it pass would leave `output_account_id` null
 * and `postDocument` would resolve `tax_code.output_account` to nothing at post — the silent-null failure
 * `tax_code_account_for_kind_check` and this check exist together to prevent.
 *
 * **Every file is validated against `tax-pack.schema.json` before anything is read out of it**, through
 * `validateTaxPack` — the shape 1A's `documentTypesLoader` uses for `document-type-seed.schema.json`
 * (§4.3.7). A fault is a `SeedError` naming the file and the JSON path, so the CLI's exit code 1 and its
 * message form are unchanged.
 */
export const taxLoader: PackLoader = {
  name: "tax",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const dir = join(ctx.packRoot, "tax");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".regime.json")).sort();
    } catch (e) {
      throw new SeedError(`${dir} is not a readable directory — a tax pack needs it (§3.4.8): ${String(e)}`);
    }

    // The loader's first act on every object it reads is to validate it against tax-pack.schema.json.
    const check = (file: string, value: unknown): void => {
      const report = validateTaxPack(value);
      if (!report.ok) {
        throw new SeedError(
          `${file} does not match urn:dulja:tax-pack:1: ` +
          report.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; "));
      }
    };

    let inserted = 0;
    for (const file of files) {
      const regime = readPackFile<TaxRegimeManifest>(ctx.packRoot, "tax", file);
      check(file, regime);
      const names = taxFileNames(regime.code);
      if (file !== names.regime) {
        throw new SeedError(`${file}: a regime file must be named ${names.regime} after its own code`);
      }
      // BOTH files are read and checked BEFORE either insert. A rollback would cover the correctness, but
      // a loader that inserts a regime and then rejects its codes reports the second file's fault after
      // having done work — and the CLI's message is the only thing a seed operator sees.
      const manifest = readPackFile<TaxCodeManifest>(ctx.packRoot, "tax", names.codes);
      check(names.codes, manifest);
      if (manifest.regimeCode !== regime.code || manifest.regimeVersion !== regime.version) {
        throw new SeedError(
          `${names.codes}: names regime ${manifest.regimeCode} v${manifest.regimeVersion}, ` +
          `but ${file} declares ${regime.code} v${regime.version}`);
      }

      const regimeRows = await tx<{ id: string }[]>`
        insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                    effective_to, name_en, name_ar, source)
        values (${ctx.tenantId}, ${ctx.companyId}, ${regime.code}, ${regime.jurisdiction}, ${regime.version},
                ${regime.effectiveFrom}, ${regime.effectiveTo ?? null}, ${regime.nameEn},
                ${regime.nameAr ?? null}, ${regime.source})
        on conflict (company_id, code, version) do nothing
        returning id`;
      inserted += regimeRows.length;
      const [regimeRow] = regimeRows.length > 0 ? regimeRows : await tx<{ id: string }[]>`
        select id from app.tax_regime
         where company_id = ${ctx.companyId} and code = ${regime.code} and version = ${regime.version}`;
      if (!regimeRow) throw new SeedError(`${file}: the regime row could neither be inserted nor read back`);

      for (const c of manifest.codes) {
        let accountId: string | null = null;
        if (c.accountCode !== null) {
          const [account] = await tx<{ id: string }[]>`
            select id from app.account where company_id = ${ctx.companyId} and code = ${c.accountCode}`;
          if (!account) {
            throw new SeedError(
              `${names.codes}: account ${c.accountCode} is not seeded for this company — ` +
              `seed --only chart-of-accounts first (§3.4.8, §4.15)`);
          }
          accountId = account.id;
        }
        const rows = await tx<{ id: string }[]>`
          insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, name_ar, rate, kind,
                                    rounding_mode, output_account_id, input_account_id,
                                    effective_from, effective_to)
          values (${ctx.tenantId}, ${ctx.companyId}, ${regimeRow.id}, ${c.code}, ${c.nameEn},
                  ${c.nameAr ?? null}, ${c.rate}, ${c.kind}, ${c.roundingMode},
                  ${c.kind === "output" ? accountId : null},
                  ${c.kind === "input" ? accountId : null},
                  ${c.effectiveFrom}, ${c.effectiveTo ?? null})
          on conflict (company_id, code, effective_from) do nothing
          returning id`;
        inserted += rows.length;
      }
    }
    return inserted;
  },
};
```

`packages/db/src/seed/index.ts` registers it in `LOADERS` beside 0C's four, 1A's `document-types` and 2C's `templates`, and re-exports the module:

```ts
export { taxFileNames, taxLoader, type TaxCodeManifest, type TaxRegimeManifest } from "./tax";
```

Two cases join `packages/db/test/seed/tax-pack.test.ts`, proving the validator is wired rather than merely written:

```ts
  it("a file that does not match tax-pack.schema.json is a SeedError naming the path", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "badtax-"));
    mkdirSync(join(root, "tax"));
    // "11" instead of "0.11000000": a percentage, which would become an 1100 % tax in numeric(19,8).
    writeFileSync(join(root, "tax", "BAD-v1.regime.json"), JSON.stringify({
      code: "BAD-v1", version: 1, jurisdiction: "MY", effectiveFrom: "2026-01-01", effectiveTo: null,
      nameEn: "Bad", source: "SYNTHETIC-TEST-v1 — not a published figure (OD-15)",
    }));
    writeFileSync(join(root, "tax", "BAD-v1.codes.json"), JSON.stringify({
      regimeCode: "BAD-v1", regimeVersion: 1,
      codes: [{ code: "BAD-OUT", nameEn: "Bad", rate: "11", kind: "output",
                roundingMode: "HALF_AWAY_FROM_ZERO", accountCode: "2300", effectiveFrom: "2026-01-01" }],
    }));
    await expect(withTenant(db.rw, a.tenant, a.system,
      (tx) => taxLoader.load(tx, ctx({ packRoot: root }))),
    ).rejects.toThrow(/BAD-v1\.codes\.json does not match urn:dulja:tax-pack:1: \/codes\/0\/rate/);
  });

  it("validateTaxPack accepts both shipped files — the regime code's lower-case `v` included", async () => {
    const { readFileSync } = await import("node:fs");
    const { validateTaxPack } = await import("@dulja/domain");
    for (const f of ["SYNTH-MY-v1.regime.json", "SYNTH-MY-v1.codes.json"]) {
      expect(validateTaxPack(JSON.parse(readFileSync(`${PACK}tax/${f}`, "utf8"))), f)
        .toEqual({ ok: true, errors: [] });
    }
  });
```

- [ ] **Step 7: Run to pass, then commit**

```bash
bun run --cwd packages/domain test -- tax/ && bun run --cwd packages/db test -- seed/tax-pack \
  && bun run --cwd packages/db test -- seed-packs && bun run typecheck
```

`seed-packs.test.ts` is 0C's file that 2C already extended; its `SUB_PACKS` and `assertPackShape` expectations are updated to the seven-member array in this task's commit (**not** in a later one — 2C's precedent, 2c:100).

```bash
git add packages/domain/src/tax/jurisdiction.ts packages/domain/src/tax/malaysia.ts \
        packages/domain/src/tax/pack-schema.ts \
        packages/domain/src/tax/index.ts packages/domain/tax-pack.schema.json \
        packages/domain/test/tax/malaysia.test.ts packages/db/src/seed/tax.ts \
        packages/db/src/seed/types.ts packages/db/src/seed/packs.ts packages/db/src/seed/index.ts \
        packages/db/seed/my/tax/ packages/db/test/seed/tax-pack.test.ts packages/db/test/seed-packs.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add the Malaysia jurisdiction pack and the tax sub-pack loader [5A T6]

§4.9.1's JurisdictionPack with amendment A3: the pack holds regime DEFINITIONS keyed
(code, version), not database rows, and a regime it does not define is a mismatch rather
than an empty return. The only definition that ships is SYNTH-MY-v1 -- five generic
boxes, four synthetic codes, two invented rates, every file carrying its synthetic
provenance. OD-15 (T10) is the only door the verified set comes through. SubPack gains
"tax", last, and the loader fails loudly when 2300 or 1350 is not seeded.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Tax at persist time, `loadSnapshot`'s two 5A fills, and step 11's one writer

**No migration.** The task that joins the pure engine to the posting service, in three pieces that must land together or the ledger and the return disagree.

1. **`computeDocumentTax`** — the persist-time computation spec:2228 demands ("applied server-side at persist time"). It runs inside 1A's document handlers, resolves each line's code, calls `taxEngine.compute`, and writes `document_line.tax_amount` and `total_incl_tax`. **`tax_amount` and `total_incl_tax` are never accepted from the wire** (Task 3's note): a client-stated tax is LEGACY-020's "the actual per-transaction tax is commented out" in the opposite direction.
2. **`loadSnapshot`'s two 5A fills** — `refs.taxCodes` and `header.taxInclusive`, the two §4.3.1 names as waiting on this slice. `TaxCodeDef` is a field-for-field superset of §4.4.2's `TaxCodeRef` and therefore satisfies it **structurally**: the rows go straight into `refs.taxCodes` keyed by **id**, and nothing converts between the two shapes (§4.4.2's closing note).
3. **`insertTaxTransactions`** — the one writer of `app.tax_transaction`, called from `post.ts` at step 11 from `plan.taxLines`, whose `amount` is **signed** (A9's registered exception).

**The one rule that makes 1 and 2 agree.** `policy.tax.inclusive` is either a boolean or the literal `"header.tax_inclusive"` (§4.4.1). 2A's evaluator resolves it in one line; `resolveInclusive` is the **same** line, exported from `packages/db/src/tax/compute.ts` so a reviewer can see there is one rule and not two. A draft computed inclusive and a plan evaluated exclusive would put a different tax in the ledger than on the invoice, and nothing would notice until the return.

**Files:**
- Create: `packages/db/src/tax/codes.ts`, `packages/db/src/tax/compute.ts`, `packages/db/src/posting/tax.ts`
- Create: `tests/invariants/support/tax.ts` (§4.17.1, amendment A9)
- Create: `packages/db/test/tax/compute.test.ts`, `packages/db/test/posting/tax-transaction.test.ts`
- Modify: `packages/db/src/posting/load.ts`, `packages/db/src/posting/post.ts`, `packages/db/src/posting/index.ts` (one re-export, `insertTaxTransactions`), `packages/db/src/tax/index.ts`, `apps/api/src/routes/accounting/documents.ts` (the `computeDocumentTax` hook in the lines handler — and in the create handler too if Task 0's first informational probe said `CreateDocumentBody` accepts lines)
- Modify: **`tests/invariants/support/ar-ap.ts` — 4B's file, two optional members on `PostFromPackOptions` and one block in `postFromPack`'s body, registered by amendment A13a.** This is the one file in this slice owned by another slice's register; the diff is written out in full in Step 1 and Self-Review item 3 of the reviewer list says to re-read the merged file before making it.

**Interfaces**

- Consumes: `taxEngine`, `TaxCodeDef`, `TaxError`, `producesNoTax` (T5); `Money`, `currency`, `toBase`, `UNIT_RATE`, `ExchangeRate` (§4.2.1); `withTenant`, `TenantContext` (§4.2.2); `PostingError`, `PostingErrorCode` (§4.2.4 + A4), `postDocument`, `loadSnapshot`, `resolvePolicy` (§4.3.1); `DocumentSnapshot`, `LineSnapshot`, `PostingPlan`, `PlannedTaxLine`, `TaxCodeRef`, `PostingPolicy` (§4.4.2); `app.tax_code`, `app.tax_regime` (T1), `app.tax_transaction` (T2); `seedTaxCode` (T1), `taxLoader` (T6), `grantCodes` (2B), `seedTypeFromPack`, `postFromPack` (4B — `postFromPack` derives its own approval path, so `packApproval` is not imported here), `ensureOpenPeriods` (3B), `seedItem`, `seedUnit`, `seedWarehouse` (3A), `seedParty` (2A), `seedAccount`, `seedTenantV2` (1A).
- Produces:

```ts
// packages/db/src/tax/codes.ts
export interface TaxCodeRow extends TaxCodeDef { companyId: string; nameEn: string; nameAr: string | null; archivedAt: string | null }
/** Every non-archived code of a company effective on `on`, keyed by ROW ID — the shape `refs.taxCodes` wants. */
export async function loadTaxCodeRefs(tx: Sql, companyId: string, on: string): Promise<Record<string, TaxCodeDef>>;
/** The regime every code on one document belongs to. Refuses a document whose lines span two regimes. */
export async function resolveRegimeFor(tx: Sql, documentId: string): Promise<TaxRegime | null>;   // PostingError
export async function listTaxCodes(tx: Sql, p: { companyId: string; regimeCode?: string; includeArchived?: boolean; cursor?: { code: string; id: string } | null; limit: number }): Promise<TaxCodeRow[]>;
export async function createTaxCode(tx: Sql, ctx: TenantContext, input: { companyId: string; regimeId: string; code: string; nameEn: string; nameAr?: string | null; rate: string; kind: TaxCodeDef["kind"]; roundingMode: RoundingMode; accountCode: string | null; effectiveFrom: string; effectiveTo?: string | null }): Promise<TaxCodeRow>;
export async function archiveTaxCode(tx: Sql, ctx: TenantContext, taxCodeId: string): Promise<void>;

// packages/db/src/tax/compute.ts
/** The ONE resolution of §4.4.1's `tax.inclusive`. 2A's evaluator resolves it identically; exported so a
 *  reviewer sees one rule and not two. */
export function resolveInclusive(policy: PostingPolicy, headerTaxInclusive: boolean): boolean;
export interface ComputedTaxLine { lineId: string; lineNo: number; taxAmount: string; totalInclTax: string; amount: string }
/** Recomputes `tax_amount` and `total_incl_tax` for every line of a DRAFT document and returns what it
 *  wrote. Throws `PostingError("ERR_DOC_STATUS_ILLEGAL")` on a non-draft and `ERR_TAX_REGIME_MISMATCH`
 *  through the engine. */
export async function computeDocumentTax(tx: Sql, ctx: TenantContext, documentId: string): Promise<ComputedTaxLine[]>;

// packages/db/src/posting/tax.ts
/** Step 11 of §4.3.2. The ONE writer of app.tax_transaction. Returns the inserted ids, in plan order. */
export async function insertTaxTransactions(tx: Sql, input: { plan: PostingPlan; snapshot: DocumentSnapshot; postingSeq: bigint; fiscalPeriodId: string }): Promise<string[]>;
```

- [ ] **Step 1: Write the shared test helper (§4.17.1, amendment A9)**

`tests/invariants/support/tax.ts`. Four test files need the same seeded regime, four codes, two accounts and a taxed invoice; hazard 9 forbids four spellings of it.

```ts
// tests/invariants/support/tax.ts — registered to 5A by contracts §4.17.1 (amendment A9).
import { fileURLToPath } from "node:url";
import { withTenant as prodWithTenant } from "@dulja/db";
import { taxLoader } from "@dulja/db/seed";
import { seedAccount, seedParty, seedTenantV2, type Db, type Seed } from "@dulja/db/test";
import { grantCodes } from "@dulja/db/test";
// 3B registers `ensureOpenPeriods` in `tests/invariants/support/post-inventory.ts`, beside
// `postInventoryDocument` and `recordingJobs` (contracts §4.17.1). There is no `support/costing.ts` —
// 3B's `tests/regression/support/costing.ts` is a different file in a different directory.
import { ensureOpenPeriods } from "./post-inventory";
import { postFromPack, seedTypeFromPack } from "./ar-ap";

/** The shipped pack root, resolved from THIS file so Vitest's cwd (`tests/`) cannot change the answer.
 *  4A's `PACK_ROOT` (packages/db/test/ar-ap/_support.ts, the RELATIVE "seed/my" readPackFile resolves)
 *  and 4B's `PACK_DIR` (tests/invariants/support/ar-ap.ts, an ABSOLUTE directory with a trailing
 *  separator — phase-4b amendment 9 names it PACK_DIR and not PACK_ROOT on purpose) both point at the
 *  same directory in two shapes; this third one exists because it is the shape THIS file needs and
 *  neither of those two is it. Do not import either here. */
export const TAX_PACK_ROOT = fileURLToPath(new URL("../../../packages/db/seed/my/", import.meta.url));

/** Applies `packages/db/seed/my/tax/` to one seeded company through the real loader — never by hand-writing
 *  regime and code rows, which is how a test starts asserting a pack it invented. */
export async function seedTaxPack(db: Db, s: Seed): Promise<{ regimeId: string; codes: Record<string, string> }> {
  await prodWithTenant(db.rw, { tenantId: s.tenant, actorId: s.system, requestId: "tax-pack" }, async (tx) => {
    await taxLoader.load(tx, {
      config: { tenantId: s.tenant } as never, tenantId: s.tenant, companyId: s.company,
      systemPrincipalId: s.system, packRoot: TAX_PACK_ROOT,
    });
  });
  return prodWithTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "tax-pack-read" }, async (tx) => {
    const [regime] = await tx<{ id: string }[]>`
      select id from app.tax_regime where company_id = ${s.company} and code = 'SYNTH-MY-v1' and version = 1`;
    const rows = await tx<{ id: string; code: string }[]>`
      select id, code from app.tax_code where company_id = ${s.company} order by code`;
    return { regimeId: regime!.id, codes: Object.fromEntries(rows.map((r) => [r.code, r.id])) };
  });
}

export interface TaxFixture {
  s: Seed;
  regimeId: string;
  /** `SYN-OUT-STD`, `SYN-OUT-ZERO`, `SYN-IN-STD`, `SYN-EXEMPT` → tax_code id. */
  codes: Record<string, string>;
  accounts: Record<string, string>;
  types: Record<string, string>;
  customerId: string;
  vendorId: string;
  poster: string;
}

/** The one setup every tax test uses. **Twelve accounts** — ten seeded here plus `1000` and `4000`, which
 *  `seedTenant` already created and which are RESOLVED rather than re-seeded — the four pack codes, the
 *  four taxed 4A types read off disk, a customer, a vendor, and open periods for the whole of 2026. */
export async function taxFixture(db: Db, name: string): Promise<TaxFixture> {
  const s = await seedTenantV2(db, name);
  // ⚠️ `1000 Cash` and `4000 Sales` are `seedTenant`'s own rows and their ids are ALREADY on the Seed as
  // `s.cash` and `s.sales` (plan0A:1592-1594). `app.account` carries `unique (company_id, code)`, so
  // `seedAccount` on either would be a conflict — they are mapped, not created. **`4000` must be in this
  // map**: `postTaxedDocument` defaults every line to `f.accounts["4000"]`, and without the entry that
  // lookup is `undefined` at run time (the non-null assertion hides it from the compiler), every default
  // line inserts `account_id = null`, and SALES_INVOICE's `each_line` revenue rule resolves nothing.
  // `5920` is `seedTenantV2`'s and is reached through `company.fx_rounding_account_id`, never by code —
  // no test in this slice names it, so it is deliberately not in the map.
  const accounts: Record<string, string> = { "1000": s.cash, "4000": s.sales };
  for (const a of [
    // 5A's own two rows (§4.15). Every other line is 0C's, 3C's or 3D's and is only RESOLVED here.
    { code: "2300", nameEn: "Output tax payable", type: "liability" },
    { code: "1350", nameEn: "Input tax receivable", type: "asset" },
    { code: "1200", nameEn: "Trade receivables", type: "asset" },
    { code: "2100", nameEn: "Trade payables", type: "liability" },
    { code: "1100", nameEn: "Bank", type: "asset" },
    { code: "1300", nameEn: "Inventory control", type: "asset" },
    { code: "5000", nameEn: "Cost of goods sold", type: "expense" },
    { code: "5900", nameEn: "Other operating expense", type: "expense" },
    { code: "2150", nameEn: "Goods received not invoiced", type: "liability" },
    { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" },
  ] as const) {
    accounts[a.code] = await seedAccount(db, s, { code: a.code, nameEn: a.nameEn, type: a.type });
  }
  const { regimeId, codes } = await seedTaxPack(db, s);
  const types: Record<string, string> = {};
  for (const code of ["SALES_INVOICE", "SALES_CREDIT_NOTE", "PURCHASE_INVOICE", "PURCHASE_CREDIT_NOTE"]) {
    types[code] = await seedTypeFromPack(db, s, code);
  }
  const customerId = await seedParty(db, s, { kind: "customer", code: "TAXCUST" });
  const vendorId = await seedParty(db, s, { kind: "vendor", code: "TAXVEND" });
  await ensureOpenPeriods(db, s, 2026);
  // 2B's R2 evaluates policy.approval.post INSIDE the posting transaction and seedTenant grants nothing
  // (§4.1, pinned), so the codes are granted once per seed object, not once per file (§4.17's grantCodes note).
  await grantCodes(db, s, { codes: [
    "accounting.sales.create", "accounting.sales.post",
    "accounting.purchase.create", "accounting.purchase.post",
    "accounting.journal.create", "accounting.journal.post",
    "accounting.tax.manage",
  ] });
  return { s, regimeId, codes, accounts, types, customerId, vendorId, poster: s.human };
}

export interface TaxedLine {
  lineNo: number; kind?: "item" | "account"; accountId?: string; amount: string;
  /** A key of `TaxFixture.codes`, or `null` for a line that carries no code at all. */
  taxCode: string | null;
}

/**
 * Drafts a typed document with taxed lines, computes its tax at persist time, and posts it through 1A's
 * frozen `postDocument` by way of 4B's `postFromPack` (which handles the approval path §4.5.1 requires).
 * **The only way a test in this slice creates tax transactions.**
 *
 * **The option this helper takes is `typeCode`; the option 4B's helper takes is `code`.** They are mapped
 * here, once, rather than renamed in either file: `PostFromPackOptions.code` is 4B's frozen surface
 * (phase-4b:1859) and `typeCode` is what every call site in this slice already reads. **There is no
 * `approval` member to pass** — `postFromPack` derives the path itself with `packApproval(opts.code)`
 * precisely so a call site cannot forget it (phase-4b:1943, 2014), which is why this file does not import
 * `packApproval` at all.
 */
export async function postTaxedDocument(
  db: Db, f: TaxFixture,
  opts: { typeCode: string; effectiveDate: string; partyId?: string; taxInclusive?: boolean; lines: TaxedLine[] },
): Promise<{ documentId: string; number: bigint }> {
  // `postFromPack` returns `{ documentId, result: PostResult }` (phase-4b:1335), not a flattened row.
  const { documentId, result } = await postFromPack(db, f.s, {
    code: opts.typeCode,
    effectiveDate: opts.effectiveDate,
    partyId: opts.partyId ?? f.customerId,
    taxInclusive: opts.taxInclusive ?? false,
    computeTax: true,                       // postFromPack calls computeDocumentTax before it transitions
    lines: opts.lines.map((l) => ({
      lineNo: l.lineNo, kind: l.kind ?? "account",
      accountId: l.accountId ?? f.accounts["4000"]!,
      amount: l.amount,
      ...(l.taxCode === null ? {} : { taxCodeId: f.codes[l.taxCode]! }),
    })),
  });
  return { documentId, number: result.number };
}
```

⚠️ **`postFromPack` gains two options and this task makes the edit — registered as amendment A13a, for the reason A12 was registered.** 4B's helper has no `taxInclusive` and no `computeTax`; both are additive, defaulted to `false`, and 4B's own callers are unaffected. `tests/invariants/support/ar-ap.ts` is 4B's §4.17.1 row (its own amendment 9, phase-4b:250), so extending it is a register edit and not a local convenience: **6A owns the next re-run of test 15 and posts taxed `POS_TICKET`s through this same helper**, and a 6A writer who reads §4.17.1 without finding `computeTax` writes a second posting helper — hazard 9. **Task 0's gate is what proves the helper exists to be extended**; if the gate reported `MISSING (repo) 4B postFromPack`, stop and reconcile with 4B rather than writing a third posting helper. The diff on `tests/invariants/support/ar-ap.ts`, in full — two members on the options interface and one block in the body, **between the draft and the approval path**:

```ts
export interface PostFromPackOptions {
  code: string;
  effectiveDate: string;
  /* … every existing member, unchanged: partyId, currency, exchangeRate, rateSource,
        warehouseId, jobs, lines, allocate … */
  /**
   * 5A / migration 0054. Sets `app.document.tax_inclusive` before tax is computed. 3C's
   * `DraftTypedDocumentOptions` has no member for it — the column is 5A's and 3C predates it — so this is
   * an `UPDATE`, exactly as `rateSource` is (phase-4b:1955) and for the same reason.
   */
  taxInclusive?: boolean;
  /**
   * 5A. Runs `computeDocumentTax` on the draft before any transition. Off by default, so every 4A/4B
   * caller behaves exactly as it did; on, it is what fills `document_line.tax_amount` and
   * `total_incl_tax` and therefore what makes `plan.taxLines` non-empty at post.
   */
  computeTax?: boolean;
}
```

```ts
  // ── 5A: the header flag, then the computation, then the approval path ───────────────────────────────
  //
  // ORDER IS LOAD-BEARING. `computeDocumentTax` reads `header.tax_inclusive` through
  // `resolveInclusive(policy, header.tax_inclusive)`, so the UPDATE must precede it — otherwise the
  // `synth-my-inclusive` golden case computes exclusive tax on a gross figure and its boxes are wrong
  // rather than absent. And `computeDocumentTax` refuses a non-draft document
  // (`ERR_DOC_STATUS_ILLEGAL`), so it must precede the FIRST `transitionDocument` below.
  if (opts.taxInclusive) {
    await withTenant(db.rw, humanCtx, (tx) =>
      tx`update app.document set tax_inclusive = true where id = ${documentId}`);
  }
  if (opts.computeTax) {
    await withTenant(db.rw, humanCtx, (tx) => computeDocumentTax(tx, humanCtx, documentId));
  }
```

placed immediately after the existing `rateSource` block and before `let postCtx = humanCtx;`, with `import { computeDocumentTax } from "@dulja/db";` joining that file's imports.

- [ ] **Step 2: Write the failing tests**

`packages/db/test/tax/compute.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant as prodWithTenant } from "../../src";
import { computeDocumentTax, resolveInclusive } from "../../src/tax";
import { startDb, withTenant, type Db } from "../harness";
import { draftTypedDocument } from "../fixtures";
import { postTaxedDocument, taxFixture, type TaxFixture } from "../../../../tests/invariants/support/tax";

let db: Db;
let f: TaxFixture;
const ctx = () => ({ tenantId: f.s.tenant, actorId: f.s.human, requestId: "compute-test" });

beforeAll(async () => { db = await startDb(); f = await taxFixture(db, "compute"); }, 180_000);
afterAll(async () => { await db?.stop(); });

/** `series` is a REQUIRED member of 3C's `DraftTypedDocumentOptions` (phase-3c:404-416) and every direct
 *  call in this slice passes `"TMP"`, exactly as 4B's `postFromPack` does (phase-4b:1946): the value never
 *  survives, because `issueDocument` overwrites it from `policy.numbering.series` and nothing here posts a
 *  document whose series it asserts. */
async function draft(taxInclusive: boolean, lines: { lineNo: number; amount: string; taxCode: string }[]) {
  const { documentId } = await draftTypedDocument(db, f.s, {
    documentTypeId: f.types["SALES_INVOICE"]!, series: "TMP", effectiveDate: "2026-01-15", partyId: f.customerId,
    lines: lines.map((l) => ({ lineNo: l.lineNo, kind: "account", accountId: f.accounts["4000"]!,
                               amount: l.amount, taxCodeId: f.codes[l.taxCode]! })),
  });
  await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
    tx`update app.document set tax_inclusive = ${taxInclusive} where id = ${documentId}`);
  return documentId;
}

describe("computeDocumentTax (spec:2228, ADR 0050)", () => {
  it("resolveInclusive is ONE rule: a boolean literal, or the header field", () => {
    const p = (inclusive: unknown) => ({ tax: { applies: true, inclusive } }) as never;
    expect(resolveInclusive(p(true), false)).toBe(true);
    expect(resolveInclusive(p(false), true)).toBe(false);
    expect(resolveInclusive(p("header.tax_inclusive"), true)).toBe(true);
    expect(resolveInclusive(p("header.tax_inclusive"), false)).toBe(false);
    expect(resolveInclusive(p(undefined), true)).toBe(false);       // absent means exclusive
    expect(resolveInclusive({ tax: { applies: false } } as never, true)).toBe(false);
  });

  it("exclusive: tax_amount = amount x rate and total_incl_tax = amount + tax", async () => {
    const id = await draft(false, [{ lineNo: 1, amount: "300.0000", taxCode: "SYN-OUT-STD" }]);
    const written = await prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id));
    expect(written).toEqual([{ lineId: expect.any(String), lineNo: 1, amount: "300.0000",
                               taxAmount: "33.0000", totalInclTax: "333.0000" }]);
    const [row] = await db.admin<{ tax_amount: string; total_incl_tax: string }[]>`
      select tax_amount::text, total_incl_tax::text from app.document_line where document_id = ${id}`;
    expect(row).toEqual({ tax_amount: "33.0000", total_incl_tax: "333.0000" });
  });

  it("inclusive: amount is REWRITTEN to the extracted base and total_incl_tax keeps the entered figure", async () => {
    const id = await draft(true, [{ lineNo: 1, amount: "333.0000", taxCode: "SYN-OUT-STD" }]);
    const [w] = await prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id));
    expect(w).toMatchObject({ amount: "300.0000", taxAmount: "33.0000", totalInclTax: "333.0000" });
    // §4.3.4 defines `amount` as "excl. tax, document currency" — so an inclusive entry MUST be rewritten,
    // or the each_line revenue leg would credit the tax-inclusive figure and the invoice would not balance.
  });

  it("is idempotent: computing twice writes the same figures and never taxes a tax", async () => {
    const id = await draft(true, [{ lineNo: 1, amount: "333.0000", taxCode: "SYN-OUT-STD" }]);
    const first = await prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id));
    const second = await prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id));
    expect(second).toEqual(first);
  });

  it("a line with no tax code is zeroed, not skipped — LEGACY-011's NULL arithmetic cannot start", async () => {
    const { documentId } = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types["SALES_INVOICE"]!, series: "TMP", effectiveDate: "2026-01-15", partyId: f.customerId,
      lines: [{ lineNo: 1, kind: "account", accountId: f.accounts["4000"]!, amount: "100.0000" }],
    });
    const [w] = await prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), documentId));
    expect(w).toMatchObject({ taxAmount: "0.0000", totalInclTax: "100.0000" });
  });

  it("zero-rated and exempt codes yield zero tax and the full total", async () => {
    const id = await draft(false, [
      { lineNo: 1, amount: "70.0000", taxCode: "SYN-OUT-ZERO" },
      { lineNo: 2, amount: "80.0000", taxCode: "SYN-EXEMPT" },
    ]);
    const w = await prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id));
    expect(w.map((l) => l.taxAmount)).toEqual(["0.0000", "0.0000"]);
    expect(w.map((l) => l.totalInclTax)).toEqual(["70.0000", "80.0000"]);
  });

  it("two codes of DIFFERENT regimes on one document is a refusal (LEGACY-020)", async () => {
    const second = await prodWithTenant(db.rw, ctx(), async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                    name_en, source)
        values (${f.s.tenant}, ${f.s.company}, 'SYNTH-MY-v2', 'MY', 1, '2026-01-01',
                'Second synthetic regime', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
        returning id`;
      const [c] = await tx<{ id: string }[]>`
        insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, rate, kind, rounding_mode,
                                  output_account_id, effective_from)
        values (${f.s.tenant}, ${f.s.company}, ${r!.id}, 'SYN-OTHER', 'Other regime code', 0.04500000,
                'output', 'HALF_AWAY_FROM_ZERO', ${f.accounts["2300"]}, '2026-01-01')
        returning id`;
      return c!.id;
    });
    const { documentId } = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types["SALES_INVOICE"]!, series: "TMP", effectiveDate: "2026-01-15", partyId: f.customerId,
      lines: [
        { lineNo: 1, kind: "account", accountId: f.accounts["4000"]!, amount: "100.0000",
          taxCodeId: f.codes["SYN-OUT-STD"]! },
        { lineNo: 2, kind: "account", accountId: f.accounts["4000"]!, amount: "100.0000", taxCodeId: second },
      ],
    });
    await expect(prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), documentId)))
      .rejects.toThrow(/ERR_TAX_REGIME_MISMATCH: document .* spans two tax regimes: SYNTH-MY-v1 and SYNTH-MY-v2/);
  });

  it("an archived code cannot be computed against — the loud half of spec:2049's archival", async () => {
    const id = await draft(false, [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-OUT-STD" }]);
    await prodWithTenant(db.rw, ctx(), (tx) =>
      tx`update app.tax_code set archived_at = now() where id = ${f.codes["SYN-OUT-STD"]}`);
    await expect(prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), id)))
      .rejects.toThrow(/ERR_TAX_REGIME_MISMATCH: line 1: tax code SYN-OUT-STD is archived/);
    await prodWithTenant(db.rw, ctx(), (tx) =>
      tx`update app.tax_code set archived_at = null where id = ${f.codes["SYN-OUT-STD"]}`);
  });

  it("a non-draft document refuses recomputation (spec:2049, LEGACY-041)", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE", effectiveDate: "2026-01-20",
      lines: [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-OUT-STD" }],
    });
    await expect(prodWithTenant(db.rw, ctx(), (tx) => computeDocumentTax(tx, ctx(), documentId)))
      .rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: document .* is posted, not draft/);
  });
});
```

`packages/db/test/posting/tax-transaction.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument, transitionDocument, withTenant as prodWithTenant } from "../../src";
import { computeDocumentTax } from "../../src/tax";
import { startDb, type Db } from "../harness";
import { draftTypedDocument } from "../fixtures";
import { postTaxedDocument, taxFixture, type TaxFixture } from "../../../../tests/invariants/support/tax";

let db: Db;
let f: TaxFixture;

beforeAll(async () => { db = await startDb(); f = await taxFixture(db, "step11"); }, 180_000);
afterAll(async () => { await db?.stop(); });

describe("postDocument step 11 — app.tax_transaction (§4.3.2, §4.9.2)", () => {
  it("one row per (line, code), carrying the SIGNED figures and the base twins", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE", effectiveDate: "2026-01-15",
      lines: [
        { lineNo: 1, amount: "300.0000", taxCode: "SYN-OUT-STD" },
        { lineNo: 2, amount: "70.0000", taxCode: "SYN-OUT-ZERO" },
      ],
    });
    const rows = await db.admin<{ line_no: number; base: string; tax: string; base_base: string;
                                 tax_base: string; posting_seq: string; effective_date: string }[]>`
      select line_no, base::text, tax::text, base_base::text, tax_base::text, posting_seq::text,
             effective_date::text
        from app.tax_transaction where document_id = ${documentId} order by line_no`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ line_no: 1, base: "300.0000", tax: "33.0000",
                                    base_base: "300.0000", tax_base: "33.0000",
                                    effective_date: "2026-01-15" });
    expect(rows[1]).toMatchObject({ line_no: 2, base: "70.0000", tax: "0.0000" });
    // posting_seq is assigned at step 8, BEFORE any row that carries it (§4.3.2), so it is never null.
    for (const r of rows) expect(BigInt(r.posting_seq) > 0n).toBe(true);
  });

  it("a credit note writes NEGATIVE tax — A9's one exception, read from `side` nowhere", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "SALES_CREDIT_NOTE", effectiveDate: "2026-01-16",
      lines: [{ lineNo: 1, amount: "-50.0000", taxCode: "SYN-OUT-STD" }],
    });
    const [r] = await db.admin<{ base: string; tax: string; tax_base: string }[]>`
      select base::text, tax::text, tax_base::text from app.tax_transaction where document_id = ${documentId}`;
    expect(r).toEqual({ base: "-50.0000", tax: "-5.5000", tax_base: "-5.5000" });
  });

  it("the ledger's tax leg and the tax_transaction agree to the cent, both directions", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE", effectiveDate: "2026-01-17",
      lines: [{ lineNo: 1, amount: "1000.0000", taxCode: "SYN-OUT-STD" }],
    });
    const [led] = await db.admin<{ credit: string }[]>`
      select sum(l.base_credit - l.base_debit)::text as credit from app.ledger_entry l
       where l.document_id = ${documentId} and l.account_id = ${f.accounts["2300"]}`;
    const [txn] = await db.admin<{ tax: string }[]>`
      select sum(tax_base)::text as tax from app.tax_transaction where document_id = ${documentId}`;
    expect(led!.credit).toBe("110.0000");
    expect(txn!.tax).toBe("110.0000");
  });

  it("an INPUT code debits 1350 and its transaction carries the same figure", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "PURCHASE_INVOICE", effectiveDate: "2026-01-18", partyId: f.vendorId,
      lines: [{ lineNo: 1, kind: "account", accountId: f.accounts["5900"], amount: "200.0000",
                taxCode: "SYN-IN-STD" }],
    });
    const [led] = await db.admin<{ debit: string }[]>`
      select sum(l.base_debit - l.base_credit)::text as debit from app.ledger_entry l
       where l.document_id = ${documentId} and l.account_id = ${f.accounts["1350"]}`;
    const [txn] = await db.admin<{ tax: string }[]>`
      select sum(tax_base)::text as tax from app.tax_transaction where document_id = ${documentId}`;
    expect(led!.debit).toBe("22.0000");
    expect(txn!.tax).toBe("22.0000");
  });

  it("an EXEMPT line writes a row with tax = 0; a CODE-LESS line writes no row at all", async () => {
    // The distinction matters to the return: an exempt supply is reported in box S3, so it must be a row
    // with a zero tax; a line with no code is not a taxable event and must not appear at all. LEGACY-058's
    // failure was the inverse — an uncoded voucher line was invisible to the reconciliation AND excluded
    // from the return, so nothing could tell the two apart.
    const { documentId: exempt } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE", effectiveDate: "2026-01-19",
      lines: [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-EXEMPT" }],
    });
    const [e] = await db.admin<{ n: number; tax: string | null }[]>`
      select count(*)::int as n, max(tax)::text as tax
        from app.tax_transaction where document_id = ${exempt}`;
    expect(e).toEqual({ n: 1, tax: "0.0000" });

    const { documentId: plain } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE", effectiveDate: "2026-01-21",
      lines: [{ lineNo: 1, amount: "100.0000", taxCode: null }],
    });
    const [p] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.tax_transaction where document_id = ${plain}`;
    expect(p!.n).toBe(0);
  });

  it("posting twice is impossible, so a tax transaction cannot be duplicated (LEGACY-041 + the unique key)", async () => {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE", effectiveDate: "2026-01-22",
      lines: [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-OUT-STD" }],
    });
    const c = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "again" };
    await expect(prodWithTenant(db.rw, c, (tx) => postDocument(tx, c, { documentId })))
      .rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL/);
  });

  it("PostResult.taxTransactionIds is filled, in plan order (§4.3.1)", async () => {
    const c = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "ids" };
    const { documentId } = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types["SALES_INVOICE"]!, series: "TMP", effectiveDate: "2026-01-23", partyId: f.customerId,
      lines: [
        { lineNo: 1, kind: "account", accountId: f.accounts["4000"]!, amount: "100.0000",
          taxCodeId: f.codes["SYN-OUT-STD"]! },
        { lineNo: 2, kind: "account", accountId: f.accounts["4000"]!, amount: "200.0000",
          taxCodeId: f.codes["SYN-IN-STD"]! },
      ],
    });
    const result = await prodWithTenant(db.rw, c, async (tx) => {
      await computeDocumentTax(tx, c, documentId);
      await transitionDocument(tx, c, { documentId, to: "submitted" });
      return postDocument(tx, c, { documentId });
    });
    // Two DISTINCT codes are two `each_tax` groups, so two ids — the evaluator groups by code, not by line.
    expect(result.taxTransactionIds).toHaveLength(2);
    const stored = await db.admin<{ id: string }[]>`
      select id from app.tax_transaction where document_id = ${documentId} order by line_no`;
    expect(new Set(result.taxTransactionIds)).toEqual(new Set(stored.map((r) => r.id)));
  });
});
```

- [ ] **Step 3: Run them and see the exact expected failure**

```bash
bun run --cwd packages/db test -- tax/compute posting/tax-transaction
```

Expected:

```
FAIL  test/tax/compute.test.ts
SyntaxError: The requested module '../../src/tax' does not provide an export named 'computeDocumentTax'

FAIL  test/posting/tax-transaction.test.ts > … > one row per (line, code) …
AssertionError: expected [] to have a length of 2 but got +0
```

- [ ] **Step 4: Write `codes.ts`**

```ts
// packages/db/src/tax/codes.ts
import type { Sql } from "postgres";
import type { RoundingMode, TaxCodeDef, TaxRegime } from "@dulja/domain";
import { PostingError } from "../posting/errors";
import type { TenantContext } from "../with-tenant";

/** The keyset position of the `tax-codes` list. Declared locally as `{ code, id }` rather than imported
 *  from §4.2.8's `Cursor`, because `packages/db` may not import `@dulja/contracts` (§3.1) — the route
 *  module is what encodes and decodes the opaque wire cursor. */
export interface TaxCodeCursor { code: string; id: string }

export interface TaxCodeRow extends TaxCodeDef {
  companyId: string; nameEn: string; nameAr: string | null; archivedAt: string | null;
  regimeCode: string; regimeVersion: number;
}

/** Every non-archived code of a company effective on `on`, keyed by ROW ID — which is exactly the shape
 *  `DocumentSnapshot.refs.taxCodes` wants (§4.4.2: "keyed by the row id … so the evaluator never does a
 *  second lookup"). `TaxCodeDef` is a field-for-field superset of `TaxCodeRef` and satisfies it
 *  structurally, so nothing converts between the two. */
export async function loadTaxCodeRefs(
  tx: Sql, companyId: string, on: string,
): Promise<Record<string, TaxCodeDef>> {
  const rows = await tx<{ id: string; regime_id: string; code: string; rate: string; kind: TaxCodeDef["kind"];
                          rounding_mode: RoundingMode; output_account_id: string | null;
                          input_account_id: string | null; effective_from: string;
                          effective_to: string | null }[]>`
    select id, regime_id, code, rate::text as rate, kind, rounding_mode,
           output_account_id, input_account_id, effective_from::text, effective_to::text
      from app.tax_code
     where company_id = ${companyId}
       and archived_at is null
       and effective_from <= ${on}
       and (effective_to is null or effective_to >= ${on})`;
  return Object.fromEntries(rows.map((r) => [r.id, {
    id: r.id, regimeId: r.regime_id, code: r.code, rate: r.rate, kind: r.kind,
    roundingMode: r.rounding_mode, outputAccountId: r.output_account_id, inputAccountId: r.input_account_id,
    effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
  } satisfies TaxCodeDef]));
}

/**
 * The regime every tax code on one document belongs to, or `null` when no line carries a code.
 *
 * **A document whose lines span two regimes is refused.** LEGACY-020's failure was that nothing said which
 * regime a code belonged to, so a VAT tenant ran the GST return and reported sales as purchases; a document
 * mixing two regimes would put half its transactions in one return and half in another, with both returns
 * looking complete. The refusal names both regimes.
 */
export async function resolveRegimeFor(tx: Sql, documentId: string): Promise<TaxRegime | null> {
  const rows = await tx<{ id: string; code: string; jurisdiction: "MY"; version: number;
                          effective_from: string; effective_to: string | null }[]>`
    select distinct r.id, r.code, r.jurisdiction, r.version,
                    r.effective_from::text, r.effective_to::text
      from app.document_line l
      join app.tax_code c on c.id = l.tax_code_id
      join app.tax_regime r on r.id = c.regime_id
     where l.document_id = ${documentId}
     order by r.code`;
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new PostingError("ERR_TAX_REGIME_MISMATCH",
      `document ${documentId} spans two tax regimes: ${rows.map((r) => r.code).join(" and ")}`);
  }
  const r = rows[0]!;
  return { id: r.id, code: r.code, jurisdiction: r.jurisdiction, version: r.version,
           effectiveFrom: r.effective_from, effectiveTo: r.effective_to };
}

/** The `tax-codes` list route's read. Keyset on `(code, id)`; `regimeCode` is the one declared filter. */
export async function listTaxCodes(
  tx: Sql,
  p: { companyId: string; regimeCode?: string; includeArchived?: boolean;
       cursor?: TaxCodeCursor | null; limit: number },
): Promise<TaxCodeRow[]> {
  const rows = await tx<Record<string, string | number | null>[]>`
    select c.id, c.company_id, c.regime_id, c.code, c.name_en, c.name_ar, c.rate::text as rate, c.kind,
           c.rounding_mode, c.output_account_id, c.input_account_id,
           c.effective_from::text, c.effective_to::text, c.archived_at::text,
           r.code as regime_code, r.version as regime_version
      from app.tax_code c
      join app.tax_regime r on r.id = c.regime_id
     where c.company_id = ${p.companyId}
       and (${p.regimeCode ?? null}::text is null or r.code = ${p.regimeCode ?? null})
       and (${p.includeArchived ?? false} or c.archived_at is null)
       and (${p.cursor?.code ?? null}::text is null
            or (c.code, c.id) > (${p.cursor?.code ?? null}::text, ${p.cursor?.id ?? null}::uuid))
     order by c.code, c.id
     limit ${p.limit}`;
  return rows.map((r) => ({
    id: r.id as string, companyId: r.company_id as string, regimeId: r.regime_id as string,
    code: r.code as string, nameEn: r.name_en as string, nameAr: r.name_ar as string | null,
    rate: r.rate as string, kind: r.kind as TaxCodeDef["kind"], roundingMode: r.rounding_mode as RoundingMode,
    outputAccountId: r.output_account_id as string | null, inputAccountId: r.input_account_id as string | null,
    effectiveFrom: r.effective_from as string, effectiveTo: r.effective_to as string | null,
    archivedAt: r.archived_at as string | null,
    regimeCode: r.regime_code as string, regimeVersion: r.regime_version as number,
  }));
}

/** The break-glass runtime create under `accounting.tax.manage`. The PRIMARY load path is the seed PR
 *  (ADR 0050, §3.4.8) — this exists so an accountant can add a code mid-period without a deploy, and the
 *  audit trigger on `tax_code` is what records that they did. */
export async function createTaxCode(
  tx: Sql, ctx: TenantContext,
  input: { companyId: string; regimeId: string; code: string; nameEn: string; nameAr?: string | null;
           rate: string; kind: TaxCodeDef["kind"]; roundingMode: RoundingMode;
           accountCode: string | null; effectiveFrom: string; effectiveTo?: string | null },
): Promise<TaxCodeRow> {
  let accountId: string | null = null;
  if (input.accountCode !== null) {
    const [account] = await tx<{ id: string }[]>`
      select id from app.account where company_id = ${input.companyId} and code = ${input.accountCode}`;
    if (!account) {
      throw new PostingError("ERR_POLICY_REQUIRES_MISSING",
        `account ${input.accountCode} does not exist for this company (§4.15)`);
    }
    accountId = account.id;
  }
  const [row] = await tx<{ id: string }[]>`
    insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, name_ar, rate, kind,
                              rounding_mode, output_account_id, input_account_id, effective_from, effective_to)
    values (${ctx.tenantId}, ${input.companyId}, ${input.regimeId}, ${input.code}, ${input.nameEn},
            ${input.nameAr ?? null}, ${input.rate}, ${input.kind}, ${input.roundingMode},
            ${input.kind === "output" ? accountId : null},
            ${input.kind === "input" ? accountId : null},
            ${input.effectiveFrom}, ${input.effectiveTo ?? null})
    returning id`;
  const [created] = await listTaxCodes(tx, { companyId: input.companyId, includeArchived: true, limit: 1000 })
    .then((all) => all.filter((c) => c.id === row!.id));
  return created!;
}

/** spec:2049: master data is archived, never deleted. `app_rw` holds no DELETE on this table (§3.5.4). */
export async function archiveTaxCode(tx: Sql, ctx: TenantContext, taxCodeId: string): Promise<void> {
  const rows = await tx<{ id: string }[]>`
    update app.tax_code set archived_at = now() where id = ${taxCodeId} and archived_at is null returning id`;
  if (rows.length === 0) throw new PostingError("ERR_NOT_FOUND", `tax code ${taxCodeId} is not an open code`);
}
```

- [ ] **Step 5: Write `compute.ts`**

```ts
// packages/db/src/tax/compute.ts
import type { Sql } from "postgres";
import { currency, Money, taxEngine, TaxError, type PostingPolicy, type TaxLineInput } from "@dulja/domain";
import { PostingError } from "../posting/errors";
import { resolvePolicy } from "../posting/index";
import type { TenantContext } from "../with-tenant";
import { loadTaxCodeRefs, resolveRegimeFor } from "./codes";

/**
 * The ONE resolution of §4.4.1's `tax.inclusive`, which is `boolean | "header.tax_inclusive"`.
 *
 * 2A's `evaluatePolicy` resolves it with the identical expression. It is exported from here so a reviewer
 * can see there is one rule and not two: a draft computed inclusive against a plan evaluated exclusive
 * would put a different tax on the invoice than in the ledger, and nothing would notice until the return.
 */
export function resolveInclusive(policy: PostingPolicy, headerTaxInclusive: boolean): boolean {
  if (policy.tax.applies !== true) return false;
  const declared = policy.tax.inclusive;
  return declared === "header.tax_inclusive" ? headerTaxInclusive : declared === true;
}

export interface ComputedTaxLine {
  lineId: string; lineNo: number;
  /** The tax-EXCLUSIVE base, rewritten on the row when the document is inclusive (§4.3.4). */
  amount: string;
  taxAmount: string; totalInclTax: string;
}

/**
 * Recomputes `document_line.tax_amount` and `total_incl_tax` for every line of a DRAFT document, and
 * rewrites `amount` to the extracted base when the document is tax-inclusive.
 *
 * spec:2228 requires rounding "applied server-side at persist time", and ADR 0050 fixes this as the one
 * call site: the evaluator, the ledger and the return then all read one number. `tax_amount` and
 * `total_incl_tax` are never accepted from the wire (§4.2.8's `DocumentLineInput`), so a client cannot
 * state a tax the server did not compute — LEGACY-020's commented-out per-transaction tax, inverted.
 *
 * Idempotent: it derives everything from `amount` and `total_incl_tax`, taking the ENTERED figure for an
 * inclusive line from `total_incl_tax` once one has been written, so a second call cannot tax a tax.
 */
export async function computeDocumentTax(
  tx: Sql, ctx: TenantContext, documentId: string,
): Promise<ComputedTaxLine[]> {
  const [header] = await tx<{ status: string; document_type_id: string; effective_date: string;
                              currency: string; tax_inclusive: boolean; company_id: string }[]>`
    select status, document_type_id, effective_date::text, currency, tax_inclusive, company_id
      from app.document where id = ${documentId}`;
  if (!header) throw new PostingError("ERR_NOT_FOUND", `document ${documentId} is not visible`);
  if (header.status !== "draft") {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL",
      `document ${documentId} is ${header.status}, not draft — a posted document is corrected by reversal (LEGACY-041)`);
  }

  const { definition } = await resolvePolicy(tx, header.document_type_id, header.effective_date);
  const inclusive = resolveInclusive(definition, header.tax_inclusive);
  const ccy = currency(header.currency);

  const lines = await tx<{ id: string; line_no: number; amount: string; total_incl_tax: string;
                           tax_code_id: string | null }[]>`
    select id, line_no, amount::text, total_incl_tax::text, tax_code_id
      from app.document_line where document_id = ${documentId} order by line_no`;

  const regime = await resolveRegimeFor(tx, documentId);
  const refs = await loadTaxCodeRefs(tx, header.company_id, header.effective_date);

  const inputs: TaxLineInput[] = [];
  const untaxed: { id: string; line_no: number; amount: string }[] = [];
  for (const l of lines) {
    if (l.tax_code_id === null) { untaxed.push(l); continue; }
    const code = refs[l.tax_code_id];
    if (!code) {
      // The FK guarantees the row exists (0055), so the only way to miss it is `archived_at` or an
      // effective range that does not cover this document's date. Both are refusals, not silent zeroes.
      const [why] = await tx<{ code: string; archived_at: string | null;
                               effective_from: string; effective_to: string | null }[]>`
        select code, archived_at::text, effective_from::text, effective_to::text
          from app.tax_code where id = ${l.tax_code_id}`;
      throw new PostingError("ERR_TAX_REGIME_MISMATCH",
        why?.archived_at
          ? `line ${l.line_no}: tax code ${why.code} is archived`
          : `line ${l.line_no}: tax code ${why?.code ?? l.tax_code_id} is not effective on ` +
            `${header.effective_date} (${why?.effective_from}..${why?.effective_to ?? "open"})`);
    }
    // An inclusive line's ENTERED figure is `total_incl_tax` once one has been written, and `amount`
    // before that. This is what makes a second call idempotent instead of taxing an already-net figure.
    const entered = inclusive && l.total_incl_tax !== "0.0000" ? l.total_incl_tax : l.amount;
    inputs.push({ lineNo: l.line_no, amount: Money.of(entered, ccy), taxCode: code, inclusive });
  }

  let results: ReturnType<typeof taxEngine.compute> = [];
  if (inputs.length > 0) {
    if (!regime) throw new PostingError("ERR_TAX_REGIME_MISMATCH", `document ${documentId} has coded lines but no regime`);
    try { results = taxEngine.compute(regime, inputs); }
    catch (e) {
      // The engine cannot import AppError (§3.1) and neither can this module; the token is preserved.
      if (e instanceof TaxError) throw new PostingError(e.code, e.detail);
      throw e;
    }
  }

  const out: ComputedTaxLine[] = [];
  for (const r of results) {
    const line = lines.find((l) => l.line_no === r.lineNo)!;
    const total = r.base.add(r.tax);
    await tx`
      update app.document_line
         set amount = ${r.base.toString()}, tax_amount = ${r.tax.toString()},
             total_incl_tax = ${total.toString()}
       where id = ${line.id}`;
    out.push({ lineId: line.id, lineNo: r.lineNo, amount: r.base.toString(),
               taxAmount: r.tax.toString(), totalInclTax: total.toString() });
  }
  for (const l of untaxed) {
    // A code-less line is ZEROED, never left alone: LEGACY-011's whole finding is that one un-populated
    // monetary column nulls a whole period's box. `0.0000` is a figure; a stale one is not.
    await tx`
      update app.document_line set tax_amount = 0, total_incl_tax = ${l.amount} where id = ${l.id}`;
    out.push({ lineId: l.id, lineNo: l.line_no, amount: l.amount,
               taxAmount: "0.0000", totalInclTax: l.amount });
  }
  return out.sort((x, y) => x.lineNo - y.lineNo);
}
```

- [ ] **Step 6: Write `posting/tax.ts` and wire step 11**

```ts
// packages/db/src/posting/tax.ts
import type { Sql } from "postgres";
import { toBase, type DocumentSnapshot, type PostingPlan } from "@dulja/domain";
import { resolveRegimeFor } from "../tax/codes";
import { PostingError } from "./errors";

/**
 * §4.3.2 step 11: "Insert `app.tax_transaction` rows (5A+)".
 *
 * **This function is the ONE writer of `app.tax_transaction`** — the table is on the `posting-only-tables`
 * list 1A shipped (§3.7.5) and is immutable to `app_rw` besides, so a second writer would fail the lint and
 * then the database.
 *
 * `plan.taxLines` carries **signed** amounts: `PlannedTaxLine.amount` is A9's one registered exception to
 * sign normalisation, because a credit note's tax is genuinely negative tax and the return needs the sign.
 * Nothing here reads a sign to choose a direction — there is no side to choose.
 *
 * The base twins are `toBase(value, snapshot.header.exchangeRate)`, which is `round(value x rate, 4)`
 * HALF_AWAY_FROM_ZERO — the same arithmetic `ledger_entry`'s CHECK applies (spec:1816, hazard 23), so a
 * return filed in base currency and the ledger's tax leg agree by construction rather than by luck.
 *
 * **`regime_id` comes from `resolveRegimeFor`, NOT from `snapshot.refs.taxCodes`.** The map is typed
 * `Record<string, TaxCodeRef>` (§4.4.2), and `TaxCodeRef` has no `regimeId` member — 5A's `TaxCodeDef` is a
 * SUPERSET of it, so the objects go *in* unconverted, but a value read back *out* is statically a
 * `TaxCodeRef` and `code.regimeId` is `TS2339`. Widening `TaxCodeRef` is not the answer either: it is a
 * frozen §4.4.2 shape and 2A's own evaluator tests build literal `refs.taxCodes` entries (phase-2a:1380)
 * that a new required member would break. `resolveRegimeFor` is already this slice's function, already
 * returns the document's one regime, and re-asserts the single-regime invariant at POST time as well as at
 * compute time — which is worth having, because `computeDocumentTax` ran when the lines were saved and a
 * post can be minutes later.
 */
export async function insertTaxTransactions(
  tx: Sql,
  input: { plan: PostingPlan; snapshot: DocumentSnapshot; postingSeq: bigint; fiscalPeriodId: string },
): Promise<string[]> {
  const { plan, snapshot, postingSeq, fiscalPeriodId } = input;
  if (plan.taxLines.length === 0) return [];

  // Non-null by construction: a planned tax line exists only because a document line carried a code, which
  // is exactly the condition under which resolveRegimeFor returns a regime rather than null. The guard is
  // the loud form of that argument rather than a `!`.
  const regime = await resolveRegimeFor(tx, snapshot.header.id);
  if (!regime) {
    throw new PostingError("ERR_TAX_REGIME_MISMATCH",
      `document ${snapshot.header.id} planned ${plan.taxLines.length} tax line(s) but no line carries a tax code`);
  }

  const ids: string[] = [];
  for (const t of plan.taxLines) {
    if (!snapshot.refs.taxCodes[t.taxCodeId]) {
      throw new PostingError("ERR_TAX_REGIME_MISMATCH",
        `planned tax line ${t.lineNo} names tax code ${t.taxCodeId}, which loadSnapshot did not resolve`);
    }
    const [row] = await tx<{ id: string }[]>`
      insert into app.tax_transaction (tenant_id, company_id, document_id, line_no, tax_code_id, regime_id,
                                       base, tax, base_base, tax_base,
                                       effective_date, fiscal_period_id, posting_seq)
      values (app.current_tenant(), ${snapshot.company.id}, ${snapshot.header.id}, ${t.lineNo},
              ${t.taxCodeId}, ${regime.id},
              ${t.base.toString()}, ${t.amount.toString()},
              ${toBase(t.base, snapshot.header.exchangeRate).toString()},
              ${toBase(t.amount, snapshot.header.exchangeRate).toString()},
              ${snapshot.header.effectiveDate}, ${fiscalPeriodId}, ${postingSeq})
      returning id`;
    ids.push(row!.id);
  }
  return ids;
}
```

**The import is `../tax/codes`, not `../tax` (the barrel).** `packages/db/src/tax/index.ts` re-exports `compute.ts`, and `compute.ts` imports `../posting/index` for `resolvePolicy`; going through the barrel would make `posting/index → posting/tax → tax/index → tax/compute → posting/index` a cycle. Reaching the one module directly keeps the graph `posting/tax → tax/codes → posting/errors`, which terminates. Both files are inside `packages/db/src`, so `dependency-rule` (§3.1) sees one tier and says nothing either way.

**`tenant_id` is `app.current_tenant()` and never a parameter.** `DocumentSnapshot.header` carries no `tenantId` (§4.4.2), the session already has one because every statement runs inside `withTenant`, and a tenant id a caller could supply is LEGACY-044's class of defect. This is exactly what 1A's `insertLedger` does for the same column, and the RLS `with check` predicate would refuse anything else anyway.

`packages/db/src/posting/post.ts` — **one call, at the site Task 0's gate located**, after the `ledger_entry` insert (step 10) and before the `account_balance` MERGE (step 12):

```ts
  // ── 11. tax transactions (5A) ───────────────────────────────────────────────────────────────────────
  // §4.3.2 step 11. Before the MERGE, because a MERGE that succeeded and a tax insert that failed would
  // leave a balance the return cannot explain — one transaction, so either both land or neither does (D14).
  const taxTransactionIds = await insertTaxTransactions(tx, {
    plan, snapshot, postingSeq, fiscalPeriodId,
  });
```

and `PostResult.taxTransactionIds` — a member §4.3.1 has declared since Phase 1 and 1A returned as `[]` — is filled from it. **Nothing else in `post.ts` changes**: no step is renumbered, no branch is added, and the `[]` literal is replaced by the variable.

- [ ] **Step 7: Fill `loadSnapshot`'s two 5A fields**

`packages/db/src/posting/load.ts` — the two fields §4.3.1 lists as waiting on 5A, and no others:

```ts
  // 5A / migration 0054. The column arrived with this slice; every document posted in Phases 1-4 reads
  // false, which is what they were computed as.
  taxInclusive: header.tax_inclusive,
```

```ts
  // 5A. Keyed by the tax_code ROW ID (§4.4.2), because `document_line.tax_code_id` is what the evaluator
  // holds. `TaxCodeDef` is a field-for-field superset of `TaxCodeRef` and satisfies it STRUCTURALLY —
  // §4.4.2's closing note — so these objects go in unconverted and no second shape exists.
  taxCodes: await loadTaxCodeRefs(tx, header.company_id, header.effective_date),
```

The `header.tax_inclusive` column joins the existing `select` list in `load.ts`; `refs.items`, `refs.components` and `refs.schemes` stay `{}` (3A and 8A own those, and §4.3.1's list says so).

- [ ] **Step 8: Hook the handlers, run to pass, commit**

`apps/api/src/routes/accounting/documents.ts` — `computeDocumentTax(tx, c.var.ctx, documentId)` is called at the end of the `PUT …/documents/{documentId}/lines` handler's own transaction, **and** at the end of the `POST …/documents` handler when Task 0's first informational probe said `CreateDocumentBody` accepts lines. Both calls are inside `c.var.withTenant`, so the lines and their tax commit together; a failure surfaces as the `PostingError` branch `apps/api/src/problem.ts` already has.

`packages/db/src/tax/index.ts` — **Task 5's `export {};` line is replaced by these two**, not joined by them:

```ts
export { archiveTaxCode, createTaxCode, listTaxCodes, loadTaxCodeRefs, resolveRegimeFor,
         type TaxCodeCursor, type TaxCodeRow } from "./codes";
export { computeDocumentTax, resolveInclusive, type ComputedTaxLine } from "./compute";
```

and `packages/db/src/posting/index.ts` gains `export { insertTaxTransactions } from "./tax";`.

```bash
bun run --cwd packages/db test -- tax/compute posting/tax-transaction && bun run lint:rules && bun run typecheck
```

`lint:rules` is the one that matters here: `posting-only-tables` must be **silent**, which it is only because the `insert into app.tax_transaction` lives in `packages/db/src/posting/**`. If it fires on `packages/db/src/tax/returns.ts` in Task 8, that file has grown a write it must not have.

```bash
git add packages/db/src/tax/codes.ts packages/db/src/tax/compute.ts packages/db/src/tax/index.ts \
        packages/db/src/posting/tax.ts packages/db/src/posting/post.ts packages/db/src/posting/load.ts \
        packages/db/src/posting/index.ts apps/api/src/routes/accounting/documents.ts \
        tests/invariants/support/tax.ts tests/invariants/support/ar-ap.ts \
        packages/db/test/tax/compute.test.ts packages/db/test/posting/tax-transaction.test.ts
git commit -m "$(cat <<'EOF'
feat(db): compute tax at persist time and write tax_transaction at step 11 [5A T7]

Three pieces that must land together: computeDocumentTax inside 1A's line handlers
(spec:2228 "applied at persist time", ADR 0050); loadSnapshot's two 5A fills, with
TaxCodeDef satisfying TaxCodeRef structurally so nothing converts; and
insertTaxTransactions as the ONE writer of app.tax_transaction, taking the SIGNED
plan.taxLines amounts -- A9's registered exception -- and their toBase twins.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Return generation, the tie-out, the two route modules, and the four policy upserts

**No migration.** The service half of the definition of done and the API that reaches it, plus the four seed-file edits 4A named as this slice's ("5A adds the `each_tax` credit leg and flips `applies` in a policy `version: 2`", phase-4a:2762) — which is also the **test 15 re-run** the card assigns: four document types gain tax through a reviewed seed PR and **not one line of TypeScript**.

**Two decisions this task fixes.**

- **A return is two steps, `draft` then `generated`.** `POST …/tax-returns` reserves the period (`unique (company_id, regime_id, period_start)` is what stops two people filing the same quarter twice) and `POST …/tax-returns/{id}/generate` builds the payload, validates it and moves the row. That is why §4.9.2's status vocabulary has three labels and not two, and it makes the byte-identity of test 26 a natural assertion: generate twice, compare `payload_sha256`. `generated → filed` is **5B's** transition under `accounting.tax.file`, and this slice writes neither `filed_at` nor `attachment_id`.
- **`taxReturnTieOut` reads `account_balance`, not `ledger_entry`.** 1B's rule holds here for the same reason it holds for the trial balance: a report that quietly re-aggregated would hide exactly the drift the integrity job exists to find (§4.16.3). The tie-out is the "reconciled" verb of the DoD.

**Files:**
- Create: `packages/db/src/tax/returns.ts`, `packages/contracts/src/accounting/tax.ts`, `apps/api/src/routes/accounting/tax-returns.ts`
- Create: `packages/db/test/tax/returns.test.ts`, `apps/api/test/routes/accounting/tax-codes.test.ts`, `apps/api/test/routes/accounting/tax-returns.test.ts`
- Create: `docs/runbooks/tax-return.md`
- Modify: `apps/api/src/routes/accounting/tax-codes.ts` (the router beside T4's constant), `apps/api/src/routes/index.ts` (`buildRoutes`), `tests/invariants/probes.ts` (two entries), `packages/db/src/tax/index.ts`, `packages/db/seed/my/document-types/{SALES_INVOICE,SALES_CREDIT_NOTE,PURCHASE_INVOICE,PURCHASE_CREDIT_NOTE}.json`

**Interfaces**

- Consumes: `malaysiaPack`, `TaxTransactionRow`, `ReturnBox`, `canonicalJson`, `TaxError` (T5, T6); `Money`, `currency` (§4.2.1); `resolveRegimeFor` (T7); `app.tax_transaction`, `app.tax_return` (T2), `app.account_balance` (§4.3.3, 1A); `RouteModule`, `buildRoutes`, `IdempotencyHeader`, `requirePermission`, `TAX_PERMISSION` (T4), `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `RateSchema`, `ProblemSchema`, `encodeCursor`, `decodeCursor` (§4.2.7, §4.2.8); `PROBES`, `IsolationProbe`, `startApi` (§3.7.2, §4.2.12); `taxFixture`, `postTaxedDocument` (T7).
- Produces:

```ts
// packages/db/src/tax/returns.ts
export interface TaxReturnRow {
  id: string; companyId: string; regimeId: string; regimeCode: string; regimeVersion: number;
  periodStart: string; periodEnd: string; status: "draft" | "generated" | "filed";
  payload: string | null; payloadSha256: string | null; generatedBy: string | null;
  filedAt: string | null; attachmentId: string | null; createdAt: string;
}
export async function createTaxReturn(tx: Sql, ctx: TenantContext, input: { companyId: string; regimeId: string; periodStart: string; periodEnd: string }): Promise<TaxReturnRow>;
export async function listTaxReturns(tx: Sql, p: { companyId: string; regimeCode?: string; cursor?: { periodStart: string; id: string } | null; limit: number }): Promise<TaxReturnRow[]>;
/** `regimeCode` + `regimeVersion` → the tenant's own regime id, or `null`. The route turns `null` into a
 *  404 rather than a 422, so a probe cannot learn whether another tenant's regime exists. */
export async function findRegime(tx: Sql, companyId: string, code: string, version: number): Promise<string | null>;
/** The `currency` member is the COMPANY's base currency — the one the boxes are denominated in, and the one
 *  member of `TaxReturnDetail` that has no other source. */
export async function getTaxReturn(tx: Sql, taxReturnId: string): Promise<{ row: TaxReturnRow; boxes: ReturnBox[]; currency: CurrencyCode }>;
/** Reads `app.tax_transaction` and NOTHING else, builds the payload through the pack, validates it, writes
 *  `payload` / `payload_sha256` / `status = 'generated'` and stamps `generated_by`. */
export async function generateTaxReturn(tx: Sql, ctx: TenantContext, taxReturnId: string): Promise<{ row: TaxReturnRow; boxes: ReturnBox[]; currency: CurrencyCode }>;
export interface TaxReturnTieOutRow { accountCode: string; boxCodes: string[]; boxBase: string; ledgerBase: string; difference: string }
/** The DoD's "reconciled" verb: each control account's box total against `account_balance`. */
export async function taxReturnTieOut(tx: Sql, taxReturnId: string): Promise<TaxReturnTieOutRow[]>;

// packages/contracts/src/accounting/tax.ts
export const TaxCodeKindSchema: z.ZodEnum<["output", "input", "exempt", "zero", "out_of_scope"]>;
export const RoundingModeSchema: z.ZodEnum<["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"]>;
export const TaxCodeSchema: z.ZodObject<…>;      export type TaxCodeDto = z.infer<typeof TaxCodeSchema>;
export const CreateTaxCodeBody: z.ZodObject<…>;  export const TaxCodeQuery: z.ZodObject<…>;
export const TaxCodeList = ListEnvelope(TaxCodeSchema);
export const ReturnBoxSchema: z.ZodObject<{ code; label; amount }>;
export const TaxReturnStatusSchema: z.ZodEnum<["draft", "generated", "filed"]>;
export const TaxReturnSchema: z.ZodObject<…>;    export type TaxReturnDto = z.infer<typeof TaxReturnSchema>;
export const CreateTaxReturnBody: z.ZodObject<…>; export const TaxReturnQuery: z.ZodObject<…>;
export const TaxReturnList = ListEnvelope(TaxReturnSchema);
export const TaxReturnTieOutRowSchema: z.ZodObject<…>;  export const TaxReturnDetail: z.ZodObject<…>;

// apps/api/src/routes/accounting/tax-codes.ts  (T4's constant kept)
export const taxCodeRoutes: OpenAPIHono<AppEnv>;   export const taxCodeRouteModule: RouteModule;
// apps/api/src/routes/accounting/tax-returns.ts
export const taxReturnRoutes: OpenAPIHono<AppEnv>; export const taxReturnRouteModule: RouteModule;
```

- [ ] **Step 1: Write the failing service test**

`packages/db/test/tax/returns.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant as prodWithTenant } from "../../src";
import { createTaxReturn, generateTaxReturn, getTaxReturn, listTaxReturns, taxReturnTieOut } from "../../src/tax";
import { startDb, type Db } from "../harness";
import { postTaxedDocument, taxFixture, type TaxFixture } from "../../../../tests/invariants/support/tax";

let db: Db;
let f: TaxFixture;
let returnId: string;
const ctx = () => ({ tenantId: f.s.tenant, actorId: f.s.human, requestId: "returns-test" });
const Q1 = { periodStart: "2026-01-01", periodEnd: "2026-03-31" };

beforeAll(async () => {
  db = await startDb();
  f = await taxFixture(db, "returns");
  // The DoD fixture: five documents, one of each shape the pack's five boxes must separate.
  await postTaxedDocument(db, f, { typeCode: "SALES_INVOICE", effectiveDate: "2026-01-15",
    lines: [{ lineNo: 1, amount: "1000.0000", taxCode: "SYN-OUT-STD" }] });
  await postTaxedDocument(db, f, { typeCode: "SALES_INVOICE", effectiveDate: "2026-02-10",
    lines: [{ lineNo: 1, amount: "500.0000", taxCode: "SYN-OUT-STD" }] });
  await postTaxedDocument(db, f, { typeCode: "SALES_CREDIT_NOTE", effectiveDate: "2026-02-20",
    lines: [{ lineNo: 1, amount: "-200.0000", taxCode: "SYN-OUT-STD" }] });
  await postTaxedDocument(db, f, { typeCode: "SALES_INVOICE", effectiveDate: "2026-03-05",
    lines: [{ lineNo: 1, amount: "300.0000", taxCode: "SYN-OUT-ZERO" },
            { lineNo: 2, amount: "150.0000", taxCode: "SYN-EXEMPT" }] });
  await postTaxedDocument(db, f, { typeCode: "PURCHASE_INVOICE", effectiveDate: "2026-03-20",
    partyId: f.vendorId,
    lines: [{ lineNo: 1, kind: "account", accountId: f.accounts["5900"], amount: "800.0000",
              taxCode: "SYN-IN-STD" }] });
  // …and one OUTSIDE the quarter, which must not appear in any box (LEGACY-059).
  await postTaxedDocument(db, f, { typeCode: "SALES_INVOICE", effectiveDate: "2026-04-02",
    lines: [{ lineNo: 1, amount: "9999.0000", taxCode: "SYN-OUT-STD" }] });
  const row = await prodWithTenant(db.rw, ctx(), (tx) =>
    createTaxReturn(tx, ctx(), { companyId: f.s.company, regimeId: f.regimeId, ...Q1 }));
  returnId = row.id;
}, 300_000);
afterAll(async () => { await db?.stop(); });

describe("tax returns (§4.9.2, the Phase 5 DoD)", () => {
  it("a new return is a draft with no payload and no generator", async () => {
    const { row } = await prodWithTenant(db.rw, ctx(), (tx) => getTaxReturn(tx, returnId));
    expect(row).toMatchObject({ status: "draft", payload: null, payloadSha256: null, generatedBy: null,
                                regimeCode: "SYNTH-MY-v1", periodStart: "2026-01-01" });
  });

  it("one return per company, regime and period start — a second reservation is refused", async () => {
    await expect(prodWithTenant(db.rw, ctx(), (tx) =>
      createTaxReturn(tx, ctx(), { companyId: f.s.company, regimeId: f.regimeId, ...Q1 })),
    ).rejects.toThrow(/tax_return_company_id_regime_id_period_start_key/);
  });

  it("generate fills every box from tax_transaction, excluding the out-of-period document (LEGACY-059)", async () => {
    const { row, boxes } = await prodWithTenant(db.rw, ctx(), (tx) => generateTaxReturn(tx, ctx(), returnId));
    expect(row.status).toBe("generated");
    expect(row.generatedBy).toBe(f.s.human);
    const box = (c: string) => boxes.find((b) => b.code === c)!.amount.toString();
    expect(box("S1")).toBe("1300.0000");    // 1000 + 500 - 200 : the 9999 of 2026-04-02 is NOT here
    expect(box("S2")).toBe("143.0000");     // 110 + 55 - 22
    expect(box("S3")).toBe("450.0000");     // 300 zero-rated + 150 exempt
    expect(box("P1")).toBe("800.0000");
    expect(box("P2")).toBe("88.0000");
  });

  it("regenerating is byte-identical and keeps the FIRST generator (§4.3.4's closed_by precedent)", async () => {
    const first = await prodWithTenant(db.rw, ctx(), (tx) => getTaxReturn(tx, returnId));
    const again = await prodWithTenant(db.rw,
      { tenantId: f.s.tenant, actorId: f.s.system, requestId: "regen" },
      (tx) => generateTaxReturn(tx, { tenantId: f.s.tenant, actorId: f.s.system, requestId: "regen" }, returnId));
    expect(again.row.payload).toBe(first.row.payload);
    expect(again.row.payloadSha256).toBe(first.row.payloadSha256);
    expect(again.row.generatedBy).toBe(f.s.human);        // NOT the system principal
  });

  it("the payload is what the pack produced, and the sha is sha256 of exactly those bytes", async () => {
    const { row } = await prodWithTenant(db.rw, ctx(), (tx) => getTaxReturn(tx, returnId));
    // `convert_to(payload, 'UTF8')` — `payload` is `text` and PostgreSQL has no text→bytea cast; the
    // stored sha is the sha of the payload's UTF-8 bytes, and this is the expression that says so.
    const [check] = await db.admin<{ same: boolean }[]>`
      select payload_sha256 = sha256(convert_to(payload, 'UTF8')) as same
        from app.tax_return where id = ${returnId}`;
    expect(check!.same).toBe(true);
    expect(row.payload).toContain('"regimeCode":"SYNTH-MY-v1"');
  });

  it("the tie-out reconciles both control accounts to the cent — the DoD's third verb", async () => {
    const rows = await prodWithTenant(db.rw, ctx(), (tx) => taxReturnTieOut(tx, returnId));
    expect(rows.map((r) => r.accountCode)).toEqual(["1350", "2300"]);
    const out = rows.find((r) => r.accountCode === "2300")!;
    expect(out).toMatchObject({ boxCodes: ["S2"], boxBase: "143.0000", ledgerBase: "143.0000",
                                difference: "0.0000" });
    const inp = rows.find((r) => r.accountCode === "1350")!;
    expect(inp).toMatchObject({ boxCodes: ["P2"], boxBase: "88.0000", ledgerBase: "88.0000",
                                difference: "0.0000" });
  });

  it("a return whose transactions carry a SECOND regime is refused, not filed wrong (spec:2444)", async () => {
    const g = await taxFixture(db, "returns-two-regimes");
    const second = await prodWithTenant(db.rw, { tenantId: g.s.tenant, actorId: g.s.human, requestId: "r2" },
      async (tx) => {
        const [r] = await tx<{ id: string }[]>`
          insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                      name_en, source)
          values (${g.s.tenant}, ${g.s.company}, 'SYNTH-MY-v1', 'MY', 2, '2026-01-01',
                  'Synthetic regime v1 revision 2', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
          returning id`;
        return r!.id;
      });
    const gctx = { tenantId: g.s.tenant, actorId: g.s.human, requestId: "r2" };
    await postTaxedDocument(db, g, { typeCode: "SALES_INVOICE", effectiveDate: "2026-01-15",
      lines: [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-OUT-STD" }] });
    const r = await prodWithTenant(db.rw, gctx, (tx) =>
      createTaxReturn(tx, gctx, { companyId: g.s.company, regimeId: second, ...Q1 }));
    // Version 2 has no definition in the pack, and its period holds v1 transactions — two refusals, one code.
    await expect(prodWithTenant(db.rw, gctx, (tx) => generateTaxReturn(tx, gctx, r.id)))
      .rejects.toThrow(/ERR_TAX_REGIME_MISMATCH/);
    const [after] = await db.admin<{ status: string; payload: string | null }[]>`
      select status, payload from app.tax_return where id = ${r.id}`;
    expect(after).toEqual({ status: "draft", payload: null });   // the refusal left NOTHING behind
  });

  it("listTaxReturns pages on (period_start, id) and filters by regime code", async () => {
    const rows = await prodWithTenant(db.rw, ctx(), (tx) =>
      listTaxReturns(tx, { companyId: f.s.company, regimeCode: "SYNTH-MY-v1", limit: 10 }));
    expect(rows.map((r) => r.periodStart)).toEqual(["2026-01-01"]);
    expect(await prodWithTenant(db.rw, ctx(), (tx) =>
      listTaxReturns(tx, { companyId: f.s.company, regimeCode: "NOPE", limit: 10 }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see the exact expected failure**

```bash
bun run --cwd packages/db test -- tax/returns
```

Expected:

```
FAIL  test/tax/returns.test.ts
SyntaxError: The requested module '../../src/tax' does not provide an export named 'createTaxReturn'
```

- [ ] **Step 3: Write `returns.ts`**

```ts
// packages/db/src/tax/returns.ts
import type { Sql } from "postgres";
import { currency, malaysiaPack, Money, TaxError,
         type CurrencyCode, type ReturnBox, type TaxCodeDef, type TaxRegime,
         type TaxTransactionRow } from "@dulja/domain";
import { PostingError } from "../posting/errors";
import type { TenantContext } from "../with-tenant";

export interface TaxReturnRow {
  id: string; companyId: string; regimeId: string; regimeCode: string; regimeVersion: number;
  periodStart: string; periodEnd: string; status: "draft" | "generated" | "filed";
  payload: string | null; payloadSha256: string | null; generatedBy: string | null;
  filedAt: string | null; attachmentId: string | null; createdAt: string;
}
export interface TaxReturnCursor { periodStart: string; id: string }

const SELECT_RETURN = (tx: Sql) => tx`
  select r.id, r.company_id, r.regime_id, g.code as regime_code, g.version as regime_version,
         r.period_start::text, r.period_end::text, r.status, r.payload,
         encode(r.payload_sha256, 'hex') as payload_sha256, r.generated_by,
         r.filed_at::text, r.attachment_id, r.created_at::text
    from app.tax_return r join app.tax_regime g on g.id = r.regime_id`;

function toRow(r: Record<string, unknown>): TaxReturnRow {
  return {
    id: r.id as string, companyId: r.company_id as string, regimeId: r.regime_id as string,
    regimeCode: r.regime_code as string, regimeVersion: r.regime_version as number,
    periodStart: r.period_start as string, periodEnd: r.period_end as string,
    status: r.status as TaxReturnRow["status"], payload: r.payload as string | null,
    payloadSha256: r.payload_sha256 as string | null, generatedBy: r.generated_by as string | null,
    filedAt: r.filed_at as string | null, attachmentId: r.attachment_id as string | null,
    createdAt: r.created_at as string,
  };
}

/** Reserves the period. `unique (company_id, regime_id, period_start)` is what stops two people filing the
 *  same quarter twice; the refusal surfaces as `ERR_CONFLICT_UNIQUE` through `fromDatabaseError`. */
export async function createTaxReturn(
  tx: Sql, ctx: TenantContext,
  input: { companyId: string; regimeId: string; periodStart: string; periodEnd: string },
): Promise<TaxReturnRow> {
  const [made] = await tx<{ id: string }[]>`
    insert into app.tax_return (tenant_id, company_id, regime_id, period_start, period_end, status)
    values (${ctx.tenantId}, ${input.companyId}, ${input.regimeId},
            ${input.periodStart}, ${input.periodEnd}, 'draft')
    returning id`;
  const rows = await SELECT_RETURN(tx)`where r.id = ${made!.id}` as unknown as Record<string, unknown>[];
  return toRow(rows[0]!);
}

export async function listTaxReturns(
  tx: Sql,
  p: { companyId: string; regimeCode?: string; cursor?: TaxReturnCursor | null; limit: number },
): Promise<TaxReturnRow[]> {
  const rows = await tx<Record<string, unknown>[]>`
    select r.id, r.company_id, r.regime_id, g.code as regime_code, g.version as regime_version,
           r.period_start::text, r.period_end::text, r.status, r.payload,
           encode(r.payload_sha256, 'hex') as payload_sha256, r.generated_by,
           r.filed_at::text, r.attachment_id, r.created_at::text
      from app.tax_return r join app.tax_regime g on g.id = r.regime_id
     where r.company_id = ${p.companyId}
       and (${p.regimeCode ?? null}::text is null or g.code = ${p.regimeCode ?? null})
       and (${p.cursor?.periodStart ?? null}::date is null
            or (r.period_start, r.id) > (${p.cursor?.periodStart ?? null}::date, ${p.cursor?.id ?? null}::uuid))
     order by r.period_start, r.id
     limit ${p.limit}`;
  return rows.map(toRow);
}

/** The transactions of one return's period and regime. **Both period bounds are always bound** — LEGACY-059's
 *  failure was a concatenated query that silently lost its date filter and reported every voucher ever
 *  posted; this is a tagged template and the bounds are parameters, so losing one is not expressible. */
async function transactionsFor(tx: Sql, row: TaxReturnRow): Promise<TaxTransactionRow[]> {
  const rows = await tx<{ document_id: string; document_type_code: string; line_no: number;
                          tax_code_id: string; tax_code: string; regime_id: string;
                          kind: TaxCodeDef["kind"]; rate: string; base: string; tax: string;
                          base_base: string; tax_base: string; effective_date: string;
                          posting_seq: string; base_currency: string; document_currency: string }[]>`
    select t.document_id, dt.code as document_type_code, t.line_no, t.tax_code_id, c.code as tax_code,
           t.regime_id, c.kind, c.rate::text as rate,
           t.base::text, t.tax::text, t.base_base::text, t.tax_base::text,
           t.effective_date::text, t.posting_seq::text, co.base_currency,
           d.currency as document_currency
      from app.tax_transaction t
      join app.tax_code c   on c.id = t.tax_code_id
      join app.document d   on d.id = t.document_id
      join app.document_type dt on dt.id = d.document_type_id
      join app.company co   on co.id = t.company_id
     where t.company_id    = ${row.companyId}
       and t.regime_id     = ${row.regimeId}
       and t.effective_date >= ${row.periodStart}
       and t.effective_date <= ${row.periodEnd}
     order by t.effective_date, t.posting_seq, t.line_no, c.code`;
  return rows.map((r) => {
    // TWO currencies, and they are not the same one. `base_base` / `tax_base` are the company's base
    // currency — what the return is filed in and what every box sums. `base` / `tax` are the DOCUMENT's
    // currency, so they are branded with `d.currency`. They are equal for a domestic invoice and differ the
    // moment a tenant codes tax on a foreign-currency one; labelling the document figures with the base
    // currency would hand `TaxTransactionRow.base` a `Money` that claims a currency it is not in, which is
    // exactly the mislabelling spec:2041's compile-time currency check exists to catch.
    const ccy = currency(r.base_currency);
    const doc = currency(r.document_currency);
    return {
      documentId: r.document_id, documentTypeCode: r.document_type_code, lineNo: r.line_no,
      taxCodeId: r.tax_code_id, taxCode: r.tax_code, regimeId: r.regime_id, kind: r.kind, rate: r.rate,
      base: Money.of(r.base, doc), tax: Money.of(r.tax, doc),
      baseBase: Money.of(r.base_base, ccy), taxBase: Money.of(r.tax_base, ccy),
      effectiveDate: r.effective_date, postingSeq: r.posting_seq,
    } satisfies TaxTransactionRow;
  });
}

/**
 * Reads `app.tax_transaction` and **nothing else** — never a document, never a `ledger_entry` — builds the
 * payload through the pack, validates it, and writes the row.
 *
 * A refusal leaves the row untouched: the pack throws before the UPDATE, and the whole call is inside the
 * caller's `withTenant`, so a half-generated return is not reachable. `generated_by` is stamped by
 * `app.stamp_actor` on the NULL → value transition and keeps the FIRST generator on a regeneration — 1A's
 * `closed_by` decision (§4.3.4); `app.audit_log` is the per-generation record with its own stamped actor.
 */
export async function generateTaxReturn(
  tx: Sql, ctx: TenantContext, taxReturnId: string,
): Promise<{ row: TaxReturnRow; boxes: ReturnBox[]; currency: CurrencyCode }> {
  const found = await SELECT_RETURN(tx)`where r.id = ${taxReturnId}` as unknown as Record<string, unknown>[];
  if (found.length === 0) throw new PostingError("ERR_NOT_FOUND", `tax return ${taxReturnId} is not visible`);
  const row = toRow(found[0]!);
  if (row.status === "filed") {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL",
      `tax return ${taxReturnId} is filed — a filed return is corrected by a new period's return, never regenerated`);
  }

  const [regimeRow] = await tx<{ id: string; code: string; jurisdiction: "MY"; version: number;
                                 effective_from: string; effective_to: string | null }[]>`
    select id, code, jurisdiction, version, effective_from::text, effective_to::text
      from app.tax_regime where id = ${row.regimeId}`;
  const regime: TaxRegime = {
    id: regimeRow!.id, code: regimeRow!.code, jurisdiction: regimeRow!.jurisdiction,
    version: regimeRow!.version, effectiveFrom: regimeRow!.effective_from, effectiveTo: regimeRow!.effective_to,
  };

  const transactions = await transactionsFor(tx, row);
  let built: { boxes: ReturnBox[]; payload: string };
  try {
    built = malaysiaPack.buildReturn({ regime, periodStart: row.periodStart, periodEnd: row.periodEnd,
                                       transactions });
  } catch (e) {
    if (e instanceof TaxError) throw new PostingError(e.code, e.detail);
    throw e;
  }
  const check = malaysiaPack.validateReturn(built.payload);
  if (!check.ok) {
    // "generated, validated and reconciled" — a payload the pack cannot re-read is not generated.
    throw new PostingError("ERR_TAX_REGIME_MISMATCH",
      `the generated return does not validate against ${regime.code} v${regime.version}: ${check.errors.join("; ")}`);
  }

  // `convert_to(text, 'UTF8')`, NOT `::bytea`. PostgreSQL has no cast from `text` to `bytea` — the column
  // is `text` (0054) and `select payload::bytea` raises "cannot cast type text to bytea"; postgres.js sends
  // a JS string as `text`, so the parameterised form fails identically. `convert_to` is the documented
  // text→bytes conversion and it names the encoding, which is the half that matters: the golden payload's
  // sha is the sha of its UTF-8 bytes, and the pack's Arabic labels make that a real distinction rather
  // than a pedantic one. (`sha256(''::bytea)` in T2's test works only because `''` is an UNTYPED literal
  // handed straight to bytea's input function — not a cast from `text`.)
  await tx`
    update app.tax_return
       set payload = ${built.payload},
           payload_sha256 = sha256(convert_to(${built.payload}, 'UTF8')),
           status = 'generated'
     where id = ${taxReturnId}`;
  const after = await SELECT_RETURN(tx)`where r.id = ${taxReturnId}` as unknown as Record<string, unknown>[];
  const [co] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${row.companyId}`;
  return { row: toRow(after[0]!), boxes: built.boxes, currency: currency(co!.base_currency) };
}

/** `regimeCode` + `regimeVersion` → the tenant's own regime id, or `null`. RLS bounds the read, so a code
 *  belonging to another tenant is indistinguishable from one that does not exist — which is what lets the
 *  route answer **404** and leak nothing (§4.2.7's not-found-over-forbidden rule for cross-tenant reads). */
export async function findRegime(
  tx: Sql, companyId: string, code: string, version: number,
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.tax_regime
     where company_id = ${companyId} and code = ${code} and version = ${version}`;
  return row?.id ?? null;
}

/** Re-reads a stored return's boxes from its own payload — never by re-summing, so what a screen shows is
 *  what was generated. A draft has no payload and therefore no boxes. `currency` is the COMPANY's base
 *  currency and is returned in every case, draft included: `TaxReturnDetail` declares the member and the
 *  route must not run its own SQL to fill it. */
export async function getTaxReturn(
  tx: Sql, taxReturnId: string,
): Promise<{ row: TaxReturnRow; boxes: ReturnBox[]; currency: CurrencyCode }> {
  const found = await SELECT_RETURN(tx)`where r.id = ${taxReturnId}` as unknown as Record<string, unknown>[];
  if (found.length === 0) throw new PostingError("ERR_NOT_FOUND", `tax return ${taxReturnId} is not visible`);
  const row = toRow(found[0]!);
  const [co] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${row.companyId}`;
  const ccy = currency(co!.base_currency);
  if (row.payload === null) return { row, boxes: [], currency: ccy };
  const parsed = JSON.parse(row.payload) as { boxes: { code: string; label: string; amount: string }[] };
  return { row, boxes: parsed.boxes.map((b) => ({ code: b.code, label: b.label, amount: Money.of(b.amount, ccy) })),
           currency: ccy };
}

export interface TaxReturnTieOutRow {
  accountCode: string; boxCodes: string[]; boxBase: string; ledgerBase: string; difference: string;
}

/**
 * The DoD's **"reconciled"** verb. For each of the two §4.15 control accounts, the sum of the return's tax
 * boxes that feed it against `app.account_balance` for the same periods.
 *
 * **`account_balance`, not `ledger_entry`** — 1B's rule (§4.16.3): a report that quietly re-aggregated the
 * ledger would hide exactly the drift the integrity job exists to find. The orientation is per account
 * type: `2300` is a liability, so its ledger figure is credit − debit; `1350` is an asset, so debit − credit.
 * Reversing the orientation is how a tie-out passes for assets and fails for liabilities — 4B's second-pass
 * finding, avoided here by taking the sign from `app.account.type` and not from a hand-written map.
 */
export async function taxReturnTieOut(tx: Sql, taxReturnId: string): Promise<TaxReturnTieOutRow[]> {
  const { row, boxes, currency: ccy } = await getTaxReturn(tx, taxReturnId);
  if (row.payload === null) {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL", `tax return ${taxReturnId} is a draft — generate it first`);
  }
  const definition = malaysiaPack.regimes.find(
    (d) => d.code === row.regimeCode && d.version === row.regimeVersion)!;

  // Which tax box feeds which control account: an `output` box credits 2300, an `input` box debits 1350.
  // The mapping comes from the DEFINITION's own `kinds` and `measure`, never from a literal box code, so a
  // regime with different box codes (OD-15's) ties out without editing this function.
  const wanted: { accountCode: string; boxCodes: string[] }[] = [
    { accountCode: "1350", boxCodes: definition.boxes
        .filter((b) => b.measure === "tax" && b.kinds.includes("input")).map((b) => b.code) },
    { accountCode: "2300", boxCodes: definition.boxes
        .filter((b) => b.measure === "tax" && b.kinds.includes("output")).map((b) => b.code) },
  ];

  // `ccy` came back from `getTaxReturn` — one read of `company.base_currency` per tie-out, not two.
  const out: TaxReturnTieOutRow[] = [];
  for (const w of wanted) {
    let boxTotal = Money.zero(ccy);
    for (const b of boxes) if (w.boxCodes.includes(b.code)) boxTotal = boxTotal.add(b.amount);
    const [led] = await tx<{ base: string | null }[]>`
      select coalesce(sum(case a.type when 'liability' then b.base_credit - b.base_debit
                                      else b.base_debit - b.base_credit end), 0)::numeric(19,4)::text as base
        from app.account_balance b
        join app.account a on a.id = b.account_id
        join app.fiscal_period p on p.id = b.fiscal_period_id
       where b.company_id = ${row.companyId}
         and a.code       = ${w.accountCode}
         and p.starts_on >= ${row.periodStart}
         and p.ends_on   <= ${row.periodEnd}`;
    // `coalesce(..., 0)` is deliberate and is LEGACY-011's fix at this boundary: an account with no balance
    // row must read 0.0000, never null, or the difference would be null and the DoD assertion vacuous.
    const ledger = Money.of(led!.base!, ccy);
    out.push({
      accountCode: w.accountCode, boxCodes: w.boxCodes,
      boxBase: boxTotal.toString(), ledgerBase: ledger.toString(),
      difference: boxTotal.subtract(ledger).toString(),
    });
  }
  return out;
}
```

⚠️ **The tie-out's `p.starts_on >= periodStart and p.ends_on <= periodEnd` requires the return's window to be a whole number of fiscal periods**, which a monthly or quarterly return over monthly periods always is. A window that cut a period in half would silently exclude it and the difference would be wrong with nothing to say so, therefore `createTaxReturn` refuses that shape before it inserts:

```ts
  const [cover] = await tx<{ partial: number }[]>`
    select count(*)::int as partial from app.fiscal_period
     where company_id = ${input.companyId}
       and starts_on <= ${input.periodEnd} and ends_on >= ${input.periodStart}
       and (starts_on < ${input.periodStart} or ends_on > ${input.periodEnd})`;
  if (cover!.partial > 0) {
    throw new PostingError("ERR_POLICY_REQUIRES_MISSING",
      `${input.periodStart}..${input.periodEnd} cuts a fiscal period in half — a return covers whole periods`);
  }
```

**`ERR_POLICY_REQUIRES_MISSING`, deliberately, and `PostingErrorCode` gains no member for it.** `ERR_VALIDATION_FAILED` is not in the union (§4.2.4's `PostingErrorCode` list) and widening a union that means *"the posting service refused"* for a shape check on a return period would blur what the union is for. The code that IS in the union and whose contract is "the message names the missing one" is the right one, and it maps to 422 exactly as the case needs. A reviewer who thinks the wire code should be `ERR_VALIDATION_FAILED` is right that the *shape* belongs in Zod — and `CreateTaxReturnBody` does validate `periodEnd >= periodStart`; what it cannot know is the company's fiscal calendar, which is why this check is in the service.

- [ ] **Step 4: Write the Zod contracts**

`packages/contracts/src/accounting/tax.ts`. Every filter is a **literal `filter[…]` key** — §4.2.8 Layer 2's default, and the surface is two field × operator pairs, well under the threshold at which `parseFilters` earns its keep:

```ts
import { z } from "@hono/zod-openapi";
import { CurrencySchema, DateSchema, ListEnvelope, ListQuery, RateSchema, TimestampSchema, UuidSchema }
  from "../common";

/** A 4-dp signed figure. The same file-local form 1A's `DocumentLineSchema` uses (§4.2.8's registered
 *  practice): a return's box and a credit note's tax are both legitimately negative. */
const Amount = z.string().regex(/^-?\d+\.\d{4}$/);

export const TaxCodeKindSchema = z.enum(["output", "input", "exempt", "zero", "out_of_scope"]);
export const RoundingModeSchema = z.enum(["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"]);

export const TaxCodeSchema = z.object({
  id: UuidSchema, regimeId: UuidSchema, regimeCode: z.string(), regimeVersion: z.number().int(),
  code: z.string(), nameEn: z.string(), nameAr: z.string().nullable(),
  rate: RateSchema, kind: TaxCodeKindSchema, roundingMode: RoundingModeSchema,
  outputAccountId: UuidSchema.nullable(), inputAccountId: UuidSchema.nullable(),
  effectiveFrom: DateSchema, effectiveTo: DateSchema.nullable(), archivedAt: TimestampSchema.nullable(),
}).openapi("TaxCode");
export type TaxCodeDto = z.infer<typeof TaxCodeSchema>;

export const CreateTaxCodeBody = z.object({
  regimeId: UuidSchema, code: z.string().regex(/^[A-Z][A-Z0-9-]{1,31}$/),
  nameEn: z.string().min(1).max(200), nameAr: z.string().max(200).nullish(),
  rate: RateSchema, kind: TaxCodeKindSchema, roundingMode: RoundingModeSchema.default("HALF_AWAY_FROM_ZERO"),
  /** A §4.15 account CODE, not an id — the register is the shared namespace, and a code is what a policy
   *  and a seed file both name (hazard 32). `null` for a code that produces no tax. */
  accountCode: z.string().regex(/^[1-5][0-9]{3}$/).nullable(),
  effectiveFrom: DateSchema, effectiveTo: DateSchema.nullish(),
}).openapi("CreateTaxCode");

export const TaxCodeQuery = ListQuery.extend({
  "filter[regimeCode][eq]": z.string().optional(),
  "filter[archived][eq]": z.enum(["true", "false"]).optional(),
}).strict();
export const TaxCodeList = ListEnvelope(TaxCodeSchema);

export const ReturnBoxSchema = z.object({
  code: z.string(), label: z.string(), amount: Amount,
}).openapi("ReturnBox");

export const TaxReturnStatusSchema = z.enum(["draft", "generated", "filed"]);
export const TaxReturnSchema = z.object({
  id: UuidSchema, regimeId: UuidSchema, regimeCode: z.string(), regimeVersion: z.number().int(),
  periodStart: DateSchema, periodEnd: DateSchema, status: TaxReturnStatusSchema,
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  generatedBy: UuidSchema.nullable(), filedAt: TimestampSchema.nullable(),
  attachmentId: UuidSchema.nullable(), createdAt: TimestampSchema,
}).openapi("TaxReturn");
export type TaxReturnDto = z.infer<typeof TaxReturnSchema>;

export const CreateTaxReturnBody = z.object({
  /** The regime CODE and version, resolved server-side — a screen picks from the tax-code list's rows and
   *  never has to hold a per-tenant uuid.
   *
   *  ⚠️ **A regime code admits a lower-case letter after the first**, and the tax-CODE pattern above does
   *  not. The shipped regime is `SYNTH-MY-v1`; the all-caps form would reject the only regime this slice
   *  ships and no return could be created at all. This regex is the same one
   *  `tax-pack.schema.json`'s `$defs/regimeCode` carries, and the two must stay identical. */
  regimeCode: z.string().regex(/^[A-Z][A-Za-z0-9-]{1,31}$/), regimeVersion: z.number().int().positive(),
  periodStart: DateSchema, periodEnd: DateSchema,
}).refine((b) => b.periodEnd >= b.periodStart, { message: "periodEnd must not precede periodStart" })
  .openapi("CreateTaxReturn");

export const TaxReturnQuery = ListQuery.extend({
  "filter[regimeCode][eq]": z.string().optional(),
}).strict();
export const TaxReturnList = ListEnvelope(TaxReturnSchema);

export const TaxReturnTieOutRowSchema = z.object({
  accountCode: z.string(), boxCodes: z.array(z.string()),
  boxBase: Amount, ledgerBase: Amount, difference: Amount,
}).openapi("TaxReturnTieOutRow");

/** The single-return read: the row, its boxes as generated, the payload bytes, and the tie-out. */
export const TaxReturnDetail = z.object({
  taxReturn: TaxReturnSchema,
  boxes: z.array(ReturnBoxSchema),
  payload: z.string().nullable(),
  tieOut: z.array(TaxReturnTieOutRowSchema),
  currency: CurrencySchema,
}).openapi("TaxReturnDetail");
```

- [ ] **Step 5: Write the two route modules and register them**

`apps/api/src/routes/accounting/tax-codes.ts` keeps T4's `TAX_PERMISSION` and gains:

```ts
// apps/api/src/routes/accounting/tax-codes.ts — T4's TAX_PERMISSION const stays exactly as it is; these
// imports and everything below join it.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { archiveTaxCode, createTaxCode, listTaxCodes, type TaxCodeRow } from "@dulja/db";
import { decodeCursor, encodeCursor, ProblemSchema, UuidSchema } from "@dulja/contracts";
import { CreateTaxCodeBody, TaxCodeList, TaxCodeQuery, TaxCodeSchema,
         type TaxCodeDto } from "@dulja/contracts/accounting/tax";
import { IdempotencyHeader, requirePermission, type AppEnv, type RouteModule } from "../../kernel";

export const taxCodeRoutes = new OpenAPIHono<AppEnv>();

const scope = { company: "path:companyId" } as const;

taxCodeRoutes.openapi(createRoute({
  method: "get", path: "/",
  request: { params: z.object({ companyId: UuidSchema }), query: TaxCodeQuery },
  responses: { 200: { content: { "application/json": { schema: TaxCodeList } }, description: "Tax codes" },
               403: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Forbidden" } },
  middleware: [requirePermission(TAX_PERMISSION.manage, scope)], tags: ["accounting"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const rows = await c.var.withTenant((tx) => listTaxCodes(tx, {
    companyId, regimeCode: q["filter[regimeCode][eq]"],
    includeArchived: q["filter[archived][eq]"] === "true",
    cursor: cursor ? { code: cursor.k[0] as string, id: cursor.id } : null,
    limit: q.limit + 1,
  }));
  const page = rows.slice(0, q.limit);
  const next = rows.length > q.limit && page.length > 0
    ? encodeCursor({ k: [page[page.length - 1]!.code], id: page[page.length - 1]!.id }) : null;
  return c.json({ items: page.map(toTaxCodeDto), next_cursor: next }, 200);
});

taxCodeRoutes.openapi(createRoute({
  method: "post", path: "/",
  request: { params: z.object({ companyId: UuidSchema }), headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: CreateTaxCodeBody } } } },
  responses: { 201: { content: { "application/json": { schema: TaxCodeSchema } }, description: "Created" },
               422: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Unresolvable account" } },
  middleware: [requirePermission(TAX_PERMISSION.manage, scope)], tags: ["accounting"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await c.var.withTenant((tx) => createTaxCode(tx, c.var.ctx, { companyId, ...body,
    nameAr: body.nameAr ?? null, effectiveTo: body.effectiveTo ?? null }));
  return c.json(toTaxCodeDto(row), 201);
});

taxCodeRoutes.openapi(createRoute({
  method: "post", path: "/{taxCodeId}/archive",
  request: { params: z.object({ companyId: UuidSchema, taxCodeId: UuidSchema }), headers: IdempotencyHeader },
  responses: { 204: { description: "Archived" },
               404: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Not found" } },
  middleware: [requirePermission(TAX_PERMISSION.manage, scope)], tags: ["accounting"],
}), async (c) => {
  const { taxCodeId } = c.req.valid("param");
  await c.var.withTenant((tx) => archiveTaxCode(tx, c.var.ctx, taxCodeId));
  return c.body(null, 204);
});

export const taxCodeRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/tax-codes",
  router: taxCodeRoutes,
  permissions: [TAX_PERMISSION.manage],
  auth: "human",
};
```

and the file-local mapper, written out because a second spelling of it is how two shapes of one DTO enter the codebase (hazard 35). Every member but `archivedAt` is already named identically on both sides:

```ts
/** `TaxCodeRow` (packages/db) → `TaxCodeDto` (the wire). The one conversion: `archived_at` comes back as a
 *  `text` timestamp and `TimestampSchema` wants RFC 3339, which is what `toISOString()` produces. */
function toTaxCodeDto(row: TaxCodeRow): TaxCodeDto {
  return {
    id: row.id, regimeId: row.regimeId, regimeCode: row.regimeCode, regimeVersion: row.regimeVersion,
    code: row.code, nameEn: row.nameEn, nameAr: row.nameAr,
    rate: row.rate, kind: row.kind, roundingMode: row.roundingMode,
    outputAccountId: row.outputAccountId, inputAccountId: row.inputAccountId,
    effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo,
    archivedAt: row.archivedAt === null ? null : new Date(row.archivedAt).toISOString(),
  };
}
```

`apps/api/src/routes/accounting/tax-returns.ts` — four routes on `/v1/companies/:companyId/tax-returns`, all four behind `requirePermission(TAX_PERMISSION.manage, { company: "path:companyId" })` and the two unsafe ones behind `IdempotencyHeader`:

```ts
// apps/api/src/routes/accounting/tax-returns.ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createTaxReturn, findRegime, generateTaxReturn, getTaxReturn, listTaxReturns,
         taxReturnTieOut, type TaxReturnRow } from "@dulja/db";
import { AppError } from "@dulja/contracts";
import { CreateTaxReturnBody, TaxReturnDetail, TaxReturnList, TaxReturnQuery, TaxReturnSchema,
         type TaxReturnDto } from "@dulja/contracts/accounting/tax";
import { decodeCursor, encodeCursor, ProblemSchema, UuidSchema } from "@dulja/contracts";
// The kernel path 4B's own route module uses (phase-4b:7600). `tax-codes.ts` — written in this same task —
// imports the identical set; if the merged tree names it differently, correct BOTH files, never one.
import { IdempotencyHeader, requirePermission, type AppEnv, type RouteModule } from "../../kernel";
import { TAX_PERMISSION } from "./tax-codes";

export const taxReturnRoutes = new OpenAPIHono<AppEnv>();

const scope = { company: "path:companyId" } as const;
const params = z.object({ companyId: UuidSchema });
const detailParams = z.object({ companyId: UuidSchema, taxReturnId: UuidSchema });

/** `TaxReturnRow` → the wire row. `payload` is deliberately NOT on `TaxReturnSchema` — a list of returns
 *  would otherwise carry a full payload per item; the detail response has its own `payload` member. */
function toTaxReturnDto(row: TaxReturnRow): TaxReturnDto {
  return {
    id: row.id, regimeId: row.regimeId, regimeCode: row.regimeCode, regimeVersion: row.regimeVersion,
    periodStart: row.periodStart, periodEnd: row.periodEnd, status: row.status,
    payloadSha256: row.payloadSha256, generatedBy: row.generatedBy,
    filedAt: row.filedAt === null ? null : new Date(row.filedAt).toISOString(),
    attachmentId: row.attachmentId, createdAt: new Date(row.createdAt).toISOString(),
  };
}

// ── GET / — the list ───────────────────────────────────────────────────────────────────────────────────
taxReturnRoutes.openapi(createRoute({
  method: "get", path: "/",
  request: { params, query: TaxReturnQuery },
  responses: { 200: { content: { "application/json": { schema: TaxReturnList } }, description: "Tax returns" },
               403: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Forbidden" } },
  middleware: [requirePermission(TAX_PERMISSION.manage, scope)], tags: ["accounting"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const rows = await c.var.withTenant((tx) => listTaxReturns(tx, {
    companyId, regimeCode: q["filter[regimeCode][eq]"],
    cursor: cursor ? { periodStart: cursor.k[0] as string, id: cursor.id } : null,
    limit: q.limit + 1,
  }));
  const page = rows.slice(0, q.limit);
  const next = rows.length > q.limit && page.length > 0
    ? encodeCursor({ k: [page[page.length - 1]!.periodStart], id: page[page.length - 1]!.id }) : null;
  return c.json({ items: page.map(toTaxReturnDto), next_cursor: next }, 200);
});

// ── POST / — reserve the period ────────────────────────────────────────────────────────────────────────
taxReturnRoutes.openapi(createRoute({
  method: "post", path: "/",
  request: { params, headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: CreateTaxReturnBody } } } },
  responses: { 201: { content: { "application/json": { schema: TaxReturnSchema } }, description: "Created" },
               404: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "No such regime" },
               409: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Period already reserved" },
               422: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Partial fiscal period" } },
  middleware: [requirePermission(TAX_PERMISSION.manage, scope)], tags: ["accounting"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await c.var.withTenant(async (tx) => {
    // 404, never 403 and never 422: RLS bounds the lookup, so another tenant's regime is indistinguishable
    // from one that does not exist, and a probe learns nothing from the status code.
    const regimeId = await findRegime(tx, companyId, body.regimeCode, body.regimeVersion);
    if (regimeId === null) {
      throw new AppError("ERR_NOT_FOUND",
        `no tax regime ${body.regimeCode} v${body.regimeVersion} for this company`);
    }
    // The unique key surfaces as 409 ERR_CONFLICT_UNIQUE through fromDatabaseError; the partial-period
    // refusal is a PostingError("ERR_POLICY_REQUIRES_MISSING") and reaches 422 through the branch
    // apps/api/src/problem.ts already has. Neither is caught here.
    return createTaxReturn(tx, c.var.ctx, {
      companyId, regimeId, periodStart: body.periodStart, periodEnd: body.periodEnd,
    });
  });
  return c.json(toTaxReturnDto(row), 201);
});

// ── POST /{id}/generate ────────────────────────────────────────────────────────────────────────────────
taxReturnRoutes.openapi(createRoute({
  method: "post", path: "/{taxReturnId}/generate",
  request: { params: detailParams, headers: IdempotencyHeader },
  responses: { 200: { content: { "application/json": { schema: TaxReturnDetail } }, description: "Generated" },
               404: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Not found" },
               422: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Regime mismatch or filed" } },
  middleware: [requirePermission(TAX_PERMISSION.manage, scope)], tags: ["accounting"],
}), async (c) => {
  const { taxReturnId } = c.req.valid("param");
  const out = await c.var.withTenant(async (tx) => {
    const g = await generateTaxReturn(tx, c.var.ctx, taxReturnId);
    return { ...g, tieOut: await taxReturnTieOut(tx, taxReturnId) };
  });
  return c.json({
    taxReturn: toTaxReturnDto(out.row),
    boxes: out.boxes.map((b) => ({ code: b.code, label: b.label, amount: b.amount.toString() })),
    payload: out.row.payload, tieOut: out.tieOut, currency: out.currency,
  }, 200);
});

// ── GET /{id} ──────────────────────────────────────────────────────────────────────────────────────────
taxReturnRoutes.openapi(createRoute({
  method: "get", path: "/{taxReturnId}",
  request: { params: detailParams },
  responses: { 200: { content: { "application/json": { schema: TaxReturnDetail } }, description: "Tax return" },
               404: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Not found" } },
  middleware: [requirePermission(TAX_PERMISSION.manage, scope)], tags: ["accounting"],
}), async (c) => {
  const { taxReturnId } = c.req.valid("param");
  const out = await c.var.withTenant(async (tx) => {
    const g = await getTaxReturn(tx, taxReturnId);
    // A draft has no payload, so there is nothing to reconcile — `taxReturnTieOut` refuses it by design
    // (ERR_DOC_STATUS_ILLEGAL), and a GET must not 422 for the ordinary state of a new row.
    return { ...g, tieOut: g.row.payload === null ? [] : await taxReturnTieOut(tx, taxReturnId) };
  });
  return c.json({
    taxReturn: toTaxReturnDto(out.row),
    boxes: out.boxes.map((b) => ({ code: b.code, label: b.label, amount: b.amount.toString() })),
    payload: out.row.payload, tieOut: out.tieOut, currency: out.currency,
  }, 200);
});

export const taxReturnRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/tax-returns",
  router: taxReturnRoutes,
  permissions: [TAX_PERMISSION.manage],
  auth: "human",
};
```

**`generate` is idempotent by nature and does *not* join `REPLAY_BY_RERUN`** (§4.2.9): its response is JSON, it writes, and a replay of the stored body is exactly right — the second generation would produce the identical bytes anyway.

Both modules are added **inside `buildRoutes`** (never by pushing onto `ROUTES` — §4.2.7), and `tests/invariants/probes.ts` gains exactly two entries keyed by the two `RouteModule.path` strings: each seeds a tax code and a return owned by tenant B, performs `GET` as tenant A and expects **404**.

`docs/runbooks/tax-return.md` — the periodic procedure in eight numbered steps: confirm every document of the period is posted (`GET …/documents?filter[status][eq]=draft`); `POST …/tax-returns` for the period; `POST …/tax-returns/{id}/generate`; read `tieOut` and stop if any `difference` is not `0.0000`; compare the boxes to the accountant's own working; keep the `payloadSha256` with the filing record; re-run `generate` after any correction and expect a **different** sha (a correction that changes no figure is not a correction); and — once 5B lands — hand the payload to `accounting.tax.submit`. Two sample query strings are included in full.

- [ ] **Step 6: Flip the `tax` block on 4A's four types (the test 15 re-run)**

Each of the four files gains `"policyVersion": 2` and, inside `policy`, `"tax": { "applies": true, "inclusive": "header.tax_inclusive" }` plus one `each_tax` rule. **§3.4.8's policy rule applies: `posting_policy` upserts `on conflict (document_type_id, version) do update`, so version 1 stays in place for documents already dated under it** and this is a `policyVersion: 2` row, not an edit. `SALES_INVOICE.json`'s and `SALES_CREDIT_NOTE.json`'s new rule:

```json
      { "for": "each_tax",  "side": "credit", "account": { "from": "tax_code.output_account" }, "amount": "tax.amount" },
```

`PURCHASE_INVOICE.json`'s and `PURCHASE_CREDIT_NOTE.json`'s:

```json
      { "for": "each_tax",  "side": "debit",  "account": { "from": "tax_code.input_account" },  "amount": "tax.amount" },
```

and each file's `effectiveFrom` becomes **`"2026-01-01"`** — unchanged from version 1, because the tax block is not a mid-year rate change but the completion of a policy 4A shipped deliberately incomplete. **No account-code literal appears in any of the four**: the two references resolve through `tax_code.output_account_id` / `input_account_id`, which Task 6's loader sets from `2300` and `1350` — which is why hazard 33 is satisfied at the seed and not at the policy.

**The AR leg already reads the tax-inclusive total.** 4A's `SALES_INVOICE` policy debits `party.receivable_account` with `line.total_incl_tax` (spec:2009–2028's worked example), which `computeDocumentTax` now fills — so the invoice balances as `total_incl_tax = amount + tax.amount` with no further rule. **A reviewer should check this on 4A's actual file**: if 4A debited `line.amount` instead, the document will not balance once tax exists and the fix is one word in 4A's rule, recorded in this task's commit body rather than worked around here.

Applied as a task step, so the four rows exist for the route tests:

```bash
bun run --cwd packages/db seed --tenant "$TENANT_ID" --only document-types
```

- [ ] **Step 7: Write the two route tests, run everything to pass, commit**

Both files drive the real app through `startApi()` (§4.2.12) and read every refusal through 0B's `problemOf`.

`apps/api/test/routes/accounting/tax-codes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The two paths 4B's route test uses (phase-4b:6362-6365): `startApi` from apps/api's own support module,
// `problemOf` from the root tests/ one.
import { startApi, type StartedApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";
import { grantCodes, seedAccount, seedTaxCode, seedTenantV2, startDb, type Db, type Seed }
  from "@dulja/db/test";
// 3D exported 3B's module-private helper for exactly this shape of case: a second human in the SAME tenant
// and company, holding no grant of its own (phase-3d:206). Using another tenant's principal instead would
// make the request wrong-tenant rather than wrong-permission, and which status the scope check answers for
// a company outside the caller's tenant is not something this plan may assume.
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";

let db: Db;
let api: StartedApi;
let a: Seed;
let ungranted: string;
let regimeId: string;

beforeAll(async () => {
  db = await startDb();
  api = await startApi(db);
  a = await seedTenantV2(db, "taxapi-a");
  await seedAccount(db, a, { code: "2300", nameEn: "Output tax payable", type: "liability" });
  await grantCodes(db, a, { codes: ["accounting.tax.manage"] });
  ungranted = await secondPrincipal(db, a, "no-tax-grant");
  ({ regimeId } = await seedTaxCode(db, a, { code: "SYN-OUT-STD" }));
}, 300_000);
afterAll(async () => { await api?.stop(); await db?.stop(); });

const base = () => `/v1/companies/${a.company}/tax-codes`;

describe("tax-codes routes (§4.2.7, §4.2.8)", () => {
  it("GET / lists the company's codes in (code, id) order", async () => {
    const res = await api.request({ method: "GET", path: `${base()}?limit=50`, as: a.human });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: { code: string; rate: string; regimeCode: string }[] };
    expect(body.items.map((i) => i.code)).toEqual(["SYN-OUT-STD"]);
    expect(body.items[0]!.rate).toBe("0.11000000");
    expect(body.items[0]!.regimeCode).toBe("SYNTH-MY-v1");
  });

  it("POST / creates a code and resolves its account by §4.15 CODE", async () => {
    const res = await api.request({ method: "POST", path: base(), as: a.human,
      idempotencyKey: crypto.randomUUID(),
      body: { regimeId, code: "SYN-OUT-B", nameEn: "Second output (synthetic)", rate: "0.11000000",
              kind: "output", roundingMode: "HALF_EVEN", accountCode: "2300",
              effectiveFrom: "2026-04-01" } });
    expect(res.status).toBe(201);
    const dto = await res.json() as { outputAccountId: string | null; roundingMode: string };
    expect(dto.outputAccountId).not.toBeNull();
    expect(dto.roundingMode).toBe("HALF_EVEN");
  });

  it("POST / with an accountCode the company lacks is 422 ERR_POLICY_REQUIRES_MISSING", async () => {
    const res = await api.request({ method: "POST", path: base(), as: a.human,
      idempotencyKey: crypto.randomUUID(),
      body: { regimeId, code: "SYN-NO-ACCT", nameEn: "No account", rate: "0.11000000", kind: "input",
              roundingMode: "HALF_AWAY_FROM_ZERO", accountCode: "1350", effectiveFrom: "2026-04-01" } });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_POLICY_REQUIRES_MISSING");
  });

  it("every unsafe route refuses a missing idempotency key (§4.2.9)", async () => {
    for (const path of [base(), `${base()}/${crypto.randomUUID()}/archive`]) {
      const res = await api.request({ method: "POST", path, as: a.human, idempotencyKey: null, body: {} });
      expect(res.status, path).toBe(400);
      expect((await problemOf(res)).code, path).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    }
  });

  it("a replayed key returns the stored body with Idempotency-Replayed: true", async () => {
    const key = crypto.randomUUID();
    const body = { regimeId, code: "SYN-REPLAY", nameEn: "Replay (synthetic)", rate: "0.11000000",
                   kind: "output", roundingMode: "HALF_AWAY_FROM_ZERO", accountCode: "2300",
                   effectiveFrom: "2026-05-01" };
    const first = await api.request({ method: "POST", path: base(), as: a.human, idempotencyKey: key, body });
    const again = await api.request({ method: "POST", path: base(), as: a.human, idempotencyKey: key, body });
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.text()).toBe(await first.text());
  });

  it("POST /{id}/archive is 204, and archiving twice is 404 (spec:2049 — archived, never deleted)", async () => {
    const { taxCodeId } = await seedTaxCode(db, a, { code: "SYN-ARCH" });
    const path = `${base()}/${taxCodeId}/archive`;
    expect((await api.request({ method: "POST", path, as: a.human, idempotencyKey: crypto.randomUUID() }))
      .status).toBe(204);
    const second = await api.request({ method: "POST", path, as: a.human, idempotencyKey: crypto.randomUUID() });
    expect(second.status).toBe(404);
    expect((await problemOf(second)).code).toBe("ERR_NOT_FOUND");
  });

  it("a principal of THIS tenant without accounting.tax.manage is 403 ERR_RBAC_FORBIDDEN", async () => {
    // Same tenant, same company, no grant — so the only thing that can refuse is `requirePermission`, and
    // the status is unambiguous. (A wrong-TENANT request is a different question with a different answer,
    // and the probe in `tests/invariants/probes.ts` is what owns it.)
    const res = await api.request({ method: "GET", path: base(), as: ungranted });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("an undeclared query parameter is ERR_VALIDATION_FAILED — .strict() is what produces it", async () => {
    const res = await api.request({ method: "GET", path: `${base()}?filter[rate][eq]=0.11000000`, as: a.human });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });
});
```

`apps/api/test/routes/accounting/tax-returns.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi, type StartedApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";
import { startDb, type Db } from "@dulja/db/test";
import { postTaxedDocument, taxFixture, type TaxFixture } from "../../../../../tests/invariants/support/tax";

let db: Db;
let api: StartedApi;
let f: TaxFixture;
let g: TaxFixture;          // a SECOND tenant, for the cross-tenant reads
let returnId: string;

const Q1 = { periodStart: "2026-01-01", periodEnd: "2026-03-31" };

beforeAll(async () => {
  db = await startDb();
  api = await startApi(db);
  f = await taxFixture(db, "returnsapi-a");
  g = await taxFixture(db, "returnsapi-b");
  await postTaxedDocument(db, f, { typeCode: "SALES_INVOICE", effectiveDate: "2026-01-15",
    lines: [{ lineNo: 1, amount: "1000.0000", taxCode: "SYN-OUT-STD" }] });
}, 300_000);
afterAll(async () => { await api?.stop(); await db?.stop(); });

const base = (t: TaxFixture) => `/v1/companies/${t.s.company}/tax-returns`;
const create = (t: TaxFixture, body: Record<string, unknown>) =>
  api.request({ method: "POST", path: base(t), as: t.s.human, idempotencyKey: crypto.randomUUID(), body });

describe("tax-returns routes (§4.2.7, the Phase 5 DoD's API half)", () => {
  it("POST / reserves the period and answers 201", async () => {
    const res = await create(f, { regimeCode: "SYNTH-MY-v1", regimeVersion: 1, ...Q1 });
    expect(res.status).toBe(201);
    const dto = await res.json() as { id: string; status: string; payloadSha256: string | null };
    expect(dto).toMatchObject({ status: "draft", payloadSha256: null });
    returnId = dto.id;
  });

  it("a second reservation of the same period is 409 ERR_CONFLICT_UNIQUE", async () => {
    const res = await create(f, { regimeCode: "SYNTH-MY-v1", regimeVersion: 1, ...Q1 });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("a regime the TENANT does not have is 404, not 403 and not 422 — a probe learns nothing", async () => {
    const res = await create(f, { regimeCode: "SYNTH-MY-v9", regimeVersion: 9, ...Q1 });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("a window that cuts a fiscal period in half is 422 ERR_POLICY_REQUIRES_MISSING", async () => {
    const res = await create(f, { regimeCode: "SYNTH-MY-v1", regimeVersion: 1,
                                  periodStart: "2026-04-15", periodEnd: "2026-06-30" });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_POLICY_REQUIRES_MISSING");
  });

  it("POST /{id}/generate returns the detail, and GET /{id} returns the identical bytes", async () => {
    const gen = await api.request({ method: "POST", path: `${base(f)}/${returnId}/generate`,
      as: f.s.human, idempotencyKey: crypto.randomUUID() });
    expect(gen.status).toBe(200);
    const detail = await gen.json() as {
      taxReturn: { status: string; payloadSha256: string | null };
      boxes: { code: string; amount: string }[]; payload: string | null;
      tieOut: { accountCode: string; difference: string }[]; currency: string };
    expect(detail.taxReturn.status).toBe("generated");
    expect(detail.taxReturn.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.boxes.find((b) => b.code === "S2")!.amount).toBe("110.0000");
    expect(detail.tieOut.map((r) => r.difference)).toEqual(["0.0000", "0.0000"]);
    expect(detail.currency).toBe("MYR");

    const read = await api.request({ method: "GET", path: `${base(f)}/${returnId}`, as: f.s.human });
    expect(read.status).toBe(200);
    expect((await read.json() as { payload: string }).payload).toBe(detail.payload);
  });

  it("GET /{id} on a DRAFT is 200 with no boxes and an empty tieOut, never a 422", async () => {
    const made = await create(f, { regimeCode: "SYNTH-MY-v1", regimeVersion: 1,
                                   periodStart: "2026-07-01", periodEnd: "2026-09-30" });
    const { id } = await made.json() as { id: string };
    const res = await api.request({ method: "GET", path: `${base(f)}/${id}`, as: f.s.human });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ boxes: [], tieOut: [], payload: null });
  });

  it("a generate whose regime the PACK has no definition for is 422 ERR_TAX_REGIME_MISMATCH", async () => {
    // The reachable half of amendment A3. A *foreign-regime transaction* cannot be provoked through the
    // API — `transactionsFor` binds `t.regime_id` — and a mixed-regime document never posts at all.
    const gctx = { tenantId: g.s.tenant, actorId: g.s.human, requestId: "unknown-regime" };
    const [other] = await (await import("@dulja/db")).withTenant(db.rw, gctx, (tx) => tx<{ id: string }[]>`
      insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                  name_en, source)
      values (${g.s.tenant}, ${g.s.company}, 'OTHER-MY-v1', 'MY', 1, '2026-01-01',
              'Second synthetic regime', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
      returning id`);
    expect(other).toBeDefined();
    const made = await create(g, { regimeCode: "OTHER-MY-v1", regimeVersion: 1, ...Q1 });
    const { id } = await made.json() as { id: string };
    const res = await api.request({ method: "POST", path: `${base(g)}/${id}/generate`,
      as: g.s.human, idempotencyKey: crypto.randomUUID() });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_TAX_REGIME_MISMATCH");
  });

  it("another tenant's return id is 404 inside that tenant's own scope, and unsafe routes need a key", async () => {
    // The convention `tests/invariants/probes.ts` uses and the only one this plan may assert: tenant G asks
    // for a row id owned by F, under **G's own company path**, so the scope check passes and RLS is what
    // answers. A request against F's company path is a wrong-TENANT question whose status this plan does
    // not fix, and asserting a guess there is how a test gets "corrected" to whatever the framework did.
    const scoped = await api.request({ method: "GET", path: `${base(g)}/${returnId}`, as: g.s.human });
    expect(scoped.status).toBe(404);
    expect((await problemOf(scoped)).code).toBe("ERR_NOT_FOUND");
    for (const path of [base(f), `${base(f)}/${returnId}/generate`]) {
      const res = await api.request({ method: "POST", path, as: f.s.human, idempotencyKey: null, body: {} });
      expect(res.status, path).toBe(400);
      expect((await problemOf(res)).code, path).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    }
  });
});
```

⚠️ **That refusal is the reachable one, and the unreachable neighbour is worth naming.** "A generate whose period holds a *foreign regime's* transactions" cannot be provoked through the API: `transactionsFor` binds `t.regime_id = ${row.regimeId}`, so a foreign row is never selected — and a document mixing two regimes is refused by `resolveRegimeFor` at compute time and never posts at all (T9 Step 6 proves both halves). The reachable refusal is a regime the **pack** does not define, which is amendment A3's *"a regime the pack does not know **is** a mismatch"*, and it is one `ERR_TAX_REGIME_MISMATCH` either way.

```bash
bun run --cwd packages/db test -- tax/returns \
  && bun run --cwd apps/api test -- routes/accounting/tax-codes routes/accounting/tax-returns \
  && bun run --cwd tests test -- invariants/tenant-isolation \
  && bun run --cwd packages/contracts openapi:generate && bun run typecheck && bun run lint:rules
```

The OpenAPI document is regenerated **in this commit** — CI fails on a diff (spec:2055).

```bash
git add packages/db/src/tax/returns.ts packages/db/src/tax/index.ts \
        packages/contracts/src/accounting/tax.ts packages/contracts/openapi.json \
        apps/api/src/routes/accounting/tax-codes.ts apps/api/src/routes/accounting/tax-returns.ts \
        apps/api/src/routes/index.ts tests/invariants/probes.ts \
        packages/db/seed/my/document-types/SALES_INVOICE.json \
        packages/db/seed/my/document-types/SALES_CREDIT_NOTE.json \
        packages/db/seed/my/document-types/PURCHASE_INVOICE.json \
        packages/db/seed/my/document-types/PURCHASE_CREDIT_NOTE.json \
        docs/runbooks/tax-return.md packages/db/test/tax/returns.test.ts \
        apps/api/test/routes/accounting/
git commit -m "$(cat <<'EOF'
feat(api): generate tax returns, reconcile them, and expose two route modules [5A T8]

A return is two steps -- draft reserves the period, generate builds the payload from
app.tax_transaction alone, validates it through the pack and stamps generated_by on the
NULL -> value transition. taxReturnTieOut reads account_balance (1B's rule) and takes its
orientation from app.account.type, so the equality cannot pass for assets and fail for
liabilities. The four 4A policies gain their each_tax leg at policyVersion 2 -- a seed PR
and not one line of TypeScript, which is the test 15 re-run this slice owns.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

### Task 9: `tests/golden/tax/` and acceptance test 26 — the whole definition of done

**No migration.** The task that turns everything Tasks 1–8 built into the one sentence §2.6 assigns this slice: *"The return is generated, validated and reconciled end-to-end against a golden fixture"*, and the Part VI row it owns:

> **26. Tax return determinism.** *A golden fixture of documents produces a byte-identical return across runs; a tax code from the wrong regime causes a refusal, not a wrong number.* (spec:2444; LEGACY-020, 058, 059)

**Why this harness goes through the database, when 3B's costing harness does not.** 3B's golden driver is pure — it calls `evaluatePolicy` over a `DocumentSnapshot[]` and never opens a connection, which is why its cases carry a `policies.json`. This one cannot be: the DoD's third verb is **reconciled**, `taxReturnTieOut` reads `app.account_balance`, and `account_balance` exists only after `postDocument` has run inside a transaction. So the fixture is symbolic input driven through the real stack — `taxFixture` → `postTaxedDocument` → `createTaxReturn` → `generateTaxReturn` → `taxReturnTieOut` — and the byte-compare is over the **output**. That is amendment A10, and it is also why a `policies.json` would be wrong here: `taxFixture` reads the four 4A envelopes off disk through `seedTypeFromPack`, and a second copy of those policies in the fixture directory is two spellings of one thing (hazard 9).

**The two cases, and why the second one is the sharper test.**

| Case | What it is | What only it can prove |
|---|---|---|
| `synth-my-quarter` | Five documents across 2026 Q1: a standard-rated sale, a credit note, a standard-rated purchase, a zero-rated sale and an exempt sale. All **tax-exclusive**. | Every box of `SYNTH-MY-v1` is fed by at least one transaction; both control accounts tie out; a credit note **reduces** the output box rather than adding to it. |
| `synth-my-inclusive` | The same five documents, the same dates, the same parties — entered **tax-inclusive** at their gross figures (`1110.0000`, `-222.0000`, `555.0000`, `300.0000`, `150.0000`). | The inclusive extraction reaches the identical boxes. Its `payload` and `payloadSha256` are **byte-identical to the first case's**, which is a stronger statement than "each case is stable across runs": it says the two entry conventions are one computation. |

**The credit note carries negated magnitudes, and that is 4A's rule, not this task's convention.** phase-4a:3845 is explicit — *"a credit note's policy carries **the same `side`s as its invoice**, and the negation of the line magnitudes is what turns them into credits. Getting this backwards … produces a type that posts correctly when created by hand and **backwards** when created by `reverseDocument`"*. So `SALES_CREDIT_NOTE`'s line in this fixture is `amount: "-200.0000"`; `computeDocumentTax` derives `tax_amount = -22.0000` from it through the engine's symmetric rounding (LEGACY-019); §4.4.2 A9 flips the `each_tax` credit into a **debit** of `2300` at `22.0000`; and `PlannedTaxLine.amount` — A9's one registered exception — stays **`-22.0000`**, which is exactly the figure box `S2` needs. **If a reviewer changes that line to `200.0000`, `S2` reads `132.0000`, the ledger still reads `88.0000`, and the tie-out fails by `44.0000`.** The failure is loud, which is the point of writing the tie-out into the fixture rather than only the boxes.

**Files:**
- Create: `tests/golden/tax.test.ts`
- Create: `tests/golden/tax/synth-my-quarter/input.json`, `tests/golden/tax/synth-my-quarter/expected.json`
- Create: `tests/golden/tax/synth-my-inclusive/input.json`, `tests/golden/tax/synth-my-inclusive/expected.json`
- Modify: nothing. **This task adds no production code at all** — if it needs one, that is a defect in Tasks 5–8 and it is fixed there.

**Interfaces**

- Consumes: `startDb`, `Db` (§4.1, via `@dulja/db/test`); the production `withTenant`, `TenantContext` (§4.2.2 — root `tests/` use the production one, hazard 15); `taxFixture`, `TaxFixture`, `postTaxedDocument` (T7, `tests/invariants/support/tax.ts`); `createTaxReturn`, `generateTaxReturn`, `getTaxReturn`, `taxReturnTieOut`, `TaxReturnTieOutRow` (T8); `malaysiaPack`, `SYNTH_MY_V1`, `canonicalJson`, `ReturnBox` (T5, T6); `Money`, `currency` (§4.2.1); **`seedTaxCode` (T1) for the wrong-regime case, called with an explicit `regimeId`** — the helper reuses `SYNTH-MY-v1` when none is passed (T1 Step 5), so the second regime is inserted by the test itself.
- Produces: **no production interface.** Inside `tests/golden/tax.test.ts` only:

```ts
/** A10's on-disk box: `ReturnBox` with `amount` as a 4-dp string, because `Money` is not JSON. */
export interface GoldenBox { code: string; label: string; amount: string }
export interface GoldenLine { lineNo: number; accountCode: string; amount: string; taxCode: string | null }
export interface GoldenDocument {
  typeCode: "SALES_INVOICE" | "SALES_CREDIT_NOTE" | "PURCHASE_INVOICE" | "PURCHASE_CREDIT_NOTE";
  effectiveDate: string; party: "customer" | "vendor"; taxInclusive: boolean; lines: GoldenLine[];
}
export interface GoldenCase {
  regimeCode: string; regimeVersion: number; periodStart: string; periodEnd: string;
  documents: GoldenDocument[];
}
/** A10: the rendered return, its sha, and the tie-out — the DoD's three verbs are three assertions. */
export interface TaxGoldenExpectation {
  boxes: GoldenBox[]; payload: string; payloadSha256: string; tieOut: TaxReturnTieOutRow[];
}
declare function runGoldenCase(db: Db, name: string, input: GoldenCase): Promise<TaxGoldenExpectation>;
declare const CASES: readonly ["synth-my-quarter", "synth-my-inclusive"];
```

- [ ] **Step 1: Write the failing harness**

`tests/golden/tax.test.ts`. One file, one `startDb()`, one seeded tenant **per case** — the two cases post the same documents and would otherwise sum into one another's boxes.

```ts
// tests/golden/tax.test.ts — acceptance test 26 (spec:2444) and the whole Phase 5 definition of done.
//
// Amendment A10: for the tax area, `expected.json` is a TaxGoldenExpectation and `input.json` is a
// GoldenCase whose documents name their codes, accounts and parties SYMBOLICALLY, because every id in
// this fixture is a per-run uuid. There is no `policies.json`: `taxFixture` reads the four 4A
// document-type envelopes off disk through `seedTypeFromPack`, and a second copy of them here would be
// two spellings of one thing (hazard 9).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { createTaxReturn, generateTaxReturn, getTaxReturn, taxReturnTieOut,
         type TaxReturnTieOutRow } from "@dulja/db";
import { canonicalJson, malaysiaPack, Money, currency, SYNTH_MY_V1 } from "@dulja/domain";
import { seedTaxCode, startDb, type Db } from "@dulja/db/test";
import { postTaxedDocument, taxFixture, type TaxFixture } from "../invariants/support/tax";

const DIR = fileURLToPath(new URL("./tax/", import.meta.url));
const CASES = ["synth-my-quarter", "synth-my-inclusive"] as const;

export interface GoldenBox { code: string; label: string; amount: string }
export interface GoldenLine { lineNo: number; accountCode: string; amount: string; taxCode: string | null }
export interface GoldenDocument {
  typeCode: "SALES_INVOICE" | "SALES_CREDIT_NOTE" | "PURCHASE_INVOICE" | "PURCHASE_CREDIT_NOTE";
  effectiveDate: string; party: "customer" | "vendor"; taxInclusive: boolean; lines: GoldenLine[];
}
export interface GoldenCase {
  regimeCode: string; regimeVersion: number; periodStart: string; periodEnd: string;
  documents: GoldenDocument[];
}
export interface TaxGoldenExpectation {
  boxes: GoldenBox[]; payload: string; payloadSha256: string; tieOut: TaxReturnTieOutRow[];
}

function readCase(name: string): GoldenCase {
  return JSON.parse(readFileSync(join(DIR, name, "input.json"), "utf8")) as GoldenCase;
}

/**
 * Drives one case end to end and returns exactly what `expected.json` holds. **No assertion lives in
 * here** — the harness produces, the tests compare, and `UPDATE_GOLDEN=1` writes. A generated expected
 * file nobody read is a snapshot of whatever the code did, so Step 5 reads them against a hand table.
 */
async function runGoldenCase(db: Db, name: string, input: GoldenCase): Promise<TaxGoldenExpectation> {
  const f: TaxFixture = await taxFixture(db, name);
  for (const d of input.documents) {
    await postTaxedDocument(db, f, {
      typeCode: d.typeCode,
      effectiveDate: d.effectiveDate,
      partyId: d.party === "customer" ? f.customerId : f.vendorId,
      taxInclusive: d.taxInclusive,
      lines: d.lines.map((l) => ({
        lineNo: l.lineNo, kind: "account", accountId: f.accounts[l.accountCode]!,
        amount: l.amount, taxCode: l.taxCode,
      })),
    });
  }
  const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: `golden-${name}` };
  return withTenant(db.rw, ctx, async (tx) => {
    const draft = await createTaxReturn(tx, ctx, {
      companyId: f.s.company, regimeId: f.regimeId,
      periodStart: input.periodStart, periodEnd: input.periodEnd,
    });
    const { row, boxes } = await generateTaxReturn(tx, ctx, draft.id);
    const tieOut = await taxReturnTieOut(tx, draft.id);
    return {
      boxes: boxes.map((b) => ({ code: b.code, label: b.label, amount: b.amount.toString() })),
      payload: row.payload!,
      payloadSha256: row.payloadSha256!,
      tieOut,
    };
  });
}

describe("acceptance test 26 — tax return determinism (spec:2444; LEGACY-020, 058, 059)", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("every case directory holds exactly input.json and expected.json", () => {
    // A10: no `policies.json` in this area. An extra file here means someone copied 3B's layout.
    for (const c of CASES) {
      expect(readdirSync(join(DIR, c)).sort()).toEqual(["expected.json", "input.json"]);
    }
  });

  for (const name of CASES) {
    it(`${name} matches expected.json byte for byte`, async () => {
      const actual = await runGoldenCase(db, name, readCase(name));
      if (process.env.UPDATE_GOLDEN === "1") {
        writeFileSync(join(DIR, name, "expected.json"), `${JSON.stringify(actual, null, 2)}\n`);
      }
      const expected = JSON.parse(
        readFileSync(join(DIR, name, "expected.json"), "utf8")) as TaxGoldenExpectation;
      expect(JSON.stringify(actual, null, 2)).toBe(JSON.stringify(expected, null, 2));
    }, 180_000);
  }
});
```

- [ ] **Step 2: Run it and see the exact expected failure**

```bash
bun run --cwd tests test -- golden/tax
```

Expected, before the fixtures exist — the harness is what fails, and it fails on the directory read rather than on a comparison:

```
FAIL  golden/tax.test.ts > acceptance test 26 > every case directory holds exactly input.json and expected.json
  Error: ENOENT: no such file or directory, scandir '.../tests/golden/tax/synth-my-quarter'
```

**Do not create empty files to get past it.** The next two steps write real ones.

- [ ] **Step 3: Write `synth-my-quarter/input.json`**

Five documents, one line each, all in 2026 Q1, all tax-**exclusive**. `taxFixture` calls `ensureOpenPeriods(db, s, 2026)` (3B), so all twelve 2026 monthly periods are open and Q1 is exactly three whole periods — which is what `createTaxReturn`'s partial-period refusal (T8 Step 3) requires.

```json
{
  "regimeCode": "SYNTH-MY-v1",
  "regimeVersion": 1,
  "periodStart": "2026-01-01",
  "periodEnd": "2026-03-31",
  "documents": [
    {
      "typeCode": "SALES_INVOICE",
      "effectiveDate": "2026-01-15",
      "party": "customer",
      "taxInclusive": false,
      "lines": [
        { "lineNo": 1, "accountCode": "4000", "amount": "1000.0000", "taxCode": "SYN-OUT-STD" }
      ]
    },
    {
      "typeCode": "SALES_CREDIT_NOTE",
      "effectiveDate": "2026-02-10",
      "party": "customer",
      "taxInclusive": false,
      "lines": [
        { "lineNo": 1, "accountCode": "4000", "amount": "-200.0000", "taxCode": "SYN-OUT-STD" }
      ]
    },
    {
      "typeCode": "PURCHASE_INVOICE",
      "effectiveDate": "2026-02-20",
      "party": "vendor",
      "taxInclusive": false,
      "lines": [
        { "lineNo": 1, "accountCode": "5900", "amount": "500.0000", "taxCode": "SYN-IN-STD" }
      ]
    },
    {
      "typeCode": "SALES_INVOICE",
      "effectiveDate": "2026-03-05",
      "party": "customer",
      "taxInclusive": false,
      "lines": [
        { "lineNo": 1, "accountCode": "4000", "amount": "300.0000", "taxCode": "SYN-OUT-ZERO" }
      ]
    },
    {
      "typeCode": "SALES_INVOICE",
      "effectiveDate": "2026-03-20",
      "party": "customer",
      "taxInclusive": false,
      "lines": [
        { "lineNo": 1, "accountCode": "4000", "amount": "150.0000", "taxCode": "SYN-EXEMPT" }
      ]
    }
  ]
}
```

**Four things about this file that a reviewer must be able to check without running it.**

1. **`-200.0000` is deliberate and is 4A's rule** (the paragraph above). The credit note's own policy has the invoice's sides; the negation is what turns them into credits, and it is what makes `tax_transaction.tax` read `-22.0000`.
2. **The two zero-tax documents post only because of amendment A11.** `SYN-OUT-ZERO` and `SYN-EXEMPT` have `output_account_id` null — `tax_code_account_for_kind_check` and the T6 loader put an account on `output` and `input` codes only — so a resolve-then-drop evaluator would refuse them with `ERR_POLICY_REQUIRES_MISSING`. A11 fixes the order and keeps the `PlannedTaxLine`, which is what fills box `S3`. **If Task 0's A11 line is `MISSING`, this fixture is the first thing that fails and the answer is the amendment, not a fourth account code.**
3. **`5900` on the purchase, not `1300`.** A `PURCHASE_INVOICE` line against an inventory account would take 3A's movement path and pull item, warehouse and lot resolution into a fixture about tax. `5900 Other operating expense` is 0C's row, `taxFixture` resolves it, and the tax half of a purchase is identical either way.
4. **Two documents share `2026-03`, on different dates.** That is what makes the tie-out's whole-period window meaningful — a per-period `account_balance` row carrying more than one document's contribution.

- [ ] **Step 4: Write `synth-my-inclusive/input.json`**

The same five documents at the same dates with the same parties, entered **tax-inclusive** at their gross figures. The zero-rated and exempt lines are unchanged in value because extraction at rate `0.00000000` is the identity — written out anyway, because a fixture that omits the uninteresting rows is a fixture whose two cases are not comparable.

```json
{
  "regimeCode": "SYNTH-MY-v1",
  "regimeVersion": 1,
  "periodStart": "2026-01-01",
  "periodEnd": "2026-03-31",
  "documents": [
    {
      "typeCode": "SALES_INVOICE",
      "effectiveDate": "2026-01-15",
      "party": "customer",
      "taxInclusive": true,
      "lines": [
        { "lineNo": 1, "accountCode": "4000", "amount": "1110.0000", "taxCode": "SYN-OUT-STD" }
      ]
    },
    {
      "typeCode": "SALES_CREDIT_NOTE",
      "effectiveDate": "2026-02-10",
      "party": "customer",
      "taxInclusive": true,
      "lines": [
        { "lineNo": 1, "accountCode": "4000", "amount": "-222.0000", "taxCode": "SYN-OUT-STD" }
      ]
    },
    {
      "typeCode": "PURCHASE_INVOICE",
      "effectiveDate": "2026-02-20",
      "party": "vendor",
      "taxInclusive": true,
      "lines": [
        { "lineNo": 1, "accountCode": "5900", "amount": "555.0000", "taxCode": "SYN-IN-STD" }
      ]
    },
    {
      "typeCode": "SALES_INVOICE",
      "effectiveDate": "2026-03-05",
      "party": "customer",
      "taxInclusive": true,
      "lines": [
        { "lineNo": 1, "accountCode": "4000", "amount": "300.0000", "taxCode": "SYN-OUT-ZERO" }
      ]
    },
    {
      "typeCode": "SALES_INVOICE",
      "effectiveDate": "2026-03-20",
      "party": "customer",
      "taxInclusive": true,
      "lines": [
        { "lineNo": 1, "accountCode": "4000", "amount": "150.0000", "taxCode": "SYN-EXEMPT" }
      ]
    }
  ]
}
```

**`taxInclusive: true` reaches the row through `document.tax_inclusive`** (migration 0054), which `postTaxedDocument` passes to `postFromPack` and `computeDocumentTax` reads through `resolveInclusive(policy, header.tax_inclusive)` — the four 4A policies declare `"inclusive": "header.tax_inclusive"` (T8 Step 6), so the header is what decides and the policy is the same file in both cases.

- [ ] **Step 5: Generate both `expected.json` files, then read them against this table**

```bash
UPDATE_GOLDEN=1 bun run --cwd tests test -- golden/tax
git diff --stat tests/golden/tax
```

Two new files. **Now read them.** These are the figures both must carry, and every one of them is derivable by hand from `SYNTH-MY-v1`'s five boxes and the two rates:

| Transaction | code | kind | rate | `base` | `tax` |
|---|---|---|---|---|---|
| sale 2026-01-15 | `SYN-OUT-STD` | output | `0.11000000` | `1000.0000` | `110.0000` |
| credit note 2026-02-10 | `SYN-OUT-STD` | output | `0.11000000` | `-200.0000` | `-22.0000` |
| purchase 2026-02-20 | `SYN-IN-STD` | input | `0.11000000` | `500.0000` | `55.0000` |
| zero-rated sale 2026-03-05 | `SYN-OUT-ZERO` | zero | `0.00000000` | `300.0000` | `0.0000` |
| exempt sale 2026-03-20 | `SYN-EXEMPT` | exempt | `0.00000000` | `150.0000` | `0.0000` |

| Box | rule (`SYNTH_MY_V1`) | arithmetic | amount |
|---|---|---|---|
| `S1` | `kinds ["output"]`, `measure base` | `1000 − 200` | **`800.0000`** |
| `S2` | `kinds ["output"]`, `measure tax` | `110 − 22` | **`88.0000`** |
| `S3` | `kinds ["zero","exempt"]`, `measure base` | `300 + 150` | **`450.0000`** |
| `P1` | `kinds ["input"]`, `measure base` | `500` | **`500.0000`** |
| `P2` | `kinds ["input"]`, `measure tax` | `55` | **`55.0000`** |

| Tie-out row | box codes | `boxBase` | `ledgerBase` | `difference` |
|---|---|---|---|---|
| `1350` (asset → `base_debit − base_credit`) | `["P2"]` | `55.0000` | `55.0000` | **`0.0000`** |
| `2300` (liability → `base_credit − base_debit`) | `["S2"]` | `88.0000` | `88.0000` | **`0.0000`** |

`taxReturnTieOut` returns `1350` **before** `2300` — its `wanted` array is written in that order (T8 Step 3) — so `expected.json`'s `tieOut` array is in that order too.

**The `payload` both files must carry, byte for byte.** `canonicalJson` sorts object keys lexicographically at every depth and preserves array order, so the top-level keys run `boxes, currency, jurisdiction, periodEnd, periodStart, regimeCode, regimeVersion` and each box runs `amount, code, label`; the box array stays in `SYNTH_MY_V1.boxes` order:

```
{"boxes":[{"amount":"800.0000","code":"S1","label":"Standard-rated supplies (value)"},{"amount":"88.0000","code":"S2","label":"Tax on standard-rated supplies"},{"amount":"450.0000","code":"S3","label":"Zero-rated and exempt supplies (value)"},{"amount":"500.0000","code":"P1","label":"Taxable purchases (value)"},{"amount":"55.0000","code":"P2","label":"Tax on taxable purchases"}],"currency":"MYR","jurisdiction":"MY","periodEnd":"2026-03-31","periodStart":"2026-01-01","regimeCode":"SYNTH-MY-v1","regimeVersion":1}
```

and its `payloadSha256` is therefore

```
df0b4de2ec7fc20f1f1fb045447792279cdbc12d2fa7ae7446d0034ee6cdc438
```

**Verify the sha independently before trusting the generated file** — the whole value of a golden fixture is that two people reach the same bytes by different routes:

```bash
printf '%s' "$(node -e 'const e=require("./tests/golden/tax/synth-my-quarter/expected.json");process.stdout.write(e.payload)')" | sha256sum
# df0b4de2ec7fc20f1f1fb045447792279cdbc12d2fa7ae7446d0034ee6cdc438  -
```

**If the generated sha differs, do not edit the sha.** Diff the generated `payload` against the block above; the byte that moved names the fault — a label typo in `SYNTH_MY_V1`, a box out of definition order, a `currency` that is not the company's `base_currency`, or a figure from the table above that came out wrong.

`synth-my-quarter/expected.json`, in full:

```json
{
  "boxes": [
    { "code": "S1", "label": "Standard-rated supplies (value)", "amount": "800.0000" },
    { "code": "S2", "label": "Tax on standard-rated supplies", "amount": "88.0000" },
    { "code": "S3", "label": "Zero-rated and exempt supplies (value)", "amount": "450.0000" },
    { "code": "P1", "label": "Taxable purchases (value)", "amount": "500.0000" },
    { "code": "P2", "label": "Tax on taxable purchases", "amount": "55.0000" }
  ],
  "payload": "{\"boxes\":[{\"amount\":\"800.0000\",\"code\":\"S1\",\"label\":\"Standard-rated supplies (value)\"},{\"amount\":\"88.0000\",\"code\":\"S2\",\"label\":\"Tax on standard-rated supplies\"},{\"amount\":\"450.0000\",\"code\":\"S3\",\"label\":\"Zero-rated and exempt supplies (value)\"},{\"amount\":\"500.0000\",\"code\":\"P1\",\"label\":\"Taxable purchases (value)\"},{\"amount\":\"55.0000\",\"code\":\"P2\",\"label\":\"Tax on taxable purchases\"}],\"currency\":\"MYR\",\"jurisdiction\":\"MY\",\"periodEnd\":\"2026-03-31\",\"periodStart\":\"2026-01-01\",\"regimeCode\":\"SYNTH-MY-v1\",\"regimeVersion\":1}",
  "payloadSha256": "df0b4de2ec7fc20f1f1fb045447792279cdbc12d2fa7ae7446d0034ee6cdc438",
  "tieOut": [
    { "accountCode": "1350", "boxCodes": ["P2"], "boxBase": "55.0000", "ledgerBase": "55.0000", "difference": "0.0000" },
    { "accountCode": "2300", "boxCodes": ["S2"], "boxBase": "88.0000", "ledgerBase": "88.0000", "difference": "0.0000" }
  ]
}
```

**`synth-my-inclusive/expected.json` is the identical file.** Not "similar to" — identical, byte for byte, and Step 6 asserts that as its own case. Two entry conventions, one computation.

- [ ] **Step 6: The three clauses of test 26, and the two refusals**

Appended to `tests/golden/tax.test.ts` as a second `describe`. **These are the assertions the byte-compare cannot make**: byte-identity across *runs*, the wrong-regime refusal, and the tie-out read as an equality rather than as a stored figure.

```ts
describe("test 26 clauses beyond the byte-compare", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); }, 180_000);
  afterAll(async () => { await db.stop(); });

  // ── Clause 1: "byte-identical across runs" ──────────────────────────────────────────────────────────
  it("regenerating the same period produces the identical sha, and a later period does not disturb it",
    async () => {
      const input = readCase("synth-my-quarter");
      const f = await taxFixture(db, "t26-determinism");
      for (const d of input.documents) {
        await postTaxedDocument(db, f, {
          typeCode: d.typeCode, effectiveDate: d.effectiveDate,
          partyId: d.party === "customer" ? f.customerId : f.vendorId,
          taxInclusive: d.taxInclusive,
          lines: d.lines.map((l) => ({ lineNo: l.lineNo, kind: "account" as const,
            accountId: f.accounts[l.accountCode]!, amount: l.amount, taxCode: l.taxCode })),
        });
      }
      const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "t26-det" };
      const first = await withTenant(db.rw, ctx, async (tx) => {
        const draft = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId,
          periodStart: "2026-01-01", periodEnd: "2026-03-31" });
        const { row } = await generateTaxReturn(tx, ctx, draft.id);
        return { id: draft.id, sha: row.payloadSha256!, by: row.generatedBy! };
      });
      expect(first.sha).toBe("df0b4de2ec7fc20f1f1fb045447792279cdbc12d2fa7ae7446d0034ee6cdc438");

      // Regenerate: same bytes, and `generated_by` keeps the FIRST generator (T8's NULL -> value rule).
      const second = await withTenant(db.rw, ctx, async (tx) => {
        const { row } = await generateTaxReturn(tx, ctx, first.id);
        return { sha: row.payloadSha256!, by: row.generatedBy! };
      });
      expect(second.sha).toBe(first.sha);
      expect(second.by).toBe(first.by);

      // A document in Q2 changes nothing about Q1. LEGACY-059's failure was the opposite: a truncated query
      // lost its period filter and the return reported every voucher ever posted.
      await postTaxedDocument(db, f, {
        typeCode: "SALES_INVOICE", effectiveDate: "2026-04-05", taxInclusive: false,
        lines: [{ lineNo: 1, accountId: f.accounts["4000"]!, amount: "9999.0000", taxCode: "SYN-OUT-STD" }],
      });
      const third = await withTenant(db.rw, ctx, (tx) => generateTaxReturn(tx, ctx, first.id));
      expect(third.row.payloadSha256).toBe(first.sha);
    }, 180_000);

  // ── Clause 2: "a tax code from the wrong regime causes a refusal, not a wrong number" ───────────────
  it("a document whose lines span two regimes is refused, and so is a return on a regime the pack lacks",
    async () => {
      const f = await taxFixture(db, "t26-wrong-regime");
      const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "t26-wrong" };

      // A SECOND regime. `seedTaxCode` REUSES SYNTH-MY-v1 when no `regimeId` is passed (T1 Step 5), so the
      // regime row is inserted here and handed to the helper — one helper, no second spelling (hazard 9).
      const [other] = await withTenant(db.rw, ctx, (tx) => tx<{ id: string }[]>`
        insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                    name_en, source)
        values (${f.s.tenant}, ${f.s.company}, 'OTHER-MY-v1', 'MY', 1, '2026-01-01',
                'Second synthetic regime', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
        returning id`);
      const foreign = await seedTaxCode(db, f.s, {
        code: "OTHER-OUT", rate: "0.07000000", kind: "output", regimeId: other!.id });
      // `seedTaxCode` resolves `2300` for an `output` code by itself (T1 Step 5), and `taxFixture` seeded
      // that account — so no account fix-up is needed here, and adding one would make this pass for the
      // wrong reason: the refusal below must come from the REGIME, never from a null account.
      const f2: TaxFixture = { ...f, codes: { ...f.codes, "OTHER-OUT": foreign.taxCodeId } };

      // ── Clause 2 proper: a tax code from the wrong regime, on a real document. `resolveRegimeFor`
      // refuses a document whose lines span two regimes (T7), reaching the caller through
      // `computeDocumentTax` — "a refusal, not a wrong number" (spec:2444). If this document posted, its
      // two codes' figures would land in one return with two rates and nothing to say which was which,
      // which is LEGACY-020's enum collision in its modern form.
      await expect(postTaxedDocument(db, f2, {
        typeCode: "SALES_INVOICE", effectiveDate: "2026-01-20", taxInclusive: false,
        lines: [
          { lineNo: 1, accountId: f.accounts["4000"]!, amount: "400.0000", taxCode: "SYN-OUT-STD" },
          { lineNo: 2, accountId: f.accounts["4000"]!, amount: "400.0000", taxCode: "OTHER-OUT" },
        ],
      })).rejects.toMatchObject({ code: "ERR_TAX_REGIME_MISMATCH" });

      // And nothing was written: the refusal happens inside the caller's transaction, before any post.
      const written = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.tax_transaction where company_id = ${f.s.company}`);
      expect(written[0]!.n).toBe(0);

      // ── The other half of one code: a return whose OWN regime the pack has no definition for. A regime
      // the pack does not know IS a mismatch (amendment A3) — never an empty return, which would file.
      const unknown = await withTenant(db.rw, ctx, async (tx) => {
        const draft = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: other!.id,
          periodStart: "2026-01-01", periodEnd: "2026-03-31" });
        return draft.id;
      });
      await expect(withTenant(db.rw, ctx, (tx) => generateTaxReturn(tx, ctx, unknown)))
        .rejects.toMatchObject({ code: "ERR_TAX_REGIME_MISMATCH" });
      await expect(withTenant(db.rw, ctx, (tx) => generateTaxReturn(tx, ctx, unknown)))
        .rejects.toThrow(/this pack has no definition for OTHER-MY-v1 v1/);

      // Each of the two codes posts fine on its OWN document — the refusal is about MIXING, not about the
      // second regime existing. Without this the test would pass on any breakage of `OTHER-OUT`.
      await postTaxedDocument(db, f2, {
        typeCode: "SALES_INVOICE", effectiveDate: "2026-01-21", taxInclusive: false,
        lines: [{ lineNo: 1, accountId: f.accounts["4000"]!, amount: "400.0000", taxCode: "OTHER-OUT" }],
      });
      const after = await withTenant(db.rw, ctx, (tx) => tx<{ tax: string }[]>`
        select tax::text from app.tax_transaction where company_id = ${f.s.company}`);
      expect(after.map((r) => r.tax)).toEqual(["28.0000"]);      // 400.0000 x 0.07
    }, 180_000);

  it("the pack refuses a transaction whose regime is not the return's, naming the document and line", () => {
    // Pure, and it is the second half of clause 2: the guard that stops a foreign row being silently
    // dropped (LEGACY-058's contradictory union half, in reverse). No database needed.
    const regime = { id: "11111111-1111-7111-8111-111111111111", code: "SYNTH-MY-v1",
                     jurisdiction: "MY" as const, version: 1,
                     effectiveFrom: "2026-01-01", effectiveTo: null };
    const ccy = currency("MYR");
    const foreign = {
      documentId: "22222222-2222-7222-8222-222222222222", documentTypeCode: "SALES_INVOICE", lineNo: 1,
      taxCodeId: "33333333-3333-7333-8333-333333333333", taxCode: "OTHER-OUT",
      regimeId: "44444444-4444-7444-8444-444444444444", kind: "output" as const, rate: "0.07000000",
      base: Money.of("100.0000", ccy), tax: Money.of("7.0000", ccy),
      baseBase: Money.of("100.0000", ccy), taxBase: Money.of("7.0000", ccy),
      effectiveDate: "2026-01-20", postingSeq: "1",
    };
    expect(() => malaysiaPack.buildReturn({ regime, periodStart: "2026-01-01", periodEnd: "2026-03-31",
                                            transactions: [foreign] }))
      .toThrow(/document 22222222-2222-7222-8222-222222222222 line 1 carries regime 44444444/);
  });

  // ── Clause 3: "validated" and "reconciled" — the DoD's other two verbs ──────────────────────────────
  it("the generated payload re-validates against the pack and both control accounts tie out", async () => {
    const input = readCase("synth-my-inclusive");
    const f = await taxFixture(db, "t26-tieout");
    for (const d of input.documents) {
      await postTaxedDocument(db, f, {
        typeCode: d.typeCode, effectiveDate: d.effectiveDate,
        partyId: d.party === "customer" ? f.customerId : f.vendorId,
        taxInclusive: d.taxInclusive,
        lines: d.lines.map((l) => ({ lineNo: l.lineNo, kind: "account" as const,
          accountId: f.accounts[l.accountCode]!, amount: l.amount, taxCode: l.taxCode })),
      });
    }
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "t26-tie" };
    const { boxes, tie, payload } = await withTenant(db.rw, ctx, async (tx) => {
      const draft = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId,
        periodStart: "2026-01-01", periodEnd: "2026-03-31" });
      const g = await generateTaxReturn(tx, ctx, draft.id);
      return { boxes: g.boxes, payload: g.row.payload!, tie: await taxReturnTieOut(tx, draft.id) };
    });

    expect(malaysiaPack.validateReturn(payload)).toEqual({ ok: true, errors: [] });
    expect(payload).toBe(canonicalJson(JSON.parse(payload)));      // the payload IS canonical, not merely valid
    expect(boxes.map((b) => [b.code, b.amount.toString()])).toEqual([
      ["S1", "800.0000"], ["S2", "88.0000"], ["S3", "450.0000"], ["P1", "500.0000"], ["P2", "55.0000"],
    ]);
    // Every box the definition declares is present, in definition order — a box the pack knows and the
    // return omits is LEGACY-011's "filed with tax but no base" in its other direction.
    expect(boxes.map((b) => b.code)).toEqual(SYNTH_MY_V1.boxes.map((b) => b.code));
    expect(tie).toEqual([
      { accountCode: "1350", boxCodes: ["P2"], boxBase: "55.0000", ledgerBase: "55.0000", difference: "0.0000" },
      { accountCode: "2300", boxCodes: ["S2"], boxBase: "88.0000", ledgerBase: "88.0000", difference: "0.0000" },
    ]);
  }, 180_000);

  it("an empty period generates a return of zero boxes and ties out to 0.0000, never to null", async () => {
    // LEGACY-011 at this boundary: `taxReturnTieOut`'s `coalesce(..., 0)` is what makes the assertion real
    // rather than vacuous. A null difference compares equal to nothing and passes no test.
    const f = await taxFixture(db, "t26-empty");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "t26-empty" };
    const { boxes, tie } = await withTenant(db.rw, ctx, async (tx) => {
      const draft = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId,
        periodStart: "2026-01-01", periodEnd: "2026-03-31" });
      const g = await generateTaxReturn(tx, ctx, draft.id);
      return { boxes: g.boxes, tie: await taxReturnTieOut(tx, draft.id) };
    });
    expect(boxes.map((b) => b.amount.toString())).toEqual(
      ["0.0000", "0.0000", "0.0000", "0.0000", "0.0000"]);
    expect(tie.map((r) => r.difference)).toEqual(["0.0000", "0.0000"]);
    expect(tie.every((r) => r.ledgerBase === "0.0000")).toBe(true);
  }, 180_000);

  it("a draft return has no boxes and refuses a tie-out", async () => {
    const f = await taxFixture(db, "t26-draft");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "t26-draft" };
    await withTenant(db.rw, ctx, async (tx) => {
      const draft = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId,
        periodStart: "2026-01-01", periodEnd: "2026-03-31" });
      expect((await getTaxReturn(tx, draft.id)).boxes).toEqual([]);
      await expect(taxReturnTieOut(tx, draft.id)).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
    });
  }, 180_000);
});
```

⚠️ **Why the wrong-regime case inserts its own regime row instead of calling `seedTaxCode` twice.** T1 Step 5's helper **reuses** `SYNTH-MY-v1` when `regimeId` is omitted — that is deliberate, so a test wanting two codes in one regime writes two plain calls — which means it cannot produce a *second* regime on its own. The case therefore inserts one `tax_regime` row and passes its id, and everything else goes through the helper. **Do not add a `seedTaxRegime` beside it** (hazard 9): one row, one insert, in the one test that needs a second regime at all.

- [ ] **Step 7: Run everything to pass, and commit**

```bash
bun run --cwd tests test -- golden/tax \
  && bun run --cwd packages/db test -- tax \
  && bun run --cwd tests test -- invariants/tenant-isolation \
  && bun run typecheck && bun run lint:rules
```

All of `golden/tax.test.ts` green. **Then re-read both `expected.json` files one last time against Step 5's tables** — a golden fixture is only worth what the reviewer checked, and the sha above is the one figure a reader cannot derive in their head.

```bash
git add tests/golden/tax.test.ts tests/golden/tax/
git commit -m "$(cat <<'EOF'
test(golden): pin the tax return with two fixtures and close acceptance test 26 [5A T9]

Two cases -- the same quarter entered tax-exclusive and tax-inclusive -- produce the
byte-identical payload and sha, which says the two entry conventions are one computation
rather than two that happen to agree. The DoD's three verbs are three assertions:
generated (the sha is stable across regenerations and across a later period's document),
validated (validateReturn re-reads the payload and the payload IS canonical), reconciled
(2300 and 1350 tie to account_balance at 0.0000, and an empty period ties to 0.0000 and
not to null -- LEGACY-011 at this boundary). The credit note carries negated magnitudes per
4A's rule, so its tax is -22.0000 and the output box falls to 88.0000.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: ⚠️ OD-15 — the verified return format, ADR 0049, and the provenance guard

**Owner decision OD-15 (§2.12): "LHDN MyInvois credentials and the current requirement set" — spec:92, 982, 2226, 2405, 2467; Part VII #3. §2.12's default: *abstract interface only*.** §2.6's card scopes 5A's half precisely: *"'current requirement set' for the **return** format is verified from the authority's own documentation before the return task (isolated task 'fetch current LHDN publication, record in ADR 0049')"*. The credentials, the submission API and every MyInvois field are **5B's** half, behind ADR 0051.

**This task is isolated and nothing else in this plan is gated on it.** Tasks 1–9 ship a complete, testable jurisdiction pack whose every literal is invented and says so; Task 10 adds a second `RegimeDefinition` beside the first and changes no signature, no table, no route and no test. **Dropping this task drops one regime definition and one pair of seed files. It drops no interface.**

**Hazard 2, stated once so nobody has to infer it.** *"No LHDN endpoint, field name, schema version, threshold or deadline appears in any plan until the authority's current specification has been fetched and recorded."* That binds this task's own text: everything below says **"the format the authority currently publishes"** and never names a form, a box, a rate, a threshold, a deadline or a submission channel. **A reviewer who finds a Malaysian tax figure anywhere in this plan — including in this task — has found the defect this hazard exists to catch.**

**Owner provides** (hazard 5's pattern):

> The authority's **currently published** return specification for the regime this company files under — the publication itself or a stable citation to it (title, issuing body, publication date, version) — and the accountant's written confirmation that it is the version in force for the periods Dulja will file. Nothing is transcribed from memory, from this document, from a training corpus or from a third-party summary (spec:2467: *"do not rely on this document or on training data"*).
>
> **Verify:**
> ```bash
> test -s docs/adr/0049-verified-lhdn-return-format.md \
>   && grep -q '^Status: accepted' docs/adr/0049-verified-lhdn-return-format.md \
>   && ls -1 packages/db/seed/my/tax/ | grep -v '^SYNTH-MY-v1' | grep -c '\.regime\.json$'
> ```
> prints a count of **at least 1** and exits 0.
>
> **Until provided:** Steps 4–6 do not run. ADR 0049 stays `proposed` and carries **no figure**; `docs/decisions/od-15-5a-return-format.md` records the default in force; the shipped regime stays `SYNTH-MY-v1`; and **Steps 1–3 run anyway** — the decision record, the ADR skeleton and the provenance guard are what make the eventual arrival safe, and the guard is a live tripwire whether or not the material ever lands.

**Files:**
- Create: `docs/adr/0049-verified-lhdn-return-format.md`, `docs/decisions/od-15-5a-return-format.md`
- Modify: `packages/db/test/seed/tax-pack.test.ts` (T6's file — one appended `describe`), `packages/db/seed/my/tax/README.md` (T6's file — the "what OD-15 replaces" paragraph gains the command)
- ⚠️ Steps 4–6 only: `packages/domain/src/tax/malaysia.ts` (one entry appended to `MALAYSIA_REGIMES`), `packages/db/seed/my/tax/<REGIME>.regime.json`, `packages/db/seed/my/tax/<REGIME>.codes.json`, `packages/domain/test/tax/malaysia.test.ts` (one appended case)

**Interfaces**

- Consumes: `MALAYSIA_REGIMES`, `SYNTH_MY_V1`, `RegimeDefinition`, `malaysiaPack` (T6); `taxFileNames`, `TaxRegimeManifest`, `TaxCodeManifest`, `taxLoader` (T6); `readPackFile`, `assertPackShape`, `SeedError` (§4.2.13); `REPO_ROOT`, `repoFile` (0B's test helpers, §4.2.12); `startDb`, `Db`, `seedTenantV2`, `seedAccount` (§4.1, 1A).
- Produces: **no TypeScript interface at all.** Two documents, one appended `describe`, and — behind the gate — one `RegimeDefinition` entry and one pair of seed files whose names follow `taxFileNames`. **`JurisdictionPack`, `RegimeDefinition`, `ReturnBoxDef` and `malaysiaPack` are unchanged**: that is the whole point of A3's definitions-keyed-by-`(code, version)` design, and it is why this task is droppable.

- [ ] **Step 1: Write the decision record**

`docs/decisions/od-15-5a-return-format.md`. The 4B `od-09` precedent: a record of what was assumed, where each assumption lives, and what changes if the answer differs. **No figures, and no MyInvois detail.**

```markdown
# OD-15 (5A half) — the verified return format

**Status:** outstanding as of the date this file was created. Owner: the project owner (§2.12, spec:2405).
**Scope of this record:** the *return* format only. Credentials, the submission API and every MyInvois
transport detail are OD-15's second half and belong to slice 5B under ADR 0051.

## What was asked

The authority's currently published return specification for the regime this company files under — the
publication or a stable citation to it (title, issuing body, publication date, version) — plus the
accountant's written confirmation that it is the version in force for the periods Dulja will file.

## What was assumed instead, and where the assumption lives

The default of contracts §2.12 — **abstract interface only** — realised as a complete but deliberately
synthetic regime:

| Assumption | File | What it is |
|---|---|---|
| One regime definition, `SYNTH-MY-v1`, five boxes with generic labels | `packages/domain/src/tax/malaysia.ts` | `SYNTH_MY_V1`, the only member of `MALAYSIA_REGIMES` |
| Four tax codes, two invented rates | `packages/db/seed/my/tax/SYNTH-MY-v1.codes.json` | every row carries `"source": "SYNTHETIC-TEST-v1 — not a published figure (OD-15)"` |
| Provenance is a column, not a comment | `app.tax_regime.source` (migration 0053, amendment A2) | `not null`; the loader writes the manifest's `source` verbatim |
| The golden fixture files that synthetic regime | `tests/golden/tax/` | acceptance test 26 is green on invented figures |

## What changes when the answer arrives

**Nothing structural.** A second `RegimeDefinition` joins `MALAYSIA_REGIMES`; a second `.regime.json` /
`.codes.json` pair joins `packages/db/seed/my/tax/`; ADR 0049 records the publication and moves to
`accepted`. `buildReturn` matches a tenant's regime row to a definition by `(code, version)`, so a tenant
on the verified regime simply matches the other entry. **Nothing is replaced** — a tenant already on
`SYNTH-MY-v1` keeps its filed returns readable, and a filed return is never regenerated (T8).

## What does NOT change, ever

No rate, box label, form name, threshold, deadline, endpoint, schema version or field name is written into
`packages/domain/src/tax/**` or `packages/db/src/tax/**`. Rates and box layouts are **data** — a seed file
and a `RegimeDefinition` — and a change to either is a reviewed seed PR, never a release (ADR 0050). That
is LEGACY-020's fix, and it is the reason this record exists at all: the legacy system's GST return carried
its rate as a literal inside a stored procedure, so the rate could not be reviewed, dated or reverted.
```

- [ ] **Step 2: Write ADR 0049 as a proposal, empty of figures**

`docs/adr/0049-verified-lhdn-return-format.md`. **It is created now and stays `proposed`** — an ADR that exists and is empty is a record that the question was asked; an ADR written after the fact is not. spec:95 requires anything touching money semantics to be proposed and asked before implementing, and a return format is money semantics.

```markdown
# ADR 0049 — The verified return format

Status: proposed
Date: (the date this file is created)
Deciders: the project owner, the accountant, the architect
Supersedes: none
Related: ADR 0050 (one tax computation at persist time), ADR 0051 (5B, the verified MyInvois requirement
set), contracts §2.12 OD-15, contracts hazards 1 and 2, spec:2226, spec:2405, spec:2467

## Context

Slice 5A ships a pluggable jurisdiction pack (contracts §4.9.1) whose regime definitions carry their own
box layouts as data. It ships exactly one definition, `SYNTH-MY-v1`, every literal of which is invented
and marked as such in `app.tax_regime.source`. That is deliberate: contracts hazard 1 forbids a published
statutory figure anywhere in this repository, and hazard 2 forbids any detail of the authority's own
publication until that publication has been read.

Part VII #3 and spec:2467 are explicit that the current requirement set is fetched from the authority and
never reconstructed from this specification or from a model's training data. LEGACY-020 is the defect this
guards against in its concrete form: the legacy system's GST return multiplied by a rate literal inside a
stored procedure, with no regime discriminator, no effective date and no provenance — so nobody could say
which rate had been applied to which period, or revert one.

## Decision

**Proposed, pending OD-15.** When the owner provides the authority's currently published return
specification:

1. Its citation — title, issuing body, publication date, version — is recorded in the "Publication" section
   below, and **only there**. No figure from it is repeated in this ADR's prose.
2. Its box layout becomes a second `RegimeDefinition` in `packages/domain/src/tax/malaysia.ts`, appended to
   `MALAYSIA_REGIMES`. `SYNTH_MY_V1` is not removed.
3. Its codes and rates become `packages/db/seed/my/tax/<REGIME>.regime.json` and `<REGIME>.codes.json`,
   named by `taxFileNames`, each carrying the citation string in `source`.
4. This ADR moves to `accepted` in the same PR as those files, and the provenance guard
   (`packages/db/test/seed/tax-pack.test.ts`) is what makes that ordering mechanical rather than a habit.

**Until then this ADR carries no rate, no box code, no box label, no form name, no threshold and no
deadline.** An implementer who needs one has hit the gate, not a gap.

## Publication

(empty until OD-15 lands: title, issuing body, publication date, version, and the accountant's written
confirmation that it is in force for the periods Dulja will file)

## Consequences

- **Slice 5A is not blocked.** Every task except this one runs on `SYNTH-MY-v1`, and acceptance test 26 is
  green on it — determinism, validation and the tie-out are properties of the engine and the pack, not of
  any particular rate.
- **Adding the verified regime changes no interface.** `JurisdictionPack.regimes` holds definitions keyed
  `(code, version)` (contracts amendment A3), so a second entry is additive by construction.
- **A tenant already filing under `SYNTH-MY-v1` keeps its filed returns readable**, because nothing is
  replaced and a filed return is never regenerated.
- **The cost of being wrong is bounded to a seed PR.** A misread rate is one reviewed JSON diff with a
  `source` line naming where it came from — not a release, and not a stored procedure.
```

- [ ] **Step 3: Write the provenance guard, and run it**

Appended to `packages/db/test/seed/tax-pack.test.ts` (T6's file). **This is the part of Task 10 that runs whether or not the owner answers**, and it is what makes the eventual arrival safe: it fails the build if a regime definition ever ships without a seed pair, or if a non-synthetic regime ever ships without an accepted ADR 0049.

```ts
// ── OD-15 provenance guard (Task 10). Runs on every build, answered or not. ───────────────────────────
describe("OD-15 — every shipped regime is either synthetic or backed by an accepted ADR 0049", () => {
  const TAX_DIR = repoFile("packages/db/seed/my/tax");
  const ADR = repoFile("docs/adr/0049-verified-lhdn-return-format.md");

  it("every RegimeDefinition in MALAYSIA_REGIMES has a matching seed pair, named by taxFileNames", () => {
    // A definition with no seed files is a regime no tenant can be put on; a seed pair with no definition
    // is a regime `buildReturn` refuses with ERR_TAX_REGIME_MISMATCH. Both are caught here, at build time,
    // rather than at a filing deadline.
    const present = readdirSync(TAX_DIR);
    for (const d of MALAYSIA_REGIMES) {
      const names = taxFileNames(d.code);
      expect(present, `${d.code} v${d.version} has no ${names.regime}`).toContain(names.regime);
      expect(present, `${d.code} v${d.version} has no ${names.codes}`).toContain(names.codes);
    }
    const declared = new Set(MALAYSIA_REGIMES.flatMap((d) => {
      const n = taxFileNames(d.code); return [n.regime, n.codes];
    }));
    for (const file of present.filter((f) => f.endsWith(".json"))) {
      expect(declared, `${file} has no RegimeDefinition in MALAYSIA_REGIMES`).toContain(file);
    }
  });

  it("a regime whose source is not synthetic requires ADR 0049 to be accepted", () => {
    // The ONE mechanical link between "a real figure entered the repository" and "the ADR that records
    // where it came from was accepted first". Contracts hazards 1 and 2, spec:2467, and the reason this
    // guard is written before the answer arrives rather than after.
    const adr = existsSync(ADR) ? readFileSync(ADR, "utf8") : "";
    const accepted = /^Status: accepted$/m.test(adr);
    for (const d of MALAYSIA_REGIMES) {
      const manifest = readPackFile<TaxRegimeManifest>(
        repoFile("packages/db/seed/my"), "tax", taxFileNames(d.code).regime);
      const synthetic = manifest.source.startsWith("SYNTHETIC");
      expect(synthetic || accepted,
        `${d.code} v${d.version} declares source ${JSON.stringify(manifest.source)}, which is not ` +
        `synthetic, and docs/adr/0049-verified-lhdn-return-format.md is not accepted — ` +
        `a published figure may not enter this repository before the ADR that cites it (hazard 2)`)
        .toBe(true);
    }
  });

  it("no Malaysian tax figure is hard-coded in the tax engine or the tax services", () => {
    // The mechanical half of hazard 1 for this slice's own source. A rate lives in `app.tax_code`, seeded
    // from a reviewed file; a decimal literal that looks like a rate in either directory is LEGACY-020.
    const suspects = sourceFiles(["packages/domain/src/tax", "packages/db/src/tax"])
      .flatMap((f) => f.lines.flatMap((line, i) =>
        /(^|[^\w.])0\.[0-9]{1,8}\b/.test(line) && !line.trimStart().startsWith("*")
          ? [`${f.path}:${i + 1} ${line.trim()}`] : []));
    expect(suspects, "a decimal literal that could be a tax rate").toEqual([]);
  });
});
```

The file's imports gain `readdirSync`, `existsSync`, `readFileSync` from `node:fs`, and `MALAYSIA_REGIMES` from `@dulja/domain`; `repoFile` and `sourceFiles` come from 0B's test helpers (§4.2.12).

```bash
bun run --cwd packages/db test -- seed/tax-pack
```

All three cases green with only `SYNTH-MY-v1` shipped: one definition, one pair of files, a synthetic `source`, and no decimal literal in either tax directory.

```bash
git add docs/adr/0049-verified-lhdn-return-format.md docs/decisions/od-15-5a-return-format.md \
        packages/db/test/seed/tax-pack.test.ts packages/db/seed/my/tax/README.md
git commit -m "$(cat <<'EOF'
docs(adr): record OD-15's return-format gate and guard the pack's provenance [5A T10]

ADR 0049 exists and is `proposed`, carrying no rate, box, form, threshold or deadline --
an ADR written after the fact is not a record that the question was asked. The guard is
the mechanical half: a regime definition with no seed pair fails the build, a seed file
with no definition fails the build, and a regime whose `source` is not synthetic fails
the build until ADR 0049 is accepted. Steps 4-6 stay unrun until the owner answers.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

- [ ] ⚠️ **Step 4: Only when the owner's material has arrived — record the publication and accept ADR 0049**

Fill the ADR's **Publication** section with the citation exactly as the publication states it, move `Status:` to `accepted`, and add the accountant's confirmation as an attachment reference. **Read the publication; do not summarise it from anything else.** The gate command at the top of this task is what the reviewer runs.

- [ ] ⚠️ **Step 5: Add the verified regime definition and its seed pair**

`packages/domain/src/tax/malaysia.ts` — **append**, never replace:

```ts
/** Added by Task 10 under an accepted ADR 0049. Its code, version and box list come from the publication
 *  that ADR cites and from nowhere else. `SYNTH_MY_V1` stays: a tenant already on it keeps its filed
 *  returns readable, and `buildReturn` matches by (code, version). */
export const MY_VERIFIED_V1: RegimeDefinition = { /* per ADR 0049 */ };

export const MALAYSIA_REGIMES: readonly RegimeDefinition[] = [SYNTH_MY_V1, MY_VERIFIED_V1];
```

and the pair `packages/db/seed/my/tax/<REGIME>.regime.json` / `<REGIME>.codes.json`, named by `taxFileNames(code)`, in the exact shapes T6's `TaxRegimeManifest` and `TaxCodeManifest` declare, with `source` set to the ADR's citation string. **`tax-pack.schema.json` validates them at seed time** — a rate that is not eight decimal places, or an `accountCode` outside `^[1-5][0-9]{3}$`, fails there rather than becoming a wrong return.

`/* per ADR 0049 */` is the only placeholder in this plan and it is a deliberate one: **hazard 2 forbids writing that literal here.** Steps 4–6 do not run until the ADR exists to be copied from, and an implementer reading this task before then must find nothing to copy.

- [ ] ⚠️ **Step 6: Prove the second regime through the same tests, and commit**

Append to `packages/domain/test/tax/malaysia.test.ts` one case asserting `malaysiaPack.regimes` has two entries, that `buildReturn` over a `TaxRegime` row matching the second definition produces that definition's boxes, and that a row matching neither still raises `ERR_TAX_REGIME_MISMATCH`. Then:

```bash
bun run --cwd packages/db test -- seed/tax-pack \
  && bun run --cwd packages/domain test -- tax/malaysia \
  && bun run --cwd tests test -- golden/tax
```

The golden fixtures are **unchanged** — they file under `SYNTH-MY-v1` and a second definition does not touch them. If `golden/tax` moves when a regime is *added*, `buildReturn` is matching by something other than `(code, version)` and that is the finding.

```bash
git add packages/domain/src/tax/malaysia.ts packages/db/seed/my/tax/ \
        packages/domain/test/tax/malaysia.test.ts docs/adr/0049-verified-lhdn-return-format.md
git commit -m "$(cat <<'EOF'
feat(domain): add the verified regime definition under ADR 0049 [5A T10]

Appended, never replaced: SYNTH-MY-v1 stays so a tenant already on it keeps its filed
returns readable, and buildReturn matches by (code, version). Every figure comes from the
publication ADR 0049 cites and from nowhere else; the seed files carry that citation in
`source`, which the provenance guard is what checks.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The five regression files, the pinned lists, and this slice's re-run matrix

**No migration, no production code.** The task that closes the Part I defects §2.6 assigns this slice and re-runs the acceptance tests the card lists as re-runs. **If any step here needs a production edit, the edit belongs in the task that shipped the thing** — this task only asserts.

**§3.7.3's ownership rule, applied.** This slice is the **first in execution order** to touch LEGACY-020, 058 and 059, so it **creates** those three files with `describe("LEGACY-NNN <Part I heading> — 5A", …)`. LEGACY-011 and LEGACY-019 are 0B's thin files (both are on the Plan 0A-proven list), so this slice **appends** a `— 5A` block to each and **never edits an earlier block**. No suffixed file name (`legacy-020-tax.test.ts`) is created; that is forbidden outright.

**The five defects, in one sentence each, because a regression file whose author did not read the defect asserts the wrong thing.**

| Defect | Part I | The failure, verbatim in substance | This slice's block |
|---|---|---|---|
| **LEGACY-011** · C | spec:311 | `procCalculateVATReturn` accumulates without `coalesce`, so one NULL line total nulls `Output_Total` for the whole period while `Output_Tax` still reports a figure — **"a return is filed with tax but no base"**. | every monetary column of `tax_transaction` is `not null`; an untaxed line is written `0.0000` and never left stale; an empty period ties out to `0.0000` and not to null. |
| **LEGACY-019** · H | spec:381 | Ten rounding columns configured across `Currencies` and `TaxCodes` with **zero references**; `RoundTo.sql` is never called and is wrong — asymmetric across sign (`+6 → 10`, `−6 → −5`), NULL-propagating, integer-overflowing. | the mode is declared per code **and applied**: two codes differing only in `rounding_mode` give different tax over one base; `+X` and `−X` give exactly opposite tax; there is no second rounding function in either tax directory. |
| **LEGACY-020** · H | spec:388 | `procCalculateGSTReturn` multiplies by a `0.06` literal, uses an ambiguous date literal, and shares an enum whose meaning differs by context. | the rate is a `tax_code` row and changing the seed changes the return with no code change; every code declares its regime and an out-of-window code refuses; `kind` is `text` + a named CHECK owned by this table and by nothing else. |
| **LEGACY-058** · M | spec:708 | The two halves of `procGetTaxItems`' union filter differently, so an **uncoded manual journal is invisible to the reconciliation and excluded from the return**. | one selection path for both directions: an uncoded line on a sale, on a purchase and on a JOURNAL each produce zero `tax_transaction` rows, and all three documents still post with their ledger entries intact. |
| **LEGACY-059** · H | spec:713 | A `varchar(1000)` query buffer overflows; a truncation at a clause boundary yields **"a valid query with the period filter missing"** and the return silently reports every voucher ever posted. | both period bounds are bound parameters of a tagged template — losing one is not expressible; a Q2 document does not move a Q1 return; an out-of-window row is a refusal, not a silently dropped row. |

**Files:**
- Create: `tests/regression/legacy-020.test.ts`, `tests/regression/legacy-058.test.ts`, `tests/regression/legacy-059.test.ts`
- Modify: `tests/regression/legacy-011.test.ts`, `tests/regression/legacy-019.test.ts` (append one `describe` each)
- Create: `tests/invariants/phase-5a-pinned.test.ts`

**Interfaces**

- Consumes: `startDb`, `Db`, `Seed`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE` (§4.1); the production `withTenant` (§4.2.2 — hazard 15: root `tests/` use the production one); `taxFixture`, `postTaxedDocument`, `seedTaxPack` (T7); `taxEngine`, `TaxError`, `malaysiaPack`, `producesNoTax`, `Money`, `currency`, `round` (T5, §4.2.1); `createTaxReturn`, `generateTaxReturn`, `taxReturnTieOut` (T8); `computeDocumentTax` (T7); `PERMISSIONS`, `PERMISSION` (§4.2.5); `ROLES` (0D); `sourceFiles`, `repoFile`, `REPO_ROOT` (§4.2.12); `seedTenantV2`, `seedAccount` (1A); `grantCodes` (2B).
- Produces: **nothing.** Five regression blocks and one pinned-list file. `tests/invariants/phase-5a-pinned.test.ts` exports no symbol — it is a set of equalities.

- [ ] **Step 1: Create `tests/regression/legacy-020.test.ts`**

```ts
// tests/regression/legacy-020.test.ts
// LEGACY-020 (H) — The GST return hardcodes a rate, uses an ambiguous date literal, and shares an enum with
// an incompatible meaning (spec:388). Created by slice 5A, the first slice in execution order to touch it.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { createTaxReturn, generateTaxReturn } from "@dulja/db";
import { startDb, type Db } from "@dulja/db/test";
import { sourceFiles } from "@dulja/db/test";
import { postTaxedDocument, taxFixture } from "../invariants/support/tax";

describe("LEGACY-020 The GST return hardcodes a rate, uses an ambiguous date literal, and shares an enum — 5A",
  () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("the rate is a row, not a literal: changing the seeded rate changes the return with no code change",
    async () => {
      const f = await taxFixture(db, "legacy020-rate");
      const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "legacy020" };
      await postTaxedDocument(db, f, {
        typeCode: "SALES_INVOICE", effectiveDate: "2026-01-10", taxInclusive: false,
        lines: [{ lineNo: 1, accountId: f.accounts["4000"]!, amount: "1000.0000", taxCode: "SYN-OUT-STD" }],
      });
      const before = await withTenant(db.rw, ctx, async (tx) => {
        const d = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId,
          periodStart: "2026-01-01", periodEnd: "2026-01-31" });
        return (await generateTaxReturn(tx, ctx, d.id)).boxes.find((b) => b.code === "S2")!.amount.toString();
      });
      expect(before).toBe("110.0000");

      // A SECOND code at a different rate, effective later — the version-by-effective-date shape the legacy
      // system had no way to express, which is why its rate lived in a procedure.
      await withTenant(db.rw, ctx, async (tx) => {
        await tx`
          insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, rate, kind,
                                    rounding_mode, output_account_id, effective_from)
          values (${f.s.tenant}, ${f.s.company}, ${f.regimeId}, 'SYN-OUT-STD-2', 'Second rate (synthetic)',
                  '0.20000000', 'output', 'HALF_AWAY_FROM_ZERO', ${f.accounts["2300"]!}, '2026-02-01')`;
      });
      const f2 = { ...f, codes: { ...f.codes } };
      const [second] = await withTenant(db.rw, ctx, (tx) => tx<{ id: string }[]>`
        select id from app.tax_code where company_id = ${f.s.company} and code = 'SYN-OUT-STD-2'`);
      f2.codes["SYN-OUT-STD-2"] = second!.id;
      await postTaxedDocument(db, f2, {
        typeCode: "SALES_INVOICE", effectiveDate: "2026-02-10", taxInclusive: false,
        lines: [{ lineNo: 1, accountId: f.accounts["4000"]!, amount: "1000.0000", taxCode: "SYN-OUT-STD-2" }],
      });
      const after = await withTenant(db.rw, ctx, async (tx) => {
        const d = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId,
          periodStart: "2026-02-01", periodEnd: "2026-02-28" });
        return (await generateTaxReturn(tx, ctx, d.id)).boxes.find((b) => b.code === "S2")!.amount.toString();
      });
      expect(after).toBe("200.0000");
      // And January is unmoved — the old rate still applies to the old period, which is the whole point of
      // an effective-dated rate table and the thing a procedure literal cannot do.
      const january = await withTenant(db.rw, ctx, async (tx) => {
        const d = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId,
          periodStart: "2026-03-01", periodEnd: "2026-03-31" });
        await generateTaxReturn(tx, ctx, d.id);
        const rows = await tx<{ tax: string }[]>`
          select tax::text from app.tax_transaction
           where company_id = ${f.s.company} and effective_date = '2026-01-10'`;
        return rows[0]!.tax;
      });
      expect(january).toBe("110.0000");
    }, 180_000);

  it("no decimal literal that could be a rate exists in the tax engine or the tax services", () => {
    // The mechanical statement of the defect's first clause. Task 10's provenance guard makes the same
    // assertion over the same directories from `packages/db`'s own suite; both are cheap, and this is the
    // one a reader looking up LEGACY-020 will find.
    const hits = sourceFiles(["packages/domain/src/tax", "packages/db/src/tax"])
      .flatMap((f) => f.lines.flatMap((line, i) =>
        /(^|[^\w.])0\.[0-9]{1,8}\b/.test(line) && !line.trimStart().startsWith("*")
          ? [`${f.path}:${i + 1}`] : []));
    expect(hits).toEqual([]);
  });

  it("every tax code declares its regime, and a code outside its effective window refuses", async () => {
    const f = await taxFixture(db, "legacy020-window");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "legacy020-w" };
    const nulls = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.tax_code
       where company_id = ${f.s.company} and regime_id is null`);
    expect(nulls[0]!.n).toBe(0);          // regime_id is NOT NULL in the DDL; this asserts the data too

    await withTenant(db.rw, ctx, async (tx) => {
      await tx`update app.tax_code set effective_to = '2025-12-31'
                where id = ${f.codes["SYN-OUT-STD"]!}`;
    });
    await expect(postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE", effectiveDate: "2026-01-10", taxInclusive: false,
      lines: [{ lineNo: 1, accountId: f.accounts["4000"]!, amount: "100.0000", taxCode: "SYN-OUT-STD" }],
    })).rejects.toMatchObject({ code: "ERR_TAX_REGIME_MISMATCH" });
    // "a refusal, not a wrong number" (spec:2444) — and the ambiguous-date half of the defect is answered
    // by the column type: `effective_from`/`effective_to` are `date`, compared to `document.effective_date`,
    // which is also `date`. There is no string date in this path to be ambiguous.
  }, 180_000);

  it("`kind` is a text CHECK owned by this table, not an enum shared with another meaning", async () => {
    const f = await taxFixture(db, "legacy020-enum");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "legacy020-e" };
    const [{ constraints, enums }] = await withTenant(db.rw, ctx, (tx) =>
      tx<{ constraints: number; enums: number }[]>`
        select (select count(*)::int from pg_constraint
                 where conname = 'tax_code_kind_check') as constraints,
               (select count(*)::int from pg_type t join pg_enum e on e.enumtypid = t.oid
                 where e.enumlabel in ('output', 'input', 'exempt', 'zero', 'out_of_scope')) as enums`);
    expect(constraints).toBe(1);
    expect(enums).toBe(0);   // hazard 11: no slice adds an enum label; a closed vocabulary is text + CHECK
  }, 180_000);
});
```

- [ ] **Step 2: Create `tests/regression/legacy-058.test.ts`**

```ts
// tests/regression/legacy-058.test.ts
// LEGACY-058 (M) — `procGetTaxItems` applies contradictory filters to the two halves of its union
// (spec:708). The failure: an uncoded manual journal is invisible to the reconciliation AND excluded
// from the return. Created by slice 5A.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { createTaxReturn, generateTaxReturn } from "@dulja/db";
import { startDb, type Db } from "@dulja/db/test";
import { postJournal } from "@dulja/db";                       // 1B's helper — the "manual voucher" half
import { postTaxedDocument, taxFixture } from "../invariants/support/tax";

describe("LEGACY-058 procGetTaxItems applies contradictory filters to the two halves of its union — 5A", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("an uncoded line behaves identically on a sale, on a purchase and on a manual journal", async () => {
    const f = await taxFixture(db, "legacy058");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "legacy058" };

    // One sale and one purchase, each with a CODED line and an UNCODED line. In the legacy system the
    // bill half and the voucher half of the union disagreed about what `uncoded` even meant, and the
    // voucher seed carried `ItmTaxCode is not null`, a contradiction that always returned zero rows.
    const sale = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE", effectiveDate: "2026-01-10", taxInclusive: false,
      lines: [
        { lineNo: 1, accountId: f.accounts["4000"]!, amount: "1000.0000", taxCode: "SYN-OUT-STD" },
        { lineNo: 2, accountId: f.accounts["4000"]!, amount: "500.0000", taxCode: null },
      ],
    });
    const purchase = await postTaxedDocument(db, f, {
      typeCode: "PURCHASE_INVOICE", effectiveDate: "2026-01-11", partyId: f.vendorId, taxInclusive: false,
      lines: [
        { lineNo: 1, accountId: f.accounts["5900"]!, amount: "200.0000", taxCode: "SYN-IN-STD" },
        { lineNo: 2, accountId: f.accounts["5900"]!, amount: "300.0000", taxCode: null },
      ],
    });
    // A manual journal: JOURNAL's policy declares `tax: { applies: false }` (§4.3.7) and its lines carry
    // no tax code at all. It must post, it must appear in the ledger, and it must contribute nothing.
    const journal = await postJournal(db, f.s, {
      effectiveDate: "2026-01-12",
      lines: [
        { lineNo: 1, accountId: f.accounts["5900"]!, debit: "75.0000", credit: "0.0000" },
        { lineNo: 2, accountId: f.accounts["1100"]!, debit: "0.0000", credit: "75.0000" },
      ],
    });

    const counts = await withTenant(db.rw, ctx, (tx) => tx<{ doc: string; n: number }[]>`
      select d.id::text as doc, count(t.id)::int as n
        from app.document d
        left join app.tax_transaction t on t.document_id = d.id
       where d.id in (${sale.documentId}, ${purchase.documentId}, ${journal.documentId})
       group by d.id order by d.id`);
    const byDoc = Object.fromEntries(counts.map((r) => [r.doc, r.n]));
    expect(byDoc[sale.documentId]).toBe(1);        // the coded line only
    expect(byDoc[purchase.documentId]).toBe(1);    // the coded line only — the SAME rule, both directions
    expect(byDoc[journal.documentId]).toBe(0);     // and nothing at all for the manual voucher

    // All three are still in the ledger. The legacy failure was that the journal DISAPPEARED — from the
    // reconciliation and from the return — and the ledger was the only place it survived.
    const entries = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry
       where document_id in (${sale.documentId}, ${purchase.documentId}, ${journal.documentId})`);
    expect(entries[0]!.n).toBeGreaterThanOrEqual(8);

    // And the uncoded lines were ZEROED, not left stale — T7's rule, and LEGACY-011's neighbour.
    const zeroed = await withTenant(db.rw, ctx, (tx) => tx<{ tax_amount: string; total: string }[]>`
      select tax_amount::text, total_incl_tax::text as total from app.document_line
       where document_id = ${sale.documentId} and line_no = 2`);
    expect(zeroed[0]).toEqual({ tax_amount: "0.0000", total: "500.0000" });
  }, 180_000);

  it("the uncoded value reaches the return through no box, and the coded value through exactly one",
    async () => {
      const f = await taxFixture(db, "legacy058-boxes");
      const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "legacy058-b" };
      await postTaxedDocument(db, f, {
        typeCode: "SALES_INVOICE", effectiveDate: "2026-01-10", taxInclusive: false,
        lines: [
          { lineNo: 1, accountId: f.accounts["4000"]!, amount: "1000.0000", taxCode: "SYN-OUT-STD" },
          { lineNo: 2, accountId: f.accounts["4000"]!, amount: "500.0000", taxCode: null },
        ],
      });
      const boxes = await withTenant(db.rw, ctx, async (tx) => {
        const d = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId,
          periodStart: "2026-01-01", periodEnd: "2026-01-31" });
        return (await generateTaxReturn(tx, ctx, d.id)).boxes;
      });
      // 1000 in S1, 110 in S2, and the 500 nowhere: an uncoded line is out of scope of the return by
      // construction, which is a decision the operator can see rather than a filter that lost it.
      expect(boxes.map((b) => [b.code, b.amount.toString()])).toEqual([
        ["S1", "1000.0000"], ["S2", "110.0000"], ["S3", "0.0000"], ["P1", "0.0000"], ["P2", "0.0000"],
      ]);
    }, 180_000);
});
```

⚠️ **`postJournal` is 1B's export and its option names are 1B's.** If the signature above does not match `packages/db/src/reports/`'s helper as 1B shipped it, correct **this** call — never add a journal helper here (hazard 9, §4.18). The assertion does not depend on the helper's shape, only on there being a posted JOURNAL.

- [ ] **Step 3: Create `tests/regression/legacy-059.test.ts`**

```ts
// tests/regression/legacy-059.test.ts
// LEGACY-059 (H) — `procGetTaxItems` overflows its declared buffer on a normal VAT return (spec:713).
// The failure: truncation at a clause boundary yields "a valid query with the period filter missing", and
// the return silently reports every voucher ever posted. Created by slice 5A.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { createTaxReturn, generateTaxReturn } from "@dulja/db";
import { malaysiaPack, Money, currency } from "@dulja/domain";
import { sourceFiles, startDb, type Db } from "@dulja/db/test";
import { postTaxedDocument, taxFixture } from "../invariants/support/tax";

describe("LEGACY-059 procGetTaxItems overflows its declared buffer on a normal VAT return — 5A", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("a return is bounded by its period even when later periods hold much larger figures", async () => {
    const f = await taxFixture(db, "legacy059");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "legacy059" };
    await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE", effectiveDate: "2026-01-10", taxInclusive: false,
      lines: [{ lineNo: 1, accountId: f.accounts["4000"]!, amount: "1000.0000", taxCode: "SYN-OUT-STD" }],
    });
    // The figure the legacy return would have swept in. If the period filter were lost, S2 reads
    // 110 + 11000 = 11110.0000, which is exactly the "filed-return-level error with no visible symptom".
    await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE", effectiveDate: "2026-06-15", taxInclusive: false,
      lines: [{ lineNo: 1, accountId: f.accounts["4000"]!, amount: "100000.0000", taxCode: "SYN-OUT-STD" }],
    });
    const boxes = await withTenant(db.rw, ctx, async (tx) => {
      const d = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId,
        periodStart: "2026-01-01", periodEnd: "2026-01-31" });
      return (await generateTaxReturn(tx, ctx, d.id)).boxes;
    });
    expect(boxes.find((b) => b.code === "S1")!.amount.toString()).toBe("1000.0000");
    expect(boxes.find((b) => b.code === "S2")!.amount.toString()).toBe("110.0000");
  }, 180_000);

  it("an out-of-window transaction is a refusal, never a silently dropped row", () => {
    // The other direction of the same defect. `buildReturnFrom` is handed rows by the caller's own SQL;
    // if a row outside the window ever reaches it, that is a query bug and it says so rather than
    // filtering the row away, which would hide exactly the fault.
    const ccy = currency("MYR");
    const regime = { id: "55555555-5555-7555-8555-555555555555", code: "SYNTH-MY-v1",
                     jurisdiction: "MY" as const, version: 1,
                     effectiveFrom: "2026-01-01", effectiveTo: null };
    const late = {
      documentId: "66666666-6666-7666-8666-666666666666", documentTypeCode: "SALES_INVOICE", lineNo: 1,
      taxCodeId: "77777777-7777-7777-8777-777777777777", taxCode: "SYN-OUT-STD",
      regimeId: regime.id, kind: "output" as const, rate: "0.11000000",
      base: Money.of("100.0000", ccy), tax: Money.of("11.0000", ccy),
      baseBase: Money.of("100.0000", ccy), taxBase: Money.of("11.0000", ccy),
      effectiveDate: "2026-06-15", postingSeq: "9",
    };
    expect(() => malaysiaPack.buildReturn({ regime, periodStart: "2026-01-01", periodEnd: "2026-01-31",
                                            transactions: [late] }))
      .toThrow(/is dated 2026-06-15, outside 2026-01-01\.\.2026-01-31/);
  });

  it("the period bounds are parameters of a tagged template — losing one is not expressible", () => {
    // The root cause was string building. `sql.unsafe` has exactly three homes (§3.3, hazard 21) and none
    // is in this slice; `no-sql-concat` (test 27) enforces the general rule and this pins it for the two
    // directories a tax reader will look in.
    const offenders = sourceFiles(["packages/domain/src/tax", "packages/db/src/tax"])
      .flatMap((f) => f.lines.flatMap((line, i) =>
        /\.unsafe\s*\(|["'`][^"'`]*\b(select|insert|update|delete|where)\b[^"'`]*["'`]\s*\+/i.test(line)
          ? [`${f.path}:${i + 1} ${line.trim()}`] : []));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 4: Append the two `— 5A` blocks**

`tests/regression/legacy-011.test.ts` gains one `describe` at the end of the file. **Nothing above it is touched** (§3.7.3).

```ts
// ── appended by slice 5A ─────────────────────────────────────────────────────────────────────────────
describe("LEGACY-011 NULL arithmetic irreversibly nulls balances and tax boxes — 5A (the VAT-box half)", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("every monetary column of app.tax_transaction is NOT NULL", async () => {
    // "A return is filed with tax but no base" was possible because `Output_Total` and `Output_Tax` were
    // separate accumulations and only one of them met a NULL. Here both figures are columns of one row
    // and neither can be null, so the two cannot disagree about whether a transaction happened.
    const rows = await withTenant(db.rw, SYSTEM_CTX, (tx) => tx<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_transaction'
         and column_name in ('base', 'tax', 'base_base', 'tax_base')
       order by column_name`);
    expect(rows).toEqual([
      { column_name: "base", is_nullable: "NO" },
      { column_name: "base_base", is_nullable: "NO" },
      { column_name: "tax", is_nullable: "NO" },
      { column_name: "tax_base", is_nullable: "NO" },
    ]);
  }, 180_000);

  it("an uncoded line is written 0.0000 rather than left stale, and an empty period ties out to 0.0000",
    async () => {
      const f = await taxFixture(db, "legacy011-5a");
      const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "legacy011-5a" };
      const doc = await postTaxedDocument(db, f, {
        typeCode: "SALES_INVOICE", effectiveDate: "2026-01-10", taxInclusive: false,
        lines: [{ lineNo: 1, accountId: f.accounts["4000"]!, amount: "400.0000", taxCode: null }],
      });
      const line = await withTenant(db.rw, ctx, (tx) => tx<{ tax_amount: string; total: string }[]>`
        select tax_amount::text, total_incl_tax::text as total
          from app.document_line where document_id = ${doc.documentId}`);
      expect(line[0]).toEqual({ tax_amount: "0.0000", total: "400.0000" });

      const tie = await withTenant(db.rw, ctx, async (tx) => {
        const d = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId,
          periodStart: "2026-02-01", periodEnd: "2026-02-28" });
        await generateTaxReturn(tx, ctx, d.id);
        return taxReturnTieOut(tx, d.id);
      });
      // `coalesce(..., 0)` in taxReturnTieOut is what makes this a real assertion: a null difference
      // compares equal to nothing and passes every test, which is how the legacy return went unnoticed.
      expect(tie.map((r) => [r.accountCode, r.ledgerBase, r.difference])).toEqual([
        ["1350", "0.0000", "0.0000"], ["2300", "0.0000", "0.0000"],
      ]);
      for (const r of tie) expect(r.difference).not.toBeNull();
    }, 180_000);
});
```

**The imports both appended blocks need**, added to the top of each file beside whatever 0B already imports there — never replacing an existing line: `legacy-011.test.ts` gains `withTenant` from `@dulja/db`, `createTaxReturn` / `generateTaxReturn` / `taxReturnTieOut` from `@dulja/db`, `startDb` and `type Db` from `@dulja/db/test`, and `postTaxedDocument` / `taxFixture` from `../invariants/support/tax`; `legacy-019.test.ts` gains `taxEngine`, `Money`, `currency` and `type RoundingMode` from `@dulja/domain` and `sourceFiles` from `@dulja/db/test`. **`SYSTEM_CTX`** in the first block is the file-local `{ tenantId: <a seeded tenant>, actorId: <its system principal>, requestId: "legacy011-5a-ddl" }` — the DDL case reads `information_schema` and needs *a* tenant session, not a particular one; if 0B's file already declares such a constant, use it rather than adding a second.

`tests/regression/legacy-019.test.ts` gains:

```ts
// ── appended by slice 5A ─────────────────────────────────────────────────────────────────────────────
describe("LEGACY-019 Rounding is configured everywhere, applied nowhere, and the function is wrong — 5A", () => {
  const ccy = currency("MYR");
  const codeAt = (mode: RoundingMode) => ({
    id: "88888888-8888-7888-8888-888888888888", regimeId: "99999999-9999-7999-8999-999999999999",
    code: "SYN-OUT-STD", rate: "0.11000000", kind: "output" as const, roundingMode: mode,
    outputAccountId: null, inputAccountId: null, effectiveFrom: "2026-01-01", effectiveTo: null,
  });
  const regime = { id: "99999999-9999-7999-8999-999999999999", code: "SYNTH-MY-v1",
                   jurisdiction: "MY" as const, version: 1, effectiveFrom: "2026-01-01", effectiveTo: null };

  it("the declared mode is APPLIED: two codes differing only in rounding_mode give different tax", () => {
    // The defect's headline: ten rounding columns across `Currencies` and `TaxCodes` with ZERO references.
    // 10.0500 x 0.11 = 1.1055 exactly, so at scale 4 there is nothing to round and every mode agrees --
    // asserted first, because a test whose two modes always differ proves nothing about which one ran.
    const base = Money.of("10.0500", ccy);
    const half = taxEngine.compute(regime,
      [{ lineNo: 1, amount: base, taxCode: codeAt("HALF_AWAY_FROM_ZERO"), inclusive: false }]);
    const toward = taxEngine.compute(regime,
      [{ lineNo: 1, amount: base, taxCode: codeAt("TOWARD_ZERO"), inclusive: false }]);
    expect(half[0]!.tax.toString()).toBe("1.1055");
    expect(toward[0]!.tax.toString()).toBe("1.1055");
    // Now push the base until the modes MUST part: 10.0509 x 0.11 = 1.105599, whose fifth decimal is 9.
    const finer = Money.of("10.0509", ccy);
    const h2 = taxEngine.compute(regime,
      [{ lineNo: 1, amount: finer, taxCode: codeAt("HALF_AWAY_FROM_ZERO"), inclusive: false }]);
    const t2 = taxEngine.compute(regime,
      [{ lineNo: 1, amount: finer, taxCode: codeAt("TOWARD_ZERO"), inclusive: false }]);
    expect(h2[0]!.tax.toString()).toBe("1.1056");
    expect(t2[0]!.tax.toString()).toBe("1.1055");
    expect(h2[0]!.tax.toString()).not.toBe(t2[0]!.tax.toString());
  });

  it("rounding is symmetric across sign — the +6/-6 asymmetry that left a 5-unit imbalance per credit note",
    () => {
      // `RoundTo.sql` returned +10 for +6 and -5 for -6. Every mode here must be sign-symmetric in
      // MAGNITUDE for HALF_AWAY_FROM_ZERO, which is the mode every shipped code declares.
      const plus = taxEngine.compute(regime, [{ lineNo: 1, amount: Money.of("10.0509", ccy),
        taxCode: codeAt("HALF_AWAY_FROM_ZERO"), inclusive: false }]);
      const minus = taxEngine.compute(regime, [{ lineNo: 1, amount: Money.of("-10.0509", ccy),
        taxCode: codeAt("HALF_AWAY_FROM_ZERO"), inclusive: false }]);
      expect(minus[0]!.tax.toString()).toBe(`-${plus[0]!.tax.toString()}`);
      expect(minus[0]!.base.toString()).toBe(`-${plus[0]!.base.toString()}`);
    });

  it("a null base is not expressible, and a rounded figure is never rounded twice", () => {
    // `vRoundBase is NULL` bypassed the `= 0` guard and returned NULL, silently nulling the amount.
    // `Money` has no null state and `TaxLineInput.amount` is a `Money`, so the branch cannot exist.
    // And an inclusive line's base + tax is EXACTLY the entered figure — no residue, no second rounding.
    const r = taxEngine.compute(regime, [{ lineNo: 1, amount: Money.of("1110.0000", ccy),
      taxCode: codeAt("HALF_AWAY_FROM_ZERO"), inclusive: true }]);
    expect(r[0]!.base.add(r[0]!.tax).toString()).toBe("1110.0000");
    expect(r[0]!.base.toString()).toBe("1000.0000");
    expect(r[0]!.tax.toString()).toBe("110.0000");
  });

  it("there is exactly one rounding function: no Math.round and no local round in either tax directory",
    () => {
      const offenders = sourceFiles(["packages/domain/src/tax", "packages/db/src/tax"])
        .flatMap((f) => f.lines.flatMap((line, i) =>
          /\bMath\.(round|floor|ceil|trunc)\b|\bfunction\s+round\b|\.toFixed\s*\(/.test(line)
            ? [`${f.path}:${i + 1} ${line.trim()}`] : []));
      expect(offenders).toEqual([]);
    });
});
```

⚠️ **The two figures `1.1056` / `1.1055` are the one place this task asserts an arithmetic result rather than a property.** They follow from `10.0509 × 0.11 = 1.105599`, which rounds up at scale 4 under `HALF_AWAY_FROM_ZERO` and down under `TOWARD_ZERO`. **Verify them by hand before running**; if the engine disagrees, the finding is in T5's `compute`, not here.

- [ ] **Step 5: Write `tests/invariants/phase-5a-pinned.test.ts` — the re-run matrix as equalities**

The card's re-runs (12, 13, 27, 36) and the two pinned lists this slice must leave exactly where it found them.

```ts
// tests/invariants/phase-5a-pinned.test.ts
// The lists slice 5A must leave unchanged, and the acceptance tests §2.6 lists as re-runs. Every case here
// is an EQUALITY, not a superset check: a list that grew silently is the failure this file exists to find.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema, startDb, type Db } from "@dulja/db/test";
import { PERMISSIONS } from "@dulja/contracts";
import { ROLES } from "@dulja/db/seed";
import { ROUTES } from "../../apps/api/src/routes/index";
import { PROBES } from "./probes";

describe("slice 5A — the pinned lists and the re-run matrix", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); }, 180_000);
  afterAll(async () => { await db.stop(); });

  // ── §3.5.4: the app_rw DELETE grant list. 2B is the ONLY slice that ever extends it (hazard 25). ─────
  it("app_rw holds DELETE on exactly the pinned tables — 5A adds none", async () => {
    const rows = await withTenant(db.rw, SYSTEM_CTX, (tx) => tx<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and privilege_type = 'DELETE' and table_schema = 'app'
       order by table_name`);
    const granted = rows.map((r) => r.table_name);
    expect(granted).not.toContain("tax_code");         // archived with archived_at (spec:2049)
    expect(granted).not.toContain("tax_transaction");  // immutable, and posting-only besides
    expect(granted).not.toContain("tax_return");       // a regeneration is an UPDATE of the same row
    expect(granted).not.toContain("tax_regime");
    // The full pinned equality lives in packages/db/test/privileges.test.ts (Plan 0A, extended by 2B);
    // this is the 5A-shaped statement of it and it fails the moment one of the four appears.
  }, 180_000);

  // ── §3.5.3: the linter sets, at exactly the state the register declares. Hazard 13. ──────────────────
  it("only tax_transaction joined AUDIT_EXEMPT and IMMUTABLE; the other three tables are audited", () => {
    expect(AUDIT_EXEMPT).toContain("app.tax_transaction");
    expect(IMMUTABLE).toContain("app.tax_transaction");
    for (const t of ["app.tax_regime", "app.tax_code", "app.tax_return"]) {
      expect(AUDIT_EXEMPT, `${t} must stay audited (test 13)`).not.toContain(t);
      expect(IMMUTABLE, `${t} is mutable master data`).not.toContain(t);
    }
  });

  it("the schema linter passes over the four new tables", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.table.startsWith("app.tax_"))).toEqual([]);
  }, 180_000);

  // ── Test 13 re-run: audit completeness over this slice's own tables. ─────────────────────────────────
  it("a write to each audited tax table lands in app.audit_log under the acting principal", async () => {
    const f = await taxFixture(db, "pinned-audit");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "pinned-audit" };
    const before = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name in ('tax_code', 'tax_return')`);
    await withTenant(db.rw, ctx, async (tx) => {
      await tx`update app.tax_code set name_en = 'renamed (audited)' where id = ${f.codes["SYN-EXEMPT"]!}`;
      await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId,
        periodStart: "2026-01-01", periodEnd: "2026-01-31" });
    });
    const after = await withTenant(db.rw, ctx, (tx) => tx<{ n: number; actors: string[] }[]>`
      select count(*)::int as n, array_agg(distinct actor_id::text) as actors
        from app.audit_log where table_name in ('tax_code', 'tax_return')`);
    expect(after[0]!.n).toBeGreaterThan(before[0]!.n);
    expect(after[0]!.actors).toContain(f.s.human);
  }, 180_000);

  // ── Test 36 re-run: the permission catalogue. §3.6.1's vocabulary is CLOSED (hazard 26). ─────────────
  it("5A added exactly one permission code and it is granted to exactly the accountant", () => {
    const tax = PERMISSIONS.filter((p) => p.code.startsWith("accounting.tax."));
    expect(tax.map((p) => p.code)).toEqual(["accounting.tax.manage"]);   // `.file` is 5B's, not seeded here
    expect(tax[0]!.mutating).toBe(true);
    const holders = Object.entries(ROLES)
      .filter(([, codes]) => (codes as readonly string[]).includes("accounting.tax.manage"))
      .map(([role]) => role).sort();
    expect(holders).toEqual(["accountant"]);
  });

  // ── Test 12 re-run: two route modules, two probes, keyed by RouteModule.path (hazard 31). ────────────
  it("both new route modules have a probe, and no probe names a route that does not exist", () => {
    const paths = ROUTES.map((r) => r.path);
    expect(paths).toContain("/v1/companies/:companyId/tax-codes");
    expect(paths).toContain("/v1/companies/:companyId/tax-returns");
    for (const p of paths) expect(Object.keys(PROBES), `${p} has no probe`).toContain(p);
    for (const k of Object.keys(PROBES)) expect(paths, `${k} probes nothing`).toContain(k);
  });

  // ── Test 27 re-run: no SQL text across the API, stated for this slice's own surface. ─────────────────
  it("this slice ships no sql.unsafe and no concatenated SQL", () => {
    const offenders = sourceFiles([
      "packages/domain/src/tax", "packages/db/src/tax", "packages/db/src/posting/tax.ts",
      "packages/db/src/seed/tax.ts", "apps/api/src/routes/accounting/tax-codes.ts",
      "apps/api/src/routes/accounting/tax-returns.ts",
    ]).flatMap((f) => f.lines.flatMap((line, i) =>
      /\.unsafe\s*\(/.test(line) ? [`${f.path}:${i + 1}`] : []));
    expect(offenders).toEqual([]);   // §3.3: sql.unsafe has exactly three homes and none is here
  });

  // ── Test 15 re-run, the assertion half: the four types gained tax through SEED DATA only. ────────────
  it("the four 4A types carry policyVersion 2 with a tax block, and 5A shipped no document-type code", () => {
    const PACK = repoFile("packages/db/seed/my/document-types");
    for (const code of ["SALES_INVOICE", "SALES_CREDIT_NOTE", "PURCHASE_INVOICE", "PURCHASE_CREDIT_NOTE"]) {
      const env = JSON.parse(readFileSync(join(PACK, `${code}.json`), "utf8")) as {
        code: string; policyVersion: number; policy: { tax: { applies: boolean }; lines: { for: string }[] };
      };
      expect(env.code).toBe(code);
      expect(env.policyVersion).toBe(2);
      expect(env.policy.tax.applies).toBe(true);
      expect(env.policy.lines.filter((l) => l.for === "each_tax")).toHaveLength(1);
    }
    // And nothing else in the pack is 5A's. The card is explicit: this slice registers no §4.14 code.
    const owned = readdirSync(PACK).filter((f) => /^TAX_/.test(f));
    expect(owned).toEqual([]);
  });
});
```

**The file's remaining imports**, beside the ones written above: `readFileSync` and `readdirSync` from `node:fs`, `join` from `node:path`, `sourceFiles` and `repoFile` from `@dulja/db/test`, `createTaxReturn` from `@dulja/db`, and `taxFixture` from `./support/tax`. **`SYSTEM_CTX`** here is the same file-local shape as in the legacy-011 block — a seeded tenant's system principal, declared once at the top of this file, because `information_schema` and `pg_constraint` reads still need a tenant session (every query runs inside `withTenant`, spec:2053).

- [ ] **Step 6: Run everything, and commit**

```bash
bun run --cwd tests test -- regression/legacy-011 regression/legacy-019 regression/legacy-020 \
                            regression/legacy-058 regression/legacy-059 invariants/phase-5a-pinned \
  && bun run --cwd tests test -- invariants/tenant-isolation invariants/audit-chain \
  && bun run --cwd packages/db test \
  && bun run lint && bun run lint:rules && bun run format:check && bun run typecheck
```

**All five regression files green, both appended blocks green, and the pinned file green.** A failure in `phase-5a-pinned` is never fixed in that file — it means a list moved, and the fix is in the task that moved it.

```bash
git add tests/regression/legacy-020.test.ts tests/regression/legacy-058.test.ts \
        tests/regression/legacy-059.test.ts tests/regression/legacy-011.test.ts \
        tests/regression/legacy-019.test.ts tests/invariants/phase-5a-pinned.test.ts
git commit -m "$(cat <<'EOF'
test(regression): close LEGACY-020, 058 and 059 and pin 5A's lists [5A T11]

Three files created and two appended, each asserting the defect's actual failure rather
than its heading: a rate that is a row and not a literal (020), one selection rule for
both directions so an uncoded manual journal cannot vanish (058), a period bound that is
a parameter and an out-of-window row that refuses rather than being dropped (059), a
return that cannot carry tax without base (011), and a rounding mode that is declared per
code AND applied, symmetric across sign, with no second rounding function (019). The
pinned file states the DELETE list, the linter sets, the catalogue and the probe keys as
equalities -- a list that grew silently is what it exists to find.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: ⚠️ OD-24 — the tax-return screen

**Owner decision OD-24 (§2.12): "Screenshots + operator description before any screen" — spec:79, 108, 2408. Default: the screen task is blocked, not the slice.** spec:79 and spec:108 state that the UI is not specified, and hazard 29 forbids inventing a workflow.

**Owner provides:** a screenshot of the legacy screen an operator uses to prepare and check a **VAT/GST return**, and a **two-minute description** of what they do, in order, including which keys they press and what they compare the figures against before filing. **Verify:** `ls -1 docs/owner/od-24/5a/` shows two files — `tax-return.png` and one `.md` transcript. **Until provided:** Steps 2 onward do not run; the slice ships with the API and no screen, and Tasks 8–11 are a deliverable the accountant's own tooling can already drive through `GET /v1/companies/{companyId}/tax-returns/{id}`.

**Steps 2–6 carry real code against a stated default layout**, on 3A's, 3D's and 4B's terms and for their reason: hazard 29 blocks the *screen*, not the ability to write one, and if the owner's material shows a different workflow only `tax-returns.tsx` and its test change — `tax-api.ts` does not.

**The stated default layout, so a reviewer can compare it to the owner's material.** 0E Task 4's keyboard model unchanged (`/` filters, `↑`/`↓` move the selection, `Enter` opens, `Ctrl+S` saves, `Esc` reverts, `Ctrl+N` starts a new row), plus **one addition this job needs and one deliberate omission**.

- **The addition: `Ctrl+G` generates the selected return**, and it is a distinct key rather than `Ctrl+S` because generating **writes a payload and stamps `generated_by`** — an operator arrowing through a list must not be able to generate one by muscle memory. A confirmation is not asked (a regeneration is idempotent and the sha proves it), but the key is deliberate.
- **The omission: there is no "file" action.** `generated → filed` is 5B's transition under `accounting.tax.file`, this slice seeds neither the code nor the button, and a screen offering an action the API refuses is worse than a screen missing one.
- **The layout is one column, not two.** A return is a list of five to fifteen boxes and a two-row reconciliation; the operator's whole job is *"do these figures agree with my own working"*, so the boxes and the tie-out are read together on one surface and the return list is a filter strip above them. **The tie-out is not collapsible**: `difference` is the one figure that must never be scrolled past, and a non-zero one paints the row and blocks nothing — the screen reports, the API refuses.

**Files:** create `apps/backoffice/src/lib/tax-api.ts`, `apps/backoffice/src/routes/accounting/tax-returns.tsx`, `apps/backoffice/test/tax-returns.test.tsx`, `tests/e2e/tax-return.spec.ts`; modify `apps/backoffice/src/lib/ar-ap-api.ts` (**one word**: `filterQuery` gains `export`), `apps/backoffice/src/router.tsx` (one route), `apps/backoffice/src/components/app-shell.tsx` (one nav entry), `packages/i18n/src/locales/en.json` and `ar.json` (the `accounting.tax.*` keys).

**Interfaces**

- Consumes: the six `@dulja/ui` components 0E owns — `DataGrid`, `DateField`, `MoneyText`, `ProblemAlert`, `SelectList`, `Toolbar`; **this slice adds none**, and any that 0E did not ship is a 0E reconciliation, not a component invented here. `apiFetch` (0E Task 3's authenticated fetch wrapper, `apps/backoffice/src/lib/api-client.ts`); **`filterQuery` from 4B's `apps/backoffice/src/lib/ar-ap-api.ts`**, which that plan declares "the ONE place in the backoffice that composes §4.2.8's filter grammar" — so this task **exports** it rather than writing a second one (hazard 9). `useTranslation` and the `accounting.tax.*` ICU keys (`@dulja/i18n`, 0E); `MoneyJson` (`@dulja/i18n`, 0E — the §4.2.8 `MoneySchema` wire shape given a TypeScript name, and reachable from `apps/**` where `@dulja/domain`'s `Money` is the wrong tool for a rendered figure); the TanStack `createRoute` shape 0E's `router.tsx` already uses. From `@dulja/contracts`: the **DTO aliases only** — `TaxReturnDto`, `TaxCodeDto` (T8 Step 4). **`apps/backoffice` may not import `packages/db` (§3.1)**, so `TaxReturnRow` and `TaxReturnTieOutRow` are unreachable here and the two file-local response interfaces below are the only legal spelling.
- Produces: `apps/backoffice/src/lib/tax-api.ts` — `fetchTaxReturns`, `TaxReturnListResponse`, `fetchTaxReturn`, `TaxReturnDetailResponse`, `TieOutRow`, `ReturnBoxJson`, `createTaxReturn`, `generateTaxReturn`, `fetchTaxCodes`; `src/routes/accounting/tax-returns.tsx` exporting its TanStack `Route` and keeping `boxRows`, `tieRows` and its row types file-local; one `router.tsx` entry, one `app-shell.tsx` entry, and the `accounting.tax.*` keys in **both** locale catalogues, complete in `en` and `ar` before merge (spec:2061). **No contract, no route and no table** — everything this screen reads exists after Task 8, which is what makes the task droppable whole.

- [ ] **Step 1: The OD-24 gate**

```bash
mkdir -p docs/owner/od-24/5a
ls -1 docs/owner/od-24/5a/
```

Two files must be listed. **Until then, stop here** and record the outstanding screen in the PR body of Task 11's commit. The slice ships without it.

- [ ] **Step 2: The typed fetch layer**

```tsx
// apps/backoffice/src/lib/tax-api.ts
//
// Slice 5A's read/write surface for the tax-return screen. It composes NO query string of its own: 4B's
// `filterQuery` is declared the one place in this application that writes §4.2.8's `filter[<field>][<op>]`
// grammar, and a second composer is how a convention diverges (hazard 9). The only edit this task makes to
// that file is adding `export` to the function.
//
// DTO ALIASES, not schemas: a Zod schema is a value and `import type` cannot name one. `TaxReturnDto` and
// `TaxCodeDto` are declared beside their schemas in packages/contracts/src/accounting/tax.ts (T8 Step 4),
// the `z.infer` convention 1B's `TrialBalanceRowDto` established.
import type { TaxCodeDto, TaxReturnDto } from "@dulja/contracts";
import { filterQuery } from "./ar-ap-api";
import { apiFetch } from "./api-client";

/** The wire box: `ReturnBoxSchema` (T8 Step 4). `amount` is a 4-dp string and stays one all the way to
 *  `MoneyText` — `apps/**` never parses a money string into a number (`no-number-money`, §3.7.5). */
export interface ReturnBoxJson { code: string; label: string; amount: string }
/** `TaxReturnTieOutRowSchema` (T8 Step 4). Its `difference` is what the screen paints on. */
export interface TieOutRow {
  accountCode: string; boxCodes: string[]; boxBase: string; ledgerBase: string; difference: string;
}
export interface TaxReturnListResponse { items: TaxReturnDto[]; next_cursor: string | null }
/** `TaxReturnDetail` (T8 Step 4). A draft returns `boxes: []`, `payload: null` and `tieOut: []`. */
export interface TaxReturnDetailResponse {
  taxReturn: TaxReturnDto; boxes: ReturnBoxJson[]; payload: string | null;
  tieOut: TieOutRow[]; currency: string;
}

export async function fetchTaxReturns(
  companyId: string, opts: { regimeCode?: string } = {},
): Promise<TaxReturnListResponse> {
  return apiFetch(`/v1/companies/${companyId}/tax-returns${filterQuery({ regimeCode: opts.regimeCode })}`);
}

export async function fetchTaxReturn(
  companyId: string, taxReturnId: string,
): Promise<TaxReturnDetailResponse> {
  return apiFetch(`/v1/companies/${companyId}/tax-returns/${taxReturnId}`);
}

/** The two unsafe calls. `apiFetch` attaches the `Idempotency-Key` header every unsafe method needs
 *  (§4.2.9); a replayed key returns the stored body with `Idempotency-Replayed: true` and the screen is
 *  correct either way, which is exactly why the key is generated per user gesture and not per render. */
export async function createTaxReturn(
  companyId: string,
  body: { regimeCode: string; regimeVersion: number; periodStart: string; periodEnd: string },
): Promise<TaxReturnDto> {
  return apiFetch(`/v1/companies/${companyId}/tax-returns`, { method: "POST", body });
}

export async function generateTaxReturn(
  companyId: string, taxReturnId: string,
): Promise<TaxReturnDetailResponse> {
  return apiFetch(`/v1/companies/${companyId}/tax-returns/${taxReturnId}/generate`, { method: "POST" });
}

/** The regime picker's source: the tax-code list carries `regimeCode` and `regimeVersion` on every row, so
 *  the screen never has to hold a per-tenant regime uuid (T8's `CreateTaxReturnBody` takes code+version). */
export async function fetchTaxCodes(
  companyId: string,
): Promise<{ items: TaxCodeDto[]; next_cursor: string | null }> {
  return apiFetch(`/v1/companies/${companyId}/tax-codes`);
}
```

and the one-word edit in `apps/backoffice/src/lib/ar-ap-api.ts`:

```ts
/** §4.2.8 Layer 1's grammar, in one place. Values are encoded; an empty clause list yields "".
 *  Exported by slice 5A's Task 12 so the tax screen composes filters through this function and not a
 *  second copy — 4B's own comment calls this "the ONE place in the backoffice". */
export function filterQuery(clauses: Readonly<Record<string, string | undefined>>): string {
```

- [ ] **Step 3: The screen**

```tsx
// apps/backoffice/src/routes/accounting/tax-returns.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { DataGrid, DateField, MoneyText, ProblemAlert, SelectList, Toolbar } from "@dulja/ui";
import { useTranslation } from "@dulja/i18n";
import { rootRoute } from "../../router";
import { useCompanyId } from "../../lib/company";
import {
  createTaxReturn, fetchTaxCodes, fetchTaxReturn, fetchTaxReturns, generateTaxReturn,
  type ReturnBoxJson, type TaxReturnDetailResponse, type TieOutRow,
} from "../../lib/tax-api";
import type { TaxReturnDto } from "@dulja/contracts";

interface RegimeOption { code: string; version: number; label: string }

/** One place decides what a regime option is, so the picker and the create body cannot disagree about
 *  which `(code, version)` pair a row means. */
function regimeOptions(codes: { regimeCode: string; regimeVersion: number }[]): RegimeOption[] {
  const seen = new Map<string, RegimeOption>();
  for (const c of codes) {
    const key = `${c.regimeCode}@${c.regimeVersion}`;
    if (!seen.has(key)) {
      seen.set(key, { code: c.regimeCode, version: c.regimeVersion, label: `${c.regimeCode} v${c.regimeVersion}` });
    }
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function TaxReturnsScreen() {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const [returns, setReturns] = useState<TaxReturnDto[]>([]);
  const [regimes, setRegimes] = useState<RegimeOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaxReturnDetailResponse | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ regime: "", periodStart: "", periodEnd: "" });

  const reload = useCallback(async () => {
    try {
      const [list, codes] = await Promise.all([fetchTaxReturns(companyId), fetchTaxCodes(companyId)]);
      setReturns(list.items);
      setRegimes(regimeOptions(codes.items));
      setProblem(null);
    } catch (e) { setProblem(e); }
  }, [companyId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (selected === null) { setDetail(null); return; }
    fetchTaxReturn(companyId, selected).then(setDetail).catch(setProblem);
  }, [companyId, selected]);

  const onCreate = useCallback(async () => {
    const option = regimes.find((r) => `${r.code}@${r.version}` === draft.regime);
    if (!option || !draft.periodStart || !draft.periodEnd) return;
    setBusy(true);
    try {
      const made = await createTaxReturn(companyId, {
        regimeCode: option.code, regimeVersion: option.version,
        periodStart: draft.periodStart, periodEnd: draft.periodEnd,
      });
      await reload();
      setSelected(made.id);
      setProblem(null);
    } catch (e) { setProblem(e); } finally { setBusy(false); }
  }, [companyId, draft, regimes, reload]);

  const onGenerate = useCallback(async () => {
    if (selected === null) return;
    setBusy(true);
    try {
      setDetail(await generateTaxReturn(companyId, selected));
      await reload();
      setProblem(null);
    } catch (e) { setProblem(e); } finally { setBusy(false); }
  }, [companyId, reload, selected]);

  // The one keyboard addition this job needs (see the stated default layout). Ctrl+G, never Ctrl+S:
  // generating writes a payload and stamps generated_by, and an operator arrowing a list must not be able
  // to trigger it by muscle memory. `metaKey` for parity on macOS, spec:2254's keyboard-parity target.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") { e.preventDefault(); void onGenerate(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onGenerate]);

  const boxRows = useMemo(() => (detail?.boxes ?? []).map((b: ReturnBoxJson) => ({
    key: b.code, code: b.code, label: b.label,
    amount: <MoneyText value={{ amount: b.amount, currency: detail!.currency }} />,
  })), [detail]);

  // `difference` decides the row's tone and NOTHING else: the screen reports, the API refuses. A tie-out
  // row is never hidden and the section is never collapsible — a non-zero difference scrolled past is the
  // whole class of failure LEGACY-011 and LEGACY-059 are.
  const tieRows = useMemo(() => (detail?.tieOut ?? []).map((r: TieOutRow) => ({
    key: r.accountCode, account: r.accountCode, boxes: r.boxCodes.join(", "),
    box: <MoneyText value={{ amount: r.boxBase, currency: detail!.currency }} />,
    ledger: <MoneyText value={{ amount: r.ledgerBase, currency: detail!.currency }} />,
    difference: <MoneyText value={{ amount: r.difference, currency: detail!.currency }} />,
    tone: r.difference === "0.0000" ? ("ok" as const) : ("warning" as const),
  })), [detail]);

  return (
    <section aria-labelledby="tax-returns-heading">
      <h1 id="tax-returns-heading">{t("accounting.tax.returns.title")}</h1>
      {problem !== null && <ProblemAlert problem={problem} />}

      <Toolbar label={t("accounting.tax.returns.newReturn")}>
        <SelectList
          label={t("accounting.tax.returns.regime")}
          value={draft.regime}
          options={regimes.map((r) => ({ value: `${r.code}@${r.version}`, label: r.label }))}
          onChange={(regime) => setDraft((d) => ({ ...d, regime }))}
        />
        <DateField label={t("accounting.tax.returns.periodStart")} value={draft.periodStart}
                   onChange={(periodStart) => setDraft((d) => ({ ...d, periodStart }))} />
        <DateField label={t("accounting.tax.returns.periodEnd")} value={draft.periodEnd}
                   onChange={(periodEnd) => setDraft((d) => ({ ...d, periodEnd }))} />
        <button type="button" onClick={() => void onCreate()} disabled={busy}>
          {t("accounting.tax.returns.create")}
        </button>
      </Toolbar>

      <DataGrid
        label={t("accounting.tax.returns.listLabel")}
        columns={[
          { key: "period", header: t("accounting.tax.returns.period") },
          { key: "regime", header: t("accounting.tax.returns.regime") },
          { key: "status", header: t("accounting.tax.returns.status") },
        ]}
        rows={returns.map((r) => ({
          key: r.id, period: `${r.periodStart} — ${r.periodEnd}`,
          regime: `${r.regimeCode} v${r.regimeVersion}`,
          status: t(`accounting.tax.returns.statuses.${r.status}`),
        }))}
        selectedKey={selected}
        onSelect={setSelected}
      />

      {detail !== null && (
        <>
          <h2>{t("accounting.tax.returns.boxes")}</h2>
          <DataGrid
            label={t("accounting.tax.returns.boxes")}
            columns={[
              { key: "code", header: t("accounting.tax.returns.boxCode") },
              { key: "label", header: t("accounting.tax.returns.boxLabel") },
              { key: "amount", header: t("accounting.tax.returns.amount"), align: "end" },
            ]}
            rows={boxRows}
            empty={t("accounting.tax.returns.notGenerated")}
          />
          <button type="button" onClick={() => void onGenerate()} disabled={busy}>
            {t("accounting.tax.returns.generate")}
          </button>

          <h2>{t("accounting.tax.returns.reconciliation")}</h2>
          <DataGrid
            label={t("accounting.tax.returns.reconciliation")}
            columns={[
              { key: "account", header: t("accounting.tax.returns.controlAccount") },
              { key: "boxes", header: t("accounting.tax.returns.boxCodes") },
              { key: "box", header: t("accounting.tax.returns.perReturn"), align: "end" },
              { key: "ledger", header: t("accounting.tax.returns.perLedger"), align: "end" },
              { key: "difference", header: t("accounting.tax.returns.difference"), align: "end" },
            ]}
            rows={tieRows}
            empty={t("accounting.tax.returns.notGenerated")}
          />
          {detail.taxReturn.payloadSha256 !== null && (
            <p>{t("accounting.tax.returns.sha", { sha: detail.taxReturn.payloadSha256 })}</p>
          )}
        </>
      )}
    </section>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/accounting/tax-returns",
  component: TaxReturnsScreen,
});
```

**The `payloadSha256` is on the screen deliberately.** The runbook (T8 Step 5) tells the operator to keep it with the filing record and to expect a **different** sha after a correction; a sha nobody can see is a sha nobody keeps.

- [ ] **Step 4: The two locale catalogues**

`packages/i18n/src/locales/en.json` and `ar.json` gain the `accounting.tax.returns.*` keys used above — `title`, `newReturn`, `regime`, `periodStart`, `periodEnd`, `create`, `listLabel`, `period`, `status`, `statuses.draft`, `statuses.generated`, `statuses.filed`, `boxes`, `boxCode`, `boxLabel`, `amount`, `notGenerated`, `generate`, `reconciliation`, `controlAccount`, `boxCodes`, `perReturn`, `perLedger`, `difference`, `sha`. **Both catalogues are complete before merge** (spec:2061); `sha` carries the ICU placeholder `{sha}` in both. **No box label is localised here** — a box's label comes from the `RegimeDefinition` and is filed text, not interface chrome, so translating it would put a different string on the screen than in the payload.

- [ ] **Step 5: The component test**

`apps/backoffice/test/tax-returns.test.tsx`, against a mocked `apiFetch` (0E's convention): the list renders one row per return; selecting a draft shows the `notGenerated` empty text in both grids; `Ctrl+G` calls `generateTaxReturn` exactly once and re-renders five boxes; a tie-out row with `difference: "0.0000"` carries tone `ok` and one with `"44.0000"` carries tone `warning`; a 422 `ERR_TAX_REGIME_MISMATCH` from generate renders a `ProblemAlert` and leaves the previous boxes on screen; and **no `t()` key used by the component is missing from either catalogue** — asserted by iterating the rendered keys against both JSON files, which is what stops an `ar` catalogue drifting behind `en`.

- [ ] **Step 6: The both-directions end-to-end pass (test 23 re-run), then commit**

`tests/e2e/tax-return.spec.ts` — Playwright against staging, **skipped when `STAGING_BASE_URL` is unset** (§3.7.1). One flow in each text direction (`en` LTR, `ar` RTL): open the screen, create a return for a whole quarter, press `Ctrl+G`, and assert the five box codes, both tie-out rows and a `difference` of `0.0000`; screenshot both. **The RTL pass asserts the numeric columns stay end-aligned and the box amounts are not mirrored** — a money figure is not bidirectional text, and reversing one is the classic RTL defect (spec:2377, test 23).

```bash
bun run --cwd apps/backoffice test -- tax-returns \
  && bun run --cwd packages/i18n test \
  && bun run typecheck && bun run lint \
  && STAGING_BASE_URL="$STAGING_BASE_URL" bun run --cwd tests test:e2e -- tax-return
```

```bash
git add apps/backoffice/src/lib/tax-api.ts apps/backoffice/src/lib/ar-ap-api.ts \
        apps/backoffice/src/routes/accounting/tax-returns.tsx apps/backoffice/src/router.tsx \
        apps/backoffice/src/components/app-shell.tsx apps/backoffice/test/tax-returns.test.tsx \
        packages/i18n/src/locales/en.json packages/i18n/src/locales/ar.json \
        tests/e2e/tax-return.spec.ts docs/owner/od-24/5a/
git commit -m "$(cat <<'EOF'
feat(backoffice): add the tax-return screen behind OD-24 [5A T12]

One column, because the operator's whole job is "do these figures agree with my working":
the boxes and the two-row reconciliation are read together and the tie-out is never
collapsible -- a non-zero difference scrolled past is the failure LEGACY-011 and LEGACY-059 are.
Ctrl+G generates and Ctrl+S does not, because generating writes a payload and stamps
generated_by. No file action: generated -> filed is 5B's under accounting.tax.file, and a
button the API refuses is worse than a missing one. Filters go through 4B's filterQuery,
which gains `export` and stays the one composer in this application.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Against the contracts card (§2.6's 5A row).** Every deliverable the card lists has a task. `packages/domain/src/tax/` with `TaxEngine` and `JurisdictionPack` — versioned regimes with rate-effective-date tables, every code declaring its regime, inclusive and exclusive bases, **one rounding function with a mode declared per tax code** (spec:2227–2228), and the wrong-regime refusal `ERR_TAX_REGIME_MISMATCH` (T5, T6); the four tables `app.tax_regime`, `app.tax_code`, `app.tax_transaction` — **one row per posted tax line, written by the posting service at step 11 and by nothing else** — and `app.tax_return` (T1, T2, T7); `document_line.tax_code_id`'s FK (T3) and the `document.tax_inclusive` header field (T2); the Malaysia pack **created here** under `packages/db/seed/my/tax/` with its `--only tax` loader, `accounting.tax.manage`, and the two §4.15 rows `2300` / `1350` set as the codes' `output_account_id` / `input_account_id` by the same task (T4, T6); return generation **from `tax_transaction` only**, byte-identical across runs, with `tests/golden/tax/` (T8, T9); and the return screen (T12). Migration range **0053–0056, all four used, four PRs**; ADR range **0049–0050**, both written as proposals per spec:95. **Target size 11–13 tasks: 13** (T0 carries no application code — the shape 2C, 3C, 3D and 4B all used).

**Two deviations from the card, both deliberate and both stated where they bite.**

1. **The card names the owner gate "OD-15", the assignment JSON that produced this file named "OD-12".** OD-12 is *"list of cashiers per branch"* and gates **6C**; it has nothing to do with tax. **The contracts document is the authority** and this plan follows the card: **OD-15 → Task 10**, **OD-24 → Task 12**, and no OD-12 task exists. If the JSON is later corrected, nothing in this plan moves.
2. **The card says OD-15's verification comes "before the return task"; this plan numbers it Task 10, after Task 8.** That is safe because **nothing in the return path depends on it**: §2.12's default — *abstract interface only* — is realised as `SYNTH-MY-v1`, a complete regime whose every literal is invented, and Tasks 8 and 9 are green against it. Task 10 appends a definition and changes no signature. **The Execution handoff says T10 depends only on T6 and may run before T8**, so a team that has the owner's material on day one loses nothing by the numbering.

**This plan is longer than the 2500–4000-line guidance — a little over 7,300 lines, and stated as a range because an exact figure drifts the moment a line is edited (it was recorded as "6,410" while `wc -l` read 7,286) — and the reason is recorded rather than hidden.** Six of the thirteen tasks carry a complete module or migration in full (0053's and 0054's DDL, `engine.ts` + `canonical.ts`, `jurisdiction.ts` + `malaysia.ts` + the loader, `compute.ts` + `posting/tax.ts`, `returns.ts` + the contracts + two route modules, and the screen), and hazard 35 requires the plan to repeat the code rather than gesture at it. The written peer plans in this folder run 5,400–8,400 lines for the same reason. **About 1,900 of those lines are Tasks 9–12 and the two sections below**, added in the finishing pass; nothing was padded, and the one placeholder in the file (`/* per ADR 0049 */`, T10 Step 5) is deliberate — hazard 2 forbids writing that literal before the ADR exists to copy it from.

**Eight things the finishing pass changed, all of which were in the file before it.** Three of them would have failed on first run and two of those were in the owned acceptance test.

1. **The golden fixture's credit note would have made the DoD test fail, and the fixture was the place it would have shown.** Test 26 needs `S2` to read `88.0000` while `account_balance` on `2300` reads `88.0000`; that holds only if `tax_transaction.tax` is **`-22.0000`** for the credit note. phase-4a:3845 settles it — a credit note carries **negated** line magnitudes and its policy carries the invoice's sides — so T9's `input.json` states `"amount": "-200.0000"` and the task spells out what a reviewer who "corrects" it to `200.0000` will see: `S2 = 132.0000`, ledger `88.0000`, and a `44.0000` difference. **Writing the figures out by hand is what found this**; a fixture generated and never read would have encoded whichever sign the code produced.
2. **A zero-rated sale looked unpostable, and the pack looked like it shipped a box nothing could fill — until 2A's evaluator was actually read.** `tax_code_account_for_kind_check` (T1) and the T6 loader put an account id on `kind = 'output'` and `kind = 'input'` **only**, so `SYN-OUT-ZERO` and `SYN-EXEMPT` have `output_account_id` null — correctly, since a zero-rated supply has no tax account. T8's `each_tax` rule resolves `{ from: "tax_code.output_account" }`, and §4.4.1's *"never a silent null account"* makes a null resolution an `ERR_POLICY_REQUIRES_MISSING`. **The order 2A actually ships saves it**: `taxLines.push({ … })`, then `if (g.amount.isZero()) continue;`, then `resolveAccount` (phase-2a:1843–1855) — the zero group never reaches the account, and its `PlannedTaxLine` is pushed anyway, which is what feeds box `S3`. **Amendment A11 is therefore "recorded, not changed", the shape A8 has**: §4.4.2 does not *state* that ordering, 5A is the first slice whose correctness depends on it totally, and writing it down is what stops a later refactor of `evaluate.ts` reordering two lines and silently refusing every zero-rated document. **No slice's code changes.** Three of the five golden documents rest on those two lines, and the plan says so out loud rather than leaving a reader to discover it from a failing fixture.
3. **`TaxGoldenExpectation.boxes` was `ReturnBox[]`, whose `amount` is a `Money` and is not JSON**, so A10's registered shape could not be written to disk. `GoldenBox` is `ReturnBox` with `amount` as a 4-dp string and the harness re-wraps with `Money.of`; A10's row now says so.
4. **The File Structure gave each golden case a `policies.json`, copying 3B's layout for a harness that is not 3B's.** 3B's driver is a pure `evaluatePolicy` call and its cases must carry the policy; this harness posts through `taxFixture`, which reads the four 4A envelopes off disk through `seedTypeFromPack` — a second copy in the fixture directory would be two spellings of one thing. The file is gone, A10 records why, and T9's first case asserts the directory holds exactly two files so nobody re-adds it.
5. **T8's Produces block declared `export const TaxCodeDto: z.infer<…>` and `export const TaxReturnDto: z.infer<…>`** — `z.infer` is a type and `const` does not compile. Step 4's actual code was already correct (`export type`); the summary is now too, which matters because **T12 does `import type { TaxCodeDto, TaxReturnDto }`** and a reviewer reading only the Produces block would have written the wrong declaration.
6. **T9's wrong-regime case never used a wrong-regime code, in the task that owns test 26's second clause.** Both of its `postTaxedDocument` calls passed `taxCode: null` while the comment claimed a foreign code was being posted, so *"a tax code from the wrong regime causes a refusal, not a wrong number"* (spec:2444) was asserted nowhere at document level. The case now posts one `SALES_INVOICE` whose two lines carry codes from two regimes and asserts `resolveRegimeFor`'s refusal reaching through `computeDocumentTax`, asserts that **nothing was written**, keeps the unknown-definition refusal as the second half of the same code, and ends by posting each code on its **own** document so the test cannot pass by `OTHER-OUT` being broken. Its `update app.tax_code set output_account_id` is gone too: `seedTaxCode` already resolves `2300` for an `output` code, and the fix-up would have let the refusal come from a null account instead of from the regime.
7. **T8 Step 7 promised a route assertion that cannot be provoked, and this plan's own T9 comment said why.** *"`422` on a generate whose period holds a foreign regime's transactions"* — but `transactionsFor` binds `t.regime_id = ${row.regimeId}`, so a foreign row is never selected, and a mixed-regime document never posts. The sentence is now the reachable refusal (a regime the pack has no definition for, amendment A3) with the unreachable neighbour named beside it.
8. **Global Constraint 15 named a rate the pack does not ship** (`0.04500000`) and Global Constraint 6 promised "the two places a sign *is* read". The first is now `0.11000000` and `0.00000000`, matching `SYNTH-MY-v1.codes.json` exactly. The second is now "the two places a signed magnitude **flows through**", because the honest count of places this slice *reads* a sign to decide anything is **zero** — see the A9 paragraph below.

**Fourteen things a review pass changed after the finishing pass, every one of which would have failed on first run or first `typecheck`.** Seven were blockers.

1. **Migration 0054's `generated_by` key could not be applied.** It was written as the table-level composite `foreign key (tenant_id, generated_by) references app.principal(id)` — two referencing columns against a one-column reference, which PostgreSQL refuses at DDL time ("number of referencing and referenced columns for foreign key disagree"), so 0054 never applied and Tasks 2 onward were unexecutable. `app.principal` is **global** (plan0A:988-998) and carries no `unique (tenant_id, id)`; every earlier slice writes the single-column inline form (plan0A:1474 `closed_by`, plan0A:1794 `posted_by`, 4A's `unallocated_by`, 4B's `unmatched_by`) and this one now does too, with a T2 assertion on `pg_get_constraintdef` so the shape is pinned rather than remembered.
2. **`postTaxedDocument` called 4B's `postFromPack` with an option set that does not exist.** It passed `typeCode:` (the frozen member is `code:`, phase-4b:1859) and `approval: packApproval(...)` (there is no `approval` member — `postFromPack` derives the path itself, phase-4b:1943, which is the *point* of that helper), and it returned the call directly while `postFromPack` returns `{ documentId, result }` and the helper declares `{ documentId, number }`. Three separate type errors in one call; every T7/T8/T9 test is built on the helper. Fixed at the one mapping site, `packApproval` dropped from the import and from both consumer lists.
3. **Nothing wrote `document_line.tax_code_id` in any test.** Every taxed line reaches the database through 3C's `draftTypedDocument`, whose `DraftLine` has no `taxCodeId` and whose insert omits the column (phase-3c:384-402, 444-453) — so the code was an excess property at compile time and a dropped value at run time: no line carried a code, `computeDocumentTax` wrote zeros, `plan.taxLines` was empty, and every box in the owned acceptance test read `0.0000`. **Amendment A12** adds the member and the column additively in Task 3, in the same PR as the foreign key and for §4.3.4's own reason; Task 3 proves it with a round-trip case. The five direct `draftTypedDocument` calls also gained the **required** `series` member they were missing.
4. **`taxFixture` never put `4000` in `f.accounts`, and `postTaxedDocument` defaults every line to it.** The loop seeded ten codes and `4000` was not among them, so the lookup was `undefined` at run time behind a `!`, every default line inserted `account_id = null`, and `SALES_INVOICE`'s `each_line` revenue rule resolved nothing. `4000` and `1000` are `seedTenant`'s own rows and their ids are already on the `Seed` as `s.sales` and `s.cash` (plan0A:1592-1594), so they are **mapped, not re-seeded** — `app.account` carries `unique (company_id, code)` and a second `seedAccount` would conflict. The "Twelve accounts" comment is now true.
5. **T6's box test asserted figures the implementation cannot produce.** `buildReturnFrom` sums `baseBase`/`taxBase` — a return is filed in base currency — and the five `txn({…})` calls overrode only `base`/`tax`, leaving the 300/33 defaults in the columns the boxes actually read. The TDD loop could not close, and the obvious "fix" (summing `base`/`tax`) is wrong. Every override now sets both pairs, and a **new** case gives them different values so the two are told apart.
6. **The tax-pack schema's `code` pattern rejected the only regime the slice ships.** `^[A-Z][A-Z0-9-]{1,31}$` excludes the lower-case `v` of `SYNTH-MY-v1`, so the loader would have thrown on its own pack and every T7/T8/T9 fixture with it. The regime pattern is now `^[A-Z][A-Za-z0-9-]{1,31}$` (the tax-**code** pattern stays all-caps), `CreateTaxReturnBody.regimeCode` carries the identical regex for the identical reason, `tax-pack.schema.json` is written out in full instead of described, and `validateTaxPack` — named in prose but defined nowhere — is a real function in `packages/domain/src/tax/pack-schema.ts` with its Ajv wiring copied from 1A's (phase-1a:1760-1762) and its call placed **inside** `taxLoader.load` with two tests on it.
7. **`insertTaxTransactions` read `regimeId` off a `TaxCodeRef`, which has none.** `snapshot.refs.taxCodes` is `Record<string, TaxCodeRef>` (§4.4.2:2415) and `TaxCodeRef` is `{ id; code; rate; kind; roundingMode; outputAccountId; inputAccountId }` — `TaxCodeDef` is a superset, so the objects go *in* unconverted, but a value read *out* is statically a `TaxCodeRef` and `code.regimeId` is `TS2339`. **Widening `TaxCodeRef` was rejected**: it is a frozen §4.4.2 shape and 2A's own evaluator tests build literal `refs.taxCodes` entries (phase-2a:1380) that a new required member would break. The regime now comes from `resolveRegimeFor`, which is already this slice's function and which re-asserts the single-regime invariant at post time as well as at compute time.
8. **T1's negative-rate case called `seedTaxCode` before the accounts its `output` default needs existed.** `beforeAll` seeded only `seedTenantV2`, and `2300` was created in the *next* `it`; Vitest runs `it` blocks in file order, so the call violated `tax_code_account_for_kind_check` and the test died before reaching the assertion it exists for. The two §4.15 accounts move to `beforeAll` (T2's equivalent already got this right), the case uses a distinct code so the SYN- list below it stays exact, and that list is now filtered `code like 'SYN-%'`.
9. **`sha256(payload::bytea)` is not valid PostgreSQL.** There is no cast from `text` to `bytea`; the generate path would have errored on its first write and test 26's byte-identity assertions would never have run. Both the service and the test now use `convert_to(…, 'UTF8')`, which also names the encoding the pinned `df0b4de2…` sha is the sha of — a real distinction given the pack's Arabic labels. (T2's `sha256(''::bytea)` is untouched and correct: `''` is an untyped literal, not a cast.)
10. **`assertRegime` refused every code effective after an OPEN regime's first day.** `const from = regime.effectiveTo ?? regime.effectiveFrom` collapses an open-ended regime's window to its start, so `SYNTH-MY-v1` — whose `effective_to` is null — could never carry a second rate, which contradicts §2.6's "versioned regimes with rate-effective-date tables", makes 0053's `unique (company_id, code, effective_from)` pointless, and makes **T11 Step 1 unreachable**: it posts a `SYN-OUT-STD-2` effective 2026-02-01. The upper bound is now open when `effectiveTo` is null, the "late" case uses a *closed* regime so it still refuses, a new case proves a mid-regime code is **accepted**, and the message prints the bound it actually compared against.
11. **`ensureOpenPeriods` was imported from a file that does not exist.** 3B ships it in `tests/invariants/support/post-inventory.ts` (§4.17.1's row; `tests/regression/support/costing.ts` is a different file in a different directory), so `support/tax.ts` — the entry point of every T7/T8/T9 test — could not resolve. The import and Task 0's `need_repo` line both name the real path.
12. **Four things were prose where the skill requires code** (hazard 35). `apps/api/src/routes/accounting/tax-returns.ts` — four handlers, cursor paging, the 404-over-403 rule and idempotency — was one paragraph; `toTaxCodeDto` was named and never written; both route test files were a sentence listing nine assertions; `tax-pack.schema.json` was a prose description. All four are now code. Writing the create handler out is also what surfaced two gaps it needed: `findRegime` (added to T8's Produces) and `TaxReturnDetail.currency`, whose declared member had **no source** — `getTaxReturn` and `generateTaxReturn` now return it, and `taxReturnTieOut` takes it from there instead of running a second `company` read.
13. **`transactionsFor` labelled the document-currency figures with the base currency**, which reviewer check 6 recorded rather than fixed. It is now fixed at its source: the query selects `d.currency as document_currency` and `base`/`tax` are branded with it. No figure in this slice moves — every box reads `baseBase`/`taxBase` — but the first tenant that codes tax on a foreign-currency invoice no longer gets a `Money` claiming a currency it is not in.
14. **Three counts and two comments disagreed with the file.** Task 0's Interfaces block said "ten register rows" above eleven; `malaysia.ts`'s header named `0.04500000`, a rate the pack does not ship (Global Constraint 15 had already been corrected and the comment was not); `taxFileNames` took a `version` it never read while its comment claimed the name carried it — the parameter is gone and the docstring now says what is actually true, that a regime's version rides in its **code** (`SYNTH-MY-v1`) and the code alone must be unique per pack.

**Six things an independent audit pass changed after the review pass. One was a register gap, one a `typecheck` failure, and four were lists that had fallen behind the tasks below them.**

1. **Two shared surfaces were extended without being registered, in a plan whose own Task 0 exists to stop exactly that.** T7 adds `taxInclusive?` and `computeTax?` to 4B's `PostFromPackOptions` and a block to `postFromPack`'s body; T2 adds `taxInclusive` to 1A's `DocumentSchema`. Both are the same class of edit as A12's to 3C's `DraftLine` — additive, optional where the column allows it, no signature changed — and A12 was registered while these two were only disclosed in a ⚠️ note. **Amendment A13** now registers both, with **two** grep literals (a bare `taxInclusive: z.boolean()` is a prefix of A7's `…optional()` and would pass vacuously, so the second literal names the schema), Task 0's counts move to thirteen amendments and fourteen `ok (contracts)` lines, and Global Constraint 13 is applied to all four cross-slice files this plan opens rather than to the two that were noticed first. The concrete cost of leaving it: **6A owns the next re-run of test 15** and posts taxed `POS_TICKET`s through that same helper — a 6A writer who reads §4.17.1 and does not find `computeTax` writes a second posting helper, which is hazard 9.
2. **`packages/db/src/tax/index.ts` was created with no exports while `packages/db/src/index.ts` re-exported it.** A `.ts` file holding only comments is a global script, not a module, so `export * from "./tax"` is **TS2306** and Task 5 Step 6's `bun run typecheck` could not go green at the step that claims the loop closes. The stub is now `export {};` with the reason on the line, and T7 Step 8 says it **replaces** that line rather than joining it.
3. **Three Files lists were behind their own steps.** T2's list named neither `apps/api/src/routes/accounting/documents.ts` (which its Step 5 edits and its `git add` stages) nor the `DocumentSchema` member; T7's named neither `tests/invariants/support/ar-ap.ts` nor `packages/db/src/posting/index.ts`, both of which its steps write and its `git add` stages. All are listed now, each with what it gains.
4. **The File Structure section was missing two edited files and misattributed a third.** `apps/api/src/routes/accounting/documents.ts` appeared nowhere despite being edited by two tasks, `tests/invariants/support/ar-ap.ts` and `packages/db/src/posting/index.ts` were absent, and `packages/db/src/posting/errors.ts` was tagged **T7** when T5's Files list and T5's `git add` both own it (A4 lands with the `ERRORS` row, not with the writer). Fixed at all four rows.
5. **Task 0's intro undercounted its own gate.** It said "eight names this plan imports from 4A, 4B, 3B, 2A and 1A" above nine `need_repo` lines, and its slice list omitted 3C, whose `draftTypedDocument` the script checks. Step 3 and the commit body had it right; the intro now matches them.
6. **`TaxedLine` was exported by `support/tax.ts` and named in the File Structure and the Self-Review, but was not in A9's registered list.** It is the line shape `postTaxedDocument` takes, so a consumer cannot type a line array without it. A9, the Assumptions block, the File Structure and this section now name the same **six** exports.

**Not changed, and why.** The orchestrator's slice JSON gives 5A's owner gates as `["OD-12","OD-24"]`. **OD-12 is "list of cashiers per branch" and gates 6C** (contracts §2.12); §2.6's 5A card gives **OD-15** and OD-24, and the contracts document is the authority. Nothing in this plan moves — deviation 1 above already recorded it — but **the catalogue generator that produced that JSON has a transcription fault worth checking against the other slices.**

**Contract additions — every name invented because the registers lacked one.** All **thirteen** register amendments land in Task 0; nothing below is a literal in a registered namespace except the two Task 0 amends explicitly (`2300`, `1350`, already §4.15 rows assigned to this slice).

- `packages/domain/src/tax/engine.ts` — `TaxRegime`, `TaxCodeDef`, `TaxLineInput`, `TaxLineResult`, `TaxEngine` (all five §4.9.1 verbatim), plus **`taxEngine`** (the const the interface had no name for), **`TaxError`** (the engine's one error class — `packages/domain` may not import `AppError`, §3.1) and **`producesNoTax`** (the `exempt`/`zero`/`out_of_scope` predicate the return's box rules need; two spellings of it would put one sale in two boxes).
- `packages/domain/src/tax/canonical.ts` — **`canonicalJson`**, the one canonicaliser; §4.9.3's `hash: sha256 of the canonical payload` is this function, so 5B imports it rather than writing a second.
- `packages/domain/src/tax/jurisdiction.ts` — `ReturnBox`, `JurisdictionPack` (§4.9.1), plus **`ReturnBoxDef`** (a box's rule as data rather than as TypeScript — a box whose rule is in code is LEGACY-020's literal in a different coat), **`RegimeDefinition`** (amendment A3) and **`TaxTransactionRow`** (amendment A5 — §4 left the shape open as 5A's own), and the module-internal **`buildReturnFrom`** / **`validateReturnAgainst`** that a second jurisdiction would call with its own definitions.
- `packages/domain/src/tax/malaysia.ts` — **`SYNTH_MY_V1`**, **`MALAYSIA_REGIMES`**, `malaysiaPack` (§4.9.1), and behind OD-15 **`MY_VERIFIED_V1`** (T10, dropped with that task).
- `packages/domain/tax-pack.schema.json` — **`urn:dulja:tax-pack:1`**, the seed envelope; its `rate` pattern `^\d+\.\d{8}$` is what stops `"11"` or `"11%"` becoming an 1100 % tax, and its `$defs/regimeCode` pattern `^[A-Z][A-Za-z0-9-]{1,31}$` is the one `CreateTaxReturnBody.regimeCode` repeats — an all-caps pattern would reject `SYNTH-MY-v1`, the only regime that ships.
- `packages/domain/src/tax/pack-schema.ts` — **`validateTaxPack`** and **`TaxPackValidation`**, the Ajv wiring for that schema, in the shape 1A gave `validateDocumentTypeSeed` (phase-1a:1760-1762) so `taxLoader`'s `SeedError` and the CLI's exit code are unchanged.
- `packages/db/src/tax/codes.ts` — **`TaxCodeRow`**, **`TaxCodeCursor`**, **`loadTaxCodeRefs`**, **`resolveRegimeFor`**, **`listTaxCodes`**, **`createTaxCode`**, **`archiveTaxCode`**.
- `packages/db/src/tax/compute.ts` — **`resolveInclusive`** (the ONE resolution of §4.4.1's `tax.inclusive`, exported so a reviewer sees one rule and not two), **`ComputedTaxLine`**, **`computeDocumentTax`**.
- `packages/db/src/tax/returns.ts` — **`TaxReturnRow`**, **`TaxReturnCursor`**, **`createTaxReturn`**, **`listTaxReturns`**, **`findRegime`** (the `regimeCode` + `regimeVersion` → id lookup the create route needs to answer 404 rather than 422), **`getTaxReturn`**, **`generateTaxReturn`** (both returning `{ row, boxes, currency }` — `currency` is `TaxReturnDetail`'s one member with no other source, and the route must not run its own SQL), **`TaxReturnTieOutRow`**, **`taxReturnTieOut`**, and the private `SELECT_RETURN` / `toRow` / `transactionsFor`.
- `packages/db/src/tax/index.ts` — the barrel `packages/db/src/index.ts` re-exports.
- `packages/db/src/posting/tax.ts` — **`insertTaxTransactions`**, the one writer of `app.tax_transaction`. `packages/db/src/posting/errors.ts` — **one member added** to `PostingErrorCode`, `"ERR_TAX_REGIME_MISMATCH"` (amendment A4), and nothing else in that file.
- `packages/db/src/seed/tax.ts` — **`TaxRegimeManifest`**, **`TaxCodeManifest`**, **`taxFileNames`**, **`taxLoader`**; and the four `SubPack` edits of amendment A6 (`SubPack`, `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES`, `OWNED_ELSEWHERE`).
- `packages/contracts/src/accounting/tax.ts` — `TaxCodeKindSchema`, `RoundingModeSchema`, `TaxCodeSchema`, **`TaxCodeDto`**, `CreateTaxCodeBody`, `TaxCodeQuery`, `TaxCodeList`, `ReturnBoxSchema`, `TaxReturnStatusSchema`, `TaxReturnSchema`, **`TaxReturnDto`**, `CreateTaxReturnBody`, `TaxReturnQuery`, `TaxReturnList`, `TaxReturnTieOutRowSchema`, `TaxReturnDetail`, and the file-local `Amount` (§4.2.8's registered practice, 4B amendment 12's precedent). `packages/contracts/src/errors.ts` — **one `ERRORS` row**, `ERR_TAX_REGIME_MISMATCH` (422), §4.2.4's row already allocated to 5A. `packages/contracts/src/accounting/document.ts` is **1A's** file and gains three members across two tasks, each registered: `DocumentLineInput.taxCodeId` and `CreateDocumentBody.taxInclusive` (A7, T3 and T2) and **`DocumentSchema.taxInclusive` (A13b, T2)** — the read twin, not optional, because the column is `not null default false`.
- `apps/api/src/routes/accounting/tax-codes.ts` — **`TAX_PERMISSION`**, `taxCodeRoutes`, `taxCodeRouteModule`, the private `toTaxCodeDto`; `tax-returns.ts` — `taxReturnRoutes`, `taxReturnRouteModule`, the private `toTaxReturnDto`.
- `packages/db/test/fixtures.ts` — **`seedTaxCode`**, the one §4.17 row this slice owns (T1); and **amendment A12's two additions to 3C's helper** — `DraftLine.taxCodeId?: string` and `tax_code_id` in `draftTypedDocument`'s insert (T3, in the same PR as the foreign key). Two tasks open the file, neither touches the other's lines, and nothing else in it changes.
- Test tier: **`tests/invariants/support/tax.ts`** (§4.17.1, amendment A9) with **`TAX_PACK_ROOT`**, **`seedTaxPack`**, **`TaxFixture`**, **`taxFixture`**, **`TaxedLine`**, **`postTaxedDocument`**; `tests/golden/tax.test.ts`'s **`GoldenBox`**, **`GoldenLine`**, **`GoldenDocument`**, **`GoldenCase`**, **`TaxGoldenExpectation`** (amendment A10) and the file-local `readCase` / `runGoldenCase` / `CASES`; `tests/invariants/phase-5a-pinned.test.ts` (exports nothing — a file of equalities). ⚠️ **4B's `tests/invariants/support/ar-ap.ts` gains two `PostFromPackOptions` members** (`taxInclusive?`, `computeTax?`) and one block in `postFromPack`'s body — additive, optional, defaulted to `false`, 4B's own callers unaffected — **registered as amendment A13a** rather than made silently, because that file is 4B's §4.17.1 row and 6A posts taxed `POS_TICKET`s through the same helper. Task 0's gate is what proves the helper exists to be extended.
- ⚠️ Backoffice (OD-24, dropped with Task 12): `apps/backoffice/src/lib/tax-api.ts` — **`ReturnBoxJson`**, **`TieOutRow`**, **`TaxReturnListResponse`**, **`TaxReturnDetailResponse`**, `fetchTaxReturns`, `fetchTaxReturn`, `createTaxReturn`, `generateTaxReturn`, `fetchTaxCodes`; `src/routes/accounting/tax-returns.tsx` exports its TanStack `Route` and keeps `regimeOptions`, `boxRows`, `tieRows` file-local. **`ar-ap-api.ts`'s `filterQuery` gains `export` and stays the one composer** — this slice writes no second one.
- Documents and scripts: `docs/adr/0049-verified-lhdn-return-format.md`, `docs/adr/0050-tax-computation-at-persist-time.md`, `docs/decisions/od-15-5a-return-format.md`, `docs/runbooks/tax-return.md`, `docs/owner/od-24/5a/`, `scripts/check/contracts-5a-amendments.sh`, `packages/db/seed/my/tax/README.md`.

**Against the never/always lists.** Four tables are created and every one carries `tenant_id`, `FORCE ROW LEVEL SECURITY`, a policy named exactly `tenant_isolation`, `created_at`, composite `(tenant_id, x)` foreign keys, `uuidv7` ids, snake_case singular names, a hand-written down file and a two-tenant test **in its own task**. `attach_audit` on three of them and `AUDIT_EXEMPT` + `IMMUTABLE` on `tax_transaction` — §3.5.3's exact state, edited once, in T2 only. Every endpoint has a Zod schema, an OpenAPI entry regenerated **in the same commit**, `IdempotencyHeader` on every unsafe method and a probe on each of the two new modules. No `ledger_entry`, movement, layer, `account_balance`, `stock_on_hand` or `tax_transaction` write happens outside `posting/` and `costing/` — `packages/db/src/tax/returns.ts` **reads** `tax_transaction` and `packages/db/src/posting/tax.ts` is its one writer, which is the mechanical half of hazard 22 and the first time that particular table name binds anything. No `number` holds money or a rate; every rate is an 8-dp string and every tie-out sums through `Money.add` or SQL `sum(...)::text`. No `sql.unsafe`, no string-concatenated SQL, no DDL from application code, no disabled invariant, no enum label added (three new vocabularies, all `text` + a named CHECK). Every commit message carries the trailer.

**Against §4.4.2's A9.** **No line of this slice reads a sign to choose a ledger direction, an account or a box.** The ledger legs are planned by 2A's evaluator from `document_line`, and A9's normalisation is what turns a credit note's negated magnitudes into the opposite sides — this slice writes no `PlannedLedgerLine` at all. The **two places a signed magnitude flows through**, both over `tax_transaction.tax`: (1) `insertTaxTransactions` writes `PlannedTaxLine.amount` **unchanged** into the column, A9's one registered exception, because a credit note's tax is genuinely negative tax and there is no `side` member for a sign to move into; (2) `buildReturnFrom` **adds** `taxBase` and `baseBase` into their boxes, where a negative figure is a subtraction with no branch, no `isNegative()` and no map. `taxReturnTieOut`'s orientation comes from `app.account.type` (`liability` → credit − debit, otherwise debit − credit) and **not** from any amount's sign, which is exactly 4B's second-pass finding avoided at its source: a hand-written per-account sign map is how a tie-out passes for assets and fails for liabilities.

**Against the hazards.** **1**: no statutory rate, threshold, ceiling or formula anywhere — the shipped regime is `SYNTH-MY-v1`, its rates are `0.11000000` and `0.00000000`, every seed row carries `"source": "SYNTHETIC-TEST-v1 — not a published figure (OD-15)"`, `tax_regime.source` is `not null` (amendment A2), and T10's provenance guard **fails the build** if a non-synthetic `source` ever ships without an accepted ADR 0049. **2**: no LHDN or MyInvois endpoint, field, schema version, threshold or deadline appears — including inside Task 10, whose own text says "the format the authority currently publishes" and nothing more; `/* per ADR 0049 */` is the only place a literal would go and it stays a comment until the ADR exists. **4**: this slice ships **no `ReportCode`** and does not widen `ReportCodeSchema` — hazard 4's minimal set (spec:2300) names no Phase 5 report, `accounting.tax_return_view` is 7C's, and the filed return is a `tax_return` row served by this slice's own module (amendment A8 records it so a later reader does not go looking). **5**: T10 and T12 are both the owner-account pattern with an exact verify command and a stated local equivalent. **6**: OD-15 and OD-24 are one isolated task each, both droppable without renumbering a neighbour's interface. **8** and **9**: every 0A helper is cited by its exact name; `fixtures.ts` gains exactly the one §4.17 row plus A12's additive member; §4.17.1 gains one registered file (A9) **and one recorded additive edit to 4B's** (A13a). **Every file this slice opens that another slice owns is registered before it is opened** — 3C's `DraftLine` (A12), 4B's `PostFromPackOptions` (A13a), 1A's `CreateDocumentBody` (A7) and 1A's `DocumentSchema` (A13b) — which is Global Constraint 13 applied to all four rather than to the two that happened to be noticed first. **10**: no per-tenant row is written by a migration — the regime, the codes and the four policy upserts are all seed-pack data applied by `bun run seed --tenant`; only `app.permission` (global) is migration data, in 0056. **11**: no enum label. **13**: `lint-schema.ts` is edited **once**, in T2, to exactly §3.5.3's state. **14**: all four allocated migration numbers are used and none is borrowed; no plan step asserts `max(version)`. **15**: root `tests/` and every service use the production `withTenant`; only `packages/db/test` uses the 4-argument one. **20**: this slice enqueues no job and adds no `JOBS` name — `accounting.tax.submit` is 5B's. **21**: `sql.unsafe` appears nowhere in this slice and T11 Step 3 asserts it. **22** and **23**: see the never-list paragraph; `toBase` stays `HALF_AWAY_FROM_ZERO` at scale 4 and is the only place a rate applies to a base amount. **24**: no handler inserts a `document_event`. **25**: the DELETE list is unchanged and T11 Step 5 asserts the four new tables are absent from it. **26**: one code, from the register; `accounting.tax.file` is 5B's and is not seeded here. **29**: T12 begins with OD-24, states its one keyboard addition and its one deliberate omission so a reviewer can compare them to the owner's material, and invents no workflow. **31**: two route modules, two `PROBES` keys, asserted as a bijection in T11 Step 5. **32** and **33**: every literal comes from a register; `2300` and `1350` are this slice's own §4.15 rows and are seeded by the task that seeds the codes referencing them, so the rule is satisfied at its source rather than at the policy; the eleven accounts this slice only consumes are resolved and never re-seeded. **34**: the four edited seed files stay envelopes with `module` outside `policy`, at `policyVersion: 2`. **35**: every task has exact paths, real code, a failing test first and a commit.

**Six things a reviewer should check that this plan cannot prove on its own.**

1. **The `each_tax` group's account resolution order (amendment A11).** Three of the five golden documents post only if a zero-amount `each_tax` group is dropped **before** its `accountRef` is resolved. 2A's written body does exactly that (phase-2a:1843–1855) and A11 only records it — but this plan read 2A's *plan*, not the merged file. **Re-check the merged `packages/domain/src/posting/evaluate.ts` before Task 7.** If the two lines have been reordered, the finding is in `evaluate.ts` and the fix is there under §4.18 — not a fourth account code here, and not an `accountCode` on `SYN-OUT-ZERO` (the loader and `tax_code_account_for_kind_check` would both ignore it).
2. **4A's `SALES_INVOICE` AR leg.** T8 Step 6 assumes 4A debits `party.receivable_account` with `line.total_incl_tax` (spec:2009–2028's worked example). If 4A debited `line.amount`, the invoice will not balance once tax exists and the fix is one word **in 4A's file**, recorded in T8's commit body rather than worked around here.
3. **Whether 4B's `postFromPack` still has the shape T7 Step 1's diff is written against.** This plan reads 4B's *plan* — `PostFromPackOptions.code`, the internally-derived `packApproval`, the `{ documentId, result }` return and the `rateSource` `UPDATE` the `taxInclusive` one is modelled on (phase-4b:1859, 1943, 1955) — and adds two members to that interface **under amendment A13a**. **Re-read the merged `tests/invariants/support/ar-ap.ts` before Task 7.** If a member was renamed, correct *this* plan's mapping in `postTaxedDocument`; never write a third posting helper (§4.18, hazard 9). The same applies to the order of the new block: `taxInclusive`'s `UPDATE` must precede `computeTax`, and `computeTax` must precede the first `transitionDocument`, or the `synth-my-inclusive` golden case computes exclusive tax on a gross figure.
4. **1B's `postJournal` signature.** T11's legacy-058 block calls it to post the "manual voucher" half of the defect. The assertion does not depend on the helper's shape, only on there being a posted JOURNAL — correct the call, never add a journal helper here.
5. **Whether `CreateDocumentBody` accepts lines at create.** Task 0's first informational probe answers it and it decides whether T7 Step 8 hooks `computeDocumentTax` in one handler or two. A document created with lines and never re-saved would otherwise carry `tax_amount = 0` into the ledger, and every box would be short by that document.
6. **`filterQuery`'s home once 4B is merged.** T12 imports it from `apps/backoffice/src/lib/ar-ap-api.ts` and adds one `export` keyword. If 4B renamed it, or if `ar-ap-api.ts` was dropped with 4B's own OD-24 task, **the composer must be moved to a shared module and both screens import it** — two definitions of §4.2.8's grammar in one application is hazard 9, and it is the executor's stop-and-raise before `tax-api.ts` is written.

**Deliberately not in this slice.** No `EInvoiceTransmitter`, no `app.einvoice_transmission`, no `accounting.tax.file`, no `accounting.tax.submit` job and no MyInvois detail of any kind — all 5B's, behind OD-15's second half and ADR 0051. No `generated → filed` transition and no write to `tax_return.filed_at` or `attachment_id`: the columns exist (0054) so 5B adds no migration, and this slice never sets them. No `ReportDefinition`, no `ReportCode`, no `DatasetId` member and no `packages/db/seed/my/reports/5a/` directory — 7A builds the engine and 7C ships `accounting.tax_return_view` over `tax_transaction`, which is already in 7A's ≤ 0058 dataset set. No second jurisdiction pack: `malaysiaPack` is the only v1 pack (D21) and a GCC pack is deferred until a customer there exists. No document-type code of this slice's own, not even a test-only one — every type its tests configure is a 4A envelope read off disk. No `tax_code` mutation path beyond create and archive: a rate change is a **new code at a new `effective_from`**, which is what makes January's return unmovable after February's rate lands (T11 Step 1 proves it). No per-line tax override and no client-supplied `tax_amount`: the column is server-computed at persist time or it is `0.0000`.

---

## Execution handoff

**Read before starting.** This plan's Assumptions block, all of §3 of the contracts document, **§4.9 in full**, §4.3.2's fixed algorithm (steps 6, 8, 10, 11, 12), §4.4.1's `tax` block and `each_tax` rule, and **§4.4.2's sign-normalisation section including its one exception**. Then Task 0 in full: it is a gate, not a formality, and **Task 1 does not start until `bash scripts/check/contracts-5a-amendments.sh` exits 0**. Its three informational blocks change what Tasks 7 and 8 do — read them rather than skimming past them; the third one prints the actual step-11 landing site in `post.ts` as that file stands after 3B, 4A and 4B, which is not the same as §4.3.2's numbering.

**Order and independence.** **T0 → T1 → T2 → T3** are strictly sequential (each migration builds on the last; 0055's FK needs 0053's table). **T4** needs only T1 (its chart rows are what T6's loader resolves) and may run in parallel with T2/T3. **T5 → T6** are the pure half and need no migration at all — **they may run in parallel with T1–T4 by a second engineer**, and only T6's *test* needs T1's tables. **T7 needs T2, T5 and T6.** **T8 needs T7.** **T9 needs T8** and is where the DoD becomes true. **T10 needs only T6** — its provenance guard reads `MALAYSIA_REGIMES` and the seed directory and nothing else — **so it may run any time after T6 and before T8**, which is what satisfies §2.6's "before the return task" when the owner's material is already in hand. **T11 needs T8** (its regression blocks generate returns) and **T12 is gated on OD-24 and blocks nothing.**

**One migration per PR (spec:2057).** Four migrations, four PRs: T1 (0053), T2 (0054), T3 (0055), T4 (0056). Nothing else in the plan adds DDL. Tasks 5–12 may be grouped by whatever review cadence the team runs, but a task is never split across PRs — its failing test and its implementation land together.

**Two ADRs are written as proposals and must be accepted before their implementation merges** (spec:95): **0050** (T1, T5, T7 — one tax computation at persist time, and `tax_regime.source` as the provenance column) and **0049** (T10 — and 0049 stays `proposed` indefinitely if OD-15 never lands, which blocks only T10 Steps 4–6). A still-`proposed` ADR blocks its own tasks' merge, not the plan.

**Where to stop and raise rather than working around.**

- **A `MISSING (repo):` line from Task 0's gate.** That is a reconciliation with 1A, 2A, 3B, 4A or 4B, and **the owning plan is the authority for what it exports** (§4.18). Correct *this* plan's import path or name; never add a second spelling.
- **A zero-rated document refusing with `ERR_POLICY_REQUIRES_MISSING` naming an account.** A11 records that 2A's `each_tax` path drops a zero group **before** resolving its `accountRef` (phase-2a:1843–1855); a refusal means the merged `evaluate.ts` no longer does. **That is a 2A reconciliation and it is fixed in `packages/domain/src/posting/evaluate.ts` under §4.18, not here.** Do **not** give `SYN-OUT-ZERO` or `SYN-EXEMPT` an `accountCode` — the loader writes `output_account_id` for `kind = 'output'` only and `tax_code_account_for_kind_check` makes that deliberate, so the seed edit would change nothing and hide the real question.
- **`ERR_LEDGER_UNBALANCED` from a taxed `SALES_INVOICE`.** 4A's AR leg is debiting `line.amount` rather than `line.total_incl_tax`. That is a 4A fix (Self-Review item 2), not a compensating rule here — a second AR line for the tax would put the tax on the invoice twice the day 4A is corrected.
- **The golden `payloadSha256` differing from `df0b4de2ec7fc20f1f1fb045447792279cdbc12d2fa7ae7446d0034ee6cdc438`.** Never edit the sha. Diff the generated `payload` against T9 Step 5's block; the byte that moved names the fault — a label typo in `SYNTH_MY_V1`, a box out of definition order, a `currency` that is not the company's `base_currency`, or a figure that came out wrong.
- **A non-zero `difference` in the tie-out.** Read the credit note first (Self-Review item 1): a positive `tax_transaction.tax` on a `SALES_CREDIT_NOTE` produces exactly this, and the amount of the difference is twice the credit note's tax. If the credit note is right, the next suspect is `taxReturnTieOut`'s orientation — it must come from `app.account.type` and never from a per-account map.
- **`posting-only-tables` firing on `packages/db/src/tax/returns.ts`.** That file **reads** `app.tax_transaction`; the rule matches `insert`, `update`, `delete` and `merge` only. If it fires on a `select`, the rule's pattern has drifted and *that* is the finding. Never add a suppression, and never move the read into `posting/`.
- **Any proposal to let a client send `tax_amount` or `total_incl_tax`.** spec:2228 requires the computation at persist time and LEGACY-020's root cause is a tax figure nobody could recompute. A client-stated tax is the same defect facing the other way.
- **Any proposal to give `tax_code` a `source` column beside `tax_regime`'s.** §4.9.2 pins `tax_code` exactly and amendment A2 adds `source` to `tax_regime` **only** — one provenance record per regime, which is the unit a publication actually covers. A column here is a contracts amendment first.
- **Any proposal to compute the return from `ledger_entry` "because it is the same number".** It is not: the ledger's tax leg is a per-document sum in base, and a return needs the per-code, per-kind split with its own base measure. Reading the ledger would also make the tie-out compare a figure to itself, which is the one thing it must never do.
- **Any proposal to regenerate a `filed` return.** T8 refuses it and 5B depends on that refusal: a filed return's payload is what was transmitted, and a correction is a new period's return.

**The two commands that must be green after every task.** `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck` and `bun run test`, both at the repository root. `lint:rules` is the one that catches this slice's likeliest mistakes: a `db.` outside `withTenant`, a `number` typed against a name matching `/rate|tax/i`, a permission code with no reference, and a `tax_transaction` write that drifted outside `posting/`.

**What Phase 5B, Phase 6 and Phase 7 inherit, so nobody has to re-derive it.**

- **`canonicalJson` is the hash function.** §4.9.3's `EInvoiceDocument.hash` is "sha256 of the canonical payload"; that canonicaliser exists, is pure, and is exported from `@dulja/domain`. **5B imports it.** A second canonicaliser gives one document two hashes, and the authority will have seen the other one.
- **`app.tax_transaction` is the only source a return may read**, and `postDocument` step 11 is its only writer. 5B's transmission log keys on `document_id` and never re-derives a tax figure; 7C's `accounting.tax_return_view` reads `tax_transaction` (already in 7A's ≤ 0058 `DatasetId` set, so 7A adds no member).
- **A regime is added, never replaced.** `JurisdictionPack.regimes` holds definitions keyed `(code, version)` (A3), tenants are matched to one by that pair, and a filed return stays readable because nothing is removed. **OD-15's arrival is a seed PR plus one appended const** — that is the shape 8A/8B's statutory tables must copy, and it is the same shape for the same reason (LEGACY-020, LEGACY-078).
- **`resolveInclusive` is the one rule.** Anything that computes a tax-inclusive base — a POS ticket at 6A, a payroll benefit at 8B — calls it or repeats its single line, and if it repeats it, the two will disagree the first time §4.4.1's `tax.inclusive` grows a third form.
- **`accounting.tax.manage` is seeded and granted to `accountant`; `accounting.tax.file` is not seeded at all.** 5B seeds it in the PR that raises it, with the `accountant` grant, exactly as this slice did — the F-21 rule, and `permission-catalogue` fails the build until the reference exists in `apps/**`.
- **The four AR/AP policies are at `policyVersion: 2` with a `tax` block.** A fifth revenue-bearing type — 6A's `POS_TICKET` — adds its own `each_tax` leg the same way, as a seed file and not one line of TypeScript, and that is the test 15 re-run **6A** owns.

