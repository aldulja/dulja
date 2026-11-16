# Dulja Phase 2A — Policy engine, generic `document_line`, `party`, posting-service generalisation, reversal

**For agentic workers:** every task below is self-contained. Read the task, open the files it names, and type what it shows. Do not read the other tasks first; do not look for context outside the paths a task names. Every signature, every SQL statement and every test assertion you need is written out in the task — where this plan repeats the contracts document, the repetition is deliberate (contracts §5 item 35: "a task's implementer sees only their own task").

**Goal.** Turn the posting service from *the thing that posts a JOURNAL* into *the thing that posts anything a policy describes*. Concretely: widen `packages/domain/posting-policy.schema.json` from 1A's JOURNAL subset to the full contracts §4.4.1 text under ADR 0026 — the proposal spec:2006 demands — and widen `evaluatePolicy` to match, so a policy may iterate lines, tax groups or the document as a whole, resolve accounts from a party, an item, a tax code, a pay component, a statutory scheme or a literal chart code, filter with a `when` conjunction, tag each planned ledger line with dimensions from a declared source, and refuse a document whose planned lines are missing a `dimensions.required` type. Around that: `app.party` and the deferred `document.party_id` foreign key spec:1759 has been waiting for since migration 0001; `document_line` generalised with the ten columns of contracts §4.3.4; `document_type.module` and `archived_at`; `loadSnapshot` filling the fields it has been stubbing since 1A; `reverseDocument` carrying the new line columns; the document API's static `accounting.journal.*` gates replaced by the codes the effective policy names; and the two configuration APIs — document types with their policy versions under `admin.company.manage`, parties under `accounting.party.manage` — through which a tenant defines a new document type without a line of code. At the end of this slice a document type created through `POST /v1/companies/{companyId}/document-types`, given a policy version through `POST …/document-types/{id}/policies`, numbers, posts and reverses; and a policy that requires the BRANCH dimension refuses a planned line that carries none.

**Architecture.** The split of contracts §3.1 and §4.3 is unchanged and this slice deepens it. The **pure** half — the JSON Schema, the snapshot and plan types, `validatePolicy`, `parsePolicy`, `validateRequires`, `evaluatePolicy`, `balanceInBase` — stays in `packages/domain/src/posting/`, imports nothing but `decimal.js` and Ajv, and never touches a database, a clock or a network; that is what makes the golden fixtures of Phases 3, 5 and 8 and acceptance tests 22 and 28 possible. The **I/O** half — `loadSnapshot`, `resolvePolicy`, `issueDocument`, `postDocument`, `reverseDocument`, `voidDocument` — stays in `packages/db/src/posting/` and is exported from `@dulja/db`; this slice extends those files and adds no sibling. `packages/domain/src/**` still may not import `packages/domain/payroll/**` (spec:2366), which is why `PayComponentRef`, `SchemeRef` and `PayrollLineRef` are declared in core and 8B maps onto them. The API layer gains two configuration route modules and one middleware, `requireDocumentPermission`, which resolves the permission code for a document action from the policy effective for the document's `effective_date` — a pre-flight only; 2B's BEFORE UPDATE OF status trigger is the control (spec:2173).

**Tech Stack.** TypeScript on Bun (apps and packages) with Vitest on Node 24 for tests (D5); PostgreSQL 18 through `postgres.js` tagged templates; Drizzle ORM mirrors for reads and as the migration diff source (ADR-0002, contracts §3.4.9); Hono + `@hono/zod-openapi` for routes; `decimal.js` behind `Money` (0D); Ajv (JSON Schema draft 2020-12) for policy validation; `json-schema-to-typescript` (dev) for the committed `PostingPolicy` type; Testcontainers for every database test. No package version appears in any source file — the lockfile owns versions (spec:104).

**Spec.** `docs/spec/rebuild-spec.md` v1.2 — §0.2 (spec:97–106), §0.4 glossary rows Muniment/Bill/Voucher/Account (spec:152–156), §3.1 #3 (spec:1075), §3.3 DocumentType/Document/DocumentLine/Party (spec:1169, 1185–1192), §3.5 (spec:1234–1236), §3.8 document tables (spec:1693–1780) and the posting-policy definition (spec:2006–2031), §3.9 (spec:2039–2051), §3.10.3 (spec:2101), §4.2 (spec:2138) and §4.2.1–§4.2.2 (spec:2146–2179), §4.11 (spec:2262–2267), Part V phase 2 row (spec:2288), Part VI tests 15 and 28 (spec:2433, 2446), Part I SAH-013, SAH-072, SAH-078. Contracts: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` (2026-09-07).

---

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 2A — Policy engine, generic `document_line`, `party`, posting-service generalisation, reversal. **Phase:** 2. **Phase gate:** this plan starts only when 1A and 1B are merged and the Phase 1 definition of done (spec:2287) is green in CI (spec:87).
- **Depends on (merged):** **1A** (`loadSnapshot`, `resolvePolicy`, `issueDocument`, `postDocument`, `reverseDocument`, `voidDocument`, `PostingError`, `posting-policy.schema.json` at the JOURNAL subset, `document-type-seed.schema.json`, `evaluatePolicy`/`validatePolicy`/`parsePolicy`/`validateDocumentTypeSeed`/`validateRequires`/`balanceInBase`, `loadDocumentTypes`, `app.document_line`, `app.account_balance`, `app.posting_seq`, the `documents`/`ledger-entries`/`accounts`/`fiscal-periods` route modules, `posting-only-tables`, `JOURNAL_POLICY_V1`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount`); **1B** (`postJournal`, `registerProjectionCheck`, the `reportsRouteModule`); **0D** (`Money`, `Quantity`, `currency`, `toBase`, `UNIT_RATE`, `round`, `seedBranch`, `seedCurrency`, `seedRate`, `PERMISSIONS`, `ROLES`); **0B** (`withTenant`, `TenantContext`, `createDb`, `AppError`, `ERRORS`, `PERMISSION`, `requirePermission`, `buildRoutes`, `RouteModule`, `IdempotencyHeader`, `startApi`, `PROBES`, `sharedDb`, `sharedApi`, `thinRegression`, `fullRegression`, `problemOf`, `grantAdmin`); **Plan 0A** (`startDb`, `Db`, `Seed`, the 4-argument test `withTenant`, `uuidv7`, `seedTenant`, `draftDocument`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `schemaFingerprint`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.current_tenant`).
- **Migration numbers:** 0017–0020 — files `0017_create_party.sql`, `0018_alter_document_party_fk_and_document_type_module.sql`, `0019_alter_document_line_generalise.sql`, `0020_seed_permission_phase2a.sql`, each with its hand-written `NNNN.down.sql`. **ADR numbers:** 0026–0028; this slice writes **0026** (the posting-policy schema in full — a proposal, spec:95/2006) and **0027** (the policy API exposes create-version only). **0028 is left unused** — contracts §3.4.1's rule for migration numbers applies to ADR numbers too (§3.9): unused numbers stay unused. The `party` `kind` discriminator needs no ADR: spec:1169 and contracts §4.5.7 already decide it.
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 `Money`/`Quantity`/`toBase`, §4.2.2 `withTenant`/`TenantContext`, §4.2.3 `AppEnv`/`RequestContext`, §4.2.4 `AppError`/`ERRORS`/`Problem`/`PostingError`, §4.2.5 `PERMISSION`/`requirePermission`/`PermissionCode`, §4.2.7 `RouteModule`/`buildRoutes`/`IdempotencyHeader`/`PROBES`, §4.2.8 the common Zod schemas and the cursor codec, §4.2.9 the idempotency header, §4.2.12 `startApi`, §4.3.1 the posting barrel, §4.3.2 the fixed algorithm, §4.3.4 `document_line`, §4.3.6 numbering, §4.3.7 the seed envelope and `loadDocumentTypes`, §4.17/§4.17.1 the fixture registers.
- **Interfaces produced:** §4.4.1 **in full** (`packages/domain/posting-policy.schema.json`, same `$id` `urn:dulja:posting-policy:1`, same `"version": { "const": 1 }`); §4.4.2 in full (`evaluatePolicy` over every `for`, `when`, `account`, `amount` and `dimensions` member of the schema, **with the sign normalisation of amendment A9** — a negative resolved amount emits the rule's opposite side at `amount.abs()`, so `PlannedLedgerLine.amount` is never negative and `app.ledger_entry`'s `check (debit >= 0)`/`check (credit >= 0)` can be satisfied by a reversal); §4.5.7 verbatim (`app.party` and the deferred `document.party_id` FK); §4.3.4's 2A row verbatim (the ten `document_line` columns) and its `document_type` additions (`module`, `archived_at`); §4.5.4's `requireDocumentPermission(stage)` and `DOCUMENT_STAGE_CODES`; §3.6.2's one `accounting.party.manage` code; §4.17's `seedParty` and `seedDocumentType`.
- **Owner decisions:** **OD-24** → Task 15 (isolated); default: the screen task is blocked, the slice is not. No other owner decision touches this slice.
- **Part VI tests owned / re-run:** owned — **none exclusively**. Re-run — **15** (the numbers/posts/reverses clauses on a configured type; 2C owns the test and adds prints/reports), **28**'s BRANCH-refusal mechanism (F-9; 8B re-runs it on PAYROLL), **12** and **13** and **36** for `party`, `document_type` and `posting_policy`. **§3.0.4 rows owned:** spec:1066 — BRANCH mandatory on every revenue, COGS and staff-cost ledger line, "a posting-policy `requires`" (8B contributes PAYROLL). **Regression files created / appended:** created — none; appended — `sah-013`, `sah-072`, `sah-078` (all three created by 0B, §3.7.3).
- **Shared namespaces this slice writes into:** document-type codes (§4.14) — **`POLICY_TEST`** and **`POLICY_TEST_2`** (both module `accounting`, test only, never seeded into a pack), registered by amendment A1 below, and **`CONSIGNMENT_RETURN`** — already registered to **2C** in §4.14 and used here only as a request-body literal in Task 10's, Task 13's and Task 14's API tests, never written into `packages/db/seed/my/document-types/`; 2C still owns the code, its seed file and test 15. **No other document-type code literal appears anywhere in this slice** — a test that needs "a second type" uses `POLICY_TEST_2`, and a test that needs "a `producesType` this company does not have" names `POLICY_TEST_2` in a company where only `POLICY_TEST` is seeded (contracts §5 item 32). Account codes (§4.15) — **none seeded**; consumed but seeded elsewhere: `1200` Trade receivables and `2100` Trade payables (0C), used as `seedParty`'s defaults per §4.17 and created by that fixture when a bare `seedTenant` tenant has no chart, and `5920` FX rounding (0C, wired by 1A's `seedTenantV2`). Report codes (§4.16.1) and `DatasetId` members (§4.16.2) — **none**. `fixtures.ts` helpers (§4.17) — **`seedParty`, `seedDocumentType`, and no others**; shared test helpers (§4.17.1) — **none**.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

### The ten amendments this plan needs, and why

contracts:1261 says a plan implements §4's blocks **verbatim** and "may add members only by amending this document". Each row below is one amendment PR against the contracts document, landing **before** the task that needs it.

| # | § | Amendment | Task |
|---|---|---|---|
| **A1** | 4.14 | Register **two** test-only codes, both module `accounting`, direction internal, inventory none, `approval.post: accounting.journal.post`, **test only, never seeded into a pack**: `POLICY_TEST` (series `PT`, `reversal.producesType: "POLICY_TEST"`) and `POLICY_TEST_2` (series `PT2`, `reversal.producesType: "POLICY_TEST_2"`). Contracts §5 item 32 makes an unregistered document-type code a review-blocking finding, and this slice's re-runs of tests 15 and 28 both need a type that is not JOURNAL. **Two are needed, not one:** T9 needs a second type whose only policy version is effective *after* the document's date (the `ERR_POLICY_NOT_FOUND` case), T10 needs a second type to archive without archiving the one its other cases use, T8 needs a `reversal.producesType` naming a code that is registered but *not seeded in that company*, and T14's `sah-078` needs a second type in its own tenant. The two series differ so the two test types never share a numbering series. | T6 |
| **A2** | 4.2.8 | Register two contracts modules: `packages/contracts/src/accounting/party.ts` (`PartySchema`, `PartyKindSchema`, `CreatePartyBody`, `UpdatePartyBody`, `PartyQuery`, `PartyList`) and `packages/contracts/src/admin/document-type.ts` (`DocumentTypeSchema`, `CreateDocumentTypeBody`, `DocumentTypeQuery`, `DocumentTypeList`, `PostingPolicySchema`, `CreatePostingPolicyBody`, `PostingPolicyList`, `DocumentTypeModuleSchema`). **And three names added to 1A's `packages/contracts/src/accounting/document.ts`** — `DocumentTypeCodeSchema`, `DocumentLineKindSchema` and `DocumentLineInput` (the line as *accepted*, replacing 1A's inline object; 3A and 5A each add their own field to it in the PR that adds their foreign key). All four are exported from `@dulja/contracts` and imported by 2C, 3A, 4A and 6A, so none is a name internal to one slice (contracts:1263). | T9, T10, T11 |
| **A3** | 4.2.7 | Register two `RouteModule` paths: `/v1/companies/:companyId/document-types` (`documentTypeRoutes`, gate `admin.company.manage`) and `/v1/companies/:companyId/parties` (`partyRoutes`, gate `accounting.party.manage`), with sub-paths `POST …/document-types/{documentTypeId}/policies`, `POST …/document-types/{documentTypeId}/archive`, `POST …/parties/{partyId}/archive`. | T10, T11 |
| **A4** | 4.5.4 | `requireDocumentPermission` and `DOCUMENT_STAGE_CODES` are created by **2A**, not 2B, and ship with **all six** `DocumentStage` members mapped. 1A's Task 12 states twice that "2A replaces both static gates with `policy.approval.create` / `policy.approval.post` resolved from the effective policy"; 2B then *uses* the middleware for its `submitted`/`approved` transitions and edits the file only to add its own `RouteModule` permissions, never the stage map. The file also exports **`POLICY_RESOLVED_CODES`** — the `PERMISSION[...]` references that keep the bidirectional `permission-catalogue` lint (§3.6.3) satisfied for gates resolved from *data*, which no source scan can see; `DOCUMENT_STAGE_CODES` is initialised from it and every type-seeding slice appends to it. | T9 |
| **A5** | 4.4.2, 4.3.2 | `evaluatePolicy` emits a planned line whose `amount` reference is `line.cost` or `line.variance_value` and whose `LineSnapshot.cost` is `null` as `Money.zero`, and **exempts it from the zero-drop of §4.3.2 step 6** — `null` (not yet costed) and `Money.zero` (costed at zero) are different, which is why `LineSnapshot.cost` is `Money \| null`. Without the exemption step 9's `applyMovements`, which "fills `value` on the plan", would have no line left to fill and 3B could not exist. Until 3B ships, `postDocument` fail-closes on any surviving zero-amount non-`fx_rounding` planned line with `ERR_POLICY_REQUIRES_MISSING`; 3B replaces that guard with the `applyMovements` call at step 9. | T6, T7 |
| **A6** | 4.4.1 | Fix the resolution paths the schema names but §4.4.2 does not map: `when["document.kind"]` resolves from `snapshot.header.customFields["kind"]` (a document has no `kind` column and 8B's `payroll_run.kind` is a 1:1 extension, so the custom-field bag is the only place a kind can live in core); `amountRef` `line.total_excl_tax` is the same field as `line.amount` (§4.3.4 defines `amount` as "excl. tax"); `line.variance_value` is `LineSnapshot.cost` under A5's rules and 3D fixes its accounting meaning. | T6 |
| **A7** | 2.2 (2A card), 3.6.2 | The 2A card's Delivers ends "…; `accounting.document.reverse` handler", but §3.6.2 introduces `accounting.document.reverse` in **2B**, §4.5.4 puts `POST …/documents/{documentId}/reverse` beside 2B's transitions route, and 1A's Self-Review records that it deliberately shipped no reversal endpoint "so 2B's route is one handler over a function that is already green". Handler and code must land together or the bidirectional `permission-catalogue` check (§3.6.3) fails on whichever slice is missing its half. **Resolution: 2A generalises `reverseDocument` (the service) and ships no reversal route and no reversal permission code; 2B ships both.** The card sentence is amended to read "…; `reverseDocument` generalised to the new `document_line` columns (the HTTP route and `accounting.document.reverse` are 2B's)". | T8 |
| **A8** | 4.3.1 | State that `reverseDocument` reads `policy.reversal` from the policy **pinned on the original document** (`app.document.posting_policy_id`, spec:1753) and not from `resolvePolicy(documentTypeId, original.effective_date)`. 1A shipped the second form, which was safe while a policy version could only arrive through a seed file; 2A's `POST …/document-types/{documentTypeId}/policies` makes a **back-dated** `effective_from` an ordinary API call, and a version whose `effective_from` is on or before an already-posted document's `effective_date` would then change what that document's reversal produces. That is SAH-013 verbatim — "reversal reads *current* flags, not those originally applied" — and 2A is both the slice that opens the door and the slice that appends to `sah-013`. The signature, the return and the error codes are unchanged. | T8, T14 |
| **A9** | 4.4.2 | **`evaluatePolicy` normalises the sign of every planned ledger line: a rule whose resolved amount is negative emits the rule's *opposite* side with `amount.abs()`.** `PlannedLedgerLine.amount` is therefore never negative, and `side` alone carries the direction. This is not a convenience — it is the only shape `app.ledger_entry` accepts: plan0A:2012–2013 declares `check (debit >= 0)` and `check (credit >= 0)`, and 1A's `insertLedger` writes `const debit = line.side === "debit" ? line.amount.toString() : "0.0000"` (1a:3176–3179), so a negative planned amount dies on `ledger_entry_debit_check` at the insert. A reversal document carries **negated** signed magnitudes on its lines (T8), which is exactly how one policy produces both directions — and it only works because the negative amount flips the side here. The rule applies in both emit paths (`each_line`/`document` through `push`, and the `each_tax` group). `PlannedTaxLine.amount` is **not** normalised: 5A's tax ledger wants the signed magnitude. | T6, T8 |
| **A10** | 4.2.4 | Strike "`ERR_VALIDATION_FAILED` only" from the `Problem.errors` comment: **`ERR_POLICY_INVALID` also carries `errors[]`**, each entry a JSON Pointer into the rejected policy definition plus the validator's message. `AppError`'s `extra?: Partial<Problem>` and `ProblemSchema`'s optional `errors` already permit it structurally; this makes the registry say it. The reason is SAH-078 itself — "an invalid rule is refused at configuration time, **naming the JSON path**" — and T10's and T14's assertions read `problem.errors[].path`. No other code gains the member. | T10 |

---

## Global Constraints

**Never** (spec:97–104, restated because each task must be able to stand alone): write to a ledger or movement table outside the posting service; represent money as a float anywhere, TypeScript included; build SQL by string concatenation (SAH-036/037/069); issue DDL from application code (SAH-053); disable an invariant, constraint or trigger "temporarily" (SAH-027, 041, 053); gate an audit write on any flag (SAH-030); hard-code a package version into a source file — the lockfile owns versions.

**Always**, for every new table (spec:106 unioned with the Plan 0A linter, contracts §3.3): `tenant_id`; RLS enabled **and forced** through `call app_meta.enable_tenant_rls('app.<name>')`; the policy named exactly `tenant_isolation`; `id uuid primary key default uuidv7()` unless the table is in `NO_ID_TABLES`; `created_at timestamptz not null default now()`; `call app_meta.attach_audit('app.<name>')` unless the table is in `AUDIT_EXEMPT`; `call app_meta.attach_stamp('app.<name>', '<col>_by')` for every `*_by` column; composite FKs `(tenant_id, <parent>_id)` to every tenant-scoped parent; a migration with a hand-written down; a Drizzle mirror in `packages/db/src/schema/`; and a test that a second tenant cannot see it. `lintSchema` must report **zero** violations after every migration. This slice's one new table, `app.party`, joins **no** linter set (contracts §3.5.3).

**Every query — reads included — runs inside `withTenant`** (spec:2053). The `no-bare-db` lint forbids a bare `db.` call; only a `tx` obtained from `withTenant` may tag SQL. `sql.unsafe` has exactly three homes and none of them is in this slice (contracts §3.3).

**Money is `numeric(19,4)` in Postgres and `Money` in TypeScript** (spec:2041); quantities are `numeric(19,6)` and `Quantity` (spec:2043). Base conversion is `round(value × rate, 4)` with `HALF_AWAY_FROM_ZERO` (spec:1816, contracts §5 item 23). `effective_date` is a `date` the user enters and is never derived from `posted_at` (spec:2039).

**No new `ERR_*` code.** Every condition this slice raises is already allocated in contracts §4.2.4 and already present in `packages/contracts/src/errors.ts` after 0B and 1A: `ERR_VALIDATION_FAILED`, `ERR_NOT_FOUND`, `ERR_CONFLICT_UNIQUE`, `ERR_CONFLICT_REFERENCE`, `ERR_RBAC_FORBIDDEN`, `ERR_POLICY_INVALID`, `ERR_POLICY_NOT_FOUND`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_DOC_STATUS_ILLEGAL`, `ERR_DOC_NO_LINES`. A task that reaches for a code not in that list has found a real gap — stop and amend contracts §4.2.4 first.

**No DDL outside `packages/db/migrations/`, and no per-tenant row inside one.** `FORCE ROW LEVEL SECURITY` binds `app_migrator` too (spec:1366), so migration 0020 may write `app.permission` (global) and nothing else; document types, policies and parties are seed-pack or API data (contracts §3.4.8, hazard 10).

**Commits.** Conventional commits, scope = workspace or area, subject `<type>(<scope>): <summary> [2A T<n>]`, every message ending with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (contracts §3.8). **One migration per PR** (spec:2057) — this slice has four migrations and therefore at least four PRs. `bun run lint`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root must be green after every task.

**`bun run lint:rules` has one documented window, and it is the only one.** `permission-catalogue` is bidirectional (contracts §3.6.3), so from Task 4 — which adds `accounting.party.manage` to `packages/contracts/permissions.ts` in the same PR as migration 0020, because `permission-catalogue.test.ts` compares the database set and the exported set in both directions — until Task 11 registers the party route, `lint:rules` reports exactly **one** violation, `permission-catalogue … accounting.party.manage has no reference`. No other rule may report anything at any point, and every task that runs `lint:rules` says so in its expectation. Tasks 4 through 11 are one pull request (see *Execution handoff*), so no red build is ever published.

Pushing to GitHub is the owner's call, not part of any task's definition of done.

**TDD.** Every task writes the failing test first, runs it, sees the **exact** stated failure, writes the minimal implementation, runs the test to green, then commits. A task that reports a different failure than the one written down has found a real difference from the plan — stop and report it rather than editing the expectation.

---

## Phase 2 definition of done (spec:2288, verbatim) and this slice's share

> **Scope:** "Party model, `DocumentType` + versioned `PostingPolicy`, draft→issued→posted→reversed state machine with `document_event` and the R1/R2 status trigger, numbering, templates, **attachment service** (object storage, opaque ids, hash — §3.3)".
>
> **Definition of done:** "**A new document type is added with zero code**; issued numbers are unique and gapless-provable".

| Clause | Slice | Where |
|---|---|---|
| "A new document type is added with zero code" — **the mechanism**: the policy schema in full, the evaluator that reads it, the party and line columns a real type needs, and the configuration API that creates a type and a policy version | **2A** | Tasks 5, 6, 7, 10, 11; proved end to end at the service and API level in Task 13 |
| "A new document type is added with zero code" — **the sentence**, proved by test 15 (numbers, posts, **prints**, **reports**, reverses) | 2C | 2C's test-15 task |
| "issued numbers are unique and gapless-provable" | 2B | `app.series_gaps`, the concurrent-first-document test |
| draft→submitted→approved state machine, `document_event`, R1/R2 triggers, voids | 2B | 2B's trigger tasks |
| Templates, attachments | 2C | 2C |
| **§3.0.4 row spec:1066** — BRANCH mandatory on every revenue, COGS and staff-cost ledger line, as a posting-policy `requires` | **2A** | Task 12 |

The phase exits when every clause is green in CI (spec:87).

---

## File Structure

```
packages/db/
├─ migrations/
│  ├─ 0017_create_party.sql                          app.party (§4.5.7)                        T1
│  ├─ 0017.down.sql                                                                            T1
│  ├─ 0018_alter_document_party_fk_and_document_type_module.sql
│  │                                                 document.party_id FK (spec:1759) +
│  │                                                 document_type.module, .archived_at (§4.3.4) T2
│  ├─ 0018.down.sql                                                                            T2
│  ├─ 0019_alter_document_line_generalise.sql        the ten §4.3.4 columns                    T3
│  ├─ 0019.down.sql                                                                            T3
│  ├─ 0020_seed_permission_phase2a.sql               accounting.party.manage (§3.6.2)          T4
│  └─ 0020.down.sql                                                                            T4
├─ src/
│  ├─ schema/party.ts                                Drizzle mirror (new)                      T1
│  ├─ schema/document.ts                             party_id FK noted on the 0B mirror        T2
│  ├─ schema/document_type.ts                        + module, archived_at                     T2
│  ├─ schema/document_line.ts                        + the ten 2A columns                      T3
│  ├─ posting/load.ts                                loadSnapshot fills party, the line
│  │                                                 columns and customFields                  T7
│  ├─ posting/post.ts                                the A5 fail-closed guard                  T7
│  ├─ posting/reverse.ts                             reverseDocument carries the new columns   T8
│  └─ seed/document-types.ts                         the insert widened with `module`          T2
└─ test/
   ├─ fixtures.ts                                    + seedParty (T1), seedDocumentType (T6)   T1, T6
   ├─ party.test.ts                                                                            T1
   ├─ document-party-fk.test.ts                                                                T2
   ├─ document-line-generalised.test.ts                                                        T3
   ├─ permission-catalogue.test.ts                   + accounting.party.manage                 T4
   ├─ posting/load.test.ts                           extended: party, line columns, custom     T7
   ├─ posting/post.test.ts                           extended: the A5 guard                    T7
   ├─ posting/reverse.test.ts                        extended: generalised reversal            T8
   ├─ posting/branch-required.test.ts                spec:1066, F-9                            T12
   └─ seed/document-types.test.ts                    extended: module is inserted              T2

packages/domain/
├─ posting-policy.schema.json                        widened to §4.4.1 in full, same $id       T5
├─ scripts/policy-type-options.ts                    (new) the generator's banner and options,
│                                                    imported by the script AND the drift test  T5
├─ scripts/generate-policy-type.ts                   imports the two constants instead of
│                                                    declaring them inline                     T5
├─ src/posting/policy.ts                             regenerated, committed                    T5
├─ src/posting/evaluate.ts                           each_tax, document, full when / account /
│                                                    amount / dimensions / sign normalisation  T6
└─ test/posting/
   ├─ validate-policy.test.ts                        extended: the spec:2008–2028 example      T5
   ├─ policy-type.test.ts                            extended: the regenerated type            T5
   ├─ sales-invoice.fixture.json                     spec:2008–2028, verbatim                  T5
   └─ evaluate.test.ts                               extended: the full evaluator              T6

packages/contracts/
├─ permissions.ts                                    + accounting.party.manage                 T4
├─ src/accounting/document.ts                        + partyId and the line columns; the
│                                                    documentTypeCode restriction dropped      T9
├─ src/accounting/party.ts                           (new, amendment A2)                       T11
├─ src/admin/document-type.ts                        (new, amendment A2)                       T10
└─ src/index.ts                                      re-exports the two new modules         T10, T11

packages/db/seed/roles.ts                            `user` gains accounting.party.manage      T4

apps/api/
├─ src/middleware/require-document-permission.ts     (new, amendment A4)                       T9
├─ src/routes/accounting/documents.ts                policy-resolved gates; the new body       T9
├─ src/routes/accounting/parties.ts                  (new)                                     T11
├─ src/routes/admin/document-types.ts                (new)                                     T10
├─ src/routes/index.ts                               two new RouteModule entries;
│                                                    DOCUMENT_STAGE_CODES on documents      T9→T11
└─ test/routes/
   ├─ accounting/documents.test.ts                   extended: policy-resolved gates;          T9
   │                                                 1A's drafter case rewritten, 1A's
   │                                                 documentTypeCode pin case deleted
   ├─ accounting/documents.branch.test.ts            spec:1066 through the API                 T12
   ├─ accounting/parties.test.ts                     (new)                                     T11
   ├─ admin/document-types.test.ts                   (new)                                     T10
   └─ accounting/zero-code.test.ts                   test 15's mechanism clauses               T13

tests/
├─ invariants/probes.ts                              two new PROBES entries                 T10, T11
└─ regression/
   ├─ sah-013.test.ts                                append "— 2A"                             T14
   ├─ sah-072.test.ts                                append "— 2A"                             T14
   └─ sah-078.test.ts                                append "— 2A"                             T14

docs/adr/
├─ 0026-posting-policy-schema.md                     PROPOSAL (spec:95, spec:2006)             T5
└─ 0027-posting-policy-versions-are-append-only.md   PROPOSAL (spec:95)                        T10

docs/ui/
└─ phase-2a-party-api-surface.md                     OWNER GATE OD-24 — no screen ships here   T15
```

**0028 is allocated to this slice and stays unused** — contracts §3.9 allocates 0026–0028 to 2A and §3.4.1's
rule for migration numbers applies to ADR numbers too: an unused number stays unused rather than being lent
to 2B. Nothing in this slice needs a third ADR: the `party` `kind` discriminator is decided by spec:1169 and
contracts §4.5.7, the ten `document_line` columns by §4.3.4, and the reversal mechanism by D13.

---

### Task 1: Migration `0017_create_party.sql`: `app.party`, and the `seedParty` fixture

`app.party` is the table spec:1169 promises when it replaces the legacy `Account`'s twenty `Is*` flags: "**Account** (GL only) + **Party**". One table, one `kind` discriminator, five values — `customer`, `vendor`, `employee`, `student`, `dealer` — of which `student` and `dealer` are reserved names carried so a later module needs no migration (F-16). The receivable and payable account links are what the posting policy's `party.receivable_account` and `party.payable_account` references resolve against (contracts §4.4.1).

The DDL is contracts §4.5.7 **verbatim**. Nothing here is a choice: the columns, the CHECK, the two unique keys and the four foreign keys are frozen.

**Files:**
- Create: `packages/db/migrations/0017_create_party.sql`, `packages/db/migrations/0017.down.sql`, `packages/db/src/schema/party.ts`, `packages/db/test/party.test.ts`
- Modify: `packages/db/test/fixtures.ts`

**Interfaces:**
- Produces (SQL): `app.party` exactly as contracts §4.5.7.
- Produces (TS): `packages/db/src/schema/party.ts` — the Drizzle mirror `party`; `packages/db/test/fixtures.ts` — `export async function seedParty(db: Db, s: Seed, opts?: SeedPartyOptions): Promise<string>` and `export interface SeedPartyOptions { kind?: "customer" | "vendor" | "employee" | "student" | "dealer"; code?: string; nameEn?: string; receivableAccountId?: string; payableAccountId?: string }` (contracts §4.17 — `seedParty` is 2A's, returns the party id, uniform `(db, s, opts?)` shape).
- Consumes: `startDb`, `Db`, `Seed`, `seedTenant`, `uuidv7`, the 4-argument test `withTenant` (§4.1); `lintSchema`, `Violation` (§4.1); `seedAccount` (1A, §4.17); `app_meta.enable_tenant_rls`, `app_meta.attach_audit` (§4.1).

**`seedParty` creates `1200`/`2100` when the tenant has no chart, and never re-seeds a pack.** contracts §4.17 fixes the defaults as "`kind: 'customer'` with `1200`/`2100` (§4.15)", and §4.15 assigns both codes to **0C**'s `0c-base.json`. A `seedTenant`/`seedTenantV2` tenant has only `1000` and `4000` (plan0A) plus `5920` (1A) — the seed pack does not run in a unit test. So the fixture *selects* the account by code and creates it through 1A's `seedAccount` only when it is absent. That is a fixture creating a fixture row, not a slice re-seeding another slice's pack (hazard 33 governs seed packs and policies; §4.17 explicitly mandates these two defaults).

- [ ] **Step 1: Write the failing test `packages/db/test/party.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { seedParty, seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("app.party — contracts §4.5.7, spec:1169 (SAH-072: one discriminator, not twenty Is* flags)", () => {
  let db: Db; let a: Seed; let b: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenant(db, "Alpha"); b = await seedTenant(db, "Beta"); });
  afterAll(async () => { await db.stop(); });

  it("seeds a customer with the 1200/2100 control accounts and stamps created_at", async () => {
    const id = await seedParty(db, a);
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ kind: string; code: string; name_en: string; receivable: string | null; payable: string | null; archived_at: string | null }[]>`
        select p.kind, p.code, p.name_en,
               r.code as receivable, y.code as payable, p.archived_at::text as archived_at
          from app.party p
          left join app.account r on r.id = p.receivable_account_id
          left join app.account y on y.id = p.payable_account_id
         where p.id = ${id}`);
    expect(row).toEqual({ kind: "customer", code: "P-0001", name_en: "Alpha customer", receivable: "1200", payable: "2100", archived_at: null });
  });

  it("accepts the five kinds and refuses a sixth", async () => {
    for (const kind of ["customer", "vendor", "employee", "student", "dealer"] as const) {
      await expect(seedParty(db, a, { kind, code: `K-${kind}` })).resolves.toMatch(/^[0-9a-f-]{36}$/);
    }
    await expect(seedParty(db, a, { kind: "supplier" as never, code: "K-supplier" })).rejects.toThrow(/party_kind_check/);
  });

  it("refuses a duplicate code inside one company and allows the same code in another tenant", async () => {
    await seedParty(db, a, { code: "DUP" });
    await expect(seedParty(db, a, { code: "DUP" })).rejects.toThrow(/party_company_id_code_key/);
    await expect(seedParty(db, b, { code: "DUP" })).resolves.toBeDefined();
  });

  it("refuses a receivable account belonging to another tenant (the composite FK)", async () => {
    const foreign = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ id: string }[]>`select id from app.account where company_id = ${b.company} and code = '1000'`);
    await expect(seedParty(db, a, { code: "XFK", receivableAccountId: foreign[0]!.id }))
      .rejects.toThrow(/party_tenant_id_receivable_account_id_fkey/);
  });

  it("tenant B cannot see, update or delete tenant A's party (spec:106)", async () => {
    const id = await seedParty(db, a, { code: "ISO" });
    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ id: string }[]>`select id from app.party where id = ${id}`);
    expect(seen).toEqual([]);
    const updated = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx`update app.party set name_en = 'stolen' where id = ${id}`);
    expect(updated.count).toBe(0);
  });

  it("every write is audited with the acting principal (spec:106, SAH-030)", async () => {
    const id = await seedParty(db, a, { code: "AUD" });
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ op: string; actor_id: string }[]>`
        select op, actor_id from app.audit_log where table_name = 'party' and row_id = ${id} order by seq`);
    expect(rows).toEqual([{ op: "INSERT", actor_id: a.human }]);
  });

  it("archival is an update, never a delete (spec:2049)", async () => {
    const id = await seedParty(db, a, { code: "ARC" });
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.party set archived_at = now() where id = ${id}`);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`delete from app.party where id = ${id}`))
      .rejects.toThrow(/permission denied/);
  });

  it("the schema linter reports zero violations", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations).toEqual([]);
  });

  it("uuidv7 ids are time-ordered, never sequential integers (spec:2037)", async () => {
    const first = await seedParty(db, a, { code: "ORD-1" });
    const second = await seedParty(db, a, { code: "ORD-2" });
    expect(first < second).toBe(true);
    const [col] = await db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'party' and column_name = 'id'`;
    expect(col!.data_type).toBe("uuid");
    void uuidv7;
  });
});
```

Run: `bun run --cwd packages/db test -- test/party.test.ts`
Expected: **FAIL** — `relation "app.party" does not exist` on the first `select`, and `seedParty is not exported` at import time.

- [ ] **Step 2: Write `packages/db/migrations/0017_create_party.sql`**

```sql
-- ── 1. app.party — the entity spec:1169 splits out of the legacy Account's twenty Is* flags ───
-- Party is a SINGLE table with one `kind` discriminator (SAH-072: "one discriminator, not 30 booleans").
-- `student` and `dealer` are reserved so a later module is data, not a migration (contracts §4.5.7, F-16).
create table app.party (
  id                     uuid primary key default uuidv7(),
  tenant_id              uuid not null references app.tenant(id),
  company_id             uuid not null,
  kind                   text not null constraint party_kind_check
                           check (kind in ('customer', 'vendor', 'employee', 'student', 'dealer')),
  code                   text not null,
  name_en                text not null,
  name_ar                text,                                     -- bilingual master data as columns, not a blob (spec:2045)
  receivable_account_id  uuid,                                     -- policy path party.receivable_account (contracts §4.4.1)
  payable_account_id     uuid,                                     -- policy path party.payable_account
  currency               char(3),                                  -- statement currency; null means the company's base currency
  tax_registration       text,
  email                  text,
  phone                  text,
  address                jsonb not null default '{}'::jsonb,
  archived_at            timestamptz,                              -- master data is archived, never deleted (spec:2049)
  created_at             timestamptz not null default now(),
  constraint party_company_id_code_key unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)            references app.company(tenant_id, id),
  foreign key (tenant_id, receivable_account_id) references app.account(tenant_id, id),
  foreign key (tenant_id, payable_account_id)    references app.account(tenant_id, id)
);

-- ── 2. Tenancy and audit (spec:106; contracts §3.5.1) ────────────────────────
call app_meta.enable_tenant_rls('app.party');
call app_meta.attach_audit('app.party');

-- ── 3. The lookups the party API and the posting snapshot make (SAH-070: index what filters) ──
create index party_company_kind_idx on app.party (company_id, kind) where archived_at is null;

-- app_rw receives select, insert, update through default privileges (plan0A). No DELETE grant:
-- contracts §3.5.4 pins the DELETE list and 2B is the only slice that extends it.
```

`packages/db/migrations/0017.down.sql`:

```sql
drop index if exists app.party_company_kind_idx;
drop table if exists app.party;
```

- [ ] **Step 3: Write the Drizzle mirror `packages/db/src/schema/party.ts`**

The mirror is the diff source for the next slice that alters this table (4A adds `credit_limit`, `payment_term_id`, `credit_hold`; 9B adds `legacy_ref`) — ADR-0002, contracts §3.4.9.

```ts
import { relations } from "drizzle-orm";
import { char, index, jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { account } from "./account";
import { company } from "./company";

const app = pgSchema("app");

export const party = app.table(
  "party",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    kind: text("kind").notNull().$type<"customer" | "vendor" | "employee" | "student" | "dealer">(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    receivableAccountId: uuid("receivable_account_id"),
    payableAccountId: uuid("payable_account_id"),
    currency: char("currency", { length: 3 }),
    taxRegistration: text("tax_registration"),
    email: text("email"),
    phone: text("phone"),
    address: jsonb("address").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [unique("party_company_id_code_key").on(t.companyId, t.code), index("party_company_kind_idx").on(t.companyId, t.kind)],
);

export const partyRelations = relations(party, ({ one }) => ({
  company: one(company, { fields: [party.companyId], references: [company.id] }),
  receivableAccount: one(account, { fields: [party.receivableAccountId], references: [account.id] }),
  payableAccount: one(account, { fields: [party.payableAccountId], references: [account.id] }),
}));
```

- [ ] **Step 4: Add `seedParty` to `packages/db/test/fixtures.ts`**

Append below 1A's `seedAccount`. **`seedTenant` is never edited** (contracts §4.1, hazard 9) — this is a new export beside it.

```ts
export interface SeedPartyOptions {
  kind?: "customer" | "vendor" | "employee" | "student" | "dealer";
  code?: string;
  nameEn?: string;
  receivableAccountId?: string;
  payableAccountId?: string;
}

/** contracts §4.17 — 2A's helper. Defaults to a customer wired to the §4.15 control accounts 1200/2100,
 *  which 0C's seed pack owns; a unit-test tenant has no pack, so the fixture creates them once through
 *  1A's seedAccount and reuses them afterwards. Returns the party id. */
export async function seedParty(db: Db, s: Seed, opts: SeedPartyOptions = {}): Promise<string> {
  const control = async (code: string, nameEn: string, type: "asset" | "liability"): Promise<string> => {
    const [found] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ id: string }[]>`select id from app.account where company_id = ${s.company} and code = ${code}`);
    return found ? found.id : seedAccount(db, s, { code, nameEn, type });
  };
  const id = await uuidv7(db.admin);
  const receivable = opts.receivableAccountId ?? (await control("1200", "Trade receivables", "asset"));
  const payable = opts.payableAccountId ?? (await control("2100", "Trade payables", "liability"));
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.party (id, tenant_id, company_id, kind, code, name_en, receivable_account_id, payable_account_id)
    values (${id}, ${s.tenant}, ${s.company}, ${opts.kind ?? "customer"}, ${opts.code ?? "P-0001"},
            ${opts.nameEn ?? "Alpha customer"}, ${receivable}, ${payable})`);
  return id;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/party.test.ts`
Expected: **PASS** (9 tests). If the duplicate-code test fails with a differently named constraint, the `constraint party_company_id_code_key` clause was dropped from the DDL — PostgreSQL's auto-generated name happens to match here, but 4A's migration references the name and must not depend on that.

Run: `bun run --cwd packages/db test`
Expected: PASS — the whole `packages/db` suite, including Plan 0A's reversibility test, which now walks 0017 up and down.

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat(db): app.party — one entity with one kind discriminator [2A T1]

spec:1169 splits the legacy Account's twenty Is* flags into a GL-only Account
and a Party; SAH-072 is what a discriminator replaces. The receivable and
payable links are what the posting policy's party.receivable_account and
party.payable_account references resolve against (contracts §4.4.1). Archived,
never deleted (spec:2049); no DELETE grant, so §3.5.4's pinned list is unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration `0018_alter_document_party_fk_and_document_type_module.sql`: the deferred FK and the `document_type` additions

Migration 0001 created `app.document.party_id` with the comment "FK `(tenant_id, party_id)` → `app.party` is added by the Phase 2 migration" (spec:1759). This is that migration. The same file carries the two `document_type` columns contracts §4.3.4 assigns to 2A — `module` and `archived_at` — because 2A's four files exhaust 0017–0020 and 0021 belongs to 2B; contracts §3.4.3 allows one file to do both and §3.4.2 requires the file name to say so.

`document_type.module` answers exactly one question: **which module's read permission may download this document's attachments** (contracts §4.5.8, §4.14). It is **not** the module segment of `approval.post` — `PAYROLL_PAYMENT` posts under `accounting.payment.post` and is `hr` because its attachments carry per-employee pay. The column's `default 'accounting'` exists only so this `ALTER` can run against live rows; every seed file sets it explicitly and 1A's loader is widened here to insert it.

**Files:**
- Create: `packages/db/migrations/0018_alter_document_party_fk_and_document_type_module.sql`, `packages/db/migrations/0018.down.sql`, `packages/db/test/document-party-fk.test.ts`
- Modify: `packages/db/src/schema/document.ts`, `packages/db/src/schema/document_type.ts`, `packages/db/src/seed/document-types.ts`, `packages/db/test/seed/document-types.test.ts`

**Interfaces:**
- Produces (SQL): `alter table app.document add constraint document_party_fk foreign key (tenant_id, party_id) references app.party(tenant_id, id)` (contracts §4.5.7, spec:1759); `app.document_type.module text not null default 'accounting' check (module in ('accounting','inventory','hr','pos'))` and `app.document_type.archived_at timestamptz` (contracts §4.3.4).
- Produces (TS): the two Drizzle mirrors extended; `loadDocumentTypes` inserting `module` from the envelope. Signature unchanged: `loadDocumentTypes(sql: Sql, ctx: TenantContext, packDir: string, catalogue: readonly string[]): Promise<DocumentTypeSeedResult[]>` (contracts §4.3.7, 1A).
- Consumes: `startDb`, `Db`, `Seed`, `seedTenant`, `seedTenantV2`, `draftDocument`, `uuidv7`, the test `withTenant`, `lintSchema` (§4.1, 1A); `seedParty` (Task 1); `loadDocumentTypes`, `DocumentTypeSeedResult` (1A).

- [ ] **Step 1: Write the failing test `packages/db/test/document-party-fk.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { draftDocument, seedParty, seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

describe("document.party_id FK and document_type.module — spec:1759, contracts §4.3.4, §4.5.8", () => {
  let db: Db; let a: Seed; let b: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenant(db, "Alpha"); b = await seedTenant(db, "Beta"); });
  afterAll(async () => { await db.stop(); });

  it("a document may point at a party of its own tenant", async () => {
    const party = await seedParty(db, a, { code: "FK-OK" });
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set party_id = ${party} where id = ${doc}`);
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ party_id: string }[]>`select party_id from app.document where id = ${doc}`);
    expect(row!.party_id).toBe(party);
  });

  it("a document cannot point at another tenant's party — the composite FK, not a tenant_id check", async () => {
    const foreign = await seedParty(db, b, { code: "FK-X" });
    const doc = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`update app.document set party_id = ${foreign} where id = ${doc}`)).rejects.toThrow(/document_party_fk/);
  });

  it("party_id stays nullable — a JOURNAL has no party", async () => {
    const [col] = await db.admin<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'document' and column_name = 'party_id'`;
    expect(col!.is_nullable).toBe("YES");
  });

  it("document_type.module defaults to accounting on the rows migration 0001 and Plan 0A left behind", async () => {
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ code: string; module: string; archived_at: string | null }[]>`
        select code, module, archived_at::text as archived_at from app.document_type where id = ${a.docType}`);
    expect(row).toEqual({ code: "JOURNAL", module: "accounting", archived_at: null });
  });

  it("document_type.module admits exactly the four modules of the attachment download map", async () => {
    for (const module of ["accounting", "inventory", "hr", "pos"]) {
      const updated = await withTenant(db.rw, a.tenant, a.human, (tx) =>
        tx`update app.document_type set module = ${module} where id = ${a.docType}`);
      expect(updated.count).toBe(1);
    }
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`update app.document_type set module = 'admin' where id = ${a.docType}`)).rejects.toThrow(/document_type_module_check/);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document_type set module = 'accounting' where id = ${a.docType}`);
  });

  it("the schema linter reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

Run: `bun run --cwd packages/db test -- test/document-party-fk.test.ts`
Expected: **FAIL** — the cross-tenant update succeeds (no `document_party_fk` yet) and `column "module" does not exist`.

- [ ] **Step 2: Write `packages/db/migrations/0018_alter_document_party_fk_and_document_type_module.sql`**

```sql
-- ── 1. The foreign key migration 0001 deferred (spec:1759) ───────────────────
-- app.document.party_id has existed since 0001 with the comment "FK (tenant_id, party_id) → app.party is
-- added by the Phase 2 migration". app.party landed in 0017; this is that key. Composite, never plain:
-- a plain FK to app.party(id) would let one tenant's document name another tenant's party (contracts §3.5.1).
alter table app.document
  add constraint document_party_fk
  foreign key (tenant_id, party_id) references app.party(tenant_id, id);

-- ── 2. document_type.module — the attachment download gate, and nothing else (contracts §4.5.8, §4.14) ──
-- Which module's READ permission may see this document's attachments: the module of the team that files them.
-- NOT the module segment of approval.post — PAYROLL_PAYMENT posts under accounting.payment.post and is 'hr'.
-- The default exists only so this ALTER can run against live rows; every seed file sets it explicitly.
alter table app.document_type
  add column module text not null default 'accounting'
    constraint document_type_module_check check (module in ('accounting', 'inventory', 'hr', 'pos'));

-- ── 3. document_type.archived_at — master data is archived, never deleted (spec:2049) ──
alter table app.document_type add column archived_at timestamptz;
```

`packages/db/migrations/0018.down.sql`:

```sql
-- A down that dropped app.document or app.document_type would break contracts §3.4.5: a migration adding a
-- column to a 0001 table drops ONLY that column.
alter table app.document_type drop column if exists archived_at;
alter table app.document_type drop constraint if exists document_type_module_check;
alter table app.document_type drop column if exists module;
alter table app.document drop constraint if exists document_party_fk;
```

- [ ] **Step 3: Extend the two Drizzle mirrors**

In `packages/db/src/schema/document_type.ts`, add to the column object, after `nameAr`:

```ts
    module: text("module").notNull().$type<"accounting" | "inventory" | "hr" | "pos">(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
```

In `packages/db/src/schema/document.ts`, add the relation so a read can join the party (the column itself already exists from 0B's mirror). Add this import at the top of the file:

```ts
import { party } from "./party";
```

and this member inside the object `documentRelations` returns, beside its existing `company` and `documentType` members:

```ts
  party: one(party, { fields: [document.partyId], references: [party.id] }),
```

- [ ] **Step 4: Widen `loadDocumentTypes` to insert `module`**

1A's loader validates the envelope's `module` and deliberately does not insert it, because the column did not exist: contracts §4.3.7 says "**2A widens the insert list in that PR**". In `packages/db/src/seed/document-types.ts`, change the `document_type` insert to:

```ts
    await tx`
      insert into app.document_type (id, tenant_id, company_id, code, name_en, name_ar, module)
      values (${typeId}, ${ctx.tenantId}, ${companyId}, ${envelope.code}, ${envelope.nameEn},
              ${envelope.nameAr ?? null}, ${envelope.module})
      on conflict (company_id, code) do nothing`;
```

and add one case to `packages/db/test/seed/document-types.test.ts`:

```ts
  it("the envelope's module reaches the column the attachment gate reads (contracts §4.5.8)", async () => {
    await withTenant(db.rw, a.tenant, a.system, (tx) => loadDocumentTypes(tx, ctx, packDir, catalogue));
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ module: string }[]>`select module from app.document_type where company_id = ${a.company} and code = 'JOURNAL'`);
    expect(row!.module).toBe("accounting");
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/document-party-fk.test.ts test/seed/document-types.test.ts`
Expected: **PASS** (7 tests). If the cross-tenant update still succeeds, the constraint was written against `app.party(id)` rather than `app.party(tenant_id, id)`.

Run: `bun run --cwd packages/db test && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat(db): the deferred document.party_id FK and document_type.module [2A T2]

spec:1759 left the composite FK for Phase 2; app.party landed in 0017. The same
file carries document_type.module and archived_at (contracts §4.3.4) because 2A's
four migrations exhaust 0017-0020 and §3.4.3 allows one file to do both. `module`
is the attachment download gate of §4.5.8 and nothing else; 1A's document-types
loader now inserts it from the envelope, as §4.3.7 says it would.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration `0019_alter_document_line_generalise.sql`: one line table for every document

1A shipped `app.document_line` as the journal shape — `account_id`, `debit`, `credit`, `dimensions`, `custom_fields`. spec:1185 is the target: "**Document** / **DocumentLine** (with `InventoryMovement`) — One document model for everything". This migration adds the ten columns contracts §4.3.4 assigns to 2A, all nullable or defaulted, so it is an **expand** step against a live table (contracts §3.4.7).

Two of them are foreign keys this slice deliberately does **not** add: `item_id` gets `(tenant_id, item_id) → app.item` in 3A's migration 0032 and `tax_code_id` gets `(tenant_id, tax_code_id) → app.tax_code` in 5A's 0055. Until then the columns are unconstrained uuids, which is why Task 9 does **not** accept them through the API — a dangling uuid written today is a row 3A's `ALTER … ADD FOREIGN KEY` would refuse tomorrow.

The `kind` CHECK is given an explicit name. 6A's migration 0061 and 8B's 0087 both execute `alter table app.document_line drop constraint document_line_kind_check` and re-add it with the full label union; either may run first (spec:2301), so neither may depend on a generated name.

**Files:**
- Create: `packages/db/migrations/0019_alter_document_line_generalise.sql`, `packages/db/migrations/0019.down.sql`, `packages/db/test/document-line-generalised.test.ts`
- Modify: `packages/db/src/schema/document_line.ts`

**Interfaces:**
- Produces (SQL): the ten columns of contracts §4.3.4's 2A row on `app.document_line`, with the named constraint `document_line_kind_check`.
- Produces (TS): the extended Drizzle mirror.
- Consumes: `startDb`, `Db`, `Seed`, `seedTenant`, `draftDocument`, `uuidv7`, the test `withTenant`, `lintSchema` (§4.1).

- [ ] **Step 1: Write the failing test `packages/db/test/document-line-generalised.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { draftDocument, seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("app.document_line generalised — contracts §4.3.4 (2A row), spec:1185", () => {
  let db: Db; let a: Seed; let doc: string;
  beforeAll(async () => {
    db = await startDb(); a = await seedTenant(db, "Alpha"); doc = await draftDocument(db, a);
  });
  afterAll(async () => { await db.stop(); });

  const insert = (lineNo: number, extra: Record<string, unknown> = {}) =>
    withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document_line ${tx({
        id, tenant_id: a.tenant, company_id: a.company, document_id: doc, line_no: lineNo, ...extra,
      })}`;
      return id;
    });

  it("an existing journal line keeps working and reads back as kind 'account' with zeroed money columns", async () => {
    const id = await insert(1, { account_id: a.cash, debit: "10.0000" });
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<Record<string, string | null>[]>`
        select kind, item_id, quantity::text as quantity, unit_price::text as unit_price,
               discount::text as discount, amount::text as amount, tax_code_id,
               tax_amount::text as tax_amount, total_incl_tax::text as total_incl_tax, cost::text as cost
          from app.document_line where id = ${id}`);
    expect(row).toEqual({
      kind: "account", item_id: null, quantity: null, unit_price: null,
      discount: "0.0000", amount: "0.0000", tax_code_id: null,
      tax_amount: "0.0000", total_incl_tax: "0.0000", cost: null,
    });
  });

  it("an item line carries a quantity at scale 6 and money at scale 4", async () => {
    const item = await uuidv7(db.admin);
    const id = await insert(2, {
      kind: "item", item_id: item, quantity: "3.500000", unit_price: "12.3456",
      discount: "1.0000", amount: "42.2096", tax_amount: "2.5326", total_incl_tax: "44.7422",
    });
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ kind: string; item_id: string; quantity: string; unit_price: string; total_incl_tax: string }[]>`
        select kind, item_id, quantity::text as quantity, unit_price::text as unit_price,
               total_incl_tax::text as total_incl_tax from app.document_line where id = ${id}`);
    expect(row).toEqual({ kind: "item", item_id: item, quantity: "3.500000", unit_price: "12.3456", total_incl_tax: "44.7422" });
  });

  it("kind admits exactly account, item, tax and text at this slice", async () => {
    for (const kind of ["account", "item", "tax", "text"]) {
      await expect(insert(100 + kind.length + kind.charCodeAt(0), { kind })).resolves.toBeDefined();
    }
    await expect(insert(200, { kind: "tender" })).rejects.toThrow(/document_line_kind_check/);
    await expect(insert(201, { kind: "payroll" })).rejects.toThrow(/document_line_kind_check/);
  });

  it("the kind CHECK carries the exact name 6A's 0061 and 8B's 0087 both drop", async () => {
    const rows = await db.admin<{ conname: string }[]>`
      select conname from pg_constraint
       where conrelid = 'app.document_line'::regclass and conname = 'document_line_kind_check'`;
    expect(rows).toHaveLength(1);
  });

  it("item_id and tax_code_id carry NO foreign key yet — 3A's 0032 and 5A's 0055 add them", async () => {
    const rows = await db.admin<{ conname: string }[]>`
      select conname from pg_constraint
       where conrelid = 'app.document_line'::regclass and contype = 'f'
         and pg_get_constraintdef(oid) like '%item%'`;
    expect(rows).toEqual([]);
    await expect(insert(300, { kind: "item", item_id: await uuidv7(db.admin) })).resolves.toBeDefined();
  });

  it("document_line has no branch_id and never gains one (contracts §4.5.6)", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'document_line' and column_name like '%branch%'`;
    expect(cols).toEqual([]);
  });

  it("the schema linter reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

Run: `bun run --cwd packages/db test -- test/document-line-generalised.test.ts`
Expected: **FAIL** — `column "kind" of relation "document_line" does not exist`.

- [ ] **Step 2: Write `packages/db/migrations/0019_alter_document_line_generalise.sql`**

```sql
-- ── 1. One line table for every document (spec:1185; contracts §4.3.4, the 2A row) ──
-- Every column is nullable or defaulted: this is the EXPAND half of expand/contract on a live table
-- (spec:2057, contracts §3.4.7). Nothing is renamed and nothing is dropped.
alter table app.document_line
  add column kind            text not null default 'account',
  add column item_id         uuid,                                  -- FK (tenant_id, item_id) → app.item in 3A's 0032
  add column quantity        numeric(19,6),                         -- item base unit; entered unit lands in 3A's 0032
  add column unit_price      numeric(19,4),
  add column discount        numeric(19,4) not null default 0,
  add column amount          numeric(19,4) not null default 0,      -- excluding tax, in the document currency
  add column tax_code_id     uuid,                                  -- FK (tenant_id, tax_code_id) → app.tax_code in 5A's 0055
  add column tax_amount      numeric(19,4) not null default 0,
  add column total_incl_tax  numeric(19,4) not null default 0,
  add column cost            numeric(19,4);                         -- written by the costing engine at post (3B)

-- ── 2. The kind vocabulary, NAMED so 6A's 0061 and 8B's 0087 can drop it by name ──
-- Those two files each re-add the CHECK with the identical complete union
-- ('account','item','tax','text','tender','payroll'); either phase may execute first (spec:2301), so
-- neither may rely on a generated constraint name (contracts §4.3.4).
alter table app.document_line
  add constraint document_line_kind_check check (kind in ('account', 'item', 'tax', 'text'));

-- ── 3. The lookups the snapshot and the reports make (SAH-070) ───────────────
create index document_line_item_idx on app.document_line (item_id) where item_id is not null;

-- No branch key: a line is isolated through its parent document's own branch_isolation policy
-- (contracts §4.5.6 — "document_line is deliberately absent"). BRANCH lives on document.branch_id.
```

`packages/db/migrations/0019.down.sql`:

```sql
drop index if exists app.document_line_item_idx;
alter table app.document_line drop constraint if exists document_line_kind_check;
alter table app.document_line
  drop column if exists cost,
  drop column if exists total_incl_tax,
  drop column if exists tax_amount,
  drop column if exists tax_code_id,
  drop column if exists amount,
  drop column if exists discount,
  drop column if exists unit_price,
  drop column if exists quantity,
  drop column if exists item_id,
  drop column if exists kind;
```

- [ ] **Step 3: Extend `packages/db/src/schema/document_line.ts`**

Add to the column object, after `dimensions` and `customFields`:

```ts
    kind: text("kind").notNull().$type<"account" | "item" | "tax" | "text">(),
    itemId: uuid("item_id"),
    quantity: numeric("quantity", { precision: 19, scale: 6 }),
    unitPrice: numeric("unit_price", { precision: 19, scale: 4 }),
    discount: numeric("discount", { precision: 19, scale: 4 }).notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    taxCodeId: uuid("tax_code_id"),
    taxAmount: numeric("tax_amount", { precision: 19, scale: 4 }).notNull(),
    totalInclTax: numeric("total_incl_tax", { precision: 19, scale: 4 }).notNull(),
    cost: numeric("cost", { precision: 19, scale: 4 }),
```

and add `index` and `numeric` to the `drizzle-orm/pg-core` import, plus `index("document_line_item_idx").on(t.itemId)` to the table's constraint array. `kind`'s `$type` is the **four** labels this migration admits; 6A and 8B widen it when they widen the CHECK.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/document-line-generalised.test.ts`
Expected: **PASS** (7 tests). If the "no foreign key yet" case fails, a composite FK to `app.item` was added — remove it: `app.item` does not exist until 3A and the migration would not apply.

Run: `bun run --cwd packages/db test && bun run typecheck && bun run lint`
Expected: PASS — 1A's `document-line.test.ts`, `posting/*.test.ts` and Plan 0A's reversibility test all still green.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat(db): generalise document_line — one line table for every document [2A T3]

spec:1185 replaces the legacy Bill/BillItems and Voucher/VouItems split with one
document model. The ten columns are contracts §4.3.4's 2A row, all nullable or
defaulted (the expand half of expand/contract, spec:2057). item_id and
tax_code_id get their composite FKs in 3A's 0032 and 5A's 0055; the kind CHECK
carries the name both 6A's 0061 and 8B's 0087 drop by name.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Migration `0020_seed_permission_phase2a.sql`: `accounting.party.manage` and its one role grant

`app.permission` is global (no RLS, read-only for `app_rw`) and is therefore the one table a migration may write (contracts §3.4.8, hazard 10). This slice introduces exactly one code, `accounting.party.manage` (contracts §3.6.2). It is **mutating**.

The seeded role that receives it is `user`, and only `user`. spec:2159 gives the general back-office clerk "maintain customers and vendors (credit terms included)" and no other role's row claims party maintenance; spec:2178's R7 names the pair explicitly — "`user` is a drafting role and holds `*.create` and `accounting.party.manage`, which are mutating by definition". `admin` receives it automatically because `admin.permissions` is computed from `PERMISSIONS` (contracts §3.6.4). `auditor` must not receive it and the `role-seed` lint proves that.

**Files:**
- Create: `packages/db/migrations/0020_seed_permission_phase2a.sql`, `packages/db/migrations/0020.down.sql`
- Modify: `packages/contracts/permissions.ts`, `packages/db/seed/roles.ts`, `packages/db/test/permission-catalogue.test.ts`

**Interfaces:**
- Produces (SQL): one row in `app.permission` — `('accounting.party.manage', 'accounting', true, …)`.
- Produces (TS): one `PermissionDef` in `PERMISSIONS` with `phase: "2A"`; `accounting.party.manage` appended to the `user` role's `permissions` array in `ROLES`.
- Consumes: `PERMISSIONS`, `PermissionDef`, `PERMISSION` (§4.2.5, 0B); `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` (§4.2.5, 0D); `startDb`, `Db` (§4.1).

- [ ] **Step 1: Extend the failing test `packages/db/test/permission-catalogue.test.ts`**

0B's file already asserts set equality in both directions between `app.permission` and `PERMISSIONS`; adding the catalogue entry without the migration breaks it, and adding the migration without the entry breaks it the other way. Add one case that pins this slice's contribution by name so a future edit cannot silently drop it:

```ts
  it("2A introduces exactly accounting.party.manage, and it is mutating (contracts §3.6.2)", async () => {
    const mine = [...PERMISSIONS].filter((p) => p.phase === "2A");
    expect(mine.map((p) => p.code)).toEqual(["accounting.party.manage"]);
    expect(mine[0]!.mutating).toBe(true);
    expect(mine[0]!.module).toBe("accounting");
    const rows = await db.admin<{ module: string; mutating: boolean }[]>`
      select module, mutating from app.permission where code = 'accounting.party.manage'`;
    expect(rows).toEqual([{ module: "accounting", mutating: true }]);
  });

  it("only `user` is seeded with it; `auditor` holds no mutating code (spec:2159, R7 spec:2178)", () => {
    const holders = [...ROLES].filter((r) => r.code !== "admin" && r.permissions.includes("accounting.party.manage"));
    expect(holders.map((r) => r.code)).toEqual(["user"]);
    const auditor = [...ROLES].find((r) => r.code === "auditor")!;
    expect(auditor.permissions).not.toContain("accounting.party.manage");
  });
```

Add `ROLES` to the file's imports (`import { ROLES } from "../seed/roles";`) beside the existing `PERMISSIONS` import.

Run: `bun run --cwd packages/db test -- test/permission-catalogue.test.ts`
Expected: **FAIL** — `expected [] to equal [ 'accounting.party.manage' ]`.

- [ ] **Step 2: Add the entry to `packages/contracts/permissions.ts`**

Append inside the `PERMISSIONS` array, after 1B's `accounting.report.read` entry:

```ts
  {
    code: "accounting.party.manage",
    module: "accounting",
    mutating: true,
    description: "Create, edit and archive customers, vendors and other parties",
    phase: "2A",
  },
```

- [ ] **Step 3: Grant it to `user` in `packages/db/seed/roles.ts`**

In the `user` entry, append `"accounting.party.manage"` to `permissions`. Change nothing else: `INCOMPATIBLE_PAIRS` is unchanged (spec:2177 names four pairs and none involves this code), and `admin.permissions` is computed.

- [ ] **Step 4: Write `packages/db/migrations/0020_seed_permission_phase2a.sql`**

```sql
-- ── 1. The Phase 2A permission catalogue entry (contracts §3.6.2, spec:2146) ──
-- app.permission is global (no RLS) and is the one table a migration may write: FORCE ROW LEVEL SECURITY
-- binds app_migrator too (spec:1366), so per-tenant rows — roles, document types, policies — are seed-pack
-- data applied by `bun run seed --tenant` (contracts §3.4.8).
insert into app.permission (code, module, mutating, description) values
  ('accounting.party.manage', 'accounting', true, 'Create, edit and archive customers, vendors and other parties')
on conflict (code) do update
  set module = excluded.module, mutating = excluded.mutating, description = excluded.description;
```

`packages/db/migrations/0020.down.sql`:

```sql
delete from app.permission where code = 'accounting.party.manage';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/permission-catalogue.test.ts`
Expected: **PASS** (0B's cases plus the two above).

Run: `bun run --cwd packages/db test && bun run typecheck && bun run lint`
Expected: PASS.

Run: `bun run lint:rules`
Expected: **exactly one violation**, `permission-catalogue … accounting.party.manage has no reference`. That is the documented window of the Global Constraints; Task 11 closes it when the party route registers the code. No other rule may report anything.

- [ ] **Step 6: Commit**

```bash
git add packages/db packages/contracts
git commit -m "$(cat <<'EOF'
chore(seed): accounting.party.manage and its one role grant [2A T4]

The slice's only new permission code (contracts §3.6.2). Seeded to `user` alone:
spec:2159 gives the back-office clerk customer and vendor maintenance and
spec:2178's R7 names the pair. `admin` is computed; `auditor` holds no mutating
code and the role-seed lint proves it. The permission-catalogue lint reports one
"no reference" violation until T11 registers the party route.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: ADR 0026 and the posting-policy schema in full

spec:2006 is unambiguous: "**Phase 2 opens with an ADR proposing this schema in full** (`packages/domain/posting-policy.schema.json`); this is the shape it must at minimum cover, so the agent knows what 'a new document type with zero code' means". The ADR is a **proposal** — spec:95 requires it, because the schema is the data model of every posting rule the system will ever have.

1A created the file at the JOURNAL subset. This task widens it to contracts §4.4.1 **verbatim**, keeping the same `$id` (`urn:dulja:posting-policy:1`) and the same `"version": { "const": 1 }`. The widening adds enum labels and optional properties **only**, so every file valid under 1A's subset stays valid: it *completes* version 1 rather than superseding it. From this task onward the rule "a schema change is a new `version` const and a new `$id`, proposed through the contracts document" binds.

The committed `PostingPolicy` type is regenerated in the same PR. contracts §4.18 names this explicitly: "**2A regenerates the committed type when it widens the schema**" — an `$id`-stable schema with a stale committed type is the one way this can silently drift.

**Files:**
- Create: `docs/adr/0026-posting-policy-schema.md`, `packages/domain/test/posting/sales-invoice.fixture.json`, `packages/domain/scripts/policy-type-options.ts`
- Modify: `packages/domain/posting-policy.schema.json`, `packages/domain/src/posting/policy.ts` (regenerated, committed), `packages/domain/scripts/generate-policy-type.ts`, `packages/domain/test/posting/validate-policy.test.ts`, `packages/domain/test/posting/policy-type.test.ts`

**Interfaces:**
- Produces (JSON): `packages/domain/posting-policy.schema.json` at contracts §4.4.1 in full; `$id` unchanged.
- Produces (TS): the regenerated `PostingPolicy` at `packages/domain/src/posting/policy.ts`, exported unchanged from `@dulja/domain`.
- Produces (TS, dev script only — **not** exported from `@dulja/domain` and not a §4 interface): `packages/domain/scripts/policy-type-options.ts` — `export const POLICY_TYPE_BANNER: string` and `export const POLICY_TYPE_OPTIONS: Partial<Options>`, imported by `scripts/generate-policy-type.ts` and by `test/posting/policy-type.test.ts` so the drift guard cannot disagree with the generator. §4.18 registers `policy:types` and `scripts/generate-policy-type.ts` as 1A's; this splits two constants out of that file and changes neither its behaviour nor its script entry.
- Consumes: `validatePolicy`, `parsePolicy`, `PolicyEvaluationError` (1A); `compile` and the type `Options` from `json-schema-to-typescript` (dev, 1A's dependency); `PERMISSIONS` from `@dulja/contracts` (test only — `packages/domain` may not import it, so the test passes the catalogue as an array literal built in the test file, exactly as 1A's does).

- [ ] **Step 1: Write `packages/domain/test/posting/sales-invoice.fixture.json`**

This is spec:2008–2028 verbatim, minus the JSONC comments a `.json` file cannot carry, plus the three members §4.4.1 makes required that the spec example elides (`requires` is present in the spec; `dimensions` is optional and omitted here on purpose, so the test proves the default applies).

```json
{
  "version": 1,
  "documentType": "SALES_INVOICE",
  "direction": "outbound",
  "requires": ["party", "warehouse"],
  "lines": [
    { "for": "each_line", "side": "debit",  "account": { "from": "party.receivable_account" }, "amount": "line.total_incl_tax" },
    { "for": "each_line", "side": "credit", "account": { "from": "item.revenue_account" },     "amount": "line.total_excl_tax" },
    { "for": "each_tax",  "side": "credit", "account": { "from": "tax_code.output_account" },  "amount": "tax.amount" },
    { "for": "each_line", "side": "credit", "account": { "from": "item.inventory_account" },   "amount": "line.cost" },
    { "for": "each_line", "side": "debit",  "account": { "from": "item.cogs_account" },        "amount": "line.cost" }
  ],
  "inventory": { "effect": "issue", "warehouse": "header.warehouse", "costing": "consume_layers" },
  "tax": { "applies": true, "inclusive": "header.tax_inclusive" },
  "numbering": { "series": "INV", "assignAt": "issue" },
  "reversal": { "allowed": true, "producesType": "SALES_CREDIT_NOTE" },
  "approval": { "required": false, "approve": null, "post": "accounting.sales.post" },
  "fxRoundingAccount": { "from": "company.fx_rounding_account_id" }
}
```

- [ ] **Step 2: Extend the failing tests**

Append to `packages/domain/test/posting/validate-policy.test.ts`:

```ts
import salesInvoice from "./sales-invoice.fixture.json" with { type: "json" };

describe("the widened schema — contracts §4.4.1 in full, ADR 0026", () => {
  // packages/domain may not import @dulja/contracts (§3.1), so the catalogue is a literal here, exactly as
  // 1A's own cases build it. These six codes are the ones the fixtures below name — the three `hr.payroll.*`
  // entries are what the payroll fixture further down resolves its component and scheme accounts under.
  const catalogue = [
    "accounting.journal.create", "accounting.journal.post", "accounting.sales.post", "hr.payroll.approve",
    "hr.payroll.post", "hr.payroll.prepare",
  ] as const;

  it("the spec:2008-2028 SALES_INVOICE example validates (spec:2006 — 'the shape it must at minimum cover')", () => {
    expect(validatePolicy(salesInvoice, catalogue)).toEqual({ ok: true, errors: [] });
  });

  it("every policy valid under 1A's subset is still valid — the widening adds labels and optional members only", () => {
    expect(validatePolicy(JOURNAL_POLICY_FIXTURE, catalogue)).toEqual({ ok: true, errors: [] });
  });

  it("the $id and the version const are unchanged, so 1A's committed files need no migration", async () => {
    const schema = JSON.parse(await readFile(new URL("../../posting-policy.schema.json", import.meta.url), "utf8"));
    expect(schema.$id).toBe("urn:dulja:posting-policy:1");
    expect(schema.properties.version).toEqual({ const: 1 });
    expect(schema.additionalProperties).toBe(false);
  });

  it("an inventory effect other than 'none' requires a warehouse and a costing rule", () => {
    const bad = { ...salesInvoice, inventory: { effect: "issue" } };
    const report = validatePolicy(bad, catalogue);
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.message).join(" ")).toMatch(/warehouse/);
  });

  it("approval.required = true forces a non-null approve code", () => {
    const bad = { ...salesInvoice, approval: { required: true, approve: null, post: "accounting.sales.post" } };
    expect(validatePolicy(bad, catalogue).ok).toBe(false);
  });

  it("an approval code absent from the catalogue is refused at seed time (F-21)", () => {
    const bad = { ...salesInvoice, approval: { required: false, approve: null, post: "accounting.purchase.post" } };
    expect(validatePolicy(bad, catalogue)).toEqual({
      ok: false,
      errors: [{ path: "/approval/post", message: "accounting.purchase.post is not in the permission catalogue" }],
    });
  });

  it("an unknown property is still refused — additionalProperties: false did not loosen", () => {
    expect(validatePolicy({ ...salesInvoice, nameEn: "Sales invoice" }, catalogue).ok).toBe(false);
  });

  it("a policy line may declare its dimension sources and the required dimension types", () => {
    const tagged = {
      ...salesInvoice,
      lines: [{ for: "each_line", side: "debit", account: { code: "1200" }, amount: "line.amount",
                when: { "line.kind": "item", "item.kind": "product" },
                dimensions: { from: ["line.dimensions", "document.branch"] } }],
      dimensions: { required: ["BRANCH"] },
    };
    expect(validatePolicy(tagged, catalogue)).toEqual({ ok: true, errors: [] });
  });

  it("a payroll policy resolves component and scheme accounts and filters on the employer share (spec:2101)", () => {
    const payroll = {
      version: 1, documentType: "PAYROLL", direction: "none", requires: [],
      lines: [
        { for: "each_line", side: "debit", account: { from: "line.component.expense_account" }, amount: "line.amount",
          when: { "line.kind": "payroll", "line.component.kind": "earning" } },
        { for: "each_line", side: "debit", account: { from: "line.scheme.expense_account" }, amount: "line.amount",
          when: { "line.kind": "payroll", "line.share": "employer" } },
        { for: "each_line", side: "credit", account: { from: "line.scheme.payable_account" }, amount: "line.amount",
          when: { "line.kind": "payroll" } },
      ],
      inventory: { effect: "none" }, tax: { applies: false },
      numbering: { series: "PAY", assignAt: "issue" },
      reversal: { allowed: true, producesType: "PAYROLL" },
      approval: { required: true, approve: "hr.payroll.approve", post: "hr.payroll.post", create: "hr.payroll.prepare" },
      fxRoundingAccount: { from: "company.fx_rounding_account_id" },
      dimensions: { required: ["BRANCH", "EMPLOYEE"] },
    };
    expect(validatePolicy(payroll, catalogue)).toEqual({ ok: true, errors: [] });
  });
});
```

`JOURNAL_POLICY_FIXTURE` is the `policy` member of 1A's `journal-envelope.fixture.json`, already imported at the top of that test file by 1A; if it is not, add `import envelope from "./journal-envelope.fixture.json" with { type: "json" };` and `const JOURNAL_POLICY_FIXTURE = envelope.policy;`. Add `import { readFile } from "node:fs/promises";` at the top.

Run: `bun run --cwd packages/domain test -- test/posting/validate-policy.test.ts`
Expected: **FAIL** — the SALES_INVOICE fixture is rejected with `must be equal to one of the allowed values` on `/lines/0/account/from` (1A's subset admits only `line.account` and `company.fx_rounding_account_id`) and `must be equal to one of the allowed values` on `/inventory/effect`.

- [ ] **Step 3: Replace `packages/domain/posting-policy.schema.json` with the §4.4.1 text in full**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:dulja:posting-policy:1",
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
      "properties": {
        "effect": { "enum": ["issue", "receipt", "transfer", "none"] },
        "warehouse": { "enum": ["header.warehouse", "line.warehouse"] },
        "to_warehouse": { "enum": ["header.to_warehouse", "line.to_warehouse"] },
        "costing": { "enum": ["consume_layers", "create_layer", "zero", "none"] },
        "allowNegative": { "type": "boolean", "default": false }
      },
      "if": { "properties": { "effect": { "enum": ["issue", "receipt", "transfer"] } } },
      "then": { "required": ["warehouse", "costing"] }
    },
    "tax": {
      "type": "object", "additionalProperties": false, "required": ["applies"],
      "properties": { "applies": { "type": "boolean" }, "inclusive": { "anyOf": [{ "type": "boolean" }, { "const": "header.tax_inclusive" }] } }
    },
    "numbering": { "type": "object", "additionalProperties": false, "required": ["series", "assignAt"], "properties": { "series": { "type": "string", "pattern": "^[A-Z0-9-]{1,16}$" }, "assignAt": { "const": "issue" } } },
    "reversal": { "type": "object", "additionalProperties": false, "required": ["allowed", "producesType"], "properties": { "allowed": { "type": "boolean" }, "producesType": { "type": ["string", "null"], "pattern": "^[A-Z][A-Z0-9_]{1,63}$" } } },
    "approval": {
      "type": "object", "additionalProperties": false, "required": ["required", "approve", "post"],
      "properties": { "required": { "type": "boolean" }, "approve": { "$ref": "#/$defs/permissionCodeOrNull" }, "post": { "$ref": "#/$defs/permissionCode" },
                      "create": { "$ref": "#/$defs/permissionCode" } },
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
        { "type": "object", "additionalProperties": false, "required": ["from"], "properties": { "from": { "enum": [
          "line.account", "party.receivable_account", "party.payable_account",
          "item.revenue_account", "item.inventory_account", "item.cogs_account", "item.expense_account",
          "tax_code.output_account", "tax_code.input_account",
          "line.component.expense_account", "line.scheme.payable_account", "line.scheme.expense_account",
          "company.fx_rounding_account_id" ] } } },
        { "type": "object", "additionalProperties": false, "required": ["code"], "properties": { "code": { "type": "string", "minLength": 1 } } }
      ]
    },
    "amountRef": { "enum": [
      "line.debit", "line.credit", "line.amount", "line.total_excl_tax", "line.total_incl_tax", "line.tax_amount", "line.cost", "line.discount", "line.variance_value",
      "tax.amount", "document.total_excl_tax", "document.total_incl_tax", "document.tax_total" ] },
    "policyLine": {
      "type": "object", "additionalProperties": false, "required": ["for", "side", "account", "amount"],
      "properties": {
        "for": { "enum": ["each_line", "each_tax", "document"] },
        "side": { "enum": ["debit", "credit"] },
        "account": { "$ref": "#/$defs/accountRef" },
        "amount": { "$ref": "#/$defs/amountRef" },
        "when": { "type": "object", "additionalProperties": false, "properties": {
          "line.kind": { "enum": ["account", "item", "tax", "text", "tender", "payroll"] },
          "line.tender_method": { "enum": ["cash", "card", "transfer", "store_credit"] },
          "line.component.kind": { "enum": ["earning", "deduction"] },
          "line.share": { "enum": ["employee", "employer"] },
          "line.quantity_sign": { "enum": ["positive", "negative"] },
          "item.kind": { "enum": ["product", "service", "asset"] },
          "document.kind": { "type": "string" } } },
        "dimensions": { "type": "object", "additionalProperties": false, "properties": { "from": { "type": "array", "items": { "enum": ["line.dimensions", "document.branch", "line.employee"] }, "default": ["line.dimensions", "document.branch"] } } }
      }
    }
  }
}
```

- [ ] **Step 4: Regenerate the committed type, and make the drift guard exact**

**First, lift the generator's two constants into a side-effect-free module**, so the test and the script cannot disagree about them. 1A declared `banner` and the `compile` options inline in `packages/domain/scripts/generate-policy-type.ts`; a drift test that re-picked those options would compare the committed file against output the script never produces. Create `packages/domain/scripts/policy-type-options.ts`:

```ts
import type { Options } from "json-schema-to-typescript";

/** The exact header 1A's generator writes above the generated type. `policy-type.test.ts` strips it before
 *  comparing, and `generate-policy-type.ts` prepends it — one declaration, so they cannot disagree. */
export const POLICY_TYPE_BANNER = [
  "// GENERATED FILE — do not edit by hand.",
  "// Source: packages/domain/posting-policy.schema.json ($id urn:dulja:posting-policy:1)",
  "// Regenerate: bun run --cwd packages/domain policy:types",
  "",
].join("\n");

/** The exact options 1A's generator passes to `compile`. Changing one of these changes the committed file,
 *  so the drift test must read them from here rather than restate them (contracts §4.18). */
export const POLICY_TYPE_OPTIONS: Partial<Options> = {
  bannerComment: "",
  additionalProperties: false,
  style: { printWidth: 120, singleQuote: false },
};
```

Then replace `packages/domain/scripts/generate-policy-type.ts` with this — it is 1A's file with the inline `const banner = [...]` array and the inline options object deleted and the two names imported instead. Its `policy:types` package script entry and its top-level `await` are unchanged:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import { POLICY_TYPE_BANNER, POLICY_TYPE_OPTIONS } from "./policy-type-options";

/** Regenerates src/posting/policy.ts from posting-policy.schema.json. CI runs this and fails on a diff, so the
 *  committed type can never drift from the schema (the same discipline as the committed openapi.json, spec:2055). */
const root = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(await readFile(`${root}posting-policy.schema.json`, "utf8")) as Record<string, unknown>;
const ts = await compile(schema, "PostingPolicy", POLICY_TYPE_OPTIONS);
await writeFile(`${root}src/posting/policy.ts`, POLICY_TYPE_BANNER + ts, "utf8");
```

Now run: `bun run --cwd packages/domain policy:types`

This rewrites `packages/domain/src/posting/policy.ts`. **Commit the output** — it is a source file, not a build artefact (1A, ADR 0022). Read the diff before continuing: the `PostingPolicy["lines"][number]["account"]` union must now carry both the thirteen `from` labels and the `{ code: string }` branch, and `PostingPolicy["lines"][number]["for"]` must carry all three values. If the generator emits `[k: string]: unknown` anywhere, `additionalProperties: false` was lost in the edit.

Extend `packages/domain/test/posting/policy-type.test.ts` with the assertion that the committed file is current — this is the drift guard contracts §4.18 asks for. It compares the **whole** normalised text, not a prefix: the thirteen-member `accountRef` union and the thirteen-member `amountRef` union both sit well past the first few hundred characters, so a prefix comparison would be blind to exactly the drift this widening can cause.

```ts
  it("the committed PostingPolicy type is what the current schema generates (contracts §4.18)", async () => {
    const schema = JSON.parse(await readFile(new URL("../../posting-policy.schema.json", import.meta.url), "utf8"));
    const generated = await compile(schema, "PostingPolicy", POLICY_TYPE_OPTIONS);
    const onDisk = await readFile(new URL("../../src/posting/policy.ts", import.meta.url), "utf8");
    // The committed file is BANNER + generated. Strip exactly that banner — not "any leading // lines" —
    // so a hand-added comment at the top of the file is drift and is reported as drift.
    expect(onDisk.startsWith(POLICY_TYPE_BANNER)).toBe(true);
    const committed = onDisk.slice(POLICY_TYPE_BANNER.length);
    const normalise = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
    expect(normalise(committed)).toBe(normalise(generated));
  });
```

with `import { compile } from "json-schema-to-typescript";`, `import { readFile } from "node:fs/promises";` and `import { POLICY_TYPE_OPTIONS, POLICY_TYPE_BANNER } from "../../scripts/policy-type-options";` at the top. If 1A's file already carries an equivalent case, extend that one instead of adding a second.

The failure mode to expect while writing this: if the case fails with two long strings that differ only in whitespace, `normalise` was applied to one side only; if it fails on `onDisk.startsWith(POLICY_TYPE_BANNER)`, `policy:types` was not re-run after the schema edit, which is the drift this case exists to catch.

**One config hedge.** `test/posting/policy-type.test.ts` now imports from `../../scripts/`, which typechecks only if `packages/domain/tsconfig.json`'s `include` covers that directory. If `bun run typecheck` reports the import as "not listed in the file list of project", add `"scripts/**/*.ts"` to that `include` array — a one-line config change, no source change, and no other workspace is affected.

- [ ] **Step 5: Write `docs/adr/0026-posting-policy-schema.md`**

```markdown
# ADR 0026 — The posting-policy schema, in full

**Status:** PROPOSED — this ADR touches the data model, so spec:95 requires it to be written as a proposal and asked before implementing. spec:2006 requires it by name: "Phase 2 opens with an ADR proposing this schema in full."
**Date:** 2026-09-05
**Deciders:** owner (pending), architect
**Slice:** 2A

## Context

The legacy system encoded document behaviour as ~35 boolean flags on `Muniments` plus XML options (SAH-013, SAH-072, SAH-078). Nothing declared which combinations were legal, the rules lived in client code and trigger branches, and a reversal read the *current* flags rather than the ones originally applied. spec:1075 states the replacement: "Document types are data; posting rules are versioned policy objects — declarative, validated, tested, and *pinned to each posted document* so history is never re-interpreted."

1A shipped `packages/domain/posting-policy.schema.json` at the subset the JOURNAL type needs, so `postDocument` had a type to compile against and the seed had a schema to validate. That subset cannot express a sales invoice, a payroll run or a POS ticket.

## Decision

`packages/domain/posting-policy.schema.json` is widened to the full text in contracts §4.4.1, keeping `$id: urn:dulja:posting-policy:1` and `"version": { "const": 1 }`.

A policy declares:

- **`direction`** (`inbound | outbound | internal | none`) and **`requires`** — header fields the document must carry before it may post (`party`, `warehouse`, `to_warehouse`, `attributed_to`, `client_ref`, `reverses_document`).
- **`lines`** — the ledger lines the document produces. Each rule names a **scope** (`for`: `each_line`, `each_tax`, `document`), a **side**, an **account reference** (one of thirteen resolution paths, or a literal `{ "code": "…" }` resolved against `app.account.code` of the document's company and registered in contracts §4.15), an **amount reference** (one of thirteen), an optional **`when`** conjunction of equalities, and an optional **`dimensions.from`** list naming where the line's analysis dimensions come from.
- **`inventory`**, **`tax`**, **`numbering`**, **`reversal`**, **`approval`** (with the optional `create` code this document adds to the spec's block), **`fxRoundingAccount`** and **`dimensions.required`**.

The schema is `additionalProperties: false` at every level. A document-type seed file is therefore an **envelope** whose `policy` member is the policy (contracts §4.3.7): `nameEn`, `nameAr`, `module`, `policyVersion` and `effectiveFrom` live outside it.

**Two numbers, one word.** `policy.version` is the *schema* version and is `const 1`; the envelope's `policyVersion` is the `app.posting_policy.version` row number under `unique (document_type_id, version)`.

**A schema change is a new `version` const and a new `$id`**, proposed through the contracts document. This widening is not such a change: it adds enum labels and optional properties only, so every file valid under 1A's subset is still valid. It completes version 1.

## Alternatives considered

- **A DSL or a small expression language for `amount`.** Rejected: an expression language is a parser, an evaluator and an injection surface, and spec:2053/SAH-036 exists because the legacy system built behaviour out of strings. A closed `amountRef` enum is checkable by CI, diffable in review, and exhaustively switchable in TypeScript.
- **Per-document-type schemas.** Rejected: `validatePolicy` would have to pick a schema by document type, which is the flag-dispatch SAH-013 describes, one level up.
- **A `version: 2` schema now.** Rejected: 1A's committed policies and the `PostingPolicy` type would need a migration for a change that removes nothing.

## Consequences

- `evaluatePolicy` must handle every member the schema admits or the schema promises what the engine cannot do; 2A Task 6 does that, and its test file has one case per enum label.
- A reference whose backing table does not exist yet (`item.*` is 3A's, `tax_code.*` is 5A's, `line.component.*`/`line.scheme.*` are 8A/8B's) resolves through the structural `ItemRef`/`TaxCodeRef`/`PayComponentRef`/`SchemeRef` shapes declared in core (contracts §4.4.2, spec:2366 — "core never imports HR"), and yields `ERR_POLICY_REQUIRES_MISSING` naming the reference until its slice populates `snapshot.refs`.
- Every seeded policy is a reviewed diff of a version-controlled file (SAH-078), and every posted document pins the `posting_policy_id` that produced it (SAH-013).
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd packages/domain test`
Expected: **PASS** — 1A's cases plus the **ten** above: nine in `validate-policy.test.ts` and the one drift guard in `policy-type.test.ts`. If the SALES_INVOICE fixture still fails on `/tax/inclusive`, the `anyOf` branch admitting the literal `"header.tax_inclusive"` was dropped.

Run: `bun run --cwd packages/db test -- test/seed/document-types.test.ts && bun run typecheck`
Expected: PASS — the widening is backward compatible, so 1A's `JOURNAL.json` still validates and still seeds.

- [ ] **Step 7: Commit**

```bash
git add packages/domain docs/adr/0026-posting-policy-schema.md
git commit -m "$(cat <<'EOF'
feat(domain): the posting-policy schema in full, per ADR 0026 [2A T5]

spec:2006 asks Phase 2 to open with an ADR proposing this schema in full; 0026 is
that proposal (spec:95 — it touches the data model). Same $id, same version const:
the widening adds enum labels and optional members only, so every file valid under
1A's JOURNAL subset stays valid. The committed PostingPolicy type is regenerated
in this PR, which contracts §4.18 requires — a stable $id with a stale type is the
one way this drifts silently.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `evaluatePolicy` over the whole schema

The engine that makes "a new document type with zero code" true. 1A's `evaluatePolicy` handles one shape — `for: "each_line"`, `when: { "line.kind": … }`, `account.from ∈ { line.account, company.fx_rounding_account_id }`, `amount ∈ { line.debit, line.credit }`. This task widens it to every member Task 5's schema admits, and adds nothing the schema does not admit.

**Read this before writing the dimension code.** contracts §4.3.2 step 10 says the evaluator adds BRANCH from `document.branch_id` "to every line regardless", and §4.4.1 gives `dimensions.from` the default `["line.dimensions", "document.branch"]`. Those two agree once "regardless" is read as *by default*: a rule that declares `dimensions: { "from": ["line.dimensions"] }` omits `document.branch`, and a policy whose `dimensions.required` names `BRANCH` then refuses that planned line with `ERR_POLICY_REQUIRES_MISSING`. That is the only reading under which spec:1066 ("BRANCH mandatory … a posting-policy `requires`") is a rule the engine can break, and it is the mechanism 8B's PAYROLL uses in the other direction: BRANCH arrives on a payroll line through `line.dimensions` (the employee's home branch) and EMPLOYEE through `line.employee`.

**Read this before writing `push`. A negative resolved amount flips the side; it never reaches the ledger as a negative number.** `app.ledger_entry` carries `check (debit >= 0)` and `check (credit >= 0)` (plan0A:2012–2013) and 1A's `insertLedger` writes `const debit = line.side === "debit" ? line.amount.toString() : "0.0000"` (1a:3176–3179) — so a `PlannedLedgerLine` with a negative `amount` dies on `ledger_entry_debit_check` at the insert, not at evaluation, and the error names a constraint rather than the policy. `evaluatePolicy` therefore **normalises**: a rule whose resolved amount is negative emits the rule's *opposite* side with `amount.abs()`. `side` alone carries direction; `PlannedLedgerLine.amount` is never negative. This is amendment A9, and it is what makes Task 8's reversal work: a reversal line carries **negated** magnitudes (`amount = -28.5000`), the same `each_line` rules run over it, and each planned line comes out on the mirrored side at a positive magnitude — one rule set, both directions. `PlannedTaxLine.amount` is **not** normalised; 5A's tax ledger wants the signed magnitude.

**`line.cost` is `null` before the costing engine runs, and a null cost must not drop the line.** contracts §4.3.2 evaluates at step 6 and calls `applyMovements` at step 9, which "fills `value` on the plan"; if step 6 dropped the COGS and inventory lines as zero there would be nothing left for step 9 to fill and 3B could not exist. So: a planned line whose `amount` reference is `line.cost` or `line.variance_value` and whose `LineSnapshot.cost` is `null` is emitted with `Money.zero` and is **exempt from the zero-drop**. A cost that is genuinely `Money.zero` — computed, and zero — is dropped like any other zero. `cost: Money | null` is what carries the difference. This is amendment A5; Task 7 adds the fail-closed guard in `postDocument` that keeps the exemption safe until 3B lands.

**Read this before writing the `each_tax` path. A zero-amount tax group is dropped *before* its `accountRef` is resolved, and its `PlannedTaxLine` is pushed either way.** The two statements are one line apart in the body below and the order between them is load-bearing: a zero-rated, exempt or out-of-scope tax code carries no output account and no input account — correctly, because a zero-rated supply has no tax account — so an evaluator that resolved the rule's `account: { from: "tax_code.output_account" }` first would refuse an ordinary zero-rated sale with `ERR_POLICY_REQUIRES_MISSING`, naming an account that is *right* to be absent. Dropping first makes the account irrelevant for exactly the groups that have none. The `taxLines.push` sits deliberately **outside** the drop, above it: a zero-amount group still contributes its base, and a tax return's zero-rated box is computed from that base. Step 1's zero-group case pins both halves; do not reorder the two statements to "tidy" the loop.

**Files:**
- Modify: `packages/domain/src/posting/evaluate.ts`, `packages/domain/test/posting/evaluate.test.ts`, `packages/db/test/fixtures.ts`

**Interfaces:**
- Produces (TS, all exported from `@dulja/domain`, signatures unchanged from contracts §4.4.2):
```ts
export function evaluatePolicy(policy: PostingPolicy, snapshot: DocumentSnapshot): PostingPlan;   // pure; throws PolicyEvaluationError
export function validateRequires(policy: PostingPolicy, snapshot: DocumentSnapshot): { missing: string[] };
```
- Produces (TS, `packages/db/test/fixtures.ts`): `export async function seedDocumentType(db: Db, s: Seed, opts: SeedDocumentTypeOptions): Promise<string>` and `export interface SeedDocumentTypeOptions { code: string; module?: "accounting" | "inventory" | "hr" | "pos"; policy: unknown; policyVersion?: number; effectiveFrom?: string }` (contracts §4.17 — 2A's helper; 2C, 3C, 3D, 4A, 6A and 8B all configure a type through this one helper).
- Consumes: `Money`, `Quantity`, `CurrencyCode`, `toBase`, `MONEY_SCALE` (§4.2.1); `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `PlannedTaxLine`, `PostingPlan`, `PolicyEvaluationError`, `ItemRef`, `TaxCodeRef`, `PayComponentRef`, `SchemeRef` (1A, §4.4.2); `parsePolicy` (1A) in the fixture.

- [ ] **Step 1: Extend the failing test `packages/domain/test/posting/evaluate.test.ts`**

```ts
describe("evaluatePolicy over the whole schema — contracts §4.4.2, ADR 0026", () => {
  const MYR = currency("MYR");
  const m = (v: string): Money => Money.of(v, MYR);
  const ids = {
    company: "00000000-0000-7000-8000-000000000001", branch: "00000000-0000-7000-8000-000000000002",
    recv: "00000000-0000-7000-8000-000000000003", pay: "00000000-0000-7000-8000-000000000004",
    revenue: "00000000-0000-7000-8000-000000000005", inventory: "00000000-0000-7000-8000-000000000006",
    cogs: "00000000-0000-7000-8000-000000000007", output: "00000000-0000-7000-8000-000000000008",
    fx: "00000000-0000-7000-8000-000000000009", item: "00000000-0000-7000-8000-00000000000a",
    tax: "00000000-0000-7000-8000-00000000000b", suspense: "00000000-0000-7000-8000-00000000000c",
    project: "00000000-0000-7000-8000-00000000000d", employeeDim: "00000000-0000-7000-8000-00000000000e",
    zeroTax: "00000000-0000-7000-8000-00000000000f",
  };

  const line = (over: Partial<LineSnapshot> = {}): LineSnapshot => ({
    id: `l${over.lineNo ?? 1}`, lineNo: over.lineNo ?? 1, kind: "item", description: null,
    accountId: null, itemId: ids.item, quantity: Quantity.of("2.000000"), unitPrice: m("50.0000"),
    discount: m("0.0000"), amount: m("100.0000"), taxCodeId: ids.tax, taxAmount: m("6.0000"),
    totalInclTax: m("106.0000"), debit: m("0.0000"), credit: m("0.0000"), cost: null,
    warehouseId: null, toWarehouseId: null, lotId: null, unitId: null, unitQuantity: null,
    countedQuantity: null, expectedQuantity: null, tenderMethod: null,
    customFields: {}, dimensions: {}, payroll: null, ...over,
  });

  const snapshot = (over: Partial<DocumentSnapshot> = {}): DocumentSnapshot => ({
    header: {
      id: "d1", companyId: ids.company, documentTypeCode: "SALES_INVOICE", status: "issued", series: "INV",
      fiscalPeriodId: "p1", number: 1n, effectiveDate: "2026-01-15", partyId: "party-1", currency: MYR,
      exchangeRate: UNIT_RATE(MYR), branchId: ids.branch, attributedTo: null, clientRef: null,
      warehouseId: null, toWarehouseId: null, taxInclusive: false, reversesDocumentId: null, customFields: {},
    },
    lines: [line()],
    company: { id: ids.company, baseCurrency: MYR, fxRoundingAccountId: ids.fx, costingMethod: "avco" },
    party: { id: "party-1", kind: "customer", receivableAccountId: ids.recv, payableAccountId: ids.pay, creditLimit: null },
    refs: {
      accountsByCode: { "3900": ids.suspense },
      items: { [ids.item]: { id: ids.item, code: "ITM", kind: "product", baseUnitId: "u1", trackLots: false,
                             revenueAccountId: ids.revenue, inventoryAccountId: ids.inventory,
                             cogsAccountId: ids.cogs, expenseAccountId: null } satisfies ItemRef },
      taxCodes: { [ids.tax]: { id: ids.tax, code: "SST6", rate: "0.06000000", kind: "output",
                               roundingMode: "HALF_AWAY_FROM_ZERO", outputAccountId: ids.output,
                               inputAccountId: null } satisfies TaxCodeRef },
      components: {}, schemes: {},
      dimensionTypesByCode: { BRANCH: "dt-branch", PROJECT: "dt-project", EMPLOYEE: "dt-employee" },
    },
    ...over,
  });

  const policy = (over: Record<string, unknown> = {}): PostingPolicy => parsePolicy({
    version: 1, documentType: "SALES_INVOICE", direction: "outbound", requires: [],
    lines: [], inventory: { effect: "none" }, tax: { applies: false },
    numbering: { series: "INV", assignAt: "issue" },
    reversal: { allowed: true, producesType: "SALES_CREDIT_NOTE" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" }, ...over,
  });

  it("resolves every account reference the schema admits", () => {
    const plan = evaluatePolicy(policy({ lines: [
      { for: "each_line", side: "debit",  account: { from: "party.receivable_account" }, amount: "line.total_incl_tax" },
      { for: "each_line", side: "credit", account: { from: "item.revenue_account" },     amount: "line.total_excl_tax" },
      { for: "each_line", side: "credit", account: { from: "party.payable_account" },    amount: "line.tax_amount" },
      { for: "each_line", side: "debit",  account: { code: "3900" },                     amount: "line.discount" },
    ] }), snapshot({ lines: [line({ discount: m("5.0000") })] }));
    expect(plan.ledgerLines.map((l) => [l.accountId, l.side, l.amount.toString()])).toEqual([
      [ids.recv, "debit", "106.0000"],
      [ids.revenue, "credit", "100.0000"],
      [ids.pay, "credit", "6.0000"],
      [ids.suspense, "debit", "5.0000"],
    ]);
  });

  it("`line.amount` and `line.total_excl_tax` are the same field (contracts §4.3.4: amount is excl. tax)", () => {
    const both = evaluatePolicy(policy({ lines: [
      { for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.amount" },
      { for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.total_excl_tax" },
    ] }), snapshot());
    expect(both.ledgerLines.map((l) => l.amount.toString())).toEqual(["100.0000", "100.0000"]);
  });

  it("a negative resolved amount flips the side and plans a positive magnitude (amendment A9)", () => {
    // A reversal document carries NEGATED magnitudes on its lines (Task 8). The same two rules that produced
    // debit/credit on the original must produce the mirror here with no second rule set — and never a
    // negative `debit`, which app.ledger_entry's `check (debit >= 0)` refuses outright (plan0A:2012).
    const plan = evaluatePolicy(policy({ lines: [
      { for: "each_line", side: "debit",  account: { from: "party.receivable_account" }, amount: "line.amount" },
      { for: "each_line", side: "credit", account: { from: "item.revenue_account" },     amount: "line.total_incl_tax" },
    ] }), snapshot({ lines: [line({ amount: m("-25.0000"), totalInclTax: m("-26.5000") })] }));
    expect(plan.ledgerLines.map((l) => [l.accountId, l.side, l.amount.toString()])).toEqual([
      [ids.recv, "credit", "25.0000"],
      [ids.revenue, "debit", "26.5000"],
    ]);
    expect(plan.ledgerLines[0]!.base.toString()).toBe("25.0000");    // base is derived from the normalised amount

    // The same normalisation on the each_tax path — a credit note's tax group is negative too.
    const taxPlan = evaluatePolicy(policy({
      tax: { applies: true, inclusive: false },
      lines: [{ for: "each_tax", side: "credit", account: { from: "tax_code.output_account" }, amount: "tax.amount" }],
    }), snapshot({ lines: [line({ amount: m("-25.0000"), taxAmount: m("-1.5000") })] }));
    expect(taxPlan.ledgerLines.map((l) => [l.side, l.amount.toString()])).toEqual([["debit", "1.5000"]]);
    expect(taxPlan.taxLines[0]!.amount.toString()).toBe("-1.5000");  // taxLines keep the SIGNED magnitude (A9)
  });

  it("`for: each_tax` groups by tax code, emits one ledger line per group and fills plan.taxLines", () => {
    const plan = evaluatePolicy(policy({
      tax: { applies: true, inclusive: false },
      lines: [{ for: "each_tax", side: "credit", account: { from: "tax_code.output_account" }, amount: "tax.amount" }],
    }), snapshot({ lines: [line({ lineNo: 1 }), line({ lineNo: 2, amount: m("200.0000"), taxAmount: m("12.0000") })] }));
    expect(plan.ledgerLines).toHaveLength(1);
    expect(plan.ledgerLines[0]).toMatchObject({ accountId: ids.output, side: "credit", sourceLineNo: null });
    expect(plan.ledgerLines[0]!.amount.toString()).toBe("18.0000");
    expect(plan.taxLines).toHaveLength(1);
    expect(plan.taxLines[0]).toMatchObject({ taxCodeId: ids.tax, inclusive: false });
    expect(plan.taxLines[0]!.base.toString()).toBe("300.0000");
    expect(plan.taxLines[0]!.amount.toString()).toBe("18.0000");
  });

  it("a tax group evaluating to zero plans no ledger line and resolves no account", () => {
    // The zero-drop runs BEFORE `resolveAccount`, and that order is load-bearing. A zero-rated, exempt or
    // out-of-scope tax code has no output and no input account — correctly, because a zero-rated supply has
    // no tax account — so an evaluator that resolved first would refuse an ordinary zero-rated sale with
    // ERR_POLICY_REQUIRES_MISSING naming an account that is right to be absent. The `PlannedTaxLine` is
    // pushed either way: it carries the base a zero-rated return box is computed from, and dropping it would
    // make a zero-rated supply invisible to the return. This case pins both halves; do not reorder the body.
    const s = snapshot({ lines: [line({ taxCodeId: ids.zeroTax, taxAmount: m("0.0000") })] });
    s.refs.taxCodes[ids.zeroTax] = { id: ids.zeroTax, code: "ZR", rate: "0.00000000", kind: "zero",
                                     roundingMode: "HALF_AWAY_FROM_ZERO", outputAccountId: null,
                                     inputAccountId: null } satisfies TaxCodeRef;
    const plan = evaluatePolicy(policy({
      tax: { applies: true, inclusive: false },
      lines: [{ for: "each_tax", side: "credit", account: { from: "tax_code.output_account" }, amount: "tax.amount" }],
    }), s);
    expect(plan.ledgerLines).toEqual([]);
    expect(plan.taxLines).toHaveLength(1);
    expect(plan.taxLines[0]).toMatchObject({ taxCodeId: ids.zeroTax, inclusive: false });
    expect(plan.taxLines[0]!.base.toString()).toBe("100.0000");
    expect(plan.taxLines[0]!.amount.toString()).toBe("0.0000");
  });

  it("`tax.inclusive: 'header.tax_inclusive'` reads the header flag", () => {
    const plan = evaluatePolicy(policy({
      tax: { applies: true, inclusive: "header.tax_inclusive" },
      lines: [{ for: "each_tax", side: "credit", account: { from: "tax_code.output_account" }, amount: "tax.amount" }],
    }), snapshot({ header: { ...snapshot().header, taxInclusive: true } }));
    expect(plan.taxLines[0]!.inclusive).toBe(true);
  });

  it("`for: document` emits exactly one line from the document totals", () => {
    // Only the three document-scoped account references may appear on a `for: document` rule — the two party
    // links and the FX-rounding account — plus a literal `{ code }`. An `item.*` or `tax_code.*` ref here is
    // ERR_POLICY_INVALID, which the very next case asserts: with `line === null` there is no item and no tax
    // code to resolve against, so the guard is the correct behaviour and not a limitation to work around.
    const plan = evaluatePolicy(policy({ lines: [
      { for: "document", side: "debit",  account: { from: "party.receivable_account" }, amount: "document.total_incl_tax" },
      { for: "document", side: "credit", account: { from: "party.payable_account" },    amount: "document.total_excl_tax" },
      { for: "document", side: "credit", account: { code: "3900" },                     amount: "document.tax_total" },
    ] }), snapshot({ lines: [line({ lineNo: 1 }), line({ lineNo: 2 })] }));
    expect(plan.ledgerLines.map((l) => [l.side, l.amount.toString(), l.sourceLineNo])).toEqual([
      ["debit", "212.0000", null], ["credit", "200.0000", null], ["credit", "12.0000", null],
    ]);
  });

  it("a `for: document` rule that names a line-scoped account or amount is ERR_POLICY_INVALID", () => {
    for (const rule of [
      { for: "document", side: "debit", account: { from: "line.account" }, amount: "document.total_incl_tax" },
      { for: "document", side: "debit", account: { code: "3900" }, amount: "line.amount" },
    ] as const) {
      expect(() => evaluatePolicy(policy({ lines: [rule] }), snapshot()))
        .toThrow(/ERR_POLICY_INVALID/);
    }
  });

  it("`when` is a conjunction — every declared equality must hold", () => {
    const rule = { for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.amount",
                   when: { "line.kind": "item", "item.kind": "product" } };
    expect(evaluatePolicy(policy({ lines: [rule] }), snapshot()).ledgerLines).toHaveLength(1);
    const service = snapshot();
    service.refs.items[ids.item] = { ...service.refs.items[ids.item]!, kind: "service" };
    expect(evaluatePolicy(policy({ lines: [rule] }), service).ledgerLines).toHaveLength(0);
  });

  it("filters on tender method, quantity sign, component kind, share and document kind", () => {
    const only = (when: Record<string, string>, over: Partial<LineSnapshot>, header: Record<string, unknown> = {}) =>
      evaluatePolicy(
        policy({ lines: [{ for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.amount", when }] }),
        snapshot({ lines: [line(over)], header: { ...snapshot().header, ...header } }),
      ).ledgerLines.length;
    expect(only({ "line.tender_method": "cash" }, { kind: "tender", tenderMethod: "cash" })).toBe(1);
    expect(only({ "line.tender_method": "card" }, { kind: "tender", tenderMethod: "cash" })).toBe(0);
    expect(only({ "line.quantity_sign": "negative" }, { quantity: Quantity.of("-1.000000") })).toBe(1);
    expect(only({ "line.quantity_sign": "negative" }, { quantity: Quantity.of("1.000000") })).toBe(0);
    expect(only({ "line.quantity_sign": "positive" }, { quantity: null })).toBe(0);
    expect(only({ "document.kind": "supplementary" }, {}, { customFields: { kind: "supplementary" } })).toBe(1);
    expect(only({ "document.kind": "regular" }, {}, { customFields: { kind: "supplementary" } })).toBe(0);
  });

  it("resolves component and scheme accounts and filters on the employer share (spec:2101)", () => {
    const s = snapshot({
      header: { ...snapshot().header, documentTypeCode: "PAYROLL" },
      lines: [line({ kind: "payroll", itemId: null, taxCodeId: null, amount: m("80.0000"),
                     payroll: { employeeId: "e1", employeeDimensionValueId: ids.employeeDim, componentId: "c1", schemeId: "s1", share: "employer" } })],
    });
    s.refs.components = { c1: { id: "c1", code: "BASIC", kind: "earning", expenseAccountId: ids.cogs, payableAccountId: null } satisfies PayComponentRef };
    s.refs.schemes = { s1: { id: "s1", code: "SYNTH", payableAccountId: ids.pay, expenseAccountId: ids.revenue } satisfies SchemeRef };
    const plan = evaluatePolicy(policy({ lines: [
      { for: "each_line", side: "debit",  account: { from: "line.scheme.expense_account" }, amount: "line.amount", when: { "line.share": "employer" } },
      { for: "each_line", side: "credit", account: { from: "line.scheme.payable_account" }, amount: "line.amount" },
      { for: "each_line", side: "debit",  account: { from: "line.component.expense_account" }, amount: "line.amount", when: { "line.component.kind": "earning" } },
    ] }), s);
    expect(plan.ledgerLines.map((l) => l.accountId)).toEqual([ids.revenue, ids.pay, ids.cogs]);
  });

  it("BRANCH is added from the header by default and a line's own value never overrides it", () => {
    const plan = evaluatePolicy(
      policy({ lines: [{ for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.amount" }] }),
      snapshot({ lines: [line({ dimensions: { BRANCH: "someone-elses-branch", PROJECT: ids.project } })] }),
    );
    expect(plan.ledgerLines[0]!.dimensions).toEqual({ BRANCH: ids.branch, PROJECT: ids.project });
  });

  it("`dimensions.from` omitting document.branch produces a line with no BRANCH, which `required` then refuses (F-9, spec:1066)", () => {
    const p = policy({
      lines: [{ for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.amount",
                dimensions: { from: ["line.dimensions"] } }],
      dimensions: { required: ["BRANCH"] },
    });
    expect(() => evaluatePolicy(p, snapshot())).toThrow(/ERR_POLICY_REQUIRES_MISSING.*BRANCH/s);
  });

  it("`line.employee` adds the EMPLOYEE dimension from the payroll ref (spec:2101)", () => {
    const s = snapshot({ lines: [line({ kind: "payroll", payroll: { employeeId: "e1", employeeDimensionValueId: ids.employeeDim, componentId: null, schemeId: null, share: null } })] });
    const plan = evaluatePolicy(policy({
      lines: [{ for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.amount",
                dimensions: { from: ["line.dimensions", "document.branch", "line.employee"] } }],
      dimensions: { required: ["BRANCH", "EMPLOYEE"] },
    }), s);
    expect(plan.ledgerLines[0]!.dimensions).toEqual({ BRANCH: ids.branch, EMPLOYEE: ids.employeeDim });
  });

  it("a required dimension type the company does not define is refused by name", () => {
    const s = snapshot();
    delete s.refs.dimensionTypesByCode.PROJECT;
    expect(() => evaluatePolicy(policy({
      lines: [{ for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.amount" }],
      dimensions: { required: ["PROJECT"] },
    }), s)).toThrow(/ERR_POLICY_REQUIRES_MISSING.*PROJECT/s);
  });

  it("a null cost keeps its planned line at zero — the costing engine fills it at step 9 (amendment A5)", () => {
    const plan = evaluatePolicy(policy({ lines: [
      { for: "each_line", side: "debit",  account: { from: "item.cogs_account" },      amount: "line.cost" },
      { for: "each_line", side: "credit", account: { from: "item.inventory_account" }, amount: "line.cost" },
      { for: "each_line", side: "debit",  account: { code: "3900" },                   amount: "line.discount" },
    ] }), snapshot());
    expect(plan.ledgerLines.map((l) => [l.accountId, l.amount.toString()])).toEqual([
      [ids.cogs, "0.0000"], [ids.inventory, "0.0000"],
    ]);
    expect(plan.warnings).toEqual(["line 1: cost is not yet computed; the costing engine fills it at post"]);
  });

  it("a cost that is genuinely zero is dropped like any other zero amount", () => {
    const plan = evaluatePolicy(
      policy({ lines: [{ for: "each_line", side: "debit", account: { from: "item.cogs_account" }, amount: "line.cost" }] }),
      snapshot({ lines: [line({ cost: m("0.0000") })] }),
    );
    expect(plan.ledgerLines).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("an unresolvable reference names itself and the line", () => {
    const noParty = snapshot({ party: null });
    expect(() => evaluatePolicy(policy({ lines: [{ for: "each_line", side: "debit", account: { from: "party.receivable_account" }, amount: "line.amount" }] }), noParty))
      .toThrow(/ERR_POLICY_REQUIRES_MISSING.*party\.receivable_account/s);
    const noItem = snapshot({ lines: [line({ itemId: null })] });
    expect(() => evaluatePolicy(policy({ lines: [{ for: "each_line", side: "debit", account: { from: "item.revenue_account" }, amount: "line.amount" }] }), noItem))
      .toThrow(/ERR_POLICY_REQUIRES_MISSING.*item\.revenue_account/s);
  });

  it("validateRequires reports every missing header field by its schema name", () => {
    const p = policy({ requires: ["party", "warehouse", "client_ref"] });
    expect(validateRequires(p, snapshot({ party: null, header: { ...snapshot().header, partyId: null } })).missing)
      .toEqual(["party", "warehouse", "client_ref"]);
    expect(validateRequires(policy({ requires: ["party"] }), snapshot()).missing).toEqual([]);
  });
});
```

Add `Quantity`, `UNIT_RATE`, `currency`, `parsePolicy`, `validateRequires`, and the four ref types to the file's imports.

Run: `bun run --cwd packages/domain test -- test/posting/evaluate.test.ts`
Expected: **FAIL** — the first case fails with `ERR_POLICY_REQUIRES_MISSING: line 1 has no account` (1A's `resolveAccount` falls through to `line.accountId` for every `from` it does not know), the `each_tax` case produces zero ledger lines, and the negative-amount case reports `side: "debit"` with `amount: "-25.0000"` because 1A's `push` never inspects the sign. The zero-group case fails on its **`taxLines`** assertion rather than on its ledger assertion — 1A has no `each_tax` branch at all, so `plan.ledgerLines` is empty for the accidental reason and `plan.taxLines` is empty for the real one.

- [ ] **Step 2: Replace the evaluator half of `packages/domain/src/posting/evaluate.ts`**

Everything above `const REQUIRES_FIELD` is unchanged. Replace `resolveAccount`, `evaluatePolicy` and nothing else; `validateRequires`, `validatePolicy`, `parsePolicy`, `validateDocumentTypeSeed` and `balanceInBase` keep 1A's bodies exactly.

```ts
type PolicyLine = PostingPolicy["lines"][number];
type AccountRef = PolicyLine["account"];
type AmountRef = PolicyLine["amount"];

/** The two amount references the costing engine fills at §4.3.2 step 9, long after evaluation. */
const COST_REFS: ReadonlySet<string> = new Set(["line.cost", "line.variance_value"]);

const missing = (what: string, where: string): never => {
  throw new PolicyEvaluationError("ERR_POLICY_REQUIRES_MISSING", `${where} cannot resolve ${what}`);
};

function resolveAccount(ref: AccountRef, line: LineSnapshot | null, snapshot: DocumentSnapshot): string {
  const where = line ? `line ${line.lineNo}` : `document ${snapshot.header.id}`;
  if ("code" in ref) {
    // A literal chart code. Every literal a policy may name is registered in contracts §4.15 with the one
    // slice that seeds it; an unseeded code fails here rather than posting to a null account.
    return snapshot.refs.accountsByCode[ref.code]
      ?? missing(`account code ${ref.code} in company ${snapshot.company.id}`, where);
  }
  switch (ref.from) {
    case "company.fx_rounding_account_id":
      return snapshot.company.fxRoundingAccountId ?? missing("company.fx_rounding_account_id", where);
    case "party.receivable_account":
      return snapshot.party?.receivableAccountId ?? missing("party.receivable_account", where);
    case "party.payable_account":
      return snapshot.party?.payableAccountId ?? missing("party.payable_account", where);
    default:
      break;
  }
  if (!line) missing(`${ref.from} on a document-scoped rule`, where);   // unreachable: guarded in evaluatePolicy
  switch (ref.from) {
    case "line.account":
      return line!.accountId ?? missing("line.account", where);
    case "item.revenue_account":
    case "item.inventory_account":
    case "item.cogs_account":
    case "item.expense_account": {
      const item: ItemRef | undefined = line!.itemId ? snapshot.refs.items[line!.itemId] : undefined;
      const id = item && {
        "item.revenue_account": item.revenueAccountId,
        "item.inventory_account": item.inventoryAccountId,
        "item.cogs_account": item.cogsAccountId,
        "item.expense_account": item.expenseAccountId,
      }[ref.from];
      return id ?? missing(ref.from, where);
    }
    case "tax_code.output_account":
    case "tax_code.input_account": {
      const code: TaxCodeRef | undefined = line!.taxCodeId ? snapshot.refs.taxCodes[line!.taxCodeId] : undefined;
      const id = code && (ref.from === "tax_code.output_account" ? code.outputAccountId : code.inputAccountId);
      return id ?? missing(ref.from, where);
    }
    case "line.component.expense_account": {
      const c: PayComponentRef | undefined = line!.payroll?.componentId ? snapshot.refs.components[line!.payroll.componentId] : undefined;
      return c?.expenseAccountId ?? missing(ref.from, where);
    }
    case "line.scheme.payable_account":
    case "line.scheme.expense_account": {
      const s: SchemeRef | undefined = line!.payroll?.schemeId ? snapshot.refs.schemes[line!.payroll.schemeId] : undefined;
      const id = s && (ref.from === "line.scheme.payable_account" ? s.payableAccountId : s.expenseAccountId);
      return id ?? missing(ref.from, where);
    }
    default:
      throw new PolicyEvaluationError("ERR_POLICY_INVALID", `unknown account reference ${String(ref.from)}`);
  }
}

/** Every `when` key the schema admits, resolved against the line and the snapshot. A `when` is a CONJUNCTION:
 *  every declared equality must hold. A key whose value cannot be read (no item, no payroll ref, no quantity)
 *  does not match — a filter never fails open. */
function matchesWhen(when: NonNullable<PolicyLine["when"]>, line: LineSnapshot | null, snapshot: DocumentSnapshot): boolean {
  for (const [key, expected] of Object.entries(when)) {
    let actual: string | null = null;
    switch (key) {
      case "line.kind": actual = line?.kind ?? null; break;
      case "line.tender_method": actual = line?.tenderMethod ?? null; break;
      case "line.component.kind": {
        const id = line?.payroll?.componentId ?? null;
        actual = id ? snapshot.refs.components[id]?.kind ?? null : null;
        break;
      }
      case "line.share": actual = line?.payroll?.share ?? null; break;
      case "line.quantity_sign":
        actual = line?.quantity == null ? null : line.quantity.isNegative() ? "negative" : "positive";
        break;
      case "item.kind": {
        const id = line?.itemId ?? null;
        actual = id ? snapshot.refs.items[id]?.kind ?? null : null;
        break;
      }
      case "document.kind": {
        // Amendment A6: a document has no `kind` column; 8B's payroll_run.kind is a 1:1 extension and core
        // never imports HR (spec:2366), so the custom-field bag is where a kind lives for the evaluator.
        const v = snapshot.header.customFields["kind"];
        actual = typeof v === "string" ? v : null;
        break;
      }
      default:
        throw new PolicyEvaluationError("ERR_POLICY_INVALID", `unknown when key ${key}`);
    }
    if (actual !== expected) return false;
  }
  return true;
}

/** Resolves a line-scoped amount. Returns `null` for a cost reference the costing engine has not filled
 *  (amendment A5) — the caller emits a zero line and exempts it from the drop. */
function lineAmount(ref: AmountRef, line: LineSnapshot): Money | null {
  switch (ref) {
    case "line.debit": return line.debit;
    case "line.credit": return line.credit;
    case "line.amount":
    case "line.total_excl_tax": return line.amount;      // §4.3.4: `amount` IS the excl.-tax total (amendment A6)
    case "line.total_incl_tax": return line.totalInclTax;
    case "line.tax_amount": return line.taxAmount;
    case "line.discount": return line.discount;
    case "line.cost":
    case "line.variance_value": return line.cost;        // null until §4.3.2 step 9
    default:
      throw new PolicyEvaluationError("ERR_POLICY_INVALID", `amount reference ${ref} is not valid on a line-scoped rule`);
  }
}

function documentAmount(ref: AmountRef, snapshot: DocumentSnapshot, zero: Money): Money {
  const sum = (pick: (l: LineSnapshot) => Money): Money => snapshot.lines.reduce((a, l) => a.add(pick(l)), zero);
  switch (ref) {
    case "document.total_excl_tax": return sum((l) => l.amount);
    case "document.total_incl_tax": return sum((l) => l.totalInclTax);
    case "document.tax_total": return sum((l) => l.taxAmount);
    default:
      throw new PolicyEvaluationError("ERR_POLICY_INVALID", `amount reference ${ref} is not valid on a document-scoped rule`);
  }
}

const DOCUMENT_SCOPED_ACCOUNTS: ReadonlySet<string> = new Set([
  "party.receivable_account", "party.payable_account", "company.fx_rounding_account_id",
]);

function dimensionsFor(rule: PolicyLine, line: LineSnapshot | null, snapshot: DocumentSnapshot): Record<string, string> {
  // The schema's default, restated: a rule with no `dimensions` block takes the line's own bag plus the
  // document's BRANCH. contracts §4.3.2 step 10's "regardless" is that default — a rule that DECLARES a
  // narrower `from` omits what it does not name, which is what makes `dimensions.required` a rule the
  // engine can break (spec:1066, F-9).
  const from = rule.dimensions?.from ?? ["line.dimensions", "document.branch"];
  const out: Record<string, string> = {};
  for (const source of from) {
    if (source === "line.dimensions" && line) Object.assign(out, line.dimensions);
    if (source === "document.branch") out["BRANCH"] = snapshot.header.branchId;
    if (source === "line.employee" && line?.payroll) out["EMPLOYEE"] = line.payroll.employeeDimensionValueId;
  }
  // The header's BRANCH always wins over a value a client put in the line's own bag (SAH-042, SAH-050).
  if (from.includes("document.branch")) out["BRANCH"] = snapshot.header.branchId;
  return out;
}

/** Pure. Zero-amount planned lines are dropped (§4.3.2 step 6) EXCEPT a cost reference the costing engine
 *  has not filled — see amendment A5. A zero-amount `each_tax` group is dropped BEFORE its accountRef is
 *  resolved, so a tax code with no account (zero-rated, exempt) plans nothing rather than refusing.
 *  Every planned LEDGER line's `amount` is non-negative — `side` is the sole carrier of direction (amendment
 *  A9); planned TAX lines keep their signed magnitude. Throws PolicyEvaluationError and never touches I/O. */
export function evaluatePolicy(policy: PostingPolicy, snapshot: DocumentSnapshot): PostingPlan {
  const zero = Money.zero(snapshot.header.currency);
  const ledgerLines: PlannedLedgerLine[] = [];
  const taxLines: PlannedTaxLine[] = [];
  const warnings: string[] = [];
  let lineNo = 0;

  /** Amendment A9. `app.ledger_entry` has `check (debit >= 0)` and `check (credit >= 0)` (plan0A:2012) and
   *  1A's `insertLedger` puts `line.amount` straight into the column named by `line.side`, so a negative
   *  planned amount would die on a constraint instead of producing a mirrored entry. A negative amount is
   *  therefore the SAME entry on the opposite side: side carries the direction, the magnitude is absolute.
   *  This is what lets one `each_line` rule set post a document and its reversal (Task 8). */
  const normalise = (side: "debit" | "credit", amount: Money): { side: "debit" | "credit"; amount: Money } =>
    amount.isNegative()
      ? { side: side === "debit" ? "credit" : "debit", amount: amount.abs() }
      : { side, amount };

  const push = (rule: PolicyLine, source: LineSnapshot | null, raw: Money, unresolvedCost: boolean): void => {
    if (raw.isZero() && !unresolvedCost) return;
    const { side, amount } = normalise(rule.side, raw);
    lineNo += 1;
    ledgerLines.push({
      lineNo,
      accountId: resolveAccount(rule.account, source, snapshot),
      side,
      amount,
      base: toBase(amount, snapshot.header.exchangeRate),
      dimensions: dimensionsFor(rule, source, snapshot),
      sourceLineNo: source?.lineNo ?? null,
      role: "policy",
    });
  };

  for (const rule of policy.lines) {
    if (rule.for === "each_line") {
      for (const line of snapshot.lines) {
        if (rule.when && !matchesWhen(rule.when, line, snapshot)) continue;
        const resolved = lineAmount(rule.amount, line);
        if (resolved === null) {
          // One warning per LINE, not per rule: a policy that names line.cost twice (the COGS debit and the
          // inventory credit of every sales policy) describes one uncomputed cost, and repeating the sentence
          // would make `plan.warnings` grow with the rule count rather than with the facts.
          const prefix = `line ${line.lineNo}:`;
          if (!warnings.some((w) => w.startsWith(prefix))) {
            warnings.push(`${prefix} cost is not yet computed; the costing engine fills it at post`);
          }
          push(rule, line, zero, true);
        } else {
          push(rule, line, resolved, false);
        }
      }
      continue;
    }

    if (rule.for === "each_tax") {
      if (rule.amount !== "tax.amount") {
        throw new PolicyEvaluationError("ERR_POLICY_INVALID", `an each_tax rule must use amount "tax.amount", not ${rule.amount}`);
      }
      const inclusive = policy.tax.inclusive === "header.tax_inclusive"
        ? snapshot.header.taxInclusive
        : policy.tax.inclusive === true;
      const groups = new Map<string, { base: Money; amount: Money; line: LineSnapshot }>();
      for (const line of snapshot.lines) {
        if (!line.taxCodeId) continue;
        if (rule.when && !matchesWhen(rule.when, line, snapshot)) continue;
        const g = groups.get(line.taxCodeId);
        groups.set(line.taxCodeId, g
          ? { base: g.base.add(line.amount), amount: g.amount.add(line.taxAmount), line: g.line }
          : { base: line.amount, amount: line.taxAmount, line });
      }
      for (const [taxCodeId, g] of groups) {
        // `taxLines` keeps the SIGNED magnitude — 5A's tax ledger needs the sign to tell an invoice's output
        // tax from a credit note's (amendment A9 exempts it from the normalisation below).
        taxLines.push({ lineNo: g.line.lineNo, taxCodeId, base: g.base, amount: g.amount, inclusive });
        // ORDER IS LOAD-BEARING — the zero-amount group is dropped HERE, before `resolveAccount` runs below.
        // A zero-rated, exempt or out-of-scope tax code has no output and no input account, so resolving the
        // rule's accountRef first would refuse an ordinary zero-rated sale with ERR_POLICY_REQUIRES_MISSING
        // naming an account that is right to be absent. The `taxLines.push` above is deliberately outside the
        // drop: the zero group's base is what a zero-rated return box is computed from. Do not reorder these.
        if (g.amount.isZero()) continue;
        // The account resolves through the GROUP's representative line, but the ledger line belongs to the
        // document, not to that line: sourceLineNo is null (§4.4.2's PlannedLedgerLine).
        const { side, amount } = normalise(rule.side, g.amount);
        lineNo += 1;
        ledgerLines.push({
          lineNo, accountId: resolveAccount(rule.account, g.line, snapshot), side,
          amount, base: toBase(amount, snapshot.header.exchangeRate),
          dimensions: dimensionsFor(rule, null, snapshot), sourceLineNo: null, role: "policy",
        });
      }
      continue;
    }

    // rule.for === "document": one line, from the document's own totals.
    if (!("code" in rule.account) && !DOCUMENT_SCOPED_ACCOUNTS.has(rule.account.from)) {
      throw new PolicyEvaluationError("ERR_POLICY_INVALID", `a document-scoped rule cannot resolve ${rule.account.from}, which is line-scoped`);
    }
    if (rule.when && !matchesWhen(rule.when, null, snapshot)) continue;
    push(rule, null, documentAmount(rule.amount, snapshot, zero), false);
  }

  for (const required of policy.dimensions?.required ?? []) {
    if (!snapshot.refs.dimensionTypesByCode[required]) {
      throw new PolicyEvaluationError("ERR_POLICY_REQUIRES_MISSING", `dimension type ${required} is required by ${policy.documentType} and company ${snapshot.company.id} does not define it`);
    }
    const offender = ledgerLines.find((l) => !l.dimensions[required]);
    if (offender) {
      throw new PolicyEvaluationError("ERR_POLICY_REQUIRES_MISSING", `dimension ${required} is required by ${policy.documentType} and planned line ${offender.lineNo} carries none`);
    }
  }

  return { ledgerLines, movements: [], taxLines, warnings };
}
```

`movements` stays `[]`: `inventory.effect` is read by 3A's `applyMovements` (contracts §4.7.2), which is the slice that has `app.item` and `app.warehouse` to plan against. The `document`-scoped guard runs before `when`, so a policy that is wrong is refused whether or not its filter would have matched.

- [ ] **Step 3: Add `seedDocumentType` to `packages/db/test/fixtures.ts`**

```ts
export interface SeedDocumentTypeOptions {
  code: string;
  module?: "accounting" | "inventory" | "hr" | "pos";
  policy: unknown;
  policyVersion?: number;
  effectiveFrom?: string;
}

/** contracts §4.17 — 2A's helper; 2C, 3C, 3D, 4A, 6A and 8B all configure a type through this one helper.
 *  The options are the §4.3.7 envelope's members. The policy is parsed against the schema BEFORE the insert:
 *  a fixture that seeds an invalid policy would make every later test lie. Returns the document_type id;
 *  calling it again with the same `code` adds another policy version to the existing type. */
export async function seedDocumentType(db: Db, s: Seed, opts: SeedDocumentTypeOptions): Promise<string> {
  parsePolicy(opts.policy);
  const typeId = await uuidv7(db.admin);
  const policyId = await uuidv7(db.admin);
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`
      insert into app.document_type (id, tenant_id, company_id, code, name_en, module)
      values (${typeId}, ${s.tenant}, ${s.company}, ${opts.code}, ${opts.code}, ${opts.module ?? "accounting"})
      on conflict (company_id, code) do nothing`;
    const [row] = await tx<{ id: string }[]>`
      select id from app.document_type where company_id = ${s.company} and code = ${opts.code}`;
    await tx`
      insert into app.posting_policy (id, tenant_id, document_type_id, version, effective_from, definition)
      values (${policyId}, ${s.tenant}, ${row!.id}, ${opts.policyVersion ?? 1},
              ${opts.effectiveFrom ?? "2026-01-01"}, ${JSON.stringify(opts.policy)}::jsonb)
      on conflict (document_type_id, version) do update
        set definition = excluded.definition, effective_from = excluded.effective_from`;
    return row!.id;
  });
}
```

Add `parsePolicy` to the file's `@dulja/domain` import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/domain test -- test/posting/evaluate.test.ts`
Expected: **PASS** (19 cases plus 1A's). If "BRANCH is added from the header by default" fails with the line's own value, the final `if (from.includes("document.branch"))` re-assignment was dropped — `Object.assign` from the line's bag runs first and would otherwise win. If the negative-amount case reports `side: "debit"` with `amount: "-25.0000"`, `normalise` is not being applied inside `push`; if it reports the right sides but `base: "-25.0000"`, `toBase` is being called on `raw` rather than on the normalised `amount`. If the zero-group case throws `ERR_POLICY_REQUIRES_MISSING … tax_code.output_account`, the `if (g.amount.isZero()) continue;` was written **after** the `resolveAccount` call instead of before it; if it passes the ledger assertion but reports `plan.taxLines` empty, the `taxLines.push` was moved inside the drop.

Run: `bun run --cwd packages/domain test && bun run --cwd packages/db test && bun run typecheck && bun run lint`
Expected: PASS — 1A's `posting/post.test.ts` and `posting/reverse.test.ts` still green, because a JOURNAL policy exercises only the `each_line` path this task kept identical.

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/db/test/fixtures.ts
git commit -m "$(cat <<'EOF'
feat(domain): evaluatePolicy over the whole schema [2A T6]

Thirteen account references, thirteen amount references, three scopes, the seven
`when` keys and the three dimension sources ADR 0026 admits. A negative resolved
amount flips the rule's side and plans the absolute magnitude (amendment A9):
app.ledger_entry has check (debit >= 0) and check (credit >= 0), so side carries
the direction and nothing else can. That is what lets ONE rule set post a document
and its reversal, whose lines carry negated magnitudes. dimensions.from is
what makes spec:1066 a rule the engine can break: a rule that omits document.branch
produces a line with no BRANCH and dimensions.required refuses it (F-9, test 28's
mechanism). A null line.cost keeps its planned line at zero rather than dropping
it, so 3B's applyMovements has something to fill (amendment A5). An each_tax group
whose amount is zero is dropped BEFORE its accountRef is resolved and keeps its
PlannedTaxLine: a zero-rated or exempt code has no tax account, and resolving
first would refuse the document over an account that is right to be absent. Adds
seedDocumentType (contracts §4.17), which parses the policy before inserting it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `loadSnapshot` fills what 1A stubbed, and `postDocument` fail-closes on an unfilled cost

1A declared `DocumentSnapshot` at its final shape and filled it at the Phase 1 subset: `LineSnapshot.kind` was the literal `"account"`, `header.partyId`/`party` were `null`, the ten money and quantity fields were zero or null, and `header.customFields` was `{}`. Tasks 1–3 added the columns; this task fills the fields. Every change is a one-expression change in the file 1A named for it, exactly as 1A's assumption 8 said it would be.

Two fields stay stubbed and stay commented, because their columns are still not there: `header.warehouseId`/`toWarehouseId` (3A's migration 0031), `header.taxInclusive` (5A's 0054) and `company.costingMethod` (3B). `refs.items`, `refs.taxCodes`, `refs.components` and `refs.schemes` also stay `{}` — 3A, 5A and 8A own those tables and each fills its own map.

The second half of the task is the guard amendment A5 promises. The evaluator now emits a zero-amount ledger line for an unfilled `line.cost`, and until 3B's `applyMovements` lands at §4.3.2 step 9 there is nothing to fill it — so `postDocument` must **refuse** rather than write a zero-value COGS row. The guard is one condition, placed immediately before the `ledger_entry` insert, and 3B replaces it with the `applyMovements` call.

**Files:**
- Modify: `packages/db/src/posting/load.ts`, `packages/db/src/posting/post.ts`, `packages/db/test/posting/load.test.ts`, `packages/db/test/posting/post.test.ts`

**Interfaces:**
- Produces (TS, signature unchanged from contracts §4.3.1): `loadSnapshot(tx: Sql, documentId: string): Promise<DocumentSnapshot>` — now filling `header.partyId`, `party`, `header.customFields`, `LineSnapshot.kind`, `itemId`, `quantity`, `unitPrice`, `discount`, `amount`, `taxCodeId`, `taxAmount`, `totalInclTax`, `cost`.
- Produces (TS, signature unchanged): `postDocument(tx, ctx, { documentId }): Promise<PostResult>` — with the amendment A5 guard.
- Consumes: `Money`, `Quantity`, `currency`, `toBase`, `UNIT_RATE` (§4.2.1); `DocumentSnapshot`, `LineSnapshot`, `PolicyEvaluationError` (§4.4.2); `PostingError` (1A); `seedParty`, `seedDocumentType`, `seedTenantV2`, `draftDocument`, `uuidv7` (Tasks 1, 6; 1A; §4.1); the four-argument test `withTenant` (§4.1) and the production three-argument one, imported into `post.test.ts` as `prodWithTenant` (1a:2766).

- [ ] **Step 1: Extend the failing test `packages/db/test/posting/load.test.ts`**

```ts
describe("loadSnapshot at the Phase 2 shape — contracts §4.4.2", () => {
  let db: Db; let a: Seed; let party: string;
  beforeAll(async () => {
    db = await startDb(); a = await seedTenantV2(db, "Alpha"); party = await seedParty(db, a, { code: "LS-1" });
  });
  afterAll(async () => { await db.stop(); });

  const withLines = async (lines: Record<string, unknown>[], header: Record<string, unknown> = {}): Promise<string> => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      if (Object.keys(header).length > 0) await tx`update app.document set ${tx(header)} where id = ${doc}`;
      for (const [i, l] of lines.entries()) {
        await tx`insert into app.document_line ${tx({
          id: await uuidv7(db.admin), tenant_id: a.tenant, company_id: a.company, document_id: doc, line_no: i + 1, ...l,
        })}`;
      }
    });
    return doc;
  };

  it("fills the party from the document's party_id", async () => {
    const doc = await withLines([{ account_id: a.cash, debit: "1.0000" }], { party_id: party });
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.header.partyId).toBe(party);
    expect(snap.party).toMatchObject({ id: party, kind: "customer" });
    expect(snap.party!.receivableAccountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(snap.party!.creditLimit).toBeNull();          // 4A's migration 0045 adds the column
  });

  it("leaves party null when the document has none — a JOURNAL has no party", async () => {
    const doc = await withLines([{ account_id: a.cash, debit: "1.0000" }]);
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.header.partyId).toBeNull();
    expect(snap.party).toBeNull();
  });

  it("fills every line column migration 0019 added, at the right scale and type", async () => {
    const item = await uuidv7(db.admin);
    const taxCode = await uuidv7(db.admin);
    const doc = await withLines([{
      kind: "item", item_id: item, quantity: "3.500000", unit_price: "12.3456", discount: "1.0000",
      amount: "42.2096", tax_code_id: taxCode, tax_amount: "2.5326", total_incl_tax: "44.7422", cost: "30.0000",
    }]);
    const [l] = (await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc))).lines;
    expect(l!.kind).toBe("item");
    expect(l!.itemId).toBe(item);
    expect(l!.taxCodeId).toBe(taxCode);
    expect(l!.quantity!.toString()).toBe("3.500000");
    expect(l!.unitPrice!.toString()).toBe("12.3456");
    expect(l!.discount.toString()).toBe("1.0000");
    expect(l!.amount.toString()).toBe("42.2096");
    expect(l!.taxAmount.toString()).toBe("2.5326");
    expect(l!.totalInclTax.toString()).toBe("44.7422");
    expect(l!.cost!.toString()).toBe("30.0000");
  });

  it("a null cost stays null — it is not zero (amendment A5)", async () => {
    const doc = await withLines([{ kind: "item", amount: "5.0000" }]);
    const [l] = (await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc))).lines;
    expect(l!.cost).toBeNull();
  });

  it("fills header.customFields from custom_field_value, keyed by the definition code (0D)", async () => {
    const defId = await uuidv7(db.admin);
    const doc = await withLines([{ account_id: a.cash, debit: "1.0000" }]);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.custom_field_definition (id, tenant_id, company_id, entity, code, name_en, kind)
               values (${defId}, ${a.tenant}, ${a.company}, 'document', 'kind', 'Run kind', 'text')`;
      await tx`insert into app.custom_field_value (id, tenant_id, definition_id, entity_id, value)
               values (${await uuidv7(db.admin)}, ${a.tenant}, ${defId}, ${doc}, ${JSON.stringify("supplementary")}::jsonb)`;
    });
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.header.customFields).toEqual({ kind: "supplementary" });
  });

  it("still stubs what its column does not exist for yet, and says which slice adds it", async () => {
    const doc = await withLines([{ account_id: a.cash, debit: "1.0000" }]);
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.header.warehouseId).toBeNull();          // 3A / 0031
    expect(snap.header.toWarehouseId).toBeNull();        // 3A / 0031
    expect(snap.header.taxInclusive).toBe(false);        // 5A / 0054
    expect(snap.company.costingMethod).toBe("avco");     // 3B; OD-06's default
    expect(snap.refs.items).toEqual({});                 // 3A
    expect(snap.refs.taxCodes).toEqual({});              // 5A
    expect(snap.refs.components).toEqual({});            // 8A
    expect(snap.refs.schemes).toEqual({});               // 8A
  });

  it("another tenant's document is invisible, party and all", async () => {
    const b = await seedTenantV2(db, "Beta");
    const doc = await withLines([{ account_id: a.cash, debit: "1.0000" }], { party_id: party });
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) => loadSnapshot(tx, doc)))
      .rejects.toThrow(/ERR_NOT_FOUND/);
  });
});
```

Append to `packages/db/test/posting/post.test.ts`, **inside 1A's existing outer `describe`, after its last `it`** — the case uses that block's `db` and `a`, and `ctx(s)` is 1A's file-level helper `(s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: "req-post" })`. Add `seedDocumentType` to the file's `../fixtures` import.

**The two cost legs must be symmetric, and that is not cosmetic.** contracts §4.3.2 runs `balanceInBase` at **step 6**, before the guard at step 10, and 1A's implementation throws `ERR_LEDGER_UNBALANCED` when the base residue exceeds `0.01 × ledgerLines.length` (1a:1871–1874). A policy with one `line.amount` leg and one `line.cost` leg plans debit 10.0000 against credit 0.0000 — a residue of 10.0000 against a tolerance of 0.02 — so the document would be refused for being unbalanced and the A5 guard would never run. Four legs, two of them the zero-amount cost pair, give Σbase debit = Σbase credit and leave exactly the two surviving zero-amount planned lines the guard exists to catch.

**`withTenant` here is 1A's four-argument test helper and `prodWithTenant` is the production three-argument one** (1a:2766 imports it under that alias; contracts §4.1 freezes the test helper's shape). `postDocument` needs a real `TenantContext`, so every call below goes through `prodWithTenant`.

```ts
  it("refuses to post a document whose policy names line.cost before the costing engine exists (amendment A5)", async () => {
    const typeId = await seedDocumentType(db, a, {
      code: "POLICY_TEST",
      policy: {
        version: 1, documentType: "POLICY_TEST", direction: "internal", requires: [],
        lines: [
          // The two money legs balance in base, so balanceInBase at §4.3.2 step 6 passes.
          { for: "each_line", side: "debit",  account: { code: "1000" }, amount: "line.amount" },
          { for: "each_line", side: "credit", account: { code: "4000" }, amount: "line.amount" },
          // The two cost legs then survive the zero-drop as a balanced zero pair (amendment A5), which is
          // exactly the state the step-10 guard must refuse until 3B's applyMovements fills them.
          { for: "each_line", side: "debit",  account: { code: "1000" }, amount: "line.cost" },
          { for: "each_line", side: "credit", account: { code: "4000" }, amount: "line.cost" },
        ],
        inventory: { effect: "none" }, tax: { applies: false },
        numbering: { series: "PT", assignAt: "issue" },
        reversal: { allowed: true, producesType: "POLICY_TEST" },
        approval: { required: false, approve: null, post: "accounting.journal.post" },
        fxRoundingAccount: { from: "company.fx_rounding_account_id" },
      },
    });
    const doc = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                          effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId}, 'PT', ${a.period}, '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (id, tenant_id, company_id, document_id, line_no, kind, amount)
               values (${await uuidv7(db.admin)}, ${a.tenant}, ${a.company}, ${id}, 1, 'item', '10.0000')`;
      return id;
    });
    await expect(prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc })))
      .rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING.*costing engine/s);
  });
```

Run: `bun run --cwd packages/db test -- test/posting/load.test.ts test/posting/post.test.ts`
Expected: **FAIL** — `expected null to be <the seeded party's uuid>` on the party case (1A returns `header.partyId: h.party_id` but hard-codes `party: null`), `expected 'account' to be 'item'` on the line case (1A hard-codes `kind: "account"`), `expected {} to equal { kind: 'supplementary' }` on the custom-fields case, and `column pt.kind does not exist`-style compile noise once the query is edited but the interface is not. The new `post.test.ts` case fails with **"promise resolved instead of rejecting"**: the plan balances (10.0000 against 10.0000, plus a zero cost pair that A5 exempts from the drop), so before the guard exists `postDocument` succeeds and writes two zero-value ledger rows — which is exactly the silently-wrong trial balance the guard exists to prevent. If instead it fails with `ERR_LEDGER_UNBALANCED`, the four legs were written as two and the cost pair is not balanced against the amount pair.

- [ ] **Step 2: Fill the snapshot in `packages/db/src/posting/load.ts`**

Replace the two row interfaces with these, in full — the first ten fields of `HeaderRow` and the first eight of `LineRow` are 1A's, unchanged, and are restated here so the file can be typed from this task alone:

```ts
interface HeaderRow {
  id: string; company_id: string; document_type_id: string; document_type_code: string; status: string;
  series: string; fiscal_period_id: string | null; number: string | null; effective_date: string;
  party_id: string | null; currency: string; exchange_rate: string; rate_source: string | null;
  reverses_document_id: string | null; client_ref: string | null; branch_id: string; attributed_to: string | null;
  base_currency: string; fx_rounding_account_id: string | null;
  // 2A: the party's own columns, through a LEFT JOIN — a JOURNAL has no party and all three stay null.
  party_kind: string | null; party_receivable: string | null; party_payable: string | null;
}
interface LineRow {
  id: string; line_no: number; description: string | null; account_id: string | null;
  debit: string; credit: string; dimensions: Record<string, string>; custom_fields: Record<string, unknown>;
  // 2A: migration 0019's ten columns.
  kind: string; item_id: string | null; quantity: string | null; unit_price: string | null;
  discount: string; amount: string; tax_code_id: string | null; tax_amount: string;
  total_incl_tax: string; cost: string | null;
}
```

Replace the header query in full. Only the last select line and the `left join` are new; everything above them is 1A's text:

```ts
  const [h] = await tx<HeaderRow[]>`
    select d.id, d.company_id, d.document_type_id, t.code as document_type_code, d.status::text as status,
           d.series, d.fiscal_period_id, d.number::text as number, to_char(d.effective_date, 'YYYY-MM-DD') as effective_date,
           d.party_id, d.currency, d.exchange_rate::text as exchange_rate, d.rate_source,
           d.reverses_document_id, d.client_ref::text as client_ref, d.branch_id, d.attributed_to,
           c.base_currency, c.fx_rounding_account_id,
           pt.kind as party_kind, pt.receivable_account_id as party_receivable, pt.payable_account_id as party_payable
      from app.document d
      join app.document_type t on t.id = d.document_type_id
      join app.company c       on c.id = d.company_id
      left join app.party pt   on pt.id = d.party_id
     where d.id = ${documentId}`;
  if (!h) throw new PostingError("ERR_NOT_FOUND", `no document ${documentId} in this tenant`);
```

The join is on `pt.id` alone and not `(pt.tenant_id, pt.id)`: `app.party` carries a FORCED `tenant_isolation` policy, so a cross-tenant row is invisible to this session in the first place, and `document_party_fk` (Task 2) makes the pair impossible to write.

Replace the line query and its mapping with:

```ts
  const lineRows = await tx<LineRow[]>`
    select id, line_no, description, account_id, debit::text as debit, credit::text as credit,
           dimensions, custom_fields, kind, item_id,
           quantity::text as quantity, unit_price::text as unit_price, discount::text as discount,
           amount::text as amount, tax_code_id, tax_amount::text as tax_amount,
           total_incl_tax::text as total_incl_tax, cost::text as cost
      from app.document_line where document_id = ${documentId} order by line_no`;
  const lines: LineSnapshot[] = lineRows.map((r) => ({
    id: r.id, lineNo: r.line_no,
    kind: r.kind as LineSnapshot["kind"],
    description: r.description, accountId: r.account_id, itemId: r.item_id,
    quantity: r.quantity === null ? null : Quantity.of(r.quantity),
    unitPrice: r.unit_price === null ? null : Money.of(r.unit_price, docCurrency),
    discount: Money.of(r.discount, docCurrency),
    amount: Money.of(r.amount, docCurrency),
    taxCodeId: r.tax_code_id,
    taxAmount: Money.of(r.tax_amount, docCurrency),
    totalInclTax: Money.of(r.total_incl_tax, docCurrency),
    debit: Money.of(r.debit, docCurrency), credit: Money.of(r.credit, docCurrency),
    cost: r.cost === null ? null : Money.of(r.cost, docCurrency),   // null ≠ zero: amendment A5
    warehouseId: null, toWarehouseId: null, lotId: null,            // 3A / 0031, 0032
    unitId: null, unitQuantity: null,                               // 3A / 0032
    countedQuantity: null, expectedQuantity: null,                  // 3D / 0040
    tenderMethod: null,                                             // 6A lifts it from custom_fields.method (§4.6.5)
    customFields: r.custom_fields, dimensions: r.dimensions, payroll: null,   // 8B fills payroll (§4.12.6)
  }));
```

**1A's `const zero = Money.zero(docCurrency);` above that mapping is now unused** — every money field comes from a column — so delete that line too, or `bun run lint` fails on `@typescript-eslint/no-unused-vars`. Check with `grep -n "zero" packages/db/src/posting/load.ts` after the edit; `loadSnapshot` should have no hit left (`balanceInBase` and `evaluatePolicy` have their own, in `packages/domain`).

Add the custom-field read beside 1A's account and dimension reads:

```ts
  const customFieldRows = await tx<{ code: string; value: unknown }[]>`
    select d.code, v.value
      from app.custom_field_value v
      join app.custom_field_definition d on d.id = v.definition_id
     where v.entity_id = ${documentId} and d.entity = 'document'`;
```

Then replace the whole returned object. Two members change — `customFields` on the header and `party` — and the rest is 1A's text, restated so the file can be typed from this task alone:

```ts
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
      // 2A: 0D's custom_field_value, keyed by the DEFINITION's code — which is what the evaluator's
      // `when: { "document.kind": … }` reads (amendment A6). No company filter: custom_field_value has no
      // company key, and its RLS policy plus the definition join already scope it.
      customFields: Object.fromEntries(customFieldRows.map((r) => [r.code, r.value])),
    },
    lines,
    company: {
      id: h.company_id, baseCurrency, fxRoundingAccountId: h.fx_rounding_account_id,
      costingMethod: "avco",                      // 3B adds company.costing_method; OD-06's default until then
    },
    // 2A: app.party, through the LEFT JOIN above. `party_kind` is non-null exactly when `party_id` is, so the
    // non-null assertion is sound; the two account links are legitimately nullable columns.
    party: h.party_id === null ? null : {
      id: h.party_id, kind: h.party_kind! as "customer" | "vendor" | "employee" | "student" | "dealer",
      receivableAccountId: h.party_receivable, payableAccountId: h.party_payable,
      creditLimit: null,                          // 4A's migration 0045 adds party.credit_limit
    },
    refs: {
      accountsByCode: Object.fromEntries(accountRows.map((r) => [r.code, r.id])),
      items: {}, taxCodes: {}, components: {}, schemes: {},
      dimensionTypesByCode: Object.fromEntries(dimensionRows.map((r) => [r.code, r.id])),
    },
  };
```

Add `Quantity` to the file's `@dulja/domain` import.

- [ ] **Step 3: Add the amendment A5 guard to `packages/db/src/posting/post.ts`**

Immediately before the `insertLedger` call at step 10:

```ts
  // Amendment A5. evaluatePolicy emits a zero-amount planned line for an `amount` reference of `line.cost`
  // or `line.variance_value` whose document_line.cost is still null, so §4.3.2 step 9's applyMovements has a
  // line to fill. Until 3B ships that hook, nothing fills it — so we FAIL CLOSED rather than write a
  // zero-value COGS or inventory row that would make the trial balance quietly wrong.
  // 3B REPLACES this block with `plan = await applyMovements(tx, ctx, plan, snapshot)` (contracts §4.7.2).
  const unfilled = plan.ledgerLines.find((l) => l.role === "policy" && l.amount.isZero());
  if (unfilled) {
    throw new PostingError(
      "ERR_POLICY_REQUIRES_MISSING",
      `planned line ${unfilled.lineNo} of document ${input.documentId} has no amount: the costing engine has not run, and it is what fills document_line.cost (contracts §4.3.2 step 9)`,
    );
  }
```

`plan.warnings` already carries the per-line explanation the evaluator produced; `PostResult.warnings` returns it unchanged for the caller's log.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/posting/load.test.ts test/posting/post.test.ts`
Expected: **PASS** (1A's cases plus 8). If the custom-fields case returns `{}`, the join is filtering on `d.company_id` — `custom_field_value` has no company key, and its RLS policy plus the definition join already scope it.

Run: `bun run --cwd packages/db test && bun run typecheck && bun run lint`
Expected: PASS. 1A's whole posting suite is green: a JOURNAL line has `kind = 'account'` by the 0019 default and every new money column defaults to zero, so `evaluatePolicy` sees exactly what it saw before.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat(db): loadSnapshot fills the party, the line columns and the custom fields [2A T7]

1A declared DocumentSnapshot at its final shape and filled it at the Phase 1
subset; Tasks 1-3 added the columns and this fills the fields — one expression
each, exactly where 1A's assumption 8 said they would be. warehouse (3A),
tax_inclusive (5A), costing_method (3B) and the four refs maps stay stubbed with
the slice that fills them named on the line.

postDocument now fail-closes on a planned line whose amount is still zero because
document_line.cost is null (amendment A5). 3B replaces that guard with the
applyMovements call of contracts §4.3.2 step 9.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `reverseDocument` over a generalised line

D13 fixes one correction mechanism for the whole system: a reversal is a **new document** of `policy.reversal.producesType`, with the sides swapped, posted through the same `postDocument`, after which the original becomes `reversed`. 1A shipped exactly that for a journal — five columns copied. A document with item lines, tax and cost has ten more, and a reversal that dropped them would post a credit note with no quantity, no tax and no cost, which is SAH-013 arriving through the back door: the reversal would not mirror what was originally applied.

This task widens the two `insert … select` statements and adds the refusals the generalised policy makes possible. **It ships no HTTP route:** `POST …/documents/{documentId}/reverse` and the `accounting.document.reverse` code are 2B's (contracts §3.6.2, §4.5.4; 1A's Self-Review records the same split). See amendment A7.

**What "swapped" means for each column.** `debit ⇄ credit` (1A): both columns carry `check (>= 0)` (1a:344–345), so a mirror on those two can only ever be a swap. `amount`, `discount`, `tax_amount`, `total_incl_tax` and `quantity` are **negated**, not swapped: they are signed magnitudes on a line whose *direction* is the document type's, and a credit note for 3 units at 100 is a line of −3 units at 100. Migration 0019 gives none of those five a non-negative CHECK, so the negative is legal in the column.

**Why negation alone produces the mirrored ledger.** A negated `amount` reaching `evaluatePolicy` through an `amount: "line.amount"` rule would plan a *negative* ledger amount, and `app.ledger_entry` refuses that outright — `check (debit >= 0)`, `check (credit >= 0)` (plan0A:2012–2013), with 1A's `insertLedger` putting `line.amount` straight into the column named by `line.side` (1a:3176–3179). **Amendment A9 is what closes the gap:** Task 6's `evaluatePolicy` normalises a negative resolved amount into the rule's *opposite* side at `amount.abs()`. So the same `each_line` rule set, run over a reversal's negated lines, emits the mirrored side at a positive magnitude — one rule set, both directions, and no `debit = '-28.5000'` ever reaches the insert. A9 must land, and Task 6 must be merged, before this task's tests can pass; the run step below says what it looks like if either is missing.

`cost` is **not** copied — the reversal is a new document and its cost is the costing engine's answer at its own effective date (3B), never a copy of the original's. `kind`, `item_id`, `unit_price`, `tax_code_id`, `dimensions` and `custom_fields` are copied unchanged.

**Files:**
- Modify: `packages/db/src/posting/reverse.ts`, `packages/db/test/posting/reverse.test.ts`

**Interfaces:**
- Produces (TS, signature unchanged from contracts §4.3.1): `reverseDocument(tx: Sql, ctx: TenantContext, input: { documentId: string; effectiveDate: string; reason: string }): Promise<{ reversalDocumentId: string; number: bigint }>`.
- Consumes: `loadSnapshot`, `resolvePolicy`, `postDocument`, `PostingError` (1A, Task 7); `parsePolicy`, `PolicyEvaluationError`, `PostingPolicy` (1A, §4.4.2); the sign normalisation of `evaluatePolicy` (Task 6, amendment A9); `seedDocumentType` (Task 6); `seedTenantV2` (1A); the production `withTenant` — imported in this test file as `prodWithTenant` (1a:3383) — and the four-argument test `withTenant` (§4.1).

- [ ] **Step 1: Extend the failing test `packages/db/test/posting/reverse.test.ts`**

Append this as a **new top-level `describe`** beside 1A's. `withTenant` in this file is 1A's four-argument test helper and `prodWithTenant` is the production three-argument one, imported under that alias at 1a:3383; `ctx` is 1A's file-level `(s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: "req-reverse" })`, and both are in scope here because both are declared at module scope. `postDocument` and `reverseDocument` take a real `TenantContext`, so every call below is `prodWithTenant(db.rw, ctx(s), …)` — never the four-argument helper with an object where a `tenantId` string belongs (hazard 15). Add `seedDocumentType` and `postDocument` to the file's imports if 1A's list lacks them.

```ts
describe("reverseDocument on a generalised line — D13, contracts §4.3.1", () => {
  let db: Db; let a: Seed; let typeId: string;
  const POLICY_TEST = {
    version: 1, documentType: "POLICY_TEST", direction: "internal", requires: [],
    lines: [
      { for: "each_line", side: "debit",  account: { code: "1000" }, amount: "line.amount", when: { "line.kind": "item" } },
      { for: "each_line", side: "credit", account: { code: "4000" }, amount: "line.amount", when: { "line.kind": "item" } },
    ],
    inventory: { effect: "none" }, tax: { applies: false },
    numbering: { series: "PT", assignAt: "issue" },
    reversal: { allowed: true, producesType: "POLICY_TEST" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  };

  beforeAll(async () => {
    db = await startDb(); a = await seedTenantV2(db, "Alpha");
    typeId = await seedDocumentType(db, a, { code: "POLICY_TEST", policy: POLICY_TEST });
  });
  afterAll(async () => { await db.stop(); });

  const postItemDocument = async (line: Record<string, unknown>): Promise<string> => {
    return prodWithTenant(db.rw, ctx(a), async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                          effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId}, 'PT', ${a.period}, '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line ${tx({
        id: await uuidv7(db.admin), tenant_id: a.tenant, company_id: a.company, document_id: id, line_no: 1,
        kind: "item", ...line,
      })}`;
      await postDocument(tx, ctx(a), { documentId: id });
      return id;
    });
  };

  it("carries every 0019 column onto the reversal, negating the signed magnitudes", async () => {
    const item = await uuidv7(db.admin);
    const source = await postItemDocument({
      item_id: item, quantity: "3.000000", unit_price: "10.0000", discount: "1.5000",
      amount: "28.5000", tax_amount: "1.7100", total_incl_tax: "30.2100",
      dimensions: JSON.stringify({}), custom_fields: JSON.stringify({ note: "keep me" }),
    });
    const { reversalDocumentId } = await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), { documentId: source, effectiveDate: "2026-01-20", reason: "wrong quantity" }));

    const [l] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<Record<string, string | null>[]>`
        select kind, item_id, quantity::text as quantity, unit_price::text as unit_price,
               discount::text as discount, amount::text as amount, tax_amount::text as tax_amount,
               total_incl_tax::text as total_incl_tax, cost::text as cost, custom_fields::text as custom_fields
          from app.document_line where document_id = ${reversalDocumentId}`);
    expect(l).toEqual({
      kind: "item", item_id: item, quantity: "-3.000000", unit_price: "10.0000",
      discount: "-1.5000", amount: "-28.5000", tax_amount: "-1.7100", total_incl_tax: "-30.2100",
      cost: null, custom_fields: '{"note": "keep me"}',
    });
  });

  it("the reversal's ledger entries mirror the original, and the original becomes reversed", async () => {
    const source = await postItemDocument({ amount: "40.0000" });
    const { reversalDocumentId } = await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), { documentId: source, effectiveDate: "2026-01-20", reason: "mistake" }));
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ document_id: string; debit: string; credit: string }[]>`
        select document_id, debit::text as debit, credit::text as credit from app.ledger_entry
         where document_id in (${source}, ${reversalDocumentId}) order by document_id, line_no`);
    const original = rows.filter((r) => r.document_id === source);
    const reversal = rows.filter((r) => r.document_id === reversalDocumentId);
    // The reversal's line carries amount = -40.0000, so amendment A9 flips each rule's side and takes the
    // absolute magnitude: planned line 1 (rule side debit, account 1000) becomes a 40.0000 CREDIT and
    // planned line 2 (rule side credit, account 4000) becomes a 40.0000 DEBIT. Positive magnitudes with
    // swapped sides is the only shape check (debit >= 0) admits (plan0A:2012).
    expect(original.map((r) => [r.debit, r.credit])).toEqual([["40.0000", "0.0000"], ["0.0000", "40.0000"]]);
    expect(reversal.map((r) => [r.debit, r.credit])).toEqual([["0.0000", "40.0000"], ["40.0000", "0.0000"]]);
    const [doc] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ status: string }[]>`select status::text as status from app.document where id = ${source}`);
    expect(doc!.status).toBe("reversed");
  });

  it("the reversal carries reverses_document_id, so `requires: [reverses_document]` is satisfiable", async () => {
    const source = await postItemDocument({ amount: "7.0000" });
    const { reversalDocumentId } = await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), { documentId: source, effectiveDate: "2026-01-20", reason: "r" }));
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ reverses_document_id: string }[]>`select reverses_document_id from app.document where id = ${reversalDocumentId}`);
    expect(row!.reverses_document_id).toBe(source);
  });

  it("refuses when the effective policy forbids reversal, naming the type", async () => {
    const noReverse = await seedDocumentType(db, a, {
      code: "POLICY_TEST", policyVersion: 2, effectiveFrom: "2026-01-25",
      policy: { ...POLICY_TEST, reversal: { allowed: false, producesType: null } },
    });
    expect(noReverse).toBe(typeId);
    const source = await prodWithTenant(db.rw, ctx(a), async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                          effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId}, 'PT', ${a.period}, '2026-01-28', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (id, tenant_id, company_id, document_id, line_no, kind, amount)
               values (${await uuidv7(db.admin)}, ${a.tenant}, ${a.company}, ${id}, 1, 'item', '9.0000')`;
      await postDocument(tx, ctx(a), { documentId: id });
      return id;
    });
    await expect(prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), { documentId: source, effectiveDate: "2026-01-28", reason: "no" })))
      .rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL.*POLICY_TEST/s);
  });

  it("refuses when producesType names a type this company does not have", async () => {
    // POLICY_TEST_2 is registered in §4.14 by amendment A1 and is deliberately NOT seeded into tenant b —
    // only POLICY_TEST is. Naming a registered-but-absent code is the point: hazard 32 forbids inventing a
    // document-type code even for a case whose whole purpose is that the code cannot be resolved.
    const b = await seedTenantV2(db, "Beta");
    const bType = await seedDocumentType(db, b, {
      code: "POLICY_TEST", policy: { ...POLICY_TEST, reversal: { allowed: true, producesType: "POLICY_TEST_2" } },
    });
    const source = await prodWithTenant(db.rw, ctx(b), async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                          effective_date, currency, branch_id)
               values (${id}, ${b.tenant}, ${b.company}, ${bType}, 'PT', ${b.period}, '2026-01-15', 'MYR', ${b.hq})`;
      await tx`insert into app.document_line (id, tenant_id, company_id, document_id, line_no, kind, amount)
               values (${await uuidv7(db.admin)}, ${b.tenant}, ${b.company}, ${id}, 1, 'item', '5.0000')`;
      await postDocument(tx, ctx(b), { documentId: id });
      return id;
    });
    await expect(prodWithTenant(db.rw, ctx(b), (tx) =>
      reverseDocument(tx, ctx(b), { documentId: source, effectiveDate: "2026-01-15", reason: "x" })))
      .rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING.*POLICY_TEST_2/s);
  });

  it("reads `reversal` from the PINNED policy, not from whatever is effective today (SAH-013, amendment A8)", async () => {
    const source = await postItemDocument({ amount: "9.0000", quantity: "1.000000" });

    // A back-dated version 2 lands AFTER the original posted — which Task 10's
    // `POST …/document-types/{documentTypeId}/policies` makes an ordinary API call, because ADR 0027 makes a
    // version append-only but says nothing about how far back `effective_from` may reach. `effective_from`
    // 2026-01-10 is greater than v1's 2026-01-01 and still on or before the original's 2026-01-15, so
    // `resolvePolicy(type, '2026-01-15')` now answers **v2** — whose policy forbids reversal. The pinned
    // `document.posting_policy_id` still names v1, and v1 is what was originally applied (spec:1753).
    await seedDocumentType(db, a, {
      code: "POLICY_TEST", policyVersion: 2, effectiveFrom: "2026-01-10",
      policy: { ...POLICY_TEST, reversal: { allowed: false, producesType: null } },
    });

    const { reversalDocumentId } = await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), { documentId: source, effectiveDate: "2026-01-20", reason: "pinned" }));

    const [rows] = await prodWithTenant(db.rw, ctx(a), (tx) => tx<{ pinned: string; original: string }[]>`
      select r.posting_policy_id::text as pinned, o.posting_policy_id::text as original
        from app.document r join app.document o on o.id = ${source}
       where r.id = ${reversalDocumentId}`);
    // The original keeps v1; the reversal is a new document at its own effective date and pins v2. Two
    // different policies on the two documents is the point — neither is re-interpreted later.
    expect(rows!.pinned).not.toBe(rows!.original);
    const versions = await prodWithTenant(db.rw, ctx(a), (tx) => tx<{ version: number }[]>`
      select p.version from app.posting_policy p
       where p.id in (${rows!.original}::uuid, ${rows!.pinned}::uuid) order by p.version`);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });
});
```

Run: `bun run --cwd packages/db test -- test/posting/reverse.test.ts`
Expected: **FAIL** — the first case returns `kind: "account", item_id: null, quantity: null, …`: 1A's insert copies five columns and the rest fall to their 0019 defaults. The pinned-policy case fails differently and later, with `ERR_DOC_STATUS_ILLEGAL: policy for POLICY_TEST does not allow reversal` — 1A resolves the block by date, so the back-dated v2 wins. Both failures are expected; if the pinned-policy case instead **passes** before Step 2b is written, `resolvePolicy`'s `order by effective_from desc, version desc` picked v1, which means the fixture's `effectiveFrom` was not applied — check that `seedDocumentType`'s `on conflict (document_type_id, version) do update` did not collapse the two rows into one.

- [ ] **Step 2: Widen the `document_line` insert in `packages/db/src/posting/reverse.ts`**

**Only the `document_line` insert changes.** The `document` insert below is **byte-identical to 1A's** (1a:3614–3621): 1A already carries `party_id` and `attributed_to` in its column and select lists, so the reversal already inherits the party a credit note settles against, and nothing here is an edit. It is restated only so this task can be typed from itself and so the reader can see that the two inserts belong to one statement pair. Replace the `document_line` insert entirely:

```ts
  const [created] = await tx<{ id: string }[]>`
    insert into app.document (tenant_id, company_id, document_type_id, series, effective_date, currency,
                              exchange_rate, rate_source, branch_id, party_id, attributed_to, reverses_document_id)
    select ${ctx.tenantId}, d.company_id, ${reversalType.id}, d.series, ${input.effectiveDate}::date, d.currency,
           d.exchange_rate, d.rate_source, d.branch_id, d.party_id, d.attributed_to, d.id
      from app.document d where d.id = ${input.documentId}
    returning id`;
  const reversalId = created!.id;

  // The mirror. `debit` and `credit` SWAP; the signed magnitudes NEGATE, so the same policy rules produce the
  // mirrored ledger lines with no second rule set (D13). `cost` is NOT copied: the reversal is its own
  // document and the costing engine answers for its own effective date (3B). `kind`, `item_id`, `unit_price`,
  // `tax_code_id`, `dimensions` and `custom_fields` carry over unchanged — a reversal that dropped them would
  // stop mirroring what was originally applied, which is SAH-013 by another route.
  await tx`
    insert into app.document_line (tenant_id, company_id, document_id, line_no, description, account_id,
                                   debit, credit, dimensions, custom_fields,
                                   kind, item_id, quantity, unit_price, discount, amount,
                                   tax_code_id, tax_amount, total_incl_tax)
    select ${ctx.tenantId}, l.company_id, ${reversalId}, l.line_no,
           ${`Reversal of ${snapshot.header.series} ${snapshot.header.number ?? ""}: ${input.reason}`}, l.account_id,
           l.credit, l.debit, l.dimensions, l.custom_fields,
           l.kind, l.item_id, -l.quantity, l.unit_price, -l.discount, -l.amount,
           l.tax_code_id, -l.tax_amount, -l.total_incl_tax
      from app.document_line l where l.document_id = ${input.documentId}`;
```

`-l.quantity` on a NULL quantity is NULL, which is what an account line needs; PostgreSQL's unary minus on `numeric` is exact, so no rounding enters here.

- [ ] **Step 2b: Read the `reversal` block from the pinned policy (amendment A8, SAH-013)**

In the same file, replace 1A's one policy-resolution line

```ts
  const { definition } = await resolvePolicy(tx, source.document_type_id, source.effective_date);
```

with a read of the policy the original **pinned**:

```ts
  // SAH-013 is exactly "reversal reads CURRENT document-type flags instead of what was originally applied",
  // and `app.document.posting_policy_id` is the column spec:1753 pins so that it cannot happen ("PINNED at
  // post time; never re-read"). A posted document always has one — contracts §4.3.2 step 13 writes it — so
  // the reversal block is read from THAT row. resolvePolicy by the original's effective_date was safe while a
  // version could arrive only through a seed PR; Task 10's POST …/policies makes a back-dated `effective_from`
  // an ordinary API call, and a version effective on or before an already-posted document's effective_date
  // would otherwise change what that document's reversal produces, months later, with no write to the
  // document. `resolvePolicy` is still what the REVERSAL's own posting uses — postDocument resolves it for the
  // reversal's own effective_date — which is why the two documents legitimately pin different policies.
  const [pinned] = await tx<{ id: string; version: number; definition: unknown }[]>`
    select p.id, p.version, p.definition
      from app.posting_policy p
      join app.document d on d.posting_policy_id = p.id
     where d.id = ${input.documentId}`;
  if (!pinned) {
    throw new PostingError("ERR_POLICY_NOT_FOUND",
      `document ${input.documentId} is posted but pins no posting policy, so what was originally applied is unknown; it cannot be reversed`);
  }
  let definition: PostingPolicy;
  try {
    definition = parsePolicy(pinned.definition);
  } catch (e) {
    if (e instanceof PolicyEvaluationError) {
      throw new PostingError("ERR_POLICY_INVALID",
        `pinned posting policy ${pinned.id} (version ${pinned.version}) is invalid: ${e.detail}`);
    }
    throw e;
  }
```

Three import consequences in `packages/db/src/posting/reverse.ts`, and no fourth:

- add `parsePolicy`, `PolicyEvaluationError` and the type `PostingPolicy` to the file's `@dulja/domain` import — the same three names `resolvePolicy` itself imports in `packages/db/src/posting/load.ts`, so no new dependency edge appears (`packages/db` → `@dulja/domain` is the one edge §3.1 allows);
- **remove `resolvePolicy` from this file's import list if and only if nothing else in `reverse.ts` still calls it.** `voidDocument` shares the file and does not resolve a policy, so after this edit the import is unused and `bun run lint` fails on `@typescript-eslint/no-unused-vars`. Check with `grep -n "resolvePolicy" packages/db/src/posting/reverse.ts` after the edit and delete the name from the import if the only hit is the import line itself;
- `definition` changes from a `const` destructured out of `resolvePolicy` to a `let` assigned in the `try`. Everything downstream — `definition.reversal.allowed`, `definition.reversal.producesType`, `definition.documentType` — is untouched, because `parsePolicy` returns the same `PostingPolicy`.

Nothing else in the function changes: the `for update` row lock, the `status !== 'posted'` refusal, the `reversalType` lookup and the two inserts are all as 1A wrote them.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/posting/reverse.test.ts`
Expected: **PASS** (1A's 7 cases plus 6). If the ledger mirror case fails with `new row for relation "ledger_entry" violates check constraint "ledger_entry_debit_check"`, **amendment A9 is missing or Task 6's `normalise` was not written** — a negated `line.amount` is reaching `insertLedger` as a negative number; fix Task 6, not this test. If it shows the reversal with the *same* sides as the original, the `l.credit, l.debit` swap was written as `l.debit, l.credit`. If one of **1A's own** seven cases goes red on `ERR_POLICY_NOT_FOUND … pins no posting policy`, that case reached `reverseDocument` on a document whose `posting_policy_id` is null — which means it was posted by a raw `insert into app.document … status = 'posted'` rather than through `postDocument`. Fix the fixture to post through `postDocument`; do **not** relax the guard, because a document with no pinned policy is precisely the SAH-013 state.

Run: `bun run --cwd packages/db test && bun run typecheck && bun run lint`
Expected: PASS — 1A's acceptance test 3 (re-key a posting) still holds: `sum(account_balance) = sum(ledger_entry)` because a reversal only ever adds rows.

- [ ] **Step 4: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat(db): reverseDocument carries the generalised line [2A T8]

D13's mirror document now copies kind, item_id, unit_price, tax_code_id,
dimensions and custom_fields and NEGATES the signed magnitudes (quantity,
discount, amount, tax_amount, total_incl_tax) beside 1A's debit/credit swap, so
one policy produces both directions. `cost` is deliberately not copied: the
reversal is its own document at its own effective date (3B answers for it).

The `reversal` block is now read from the policy the ORIGINAL pinned
(document.posting_policy_id, spec:1753) instead of resolvePolicy at the original's
effective date. 1A's form was safe while versions arrived only through seed PRs;
T10's POST .../policies makes a back-dated effective_from an ordinary API call, and
that is SAH-013 by the front door. Amendment A8.

No HTTP route here: POST .../documents/{id}/reverse and accounting.document.reverse
are 2B's (contracts §3.6.2, §4.5.4; 1A shipped no reversal endpoint for the same
reason). Amendment A7 records the 2A card's contrary sentence.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `requireDocumentPermission`: the document API's gate comes from the policy, not from a literal

1A gated `/v1/companies/{companyId}/documents` with the static codes `accounting.journal.create` and `accounting.journal.post` and required the create body's `documentTypeCode` to be `"JOURNAL"`, and its Task 12 says twice that "**2A replaces both static gates with `policy.approval.create` / `policy.approval.post` resolved from the effective policy and drops the `documentTypeCode` restriction — the paths never change**". This is that task. Without it "a new document type is added with zero code" would be false at the first hurdle: a tenant's new type would be creatable only by someone holding the *journal* code.

The middleware is contracts §4.5.4's `requireDocumentPermission(stage)`. Amendment A4 moves its authorship from 2B to 2A and requires **all six** `DocumentStage` members to be mapped here, so 2B uses the file for its `submitted`/`approved` transitions and never edits the stage map. The middleware is a **pre-flight** (spec:2173): it produces a good error message; 2B's BEFORE UPDATE OF status trigger is the control.

`RouteModule.permissions` becomes `DOCUMENT_STAGE_CODES` — an explicit constant, because the code is resolved from data and cannot be derived from source. Every slice that seeds a document type appends its `approval.*` codes to it in the same PR as its policy file; that is what keeps the `permission-catalogue` lint satisfied for policy-resolved codes.

**The body reader runs before Zod.** For the `create` stage there is no `:documentId`, so the middleware reads `documentTypeCode` from the request body. Hono caches the parsed body, so `await c.req.json()` here and again in the handler parses once.

**Files:**
- Create: `apps/api/src/middleware/require-document-permission.ts`
- Modify: `packages/contracts/src/accounting/document.ts`, `apps/api/src/routes/accounting/documents.ts`, `apps/api/src/routes/index.ts`, `apps/api/test/routes/accounting/documents.test.ts`

**Interfaces:**
- Produces (api, contracts §4.5.4 with amendment A4):
```ts
// apps/api/src/middleware/require-document-permission.ts
export type DocumentStage = "create" | "submit" | "approve" | "issue" | "post" | "void";
export function requireDocumentPermission(stage: DocumentStage): MiddlewareHandler<AppEnv>;
// apps/api/src/routes/accounting/documents.ts
export const DOCUMENT_STAGE_CODES: readonly PermissionCode[];
```
- Produces (contracts, amendment A2): `DocumentTypeCodeSchema`, `DocumentLineKindSchema`, `DocumentLineInput` (the line as accepted, replacing 1A's inline `LineInput`); `CreateDocumentBody` with `documentTypeCode: DocumentTypeCodeSchema` and an optional `partyId`, keeping 1A's `.min(1)` and its `.openapi("CreateDocument")` name; `ReplaceLinesBody` keeping `.min(1)` and `.openapi("ReplaceLines")`; `DocumentLineSchema` (the line as returned, keeping `.openapi("DocumentLine")`) widened with `kind`, `itemId`, `quantity`, `unitPrice`, `discount`, `amount`, `taxCodeId`, `taxAmount`, `totalInclTax` and `cost`.
- Produces (api, this file only, not a contracts export): the widened `insertLines`/`upsertLines`/`lineWriteColumns`, the widened `PUT …/lines` zeroing UPDATE, and `readDocument`'s tombstone filter with `kind = 'account'` added.
- Consumes: `resolvePolicy` (1A); `AppError`, `PERMISSION`, `PermissionCode` (0B); `AppEnv`, `RequestContext` (§4.2.3); `PostingPolicy` (§4.4.2); `startApi`, `problemOf` (0B, §4.17.1); `seedTenantV2` (1A), `seedDocumentType` (Task 6), `seedParty` (Task 1), `uuidv7`, `type Seed` (§4.1); `QuantitySchema`, `UuidSchema`, `DateSchema`, `CurrencySchema` (§4.2.8).

**`itemId` and `taxCodeId` are deliberately NOT accepted through the API at this slice.** Migration 0019 adds both columns without a foreign key — 3A's 0032 adds `(tenant_id, item_id) → app.item` and 5A's 0055 adds `(tenant_id, tax_code_id) → app.tax_code`. A dangling uuid accepted today is a row those `ALTER … ADD FOREIGN KEY` statements would refuse on live data tomorrow. 3A and 5A add the fields to `DocumentLineSchema` in the PR that adds the key.

- [ ] **Step 1: Correct two of 1A's cases, then extend `apps/api/test/routes/accounting/documents.test.ts`**

**Two 1A cases stop being true the moment Step 3 lands, and both are edited here — a slice never publishes a red tree (Global Constraints).** Neither is a gratuitous rewrite: one of them says in its own title that 2A lifts it.

**Edit one — the `drafter` grant and the `drafter` case.** `JOURNAL_POLICY_V1` declares **no `approval.create`**: contracts §4.4.1 carries a round-2 correction saying so in as many words ("JOURNAL declares no `approval.create` … `create`/`submit` resolve `approval.create ?? approval.post` to **`accounting.journal.post`**"), the frozen seed file of §4.3.7 and the frozen fixture of §4.17 both omit the member, and hazard 9 forbids editing either. So after Step 3 **every** stage of a JOURNAL resolves to the one code `accounting.journal.post`, and 1A's `drafter` — granted only `accounting.journal.create` at 1a:4460 — can no longer even create one. Change the grant line in 1A's `beforeAll` from

```ts
    await grant(a, drafter, "accounting.journal.create");
```

to

```ts
    // 2A: the create gate is now resolved from the policy, and JOURNAL_POLICY_V1 declares no approval.create,
    // so `approval.create ?? approval.post` is accounting.journal.post (contracts §4.5.4, §4.4.1's round-2
    // correction). The wording is 2B Task 7 Step 2's own, so that slice finds the edit already made.
    await grant(a, drafter, "accounting.journal.create", "accounting.journal.post");
```

The grant alone is not enough. With both codes the drafter can now *post* as well, so 1A's assertion that it cannot is false in the other direction — replace that case in full:

```ts
  // 2A: both gates on this route are resolved from the effective policy (contracts §4.5.4), and for a
  // JOURNAL every stage resolves to the single code accounting.journal.post (§4.4.1's round-2 correction).
  // The create and post authorities are therefore ONE code for this type, and spec:2158's "the clerk may not
  // post" cannot be demonstrated on JOURNAL at all. It is demonstrated instead on POLICY_TEST, whose policy
  // DOES declare approval.create — the "posting is gated by the policy's approval.post" case of the block
  // appended below, which is a strictly stronger statement of the same rule.
  it("a drafter holding the code JOURNAL's policy names may create AND post it (2A: §4.4.1's correction)", async () => {
    const doc = (await (await create(drafter, [
      { lineNo: 1, accountId: a.cash, debit: "3.0000" }, { lineNo: 2, accountId: a.sales, credit: "3.0000" },
    ])).json()) as { id: string };
    const posted = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${doc.id}/transitions`, as: drafter, body: { to: "posted" },
    });
    expect(posted.status).toBe(200);
    expect((await posted.json()) as { status: string }).toMatchObject({ status: "posted" });
  });
```

**Edit two — delete 1A's `documentTypeCode` pin case.** 1a:4475 reads

```ts
  it("refuses any documentTypeCode but JOURNAL at Phase 1 (2A lifts this)", async () => {
    const res = await create(a.human, [{ lineNo: 1, accountId: a.cash, debit: "1.0000" }], { documentTypeCode: "SALES_INVOICE" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });
```

Step 4 removes the `z.literal("JOURNAL")` pin, so Zod accepts the code and the middleware's type lookup answers **404 `ERR_NOT_FOUND`**. **Delete the case.** Its replacement is the new block's "a documentTypeCode that names no type in the company is 404, never 403", which asserts the post-2A truth on a code that is not a shared-namespace literal (hazard 32). Do not merely retitle it: `SALES_INVOICE` belongs to 4A in §4.14, and this slice writes no document-type code it does not own or already declare.

Then append the new top-level `describe`:

```ts
describe("the document gate comes from the policy, not from a literal — contracts §4.5.4, 1A T12", () => {
  let api: StartedApi; let a: Seed; let clerk: string; let poster: string;

  const POLICY_TEST = {
    version: 1, documentType: "POLICY_TEST", direction: "internal", requires: [],
    lines: [
      { for: "each_line", side: "debit",  account: { from: "line.account" }, amount: "line.debit",  when: { "line.kind": "account" } },
      { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
    ],
    inventory: { effect: "none" }, tax: { applies: false },
    numbering: { series: "PT", assignAt: "issue" },
    reversal: { allowed: true, producesType: "POLICY_TEST" },
    approval: { required: false, approve: null, post: "accounting.journal.post", create: "accounting.party.manage" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  };

  /** 1A creates its one extra principal with an inline `app.principal` + `app.membership` pair inside its own
   *  `beforeAll` (1a:4455–4459) and grants with a `const grant = (s, principalId, ...codes)` declared inside
   *  its own `describe` — so neither is in scope here. These two are that pair, as named local helpers of this
   *  block. They are test-file locals, not a second spelling of a §4.17 fixture (hazard 9 governs that
   *  register); the shapes are 1A's, copied so this task can be typed from itself. */
  const seedPrincipal = async (s: Seed, displayName: string): Promise<string> => {
    const principalId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${principalId}, 'human', ${`${displayName.toLowerCase()}:${s.tenant}`}, ${displayName})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
    });
    return principalId;
  };

  const grantCodes = async (s: Seed, principalId: string, ...codes: string[]): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${roleId}, ${s.tenant}, ${`r-${roleId.slice(0, 8)}`}, 'grant')`;
      for (const code of codes) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await seedDocumentType(api.db, a, { code: "POLICY_TEST", policy: POLICY_TEST });
    clerk = await seedPrincipal(a, "Clerk");
    poster = await seedPrincipal(a, "Poster");
    // `GET …/documents/{id}` is membership-only (1A), so the clerk needs no read code to check its own draft.
    await grantCodes(a, clerk, "accounting.party.manage");
    await grantCodes(a, poster, "accounting.journal.post");
  });
  afterAll(async () => { await api.stop(); });

  const create = (as: string, typeCode: string) => api.request({
    method: "POST", path: `/v1/companies/${a.company}/documents`, as,
    body: {
      documentTypeCode: typeCode, effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
      lines: [{ lineNo: 1, kind: "account", accountId: a.cash, debit: "5.0000" },
              { lineNo: 2, kind: "account", accountId: a.sales, credit: "5.0000" }],
    },
  });

  it("a document type the tenant configured is creatable without touching accounting.journal.create", async () => {
    const res = await create(clerk, "POLICY_TEST");
    expect(res.status).toBe(201);
  });

  it("the same principal cannot create a JOURNAL — the code comes from EACH type's own policy", async () => {
    const res = await create(clerk, "JOURNAL");
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("posting is gated by the policy's approval.post, whoever created the draft (spec:2158 — the clerk may not post)", async () => {
    const created = await create(clerk, "POLICY_TEST");
    const { id } = (await created.json()) as { id: string };
    const refused = await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: clerk, body: { to: "posted" } });
    expect(refused.status).toBe(403);
    const posted = await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: poster, body: { to: "posted" } });
    expect(posted.status).toBe(200);
  });

  it("`approval.create` falling back to `approval.post` when the policy omits it", async () => {
    await seedDocumentType(api.db, a, {
      code: "POLICY_TEST", policyVersion: 2, effectiveFrom: "2026-01-20",
      policy: { ...POLICY_TEST, approval: { required: false, approve: null, post: "accounting.journal.post" } },
    });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: clerk,
      body: { documentTypeCode: "POLICY_TEST", effectiveDate: "2026-01-22", currency: "MYR", branchId: a.hq,
              lines: [{ lineNo: 1, kind: "account", accountId: a.cash, debit: "1.0000" },
                      { lineNo: 2, kind: "account", accountId: a.sales, credit: "1.0000" }] },
    });
    expect(res.status).toBe(403);                      // clerk holds party.manage, not journal.post
  });

  it("a documentTypeCode that names no type in the company is 404, never 403", async () => {
    const res = await create(clerk, "NOT_A_TYPE");
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("a type with no policy effective for the date is ERR_POLICY_NOT_FOUND, not a silent allow", async () => {
    // POLICY_TEST_2 is §4.14's second test-only code (amendment A1). Its only policy version is effective
    // from June, so a January document has no effective policy — and the body still carries two balanced
    // lines, because `CreateDocumentBody.lines` keeps 1A's `.min(1)` and an empty array would be refused by
    // Zod rather than by the policy resolution this case is about.
    await seedDocumentType(api.db, a, {
      code: "POLICY_TEST_2",
      policy: { ...POLICY_TEST, documentType: "POLICY_TEST_2", numbering: { series: "PT2", assignAt: "issue" },
                reversal: { allowed: true, producesType: "POLICY_TEST_2" } },
      effectiveFrom: "2026-06-01",
    });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: clerk,
      body: { documentTypeCode: "POLICY_TEST_2", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
              lines: [{ lineNo: 1, kind: "account", accountId: a.cash, debit: "1.0000" },
                      { lineNo: 2, kind: "account", accountId: a.sales, credit: "1.0000" }] },
    });
    expect((await problemOf(res)).code).toBe("ERR_POLICY_NOT_FOUND");
  });

  it("persists an item line's quantity, price and totals and reads them back, and rejects itemId (no FK until 3A)", async () => {
    const ok = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: clerk,
      body: { documentTypeCode: "POLICY_TEST", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
              lines: [{ lineNo: 1, kind: "item", quantity: "2.000000", unitPrice: "3.0000", amount: "6.0000",
                        taxAmount: "0.0000", totalInclTax: "6.0000" }] },
    });
    expect(ok.status).toBe(201);

    // A 201 alone would pass even if every widened field were discarded, which is exactly the defect this
    // case exists to catch — so read the document back and assert the stored values. An item line has no
    // accountId and zero debit/credit, so this also proves readDocument's tombstone filter was widened with
    // `kind = 'account'`: without that, the row comes back missing entirely.
    const { id } = (await ok.json()) as { id: string };
    const read = await api.request({ method: "GET", path: `/v1/companies/${a.company}/documents/${id}`, as: clerk });
    const doc = (await read.json()) as { lines: Record<string, unknown>[] };
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({
      lineNo: 1, kind: "item", accountId: null, quantity: "2.000000", unitPrice: "3.0000",
      discount: "0.0000", amount: "6.0000", taxAmount: "0.0000", totalInclTax: "6.0000",
      itemId: null, taxCodeId: null, cost: null,
    });

    const bad = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: clerk,
      body: { documentTypeCode: "POLICY_TEST", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
              lines: [{ lineNo: 1, kind: "item", itemId: a.cash, amount: "6.0000" }] },
    });
    expect(bad.status).toBe(400);
    expect((await problemOf(bad)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a negative money field and a both-sided line are 400, not 500 — 1A's Amount and refine still bind", async () => {
    // `document_line.debit` carries `check (debit >= 0)` and `check (not (debit > 0 and credit > 0))`
    // (1a:344-349). A body that reached either would raise SQLSTATE 23514, whose message does not start with
    // `ERR_`, and `fromDatabaseError` maps that to ERR_INTERNAL 500 (§4.2.4). Zod must refuse both first.
    const negative = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: clerk,
      body: { documentTypeCode: "POLICY_TEST", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
              lines: [{ lineNo: 1, kind: "account", accountId: a.cash, debit: "-5.0000" }] },
    });
    expect(negative.status).toBe(400);
    expect((await problemOf(negative)).code).toBe("ERR_VALIDATION_FAILED");

    const bothSides = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: clerk,
      body: { documentTypeCode: "POLICY_TEST", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
              lines: [{ lineNo: 1, kind: "account", accountId: a.cash, debit: "5.0000", credit: "5.0000" }] },
    });
    expect(bothSides.status).toBe(400);

    const accountLineWithNoAccount = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: clerk,
      body: { documentTypeCode: "POLICY_TEST", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
              lines: [{ lineNo: 1, kind: "account", debit: "5.0000" }] },
    });
    expect(accountLineWithNoAccount.status).toBe(400);
  });

  it("a partyId of another tenant is refused by the composite FK, as ERR_CONFLICT_REFERENCE", async () => {
    const b = await seedTenantV2(api.db, "Beta");
    const foreign = await seedParty(api.db, b, { code: "X-API" });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: clerk,
      body: { documentTypeCode: "POLICY_TEST", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
              partyId: foreign,
              lines: [{ lineNo: 1, kind: "account", accountId: a.cash, debit: "1.0000" },
                      { lineNo: 2, kind: "account", accountId: a.sales, credit: "1.0000" }] },
    });
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_REFERENCE");
  });
});
```

This is a **new top-level `describe`**, appended below 1A's. `seedPrincipal` and `grantCodes` are written out above because **1A defines neither**: its file has one `const grant = async (s: Seed, principalId: string, ...codes: string[])` (1a:4433) declared *inside its own `describe`*, so it is not in scope for a sibling block, and it creates its extra principal with an inline `insert into app.principal` / `insert into app.membership` pair in its `beforeAll` (1a:4455–4459) rather than through any helper. Do not import either name from anywhere. Add `seedDocumentType`, `seedParty`, `seedTenantV2`, `uuidv7`, `type Seed` (from `@dulja/db/test`) and `problemOf` to the file's imports.

Run: `bun run --cwd apps/api test -- test/routes/accounting/documents.test.ts`
Expected: **FAIL**, on the new block only — its first case returns 400 `ERR_VALIDATION_FAILED` (`documentTypeCode` must still be `"JOURNAL"` until Step 4), and once that is relaxed it returns 403 (`accounting.journal.create` is still the static gate until Step 3). The two edits above are green *before* Step 3 as well as after: the static gate admits the drafter on `accounting.journal.create` and the transitions gate on `accounting.journal.post`, which the widened grant now holds, and the deleted case is simply gone. **If the rewritten drafter case fails at this point with 403 on the transition, the grant line was widened in the wrong `describe`** — 1A declares `grant` inside its own block and there is exactly one `drafter` grant to change.

- [ ] **Step 2: Write `apps/api/src/middleware/require-document-permission.ts`**

```ts
import type { MiddlewareHandler } from "hono";
import type { PostingPolicy } from "@dulja/domain";
import { resolvePolicy } from "@dulja/db";
import { AppError, PERMISSION, type PermissionCode } from "@dulja/contracts";
import type { AppEnv } from "../context";

/** contracts §4.5.4. All six stages are mapped here (amendment A4): 2A reaches create/issue/post/void, and
 *  2B's state machine reaches submit/approve without editing this file. */
export type DocumentStage = "create" | "submit" | "approve" | "issue" | "post" | "void";

/** create/submit → approval.create ?? approval.post · approve → approval.approve ?? approval.post ·
 *  issue/post/void → approval.post (contracts §4.5.4). `approval.post` is required by the schema, so every
 *  branch terminates in a code and none can fall open. */
function codeFor(stage: DocumentStage, policy: PostingPolicy): PermissionCode {
  const post = policy.approval.post as PermissionCode;
  switch (stage) {
    case "create":
    case "submit":
      return (policy.approval.create as PermissionCode | undefined) ?? post;
    case "approve":
      return (policy.approval.approve as PermissionCode | null) ?? post;
    case "issue":
    case "post":
    case "void":
      return post;
  }
}

/**
 * Loads the document named by `:documentId` — or, for "create", the type named by the body's
 * `documentTypeCode` — resolves the policy effective for its `effective_date` (contracts §4.3.1
 * `resolvePolicy` semantics), maps the stage to a code, and calls `app.actor_has(code, company_id, branch_id)`
 * inside `c.var.withTenant`. 403 `ERR_RBAC_FORBIDDEN`; 404 `ERR_NOT_FOUND` when the document or the type is
 * invisible. Pre-flight ONLY (spec:2173): 2B's BEFORE UPDATE OF status trigger is the control.
 */
export function requireDocumentPermission(stage: DocumentStage): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const companyId = c.req.param("companyId")!;
    const documentId = c.req.param("documentId");

    const resolved = await c.var.withTenant(async (tx) => {
      if (stage === "create") {
        // Hono caches the parsed body, so the handler's own `c.req.json()` does not parse twice.
        const body = (await c.req.json().catch(() => ({}))) as { documentTypeCode?: unknown; effectiveDate?: unknown };
        const code = typeof body.documentTypeCode === "string" ? body.documentTypeCode : "";
        const effectiveDate = typeof body.effectiveDate === "string" ? body.effectiveDate : "";
        const [type] = await tx<{ id: string }[]>`
          select id from app.document_type
           where company_id = ${companyId} and code = ${code} and archived_at is null`;
        if (!type || effectiveDate === "") {
          throw new AppError("ERR_NOT_FOUND", `no document type ${code || "(none given)"} in company ${companyId}`);
        }
        const { definition } = await resolvePolicy(tx, type.id, effectiveDate);
        return { policy: definition, branchId: null as string | null };
      }

      const [doc] = await tx<{ document_type_id: string; effective_date: string; branch_id: string }[]>`
        select document_type_id, to_char(effective_date, 'YYYY-MM-DD') as effective_date, branch_id
          from app.document where id = ${documentId}`;
      if (!doc) throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      const { definition } = await resolvePolicy(tx, doc.document_type_id, doc.effective_date);
      return { policy: definition, branchId: doc.branch_id };
    });

    const code = codeFor(stage, resolved.policy);
    const allowed = await c.var.withTenant(async (tx) => {
      const [row] = await tx<{ ok: boolean }[]>`
        select app.actor_has(${code}, ${companyId}::uuid, ${resolved.branchId}::uuid) as ok`;
      return row!.ok;
    });
    if (!allowed) {
      throw new AppError("ERR_RBAC_FORBIDDEN", `${code} is required to ${stage} a ${resolved.policy.documentType} in company ${companyId}`);
    }
    await next();
  };
}

/** Referenced so the `permission-catalogue` lint sees the two codes DOCUMENT_STAGE_CODES holds even though
 *  every gate above is resolved from data. `PERMISSION` is the catalogue's own identity map (§4.2.5). */
export const POLICY_RESOLVED_CODES = [PERMISSION["accounting.journal.create"], PERMISSION["accounting.journal.post"]] as const;
```

- [ ] **Step 3: Rewire `apps/api/src/routes/accounting/documents.ts`**

Seven edits, and no path changes.

1. Export the constant contracts §4.5.4 names, and reference the codes so the catalogue lint is satisfied for gates resolved from data:

```ts
import { POLICY_RESOLVED_CODES, requireDocumentPermission, type DocumentStage } from "../../middleware/require-document-permission";

/** contracts §4.5.4. The union of every code any seeded type's policy may name at any stage. It cannot be
 *  derived from source — the code is resolved from data — so it is explicit, and every slice that seeds a
 *  document type adds its `approval.*` codes here in the same PR as its policy file. At 2A the only seeded
 *  type is JOURNAL (1A), and its policy names `accounting.journal.post` alone — it declares no
 *  `approval.create` (contracts §4.4.1, round-2 correction). `accounting.journal.create` stays in this
 *  constant because Step 3 item 2 deletes its only remaining source reference and §3.6.3's bidirectional
 *  `permission-catalogue` check needs one; it is still a catalogue code and still gated on this module. */
export const DOCUMENT_STAGE_CODES: readonly PermissionCode[] = POLICY_RESOLVED_CODES;
```

`type DocumentStage` is needed by item 2's `STAGE_OF` map and `type PermissionCode` by the line above — **add `type PermissionCode` to this file's `@dulja/contracts` import if 1A's list lacks it**, and remove `requirePermission` and `PERMISSION` from the imports if item 2 leaves no other call to them (`grep -n "requirePermission\|PERMISSION\[" apps/api/src/routes/accounting/documents.ts` after the edit; an unused import fails `bun run lint` on `@typescript-eslint/no-unused-vars`).

2. Replace `middleware: [requirePermission(PERMISSION["accounting.journal.create"], { company: "path:companyId" })]` on the create route with `middleware: [requireDocumentPermission("create")]`, and `requirePermission(PERMISSION["accounting.journal.post"], …)` on the transitions route with `middleware: [requireDocumentPermission(<stage>)]` where the stage is read from the body's `to`:

Declare the stage map at module scope, beside `DOCUMENT_STAGE_CODES`:

```ts
const STAGE_OF: Record<"issued" | "posted" | "void", DocumentStage> = { issued: "issue", posted: "post", void: "void" };
```

and give the transitions route's `createRoute({ … })` this `middleware` member in place of its `requirePermission` one:

```ts
    middleware: [async (c, next) => {
      const { to } = (await c.req.json().catch(() => ({}))) as { to?: keyof typeof STAGE_OF };
      const stage = to ? STAGE_OF[to] : undefined;
      if (!stage) throw new AppError("ERR_VALIDATION_FAILED", `to must be one of ${Object.keys(STAGE_OF).join(", ")}`);
      return requireDocumentPermission(stage)(c, next);
    }] as const,
```

The `PUT …/documents/{documentId}/lines` route takes `requireDocumentPermission("create")` — editing a draft is the same authority as creating one (contracts §4.5.4: "`approval.create ?? approval.post` … for creating or editing the draft itself").

3. **Rewrite the create handler's body.** 1A pinned `documentTypeCode` to the literal `"JOURNAL"` in the Zod schema (Step 4 removes that pin) and its handler resolves the type by code already; what changes here is that the handler writes `party_id` and hands the widened lines to `insertLines`. Replace the body from the type lookup to the `readDocument` return with:

```ts
    const doc = await c.var.withTenant(async (tx) => {
      const [type] = await tx<{ id: string }[]>`
        select id from app.document_type
         where company_id = ${companyId} and code = ${body.documentTypeCode} and archived_at is null`;
      if (!type) throw new AppError("ERR_NOT_FOUND", `no document type ${body.documentTypeCode} in company ${companyId}`);

      // The series comes from the policy so a draft already shows the series it will be numbered in; the
      // number itself is assigned at issue and never by the client (SAH-051). 1A's text, unchanged.
      const [policy] = await tx<{ definition: { numbering: { series: string } } }[]>`
        select definition from app.posting_policy
         where document_type_id = ${type.id} and effective_from <= ${body.effectiveDate}::date
         order by effective_from desc, version desc limit 1`;
      if (!policy) throw new AppError("ERR_POLICY_NOT_FOUND", `no posting policy for ${body.documentTypeCode} effective on ${body.effectiveDate}`);

      // 2A: party_id. A uuid of another tenant raises 23503 on document_party_fk (Task 2), which
      // fromDatabaseError maps to ERR_CONFLICT_REFERENCE (§4.2.4) — never a 500, and never a silent write.
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date,
                                         currency, exchange_rate, rate_source, branch_id, party_id, client_ref)
               values (${id}, ${c.var.ctx.tenantId}, ${companyId}, ${type.id}, ${policy.definition.numbering.series},
                       ${body.effectiveDate}, ${body.currency}, ${rate}, ${source}, ${body.branchId},
                       ${body.partyId ?? null}, ${body.clientRef ?? null})`;
      await insertLines(tx, c.var.ctx.tenantId, companyId, id, body.lines);
      return readDocument(tx, companyId, id);
    });
    return c.json(doc, 201);
```

`id`, `rate` and `source` are 1A's own locals above this block and are untouched.

4. **Widen `insertLines` and `upsertLines`.** 1A's INSERT column list is nine columns and its parameter type names five members; both must carry migration 0019's fields or every widened body field is silently discarded and Step 1's item-line case would pass on a bare status check. Replace both functions in full:

```ts
/** The line as accepted, after Zod: `DocumentLineInput`'s output type. `itemId`/`taxCodeId` are deliberately
 *  absent — migration 0019 adds those columns with no foreign key and 3A's 0032 / 5A's 0055 add the keys. */
type LineWrite = {
  lineNo: number; kind: "account" | "item" | "tax" | "text"; description?: string; accountId?: string;
  debit: string; credit: string; quantity?: string; unitPrice?: string; discount: string; amount: string;
  taxAmount: string; totalInclTax: string; dimensions: Record<string, string>;
  customFields: Record<string, unknown>;
};

const lineWriteColumns = (tx: Tx, tenantId: string, companyId: string, documentId: string, l: LineWrite) => tx({
  tenant_id: tenantId, company_id: companyId, document_id: documentId, line_no: l.lineNo,
  description: l.description ?? null, account_id: l.accountId ?? null, kind: l.kind,
  debit: l.debit, credit: l.credit, quantity: l.quantity ?? null, unit_price: l.unitPrice ?? null,
  discount: l.discount, amount: l.amount, tax_amount: l.taxAmount, total_incl_tax: l.totalInclTax,
  dimensions: JSON.stringify(l.dimensions), custom_fields: JSON.stringify(l.customFields),
});

async function insertLines(tx: Tx, tenantId: string, companyId: string, documentId: string, lines: readonly LineWrite[]): Promise<void> {
  for (const l of lines) {
    await tx`insert into app.document_line ${lineWriteColumns(tx, tenantId, companyId, documentId, l)}`;
  }
}

async function upsertLines(tx: Tx, tenantId: string, companyId: string, documentId: string, lines: readonly LineWrite[]): Promise<void> {
  for (const l of lines) {
    await tx`insert into app.document_line ${lineWriteColumns(tx, tenantId, companyId, documentId, l)}
             on conflict (document_id, line_no) do update
                set description = excluded.description, account_id = excluded.account_id, kind = excluded.kind,
                    debit = excluded.debit, credit = excluded.credit,
                    quantity = excluded.quantity, unit_price = excluded.unit_price,
                    discount = excluded.discount, amount = excluded.amount,
                    tax_amount = excluded.tax_amount, total_incl_tax = excluded.total_incl_tax,
                    dimensions = excluded.dimensions, custom_fields = excluded.custom_fields`;
  }
}
```

`tx({ … })` is `postgres.js`'s own helper for a parameterised column/value pair — every value is bound, no identifier is built from a string, and the `no-sql-concat` lint is satisfied (contracts §3.3). `cost` is absent from both lists on purpose: it is the costing engine's column (3B), never a client's.

5. **Widen the `PUT …/lines` zeroing UPDATE, and widen `readDocument`'s tombstone filter with it.** `app_rw` holds no DELETE on `document_line` until 2B's migration 0023, so a replacement zeroes every existing row and upserts the new set. 1A's UPDATE zeroes five columns; the ten new ones would survive, and `loadSnapshot` (Task 7) applies **no** tombstone filter — so a policy keyed on `line.amount` would post a removed line's amount. Replace 1A's UPDATE with:

```ts
      // Every column a client can write is reset, so a tombstone carries no value any reader or the posting
      // service could act on. 1A zeroed five; migration 0019 added ten more, and loadSnapshot reads all of
      // them with no filter of its own — a stale `amount` here would post a line the caller deleted.
      await tx`update app.document_line
                  set debit = 0, credit = 0, description = null, account_id = null, dimensions = '{}'::jsonb,
                      kind = 'account', item_id = null, quantity = null, unit_price = null,
                      discount = 0, amount = 0, tax_code_id = null, tax_amount = 0, total_incl_tax = 0,
                      custom_fields = '{}'::jsonb
                where document_id = ${documentId}`;
```

and replace `readDocument`'s line query, whose predicate must now also test `kind`:

```ts
  // The `not (…)` clause hides the tombstones the PUT …/lines handler leaves behind. 1A's predicate was
  // `debit = 0 and credit = 0 and account_id is null`, unreachable for an API-created line *because
  // LineInput.accountId was required*. 2A makes `accountId` optional for an item line, so that shape is now
  // reachable — an item line legitimately has no account and zero debit/credit. `kind = 'account'` is what
  // restores the guarantee: `DocumentLineInput` refuses an `account` line with no `accountId`, so only the
  // zeroing UPDATE above can produce this exact combination.
  const lines = await tx<LineRow[]>`select ${lineColumns(tx)} from app.document_line
     where document_id = ${documentId}
       and not (kind = 'account' and debit = 0 and credit = 0 and account_id is null)
     order by line_no`;
```

6. **Widen `lineColumns` and `toDocument`'s line mapping** so the fields Step 4 adds to `DocumentLineSchema` are actually read:

```ts
const lineColumns = (tx: Sql) => tx`id, line_no, description, account_id, kind, debit::text as debit,
                                    credit::text as credit, item_id, quantity::text as quantity,
                                    unit_price::text as unit_price, discount::text as discount,
                                    amount::text as amount, tax_code_id, tax_amount::text as tax_amount,
                                    total_incl_tax::text as total_incl_tax, cost::text as cost,
                                    dimensions, custom_fields`;
```

and, inside `toDocument`, replace the `lines: lines.map(…)` member with:

```ts
  lines: lines.map((l) => ({
    id: l.id, lineNo: l.line_no, description: l.description, accountId: l.account_id,
    kind: l.kind as "account" | "item" | "tax" | "text",
    debit: l.debit, credit: l.credit,
    itemId: l.item_id, quantity: l.quantity, unitPrice: l.unit_price,
    discount: l.discount, amount: l.amount,
    taxCodeId: l.tax_code_id, taxAmount: l.tax_amount, totalInclTax: l.total_incl_tax, cost: l.cost,
    dimensions: l.dimensions, customFields: l.custom_fields,
  })),
```

adding the same ten members to 1A's `LineRow` interface in this file: `kind: string; item_id: string | null; quantity: string | null; unit_price: string | null; discount: string; amount: string; tax_code_id: string | null; tax_amount: string; total_incl_tax: string; cost: string | null`.

7. In `apps/api/src/routes/index.ts`, change the documents module's `permissions` to `DOCUMENT_STAGE_CODES`:

```ts
    { path: "/v1/companies/:companyId/documents", router: documentRoutes, permissions: DOCUMENT_STAGE_CODES, auth: "human" },
```

- [ ] **Step 4: Widen `packages/contracts/src/accounting/document.ts`**

**Two money regexes, and the difference is load-bearing.** 1A declares `const Amount = z.string().regex(/^\d+\.\d{4}$/); // document currency, never negative — the side carries the sign` (1a:4638). That stays exactly as it is and governs every **accepted** money field: `document_line.debit` and `.credit` carry `check (>= 0)` (1a:344–345), so a negative in the body would raise SQLSTATE 23514, whose message does not start with `ERR_`, and `fromDatabaseError` maps that to `ERR_INTERNAL` **500** instead of a 400. The **returned** line is a different matter: a reversal's `amount`, `discount`, `tax_amount`, `total_incl_tax` and `quantity` are negated (Task 8), so the response schema must admit a sign or every `GET` of a reversal fails wire validation. Hence `SignedAmount` beside `Amount`.

```ts
const Amount = z.string().regex(/^\d+\.\d{4}$/);          // 1A's, unchanged — accepted money, never negative
const SignedAmount = z.string().regex(/^-?\d+\.\d{4}$/);  // 2A — RETURNED money; a reversal's magnitudes are negated

export const DocumentTypeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
export const DocumentLineKindSchema = z.enum(["account", "item", "tax", "text"]);

/** The line as ACCEPTED, replacing 1A's inline `LineInput`. `itemId` and `taxCodeId` are absent by design:
 *  migration 0019 adds those columns with no foreign key, and 3A's 0032 and 5A's 0055 add the keys. Accepting
 *  a uuid the database cannot yet check would leave rows those ALTERs would refuse on live data. Each of those
 *  slices adds its field here in the PR that adds its key.
 *
 *  Both of 1A's guards are carried forward, and one is added:
 *   - every money field is `Amount` — non-negative, the side carries the sign;
 *   - a line is a debit or a credit, never both (`check (not (debit > 0 and credit > 0))`, 1a:349);
 *   - an `account` line must name an `accountId`. 1A made `accountId` unconditionally required and
 *     `readDocument`'s tombstone filter depends on that (1a:6281); an ITEM line legitimately has none, so
 *     the requirement becomes conditional on `kind` and the filter gains `kind = 'account'` (Step 3 item 6). */
export const DocumentLineInput = z.object({
  lineNo: z.number().int().positive(),
  kind: DocumentLineKindSchema.default("account"),
  description: z.string().max(500).optional(),
  accountId: UuidSchema.optional(),
  debit: Amount.default("0.0000"),
  credit: Amount.default("0.0000"),
  quantity: QuantitySchema.optional(),
  unitPrice: Amount.optional(),
  discount: Amount.default("0.0000"),
  amount: Amount.default("0.0000"),
  taxAmount: Amount.default("0.0000"),
  totalInclTax: Amount.default("0.0000"),
  dimensions: z.record(z.string(), UuidSchema).default({}),
  customFields: z.record(z.string(), z.unknown()).default({}),
})
  .strict()
  .refine((l) => !(l.debit !== "0.0000" && l.credit !== "0.0000"), {
    message: "a line is a debit or a credit, never both",
  })
  .refine((l) => l.kind !== "account" || l.accountId !== undefined, {
    message: "an account line must name an accountId",
  });

export const CreateDocumentBody = z.object({
  documentTypeCode: DocumentTypeCodeSchema,          // 1A pinned this to "JOURNAL"; the pin is what 2A removes
  effectiveDate: DateSchema,
  currency: CurrencySchema,
  branchId: UuidSchema,
  partyId: UuidSchema.optional(),
  clientRef: UuidSchema.optional(),
  lines: z.array(DocumentLineInput).min(1),
}).strict().openapi("CreateDocument");

export const ReplaceLinesBody = z.object({
  lines: z.array(DocumentLineInput).min(1),
}).strict().openapi("ReplaceLines");
```

`.min(1)` and the two `.openapi(…)` component names are 1A's and are **kept**: `openapi.json` is committed and CI fails on a diff (spec:2055), so renaming a component here would show up as an unexplained API break. `.strict()` is new and is what turns an `itemId` in the body into `ERR_VALIDATION_FAILED`.

Widen the **returned** line too, keeping its `.openapi("DocumentLine")` name:

```ts
export const DocumentLineSchema = z.object({
  id: UuidSchema, lineNo: z.number().int().positive(), description: z.string().nullable(),
  accountId: UuidSchema.nullable(),
  kind: DocumentLineKindSchema,
  debit: Amount, credit: Amount,                    // both columns carry check (>= 0): never signed
  itemId: UuidSchema.nullable(),                    // read-only until 3A's 0032 accepts it
  quantity: QuantitySchema.nullable(),
  unitPrice: SignedAmount.nullable(),
  discount: SignedAmount, amount: SignedAmount,
  taxCodeId: UuidSchema.nullable(),                 // read-only until 5A's 0055 accepts it
  taxAmount: SignedAmount, totalInclTax: SignedAmount,
  cost: SignedAmount.nullable(),                    // the costing engine's column (3B); never accepted
  dimensions: z.record(z.string(), z.string()), customFields: z.record(z.string(), z.unknown()),
}).openapi("DocumentLine");
```

Reading a column is not writing one: `itemId`, `taxCodeId` and `cost` appear here and nowhere in `DocumentLineInput`.

Add `QuantitySchema` to the file's `../common` import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test -- test/routes/accounting/documents.test.ts`
Expected: **PASS** — 1A's cases (one rewritten and one deleted by Step 1's two edits, so the file's 1A block is **one case shorter** than 1A left it) plus the **9** of the new block. If the rewritten drafter case now returns 403 on the *create*, the grant was widened but Step 3's middleware is resolving `approval.create` without the `?? approval.post` fallback. If "a documentTypeCode that names no type is 404" returns 403 instead, the middleware is calling `actor_has` before resolving the type — the order matters: an invisible type must never reveal itself through a permission error. If the item-line case's `GET` returns `lines: []`, `readDocument`'s tombstone predicate was not widened with `kind = 'account'` (Step 3 item 6). If it returns the line but with `quantity: null` and `amount: "0.0000"`, `insertLines` was not widened (Step 3 item 4).

Run: `bun run --cwd apps/api test -- test/routes/accounting/documents.test.ts -t "replace"`
Expected: PASS — 1A's own `PUT …/lines` cases, including the one that replaces three lines with two. The widened zeroing UPDATE must leave the shorter set readable and the removed line hidden.

Run: `bun run --cwd apps/api test && bun run --cwd packages/contracts test && bun run typecheck && bun run lint`
Expected: PASS. `bun run --cwd packages/contracts openapi:generate` then `git diff --exit-code packages/contracts/openapi.json` — regenerate and commit the OpenAPI document; CI fails on a diff (spec:2055).

- [ ] **Step 6: Commit**

```bash
git add apps/api packages/contracts
git commit -m "$(cat <<'EOF'
feat(api): the document gate comes from the policy, not from a literal [2A T9]

1A's Task 12 says twice that 2A replaces the static accounting.journal.* gates
with policy.approval.create / .post resolved from the effective policy and drops
the documentTypeCode pin; without that, "a new document type with zero code" is
false at the first hurdle. requireDocumentPermission is contracts §4.5.4 with all
six stages mapped (amendment A4), so 2B uses it and never edits the stage map.
RouteModule.permissions becomes DOCUMENT_STAGE_CODES, the explicit union every
type-seeding slice appends to. itemId and taxCodeId stay out of the request body
until 3A's 0032 and 5A's 0055 add their foreign keys.

Two of 1A's cases move with the gate, because JOURNAL_POLICY_V1 declares no
approval.create (contracts 4.4.1, round-2 correction) and every JOURNAL stage
therefore resolves to accounting.journal.post: the drafter is granted that code
too and its case now asserts create AND post, with spec:2158's separation moved
to POLICY_TEST where the policy actually names two codes; and the case titled
"refuses any documentTypeCode but JOURNAL at Phase 1 (2A lifts this)" is deleted
in favour of the 404 case that replaces it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The document-type and posting-policy API, and ADR 0027

The API through which a tenant adds a document type and gives it a posting policy — the sentence spec:2288 makes Phase 2's definition of done. Both live under `admin.company.manage`: contracts §3.6.2 fixes that "document types and posting policies are maintained under `admin.company.manage`" and the permission vocabulary is closed (§3.6.1), so no new code appears here.

A policy version is **append-only** through this API: there is `POST …/document-types/{documentTypeId}/policies` and no `PUT`. ADR 0027 records why, as a proposal (spec:95 — it touches the data model). The seed CLI's `on conflict (document_type_id, version) do update` (contracts §3.4.8) stays the one path that rewrites a version, and it exists so a placeholder seeded on staging cannot outlive the real definition.

Every definition is validated by `validatePolicy(definition, catalogue)` **before** the insert — schema *and* the F-21 catalogue check, so a policy naming a permission code no slice has shipped is refused at configuration time rather than at post.

**Files:**
- Create: `packages/contracts/src/admin/document-type.ts`, `apps/api/src/routes/admin/document-types.ts`, `apps/api/test/routes/admin/document-types.test.ts`, `docs/adr/0027-posting-policy-versions-are-append-only.md`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Produces (contracts, amendment A2): `DocumentTypeSchema`, `CreateDocumentTypeBody`, `DocumentTypeQuery`, `DocumentTypeList`, `PostingPolicySchema`, `CreatePostingPolicyBody`, `PostingPolicyList`.
- Produces (api, amendment A3): `documentTypeRoutes`; a `RouteModule` `{ path: "/v1/companies/:companyId/document-types", router: documentTypeRoutes, permissions: [PERMISSION["admin.company.manage"]], auth: "human" }`; a `PROBES` entry under that path.
- Consumes: `validatePolicy`, `PolicyValidation` (1A/Task 5); `PERMISSIONS`, `PERMISSION`, `requirePermission`, `AppError`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `IdempotencyHeader` (0B); `startApi`, `grantAdmin`, `problemOf` (0B).

- [ ] **Step 1: Write the failing test `apps/api/test/routes/admin/document-types.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/document-types — contracts §4.3.7, spec:2288", () => {
  let api: StartedApi; let a: Seed;
  const base = () => `/v1/companies/${a.company}/document-types`;

  const POLICY = {
    version: 1, documentType: "CONSIGNMENT_RETURN", direction: "inbound", requires: [],
    lines: [
      { for: "each_line", side: "debit",  account: { from: "line.account" }, amount: "line.debit",  when: { "line.kind": "account" } },
      { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
    ],
    inventory: { effect: "none" }, tax: { applies: false },
    numbering: { series: "CR", assignAt: "issue" },
    reversal: { allowed: true, producesType: "CONSIGNMENT_RETURN" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  };

  beforeAll(async () => { api = await startApi(); a = await seedTenantV2(api.db, "Alpha"); await grantAdmin(api, a); });
  afterAll(async () => { await api.stop(); });

  const createType = (over: Record<string, unknown> = {}) => api.request({
    method: "POST", path: base(), as: a.human,
    body: { code: "CONSIGNMENT_RETURN", nameEn: "Consignment return", nameAr: "مرتجع أمانة", module: "accounting", ...over },
  });

  it("creates a type with its module and returns it", async () => {
    const res = await createType();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ code: "CONSIGNMENT_RETURN", module: "accounting", archivedAt: null });
  });

  it("refuses a second type with the same code in the company", async () => {
    expect((await problemOf(await createType())).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("refuses a module outside the four the attachment gate knows", async () => {
    // `X1` never reaches app.document_type: Zod refuses the body on `module` before the handler runs, so no
    // code enters §4.14's namespace here (hazard 32 governs codes that are *written*, and none is).
    expect((await problemOf(await createType({ code: "X1", module: "admin" }))).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("adds a policy version and returns it with its effective_from", async () => {
    const { id } = (await (await api.request({ method: "GET", path: `${base()}?filter[code][eq]=CONSIGNMENT_RETURN`, as: a.human })).json() as { items: { id: string }[] }).items[0]!;
    const res = await api.request({
      method: "POST", path: `${base()}/${id}/policies`, as: a.human,
      body: { version: 1, effectiveFrom: "2026-01-01", definition: POLICY },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ version: 1, effectiveFrom: "2026-01-01" });
  });

  it("refuses a definition that fails the schema, naming the path (ERR_POLICY_INVALID)", async () => {
    const { id } = (await (await api.request({ method: "GET", path: `${base()}?filter[code][eq]=CONSIGNMENT_RETURN`, as: a.human })).json() as { items: { id: string }[] }).items[0]!;
    const res = await api.request({
      method: "POST", path: `${base()}/${id}/policies`, as: a.human,
      body: { version: 2, effectiveFrom: "2026-02-01", definition: { ...POLICY, inventory: { effect: "issue" } } },
    });
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_POLICY_INVALID");
    expect(problem.errors!.map((e) => e.path)).toContain("/inventory");
  });

  it("refuses a definition naming a permission code no slice has shipped (F-21)", async () => {
    const { id } = (await (await api.request({ method: "GET", path: `${base()}?filter[code][eq]=CONSIGNMENT_RETURN`, as: a.human })).json() as { items: { id: string }[] }).items[0]!;
    const res = await api.request({
      method: "POST", path: `${base()}/${id}/policies`, as: a.human,
      body: { version: 2, effectiveFrom: "2026-02-01",
              definition: { ...POLICY, approval: { required: false, approve: null, post: "inventory.receipt.post" } } },
    });
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_POLICY_INVALID");
    expect(problem.detail).toMatch(/inventory\.receipt\.post/);
  });

  it("a version is append-only — the same version number is a conflict, never an overwrite (ADR 0027)", async () => {
    const { id } = (await (await api.request({ method: "GET", path: `${base()}?filter[code][eq]=CONSIGNMENT_RETURN`, as: a.human })).json() as { items: { id: string }[] }).items[0]!;
    const res = await api.request({
      method: "POST", path: `${base()}/${id}/policies`, as: a.human,
      body: { version: 1, effectiveFrom: "2026-03-01", definition: POLICY },
    });
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
    const list = await api.request({ method: "GET", path: `${base()}/${id}/policies`, as: a.human });
    const page = (await list.json()) as { items: { version: number; effectiveFrom: string }[]; next_cursor: string | null };
    expect(page.items).toEqual([{ version: 1, effectiveFrom: "2026-01-01" }].map((x) => expect.objectContaining(x)));
    // One row under the default limit of 100, so the page is complete and the cursor is null — not the
    // unconditional `null` a truncating handler would also return.
    expect(page.next_cursor).toBeNull();
  });

  it("the types list pages with the shared cursor codec rather than truncating (§4.2.8)", async () => {
    const one = await api.request({ method: "GET", path: `${base()}?limit=1`, as: a.human });
    const first = (await one.json()) as { items: { code: string }[]; next_cursor: string | null };
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();                       // there is more than one type in this company
    const two = await api.request({ method: "GET", path: `${base()}?limit=1&cursor=${first.next_cursor}`, as: a.human });
    const second = (await two.json()) as { items: { code: string }[] };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.code).not.toBe(first.items[0]!.code);   // (code, id) advanced; nothing repeats
  });

  it("archiving is an update, and an archived type is not offered for a new document", async () => {
    // POLICY_TEST_2 is §4.14's second test-only code (amendment A1). A second code is needed because the
    // cases above must keep CONSIGNMENT_RETURN unarchived, and hazard 32 forbids inventing one.
    const created = await createType({ code: "POLICY_TEST_2", nameEn: "Archive me" });
    const { id } = (await created.json()) as { id: string };
    const res = await api.request({ method: "POST", path: `${base()}/${id}/archive`, as: a.human, body: {} });
    expect(res.status).toBe(200);
    expect((await res.json() as { archivedAt: string | null }).archivedAt).not.toBeNull();
    const list = await api.request({ method: "GET", path: base(), as: a.human });
    expect(((await list.json()) as { items: { code: string }[] }).items.map((i) => i.code)).not.toContain("POLICY_TEST_2");
  });

  it("a principal without admin.company.manage is refused", async () => {
    const b = await seedTenantV2(api.db, "Beta");                       // no grantAdmin
    const res = await api.request({ method: "POST", path: `/v1/companies/${b.company}/document-types`, as: b.human,
                                    body: { code: "NOPE", nameEn: "Nope", module: "accounting" } });
    expect(res.status).toBe(403);
  });
});
```

Run: `bun run --cwd apps/api test -- test/routes/admin/document-types.test.ts`
Expected: **FAIL** — every case 404s; the route module does not exist.

- [ ] **Step 2: Write `packages/contracts/src/admin/document-type.ts`**

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const DocumentTypeModuleSchema = z.enum(["accounting", "inventory", "hr", "pos"]);

export const DocumentTypeSchema = z.object({
  id: UuidSchema,
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  /** contracts §4.5.8: which module's READ permission may download this document's attachments. It is NOT
   *  the module segment of approval.post — PAYROLL_PAYMENT posts under accounting.payment.post and is 'hr'. */
  module: DocumentTypeModuleSchema,
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

export const CreateDocumentTypeBody = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  module: DocumentTypeModuleSchema,
}).strict();

export const DocumentTypeQuery = ListQuery.extend({
  "filter[code][eq]": z.string().optional(),
  "filter[module][eq]": DocumentTypeModuleSchema.optional(),
  includeArchived: z.enum(["true", "false"]).default("false"),
});
export const DocumentTypeList = ListEnvelope(DocumentTypeSchema);

export const PostingPolicySchema = z.object({
  id: UuidSchema,
  documentTypeId: UuidSchema,
  version: z.number().int().positive(),
  effectiveFrom: DateSchema,
  definition: z.unknown(),                       // validated against posting-policy.schema.json, not by Zod
  createdAt: TimestampSchema,
});

export const CreatePostingPolicyBody = z.object({
  version: z.number().int().positive(),
  effectiveFrom: DateSchema,
  definition: z.unknown(),
}).strict();

export const PostingPolicyList = ListEnvelope(PostingPolicySchema);
```

The definition is `z.unknown()` on purpose: JSON Schema is the validator (ADR 0022, ADR 0026), and a second Zod transcription of it would be a second spelling of one thing.

- [ ] **Step 3: Write `apps/api/src/routes/admin/document-types.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { validatePolicy } from "@dulja/domain";
import {
  AppError, CreateDocumentTypeBody, CreatePostingPolicyBody, decodeCursor, DocumentTypeList, DocumentTypeQuery,
  DocumentTypeSchema, encodeCursor, ListQuery, PERMISSION, PERMISSIONS, PostingPolicyList, PostingPolicySchema,
  ProblemSchema, UuidSchema,
} from "@dulja/contracts";
import type { AppEnv } from "../../context";
import { IdempotencyHeader } from "../index";
import { requirePermission } from "../../middleware/require-permission";

export const documentTypeRoutes = new OpenAPIHono<AppEnv>();
const scope = { company: "path:companyId" } as const;
const gate = () => requirePermission(PERMISSION["admin.company.manage"], scope);
const CATALOGUE: readonly string[] = PERMISSIONS.map((p) => p.code);

documentTypeRoutes.openapi(createRoute({
  method: "post", path: "/",
  request: { params: z.object({ companyId: UuidSchema }), headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: CreateDocumentTypeBody } } } },
  responses: { 201: { description: "Created", content: { "application/json": { schema: DocumentTypeSchema } } },
               409: { description: "Duplicate code", content: { "application/problem+json": { schema: ProblemSchema } } } },
  middleware: [gate()], tags: ["admin"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await c.var.withTenant((tx) => tx<DocumentTypeRow[]>`
    insert into app.document_type (tenant_id, company_id, code, name_en, name_ar, module)
    values (${c.var.ctx.tenantId}, ${companyId}, ${body.code}, ${body.nameEn}, ${body.nameAr ?? null}, ${body.module})
    returning id, code, name_en, name_ar, module, archived_at, created_at`);
  return c.json(toDto(row[0]!), 201);
});

documentTypeRoutes.openapi(createRoute({
  method: "get", path: "/",
  request: { params: z.object({ companyId: UuidSchema }), query: DocumentTypeQuery },
  responses: { 200: { description: "OK", content: { "application/json": { schema: DocumentTypeList } } } },
  middleware: [gate()], tags: ["admin"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  // Keyset pagination on (code, id) — the declared sort key — with the shared codec of §4.2.8. A hard-coded
  // `next_cursor: null` under a LIMIT truncates silently, and a company may hold more than the 100 types
  // `ListQuery.limit` defaults to.
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const afterCode = after ? String(after.k[0]) : null;
  const rows = await c.var.withTenant((tx) => tx<DocumentTypeRow[]>`
    select id, code, name_en, name_ar, module, archived_at, created_at
      from app.document_type
     where company_id = ${companyId}
       and (${q.includeArchived === "true"} or archived_at is null)
       and (${q["filter[code][eq]"] ?? null}::text is null or code = ${q["filter[code][eq]"] ?? null})
       and (${q["filter[module][eq]"] ?? null}::text is null or module = ${q["filter[module][eq]"] ?? null})
       and (${afterCode}::text is null or (code, id) > (${afterCode}, ${after?.id ?? null}::uuid))
     order by code, id
     limit ${q.limit}`);
  const last = rows.at(-1);
  return c.json({
    items: rows.map(toDto),
    next_cursor: rows.length === q.limit && last ? encodeCursor({ k: [last.code], id: last.id }) : null,
  }, 200);
});

documentTypeRoutes.openapi(createRoute({
  method: "post", path: "/{documentTypeId}/archive",
  request: { params: z.object({ companyId: UuidSchema, documentTypeId: UuidSchema }), headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: z.object({}).strict() } } } },
  responses: { 200: { description: "Archived", content: { "application/json": { schema: DocumentTypeSchema } } },
               404: { description: "Unknown", content: { "application/problem+json": { schema: ProblemSchema } } } },
  middleware: [gate()], tags: ["admin"],
}), async (c) => {
  const { documentTypeId } = c.req.valid("param");
  const rows = await c.var.withTenant((tx) => tx<DocumentTypeRow[]>`
    update app.document_type set archived_at = now()
     where id = ${documentTypeId} and archived_at is null
     returning id, code, name_en, name_ar, module, archived_at, created_at`);
  if (rows.length === 0) throw new AppError("ERR_NOT_FOUND", `no unarchived document type ${documentTypeId}`);
  return c.json(toDto(rows[0]!), 200);
});

documentTypeRoutes.openapi(createRoute({
  method: "post", path: "/{documentTypeId}/policies",
  request: { params: z.object({ companyId: UuidSchema, documentTypeId: UuidSchema }), headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: CreatePostingPolicyBody } } } },
  responses: { 201: { description: "Created", content: { "application/json": { schema: PostingPolicySchema } } },
               409: { description: "Version exists", content: { "application/problem+json": { schema: ProblemSchema } } },
               422: { description: "Invalid definition", content: { "application/problem+json": { schema: ProblemSchema } } } },
  middleware: [gate()], tags: ["admin"],
}), async (c) => {
  const { documentTypeId } = c.req.valid("param");
  const body = c.req.valid("json");

  // Schema AND catalogue, before any write: a policy naming a permission code no slice has shipped is
  // refused at configuration time rather than at post (F-21, contracts §4.4.1).
  const report = validatePolicy(body.definition, CATALOGUE);
  if (!report.ok) {
    // `errors` carries the JSON Pointer into the rejected definition. §4.2.4's comment reserved the member
    // for ERR_VALIDATION_FAILED; amendment A10 extends it to ERR_POLICY_INVALID, because SAH-078's claim is
    // that an invalid rule is refused at configuration time *naming the JSON path*, and `detail` alone makes
    // a caller parse prose. `detail` carries the same paths so a human-readable message loses nothing.
    throw new AppError("ERR_POLICY_INVALID",
      `posting policy for document type ${documentTypeId} is invalid: ${report.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`,
      { errors: report.errors });
  }

  const rows = await c.var.withTenant(async (tx) => {
    const [type] = await tx<{ code: string }[]>`select code from app.document_type where id = ${documentTypeId}`;
    if (!type) throw new AppError("ERR_NOT_FOUND", `no document type ${documentTypeId}`);
    const declared = (body.definition as { documentType?: unknown }).documentType;
    if (declared !== type.code) {
      throw new AppError("ERR_POLICY_INVALID", `definition.documentType ${String(declared)} does not equal the type's code ${type.code}`);
    }
    // Append-only: no `on conflict` (ADR 0027). A duplicate version raises 23505 → ERR_CONFLICT_UNIQUE.
    return tx<PolicyRow[]>`
      insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
      values (${c.var.ctx.tenantId}, ${documentTypeId}, ${body.version}, ${body.effectiveFrom}::date,
              ${JSON.stringify(body.definition)}::jsonb)
      returning id, document_type_id, version, to_char(effective_from, 'YYYY-MM-DD') as effective_from, definition, created_at`;
  });
  return c.json(toPolicyDto(rows[0]!), 201);
});

documentTypeRoutes.openapi(createRoute({
  method: "get", path: "/{documentTypeId}/policies",
  request: { params: z.object({ companyId: UuidSchema, documentTypeId: UuidSchema }), query: ListQuery },
  responses: { 200: { description: "OK", content: { "application/json": { schema: PostingPolicyList } } } },
  middleware: [gate()], tags: ["admin"],
}), async (c) => {
  const { documentTypeId } = c.req.valid("param");
  const q = c.req.valid("query");
  // The policy list on a type is its whole history and ADR 0027 makes it append-only, so it only grows —
  // which is exactly why it needs a cursor. `version` is unique per type (`unique (document_type_id,
  // version)`), so the keyset is one column plus the id tiebreak the codec always carries.
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const afterVersion = after ? Number(after.k[0]) : null;
  const rows = await c.var.withTenant((tx) => tx<PolicyRow[]>`
    select id, document_type_id, version, to_char(effective_from, 'YYYY-MM-DD') as effective_from, definition, created_at
      from app.posting_policy
     where document_type_id = ${documentTypeId}
       and (${afterVersion}::int is null or version > ${afterVersion})
     order by version
     limit ${q.limit}`);
  const last = rows.at(-1);
  return c.json({
    items: rows.map(toPolicyDto),
    next_cursor: rows.length === q.limit && last ? encodeCursor({ k: [last.version], id: last.id }) : null,
  }, 200);
});

interface DocumentTypeRow { id: string; code: string; name_en: string; name_ar: string | null; module: string; archived_at: Date | null; created_at: Date }
interface PolicyRow { id: string; document_type_id: string; version: number; effective_from: string; definition: unknown; created_at: Date }

const toDto = (r: DocumentTypeRow) => ({
  id: r.id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar,
  module: r.module as "accounting" | "inventory" | "hr" | "pos",
  archivedAt: r.archived_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
});
const toPolicyDto = (r: PolicyRow) => ({
  id: r.id, documentTypeId: r.document_type_id, version: r.version,
  effectiveFrom: r.effective_from, definition: r.definition, createdAt: r.created_at.toISOString(),
});
```

Register the module in `apps/api/src/routes/index.ts` **inside `buildRoutes`** (never by pushing onto `ROUTES` — §4.2.7):

```ts
    { path: "/v1/companies/:companyId/document-types", router: documentTypeRoutes, permissions: [PERMISSION["admin.company.manage"]], auth: "human" },
```

and add the probe to `tests/invariants/probes.ts`:

```ts
  "/v1/companies/:companyId/document-types": {
    seed: async (db, owner) => ({ path: `/v1/companies/${owner.company}/document-types`, method: "GET" }),
    expect: 403,
  },
```

- [ ] **Step 4: Write `docs/adr/0027-posting-policy-versions-are-append-only.md`**

```markdown
# ADR 0027 — A posting-policy version is append-only through the API

**Status:** PROPOSED — the rule shapes the data model's write paths, so spec:95 requires a proposal.
**Date:** 2026-09-05
**Deciders:** owner (pending), architect
**Slice:** 2A

## Context

`app.posting_policy` is keyed `unique (document_type_id, version)` and every posted document pins the
`posting_policy_id` that produced it (spec:1753, SAH-013). The legacy system's failure was that a reversal read
the *current* document-type flags rather than the ones originally applied.

Pinning the id is necessary but not sufficient: if the row a pinned id points at can be rewritten, the pin
buys nothing. Two write paths exist — the seed CLI (contracts §3.4.8) and this slice's configuration API — and
they need different rules.

## Decision

**The API is append-only.** `POST /v1/companies/{companyId}/document-types/{documentTypeId}/policies` inserts a
new `(document_type_id, version)` row. There is no `PUT` and no `PATCH` on a version. A repeated version number
raises SQLSTATE 23505 → `ERR_CONFLICT_UNIQUE`. A correction is a new version with a later `effective_from`;
`resolvePolicy` picks the greatest `effective_from ≤ effective_date`, ties broken by the highest version
(contracts §4.3.1), so a corrected rule applies from the date the tenant chooses and never retroactively.

**The seed CLI keeps its upsert**, which contracts §3.4.8 fixes as `on conflict (document_type_id, version) do
update set definition = …, effective_from = …`, and which is deliberately the *only* path that rewrites a
version. Its reason is stated there: a placeholder policy seeded on staging in an early phase would otherwise
silently survive the real definition arriving later, and the phase's tests would pass locally and fail on
staging. That path is a reviewed diff of a version-controlled file under an operator's hand (SAH-078); the API
path is a tenant's admin clicking a button.

## Alternatives considered

- **`PUT` on a version, refused once a document has posted under it.** Rejected: the check is a `select … from
  app.document where posting_policy_id = …`, which is racy against a concurrent post and would need the same
  advisory-lock machinery the numbering path has, to protect an operation nobody needs. Adding a version is
  cheap and its audit trail is the row itself.
- **No API path at all; policies only through the seed pack.** Rejected: spec:2288 requires a tenant to add a
  document type, and test 15 requires it to be provable without a deployment.

## Consequences

- The policy list on a type is its history; `report_definition`-style cloning is not needed.
- `app.posting_policy` has no `archived_at`: superseding is what a later `effective_from` does.
- 2B's status trigger resolves the policy by `effective_from ≤ effective_date` for R1/R2 and reads a row that
  cannot have changed under it since the document was drafted.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test -- test/routes/admin/document-types.test.ts`
Expected: **PASS** (10 cases). If the F-21 case passes the wrong way — a 201 for `inventory.receipt.post` — `CATALOGUE` is being built from something other than `PERMISSIONS`. If the paging case gets `next_cursor: null` on a one-row page, `next_cursor` is still hard-coded rather than emitted from `encodeCursor` when `rows.length === q.limit`. The paging case depends on this company holding at least two unarchived types by the time it runs — `JOURNAL` from `seedTenantV2` and `CONSIGNMENT_RETURN` from the first case — so it must stay below the append-only case and above the archive case.

Run: `bun run --cwd apps/api test && bun run --cwd tests test && bun run typecheck && bun run lint`
Expected: PASS — the tenant-isolation harness now finds a `PROBES` entry for the new path; without one it fails the build (contracts §5 item 31).

Regenerate and commit the OpenAPI document: `bun run --cwd packages/contracts openapi:generate`.

- [ ] **Step 6: Commit**

```bash
git add apps/api packages/contracts tests docs/adr/0027-posting-policy-versions-are-append-only.md
git commit -m "$(cat <<'EOF'
feat(api): the document-type and posting-policy configuration API [2A T10]

The half of "a new document type is added with zero code" that a tenant touches:
create a type with its module, add a policy version, list and archive. Every
definition passes validatePolicy — schema AND the F-21 catalogue check — before
the insert, so a policy naming a permission code no slice has shipped is refused
at configuration time, not at post. ADR 0027 (proposal) records why the API is
append-only while the seed CLI keeps the upsert contracts §3.4.8 gives it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The party API

`/v1/companies/{companyId}/parties` under `accounting.party.manage` — the code Task 4 seeded, and the reference that closes the `permission-catalogue` window the Global Constraints opened there. Parties are master data: created, edited, **archived, never deleted** (spec:2049).

**Files:**
- Create: `packages/contracts/src/accounting/party.ts`, `apps/api/src/routes/accounting/parties.ts`, `apps/api/test/routes/accounting/parties.test.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Produces (contracts, amendment A2): `PartyKindSchema`, `PartySchema`, `CreatePartyBody`, `UpdatePartyBody`, `PartyQuery`, `PartyList`.
- Produces (api, amendment A3): `partyRoutes`; a `RouteModule` `{ path: "/v1/companies/:companyId/parties", router: partyRoutes, permissions: [PERMISSION["accounting.party.manage"]], auth: "human" }`; a `PROBES` entry.
- Consumes: `PERMISSION`, `requirePermission`, `AppError`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `CurrencySchema`, `TimestampSchema`, `IdempotencyHeader`, `encodeCursor`, `decodeCursor` (0B); `startApi`, `grantAdmin`, `problemOf` (0B); `seedTenantV2`, `seedParty` (1A, Task 1).

- [ ] **Step 1: Write the failing test `apps/api/test/routes/accounting/parties.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedAccount, seedTenantV2, type Seed } from "@dulja/db/test";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/parties — spec:1169, contracts §4.5.7", () => {
  let api: StartedApi; let a: Seed; let receivable: string;
  const base = () => `/v1/companies/${a.company}/parties`;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await grantAdmin(api, a);
    receivable = await seedAccount(api.db, a, { code: "1200", nameEn: "Trade receivables", type: "asset" });
  });
  afterAll(async () => { await api.stop(); });

  const create = (over: Record<string, unknown> = {}) => api.request({
    method: "POST", path: base(), as: a.human,
    body: { kind: "customer", code: "C-001", nameEn: "Kedai Runcit Ali", nameAr: "دكان علي",
            receivableAccountId: receivable, ...over },
  });

  it("creates a customer and returns it with archivedAt null", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ kind: "customer", code: "C-001", nameEn: "Kedai Runcit Ali", nameAr: "دكان علي", archivedAt: null });
  });

  it("accepts the five kinds spec:1169 names and refuses a sixth", async () => {
    for (const kind of ["customer", "vendor", "employee", "student", "dealer"]) {
      expect((await create({ kind, code: `K-${kind}` })).status).toBe(201);
    }
    expect((await problemOf(await create({ kind: "supplier", code: "K-x" }))).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("refuses a duplicate code in the company", async () => {
    // The first call is a 201 whose body is a PartySchema DTO, not a problem+json document — `problemOf` on
    // it would read `status` off a party and compare `undefined` to 201.
    expect((await create({ code: "DUP" })).status).toBe(201);
    expect((await problemOf(await create({ code: "DUP" }))).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("refuses a receivable account belonging to another tenant (the composite FK)", async () => {
    // The title is exact, and Task 1's equivalent case carries the same one: §4.5.7's key is
    // `(tenant_id, receivable_account_id) → app.account(tenant_id, id)` — tenant-composite only — so an
    // account belonging to a SIBLING COMPANY inside the same tenant would be accepted by the schema. That
    // narrower rule is not this slice's to enforce and no case here claims it.
    const b = await seedTenantV2(api.db, "Beta");
    const foreign = await seedAccount(api.db, b, { code: "1200", nameEn: "Trade receivables", type: "asset" });
    expect((await problemOf(await create({ code: "XA", receivableAccountId: foreign }))).code).toBe("ERR_CONFLICT_REFERENCE");
  });

  it("lists, filters by kind and pages with the shared cursor codec", async () => {
    const first = await api.request({ method: "GET", path: `${base()}?filter[kind][eq]=customer&limit=2`, as: a.human });
    const page = (await first.json()) as { items: { kind: string }[]; next_cursor: string | null };
    expect(page.items.every((i) => i.kind === "customer")).toBe(true);
    expect(page.items).toHaveLength(2);
    const second = await api.request({ method: "GET", path: `${base()}?filter[kind][eq]=customer&limit=2&cursor=${page.next_cursor}`, as: a.human });
    const next = (await second.json()) as { items: { code: string }[] };
    expect(next.items.map((i) => i.code)).not.toContain((page.items as unknown as { code: string }[])[0]!.code);
  });

  it("updates the editable fields and leaves code and kind alone", async () => {
    const { id } = (await (await create({ code: "UPD" })).json()) as { id: string };
    const res = await api.request({ method: "PATCH", path: `${base()}/${id}`, as: a.human,
                                    body: { nameEn: "Renamed", phone: "+60-3-0000000" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nameEn: "Renamed", phone: "+60-3-0000000", code: "UPD", kind: "customer" });
    const rejected = await api.request({ method: "PATCH", path: `${base()}/${id}`, as: a.human, body: { code: "OTHER" } });
    expect((await problemOf(rejected)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("archives rather than deletes, and an archived party is out of the default list (spec:2049)", async () => {
    const { id } = (await (await create({ code: "ARC" })).json()) as { id: string };
    const res = await api.request({ method: "POST", path: `${base()}/${id}/archive`, as: a.human, body: {} });
    expect(res.status).toBe(200);
    expect((await res.json() as { archivedAt: string | null }).archivedAt).not.toBeNull();
    const list = await api.request({ method: "GET", path: `${base()}?limit=1000`, as: a.human });
    expect(((await list.json()) as { items: { code: string }[] }).items.map((i) => i.code)).not.toContain("ARC");
    const deleted = await api.request({ method: "DELETE", path: `${base()}/${id}`, as: a.human });
    expect(deleted.status).toBe(404);                 // there is no DELETE route at all
  });

  it("a principal without accounting.party.manage is refused", async () => {
    const b = await seedTenantV2(api.db, "Beta2");
    const res = await api.request({ method: "POST", path: `/v1/companies/${b.company}/parties`, as: b.human,
                                    body: { kind: "customer", code: "NOPE", nameEn: "Nope" } });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("every unsafe call needs an Idempotency-Key, and a replay returns the first response", async () => {
    const missing = await api.request({ method: "POST", path: base(), as: a.human, idempotencyKey: null,
                                        body: { kind: "vendor", code: "IDEM", nameEn: "Idem" } });
    expect((await problemOf(missing)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    const key = "party-idem-1";
    const one = await api.request({ method: "POST", path: base(), as: a.human, idempotencyKey: key,
                                    body: { kind: "vendor", code: "IDEM", nameEn: "Idem" } });
    const two = await api.request({ method: "POST", path: base(), as: a.human, idempotencyKey: key,
                                    body: { kind: "vendor", code: "IDEM", nameEn: "Idem" } });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.headers.get("Idempotency-Replayed")).toBe("true");
  });
});
```

Run: `bun run --cwd apps/api test -- test/routes/accounting/parties.test.ts`
Expected: **FAIL** — every case 404s; the route module does not exist.

- [ ] **Step 2: Write `packages/contracts/src/accounting/party.ts`**

```ts
import { z } from "@hono/zod-openapi";
import { CurrencySchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

/** spec:1169 — one entity with one discriminator, replacing the legacy Account's twenty Is* flags (SAH-072).
 *  `student` and `dealer` are reserved names carried so a later module is data, not a migration. */
export const PartyKindSchema = z.enum(["customer", "vendor", "employee", "student", "dealer"]);

export const PartySchema = z.object({
  id: UuidSchema,
  kind: PartyKindSchema,
  code: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  receivableAccountId: UuidSchema.nullable(),
  payableAccountId: UuidSchema.nullable(),
  currency: CurrencySchema.nullable(),
  taxRegistration: z.string().max(64).nullable(),
  email: z.string().email().max(320).nullable(),
  phone: z.string().max(64).nullable(),
  address: z.record(z.string(), z.unknown()),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

export const CreatePartyBody = z.object({
  kind: PartyKindSchema,
  code: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  receivableAccountId: UuidSchema.optional(),
  payableAccountId: UuidSchema.optional(),
  currency: CurrencySchema.optional(),
  taxRegistration: z.string().max(64).optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(64).optional(),
  address: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** `code` and `kind` are absent: a party's identity and its discriminator do not change under an edit.
 *  `.strict()` turns an attempt into ERR_VALIDATION_FAILED rather than a silent no-op. */
export const UpdatePartyBody = CreatePartyBody.omit({ kind: true, code: true }).partial().strict();

export const PartyQuery = ListQuery.extend({
  "filter[kind][eq]": PartyKindSchema.optional(),
  "filter[code][eq]": z.string().optional(),
  includeArchived: z.enum(["true", "false"]).default("false"),
});
export const PartyList = ListEnvelope(PartySchema);
```

- [ ] **Step 3: Write `apps/api/src/routes/accounting/parties.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError, CreatePartyBody, decodeCursor, encodeCursor, PartyList, PartyQuery, PartySchema,
  PERMISSION, ProblemSchema, UpdatePartyBody, UuidSchema,
} from "@dulja/contracts";
import type { AppEnv } from "../../context";
import { IdempotencyHeader } from "../index";
import { requirePermission } from "../../middleware/require-permission";

export const partyRoutes = new OpenAPIHono<AppEnv>();
const gate = () => requirePermission(PERMISSION["accounting.party.manage"], { company: "path:companyId" });

interface PartyRow {
  id: string; kind: string; code: string; name_en: string; name_ar: string | null;
  receivable_account_id: string | null; payable_account_id: string | null; currency: string | null;
  tax_registration: string | null; email: string | null; phone: string | null;
  address: Record<string, unknown>; archived_at: Date | null; created_at: Date;
}
const toDto = (r: PartyRow) => ({
  id: r.id, kind: r.kind as "customer" | "vendor" | "employee" | "student" | "dealer",
  code: r.code, nameEn: r.name_en, nameAr: r.name_ar,
  receivableAccountId: r.receivable_account_id, payableAccountId: r.payable_account_id,
  currency: r.currency, taxRegistration: r.tax_registration, email: r.email, phone: r.phone,
  address: r.address, archivedAt: r.archived_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
});

// The column list is written out in each of the five statements below. There is no `const COLUMNS` string and
// no `tx.unsafe(COLUMNS)`: contracts §3.3 gives `sql.unsafe` exactly three homes and none of them is in this
// slice, and the `no-sql-concat` lint (test 27) is what keeps SAH-036/037/069 closed. Five repetitions of one
// line is the price, and it is the right price.

partyRoutes.openapi(createRoute({
  method: "post", path: "/",
  request: { params: z.object({ companyId: UuidSchema }), headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: CreatePartyBody } } } },
  responses: { 201: { description: "Created", content: { "application/json": { schema: PartySchema } } },
               409: { description: "Duplicate code or unknown account", content: { "application/problem+json": { schema: ProblemSchema } } } },
  middleware: [gate()], tags: ["accounting"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const b = c.req.valid("json");
  const rows = await c.var.withTenant((tx) => tx<PartyRow[]>`
    insert into app.party (tenant_id, company_id, kind, code, name_en, name_ar, receivable_account_id,
                           payable_account_id, currency, tax_registration, email, phone, address)
    values (${c.var.ctx.tenantId}, ${companyId}, ${b.kind}, ${b.code}, ${b.nameEn}, ${b.nameAr ?? null},
            ${b.receivableAccountId ?? null}, ${b.payableAccountId ?? null}, ${b.currency ?? null},
            ${b.taxRegistration ?? null}, ${b.email ?? null}, ${b.phone ?? null},
            ${JSON.stringify(b.address ?? {})}::jsonb)
    returning id, kind, code, name_en, name_ar, receivable_account_id, payable_account_id, currency,
              tax_registration, email, phone, address, archived_at, created_at`);
  return c.json(toDto(rows[0]!), 201);
});
```

The remaining four routes:

```ts
partyRoutes.openapi(createRoute({
  method: "get", path: "/",
  request: { params: z.object({ companyId: UuidSchema }), query: PartyQuery },
  responses: { 200: { description: "OK", content: { "application/json": { schema: PartyList } } } },
  middleware: [gate()], tags: ["accounting"],
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  // Keyset pagination on (code, id) — the declared sort key, never a field name reaching SQL as text
  // (contracts §4.2.8, test 27). The cursor codec is the shared one; a second base64url round-trip here
  // would be two spellings of one thing (hazard 9).
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const afterCode = after ? String(after.k[0]) : null;
  const rows = await c.var.withTenant((tx) => tx<PartyRow[]>`
    select id, kind, code, name_en, name_ar, receivable_account_id, payable_account_id, currency,
           tax_registration, email, phone, address, archived_at, created_at
      from app.party
     where company_id = ${companyId}
       and (${q.includeArchived === "true"} or archived_at is null)
       and (${q["filter[kind][eq]"] ?? null}::text is null or kind = ${q["filter[kind][eq]"] ?? null})
       and (${q["filter[code][eq]"] ?? null}::text is null or code = ${q["filter[code][eq]"] ?? null})
       and (${afterCode}::text is null or (code, id) > (${afterCode}, ${after?.id ?? null}::uuid))
     order by code, id
     limit ${q.limit}`);
  const last = rows.at(-1);
  return c.json({
    items: rows.map(toDto),
    next_cursor: rows.length === q.limit && last ? encodeCursor({ k: [last.code], id: last.id }) : null,
  }, 200);
});

partyRoutes.openapi(createRoute({
  method: "get", path: "/{partyId}",
  request: { params: z.object({ companyId: UuidSchema, partyId: UuidSchema }) },
  responses: { 200: { description: "OK", content: { "application/json": { schema: PartySchema } } },
               404: { description: "Unknown", content: { "application/problem+json": { schema: ProblemSchema } } } },
  middleware: [gate()], tags: ["accounting"],
}), async (c) => {
  const { partyId } = c.req.valid("param");
  const rows = await c.var.withTenant((tx) => tx<PartyRow[]>`
    select id, kind, code, name_en, name_ar, receivable_account_id, payable_account_id, currency,
           tax_registration, email, phone, address, archived_at, created_at
      from app.party where id = ${partyId}`);
  if (rows.length === 0) throw new AppError("ERR_NOT_FOUND", `no party ${partyId}`);
  return c.json(toDto(rows[0]!), 200);
});

partyRoutes.openapi(createRoute({
  method: "patch", path: "/{partyId}",
  request: { params: z.object({ companyId: UuidSchema, partyId: UuidSchema }), headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: UpdatePartyBody } } } },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: PartySchema } } },
               404: { description: "Unknown", content: { "application/problem+json": { schema: ProblemSchema } } } },
  middleware: [gate()], tags: ["accounting"],
}), async (c) => {
  const { partyId } = c.req.valid("param");
  const b = c.req.valid("json");
  const rows = await c.var.withTenant((tx) => tx<PartyRow[]>`
    update app.party
       set name_en = coalesce(${b.nameEn ?? null}, name_en),
           name_ar = coalesce(${b.nameAr ?? null}, name_ar),
           receivable_account_id = coalesce(${b.receivableAccountId ?? null}, receivable_account_id),
           payable_account_id = coalesce(${b.payableAccountId ?? null}, payable_account_id),
           currency = coalesce(${b.currency ?? null}, currency),
           tax_registration = coalesce(${b.taxRegistration ?? null}, tax_registration),
           email = coalesce(${b.email ?? null}, email),
           phone = coalesce(${b.phone ?? null}, phone),
           address = coalesce(${b.address ? JSON.stringify(b.address) : null}::jsonb, address)
     where id = ${partyId} and archived_at is null
     returning id, kind, code, name_en, name_ar, receivable_account_id, payable_account_id, currency,
               tax_registration, email, phone, address, archived_at, created_at`);
  if (rows.length === 0) throw new AppError("ERR_NOT_FOUND", `no unarchived party ${partyId}`);
  return c.json(toDto(rows[0]!), 200);
});

/** Archive, never delete (spec:2049). There is deliberately no DELETE route and no DELETE grant:
 *  contracts §3.5.4 pins the grant list and 2B is the only slice that extends it. */
partyRoutes.openapi(createRoute({
  method: "post", path: "/{partyId}/archive",
  request: { params: z.object({ companyId: UuidSchema, partyId: UuidSchema }), headers: IdempotencyHeader,
             body: { content: { "application/json": { schema: z.object({}).strict() } } } },
  responses: { 200: { description: "Archived", content: { "application/json": { schema: PartySchema } } },
               404: { description: "Unknown", content: { "application/problem+json": { schema: ProblemSchema } } } },
  middleware: [gate()], tags: ["accounting"],
}), async (c) => {
  const { partyId } = c.req.valid("param");
  const rows = await c.var.withTenant((tx) => tx<PartyRow[]>`
    update app.party set archived_at = now() where id = ${partyId} and archived_at is null
     returning id, kind, code, name_en, name_ar, receivable_account_id, payable_account_id, currency,
               tax_registration, email, phone, address, archived_at, created_at`);
  if (rows.length === 0) throw new AppError("ERR_NOT_FOUND", `no unarchived party ${partyId}`);
  return c.json(toDto(rows[0]!), 200);
});
```

Register inside `buildRoutes` and add the probe:

```ts
    { path: "/v1/companies/:companyId/parties", router: partyRoutes, permissions: [PERMISSION["accounting.party.manage"]], auth: "human" },
```

Add `seedParty` to `tests/invariants/probes.ts`'s existing `@dulja/db/test` import — the entry below is the first probe in that file to seed through a fixture helper (Task 10's needs none), so the name is not yet imported there:

```ts
  "/v1/companies/:companyId/parties": {
    seed: async (db, owner) => {
      const partyId = await seedParty(db, owner, { code: "PROBE" });
      return { path: `/v1/companies/${owner.company}/parties/${partyId}`, method: "GET" };
    },
    expect: 404,                                       // RLS hides the row; the handler answers ERR_NOT_FOUND
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test -- test/routes/accounting/parties.test.ts`
Expected: **PASS** (9 cases). If the paging case returns the same first item, the keyset predicate is comparing `code` alone rather than the row constructor `(code, id)`.

Run: `bun run --cwd apps/api test && bun run --cwd tests test && bun run typecheck && bun run lint`
Expected: PASS.

Run: `bun run lint:rules`
Expected: **zero violations** — this is the task that closes the window Task 4 opened.

Regenerate and commit the OpenAPI document: `bun run --cwd packages/contracts openapi:generate`.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/contracts tests
git commit -m "$(cat <<'EOF'
feat(api): the party API under accounting.party.manage [2A T11]

Create, read, list with keyset paging on (code, id), patch and archive. No DELETE
route and no DELETE grant: master data is archived (spec:2049) and contracts
§3.5.4 pins the grant list to 2B. `code` and `kind` are not editable — a party's
identity and discriminator do not change under an edit. This closes the
permission-catalogue window Task 4 opened: lint:rules is back to zero.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: §3.0.4 row spec:1066: BRANCH is mandatory, and the engine proves it

The one coverage row this slice **owns**: "BRANCH dimension **mandatory** on every revenue, COGS and staff-cost ledger line (a posting-policy `requires`), so branch P&L has no unallocated lines" (spec:1066), proven by test 28 in 8B. 2A owns the **mechanism** — the `dimensions.required` refusal — and 8B re-runs it on PAYROLL.

The mechanism, restated so it can be checked: `document.branch_id` is NOT NULL (spec:1759), and by default `dimensions.from` is `["line.dimensions", "document.branch"]`, so every planned line carries BRANCH and `required: ["BRANCH"]` is satisfied. A policy line rule that **declares** `dimensions: { "from": ["line.dimensions"] }` opts out, and the `required` check then refuses at evaluation, before any row is written. That is what makes `required` a rule rather than a comment, and it is exactly how a mis-authored policy for a revenue or staff-cost line gets caught.

This task proves it three ways — in the pure evaluator (Task 6 already did, and this re-asserts through the real posting path), through `postDocument` called directly as `app_rw`, and through the API — so a handler that forgot the check cannot hide the defect.

**Files:**
- Create: `packages/db/test/posting/branch-required.test.ts`, `apps/api/test/routes/accounting/documents.branch.test.ts`

**Interfaces:**
- Produces: no source; this task is the row's proof.
- Consumes: `postDocument`, `PostingError` (1A, Task 7); `seedDocumentType`, `seedTenantV2`, `seedBranch` (Task 6; 1A; 0D); `startApi`, `grantAdmin`, `problemOf` (0B).

- [ ] **Step 1: Write `packages/db/test/posting/branch-required.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import { seedDocumentType, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, type Db } from "../harness";
import { withTenant } from "../../src/with-tenant";

/** contracts §6.2 row spec:1066 — owned by 2A. 8B re-runs the same refusal on PAYROLL (test 28). */
describe("BRANCH is mandatory on a policy that requires it — spec:1066, F-9", () => {
  let db: Db; let a: Seed;

  const withBranchSource = (from: string[]) => ({
    version: 1, documentType: "POLICY_TEST", direction: "internal", requires: [],
    lines: [
      { for: "each_line", side: "debit",  account: { code: "1000" }, amount: "line.amount", dimensions: { from } },
      { for: "each_line", side: "credit", account: { code: "4000" }, amount: "line.amount", dimensions: { from } },
    ],
    inventory: { effect: "none" }, tax: { applies: false },
    numbering: { series: "PT", assignAt: "issue" },
    reversal: { allowed: true, producesType: "POLICY_TEST" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    dimensions: { required: ["BRANCH"] },
  });

  const draftAndPost = async (typeId: string, effectiveDate: string): Promise<string> => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) };
    return withTenant(db.rw, ctx, async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                          effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId}, 'PT', ${a.period}, ${effectiveDate}::date, 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (id, tenant_id, company_id, document_id, line_no, kind, amount)
               values (${await uuidv7(db.admin)}, ${a.tenant}, ${a.company}, ${id}, 1, 'item', '25.0000')`;
      await postDocument(tx, ctx, { documentId: id });
      return id;
    });
  };

  beforeAll(async () => {
    db = await startDb(); a = await seedTenantV2(db, "Alpha");
    // v1 takes the header's branch; v2, effective later, opts out of it. Both live on one type, which also
    // exercises resolvePolicy's "greatest effective_from <= effective_date" (contracts §4.3.1).
    await seedDocumentType(db, a, { code: "POLICY_TEST", policyVersion: 1, effectiveFrom: "2026-01-01",
                                    policy: withBranchSource(["line.dimensions", "document.branch"]) });
    await seedDocumentType(db, a, { code: "POLICY_TEST", policyVersion: 2, effectiveFrom: "2026-01-20",
                                    policy: withBranchSource(["line.dimensions"]) });
  });
  afterAll(async () => { await db.stop(); });

  it("posts when the policy's dimension sources include document.branch", async () => {
    const [type] = await withTenant(db.rw, { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ id: string }[]>`select id from app.document_type where company_id = ${a.company} and code = 'POLICY_TEST'`);
    const doc = await draftAndPost(type!.id, "2026-01-15");
    const rows = await withTenant(db.rw, { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) },
      // app.ledger_entry_dimension is (tenant_id, entry_id, dimension_type_id, dimension_value_id) with
      // primary key (entry_id, dimension_type_id) — plan0A:2041-2046. The join column is `entry_id`; there
      // is no `ledger_entry_id`, and naming one would fail with `column d.ledger_entry_id does not exist`
      // rather than with a wrong answer.
      (tx) => tx<{ dimension_value_id: string }[]>`
        select d.dimension_value_id from app.ledger_entry_dimension d
          join app.ledger_entry l on l.id = d.entry_id
         where l.document_id = ${doc}`);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.dimension_value_id === a.hq)).toBe(true);
  });

  it("refuses, before any ledger row is written, when a rule opts out of document.branch", async () => {
    const [type] = await withTenant(db.rw, { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ id: string }[]>`select id from app.document_type where company_id = ${a.company} and code = 'POLICY_TEST'`);
    await expect(draftAndPost(type!.id, "2026-01-25")).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING.*BRANCH/s);
    const [count] = await withTenant(db.rw, { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.ledger_entry
                                   where fiscal_period_id = ${a.period} and effective_date = '2026-01-25'`);
    expect(count!.n).toBe(0);
  });

  it("the refusal names the dimension and the document type, so an operator can fix the policy", async () => {
    const [type] = await withTenant(db.rw, { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ id: string }[]>`select id from app.document_type where company_id = ${a.company} and code = 'POLICY_TEST'`);
    await expect(draftAndPost(type!.id, "2026-01-25"))
      .rejects.toThrow(/dimension BRANCH is required by POLICY_TEST and planned line 1 carries none/);
  });
});
```

- [ ] **Step 2: Write `apps/api/test/routes/accounting/documents.branch.test.ts`**

The same refusal through the HTTP path, so the row is closed "through any endpoint" and not only in the library.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDocumentType, seedTenantV2, type Seed } from "@dulja/db/test";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("spec:1066 through the API — a policy that requires BRANCH refuses a line without it", () => {
  let api: StartedApi; let a: Seed;

  beforeAll(async () => {
    api = await startApi(); a = await seedTenantV2(api.db, "Alpha"); await grantAdmin(api, a);
    await seedDocumentType(api.db, a, {
      code: "POLICY_TEST",
      policy: {
        version: 1, documentType: "POLICY_TEST", direction: "internal", requires: [],
        lines: [
          { for: "each_line", side: "debit",  account: { code: "1000" }, amount: "line.debit",  dimensions: { from: ["line.dimensions"] } },
          { for: "each_line", side: "credit", account: { code: "4000" }, amount: "line.credit", dimensions: { from: ["line.dimensions"] } },
        ],
        inventory: { effect: "none" }, tax: { applies: false },
        numbering: { series: "PT", assignAt: "issue" },
        reversal: { allowed: true, producesType: "POLICY_TEST" },
        approval: { required: false, approve: null, post: "accounting.journal.post" },
        fxRoundingAccount: { from: "company.fx_rounding_account_id" },
        dimensions: { required: ["BRANCH"] },
      },
    });
  });
  afterAll(async () => { await api.stop(); });

  it("the post is 422 ERR_POLICY_REQUIRES_MISSING and the document stays unposted", async () => {
    const created = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: a.human,
      body: { documentTypeCode: "POLICY_TEST", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
              lines: [{ lineNo: 1, kind: "account", accountId: a.cash, debit: "9.0000" },
                      { lineNo: 2, kind: "account", accountId: a.sales, credit: "9.0000" }] },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const res = await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: a.human, body: { to: "posted" } });
    const problem = await problemOf(res);
    expect(problem.status).toBe(422);
    expect(problem.code).toBe("ERR_POLICY_REQUIRES_MISSING");
    expect(problem.detail).toMatch(/BRANCH/);
    const read = await api.request({ method: "GET", path: `/v1/companies/${a.company}/documents/${id}`, as: a.human });
    expect(((await read.json()) as { status: string }).status).toBe("draft");
  });
});
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/posting/branch-required.test.ts`
Expected: **PASS** (3). Write them, run them, and if the first case passes *before* the second is written, add the second first — the refusal is the assertion that matters.

Run: `bun run --cwd apps/api test -- test/routes/accounting/documents.branch.test.ts`
Expected: **PASS** (1). If the transition returns 500, `PolicyEvaluationError` is not reaching `apps/api/src/problem.ts`'s `asAppError` branch — contracts §4.2.4 requires it to translate exactly as `PostingError` and `TenantContextError` do; 1A wired it, so a 500 means the `instanceof` check is against the wrong class.

Run: `bun run --cwd packages/db test && bun run --cwd apps/api test && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/db/test/posting/branch-required.test.ts apps/api/test/routes/accounting/documents.branch.test.ts
git commit -m "$(cat <<'EOF'
test(db): spec:1066 — BRANCH mandatory as a posting-policy requirement [2A T12]

The §3.0.4 row 2A owns. document.branch_id is NOT NULL and dimensions.from
defaults to ["line.dimensions","document.branch"], so BRANCH is on every planned
line by default; a rule that DECLARES a narrower source opts out and
dimensions.required then refuses at evaluation, before any ledger row exists.
That is what makes `required` a rule rather than a comment, and it is the
mechanism test 28 re-runs on PAYROLL in 8B (F-9). Proven through postDocument as
app_rw and through the transitions endpoint.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: The zero-code proof — a document type defined entirely through the API numbers, posts and reverses

This is the task the header points at: the mechanism behind Phase 2's definition of done, "**A new document type is added with zero code**" (spec:2288), demonstrated end to end. Every other task in this plan proves one piece — the schema (T5), the evaluator (T6), the snapshot (T7), the reversal (T8), the gate (T9), the configuration API (T10), the party API (T11). This one strings them together and asserts the sentence.

**What makes this test different from Task 10's.** Task 10 asserts that the two configuration endpoints *behave* — they create, they refuse, they list, they archive. This task never calls `seedDocumentType`, never inserts an `app.document_type` or an `app.posting_policy` row, and touches no seed file: the type and its policy version arrive through `POST /v1/companies/{companyId}/document-types` and `POST …/document-types/{documentTypeId}/policies` as JSON in a request body, and everything afterwards — draft, issue, post, read, reverse — runs against that configuration. If any clause of the sentence needed a line of TypeScript, this test cannot pass.

**What this task does NOT claim.** Test 15 (spec:2433) is **2C's**, and its full sentence is "it numbers, posts, **prints**, **reports** and reverses correctly". Printing needs `app.print_template` and the ADR-0016 engine, and the report clause needs the `accounting.ledger` **report definition** — both 2C's and 1B's respectively. This task proves the three clauses whose mechanism is 2A's (numbers, posts, reverses) and reads the posted rows back through **1A's `/ledger-entries` read endpoint**, which is a query, not a `ReportCode`. 2C's test-15 task adds the print and report clauses on top of exactly this fixture; contracts §6.1 records 2A as a re-runner of test 15 and 2C as its owner.

**Why the type is `CONSIGNMENT_RETURN`.** Hazard 32 forbids inventing a document-type code, and §4.14 already registers this one — slice 2C, module `accounting`, **inbound / inventory `none` / `accounting.journal.post`**, series `CR`, "test 15 fixture; not seeded". Using it here creates no second spelling of anything: 2C still owns the code, its `packages/db/seed/my/document-types/` file and the test. This slice writes it only into a request body, which is the whole point — a code that reaches the database through an HTTP request rather than a seed file is a type added with zero code.

**Why `approval.post` is `accounting.journal.post` and not a new code.** §4.14 fixes it, and F-21 is the reason: `validatePolicy` refuses a policy naming a permission code absent from the catalogue, and `accounting.purchase.post` is 3C's. It also means `DOCUMENT_STAGE_CODES` (Task 9) already holds the only code this type's policy names, so registering this type opens **no** `permission-catalogue` window.

**Files:**
- Create: `apps/api/test/routes/accounting/zero-code.test.ts`

**Interfaces:**
- Produces: no source. This task is the definition of done's proof; it adds no export, no route, no column and no permission code.
- Consumes: `startApi`, `StartedApi` (0B, `apps/api/test/support/app`); `grantAdmin`, `problemOf` (0B, `tests/support/api`); `seedTenantV2` (1A, `@dulja/db/test`); `withTenant` and `reverseDocument` (1A/Task 8, `@dulja/db`); `uuidv7` (§4.1); the routes of Tasks 9, 10 and 11 and 1A's `/documents`, `/documents/{id}/transitions` and `/ledger-entries`.

**The reversal runs through the service, not through HTTP.** Amendment A7: `POST …/documents/{documentId}/reverse` and the `accounting.document.reverse` code are **2B's**, and a route that referenced the code before 2B seeded it would fail the bidirectional `permission-catalogue` check. So this task calls `reverseDocument` directly on `api.db.rw` inside the **production** three-argument `withTenant(sql, ctx, fn)` (contracts §4.2.2; hazard 15) — the same way Task 8 exercises it and the same way 2B's handler will. When 2B lands, its own test-15 re-run replaces this one call with the endpoint; nothing else in this file changes.

- [ ] **Step 1: Write the failing test `apps/api/test/routes/accounting/zero-code.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reverseDocument, withTenant } from "@dulja/db";
import { seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

/**
 * Phase 2 definition of done, first clause (spec:2288): "A new document type is added with zero code."
 *
 * The type and its policy version are created through the two configuration endpoints of Task 10 and nothing
 * else: no seedDocumentType, no INSERT, no seed file, no TypeScript. Everything afterwards runs against that
 * configuration. 2C owns test 15 and adds the print and report clauses on this same fixture (contracts §6.1).
 *
 * CONSIGNMENT_RETURN is §4.14's registered row — accounting / inbound / inventory none /
 * accounting.journal.post / series CR — because hazard 32 forbids inventing a code and because F-21 refuses a
 * policy naming a permission code no slice has shipped.
 */
describe("zero code: a document type created through the API numbers, posts and reverses — spec:2288, spec:2433", () => {
  let api: StartedApi;
  let a: Seed;
  let documentTypeId: string;

  const types = () => `/v1/companies/${a.company}/document-types`;
  const docs = () => `/v1/companies/${a.company}/documents`;

  /** §4.14's CONSIGNMENT_RETURN, as JSON in a request body. Not a fixture constant in packages/db — the
   *  point of the test is that this object never enters the repository as code. */
  const POLICY = {
    version: 1,
    documentType: "CONSIGNMENT_RETURN",
    direction: "inbound",
    requires: [],
    lines: [
      { for: "each_line", side: "debit",  account: { from: "line.account" }, amount: "line.debit",  when: { "line.kind": "account" } },
      { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
    ],
    inventory: { effect: "none" },
    tax: { applies: false },
    numbering: { series: "CR", assignAt: "issue" },
    reversal: { allowed: true, producesType: "CONSIGNMENT_RETURN" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  };

  const draft = async (over: Record<string, unknown> = {}): Promise<string> => {
    const res = await api.request({
      method: "POST", path: docs(), as: a.human,
      body: {
        documentTypeCode: "CONSIGNMENT_RETURN", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
        lines: [
          { lineNo: 1, kind: "account", accountId: a.cash,  debit: "42.0000" },
          { lineNo: 2, kind: "account", accountId: a.sales, credit: "42.0000" },
        ],
        ...over,
      },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  const transition = (id: string, to: string) => api.request({
    method: "POST", path: `${docs()}/${id}/transitions`, as: a.human, body: { to },
  });

  const read = async (id: string) => (await (await api.request({ method: "GET", path: `${docs()}/${id}`, as: a.human })).json()) as {
    id: string; documentTypeCode: string; status: string; series: string; number: string | null;
    reversesDocumentId: string | null;
    lines: { lineNo: number; debit: string; credit: string; accountId: string | null }[];
  };

  /** 1A's `DocumentSchema` deliberately does not expose `postingPolicyId` — it is an internal pin, not a
   *  client concern — so the two assertions that need it read the column, as `app_rw`, through the production
   *  three-argument `withTenant`. Adding the field to the wire schema would be a §4.2.8 amendment this slice
   *  has no reason to make. */
  const pinnedPolicyOf = async (id: string): Promise<string | null> => {
    const rows = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "zc-pin" }, (tx) =>
      tx<{ posting_policy_id: string | null }[]>`select posting_policy_id::text as posting_policy_id from app.document where id = ${id}`);
    return rows[0]!.posting_policy_id;
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "ZeroCode");
    await grantAdmin(api, a);

    // ─── The whole of "adding a document type": two HTTP calls. ───────────────
    const created = await api.request({
      method: "POST", path: types(), as: a.human,
      body: { code: "CONSIGNMENT_RETURN", nameEn: "Consignment return", nameAr: "مرتجع أمانة", module: "accounting" },
    });
    expect(created.status).toBe(201);
    documentTypeId = ((await created.json()) as { id: string }).id;

    const versioned = await api.request({
      method: "POST", path: `${types()}/${documentTypeId}/policies`, as: a.human,
      body: { version: 1, effectiveFrom: "2026-01-01", definition: POLICY },
    });
    expect(versioned.status).toBe(201);
  });

  afterAll(async () => { await api.stop(); });

  it("the type and its policy exist, and no seed file or fixture put them there", async () => {
    // The seed pack has no CONSIGNMENT_RETURN file (§4.14: "not seeded"), and this test called no fixture.
    const rows = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "zero-code" }, (tx) =>
      tx<{ code: string; module: string; versions: number }[]>`
        select t.code, t.module, count(p.id)::int as versions
          from app.document_type t left join app.posting_policy p on p.document_type_id = t.id
         where t.company_id = ${a.company} and t.code = 'CONSIGNMENT_RETURN'
         group by t.code, t.module`);
    expect(rows).toEqual([{ code: "CONSIGNMENT_RETURN", module: "accounting", versions: 1 }]);
  });

  it("NUMBERS: the first issued document of the new type is CR 1 and the second is CR 2", async () => {
    const first = await draft();
    expect((await read(first)).number).toBeNull();                 // assignAt: "issue" — a draft has no number
    expect((await transition(first, "issued")).status).toBe(200);
    const firstIssued = await read(first);
    expect(firstIssued.series).toBe("CR");
    expect(firstIssued.number).toBe("1");
    expect(firstIssued.status).toBe("issued");

    const second = await draft();
    await transition(second, "issued");
    expect((await read(second)).number).toBe("2");
  });

  it("POSTS: the issued document posts through the same posting service and pins the policy it used", async () => {
    const id = await draft();
    await transition(id, "issued");
    expect((await transition(id, "posted")).status).toBe(200);

    const posted = await read(id);
    expect(posted.status).toBe("posted");
    expect(await pinnedPolicyOf(id)).not.toBeNull();                // SAH-013: the rule is pinned on the row

    // 1A's `LedgerEntryQuery` is flat — `documentId`, `accountId`, `fiscalPeriodId`, `from`, `to` — not the
    // `filter[x][eq]` form this slice's own two configuration routes use. Consume it as 1A shipped it.
    const entries = await api.request({
      method: "GET", path: `/v1/companies/${a.company}/ledger-entries?documentId=${id}`, as: a.human,
    });
    const { items } = (await entries.json()) as { items: { accountId: string; debit: string; credit: string; baseDebit: string; baseCredit: string }[] };
    expect(items).toHaveLength(2);
    expect(items.filter((e) => e.accountId === a.cash).map((e) => e.debit)).toEqual(["42.0000"]);
    expect(items.filter((e) => e.accountId === a.sales).map((e) => e.credit)).toEqual(["42.0000"]);
    // Base amounts are value × rate at scale 4 even at rate 1 (spec:1816) — the same path a JOURNAL takes.
    expect(items.map((e) => e.baseDebit)).toEqual(expect.arrayContaining(["42.0000", "0.0000"]));
  });

  it("POSTS: BRANCH lands on every ledger line of the new type without the policy mentioning it (spec:1066)", async () => {
    const id = await draft();
    await transition(id, "issued");
    await transition(id, "posted");
    const rows = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "zero-code-branch" }, (tx) =>
      tx<{ code: string; dimension_value_id: string }[]>`
        select dt.code, d.dimension_value_id
          from app.ledger_entry_dimension d
          join app.ledger_entry l on l.id = d.entry_id
          join app.dimension_value dv on dv.id = d.dimension_value_id
          join app.dimension_type dt on dt.id = dv.dimension_type_id
         where l.document_id = ${id}`);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.code === "BRANCH" && r.dimension_value_id === a.hq)).toBe(true);
  });

  it("REVERSES: reverseDocument produces a CONSIGNMENT_RETURN with the sides swapped and the original becomes reversed", async () => {
    const id = await draft();
    await transition(id, "issued");
    await transition(id, "posted");

    // Amendment A7: no HTTP reversal route ships at 2A. The service call is what 2B's handler will wrap.
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(api.db.admin) };
    const { reversalDocumentId, number } = await withTenant(api.db.rw, ctx, (tx) =>
      reverseDocument(tx, ctx, { documentId: id, effectiveDate: "2026-01-20", reason: "goods returned to consignor" }));
    expect(number).toBeGreaterThan(0n);

    const original = await read(id);
    expect(original.status).toBe("reversed");

    const reversal = await read(reversalDocumentId);
    expect(reversal.documentTypeCode).toBe("CONSIGNMENT_RETURN");   // policy.reversal.producesType, from the body
    expect(reversal.status).toBe("posted");
    expect(reversal.reversesDocumentId).toBe(id);
    expect(reversal.series).toBe("CR");

    // The mirror: line 1 was a 42.0000 debit and is now a 42.0000 credit, on the same account.
    const byLine = new Map(reversal.lines.map((l) => [l.lineNo, l]));
    expect(byLine.get(1)).toMatchObject({ accountId: a.cash,  debit: "0.0000", credit: "42.0000" });
    expect(byLine.get(2)).toMatchObject({ accountId: a.sales, debit: "42.0000", credit: "0.0000" });
  });

  it("REVERSES: after the reversal every account nets to zero across the two documents, and no row was removed", async () => {
    const id = await draft();
    await transition(id, "issued");
    await transition(id, "posted");
    const before = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "zc-count-1" }, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.ledger_entry where company_id = ${a.company}`);

    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(api.db.admin) };
    const { reversalDocumentId } = await withTenant(api.db.rw, ctx, (tx) =>
      reverseDocument(tx, ctx, { documentId: id, effectiveDate: "2026-01-20", reason: "net to zero" }));

    const nets = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "zc-net" }, (tx) =>
      tx<{ account_id: string; net: string }[]>`
        select account_id, (sum(debit) - sum(credit))::text as net
          from app.ledger_entry
         where document_id in (${id}, ${reversalDocumentId})
         group by account_id order by account_id`);
    expect(nets).toHaveLength(2);
    expect(nets.every((r) => Number(r.net) === 0)).toBe(true);

    // A reversal ADDS rows; it never subtracts (contracts §4.3.3 — account_balance stays a pure sum).
    const after = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "zc-count-2" }, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.ledger_entry where company_id = ${a.company}`);
    expect(after[0]!.n).toBe(before[0]!.n + 2);
  });

  it("a policy version added later takes effect from its own effective_from and never re-interprets history", async () => {
    // The zero-code claim includes CHANGING a type without code. Version 2 sends both legs to `1000` from
    // 2026-01-20; the 2026-01-15 documents above keep the rows version 1 produced, because the effective
    // policy is chosen by the document's effective_date and pinned at post (spec:1075, SAH-013).
    //
    // Both dates sit inside 2026-01, which is the ONLY open period `seedTenant` creates — §4.1 pins the three
    // as "2026-01 open, 2026-02 closed, 2026-03 locked". A February document would be refused at §4.3.2
    // step 5 with ERR_PERIOD_NOT_OPEN and this case would prove nothing about version 2.
    const v2 = await api.request({
      method: "POST", path: `${types()}/${documentTypeId}/policies`, as: a.human,
      body: {
        version: 2, effectiveFrom: "2026-01-20",
        definition: { ...POLICY, lines: [
          { for: "each_line", side: "debit",  account: { code: "1000" }, amount: "line.debit",  when: { "line.kind": "account" } },
          { for: "each_line", side: "credit", account: { code: "1000" }, amount: "line.credit", when: { "line.kind": "account" } },
        ] },
      },
    });
    expect(v2.status).toBe(201);

    const late = await draft({ effectiveDate: "2026-01-25" });
    // Both transitions are asserted. Without this, a refusal leaves `lateRows` empty and `[].every(…)` is
    // `true` — the case would go green while posting nothing, which is exactly how a period or policy error
    // hides here.
    expect((await transition(late, "issued")).status).toBe(200);
    expect((await transition(late, "posted")).status).toBe(200);

    const lateRows = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "zc-v2" }, (tx) =>
      tx<{ account_id: string }[]>`select account_id from app.ledger_entry where document_id = ${late}`);
    expect(lateRows).toHaveLength(2);                                  // non-empty before the `every` below
    expect(lateRows.every((r) => r.account_id === a.cash)).toBe(true); // `1000` is seedTenant's cash account

    const latePin = await pinnedPolicyOf(late);
    const earlyPin = await pinnedPolicyOf(await firstEarlyJanuaryPosted());
    expect(latePin).not.toBeNull();
    expect(earlyPin).not.toBeNull();
    expect(latePin).not.toBe(earlyPin);
  });

  /** The id of a document this file posted BEFORE version 2's effective_from — used only to compare pinned
   *  policy ids. The bound is 2026-01-20 because that is where version 2 begins; every draft above this case
   *  uses 2026-01-15. */
  async function firstEarlyJanuaryPosted(): Promise<string> {
    const rows = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "zc-jan" }, (tx) =>
      tx<{ id: string }[]>`
        select d.id from app.document d
          join app.document_type t on t.id = d.document_type_id
         where t.code = 'CONSIGNMENT_RETURN' and d.status in ('posted', 'reversed')
           and d.effective_date < '2026-01-20' order by d.effective_date, d.id limit 1`);
    return rows[0]!.id;
  }

  it("a second tenant's own admin lists their own types and CONSIGNMENT_RETURN is not among them (test 12)", async () => {
    // The point is RLS, not RBAC. B's admin is fully authorised **in B**, so `requirePermission` passes and the
    // query actually runs — and the row created in A is still invisible, because `tenant_isolation` is a
    // FORCED policy on `app.document_type` (spec:106). A test that asserted 403 on a foreign path would only
    // re-prove membership, which is exactly what the two `PROBES` entries of T10 and T11 already do
    // (§3.7.2) — and it would pass whether or not RLS worked at all.
    const b = await seedTenantV2(api.db, "ZeroCodeBeta");
    await grantAdmin(api, b);

    const own = await api.request({ method: "GET", path: `/v1/companies/${b.company}/document-types`, as: b.human });
    expect(own.status).toBe(200);
    const codes = ((await own.json()) as { items: { code: string }[] }).items.map((i) => i.code);
    expect(codes).toContain("JOURNAL");                             // seedTenantV2 gives every tenant one
    expect(codes).not.toContain("CONSIGNMENT_RETURN");              // A's type, invisible to B

    // And B's admin cannot reach it by naming A's company: membership is checked before RLS is consulted, so
    // the refusal is ERR_RBAC_FORBIDDEN rather than an empty list — an invisible company never 404s into a
    // "does this exist?" oracle.
    const cross = await api.request({ method: "GET", path: `${types()}?filter[code][eq]=CONSIGNMENT_RETURN`, as: b.human });
    expect((await problemOf(cross)).code).toBe("ERR_RBAC_FORBIDDEN");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun run --cwd apps/api test -- test/routes/accounting/zero-code.test.ts`
Expected: **PASS** (8 cases). This task writes no implementation, so unlike every other task in this plan the test is expected to pass on its first run — Tasks 9, 10 and 11 built everything it exercises. A failure here is a real defect in one of them, and the failure names which:

| Failure | The task that owns it |
|---|---|
| `POST …/document-types` 404 | Task 10 — the route module is not registered inside `buildRoutes` |
| `POST …/documents` 403 with `accounting.journal.create` in the detail | Task 9 — the create gate is still the static literal, not `codeFor("create", policy)` |
| `POST …/documents` 422 `documentTypeCode must be JOURNAL` | Task 9 step 3 item 3 — the `JOURNAL` guard was not deleted |
| the number is `null` after `to: "issued"` | 1A's `issueDocument` — `numbering.assignAt` is not being read from the widened policy |
| BRANCH missing from `ledger_entry_dimension` | Task 6 — `dimensions.from`'s `document.branch` default was not applied |
| `reverseDocument` raises `ERR_POLICY_REQUIRES_MISSING … CONSIGNMENT_RETURN does not exist` | the API-created type was archived, or the reversal ran in a different company |
| the 2026-01-25 document posts to `4000` | Task 10 — the second version's `effective_from` was stored as the first's, or `resolvePolicy`'s `order by effective_from desc` was changed |
| either transition of the 2026-01-25 document returns 422 `ERR_PERIOD_NOT_OPEN` | the date left 2026-01, which is the only **open** period `seedTenant` creates (§4.1: 2026-01 open, 2026-02 closed, 2026-03 locked) |
| B's list contains `CONSIGNMENT_RETURN` | migration 0001's `tenant_isolation` policy on `app.document_type`, or T10's list handler filtering on `company_id` alone from a session with the wrong `app.tenant_id` — the more serious of the two |

Run: `bun run --cwd apps/api test`
Expected: PASS — the whole route suite, 1A's `documents.test.ts` and Task 9's additions included.

Run: `bun run --cwd tests test`
Expected: PASS — `tests/invariants/tenant-isolation.test.ts` walks `ROUTES` and both new probes (Tasks 10, 11) answer.

Run: `bun run lint && bun run format:check && bun run typecheck && bun run test`
Expected: PASS, all four, at the repository root.

Run: `bun run lint:rules`
Expected: **zero violations.** Task 11 closed the one documented window; this task adds no permission code and no source file.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/routes/accounting/zero-code.test.ts
git commit -m "$(cat <<'EOF'
test(api): a document type added with zero code numbers, posts and reverses [2A T13]

Phase 2's definition of done (spec:2288), at the mechanism level. The type and its
policy version arrive through POST .../document-types and POST .../policies as JSON
in a request body -- no seedDocumentType, no INSERT, no seed file, no TypeScript --
and CR 1 and CR 2 issue, post with BRANCH on every ledger line, and reverse into
CONSIGNMENT_RETURN with the sides swapped and the original marked reversed. A
version 2 effective from 2026-01-20 leaves the earlier January documents' pinned
rows untouched -- 2026-02 is a closed period, so the boundary has to sit inside
the one open month.

CONSIGNMENT_RETURN is §4.14's registered row (2C owns the code, its seed file and
test 15); this slice writes it only into a request body. The print and report
clauses of test 15 are 2C's and are deliberately absent here. Reversal goes through
reverseDocument rather than an endpoint: POST .../reverse and
accounting.document.reverse are 2B's (amendment A7).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: The three regression appends — SAH-013, SAH-072, SAH-078

spec:2059 requires one `tests/regression/sah-NNN.test.ts` per Part I defect touched, and contracts §3.7.3 fixes the ownership rule: **the first slice in execution order creates the file; every later slice appends a `describe("… — <slice id>", …)` block and never edits an earlier one.** All three files this slice touches were created by **0B** — `sah-013` and `sah-072` as *thin* files (0B Task 14), `sah-078` as a *full* one. This slice **creates nothing** and appends exactly three blocks.

**What each block has to prove that 0B's could not.**

| File | 0B's block asserts | 2A's block asserts |
|---|---|---|
| `sah-013` — "Reversal reads *current* document-type flags, not those originally applied" | `ledger_entry.posting_policy_id` is `NOT NULL` and both rows of a posted document carry the seeded policy id — the *column* exists and is filled | that **`reverseDocument` reads the pinned row**: a back-dated policy version inserted after the original posted does not change what the reversal produces (amendment A8) |
| `sah-072` — "Zero CHECK constraints; 544 booleans encoding exclusive states" | `app.account` has one boolean and its five states are an enum; the schema has CHECKs and no float | that this slice's **three** new closed vocabularies are named CHECKs that refuse a sixth label — `party_kind_check`, `document_type_module_check`, `document_line_kind_check` — and that `app.party` and `app.document_line` add **no** boolean at all |
| `sah-078` — "Behaviour-governing configuration lives in opaque blobs" | `permission.code` is text, the catalogue equals the file, `posting_policy.definition` is `jsonb` | that a policy version is **schema-validated JSON that round-trips byte-equal**, is refused with a JSON-Pointer path when it does not validate, and is listable and diffable — the configuration that governs posting arrives as reviewable text, never as a blob |

The `describe` heading text is 0B's, verbatim, with `— 2A` in place of `— 0B`: §3.7.3's rule is that the *defect heading* stays constant across blocks so a reader greps one string and finds every slice that touched it.

**Files:**
- Modify: `tests/regression/sah-013.test.ts`, `tests/regression/sah-072.test.ts`, `tests/regression/sah-078.test.ts`

**Interfaces:**
- Produces: no source. Three `describe` blocks appended to three existing files.
- Consumes: `sharedDb` (0B, `tests/support/regression`); `sharedApi`, `problemOf` (0B, `tests/support/api`); `withTenant`, `postDocument`, `reverseDocument` from `@dulja/db` (production, three-argument — hazard 15); `seedTenantV2`, `seedDocumentType`, `uuidv7` from `@dulja/db/test` (1A, Task 6, §4.1).

**These files run in the `tests` workspace, which uses the production `withTenant(sql, ctx, fn)`.** Hazard 15: the four-argument test helper is `packages/db/test/harness.ts`'s and belongs to `packages/db/test/**` only. `sharedDb()` returns `{ db, rw, a, b }` where `rw` is the production `createDb` pool (§4.17.1) — pass `rw`, not `db.rw`, and pass a `TenantContext` object, not two ids.

- [ ] **Step 1: Append the `— 2A` block to `tests/regression/sah-013.test.ts`**

Add to the **end** of the file. Do not touch the `thinRegression("SAH-013", …)` call above it. Add `describe`, `it` and `expect` to the `vitest` import if the file does not already import them (0B's version imports only `thinRegression`, which wraps them internally, so all three are new here), and add the two `@dulja/db` / `@dulja/db/test` imports.

```ts
// tests/regression/sah-013.test.ts — append
import { describe, expect, it } from "vitest";
import { postDocument, reverseDocument, withTenant } from "@dulja/db";
import { seedDocumentType, seedTenantV2, uuidv7 } from "@dulja/db/test";
import { sharedDb } from "../support/regression";

describe("SAH-013 Reversal reads *current* document-type flags instead of what was originally applied — 2A", () => {
  const POLICY = {
    version: 1, documentType: "POLICY_TEST", direction: "internal", requires: [],
    lines: [
      { for: "each_line", side: "debit",  account: { from: "line.account" }, amount: "line.debit",  when: { "line.kind": "account" } },
      { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
    ],
    inventory: { effect: "none" }, tax: { applies: false },
    numbering: { series: "PT", assignAt: "issue" },
    reversal: { allowed: true, producesType: "POLICY_TEST" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  };

  it("a policy version back-dated after the post does not change what the reversal produces", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH013-2A");
    const typeId = await seedDocumentType(db, s, { code: "POLICY_TEST", policy: POLICY, effectiveFrom: "2026-01-01" });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah013-2a" };

    const doc = await withTenant(rw, ctx, async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${id}, ${s.tenant}, ${s.company}, ${typeId}, 'PT', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, debit)
               values (${s.tenant}, ${s.company}, ${id}, 1, 'account', ${s.cash}, 13.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, credit)
               values (${s.tenant}, ${s.company}, ${id}, 2, 'account', ${s.sales}, 13.0000)`;
      await postDocument(tx, ctx, { documentId: id });
      return id;
    });

    // The legacy defect, reproduced exactly: the governing rule CHANGES after the document is filed. 2A's
    // POST .../document-types/{id}/policies makes this an ordinary administrative act, and `effective_from`
    // 2026-01-10 is on or before the document's own 2026-01-15, so resolvePolicy by date now answers v2 —
    // whose `reversal.allowed` is false. If reverseDocument read the current answer, this call would refuse.
    await seedDocumentType(db, s, {
      code: "POLICY_TEST", policyVersion: 2, effectiveFrom: "2026-01-10",
      policy: { ...POLICY, reversal: { allowed: false, producesType: null } },
    });

    const { reversalDocumentId } = await withTenant(rw, ctx, (tx) =>
      reverseDocument(tx, ctx, { documentId: doc, effectiveDate: "2026-01-25", reason: "sah-013" }));
    expect(reversalDocumentId).toMatch(/^[0-9a-f-]{8}-[0-9a-f-]{4}-7[0-9a-f-]{3}-[0-9a-f-]{4}-[0-9a-f]{12}$/);

    // And the original's ledger rows still name version 1 — nothing was re-interpreted (spec:1753).
    const rows = await withTenant(rw, ctx, (tx) => tx<{ version: number }[]>`
      select distinct p.version from app.ledger_entry l
        join app.posting_policy p on p.id = l.posting_policy_id
       where l.document_id = ${doc}`);
    expect(rows.map((r) => r.version)).toEqual([1]);
  });

  it("the reversal mirrors every generalised line column, so it reflects what was applied and not a subset", async () => {
    const { db, rw } = await sharedDb();
    const s = await seedTenantV2(db, "SAH013-2Ab");
    const itemPolicy = {
      ...POLICY,
      lines: [
        { for: "each_line", side: "debit",  account: { code: "1000" }, amount: "line.amount", when: { "line.kind": "item" } },
        { for: "each_line", side: "credit", account: { code: "4000" }, amount: "line.amount", when: { "line.kind": "item" } },
      ],
    };
    const typeId = await seedDocumentType(db, s, { code: "POLICY_TEST", policy: itemPolicy });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah013-2ab" };
    const itemId = await uuidv7(db.admin);

    const doc = await withTenant(rw, ctx, async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${id}, ${s.tenant}, ${s.company}, ${typeId}, 'PT', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, item_id,
                                              quantity, unit_price, discount, amount, tax_amount, total_incl_tax)
               values (${s.tenant}, ${s.company}, ${id}, 1, 'item', ${itemId},
                       4.000000, 25.0000, 0.0000, 100.0000, 6.0000, 106.0000)`;
      await postDocument(tx, ctx, { documentId: id });
      return id;
    });

    const { reversalDocumentId } = await withTenant(rw, ctx, (tx) =>
      reverseDocument(tx, ctx, { documentId: doc, effectiveDate: "2026-01-25", reason: "sah-013 mirror" }));

    const [line] = await withTenant(rw, ctx, (tx) => tx<Record<string, string | null>[]>`
      select kind, item_id, quantity::text as quantity, unit_price::text as unit_price,
             amount::text as amount, tax_amount::text as tax_amount, total_incl_tax::text as total_incl_tax,
             cost::text as cost
        from app.document_line where document_id = ${reversalDocumentId}`);
    // The legacy reversal copied a handful of columns and re-read the rest from the current type. This one
    // carries kind and item_id unchanged and NEGATES the signed magnitudes; `cost` is the costing engine's
    // answer for the reversal's own date (3B), never a copy.
    expect(line).toEqual({
      kind: "item", item_id: itemId, quantity: "-4.000000", unit_price: "25.0000",
      amount: "-100.0000", tax_amount: "-6.0000", total_incl_tax: "-106.0000", cost: null,
    });
  });
});
```

- [ ] **Step 2: Append the `— 2A` block to `tests/regression/sah-072.test.ts`**

```ts
// tests/regression/sah-072.test.ts — append
import { describe, expect, it } from "vitest";
import { sharedDb } from "../support/regression";

describe("SAH-072 Zero CHECK constraints across 460 tables, and 544 boolean columns encoding mutually exclusive states — 2A", () => {
  it("every closed vocabulary this slice adds is a NAMED CHECK, and 6A and 8B drop two of them by name", async () => {
    const { db } = await sharedDb();
    const rows = await db.admin<{ conname: string; def: string }[]>`
      select c.conname, pg_get_constraintdef(c.oid) as def
        from pg_constraint c join pg_class t on t.oid = c.conrelid
        join pg_namespace ns on ns.oid = t.relnamespace
       where ns.nspname = 'app' and c.contype = 'c'
         and c.conname in ('party_kind_check', 'document_type_module_check', 'document_line_kind_check')
       order by c.conname`;
    expect(rows.map((r) => r.conname)).toEqual(["document_line_kind_check", "document_type_module_check", "party_kind_check"]);

    // The names are load-bearing, not cosmetic: 6A's 0061 and 8B's 0087 each DROP document_line_kind_check by
    // name and re-add it with the complete label union, and either phase may execute first (spec:2301).
    expect(rows.find((r) => r.conname === "party_kind_check")!.def)
      .toMatch(/customer.*vendor.*employee.*student.*dealer/s);
    expect(rows.find((r) => r.conname === "document_type_module_check")!.def)
      .toMatch(/accounting.*inventory.*hr.*pos/s);
  });

  it("the two tables this slice touches encode their states as a discriminator, and add no boolean at all", async () => {
    const { db } = await sharedDb();
    // `Account` carried twenty Is* flags; spec:1169 splits it into a GL-only Account and a Party whose one
    // `kind` column carries five mutually exclusive values. A party is never "IsCustomer AND IsVendor".
    for (const table of ["party", "document_line"]) {
      const booleans = await db.admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'app' and table_name = ${table} and data_type = 'boolean'`;
      expect(booleans, table).toEqual([]);
    }
    const [kind] = await db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'party' and column_name = 'kind'`;
    expect(kind!.data_type).toBe("text");                          // text + CHECK, never an enum (§3.4.4)
  });

  it("the vocabulary refuses a value outside it, at the database, whatever the caller is", async () => {
    const { db, rw, a } = await sharedDb();
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "sah072-2a" };
    // Not through the API, not through a fixture: straight at app_rw, which is the only proof that matters.
    await expect(withTenantInsert(rw, ctx, a, "supplier")).rejects.toThrow(/party_kind_check/);
  });
});

/** A bare `app.party` insert as app_rw, used only to prove the CHECK refuses an unknown discriminator. */
async function withTenantInsert(
  rw: Parameters<typeof withTenant>[0],
  ctx: Parameters<typeof withTenant>[1],
  a: { tenant: string; company: string },
  kind: string,
): Promise<void> {
  await withTenant(rw, ctx, (tx) => tx`
    insert into app.party (tenant_id, company_id, kind, code, name_en)
    values (${a.tenant}, ${a.company}, ${kind}, ${`SAH072-${kind}`}, 'Bad kind')`);
}
```

Add `import { withTenant } from "@dulja/db";` to the file's imports for the helper above.

- [ ] **Step 3: Append the `— 2A` block to `tests/regression/sah-078.test.ts`**

0B's block is a `fullRegression(...)` call, so this append is a plain `describe` using `sharedApi()` directly (§4.17.1 — the `Seed`s there live in a different database from `sharedDb()`'s).

**Each case seeds its own tenant, and that is not tidiness.** `sharedApi()`'s `Seed`s are shared across every regression file, and `app.document_type` is `unique (company_id, code)` — so a document type created into `a.company` here collides with whichever later slice's regression append creates the same code in the same shared seed, and the failure lands on whichever file happens to run second. `seedTenantV2(api.db, "SAH078-2A")` plus `grantAdmin` costs one tenant and removes the coupling entirely; Task 14's `sah-013` block already works this way. **2C's writer: this block owns no code in `a.company`, so nothing here constrains what you create there.**

```ts
// tests/regression/sah-078.test.ts — append
import { describe, expect, it } from "vitest";
import { seedTenantV2 } from "@dulja/db/test";
import { grantAdmin, problemOf, sharedApi } from "../support/api";

describe("SAH-078 Behaviour-governing configuration lives in opaque blobs — 2A", () => {
  const POLICY = {
    version: 1, documentType: "CONSIGNMENT_RETURN", direction: "inbound", requires: [],
    lines: [
      { for: "each_line", side: "debit",  account: { from: "line.account" }, amount: "line.debit",  when: { "line.kind": "account" } },
      { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
    ],
    inventory: { effect: "none" }, tax: { applies: false },
    numbering: { series: "CR", assignAt: "issue" },
    reversal: { allowed: true, producesType: "CONSIGNMENT_RETURN" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  };

  it("a posting rule is schema-validated JSON that round-trips byte-equal — reviewable text, not a blob", async () => {
    const { api } = await sharedApi();
    const s = await seedTenantV2(api.db, "SAH078-2A");            // own tenant: no shared-seed code collision
    await grantAdmin(api, s);
    const base = `/v1/companies/${s.company}/document-types`;
    const created = await api.request({ method: "POST", path: base, as: s.human,
      body: { code: "CONSIGNMENT_RETURN", nameEn: "Consignment return", module: "accounting" } });
    const { id } = (await created.json()) as { id: string };
    const added = await api.request({ method: "POST", path: `${base}/${id}/policies`, as: s.human,
      body: { version: 1, effectiveFrom: "2026-01-01", definition: POLICY } });
    expect(added.status).toBe(201);

    // Round-trip: what comes back out of jsonb is what went in. A blob cannot make this claim, and neither
    // can a schema whose validator lives in client code — which is the legacy shape this defect names.
    const listed = await api.request({ method: "GET", path: `${base}/${id}/policies`, as: s.human });
    const { items } = (await listed.json()) as { items: { version: number; definition: unknown }[] };
    expect(items).toHaveLength(1);
    expect(items[0]!.definition).toEqual(POLICY);

    // And it is queryable in SQL, which is what "diffable and reasonable-about" means at the data layer.
    const [row] = await api.db.admin<{ document_type: string; series: string }[]>`
      select definition->>'documentType' as document_type, definition->'numbering'->>'series' as series
        from app.posting_policy where document_type_id = ${id} and version = 1`;
    expect(row).toEqual({ document_type: "CONSIGNMENT_RETURN", series: "CR" });
  });

  it("an invalid rule is refused at configuration time, naming the JSON path — not accepted and failed at post", async () => {
    const { api } = await sharedApi();
    const s = await seedTenantV2(api.db, "SAH078-2Ab");           // own tenant again, for the same reason
    await grantAdmin(api, s);
    const base = `/v1/companies/${s.company}/document-types`;
    // POLICY_TEST_2 is §4.14's second test-only code (amendment A1). `COST_ADJUSTMENT` would be wrong twice
    // over: §4.14 assigns it to 3B, and creating it in a shared seed would collide with 3B's own regression.
    const created = await api.request({ method: "POST", path: base, as: s.human,
      body: { code: "POLICY_TEST_2", nameEn: "Policy test 2", module: "accounting" } });
    const { id } = (await created.json()) as { id: string };

    // `inventory: { effect: "issue" }` without `warehouse`/`costing` fails §4.4.1's conditional. The legacy
    // system had nowhere to say this: behaviour lived in a blob and broke at run time, in a trigger branch.
    const res = await api.request({ method: "POST", path: `${base}/${id}/policies`, as: s.human,
      body: { version: 1, effectiveFrom: "2026-01-01",
              definition: { ...POLICY, documentType: "POLICY_TEST_2", inventory: { effect: "issue" } } } });
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_POLICY_INVALID");
    // `errors[]` on an ERR_POLICY_INVALID problem is amendment A10 — §4.2.4's comment reserved the member
    // for ERR_VALIDATION_FAILED, and "naming the JSON path" is this defect's own claim.
    expect(problem.errors!.map((e) => e.path)).toContain("/inventory");

    // Nothing was written: a refused rule leaves no half-configured type behind.
    const listed = await api.request({ method: "GET", path: `${base}/${id}/policies`, as: s.human });
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("the schema itself is a version-controlled file with a stable $id, so a change to it is a reviewed diff", async () => {
    const { api } = await sharedApi();
    // The claim is about the artefact, not the database: the rules that govern posting are a committed JSON
    // Schema (ADR 0022, widened under ADR 0026) plus a committed generated type, both diffable in review.
    const schema = (await import("../../packages/domain/posting-policy.schema.json", { with: { type: "json" } })).default as {
      $id: string; $schema: string; properties: { version: { const: number } }; additionalProperties: boolean;
    };
    expect(schema.$id).toBe("urn:dulja:posting-policy:1");
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.properties.version.const).toBe(1);
    expect(schema.additionalProperties).toBe(false);               // §4.3.7: the envelope's members live outside
    void api;
  });
});
```

- [ ] **Step 4: Run the three files and the whole regression tier**

Run: `bun run --cwd tests test -- regression/sah-013.test.ts regression/sah-072.test.ts regression/sah-078.test.ts`
Expected: **PASS** — 0B's blocks plus this slice's **eight** cases (2 in `sah-013`, 3 in `sah-072`, 3 in `sah-078`). If `sah-013`'s first case fails with `ERR_DOC_STATUS_ILLEGAL: policy for POLICY_TEST does not allow reversal`, Task 8 Step 2b was not applied and `reverseDocument` is still resolving the reversal block by date — that is the defect this block exists to catch, so fix Task 8, not this test.

Run: `bun run --cwd tests test`
Expected: PASS — every invariant and regression file, 0B's forty-odd and 1A's sixteen included.

Run: `bun run lint && bun run format:check && bun run typecheck && bun run test`
Expected: PASS at the repository root.

Note: `tests/` is deliberately outside `scripts/lint/run.ts`'s `ROOTS` (§3.7.5), so the raw `insert into app.document_line` in the `sah-013` block does not trip `posting-only-tables` — and it is not a ledger table in any case. Do **not** add `tests` to `ROOTS`.

- [ ] **Step 5: Commit**

```bash
git add tests/regression/sah-013.test.ts tests/regression/sah-072.test.ts tests/regression/sah-078.test.ts
git commit -m "$(cat <<'EOF'
test(regression): SAH-013, SAH-072 and SAH-078 blocks for 2A [2A T14]

Three appends, no new file: contracts §3.7.3 makes 0B the creator of all three and
a later slice appends a describe block and never edits an earlier one.

013 -- the defect is "reversal reads current flags": a policy version back-dated
after the post no longer changes what the reversal produces, because reverseDocument
reads document.posting_policy_id (amendment A8), and the mirror carries every 0019
column with the signed magnitudes negated.
072 -- the three closed vocabularies this slice adds are NAMED CHECKs that refuse a
sixth label at app_rw; app.party and app.document_line add no boolean at all.
078 -- a posting rule is schema-validated JSON that round-trips byte-equal, is
refused with a JSON-Pointer path at configuration time, and is queryable in SQL;
the schema is a committed file with a stable $id.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: OWNER GATE OD-24 — the party screen this slice does not ship

> **This task is isolated for owner decision OD-24** (contracts §2.12: "Screenshots + operator description before any screen"; spec:79 and spec:108 — "the UI is not specified"; spec:2408). It is the **only** task in this plan that depends on an owner decision, and dropping it changes nothing else: no task before it and no later slice imports anything it produces.
>
> **Owner provides:** screenshots of the legacy Sahlisoft customer/vendor master screen — the list, the entry form and whatever dialog sets the control accounts and credit terms — plus a two-minute description of how a clerk actually uses each (what they type first, what they never touch, which field they tab to twenty times a day).
> **Verify:** `ls docs/ui/od-24-party.md docs/ui/od-24-party-*.png` lists the description and at least one screenshot, and the description is attached to the task of whichever slice ships the screen before that task is executed.
> **Until provided:** nothing in this slice blocks. **2A ships no screen at all** — its File Structure contains no `apps/desktop/**` path, and the Delivers block of the 2A card names none. This task's whole content is to record what 2A froze for a party screen and exactly what changes if the owner's material contradicts it.

**Files:**
- Create: `docs/ui/phase-2a-party-api-surface.md`

**Interfaces:**
- Produces: a one-page record of the API surface a party screen consumes, and the list of things that would have to change if the owner's screenshots show a different workflow. **No code, no test, no export.**
- Consumes: the route modules of Tasks 9, 10 and 11 — read, not imported.

**Why 2A carries an OD-24 row at all, and the gap this task reports.** The 2A card's *Owner gates* cell reads "**OD-24** screenshots (party screen). No other", yet no slice's Delivers block ships a *party master* screen: **4A** ships "AR/AP screens keyboard-first, both directions" and **2C** ships "back-office document list/entry screens". So the gate lands on a screen that is nobody's declared deliverable. 1A hit the same shape — its card named OD-24 while every Phase 1 screen was 1B's — and resolved it the same way: the gate that lands here is **not** "build a screen" but "do not let an unspecified UI leak into the API shapes a screen will need". That risk is real and specific. A handler written with a screen in mind bakes a workflow into a route: a `POST /parties` that took a nested `openingBalance`, or a `GET /parties` that returned the party with its ageing buckets inlined, would make the screen's workflow a property of the API, and spec:79 says the UI is not specified. Recording the surface explicitly means that if the owner's screenshots show a different workflow, the change is in the screen's components and, at most, in a query parameter — never in the posting service or the party table. **The gap itself is an open question for the architect** (see *Self-Review → Open questions*): either 4A's "AR/AP screens" is read as including the party master, or a card's Delivers gains the screen. This plan does not decide it.

- [ ] **Step 1: Write `docs/ui/phase-2a-party-api-surface.md`**

```markdown
# The API surface a party screen consumes (frozen by Phase 2A)

**Status:** the OD-24 material for the party screen has **not** been received (contracts §2.12, OD-24;
spec:2408). No screen ships in 2A. This file records what 2A froze, so that whichever slice ships the
screen — see the open question at the bottom — builds against a surface that already exists, and so that
the diff when the owner's material arrives is a set of components and not a set of routes.

## What exists after Phase 2A

| Capability | Endpoint | Gate | Notes |
|---|---|---|---|
| List parties, filtered and paged | `GET /v1/companies/{companyId}/parties?filter[kind][eq]=&filter[code][eq]=&includeArchived=&limit=&cursor=` | `accounting.party.manage` | keyset paging on `(code, id)`; `includeArchived` defaults to `false` |
| Read one party | `GET /v1/companies/{companyId}/parties/{partyId}` | `accounting.party.manage` | 404 `ERR_NOT_FOUND` when RLS hides it — never 403, so an invisible row cannot be probed |
| Create a party | `POST /v1/companies/{companyId}/parties` | `accounting.party.manage` | `kind` is one of `customer · vendor · employee · student · dealer`; `code` unique per company |
| Edit a party | `PATCH /v1/companies/{companyId}/parties/{partyId}` | `accounting.party.manage` | `code` and `kind` are **not** editable |
| Archive a party | `POST /v1/companies/{companyId}/parties/{partyId}/archive` | `accounting.party.manage` | there is no DELETE route and no DELETE grant (spec:2049) |
| List document types (to offer a type when the screen opens a document) | `GET /v1/companies/{companyId}/document-types` | `admin.company.manage` | archived types are excluded by default |

`accounting.party.manage` is seeded to **`user`** and computed for `admin` (2A Task 4). A read-only role — an
auditor — holds **no** party code, so a party screen shown to `auditor` has no data to show; if the owner's
workflow needs a read-only party view, that needs a **read** code, and the permission vocabulary is closed
(contracts §3.6.1), so it is an amendment to §3.6.1 and not a plan decision.

## What the screen must NOT expect the API to do

- **No opening balance on create.** A party's balance is the sum of its posted documents. A screen that wants
  an opening balance posts a document (4A's `SALES_INVOICE` or a `JOURNAL`); it is never a column on `party`.
- **No ageing on the party read.** `party_ageing` is 4B's projection and `accounting.ageing` is 4B's report
  code. The party read returns master data only.
- **No credit limit or payment term yet.** `party.credit_limit`, `party.payment_term_id` and
  `party.credit_hold` arrive in **4A**'s migration `0045_alter_party_add_credit_control.sql`. A screen built
  before 4A shows five fields fewer; it does not invent them.
- **No party-scoped document list.** `GET /v1/companies/{companyId}/documents` takes no `partyId` filter at
  2A. Adding one is a query parameter on an existing route — the smallest possible change — and it belongs to
  the slice that ships the screen.
- **No nested writes.** One request writes one party. A screen that saves a party and three addresses in one
  round trip needs a request shape that does not exist and would be an amendment to §4.2.8.

## Keyboard parity, which is not negotiable

spec:2254 requires every operation to be reachable from the keyboard, and both text directions (spec:2253,
§4.10). The list is a grid with `code` as the first column because `code` is what a clerk types; the entry
form's tab order follows `kind → code → nameEn → nameAr → receivableAccountId → payableAccountId → currency
→ taxRegistration → email → phone → address`, which is the declaration order of `CreatePartyBody` and of the
`app.party` DDL. If the owner's screenshots show a different order, **the change is the component's tab
index** — no route, no schema, no column moves.

## What changes if the owner's material contradicts this

| If the screenshots show | Change | Where |
|---|---|---|
| a different field order or grouping | tab order and layout | the screen's component only |
| a read-only party view for a non-`user` role | a new **read** permission code | amend contracts §3.6.1, then a one-line `middleware` change |
| a party-scoped document list | one `filter[partyId][eq]` query parameter | `apps/api/src/routes/accounting/documents.ts`, `DocumentQuery` |
| an opening-balance field on the create form | a document, not a column | the screen calls `POST …/documents` after `POST …/parties` |
| a "merge two parties" action | a new endpoint and an ADR proposal (it rewrites posted history's references) | not in v1 without an ADR — spec:95 |
| fields that are 4A's (`credit_limit`, terms, hold) | nothing here | 4A's migration `0045` and its own screen task |

## Open question this file does not answer

**Which slice ships the party master screen?** The 2A card's *Owner gates* cell says "OD-24 screenshots
(party screen)", but 2A's Delivers block ships no screen; 4A ships "AR/AP screens" and 2C ships "document
list/entry screens". Either 4A's cell is read as including the party master — in which case the OD-24 row
belongs on 4A's card and 2A's cell should say "records the surface; ships no screen" — or a card's Delivers
gains the screen explicitly. The architect decides; this file exists so that whichever way it goes, the
surface is already frozen.
```

- [ ] **Step 2: Verify the gate, and record that it is pending**

Run:
```bash
ls docs/ui/od-24-party.md docs/ui/od-24-party-*.png
```
Expected **today**: `ls: cannot access 'docs/ui/od-24-party.md': No such file or directory` — the gate is **pending**, and that is the recorded state, not a failure. Nothing in this slice blocks on it: no test, no route and no migration references any of those paths.

**The local equivalent** (contracts §5 item 5): the surface this file freezes is verified against the running system rather than against the owner's material, with the API this slice already ships —

```bash
bun run --cwd apps/api test -- test/routes/accounting/parties.test.ts test/routes/admin/document-types.test.ts
```
Expected: **PASS** — every row of the *What exists* table above is one case in those two files (Tasks 10 and 11), so the document cannot drift from the API without a red test.

**When the owner's material arrives**, the person executing the screen task: puts the screenshots at `docs/ui/od-24-party-*.png` and the two-minute description under an `## Operator description` heading in `docs/ui/od-24-party.md`, then walks the *What changes* table above and opens one PR per row that applies. No row in that table touches `packages/db` or `packages/domain`.

- [ ] **Step 3: Commit**

```bash
git add docs/ui/phase-2a-party-api-surface.md
git commit -m "$(cat <<'EOF'
docs(ui): the API surface a party screen consumes; OD-24 pending [2A T15]

OD-24 (contracts §2.12; spec:79, 108, 2408) gates every screen on the owner's
screenshots and a two-minute operator description. 2A ships NO screen -- its card's
Delivers names none -- so the gate that lands here is "do not let an unspecified UI
leak into the API shapes a screen will need", the same shape 1A resolved with
docs/ui/phase-1-api-surface.md.

The file freezes six endpoints, five things a screen must NOT expect the API to do
(no opening balance, no ageing on the read, no 4A credit-control fields, no
party-scoped document filter, no nested writes), the keyboard tab order, and a table
of what changes if the screenshots contradict it -- no row of which touches
packages/db or packages/domain.

It also records the gap the architect must close: no card's Delivers ships a party
master screen, so the OD-24 row on the 2A card names a screen nobody owns.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

### Against the contracts card for 2A (§2.3)

| Card deliverable | Task | Note |
|---|---|---|
| **ADR 0026** — the proposal spec:2006 demands — widening `packages/domain/posting-policy.schema.json` from 1A's JOURNAL subset to §4.4.1 in full, "same file, same `$id`, same `"version": { "const": 1 }`", adding enum labels and optional properties only | T5 | written as a **proposal** (spec:95 — it is the data model of every posting rule); the regenerated `PostingPolicy` is committed in the same PR, which §4.18 names explicitly |
| the spec example (spec:2008–2028) + per-line dimension tagging + line-level account resolution (`line.component.expense_account`, `line.scheme.payable_account` — spec:2101) + the `when` filter + `dimensions.required` | T5, T6 | the spec example ships as `packages/domain/test/posting/sales-invoice.fixture.json`, asserted valid; the four widenings are the four branches of T6 |
| `evaluatePolicy(policy, snapshot): PostingPlan` — pure, no I/O (§4.4.2) | T6 | thirteen account references, thirteen amount references, three `for` scopes, seven `when` keys, three dimension sources; imports `decimal.js` (behind `Money`) and nothing else. **Plus the sign normalisation of amendment A9** — a negative resolved amount emits the rule's opposite side at `amount.abs()`, in both emit paths, `PlannedTaxLine` exempt — because `app.ledger_entry` carries `check (debit >= 0)`/`check (credit >= 0)` and `side` is therefore the only thing that can carry direction |
| `validatePolicy(definition): PolicyValidation` "used by the seed and by the API when a tenant adds a type" | T5 (widened), T10 (consumed) | the catalogue is a **parameter**, as 1A shipped it — `packages/domain` may not import `@dulja/contracts` (§3.1); the API passes `PERMISSIONS.map(p => p.code)` |
| `app.party` (kinds `customer \| vendor \| employee \| student \| dealer`, receivable/payable links, §4.5.7) | T1 | DDL verbatim; `student`/`dealer` reserved (F-16, §2.11); joins **no** linter set (§3.5.3); no DELETE grant (§3.5.4) |
| the deferred `document.party_id` composite FK (spec:1759) | T2 | `document_party_fk` on `(tenant_id, party_id)`, never a plain FK |
| `document_line` generalised: `kind`, `item_id` (no FK until 3A), `quantity`, `unit_price`, `discount`, `amount`, `tax_code_id` (no FK until 5A), `tax_amount`, `total_incl_tax`, `cost` | T3 | the ten columns of §4.3.4's 2A row, all nullable or defaulted (the expand half, §3.4.7); `document_line_kind_check` **named** because 6A's 0061 and 8B's 0087 both drop it by name |
| `document_type.module`, `archived_at` (§4.3.4) | T2 | in the same file as the FK, which §3.4.3 allows and §3.4.2 requires the name to say; `module` is the §4.5.8 attachment gate and **not** the module segment of `approval.post` (hazard 34) |
| posting service generalised to evaluate any policy; the Phase 1 hand-written path retired | T6, T7 | `evaluatePolicy` is the one path; `loadSnapshot` fills the eleven fields 1A stubbed; `postDocument` fail-closes on an unfilled `cost` until 3B (amendment A5) |
| `requires` enforcement including `dimensions.required` (BRANCH — spec:1066) | T6, T12 | the `dimensions.from` default carries BRANCH onto every planned line; a rule that **declares** a narrower source opts out and `required` then refuses **before any ledger row exists** |
| reversal producing `reversal.producesType` and setting the original to `reversed` (spec:2024, D13) | T8 | the ten new columns carried, signed magnitudes negated, `cost` deliberately not copied; the mirror reaches the ledger through A9's sign normalisation rather than as a negative `debit`, which `ledger_entry_debit_check` would refuse; **and** the `reversal` block now read from the **pinned** policy (amendment A8) |
| Document-type + policy API: create a type and a new policy version from JSON, validated against the schema, `unique (document_type_id, version)`, `effective_from`, under `admin.company.manage` | T10 | append-only (**ADR 0027**, a proposal); `validatePolicy` runs schema **and** the F-21 catalogue check before the insert |
| party API under `accounting.party.manage` | T4 (code), T11 (routes) | create, read, list with keyset paging on `(code, id)`, patch, archive; **no DELETE** |
| "`accounting.document.reverse` handler" | — | **not shipped, deliberately** — §3.6.2 introduces the code in 2B, §4.5.4 puts the route beside 2B's transitions, and 1A shipped no reversal endpoint for the same reason. **Amendment A7** rewrites the card sentence. T8 ships the generalised service; 2B ships the route and the code, together, or the bidirectional catalogue lint fails on whichever half is missing |
| this slice's share of the DoD: the mechanism behind "a new document type is added with zero code" | T5, T6, T7, T10, T11; proved end to end in **T13** | 2C proves the sentence (test 15) with prints and reports on top of T13's fixture |
| Part VI: none owned; re-runs 15, 28's BRANCH mechanism (F-9), 12, 13, 36 | T13 (15), T12 (28's mechanism), T10/T11 probes + `tests/invariants` (12), T1's audit case (13), T4 (36) | |
| §3.0.4 row spec:1066 owned | T12 | proven in the pure evaluator (T6), through `postDocument` as `app_rw`, and through the transitions endpoint |
| Regression: appends to sah-013, sah-072, sah-078; creates none | T14 | three `describe("… — 2A")` blocks; no earlier block edited (§3.7.3) |
| Owner gate OD-24 | T15 | one isolated task; nothing else depends on it; **2A ships no screen** |

Migration range 0017–0020 — four files, the four names the card expects, four PRs. ADR range 0026–0028 — **two** written (0026, 0027 — both proposals), **0028 left unused** per §3.4.1's rule applied to ADR numbers. Target size 13–15 tasks: **15**.

### Against the hazards (§5)

1 **no statutory rate, threshold, ceiling or formula anywhere** — `sales-invoice.fixture.json` (T5) carries `tax: { applies: true, inclusive: "header.tax_inclusive" }` and **no rate at all**; the one numeric tax value in this slice is `rate: "0.06000000"` on the `TaxCodeRef` of T6's in-memory `evaluate.test.ts` snapshot, which is a *test input to a pure function* proving that `tax.amount` reaches the planned line — not a rate table, not a seed file, not a fixture asserted as Malaysian law, and not loaded by anything at run time. Every policy this plan writes into a request body or a test sets `tax: { applies: false }`. The real tables arrive only through OD-23 as `packages/db/seed/my/statutory/<scheme>/vN.json`, and 5A owns `app.tax_code` · 2 **no MyInvois detail** — no LHDN endpoint, field, version or deadline appears · 3 **Firebird untouched** · 4 **no report ships here** — no `ReportCode`, no `DatasetId`, no report definition; T13 reads posted rows through 1A's `/ledger-entries` **query** endpoint and says so, leaving 2C's report clause of test 15 intact · 5 **the one owner-account-shaped task (T15)** states what the owner provides, the exact `ls` that verifies it, and the local equivalent (`bun run --cwd apps/api test -- …parties.test.ts …document-types.test.ts`) · 6 **one OD item, one isolated task** — OD-24 → T15 and nothing else · 7 **no D1–D27 re-opened**; D13 is implemented, not revisited · 8 **every Plan 0A helper cited by its exact name** — `startDb`, `Db`, `Seed`, `seedTenant`, `draftDocument`, `uuidv7`, the 4-argument test `withTenant`, `lintSchema`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor` · 9 **`fixtures.ts` extended additively with exactly the two §4.17 helpers 2A owns** — `seedParty` (T1) and `seedDocumentType` (T6); `Seed`, `seedTenant` and `draftDocument` are untouched, and no third helper is invented · 10 **no per-tenant row written by a migration** — 0020 writes only global `app.permission`; every document type, policy and party in this plan is API or fixture data · 11 **no enum label added** — all three new vocabularies are `text + CHECK` · 12 **0B's generalised reversibility test relied on**, not rewritten; 0017–0020 each walk up and down through it · 13 **`lint-schema.ts` untouched** — `app.party` joins no set (§3.5.3), which is the pre-declared state · 14 **no renumbering, no `max(version)` assertion** · 15 **two `withTenant`s kept apart** — the 4-argument test helper in `packages/db/test/*.test.ts`, the production three-argument one in `packages/db/test/posting/**` (where a real `TenantContext` is required), `apps/api/test/**` and root `tests/**` · 16 not this slice (`employee` is migration 0064) · 17 not this slice · 18 **the fixed projection set respected** — T13 compares per-account nets and row counts, never `posting_policy_id`, which the original and its reversal legitimately differ on · 19 not this slice · 20 no job handler ships here · 21 **no `sql.unsafe`** anywhere in this slice · 22 **nothing outside `packages/db/src/posting/` writes a ledger table** — T13's and T14's raw SQL is `document`/`document_line` only, and both live outside the lint runner's `ROOTS` or inside an allowed prefix · 23 **`toBase` is `HALF_AWAY_FROM_ZERO` at scale 4** and T13 asserts base amounts at that scale · 24 **no `document_event` written** — 2B's triggers own it; T13 asserts status through the document row, never by inserting an event · 25 **no DELETE grant added**; `privileges.test.ts` untouched; `party` and `document_type` are archived with `archived_at` · 26 **one new permission code, and it is in spec:2146's closed vocabulary** — `accounting.party.manage` (§3.6.2); no new module · 27 no principal kind added · 28 not this slice · 29 **the UI is not invented** — T15 records a surface and ships no screen · 30 the PDF engine is not touched · 31 **every new route has a `PROBES` entry** — two routes (T10, T11), two probes · 32 **no literal invented in a shared namespace** — document-type codes: `POLICY_TEST` and `POLICY_TEST_2` (both registered by A1) and `CONSIGNMENT_RETURN` (already registered to 2C, used only in request bodies, recorded in the Assumptions block). **Those three are the only document-type code literals this slice ever writes to a table or a seed file.** Three further literals appear in `documentType`/`documentTypeCode` positions and none of them reaches `app.document_type`: `X1` in T10's module-validation case, refused by Zod before the handler runs; `NOT_A_TYPE` in T9's 404 case, which passes Zod's `^[A-Z][A-Z0-9_]{1,63}$` and is then refused by the middleware's type lookup — the case exists precisely to prove that an unknown code answers 404 rather than 403, so a code that names nothing *is* the assertion; and **`SALES_INVOICE`**, which is **4A's** code in §4.14 and appears here only as pure-function input — T5's `sales-invoice.fixture.json`, which is spec:2008–2028's own example fed to `validatePolicy`, and T6's in-memory `evaluate.test.ts` snapshot fed to `evaluatePolicy`. Neither function touches a database and neither literal is a claim on §4.14's namespace. (1A's own `SALES_INVOICE`, in the pin case T9 Step 1 deletes, leaves the tree with that deletion.) Account codes: **none seeded**, and `1200`/`2100`/`5920`/`1000`/`4000` are all 0C's or 0A's; report codes and `DatasetId`: none; `fixtures.ts`: the two §4.17 helpers; `ERR_*`: none added · 33 **the slice that seeds a policy seeds the accounts it names** — this slice seeds **no** policy into a pack, and T1 asserts `1200`/`2100` resolve (creating them through 1A's `seedAccount` only in the unit-test tenant that has no pack), T13's policies name only `1000`/`4000`, which `seedTenantV2` guarantees · 34 **a document-type seed file is an envelope** and `module` is not the module segment of `approval.post` — T2's migration comment and T10's Zod doc-comment both say so · 35 **no placeholder anywhere** — every migration, handler, schema, fixture and test body is written out in full; no "similar to Task N", no ellipsis standing in for content.

### Issues found while reviewing, and fixed inline

1. **`reverseDocument` re-read the *current* policy — SAH-013, by the front door.** 1A resolves the reversal block with `resolvePolicy(tx, source.document_type_id, source.effective_date)`, which was safe while a policy version could arrive only through a reviewed seed PR. **This slice ships the API that breaks it**: `POST …/document-types/{documentTypeId}/policies` (T10) accepts any `effective_from`, ADR 0027 constrains only *overwriting*, and `resolvePolicy`'s `order by effective_from desc, version desc` means a version back-dated to on-or-before an already-posted document's `effective_date` becomes that document's answer — so a reversal written months later could produce a different type, or refuse outright, with no write to the document. That is the Part I heading verbatim. **Fixed in T8 Step 2b**: the `reversal` block is read from `app.document.posting_policy_id`, the column spec:1753 pins for exactly this reason; `resolvePolicy` still governs the reversal document's *own* posting at its *own* effective date, which is why the two documents legitimately pin different policies. Recorded as **amendment A8**, tested in T8 Step 1's sixth case and in T14's `sah-013` block, and the T8 run step now says what to do if one of 1A's own seven cases goes red on the new guard.
2. **Three API tests imported `tests/support/api` one directory too high.** `apps/api/test/routes/accounting/parties.test.ts`, `.../accounting/documents.branch.test.ts` and `.../admin/document-types.test.ts` all sit five levels below the repository root, and all three wrote `../../../../tests/support/api`, which resolves to `apps/tests/support/api`. 1B's frozen precedent is exact: `../../../../` from `apps/worker/test/handlers/` (four levels) and `../../../../../` from `apps/api/test/routes/accounting/` (five). All three corrected to five. Every one of those files would have failed at import time, before a single assertion ran.
3. **Twelve task headings used an em dash where the house form is a colon.** Normalised to `### Task N: <title>`. The batch is **not** uniform — 2C already uses three hashes with a colon, 2B uses three hashes with an em dash and 9A uses **two** hashes with a colon — so this is a normalisation toward the stated form rather than a match to a sibling, and it is the form a reviewer's `grep -c "^### Task "` count depends on. No cross-reference broke: every reference in this plan is by number or `T<n>`.
4. **The File Structure block listed no file for T15 and did not account for ADR 0028.** Added `docs/ui/phase-2a-party-api-surface.md`, and a paragraph recording that 0028 is allocated to this slice and **stays unused** — §3.4.1's rule for migration numbers applied to ADR numbers, so 2B may not borrow it.
5. **The Assumptions block claimed `POLICY_TEST` was the only document-type code this slice writes, while T10's own test creates `CONSIGNMENT_RETURN`.** The code is registered — to **2C** — so nothing was invented, but the header contradicted its own tasks. The namespaces bullet now names both and states the boundary: 2C keeps the code, its seed file and test 15; 2A writes it only into a request body, which is the zero-code claim rather than a second owner.
6. **Four `@dulja/contracts` exports had no amendment row.** T9 adds `DocumentTypeCodeSchema`, `DocumentLineKindSchema` and `DocumentLineInput` to `accounting/document.ts` and T10 adds `DocumentTypeModuleSchema` to `admin/document-type.ts`; all four are imported by 2C, 3A, 4A and 6A, so contracts:1263's "internal to one slice" exemption does not cover them. **A2 extended.** T9's `POLICY_RESOLVED_CODES` — the mechanism that keeps the bidirectional catalogue lint satisfied for a gate resolved from data, which no source scan can see — was likewise unregistered: **A4 extended.**
7. **The amendment table said "seven", then eight, and now holds ten.** The heading and the count were corrected together each time; A9 and A10 are the two rows the second review pass added, and the execution handoff's ordering list carries both.
8. **T13 first asserted `postingPolicyId` on the document read, and 1A's `DocumentSchema` has no such field.** 1A exposes `postingPolicyId` on `LedgerEntrySchema` and deliberately not on `DocumentSchema` — the pin is an internal fact, not a client concern. Two assertions were rewritten to read `app.document.posting_policy_id` through the production `withTenant` as `app_rw` (`pinnedPolicyOf`), which keeps the claim and avoids a §4.2.8 amendment this slice has no reason to make. An implementer typing the original would have got `Property 'postingPolicyId' does not exist` from `tsc`, not a test failure.
9. **T13 queried the ledger with `?filter[documentId][eq]=`, which 1A's route does not accept.** 1A's `LedgerEntryQuery` is flat — `accountId`, `fiscalPeriodId`, `documentId`, `from`, `to` — while this slice's own two configuration routes (T10, T11) use the `filter[x][eq]` form. Corrected to `?documentId=`, with the difference stated in a comment so the next reader does not “fix” it back. The two spellings coexisting across route modules is a real inconsistency in §4.2.8's list conventions and is worth one architect-level decision, but not one this slice may make unilaterally, and not one worth churning 1A's frozen route for.
10. **T14 claimed “seven cases” for eight `it`s** (2 + 3 + 3). Counted and corrected; a run step whose expected count is wrong trains an implementer to ignore run steps.
11. **The reversal's negated amounts could not reach the ledger at all.** T8 negates `amount`, `discount`, `tax_amount`, `total_incl_tax` and `quantity` on the mirror line and claimed the policy's own `each_line` rules would then "produce the mirrored ledger entries without a second set of rules". They would not: `evaluatePolicy` put the resolved amount into `PlannedLedgerLine.amount` unchanged and 1A's `insertLedger` writes it straight into the column named by `side` (1a:3176–3179), so a reversal of a document whose policy uses `amount: "line.amount"` inserts `debit = '-28.5000'` and dies on `ledger_entry_debit_check` (plan0A:2012). T8's first two cases and T14's `sah-013` mirror case were all unreachable, and the second expected `[["0.0000","40.0000"],["40.0000","0.0000"]]` — positive magnitudes with **swapped** sides, which negation alone can never produce. **Fixed by adding the sign normalisation to `evaluatePolicy`** (amendment **A9**): a negative resolved amount emits the rule's opposite side at `amount.abs()`, in both emit paths, with `PlannedTaxLine` exempt. That makes all three expectations true as written, and T6 gained a case asserting it directly. T13 escaped only because `CONSIGNMENT_RETURN`'s policy uses `line.debit`/`line.credit`, whose values are swapped rather than negated.
12. **T9 persisted none of the ten new line columns.** Step 3 item 3 was one sentence of prose and no step touched 1A's `insertLines`/`upsertLines`, whose INSERT column list is nine columns and whose parameter type names five members (1a:4924–4938) — so `kind`, `quantity`, `unitPrice`, `discount`, `amount`, `taxAmount`, `totalInclTax` and `customFields` were all silently discarded, the `party_id` the cross-tenant-FK case asserts on was never written, and the item-line case passed on a bare `expect(ok.status).toBe(201)`. Step 3 is now seven written-out edits — the create handler, both line writers, the `PUT …/lines` zeroing UPDATE widened to reset all fifteen client-writable columns, `readDocument`'s tombstone predicate, `lineColumns`/`toDocument`, and the `ROUTES` entry — and the item-line case reads the row back through `GET …/documents/{id}`.
13. **`DocumentLineInput` reversed three deliberate 1A constraints.** It dropped 1A's non-negative `Amount` for a signed regex, made `accountId` optional unconditionally, dropped the debit-or-credit `.refine`, and dropped `.min(1)` and the two `.openapi(…)` component names. Consequences: a body with `debit: "-5.0000"` or both sides positive reached `document_line_debit_check` as SQLSTATE 23514, which `fromDatabaseError` maps to **ERR_INTERNAL 500** rather than a 400; and an `account` line with no `accountId` is exactly the tombstone shape `readDocument` filters out — 1A's own self-review says the filter is safe "because `LineInput.accountId` is required" (1a:6281). All four are restored, `accountId` is required **conditionally on `kind === "account"`**, and `readDocument`'s predicate gained `kind = 'account'` so a legitimate item line with no account is visible while a tombstone is not. The **returned** `DocumentLineSchema` uses a separate `SignedAmount`, because a reversal's magnitudes genuinely are negative and a non-negative response schema would fail wire validation on every `GET` of a reversal.
14. **`readDocument`'s tombstone filter and the generator script are 1A files this slice now edits beyond what the original tasks stated.** Both are named explicitly — the filter in T9 Step 3 item 6 (one predicate, in a file T9 already modifies) and `packages/domain/scripts/generate-policy-type.ts` in T5 Step 4 (two inline constants lifted into `scripts/policy-type-options.ts` so the drift test and the script cannot disagree about them). Neither changes a §4 signature; both are listed in the tasks' *Files → Modify*.
15. **T7's A5 guard was unreachable in its own test.** The test policy had one `line.amount` leg and one `line.cost` leg, so evaluation planned debit 10.0000 against credit 0.0000 — and contracts §4.3.2 runs `balanceInBase` at **step 6**, before the guard at step 10, throwing `ERR_LEDGER_UNBALANCED` on a 10.0000 residue against a 0.02 tolerance (1a:1871–1874). The guard's placement was right; the policy was wrong. It now carries four legs — a balanced `line.amount` pair and a balanced `line.cost` pair — so the plan balances and the guard is what fires.
16. **Two joins named a column that does not exist.** T12's `branch-required.test.ts` and T13's `zero-code.test.ts` both wrote `join app.ledger_entry l on l.id = d.ledger_entry_id` against `app.ledger_entry_dimension`, whose columns are `(tenant_id, entry_id, dimension_type_id, dimension_value_id)` (plan0A:2041–2046). Both corrected to `d.entry_id`. The two assertions that close coverage row spec:1066 and the BRANCH clause of the zero-code proof would otherwise never have run.
17. **T13's "later policy version" case posted into a closed period and passed vacuously.** It drafted at `2026-02-10`, and §4.1 pins `seedTenant`'s periods as "2026-01 open, 2026-02 **closed**, 2026-03 locked" — so `postDocument` refused at step 5 with `ERR_PERIOD_NOT_OPEN`, the transition's status was never asserted, `febRows` came back empty and `[].every(…)` is `true`. The one assertion behind "a type can be *changed* with zero code" was green while proving nothing. Version 2 is now effective from `2026-01-20` and the document is dated `2026-01-25` — both inside the open period — both transitions assert `200`, and `lateRows` is asserted non-empty before the `every`.
18. **Three run steps and two helper names were wrong.** T1 said 8 tests for nine `it`s and T6 said 16 for seventeen (now nineteen, with A9's case and the zero-amount `each_tax` group's). T9's Step 1 called `seedPrincipal(api, a, …)` and `grantCodes(api, a, …)`, and its prose claimed both were "the two local helpers 1A's own `documents.test.ts` already defines" — 1A defines **neither**: it has one `grant(s, principalId, ...codes)` scoped inside its own `describe` and an inline principal insert in its `beforeAll`. Both helpers are now written out in full in T9 Step 1 and the prose says why they cannot be imported. T7's and T8's appended blocks called the **four**-argument test `withTenant` with a three-argument production signature in twelve places, passing a `TenantContext` object where a `tenantId` string belongs; every one is now `prodWithTenant(db.rw, ctx(s), …)`, matching 1a:2766 and 1a:3383, and the local `const ctx = { … }` declarations that shadowed 1A's file-level `ctx` helper are gone.
19. **Two document-type codes were in no register and one belonged to another slice.** T9 created `LATE_TYPE`, T10 created `TO_ARCHIVE`, T8 named `ABSENT_TYPE`, and T14's `sah-078` created `COST_ADJUSTMENT` — which §4.14 assigns to **3B**. Contracts §5 item 32 makes an unregistered code a review-blocking finding, and the Assumptions block and the hazard-32 line both claimed only two codes existed. All four sites now use `POLICY_TEST_2`, registered alongside `POLICY_TEST` by the extended **A1** with its own series `PT2`; `ABSENT_TYPE`'s case works better for it, since the point is a code that is registered but *not seeded in that company*.
20. **T14's `sah-078` block wrote two document types into the shared regression API seed.** `sharedApi()`'s `Seed`s are shared across every regression file and `app.document_type` is `unique (company_id, code)`, so 2C's or 3B's own appends creating either code would fail on whichever file ran second. Both cases now seed their own tenant with `seedTenantV2(api.db, "SAH078-2A"/"SAH078-2Ab")` + `grantAdmin`, the way the `sah-013` block already did, and the block's comment says so for 2C's writer.
21. **T6's null-cost case asserted one warning where the loop produced one per rule.** The warning `push` sits inside `for (const line of snapshot.lines)` within `for (const rule of policy.lines)`, so two `line.cost` rules over one line produced two identical strings and `toEqual` on an array is length-sensitive. Deduped in the implementation, keyed on `line ${lineNo}:` — a policy that names `line.cost` twice describes one uncomputed cost, so one sentence is the right answer and `plan.warnings` now grows with the facts rather than with the rule count.
22. **T11 printed a forbidden `tx.unsafe(COLUMNS)` inside a code block and forbade it in the paragraph below.** An implementer working top-to-bottom types the violation and the `no-sql-concat` lint (test 27) then fails the build. The code block now carries the compliant `returning` list, the `COLUMNS` constant and the correcting paragraph are gone, and a comment beside `toDto` records why the list is repeated five times.
23. **T11's duplicate-code case read a Problem envelope out of a 201.** `problemOf(res)` on a `PartySchema` body returns an object with no `status`, so `expect(undefined).toBe(201)` failed before the line below it could exercise the actual conflict. Corrected to `expect((await create({ code: "DUP" })).status).toBe(201)`.
24. **T5's drift guard compared only the first 400 normalised characters and re-picked the generator's options.** The thirteen-member `accountRef` and `amountRef` unions — the exact thing this widening changes — live past that prefix, and a `compile` call whose options differ from the script's compares against output the script never writes. The options and the banner now live in one side-effect-free module both sides import, the comparison is `toBe` over the whole normalised text with the banner stripped, and the run step states both failure modes.
25. **T10's two list handlers returned `next_cursor: null` under a `LIMIT`.** `ListQuery.limit` defaults to 100 and ADR 0027 makes a type's policy list a monotonically growing history, so both routes truncated silently. Both now use T11's keyset pattern with the shared §4.2.8 codec — `(code, id)` for the types list, `(version)` for the policies list — and a tenth case pages the types list and asserts nothing repeats. This closes what the previous review pass had left as open question 5.
26. **T7 Step 2 used an ellipsis in place of the `HeaderRow` interface and gave partial-edit instructions.** contracts §5 item 35 lists "an ellipsis standing in for content" as a plan failure and the plan's own hazard-35 line claimed there was none. The interface, the whole header query and the whole returned object are now written out, together with the note that 1A's `const zero = Money.zero(docCurrency)` becomes unused and must be deleted or `lint` fails.
27. **T13's tenant-isolation case passed for the wrong reason.** It asserted `403` on tenant B reading its own company's document types (B has no `admin.company.manage`) and `403` again on B naming A's company (membership refused before RLS is ever consulted). Neither assertion touched the row created in A, so the case would have gone green with `tenant_isolation` dropped from `app.document_type` — and it duplicated what T10's and T11's `PROBES` entries already prove (§3.7.2). Rewritten: B's own **admin** (`grantAdmin(api, b)`) lists B's types successfully, `JOURNAL` is present, `CONSIGNMENT_RETURN` is **absent**, and the cross-company call is asserted as `ERR_RBAC_FORBIDDEN` by code rather than by status. The failure table gained the row this case can now produce, and it names the more serious of the two causes.
28. **T6's `each_tax` zero-drop was correct but unpinned, and nothing in the task said why the order mattered.** The body already dropped a zero-amount group before calling `resolveAccount`, and 5A's five golden tax documents depend on it totally — a zero-rated, exempt or out-of-scope tax code carries no output and no input account, so resolving first refuses an ordinary zero-rated sale with `ERR_POLICY_REQUIRES_MISSING` naming an account that is right to be absent. No test covered it, so a later refactor swapping two statements would have gone green here and gone red three slices away. T6 now carries a "Read this before writing the `each_tax` path" paragraph, an in-body comment saying the order is load-bearing and that the `taxLines.push` sits deliberately outside the drop, and a nineteenth case asserting that a zero group plans no ledger line, resolves no account and still contributes its base as a `PlannedTaxLine`. Behaviour is unchanged; the run-step counts and both diagnostic sentences were updated with it.

29. **T9 turned two of 1A's own cases red and edited neither, while its run step promised green.** Deleting the static `accounting.journal.create` gate has a consequence the task had mis-stated: `JOURNAL_POLICY_V1` declares **no `approval.create`** (contracts §4.4.1, round-2 correction — the prose once said otherwise and the correction is explicit), so after T9 every JOURNAL stage resolves to `accounting.journal.post`, and 1A's `drafter`, granted only `accounting.journal.create` at 1a:4460, could no longer create — its create returned 403, `doc.id` came back `undefined`, and the follow-up transition hit `/documents/undefined/transitions`. Separately, 1a:4475 `it("refuses any documentTypeCode but JOURNAL at Phase 1 (2A lifts this)")` went red the moment Step 4 removed the `z.literal("JOURNAL")` pin: Zod accepts `SALES_INVOICE` and the middleware answers 404, not 400. **T9 Step 1 now opens with both edits written out in full** — the grant widened to both codes in 2B Task 7 Step 2's own wording (so 2B finds it already made), the drafter case rewritten to assert create **and** post with spec:2158's separation moved to the POLICY_TEST case where the policy genuinely names two codes, and the pin case deleted in favour of T9's own 404 case. Step 1's FAIL sentence and Step 5's expected counts were rewritten with it, and the commit body records both edits.
30. **T14's `sah-078` append had two errors that stop the file compiling or running.** The `ERR_POLICY_INVALID` case's `api.request({ … })` call closed `inventory`, `definition` and `body` and then the call paren, never closing the request-argument object — a syntax error, so no step of T14 could run. And its final assertion read `as: a.human` where the block seeds its tenant as `s`, which is either `Cannot find name 'a'` at typecheck or a cross-tenant 403 whose body has no `items`. Both fixed; the sibling case six lines above shows the correct brace count.
31. **Seven smaller corrections, each verified against the source it cites.** T5's catalogue comment said "four codes" over a six-element array (the payroll fixture needs all three `hr.payroll.*`). T9's `POLICY_RESOLVED_CODES` doc-comment claimed JOURNAL's policy "names these two" — it names one, and the comment now gives the real reason `accounting.journal.create` stays in the constant (Step 3 item 2 deletes its last source reference and §3.6.3's bidirectional check needs one). T8 Step 2 called the `document` insert an edit when it is byte-identical to 1a:3614–3621; the step is retitled and the paragraph now scopes the replacement to the `document_line` insert. T11's party-account case was titled "not this company's" while §4.5.7's key is tenant-composite only — retitled to match T1's equivalent case, with a comment saying what the schema does and does not guarantee. T11's probe calls `seedParty` and the step never said to import it. T13's commit body said "effective from February" after review item 17 moved the boundary to 2026-01-20 (2026-02 is a closed period). The hazard-32 line called `X1` the one further literal; `NOT_A_TYPE` is a second, and both are named now. The Task 12 → Task 13 boundary was missing its `---`, and the amendment table listed A8 above A7.

### Discrepancies between the card's prose and §3/§4, resolved in favour of §3/§4

- The card's Delivers ends "…; `accounting.document.reverse` handler", but §3.6.2 introduces that code in **2B**, §4.5.4 puts `POST …/documents/{documentId}/reverse` beside 2B's transitions route, and the bidirectional `permission-catalogue` check (§3.6.3) fails on whichever slice ships one half without the other. §3 and §4 win: 2A generalises the service, 2B ships the route and the code. **Amendment A7** rewrites the card sentence.
- §4.5.4 reads as though `requireDocumentPermission` were 2B's, while 1A's Task 12 states **twice** that 2A replaces the static gates. 1A's statement wins because it is the frozen plan another writer already built against; **amendment A4** moves authorship to 2A with all six stages mapped, so 2B never edits the stage map.
- §4.4.2 maps neither `when["document.kind"]` nor the `line.total_excl_tax` and `line.variance_value` amount references that §4.4.1's schema admits. **Amendment A6** resolves all three rather than leaving the evaluator with three unreachable schema branches.

### Open questions for the reviewer

1. **No card's Delivers ships a party master screen, yet the 2A card's Owner-gates cell names one.** 4A ships "AR/AP screens", 2C ships "document list/entry screens", and 2A ships none. Either 4A's cell is read as including the party master — in which case the OD-24 row belongs on 4A's card and 2A's should read "records the surface; ships no screen" — or a card's Delivers gains it. T15 and `docs/ui/phase-2a-party-api-surface.md` freeze the surface either way; the architect decides the owner. 1A hit the identical shape and this plan follows its resolution.
2. **Amendment A8 changes behaviour that a frozen plan shipped.** 1A is frozen and its `reverse.ts` is correct *as of 1A* — the defect only becomes reachable when this slice's policy API lands. The change is a nine-line edit inside a file T8 already modifies, the signature and error codes are unchanged, and §4.3.1 does not say which policy record the `reversal` block comes from. If the architect would rather not touch 1A's line, the alternative is to forbid a back-dated `effective_from` in T10's handler (`effectiveFrom >= max(effective_from)` on the type) — which is a weaker fix, because it leaves the re-read in place for any version inserted by the seed CLI's `on conflict … do update` (§3.4.8) and closes a door the owner may legitimately want open for a correction. Flagged, not decided.
3. **`accounting.party.manage` is the only gate on the party **read** endpoints.** spec:2159 gives the back-office clerk party maintenance and spec:2158 gives `user` read access with no code to gate it; `auditor` therefore sees no parties at all. If the reviewer wants a read-only party view, the permission vocabulary is closed (§3.6.1) and a `accounting.party.read` code is an amendment to that section, not a plan decision. T15 records the same question from the screen's side.
4. **This plan is ~5,200 lines against §2.0's ~3,700 indicative ceiling for a 15-task slice.** The task *count* is inside the 13–15 target; the length is not, and the second review pass added ~500 lines by writing out what had been prose or an ellipsis (T7's `HeaderRow` and returned object, T9's seven handler and line-writer edits, T9's two local test helpers). Every line is content §5 item 35 forbids abbreviating — the widened JSON Schema (T5), the thirteen-reference evaluator (T6), two route modules with their Zod contracts and route tests (T10, T11) and four migrations with hand-written downs account for most of the rest. **The split point this card does not name, proposed here:** Tasks 10 and 11 (`document-types` + `policies`, `parties`) become **2A′ — "the Phase 2 configuration API"**, depending on 2A and depended on by 2B and 2C. The cut is clean because **no migration and no ADR crosses it**: 0017–0019 belong to T1–T3, 0020 to T4, ADR 0026 to T5 and ADR 0027 to T10 — which is the one thing that would have to move, and it moves with its task. 2A′ would take `packages/contracts/src/accounting/party.ts`, `packages/contracts/src/admin/document-type.ts`, both route modules, both `PROBES` entries, T13's zero-code proof and T15's surface record; 2A would keep the schema, the evaluator, the snapshot, the reversal, the middleware and T12's coverage row. **The plan writer cannot make this change** — §2.0 requires the contracts document to be amended first, in its own PR, and the project folder is read-only to this writer except this one file. The architect decides: execute as one 15-task slice, or amend §2.3 and §6.4 and split this file at the `### Task 10` boundary, which needs no edit to any task body.
5. **Both of this slice's new list routes declare `filter[<field>][eq]` as literal Zod keys rather than calling §4.2.8's `parseFilters`.** `DocumentTypeQuery` and `PartyQuery` name `filter[code][eq]`, `filter[module][eq]` and `filter[kind][eq]` as members of their `<Resource>Query` schema and match them in SQL by hand; `parseFilters(query): FilterClause[]` (contracts:1798) is the shared parser, and it also gives `ne`/`in`/`like` for free. **The literal-key form is the deliberate choice here, and it is recorded so the next slice does not have to guess:** §4.2.8's own rule is that "each resource declares its filterable and sortable fields in its `<Resource>Query` schema — an undeclared field is `ERR_VALIDATION_FAILED`", and a literal key *is* that declaration, typed, with the enum values checked by Zod rather than by a hand-written switch on a `FilterClause.field` string. `parseFilters` earns its keep on a route with a wide or open filter surface — 4B's ageing, 9A's extraction — where enumerating every field × operator as a Zod key would be worse. **The architect should settle which form is the house default** (open question 3 of the previous pass names the adjacent inconsistency: 1A's `LedgerEntryQuery` is flat, with no `filter[…]` at all, and T13 consumes it as 1A shipped it). Until then: two spellings of a *convention* coexist, which hazard 9 tolerates; two spellings of a *helper* would not, and there is only one cursor codec and one `parseFilters` in the repository.

---

## Execution handoff

**Order.** Tasks 1 → 15, strictly. Each task is one commit.

**Before starting.** Confirm the phase gate: **1A and 1B merged**, and the Phase 1 definition of done (spec:2287) green in CI — "Σdebit = Σcredit under fuzz; a locked period cannot be altered through any path; projections rebuild to identical figures" (spec:87). Confirm specifically:

- `bun run test` green at the repository root, and `bun run lint:rules` green on the merged Phase 1 head. This slice's Global Constraints allow exactly one `lint:rules` window (Tasks 4→11); if the head is already red, that is 1A's or 1B's to resolve, not this slice's.
- 0B's **generalised** reversibility test (contracts §3.4.6) is in `packages/db/test/privileges.test.ts` — migrations 0017–0020 all depend on it, and Plan 0A's version hard-codes `[1]`.
- `packages/domain/src/posting/policy.ts` is the **committed generated** type and `packages/domain/posting-policy.schema.json` carries `$id: "urn:dulja:posting-policy:1"` with `"version": { "const": 1 }`. T5 widens that file in place; if 1A shipped a different `$id`, stop — the widening premise is gone.
- `document.posting_policy_id` is written by `postDocument` (contracts §4.3.2 step 13). **T8 Step 2b depends on it being non-null for every posted document.** Check with `select count(*) from app.document where status in ('posted','reversed') and posting_policy_id is null` on any seeded database; the answer must be 0.

**The ten amendments land first.** contracts:1261 makes a §4 addition an amendment to the contracts document, not a plan decision. Each row of *The ten amendments this plan needs* is one PR by the **architect** against `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`, ahead of the task named in its right-hand column. Execution of a task does not start until its amendment row has landed: **A1** before T6, **A2** before T9, **A3** before T10, **A4** before T9, **A5** before T6, **A6** before T6, **A7** before T8, **A8** before T8, **A9** before T6 (and T8 depends on it landing), **A10** before T10.

**Two of the ten are the ones an executor must not skip.** **A9** (§4.4.2 sign normalisation) is a *behavioural* addition, not a registry tidy-up: without it T8's mirror cases and T14's `sah-013` mirror case fail on `ledger_entry_debit_check`, because a reversal's negated `amount` reaches `insertLedger` as a negative number and `app.ledger_entry` refuses it (plan0A:2012). **A10** (§4.2.4 `errors[]` on `ERR_POLICY_INVALID`) is what T10's and T14's JSON-Pointer assertions read; structurally the member already fits, so a missing A10 shows up as a documentation contradiction rather than a red test — which is exactly the kind that survives to the next slice.

**The one earlier slice's test file this plan edits, and what 2B will find.** T9 Step 1 makes two edits inside 1A's `apps/api/test/routes/accounting/documents.test.ts` — it is the only file belonging to a merged slice whose *existing* cases this plan changes, and both changes are forced by the gate T9 replaces. (1) 1A's `drafter` grant becomes `await grant(a, drafter, "accounting.journal.create", "accounting.journal.post");` and its case now asserts that the drafter creates **and** posts a JOURNAL, because JOURNAL's policy names one code at every stage (§4.4.1's round-2 correction); spec:2158's "the clerk may not post" is asserted instead on `POLICY_TEST`, whose policy declares `approval.create`. (2) 1A's `refuses any documentTypeCode but JOURNAL at Phase 1 (2A lifts this)` case is deleted, replaced by T9's 404 case. **2B's Task 7 Step 2 "edit one" is therefore already made** — 2B's own text anticipates this ("if 2A did not already make it … check `beforeAll` before editing"), so 2B's executor should find the grant line as this slice leaves it and skip that edit. **What 2B must still check for itself:** its state machine and its R1/R8 SoD rules land on the same rewritten case, which now expects `posted.status === 200` for the creating principal on a `draft → posted` transition. If 2B's matrix or an SoD rule stops the creator from posting, that assertion is 2B's to move — a grant edit alone will not do it. Reported upward rather than pre-empted here, because 2A ships with no SoD rule and must be green on its own head.

**After every task**, at the repository root: `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test`. These four are exactly the set contracts §3.1 requires green after every task, and they are green after every task here.

**`bun run lint:rules` has one window, and it constrains PR boundaries rather than commits.** `permission-catalogue` is bidirectional (§3.6.3), and T4 adds `accounting.party.manage` to `packages/contracts/permissions.ts` in the **same PR** as migration 0020 because the check compares the database set and the exported set in both directions. From T4 until T11 registers the party route, `lint:rules` reports exactly **one** violation — `permission-catalogue … accounting.party.manage has no reference` — and no other rule reports anything. Because CI runs on a pull request, the boundaries are:

| PR | Tasks | Migration it carries | `lint:rules` at its head |
|---|---|---|---|
| 1 | T1 | `0017_create_party.sql` | green |
| 2 | T2 | `0018_alter_document_party_fk_and_document_type_module.sql` | green |
| 3 | T3 | `0019_alter_document_line_generalise.sql` | green |
| 4 | T4 → T11 | `0020_seed_permission_phase2a.sql` (the only one) | green — T11 registers the party route |
| 5 | T12 → T15 | none | green |

Five PRs, four migrations, **one migration per PR** (spec:2057). Commits 4 through 10 sit inside PR 4 and are never a PR head, so no red build is ever published. Pushing to GitHub is the owner's call in any case. If the architect would rather have one PR per task, move T4 to sit immediately before T11 — nothing in T5–T10 raises `accounting.party.manage`, and 0020 stays the highest migration number at the moment it is written — which is a catalogue-level renumbering this writer may not make unilaterally.

**Regenerate the OpenAPI document in the PRs that change a route.** `bun run --cwd packages/contracts openapi:generate` then `git diff --exit-code packages/contracts/openapi.json`; CI fails on a diff (spec:2055). That is T9, T10 and T11.

**What this slice hands to 2B** (its plan lists all of it as consumed): `requireDocumentPermission(stage)` with all six `DocumentStage` members mapped — 2B adds no stage and edits no map, it registers its own `RouteModule` permissions and calls the middleware for `submitted`/`approved`; `DOCUMENT_STAGE_CODES` and `POLICY_RESOLVED_CODES` to append its policy codes to; `reverseDocument` generalised **and reading the pinned policy**, over which 2B's `POST …/documents/{documentId}/reverse` is one handler and `accounting.document.reverse` one catalogue row; `app.party` and `document.party_id`; the ten `document_line` columns; `document_type.module`/`archived_at`; `seedParty` and `seedDocumentType`; the `document-types`, `policies` and `parties` routes with their two `PROBES` entries; ADRs 0026 and 0027. **ADR 0028 is 2A's and stays unused — 2B's range is 0029–0030 and it may not borrow 0028.**

**What this slice hands to 2C:** `seedDocumentType` — the one helper 2C, 3C, 3D, 4A, 6A and 8B all configure a type through (§4.17); the document-type and policy API through which test 15's `CONSIGNMENT_RETURN` is defined as pure configuration, and **T13's fixture, which is test 15 minus prints and reports** — 2C's test-15 task adds those two clauses to exactly this shape; `document_type.module`, which is the attachment download gate §4.5.8 keys on; `DOCUMENT_STAGE_CODES`, to which 2C appends nothing because `CONSIGNMENT_RETURN`'s `approval.post` is already `accounting.journal.post`.

**What this slice hands to 3A, 3B, 5A, 6A and 8B:** the two **FK slots** `document_line.item_id` and `document_line.tax_code_id`, unconstrained on purpose — 3A's `0032` adds `(tenant_id, item_id) → app.item`, 5A's `0055` adds `(tenant_id, tax_code_id) → app.tax_code`, and each adds its field to `DocumentLineInput` **in the PR that adds its key**, never before; `document_line_kind_check` by name, which 6A's `0061` and 8B's `0087` each drop and re-add with the complete union `('account','item','tax','text','tender','payroll')` — either may execute first (spec:2301), so neither may rely on a generated name; `document_line.cost` and **amendment A5's fail-closed guard in `postDocument`**, which **3B replaces** with the `applyMovements` call at §4.3.2 step 9 — until then a surviving zero-amount non-`fx_rounding` planned line raises `ERR_POLICY_REQUIRES_MISSING` rather than posting a silent zero; `PayComponentRef` and `SchemeRef`, declared in core so 8B maps onto them without `packages/domain/src/**` importing `packages/domain/payroll/**` (spec:2366); the BRANCH-refusal mechanism of T12, which **8B re-runs on PAYROLL** for test 28 (F-9).

**What this slice hands to 4A:** `app.party` with the two control-account links its `SALES_INVOICE` and `PURCHASE_INVOICE` policies resolve through `party.receivable_account` / `party.payable_account`; the Drizzle mirror `packages/db/src/schema/party.ts`, which is the diff source for 4A's `0045_alter_party_add_credit_control.sql` (`credit_limit`, `payment_term_id`, `credit_hold`) — extend the mirror, never rewrite it; the party API, to which 4A adds those three fields in the same PR as the migration; `docs/ui/phase-2a-party-api-surface.md`, whose *What changes* table 4A's screen task walks.

**Known-red until a later slice:** nothing. Every test this plan writes is green at the end of T14, and T15 writes none. The one deliberately unfinished behaviour is amendment A5's guard — it is a **passing** fail-closed test that 3B replaces with the real costing call, not a red one.

**If a task's stated failure does not appear, stop.** A different failure means the repository differs from what this plan assumes — most likely a 1A or 1B interface that shipped with a different shape. Report the difference rather than editing the expectation; the contracts document is amended first, then this plan. The two places this is most likely: T5's premise that 1A's schema is the JOURNAL **subset** of the same `$id`, and T8's premise that every posted document pins a policy.

