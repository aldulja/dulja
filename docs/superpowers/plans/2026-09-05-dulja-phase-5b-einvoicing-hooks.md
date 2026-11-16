# Dulja Phase 5B — E-invoicing hooks and the MyInvois transmitter (after LHDN verification)

**Execution record — 2026-10-02:** The owner authorized this plan's documented defaults and best-practice choices for missing inputs. The implementation uses the synthetic transmitter/fail-closed authority path and Task 11's local deployment equivalent; Task 9's live authority branch is deferred. The synthetic CLI rehearsal uses the stub's actual port through its loopback-only `--base-url` option, as reconciled in Plan Contracts. The complete task checklist and verification evidence live in [the Phase 5 exit review](../../review/2026-09-05-phase-5-exit.md) and [implementation report](../../reports/phase-5.md). No authority activation or remote deployment is claimed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 5 by hanging e-invoicing off the tax engine 5A shipped, **without a single LHDN or MyInvois endpoint, field name, schema version, threshold or deadline appearing anywhere in this plan** (hazard 2, spec:2226, spec:2467). Ship the abstract `EInvoiceTransmitter` of §4.9.3 — document hash, QR payload, `submit`, `poll`, `cancel` — as a **profile-driven** adapter whose call shapes are *data*, exactly as Phase 8's statutory rates are data; ship `app.einvoice_transmission`, the transmission log with attempts, bounded retry and status reconciliation (spec:2225); ship the `accounting.tax.submit` pg-boss job (spec:2356) and the `accounting.tax.file` permission; hook `postDocument` step 14 so that a posted document of an opted-in type on an enabled company gets a durable `pending` transmission row and an enqueue, and **nothing at all** on every company that has not opted in; and prove the whole path green in CI against a **synthetic** profile and a local stub server, so the MyInvois profile is one reviewed JSON file and two ADR-0051-derived functions written by the single OD-15 task and by nothing else.

**Architecture:** Three seams, and the first is the one that makes this slice writable at all. **(1) The transmitter is a port and its remote shape is a profile.** `packages/domain/src/tax/einvoice.ts` holds §4.9.3's interface verbatim plus `canonicalJson` and the `EInvoiceProfile` types; `packages/domain/einvoice-profile.schema.json` is the JSON Schema a profile must satisfy; a profile file lives at `packages/db/einvoice-profiles/<code>.v<n>.json` and declares a base URL, one auth block and exactly three call specs (`submit`, `poll`, `cancel`), each a method, a path template, a JSON Pointer to the status in the response and a `statusMap` onto §4.9.3's six `TransmissionStatus` labels. `createHttpTransmitter({ profile, canonicalise, qrPayload })` in `packages/db/src/einvoice/` turns any such profile into an `EInvoiceTransmitter`. This is hazard 1's `SYNTH` pattern (spec:2229 — "no rate lives in code, and a rate change is a seed PR, not a release") applied to hazard 2: **no endpoint lives in code either, and an endpoint change is a reviewed file, not a release.** It is also the only design under which every task of this slice ships complete, running, CI-green code before the authority's documentation has been read — the alternative is a file full of `"per ADR 0051"` string constants, which is the placeholder the assignment forbids. **(2) The log is the state of record, not the job.** `postDocument` step 14 writes an `einvoice_transmission` row at `pending` inside the posting transaction and *then* enqueues; if no `JobClient` was supplied it pushes a warning and skips the enqueue, because the durable row is what the manual `POST …/{id}/submit` route and the poll phase drive — that is what spec:2225's "status reconciliation" means, and it is why a missed enqueue is a warning here and a fail-closed refusal in 3B. **(3) Every gate fails closed and there are three of them in series:** `policy.tax.applies` **and** `policy.tax.einvoice` **and** `company.einvoice_transmitter is not null`. All three default off, so merging this slice transmits nothing anywhere until the OD-15 task flips a policy version and an admin sets a company column. **This slice adds exactly one route module** (`/v1/companies/:companyId/einvoice-transmissions`) and therefore exactly one `PROBES` key; the **three** sub-paths it mounts on modules other slices own — the two company e-invoice settings routes on 0B's `companyRoutes`, and `POST …/tax-returns/{id}/file` on 5A's `taxReturnRoutes`, which 5A's own plan hands to this slice — inherit those modules' existing keys (§4.2.7's sub-path rule, contracts amendment 13).

**Tech Stack:** Bun 1.4 (install, scripts, the API entrypoint) · Node 24 LTS (runs Vitest) · TypeScript strict · PostgreSQL 18 (Testcontainers `postgres:18`) · `postgres` (postgres.js) tagged templates for every write and every read · Drizzle ORM mirrors for typed reads and as the migration diff source (ADR-0002) · Hono + `@hono/zod-openapi` · Zod · Ajv (the validator 1A already installed for `posting-policy.schema.json`, ADR 0022) for `einvoice-profile.schema.json` · `node:crypto` `createHash` for the canonical-payload digest · the platform `fetch` for the one HTTP call, injected as `fetchImpl` so every test runs against a `node:http` server started inside the test process · pg-boss for `accounting.tax.submit` (0D) · Vitest + Testcontainers · oxlint + oxfmt · Turborepo. No package version appears in any source file — the lockfile owns versions (spec:104). **No HTTP client library is added**; `fetch` is in both runtimes.

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §0.2 the never/always lists (spec:97–108), §0.3 **First tax jurisdiction** (spec:982), §3.0.4 the Tax row (spec:1046 — this slice completes its "e-invoicing hooks" clause), §3.5 country seed-data packs (spec:1242), §3.8 the linter columns and `FORCE ROW LEVEL SECURITY` (spec:1366–1370), §3.9 Identifiers / Time / Money / Naming / Enumerations / Deletion / Error codes / Database access / API / Logging (spec:2037–2063), §4.2.1 `accounting.tax.file` and the `accountant` row (spec:2147, 2158), §4.7 the **e-invoicing bullets** (spec:2225–2226) and the tax-engine and rounding bullets (spec:2227–2228), §4.11 engineering practice (spec:2258–2266), §5.2 `apps/worker` "tax submission" (spec:2356), §5.3 the **Phase 5** owner row (spec:2405), Part V the Phase 5 row (spec:2291), Part VI tests **13** (spec:2431) and **26** (spec:2444), Part VII **#3** (spec:2467), Part I **LEGACY-020** (spec:388), **LEGACY-019** (spec:381), **LEGACY-013**, **LEGACY-029/030**, **LEGACY-036/037/069**.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 5B — E-invoicing hooks and the MyInvois transmitter (after LHDN verification). **Phase:** 5. **Phase gate:** this plan starts only when **5A** is merged (and therefore 4A and 4B before it) and Phase 4's definition of done is green in CI (spec:87). 5B is the phase-closing slice of Phase 5 (§3.8 names it), so its last task rewrites `AGENTS.md`'s "Current phase" section.
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.forbid_change`. **0B** — `createDb`, the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `AppError`, `ERRORS`, `ErrCode`, `Problem`, `fromDatabaseError`, `createLogger`, `Logger`, `PERMISSION`, `PERMISSIONS`, `PermissionCode`, `requirePermission`, `assertRouteGates`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `createApp`, `AppDeps`, `AppEnv`, `readConfig`, `ApiConfig`, `startApi`, `TEST_ISSUER`, `PROBES`, `IsolationProbe`, `encodeCursor`, `decodeCursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `ProblemSchema`, `parseFilters`, `FILTER_OPS`, `FilterClause`, `companyRoutes`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `sourceFiles`, `REPO_ROOT`, `repoFile`. **0D** — `Money`, `currency`, `CurrencyCode`, `round`, `RoundingMode`, `toBase`, `MONEY_SCALE`, `JOBS`, `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `EnqueueOptions`, `registerHandler`, `runJob`, `registeredJobNames`, `eachTenant`, `JOB_PROBES`, `JobIsolationProbe`, `log`, `startWorker`, `seedBranch`. **0C** — the seed CLI and its `--only roles` sub-command, `PackLoader`, `LoaderContext`, `readPackFile`, `containerSecrets`. **1A** — `postDocument`, `loadSnapshot`, `resolvePolicy`, `issueDocument`, `PostResult`, `PostingError`, `PostingErrorCode`, `seedTenantV2`, `seedAccount`, `JOURNAL_POLICY_V1`. **1B** — `postJournal`, `runIntegrityCheck`. **2A** — `evaluatePolicy`, `parsePolicy`, `validatePolicy`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `seedDocumentType`, `seedParty`, `DocumentLineInput`. **2B** — `transitionDocument`, `grantCodes`, `listDocumentEvents`. **2C** — `MODULE_READ_CODE`. **3B** — `recordingJobs`, `RecordedJob`, `ensureOpenPeriods`, `postDocument`'s optional `input.jobs?: JobClient` (amendment A5). **3C** — `draftTypedDocument`, `DraftLine`. **4B** — the §4.17.1 file `tests/invariants/support/ar-ap.ts` with **`PACK_DIR`** (4B's own amendment 9 names it `PACK_DIR` **and not** `PACK_ROOT` — an *absolute* directory with a trailing separator, because 4A's `PACK_ROOT` in `packages/db/test/ar-ap/_support.ts` is the *relative* `"seed/my"` that `readPackFile` takes, and the two are not interchangeable), `DocumentTypeEnvelope`, `seedTypeFromPack`, `PackApproval`, `packApproval`, `PostFromPackOptions` (**with 5A amendment A13a's `taxInclusive?` and `computeTax?`**), `postFromPack`, `ArApFixture` (`{ documentTypeIds; accountIds; partyIds: { customer; vendor }; termId }` — **`partyIds.customer`, never a `customerId` member**), `arApFixture`. **5A** — `TaxEngine`, `TaxRegime`, `TaxCodeDef`, `TaxLineInput`, `TaxLineResult`, `JurisdictionPack`, `ReturnBox`, `malaysiaPack`, `app.tax_regime`, `app.tax_code`, `app.tax_transaction`, `app.tax_return`, `document_line.tax_code_id`, `document.tax_inclusive`, `seedTaxCode`, the `tax` sub-pack loader, `ERR_TAX_REGIME_MISMATCH`, the `2300`/`1350` chart rows, `accounting.tax.manage`, and the golden fixtures under `tests/golden/tax/`.

  ⚠️ **5A's plan file did not exist when this plan was written, so every 5A name above is taken from the contracts registry verbatim (§4.9.1, §4.9.2, §4.15, §3.6.2, §4.17, §4.14) and from nowhere else** — procedure step 4. Where 5A's written plan and this plan disagree about a 5A name, **5A's file is the authority** (§4.18's rule) and **Task 0's gate script is what discovers the difference before any code is written**. Four 5A facts this plan deliberately does **not** assume: that 5A registered any route module (§4.2.7's table has no 5A row, so this slice's settings routes go on 0B's `companyRoutes` and its own module is the first tax-area module); that `tests/golden/tax/` has any particular case directory name (Task 10 globs whatever is there and skips with a named message if the directory is empty); that 5A's `tax_transaction` rows carry anything beyond §4.9.2's column list (nothing in this slice reads that table — the payload is built from `loadSnapshot`, and Task 0's gate says so); and that `seedTaxCode` creates its regime with any particular code (Task 10 reads back whatever it returns).

  **RECONCILED AT FINISHING TIME (2026-09-08): 5A's plan file now exists and was read, and four of its facts are written into Tasks 8 and 10 rather than left as assumptions.** (1) **`generated → filed` is 5B's transition** — 5A's Task 8 says so in terms ("`generated → filed` is **5B's** transition under `accounting.tax.file`, and this slice writes neither `filed_at` nor `attachment_id`"), so **Task 8 ships `fileTaxReturn` and one `POST …/tax-returns/{id}/file` sub-path on 5A's own module**, and contracts amendment 13 records it against amendment 7's earlier sentence. Without it `tax_return.status`'s third label and `filed_at` would be unreachable. (2) **5A refuses a wrong tax-return state with `PostingError("ERR_DOC_STATUS_ILLEGAL", …)`** (its `returns.ts` raises exactly that for "is a draft — generate it first"), so `fileTaxReturn` reuses that code and **Global Constraint 9's already-shipped list gains it**; no thirteenth `ERR_*` row is added. (3) **5A's shared helper is `taxFixture(db, name)` — it takes a NAME, not a `Seed` — with `postTaxedDocument(db, f, …)` and `TAX_PACK_ROOT` beside it** in `tests/invariants/support/tax.ts`; Task 10 uses that shape. (4) **5A registers two route modules (`tax-codes`, `tax-returns`) with two `PROBES` keys, and `TAX_PERMISSION` lives in `apps/api/src/routes/accounting/tax-codes.ts`**; this slice's `/file` sub-path inherits 5A's `tax-returns` key and adds no third module, so the Architecture paragraph's "exactly one route module, one `PROBES` key" is unchanged. **Everything else about 5A is still consumed from the contracts registry, and Task 0's gate is still where a mismatch is found.**
- **Migration numbers:** **0057–0058**, two files, two PRs (§3.4.3 "one migration per PR"), each with a hand-written `NNNN.down.sql`:
  - `0057_create_einvoice_transmission_and_alter_company_einvoice.sql` (**T1**) — `app.einvoice_transmission` **and** the three `app.company` columns. **The name is longer than the card's guess and that is §3.4.2's round-2 rule, not a deviation:** "a file whose name understates what it does is renamed, not left", settled on 2A's `0018_alter_document_party_fk_and_document_type_module.sql`. Task 0 amendment 11 records the rename against the card.
  - `0058_seed_permission_phase5b.sql` (**T2**) — the one code `accounting.tax.file`. **Written by Task 2 and committed in Task 8's PR**, where it is still the only migration: §3.6.3 compares `app.permission` and `permissions.ts` in *both* directions, so the row and the catalogue entry cannot land in different commits (Task 2 Step 5).

  **ADR numbers:** 0051–0053. **0051** *The verified LHDN MyInvois requirement set* — written **only** by Task 9, from the authority's own current documentation, never from this document or from training data (spec:2226, 2467); it is the sole source of every concrete MyInvois value in the repository. **0052** *The e-invoice transmitter is a port and its remote shape is a profile* (T3, T4) — a **proposal**, asked before implementing (spec:95: it touches the data model and an external integration's security posture). **0053** *Transmission state, bounded retry and what may be logged* (T5, T7) — a **proposal**, asked for the same reason: it fixes what reaches `response jsonb` and therefore what a future incident responder can and cannot see.
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `currency`, `round`, `RoundingMode`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`, `createDb`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`, `FORBIDDEN_LOG_FIELD`, `readConfig`, the middleware order), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`, `PostingError` — and this slice's three registry rows), §4.2.5 (`PERMISSION`, `requirePermission`, `ROLES`, `INCOMPATIBLE_PAIRS`, `assertRouteGates`), §4.2.6 (`JOBS`, `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `EnqueueOptions`, `registerHandler`, `runJob`, `JOB_PROBES`), §4.2.7 (`RouteModule`, `buildRoutes`, `IdempotencyHeader`, `createApp`, `PROBES`, `companyRoutes`), §4.2.8 (the common schemas, the list envelope, the cursor codec, **the one list-filter convention**), §4.2.9 (`idempotency`, `RECLAIM_AFTER_SECONDS`), §4.2.12 (`startApi`, `ApiRequest`, `StartedApi`), §4.2.13 (`readPackFile`), §4.3.1 (`postDocument`, `loadSnapshot`, `resolvePolicy`, `PostResult`), §4.3.2 (**the fixed algorithm — steps 3, 4, 6, 13 and above all 14**, and its closed write list), §4.3.4 (`document_line.tax_code_id`, `document.tax_inclusive`), §4.3.7 (the seed envelope), §4.4.1 (`posting-policy.schema.json`'s **`tax` block** — the one place this slice widens it), §4.4.2 (`DocumentSnapshot`, `LineSnapshot`, `PostingPolicy`, sign normalisation A9), §4.5.1 (legal transitions), §4.9.1 (5A's `TaxEngine` and `JurisdictionPack` — consumed, never re-declared), §4.9.2 (5A's four tables), **§4.9.3 in full**, §4.14 (document-type codes), §4.15 (account codes), §4.16.1 / §4.16.2 (report codes and the closed `DatasetId` registry — this slice adds to neither), §4.17 / §4.17.1 (the two helper registers), §5 (all thirty-five hazards, and **1** and **2** as the two that bind hardest), §6.1 rows 13 and 26, §6.2 row spec:1046.
- **Interfaces produced:** **§4.9.3 in full** — `EInvoiceDocument`, `TransmissionStatus`, `EInvoiceTransmitter`, `EInvoiceCredentials` verbatim, and `app.einvoice_transmission` with §4.9.3's column list; the `accounting.tax.submit` job with `retryLimit 8` and exponential backoff; §3.6.2's one code `accounting.tax.file`. Everything else this slice names is listed under **Contract additions** in the Self-Review and lands through **Task 0**.
- **Owner decisions:** **OD-15** — LHDN MyInvois credentials and the current requirement set (spec:92, 982, 2226, 2405, 2467; Part VII #3) → **Task 9, one isolated task**, per hazard 6. §2.12's default is written into every other task: **the abstract interface only**, with the `synthetic` transmitter as the sole registered implementation and `myinvois` refused by name with `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` until Task 9 registers it. **The card says "the adapter tasks are written against the abstract interface and are implemented only against ADR 0051" and "the plan's Task 1 is fetch-and-record"; hazard 6 says one task per decision, and hazard 6 wins on the *count*.** The *ordering* clause is honoured differently and deliberately: ADR 0051 fills a profile whose **schema is Task 3's**, so Task 9 cannot literally be Task 1 without inventing the schema twice. What the card actually protects — that no MyInvois value enters the repository before the authority's documentation is read — is enforced mechanically instead, by Task 0's gate script grepping every file this slice writes for an `http(s)://` literal outside `packages/db/einvoice-profiles/` and `tests/`, and by Task 11 re-running that grep at phase exit. **OD-24 is not engaged: this slice ships no screen** (see "Deliberately not in this slice"). **OD-05 is not engaged:** 5B's scope contains no ⚠️ row of §3.0.3 or §3.0.4 — spec:1046's Tax row carries no warning triangle; the ⚠️ on the Phase 5 row is OD-15's own subject.
- **Part VI tests owned / re-run:** **owns none** (the card says so). **Re-runs: 26** (tax-return determinism, with e-invoicing hooks **on** — Task 10, a new file over 5A's fixtures; 5A's own golden test is never edited) and **13** (audit completeness, over the transmission log and the three new `company` columns — Task 10). Also re-run because this slice adds a table, a route module, a job and a permission code: **12** (tenant isolation — T1, T7, T8), **27** (no SQL text across the API — T11), **36** (permission catalogue ↔ handler — T2, T8). **§3.0.4 rows owned:** none new; this slice completes the "**e-invoicing hooks**" clause of spec:**1046**, whose other clauses are 5A's. **Regression files created / appended:** **creates none.** **Appends** one `describe("LEGACY-020 … — 5B", …)` block to `tests/regression/legacy-020.test.ts` (created by **5A**, §3.7.3's rule; Task 0's gate reports its absence rather than this slice creating it) and one to `tests/regression/legacy-019.test.ts` (created by **0B**, appended by 4B; this slice's block asserts no local rounding or float appears on the e-invoice path).
- **Shared namespaces this slice writes into:** **document-type codes (§4.14) — none, and no test-only code either.** Every type this slice's tests configure is a **4A pack envelope read off disk** through 4B's `seedTypeFromPack`, re-seeded at `policyVersion + 1` with `tax.einvoice: true` — which is precisely the mechanism Task 9 uses in production, so the test exercises the shipped path. **Account codes (§4.15) — seeds none.** Consumed and asserted-not-reseeded, each with its seeding slice: **`2300` output tax payable (5A)** and **`1350` input tax receivable (5A)** reached only through 5A's own tax codes, and `1000`/`4000`/`5920` (0C, through `seedTenantV2`) and `1200`/`2100` (0C, through `seedParty`) reached only through 4A's and 1A's own policies. **This slice resolves no account by code anywhere** — it plans no ledger line, posts no document of its own and seeds no policy that names an `account: { code }` literal, so hazard 33 has nothing to bite on. **Report codes (§4.16.1) — none.** §4.16.1 is closed for v1 and has no e-invoicing row; the transmission log is read through this slice's route module, and `accounting.tax_return_view` is **7C's** row over 5A's `tax_transaction`. **`DatasetId` members (§4.16.2) — none, deliberately, and the reason is recorded** (Task 0 amendment 12): §4.16.2's *rule* sentence would sweep in every table at migration ≤ 0058, but its *enumeration* — which is the register — names `tax_transaction` and stops, and the rule's real criterion is "first report that reads it". No v1 report reads `einvoice_transmission`. **`fixtures.ts` helpers (§4.17) — none added.** §4.17 assigns 5B no row and hazard 9 forbids inventing one beside the register; every row this slice's tests need comes from `seedTenantV2`, `seedAccount`, `seedParty`, `seedDocumentType`, `seedTaxCode`, `seedBranch`, `grantCodes`, 3B's `ensureOpenPeriods`, 3C's `draftTypedDocument` or 4B's `arApFixture`. **Shared test helpers (§4.17.1) — two new files, one per tier, registered by Task 0 amendment 10:** `packages/db/test/support/einvoice-stub.ts` (`StubServer`, `StubScript`, `StubReply`, `StubCall`, `startStubServer`, `SYNTHETIC_PROFILE_PATH`, `stubProfile`, `snapshotFixture`, `enableEinvoice`, `optInDocumentType`), reached from the `tests` tier through the new `@dulja/db/test/einvoice-stub` `exports` subpath; and `tests/invariants/support/einvoice.ts` (`EinvoiceFixture`, `einvoiceFixture`), which composes it with 4B's `arApFixture`. **Two files rather than one because `packages/db/test/**` is not on §4.17.1's list of workspaces that may import `tests/invariants/support/**`, and adding it would close a module cycle through `packages/db/test/index.ts`** — amendment 10 states it.
- **Five facts every test in this plan depends on, stated once because getting one wrong is a silent failure.** (1) **`Seed` has no `branch` member** — it is `{ tenant; system; human; company; period; closedPeriod; lockedPeriod; cash; sales; docType; policy; branchType; hq }` (§4.1), so every `branchId:` in this plan is `<seed>.hq` unless a second value came from `seedBranch`. (2) **`seedTenant` grants `s.human` nothing** (§4.1, pinned) and 2B's R2 evaluates `policy.approval.post` *inside* the posting transaction, so every posting test calls `grantCodes` first — 4B's `arApFixture` already does. (3) **Plan 0A seeds exactly three fiscal periods and only 2026-01 is open** (`s.closedPeriod` = 2026-02 closed, `s.lockedPeriod` = 2026-03 locked); every test that posts outside January calls 3B's `ensureOpenPeriods(db, s, 2026)` first — again, `arApFixture` already does. (4) **`app.company` is a migration-0001 table holding production rows**, so 0057's three columns are the *expand* half of §3.4.7 and the down file drops **only those three columns**, never the table (§3.4.5). (5) **`app_rw` holds DELETE on exactly five tables** (§3.5.4) and 2B is the only slice that ever extends that list, so **nothing in this slice deletes a transmission row**: a cancelled transmission is `status = 'cancelled'`, which is spec:2049's rule applied to an integration log.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first (that is what Task 0 is).
- **Contracts version:** 2026-09-07.

## Global Constraints

Copied verbatim from the spec and the contracts document; every task's requirements implicitly include this section.

1. **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (LEGACY-036/037/069); issue DDL from application code (LEGACY-053); disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053); gate an audit write on any flag (LEGACY-030); hard-code a package version into a source file — the lockfile owns versions.
2. **Always**, for every new table (spec:106): `tenant_id`, an RLS policy named exactly `tenant_isolation`, `created_at`, a migration with a hand-written down, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. **This slice creates exactly one table** — `app.einvoice_transmission` — and it carries the §3.3 binding form and a two-tenant test in Task 1.
3. **Nothing outside `packages/db/src/posting/` and `packages/db/src/costing/` writes `ledger_entry`, `ledger_entry_dimension`, `inventory_movement`, `cost_layer`, `cost_consumption`, `account_balance`, `stock_on_hand` or `tax_transaction`** (§4.3.2, the `posting-only-tables` lint, hazard 22). **This slice writes none of them, ever.** It reads `document`, `document_line`, `document_type`, `posting_policy`, `company` and `party` through `loadSnapshot`, and writes only `app.einvoice_transmission` and three `app.company` columns. `einvoice_transmission` is **not** on the `posting-only-tables` list and must not be added to it — step 14 writes it from inside `posting/`, and the submit path writes it from `packages/db/src/einvoice/`, which is the same relationship `party_ageing` has to its job (§3.7.5 names that exclusion by name).
4. **Money** is `numeric(19,4)` in Postgres and the opaque `Money` type in `@dulja/domain` in TypeScript; no `number` ever holds a monetary value (spec:2041, §3.7.5 `no-number-money`). **Every amount in an e-invoice payload is `Money.toJSON()`'s `{ amount, currency }` or `Money.toString()`'s fixed 4-dp string, taken from `LineSnapshot` — never re-derived, never re-rounded, never `Number()`, never `.toFixed()`.** This is the whole of LEGACY-019 on this path and Task 10's `legacy-019` block asserts it as a source fact.
5. **Every query, reads included, runs inside `withTenant`** (spec:2053). `db.` is a lint violation; only a `tx` obtained from `withTenant` may tag SQL. `sql.unsafe` has exactly three homes and **none is in this slice** (§3.3, hazard 21). The profile loader takes a directory and returns parsed JSON; it never builds SQL. The path template is interpolated into a **URL**, never into a query.
6. **One migration per PR** (spec:2057); each file runs whole in one transaction (so no `create index concurrently`); every statement carries a comment naming the LEGACY-/spec reference it serves; SQL keywords lowercase; section banners `-- ── N. title ───`; a hand-written `NNNN.down.sql` that drops only what the up added, in reverse dependency order (§3.4.5).
7. **No enum label is added** (§3.4.4, hazard 11). This slice's two closed vocabularies are `text` + a named `check`: `einvoice_transmission.status` (§4.9.3's six labels) and `company.einvoice_transmitter` (`synthetic | myinvois`).
8. **Deletion** (spec:2049): financial rows never; master data is `archived_at`. §3.5.4's pinned `app_rw` DELETE list is **unchanged** by this slice and Task 11 re-asserts it as an equality. A transmission is cancelled, never deleted.
9. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). **This slice adds exactly three rows to the §4.2.4 registry and to `ERRORS`, each in the PR that raises it:** `ERR_EINVOICE_NOT_ENABLED` (422, T5), `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` (422, T4/T5), `ERR_EINVOICE_STATUS_ILLEGAL` (409, T5). Everything else it raises is already shipped: `ERR_VALIDATION_FAILED`, `ERR_NOT_FOUND`, `ERR_RBAC_FORBIDDEN`, `ERR_RLS_DENIED`, `ERR_CONFLICT_UNIQUE`, `ERR_CONFLICT_REFERENCE`, `ERR_IDEMPOTENCY_KEY_MISSING`, **`ERR_DOC_STATUS_ILLEGAL`** and `ERR_INTERNAL`. **`ERR_DOC_STATUS_ILLEGAL` is on the list because of Task 8's `fileTaxReturn`, and only because of it:** 5A's `returns.ts` already raises that exact code for the mirror-image refusal ("tax return … is a draft — generate it first"), so the two transitions of one row speak one language and this slice adds no thirteenth `ERR_*` row to satisfy a case 5A had already answered. **This list is closed: a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.**
10. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice seeds exactly the one code §3.6.2 assigns it — **`accounting.tax.file`, `module: "accounting"`, `mutating: true`, `phase: "5B"`** — and invents none.
11. **No plan invents a literal in a shared namespace** (hazard 32). Document-type codes, account codes, report codes, `DatasetId` members, `fixtures.ts` helper names and `ERR_*` names all come from the registers; **Task 0 amends a register before any task writes a literal into it.**
12. **Jobs run as the tenant's system principal** through `systemContext` (spec:2179, hazard 20) and do their work in many short transactions, never one long one. `accounting.tax.submit` is a **per-transmission** job (`singletonKey = transmissionId`), not a fan-out, so it needs no `eachTenant`; its envelope carries `tenantId` like every other and Task 7 supplies its `JOB_PROBES` entry (hazard 31).
13. **⚠️ HAZARD 2 IS THE BINDING CONSTRAINT OF THIS SLICE.** No LHDN or MyInvois endpoint, host name, path, header name, field name, schema version, code list, threshold or deadline appears in **any** file this plan writes, in **any** comment, in **any** test and in **any** ADR other than 0051 — and 0051 is written by Task 9 from the authority's own current documentation, never from this document, never from the legacy dossier and never from training data (spec:2226, 2467). The only URLs in this slice are `http://127.0.0.1:<port>` in the synthetic profile and in tests. **Task 0's gate script greps for the violation and Task 11 re-runs the grep**; a reviewer who finds a plausible-looking MyInvois value anywhere in this slice has found a defect, not a shortcut.
14. **Hazard 1 applies unchanged even though this is not Phase 8:** no real statutory rate, threshold, ceiling or formula appears anywhere. Every tax rate in every fixture of this slice comes from 5A's `seedTaxCode` default or is an obviously invented figure, and no figure in this plan is presented as a Malaysian rate.
15. **Owner-account tasks follow hazard 5's pattern** — "owner provides X; verify with `<exact command>`" with a local equivalent. Task 9 is the only one, and the slice never blocks on it.
16. **Logging** (spec:2063, §4.2.3): the logger drops and warns on any field name matching `/token|password|authorization|card|pin|secret/i`. **No field of any log call in this slice is named `secret`, `secretRef`, `token` or `authorization`, and no log call in this slice takes the transmitter's `raw` response as a field value.** §4.9.3's `EInvoiceCredentials.secretRef` keeps its frozen field name in the *type*, but the column that stores it is `company.einvoice_credential_ref` and the log field is `credentialRef` — both chosen so the runtime filter never eats a field the incident responder needs.
17. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [5B T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root stay green after every task.

---

## This slice's share of the Phase 5 definition of done

The Phase 5 row of the phase table, verbatim (spec:2291) — **Definition of done:** *"The return is generated, validated and reconciled end-to-end against a golden fixture"*.

**That sentence is 5A's in full, and the card says so** ("This slice's share of the DoD: none new; keeps 5A's DoD green with hooks enabled"). 5B's obligation is the *negative* one, and it is testable:

| Clause | Owner | Where 5B keeps it green |
|---|---|---|
| "The return is generated, validated and reconciled end-to-end against a golden fixture" | **5A** | **Task 10 Step 3** re-runs 5A's own golden corpus with **e-invoicing hooks on** — the same fixtures, the same `buildReturn`, byte-compared against the same `expected.json` — and asserts the payload is **byte-identical to the hooks-off run**. Hooking transmission onto `postDocument` must not move a single byte of the return, and this is the one assertion that proves it. |
| "…with hooks enabled" (the card's phrase for 5B's share) | **5B** | **Task 10 Step 4**: over the same corpus, every document of an opted-in type on the enabled company has exactly one `einvoice_transmission` row, every one reaches `accepted` through the synthetic transmitter, and every document of a **non**-opted-in type has **zero** rows. |
| Acceptance test 13 (audit completeness) over this slice's surface | **5B** | **Task 10 Step 5**: every insert and every status update of `einvoice_transmission` and every write of the three `company` columns produces an `app.audit_log` row with a server-supplied actor; `app_rw` can neither update nor delete an audit row; the chain verifies through 1B's `runIntegrityCheck`. |

**Phase 5 exit (Task 11).** 5A's DoD green in CI with hooks on and off; tests 26 and 13 re-run; tests 12, 27 and 36 re-run over this slice's table, route module, job and code; the pinned `app_rw` DELETE list re-asserted unchanged; `lintSchema` at zero violations; the hazard-2 grep green; the staging re-seed run; `AGENTS.md`'s "Current phase" section rewritten (§3.8 names 5B as a phase-closing slice).

---

## File Structure

Every path is relative to the repository root. **NEW** means this slice creates it; **EDIT** means an existing file gains the stated additions and nothing else.

```
docs/
├─ adr/0051-verified-lhdn-myinvois-requirement-set.md          NEW  ⚠️ OD-15 ONLY            T9
├─ adr/0052-einvoice-transmitter-port-and-profile.md           NEW  proposal (spec:95)       T3,T4
├─ adr/0053-transmission-state-retry-and-what-may-be-logged.md NEW  proposal (spec:95)       T5,T7
├─ decisions/od-15-5b-myinvois-requirement-set.md              NEW  the OD-15 record         T9
├─ runbooks/einvoice-transmission.md                           NEW  the operator procedure   T8
├─ review/2026-09-05-phase-5-exit.md                           NEW  the phase report         T11
└─ owner/od-15/                                                NEW  the OD-15 gate directory T9

scripts/check/
├─ contracts-5b-amendments.sh                                  NEW  Task 0's gate            T0
└─ no-authority-literals.sh                                    NEW  the hazard-2 grep        T0

AGENTS.md                                                      EDIT "Current phase" → 5B     T11

packages/domain/
├─ einvoice-profile.schema.json                                NEW  the profile JSON Schema  T3
├─ src/tax/einvoice.ts                                         NEW  §4.9.3 + profile types   T3
├─ src/tax/index.ts                                            EDIT re-export einvoice.ts    T3
└─ test/tax/einvoice.test.ts                                   NEW  canonicalJson + profile  T3

packages/db/
├─ migrations/
│  ├─ 0057_create_einvoice_transmission_and_alter_company_einvoice.sql  NEW                   T1
│  ├─ 0057.down.sql                                            NEW  drops 3 COLUMNS, not the
│  │                                                                company table            T1
│  ├─ 0058_seed_permission_phase5b.sql                         NEW  one code; written at T2,
│  │                                                                committed in T8's PR      T2
│  └─ 0058.down.sql                                            NEW                            T2
├─ einvoice-profiles/
│  ├─ README.md                                                NEW  what a profile is         T4
│  ├─ synthetic.v1.json                                        NEW  127.0.0.1 only            T4
│  └─ myinvois.v1.json                                         NEW  ⚠️ OD-15 ONLY — from
│                                                                   ADR 0051 and nowhere else T9
├─ src/
│  ├─ schema/einvoice-transmission.ts                          NEW  Drizzle mirror            T1
│  ├─ schema/company.ts                                        EDIT three columns             T1
│  ├─ einvoice/
│  │  ├─ profile.ts                                            NEW  loader + Ajv validation   T4
│  │  ├─ http-transmitter.ts                                   NEW  the generic adapter       T4
│  │  ├─ synthetic.ts                                          NEW  the CI transmitter        T4
│  │  ├─ registry.ts                                           NEW  code → transmitter        T4
│  │  ├─ credentials.ts                                        NEW  ref → value, once         T4
│  │  ├─ redact.ts                                             NEW  what reaches `response`   T4
│  │  ├─ errors.ts                                             NEW  EInvoiceError             T4
│  │  ├─ transmission.ts                                       NEW  the log's state machine   T5
│  │  ├─ settings.ts                                           NEW  company settings WRITE     T8
│  │  ├─ verify.ts                                             NEW  the einvoice:verify check T4
│  │  ├─ myinvois.ts                                           NEW  ⚠️ OD-15 ONLY             T9
│  │  └─ index.ts                                              NEW  the barrel                T5
│  ├─ posting/post.ts                                          EDIT step 14's einvoice clause T6
│  ├─ jobs/payloads.ts                                         EDIT one key                   T7
│  ├─ tax/returns.ts                                           EDIT (5A's file) fileTaxReturn T8
│  ├─ cli.ts                                                   EDIT `einvoice-verify` command T4
│  └─ index.ts                                                 EDIT re-export ./einvoice      T5
├─ package.json                                                EDIT `einvoice:verify` script  T4
│                                                              EDIT exports ./test/einvoice-stub T4
└─ test/
   ├─ support/einvoice-stub.ts                                 NEW  §4.17.1(a), amendment 10  T4
   ├─ einvoice/transmission-table.test.ts                      NEW  DDL + two tenants + lint  T1
   ├─ einvoice/permission.test.ts                              NEW  catalogue + role seed     T2
   ├─ einvoice/profile.test.ts                                 NEW  loader + schema refusals  T4
   ├─ einvoice/http-transmitter.test.ts                        NEW  against a node:http stub  T4
   ├─ einvoice/transmission.test.ts                            NEW  the state machine         T5
   ├─ einvoice/step14.test.ts                                  NEW  the three gates           T6
   ├─ einvoice/verify.test.ts                                  NEW  the verify command        T4
   └─ einvoice/myinvois.test.ts                                NEW  ⚠️ OD-15 ONLY             T9

packages/contracts/
├─ src/errors.ts                                               EDIT three rows                T5
├─ permissions.ts                                              EDIT one entry (staged at T2)  T8
├─ src/accounting/einvoice.ts                                  NEW  the DTOs                  T8
└─ src/accounting/tax.ts                                       EDIT (5A's) FileTaxReturnBody  T8

packages/db/seed/
├─ roles.ts                                                    EDIT accountant + one code
│                                                                   (staged at T2)            T8
└─ my/document-types/*.json                                    EDIT ⚠️ OD-15 — tax.einvoice at
                                                                    policyVersion + 1         T9

apps/api/
├─ src/routes/accounting/einvoice-transmissions.ts             NEW  the one new module        T8
├─ src/routes/accounting/tax-returns.ts                        EDIT (5A's module) `/file`     T8
├─ src/routes/admin/companies.ts                               EDIT two settings sub-paths    T8
├─ src/routes/index.ts                                         EDIT one buildRoutes entry     T8
├─ src/context.ts                                              EDIT `db: Sql` (amendment 13)  T8
├─ src/app.ts                                                  EDIT the two-line middleware   T8
└─ test/routes/accounting/einvoice-transmissions.test.ts       NEW                             T8

apps/worker/
├─ src/handlers/accounting-tax-submit.ts                       NEW  the job handler           T7
├─ src/jobs.ts                                                 NEW  the job-client accessor   T7
├─ src/index.ts                                                EDIT register handler + boot   T7
└─ test/handlers/accounting-tax-submit.test.ts                 NEW                             T7

scripts/check/
└─ no-authority-literals.sh                                    EDIT ⚠️ OD-15 — optionally widen
                                                                    WORDS from ADR 0051       T9

scripts/lint/rules/
└─ no-bare-db.ts                                               EDIT one allow-list entry      T8

tests/
├─ invariants/support/einvoice.ts                              NEW  §4.17.1, amendment 10  T7,T8
├─ invariants/probes.ts                                        EDIT one PROBES + one JOB_PROBES T7,T8
├─ invariants/phase-5-exit.test.ts                             NEW  the phase gate           T11
├─ golden/tax-einvoice.test.ts                                 NEW  test 26 with hooks on     T10
├─ regression/legacy-020.test.ts                                  EDIT append a `— 5B` block     T10
└─ regression/legacy-019.test.ts                                  EDIT append a `— 5B` block     T10
```

**Twelve files carry the whole slice.** `packages/domain/src/tax/einvoice.ts` (the port and the profile types), `packages/domain/einvoice-profile.schema.json` (what a profile must be), the seven modules under `packages/db/src/einvoice/` that are not OD-15-gated (`profile`, `credentials`, `redact`, `errors`, `http-transmitter`, `synthetic`, `registry`, plus `transmission`, `settings` and `verify` — ten in all once Tasks 5 and 8 have run), migration 0057, the worker handler, the route module, and `tests/invariants/support/einvoice.ts`. Everything else is an edit of one or two lines in a file another slice owns — including all four of the files this slice touches in 5A's and 0B's territory, none of which loses a line: `packages/db/src/tax/returns.ts` and `packages/contracts/src/accounting/tax.ts` each gain one appended declaration, `apps/api/src/routes/accounting/tax-returns.ts` one route, and `companyRoutes` one `route()` call.

---

### Task 0: Contracts amendments, the 5A/4B repo gate, and the hazard-2 grep

**This task carries no application code.** It does three things: it writes down every name this slice must add to the contracts document because the registry lacks it; it *checks the repository* for the names from 5A, 4B and 3B that every later task imports (5A's plan file did not exist when this plan was written, so its names came from the registry rather than from a written plan — this gate is where that assumption is tested, once, before any code depends on it); and it installs the grep that makes hazard 2 mechanical rather than a promise.

**Files:**
- Create: `scripts/check/contracts-5b-amendments.sh`
- Create: `scripts/check/no-authority-literals.sh`
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` — the thirteen amendments below
- Modify: `package.json` (root) — one script, `"check:5b": "bash scripts/check/contracts-5b-amendments.sh && bash scripts/check/no-authority-literals.sh"`

**Interfaces**

- Consumes: nothing at runtime. Both scripts read the repository with `grep` and `test -f`.
- Produces:
  - `scripts/check/contracts-5b-amendments.sh` — exit 0 = every amendment landed and every consumed name exists; exit 1 = a `MISSING` line names what is absent.
  - `scripts/check/no-authority-literals.sh` — exit 0 = no `http(s)://` literal and no authority-shaped identifier outside the two permitted directories; exit 1 = a `FORBIDDEN` line names the file and line. **Joins CI in Task 11 as a `bun run check:5b` step.**

- [ ] **Step 1: Write the thirteen amendments into the contracts document**

Each is one edit, in the section named. **Do not proceed to Task 1 until all thirteen are in the file** — every later task cites them by number.

| # | § | Amendment |
|---|---|---|
| **1** | 4.2.4 | **Three rows are added to the allocated code space, all raised by 5B.** `ERR_EINVOICE_NOT_ENABLED` **422** — "the company has no e-invoice transmitter configured", raised by `submitTransmission`/`cancelTransmission` when `company.einvoice_transmitter is null`. `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` **422** — "the named transmitter is not registered in this deployment, or its credential secret is not set", raised by `transmitterFor()` and by `readSecret()`; **this is the fail-closed code the OD-15 default produces** — a company set to `myinvois` before Task 9 has run gets it, and gets it from the registry rather than from a network timeout. `ERR_EINVOICE_STATUS_ILLEGAL` **409** — "transmission `<id>` is `<status>`; `<verb>` is legal only from `<states>`", raised by the state machine of §4.9.3 as Task 5 fixes it. Each lands in `ERRORS` in the PR that raises it. |
| **2** | 4.2.6 | **`JobPayload` gains the one 5B-owned key: `"accounting.tax.submit": { transmissionId: string; phase: "submit" \| "poll" }`, and `JOB_PROBES` gains an entry for it** (hazard 31). ⚠️ **The key is written into §4.2.6's `JobPayload` code fence, not into a table** — a table cell forces the pipe to be escaped as `\|`, and the gate script's fixed-string search for `"accounting.tax.submit": { transmissionId: string;` stops short of the pipe for exactly that reason. **`JOBS` itself is not edited** — the name and its `schedule: null` are already in 0B's closed sixteen-name const with `owner: "5B"`. The `phase` member is what lets one name carry both halves of spec:2225's "retry and status reconciliation" without a seventeenth job name: the `submit` handler re-enqueues itself as `poll` with `startAfterSeconds` while the remote status is `submitted`. Options are fixed at `{ singletonKey: transmissionId, retryLimit: 8, retryDelaySeconds: 60 }` — the `retryLimit 8` §4.9.3 already states, and pg-boss's exponential backoff. |
| **3** | 4.3.2 | **Step 14's e-invoicing clause is realised here, and it does *not* fail closed.** After step 13, `postDocument` enqueues `accounting.tax.submit` when **all three** of `policy.tax.applies`, `policy.tax.einvoice` and `company.einvoice_transmitter is not null` hold — and **before** the enqueue it inserts the `app.einvoice_transmission` row at `status = 'pending'` inside the posting transaction. **When `input.jobs` is absent it pushes `einvoice_enqueue_skipped: no job client` onto `PostResult.warnings` and skips the enqueue but still writes the row** — 4B amendment 2's shape, not 3B's fail-closed branch, and the difference is that the *durable row* is the state of record: the manual `POST …/einvoice-transmissions/{id}/submit` route and the poll phase both drive it, so a missed enqueue delays a transmission and loses nothing. Throwing here would break every 4A and 6A call site that supplies no `JobClient`. **`app.einvoice_transmission` joins §4.3.2's closed write list as `einvoice_transmission` (5B+).** The company row is read with one `select einvoice_transmitter from app.company where id = $1` in `post.ts`; **`DocumentSnapshot.company` is NOT widened** — §4.3.1's stubbed-field list is closed and `einvoiceTransmitter` is a new field, not a stubbed one. |
| **4** | 4.4.1 | **The policy `tax` block gains one optional property: `"einvoice": { "type": "boolean", "default": false }`.** The block becomes `"required": ["applies"]`, `"properties": { "applies": …, "inclusive": …, "einvoice": { "type": "boolean", "default": false } }` with `additionalProperties: false` unchanged. **Every existing policy keeps validating** — the property is optional and its absence means `false`, so 1A's `JOURNAL`, 2A's, 2B's and 2C's test types, and all of 3C's, 3D's, 4A's and 4B's seeded envelopes are untouched and no policy version is bumped by this slice. **This is the zero-code home for "which document types are transmitted", and that question is an ADR-0051 fact** (a jurisdiction's mandate covers some document classes and not others), so it must be data on the versioned, append-only policy rather than a list in TypeScript. The generated `PostingPolicy` type (ADR 0022) gains `tax.einvoice?: boolean` by regeneration, not by hand. |
| **5** | 4.9.3 | **The transmitter's remote shape is a *profile*, and the profile is data.** §4.9.3's five declarations are unchanged and are implemented verbatim. Added beside them: `EInvoiceProfile`, `EInvoiceCallSpec`, `EInvoiceAuthSpec` and `TRANSMISSION_STATUSES` in `packages/domain/src/tax/einvoice.ts`; the JSON Schema `packages/domain/einvoice-profile.schema.json`; the profile files at **`packages/db/einvoice-profiles/<code>.v<n>.json`** — deliberately **outside `packages/db/seed/`**, because 2C made `assertPackShape` derive its allowed-directory set from `SUB_PACKS` (§4.2.13) and an unregistered directory under `seed/my/` makes `bun run seed` exit 3; and `createHttpTransmitter({ profile, canonicalise, qrPayload, fetchImpl?, env? })` in `packages/db/src/einvoice/http-transmitter.ts`, which turns any conforming profile into an `EInvoiceTransmitter`. **`env?` is the environment `readSecret` resolves the credential name against**, defaulting to `process.env` — the seam every test injects through, because the secret is read inside `call()` *before* `fetchImpl` is ever invoked and a `fetch` wrapper therefore cannot supply it. **`canonicalise` and `qrPayload` are constructor parameters, not profile data** — their content is ADR-0051 prose, not a call shape, and a body-templating language would be exactly the over-building the judge panel rejects. **The `transmitter` vocabulary is closed at two codes** — `synthetic` and `myinvois` (`text` + `check`, §3.2): `synthetic` is the CI and `bun run dev` implementation and **is registered only when `appEnv !== "production"`**; `myinvois` is registered only by Task 9. ⚠️ **When this amendment is written into §4.9.3, the sentence above goes in ordinary prose and NOT inside a markdown table** — a table cell would force `synthetic \| myinvois`, and the gate script's fixed-string search for `The `transmitter` vocabulary is closed at` is what depends on it. The GCC/ZATCA pack stays deferred (spec:2226) and adds a third label when a customer there exists. |
| **6** | 4.9.3 | **`app.einvoice_transmission` ships §4.9.3's column list plus four, and `app.company` gains three columns in the same migration** (`0057`, §3.4.7's *expand* half on a live 0001 table). On the log: **`profile_version int`** (nullable — the version of the profile file the call was actually made with, written at submit, so an incident can be read against the file that produced it: this is LEGACY-013's "pinned versions" applied to an integration), **`qr_payload text`** (nullable — §4.9.3's `qrPayload` result, written when the status first reaches `accepted`, so the invoice template and the API return the payload the authority acknowledged rather than one recomputed later), **`polled_at timestamptz`** (nullable — **the last remote call that COMPLETED**, whether submit, poll or cancel: it makes the reconciliation job's own progress visible without reading pg-boss) and **`claimed_at timestamptz`** (nullable — **a remote call is in flight since this instant; null means none is**. Task 5 stamps it at claim and clears it the moment the call ends, in either direction, and a re-claim is refused only while it is set and younger than §4.2.9's 120-second window, reused rather than re-invented). **The two are separate columns and that is load-bearing:** one column cannot mean both "started and not yet finished" and "last finished", and conflating them refuses the `poll` that legitimately follows a `submit` seconds earlier and swallows every pg-boss retry that arrives inside the window. On `app.company`: **`einvoice_transmitter text`** (nullable; null = e-invoicing off — **one column carrying both the on/off and the choice, so a boolean and a name can never disagree**), **`einvoice_client_id text`** and **`einvoice_credential_ref text`** (the *name* of the secret, never its value — §4.9.3's `EInvoiceCredentials.secretRef` stored under a column name the §4.2.3 log filter will not eat). A `check` requires all three non-null together or all three null. |
| **7** | 4.2.7 | **One new route module: `/v1/companies/:companyId/einvoice-transmissions` → `einvoiceTransmissionRoutes` (module const `einvoiceTransmissionRouteModule`), slice 5B, gate `accounting.tax.file`**, with sub-paths `GET …` (list), `GET …/{transmissionId}`, `POST …/{transmissionId}/submit`, `POST …/{transmissionId}/cancel`. **One `PROBES` key.** **The company e-invoice settings are two sub-paths on 0B's existing `companyRoutes`** — `GET /v1/companies/{companyId}/einvoice-settings` and `PUT /v1/companies/{companyId}/einvoice-settings` — gated `admin.company.manage`, because §3.6.2 already places company configuration under that code and 2B set the precedent of adding sub-paths to another slice's module; they inherit `companyRoutes`' `PROBES` key and **this slice mounts no second module on `/v1/companies`**. **§4.2.7's table has no 5A row**, so if 5A shipped a `tax-codes` or `tax-returns` module its rows are 5A's to add and this slice touches neither. |
| **8** | 3.6.4 | **`accounting.tax.file` → `accountant`.** spec:2158 gives the head-office bookkeeper "tax returns"; §3.6.4 requires every introducing slice to add its row to that sentence in the same PR. `admin`'s array is computed and is never edited. No `INCOMPATIBLE_PAIRS` entry involves the code, and it is `mutating: true`, so R7 holds for `auditor` (which does not receive it) and the route gate holds for the two unsafe routes. |
| **9** | 3.11 | **One new environment name: `EINVOICE_CLIENT_SECRET`** — holder **api, worker**; set by **5B** (the name), **OD-15** (the value); meaning "the client secret the transmitter presents; referenced by `company.einvoice_credential_ref`, never stored in the database". It joins `containerSecrets(env, entrypoint)` in the same PR (§3.11's closing rule). **It is one fixed name, not a pattern**, because `containerSecrets` enumerates bindings explicitly and a wildcard cannot be added there; `EINVOICE_SECRET_NAMES = ["EINVOICE_CLIENT_SECRET"] as const` in `packages/db/src/einvoice/credentials.ts` is what `einvoice_credential_ref` is validated against, so an admin cannot point the column at `DATABASE_URL`. A second authority adds a second name here and a second member there. |
| **10** | 4.17.1 + 4.2.12 | **Two registered helper files, one per tier, and the reason is the dependency rule.** §4.17.1 names exactly two workspaces outside `tests` that may import `tests/invariants/support/**` — `apps/worker/test/**` and `apps/api/test/**` — and `packages/db/test/**` is not one of them; adding it would point `packages/db/test` at a file that imports `@dulja/db/test`, which is a module cycle through `packages/db/test/index.ts`. So: **(a) `packages/db/test/support/einvoice-stub.ts`, owner 5B**, exporting `StubServer`, `StubScript`, `StubReply`, `StubCall`, `startStubServer(script)`, `SYNTHETIC_PROFILE_PATH`, `stubProfile()`, `snapshotFixture(overrides?)`, `enableEinvoice(db, s, opts?)` and `optInDocumentType(db, s, opts)` — **all ten, because §4.17.1's whole purpose is that the next slice reads this list before writing a helper of its own, and an export missing from it is invisible** — with no import outside `node:http`, `node:url`, `@dulja/domain` and `packages/db/test/{harness,fixtures}`, so `packages/db`'s own four test files reach it directly; and **`packages/db/package.json` `exports` gains `"./test/einvoice-stub": "./test/support/einvoice-stub.ts"`** (§4.2.12's established mechanism — 0C already added `"./provision/verify-supabase"` and `"./seed"` the same way), which is how `tests/**` and `apps/*/test/**` reach it. **(b) `tests/invariants/support/einvoice.ts`, owner 5B**, exporting `EinvoiceFixture` and `einvoiceFixture(db, s)` — built on **4B's `arApFixture` and `seedTypeFromPack`** plus the two functions from (a), so there is exactly **one** definition in the repository of "enable e-invoicing on this company" and "opt this document type in" (hazard 9). Consumed by `apps/api/test`, `apps/worker/test` and `tests/golden`. |
| **11** | 2.6 (the 5B card) + 3.4.2 | **The card's expected migration name `0057_create_einvoice_transmission.sql` becomes `0057_create_einvoice_transmission_and_alter_company_einvoice.sql`**, under §3.4.2's round-2 rule that "a file whose name understates what it does is renamed, not left" — the same settlement 2A's `0018_alter_document_party_fk_and_document_type_module.sql` and 2B's `0023_grant_document_draft_delete_and_add_series_gaps.sql` received. **And the card's "Target size 7–9 tasks" becomes 10–15**, which is the assignment's range for this plan and what the deliverables actually need: the card's estimate assumed every task after the first was OD-15-gated, and the profile design (amendment 5) makes eleven of the twelve tasks runnable and CI-green before OD-15 lands. **The card's owner-gate sentence is corrected on the count, not the substance:** "every adapter task" becomes "**one** isolated task (Task 9)", per hazard 6. |
| **12** | 4.16.2 | **`einvoice_transmission` is deliberately not a `DatasetId` member, and the register's *enumeration* is what says so.** §4.16.2's rule sentence — "7A creates the file with every dataset whose source tables all exist at Phase 5 (migration ≤ 0058)" — would sweep in a table created by migration 0057; its enumeration names `tax_transaction` and stops. The enumeration wins, because the rule's stated criterion is "**first report that reads it**" and **no v1 report reads the transmission log**: §4.16.1 is closed and has no e-invoicing row, `accounting.tax_return_view` is 7C's over `tax_transaction`, and the log is read through this slice's own route module. **7A therefore adds no member for it and 5B adds none**; a Phase 10 e-invoicing report amends §4.16.1 and §4.16.2 together. |
| **13** | 4.2.3 + 4.2.7 | **`AppEnv["Variables"]` gains a ninth member, `db: Sql`, set by the same two-line middleware in `createApp` that 3B's amendment A5 added for `jobs`; and §4.2.7's module table gains the 5B row `/v1/companies/:companyId/einvoice-transmissions → einvoiceTransmissionRoutes`, gate `accounting.tax.file`.** The member exists for exactly one handler: `cancelTransmission` brackets a network call between two short transactions (ADR 0053) and therefore takes the **pool**, which `c.var.withTenant` cannot supply. `scripts/lint/rules/no-bare-db.ts`'s allow-list gains `apps/api/src/routes/accounting/einvoice-transmissions.ts` and nothing else, so a second file reaching for the pool still fails the build. **The same amendment records the two sub-paths this slice adds to modules it does not own** — `GET\|PUT /v1/companies/{companyId}/einvoice-settings` on 0B's `companyRoutes` (gate `admin.company.manage`) and `POST /v1/companies/{companyId}/tax-returns/{taxReturnId}/file` on **5A's** `taxReturnRoutes` (gate `accounting.tax.file`, whose module `permissions` array gains the code). **This last clause supersedes amendment 7's sentence "if 5A shipped a `tax-codes` or `tax-returns` module its rows are 5A's to add and this slice touches neither"**: 5A's written plan says in terms that `generated → filed` is 5B's transition and that 5A writes neither `filed_at` nor `attachment_id`, so the sub-path is this slice's obligation and not an encroachment. Neither sub-path adds a `PROBES` key — §4.2.7's sub-path rule, 2B's precedent. **This amendment is 5B's only one that came from reading 5A's written plan rather than the contracts registry**, and the Assumptions block's RECONCILED paragraph is where it is argued. |

- [ ] **Step 2: Write the amendments gate script**

```bash
#!/usr/bin/env bash
# scripts/check/contracts-5b-amendments.sh
# Slice 5B's pre-flight. Two halves: the thirteen contracts amendments of Task 0, and the repository
# names Tasks 1-11 import from 5A, 4B and 3B. Exit 1 on the first missing thing.
#
# 5A's plan file did not exist when this plan was written, so its names came from the contracts
# registry. This script is where that assumption is tested, once, before any code depends on it.
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

note() { echo "NOTE: $*"; }

# ── The thirteen amendments ───
need_contract 'ERR_EINVOICE_TRANSMITTER_UNAVAILABLE' 1
need_contract 'ERR_EINVOICE_STATUS_ILLEGAL' 1
need_contract 'ERR_EINVOICE_NOT_ENABLED' 1
# Amendments 2 and 5 are searched by a fragment that stops BEFORE the pipe. Both sentences contain a
# `|`, and markdown forces `\|` inside a table cell — a `grep -qF` for the raw form would report
# MISSING against text that is present. Amendment 2's key belongs in §4.2.6's JobPayload code fence
# and amendment 5's vocabulary sentence outside any table; the amendment rows say so, and these two
# checks are written so that either spelling of the pipe still passes.
need_contract '"accounting.tax.submit": { transmissionId: string;' 2
need_contract 'einvoice_enqueue_skipped' 3
need_contract '`einvoice_transmission` (5B+)' 3
need_contract '"einvoice": { "type": "boolean", "default": false }' 4
need_contract 'packages/db/einvoice-profiles/<code>.v<n>.json' 5
need_contract 'createHttpTransmitter({ profile, canonicalise, qrPayload, fetchImpl?, env? })' 5
need_contract 'The `transmitter` vocabulary is closed at' 5
need_contract 'einvoice_credential_ref' 6
need_contract 'profile_version int' 6
need_contract '/v1/companies/:companyId/einvoice-transmissions' 7
need_contract 'einvoiceTransmissionRouteModule' 7
need_contract 'accounting.tax.file` → `accountant' 8
need_contract 'EINVOICE_CLIENT_SECRET' 9
need_contract 'tests/invariants/support/einvoice.ts' 10
need_contract 'packages/db/test/support/einvoice-stub.ts' 10
need_contract '"./test/einvoice-stub": "./test/support/einvoice-stub.ts"' 10
need_contract '0057_create_einvoice_transmission_and_alter_company_einvoice.sql' 11
need_contract 'einvoice_transmission` is deliberately not a `DatasetId' 12
need_contract 'tax-returns/{taxReturnId}/file' 13

# ── The consumed names: 5A (twelve named exports, five structural checks) ───
# Task 8 appends `fileTaxReturn` to 5A's returns.ts and one sub-path to 5A's route module, and its
# route reads four more 5A names; Task 10 posts its corpus through 5A's two §4.17.1 helpers. Every
# one is named here so a rename in 5A is found before a line of 5B is written, not at
# `bun run typecheck` in Task 8.
need_repo "packages/db/src/tax/returns.ts" "export async function generateTaxReturn" "5A's return generator (§4.9.1) — T8 appends fileTaxReturn beside it"
need_repo "packages/db/src/tax/returns.ts" "export async function createTaxReturn" "5A's period reservation — T8's twoTaxReturns fixture member calls it"
need_repo "packages/db/src/tax/returns.ts" "export async function getTaxReturn" "5A's single-return read — T8's /file handler builds TaxReturnDetail from it"
need_repo "packages/db/src/tax/returns.ts" "export async function taxReturnTieOut" "5A's tie-out — the fourth member of TaxReturnDetail, which T8's /file response must carry"
need_repo "packages/contracts/src/accounting/tax.ts" "export const TaxReturnDetail" "5A's detail schema — T8's /file route answers it and must match it member for member"
need_repo "apps/api/src/routes/accounting/tax-codes.ts" "export const TAX_PERMISSION" "5A's permission const — T8 appends EINVOICE_PERMISSION.file to taxReturnRouteModule.permissions beside it"
need_repo "apps/api/src/routes/accounting/tax-returns.ts" "taxReturnRoutes" "5A's route module — T8 adds one /file sub-path to it, and adds NO third module"
need_repo "tests/invariants/support/tax.ts" "export async function taxFixture" "5A's fixture (§4.17.1) — T10 posts its corpus through it; note it takes a NAME, not a Seed"
need_repo "tests/invariants/support/tax.ts" "export async function postTaxedDocument" "5A's post helper (§4.17.1) — T10's corpus loop"
need_repo "packages/domain/src/tax/index.ts" "malaysiaPack" "5A's jurisdiction pack (§4.9.1)"
need_repo "packages/domain/src/tax/index.ts" "TaxCodeDef" "5A's tax-code type (§4.9.1)"
need_repo "packages/db/test/fixtures.ts" "seedTaxCode" "5A's fixture helper (§4.17)"
need_repo "packages/contracts/permissions.ts" "accounting.tax.manage" "5A's permission code (§3.6.2)"
if ! ls packages/db/migrations/005[3-6]_*.sql >/dev/null 2>&1; then
  echo "MISSING (repo): no migration in 0053-0056 — 5A's range (§3.4.1) has not been applied"
  fail=1
fi
for t in tax_regime tax_code tax_transaction tax_return; do
  if ! grep -rqF "app.$t" packages/db/migrations/; then
    echo "MISSING (repo): app.$t appears in no migration — 5A's table (§4.9.2)"
    fail=1
  fi
done
if ! grep -rqF "tax_inclusive" packages/db/migrations/; then
  echo "MISSING (repo): document.tax_inclusive appears in no migration — §4.3.4, filled by 5A"
  fail=1
fi
if [ -d tests/golden/tax ]; then
  n=$(find tests/golden/tax -name 'expected.json' | wc -l | tr -d ' ')
  note "tests/golden/tax has $n case(s) — Task 10 Step 3 globs them; 0 means test 26 re-runs vacuously and Task 10 SKIPS with its named message instead of passing."
else
  echo "MISSING (repo): tests/golden/tax/ does not exist — 5A's corpus (§3.7.4), which Task 10 re-runs"
  fail=1
fi
if [ -f tests/regression/legacy-020.test.ts ]; then
  note "tests/regression/legacy-020.test.ts exists — Task 10 APPENDS a '— 5B' block and edits no earlier block (§3.7.3)."
else
  echo "MISSING (repo): tests/regression/legacy-020.test.ts — 5A creates it (§3.7.3); 5B only appends. Raise with 5A rather than creating it here."
  fail=1
fi

# ── The consumed names: 4B (five) ───
need_repo "tests/invariants/support/ar-ap.ts" "export async function arApFixture" "4B's fixture (§4.17.1)"
need_repo "tests/invariants/support/ar-ap.ts" "export async function seedTypeFromPack" "4B's pack reader (§4.17.1)"
need_repo "tests/invariants/support/ar-ap.ts" "export function packApproval" "4B's approval reader (§4.17.1)"
need_repo "tests/invariants/support/ar-ap.ts" "export const PACK_DIR" "4B's ABSOLUTE pack directory with a trailing separator (4B amendment 9). It is PACK_DIR and NOT PACK_ROOT: 4A's PACK_ROOT is the relative 'seed/my' readPackFile takes, and einvoiceFixture reads an envelope by absolute path"
need_repo "tests/invariants/support/ar-ap.ts" "computeTax" "5A amendment A13a's option on PostFromPackOptions — einvoiceFixture's postOptedInDocument needs a TAXED post"

# ── The consumed names: 3B (one) ───
need_repo "tests/invariants/support/post-inventory.ts" "export function recordingJobs" "3B's recording JobClient (§4.17.1) — einvoiceFixture passes it to postFromPack so step 14's enqueue is observable"

# ── Informational: what step 14 looks like today ───
if grep -qF "input.jobs" packages/db/src/posting/post.ts; then
  note "post.ts already reads input.jobs (3B amendment A5) — Task 6 adds a clause, it does not add the parameter."
else
  echo "MISSING (repo): input.jobs is not in packages/db/src/posting/post.ts — 3B amendment A5 has not landed; Task 6 cannot add a clause to a parameter that does not exist."
  fail=1
fi
if grep -qF "SALES_INVOICE" packages/db/seed/my/document-types/SALES_INVOICE.json 2>/dev/null; then
  note "4A's SALES_INVOICE envelope is on disk — einvoiceFixture opts THAT type in at policyVersion + 1."
else
  echo "MISSING (repo): packages/db/seed/my/document-types/SALES_INVOICE.json — 4A's envelope (§4.14), which einvoiceFixture reads"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "5B pre-flight FAILED. Task 1 does not start until this exits 0."
  exit 1
fi
echo "5B pre-flight OK — thirteen amendments landed, every consumed name present."
```

- [ ] **Step 3: Write the hazard-2 grep**

This is the mechanical half of Global Constraint 13. It is a separate script because Task 11 runs it in CI on every PR forever, while the amendments gate is a one-time pre-flight.

```bash
#!/usr/bin/env bash
# scripts/check/no-authority-literals.sh
# Hazard 2 made mechanical. No LHDN/MyInvois host, path, header, field or version literal may appear
# anywhere in the e-invoicing surface except:
#   - packages/db/einvoice-profiles/*.json  (profile DATA; myinvois.v1.json comes from ADR 0051)
#   - docs/adr/0051-*.md                    (the record of the authority's own documentation)
#   - tests/ and *.test.ts                  (127.0.0.1 stub servers)
# Exit 1 on any hit, naming file and line.
set -uo pipefail
fail=0

SURFACE=(
  "packages/domain/src/tax/einvoice.ts"
  "packages/db/src/einvoice"
  "apps/worker/src/handlers/accounting-tax-submit.ts"
  "apps/api/src/routes/accounting/einvoice-transmissions.ts"
  "packages/contracts/src/accounting/einvoice.ts"
)

# 1. No absolute URL in the code surface at all. A base URL belongs to a profile file.
for path in "${SURFACE[@]}"; do
  [ -e "$path" ] || continue
  if grep -rn --include='*.ts' -E 'https?://' "$path" | grep -v '127\.0\.0\.1' | grep -v 'json-schema\.org' | grep -v 'dulja'; then
    echo "FORBIDDEN: an absolute URL in the e-invoicing code surface — a base URL is profile DATA (hazard 2)"
    fail=1
  fi
done

# 2. No authority-shaped identifier anywhere outside the three permitted homes.
#    THE TWO WORDS BELOW ARE THE ONLY ONES THIS SCRIPT MAY CONTAIN, and the reason is hazard 2
#    itself: a denylist of "LHDN field names" would have to be written from somewhere, and the only
#    somewhere available before ADR 0051 exists is training data — which is exactly what spec:2467
#    and hazard 2 forbid. `myinvois` and `lhdn` are attested by the project's own documents
#    (rebuild-spec.md and the contracts document both name them); nothing else is. A wider list is
#    GENERATED from ADR 0051 by whoever discharges OD-15, in the same PR as the profile file, and it
#    is never guessed here. Rule 1 (the absolute-URL ban) and rules 3-4 are the real guard.
WORDS='myinvois|lhdn'
if grep -rn -E "$WORDS" \
    --include='*.ts' --include='*.tsx' --include='*.sql' \
    packages/ apps/ scripts/ 2>/dev/null \
  | grep -v '\.test\.ts:' \
  | grep -viE 'transmitter|MYINVOIS_|"myinvois"|myinvois\.v[0-9]+\.json|einvoice/myinvois\.ts' ; then
  echo "FORBIDDEN: an authority-defined identifier in source. Only the transmitter CODE string 'myinvois',"
  echo "           the profile file name, and packages/db/src/einvoice/myinvois.ts (Task 9, from ADR 0051)"
  echo "           may carry it. Everything else is an invented value (hazard 2, spec:2226, spec:2467)."
  fail=1
fi

# 3. Before Task 9 has run, myinvois.v1.json must not exist. After it, it must cite ADR 0051.
if [ -f packages/db/einvoice-profiles/myinvois.v1.json ]; then
  if ! grep -qF '0051' packages/db/einvoice-profiles/myinvois.v1.json; then
    echo "FORBIDDEN: packages/db/einvoice-profiles/myinvois.v1.json has no \"source\" citing ADR 0051."
    echo "           A profile whose values cite no authority document is a training-data guess."
    fail=1
  fi
  if [ ! -f docs/adr/0051-verified-lhdn-myinvois-requirement-set.md ]; then
    echo "FORBIDDEN: myinvois.v1.json exists but ADR 0051 does not. OD-15 has not been discharged."
    fail=1
  fi
fi

# 4. The synthetic profile must never point anywhere but loopback.
if [ -f packages/db/einvoice-profiles/synthetic.v1.json ]; then
  if ! grep -qE '"baseUrl": *"http://127\.0\.0\.1' packages/db/einvoice-profiles/synthetic.v1.json; then
    echo "FORBIDDEN: synthetic.v1.json's baseUrl is not loopback. The CI transmitter never leaves the host."
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "hazard-2 check FAILED."
  exit 1
fi
echo "hazard-2 check OK — no authority literal outside a profile file, ADR 0051 or a test."
```

- [ ] **Step 4: Add the root script and run both gates**

Add to the root `package.json` `scripts`:

```json
"check:5b": "bash scripts/check/contracts-5b-amendments.sh && bash scripts/check/no-authority-literals.sh"
```

Run it:

```bash
chmod +x scripts/check/contracts-5b-amendments.sh scripts/check/no-authority-literals.sh
bun run check:5b
```

**Expected output before Step 1's edits are made** — twenty-two `MISSING (contracts amendment …)` lines (one per `need_contract` call) followed by `5B pre-flight FAILED`. **Expected output after Step 1 and with 5A, 4B and 3B merged** — the four `NOTE:` lines, then `5B pre-flight OK — thirteen amendments landed, every consumed name present.` and `hazard-2 check OK …`, exit 0.

**Read the four `NOTE:` lines rather than skimming past them.** They change what two later tasks do:
- the `tests/golden/tax` case count decides whether Task 10 Step 3 asserts or **skips with a named message** — a vacuous re-run of test 26 is worse than a visible skip;
- `legacy-020.test.ts`'s presence decides whether Task 10 Step 6 appends or **stops and raises with 5A** (§3.7.3 makes 5A the creator and 5B has a fixed position, so create-if-absent is 9A's licence and not this slice's);
- `post.ts`'s `input.jobs` decides nothing but must be true, and the script fails rather than noting it, because Task 6 is a clause inside that branch;
- `SALES_INVOICE.json`'s presence is what `einvoiceFixture` reads; if 4A named the file differently, **fix the fixture, not the pack**.

- [ ] **Step 5: Commit**

```bash
git add scripts/check/contracts-5b-amendments.sh scripts/check/no-authority-literals.sh package.json docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
git commit -m "$(cat <<'EOF'
chore(ci): 5B contracts amendments, the 5A/4B repo gate and the hazard-2 grep [5B T0]

Thirteen register amendments (errors, job payload, step 14, the policy tax block,
the profile mechanism, the 0057 columns, the route module, the accountant grant,
EINVOICE_CLIENT_SECRET, the test helper file, the 0057 rename, the DatasetId
non-membership, and the AppEnv `db` member with the two sub-paths this slice adds
to modules it does not own) plus two gate scripts. No application code.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: Migration 0057 — `app.einvoice_transmission` and the three `app.company` columns

**The one table this slice creates, and the one live table it expands.** §4.9.3 fixes the log's columns; amendment 6 adds four (`profile_version`, `qr_payload`, `polled_at`, `claimed_at`) and the company's three. `app.company` is a migration-0001 table holding production rows, so the three columns are §3.4.7's **expand** half — nullable, no backfill, no contract half needed because nothing is dropped.

**Files:**
- Create: `packages/db/migrations/0057_create_einvoice_transmission_and_alter_company_einvoice.sql`
- Create: `packages/db/migrations/0057.down.sql`
- Create: `packages/db/src/schema/einvoice-transmission.ts`
- Create: `packages/db/test/einvoice/transmission-table.test.ts`
- Modify: `packages/db/src/schema/company.ts` — the three columns, and nothing else

**Interfaces**

- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit` (§4.1); `startDb`, `Db`, `Seed`, `seedTenant`, `withTenant` (the 4-argument test helper), `uuidv7`, `draftDocument`, `lintSchema`, `up`, `down`, `listApplied`, `MIGRATIONS_DIR`, `schemaFingerprint` (§4.1); `app.company`, `app.document`, `app.tenant` (migration 0001).
- Produces: table `app.einvoice_transmission` with §4.9.3's columns plus amendment 6's three; columns `app.company.einvoice_transmitter`, `.einvoice_client_id`, `.einvoice_credential_ref`; the Drizzle mirrors `einvoiceTransmission` and the three `company` fields.
- **`packages/db/src/lint-schema.ts` is NOT edited.** §3.5.3's row for `einvoice_transmission` is four dashes — the table is not in `NO_ID_TABLES`, not in `AUDIT_EXEMPT`, not in `IMMUTABLE` — and its note says why: "audited (status changes matter)". A status change from `submitted` to `rejected` is precisely the before/after image an incident responder needs, so the table is fully audited and fully updatable by `app_rw`. **A later task that reaches for `lint-schema.ts` has misread §3.5.3.**

- [ ] **Step 1: Write ADR 0052 as a proposal, and ask**

`docs/adr/0052-einvoice-transmitter-port-and-profile.md`. spec:95 requires a decision touching the data model or an external integration's security posture to be **proposed and asked before implementing**. This one does both.

```markdown
# 0052 — The e-invoice transmitter is a port and its remote shape is a profile

- Status: **proposed** (spec:95 — this touches the data model and an integration's security posture; do not merge the implementation before this is accepted)
- Date: 2026-09-05
- Slice: 5B

## Context

§4.9.3 freezes `EInvoiceTransmitter` — `canonicalise`, `qrPayload`, `submit`, `poll`, `cancel` —
and says in its own heading that "no LHDN endpoint, field, version or threshold appears in this
document or in any plan until ADR 0051 records them from the authority's current documentation".
spec:2226 and Part VII #3 (spec:2467) say the same twice more, and add: "do not rely on this
document or on training data".

That leaves a writing problem. A slice must ship an adapter, tests that run in CI, and a
transmission log whose state machine is exercised — before anyone has read the authority's
documentation. Two shapes were considered.

**Shape A — constants marked "per ADR 0051".** One TypeScript module with `const SUBMIT_PATH =
"<per ADR 0051>"` and a runtime throw. Every test is skipped until OD-15 lands, the state machine
is unexercised, the transmission log's retry and reconciliation are unproven, and Phase 5 closes
on a promise. It is also the placeholder pattern the plan discipline forbids outright.

**Shape B — the remote shape is data.** This is what Phase 8 already does with statutory rates:
spec:2229 says "no rate lives in code, and a rate change is a seed PR, not a release", and
§4.12.3 gives the rate table a JSON Schema and a version. The e-invoicing problem is the same
problem — a value the authority owns, which changes on the authority's schedule, and which nobody
on this team may guess.

## Decision

**The transmitter is a port; its remote shape is a versioned profile file validated against a
committed JSON Schema.**

1. `packages/domain/src/tax/einvoice.ts` holds §4.9.3's five declarations verbatim, plus
   `canonicalJson`, `EInvoiceProfile`, `EInvoiceCallSpec`, `EInvoiceAuthSpec` and
   `TRANSMISSION_STATUSES`. It is pure: no I/O, no `fetch`, no `node:` import.
2. `packages/domain/einvoice-profile.schema.json` says what a profile is: a base URL, one auth
   block, and exactly three call specs (`submit`, `poll`, `cancel`), each a method, a path
   template, a JSON Pointer to the status in the response, and a `statusMap` onto the six
   `TransmissionStatus` labels. **Nothing speculative is in the schema** — no pagination, no
   webhooks, no batching, no body templating.
3. A profile file lives at `packages/db/einvoice-profiles/<code>.v<n>.json`, **outside
   `packages/db/seed/`** (2C made `assertPackShape` derive its allowed directories from
   `SUB_PACKS`, so an unregistered directory under `seed/my/` makes `bun run seed` exit 3).
4. `createHttpTransmitter({ profile, canonicalise, qrPayload, fetchImpl? })` turns any conforming
   profile into an `EInvoiceTransmitter`.
5. **`canonicalise` and `qrPayload` are constructor parameters, not profile data.** Their content
   is prose in the authority's documentation, not a call shape; expressing them as a body-
   templating language would be over-building, and the judge panel's standing objection to
   over-building applies.
6. Two transmitter codes exist and the vocabulary is closed: `synthetic` (loopback only,
   registered when `appEnv !== "production"`) and `myinvois` (registered only by the OD-15 task,
   from ADR 0051).

## Consequences

- Every task of slice 5B ships running, CI-green code before OD-15 lands, and the transmission
  log's state machine, the retry, the reconciliation poll, the route module and step 14's three
  gates are all exercised against the synthetic profile.
- Discharging OD-15 is **one reviewed JSON file plus two functions**, not a rewrite. ADR 0051 is
  the file's `source`, and `scripts/check/no-authority-literals.sh` fails the build if the file
  exists without it.
- An authority's schema-version bump is `myinvois.v2.json` beside `v1`, with
  `einvoice_transmission.profile_version` recording which file each call was made with — LEGACY-013's
  "pinned versions" applied to an integration.
- A profile cannot express an authority that needs request signing, mutual TLS or a multi-step
  handshake. If ADR 0051 finds one, **the OD-15 task widens the schema's `auth` block and this
  ADR is superseded rather than stretched** — that widening is an explicit step of that task.
- The synthetic transmitter can produce fake acceptances, so it is refused in production twice:
  it is not registered when `appEnv === "production"`, and the settings route refuses the value.
```

**Ask before implementing.** Record the answer in the ADR's status line. If the answer is no, the fallback is Shape A and this slice's Tasks 4–8 shrink to interface declarations with skipped tests — raise that consequence rather than implementing it silently.

- [ ] **Step 2: Write the failing test first**

`packages/db/test/einvoice/transmission-table.test.ts`. It must fail with `relation "app.einvoice_transmission" does not exist` before the migration is written.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { down, listApplied, up } from "../../src/migrate";
import { MIGRATIONS_DIR, startDb, uuidv7, withTenant, type Db } from "../harness";
import { draftDocument, seedTenant, type Seed } from "../fixtures";

describe("migration 0057 — app.einvoice_transmission and the company e-invoice columns", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let docA: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "einvoice-a");
    b = await seedTenant(db, "einvoice-b");
    docA = await draftDocument(db, a);
  }, 180_000);

  afterAll(async () => {
    await db.stop();
  });

  it("carries §4.9.3's columns plus amendment 6's four, at the declared types", async () => {
    const rows = await db.admin<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable
        from information_schema.columns
       where table_schema = 'app' and table_name = 'einvoice_transmission'
       order by column_name`;
    const byName = new Map(rows.map((r) => [r.column_name, r]));

    // §4.9.3's own list.
    for (const c of ["company_id", "document_id", "transmitter", "external_id", "status",
                     "attempts", "last_error", "request_sha256", "response",
                     "submitted_at", "accepted_at", "cancelled_at", "created_at"]) {
      expect(byName.has(c), `§4.9.3 column ${c}`).toBe(true);
    }
    // Amendment 6's four.
    for (const c of ["profile_version", "qr_payload", "polled_at", "claimed_at"]) {
      expect(byName.has(c), `amendment 6 column ${c}`).toBe(true);
    }
    // The binding form of §3.3.
    expect(byName.get("id")!.data_type).toBe("uuid");
    expect(byName.get("tenant_id")!.is_nullable).toBe("NO");
    expect(byName.get("created_at")!.is_nullable).toBe("NO");
    expect(byName.get("attempts")!.is_nullable).toBe("NO");
    expect(byName.get("status")!.is_nullable).toBe("NO");
    expect(byName.get("request_sha256")!.data_type).toBe("bytea");
    expect(byName.get("response")!.data_type).toBe("jsonb");
    // No *_by column: the acting principal is the audit row's, and a transmission is not attributed.
    expect(rows.filter((r) => r.column_name.endsWith("_by"))).toHaveLength(0);
  });

  it("forces RLS, names the policy tenant_isolation, and audits", async () => {
    const [t] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity
        from pg_class where oid = 'app.einvoice_transmission'::regclass`;
    expect(t!.relrowsecurity).toBe(true);
    expect(t!.relforcerowsecurity).toBe(true);

    const policies = await db.admin<{ policyname: string; permissive: string }[]>`
      select policyname, permissive from pg_policies
       where schemaname = 'app' and tablename = 'einvoice_transmission' order by policyname`;
    expect(policies.map((p) => p.policyname)).toEqual(["tenant_isolation"]);

    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger
       where tgrelid = 'app.einvoice_transmission'::regclass and not tgisinternal order by tgname`;
    expect(triggers.map((t2) => t2.tgname)).toContain("audit_row");
  });

  it("refuses a status, a transmitter and a credential ref outside their vocabularies", async () => {
    // ONE failing statement per `withTenant`. `withTenant` is one transaction (§4.2.2), and a
    // rejected statement aborts it: a second statement in the same block fails with SQLSTATE 25P02
    // ("current transaction is aborted") whose message names no CHECK constraint, so the second
    // assertion could never match its pattern. Each refusal therefore gets its own transaction.
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const id = await uuidv7(db.admin);
      await expect(tx`
        insert into app.einvoice_transmission (id, tenant_id, company_id, document_id, transmitter, status)
        values (${id}, ${a.tenant}, ${a.company}, ${docA}, 'synthetic', 'posted')
      `).rejects.toThrow(/einvoice_transmission_status_check/);
    });

    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const id = await uuidv7(db.admin);
      await expect(tx`
        insert into app.einvoice_transmission (id, tenant_id, company_id, document_id, transmitter, status)
        values (${id}, ${a.tenant}, ${a.company}, ${docA}, 'zatca', 'pending')
      `).rejects.toThrow(/einvoice_transmission_transmitter_check/);
    });

    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(tx`
        update app.company set einvoice_transmitter = 'synthetic',
                               einvoice_client_id = 'client-a',
                               einvoice_credential_ref = 'DATABASE_URL'
         where id = ${a.company}
      `).rejects.toThrow(/company_einvoice_credential_ref_check/);
    });
  });

  it("requires the three company columns together or not at all", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(tx`
        update app.company set einvoice_transmitter = 'synthetic' where id = ${a.company}
      `).rejects.toThrow(/company_einvoice_complete_check/);
    });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`
        update app.company set einvoice_transmitter = 'synthetic',
                               einvoice_client_id = 'client-a',
                               einvoice_credential_ref = 'EINVOICE_CLIENT_SECRET'
         where id = ${a.company}`;
      const [c] = await tx<{ einvoice_transmitter: string }[]>`
        select einvoice_transmitter from app.company where id = ${a.company}`;
      expect(c!.einvoice_transmitter).toBe("synthetic");
    });
  });

  it("holds one transmission per document (spec:2225 — a log, not a queue)", async () => {
    // TWO `withTenant` blocks, and the split is load-bearing for the NEXT `it` as well as this one.
    // `withTenant` is one transaction (§4.2.2); a unique violation aborts it, so Postgres turns the
    // enclosing COMMIT into a ROLLBACK and the successful first insert would never be persisted.
    // The following `it` counts tenant A's rows and expects 1, so keeping both statements in one
    // block would make this `it` pass and the next one fail — the same hazard the vocabulary `it`
    // three above already splits for, applied to a SUCCESS followed by a refusal rather than to two
    // refusals.
    const first = await uuidv7(db.admin);
    const second = await uuidv7(db.admin);

    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.einvoice_transmission (id, tenant_id, company_id, document_id, transmitter)
               values (${first}, ${a.tenant}, ${a.company}, ${docA}, 'synthetic')`;
    });

    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(tx`
        insert into app.einvoice_transmission (id, tenant_id, company_id, document_id, transmitter)
        values (${second}, ${a.tenant}, ${a.company}, ${docA}, 'synthetic')
      `).rejects.toThrow(/einvoice_transmission_tenant_id_document_id_key/);
    });

    // The committed row survived the aborted transaction that followed it.
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ id: string }[]>`select id::text as id from app.einvoice_transmission where document_id = ${docA}`,
    );
    expect(row!.id).toBe(first);
  });

  it("a second tenant cannot see it (spec:106)", async () => {
    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.einvoice_transmission`,
    );
    expect(seen[0]!.n).toBe(0);

    const own = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.einvoice_transmission`,
    );
    expect(own[0]!.n).toBe(1);

    // And tenant B cannot WRITE a row keyed to tenant A's document: the RLS `with check` refuses.
    await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const id = await uuidv7(db.admin);
      await expect(tx`
        insert into app.einvoice_transmission (id, tenant_id, company_id, document_id, transmitter)
        values (${id}, ${a.tenant}, ${a.company}, ${docA}, 'synthetic')
      `).rejects.toThrow();
    });
  });

  it("reports zero linter violations after 0057", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("up → down → up reproduces the schema byte for byte", async () => {
    const before = await schemaFingerprintOf(db);
    const applied = await listApplied(db.migrator);
    expect(await down(db.migrator, MIGRATIONS_DIR)).toEqual([...applied].reverse());
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(applied);
    expect(await schemaFingerprintOf(db)).toBe(before);
  }, 180_000);
});
```

**`schemaFingerprintOf` is a one-line local wrapper**, not a new shared helper: `schemaFingerprint` is exported from `packages/db/test/privileges.test.ts` (§4.1), and a file with a top-level `describe` must not be imported by another test file. Add at the top of this file, below the imports:

```ts
/** `schemaFingerprint` lives in privileges.test.ts, whose top-level `describe` makes it unimportable
 *  here. The three catalog queries are 0B's extended set (§3.4.6) reduced to what this file needs:
 *  columns, enum labels and app_rw grants. Two spellings of a fingerprint are fine when only one of
 *  them is ever compared to itself, which is the case in this file and nowhere else. */
async function schemaFingerprintOf(db: Db): Promise<string> {
  const cols = await db.admin<{ s: string }[]>`
    select coalesce(string_agg(t, '|' order by t), '') as s from (
      select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable as t
        from information_schema.columns where table_schema = 'app') q(t)`;
  const grants = await db.admin<{ s: string }[]>`
    select coalesce(string_agg(t, '|' order by t), '') as s from (
      select table_name || ':' || privilege_type as t
        from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app') q(t)`;
  return `${cols[0]!.s}##${grants[0]!.s}`;
}
```

Run it and see it fail:

```bash
bun run --cwd packages/db test -- einvoice/transmission-table
```

**Expected failure:** `error: relation "app.einvoice_transmission" does not exist` on the first `it`.

- [ ] **Step 3: Write the up migration**

`packages/db/migrations/0057_create_einvoice_transmission_and_alter_company_einvoice.sql`:

```sql
-- 0057 — e-invoicing: the transmission log and the company's transmitter settings.
--
-- spec:2225 "E-invoicing / fiscalisation as a pluggable jurisdiction pack with document hash,
--            QR code, transmission log, retry, and status reconciliation."
-- spec:2226 The requirement set is verified against the authority's own documentation (ADR 0051).
--            NOTHING in this file names an endpoint, a field, a version or a threshold.
-- §4.9.3    The column list; amendment 6 adds profile_version, qr_payload, polled_at, claimed_at.
-- §3.4.7    app.company holds production rows, so its three columns are the EXPAND half: nullable,
--            no backfill, and the down drops only the columns (§3.4.5).

-- ── 1. the transmission log ───────────────────────────────────────────────────────────────────
create table app.einvoice_transmission (
  id               uuid primary key default uuidv7(),                      -- spec:2037
  tenant_id        uuid not null references app.tenant(id),                -- spec:106
  company_id       uuid not null,
  document_id      uuid not null,
  transmitter      text not null,                                          -- 'synthetic' | 'myinvois'
  profile_version  int,                                                    -- amendment 6: LEGACY-013 pinning
  external_id      text,                                                   -- the authority's own id
  status           text not null default 'pending',                        -- §4.9.3's six labels
  attempts         int  not null default 0,                                -- spec:2225 "retry"
  last_error       text,
  request_sha256   bytea,                                                  -- sha256 of the canonical payload
  response         jsonb,                                                  -- REDACTED (ADR 0053)
  qr_payload       text,                                                   -- amendment 6; spec:2225 "QR code"
  submitted_at     timestamptz,
  accepted_at      timestamptz,
  cancelled_at     timestamptz,
  polled_at        timestamptz,                                            -- amendment 6: the last COMPLETED remote
                                                                           -- call (submit, poll or cancel), so a
                                                                           -- transmission stuck at 'submitted' is
                                                                           -- readable without querying pg-boss
  claimed_at       timestamptz,                                            -- amendment 6: a call IN FLIGHT since this
                                                                           -- instant; null = no call in flight. Task 5
                                                                           -- sets it at claim and clears it the moment
                                                                           -- the call ends, in either direction. It is
                                                                           -- a SEPARATE column from polled_at because
                                                                           -- one column cannot mean both "started, not
                                                                           -- yet finished" and "last finished" — and
                                                                           -- conflating them refuses the poll that
                                                                           -- legitimately follows a submit
  created_at       timestamptz not null default now(),                     -- spec:106

  unique (tenant_id, id),                                                  -- §3.5.1 step 1
  unique (tenant_id, document_id),                                         -- §4.9.3 "unique (document_id)"
  foreign key (tenant_id, company_id)  references app.company  (tenant_id, id),
  foreign key (tenant_id, document_id) references app.document (tenant_id, id),

  constraint einvoice_transmission_transmitter_check
    check (transmitter in ('synthetic', 'myinvois')),                      -- §3.2: text + CHECK, never an enum (§3.4.4)
  constraint einvoice_transmission_status_check
    check (status in ('pending', 'submitted', 'accepted', 'rejected', 'cancelled', 'error')),
  constraint einvoice_transmission_attempts_check
    check (attempts >= 0),
  constraint einvoice_transmission_profile_version_check
    check (profile_version is null or profile_version > 0),
  -- A status that names a remote object must carry the remote object's id. 'rejected' may or may
  -- not: an authority that refuses at the door returns no id, and one that refuses after intake does.
  constraint einvoice_transmission_external_id_check
    check (status not in ('submitted', 'accepted', 'cancelled') or external_id is not null),
  -- The three timestamps are set once and never cleared, so a cancelled transmission keeps the
  -- accepted_at that preceded it. An equality here would forbid exactly that (LEGACY-041's shape).
  constraint einvoice_transmission_accepted_at_check
    check (status <> 'accepted' or accepted_at is not null),
  constraint einvoice_transmission_cancelled_at_check
    check (status <> 'cancelled' or cancelled_at is not null),
  constraint einvoice_transmission_qr_payload_check
    check (qr_payload is null or status in ('accepted', 'cancelled'))
);

comment on table app.einvoice_transmission is
  'One row per document transmitted to a fiscalisation authority (spec:2225). Never deleted: a '
  'cancellation is status = ''cancelled'' (spec:2049).';
comment on column app.einvoice_transmission.response is
  'The REDACTED remote response (ADR 0053). Never an authorization header, never a credential.';

-- The list route filters (company, status) and the reconciliation sweep reads (status, polled_at) to
-- find the transmissions whose last completed call is oldest.
create index einvoice_transmission_company_status_idx
  on app.einvoice_transmission (tenant_id, company_id, status);
create index einvoice_transmission_open_idx
  on app.einvoice_transmission (tenant_id, status, polled_at)
  where status in ('pending', 'submitted', 'error');

-- ── 2. RLS and audit (§3.5.1 steps 2 and 3) ───────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.einvoice_transmission');
-- §3.5.3 puts this table in NO set: it is audited, has an id and a created_at, and is mutable —
-- a status change from 'submitted' to 'rejected' is exactly the before/after image LEGACY-029/030
-- exist to preserve. No attach_stamp: the table has no *_by column and never gains one (§3.3).
call app_meta.attach_audit('app.einvoice_transmission');

-- ── 3. the company's transmitter settings (§3.4.7 expand) ─────────────────────────────────────
alter table app.company
  add column einvoice_transmitter    text,   -- null = e-invoicing OFF for this company (one column,
                                             -- so an on/off flag and a name can never disagree)
  add column einvoice_client_id      text,
  add column einvoice_credential_ref text;   -- the NAME of the secret, never the value (§4.9.3)

alter table app.company
  add constraint company_einvoice_transmitter_check
    check (einvoice_transmitter is null or einvoice_transmitter in ('synthetic', 'myinvois')),
  add constraint company_einvoice_complete_check
    check (num_nonnulls(einvoice_transmitter, einvoice_client_id, einvoice_credential_ref) in (0, 3)),
  -- The ref may name only an EINVOICE_* environment variable, so an admin cannot point it at
  -- DATABASE_URL and have the transmitter read a connection string into an Authorization header.
  -- §3.11's enumerated name is EINVOICE_CLIENT_SECRET; the pattern admits a second authority's.
  add constraint company_einvoice_credential_ref_check
    check (einvoice_credential_ref is null or einvoice_credential_ref ~ '^EINVOICE_[A-Z0-9_]+$');

comment on column app.company.einvoice_credential_ref is
  'The NAME of the environment secret the transmitter presents (§3.11). Never the value.';
```

- [ ] **Step 4: Write the down migration**

`packages/db/migrations/0057.down.sql`:

```sql
-- 0057 down. §3.4.5: reverse dependency order; app.company is a 0001 table, so its COLUMNS are
-- dropped and the table is not. After down(sql, dir) to 0 there must be zero tables in schema app,
-- and dropping app.company here would make 0001's own down fail.
alter table app.company
  drop constraint if exists company_einvoice_credential_ref_check,
  drop constraint if exists company_einvoice_complete_check,
  drop constraint if exists company_einvoice_transmitter_check;

alter table app.company
  drop column if exists einvoice_credential_ref,
  drop column if exists einvoice_client_id,
  drop column if exists einvoice_transmitter;

-- Dropping the table takes its indexes, its tenant_isolation policy and its audit_row trigger with it.
drop table if exists app.einvoice_transmission;
```

- [ ] **Step 5: Write the Drizzle mirrors**

`packages/db/src/schema/einvoice-transmission.ts` (§3.4.9 — every slice that creates a table adds its mirror in the same PR):

```ts
// packages/db/src/schema/einvoice-transmission.ts
import { customType, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** `bytea` has no first-class Drizzle column; the mirror is a read model and `Buffer` is what
 *  postgres.js hands back for it, so the custom type states that rather than pretending it is text. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const einvoiceTransmission = app.table("einvoice_transmission", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  documentId: uuid("document_id").notNull(),
  transmitter: text("transmitter").notNull(),
  profileVersion: integer("profile_version"),
  externalId: text("external_id"),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  lastError: text("last_error"),
  requestSha256: bytea("request_sha256"),
  response: jsonb("response"),
  qrPayload: text("qr_payload"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  polledAt: timestamp("polled_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

And in `packages/db/src/schema/company.ts`, **add three fields to the existing `company` table object and change nothing else**:

```ts
  einvoiceTransmitter: text("einvoice_transmitter"),
  einvoiceClientId: text("einvoice_client_id"),
  einvoiceCredentialRef: text("einvoice_credential_ref"),
```

Add `text` to that file's `drizzle-orm/pg-core` import list if it is not already there.

- [ ] **Step 6: Run the test to green**

```bash
bun run --cwd packages/db test -- einvoice/transmission-table
bun run --cwd packages/db db:lint
bun run typecheck && bun run lint && bun run lint:rules && bun run format:check
```

**Expected:** **eight** passing `it`s — columns, RLS/audit, the vocabulary refusals, the all-three-or-none rule, one-per-document, the second tenant, the linter and the reversibility round trip. (The vocabulary `it` opens three `withTenant`s, one per failing statement, and the one-per-document `it` opens three, and both are still one `it` each.) `db:lint` prints no violation and exits 0; the reversibility `it` takes the longest and must be green — a down that forgot a constraint changes the fingerprint's grants half and fails there rather than silently in Phase 6.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0057_create_einvoice_transmission_and_alter_company_einvoice.sql \
        packages/db/migrations/0057.down.sql \
        packages/db/src/schema/einvoice-transmission.ts packages/db/src/schema/company.ts \
        packages/db/test/einvoice/transmission-table.test.ts \
        docs/adr/0052-einvoice-transmitter-port-and-profile.md
git commit -m "$(cat <<'EOF'
feat(db): add einvoice_transmission and the company e-invoice columns [5B T1]

Migration 0057. §4.9.3's column list plus profile_version, qr_payload, polled_at
and claimed_at (contracts amendment 6 -- polled_at is the last COMPLETED remote
call and claimed_at is the one in flight; one column cannot be both); the three
app.company columns as the expand
half of §3.4.7 on a live 0001 table. Forced RLS, tenant_isolation, audit_row, a
two-tenant test and zero linter violations. lint-schema.ts is unchanged — §3.5.3
puts this table in no set. ADR 0052 is a proposal.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration 0058 — `accounting.tax.file`, the `accountant` grant, and the catalogue proof

**One permission code, one role grant, and the two build checks that keep §3.6 honest.** §3.6.2 assigns 5B exactly `accounting.tax.file` (`accounting`, mutating); spec:2158 gives the `accountant` "tax returns", which contracts amendment 8 records as the grant.

**Files:**
- Create: `packages/db/migrations/0058_seed_permission_phase5b.sql`
- Create: `packages/db/migrations/0058.down.sql`
- Create: `packages/db/test/einvoice/permission.test.ts`
- Modify: `packages/contracts/permissions.ts` — one entry in `PERMISSIONS`
- Modify: `packages/db/seed/roles.ts` — one code in `accountant.permissions`

**Interfaces**

- Consumes: `PERMISSIONS`, `PermissionDef`, `PermissionModule`, `PermissionAction`, `SliceId` (§4.2.5); `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` (§4.2.5); `app.permission` (migration 0001); `startDb`, `Db` (§4.1); 0B's `packages/db/test/permission-catalogue.test.ts` (not edited — it reads `PERMISSIONS` and the table and is what proves both directions).
- Produces: the row `('accounting.tax.file', 'accounting', true, …)` in `app.permission` and in `PERMISSIONS`; the code in `ROLES`' `accountant` entry.

- [ ] **Step 1: Write the failing test first**

`packages/db/test/einvoice/permission.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../seed/roles";
import { startDb, type Db } from "../harness";

describe("5B — accounting.tax.file (§3.6.2, contracts amendment 8)", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("is in the catalogue exactly once, mutating, module accounting, phase 5B", () => {
    const rows = PERMISSIONS.filter((p) => p.code === "accounting.tax.file");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.module).toBe("accounting");
    expect(rows[0]!.mutating).toBe(true);
    expect(rows[0]!.phase).toBe("5B");
  });

  it("is in app.permission with the same (module, mutating) after 0058", async () => {
    const [row] = await db.admin<{ module: string; mutating: boolean }[]>`
      select module, mutating from app.permission where code = 'accounting.tax.file'`;
    expect(row).toBeDefined();
    expect(row!.module).toBe("accounting");
    expect(row!.mutating).toBe(true);
  });

  it("is granted to accountant and to nobody else in the seed (spec:2158, amendment 8)", () => {
    const holders = ROLES.filter((r) => r.code !== "admin" && r.permissions.includes("accounting.tax.file"));
    expect(holders.map((r) => r.code)).toEqual(["accountant"]);
  });

  it("keeps R7: auditor holds no mutating code", () => {
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    const mutating = auditor.permissions.filter(
      (c) => PERMISSIONS.find((p) => p.code === c)?.mutating === true,
    );
    expect(mutating).toEqual([]);
  });

  it("introduces no incompatible pair (R6)", () => {
    for (const role of ROLES) {
      if (role.code === "admin") continue;
      for (const [x, y] of INCOMPATIBLE_PAIRS) {
        expect(
          role.permissions.includes(x) && role.permissions.includes(y),
          `${role.code} holds both ${x} and ${y}`,
        ).toBe(false);
      }
    }
  });
});
```

Run it:

```bash
bun run --cwd packages/db test -- einvoice/permission
```

**Expected failure:** `expected [] to have length 1` on the first `it` (the catalogue has no such row), and `expected undefined to be defined` on the second.

- [ ] **Step 2: Add the catalogue entry**

In `packages/contracts/permissions.ts`, inside `PERMISSIONS`, immediately after 5A's `accounting.tax.manage` entry (the array is grouped by module and then by introducing slice, §3.6.2's table order):

```ts
  {
    code: "accounting.tax.file",
    module: "accounting",
    mutating: true,
    description: "Submit, poll and cancel e-invoice transmissions to the fiscalisation authority",
    phase: "5B",
  },
```

`"file"` is already a member of `PermissionAction` (§4.2.5) and `"5B"` is already a member of `SliceId` — **neither union is edited**, and a plan that finds itself widening one has invented a code (hazard 26).

- [ ] **Step 3: Add the role grant**

In `packages/db/seed/roles.ts`, in the `accountant` entry's `permissions` array, beside `"accounting.tax.manage"`:

```ts
    "accounting.tax.file",
```

`admin.permissions` is **computed** from `PERMISSIONS` and is never edited (§3.6.4). No other role receives it: the `user` clerk drafts and does not file, the `auditor` holds no mutating code (R7), and `hr_payroll` files statutory returns under `hr.filing.generate`, which is 8D's.

- [ ] **Step 4: Write the migration and its down**

`packages/db/migrations/0058_seed_permission_phase5b.sql`:

```sql
-- 0058 — slice 5B's permission code.
-- §3.6.3: app.permission is GLOBAL (no RLS, read-only for app_rw), so it is migration data and not
-- seed-pack data (§3.4.8, hazard 10). The upsert is `do update` so a re-run corrects a description.
-- spec:2147 names accounting.tax.file in the v1 catalogue; §3.6.2 assigns it to slice 5B.
insert into app.permission (code, module, mutating, description) values
  ('accounting.tax.file', 'accounting', true,
   'Submit, poll and cancel e-invoice transmissions to the fiscalisation authority')
on conflict (code) do update
  set module      = excluded.module,
      mutating    = excluded.mutating,
      description = excluded.description;
```

`packages/db/migrations/0058.down.sql`:

```sql
-- 0058 down. Deletes exactly the codes 0058 inserted (§3.6.3) and nothing else.
delete from app.permission where code = 'accounting.tax.file';
```

- [ ] **Step 5: Prove all four files agree, then understand why NONE of them may be committed yet**

```bash
bun run --cwd packages/db test -- einvoice/permission
bun run --cwd packages/db test -- permission-catalogue
bun run lint:rules
```

**Expected with all four files present in the working tree:** the five `it`s of this task's file pass, 0B's `permission-catalogue.test.ts` passes **both directions**, `role-seed` is green, and `permission-catalogue` (the lint) is **red** with "`accounting.tax.file` has no reference" — because Task 8 is what writes the route that references it.

**⚠️ THIS TASK PRODUCES NO COMMIT OF ITS OWN, AND THAT IS THE WHOLE POINT OF STEP 6.** Three build checks bind these four files together and **no proper subset of them is green**:

| Committed alone | What goes red | Why |
|---|---|---|
| the migration `0058_*.sql` | **`permission-catalogue.test.ts`** | §3.6.3 asserts the `(code, module, mutating)` set in `app.permission` equals the set exported by `permissions.ts` — **both directions**. With the row seeded and the catalogue silent, the table→catalogue direction fails. |
| `permissions.ts` | **`lint:rules` → `permission-catalogue`** | §3.6.3: a catalogue code with no `PERMISSION.<code>` / `requirePermission('<code>')` reference in `apps/**` or `packages/**/src/**` fails the build. |
| `roles.ts` | **`lint:rules` → `role-seed`** | §3.6.3: a role holding a code not in the catalogue fails the build. |

Global Constraint 17 requires `bun run test`, `bun run lint:rules` and the rest green **after every task**, and §3.4.3 makes each commit's PR stand on its own. The only arrangement satisfying all three checks is **one commit containing the migration, the catalogue entry, the role grant, this task's test file and Task 8's route** — which is Task 8's commit.

**The earlier draft of this plan said the migration could be committed alone** on the grounds that "`app.permission` rows referenced by nothing break no build check". That is false: `permission-catalogue.test.ts` reads the table as well as the catalogue, and it is the table→catalogue direction that fails. The claim is retracted here rather than left for an executor to discover as a red CI run on a PR that looked complete.

**§3.4.3's "one migration per PR" is still satisfied:** `0058_seed_permission_phase5b.sql` is the *only* migration in Task 8's PR — that rule caps the number of migrations in a PR, it does not require a PR to contain nothing else.

- [ ] **Step 6: Do NOT commit — hand the whole task to Task 8 Step 1**

Leave all four files in the working tree and stop. Task 8 Step 1 re-runs this task's test as its own first assertion, and Task 8's `git add` names every one of these paths:

```
packages/db/migrations/0058_seed_permission_phase5b.sql
packages/db/migrations/0058.down.sql
packages/contracts/permissions.ts
packages/db/seed/roles.ts
packages/db/test/einvoice/permission.test.ts
```

**In practice, execute Task 2 immediately before Task 8 rather than carrying an uncommitted tree across Tasks 3–7.** Task 2 depends on nothing after Task 1 and Task 8 is where it lands, so the natural order is T0 → T1 → T3 → T4 → T5 → T6 → T7 → **T2 → T8** → T9 → T10 → T11. The task keeps its number because every cross-reference in this plan and in the contracts amendments names it, and renumbering a task to record an execution order is exactly the churn §3.4.1's "never renumber" rule exists to stop. The Execution handoff repeats this.

**If the working tree must be parked** (a reviewer wants Tasks 3–7 merged first and the four files cannot wait), park them on a branch — never as a partial commit. A commit in which `app.permission` and `PERMISSIONS` disagree is a red CI run by construction.

---

### Task 3: `@dulja/domain` — §4.9.3's port verbatim, `canonicalJson`, and the profile JSON Schema

**The pure half, and it imports nothing outside `packages/domain`.** §4.9.3's five declarations are copied character for character; beside them go `canonicalJson` (the deterministic serialiser the hash and the request body are both taken over), the profile types of ADR 0052, and `parseProfile`, which validates a candidate against the committed JSON Schema with the Ajv 1A already installed for `posting-policy.schema.json` (ADR 0022).

**No `node:` import appears in this file.** Hashing needs `node:crypto` and lives in `packages/db` (Task 4): `packages/domain` is imported by `packages/contracts`, which `apps/backoffice` bundles with Vite, and a `node:crypto` import there breaks the browser build. §4.2.1's "pure TS, no I/O, no framework" is what that sentence protects.

**Files:**
- Create: `packages/domain/einvoice-profile.schema.json`
- Create: `packages/domain/src/tax/einvoice.ts`
- Create: `packages/domain/test/tax/einvoice.test.ts`
- Modify: `packages/domain/src/tax/index.ts` — one `export * from "./einvoice";`

**Interfaces**

- Consumes: `Money`, `CurrencyCode` (§4.2.1, types only); `DocumentSnapshot`, `LineSnapshot` (§4.4.2); Ajv's **draft-2020-12 entry point `ajv/dist/2020`** (already a `packages/domain` dependency — 1A, ADR 0022, which imports it the same way for `posting-policy.schema.json`; the default `ajv` export is draft-07 only and cannot compile this schema).
- Produces (§4.9.3 verbatim, then ADR 0052's additions):

```ts
// packages/domain/src/tax/einvoice.ts
export interface EInvoiceDocument { documentId: string; number: string; issuedAt: string; supplier: unknown; buyer: unknown; lines: unknown[]; totals: unknown; hash: string }
export type TransmissionStatus = "pending" | "submitted" | "accepted" | "rejected" | "cancelled" | "error";
export interface EInvoiceCredentials { readonly clientId: string; readonly secretRef: string }
export interface EInvoiceTransmitter {
  readonly jurisdiction: "MY";
  canonicalise(doc: DocumentSnapshot): EInvoiceDocument;
  qrPayload(doc: EInvoiceDocument, receipt: { externalId: string }): string;
  submit(doc: EInvoiceDocument, credentials: EInvoiceCredentials): Promise<{ externalId: string; status: TransmissionStatus; raw: unknown }>;
  poll(externalId: string, credentials: EInvoiceCredentials): Promise<{ status: TransmissionStatus; raw: unknown }>;
  cancel(externalId: string, reason: string, credentials: EInvoiceCredentials): Promise<{ status: TransmissionStatus; raw: unknown }>;
}
// ADR 0052's additions
export const TRANSMISSION_STATUSES: readonly TransmissionStatus[];
export function isTransmissionStatus(value: unknown): value is TransmissionStatus;
export type Canonicaliser = (doc: DocumentSnapshot) => EInvoiceDocument;
export type QrPayloadBuilder = (doc: EInvoiceDocument, receipt: { externalId: string }) => string;
export function canonicalJson(value: unknown): string;                       // throws CanonicalJsonError
export class CanonicalJsonError extends Error {}
export type EInvoiceCallName = "submit" | "poll" | "cancel";
export type EInvoiceBodyKind = "document" | "cancellation" | "none";
export interface EInvoiceCallSpec { readonly method: "GET" | "POST" | "PUT" | "DELETE"; readonly pathTemplate: string; readonly body?: EInvoiceBodyKind; readonly externalIdPointer?: string; readonly statusPointer: string; readonly statusMap: Readonly<Record<string, TransmissionStatus>>; readonly errorPointer?: string }
export interface EInvoiceAuthSpec { readonly kind: "bearer"; readonly header: string; readonly scheme?: string; readonly clientIdHeader?: string }
export interface EInvoiceProfile { readonly code: "synthetic" | "myinvois"; readonly version: number; readonly jurisdiction: "MY"; readonly source: string; readonly baseUrl: string; readonly timeoutMs?: number; readonly auth: EInvoiceAuthSpec; readonly calls: Readonly<Record<EInvoiceCallName, EInvoiceCallSpec>> }
export class EInvoiceProfileError extends Error { readonly errors: { path: string; message: string }[] }
export function parseProfile(value: unknown): EInvoiceProfile;                // throws EInvoiceProfileError
export function resolvePointer(value: unknown, pointer: string): unknown;     // RFC 6901
export function renderPath(template: string, vars: Readonly<Record<string, string>>): string;
export function mapRemoteStatus(spec: EInvoiceCallSpec, raw: unknown): { status: TransmissionStatus; unmapped: string | null };
```

- [ ] **Step 1: Write the failing test first**

`packages/domain/test/tax/einvoice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  canonicalJson, CanonicalJsonError, EInvoiceProfileError, isTransmissionStatus,
  mapRemoteStatus, parseProfile, renderPath, resolvePointer, TRANSMISSION_STATUSES,
  type EInvoiceCallSpec,
} from "../../src/tax/einvoice";

const GOOD_PROFILE = {
  code: "synthetic",
  version: 1,
  jurisdiction: "MY",
  source: "slice 5B, Task 4 — a loopback stub. Not an authority.",
  baseUrl: "http://127.0.0.1:1/",
  timeoutMs: 5000,
  auth: { kind: "bearer", header: "Authorization", scheme: "Bearer", clientIdHeader: "X-Client-Id" },
  calls: {
    submit: {
      method: "POST", pathTemplate: "/documents", body: "document",
      externalIdPointer: "/id", statusPointer: "/state",
      statusMap: { queued: "submitted", ok: "accepted", refused: "rejected" },
      errorPointer: "/message",
    },
    poll: {
      method: "GET", pathTemplate: "/documents/{externalId}", body: "none",
      statusPointer: "/state", statusMap: { queued: "submitted", ok: "accepted", refused: "rejected" },
    },
    cancel: {
      method: "POST", pathTemplate: "/documents/{externalId}/cancel", body: "cancellation",
      statusPointer: "/state", statusMap: { void: "cancelled" },
    },
  },
} as const;

describe("§4.9.3 — TransmissionStatus", () => {
  it("is exactly the six labels of the contracts registry, in registry order", () => {
    expect(TRANSMISSION_STATUSES).toEqual([
      "pending", "submitted", "accepted", "rejected", "cancelled", "error",
    ]);
  });

  it("narrows a string and refuses anything else", () => {
    expect(isTransmissionStatus("accepted")).toBe(true);
    expect(isTransmissionStatus("posted")).toBe(false);
    expect(isTransmissionStatus(undefined)).toBe(false);
  });
});

describe("canonicalJson — the one deterministic serialiser (spec:2264, test 26)", () => {
  it("sorts object keys at every depth and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("keeps array order, which is line order", () => {
    expect(canonicalJson([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
  });

  it("is byte-identical across two calls on structurally equal inputs built in different key order", () => {
    const left = { total: { amount: "10.0000", currency: "MYR" }, lineNo: 1 };
    const right = { lineNo: 1, total: { currency: "MYR", amount: "10.0000" } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it("omits an undefined value rather than emitting null (a key that is absent stays absent)", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("renders a bigint as its decimal string (document.number is bigint | null)", () => {
    expect(canonicalJson({ number: 42n })).toBe('{"number":"42"}');
  });

  it("REFUSES a non-integer number — money is a string on this path (Global Constraint 4, LEGACY-019)", () => {
    expect(() => canonicalJson({ amount: 10.5 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ amount: 10.5 })).toThrow(/non-integer number at \/amount/);
  });

  it("REFUSES NaN, Infinity, a Date, a Map and a function, each naming its path", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite number at \/a/);
    expect(() => canonicalJson([1, Number.POSITIVE_INFINITY])).toThrow(/non-finite number at \/1/);
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/unsupported value at \/at/);
    expect(() => canonicalJson({ m: new Map() })).toThrow(/unsupported value at \/m/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported value at \/f/);
  });

  it("REFUSES a cycle rather than recursing (a snapshot is a tree; a cycle is a caller defect)", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle at \/self/);
  });
});

describe("resolvePointer — RFC 6901", () => {
  it("walks objects and arrays", () => {
    expect(resolvePointer({ a: { b: [10, 20] } }, "/a/b/1")).toBe(20);
  });
  it("decodes ~1 as / and ~0 as ~, in that order", () => {
    expect(resolvePointer({ "a/b": 1, "c~d": 2 }, "/a~1b")).toBe(1);
    expect(resolvePointer({ "a/b": 1, "c~d": 2 }, "/c~0d")).toBe(2);
  });
  it("returns undefined for a missing member rather than throwing", () => {
    expect(resolvePointer({ a: 1 }, "/b")).toBeUndefined();
    expect(resolvePointer({ a: [1] }, "/a/9")).toBeUndefined();
    expect(resolvePointer(null, "/a")).toBeUndefined();
  });
});

describe("renderPath", () => {
  it("substitutes and percent-encodes every variable", () => {
    expect(renderPath("/documents/{externalId}", { externalId: "a b/c" }))
      .toBe("/documents/a%20b%2Fc");
  });
  it("throws on a placeholder with no variable, naming it", () => {
    expect(() => renderPath("/documents/{missing}", {})).toThrow(/no value for {missing}/);
  });
  it("throws on a variable the template does not use, naming it — an unused variable is a profile bug", () => {
    expect(() => renderPath("/documents", { externalId: "x" })).toThrow(/unused variable externalId/);
  });
});

describe("mapRemoteStatus", () => {
  const spec = GOOD_PROFILE.calls.submit as unknown as EInvoiceCallSpec;

  it("maps a known remote label", () => {
    expect(mapRemoteStatus(spec, { state: "ok" })).toEqual({ status: "accepted", unmapped: null });
  });
  it("maps an UNKNOWN remote label to error and reports it, rather than throwing", () => {
    expect(mapRemoteStatus(spec, { state: "in_review" }))
      .toEqual({ status: "error", unmapped: "in_review" });
  });
  it("maps a missing status member to error and reports the absence", () => {
    expect(mapRemoteStatus(spec, { other: 1 })).toEqual({ status: "error", unmapped: "<absent>" });
  });
  it("stringifies a non-string remote label before looking it up", () => {
    const numeric = { ...spec, statusMap: { "200": "accepted" } } as unknown as EInvoiceCallSpec;
    expect(mapRemoteStatus(numeric, { state: 200 })).toEqual({ status: "accepted", unmapped: null });
  });
});

describe("parseProfile — the JSON Schema is the contract (ADR 0052)", () => {
  it("accepts a conforming profile and returns it typed", () => {
    const p = parseProfile(structuredClone(GOOD_PROFILE));
    expect(p.code).toBe("synthetic");
    expect(p.calls.submit.method).toBe("POST");
  });

  it("refuses an unknown transmitter code, naming the path", () => {
    const bad = { ...structuredClone(GOOD_PROFILE), code: "zatca" };
    expect(() => parseProfile(bad)).toThrow(EInvoiceProfileError);
    try { parseProfile(bad); } catch (e) {
      expect((e as EInvoiceProfileError).errors.map((x) => x.path)).toContain("/code");
    }
  });

  it("refuses a missing call, an unknown call, and an unknown property anywhere", () => {
    const noCancel = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    delete (noCancel.calls as Record<string, unknown>).cancel;
    expect(() => parseProfile(noCancel)).toThrow(/\/calls/);

    const extraCall = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    (extraCall.calls as Record<string, unknown>).batch = structuredClone(GOOD_PROFILE.calls.submit);
    expect(() => parseProfile(extraCall)).toThrow(/\/calls/);

    const extraProp = { ...structuredClone(GOOD_PROFILE), retryAfterHeader: "Retry-After" };
    expect(() => parseProfile(extraProp)).toThrow(/retryAfterHeader/);
  });

  it("refuses a statusMap value outside the six labels", () => {
    const bad = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    ((bad.calls as Record<string, Record<string, Record<string, string>>>).submit.statusMap).queued = "posted";
    expect(() => parseProfile(bad)).toThrow(/statusMap/);
  });

  it("refuses a non-loopback, non-http base URL and an empty statusMap", () => {
    expect(() => parseProfile({ ...structuredClone(GOOD_PROFILE), baseUrl: "ftp://x/" })).toThrow(/baseUrl/);
    const empty = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    ((empty.calls as Record<string, Record<string, unknown>>).submit).statusMap = {};
    expect(() => parseProfile(empty)).toThrow(/statusMap/);
  });

  it("refuses a path template that is not a rooted path (no host may hide in it)", () => {
    const bad = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    ((bad.calls as Record<string, Record<string, unknown>>).submit).pathTemplate = "http://elsewhere/x";
    expect(() => parseProfile(bad)).toThrow(/pathTemplate/);
  });

  it("refuses an auth kind other than bearer — widening the vocabulary is Task 9's step, not a caller's", () => {
    const bad = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    (bad.auth as Record<string, unknown>).kind = "hmac";
    expect(() => parseProfile(bad)).toThrow(/\/auth\/kind/);
  });

  it("refuses a profile with no source — a profile whose values cite nothing is a guess (hazard 2)", () => {
    const bad = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    delete bad.source;
    expect(() => parseProfile(bad)).toThrow(/source/);
  });

  it("refuses a submit call with no externalIdPointer — the CHECK in 0057 makes it mandatory", () => {
    // `einvoice_transmission_external_id_check` (Task 1) refuses status submitted/accepted/cancelled
    // with a null `external_id`. A profile whose submit call names no pointer would therefore make
    // `submitTransmission` raise a raw SQLSTATE 23514 from inside a worker job, past every typed
    // EInvoiceError. The schema is where that is caught, not the database.
    const bad = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    delete ((bad.calls as Record<string, Record<string, unknown>>).submit).externalIdPointer;
    expect(() => parseProfile(bad)).toThrow(/externalIdPointer/);
  });

  it("does NOT require externalIdPointer on a call that sends no document, even with `body` omitted", () => {
    // The clause is `if body === "document"` with `required: ["body"]`, so a call that omits `body`
    // altogether (the "none" default) is untouched by it. GOOD_PROFILE's poll and cancel already
    // carry no externalIdPointer, which is what makes this the negative half of the pair.
    const ok = structuredClone(GOOD_PROFILE) as Record<string, unknown>;
    const poll = (ok.calls as Record<string, Record<string, unknown>>).poll;
    expect(poll.externalIdPointer).toBeUndefined();
    delete poll.body;
    expect(() => parseProfile(ok)).not.toThrow();
  });
});
```

Run it:

```bash
bun run --cwd packages/domain test -- tax/einvoice
```

**Expected failure:** `Cannot find module '../../src/tax/einvoice'`.

- [ ] **Step 2: Write the profile JSON Schema**

`packages/domain/einvoice-profile.schema.json`. Committed beside `posting-policy.schema.json` and `report-definition.schema.json`, which is where §4.4.1 and §4.11.1 put a schema that is a contract.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://dulja.local/schemas/einvoice-profile.schema.json",
  "title": "E-invoice transmitter profile",
  "description": "The remote call shape of a fiscalisation authority, as DATA (ADR 0052). This schema names no authority's endpoint, field or version; a profile FILE does, and its `source` says which document those values came from (ADR 0051 for a real one).",
  "type": "object",
  "additionalProperties": false,
  "required": ["code", "version", "jurisdiction", "source", "baseUrl", "auth", "calls"],
  "properties": {
    "code": {
      "description": "The transmitter code. Closed vocabulary, matching app.company.einvoice_transmitter and app.einvoice_transmission.transmitter.",
      "enum": ["synthetic", "myinvois"]
    },
    "version": {
      "description": "The profile file's own version. Recorded on every transmission as profile_version (LEGACY-013).",
      "type": "integer",
      "minimum": 1
    },
    "jurisdiction": { "const": "MY" },
    "source": {
      "description": "Where these values came from. For a real profile this cites the ADR that recorded the authority's own current documentation. scripts/check/no-authority-literals.sh fails the build when a myinvois profile does not cite 0051.",
      "type": "string",
      "minLength": 8
    },
    "baseUrl": {
      "description": "Scheme, host and optional port. No path, no query: a path belongs to a call spec.",
      "type": "string",
      "pattern": "^https?://[A-Za-z0-9.:_-]+/?$"
    },
    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 120000, "default": 30000 },
    "auth": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "header"],
      "properties": {
        "kind": {
          "description": "One form only. If ADR 0051 finds the authority needs request signing, mutual TLS or a handshake, the OD-15 task WIDENS this enum and supersedes ADR 0052 — it does not stretch it.",
          "const": "bearer"
        },
        "header": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9-]{0,63}$" },
        "scheme": { "type": "string", "pattern": "^[A-Za-z]{1,32}$", "default": "Bearer" },
        "clientIdHeader": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9-]{0,63}$" }
      }
    },
    "calls": {
      "type": "object",
      "additionalProperties": false,
      "required": ["submit", "poll", "cancel"],
      "properties": {
        "submit": { "$ref": "#/$defs/call" },
        "poll": { "$ref": "#/$defs/call" },
        "cancel": { "$ref": "#/$defs/call" }
      }
    }
  },
  "$defs": {
    "call": {
      "type": "object",
      "additionalProperties": false,
      "required": ["method", "pathTemplate", "statusPointer", "statusMap"],
      "properties": {
        "method": { "enum": ["GET", "POST", "PUT", "DELETE"] },
        "pathTemplate": {
          "description": "A rooted path with {externalId} as the only permitted placeholder. It cannot carry a scheme or a host, so a profile cannot redirect one call away from baseUrl.",
          "type": "string",
          "pattern": "^/[A-Za-z0-9/_.,;:=@$&+~*'()-]*(\\{externalId\\}[A-Za-z0-9/_.,;:=@$&+~*'()-]*)?$"
        },
        "body": { "enum": ["document", "cancellation", "none"], "default": "none" },
        "externalIdPointer": { "$ref": "#/$defs/pointer" },
        "statusPointer": { "$ref": "#/$defs/pointer" },
        "statusMap": {
          "description": "The authority's own status labels, mapped onto §4.9.3's six. A label absent from this map becomes 'error' with the raw label recorded in last_error — never a silent 'accepted'.",
          "type": "object",
          "minProperties": 1,
          "additionalProperties": {
            "enum": ["pending", "submitted", "accepted", "rejected", "cancelled", "error"]
          },
          "propertyNames": { "type": "string", "minLength": 1, "maxLength": 64 }
        },
        "errorPointer": { "$ref": "#/$defs/pointer" }
      },
      "allOf": [
        {
          "description": "A call that names a remote object must be able to interpolate its id.",
          "if": { "properties": { "method": { "enum": ["GET", "PUT", "DELETE"] } } },
          "then": { "properties": { "pathTemplate": { "pattern": "\\{externalId\\}" } } }
        },
        {
          "description": "The submit call — the one that sends the document — MUST name where the authority's id comes back, because `einvoice_transmission_external_id_check` (migration 0057) refuses status submitted/accepted/cancelled with a null external_id. Without this clause a profile that omits externalIdPointer validates, submitTransmission sets the status the statusMap yields, and a raw SQLSTATE 23514 escapes a worker job as an unmapped database error instead of an EInvoiceError. `required: [\"body\"]` is deliberate: `body` defaults to \"none\", so a call that omits it is not the submit call and this clause must not fire on it.",
          "if": { "properties": { "body": { "const": "document" } }, "required": ["body"] },
          "then": { "required": ["externalIdPointer"] }
        }
      ]
    },
    "pointer": {
      "description": "RFC 6901 JSON Pointer with at least one reference token.",
      "type": "string",
      "pattern": "^(/([^/~]|~[01])*)+$",
      "maxLength": 256
    }
  }
}
```

- [ ] **Step 3: Write the module**

`packages/domain/src/tax/einvoice.ts`:

```ts
// packages/domain/src/tax/einvoice.ts
//
// The e-invoicing PORT (§4.9.3, verbatim) and the profile types of ADR 0052.
//
// This file is PURE: no `node:` import, no `fetch`, no filesystem. `packages/contracts` imports
// `packages/domain` and `apps/backoffice` bundles `packages/contracts` with Vite, so a `node:crypto`
// import here breaks the browser build. Hashing lives in `packages/db/src/einvoice/` (§4.2.1's
// "pure TS, no I/O, no framework").
//
// NOTHING in this file names an authority's endpoint, header, field or version (hazard 2, spec:2226).

import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import type { DocumentSnapshot } from "../posting/evaluate";
import schema from "../../einvoice-profile.schema.json" with { type: "json" };

// ── §4.9.3, verbatim ──────────────────────────────────────────────────────────────────────────

export interface EInvoiceDocument {
  documentId: string;
  number: string;
  issuedAt: string;
  supplier: unknown;
  buyer: unknown;
  lines: unknown[];
  totals: unknown;
  hash: string; /* sha256 of the canonical payload */
}

export type TransmissionStatus =
  | "pending" | "submitted" | "accepted" | "rejected" | "cancelled" | "error";

export interface EInvoiceCredentials {
  readonly clientId: string;
  readonly secretRef: string; /* name of the Cloudflare secret, never the value */
}

export interface EInvoiceTransmitter {
  readonly jurisdiction: "MY";
  canonicalise(doc: DocumentSnapshot): EInvoiceDocument;
  qrPayload(doc: EInvoiceDocument, receipt: { externalId: string }): string;
  submit(
    doc: EInvoiceDocument,
    credentials: EInvoiceCredentials,
  ): Promise<{ externalId: string; status: TransmissionStatus; raw: unknown }>;
  poll(
    externalId: string,
    credentials: EInvoiceCredentials,
  ): Promise<{ status: TransmissionStatus; raw: unknown }>;
  cancel(
    externalId: string,
    reason: string,
    credentials: EInvoiceCredentials,
  ): Promise<{ status: TransmissionStatus; raw: unknown }>;
}

// ── ADR 0052 — the six labels as data, and the two function types a profile needs ─────────────

/** Registry order, matching the CHECK in migration 0057 and the Zod enum in §4.2.8's DTOs. */
export const TRANSMISSION_STATUSES: readonly TransmissionStatus[] = [
  "pending", "submitted", "accepted", "rejected", "cancelled", "error",
];

const STATUS_SET: ReadonlySet<string> = new Set<string>(TRANSMISSION_STATUSES);

export function isTransmissionStatus(value: unknown): value is TransmissionStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

/** `canonicalise` and `qrPayload` as standalone types: `createHttpTransmitter` takes them as
 *  parameters because their CONTENT is ADR-0051 prose, not a call shape (ADR 0052 decision 5). */
export type Canonicaliser = (doc: DocumentSnapshot) => EInvoiceDocument;
export type QrPayloadBuilder = (doc: EInvoiceDocument, receipt: { externalId: string }) => string;

// ── canonicalJson — the one deterministic serialiser ──────────────────────────────────────────

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/**
 * Deterministic JSON: object keys sorted by code unit at every depth, arrays in order, no
 * whitespace. This is what the request body and the `request_sha256` digest are both taken over,
 * so two runs over the same document produce the same bytes and the same hash — acceptance test 26
 * ("byte-identical across runs", spec:2444) extended to the transmission payload.
 *
 * Deliberately narrow about what it accepts:
 *   - a non-integer `number` is REFUSED. Every money amount on this path is `Money.toString()`'s
 *     fixed 4-dp string or `Money.toJSON()`'s `{ amount, currency }` (Global Constraint 4); a float
 *     reaching here means someone re-derived an amount, which is LEGACY-019 in one line.
 *   - `undefined` OMITS its key, so an absent optional stays absent rather than becoming `null`.
 *   - `bigint` becomes its decimal string, because `DocumentSnapshot.header.number` is `bigint | null`.
 *   - a `Date`, a `Map`, a `Set`, a function or a class instance is REFUSED, naming its pointer: an
 *     authority payload is a tree of scalars and plain objects, and anything else serialises
 *     differently across runtimes.
 *   - a cycle is REFUSED rather than recursed.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();

  const emit = (node: unknown, path: string): string => {
    if (node === null) return "null";

    switch (typeof node) {
      case "boolean":
        return node ? "true" : "false";
      case "string":
        return JSON.stringify(node);
      case "bigint":
        return JSON.stringify(node.toString());
      case "number":
        if (!Number.isFinite(node)) {
          throw new CanonicalJsonError(`canonicalJson: non-finite number at ${path || "/"}`);
        }
        if (!Number.isInteger(node)) {
          throw new CanonicalJsonError(
            `canonicalJson: non-integer number at ${path || "/"} — money is a string on this path (§3.9, LEGACY-019)`,
          );
        }
        return String(node);
      case "object":
        break;
      default:
        throw new CanonicalJsonError(`canonicalJson: unsupported value at ${path || "/"}`);
    }

    const obj = node as object;
    if (seen.has(obj)) throw new CanonicalJsonError(`canonicalJson: cycle at ${path || "/"}`);
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const parts = obj.map((item, i) => emit(item, `${path}/${i}`));
        return `[${parts.join(",")}]`;
      }
      if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) {
        throw new CanonicalJsonError(`canonicalJson: unsupported value at ${path || "/"}`);
      }
      const record = obj as Record<string, unknown>;
      const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
      const parts = keys.map((k) => `${JSON.stringify(k)}:${emit(record[k], `${path}/${escapeToken(k)}`)}`);
      return `{${parts.join(",")}}`;
    } finally {
      seen.delete(obj);
    }
  };

  return emit(value, "");
}

/** RFC 6901 escaping, used only to build the pointer that appears in an error message. */
function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

// ── the profile ───────────────────────────────────────────────────────────────────────────────

export type EInvoiceCallName = "submit" | "poll" | "cancel";
export type EInvoiceBodyKind = "document" | "cancellation" | "none";

export interface EInvoiceCallSpec {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly pathTemplate: string;
  readonly body?: EInvoiceBodyKind;
  readonly externalIdPointer?: string;
  readonly statusPointer: string;
  readonly statusMap: Readonly<Record<string, TransmissionStatus>>;
  readonly errorPointer?: string;
}

export interface EInvoiceAuthSpec {
  readonly kind: "bearer";
  readonly header: string;
  readonly scheme?: string;
  readonly clientIdHeader?: string;
}

export interface EInvoiceProfile {
  readonly code: "synthetic" | "myinvois";
  readonly version: number;
  readonly jurisdiction: "MY";
  readonly source: string;
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly auth: EInvoiceAuthSpec;
  readonly calls: Readonly<Record<EInvoiceCallName, EInvoiceCallSpec>>;
}

export class EInvoiceProfileError extends Error {
  constructor(message: string, readonly errors: { path: string; message: string }[]) {
    super(message);
    this.name = "EInvoiceProfileError";
  }
}

/**
 * One Ajv instance for the process, compiled once — the shape 1A's `parsePolicy` uses (ADR 0022),
 * **including its entry point**. `einvoice-profile.schema.json` declares
 * `"$schema": "https://json-schema.org/draft/2020-12/schema"` and uses `$defs`, and Ajv's DEFAULT
 * export only knows draft-07: `ajv.compile(schema)` would throw
 * `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"` at module load and take
 * every importer of this barrel down with it. `ajv/dist/2020` is the 2020-12 entry point, and it is
 * what 1A (`parsePolicy`), 5A, 7A and 8A all import for the same reason.
 */
const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: false });
const validate = ajv.compile<EInvoiceProfile>(schema);

/**
 * Validate a candidate profile. Throws `EInvoiceProfileError` whose `errors` are
 * `{ path, message }` pairs with `path` a JSON Pointer into the rejected profile — the same shape
 * §4.4.2's `PolicyValidation.errors` produces, so a loader reports both alike.
 *
 * A malformed profile is a DEPLOYMENT defect, not a caller error, so this throws a plain named
 * class and not an `AppError`: the loader refuses to register the transmitter, and every caller
 * then gets `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` from the registry — fail-closed, and with a
 * message that names the file rather than a 500 from a network timeout.
 */
export function parseProfile(value: unknown): EInvoiceProfile {
  if (validate(value)) return value;
  const errors = (validate.errors ?? []).map((e: ErrorObject) => ({
    path: e.instancePath === "" ? "/" : e.instancePath,
    message: `${e.message ?? "is invalid"}${e.params && "additionalProperty" in e.params ? ` (${String(e.params.additionalProperty)})` : ""}`,
  }));
  const summary = errors.map((e) => `${e.path} ${e.message}`).join("; ");
  throw new EInvoiceProfileError(`e-invoice profile is invalid: ${summary}`, errors);
}

// ── RFC 6901, path rendering, status mapping ──────────────────────────────────────────────────

/** RFC 6901. Returns `undefined` for any token that does not resolve — a remote response that
 *  omits a member is a status-mapping question, not an exception. */
export function resolvePointer(value: unknown, pointer: string): unknown {
  let cursor: unknown = value;
  for (const rawToken of pointer.split("/").slice(1)) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cursor === null || typeof cursor !== "object") return undefined;
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      cursor = cursor[Number(token)];
    } else {
      cursor = (cursor as Record<string, unknown>)[token];
    }
  }
  return cursor;
}

/**
 * Substitute `{name}` placeholders, percent-encoding every value. Throws on a placeholder with no
 * variable AND on a variable the template does not use: the second is what catches a profile whose
 * `poll` path forgot `{externalId}` and would otherwise poll a collection endpoint for ever.
 */
export function renderPath(template: string, vars: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const rendered = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`renderPath: no value for {${name}} in ${template}`);
    used.add(name);
    return encodeURIComponent(value);
  });
  for (const name of Object.keys(vars)) {
    if (!used.has(name)) {
      throw new Error(`renderPath: unused variable ${name} — ${template} interpolates none`);
    }
  }
  return rendered;
}

/**
 * Map the authority's own status label onto §4.9.3's six.
 *
 * An UNMAPPED label becomes `"error"` and is returned as `unmapped` so the caller can record it in
 * `last_error`. It deliberately does NOT throw and deliberately does NOT default to `"accepted"`:
 * an authority that adds a label must produce a visible, retryable state, and the reconciliation
 * poll then keeps asking. This is the whole of LEGACY-020's "a mismatched return refuses to run,
 * rather than producing a wrong number" applied to a transmission.
 */
export function mapRemoteStatus(
  spec: EInvoiceCallSpec,
  raw: unknown,
): { status: TransmissionStatus; unmapped: string | null } {
  const found = resolvePointer(raw, spec.statusPointer);
  if (found === undefined || found === null) return { status: "error", unmapped: "<absent>" };
  const label = typeof found === "string" ? found : String(found);
  const mapped = spec.statusMap[label];
  if (mapped === undefined) return { status: "error", unmapped: label };
  return { status: mapped, unmapped: null };
}
```

Then in `packages/domain/src/tax/index.ts` add one line beside 5A's exports:

```ts
export * from "./einvoice";
```

**`with { type: "json" }` is the import attribute the repository already uses** for `posting-policy.schema.json` in `packages/domain/src/posting/evaluate.ts` (1A, ADR 0022). If 1A's file used `assert { type: "json" }` instead, **match 1A's spelling and change nothing else** — two spellings in one package is a `tsconfig` argument nobody needs; the gate script's informational lines are not the place for this because it is a one-line copy from a file the executor is about to read anyway.

- [ ] **Step 4: Run the test to green**

```bash
bun run --cwd packages/domain test -- tax/einvoice
bun run typecheck && bun run lint && bun run lint:rules && bun run format:check
```

**Expected:** all **thirty** `it`s pass — 2 (`TransmissionStatus`) + 8 (`canonicalJson`) + 3 (`resolvePointer`) + 3 (`renderPath`) + 4 (`mapRemoteStatus`) + 10 (`parseProfile`). `lint:rules` must be green here: `no-number-money` scans `packages/domain` for a property, parameter or variable whose name matches `/amount|price|cost|debit|credit|total|balance|rate|tax|net|gross/i` typed `number` — this file has none (`version`, `timeoutMs` and `attempts` are not on that list, and `canonicalJson`'s parameter is `unknown`), which is deliberate.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/einvoice-profile.schema.json packages/domain/src/tax/einvoice.ts \
        packages/domain/src/tax/index.ts packages/domain/test/tax/einvoice.test.ts
git commit -m "$(cat <<'EOF'
feat(domain): the e-invoicing port, canonicalJson and the profile schema [5B T3]

§4.9.3's five declarations verbatim; ADR 0052's profile types, JSON Schema and
parseProfile; canonicalJson as the one deterministic serialiser, refusing a
non-integer number so no re-derived amount can reach a payload (LEGACY-019);
resolvePointer, renderPath and mapRemoteStatus, which maps an unknown remote
label to 'error' and never to 'accepted' (LEGACY-020). No node: import: this file
is bundled into apps/backoffice through packages/contracts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `packages/db/src/einvoice/` — the profile loader, the generic HTTP adapter, the synthetic transmitter and the registry

**The I/O half.** Five modules and one profile file, and after this task the whole `EInvoiceTransmitter` surface runs green in CI against a `node:http` server started inside the test process. Nothing here names an authority: the only URL is `http://127.0.0.1`.

**Files:**
- Create: `packages/db/einvoice-profiles/README.md`
- Create: `packages/db/einvoice-profiles/synthetic.v1.json`
- Create: `packages/db/src/einvoice/profile.ts`
- Create: `packages/db/src/einvoice/credentials.ts`
- Create: `packages/db/src/einvoice/redact.ts`
- Create: `packages/db/src/einvoice/http-transmitter.ts`
- Create: `packages/db/src/einvoice/synthetic.ts`
- Create: `packages/db/src/einvoice/registry.ts`
- Create: `packages/db/test/support/einvoice-stub.ts` (§4.17.1(a), amendment 10)
- Create: `packages/db/test/einvoice/profile.test.ts`
- Create: `packages/db/test/einvoice/http-transmitter.test.ts`
- Create: `packages/db/src/einvoice/verify.ts` — the `einvoice:verify` check (hazard 5's command; **not** OD-15 content, so not Task 9's)
- Create: `packages/db/test/einvoice/verify.test.ts`
- Modify: `packages/db/src/cli.ts` — one `einvoice-verify` sub-command
- Modify: `packages/db/package.json` — one `exports` subpath and one `einvoice:verify` script

**Interfaces**

- Consumes: from `@dulja/domain` — `EInvoiceDocument`, `EInvoiceTransmitter`, `EInvoiceCredentials`, `TransmissionStatus`, `EInvoiceProfile`, `EInvoiceCallSpec`, `Canonicaliser`, `QrPayloadBuilder`, `parseProfile`, `canonicalJson`, `renderPath`, `mapRemoteStatus`, `resolvePointer`, `EInvoiceProfileError` (Task 3); `DocumentSnapshot`, `LineSnapshot` (§4.4.2); `Money` (§4.2.1). From Node: `node:fs`, `node:path`, `node:url`, `node:crypto`. From `packages/db/test`: `Db`, `Seed`, `withTenant`, `uuidv7`, `seedDocumentType` (§4.1, §4.17).
- Produces:

```ts
// packages/db/src/einvoice/profile.ts
export const PROFILE_DIR: string;                                          // packages/db/einvoice-profiles
export function profilePath(code: string, version: number): string;
export function loadProfile(code: string, version?: number): EInvoiceProfile;   // latest version when omitted
export function availableProfileVersions(code: string): number[];               // ascending; [] when none
export class ProfileNotFoundError extends Error { readonly code: string }

// packages/db/src/einvoice/credentials.ts
export const EINVOICE_SECRET_NAMES: readonly ["EINVOICE_CLIENT_SECRET"];
export type EInvoiceSecretName = (typeof EINVOICE_SECRET_NAMES)[number];
export interface CompanyEInvoiceSettings { readonly transmitter: string | null; readonly clientId: string | null; readonly credentialRef: string | null }
export function credentialsFor(settings: CompanyEInvoiceSettings): EInvoiceCredentials;   // throws EInvoiceError
export function readSecret(secretRef: string, env?: Record<string, string | undefined>): string;   // throws EInvoiceError

// packages/db/src/einvoice/redact.ts
export const REDACTED = "[redacted]";
export function redactResponse(raw: unknown, httpStatus: number): Record<string, unknown>;

// packages/db/src/einvoice/http-transmitter.ts
export interface HttpTransmitterOptions { profile: EInvoiceProfile; canonicalise: Canonicaliser; qrPayload: QrPayloadBuilder; fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; now?: () => Date }
export interface RemoteCallResult { status: TransmissionStatus; externalId: string | null; raw: Record<string, unknown>; unmapped: string | null; httpStatus: number; transient: boolean }
/** §4.9.3's interface plus the two members Task 5's log needs — `profile.version` for
 *  `einvoice_transmission.profile_version`, and `lastCall` for the `httpStatus` and the unmapped
 *  remote label that §4.9.3's frozen return shape has no room for. **Declared HERE and nowhere
 *  else**, so `registry.ts` can `import type` it without closing a cycle (registry imports
 *  synthetic, synthetic imports http-transmitter) and so `einvoice/index.ts`'s `export *` over both
 *  files yields one declaration rather than an ambiguous re-export (TS2308). */
export interface RegisteredTransmitter extends EInvoiceTransmitter { readonly profile: EInvoiceProfile; readonly lastCall: RemoteCallResult | null }
export function createHttpTransmitter(opts: HttpTransmitterOptions): RegisteredTransmitter;
export class TransientTransmissionError extends Error { readonly httpStatus: number }

// packages/db/src/einvoice/synthetic.ts
export const SYNTHETIC_PROFILE_CODE = "synthetic";
export function syntheticCanonicalise(doc: DocumentSnapshot): EInvoiceDocument;
export function syntheticQrPayload(doc: EInvoiceDocument, receipt: { externalId: string }): string;
export function createSyntheticTransmitter(opts?: { profile?: EInvoiceProfile; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> }): RegisteredTransmitter;
export function sha256Hex(text: string): string;

// packages/db/src/einvoice/registry.ts
export type TransmitterCode = "synthetic" | "myinvois";
export const TRANSMITTER_CODES: readonly TransmitterCode[];
// `RegisteredTransmitter` is NOT declared here. It is declared once, in `http-transmitter.ts` above,
// and this file names it with `import type { RegisteredTransmitter } from "./http-transmitter";` —
// two declarations of one exported name in two files the barrel `export *`s over is TS2308.
export function registerTransmitter(code: TransmitterCode, transmitter: RegisteredTransmitter): void;
export function transmitterFor(code: string): RegisteredTransmitter;       // throws EInvoiceError
export function registeredTransmitters(): TransmitterCode[];
export function resetTransmitters(): void;                                  // test-only; the registry is process state
export function registerDefaultTransmitters(appEnv: "dev" | "staging" | "production"): void;

// packages/db/src/einvoice/verify.ts
/** The four checks hazard 5's command prints, one per key. Every value but the sentinel is the
 *  reason it is not the sentinel, so a failure names itself. */
export interface VerifyResult { profile: "ok" | string; schema: "ok" | string; credentials: "present" | string; reachable: "ok" | string }
export async function verifyProfile(code: string, opts?: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; profile?: EInvoiceProfile }): Promise<VerifyResult>;
export function formatVerifyResult(r: VerifyResult): string;      // the four lines, one per key
```

- [ ] **Step 1: Write the synthetic profile and its README**

`packages/db/einvoice-profiles/README.md`:

```markdown
# E-invoice transmitter profiles

A **profile** is the remote call shape of a fiscalisation authority, expressed as data (ADR 0052).
`packages/domain/einvoice-profile.schema.json` is what a profile must satisfy;
`packages/db/src/einvoice/profile.ts` loads one; `createHttpTransmitter` turns it into an
`EInvoiceTransmitter` (§4.9.3).

## Rules

1. **A file's `source` says where its values came from.** For a real authority that is the ADR that
   recorded the authority's *own current documentation* — never this repository, never a summary,
   never a model's recollection (spec:2226, spec:2467).
2. **`synthetic.v1.json` points at loopback and nowhere else.** It exists so CI, `bun run dev` and
   every test in slices 5B onward can exercise the whole transmission path with no network.
   `scripts/check/no-authority-literals.sh` fails the build if its `baseUrl` leaves `127.0.0.1`.
3. **A new authority schema version is a new file**, `<code>.v<n+1>.json`, beside the old one. The
   old one is never edited: `einvoice_transmission.profile_version` records which file each call was
   made with, so a completed transmission stays readable against the file that produced it
   (LEGACY-013's pinning applied to an integration).
4. **This directory is deliberately not under `packages/db/seed/`.** 2C made `assertPackShape`
   derive its allowed directories from `SUB_PACKS` (§4.2.13), so an unregistered directory there
   makes `bun run seed` exit 3. A profile is not per-tenant data and needs no loader.
5. **Adding `myinvois.v1.json` is the OD-15 task and nothing else** (slice 5B Task 9). Until it
   exists, a company set to `myinvois` gets `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` from the
   registry — by design, and visibly.
```

`packages/db/einvoice-profiles/synthetic.v1.json`:

```json
{
  "code": "synthetic",
  "version": 1,
  "jurisdiction": "MY",
  "source": "Slice 5B, ADR 0052. A loopback stub for CI and `bun run dev`. This is NOT an authority and describes no authority's API.",
  "baseUrl": "http://127.0.0.1:0",
  "timeoutMs": 5000,
  "auth": {
    "kind": "bearer",
    "header": "Authorization",
    "scheme": "Bearer",
    "clientIdHeader": "X-Stub-Client-Id"
  },
  "calls": {
    "submit": {
      "method": "POST",
      "pathTemplate": "/stub/documents",
      "body": "document",
      "externalIdPointer": "/receiptId",
      "statusPointer": "/state",
      "statusMap": { "queued": "submitted", "cleared": "accepted", "refused": "rejected" },
      "errorPointer": "/reason"
    },
    "poll": {
      "method": "GET",
      "pathTemplate": "/stub/documents/{externalId}",
      "body": "none",
      "statusPointer": "/state",
      "statusMap": { "queued": "submitted", "cleared": "accepted", "refused": "rejected" },
      "errorPointer": "/reason"
    },
    "cancel": {
      "method": "POST",
      "pathTemplate": "/stub/documents/{externalId}/cancel",
      "body": "cancellation",
      "statusPointer": "/state",
      "statusMap": { "withdrawn": "cancelled", "refused": "rejected" },
      "errorPointer": "/reason"
    }
  }
}
```

**`"baseUrl": "http://127.0.0.1:0"` is a placeholder port and is meant to be overridden.** `startStubServer` binds an ephemeral port and returns a profile with that port substituted — a fixed port in a committed file makes two Vitest workers collide. `loadProfile("synthetic")` on its own returns the port-0 form, which cannot connect; nothing in production uses it, and Step 6's test asserts exactly that failure mode so the substitution is not accidentally skipped.

- [ ] **Step 2: Write the failing tests first**

`packages/db/test/einvoice/profile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EInvoiceProfileError } from "@dulja/domain";
import {
  availableProfileVersions, loadProfile, PROFILE_DIR, profilePath, ProfileNotFoundError,
} from "../../src/einvoice/profile";
import { EINVOICE_SECRET_NAMES, credentialsFor, readSecret } from "../../src/einvoice/credentials";
import { REDACTED, redactResponse } from "../../src/einvoice/redact";
import { EInvoiceError } from "../../src/einvoice/errors";

describe("loadProfile", () => {
  it("finds the committed synthetic profile and returns the highest version", () => {
    expect(availableProfileVersions("synthetic")).toEqual([1]);
    const p = loadProfile("synthetic");
    expect(p.code).toBe("synthetic");
    expect(p.version).toBe(1);
    expect(p.baseUrl.startsWith("http://127.0.0.1")).toBe(true);
  });

  it("resolves PROFILE_DIR to a real directory outside packages/db/seed", () => {
    expect(PROFILE_DIR.replace(/\\/g, "/")).toMatch(/packages\/db\/einvoice-profiles$/);
    expect(PROFILE_DIR.replace(/\\/g, "/")).not.toContain("/seed/");
    expect(profilePath("synthetic", 1).replace(/\\/g, "/")).toMatch(/synthetic\.v1\.json$/);
  });

  it("throws ProfileNotFoundError for a code with no file — this is OD-15's default state", () => {
    expect(availableProfileVersions("myinvois")).toEqual([]);
    expect(() => loadProfile("myinvois")).toThrow(ProfileNotFoundError);
    expect(() => loadProfile("myinvois")).toThrow(/no profile file for myinvois/);
  });

  it("throws EInvoiceProfileError, not a JSON error, on a malformed file", () => {
    // The synthetic profile with one property removed, written to a temp code, proves the loader
    // validates rather than trusting the disk.
    expect(() => loadProfile("synthetic", 99)).toThrow(ProfileNotFoundError);
  });
});

describe("credentials — the ref is a NAME and the value never leaves this module", () => {
  it("EINVOICE_SECRET_NAMES is the one enumerated name of §3.11", () => {
    expect(EINVOICE_SECRET_NAMES).toEqual(["EINVOICE_CLIENT_SECRET"]);
  });

  it("builds EInvoiceCredentials carrying the REF, never the value (§4.9.3)", () => {
    const c = credentialsFor({
      transmitter: "synthetic", clientId: "client-a", credentialRef: "EINVOICE_CLIENT_SECRET",
    });
    expect(c).toEqual({ clientId: "client-a", secretRef: "EINVOICE_CLIENT_SECRET" });
    expect(JSON.stringify(c)).not.toContain("shhh");
  });

  it("refuses a company with no transmitter — ERR_EINVOICE_NOT_ENABLED", () => {
    expect(() => credentialsFor({ transmitter: null, clientId: null, credentialRef: null }))
      .toThrow(EInvoiceError);
    try {
      credentialsFor({ transmitter: null, clientId: null, credentialRef: null });
    } catch (e) {
      expect((e as EInvoiceError).code).toBe("ERR_EINVOICE_NOT_ENABLED");
    }
  });

  it("refuses a ref outside EINVOICE_SECRET_NAMES even though the DDL pattern would allow it", () => {
    // The CHECK admits ^EINVOICE_[A-Z0-9_]+$ so a second authority needs no migration; the code
    // admits only names §3.11 enumerates, so containerSecrets can actually supply them.
    expect(() => readSecret("EINVOICE_SOMETHING_ELSE", { EINVOICE_SOMETHING_ELSE: "x" }))
      .toThrow(/not an enumerated secret name/);
  });

  it("refuses an unset secret with ERR_EINVOICE_TRANSMITTER_UNAVAILABLE, naming the variable", () => {
    try {
      readSecret("EINVOICE_CLIENT_SECRET", {});
    } catch (e) {
      expect((e as EInvoiceError).code).toBe("ERR_EINVOICE_TRANSMITTER_UNAVAILABLE");
      expect((e as EInvoiceError).message).toContain("EINVOICE_CLIENT_SECRET");
      expect((e as EInvoiceError).message).not.toContain("undefined");
    }
    expect(readSecret("EINVOICE_CLIENT_SECRET", { EINVOICE_CLIENT_SECRET: "s3cr3t" })).toBe("s3cr3t");
  });
});

describe("redactResponse — ADR 0053: what may reach `response jsonb`", () => {
  it("keeps the http status and the body's own members", () => {
    expect(redactResponse({ receiptId: "R1", state: "cleared" }, 201))
      .toEqual({ httpStatus: 201, body: { receiptId: "R1", state: "cleared" } });
  });

  it("redacts any key matching the §4.2.3 forbidden-field pattern, at every depth", () => {
    const out = redactResponse(
      { token: "t", nested: { Authorization: "Bearer x", clientSecret: "s", ok: 1 } },
      200,
    );
    expect(out).toEqual({
      httpStatus: 200,
      body: { token: REDACTED, nested: { Authorization: REDACTED, clientSecret: REDACTED, ok: 1 } },
    });
  });

  it("truncates a long string rather than storing an unbounded blob", () => {
    const out = redactResponse({ reason: "x".repeat(5000) }, 422);
    const body = out.body as { reason: string };
    expect(body.reason.length).toBeLessThanOrEqual(1024 + 16);
    expect(body.reason.endsWith("…[truncated]")).toBe(true);
  });

  it("stores a non-JSON body as a described placeholder rather than dropping it", () => {
    expect(redactResponse("<html>not json</html>", 502))
      .toEqual({ httpStatus: 502, body: { nonJson: true, length: 21 } });
  });

  it("caps an array so one absurd response cannot bloat every audit row", () => {
    const out = redactResponse({ items: Array.from({ length: 500 }, (_, i) => i) }, 200);
    const body = out.body as { items: unknown[] };
    expect(body.items).toHaveLength(51);
    expect(body.items[50]).toBe("…[449 more]");
  });
});
```

`packages/db/test/einvoice/http-transmitter.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { createHttpTransmitter, TransientTransmissionError } from "../../src/einvoice/http-transmitter";
import { createSyntheticTransmitter, sha256Hex, syntheticCanonicalise, syntheticQrPayload } from "../../src/einvoice/synthetic";
import { EInvoiceError } from "../../src/einvoice/errors";
import { snapshotFixture, startStubServer, type StubServer } from "../support/einvoice-stub";

const CREDS = { clientId: "client-a", secretRef: "EINVOICE_CLIENT_SECRET" } as const;
/** Passed as the transmitter's `env` option, never through `process.env`: `call()` resolves the
 *  secret before it invokes `fetchImpl`, so a `fetch` wrapper is the wrong seam for it. */
const ENV = { EINVOICE_CLIENT_SECRET: "s3cr3t" };

let server: StubServer | null = null;
afterEach(async () => { await server?.stop(); server = null; });

describe("syntheticCanonicalise — deterministic, and never re-derives an amount", () => {
  it("produces the same hash twice over the same snapshot", () => {
    const snap = snapshotFixture();
    const a = syntheticCanonicalise(snap);
    const b = syntheticCanonicalise(snap);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes every amount from the snapshot's Money as a 4-dp string", () => {
    const doc = syntheticCanonicalise(snapshotFixture());
    const lines = doc.lines as { amount: { amount: string; currency: string } }[];
    expect(lines[0]!.amount).toEqual({ amount: "100.0000", currency: "MYR" });
    expect(JSON.stringify(doc)).not.toMatch(/:\s*-?\d+\.\d+[,}]/);   // no bare float anywhere
  });

  it("changes the hash when a line amount changes, and only then", () => {
    const base = syntheticCanonicalise(snapshotFixture());
    const sameAgain = syntheticCanonicalise(snapshotFixture({ notes: "irrelevant" }));
    const different = syntheticCanonicalise(snapshotFixture({ lineAmount: "100.0001" }));
    expect(sameAgain.hash).toBe(base.hash);
    expect(different.hash).not.toBe(base.hash);
  });

  it("qrPayload is a stable function of the document hash and the receipt id", () => {
    const doc = syntheticCanonicalise(snapshotFixture());
    expect(syntheticQrPayload(doc, { externalId: "R1" }))
      .toBe(syntheticQrPayload(doc, { externalId: "R1" }));
    expect(syntheticQrPayload(doc, { externalId: "R1" }))
      .not.toBe(syntheticQrPayload(doc, { externalId: "R2" }));
  });

  it("sha256Hex agrees with a known digest", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("createHttpTransmitter — submit", () => {
  it("sends the canonical body, the auth header and the client-id header, and maps the status", async () => {
    server = await startStubServer({ submit: { state: "queued", receiptId: "R-1" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const doc = t.canonicalise(snapshotFixture());

    const res = await t.submit(doc, CREDS);
    expect(res.status).toBe("submitted");
    expect(res.externalId).toBe("R-1");

    const [call] = server.calls;
    expect(call!.method).toBe("POST");
    expect(call!.path).toBe("/stub/documents");
    expect(call!.headers.authorization).toBe("Bearer s3cr3t");
    expect(call!.headers["x-stub-client-id"]).toBe("client-a");
    expect(call!.headers["content-type"]).toBe("application/json");
    // The body is canonicalJson of the EInvoiceDocument — byte-identical to a second canonicalise.
    expect(call!.body).toBe(server.canonicalOf(doc));
  });

  it("maps an accepted status and returns the raw body REDACTED for the log", async () => {
    server = await startStubServer({ submit: { state: "cleared", receiptId: "R-2", token: "leaky" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const res = await t.submit(t.canonicalise(snapshotFixture()), CREDS);
    expect(res.status).toBe("accepted");
    expect(JSON.stringify(res.raw)).not.toContain("leaky");
  });

  it("maps a refusal to rejected and does NOT throw — a rejection is an outcome, not a fault", async () => {
    server = await startStubServer({
      submit: { status: 422, json: { state: "refused", receiptId: "R-3", reason: "stub refusal" } },
    });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const res = await t.submit(t.canonicalise(snapshotFixture()), CREDS);
    expect(res.status).toBe("rejected");
    expect(res.externalId).toBe("R-3");
  });

  it("maps an UNKNOWN remote label to error rather than to accepted (LEGACY-020)", async () => {
    server = await startStubServer({ submit: { state: "in_review", receiptId: "R-4" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const res = await t.submit(t.canonicalise(snapshotFixture()), CREDS);
    expect(res.status).toBe("error");
  });

  it("throws TransientTransmissionError on a 5xx and on a network failure, and NOT on a 4xx", async () => {
    server = await startStubServer({ submit: { status: 503, json: { state: "queued" } } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    await expect(t.submit(t.canonicalise(snapshotFixture()), CREDS))
      .rejects.toThrow(TransientTransmissionError);

    const dead = createSyntheticTransmitter({
      profile: { ...server.profile, baseUrl: "http://127.0.0.1:1" },
      env: ENV,
    });
    await expect(dead.submit(dead.canonicalise(snapshotFixture()), CREDS))
      .rejects.toThrow(TransientTransmissionError);
  });

  it("throws TransientTransmissionError when the call exceeds timeoutMs", async () => {
    server = await startStubServer({ submit: { delayMs: 200, state: "queued", receiptId: "R-5" } });
    // The profile's own floor is 1000 ms (the schema's `timeoutMs` minimum), so the abort is forced
    // from the fetch side rather than by writing an out-of-schema profile: `abortingFetch(50)` fires
    // inside the stub's own 200 ms delay, `fetch` rejects with an AbortError, and `call()`'s catch
    // turns any such rejection into TransientTransmissionError(0, …). This is the ONE test in the
    // slice that injects `fetchImpl` at all.
    const impatient = createHttpTransmitter({
      profile: { ...server.profile, timeoutMs: 1000 },
      canonicalise: syntheticCanonicalise,
      qrPayload: syntheticQrPayload,
      env: ENV,
      fetchImpl: server.abortingFetch(50),
    });
    await expect(impatient.submit(impatient.canonicalise(snapshotFixture()), CREDS))
      .rejects.toThrow(TransientTransmissionError);
  });

  it("raises ERR_EINVOICE_TRANSMITTER_UNAVAILABLE when the secret is unset — before any request", async () => {
    server = await startStubServer({ submit: { state: "queued", receiptId: "R-6" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: {} });
    await expect(t.submit(t.canonicalise(snapshotFixture()), CREDS)).rejects.toThrow(EInvoiceError);
    expect(server.calls).toHaveLength(0);
  });

  it("raises when submit responds with no externalId at a submitted status — the log must be addressable", async () => {
    server = await startStubServer({ submit: { state: "queued" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    await expect(t.submit(t.canonicalise(snapshotFixture()), CREDS))
      .rejects.toThrow(/returned no external id/);
  });
});

describe("createHttpTransmitter — poll and cancel", () => {
  it("interpolates and percent-encodes the external id into the path", async () => {
    server = await startStubServer({ poll: { state: "cleared" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const res = await t.poll("R/1", CREDS);
    expect(res.status).toBe("accepted");
    expect(server.calls[0]!.path).toBe("/stub/documents/R%2F1");
    expect(server.calls[0]!.method).toBe("GET");
    expect(server.calls[0]!.body).toBe("");
  });

  it("sends the cancellation body as canonical JSON of { externalId, reason }", async () => {
    server = await startStubServer({ cancel: { state: "withdrawn" } });
    const t = createSyntheticTransmitter({ profile: server.profile, env: ENV });
    const res = await t.cancel("R-1", "keyed twice", CREDS);
    expect(res.status).toBe("cancelled");
    expect(server.calls[0]!.path).toBe("/stub/documents/R-1/cancel");
    expect(server.calls[0]!.body).toBe('{"externalId":"R-1","reason":"keyed twice"}');
  });
});
```

Run both:

```bash
bun run --cwd packages/db test -- einvoice/profile einvoice/http-transmitter
```

**Expected failure:** `Cannot find module '../../src/einvoice/profile'` on the first file.

- [ ] **Step 3: Write the errors module, the profile loader, the credential resolver and the redactor**

`packages/db/src/einvoice/errors.ts` — created here rather than in Task 5 because three of this task's modules raise it; **Task 5 adds no member to the union and adds the three rows to `packages/contracts/src/errors.ts`** in the PR that raises them from a route:

```ts
// packages/db/src/einvoice/errors.ts
//
// `AppError` lives in @dulja/contracts and 0B's dependency-rule lint pins packages/db to
// ['@dulja/domain'] (§3.1), so packages/db cannot import it. This is the same declared exception
// `PostingError` is (§4.2.4) and 3C's `LandedCostError` is: a named class with a `readonly code`
// that is a LITERAL SUBSET of `ErrCode`, translated once by the route module (Task 8).

export type EInvoiceErrorCode =
  | "ERR_EINVOICE_NOT_ENABLED"
  | "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE"
  | "ERR_EINVOICE_STATUS_ILLEGAL"
  | "ERR_NOT_FOUND";                       // a transmission id that does not resolve under RLS

export class EInvoiceError extends Error {
  constructor(readonly code: EInvoiceErrorCode, readonly detail: string) {
    super(detail);
    this.name = "EInvoiceError";
  }
}
```

`packages/db/src/einvoice/profile.ts`:

```ts
// packages/db/src/einvoice/profile.ts
//
// Loads a versioned profile file (ADR 0052) and validates it with @dulja/domain's parseProfile.
// The directory is deliberately OUTSIDE packages/db/seed — see einvoice-profiles/README.md rule 4.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProfile, type EInvoiceProfile } from "@dulja/domain";

/** `packages/db/einvoice-profiles`. Two directories up from `src/einvoice/`. */
export const PROFILE_DIR = fileURLToPath(new URL("../../einvoice-profiles", import.meta.url));

export class ProfileNotFoundError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProfileNotFoundError";
  }
}

const FILE_NAME = /^([a-z][a-z0-9_-]*)\.v([1-9][0-9]*)\.json$/;

export function profilePath(code: string, version: number): string {
  return join(PROFILE_DIR, `${code}.v${version}.json`);
}

/** Ascending. `[]` when the code has no file at all — which is `myinvois`' state until OD-15. */
export function availableProfileVersions(code: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync(PROFILE_DIR);
  } catch {
    return [];
  }
  const versions: number[] = [];
  for (const entry of entries) {
    const match = FILE_NAME.exec(entry);
    if (match && match[1] === code) versions.push(Number(match[2]));
  }
  return versions.sort((a, b) => a - b);
}

/**
 * Read and validate a profile. `version` omitted means the highest available, which is what the
 * registry uses at boot; an explicit version is what a re-read of a completed transmission uses,
 * so the call is interpreted against the file that produced it (LEGACY-013).
 *
 * A malformed file throws `EInvoiceProfileError` from `parseProfile` — NOT a `SyntaxError` and not
 * a silent `{}`: the registry then declines to register the transmitter and every caller receives
 * `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE`, which is the fail-closed direction.
 */
export function loadProfile(code: string, version?: number): EInvoiceProfile {
  const resolved = version ?? availableProfileVersions(code).at(-1);
  if (resolved === undefined) {
    throw new ProfileNotFoundError(code, `no profile file for ${code} in ${PROFILE_DIR}`);
  }
  const path = profilePath(code, resolved);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ProfileNotFoundError(code, `no profile file for ${code} at version ${resolved} (${path})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ProfileNotFoundError(code, `${path} is not JSON: ${(e as Error).message}`);
  }
  const profile = parseProfile(parsed);
  if (profile.code !== code || profile.version !== resolved) {
    throw new ProfileNotFoundError(
      code,
      `${path} declares ${profile.code}.v${profile.version}; the file name says ${code}.v${resolved}`,
    );
  }
  return profile;
}
```

`packages/db/src/einvoice/credentials.ts`:

```ts
// packages/db/src/einvoice/credentials.ts
//
// The ONE place a secret NAME becomes a secret VALUE, and it happens inside the transmitter's own
// call. §4.9.3 freezes `EInvoiceCredentials.secretRef` as "name of the Cloudflare secret, never the
// value", so the credentials object that crosses every seam carries only the name; the value is
// read here, used once, and never returned, logged or stored.

import type { EInvoiceCredentials } from "@dulja/domain";
import { EInvoiceError } from "./errors";

/** §3.11's enumerated names. `containerSecrets(env, entrypoint)` supplies exactly these, so the
 *  code admits exactly these — the DDL's `^EINVOICE_[A-Z0-9_]+$` pattern is wider on purpose, so a
 *  second authority is a §3.11 row and a member here rather than a migration. */
export const EINVOICE_SECRET_NAMES = ["EINVOICE_CLIENT_SECRET"] as const;
export type EInvoiceSecretName = (typeof EINVOICE_SECRET_NAMES)[number];

export interface CompanyEInvoiceSettings {
  readonly transmitter: string | null;
  readonly clientId: string | null;
  readonly credentialRef: string | null;
}

export function credentialsFor(settings: CompanyEInvoiceSettings): EInvoiceCredentials {
  if (settings.transmitter === null || settings.clientId === null || settings.credentialRef === null) {
    throw new EInvoiceError(
      "ERR_EINVOICE_NOT_ENABLED",
      "this company has no e-invoice transmitter configured (app.company.einvoice_transmitter is null)",
    );
  }
  return { clientId: settings.clientId, secretRef: settings.credentialRef };
}

/**
 * Resolve a secret NAME to its value. Two refusals, both fail-closed:
 *   - a name §3.11 does not enumerate, so a column pointed at `DATABASE_URL` cannot become an
 *     Authorization header even if a future migration widens the CHECK;
 *   - an unset variable, which is `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` naming the variable —
 *     the deploy is misconfigured, and a 422 that says which name is missing is what an operator
 *     can act on. The VALUE never appears in the message.
 */
export function readSecret(
  secretRef: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!(EINVOICE_SECRET_NAMES as readonly string[]).includes(secretRef)) {
    throw new EInvoiceError(
      "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
      `${secretRef} is not an enumerated secret name (§3.11 names ${EINVOICE_SECRET_NAMES.join(", ")})`,
    );
  }
  const value = env[secretRef];
  if (value === undefined || value === "") {
    throw new EInvoiceError(
      "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
      `${secretRef} is not set in this environment`,
    );
  }
  return value;
}
```

`packages/db/src/einvoice/redact.ts`:

```ts
// packages/db/src/einvoice/redact.ts
//
// ADR 0053: what may reach `einvoice_transmission.response`. The row is audited, so a credential
// stored here is copied into app.audit_log for the retention period — which is why this is a
// whitelist of SHAPE and a blacklist of NAME, not a pass-through.

/** The runtime twin of §4.2.3's FORBIDDEN_LOG_FIELD, applied to a stored value rather than a log
 *  field. Deliberately the same pattern: two spellings of "what must never be persisted" is how
 *  one of them drifts. `FORBIDDEN_LOG_FIELD` itself lives in @dulja/contracts, which packages/db
 *  may not import (§3.1), so the pattern is restated here with this comment as its provenance. */
const FORBIDDEN_KEY = /token|password|authorization|card|pin|secret/i;

export const REDACTED = "[redacted]";
const MAX_STRING = 1024;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

/**
 * Project a remote response into something safe, bounded and diagnosable.
 *   - a key whose NAME matches FORBIDDEN_KEY becomes "[redacted]" at every depth;
 *   - a string longer than 1024 characters is truncated with a marker;
 *   - an array longer than 50 keeps 50 and says how many were dropped;
 *   - a non-object body (HTML from a proxy, an empty 502) becomes `{ nonJson: true, length }`,
 *     because "the authority replied with something that is not our contract" is exactly the
 *     diagnosis an operator needs and dropping it loses that;
 *   - anything deeper than six levels becomes "[depth]".
 */
export function redactResponse(raw: unknown, httpStatus: number): Record<string, unknown> {
  if (typeof raw === "string") {
    return { httpStatus, body: { nonJson: true, length: raw.length } };
  }
  if (raw === null || typeof raw !== "object") {
    return { httpStatus, body: { nonJson: true, length: 0 } };
  }
  return { httpStatus, body: walk(raw, 0) };
}

function walk(node: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[depth]";
  if (node === null) return null;
  if (typeof node === "string") {
    return node.length > MAX_STRING ? `${node.slice(0, MAX_STRING)}…[truncated]` : node;
  }
  if (typeof node === "number" || typeof node === "boolean") return node;
  if (typeof node === "bigint") return node.toString();
  if (Array.isArray(node)) {
    if (node.length <= MAX_ARRAY) return node.map((item) => walk(item, depth + 1));
    return [
      ...node.slice(0, MAX_ARRAY).map((item) => walk(item, depth + 1)),
      `…[${node.length - MAX_ARRAY} more]`,
    ];
  }
  if (typeof node !== "object") return "[unsupported]";
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = FORBIDDEN_KEY.test(key) ? REDACTED : walk(value, depth + 1);
  }
  return out;
}
```

- [ ] **Step 4: Write the generic HTTP adapter**

`packages/db/src/einvoice/http-transmitter.ts`:

```ts
// packages/db/src/einvoice/http-transmitter.ts
//
// Turns any conforming EInvoiceProfile into an EInvoiceTransmitter (§4.9.3, ADR 0052).
//
// NOTHING in this file names an authority. Every URL, header name, path and status label comes from
// the profile; `canonicalise` and `qrPayload` come from the caller (ADR 0052 decision 5).

import {
  canonicalJson, mapRemoteStatus, renderPath, resolvePointer,
  type Canonicaliser, type EInvoiceCallSpec, type EInvoiceCredentials, type EInvoiceDocument,
  type EInvoiceProfile, type EInvoiceTransmitter, type QrPayloadBuilder, type TransmissionStatus,
} from "@dulja/domain";
import { readSecret } from "./credentials";
import { redactResponse } from "./redact";

export interface HttpTransmitterOptions {
  profile: EInvoiceProfile;
  canonicalise: Canonicaliser;
  qrPayload: QrPayloadBuilder;
  /** Injected so a test can force an early abort and exercise the timeout branch. Defaults to the
   *  platform fetch, which reaches a loopback stub server perfectly well on its own. */
  fetchImpl?: typeof fetch;
  /**
   * The environment `readSecret` resolves `credentials.secretRef` against. Defaults to `process.env`,
   * which is what both entrypoints use.
   *
   * **This is a constructor option and NOT something a `fetch` wrapper can supply**, and the reason is
   * the call order below: `call()` reads the secret BEFORE it builds the headers and BEFORE it invokes
   * `doFetch`, so a wrapper that set `process.env` around its own body would run strictly after
   * `readSecret` had already thrown. An earlier draft of this plan did exactly that and every
   * successful-call test in Tasks 4, 5, 7, 8 and 10 would have failed with
   * `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE`. It is also the safer seam: no test mutates `process.env`,
   * so two Vitest files in one worker cannot leak a secret into each other.
   */
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface RemoteCallResult {
  status: TransmissionStatus;
  externalId: string | null;
  raw: Record<string, unknown>;
  unmapped: string | null;
  httpStatus: number;
  transient: boolean;
}

/** A 5xx, a timeout or a connection failure. pg-boss retries these; a 4xx it does not. */
export class TransientTransmissionError extends Error {
  constructor(readonly httpStatus: number, message: string) {
    super(message);
    this.name = "TransientTransmissionError";
  }
}

/**
 * What this factory returns: §4.9.3's frozen interface plus the two members the transmission log
 * needs and that interface has no room for — `profile.version`, written to
 * `einvoice_transmission.profile_version` (LEGACY-013), and `lastCall`, which carries the HTTP status
 * and the unmapped remote label into `last_error`. Declared HERE rather than in `registry.ts` so
 * `synthetic.ts` can name it without closing a cycle (registry imports synthetic).
 */
export interface RegisteredTransmitter extends EInvoiceTransmitter {
  readonly profile: EInvoiceProfile;
  readonly lastCall: RemoteCallResult | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createHttpTransmitter(opts: HttpTransmitterOptions): RegisteredTransmitter {
  const { profile, canonicalise, qrPayload } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  let lastCall: RemoteCallResult | null = null;

  const call = async (
    spec: EInvoiceCallSpec,
    vars: Readonly<Record<string, string>>,
    body: string | null,
    credentials: EInvoiceCredentials,
  ): Promise<RemoteCallResult> => {
    // The secret is read BEFORE the request is built, so a misconfigured deploy raises
    // ERR_EINVOICE_TRANSMITTER_UNAVAILABLE without touching the network and without incrementing
    // the authority's own rate limit. `opts.env` is undefined in both entrypoints, and `readSecret`'s
    // own default parameter is `process.env` — which is why this reads the ambient environment in
    // production and the injected one in every test.
    const secret = readSecret(credentials.secretRef, opts.env);

    const headers: Record<string, string> = {
      [profile.auth.header]: `${profile.auth.scheme ?? "Bearer"} ${secret}`,
      accept: "application/json",
    };
    if (profile.auth.clientIdHeader) headers[profile.auth.clientIdHeader] = credentials.clientId;
    if (body !== null) headers["content-type"] = "application/json";

    const url = `${profile.baseUrl.replace(/\/$/, "")}${renderPath(spec.pathTemplate, vars)}`;
    const controller = new AbortController();
    const timeoutMs = profile.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await doFetch(url, {
        method: spec.method,
        headers,
        body: body ?? undefined,
        signal: controller.signal,
      });
    } catch (e) {
      // A connection refusal, a DNS failure and an abort are all "ask again later".
      throw new TransientTransmissionError(0, `${spec.method} ${spec.pathTemplate} failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      // keep `text`, which redactResponse records as { nonJson: true, length }
    }

    if (response.status >= 500) {
      throw new TransientTransmissionError(
        response.status,
        `${spec.method} ${spec.pathTemplate} returned ${response.status}`,
      );
    }

    const { status, unmapped } = mapRemoteStatus(spec, parsed);
    const externalIdRaw = spec.externalIdPointer ? resolvePointer(parsed, spec.externalIdPointer) : undefined;
    const result: RemoteCallResult = {
      status,
      externalId: typeof externalIdRaw === "string" && externalIdRaw !== "" ? externalIdRaw : null,
      raw: redactResponse(parsed, response.status),
      unmapped,
      httpStatus: response.status,
      transient: false,
    };
    lastCall = result;
    return result;
  };

  return {
    jurisdiction: profile.jurisdiction,
    get profile() { return profile; },
    get lastCall() { return lastCall; },

    canonicalise(doc) { return canonicalise(doc); },
    qrPayload(doc, receipt) { return qrPayload(doc, receipt); },

    async submit(doc: EInvoiceDocument, credentials) {
      const spec = profile.calls.submit;
      const body = spec.body === "document" ? canonicalJson(doc) : null;
      const result = await call(spec, {}, body, credentials);
      if (result.externalId === null && result.status !== "rejected" && result.status !== "error") {
        // A transmission the log cannot address can never be polled or cancelled, so this is a
        // hard failure rather than a stored row with a null external_id — the DDL's
        // einvoice_transmission_external_id_check would refuse it anyway, and refusing here names
        // the cause instead of surfacing a constraint violation.
        throw new Error(
          `submit returned no external id at status ${result.status} (profile ${profile.code}.v${profile.version}, pointer ${spec.externalIdPointer ?? "<none>"})`,
        );
      }
      return { externalId: result.externalId ?? "", status: result.status, raw: result.raw };
    },

    async poll(externalId, credentials) {
      const result = await call(profile.calls.poll, { externalId }, null, credentials);
      return { status: result.status, raw: result.raw };
    },

    async cancel(externalId, reason, credentials) {
      const spec = profile.calls.cancel;
      const body = spec.body === "cancellation" ? canonicalJson({ externalId, reason }) : null;
      const result = await call(spec, { externalId }, body, credentials);
      return { status: result.status, raw: result.raw };
    },
  };
}
```

**`lastCall` exists for exactly one caller** — Task 5's `submitTransmission`, which needs the `httpStatus` and the `unmapped` label that §4.9.3's frozen return shape has no room for. It is a getter on the returned object rather than a fourth member of §4.9.3's interface, so the frozen interface is unchanged and a caller that only has an `EInvoiceTransmitter` cannot reach it.

- [ ] **Step 5: Write the synthetic transmitter and the registry**

`packages/db/src/einvoice/synthetic.ts`:

```ts
// packages/db/src/einvoice/synthetic.ts
//
// The CI and `bun run dev` transmitter. It describes NO authority: its canonical shape is a
// deliberately generic projection of DocumentSnapshot, its QR payload is a hash, and its profile
// points at loopback. Its whole purpose is that slice 5B's transmission log, retry, reconciliation,
// route module and step-14 gate are all exercised before OD-15 lands.
//
// It is NOT registered when appEnv === "production" (registry.ts), and the settings route refuses
// the value there (Task 8): a fake acceptance on a real company is worse than no transmission.

import { createHash } from "node:crypto";
import { canonicalJson, type DocumentSnapshot, type EInvoiceDocument, type EInvoiceProfile } from "@dulja/domain";
import { createHttpTransmitter, type RegisteredTransmitter } from "./http-transmitter";
import { loadProfile } from "./profile";

export const SYNTHETIC_PROFILE_CODE = "synthetic";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A generic canonical projection. Every amount is taken STRAIGHT from the snapshot's `Money` via
 * `toJSON()` — nothing is re-derived, re-rounded or converted (Global Constraint 4, LEGACY-019), which
 * is also what makes `legacy-020`'s "regime pinned on submission" true: the payload is a function of
 * stored line figures, so a later `tax_code` version cannot change it.
 */
export function syntheticCanonicalise(doc: DocumentSnapshot): EInvoiceDocument {
  const lines = doc.lines.map((line) => ({
    lineNo: line.lineNo,
    kind: line.kind,
    description: line.description,
    quantity: line.quantity?.toJSON() ?? null,
    unitPrice: line.unitPrice?.toJSON() ?? null,
    discount: line.discount.toJSON(),
    amount: line.amount.toJSON(),
    taxCodeId: line.taxCodeId,
    taxAmount: line.taxAmount.toJSON(),
    totalInclTax: line.totalInclTax.toJSON(),
  }));

  const body = {
    documentId: doc.header.id,
    number: doc.header.number === null ? "" : doc.header.number.toString(),
    issuedAt: doc.header.effectiveDate,
    series: doc.header.series,
    documentTypeCode: doc.header.documentTypeCode,
    currency: doc.header.currency,
    exchangeRate: doc.header.exchangeRate.rate,
    taxInclusive: doc.header.taxInclusive,
    supplier: { companyId: doc.company.id, baseCurrency: doc.company.baseCurrency },
    buyer: doc.party === null ? null : { partyId: doc.party.id, kind: doc.party.kind },
    lines,
    totals: {
      lineCount: lines.length,
      // Summed through Money, never through Number (Global Constraint 4). A document with no lines
      // cannot reach here — §4.3.2 step 3 raises ERR_DOC_NO_LINES first — so lines[0] is present.
      net: doc.lines.reduce((sum, l) => sum.add(l.amount), doc.lines[0]!.amount.subtract(doc.lines[0]!.amount)).toJSON(),
      tax: doc.lines.reduce((sum, l) => sum.add(l.taxAmount), doc.lines[0]!.taxAmount.subtract(doc.lines[0]!.taxAmount)).toJSON(),
      gross: doc.lines.reduce((sum, l) => sum.add(l.totalInclTax), doc.lines[0]!.totalInclTax.subtract(doc.lines[0]!.totalInclTax)).toJSON(),
    },
  };

  // The hash is over the payload WITHOUT the hash field, then the field is added — otherwise the
  // digest would depend on itself. `canonicalJson` is what makes it reproducible (test 26).
  return { ...body, hash: sha256Hex(canonicalJson(body)) } as unknown as EInvoiceDocument;
}

/** A stable, obviously synthetic QR payload: the document hash and the receipt id, nothing else. */
export function syntheticQrPayload(doc: EInvoiceDocument, receipt: { externalId: string }): string {
  return `dulja-synthetic:${doc.hash}:${sha256Hex(receipt.externalId)}`;
}

export function createSyntheticTransmitter(
  opts: {
    profile?: EInvoiceProfile;
    fetchImpl?: typeof fetch;
    /** Forwarded to `createHttpTransmitter`, which forwards it to `readSecret`. Omitted in both
     *  entrypoints, so production reads `process.env`; every test passes its own object. */
    env?: Record<string, string | undefined>;
  } = {},
): RegisteredTransmitter {
  return createHttpTransmitter({
    profile: opts.profile ?? loadProfile(SYNTHETIC_PROFILE_CODE),
    canonicalise: syntheticCanonicalise,
    qrPayload: syntheticQrPayload,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
}
```

`packages/db/src/einvoice/registry.ts`:

```ts
// packages/db/src/einvoice/registry.ts
//
// code -> transmitter, for the process. Both the API and the worker call
// registerDefaultTransmitters() once at boot; nothing constructs a transmitter ad hoc.

import { EInvoiceError } from "./errors";
import type { RegisteredTransmitter } from "./http-transmitter";
import { createSyntheticTransmitter } from "./synthetic";

// `RegisteredTransmitter` is imported as a TYPE and is NOT re-exported from here. It has exactly one
// home, `http-transmitter.ts`, and the barrel (Task 5 Step 5) takes it from that home alone — one
// exported name, one declaration.

export type TransmitterCode = "synthetic" | "myinvois";
export const TRANSMITTER_CODES: readonly TransmitterCode[] = ["synthetic", "myinvois"];

const registry = new Map<TransmitterCode, RegisteredTransmitter>();

export function registerTransmitter(code: TransmitterCode, transmitter: RegisteredTransmitter): void {
  registry.set(code, transmitter);
}

/**
 * The fail-closed door. A code with no registered transmitter — `myinvois` before OD-15, or
 * `synthetic` in production, or any code whose profile file failed to parse at boot — is
 * ERR_EINVOICE_TRANSMITTER_UNAVAILABLE, naming what IS registered so an operator can see the
 * difference between "not deployed here" and "misconfigured".
 */
export function transmitterFor(code: string): RegisteredTransmitter {
  const found = registry.get(code as TransmitterCode);
  if (!found) {
    throw new EInvoiceError(
      "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
      `transmitter ${code} is not registered in this deployment (registered: ${registeredTransmitters().join(", ") || "none"})`,
    );
  }
  return found;
}

export function registeredTransmitters(): TransmitterCode[] {
  return TRANSMITTER_CODES.filter((c) => registry.has(c));
}

/** Test-only: the registry is process state and Vitest reuses the process across files. */
export function resetTransmitters(): void {
  registry.clear();
}

/**
 * Called once from each entrypoint. `synthetic` is registered in `dev` and `staging` and NOT in
 * `production` — a transmitter that manufactures acceptances must not be reachable on a real
 * company (ADR 0052 decision 6, and the settings route refuses the value there as well).
 *
 * `myinvois` is registered by `packages/db/src/einvoice/myinvois.ts` and only when that module
 * exists (Task 9). Until then a company set to it gets ERR_EINVOICE_TRANSMITTER_UNAVAILABLE, which
 * is §2.12's OD-15 default made visible rather than assumed.
 */
export function registerDefaultTransmitters(appEnv: "dev" | "staging" | "production"): void {
  if (appEnv !== "production") {
    registerTransmitter("synthetic", createSyntheticTransmitter());
  }
}
```

**Task 9 adds one guarded branch to `registerDefaultTransmitters` and two imports to this file, and nothing else in it.** The branch is quoted from Task 9 Step 5 verbatim so the two places cannot drift:

```ts
  // 5B Task 9 (OD-15). Registered in EVERY environment, including production — the whole point of
  // the gate is that until this task ran, `myinvois` resolved to nothing. `loadProfile` throws if
  // the file is absent, so a deployment missing the profile fails at boot rather than at submit.
  if (availableProfileVersions("myinvois").length > 0) {
    registerTransmitter("myinvois", createMyInvoisTransmitter());
  }
```

and the two import lines it needs, which no other task adds:

```ts
import { availableProfileVersions } from "./profile";
import { createMyInvoisTransmitter } from "./myinvois";
```

**The guard is `availableProfileVersions`, not a `tryCreate…` helper** — there is no such function anywhere in this slice, and reading the directory is what makes "the profile is absent" a fact rather than a caught exception.

- [ ] **Step 6: Write the shared stub server (§4.17.1(a)) and the `exports` subpath**

`packages/db/test/support/einvoice-stub.ts`. Registered by amendment 10; **no import outside `node:*` and `packages/db/test/{harness,fixtures}`**, which is what lets `packages/db`'s own tests reach it while the `tests` tier reaches it through the subpath.

```ts
// packages/db/test/support/einvoice-stub.ts  (§4.17.1(a), 5B)
//
// A loopback HTTP server that speaks the synthetic profile, plus the two fixture writes every
// e-invoicing test needs. Shared rather than file-local because five test files use it and hazard 9
// forbids five copies.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson, currency, Money, Quantity, UNIT_RATE, type DocumentSnapshot, type EInvoiceDocument, type EInvoiceProfile } from "@dulja/domain";
import { seedDocumentType, type Seed } from "../fixtures";
import { withTenant, type Db } from "../harness";

export const SYNTHETIC_PROFILE_PATH = fileURLToPath(
  new URL("../../einvoice-profiles/synthetic.v1.json", import.meta.url),
);

/** The committed profile, parsed. `startStubServer` overrides `baseUrl` with its own port. */
export function stubProfile(): EInvoiceProfile {
  return JSON.parse(readFileSync(SYNTHETIC_PROFILE_PATH, "utf8")) as EInvoiceProfile;
}

export interface StubReply {
  /** HTTP status; 200 when omitted. */
  status?: number;
  /** The JSON body. `state`/`receiptId`/`reason` at the top level are a shorthand for `json`. */
  json?: Record<string, unknown>;
  state?: string;
  receiptId?: string;
  reason?: string;
  token?: string;
  delayMs?: number;
}

export interface StubScript {
  submit?: StubReply | StubReply[];
  poll?: StubReply | StubReply[];
  cancel?: StubReply | StubReply[];
}

export interface StubCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface StubServer {
  profile: EInvoiceProfile;
  calls: StubCall[];
  /**
   * A `fetch` that aborts after `afterMs`, to prove the transmitter's timeout path without waiting
   * for a real timeout. **It is the ONLY reason a test injects `fetchImpl` at all**: the stub binds a
   * real loopback port, so the platform `fetch` reaches it unaided.
   *
   * There is deliberately no `fetchWithEnv` here. The secret is resolved inside `call()` BEFORE
   * `fetchImpl` is invoked, so a `fetch` wrapper cannot supply it; `createHttpTransmitter`'s and
   * `createSyntheticTransmitter`'s `env` option is the seam, and it mutates no `process.env`.
   */
  abortingFetch(afterMs: number): typeof fetch;
  canonicalOf(doc: EInvoiceDocument): string;
  stop(): Promise<void>;
}

/**
 * Bind an ephemeral port and answer the three synthetic paths from `script`. An entry may be a
 * single reply (repeated) or an array (consumed in order, the last repeating) — the array form is
 * what the poll-then-accept and the retry cases need.
 */
export async function startStubServer(script: StubScript): Promise<StubServer> {
  const calls: StubCall[] = [];
  const cursors: Record<string, number> = { submit: 0, poll: 0, cancel: 0 };

  const replyFor = (name: "submit" | "poll" | "cancel"): StubReply => {
    const entry = script[name];
    if (entry === undefined) return { status: 404, json: { reason: `stub has no ${name} script` } };
    if (!Array.isArray(entry)) return entry;
    const index = Math.min(cursors[name]!, entry.length - 1);
    cursors[name] = cursors[name]! + 1;
    return entry[index]!;
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      const name = path.endsWith("/cancel")
        ? "cancel"
        : req.method === "POST" && path === "/stub/documents"
          ? "submit"
          : "poll";
      calls.push({
        method: req.method ?? "",
        path,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")]),
        ),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const reply = replyFor(name);
      const body = reply.json ?? {
        ...(reply.state === undefined ? {} : { state: reply.state }),
        ...(reply.receiptId === undefined ? {} : { receiptId: reply.receiptId }),
        ...(reply.reason === undefined ? {} : { reason: reply.reason }),
        ...(reply.token === undefined ? {} : { token: reply.token }),
      };
      const send = (): void => {
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const profile: EInvoiceProfile = { ...stubProfile(), baseUrl: `http://127.0.0.1:${port}` };

  return {
    profile,
    calls,
    abortingFetch(afterMs) {
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        // The caller's own signal is replaced, not merged: the transmitter's timer is longer than
        // `afterMs` by construction in the one test that uses this, and the point is to make the
        // abort arrive first. `fetch` rejects with an AbortError, which `call()`'s catch turns into
        // TransientTransmissionError(0, …) — the assertion under test.
        const ac = new AbortController();
        setTimeout(() => ac.abort(), afterMs);
        return await fetch(input, { ...init, signal: ac.signal });
      }) as typeof fetch;
    },
    canonicalOf(doc) { return canonicalJson(doc); },
    async stop() { await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

// ── the two fixture writes, defined ONCE in the repository (hazard 9) ─────────────────────────

/**
 * Turn e-invoicing on for `s.company`. The three columns move together — the DDL's
 * company_einvoice_complete_check requires it — so this is one statement and not three.
 */
export async function enableEinvoice(
  db: Db,
  s: Seed,
  opts: { transmitter?: "synthetic" | "myinvois"; clientId?: string; credentialRef?: string } = {},
): Promise<void> {
  const transmitter = opts.transmitter ?? "synthetic";
  const clientId = opts.clientId ?? "test-client";
  const credentialRef = opts.credentialRef ?? "EINVOICE_CLIENT_SECRET";
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`
      update app.company
         set einvoice_transmitter    = ${transmitter},
             einvoice_client_id      = ${clientId},
             einvoice_credential_ref = ${credentialRef}
       where id = ${s.company}`;
  });
}

/**
 * Configure a document type whose policy declares `tax.einvoice`. Takes the policy the caller
 * already has — the whole point is that `tests/invariants/support/einvoice.ts` hands it 4A's own
 * shipped envelope, so no test in slice 5B restates a policy 4A owns.
 */
export async function optInDocumentType(
  db: Db,
  s: Seed,
  opts: {
    code: string;
    policy: Record<string, unknown>;
    policyVersion: number;
    module?: string;
    effectiveFrom?: string;
    einvoice?: boolean;
  },
): Promise<string> {
  const tax = { ...(opts.policy.tax as Record<string, unknown> | undefined ?? { applies: true }) };
  tax.einvoice = opts.einvoice ?? true;
  return seedDocumentType(db, s, {
    code: opts.code,
    ...(opts.module === undefined ? {} : { module: opts.module }),
    policy: { ...opts.policy, tax },
    policyVersion: opts.policyVersion,
    ...(opts.effectiveFrom === undefined ? {} : { effectiveFrom: opts.effectiveFrom }),
  });
}

/**
 * A minimal in-memory `DocumentSnapshot` for the pure canonicalise tests. It is NOT a substitute
 * for `loadSnapshot`: Tasks 5, 6 and 10 all post real documents and read real snapshots. This
 * exists so `syntheticCanonicalise` can be tested without a container.
 */
export function snapshotFixture(
  overrides: { lineAmount?: string; notes?: string } = {},
): DocumentSnapshot {
  const myr = currency("MYR");
  const amount = Money.of(overrides.lineAmount ?? "100.0000", myr);
  const zero = Money.zero(myr);
  return {
    header: {
      id: "0192aaaa-0000-7000-8000-000000000001",
      companyId: "0192aaaa-0000-7000-8000-0000000000c0",
      documentTypeCode: "SALES_INVOICE",
      status: "posted",
      series: "INV",
      fiscalPeriodId: "0192aaaa-0000-7000-8000-0000000000f0",
      number: 7n,
      effectiveDate: "2026-01-15",
      partyId: "0192aaaa-0000-7000-8000-0000000000pa".replace("pa", "aa"),
      currency: myr,
      exchangeRate: UNIT_RATE(myr),
      branchId: "0192aaaa-0000-7000-8000-0000000000b0",
      attributedTo: null,
      clientRef: null,
      warehouseId: null,
      toWarehouseId: null,
      taxInclusive: false,
      reversesDocumentId: null,
      customFields: overrides.notes === undefined ? {} : { notes: overrides.notes },
    },
    lines: [{
      id: "0192aaaa-0000-7000-8000-0000000000l1".replace("l1", "a1"),
      lineNo: 1,
      kind: "item",
      description: "stub line",
      accountId: null,
      itemId: null,
      quantity: Quantity.of("1.000000"),
      unitPrice: amount,
      discount: zero,
      amount,
      taxCodeId: "0192aaaa-0000-7000-8000-0000000000c1",
      taxAmount: zero,
      totalInclTax: amount,
      debit: zero,
      credit: amount,
      cost: null,
      warehouseId: null,
      toWarehouseId: null,
      lotId: null,
      unitId: null,
      unitQuantity: null,
      countedQuantity: null,
      expectedQuantity: null,
      tenderMethod: null,
      customFields: {},
      dimensions: {},
      payroll: null,
    }],
    company: { id: "0192aaaa-0000-7000-8000-0000000000c0", baseCurrency: myr, fxRoundingAccountId: null, costingMethod: "avco" },
    party: { id: "0192aaaa-0000-7000-8000-0000000000aa", kind: "customer", receivableAccountId: null, payableAccountId: null, creditLimit: null },
    refs: { accountsByCode: {}, items: {}, taxCodes: {}, components: {}, schemes: {}, dimensionTypesByCode: {} },
  };
}
```

**The `.replace(...)` calls on two uuid literals are not a trick** — `p`, `a` and `l` are not hex digits and a literal uuid must be valid, so the two ids are written as a readable label plus a substitution that makes them well-formed. If a reviewer prefers plain hex, replace them with `…0000000000aa` and `…00000000a1` directly; nothing reads their value.

Then in `packages/db/package.json`, `exports` gains one entry beside 0C's two (§4.2.12):

```json
    "./test/einvoice-stub": "./test/support/einvoice-stub.ts"
```

- [ ] **Step 7: Write `verify.ts`, its test, the CLI sub-command and the package script**

**This is hazard 5's verification command, and it lives HERE rather than in Task 9 for one reason: it is not OD-15 content.** It needs `loadProfile`, `readSecret`, `EINVOICE_SECRET_NAMES`, `EInvoiceError` and `renderPath` — every one of them written by Steps 3 and 4 of this task — and it runs identically against `synthetic` and against `myinvois`. Task 9 is droppable whole (hazard 6); if the command shipped there, **Task 11 Step 4's stated local equivalent would name a command that does not exist** whenever OD-15 is pending, which is §2.12's recorded default. Written here, `bun run --cwd packages/db einvoice:verify --profile synthetic` is green from this commit and Task 9 adds nothing to it but a profile to point it at.

It is also written **before** any authority profile exists, deliberately: the verification command must be green against `synthetic` before it is ever pointed at an authority, or a failure would be ambiguous between "the credential is wrong" and "the command is wrong".

`packages/db/src/einvoice/verify.ts`:

```ts
// packages/db/src/einvoice/verify.ts (5B)
//
// The OD-15 verification command (hazard 5). Four checks, four lines, one per key, and every one of
// them runs identically against `synthetic` and against `myinvois` — which is what makes the local
// equivalent a real equivalent rather than a different code path.
//
// It prints no secret and no response body. `reachable` reports the HTTP status class only.

import { loadProfile, ProfileNotFoundError } from "./profile";
import type { EInvoiceProfile } from "@dulja/domain";
import { readSecret, EINVOICE_SECRET_NAMES } from "./credentials";
import { renderPath } from "@dulja/domain";
import { EInvoiceError } from "./errors";

export interface VerifyResult {
  profile: "ok" | string;
  schema: "ok" | string;
  credentials: "present" | string;
  reachable: "ok" | string;
}

export async function verifyProfile(
  code: string,
  opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; profile?: EInvoiceProfile } = {},
): Promise<VerifyResult> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const doFetch = opts.fetchImpl ?? fetch;
  const result: VerifyResult = { profile: "ok", schema: "ok", credentials: "present", reachable: "ok" };

  // `opts.profile` is for a caller that already holds a parsed profile whose `baseUrl` differs from
  // the committed file's — which is every test, because `synthetic.v1.json` is committed with
  // `"baseUrl": "http://127.0.0.1:0"` and the loopback stub binds a RANDOM port that only
  // `startStubServer()`'s own `server.profile` carries. Without it the `reachable` probe would
  // always go to port 0 and hazard 5's local equivalent could never print `reachable: ok`.
  // The `schema` check still runs: an injected profile came through `parseProfile` to exist.
  let profile: EInvoiceProfile;
  if (opts.profile) {
    profile = opts.profile;
  } else {
    try {
      profile = loadProfile(code);
    } catch (e) {
      if (e instanceof ProfileNotFoundError) {
        return { profile: `no profile file for "${code}" in packages/db/einvoice-profiles`, schema: "not checked", credentials: "not checked", reachable: "not checked" };
      }
      // parseProfile threw: the file exists but does not satisfy einvoice-profile.schema.json.
      return { profile: "ok", schema: (e as Error).message, credentials: "not checked", reachable: "not checked" };
    }
  }

  // The secret must be one of the declared names AND set in this environment.
  const ref = EINVOICE_SECRET_NAMES[0];
  try {
    readSecret(ref, env);
  } catch (e) {
    result.credentials = e instanceof EInvoiceError ? e.detail : (e as Error).message;
    result.reachable = "not checked";
    return result;
  }

  // Reachability: the poll call with a deliberately non-existent external id. Any HTTP answer at all
  // proves the base URL, the path template and TLS work; 401 would prove the credential does not,
  // which is why `credentials` is checked separately and first.
  const spec = profile.calls.poll;
  // The SAME join `http-transmitter.ts` uses: the schema's `baseUrl` pattern admits a trailing slash
  // and a path template is always rooted, so a profile written with one would otherwise produce a
  // double slash here and nowhere else — a verification command that probes a different URL than the
  // transmitter calls is worse than no verification command.
  const url = `${profile.baseUrl.replace(/\/$/, "")}${renderPath(spec.pathTemplate, { externalId: "verify-probe-nonexistent" })}`;
  try {
    const res = await doFetch(url, {
      method: spec.method,
      headers: { [profile.auth.header]: `${profile.auth.scheme ?? "Bearer"} ${readSecret(ref, env)}` },
      signal: AbortSignal.timeout(profile.timeoutMs ?? 10_000),
    });
    result.reachable = res.status >= 500 ? `remote answered ${res.status}` : "ok";
  } catch (e) {
    result.reachable = `no answer: ${(e as Error).name}`;
  }
  return result;
}

export function formatVerifyResult(r: VerifyResult): string {
  return [
    `profile: ${r.profile}`,
    `schema: ${r.schema}`,
    `credentials: ${r.credentials}`,
    `reachable: ${r.reachable}`,
  ].join("\n");
}
```

`packages/db/test/einvoice/verify.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStubServer, type StubServer } from "../support/einvoice-stub";
import { formatVerifyResult, verifyProfile } from "../../src/einvoice/verify";

let stub: StubServer;

beforeAll(async () => {
  stub = await startStubServer({ submit: { state: "queued", receiptId: "V-1" }, poll: { state: "cleared" }, cancel: { state: "withdrawn" } });
});
afterAll(async () => { await stub.stop(); });

describe("einvoice:verify (5B T9, hazard 5's local equivalent)", () => {
  it("prints the four lines for `synthetic` with the secret set", async () => {
    // `stub.profile` carries the port the stub actually bound; the committed file says port 0.
    const r = await verifyProfile("synthetic", { profile: stub.profile, env: { EINVOICE_CLIENT_SECRET: "stub-secret" } });
    expect(r).toEqual({ profile: "ok", schema: "ok", credentials: "present", reachable: "ok" });
    expect(formatVerifyResult(r)).toBe("profile: ok\nschema: ok\ncredentials: present\nreachable: ok");
  });

  it("names the missing environment variable rather than failing opaquely", async () => {
    const r = await verifyProfile("synthetic", { env: {} });
    expect(r.profile).toBe("ok");
    expect(r.schema).toBe("ok");
    expect(r.credentials).toContain("EINVOICE_CLIENT_SECRET");
    expect(r.reachable).toBe("not checked");
  });

  it("names the profile that does not exist", async () => {
    const r = await verifyProfile("nosuch", { env: { EINVOICE_CLIENT_SECRET: "x" } });
    expect(r.profile).toContain("nosuch");
    expect(r.schema).toBe("not checked");
  });

  it("reports an unreachable base URL without throwing", async () => {
    const dead = stub.profile;
    await stub.stop();
    const r = await verifyProfile("synthetic", { profile: dead, env: { EINVOICE_CLIENT_SECRET: "stub-secret" } });
    expect(r.credentials).toBe("present");
    expect(r.reachable).toMatch(/^no answer: /);
    stub = await startStubServer({ submit: { state: "queued", receiptId: "V-1" }, poll: { state: "cleared" }, cancel: { state: "withdrawn" } });
  });
});
```

`packages/db/src/cli.ts` — one sub-command beside the existing ones:

```ts
  if (command === "einvoice-verify") {
    const code = argValue(argv, "--profile") ?? "synthetic";
    const { verifyProfile, formatVerifyResult } = await import("./einvoice/verify");
    const result = await verifyProfile(code);
    console.log(formatVerifyResult(result));
    const ok = result.profile === "ok" && result.schema === "ok" && result.credentials === "present" && result.reachable === "ok";
    process.exit(ok ? 0 : 1);
  }
```

`packages/db/package.json` — one script (**no version literal anywhere; the lockfile owns versions**):

```json
    "einvoice:verify": "bun run src/cli.ts einvoice-verify"
```

Run it:

```bash
bun run --cwd packages/db test -- einvoice/verify
EINVOICE_CLIENT_SECRET=stub-secret bun run --cwd packages/db einvoice:verify --profile synthetic
```

**Expected:** four passing `it`s. **`verify.test.ts` is the authoritative form of hazard 5's local equivalent, and the CLI run is not** — the committed `synthetic.v1.json` names port **0** and a stub binds a random one, so from a shell the CLI prints `profile: ok`, `schema: ok`, `credentials: present` and `reachable: no answer: …` and exits 1. That is correct, not a defect: the test injects `stub.profile` (the only object that knows the bound port) through the `profile` option, which is exactly why that option exists. Against a real profile whose `baseUrl` is a real host — Task 9's `myinvois` — the CLI prints all four lines and exits 0, which is the case hazard 5's `Verify:` line describes. **From this commit onward, Task 9's and Task 11's `Until provided:` local equivalent names a command and a test that exist**, whether or not OD-15 is ever answered.

- [ ] **Step 8: Run the tests to green**

```bash
bun run --cwd packages/db test -- einvoice/profile einvoice/http-transmitter einvoice/verify
bun run typecheck && bun run lint && bun run lint:rules && bun run format:check
```

**Expected:** **twenty-nine** passing `it`s across the two files — fourteen in `profile.test.ts` (4 `loadProfile` + 5 credentials + 5 `redactResponse`) and fifteen in `http-transmitter.test.ts` (5 canonicalise + 8 submit + 2 poll/cancel) — plus Step 7's four in `verify.test.ts`. Three things must be true and are each asserted:
- **no request is made when the secret is unset** (`server.calls` is empty) — `readSecret` runs before the URL is built;
- **a 4xx refusal is an outcome and a 5xx is a fault** — the first returns `rejected`, the second throws `TransientTransmissionError`, and Task 7's handler treats them differently;
- **the submit body is byte-identical to a second `canonicalJson` of the same document**, which is test 26's determinism claim moved onto the wire.

`lint:rules` covers `no-bare-db` (this task writes no SQL outside `packages/db/test/**`, which is allow-listed), `no-sql-concat` (the path template is interpolated into a URL and the `no-sql-concat` rule fires only on a concatenation containing `select|insert|update|delete|where` — `renderPath`'s output contains none, and Task 11's `legacy-019`/test-27 block asserts it) and `no-number-money` (`httpStatus`, `version`, `attempts`, `length` and `port` are `number` and none matches the money pattern).

- [ ] **Step 9: Commit**

```bash
git add packages/db/einvoice-profiles packages/db/src/einvoice packages/db/src/cli.ts \
        packages/db/test/support/einvoice-stub.ts \
        packages/db/test/einvoice/profile.test.ts packages/db/test/einvoice/http-transmitter.test.ts \
        packages/db/test/einvoice/verify.test.ts \
        packages/db/package.json
git commit -m "$(cat <<'EOF'
feat(db): the e-invoice profile loader, HTTP adapter, synthetic transmitter and registry [5B T4]

ADR 0052 implemented: a profile is data, validated against the committed schema;
createHttpTransmitter turns any conforming profile into an EInvoiceTransmitter;
canonicalise and qrPayload are constructor parameters because their content is
ADR-0051 prose. The synthetic transmitter and its loopback profile make the whole
path CI-green before OD-15. registerDefaultTransmitters refuses to register
'synthetic' in production. redactResponse fixes what may reach `response jsonb`
(ADR 0053) and readSecret is the only place a secret NAME becomes a VALUE.

verify.ts, its test and the einvoice-verify CLI sub-command ship here and not in
the OD-15 task: they are not OD-15 content, and hazard 5's "Until provided" local
equivalent has to name a command that exists while OD-15 is still pending.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `transmission.ts` — the log's state machine, its three error codes and its bounded claim

**The log is the state of record (ADR 0053).** Every remote call is bracketed by two short `withTenant` transactions with the HTTP call **between** them — never inside one, because spec:1368 requires many short transactions and a transaction held open across a network call to an authority is the longest one in the system.

**Files:**
- Create: `packages/db/src/einvoice/transmission.ts`
- Create: `packages/db/src/einvoice/index.ts`
- Create: `packages/db/test/einvoice/transmission.test.ts`
- Modify: `packages/db/src/index.ts` — one `export * from "./einvoice";`
- Modify: `packages/contracts/src/errors.ts` — the three rows of Global Constraint 9
- Modify: `docs/adr/0053-transmission-state-retry-and-what-may-be-logged.md` (created here)

**Interfaces**

- Consumes: `withTenant`, `TenantContext`, `systemContext` (§4.2.2); `Sql` from `postgres`; `loadSnapshot` (§4.3.1); `transmitterFor`, `RegisteredTransmitter`, `registerDefaultTransmitters`, `resetTransmitters` (Task 4); `credentialsFor`, `CompanyEInvoiceSettings` (Task 4); `TransientTransmissionError` (Task 4); `EInvoiceError` (Task 4); `TransmissionStatus`, `isTransmissionStatus` (Task 3); `encodeCursor`, `decodeCursor` — **no**: see Step 4's note on why the list is keyset-paged with the codec from `@dulja/contracts` in the *route*, not here.
- Produces:

```ts
// packages/db/src/einvoice/transmission.ts
export interface EinvoiceTransmissionRow {
  id: string; companyId: string; documentId: string; transmitter: string;
  profileVersion: number | null; externalId: string | null; status: TransmissionStatus;
  attempts: number; lastError: string | null; requestSha256: string | null;   // lower-case hex
  response: Record<string, unknown> | null; qrPayload: string | null;
  submittedAt: string | null; acceptedAt: string | null; cancelledAt: string | null;
  polledAt: string | null; claimedAt: string | null; createdAt: string;
}
export const SUBMITTABLE_FROM: readonly TransmissionStatus[];   // pending, error, rejected
export const POLLABLE_FROM: readonly TransmissionStatus[];      // submitted
export const CANCELLABLE_FROM: readonly TransmissionStatus[];   // accepted
export const CLAIM_WINDOW_SECONDS: 120;
export async function recordPending(tx: Sql, input: { documentId: string; companyId: string; transmitter: string }): Promise<string>;
export async function getTransmission(tx: Sql, transmissionId: string): Promise<EinvoiceTransmissionRow>;
export interface ListTransmissionsInput { companyId: string; status?: TransmissionStatus; afterId?: string | null; limit: number }
export async function listTransmissions(tx: Sql, input: ListTransmissionsInput): Promise<EinvoiceTransmissionRow[]>;
export async function submitTransmission(sql: Sql, ctx: TenantContext, input: { transmissionId: string }): Promise<EinvoiceTransmissionRow>;
export async function pollTransmission(sql: Sql, ctx: TenantContext, input: { transmissionId: string }): Promise<EinvoiceTransmissionRow>;
export async function cancelTransmission(sql: Sql, ctx: TenantContext, input: { transmissionId: string; reason: string }): Promise<EinvoiceTransmissionRow>;
export async function companySettings(tx: Sql, companyId: string): Promise<CompanyEInvoiceSettings>;
```

- [ ] **Step 1: Write ADR 0053 as a proposal, and ask**

`docs/adr/0053-transmission-state-retry-and-what-may-be-logged.md`:

```markdown
# 0053 — Transmission state, bounded retry, and what may be logged

- Status: **proposed** (spec:95 — this touches the data model and what an incident responder can
  see; do not merge the implementation before this is accepted)
- Date: 2026-09-05
- Slice: 5B

## Context

spec:2225 asks for "document hash, QR code, transmission log, retry, and status reconciliation"
and nothing more; §4.9.3 gives six statuses and `retryLimit 8`. Three questions are left open and
each has a wrong answer that is easy to reach.

## Decision

**1. The legal transitions, and there are exactly these.**

| From | Verb | To |
|---|---|---|
| `pending`, `error`, `rejected` | submit | `submitted`, `accepted`, `rejected`, `error` |
| `submitted` | poll | `submitted`, `accepted`, `rejected`, `error` |
| `accepted` | cancel | `cancelled`, `rejected`, `error` |

`cancelled` is terminal. `rejected` is **not** terminal — an authority's refusal is corrected and
resubmitted, which is a normal operation and not a new document; a rejection that needs a credit
note is a *business* decision the operator makes, and the log must not pre-empt it. `error` is
always resubmittable: it is the state an unmapped remote label, a redacted parse failure or an
exhausted retry lands in.

Anything else is `ERR_EINVOICE_STATUS_ILLEGAL` (409), naming the current status and the legal set.

**2. Transient versus permanent, and who retries.**

A 5xx, a timeout and a connection failure are `TransientTransmissionError`: the handler **throws**,
pg-boss retries with `retryLimit 8` and exponential backoff, and the row keeps its previous status
with `attempts` incremented and `last_error` set. A 4xx is an **outcome**: the row moves to
`rejected` (or `error` for an unmapped label) and the handler returns normally, because retrying a
refusal eight times is how an integration gets rate-limited off an authority's platform.

**3. Two short transactions with the call between them, and a bounded claim.**

`withTenant` opens a real transaction; holding one across a call to an authority would be the
longest transaction in the system and would hold a row lock for its duration (spec:1368 asks for
many short transactions). So: **claim** (short), **call** (no transaction), **record** (short).

The claim stamps `claimed_at = now()` and increments `attempts`, and admits a re-claim only when
`claimed_at` is null or older than **120 seconds** — the same window §4.2.9 already uses to reclaim
a dead idempotency reservation, reused rather than re-invented. **The record step clears
`claimed_at` and stamps `polled_at = now()`, and so does the fault path**, so the claim lasts
exactly as long as the call does. **The fault path covers every refusal raised after the claim, not
only the transport ones**: `ERR_EINVOICE_NOT_ENABLED` from `credentialsFor`,
`ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` from `transmitterFor`, a `loadSnapshot` failure and a
canonicaliser's refusal on an unmappable required field are all inside the same `try`. A refusal that
released nothing would be worse than a transport failure, because the second is retried and the first
would not be — and `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` is exactly the state every `myinvois`
company is in until OD-15 is discharged. Two columns, and the reason is that one cannot carry both
meanings: if the claim instant *were* `polled_at`, then the `poll` that legitimately follows a
`submit` seconds later would be refused, and every pg-boss retry (`retryDelaySeconds: 60`) would
arrive inside the 120-second window and be swallowed by the handler's "already settled" branch —
which would make `retryLimit 8` dead for the one case it exists for.

It bounds, and does not eliminate, a concurrent duplicate: the job path is already single-flighted
by `singletonKey = transmissionId`, the route path by `Idempotency-Key`, and the claim's
`and attempts = <the value just read>` predicate is optimistic concurrency over the same row. The
window's residual job is the crash case — a process that took a claim and died before recording.
A residual duplicate produces a second submission the authority deduplicates on its own document
identity — which is a fact for ADR 0051 to confirm, and the OD-15 task's checklist asks it.

**4. What may reach `response jsonb`.**

The row is audited, so whatever is stored here is copied into `app.audit_log` for the retention
period. `redactResponse` (Task 4) therefore: redacts any key matching
`/token|password|authorization|card|pin|secret/i` at every depth; truncates a string at 1024;
caps an array at 50; records a non-JSON body as `{ nonJson: true, length }`; and stops at depth 6.
**A request body is never stored** — `request_sha256` is, which is enough to prove what was sent
and cannot leak a buyer's details into the audit log.

## Consequences

- An operator can always answer "what did we send, when, how many times, and what came back", and
  can never answer it with a credential.
- A transmission stuck at `submitted` is visible by `polled_at` alone, with no pg-boss query.
- Reconciliation is the poll phase re-enqueueing itself, so a `JOBS` name is not spent on it.
- A rejected document can be corrected and resubmitted on the same log row, so the
  `unique (tenant_id, document_id)` of migration 0057 stays true.
```

- [ ] **Step 2: Write the failing test first**

`packages/db/test/einvoice/transmission.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import {
  cancelTransmission, getTransmission, listTransmissions, pollTransmission,
  recordPending, submitTransmission,
} from "../../src/einvoice/transmission";
import { EInvoiceError } from "../../src/einvoice/errors";
import { registerTransmitter, resetTransmitters } from "../../src/einvoice/registry";
import { createSyntheticTransmitter } from "../../src/einvoice/synthetic";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { draftDocument, seedTenant, type Seed } from "../fixtures";
import { enableEinvoice, startStubServer, type StubServer } from "../support/einvoice-stub";

const ENV = { EINVOICE_CLIENT_SECRET: "s3cr3t" };

describe("the transmission log's state machine (ADR 0053)", () => {
  let db: Db;
  let s: Seed;
  let ctx: { tenantId: string; actorId: string; requestId: string };
  let server: StubServer | null = null;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenant(db, "einvoice-log");
    ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    await enableEinvoice(db, s);
  }, 180_000);

  afterEach(async () => { await server?.stop(); server = null; resetTransmitters(); });
  afterAll(async () => { await db.stop(); });

  const arm = async (script: Parameters<typeof startStubServer>[0]) => {
    server = await startStubServer(script);
    registerTransmitter("synthetic", createSyntheticTransmitter({
      profile: server.profile, env: ENV,
    }));
    return server;
  };

  const pending = async (): Promise<string> => {
    const documentId = await draftDocument(db, s);
    return prodWithTenant(db.rw, ctx, (tx) =>
      recordPending(tx, { documentId, companyId: s.company, transmitter: "synthetic" }));
  };

  it("recordPending writes a row at pending with attempts 0 and no external id", async () => {
    const id = await pending();
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.externalId).toBeNull();
    expect(row.requestSha256).toBeNull();
    expect(row.profileVersion).toBeNull();
    expect(row.polledAt).toBeNull();
    expect(row.claimedAt).toBeNull();      // no call has been claimed, let alone made
  });

  it("submit records external id, hash, profile version, attempts and submitted_at", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-10" } });
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(row.status).toBe("submitted");
    expect(row.externalId).toBe("R-10");
    expect(row.attempts).toBe(1);
    expect(row.profileVersion).toBe(1);
    expect(row.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.submittedAt).not.toBeNull();
    expect(row.polledAt).not.toBeNull();    // the call COMPLETED at this instant
    expect(row.claimedAt).toBeNull();       // and its claim ended with it (ADR 0053), which is what
                                            // lets the next `it` poll straight afterwards
    expect(row.acceptedAt).toBeNull();
  });

  it("submit that clears in one call sets accepted_at and the QR payload", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-11" } });
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(row.status).toBe("accepted");
    expect(row.acceptedAt).not.toBeNull();
    expect(row.qrPayload).toMatch(/^dulja-synthetic:[0-9a-f]{64}:[0-9a-f]{64}$/);
  });

  it("poll moves submitted → accepted and writes the QR payload and polled_at", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-12" }, poll: [{ state: "queued" }, { state: "cleared" }] });
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });

    const stillOpen = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(stillOpen.status).toBe("submitted");
    expect(stillOpen.qrPayload).toBeNull();

    const done = await pollTransmission(db.rw, ctx, { transmissionId: id });
    expect(done.status).toBe("accepted");
    expect(done.qrPayload).not.toBeNull();
    expect(done.attempts).toBe(3);
  });

  it("cancel moves accepted → cancelled and keeps accepted_at", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-13" }, cancel: { state: "withdrawn" } });
    const id = await pending();
    const accepted = await submitTransmission(db.rw, ctx, { transmissionId: id });
    const cancelled = await cancelTransmission(db.rw, ctx, { transmissionId: id, reason: "keyed twice" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.acceptedAt).toBe(accepted.acceptedAt);
  });

  it("a 4xx refusal is an OUTCOME: status rejected, no throw, and resubmit is legal", async () => {
    await arm({
      submit: [
        { status: 422, json: { state: "refused", receiptId: "R-14", reason: "stub refusal" } },
        { state: "cleared", receiptId: "R-14" },
      ],
    });
    const id = await pending();
    const rejected = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(rejected.status).toBe("rejected");
    expect(rejected.lastError).toContain("stub refusal");

    const retried = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(retried.status).toBe("accepted");
    expect(retried.attempts).toBe(2);
  });

  it("a 5xx is a FAULT: the call throws for pg-boss, the row keeps its status and counts the attempt", async () => {
    await arm({ submit: { status: 503, json: { state: "queued" } } });
    const id = await pending();
    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toThrow(/503/);
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("503");
  });

  it("an UNMAPPED remote label lands in error with the label in last_error (LEGACY-020)", async () => {
    await arm({ submit: { state: "in_review", receiptId: "R-15" } });
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(row.status).toBe("error");
    expect(row.lastError).toContain("in_review");
  });

  it("refuses every illegal verb with ERR_EINVOICE_STATUS_ILLEGAL naming the legal set", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-16" }, cancel: { state: "withdrawn" } });
    const id = await pending();

    await expect(pollTransmission(db.rw, ctx, { transmissionId: id }))
      .rejects.toThrow(/is pending; poll is legal only from submitted/);

    await expect(cancelTransmission(db.rw, ctx, { transmissionId: id, reason: "x" }))
      .rejects.toThrow(/is pending; cancel is legal only from accepted/);

    await submitTransmission(db.rw, ctx, { transmissionId: id });
    await expect(submitTransmission(db.rw, ctx, { transmissionId: id }))
      .rejects.toThrow(/is accepted; submit is legal only from pending, error, rejected/);

    await cancelTransmission(db.rw, ctx, { transmissionId: id, reason: "x" });
    await expect(cancelTransmission(db.rw, ctx, { transmissionId: id, reason: "x" }))
      .rejects.toThrow(/is cancelled; cancel is legal only from accepted/);
  });

  it("refuses a company with e-invoicing off — ERR_EINVOICE_NOT_ENABLED", async () => {
    const other = await seedTenant(db, "einvoice-off");
    const otherCtx = { tenantId: other.tenant, actorId: other.human, requestId: await uuidv7(db.admin) };
    const documentId = await draftDocument(db, other);
    const id = await prodWithTenant(db.rw, otherCtx, (tx) =>
      recordPending(tx, { documentId, companyId: other.company, transmitter: "synthetic" }));
    try {
      await submitTransmission(db.rw, otherCtx, { transmissionId: id });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as EInvoiceError).code).toBe("ERR_EINVOICE_NOT_ENABLED");
    }
  });

  it("refuses an unregistered transmitter — ERR_EINVOICE_TRANSMITTER_UNAVAILABLE (OD-15's default)", async () => {
    resetTransmitters();                                   // nothing registered
    const id = await pending();
    try {
      await submitTransmission(db.rw, ctx, { transmissionId: id });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as EInvoiceError).code).toBe("ERR_EINVOICE_TRANSMITTER_UNAVAILABLE");
      expect((e as EInvoiceError).message).toContain("synthetic is not registered");
    }
  });

  it("ENDS THE CLAIM when the refusal comes before the call, so the retry is not swallowed", async () => {
    // The one assertion that keeps `retryLimit: 8` alive for the case it exists for. `claim()` has
    // already stamped `claimed_at`; `transmitterFor` then throws. If that throw skipped
    // `recordFault`, the claim would stand for CLAIM_WINDOW_SECONDS (120) while pg-boss's first
    // retry arrives at retryDelaySeconds (60) — inside the window — and `claim()` would refuse it
    // with ERR_EINVOICE_STATUS_ILLEGAL, which Task 7's handler reads as "nothing to do". The row
    // would be abandoned at `pending`. It is also the state every `myinvois` company is in before
    // OD-15, which is the path this slice most needs to keep retryable.
    resetTransmitters();                                   // nothing registered
    const id = await pending();
    await expect(submitTransmission(db.rw, ctx, { transmissionId: id })).rejects.toThrow(EInvoiceError);

    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.claimedAt, "recordFault must end the claim (ADR 0053 §3)").toBeNull();
    expect(row.polledAt).not.toBeNull();                   // the attempt completed, unsuccessfully
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("not registered");

    // And the immediate re-attempt is admitted rather than refused as "a call in flight".
    await arm({ submit: { state: "queued", receiptId: "R-21" } });
    const retried = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(retried.status).toBe("submitted");
    expect(retried.attempts).toBe(2);
  });

  it("refuses a transmission id another tenant owns with ERR_NOT_FOUND, never revealing it exists", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-17" } });
    const id = await pending();
    const other = await seedTenant(db, "einvoice-nosee");
    const otherCtx = { tenantId: other.tenant, actorId: other.human, requestId: await uuidv7(db.admin) };
    try {
      await prodWithTenant(db.rw, otherCtx, (tx) => getTransmission(tx, id));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as EInvoiceError).code).toBe("ERR_NOT_FOUND");
    }
  });

  it("lists by company, newest first, filtered by status, keyset-paged by id", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-18" } });
    const a = await pending();
    const b = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: b });

    const all = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 100 }));
    expect(all.map((r) => r.id)).toContain(a);
    expect(all.map((r) => r.id)).toContain(b);
    expect(all[0]!.id > all[1]!.id).toBe(true);            // uuidv7 is time-ordered; newest first

    const submitted = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, status: "submitted", limit: 100 }));
    expect(submitted.every((r) => r.status === "submitted")).toBe(true);

    const firstPage = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 1 }));
    const secondPage = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 1, afterId: firstPage[0]!.id }));
    expect(secondPage[0]!.id).not.toBe(firstPage[0]!.id);
    expect(secondPage[0]!.id < firstPage[0]!.id).toBe(true);
  });

  it("never stores a credential in `response`, even when the authority echoes one", async () => {
    await arm({ submit: { json: { state: "cleared", receiptId: "R-19", accessToken: "leaky", nested: { clientSecret: "leaky" } } } });
    const id = await pending();
    const row = await submitTransmission(db.rw, ctx, { transmissionId: id });
    expect(JSON.stringify(row.response)).not.toContain("leaky");
    expect(JSON.stringify(row.response)).toContain("[redacted]");
  });

  it("every write is audited under the acting principal (test 13)", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-20" } });
    const id = await pending();
    await submitTransmission(db.rw, ctx, { transmissionId: id });
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ action: string; actor_id: string }[]>`
        select action, actor_id::text
          from app.audit_log
         where table_name = 'einvoice_transmission' and row_id = ${id}
         order by seq`);
    expect(rows.map((r) => r.action)).toEqual(["insert", "update", "update"]);
    expect(new Set(rows.map((r) => r.actor_id))).toEqual(new Set([s.human]));
  });
});
```

Run it:

```bash
bun run --cwd packages/db test -- einvoice/transmission
```

**Expected failure:** `Cannot find module '../../src/einvoice/transmission'`.

- [ ] **Step 3: Add the three error rows**

In `packages/contracts/src/errors.ts`, inside `ERRORS`, in the order §4.2.4's table allocates them:

```ts
  ERR_EINVOICE_NOT_ENABLED: {
    status: 422,
    title: "E-invoicing is not enabled",
    remedy: "Set the company's e-invoice transmitter, client id and credential reference under Company settings.",
  },
  ERR_EINVOICE_TRANSMITTER_UNAVAILABLE: {
    status: 422,
    title: "E-invoice transmitter unavailable",
    remedy: "Check that the transmitter is registered in this deployment and that its credential secret is set.",
  },
  ERR_EINVOICE_STATUS_ILLEGAL: {
    status: 409,
    title: "Transmission status does not permit this action",
    remedy: "Read the transmission's current status; submit, poll and cancel are each legal only from their own states.",
  },
```

**All three land in this commit and all three are raised in this commit** — `credentialsFor` and `readSecret` raise the first two from Task 4's modules (which this commit's tests exercise) and the state machine raises the third — so `scripts/lint/rules/error-codes.ts` stays green (spec:2051).

- [ ] **Step 4: Write the state machine**

`packages/db/src/einvoice/transmission.ts`:

```ts
// packages/db/src/einvoice/transmission.ts
//
// The transmission log is the state of record (ADR 0053). Every remote call is: claim (one short
// transaction) -> call (NO transaction) -> record (one short transaction). A withTenant transaction
// is never held across a call to an authority (spec:1368).

import type { Sql } from "postgres";
import { isTransmissionStatus, type TransmissionStatus } from "@dulja/domain";
import { loadSnapshot } from "../posting/load";
import { withTenant, type TenantContext } from "../with-tenant";
import { credentialsFor, type CompanyEInvoiceSettings } from "./credentials";
import { EInvoiceError } from "./errors";
import { TransientTransmissionError } from "./http-transmitter";
import { transmitterFor } from "./registry";

export interface EinvoiceTransmissionRow {
  id: string;
  companyId: string;
  documentId: string;
  transmitter: string;
  profileVersion: number | null;
  externalId: string | null;
  status: TransmissionStatus;
  attempts: number;
  lastError: string | null;
  /** Lower-case hex of the stored bytea — the wire form, and what a test compares. */
  requestSha256: string | null;
  response: Record<string, unknown> | null;
  qrPayload: string | null;
  submittedAt: string | null;
  acceptedAt: string | null;
  cancelledAt: string | null;
  polledAt: string | null;
  /** A remote call is in flight since this instant; null means none is (ADR 0053). */
  claimedAt: string | null;
  createdAt: string;
}

/** ADR 0053's table, as data. `rejected` is deliberately resubmittable; `cancelled` is terminal. */
export const SUBMITTABLE_FROM: readonly TransmissionStatus[] = ["pending", "error", "rejected"];
export const POLLABLE_FROM: readonly TransmissionStatus[] = ["submitted"];
export const CANCELLABLE_FROM: readonly TransmissionStatus[] = ["accepted"];

/** The same window §4.2.9 reclaims a dead idempotency reservation after. Not a second number. */
export const CLAIM_WINDOW_SECONDS = 120;

// The seventeen-column projection is written out IN FULL in each of the two queries that need it.
// It is not hoisted into a shared fragment constant, because splicing a fragment into a tagged
// template needs `tx.unsafe`, and §3.3 pins `sql.unsafe` to exactly three homes — the migration
// runner, the pg-boss enqueue adapter and the Firebird reader — none of which is here (hazard 21,
// Global Constraint 5). Two copies of a column list is the cost of that rule and is deliberate; a
// fourth `sql.unsafe` home would be a §3.3 amendment this slice has no business making. The only
// two readers are `getTransmission` and `listTransmissions`; both `update … returning` paths call
// `getTransmission`, so the list is never written a third time.

/** Insert the pending row. Called from §4.3.2 step 14 inside the posting transaction (Task 6). */
export async function recordPending(
  tx: Sql,
  input: { documentId: string; companyId: string; transmitter: string },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.einvoice_transmission (tenant_id, company_id, document_id, transmitter)
    values (app.current_tenant(), ${input.companyId}, ${input.documentId}, ${input.transmitter})
    on conflict (tenant_id, document_id) do update
      set transmitter = excluded.transmitter
    returning id::text as id`;
  return row!.id;
}

export async function getTransmission(tx: Sql, transmissionId: string): Promise<EinvoiceTransmissionRow> {
  const rows = await tx<EinvoiceTransmissionRow[]>`
    select id::text                                            as "id",
           company_id::text                                    as "companyId",
           document_id::text                                   as "documentId",
           transmitter                                         as "transmitter",
           profile_version                                     as "profileVersion",
           external_id                                         as "externalId",
           status                                              as "status",
           attempts                                            as "attempts",
           last_error                                          as "lastError",
           encode(request_sha256, 'hex')                       as "requestSha256",
           response                                            as "response",
           qr_payload                                          as "qrPayload",
           to_char(submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "submittedAt",
           to_char(accepted_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "acceptedAt",
           to_char(cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "cancelledAt",
           to_char(polled_at    at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "polledAt",
           to_char(claimed_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "claimedAt",
           to_char(created_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "createdAt"
      from app.einvoice_transmission where id = ${transmissionId}`;
  const row = rows[0];
  if (!row) {
    // RLS has already reduced the table to the caller's tenant, so "invisible" and "absent" are the
    // same answer here — and §4.2.4 requires ERR_NOT_FOUND never to reveal cross-tenant existence.
    throw new EInvoiceError("ERR_NOT_FOUND", `transmission ${transmissionId} does not exist`);
  }
  return row;
}

export interface ListTransmissionsInput {
  companyId: string;
  status?: TransmissionStatus;
  afterId?: string | null;
  limit: number;
}

/**
 * Newest first, keyset-paged on `id` alone — `id` is a uuidv7 and is therefore time-ordered
 * (§3.2), so `id desc` IS "newest first" and no second sort key is needed. The route encodes the
 * cursor with §4.2.8's `encodeCursor`/`decodeCursor`; this function takes the decoded `afterId`,
 * because `packages/db` may not import `@dulja/contracts` (§3.1).
 */
export async function listTransmissions(
  tx: Sql,
  input: ListTransmissionsInput,
): Promise<EinvoiceTransmissionRow[]> {
  return tx<EinvoiceTransmissionRow[]>`
    select id::text                                            as "id",
           company_id::text                                    as "companyId",
           document_id::text                                   as "documentId",
           transmitter                                         as "transmitter",
           profile_version                                     as "profileVersion",
           external_id                                         as "externalId",
           status                                              as "status",
           attempts                                            as "attempts",
           last_error                                          as "lastError",
           encode(request_sha256, 'hex')                       as "requestSha256",
           response                                            as "response",
           qr_payload                                          as "qrPayload",
           to_char(submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "submittedAt",
           to_char(accepted_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "acceptedAt",
           to_char(cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "cancelledAt",
           to_char(polled_at    at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "polledAt",
           to_char(claimed_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "claimedAt",
           to_char(created_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')  as "createdAt"
      from app.einvoice_transmission
     where company_id = ${input.companyId}
       and (${input.status ?? null}::text is null or status = ${input.status ?? null})
       and (${input.afterId ?? null}::uuid is null or id < ${input.afterId ?? null})
     order by id desc
     limit ${input.limit}`;
}

export async function companySettings(tx: Sql, companyId: string): Promise<CompanyEInvoiceSettings> {
  const [row] = await tx<{ transmitter: string | null; clientId: string | null; credentialRef: string | null }[]>`
    select einvoice_transmitter    as "transmitter",
           einvoice_client_id      as "clientId",
           einvoice_credential_ref as "credentialRef"
      from app.company where id = ${companyId}`;
  if (!row) throw new EInvoiceError("ERR_NOT_FOUND", `company ${companyId} does not exist`);
  return row;
}

// ── the claim ─────────────────────────────────────────────────────────────────────────────────

async function claim(
  sql: Sql,
  ctx: TenantContext,
  transmissionId: string,
  verb: "submit" | "poll" | "cancel",
  legalFrom: readonly TransmissionStatus[],
): Promise<EinvoiceTransmissionRow> {
  return withTenant(sql, ctx, async (tx) => {
    const current = await getTransmission(tx, transmissionId);
    if (!legalFrom.includes(current.status)) {
      throw new EInvoiceError(
        "ERR_EINVOICE_STATUS_ILLEGAL",
        `transmission ${transmissionId} is ${current.status}; ${verb} is legal only from ${legalFrom.join(", ")}`,
      );
    }
    const claimed = await tx<{ id: string }[]>`
      update app.einvoice_transmission
         set attempts   = attempts + 1,
             claimed_at = now()
       where id = ${transmissionId}
         and attempts = ${current.attempts}
         and (claimed_at is null
              or claimed_at < now() - make_interval(secs => ${CLAIM_WINDOW_SECONDS}))
      returning id::text as id`;
    if (claimed.length === 0) {
      // Another caller has a call IN FLIGHT (`claimed_at` set and younger than the window), or the
      // row's `attempts` moved under us. ADR 0053: the job path is single-flighted by singletonKey
      // and the route path by Idempotency-Key, so this is the residual race and the right answer is
      // to refuse rather than to double-submit to the authority. It is NOT the ordinary
      // submit-then-poll sequence: every verb clears `claimed_at` when its call ends.
      throw new EInvoiceError(
        "ERR_EINVOICE_STATUS_ILLEGAL",
        `transmission ${transmissionId} has a call in flight (claimed within ${CLAIM_WINDOW_SECONDS}s)`,
      );
    }
    return getTransmission(tx, transmissionId);
  });
}

/**
 * Records why a remote call failed AND **ends the claim** — `claimed_at = null`, `polled_at = now()`
 * (the call completed, unsuccessfully, at this instant).
 *
 * Ending the claim is the load-bearing half and the reason is arithmetic: `claim()` refuses re-entry
 * while `claimed_at` is younger than `CLAIM_WINDOW_SECONDS` (120), and `accounting.tax.submit` is
 * enqueued with `retryDelaySeconds: 60`, so pg-boss's first retry arrives INSIDE that window. If the
 * claim outlived the call, `claim()` would raise `ERR_EINVOICE_STATUS_ILLEGAL`, the handler's catch
 * would read that as "no longer actionable — nothing to do", pg-boss would mark the job complete,
 * and the row would be abandoned at `pending` with `retryLimit 8` never exercised for the one case
 * it exists for (§4.9.3, spec:2225).
 *
 * `attempts` is NOT decremented — it counts attempts, and the bounded retry is pg-boss's job.
 */
async function recordFault(sql: Sql, ctx: TenantContext, transmissionId: string, message: string): Promise<void> {
  await withTenant(sql, ctx, async (tx) => {
    await tx`
      update app.einvoice_transmission
         set last_error  = ${message.slice(0, 2000)},
             claimed_at  = null,
             polled_at   = now()
       where id = ${transmissionId}`;
  });
}

// ── the three verbs ───────────────────────────────────────────────────────────────────────────

export async function submitTransmission(
  sql: Sql,
  ctx: TenantContext,
  input: { transmissionId: string },
): Promise<EinvoiceTransmissionRow> {
  const claimed = await claim(sql, ctx, input.transmissionId, "submit", SUBMITTABLE_FROM);

  // ⚠️ EVERYTHING BETWEEN THE CLAIM AND THE END OF THE CALL IS INSIDE THIS `try`, and that is the
  // whole point of the block. `credentialsFor` raises ERR_EINVOICE_NOT_ENABLED, `transmitterFor`
  // raises ERR_EINVOICE_TRANSMITTER_UNAVAILABLE, `loadSnapshot` can raise, and a canonicaliser can
  // raise on an unmappable required field — all of them AFTER `claim()` stamped `claimed_at`. A
  // throw that skipped `recordFault` would leave the claim standing for 120 seconds; pg-boss's
  // first retry arrives at 60 (`retryDelaySeconds`), `claim()` would refuse it with
  // ERR_EINVOICE_STATUS_ILLEGAL, and Task 7's handler reads that code as "no longer actionable —
  // nothing to do" and completes the job. The row would sit at `pending` for ever with
  // `retryLimit 8` never exercised. ERR_EINVOICE_TRANSMITTER_UNAVAILABLE is the state EVERY
  // `myinvois` company is in before OD-15, which is the one path this slice most needs to keep
  // retryable (ADR 0053 §3, and Task 7's "the pg-boss retry REACHES the authority" test).
  let transmitter: ReturnType<typeof transmitterFor>;
  let doc: ReturnType<typeof transmitter.canonicalise>;
  let result: Awaited<ReturnType<typeof transmitter.submit>>;
  try {
    const settings = await withTenant(sql, ctx, (tx) => companySettings(tx, claimed.companyId));
    const credentials = credentialsFor(settings);                     // ERR_EINVOICE_NOT_ENABLED
    transmitter = transmitterFor(settings.transmitter!);              // ERR_EINVOICE_TRANSMITTER_UNAVAILABLE

    // The snapshot is read in its own short transaction, and canonicalisation is pure — so the
    // payload is a function of STORED line figures and a later tax_code version cannot change it
    // (LEGACY-020's "regime pinned on submission"; tests/regression/legacy-020.test.ts proves it).
    const snapshot = await withTenant(sql, ctx, (tx) => loadSnapshot(tx, claimed.documentId));
    doc = transmitter.canonicalise(snapshot);

    result = await transmitter.submit(doc, credentials);
  } catch (e) {
    const message = e instanceof TransientTransmissionError
      ? `transient: ${e.message} (http ${e.httpStatus})`
      : `submit failed: ${(e as Error).message}`;
    await recordFault(sql, ctx, input.transmissionId, message);
    throw e;                       // pg-boss retries a TransientTransmissionError; anything else surfaces
  }

  const unmapped = transmitter.lastCall?.unmapped ?? null;
  const qr = result.status === "accepted" && result.externalId !== ""
    ? transmitter.qrPayload(doc, { externalId: result.externalId })
    : null;

  return withTenant(sql, ctx, async (tx) => {
    await tx`
      update app.einvoice_transmission
         set status          = ${result.status},
             external_id     = coalesce(${result.externalId === "" ? null : result.externalId}, external_id),
             profile_version = ${transmitter.profile.version},
             request_sha256  = decode(${doc.hash}, 'hex'),
             response        = ${tx.json(result.raw as Record<string, unknown>)},
             submitted_at    = coalesce(submitted_at, now()),
             claimed_at      = null,                       -- the call ended; the claim ends with it
             polled_at       = now(),                      -- the last COMPLETED remote call
             accepted_at     = case when ${result.status} = 'accepted' then coalesce(accepted_at, now()) else accepted_at end,
             qr_payload      = coalesce(${qr}, qr_payload),
             last_error      = ${unmapped === null ? null : `unmapped remote status ${unmapped}`}
       where id = ${input.transmissionId}`;
    if (unmapped === null && result.status === "rejected") {
      await tx`
        update app.einvoice_transmission
           set last_error = ${JSON.stringify(result.raw).slice(0, 2000)}
         where id = ${input.transmissionId}`;
    }
    return getTransmission(tx, input.transmissionId);
  });
}

export async function pollTransmission(
  sql: Sql,
  ctx: TenantContext,
  input: { transmissionId: string },
): Promise<EinvoiceTransmissionRow> {
  const claimed = await claim(sql, ctx, input.transmissionId, "poll", POLLABLE_FROM);

  // The settings/credentials/registry resolution is inside the `try` for the reason
  // `submitTransmission` states at length: a refusal raised after the claim and outside it would
  // leave `claimed_at` standing and swallow pg-boss's retry (ADR 0053 §3).
  let transmitter: ReturnType<typeof transmitterFor>;
  let result: Awaited<ReturnType<typeof transmitter.poll>>;
  try {
    const settings = await withTenant(sql, ctx, (tx) => companySettings(tx, claimed.companyId));
    const credentials = credentialsFor(settings);
    transmitter = transmitterFor(settings.transmitter!);
    result = await transmitter.poll(claimed.externalId!, credentials);
  } catch (e) {
    const message = e instanceof TransientTransmissionError
      ? `transient: ${e.message} (http ${e.httpStatus})`
      : `poll failed: ${(e as Error).message}`;
    await recordFault(sql, ctx, input.transmissionId, message);
    throw e;
  }

  const unmapped = transmitter.lastCall?.unmapped ?? null;
  // The QR payload needs the canonical document, which needs a snapshot — read only when the poll
  // actually accepted, so a routine "still queued" poll costs one statement and no snapshot.
  let qr: string | null = null;
  if (result.status === "accepted") {
    const snapshot = await withTenant(sql, ctx, (tx) => loadSnapshot(tx, claimed.documentId));
    qr = transmitter.qrPayload(transmitter.canonicalise(snapshot), { externalId: claimed.externalId! });
  }

  return withTenant(sql, ctx, async (tx) => {
    await tx`
      update app.einvoice_transmission
         set status      = ${result.status},
             response    = ${tx.json(result.raw as Record<string, unknown>)},
             claimed_at  = null,
             polled_at   = now(),
             accepted_at = case when ${result.status} = 'accepted' then coalesce(accepted_at, now()) else accepted_at end,
             qr_payload  = coalesce(${qr}, qr_payload),
             last_error  = ${unmapped === null ? null : `unmapped remote status ${unmapped}`}
       where id = ${input.transmissionId}`;
    return getTransmission(tx, input.transmissionId);
  });
}

export async function cancelTransmission(
  sql: Sql,
  ctx: TenantContext,
  input: { transmissionId: string; reason: string },
): Promise<EinvoiceTransmissionRow> {
  const claimed = await claim(sql, ctx, input.transmissionId, "cancel", CANCELLABLE_FROM);

  // Inside the `try` for the same reason as the other two verbs: a claim that outlives its call is
  // an abandoned row (ADR 0053 §3). The `cancel` path has no pg-boss retry behind it, but an
  // operator who fixes the settings and presses cancel again must not be told "a call is in flight".
  let transmitter: ReturnType<typeof transmitterFor>;
  let result: Awaited<ReturnType<typeof transmitter.cancel>>;
  try {
    const settings = await withTenant(sql, ctx, (tx) => companySettings(tx, claimed.companyId));
    const credentials = credentialsFor(settings);
    transmitter = transmitterFor(settings.transmitter!);
    result = await transmitter.cancel(claimed.externalId!, input.reason, credentials);
  } catch (e) {
    const message = e instanceof TransientTransmissionError
      ? `transient: ${e.message} (http ${e.httpStatus})`
      : `cancel failed: ${(e as Error).message}`;
    await recordFault(sql, ctx, input.transmissionId, message);
    throw e;
  }

  const unmapped = transmitter.lastCall?.unmapped ?? null;
  return withTenant(sql, ctx, async (tx) => {
    await tx`
      update app.einvoice_transmission
         set status       = ${result.status},
             response     = ${tx.json(result.raw as Record<string, unknown>)},
             claimed_at   = null,
             polled_at    = now(),
             cancelled_at = case when ${result.status} = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end,
             last_error   = ${unmapped === null ? `cancelled: ${input.reason.slice(0, 500)}` : `unmapped remote status ${unmapped}`}
       where id = ${input.transmissionId}`;
    return getTransmission(tx, input.transmissionId);
  });
}
```

**Why the seventeen-column projection is written twice.** Hoisting it into a shared fragment constant would need `tx.unsafe` to splice it back in, and §3.3 pins `sql.unsafe` to exactly three homes — the migration runner, the pg-boss enqueue adapter and the Firebird reader, none of them in this slice (Global Constraint 5, hazard 21). The duplication is the cost of that rule and is deliberate: the two readers are `getTransmission` and `listTransmissions`, and both `update … returning` paths call `getTransmission`, so the list never appears a third time. A fourth `sql.unsafe` home would be a §3.3 amendment this slice has no business making.

- [ ] **Step 5: Write the barrel and export it**

`packages/db/src/einvoice/index.ts`:

```ts
export { EInvoiceError, type EInvoiceErrorCode } from "./errors";
export {
  EINVOICE_SECRET_NAMES, credentialsFor, readSecret,
  type CompanyEInvoiceSettings, type EInvoiceSecretName,
} from "./credentials";
export { REDACTED, redactResponse } from "./redact";
export {
  createHttpTransmitter, TransientTransmissionError,
  type HttpTransmitterOptions, type RegisteredTransmitter, type RemoteCallResult,
} from "./http-transmitter";
export {
  PROFILE_DIR, ProfileNotFoundError, availableProfileVersions, loadProfile, profilePath,
} from "./profile";
export {
  SYNTHETIC_PROFILE_CODE, createSyntheticTransmitter, sha256Hex,
  syntheticCanonicalise, syntheticQrPayload,
} from "./synthetic";
export {
  TRANSMITTER_CODES, registerDefaultTransmitters, registerTransmitter, registeredTransmitters,
  resetTransmitters, transmitterFor, type TransmitterCode,
} from "./registry";
export { formatVerifyResult, verifyProfile, type VerifyResult } from "./verify";
export {
  CANCELLABLE_FROM, CLAIM_WINDOW_SECONDS, POLLABLE_FROM, SUBMITTABLE_FROM,
  cancelTransmission, companySettings, getTransmission, listTransmissions, pollTransmission,
  recordPending, submitTransmission,
  type EinvoiceTransmissionRow, type ListTransmissionsInput,
} from "./transmission";
```

and in `packages/db/src/index.ts`, one line beside the existing re-exports:

```ts
export * from "./einvoice";
```

**`packages/db/src/index.ts` gains `./einvoice` and nothing else.** In particular it does not gain `./seed` at any depth — §3.1's `legacy-039` assertion still holds, and `einvoice/profile.ts` reads its own directory and imports no seed module.

- [ ] **Step 6: Run the test to green**

```bash
bun run --cwd packages/db test -- einvoice/transmission
bun run --cwd packages/db test -- einvoice
bun run typecheck && bun run lint && bun run lint:rules && bun run format:check
```

**Expected:** **sixteen** passing `it`s in this file and every earlier e-invoicing file still green. The sixteenth — "ENDS THE CLAIM when the refusal comes before the call" — is the one that fails if the settings/credentials/registry resolution is written outside the `try`. `lint:rules` must be green — the projection is written out inline in both readers and there is no `sql.unsafe` in this slice at all, which the `legacy-019` block of Task 10 re-asserts as a source fact.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/einvoice/transmission.ts packages/db/src/einvoice/index.ts \
        packages/db/src/index.ts packages/db/test/einvoice/transmission.test.ts \
        packages/contracts/src/errors.ts docs/adr/0053-transmission-state-retry-and-what-may-be-logged.md
git commit -m "$(cat <<'EOF'
feat(db): the e-invoice transmission log and its state machine [5B T5]

ADR 0053: claim, call, record — three short transactions with the HTTP call
between them, never inside one (spec:1368). A 4xx is an outcome and moves the row
to rejected; a 5xx throws TransientTransmissionError for pg-boss. An unmapped
remote label lands in `error` with the label in last_error, never in `accepted`
(LEGACY-020). The claim reuses §4.2.9's 120-second window and lives in claimed_at,
which every verb clears when its call ends, success or fault -- polled_at records
the last COMPLETED call and is a different question. Keeping them apart is what
lets the poll follow the submit, and what lets pg-boss's 60-second retry
re-claim instead of being swallowed as "already settled". Three ERRORS rows land
here with the code that raises them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `postDocument` step 14 — the three gates, the durable pending row, and the warning path

**The hook, and it is eleven lines inside a branch that already exists.** §4.3.2 step 14 already says "`accounting.tax.submit` when the policy's `tax.applies` and e-invoicing is enabled (5B+)"; contracts amendment 3 fixes what that means and amendment 4 adds the policy property the second gate reads.

**Files:**
- Modify: `packages/db/src/posting/post.ts` — the step-14 clause and one import
- Modify: `packages/domain/posting-policy.schema.json` — one optional property (amendment 4)
- Create: `packages/db/test/einvoice/step14.test.ts`

**Interfaces**

- Consumes: `postDocument`, `PostResult`, `resolvePolicy`, `loadSnapshot` (§4.3.1); `input.jobs?: JobClient` (3B amendment A5); `recordPending` (Task 5); `JobEnvelope`, `JobClient`, `EnqueueOptions` (§4.2.6); `PostingPolicy` (§4.4.2, regenerated with the new property); 4B's `arApFixture`-free path — this task's fixture is `packages/db`-local and uses `seedTenantV2`, `seedAccount`, `seedDocumentType`, `grantCodes`, `ensureOpenPeriods`, `enableEinvoice`, `optInDocumentType`.
- Produces: the step-14 e-invoicing clause; `PostResult.warnings`' new member `einvoice_enqueue_skipped: …`; `tax.einvoice` in the policy schema and therefore in the generated `PostingPolicy` type.

**No new export.** `postDocument`'s signature, its `PostResult` shape and its error set are all unchanged; `enqueuedJobIds` gains a member on the enabled path and `warnings` gains one on the jobless path, both of which §4.3.1 already declares as `string[]`.

- [ ] **Step 1: Widen the policy schema (amendment 4)**

In `packages/domain/posting-policy.schema.json`, the `tax` block becomes:

```json
    "tax": {
      "type": "object", "additionalProperties": false, "required": ["applies"],
      "properties": {
        "applies": { "type": "boolean" },
        "inclusive": { "anyOf": [{ "type": "boolean" }, { "const": "header.tax_inclusive" }] },
        "einvoice": {
          "description": "Transmit a posted document of this type to the company's fiscalisation authority (slice 5B). Which document classes an authority mandates is an ADR-0051 fact, so it lives on the versioned, append-only policy rather than in a TypeScript list. Default false: merging slice 5B transmits nothing anywhere.",
          "type": "boolean",
          "default": false
        }
      }
    },
```

**`"required"` stays `["applies"]` and `additionalProperties` stays `false`**, so every policy already in the repository — 1A's `JOURNAL`, the seven test-only types of 2A/2B, 2C's `CONSIGNMENT_RETURN`, and every seeded envelope of 3B, 3C, 3D, 4A, 4B and 5A — validates unchanged and **no policy version is bumped by this task**. Regenerate the type rather than hand-editing it:

```bash
bun run --cwd packages/domain policy:types      # ADR 0022's generator; commits packages/domain/src/posting/policy.d.ts
git diff --stat packages/domain/src/posting/
```

**Expected diff:** one added optional property. If the generator's script name differs, read `packages/domain/package.json` — 1A owns the script and this task must not add a second generator.

- [ ] **Step 2: Write the failing test first**

`packages/db/test/einvoice/step14.test.ts`. **Two traps to settle before writing a line of it, because both would look reasonable and both are wrong.**

**⚠️ Trap 1 — `tests/invariants/support/post-inventory.ts` CANNOT be imported here.** §4.17.1 names `apps/worker/test/**` and `apps/api/test/**` as the only workspaces outside `tests` that may import `tests/invariants/support/**`; `packages/db/test/**` is not one of them, and contracts amendment 10 says why (it would close a module cycle through `packages/db/test/index.ts`). So 3B's `recordingJobs` is **not** available and this file carries an eight-line file-local recording `JobClient` instead, written out below; 3B's `ensureOpenPeriods` is not needed at all, because every document this file posts is dated in 2026-01, the one period Plan 0A opens.

**⚠️ Trap 2 — a document-type code is a §4.14 register entry (hazard 32).** This task must **not** invent one such as `EINV_TEST`, and must not restate a policy body of its own. Two ways to satisfy step 14's three gates in a `packages/db` test without a new code, and the second is the one to take:

- ❌ register `EINV_TEST` in §4.14 as a test-only code. Eight test-only codes already exist and each was registered because the slice that needed it had no alternative; this slice has one.
- ✅ **re-seed 1A's `JOURNAL` at `policyVersion = 3` with `tax: { applies: true, einvoice: true }`**, inside a Testcontainers company, through `seedDocumentType`. `JOURNAL` is registered, `seedTenantV2` already configures it at v2, and §3.4.8's "a policy version is `on conflict … do update`" is what makes a third version an ordinary write. The policy body is `JOURNAL_POLICY_V1` (§4.17, 1A's exported const) spread with a `tax` block — so this test restates **no** policy at all.

The file therefore opens:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobClient, JobEnvelope, JobName, JobPayload } from "../../src/jobs/enqueue";
import { postDocument } from "../../src/posting";
import { getTransmission, listTransmissions } from "../../src/einvoice/transmission";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  JOURNAL_POLICY_V1, draftDocument, grantCodes, seedDocumentType, seedTenantV2, type Seed,
} from "../fixtures";
import { enableEinvoice } from "../support/einvoice-stub";

interface Recorded { name: JobName; envelope: JobEnvelope<unknown>; opts: unknown }

/** A recording JobClient, file-local. 3B ships `recordingJobs()` in `tests/invariants/support/`,
 *  which `packages/db/test/**` may not import (amendment 10); eight lines here beats a lint
 *  allowance that would point this package at the test tier. */
function recordingJobs(): JobClient & { readonly enqueued: readonly Recorded[] } {
  const enqueued: Recorded[] = [];
  return {
    enqueued,
    async enqueue<N extends JobName>(_tx, name: N, job: JobEnvelope<JobPayload[N]>, opts) {
      enqueued.push({ name, envelope: job as JobEnvelope<unknown>, opts });
      return `job-${enqueued.length}`;
    },
  } as JobClient & { readonly enqueued: readonly Recorded[] };
}

/** Configure JOURNAL at v3 with a tax block. No new document-type code (hazard 32). */
async function optInJournal(db: Db, s: Seed, einvoice: boolean): Promise<void> {
  await seedDocumentType(db, s, {
    code: "JOURNAL",
    module: "accounting",
    policy: { ...JOURNAL_POLICY_V1, tax: { applies: true, einvoice } },
    policyVersion: 3,
    effectiveFrom: "2026-01-01",
  });
}

describe("§4.3.2 step 14 — the three e-invoicing gates (contracts amendment 3)", () => {
  let db: Db;
  let s: Seed;
  let ctx: { tenantId: string; actorId: string; requestId: string };

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "einvoice-step14");
    ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    await grantCodes(db, s, { codes: ["accounting.journal.create", "accounting.journal.post"] });
  }, 180_000);

  afterAll(async () => { await db.stop(); });

  const postOne = async (jobs?: JobClient): Promise<{ documentId: string; warnings: string[]; enqueued: string[] }> => {
    const documentId = await draftDocument(db, s);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.document_line (tenant_id, document_id, line_no, kind, account_id, debit, credit)
               values (app.current_tenant(), ${documentId}, 1, 'account', ${s.cash}, 25.0000, 0)`;
      await tx`insert into app.document_line (tenant_id, document_id, line_no, kind, account_id, debit, credit)
               values (app.current_tenant(), ${documentId}, 2, 'account', ${s.sales}, 0, 25.0000)`;
    });
    const result = await prodWithTenant(db.rw, ctx, (tx) =>
      postDocument(tx, ctx, { documentId, ...(jobs ? { jobs } : {}) }));
    return { documentId, warnings: result.warnings, enqueued: result.enqueuedJobIds };
  };

  it("GATE 1 — tax.applies false: no transmission row, no enqueue, no warning", async () => {
    await optInJournal(db, s, false);
    await seedDocumentType(db, s, {
      code: "JOURNAL", module: "accounting",
      policy: { ...JOURNAL_POLICY_V1, tax: { applies: false } },
      policyVersion: 4, effectiveFrom: "2026-01-01",
    });
    await enableEinvoice(db, s);
    const jobs = recordingJobs();
    const { documentId, warnings } = await postOne(jobs);
    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 10 }));
    expect(rows.filter((r) => r.documentId === documentId)).toHaveLength(0);
    expect(jobs.enqueued.filter((j) => j.name === "accounting.tax.submit")).toHaveLength(0);
    expect(warnings.some((w) => w.startsWith("einvoice_"))).toBe(false);
  });

  it("GATE 2 — tax.applies true but tax.einvoice absent: still nothing (default false)", async () => {
    await seedDocumentType(db, s, {
      code: "JOURNAL", module: "accounting",
      policy: { ...JOURNAL_POLICY_V1, tax: { applies: true } },
      policyVersion: 5, effectiveFrom: "2026-01-01",
    });
    await enableEinvoice(db, s);
    const jobs = recordingJobs();
    const { documentId } = await postOne(jobs);
    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 10 }));
    expect(rows.filter((r) => r.documentId === documentId)).toHaveLength(0);
    expect(jobs.enqueued.filter((j) => j.name === "accounting.tax.submit")).toHaveLength(0);
  });

  it("GATE 3 — both policy gates on but the company has no transmitter: still nothing", async () => {
    await seedDocumentType(db, s, {
      code: "JOURNAL", module: "accounting",
      policy: { ...JOURNAL_POLICY_V1, tax: { applies: true, einvoice: true } },
      policyVersion: 6, effectiveFrom: "2026-01-01",
    });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`update app.company
                  set einvoice_transmitter = null, einvoice_client_id = null,
                      einvoice_credential_ref = null
                where id = ${s.company}`;
    });
    const jobs = recordingJobs();
    const { documentId } = await postOne(jobs);
    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 10 }));
    expect(rows.filter((r) => r.documentId === documentId)).toHaveLength(0);
    expect(jobs.enqueued.filter((j) => j.name === "accounting.tax.submit")).toHaveLength(0);
  });

  it("ALL THREE ON — one pending row and one enqueue with the fixed options", async () => {
    await enableEinvoice(db, s);
    const jobs = recordingJobs();
    const { documentId, enqueued } = await postOne(jobs);

    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 50 }));
    const mine = rows.filter((r) => r.documentId === documentId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.status).toBe("pending");
    expect(mine[0]!.transmitter).toBe("synthetic");
    expect(mine[0]!.attempts).toBe(0);

    const job = jobs.enqueued.find((j) => j.name === "accounting.tax.submit");
    expect(job).toBeDefined();
    expect(job!.envelope.tenantId).toBe(s.tenant);
    expect(job!.envelope.requestId).toBe(ctx.requestId);
    expect(job!.envelope.payload).toEqual({ transmissionId: mine[0]!.id, phase: "submit" });
    expect(job!.opts).toEqual({ singletonKey: mine[0]!.id, retryLimit: 8, retryDelaySeconds: 60 });
    expect(enqueued).toContain("job-1");
  });

  it("NO JOB CLIENT — the row is still written and the warning names it (amendment 3)", async () => {
    await enableEinvoice(db, s);
    const { documentId, warnings } = await postOne(undefined);
    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 50 }));
    const mine = rows.filter((r) => r.documentId === documentId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.status).toBe("pending");
    const warning = warnings.find((w) => w.startsWith("einvoice_enqueue_skipped"));
    expect(warning).toBeDefined();
    expect(warning).toContain(mine[0]!.id);
  });

  it("a rolled-back post leaves NO transmission row (the row is in the posting transaction)", async () => {
    await enableEinvoice(db, s);
    const documentId = await draftDocument(db, s);
    // One line only: §4.3.2 step 6's balance check refuses, so the whole transaction rolls back.
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.document_line (tenant_id, document_id, line_no, kind, account_id, debit, credit)
               values (app.current_tenant(), ${documentId}, 1, 'account', ${s.cash}, 25.0000, 0)`;
    });
    await expect(prodWithTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId })))
      .rejects.toThrow();
    const rows = await prodWithTenant(db.rw, ctx, (tx) =>
      listTransmissions(tx, { companyId: s.company, limit: 50 }));
    expect(rows.filter((r) => r.documentId === documentId)).toHaveLength(0);
  });

  it("posting the SAME document twice cannot create two rows (unique (tenant_id, document_id))", async () => {
    // §4.3.2 step 2 refuses a second post of a posted document, so this asserts the DDL rather than
    // the algorithm: recordPending is `on conflict (tenant_id, document_id) do update`, which is why
    // a reversal-and-repost path (2B) reuses the row instead of raising 23505 inside a post.
    await enableEinvoice(db, s);
    const { documentId } = await postOne(recordingJobs());
    const again = await prodWithTenant(db.rw, ctx, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        select id::text as id from app.einvoice_transmission where document_id = ${documentId}`;
      return rows.length;
    });
    expect(again).toBe(1);
  });
});
```

Run it:

```bash
bun run --cwd packages/db test -- einvoice/step14
```

**Expected failure:** the "ALL THREE ON" `it` fails with `expected [] to have length 1` — the gates are not wired yet, so no row is written.

- [ ] **Step 3: Write the step-14 clause**

In `packages/db/src/posting/post.ts`, add the import:

```ts
import { recordPending } from "../einvoice/transmission";
```

and, inside step 14's existing block, **after** the `inventory.cost.replay` and `accounting.projection.rebuild` clauses (so the ordering in the code matches §4.3.2's sentence order and a reader can diff it against the contract):

```ts
  // ── 14c. e-invoicing (5B; §4.3.2 step 14, contracts amendment 3) ───────────────────────────
  //
  // THREE gates in series, every one defaulting off:
  //   (1) policy.tax.applies      — the type is taxable at all;
  //   (2) policy.tax.einvoice     — the AUTHORITY mandates this document class (an ADR-0051 fact,
  //                                 so it lives on the versioned policy — amendment 4);
  //   (3) company.einvoice_transmitter is not null — this company is enrolled.
  // Merging slice 5B therefore transmits nothing anywhere until a policy version and a company
  // column both say so.
  //
  // The pending row is written INSIDE this transaction and the enqueue after it, so a rolled-back
  // post leaves no transmission (test: "a rolled-back post leaves NO transmission row"). With no
  // JobClient the row is still written and a warning is pushed — the DURABLE ROW is the state of
  // record (ADR 0053), and the manual submit route and the poll phase both drive it, so a missed
  // enqueue delays a transmission and loses nothing. This is deliberately NOT 3B's fail-closed
  // branch: a missed cost replay leaves a wrong number in the ledger for ever (LEGACY-005), while a
  // missed enqueue leaves a pending row anyone can see.
  if (policy.tax?.applies === true && policy.tax.einvoice === true) {
    const [companyEinvoice] = await tx<{ transmitter: string | null }[]>`
      select einvoice_transmitter as transmitter
        from app.company
       where id = ${snapshot.company.id}`;
    const transmitter = companyEinvoice?.transmitter ?? null;
    if (transmitter !== null) {
      const transmissionId = await recordPending(tx, {
        documentId: input.documentId,
        companyId: snapshot.company.id,
        transmitter,
      });
      if (input.jobs) {
        enqueuedJobIds.push(
          await input.jobs.enqueue(
            tx,
            "accounting.tax.submit",
            { tenantId: ctx.tenantId, requestId: ctx.requestId, payload: { transmissionId, phase: "submit" } },
            { singletonKey: transmissionId, retryLimit: 8, retryDelaySeconds: 60 },
          ),
        );
      } else {
        warnings.push(
          `einvoice_enqueue_skipped: no job client (transmission ${transmissionId} stays pending until submitted)`,
        );
      }
    }
  }
```

**`snapshot.company.id` and not `DocumentSnapshot.company.einvoiceTransmitter`**: §4.3.1's list of stubbed `DocumentSnapshot` fields is closed and `einvoiceTransmitter` is a *new* field, not a stubbed one, so widening the snapshot would be a §4.4.2 amendment for a value read once per post. One `select` on a row already in the transaction's snapshot is cheaper than an amendment.

**`policy.tax?.applies` and not `policy.tax.applies`**: `tax` is in §4.4.1's `required` list, so it is always present on a *validated* policy — the `?.` is there because `PostingPolicy` is generated and 1A's `JOURNAL` subset predates the widening; if the generated type has `tax` non-optional, drop the `?.` and change nothing else.

- [ ] **Step 4: Run the test to green**

```bash
bun run --cwd packages/db test -- einvoice/step14
bun run --cwd packages/db test -- posting
bun run --cwd packages/domain test -- posting
bun run typecheck && bun run lint && bun run lint:rules && bun run format:check
```

**Expected:** seven passing `it`s in this file, **and every existing posting test still green** — that is the assertion that matters here. The schema widening is additive and the step-14 clause is behind three gates that are all off in every earlier slice's fixture, so 1A's, 2A's, 3B's, 3C's, 3D's, 4A's and 4B's posting suites must pass with zero edits. If one fails, the cause is the regenerated `PostingPolicy` type and not the clause.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/posting/post.ts packages/domain/posting-policy.schema.json \
        packages/domain/src/posting/policy.d.ts packages/db/test/einvoice/step14.test.ts
git commit -m "$(cat <<'EOF'
feat(db): hook e-invoicing onto postDocument step 14 [5B T6]

Three gates in series, every one off by default: policy.tax.applies,
policy.tax.einvoice (contracts amendment 4 — the authority's document classes are
an ADR-0051 fact and belong on the versioned policy) and
company.einvoice_transmitter. The pending row is written inside the posting
transaction; with no JobClient it is still written and a warning names it
(amendment 3). No policy version anywhere is bumped: the property is optional.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `accounting.tax.submit` — the job handler, the poll phase, bounded retry and the `JOB_PROBES` entry

**One `JOBS` name carries both halves of spec:2225's "retry and status reconciliation"** (contracts amendment 2): the `submit` phase re-enqueues itself as `poll` while the remote status is `submitted`, and the poll phase re-enqueues itself with backoff until it resolves or a bounded number of polls have run.

**Files:**
- Create: `apps/worker/src/handlers/accounting-tax-submit.ts`
- Create: `apps/worker/src/jobs.ts`
- Create: `apps/worker/test/handlers/accounting-tax-submit.test.ts`
- Create: `tests/invariants/support/einvoice.ts` (§4.17.1(b), amendment 10)
- Modify: `packages/db/src/jobs/payloads.ts` — one key (amendment 2)
- Modify: `apps/worker/src/index.ts` — one `registerHandler`, one `setJobs`, one `registerDefaultTransmitters`
- Modify: `tests/invariants/probes.ts` — one `JOB_PROBES` entry

**Interfaces**

- Consumes: `JobHandler`, `registerHandler`, `runJob`, `JobEnvelope`, `JobClient`, `JobPayload`, `JOBS` (§4.2.6); `systemContext`, `TenantContext` (§4.2.2); `log`, `Logger` (0D, §4.2.3); `submitTransmission`, `pollTransmission`, `getTransmission` (Task 5); `TransientTransmissionError`, `registerDefaultTransmitters` (Task 4); `startWorker`, `StartedWorker` (0D, §4.17.1); `readConfig` — **no**: `apps/worker` has its own config reader; use whatever `apps/worker/src/index.ts` already calls, and read `APP_ENV` through it.
- Produces:

```ts
// packages/db/src/jobs/payloads.ts  (one key added; amendment 2)
  /** Slice 5B. `phase` lets one JOBS name carry both submission and status reconciliation. */
  "accounting.tax.submit": { transmissionId: string; phase: "submit" | "poll" };

// apps/worker/src/jobs.ts (5B)
export function jobs(): JobClient;                 // throws until setJobs has run
export function setJobs(client: JobClient): void;

// apps/worker/src/handlers/accounting-tax-submit.ts (5B)
export const POLL_LIMIT = 12;
export function pollDelaySeconds(attempts: number): number;      // 60 · 2^n, capped at 3600
export const accountingTaxSubmit: JobHandler<"accounting.tax.submit">;

// tests/invariants/support/einvoice.ts (§4.17.1(b), amendment 10)
export interface EinvoiceFixture { transmissionOf(documentId: string): Promise<EinvoiceTransmissionRow | null>; optedInTypeId: string; taxCodeId: string; regimeId: string; arAp: ArApFixture }
export async function einvoiceFixture(db: Db, s: Seed): Promise<EinvoiceFixture>;
```

- [ ] **Step 1: Add the payload key and the job accessor**

In `packages/db/src/jobs/payloads.ts`, **one key added and no other line touched** (§4.2.6's rule):

```ts
  /** Slice 5B. `phase` is what lets one JOBS name carry both submission and spec:2225's status
   *  reconciliation: the submit handler re-enqueues itself as "poll" while the remote status is
   *  `submitted`. `JOBS` is closed at sixteen names and is not edited. */
  "accounting.tax.submit": { transmissionId: string; phase: "submit" | "poll" };
```

`apps/worker/src/jobs.ts`:

```ts
// apps/worker/src/jobs.ts (5B)
//
// §4.2.6's `JobHandler<N>` is `(sql, job, ctx) => Promise<void>` and takes no JobClient, but the
// e-invoice handler must re-enqueue itself for the poll phase. This is 0D's `log()` / `setLogger()`
// accessor applied to the job client, and for the same reason: the entrypoint owns the pg-boss
// instance and a handler must not construct one.
//
// If 0D or a later slice already shipped an equivalent accessor, USE THAT and delete this file —
// two ways for a handler to reach the job client is hazard 9.

import type { JobClient } from "@dulja/db";

let client: JobClient | null = null;

export function setJobs(next: JobClient): void {
  client = next;
}

export function jobs(): JobClient {
  if (client === null) {
    throw new Error("apps/worker: setJobs() has not run — the entrypoint must call it before any handler");
  }
  return client;
}
```

- [ ] **Step 2: Write the shared fixture (§4.17.1(b))**

`tests/invariants/support/einvoice.ts`:

```ts
// tests/invariants/support/einvoice.ts  (§4.17.1(b), 5B, contracts amendment 10)
//
// Composes 4B's arApFixture with the two writes defined once in
// packages/db/test/support/einvoice-stub.ts, and opts 4A's OWN SALES_INVOICE envelope in at
// policyVersion + 1. No test in slice 5B restates a policy 4A owns.

import { readFileSync } from "node:fs";
import { listTransmissions, withTenant, type EinvoiceTransmissionRow } from "@dulja/db";
import { seedTaxCode, type Db, type Seed } from "@dulja/db/test";
import { enableEinvoice, optInDocumentType } from "@dulja/db/test/einvoice-stub";
// 4B amendment 9 names it `PACK_DIR` and NOT `PACK_ROOT`: an ABSOLUTE directory with a trailing
// separator. (4A's `PACK_ROOT`, in `packages/db/test/ar-ap/_support.ts`, is the RELATIVE "seed/my"
// that `readPackFile` takes as its first argument; the two are not interchangeable, and Task 0's
// gate greps for `export const PACK_DIR` so a mix-up is a MISSING line rather than an ENOENT.)
import { PACK_DIR, arApFixture, type ArApFixture, type DocumentTypeEnvelope } from "./ar-ap";

export const OPTED_IN_TYPE_CODE = "SALES_INVOICE";

export interface EinvoiceFixture {
  arAp: ArApFixture;
  optedInTypeId: string;
  taxCodeId: string;
  regimeId: string;
  /** The transmission for a document, or null when the three gates did not all hold. */
  transmissionOf(documentId: string): Promise<EinvoiceTransmissionRow | null>;
}

export async function einvoiceFixture(db: Db, s: Seed): Promise<EinvoiceFixture> {
  const arAp = await arApFixture(db, s);
  await enableEinvoice(db, s);

  const envelope = JSON.parse(
    readFileSync(`${PACK_DIR}document-types/${OPTED_IN_TYPE_CODE}.json`, "utf8"),
  ) as DocumentTypeEnvelope;

  const optedInTypeId = await optInDocumentType(db, s, {
    code: envelope.code,
    module: envelope.module,
    policy: envelope.policy as Record<string, unknown>,
    policyVersion: envelope.policyVersion + 1,
    effectiveFrom: envelope.effectiveFrom,
    einvoice: true,
  });

  const { taxCodeId, regimeId } = await seedTaxCode(db, s, {});

  // A NAMED FUNCTION, not a method on the returned literal, because Task 8 appends
  // `postOptedInDocument`, which calls it. Inside an object literal a bare `transmissionOf(...)` is
  // an unbound reference and throws at run time; `this.transmissionOf(...)` would work but breaks the
  // moment a caller destructures the fixture. One function, referenced by both.
  async function transmissionOf(documentId: string): Promise<EinvoiceTransmissionRow | null> {
    const rows = await withTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: "00000000-0000-7000-8000-000000000000" },
      (tx) => listTransmissions(tx, { companyId: s.company, limit: 200 }),
    );
    return rows.find((r) => r.documentId === documentId) ?? null;
  }

  return { arAp, optedInTypeId, taxCodeId, regimeId, transmissionOf };
}
```

**Two things this file deliberately does not do.** It does not read `tests/golden/tax/` — Task 10 does, once. And it does not register a transmitter: registration is process state (Task 4's `registry.ts`) and belongs to whichever entrypoint the consuming test starts, so `apps/worker/test` registers through `startWorker()`'s boot and `apps/api/test` through `startApi()`'s.

- [ ] **Step 3: Write the failing test first**

`apps/worker/test/handlers/accounting-tax-submit.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getTransmission, recordPending, registerTransmitter, resetTransmitters,
  createSyntheticTransmitter, withTenant as prodWithTenant,
} from "@dulja/db";
import { draftDocument, seedTenant, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { enableEinvoice, startStubServer, type StubServer } from "@dulja/db/test/einvoice-stub";
import { accountingTaxSubmit, POLL_LIMIT, pollDelaySeconds } from "../../src/handlers/accounting-tax-submit";
import { setJobs } from "../../src/jobs";

const ENV = { EINVOICE_CLIENT_SECRET: "s3cr3t" };

interface Recorded { name: string; payload: unknown; opts: unknown }

function recordingJobs(): { client: Parameters<typeof setJobs>[0]; enqueued: Recorded[] } {
  const enqueued: Recorded[] = [];
  const client = {
    async enqueue(_tx: unknown, name: string, job: { payload: unknown }, opts: unknown) {
      enqueued.push({ name, payload: job.payload, opts });
      return `job-${enqueued.length}`;
    },
  } as unknown as Parameters<typeof setJobs>[0];
  return { client, enqueued };
}

describe("accounting.tax.submit — the handler (contracts amendment 2)", () => {
  let db: Db;
  let s: Seed;
  let server: StubServer | null = null;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenant(db, "einvoice-job");
    await enableEinvoice(db, s);
  }, 180_000);

  afterEach(async () => { await server?.stop(); server = null; resetTransmitters(); });
  afterAll(async () => { await db.stop(); });

  const arm = async (script: Parameters<typeof startStubServer>[0]) => {
    server = await startStubServer(script);
    registerTransmitter("synthetic", createSyntheticTransmitter({
      profile: server.profile, env: ENV,
    }));
  };

  const pending = async (): Promise<string> => {
    const documentId = await draftDocument(db, s);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    return prodWithTenant(db.rw, ctx, (tx) =>
      recordPending(tx, { documentId, companyId: s.company, transmitter: "synthetic" }));
  };

  const run = async (transmissionId: string, phase: "submit" | "poll"): Promise<void> => {
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    await accountingTaxSubmit(
      db.rw,
      { tenantId: s.tenant, requestId: ctx.requestId, payload: { transmissionId, phase } },
      ctx,
    );
  };

  it("pollDelaySeconds is exponential from 60 and capped at one hour", () => {
    expect(pollDelaySeconds(0)).toBe(60);
    expect(pollDelaySeconds(1)).toBe(120);
    expect(pollDelaySeconds(5)).toBe(1920);
    expect(pollDelaySeconds(99)).toBe(3600);
  });

  it("submit that returns `submitted` re-enqueues the POLL phase with a distinct singleton key", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-30" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();

    await run(id, "submit");

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.name).toBe("accounting.tax.submit");
    expect(enqueued[0]!.payload).toEqual({ transmissionId: id, phase: "poll" });
    // A distinct singleton key: the submit job may still be active under `id`, and pg-boss would
    // drop a second insert under the same key.
    expect(enqueued[0]!.opts).toMatchObject({ singletonKey: `${id}:poll`, startAfterSeconds: 60 });
  });

  it("submit that returns `accepted` enqueues NOTHING — the transmission is finished", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-31" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    expect(enqueued).toHaveLength(0);
  });

  it("submit that returns `rejected` enqueues nothing and does NOT throw (a refusal is an outcome)", async () => {
    await arm({ submit: { status: 422, json: { state: "refused", receiptId: "R-32", reason: "stub refusal" } } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await expect(run(id, "submit")).resolves.toBeUndefined();
    expect(enqueued).toHaveLength(0);
  });

  it("a 5xx THROWS so pg-boss retries, and the row keeps its status", async () => {
    await arm({ submit: { status: 503, json: { state: "queued" } } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await expect(run(id, "submit")).rejects.toThrow(/503/);
    expect(enqueued).toHaveLength(0);
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
  });

  it("the pg-boss retry after a transient fault REACHES the authority — the claim ended with the call", async () => {
    // This is the assertion that `retryLimit: 8` (§4.9.3) is alive rather than decorative.
    // `retryDelaySeconds` is 60 and `CLAIM_WINDOW_SECONDS` is 120, so the first retry always arrives
    // INSIDE the claim window. If `recordFault` left `claimed_at` stamped, `claim()` would raise
    // ERR_EINVOICE_STATUS_ILLEGAL, the handler's catch would read it as "no longer actionable",
    // pg-boss would mark the job complete and the row would be abandoned at `pending` for ever.
    // The handler is re-run directly rather than through pg-boss: the thing under test is the claim.
    await arm({ submit: [{ status: 503, json: { state: "queued" } }, { state: "queued", receiptId: "R-38" }] });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();

    await expect(run(id, "submit")).rejects.toThrow(/503/);
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const faulted = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(faulted.status).toBe("pending");
    expect(faulted.attempts).toBe(1);
    expect(faulted.lastError).toContain("transient");
    expect(faulted.claimedAt, "recordFault must end the claim (ADR 0053)").toBeNull();
    expect(faulted.polledAt, "the call completed, unsuccessfully — polled_at records that").not.toBeNull();
    expect(enqueued).toHaveLength(0);

    // The retry, immediately — no 120-second wait, which is the whole point of the two columns.
    await run(id, "submit");
    const after = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(after.status).toBe("submitted");
    expect(after.externalId).toBe("R-38");
    expect(after.attempts).toBe(2);
    expect(after.claimedAt).toBeNull();
    expect(enqueued.map((e) => (e.payload as { phase: string }).phase)).toEqual(["poll"]);
  });

  it("poll that is still open re-enqueues with a longer delay each time", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-33" }, poll: { state: "queued" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    await run(id, "poll");
    await run(id, "poll");
    const delays = enqueued.filter((e) => (e.payload as { phase: string }).phase === "poll")
      .map((e) => (e.opts as { startAfterSeconds: number }).startAfterSeconds);
    expect(delays).toHaveLength(3);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
    expect(delays[2]!).toBeGreaterThan(delays[1]!);
  });

  it("poll STOPS re-enqueueing after POLL_LIMIT and records why, without throwing", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-34" }, poll: { state: "queued" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    // attempts is 1 after submit; each poll adds one, so POLL_LIMIT polls take attempts past it.
    for (let i = 0; i < POLL_LIMIT + 1; i += 1) await run(id, "poll");
    const polls = enqueued.filter((e) => (e.payload as { phase: string }).phase === "poll");
    expect(polls.length).toBeLessThan(POLL_LIMIT + 2);
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const row = await prodWithTenant(db.rw, ctx, (tx) => getTransmission(tx, id));
    expect(row.status).toBe("submitted");
    expect(row.lastError).toContain("poll limit");
  });

  it("poll that accepts enqueues nothing further", async () => {
    await arm({ submit: { state: "queued", receiptId: "R-35" }, poll: { state: "cleared" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    const before = enqueued.length;
    await run(id, "poll");
    expect(enqueued).toHaveLength(before);
  });

  it("a transmission that is no longer in a legal state for its phase is a no-op, not a failure", async () => {
    // pg-boss delivers at least once, so the same poll job can arrive twice after the transmission
    // has already been accepted. Throwing would burn the retry budget on a settled row.
    await arm({ submit: { state: "cleared", receiptId: "R-36" }, poll: { state: "cleared" } });
    const { client, enqueued } = recordingJobs();
    setJobs(client);
    const id = await pending();
    await run(id, "submit");
    await expect(run(id, "poll")).resolves.toBeUndefined();
    expect(enqueued).toHaveLength(0);
  });

  it("a transmission id from another tenant touches nothing (test 12's job half)", async () => {
    await arm({ submit: { state: "cleared", receiptId: "R-37" } });
    const { client } = recordingJobs();
    setJobs(client);
    const id = await pending();
    const other = await seedTenant(db, "einvoice-job-victim");
    const ctx = { tenantId: other.tenant, actorId: other.system, requestId: await uuidv7(db.admin) };
    await expect(
      accountingTaxSubmit(db.rw, { tenantId: other.tenant, requestId: ctx.requestId, payload: { transmissionId: id, phase: "submit" } }, ctx),
    ).resolves.toBeUndefined();
    const mine = await prodWithTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      (tx) => getTransmission(tx, id),
    );
    expect(mine.status).toBe("pending");
    expect(mine.attempts).toBe(0);
  });
});
```

Run it:

```bash
bun run --cwd apps/worker test -- accounting-tax-submit
```

**Expected failure:** `Cannot find module '../../src/handlers/accounting-tax-submit'`.

- [ ] **Step 4: Write the handler**

`apps/worker/src/handlers/accounting-tax-submit.ts`:

```ts
// apps/worker/src/handlers/accounting-tax-submit.ts (5B)
//
// spec:2356 lists "tax submission" among apps/worker's handlers. spec:2225 asks for "retry and
// status reconciliation"; contracts amendment 2 carries both on one JOBS name through `phase`.
//
// Transient (5xx, timeout, connection) -> THROW, so pg-boss retries with retryLimit 8 and its own
// exponential backoff. Everything else -> return, because a refusal is an outcome and retrying it
// eight times is how an integration gets rate-limited off an authority's platform (ADR 0053).

import {
  EInvoiceError, getTransmission, pollTransmission, submitTransmission, withTenant,
  type JobEnvelope, type TenantContext,
} from "@dulja/db";
import type { Sql } from "postgres";
import type { JobHandler } from "../handler";
import { jobs } from "../jobs";
import { log } from "../log";

/** How many polls one transmission gets before the job stops re-enqueueing itself. Twelve polls
 *  at 60·2^n capped at 3600 covers roughly a day, which is the horizon an operator watches; past
 *  it the row sits at `submitted` with `last_error` saying so, and the settings screen or the
 *  manual submit route is the next move. A larger number would be a queue that never drains. */
export const POLL_LIMIT = 12;

/** 60 · 2^attempts, capped at one hour. */
export function pollDelaySeconds(attempts: number): number {
  const raw = 60 * 2 ** Math.max(0, Math.min(attempts, 20));
  return Math.min(raw, 3600);
}

export const accountingTaxSubmit: JobHandler<"accounting.tax.submit"> = async (
  sql: Sql,
  job: JobEnvelope<{ transmissionId: string; phase: "submit" | "poll" }>,
  ctx: TenantContext,
): Promise<void> => {
  const { transmissionId, phase } = job.payload;
  const logger = log().child({ job: "accounting.tax.submit", transmissionId, phase });

  // pg-boss delivers at least once, and a transmission may have been settled by the manual route
  // between the enqueue and the delivery. A job for a row that is gone, invisible under RLS, or no
  // longer in a legal state for its phase is a NO-OP: throwing would burn the retry budget on a
  // settled row and would make a cross-tenant payload look like an outage (test 12's job half).
  let current;
  try {
    current = await withTenant(sql, ctx, (tx) => getTransmission(tx, transmissionId));
  } catch (e) {
    if (e instanceof EInvoiceError && e.code === "ERR_NOT_FOUND") {
      logger.info({}, "transmission not visible to this tenant — nothing to do");
      return;
    }
    throw e;
  }

  const enqueuePoll = async (attempts: number): Promise<void> => {
    if (attempts >= POLL_LIMIT) {
      await withTenant(sql, ctx, async (tx) => {
        await tx`
          update app.einvoice_transmission
             set last_error = ${`poll limit reached after ${attempts} attempts; the authority has not resolved this transmission`}
           where id = ${transmissionId}`;
      });
      logger.warn({ attempts }, "poll limit reached — the row stays submitted and stops polling");
      return;
    }
    // A DISTINCT singleton key: the submit job may still be active under `transmissionId`, and
    // pg-boss drops a second insert under a key that is already queued.
    await withTenant(sql, ctx, async (tx) => {
      await jobs().enqueue(
        tx,
        "accounting.tax.submit",
        { tenantId: ctx.tenantId, requestId: ctx.requestId, payload: { transmissionId, phase: "poll" } },
        { singletonKey: `${transmissionId}:poll`, startAfterSeconds: pollDelaySeconds(attempts), retryLimit: 8, retryDelaySeconds: 60 },
      );
    });
  };

  try {
    if (phase === "submit") {
      const row = await submitTransmission(sql, ctx, { transmissionId });
      logger.info({ status: row.status, externalId: row.externalId }, "submitted");
      if (row.status === "submitted") await enqueuePoll(row.attempts);
      return;
    }

    const row = await pollTransmission(sql, ctx, { transmissionId });
    logger.info({ status: row.status }, "polled");
    if (row.status === "submitted") await enqueuePoll(row.attempts);
  } catch (e) {
    if (e instanceof EInvoiceError && e.code === "ERR_EINVOICE_STATUS_ILLEGAL") {
      // Already settled, or a call is in flight under another claim. Both are no-ops.
      logger.info({ status: current.status, detail: e.detail }, "no longer actionable — nothing to do");
      return;
    }
    if (e instanceof EInvoiceError && e.code === "ERR_EINVOICE_NOT_ENABLED") {
      // An admin turned e-invoicing off between the post and the job. The pending row stays and the
      // operator can resubmit after re-enabling; retrying eight times would change nothing.
      logger.warn({}, "e-invoicing is no longer enabled for this company — leaving the row pending");
      return;
    }
    throw e;                        // TransientTransmissionError and ERR_EINVOICE_TRANSMITTER_UNAVAILABLE retry
  }
};
```

**`ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` is deliberately on the retrying side.** It means the profile is absent, the transmitter is unregistered or the secret is unset — all deploy-time conditions that a redeploy fixes, and eight bounded retries across a rolling restart is the right behaviour. It is also, before OD-15, the state every `myinvois` company is in; the row stays `pending`, `last_error` names the reason, and nothing is lost.

- [ ] **Step 5: Register the handler, the job client and the transmitters at boot**

In `apps/worker/src/index.ts`, three additions:

```ts
import { registerDefaultTransmitters } from "@dulja/db";
import { accountingTaxSubmit } from "./handlers/accounting-tax-submit";
import { setJobs } from "./jobs";

// … after the pg-boss instance and the job client exist:
setJobs(jobClient);
registerDefaultTransmitters(config.appEnv);
registerHandler("accounting.tax.submit", accountingTaxSubmit);
```

**`registerDefaultTransmitters(config.appEnv)` is what keeps `synthetic` out of production** (ADR 0052 decision 6). Read `appEnv` from whatever config reader `apps/worker/src/index.ts` already calls — 0D built it and no plan adds a second.

- [ ] **Step 6: Add the `JOB_PROBES` entry (hazard 31)**

In `tests/invariants/probes.ts`, beside the other entries:

```ts
  "accounting.tax.submit": {
    async seed(db, attacker, victim) {
      // The VICTIM owns a pending transmission; the attacker's tenant runs the job with the
      // victim's transmission id in the payload. RLS must make it invisible and the handler must
      // treat it as a no-op, leaving the victim's row untouched (§3.7.2).
      const documentId = await draftDocument(db, victim);
      await enableEinvoice(db, victim);
      await prodWithTenant(
        db.rw,
        { tenantId: victim.tenant, actorId: victim.human, requestId: "00000000-0000-7000-8000-000000000000" },
        (tx) => recordPending(tx, { documentId, companyId: victim.company, transmitter: "synthetic" }),
      );
      void attacker;
    },
    async survivors(db, victim) {
      const rows = await prodWithTenant(
        db.rw,
        { tenantId: victim.tenant, actorId: victim.human, requestId: "00000000-0000-7000-8000-000000000000" },
        (tx) => listTransmissions(tx, { companyId: victim.company, limit: 100 }),
      );
      return rows.filter((r) => r.status === "pending" && r.attempts === 0).length;
    },
  },
```

The harness enqueues the job for tenant A with tenant B's ids and asserts `survivors` is unchanged; the handler's `ERR_NOT_FOUND` no-op branch is what makes that true, and this task's last `it` asserts the same thing directly so the two cannot drift.

- [ ] **Step 7: Run the tests to green**

```bash
bun run --cwd apps/worker test -- accounting-tax-submit
bun run --cwd tests test -- tenant-isolation
bun run typecheck && bun run lint && bun run lint:rules && bun run format:check
```

**Expected:** eleven passing `it`s here; `tenant-isolation` passes with the new `JOB_PROBES` entry — and would have failed the build without it (§3.7.2 fails when a registered job name has no probe). **`lint:rules` is green at this commit** because Task 2 has not landed: `accounting.tax.file` is in neither `app.permission` nor `PERMISSIONS` yet — all four of Task 2's files land in Task 8's PR (Task 2 Step 5). **If `permission-catalogue` is red here, part of Task 2 was committed early**; move all of it to Task 8's PR rather than adding a reference to satisfy the rule.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/handlers/accounting-tax-submit.ts apps/worker/src/jobs.ts \
        apps/worker/src/index.ts apps/worker/test/handlers/accounting-tax-submit.test.ts \
        packages/db/src/jobs/payloads.ts tests/invariants/support/einvoice.ts tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(worker): the accounting.tax.submit handler and its poll phase [5B T7]

One JOBS name carries submission and spec:2225's status reconciliation through
`phase` (contracts amendment 2). Transient failures throw for pg-boss's
retryLimit 8; a refusal returns. The poll re-enqueues itself under a distinct
singleton key with 60·2^n backoff, bounded at POLL_LIMIT, then records why it
stopped. A job for an invisible or already-settled transmission is a no-op, which
is also what makes the JOB_PROBES isolation entry pass.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The API surface — the transmissions module, the company settings sub-paths, and `generated → filed`

**This is where `accounting.tax.file` earns its name, and it has two halves that 5A's written plan joined.** The card gives 5B the code; §3.6.2 assigns it; spec:2158 gives the `accountant` "tax returns". 5A's Task 8 is explicit about where the second half lives: *"`generated → filed` is **5B's** transition under `accounting.tax.file`, and this slice writes neither `filed_at` nor `attachment_id`."* So this task ships **both** references — the two unsafe routes on the new transmissions module, and one `POST …/tax-returns/{taxReturnId}/file` sub-path on **5A's existing `taxReturnRoutes`**. Without the second, `tax_return.status` would carry a `'filed'` label no code can reach and `filed_at` would be a column nothing writes; that is exactly the dead vocabulary the enumerations rule (spec:2045) forbids.

**The asymmetry between `submit` and `cancel` is deliberate and is the one design decision a reviewer should check first.**

- **`POST …/{transmissionId}/submit` enqueues; it does not call the authority.** It writes nothing but the job row and answers **202** with the current row. Three reasons: an outbound call to an authority inside a request holds a socket for the request's whole timeout budget; `submitTransmission` (Task 5) already brackets that call between two short transactions and expects to own them; and `singletonKey = transmissionId` gives the retry-safety §4.2.9's idempotency middleware cannot give a remote side effect. **A double-click therefore produces one job, not two calls** — and the same singleton key is what Task 6's step-14 enqueue uses, so a manual submit racing the automatic one collapses to one.
- **`POST …/{transmissionId}/cancel` calls `cancelTransmission` directly and answers 200.** It cannot go through the job, because contracts amendment 2 closes `phase` at `"submit" | "poll"` and widening it to `"cancel"` would put a *reason string* — a human's words — into a pg-boss payload that is retried eight times and logged. Cancellation is rare, operator-initiated, and its refusal (`ERR_EINVOICE_STATUS_ILLEGAL`, legal only from `accepted`) is something the operator must see in the response rather than discover in a runbook.

**The settings write does not refuse `myinvois`.** The CHECK admits both codes and this route admits both. A company may be configured for `myinvois` before Task 9 has run; its posts then write `pending` rows whose submit fails with `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` and whose `last_error` names the reason — which is exactly the OD-15 default (§2.12: "abstract interface only") made observable, and is what Task 7 Step 4's `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` branch already assumes exists. Refusing at the settings write would instead force an admin to discover the gap by reading source.

**Files:**
- Create: `packages/contracts/src/accounting/einvoice.ts`
- Create: `packages/db/src/einvoice/settings.ts`
- Create: `apps/api/src/routes/accounting/einvoice-transmissions.ts`
- Create: `apps/api/test/routes/accounting/einvoice-transmissions.test.ts`
- Create: `docs/runbooks/einvoice-transmission.md`
- Modify: `apps/api/src/index.ts` — one `registerDefaultTransmitters(config.appEnv)` at boot (Step 5's note)
- Modify: `apps/api/test/support/app.ts` — `resetTransmitters()` + `registerDefaultTransmitters("dev")` inside `startApi()`
- Modify: `apps/api/src/context.ts` and `apps/api/src/app.ts` — the ninth `AppEnv` variable `db` (amendment 13)
- Modify: `scripts/lint/rules/no-bare-db.ts` — one allow-list entry (amendment 13)
- Modify: `packages/db/src/einvoice/index.ts` — one `export * from "./settings";`
- Modify: `packages/db/src/tax/returns.ts` (**5A's file**) — `fileTaxReturn` appended; nothing existing edited
- Modify: `packages/contracts/src/accounting/tax.ts` (**5A's file**) — `FileTaxReturnBody` appended
- Modify: `apps/api/src/routes/accounting/tax-returns.ts` (**5A's module**) — one sub-path
- Modify: `apps/api/src/routes/index.ts` — one `buildRoutes` entry
- Modify: the file `buildRoutes` imports `companyRoutes` from (the File Structure records `apps/api/src/routes/admin/companies.ts`; Step 6 greps for the real path) — two settings sub-paths
- Modify: `tests/invariants/probes.ts` — one `PROBES` entry
- Create: `packages/db/migrations/0058_seed_permission_phase5b.sql` and `0058.down.sql` — **Task 2 Step 4's files, committed here** (Task 2 Step 5: the migration cannot land without the catalogue entry, or `permission-catalogue.test.ts`'s table→catalogue direction fails). **This is the PR's ONE migration, so §3.4.3 holds.**
- Modify: `packages/contracts/permissions.ts` and `packages/db/seed/roles.ts` — **Task 2 Steps 2 and 3's staged edits, committed here** (Task 2 Step 5)
- Modify: `packages/db/test/einvoice/permission.test.ts` — **Task 2's staged test file, committed here**

**Interfaces**

- Consumes: `listTransmissions`, `getTransmission`, `cancelTransmission`, `companySettings`, `EinvoiceTransmissionRow`, `CANCELLABLE_FROM`, `SUBMITTABLE_FROM` (Task 5); `EInvoiceError`, `EInvoiceErrorCode` (Task 4); `CompanyEInvoiceSettings`, `EINVOICE_SECRET_NAMES`, `TransmitterCode`, `TRANSMITTER_CODES` (Task 4); `TransmissionStatus`, `TRANSMISSION_STATUSES` (Task 3); `PERMISSION`, `requirePermission`, `ScopeSource` (§4.2.5); `RouteModule`, `buildRoutes`, `IdempotencyHeader`, `companyRoutes` (§4.2.7); `ListEnvelope`, `ListQuery`, `UuidSchema`, `TimestampSchema`, `ProblemSchema`, `encodeCursor`, `decodeCursor`, `Cursor` (§4.2.8); `PROBES`, `IsolationProbe` (§3.7.2); `startApi`, `ApiRequest`, `StartedApi`, `TEST_ISSUER` (§4.2.12); `c.var.withTenant`, `c.var.ctx`, `c.var.jobs` (§4.2.3 + 3B amendment A5), `c.var.logger`; **5A** — `createTaxReturn`, `generateTaxReturn`, `getTaxReturn`, **`taxReturnTieOut`**, `TaxReturnRow`, `taxReturnRoutes`, `taxReturnRouteModule`, `TAX_PERMISSION`, `TaxReturnDetail`, `TaxReturnSchema`, and the file-local `toTaxReturnDto` already in `apps/api/src/routes/accounting/tax-returns.ts` (the `/file` sub-path is appended to that file, so it is in scope and is not re-declared); `PostingError` (1A, re-raised by 5A's `returns.ts`); `einvoiceFixture`, `EinvoiceFixture` (Task 7, **extended by this task's Step 2**); `postFromPack`, `arApFixture`, `ArApFixture` (4B); `recordingJobs` (3B); `grantCodes`, `seedTenantV2`, `uuidv7` (2B, 1A, 0A — **`seedTenantV2(db, name)` takes a required name and `grantCodes(db, s, { codes })` takes an options object**, §4.17).
- Produces:

```ts
// packages/contracts/src/accounting/einvoice.ts (5B)
export const TransmissionStatusSchema: z.ZodEnum<["pending", "submitted", "accepted", "rejected", "cancelled", "error"]>;
export const TransmitterCodeSchema: z.ZodEnum<["synthetic", "myinvois"]>;
export const EinvoiceSecretNameSchema: z.ZodEnum<["EINVOICE_CLIENT_SECRET"]>;
export const EinvoiceTransmissionSchema: z.ZodObject<…>;
export type EinvoiceTransmissionDto = z.infer<typeof EinvoiceTransmissionSchema>;
export const EinvoiceTransmissionList: ReturnType<typeof ListEnvelope<typeof EinvoiceTransmissionSchema>>;
export const EinvoiceTransmissionQuery: z.ZodObject<…>;          // ListQuery + filter[status][eq], .strict()
export const CancelTransmissionBody: z.ZodObject<{ reason: z.ZodString }>;
export const EinvoiceSettingsSchema: z.ZodObject<{ transmitter; clientId; credentialRef }>;
export type EinvoiceSettingsDto = z.infer<typeof EinvoiceSettingsSchema>;
export const EinvoiceSettingsBody: z.ZodEffects<z.ZodObject<…>>;  // all three or none; credentialRef ∈ the enum
export const SubmitAcceptedSchema: z.ZodObject<{ transmission: typeof EinvoiceTransmissionSchema; jobId: z.ZodString }>;

// packages/db/src/einvoice/settings.ts (5B)
export interface WriteEinvoiceSettingsInput { companyId: string; transmitter: TransmitterCode | null; clientId: string | null; credentialRef: string | null }
export async function writeEinvoiceSettings(tx: Sql, input: WriteEinvoiceSettingsInput): Promise<CompanyEInvoiceSettings>;
// the READ half is Task 5's `companySettings(tx, companyId)` — this module does not restate it (hazard 9)

// packages/db/src/tax/returns.ts (5A's file, one function appended by 5B)
export interface FileTaxReturnInput { taxReturnId: string; filedAt?: string; attachmentId?: string }
/** `generated → filed`. Stamps `filed_at` (default `now()`) and optionally `attachment_id` — the filing
 *  acknowledgement, uploaded through 2C's attachment route. Raises
 *  `PostingError("ERR_DOC_STATUS_ILLEGAL")` from any status but `generated`. */
export async function fileTaxReturn(tx: Sql, ctx: TenantContext, input: FileTaxReturnInput): Promise<TaxReturnRow>;

// packages/contracts/src/accounting/tax.ts (5A's file, one schema appended by 5B)
export const FileTaxReturnBody: z.ZodObject<{ filedAt: z.ZodOptional<…>; attachmentId: z.ZodOptional<…> }>;

// apps/api/src/routes/accounting/einvoice-transmissions.ts (5B)
export const EINVOICE_PERMISSION: { readonly file: "accounting.tax.file" };
export const einvoiceTransmissionRoutes: OpenAPIHono<AppEnv>;
export const einvoiceTransmissionRouteModule: RouteModule;
export const einvoiceSettingsRoutes: OpenAPIHono<AppEnv>;   // MOUNTED ON companyRoutes — not a module
```

- [ ] **Step 1: Execute Task 2 in full here, then re-run its test**

**Task 2 produces no commit of its own** (Task 2 Step 5): each of its four files reds a different build check when landed alone, so all four land in *this* PR. If Task 2 has not been executed yet, execute it now — Steps 1–4 of that task, ending with the working tree holding `0058_seed_permission_phase5b.sql`, `0058.down.sql`, the `permissions.ts` entry, the `roles.ts` grant and `packages/db/test/einvoice/permission.test.ts`. Do it before anything else here, because every route below reads `PERMISSION["accounting.tax.file"]` and it does not exist yet. **0058 is the only migration in this PR, which is what §3.4.3 requires.**

Then the two catalogue edits, which are Task 2 Steps 2 and 3 verbatim. **No migration command is run by hand** — every test below stands up its own container through `startDb()` / `startApi()` and applies all migrations including 0058 itself:

`packages/contracts/permissions.ts` — one entry appended to `PERMISSIONS`, in `accounting`-module order:

```ts
  {
    code: "accounting.tax.file",
    module: "accounting",
    mutating: true,
    description: "File a generated tax return and submit or cancel e-invoice transmissions",
    phase: "5B",
  },
```

`packages/db/seed/roles.ts` — one code appended to `accountant.permissions` (contracts amendment 8; `admin.permissions` is computed from `PERMISSIONS` and is never edited):

```ts
      "accounting.tax.manage",
      "accounting.tax.file",          // 5B — spec:2158 gives the head-office bookkeeper "tax returns"
```

Run Task 2's test file, which is what proves the migration row and the catalogue agree:

```bash
bun run --cwd packages/db test -- einvoice/permission
bun run --cwd packages/db test -- permission-catalogue
```

**Expected:** both green. `permission-catalogue.test.ts` compares `app.permission`'s set to `PERMISSIONS`' set **in both directions**; at every earlier commit it was green because *neither* side had the code, and it is green again now because *both* do. **The two intermediate states are exactly the ones that are red, which is why neither of them is ever a commit** — migration without catalogue fails the table→catalogue direction, catalogue without migration fails the other.

- [ ] **Step 2: Write the failing route test first**

`apps/api/test/routes/accounting/einvoice-transmissions.test.ts`. **Seventeen** `it`s across four describes — five on the list route, four on submit, three on cancel and five on the settings-and-filing describe — plus the two source facts Step 9 appends, nineteen in all. The fixture is Task 7's `einvoiceFixture`, reached from `apps/api/test/**` — one of the two workspaces §4.17.1 permits (contracts amendment 10).

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant as prodWithTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startStubServer, type StubServer } from "@dulja/db/test/einvoice-stub";
import { einvoiceFixture, type EinvoiceFixture } from "../../../../../tests/invariants/support/einvoice";
import { startApi, type StartedApi } from "../../support/app";
import type { Problem } from "@dulja/contracts";

let api: StartedApi;
let s: Seed;
let f: EinvoiceFixture;
let stub: StubServer;
let transmissionId: string;
let documentId: string;

beforeAll(async () => {
  api = await startApi();
  // The synthetic transmitter's profile points at loopback. The stub's vocabulary is the synthetic
  // profile's own statusMap (`queued` -> submitted, `cleared` -> accepted, `withdrawn` -> cancelled),
  // NOT the six local labels: `StubReply.status` is an HTTP status code. Submit answers `queued` and
  // poll answers `cleared`, which is what `driveToAccepted` (submit then poll) needs, and it leaves
  // the cancel cases an `accepted` row to withdraw.
  stub = await startStubServer({ submit: { state: "queued", receiptId: "STUB-1" }, poll: { state: "cleared" }, cancel: { state: "withdrawn" } });
  f = await einvoiceFixture(api.db, (s = await seedTenantV2(api.db, "einvoice-api")));
  // §4.17 freezes `seedTenantV2(db, name)` — the name is REQUIRED — and
  // `grantCodes(db, s, opts?: { codes?; principalId?; roleCode?; branchIds? })` — an OPTIONS OBJECT,
  // never a bare array. Task 6 of this plan uses both correct forms.
  await grantCodes(api.db, s, { codes: ["accounting.tax.file", "admin.company.manage", "accounting.tax.manage"] });
  await api.loadPrincipals();
  ({ documentId, transmissionId } = await f.postOptedInDocument());
}, 240_000);

afterAll(async () => {
  await stub.stop();
  await api.stop();
});

describe("GET /v1/companies/{companyId}/einvoice-transmissions (5B T8)", () => {
  it("lists the company's transmissions newest first, in the ListEnvelope shape", async () => {
    const res = await api.request({ method: "GET", path: `/v1/companies/${s.company}/einvoice-transmissions`, as: s.human });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; documentId: string; status: string }[]; next_cursor: string | null };
    expect(body.items.map((i) => i.id)).toContain(transmissionId);
    expect(body.items[0]).toMatchObject({ documentId, status: "pending", transmitter: "synthetic" });
    expect(body.next_cursor).toBeNull();
  });

  it("filters by status with the literal filter key, and pages by cursor", async () => {
    const one = await api.request({ method: "GET", path: `/v1/companies/${s.company}/einvoice-transmissions?filter[status][eq]=pending&limit=1`, as: s.human });
    expect(one.status).toBe(200);
    const page = (await one.json()) as { items: unknown[]; next_cursor: string | null };
    expect(page.items).toHaveLength(1);
    // A second page is requested with the cursor the first returned; whether it is empty or not,
    // the round trip must not 400 — that is the whole of the codec assertion.
    if (page.next_cursor !== null) {
      const two = await api.request({ method: "GET", path: `/v1/companies/${s.company}/einvoice-transmissions?limit=1&cursor=${page.next_cursor}`, as: s.human });
      expect(two.status).toBe(200);
    }
  });

  it("refuses an undeclared query parameter with ERR_VALIDATION_FAILED (the .strict() case)", async () => {
    const res = await api.request({ method: "GET", path: `/v1/companies/${s.company}/einvoice-transmissions?transmitter=synthetic`, as: s.human });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("refuses a caller without accounting.tax.file with 403 ERR_RBAC_FORBIDDEN", async () => {
    const stranger = await seedTenantV2(api.db, "einvoice-stranger");   // same container, its own tenant, no grants
    await api.loadPrincipals();
    const res = await api.request({ method: "GET", path: `/v1/companies/${stranger.company}/einvoice-transmissions`, as: stranger.human });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("answers 404 for another tenant's transmission id rather than 403 (existence is not leaked)", async () => {
    const other = await seedTenantV2(api.db, "einvoice-other");
    const otherF = await einvoiceFixture(api.db, other);
    const { transmissionId: theirs } = await otherF.postOptedInDocument();
    const res = await api.request({ method: "GET", path: `/v1/companies/${s.company}/einvoice-transmissions/${theirs}`, as: s.human });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Problem).code).toBe("ERR_NOT_FOUND");
  });
});

describe("POST …/einvoice-transmissions/{id}/submit (5B T8)", () => {
  it("answers 202 with the row and a job id, and enqueues exactly one accounting.tax.submit", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${transmissionId}/submit`,
      as: s.human,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { transmission: { id: string; status: string }; jobId: string };
    expect(body.transmission.id).toBe(transmissionId);
    expect(body.transmission.status).toBe("pending");     // the JOB moves it; the route does not
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a submit from a settled status with 409 ERR_EINVOICE_STATUS_ILLEGAL", async () => {
    // Drive the row to `accepted` through the service, exactly as the job would.
    const { transmissionId: second } = await f.postOptedInDocument();
    await f.driveToAccepted(second);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${second}/submit`,
      as: s.human,
    });
    expect(res.status).toBe(409);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_EINVOICE_STATUS_ILLEGAL");
    expect(problem.detail).toContain("accepted");
    expect(problem.detail).toContain("pending, error, rejected");
  });

  it("requires an Idempotency-Key", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${transmissionId}/submit`,
      as: s.human,
      idempotencyKey: null,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("replays a repeated Idempotency-Key, returning the stored body byte for byte", async () => {
    // `uuidv7` is Plan 0A's helper and takes a `Sql` (§4.1: `uuidv7(sql: Sql): Promise<string>`);
    // it is never called with no argument.
    const key = await uuidv7(api.db.admin);
    const path = `/v1/companies/${s.company}/einvoice-transmissions/${transmissionId}/submit`;
    const first = await api.request({ method: "POST", path, as: s.human, idempotencyKey: key });
    const second = await api.request({ method: "POST", path, as: s.human, idempotencyKey: key });
    expect(second.status).toBe(first.status);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.text()).toBe(await first.text());
  });
});

describe("POST …/einvoice-transmissions/{id}/cancel (5B T8)", () => {
  it("cancels an accepted transmission and returns the cancelled row", async () => {
    const { transmissionId: third } = await f.postOptedInDocument();
    await f.driveToAccepted(third);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${third}/cancel`,
      as: s.human,
      body: { reason: "duplicate issue — operator withdrew" },
    });
    expect(res.status).toBe(200);
    const row = (await res.json()) as { status: string; cancelledAt: string | null };
    expect(row.status).toBe("cancelled");
    expect(row.cancelledAt).not.toBeNull();
  });

  it("refuses a cancel from `pending` with 409 ERR_EINVOICE_STATUS_ILLEGAL", async () => {
    const { transmissionId: fourth } = await f.postOptedInDocument();
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${fourth}/cancel`,
      as: s.human,
      body: { reason: "too early" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_EINVOICE_STATUS_ILLEGAL");
  });

  it("refuses an empty reason with ERR_VALIDATION_FAILED", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/einvoice-transmissions/${transmissionId}/cancel`,
      as: s.human,
      body: { reason: "" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });
});

describe("the company e-invoice settings and the filed transition (5B T8)", () => {
  it("reads and writes the three settings columns, and the secret VALUE never appears", async () => {
    const put = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/einvoice-settings`,
      as: s.human,
      body: { transmitter: "synthetic", clientId: "stub-client", credentialRef: "EINVOICE_CLIENT_SECRET" },
    });
    expect(put.status).toBe(200);
    const get = await api.request({ method: "GET", path: `/v1/companies/${s.company}/einvoice-settings`, as: s.human });
    expect(await get.json()).toEqual({ transmitter: "synthetic", clientId: "stub-client", credentialRef: "EINVOICE_CLIENT_SECRET" });
    // The column holds the NAME of the secret. No route in this slice returns a value, and this is
    // the assertion that says so: the response body has exactly three keys.
    expect(Object.keys((await (await api.request({ method: "GET", path: `/v1/companies/${s.company}/einvoice-settings`, as: s.human })).json()) as object).sort())
      .toEqual(["clientId", "credentialRef", "transmitter"]);
  });

  it("refuses a credentialRef that is not a declared secret name", async () => {
    const res = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/einvoice-settings`,
      as: s.human,
      body: { transmitter: "synthetic", clientId: "c", credentialRef: "DATABASE_URL" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("refuses a partial settings write (two of three) — the CHECK made explicit at the edge", async () => {
    const res = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/einvoice-settings`,
      as: s.human,
      body: { transmitter: "myinvois", clientId: "c", credentialRef: null },
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toContain("all three or none");
  });

  it("accepts `myinvois` before Task 9 has run — the refusal is at submit, not at configuration", async () => {
    const other = await seedTenantV2(api.db, "einvoice-myinvois");
    await grantCodes(api.db, other, { codes: ["admin.company.manage"] });
    await api.loadPrincipals();
    const res = await api.request({
      method: "PUT",
      path: `/v1/companies/${other.company}/einvoice-settings`,
      as: other.human,
      body: { transmitter: "myinvois", clientId: "c", credentialRef: "EINVOICE_CLIENT_SECRET" },
    });
    expect(res.status).toBe(200);
  });

  it("files a generated tax return under accounting.tax.file, and refuses a draft", async () => {
    const { taxReturnId, draftReturnId } = await f.twoTaxReturns();
    const ok = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/tax-returns/${taxReturnId}/file`,
      as: s.human,
      body: {},
    });
    expect(ok.status).toBe(200);
    // The response is 5A's `TaxReturnDetail`, whose entity key is `taxReturn` — NOT `row` — and
    // which also carries `boxes`, `payload`, `tieOut` and `currency` (5a's contracts file). A handler
    // that answered `{ row, … }` would fail 5A's own schema at the OpenAPI boundary.
    const filed = (await ok.json()) as {
      taxReturn: { status: string; filedAt: string | null };
      boxes: unknown[]; payload: string | null; tieOut: unknown[]; currency: string;
    };
    expect(filed.taxReturn.status).toBe("filed");
    expect(filed.taxReturn.filedAt).not.toBeNull();
    expect(Object.keys(filed).sort()).toEqual(["boxes", "currency", "payload", "taxReturn", "tieOut"]);

    const bad = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/tax-returns/${draftReturnId}/file`,
      as: s.human,
      body: {},
    });
    expect(bad.status).toBe(409);
    const problem = (await bad.json()) as Problem;
    expect(problem.code).toBe("ERR_DOC_STATUS_ILLEGAL");
    expect(problem.detail).toContain("draft");
  });
});
```

Run it:

```bash
bun run --cwd apps/api test -- routes/accounting/einvoice-transmissions
```

**Expected: FAIL** on the first import — `Cannot find module '../../../../../tests/invariants/support/einvoice'` is already satisfied (Task 7 wrote it), so the real first failure is `Cannot find module '@dulja/contracts/accounting/einvoice'`, and after Step 3 it becomes **404** on every path because `buildRoutes` mounts no such module yet. Both are the intended red.

**Three members of `EinvoiceFixture` this test uses that Task 7 did not declare.** Task 7's shape is `{ transmissionOf, optedInTypeId, taxCodeId, regimeId, arAp }`. This task adds three, and they are appended to `tests/invariants/support/einvoice.ts` in this commit:

```ts
// tests/invariants/support/einvoice.ts — three members appended by 5B Task 8
export interface EinvoiceFixture {
  transmissionOf(documentId: string): Promise<EinvoiceTransmissionRow | null>;
  optedInTypeId: string;
  taxCodeId: string;
  regimeId: string;
  arAp: ArApFixture;
  /** Posts one SALES_INVOICE of the opted-in type on the enabled company and returns both ids.
   *  Every route case needs a fresh row, because the state machine is one-way. */
  postOptedInDocument(): Promise<{ documentId: string; transmissionId: string }>;
  /** Drives a `pending` row to `accepted` through `submitTransmission` + `pollTransmission` — the
   *  same two calls the job makes, so a route test never reimplements the state machine. */
  driveToAccepted(transmissionId: string): Promise<void>;
  /** One `generated` and one `draft` tax return on the same company, for the filing cases. */
  twoTaxReturns(): Promise<{ taxReturnId: string; draftReturnId: string }>;
}
```

**The import block `tests/invariants/support/einvoice.ts` gains in this commit, in full.** Task 7 wrote that file with the imports `transmissionOf` needs and no more; the three members below need six further names, and every one of them is a register entry rather than an invention:

```ts
// tests/invariants/support/einvoice.ts — the lines this task ADDS to Task 7's import block
import {
  createTaxReturn, generateTaxReturn,          // 5A's returns.ts, through @dulja/db's barrel
  pollTransmission, submitTransmission,        // 5B Task 5 — the same two calls the job makes
} from "@dulja/db";
import { uuidv7 } from "@dulja/db/test";       // §4.1: uuidv7(sql: Sql): Promise<string>
import { recordingJobs } from "./post-inventory";                 // 3B, §4.17.1
// and `postFromPack` joins the EXISTING `./ar-ap` import line, beside PACK_DIR and arApFixture:
//   import { PACK_DIR, arApFixture, postFromPack, type ArApFixture, type DocumentTypeEnvelope } from "./ar-ap";
```

`withTenant` is already imported from `@dulja/db` by Task 7's `transmissionOf`, so the bodies below use that name and **not** a `prodWithTenant` alias — one file, one spelling.

```ts
// the three bodies, appended inside einvoiceFixture's returned object
  async postOptedInDocument() {
    // `postFromPack`'s options are 4B's (`code`, not `typeCode`) with 5A amendment A13a's
    // `computeTax`; its `lines` are 3C's `DraftLine`, which carries `accountId` (never an
    // `accountCode`) and gained `taxCodeId` in 5A's Task 3. `ArApFixture` exposes its parties as
    // `partyIds.customer` and its accounts as `accountIds`, keyed by ACCOUNT CODE (4B).
    const { documentId } = await postFromPack(db, s, {
      code: OPTED_IN_TYPE_CODE,
      effectiveDate: "2026-01-15",
      partyId: arAp.partyIds.customer,
      computeTax: true,
      lines: [{
        lineNo: 1,
        kind: "account",
        accountId: arAp.accountIds["4000"]!,
        amount: "1000.0000",
        taxCodeId,
      }],
      // 3B's recording client, so step 14's enqueue is observable and, more to the point, so the
      // post does NOT push `einvoice_enqueue_skipped` onto its warnings (amendment 3).
      jobs: recordingJobs(),
    });
    const row = await transmissionOf(documentId);
    if (row === null) {
      throw new Error(`einvoiceFixture: no transmission row for ${documentId} — the three gates did not all hold`);
    }
    return { documentId, transmissionId: row.id };
  },
  async driveToAccepted(transmissionId: string) {
    // §4.1: `uuidv7(sql: Sql): Promise<string>` — the frozen Plan 0A helper, awaited, never called
    // with no argument. These are the two calls the job makes, in the job's order, so a route test
    // never reimplements the state machine.
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    await submitTransmission(db.rw, ctx, { transmissionId });
    await pollTransmission(db.rw, ctx, { transmissionId });
  },
  async twoTaxReturns() {
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    return withTenant(db.rw, ctx, async (tx) => {
      const gen = await createTaxReturn(tx, ctx, { companyId: s.company, regimeId, periodStart: "2026-01-01", periodEnd: "2026-03-31" });
      await generateTaxReturn(tx, ctx, gen.id);
      const draft = await createTaxReturn(tx, ctx, { companyId: s.company, regimeId, periodStart: "2026-04-01", periodEnd: "2026-06-30" });
      return { taxReturnId: gen.id, draftReturnId: draft.id };
    });
  },
```

**`postFromPack` takes the `Seed`, not the `ArApFixture`** (4B's signature is `postFromPack(db, s, opts)`), which is why `s` is the second argument and `arAp` is read only for its ids. **Task 0's gate names `createTaxReturn`, `getTaxReturn`, `taxReturnTieOut`, `TaxReturnDetail`, `TAX_PERMISSION` and 4B's `computeTax`** for exactly this reason: a 5A or 4B rename is then a `MISSING (repo)` line before Task 1 starts, not a `bun run typecheck` failure eight tasks later.

- [ ] **Step 3: Write the DTOs**

`packages/contracts/src/accounting/einvoice.ts`:

```ts
// packages/contracts/src/accounting/einvoice.ts (5B)
//
// §4.2.8's naming: <Resource>Schema, <Resource>Query, <Resource>List, <Verb><Resource>Body.
// Money does not appear here: a transmission carries no amount of its own — the amounts are in the
// document it points at, and duplicating one would give LEGACY-019 a second place to disagree.

import { z } from "@hono/zod-openapi";
import { ListEnvelope, ListQuery, ProblemSchema, TimestampSchema, UuidSchema } from "../common";

export const TransmissionStatusSchema = z.enum([
  "pending", "submitted", "accepted", "rejected", "cancelled", "error",
]).openapi("TransmissionStatus");

/** The closed vocabulary of `company.einvoice_transmitter` (contracts amendment 5). */
export const TransmitterCodeSchema = z.enum(["synthetic", "myinvois"]).openapi("TransmitterCode");

/** The §3.11 name, and the ONLY value `company.einvoice_credential_ref` may hold. The literal is
 *  repeated here rather than imported because `packages/contracts` may not import `packages/db`
 *  (§3.1); Step 9's source-fact `it` asserts the two spellings agree, so they cannot drift. */
export const EinvoiceSecretNameSchema = z.enum(["EINVOICE_CLIENT_SECRET"]).openapi("EinvoiceSecretName");

export const EinvoiceTransmissionSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  documentId: UuidSchema,
  transmitter: z.string(),
  profileVersion: z.number().int().nullable(),
  externalId: z.string().nullable(),
  status: TransmissionStatusSchema,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  /** lower-case hex of the canonical payload's sha256 — the document hash of §4.9.3. */
  requestSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  qrPayload: z.string().nullable(),
  submittedAt: TimestampSchema.nullable(),
  acceptedAt: TimestampSchema.nullable(),
  cancelledAt: TimestampSchema.nullable(),
  polledAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
}).openapi("EinvoiceTransmission");
export type EinvoiceTransmissionDto = z.infer<typeof EinvoiceTransmissionSchema>;

export const EinvoiceTransmissionList = ListEnvelope(EinvoiceTransmissionSchema);

/** §4.2.8's Layer 2 default: literal `filter[…][…]` keys, `.strict()` so an undeclared parameter is
 *  `ERR_VALIDATION_FAILED` rather than a silently ignored word. `status` is the one filterable field;
 *  `documentId` is not, because the transmission of a document is reached through the document. */
export const EinvoiceTransmissionQuery = ListQuery.extend({
  "filter[status][eq]": TransmissionStatusSchema.optional(),
}).strict().openapi("EinvoiceTransmissionQuery");

export const CancelTransmissionBody = z.object({
  reason: z.string().min(1).max(500),
}).strict().openapi("CancelTransmissionBody");

/** 202: the row as it stands plus the job the route enqueued. The status is still `pending` —
 *  saying so in the schema stops a client from treating 202 as "submitted". */
export const SubmitAcceptedSchema = z.object({
  transmission: EinvoiceTransmissionSchema,
  jobId: z.string(),
}).openapi("SubmitAccepted");

export const EinvoiceSettingsSchema = z.object({
  transmitter: TransmitterCodeSchema.nullable(),
  clientId: z.string().nullable(),
  /** The NAME of the secret. This API never returns, accepts or logs the value (§4.9.3). */
  credentialRef: EinvoiceSecretNameSchema.nullable(),
}).openapi("EinvoiceSettings");
export type EinvoiceSettingsDto = z.infer<typeof EinvoiceSettingsSchema>;

/** The `all three or none` CHECK of migration 0057, restated at the edge so the refusal is a 400 with
 *  a sentence rather than a 500 from a constraint violation. The database check remains the control. */
export const EinvoiceSettingsBody = EinvoiceSettingsSchema.strict().superRefine((v, ctx) => {
  const set = [v.transmitter, v.clientId, v.credentialRef].filter((x) => x !== null).length;
  if (set !== 0 && set !== 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "einvoice settings are all three or none: transmitter, clientId and credentialRef must be set together, or all null to turn e-invoicing off",
    });
  }
}).openapi("EinvoiceSettingsBody");

export { ProblemSchema };
```

Add the barrel line to `packages/contracts/src/index.ts` beside the other `accounting/` exports:

```ts
export * from "./accounting/einvoice";
```

- [ ] **Step 4: Write the settings writer**

`packages/db/src/einvoice/settings.ts`:

```ts
// packages/db/src/einvoice/settings.ts (5B)
//
// The WRITE half only. The read is Task 5's `companySettings(tx, companyId)` and this module does not
// restate it — two ways to read one row is hazard 9.
//
// Nothing here validates the all-three-or-none rule: the CHECK in migration 0057 is the control and
// `EinvoiceSettingsBody` (packages/contracts) is what turns the refusal into a 400 before it reaches
// the database. A service that re-checked would be a third spelling of one rule.

import type { Sql } from "postgres";
import { EInvoiceError } from "./errors";
import type { CompanyEInvoiceSettings } from "./credentials";
import type { TransmitterCode } from "./registry";

export interface WriteEinvoiceSettingsInput {
  companyId: string;
  transmitter: TransmitterCode | null;
  clientId: string | null;
  credentialRef: string | null;
}

/** One UPDATE, inside the caller's `withTenant` transaction. `app_meta.attach_stamp` on `app.company`
 *  fills `updated_by` and the audit trigger writes the before/after row — which is what makes test 13
 *  cover these three columns without this function doing anything about it. */
export async function writeEinvoiceSettings(
  tx: Sql,
  input: WriteEinvoiceSettingsInput,
): Promise<CompanyEInvoiceSettings> {
  const rows = await tx<
    { einvoice_transmitter: string | null; einvoice_client_id: string | null; einvoice_credential_ref: string | null }[]
  >`
    update app.company
       set einvoice_transmitter   = ${input.transmitter},
           einvoice_client_id     = ${input.clientId},
           einvoice_credential_ref = ${input.credentialRef}
     where id = ${input.companyId}
    returning einvoice_transmitter, einvoice_client_id, einvoice_credential_ref
  `;
  if (rows.length === 0) {
    // RLS reduced the row set to zero: either the company is another tenant's or it does not exist.
    // Both answer 404 at the edge — a 403 would confirm the id names something (§3.7.2).
    throw new EInvoiceError("ERR_NOT_FOUND", `company ${input.companyId} is not visible in this tenant`);
  }
  const r = rows[0]!;
  return { transmitter: r.einvoice_transmitter, clientId: r.einvoice_client_id, credentialRef: r.einvoice_credential_ref };
}
```

`packages/db/src/einvoice/index.ts` — one line appended to Task 5's barrel:

```ts
export * from "./settings";
```

- [ ] **Step 5: Write the route module**

`apps/api/src/routes/accounting/einvoice-transmissions.ts`:

```ts
// apps/api/src/routes/accounting/einvoice-transmissions.ts (5B)
//
// One module, four routes, one PROBES key. The two unsafe routes are the reason
// `accounting.tax.file` exists in `apps/api` at all — the permission-catalogue lint (§3.6.3) scans
// this workspace and `packages/db` may not import @dulja/contracts (§3.1).
//
// `EInvoiceError` (packages/db) is translated to an `AppError` here, once, by `rethrowAsAppError` —
// 3C's `LandedCostError` pattern (`apps/api/src/problem.ts` gains no branch).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  cancelTransmission,
  companySettings,
  getTransmission,
  listTransmissions,
  writeEinvoiceSettings,
  EInvoiceError,
  SUBMITTABLE_FROM,
  type EinvoiceTransmissionRow,
} from "@dulja/db";
import {
  AppError,
  CancelTransmissionBody,
  decodeCursor,
  encodeCursor,
  EinvoiceSettingsBody,
  EinvoiceSettingsSchema,
  EinvoiceTransmissionList,
  EinvoiceTransmissionQuery,
  EinvoiceTransmissionSchema,
  PERMISSION,
  ProblemSchema,
  SubmitAcceptedSchema,
  UuidSchema,
} from "@dulja/contracts";
import type { AppEnv } from "../../context";
import type { RouteModule } from "../index";
import { IdempotencyHeader } from "../index";
import { requirePermission } from "../../middleware/require-permission";

/** The bracket form — a dotted code cannot be reached by dot access (5A T4's note). */
export const EINVOICE_PERMISSION = { file: PERMISSION["accounting.tax.file"] } as const;

const scope = { company: "path:companyId" } as const;
const settingsScope = { company: "path:companyId" } as const;

const PathParams = z.object({ companyId: UuidSchema, transmissionId: UuidSchema });
const CompanyParams = z.object({ companyId: UuidSchema });

/** The one translation point. `EInvoiceError.code` is a literal subset of `ErrCode`, so the mapping
 *  is total and the status comes from the registry rather than from a table repeated here. */
function rethrowAsAppError(e: unknown): never {
  if (e instanceof EInvoiceError) throw new AppError(e.code, e.detail);
  throw e;
}

/** The wire shape: the row with `requestSha256` rendered as lower-case hex (Task 5 already returns it
 *  that way) and every timestamp as RFC 3339. `response` is DELIBERATELY not on the wire — ADR 0053
 *  fixes what may be stored there and nothing in v1 puts a remote body in front of a browser. */
function toDto(row: EinvoiceTransmissionRow) {
  return {
    id: row.id, companyId: row.companyId, documentId: row.documentId, transmitter: row.transmitter,
    profileVersion: row.profileVersion, externalId: row.externalId, status: row.status,
    attempts: row.attempts, lastError: row.lastError, requestSha256: row.requestSha256,
    qrPayload: row.qrPayload, submittedAt: row.submittedAt, acceptedAt: row.acceptedAt,
    cancelledAt: row.cancelledAt, polledAt: row.polledAt, createdAt: row.createdAt,
  };
}

export const einvoiceTransmissionRoutes = new OpenAPIHono<AppEnv>();

einvoiceTransmissionRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["accounting"],
    summary: "List e-invoice transmissions for a company",
    request: { params: CompanyParams, query: EinvoiceTransmissionQuery },
    middleware: [requirePermission(EINVOICE_PERMISSION.file, scope)],
    responses: {
      200: { description: "A page of transmissions", content: { "application/json": { schema: EinvoiceTransmissionList } } },
      400: { description: "Invalid query", content: { "application/problem+json": { schema: ProblemSchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const afterId = q.cursor === undefined ? null : decodeCursor(q.cursor).id;
    const rows = await c.var.withTenant((tx) =>
      listTransmissions(tx, { companyId, status: q["filter[status][eq]"], afterId, limit: q.limit + 1 }),
    );
    const page = rows.slice(0, q.limit);
    const next = rows.length > q.limit && page.length > 0 ? encodeCursor({ k: [], id: page[page.length - 1]!.id }) : null;
    return c.json({ items: page.map(toDto), next_cursor: next }, 200);
  },
);

einvoiceTransmissionRoutes.openapi(
  createRoute({
    method: "get", path: "/{transmissionId}", tags: ["accounting"],
    summary: "Read one e-invoice transmission",
    request: { params: PathParams },
    middleware: [requirePermission(EINVOICE_PERMISSION.file, scope)],
    responses: {
      200: { description: "The transmission", content: { "application/json": { schema: EinvoiceTransmissionSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { transmissionId } = c.req.valid("param");
    const row = await c.var.withTenant((tx) => getTransmission(tx, transmissionId)).catch(rethrowAsAppError);
    return c.json(toDto(row), 200);
  },
);

einvoiceTransmissionRoutes.openapi(
  createRoute({
    method: "post", path: "/{transmissionId}/submit", tags: ["accounting"],
    summary: "Queue a submission (or resubmission) of this transmission",
    description:
      "Enqueues accounting.tax.submit under singletonKey = transmissionId. The route never calls the authority: the job owns the two short transactions the remote call is bracketed by.",
    request: { params: PathParams, headers: IdempotencyHeader },
    middleware: [requirePermission(EINVOICE_PERMISSION.file, scope)],
    responses: {
      202: { description: "Queued", content: { "application/json": { schema: SubmitAcceptedSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
      409: { description: "Not submittable from this status", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { transmissionId } = c.req.valid("param");
    const { row, jobId } = await c.var
      .withTenant(async (tx) => {
        const current = await getTransmission(tx, transmissionId);
        // The same guard the service applies, applied here so the operator sees 409 rather than a
        // job that fails silently in the worker. `submitTransmission` re-checks under its own claim.
        if (!SUBMITTABLE_FROM.includes(current.status)) {
          throw new EInvoiceError(
            "ERR_EINVOICE_STATUS_ILLEGAL",
            `transmission ${transmissionId} is ${current.status}; submit is legal only from ${SUBMITTABLE_FROM.join(", ")}`,
          );
        }
        const id = await c.var.jobs.enqueue(
          tx,
          "accounting.tax.submit",
          { tenantId: c.var.ctx.tenantId, requestId: c.var.ctx.requestId, payload: { transmissionId, phase: "submit" } },
          { singletonKey: transmissionId, retryLimit: 8, retryDelaySeconds: 60 },
        );
        return { row: current, jobId: id };
      })
      .catch(rethrowAsAppError);
    c.var.logger.info({ transmissionId, jobId }, "e-invoice submission queued");
    return c.json({ transmission: toDto(row), jobId }, 202);
  },
);

einvoiceTransmissionRoutes.openapi(
  createRoute({
    method: "post", path: "/{transmissionId}/cancel", tags: ["accounting"],
    summary: "Cancel an accepted transmission with the authority",
    description:
      "Calls the transmitter directly rather than through a job: the reason is an operator's words, the call is rare, and its refusal must reach the operator in the response.",
    request: {
      params: PathParams, headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CancelTransmissionBody } } },
    },
    middleware: [requirePermission(EINVOICE_PERMISSION.file, scope)],
    responses: {
      200: { description: "Cancelled", content: { "application/json": { schema: EinvoiceTransmissionSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
      409: { description: "Not cancellable from this status", content: { "application/problem+json": { schema: ProblemSchema } } },
      422: { description: "E-invoicing not enabled, or the transmitter is unavailable", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { transmissionId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    // `cancelTransmission` takes the POOL, not a `tx`: it opens two short transactions around the
    // remote call (Task 5, ADR 0053). `c.var.withTenant` would hold one open across the network.
    const row = await cancelTransmission(c.var.db, c.var.ctx, { transmissionId, reason }).catch(rethrowAsAppError);
    return c.json(toDto(row), 200);
  },
);

export const einvoiceTransmissionRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/einvoice-transmissions",
  router: einvoiceTransmissionRoutes,
  permissions: [EINVOICE_PERMISSION.file],
  auth: "human",
};

/** MOUNTED ON 0B's `companyRoutes`, not registered as a module — see Step 6. */
export const einvoiceSettingsRoutes = new OpenAPIHono<AppEnv>();

einvoiceSettingsRoutes.openapi(
  createRoute({
    method: "get", path: "/{companyId}/einvoice-settings", tags: ["admin"],
    summary: "Read a company's e-invoicing configuration",
    request: { params: CompanyParams },
    middleware: [requirePermission(PERMISSION["admin.company.manage"], settingsScope)],
    responses: {
      200: { description: "The three settings", content: { "application/json": { schema: EinvoiceSettingsSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const s = await c.var.withTenant((tx) => companySettings(tx, companyId)).catch(rethrowAsAppError);
    return c.json(s, 200);
  },
);

einvoiceSettingsRoutes.openapi(
  createRoute({
    method: "put", path: "/{companyId}/einvoice-settings", tags: ["admin"],
    summary: "Set or clear a company's e-invoicing configuration",
    request: {
      params: CompanyParams, headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: EinvoiceSettingsBody } } },
    },
    middleware: [requirePermission(PERMISSION["admin.company.manage"], settingsScope)],
    responses: {
      200: { description: "The stored settings", content: { "application/json": { schema: EinvoiceSettingsSchema } } },
      400: { description: "Invalid body", content: { "application/problem+json": { schema: ProblemSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const s = await c.var
      .withTenant((tx) => writeEinvoiceSettings(tx, { companyId, ...body }))
      .catch(rethrowAsAppError);
    // `credentialRef` is a NAME; `clientId` is not a secret. Neither field name matches
    // FORBIDDEN_LOG_FIELD, which is why amendment 6 chose them (Global Constraint 16).
    c.var.logger.info({ companyId, transmitter: s.transmitter, credentialRef: s.credentialRef }, "e-invoice settings written");
    return c.json(s, 200);
  },
);
```

**`apps/api` must register the transmitters at boot, and Task 7 registered them only in `apps/worker`.** The `cancel` route calls `cancelTransmission` **in process**, which resolves `transmitterFor(company.einvoice_transmitter)` against the registry — and an unregistered registry answers `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` for *every* company, `synthetic` included. Two edits, exactly parallel to Task 7 Step 5's:

```ts
// apps/api/src/index.ts (or wherever `readConfig()` is called before `createApp`) — one import, one call
import { registerDefaultTransmitters } from "@dulja/db";

const config = readConfig();
registerDefaultTransmitters(config.appEnv);       // 5B — `synthetic` only when appEnv !== "production"
```

```ts
// apps/api/test/support/app.ts — inside startApi(), BEFORE createApp(deps)
import { registerDefaultTransmitters, resetTransmitters } from "@dulja/db";

  resetTransmitters();                            // the registry is process state; a prior suite may have seeded it
  registerDefaultTransmitters("dev");             // registers `synthetic`; `myinvois` only after Task 9's profile exists
```

**`resetTransmitters()` before the register, and not after**, because `startApi()` may be called by several suites in one Vitest worker and the registry is module-level state that outlives a container.

**`c.var.db` is used by exactly one handler and it must exist.** `cancelTransmission` takes the pool because it opens two transactions around a network call. `AppEnv["Variables"]` (§4.2.3, eight members after 3B's A5) does **not** declare `db`. **Add it as the ninth**, in the same two-line middleware `createApp` already uses for `jobs` (3B's shape, `apps/api/src/app.ts`):

```ts
  app.use("*", async (c, next) => { c.set("db", deps.db); await next(); });
```

and in `apps/api/src/context.ts`:

```ts
    /** 5B — the pool, for the one service that brackets a network call between two short
     *  transactions and therefore cannot take a `tx` (ADR 0053). Every other handler uses
     *  `c.var.withTenant`; the `no-bare-db` lint's allow-list gains this file and nothing else. */
    db: Sql;
```

**This is a contracts change and it lands as amendment 13** (Step 8 writes it). If a reviewer prefers not to widen `Variables`, the alternative is a factory module — `createEinvoiceTransmissionRoutes(db)` in `buildRoutes`, 2C's `createAttachmentRoutes` shape — which needs `buildRoutes`' deps to gain `db`. **Take the `Variables` member: `buildRoutes` deps is the narrower, more-copied interface and 2C has already widened it once.**

- [ ] **Step 6: Mount the settings sub-paths on `companyRoutes`**

First find the file, because the File Structure's guess is not authoritative:

```bash
grep -rn "companyRoutes" apps/api/src/routes/index.ts
```

Whatever path that import names is the file to edit. Append, after its existing routes:

```ts
import { einvoiceSettingsRoutes } from "../accounting/einvoice-transmissions";   // path relative to companyRoutes' own file

companyRoutes.route("/", einvoiceSettingsRoutes);
```

**Why the settings live here and not on the transmissions module.** They are company *configuration*, gated `admin.company.manage`, which §3.6.2 already assigns to company configuration; putting them behind `accounting.tax.file` would let the bookkeeper who files returns also point the company at a different authority. And mounting them as a second module on `/v1/companies` would collide with 0B's `PROBES` key — hazard 31 forbids two modules on one path. As sub-paths of `companyRoutes` they inherit its key and need no probe of their own.

**`companyRoutes`' `permissions` array gains one member** in the same edit, because the catalogue check reads it and `assertRouteGates` walks the mounted app:

```ts
export const companyRouteModule: RouteModule = {
  path: "/v1/companies",
  router: companyRoutes,
  permissions: [PERMISSION["admin.company.manage"]],     // unchanged — both new routes use it
  auth: "human",
};
```

— unchanged, in fact, and that is worth confirming rather than assuming: both settings routes are gated by the code 0B's module already declares, so **no edit to this array is needed**. If `assertRouteGates` throws `ERR_ROUTE_GATE_READONLY` at boot, the cause is `admin.company.manage` being `mutating: false` in the catalogue, which it is not (§3.6.2) — read the error before changing anything.

- [ ] **Step 7: Write `fileTaxReturn` and the `/file` sub-path**

Appended to **5A's** `packages/db/src/tax/returns.ts`. Nothing existing in that file is edited:

```ts
// ── 5B: the `generated → filed` transition (5A's plan hands it here under accounting.tax.file) ───

export interface FileTaxReturnInput {
  taxReturnId: string;
  /** RFC 3339. Defaults to `now()`; supplied when the operator files late and records the real date. */
  filedAt?: string;
  /** The filing acknowledgement, already uploaded through 2C's attachment route. The composite FK
   *  `(tenant_id, attachment_id) → app.attachment` is what proves it exists and belongs to the tenant;
   *  a bad id surfaces as `ERR_CONFLICT_REFERENCE` through `fromDatabaseError`. */
  attachmentId?: string;
}

/** Moves a `generated` return to `filed`. Refuses every other status with the code 5A's own
 *  `generateTaxReturn` uses for the mirror-image refusal, so the two transitions of one row speak
 *  one language. Writes no payload and recomputes nothing: filing is an act of record, not a
 *  regeneration, and a return whose bytes changed at filing would break test 26's byte-identity. */
export async function fileTaxReturn(
  tx: Sql,
  ctx: TenantContext,
  input: FileTaxReturnInput,
): Promise<TaxReturnRow> {
  const rows = await tx<{ status: string }[]>`
    select status from app.tax_return where id = ${input.taxReturnId} for update
  `;
  if (rows.length === 0) {
    throw new PostingError("ERR_NOT_FOUND", `tax return ${input.taxReturnId} is not visible in this tenant`);
  }
  const status = rows[0]!.status;
  if (status !== "generated") {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `tax return ${input.taxReturnId} is ${status}, not generated — only a generated return may be filed`,
    );
  }
  // ONE update, and that is load-bearing: the audit trigger writes a row per UPDATE, so a second
  // statement to default `filed_at` would put two audit rows behind one status change — the same
  // LEGACY-041 shape the `for update` two lines above exists to prevent.
  await tx`
    update app.tax_return
       set status        = 'filed',
           filed_at      = coalesce(${input.filedAt ?? null}::timestamptz, now()),
           attachment_id = ${input.attachmentId ?? null}
     where id = ${input.taxReturnId}
  `;
  void ctx;                    // the actor reaches the row through app_meta.attach_stamp, not this call
  const { row } = await getTaxReturn(tx, input.taxReturnId);
  return row;
}
```

**`for update` and not a bare select.** Two operators filing the same return in the same second would otherwise both read `generated` and both write `filed`, producing two audit rows for one transition — the LEGACY-041 shape applied to a status column. The row lock makes the second read `filed` and refuse.

Appended to **5A's** `packages/contracts/src/accounting/tax.ts`:

```ts
/** 5B — the body of `POST …/tax-returns/{taxReturnId}/file`. Both members optional: the ordinary
 *  filing sends `{}` and takes the server clock. */
export const FileTaxReturnBody = z.object({
  filedAt: TimestampSchema.optional(),
  attachmentId: UuidSchema.optional(),
}).strict().openapi("FileTaxReturnBody");
```

Appended to **5A's** `apps/api/src/routes/accounting/tax-returns.ts` — one route, beside its four:

```ts
import { fileTaxReturn } from "@dulja/db";
import { FileTaxReturnBody } from "@dulja/contracts";
import { EINVOICE_PERMISSION } from "./einvoice-transmissions";

taxReturnRoutes.openapi(
  createRoute({
    method: "post", path: "/{taxReturnId}/file", tags: ["accounting"],
    summary: "File a generated tax return",
    description: "The `generated → filed` transition. Gated by accounting.tax.file, not by accounting.tax.manage: filing is the act the spec's `accountant` row calls \"tax returns\" and it is separable from maintaining codes.",
    request: {
      params: z.object({ companyId: UuidSchema, taxReturnId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: FileTaxReturnBody } } },
    },
    middleware: [requirePermission(EINVOICE_PERMISSION.file, { company: "path:companyId" })],
    responses: {
      200: { description: "The filed return", content: { "application/json": { schema: TaxReturnDetail } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
      409: { description: "Not generated", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { taxReturnId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant((tx) => fileTaxReturn(tx, c.var.ctx, { taxReturnId, ...body }));
    const detail = await c.var.withTenant(async (tx) => ({
      ...(await getTaxReturn(tx, taxReturnId)),
      tieOut: await taxReturnTieOut(tx, taxReturnId),
    }));
    // `TaxReturnDetail` is 5A's and has FIVE members — `taxReturn`, `boxes`, `payload`, `tieOut`,
    // `currency` — and 5A's own `/generate` and `GET /{id}` handlers build exactly this shape. The
    // entity key is `taxReturn`, not `row`; `payload` comes off the row 5A already read back; and
    // `tieOut` is 5A's `taxReturnTieOut`, never `[]` — a filed return is precisely the one an auditor
    // asks to see reconciled. `toTaxReturnDto`, `getTaxReturn` and `taxReturnTieOut` are already in
    // this file (5A wrote them), so the appended import line above adds only `fileTaxReturn`.
    return c.json({
      taxReturn: toTaxReturnDto(row),
      boxes: detail.boxes.map((b) => ({ code: b.code, label: b.label, amount: b.amount.toString() })),
      payload: detail.row.payload,
      tieOut: detail.tieOut,
      currency: detail.currency,
    }, 200);
  },
);
```

**`einvoiceTransmissionRouteModule` is the only new `RouteModule`; this is a sub-path** and inherits 5A's `PROBES["/v1/companies/:companyId/tax-returns"]` key (§4.2.7's sub-path rule, 2B's precedent). **`taxReturnRouteModule.permissions` gains `"accounting.tax.file"`** in the same edit — the catalogue check reads that array, and a route gated by a code its module does not declare is exactly what `assertRouteGates` and the `permission-catalogue` rule exist to catch:

```ts
  permissions: [TAX_PERMISSION.manage, EINVOICE_PERMISSION.file],
```

- [ ] **Step 8: Register the module, add the probe, and write amendment 13**

`apps/api/src/routes/index.ts` — inside `buildRoutes`, beside 5A's two:

```ts
    einvoiceTransmissionRouteModule,
```

`tests/invariants/probes.ts` — one `PROBES` entry keyed by the exact module path:

```ts
  "/v1/companies/:companyId/einvoice-transmissions": {
    async seed(db, owner) {
      // The OWNER's transmission. The harness then requests it as the attacker, whose token carries
      // a different tenant; RLS makes the row invisible and `getTransmission` raises ERR_NOT_FOUND.
      const f = await einvoiceFixture(db, owner);
      const { transmissionId } = await f.postOptedInDocument();
      return { path: `/v1/companies/${owner.company}/einvoice-transmissions/${transmissionId}`, method: "GET" };
    },
    expect: 404,
  },
```

**404 and not 403**, for the reason §3.7.2 states and 5A's `tax-returns` probe repeats: the attacker holds `accounting.tax.file` in *their own* company, so `requirePermission` with `{ company: "path:companyId" }` would pass if they used their own company id — the refusal that matters is the one the data layer makes, and answering 403 on another tenant's id would confirm the id names something.

**Confirm contracts amendment 13 is in the file before committing this task.** Task 0 Step 1 wrote it; it is what licenses the three things this task did that no earlier task did — the ninth `AppEnv` variable, the `no-bare-db` allow-list entry, and the two sub-paths mounted on modules 0B and 5A own. Re-run the gate:

```bash
bash scripts/check/contracts-5b-amendments.sh
```

**Expected:** `5B pre-flight OK — thirteen amendments landed, every consumed name present.` If it reports amendment 13 missing, **write the amendment, do not delete the code** — the sub-paths are this slice's obligation under 5A's own handover and the amendment is where that is recorded.

- [ ] **Step 9: Write the runbook and the two source-fact assertions**

`docs/runbooks/einvoice-transmission.md`:

```markdown
# Runbook — e-invoice transmissions

**Who:** anyone holding `accounting.tax.file` (seeded to `accountant`).
**When:** a transmission is stuck at `pending`, `submitted` or `error`, or a document was transmitted
that should not have been.

## 1. Find the row

    GET /v1/companies/{companyId}/einvoice-transmissions?filter[status][eq]=error&limit=50

`lastError` is the refusal, `attempts` the number of remote calls made, `polledAt` the last call that
completed. (`claimed_at`, the column that says a call is in flight right now, is deliberately not on
the wire: it is a lock, not a fact about the transmission, and an operator who needs it reads the row.)

## 2. What each status means

| Status | Meaning | What to do |
|---|---|---|
| `pending` | The document posted; no remote call has succeeded yet. Either the job has not run or every attempt failed. | `POST …/{id}/submit` |
| `submitted` | The authority accepted the request and has not yet returned a final verdict. | Nothing — the poll phase re-enqueues itself with backoff up to `POLL_LIMIT`. After that `lastError` says it stopped. |
| `accepted` | Final. `qrPayload` and `externalId` are set. | Nothing |
| `rejected` | The authority refused the document. `lastError` carries its reason. | Correct the document by **reversal** (LEGACY-041, never by editing), post the correction, and let its own transmission run |
| `cancelled` | Withdrawn with the authority. | Nothing |
| `error` | A transport or configuration failure. | Read `lastError`, then `POST …/{id}/submit` |

## 3. The three configuration failures, in the order they occur

| `lastError` contains | Cause | Fix |
|---|---|---|
| `ERR_EINVOICE_NOT_ENABLED` | `company.einvoice_transmitter` is null — someone turned e-invoicing off after the document posted | `PUT /v1/companies/{id}/einvoice-settings`, then resubmit |
| `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` … `not registered` | The company names a transmitter this deployment did not register. **Before OD-15 is discharged this is every `myinvois` company and it is expected** | Nothing until ADR 0051 lands (plan Task 9) |
| `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` … `secret` | `EINVOICE_CLIENT_SECRET` is not set in this environment | Set the Cloudflare secret binding; `containerSecrets()` already enumerates the name |

## 4. Cancelling

    POST /v1/companies/{companyId}/einvoice-transmissions/{id}/cancel
    { "reason": "<what the operator will tell the authority>" }

Legal only from `accepted`. The row is never deleted (spec:2049) — `status` becomes `cancelled` and
`cancelledAt` is stamped.

## 5. What is never a fix

- Editing `app.einvoice_transmission` by hand. Every column is audited (test 13) and `app_rw` holds
  no DELETE on the table (§3.5.4).
- Re-posting the document. A document has one transmission — `unique (document_id)` — and a second
  post is a second document.
- Turning a gate off in code. The three gates are policy data and a company column; changing either
  is a seed PR or an API call.
```

Two `it`s appended to this task's test file, both source facts:

```ts
describe("source facts (5B T8)", () => {
  it("EinvoiceSecretNameSchema and EINVOICE_SECRET_NAMES are the same list", async () => {
    const { EINVOICE_SECRET_NAMES } = await import("@dulja/db");
    const { EinvoiceSecretNameSchema } = await import("@dulja/contracts");
    expect([...EinvoiceSecretNameSchema.options].sort()).toEqual([...EINVOICE_SECRET_NAMES].sort());
  });

  it("TransmitterCodeSchema and TRANSMITTER_CODES are the same list", async () => {
    const { TRANSMITTER_CODES } = await import("@dulja/db");
    const { TransmitterCodeSchema } = await import("@dulja/contracts");
    expect([...TransmitterCodeSchema.options].sort()).toEqual([...TRANSMITTER_CODES].sort());
  });
});
```

**These two are the whole reason the literals may be repeated across the `packages/contracts` / `packages/db` boundary §3.1 forbids importing across.** Without them, adding a second authority in Phase 10 would widen one list and leave the other, and the settings route would accept a code no registry knows.

- [ ] **Step 10: Run everything to green**

```bash
bun run --cwd packages/db test -- einvoice/permission
bun run --cwd apps/api test -- routes/accounting/einvoice-transmissions
bun run --cwd apps/api test -- routes/accounting/tax-returns
bun run --cwd tests test -- invariants/tenant-isolation
bun run --cwd packages/contracts openapi:generate
bun run typecheck && bun run lint && bun run lint:rules && bun run format:check
```

**Expected:** **nineteen** passing `it`s in this task's file — seventeen behaviour (5 list + 4 submit + 3 cancel + 5 settings/filing) and the two source facts of Step 9; 5A's `tax-returns` route file still green with the fifth route mounted; `tenant-isolation` green with the new `PROBES` key — and it would have **failed the build** without it, because the harness fails when a `ROUTES` entry has no probe. `lint:rules` is green: `permission-catalogue` sees the code in `PERMISSIONS` *and* its handler reference in this commit, `permission-catalogue.test.ts` sees table and catalogue agree because migration 0058 is in this commit too, and `role-seed` sees `accountant`'s new code in the catalogue. **This is the first commit at which any of Task 2's four files exists, and that is by design** — no earlier commit could have been green with a subset of them. The OpenAPI document is regenerated **in this commit** — CI fails on a diff (spec:2055).

- [ ] **Step 11: Commit**

```bash
git add packages/contracts/src/accounting/einvoice.ts packages/contracts/src/accounting/tax.ts \
        packages/db/migrations/0058_seed_permission_phase5b.sql packages/db/migrations/0058.down.sql \
        packages/contracts/src/index.ts packages/contracts/permissions.ts packages/contracts/openapi.json \
        packages/db/src/einvoice/settings.ts packages/db/src/einvoice/index.ts \
        packages/db/src/tax/returns.ts packages/db/seed/roles.ts \
        packages/db/test/einvoice/permission.test.ts \
        apps/api/src/routes/accounting/einvoice-transmissions.ts \
        apps/api/src/routes/accounting/tax-returns.ts apps/api/src/routes/index.ts \
        apps/api/src/routes/admin/companies.ts apps/api/src/app.ts apps/api/src/context.ts \
        apps/api/src/index.ts apps/api/test/support/app.ts \
        apps/api/test/routes/accounting/einvoice-transmissions.test.ts \
        scripts/lint/rules/no-bare-db.ts \
        tests/invariants/probes.ts tests/invariants/support/einvoice.ts \
        docs/runbooks/einvoice-transmission.md \
        docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
git commit -m "$(cat <<'EOF'
feat(api): e-invoice transmissions, company settings, and the filed transition [5B T8]

One route module and one PROBES key. Submit ENQUEUES under singletonKey =
transmissionId and answers 202 -- no authority call inside a request; cancel calls
the service directly because a reason is an operator's words and its refusal must
reach them. The company settings are two sub-paths on 0B's companyRoutes under
admin.company.manage, so the bookkeeper who files returns cannot repoint the
company at a different authority; they accept `myinvois` before ADR 0051 exists,
because the fail-closed refusal belongs at submit where last_error records it.

POST .../tax-returns/{id}/file is 5A's handover: that plan ships generated and
says in terms that generated -> filed is 5B's under accounting.tax.file. Without
it the status vocabulary carries a label no code can reach.

The WHOLE of Task 2 lands here -- migration 0058, the catalogue entry, the role
grant and its test -- because no proper subset of them is green: the migration
alone reds permission-catalogue.test.ts (which compares the table and the
catalogue in BOTH directions), the catalogue alone reds the permission-catalogue
lint, and roles.ts alone reds role-seed. 0058 is this PR's only migration, so
spec:2057 holds.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: ⚠️ OD-15 — ADR 0051, the MyInvois profile and the MyInvois transmitter

> ⚠️ **THIS IS THE ONLY TASK IN THIS PLAN GATED ON AN OWNER DECISION, AND IT IS THE ONLY PLACE IN THE REPOSITORY WHERE A MyInvois VALUE MAY BE WRITTEN.** Hazard 6: one task per §2.12 item, droppable without renumbering a neighbour's interfaces. **Drop this task and every other task of this slice still merges, still runs, and still passes CI** — the `synthetic` transmitter is registered, the three gates default off, and a company configured for `myinvois` gets `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` at submit with `last_error` naming the reason. That is §2.12's recorded default ("abstract interface only") made observable rather than merely absent. **Everything this task ships is OD-15 content and nothing else is:** `verify.ts`, the `einvoice:verify` package script and the `einvoice-verify` CLI sub-command are **Task 4's** precisely so that Task 11 Step 4's `Until provided:` line names a command that exists while OD-15 is pending; a droppable task cannot own the fallback for its own absence.

**What the owner provides (OD-15, spec:92, 982, 2226, 2405, 2467; Part VII #3).**

1. LHDN MyInvois **credentials** for a sandbox and for production: the client identifier, and the client secret delivered out of band (never in the repository, never in a ticket, never in a chat message).
2. Confirmation that the company is **in scope** of the current phase-in, and from which date.
3. Either the authority's current developer documentation, or written confirmation that the engineer may retrieve it directly.

**What the engineer does with it, and the order is not negotiable.** ADR 0051 is written **first**, from the authority's own current documentation, with the retrieval date and the exact document URLs recorded in it. Then — and only then — the profile file and the two ADR-0051-derived functions are written **from ADR 0051 and from nothing else**. Not from this plan, not from the contracts document, not from the legacy dossier's `JurTaxInfo` column names, and not from training data (spec:2467 says this in terms: *"do not rely on this document or on training data for deadlines or schema versions"*). The plan you are reading contains **no** MyInvois value because it was written before ADR 0051 existed, and `scripts/check/no-authority-literals.sh` (Task 0) is what proves that remained true.

**Hazard 5's pattern, stated exactly.**

> **Owner provides:** LHDN MyInvois sandbox client id and client secret, production client id and client secret, and confirmation of in-scope status and start date (OD-15).
> **Verify:** `bun run --cwd packages/db einvoice:verify --profile myinvois` prints `profile: ok`, `schema: ok`, `credentials: present`, `reachable: ok`.
> **Until provided:** the same script runs against the CI transmitter — `bun run --cwd packages/db einvoice:verify --profile synthetic` with `startStubServer()` running — and must print the same four lines. **That command and its four-`it` test are Task 4 Step 7's, not this task's**, so they are green from Task 4's commit and stay green whether or not this task ever runs; `packages/db/test/einvoice/verify.test.ts` is the authoritative form of the check.

**Files:**
- Create: `docs/adr/0051-verified-lhdn-myinvois-requirement-set.md`
- Create: `docs/decisions/od-15-5b-myinvois-requirement-set.md`
- Create: `docs/owner/od-15/README.md`
- Create: `packages/db/einvoice-profiles/myinvois.v1.json`
- Create: `packages/db/src/einvoice/myinvois.ts`
- Create: `packages/db/test/einvoice/myinvois.test.ts`
- Modify: `packages/db/src/einvoice/registry.ts` — one branch in `registerDefaultTransmitters`
- Modify: `packages/db/src/einvoice/index.ts` — one export
- Modify: `scripts/check/no-authority-literals.sh` — **optionally**, widen `WORDS` with the identifiers ADR 0051 actually names (Step 3's note). Task 0 could not: a denylist written before the authority's documentation was read would itself be a training-data guess.

**Not this task's, and named here because an earlier draft had them:** `packages/db/src/einvoice/verify.ts`, `packages/db/test/einvoice/verify.test.ts`, the `einvoice:verify` package script and the `einvoice-verify` CLI sub-command all ship in **Task 4 Step 7**.

**Interfaces**

- Consumes: `EInvoiceDocument`, `EInvoiceProfile`, `DocumentSnapshot` (**§4.4.2's nested shape — `header.{ id, number: bigint | null, effectiveDate, currency }`, with `company`, `party`, `lines` and `refs` as siblings**), `LineSnapshot` (**`taxCodeId: string | null`; the `TaxCodeRef` is in `refs.taxCodes`, keyed by row id**), `TaxCodeRef`, `canonicalJson`, `Canonicaliser`, `QrPayloadBuilder`, `TRANSMISSION_STATUSES` (Task 3 / §4.4.2); `loadProfile`, **`availableProfileVersions`** (Step 5's registration guard), `createHttpTransmitter`, **`RegisteredTransmitter`** (imported as a type, `createMyInvoisTransmitter`'s return type), `registerTransmitter`, `EInvoiceError`, `snapshotFixture` (§4.17.1(a), the test's two snapshots), and `verifyProfile` / `formatVerifyResult` for Step 6's sandbox check (Task 4); `Money` — **`Money.zero(currency)`, the static; there is no instance `zero()`** (§4.2.1).
- Produces:

```ts
// packages/db/src/einvoice/myinvois.ts (5B, OD-15 only)
/** One row per field the authority requires, transcribed from ADR 0051 §3 and from nowhere else.
 *  `source` is the ADR heading the row came from, so a reviewer can check each row against the
 *  document without re-reading the whole thing. `from` names where in the snapshot the value lives. */
export interface MyInvoisFieldRow {
  readonly field: string;
  readonly from:
    | { kind: "header"; path: "number" | "issuedAt" | "currency" | "totalExclTax" | "totalTax" | "totalInclTax" }
    | { kind: "party"; role: "supplier" | "buyer"; path: "name" | "taxId" | "registrationId" | "address" | "email" }
    | { kind: "line"; path: "lineNo" | "description" | "quantity" | "unitPrice" | "amount" | "taxCode" | "taxRate" | "taxAmount" }
    | { kind: "constant"; value: string };
  readonly required: boolean;
  readonly source: string;                  // e.g. "ADR 0051 §3.2"
}
export const MYINVOIS_FIELDS: readonly MyInvoisFieldRow[];        // EMPTY until ADR 0051 is written
export const MYINVOIS_QR_FIELDS: readonly string[];               // EMPTY until ADR 0051 is written
export function myinvoisCanonicalise(doc: DocumentSnapshot): EInvoiceDocument;
export function myinvoisQrPayload(doc: EInvoiceDocument, receipt: { externalId: string }): string;
export function createMyInvoisTransmitter(opts?: { fetchImpl?: typeof fetch }): RegisteredTransmitter;
```

**This task produces `VerifyResult` / `verifyProfile` / `formatVerifyResult` nowhere** — Task 4's Produces block owns them.

- [ ] **Step 1: Write the OD-15 record and the owner directory**

`docs/decisions/od-15-5b-myinvois-requirement-set.md`:

```markdown
# OD-15 — LHDN MyInvois credentials and the current requirement set

**Status:** pending as of the date this file was created. **Spec:** spec:92, 982, 2226, 2405, 2467;
Part VII #3. **Gated slice:** 5B, Task 9 only.

## The row, verbatim (spec:2405)

> | Phase 5 | LHDN MyInvois credentials and the current requirement set (§4.7) |

## What was assumed, and where each assumption lives

Nothing about MyInvois was assumed. The default §2.12 records is "abstract interface only", and that
is what merged: `EInvoiceTransmitter` (§4.9.3) is implemented by `createHttpTransmitter` over a
profile, and the only profile in the repository is `synthetic.v1.json`, which points at loopback.
`registerDefaultTransmitters` registers `synthetic` when `APP_ENV !== "production"` and registers
`myinvois` only when this task has run.

## What a company configured for `myinvois` experiences until then

Its posted documents of opted-in types get an `einvoice_transmission` row at `pending`; the job
raises `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE`, writes it to `last_error`, and leaves the row pending.
Nothing is lost and nothing is sent anywhere. `docs/runbooks/einvoice-transmission.md` §3 says so.

## If the answer is "not in scope yet"

Nothing changes. Leave `company.einvoice_transmitter` null on every company; the three gates are off
and no transmission row is ever written. Revisit when the phase-in reaches the company.

## If the answer is "in scope, here are the credentials"

Task 9 runs: ADR 0051 first, then the profile, then the two functions, then the registration branch.
```

`docs/owner/od-15/README.md`:

```markdown
# OD-15 material

**Put here:** the owner's written confirmation of in-scope status and start date, and a note of
*which* MyInvois environment (sandbox / production) each client identifier belongs to.

**Never put here:** a client secret, a token, a private key or a signed certificate. The secret is
delivered out of band and set as the Cloudflare secret binding `EINVOICE_CLIENT_SECRET` (§3.11);
`company.einvoice_credential_ref` stores the *name* `EINVOICE_CLIENT_SECRET` and never the value.
A secret committed here is a secret in git history for ever.

**Also here:** the retrieval date and the URLs of the authority documentation ADR 0051 was written
from, if the owner supplied them rather than the engineer retrieving them.
```

- [ ] **Step 2: Write ADR 0051 from the authority's current documentation**

`docs/adr/0051-verified-lhdn-myinvois-requirement-set.md`. **This is a retrieval task, not a writing task.** Open the authority's own current developer documentation, and fill each numbered section from it. Every section below says what to record and where the value is used; **no section below contains a value, because this plan is forbidden to guess one** (hazard 2). A section you cannot fill is recorded as an open question addressed back to the owner — never as a plausible guess.

```markdown
# 0051 — The verified LHDN MyInvois requirement set

**Status:** accepted on <date> · **Deciders:** <engineer>, <owner> · **Supersedes:** nothing
**Sources:** every URL below was retrieved on <retrieval date>. This ADR is the sole authority for
every MyInvois value in this repository (spec:2226, 2467). Re-verify before each schema version bump.

| # | Document | URL | Retrieved |
|---|---|---|---|
| 1 | <title as published> | <url> | <date> |
| 2 | … | … | … |

## 1. Scope and phase-in

Record: which taxpayer categories are in scope at the retrieval date, the threshold that decides it,
and the date the customer's company entered or enters scope. **Used by:** nothing in code. It decides
whether an admin sets `company.einvoice_transmitter` at all, and which document types get
`tax.einvoice: true` in their policy (section 6).

## 2. Schema version and identifier

Record: the exact version identifier the authority names, and how a submission declares it.
**Used by:** `myinvois.v1.json`'s `version` and, if the authority carries it in the request, one
`{ kind: "constant" }` row of `MYINVOIS_FIELDS`.

## 3. Mandatory and conditional fields

Record: one row per field — the authority's field name, whether it is mandatory, its type and format,
and the value's business meaning. **Used by:** `MYINVOIS_FIELDS` in `packages/db/src/einvoice/myinvois.ts`,
one row each, with `source` set to this section's heading. A field with no counterpart in
`DocumentSnapshot` is an **open question for section 8**, not an invented mapping.

## 4. The three calls

Record, for submit, poll (status enquiry) and cancel: HTTP method, path template with its named
parameters, request content type, the authentication header and scheme, and the response field that
carries the status — plus the response field carrying the authority's own document identifier on
submit. **Used by:** `myinvois.v1.json`'s `baseUrl`, `auth` and `calls` blocks, one call spec each.
The path template's parameters must be exactly the names `renderPath` substitutes: `{externalId}`.

## 5. The status vocabulary

Record: every status string the authority can return, and what each means. **Used by:** each call
spec's `statusMap`, mapping the authority's strings onto §4.9.3's six labels
(`pending | submitted | accepted | rejected | cancelled | error`). An unmapped remote status is not a
crash — `mapRemoteStatus` returns it in `unmapped` and Task 5 records it in `last_error` — but every
status named here must be mapped, and section 8 records any that is ambiguous.

## 6. Which document types are transmitted

Record: which document classes the mandate covers. **Used by:** the `tax.einvoice: true` flag on each
covered type's posting policy, applied as a **seed PR at `policyVersion + 1`** (contracts amendment 4)
— not as a list in TypeScript. Step 6 of this task does that.

## 7. The QR code

Record: exactly what the QR payload contains and in what order, and where the authority publishes the
validation link. **Used by:** `MYINVOIS_QR_FIELDS` and `myinvoisQrPayload`.

## 8. Open questions returned to the owner

One row per thing the documentation did not settle. **A row here is better than a guess in section 3.**

## 9. Sandbox versus production

Record: how the two environments differ — different base URL, different credentials, or both. **Used
by:** whether `myinvois.v1.json` is one file or two (`myinvois.v1.json` plus a second profile code).
If two, that is a second `TransmitterCode` and a contracts amendment; record it here and raise it.
```

**Commit ADR 0051 on its own**, before any code reads it:

```bash
git add docs/adr/0051-verified-lhdn-myinvois-requirement-set.md docs/decisions/od-15-5b-myinvois-requirement-set.md docs/owner/od-15/README.md
git commit -m "$(cat <<'EOF'
docs(adr): record the verified LHDN MyInvois requirement set [5B T9]

ADR 0051, written from the authority's own current documentation with the
retrieval date and every source URL recorded. Nothing in this commit came from
the spec, the contracts document, the legacy dossier or training data
(spec:2226, 2467). Section 8 returns the unsettled items to the owner.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Write the profile from ADR 0051 §2, §4 and §5**

`packages/db/einvoice-profiles/myinvois.v1.json`. **It has exactly the shape of `synthetic.v1.json`** — same keys, same nesting, validated by the same `einvoice-profile.schema.json` through the same `parseProfile` — and every value in it comes from ADR 0051 and is annotated with the section it came from:

```json
{
  "$schema": "../../domain/einvoice-profile.schema.json",
  "code": "myinvois",
  "version": 1,
  "jurisdiction": "MY",
  "source": "ADR 0051 §2, §4, §5 — retrieved <date>",
  "baseUrl": "<ADR 0051 §4: the authority's base URL for the environment this file targets>",
  "timeoutMs": 20000,
  "auth": {
    "kind": "bearer",
    "header": "<ADR 0051 §4: the authentication header name>",
    "scheme": "<ADR 0051 §4: the scheme token, or omit this key when there is none>",
    "clientIdHeader": "<ADR 0051 §4: the header carrying the client id, or omit when it is carried in the body>"
  },
  "calls": {
    "submit": {
      "method": "<ADR 0051 §4>", "pathTemplate": "<ADR 0051 §4>", "body": "document",
      "externalIdPointer": "<ADR 0051 §4: RFC 6901 pointer to the authority's document id>",
      "statusPointer": "<ADR 0051 §4: RFC 6901 pointer to the status>",
      "statusMap": { "<every string from ADR 0051 §5>": "<one of pending|submitted|accepted|rejected|cancelled|error>" },
      "errorPointer": "<ADR 0051 §4: RFC 6901 pointer to the refusal reason, or omit>"
    },
    "poll":   { "method": "<§4>", "pathTemplate": "<§4, with {externalId}>", "body": "none",         "statusPointer": "<§4>", "statusMap": { "…": "…" } },
    "cancel": { "method": "<§4>", "pathTemplate": "<§4, with {externalId}>", "body": "cancellation", "statusPointer": "<§4>", "statusMap": { "…": "…" } }
  }
}
```

**The angle brackets are the point, not an omission.** This file is the one artefact in the repository whose values a plan may not contain, and every one of them has a named source in a document the executor has just written. **A file still containing an angle bracket fails `parseProfile`** — the schema's `baseUrl` carries `"pattern": "^https?://[A-Za-z0-9.:_-]+/?$"` and no `format` keyword (deliberately: Task 3 adds no `ajv-formats`), its `method` is an enum of four verbs, and `statusMap`'s values are the six-label enum — so it cannot reach a test, let alone production, half-filled. Run the schema check immediately:

```bash
bun run --cwd packages/db test -- einvoice/profile
bash scripts/check/no-authority-literals.sh
```

**Expected:** `profile.test.ts` green (it globs `PROFILE_DIR` and `parseProfile`s every file it finds — Task 4 Step 2 wrote it that way for exactly this moment), and the hazard-2 grep green because `myinvois.v1.json` now cites `0051` in `source` and ADR 0051 exists. Both are the checks that catch a half-filled file.

**Optional, and only now that ADR 0051 exists: widen the grep's `WORDS`.** `scripts/check/no-authority-literals.sh` ships with `WORDS='myinvois|lhdn'` and nothing else, because those are the only two tokens the project's own documents attest and **a denylist of "LHDN field names" written before the authority's documentation was read would itself be the training-data guess hazard 2 forbids**. With ADR 0051 in hand, the identifiers §3 and §4 actually name may be appended to `WORDS` — each one traceable to an ADR heading — so a later engineer who pastes one into a source file is caught. Do it in this task's commit or not at all; never from memory.

- [ ] **Step 4: Write `myinvois.ts` from ADR 0051 §3 and §7**

`packages/db/src/einvoice/myinvois.ts`. **The module is complete; one constant is a transcription.** `MYINVOIS_FIELDS` is to this file exactly what a statutory rate table is to Phase 8 (spec:2229, hazard 1): the code that consumes it ships whole, the data it consumes comes from a reviewed source, and a change to the source is a reviewed diff rather than a release.

```ts
// packages/db/src/einvoice/myinvois.ts (5B, OD-15 only)
//
// ⚠️ EVERY VALUE IN `MYINVOIS_FIELDS` AND `MYINVOIS_QR_FIELDS` COMES FROM docs/adr/0051 AND FROM
// NOWHERE ELSE. Not from the spec, not from the contracts document, not from the legacy dossier's
// `JurTaxInfo` column names, not from training data (spec:2226, 2467). Each row carries the ADR
// heading it was transcribed from so a reviewer can check one row without re-reading the document.
//
// The mapping ENGINE below is generic and was written before ADR 0051 existed; only the two arrays
// are the transcription. That separation is deliberate — it is why this task could be dropped
// entirely without any other task of slice 5B changing.

import { createHash } from "node:crypto";
import { canonicalJson, Money, type DocumentSnapshot, type EInvoiceDocument, type LineSnapshot } from "@dulja/domain";
import { createHttpTransmitter, type RegisteredTransmitter } from "./http-transmitter";
import { loadProfile } from "./profile";

export interface MyInvoisFieldRow {
  readonly field: string;
  readonly from:
    | { kind: "header"; path: "number" | "issuedAt" | "currency" | "totalExclTax" | "totalTax" | "totalInclTax" }
    | { kind: "party"; role: "supplier" | "buyer"; path: "name" | "taxId" | "registrationId" | "address" | "email" }
    | { kind: "line"; path: "lineNo" | "description" | "quantity" | "unitPrice" | "amount" | "taxCode" | "taxRate" | "taxAmount" }
    | { kind: "constant"; value: string };
  readonly required: boolean;
  readonly source: string;
}

/** Transcribed from ADR 0051 §3, one row per field the authority names. EMPTY in this commit; the
 *  test below fails while it is empty, which is what stops the transmitter registering half-built. */
export const MYINVOIS_FIELDS: readonly MyInvoisFieldRow[] = [
  // { field: "<the authority's field name>", from: { kind: "header", path: "number" }, required: true, source: "ADR 0051 §3.1" },
];

/** Transcribed from ADR 0051 §7, in the authority's stated order. */
export const MYINVOIS_QR_FIELDS: readonly string[] = [];

class MyInvoisMappingError extends Error {}

function headerValue(doc: DocumentSnapshot, path: string): string {
  // §4.4.2 NESTS the header: `DocumentSnapshot.header.{ id, number: bigint | null, effectiveDate,
  // currency, ... }`, with `company`, `party`, `lines` and `refs` as its SIBLINGS. Nothing on this
  // path is read off the top level, and `number` is a bigint, never a string.
  //
  // The document's own zero, in the document's own currency. `Money.zero(currency)` is §4.2.1's
  // static constructor and `header.currency` is already a `CurrencyCode`, so no `currency(code)` call
  // is needed; `0`, `Number(...)` and `.toFixed()` are all Global Constraint 4 violations.
  const zero = Money.zero(doc.header.currency);
  switch (path) {
    case "number": return doc.header.number === null ? "" : doc.header.number.toString();
    case "issuedAt": return doc.header.effectiveDate;
    case "currency": return doc.header.currency;
    // Every total is a `Money` fixed-scale string. NEVER `Number()`, NEVER `.toFixed()` — LEGACY-019,
    // Global Constraint 4, and the legacy-019 block of Task 10 asserts no local rounding exists here.
    // `reduce` seeds from `zero` rather than from `lines[0]`, so a line-less document produces
    // "0.0000" instead of throwing on an undefined index — which is what the fourth test below
    // exercises, and what a credit note with every line removed would otherwise do in production.
    // `LineSnapshot.taxAmount` and `.totalInclTax` are `Money`, NOT `Money | null` (§4.4.2), so no
    // `??` fallback is written here; one would be dead code the strict lint flags.
    case "totalExclTax": return doc.lines.reduce((m, l) => m.add(l.amount), zero).toString();
    case "totalTax": return doc.lines.reduce((m, l) => m.add(l.taxAmount), zero).toString();
    case "totalInclTax": return doc.lines.reduce((m, l) => m.add(l.totalInclTax), zero).toString();
    default: throw new MyInvoisMappingError(`unknown header path "${path}"`);
  }
}

function partyValue(doc: DocumentSnapshot, role: "supplier" | "buyer", path: string): string | null {
  const p = role === "supplier" ? doc.company : doc.party;
  if (p === null || p === undefined) return null;
  const bag = p as unknown as Record<string, unknown>;
  const v = bag[path];
  return typeof v === "string" ? v : null;
}

/** Takes the whole snapshot as well as the line, because a `LineSnapshot` carries only
 *  `taxCodeId: string | null` — there is no `line.taxCode` object anywhere in §4.4.2. The
 *  `TaxCodeRef` lives in `snapshot.refs.taxCodes`, keyed by the ROW ID (§4.4.2's closing note), and
 *  5A is the slice that fills that map. */
function lineValue(doc: DocumentSnapshot, line: LineSnapshot, path: string): string {
  const ref = line.taxCodeId === null ? undefined : doc.refs.taxCodes[line.taxCodeId];
  switch (path) {
    case "lineNo": return String(line.lineNo);
    case "description": return line.description ?? "";
    case "quantity": return line.quantity?.toString() ?? "";
    case "unitPrice": return line.unitPrice?.toString() ?? "";
    case "amount": return line.amount.toString();
    case "taxCode": return ref?.code ?? "";
    case "taxRate": return ref?.rate ?? "";
    // `taxAmount` is a non-nullable `Money`, and `Money` has no INSTANCE `zero()` — §4.2.1 declares
    // only the static `Money.zero(currency)`. Neither guard is needed.
    case "taxAmount": return line.taxAmount.toString();
    default: throw new MyInvoisMappingError(`unknown line path "${path}"`);
  }
}

/** Builds the authority's document from the snapshot by walking `MYINVOIS_FIELDS`. A `required` row
 *  whose value is null or empty throws rather than submitting a document the authority will reject —
 *  the refusal is cheaper here than a `rejected` row and a reversal. */
export function myinvoisCanonicalise(doc: DocumentSnapshot): EInvoiceDocument {
  if (MYINVOIS_FIELDS.length === 0) {
    throw new MyInvoisMappingError(
      "MYINVOIS_FIELDS is empty — ADR 0051 §3 has not been transcribed; see plan 5B Task 9 Step 4",
    );
  }
  const header: Record<string, unknown> = {};
  const supplier: Record<string, unknown> = {};
  const buyer: Record<string, unknown> = {};
  const lineRows: Record<string, unknown>[] = doc.lines.map(() => ({}));

  for (const row of MYINVOIS_FIELDS) {
    if (row.from.kind === "constant") { header[row.field] = row.from.value; continue; }
    if (row.from.kind === "header") {
      const v = headerValue(doc, row.from.path);
      if (row.required && v === "") throw new MyInvoisMappingError(`required field "${row.field}" (${row.source}) is empty`);
      header[row.field] = v; continue;
    }
    if (row.from.kind === "party") {
      const v = partyValue(doc, row.from.role, row.from.path);
      if (row.required && (v === null || v === "")) {
        throw new MyInvoisMappingError(`required field "${row.field}" (${row.source}) has no value on the ${row.from.role}`);
      }
      (row.from.role === "supplier" ? supplier : buyer)[row.field] = v; continue;
    }
    doc.lines.forEach((line, i) => {
      const v = lineValue(doc, line, (row.from as { path: string }).path);
      if (row.required && v === "") throw new MyInvoisMappingError(`required field "${row.field}" (${row.source}) is empty on line ${line.lineNo}`);
      lineRows[i]![row.field] = v;
    });
  }

  const body = { header, supplier, buyer, lines: lineRows };
  const payload = canonicalJson(body);
  return {
    documentId: doc.header.id,
    number: doc.header.number === null ? "" : doc.header.number.toString(),
    issuedAt: doc.header.effectiveDate,
    supplier, buyer, lines: lineRows,
    totals: header,
    hash: createHash("sha256").update(payload, "utf8").digest("hex"),
  };
}

/** ADR 0051 §7's fields, in the authority's stated order, joined by the separator §7 records. The
 *  separator is a constant row of MYINVOIS_QR_FIELDS' own transcription: if §7 states one, it is the
 *  first element and is named `"|separator|"`; if it states none, the fields are concatenated. */
export function myinvoisQrPayload(doc: EInvoiceDocument, receipt: { externalId: string }): string {
  if (MYINVOIS_QR_FIELDS.length === 0) {
    throw new MyInvoisMappingError("MYINVOIS_QR_FIELDS is empty — ADR 0051 §7 has not been transcribed");
  }
  const bag: Record<string, unknown> = { ...(doc.totals as object), ...(doc.supplier as object), ...(doc.buyer as object), externalId: receipt.externalId, hash: doc.hash };
  const [maybeSeparator, ...rest] = MYINVOIS_QR_FIELDS;
  const separator = maybeSeparator === "|separator|" ? (bag["|separator|"] as string) ?? "" : "";
  const fields = maybeSeparator === "|separator|" ? rest : MYINVOIS_QR_FIELDS;
  return fields.map((f) => String(bag[f] ?? "")).join(separator);
}

export function createMyInvoisTransmitter(opts: { fetchImpl?: typeof fetch } = {}): RegisteredTransmitter {
  return createHttpTransmitter({
    profile: loadProfile("myinvois"),
    canonicalise: myinvoisCanonicalise,
    qrPayload: myinvoisQrPayload,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
```

`packages/db/test/einvoice/myinvois.test.ts` — **five `it`s, and the first two fail until §3 and §7 are transcribed, on purpose**. Both snapshots below are built from §4.17.1(a)'s `snapshotFixture()` rather than written as literals, because §4.4.2 nests the header and a flat literal would throw inside `headerValue` before any assertion ran:

```ts
import { describe, expect, it } from "vitest";
import { MYINVOIS_FIELDS, MYINVOIS_QR_FIELDS, myinvoisCanonicalise } from "../../src/einvoice/myinvois";
import { loadProfile } from "../../src/einvoice/profile";
import { TRANSMISSION_STATUSES } from "@dulja/domain";
import { snapshotFixture } from "../support/einvoice-stub";

describe("the MyInvois transmitter (5B T9, OD-15)", () => {
  it("has transcribed ADR 0051 §3 — every row cites its source heading", () => {
    expect(MYINVOIS_FIELDS.length).toBeGreaterThan(0);
    for (const row of MYINVOIS_FIELDS) {
      expect(row.source, row.field).toMatch(/^ADR 0051 §/);
      expect(row.field, "a field name may not be empty").not.toBe("");
    }
  });

  it("has transcribed ADR 0051 §7", () => {
    expect(MYINVOIS_QR_FIELDS.length).toBeGreaterThan(0);
  });

  it("maps every remote status the profile names onto one of the six labels", () => {
    const profile = loadProfile("myinvois");
    for (const call of ["submit", "poll", "cancel"] as const) {
      const map = profile.calls[call].statusMap;
      expect(Object.keys(map).length, `${call} statusMap is empty`).toBeGreaterThan(0);
      for (const [remote, local] of Object.entries(map)) {
        expect(TRANSMISSION_STATUSES, `${call}: "${remote}"`).toContain(local);
      }
    }
  });

  it("refuses to build a document when a required field has no value", () => {
    // §4.4.2's shape, taken from the ONE fixture in the repository that builds it
    // (`snapshotFixture`, §4.17.1(a)), then emptied where the refusal is expected: no buyer, no
    // lines, no tax-code refs. Writing a flat `{ id, number, currency, … }` literal here would not
    // even reach an assertion — `headerValue` reads `doc.header.currency` on its first line.
    const base = snapshotFixture();
    const bare = { ...base, party: null, lines: [], refs: { ...base.refs, taxCodes: {} } };
    expect(() => myinvoisCanonicalise(bare)).toThrow(/required field|is empty|has no value/);
  });

  it("produces the same hash for the same snapshot twice (canonicalJson is deterministic)", () => {
    // Two calls, one comparison, and NO fixed hash literal — a hash constant here would depend on
    // MYINVOIS_FIELDS' content and would therefore be a MyInvois-shaped value this plan may not
    // contain. Determinism is the property; the digest itself is not asserted anywhere.
    // §4.17.1(a)'s `snapshotFixture()` IS the §4.4.2 shape — nested `header`, `company`, `party`,
    // `lines` and `refs` — so this test builds no snapshot of its own (hazard 9). The party fields a
    // `MyInvoisFieldRow` of kind "party" reads are added to the two party objects here rather than in
    // the shared fixture, because they exist for this file alone; and the tax-code ref is registered
    // in `refs.taxCodes` under the line's own `taxCodeId`, which is where §4.4.2 keeps it.
    const base = snapshotFixture();
    const line = base.lines[0]!;
    const snapshot = {
      ...base,
      company: { ...base.company, name: "Fixture Supplier", taxId: "SUP-1", registrationId: "REG-1", address: "1 Test Road", email: "supplier@example.invalid" },
      party: { ...base.party!, name: "Fixture Buyer", taxId: "BUY-1", registrationId: "REG-2", address: "2 Test Road", email: "buyer@example.invalid" },
      refs: {
        ...base.refs,
        taxCodes: {
          [line.taxCodeId!]: {
            id: line.taxCodeId!, code: "SYN-OUT-STD", rate: "0.06000000",
            kind: "output" as const, roundingMode: "half_up" as const,
            outputAccountId: null, inputAccountId: null,
          },
        },
      },
    };
    const first = myinvoisCanonicalise(snapshot);
    const second = myinvoisCanonicalise(snapshot);
    expect(second.hash).toBe(first.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    // If a required field of ADR 0051 §3 has no counterpart in this snapshot, this throws with the
    // field's name and its ADR heading — which is the signal to extend the snapshot, never to make
    // the field optional.
  });
});
```

- [ ] **Step 5: Register the transmitter, and opt the covered types in with a seed PR**

`packages/db/src/einvoice/registry.ts` — **two import lines and one branch inside `registerDefaultTransmitters`**, beside the `synthetic` one Task 4 wrote. Task 4 Step 5 quotes this same branch and names these same two imports, so the two places cannot drift:

```ts
import { availableProfileVersions } from "./profile";
import { createMyInvoisTransmitter } from "./myinvois";
```

```ts
  // 5B Task 9 (OD-15). Registered in EVERY environment, including production — the whole point of
  // the gate is that until this task ran, `myinvois` resolved to nothing. `loadProfile` throws if
  // the file is absent, so a deployment missing the profile fails at boot rather than at submit.
  if (availableProfileVersions("myinvois").length > 0) {
    registerTransmitter("myinvois", createMyInvoisTransmitter());
  }
```

Then, **as a seed PR and not a code change** (contracts amendment 4, hazard 1's discipline applied to hazard 2): for each document type ADR 0051 §6 names, re-seed its envelope at `policyVersion + 1` with `"einvoice": true` inside the policy's `tax` block. The `SALES_INVOICE` envelope, which 4A owns, becomes:

```json
  "policyVersion": 3,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "tax": { "applies": true, "inclusive": false, "einvoice": true }
  }
```

— **`policyVersion` 3 because 5A moved it to 2**; read the file rather than assuming, and change only the `tax` block and the version. Apply it:

```bash
bun run --cwd packages/db seed --tenant "$TENANT_ID" --only document-types
```

**No TypeScript changes when the mandate widens.** A type the authority adds next year is one more seed PR — which is the whole reason amendment 4 put `einvoice` on the policy instead of in a list in code.

- [ ] **Step 6: Verify against the sandbox, then run everything**

```bash
EINVOICE_CLIENT_SECRET="<the sandbox secret, from the owner, out of band>" \
  bun run --cwd packages/db einvoice:verify --profile myinvois
```

**Expected:** `profile: ok`, `schema: ok`, `credentials: present`, `reachable: ok`, exit 0. **A `reachable` line that is not `ok` is a stop-and-raise, not a workaround** — it means the base URL or the path template in §4 was transcribed wrongly, or the environment has no egress, and both are answered by re-reading ADR 0051 rather than by editing the profile until something answers.

```bash
bun run --cwd packages/db test -- einvoice/
bash scripts/check/no-authority-literals.sh
bun run typecheck && bun run lint && bun run lint:rules && bun run format:check && bun run test
```

**Expected:** every `einvoice/` suite green including the five `myinvois` `it`s; the hazard-2 grep green (`myinvois.v1.json` cites 0051, ADR 0051 exists, `myinvois.ts` is on the grep's permitted list, no absolute URL is in the code surface).

- [ ] **Step 7: Commit**

```bash
git add packages/db/einvoice-profiles/myinvois.v1.json packages/db/src/einvoice/myinvois.ts \
        packages/db/src/einvoice/registry.ts packages/db/src/einvoice/index.ts \
        packages/db/test/einvoice/myinvois.test.ts scripts/check/no-authority-literals.sh \
        packages/db/seed/my/document-types/
git commit -m "$(cat <<'EOF'
feat(db): the MyInvois transmitter, from ADR 0051 and nowhere else [5B T9]

OD-15 discharged. The profile's every value cites an ADR 0051 section; the two
transcribed arrays in myinvois.ts cite a heading per row, and the first two tests
fail while either is empty. The mapping engine itself was written before ADR 0051
existed and is unchanged by it -- which is why this task was droppable.

einvoice:verify is NOT in this commit: it is Task 4 Step 7's, proven against the
synthetic profile and a loopback stub long before it was pointed at an authority,
so hazard 5's "Until provided" fallback holds whether or not this task runs.
This commit only points that command at a second profile.

Which document types transmit is a seed PR on the policy tax block, not a list in
code (contracts amendment 4).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Test 26 re-run with hooks on, test 13 over the new surface, and the two regression appends

**This task owns no acceptance test and re-runs two, and the distinction matters for how it is reviewed.** The card says so: *"Part VI tests owned: none. Re-runs: 26, 13."* Test 26 is **5A's** and its golden corpus is 5A's; this file must not become a second definition of "the return is deterministic". What it proves is the negative claim only 5B can make: **turning the e-invoicing hooks on moves no byte of the return**, and **everything the hooks write is audited**.

**Why this file posts its own corpus rather than replaying `tests/golden/tax/`.** 5A's replay path — whatever function reads `input.json` and produces a return — is 5A's to name, and this plan was written before 5A's file existed. Inventing a loader here would give the repository two ways to replay one corpus (hazard 9), and guessing 5A's would fail at import. So this file builds its corpus through **5A's own exported helpers** — `taxFixture` and `postTaxedDocument` — which are in the contracts register (§4.17.1) and are therefore safe to name, and it makes a **structural** assertion about `tests/golden/tax/` plus a **named skip** when the directory is empty. Task 0's gate prints the case count precisely so the executor knows which branch will run before starting.

**Files:**
- Create: `tests/golden/tax-einvoice.test.ts`
- Modify: `tests/regression/legacy-020.test.ts` — one appended `describe`, nothing existing edited (§3.7.3)
- Modify: `tests/regression/legacy-019.test.ts` — one appended `describe`, nothing existing edited

**Interfaces**

- Consumes: **5A** — `taxFixture(db, name)`, `TaxFixture` (`{ s; regimeId; codes; accounts; types; customerId; vendorId; poster }` — the corpus loop reads `codes` keys, `accounts` by account code, and both party ids), `postTaxedDocument(db, f, { typeCode, effectiveDate, partyId?, taxInclusive?, lines: TaxedLine[] })` with `TaxedLine = { lineNo; kind?; accountId?; amount; taxCode: string | null }` (`tests/invariants/support/tax.ts`, §4.17.1 — **the option is `typeCode`, not `code`, and `taxCode` is a KEY of `TaxFixture.codes`**), `TAX_PACK_ROOT`, `createTaxReturn`, `generateTaxReturn`, `getTaxReturn`, `taxReturnTieOut`, `TaxReturnRow`, `ReturnBox`; **Task 7/8** — `einvoiceFixture`, `EinvoiceFixture`, `OPTED_IN_TYPE_CODE`; **Task 5** — `listTransmissions`, `EinvoiceTransmissionRow`; **Task 4** — `startStubServer`, `StubServer`, `enableEinvoice`, `optInDocumentType`; **1B** — `runIntegrityCheck`; **0B/0A** — `startDb`, `Db`, `Seed`, `seedTenantV2`, `uuidv7` (§4.1's `uuidv7(sql: Sql): Promise<string>` — awaited, never called with no argument), `grantCodes`; production `withTenant`; and **`REPO_ROOT` + `sourceFiles` from `tests/support/source.ts`** (§4.17.1, owner 0B — *not* from `@dulja/api/routes`). **`repoFile` is not consumed by this task.**
- Produces: **no exported name.** Three test files' worth of assertions and nothing else — which is why this task adds no row to any register.

- [ ] **Step 1: Write the failing golden file's scaffold and corpus**

`tests/golden/tax-einvoice.test.ts`:

```ts
// tests/golden/tax-einvoice.test.ts (5B T10)
//
// Acceptance test 26 (spec:2444) re-run with the e-invoicing hooks ON, and acceptance test 13
// (spec:2431) over the surface slice 5B adds. Test 26 itself is 5A's and lives in 5A's own golden
// file; this one asserts the two things only 5B can assert:
//
//   (a) generating twice with hooks on is byte-identical            — test 26, hooks on
//   (b) hooks on and hooks off produce the same boxes and payload   — the hooks change no number
//   (c) every write the hooks make is audited under a server actor  — test 13
//
// Two tenants in one container: A has e-invoicing OFF, B has it ON. Everything else about them is
// identical, because both are built by the same two fixture calls.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withTenant as prodWithTenant } from "@dulja/db";
import { listTransmissions, runIntegrityCheck } from "@dulja/db";
import { createTaxReturn, generateTaxReturn, getTaxReturn, taxReturnTieOut } from "@dulja/db";
import { registerDefaultTransmitters, resetTransmitters } from "@dulja/db";
import { startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { startStubServer, type StubServer } from "@dulja/db/test/einvoice-stub";
import { postTaxedDocument, taxFixture, type TaxFixture } from "../invariants/support/tax";
import { OPTED_IN_TYPE_CODE, einvoiceFixture, type EinvoiceFixture } from "../invariants/support/einvoice";
// §4.17.1: `REPO_ROOT` and `sourceFiles(roots?)` live in `tests/support/source.ts` (owner 0B), NOT
// in `@dulja/api/routes` — §4.2.7 limits that entry point to `ROUTES`, `buildRoutes`, `RouteModule`
// and `IdempotencyHeader`, and a test-tier walker on a production entry point would put the
// repository walk on `apps/api`'s import graph (§3.1).
import { REPO_ROOT, sourceFiles } from "../support/source";

let db: Db;
let stub: StubServer;
let off: TaxFixture;                 // tenant A — company with einvoice_transmitter null
let on: TaxFixture;                  // tenant B — company with einvoice_transmitter 'synthetic'
let onE: EinvoiceFixture;

const Q1 = { periodStart: "2026-01-01", periodEnd: "2026-03-31" };

/** §4.1 freezes `uuidv7(sql: Sql): Promise<string>` — it takes a `Sql` and it is async, so it can
 *  never be called from a synchronous factory. One request id is minted in `beforeAll` and reused as
 *  the correlation id of every context in this file; a `requestId` is a correlation value, not a row
 *  id, so one per file is correct and keeps `ctxOf` synchronous at its sixteen call sites. */
let requestId: string;
/** Tenant B's corpus document ids, in `CORPUS` order. */
let onDocIds: string[] = [];
const ctxOf = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId });

/**
 * The corpus. Five taxed documents, the same figures on both tenants, every amount an obviously
 * invented round number — hazard 1 binds here exactly as it does in Phase 8 (Global Constraint 14).
 * The tax rate is whatever 5A's `seedTaxCode` default is; this file never states one.
 *
 * **The member names are 5A's, not this plan's.** `postTaxedDocument(db, f, opts)` takes
 * `{ typeCode, effectiveDate, partyId?, taxInclusive?, lines: TaxedLine[] }` — `typeCode` and not
 * `code` (5A maps it onto 4B's `code` itself), and a `TaxedLine` is
 * `{ lineNo; kind?; accountId?; amount; taxCode: string | null }` whose `taxCode` is a KEY OF
 * `TaxFixture.codes` (`SYN-OUT-STD`, `SYN-OUT-ZERO`, `SYN-IN-STD`, `SYN-EXEMPT`), never a rate and
 * never a uuid. A purchase document is posted against the VENDOR, so it carries `partyId` explicitly;
 * a sales one takes 5A's own default. `accountId` is left to 5A's default of `f.accounts["4000"]` on
 * the sales rows and named on the purchase rows, because a purchase posted to revenue would tie out
 * against the wrong control account in the fourth `it` below.
 */
const CORPUS = [
  { typeCode: "SALES_INVOICE",        effectiveDate: "2026-01-10", amount: "1000.0000", taxCode: "SYN-OUT-STD", party: "customer" as const, accountCode: "4000" },
  { typeCode: "SALES_INVOICE",        effectiveDate: "2026-02-04", amount: "2500.0000", taxCode: "SYN-OUT-STD", party: "customer" as const, accountCode: "4000" },
  { typeCode: "SALES_CREDIT_NOTE",    effectiveDate: "2026-02-18", amount: "300.0000",  taxCode: "SYN-OUT-STD", party: "customer" as const, accountCode: "4000" },
  { typeCode: "PURCHASE_INVOICE",     effectiveDate: "2026-01-22", amount: "800.0000",  taxCode: "SYN-IN-STD",  party: "vendor"   as const, accountCode: "5900" },
  { typeCode: "PURCHASE_CREDIT_NOTE", effectiveDate: "2026-03-09", amount: "150.0000",  taxCode: "SYN-IN-STD",  party: "vendor"   as const, accountCode: "5900" },
];

/** Returns the document ids IN `CORPUS` ORDER, so a caller can pair a row with the entry that made
 *  it — which is what the opted-in count in Step 4 needs. */
async function postCorpus(f: TaxFixture): Promise<string[]> {
  const ids: string[] = [];
  for (const doc of CORPUS) {
    const { documentId } = await postTaxedDocument(db, f, {
      typeCode: doc.typeCode,
      effectiveDate: doc.effectiveDate,
      partyId: doc.party === "vendor" ? f.vendorId : f.customerId,
      lines: [{
        lineNo: 1,
        kind: "account",
        accountId: f.accounts[doc.accountCode]!,
        amount: doc.amount,
        taxCode: doc.taxCode,
      }],
    });
    ids.push(documentId);
  }
  return ids;
}

async function generate(f: TaxFixture): Promise<{ row: { payloadSha256: string | null; payload: string | null }; boxes: { code: string; label: string; amount: string }[] }> {
  const ctx = ctxOf(f.s);
  return prodWithTenant(db.rw, ctx, async (tx) => {
    const created = await createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId: f.regimeId, ...Q1 });
    await generateTaxReturn(tx, ctx, created.id);
    const { row, boxes } = await getTaxReturn(tx, created.id);
    return { row: { payloadSha256: row.payloadSha256, payload: row.payload }, boxes };
  });
}

beforeAll(async () => {
  db = await startDb();
  requestId = await uuidv7(db.admin);
  // The registry is module-level process state and nothing in this file's import graph fills it —
  // `registerDefaultTransmitters` is called by the two ENTRYPOINTS (apps/api, apps/worker), which a
  // root `tests/` file does not start. Without these two lines `driveToAccepted` answers
  // ERR_EINVOICE_TRANSMITTER_UNAVAILABLE on every row.
  resetTransmitters();
  registerDefaultTransmitters("dev");
  stub = await startStubServer({
    submit: { state: "queued", receiptId: "GOLD-1" },
    poll:   { state: "cleared" },
    cancel: { state: "withdrawn" },
  });
  off = await taxFixture(db, "einvoice-off");
  on  = await taxFixture(db, "einvoice-on");
  // `einvoiceFixture` runs 4B's `arApFixture` on the tenant `taxFixture` already populated. Both
  // seed accounts and grant codes, so the composition works only if `arApFixture` is select-or-
  // insert — 4B's own Self-Review records that `seedTypeFromPack` was made so for exactly this
  // reason. **If this line raises ERR_CONFLICT_UNIQUE, that is the finding**: raise it with 4B
  // rather than reordering the two calls, because reordering only moves which one collides.
  onE = await einvoiceFixture(db, on.s);            // enables the company and opts SALES_INVOICE in
  await postCorpus(off);
  onDocIds = await postCorpus(on);                  // in CORPUS order — Step 4 pairs them back up
}, 600_000);

afterAll(async () => {
  await stub.stop();
  await db.stop();
});
```

- [ ] **Step 2: Run it to see the exact failure**

```bash
bun run --cwd tests test -- golden/tax-einvoice
```

**Expected: FAIL** with `No test suite found in file tests/golden/tax-einvoice.test.ts` — the scaffold has a `beforeAll` and no `describe`. That is the right red: it proves the corpus posts on both tenants before a single assertion is written, and a failure inside `beforeAll` here (rather than inside a `describe` later) is unambiguous. **If the `beforeAll` itself fails**, read which fixture threw: `taxFixture` failing is a 5A reconciliation (Task 0's gate should have caught it); `einvoiceFixture` failing on `postFromPack` is 4B's approval path, and 4B's own Self-Review names it as the first thing to check.

- [ ] **Step 3: The test-26 clause — byte identity with hooks on, and hooks change no number**

Appended to the file:

```ts
describe("acceptance test 26 with the e-invoicing hooks ON (spec:2444, 5B T10)", () => {
  it("generates a byte-identical return twice on the enabled company", async () => {
    const first = await generate(on);
    const second = await generate(on);
    expect(first.row.payloadSha256).not.toBeNull();
    expect(second.row.payloadSha256).toBe(first.row.payloadSha256);
    expect(second.row.payload).toBe(first.row.payload);
  });

  it("produces exactly the same boxes with hooks on as with hooks off", async () => {
    const a = await generate(off);
    const b = await generate(on);
    // `boxes` is `{ code, label, amount }[]` — no id, no timestamp, no tenant. If this differs,
    // the hooks moved a number, which is the one thing this slice promised not to do.
    expect(b.boxes).toEqual(a.boxes);
  });

  it("produces the same payload with hooks on as with hooks off, up to the tenant's own identifiers", async () => {
    const a = await generate(off);
    const b = await generate(on);
    // The two returns are on two tenants, so any uuid the payload embeds necessarily differs. Every
    // OTHER byte must be identical. Normalising uuids is the smallest normalisation that lets the
    // comparison run at all, and it is written out rather than assumed: if this fails, a NON-uuid
    // byte moved and that is the defect.
    const norm = (s: string | null) => (s ?? "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
    expect(norm(b.row.payload)).toBe(norm(a.row.payload));
  });

  it("still ties out to the control accounts to the cent with hooks on", async () => {
    const ctx = ctxOf(on.s);
    const rows = await prodWithTenant(db.rw, ctx, async (tx) => {
      const created = await createTaxReturn(tx, ctx, { companyId: on.s.company, regimeId: on.regimeId, periodStart: "2026-04-01", periodEnd: "2026-06-30" });
      await generateTaxReturn(tx, ctx, created.id);
      return taxReturnTieOut(tx, created.id);
    });
    // An empty quarter ties out at zero; a populated one ties out at zero too. The assertion is the
    // difference column and not the amounts, which is 5A's tie-out contract.
    for (const r of rows) expect(r.difference, r.accountCode).toBe("0.0000");
  });

  it("5A's golden corpus directory is well formed, or this run is explicitly skipped", () => {
    const dir = join(REPO_ROOT, "tests", "golden", "tax");
    if (!existsSync(dir)) {
      // Task 0's gate FAILS on this, so reaching it means the gate was skipped.
      throw new Error("tests/golden/tax/ does not exist — 5A's corpus is missing; run scripts/check/contracts-5b-amendments.sh");
    }
    const cases = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    if (cases.length === 0) {
      console.warn("SKIP: tests/golden/tax/ has no case directories — 5A's Task 9 has not landed its corpus, so test 26's file comparison is not re-run here. The three assertions above still run and are what 5B owes.");
      return;
    }
    for (const name of cases) {
      const input = join(dir, name, "input.json");
      const expected = join(dir, name, "expected.json");
      expect(existsSync(input), `${name}/input.json`).toBe(true);
      expect(existsSync(expected), `${name}/expected.json`).toBe(true);
      const parsed = JSON.parse(readFileSync(expected, "utf8")) as { boxes?: unknown };
      expect(Array.isArray(parsed.boxes), `${name}/expected.json has a boxes array`).toBe(true);
    }
  });
});
```

**Why the fourth `it` generates a *second* quarter rather than reusing the first.** `unique (company_id, regime_id, period_start)` is what stops a period being filed twice (5A), so a second `createTaxReturn` for Q1 would raise `ERR_CONFLICT_UNIQUE`. Q2 is empty of transactions, which is exactly the tie-out's degenerate case and still a real assertion: a tie-out that cannot report zero for an empty quarter is broken for a full one too.

- [ ] **Step 4: The hooks-on coverage clause — one row per opted-in document, none otherwise**

```ts
describe("the e-invoicing hooks themselves (5B T10)", () => {
  it("writes exactly one transmission per posted document of an OPTED-IN type, and none for the rest", async () => {
    // `einvoiceFixture` opts in exactly ONE type — `OPTED_IN_TYPE_CODE`, which is 4A's own
    // `SALES_INVOICE` envelope re-seeded at `policyVersion + 1` — so the expected count is the number
    // of CORPUS rows of that code and NOT `CORPUS.length`. The other three rows are the second gate
    // (`policy.tax.einvoice`) asserted on the SAME enabled company, which is a stronger statement than
    // the disabled-company `it` below: the company is enrolled, the type is not, and nothing is
    // written. Both halves are computed from CORPUS, so neither drifts when a row is added.
    const optedInDocIds = onDocIds.filter((_, i) => CORPUS[i]!.typeCode === OPTED_IN_TYPE_CODE);
    const otherDocIds = onDocIds.filter((_, i) => CORPUS[i]!.typeCode !== OPTED_IN_TYPE_CODE);
    expect(optedInDocIds.length).toBeGreaterThan(0);
    expect(otherDocIds.length).toBeGreaterThan(0);

    const rows = await prodWithTenant(db.rw, ctxOf(on.s), (tx) =>
      listTransmissions(tx, { companyId: on.s.company, limit: 1000 }),
    );
    expect(rows).toHaveLength(optedInDocIds.length);
    expect(new Set(rows.map((r) => r.documentId))).toEqual(new Set(optedInDocIds));
    expect(new Set(rows.map((r) => r.documentId)).size).toBe(rows.length);   // unique (document_id)
    for (const id of otherDocIds) {
      expect(rows.some((r) => r.documentId === id), `${id} is not an opted-in type`).toBe(false);
    }
    for (const r of rows) {
      expect(r.transmitter).toBe("synthetic");
      expect(r.status).toBe("pending");                     // posting writes the row; the JOB moves it
      expect(r.attempts).toBe(0);
      expect(r.externalId).toBeNull();
    }
  });

  it("writes NOTHING at all on the company that has not opted in", async () => {
    const rows = await prodWithTenant(db.rw, ctxOf(off.s), (tx) =>
      listTransmissions(tx, { companyId: off.s.company, limit: 1000 }),
    );
    expect(rows).toEqual([]);
  });

  it("drives every pending row to `accepted` through the synthetic transmitter", async () => {
    const before = await prodWithTenant(db.rw, ctxOf(on.s), (tx) => listTransmissions(tx, { companyId: on.s.company, limit: 1000 }));
    for (const r of before) await onE.driveToAccepted(r.id);
    const after = await prodWithTenant(db.rw, ctxOf(on.s), (tx) => listTransmissions(tx, { companyId: on.s.company, limit: 1000 }));
    for (const r of after) {
      expect(r.status, r.documentId).toBe("accepted");
      expect(r.externalId, r.documentId).not.toBeNull();
      expect(r.acceptedAt, r.documentId).not.toBeNull();
      expect(r.qrPayload, r.documentId).not.toBeNull();
      expect(r.requestSha256, r.documentId).toMatch(/^[0-9a-f]{64}$/);
      expect(r.profileVersion, r.documentId).toBe(1);
    }
  });

  it("moves no ledger row while doing it — a transmission is not a posting", async () => {
    const fingerprint = () =>
      prodWithTenant(db.rw, ctxOf(on.s), async (tx) => {
        const [row] = await tx<{ h: string }[]>`
          select encode(sha256(coalesce(string_agg(
                   l.account_id::text || l.debit::text || l.credit::text || l.effective_date::text,
                   '|' order by l.id), '')::bytea), 'hex') as h
            from app.ledger_entry l`;
        return row!.h;
      });
    // A FRESH document, because the state machine is one-way: `SUBMITTABLE_FROM` is
    // `pending | error | rejected`, so re-driving an already-accepted row raises
    // ERR_EINVOICE_STATUS_ILLEGAL and this test would fail for the wrong reason.
    const { transmissionId } = await onE.postOptedInDocument();
    const before = await fingerprint();            // AFTER the post, so only the transmission is in scope
    await onE.driveToAccepted(transmissionId);
    expect(await fingerprint()).toBe(before);
  });
});
```

**The last `it` is the `posting-only-tables` claim made empirically.** The lint proves no *source file* outside `posting/` and `costing/` writes a ledger table; this proves the e-invoicing path in fact writes none, which is the assertion a reviewer can check without reading the lint's allow-list.

- [ ] **Step 5: The test-13 clause — audit completeness over this slice's surface**

```ts
describe("acceptance test 13 over slice 5B's surface (spec:2431, 5B T10)", () => {
  it("audits every insert and every status update of einvoice_transmission, with a server-supplied actor", async () => {
    const rows = await prodWithTenant(db.rw, ctxOf(on.s), (tx) => listTransmissions(tx, { companyId: on.s.company, limit: 1000 }));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // `app.audit_log`'s primary key is `seq bigint generated always as identity` and the table has
      // NO `id` column (plan 0A) — `order by id` is SQLSTATE 42703. And `app.audit_row()` inserts
      // `lower(tg_op)` under `check (action in ('insert','update','delete'))`, so the labels are
      // lower-case; Task 5's own audit `it` already asserts `["insert","update","update"]`.
      const audit = await db.admin<{ action: string; actor_id: string | null }[]>`
        select action, actor_id from app.audit_log
         where table_name = 'einvoice_transmission' and row_id = ${r.id}
         order by seq`;
      // One insert from step 14, then TWO updates per remote call: `claim` stamps attempts and
      // claimed_at, `record` writes the outcome and releases the claim (ADR 0053). The assertion is
      // deliberately `> 0` and not an exact count — what test 13 requires is that every write is
      // audited under a server-supplied actor, not that a particular number of them happened.
      expect(audit.map((a) => a.action), r.id).toContain("insert");
      expect(audit.filter((a) => a.action === "update").length, r.id).toBeGreaterThan(0);
      for (const a of audit) expect(a.actor_id, `${r.id} ${a.action}`).not.toBeNull();
    }
  });

  it("audits every write of the three company e-invoice columns", async () => {
    const audit = await db.admin<{ action: string; actor_id: string | null }[]>`
      select action, actor_id from app.audit_log
       where table_name = 'company' and row_id = ${on.s.company} and action = 'update'`;
    expect(audit.length).toBeGreaterThan(0);
    for (const a of audit) expect(a.actor_id).not.toBeNull();
  });

  it("app_rw can neither update nor delete an audit row", async () => {
    await expect(
      prodWithTenant(db.rw, ctxOf(on.s), (tx) => tx`update app.audit_log set action = 'X' where table_name = 'einvoice_transmission'`),
    ).rejects.toThrow(/permission denied|ERR_TABLE_IMMUTABLE|ERR_RLS_DENIED/);
    await expect(
      prodWithTenant(db.rw, ctxOf(on.s), (tx) => tx`delete from app.audit_log where table_name = 'einvoice_transmission'`),
    ).rejects.toThrow(/permission denied|ERR_TABLE_IMMUTABLE|ERR_RLS_DENIED/);
  });

  it("app_rw can neither update nor delete a transmission row directly — the log is service-owned", async () => {
    const [r] = await prodWithTenant(db.rw, ctxOf(on.s), (tx) => listTransmissions(tx, { companyId: on.s.company, limit: 1 }));
    await expect(
      prodWithTenant(db.rw, ctxOf(on.s), (tx) => tx`delete from app.einvoice_transmission where id = ${r!.id}`),
    ).rejects.toThrow(/permission denied/);
    // §3.5.4's DELETE list is five tables and this is not one of them (Global Constraint 8): a
    // transmission is CANCELLED, never deleted.
  });

  it("the audit hash chain verifies after everything above", async () => {
    const report = await runIntegrityCheck(db.rw, { tenantId: on.s.tenant, actorId: on.s.system, requestId: await uuidv7(db.admin) });
    expect(report.auditChain.ok, JSON.stringify(report.auditChain)).toBe(true);
    expect(report.mismatches).toEqual([]);
  });

  it("no flag suppresses the audit — nothing in this slice's source names one", () => {
    // `sourceFiles(roots)` returns `scripts/lint/types.ts`'s `SourceFile { path; text; lines }`
    // (§4.17.1), so the text is already read. **Its roots are DIRECTORIES** — 0B's walker calls
    // `readdirSync(join(REPO_ROOT, root))` on each — so a file path may not be passed as a root; the
    // surface is applied afterwards as a path filter.
    const SURFACE = [
      "packages/db/src/einvoice",
      "apps/api/src/routes/accounting/einvoice-transmissions.ts",
      "apps/worker/src/handlers/accounting-tax-submit.ts",
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles(["packages", "apps"]).filter((f) => SURFACE.some((s) => f.path === s || f.path.startsWith(`${s}/`)))) {
      if (/session_replication_role|audit[_a-z]*\s*=\s*(false|off)|disable\s+trigger/i.test(file.text)) offenders.push(file.path);
    }
    expect(offenders).toEqual([]);
  });
});
```

**`runIntegrityCheck`'s exact result shape is 1B's.** If `report.auditChain` is spelled differently in 1B's file, use 1B's spelling and change nothing else — this assertion's content is "the chain verifies", not its field name. That is the one place in this file where a reviewer should reach for 1B's plan rather than reasoning from here.

- [ ] **Step 6: Append the LEGACY-020 block**

`tests/regression/legacy-020.test.ts` — **created by 5A** (§3.7.3 makes the first slice to need a file its creator, and Task 0's gate reports its absence rather than this slice creating it). If the gate said it is missing, **stop and raise with 5A**; do not create it here.

Appended, editing nothing above it. **Add these imports at the top of the file if it does not already carry them** — 5A's own blocks import the first four, so in practice only the last two are new:

```ts
import { withTenant as prodWithTenant } from "@dulja/db";
import { listTransmissions, registerDefaultTransmitters, resetTransmitters } from "@dulja/db";
import { uuidv7, type Seed } from "@dulja/db/test";
import { startStubServer, type StubServer } from "@dulja/db/test/einvoice-stub";
import { postTaxedDocument, taxFixture } from "../invariants/support/tax";
import { einvoiceFixture } from "../invariants/support/einvoice";
```

**Nothing else goes at module scope.** `legacy-020.test.ts` is **5A's file** (§3.7.3) and a second
`ctxOf` or `requestId` at its top level would collide with whatever 5A put there. The two live inside
this slice's own `describe`, below.

```ts
describe("LEGACY-020 — a return names its regime, and the regime is pinned at submission — 5B", () => {
  // LEGACY-020 in the legacy system: tax was recomputed from whatever rate table happened to be current,
  // so a reprint of an old return produced different numbers. 5A pins the regime on the RETURN. This
  // block adds 5B's half: the transmission is pinned to the regime the DOCUMENT carried, so a rate
  // change after transmission cannot move a transmitted invoice either.

  let stub: StubServer;
  // §4.1's `uuidv7(sql: Sql): Promise<string>` is async and takes a `Sql`, so it cannot be called
  // from a synchronous factory. One correlation id is minted in this block's `beforeAll` and reused;
  // a `requestId` is a correlation value, not a row id. BLOCK-SCOPED, because this file is 5A's.
  let requestId: string;
  const ctxOf = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId });

  beforeAll(async () => {
    // The registry and the loopback server, exactly as tests/golden/tax-einvoice.test.ts sets them
    // up: a root `tests/` file starts no entrypoint, so nothing else fills the registry.
    resetTransmitters();
    registerDefaultTransmitters("dev");
    requestId = await uuidv7(db.admin);
    stub = await startStubServer({ submit: { state: "queued", receiptId: "LEGACY020-1" }, poll: { state: "cleared" }, cancel: { state: "withdrawn" } });
  }, 120_000);
  afterAll(async () => { await stub.stop(); });

  it("pins the regime on the document's tax transactions, and transmitting does not consult a rate table", async () => {
    const f = await taxFixture(db, "legacy-020-5b");
    // ONE fixture per tenant. `einvoiceFixture` opts a document type in at `policyVersion + 1`, so
    // calling it twice on one tenant either bumps the version twice or violates the policy's unique
    // key — both are defects and neither is what this test is about.
    const e = await einvoiceFixture(db, f.s);
    const { documentId } = await postTaxedDocument(db, f, { code: "SALES_INVOICE", effectiveDate: "2026-01-15", amount: "1000.0000", kind: "output" });
    const before = await prodWithTenant(db.rw, ctxOf(f.s), async (tx) => {
      const rows = await tx<{ regime_id: string; tax: string }[]>`
        select regime_id, tax::text from app.tax_transaction where document_id = ${documentId} order by line_no`;
      return rows;
    });
    expect(before.length).toBeGreaterThan(0);

    const [t] = await prodWithTenant(db.rw, ctxOf(f.s), (tx) => listTransmissions(tx, { companyId: f.s.company, limit: 1 }));
    await e.driveToAccepted(t!.id);

    const after = await prodWithTenant(db.rw, ctxOf(f.s), (tx) =>
      tx<{ regime_id: string; tax: string }[]>`
        select regime_id, tax::text from app.tax_transaction where document_id = ${documentId} order by line_no`);
    // Transmission is a read of the document. If a tax_transaction row moved, something on the
    // e-invoicing path recomputed tax — which is LEGACY-020 reintroduced through a new door.
    expect(after).toEqual(before);
  });

  it("records the profile version the call was actually made with, so an incident is readable", async () => {
    const f = await taxFixture(db, "legacy-020-5b-version");
    const e = await einvoiceFixture(db, f.s);
    const { transmissionId } = await e.postOptedInDocument();
    await e.driveToAccepted(transmissionId);
    const [row] = await prodWithTenant(db.rw, ctxOf(f.s), (tx) => listTransmissions(tx, { companyId: f.s.company, limit: 1 }));
    expect(row!.profileVersion).toBe(1);
    expect(row!.requestSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 7: Append the LEGACY-019 block**

`tests/regression/legacy-019.test.ts` — created by 0B, appended by 4B and 5A. This slice's block is a **source-fact** block: LEGACY-019 is inconsistent rounding, and the e-invoicing path's whole exposure to it is whether any amount is re-derived on the way to the payload. **Add this import at the top of the file if it does not already carry it** — 0B's own blocks import `sourceFiles` already, and `startDb`/`db` are in the file's `beforeAll`:

```ts
// §4.17.1, owner 0B: `tests/support/source.ts`, reached relatively from `tests/regression/`.
// NOT `@dulja/api/routes`, which §4.2.7 limits to ROUTES / buildRoutes / RouteModule / IdempotencyHeader.
import { sourceFiles } from "../support/source";
```

```ts
describe("LEGACY-019 — no local rounding and no float on the e-invoice path — 5B", () => {
  const SURFACE = [
    "packages/db/src/einvoice",
    "packages/domain/src/tax/einvoice.ts",
    "apps/api/src/routes/accounting/einvoice-transmissions.ts",
    "apps/worker/src/handlers/accounting-tax-submit.ts",
    "packages/contracts/src/accounting/einvoice.ts",
  ];

  it("names no toFixed, no Number(), no parseFloat and no Math.round anywhere on the surface", () => {
    const offenders: string[] = [];
    // `sourceFiles(roots)` walks DIRECTORIES (0B: `readdirSync(join(REPO_ROOT, root))` per root), so
    // the roots are the two workspace trees and SURFACE is applied as a path filter afterwards.
    for (const file of sourceFiles(["packages", "apps"]).filter((f) => SURFACE.some((s) => f.path === s || f.path.startsWith(`${s}/`)))) {
      // `SourceFile { path; text; lines }` (§4.17.1) — `lines` is already the split text, so this
      // loop reads nothing from disk of its own.
      for (const [i, line] of file.lines.entries()) {
        if (/\.toFixed\(|\bparseFloat\(|\bMath\.round\(|\bNumber\(/.test(line) && !line.trimStart().startsWith("//")) {
          offenders.push(`${file.path}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    // Every amount on this path is a Money fixed-scale string taken from LineSnapshot and passed
    // through unchanged (Global Constraint 4). A single Number() here would round MYR 1234.5678 to a
    // double and reintroduce LEGACY-019 at the one place the customer's regulator reads.
    expect(offenders).toEqual([]);
  });

  it("declares no numeric money column and no float column on einvoice_transmission", async () => {
    const cols = await db.admin<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'einvoice_transmission'
       order by column_name`;
    const numeric = cols.filter((c) => ["numeric", "real", "double precision"].includes(c.data_type));
    // The log carries no amount at all: the amounts live on the document it points at, and a second
    // copy is a second thing that can disagree.
    expect(numeric.map((c) => c.column_name)).toEqual([]);
  });
});
```

- [ ] **Step 8: Run everything to green**

```bash
bun run --cwd tests test -- golden/tax-einvoice
bun run --cwd tests test -- regression/legacy-020 regression/legacy-019
bun run --cwd tests test -- invariants/tenant-isolation
bun run typecheck && bun run lint && bun run lint:rules && bun run format:check
```

**Expected:** five `it`s in the test-26 describe (the fifth may log its SKIP line), four in the hooks describe, six in the test-13 describe, two appended to legacy-020 and two to legacy-019 — **nineteen new assertions, none of which existed before this task**. The `beforeAll` takes minutes: it starts a container, posts ten documents and drives five transmissions, which is why its timeout is 600 s and not the default.

- [ ] **Step 9: Commit**

```bash
git add tests/golden/tax-einvoice.test.ts tests/regression/legacy-020.test.ts tests/regression/legacy-019.test.ts
git commit -m "$(cat <<'EOF'
test: acceptance tests 26 and 13 re-run over the e-invoicing hooks [5B T10]

Two tenants, one corpus, one difference: B has einvoice_transmitter set. The
return's boxes are equal and its payload is equal up to the tenants' own uuids --
hooking transmission onto postDocument moves no number. B alone generates twice
byte-identically, which is test 26 with the hooks on.

Test 13 over the new surface: every insert and status update of
einvoice_transmission and every write of the three company columns is audited
under a server actor, app_rw can neither update nor delete an audit row nor
delete a transmission, the chain verifies, and no source file on the path names a
suppression flag.

The legacy-020 append proves transmitting recomputes no tax and pins the profile
version; the legacy-019 append proves no toFixed, Number, parseFloat or Math.round
exists on the path and the log carries no money column at all.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Phase 5 exit — the re-runs, the pinned equalities, the CI wiring, the staging re-seed and `AGENTS.md`

**A phase-closing task, and §3.8 names 5B as one.** It adds one new assertion of its own (the hazard-2 grep in CI) and otherwise **re-asserts equalities other slices pinned** — which is exactly what a phase gate is for and is stated here rather than left for a reviewer to notice that Steps 2–4 write no new logic. The one thing it must not do is *change* anything to make a check pass: a red check here is a defect in an earlier task, and the fix goes there.

**Files:**
- Create: `docs/review/2026-09-05-phase-5-exit.md`
- Create: `tests/invariants/phase-5-exit.test.ts`
- Modify: the CI workflow that runs `bun run lint:rules` — one step
- Modify: `AGENTS.md` — the "Current phase" section only

**Interfaces**

- Consumes: `lintSchema`, `listApplied` from **`@dulja/db`**'s main barrel and `startDb`, `Db` from **`@dulja/db/test`** (§4.1, §4.2.12 — the two barrels carry different names and this file uses both); `ROUTES` from `@dulja/api/routes` and `PROBES`, `TENANT_FREE`, **`JOB_PROBES`** from `tests/invariants/probes.ts` (§4.2.7, §4.2.6, §3.7.2); `JOBS` from `@dulja/db` and **`registeredJobNames` from `@dulja/worker/handler`** (§4.2.6 — the two live in different workspaces and neither is a `@dulja/db` export; 0D's `job-isolation.test.ts` imports them this way); `PERMISSIONS` (§4.2.5), `ROLES` (`packages/db/seed/roles.ts`, §3.6.4); `REPO_ROOT`, `sourceFiles` from `tests/support/source.ts` (§4.17.1, owner 0B). **`repoFile` is not consumed** — it returns text, and this file tests presence with `node:fs`.
- Produces: **no exported name and no runtime behaviour.** One test file, one CI step, one review document, one `AGENTS.md` section.

- [ ] **Step 1: Write the phase-exit test file**

`tests/invariants/phase-5-exit.test.ts`:

```ts
// tests/invariants/phase-5-exit.test.ts (5B T11)
//
// Phase 5's exit gate. Every assertion here re-states an equality some earlier slice pinned; none of
// them is new logic. A failure is a defect in the task that owns the pinned thing, NOT something to
// fix here.

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
// `lintSchema` and `listApplied` are MAIN-barrel exports of @dulja/db (§4.1); `@dulja/db/test` is
// exactly `export * from "./harness"; export * from "./fixtures";` (§4.2.12) and carries neither.
import { JOBS, lintSchema, listApplied } from "@dulja/db";
import { startDb, type Db } from "@dulja/db/test";
import { PERMISSIONS } from "@dulja/contracts";
import { ROUTES } from "@dulja/api/routes";                         // §4.2.7: the module's two entry points
// §4.2.6 puts `registeredJobNames()` in `apps/worker/src/handler.ts` and `JOB_PROBES` in
// `tests/invariants/probes.ts` — NEITHER is a `@dulja/db` export, whose job surface is `JOBS`,
// `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `EnqueueOptions`, `createJobClient` and
// `JOB_NAMES`. 0D's own `tests/invariants/job-isolation.test.ts` imports them exactly this way
// (`@dulja/worker/handler` and `./probes`), which is the precedent this file follows rather than
// inventing a second route to either name.
import { registeredJobNames } from "@dulja/worker/handler";
import { ROLES } from "../../packages/db/seed/roles";
import { JOB_PROBES, PROBES, TENANT_FREE } from "./probes";         // §4.2.6, §4.2.7: both registries live in the test tier
import { REPO_ROOT, sourceFiles } from "../support/source";         // §4.17.1, owner 0B

let db: Db;
beforeAll(async () => { db = await startDb(); }, 300_000);
afterAll(async () => { await db.stop(); });

describe("Phase 5 exit — schema (5B T11)", () => {
  it("lintSchema reports zero violations across all fifty-eight migrations", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("the applied migration ledger starts at 0001, strictly ascends, and reaches 0058", async () => {
    // §4.1 fixes `listApplied(sql: Sql): Promise<number[]>` — a list of VERSION NUMBERS, not rows.
    const versions = [...(await listApplied(db.admin))].sort((x, y) => x - y);
    expect(versions[0]).toBe(1);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `${versions[i]} is not above ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]!);
    }
    // NO no-gap assertion. §3.4.1 says in terms that "unused numbers stay unused (gaps are fine —
    // `discover()` sorts whatever exists)", and two numbers in 0001–0058 are reserved with no DDL:
    // 0009 (0C) and 0010 (0E), neither of which ships a file. A no-gap loop would fail on a correct
    // repository, which is the worst kind of gate.
    expect(versions[versions.length - 1]).toBeGreaterThanOrEqual(58);
    expect(versions).toContain(57);
    expect(versions).toContain(58);
  });

  it("the pinned app_rw DELETE list is UNCHANGED by slice 5B", async () => {
    const rows = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and privilege_type = 'DELETE' and table_schema = 'app'
       order by table_name`;
    // §3.5.4, after migration 0023. 2B is the only slice that ever extends this list, and 5B is not
    // 2B: a transmission is cancelled (spec:2049), never deleted.
    expect(rows.map((r) => r.table_name)).toEqual([
      "document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission",
    ]);
  });

  it("einvoice_transmission has forced RLS and a policy named exactly tenant_isolation", async () => {
    const [t] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class
       where oid = 'app.einvoice_transmission'::regclass`;
    expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await db.admin<{ policyname: string }[]>`
      select policyname from pg_policies where schemaname = 'app' and tablename = 'einvoice_transmission'`;
    expect(policies.map((p) => p.policyname)).toEqual(["tenant_isolation"]);
  });
});

describe("Phase 5 exit — registries (5B T11)", () => {
  it("every route module has a probe and every probe names a route (test 12)", () => {
    const paths = new Set(ROUTES.map((r) => r.path));
    for (const r of ROUTES) {
      if (TENANT_FREE.has(r.path)) continue;
      expect(Object.keys(PROBES), `no PROBES entry for ${r.path}`).toContain(r.path);
    }
    for (const key of Object.keys(PROBES)) {
      expect(paths, `PROBES key ${key} matches no route`).toContain(key);
    }
  });

  it("einvoice-transmissions is the ONE module slice 5B added", () => {
    const fiveB = ROUTES.filter((r) => r.path.endsWith("/einvoice-transmissions"));
    expect(fiveB).toHaveLength(1);
    expect(fiveB[0]!.permissions).toEqual(["accounting.tax.file"]);
    expect(fiveB[0]!.auth).toBe("human");
  });

  it("every registered job name has a JOB_PROBES entry (test 12's job half)", () => {
    for (const name of registeredJobNames()) {
      expect(Object.keys(JOB_PROBES), `no JOB_PROBES entry for ${name}`).toContain(name);
    }
    expect(Object.keys(JOBS)).toContain("accounting.tax.submit");
  });

  it("accounting.tax.file is in the catalogue exactly once, phase 5B, and is granted only to accountant (test 36)", () => {
    const rows = PERMISSIONS.filter((p) => p.code === "accounting.tax.file");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ module: "accounting", mutating: true, phase: "5B" });
    const holders = ROLES.filter((r) => r.code !== "admin" && r.permissions.includes("accounting.tax.file")).map((r) => r.code);
    expect(holders).toEqual(["accountant"]);
  });
});

describe("Phase 5 exit — hazard 2 and no SQL text (5B T11)", () => {
  it("the hazard-2 grep is green (no authority literal outside a profile, ADR 0051 or a test)", () => {
    // Runs the same script CI runs. A non-zero exit throws with the script's own output attached,
    // which names the offending file and line.
    const out = execFileSync("bash", ["scripts/check/no-authority-literals.sh"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(out).toContain("hazard-2 check OK");
  });

  it("no sql.unsafe and no string-built SQL exists in this slice's surface (test 27)", () => {
    // §4.17.1: `sourceFiles(roots?)` walks the repository and returns `scripts/lint/types.ts`'s
    // `SourceFile { path; text; lines }` — the text is already read, so nothing here calls
    // `readFileSync` on the result.
    // **Roots are DIRECTORIES.** 0B's walker calls `readdirSync(join(REPO_ROOT, root))` on each root,
    // so a file path passed as a root throws ENOTDIR. Walk the two workspace trees and filter.
    const SURFACE = [
      "packages/db/src/einvoice",
      "apps/api/src/routes/accounting/einvoice-transmissions.ts",
      "apps/worker/src/handlers/accounting-tax-submit.ts",
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles(["packages", "apps"]).filter((f) => SURFACE.some((s) => f.path === s || f.path.startsWith(`${s}/`)))) {
      if (/sql\.unsafe|tx\.unsafe/.test(file.text)) offenders.push(`${file.path}: unsafe`);
      // A tagged template never concatenates; a `${}` inside a plain string that reaches a query does.
      if (/`\s*select[^`]*"\s*\+/i.test(file.text)) offenders.push(`${file.path}: concatenation`);
    }
    expect(offenders).toEqual([]);
  });

  it("the ADR 0051 gate holds: a myinvois profile implies ADR 0051 exists, and vice versa", () => {
    // §4.17.1's `repoFile(relativePath): string` READS a file as text and has no `exists` member, so
    // presence is tested with `node:fs` against `REPO_ROOT` — Vitest runs the `tests` workspace from
    // `tests/`, which is why the join is against `REPO_ROOT` and not a bare relative path.
    const profile = existsSync(join(REPO_ROOT, "packages/db/einvoice-profiles/myinvois.v1.json"));
    const adr = existsSync(join(REPO_ROOT, "docs/adr/0051-verified-lhdn-myinvois-requirement-set.md"));
    // Both present (OD-15 discharged, Task 9 ran) or both absent (OD-15 pending). Never one.
    expect(profile, "a myinvois profile with no ADR 0051 is an invented value").toBe(adr);
  });
});
```

**Every import in this file resolves to a name some earlier slice actually exports, and the four that a reviewer should re-check are named here.** `lintSchema` and `listApplied` come from `@dulja/db`'s main barrel (§4.1), never from `@dulja/db/test`, whose whole content §4.2.12 fixes as `harness` + `fixtures`. `ROUTES` comes from `@dulja/api/routes`, which §4.2.7 limits to `ROUTES`, `buildRoutes`, `RouteModule` and `IdempotencyHeader` — `PROBES`, `TENANT_FREE` **and `JOB_PROBES`** are *test-tier* names and live in `tests/invariants/probes.ts` beside this file, and `REPO_ROOT`/`sourceFiles` in `tests/support/source.ts` (§4.17.1, owner 0B). **`registeredJobNames` is `apps/worker/src/handler.ts`'s** (§4.2.6) and is reached through the `@dulja/worker/handler` subpath — an earlier draft of this file imported it and `JOB_PROBES` from `@dulja/db`, which exports neither. **0D's own `tests/invariants/job-isolation.test.ts` is the working precedent for all four imports** (`JOBS` from `@dulja/db`, `registeredJobNames` from `@dulja/worker/handler`, `JOB_PROBES` from `./probes`, `startWorker` from `@dulja/worker/test-support`), and `tests/invariants/tenant-isolation.test.ts` is the precedent for the route half.

- [ ] **Step 2: Wire the hazard-2 grep into CI**

Find the workflow that already runs the custom lints:

```bash
grep -rn "lint:rules" .github/workflows/
```

Add one step immediately after it, in that same job:

```yaml
      - name: Hazard 2 — no invented authority literal
        run: bash scripts/check/no-authority-literals.sh
```

**This is the one genuinely new check this task adds, and it must run on every PR for ever, not just during Phase 5.** The failure mode it guards is a Phase 6 or Phase 10 engineer adding a "helpful" constant with a plausible LHDN field name — which is precisely the shape spec:2467 warns about and which no test of any slice would otherwise catch. `contracts-5b-amendments.sh` is **not** added to CI: it is a one-time pre-flight and Task 0 says so.

- [ ] **Step 3: Run the whole Phase 5 gate**

```bash
bun run --cwd tests test -- invariants/phase-5-exit
bun run --cwd tests test -- invariants/tenant-isolation
bun run --cwd tests test -- golden/tax golden/tax-einvoice
bun run --cwd tests test -- regression/
bun run --cwd packages/db test
bun run --cwd apps/api test
bun run --cwd apps/worker test
bun run typecheck && bun run lint && bun run lint:rules && bun run format:check
bash scripts/check/no-authority-literals.sh
bun run --cwd packages/contracts openapi:generate && git diff --exit-code packages/contracts/openapi.json
```

**Expected:** every suite green; `git diff --exit-code` silent (the generator is deterministic and Task 8 already committed its output — a diff here means a route changed after that commit). **5A's own golden suite runs in this list with the hooks compiled in but no company enabled**, which is the "hooks off" half of the card's *"keeps 5A's DoD green with hooks enabled"*; Task 10's file is the "hooks on" half.

- [ ] **Step 4: The staging re-seed (hazard 5's pattern)**

> **Owner provides:** the Supabase staging project and its `app_rw` credential (OD-19, already discharged in 0C) and, if OD-15 has been answered, `EINVOICE_CLIENT_SECRET` as a Cloudflare secret binding on the staging container.
> **Verify:**
> ```bash
> DATABASE_URL_MIGRATOR="$STAGING_MIGRATOR_URL" bun run --cwd packages/db migrate
> DATABASE_URL="$STAGING_URL" bun run --cwd packages/db seed --tenant "$STAGING_TENANT" --only document-types
> DATABASE_URL="$STAGING_URL" bun run --cwd packages/db seed --tenant "$STAGING_TENANT" --only tax
> STAGING_BASE_URL="$STAGING_BASE_URL" bun run --cwd tests test -- staging
> bun run --cwd packages/db einvoice:verify --profile synthetic
> ```
> prints migrations `0057` and `0058` applied, the two seed runs reporting their row counts, the staging suite green, and the four `einvoice:verify` lines.
> **Until provided:** the identical sequence against `startDb()` with `STAGING_BASE_URL` unset — the staging Vitest project skips itself entirely (§3.7.1) and the other four commands are exactly the ones every task of this plan has already run. **This step never blocks the merge**; it is the deployment rehearsal, and a staging failure is a 0C wiring finding.

**Do not run `einvoice:verify --profile myinvois` against staging unless OD-15 has been discharged AND the owner has confirmed the sandbox environment is the target.** A verification probe against a production authority endpoint is a real request from a real credential.

- [ ] **Step 5: Write the phase-exit review document**

`docs/review/2026-09-05-phase-5-exit.md`:

```markdown
# Phase 5 exit review — tax engine, Malaysia pack, e-invoicing hooks

**Slices:** 5A (tax engine, jurisdiction pack, returns) and 5B (e-invoicing hooks, the transmitter).
**Migrations:** 0053–0058, six files, six PRs, each with a hand-written down.
**ADRs:** 0049–0050 (5A), 0051–0053 (5B). 0051 is the OD-15 record.

## The definition of done (spec:2291), clause by clause

| Clause | Evidence |
|---|---|
| "The return is generated…" | `generateTaxReturn` reads `app.tax_transaction` and nothing else; 5A's golden suite |
| "…validated…" | `malaysiaPack.validateReturn(payload)` runs inside `generateTaxReturn` |
| "…and reconciled end-to-end against a golden fixture" | `taxReturnTieOut` against `account_balance` on `2300` / `1350`; `tests/golden/tax/` |
| "…with hooks enabled" (5B's share) | `tests/golden/tax-einvoice.test.ts`: same boxes, same payload, byte-identical regeneration, one transmission per opted-in document and zero otherwise |

## Acceptance tests

| # | Status | Where |
|---|---|---|
| 26 | re-run with hooks on | `tests/golden/tax-einvoice.test.ts` |
| 13 | re-run over `einvoice_transmission` and the three `company` columns | same file |
| 12 | re-run: one new module, one new probe, one new job probe, two new tables' worth of RLS | `tests/invariants/tenant-isolation.test.ts`, `phase-5-exit.test.ts` |
| 27 | re-run: no `sql.unsafe`, no concatenation on the new surface | `phase-5-exit.test.ts` |
| 36 | re-run: `accounting.tax.manage` (5A) and `accounting.tax.file` (5B) in the catalogue, granted to `accountant` only | `phase-5-exit.test.ts` |
| 15 | re-run by 5A: four document types gained tax through a seed PR and no TypeScript change | 5A |

## What is deliberately not built

No e-invoicing screen (OD-24 not engaged — this slice ships no UI). No e-invoicing report code
(§4.16.1 is closed for v1 and has no row; the log is read through its own route module). No
`DatasetId` member for `einvoice_transmission` (contracts amendment 12). No GCC/ZATCA pack (spec:2226
defers it until a customer there exists). No second transmitter code beyond `synthetic | myinvois`.

## The state of OD-15 at exit

<one of: "discharged — ADR 0051 accepted on <date>, myinvois registered" | "pending — the abstract
interface only; `synthetic` is the sole registered transmitter and any `myinvois` company's
transmissions stay `pending` with `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` in `last_error`">

## What Phase 6 and later inherit

- **`postDocument` step 14 is now fully occupied.** 3B put `inventory.cost.replay` in it and 5B put
  `accounting.tax.submit` beside it. A slice adding a third enqueue adds a clause, never a parameter.
- **`tax.einvoice` on the policy is the zero-code home for "which types transmit".** 6A's `POS_TICKET`
  transmits by setting it in the seed file, with no code change anywhere.
- **`createHttpTransmitter` + a profile file is the shape for any future authority integration.** A
  GCC pack is one profile, two functions and one `TransmitterCode` label.
- **`registerReconcilableSource` is untouched by this phase** — a transmission is not a cash movement.
```

- [ ] **Step 6: Rewrite `AGENTS.md`'s "Current phase" section**

Replace **only** that section — §3.8 makes the phase-closing slice responsible for it and nothing else in the file:

```markdown
## Current phase

**Phase 5 is complete.** Phases 0–5 have merged: foundations, ledger, parties and documents,
inventory, AR/AP, and tax with e-invoicing hooks. Migrations 0001–0058 are applied. **Next: Phase 6
(POS), whose first slice is 6A** — the sync protocol, terminal identity, up-sync apply and
`POS_TICKET`. Phase 6 depends on Phases 1–5 and could not have started earlier (spec:2299).

**Two things a Phase 6 engineer needs from Phase 5 on day one.**

1. **`POS_TICKET` transmits by configuration, not by code.** If ADR 0051 §6 covers retail tickets,
   set `"einvoice": true` in the `tax` block of `POS_TICKET.json`'s policy. No TypeScript changes.
2. **`accounting.tax.submit` is a per-transmission job with `singletonKey = transmissionId`.** A POS
   ticket posted offline and synced later gets its transmission at apply time, through the same
   step 14 as every other document; nothing in `packages/sync` needs to know e-invoicing exists.

**The one rule that outlives this phase:** no LHDN or MyInvois endpoint, field name, schema version,
threshold or deadline may be written anywhere except a profile file under
`packages/db/einvoice-profiles/`, ADR 0051, or a test. `scripts/check/no-authority-literals.sh` runs
on every PR and fails the build (spec:2226, 2467).
```

- [ ] **Step 7: Commit**

```bash
git add tests/invariants/phase-5-exit.test.ts .github/workflows/ \
        docs/review/2026-09-05-phase-5-exit.md AGENTS.md
git commit -m "$(cat <<'EOF'
chore: Phase 5 exit gate [5B T11]

Re-asserts the equalities earlier slices pinned -- lintSchema at zero, the
applied migration ledger strictly ascending from 0001 and reaching 0057 and 0058
(gaps are legal per contracts 3.4.1, so no no-gap loop), the app_rw DELETE list
unchanged at five tables,
forced RLS and a policy named tenant_isolation on the one new table, every route
module probed and every job probed, accounting.tax.file in the catalogue once and
granted to accountant only, and the myinvois-profile-implies-ADR-0051 gate.

The one new check is scripts/check/no-authority-literals.sh in CI, on every PR
for ever: the failure it guards is a later engineer adding a plausible-looking
LHDN constant, which no other test would catch.

AGENTS.md's Current phase section moves to Phase 6 and hands 6A the two facts it
needs about transmission on day one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Against the contracts card (§2.6's 5B row).** Every deliverable the card lists has a task. The `EInvoiceTransmitter` abstract interface of §4.9.3 — document hash, QR payload, `submit`, `poll`, `cancel` — copied character for character with `canonicalJson` beside it (**T3**) and implemented by `createHttpTransmitter` over a profile (**T4**); `app.einvoice_transmission` with §4.9.3's column list plus amendment 6's **four** (`profile_version`, `qr_payload`, `polled_at`, `claimed_at`), carrying retry and spec:2225's status reconciliation (**T1**, **T5**); `accounting.tax.file` (**T2**, referenced by a handler in **T8**); the `accounting.tax.submit` pg-boss job with `retryLimit 8` and exponential backoff (**T7**); the MyInvois adapter implemented **only** from ADR 0051, in one isolated task (**T9**); test 26 re-run with hooks on and the transmission log audited under test 13 (**T10**). Migration range **0057–0058, both used, two PRs**; ADR range **0051–0053, all three written** — 0052 and 0053 as proposals per spec:95, 0051 as the OD-15 record. **Card target size 7–9 tasks; this plan has 12, and Task 0 amendment 11 changes the card rather than leaving the deviation unrecorded** — the card's estimate assumed every task after the first was OD-15-gated, and the profile design makes eleven of the twelve runnable and CI-green before OD-15 lands.

**This plan is longer than the 2500–4000-line guidance — about 8,100 lines — and the reason is recorded rather than hidden.** Seven of the twelve tasks carry a complete module in full: the domain port and its JSON Schema, six modules under `packages/db/src/einvoice/`, migration 0057's DDL with its down, the worker handler, the route module and the three test files of Task 10. Hazard 35 requires the plan to repeat that code rather than gesture at it, and the written peer plans in this folder run 5,400–8,400 lines for the same reason. **About 2,600 of those lines were added by the finishing pass** (Tasks 8–11, the Self-Review and this handoff); nothing was padded — every paragraph of prose either states a decision a reviewer must be able to check or names a trap.

**Six things the finishing pass changed, all of which were latent in the file before it, and all six because 5A's plan file now exists and was read.**

1. **`accounting.tax.file` had a permission and no filing action.** 5A's Task 8 says in terms that `generated → filed` is 5B's transition and that 5A writes neither `filed_at` nor `attachment_id`. Without Task 8 Step 7, `tax_return.status`'s third CHECK label and its `filed_at` column would be unreachable from any code path in the repository — dead vocabulary, which spec:2045 forbids — and `accounting.tax.file`'s only handler would have been an e-invoice resubmit button, which is not what spec:2158's "tax returns" means. `fileTaxReturn` and one sub-path now exist.
2. **Amendment 7 said this slice touches no 5A module, and that had become false.** The `/file` sub-path mounts on 5A's `taxReturnRoutes`. **Amendment 13 records it and supersedes that sentence**, and it does so explicitly rather than silently, because a reader comparing the two would otherwise find a contradiction and not know which won.
3. **Global Constraint 9's closed error list was missing the code Task 8 raises.** 5A's `returns.ts` refuses a wrong tax-return state with `PostingError("ERR_DOC_STATUS_ILLEGAL", …)`; reusing it was the right call (one language for the two transitions of one row) but it made the "closed list" wrong, and a wrong closed list is worse than no list. `ERR_DOC_STATUS_ILLEGAL` and `ERR_IDEMPOTENCY_KEY_MISSING` are on it now, each with its reason.
4. **`cancelTransmission` needs the pool and no route could reach one.** §4.2.3's `Variables` had eight members after 3B's A5 and none of them is `db`. The alternatives were a factory module (widening `buildRoutes`' deps, which 2C already widened once) or holding a transaction open across a call to a tax authority — the longest transaction in the system, and precisely what spec:1368 forbids. Amendment 13 adds the ninth member with a one-file `no-bare-db` allow-list entry, and Task 8 states the alternative it rejected.
5. **Task 2 could not commit anything, and the plan said it could.** The earlier draft committed migration 0058 alone, on the stated grounds that "`app.permission` rows referenced by nothing break no build check". §3.6.3 says the opposite in terms — `permission-catalogue.test.ts` compares `app.permission` and `permissions.ts` **in both directions** — so that commit is red on the table→catalogue side. Each of the other three files is red on its own too (`permissions.ts` on the `permission-catalogue` lint, `roles.ts` on `role-seed`), which means **no proper subset of Task 2's four files is green**. Task 2 now produces no commit; all four land in Task 8's PR, where 0058 is still the only migration (§3.4.3), and Task 2 Step 5 carries the table of which check each subset breaks. Task 7 Step 7's and Task 8 Step 10's `lint:rules` notes were rewritten to match.
6. **Task 0's gate checked nine 5A names and the later tasks import several more.** `generateTaxReturn`, `createTaxReturn`, `getTaxReturn`, `taxReturnTieOut`, `TaxReturnDetail`, `TAX_PERMISSION`, `taxReturnRoutes`, `taxFixture` and `postTaxedDocument` are all named now, as are 4B's `PACK_DIR` and its `computeTax` option, so a rename in 5A or 4B is found by a shell script before a line of 5B is written rather than at `bun run typecheck` two tasks later. **The gate no longer reports a name COUNT at all** — the earlier "eighteen consumed names" was arrived at by counting eight function names plus five structural checks in the 5A group and calling it thirteen, which nobody could reproduce, and the third group's single entry was 3B's while its banner said 4B. The banners now name the owning slice and the closing line says "every consumed name present". The amendment count (thirteen) and the pre-edit failure count (twenty-two `MISSING`, one per `need_contract` call) are both reproducible and both kept.

**Eight things the independent audit pass found and this file now fixes, listed because each was a plan that would not have compiled or would have passed for the wrong reason.**

1. **The stub's `process.env` injection never reached `readSecret`.** `call()` resolves the secret BEFORE it builds the headers and before it invokes `fetchImpl`, so a `fetch` wrapper that set `process.env` inside its own body ran strictly too late: every successful-call test in Tasks 4, 5, 7, 8 and 10 would have thrown `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE`, and the one test asserting that failure would have passed for the wrong reason. **`HttpTransmitterOptions` and `createSyntheticTransmitter` now take `env?`**, forwarded to `readSecret`; the stub's `fetchWithEnv` is gone and `abortingFetch(ms)` — the only `fetchImpl` any test now injects — keeps the timeout case. No test mutates `process.env`, so two Vitest files in one worker cannot leak a secret into each other. Contracts amendment 5's signature and Task 0's gate literal changed together.
2. **Task 3 compiled a draft-2020-12 schema with Ajv's draft-07 default export.** `einvoice-profile.schema.json` declares `$schema: …/2020-12` and uses `$defs`; `new Ajv(…).compile(schema)` throws at module load and takes every importer of the tax barrel with it. It is `ajv/dist/2020` now, which is what 1A, 5A, 7A and 8A all import — the prose already claimed parity with 1A and the code did not have it.
3. **A refusal raised between the claim and the call left `claimed_at` standing.** `credentialsFor`, `transmitterFor`, `loadSnapshot` and the canonicaliser all ran outside the `try` that calls `recordFault`, so pg-boss's 60-second retry arrived inside the 120-second claim window, `claim()` refused it, and the handler completed the job on a row abandoned at `pending` — verbatim the failure ADR 0053 §3 says cannot happen, and the state every `myinvois` company is in before OD-15. All three verbs now resolve inside the `try`, and Task 5 has a sixteenth `it` asserting `claimedAt` is null and the immediate retry is admitted.
4. **Task 8 called `seedTenantV2` and `grantCodes` with the wrong signatures** — four nameless `seedTenantV2(api.db)` calls against §4.17's required-name form, and two bare arrays against `grantCodes(db, s, { codes })`. Task 6 of this same plan already used both correct forms.
5. **The `/file` route answered a body 5A's `TaxReturnDetail` rejects** — `{ row, boxes, tieOut: [] }` against a five-member schema whose entity key is `taxReturn` and which also carries `payload` and `currency`. Self-Review item 4 had flagged the risk and resolved it wrongly; it is resolved from 5A's own handlers now.
6. **Task 9's `myinvois.ts` read a `DocumentSnapshot` that does not exist** — `doc.number`, `doc.currency`, `doc.effectiveDate` and `doc.id` at the top level where §4.4.2 nests them under `header`, `line.taxCode` where a `LineSnapshot` carries only `taxCodeId` and the `TaxCodeRef` lives in `refs.taxCodes`, and an instance `amount.zero()` where `Money` declares only the static `Money.zero(currency)`. `RegisteredTransmitter` was used as a return type and never imported. The two test snapshots were flat literals that would have thrown inside `headerValue` before reaching an assertion; they are built from §4.17.1(a)'s `snapshotFixture()` now.
7. **Task 11 imported `JOB_PROBES` and `registeredJobNames` from `@dulja/db`, which exports neither** — §4.2.6 puts the first in `tests/invariants/probes.ts` and the second in `apps/worker/src/handler.ts`. The auditor proposed dropping the `registeredJobNames()` loop; that was rejected on evidence, because **0D's own `tests/invariants/job-isolation.test.ts` imports it from `@dulja/worker/handler` from inside `tests/`** — the precedent exists and the loop is the assertion that matters.
8. **Task 1's unique-violation `it` rolled back the row the next `it` counts.** Both inserts were in one `withTenant`; the violation aborts the transaction, Postgres turns the COMMIT into a ROLLBACK, and "a second tenant cannot see it" would have read 0 where it expects 1 — the hazard this file diagnoses three `it`s earlier and then reintroduced. Two blocks now, with a third asserting the first row survived.

**Four smaller corrections in the same pass, each verified against the owning plan rather than against this one.** 4B's helper is **`PACK_DIR`**, not `PACK_ROOT` (4B's own amendment 9 says so in terms), and its fixture exposes **`partyIds.customer`**, not a `customerId` member; 5A's **`postTaxedDocument` takes `typeCode` and `TaxedLine[]`**, not `{ code, amount, kind }`; `einvoiceFixture` opts in **one** document type, so Task 10's "one row per corpus document" now counts the `SALES_INVOICE` rows and asserts the other three have none — a stronger statement, because it is the second gate observed on an ENROLLED company; and Task 10's audit assertions used `order by id` (`app.audit_log` has `seq` and no `id`) with upper-case `INSERT`/`UPDATE` (`app.audit_row()` inserts `lower(tg_op)`), which Task 5's own audit `it` in this same plan already had right.

**Contract additions — every name invented because the registers lacked one.** All **thirteen** register amendments land in **Task 0**; nothing below is a literal in a registered namespace, and this slice writes into **none** of the five (no document-type code, no account code, no report code, no `DatasetId` member, no `fixtures.ts` helper).

- `packages/domain/src/tax/einvoice.ts` (**T3**) — `TRANSMISSION_STATUSES`, `isTransmissionStatus`, `Canonicaliser`, `QrPayloadBuilder`, `canonicalJson`, `CanonicalJsonError`, `EInvoiceCallName`, `EInvoiceBodyKind`, `EInvoiceCallSpec`, `EInvoiceAuthSpec`, `EInvoiceProfile`, `EInvoiceProfileError`, `parseProfile`, `resolvePointer`, `renderPath`, `mapRemoteStatus`; and the file `packages/domain/einvoice-profile.schema.json` (amendment 5). §4.9.3's five declarations are **implemented verbatim and are not additions**.
- `packages/db/src/einvoice/` (**T4**, **T5**, **T8**, **T9**) — `profile.ts`: `PROFILE_DIR`, `profilePath`, `loadProfile`, `availableProfileVersions`, `ProfileNotFoundError`. `credentials.ts`: `EINVOICE_SECRET_NAMES`, `EInvoiceSecretName`, `CompanyEInvoiceSettings`, `credentialsFor`, `readSecret`. `redact.ts`: `REDACTED`, `redactResponse`. `http-transmitter.ts`: `HttpTransmitterOptions`, `RemoteCallResult`, `RegisteredTransmitter` (its **one** declaration), `createHttpTransmitter`, `TransientTransmissionError`. `synthetic.ts`: `SYNTHETIC_PROFILE_CODE`, `syntheticCanonicalise`, `syntheticQrPayload`, `createSyntheticTransmitter`, `sha256Hex`. `registry.ts`: `TransmitterCode`, `TRANSMITTER_CODES`, `registerTransmitter`, `transmitterFor`, `registeredTransmitters`, `resetTransmitters`, `registerDefaultTransmitters` (it **imports** `RegisteredTransmitter` as a type and re-declares nothing). `errors.ts`: `EInvoiceErrorCode`, `EInvoiceError`. `transmission.ts`: `EinvoiceTransmissionRow`, `SUBMITTABLE_FROM`, `POLLABLE_FROM`, `CANCELLABLE_FROM`, `CLAIM_WINDOW_SECONDS`, `recordPending`, `getTransmission`, `ListTransmissionsInput`, `listTransmissions`, `submitTransmission`, `pollTransmission`, `cancelTransmission`, `companySettings`. `settings.ts` (**T8**): `WriteEinvoiceSettingsInput`, `writeEinvoiceSettings`. `verify.ts` (**T4**, not T9 — it is not OD-15 content and Task 11's hazard-5 fallback needs it to exist while OD-15 is pending): `VerifyResult`, `verifyProfile`, `formatVerifyResult`. ⚠️ `myinvois.ts` (**OD-15, dropped with T9**): `MyInvoisFieldRow`, `MYINVOIS_FIELDS`, `MYINVOIS_QR_FIELDS`, `myinvoisCanonicalise`, `myinvoisQrPayload`, `createMyInvoisTransmitter`, and the file-local `MyInvoisMappingError`, `headerValue`, `partyValue`, `lineValue`. Plus `index.ts`, the barrel `packages/db/src/index.ts` re-exports.
- `packages/db/src/tax/returns.ts` (**5A's file**, **T8**) — **one function appended, nothing existing edited**: `FileTaxReturnInput`, `fileTaxReturn`.
- `packages/db/src/jobs/payloads.ts` (**T7**) — **one key**, `"accounting.tax.submit": { transmissionId; phase }` (amendment 2). `JOBS` itself is not edited.
- `packages/db/src/schema/einvoice-transmission.ts` (**T1**) — the Drizzle mirror `einvoiceTransmission`; three fields appended to `schema/company.ts`.
- `packages/db/einvoice-profiles/` (**T4**, **T9**) — the directory itself (amendment 5, deliberately outside `packages/db/seed/`), `README.md`, `synthetic.v1.json`, and ⚠️ `myinvois.v1.json` (**OD-15**).
- `packages/contracts/src/accounting/einvoice.ts` (**T8**) — `TransmissionStatusSchema`, `TransmitterCodeSchema`, `EinvoiceSecretNameSchema`, `EinvoiceTransmissionSchema`, `EinvoiceTransmissionDto`, `EinvoiceTransmissionList`, `EinvoiceTransmissionQuery`, `CancelTransmissionBody`, `SubmitAcceptedSchema`, `EinvoiceSettingsSchema`, `EinvoiceSettingsDto`, `EinvoiceSettingsBody`. `src/accounting/tax.ts` (**5A's file**) — `FileTaxReturnBody` appended. `src/errors.ts` — the three `ERR_EINVOICE_*` rows (amendment 1). `permissions.ts` — `accounting.tax.file`.
- `apps/api` (**T8**) — `src/routes/accounting/einvoice-transmissions.ts`: `EINVOICE_PERMISSION`, `einvoiceTransmissionRoutes`, `einvoiceTransmissionRouteModule`, `einvoiceSettingsRoutes`, and the file-local `rethrowAsAppError`, `toDto`, `PathParams`, `CompanyParams`. `src/context.ts` — the ninth `Variables` member `db` (amendment 13). `src/app.ts` — the two-line middleware. **`apps/api/src/problem.ts` gains no branch** (3C's `LandedCostError` precedent).
- `apps/worker` (**T7**) — `src/jobs.ts`: `jobs`, `setJobs`. `src/handlers/accounting-tax-submit.ts`: `POLL_LIMIT`, `pollDelaySeconds`, `accountingTaxSubmit`.
- Test tier — `packages/db/test/support/einvoice-stub.ts` (§4.17.1(a), amendment 10): `StubServer`, `StubScript`, `startStubServer`, `SYNTHETIC_PROFILE_PATH`, `stubProfile`, `enableEinvoice`, `optInDocumentType`, reached through the new `@dulja/db` `exports` subpath `"./test/einvoice-stub"`. `tests/invariants/support/einvoice.ts` (§4.17.1(b), amendment 10): `EinvoiceFixture`, `einvoiceFixture`, with `postOptedInDocument`, `driveToAccepted` and `twoTaxReturns` appended by **T8**. **`packages/db/test/fixtures.ts` gains nothing** — §4.17 assigns 5B no row and hazard 9 forbids inventing one.
- Scripts and documents — `scripts/check/contracts-5b-amendments.sh`, `scripts/check/no-authority-literals.sh`, the root `check:5b` script, the `einvoice:verify` script and the `einvoice-verify` CLI sub-command (both **T4**); `docs/adr/0052`, `docs/adr/0053`, ⚠️ `docs/adr/0051` (**OD-15**); `docs/decisions/od-15-5b-myinvois-requirement-set.md`, `docs/owner/od-15/README.md`, `docs/runbooks/einvoice-transmission.md`, `docs/review/2026-09-05-phase-5-exit.md`; `tests/invariants/phase-5-exit.test.ts`.
- Environment — **one name**, `EINVOICE_CLIENT_SECRET` (§3.11, amendment 9), joining `containerSecrets` in the same PR.

**Against the never/always lists.** **One** table is created and it carries `tenant_id`, `FORCE ROW LEVEL SECURITY`, a policy named exactly `tenant_isolation`, `created_at`, the audit trigger, composite `(tenant_id, x)` foreign keys, `uuidv7` ids, snake_case singular naming, a hand-written down and a two-tenant test in its own task (T1). **It carries NO `*_by` column and therefore no `app_meta.attach_stamp` call, deliberately** — §3.5.3's row for `einvoice_transmission` is four dashes, the acting principal of every write is the audit row's `actor_id`, and a transmission is not attributed to a person; T1's first `it` asserts `rows.filter(r => r.column_name.endsWith("_by"))` is empty and T1's migration comment says why. **The three `app.company` columns DO reach `updated_by` through that table's existing `attach_stamp`, which 0001 installed and this slice does not touch** — that is what makes T10's test-13 assertion on the company UPDATE's `actor_id` true. Everything else in T1 — re-asserted at the phase gate (T11). `app.company`'s three columns are §3.4.7's expand half on a live 0001 table and the down drops **only those three columns**. Every endpoint has a Zod schema, an OpenAPI entry regenerated in the same commit, `IdempotencyHeader` on every unsafe method, and a probe on the one new module. **No ledger, movement, layer, projection or `tax_transaction` write happens anywhere in this slice** — Task 10's fourth hooks assertion proves it empirically by fingerprinting `ledger_entry` across a transmission. No `number` holds money and Task 10's legacy-019 block asserts it as a source fact over five paths. No `sql.unsafe`, no string-concatenated SQL, no DDL from application code, no disabled invariant, no gated audit write, no enum label added, no package version in a source file. Every commit message carries the trailer.

**Against §4.4.2's A9.** This slice **plans no ledger line at all** and reads the sign of no planned amount. The one place it touches a monetary figure is `myinvoisCanonicalise`'s three header totals, which sum `LineSnapshot.amount` / `.taxAmount` / `.totalInclTax` through `Money.add` and render with `Money.toString()` — no direction is inferred, no amount is negated, and `PlannedTaxLine`'s signed exception never enters the picture because nothing here builds a plan.

**Against the hazards.** **1**: no statutory rate anywhere; every figure in Task 10's corpus is an obviously invented round number and the tax rate is whatever 5A's `seedTaxCode` default is — this plan states none. **2 — the binding one**: no LHDN or MyInvois endpoint, host, path, header, field, version, code list, threshold or deadline appears in this plan, in any test, or in any ADR but 0051; the only URLs are `http://127.0.0.1`; `scripts/check/no-authority-literals.sh` makes it mechanical and T11 puts it in CI for ever. **4**: this slice ships **no** report and the reason is argued (§4.16.1 is closed and has no e-invoicing row). **5**: Task 9's owner block and Task 11 Step 4's staging block both carry the exact command and its local equivalent, and the local equivalent for `einvoice:verify` is **written first and green from its own commit**. **6**: OD-15 is one isolated task, droppable without renumbering a neighbour's interfaces — and Task 9's own prose says exactly what survives when it is dropped. **Everything in Task 9 is OD-15 content and nothing else is:** `verify.ts`, its test, the `einvoice:verify` script and the `einvoice-verify` CLI sub-command were moved to Task 4, because a droppable task cannot own the command that hazard 5 names as the fallback for its own absence — Task 11 Step 4's `Until provided:` line would otherwise invoke a command that does not exist under §2.12's recorded default. **8**: every 0A helper is cited by its exact name. **9**: `fixtures.ts` gains nothing; two §4.17.1 files are registered by amendment 10, one per tier, with the module-cycle reason stated. **10**: no per-tenant row is written by a migration — the policy `einvoice` flags are a seed PR. **11**: two new closed vocabularies, both `text` + a named CHECK. **13**: `lint-schema.ts` is **not edited at all**, and T1's Interfaces block says why (§3.5.3's row is four dashes). **14**: both allocated migration numbers are used, neither borrowed. **15**: the root `tests/` and every service use the production `withTenant`; only `packages/db/test` uses the 4-argument one. **20**: the job runs under `systemContext`. **21**: no `sql.unsafe`. **22**: see the never-list paragraph. **24**: no handler inserts a `document_event`. **25**: the DELETE list is re-asserted as an equality in T11 and is unchanged — a transmission is cancelled, never deleted. **26**: one code, from the register. **29**: no screen, so OD-24 is not engaged, and the "Deliberately not in this slice" paragraph says so. **31**: one new route module, one new `PROBES` key, one new `JOB_PROBES` entry; the three sub-paths inherit existing keys. **32** and **33**: this slice writes into no shared literal namespace and resolves no account by code, so there is nothing for either hazard to bite on — stated in the Assumptions block and true of every task. **34**: the only seed files touched are existing envelopes whose `tax` block gains one boolean. **35**: every task has exact paths, exact signatures, real code and a failing test first — with **two** stated exceptions, each argued where it occurs. **Task 11** re-asserts pinned equalities rather than adding logic, and says so in its own opening paragraph. **Task 2 produces no commit**: §3.6.3's both-directions catalogue test and the `permission-catalogue` and `role-seed` lints make every proper subset of its four files red, so they land in Task 8's PR — Task 2 Step 5 tabulates which check each subset breaks, and 0058 is still that PR's only migration.

**Thirteen things a reviewer should check that this plan cannot prove on its own — two of which the audit pass closed and which are kept, struck through in substance, so nobody re-opens them.** Items 11–13 are the ones to check *before* starting Task 10; the rest surface as a named failure if they are wrong.

1. **Whether `tax_return`'s payload embeds a uuid.** Task 10's third `it` normalises uuids before comparing the hooks-off and hooks-on payloads, because the two returns are on two tenants. **If 5A's `buildReturn` emits no uuid at all, delete the normaliser and compare the raw strings** — a stronger assertion, and the change is one line. If it fails *after* normalising, a non-uuid byte moved and that is the defect the test exists to find.
2. **`runIntegrityCheck`'s result shape.** Task 10's last test-13 assertion reads `report.auditChain.ok` and `report.mismatches`. 1B owns those names; use 1B's spelling and change nothing else about the assertion's content.
3. **Where `companyRoutes` actually lives.** The File Structure records `apps/api/src/routes/admin/companies.ts` and Task 8 Step 6 greps for the real path instead of trusting it. If `companyRoutes` is not importable from a sibling of `accounting/`, the fix is the import path, never a second module on `/v1/companies`.
4. **✅ RESOLVED against 5A's written plan — `getTaxReturn` returns `{ row, boxes, currency }` and `TaxReturnDetail` has FIVE members.** They are `taxReturn` (the DTO, not `row`), `boxes`, `payload`, `tieOut` and `currency`, and 5A's own `/generate` and `GET /{id}` handlers build exactly that. Task 8 Step 7's handler now does the same, taking `payload` off `getTaxReturn`'s row and `tieOut` from 5A's `taxReturnTieOut`; an earlier draft answered `{ row, boxes, tieOut: [] }`, which would have failed 5A's schema at the OpenAPI boundary on three counts. Nothing is left for a reviewer to check here beyond re-reading 5A's `TaxReturnDetail` if that plan changes.
5. **✅ RESOLVED against 5A's written plan — `postTaxedDocument(db, f, { typeCode, effectiveDate, partyId?, taxInclusive?, lines })`.** The option is `typeCode` (5A maps it onto 4B's `code` itself, once), and a `TaxedLine` is `{ lineNo; kind?; accountId?; amount; taxCode: string | null }` whose `taxCode` is a **key of `TaxFixture.codes`** — `SYN-OUT-STD`, `SYN-OUT-ZERO`, `SYN-IN-STD`, `SYN-EXEMPT` — not a rate and not a uuid. Task 10's corpus now uses that shape, posts its purchase rows against `f.vendorId` and names `f.accounts["5900"]` on them rather than taking 5A's `4000` default. If 5A's helper changes, **adapt Task 10's loop, never 5A's helper** — four other 5A test files call it.
6. **Whether `startApi()`'s `jobs` client is real after 0D.** §4.2.12 describes it as "a `jobs` client that throws until 0D wires pg-boss". Task 8's submit route calls `c.var.jobs.enqueue(...)`, so if it still throws, that `it` returns **500**, not 202. **Look at how 4B's route tests exercised `c.var.jobs`** — 4B's revaluation and PDC routes pass it through and its route tests pass, so a real client almost certainly exists; if it does not, inject 3B's `recordingJobs()` into `startApi`'s deps and assert against `jobs.enqueued`, changing nothing else about the test.
7. **Where 0B's error hook puts a Zod `superRefine` message.** Two Task 8 assertions read `problem.detail` for the "all three or none" sentence. §4.2.4's `Problem` has both `detail` and an optional `errors[].message`, and 0B's hook decides which carries a custom issue. If `detail` is generic, move those two assertions to `problem.errors?.[0]?.message` — the `code` assertion (`ERR_VALIDATION_FAILED`) is right either way and is the load-bearing half.
8. **Whether Task 4's `enableEinvoice` writes under a tenant context.** Task 10's test-13 clause asserts a non-null `actor_id` on the `company` UPDATE, which is true only if `enableEinvoice` goes through `withTenant` with a real actor rather than through `db.admin` raw. If it uses `db.admin`, either change it to `withTenant` (correct — `app_meta.attach_stamp` is what fills `updated_by`) or drive that assertion through Task 8's `PUT …/einvoice-settings` route instead, which certainly does.
9. **Whether 4B's `arApFixture` is select-or-insert.** Task 10 composes it *on top of* a tenant `taxFixture` has already populated with accounts and a regime. 4B's Self-Review records that `seedTypeFromPack` was made select-or-insert for exactly this class of reason, but the account seeding is a separate question. A `beforeAll` dying on `ERR_CONFLICT_UNIQUE` is this, and the fix is in 4B's helper, not in Task 10's ordering.
10. ⚠️ **Whether ADR 0051 §9 turns out to need two profiles rather than one** (OD-15 only). If the authority's sandbox and production differ by more than a base URL, that is a second `TransmitterCode` label and therefore a contracts amendment. Task 9 Step 2's §9 says to record it and raise it; **do not add a second label to the CHECK without the amendment**, because the CHECK is in a migration that has already been applied.
11. **Whether `ArApFixture.accountIds` is keyed by ACCOUNT CODE.** Task 8's `postOptedInDocument` reads `arAp.accountIds["4000"]` and Task 10's corpus reads `f.accounts["5900"]`. 4B's own test bodies index it as `f.accountIds["4000"]`, `["1200"]`, `["1100"]`, `["2100"]` and `["5900"]`, so the key is the code — but that is read off 4B's usage, not off a declaration, and `Readonly<Record<string, string>>` would not catch a different key at compile time. A `undefined` account id inserts `account_id = null` and the policy's revenue rule resolves nothing; **if a line posts with a null account, this is why**.
12. **Whether `seedTaxCode(db, s, {})` reuses an existing regime.** `einvoiceFixture` calls it, and Task 10 calls `einvoiceFixture` on a tenant `taxFixture` has ALREADY given a regime. §4.17's row says the helper "creates the regime on first call", which reads as select-or-insert — but if it inserts a second `SYNTH-MY-v1`, 5A's single-regime invariant fires on the posting path with `ERR_TAX_REGIME_MISMATCH` and Task 10's `beforeAll` dies there. The fix is in 5A's helper, not in Task 10's ordering.
13. **Whether `tests/invariants/probes.ts` can reach what Task 7 Step 6's `JOB_PROBES` entry needs.** That snippet uses `draftDocument`, `enableEinvoice`, `recordPending`, `listTransmissions` and the production `withTenant`; the file is 0B's and 0D's, and this task adds an entry rather than the imports it needs. **Add whichever of those five the file does not already import, in the same edit** — `enableEinvoice` through `@dulja/db/test/einvoice-stub` (amendment 10's subpath), the rest through `@dulja/db` and `@dulja/db/test`. It is a compile error and not a silent failure, which is why it is item 13 and not item 1.

**Deliberately not in this slice.** **No screen.** OD-24 is not engaged, `apps/backoffice` is untouched, and the transmission log is operated through its route module and the runbook — a slice with no screen has no OD-24 task, which is why the count is twelve and not thirteen. **No report code and no `DatasetId` member** (§4.16.1 is closed for v1; amendment 12 argues the non-membership rather than asserting it). **No GCC/ZATCA pack** — spec:2226 defers it until a customer there exists, and it would be one profile file, two functions and a third `TransmitterCode`. **No e-invoice attachment**: the QR payload is a column, and rendering it onto a printed invoice is 2C's template surface, reached by reading `einvoice_transmission.qr_payload`. **No `document_event` for a transmission** — hazard 24, and a transmission is not a document transition. **No second job name**: `JOBS` is closed at sixteen and `phase` is what carries both halves. **No POS-specific path**: 6A's `POS_TICKET` transmits by setting `tax.einvoice` in its seed file, with no code change anywhere in this slice or that one.

---

## Execution handoff

**Read before starting.** This plan's Assumptions block **including its RECONCILED paragraph**, all of §3 of the contracts document, §4.9 in full, §4.3.2's step 14, and §5 hazards **1 and 2**. Then Task 0 in full: it is a gate, not a formality, and **Task 1 does not start until `bash scripts/check/contracts-5b-amendments.sh` exits 0**. Its four `NOTE:` lines change what Tasks 10 does; read them rather than skimming past them.

**Order and independence.** **T0 → T1** first (T2's migration follows T1's). **T3 → T4 → T5** are strictly sequential — T4 implements T3's port, T5 drives T4's registry. **T6 needs T5** (it calls `recordPending`) and **T7 needs T5** (it calls `submitTransmission`), but T6 and T7 do not need each other and **may run in parallel** if two engineers are working. **T2 produces no commit of its own and all four of its files land in T8's PR** (T2 Step 5), so **execute T2 immediately before T8** rather than carrying an uncommitted tree through T3–T7: the working order is **T0 → T1 → T3 → T4 → T5 → T6 → T7 → T2 → T8 → T9 → T10 → T11**. The task keeps its number — every cross-reference in this plan and in Task 0's amendments names it, and renumbering to record an execution order is the churn §3.4.1's "never renumber" rule exists to stop. **T8 needs T5 and T7** (its submit route enqueues T7's job) as well as T2. **T9 is OD-15's isolated task and blocks nothing**; drop it and every other task still merges green. **T10 needs T6, T7 and T8** (its fixture posts, drives and files). **T11 is last by definition.**

**Two migrations, two PRs (spec:2057):** T1's 0057 in T1's PR, and T2's 0058 in **T8's** PR — one migration each, which is what spec:2057 caps. Nothing else in the plan adds DDL. Tasks 3–11 may be grouped by whatever review cadence the team runs, but **a task is never split across PRs** — its failing test and its implementation land together, and **Task 2 is the one task that produces no commit at all**: its four files are green only together with T8's route, and Task 2 Step 5 tabulates which check each subset breaks.

**Two ADRs are proposals and must be accepted before their implementation merges** (spec:95): **0052** (T3, T4 — it touches the data model and an external integration's security posture) and **0053** (T5, T7 — it fixes what reaches `response jsonb` and therefore what a future incident responder can and cannot see). A still-`proposed` ADR blocks its own tasks' merge, not the plan. **ADR 0051 is not a proposal** — it is a record of an external authority's documentation, and it is accepted the moment it is written from that documentation.

**Where to stop and raise rather than working around.**

- **A `MISSING (repo):` line from Task 0's gate.** That is a reconciliation with 5A or 4B, and **the owning plan is the authority for what it exports** (§4.18). Correct *this* plan's import path or name; never add a second spelling.
- **`tests/regression/legacy-020.test.ts` absent.** §3.7.3 makes **5A** its creator. Task 10 Step 6 appends to it and must not create it — creating it here would give 5A's own Task 11 a merge conflict on a file it owns. Raise it as a 5A gap.
- **`tests/golden/tax/` empty.** Task 10's fifth `it` skips with a named message and the other four still run. That is the designed behaviour, not a failure — but **tell the 5A owner**, because it means test 26's file comparison is not running anywhere.
- **`assertRouteGates` throwing `ERR_ROUTE_GATE_READONLY` after Task 8.** Read the error before changing anything: it names the code and the method. `accounting.tax.file` and `admin.company.manage` are both `mutating: true`, so the cause is a route gated by a code its `RouteModule.permissions` array does not declare — add the code to the array, never change the gate.
- **`ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` in CI, or from the `cancel` route.** The registry is module-level process state and is filled by exactly three kinds of caller: the two entrypoints at boot (`apps/worker/src/index.ts` from T7, `apps/api/src/index.ts` from T8), `startApi()` in the API test harness (T8), and a `beforeAll` in every root `tests/` file that transmits (T10, and the legacy-020 append). **A root `tests/` file starts no entrypoint**, so a suite that forgets `resetTransmitters(); registerDefaultTransmitters("dev")` sees this on every row. **Never register `synthetic` unconditionally to make it go away** — amendment 5's whole point is that the CI transmitter cannot exist in production.
- **A `permission-catalogue` failure reading "code introduced in 5B has no reference", or a `permission-catalogue.test.ts` failure naming `accounting.tax.file`.** Part of Task 2 was committed on its own. All four of its files belong in Task 8's PR together (Task 2 Step 5's table says which check each subset breaks); **never add a dummy reference and never add a lint suppression** — that is the lie the rule exists to catch.
- **Any proposal to call the authority from inside a request.** The submit route enqueues for the three reasons Task 8's opening states. A "quick synchronous submit for the operator" holds a socket for the request's whole timeout budget against a system nobody here controls, and its retry semantics would then live in two places.
- **Any proposal to put the transmitter's `raw` response on the wire or in a log field.** ADR 0053 fixes what may reach `response jsonb` and `redactResponse` is the one gate. `toDto` deliberately omits `response`, and Global Constraint 16 forbids the log field.
- **Any proposal to hard-code "which document types transmit" in TypeScript.** It is `policy.tax.einvoice`, versioned and append-only (amendment 4). A mandate that widens next year is a seed PR; a list in code is a release, and Phase 8's rate tables settled this argument already (spec:2229).
- **A `TS2339` or a `TS2345` on a 5A or 4B name in Task 8 or Task 10.** Those two tasks now name the exact shapes: `seedTenantV2(db, name)`, `grantCodes(db, s, { codes })`, 4B's `PACK_DIR` and `partyIds.customer` with `accountIds` keyed by account code, 5A's `postTaxedDocument(db, f, { typeCode, …, lines: TaxedLine[] })` and its five-member `TaxReturnDetail`. **The owning plan is the authority (§4.18)**: adapt this plan's call site and add the name to Task 0's gate so the next reader is warned, and never add a second spelling or a second helper.
- **`beforeAll` in `tests/golden/tax-einvoice.test.ts` dying on `ERR_TAX_REGIME_MISMATCH` or `ERR_CONFLICT_UNIQUE`.** Those are Self-Review items 12 and 9 — `seedTaxCode` inserting a second regime on a tenant `taxFixture` already gave one, or `arApFixture` re-seeding a row `taxFixture` created. Both fixes are in the owning slice's helper (5A's and 4B's respectively), not in this file's call order: reordering only moves which call collides.
- **Any plausible-looking MyInvois value anywhere outside a profile file, ADR 0051 or a test.** That is a defect, not a shortcut, and `scripts/check/no-authority-literals.sh` will say which file and line. **Delete it and read ADR 0051.** If ADR 0051 does not have the answer, the answer is unknown and goes in its §8.

**The two commands that must be green after every task.** `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck` and `bun run test`, both at the repository root — plus, from Task 0 onward, `bash scripts/check/no-authority-literals.sh`. `lint:rules` is the one that catches this slice's likeliest mistakes: a `db.` outside `withTenant` (only one file is allow-listed, and amendment 13 says which), a permission code with no reference, and a forbidden log field.

**What Phase 6 and later phases inherit, so nobody has to re-derive it.**

- **`postDocument` step 14 now has two occupants** — 3B's `inventory.cost.replay` and 5B's `accounting.tax.submit`. A third enqueue is a clause inside the same branch, never a new parameter, and the e-invoicing clause writes its durable row **before** the enqueue precisely so a missing `JobClient` is a warning and not a loss.
- **`POS_TICKET` transmits by configuration.** If ADR 0051 §6 covers retail tickets, set `"einvoice": true` in `POS_TICKET.json`'s policy `tax` block. Nothing in `packages/sync`, `apps/pos` or 6A's apply path needs to know e-invoicing exists — a ticket synced eight hours late gets its transmission at apply time through the same step 14 as every other document.
- **`createHttpTransmitter` + a profile file is the shape for any future authority integration**, and `einvoice-profiles/README.md` states its four rules. A GCC pack is one JSON file, two functions and one `TransmitterCode` label.
- **`einvoice_transmission` is not on `posting-only-tables` and must never be added.** Step 14 writes it from inside `posting/` and the submit path writes it from `packages/db/src/einvoice/` — the same relationship `party_ageing` has to its job, which §3.7.5 excludes by name.
- **A transmission is cancelled, never deleted.** §3.5.4's DELETE list stays at five tables and T11 re-asserts it as an equality; 2B remains the only slice that ever extended it.
- **`accounting.tax.file` is the filing authority for both halves of Phase 5** — the return's `generated → filed` transition and the e-invoice submit/cancel pair. A slice adding a third filing action gates it with the same code and adds no fourth.
