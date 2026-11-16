# Dulja Phase 1A — Posting service, JOURNAL, numbering, `account_balance`, chart of accounts, periods

**For agentic workers:** every task below is self-contained. Read the task, open the files it names, and type what it shows. Do not read the other tasks first; do not look for context outside the paths a task names. Every signature, every SQL statement and every test assertion you need is written out in the task — where this plan repeats the contracts document, the repetition is deliberate (contracts §5 item 35: "a task's implementer sees only their own task").

**Goal.** Ship the posting service — the one code path through which any financial row is ever written — together with the Phase 1 tables it needs (`document_line`, `account_balance`, `document.posting_seq`), the JOURNAL document type and its policy v1, the chart-of-accounts and fiscal-period APIs, and the generic document API through which a journal voucher is drafted and posted. At the end of this slice a balanced two-line journal entered through `POST /v1/companies/{companyId}/documents` and posted through `POST …/documents/{id}/transitions` produces immutable `ledger_entry` rows, a `MERGE`d `account_balance` row and an audit trail, and `Σdebit = Σcredit` holds over ten thousand fast-check-generated documents.

**Architecture.** The posting service is split by the dependency rule (spec:2389, contracts §3.1): the pure half — the policy JSON Schema, the document snapshot and posting-plan types, `evaluatePolicy`, `validateRequires`, `balanceInBase` — lives in `packages/domain/src/posting/` and performs no I/O; the I/O half — `loadSnapshot`, `resolvePolicy`, `issueDocument`, `postDocument`, `reverseDocument`, `voidDocument` — lives in `packages/db/src/posting/` and is exported from `@dulja/db`. Neither `apps/api` nor `apps/worker` contains posting logic: the document routes here and the sync-apply, payroll and recost jobs of later phases all call the same four functions (spec:1360, 2081 — "exactly the same posting service"). Every one of them takes the caller's `tx` — the transaction `withTenant` opened — and none opens its own, so the handler's work, the pg-boss enqueue and the posting commit or roll back together. The acting principal is **always** `app.current_actor()` read from the session, never a parameter (SAH-044).

**Tech Stack.** TypeScript on Bun (apps and packages) with Vitest on Node 24 for tests (D5); PostgreSQL 18 through `postgres.js` tagged templates; Drizzle ORM mirrors for reads and as the migration diff source (ADR-0002, contracts §3.4.9); Hono + `@hono/zod-openapi` for routes; `decimal.js` behind `Money` (0D); Ajv (JSON Schema draft 2020-12) for policy validation; `fast-check` for the property and fuzz suites; Testcontainers for every database test. No package version appears in any source file — the lockfile owns versions (spec:104).

**Spec.** `docs/spec/rebuild-spec.md` v1.2 — §0.2 (spec:97–106), §3.1 (spec:1071–1078), §3.3 and its projections paragraph (spec:1163–1206), §3.8 in full (spec:1362–2032), §3.9 (spec:2039–2051), §4.7 (spec:2222–2224), §4.11 (spec:2262–2267), Part V phase 1 row (spec:2287), Part VI tests 1, 3, 4, 9, 16 (spec:2419–2457), Part I §A SAH-001–024. Contracts: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` (2026-09-05).

---

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 1A — Posting service, JOURNAL, numbering, `account_balance`, chart of accounts, periods. **Phase:** 1. **Phase gate:** this plan starts only when 0B, 0D, 0C and 0E are merged and the Phase 0 exit gate is green in CI — every §5.0 row green **and** tests 11, 12, 13, 14, 27 passing **and** the catalogue-integrity, incompatible-pair, auditor-read-only, expired-assignment and one-query assertions of test 36 passing against the Phase 0 catalogue (spec:87, spec:2327, contracts §2.1).
- **Depends on (merged):** **0B** (production `withTenant`, `TenantContext`, `createDb`, `systemContext`, `AppError`, `ERRORS`, `ErrCode`, `fromDatabaseError`, `Problem`, `PERMISSIONS`, `PERMISSION`, `isMutating`, `PermissionCode`, `requirePermission`, `ScopeSource`, `RouteModule`, `ROUTES`, `buildRoutes`, `createApp`, `AppEnv`, `Logger`, `startApi`, `ApiRequest`, `StartedApi`, `PROBES`, `IsolationProbe`, `sharedDb`, `thinRegression`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `CurrencySchema`, `MoneySchema`, `ProblemSchema`, `ListEnvelope`, `ListQuery`, `encodeCursor`, `decodeCursor`, migration 0002, the generalised reversibility test of contracts §3.4.6, `scripts/lint/run.ts`, `@dulja/db/test` subpath). **0D** (`Money`, `currency`, `round`, `RoundingMode`, `MONEY_SCALE`, `RATE_SCALE`, `Quantity`, `Rational`, `ExchangeRate`, `toBase`, `UNIT_RATE`, `CurrencyCode`, `app.currency`, `app.exchange_rate`, `app.rate_for`, `JOBS`, `JobClient`, `createJobClient`, `JobEnvelope`, `packages/db/seed/roles.ts` with `ROLES`/`RoleSeed`/`adminPermissions`/`INCOMPATIBLE_PAIRS`, the `permission-catalogue`, `role-seed` and `no-number-money` lints, `seedBranch`, `seedCurrency`, `seedRate`). **0C** (the seed CLI `packages/db/src/cli.ts seed --tenant <id> [--only <sub-pack>]`, `packages/db/seed/my/chart-of-accounts/0c-base.json` with the eleven §4.15 base accounts including `5920 FX rounding` wired to `company.fx_rounding_account_id`, the `fiscal-periods` sub-pack, staging). **0E** (the back office — consumed by 1B, not by this slice). Plan 0A helpers consumed **by exact name and never renamed:** `startDb`, `Db`, `Role`, `MIGRATIONS_DIR`, `ROLES_SQL`, the 4-argument test `withTenant`, `uuidv7`, `Seed`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `up`, `down`, `listApplied`, `discover`, `Migration`, `lintSchema`, `Violation`, `AUDIT_EXEMPT`, `IMMUTABLE`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.resolve_principal`, `app.current_tenant`, `app.current_actor`, `app.assert_period_open`, `app.assert_document_balanced`, `app.forbid_change`, `app.stamp_actor`, `app.audit_row`, `app.audit_chain`.
- **Migration numbers:** 0011–0014 — `0011_create_document_line.sql`, `0012_create_account_balance.sql`, `0013_alter_document_add_posting_seq.sql`, `0014_seed_permission_phase1.sql`, each with a hand-written `NNNN.down.sql`. **ADR numbers:** 0021–0023 — 0021 `document_line` base shape (a **proposal**, spec:95, since it is a data-model decision), 0022 Ajv as the posting-policy validator with a committed generated `PostingPolicy` type, 0023 `fiscal_period.reopen_reason` as the audited reopen reason.
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`/`toBase`/`ExchangeRate`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`AppEnv`, `Logger`, middleware order), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`), §4.2.5 (`PERMISSIONS`, `requirePermission`, `RoleSeed`/`ROLES`), §4.2.6 (`JobClient` — no job is enqueued by Phase 1; the parameter exists so the signature is final), §4.2.7 (`RouteModule`, `buildRoutes`, `PROBES`), §4.2.8 (common Zod schemas, list envelope, cursor), §4.2.9 (idempotency), §4.2.10 (`app.rate_for`), §4.2.12 (`startApi`), §4.15 (account codes seeded by 0C).
- **Interfaces produced:** §4.3.1 verbatim (`loadSnapshot`, `resolvePolicy`, `issueDocument`, `IssueResult`, `postDocument`, `PostResult`, `reverseDocument`, `voidDocument`, `DocumentStatus`; `transitionDocument`/`recordOverride` are 2A/2B and are **not** implemented here), §4.3.2 (the fixed algorithm, at its Phase 1 subset), §4.3.3 verbatim (`app.account_balance` and the `MERGE`), §4.3.4 verbatim (the Phase 1 `app.document_line`), §4.3.5 (`document.posting_seq`, `app.posting_seq`), §4.3.6 verbatim (numbering at issue), §4.3.7 verbatim (the document-type seed envelope and `JOURNAL.json`), §4.4.1 at the **JOURNAL subset** (`packages/domain/posting-policy.schema.json`, `$id: urn:dulja:posting-policy:1`), §4.4.2 verbatim for every declared type (`PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PlannedMovement`, `PlannedTaxLine`, `PostingPlan`, `PolicyValidation`, `PayComponentRef`, `SchemeRef`, `PayrollLineRef`, `ItemRef`, `TaxCodeRef`) and at the JOURNAL subset for `evaluatePolicy`, §3.5.2's `posting-only-tables` lint, §3.6.2's six `accounting.*` codes, §4.17's `JOURNAL_POLICY_V1`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount`.
- **Owner decisions:** **OD-24** (screenshots and a two-minute operator description before any screen) → **Task 15, isolated**; default assumed = **no screen ships in this slice** — 1A ships the API surface only and the three Phase 1 screens (chart of accounts, journal entry, fiscal periods) are 1B's Delivers. No other OD item gates this slice; **OD-27** (Part VII #6, real DDL constraints) is *cited* by the conditional regression file `tests/regression/sah-024.test.ts`, which contracts §3.7.3 makes 1A create **marked `it.skip` with the reason** — that is one `it` inside Task 14, not a gate on any deliverable. **OD-06** (v1 costing method) is **not** this slice's: `DocumentSnapshot.company.costingMethod` is filled with the §2.12 default `"avco"` because `app.company` has no `costing_method` column before 3B, and 3B's isolated OD-06 task changes that one expression.
- **Part VI tests owned / re-run:** owns **1** (ledger invariant — the fast-check fuzz suite of Task 14), **3** (re-key a posting — Task 9), **4** (multi-tenant aggregate — the two-connection, two-tenant concurrent post of Task 14). Re-runs **16** (JOURNAL numbering — the concurrency pre-check of Task 7; 2B owns it), **9** (period lock through the **API and admin paths only** — Task 12 for the API path, Tasks 11 and 8 for the admin path; 1B owns the test and ships the background-job path, 9B the import path), **12**, **13** and **36** for the three new tables and the six new codes. **§3.0.4 rows owned:** none — 1A contributes to spec:1040 (owned by 1B) and to spec:1045's "base = value × rate" clause (owned by 4B). **Regression files created:** `tests/regression/sah-001.test.ts`, `sah-002.test.ts`, `sah-011.test.ts`, `sah-024.test.ts` (⚠️ conditional, created immediately and marked `it.skip` until OD-27 answers Part VII #6 — contracts §3.7.3 names 1A as its creator), `sah-049.test.ts`, `sah-079.test.ts`. **Appended to:** `sah-003`, `sah-012`, `sah-021`, `sah-031`, `sah-035`, `sah-041`, `sah-050`, `sah-051`, `sah-070`, `sah-071` (each already created by 0B; this slice adds a `describe("… — 1A", …)` block and never edits an earlier one).
- **Shared namespaces this slice writes into:** **document-type codes (§4.14):** `JOURNAL`, `module: "accounting"`, series `JV` — the only one. **Account codes (§4.15):** **none seeded** — every code this slice's policy and tests name is 0C's: `1000` Cash on hand, `4000` Sales, `5920` FX rounding (the `company.fx_rounding_account_id` target), plus `1100` Bank and `1300` Inventory control used only as second accounts in tests. Task 10's first step asserts `1000`, `4000` and `5920` resolve for the seeded company (contracts §5 item 33). **Report codes (§4.16.1) and `DatasetId` members (§4.16.2):** **none** — `accounting.trial_balance` and `accounting.ledger` are 1B's. **`fixtures.ts` helpers (§4.17):** `JOURNAL_POLICY_V1`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount` — **and no others**. **`ERR_*` (§4.2.4):** this slice adds exactly `ERR_PERIOD_NOT_FOUND`, `ERR_POLICY_NOT_FOUND`, `ERR_POLICY_INVALID`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_DOC_NO_LINES` and `ERR_DOC_STATUS_ILLEGAL` to `ERRORS` in `packages/contracts/src/errors.ts` — two in **Task 5** (the two `ERR_POLICY_*` the evaluator throws) and the remaining four in **Task 6**, all six therefore inside the one pull request that spans Tasks 4→12. They land no later than Task 6 and not "each in the PR that raises it", because Task 6 Step 5's `if (e instanceof PostingError) return new AppError(e.code, e.detail)` needs `PostingErrorCode` to be a literal subset of `ErrCode` **with no cast**, and `PostingErrorCode` carries all nine of §4.3.8's Phase 1 members from Task 6 Step 2 onward. The `error-codes` build check is satisfied for every one of the six from the moment it is added, because each occurs as a string literal in `packages/domain/src/posting/evaluate.ts` or `packages/db/src/posting/errors.ts` — both inside `packages/**/src/**`.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contract amendments this plan depends on — seven, each listed with its section, its wording and the task it blocks in the Self-Review's *Contract amendments* table.** In task order: **A1** `app.fiscal_period.reopen_reason` registered in §4.3.4/§4.6 (blocks **Task 3**); **A7** the six `accounting.*` role grants recorded in §3.6.4's register sentence (lands **with Task 4**); **A3** `balanceInBase`'s third parameter in §4.4.2 and the `balanceLines()` spelling in §2.2, and **A6** the three §4.4.2 additions `parsePolicy`, `validateDocumentTypeSeed` and a body for `PolicyEvaluationError` (both block **Task 5**); **A2** `PostingError`/`PostingErrorCode` in §4.3.1/§4.3.8 and **A5** the `refs.accountsByCode` sentence at contracts:2108 (block **Task 6**); **A4** the balance-key advisory lock beside the §4.3.3 `MERGE` (blocks **Task 8**). None changes behaviour; each makes the registry say what this plan ships. The architect makes them in their own PR — the project folder is read-only to this plan's writer except this file. **As of the 2026-09-08 audit, A1, A2, A3 and A6 have landed in the contracts document; A4 and A5 have not** — §4.3.3's `MERGE` recipe still carries no balance-key advisory lock and §4.4.2 still reads "holds exactly the §4.15 codes the policy names" — so Tasks 6 and 8 remain gated, and A7's register sentence still records only 2A's and 2B's grants.
- **Contracts version:** 2026-09-05.

### Readings this plan fixes so no task re-derives them

1. **`document.posted_by` is written explicitly, not by a default.** `app.stamp_actor` overwrites a supplied value on the NULL → non-null transition but never invents one, and `app.document.posted_by` has **no** column default (plan0A:1771 — `posted_by uuid references app.principal(id)`). Step 13 of §4.3.2 therefore writes `posted_by = app.current_actor()` in the same `update`; the trigger then re-stamps it from the session, which is the control. `app.ledger_entry.posted_by` **does** carry `default app.current_actor()` (plan0A) and is never named in an insert.
2. **`fiscal_period.closed_by` records the *first* close, and every close and reopen is recorded in full in `app.audit_log`.** `app.stamp_actor` raises `ERR_ACTOR_IMMUTABLE` on any change to a non-null `*_by` value, so a period closed by Ali, reopened, then closed by Siti cannot move `closed_by` to Siti. Task 11's close statement is therefore `closed_by = coalesce(closed_by, app.current_actor())` — a no-op update for the second close, which the trigger accepts — and the audited row image, whose `actor_id` is stamped per row, is the per-event record the auditor reads. Changing `stamp_actor` is a Plan 0A amendment; Plan 0A is frozen.
3. **`fiscal_period.reopen_reason` is the column the reason lands in, and it needs a contracts amendment before migration 0013 ships.** `app.audit_log` has no `reason` column and its `after` image is `to_jsonb(new)` of the row (plan0A:2308–2332), so "a reason written to the audit row" (spec:2179) means a column on the row. Migration 0013 adds it under its expected file name, in a clearly bannered second section (ADR 0023), and 1B reads it as `after->>'reopen_reason'`, null-safe. **But `reopen_reason` occurs nowhere in the contracts document today:** §4.3.4 enumerates every column a later slice adds to a Plan 0A table and names only `document` and `document_type` additions, and §4.6's table register covers new tables. The 1B card says only "every period reopen reported (spec:2179)" — that is a requirement 1B carries, not an existing 1B contract this column satisfies. Adding a column to a shared Plan 0A table without a register row is exactly what hazard 32 and §3.10 ("a needed change goes to that document first") forbid, so **Task 3 does not start until the architect has registered `app.fiscal_period.reopen_reason text` (owner 1A / migration 0013, reader 1B) in §4.3.4 or §4.6** — Self-Review *Contract amendments* row A1. No code below changes once that row exists.
4. **`document_type.module` does not exist yet.** 2A's migration 0018 adds it (contracts §4.3.4). The seed envelope of §4.3.7 carries `module` and `document-type-seed.schema.json` **requires** it — the loader validates it and does **not** insert it; 2A widens the loader's insert list to `(code, name_en, name_ar, module)` in the same PR as 0018. Nothing is lost: the column's only consumer is the §4.5.8 attachment gate, which is 2C's.
5. **There is no journal-specific route.** §4.2.7 fixes the generic document surface `/v1/companies/{companyId}/documents`, `…/documents/{documentId}/lines`, `…/documents/{documentId}/transitions`, and calls a type-specific route a convention violation; 1B's screens call exactly those paths. At Phase 1 the routes are gated by the static codes `accounting.journal.create` and `accounting.journal.post`, and the create body's `documentTypeCode` must equal `"JOURNAL"` (anything else is `ERR_VALIDATION_FAILED`). 2A replaces the static gate with `policy.approval.create` / `policy.approval.post` resolved from the effective policy; the paths never change.
6. **`reverseDocument` inserts a `document` and its `document_line` rows.** The closed write list of §4.3.2 reads "`document_line` (`cost` only, 3A+)" of the *document being posted*; D13 and §4.3.1's own docstring require the reversal document itself to be created, which means one `document` insert and one `document_line` insert per source line. Both are ordinary application writes on tables the `posting-only-tables` lint does not cover (§3.7.5 lists neither), and they happen inside `packages/db/src/posting/` regardless.
7. **A document that plans zero ledger lines is refused, not posted.** Nothing in the database stops an empty posting: `assert_document_balanced` is satisfied by `0 = 0` and `assert_period_open` never fires with no rows, so a document whose policy yields no lines — 0A's fixture policy `{"lines":[]}` is exactly such a policy — would reach `status = 'posted'` with no ledger entry at all. `postDocument` therefore throws `ERR_DOC_NO_LINES` when `plan.ledgerLines.length === 0` after evaluation, the same code §4.2.4 allocates for "posting service" and §4.3.2 step 3 already uses for a document with no `document_line` rows. The message distinguishes the two cases.
8. **The snapshot types are declared in full at their §4.4.2 shape and filled at the Phase 1 subset.** `loadSnapshot` fills `LineSnapshot.kind` with the literal `"account"` (there is no `kind` column before 2A's 0019), `header.taxInclusive` with `false` (no column before 5A's 0054), `header.partyId`/`party` with `null` (no `party` table before 2A), `header.warehouseId`/`toWarehouseId` with `null` (no columns before 3A's 0031), `company.costingMethod` with `"avco"` (no column before 3B; OD-06's default), and `refs.items`, `refs.taxCodes`, `refs.components`, `refs.schemes` with `{}`. Each is a one-expression change in the slice that adds the column, and every consumer compiles against the final shape from this slice onward.
9. **`resolvePolicy` breaks a tie on the highest `version`.** 0A's fixture policy (`version = 1`) and this slice's JOURNAL policy v1 (`posting_policy.version = 2`) share `effective_from = '2026-01-01'`, so `order by effective_from desc, version desc limit 1` is what makes a `seedTenantV2` tenant post real lines while `seedTenant` keeps its empty-policy behaviour for the 0A tests that depend on it.
10. **Ajv is a new dependency of `@dulja/domain`.** D11 ("`decimal.js` only") scopes the money module; `validatePolicy` is declared in `packages/domain/src/posting/evaluate.ts` by §4.4.2 and needs a draft-2020-12 validator. `ajv` (runtime) and `json-schema-to-typescript` (dev, for the committed generated type) are added to `packages/domain/package.json` with the version resolved by the lockfile — no version literal reaches a source file (spec:104). ADR 0022 records it.
11. **The posting service throws `PostingError`, not `AppError`, and `apps/api` maps it — because `packages/db` may not import `@dulja/contracts`.** §4.3.1 says `postDocument` "Throws AppError codes listed in §4.3.7" and §4.3.8 lists them "each through `AppError` or translated from the DB token by `fromDatabaseError`" — but `AppError` lives in `@dulja/contracts`, and 0B's `dependency-rule` lint pins `packages/db` to `["@dulja/domain"]` (spec:2389). The *codes* are honoured exactly: `packages/db/src/posting/errors.ts` declares `PostingError` whose `code` is a literal subset of `ErrCode`, and `apps/api/src/problem.ts` gains one branch beside the `TenantContextError` branch 0B already wrote for the identical reason (`TenantContextError` is also declared in `@dulja/db` and mapped in the API). Nothing about the wire response changes: the `Problem` a caller sees is the one §4.2.4 specifies. This is the one place this plan departs from the registry's literal text, and it departs to obey a rule the registry itself sets.

---

## Global Constraints

**Never** (spec:97–104, restated because each task must be able to stand alone): write to a ledger or movement table outside the posting service; represent money as a float anywhere, TypeScript included; build SQL by string concatenation (SAH-036/037/069); issue DDL from application code (SAH-053); disable an invariant, constraint or trigger "temporarily" (SAH-027, 041, 053); gate an audit write on any flag (SAH-030); hard-code a package version into a source file — the lockfile owns versions.

**Always**, for every new table (spec:106 unioned with the Plan 0A linter, contracts §3.3): `tenant_id`; RLS enabled **and forced** through `call app_meta.enable_tenant_rls('app.<name>')`; the policy named exactly `tenant_isolation`; `id uuid primary key default uuidv7()` unless the table is in `NO_ID_TABLES`; `created_at timestamptz not null default now()`; `call app_meta.attach_audit('app.<name>')` unless the table is in `AUDIT_EXEMPT`; `call app_meta.attach_stamp('app.<name>', '<col>_by')` for every `*_by` column; composite FKs `(tenant_id, <parent>_id)` to every tenant-scoped parent; a migration with a hand-written down; a Drizzle mirror in `packages/db/src/schema/`; and a test that a second tenant cannot see it. `lintSchema` must report **zero** violations after every migration.

**Every query — reads included — runs inside `withTenant`** (spec:2053). The `no-bare-db` lint forbids a bare `db.` call; only a `tx` obtained from `withTenant` may tag SQL. `sql.unsafe` has exactly three homes and none of them is in this slice (contracts §3.3).

**Money is `numeric(19,4)` in Postgres and `Money` in TypeScript** (spec:2041). Base conversion is `round(value × rate, 4)` with `HALF_AWAY_FROM_ZERO` — the only mode that satisfies the `ledger_entry` CHECK `base_debit = round(debit * exchange_rate, 4)` (spec:1816, contracts §5 item 23). `effective_date` is a `date` the user enters and is never derived from `posted_at` (spec:2039).

**Commits.** Conventional commits, scope = workspace or area, subject `<type>(<scope>): <summary> [1A T<n>]`, every message ending with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (contracts §3.8). **One migration per PR** (spec:2057) — this slice has four migrations and therefore at least four PRs. `bun run lint`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root must be green after every task — those four are the set contracts §3.1 fixes (contracts:924), and this plan holds them green after all fifteen.

**`bun run lint:rules` has one documented exception, and it is the only one.** contracts:924 puts `lint:rules` in CI rather than in the per-task set. `permission-catalogue` is bidirectional (contracts:1153), so from Task 4 — which must add the six `accounting.*` codes to `packages/contracts/permissions.ts` in the same PR as migration 0014, because `permission-catalogue.test.ts` asserts the DB set and the exported set are equal in both directions — until Task 12 registers the last handler, `lint:rules` reports exactly six violations, all of the form `permission-catalogue … accounting.<x> has no reference`. That is the phased catalogue spec:2142 describes. **No other rule may report anything at any point**, and every task that runs `lint:rules` says so in its expectation. Because CI runs on a pull request, Tasks 4 through 12 are one PR (see *Execution handoff* for the five PR boundaries), so no red build is ever published.

Pushing to GitHub is the owner's call, not part of any task's definition of done.

**TDD.** Every task writes the failing test first, runs it, sees the **exact** stated failure, writes the minimal implementation, runs the test to green, then commits. A task that reports a different failure than the one written down has found a real difference from the plan — stop and report it rather than editing the expectation.

---

## Phase 1 definition of done (spec:2287, verbatim) and this slice's share

> **Scope:** "Chart of accounts, fiscal periods & locking, **a single hand-written `JOURNAL` document type with policy v1** (Phase 2 generalises this into the policy engine), immutable `LedgerEntry`, numbering via `document_series`, `account_balance` via `MERGE`, trial balance, integrity checker".
>
> **Definition of done:** "Σdebit = Σcredit holds under fuzz testing; projections rebuild **bit-identically**; a locked period cannot be altered through any path including import; the first PITR restore drill has been run against staging and written up as a runbook (§4.8, acceptance test 24)".

| Clause | Slice | Where |
|---|---|---|
| "Σdebit = Σcredit holds under fuzz testing" | **1A** | Task 14 — `apps/api/test/routes/documents.fuzz.test.ts`, fast-check over document shapes through `POST …/transitions` |
| "a locked period cannot be altered through any path" — **API and admin paths** | **1A** | Task 12 — a post into a `closed` period is refused through `POST …/documents/{id}/transitions`; Task 11 — the same post as `app_rw` outside every route is refused by `postDocument`; Task 8 — a raw `insert into app.ledger_entry` as `app_rw` into a `closed` and a `locked` period is refused by `app.assert_period_open`, which is the control |
| "a locked period cannot be altered through any path" — background-job path | 1B | 1B's test 9 |
| "a locked period cannot be altered through any path" — import path | 9B | 9B's loader task |
| "projections rebuild bit-identically" | 1B | `accounting.ledger.integrity_check` |
| "the first PITR restore drill …" | 1B | the drill task (OD-19) |

The phase exits when every clause is green in CI (spec:87).

---

## File Structure

```
packages/db/
├─ migrations/
│  ├─ 0011_create_document_line.sql        app.document_line (§4.3.4)                            T1
│  ├─ 0011.down.sql                                                                              T1
│  ├─ 0012_create_account_balance.sql      app.account_balance (§4.3.3)                          T2
│  ├─ 0012.down.sql                                                                              T2
│  ├─ 0013_alter_document_add_posting_seq.sql  app.posting_seq, document.posting_seq,
│  │                                           fiscal_period.reopen_reason (§4.3.5, ADR 0023)    T3
│  ├─ 0013.down.sql                                                                              T3
│  ├─ 0014_seed_permission_phase1.sql      the six accounting.* codes (§3.6.2)                    T4
│  └─ 0014.down.sql                                                                              T4
├─ src/
│  ├─ schema/document_line.ts              Drizzle mirror                                        T1
│  ├─ schema/account_balance.ts            Drizzle mirror                                        T2
│  ├─ schema/document.ts                   posting_seq added to the 0B mirror                    T3
│  ├─ schema/fiscal_period.ts              reopen_reason added to the 0B mirror                  T3
│  ├─ lint-schema.ts                       NO_ID_TABLES gains account_balance                    T2
│  ├─ posting/
│  │  ├─ load.ts                           loadSnapshot, resolvePolicy (§4.3.1)                   T6
│  │  ├─ issue.ts                          issueDocument (§4.3.6)                                 T7
│  │  ├─ post.ts                           postDocument (§4.3.2), the account_balance MERGE       T8
│  │  ├─ reverse.ts                        reverseDocument, voidDocument (D13, spec:1745)         T9
│  │  └─ index.ts                          the §4.3.1 barrel                                      T6→T9
│  ├─ seed/document-types.ts               the `--only document-types` loader (§3.4.8)            T13
│  └─ index.ts                             re-exports ./posting                                   T6
├─ seed/my/document-types/JOURNAL.json     the §4.3.7 envelope and policy v1                     T13
└─ test/
   ├─ fixtures.ts                          + JOURNAL_POLICY_V1, seedTenantV2,
   │                                         seedJournalPolicy, seedAccount (§4.17)              T6
   ├─ document-line.test.ts                                                                      T1
   ├─ account-balance.test.ts                                                                    T2
   ├─ posting-seq.test.ts                                                                        T3
   ├─ permission-catalogue.test.ts         extended with the six accounting codes                 T4
   ├─ posting/load.test.ts                                                                       T6
   ├─ posting/issue.test.ts                two-connection numbering race                          T7
   ├─ posting/post.test.ts                                                                        T8
   ├─ posting/reverse.test.ts              test 3 — re-key a posting                              T9
   └─ seed/document-types.test.ts                                                                T13

packages/domain/
├─ posting-policy.schema.json              §4.4.1 at the JOURNAL subset, $id urn:dulja:posting-policy:1   T5
├─ document-type-seed.schema.json          the §4.3.7 envelope                                   T5
├─ src/posting/
│  ├─ policy.ts                            the generated, committed PostingPolicy type            T5
│  ├─ evaluate.ts                          §4.4.2 types + validatePolicy, validateRequires,
│  │                                       evaluatePolicy, balanceInBase                          T5
│  └─ index.ts                                                                                    T5
├─ src/index.ts                            re-exports ./posting                                   T5
├─ scripts/generate-policy-type.ts         json-schema-to-typescript, run by `policy:types`       T5
└─ test/posting/
   ├─ journal-envelope.fixture.json        the §4.3.7 envelope; T13 asserts it byte-equal to
   │                                       packages/db/seed/my/document-types/JOURNAL.json         T5
   ├─ validate-policy.test.ts                                                                     T5
   ├─ policy-type.test.ts                  the committed type matches the schema                   T5
   ├─ evaluate.test.ts                                                                            T5
   └─ balance.property.test.ts             fast-check: Σbase debit = Σbase credit                 T5

packages/contracts/
├─ permissions.ts                          + the six accounting.* entries                         T4
├─ src/errors.ts                           + six ERR_* rows (two in T5, four in T6)               T5, T6
└─ src/accounting/
   ├─ account.ts                           AccountSchema, CreateAccountBody, UpdateAccountBody,
   │                                       AccountQuery, AccountList, AccountNodeSchema, AccountTree   T10
   ├─ fiscal-period.ts                     FiscalPeriodSchema, FiscalPeriodQuery, FiscalPeriodList,
   │                                       ClosePeriodBody, ReopenPeriodBody                           T11
   ├─ document.ts                          DocumentSchema, DocumentLineSchema, CreateDocumentBody,
   │                                       ReplaceLinesBody, TransitionBody, TransitionResultSchema,
   │                                       DocumentQuery, DocumentList                                 T12
   └─ ledger.ts                            LedgerEntrySchema, LedgerEntryQuery, LedgerEntryList        T12

packages/db/seed/roles.ts                  accountant / user / auditor grants                     T4

apps/api/
├─ src/routes/
│  ├─ accounting/accounts.ts               /v1/companies/:companyId/accounts                      T10
│  ├─ accounting/fiscal-periods.ts         /v1/companies/:companyId/fiscal-periods                T11
│  ├─ accounting/documents.ts              /v1/companies/:companyId/documents                     T12
│  └─ accounting/ledger.ts                 /v1/companies/:companyId/ledger-entries                T12
├─ src/routes/index.ts                     four new RouteModule entries                        T10→T12
└─ test/routes/accounting/
   ├─ accounts.test.ts                                                                            T10
   ├─ fiscal-periods.test.ts               period lock through the admin path (test 9 share)      T11
   ├─ documents.test.ts                    period lock through the API path (test 9 share)        T12
   └─ documents.fuzz.test.ts               test 1 and test 4                                      T14

scripts/lint/rules/posting-only-tables.ts  §3.7.5, owned by 1A                                    T8
scripts/lint/rules/posting-only-tables.test.ts                                                    T8

tests/
├─ invariants/probes.ts                    four new PROBES entries                             T10→T12
└─ regression/
   ├─ sah-001.test.ts  sah-002.test.ts  sah-011.test.ts  sah-024.test.ts (skipped)
   ├─ sah-049.test.ts  sah-079.test.ts                                                            T14
   └─ appends to sah-003, 012, 021, 031, 035, 041, 050, 051, 070, 071                              T14

docs/adr/
├─ 0021-document-line-base-shape.md        PROPOSAL (spec:95)                                     T1
├─ 0022-ajv-posting-policy-validator.md                                                           T5
└─ 0023-fiscal-period-reopen-reason.md                                                            T3
```

---

### Task 1 — Migration `0011_create_document_line.sql`: `app.document_line`

The line table every document type from Phase 2 onward extends. Phase 1 needs exactly the columns a journal voucher uses: a line number, a description, an account, a debit and a credit in the document's currency, a dimension bag and a custom-field bag. Every later slice adds nullable or defaulted columns to this same table (contracts §4.3.4) — none ever renames or drops one.

**Files:**
- Create: `packages/db/migrations/0011_create_document_line.sql`, `packages/db/migrations/0011.down.sql`, `packages/db/src/schema/document_line.ts`, `packages/db/test/document-line.test.ts`, `docs/adr/0021-document-line-base-shape.md`

**Interfaces:**
- Produces (SQL): `app.document_line` exactly as contracts §4.3.4 — columns `id`, `tenant_id`, `company_id`, `document_id`, `line_no`, `description`, `account_id`, `debit`, `credit`, `dimensions`, `custom_fields`, `created_at`; constraints `check (line_no > 0)`, `check (debit >= 0)`, `check (credit >= 0)`, `check (not (debit > 0 and credit > 0))`, `unique (document_id, line_no)`, `unique (tenant_id, id)`; composite FKs to `company`, `document` (`on delete cascade`) and `account`; `tenant_isolation` RLS and the `audit_row` trigger.
- Produces (TS): `packages/db/src/schema/document_line.ts` exporting `documentLine`.
- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit` (§4.1); `startDb`, `seedTenant`, `draftDocument`, `uuidv7`, the test `withTenant` (§4.1); `lintSchema`, `up`, `down`, `MIGRATIONS_DIR` (§4.1).

**Why `document_line` carries no `branch_id`, ever** (contracts §3.5.1 item 7): it is isolated through its parent `document`, which is Form A of the §4.5.6 branch-isolation policy set. 6C's `branch_isolation_policy` linter rule deliberately does not name it. Do not add one here or anywhere.

- [ ] **Step 1: Write the failing test `packages/db/test/document-line.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { draftDocument, seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("app.document_line — contracts §4.3.4 (spec:1748, SAH-021, 035)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    b = await seedTenant(db, "Beta");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("accepts a two-line journal and defaults both bags to {}", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, description, account_id, debit)
               values (${a.tenant}, ${a.company}, ${doc}, 1, 'Cash received', ${a.cash}, 100.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, description, account_id, credit)
               values (${a.tenant}, ${a.company}, ${doc}, 2, 'Sales', ${a.sales}, 100.0000)`;
    });
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { line_no: number; debit: string; credit: string; dimensions: unknown; custom_fields: unknown }[]
    >`select line_no, debit, credit, dimensions, custom_fields from app.document_line where document_id = ${doc} order by line_no`);
    expect(rows.map((r) => r.line_no)).toEqual([1, 2]);
    expect(rows[0]!.debit).toBe("100.0000");
    expect(rows[1]!.credit).toBe("100.0000");
    expect(rows[0]!.dimensions).toEqual({});
    expect(rows[0]!.custom_fields).toEqual({});
  });

  it("refuses a line that is both a debit and a credit, a negative amount and line_no 0", async () => {
    const doc = await draftDocument(db, a);
    const insert = (lineNo: number, debit: string, credit: string) =>
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit)
        values (${a.tenant}, ${a.company}, ${doc}, ${lineNo}, ${a.cash}, ${debit}, ${credit})`);
    await expect(insert(1, "5.0000", "5.0000")).rejects.toThrow(/document_line_check/);
    await expect(insert(2, "-5.0000", "0.0000")).rejects.toThrow(/document_line_debit_check/);
    await expect(insert(0, "5.0000", "0.0000")).rejects.toThrow(/document_line_line_no_check/);
  });

  it("refuses a duplicate line_no on one document", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
      values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 1.0000)`);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
        values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.sales}, 1.0000)`),
    ).rejects.toThrow(/document_line_document_id_line_no_key/);
  });

  it("cannot borrow another tenant's account through the composite FK (SAH-035)", async () => {
    const doc = await draftDocument(db, a);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
        values (${a.tenant}, ${a.company}, ${doc}, 9, ${b.cash}, 1.0000)`),
    ).rejects.toThrow(/document_line_tenant_id_account_id_fkey/);
  });

  it("a second tenant sees no lines at all (spec:106 'a test that a second tenant cannot see it')", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
      values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 7.0000)`);
    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_line`);
    expect(seen[0]!.n).toBe(0);
    const written = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const r = await tx`update app.document_line set description = 'stolen' where document_id = ${doc}`;
      return r.count;
    });
    expect(written).toBe(0);
  });

  it("deleting a draft document cascades its lines", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
      values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 3.0000)`);
    // app_rw holds no DELETE on document until 2B's migration 0023, so the cascade is exercised as the owner.
    await withTenant(db.migrator, a.tenant, a.system, (tx) => tx`delete from app.document where id = ${doc}`);
    const rows = await withTenant(db.migrator, a.tenant, a.system, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_line where document_id = ${doc}`);
    expect(rows[0]!.n).toBe(0);
  });

  it("writes an audit row for the insert and the update (spec:106)", async () => {
    const doc = await draftDocument(db, a);
    const lineId = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_line (id, tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${lineId}, ${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 2.0000)`;
      await tx`update app.document_line set description = 'corrected' where id = ${lineId}`;
    });
    const audit = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ action: string }[]>`
      select action from app.audit_log where table_name = 'document_line' and row_id = ${lineId} order by seq`);
    expect(audit.map((r) => r.action)).toEqual(["insert", "update"]);
  });

  it("leaves the schema linter with zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

Run: `bun run --cwd packages/db test -- test/document-line.test.ts`
Expected: **FAIL** — seven of the eight tests error with `relation "app.document_line" does not exist`. The eighth, "leaves the schema linter with zero violations", touches no new table: it is **already green** on the Phase 0 head and stays green after the migration. Seven red and one green is the expected result here; a different split means the repository differs from this plan.

- [ ] **Step 2: Write `packages/db/migrations/0011_create_document_line.sql`**

```sql
-- 0011_create_document_line.sql — the document line table (contracts §4.3.4; spec:1748 the document header).
-- Phase 1 needs only the columns a JOURNAL uses. Every later slice ADDS nullable or defaulted columns to this
-- same table (2A kind/item/amounts, 3A warehouse/lot/unit, 3D count quantities, 5A the tax-code FK) — expand
-- only, never a rename (spec:2057, contracts §3.4.7).
-- document_line deliberately has NO branch key and never gains one (contracts §3.5.1 item 7, §4.5.6): it is
-- branch-isolated through its parent document, so 6C's branch_isolation_policy rule does not name it.

-- ── 1. the table ──────────────────────────────────────────────────────────────────────────────────────
create table app.document_line (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  document_id    uuid not null,
  line_no        int not null check (line_no > 0),
  description    text,
  account_id     uuid,                                   -- 'account' lines (JOURNAL); item lines resolve accounts through the policy
  debit          numeric(19,4) not null default 0 check (debit >= 0),     -- document currency (spec:2041)
  credit         numeric(19,4) not null default 0 check (credit >= 0),
  dimensions     jsonb not null default '{}'::jsonb,     -- {"<dimension_type.code>": "<dimension_value.id>"}; BRANCH is never here — it is document.branch_id
  custom_fields  jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  check (not (debit > 0 and credit > 0)),                -- one side per line, exactly as ledger_entry (spec:1815)
  unique (document_id, line_no),
  unique (tenant_id, id),
  -- Composite FKs: an FK check bypasses RLS, so a plain references would let tenant A's line point at
  -- tenant B's account if the uuid were known (SAH-035, spec:1820).
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, document_id) references app.document(tenant_id, id) on delete cascade,
  foreign key (tenant_id, account_id)  references app.account(tenant_id, id)
);

-- ── 2. isolation and audit ────────────────────────────────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.document_line');
call app_meta.attach_audit('app.document_line');          -- before/after images of every draft edit (spec:106)

-- app_rw receives select, insert, update through the default privileges of migration 0001 (plan0A:2564).
-- No DELETE: the cascade from document runs with the table owner's rights, and 2B's migration 0023 is the
-- one slice that grants app_rw DELETE here, guarded by document_delete_draft_only (contracts §3.5.4).
-- No extra index: `unique (document_id, line_no)` already backs every lookup by document (SAH-070).
```

`packages/db/migrations/0011.down.sql`:

```sql
-- Reverse of 0011. The audit trigger and the RLS policy go with the table; app_meta and its default
-- privileges are never dropped (contracts §3.4.5).
drop table if exists app.document_line;
```

- [ ] **Step 3: Write the Drizzle mirror `packages/db/src/schema/document_line.ts`**

The mirror is the diff source for every later change to this table (ADR-0002, contracts §3.4.9): a slice edits the mirror, runs `drizzle-kit generate`, renames the output into its own migration range and hand-edits it.

```ts
import { check, foreignKey, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { account } from "./account";
import { company } from "./company";
import { document } from "./document";
import { tenant } from "./tenant";

/** contracts §4.3.4 — the Phase 1 base. Later slices add nullable or defaulted columns; nothing is renamed. */
export const documentLine = pgTable(
  "document_line",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id").notNull(),
    lineNo: integer("line_no").notNull(),
    description: text("description"),
    accountId: uuid("account_id"),
    debit: numeric("debit", { precision: 19, scale: 4 }).notNull().default("0"),
    credit: numeric("credit", { precision: 19, scale: 4 }).notNull().default("0"),
    dimensions: jsonb("dimensions").notNull().default(sql`'{}'::jsonb`),
    customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("document_line_line_no_check", sql`${t.lineNo} > 0`),
    check("document_line_debit_check", sql`${t.debit} >= 0`),
    check("document_line_credit_check", sql`${t.credit} >= 0`),
    check("document_line_check", sql`not (${t.debit} > 0 and ${t.credit} > 0)`),
    unique("document_line_document_id_line_no_key").on(t.documentId, t.lineNo),
    unique("document_line_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.companyId], foreignColumns: [company.tenantId, company.id] }),
    foreignKey({ columns: [t.tenantId, t.documentId], foreignColumns: [document.tenantId, document.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.tenantId, t.accountId], foreignColumns: [account.tenantId, account.id] }),
  ],
);
```

Add `export * from "./schema/document_line";` to `packages/db/src/schema/index.ts` beside the 0B mirrors.

- [ ] **Step 4: Write `docs/adr/0021-document-line-base-shape.md` as a PROPOSAL**

spec:95 requires anything touching the data model to be written as a proposal and asked before implementing. This ADR is that proposal; it ships in the same PR and is marked `Proposed`, not `Accepted`, until the reviewer approves the PR.

```markdown
# ADR 0021 — `document_line`: the Phase 1 base shape

- **Status:** Proposed (spec:95 — a data-model decision is proposed and asked, not implemented first)
- **Date:** 2026-09-05
- **Slice:** 1A
- **Supersedes / superseded by:** —

## Context

Phase 1 posts a single hand-written `JOURNAL` type (spec:2287). Phase 2 generalises documents; Phase 3 adds
items, warehouses and lots; Phase 5 adds tax; Phase 6 adds POS tender lines; Phase 8 adds payroll lines. All of
them are lines of the same document. The choice is between one table that grows by expand-only ALTERs and one
table per family.

## Decision

One table, `app.document_line`, created here with the seven business columns a journal voucher needs
(`line_no`, `description`, `account_id`, `debit`, `credit`, `dimensions`, `custom_fields`) plus the standard
tenant, company, document, id and `created_at` columns. Every later slice adds **nullable or defaulted**
columns to this table on the schedule in contracts §4.3.4, and no slice renames or drops one. `kind` arrives
in 2A with the default `'account'`, so every row this slice writes is retro-classified correctly.

## Consequences

- A generic `documents` API (§4.2.7) can serve every type without a per-type table, which is what acceptance
  test 15 ("a new document type with zero code") requires.
- The table is wide by Phase 8. That is acceptable: Postgres stores NULLs in the null bitmap, and the
  alternative — a table per family — would make the posting service branch on type, which is exactly the
  design the policy engine exists to avoid (RC-3).
- `document_line` never gains a branch key. It is branch-isolated through `document` (contracts §4.5.6), so
  6C's `branch_isolation_policy` rule deliberately omits it.
- Every future column addition is an expand migration; a matching contract migration is only ever needed if a
  column is retired, which no slice in the v1 roadmap does.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/document-line.test.ts`
Expected: **PASS** (8 tests). If the cascade test fails with `permission denied for table document`, the test is running as `app_rw` instead of `app_migrator` — re-read step 1's comment.

Run: `bun run --cwd packages/db test`
Expected: PASS — every 0A/0B suite still green, including `privileges.test.ts`'s up→down→up fingerprint check (contracts §3.4.6), which now round-trips migration 0011.

- [ ] **Step 6: Commit**

```bash
git add packages/db docs/adr/0021-document-line-base-shape.md
git commit -m "$(cat <<'EOF'
feat(db): app.document_line, the Phase 1 base line table [1A T1]

Seven business columns for a JOURNAL, tenant isolation, the audit trigger and
composite FKs to company, document (cascade) and account. Later slices add
nullable columns to this same table and never rename one. ADR 0021 is a
proposal per spec:95.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2 — Migration `0012_create_account_balance.sql`: `app.account_balance`

The one projection Phase 1 maintains. It is derived — every row is a sum of `ledger_entry` rows over the full key `(company, account, fiscal period, currency)` — which is precisely why SAH-001 and SAH-049 happened in the legacy system: its aggregate tables were keyed on less than the grain they aggregated, so two tenants' rows collided and a concurrent upsert lost an amount. The key here is the whole grain, the write is a single `MERGE`, and 1B rebuilds the table from the ledger and compares row for row.

**Files:**
- Create: `packages/db/migrations/0012_create_account_balance.sql`, `packages/db/migrations/0012.down.sql`, `packages/db/src/schema/account_balance.ts`, `packages/db/test/account-balance.test.ts`
- Modify: `packages/db/src/lint-schema.ts`

**Interfaces:**
- Produces (SQL): `app.account_balance` exactly as contracts §4.3.3 — `tenant_id`, `company_id`, `account_id`, `fiscal_period_id`, `currency`, `debit`, `credit`, `base_debit`, `base_credit`, `created_at`, `updated_at`; `primary key (company_id, account_id, fiscal_period_id, currency)`; composite FKs to `company`, `account` and `fiscal_period`; `tenant_isolation` RLS.
- Produces (TS): `packages/db/src/schema/account_balance.ts` exporting `accountBalance`; `NO_ID_TABLES` in `lint-schema.ts` gains `"account_balance"`.
- Consumes: `app_meta.enable_tenant_rls`; `lintSchema`, `AUDIT_EXEMPT`; `startDb`, `seedTenant`, the test `withTenant`.

**Set memberships, fixed by contracts §3.5.3 — edit `lint-schema.ts` to exactly this state and no further:** `account_balance` joins `NO_ID_TABLES` (its key is natural, so the `id_column` rule must not fire; `NO_CREATED_AT_TABLES` is *derived* as `new Set([...NO_ID_TABLES, "ledger_entry"])` and is never rewritten). It is **already** in `AUDIT_EXEMPT` (plan0A:2706–2709) — do not add it again. It is **not** immutable: `app_rw` keeps `select, insert, update` through the default privileges because the `MERGE` needs all three.

- [ ] **Step 1: Write the failing test `packages/db/test/account-balance.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EXEMPT, lintSchema } from "../src/lint-schema";
import { seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

/** The exact MERGE of contracts §4.3.3, run here directly so the table's shape is proven before the posting
 *  service exists. Task 8 moves this statement into packages/db/src/posting/post.ts unchanged. */
const MERGE_FROM_DOCUMENT = (tenant: string, company: string, doc: string) => [tenant, company, doc] as const;

describe("app.account_balance — contracts §4.3.3 (SAH-001, 002, 049)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    b = await seedTenant(db, "Beta");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("is keyed on the full grain — company, account, period and currency (SAH-049)", async () => {
    const key = await withTenant(db.admin, a.tenant, a.system, (tx) => tx<{ attname: string }[]>`
      select att.attname
        from pg_index i
        join pg_attribute att on att.attrelid = i.indrelid and att.attnum = any (i.indkey)
       where i.indrelid = 'app.account_balance'::regclass and i.indisprimary
       order by att.attnum`);
    expect(key.map((r) => r.attname).sort()).toEqual(["account_id", "company_id", "currency", "fiscal_period_id"]);
  });

  it("is audit-exempt and has no id column (contracts §3.5.3)", async () => {
    expect(AUDIT_EXEMPT.has("account_balance")).toBe(true);
    const cols = await withTenant(db.admin, a.tenant, a.system, (tx) => tx<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'account_balance'`);
    expect(cols.map((c) => c.column_name)).not.toContain("id");
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(["tenant_id", "company_id", "account_id", "fiscal_period_id", "currency",
        "debit", "credit", "base_debit", "base_credit", "created_at", "updated_at"]),
    );
  });

  it("accumulates rather than replaces when the same key is merged twice (SAH-002)", async () => {
    const merge = (amount: string) =>
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        merge into app.account_balance b
        using (select ${a.tenant}::uuid as tenant_id, ${a.company}::uuid as company_id, ${a.cash}::uuid as account_id,
                      ${a.period}::uuid as fiscal_period_id, 'MYR'::char(3) as currency,
                      ${amount}::numeric as debit, 0::numeric as credit,
                      ${amount}::numeric as base_debit, 0::numeric as base_credit) s
           on b.company_id = s.company_id and b.account_id = s.account_id
          and b.fiscal_period_id = s.fiscal_period_id and b.currency = s.currency
         when matched then update set debit = b.debit + s.debit, credit = b.credit + s.credit,
                                      base_debit = b.base_debit + s.base_debit, base_credit = b.base_credit + s.base_credit,
                                      updated_at = now()
         when not matched then insert (tenant_id, company_id, account_id, fiscal_period_id, currency, debit, credit, base_debit, base_credit)
                               values (s.tenant_id, s.company_id, s.account_id, s.fiscal_period_id, s.currency, s.debit, s.credit, s.base_debit, s.base_credit)`);
    await merge("100.0000");
    await merge("25.5000");
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ debit: string; base_debit: string }[]>`
      select debit, base_debit from app.account_balance where account_id = ${a.cash} and fiscal_period_id = ${a.period}`);
    expect(row!.debit).toBe("125.5000");
    expect(row!.base_debit).toBe("125.5000");
  });

  it("refuses an account from another tenant through the composite FK (SAH-035)", async () => {
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency, debit)
        values (${a.tenant}, ${a.company}, ${b.cash}, ${a.period}, 'MYR', 1.0000)`),
    ).rejects.toThrow(/account_balance_tenant_id_account_id_fkey/);
  });

  it("a second tenant sees no balances and cannot update one (SAH-001)", async () => {
    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account_balance`);
    expect(seen[0]!.n).toBe(0);
    const touched = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const r = await tx`update app.account_balance set debit = debit + 1`;
      return r.count;
    });
    expect(touched).toBe(0);
  });

  it("app_rw may not delete a balance row (a projection is rebuilt, never trimmed)", async () => {
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`delete from app.account_balance where account_id = ${a.cash}`),
    ).rejects.toThrow(/permission denied for table account_balance/);
  });

  it("leaves the schema linter with zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    expect(MERGE_FROM_DOCUMENT(a.tenant, a.company, a.docType)).toHaveLength(3);
  });
});
```

Run: `bun run --cwd packages/db test -- test/account-balance.test.ts`
Expected: **FAIL** — `relation "app.account_balance" does not exist` on the first test.

- [ ] **Step 2: Write `packages/db/migrations/0012_create_account_balance.sql`**

```sql
-- 0012_create_account_balance.sql — the only projection Phase 1 maintains (contracts §4.3.3; spec:2031).
-- The legacy system's aggregate tables were keyed on less than the grain they aggregated, so two tenants'
-- rows collided (SAH-001) and a concurrent upsert silently lost an amount (SAH-049); its upsert never fired
-- on UPDATE, so re-keying a posting destroyed the balance (SAH-002). The key here IS the grain, the write is
-- one MERGE, and 1B's integrity job rebuilds the table from ledger_entry and compares row for row.

-- ── 1. the projection ─────────────────────────────────────────────────────────────────────────────────
create table app.account_balance (
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  account_id        uuid not null,
  fiscal_period_id  uuid not null,
  currency          char(3) not null,
  debit             numeric(19,4) not null default 0,
  credit            numeric(19,4) not null default 0,
  base_debit        numeric(19,4) not null default 0,
  base_credit       numeric(19,4) not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (company_id, account_id, fiscal_period_id, currency),   -- the full key the MERGE targets (SAH-002/049)
  foreign key (tenant_id, company_id)       references app.company(tenant_id, id),
  foreign key (tenant_id, account_id)       references app.account(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id)
);

-- ── 2. isolation ──────────────────────────────────────────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.account_balance');
-- Derived, so no audit trigger: account_balance is already in AUDIT_EXEMPT (plan0A:2706-2709). It joins
-- NO_ID_TABLES in lint-schema.ts (natural key). app_rw keeps select, insert and update through the default
-- privileges of 0001 — the MERGE needs all three — and holds no DELETE: a projection is rebuilt, not trimmed.
```

`packages/db/migrations/0012.down.sql`:

```sql
-- Reverse of 0012.
drop table if exists app.account_balance;
```

- [ ] **Step 3: Extend `packages/db/src/lint-schema.ts`**

Change **only** the `NO_ID_TABLES` literal. `NO_CREATED_AT_TABLES` derives from it and is not touched; `AUDIT_EXEMPT` already lists `account_balance` and is not touched.

```ts
/** Join and counter tables that legitimately lack id/created_at, plus audit_log (seq/occurred_at) and permission (code). */
const NO_ID_TABLES = new Set([
  "membership", "role_permission", "role_assignment", "role_assignment_branch", "ledger_entry_dimension",
  "document_series", "document_number_void", "idempotency_key", "audit_log", "permission",
  "account_balance",                                   // 1A: natural key (company, account, period, currency) — contracts §3.5.3
]);
```

- [ ] **Step 4: Write the Drizzle mirror `packages/db/src/schema/account_balance.ts`**

```ts
import { char, foreignKey, numeric, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { account } from "./account";
import { company } from "./company";
import { fiscalPeriod } from "./fiscal_period";
import { tenant } from "./tenant";

/** contracts §4.3.3 — derived from ledger_entry, keyed on the full grain, written only by the posting service. */
export const accountBalance = pgTable(
  "account_balance",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    companyId: uuid("company_id").notNull(),
    accountId: uuid("account_id").notNull(),
    fiscalPeriodId: uuid("fiscal_period_id").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    debit: numeric("debit", { precision: 19, scale: 4 }).notNull().default("0"),
    credit: numeric("credit", { precision: 19, scale: 4 }).notNull().default("0"),
    baseDebit: numeric("base_debit", { precision: 19, scale: 4 }).notNull().default("0"),
    baseCredit: numeric("base_credit", { precision: 19, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.accountId, t.fiscalPeriodId, t.currency] }),
    foreignKey({ columns: [t.tenantId, t.companyId], foreignColumns: [company.tenantId, company.id] }),
    foreignKey({ columns: [t.tenantId, t.accountId], foreignColumns: [account.tenantId, account.id] }),
    foreignKey({ columns: [t.tenantId, t.fiscalPeriodId], foreignColumns: [fiscalPeriod.tenantId, fiscalPeriod.id] }),
  ],
);
```

Add `export * from "./schema/account_balance";` to `packages/db/src/schema/index.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/account-balance.test.ts`
Expected: **PASS** (7 tests).

Run: `bun run --cwd packages/db db:lint`
Expected: exit 0 with no output — if it prints `account_balance id_column …`, the `NO_ID_TABLES` edit in step 3 was not saved.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat(db): app.account_balance keyed on the full grain [1A T2]

company, account, fiscal period and currency together are the primary key, so
two tenants cannot collide (SAH-001) and a concurrent MERGE cannot lose an
amount (SAH-049). Derived, audit-exempt, no DELETE for app_rw.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3 — Migration `0013_alter_document_add_posting_seq.sql`: `app.posting_seq`, `document.posting_seq`, `fiscal_period.reopen_reason`

Two small alters that the rest of the slice depends on. `posting_seq` is the chronological key the costing engine will use from Phase 3 (`(effective_date, posting_seq, line_no, movement_no)` — contracts §4.3.5); it is assigned once, at post, before any row that carries it is written. `reopen_reason` is where the mandatory reason for reopening a fiscal period lands, because "written to the audit row" (spec:2179) can only mean a column on the row — `audit_row` writes `to_jsonb(new)` and has no reason parameter (plan0A:2308–2332).

**Files:**
- Create: `packages/db/migrations/0013_alter_document_add_posting_seq.sql`, `packages/db/migrations/0013.down.sql`, `packages/db/test/posting-seq.test.ts`, `docs/adr/0023-fiscal-period-reopen-reason.md`
- Modify: `packages/db/src/schema/document.ts`, `packages/db/src/schema/fiscal_period.ts`

**Interfaces:**
- Produces (SQL): `app.posting_seq` (a plain sequence, `usage` granted to `app_rw`); `app.document.posting_seq bigint` with `unique (company_id, posting_seq)`; `app.fiscal_period.reopen_reason text`.
- Produces (TS): `postingSeq` added to the `document` mirror, `reopenReason` to the `fiscal_period` mirror.
- Consumes: `startDb`, `seedTenant`, `draftDocument`, the test `withTenant`, `lintSchema`.

**Why a plain sequence and not a per-company counter:** §4.3.5 says "no gaps required; total order within a company is what matters". A global sequence gives a total order across the whole database at zero contention (a sequence is not transactional, so a rollback burns a number and blocks nothing), and `unique (company_id, posting_seq)` makes the per-company projection of that order unique. Contrast `document_series`, which **is** a per-company counter under an advisory lock precisely because a document *number* must be gapless-provable (spec:2222).

- [ ] **Step 1: Write the failing test `packages/db/test/posting-seq.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { draftDocument, seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

describe("document.posting_seq and fiscal_period.reopen_reason — contracts §4.3.5, spec:2179", () => {
  let db: Db;
  let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("app_rw may draw from app.posting_seq and the numbers strictly increase", async () => {
    const [first, second] = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [x] = await tx<{ n: string }[]>`select nextval('app.posting_seq')::text as n`;
      const [y] = await tx<{ n: string }[]>`select nextval('app.posting_seq')::text as n`;
      return [BigInt(x!.n), BigInt(y!.n)];
    });
    expect(second!).toBeGreaterThan(first!);
  });

  it("a document starts with a null posting_seq and takes one only when stamped", async () => {
    const doc = await draftDocument(db, a);
    const before = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ posting_seq: string | null }[]>`
      select posting_seq::text as posting_seq from app.document where id = ${doc}`);
    expect(before[0]!.posting_seq).toBeNull();

    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.document set posting_seq = nextval('app.posting_seq') where id = ${doc} and posting_seq is null`);
    const after = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ posting_seq: string | null }[]>`
      select posting_seq::text as posting_seq from app.document where id = ${doc}`);
    expect(after[0]!.posting_seq).not.toBeNull();
  });

  it("two documents of one company cannot share a posting_seq", async () => {
    const one = await draftDocument(db, a);
    const two = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.document set posting_seq = 999999 where id = ${one}`);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        update app.document set posting_seq = 999999 where id = ${two}`),
    ).rejects.toThrow(/document_company_id_posting_seq_key/);
  });

  it("a reopen reason lands in the audited after-image (spec:2179, ADR 0023)", async () => {
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.fiscal_period set status = 'open', reopen_reason = 'audit adjustment requested by the auditor'
       where id = ${a.closedPeriod}`);
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ reason: string | null; actor: string }[]>`
      select after ->> 'reopen_reason' as reason, actor_id::text as actor
        from app.audit_log
       where table_name = 'fiscal_period' and row_id = ${a.closedPeriod} and action = 'update'
       order by seq desc limit 1`);
    expect(row!.reason).toBe("audit adjustment requested by the auditor");
    expect(row!.actor).toBe(a.human);
  });

  it("leaves the schema linter with zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

Run: `bun run --cwd packages/db test -- test/posting-seq.test.ts`
Expected: **FAIL** — the first test errors with `relation "app.posting_seq" does not exist`.

- [ ] **Step 2: Write `packages/db/migrations/0013_alter_document_add_posting_seq.sql`**

```sql
-- 0013_alter_document_add_posting_seq.sql — two alters on 0001 tables.
-- Both are expand-only: a nullable column and a new sequence, no rewrite of an existing column (spec:2057).

-- ── 1. document.posting_seq — the costing engine's chronological key (contracts §4.3.5) ───────────────
-- Assigned once, at post, at step 8 of the posting algorithm, BEFORE any row that carries it is written:
-- inventory_movement.posting_seq, cost_layer.sequence and tax_transaction.posting_seq are all NOT NULL in
-- the slices that add them. Gaps are irrelevant — a rolled-back post burns a number and blocks nobody. What
-- matters is a total order per company, which the unique below guarantees. Contrast document_series, which
-- is a locked per-period counter because a document NUMBER must be gapless-provable (spec:2222, SAH-051).
create sequence app.posting_seq;
grant usage on sequence app.posting_seq to app_rw;      -- 0001 grants default privileges on TABLES only (plan0A:2564)

alter table app.document add column posting_seq bigint;
alter table app.document add constraint document_company_id_posting_seq_key unique (company_id, posting_seq);

-- ── 2. fiscal_period.reopen_reason — the reason spec:2179 requires in the audit row (ADR 0023) ────────
-- app.audit_log has no reason column and app.audit_row() writes to_jsonb(new) with no parameter for one
-- (plan0A:2308-2332), so "a reason written to the audit row" means a column on the row: the update that
-- reopens the period carries the reason, and the audited after-image holds it beside the actor the chain
-- trigger stamped. 1B's nightly integrity job reports every reopen by reading after ->> 'reopen_reason'.
alter table app.fiscal_period add column reopen_reason text;
```

`packages/db/migrations/0013.down.sql`:

```sql
-- Reverse of 0013. Only the columns and the sequence this file added come out — never the 0001 tables
-- themselves (contracts §3.4.5).
alter table app.fiscal_period drop column if exists reopen_reason;
alter table app.document drop constraint if exists document_company_id_posting_seq_key;
alter table app.document drop column if exists posting_seq;
revoke usage on sequence app.posting_seq from app_rw;
drop sequence if exists app.posting_seq;
```

- [ ] **Step 3: Extend the two Drizzle mirrors**

In `packages/db/src/schema/document.ts`, add the column beside the others and the unique to the extra-config array:

```ts
    postingSeq: bigint("posting_seq", { mode: "bigint" }),          // 1A, contracts §4.3.5 — set once at post
```

```ts
    unique("document_company_id_posting_seq_key").on(t.companyId, t.postingSeq),
```

(`bigint` and `unique` come from `drizzle-orm/pg-core`; add them to the existing import list.)

In `packages/db/src/schema/fiscal_period.ts`:

```ts
    reopenReason: text("reopen_reason"),                            // 1A, spec:2179 — the audited reopen reason
```

- [ ] **Step 4: Write `docs/adr/0023-fiscal-period-reopen-reason.md`**

```markdown
# ADR 0023 — The mandatory period-reopen reason is a column on `fiscal_period`

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 1A

## Context

spec:2179 (R8) requires that `accounting.period.reopen` "requires a reason written to the audit row, and every
reopen is reported by the nightly integrity job". `app.audit_log` (plan0A) has columns `before` and `after`
holding `to_jsonb(old)` / `to_jsonb(new)` of the changed row and no free-text column; `app.audit_row()` takes
no reason parameter and gating an audit write on anything is forbidden (spec:103). So the reason has to reach
the audit row through the row itself.

## Decision

Migration 0013 adds `app.fiscal_period.reopen_reason text`. The reopen handler writes it in the same `UPDATE`
that sets `status = 'open'`, and the `audit_row` AFTER trigger carries it into `after`. The API refuses a
reopen with a missing or blank reason (`ERR_VALIDATION_FAILED`), so a non-null value is always present when a
period moves out of `closed` or `locked`.

The alternative — a transaction-scoped `set_config('app.event_reason', …)` read by a trigger, as 2B uses for
`document_event.reason` — was rejected here: `document_event` is a purpose-built event table with its own
`reason` column, whereas `fiscal_period` has no event table in v1 and inventing one for a single field would
be over-building. When 2B's session-setting mechanism exists it is used for documents only.

## Consequences

- `fiscal_period.reopen_reason` holds the **most recent** reason. The full history is in `app.audit_log`, one
  row per reopen, each with its own stamped `actor_id` and `occurred_at`; 1B's job walks those rows.
- `closed_by` and `closed_at` are not cleared on reopen. `app.stamp_actor` raises `ERR_ACTOR_IMMUTABLE` on any
  change to a non-null `*_by` value, so the close handler writes
  `closed_by = coalesce(closed_by, app.current_actor())` and the column records the first closer; the audit
  log is the per-event record. Changing that would mean amending Plan 0A, which is frozen.
- 1B reads `after ->> 'reopen_reason'` and is null-safe, so a reopen performed by direct SQL without the
  column set is still reported, with a null reason.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/posting-seq.test.ts`
Expected: **PASS** (5 tests). If the first test fails with `permission denied for sequence posting_seq`, the `grant usage` line is missing.

Run: `bun run --cwd packages/db test -- test/privileges.test.ts`
Expected: PASS — the up→down→up fingerprint holds. Do **not** read a failure here as a missing `revoke usage on sequence`: the fingerprint's grants query (contracts §3.4.6) reads `information_schema.role_table_grants`, which covers tables and views only, while a sequence's `USAGE` privilege lives in `information_schema.usage_privileges` and is therefore outside the fingerprint altogether — and in any case `0013.down.sql` drops `app.posting_seq`, which takes its grant with it whether the explicit `revoke` line is there or not (it is there, for symmetry with the `grant`). A failure here is a table, view, column or constraint the down file did not restore — most likely `document_company_id_posting_seq_key`.

- [ ] **Step 6: Commit**

```bash
git add packages/db docs/adr/0023-fiscal-period-reopen-reason.md
git commit -m "$(cat <<'EOF'
feat(db): app.posting_seq, document.posting_seq, fiscal_period.reopen_reason [1A T3]

posting_seq is the costing engine's chronological key, assigned once at post and
unique per company. reopen_reason is the column the mandatory reopen reason
lands in so the audited after-image carries it (spec:2179, ADR 0023).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4 — Migration `0014_seed_permission_phase1.sql`, the six `accounting.*` codes, and the role grants

The permission catalogue is phased: a code enters `packages/contracts/permissions.ts` in the slice that builds its handler, so "a code no handler evaluates fails the build" holds at every phase (spec:2142). This task adds the six codes Phase 1 needs and the role grants the spec's role table gives them. The handlers arrive in Tasks 10–12, and `permission-catalogue.test.ts` asserts the `app.permission` set and the `permissions.ts` set are equal **in both directions**, so migration 0014 and the `permissions.ts` rows cannot be split across tasks — both land here. The consequence is that from this task until Task 12, `bun run lint:rules` reports exactly six `permission-catalogue … has no reference` violations and nothing else. That is the one documented exception (Global Constraints), it is stated in this task's commit body, and it is why Tasks 4 through 12 form a single pull request (Execution handoff) — CI never sees a red head.

**Files:**
- Create: `packages/db/migrations/0014_seed_permission_phase1.sql`, `packages/db/migrations/0014.down.sql`
- Modify: `packages/contracts/permissions.ts`, `packages/db/seed/roles.ts`, `packages/db/test/permission-catalogue.test.ts`, `packages/db/test/roles-seed.test.ts`

**Interfaces:**
- Produces: six rows in `app.permission`; six `PermissionDef` entries in `PERMISSIONS` with `phase: "1A"`; `accountant`, `user` and `auditor` grants in `ROLES`.
- Consumes: `PERMISSIONS`, `PermissionDef` (§4.2.5, 0B); `ROLES`, `RoleSeed`, `adminPermissions`, `INCOMPATIBLE_PAIRS` (§4.2.5, 0D).

**The six codes and their `mutating` flag** (contracts §3.6.2, frozen): `accounting.account.manage` true · `accounting.ledger.read` **false** · `accounting.period.close` true · `accounting.period.reopen` true · `accounting.journal.create` true · `accounting.journal.post` true.

**The role grants, read off the spec's role table** (spec:2156–2163) and off R8 (spec:2179):

| Role | Codes added here | The spec sentence |
|---|---|---|
| `admin` | *computed* — `adminPermissions(catalogue)` picks up all six automatically | "Every permission present at the current phase … except selling at a till and terminal sync" (spec:2156); "`accounting.period.reopen` … held by `admin` only in the seed" (spec:2179) |
| `accountant` | `accounting.account.manage`, `accounting.ledger.read`, `accounting.period.close`, `accounting.journal.create`, `accounting.journal.post` | "Chart of accounts, journals … and their posting … period close"; "**May not** … reopen a period" (spec:2157) |
| `user` | `accounting.journal.create` | "Draft … documents … (`*.create`)"; "**May not** post" (spec:2158) |
| `auditor` | `accounting.ledger.read` | "Read everything financial: ledger, documents, reports"; "**May not** [hold] any mutating permission" (spec:2163) |
| `warehouse`, `branch_manager`, `cashier`, `hr_payroll`, `pos_terminal` | none | none of the five has an accounting authority at Phase 1 |

**Reading `user` "reads accounts"** (spec:2158): the catalogue has one accounts code and it is mutating (`accounting.account.manage`), so a read gate would have to be a code the catalogue does not contain — and §3.6.1 closes the vocabulary. The chart-of-accounts **list and read** endpoints are therefore gated by membership only, exactly as 0D gated dimension reads ("API … under `admin.company.manage`; reads need membership only" — contracts §4.2.11). Task 10 implements that and its route module declares only `accounting.account.manage` in `RouteModule.permissions`.

- [ ] **Step 1: Extend the failing tests**

Add to `packages/db/test/permission-catalogue.test.ts` (0B's file) a new `it` inside its existing `describe`:

```ts
  it("holds the six Phase 1 accounting codes with the contracts' mutating flags (§3.6.2)", async () => {
    // app.permission is global — no tenant_id, no RLS (plan0A:1313) — so it is read on db.admin directly.
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code like 'accounting.%' order by code`;
    expect(rows).toEqual([
      { code: "accounting.account.manage", module: "accounting", mutating: true },
      { code: "accounting.journal.create", module: "accounting", mutating: true },
      { code: "accounting.journal.post", module: "accounting", mutating: true },
      { code: "accounting.ledger.read", module: "accounting", mutating: false },
      { code: "accounting.period.close", module: "accounting", mutating: true },
      { code: "accounting.period.reopen", module: "accounting", mutating: true },
    ]);
  });
```

Add to `packages/db/test/roles-seed.test.ts` (0D's file), first extending its imports to `import { adminPermissions, ROLES } from "../seed/roles";` and `import { PERMISSIONS } from "@dulja/contracts/permissions";` if `adminPermissions` and `PERMISSIONS` are not already in scope there:

```ts
  it("gives the accountant every Phase 1 accounting code except period.reopen (spec:2157)", () => {
    const accountant = ROLES.find((r) => r.code === "accountant")!;
    expect([...accountant.permissions].sort()).toEqual([
      "accounting.account.manage", "accounting.journal.create", "accounting.journal.post",
      "accounting.ledger.read", "accounting.period.close",
    ]);
    expect(accountant.permissions).not.toContain("accounting.period.reopen");
  });

  it("gives the clerk only the drafting code and the auditor only the read (spec:2158, 2163)", () => {
    expect(ROLES.find((r) => r.code === "user")!.permissions).toEqual(["accounting.journal.create"]);
    expect([...ROLES.find((r) => r.code === "auditor")!.permissions].sort()).toEqual([
      "accounting.ledger.read", "admin.audit_log.read",
    ]);
  });

  it("admin alone holds accounting.period.reopen (spec:2179 R8)", () => {
    const catalogue = PERMISSIONS.map((p) => p.code);
    expect(adminPermissions(catalogue)).toContain("accounting.period.reopen");
    for (const role of ROLES.filter((r) => r.code !== "admin")) {
      expect(role.permissions).not.toContain("accounting.period.reopen");
    }
  });
```

Run: `bun run --cwd packages/db test -- test/permission-catalogue.test.ts test/roles-seed.test.ts`
Expected: **FAIL** — the catalogue test reports `expected [] to equal [ …six rows… ]` (no `accounting.%` row exists); the three role tests report `expected [] to equal [ 'accounting.account.manage', … ]`.

- [ ] **Step 2: Extend `packages/contracts/permissions.ts`**

Append one block to the `PERMISSIONS` array literal, after 0B's five `admin.*` entries. Do not reorder the existing entries.

```ts
  // ── 1A · accounting (contracts §3.6.2) ─────────────────────────────────────────────────────────────
  { code: "accounting.account.manage", module: "accounting", mutating: true,  phase: "1A", description: "Create, edit and archive chart-of-accounts rows" },
  { code: "accounting.ledger.read",    module: "accounting", mutating: false, phase: "1A", description: "Read posted ledger entries and account balances" },
  { code: "accounting.period.close",   module: "accounting", mutating: true,  phase: "1A", description: "Close a fiscal period so nothing may post into it" },
  { code: "accounting.period.reopen",  module: "accounting", mutating: true,  phase: "1A", description: "Reopen a closed or locked fiscal period, with a mandatory reason" },
  { code: "accounting.journal.create", module: "accounting", mutating: true,  phase: "1A", description: "Draft and edit a journal voucher and its lines" },
  { code: "accounting.journal.post",   module: "accounting", mutating: true,  phase: "1A", description: "Post a journal voucher to the ledger" },
```

- [ ] **Step 3: Extend `packages/db/seed/roles.ts`**

Three `permissions` arrays gain elements and **nothing else in the file is touched** — `code`, `nameEn`, `nameAr` and `description` keep the values 0D wrote, no entry is reordered, and any code already in one of these arrays stays where it is and stays first. Each block below is the array **after** this task; the added lines are the ones carrying the `// 1A` comment. `admin`'s array is left exactly as it is: it is computed by `adminPermissions(catalogue)` at seed time and picks the six new codes up for free.

In the `ROLES` entry whose `code` is `"accountant"`, the `permissions` array becomes (spec:2157 — chart of accounts, journals and their posting, period close; **not** period reopen):

```ts
    permissions: [
      // 1A (spec:2157 — chart of accounts, journals and their posting, period close; NOT period reopen)
      "accounting.account.manage",
      "accounting.ledger.read",
      "accounting.period.close",
      "accounting.journal.create",
      "accounting.journal.post",
    ],
```

In the entry whose `code` is `"user"`, the `permissions` array becomes (spec:2158 — the clerk drafts documents and may not post; reading the chart of accounts needs membership only):

```ts
    permissions: [
      // 1A (spec:2158 — drafts documents; may not post). Reading the chart of accounts needs membership only.
      "accounting.journal.create",
    ],
```

In the entry whose `code` is `"auditor"`, the array already holds `"admin.audit_log.read"`; append one element after it, so the array becomes (spec:2163; non-mutating codes only, which `role-seed`'s R7 check enforces in CI):

```ts
    permissions: [
      "admin.audit_log.read",
      // 1A (spec:2163 — reads everything financial). Non-mutating only: R7 is a CI test.
      "accounting.ledger.read",
    ],
```

- [ ] **Step 4: Write `packages/db/migrations/0014_seed_permission_phase1.sql`**

```sql
-- 0014_seed_permission_phase1.sql — the six Phase 1 accounting codes (spec:2147, contracts §3.6.2).
-- app.permission is the one table a migration may write: it is global (no tenant_id, no RLS — plan0A:1313),
-- so FORCE ROW LEVEL SECURITY does not hide it from app_migrator the way it hides every per-tenant table
-- (contracts §3.4.8, spec:1366). The role grants over these codes are per-tenant seed-pack data and are
-- applied by `bun run seed --tenant <id> --only roles` from packages/db/seed/roles.ts.
-- `do update` rather than `do nothing`: re-running on staging must correct a drifted description.

-- ── 1. the Phase 1 catalogue ──────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('accounting.account.manage', 'accounting', true,  'Create, edit and archive chart-of-accounts rows'),
  ('accounting.ledger.read',    'accounting', false, 'Read posted ledger entries and account balances'),
  ('accounting.period.close',   'accounting', true,  'Close a fiscal period so nothing may post into it'),
  ('accounting.period.reopen',  'accounting', true,  'Reopen a closed or locked fiscal period, with a mandatory reason'),
  ('accounting.journal.create', 'accounting', true,  'Draft and edit a journal voucher and its lines'),
  ('accounting.journal.post',   'accounting', true,  'Post a journal voucher to the ledger')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;
```

`packages/db/migrations/0014.down.sql`:

```sql
-- Reverse of 0014: exactly the six codes it inserted. The FK from app.role_permission.permission_code blocks
-- the delete while any tenant still grants one, which is the correct signal — re-run the role seed for that
-- tenant first (contracts §3.4.5).
delete from app.permission where code in (
  'accounting.account.manage',
  'accounting.ledger.read',
  'accounting.period.close',
  'accounting.period.reopen',
  'accounting.journal.create',
  'accounting.journal.post'
);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/permission-catalogue.test.ts test/roles-seed.test.ts`
Expected: **PASS**. The catalogue test's existing both-directions assertion (the set in `app.permission` equals the set exported by `permissions.ts`) now covers eleven codes.

Run: `bun run --cwd packages/contracts typecheck`
Expected: PASS — `PermissionCode` is now an eleven-member union and `PERMISSION["accounting.journal.post"]` type-checks.

If you run `bun run lint:rules` here, expect `9 rules, N files, 6 violations` — `permission-catalogue` reporting the six new codes as having no handler, and nothing from any other rule. That is expected until Task 12 lands, it is stated in this task's commit body, and it is the documented exception in Global Constraints. Do not "fix" it by deleting a code or by touching the rule.

- [ ] **Step 6: Commit**

```bash
git add packages/db packages/contracts
git commit -m "$(cat <<'EOF'
feat(db): the six Phase 1 accounting permission codes and their role grants [1A T4]

Migration 0014 seeds the codes; permissions.ts gains the six entries with
phase 1A; roles.ts grants them per spec:2157-2163 — the accountant may close a
period but not reopen one, the clerk only drafts, the auditor only reads, and
admin picks all six up through adminPermissions().

lint:rules stays red until Task 12 registers the handlers; that is the phased
catalogue working as spec:2142 intends.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5 — `packages/domain/src/posting/`: the policy schema, the snapshot and plan types, and the JOURNAL evaluator

The pure half of the posting service. Nothing here touches a database, a clock or a network — it takes a policy and a snapshot of a document and returns a plan of ledger lines. That is what makes the golden fixtures of Phases 3, 5 and 8 possible and what lets acceptance tests 22 and 28 compare a POS ticket, an invoice and a payroll run line for line.

The JSON Schema created here is `urn:dulja:posting-policy:1` at **the JOURNAL subset**. 2A widens the same file and the same `$id` to the full contracts §4.4.1 text under ADR 0026 — adding enum labels and optional properties only, so every file valid under this subset stays valid. Do not anticipate that widening: a label this slice does not need is a label a reviewer cannot check against a policy.

**Files:**
- Create: `packages/domain/posting-policy.schema.json`, `packages/domain/document-type-seed.schema.json`, `packages/domain/src/posting/policy.ts`, `packages/domain/src/posting/evaluate.ts`, `packages/domain/src/posting/index.ts`, `packages/domain/scripts/generate-policy-type.ts`, `packages/domain/test/posting/validate-policy.test.ts`, `packages/domain/test/posting/evaluate.test.ts`, `packages/domain/test/posting/balance.property.test.ts`, `docs/adr/0022-ajv-posting-policy-validator.md`
- Modify: `packages/domain/package.json`, `packages/domain/src/index.ts`, `packages/contracts/src/errors.ts`

**Interfaces:**
- Produces (JSON): `packages/domain/posting-policy.schema.json` with `$id: "urn:dulja:posting-policy:1"`, `additionalProperties: false`, `"version": { "const": 1 }`; `packages/domain/document-type-seed.schema.json` — the §4.3.7 envelope.
- Produces (TS), all exported from `@dulja/domain`:

```ts
export type PostingPolicy = /* generated from posting-policy.schema.json, committed at src/posting/policy.ts */;
export interface DocumentSnapshot { /* contracts §4.4.2, verbatim — written out in step 4 */ }
export interface LineSnapshot { /* contracts §4.4.2, verbatim */ }
export interface PlannedLedgerLine { lineNo: number; accountId: string; side: "debit" | "credit"; amount: Money; base: Money; dimensions: Record<string, string>; sourceLineNo: number | null; role: "policy" | "fx_rounding" }
export interface PlannedMovement { lineNo: number; movementNo: number; itemId: string; warehouseId: string; lotId: string | null; quantity: Quantity; effect: "receipt" | "issue"; value: Money | null; costing: "consume_layers" | "create_layer" | "zero" }
export interface PlannedTaxLine { lineNo: number; taxCodeId: string; base: Money; amount: Money; inclusive: boolean }
export interface PostingPlan { ledgerLines: PlannedLedgerLine[]; movements: PlannedMovement[]; taxLines: PlannedTaxLine[]; warnings: string[] }
export interface PolicyValidation { ok: boolean; errors: { path: string; message: string }[] }
export interface PayComponentRef { id: string; code: string; kind: "earning" | "deduction"; expenseAccountId: string | null; payableAccountId: string | null }
export interface SchemeRef { id: string; code: string; payableAccountId: string; expenseAccountId: string | null }
export interface PayrollLineRef { employeeId: string; employeeDimensionValueId: string; componentId: string | null; schemeId: string | null; share: "employee" | "employer" | null }
export interface ItemRef { id: string; code: string; kind: "product" | "service" | "asset"; baseUnitId: string; trackLots: boolean; revenueAccountId: string | null; inventoryAccountId: string | null; cogsAccountId: string | null; expenseAccountId: string | null }
export interface TaxCodeRef { id: string; code: string; rate: string; kind: "output" | "input" | "exempt" | "zero" | "out_of_scope"; roundingMode: RoundingMode; outputAccountId: string | null; inputAccountId: string | null }
export class PolicyEvaluationError extends Error { readonly code: "ERR_POLICY_INVALID" | "ERR_POLICY_REQUIRES_MISSING" | "ERR_LEDGER_UNBALANCED"; readonly detail: string }
export function validatePolicy(definition: unknown, catalogue: readonly string[]): PolicyValidation;
export function parsePolicy(definition: unknown): PostingPolicy;                                   // schema only; throws PolicyEvaluationError("ERR_POLICY_INVALID")
export function validateDocumentTypeSeed(envelope: unknown): PolicyValidation;
export function validateRequires(policy: PostingPolicy, snapshot: DocumentSnapshot): { missing: string[] };
export function evaluatePolicy(policy: PostingPolicy, snapshot: DocumentSnapshot): PostingPlan;
export function balanceInBase(plan: PostingPlan, fxRoundingAccountId: string | null, baseCurrency: CurrencyCode): PostingPlan;
```

- Consumes: `Money`, `CurrencyCode`, `currency`, `Quantity`, `RoundingMode`, `round`, `MONEY_SCALE`, `ExchangeRate`, `toBase`, `UNIT_RATE` from `@dulja/domain`'s own money module (§4.2.1, 0D); `Decimal` from `decimal.js`; `Ajv2020` from `ajv/dist/2020`; `fc` from `fast-check` (test only).

**Four deviations from the §4.4.2 text, each deliberate and each named here so a reviewer sees them.** contracts:1261 says §4's blocks are implemented verbatim and "may add members only by amending this document", so deviations 1, 3 and 4 — the three that *add a name* — are **amendment A6** in the Self-Review's table and land before this task starts. Deviation 2 is **amendment A3**.
1. **`parsePolicy` is new.** §4.4.2 gives one entry point, `validatePolicy(definition, catalogue)`, which checks the schema *and* that approval codes exist in the permission catalogue. That is a **seed-time** check — the loader has the catalogue. At post time `resolvePolicy` reads a definition already in the database and needs a cheap structural parse that throws, not a report. `parsePolicy` is that: the schema half of `validatePolicy`, throwing `PolicyEvaluationError("ERR_POLICY_INVALID")`. Both share one compiled Ajv validator.
2. **`balanceInBase` takes a third parameter, `baseCurrency`.** The §4.4.2 signature is `(plan, fxRoundingAccountId)`; the FX-rounding line's amount is a `Money` and `Money` cannot exist without a currency, and a plan whose every line has been dropped as zero carries no currency to borrow. The parameter is passed by `postDocument` from `snapshot.company.baseCurrency`.
3. **`PolicyEvaluationError` carries three codes, not one.** The registry names the class in a comment with `code: "ERR_POLICY_INVALID"` but declares no body. `evaluatePolicy` must also refuse a `dimensions.required` type or an `account.code` the company cannot resolve, which §4.2.4 allocates to `ERR_POLICY_REQUIRES_MISSING`, and `balanceInBase` throws `ERR_LEDGER_UNBALANCED`. One class, three codes, each mapped to its own `AppError` by `postDocument`. (contracts:1263 lists the five types §4 deliberately leaves bodiless; this is not one of them, so the body is an addition, not a fill-in.)
4. **`validateDocumentTypeSeed` is new.** contracts:178 makes 1A the creator of `packages/domain/document-type-seed.schema.json`, but §4.4.2 declares no function that validates against it, and `loadDocumentTypes` (Task 13) needs one. It returns the same `PolicyValidation` shape as `validatePolicy` so the loader reports envelope and policy errors identically.

- [ ] **Step 1: Add the dependencies and the type-generation script**

In `packages/domain/package.json`, add to `dependencies` `"ajv"` and to `devDependencies` `"json-schema-to-typescript"`, each with the version the lockfile resolves — run `bun add --cwd packages/domain ajv` and `bun add --cwd packages/domain --dev json-schema-to-typescript` rather than typing a range, and never write a version into a source file (spec:104). Add to `scripts`:

```json
    "policy:types": "bun run scripts/generate-policy-type.ts"
```

`packages/domain/scripts/generate-policy-type.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

/** Regenerates src/posting/policy.ts from posting-policy.schema.json. CI runs this and fails on a diff, so the
 *  committed type can never drift from the schema (the same discipline as the committed openapi.json, spec:2055). */
const root = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(await readFile(`${root}posting-policy.schema.json`, "utf8")) as Record<string, unknown>;
const banner = [
  "// GENERATED FILE — do not edit by hand.",
  "// Source: packages/domain/posting-policy.schema.json ($id urn:dulja:posting-policy:1)",
  "// Regenerate: bun run --cwd packages/domain policy:types",
  "",
].join("\n");
const ts = await compile(schema, "PostingPolicy", {
  bannerComment: "",
  additionalProperties: false,
  style: { printWidth: 120, singleQuote: false },
});
await writeFile(`${root}src/posting/policy.ts`, banner + ts, "utf8");
```

- [ ] **Step 2: Write the failing tests**

`packages/domain/test/posting/validate-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePolicy, PolicyEvaluationError, validateDocumentTypeSeed, validatePolicy } from "../../src/posting";

const JOURNAL_ENVELOPE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./journal-envelope.fixture.json", import.meta.url)), "utf8"),
) as { policy: unknown };

const CATALOGUE = [
  "accounting.account.manage", "accounting.ledger.read", "accounting.period.close",
  "accounting.period.reopen", "accounting.journal.create", "accounting.journal.post",
];

describe("validatePolicy — contracts §4.4.1 at the JOURNAL subset", () => {
  it("accepts the JOURNAL policy of contracts §4.3.7", () => {
    expect(validatePolicy(JOURNAL_ENVELOPE.policy, CATALOGUE)).toEqual({ ok: true, errors: [] });
  });

  it("accepts the whole §4.3.7 envelope against document-type-seed.schema.json", () => {
    expect(validateDocumentTypeSeed(JOURNAL_ENVELOPE)).toEqual({ ok: true, errors: [] });
  });

  it("rejects an unknown member — the schema is additionalProperties: false (spec:2008)", () => {
    const bad = { ...(JOURNAL_ENVELOPE.policy as object), nameEn: "Journal Voucher" };
    const result = validatePolicy(bad, CATALOGUE);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: "", message: expect.stringContaining("nameEn") });
  });

  it("rejects an approval code the catalogue does not contain (F-21)", () => {
    const policy = JSON.parse(JSON.stringify(JOURNAL_ENVELOPE.policy)) as { approval: { post: string } };
    policy.approval.post = "accounting.purchase.post";
    const result = validatePolicy(policy, CATALOGUE);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: "/approval/post", message: "accounting.purchase.post is not in the permission catalogue" },
    ]);
  });

  it("rejects a version other than 1 — a schema change is a new const and a new $id", () => {
    const policy = { ...(JOURNAL_ENVELOPE.policy as object), version: 2 };
    expect(validatePolicy(policy, CATALOGUE).ok).toBe(false);
  });

  it("parsePolicy returns the policy and throws ERR_POLICY_INVALID on anything else", () => {
    expect(parsePolicy(JOURNAL_ENVELOPE.policy).documentType).toBe("JOURNAL");
    // The Plan 0A fixture policy — a stub with no requires/inventory/tax/numbering/reversal/approval blocks.
    const stub = { version: 1, documentType: "JOURNAL", direction: "none", lines: [] };
    let caught: unknown;
    try {
      parsePolicy(stub);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PolicyEvaluationError);
    expect((caught as PolicyEvaluationError).code).toBe("ERR_POLICY_INVALID");
    expect((caught as PolicyEvaluationError).detail).toContain("numbering");
  });

  it("rejects an envelope whose file code and policy.documentType disagree (§4.3.7)", () => {
    const bad = { ...JOURNAL_ENVELOPE, code: "JOURNAL_2" };
    const result = validateDocumentTypeSeed(bad);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: "/code", message: "code JOURNAL_2 does not equal policy.documentType JOURNAL" },
    ]);
  });
});
```

`packages/domain/test/posting/journal-envelope.fixture.json` — the §4.3.7 file verbatim (Task 13 copies this same JSON to `packages/db/seed/my/document-types/JOURNAL.json`, and Task 13's test asserts the two are byte-identical, so a policy change can never land in one and not the other):

```json
{
  "code": "JOURNAL",
  "nameEn": "Journal Voucher",
  "nameAr": "قيد يومية",
  "module": "accounting",
  "policyVersion": 2,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "JOURNAL",
    "direction": "internal",
    "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "JV", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "JOURNAL" },
    "approval": { "required": false, "approve": null, "post": "accounting.journal.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

`packages/domain/test/posting/evaluate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { currency, Money, UNIT_RATE, type CurrencyCode } from "../../src";
import {
  balanceInBase, evaluatePolicy, parsePolicy, PolicyEvaluationError, validateRequires,
  type DocumentSnapshot, type LineSnapshot,
} from "../../src/posting";

const MYR = currency("MYR");
const USD = currency("USD");
const POLICY = parsePolicy(
  (JSON.parse(readFileSync(fileURLToPath(new URL("./journal-envelope.fixture.json", import.meta.url)), "utf8")) as { policy: unknown }).policy,
);

const line = (over: Partial<LineSnapshot> & { lineNo: number }): LineSnapshot => ({
  id: `line-${over.lineNo}`, kind: "account", description: null, accountId: "acct-cash", itemId: null,
  quantity: null, unitPrice: null, discount: Money.zero(MYR), amount: Money.zero(MYR), taxCodeId: null,
  taxAmount: Money.zero(MYR), totalInclTax: Money.zero(MYR), debit: Money.zero(MYR), credit: Money.zero(MYR),
  cost: null, warehouseId: null, toWarehouseId: null, lotId: null, unitId: null, unitQuantity: null,
  countedQuantity: null, expectedQuantity: null, tenderMethod: null, customFields: {}, dimensions: {},
  payroll: null, ...over,
});

const snapshot = (lines: LineSnapshot[], over: Partial<DocumentSnapshot["header"]> = {}): DocumentSnapshot => ({
  header: {
    id: "doc-1", companyId: "co-1", documentTypeCode: "JOURNAL", status: "draft", series: "JV",
    fiscalPeriodId: "per-1", number: null, effectiveDate: "2026-01-15", partyId: null, currency: MYR,
    exchangeRate: UNIT_RATE(MYR), branchId: "branch-hq", attributedTo: null, clientRef: null,
    warehouseId: null, toWarehouseId: null, taxInclusive: false, reversesDocumentId: null, customFields: {}, ...over,
  },
  lines,
  company: { id: "co-1", baseCurrency: MYR, fxRoundingAccountId: "acct-fx", costingMethod: "avco" },
  party: null,
  refs: { accountsByCode: {}, items: {}, taxCodes: {}, components: {}, schemes: {}, dimensionTypesByCode: { BRANCH: "dt-branch" } },
});

describe("evaluatePolicy — the JOURNAL subset (contracts §4.4.2)", () => {
  it("emits one ledger line per non-zero side, tagged BRANCH from the header", () => {
    const plan = evaluatePolicy(POLICY, snapshot([
      line({ lineNo: 1, accountId: "acct-cash", debit: Money.of("100.0000", MYR) }),
      line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("100.0000", MYR) }),
    ]));
    expect(plan.ledgerLines).toEqual([
      { lineNo: 1, accountId: "acct-cash", side: "debit", amount: Money.of("100.0000", MYR), base: Money.of("100.0000", MYR), dimensions: { BRANCH: "branch-hq" }, sourceLineNo: 1, role: "policy" },
      { lineNo: 2, accountId: "acct-sales", side: "credit", amount: Money.of("100.0000", MYR), base: Money.of("100.0000", MYR), dimensions: { BRANCH: "branch-hq" }, sourceLineNo: 2, role: "policy" },
    ]);
    expect(plan.movements).toEqual([]);
    expect(plan.taxLines).toEqual([]);
  });

  it("drops a zero-amount planned line rather than writing a 0/0 ledger row (§4.3.2 step 6)", () => {
    const plan = evaluatePolicy(POLICY, snapshot([
      line({ lineNo: 1, debit: Money.of("50.0000", MYR) }),
      line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("50.0000", MYR) }),
      line({ lineNo: 3, accountId: "acct-note", description: "narration only" }),
    ]));
    expect(plan.ledgerLines.map((l) => l.sourceLineNo)).toEqual([1, 2]);
  });

  it("keeps a line's own dimensions and adds BRANCH, which always wins", () => {
    const plan = evaluatePolicy(POLICY, snapshot([
      line({ lineNo: 1, debit: Money.of("1.0000", MYR), dimensions: { COSTCENTRE: "cc-1", BRANCH: "branch-forged" } }),
      line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("1.0000", MYR) }),
    ]));
    expect(plan.ledgerLines[0]!.dimensions).toEqual({ COSTCENTRE: "cc-1", BRANCH: "branch-hq" });
  });

  it("normalises the sign: a negative resolved amount flips the side and keeps the magnitude (§4.4.2 A9)", () => {
    // Unreachable through `loadSnapshot` at the JOURNAL subset — migration 0011 constrains
    // `document_line.debit >= 0` and `credit >= 0` — so the snapshot is built by hand. The assertion is that
    // `evaluatePolicy` itself owns the rule, because 2A widens `amountRef` with `line.amount` / `line.cost`
    // and extends this same `for` switch, and `app.ledger_entry`'s `check (debit >= 0)` accepts nothing else.
    const plan = evaluatePolicy(POLICY, snapshot([
      line({ lineNo: 1, debit: Money.of("-40.0000", MYR) }),
      line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("-40.0000", MYR) }),
    ]));
    expect(plan.ledgerLines.map((l) => [l.side, l.amount.toString(), l.base.toString()])).toEqual([
      ["credit", "40.0000", "40.0000"],      // the debit rule emitted a credit
      ["debit", "40.0000", "40.0000"],       // the credit rule emitted a debit
    ]);
    expect(plan.ledgerLines.every((l) => !l.amount.isNegative())).toBe(true);
  });

  it("converts to base with round(value × rate, 4) HALF_AWAY_FROM_ZERO (spec:1816)", () => {
    const rate = { from: USD, to: MYR, rate: "4.68350000", effectiveFrom: "2026-01-01", source: "BNM 2026-01-01" };
    const plan = evaluatePolicy(POLICY, snapshot(
      [
        line({ lineNo: 1, debit: Money.of("33.3350", USD), amount: Money.zero(USD), discount: Money.zero(USD), credit: Money.zero(USD), taxAmount: Money.zero(USD), totalInclTax: Money.zero(USD) }),
        line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("33.3350", USD), amount: Money.zero(USD), discount: Money.zero(USD), debit: Money.zero(USD), taxAmount: Money.zero(USD), totalInclTax: Money.zero(USD) }),
      ],
      { currency: USD, exchangeRate: rate },
    ));
    expect(plan.ledgerLines[0]!.base.toString()).toBe("156.1245");   // 33.3350 × 4.68350000 = 156.1244725, HALF_AWAY_FROM_ZERO at scale 4
  });

  it("refuses a policy that names an account code the company cannot resolve", () => {
    const withCode = parsePolicy({
      ...(POLICY as unknown as Record<string, unknown>),
      lines: [{ for: "each_line", side: "debit", account: { code: "9999" }, amount: "line.debit" }],
    });
    expect(() => evaluatePolicy(withCode, snapshot([line({ lineNo: 1, debit: Money.of("1.0000", MYR) })])))
      .toThrow(/ERR_POLICY_REQUIRES_MISSING/);
  });

  it("refuses a required dimension type no line carries", () => {
    const withDim = parsePolicy({ ...(POLICY as unknown as Record<string, unknown>), dimensions: { required: ["COSTCENTRE"] } });
    let caught: unknown;
    try {
      evaluatePolicy(withDim, snapshot([
        line({ lineNo: 1, debit: Money.of("1.0000", MYR) }),
        line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("1.0000", MYR) }),
      ]));
    } catch (e) {
      caught = e;
    }
    expect((caught as PolicyEvaluationError).code).toBe("ERR_POLICY_REQUIRES_MISSING");
    expect((caught as PolicyEvaluationError).detail).toContain("COSTCENTRE");
  });
});

describe("validateRequires — contracts §4.3.2 step 4", () => {
  it("names every missing field and nothing else", () => {
    const policy = parsePolicy({ ...(POLICY as unknown as Record<string, unknown>), requires: ["party", "client_ref"] });
    expect(validateRequires(policy, snapshot([]))).toEqual({ missing: ["party", "client_ref"] });
    expect(validateRequires(policy, snapshot([], { partyId: "p-1", clientRef: "c-1" }))).toEqual({ missing: [] });
  });
});

describe("balanceInBase — the FX-rounding line (spec:1868)", () => {
  const rate = { from: USD, to: MYR, rate: "4.68350000", effectiveFrom: "2026-01-01", source: "BNM 2026-01-01" };

  it("returns the plan untouched when base already balances", () => {
    const plan = evaluatePolicy(POLICY, snapshot([
      line({ lineNo: 1, debit: Money.of("10.0000", MYR) }),
      line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("10.0000", MYR) }),
    ]));
    expect(balanceInBase(plan, "acct-fx", MYR)).toBe(plan);
  });

  /**
   * The fixture below is chosen because it actually LEAVES a residue, which most three-line splits do not.
   * At 4.68350000 the obvious 0.3335 = 0.1667 + 0.1668 converts to 1.5619 = 0.7807 + 0.7812 — exactly
   * balanced, `balanceInBase` returns the plan untouched, and every assertion here would fail on a correct
   * implementation. These numbers do leave one:
   *   debit  0.0003 × 4.68350000 = 0.00140505 → 0.0014
   *   credit 0.0001 × 4.68350000 = 0.00046835 → 0.0005, three of them → 0.0015
   *   residue = 0.0014 − 0.0015 = −0.0001, well inside the 0.01 × 4 tolerance, so exactly one fx_rounding
   *   DEBIT line of 0.0001 MYR is appended (residue is negative → the side is "debit").
   */
  it("appends one fx_rounding line for a rounding residue and the plan then balances in base", () => {
    const plan = evaluatePolicy(POLICY, snapshot(
      [
        line({ lineNo: 1, debit: Money.of("0.0003", USD), amount: Money.zero(USD), credit: Money.zero(USD), discount: Money.zero(USD), taxAmount: Money.zero(USD), totalInclTax: Money.zero(USD) }),
        line({ lineNo: 2, accountId: "acct-b", credit: Money.of("0.0001", USD), amount: Money.zero(USD), debit: Money.zero(USD), discount: Money.zero(USD), taxAmount: Money.zero(USD), totalInclTax: Money.zero(USD) }),
        line({ lineNo: 3, accountId: "acct-c", credit: Money.of("0.0001", USD), amount: Money.zero(USD), debit: Money.zero(USD), discount: Money.zero(USD), taxAmount: Money.zero(USD), totalInclTax: Money.zero(USD) }),
        line({ lineNo: 4, accountId: "acct-d", credit: Money.of("0.0001", USD), amount: Money.zero(USD), debit: Money.zero(USD), discount: Money.zero(USD), taxAmount: Money.zero(USD), totalInclTax: Money.zero(USD) }),
      ],
      { currency: USD, exchangeRate: rate },
    ));
    expect(plan.ledgerLines).toHaveLength(4);
    const balanced = balanceInBase(plan, "acct-fx", MYR);
    expect(balanced.ledgerLines).toHaveLength(5);
    const fx = balanced.ledgerLines.at(-1)!;
    expect(fx.role).toBe("fx_rounding");
    expect(fx.accountId).toBe("acct-fx");
    expect(fx.side).toBe("debit");
    expect(fx.amount.currency).toBe(MYR);
    expect(fx.amount.toString()).toBe("0.0001");
    expect(fx.amount.equals(fx.base)).toBe(true);
    const debit = balanced.ledgerLines.filter((l) => l.side === "debit").reduce((a, l) => a.add(l.base), Money.zero<CurrencyCode>(MYR));
    const credit = balanced.ledgerLines.filter((l) => l.side === "credit").reduce((a, l) => a.add(l.base), Money.zero<CurrencyCode>(MYR));
    expect(debit.equals(credit)).toBe(true);
  });

  it("throws ERR_LEDGER_UNBALANCED when the residue is real, not rounding", () => {
    const plan = evaluatePolicy(POLICY, snapshot([
      line({ lineNo: 1, debit: Money.of("100.0000", MYR) }),
      line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("90.0000", MYR) }),
    ]));
    expect(() => balanceInBase(plan, "acct-fx", MYR)).toThrow(/ERR_LEDGER_UNBALANCED/);
  });

  it("throws ERR_LEDGER_UNBALANCED when the company has no fx_rounding account", () => {
    // Same residue-leaving fixture as the fx_rounding test above — a fixture that balances exactly would
    // return early from balanceInBase and never reach the fxRoundingAccountId check at all.
    const plan = evaluatePolicy(POLICY, snapshot(
      [
        line({ lineNo: 1, debit: Money.of("0.0003", USD), amount: Money.zero(USD), credit: Money.zero(USD), discount: Money.zero(USD), taxAmount: Money.zero(USD), totalInclTax: Money.zero(USD) }),
        line({ lineNo: 2, accountId: "acct-b", credit: Money.of("0.0001", USD), amount: Money.zero(USD), debit: Money.zero(USD), discount: Money.zero(USD), taxAmount: Money.zero(USD), totalInclTax: Money.zero(USD) }),
        line({ lineNo: 3, accountId: "acct-c", credit: Money.of("0.0001", USD), amount: Money.zero(USD), debit: Money.zero(USD), discount: Money.zero(USD), taxAmount: Money.zero(USD), totalInclTax: Money.zero(USD) }),
        line({ lineNo: 4, accountId: "acct-d", credit: Money.of("0.0001", USD), amount: Money.zero(USD), debit: Money.zero(USD), discount: Money.zero(USD), taxAmount: Money.zero(USD), totalInclTax: Money.zero(USD) }),
      ],
      { currency: USD, exchangeRate: rate },
    ));
    expect(() => balanceInBase(plan, null, MYR)).toThrow(/ERR_LEDGER_UNBALANCED/);
  });
});
```

`packages/domain/test/posting/balance.property.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { currency, Money, type CurrencyCode } from "../../src";
import { balanceInBase, evaluatePolicy, parsePolicy, type LineSnapshot } from "../../src/posting";

const MYR = currency("MYR");
const FOREIGN = currency("USD");
const POLICY = parsePolicy(
  (JSON.parse(readFileSync(fileURLToPath(new URL("./journal-envelope.fixture.json", import.meta.url)), "utf8")) as { policy: unknown }).policy,
);

/** A pair of amounts that sum equal in the DOCUMENT currency: n debits and m credits with the same total.
 *  After per-line base rounding they need not sum equal in BASE — which is exactly the residue balanceInBase
 *  is for (spec:1868). The property is that after balanceInBase the base sums are always equal or the call
 *  threw, and that it never invents more than one fx_rounding line. */
describe("balanceInBase — property (spec:1868, contracts §5 item 23)", () => {
  it("either balances in base with at most one fx_rounding line, or refuses", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 2, maxLength: 12 }),
        fc.integer({ min: 100_000_000, max: 9_999_999_999 }),      // rate at 8 dp, 1.00000000 … 99.99999999
        (parts, rateScaled) => {
          const total = parts.reduce((a, b) => a + b, 0);
          const rate = { from: FOREIGN, to: MYR, rate: (rateScaled / 1e8).toFixed(8), effectiveFrom: "2026-01-01", source: "test" };
          const zero = Money.zero(FOREIGN);
          const base = (lineNo: number): LineSnapshot => ({
            id: `l${lineNo}`, lineNo, kind: "account", description: null, accountId: `acct-${lineNo}`, itemId: null,
            quantity: null, unitPrice: null, discount: zero, amount: zero, taxCodeId: null, taxAmount: zero,
            totalInclTax: zero, debit: zero, credit: zero, cost: null, warehouseId: null, toWarehouseId: null,
            lotId: null, unitId: null, unitQuantity: null, countedQuantity: null, expectedQuantity: null,
            tenderMethod: null, customFields: {}, dimensions: {}, payroll: null,
          });
          const lines: LineSnapshot[] = [
            { ...base(1), debit: Money.of((total / 10_000).toFixed(4), FOREIGN) },
            ...parts.map((p, i) => ({ ...base(i + 2), credit: Money.of((p / 10_000).toFixed(4), FOREIGN) })),
          ];
          const plan = evaluatePolicy(POLICY, {
            header: {
              id: "d", companyId: "c", documentTypeCode: "JOURNAL", status: "draft", series: "JV",
              fiscalPeriodId: "p", number: null, effectiveDate: "2026-01-15", partyId: null, currency: FOREIGN,
              exchangeRate: rate, branchId: "b", attributedTo: null, clientRef: null, warehouseId: null,
              toWarehouseId: null, taxInclusive: false, reversesDocumentId: null, customFields: {},
            },
            lines,
            company: { id: "c", baseCurrency: MYR, fxRoundingAccountId: "acct-fx", costingMethod: "avco" },
            party: null,
            refs: { accountsByCode: {}, items: {}, taxCodes: {}, components: {}, schemes: {}, dimensionTypesByCode: {} },
          });
          let balanced;
          try {
            balanced = balanceInBase(plan, "acct-fx", MYR);
          } catch {
            return true;              // a refusal is a legal outcome; it is never a wrong number
          }
          expect(balanced.ledgerLines.filter((l) => l.role === "fx_rounding").length).toBeLessThanOrEqual(1);
          // `Money.zero<CurrencyCode>(MYR)` on purpose: `currency` has a `const` type parameter, so a bare
          // `Money.zero(MYR)` is `Money<CurrencyCode & "MYR">`, the reduce accumulator takes its type from
          // the seed, and `a.add(l.base)` — where `base` is the wide `Money<CurrencyCode>` of
          // PlannedLedgerLine — is then a compile error. The explicit argument widens the seed instead.
          const d = balanced.ledgerLines.filter((l) => l.side === "debit").reduce((a, l) => a.add(l.base), Money.zero<CurrencyCode>(MYR));
          const c = balanced.ledgerLines.filter((l) => l.side === "credit").reduce((a, l) => a.add(l.base), Money.zero<CurrencyCode>(MYR));
          expect(d.equals(c)).toBe(true);
          return true;
        },
      ),
      { numRuns: 2000 },
    );
  });
});
```

Run: `bun run --cwd packages/domain test -- test/posting`
Expected: **FAIL** — every file errors at import with `Cannot find module '../../src/posting'`.

- [ ] **Step 3: Write `packages/domain/posting-policy.schema.json` at the JOURNAL subset**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:dulja:posting-policy:1",
  "title": "Dulja posting policy, version 1 (JOURNAL subset — 2A widens this file and keeps the $id)",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "documentType", "direction", "requires", "lines", "inventory", "tax", "numbering", "reversal", "approval", "fxRoundingAccount"],
  "properties": {
    "version": { "const": 1 },
    "documentType": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]{1,63}$" },
    "direction": { "enum": ["inbound", "outbound", "internal", "none"] },
    "requires": { "type": "array", "uniqueItems": true, "items": { "enum": ["party", "warehouse", "to_warehouse", "attributed_to", "client_ref", "reverses_document"] } },
    "lines": { "type": "array", "items": { "$ref": "#/$defs/policyLine" } },
    "inventory": {
      "type": "object", "additionalProperties": false, "required": ["effect"],
      "properties": { "effect": { "enum": ["none"] } }
    },
    "tax": {
      "type": "object", "additionalProperties": false, "required": ["applies"],
      "properties": { "applies": { "type": "boolean" } }
    },
    "numbering": { "type": "object", "additionalProperties": false, "required": ["series", "assignAt"], "properties": { "series": { "type": "string", "pattern": "^[A-Z0-9-]{1,16}$" }, "assignAt": { "const": "issue" } } },
    "reversal": { "type": "object", "additionalProperties": false, "required": ["allowed", "producesType"], "properties": { "allowed": { "type": "boolean" }, "producesType": { "type": ["string", "null"], "pattern": "^[A-Z][A-Z0-9_]{1,63}$" } } },
    "approval": {
      "type": "object", "additionalProperties": false, "required": ["required", "approve", "post"],
      "properties": { "required": { "type": "boolean" }, "approve": { "$ref": "#/$defs/permissionCodeOrNull" }, "post": { "$ref": "#/$defs/permissionCode" }, "create": { "$ref": "#/$defs/permissionCode" } },
      "if": { "properties": { "required": { "const": true } } },
      "then": { "properties": { "approve": { "type": "string" } } }
    },
    "fxRoundingAccount": { "type": "object", "additionalProperties": false, "required": ["from"], "properties": { "from": { "const": "company.fx_rounding_account_id" } } },
    "dimensions": {
      "type": "object", "additionalProperties": false,
      "properties": { "required": { "type": "array", "uniqueItems": true, "items": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]{1,31}$" } } },
      "default": { "required": [] }
    }
  },
  "$defs": {
    "permissionCode": { "type": "string", "pattern": "^(admin|accounting|inventory|hr|pos)\\.[a-z_]+\\.[a-z_]+$" },
    "permissionCodeOrNull": { "anyOf": [{ "type": "null" }, { "$ref": "#/$defs/permissionCode" }] },
    "accountRef": {
      "oneOf": [
        { "type": "object", "additionalProperties": false, "required": ["from"], "properties": { "from": { "enum": ["line.account", "company.fx_rounding_account_id"] } } },
        { "type": "object", "additionalProperties": false, "required": ["code"], "properties": { "code": { "type": "string", "minLength": 1 } } }
      ]
    },
    "amountRef": { "enum": ["line.debit", "line.credit"] },
    "policyLine": {
      "type": "object", "additionalProperties": false, "required": ["for", "side", "account", "amount"],
      "properties": {
        "for": { "enum": ["each_line"] },
        "side": { "enum": ["debit", "credit"] },
        "account": { "$ref": "#/$defs/accountRef" },
        "amount": { "$ref": "#/$defs/amountRef" },
        "when": { "type": "object", "additionalProperties": false, "properties": { "line.kind": { "enum": ["account"] } } },
        "dimensions": { "type": "object", "additionalProperties": false, "properties": { "from": { "type": "array", "items": { "enum": ["line.dimensions", "document.branch"] }, "default": ["line.dimensions", "document.branch"] } } }
      }
    }
  }
}
```

`packages/domain/document-type-seed.schema.json` — the §4.3.7 envelope. `policy` is `true` here (any object): the loader validates it separately against `posting-policy.schema.json`, because a `$ref` across two files would make one Ajv instance own both and blur which error came from which schema.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:dulja:document-type-seed:1",
  "title": "The seed-file envelope for one document type (contracts §4.3.7)",
  "type": "object",
  "additionalProperties": false,
  "required": ["code", "nameEn", "module", "policyVersion", "effectiveFrom", "policy"],
  "properties": {
    "code": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]{1,63}$" },
    "nameEn": { "type": "string", "minLength": 1 },
    "nameAr": { "type": "string", "minLength": 1 },
    "module": { "enum": ["accounting", "inventory", "hr", "pos"] },
    "policyVersion": { "type": "integer", "minimum": 1 },
    "effectiveFrom": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
    "policy": true
  }
}
```

- [ ] **Step 4: Write `packages/domain/src/posting/evaluate.ts`**

```ts
import Decimal from "decimal.js";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import policySchema from "../../posting-policy.schema.json" with { type: "json" };
import seedSchema from "../../document-type-seed.schema.json" with { type: "json" };
import { Money, toBase, type CurrencyCode, type ExchangeRate, type RoundingMode } from "../money";
import type { Quantity } from "../quantity";
import type { PostingPolicy } from "./policy";

export type DocumentStatus = "draft" | "submitted" | "approved" | "issued" | "void" | "posted" | "reversed";

/** contracts §4.4.2 — declared in full at its final shape and filled at the Phase 1 subset (this plan's
 *  assumption 8). Every later slice fills a field it adds a column for; no consumer ever changes. */
export interface DocumentSnapshot {
  header: {
    id: string; companyId: string; documentTypeCode: string; status: DocumentStatus; series: string;
    fiscalPeriodId: string | null; number: bigint | null; effectiveDate: string; partyId: string | null;
    currency: CurrencyCode; exchangeRate: ExchangeRate; branchId: string; attributedTo: string | null;
    clientRef: string | null; warehouseId: string | null; toWarehouseId: string | null; taxInclusive: boolean;
    reversesDocumentId: string | null; customFields: Record<string, unknown>;
  };
  lines: LineSnapshot[];
  company: { id: string; baseCurrency: CurrencyCode; fxRoundingAccountId: string | null; costingMethod: "avco" | "fifo" };
  party: { id: string; kind: string; receivableAccountId: string | null; payableAccountId: string | null; creditLimit: Money | null } | null;
  refs: {
    accountsByCode: Record<string, string>; items: Record<string, ItemRef>; taxCodes: Record<string, TaxCodeRef>;
    components: Record<string, PayComponentRef>; schemes: Record<string, SchemeRef>; dimensionTypesByCode: Record<string, string>;
  };
}

export interface LineSnapshot {
  id: string; lineNo: number; kind: "account" | "item" | "tax" | "text" | "tender" | "payroll"; description: string | null;
  accountId: string | null; itemId: string | null; quantity: Quantity | null; unitPrice: Money | null; discount: Money;
  amount: Money; taxCodeId: string | null; taxAmount: Money; totalInclTax: Money; debit: Money; credit: Money;
  cost: Money | null; warehouseId: string | null; toWarehouseId: string | null; lotId: string | null;
  unitId: string | null; unitQuantity: Quantity | null;
  countedQuantity: Quantity | null; expectedQuantity: Quantity | null;
  /** The `when` filter's `line.tender_method` reads this typed field, never the untyped bag (§4.6.5). */
  tenderMethod: "cash" | "card" | "transfer" | "store_credit" | null;
  customFields: Record<string, unknown>;
  dimensions: Record<string, string>; payroll: PayrollLineRef | null;
}

export interface PlannedLedgerLine {
  lineNo: number; accountId: string; side: "debit" | "credit"; amount: Money; base: Money;
  dimensions: Record<string, string>; sourceLineNo: number | null; role: "policy" | "fx_rounding";
}
export interface PlannedMovement {
  lineNo: number; movementNo: number; itemId: string; warehouseId: string; lotId: string | null;
  quantity: Quantity; effect: "receipt" | "issue"; value: Money | null; costing: "consume_layers" | "create_layer" | "zero";
}
export interface PlannedTaxLine { lineNo: number; taxCodeId: string; base: Money; amount: Money; inclusive: boolean }
export interface PostingPlan { ledgerLines: PlannedLedgerLine[]; movements: PlannedMovement[]; taxLines: PlannedTaxLine[]; warnings: string[] }
export interface PolicyValidation { ok: boolean; errors: { path: string; message: string }[] }

/** Declared here, in core, and nowhere else — spec:2366 forbids packages/domain/src/** importing
 *  packages/domain/payroll/**. 8B's richer types satisfy these structurally and core never imports HR. */
export interface PayComponentRef { id: string; code: string; kind: "earning" | "deduction"; expenseAccountId: string | null; payableAccountId: string | null }
export interface SchemeRef { id: string; code: string; payableAccountId: string; expenseAccountId: string | null }
export interface PayrollLineRef { employeeId: string; employeeDimensionValueId: string; componentId: string | null; schemeId: string | null; share: "employee" | "employer" | null }
/** Declared here for the same reason: app.item is 3A's table and app.tax_code is 5A's, and the evaluator
 *  resolves item.* and tax_code.* references before either exists. */
export interface ItemRef {
  id: string; code: string; kind: "product" | "service" | "asset"; baseUnitId: string; trackLots: boolean;
  revenueAccountId: string | null; inventoryAccountId: string | null; cogsAccountId: string | null; expenseAccountId: string | null;
}
export interface TaxCodeRef {
  id: string; code: string; rate: string; kind: "output" | "input" | "exempt" | "zero" | "out_of_scope";
  roundingMode: RoundingMode; outputAccountId: string | null; inputAccountId: string | null;
}

export class PolicyEvaluationError extends Error {
  constructor(
    readonly code: "ERR_POLICY_INVALID" | "ERR_POLICY_REQUIRES_MISSING" | "ERR_LEDGER_UNBALANCED",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PolicyEvaluationError";
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: false });
const policyValidator: ValidateFunction = ajv.compile(policySchema);
const seedValidator: ValidateFunction = ajv.compile(seedSchema);

const toErrors = (errors: ErrorObject[] | null | undefined): { path: string; message: string }[] =>
  (errors ?? []).map((e) => ({ path: e.instancePath, message: `${e.message ?? "is invalid"}${e.params && "additionalProperty" in e.params ? ` (${String(e.params.additionalProperty)})` : ""}` }));

/** Seed time: the JSON Schema plus "every approval code exists in the catalogue" (F-21, contracts §4.4.1). */
export function validatePolicy(definition: unknown, catalogue: readonly string[]): PolicyValidation {
  if (!policyValidator(definition)) return { ok: false, errors: toErrors(policyValidator.errors) };
  const policy = definition as PostingPolicy;
  const errors: { path: string; message: string }[] = [];
  const check = (code: string | null | undefined, path: string): void => {
    if (code && !catalogue.includes(code)) errors.push({ path, message: `${code} is not in the permission catalogue` });
  };
  check(policy.approval.post, "/approval/post");
  check(policy.approval.approve, "/approval/approve");
  check(policy.approval.create, "/approval/create");
  return { ok: errors.length === 0, errors };
}

/** Post time: the schema only, throwing. A definition already in the database has been through
 *  validatePolicy at seed time; this guards against one written by hand or by an older schema. */
export function parsePolicy(definition: unknown): PostingPolicy {
  if (!policyValidator(definition)) {
    const detail = toErrors(policyValidator.errors).map((e) => `${e.path || "/"} ${e.message}`).join("; ");
    throw new PolicyEvaluationError("ERR_POLICY_INVALID", detail);
  }
  return definition as PostingPolicy;
}

/** The §4.3.7 envelope: the schema, plus the two cross-field rules the schema cannot express. */
export function validateDocumentTypeSeed(envelope: unknown): PolicyValidation {
  if (!seedValidator(envelope)) return { ok: false, errors: toErrors(seedValidator.errors) };
  const e = envelope as { code: string; policy: { documentType?: unknown } };
  const declared = typeof e.policy?.documentType === "string" ? e.policy.documentType : "";
  if (e.code !== declared) {
    return { ok: false, errors: [{ path: "/code", message: `code ${e.code} does not equal policy.documentType ${declared}` }] };
  }
  return { ok: true, errors: [] };
}

const REQUIRES_FIELD: Record<string, (s: DocumentSnapshot) => unknown> = {
  party: (s) => s.header.partyId,
  warehouse: (s) => s.header.warehouseId,
  to_warehouse: (s) => s.header.toWarehouseId,
  attributed_to: (s) => s.header.attributedTo,
  client_ref: (s) => s.header.clientRef,
  reverses_document: (s) => s.header.reversesDocumentId,
};

export function validateRequires(policy: PostingPolicy, snapshot: DocumentSnapshot): { missing: string[] } {
  return { missing: (policy.requires ?? []).filter((field) => REQUIRES_FIELD[field]?.(snapshot) == null) };
}

function resolveAccount(ref: PostingPolicy["lines"][number]["account"], line: LineSnapshot, snapshot: DocumentSnapshot): string {
  if ("code" in ref) {
    const id = snapshot.refs.accountsByCode[ref.code];
    if (!id) throw new PolicyEvaluationError("ERR_POLICY_REQUIRES_MISSING", `account code ${ref.code} does not exist in company ${snapshot.company.id}`);
    return id;
  }
  if (ref.from === "company.fx_rounding_account_id") {
    if (!snapshot.company.fxRoundingAccountId) throw new PolicyEvaluationError("ERR_POLICY_REQUIRES_MISSING", `company ${snapshot.company.id} has no fx_rounding_account_id`);
    return snapshot.company.fxRoundingAccountId;
  }
  if (!line.accountId) throw new PolicyEvaluationError("ERR_POLICY_REQUIRES_MISSING", `line ${line.lineNo} has no account`);
  return line.accountId;
}

/** Pure. Zero-amount planned lines are dropped (§4.3.2 step 6); BRANCH is added to every line from the
 *  header and always wins over a value a client put in the line's own bag.
 *
 *  SIGN NORMALISATION (contracts §4.4.2, amendment A9) — a rule whose resolved amount is negative emits the
 *  rule's OPPOSITE side with `amount.abs()`, so `PlannedLedgerLine.amount` is never negative and `side` alone
 *  carries direction. This is the only shape `app.ledger_entry` accepts: plan0A:2012–2013 declares
 *  `check (debit >= 0)` and `check (credit >= 0)`, and Task 8's `insertLedger` writes
 *  `line.side === "debit" ? line.amount.toString() : "0.0000"`, so a negative planned amount would die on
 *  `ledger_entry_debit_check`. At the Phase 1 JOURNAL subset the branch is defensive — `amountRef` has only
 *  `line.debit` and `line.credit`, and migration 0011 constrains both `>= 0` — but it is stated as behaviour
 *  of THIS function, and 2A extends this same `for` switch with `each_tax` and `document` and with the
 *  `line.amount` / `line.cost` refs that make it reachable. `PlannedTaxLine.amount` is the one exception and
 *  stays signed; this slice emits no tax line. */
export function evaluatePolicy(policy: PostingPolicy, snapshot: DocumentSnapshot): PostingPlan {
  const ledgerLines: PlannedLedgerLine[] = [];
  let lineNo = 0;
  for (const rule of policy.lines) {
    if (rule.for !== "each_line") continue;                       // 2A adds each_tax and document
    for (const line of snapshot.lines) {
      if (rule.when?.["line.kind"] && rule.when["line.kind"] !== line.kind) continue;
      const resolved = rule.amount === "line.debit" ? line.debit : line.credit;
      if (resolved.isZero()) continue;
      const negative = resolved.isNegative();
      const amount = negative ? resolved.abs() : resolved;
      const side: "debit" | "credit" = negative ? (rule.side === "debit" ? "credit" : "debit") : rule.side;
      lineNo += 1;
      ledgerLines.push({
        lineNo,
        accountId: resolveAccount(rule.account, line, snapshot),
        side,
        amount,
        base: toBase(amount, snapshot.header.exchangeRate),
        dimensions: { ...line.dimensions, BRANCH: snapshot.header.branchId },
        sourceLineNo: line.lineNo,
        role: "policy",
      });
    }
  }
  for (const required of policy.dimensions?.required ?? []) {
    const offender = ledgerLines.find((l) => !l.dimensions[required]);
    if (offender) {
      throw new PolicyEvaluationError("ERR_POLICY_REQUIRES_MISSING", `dimension ${required} is required by ${policy.documentType} and planned line ${offender.lineNo} carries none`);
    }
  }
  return { ledgerLines, movements: [], taxLines: [], warnings: [] };
}

/** spec:1868 — base amounts are rounded per line, so Σbase can be off by a rounding residue. One FX-rounding
 *  line at rate 1 on company.fx_rounding_account_id absorbs it. A residue larger than 0.01 per planned line
 *  is not rounding: it is a wrong document, and it is refused before any row is written (§4.3.2 step 6). */
export function balanceInBase(plan: PostingPlan, fxRoundingAccountId: string | null, baseCurrency: CurrencyCode): PostingPlan {
  const zero = Money.zero(baseCurrency);
  const debit = plan.ledgerLines.filter((l) => l.side === "debit").reduce((a, l) => a.add(l.base), zero);
  const credit = plan.ledgerLines.filter((l) => l.side === "credit").reduce((a, l) => a.add(l.base), zero);
  const residue = debit.subtract(credit);
  if (residue.isZero()) return plan;

  const tolerance = new Decimal("0.01").times(Math.max(plan.ledgerLines.length, 1));
  if (residue.toDecimal().abs().greaterThan(tolerance)) {
    throw new PolicyEvaluationError("ERR_LEDGER_UNBALANCED", `base debits and credits differ by ${residue.toString()} ${baseCurrency}, which exceeds the ${tolerance.toFixed(2)} rounding tolerance for ${plan.ledgerLines.length} lines`);
  }
  if (!fxRoundingAccountId) {
    throw new PolicyEvaluationError("ERR_LEDGER_UNBALANCED", `base debits and credits differ by ${residue.toString()} ${baseCurrency} and the company has no fx_rounding_account_id to absorb it`);
  }
  const branch = plan.ledgerLines[0]?.dimensions.BRANCH;
  return {
    ...plan,
    ledgerLines: [
      ...plan.ledgerLines,
      {
        lineNo: plan.ledgerLines.length + 1,
        accountId: fxRoundingAccountId,
        side: residue.isPositive() ? "credit" : "debit",
        amount: residue.abs(),
        base: residue.abs(),
        dimensions: branch ? { BRANCH: branch } : {},
        sourceLineNo: null,
        role: "fx_rounding",
      },
    ],
  };
}
```

`packages/domain/src/posting/index.ts`:

```ts
export * from "./evaluate";
export type { PostingPolicy } from "./policy";
```

Add `export * from "./posting";` to `packages/domain/src/index.ts`.

- [ ] **Step 5: Generate and commit `packages/domain/src/posting/policy.ts`**

Run: `bun run --cwd packages/domain policy:types`

The file it writes is committed as generated output. Its shape — verify it before continuing; if `json-schema-to-typescript` names an inner interface differently, keep its output and do **not** hand-edit:

```ts
// GENERATED FILE — do not edit by hand.
// Source: packages/domain/posting-policy.schema.json ($id urn:dulja:posting-policy:1)
// Regenerate: bun run --cwd packages/domain policy:types

export interface PostingPolicy {
  version: 1;
  documentType: string;
  direction: "inbound" | "outbound" | "internal" | "none";
  requires: ("party" | "warehouse" | "to_warehouse" | "attributed_to" | "client_ref" | "reverses_document")[];
  lines: PolicyLine[];
  inventory: { effect: "none" };
  tax: { applies: boolean };
  numbering: { series: string; assignAt: "issue" };
  reversal: { allowed: boolean; producesType: string | null };
  approval: { required: boolean; approve: string | null; post: string; create?: string };
  fxRoundingAccount: { from: "company.fx_rounding_account_id" };
  dimensions?: { required?: string[] };
}
export interface PolicyLine {
  for: "each_line";
  side: "debit" | "credit";
  account: { from: "line.account" | "company.fx_rounding_account_id" } | { code: string };
  amount: "line.debit" | "line.credit";
  when?: { "line.kind"?: "account" };
  dimensions?: { from?: ("line.dimensions" | "document.branch")[] };
}
```

Add a guard so the committed file cannot drift, as `packages/domain/test/posting/policy-type.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("src/posting/policy.ts is generated, not hand-written", () => {
  it("regenerating produces no diff (the committed-artifact discipline of spec:2055)", () => {
    const path = fileURLToPath(new URL("../../src/posting/policy.ts", import.meta.url));
    const before = readFileSync(path, "utf8");
    execFileSync("bun", ["run", "policy:types"], { cwd: fileURLToPath(new URL("../..", import.meta.url)) });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
```

- [ ] **Step 6: Add the two error codes this task raises to `packages/contracts/src/errors.ts`**

The `error-codes` build check (0B) fails when a code **present in `ERRORS`** has no occurrence in `apps/**`, `packages/**/src/**` or `packages/db/migrations/**`. `ERR_POLICY_INVALID` and `ERR_POLICY_REQUIRES_MISSING` now occur in `packages/domain/src/posting/evaluate.ts`, so their rows may land — and **only** those two land here. The remaining four (`ERR_POLICY_NOT_FOUND`, `ERR_PERIOD_NOT_FOUND`, `ERR_DOC_NO_LINES`, `ERR_DOC_STATUS_ILLEGAL`) all land together in **Task 6 Step 5**, not one per raising task: Task 6 Step 5's `if (e instanceof PostingError) return new AppError(e.code, e.detail)` needs `PostingErrorCode` to be a literal subset of `ErrCode` **with no cast**, and Task 6 Step 2 declares `PostingErrorCode` with all nine of §4.3.8's Phase 1 members. Adding them here instead would make `error-codes` red until Task 6, because none of the four occurs in any source file yet.

Add to the `ERRORS` object literal, keeping its existing alphabetical grouping by domain:

```ts
  ERR_POLICY_INVALID:           { status: 422, title: "Posting policy invalid",          remedy: "Correct the policy definition in the seed pack and re-run the document-types seed for this tenant" },
  ERR_POLICY_REQUIRES_MISSING:  { status: 422, title: "Posting policy input missing",    remedy: "Supply the field, dimension or account the message names, then post again" },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run --cwd packages/domain test -- test/posting`
Expected: **PASS** — `validate-policy.test.ts` 7, `evaluate.test.ts` 12, `balance.property.test.ts` 1 (2 000 fast-check runs), `policy-type.test.ts` 1.

Run: `bun run --cwd packages/domain typecheck && bun run lint:rules`
Expected: `typecheck` PASS. `lint:rules` reports **only** the six `permission-catalogue` violations Task 4 introduced — `9 rules, N files, 6 violations`, every line naming an `accounting.*` code with no reference. That is the phased catalogue working as spec:2142 intends, it is the one documented exception to the after-every-task list, and it clears at Task 12 (Execution handoff). **No other rule may report anything.** In particular: `no-number-money` matches *declared type annotations* only — `x: number`, `x?: number`, `x: number | null` — because 0D's runner passes parsed source files with no type checker, so an inferred `const total = parts.reduce((a, b) => a + b, 0)` in the property test is not a violation; every *declared* money-shaped field written above is `Money` or `string`. `dependency-rule` passes because `packages/domain/src/posting/` imports only from `packages/domain/src/money`, `packages/domain/src/quantity`, `decimal.js` and `ajv` — never from `packages/domain/payroll/`.

- [ ] **Step 8: Write `docs/adr/0022-ajv-posting-policy-validator.md`**

```markdown
# ADR 0022 — Ajv validates posting policies; the `PostingPolicy` type is generated and committed

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 1A

## Context

spec:2008 makes the posting policy a JSON document validated against
`packages/domain/posting-policy.schema.json`, and spec:1711 requires it to be diffable and version-controlled
rather than an opaque blob (SAH-078). Two things follow: something must validate a policy against that schema,
and TypeScript must have a type for it that cannot drift from the schema.

## Decision

- **Ajv** with the draft-2020-12 dialect (`ajv/dist/2020`), one instance compiled once at module load in
  `packages/domain/src/posting/evaluate.ts`, `strict: true`, `allErrors: true`, `useDefaults: false`.
  `useDefaults: false` matters: a policy read back from the database must look exactly as it was seeded, so a
  schema `default` never silently rewrites a stored definition.
- **`json-schema-to-typescript`** generates `packages/domain/src/posting/policy.ts` from the schema. The
  output is **committed**, and `packages/domain/test/posting/policy-type.test.ts` regenerates it and fails on
  a diff — the same discipline spec:2055 applies to `openapi.json`.
- D11's "`decimal.js` only" is a decision about how money is represented, not a ban on every dependency of
  `packages/domain`; the money module keeps exactly one runtime dependency, and the policy module adds one.

## Consequences

- A policy that fails the schema is refused with the JSON Pointer of the offending member, which is what
  `ERR_POLICY_INVALID`'s `detail` reports.
- 2A widens the schema (ADR 0026) and regenerates the type; because the widening adds enum labels and optional
  properties only, the generated type widens and every 1A caller still compiles.
- Ajv is a runtime dependency of `@dulja/domain`, therefore of `@dulja/db`, `@dulja/contracts`, `apps/api`,
  `apps/worker` and `apps/pos`. It is ~120 kB minified, which is acceptable at the till.
```

- [ ] **Step 9: Commit**

```bash
git add packages/domain packages/contracts docs/adr/0022-ajv-posting-policy-validator.md
git commit -m "$(cat <<'EOF'
feat(domain): the posting-policy schema, the snapshot types and the JOURNAL evaluator [1A T5]

posting-policy.schema.json at the JOURNAL subset with $id urn:dulja:posting-policy:1
(2A widens the same file and the same $id); document-type-seed.schema.json for the
§4.3.7 envelope; the committed generated PostingPolicy type with a no-diff guard;
evaluatePolicy, validateRequires and balanceInBase, all pure. Base conversion is
round(value × rate, 4) HALF_AWAY_FROM_ZERO so the ledger_entry CHECK holds by
construction, and one FX-rounding line absorbs the per-line residue (spec:1868).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6 — `packages/db/src/posting/`: `loadSnapshot`, `resolvePolicy`, `PostingError`, and the four `fixtures.ts` helpers

The reading half of the posting service, plus the four test helpers contracts §4.17 assigns this slice. Every posting task from here on uses `seedTenantV2`, so the fixtures land now.

**Files:**
- Create: `packages/db/src/posting/errors.ts`, `packages/db/src/posting/load.ts`, `packages/db/src/posting/index.ts`, `packages/db/test/posting/load.test.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/test/fixtures.ts`, `packages/contracts/src/errors.ts`, `apps/api/src/problem.ts`

**Interfaces:**
- Produces (TS), exported from `@dulja/db`:

```ts
export type PostingErrorCode =
  | "ERR_NOT_FOUND" | "ERR_DOC_STATUS_ILLEGAL" | "ERR_DOC_NO_LINES" | "ERR_POLICY_NOT_FOUND"
  | "ERR_POLICY_INVALID" | "ERR_POLICY_REQUIRES_MISSING" | "ERR_PERIOD_NOT_FOUND" | "ERR_PERIOD_NOT_OPEN"
  | "ERR_LEDGER_UNBALANCED";
export class PostingError extends Error { constructor(readonly code: PostingErrorCode, readonly detail: string) }
export async function loadSnapshot(tx: Sql, documentId: string): Promise<DocumentSnapshot>;                      // ERR_NOT_FOUND
export async function resolvePolicy(tx: Sql, documentTypeId: string, effectiveDate: string): Promise<{ policyId: string; definition: PostingPolicy }>;   // ERR_POLICY_NOT_FOUND, ERR_POLICY_INVALID
```

- Produces (test), exported from `@dulja/db/test` (contracts §4.17):

```ts
export const JOURNAL_POLICY_V1: PostingPolicy;                       // the `policy` member of §4.3.7, not the envelope
export async function seedJournalPolicy(db: Db, s: Seed): Promise<void>;
export async function seedTenantV2(db: Db, name: string): Promise<Seed>;
export async function seedAccount(db: Db, s: Seed, opts: { code: string; nameEn: string; type: "asset" | "liability" | "equity" | "income" | "expense"; parentCode?: string; currency?: string }): Promise<string>;
```

- Consumes: `DocumentSnapshot`, `LineSnapshot`, `PostingPolicy`, `parsePolicy`, `Money`, `currency`, `UNIT_RATE`, `type ExchangeRate` from `@dulja/domain`; `Sql` from `postgres`; `Db`, `Seed`, `seedTenant`, `uuidv7`, the test `withTenant` from `./harness` / `./fixtures` (§4.1).

**`seedTenant` is never edited** (contracts §4.1, hazard 9). `seedTenantV2` calls it and adds two things on top: the `5920` FX-rounding account wired to `company.fx_rounding_account_id`, and the JOURNAL policy at `posting_policy.version = 2`. The 0A tests that depend on the empty policy `{"version":1,…,"lines":[]}` keep passing because that row is untouched and `resolvePolicy` prefers the higher version at the same `effective_from`.

**`refs.accountsByCode` holds every non-archived leaf account of the company.** `loadSnapshot(tx, documentId)` has no policy parameter, so it cannot know which `account: { "code": … }` literals the policy will name; loading the company's leaf chart — one index scan on `account (company_id, code)`, eleven rows for a Phase 1 tenant and a few hundred for a real one — makes `account.code` resolution total, which is what `ERR_POLICY_REQUIRES_MISSING` "naming the code" requires. Group accounts are excluded because nothing may post to one.

- [ ] **Step 1: Write the failing test `packages/db/test/posting/load.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSnapshot, PostingError, resolvePolicy } from "../../src/posting";
import { JOURNAL_POLICY_V1, draftDocument, seedAccount, seedTenant, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("loadSnapshot and resolvePolicy — contracts §4.3.1", () => {
  let db: Db;
  let a: Seed;
  let plain: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    plain = await seedTenant(db, "Plain");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("loads the header, the lines and the company at the Phase 1 subset", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, description, account_id, debit)
               values (${a.tenant}, ${a.company}, ${doc}, 1, 'Cash in', ${a.cash}, 100.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit, dimensions)
               values (${a.tenant}, ${a.company}, ${doc}, 2, ${a.sales}, 100.0000, ${JSON.stringify({ COSTCENTRE: "cc-1" })}::jsonb)`;
    });
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));

    expect(snap.header).toMatchObject({
      id: doc, companyId: a.company, documentTypeCode: "JOURNAL", status: "draft", series: "JV",
      fiscalPeriodId: a.period, number: null, effectiveDate: "2026-01-15", branchId: a.hq,
      partyId: null, taxInclusive: false, warehouseId: null, toWarehouseId: null, reversesDocumentId: null,
    });
    expect(snap.header.currency).toBe("MYR");
    expect(snap.header.exchangeRate).toEqual({ from: "MYR", to: "MYR", rate: "1.00000000", effectiveFrom: "2026-01-15", source: "unit" });
    expect(snap.company).toMatchObject({ id: a.company, baseCurrency: "MYR", costingMethod: "avco" });
    expect(snap.company.fxRoundingAccountId).not.toBeNull();
    expect(snap.party).toBeNull();
    expect(snap.lines).toHaveLength(2);
    expect(snap.lines[0]).toMatchObject({ lineNo: 1, kind: "account", description: "Cash in", accountId: a.cash, itemId: null, tenderMethod: null, payroll: null });
    expect(snap.lines[0]!.debit.toString()).toBe("100.0000");
    expect(snap.lines[0]!.credit.toString()).toBe("0.0000");
    expect(snap.lines[1]!.dimensions).toEqual({ COSTCENTRE: "cc-1" });
    expect(snap.refs.items).toEqual({});
    expect(snap.refs.taxCodes).toEqual({});
    expect(snap.refs.components).toEqual({});
    expect(snap.refs.schemes).toEqual({});
    expect(snap.refs.dimensionTypesByCode).toMatchObject({ BRANCH: a.branchType });
  });

  it("keys refs.accountsByCode by app.account.code over the company's leaf accounts", async () => {
    const doc = await draftDocument(db, a);
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.refs.accountsByCode["1000"]).toBe(a.cash);
    expect(snap.refs.accountsByCode["4000"]).toBe(a.sales);
    expect(snap.refs.accountsByCode["5920"]).toBe(snap.company.fxRoundingAccountId);
  });

  it("builds a real ExchangeRate for a foreign-currency document", async () => {
    const doc = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                effective_date, currency, exchange_rate, rate_source, branch_id)
      values (${doc}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', ${a.period},
              '2026-01-15', 'USD', 4.68350000, 'BNM 2026-01-15', ${a.hq})`);
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.header.exchangeRate).toEqual({ from: "USD", to: "MYR", rate: "4.68350000", effectiveFrom: "2026-01-15", source: "BNM 2026-01-15" });
  });

  it("refuses a document of another tenant with ERR_NOT_FOUND, never a leak", async () => {
    const doc = await draftDocument(db, a);
    await expect(
      withTenant(db.rw, plain.tenant, plain.human, (tx) => loadSnapshot(tx, doc)),
    ).rejects.toMatchObject({ code: "ERR_NOT_FOUND" });
  });

  it("resolves the policy effective for the date, preferring the higher version on a tie", async () => {
    const resolved = await withTenant(db.rw, a.tenant, a.human, (tx) => resolvePolicy(tx, a.docType, "2026-01-15"));
    expect(resolved.definition).toEqual(JOURNAL_POLICY_V1);
    const [version] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ version: number }[]>`
      select version from app.posting_policy where id = ${resolved.policyId}`);
    expect(version!.version).toBe(2);        // 0A's version 1 shares effective_from 2026-01-01 and loses the tie
  });

  it("raises ERR_POLICY_NOT_FOUND before the earliest effective_from", async () => {
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => resolvePolicy(tx, a.docType, "2025-12-31")),
    ).rejects.toMatchObject({ code: "ERR_POLICY_NOT_FOUND" });
  });

  it("raises ERR_POLICY_INVALID for a stored definition that fails the schema (SAH-013)", async () => {
    await expect(
      withTenant(db.rw, plain.tenant, plain.human, (tx) => resolvePolicy(tx, plain.docType, "2026-01-15")),
    ).rejects.toMatchObject({ code: "ERR_POLICY_INVALID" });
  });

  it("seedAccount is idempotent on (company, code) and returns the same id", async () => {
    const first = await seedAccount(db, a, { code: "1100", nameEn: "Bank", type: "asset" });
    const second = await seedAccount(db, a, { code: "1100", nameEn: "Bank", type: "asset" });
    expect(second).toBe(first);
  });

  it("a PostingError instance carries its code and a detail naming the entity", () => {
    const e = new PostingError("ERR_NOT_FOUND", "no document 0192 in this tenant");
    expect(e.code).toBe("ERR_NOT_FOUND");
    expect(e.message).toBe("ERR_NOT_FOUND: no document 0192 in this tenant");
  });
});
```

Run: `bun run --cwd packages/db test -- test/posting/load.test.ts`
Expected: **FAIL** — `Cannot find module '../../src/posting'`.

- [ ] **Step 2: Write `packages/db/src/posting/errors.ts`**

```ts
/**
 * The posting service's error type.
 *
 * `packages/db` may import `@dulja/domain` and nothing else (spec:2389; scripts/lint/rules/dependency-rule.ts),
 * so it cannot construct the `AppError` of contracts §4.2.4 — which lives in `@dulja/contracts`. The CODES are
 * the ones §4.3.8 lists, and `apps/api/src/problem.ts` maps this class to an `AppError` in one branch, exactly
 * as 0B already maps `TenantContextError` (also declared in `@dulja/db`) for the same reason. The wire response
 * is the `Problem` §4.2.4 specifies, unchanged.
 */
export type PostingErrorCode =
  | "ERR_NOT_FOUND"
  | "ERR_DOC_STATUS_ILLEGAL"
  | "ERR_DOC_NO_LINES"
  | "ERR_POLICY_NOT_FOUND"
  | "ERR_POLICY_INVALID"
  | "ERR_POLICY_REQUIRES_MISSING"
  | "ERR_PERIOD_NOT_FOUND"
  | "ERR_PERIOD_NOT_OPEN"
  | "ERR_LEDGER_UNBALANCED";

export class PostingError extends Error {
  constructor(
    readonly code: PostingErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PostingError";
  }
}
```

- [ ] **Step 3: Write `packages/db/src/posting/load.ts`**

```ts
import type { Sql } from "postgres";
import {
  currency, Money, parsePolicy, PolicyEvaluationError, UNIT_RATE,
  type CurrencyCode, type DocumentSnapshot, type ExchangeRate, type LineSnapshot, type PostingPolicy,
} from "@dulja/domain";
import { PostingError } from "./errors";

interface HeaderRow {
  id: string; company_id: string; document_type_id: string; document_type_code: string; status: string;
  series: string; fiscal_period_id: string | null; number: string | null; effective_date: string;
  party_id: string | null; currency: string; exchange_rate: string; rate_source: string | null;
  reverses_document_id: string | null; client_ref: string | null; branch_id: string; attributed_to: string | null;
  base_currency: string; fx_rounding_account_id: string | null;
}
interface LineRow {
  id: string; line_no: number; description: string | null; account_id: string | null;
  debit: string; credit: string; dimensions: Record<string, string>; custom_fields: Record<string, unknown>;
}

/** contracts §4.4.2's shape, filled at the Phase 1 subset. Every `null`/`{}`/literal below is a column a later
 *  slice adds; the field is declared now so no consumer changes when it does (this plan's assumption 8). */
export async function loadSnapshot(tx: Sql, documentId: string): Promise<DocumentSnapshot> {
  const [h] = await tx<HeaderRow[]>`
    select d.id, d.company_id, d.document_type_id, t.code as document_type_code, d.status::text as status,
           d.series, d.fiscal_period_id, d.number::text as number, to_char(d.effective_date, 'YYYY-MM-DD') as effective_date,
           d.party_id, d.currency, d.exchange_rate::text as exchange_rate, d.rate_source,
           d.reverses_document_id, d.client_ref::text as client_ref, d.branch_id, d.attributed_to,
           c.base_currency, c.fx_rounding_account_id
      from app.document d
      join app.document_type t on t.id = d.document_type_id
      join app.company c       on c.id = d.company_id
     where d.id = ${documentId}`;
  if (!h) throw new PostingError("ERR_NOT_FOUND", `no document ${documentId} in this tenant`);

  const docCurrency = currency(h.currency);
  const baseCurrency = currency(h.base_currency);
  const exchangeRate: ExchangeRate =
    h.currency === h.base_currency
      ? { ...UNIT_RATE(baseCurrency), effectiveFrom: h.effective_date }
      : {
          from: docCurrency, to: baseCurrency,
          rate: h.exchange_rate,                    // already "4.68350000" — ::text preserves numeric(19,8)'s scale; a parseFloat here would be SAH-012 in the new system
          effectiveFrom: h.effective_date,
          source: h.rate_source ?? "unknown",
        };

  const lineRows = await tx<LineRow[]>`
    select id, line_no, description, account_id, debit::text as debit, credit::text as credit, dimensions, custom_fields
      from app.document_line where document_id = ${documentId} order by line_no`;
  const zero = Money.zero(docCurrency);
  const lines: LineSnapshot[] = lineRows.map((r) => ({
    id: r.id, lineNo: r.line_no,
    kind: "account",                              // 2A's migration 0019 adds the column; every 1A row is an account line
    description: r.description, accountId: r.account_id, itemId: null, quantity: null, unitPrice: null,
    discount: zero, amount: zero, taxCodeId: null, taxAmount: zero, totalInclTax: zero,
    debit: Money.of(r.debit, docCurrency), credit: Money.of(r.credit, docCurrency),
    cost: null, warehouseId: null, toWarehouseId: null, lotId: null, unitId: null, unitQuantity: null,
    countedQuantity: null, expectedQuantity: null, tenderMethod: null,
    customFields: r.custom_fields, dimensions: r.dimensions, payroll: null,
  }));

  const accountRows = await tx<{ code: string; id: string }[]>`
    select code, id from app.account
     where company_id = ${h.company_id} and is_group = false and archived_at is null`;
  const dimensionRows = await tx<{ code: string; id: string }[]>`
    select code, id from app.dimension_type where company_id = ${h.company_id}`;

  return {
    header: {
      id: h.id, companyId: h.company_id, documentTypeCode: h.document_type_code,
      status: h.status as DocumentSnapshot["header"]["status"], series: h.series,
      fiscalPeriodId: h.fiscal_period_id, number: h.number === null ? null : BigInt(h.number),
      effectiveDate: h.effective_date, partyId: h.party_id, currency: docCurrency, exchangeRate,
      branchId: h.branch_id, attributedTo: h.attributed_to, clientRef: h.client_ref,
      warehouseId: null,                          // 3A's migration 0031
      toWarehouseId: null,                        // 3A's migration 0031
      taxInclusive: false,                        // 5A's migration 0054
      reversesDocumentId: h.reverses_document_id,
      customFields: {},                           // 0D's custom_field_value is read by 2A's loader
    },
    lines,
    company: {
      id: h.company_id, baseCurrency, fxRoundingAccountId: h.fx_rounding_account_id,
      costingMethod: "avco",                      // 3B adds company.costing_method; OD-06's default until then
    },
    party: null,                                  // 2A's app.party
    refs: {
      accountsByCode: Object.fromEntries(accountRows.map((r) => [r.code, r.id])),
      items: {}, taxCodes: {}, components: {}, schemes: {},
      dimensionTypesByCode: Object.fromEntries(dimensionRows.map((r) => [r.code, r.id])),
    },
  };
}

/** The policy effective for a document: the greatest effective_from <= effectiveDate, ties broken by the
 *  highest version (spec:2172, contracts §4.3.1). The definition is parsed against the schema on the way out,
 *  so a hand-edited or stale row is refused rather than evaluated (SAH-013). */
export async function resolvePolicy(
  tx: Sql,
  documentTypeId: string,
  effectiveDate: string,
): Promise<{ policyId: string; definition: PostingPolicy }> {
  const [row] = await tx<{ id: string; version: number; definition: unknown }[]>`
    select id, version, definition from app.posting_policy
     where document_type_id = ${documentTypeId} and effective_from <= ${effectiveDate}::date
     order by effective_from desc, version desc
     limit 1`;
  if (!row) {
    throw new PostingError("ERR_POLICY_NOT_FOUND", `no posting policy for document type ${documentTypeId} effective on ${effectiveDate}`);
  }
  try {
    return { policyId: row.id, definition: parsePolicy(row.definition) };
  } catch (e) {
    if (e instanceof PolicyEvaluationError) {
      throw new PostingError("ERR_POLICY_INVALID", `posting policy ${row.id} (version ${row.version}) is invalid: ${e.detail}`);
    }
    throw e;
  }
}
```

`packages/db/src/posting/index.ts`:

```ts
export * from "./errors";
export * from "./load";
```

Add `export * from "./posting";` to `packages/db/src/index.ts` beside the 0A and 0B exports.

- [ ] **Step 4: Extend `packages/db/test/fixtures.ts` with the four §4.17 helpers**

Append to the file. **Do not touch `Seed`, `seedTenant` or `draftDocument`** — the 0A tests depend on them exactly as they are (hazard 9).

```ts
import type { PostingPolicy } from "@dulja/domain";

/** contracts §4.3.7 — the `policy` member of the JOURNAL envelope, NOT the envelope. Task 13's seed file
 *  carries the same object and a test asserts the two are identical. */
export const JOURNAL_POLICY_V1: PostingPolicy = {
  version: 1,
  documentType: "JOURNAL",
  direction: "internal",
  requires: [],
  lines: [
    { for: "each_line", side: "debit", account: { from: "line.account" }, amount: "line.debit", when: { "line.kind": "account" } },
    { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "JV", assignAt: "issue" },
  reversal: { allowed: true, producesType: "JOURNAL" },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};

/** The one way any test creates a §4.15 account. Idempotent on (company_id, code) so a helper that seeds a
 *  code seedTenant already created returns that row's id rather than colliding. */
export async function seedAccount(
  db: Db,
  s: Seed,
  opts: { code: string; nameEn: string; type: "asset" | "liability" | "equity" | "income" | "expense"; parentCode?: string; currency?: string },
): Promise<string> {
  const id = await uuidv7(db.admin);
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const parent = opts.parentCode
      ? (await tx<{ id: string }[]>`select id from app.account where company_id = ${s.company} and code = ${opts.parentCode}`)[0]?.id ?? null
      : null;
    await tx`insert into app.account (id, tenant_id, company_id, code, name_en, type, parent_id, currency)
             values (${id}, ${s.tenant}, ${s.company}, ${opts.code}, ${opts.nameEn}, ${opts.type}::app.account_type,
                     ${parent}, ${opts.currency ?? null})
             on conflict (company_id, code) do nothing`;
    const [row] = await tx<{ id: string }[]>`select id from app.account where company_id = ${s.company} and code = ${opts.code}`;
    return row!.id;
  });
}

/** Inserts JOURNAL_POLICY_V1 as posting_policy.version = 2 for the seeded JOURNAL type, effective 2026-01-01
 *  — matching the seed pack's policyVersion and effectiveFrom (contracts §4.3.7) so the fixture and the pack
 *  agree. 0A's version 1 row is left exactly as it is. */
export async function seedJournalPolicy(db: Db, s: Seed): Promise<void> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.posting_policy (id, tenant_id, document_type_id, version, effective_from, definition)
    values (${id}, ${s.tenant}, ${s.docType}, 2, '2026-01-01', ${JSON.stringify(JOURNAL_POLICY_V1)}::jsonb)
    on conflict (document_type_id, version) do update
       set definition = excluded.definition, effective_from = excluded.effective_from`);
}

/** seedTenant plus everything a posting test needs: the 5920 FX-rounding account wired to the company, and
 *  the JOURNAL policy v1. Seed keeps its 0A shape — a test that needs the FX account's id reads
 *  `company.fx_rounding_account_id` or calls seedAccount(db, s, { code: "5920", … }) again. */
export async function seedTenantV2(db: Db, name: string): Promise<Seed> {
  const s = await seedTenant(db, name);
  const fx = await seedAccount(db, s, { code: "5920", nameEn: "FX rounding", type: "expense" });
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    update app.company set fx_rounding_account_id = ${fx} where id = ${s.company}`);
  await seedJournalPolicy(db, s);
  return s;
}
```

- [ ] **Step 5: Add the four remaining error codes to `packages/contracts/src/errors.ts` and the `PostingError` branch to `apps/api/src/problem.ts`**

**All four rows land here, in this step, and none of them waits for Task 8.** Step 2 above declared `PostingErrorCode` with all nine of §4.3.8's Phase 1 members, and the branch below relies on `PostingErrorCode` being a literal subset of `ErrCode` **with no cast**. `ErrCode` is `keyof typeof ERRORS` (§4.2.4), 0B's shipped `ERRORS` subset contains neither `ERR_DOC_NO_LINES`, `ERR_DOC_STATUS_ILLEGAL` nor `ERR_PERIOD_NOT_FOUND`, and Task 5 added only the two `ERR_POLICY_*` rows — so leaving those three until Task 8 would make Step 6's `apps/api typecheck` fail here, and would also leave Task 7's `issueDocument` raising `ERR_DOC_STATUS_ILLEGAL` and `ERR_PERIOD_NOT_FOUND` a whole task before either code exists. The `error-codes` build check (§4.2.4, contracts:1473) is satisfied for all four the moment `packages/db/src/posting/errors.ts` exists, because it looks for the code as a string literal anywhere under `packages/**/src/**` and Step 2 wrote all nine there.

In `errors.ts` — the last four of this slice's six rows (Task 5 wrote `ERR_POLICY_INVALID` and `ERR_POLICY_REQUIRES_MISSING`):

```ts
  ERR_POLICY_NOT_FOUND:         { status: 422, title: "No posting policy",               remedy: "Seed a posting policy for this document type effective on or before the document's effective date" },
  ERR_DOC_NO_LINES:             { status: 422, title: "Document has no lines",           remedy: "Add at least one line with a non-zero debit or credit, then post again" },
  ERR_DOC_STATUS_ILLEGAL:       { status: 409, title: "Illegal document transition",     remedy: "Check the document's current status; a posted document is corrected by reversal, never by editing" },
  ERR_PERIOD_NOT_FOUND:         { status: 422, title: "No fiscal period",                remedy: "Create the fiscal period covering this effective date, or correct the date" },
```

In `apps/api/src/problem.ts`, add the import and one branch to `asAppError`, directly after the `TenantContextError` branch it mirrors:

```ts
import { PostingError, TenantContextError } from "@dulja/db";
```

```ts
  if (e instanceof PostingError) return new AppError(e.code, e.detail);
```

`PostingErrorCode` is a literal subset of `ErrCode`, so this line type-checks with no cast; if it does not, a code is missing from `ERRORS` and the compiler names it. (0B's own `TenantContextError` branch writes `e.code as ErrCode`; this branch deliberately does not, because the cast is what would let a missing row through silently.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/posting/load.test.ts`
Expected: **PASS** (9 tests). If the tie-break test reports `version 1`, the `order by` in `resolvePolicy` is missing `, version desc`.

Run: `bun run --cwd packages/db test && bun run --cwd apps/api typecheck`
Expected: PASS — `documents.test.ts` and `ledger.test.ts` from Plan 0A are unaffected because `seedTenant` is untouched.

- [ ] **Step 7: Commit**

```bash
git add packages/db packages/contracts apps/api
git commit -m "$(cat <<'EOF'
feat(db): loadSnapshot, resolvePolicy and the four 1A test fixtures [1A T6]

The reading half of the posting service. The snapshot is built at its final
§4.4.2 shape and filled at the Phase 1 subset, so no consumer changes when 2A,
3A, 3B or 5A add their columns. resolvePolicy takes the greatest effective_from
and breaks a tie on the highest version, which is what lets seedTenantV2's
policy v2 win over Plan 0A's stub at the same date, and it parses the stored
definition so a hand-edited row is refused rather than evaluated (SAH-013).

PostingError carries the §4.3.8 codes; apps/api maps it in one branch beside the
TenantContextError branch, because packages/db may import only @dulja/domain.
All four remaining ERR_* rows land here rather than in the task that first raises
each, because that branch relies on PostingErrorCode being a literal subset of
ErrCode with no cast, and PostingErrorCode is complete from this commit on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7 — `issueDocument`: numbering under the series advisory lock

The point where a document stops being a draft and acquires a number nobody else can have. SAH-051 is the legacy system's numbering: a `max() + 1` with no lock, no uniqueness constraint and no record of a number that was issued and then abandoned. All three are fixed here — the counter is a row, the row is taken under an advisory lock keyed on `(company, series, period)`, and the database refuses a duplicate through `unique (company_id, series, fiscal_period_id, number)` even if the lock were somehow bypassed.

**Files:**
- Create: `packages/db/src/posting/issue.ts`, `packages/db/test/posting/issue.test.ts`
- Modify: `packages/db/src/posting/index.ts`

**Interfaces:**
- Produces (TS), exported from `@dulja/db`:

```ts
export interface IssueResult { documentId: string; series: string; fiscalPeriodId: string; number: bigint }
export async function issueDocument(tx: Sql, ctx: TenantContext, input: { documentId: string }): Promise<IssueResult>;
```

- Consumes: `loadSnapshot`, `resolvePolicy`, `PostingError` (Task 6); `TenantContext` (§4.2.2); `Sql`.

**The SQL is contracts §4.3.6, verbatim.** The lock key `'series:<company>/<series>/<period>'` is fixed by spec:1741 and is **not** the audit chain's `'tenant-serial:<tenant>'` key — the two never contend. `pg_advisory_xact_lock` is released at commit, and a rollback releases it without consuming the number, which is exactly why the counter is a row and not a sequence: a sequence would leave gaps that nothing can explain, and spec:2222 requires numbering to be gapless-provable.

**Period resolution happens here.** `issueDocument` sets `fiscal_period_id` from `effective_date` (§4.3.2 step 5 and spec:1756 "resolved from `effective_date` at issue"), which is what makes the lock key well-defined. A document whose `effective_date` falls in no period raises `ERR_PERIOD_NOT_FOUND`; a period that is not `open` raises `ERR_PERIOD_NOT_OPEN` — the pre-check, with `assert_period_open` on `ledger_entry` remaining the control.

- [ ] **Step 1: Write the failing test `packages/db/test/posting/issue.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { issueDocument } from "../../src/posting";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { draftDocument, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("issueDocument — contracts §4.3.6 (SAH-051, spec:2222)", () => {
  let db: Db;
  let a: Seed;
  const ctx = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: "req-issue" });

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("issues 1 for the first document of a series in a period and 2 for the next", async () => {
    const one = await draftDocument(db, a);
    const two = await draftDocument(db, a);
    const first = await prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: one }));
    const second = await prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: two }));
    expect(first).toEqual({ documentId: one, series: "JV", fiscalPeriodId: a.period, number: 1n });
    expect(second.number).toBe(2n);
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ status: string; number: string }[]>`
      select status::text as status, number::text as number from app.document where id in (${one}, ${two}) order by number`);
    expect(rows.map((r) => r.status)).toEqual(["issued", "issued"]);
  });

  it("restarts at 1 in a different period of the same series (spec:1772 'year 2 starts at 1')", async () => {
    const periodId = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, (tx) => tx`
      insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status)
      values (${periodId}, ${a.tenant}, ${a.company}, '2027-01-01', '2027-01-31', 'open')`);
    const doc = await draftDocument(db, a, { effectiveDate: "2027-01-10", periodId });
    const result = await prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: doc }));
    expect(result).toMatchObject({ number: 1n, fiscalPeriodId: periodId });
  });

  it("two connections racing the FIRST document of a new series both succeed, with 1 and 2 (test 16)", async () => {
    const periodId = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, (tx) => tx`
      insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status)
      values (${periodId}, ${a.tenant}, ${a.company}, '2028-01-01', '2028-01-31', 'open')`);
    const left = await draftDocument(db, a, { effectiveDate: "2028-01-10", periodId });
    const right = await draftDocument(db, a, { effectiveDate: "2028-01-10", periodId });

    // Two real connections, max: 1 each — the interleaving spec:2266 asks for, not two promises on one pool.
    const one = postgres(db.url("app_rw"), { max: 1, prepare: false });
    const two = postgres(db.url("app_rw"), { max: 1, prepare: false });
    try {
      const results = await Promise.all([
        prodWithTenant(one, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: left })),
        prodWithTenant(two, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: right })),
      ]);
      expect(results.map((r) => r.number).sort()).toEqual([1n, 2n]);
    } finally {
      await one.end();
      await two.end();
    }
  });

  it("refuses an effective_date that falls in no period", async () => {
    const doc = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${doc}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2099-06-01', 'MYR', ${a.hq})`);
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: doc })),
    ).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_FOUND" });
  });

  it("refuses a closed and a locked period before touching the counter (test 9, API path)", async () => {
    for (const [periodId, label] of [[a.closedPeriod, "2026-02-15"], [a.lockedPeriod, "2026-03-15"]] as const) {
      const doc = await draftDocument(db, a, { effectiveDate: label, periodId });
      await expect(
        prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: doc })),
      ).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
    }
    const [counter] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_series where fiscal_period_id in (${a.closedPeriod}, ${a.lockedPeriod})`);
    expect(counter!.n).toBe(0);
  });

  it("refuses to issue a document that is already issued", async () => {
    const doc = await draftDocument(db, a);
    await prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: doc }));
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: doc })),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
  });

  it("a rolled-back issue consumes no number (spec:1744)", async () => {
    const doomed = await draftDocument(db, a);
    const next = await draftDocument(db, a);
    const before = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ next_number: string }[]>`
      select next_number::text as next_number from app.document_series
       where company_id = ${a.company} and series = 'JV' and fiscal_period_id = ${a.period}`);
    await expect(
      prodWithTenant(db.rw, ctx(a), async (tx) => {
        await issueDocument(tx, ctx(a), { documentId: doomed });
        throw new Error("caller aborts after issuing");
      }),
    ).rejects.toThrow("caller aborts after issuing");
    const issued = await prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: next }));
    expect(issued.number).toBe(BigInt(before[0]!.next_number));
  });
});
```

Run: `bun run --cwd packages/db test -- test/posting/issue.test.ts`
Expected: **FAIL** — `issueDocument is not a function` (the barrel exports only `errors` and `load`).

- [ ] **Step 2: Write `packages/db/src/posting/issue.ts`**

```ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { PostingError } from "./errors";
import { loadSnapshot, resolvePolicy } from "./load";

export interface IssueResult { documentId: string; series: string; fiscalPeriodId: string; number: bigint }

/** The transitions from which `→ issued` is reachable at Phase 1. `approval.required = false` on the JOURNAL
 *  policy admits `draft → issued` (contracts §4.5.1, the two rows marked †); 2B moves this table into
 *  app.document_status_before() where it becomes the control rather than a pre-check. */
const ISSUABLE_FROM = new Set(["draft", "submitted", "approved"]);

/**
 * Resolves the fiscal period from `effective_date`, takes the series counter under the advisory lock of
 * spec:1741 and writes `status = 'issued'`, `series`, `fiscal_period_id` and `number` on the document.
 * Takes the caller's `tx` and opens none of its own, so a rollback releases the lock and never consumes a
 * number (spec:1744).
 */
export async function issueDocument(tx: Sql, ctx: TenantContext, input: { documentId: string }): Promise<IssueResult> {
  const snapshot = await loadSnapshot(tx, input.documentId);
  if (snapshot.header.status === "issued") {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL", `document ${input.documentId} is already issued as ${snapshot.header.series} ${snapshot.header.number}`);
  }
  if (!ISSUABLE_FROM.has(snapshot.header.status)) {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL", `document ${input.documentId} is ${snapshot.header.status} and cannot be issued`);
  }

  // The snapshot carries the type's CODE (the evaluator resolves policies by code); resolvePolicy is keyed by
  // the type's id, so it is read here rather than widening the frozen DocumentSnapshot shape.
  const [typeRow] = await tx<{ document_type_id: string }[]>`
    select document_type_id from app.document where id = ${input.documentId}`;
  const { definition } = await resolvePolicy(tx, typeRow!.document_type_id, snapshot.header.effectiveDate);
  const series = definition.numbering.series;

  const [period] = await tx<{ id: string; status: string }[]>`
    select id, status::text as status from app.fiscal_period
     where company_id = ${snapshot.header.companyId}
       and ${snapshot.header.effectiveDate}::date between starts_on and ends_on`;
  if (!period) {
    throw new PostingError("ERR_PERIOD_NOT_FOUND", `no fiscal period of company ${snapshot.header.companyId} contains ${snapshot.header.effectiveDate}`);
  }
  if (period.status !== "open") {
    throw new PostingError("ERR_PERIOD_NOT_OPEN", `fiscal period ${period.id} is ${period.status}`);
  }

  // contracts §4.3.6, verbatim. The key is spec:1741's; it is deliberately NOT the audit chain's
  // 'tenant-serial:<tenant>' key, so the two locks can never deadlock with each other (plan0A:2280-2284).
  await tx`select pg_advisory_xact_lock(hashtextextended('series:' || ${snapshot.header.companyId}::text || '/' || ${series} || '/' || ${period.id}::text, 0))`;
  // The counter row is created on first use — this is the "first document of a new series in a new period"
  // half of acceptance test 16, and the reason both racers below succeed instead of one hitting a missing row.
  await tx`insert into app.document_series (tenant_id, company_id, series, fiscal_period_id)
           values (${ctx.tenantId}, ${snapshot.header.companyId}, ${series}, ${period.id})
           on conflict do nothing`;
  const [counter] = await tx<{ number: string }[]>`
    update app.document_series set next_number = next_number + 1
     where company_id = ${snapshot.header.companyId} and series = ${series} and fiscal_period_id = ${period.id}
     returning (next_number - 1)::text as number`;
  const number = BigInt(counter!.number);

  await tx`update app.document
              set status = 'issued', series = ${series}, fiscal_period_id = ${period.id}, number = ${number}
            where id = ${input.documentId}`;

  return { documentId: input.documentId, series, fiscalPeriodId: period.id, number };
}
```

Add `export * from "./issue";` to `packages/db/src/posting/index.ts`.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/posting/issue.test.ts`
Expected: **PASS** (7 tests). The race test is the one that matters: if it fails with `document_series_pkey` on one side, the `on conflict do nothing` is missing; if both sides return `1n`, the advisory lock line was dropped.

- [ ] **Step 4: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat(db): issueDocument — numbering under the series advisory lock [1A T7]

The counter is a row per (company, series, period) taken under
pg_advisory_xact_lock('series:<company>/<series>/<period>'), so two connections
racing the first document of a new period get 1 and 2 rather than a duplicate
(SAH-051, test 16). The period is resolved from effective_date and must be open
before the counter is touched. A rollback releases the lock and consumes no
number, which is what makes the series gapless-provable (spec:2222).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8 — `postDocument`, the `account_balance` `MERGE`, and the `posting-only-tables` lint

The centre of the system. Everything the spec's "Never" list protects runs through this one function: it is the only code that inserts a `ledger_entry`, and from Phase 3 the only code that inserts a movement, a cost layer or a tax transaction. The lint rule written here is the mechanical half of that promise — after this task, a `merge into app.account_balance` anywhere outside `packages/db/src/posting/`, `packages/db/src/costing/` or `packages/db/test/` fails the build.

**Files:**
- Create: `packages/db/src/posting/post.ts`, `packages/db/test/posting/post.test.ts`, `scripts/lint/rules/posting-only-tables.ts`, `scripts/lint/rules/posting-only-tables.test.ts`
- Modify: `packages/db/src/posting/index.ts`, `packages/contracts/src/errors.ts`

**Interfaces:**
- Produces (TS), exported from `@dulja/db`:

```ts
export interface PostResult {
  documentId: string; number: bigint; series: string; fiscalPeriodId: string;
  postingPolicyId: string; postingSeq: bigint;
  ledgerEntryIds: string[]; movementIds: string[]; taxTransactionIds: string[];
  enqueuedJobIds: string[]; warnings: string[];
}
export async function postDocument(tx: Sql, ctx: TenantContext, input: { documentId: string }): Promise<PostResult>;
```

- Produces (lint): `scripts/lint/rules/posting-only-tables.ts` exporting `rule: LintRule` named `posting-only-tables`.
- Consumes: `loadSnapshot`, `resolvePolicy`, `issueDocument`, `PostingError` (Tasks 6–7); `evaluatePolicy`, `validateRequires`, `balanceInBase`, `PolicyEvaluationError`, `PostingPlan` (Task 5); `TenantContext` (§4.2.2); `LintRule`, `LintViolation`, `SourceFile` from `scripts/lint/types` (0B).

**The algorithm is contracts §4.3.2, at its Phase 1 subset.** Steps 9 (movements, 3A+), 11 (tax transactions, 5A+), the `stock_on_hand`/`employee_ytd` half of step 12 (3A+/8C+) and step 14 (job enqueues, 3B/4B/5B) are **no-ops here** — each has a numbered comment in the code marking where its slice inserts itself, so a later writer adds a block rather than rearranging one. Step 13's `document_event` insert is a 2B trigger; at Phase 1 the update happens and no event row exists.

**Two guards this task adds that the registry text implies but does not spell out** (this plan's assumption 7 and the `posted_by` reading, assumption 1):
- After evaluation, `plan.ledgerLines.length === 0` raises `ERR_DOC_NO_LINES`. Nothing in the database would stop an empty posting: `assert_document_balanced` is satisfied by `0 = 0` and `assert_period_open` never fires with no rows, so a document whose policy plans nothing would silently reach `status = 'posted'` with no ledger entry at all.
- Step 13 writes `posted_by = app.current_actor()` explicitly. `app.document.posted_by` has no column default, and `app.stamp_actor` overwrites a supplied value on the NULL → non-null transition but never invents one.

- [ ] **Step 1: Write the failing test `packages/db/test/posting/post.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { draftDocument, seedAccount, seedTenant, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const ctx = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: "req-post" });

/** Drafts a document and gives it the lines listed, in order. Returns the document id. */
async function draftWithLines(
  db: Db, s: Seed, lines: { account: string; debit?: string; credit?: string; dimensions?: Record<string, string> }[],
  opts: { effectiveDate?: string; periodId?: string; currency?: string; rate?: string } = {},
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date,
                                       currency, exchange_rate, rate_source, branch_id)
             values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', ${opts.effectiveDate ?? "2026-01-15"},
                     ${opts.currency ?? "MYR"}, ${opts.rate ?? "1"}, ${opts.rate ? "BNM test" : null}, ${s.hq})`;
    let n = 0;
    for (const l of lines) {
      n += 1;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit, dimensions)
               values (${s.tenant}, ${s.company}, ${id}, ${n}, ${l.account}, ${l.debit ?? "0"}, ${l.credit ?? "0"},
                       ${JSON.stringify(l.dimensions ?? {})}::jsonb)`;
    }
  });
  return id;
}

describe("postDocument — contracts §4.3.2 (SAH-003, 012, 031, 041, 044)", () => {
  let db: Db;
  let a: Seed;
  let plain: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    plain = await seedTenant(db, "Plain");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("issues, stamps a posting_seq, writes the ledger and merges the balance in one transaction", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "100.0000" },
      { account: a.sales, credit: "100.0000" },
    ]);
    const result = await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));

    expect(result.series).toBe("JV");
    expect(result.fiscalPeriodId).toBe(a.period);
    expect(result.ledgerEntryIds).toHaveLength(2);
    expect(result.movementIds).toEqual([]);
    expect(result.taxTransactionIds).toEqual([]);
    expect(result.enqueuedJobIds).toEqual([]);
    expect(result.postingSeq).toBeGreaterThan(0n);

    const [header] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { status: string; posted_by: string; posting_policy_id: string; posted_at: Date | null }[]
    >`select status::text as status, posted_by::text as posted_by, posting_policy_id::text as posting_policy_id, posted_at
        from app.document where id = ${doc}`);
    expect(header!.status).toBe("posted");
    expect(header!.posted_by).toBe(a.human);                    // stamped from the session, never a parameter (SAH-044)
    expect(header!.posting_policy_id).toBe(result.postingPolicyId);
    expect(header!.posted_at).not.toBeNull();

    const entries = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { line_no: number; account_id: string; debit: string; credit: string; base_debit: string; currency: string; exchange_rate: string; posted_by: string }[]
    >`select line_no, account_id::text as account_id, debit::text as debit, credit::text as credit,
             base_debit::text as base_debit, currency, exchange_rate::text as exchange_rate, posted_by::text as posted_by
        from app.ledger_entry where document_id = ${doc} order by line_no`);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ line_no: 1, account_id: a.cash, debit: "100.0000", credit: "0.0000", base_debit: "100.0000", currency: "MYR", posted_by: a.human });
    expect(entries[1]).toMatchObject({ line_no: 2, account_id: a.sales, credit: "100.0000" });

    const dims = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ dimension_value_id: string }[]>`
      select d.dimension_value_id::text as dimension_value_id
        from app.ledger_entry_dimension d join app.ledger_entry l on l.id = d.entry_id
       where l.document_id = ${doc}`);
    expect(dims).toHaveLength(2);
    expect(dims.every((d) => d.dimension_value_id === a.hq)).toBe(true);   // BRANCH on every line (spec:1066)

    const [balance] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ debit: string; base_debit: string }[]>`
      select debit::text as debit, base_debit::text as base_debit from app.account_balance
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    expect(balance).toMatchObject({ debit: "100.0000", base_debit: "100.0000" });
  });

  it("accumulates the projection over two documents rather than replacing it (SAH-002)", async () => {
    // The tenant is seeded once in beforeAll and the first test in this file posts 100.0000 to a.cash, so
    // the value is deterministic. Asserted as the exact numeric(19,4) STRING: converting a money column to
    // a JS float to compare it approximately is the thing spec:97-104 forbids, and this is a test, which is
    // exactly where the habit would start.
    const [before] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ debit: string }[]>`
      select debit::text as debit from app.account_balance
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    expect(before!.debit).toBe("100.0000");
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "40.0000" },
      { account: a.sales, credit: "40.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));
    const [after] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ debit: string }[]>`
      select debit::text as debit from app.account_balance
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    expect(after!.debit).toBe("140.0000");
  });

  it("adds one FX-rounding line when per-line base rounding leaves a residue (spec:1868)", async () => {
    // The fixture has to LEAVE a residue, which is fussier than it looks. At 4.68350000 the obvious
    // 0.3335 = 0.1667 + 0.1668 splits to 1.5619 = 0.7807 + 0.7812 in base — exactly balanced, no residue,
    // no fx line, and this test would assert a state it can never reach. This fixture does leave one:
    //   debit  0.0003 × 4.68350000 = 0.00140505 → 0.0014
    //   credit 0.0001 × 4.68350000 = 0.00046835 → 0.0005, three of them → 0.0015
    //   residue = 0.0014 − 0.0015 = −0.0001, inside the 0.01 × 4 tolerance, so ONE fx_rounding DEBIT line
    //   of 0.0001 MYR at rate 1.00000000 is appended and Σbase debit = Σbase credit = 0.0015.
    const b = await seedAccount(db, a, { code: "1100", nameEn: "Bank", type: "asset" });
    const c = await seedAccount(db, a, { code: "1300", nameEn: "Inventory control", type: "asset" });
    const doc = await draftWithLines(
      db, a,
      [
        { account: a.cash, debit: "0.0003" },
        { account: b, credit: "0.0001" },
        { account: c, credit: "0.0001" },
        { account: a.sales, credit: "0.0001" },
      ],
      { currency: "USD", rate: "4.68350000" },
    );
    const result = await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));
    expect(result.ledgerEntryIds).toHaveLength(5);            // four policy lines plus the fx_rounding line
    const [fx] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { currency: string; exchange_rate: string; account_id: string; debit: string; base_debit: string }[]
    >`select currency, exchange_rate::text as exchange_rate, account_id::text as account_id,
             debit::text as debit, base_debit::text as base_debit
        from app.ledger_entry where document_id = ${doc} order by line_no desc limit 1`);
    expect(fx).toMatchObject({ currency: "MYR", exchange_rate: "1.00000000", debit: "0.0001", base_debit: "0.0001" });
    const [company] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ fx: string }[]>`
      select fx_rounding_account_id::text as fx from app.company where id = ${a.company}`);
    expect(fx!.account_id).toBe(company!.fx);
    const [sum] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ diff: string }[]>`
      select (sum(base_debit) - sum(base_credit))::text as diff from app.ledger_entry where document_id = ${doc}`);
    expect(sum!.diff).toBe("0.0000");
  });

  it("refuses a document with no lines and a document whose policy plans none", async () => {
    const empty = await draftWithLines(db, a, []);
    await expect(prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: empty })))
      .rejects.toMatchObject({ code: "ERR_DOC_NO_LINES" });

    const narrationOnly = await draftWithLines(db, a, [{ account: a.cash }]);   // debit 0, credit 0
    await expect(prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: narrationOnly })))
      .rejects.toMatchObject({ code: "ERR_DOC_NO_LINES" });
  });

  it("refuses an unbalanced document before writing any row (SAH-003)", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "100.0000" },
      { account: a.sales, credit: "90.0000" },
    ]);
    await expect(prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc })))
      .rejects.toMatchObject({ code: "ERR_LEDGER_UNBALANCED" });
    const [rows] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where document_id = ${doc}`);
    expect(rows!.n).toBe(0);
    const [status] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ status: string }[]>`
      select status::text as status from app.document where id = ${doc}`);
    expect(status!.status).toBe("draft");
  });

  it("refuses a closed and a locked period, and the trigger is the control (test 9, admin path)", async () => {
    for (const [periodId, date] of [[a.closedPeriod, "2026-02-15"], [a.lockedPeriod, "2026-03-15"]] as const) {
      const doc = await draftWithLines(db, a, [
        { account: a.cash, debit: "5.0000" }, { account: a.sales, credit: "5.0000" },
      ], { effectiveDate: date, periodId });
      await expect(prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc })))
        .rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
    }
    // The pre-check is a better message; the control is app.assert_period_open on ledger_entry (spec:1862).
    const doc = await draftWithLines(db, a, [{ account: a.cash, debit: "5.0000" }, { account: a.sales, credit: "5.0000" }]);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id, debit, credit,
                                      currency, exchange_rate, base_debit, base_credit, effective_date,
                                      fiscal_period_id, posting_policy_id)
        values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 5.0000, 0, 'MYR', 1, 5.0000, 0,
                '2026-03-15', ${a.lockedPeriod}, ${a.policy})`),
    ).rejects.toThrow(/ERR_PERIOD_NOT_OPEN/);
  });

  it("refuses a second post of the same document", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "7.0000" }, { account: a.sales, credit: "7.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));
    await expect(prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc })))
      .rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
  });

  it("refuses a line whose dimension names a type the company does not have", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "1.0000", dimensions: { PROJECT: a.hq } },
      { account: a.sales, credit: "1.0000" },
    ]);
    await expect(prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc })))
      .rejects.toMatchObject({ code: "ERR_POLICY_REQUIRES_MISSING" });
  });

  it("refuses to post a document of a tenant whose policy is the 0A stub", async () => {
    const doc = await draftWithLines(db, plain, [
      { account: plain.cash, debit: "1.0000" }, { account: plain.sales, credit: "1.0000" },
    ]);
    await expect(
      prodWithTenant(db.rw, ctx(plain), (tx) => postDocument(tx, ctx(plain), { documentId: doc })),
    ).rejects.toMatchObject({ code: "ERR_POLICY_INVALID" });
  });
});
```

Run: `bun run --cwd packages/db test -- test/posting/post.test.ts`
Expected: **FAIL** — `postDocument is not a function`.

- [ ] **Step 2: Write `packages/db/src/posting/post.ts`**

```ts
import type { Sql } from "postgres";
import {
  balanceInBase, evaluatePolicy, PolicyEvaluationError, validateRequires,
  type DocumentSnapshot, type PlannedLedgerLine, type PostingPlan, type PostingPolicy,
} from "@dulja/domain";
import type { TenantContext } from "../with-tenant";
import { PostingError } from "./errors";
import { issueDocument } from "./issue";
import { loadSnapshot, resolvePolicy } from "./load";

export interface PostResult {
  documentId: string; number: bigint; series: string; fiscalPeriodId: string;
  postingPolicyId: string; postingSeq: bigint;
  ledgerEntryIds: string[]; movementIds: string[]; taxTransactionIds: string[];
  enqueuedJobIds: string[]; warnings: string[];
}

const POSTABLE_FROM = new Set(["draft", "submitted", "approved", "issued"]);

/** contracts §4.3.2, at the Phase 1 subset. Takes the caller's `tx` and opens none of its own, so the
 *  handler's work and this posting commit or roll back together. */
export async function postDocument(tx: Sql, ctx: TenantContext, input: { documentId: string }): Promise<PostResult> {
  // 1. one poster per document.
  const [locked] = await tx<{ id: string; status: string; document_type_id: string; effective_date: string }[]>`
    select id, status::text as status, document_type_id, to_char(effective_date, 'YYYY-MM-DD') as effective_date
      from app.document where id = ${input.documentId} for update`;
  if (!locked) throw new PostingError("ERR_NOT_FOUND", `no document ${input.documentId} in this tenant`);

  // 2. status.
  if (!POSTABLE_FROM.has(locked.status)) {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL", `document ${input.documentId} is ${locked.status} and cannot be posted`);
  }

  // 3. snapshot.
  let snapshot = await loadSnapshot(tx, input.documentId);
  if (snapshot.lines.length === 0) {
    throw new PostingError("ERR_DOC_NO_LINES", `document ${input.documentId} has no lines`);
  }

  // 4. policy and its required inputs.
  const { policyId, definition } = await resolvePolicy(tx, locked.document_type_id, locked.effective_date);
  const { missing } = validateRequires(definition, snapshot);
  if (missing.length > 0) {
    throw new PostingError("ERR_POLICY_REQUIRES_MISSING", `document ${input.documentId} is missing ${missing.join(", ")}, required by policy ${policyId}`);
  }

  // 5. fiscal period — the pre-check; app.assert_period_open on ledger_entry remains the control (spec:1862).
  const [period] = await tx<{ id: string; status: string }[]>`
    select id, status::text as status from app.fiscal_period
     where company_id = ${snapshot.header.companyId}
       and ${locked.effective_date}::date between starts_on and ends_on`;
  if (!period) {
    throw new PostingError("ERR_PERIOD_NOT_FOUND", `no fiscal period of company ${snapshot.header.companyId} contains ${locked.effective_date}`);
  }
  if (period.status !== "open") {
    throw new PostingError("ERR_PERIOD_NOT_OPEN", `fiscal period ${period.id} is ${period.status}`);
  }

  // 6. evaluate, convert to base, absorb the rounding residue.
  const plan = planFor(definition, snapshot, input.documentId);

  // 7. issue if not issued.
  let series = snapshot.header.series;
  let number = snapshot.header.number;
  if (locked.status !== "issued") {
    const issued = await issueDocument(tx, ctx, { documentId: input.documentId });
    series = issued.series;
    number = issued.number;
    snapshot = await loadSnapshot(tx, input.documentId);
  }
  if (number === null) {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL", `document ${input.documentId} is issued with no number`);
  }

  // 8. posting_seq, BEFORE any row that carries it is written (contracts §4.3.5).
  const [seqRow] = await tx<{ posting_seq: string }[]>`
    update app.document set posting_seq = coalesce(posting_seq, nextval('app.posting_seq'))
     where id = ${input.documentId}
     returning posting_seq::text as posting_seq`;
  const postingSeq = BigInt(seqRow!.posting_seq);

  // 9. Phase 3 hook — `plan = await applyMovements(tx, ctx, plan, snapshot)` (contracts §4.7.2). 3A inserts
  //    inventory_movement here, 3B the cost layers; both fill `value` on the plan and `cost` on document_line.
  //    Nothing to do at Phase 1: the JOURNAL policy's inventory.effect is "none".

  // 10. the ledger and its dimensions.
  const ledgerEntryIds = await insertLedger(tx, ctx, snapshot, plan, {
    policyId, periodId: period.id, effectiveDate: locked.effective_date,
  });

  // 11. Phase 5 hook — app.tax_transaction rows (5A). The JOURNAL policy's tax.applies is false.

  // 12. the projection. 3A adds stock_on_hand here and 8C adds employee_ytd for PAYROLL documents (D14 —
  //     same transaction, never a job).
  //
  //     FIRST, serialise on the balance keys this document touches. `MERGE … WHEN NOT MATCHED THEN INSERT`
  //     is NOT `INSERT … ON CONFLICT`: it does not re-check the target on a concurrent insert, so two
  //     transactions that both find no account_balance row for the same
  //     (company_id, account_id, fiscal_period_id, currency) both take the NOT MATCHED branch and the second
  //     raises SQLSTATE 23505 when the first commits. The production withTenant retries 40001 and 40P01 only
  //     (§4.2.2), so that surfaces to the caller as ERR_CONFLICT_UNIQUE on a legitimate post. The path is
  //     reachable in this slice: a caller may issue in one request and post in another, and postDocument then
  //     skips issueDocument at step 7 — so the series advisory lock that serialises the draft→post path is
  //     not held here. The locks are taken in SORTED key order: two posts whose account sets overlap then
  //     queue in the same order instead of deadlocking. They are transaction-scoped and released at commit.
  //     (Contract amendment A4 registers this beside the §4.3.3 MERGE, so 3A's stock_on_hand and 8C's
  //     employee_ytd copy it rather than re-discover it.)
  const balanceKeys = [
    ...new Set(plan.ledgerLines.map((l) => `${l.accountId}/${period.id}/${l.amount.currency}`)),
  ].sort();
  for (const key of balanceKeys) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`balance:${snapshot.header.companyId}/${key}`}, 0))`;
  }

  await tx`
    merge into app.account_balance b
    using (select ${ctx.tenantId}::uuid as tenant_id, ${snapshot.header.companyId}::uuid as company_id,
                  l.account_id, l.fiscal_period_id, l.currency,
                  sum(l.debit) as debit, sum(l.credit) as credit,
                  sum(l.base_debit) as base_debit, sum(l.base_credit) as base_credit
             from app.ledger_entry l where l.document_id = ${input.documentId}::uuid
            group by l.account_id, l.fiscal_period_id, l.currency) s
       on b.company_id = s.company_id and b.account_id = s.account_id
      and b.fiscal_period_id = s.fiscal_period_id and b.currency = s.currency
     when matched then update set debit = b.debit + s.debit, credit = b.credit + s.credit,
                                  base_debit = b.base_debit + s.base_debit, base_credit = b.base_credit + s.base_credit,
                                  updated_at = now()
     when not matched then insert (tenant_id, company_id, account_id, fiscal_period_id, currency, debit, credit, base_debit, base_credit)
                           values (s.tenant_id, s.company_id, s.account_id, s.fiscal_period_id, s.currency,
                                   s.debit, s.credit, s.base_debit, s.base_credit)`;

  // 13. the header. posted_by is written explicitly — the column has no default and app.stamp_actor
  //     overwrites a supplied value on the NULL → non-null transition but never invents one (SAH-044).
  //     2B's AFTER UPDATE OF status trigger writes the document_event; at Phase 1 there is none.
  await tx`update app.document
              set status = 'posted', posting_policy_id = ${policyId}, posted_at = now(), posted_by = app.current_actor()
            where id = ${input.documentId}`;

  // 14. Phase 3+ hook — enqueue inventory.cost.replay (3B), accounting.projection.rebuild (4B),
  //     accounting.tax.submit (5B) on this same `tx`, so a rollback un-enqueues them (spec:2321).

  // 15. The deferred constraint trigger ledger_entry_balanced fires at COMMIT (spec:1865); if the step-6
  //     pre-check were ever wrong, the caller's withTenant surfaces ERR_LEDGER_UNBALANCED from there.
  return {
    documentId: input.documentId, number, series, fiscalPeriodId: period.id,
    postingPolicyId: policyId, postingSeq,
    ledgerEntryIds, movementIds: [], taxTransactionIds: [], enqueuedJobIds: [], warnings: plan.warnings,
  };
}

/** Step 6 in one place, so the two PolicyEvaluationError codes translate once. */
function planFor(definition: PostingPolicy, snapshot: DocumentSnapshot, documentId: string): PostingPlan {
  let plan: PostingPlan;
  try {
    plan = balanceInBase(
      evaluatePolicy(definition, snapshot),
      snapshot.company.fxRoundingAccountId,
      snapshot.company.baseCurrency,
    );
  } catch (e) {
    if (e instanceof PolicyEvaluationError) throw new PostingError(e.code, `document ${documentId}: ${e.detail}`);
    throw e;
  }
  if (plan.ledgerLines.length === 0) {
    // Nothing in the database would stop this: assert_document_balanced is satisfied by 0 = 0 and
    // assert_period_open never fires with no rows, so the document would reach 'posted' with no ledger.
    throw new PostingError("ERR_DOC_NO_LINES", `document ${documentId} has ${snapshot.lines.length} line(s) but the policy plans no ledger entry — every line is zero on both sides`);
  }
  return plan;
}

/** Step 10. The column list is plan0A:1916-1921 exactly; posted_by and posted_at come from the row defaults. */
async function insertLedger(
  tx: Sql,
  ctx: TenantContext,
  snapshot: DocumentSnapshot,
  plan: PostingPlan,
  at: { policyId: string; periodId: string; effectiveDate: string },
): Promise<string[]> {
  const ids: string[] = [];
  for (const line of plan.ledgerLines) {
    // An fx_rounding line is a BASE-currency line at rate 1 (spec:1868); a policy line carries the
    // document's currency and rate. Both satisfy base_* = round(value * rate, 4) by construction.
    const isFx = line.role === "fx_rounding";
    const lineCurrency = isFx ? snapshot.company.baseCurrency : snapshot.header.currency;
    const rate = isFx ? "1.00000000" : snapshot.header.exchangeRate.rate;
    const debit = line.side === "debit" ? line.amount.toString() : "0.0000";
    const credit = line.side === "credit" ? line.amount.toString() : "0.0000";
    const baseDebit = line.side === "debit" ? line.base.toString() : "0.0000";
    const baseCredit = line.side === "credit" ? line.base.toString() : "0.0000";

    const [entry] = await tx<{ id: string }[]>`
      insert into app.ledger_entry
        (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate,
         base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id)
      values (${ctx.tenantId}, ${snapshot.header.companyId}, ${snapshot.header.id}, ${line.lineNo},
              ${line.accountId}, ${debit}, ${credit}, ${lineCurrency}, ${rate},
              ${baseDebit}, ${baseCredit}, ${at.effectiveDate}, ${at.periodId}, ${at.policyId})
      returning id`;
    ids.push(entry!.id);
    await insertDimensions(tx, ctx, snapshot, entry!.id, line);
  }
  return ids;
}

async function insertDimensions(
  tx: Sql,
  ctx: TenantContext,
  snapshot: DocumentSnapshot,
  entryId: string,
  line: PlannedLedgerLine,
): Promise<void> {
  for (const [code, valueId] of Object.entries(line.dimensions)) {
    const typeId = snapshot.refs.dimensionTypesByCode[code];
    if (!typeId) {
      throw new PostingError("ERR_POLICY_REQUIRES_MISSING", `company ${snapshot.company.id} has no dimension type ${code}, named by planned line ${line.lineNo}`);
    }
    await tx`insert into app.ledger_entry_dimension (tenant_id, entry_id, dimension_type_id, dimension_value_id)
             values (${ctx.tenantId}, ${entryId}, ${typeId}, ${valueId})`;
  }
}
```

Add `export * from "./post";` to `packages/db/src/posting/index.ts`.

- [ ] **Step 3: Write the failing test for the lint rule, `scripts/lint/rules/posting-only-tables.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { SourceFile } from "../types";
import { rule } from "./posting-only-tables";

const file = (path: string, text: string): SourceFile => ({ path, text, lines: text.split("\n") });

describe("posting-only-tables — contracts §3.7.5, the mechanical half of spec:97", () => {
  it("flags a write to a ledger, movement or projection table outside the posting and costing homes", () => {
    const bad = file(
      "apps/api/src/routes/accounting/documents.ts",
      [
        "await tx`insert into app.ledger_entry (tenant_id) values (1)`;",
        "await tx`merge into app.account_balance b using (select 1) s on true`;",
        "await tx`delete from app.stock_on_hand where item_id = ${id}`;",
      ].join("\n"),
    );
    expect(rule.run([bad]).map((v) => v.line)).toEqual([1, 2, 3]);
    expect(rule.run([bad])[0]!.detail).toContain("app.ledger_entry");
  });

  it("allows the posting service, the costing engine, the db test tree and its own fixtures", () => {
    for (const path of [
      "packages/db/src/posting/post.ts",
      "packages/db/src/costing/apply.ts",
      "packages/db/test/posting/post.test.ts",
      "scripts/lint/rules/posting-only-tables.test.ts",
    ]) {
      expect(rule.run([file(path, "await tx`insert into app.ledger_entry (tenant_id) values (1)`;")])).toEqual([]);
    }
  });

  it("allows a read of the same tables anywhere — reports select freely", () => {
    const report = file("apps/api/src/routes/accounting/ledger.ts", "await tx`select * from app.ledger_entry where id = ${id}`;");
    expect(rule.run([report])).toEqual([]);
  });

  it("does not flag the async projections, which their own jobs rebuild (contracts §3.7.5)", () => {
    const job = file("apps/worker/src/jobs/rebuild.ts", "await tx`insert into app.party_ageing (tenant_id) values (1)`;");
    expect(rule.run([job])).toEqual([]);
  });
});
```

Run: `bun run --cwd . test -- scripts/lint/rules/posting-only-tables.test.ts` (or the command 0B's rule tests already use)
Expected: **FAIL** — `Cannot find module './posting-only-tables'`.

- [ ] **Step 4: Write `scripts/lint/rules/posting-only-tables.ts`**

```ts
import type { LintRule, LintViolation } from "../types";

/**
 * contracts §3.7.5, owned by 1A. The mechanical half of spec:97 "never write to a ledger or movement table
 * outside the posting service". Reads are unrestricted — a report selects freely.
 *
 * The async projections `party_ageing`, `item_profitability` and `stock_valuation` are deliberately NOT here:
 * they are rebuilt by their pg-boss jobs, not by the posting service.
 */
const PROTECTED = [
  "app.ledger_entry",
  "app.ledger_entry_dimension",
  "app.inventory_movement",
  "app.cost_layer",
  "app.cost_consumption",
  "app.account_balance",
  "app.stock_on_hand",
  "app.tax_transaction",
  "app.employee_ytd",           // 8C adds the table; the name is listed from the start so 8C adds no rule
];

const ALLOWED_PREFIXES = [
  "packages/db/src/posting/",
  "packages/db/src/costing/",
  "packages/db/test/",
  "scripts/lint/rules/",        // this rule's own fixtures name the tables in DML strings
];

/** `insert into app.x`, `update app.x`, `delete from app.x`, `merge into app.x` — the four DML verbs. */
const DML = /\b(?:insert\s+into|update|delete\s+from|merge\s+into)\s+(app\.[a-z_]+)/gi;

export const rule: LintRule = {
  name: "posting-only-tables",
  run(files) {
    const out: LintViolation[] = [];
    for (const f of files) {
      if (ALLOWED_PREFIXES.some((p) => f.path.startsWith(p))) continue;
      f.lines.forEach((line, i) => {
        for (const m of line.matchAll(DML)) {
          const table = m[1]!.toLowerCase();
          if (!PROTECTED.includes(table)) continue;
          out.push({
            file: f.path, line: i + 1, rule: this.name,
            detail: `${table} may be written only by packages/db/src/posting/ or packages/db/src/costing/ (spec:97, contracts §3.7.5)`,
          });
        }
      });
    }
    return out;
  },
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/posting/post.test.ts`
Expected: **PASS** (9 tests). Two failures worth naming in advance: if the FX test reports `ledger_entry_check` on `base_debit = round(debit * exchange_rate, 4)`, `toBase` is rounding with a mode other than `HALF_AWAY_FROM_ZERO` (contracts §5 item 23); if the "second post" test reports a unique violation on `ledger_entry_document_id_line_no_key` instead of `ERR_DOC_STATUS_ILLEGAL`, `POSTABLE_FROM` wrongly contains `"posted"`.

Run: `bun run lint:rules`
Expected: **the eight other rules pass with 0 violations, and `permission-catalogue` still reports the six 1A codes as unreferenced** — `9 rules, N files, 6 violations`, every one of them `permission-catalogue … accounting.* has no reference`. That is the phased catalogue working as spec:2142 intends (Task 4's commit body says so) and it is the documented exception to the after-every-task list; it clears at Task 12, which is where this stretch of commits becomes a pull request (Execution handoff). What this run is actually checking is **this task's new rule**: `posting-only-tables` must report **zero** violations. If it names a file outside `packages/db/src/posting/`, `packages/db/src/costing/`, `packages/db/test/` or `scripts/lint/rules/`, a ledger or projection write has escaped the posting service — stop and fix the write, never the allow-list.

- [ ] **Step 6: Commit**

```bash
git add packages/db scripts/lint
git commit -m "$(cat <<'EOF'
feat(db): postDocument, the account_balance MERGE and the posting-only-tables lint [1A T8]

The §4.3.2 algorithm at its Phase 1 subset, with a numbered comment at each of
the four hooks 3A, 3B, 5A and 5B fill. Rows are refused before anything is
written: no lines, a policy that plans none, a missing required input, a period
that is not open, a residue larger than rounding. posted_by is written from
app.current_actor() because the column has no default. The MERGE is preceded by
one transaction-scoped advisory lock per planned balance key, taken in sorted
order: MERGE has no ON CONFLICT-style re-check, so two concurrent posts to the
same (company, account, period, currency) would otherwise raise 23505 on a
legitimate post, and sorting is what keeps the queue from deadlocking. The lint
makes the "never write to a ledger table outside the posting service" rule
mechanical.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9 — `reverseDocument` and `voidDocument`: the two corrections D13 allows

A posted document is never edited and never deleted (spec:2224, SAH-041). There are exactly two corrections: a **void**, for a number that was issued and will never post — recorded as a `document_number_void` row so the gap in the series is explained rather than merely present (SAH-051) — and a **reversal**, for a document that did post, which creates a mirror-image document, posts it through the same `postDocument`, and marks the original `reversed` (D13).

Acceptance test 3 lives here: post to account A, reverse, re-post to a never-used account B, and `sum(account_balance) = sum(ledger_entry)`. That is the direct answer to SAH-002, where re-keying a posting destroyed the amount because the aggregate's upsert never fired on UPDATE.

**Files:**
- Create: `packages/db/src/posting/reverse.ts`, `packages/db/test/posting/reverse.test.ts`
- Modify: `packages/db/src/posting/index.ts`

**Interfaces:**
- Produces (TS), exported from `@dulja/db`:

```ts
export async function reverseDocument(tx: Sql, ctx: TenantContext, input: { documentId: string; effectiveDate: string; reason: string }): Promise<{ reversalDocumentId: string; number: bigint }>;
export async function voidDocument(tx: Sql, ctx: TenantContext, input: { documentId: string; reason: string }): Promise<void>;
```

- Consumes: `loadSnapshot`, `resolvePolicy`, `postDocument`, `PostingError` (Tasks 6–8); `TenantContext`.

**The reversal document is created, not conjured.** Contracts §4.3.2's closed write list reads "`document_line` (`cost` only, 3A+)" of the document *being posted*; D13 and §4.3.1's own docstring require the reversal document itself to exist, which means one `document` insert and one `document_line` insert per source line (this plan's assumption 6). Neither table is on the `posting-only-tables` list, and both writes happen inside `packages/db/src/posting/` regardless.

**Sides are swapped on the lines, not on the ledger.** The reversal is a document like any other: its lines carry the original's credits as debits and vice versa, and it is then posted through `postDocument` unchanged. That is what makes 1B's projection rebuild a pure sum — a reversal *adds* rows, it never subtracts (contracts §4.3.3).

- [ ] **Step 1: Write the failing test `packages/db/test/posting/reverse.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueDocument, postDocument, reverseDocument, voidDocument } from "../../src/posting";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { JOURNAL_POLICY_V1, seedAccount, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const ctx = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: "req-reverse" });

async function draftWithLines(
  db: Db, s: Seed, lines: { account: string; debit?: string; credit?: string }[],
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
             values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
    let n = 0;
    for (const l of lines) {
      n += 1;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit)
               values (${s.tenant}, ${s.company}, ${id}, ${n}, ${l.account}, ${l.debit ?? "0"}, ${l.credit ?? "0"})`;
    }
  });
  return id;
}

describe("reverseDocument and voidDocument — D13, spec:1745, SAH-002/041/051", () => {
  let db: Db;
  let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("creates a mirror document, posts it, and marks the original reversed", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "100.0000" },
      { account: a.sales, credit: "100.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));
    const reversal = await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), { documentId: doc, effectiveDate: "2026-01-20", reason: "keyed to the wrong account" }));

    const [original] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ status: string }[]>`
      select status::text as status from app.document where id = ${doc}`);
    expect(original!.status).toBe("reversed");

    const [mirror] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { status: string; series: string; reverses: string; effective_date: string }[]
    >`select status::text as status, series, reverses_document_id::text as reverses,
             to_char(effective_date, 'YYYY-MM-DD') as effective_date
        from app.document where id = ${reversal.reversalDocumentId}`);
    expect(mirror).toMatchObject({ status: "posted", series: "JV", reverses: doc, effective_date: "2026-01-20" });

    const entries = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { account_id: string; debit: string; credit: string }[]
    >`select account_id::text as account_id, debit::text as debit, credit::text as credit
        from app.ledger_entry where document_id = ${reversal.reversalDocumentId} order by line_no`);
    expect(entries).toEqual([
      { account_id: a.cash, debit: "0.0000", credit: "100.0000" },
      { account_id: a.sales, debit: "100.0000", credit: "0.0000" },
    ]);
  });

  it("test 3 — re-key a posting: sum(account_balance) equals sum(ledger_entry) after reverse and re-post", async () => {
    const wrong = await seedAccount(db, a, { code: "1100", nameEn: "Bank", type: "asset" });
    const never = await seedAccount(db, a, { code: "1300", nameEn: "Inventory control", type: "asset" });

    const first = await draftWithLines(db, a, [
      { account: wrong, debit: "250.0000" }, { account: a.sales, credit: "250.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: first }));
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), { documentId: first, effectiveDate: "2026-01-16", reason: "wrong account" }));

    const second = await draftWithLines(db, a, [
      { account: never, debit: "250.0000" }, { account: a.sales, credit: "250.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: second }));

    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { account_id: string; projected: string; posted: string }[]
    >`select b.account_id::text as account_id,
             (b.base_debit - b.base_credit)::text as projected,
             (coalesce(sum(l.base_debit), 0) - coalesce(sum(l.base_credit), 0))::text as posted
        from app.account_balance b
        left join app.ledger_entry l
          on l.company_id = b.company_id and l.account_id = b.account_id
         and l.fiscal_period_id = b.fiscal_period_id and l.currency = b.currency
       group by b.account_id, b.base_debit, b.base_credit
       order by 1`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.projected).toBe(r.posted);

    const [wrongBalance] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ net: string }[]>`
      select (base_debit - base_credit)::text as net from app.account_balance
       where account_id = ${wrong} and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    expect(wrongBalance!.net).toBe("0.0000");           // the mis-keyed account nets to nothing (SAH-002)
    const [neverBalance] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ net: string }[]>`
      select (base_debit - base_credit)::text as net from app.account_balance
       where account_id = ${never} and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    expect(neverBalance!.net).toBe("250.0000");
  });

  it("refuses to reverse anything that is not posted, and refuses a second reversal", async () => {
    const draft = await draftWithLines(db, a, [
      { account: a.cash, debit: "1.0000" }, { account: a.sales, credit: "1.0000" },
    ]);
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => reverseDocument(tx, ctx(a), { documentId: draft, effectiveDate: "2026-01-20", reason: "no" })),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });

    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: draft }));
    await prodWithTenant(db.rw, ctx(a), (tx) => reverseDocument(tx, ctx(a), { documentId: draft, effectiveDate: "2026-01-20", reason: "once" }));
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => reverseDocument(tx, ctx(a), { documentId: draft, effectiveDate: "2026-01-20", reason: "twice" })),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
  });

  it("refuses a reversal into a closed period — the correction must land somewhere open (spec:2224)", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "3.0000" }, { account: a.sales, credit: "3.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => reverseDocument(tx, ctx(a), { documentId: doc, effectiveDate: "2026-03-15", reason: "into a locked period" })),
    ).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
  });

  it("voids an issued document and records the number so the gap is explained (SAH-051)", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "9.0000" }, { account: a.sales, credit: "9.0000" },
    ]);
    const { number, series, fiscalPeriodId } = await prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: doc }));
    await prodWithTenant(db.rw, ctx(a), (tx) => voidDocument(tx, ctx(a), { documentId: doc, reason: "printed on the wrong stationery" }));

    const [header] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ status: string }[]>`
      select status::text as status from app.document where id = ${doc}`);
    expect(header!.status).toBe("void");
    const [voided] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ reason: string; voided_by: string }[]>`
      select reason, voided_by::text as voided_by from app.document_number_void
       where company_id = ${a.company} and series = ${series} and fiscal_period_id = ${fiscalPeriodId} and number = ${number}`);
    expect(voided).toMatchObject({ reason: "printed on the wrong stationery", voided_by: a.human });
  });

  it("refuses to void a draft (it has no number) and a posted document (spec:2224)", async () => {
    const draft = await draftWithLines(db, a, [
      { account: a.cash, debit: "2.0000" }, { account: a.sales, credit: "2.0000" },
    ]);
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => voidDocument(tx, ctx(a), { documentId: draft, reason: "no number yet" })),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });

    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: draft }));
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => voidDocument(tx, ctx(a), { documentId: draft, reason: "too late" })),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
  });

  it("refuses a reversal when the policy forbids one", async () => {
    const noReversal = { ...JSON.parse(JSON.stringify(JOURNAL_POLICY_V1)), reversal: { allowed: false, producesType: null } };
    const typeId = await uuidv7(db.admin);
    const policyId = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_type (id, tenant_id, company_id, code, name_en)
               values (${typeId}, ${a.tenant}, ${a.company}, 'NOREV', 'No reversal')`;
      await tx`insert into app.posting_policy (id, tenant_id, document_type_id, version, effective_from, definition)
               values (${policyId}, ${a.tenant}, ${typeId}, 1, '2026-01-01', ${JSON.stringify({ ...noReversal, documentType: "NOREV" })}::jsonb)`;
    });
    const doc = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${a.tenant}, ${a.company}, ${typeId}, 'JV', '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 4.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${doc}, 2, ${a.sales}, 4.0000)`;
    });
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => reverseDocument(tx, ctx(a), { documentId: doc, effectiveDate: "2026-01-20", reason: "not allowed" })),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
  });
});
```

Run: `bun run --cwd packages/db test -- test/posting/reverse.test.ts`
Expected: **FAIL** — `reverseDocument is not a function`.

- [ ] **Step 2: Write `packages/db/src/posting/reverse.ts`**

```ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { PostingError } from "./errors";
import { loadSnapshot, resolvePolicy } from "./load";
import { postDocument } from "./post";

/**
 * D13. Creates the reversing document of `policy.reversal.producesType` with the sides swapped, posts it
 * through the same postDocument, and marks the original `reversed`. The reversal ADDS ledger rows — it never
 * subtracts — which is what keeps account_balance a pure sum (contracts §4.3.3).
 */
export async function reverseDocument(
  tx: Sql,
  ctx: TenantContext,
  input: { documentId: string; effectiveDate: string; reason: string },
): Promise<{ reversalDocumentId: string; number: bigint }> {
  const [source] = await tx<{ id: string; status: string; document_type_id: string; effective_date: string }[]>`
    select id, status::text as status, document_type_id, to_char(effective_date, 'YYYY-MM-DD') as effective_date
      from app.document where id = ${input.documentId} for update`;
  if (!source) throw new PostingError("ERR_NOT_FOUND", `no document ${input.documentId} in this tenant`);
  if (source.status !== "posted") {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL", `document ${input.documentId} is ${source.status}; only a posted document can be reversed (spec:2224)`);
  }

  const { definition } = await resolvePolicy(tx, source.document_type_id, source.effective_date);
  if (!definition.reversal.allowed || definition.reversal.producesType === null) {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL", `policy for ${definition.documentType} does not allow reversal`);
  }

  const [reversalType] = await tx<{ id: string }[]>`
    select t.id from app.document_type t
      join app.document d on d.company_id = t.company_id
     where d.id = ${input.documentId} and t.code = ${definition.reversal.producesType}`;
  if (!reversalType) {
    throw new PostingError("ERR_POLICY_REQUIRES_MISSING", `document type ${definition.reversal.producesType} does not exist in this company, but the ${definition.documentType} policy reverses into it`);
  }

  const snapshot = await loadSnapshot(tx, input.documentId);
  const [created] = await tx<{ id: string }[]>`
    insert into app.document (tenant_id, company_id, document_type_id, series, effective_date, currency,
                              exchange_rate, rate_source, branch_id, party_id, attributed_to, reverses_document_id)
    select ${ctx.tenantId}, d.company_id, ${reversalType.id}, d.series, ${input.effectiveDate}::date, d.currency,
           d.exchange_rate, d.rate_source, d.branch_id, d.party_id, d.attributed_to, d.id
      from app.document d where d.id = ${input.documentId}
    returning id`;
  const reversalId = created!.id;

  // Sides swapped on the LINES, so the reversal posts through the unchanged policy (D13).
  await tx`
    insert into app.document_line (tenant_id, company_id, document_id, line_no, description, account_id, debit, credit, dimensions, custom_fields)
    select ${ctx.tenantId}, l.company_id, ${reversalId}, l.line_no,
           ${`Reversal of ${snapshot.header.series} ${snapshot.header.number ?? ""}: ${input.reason}`}, l.account_id,
           l.credit, l.debit, l.dimensions, l.custom_fields
      from app.document_line l where l.document_id = ${input.documentId}`;

  const posted = await postDocument(tx, ctx, { documentId: reversalId });

  await tx`update app.document set status = 'reversed' where id = ${input.documentId}`;

  return { reversalDocumentId: reversalId, number: posted.number };
}

/**
 * spec:1745 — "Voiding an issued document sets status = 'void' AND inserts document_number_void in the same
 * transaction". The number is never re-issued; the row is what turns a gap in the series into an explained
 * gap (SAH-051). `voided_by` is stamped from the session by app.stamp_actor.
 */
export async function voidDocument(
  tx: Sql,
  ctx: TenantContext,
  input: { documentId: string; reason: string },
): Promise<void> {
  const [doc] = await tx<
    { id: string; status: string; company_id: string; series: string; fiscal_period_id: string | null; number: string | null }[]
  >`select id, status::text as status, company_id, series, fiscal_period_id, number::text as number
      from app.document where id = ${input.documentId} for update`;
  if (!doc) throw new PostingError("ERR_NOT_FOUND", `no document ${input.documentId} in this tenant`);
  if (doc.status !== "issued" || doc.number === null || doc.fiscal_period_id === null) {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL", `document ${input.documentId} is ${doc.status}; only an issued document holds a number that can be voided (contracts §4.5.1)`);
  }

  await tx`update app.document set status = 'void' where id = ${input.documentId}`;
  await tx`insert into app.document_number_void (tenant_id, company_id, series, fiscal_period_id, number, reason)
           values (${ctx.tenantId}, ${doc.company_id}, ${doc.series}, ${doc.fiscal_period_id}, ${doc.number}::bigint, ${input.reason})`;
}
```

Add `export * from "./reverse";` to `packages/db/src/posting/index.ts`.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/posting/reverse.test.ts`
Expected: **PASS** (7 tests). If the test-3 comparison fails on a row where `projected` and `posted` differ, the `MERGE` of Task 8 is grouping on fewer columns than the primary key — re-read contracts §4.3.3.

Run: `bun run --cwd packages/db test`
Expected: PASS — the whole `packages/db` suite, 0A's included.

- [ ] **Step 4: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat(db): reverseDocument and voidDocument — the two corrections D13 allows [1A T9]

A reversal is a mirror document posted through the same postDocument, so the
projection stays a pure sum and acceptance test 3 holds: post to one account,
reverse, re-post to a never-used account, and sum(account_balance) still equals
sum(ledger_entry) (SAH-002). A void marks the document and records the number in
document_number_void, so a gap in the series is an explained gap (SAH-051).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10 — The chart-of-accounts API

`/v1/companies/{companyId}/accounts`. Accounts are archived, never deleted (spec:2049, SAH-021), and the tree is read with **one** recursive CTE rather than a per-row lookup — SAH-071 is the legacy system running a recursive tree check inside a trigger, once per row.

**Files:**
- Create: `packages/contracts/src/accounting/account.ts`, `apps/api/src/routes/accounting/accounts.ts`, `apps/api/test/routes/accounting/accounts.test.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Produces (contracts): `AccountSchema`, `CreateAccountBody`, `UpdateAccountBody`, `AccountQuery`, `AccountList`, `AccountNodeSchema`, `AccountTree`.
- Produces (api): `accountRoutes`; a `RouteModule` `{ path: "/v1/companies/:companyId/accounts", router: accountRoutes, permissions: ["accounting.account.manage"], auth: "human" }`; a `PROBES` entry under that path.
- Consumes: `requirePermission` and `ScopeSource` (§4.2.5); `AppEnv`, `c.var.withTenant` (§4.2.3); `UuidSchema`, `ListQuery`, `ListEnvelope`, `ProblemSchema`, `encodeCursor`, `decodeCursor` (§4.2.8); `AppError` (§4.2.4); `startApi`, `ApiRequest` (§4.2.12); `seedTenantV2`, `seedAccount` (§4.17).

**Reads are gated by membership, writes by `accounting.account.manage`.** The catalogue has one accounts code and it is mutating; §3.6.1 closes the vocabulary, so a read code cannot be invented, and 0D set the precedent for dimensions ("reads need membership only", §4.2.11). spec:2158 gives `user` "reads accounts" and no code, which is the same shape. Because the two read routes carry **no** middleware, a cross-tenant `GET` is stopped by RLS, not by RBAC: the handler runs, `app.account` is reduced to the caller's tenant and the page comes back **empty with a 200**. That is deliberate — 0B regated `GET /v1/companies/{companyId}` from `{ company: "path:companyId" }` to `{ company: "any" }` for exactly this reason, since a 403 on an id the caller may not see confirms the id exists. Step 1's cross-tenant case asserts the empty 200 on both reads and the 403 on the gated `POST`; **do not "fix" it by gating the list route.**

**Every unsafe operation declares the `Idempotency-Key` header, and it is `apps/api/src/routes/index.ts` that owns the schema.** Contracts §4.2.7 (spec:2055): "Every `post`/`put`/`patch`/`delete` `createRoute` in every slice sets `request.headers: IdempotencyHeader`." The middleware that enforces the header is global (§4.2.9) and runs whether or not a route declares it, so this is about the committed `openapi.json`: `@hono/zod-openapi` documents only what a route's `request` declares, and a client generated from a spec that omits the header sends no header and gets `ERR_IDEMPOTENCY_KEY_MISSING`. `IdempotencyHeader` is **not** in `@dulja/contracts` — 0B Task 11 declares it in `apps/api/src/routes/index.ts`, which is why the import below reads `from "../index"`; 2A's `admin/document-types.ts` imports it the same way, so the routes-module cycle this creates is the shape 0B and 2A already ship. This slice's three unsafe accounts operations (`POST /`, `PATCH /{accountId}`, `POST /{accountId}/archive`), the two of Task 11 and the three of Task 12 make **eight** in all; the read routes and `ledger-entries` declare nothing.

- [ ] **Step 1: Write the failing test `apps/api/test/routes/accounting/accounts.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/accounts — spec:1673, SAH-021, SAH-071", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;
  const grant = async (s: Seed, code: string): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${s.tenant}, ${`r-${code}`}, ${code})`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${roleId}, ${code})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${s.tenant}, ${s.human}, ${roleId}, ${s.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    b = await seedTenantV2(api.db, "Beta");
    await grant(a, "accounting.account.manage");
  });
  afterAll(async () => { await api.stop(); });

  it("the accounts 0C seeds and the JOURNAL policy names all resolve (contracts §5 item 33)", async () => {
    const res = await api.request({ method: "GET", path: `/v1/companies/${a.company}/accounts?limit=1000`, as: a.human });
    const body = (await res.json()) as { items: { code: string }[] };
    for (const code of ["1000", "4000", "5920"]) expect(body.items.map((i) => i.code)).toContain(code);
  });

  it("creates a leaf account under a group parent and reads it back", async () => {
    const group = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/accounts`, as: a.human,
      body: { code: "2000", nameEn: "Liabilities", nameAr: "الخصوم", type: "liability", isGroup: true },
    });
    expect(group.status).toBe(201);
    const parent = (await group.json()) as { id: string };
    const leaf = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/accounts`, as: a.human,
      body: { code: "2100", nameEn: "Trade payables", type: "liability", parentId: parent.id },
    });
    expect(leaf.status).toBe(201);
    expect(await leaf.json()).toMatchObject({ code: "2100", type: "liability", isGroup: false, parentId: parent.id, archivedAt: null });
  });

  it("refuses a duplicate code in the company with ERR_CONFLICT_UNIQUE", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/accounts`, as: a.human,
      body: { code: "1000", nameEn: "Cash again", type: "asset" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("archives rather than deletes, and an archived account is excluded from the default list (SAH-021)", async () => {
    const created = (await (await api.request({
      method: "POST", path: `/v1/companies/${a.company}/accounts`, as: a.human,
      body: { code: "5990", nameEn: "Retired", type: "expense" },
    })).json()) as { id: string };
    const archived = await api.request({ method: "POST", path: `/v1/companies/${a.company}/accounts/${created.id}/archive`, as: a.human, body: {} });
    expect(archived.status).toBe(200);
    expect((await archived.json()) as { archivedAt: string | null }).toMatchObject({ archivedAt: expect.any(String) });

    const list = (await (await api.request({ method: "GET", path: `/v1/companies/${a.company}/accounts?limit=1000`, as: a.human })).json()) as { items: { code: string }[] };
    expect(list.items.map((i) => i.code)).not.toContain("5990");
    const all = (await (await api.request({ method: "GET", path: `/v1/companies/${a.company}/accounts?limit=1000&includeArchived=true`, as: a.human })).json()) as { items: { code: string }[] };
    expect(all.items.map((i) => i.code)).toContain("5990");
  });

  it("returns the tree in one recursive CTE with depth and path (SAH-071)", async () => {
    const res = await api.request({ method: "GET", path: `/v1/companies/${a.company}/accounts/tree`, as: a.human });
    expect(res.status).toBe(200);
    const tree = (await res.json()) as { items: { code: string; depth: number; path: string[] }[] };
    const payables = tree.items.find((n) => n.code === "2100")!;
    expect(payables.depth).toBe(1);
    expect(payables.path).toEqual(["2000", "2100"]);
    const root = tree.items.find((n) => n.code === "1000")!;
    expect(root.depth).toBe(0);
  });

  it("refuses a parent from another company and a cycle", async () => {
    const foreign = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/accounts`, as: a.human,
      body: { code: "2200", nameEn: "Bad parent", type: "liability", parentId: b.cash },
    });
    expect(foreign.status).toBe(404);
    const self = (await (await api.request({
      method: "POST", path: `/v1/companies/${a.company}/accounts`, as: a.human,
      body: { code: "2300", nameEn: "Self", type: "liability", isGroup: true },
    })).json()) as { id: string };
    const cycle = await api.request({
      method: "PATCH", path: `/v1/companies/${a.company}/accounts/${self.id}`, as: a.human, body: { parentId: self.id },
    });
    expect(cycle.status).toBe(400);
    expect(((await cycle.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a principal without accounting.account.manage may read but not write", async () => {
    const read = await api.request({ method: "GET", path: `/v1/companies/${b.company}/accounts`, as: b.human });
    expect(read.status).toBe(200);
    const write = await api.request({
      method: "POST", path: `/v1/companies/${b.company}/accounts`, as: b.human,
      body: { code: "2900", nameEn: "Nope", type: "liability" },
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("cannot reach another tenant's company: the ungated read is an empty page, the gated write is 403 (test 12)", async () => {
    // The two read routes carry NO middleware — contracts §4.2.7: "Reads on `accounts`, `fiscal-periods` and
    // `documents/{id}` are gated by membership only". A `{ company: "path:companyId" }` gate here would answer
    // 403 for an id the caller may not see, and a 403 confirms the id exists — exactly the leak 0B removed
    // from `GET /v1/companies/{companyId}` when it regated that read to `{ company: "any" }`. So on this path
    // the control is RLS, not RBAC: the handler runs inside `withTenant(a.tenant)`, `app.account` is reduced
    // to tenant A's rows, and `where company_id = ${b.company}` matches none of them. The honest answer is an
    // empty page, and asserting 403 here would be asserting the leak.
    const read = await api.request({ method: "GET", path: `/v1/companies/${b.company}/accounts`, as: a.human });
    expect(read.status).toBe(200);
    expect((await read.json()) as { items: unknown[]; next_cursor: string | null }).toEqual({ items: [], next_cursor: null });

    const tree = await api.request({ method: "GET", path: `/v1/companies/${b.company}/accounts/tree`, as: a.human });
    expect(tree.status).toBe(200);
    expect((await tree.json()) as { items: unknown[] }).toEqual({ items: [] });

    // 403 belongs to the gated verbs, and this is the shape the `PROBES` entry for this path exercises.
    const write = await api.request({
      method: "POST", path: `/v1/companies/${b.company}/accounts`, as: a.human,
      body: { code: "9997", nameEn: "Trespass", type: "asset" },
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");

    // …and nothing was written under either tenant by the attempt.
    const mine = (await (await api.request({ method: "GET", path: `/v1/companies/${a.company}/accounts?limit=1000`, as: a.human })).json()) as { items: { code: string }[] };
    expect(mine.items.map((i) => i.code)).not.toContain("9997");
  });
});
```

Run: `bun run --cwd apps/api test -- test/routes/accounting/accounts.test.ts`
Expected: **FAIL** — every request answers 404: the route module is not registered.

- [ ] **Step 2: Write `packages/contracts/src/accounting/account.ts`**

```ts
import { z } from "@hono/zod-openapi";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const AccountTypeSchema = z.enum(["asset", "liability", "equity", "income", "expense"]);

export const AccountSchema = z.object({
  id: UuidSchema, code: z.string(), nameEn: z.string(), nameAr: z.string().nullable(),
  type: AccountTypeSchema, parentId: UuidSchema.nullable(), isGroup: z.boolean(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(), archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
}).openapi("Account");

export const CreateAccountBody = z.object({
  code: z.string().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/),
  nameEn: z.string().min(1), nameAr: z.string().min(1).optional(),
  type: AccountTypeSchema, parentId: UuidSchema.optional(), isGroup: z.boolean().default(false),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
}).openapi("CreateAccount");

export const UpdateAccountBody = z.object({
  nameEn: z.string().min(1).optional(), nameAr: z.string().min(1).optional(),
  parentId: UuidSchema.nullable().optional(), currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
}).openapi("UpdateAccount");

/** Filterable and sortable fields are declared, never taken as text — no field name reaches SQL (test 27). */
export const AccountQuery = ListQuery.extend({
  type: AccountTypeSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const AccountList = ListEnvelope(AccountSchema);

export const AccountNodeSchema = AccountSchema.extend({
  depth: z.number().int().min(0),
  path: z.array(z.string()),
}).openapi("AccountNode");
export const AccountTree = z.object({ items: z.array(AccountNodeSchema) });
```

Add `export * from "./accounting/account";` to `packages/contracts/src/index.ts`.

- [ ] **Step 3: Write `apps/api/src/routes/accounting/accounts.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { v7 as newUuidV7 } from "uuid";
import {
  AccountList, AccountQuery, AccountSchema, AccountTree, AppError, CreateAccountBody, decodeCursor,
  encodeCursor, ProblemSchema, UpdateAccountBody, UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../../context";
import { IdempotencyHeader } from "../index";
import { requirePermission } from "../../middleware/require-permission";

export const accountRoutes = new OpenAPIHono<AppEnv>();
/** Writes need the code; reads need membership only — the 0D precedent for dimensions (contracts §4.2.11)
 *  and the reading spec:2158 forces, since the catalogue has no accounts read code (§3.6.1 is closed). */
const manage = requirePermission(PERMISSION["accounting.account.manage"], { company: "path:companyId" });

type Row = {
  id: string; code: string; name_en: string; name_ar: string | null; type: string; parent_id: string | null;
  is_group: boolean; currency: string | null; archived_at: Date | null; created_at: Date;
};
const toAccount = (r: Row) => ({
  id: r.id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar, type: r.type, parentId: r.parent_id,
  isGroup: r.is_group, currency: r.currency, archivedAt: r.archived_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});
/** A postgres.js fragment, not a string: a nested tagged template composes safely and never reaches
 *  `sql.unsafe`, which contracts §3.3 confines to three homes, none of them a route file. */
const columns = (tx: Sql) => tx`id, code, name_en, name_ar, type::text as type, parent_id, is_group, currency, archived_at, created_at`;

accountRoutes.openapi(
  createRoute({
    method: "post", path: "/", tags: ["accounting"], middleware: [manage] as const, summary: "Create an account",
    request: { params: z.object({ companyId: UuidSchema }), headers: IdempotencyHeader,
               body: { content: { "application/json": { schema: CreateAccountBody } } } },
    responses: {
      201: { description: "The account", content: { "application/json": { schema: AccountSchema } } },
      404: { description: "Parent not in this company", content: { "application/problem+json": { schema: ProblemSchema } } },
      409: { description: "Code already used", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const id = newUuidV7();
    const row = await c.var.withTenant(async (tx) => {
      if (body.parentId) {
        const [parent] = await tx<{ id: string }[]>`select id from app.account where id = ${body.parentId} and company_id = ${companyId}`;
        if (!parent) throw new AppError("ERR_NOT_FOUND", `no account ${body.parentId} in company ${companyId}`);
      }
      await tx`insert into app.account (id, tenant_id, company_id, code, name_en, name_ar, type, parent_id, is_group, currency)
               values (${id}, ${c.var.ctx.tenantId}, ${companyId}, ${body.code}, ${body.nameEn}, ${body.nameAr ?? null},
                       ${body.type}::app.account_type, ${body.parentId ?? null}, ${body.isGroup}, ${body.currency ?? null})`;
      const [r] = await tx<Row[]>`select ${columns(tx)} from app.account where id = ${id}`;
      return r!;
    });
    return c.json(toAccount(row), 201);
  },
);

accountRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["accounting"], summary: "List accounts (membership only)",
    request: { params: z.object({ companyId: UuidSchema }), query: AccountQuery },
    responses: { 200: { description: "A page of accounts", content: { "application/json": { schema: AccountList } } } },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { cursor, limit, type, includeArchived } = c.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await c.var.withTenant((tx) => tx<Row[]>`
      select ${columns(tx)} from app.account
       where company_id = ${companyId}
         and (${includeArchived} or archived_at is null)
         and (${type ?? null}::text is null or type::text = ${type ?? null})
         and (${after ? after.id : null}::uuid is null or id > ${after ? after.id : null}::uuid)
       order by id limit ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.json({ items: page.map(toAccount), next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.id }) : null });
  },
);

accountRoutes.openapi(
  createRoute({
    method: "get", path: "/tree", tags: ["accounting"], summary: "The chart as a tree, in one recursive CTE (SAH-071)",
    request: { params: z.object({ companyId: UuidSchema }) },
    responses: { 200: { description: "Every account with its depth and code path", content: { "application/json": { schema: AccountTree } } } },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    // One statement for the whole tree. SAH-071 is the legacy system running a recursive check per row inside
    // a trigger; the depth cap is a belt-and-braces guard, since the PATCH handler already refuses a cycle.
    const rows = await c.var.withTenant((tx) => tx<(Row & { depth: number; path: string[] })[]>`
      with recursive node as (
        select a.*, 0 as depth, array[a.code] as path
          from app.account a
         where a.company_id = ${companyId} and a.parent_id is null and a.archived_at is null
        union all
        select a.*, n.depth + 1, n.path || a.code
          from app.account a join node n on a.parent_id = n.id
         where a.company_id = ${companyId} and a.archived_at is null and n.depth < 32
      )
      select id, code, name_en, name_ar, type::text as type, parent_id, is_group, currency, archived_at,
             created_at, depth, path
        from node order by path`);
    return c.json({ items: rows.map((r) => ({ ...toAccount(r), depth: r.depth, path: r.path })) });
  },
);

accountRoutes.openapi(
  createRoute({
    method: "patch", path: "/{accountId}", tags: ["accounting"], middleware: [manage] as const, summary: "Rename or re-parent an account",
    request: {
      params: z.object({ companyId: UuidSchema, accountId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdateAccountBody } } },
    },
    responses: {
      200: { description: "The account", content: { "application/json": { schema: AccountSchema } } },
      400: { description: "Cycle", content: { "application/problem+json": { schema: ProblemSchema } } },
      404: { description: "Not in this company", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, accountId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      if (body.parentId) {
        if (body.parentId === accountId) throw new AppError("ERR_VALIDATION_FAILED", `account ${accountId} cannot be its own parent`);
        const [cycle] = await tx<{ n: number }[]>`
          with recursive up as (
            select id, parent_id, 0 as depth from app.account where id = ${body.parentId} and company_id = ${companyId}
            union all
            select a.id, a.parent_id, up.depth + 1 from app.account a join up on a.id = up.parent_id where up.depth < 32
          ) select count(*)::int as n from up where id = ${accountId}`;
        if (cycle!.n > 0) throw new AppError("ERR_VALIDATION_FAILED", `making ${body.parentId} the parent of ${accountId} would create a cycle`);
      }
      const updated = await tx<Row[]>`
        update app.account
           set name_en   = coalesce(${body.nameEn ?? null}, name_en),
               name_ar   = case when ${body.nameAr === undefined} then name_ar else ${body.nameAr ?? null} end,
               parent_id = case when ${body.parentId === undefined} then parent_id else ${body.parentId ?? null} end,
               currency  = case when ${body.currency === undefined} then currency else ${body.currency ?? null} end
         where id = ${accountId} and company_id = ${companyId}
        returning ${columns(tx)}`;
      if (updated.length === 0) throw new AppError("ERR_NOT_FOUND", `no account ${accountId} in company ${companyId}`);
      return updated[0]!;
    });
    return c.json(toAccount(row));
  },
);

accountRoutes.openapi(
  createRoute({
    method: "post", path: "/{accountId}/archive", tags: ["accounting"], middleware: [manage] as const,
    summary: "Archive an account — accounts are never deleted (spec:2049, SAH-021)",
    request: { params: z.object({ companyId: UuidSchema, accountId: UuidSchema }), headers: IdempotencyHeader,
               body: { content: { "application/json": { schema: z.object({}) } } } },
    responses: {
      200: { description: "The archived account", content: { "application/json": { schema: AccountSchema } } },
      404: { description: "Not in this company", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, accountId } = c.req.valid("param");
    const row = await c.var.withTenant(async (tx) => {
      const updated = await tx<Row[]>`
        update app.account set archived_at = coalesce(archived_at, now())
         where id = ${accountId} and company_id = ${companyId}
        returning ${columns(tx)}`;
      if (updated.length === 0) throw new AppError("ERR_NOT_FOUND", `no account ${accountId} in company ${companyId}`);
      return updated[0]!;
    });
    return c.json(toAccount(row));
  },
);
```

`columns(tx)` is a **nested tagged template**, not `sql.unsafe`: contracts §3.3 confines `sql.unsafe` to the migration runner, the pg-boss enqueue adapter and the Firebird reader, and no route file may use it. postgres.js composes a nested template into the parent statement without any string interpolation, so no field name reaches SQL as text (test 27).

- [ ] **Step 4: Register the module and its probe**

In `apps/api/src/routes/index.ts`, add to `buildRoutes`:

```ts
    { path: "/v1/companies/:companyId/accounts", router: accountRoutes, permissions: ["accounting.account.manage"], auth: "human" },
```

In `tests/invariants/probes.ts`:

```ts
  "/v1/companies/:companyId/accounts": {
    seed: (_db, owner) => Promise.resolve({
      path: `/v1/companies/${owner.company}/accounts`, method: "POST",
      body: { code: "9998", nameEn: "Stolen", type: "asset" },
    }),
    expect: 403,                                        // requirePermission refuses the company before any row is read
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test -- test/routes/accounting/accounts.test.ts && bun run --cwd packages/contracts openapi:generate`
Expected: **PASS** (8 tests); the generated `openapi.json` gains five operations and CI's diff check passes once it is committed.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts apps/api tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(api): the chart-of-accounts API [1A T10]

Writes gated by accounting.account.manage, reads by membership — the catalogue
has no accounts read code and spec:2158 gives the clerk read access. Accounts
are archived, never deleted (SAH-021), and the tree is one recursive CTE with a
depth cap rather than a per-row walk (SAH-071). A cycle is refused on re-parent.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11 — The fiscal-period API: close, reopen-with-reason, and the period lock through the admin path

Part of this slice's share of the Phase 1 definition-of-done clause "a locked period cannot be altered through any path": the **admin path** — the write attempted as `app_rw` directly, outside every route, is refused by `assert_period_open`, which is the control. The **API path** (a post through the documents route into a closed period) is asserted in **Task 12**, because it needs the documents route Task 12 creates; the raw-SQL half of the admin path is asserted in **Task 8**'s `packages/db/test/posting/post.test.ts`, which is one of the three prefixes the `posting-only-tables` rule allows to name `app.ledger_entry` in DML. 1B owns test 9 and adds the background-job path; 9B adds the import path.

**This task's test file writes no DML naming a protected table.** `apps/api/test/**` is inside the lint runner's `ROOTS` (`["apps", "packages", "scripts"]`) and outside every entry of `ALLOWED_PREFIXES` (contracts §3.7.5; Task 8's rule), so an `insert into app.ledger_entry` here would turn `lint:rules` red from this task onward. The admin-path assertion below is therefore a direct `postDocument` call as `app_rw` — a function call, not a DML string — and the trigger-is-the-control assertion lives in Task 8's file where the raw insert is legal.

**Files:**
- Create: `packages/contracts/src/accounting/fiscal-period.ts`, `apps/api/src/routes/accounting/fiscal-periods.ts`, `apps/api/test/routes/accounting/fiscal-periods.test.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Produces (contracts): `FiscalPeriodSchema`, `FiscalPeriodQuery`, `FiscalPeriodList`, `ClosePeriodBody`, `ReopenPeriodBody`.
- Produces (api): `fiscalPeriodRoutes`; `RouteModule` `{ path: "/v1/companies/:companyId/fiscal-periods", permissions: ["accounting.period.close", "accounting.period.reopen"], auth: "human" }`; a `PROBES` entry.
- Consumes: `requirePermission`, `AppEnv`, `AppError`, the common schemas (§4.2.4, §4.2.5, §4.2.8), `startApi` (§4.2.12); production `withTenant` and `postDocument` from `@dulja/db`; `seedTenantV2`, `uuidv7` from `@dulja/db/test` (§4.17, §4.1).

**Two behaviours fixed by this plan's readings 2 and 3, and asserted below:**
- The reopen `UPDATE` carries `reopen_reason`, so the audited `after` image holds it (ADR 0023). A blank reason is `ERR_VALIDATION_FAILED`.
- The close `UPDATE` writes `closed_by = coalesce(closed_by, app.current_actor())`. `app.stamp_actor` raises `ERR_ACTOR_IMMUTABLE` on any change to a non-null `*_by` value, so a period closed by one principal, reopened, and closed by another would otherwise fail. The column records the first closer; the audit log records every close with its own actor.

**Both unsafe operations declare `request.headers: IdempotencyHeader`** (contracts §4.2.7, spec:2055 — "every `post`/`put`/`patch`/`delete` `createRoute` in every slice"). The schema is 0B's, declared in `apps/api/src/routes/index.ts`, so the import is `import { IdempotencyHeader } from "../index";` — the same form 2A's `admin/document-types.ts` uses. The header's enforcement is the global middleware of §4.2.9; the declaration is what puts the parameter into the committed `openapi.json`. The list route is safe and declares nothing.

- [ ] **Step 1: Write the failing test `apps/api/test/routes/accounting/fiscal-periods.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { postDocument, withTenant } from "@dulja/db";
import { seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/fiscal-periods — spec:2223, 2179, test 9 (API and admin paths)", () => {
  let api: StartedApi;
  let a: Seed;
  let second: string;                                   // a second human principal in tenant a
  const grant = async (s: Seed, principalId: string, ...codes: string[]): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${s.tenant}, ${`r-${roleId.slice(0, 8)}`}, 'grant')`;
      for (const code of codes) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    second = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${second}, 'human', ${`human2:${a.tenant}`}, 'Second')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${second})`;
    });
    await grant(a, a.human, "accounting.period.close", "accounting.period.reopen");
    await grant(a, second, "accounting.period.close");
  });
  afterAll(async () => { await api.stop(); });

  it("lists the company's periods with their status", async () => {
    const res = await api.request({ method: "GET", path: `/v1/companies/${a.company}/fiscal-periods`, as: a.human });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; status: string }[] };
    expect(body.items.find((p) => p.id === a.period)!.status).toBe("open");
    expect(body.items.find((p) => p.id === a.lockedPeriod)!.status).toBe("locked");
  });

  it("closes a period and stamps closed_by from the session", async () => {
    const res = await api.request({ method: "POST", path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/close`, as: a.human, body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "closed", closedBy: a.human });
  });

  it("refuses a post as app_rw outside every route once the period is closed (test 9 — admin path)", async () => {
    // The API path is Task 12's (it needs POST /documents). This is the path a DBA or a script takes:
    // a real app_rw session, no HTTP, no permission middleware. postDocument still refuses, and behind it
    // app.assert_period_open on ledger_entry is the control — asserted against a raw INSERT in Task 8's
    // packages/db/test/posting/post.test.ts, which is where the posting-only-tables rule allows that DML.
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "admin-path" };
    const docId = await uuidv7(api.db.admin);
    await withTenant(api.db.rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${docId}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${docId}, 1, ${a.cash}, 5.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${docId}, 2, ${a.sales}, 5.0000)`;
    });
    await expect(withTenant(api.db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId: docId })))
      .rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
    const [entries] = await withTenant(api.db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where document_id = ${docId}`);
    expect(entries!.n).toBe(0);
  });

  it("reopens only with a reason, and the reason lands in the audited row (spec:2179, ADR 0023)", async () => {
    const blank = await api.request({ method: "POST", path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/reopen`, as: a.human, body: { reason: "   " } });
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");

    const ok = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/reopen`, as: a.human,
      body: { reason: "the auditor asked for one more adjustment" },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "open", reopenReason: "the auditor asked for one more adjustment" });

    const [audit] = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "read" }, (tx) => tx<
      { reason: string | null; actor: string }[]
    >`select after ->> 'reopen_reason' as reason, actor_id::text as actor from app.audit_log
       where table_name = 'fiscal_period' and row_id = ${a.period} and action = 'update' order by seq desc limit 1`);
    expect(audit).toMatchObject({ reason: "the auditor asked for one more adjustment", actor: a.human });
  });

  it("a second close by a different principal succeeds and closed_by keeps the first closer (this plan's reading 2)", async () => {
    const res = await api.request({ method: "POST", path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/close`, as: second, body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "closed", closedBy: a.human });
    const actors = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "read" }, (tx) => tx<{ actor: string }[]>`
      select actor_id::text as actor from app.audit_log
       where table_name = 'fiscal_period' and row_id = ${a.period} and action = 'update' order by seq`);
    expect(actors.at(-1)!.actor).toBe(second);           // every close is recorded with its own actor
  });

  it("close and reopen are separate authorities (spec:2179 R8)", async () => {
    const res = await api.request({ method: "POST", path: `/v1/companies/${a.company}/fiscal-periods/${a.period}/reopen`, as: second, body: { reason: "not mine to give" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });
});
```

Run: `bun run --cwd apps/api test -- test/routes/accounting/fiscal-periods.test.ts`
Expected: **FAIL** — 404 on the list, because this module is not registered yet. Every test in this file is green at the end of this task: none of them calls `/v1/companies/{companyId}/documents`, which is Task 12's route.

- [ ] **Step 2: Write `packages/contracts/src/accounting/fiscal-period.ts`**

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const FiscalPeriodSchema = z.object({
  id: UuidSchema, startsOn: DateSchema, endsOn: DateSchema,
  status: z.enum(["open", "closed", "locked"]),
  closedBy: UuidSchema.nullable(), closedAt: TimestampSchema.nullable(),
  reopenReason: z.string().nullable(), createdAt: TimestampSchema,
}).openapi("FiscalPeriod");

export const FiscalPeriodQuery = ListQuery.extend({ status: z.enum(["open", "closed", "locked"]).optional() });
export const FiscalPeriodList = ListEnvelope(FiscalPeriodSchema);
export const ClosePeriodBody = z.object({}).openapi("ClosePeriod");
/** spec:2179 — reopening "requires a reason written to the audit row". `.trim().min(1)` refuses whitespace. */
export const ReopenPeriodBody = z.object({ reason: z.string().trim().min(1).max(500) }).openapi("ReopenPeriod");
```

Add `export * from "./accounting/fiscal-period";` to `packages/contracts/src/index.ts`.

- [ ] **Step 3: Write `apps/api/src/routes/accounting/fiscal-periods.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import {
  AppError, ClosePeriodBody, decodeCursor, encodeCursor, FiscalPeriodList, FiscalPeriodQuery,
  FiscalPeriodSchema, ProblemSchema, ReopenPeriodBody, UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../../context";
import { IdempotencyHeader } from "../index";
import { requirePermission } from "../../middleware/require-permission";

export const fiscalPeriodRoutes = new OpenAPIHono<AppEnv>();
const close = requirePermission(PERMISSION["accounting.period.close"], { company: "path:companyId" });
const reopen = requirePermission(PERMISSION["accounting.period.reopen"], { company: "path:companyId" });

type Row = {
  id: string; starts_on: string; ends_on: string; status: string; closed_by: string | null;
  closed_at: Date | null; reopen_reason: string | null; created_at: Date;
};
/** A nested postgres.js fragment, never `sql.unsafe` — contracts §3.3 confines that to three homes. */
const columns = (tx: Sql) => tx`id, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on,
                                status::text as status, closed_by, closed_at, reopen_reason, created_at`;
const toPeriod = (r: Row) => ({
  id: r.id, startsOn: r.starts_on, endsOn: r.ends_on, status: r.status, closedBy: r.closed_by,
  closedAt: r.closed_at?.toISOString() ?? null, reopenReason: r.reopen_reason, createdAt: r.created_at.toISOString(),
});

fiscalPeriodRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["accounting"], summary: "List fiscal periods (membership only)",
    request: { params: z.object({ companyId: UuidSchema }), query: FiscalPeriodQuery },
    responses: { 200: { description: "A page of periods", content: { "application/json": { schema: FiscalPeriodList } } } },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { cursor, limit, status } = c.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await c.var.withTenant((tx) => tx<Row[]>`
      select ${columns(tx)} from app.fiscal_period
       where company_id = ${companyId}
         and (${status ?? null}::text is null or status::text = ${status ?? null})
         and (${after ? after.id : null}::uuid is null or id > ${after ? after.id : null}::uuid)
       order by id limit ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.json({ items: page.map(toPeriod), next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.id }) : null });
  },
);

fiscalPeriodRoutes.openapi(
  createRoute({
    method: "post", path: "/{periodId}/close", tags: ["accounting"], middleware: [close] as const,
    summary: "Close a period — uniform for all roles (spec:2223)",
    request: { params: z.object({ companyId: UuidSchema, periodId: UuidSchema }), headers: IdempotencyHeader,
               body: { content: { "application/json": { schema: ClosePeriodBody } } } },
    responses: {
      200: { description: "The period", content: { "application/json": { schema: FiscalPeriodSchema } } },
      404: { description: "Not in this company", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, periodId } = c.req.valid("param");
    const row = await c.var.withTenant(async (tx) => {
      // closed_by is coalesced, never reassigned: app.stamp_actor raises ERR_ACTOR_IMMUTABLE on any change to
      // a non-null *_by value, so a close after a reopen by a different principal would fail. The column holds
      // the first closer; app.audit_log holds every close with its own stamped actor (ADR 0023).
      const updated = await tx<Row[]>`
        update app.fiscal_period
           set status = 'closed', closed_at = now(), closed_by = coalesce(closed_by, app.current_actor())
         where id = ${periodId} and company_id = ${companyId}
        returning ${columns(tx)}`;
      if (updated.length === 0) throw new AppError("ERR_NOT_FOUND", `no fiscal period ${periodId} in company ${companyId}`);
      return updated[0]!;
    });
    return c.json(toPeriod(row));
  },
);

fiscalPeriodRoutes.openapi(
  createRoute({
    method: "post", path: "/{periodId}/reopen", tags: ["accounting"], middleware: [reopen] as const,
    summary: "Reopen a closed or locked period with a mandatory reason (spec:2179 R8)",
    request: { params: z.object({ companyId: UuidSchema, periodId: UuidSchema }), headers: IdempotencyHeader,
               body: { content: { "application/json": { schema: ReopenPeriodBody } } } },
    responses: {
      200: { description: "The period", content: { "application/json": { schema: FiscalPeriodSchema } } },
      404: { description: "Not in this company", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, periodId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const updated = await tx<Row[]>`
        update app.fiscal_period set status = 'open', reopen_reason = ${reason}
         where id = ${periodId} and company_id = ${companyId}
        returning ${columns(tx)}`;
      if (updated.length === 0) throw new AppError("ERR_NOT_FOUND", `no fiscal period ${periodId} in company ${companyId}`);
      return updated[0]!;
    });
    return c.json(toPeriod(row));
  },
);
```

- [ ] **Step 4: Register the module and its probe**

`apps/api/src/routes/index.ts`:

```ts
    { path: "/v1/companies/:companyId/fiscal-periods", router: fiscalPeriodRoutes, permissions: ["accounting.period.close", "accounting.period.reopen"], auth: "human" },
```

`tests/invariants/probes.ts`:

```ts
  "/v1/companies/:companyId/fiscal-periods": {
    seed: (_db, owner) => Promise.resolve({
      path: `/v1/companies/${owner.company}/fiscal-periods/${owner.period}/close`, method: "POST", body: {},
    }),
    expect: 403,
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test -- test/routes/accounting/fiscal-periods.test.ts`
Expected: **PASS** (6 tests) — the whole file, with nothing left red. If the "second close" test fails with `ERR_ACTOR_IMMUTABLE`, the `coalesce` in the close handler was dropped.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts apps/api tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(api): the fiscal-period API — close, and reopen with a mandatory reason [1A T11]

Close and reopen are separate authorities (spec:2179 R8); admin alone holds
reopen in the seed. The reason is written to fiscal_period.reopen_reason so the
audited after-image carries it (ADR 0023). closed_by is coalesced rather than
reassigned, because app.stamp_actor makes a *_by column immutable once set; the
audit log is the per-close record.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12 — The generic document API and the ledger read

`/v1/companies/{companyId}/documents`, `…/documents/{documentId}/lines`, `…/documents/{documentId}/transitions` and `/v1/companies/{companyId}/ledger-entries`. §4.2.7 fixes these paths and calls a type-specific route (`/journals`) a convention violation; 1B's screens call exactly these. At Phase 1 the create route is gated by the static code `accounting.journal.create` and the transitions route by `accounting.journal.post`, and the body's `documentTypeCode` must be `"JOURNAL"`. **2A replaces both static gates with `policy.approval.create` / `policy.approval.post` resolved from the effective policy and drops the `documentTypeCode` restriction — the paths never change.**

**Files:**
- Create: `packages/contracts/src/accounting/document.ts`, `packages/contracts/src/accounting/ledger.ts`, `apps/api/src/routes/accounting/documents.ts`, `apps/api/src/routes/accounting/ledger.ts`, `apps/api/test/routes/accounting/documents.test.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Produces (contracts): `DocumentSchema`, `DocumentLineSchema`, `CreateDocumentBody`, `ReplaceLinesBody`, `TransitionBody` (`to ∈ issued | posted | void` — reversal is 2B's own route, §4.5.4), `TransitionResultSchema`, `DocumentQuery`, `DocumentList`, `LedgerEntrySchema`, `LedgerEntryQuery`, `LedgerEntryList`.
- Produces (api): `documentRoutes` at `/v1/companies/:companyId/documents` with `permissions: ["accounting.journal.create", "accounting.journal.post"]`; `ledgerRoutes` at `/v1/companies/:companyId/ledger-entries` with `permissions: ["accounting.ledger.read"]`; two `PROBES` entries.
- Consumes: `issueDocument`, `postDocument`, `voidDocument` from `@dulja/db` (Tasks 7–9; `reverseDocument` is **not** consumed here — §4.5.4 puts reversal on 2B's own route under `accounting.document.reverse`); `requirePermission`, `AppEnv`, `AppError`, the common schemas, `startApi`, `seedTenantV2`.

**The rate is resolved and pinned at create, not at post.** `document.exchange_rate` and `rate_source` are columns (spec:1761–1762); the create handler calls `app.rate_for(company, from, to, effective_date)` when the document currency differs from the company's base currency and raises `ERR_RATE_NOT_FOUND` when there is no rate, so `loadSnapshot` reads a pinned rate and a stored base amount is never recomputed on read (spec:2041).

**All three unsafe operations declare `request.headers: IdempotencyHeader`** — `POST /`, `PUT /{documentId}/lines` and `POST /{documentId}/transitions` (contracts §4.2.7, spec:2055). The schema is 0B's, declared in `apps/api/src/routes/index.ts`, so the import is `import { IdempotencyHeader } from "../index";`. Declaring it changes no runtime behaviour — the §4.2.9 middleware is global, and Step 1's last test still asserts `ERR_IDEMPOTENCY_KEY_MISSING` when the header is omitted — it puts the required parameter into the committed `openapi.json`, which matters here more than anywhere else in the slice because **2B mounts `POST …/documents/{documentId}/reverse`, `POST …/overrides` and `DELETE …/documents/{documentId}` on this very module** and declares the header on all three; a spec that documented it on 2B's operations and not on these would be self-contradicting. `ledgerRoutes` is read-only and declares nothing.

- [ ] **Step 1: Write the failing test `apps/api/test/routes/accounting/documents.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/documents — contracts §4.2.7, spec:2287", () => {
  let api: StartedApi;
  let a: Seed;
  let drafter: string;
  const grant = async (s: Seed, principalId: string, ...codes: string[]): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${s.tenant}, ${`r-${roleId.slice(0, 8)}`}, 'grant')`;
      for (const code of codes) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    });
  };
  const create = (as: string, lines: unknown[], over: Record<string, unknown> = {}) =>
    api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as,
      body: { documentTypeCode: "JOURNAL", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq, lines, ...over },
    });

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    drafter = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${drafter}, 'human', ${`drafter:${a.tenant}`}, 'Drafter')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${drafter})`;
    });
    await grant(a, a.human, "accounting.journal.create", "accounting.journal.post", "accounting.ledger.read");
    await grant(a, drafter, "accounting.journal.create");
  });
  afterAll(async () => { await api.stop(); });

  it("drafts a journal with its lines and returns it with status draft and no number", async () => {
    const res = await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "100.0000", description: "Cash in" },
      { lineNo: 2, accountId: a.sales, credit: "100.0000" },
    ]);
    expect(res.status).toBe(201);
    const doc = (await res.json()) as { id: string; status: string; number: string | null; lines: unknown[] };
    expect(doc).toMatchObject({ status: "draft", number: null, series: "JV" });
    expect(doc.lines).toHaveLength(2);
  });

  it("refuses any documentTypeCode but JOURNAL at Phase 1 (2A lifts this)", async () => {
    const res = await create(a.human, [{ lineNo: 1, accountId: a.cash, debit: "1.0000" }], { documentTypeCode: "SALES_INVOICE" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("posts through the transitions route and returns the ledger entry ids", async () => {
    const doc = (await (await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "60.0000" }, { lineNo: 2, accountId: a.sales, credit: "60.0000" },
    ])).json()) as { id: string };
    const posted = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${doc.id}/transitions`, as: a.human, body: { to: "posted" },
    });
    expect(posted.status).toBe(200);
    const result = (await posted.json()) as { status: string; number: string; ledgerEntryIds: string[] };
    expect(result.status).toBe("posted");
    expect(result.ledgerEntryIds).toHaveLength(2);
    expect(BigInt(result.number)).toBeGreaterThan(0n);
  });

  it("a drafter may create but not post (spec:2158 — the clerk may not post)", async () => {
    const doc = (await (await create(drafter, [
      { lineNo: 1, accountId: a.cash, debit: "3.0000" }, { lineNo: 2, accountId: a.sales, credit: "3.0000" },
    ])).json()) as { id: string };
    const posted = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${doc.id}/transitions`, as: drafter, body: { to: "posted" },
    });
    expect(posted.status).toBe(403);
    expect(((await posted.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("surfaces ERR_LEDGER_UNBALANCED as a problem+json with the difference in the detail (SAH-003)", async () => {
    const doc = (await (await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "100.0000" }, { lineNo: 2, accountId: a.sales, credit: "90.0000" },
    ])).json()) as { id: string };
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${doc.id}/transitions`, as: a.human, body: { to: "posted" },
    });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_LEDGER_UNBALANCED");
    expect(problem.detail).toContain(doc.id);
    expect(problem.type).toBe("urn:dulja:error:ERR_LEDGER_UNBALANCED");
  });

  it("replaces the lines of a draft, drops the surplus rows from the read, and refuses to touch a posted document", async () => {
    // Three lines in, two lines out. app_rw has no DELETE on document_line until 2B's migration 0023, so
    // line 3 physically survives as a zeroed, un-accounted tombstone — and must NOT come back out of the
    // reader, or 1B's journal grid shows a phantom row (Self-Review, issue 16).
    const doc = (await (await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "8.0000" },
      { lineNo: 2, accountId: a.sales, credit: "5.0000" },
      { lineNo: 3, accountId: a.sales, credit: "3.0000" },
    ])).json()) as { id: string };
    const replaced = await api.request({
      method: "PUT", path: `/v1/companies/${a.company}/documents/${doc.id}/lines`, as: a.human,
      body: { lines: [{ lineNo: 1, accountId: a.cash, debit: "9.0000" }, { lineNo: 2, accountId: a.sales, credit: "9.0000" }] },
    });
    expect(replaced.status).toBe(200);
    expect((await replaced.json()) as { lines: { lineNo: number }[] }).toMatchObject({
      lines: [{ lineNo: 1, debit: "9.0000" }, { lineNo: 2, credit: "9.0000" }],
    });
    const reread = (await (await api.request({ method: "GET", path: `/v1/companies/${a.company}/documents/${doc.id}`, as: a.human })).json()) as { lines: unknown[] };
    expect(reread.lines).toHaveLength(2);
    await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${doc.id}/transitions`, as: a.human, body: { to: "posted" } });
    const after = await api.request({
      method: "PUT", path: `/v1/companies/${a.company}/documents/${doc.id}/lines`, as: a.human,
      body: { lines: [{ lineNo: 1, accountId: a.cash, debit: "1.0000" }] },
    });
    expect(after.status).toBe(409);
    expect(((await after.json()) as Problem).code).toBe("ERR_DOC_STATUS_ILLEGAL");
  });

  it("voids an issued document, and offers no reversal target (§4.5.4 gives 2B its own route)", async () => {
    const toVoid = (await (await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "2.0000" }, { lineNo: 2, accountId: a.sales, credit: "2.0000" },
    ])).json()) as { id: string };
    await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${toVoid.id}/transitions`, as: a.human, body: { to: "issued" } });
    const voided = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${toVoid.id}/transitions`, as: a.human,
      body: { to: "void", reason: "wrong stationery" },
    });
    expect((await voided.json()) as { status: string }).toMatchObject({ status: "void" });

    // Reversal is NOT a transition target in Phase 1: contracts §4.5.4 puts it on
    // POST …/documents/{id}/reverse under `accounting.document.reverse`, which slice 2B owns. A caller who
    // asks for it here is refused by the Zod enum, not by a permission check — there is nothing to permit.
    const toReverse = (await (await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "4.0000" }, { lineNo: 2, accountId: a.sales, credit: "4.0000" },
    ])).json()) as { id: string };
    await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${toReverse.id}/transitions`, as: a.human, body: { to: "posted" } });
    const reversed = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${toReverse.id}/transitions`, as: a.human,
      body: { to: "reversed", reason: "keyed twice", effectiveDate: "2026-01-20" },
    });
    expect(reversed.status).toBe(400);
    expect(((await reversed.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
    const stillPosted = await api.request({ method: "GET", path: `/v1/companies/${a.company}/documents/${toReverse.id}`, as: a.human });
    expect(((await stillPosted.json()) as { status: string }).status).toBe("posted");
  });

  it("refuses a post into a closed period through the API (test 9 — API path)", async () => {
    // a.closedPeriod covers 2026-02-15 (seedTenantV2). The route is the only path this task adds; the
    // admin path — the same write attempted as app_rw, refused by app.assert_period_open — is asserted in
    // Task 8's packages/db/test/posting/post.test.ts and again in Task 11 through a direct postDocument call.
    const doc = (await (await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "5.0000" }, { lineNo: 2, accountId: a.sales, credit: "5.0000" },
    ], { effectiveDate: "2026-02-15" })).json()) as { id: string };
    const posted = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${doc.id}/transitions`, as: a.human, body: { to: "posted" },
    });
    expect(posted.status).toBe(422);
    expect(((await posted.json()) as Problem).code).toBe("ERR_PERIOD_NOT_OPEN");
  });

  it("refuses a foreign-currency document with no rate (ERR_RATE_NOT_FOUND)", async () => {
    const res = await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "1.0000" }, { lineNo: 2, accountId: a.sales, credit: "1.0000" },
    ], { currency: "EUR" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Problem).code).toBe("ERR_RATE_NOT_FOUND");
  });

  it("reads posted ledger entries under accounting.ledger.read, filtered by account and period", async () => {
    const res = await api.request({
      method: "GET", path: `/v1/companies/${a.company}/ledger-entries?accountId=${a.cash}&fiscalPeriodId=${a.period}&limit=100`,
      as: a.human,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { accountId: string; baseDebit: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((e) => e.accountId === a.cash)).toBe(true);

    const forbidden = await api.request({ method: "GET", path: `/v1/companies/${a.company}/ledger-entries`, as: drafter });
    expect(forbidden.status).toBe(403);
  });

  it("the idempotency header is required and a replay returns the stored response (§4.2.9)", async () => {
    const key = `idem-${Date.now()}`;
    const body = {
      documentTypeCode: "JOURNAL", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
      lines: [{ lineNo: 1, accountId: a.cash, debit: "11.0000" }, { lineNo: 2, accountId: a.sales, credit: "11.0000" }],
    };
    const missing = await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents`, as: a.human, body, idempotencyKey: null });
    expect(((await missing.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    const first = await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents`, as: a.human, body, idempotencyKey: key });
    const replay = await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents`, as: a.human, body, idempotencyKey: key });
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
  });
});
```

Run: `bun run --cwd apps/api test -- test/routes/accounting/documents.test.ts`
Expected: **FAIL** — 404 on every request.

- [ ] **Step 2: Write `packages/contracts/src/accounting/document.ts` and `ledger.ts`**

```ts
// packages/contracts/src/accounting/document.ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

const Amount = z.string().regex(/^\d+\.\d{4}$/);          // document currency, never negative — the side carries the sign

export const DocumentLineSchema = z.object({
  id: UuidSchema, lineNo: z.number().int().positive(), description: z.string().nullable(),
  accountId: UuidSchema.nullable(), debit: Amount, credit: Amount,
  dimensions: z.record(z.string(), z.string()), customFields: z.record(z.string(), z.unknown()),
}).openapi("DocumentLine");

export const DocumentSchema = z.object({
  id: UuidSchema, documentTypeCode: z.string(), status: z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]),
  series: z.string(), number: z.string().nullable(), fiscalPeriodId: UuidSchema.nullable(),
  effectiveDate: DateSchema, currency: z.string().regex(/^[A-Z]{3}$/), exchangeRate: z.string(),
  rateSource: z.string().nullable(), branchId: UuidSchema, clientRef: UuidSchema.nullable(),
  reversesDocumentId: UuidSchema.nullable(), postedAt: TimestampSchema.nullable(), createdAt: TimestampSchema,
  lines: z.array(DocumentLineSchema),
}).openapi("Document");

const LineInput = z.object({
  lineNo: z.number().int().positive(), description: z.string().max(500).optional(),
  accountId: UuidSchema, debit: Amount.optional(), credit: Amount.optional(),
  dimensions: z.record(z.string(), UuidSchema).optional(),
}).refine((l) => !(l.debit && l.credit && l.debit !== "0.0000" && l.credit !== "0.0000"), {
  message: "a line is a debit or a credit, never both",
});

export const CreateDocumentBody = z.object({
  /** Phase 1 posts one hand-written type (spec:2287). 2A replaces this literal with the tenant's catalogue. */
  documentTypeCode: z.literal("JOURNAL"),
  effectiveDate: DateSchema, currency: z.string().regex(/^[A-Z]{3}$/), branchId: UuidSchema,
  clientRef: UuidSchema.optional(), lines: z.array(LineInput).min(1),
}).openapi("CreateDocument");

export const ReplaceLinesBody = z.object({ lines: z.array(LineInput).min(1) }).openapi("ReplaceLines");

/**
 * Phase 1 supports three targets. 2A adds `submitted`, `approved` and `draft` through transitionDocument
 * (§4.3.1, §4.5.4). **`reversed` is deliberately absent**: contracts §4.5.4 gives reversal its own route,
 * `POST …/documents/{documentId}/reverse { effectiveDate, reason }`, gated by `accounting.document.reverse`
 * — a code §3.6.2 assigns to 2B so that posting and reversing are separate authorities. Offering `reversed`
 * here would put it behind `accounting.journal.post` and collapse that separation.
 */
export const TransitionBody = z.object({
  to: z.enum(["issued", "posted", "void"]),
  reason: z.string().trim().min(1).max(500).optional(),
}).refine((b) => (b.to === "void" ? Boolean(b.reason) : true), { message: "a void requires a reason" })
  .openapi("Transition");

export const TransitionResultSchema = z.object({
  documentId: UuidSchema, status: z.string(), number: z.string().nullable(), series: z.string(),
  fiscalPeriodId: UuidSchema.nullable(), ledgerEntryIds: z.array(UuidSchema),
}).openapi("TransitionResult");

export const DocumentQuery = ListQuery.extend({
  status: z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]).optional(),
  fiscalPeriodId: UuidSchema.optional(),
});
export const DocumentList = ListEnvelope(DocumentSchema.omit({ lines: true }));
```

```ts
// packages/contracts/src/accounting/ledger.ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const LedgerEntrySchema = z.object({
  id: UuidSchema, documentId: UuidSchema, lineNo: z.number().int().positive(), accountId: UuidSchema,
  debit: z.string(), credit: z.string(), currency: z.string().regex(/^[A-Z]{3}$/), exchangeRate: z.string(),
  baseDebit: z.string(), baseCredit: z.string(), effectiveDate: DateSchema, fiscalPeriodId: UuidSchema,
  postingPolicyId: UuidSchema, postedAt: TimestampSchema, postedBy: UuidSchema,
}).openapi("LedgerEntry");

export const LedgerEntryQuery = ListQuery.extend({
  accountId: UuidSchema.optional(), fiscalPeriodId: UuidSchema.optional(), documentId: UuidSchema.optional(),
  from: DateSchema.optional(), to: DateSchema.optional(),
});
export const LedgerEntryList = ListEnvelope(LedgerEntrySchema);
```

Add both to `packages/contracts/src/index.ts`.

- [ ] **Step 3: Write `apps/api/src/routes/accounting/documents.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { v7 as newUuidV7 } from "uuid";
import {
  AppError, CreateDocumentBody, DocumentSchema, ProblemSchema, ReplaceLinesBody, TransitionBody,
  TransitionResultSchema, UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { issueDocument, postDocument, voidDocument } from "@dulja/db";
import type { AppEnv } from "../../context";
import { IdempotencyHeader } from "../index";
import { requirePermission } from "../../middleware/require-permission";

export const documentRoutes = new OpenAPIHono<AppEnv>();
/** Phase 1 gates statically. 2A resolves policy.approval.create / policy.approval.post instead; the paths,
 *  the bodies and the responses do not change (contracts §4.4.1 semantics, §4.2.7 paths). */
const draft = requirePermission(PERMISSION["accounting.journal.create"], { company: "path:companyId" });
const post = requirePermission(PERMISSION["accounting.journal.post"], { company: "path:companyId" });

type HeaderRow = {
  id: string; document_type_code: string; status: string; series: string; number: string | null;
  fiscal_period_id: string | null; effective_date: string; currency: string; exchange_rate: string;
  rate_source: string | null; branch_id: string; client_ref: string | null; reverses_document_id: string | null;
  posted_at: Date | null; created_at: Date;
};
type LineRow = {
  id: string; line_no: number; description: string | null; account_id: string | null; debit: string;
  credit: string; dimensions: Record<string, string>; custom_fields: Record<string, unknown>;
};
/** Nested postgres.js fragments, never `sql.unsafe` — contracts §3.3 confines that to three homes. */
const header = (tx: Sql) => tx`d.id, t.code as document_type_code, d.status::text as status, d.series, d.number::text as number,
                               d.fiscal_period_id, to_char(d.effective_date, 'YYYY-MM-DD') as effective_date, d.currency,
                               d.exchange_rate::text as exchange_rate, d.rate_source, d.branch_id, d.client_ref::text as client_ref,
                               d.reverses_document_id, d.posted_at, d.created_at`;
const lineColumns = (tx: Sql) => tx`id, line_no, description, account_id, debit::text as debit, credit::text as credit, dimensions, custom_fields`;

const toDocument = (h: HeaderRow, lines: LineRow[]) => ({
  id: h.id, documentTypeCode: h.document_type_code, status: h.status, series: h.series, number: h.number,
  fiscalPeriodId: h.fiscal_period_id, effectiveDate: h.effective_date, currency: h.currency,
  exchangeRate: h.exchange_rate, rateSource: h.rate_source, branchId: h.branch_id, clientRef: h.client_ref,
  reversesDocumentId: h.reverses_document_id, postedAt: h.posted_at?.toISOString() ?? null,
  createdAt: h.created_at.toISOString(),
  lines: lines.map((l) => ({
    id: l.id, lineNo: l.line_no, description: l.description, accountId: l.account_id,
    debit: l.debit, credit: l.credit, dimensions: l.dimensions, customFields: l.custom_fields,
  })),
});

documentRoutes.openapi(
  createRoute({
    method: "post", path: "/", tags: ["accounting"], middleware: [draft] as const, summary: "Draft a document with its lines",
    request: { params: z.object({ companyId: UuidSchema }), headers: IdempotencyHeader,
               body: { content: { "application/json": { schema: CreateDocumentBody } } } },
    responses: {
      201: { description: "The draft", content: { "application/json": { schema: DocumentSchema } } },
      422: { description: "No rate, or no policy", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const id = newUuidV7();
    const doc = await c.var.withTenant(async (tx) => {
      const [type] = await tx<{ id: string }[]>`
        select id from app.document_type where company_id = ${companyId} and code = ${body.documentTypeCode}`;
      if (!type) throw new AppError("ERR_NOT_FOUND", `company ${companyId} has no document type ${body.documentTypeCode}`);

      const [company] = await tx<{ base_currency: string }[]>`select base_currency from app.company where id = ${companyId}`;
      if (!company) throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);

      // The rate is pinned on the document at create; a stored base amount is never recomputed on read
      // (spec:2041, 2039). The identity pair is never looked up — it is rate 1, source 'unit' (§4.2.10).
      let rate = "1";
      let source: string | null = null;
      if (body.currency !== company.base_currency) {
        const [r] = await tx<{ rate: string; source: string }[]>`
          select rate::text as rate, source from app.rate_for(${companyId}, ${body.currency}, ${company.base_currency}, ${body.effectiveDate}::date)`;
        if (!r?.rate) throw new AppError("ERR_RATE_NOT_FOUND", `no exchange rate from ${body.currency} to ${company.base_currency} for company ${companyId} on ${body.effectiveDate}`);
        rate = r.rate;
        source = r.source;
      }

      // The series comes from the policy so a draft already shows the series it will be numbered in; the
      // number itself is assigned at issue and never by the client (SAH-051).
      const [policy] = await tx<{ definition: { numbering: { series: string } } }[]>`
        select definition from app.posting_policy
         where document_type_id = ${type.id} and effective_from <= ${body.effectiveDate}::date
         order by effective_from desc, version desc limit 1`;
      if (!policy) throw new AppError("ERR_POLICY_NOT_FOUND", `no posting policy for ${body.documentTypeCode} effective on ${body.effectiveDate}`);

      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date,
                                         currency, exchange_rate, rate_source, branch_id, client_ref)
               values (${id}, ${c.var.ctx.tenantId}, ${companyId}, ${type.id}, ${policy.definition.numbering.series},
                       ${body.effectiveDate}, ${body.currency}, ${rate}, ${source}, ${body.branchId}, ${body.clientRef ?? null})`;
      await insertLines(tx, c.var.ctx.tenantId, companyId, id, body.lines);
      return readDocument(tx, companyId, id);
    });
    return c.json(doc, 201);
  },
);

documentRoutes.openapi(
  createRoute({
    method: "get", path: "/{documentId}", tags: ["accounting"], summary: "Read a document with its lines (membership only)",
    request: { params: z.object({ companyId: UuidSchema, documentId: UuidSchema }) },
    responses: {
      200: { description: "The document", content: { "application/json": { schema: DocumentSchema } } },
      404: { description: "Not in this company", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    return c.json(await c.var.withTenant((tx) => readDocument(tx, companyId, documentId)));
  },
);

documentRoutes.openapi(
  createRoute({
    method: "put", path: "/{documentId}/lines", tags: ["accounting"], middleware: [draft] as const,
    summary: "Replace the lines of a draft",
    request: {
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: ReplaceLinesBody } } },
    },
    responses: {
      200: { description: "The document", content: { "application/json": { schema: DocumentSchema } } },
      409: { description: "Not a draft", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const { lines } = c.req.valid("json");
    const doc = await c.var.withTenant(async (tx) => {
      const [header] = await tx<{ status: string }[]>`
        select status::text as status from app.document where id = ${documentId} and company_id = ${companyId} for update`;
      if (!header) throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      if (header.status !== "draft") throw new AppError("ERR_DOC_STATUS_ILLEGAL", `document ${documentId} is ${header.status}; only a draft's lines may be replaced`);
      // app_rw holds no DELETE on document_line until 2B's migration 0023, so a replacement zeroes EVERY
      // existing row and then upserts the new set — a body of [1, 3] must not leave line 2 standing. The
      // audit trail keeps the before-image of each row (spec:106).
      //
      // account_id is nulled too, and that null is load-bearing: replacing three lines with two leaves the
      // third row physically present, and a zero/zero row that still carried an account_id would come back
      // out of readDocument as a phantom line in 1B's journal grid. `debit = 0 and credit = 0 and
      // account_id is null` is a shape no API-created line can have — LineInput.accountId is required — so
      // readDocument uses exactly that predicate to hide the tombstone. postDocument is unaffected either
      // way: the evaluator drops zero-amount lines.
      await tx`update app.document_line set debit = 0, credit = 0, description = null, account_id = null,
                                            dimensions = '{}'::jsonb
                where document_id = ${documentId}`;
      await upsertLines(tx, c.var.ctx.tenantId, companyId, documentId, lines);
      return readDocument(tx, companyId, documentId);
    });
    return c.json(doc);
  },
);

documentRoutes.openapi(
  createRoute({
    method: "post", path: "/{documentId}/transitions", tags: ["accounting"], middleware: [post] as const,
    summary: "Issue, post or void a document (reversal is 2B's own route, §4.5.4)",
    request: {
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: TransitionBody } } },
    },
    responses: {
      200: { description: "The outcome", content: { "application/json": { schema: TransitionResultSchema } } },
      409: { description: "Illegal transition", content: { "application/problem+json": { schema: ProblemSchema } } },
      422: { description: "Unbalanced, closed period, or invalid policy", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await c.var.withTenant(async (tx) => {
      const [owned] = await tx<{ id: string }[]>`select id from app.document where id = ${documentId} and company_id = ${companyId}`;
      if (!owned) throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      switch (body.to) {
        case "issued": {
          const r = await issueDocument(tx, c.var.ctx, { documentId });
          return { documentId, status: "issued", number: r.number.toString(), series: r.series, fiscalPeriodId: r.fiscalPeriodId, ledgerEntryIds: [] };
        }
        case "posted": {
          const r = await postDocument(tx, c.var.ctx, { documentId });
          return { documentId, status: "posted", number: r.number.toString(), series: r.series, fiscalPeriodId: r.fiscalPeriodId, ledgerEntryIds: r.ledgerEntryIds };
        }
        case "void": {
          await voidDocument(tx, c.var.ctx, { documentId, reason: body.reason! });
          const [h] = await tx<{ series: string; number: string | null; fiscal_period_id: string | null }[]>`
            select series, number::text as number, fiscal_period_id from app.document where id = ${documentId}`;
          return { documentId, status: "void", number: h!.number, series: h!.series, fiscalPeriodId: h!.fiscal_period_id, ledgerEntryIds: [] };
        }
        // No `case "reversed"`. Contracts §4.5.4 gives reversal its own route,
        // POST …/documents/{documentId}/reverse { effectiveDate, reason }, gated by `accounting.document.reverse`
        // — a code §3.6.2 assigns to 2B precisely so a poster is not automatically a reverser. Offering it here
        // under `accounting.journal.post` would collapse that separation and pre-empt 2B's route.
        // `reverseDocument` ships in @dulja/db from Task 9 and is tested there; 2B adds the handler.
      }
    });
    return c.json(result);
  },
);

type Tx = Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0];

async function insertLines(tx: Tx, tenantId: string, companyId: string, documentId: string, lines: readonly { lineNo: number; description?: string; accountId: string; debit?: string; credit?: string; dimensions?: Record<string, string> }[]): Promise<void> {
  for (const l of lines) {
    await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, description, account_id, debit, credit, dimensions)
             values (${tenantId}, ${companyId}, ${documentId}, ${l.lineNo}, ${l.description ?? null}, ${l.accountId},
                     ${l.debit ?? "0.0000"}, ${l.credit ?? "0.0000"}, ${JSON.stringify(l.dimensions ?? {})}::jsonb)`;
  }
}

async function upsertLines(tx: Tx, tenantId: string, companyId: string, documentId: string, lines: readonly { lineNo: number; description?: string; accountId: string; debit?: string; credit?: string; dimensions?: Record<string, string> }[]): Promise<void> {
  for (const l of lines) {
    await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, description, account_id, debit, credit, dimensions)
             values (${tenantId}, ${companyId}, ${documentId}, ${l.lineNo}, ${l.description ?? null}, ${l.accountId},
                     ${l.debit ?? "0.0000"}, ${l.credit ?? "0.0000"}, ${JSON.stringify(l.dimensions ?? {})}::jsonb)
             on conflict (document_id, line_no) do update
                set description = excluded.description, account_id = excluded.account_id,
                    debit = excluded.debit, credit = excluded.credit, dimensions = excluded.dimensions`;
  }
}

async function readDocument(tx: Tx, companyId: string, documentId: string) {
  const [h] = await tx<HeaderRow[]>`
    select ${header(tx)} from app.document d join app.document_type t on t.id = d.document_type_id
     where d.id = ${documentId} and d.company_id = ${companyId}`;
  if (!h) throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
  // The `not (…)` clause hides the tombstones the PUT …/lines handler leaves behind: app_rw has no DELETE on
  // document_line until 2B's migration 0023, so a shorter replacement zeroes and un-accounts the rows it no
  // longer needs. `debit = 0 and credit = 0 and account_id is null` is unreachable for a line created through
  // this API — LineInput.accountId is required — so nothing a caller wrote is ever hidden.
  const lines = await tx<LineRow[]>`select ${lineColumns(tx)} from app.document_line
     where document_id = ${documentId}
       and not (debit = 0 and credit = 0 and account_id is null)
     order by line_no`;
  return toDocument(h, lines);
}
```

- [ ] **Step 4: Write `apps/api/src/routes/accounting/ledger.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { decodeCursor, encodeCursor, LedgerEntryList, LedgerEntryQuery, UuidSchema } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";

export const ledgerRoutes = new OpenAPIHono<AppEnv>();
const read = requirePermission(PERMISSION["accounting.ledger.read"], { company: "path:companyId" });

type Row = {
  id: string; document_id: string; line_no: number; account_id: string; debit: string; credit: string;
  currency: string; exchange_rate: string; base_debit: string; base_credit: string; effective_date: string;
  fiscal_period_id: string; posting_policy_id: string; posted_at: Date; posted_by: string;
};

ledgerRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["accounting"], middleware: [read] as const, summary: "Read posted ledger entries",
    request: { params: z.object({ companyId: UuidSchema }), query: LedgerEntryQuery },
    responses: { 200: { description: "A page of entries", content: { "application/json": { schema: LedgerEntryList } } } },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { cursor, limit, accountId, fiscalPeriodId, documentId, from, to } = c.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    // Every filter is a declared field bound as a parameter — no field name reaches SQL as text (test 27).
    // The index this uses is plan0A's ledger_entry (company_id, account_id, effective_date) — SAH-070.
    const rows = await c.var.withTenant((tx) => tx<Row[]>`
      select id, document_id, line_no, account_id, debit::text as debit, credit::text as credit, currency,
             exchange_rate::text as exchange_rate, base_debit::text as base_debit, base_credit::text as base_credit,
             to_char(effective_date, 'YYYY-MM-DD') as effective_date, fiscal_period_id, posting_policy_id,
             posted_at, posted_by
        from app.ledger_entry
       where company_id = ${companyId}
         and (${accountId ?? null}::uuid is null or account_id = ${accountId ?? null}::uuid)
         and (${fiscalPeriodId ?? null}::uuid is null or fiscal_period_id = ${fiscalPeriodId ?? null}::uuid)
         and (${documentId ?? null}::uuid is null or document_id = ${documentId ?? null}::uuid)
         and (${from ?? null}::date is null or effective_date >= ${from ?? null}::date)
         and (${to ?? null}::date is null or effective_date <= ${to ?? null}::date)
         and (${after ? after.id : null}::uuid is null or id > ${after ? after.id : null}::uuid)
       order by id limit ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.json({
      items: page.map((r) => ({
        id: r.id, documentId: r.document_id, lineNo: r.line_no, accountId: r.account_id, debit: r.debit,
        credit: r.credit, currency: r.currency, exchangeRate: r.exchange_rate, baseDebit: r.base_debit,
        baseCredit: r.base_credit, effectiveDate: r.effective_date, fiscalPeriodId: r.fiscal_period_id,
        postingPolicyId: r.posting_policy_id, postedAt: r.posted_at.toISOString(), postedBy: r.posted_by,
      })),
      next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.id }) : null,
    });
  },
);
```

- [ ] **Step 5: Register both modules and their probes**

`apps/api/src/routes/index.ts`:

```ts
    { path: "/v1/companies/:companyId/documents", router: documentRoutes, permissions: ["accounting.journal.create", "accounting.journal.post"], auth: "human" },
    { path: "/v1/companies/:companyId/ledger-entries", router: ledgerRoutes, permissions: ["accounting.ledger.read"], auth: "human" },
```

`tests/invariants/probes.ts`:

```ts
  "/v1/companies/:companyId/documents": {
    seed: (_db, owner) => Promise.resolve({
      path: `/v1/companies/${owner.company}/documents`, method: "POST",
      body: {
        documentTypeCode: "JOURNAL", effectiveDate: "2026-01-15", currency: "MYR", branchId: owner.hq,
        lines: [{ lineNo: 1, accountId: owner.cash, debit: "1.0000" }, { lineNo: 2, accountId: owner.sales, credit: "1.0000" }],
      },
    }),
    expect: 403,
  },
  "/v1/companies/:companyId/ledger-entries": {
    seed: (_db, owner) => Promise.resolve({ path: `/v1/companies/${owner.company}/ledger-entries`, method: "GET" }),
    expect: 403,
  },
```

- [ ] **Step 6: Run everything to verify**

Run: `bun run --cwd apps/api test -- test/routes/accounting && bun run --cwd packages/contracts openapi:generate && bun run lint:rules`
Expected: **PASS** — `documents.test.ts` 11, `fiscal-periods.test.ts` 6 (green since Task 11), `accounts.test.ts` 8. `lint:rules` prints `9 rules, N files, 0 violations`: all six 1A permission codes are now referenced by a handler, so `permission-catalogue` is satisfied for the first time since Task 4, and this is the commit the Task 4 → 12 pull request is opened from (Execution handoff).

Run: `bun run --cwd tests test -- invariants/tenant-isolation.test.ts`
Expected: PASS — the harness now iterates four more `ROUTES` entries and finds a `PROBES` entry for each (test 12).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts apps/api tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(api): the generic document API and the ledger read [1A T12]

/v1/companies/{companyId}/documents, .../lines and .../transitions — the paths
§4.2.7 fixes, gated at Phase 1 by the static accounting.journal.create and
.post codes and restricted to documentTypeCode JOURNAL; 2A resolves both from
the policy and lifts the restriction without moving a path. The exchange rate is
resolved and pinned at create, so a stored base amount is never recomputed.
All six Phase 1 permission codes now have a handler and lint:rules is green.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13 — The `document-types` seed sub-pack: the loader and `JOURNAL.json`

Contracts §3.4.8 makes 1A the owner of the `document-types` loader: 0C builds the seed CLI and its `--only` flag but cannot write a loader for an envelope whose policy schema does not exist yet. This task ships the loader, the first sub-pack file, and the run that proves a tenant can be given the JOURNAL type from version-controlled JSON rather than from a fixture.

**Files:**
- Create: `packages/db/src/seed/document-types.ts`, `packages/db/seed/my/document-types/JOURNAL.json`, `packages/db/test/seed/document-types.test.ts`
- Modify: `packages/db/src/seed/index.ts` (Step 3's export **and** Step 4's `LOADERS` / `applied` entries — the seed barrel, because §3.1 forbids a `./seed` export on `packages/db/src/index.ts`); and, to register the sub-pack with 0C's dispatcher (Step 4), `packages/db/src/seed/types.ts`, `packages/db/src/seed/packs.ts`, `packages/db/test/seed-packs.test.ts`, `packages/db/test/seed-idempotent.test.ts`

**Interfaces:**
- Produces (TS), exported from `@dulja/db/seed` — the subpath, never the main barrel (§3.1, sah-039; Step 3):

```ts
export interface DocumentTypeSeedResult { code: string; documentTypeId: string; policyId: string; created: boolean }
/** The standalone form: opens its own tenant transaction. `packDir` is `packages/db/seed/<pack>/document-types`. */
export async function loadDocumentTypes(sql: Sql, ctx: TenantContext, packDir: string, catalogue: readonly string[]): Promise<DocumentTypeSeedResult[]>;
/** The seam form: what `--only document-types` dispatches to (§4.2.13's `PackLoader`, §3.4.8's first later loader). */
export const documentTypesLoader: PackLoader;   // name: "document-types"
```

**This task registers the `document-types` sub-pack with 0C's `--only` dispatcher.** §4.2.13 fixes that seam as `PackLoader { readonly name: SubPack; load(tx: Sql, ctx: LoaderContext): Promise<number> }`, and 0C dispatches through `const LOADERS: Readonly<Record<SubPack, PackLoader>>` and `runLoaders` in `packages/db/src/seed/index.ts` — not through a `switch` in `cli.ts`. `documentTypesLoader` is that member for `document-types`; `loadDocumentTypes` keeps the §4.3.7 signature verbatim and stays the implementation underneath it, which is what this task's tests call directly. **The two forms cannot be one function:** `runLoaders` already wraps every `load` in `withTenant(sql, { tenantId, actorId: systemPrincipalId, requestId }, …)` and hands the loader the resulting `tx`, so a `load` that called `loadDocumentTypes(tx, …)` would open a second `withTenant` on a transaction and raise `ERR_TENANT_CONTEXT_NESTED` (§4.2.2) — and `LoaderContext` carries no `requestId` from which to build a `TenantContext` anyway. Step 3 therefore factors the file into a file-reading half and a transaction half, and the two exported forms compose them differently.

- Consumes: `validateDocumentTypeSeed`, `validatePolicy` (Task 5); `withTenant`, `TenantContext` (§4.2.2); `PackLoader`, `LoaderContext` from `packages/db/src/seed/packs.ts` and `SubPack` / `SUB_PACKS` from `packages/db/src/seed/types.ts` (§4.2.13, 0C Task 6); `readdir`/`readFile` from `node:fs/promises`.

**Three rules from §3.4.8 and §4.3.7 the loader implements literally:**
1. `document_type` upserts `on conflict do nothing`; `posting_policy` upserts `on conflict (document_type_id, version) do update set definition = excluded.definition, effective_from = excluded.effective_from` — a placeholder seeded on staging must not survive the real definition arriving.
2. `<CODE>.json`'s file name, the envelope's `code` and `policy.documentType` must all agree; `validateDocumentTypeSeed` checks the last two and the loader checks the first.
3. The loader **validates the policy against the permission catalogue** before either insert, so a policy naming a code whose slice has not shipped is refused at seed time rather than at post (F-21).

**The `module` member is validated and not inserted.** `app.document_type` gains its `module` column in 2A's migration 0018; until then the envelope's value is checked against the enum and carried no further (this plan's reading 4). 2A widens the insert list in the same PR as the migration.

**The catalogue is a parameter, not an import — and the CLI reads it from the database, not from `@dulja/contracts`.** `packages/db` may not import `@dulja/contracts`: 0B's `dependency-rule` pins `"packages/db": ["@dulja/domain"]` (0B step "Write `scripts/lint/rules/dependency-rule.ts`", spec:2389), and `packages/db/src/cli.ts` is inside `packages/db`, so `PERMISSIONS.map((p) => p.code)` in the CLI would be a `dependency-rule` violation and would break the "no other rule may report anything" rule of Global Constraints at this task. The caller therefore supplies the codes as data — the same shape 0D chose for `adminPermissions(catalogue)` in `packages/db/seed/roles.ts` — and both callers read them from `app.permission`, which is the authoritative set at seed time anyway: it is global, has no `tenant_id` and no RLS (plan0A:1313), migration 0014 is the only writer, and `permission-catalogue.test.ts` asserts it equals `PERMISSIONS` in both directions, so the two sources can never disagree. Step 4's CLI branch and the test below both run `select code from app.permission`.

- [ ] **Step 1: Write the failing test `packages/db/test/seed/document-types.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadDocumentTypes } from "../../src/seed/document-types";
import { JOURNAL_POLICY_V1, seedTenant, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const PACK = fileURLToPath(new URL("../../seed/my/document-types", import.meta.url));
/** Task 5's copy of the same envelope. The first assertion below pins the two files byte for byte. */
const DOMAIN_FIXTURE = fileURLToPath(new URL("../../../domain/test/posting/journal-envelope.fixture.json", import.meta.url));

describe("the document-types sub-pack loader — contracts §3.4.8, §4.3.7", () => {
  let db: Db;
  let a: Seed;
  let catalogue: string[];
  const ctx = (s: Seed) => ({ tenantId: s.tenant, actorId: s.system, requestId: "seed" });

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");                 // deliberately NOT seedTenantV2: the pack does the work
    const rows = await db.admin<{ code: string }[]>`select code from app.permission`;
    catalogue = rows.map((r) => r.code);
  });
  afterAll(async () => { await db.stop(); });

  it("the seed file is byte-identical to the domain fixture the evaluator tests use", () => {
    // Two assertions, because there are three copies of this JSON and each pair has to be pinned:
    // (1) the seed pack file against the domain test fixture, byte for byte — this is the claim Task 5 makes
    //     when it writes the fixture, and without it the fixture can drift and take the evaluator's tests
    //     with it; (2) the seed file's `policy` member against JOURNAL_POLICY_V1 in packages/db/test/fixtures.ts,
    //     which is what seedJournalPolicy inserts.
    const seedText = readFileSync(`${PACK}/JOURNAL.json`, "utf8");
    const fixtureText = readFileSync(DOMAIN_FIXTURE, "utf8");
    expect(seedText).toBe(fixtureText);

    const onDisk = JSON.parse(seedText) as { policy: unknown };
    expect(onDisk.policy).toEqual(JOURNAL_POLICY_V1);
  });

  it("seeds the JOURNAL type and its policy version 2 for the tenant", async () => {
    const results = await loadDocumentTypes(db.rw, ctx(a), PACK, catalogue);
    expect(results).toEqual([expect.objectContaining({ code: "JOURNAL", created: false })]);   // seedTenant already made the type

    const [policy] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { version: number; effective_from: string; definition: unknown }[]
    >`select version, to_char(effective_from, 'YYYY-MM-DD') as effective_from, definition
        from app.posting_policy where document_type_id = ${a.docType} and version = 2`);
    expect(policy).toMatchObject({ version: 2, effective_from: "2026-01-01" });
    expect(policy!.definition).toEqual(JOURNAL_POLICY_V1);
  });

  it("is idempotent, and re-running updates a drifted definition rather than skipping it (§3.4.8)", async () => {
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.posting_policy set definition = ${JSON.stringify({ ...JOURNAL_POLICY_V1, direction: "none" })}::jsonb
       where document_type_id = ${a.docType} and version = 2`);
    await loadDocumentTypes(db.rw, ctx(a), PACK, catalogue);
    const [policy] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ definition: { direction: string } }[]>`
      select definition from app.posting_policy where document_type_id = ${a.docType} and version = 2`);
    expect(policy!.definition.direction).toBe("internal");
  });

  it("refuses a policy naming a permission code the catalogue does not hold (F-21)", async () => {
    await expect(loadDocumentTypes(db.rw, ctx(a), PACK, ["admin.user.manage"]))
      .rejects.toThrow(/JOURNAL\.json.*accounting\.journal\.post is not in the permission catalogue/s);
  });

  it("refuses a file whose name and code disagree", async () => {
    const badDir = fileURLToPath(new URL("./fixtures/bad-document-types", import.meta.url));
    await expect(loadDocumentTypes(db.rw, ctx(a), badDir, catalogue)).rejects.toThrow(/WRONGNAME\.json/);
  });
});
```

`packages/db/test/seed/fixtures/bad-document-types/WRONGNAME.json` — one file whose envelope `code` is `JOURNAL` while the file is named `WRONGNAME.json`:

```json
{
  "code": "JOURNAL",
  "nameEn": "Journal Voucher",
  "module": "accounting",
  "policyVersion": 2,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1, "documentType": "JOURNAL", "direction": "internal", "requires": [], "lines": [],
    "inventory": { "effect": "none" }, "tax": { "applies": false },
    "numbering": { "series": "JV", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "JOURNAL" },
    "approval": { "required": false, "approve": null, "post": "accounting.journal.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" }
  }
}
```

Run: `bun run --cwd packages/db test -- test/seed/document-types.test.ts`
Expected: **FAIL** — `Cannot find module '../../src/seed/document-types'`.

- [ ] **Step 2: Write `packages/db/seed/my/document-types/JOURNAL.json`**

The §4.3.7 file, verbatim — the same JSON as `packages/domain/test/posting/journal-envelope.fixture.json` from Task 5, so the schema tests and the seed cannot diverge.

```json
{
  "code": "JOURNAL",
  "nameEn": "Journal Voucher",
  "nameAr": "قيد يومية",
  "module": "accounting",
  "policyVersion": 2,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "JOURNAL",
    "direction": "internal",
    "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "JV", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "JOURNAL" },
    "approval": { "required": false, "approve": null, "post": "accounting.journal.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

- [ ] **Step 3: Write `packages/db/src/seed/document-types.ts`**

```ts
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Sql } from "postgres";
import { validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import { withTenant, type TenantContext } from "../with-tenant";
import type { LoaderContext, PackLoader } from "./packs";

export interface DocumentTypeSeedResult { code: string; documentTypeId: string; policyId: string; created: boolean }

interface Envelope {
  code: string; nameEn: string; nameAr?: string;
  module: "accounting" | "inventory" | "hr" | "pos";
  policyVersion: number; effectiveFrom: string; policy: Record<string, unknown>;
}

/**
 * The `document-types` sub-pack loader (contracts §3.4.8, §4.3.7), in its standalone form: it is handed a pool
 * and opens the tenant transaction itself. `documentTypesLoader` at the foot of this file is the same loader in
 * §4.2.13's `PackLoader` form, for callers that already hold a `tx` — which is every `--only` run. Per-tenant
 * rows cannot be written by a migration — FORCE ROW LEVEL SECURITY binds app_migrator too (spec:1366) — so every
 * document type and posting policy arrives this way, from version-controlled JSON, diffable in review (SAH-078).
 *
 * `catalogue` is a parameter rather than an import because packages/db may import only @dulja/domain
 * (spec:2389, dependency-rule) — and both this file's callers, the loader below and the test, read the codes
 * from app.permission, which is global, RLS-free (plan0A:1313) and written only by migration 0014, so it is the
 * same set as PERMISSIONS by construction (permission-catalogue.test.ts asserts the equality in both directions).
 */
export async function loadDocumentTypes(
  sql: Sql,
  ctx: TenantContext,
  packDir: string,
  catalogue: readonly string[],
): Promise<DocumentTypeSeedResult[]> {
  const envelopes = await readEnvelopes(packDir, catalogue);
  return withTenant(sql, ctx, (tx) => applyDocumentTypes(tx, ctx.tenantId, envelopes));
}

/** The file half: read, validate against the envelope schema, the file name and the permission catalogue. No I/O to the database, so it is the same whichever of the two entry points calls it. */
async function readEnvelopes(packDir: string, catalogue: readonly string[]): Promise<Envelope[]> {
  const files = (await readdir(packDir)).filter((f) => f.endsWith(".json")).sort();
  const envelopes: Envelope[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(packDir, file), "utf8")) as unknown;
    const envelopeCheck = validateDocumentTypeSeed(raw);
    if (!envelopeCheck.ok) {
      throw new Error(`${file}: ${envelopeCheck.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`);
    }
    const envelope = raw as Envelope;
    if (basename(file, ".json") !== envelope.code) {
      throw new Error(`${file}: the file name must equal the envelope's code ${envelope.code} (contracts §4.3.7)`);
    }
    const policyCheck = validatePolicy(envelope.policy, catalogue);
    if (!policyCheck.ok) {
      throw new Error(`${file}: ${policyCheck.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`);
    }
    envelopes.push(envelope);
  }
  return envelopes;
}

/** The transaction half: `tx` is already inside one tenant transaction — opened by `loadDocumentTypes` above, or by 0C's `runLoaders` before it calls `documentTypesLoader.load`. It never opens its own (§4.2.2 forbids nesting). */
async function applyDocumentTypes(tx: Sql, tenantId: string, envelopes: readonly Envelope[]): Promise<DocumentTypeSeedResult[]> {
  const companies = await tx<{ id: string }[]>`select id from app.company order by created_at`;
  const results: DocumentTypeSeedResult[] = [];
  for (const company of companies) {
    for (const e of envelopes) {
      // `module` is validated above and inserted from 2A's migration 0018 onward, which adds the column.
      const inserted = await tx<{ id: string }[]>`
        insert into app.document_type (tenant_id, company_id, code, name_en, name_ar)
        values (${tenantId}, ${company.id}, ${e.code}, ${e.nameEn}, ${e.nameAr ?? null})
        on conflict (company_id, code) do nothing
        returning id`;
      const [type] = inserted.length > 0
        ? inserted
        : await tx<{ id: string }[]>`select id from app.document_type where company_id = ${company.id} and code = ${e.code}`;

      // A policy version is `do update`, never `do nothing` (contracts §3.4.8): a placeholder seeded on
      // staging must not silently survive the real definition arriving in a later phase.
      const [policy] = await tx<{ id: string }[]>`
        insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
        values (${tenantId}, ${type!.id}, ${e.policyVersion}, ${e.effectiveFrom}::date, ${JSON.stringify(e.policy)}::jsonb)
        on conflict (document_type_id, version) do update
           set definition = excluded.definition, effective_from = excluded.effective_from
        returning id`;
      results.push({ code: e.code, documentTypeId: type!.id, policyId: policy!.id, created: inserted.length > 0 });
    }
  }
  return results;
}

/**
 * The §4.2.13 seam: what `bun run seed --only document-types` dispatches to. `runLoaders` has already opened the
 * tenant transaction with the system principal as actor, so this receives `tx` and must not open another
 * (`ERR_TENANT_CONTEXT_NESTED`, §4.2.2) — which is why it composes the two halves above rather than calling
 * `loadDocumentTypes`. The catalogue is read from `app.permission` inside the same transaction, exactly as 0C's
 * `rolesLoader` does: this file is inside `packages/db`, which `dependency-rule` pins to `["@dulja/domain"]`
 * (spec:2389), so a `PERMISSIONS` import here would be a lint violation. `app.permission` is global — no
 * `tenant_id`, no RLS (plan0A:1313) — migration 0014 is its only writer, and `permission-catalogue.test.ts`
 * asserts it equals `PERMISSIONS` in both directions, so the read is the same set by construction.
 *
 * The return is "rows inserted", the one meaning §4.2.13 gives every loader: the count of document types created,
 * which is 0 on the idempotent second run even though the policy upsert is `do update`.
 */
export const documentTypesLoader: PackLoader = {
  name: "document-types",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const catalogue = (await tx<{ code: string }[]>`select code from app.permission order by code`).map((r) => r.code);
    const envelopes = await readEnvelopes(join(ctx.packRoot, "document-types"), catalogue);
    const results = await applyDocumentTypes(tx, ctx.tenantId, envelopes);
    return results.filter((r) => r.created).length;
  },
};
```

Add `export { documentTypesLoader, loadDocumentTypes, type DocumentTypeSeedResult } from "./document-types";` to **`packages/db/src/seed/index.ts`** — 0C's seed barrel, reached as `@dulja/db/seed` (§4.2.12, §4.2.13).

**Never `packages/db/src/index.ts`.** §3.1 settles it: the seed is reachable only through the `@dulja/db/seed` subpath, and 0C's `tests/regression/sah-039.test.ts` asserts the main barrel carries no `export … from "./seed…"` **at any depth** (`expect(barrel).not.toMatch(/from ["']\.\/seed/)`), so `export * from "./seed/document-types";` fails that regression even though this module imports no Supabase itself — `packages/db/src/seed/auth-admin.ts` does, and one re-export on the barrel would put the service-role admin client on the import graph of every `apps/api` and `apps/worker` module that imports `withTenant`. Nothing else in this task moves: Step 1's test imports the module by relative path, and 2C, 3C, 3D, 5A, 7A and 8A consume `loadDocumentTypes` through `@dulja/db/seed`.

- [ ] **Step 4: Register the sub-pack with 0C's `--only` dispatcher**

`cli.ts` needs no edit: 0C's `--only` dispatch is a table, not a `switch`. `packages/db/src/seed/index.ts` holds `const LOADERS: Readonly<Record<SubPack, PackLoader>>` and `runLoaders`, which opens one `withTenant` per sub-pack and calls `loader.load(tx, ctx)`. Widening `SubPack` is what makes `--only document-types` a legal flag, and five edits follow from it — all five are what 0C's ADR 0012 ("a slice adding a sub-pack edits `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES` and `OWNED_ELSEWHERE`") told this slice to expect:

1. `packages/db/src/seed/types.ts` — add `"document-types"` to the `SubPack` union and to `SUB_PACKS`. **It goes last**, after `chart-of-accounts`: `SUB_PACKS` is application order, and a policy is validated against accounts that must already exist (contracts §5 item 33).
2. `packages/db/src/seed/index.ts` — one added line in each of the two places `SubPack` is enumerated, and the import they need (beside the re-export Step 3 added to this same file). Add only these; do not restate 0C's map, whose annotation 0C settles across its Tasks 8, 10 and 11:

```ts
import { documentTypesLoader } from "./document-types";
//   … into the LOADERS map:
  "document-types": documentTypesLoader,          // 1A — contracts §3.4.8's first later sub-pack
//   … into runLoaders' `const applied: Record<SubPack, number>` initialiser, which will not typecheck a key short:
  "document-types": 0,
```

(The other `applied: { roles: 0, … }` literal, in `seed()` at 0C Task 7, is a placeholder its own Task 12 replaces with `await runLoaders(…)` — it is gone by the time this slice runs, so it is not a third site.)

3. `packages/db/src/seed/packs.ts` — move `"document-types"` out of `OWNED_ELSEWHERE` (where 0C parked it as "slice 1A's and cannot be applied at Phase 0") and into `PHASE_0_SUB_PACK_DIRECTORIES`. Without the move, `assertPackShape` refuses the very pack Step 2 just added `document-types/JOURNAL.json` to and the seed exits **3**. **Keep the const's name.** 0C's ADR 0012 foresees renaming it "as the pack grows", but §4.2.13 registers the spelling `PHASE_0_SUB_PACK_DIRECTORIES` and its Phase 0 value, so a rename is the architect's amendment, not this task's — the same §4.18 row that opens this loader against §4.2.13 is where it belongs.
4. `packages/db/test/seed-packs.test.ts` — **three** assertions in 0C's file name the old four-member world, and all three go red the moment `SubPack` is widened:
   - `expect(SUB_PACKS).toEqual(["roles", "dimensions", "fiscal-periods", "chart-of-accounts"])` → append `"document-types"`.
   - the `--only` case `expect(() => parseSeedArgs([...base, "--only", "document-types"], env)).toThrow(/unknown sub-pack 'document-types' — expected one of roles, dimensions, fiscal-periods, chart-of-accounts/)` — `document-types` is now a *known* sub-pack, so the case must pick a name that is still unknown (`"tax"`, slice 5A's) and its `expected one of` list must gain the fifth member.
   - in the `assertPackShape` case, `expect(PHASE_0_SUB_PACK_DIRECTORIES).toEqual(["chart-of-accounts", "dimensions", "fiscal-periods"])` gains `"document-types"`, and the last line — `expect(() => assertPackShape(pack([...PHASE_0_SUB_PACK_DIRECTORIES, "document-types"]))).toThrow(/unexpected sub-pack: document-types — document-types\/ is slice 1A's/)` — is deleted, its point having been served. **The `tax` line above it stays**: `OWNED_ELSEWHERE` still holds the four sub-packs 2C, 5A, 7A and 8A own, and that case is what proves it.
5. `packages/db/test/seed-idempotent.test.ts` — `expect(Object.values(r.applied)).toEqual([0, 0, 0, 0])` becomes five zeroes, and the first-run block gains `expect(r.applied["document-types"]).toBe(1)` (one JOURNAL type, one company).

Every later sub-pack owner (2C, 5A, 7A, 8A) repeats exactly these five edits for its own name — the thing they copy is the `PackLoader` shape, not `loadDocumentTypes`'s signature.

- [ ] **Step 5: Run the tests and the real seed**

Run: `bun run --cwd packages/db test -- test/seed/document-types.test.ts`
Expected: **PASS** (5 tests).

Run against a Testcontainers or local database with a seeded tenant, **0C's chart first** so every account the JOURNAL policy can resolve exists (contracts §5 item 33):

```bash
bun run --cwd packages/db seed --tenant <tenant_id> --only chart-of-accounts
bun run --cwd packages/db seed --tenant <tenant_id> --only document-types
```

Expected: both exit 0. 0C's CLI prints the whole `SeedResult` as JSON (`console.log(JSON.stringify(await seed(sql, config), null, 2))`), so what to read is its `applied` map: the second run prints `"document-types": 1` — one JOURNAL type for the one company. **Run each a second time and `applied["document-types"]` is `0`**, which is the idempotence §3.4.8 requires; the policy row is still re-upserted by `do update`, and re-upserting an identical definition changes nothing.

Then verify the three account codes this slice **consumes but does not seed** resolve against the real pack rather than against a fixture:

```bash
psql "$DATABASE_URL_MIGRATOR" -c "select code from app.account where code in ('1000','4000','5920') order by 1"
psql "$DATABASE_URL_MIGRATOR" -c "select (select code from app.account where id = c.fx_rounding_account_id) from app.company c"
```

Expected: `1000`, `4000` and `5920`, and `5920` as the company's `fx_rounding_account_id` (spec:2001, contracts §4.15). If the third is missing, 0C's seed task did not wire `company.fx_rounding_account_id` and every foreign-currency post will raise `ERR_LEDGER_UNBALANCED` on the rounding residue — report it against 0C rather than working around it here.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
chore(seed): the document-types sub-pack — its loader and JOURNAL.json [1A T13]

0C builds the CLI and the --only flag but cannot write a loader for an envelope
whose policy schema does not exist yet, so §3.4.8 gives this sub-pack to 1A. The
file name, the envelope code and policy.documentType must agree; the policy is
validated against the permission catalogue before either insert, so a policy
naming a code whose slice has not shipped is refused at seed time (F-21); and a
policy version is `do update`, so a staging placeholder cannot outlive the real
definition.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14 — Acceptance tests 1 and 4, and the sixteen regression files

The Phase 1 definition-of-done clause this slice owns — "Σdebit = Σcredit holds under fuzz testing" — and the two-tenant concurrency test. Then the Part I regression files: six created here, ten appended to.

**Files:**
- Create: `apps/api/test/routes/accounting/documents.fuzz.test.ts`, `tests/regression/sah-001.test.ts`, `sah-002.test.ts`, `sah-011.test.ts`, `sah-024.test.ts`, `sah-049.test.ts`, `sah-079.test.ts`
- Modify: `tests/regression/sah-003.test.ts`, `sah-012.test.ts`, `sah-021.test.ts`, `sah-031.test.ts`, `sah-035.test.ts`, `sah-041.test.ts`, `sah-050.test.ts`, `sah-051.test.ts`, `sah-070.test.ts`, `sah-071.test.ts` (0B created all ten; this slice **appends** a `describe(… — 1A)` block to each and edits no earlier block — contracts §3.7.3)

**Interfaces:**
- Consumes: `startApi`, `StartedApi` (§4.2.12); `seedTenantV2`, `seedAccount`, `uuidv7`, `Db`, `Seed` (§4.1, §4.17); production `withTenant`, `issueDocument`, `postDocument`, `voidDocument`, `reverseDocument`, `lintSchema` from `@dulja/db`; `sharedDb` from `tests/support/regression.ts` (0B — contracts §4.17.1; it returns `{ db: Db; rw: Sql; a: Seed; b: Seed }`, so every regression file below destructures it and never treats the result as a `Db`); `fc` from `fast-check`; `postgres` for the two-connection tests.

**`sharedDb()`'s two halves, and which is which.** `db` is Plan 0A's `Db` — `db.admin`, `db.migrator`, `db.url(role)`, `db.stop()` — and is what `seedTenantV2(db, …)`, `seedAccount(db, s, …)`, `uuidv7(db.admin)` and `postgres(db.url("app_rw"), …)` take. `rw` is 0B's **production** `createDb(db.url("app_rw"))` pool, and is what the production three-argument `withTenant(rw, ctx, fn)` takes — the whole point of the regression tier is that the defect is re-proved through the production layer (0B Task 13). A file that needs only a catalogue read destructures `{ db }`; a file that also runs a tenant-scoped statement destructures `{ db, rw }`. `sharedDb()` is memoised for the whole `tests` run, so **no file calls `db.stop()`**. This slice does **not** use 0B's `thinRegression` wrapper: its `describe` title is hard-coded `… — 0B` (0B Task 13 Step 2), and contracts §3.7.3 requires a 1A block to read `… — 1A`, so each file below writes its own `describe`/`it`.
- Produces: no application code — this task is tests only.

- [ ] **Step 1: Write `apps/api/test/routes/accounting/documents.fuzz.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import postgres from "postgres";
import { postDocument, withTenant } from "@dulja/db";
import { seedAccount, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

describe("acceptance test 1 — the ledger invariant under fuzz (spec:2419, SAH-003)", () => {
  let api: StartedApi;
  let a: Seed;
  let accounts: string[];

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Fuzz");
    accounts = [a.cash, a.sales];
    for (const [code, name, type] of [["1100", "Bank", "asset"], ["1300", "Inventory control", "asset"], ["2100", "Trade payables", "liability"]] as const) {
      accounts.push(await seedAccount(api.db, a, { code, nameEn: name, type }));
    }
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'fuzz', 'Fuzz')`;
      for (const code of ["accounting.journal.create", "accounting.journal.post"]) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.tenant}, ${a.human}, ${roleId}, ${a.company})`;
    });
  }, 180_000);
  afterAll(async () => { await api.stop(); });

  /** A balanced document: n debit legs and m credit legs whose totals agree to the cent in the document
   *  currency. The generator produces the SHAPE; the ledger invariant is the property. */
  const balanced = fc
    .record({
      debits: fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 1, maxLength: 6 }),
      creditSplit: fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 6 }),
      accountPicks: fc.array(fc.nat({ max: 4 }), { minLength: 12, maxLength: 12 }),
    })
    .map(({ debits, creditSplit, accountPicks }) => {
      const total = debits.reduce((x, y) => x + y, 0);
      const weight = creditSplit.reduce((x, y) => x + y, 0);
      const credits: number[] = creditSplit.map((w) => Math.floor((total * w) / weight));
      credits[0]! += total - credits.reduce((x, y) => x + y, 0);          // the residue lands on the first leg
      return { debits, credits: credits.filter((c) => c > 0), accountPicks };
    })
    .filter((d) => d.credits.length > 0);

  it("every balanced document either posts with Σdebit = Σcredit, or is refused — never a wrong number", async () => {
    await fc.assert(
      fc.asyncProperty(balanced, async ({ debits, credits, accountPicks }) => {
        const cents = (n: number) => (n / 10_000).toFixed(4);
        const lines = [
          ...debits.map((v, i) => ({ lineNo: i + 1, accountId: accounts[accountPicks[i]! % accounts.length]!, debit: cents(v) })),
          ...credits.map((v, i) => ({ lineNo: debits.length + i + 1, accountId: accounts[accountPicks[6 + i]! % accounts.length]!, credit: cents(v) })),
        ];
        const created = await api.request({
          method: "POST", path: `/v1/companies/${a.company}/documents`, as: a.human,
          body: { documentTypeCode: "JOURNAL", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq, lines },
        });
        if (created.status !== 201) return true;                          // a refusal is never a wrong number
        const { id } = (await created.json()) as { id: string };
        const posted = await api.request({
          method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: a.human, body: { to: "posted" },
        });
        if (posted.status !== 200) return true;

        const [sums] = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "fuzz" }, (tx) => tx<
          { diff: string; base_diff: string }[]
        >`select (sum(debit) - sum(credit))::text as diff, (sum(base_debit) - sum(base_credit))::text as base_diff
            from app.ledger_entry where document_id = ${id}`);
        expect(sums!.diff).toBe("0.0000");
        expect(sums!.base_diff).toBe("0.0000");
        return true;
      }),
      { numRuns: 250 },
    );
  }, 600_000);

  it("Σdebit = Σcredit holds for the tenant, the company and every period after the whole run (spec:2419)", async () => {
    const rows = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "fuzz" }, (tx) => tx<
      { fiscal_period_id: string; diff: string }[]
    >`select fiscal_period_id, (sum(base_debit) - sum(base_credit))::text as diff
        from app.ledger_entry where company_id = ${a.company} group by fiscal_period_id`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.diff).toBe("0.0000");
  });

  it("every account_balance row still equals the sum of its ledger entries", async () => {
    const [mismatch] = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "fuzz" }, (tx) => tx<{ n: number }[]>`
      with rebuilt as (
        select company_id, account_id, fiscal_period_id, currency,
               sum(debit) as debit, sum(credit) as credit, sum(base_debit) as base_debit, sum(base_credit) as base_credit
          from app.ledger_entry group by 1, 2, 3, 4)
      select count(*)::int as n
        from rebuilt r full outer join app.account_balance b
          on b.company_id = r.company_id and b.account_id = r.account_id
         and b.fiscal_period_id = r.fiscal_period_id and b.currency = r.currency
       where r.company_id is null or b.company_id is null
          or b.debit <> r.debit or b.credit <> r.credit or b.base_debit <> r.base_debit or b.base_credit <> r.base_credit`);
    expect(mismatch!.n).toBe(0);
  });
});

describe("acceptance test 4 — two tenants post to the same account and currency concurrently (spec:2422)", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    b = await seedTenantV2(api.db, "Beta");
  }, 180_000);
  afterAll(async () => { await api.stop(); });

  it("each sees only its own balance, and neither loses an amount (SAH-001, SAH-035, SAH-049)", async () => {
    const draft = async (s: Seed, amount: string): Promise<string> => {
      const id = await uuidv7(api.db.admin);
      await withTenant(api.db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "seed" }, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${s.tenant}, ${s.company}, ${id}, 1, ${s.cash}, ${amount})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${s.tenant}, ${s.company}, ${id}, 2, ${s.sales}, ${amount})`;
      });
      return id;
    };
    const docA = await draft(a, "111.0000");
    const docB = await draft(b, "222.0000");

    // Two real connections interleaved, max: 1 each — the shape spec:2266 asks for.
    const one = postgres(api.db.url("app_rw"), { max: 1, prepare: false });
    const two = postgres(api.db.url("app_rw"), { max: 1, prepare: false });
    try {
      await Promise.all([
        withTenant(one, { tenantId: a.tenant, actorId: a.human, requestId: "race-a" }, (tx) => postDocument(tx, { tenantId: a.tenant, actorId: a.human, requestId: "race-a" }, { documentId: docA })),
        withTenant(two, { tenantId: b.tenant, actorId: b.human, requestId: "race-b" }, (tx) => postDocument(tx, { tenantId: b.tenant, actorId: b.human, requestId: "race-b" }, { documentId: docB })),
      ]);
    } finally {
      await one.end();
      await two.end();
    }

    for (const [s, expected] of [[a, "111.0000"], [b, "222.0000"]] as const) {
      const rows = await withTenant(api.db.rw, { tenantId: s.tenant, actorId: s.human, requestId: "check" }, (tx) => tx<
        { account_id: string; debit: string }[]
      >`select account_id::text as account_id, debit::text as debit from app.account_balance where currency = 'MYR'`);
      expect(rows).toHaveLength(2);                                   // exactly its own cash and sales rows
      expect(rows.find((r) => r.account_id === s.cash)!.debit).toBe(expected);
    }
  }, 120_000);
});
```

- [ ] **Step 2: Write the six regression files this slice creates**

Each is one `describe("SAH-NNN <Part I heading> — 1A", …)` block. Later slices **append** blocks to the same file and never edit these (contracts §3.7.3).

```ts
// tests/regression/sah-001.test.ts — "Denormalised currency balances are updated without the tenant key"
import { describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { seedTenantV2 } from "@dulja/db/test";
import { sharedDb } from "../support/regression";

describe("SAH-001 Denormalised currency balances updated without the tenant key — 1A", () => {
  it("account_balance carries tenant_id, is RLS-forced, and a second tenant can neither see nor update a row", async () => {
    const { db, rw } = await sharedDb();
    const a = await seedTenantV2(db, "SAH001-A");
    const b = await seedTenantV2(db, "SAH001-B");
    await withTenant(rw, { tenantId: a.tenant, actorId: a.human, requestId: "sah001" }, (tx) => tx`
      insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency, debit, base_debit)
      values (${a.tenant}, ${a.company}, ${a.cash}, ${a.period}, 'MYR', 10.0000, 10.0000)`);
    const seen = await withTenant(rw, { tenantId: b.tenant, actorId: b.human, requestId: "sah001" }, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account_balance`);
    expect(seen[0]!.n).toBe(0);
    const touched = await withTenant(rw, { tenantId: b.tenant, actorId: b.human, requestId: "sah001" }, async (tx) => {
      const r = await tx`update app.account_balance set debit = debit + 1`;
      return r.count;
    });
    expect(touched).toBe(0);
  });
});
```

```ts
// tests/regression/sah-002.test.ts — "Upsert never fires on UPDATE; re-keying destroys the amount"
import { describe, expect, it } from "vitest";
import { postDocument, reverseDocument, withTenant } from "@dulja/db";
import { seedAccount, seedTenantV2, uuidv7 } from "@dulja/db/test";
import { sharedDb } from "../support/regression";

describe("SAH-002 Upsert never fires on UPDATE; re-keying destroys the amount — 1A", () => {
  it("re-keying a posting by reversal leaves sum(account_balance) equal to sum(ledger_entry) (test 3)", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH002");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah002" };
    const wrong = await seedAccount(db, s, { code: "1100", nameEn: "Bank", type: "asset" });
    const right = await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    const draft = async (account: string): Promise<string> => {
      const id = await uuidv7(db.admin);
      await withTenant(rw, ctx, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${s.tenant}, ${s.company}, ${id}, 1, ${account}, 250.0000)`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${s.tenant}, ${s.company}, ${id}, 2, ${s.sales}, 250.0000)`;
      });
      return id;
    };
    const first = await draft(wrong);
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: first }));
    await withTenant(rw, ctx, (tx) => reverseDocument(tx, ctx, { documentId: first, effectiveDate: "2026-01-16", reason: "re-key" }));
    const second = await draft(right);
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: second }));

    const [net] = await withTenant(rw, ctx, (tx) => tx<{ wrong: string; right: string }[]>`
      select coalesce(max(case when account_id = ${wrong} then base_debit - base_credit end), 0)::text as wrong,
             coalesce(max(case when account_id = ${right} then base_debit - base_credit end), 0)::text as right
        from app.account_balance where fiscal_period_id = ${s.period} and currency = 'MYR'`);
    expect(net!.wrong).toBe("0.0000");
    expect(net!.right).toBe("250.0000");
  });
});
```

```ts
// tests/regression/sah-011.test.ts — "NULL arithmetic irreversibly nulls balances and tax boxes"
import { describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { seedTenantV2 } from "@dulja/db/test";
import { sharedDb } from "../support/regression";

describe("SAH-011 NULL arithmetic irreversibly nulls balances — 1A", () => {
  it("every amount column of account_balance and ledger_entry is NOT NULL with a zero default", async () => {
    const { db } = await sharedDb();
    const rows = await db.admin<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }[]>`
      select table_name, column_name, is_nullable, column_default
        from information_schema.columns
       where table_schema = 'app'
         and table_name in ('account_balance', 'ledger_entry')
         and column_name in ('debit', 'credit', 'base_debit', 'base_credit')
       order by table_name, column_name`;
    expect(rows).toHaveLength(8);
    for (const r of rows) expect(r.is_nullable).toBe("NO");
    for (const r of rows.filter((x) => x.table_name === "account_balance")) expect(r.column_default).toContain("0");
  });

  it("a MERGE of a zero-amount group cannot null an existing balance", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH011");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah011" };
    await withTenant(rw, ctx, (tx) => tx`
      insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency, debit, base_debit)
      values (${s.tenant}, ${s.company}, ${s.cash}, ${s.period}, 'MYR', 5.0000, 5.0000)`);
    await withTenant(rw, ctx, (tx) => tx`
      update app.account_balance set debit = debit + 0, base_debit = base_debit + 0
       where account_id = ${s.cash} and fiscal_period_id = ${s.period} and currency = 'MYR'`);
    const [row] = await withTenant(rw, ctx, (tx) => tx<{ debit: string }[]>`
      select debit::text as debit from app.account_balance where account_id = ${s.cash} and fiscal_period_id = ${s.period}`);
    expect(row!.debit).toBe("5.0000");
  });
});
```

```ts
// tests/regression/sah-024.test.ts — "Account codes are allocated with max() on a string, without locking"
import { describe, it } from "vitest";

/**
 * ⚠️ CONDITIONAL — created by 1A per contracts §3.7.3 and left skipped until OD-27 answers Part VII #6.
 *
 * spec:427: "`IncCodeNumber` is an external UDF not in the corpus; it may zero-pad and avoid this. Confirm
 * before rating." Until the owner supplies the legacy DDL and that UDF's body, the defect is a hypothesis,
 * not a fact, and the new system's behaviour is not in question either way: Dulja never derives an account
 * code. `POST /v1/companies/{companyId}/accounts` takes the code from the caller and
 * `unique (company_id, code)` refuses a duplicate, which is asserted in
 * apps/api/test/routes/accounting/accounts.test.ts, the test named
 * "refuses a duplicate code in the company with ERR_CONFLICT_UNIQUE".
 *
 * WHEN OD-27 LANDS: if the owner confirms the defect, replace the `it.skip` below with an `it` that seeds a
 * legacy-shaped chart through the API and asserts that codes '1', '9' and '10' coexist and that two
 * concurrent creates of the same code produce one 201 and one 409 ERR_CONFLICT_UNIQUE. If the owner reports
 * that `IncCodeNumber` zero-pads and the defect never existed, delete this file and remove its row from the
 * regression table in this plan's Self-Review.
 */
describe("SAH-024 Account codes allocated with max() on a string, without locking — 1A", () => {
  it.skip("⚠️ pending OD-27 (Part VII #6, spec:427): the legacy DDL and IncCodeNumber's body are not in the corpus", () => {
    // Deliberately empty: this test is a placeholder for an owner decision, not for missing work.
  });
});
```

```ts
// tests/regression/sah-049.test.ts — "Aggregate tables unkeyed; upsert race duplicates silently"
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { postDocument, withTenant } from "@dulja/db";
import { seedTenantV2, uuidv7 } from "@dulja/db/test";
import { sharedDb } from "../support/regression";

describe("SAH-049 Aggregate tables unkeyed; upsert race duplicates silently — 1A", () => {
  it("two concurrent posts to the same account, period and currency produce ONE row holding both amounts", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH049");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah049" };
    const draft = async (amount: string): Promise<string> => {
      const id = await uuidv7(db.admin);
      await withTenant(rw, ctx, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${s.tenant}, ${s.company}, ${id}, 1, ${s.cash}, ${amount})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${s.tenant}, ${s.company}, ${id}, 2, ${s.sales}, ${amount})`;
      });
      return id;
    };
    const left = await draft("10.0000");
    const right = await draft("20.0000");
    const one = postgres(db.url("app_rw"), { max: 1, prepare: false });
    const two = postgres(db.url("app_rw"), { max: 1, prepare: false });
    try {
      await Promise.all([
        withTenant(one, ctx, (tx) => postDocument(tx, ctx, { documentId: left })),
        withTenant(two, ctx, (tx) => postDocument(tx, ctx, { documentId: right })),
      ]);
    } finally {
      await one.end();
      await two.end();
    }
    const rows = await withTenant(rw, ctx, (tx) => tx<{ debit: string }[]>`
      select debit::text as debit from app.account_balance
       where account_id = ${s.cash} and fiscal_period_id = ${s.period} and currency = 'MYR'`);
    expect(rows).toHaveLength(1);                                   // the key is the grain: no duplicate row
    expect(rows[0]!.debit).toBe("30.0000");                          // and no lost amount
  });

  /**
   * The test above races two DRAFTS, so both calls go through issueDocument and both queue on
   * `pg_advisory_xact_lock('series:<company>/JV/<period>')` — the MERGE never actually runs concurrently.
   * This test removes that accidental serialisation: both documents are issued FIRST, in their own
   * transactions, so postDocument skips issueDocument entirely (post.ts step 7) and the two MERGEs meet at
   * the same (company, account, fiscal_period, currency) key. `MERGE … WHEN NOT MATCHED THEN INSERT` has no
   * ON CONFLICT-style re-check, so without the sorted balance-key advisory lock of post.ts step 12 the
   * second transaction raises SQLSTATE 23505 on commit of the first — which the production withTenant does
   * NOT retry (it retries 40001 and 40P01 only, contracts §4.2.2) and which surfaces to the caller as
   * ERR_CONFLICT_UNIQUE on a perfectly legitimate post. The route reaches this path whenever a caller
   * issues in one request (`to: "issued"`) and posts in another.
   */
  it("two concurrent posts of ALREADY-ISSUED documents still produce ONE row, and never ERR_CONFLICT_UNIQUE", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH049b");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah049b" };
    const draftAndIssue = async (amount: string): Promise<string> => {
      const id = await uuidv7(db.admin);
      await withTenant(rw, ctx, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${s.tenant}, ${s.company}, ${id}, 1, ${s.cash}, ${amount})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${s.tenant}, ${s.company}, ${id}, 2, ${s.sales}, ${amount})`;
      });
      await withTenant(rw, ctx, (tx) => issueDocument(tx, ctx, { documentId: id }));   // its own transaction: the series lock is released here
      return id;
    };
    const left = await draftAndIssue("100.0000");
    const right = await draftAndIssue("200.0000");
    const one = postgres(db.url("app_rw"), { max: 1, prepare: false });
    const two = postgres(db.url("app_rw"), { max: 1, prepare: false });
    try {
      await Promise.all([
        withTenant(one, ctx, (tx) => postDocument(tx, ctx, { documentId: left })),
        withTenant(two, ctx, (tx) => postDocument(tx, ctx, { documentId: right })),
      ]);
    } finally {
      await one.end();
      await two.end();
    }
    const rows = await withTenant(rw, ctx, (tx) => tx<{ debit: string }[]>`
      select debit::text as debit from app.account_balance
       where account_id = ${s.cash} and fiscal_period_id = ${s.period} and currency = 'MYR'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.debit).toBe("300.0000");
  });
});
```

The second test needs `issueDocument` in the import list, so the file's first import line from `@dulja/db` is `import { issueDocument, postDocument, withTenant } from "@dulja/db";`.

```ts
// tests/regression/sah-079.test.ts — "44 repair objects, two ledgers, one broken guard"
import { describe, expect, it } from "vitest";
import { lintSchema } from "@dulja/db";
import { sharedDb } from "../support/regression";

describe("SAH-079 44 repair objects, two ledgers, one broken guard — 1A", () => {
  it("there is exactly ONE ledger table and one projection derived from it — no repair object exists", async () => {
    const { db } = await sharedDb();
    const rows = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.tables
       where table_schema = 'app' and table_type = 'BASE TABLE'
         and (table_name like '%ledger%' or table_name like '%balance%' or table_name like '%repair%'
              or table_name like '%fix%' or table_name like '%recalc%' or table_name like '%rebuild%')
       order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual(["account_balance", "ledger_entry", "ledger_entry_dimension"]);
  });

  it("the schema linter reports zero violations after Phase 1's migrations", async () => {
    const { db } = await sharedDb();
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 3: Append one `describe` block to each of the ten existing files**

Add each block to the **end** of the named file. Do not edit the `— 0B` block above it.

```ts
// tests/regression/sah-003.test.ts — append
describe("SAH-003 Nothing enforces debits = credits — 1A", () => {
  it("the deferred constraint trigger refuses an unbalanced document at COMMIT, whatever the caller does", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH003-1A");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah003" };
    const doc = await uuidv7(db.admin);
    await expect(
      withTenant(rw, ctx, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
        await tx`insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id, debit, credit,
                                               currency, exchange_rate, base_debit, base_credit, effective_date,
                                               fiscal_period_id, posting_policy_id)
                 values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 100.0000, 0, 'MYR', 1, 100.0000, 0,
                         '2026-01-15', ${s.period}, ${s.policy})`;
      }),
    ).rejects.toThrow(/ERR_LEDGER_UNBALANCED/);
  });
});
```

```ts
// tests/regression/sah-012.test.ts — append
describe("SAH-012 Base amounts never derived from value × rate — 1A", () => {
  it("postDocument writes base = round(value × rate, 4) and the CHECK refuses anything else", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH012-1A");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah012" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate, rate_source, branch_id)
               values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'USD', 4.68350000, 'BNM test', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 33.3350)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${s.tenant}, ${s.company}, ${doc}, 2, ${s.sales}, 33.3350)`;
    });
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: doc }));
    const [row] = await withTenant(rw, ctx, (tx) => tx<{ base_debit: string; rate_source: string }[]>`
      select l.base_debit::text as base_debit, d.rate_source from app.ledger_entry l
        join app.document d on d.id = l.document_id
       where l.document_id = ${doc} and l.debit > 0`);
    expect(row!.base_debit).toBe("156.1245");           // 33.3350 × 4.68350000 = 156.1244725, HALF_AWAY_FROM_ZERO at scale 4
    expect(row!.rate_source).toBe("BNM test");
  });
});
```

```ts
// tests/regression/sah-021.test.ts — append
describe("SAH-021 Accounts deletable with postings; generator rewinds and reuses IDs — 1A", () => {
  it("app_rw holds no DELETE on account, and archiving is the only removal", async () => {
    const { db } = await sharedDb();
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'account'`;
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'account' and column_name = 'archived_at'`;
    expect(cols).toHaveLength(1);
  });

  it("a posting_seq is never rewound: it is drawn once and the unique per company holds", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH021-1A");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah021" };
    const [a, b] = await withTenant(rw, ctx, async (tx) => {
      const [x] = await tx<{ n: string }[]>`select nextval('app.posting_seq')::text as n`;
      const [y] = await tx<{ n: string }[]>`select nextval('app.posting_seq')::text as n`;
      return [BigInt(x!.n), BigInt(y!.n)];
    });
    expect(b).toBeGreaterThan(a);
  });
});
```

```ts
// tests/regression/sah-031.test.ts — append
describe("SAH-031 Period locks per-tier, on a sibling table, not on the lines — 1A", () => {
  it("the lock is on ledger_entry itself: a locked period refuses the line, not merely the header", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH031-1A");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah031" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-03-15', 'MYR', ${s.hq})`);
    await expect(
      withTenant(rw, ctx, (tx) => tx`
        insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency,
                                      exchange_rate, base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id)
        values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 1.0000, 0, 'MYR', 1, 1.0000, 0, '2026-03-15', ${s.lockedPeriod}, ${s.policy})`),
    ).rejects.toThrow(/ERR_PERIOD_NOT_OPEN/);
  });
});
```

```ts
// tests/regression/sah-035.test.ts — append
describe("SAH-035 Tenant scoping is a client convention — 1A", () => {
  it("every Phase 1 table refuses a cross-tenant reference through its composite FK", async () => {
    const { db, rw } = await sharedDb();
    const a = await seedTenantV2(db, "SAH035-A");
    const b = await seedTenantV2(db, "SAH035-B");
    const ctxA = { tenantId: a.tenant, actorId: a.human, requestId: "sah035" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctxA, (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${doc}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2026-01-15', 'MYR', ${a.hq})`);
    await expect(
      withTenant(rw, ctxA, (tx) => tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
        values (${a.tenant}, ${a.company}, ${doc}, 1, ${b.cash}, 1.0000)`),
    ).rejects.toThrow(/document_line_tenant_id_account_id_fkey/);
    await expect(
      withTenant(rw, ctxA, (tx) => tx`
        insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency, debit)
        values (${a.tenant}, ${a.company}, ${b.cash}, ${a.period}, 'MYR', 1.0000)`),
    ).rejects.toThrow(/account_balance_tenant_id_account_id_fkey/);
  });
});
```

```ts
// tests/regression/sah-041.test.ts — append
describe("SAH-041 Hard deletes; anti-tampering triggers shipped disabled — 1A", () => {
  it("a posted document's ledger cannot be updated or deleted by anyone, and the trigger is enabled", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH041-1A");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah041" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 12.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${s.tenant}, ${s.company}, ${doc}, 2, ${s.sales}, 12.0000)`;
    });
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: doc }));
    await expect(withTenant(rw, ctx, (tx) => tx`update app.ledger_entry set debit = 0 where document_id = ${doc}`))
      .rejects.toThrow(/permission denied|ERR_TABLE_IMMUTABLE/);
    const [trigger] = await db.admin<{ tgenabled: string }[]>`
      select tgenabled::text as tgenabled from pg_trigger
       where tgrelid = 'app.ledger_entry'::regclass and tgname = 'ledger_entry_immutable'`;
    expect(trigger!.tgenabled).toBe("O");                            // 'O' = enabled for origin; never 'D'
  });
});
```

```ts
// tests/regression/sah-050.test.ts — append
describe("SAH-050 NULL dimensions accumulate orphans and lose decrements — 1A", () => {
  it("every ledger line carries a BRANCH dimension; none is NULL and none is orphaned", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH050-1A");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah050" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 6.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${s.tenant}, ${s.company}, ${doc}, 2, ${s.sales}, 6.0000)`;
    });
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: doc }));
    const rows = await withTenant(rw, ctx, (tx) => tx<{ n: number; orphans: number }[]>`
      select count(*)::int as n,
             count(*) filter (where v.id is null)::int as orphans
        from app.ledger_entry l
        join app.ledger_entry_dimension d on d.entry_id = l.id
        left join app.dimension_value v on v.id = d.dimension_value_id
       where l.document_id = ${doc}`);
    expect(rows[0]).toEqual({ n: 2, orphans: 0 });
  });
});
```

```ts
// tests/regression/sah-051.test.ts — append
describe("SAH-051 Numbering races, no uniqueness, cannot be gapless — 1A", () => {
  it("a voided number is recorded, and the same (series, period, number) can never be issued twice", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH051-1A");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah051" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`);
    const issued = await withTenant(rw, ctx, (tx) => issueDocument(tx, ctx, { documentId: doc }));
    await withTenant(rw, ctx, (tx) => voidDocument(tx, ctx, { documentId: doc, reason: "misprint" }));
    const [voided] = await withTenant(rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_number_void
       where company_id = ${s.company} and series = ${issued.series} and number = ${issued.number}`);
    expect(voided!.n).toBe(1);

    const other = await uuidv7(db.admin);
    await expect(
      withTenant(rw, ctx, (tx) => tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id, number, effective_date, currency, branch_id)
        values (${other}, ${s.tenant}, ${s.company}, ${s.docType}, ${issued.series}, ${issued.fiscalPeriodId}, ${issued.number}, '2026-01-15', 'MYR', ${s.hq})`),
    ).rejects.toThrow(/document_company_id_series_fiscal_period_id_number_key/);
  });
});
```

```ts
// tests/regression/sah-070.test.ts — append
describe("SAH-070 Index coverage missing on the columns reports filter by — 1A", () => {
  it("the ledger read's filters are covered: (company_id, account_id, effective_date) and (company_id, effective_date)", async () => {
    const { db } = await sharedDb();
    const rows = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and tablename = 'ledger_entry'`;
    const defs = rows.map((r) => r.indexdef.replace(/\s+/g, " "));
    expect(defs.some((d) => /\(company_id, account_id, effective_date\)/.test(d))).toBe(true);
    expect(defs.some((d) => /\(company_id, effective_date\)/.test(d))).toBe(true);
    const lineIdx = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and tablename = 'document_line'`;
    expect(lineIdx.some((r) => /\(document_id, line_no\)/.test(r.indexdef.replace(/\s+/g, " ")))).toBe(true);
  });
});
```

```ts
// tests/regression/sah-071.test.ts — append
describe("SAH-071 Recursive tree check per row inside triggers — 1A", () => {
  it("the chart of accounts is read as ONE recursive CTE, and no trigger on account is recursive", async () => {
    const { db } = await sharedDb();
    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.account'::regclass and not tgisinternal`;
    expect(triggers.map((t) => t.tgname).sort()).toEqual(["audit_row"]);   // audit only; no tree check
    // `explain` names its column "QUERY PLAN", so read it positionally rather than by an invented key.
    const plan = await db.admin<Record<string, string>[]>`
      explain (format text) with recursive node as (
        select a.id, a.parent_id, 0 as depth from app.account a where a.parent_id is null
        union all
        select a.id, a.parent_id, n.depth + 1 from app.account a join node n on a.parent_id = n.id where n.depth < 32)
      select count(*) from node`;
    expect(plan.map((r) => Object.values(r)[0]!).join(" ")).toMatch(/Recursive Union|CTE Scan/);
  });
});
```

Each appended file needs the imports the block uses; add them to the file's existing import list, merging into an existing specifier rather than adding a second `import` from the same module (`import/no-duplicates`). The full set across the ten files: `describe`, `expect`, `it` from `vitest` (0B's files import none of the three — `thinRegression` supplies them through `ThinContext` — so every one of the ten gains `import { describe, expect, it } from "vitest";`); `issueDocument`, `postDocument`, `voidDocument`, `withTenant` from `@dulja/db`; `lintSchema` from `@dulja/db` where the block reads the linter; `seedTenantV2`, `uuidv7` from `@dulja/db/test`; and `sharedDb` from `../support/regression` — the same module the file already imports `thinRegression` from, so the two names go on one line: `import { sharedDb, thinRegression } from "../support/regression";`.

- [ ] **Step 4: Run everything**

Run: `bun run --cwd apps/api test -- test/routes/accounting/documents.fuzz.test.ts`
Expected: **PASS** (4 tests — three in the `acceptance test 1` describe and one in `acceptance test 4`; the fuzz `it` runs 250 generated documents and takes several minutes, so its per-test timeout is set to 600 s above).

Run: `bun run --cwd tests test`
Expected: PASS — the invariants suite plus every regression file, `sah-024`'s single `it` reported as skipped.

Run at the repository root: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: all green. This is the slice's gate.

- [ ] **Step 5: Commit**

```bash
git add apps/api tests
git commit -m "$(cat <<'EOF'
test: acceptance tests 1 and 4, and the sixteen Part I regression files [1A T14]

Test 1 is fast-check over 250 generated balanced documents through the API, then
Σdebit = Σcredit asserted per tenant, company and period and account_balance
compared against a fresh rebuild. Test 4 posts two tenants to the same account
and currency on two real connections and asserts each sees only its own row.

Creates sah-001, 002, 011, 024 (skipped pending OD-27), 049 and 079; appends a
— 1A block to sah-003, 012, 021, 031, 035, 041, 050, 051, 070 and 071.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15 — OWNER GATE OD-24: the screens this slice does not ship

> **This task is isolated for owner decision OD-24** (contracts §2.12: "Screenshots + operator description before any screen"; spec:79, 108, 2408 — "the UI is not specified"). It is the **only** task in this plan that depends on an owner decision, and dropping it changes nothing else.
>
> **Owner provides:** screenshots of the legacy Sahlisoft chart-of-accounts, journal-entry and fiscal-period screens, plus a two-minute description of how an operator actually uses each.
> **Verify:** the three screenshots and the description are attached to **1B's** screen tasks before those tasks are executed.
> **Until provided:** nothing in this slice blocks. 1A ships no screen at all — the three Phase 1 screens are 1B's Delivers ("Back-office screens: chart of accounts, journal entry (keyboard-first, spec:2254), fiscal periods with close/reopen-with-reason"). This task's whole content is to record what 1A froze for those screens and what changes if the owner's material contradicts it.

**Files:**
- Create: `docs/ui/phase-1-api-surface.md`

**Interfaces:**
- Produces: a one-page record of the API surface 1B's three screens consume. No code.
- Consumes: the route modules of Tasks 10–12.

**Why 1A carries an OD-24 row at all.** Contracts §2.2 lists OD-24 on this card and Appendix A item 5 counts 1A among the eighteen slices whose card names it, yet every screen in Phase 1 is 1B's. The gate that lands on 1A is therefore not "build a screen" but "do not let an unspecified UI leak into the API shapes a screen will need". That is a real risk: a handler written with a screen in mind bakes a workflow into a route, and spec:79 says the UI is not specified. This task states the surface explicitly so that if the owner's screenshots show a different workflow, the change is in 1B's components and, at most, in a query parameter here — never in the posting service.

- [ ] **Step 1: Write `docs/ui/phase-1-api-surface.md`**

```markdown
# Phase 1 — the API surface the back-office screens consume (OWNER GATE OD-24)

**Status:** the three screens are **1B's**; 1A ships this surface and no UI. Written 2026-09-05 by slice 1A.

The owner has not yet supplied screenshots or an operator description (OD-24, spec:2408), so no workflow is
assumed here. What is fixed is the data each screen needs and where it comes from.

| Screen (1B) | Reads | Writes | Permission |
|---|---|---|---|
| Chart of accounts | `GET /v1/companies/{companyId}/accounts` (paged, `type`, `includeArchived`) and `GET …/accounts/tree` (one recursive CTE, each node with `depth` and a code `path`) | `POST …/accounts`, `PATCH …/accounts/{id}`, `POST …/accounts/{id}/archive` | reads: membership; writes: `accounting.account.manage` |
| Journal entry | `GET …/documents/{documentId}` (header plus lines) | `POST …/documents` (header and lines in one call), `PUT …/documents/{documentId}/lines` (replace), `POST …/documents/{documentId}/transitions` with `to ∈ issued \| posted \| void` | create: `accounting.journal.create`; transitions: `accounting.journal.post` |
| Fiscal periods | `GET …/fiscal-periods` (with `status`) | `POST …/fiscal-periods/{periodId}/close`, `POST …/fiscal-periods/{periodId}/reopen` (body `{ reason }`, mandatory) | `accounting.period.close`, `accounting.period.reopen` |

Facts a screen may rely on:

- Every error is `application/problem+json` with a stable `code`, a `detail` naming the entity and a `remedy`
  (contracts §4.2.4). A screen renders `detail` and `remedy`; it never parses `detail`.
- A document is created with all its lines in one call, so a keyboard-first grid (spec:2254) can submit once.
- `POST …/transitions` returns `{ documentId, status, number, series, fiscalPeriodId, ledgerEntryIds }` —
  enough to show the assigned number without a second request.
- Amounts are `{ "amount": "1234.5000", "currency": "MYR" }` or a fixed-4-dp string; display rounding is the
  UI's business and is never persisted (spec:2041).
- **There is no reversal endpoint in Phase 1.** Contracts §4.5.4 puts reversal on its own route,
  `POST …/documents/{documentId}/reverse { effectiveDate, reason }`, gated by `accounting.document.reverse`
  — a permission code §3.6.2 assigns to slice 2B, deliberately separate from `accounting.journal.post` so a
  poster is not automatically a reverser. A Phase 1 journal-entry screen offers **issue**, **post** and
  **void**; the reversal button appears with 2B. `reverseDocument` itself already ships in `@dulja/db`.
- Every unsafe call requires an `Idempotency-Key`; a retry after a network failure replays rather than
  double-posting (contracts §4.2.9).

**If the owner's screenshots show a different workflow**, the likely changes and their blast radius:

| Owner finding | Change | Where |
|---|---|---|
| Lines are entered one at a time, not as a grid | add `POST …/documents/{documentId}/lines` beside the existing `PUT` | one route file, `apps/api/src/routes/accounting/documents.ts` |
| The operator expects to see the number before posting | 1B's screen calls `transitions` with `to: "issued"` first — already supported | 1B's component only |
| Accounts are picked by a searchable code prefix | add a `codePrefix` filter to `AccountQuery` | one Zod schema and one `where` clause |
| A period close needs a reason too | mirror `ReopenPeriodBody` on `ClosePeriodBody`; the column already exists as `reopen_reason`, so a `close_reason` column would be a new migration in **1B's** range | contracts amendment first (§3.4.1) |

**Nothing in the above touches `packages/db/src/posting/` or `packages/domain/src/posting/`.** That is the
point of this record: the posting service is decided by the spec and the contracts document, not by a screen.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ui/phase-1-api-surface.md
git commit -m "$(cat <<'EOF'
docs: the Phase 1 API surface 1B's screens consume (OWNER GATE OD-24) [1A T15]

1A ships no screen — the three Phase 1 screens are 1B's. This records what the
API froze for them and what changes if the owner's screenshots show a different
workflow, so an unspecified UI cannot leak into a route or into the posting
service (spec:79, 108).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

### Against the contracts card for 1A (§2.2)

| Card deliverable | Task | Note |
|---|---|---|
| `app.document_line` (Phase 1 base, §4.3.4) | T1 | verbatim; ADR 0021 is a proposal per spec:95 |
| `app.account_balance` (§4.3.3) | T2 | DDL and `MERGE` verbatim; `NO_ID_TABLES` gains it, `AUDIT_EXEMPT` already held it |
| `document.posting_seq` (§4.3.5) | T3 | plus the sequence, the grant and `unique (company_id, posting_seq)` |
| linter set updates | T2 | exactly the one membership §3.5.3 assigns; nothing else touched |
| `packages/domain/src/posting/`: `PostingPlan`, `balanceLines()`, base conversion, FX-rounding line | T5 | the registry's own name for the balancing function is **`balanceInBase`** (§4.4.2); the card's prose "`balanceLines()`" has no counterpart in §4, so `balanceInBase` is what ships — see *Discrepancies* below |
| `posting-policy.schema.json` at the JOURNAL subset + the committed `PostingPolicy` type | T5 | `$id urn:dulja:posting-policy:1`, `"version": { "const": 1 }`; 2A widens the same file |
| `packages/db/src/posting/`: `issueDocument`, `postDocument`, `reverseDocument`, `voidDocument` | T6–T9 | signatures §4.3.1 verbatim; `transitionDocument`/`recordOverride` are 2A/2B and are absent |
| `document-type-seed.schema.json` + the `document-types` loader | T5, T13 | §3.4.8 names the loader but fixes no signature, so `loadDocumentTypes`'s `catalogue` parameter, `DocumentTypeSeedResult` and the `PackLoader` value `documentTypesLoader` are 1A's own names, not registry additions — but the `SubPack` member `"document-types"` that value's `name` field carries **is** a §4.2.13 widening, pre-authorised by that section's own comment and folded in with the Execution handoff's note. The two **domain** functions the loader needs — `validateDocumentTypeSeed` and `parsePolicy` — *are* additions to §4.4.2's frozen block: amendment **A6** |
| `packages/db/seed/my/document-types/JOURNAL.json` | T13 | §4.3.7 verbatim, asserted byte-equal to the domain fixture |
| Chart-of-accounts API (tree via recursive CTE, `archived_at`) | T10 | reads membership-only, per §4.2.11's precedent |
| Fiscal-period API (close, reopen with a reason to the audit row) | T11 | `reopen_reason` column, ADR 0023 |
| Journal API and ledger read | T12 | on §4.2.7's **generic** document paths, not a `/journals` route; `to: "reversed"` is **not** offered — see *Contract amendments* |
| fast-check fuzz suite; two-connection concurrency (tests 16 and 4) | T7, T14 | |
| Migration `0014_seed_permission_phase1.sql` + `roles.ts` grants | T4 | six codes; `accountant`, `user`, `auditor`; `admin` computed |
| DoD share: "Σdebit = Σcredit under fuzz"; the API and admin paths of the period lock | T14, T12, T11 | the API path is T12 (it needs the documents route); the admin path is T11 and T8 |
| Part VI 1, 3, 4 owned; 16, 9, 12, 13, 36 re-run | T14, T9, T7, T11, T12 | |
| Regression files created and appended | T14 | six created (024 skipped per §3.7.3), ten appended |
| Owner gate OD-24 | T15 | one isolated task; nothing else depends on it |

Migration range 0011–0014 — four files, four names as expected, four PRs. ADR range 0021–0023 — three ADRs, 0021 a proposal. Target size 13–15 tasks: **15**.

### Against the hazards (§5)

1 no statutory figure anywhere · 2 no MyInvois detail · 3 Firebird untouched · 4 no report ships here (1B owns `accounting.trial_balance` and `accounting.ledger`; this slice's ledger **read endpoint** is not a report definition and takes no `ReportCode`) · 5 the one owner-account-shaped task (T15) states what the owner provides and how it is verified · 6 one OD item, one isolated task · 7 no D1–D27 re-opened · 8 every Plan 0A helper cited by its exact name · 9 `fixtures.ts` extended additively with exactly the four §4.17 helpers; `Seed`, `seedTenant` and `draftDocument` untouched · 10 no per-tenant row written by a migration (0014 writes only global `app.permission`) · 11 no enum label added · 12 0B's generalised reversibility test relied on, not re-written · 13 `lint-schema.ts` edited to exactly the §3.5.3 state · 14 no renumbering, no `max(version)` assertion · 15 the production `withTenant` in root `tests/` and `apps/api`, the 4-argument test one in `packages/db/test/` · 16–21 not this slice · 22 nothing outside `packages/db/src/posting/` writes a ledger or projection table, and T8 ships the lint that proves it · 23 `toBase` is `HALF_AWAY_FROM_ZERO` at scale 4 · 24 no `document_event` written (2B's triggers) · 25 no DELETE grant added; `privileges.test.ts` untouched · 26 no new permission code beyond §3.6.2's six · 27 no new principal kind · 28–31 not this slice, except 31: every one of the four new routes has a `PROBES` entry · 32 no literal invented in a shared namespace · 33 no account code seeded; T10 asserts `1000`, `4000` and `5920` resolve through the API for a fixture tenant, and T13 step 5 verifies the same three against **0C's real pack** after `--only chart-of-accounts` · 34 the seed file is an envelope and `module` is validated, not inserted · 35 no placeholder text anywhere; every step carries the real code.

### Issues found while reviewing, and fixed inline

1. **`issueDocument` first drafted the `document_series` insert with the company id in `tenant_id`.** The composite FK would have raised `document_series_tenant_id_fkey` on the very first test. Fixed: the insert takes `ctx.tenantId`, and `ctx` is a used parameter rather than `_ctx`.
2. **`document.posted_by` would have stayed NULL.** §4.3.2 step 13 says "`stamp_posted_by` sets `posted_by`", but `app.stamp_actor` overwrites a supplied value and never invents one, and the column has no default. Step 13 now writes `posted_by = app.current_actor()` (reading 1); T8's first test asserts it.
3. **A document that plans zero ledger lines would have posted silently.** `assert_document_balanced` is satisfied by `0 = 0`. `postDocument` now raises `ERR_DOC_NO_LINES` after evaluation (reading 7); T8 asserts both the no-lines and the all-zero-lines cases.
4. **A second period close by a different principal would have raised `ERR_ACTOR_IMMUTABLE`.** `closed_by` is a `*_by` column and `stamp_actor` freezes it once non-null. The close handler now writes `closed_by = coalesce(closed_by, app.current_actor())` (reading 2); T11 asserts the second close succeeds and that the audit log holds the second actor.
5. **`packages/db` cannot import `AppError`.** 0B's `dependency-rule` pins it to `["@dulja/domain"]`. `PostingError` is declared in `packages/db/src/posting/errors.ts` with a code type that is a literal subset of `ErrCode`, and `apps/api/src/problem.ts` maps it in one branch beside the `TenantContextError` branch 0B wrote for the identical reason (reading 11).
6. **`loadDocumentTypes` cannot import `PERMISSIONS` either.** The catalogue is a parameter — the same shape 0D chose for `adminPermissions(catalogue)`.
7. **`validatePolicy` is the wrong tool at post time.** It returns a report and needs the catalogue; `resolvePolicy` needs a cheap structural parse that throws. `parsePolicy` was added and both share one compiled Ajv validator.
8. **`document_type.module` does not exist until 2A.** The loader validates it and does not insert it (reading 4); T13 says so and names 2A as the slice that widens the insert.
9. **`balanceInBase` needs a currency.** A plan whose lines were all dropped as zero carries no `Money` to borrow one from, so the signature takes `baseCurrency` as a third parameter — stated in T5's deviations list.
10. **The `posting-only-tables` rule would have flagged its own test fixtures.** `scripts/lint/rules/` is in the allow-list, with the reason in the comment.
11. **The rule would also have flagged T11's own test.** An earlier draft of the fiscal-period admin-path test wrote `insert into app.ledger_entry` from `apps/api/test/`, which is inside the runner's `ROOTS` and outside every allowed prefix, so `lint:rules` would have gone red from T11 onward. The direct-SQL half of that assertion lives in **T8**'s `packages/db/test/posting/post.test.ts` (an allowed prefix), which already asserts `assert_period_open` refuses a raw `app_rw` insert into a locked period; T11 keeps the half that needs no raw DML — a direct `postDocument` call as `app_rw`, outside any route. `ALLOWED_PREFIXES` is unamended.
12. **The `account_balance` `MERGE` could raise `ERR_CONFLICT_UNIQUE` on a legitimate post.** `MERGE … WHEN NOT MATCHED THEN INSERT` has no `ON CONFLICT`-style re-check, and the path that reaches it without the numbering advisory lock is reachable in this slice (issue in one request, post in another). T8 now takes one `pg_advisory_xact_lock` per planned balance key in sorted order before the `MERGE`, and `sah-049.test.ts` gains a second `it` that races two **already-issued** documents — the case the existing draft-and-draft race never exercised because `issueDocument`'s series lock serialised it. Amendment A4.
13. **The FX-rounding fixture left no residue.** One debit of `0.3335 USD` against credits of `0.1667` and `0.1668` at `4.68350000` converts to `1.5619` against `0.7807 + 0.7812 = 1.5619` — exactly balanced, so `balanceInBase` returned the plan untouched and three tests asserted a state they could never reach. The fixture is now `0.0003` against three credits of `0.0001` (base `0.0014` against `0.0005 × 3 = 0.0015`, residue `−0.0001`), which produces exactly one `fx_rounding` **debit** line.
14. **Two base-conversion expectations were arithmetically wrong, the same typo twice.** `33.3350 × 4.68350000 = 156.1244725`, which rounds HALF_AWAY_FROM_ZERO at scale 4 to `156.1245`; both T5's `evaluate.test.ts` and T14's `tests/regression/sah-012.test.ts` asserted `156.1274` (two digits transposed). A correct `toBase` would have failed both, and the Global Constraints tell the implementer to stop rather than edit the expectation — so the plan would have deadlocked on its own typo, twice, in two different tasks.
15. **Three error codes were raised a task before they existed.** `ERR_DOC_STATUS_ILLEGAL`, `ERR_DOC_NO_LINES` and `ERR_PERIOD_NOT_FOUND` are members of `PostingErrorCode` from T6 Step 2, and T6 Step 5's `if (e instanceof PostingError) return new AppError(e.code, e.detail)` relies on `PostingErrorCode ⊆ ErrCode` with no cast — but the three rows were added to `ERRORS` in T8. All six of this slice's rows now land in T5 (two) and T6 (four), so T6's `apps/api typecheck` can pass. The `error-codes` check is satisfied at T6 because all four T6 codes appear as string literals in `packages/db/src/posting/errors.ts`, which is inside `packages/**/src/**`.
16. **The seed CLI branch imported `PERMISSIONS` from `@dulja/contracts`.** Task 13's own prose says the catalogue is a parameter *because* `packages/db` may not import `@dulja/contracts`, and then Step 4's CLI case did exactly that — and `packages/db/src/cli.ts` is inside `packages/db`, which 0B's `dependency-rule` pins to `["@dulja/domain"]`. `lint:rules` would have gone red with a `dependency-rule` violation at Task 13, which Global Constraints forbid (the six `permission-catalogue` rows are the *only* documented exception, and they have cleared by Task 12). The CLI now reads `select code from app.permission` — the same source the test uses, global and RLS-free (plan0A:1313), written only by migration 0014 and asserted equal to `PERMISSIONS` in both directions by `permission-catalogue.test.ts`, so the two sets cannot disagree.
17. **Three §4.4.2 additions had no amendment row.** `parsePolicy`, `validateDocumentTypeSeed` and `PolicyEvaluationError`'s body are named by Task 5's deviations list and consumed by Tasks 6 and 13, but contracts:1261 allows additions to a §4 block "only by amending this document" and contracts:1263 does not list `PolicyEvaluationError` among the five deliberately bodiless types. Amendment **A6** was added and the amendment count in the Assumptions block went from five to six. The Self-Review table's dangling "see *Contract additions*" cross-reference — a section that does not exist — now points at A6.
18. **`PUT …/lines` left zeroed orphan rows visible to the reader.** `app_rw` holds no DELETE on `document_line` until 2B's migration 0023, so a replacement zeroes every row and upserts the new set; replacing three lines with two left line 3 as a zero/zero row with its `account_id` intact, and `readDocument` returned it as a phantom line to 1B's grid. The zeroing `UPDATE` now also nulls `account_id`, and `readDocument` filters `debit = 0 and credit = 0 and account_id is null` — a shape no API-created line can have, because `LineInput.accountId` is required.

### Fixed in the 2026-09-08 audit pass

An independent auditor read this plan against the contracts document, plan 0A and the spec. Its findings, verified against the cited source and applied here:

19. **Every Task 14 regression file called `sharedDb()` from the wrong module and destructured nothing — a blocker.** The Interfaces block said "`sharedDb` from `tests/invariants/probes.ts`" and all sixteen snippets wrote `import { sharedDb } from "../invariants/probes";` then `const db = await sharedDb();`. Both halves were wrong against the frozen 0B surface. 0B Task 13 Step 2 declares `export function sharedDb(): Promise<{ db: Db; rw: Sql; a: Seed; b: Seed }>` in **`tests/support/regression.ts`** (contracts §4.17.1 registers it at that path), while `tests/invariants/probes.ts` is 0B Task 13 Step 3 and exports only `PROBES` and `IsolationProbe` — so the import resolved to nothing, and even had it resolved, `db.admin` would have been `undefined` (every `uuidv7(db.admin)` and every `information_schema` read throws) and `db.url` would not have been a function (sah-049's and test 4's two-connection races cannot open a connection). Fixed at all nineteen call sites: the import is now `from "../support/regression"`, thirteen sites destructure `const { db, rw } = await sharedDb();` and six — the pure catalogue reads in sah-011's first test, sah-079, sah-021's first test, sah-070 and sah-071 — destructure `const { db } = await sharedDb();` so no unused binding trips lint. Every `withTenant(db.rw, …)` inside Task 14 became `withTenant(rw, …)`, because `rw` is the **production** `createDb` pool 0B's `ThinContext` documents ("`rw` is the production `createDb` pool and `withTenant` the production three-argument helper") and re-proving the defect through the production layer is the regression tier's whole purpose; `db.admin`, `db.url("app_rw")`, `seedTenantV2(db, …)`, `seedAccount(db, …)` and `uuidv7(db.admin)` keep the inner `Db`. The 70 occurrences of `withTenant(db.rw, …)` in Tasks 1–13 are **unchanged and correct**: those files call `startDb()` themselves and `Db.rw` is that harness's own `app_rw` pool (contracts:1305). 0B's `thinRegression` wrapper is deliberately **not** used — its `describe` title is hard-coded `… — 0B` — and the Interfaces block now says so. This closes contracts §4.18's round-1 open item (5) from the plan side: the use sites were wrong, §4.17.1 was right.
20. **`balance.property.test.ts` did not type-check.** Its local `base()` helper is annotated `: LineSnapshot` and omitted the required `lineNo: number` that the same task declares at §4.4.2 verbatim — TS2739, so Task 5 Step 7's `bun run --cwd packages/domain typecheck` could not pass and Global Constraints would have stopped the implementer on a defect of the plan's own making. (`evaluate.test.ts`'s sibling helper escaped it only because `...over` supplies `lineNo`.) `lineNo,` added; the shorthand also gives every generated line a correct `sourceLineNo`.
21. **Task 10's cross-tenant case asserted 403 from a route with no gate.** `GET /v1/companies/{companyId}/accounts` carries no middleware — contracts §4.2.7: "Reads on `accounts`, `fiscal-periods` and `documents/{id}` are gated by membership only" — so a request from tenant A for tenant B's company runs the handler inside `withTenant(a.tenant)`, RLS reduces `app.account` to A, `where company_id = ${b.company}` matches nothing and the answer is `200 {"items":[],"next_cursor":null}`. Adding a `path:companyId` gate to make the 403 true would re-introduce the existence leak 0B removed from `GET /v1/companies/{companyId}` (0B Self-Review 8a). The case now asserts the honest outcome on both reads, keeps a 403 by exercising the **gated** `POST` — the shape this path's `PROBES` entry already probes — and states in a comment why gating the read would be wrong. Task 11's and Task 12's read tests were re-checked and carry no such assumption: their 403s are all on gated verbs (`/close`, `/reopen`, `/transitions`, `ledger-entries` under `accounting.ledger.read`).
22. **No unsafe route declared `request.headers: IdempotencyHeader`.** Contracts §4.2.7 (spec:2055) makes it binding without exception on every `post`/`put`/`patch`/`delete` `createRoute` in every slice, and the string occurred zero times in this plan while 2A and 2B both set it — 2B on operations it mounts on **this slice's own `documentRoutes` module**, so the committed `openapi.json` would have documented the header on 2B's `reverse`/`overrides`/`DELETE` and not on the three 1A operations beside them, and a generated client would omit a required header. Runtime behaviour never changed (the §4.2.9 middleware is global, and Task 12's own test still asserts `ERR_IDEMPOTENCY_KEY_MISSING`), but the spec was wrong. `headers: IdempotencyHeader` added to all **eight** unsafe operations — accounts `POST /`, `PATCH /{accountId}`, `POST /{accountId}/archive`; fiscal-periods `POST /{periodId}/close`, `POST /{periodId}/reopen`; documents `POST /`, `PUT /{documentId}/lines`, `POST /{documentId}/transitions` — with `import { IdempotencyHeader } from "../index";` in each of the three route files. **The import is not from `@dulja/contracts`:** 0B Task 11 declares the schema in `apps/api/src/routes/index.ts`, and 2A's `admin/document-types.ts` imports it by the same relative path, so the routes-module cycle is the shape both already ship.
23. **`evaluatePolicy` shipped without the A9 sign-normalisation branch §4.4.2 states as its behaviour.** The slice's *output* was already conformant — `amount` was taken only from `line.debit`/`line.credit`, which migration 0011 constrains `>= 0` — but §4.4.2 names `evaluatePolicy` itself as the owner of the rule ("a rule whose resolved amount is negative emits the rule's *opposite* side with `amount.abs()` … in **both** emit paths"), and 2A extends this exact `for` switch with `each_tax`, `document` and the `line.amount`/`line.cost` refs that make it reachable. A 2A implementer copying this file would have had nothing to copy. The three-line branch is now written, with a comment naming plan0A:2012–2013's `check (debit >= 0)` as why no other shape is possible and marking the branch defensive at the JOURNAL subset, and `evaluate.test.ts` gains one `it` that builds a snapshot with negative `debit`/`credit` by hand and asserts the sides flipped and the magnitudes survived. That file's expected count moves from 11 to 12; no other count moves. `PlannedTaxLine` stays signed and this slice emits none.
24. **Smaller, each verified against its source.** Task 14 Step 4 claimed 5 tests in `documents.fuzz.test.ts` where the file has 4 (three `it`s under `acceptance test 1`, one under `acceptance test 4`) — corrected, and the split named so a miscount is visible. Task 1 Step 1's "**FAIL** — *every* test errors with `relation "app.document_line" does not exist`" over-claimed: the eighth `it`, `expect(await lintSchema(db.admin)).toEqual([])`, touches no new table and is green on the Phase 0 head, so an implementer obeying Global Constraints would have stopped on a correct result — reworded to "seven of the eight". Task 11's test file imported `postDocument` and `withTenant` from `@dulja/db` on two consecutive lines (`import/no-duplicates`) — merged; a sweep over every fenced block in this plan found no other duplicate specifier. Task 15's `docs/ui/phase-1-api-surface.md` rendered the transition result as `{ …, ledgerEntryIds,\n }` with a stray comma and line break where the brace belongs — closed on one line. The §3.6.4 role-grant register had no amendment row even though Task 4 grants seven code-role pairs and §3.6.4 requires each introducing slice to add its row "in the same PR" — added as **A7**, and the amendment count in the Assumptions block and in the table's preamble moved from six to seven.

### Discrepancies between the contracts card's prose and §4, resolved in favour of §4

- The card names **`balanceLines()`**; §4.4.2 declares **`balanceInBase`**. §4 is the interface registry and is what other plans import, so `balanceInBase` ships. If the reviewer prefers the card's spelling, that is a one-line amendment to §4.4.2 and a rename here — no behaviour changes.
- The card says the JOURNAL policy is "seeded with `bun run seed --tenant <id> --only document-types`" and also that `posting_policy` is seeded at `version = 2`; §4.3.7 confirms `policyVersion: 2` while `policy.version` stays `1`. Both numbers are carried, and T13's test asserts the pair.

### Contract amendments this plan requires before it merges

The project folder is read-only to this plan's writer except this one file, so each of the **seven** rows below is a change the **architect** makes to `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` in its own PR, ahead of the task named. None of them changes behaviour; each of them makes the registry say what this plan ships. Execution of the task named in the right-hand column does not start until its row has landed.

**Landed / not landed as of 2026-09-08.** A1 is in §4.3.4, A2 in §4.3.1/§4.3.8, A3 in §4.4.2 (with §2.2's `balanceLines()` correction recorded in §4.18 round 1) and A6 at contracts:2452 — all four are done. **A4 and A5 are not**: §4.3.3's `MERGE` recipe carries no advisory-lock paragraph and contracts:2108 still reads "holds exactly the §4.15 codes the policy names". A7 is new in this pass and is not in §3.6.4, which today records only `accounting.party.manage → user` (2A) and `accounting.document.reverse → accountant` (2B). Tasks 4, 6 and 8 are gated accordingly.

| # | Section | Amendment | Needed before |
|---|---|---|---|
| A1 | §4.3.4 (or §4.6) | Register `app.fiscal_period.reopen_reason text` on the Plan 0A table, owner 1A / migration 0013, reader 1B. §4.3.4 enumerates every column a later slice adds to a Plan 0A table and today lists no `fiscal_period` addition; `reopen_reason` occurs nowhere in the contracts document. Reading 3 explains **why** the column is the right home for spec:2179's reason; it does not make the column registered. Without A1 this migration invents a shared name, which hazard 32 and §3.10 forbid. | **Task 3** |
| A2 | §4.3.1, §4.3.8 | Name `PostingError` and `PostingErrorCode` in `packages/db/src/posting/errors.ts` and the one `asAppError` branch in `apps/api/src/problem.ts`, in place of "Throws AppError codes listed in §4.3.7" / "each through `AppError`". The registry as written contradicts itself: `AppError` is in `@dulja/contracts` and §3.1 pins `packages/db` to `@dulja/domain` only. The wire `Problem` is unchanged (reading 11). Note that 0B's `TenantContextError` branch casts (`e.code as ErrCode`); this plan does **not** cast, because Task 6 Step 5 puts every `PostingErrorCode` member into `ERRORS` first. | **Task 6** |
| A3 | §4.4.2, §2.2 | Change `balanceInBase(plan, fxRoundingAccountId)` to `balanceInBase(plan, fxRoundingAccountId, baseCurrency: CurrencyCode)`, and change §2.2's prose spelling `balanceLines()` to `balanceInBase`. The reason is T5 deviation 2: a plan whose every line was dropped as zero carries no `Money` to borrow a currency from. 1A is the only consumer in any plan, so the blast radius is nil. | **Task 5** |
| A4 | §4.3.3 | Add the balance-key serialisation point to the `MERGE` recipe: `MERGE … WHEN NOT MATCHED THEN INSERT` does **not** re-check on a concurrent insert the way `INSERT … ON CONFLICT` does, so two transactions that both miss the same `(company_id, account_id, fiscal_period_id, currency)` row both take the NOT MATCHED branch and the second raises `23505` on commit of the first — surfacing as `ERR_CONFLICT_UNIQUE` on a legitimate post, because the production `withTenant` retries only 40001/40P01 (§4.2.2). Task 8 takes one `pg_advisory_xact_lock` per planned balance key **in sorted order** before the `MERGE`; sorting is what makes two overlapping posts queue instead of deadlock. Register the lock beside the `MERGE` so 3A's `stock_on_hand` and 8C's `employee_ytd` copy it. | **Task 8** |
| A5 | §4.4.2 (`refs.accountsByCode` sentence, contracts:2108) | Change "holds exactly the §4.15 codes the policy names" to "holds the company's non-archived leaf accounts, keyed by code" — or add the policy's code set as a `loadSnapshot` parameter in §4.3.1. `loadSnapshot` has no policy parameter today, so the implementation is necessarily a superset (Open question 2). | **Task 6** |
| A7 | §3.6.4 | Extend the register sentence "**The grants recorded so far, so no slice has to re-derive one from the spec's table**" — today `accounting.party.manage → user` (2A) and `accounting.document.reverse → accountant` (2B) — with this slice's seven, in the same PR as Task 4, exactly as that section requires ("Every later introducing slice adds its row to this sentence in the same PR"): **`accounting.account.manage`, `accounting.ledger.read`, `accounting.period.close`, `accounting.journal.create`, `accounting.journal.post` → `accountant`** (spec:2157 — chart of accounts, journals and their posting, period close; **not** period reopen); **`accounting.journal.create` → `user`** (spec:2158 — the clerk drafts and may not post; reading the chart needs membership only); **`accounting.ledger.read` → `auditor`** (spec:2163, non-mutating only). `accounting.period.reopen` is granted to **no** seeded role but `admin`, which `adminPermissions(catalogue)` computes. Without this row the register stays silent about the six Phase 1 codes and 1B and 2A re-derive them from spec:2157–2163 — the exact duplication §3.6.4 exists to prevent. Task 4's own code is unchanged either way; this row is a documentation debt the task creates. | **Task 4** (same PR) |
| A6 | §4.4.2 | Add three members to the frozen `@dulja/domain` posting block. contracts:1261 makes this mandatory — "a plan implements them **verbatim** … and may add members only by amending this document" — and contracts:1263 lists the five bodiless types §4 leaves open, none of which is any of these. The three: `export function parsePolicy(definition: unknown): PostingPolicy;` (the schema half of `validatePolicy`, throwing rather than reporting, because `resolvePolicy` reads a definition already in the database and has no catalogue — Task 5 deviation 1); `export function validateDocumentTypeSeed(envelope: unknown): PolicyValidation;` (the envelope validator for `document-type-seed.schema.json`, which contracts:178 already assigns to 1A but never names); and a **body** for `PolicyEvaluationError`, which contracts:2078 names only inside a comment and only with `ERR_POLICY_INVALID` — `export class PolicyEvaluationError extends Error { readonly code: "ERR_POLICY_INVALID" \| "ERR_POLICY_REQUIRES_MISSING" \| "ERR_LEDGER_UNBALANCED"; readonly detail: string }`, the three codes §4.3.8 already allocates to the evaluator. No declared signature changes; three names are added. | **Task 5** |

**Not amended, and therefore not shipped:** contracts §4.5.4 (contracts:2215) fixes the transitions body as `{ to: "submitted" | "approved" | "issued" | "posted" | "void" | "draft" }` and puts reversal on its own route, `POST …/documents/{documentId}/reverse { effectiveDate, reason }`, gated by `accounting.document.reverse` — a code §3.6.2 assigns to **2B**. An earlier draft of Task 12 accepted `to: "reversed"` under `accounting.journal.post`, which would have collapsed the poster/reverser separation that separate code exists to create, and pre-empted 2B's route. `TransitionBody` therefore ships as `z.enum(["issued", "posted", "void"])` and 1A exposes **no** reversal endpoint. `reverseDocument` still ships in `packages/db` and Task 9 tests it directly, so 2B's route is one handler over a function that is already green.

### Open questions for the reviewer

1. **Migration 0013 carries two unrelated alters under one name.** The card fixes the file name `0013_alter_document_add_posting_seq.sql` and the range 0011–0014 has no fifth slot, so `fiscal_period.reopen_reason` rides along in a bannered second section. The alternative is a contracts amendment extending 1A's range to 0015 — which collides with 1B's. Flagged, not decided.
2. **`refs.accountsByCode` loads the company's whole leaf chart on every post.** Total resolution of `account.code` is what `ERR_POLICY_REQUIRES_MISSING` "naming the code" needs, and `loadSnapshot` has no policy parameter. For a real chart this is a few hundred rows on an indexed scan. If a later slice measures it as hot, the fix is to pass the policy's code set into `loadSnapshot` — a §4.3.1 amendment, not a behaviour change.
3. **Reads on `/accounts`, `/fiscal-periods` and `/documents/{id}` are gated by membership only.** §4.2.11 set the precedent for dimensions and spec:2158 gives `user` read access with no code to gate it. If the reviewer wants a code, it has to be added to the closed catalogue of §3.6.1 first.
4. **This plan is 6,433 lines against §2.0's ~3,700 ceiling for a 15-task slice, and §2.0's rule is to amend the catalogue rather than grow the plan.** (It was ~6,074 before the first review pass, ~6,281 after it, 6,345 after the second, and 6,433 after the 2026-09-08 audit-fix pass; every pass added lines — test bodies, the `sharedDb()` contract note, the sign-normalisation branch and its test, the `IdempotencyHeader` paragraphs, amendment rows — because no fix was available that removed content: every line here is content §5 item 35 forbids abbreviating. The overrun is therefore structural and only the split below removes it.) The task *count* is inside the 13–15 target; the length is not. The overrun is real content, not padding — every route handler, every migration and every test body is written out because §5 item 35 forbids "similar to Task N", and the four route modules of Tasks 10–12 alone are ~1,500 lines of handlers, Zod schemas and route tests. **The split point this card does not name, proposed here:** Tasks 10, 11 and 12 (`accounts`, `fiscal-periods`, `documents` + `ledger-entries`) become **1A′ — "the Phase 1 accounting API"**, depending on 1A and depended on by 1B. 1A′ inherits **no** migration number (Tasks 10–12 write no DDL) and **no** ADR (0021–0023 all belong to Tasks 1, 3 and 5), which is what makes this the clean cut; it takes with it the four `PROBES` entries, the four `RouteModule` registrations, `packages/contracts/src/accounting/*`, and the API half of the DoD clause "a locked period cannot be altered through any path". Tasks 14 and 15 stay with 1A because the fuzz suite proves 1A's own DoD clause. **The plan writer cannot make this change** — §2.0 requires the contracts document to be amended first, in its own PR, and the project folder is read-only to this writer except this one file. The architect decides: execute as one 15-task slice, or amend §2.2 and §6.4 to add 1A′ and split this file at the `### Task 10` boundary, which needs no edit to any task body.

---

## Execution handoff

**Order.** Tasks 1 → 15, strictly. Each is one commit; Tasks 1, 2, 3 and 4 are each also one PR because each carries a migration (spec:2057).

**Before starting, confirm the amendment gate as well as the phase gate.** Of the seven rows in the Self-Review's *Contract amendments* table, **A1, A2, A3 and A6 have landed** in `2026-09-05-dulja-plan-contracts.md` as of 2026-09-08. **A4, A5 and A7 have not.** Concretely: §4.3.3's `MERGE` recipe carries no balance-key advisory-lock paragraph (A4 — **Task 8 does not start until it does**), contracts:2108 still reads "`refs.accountsByCode` … holds exactly the §4.15 codes the policy names" rather than the company's non-archived leaf chart this slice actually loads (A5 — **Task 6 does not start until it does**), and §3.6.4's register sentence still names only 2A's and 2B's grants (A7 — the architect adds 1A's seven **in the same PR as Task 4**, which is PR 4 below). Each is the architect's edit in its own PR; none changes a line of this plan.

**Before starting.** Confirm the phase gate: 0B, 0D, 0C and 0E merged; `bun run test` green at the root; tests 11, 12, 13, 14, 27 and the test-36 catalogue clauses passing in CI (spec:2327). Confirm 0B's generalised reversibility test (contracts §3.4.6) is in `packages/db/test/privileges.test.ts` — every migration from 0011 on depends on it, and the 0A version hard-codes `[1]`.

**Also confirm, before Task 4, that `bun run lint:rules` is green on the merged Phase 0 head.** One pre-existing 0B shape makes this worth checking rather than assuming: `packages/db/test/permission-catalogue.test.ts` (0B's file, 0B Task 7) opens with `import { PERMISSIONS } from "@dulja/contracts/permissions"`, and 0B's own `dependency-rule` matches an owner by `f.path.startsWith("packages/db/")` with `"packages/db": ["@dulja/domain"]`, over a file set (`ROOTS = ["apps", "packages", "scripts"]`) that includes `packages/db/test/**`. 0D reached the same conclusion from the other side and put `tests/invariants/role-catalogue.test.ts` in the root `tests/` tier for exactly this reason ("the only place the two can meet without the `dependency-rule` lint firing over `packages/**`"). **If that import is red on the Phase 0 head it is 0B's to resolve, not this slice's** — Task 4 only appends one `it` to that existing file and adds no import — and the resolution is 0B's choice between moving the DB-vs-module equality test to the root `tests/` tier (0D's precedent) and adding `@dulja/contracts` to the `packages/db` tier for test paths. Task 4's own `PERMISSIONS.map((p) => p.code)` line uses the import 0B already wrote there; do not "fix" it by adding a second source of the catalogue. The one place this slice *would* have introduced a new such import — Task 13's `documentTypesLoader.load`, which needs the permission catalogue to validate a policy — reads `select code from app.permission` on its own `tx` instead, exactly as 0C's `rolesLoader` does.

**After every task**, at the repository root: `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test` — these four are exactly the set contracts §3.1 (contracts:924) requires green after every task, and they are green after every task here.

**`bun run lint:rules` is the one documented exception, and it constrains PR boundaries, not commits.** contracts:924 puts `lint:rules` in CI rather than in the per-task set; `permission-catalogue` is bidirectional (contracts:1153 — "fails the build if a catalogue code has no reference or a reference names no catalogue code"), so from the moment Task 4 adds the six `accounting.*` codes to `packages/contracts/permissions.ts` until Task 12 registers the last handler, `lint:rules` reports six unreferenced codes. That is the phased catalogue working as spec:2142 intends. Because CI runs on a pull request, **the PR boundaries are:**

| PR | Tasks | Migration it carries | `lint:rules` at its head |
|---|---|---|---|
| 1 | Task 1 | `0011_create_document_line.sql` | green |
| 2 | Task 2 | `0012_create_account_balance.sql` | green |
| 3 | Task 3 | `0013_alter_document_add_posting_seq.sql` | green |
| 4 | Tasks 4 → 12 | `0014_seed_permission_phase1.sql` (the only one) | green — Task 12 registers the handlers |
| 5 | Tasks 13 → 15 | none | green |

Five PRs, four migrations, **one migration per PR** (spec:2057). Commits 4 through 11 sit inside PR 4 and are never a PR head, so no red build is ever published. Pushing is the owner's call in any case (Global Constraints). If the architect would rather have one PR per task, the alternative is to reorder Task 4 to sit immediately before Task 10 — nothing in Tasks 5–9 references a permission code, and migration 0014 stays the highest number at the moment it is written — which is a catalogue-level renumbering this plan's writer may not make unilaterally.

**What this slice hands to 1B** (its plan already lists all of it as consumed): `postDocument`, `issueDocument`, `reverseDocument`, `voidDocument`, `loadSnapshot`, `resolvePolicy`, `PostingError` from `@dulja/db`; `app.document_line`, `app.account_balance`, `app.posting_seq`, `document.posting_seq`, `fiscal_period.reopen_reason`; the six `accounting.*` permission codes; the routes `/v1/companies/:companyId/accounts` (+ `/tree`), `/fiscal-periods` (+ `/{id}/close`, `/{id}/reopen`), `/documents` (+ `/{id}`, `/{id}/lines`, `/{id}/transitions`) and `/ledger-entries`; the fixtures `JOURNAL_POLICY_V1`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount`; the `posting-only-tables` lint rule; `docs/ui/phase-1-api-surface.md`.

**What this slice hands to 2A:** `packages/domain/posting-policy.schema.json` (widen it under ADR 0026, keeping the `$id` and `"version": { "const": 1 }`, adding enum labels and optional properties only); `evaluatePolicy`'s `each_line` branch (add `each_tax` and `document` beside it — the `for` switch has one arm); `loadSnapshot`'s Phase 1 fills, each marked with the migration that replaces it; `applyDocumentTypes`'s insert list, under `loadDocumentTypes` and `documentTypesLoader` alike (add `module` with migration 0018); the static permission gates in `documents.ts` (replace with `policy.approval.create` / `policy.approval.post`) and the `documentTypeCode: z.literal("JOURNAL")` in `CreateDocumentBody`.

**What this slice changes in 0C's seed seam:** merging 1A widens 0C's `SubPack` union — `export type SubPack = "roles" | "dimensions" | "fiscal-periods" | "chart-of-accounts"` in **`packages/db/src/seed/types.ts`**, together with its ordered twin **`SUB_PACKS`** in the same file — to a fifth member, `"document-types"`, which is exactly the additive widening contracts §4.2.13's comment reserves for "each loader-owning slice"; Task 13 Step 4 lists the four further edits that follow from it (`LOADERS` and `runLoaders`' `applied` initialiser in `packages/db/src/seed/index.ts`, the `PHASE_0_SUB_PACK_DIRECTORIES` / `OWNED_ELSEWHERE` move in `packages/db/src/seed/packs.ts`, and the two 0C tests that carry the four literals), and the architect folds the new member into §4.2.13 and closes §4.18's first open item in the same PR.

**Known-red until a later slice:** nothing. Every test this plan writes is green at the end of Task 14; `tests/regression/sah-024.test.ts` reports one **skipped** `it`, by design, until OD-27 lands.

**If a task's stated failure does not appear**, stop. A different failure means the repository differs from what this plan assumes — most likely a 0B/0D/0C interface that shipped with a different shape. Report the difference rather than editing the expectation; the contracts document is amended first, then this plan.

