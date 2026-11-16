# Dulja Phase 2B — Document state machine, `document_event`, R1/R2 triggers, voids, gapless numbering proof

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the document lifecycle a data-layer control — a legal-transition matrix, maker ≠ checker (R1) and approval authority (R2) enforced by triggers on `app.document`, every transition recorded in an immutable `app.document_event`, overrides admitted only through a second principal, draft deletion the one DELETE the application role holds, and gaplessness of every issued number provable by one SQL function.

**Architecture.** The state machine lives in **two triggers on `app.document`**, not in TypeScript. `app.document_status_before()` is a BEFORE UPDATE OF status trigger that resolves the posting policy effective for the document's `effective_date`, applies the transition matrix of contracts §4.5.1, enforces R1 by reading `app.document_event` and R2 by calling `app.actor_has(code, company_id, branch_id)`; `app.document_status_after()` is the AFTER UPDATE OF status trigger that writes the `transition` event itself, so **no handler ever inserts `document_event`** (spec:1786) and a direct `app_rw` UPDATE cannot skip either control. The TypeScript seam above it — `transitionDocument`, `recordOverride` in `packages/db/src/posting/lifecycle.ts` — only sets the two transaction settings the AFTER trigger reads (`app.event_reason`, `app.event_attributed_to`) and issues the UPDATE; the API middleware `requireDocumentPermission(stage)` is a pre-flight for a better error message and never the control (spec:2173, SAH-032). Overrides are a second door on the same table: a BEFORE INSERT guard admits an `override` row only when `app.principal_has(attributed_to, override_code, company, branch)` holds for a principal that is neither the document's creator nor the principal it is attributed to (R8, spec:2179). Numbering integrity is closed from the other end: `app.series_gaps()` lists every number in `[1, next_number)` that is neither an issued document nor a recorded void, `document_delete_draft_only` refuses the deletion of anything but a draft, and the two together are what makes "issued numbers are unique and gapless-provable" a runnable assertion rather than a promise.

**Tech Stack:** PostgreSQL 18 (PL/pgSQL triggers, RLS with FORCE, advisory locks), TypeScript on Bun, `postgres.js` tagged templates, Drizzle ORM mirrors for reads, Hono + `@hono/zod-openapi`, Zod, Vitest + Testcontainers (Node 24).

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §0.2 (spec:97–106), §3.3 (spec:1188, 1190, 1201), §3.8 numbering (spec:1717–1745), `document` status/void (spec:1747–1780), `document_event` forward declaration (spec:1782–1787), linter lists (spec:1370), §3.9 Deletion (spec:2049) and Error codes (spec:2051), §3.10.1 recalculation (spec:2081), §4.2.1 branch scoping (spec:2166), §4.2.2 R1/R2/R3/R8 (spec:2172–2179), §4.7 (spec:2222–2224), §4.11 (spec:2254 keyboard parity — no screen ships here), Part V Phase 2 (spec:2288), Part VI tests 10, 16, 31 (spec:2428, 2434, 2449), Part I SAH-023, 032, 040, 041, 042, 051, 072.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 2B — Document state machine, `document_event`, R1/R2 triggers, voids, gapless numbering proof. **Phase:** 2. **Phase gate:** this plan starts only when **2A** is merged and the Phase 1 definition of done (1A, 1B) is green in CI (spec:87).
- **Depends on (merged):** **2A** (`app.party`, the generalised `document_line`, `document_type.module`/`archived_at`, the widened `posting-policy.schema.json` and `evaluatePolicy`/`validatePolicy`, `seedParty`, `seedDocumentType`, **`requireDocumentPermission` and `DOCUMENT_STAGE_CODES` — 2A's amendment A4**, the widened `CreateDocumentBody`/`DocumentLineSchema`/`ReplaceLinesBody`, the `document-types` and `parties` route modules); **1A** (`loadSnapshot`, `resolvePolicy`, `issueDocument`, `postDocument`, `reverseDocument`, `voidDocument`, `PostingError`, `app.posting_seq`, `JOURNAL_POLICY_V1`, `seedTenantV2`, `seedJournalPolicy`, `seedAccount`, `documentRoutes`); **1B** (`registerProjectionCheck`, `projectionChecks`, `ProjectionCheck`, `ProjectionMismatch`, `postJournal`); **0B** (`withTenant`, `TenantContext`, `systemContext`, `createDb`, `AppError`, `ERRORS`, `fromDatabaseError`, `requirePermission`, `AppEnv`, `IdempotencyHeader`, `buildRoutes`, `PROBES`, `startApi`, `thinRegression`, `sharedDb`); **0D** (`PERMISSIONS`, `PERMISSION`, `ROLES`, the `permission-catalogue` and `role-seed` lints); **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument test helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_tenant`, `app.current_actor`, `app.forbid_change`.
- **Migration numbers:** **0021–0024** — `0021_create_document_event.sql`, `0022_create_document_status_triggers.sql`, **`0023_grant_document_draft_delete_and_add_series_gaps.sql`**, `0024_seed_permission_phase2b.sql`, each with its hand-written `NNNN.down.sql`. The third file's name extends the card's expected `0023_grant_document_draft_delete.sql` because it carries `app.series_gaps` as well, and §3.4.2 requires the name to say what the file does — exactly the precedent 2A's card sets with `0018_alter_document_party_fk_and_document_type_module.sql`. **ADR numbers:** 0029, 0030.
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`, `createDb`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`), §4.2.4 (`Problem`, `ERRORS`, `ErrCode`, `AppError`, `fromDatabaseError`, `PostingError`, `PostingErrorCode`), §4.2.5 (`PERMISSIONS`, `PERMISSION`, `PermissionCode`, `requirePermission` with the `{ company: "path:companyId", branch: "document" }` scope, `ROLES`), §4.2.7 (`RouteModule`, `buildRoutes`, `IdempotencyHeader`, `IsolationProbe`, `PROBES`), §4.2.8 (`UuidSchema`, `DateSchema`, `TimestampSchema`, `ListEnvelope`, `ProblemSchema` — **no `ListQuery` and no cursor codec**: the one list this slice adds is a document's own bounded timeline, Task 8 route decision 3), §4.2.9 (`idempotency`), §4.2.12 (`startApi`, `StartedApi`, `ApiRequest`, `TEST_ISSUER`), §4.3.1 (`loadSnapshot`, `resolvePolicy`, `issueDocument`, `postDocument`, `reverseDocument`, `voidDocument`, `DocumentStatus`), §4.3.2 (the fixed algorithm — steps 7, 8 and 13 now run through this slice's triggers), §4.3.4 (`document_line`, the `document` header additions), §4.3.6 (numbering at issue), §4.3.7 (the document-type seed envelope), §4.4.1 (the policy schema as 2A widened it — `approval.required`, `.approve`, `.post`, `.create`; `numbering.series`; `reversal.producesType`), §4.4.2 (`PostingPolicy`, whose `["approval"]` member types `stageCode`), §4.16.3 (`ProjectionCheck`, `registerProjectionCheck`, `ProjectionMismatch`), §4.17 (`seedTenantV2`, `seedAccount`, `seedDocumentType`, `seedParty`), §4.17.1 (`sharedDb`, `thinRegression`, `postJournal`).
- **Interfaces produced:** §4.5.1 verbatim (the legal-transition matrix, as `app.document_status_before()`), §4.5.2 verbatim (`app.document_event`, its triggers, the two session settings), §4.5.3 verbatim (`app.principal_has`, `app.assert_override_authorised`, `document_event_override_guard`), §4.5.4's routes (the widened transitions body, **the widened `TransitionResultSchema` — a superset of 1A's six members, adding `from`, `to`, `eventId`** — and the handler, plus `POST …/reverse`, `POST …/overrides`, `DELETE …/{documentId}`, `GET …/{documentId}/events`) — **`DocumentStage`, `requireDocumentPermission` and `DOCUMENT_STAGE_CODES` are consumed, not produced: 2A's amendment A4 moved their authorship to 2A, and this slice adds only the `stageCode` export (assumption 4)**, §4.5.5 verbatim (`app.series_gaps`), §4.3.1 verbatim for `transitionDocument`, `TransitionResult`, `recordOverride`, `OverrideCode`, §3.5.4's second row (the DELETE grant on `document` and `document_line`), §3.6.2's `accounting.document.reverse`.
- **Owner decisions:** **none.** The 2B card's "Owner gates" cell reads *none*, and this slice ships no screen, so **OD-24 does not gate any task here** — every screen in Phase 2 is 2C's. No task in this plan waits on an owner.
- **Part VI tests owned / re-run:** **owned 10, 16, 31**; **re-run** 1 (the ledger invariant, now through the trigger path), 12 (four new routes get `PROBES` entries), 13 (`document` status writes are audited; `document_event` is immutable to `app_rw`), 36 (`accounting.document.reverse` joins the catalogue, handler and role seed). **§3.0.4 rows owned:** spec:1041 (document types + policies; numbering; approval state machine in `document_event` — 2A contributed the engine) and the "segregation of duties" clause of spec:1065. **Regression files created:** none. **Regression files appended:** `tests/regression/sah-023.test.ts`, `sah-032.test.ts`, `sah-040.test.ts`, `sah-041.test.ts`, `sah-042.test.ts`, `sah-051.test.ts`, `sah-072.test.ts` — all seven created by 0B (§3.7.3), so every block this slice adds is `describe("SAH-NNN … — 2B", …)` appended below the existing blocks, and no earlier block is edited.
- **Shared namespaces this slice writes into:** **document-type codes (§4.14):** **none seeded into a pack, five registered as test-only.** Tasks 4, 9 and 10 configure `GAP_TEST` (series `GAP`), `NG_NG`/`NG_RC`/`NG_HT` (series `NG`/`RC`/`HT`) and `SOD_TEST` (series `SD`) through `seedDocumentType` inside a Testcontainers database; none is ever a seed-pack file and none reaches `packages/db/seed/`, exactly as 2C's `CONSIGNMENT_RETURN` row is marked "test only". All five are registered in §4.14 already — the round-2 amendment pass landed them, and Task 12 Step 1 verifies each is present before the slice merges — because hazard 32 makes an unregistered document-type code a review-blocking finding. Their policies exist for one reason each: `issueDocument` writes `policy.numbering.series` onto the header (§4.3.6), so an assertion about a series is only non-vacuous against a type whose *policy* names it, and `SOD_TEST` is the only shape in which `approval.approve` and `approval.post` differ, which is what makes "above their own authority" testable. **Account codes (§4.15):** **none seeded and none consumed beyond 1A's** — every document this slice moves through the state machine debits `1000` Cash and credits `4000` Sales through the ids `seedTenant` returns as `a.cash`/`a.sales` (plan0A:1593–1595), never by looking a code up. **Contracts §5 item 33 — "an account code a policy names must resolve for the seeded company" — therefore does not bite here:** every policy this slice configures (Task 2's `STRICT`, Task 4's `GAP_TEST`, Task 9's `NG_*`, Task 10's `SOD_TEST`) addresses its accounts as `{ from: "line.account" }`, so no account code appears in any policy at all and there is nothing to resolve. The slice seeds no account and adds no code to §4.15. **Report codes (§4.16.1) and `DatasetId` members (§4.16.2):** **none** — Phase 2 ships no report; `document_event`'s reader is 7B's `accounting.document_event_log`. **`fixtures.ts` helpers (§4.17):** **`grantCodes`** and no others (a contract addition, declared below). **Shared test helpers (§4.17.1):** none added; `postJournal` is *modified* in Task 2, not replaced. **`ERR_*` (§4.2.4):** this slice adds exactly `ERR_SOD_NO_SUBMISSION`, `ERR_SOD_MAKER_IS_CHECKER`, `ERR_OVERRIDE_NOT_AUTHORISED` (Task 3 Step 5) and `ERR_DOC_NOT_DRAFT` (**Task 4 Step 9**) to `ERRORS` in `packages/contracts/src/errors.ts`. Each row lands in the same commit as the migration that raises its token as a string literal — the first three in `0021_*.sql`/`0022_*.sql`, the fourth in `0023_*.sql` — so `scripts/lint/rules/error-codes.ts`, which scans `packages/db/migrations/**` as well as source, is green at every commit of this slice. `ERR_DOC_STATUS_ILLEGAL`, `ERR_POLICY_NOT_FOUND`, `ERR_POLICY_INVALID`, `ERR_RBAC_FORBIDDEN` and `ERR_NOT_FOUND` already exist (0B, 1A) and are re-used, never re-spelled.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

### Five assumptions this plan makes explicit, because a reviewer must be able to check them

1. **`→ issued` carries no R2 check.** Contracts §4.5.1 attaches an authority condition to `approved`, `posted` and `void` only; `draft → issued` and `submitted → issued` are conditioned on `approval.required = false` and nothing else, and `approved → issued` is unconditional ("authority was checked at `approved`"). This plan implements exactly that. It is also what keeps Plan 0A's `packages/db/test/documents.test.ts` green: its one direct `update app.document set number = 1, status = 'issued'` runs as `a.human`, who holds no permission and whose seed policy has no `approval` block at all — the matrix admits it (`required` absent → false) and no gate is evaluated, so the assertion still fails on the unique constraint as 0A wrote it. **Plan 0A's tests are not edited by this slice.**
2. **R2 on `posted` genuinely raises the bar for existing tests, and Task 2 pays that cost once.** `app.actor_has(policy.approval.post, …)` now runs inside the transaction for every `issued → posted` update, and the DB-tier and `tests/`-tier posting suites of 1A, 1B **and 2A** act as a `s.human` whom `seedTenant` deliberately grants nothing (§4.1). Task 2 therefore adds the `grantCodes` fixture helper and applies it **once per seed object** — the unit is the seed, not the file — at **ten seed objects across five files**: `packages/db/test/posting/post.test.ts` (two seeds), `packages/db/test/posting/reverse.test.ts` (1A's outer seed pair **plus** 2A's nested `describe`'s own seed **plus** the local `b` its producesType case creates), `packages/db/test/posting/branch-required.test.ts` (2A T12), `tests/regression/sah-013.test.ts` (2A T14, two `sharedDb()` seeds) and `tests/invariants/support/post-journal.ts` (one memoised grant inside `postJournal`, the single choke point for the whole `tests/` tier) — **2 + 4 + 1 + 2 + 1 = 10**. Task 2 Step 7 prints the two `grep` commands that re-derive the list against the merged tree, so a worker never trusts this sentence over the repository. `packages/db/test/posting/issue.test.ts` and `packages/db/test/documents.test.ts` need no change — see assumption 1. 2A's *API*-tier suites already grant, because 2A's own `requireDocumentPermission` gates on the same code.
3. **`JOURNAL`'s effective policy declares no `approval.create`.** Contracts §4.4.1 says in prose that JOURNAL's `approval.create` is `accounting.journal.create`, but the frozen seed file of §4.3.7 and the frozen `JOURNAL_POLICY_V1` fixture of §4.17 both omit the member, and hazard 9 forbids editing either. §4.5.4's map is therefore implemented verbatim — `create`/`submit` resolve `approval.create ?? approval.post` — and for JOURNAL that resolves to `accounting.journal.post`. The one 1A route assertion this changes — `apps/api/test/routes/accounting/documents.test.ts`'s `drafter` principal, who held only `accounting.journal.create` — **is updated by 2A, not by this slice**: 2A Task 9 Step 1 widens the grant in this plan's own wording and rewrites the case beside it as "may create AND post", so Task 7 Step 2 verifies both and edits neither. That rewritten case still passes here: JOURNAL's `approval.required` is false, so block 2b's R1 never evaluates, `postDocument` reaches `posted` through the legal `draft → issued → posted` pair, and block 2c's gate is the very code 2A granted. The inconsistency is reported upward as a question for the contracts document, not resolved here (hazard 7).
4. **2A already shipped the middleware, and Tasks 6 and 7 begin with a diff.** Contracts §4.5.4 marks `requireDocumentPermission(stage)` "(2B)", but **2A's amendment A4 moved its authorship to 2A** — "created by **2A**, not 2B, and ship with **all six** `DocumentStage` members mapped … 2B then *uses* the middleware for its `submitted`/`approved` transitions and edits the file only to add its own `RouteModule` permissions, never the stage map" — and 2A is merged before this plan starts. A4 is honoured, not re-litigated (hazard 7). So: `apps/api/src/middleware/require-document-permission.ts`, `DOCUMENT_STAGE_CODES`, the replacement of 1A's two static gates and the widened `CreateDocumentBody` **exist when Task 6 begins**, and what remains genuinely 2B's is (a) the `stageCode` export, which 2A's Produces block does not list, (b) the dedicated middleware test file, which 2A did not create (it tested through `documents.test.ts`), and (c) everything in Task 7 that touches `TransitionBody`, which 2A did not touch — 1A's three-value enum is still there. Each of the two tasks opens with a reconciliation note naming exactly which of its steps become verifications. **Task 6 prints a two-edit diff against 2A's merged file and no full-file listing**, precisely so no reader can mistake a later description for the merged authority: 2A's `resolvePolicy` resolution, its `branchId = null` create branch, its error codes and its `POLICY_RESOLVED_CODES` export all stand, and **any difference between 2A's file and this plan is resolved in 2A's favour and reported, never overwritten.** 2A's amendment **A7** points the other way and is also honoured: `POST …/documents/{documentId}/reverse` and the `accounting.document.reverse` code are this slice's, and Tasks 5 and 8 land them in one pull request.
5. **A policy that declares no `approval.post` fails closed.** `posting-policy.schema.json` makes `approval.post` required, so any policy that lacks it is not schema-valid; the BEFORE trigger raises `ERR_POLICY_INVALID` rather than skipping the check, because a silent skip is the SAH-032 failure this slice exists to close. The only policies in the repository that lack the block are Plan 0A's placeholder fixture and Plan 0A's `'{"version":2}'::jsonb` row, and neither is ever transitioned past `issued` by any test.

## Global Constraints

- **Never**, verbatim (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (SAH-036/037/069); issue DDL from application code (SAH-053); disable an invariant, constraint or trigger "temporarily" (SAH-027, 041, 053); gate an audit write on any flag (SAH-030); hard-code a package version into a source file — the lockfile owns versions.
- **Always** (spec:106): every new table carries `tenant_id`, an RLS policy, `created_at`, a migration and a test that a second tenant cannot see it; every new endpoint carries a Zod schema, an OpenAPI entry, idempotency on unsafe methods and a tenant-isolation test; every UI screen is verified in both text directions before merge (this slice ships no screen).
- **Binding form for a new table** (§3.3): `tenant_id`; RLS enabled **and forced**; a policy named exactly `tenant_isolation`; `id uuid primary key default uuidv7()`; `created_at timestamptz not null default now()`; an `audit_row` trigger unless in `AUDIT_EXEMPT`; `stamp_<col>` for every `*_by` column **and for `document_event.actor_id`** (spec:1370); composite `(tenant_id, <parent>_id)` FKs to every tenant-scoped parent; a migration with a hand-written down; a two-tenant test.
- **Money is `numeric(19,4)`, rates `numeric(19,8)`, quantities `numeric(19,6)`** (§4.1). No `number` appears in any signature naming an amount (the `no-number-money` lint, §3.7.5). This slice writes no amount.
- **Every SQL statement is a `postgres.js` tagged template on a `tx` obtained from `withTenant`, or Drizzle.** `sql.unsafe` has exactly three homes and none of them is in this slice (§3.3, hazard 21).
- **`document_event` is written only by triggers and the override door** (hazard 24). No handler in this slice inserts a `transition` row; `recordOverride` inserts the `override` row and nothing else does.
- **One migration per PR** (spec:2057); each file runs whole in one transaction; SQL keywords lowercase; section banners `-- ── N. title ───`; every statement carries a comment naming the SAH- or spec reference it serves.
- **Commits** are conventional with the scope, subject form `<type>(<scope>): <summary> [2B T<n>]`, and every message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8).
- **Node 24 runs Vitest; Bun runs everything else** (D5). Tests connect as `app_rw` / `app_migrator` through `startDb()`, never as superuser for behaviour under test.
- **No package version is hard-coded**; nothing new is installed by this slice.

## Phase 2 definition of done (spec:2288, verbatim) and this slice's share

> **A new document type is added with zero code**; issued numbers are unique and gapless-provable

**This slice's share:** *"issued numbers are unique and gapless-provable"* — closed by Task 4 (`app.series_gaps` plus the draft-only DELETE guard) and proved end to end by Task 9 (acceptance test 16). The first clause is 2C's, proved by test 15; 2B supplies the state machine and the numbering integrity that a zero-code type inherits.

---

## File Structure

```
packages/db/
├─ migrations/
│  ├─ 0021_create_document_event.sql            app.document_event + app.principal_has +
│  │  0021.down.sql                             app.assert_override_authorised + the override guard      T1
│  ├─ 0022_create_document_status_triggers.sql  app.effective_policy, app.document_status_before,
│  │  0022.down.sql                             app.document_status_after and their two triggers          T2
│  ├─ 0023_grant_document_draft_delete_and_add_series_gaps.sql
│  │  0023.down.sql                             the DELETE grant, the two draft-only guards, series_gaps   T4
│  └─ 0024_seed_permission_phase2b.sql          accounting.document.reverse
│     0024.down.sql                                                                                        T5
├─ src/
│  ├─ schema/document-event.ts                  Drizzle mirror of app.document_event (reads only)         T1
│  ├─ posting/
│  │  ├─ lifecycle.ts                           setEventContext, transitionDocument, recordOverride,
│  │  │                                         OverrideCode, listDocumentEvents                          T3
│  │  ├─ reverse.ts        (modified)           voidDocument / reverseDocument set the event reason        T3
│  │  └─ index.ts          (modified)           re-exports ./lifecycle                                     T3
│  ├─ integrity/
│  │  ├─ series-gaps.ts                         SERIES_GAP_CHECK: ProjectionCheck over app.series_gaps     T4
│  │  └─ index.ts          (modified)           registerProjectionCheck(SERIES_GAP_CHECK)                  T4
│  └─ index.ts             (modified)           re-exports lifecycle and SERIES_GAP_CHECK                  T3, T4
└─ test/
   ├─ document-event.test.ts                    the table, its guards, the override door, two tenants     T1
   ├─ document-status.test.ts                   the transition matrix, R1, R2, the event rows             T2
   ├─ posting/lifecycle.test.ts                 transitionDocument / recordOverride / listDocumentEvents  T3
   ├─ document-delete.test.ts                   the DELETE grant, both guards, series_gaps                T4
   ├─ fixtures.ts           (modified)          + grantCodes                                              T2
   ├─ privileges.test.ts    (modified)          the pinned DELETE list gains document, document_line      T4
   ├─ permission-catalogue.test.ts (unmodified) proves 0024 and permissions.ts agree                      T5
   └─ posting/post.test.ts, posting/reverse.test.ts (modified)  grant approval.post before posting        T2

packages/contracts/
├─ permissions.ts          (modified)           + accounting.document.reverse                             T5
└─ src/
   ├─ errors.ts            (modified)           + ERR_SOD_NO_SUBMISSION, ERR_SOD_MAKER_IS_CHECKER,
   │                                            ERR_OVERRIDE_NOT_AUTHORISED  T3; + ERR_DOC_NOT_DRAFT     T4
   ├─ accounting/document.ts (modified)         TransitionBody + TransitionResultSchema widened;
   │                                            DocumentEventSchema, DocumentEventList, ReverseDocumentBody,
   │                                            ReverseDocumentResultSchema, OverrideBody,
   │                                            OverrideResultSchema, DeleteDocumentResultSchema          T7, T8
   └─ index.ts             (modified)           re-exports the new schemas                                T7, T8

packages/db/seed/roles.ts  (modified)           accountant gains accounting.document.reverse              T5

apps/api/src/
├─ middleware/require-document-permission.ts    2A's file (amendment A4) — this slice exports stageCode
│                          (modified)           in place of the private codeFor, nothing else            T6
└─ routes/accounting/documents.ts (modified)    TransitionBody's six stages, STAGE_FOR, lastEventId,
                                                headerOf; DOCUMENT_STAGE_CODES verified (2A's);
                                                POST …/reverse, POST …/overrides, DELETE …/{id},
                                                GET …/{id}/events, MODULE_READ_CODE                       T7, T8
apps/api/test/
├─ middleware/require-document-permission.test.ts                                                          T6
├─ routes/accounting/documents.test.ts (modified)  the drafter assertion; the widened transitions          T7
└─ routes/accounting/document-lifecycle.test.ts    reverse / overrides / delete / events                   T8

tests/
├─ invariants/probes.ts    (modified)           no new PROBES key — the four routes mount on the
│                                               existing /v1/companies/:companyId/documents module        T7, T8
├─ invariants/numbering-gapless.test.ts         acceptance test 16                                        T9
├─ invariants/segregation-of-duties.test.ts     acceptance tests 10 and 31                                T10
└─ regression/sah-023 · 032 · 040 · 041 · 042 · 051 · 072.test.ts (appended)                              T11

docs/adr/
├─ 0029-document-state-machine-in-triggers.md   proposal (security + data model — spec:95)                T2
└─ 0030-gapless-numbering-and-draft-deletion.md proposal (data model — spec:95)                           T4
```

---

### Task 1: Migration `0021_create_document_event.sql`: `app.document_event`, `app.principal_has`, the override door

`app.document_event` is the table spec:1782–1787 forward-declares and contracts §4.5.2 fixes: append-only, audit-exempt, `actor_id` stamped from the session and never from a payload (SAH-044), `attributed_to` a data column for the cashier or supervisor a POS event belongs to. The same file ships the **override door** — `app.principal_has`, the parameterised twin of `app.actor_has`, and the BEFORE INSERT guard that admits an `override` row only for a *second* principal who holds the override code at the document's branch (R8, spec:2179; SAH-027, SAH-048). Table and guards ship together because §3.5.1's new-table recipe is one unit: a table whose only write door is a trigger is not created until that trigger exists.

**Files:**
- Create: `packages/db/migrations/0021_create_document_event.sql`, `packages/db/migrations/0021.down.sql`, `packages/db/src/schema/document-event.ts`, `packages/db/test/document-event.test.ts`
- Modify: none. `document_event` is **already** a member of `AUDIT_EXEMPT` and `IMMUTABLE` in `packages/db/src/lint-schema.ts` (plan0A:2705–2711), and §3.5.3 pre-declares that it joins neither `NO_ID_TABLES` nor `NO_CREATED_AT_TABLES` — so this slice edits none of the six linter sets. Step 5 asserts that.

**Interfaces:**
- Consumes: `startDb`, `withTenant` (the 4-argument test helper), `uuidv7`, `seedTenant`, `draftDocument`, `type Db`, `type Seed` from `@dulja/db/test`; `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `MIGRATIONS_DIR` from `@dulja/db` and `@dulja/db/test`; `app_meta.enable_tenant_rls`, `app_meta.attach_stamp`, `app.forbid_change`, `app.current_actor`, `app.actor_has` (Plan 0A); `app.document` (plan0A migration 0001) and `app.permission` (global catalogue).
- Produces:
  - `app.document_event (id, tenant_id, company_id, document_id, event_kind, from_status, to_status, override_code, actor_id, attributed_to, occurred_at, reason, created_at)` exactly as contracts §4.5.2, with `unique (tenant_id, id)`, the composite FKs to `company` and `document`, the `event_kind` CHECK, the index `document_event_document_idx`, `tenant_isolation` RLS forced, the `stamp_actor_id` trigger and the `document_event_immutable` trigger.
  - `app.principal_has(p_principal uuid, p_code text, p_company_id uuid, p_branch_id uuid default null) returns boolean` — contracts §4.5.3 verbatim.
  - `app.assert_override_authorised() returns trigger` and the trigger `document_event_override_guard before insert on app.document_event for each row when (new.event_kind = 'override')`.
  - The DB error token `ERR_OVERRIDE_NOT_AUTHORISED` (SQLSTATE 23514, message `TOKEN: text`), consumed by `fromDatabaseError` in Task 3.
  - `documentEvent` — the Drizzle mirror in `packages/db/src/schema/document-event.ts`, used for reads in `apps/api` (Task 8).

- [ ] **Step 1: Write the failing test `packages/db/test/document-event.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "@dulja/db";
import { draftDocument, seedTenant, startDb, uuidv7, withTenant, type Db, type Seed } from "./index";

describe("app.document_event — contracts §4.5.2/§4.5.3, spec:1782–1787, R8 spec:2179", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  /** A second human in tenant `s`, so an override can be attributed to somebody other than the creator. */
  const secondPrincipal = async (s: Seed, label: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${s.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    return id;
  };
  /** Grants `codes` to `principalId` through a real role chain, acting as the tenant's SYSTEM principal
   *  (app.forbid_self_grant refuses a principal granting to itself — plan0A:1385). */
  const grant = async (s: Seed, principalId: string, codes: string[]): Promise<void> => {
    const roleId = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${roleId}, ${s.tenant}, ${`r-${roleId.slice(0, 8)}`}, 'grant')`;
      for (const code of codes) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                 values (${s.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    });
  };

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    b = await seedTenant(db, "Beta");
    // accounting.credit_limit.override is 4A's catalogue row (§3.6.2) and does not exist at 2B. The override
    // door is a mechanism, not a code, so the mechanism is proved against a row inserted here as the migrator.
    // app.permission is global, has no RLS and is read-only for app_rw (plan0A:1254), so only this test's own
    // container ever sees the row and permission-catalogue.test.ts (its own container) stays green.
    await db.migrator`insert into app.permission (code, module, mutating, description)
      values ('accounting.credit_limit.override', 'accounting', true, 'test-local stand-in for 4A''s code')
      on conflict (code) do nothing`;
  });
  afterAll(async () => { await db.stop(); });

  it("carries the contracts §4.5.2 columns and is tenant-isolated, forced, indexed", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'document_event' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "actor_id", "attributed_to", "company_id", "created_at", "document_id", "event_kind",
      "from_status", "id", "occurred_at", "override_code", "reason", "tenant_id", "to_status",
    ]);
    const [rls] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class
       where relnamespace = 'app'::regnamespace and relname = 'document_event'`;
    expect([rls!.relrowsecurity, rls!.relforcerowsecurity]).toEqual([true, true]);
    const idx = await db.admin<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = 'app' and tablename = 'document_event' order by 1`;
    expect(idx.map((i) => i.indexname)).toContain("document_event_document_idx");
  });

  it("stamps actor_id from the session and refuses a payload actor (spec:1370, SAH-044)", async () => {
    const doc = await draftDocument(db, a);
    const other = await secondPrincipal(a, "impostor");
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ actor_id: string }[]>`
      insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, actor_id)
      values (${a.tenant}, ${a.company}, ${doc}, 'transition', 'draft', 'submitted', ${other})
      returning actor_id`);
    expect(row!.actor_id).toBe(a.human);
  });

  it("is immutable: app_rw holds no UPDATE or DELETE and the trigger refuses both", async () => {
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'document_event' order by 1`;
    expect(grants.map((g) => g.privilege_type)).toEqual(["INSERT", "SELECT"]);
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status)
      values (${a.tenant}, ${a.company}, ${doc}, 'transition', 'draft', 'submitted')`);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`update app.document_event set reason = 'tampered' where document_id = ${doc}`),
    ).rejects.toThrow(/permission denied|ERR_TABLE_IMMUTABLE/);
  });

  it("refuses a transition row with an override_code and an override row without one", async () => {
    const doc = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, override_code)
      values (${a.tenant}, ${a.company}, ${doc}, 'transition', 'draft', 'submitted', 'accounting.credit_limit.override')`),
    ).rejects.toThrow(/document_event_check/);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status)
      values (${a.tenant}, ${a.company}, ${doc}, 'override', 'draft', 'draft')`),
    ).rejects.toThrow(/document_event_check/);
  });

  it("admits an override only from a second principal who holds the code (R8, spec:2179)", async () => {
    const doc = await draftDocument(db, a);                       // created_by = a.human
    const supervisor = await secondPrincipal(a, "supervisor");
    await grant(a, supervisor, ["accounting.credit_limit.override"]);

    // the creator cannot override their own document, even holding the code
    await grant(a, a.human, ["accounting.credit_limit.override"]);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, override_code, reason)
      values (${a.tenant}, ${a.company}, ${doc}, 'override', 'draft', 'draft', 'accounting.credit_limit.override', 'because I said so')`),
    ).rejects.toThrow(/ERR_OVERRIDE_NOT_AUTHORISED: an override on document .* needs a second principal/);

    // a second principal WITHOUT the code is refused
    const bystander = await secondPrincipal(a, "bystander");
    await expect(withTenant(db.rw, a.tenant, bystander, (tx) => tx`
      insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, override_code, reason)
      values (${a.tenant}, ${a.company}, ${doc}, 'override', 'draft', 'draft', 'accounting.credit_limit.override', 'passing by')`),
    ).rejects.toThrow(/ERR_OVERRIDE_NOT_AUTHORISED: principal .* does not hold accounting\.credit_limit\.override/);

    // the supervisor, who holds it and is not the creator, is admitted
    const [ok] = await withTenant(db.rw, a.tenant, supervisor, (tx) => tx<{ actor_id: string; override_code: string }[]>`
      insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, override_code, reason)
      values (${a.tenant}, ${a.company}, ${doc}, 'override', 'draft', 'draft', 'accounting.credit_limit.override', 'customer is good for it')
      returning actor_id, override_code`);
    expect(ok).toEqual({ actor_id: supervisor, override_code: "accounting.credit_limit.override" });
  });

  it("app.principal_has answers for a named principal, honours branch rows and never fails open", async () => {
    const scoped = await secondPrincipal(a, "branch-only");
    const roleId = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'bm2b', 'Branch manager')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${roleId}, 'accounting.credit_limit.override')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${scoped}, ${roleId}, ${a.company})`;
      await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
               values (${a.tenant}, ${scoped}, ${roleId}, ${a.company}, ${a.hq})`;
    });
    const [r] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { at_hq: boolean; company_wide: boolean; unknown_code: boolean }[]
    >`select app.principal_has(${scoped}, 'accounting.credit_limit.override', ${a.company}, ${a.hq}) as at_hq,
             app.principal_has(${scoped}, 'accounting.credit_limit.override', ${a.company})          as company_wide,
             app.principal_has(${scoped}, 'accounting.period.close', ${a.company}, ${a.hq})          as unknown_code`);
    expect(r).toEqual({ at_hq: true, company_wide: false, unknown_code: false });
  });

  it("tenant B cannot see or write tenant A's events (spec:106 'a test that a second tenant cannot see it')", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status)
      values (${a.tenant}, ${a.company}, ${doc}, 'transition', 'draft', 'submitted')`);
    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.document_event where document_id = ${doc}`);
    expect(seen[0]!.n).toBe(0);
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) => tx`
      insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status)
      values (${a.tenant}, ${a.company}, ${doc}, 'transition', 'draft', 'submitted')`),
    ).rejects.toThrow(/row-level security|violates row-level security policy/);
  });

  it("the schema linter reports zero violations and the six sets are untouched", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/document-event.test.ts`
Expected: FAIL — `relation "app.document_event" does not exist` on the first `information_schema` assertion (it returns `[]`, so the `toEqual` on the column list fails), and every later case errors on the same missing relation.

- [ ] **Step 3: Write `packages/db/migrations/0021_create_document_event.sql`**

```sql
-- 0021_create_document_event.sql ──────────────────────────────────────────────
-- The append-only record of every status change and every override on a document.
-- spec:1782–1787 forward-declares it; contracts §4.5.2 fixes the columns; C11 is resolved with event_kind.
-- Handlers never write this table: the AFTER UPDATE OF status trigger of migration 0022 writes 'transition'
-- rows and the override door below is the only other way in (spec:1786, SAH-044).

-- ── 1. the table ──────────────────────────────────────────────────────────────
create table app.document_event (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  document_id    uuid not null,
  event_kind     text not null check (event_kind in ('transition', 'override')),
  from_status    app.document_status not null,
  to_status      app.document_status not null,                  -- override: from_status = to_status = the status at the time
  override_code  text references app.permission(code),          -- overrides only; plain FK: permission is a global catalogue
  actor_id       uuid not null default app.current_actor() references app.principal(id),   -- stamped; never from a payload (SAH-044)
  attributed_to  uuid references app.principal(id),             -- the supervisor or cashier the event belongs to — DATA (spec:1785)
  occurred_at    timestamptz not null default now(),            -- the business time; created_at is the row time
  reason         text,
  created_at     timestamptz not null default now(),
  check ((event_kind = 'transition' and override_code is null and from_status <> to_status)
      or (event_kind = 'override'   and override_code is not null and from_status = to_status)),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, document_id) references app.document(tenant_id, id)
);
comment on table app.document_event is
  'Append-only lifecycle record. R1 (maker <> checker) is read from here by app.document_status_before (spec:2172).';

create index document_event_document_idx on app.document_event (document_id, occurred_at);

call app_meta.enable_tenant_rls('app.document_event');
call app_meta.attach_stamp('app.document_event', 'actor_id');    -- spec:1370 names actor_id explicitly, though it is not *_by

-- Immutable: no audit trigger (it is already in AUDIT_EXEMPT), no UPDATE/DELETE for app_rw (already in IMMUTABLE).
create trigger document_event_immutable before update or delete on app.document_event
  for each row execute function app.forbid_change();
revoke update, delete on app.document_event from app_rw;

-- ── 2. app.principal_has — the parameterised twin of app.actor_has (contracts §4.5.3) ─────────────────────
-- Identical body to app.actor_has (plan0A:985–1004) with p_principal in place of app.current_actor().
-- app.actor_has itself is untouched. A NULL branch asks for company-wide authority and is granted only by an
-- assignment with no branch rows, so a branch-restricted principal never gains anything by omitting the
-- branch (SAH-042, SAH-050 — never fail open).
create function app.principal_has(p_principal uuid, p_code text, p_company_id uuid, p_branch_id uuid default null)
returns boolean language sql stable as $$
  select exists (
    select 1 from app.principal p join app.membership m on m.principal_id = p.id
     where p.id = p_principal and p.kind = 'system' and m.tenant_id = app.current_tenant())
  or exists (
    select 1
      from app.role_assignment ra
      join app.role_permission rp on rp.role_id = ra.role_id
     where ra.principal_id = p_principal
       and ra.company_id   = p_company_id
       and rp.permission_code = p_code
       and (ra.expires_at is null or ra.expires_at > now())
       and (not exists (select 1 from app.role_assignment_branch b
                         where b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id)
            or (p_branch_id is not null and exists (
                  select 1 from app.role_assignment_branch b
                   where b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id
                     and b.branch_id = p_branch_id))))
$$;

-- ── 3. the override door (R8, spec:2179; SAH-027, SAH-048) ────────────────────────────────────────────────
-- An override is an explicit permission exercised per document by a SECOND principal and recorded here,
-- never a session flag. POS: actor_id is the terminal and attributed_to the supervisor whose PIN authorised
-- it; back office: actor_id is the second principal and attributed_to is null.
create function app.assert_override_authorised() returns trigger language plpgsql as $$
declare
  d app.document%rowtype;
  p uuid := coalesce(new.attributed_to, new.actor_id);
begin
  select * into d from app.document where id = new.document_id;
  if d.id is null then
    raise exception 'ERR_OVERRIDE_NOT_AUTHORISED: document % is not visible', new.document_id using errcode = 'check_violation';
  end if;
  if not app.principal_has(p, new.override_code, d.company_id, d.branch_id) then
    raise exception 'ERR_OVERRIDE_NOT_AUTHORISED: principal % does not hold % at branch %', p, new.override_code, d.branch_id using errcode = 'check_violation';
  end if;
  if p = d.created_by or p is not distinct from d.attributed_to then
    raise exception 'ERR_OVERRIDE_NOT_AUTHORISED: an override on document % needs a second principal', d.id using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- BEFORE INSERT triggers fire in alphabetical order, so document_event_override_guard runs before
-- stamp_actor_id; new.actor_id already carries the column default app.current_actor() at that point.
create trigger document_event_override_guard before insert on app.document_event
  for each row when (new.event_kind = 'override') execute function app.assert_override_authorised();
```

- [ ] **Step 4: Write `packages/db/migrations/0021.down.sql`**

```sql
-- 0021.down.sql ───────────────────────────────────────────────────────────────
-- Reverse dependency order. `drop function … cascade` removes the function's triggers (plan0A:1518).
drop function if exists app.assert_override_authorised() cascade;
drop function if exists app.principal_has(uuid, text, uuid, uuid);
drop table if exists app.document_event;
```

- [ ] **Step 5: Write the Drizzle mirror `packages/db/src/schema/document-event.ts`**

Every slice that creates a table adds its mirror in the same PR (§3.4.9); the mirror is what `drizzle-kit generate` diffs against and what `apps/api` reads through in Task 8.

**Two facts to establish by reading before writing this file, because neither is printed in any earlier plan.**

1. **The `app` schema object is 0B's and is imported, never re-declared.** `packages/db/src/schema/tenant.ts` declares `export const app = pgSchema("app");` (plan 0B Task 1 Step 8) and `packages/db/src/schema/index.ts` re-exports it as `export { app, tenantTable } from "./tenant";` (same task, Step 8). So this file writes `import { app } from "./tenant";` and **exports no `app` of its own** — 1A added `export * from "./schema/document_line";` to that index, so a second exported `app` would shadow or collide with 0B's rather than adding anything — and two `export *` mirrors both carrying `app` is an ambiguous re-export. (2A's `party.ts` declares a private `const app = pgSchema("app")` instead; either is safe, an *exported* one is not.)
2. **How `app.document_status` is spelled in the mirrors.** `packages/db/src/schema/document.ts` exists and is edited by 1A (its `posting_seq` column), 1B (an index) and 2A (the `party` relation), but no plan prints its `status` column, so the construct is unknown until the file is read. Open it and mirror `from_status`/`to_status` **the same way it mirrors `status`**, which is one of exactly two shapes:
   - if it declares and exports a pg enum — `export const documentStatus = app.enum("document_status", ["draft", "submitted", "approved", "issued", "void", "posted", "reversed"])`, or the same call as `pgEnum` — add `import { documentStatus } from "./document";` and write `documentStatus("from_status").notNull()` / `documentStatus("to_status").notNull()`;
   - if it types the column as `text(...).$type<DocumentStatus>()`, write the two columns the same way — `text("from_status").notNull().$type<DocumentStatus>()` — importing `DocumentStatus` from `@dulja/db`'s posting barrel (contracts §4.3.1) rather than inventing an enum object, because a second `pgEnum("document_status", …)` in a second file is a duplicate declaration `drizzle-kit generate` reports.

  **Do not create an enum export that `document.ts` does not already have**: the mirror follows the migration and the existing mirrors, it never leads them (§3.4.9). The code below is written in the first shape; if the file is in the second, substitute the two column lines and nothing else.

```ts
import { relations } from "drizzle-orm";
import { index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";                        // 0B's shared pgSchema("app") — never re-declared
import { documentStatus } from "./document";           // shape 1 above; see the note before this listing

/** Mirror of app.document_event (migration 0021). READS ONLY — every write goes through a trigger. */
export const documentEvent = app.table(
  "document_event",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id").notNull(),
    eventKind: text("event_kind").notNull().$type<"transition" | "override">(),
    fromStatus: documentStatus("from_status").notNull(),
    toStatus: documentStatus("to_status").notNull(),
    overrideCode: text("override_code"),
    actorId: uuid("actor_id").notNull(),
    attributedTo: uuid("attributed_to"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tenantRow: unique("document_event_tenant_id_id_key").on(t.tenantId, t.id),
    byDocument: index("document_event_document_idx").on(t.documentId, t.occurredAt),
  }),
);

export const documentEventRelations = relations(documentEvent, () => ({}));
```

- [ ] **Step 6: Run the migration and the test**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/document-event.test.ts`
Expected: **PASS** (8 tests). Two failures worth naming in advance: if the immutability case reports `ERR_TABLE_IMMUTABLE` from the trigger rather than `permission denied`, the `revoke` line did not run — the regex admits both, but a missing `revoke` also makes `lintSchema` report `immutable_privileges`, so check that assertion first. If the override case reports `insert or update on table "document_event" violates foreign key constraint` instead of `ERR_OVERRIDE_NOT_AUTHORISED`, the `beforeAll` permission row was not inserted — `app.permission` is global and `app_rw` cannot write it, so the insert must be on `db.migrator`.

- [ ] **Step 7: Prove the migration is reversible**

Run: `bun run --cwd packages/db test -- test/privileges.test.ts`
Expected: PASS — 0B's generalised `up → down → up` case (§3.4.6) now walks `[1, …, 21]` and the `schemaFingerprint` comparison covers the new table, its grants and its enum use.

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0021_create_document_event.sql packages/db/migrations/0021.down.sql \
        packages/db/src/schema/document-event.ts packages/db/test/document-event.test.ts
git commit -m "$(cat <<'EOF'
feat(db): app.document_event, app.principal_has and the override door [2B T1]

The append-only lifecycle record spec:1782-1787 forward-declares. actor_id is
stamped from the session and a payload actor is overwritten (SAH-044);
attributed_to stays data, so the cashier a POS event belongs to is never
confused with the principal that acted. The override door is R8 in the data
layer: an override row is admitted only when a SECOND principal holds the code
at the document's branch, so "one client-settable variable disables every
write-time control" (SAH-027) has no analogue here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: ADR 0029 and migration `0022_create_document_status_triggers.sql`: the matrix, R1 and R2

The whole state machine, in one file, because one migration file is one transaction and the matrix, R1 and R2 live in one function. `app.document_status_before()` is the control spec:2172–2173 demands: it resolves the policy **effective for the document's `effective_date`** — never `document.posting_policy_id`, which §3.8 pins only at post and is NULL at approval — applies contracts §4.5.1, reads `app.document_event` for R1 and calls `app.actor_has` for R2. `app.document_status_after()` writes the `transition` row itself, so a direct `app_rw` UPDATE cannot skip the record (spec:2172 clause 1).

This is also the task that pays the cost of R2 arriving: from here on, `issued → posted` requires the acting principal to hold the effective policy's `approval.post` at the document's branch, and the DB-tier and `tests/`-tier posting suites of 1A, 1B **and 2A** act as a `s.human` whom `seedTenant` grants nothing (§4.1). Step 6 adds one fixture helper, `grantCodes`, and Step 7 applies it once **per seed object** at every such call site in the merged tree.

**Files:**
- Create: `docs/adr/0029-document-state-machine-in-triggers.md`, `packages/db/migrations/0022_create_document_status_triggers.sql`, `packages/db/migrations/0022.down.sql`, `packages/db/test/document-status.test.ts`
- Modify: `packages/db/test/fixtures.ts` (add `grantCodes` — additive; no existing helper or constant is touched), `packages/db/test/posting/post.test.ts`, `packages/db/test/posting/reverse.test.ts`, `packages/db/test/posting/branch-required.test.ts` (2A), `tests/regression/sah-013.test.ts` (2A), `tests/invariants/support/post-journal.ts`

**Interfaces:**
- Consumes: `app.actor_has(p_code text, p_company_id uuid, p_branch_id uuid default null)`, `app.current_actor()` (Plan 0A); `app.document_event` and its two triggers (Task 1); `app.posting_policy (document_type_id, version, effective_from, definition)` (plan0A migration 0001); the policy shape of contracts §4.4.1 — `approval.required`, `approval.approve`, `approval.post`; `seedTenantV2`, `seedAccount`, `seedBranch` (0D, §4.17 — the one way a test creates a second `BRANCH` `dimension_value`), `draftDocument`, `uuidv7`, `withTenant`, `startDb` from `@dulja/db/test`; `postDocument`, `issueDocument` from `@dulja/db` (1A).
- Produces:
  - `app.effective_policy(p_document_type_id uuid, p_on date) returns jsonb` — the SQL twin of 1A's `resolvePolicy`: the `definition` of the row with the greatest `effective_from <= p_on`, ties broken by the highest `version`. **A contract addition** (§4.5.2 asks for "`resolvePolicy` semantics in SQL" and names no function).
  - `app.document_status_before() returns trigger` and `create trigger document_status_before before update of status on app.document for each row execute function app.document_status_before()`.
  - `app.document_status_after() returns trigger` and `create trigger document_status_after after update of status on app.document for each row when (old.status is distinct from new.status) execute function app.document_status_after()`.
  - The DB error tokens `ERR_DOC_STATUS_ILLEGAL` (already allocated, 1A), `ERR_SOD_NO_SUBMISSION`, `ERR_SOD_MAKER_IS_CHECKER`, `ERR_RBAC_FORBIDDEN`, `ERR_POLICY_NOT_FOUND`, `ERR_POLICY_INVALID` — all SQLSTATE 23514 in the `TOKEN: text` form (§4.1).
  - The two session settings the AFTER trigger reads: `app.event_reason`, `app.event_attributed_to` (contracts §4.5.2).
  - `grantCodes(db: Db, s: Seed, opts?: { codes?: readonly string[]; principalId?: string; roleCode?: string; branchIds?: readonly string[] }): Promise<string>` in `packages/db/test/fixtures.ts`, returning the created role's id. **A contract addition to §4.17.**

- [ ] **Step 1: Write `docs/adr/0029-document-state-machine-in-triggers.md`**

```markdown
# ADR 0029 — The document state machine lives in triggers, and the API gate is a pre-flight

**Status:** Proposed (spec:95 — this touches security and the data model, so it is proposed and asked before implementing)
**Date:** 2026-09-05
**Slice:** 2B
**Supersedes:** nothing. **Superseded by:** nothing.

## Context

spec:2172 states the mechanism in one sentence: "an AFTER UPDATE OF status trigger on `document` **inserts the
`document_event` row itself** … handlers never write `document_event`, so a direct `app_rw` update cannot skip
it", and "a BEFORE UPDATE OF status trigger enforces the legal transitions … and, for a type whose effective
policy declares `approval.required`, **fails closed**". spec:2173 adds that the handler's own check "is a
pre-flight for a better error message, not the control (SAH-032)". Acceptance tests 10 and 31 (spec:2428,
2449) require the rules to hold "through any path — API, job, or direct SQL as `app_rw`".

SAH-032 is the legacy system letting a user raise a document's approval level above their own; SAH-027 is one
client-settable variable disabling every write-time control. Both are the same shape of failure: the control
lived above the data.

Three placements were considered.

1. **In the API handler.** Rejected outright: it fails the "direct SQL as `app_rw`" clause of tests 10 and 31,
   and it is exactly SAH-032.
2. **In the posting service (`packages/db/src/posting/`).** Rejected: the sync-apply job, the importer and the
   payroll engine all reach `app.document` through `withTenant`, and a future writer that forgets the helper is
   one line away from a silent bypass. The `posting-only-tables` lint protects ledger and movement tables, not
   `document.status`.
3. **In two triggers on `app.document`.** Chosen.

## Decision

- `app.document_status_before()` — BEFORE UPDATE OF status, FOR EACH ROW — resolves the policy effective for
  `new.effective_date` through `app.effective_policy`, applies the contracts §4.5.1 matrix, then R1 and then R2.
  It resolves by `effective_date` and **not** by `document.posting_policy_id`, which §3.8 pins only at post and
  is NULL at approval (spec:2172).
- `app.document_status_after()` — AFTER UPDATE OF status, FOR EACH ROW, WHEN (old.status is distinct from
  new.status) — inserts the `transition` row, taking `reason` and `attributed_to` from two transaction settings
  (`app.event_reason`, `app.event_attributed_to`). The settings are the convention contracts §4.5.2 fixes for
  spec:2172's "reason from a transaction setting".
- `posted → reversed` is admitted **only when a posted document already carries
  `reverses_document_id = the original`**. That is `reverseDocument`'s own signature in data (1A posts the
  reversing document before flipping the original), so "only by `reverseDocument`" (contracts §4.5.1) becomes a
  row-level fact rather than a service-level promise, and a direct `update … set status = 'reversed'` fails.
- `→ issued` evaluates no authority code. The matrix conditions `draft → issued` and `submitted → issued` on
  `approval.required = false` and leaves `approved → issued` unconditional, because authority was checked at
  `approved`. Issuing consumes a number; it does not commit anything to the ledger.
- A policy that declares no `approval.post` **fails closed** with `ERR_POLICY_INVALID` on any transition to
  `approved`, `posted` or `void`. `posting-policy.schema.json` requires the member, so the only policies
  affected are pre-schema placeholders.
- `requireDocumentPermission(stage)` in `apps/api` performs the same resolution before the handler runs, purely
  so the caller gets `403 ERR_RBAC_FORBIDDEN` with a remedy instead of a 409 from a constraint. It is never the
  control.

## Consequences

- Every path — HTTP handler, pg-boss job under `systemContext`, `psql` as `app_rw` — is governed identically.
  Acceptance tests 10 and 31 are written against all three and pass without three implementations.
- Posting now requires authority. Every existing test that posted as a principal with no role must grant the
  effective policy's `approval.post` first. This slice adds `grantCodes` to `fixtures.ts` and updates the three
  call sites; later slices grant through the same helper.
- The trigger reads `app.document_event`, which is RLS-forced. Both tables are the current tenant's by
  construction (the trigger runs inside the same `withTenant` transaction), so no `SECURITY DEFINER` is needed —
  and none is used, because a definer function here would also bypass `tenant_isolation`, which is a tenancy
  hole, not a lifecycle one.
- A status change now costs one extra `app.posting_policy` lookup and one `document_event` insert. The lookup is
  a two-column index seek; the insert is what makes R1 answerable at all.
- **Open question for the contracts document, raised here and not decided here:** contracts §4.4.1 says JOURNAL's
  `approval.create` is `accounting.journal.create`, but §4.3.7's frozen seed file and §4.17's frozen
  `JOURNAL_POLICY_V1` both omit the member, so §4.5.4's `approval.create ?? approval.post` resolves JOURNAL's
  create stage to `accounting.journal.post`. Either the two frozen artefacts gain the member or the §4.4.1
  sentence goes. This plan implements §4.5.4 verbatim and changes neither artefact.
```

- [ ] **Step 2: Write the failing test `packages/db/test/document-status.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCodes, seedBranch, seedTenantV2, startDb, uuidv7, withTenant, type Db, type Seed } from "./index";

/**
 * The transition matrix, R1 and R2 exercised where they live: a direct `app_rw` UPDATE. Everything the API
 * and the jobs do reduces to this statement, so a rule proven here is proven for every path (spec:2172).
 */
describe("app.document_status_before / _after — contracts §4.5.1, spec:2172–2173 (SAH-032)", () => {
  let db: Db;
  let a: Seed;
  let approver: string;
  let poster: string;
  /** A type whose policy declares approval.required, so R1 and R2 both engage. */
  let strictType: string;

  const person = async (label: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${a.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
    });
    return id;
  };

  /**
   * A document of `typeId` INSERTED DIRECTLY at `status`, with two balanced lines so it could be posted if the
   * test wanted to. Both status triggers are `... update of status` triggers, so an INSERT fires neither: a row
   * created here at `submitted` carries **no `document_event` history at all**. That is the only way to reach
   * the state R1's first clause guards against, because every UPDATE into `submitted` writes the submitted
   * event itself — which is exactly why `ERR_SOD_NO_SUBMISSION` is unreachable from a `draft` row (the matrix
   * of block 2a refuses `draft → approved` with `ERR_DOC_STATUS_ILLEGAL` before R1 is ever evaluated).
   */
  const draftAt = async (typeId: string, series: string, status: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, status, effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId}, ${series}, ${status}::app.document_status, '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 10.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 10.0000)`;
    });
    return id;
  };

  /** A draft of `typeId` — the ordinary starting point for every case but R1's first. */
  const draft = (typeId: string, series: string): Promise<string> => draftAt(typeId, series, "draft");

  /** One status update as `actor`, with the reason carried through the transaction settings. */
  const move = (docId: string, to: string, actor: string, reason: string | null = null): Promise<unknown> =>
    withTenant(db.rw, a.tenant, actor, async (tx) => {
      await tx`select set_config('app.event_reason', ${reason ?? ""}, true),
                      set_config('app.event_attributed_to', '', true)`;
      await tx`update app.document set status = ${to}::app.document_status where id = ${docId}`;
    });

  const events = (docId: string) =>
    withTenant(db.rw, a.tenant, a.human, (tx) => tx<
      { from_status: string; to_status: string; actor_id: string; reason: string | null }[]
    >`select from_status::text as from_status, to_status::text as to_status, actor_id, reason
        from app.document_event where document_id = ${docId} and event_kind = 'transition' order by id`);

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    approver = await person("approver");
    poster = await person("poster");
    await grantCodes(db, a, { principalId: a.human, codes: ["accounting.journal.post"] });
    await grantCodes(db, a, { principalId: approver, codes: ["accounting.journal.post"] });
    await grantCodes(db, a, { principalId: poster, codes: ["accounting.journal.post"] });

    // A JOURNAL-shaped type whose policy REQUIRES approval, so the maker-checker rules engage. Both codes are
    // in the catalogue at 2B, which is what validatePolicy demands (F-21, contracts §4.4.1).
    strictType = await uuidv7(db.admin);
    const policyId = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.document_type (id, tenant_id, company_id, code, name_en)
               values (${strictType}, ${a.tenant}, ${a.company}, 'STRICT', 'Strict journal')`;
      await tx`insert into app.posting_policy (id, tenant_id, document_type_id, version, effective_from, definition)
               values (${policyId}, ${a.tenant}, ${strictType}, 1, '2026-01-01', ${JSON.stringify({
                 version: 1, documentType: "STRICT", direction: "internal", requires: [],
                 lines: [
                   { for: "each_line", side: "debit",  account: { from: "line.account" }, amount: "line.debit",  when: { "line.kind": "account" } },
                   { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
                 ],
                 inventory: { effect: "none" }, tax: { applies: false },
                 numbering: { series: "ST", assignAt: "issue" },
                 reversal: { allowed: true, producesType: "STRICT" },
                 approval: { required: true, approve: "accounting.journal.post", post: "accounting.journal.post" },
                 fxRoundingAccount: { from: "company.fx_rounding_account_id" },
                 dimensions: { required: [] },
               })}::jsonb)`;
    });
  });
  afterAll(async () => { await db.stop(); });

  it("admits draft → submitted always, and records the transition with its actor and reason", async () => {
    const d = await draft(strictType, "ST");
    await move(d, "submitted", a.human, "ready for review");
    expect(await events(d)).toEqual([
      { from_status: "draft", to_status: "submitted", actor_id: a.human, reason: "ready for review" },
    ]);
  });

  it("refuses draft → issued when the policy requires approval, and admits it when it does not", async () => {
    const strict = await draft(strictType, "ST");
    await expect(move(strict, "issued", a.human)).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: draft → issued needs approval\.required = false/);
    const loose = await draft(a.docType, "JV");                    // JOURNAL_POLICY_V1: approval.required = false
    await move(loose, "issued", a.human);
    expect((await events(loose)).at(-1)).toMatchObject({ from_status: "draft", to_status: "issued" });
  });

  it("R1: approving a submitted document that carries no submitted event is ERR_SOD_NO_SUBMISSION", async () => {
    // The document is INSERTED at `submitted`, not moved there: the matrix (block 2a) runs BEFORE R1 (block
    // 2b), so `draft → approved` is refused as an illegal pair and R1 is never reached. An INSERT fires no
    // `update of status` trigger, so this row is `submitted` with an empty event log — the one state in which
    // R1's first clause can speak, and the state a bad importer or a hand-written INSERT would produce.
    const d = await draftAt(strictType, "ST", "submitted");
    await expect(move(d, "approved", approver)).rejects.toThrow(
      /ERR_SOD_NO_SUBMISSION: document .* has no submitted event/);
  });

  it("R1: the submitter cannot approve or post their own document (spec:2172)", async () => {
    const d = await draft(strictType, "ST");
    await move(d, "submitted", a.human, "mine");
    await expect(move(d, "approved", a.human)).rejects.toThrow(
      /ERR_SOD_MAKER_IS_CHECKER: principal .* submitted document .* and cannot approve it/);
    await move(d, "approved", approver, "checked");
    await move(d, "issued", approver);
    await expect(move(d, "posted", a.human)).rejects.toThrow(
      /ERR_SOD_MAKER_IS_CHECKER: principal .* submitted document .* and cannot post it/);
  });

  it("R2: approval and posting are refused to a principal without the policy's code (spec:2173, SAH-032)", async () => {
    const nobody = await person("nobody");
    const d = await draft(strictType, "ST");
    await move(d, "submitted", a.human, "for review");
    await expect(move(d, "approved", nobody)).rejects.toThrow(
      /ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.journal\.post/);
  });

  it("R2: a branch-restricted principal is refused at another branch and admitted at its own (SAH-042)", async () => {
    const branchOnly = await person("branch-only");
    await grantCodes(db, a, { principalId: branchOnly, codes: ["accounting.journal.post"], branchIds: [a.hq] });
    const d = await draft(strictType, "ST");
    await move(d, "submitted", a.human, "for review");
    await move(d, "approved", branchOnly, "at my own branch");     // document.branch_id = a.hq
    expect((await events(d)).at(-1)).toMatchObject({ to_status: "approved", actor_id: branchOnly });

    // The registered fixture, not a hand-rolled INSERT: contracts §4.17 makes seedBranch (0D) the one way a
    // test creates a second BRANCH dimension_value, and §4.17's preamble makes that register binding.
    const other = await seedBranch(db, a, { code: "KL01", nameEn: "Kuala Lumpur shop" });
    const elsewhere = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${elsewhere}, ${a.tenant}, ${a.company}, ${strictType}, 'ST', '2026-01-15', 'MYR', ${other})`);
    await move(elsewhere, "submitted", a.human, "for review");
    await expect(move(elsewhere, "approved", branchOnly)).rejects.toThrow(
      /ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.journal\.post at branch/);
  });

  it("the backward edge needs a reason, and is the only backward edge", async () => {
    const d = await draft(strictType, "ST");
    await move(d, "submitted", a.human, "for review");
    await expect(move(d, "draft", a.human)).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: returning document .* from submitted to draft is a recalculation and needs a reason/);
    await move(d, "draft", a.human, "compensation_changed");
    expect((await events(d)).at(-1)).toEqual(
      { from_status: "submitted", to_status: "draft", actor_id: a.human, reason: "compensation_changed" });
    await move(d, "submitted", a.human, "again");
    await move(d, "approved", approver, "checked");
    await move(d, "draft", approver, "figures changed");
    expect((await events(d)).at(-1)).toMatchObject({ from_status: "approved", to_status: "draft" });
  });

  it("refuses every pair the matrix does not name", async () => {
    const d = await draft(strictType, "ST");
    // Every one of these is ERR_DOC_STATUS_ILLEGAL and nothing else: the matrix of block 2a names no pair
    // starting at `draft` except `submitted` and `issued`, and it runs before R1 and R2 — so the error is
    // never an SoD one from this row, however authorised the actor is.
    for (const to of ["approved", "posted", "void", "reversed"]) {
      await expect(move(d, to, approver, "why not"), `draft → ${to}`).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL/);
    }
    await move(d, "submitted", a.human, "for review");
    for (const to of ["posted", "void", "reversed"]) {
      await expect(move(d, to, approver, "why not")).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL/);
    }
  });

  it("posted → reversed is admitted only when a posted reversal already points at the original (D13)", async () => {
    const original = await draft(a.docType, "JV");
    await move(original, "issued", a.human);
    await move(original, "posted", a.human);
    await expect(move(original, "reversed", a.human, "by hand")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: document .* can only be marked reversed by reverseDocument/);

    const mirror = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id, reverses_document_id)
               values (${mirror}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2026-01-16', 'MYR', ${a.hq}, ${original})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${mirror}, 1, ${a.cash}, 10.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${mirror}, 2, ${a.sales}, 10.0000)`;
    });
    await move(mirror, "issued", a.human);
    await move(mirror, "posted", a.human);
    await move(original, "reversed", a.human, "corrected by JV reversal");
    expect((await events(original)).at(-1)).toMatchObject({ from_status: "posted", to_status: "reversed" });
  });

  it("a status update that does not change the status writes no event", async () => {
    const d = await draft(a.docType, "JV");
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx`update app.document set status = 'draft' where id = ${d}`);
    expect(await events(d)).toEqual([]);
  });

  it("a policy with no approval block fails closed on approved/posted/void (assumption 5)", async () => {
    // seedTenant's placeholder policy (version 1) has no approval member; JOURNAL_POLICY_V1 (version 2) does,
    // and resolution takes the highest version at the same effective_from — so a type with ONLY the placeholder
    // is what proves the fail-closed path.
    const bare = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.document_type (id, tenant_id, company_id, code, name_en)
               values (${bare}, ${a.tenant}, ${a.company}, 'BARE', 'Bare')`;
      await tx`insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
               values (${a.tenant}, ${bare}, 1, '2026-01-01', ${JSON.stringify({ version: 1, documentType: "BARE", direction: "none", lines: [] })}::jsonb)`;
    });
    const d = await draft(bare, "BR");
    await move(d, "issued", a.human);                                // no gate on → issued
    await expect(move(d, "void", a.human, "no policy")).rejects.toThrow(
      /ERR_POLICY_INVALID: the policy effective for document .* declares no approval\.post/);
  });

  it("ERR_POLICY_NOT_FOUND when no policy is effective for the document's date", async () => {
    const late = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.document_type (id, tenant_id, company_id, code, name_en)
               values (${late}, ${a.tenant}, ${a.company}, 'LATE', 'Late')`;
      await tx`insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
               values (${a.tenant}, ${late}, 1, '2027-01-01', ${JSON.stringify({ version: 1, documentType: "LATE", direction: "none", lines: [] })}::jsonb)`;
    });
    const d = await draft(late, "LT");
    await expect(move(d, "submitted", a.human, "too early")).rejects.toThrow(
      /ERR_POLICY_NOT_FOUND: no posting policy of document type .* is effective on 2026-01-15/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/document-status.test.ts`
Expected: FAIL — `import { grantCodes … } from "./index"` does not resolve (`grantCodes` is not exported), so the file fails at collection. `seedBranch` in the same import **does** resolve: it is 0D's, merged since Phase 0 (contracts §4.17). Add `grantCodes` in Step 6 and the failure moves to the first assertion: `draft → submitted` writes no `document_event` row, so `events(d)` returns `[]`.

- [ ] **Step 4: Write `packages/db/migrations/0022_create_document_status_triggers.sql`**

```sql
-- 0022_create_document_status_triggers.sql ────────────────────────────────────
-- The document state machine, in the data layer. spec:2172-2173; contracts §4.5.1; ADR 0029.
-- SAH-032: a user could raise a document's approval level above their own because the check lived in the UI.
-- Here it lives in a BEFORE UPDATE OF status trigger, so the API, a pg-boss job and psql as app_rw are all
-- governed identically (acceptance tests 10 and 31).

-- ── 1. the SQL twin of the posting service's resolvePolicy (contracts §4.3.1, §4.5.2) ─────────────────────
-- The policy EFFECTIVE FOR THE DOCUMENT'S effective_date — never document.posting_policy_id, which §3.8 pins
-- only at post and is NULL at approval (spec:2172). Ties on effective_from are broken by the highest version.
create function app.effective_policy(p_document_type_id uuid, p_on date) returns jsonb
language sql stable as $$
  select p.definition
    from app.posting_policy p
   where p.document_type_id = p_document_type_id
     and p.effective_from <= p_on
   order by p.effective_from desc, p.version desc
   limit 1
$$;

-- ── 2. the BEFORE trigger: the legal-transition matrix, R1 and R2 ────────────────────────────────────────
create function app.document_status_before() returns trigger language plpgsql as $$
declare
  v_policy   jsonb;
  v_required boolean;
  v_approve  text;
  v_post     text;
  v_gate     text;
begin
  -- An UPDATE that lists status but does not change it is not a transition (a no-op re-save).
  if new.status is not distinct from old.status then
    return new;
  end if;

  v_policy := app.effective_policy(new.document_type_id, new.effective_date);
  if v_policy is null then
    raise exception 'ERR_POLICY_NOT_FOUND: no posting policy of document type % is effective on %',
      new.document_type_id, to_char(new.effective_date, 'YYYY-MM-DD') using errcode = 'check_violation';
  end if;
  v_required := coalesce((v_policy -> 'approval' ->> 'required')::boolean, false);
  v_approve  := v_policy -> 'approval' ->> 'approve';
  v_post     := v_policy -> 'approval' ->> 'post';

  -- ── 2a. the matrix (contracts §4.5.1). Every pair not named here is illegal. ────────────────────────────
  if old.status = 'draft' and new.status = 'submitted' then
    null;                                                        -- always

  elsif old.status in ('draft', 'submitted') and new.status = 'issued' then
    if v_required then
      raise exception 'ERR_DOC_STATUS_ILLEGAL: % → issued needs approval.required = false; document % must be approved first',
        old.status, new.id using errcode = 'check_violation';
    end if;

  elsif old.status = 'submitted' and new.status = 'approved' then
    null;                                                        -- R1 and R2 below

  elsif old.status in ('submitted', 'approved') and new.status = 'draft' then
    -- The one backward edge (spec:1188, 2081). R3 uses reason 'compensation_changed'; every caller must give one.
    if nullif(current_setting('app.event_reason', true), '') is null then
      raise exception 'ERR_DOC_STATUS_ILLEGAL: returning document % from % to draft is a recalculation and needs a reason (spec:2081)',
        new.id, old.status using errcode = 'check_violation';
    end if;

  elsif old.status = 'approved' and new.status = 'issued' then
    null;                                                        -- authority was checked at approved

  elsif old.status = 'issued' and new.status in ('posted', 'void') then
    null;                                                        -- R1 and R2 below

  elsif old.status = 'posted' and new.status = 'reversed' then
    -- "Only by reverseDocument" expressed in data: 1A posts the reversing document BEFORE flipping the
    -- original, so a posted document carrying reverses_document_id = this one is that call's signature (D13).
    if not exists (select 1 from app.document r where r.reverses_document_id = new.id and r.status = 'posted') then
      raise exception 'ERR_DOC_STATUS_ILLEGAL: document % can only be marked reversed by reverseDocument, which posts the reversing document first (D13, spec:2224)',
        new.id using errcode = 'check_violation';
    end if;

  else
    raise exception 'ERR_DOC_STATUS_ILLEGAL: % → % is not a legal transition for document % (contracts §4.5.1)',
      old.status, new.status, new.id using errcode = 'check_violation';
  end if;

  -- ── 2b. R1 maker <> checker (spec:2172). Read from document_event, which only triggers write. ───────────
  if v_required and new.status in ('approved', 'posted') then
    if not exists (select 1 from app.document_event e
                    where e.document_id = new.id and e.event_kind = 'transition' and e.to_status = 'submitted') then
      raise exception 'ERR_SOD_NO_SUBMISSION: document % has no submitted event; its type requires a maker before a checker',
        new.id using errcode = 'check_violation';
    end if;
    if exists (select 1 from app.document_event e
                where e.document_id = new.id and e.event_kind = 'transition' and e.to_status = 'submitted'
                  and e.actor_id = app.current_actor()) then
      raise exception 'ERR_SOD_MAKER_IS_CHECKER: principal % submitted document % and cannot % it',
        app.current_actor(), new.id, case when new.status = 'approved' then 'approve' else 'post' end
        using errcode = 'check_violation';
    end if;
  end if;

  -- ── 2c. R2 authority at transition time (spec:2173). NULL branch never fails open (SAH-042, SAH-050). ───
  if new.status = 'approved' then
    v_gate := coalesce(v_approve, v_post);          -- for approval.required = false types approve is null
  elsif new.status in ('posted', 'void') then
    v_gate := v_post;
  else
    v_gate := null;                                 -- submitted, draft and issued evaluate no code (ADR 0029)
  end if;

  if v_gate is null and new.status in ('approved', 'posted', 'void') then
    raise exception 'ERR_POLICY_INVALID: the policy effective for document % declares no approval.%',
      new.id, case when new.status = 'approved' then 'approve and no approval.post' else 'post' end
      using errcode = 'check_violation';
  end if;
  if v_gate is not null and not app.actor_has(v_gate, new.company_id, new.branch_id) then
    raise exception 'ERR_RBAC_FORBIDDEN: principal % does not hold % at branch % of company %',
      app.current_actor(), v_gate, new.branch_id, new.company_id using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- Trigger names fire alphabetically within a timing class: document_status_before runs before stamp_created_by
-- and stamp_posted_by, neither of which this function reads.
create trigger document_status_before before update of status on app.document
  for each row execute function app.document_status_before();

-- ── 3. the AFTER trigger: the record itself (spec:2172 clause 1) ─────────────────────────────────────────
-- Handlers never insert document_event. The reason and the attributed principal arrive as transaction
-- settings, which is the convention contracts §4.5.2 fixes for spec:2172's "reason from a transaction setting".
create function app.document_status_after() returns trigger language plpgsql as $$
begin
  insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status,
                                  attributed_to, reason)
  values (new.tenant_id, new.company_id, new.id, 'transition', old.status, new.status,
          nullif(current_setting('app.event_attributed_to', true), '')::uuid,
          nullif(current_setting('app.event_reason', true), ''));
  return null;                                       -- row-level AFTER triggers ignore the return value
end $$;

create trigger document_status_after after update of status on app.document
  for each row when (old.status is distinct from new.status) execute function app.document_status_after();
```

- [ ] **Step 5: Write `packages/db/migrations/0022.down.sql`**

```sql
-- 0022.down.sql ───────────────────────────────────────────────────────────────
-- `drop function … cascade` removes the function's triggers (plan0A:1518); reverse dependency order.
drop function if exists app.document_status_after() cascade;
drop function if exists app.document_status_before() cascade;
drop function if exists app.effective_policy(uuid, date);
```

- [ ] **Step 6: Add `grantCodes` to `packages/db/test/fixtures.ts`**

Append to the end of the file. **Nothing above it changes** — `Seed`, `seedTenant` and `draftDocument` are Plan 0A's and are immovable (§4.1, hazard 9).

```ts
/**
 * Grants `codes` to a principal through a real role → role_permission → role_assignment chain, acting as the
 * tenant's SYSTEM principal: `app.forbid_self_grant` (plan0A:1385) refuses a principal granting to itself and
 * `app.assert_assignment_kind` refuses a non-terminal role on a terminal. Returns the role id.
 *
 * `seedTenant` deliberately grants `s.human` nothing (contracts §4.1), so from slice 2B — when the BEFORE
 * UPDATE OF status trigger began calling `app.actor_has` — every test that approves, posts or voids a document
 * must grant first. This is the ONE way to do it at the database tier; route tests use 0B's `grantAdmin`
 * (contracts §4.17.1) for the five admin codes and this helper for anything narrower.
 *
 * `branchIds` adds `role_assignment_branch` rows, which restrict the assignment to those BRANCH dimension
 * values: with rows present, `app.actor_has(code, company, null)` is FALSE (spec:2166, SAH-042).
 *
 * `opts` is optional and every member of it is optional, so `grantCodes(db, s)` is legal and **grants
 * nothing**: it creates a role with zero `role_permission` rows and assigns it, which is the documented
 * behaviour and not a bug — Task 8's `no-codes` case passes `codes: []` deliberately to build a principal
 * who holds a role and no code. A caller who wants a grant must pass `codes`.
 */
export async function grantCodes(
  db: Db,
  s: Seed,
  opts: {
    codes?: readonly string[];
    principalId?: string;
    roleCode?: string;
    branchIds?: readonly string[];
  } = {},
): Promise<string> {
  const roleId = await uuidv7(db.admin);
  const principalId = opts.principalId ?? s.human;
  const roleCode = opts.roleCode ?? `grant-${roleId.slice(0, 8)}`;
  await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
    await tx`insert into app.role (id, tenant_id, code, name_en)
             values (${roleId}, ${s.tenant}, ${roleCode}, ${`Granted role ${roleCode}`})`;
    for (const code of opts.codes ?? []) {
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${s.tenant}, ${roleId}, ${code})`;
    }
    await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
             values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    for (const branchId of opts.branchIds ?? []) {
      await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
               values (${s.tenant}, ${principalId}, ${roleId}, ${s.company}, ${branchId})`;
    }
  });
  return roleId;
}
```

- [ ] **Step 7: Grant `accounting.journal.post` at every call site that posts as an ungranted principal**

R2 makes posting an authorised act. **The unit is the seed object, not the file:** a grant is per `(principal, company)` chain, so a file with two `seedTenantV2` calls — or a nested `describe` with its own `beforeAll` — needs one grant each. Derive the list mechanically before editing, against the **merged 2A tree**:

```bash
grep -rn "postDocument(\|reverseDocument(\|transitionDocument(" packages/db/test tests | grep -v "support/post-journal.ts"
grep -rn "seedTenantV2(" packages/db/test tests
```

Every `Seed` in the first list's files whose acting principal holds no role needs one `grantCodes(db, <seed>, { codes: ["accounting.journal.post"] })` before its first posting call. `POLICY_TEST`, `SOD_TEST`, `STRICT` and `JOURNAL_POLICY_V1` all name `accounting.journal.post` as `approval.post`, so one code covers every one of them, and `reverseDocument` needs the *reversal type's* `approval.post` — for all of them the same code again. **`packages/db/test/posting/issue.test.ts` and `packages/db/test/documents.test.ts` need nothing** (assumption 1: `→ issued` evaluates no code).

At 2A-merged the list is **ten seed objects across five files** (2 + 4 + 1 + 2 + 1, counted below), and this is the complete set:

`packages/db/test/posting/post.test.ts` (1A, extended by 2A T7) — inside the file's `beforeAll`, immediately after the two `seedTenantV2` calls:

```ts
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    await grantCodes(db, b, { codes: ["accounting.journal.post"] });
```

and extend the existing import to `import { draftDocument, grantCodes, seedTenantV2, … } from "../index";` (keep the path the file already uses). The same import change is needed in each file below.

`packages/db/test/posting/reverse.test.ts` (1A, extended by 2A T8) — **two `beforeAll`s and one in-test seed**, because 2A appended a nested `describe("reverseDocument on a generalised line — D13, contracts §4.3.1")` with its own `let a: Seed`:

```ts
    // in 1A's outer beforeAll, after its seedTenantV2 calls
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    await grantCodes(db, b, { codes: ["accounting.journal.post"] });
```

```ts
    // in 2A's nested describe's own beforeAll, after `a = await seedTenantV2(db, "Alpha");`
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
```

```ts
    // inside 2A's case "refuses when producesType names a type this company does not have", immediately
    // after `const b = await seedTenantV2(db, "Beta");` — that case posts the source document as b.human
    // before asserting the reversal refusal, so without the grant it fails in its own setup.
    await grantCodes(db, b, { codes: ["accounting.journal.post"] });
```

`packages/db/test/posting/branch-required.test.ts` (2A T12) — its `draftAndPost` helper posts as `a.human` on its own `seedTenantV2`; add the grant in its `beforeAll`, after `a = await seedTenantV2(db, "Alpha");`:

```ts
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
```

`tests/regression/sah-013.test.ts` (2A T14) — two blocks, each with its own `sharedDb()` seed (`"SAH013-2A"` and `"SAH013-2Ab"`); add the grant immediately after each `seedTenantV2` call, before the `withTenant` that posts:

```ts
    await grantCodes(db, s, { codes: ["accounting.journal.post"], roleCode: "sah013-post" });
```

(`roleCode` is passed because `sharedDb()` shares one database across the whole thin-regression tier and a generated role code per call would otherwise accumulate; a fixed code is fine because each block seeds its own tenant. **This file is in the `tests` workspace and imports from `@dulja/db/test`, not `../index`** — add `grantCodes` to that import.)

`tests/invariants/support/post-journal.ts` — `postJournal` is the whole `tests/` tier's only way to create ledger rows (contracts §4.17.1), so the grant belongs inside it, once per `Seed`, rather than in every caller:

```ts
import { grantCodes, type Db, type Seed } from "@dulja/db/test";

/** Seeds that have already been granted accounting.journal.post — the helper is called many times per Seed. */
const granted = new WeakSet<Seed>();

/** Slice 2B: the BEFORE UPDATE OF status trigger calls app.actor_has(policy.approval.post, …) on issued →
 *  posted, and `seedTenant` grants `s.human` nothing (contracts §4.1). One grant per Seed, memoised. */
async function ensurePostAuthority(db: Db, s: Seed): Promise<void> {
  if (granted.has(s)) return;
  await grantCodes(db, s, { codes: ["accounting.journal.post"], roleCode: "post-journal" });
  granted.add(s);
}
```

and call `await ensurePostAuthority(db, s);` as the first statement of `postJournal`'s body, before it drafts the document.

- [ ] **Step 8: Run the migration and every affected suite**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test`
Expected: **PASS** — `document-status.test.ts` (12 tests) plus every 0A, 1A, 1B and 2A `packages/db` suite. Four failures worth naming in advance: an `ERR_DOC_STATUS_ILLEGAL: draft → approved` out of the R1 `ERR_SOD_NO_SUBMISSION` case means that case was written against `draft` rather than `draftAt(…, "submitted")` — R1 lives in block 2b and the matrix of block 2a has already refused the pair, so the SoD error is genuinely unreachable from a draft and the *test* is what moves, never the trigger; an `ERR_RBAC_FORBIDDEN` out of `posting/post.test.ts`, `posting/reverse.test.ts` or `posting/branch-required.test.ts` means Step 7 missed one of that file's seed objects — the nested `describe` in `reverse.test.ts` has its own `a`, and its producesType case has a local `b`; an `ERR_DOC_STATUS_ILLEGAL: issued → posted` out of `posting/issue.test.ts` means the matrix's `old.status = 'issued'` branch was written `new.status = 'posted'` only and dropped `'void'`; a failure in 0A's `documents.test.ts` on `/unique/` means the matrix wrongly evaluates a gate on `→ issued` (assumption 1 — that path must reach the unique constraint untouched).

Run: `bun run --cwd tests test`
Expected: PASS — 1B's four invariant suites go through `postJournal`, which now grants once per `Seed`, and 2A's `sah-013` block grants its own two seeds.

- [ ] **Step 9: Commit**

```bash
git add docs/adr/0029-document-state-machine-in-triggers.md \
        packages/db/migrations/0022_create_document_status_triggers.sql packages/db/migrations/0022.down.sql \
        packages/db/test/document-status.test.ts packages/db/test/fixtures.ts \
        packages/db/test/posting/post.test.ts packages/db/test/posting/reverse.test.ts \
        packages/db/test/posting/branch-required.test.ts tests/regression/sah-013.test.ts \
        tests/invariants/support/post-journal.ts
git commit -m "$(cat <<'EOF'
feat(db): the document state machine as two triggers on app.document [2B T2]

The legal-transition matrix, R1 (maker <> checker) and R2 (authority resolved
from the policy effective for the document's effective_date) all run in a BEFORE
UPDATE OF status trigger, and the AFTER trigger writes the document_event row
itself. So the API, a pg-boss job and psql as app_rw are governed identically —
which is what acceptance tests 10 and 31 demand and what SAH-032 lacked.

R2 makes posting an authorised act, so every existing call site that posted as
an ungranted principal now grants through the new grantCodes fixture helper —
ten seed objects across five files of 1A, 1B and 2A.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `packages/db/src/posting/lifecycle.ts`: `transitionDocument`, `recordOverride`, and three error rows

The TypeScript seam above the triggers. It does three things and no more: sets the two transaction settings the AFTER trigger reads, issues the UPDATE (or delegates to `issueDocument`, which owns the numbering), and returns the event the trigger wrote. Every rule stays in the database (ADR 0029). `recordOverride` is the one place in the codebase that inserts a `document_event` row directly, and the guard of Task 1 is what makes that safe.

**Files:**
- Create: `packages/db/src/posting/lifecycle.ts`, `packages/db/test/posting/lifecycle.test.ts`
- Modify: `packages/db/src/posting/index.ts` (re-export `./lifecycle`), `packages/db/src/posting/reverse.ts` (set the event reason before both status writes), `packages/contracts/src/errors.ts` (**three** rows — the slice's fourth, `ERR_DOC_NOT_DRAFT`, lands in Task 4 Step 9 with the migration that raises it)

**Interfaces:**
- Consumes: `type Sql` from `postgres`; `type TenantContext` from `../with-tenant`; `PostingError`, `type PostingErrorCode` from `./errors` (1A); `issueDocument`, `type IssueResult` from `./issue` (1A); `type DocumentStatus` from `./index` (1A); `app.document_event` and its guard (Task 1); the two triggers (Task 2); `ERRORS`, `type ErrorDef` from `@dulja/contracts`.
- Produces:
  - `export async function setEventContext(tx: Sql, input: { reason?: string | null; attributedTo?: string | null }): Promise<void>` — sets `app.event_reason` and `app.event_attributed_to` for the rest of the transaction.
  - `export async function transitionDocument(tx: Sql, ctx: TenantContext, input: { documentId: string; to: Exclude<DocumentStatus, "posted" | "void" | "reversed">; reason?: string; attributedTo?: string }): Promise<TransitionResult>` — contracts §4.3.1 verbatim.
  - `export interface TransitionResult { documentId: string; from: DocumentStatus; to: DocumentStatus; eventId: string; number?: bigint }` — contracts §4.3.1 verbatim.
  - `export type OverrideCode = "inventory.negative_stock.override" | "accounting.credit_limit.override" | "pos.ticket.override"` — contracts §4.3.1 verbatim.
  - `export async function recordOverride(tx: Sql, ctx: TenantContext, input: { documentId: string; code: OverrideCode; reason: string; attributedTo?: string }): Promise<{ eventId: string }>` — contracts §4.3.1 verbatim.
  - `export interface DocumentEventRow { id: string; eventKind: "transition" | "override"; fromStatus: DocumentStatus; toStatus: DocumentStatus; overrideCode: string | null; actorId: string; attributedTo: string | null; occurredAt: string; reason: string | null }` and `export async function listDocumentEvents(tx: Sql, documentId: string): Promise<DocumentEventRow[]>` — the read Task 8's `GET …/events` route serves. **A contract addition.**
  - **Three** new `ERRORS` rows: `ERR_SOD_NO_SUBMISSION` (409), `ERR_SOD_MAKER_IS_CHECKER` (409), `ERR_OVERRIDE_NOT_AUTHORISED` (409) — statuses and raisers exactly as contracts §4.2.4 allocates them. **`ERR_DOC_NOT_DRAFT` (409) is the slice's fourth and is deliberately not produced here:** its only raiser is Task 4's migration 0023, and `scripts/lint/rules/error-codes.ts` reports a catalogue row that no raiser mentions, so that row lands in **Task 4 Step 9** — the same commit as its migration (§4.2.4 allocates it to this slice either way).

- [ ] **Step 1: Write the failing test `packages/db/test/posting/lifecycle.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant as prodWithTenant } from "@dulja/db";
import {
  listDocumentEvents, recordOverride, setEventContext, transitionDocument,
} from "../../src/posting/lifecycle";
import { postDocument } from "../../src/posting";
import { grantCodes, seedTenantV2, startDb, uuidv7, withTenant, type Db, type Seed } from "../index";

describe("transitionDocument / recordOverride — contracts §4.3.1, §4.5.3", () => {
  let db: Db;
  let a: Seed;
  let supervisor: string;
  const ctx = (s: Seed, actorId?: string) => ({ tenantId: s.tenant, actorId: actorId ?? s.human, requestId: "req-2b" });

  const person = async (label: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${a.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
    });
    return id;
  };

  const draft = async (): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 25.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 25.0000)`;
    });
    return id;
  };

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    supervisor = await person("supervisor");
    await db.migrator`insert into app.permission (code, module, mutating, description)
      values ('accounting.credit_limit.override', 'accounting', true, 'test-local stand-in for 4A''s code')
      on conflict (code) do nothing`;
    await grantCodes(db, a, { principalId: supervisor, codes: ["accounting.credit_limit.override"] });
  });
  afterAll(async () => { await db.stop(); });

  it("moves draft → submitted and returns the event the trigger wrote", async () => {
    const d = await draft();
    const result = await prodWithTenant(db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: d, to: "submitted", reason: "for review" }));
    expect(result).toMatchObject({ documentId: d, from: "draft", to: "submitted" });
    expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.number).toBeUndefined();
    const events = await prodWithTenant(db.rw, ctx(a), (tx) => listDocumentEvents(tx, d));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventKind: "transition", fromStatus: "draft", toStatus: "submitted", reason: "for review", actorId: a.human });
  });

  it("to: 'issued' delegates to issueDocument and returns the number (contracts §4.3.1)", async () => {
    const d = await draft();
    const result = await prodWithTenant(db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: d, to: "issued" }));
    expect(result.from).toBe("draft");
    expect(result.to).toBe("issued");
    expect(typeof result.number).toBe("bigint");
    const [row] = await prodWithTenant(db.rw, ctx(a), (tx) =>
      tx<{ number: string; series: string }[]>`select number::text as number, series from app.document where id = ${d}`);
    expect(row!.number).toBe(String(result.number));
    expect(row!.series).toBe("JV");
  });

  it("carries attributedTo onto the event and clears both settings afterwards", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), async (tx) => {
      await transitionDocument(tx, ctx(a), { documentId: d, to: "submitted", reason: "till", attributedTo: supervisor });
      // a second, plain transition in the SAME transaction must not inherit the first one's reason
      await transitionDocument(tx, ctx(a), { documentId: d, to: "draft", reason: "recalculate" });
      await tx`update app.document set status = 'submitted' where id = ${d}`;
    });
    const events = await prodWithTenant(db.rw, ctx(a), (tx) => listDocumentEvents(tx, d));
    expect(events.map((e) => [e.toStatus, e.reason, e.attributedTo])).toEqual([
      ["submitted", "till", supervisor],
      ["draft", "recalculate", null],
      ["submitted", null, null],
    ]);
  });

  it("ERR_NOT_FOUND for a document the caller cannot see", async () => {
    const ghost = await uuidv7(db.admin);
    await expect(prodWithTenant(db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: ghost, to: "submitted" })),
    ).rejects.toMatchObject({ code: "ERR_NOT_FOUND" });
  });

  it("recordOverride writes an override event for a second principal, and refuses the creator", async () => {
    const d = await draft();
    const { eventId } = await prodWithTenant(db.rw, ctx(a, supervisor), (tx) =>
      recordOverride(tx, ctx(a, supervisor), {
        documentId: d, code: "accounting.credit_limit.override", reason: "customer is good for it",
      }));
    const events = await prodWithTenant(db.rw, ctx(a), (tx) => listDocumentEvents(tx, d));
    expect(events).toEqual([{
      id: eventId, eventKind: "override", fromStatus: "draft", toStatus: "draft",
      overrideCode: "accounting.credit_limit.override", actorId: supervisor, attributedTo: null,
      occurredAt: expect.any(String), reason: "customer is good for it",
    }]);

    await grantCodes(db, a, { codes: ["accounting.credit_limit.override"], roleCode: "self-override" });
    await expect(prodWithTenant(db.rw, ctx(a), (tx) =>
      recordOverride(tx, ctx(a), { documentId: d, code: "accounting.credit_limit.override", reason: "mine" })),
    ).rejects.toThrow(/ERR_OVERRIDE_NOT_AUTHORISED/);
  });

  it("voidDocument's event carries the void reason (spec:1745)", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: d }));
    const second = await draft();
    await prodWithTenant(db.rw, ctx(a), async (tx) => {
      await transitionDocument(tx, ctx(a), { documentId: second, to: "issued" });
    });
    const { voidDocument } = await import("../../src/posting");
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      voidDocument(tx, ctx(a), { documentId: second, reason: "printer jam; reissued" }));
    const events = await prodWithTenant(db.rw, ctx(a), (tx) => listDocumentEvents(tx, second));
    expect(events.at(-1)).toMatchObject({ toStatus: "void", reason: "printer jam; reissued" });
  });

  it("setEventContext is transaction-scoped: a new transaction starts with no reason", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) => setEventContext(tx, { reason: "leaked?" }));
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      tx`update app.document set status = 'submitted' where id = ${d}`);
    const events = await prodWithTenant(db.rw, ctx(a), (tx) => listDocumentEvents(tx, d));
    expect(events[0]!.reason).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/posting/lifecycle.test.ts`
Expected: FAIL — `Cannot find module '../../src/posting/lifecycle'`.

- [ ] **Step 3: Write `packages/db/src/posting/lifecycle.ts`**

```ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { PostingError } from "./errors";
import { issueDocument } from "./issue";
import type { DocumentStatus } from "./index";

/**
 * The two transaction settings `app.document_status_after()` reads (contracts §4.5.2). They are the convention
 * for spec:2172's "reason from a transaction setting": `set_config(…, true)` is transaction-local, so the value
 * dies with the transaction and can never leak into the next request on a pooled connection.
 *
 * Both are always written, never only one — otherwise a second transition in the same transaction would
 * silently inherit the first one's reason.
 */
export async function setEventContext(
  tx: Sql,
  input: { reason?: string | null; attributedTo?: string | null },
): Promise<void> {
  await tx`select set_config('app.event_reason', ${input.reason ?? ""}, true),
                  set_config('app.event_attributed_to', ${input.attributedTo ?? ""}, true)`;
}

export interface TransitionResult {
  documentId: string;
  from: DocumentStatus;
  to: DocumentStatus;
  eventId: string;
  number?: bigint;
}

/**
 * Every status change other than post, void and reverse (contracts §4.5.4). It performs no check of its own:
 * the BEFORE UPDATE OF status trigger applies the matrix, R1 and R2, and the AFTER trigger writes the event
 * (ADR 0029). `to: "issued"` delegates to `issueDocument`, which owns the advisory lock and the numbering
 * (contracts §4.3.6) — a bare `update … set status = 'issued'` would leave the document numberless.
 *
 * Throws `ERR_NOT_FOUND` when the document is invisible under RLS; every other failure arrives as a Postgres
 * error carrying an `ERR_*` token, which `apps/api`'s `fromDatabaseError` maps to the wire `Problem`.
 */
export async function transitionDocument(
  tx: Sql,
  ctx: TenantContext,
  input: {
    documentId: string;
    to: Exclude<DocumentStatus, "posted" | "void" | "reversed">;
    reason?: string;
    attributedTo?: string;
  },
): Promise<TransitionResult> {
  const [before] = await tx<{ status: DocumentStatus }[]>`
    select status::text as status from app.document where id = ${input.documentId} for update`;
  if (!before) throw new PostingError("ERR_NOT_FOUND", `no document ${input.documentId} in this tenant`);

  await setEventContext(tx, { reason: input.reason ?? null, attributedTo: input.attributedTo ?? null });

  let number: bigint | undefined;
  if (input.to === "issued") {
    ({ number } = await issueDocument(tx, ctx, { documentId: input.documentId }));
  } else {
    await tx`update app.document set status = ${input.to}::app.document_status where id = ${input.documentId}`;
  }

  // uuidv7 is time-ordered, so `order by id desc` is the insertion order — `occurred_at` cannot be, because
  // now() is the transaction start and every event written in one transaction shares it.
  const [event] = await tx<{ id: string }[]>`
    select id from app.document_event
     where document_id = ${input.documentId} and event_kind = 'transition'
     order by id desc limit 1`;
  if (!event) {
    throw new PostingError("ERR_DOC_STATUS_ILLEGAL", `document ${input.documentId} recorded no transition event`);
  }

  // Cleared so a later statement in the same transaction cannot inherit this reason.
  await setEventContext(tx, {});

  return {
    documentId: input.documentId,
    from: before.status,
    to: input.to,
    eventId: event.id,
    ...(number === undefined ? {} : { number }),
  };
}

/** contracts §4.3.1. The three codes the system will ever put on an override event. */
export type OverrideCode =
  | "inventory.negative_stock.override"
  | "accounting.credit_limit.override"
  | "pos.ticket.override";

/**
 * The override door (contracts §4.5.3, R8 spec:2179). This is the ONE place in the codebase that inserts a
 * `document_event` row directly; `document_event_override_guard` is what makes that safe — it refuses the row
 * unless `attributed_to ?? actor_id` holds `code` at the document's branch and is neither the document's
 * `created_by` nor its `attributed_to` (SAH-027, SAH-048).
 *
 * Back office: `attributedTo` is omitted and the acting principal is the second principal. POS (6C): the
 * terminal acts and `attributedTo` is the supervisor whose PIN authorised it (spec:1324, hazard 19).
 */
export async function recordOverride(
  tx: Sql,
  ctx: TenantContext,
  input: { documentId: string; code: OverrideCode; reason: string; attributedTo?: string },
): Promise<{ eventId: string }> {
  const [doc] = await tx<{ id: string }[]>`select id from app.document where id = ${input.documentId}`;
  if (!doc) throw new PostingError("ERR_NOT_FOUND", `no document ${input.documentId} in this tenant`);

  const [row] = await tx<{ id: string }[]>`
    insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status,
                                    override_code, attributed_to, reason)
    select ${ctx.tenantId}, d.company_id, d.id, 'override', d.status, d.status,
           ${input.code}, ${input.attributedTo ?? null}, ${input.reason}
      from app.document d where d.id = ${input.documentId}
    returning id`;
  return { eventId: row!.id };
}

export interface DocumentEventRow {
  id: string;
  eventKind: "transition" | "override";
  fromStatus: DocumentStatus;
  toStatus: DocumentStatus;
  overrideCode: string | null;
  actorId: string;
  attributedTo: string | null;
  occurredAt: string;
  reason: string | null;
}

/** The document's timeline, oldest first. Ordered by `id` for the reason `transitionDocument` gives above. */
export async function listDocumentEvents(tx: Sql, documentId: string): Promise<DocumentEventRow[]> {
  return tx<DocumentEventRow[]>`
    select id,
           event_kind                                as "eventKind",
           from_status::text                         as "fromStatus",
           to_status::text                           as "toStatus",
           override_code                             as "overrideCode",
           actor_id                                  as "actorId",
           attributed_to                             as "attributedTo",
           to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "occurredAt",
           reason
      from app.document_event
     where document_id = ${documentId}
     order by id`;
}
```

- [ ] **Step 4: Re-export from `packages/db/src/posting/index.ts` and set the reason in `reverse.ts`**

In `packages/db/src/posting/index.ts`, add beside the existing `export * from "./reverse";`:

```ts
export * from "./lifecycle";
```

In `packages/db/src/posting/reverse.ts`, add the import and one call before each of the two status writes, so the events the AFTER trigger writes carry the operator's reason instead of a null:

```ts
import { setEventContext } from "./lifecycle";
```

In `reverseDocument`, immediately before `await tx`update app.document set status = 'reversed' where id = ${input.documentId}`;`:

```ts
  await setEventContext(tx, { reason: `Reversed by ${definition.reversal.producesType} ${posted.number}: ${input.reason}` });
```

In `voidDocument`, immediately before `await tx`update app.document set status = 'void' where id = ${input.documentId}`;`:

```ts
  await setEventContext(tx, { reason: input.reason });
```

- [ ] **Step 5: Add three rows to `packages/contracts/src/errors.ts`**

Inside the `ERRORS` object literal, in the order contracts §4.2.4 lists them:

```ts
  ERR_SOD_NO_SUBMISSION:       { status: 409, title: "No submission to check",        remedy: "Submit the document first; a type whose policy requires approval needs a maker before a checker (spec:2172)" },
  ERR_SOD_MAKER_IS_CHECKER:    { status: 409, title: "Maker cannot be checker",       remedy: "Ask a different principal to approve or post; the submitter of a document may never approve or post it (spec:2172)" },
  ERR_OVERRIDE_NOT_AUTHORISED: { status: 409, title: "Override not authorised",       remedy: "An override must be recorded by a second principal who holds the override permission at the document's branch (spec:2179)" },
```

All three are already raised as string literals inside `packages/db/migrations/0021_create_document_event.sql` and `0022_create_document_status_triggers.sql`, both of which are applied by the time this step runs, so `scripts/lint/rules/error-codes.ts` (which scans `packages/db/migrations/**` as well as source) is **green at this commit**. **The slice's fourth row, `ERR_DOC_NOT_DRAFT`, is deliberately not here:** its only raiser is Task 4's migration 0023, and a catalogue row with no raiser is exactly what that rule reports, so the row lands in Task 4 Step 9 — in the same commit as the migration that raises it. Nothing in this slice forces a red `bun run lint` between tasks 3 and 4.

- [ ] **Step 6: Run the tests**

Run: `bun run --cwd packages/db test -- test/posting/lifecycle.test.ts`
Expected: **PASS** (7 tests). Two failures worth naming in advance: if the third case reports `["submitted", "till", supervisor], ["draft", "till", supervisor], …` the final `setEventContext(tx, {})` is missing — the settings are transaction-scoped and must be cleared, not merely re-set; if the `to: "issued"` case returns `number: undefined`, `transitionDocument` is writing the status itself instead of calling `issueDocument`.

Run: `bun run --cwd packages/contracts typecheck && bun run --cwd packages/db typecheck`
Expected: PASS.

Run: `bun run lint`
Expected: **PASS** — the three rows added in Step 5 are each raised as a token in migration 0021 or 0022, both already applied. A finding naming `ERR_DOC_NOT_DRAFT` means that row was added here instead of in Task 4 Step 9, where its raiser lands.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/posting/lifecycle.ts packages/db/src/posting/index.ts packages/db/src/posting/reverse.ts \
        packages/db/test/posting/lifecycle.test.ts packages/contracts/src/errors.ts
git commit -m "$(cat <<'EOF'
feat(db): transitionDocument, recordOverride and the document event reader [2B T3]

The thin seam above the triggers: it sets the two transaction settings the AFTER
trigger reads, issues the UPDATE (delegating to issueDocument for `issued`, which
owns the numbering lock), and returns the event the trigger wrote. No rule lives
here. recordOverride is the only direct insert into document_event anywhere, and
the BEFORE INSERT guard of migration 0021 is what makes it safe.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: ADR 0030 and migration `0023_grant_document_draft_delete_and_add_series_gaps.sql`

Two halves of one guarantee. spec:2049 admits genuine deletion in exactly two cases — "for drafts and for the GDPR/PDPA erasure workflow, and both write an audit row first" — and contracts §3.5.4 records that **2B is the only slice that ever extends the pinned DELETE list**. spec:2222 wants numbering "gapless-provable" and spec:2224 forbids deleting a posted document at any privilege level. `app.series_gaps` is what turns "provable" into a query: every number in `[1, next_number)` that is neither an issued document nor a recorded void. The two guards are what keep the answer honest — a deletable issued document would empty the function's result by removing the evidence.

The file name extends the card's expected `0023_grant_document_draft_delete.sql` because §3.4.2 requires the name to say what the file does and this file also creates a function; the precedent is 2A's `0018_alter_document_party_fk_and_document_type_module.sql`.

**Files:**
- Create: `docs/adr/0030-gapless-numbering-and-draft-deletion.md`, `packages/db/migrations/0023_grant_document_draft_delete_and_add_series_gaps.sql`, `packages/db/migrations/0023.down.sql`, `packages/db/src/integrity/series-gaps.ts`, `packages/db/test/document-delete.test.ts`
- Modify: `packages/db/src/integrity/index.ts` (register the check), `packages/db/src/index.ts` (re-export `SERIES_GAP_CHECK`), `packages/db/test/privileges.test.ts` (the pinned DELETE list), `packages/contracts/src/errors.ts` (the `ERR_DOC_NOT_DRAFT` row, Step 9 — it lands with its raiser), `tests/invariants/audit-chain.test.ts` (1B's pinned `projections.checked` array gains `document_series`, Step 7)

**Interfaces:**
- Consumes: `app.document`, `app.document_line`, `app.document_series`, `app.document_number_void` (plan0A migration 0001); `app_meta.attach_audit`'s AFTER DELETE half — `app.audit_row()` is already attached to both tables by 0001 and 1A and fires on DELETE with the before-image (spec:2049); `type ProjectionCheck`, `type ProjectionMismatch`, `registerProjectionCheck` from `../integrity/types` and `../integrity/projections` (1B); `grantCodes`, `seedDocumentType`, `seedTenantV2`, `startDb`, `uuidv7`, `withTenant` from `@dulja/db/test`; `postDocument`, `voidDocument`, `transitionDocument` from `@dulja/db`.
- Produces:
  - `grant delete on app.document, app.document_line to app_rw` — the second and final row of contracts §3.5.4.
  - `app.forbid_delete_unless_draft() returns trigger` and the trigger `document_delete_draft_only before delete on app.document for each row`, raising `ERR_DOC_NOT_DRAFT`.
  - `app.forbid_line_delete_unless_draft() returns trigger` and the trigger `document_line_delete_draft_only before delete on app.document_line for each row`, raising `ERR_DOC_NOT_DRAFT`. **A contract addition** — §3.5.4 grants DELETE on `document_line` and names only the parent's guard; without the child's, `app_rw` could delete the lines of a posted document one row at a time.
  - `app.series_gaps(p_company uuid, p_series text, p_period uuid) returns table (number bigint)` — contracts §4.5.5 verbatim.
  - `export const SERIES_GAP_CHECK: ProjectionCheck` in `packages/db/src/integrity/series-gaps.ts`, registered in `packages/db/src/integrity/index.ts` beside 1B's `ACCOUNT_BALANCE_CHECK`. **A contract addition** — §4.16.3 names 3A and 8C as the registry's extenders and this is a third.
  - The `ERR_DOC_NOT_DRAFT` row in `ERRORS` (§4.2.4, already allocated by name in this plan's assumptions) — added in Step 9, in the same commit as the migration that raises it.

- [ ] **Step 1: Write `docs/adr/0030-gapless-numbering-and-draft-deletion.md`**

```markdown
# ADR 0030 — Gaplessness is proved by a function, and drafts are the one thing app_rw may delete

**Status:** Proposed (spec:95 — this touches the data model and the privilege surface)
**Date:** 2026-09-05
**Slice:** 2B
**Supersedes:** nothing. **Superseded by:** nothing.

## Context

The Phase 2 definition of done (spec:2288) reads "issued numbers are unique and **gapless-provable**", and
spec:2222 spells out the mechanism: "assigned at *issue*, per (series, period), unique-constrained,
gapless-provable, with voided numbers explicitly recorded (SAH-051)". Uniqueness is already a constraint
(`unique (company_id, series, fiscal_period_id, number)`, plan0A). *Provable* is not: nothing in the schema
answers "is there a number this series issued that no document and no void explains?"

SAH-051 is the legacy numbering: a race on first use, no uniqueness constraint, and no way to demonstrate
gaplessness. spec:2224 adds the other half — "No deletion of posted documents at any privilege level" — because
a system that can delete an issued document can make any gap disappear.

spec:2049 nevertheless admits deletion "for drafts and for the GDPR/PDPA erasure workflow, and both write an
audit row first", and contracts §3.5.4 pins the `app_rw` DELETE list, which after Plan 0A holds
`idempotency_key`, `role_permission` and `role_assignment_branch`. **This slice is the only one that ever
extends it** (contracts hazard 25).

Three ways to prove gaplessness were considered.

1. **A materialised gap table maintained by the posting service.** Rejected: a projection of a projection, and
   the thing it would prove is exactly what a bug in it would hide.
2. **A nightly job that walks every series in application code.** Rejected on the same ground the trial balance
   is read from `account_balance` rather than recomputed (contracts §4.16.3): the check must be expressible in
   one statement a human can read.
3. **A set-returning SQL function, evaluated on demand and by the nightly integrity job.** Chosen.

## Decision

- `app.series_gaps(company, series, period)` returns every `n` in `[1, document_series.next_number)` for which
  there is neither a `document` row with that number nor a `document_number_void` row. **Zero rows for every
  (company, series, period) is the definition-of-done proof.** It is `stable` and runs under the caller's RLS,
  so a tenant can only ever prove its own numbering.
- `SERIES_GAP_CHECK` registers with 1B's `registerProjectionCheck`, so the nightly
  `accounting.ledger.integrity_check` reports a non-empty result as a mismatch and the incident path 1B built
  handles it. It reports `projection: "document_series"` and `side: "missing_in_projection"` — the reading
  being that the counter has advanced past a number the document set does not explain.
- `app_rw` gains DELETE on `app.document` and `app.document_line`, guarded by two BEFORE DELETE triggers that
  raise `ERR_DOC_NOT_DRAFT` for anything but a draft. The `audit_row` AFTER DELETE trigger already attached to
  both tables supplies spec:2049's "writes an audit row first".
- The **child** guard refuses only when a non-draft parent is *visible*. A cascade from a deleted parent leaves
  no parent row to see, and that parent's own guard already proved it was a draft; a direct
  `delete from app.document_line where document_id = <a posted document>` sees the parent and is refused.
- No other table ever gains DELETE. Everything else is archived with `archived_at` (contracts §4.11.2).

## Consequences

- Acceptance test 16's three clauses become runnable: concurrent first documents both succeed (the advisory
  lock of contracts §4.3.6), issued numbers are unique (the constraint), and deletion of an issued document is
  impossible (the guard) — through the API, through a job and through direct `app_rw` SQL.
- A voided number stays a *recorded* gap, not a hole: `voidDocument` writes `document_number_void` in the same
  transaction as the status change (spec:1745), so `series_gaps` sees it as explained.
- The nightly job gains one query per `(company, series, period)` counter row. Counters are per period, so the
  cardinality is small and bounded by the number of series a company uses.
- **A known limit of this decision, recorded here rather than discovered later:** the DELETE grant reaches only
  a draft that carries **no** `document_event` row. `app.document_event`'s foreign key to `app.document`
  (contracts §4.5.2) declares no on-delete action and the table is immutable to `app_rw`, so a draft that was
  submitted and returned to draft — or that received an override — cannot be deleted at all: the statement
  fails with SQLSTATE 23503 and the caller sees `ERR_CONFLICT_REFERENCE`, not `ERR_DOC_NOT_DRAFT` and not
  success. `packages/db/test/document-delete.test.ts` pins that behaviour so it is visible in CI. It is not
  what spec:2049 intends for "deletion for drafts", but the foreign key is contracts-verbatim and the two
  candidate fixes both touch how the record of a deleted document is kept, so it is reported as question 3 of
  Task 12 Step 1 — where it is already on the record as contracts §4.18 open item 4, so that step verifies it
  rather than files it — and not decided here (hazard 7). The slice that applies the answer replaces this
  pinning test.
- **Recorded for a later amendment:** `IntegrityReport` (1B, contracts §4.16.3) has no `numberingGaps` member,
  so a gap is reported through `ProjectionMismatch`. A dedicated member would read better; changing the
  interface is a contracts-document change, not a plan change (hazard 7).
```

- [ ] **Step 2: Write the failing test `packages/db/test/document-delete.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant as prodWithTenant } from "@dulja/db";
import { postDocument, transitionDocument, voidDocument } from "../src/posting";
import { grantCodes, seedDocumentType, seedTenantV2, startDb, uuidv7, withTenant, type Db, type Seed } from "./index";

describe("draft-only deletion and app.series_gaps — spec:2049, 2222, 2224 (SAH-041, SAH-051)", () => {
  let db: Db;
  let a: Seed;
  let gapType: string;                     // a type whose policy numbers into series "GAP"
  const ctx = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: "req-delete" });

  /**
   * A type whose ONLY difference from JOURNAL is the series it numbers into. The series on the header is not
   * the series the document ends up in: `issueDocument` writes `policy.numbering.series` back onto the row
   * (contracts §4.3.6, "the series comes from `policy.numbering.series`"), so a header written with 'GAP'
   * against `a.docType` would still be numbered into 'JV' and every `series_gaps('GAP', …)` assertion would
   * pass for the wrong reason. Already registered in contracts §4.14 as the test-only document-type code
   * `GAP_TEST`; Task 12 Step 1 verifies that row is present rather than adding it.
   */
  const GAP_POLICY = {
    version: 1, documentType: "GAP_TEST", direction: "internal", requires: [],
    lines: [
      { for: "each_line", side: "debit", account: { from: "line.account" }, amount: "line.debit", when: { "line.kind": "account" } },
      { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
    ],
    inventory: { effect: "none" }, tax: { applies: false },
    numbering: { series: "GAP", assignAt: "issue" },
    reversal: { allowed: true, producesType: "GAP_TEST" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    dimensions: { required: [] },
  };

  const draft = async (typeId?: string, series = "JV"): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId ?? a.docType}, ${series}, '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 5.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 5.0000)`;
    });
    return id;
  };

  const gaps = (series: string) =>
    prodWithTenant(db.rw, ctx(a), (tx) => tx<{ number: string }[]>`
      select number::text as number from app.series_gaps(${a.company}, ${series}, ${a.period}) order by 1`);

  /** The counter row itself, so a "no gaps" assertion can be shown not to be vacuous. */
  const counter = (series: string) =>
    prodWithTenant(db.rw, ctx(a), (tx) => tx<{ next_number: string }[]>`
      select next_number::text as next_number from app.document_series
       where company_id = ${a.company} and series = ${series} and fiscal_period_id = ${a.period}`);

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    // effectiveFrom is passed explicitly: seedDocumentType's default is 2A's and app.effective_policy must
    // pick this row for the 2026-01-15 documents below (hazard 9 — the helper is never edited).
    gapType = await seedDocumentType(db, a, { code: "GAP_TEST", policy: GAP_POLICY, effectiveFrom: "2026-01-01" });
  });
  afterAll(async () => { await db.stop(); });

  it("app_rw holds DELETE on exactly five tables — the contracts §3.5.4 list after 0023", async () => {
    const rows = await db.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app'
         and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') order by 1, 2`;
    expect(rows).toEqual([
      { table_name: "document", privilege_type: "DELETE" },
      { table_name: "document_line", privilege_type: "DELETE" },
      { table_name: "idempotency_key", privilege_type: "DELETE" },
      { table_name: "role_assignment_branch", privilege_type: "DELETE" },
      { table_name: "role_permission", privilege_type: "DELETE" },
    ]);
  });

  it("a draft is deletable, its lines cascade, and the audit log keeps the before-image (spec:2049)", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) => tx`delete from app.document where id = ${d}`);
    const [left] = await prodWithTenant(db.rw, ctx(a), (tx) =>
      tx<{ docs: number; lines: number }[]>`
        select (select count(*)::int from app.document where id = ${d}) as docs,
               (select count(*)::int from app.document_line where document_id = ${d}) as lines`);
    expect(left).toEqual({ docs: 0, lines: 0 });
    const [audited] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where table_name = 'document' and operation = 'DELETE' and before ->> 'id' = ${d}`;
    expect(audited!.n).toBe(1);
  });

  it("an issued document cannot be deleted — the third clause of acceptance test 16", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) => transitionDocument(tx, ctx(a), { documentId: d, to: "issued" }));
    await expect(prodWithTenant(db.rw, ctx(a), (tx) => tx`delete from app.document where id = ${d}`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is issued/);
  });

  it("a posted document cannot be deleted, and neither can one of its lines (spec:2224)", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: d }));
    await expect(prodWithTenant(db.rw, ctx(a), (tx) => tx`delete from app.document where id = ${d}`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is posted/);
    await expect(prodWithTenant(db.rw, ctx(a), (tx) =>
      tx`delete from app.document_line where document_id = ${d} and line_no = 1`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT: document .* is posted/);
  });

  it("a draft's individual line may be deleted", async () => {
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      tx`delete from app.document_line where document_id = ${d} and line_no = 2`);
    const [n] = await prodWithTenant(db.rw, ctx(a), (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.document_line where document_id = ${d}`);
    expect(n!.n).toBe(1);
  });

  it("a draft that already carries a document_event cannot be deleted — the open question of Task 12 Step 1", async () => {
    // contracts §4.5.2 declares `foreign key (tenant_id, document_id) references app.document(tenant_id, id)`
    // on app.document_event with NO on-delete action, and the table is immutable to app_rw. So a draft that
    // has been round-tripped (draft → submitted → draft, the recalculation edge of spec:2081) or that has
    // received an override carries rows the parent DELETE cannot clear, and the delete fails with SQLSTATE
    // 23503 — surfaced by the route of Task 8 as ERR_CONFLICT_REFERENCE, not as ERR_DOC_NOT_DRAFT and not as
    // a success. This case PINS that behaviour so it is visible rather than latent; it is not the behaviour
    // spec:2049 wants, and the FK is contracts-verbatim, so 2B does not change it unilaterally. Task 12
    // Step 1 carries it upward as a question with two proposed shapes. When the answer lands, the slice that
    // applies it replaces this case.
    const d = await draft();
    await prodWithTenant(db.rw, ctx(a), (tx) => transitionDocument(tx, ctx(a), { documentId: d, to: "submitted", reason: "for review" }));
    await prodWithTenant(db.rw, ctx(a), (tx) => transitionDocument(tx, ctx(a), { documentId: d, to: "draft", reason: "figures changed" }));
    const [events] = await prodWithTenant(db.rw, ctx(a), (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.document_event where document_id = ${d}`);
    expect(events!.n).toBe(2);
    const [status] = await prodWithTenant(db.rw, ctx(a), (tx) =>
      tx<{ status: string }[]>`select status::text as status from app.document where id = ${d}`);
    expect(status!.status).toBe("draft");          // the draft-only guard would admit it

    // The regex admits both spellings for the same reason Task 1's immutability case does: the raw PG text
    // when the driver error surfaces unwrapped, and the code `fromDatabaseError` maps SQLSTATE 23503 to
    // (0B, §4.2.4) if it is translated on the way out.
    await expect(prodWithTenant(db.rw, ctx(a), (tx) => tx`delete from app.document where id = ${d}`))
      .rejects.toThrow(/violates foreign key constraint|ERR_CONFLICT_REFERENCE/);
  });

  it("series_gaps is empty for a clean series and stays empty when a number is voided", async () => {
    const first = await draft(gapType, "GAP");
    const second = await draft(gapType, "GAP");
    await prodWithTenant(db.rw, ctx(a), (tx) => transitionDocument(tx, ctx(a), { documentId: first, to: "issued" }));
    await prodWithTenant(db.rw, ctx(a), (tx) => transitionDocument(tx, ctx(a), { documentId: second, to: "issued" }));

    // The non-vacuity guard: series_gaps returns zero rows for a counter that does not exist, so the two
    // assertions below would pass on an empty database. This one proves the counter really advanced to 3,
    // which means [1, 3) is a range series_gaps actually walks.
    expect((await counter("GAP")).map((r) => r.next_number)).toEqual(["3"]);
    const [numbers] = await prodWithTenant(db.rw, ctx(a), (tx) => tx<{ ns: string }[]>`
      select string_agg(number::text, ',' order by number) as ns from app.document
       where company_id = ${a.company} and series = 'GAP' and fiscal_period_id = ${a.period}`);
    expect(numbers!.ns).toBe("1,2");

    expect(await gaps("GAP")).toEqual([]);
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      voidDocument(tx, ctx(a), { documentId: second, reason: "printer jam; reissued" }));
    // Two separate facts, and the comment says which assertion carries which, because it is easy to claim
    // more here than the test proves. (a) The void RECORD exists — that is the `voided.n === 1` assertion,
    // and it is the "voided numbers are recorded" clause of acceptance test 16. (b) The series is still
    // whole. It is NOT (b) that proves (a) explains it: `voidDocument` updates only `status` (1a:3657) and
    // leaves `document.number` in place, so number 2 is still excluded by series_gaps' FIRST predicate — the
    // one about documents — and this assertion would read empty with an empty document_number_void. The
    // void row's own effect on series_gaps is isolated in the next case, where no document exists at all.
    const [voided] = await prodWithTenant(db.rw, ctx(a), (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_number_void
       where company_id = ${a.company} and series = 'GAP' and fiscal_period_id = ${a.period} and number = 2`);
    expect(voided!.n).toBe(1);
    expect(await gaps("GAP")).toEqual([]);
  });

  it("a recorded void is what explains a number: series_gaps skips the voided one and names its neighbour", async () => {
    // The isolation the case above cannot give: a series with NO document at all, a counter advanced past 1
    // and 2, and exactly one of the two recorded as voided. The void row is now the only possible
    // explanation for number 1, so the assertion bites — drop the `document_number_void` predicate from
    // app.series_gaps and this returns ["1", "2"].
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.document_series (tenant_id, company_id, series, fiscal_period_id, next_number)
               values (${a.tenant}, ${a.company}, 'VOIDONLY', ${a.period}, 3)`;
      await tx`insert into app.document_number_void (tenant_id, company_id, series, fiscal_period_id, number, reason)
               values (${a.tenant}, ${a.company}, 'VOIDONLY', ${a.period}, 1, 'recorded void with no surviving document')`;
    });
    expect((await gaps("VOIDONLY")).map((r) => r.number)).toEqual(["2"]);
  });

  it("series_gaps names the number when the counter has advanced past an unexplained one", async () => {
    // The only way to manufacture one is to advance the counter as the migrator without issuing — exactly the
    // shape a bug in the posting service would produce, which is what the nightly job must catch.
    await withTenant(db.migrator, a.tenant, a.system, (tx) => tx`
      insert into app.document_series (tenant_id, company_id, series, fiscal_period_id, next_number)
      values (${a.tenant}, ${a.company}, 'HOLE', ${a.period}, 4)`);
    expect((await gaps("HOLE")).map((r) => r.number)).toEqual(["1", "2", "3"]);
  });

  it("series_gaps is tenant-scoped: another tenant's counters are invisible", async () => {
    const b = await seedTenantV2(db, "Beta");
    const rows = await prodWithTenant(db.rw, { tenantId: b.tenant, actorId: b.human, requestId: "r" }, (tx) =>
      tx<{ number: string }[]>`select number::text as number from app.series_gaps(${a.company}, 'HOLE', ${a.period})`);
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/document-delete.test.ts`
Expected: FAIL — the first case reports only the three Plan 0A rows, and every later case errors with `permission denied for table document` or `function app.series_gaps(uuid, unknown, uuid) does not exist`.

- [ ] **Step 4: Write `packages/db/migrations/0023_grant_document_draft_delete_and_add_series_gaps.sql`**

```sql
-- 0023_grant_document_draft_delete_and_add_series_gaps.sql ────────────────────
-- Two halves of one guarantee (ADR 0030).
--   (a) spec:2049 admits genuine deletion for drafts, and both cases "write an audit row first";
--       spec:2224 forbids deleting a posted document at any privilege level (SAH-041).
--   (b) spec:2222 wants numbering gapless-PROVABLE, and spec:2288 makes that the Phase 2 definition of done.
-- The DELETE grant below is the ONE extension of the pinned app_rw DELETE list in the whole of v1
-- (contracts §3.5.4); every other table is archived with archived_at.

-- ── 1. the guards, created BEFORE the grant so no window exists in which DELETE is unguarded ──────────────
create function app.forbid_delete_unless_draft() returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: document % is %; an issued document is voided and a posted one is reversed (spec:2049, 2224)',
      old.id, old.status using errcode = 'check_violation';
  end if;
  return old;
end $$;

create trigger document_delete_draft_only before delete on app.document
  for each row execute function app.forbid_delete_unless_draft();

-- The child guard. document_line cascades from document (the composite FK is ON DELETE CASCADE, 1A migration
-- 0011), and during a cascade the parent row is already gone — so the guard refuses only when a NON-DRAFT
-- parent is still visible. That is exactly the direct `delete from app.document_line where document_id = <a
-- posted document>` case, which the grant below would otherwise permit one row at a time.
create function app.forbid_line_delete_unless_draft() returns trigger language plpgsql as $$
declare
  v_status app.document_status;
begin
  select d.status into v_status from app.document d where d.id = old.document_id;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: document % is %; its lines cannot be deleted (spec:2224)',
      old.document_id, v_status using errcode = 'check_violation';
  end if;
  return old;
end $$;

create trigger document_line_delete_draft_only before delete on app.document_line
  for each row execute function app.forbid_line_delete_unless_draft();

-- ── 2. the grant (contracts §3.5.4 row two — the only one this system ever adds) ──────────────────────────
-- app.audit_row() is already attached to both tables and fires AFTER DELETE with the before-image, which is
-- spec:2049's "both write an audit row first". No flag can suppress it (SAH-030).
grant delete on app.document, app.document_line to app_rw;

-- ── 3. the gapless proof (contracts §4.5.5; spec:2222, 2288) ──────────────────────────────────────────────
-- Every number the counter has issued that is neither a document nor a recorded void. Zero rows for every
-- (company, series, period) is the definition-of-done proof; the 1B integrity job reports any non-empty result.
-- `stable` and unqualified reads, so it runs under the caller's RLS and proves only the caller's tenancy.
create function app.series_gaps(p_company uuid, p_series text, p_period uuid)
returns table (number bigint) language sql stable as $$
  select g.n from app.document_series s
  cross join lateral generate_series(1, s.next_number - 1) as g(n)
  where s.company_id = p_company and s.series = p_series and s.fiscal_period_id = p_period
    and not exists (select 1 from app.document d
                     where d.company_id = p_company and d.series = p_series
                       and d.fiscal_period_id = p_period and d.number = g.n)
    and not exists (select 1 from app.document_number_void v
                     where v.company_id = p_company and v.series = p_series
                       and v.fiscal_period_id = p_period and v.number = g.n)
$$;
```

- [ ] **Step 5: Write `packages/db/migrations/0023.down.sql`**

```sql
-- 0023.down.sql ───────────────────────────────────────────────────────────────
drop function if exists app.series_gaps(uuid, text, uuid);
revoke delete on app.document, app.document_line from app_rw;
drop function if exists app.forbid_line_delete_unless_draft() cascade;
drop function if exists app.forbid_delete_unless_draft() cascade;
```

- [ ] **Step 6: Write `packages/db/src/integrity/series-gaps.ts`**

```ts
import type { Sql } from "postgres";
import type { ProjectionCheck, ProjectionMismatch } from "./types";

/**
 * The numbering half of the nightly integrity run (contracts §4.5.5: "the 1B integrity job reports any
 * non-empty result"; ADR 0030). It walks every counter the tenant owns and asks `app.series_gaps` for the
 * numbers the counter has advanced past that no document and no void explains.
 *
 * It reports through `ProjectionMismatch` because that is the shape `registerProjectionCheck` accepts:
 * `projection` is the counter table, and `missing_in_projection` reads as "the number is missing from the set
 * of documents and voids that should explain it". A dedicated `numberingGaps` member on `IntegrityReport`
 * would read better and is recorded in ADR 0030 as a later amendment to contracts §4.16.3.
 */
export const SERIES_GAP_CHECK: ProjectionCheck = {
  name: "document_series",
  async run(tx: Sql): Promise<ProjectionMismatch[]> {
    const counters = await tx<{ company_id: string; series: string; fiscal_period_id: string }[]>`
      select company_id, series, fiscal_period_id from app.document_series
       order by company_id, series, fiscal_period_id`;
    const mismatches: ProjectionMismatch[] = [];
    for (const c of counters) {
      const gaps = await tx<{ number: string }[]>`
        select number::text as number
          from app.series_gaps(${c.company_id}, ${c.series}, ${c.fiscal_period_id}) order by 1`;
      for (const g of gaps) {
        mismatches.push({
          projection: "document_series",
          key: {
            company_id: c.company_id,
            series: c.series,
            fiscal_period_id: c.fiscal_period_id,
            number: g.number,
          },
          side: "missing_in_projection",
          detail: `number ${g.number} of series ${c.series} is neither an issued document nor a recorded void (spec:2222, SAH-051)`,
        });
      }
    }
    return mismatches;
  },
};
```

- [ ] **Step 7: Register the check and re-export it**

In `packages/db/src/integrity/index.ts`, beside 1B's registration:

```ts
import { SERIES_GAP_CHECK } from "./series-gaps";
// … below `registerProjectionCheck(ACCOUNT_BALANCE_CHECK);`
registerProjectionCheck(SERIES_GAP_CHECK);
```

and add to the same file's re-export list:

```ts
export { SERIES_GAP_CHECK } from "./series-gaps";
```

In `packages/db/src/index.ts`, add `SERIES_GAP_CHECK` to the existing `export { … } from "./integrity";` list.

**And update the one pinned assertion this registration breaks.** `registerProjectionCheck` appends to a module-level registry, so `IntegrityReport.projections.checked` becomes `["account_balance", "document_series"]` for every caller. **The one file that pins it is 1B's and lives in the `tests` workspace**, which is what makes it easy to miss from `packages/db`:

`tests/invariants/audit-chain.test.ts` (1B, its case *"reports 'no postings' for a tenant with an empty ledger"*): change the one line

```ts
    expect(report.projections.checked).toEqual(["account_balance"]);
```

  to

```ts
    // 2B registers SERIES_GAP_CHECK beside 1B's ACCOUNT_BALANCE_CHECK (contracts §4.16.3); registration order
    // is the array's order. An empty-ledger tenant has no counters either, so `ok` and `summary` are unchanged.
    expect(report.projections.checked).toEqual(["account_balance", "document_series"]);
```

**Only that one file pins the array.** `apps/worker/test/handlers/integrity-check.test.ts` (1B) asserts on the report's `ok`, `summary` and recorded incident but never on `projections.checked` — grep it for the field before assuming otherwise; Step 10 runs it as a regression check and it needs no edit.

That file's other assertions do not move either: `SERIES_GAP_CHECK` reports a mismatch only for a `document_series` row with an unexplained number, and no earlier suite creates one (Task 9's falsifiability pass creates its own fiscal period so its `HOLE` counter cannot bleed).

- [ ] **Step 8: Update the pinned DELETE list in `packages/db/test/privileges.test.ts`**

Replace the body of the case `"app_rw may DELETE only from idempotency_key and the two RBAC join tables, and has no TRUNCATE/REFERENCES/TRIGGER anywhere"` — rename it and extend the expectation to exactly the contracts §3.5.4 list after 0023:

```ts
  it("app_rw may DELETE only from idempotency_key, the two RBAC join tables and drafts (document, document_line), and has no TRUNCATE/REFERENCES/TRIGGER anywhere", async () => {
    const rows = await db.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') order by 1, 2`;
    // contracts §3.5.4: 2B (migration 0023) is the ONLY slice that ever extends this list; the two document
    // rows are guarded by document_delete_draft_only / document_line_delete_draft_only (ERR_DOC_NOT_DRAFT).
    expect(rows).toEqual([
      { table_name: "document", privilege_type: "DELETE" },
      { table_name: "document_line", privilege_type: "DELETE" },
      { table_name: "idempotency_key", privilege_type: "DELETE" },
      { table_name: "role_assignment_branch", privilege_type: "DELETE" },
      { table_name: "role_permission", privilege_type: "DELETE" },
    ]);
  });
```

- [ ] **Step 9: Add the `ERR_DOC_NOT_DRAFT` row to `packages/contracts/src/errors.ts`**

The slice's fourth `ERR_*` row lands here rather than in Task 3, because `scripts/lint/rules/error-codes.ts` requires a catalogue row and a raiser of that token to exist together, and this row's only raiser is Step 4's migration. Inside the `ERRORS` object literal, beside the three rows Task 3 Step 5 added:

```ts
  ERR_DOC_NOT_DRAFT:           { status: 409, title: "Document is not a draft",       remedy: "Only a draft may be deleted; an issued document is voided and a posted one is reversed (spec:2049, 2224)" },
```

`app.forbid_delete_unless_draft()` and `app.forbid_line_delete_unless_draft()` both raise it with SQLSTATE 23514 in the `TOKEN: text` form, so `fromDatabaseError` (0B, §4.2.4) maps it to this row's 409 without a handler `catch`.

- [ ] **Step 10: Run everything this touches**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/document-delete.test.ts test/privileges.test.ts`
Expected: **PASS** (10 + the privileges suite). Four failures worth naming in advance: if the cascade case reports `ERR_DOC_NOT_DRAFT` while deleting a *draft*, the child guard is testing `v_status is null` the wrong way round — it must refuse only when a non-draft parent is visible; if `series_gaps` returns rows for the clean `GAP` series, `document_series.next_number` was advanced without a document, which means `issueDocument` ran outside the transaction that wrote the number; if the non-vacuity guard reports `next_number` `["3"]` for series `JV` and nothing for `GAP`, the two documents were drafted against `a.docType` instead of `gapType` and `issueDocument` numbered them into JOURNAL's own series; if the `VOIDONLY` case reports `["1", "2"]`, Step 4's `app.series_gaps` was written with the `document` predicate alone and the `document_number_void` one dropped — which is precisely the difference that case exists to catch, because no other assertion in this file can see it.

Run: `bun run lint` (the repository's `scripts/lint/run.ts`)
Expected: PASS — `error-codes` finds all four of the slice's rows: `ERR_SOD_NO_SUBMISSION`, `ERR_SOD_MAKER_IS_CHECKER` and `ERR_OVERRIDE_NOT_AUTHORISED` in migrations 0021/0022 (rows added in Task 3 Step 5), and `ERR_DOC_NOT_DRAFT` in 0023 (row added in Step 9 above, same commit as its raiser).

Run: `bun run --cwd apps/worker test -- test/handlers/integrity-check.test.ts`
Expected: PASS unchanged — 1B's handler test asserts on the report's `ok`, `summary` and recorded incident, not on `projections.checked`, so a second registered check moves none of its expectations. If it does fail on the array, extend that expectation here rather than removing the registration.

Run: `bun run --cwd tests test -- invariants/audit-chain.test.ts`
Expected: PASS — with Step 7's one-line change to that file's pinned `checked` array. Without it this run fails `expected [ 'account_balance', 'document_series' ] to deeply equal [ 'account_balance' ]`, and so does every later `bun run --cwd tests test` in Tasks 9, 10 and 12.

- [ ] **Step 11: Commit**

```bash
git add docs/adr/0030-gapless-numbering-and-draft-deletion.md \
        packages/db/migrations/0023_grant_document_draft_delete_and_add_series_gaps.sql \
        packages/db/migrations/0023.down.sql packages/db/src/integrity/series-gaps.ts \
        packages/db/src/integrity/index.ts packages/db/src/index.ts \
        packages/contracts/src/errors.ts tests/invariants/audit-chain.test.ts \
        packages/db/test/document-delete.test.ts packages/db/test/privileges.test.ts
git commit -m "$(cat <<'EOF'
feat(db): draft-only deletion and app.series_gaps [2B T4]

spec:2049 admits deletion for drafts alone, so app_rw gains DELETE on document
and document_line behind two BEFORE DELETE guards raising ERR_DOC_NOT_DRAFT —
the one and only extension of the pinned DELETE list in v1 (contracts 3.5.4).
app.series_gaps turns "gapless-provable" (spec:2222, 2288) into a query, and
SERIES_GAP_CHECK puts it in the nightly integrity run beside account_balance —
which is why 1B's pinned projections.checked array gains a second member. The
guards are what keep the answer honest: a deletable issued document could empty
the result by removing the evidence (SAH-041, SAH-051).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Migration `0024_seed_permission_phase2b.sql`: `accounting.document.reverse`

One code, and the role that holds it. `app.permission` is global and read-only for `app_rw` (plan0A:1254), so it is migration data (§3.4.8); the role grant is seed-pack data in `packages/db/seed/roles.ts`, applied per tenant by the seed CLI. The `permission-catalogue` lint (§3.6.3) requires the code to have a handler reference, which Task 8 supplies — so this task and Task 8 travel in one pull request, and Step 5 says exactly when the lint goes green.

**Files:**
- Create: `packages/db/migrations/0024_seed_permission_phase2b.sql`, `packages/db/migrations/0024.down.sql`
- Modify: `packages/contracts/permissions.ts`, `packages/db/seed/roles.ts`

**Interfaces:**
- Consumes: `app.permission (code, module, mutating, description)` with the CHECK `^[a-z_]+\.[a-z_]+\.[a-z_]+$` and `module in ('admin','accounting','inventory','hr','pos')` (plan0A:1314–1318); `PERMISSIONS`, `type PermissionDef`, `type SliceId` from `packages/contracts/permissions.ts` (0B); `ROLES`, `type RoleSeed`, `INCOMPATIBLE_PAIRS` from `packages/db/seed/roles.ts` (0D).
- Produces: the catalogue row `accounting.document.reverse` (`module: "accounting"`, `mutating: true`, `phase: "2B"`) in both `app.permission` and `PERMISSIONS`; the code in `accountant`'s `permissions` array in `roles.ts`. `admin`'s array is computed from `PERMISSIONS` (§3.6.4) and needs no edit.

- [ ] **Step 1: Write the failing assertion by extending `packages/contracts/permissions.ts`**

There is no new test file: 0B's `packages/db/test/permission-catalogue.test.ts` already asserts, after all migrations, that the `(code, module, mutating)` set in `app.permission` equals the set exported by `permissions.ts`, **in both directions**. Adding the entry to `permissions.ts` first is therefore the failing test.

In the `PERMISSIONS` array, immediately after 2A's `accounting.party.manage` entry:

```ts
  { code: "accounting.document.reverse", module: "accounting", mutating: true, phase: "2B",
    description: "Reverse a posted document, producing the reversing document its policy names (D13, spec:2024)" },
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/permission-catalogue.test.ts`
Expected: FAIL — the catalogue holds `accounting.document.reverse` and `app.permission` does not; the assertion reports the one-sided difference.

- [ ] **Step 3: Write `packages/db/migrations/0024_seed_permission_phase2b.sql`**

```sql
-- 0024_seed_permission_phase2b.sql ────────────────────────────────────────────
-- The one permission code slice 2B introduces (contracts §3.6.2). app.permission is a GLOBAL catalogue with no
-- RLS and read-only for app_rw (plan0A:1254), so it is migration data; role grants are per-tenant seed-pack
-- data applied by `bun run seed --tenant <id> --only roles` (contracts §3.4.8, hazard 10).
insert into app.permission (code, module, mutating, description) values
  ('accounting.document.reverse', 'accounting', true,
   'Reverse a posted document, producing the reversing document its policy names (D13, spec:2024)')
on conflict (code) do update
  set module = excluded.module, mutating = excluded.mutating, description = excluded.description;
```

- [ ] **Step 4: Write `packages/db/migrations/0024.down.sql`**

```sql
-- 0024.down.sql ───────────────────────────────────────────────────────────────
-- Exactly the code 0024 inserted. The FK from app.role_permission.permission_code blocks the delete if a
-- seeded tenant still holds it, which is the intended signal: re-run the roles sub-pack before rolling back.
delete from app.permission where code = 'accounting.document.reverse';
```

- [ ] **Step 5: Grant it in `packages/db/seed/roles.ts`**

Add `"accounting.document.reverse"` to the **`accountant`** role's `permissions` array, immediately after `"accounting.journal.post"`.

`accountant` and no other. spec:2157 gives the accountant "sales and purchase documents and their posting … period close" and makes corrections their work; spec:2158 says `user` "may not post"; spec:2163 makes `auditor` non-mutating and the `role-seed` lint (R7) fails the build if a mutating code reaches it. `warehouse` posts receipts and transfers "quantities only" (spec:2159) and does not correct the ledger. `admin` is computed from `PERMISSIONS` and picks the code up automatically (§3.6.4).

**This grant is only half the authority a reversal needs, deliberately.** `accounting.document.reverse` gates the *route*; the reversing document is then posted by `reverseDocument` through `postDocument`, whose `issued → posted` update is checked by the Task 2 trigger against the *reversal type's* `approval.post`. `accountant` already holds every `accounting.*.post` code the seed grants, so the pair holds; a tenant that clones a narrower role must grant both or the reversal fails at the trigger with `ERR_RBAC_FORBIDDEN`, which is the correct answer.

- [ ] **Step 6: Run the catalogue and role checks**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/permission-catalogue.test.ts`
Expected: **PASS** — both directions agree.

Run: `bun run lint`
Expected: **FAIL on `permission-catalogue`** — `accounting.document.reverse` has no `PERMISSION[…]` or `requirePermission('…')` reference yet. That reference arrives in Task 8, in this same pull request. `role-seed` passes: `accountant` holds no `INCOMPATIBLE_PAIRS` member with this code, and `auditor` does not hold it.

Run: `bun run --cwd tests test -- invariants/role-catalogue.test.ts` if 0D's test 36 file exists under that name, otherwise `bun run --cwd tests test`
Expected: PASS — the "who can reverse a document in company X" query is the same one-query shape 0D pinned; a new code does not change it.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0024_seed_permission_phase2b.sql packages/db/migrations/0024.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts
git commit -m "$(cat <<'EOF'
chore(seed): accounting.document.reverse joins the catalogue and the accountant [2B T5]

The one code this slice introduces (contracts 3.6.2). It gates the reverse route
only; the reversing document is still posted under the reversal type's own
approval.post through the status trigger, so a role that can reverse but not post
gets ERR_RBAC_FORBIDDEN from the data layer, which is the correct answer.

The permission-catalogue lint stays red until task 8 references the code in a
handler; both land in one pull request.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `apps/api/src/middleware/require-document-permission.ts`

The pre-flight (contracts §4.5.4). `requirePermission(code, scope)` cannot serve here because the code is not known at route-registration time — it is resolved per request from the policy effective for the document's `effective_date`. The middleware performs the same resolution the trigger performs, and returns `403 ERR_RBAC_FORBIDDEN` with a remedy instead of letting the caller collect a 409 from a constraint. **It is never the control** (spec:2173, ADR 0029).

**Reconciliation with 2A (amendment A4) — read this before Step 1. This task is a two-line diff, not a create.** 2A created `apps/api/src/middleware/require-document-permission.ts` with all six `DocumentStage` members mapped, and **2A's file is the merged authority for every behaviour in it.** What this slice adds is one export and nothing else:

- **2A's private `codeFor(stage, policy)` becomes the exported `stageCode(stage, approval)`.** Same `switch`, same three branches, one narrower parameter: it takes the policy's `approval` block instead of the whole `PostingPolicy`, so a test and a later slice (6C's sync apply, 8B's payroll routes) can assert the map from a plain object with no policy and no request. That is the whole of Step 3.
- **Nothing else in the file is touched.** In particular 2A's **`resolvePolicy(tx, type.id, effectiveDate)`** resolution (it calls 1A's TypeScript function and gets `ERR_POLICY_NOT_FOUND` from it — this task does **not** substitute `app.effective_policy`, which is the *trigger's* resolver), its `branchId = null` for the create stage, its `ERR_NOT_FOUND` for a missing type or an absent `effectiveDate`, its 403 message, and — critically — its **`export const POLICY_RESOLVED_CODES`**, which amendment A4 makes the initialiser of `DOCUMENT_STAGE_CODES` in `documents.ts`. Deleting it would break the typecheck of a 2A file this slice does not otherwise edit.
- **The middleware raises no `ERR_POLICY_INVALID`.** 2A's file reads `policy.approval.post`, which the schema makes required (§4.4.1), and this task adds no branch. Fail-closed on a policy with no `approval` block is **the trigger's** job and is asserted there (Task 2, assumption 5): the pre-flight cannot distinguish "no policy row" from "policy without an approval block" without a second query, and inventing one here would make the pre-flight and the control disagree about the code — which ADR 0029 forbids.
- **If 2A's merged file differs from this description**, 2A wins: report the difference against contracts §4.5.4 in Task 12 Step 1 and leave 2A's behaviour alone. Do **not** rewrite the file to match this plan.
- **Step 1's test file is genuinely new.** 2A exercised the middleware through `apps/api/test/routes/accounting/documents.test.ts`; the dedicated `apps/api/test/middleware/require-document-permission.test.ts` does not exist, and its `stageCode` case is the assertion that made the export worth making.

**Files:**
- Create: `apps/api/test/middleware/require-document-permission.test.ts`
- Modify: `apps/api/src/middleware/require-document-permission.ts` (2A's file — export `stageCode` in place of the private `codeFor` and change its call; nothing else)

**Interfaces:**
- Consumes (all already in 2A's file, and unchanged by this task): `type AppEnv` from `../context` (0B); `AppError` from `@dulja/contracts` (0B); `resolvePolicy` from `@dulja/db` (1A, §4.3.1); `type PostingPolicy` from `@dulja/domain` (§4.4.2); `app.actor_has(text, uuid, uuid)` (Plan 0A); `c.var.withTenant` (0B, §4.2.3). For the test: `startApi`, `type StartedApi` from `../support/app` (0B); `type Problem` from `@dulja/contracts` (0B); `grantCodes`, `seedTenantV2`, `uuidv7`, `withTenant`, `type Seed` from `@dulja/db/test`.
- Produces:
  - `export function stageCode(stage: DocumentStage, approval: PostingPolicy["approval"]): string` — the pure half of §4.5.4's map, lifted out of 2A's private `codeFor` and exported. **A contract addition, and the only thing this task produces.** The parameter is typed `PostingPolicy["approval"]` rather than a fresh interface so no new exported type name is invented and the two callers cannot drift; the return is `string` and not `PermissionCode`, because a policy may name a code whose slice has not yet seeded it (`hr.payroll.prepare` at 2B) and `app.actor_has` takes `text`.
  - `export type DocumentStage` and `export function requireDocumentPermission(stage)` are **2A's and are re-declared by nothing here** — they are listed in this plan's Consumes above and appear in §4.5.4 already.

- [ ] **Step 1: Write the failing test `apps/api/test/middleware/require-document-permission.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCodes, seedTenantV2, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import type { Problem } from "@dulja/contracts";
import { stageCode } from "../../src/middleware/require-document-permission";
import { startApi, type StartedApi } from "../support/app";

describe("requireDocumentPermission — contracts §4.5.4, spec:2173", () => {
  let api: StartedApi;
  let a: Seed;
  let clerk: string;
  let poster: string;

  const draft = async (): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await withTenant(api.db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 3.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 3.0000)`;
    });
    return id;
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    clerk = await uuidv7(api.db.admin);
    poster = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      for (const [id, label] of [[clerk, "clerk"], [poster, "poster"]] as const) {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${id}, 'human', ${`${label}:${a.tenant}`}, ${label})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
      }
    });
    await grantCodes(api.db, a, { principalId: clerk, codes: ["accounting.journal.create"] });
    await grantCodes(api.db, a, { principalId: poster, codes: ["accounting.journal.post"] });
    await api.loadPrincipals();
  });
  afterAll(async () => { await api.stop(); });

  it("maps every stage exactly as contracts §4.5.4 states", () => {
    const full = { required: true, approve: "hr.payroll.approve", post: "hr.payroll.post", create: "hr.payroll.prepare" };
    expect(stageCode("create", full)).toBe("hr.payroll.prepare");
    expect(stageCode("submit", full)).toBe("hr.payroll.prepare");
    expect(stageCode("approve", full)).toBe("hr.payroll.approve");
    expect(stageCode("issue", full)).toBe("hr.payroll.post");
    expect(stageCode("post", full)).toBe("hr.payroll.post");
    expect(stageCode("void", full)).toBe("hr.payroll.post");

    // JOURNAL_POLICY_V1 shape: no `create`, no `approve` (contracts §4.3.7 — assumption 3)
    const journal = { required: false, approve: null, post: "accounting.journal.post" };
    expect(stageCode("create", journal)).toBe("accounting.journal.post");
    expect(stageCode("submit", journal)).toBe("accounting.journal.post");
    expect(stageCode("approve", journal)).toBe("accounting.journal.post");
  });

  it("403 ERR_RBAC_FORBIDDEN naming the resolved code when the caller lacks it", async () => {
    const d = await draft();
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${d}/transitions`,
      as: clerk, body: { to: "posted" },
    });
    expect(res.status).toBe(403);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("accounting.journal.post");
  });

  it("lets the request through when the caller holds the resolved code", async () => {
    const d = await draft();
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${d}/transitions`,
      as: poster, body: { to: "issued" },
    });
    expect(res.status).toBe(200);
  });

  it("404 ERR_NOT_FOUND for a document of another tenant, revealing nothing", async () => {
    const b = await seedTenantV2(api.db, "Beta");
    const bDoc = await uuidv7(api.db.admin);
    await withTenant(api.db.rw, b.tenant, b.human, (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${bDoc}, ${b.tenant}, ${b.company}, ${b.docType}, 'JV', '2026-01-15', 'MYR', ${b.hq})`);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${bDoc}/transitions`,
      as: poster, body: { to: "issued" },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Problem).code).toBe("ERR_NOT_FOUND");
  });

  // The one case that is RED at the end of this task: `to: "submitted"` is outside 2A's three-value STAGE_OF,
  // so the route's per-`to` resolver raises 400 ERR_VALIDATION_FAILED before the middleware ever runs. Task 7
  // Step 5 replaces STAGE_OF with the six-value STAGE_FOR and this case goes green there. The error itself is
  // 2A's `resolvePolicy` (contracts §4.3.1) raising ERR_POLICY_NOT_FOUND — the middleware adds no branch.
  it("422 ERR_POLICY_NOT_FOUND when nothing is effective for the document's date", async () => {
    const late = await uuidv7(api.db.admin);
    const lateDoc = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.document_type (id, tenant_id, company_id, code, name_en)
               values (${late}, ${a.tenant}, ${a.company}, 'LATE2', 'Late')`;
      await tx`insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
               values (${a.tenant}, ${late}, 1, '2030-01-01', '{"version":1,"documentType":"LATE2","direction":"none","lines":[]}'::jsonb)`;
    });
    await withTenant(api.db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${lateDoc}, ${a.tenant}, ${a.company}, ${late}, 'LT', '2026-01-15', 'MYR', ${a.hq})`);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${lateDoc}/transitions`,
      as: poster, body: { to: "submitted" },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Problem).code).toBe("ERR_POLICY_NOT_FOUND");
  });

  it("resolves the CREATE stage from the body's documentTypeCode, not from a path id", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: clerk,
      body: {
        documentTypeCode: "JOURNAL", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
        lines: [{ lineNo: 1, accountId: a.cash, debit: "1.0000" }, { lineNo: 2, accountId: a.sales, credit: "1.0000" }],
      },
    });
    // assumption 3: JOURNAL declares no approval.create, so the create stage resolves to approval.post and the
    // clerk — who holds only accounting.journal.create — is refused.
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).detail).toContain("accounting.journal.post");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd apps/api test -- test/middleware/require-document-permission.test.ts`
Expected: **FAIL at collection** — `SyntaxError: The requested module '../../src/middleware/require-document-permission' does not provide an export named 'stageCode'`. The module itself resolves: 2A created it (amendment A4), and the missing export is the only thing this task adds. **If the failure is instead `Cannot find module`, 2A is not merged and this slice's phase gate is not met — stop.**

- [ ] **Step 3: Export `stageCode` from `apps/api/src/middleware/require-document-permission.ts`**

Two edits to 2A's merged file. **Print the file before editing and confirm it matches the reconciliation note above.**

**Edit one** — replace 2A's private `codeFor`:

```ts
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
```

with the exported, narrower form — same three branches, same order, no behaviour change:

```ts
/**
 * create/submit → approval.create ?? approval.post · approve → approval.approve ?? approval.post ·
 * issue/post/void → approval.post (contracts §4.5.4). `approval.post` is required by the schema, so every
 * branch terminates in a code and none can fall open.
 *
 * **Exported (2B, a contract addition to §4.5.4)** as a pure function of the `approval` block alone, so a test
 * can assert the map with no policy and no request, and so a later slice that resolves the same map for a
 * non-request path (6C's sync apply, 8B's payroll routes) calls this rather than re-deriving it. The return is
 * `string`, not `PermissionCode`: a policy may legitimately name a code whose slice has not seeded it yet
 * (`hr.payroll.prepare` at 2B) and `app.actor_has` takes `text`.
 */
export function stageCode(stage: DocumentStage, approval: PostingPolicy["approval"]): string {
  const post = approval.post;
  switch (stage) {
    case "create":
    case "submit":
      return approval.create ?? post;
    case "approve":
      return approval.approve ?? post;
    case "issue":
    case "post":
    case "void":
      return post;
  }
}
```

**Edit two** — the one call site, inside `requireDocumentPermission`:

```ts
    const code = codeFor(stage, resolved.policy);
```

becomes

```ts
    const code = stageCode(stage, resolved.policy.approval);
```

**Everything else in the file stays byte-for-byte as 2A merged it**, including the `resolvePolicy` call that resolves the policy and raises `ERR_POLICY_NOT_FOUND`, the `branchId = null` create branch, the `ERR_NOT_FOUND` for a missing type, the 403 message, and `export const POLICY_RESOLVED_CODES`. The two imports 2A's `codeFor` used — `type PostingPolicy` from `@dulja/domain` and `type PermissionCode` from `@dulja/contracts` — are both still needed: `PostingPolicy` by `stageCode`'s parameter type, `PermissionCode` by `POLICY_RESOLVED_CODES`. Nothing is removed from the import list.

- [ ] **Step 4: Run the test**

Run: `bun run --cwd apps/api test -- test/middleware/require-document-permission.test.ts`
Expected: **PASS on five of the six cases; FAIL on exactly one** — the `422 ERR_POLICY_NOT_FOUND` case, which returns **400 `ERR_VALIDATION_FAILED`**. That is the correct intermediate state and worth reading carefully, because it is easy to mistake for a broken middleware:

- `stageCode`, the 403, the 200 on `to: "issued"`, the cross-tenant 404 and the create-stage 403 all pass **now**, because 2A already mounts `requireDocumentPermission` on the transitions route (per-`to`) and on the create route.
- The 422 case sends `to: "submitted"`, and 2A's per-`to` resolver knows only `issued | posted | void` (`STAGE_OF`), so it raises `ERR_VALIDATION_FAILED` **before** the middleware runs and the policy is never resolved. **Task 7 Step 5 is where this case goes green**, when `STAGE_OF` is replaced by the six-value `STAGE_FOR`.

Do not "fix" it here by widening the route: the route is Task 7's file and Task 7's test asserts the widening.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/require-document-permission.ts \
        apps/api/test/middleware/require-document-permission.test.ts
git commit -m "$(cat <<'EOF'
feat(api): export stageCode from requireDocumentPermission [2B T6]

2A shipped the middleware (amendment A4) with all six DocumentStage members
mapped in a private codeFor. This lifts that map into an exported stageCode
taking only the policy's approval block, so a test can assert it with no request
and 6C's sync apply and 8B's payroll routes resolve it identically instead of
re-deriving it. No behaviour changes: same three branches, same order, and 2A's
resolvePolicy call, its create-stage branch and POLICY_RESOLVED_CODES are
untouched. It remains a pre-flight and never the control (spec:2173).

The new test file is the assertion that made the export worth making. Its
ERR_POLICY_NOT_FOUND case stays red until task 7 widens the route's `to`.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The transitions route generalised, and the widened `TransitionResultSchema`

1A mounted `POST …/documents/{documentId}/transitions` with `to ∈ issued | posted | void` behind the static code `accounting.journal.post`, and gated create with the static `accounting.journal.create`; 2A replaced both static gates with `requireDocumentPermission` and shipped `DOCUMENT_STAGE_CODES` (amendment A4). This task does the half neither did: it widens `to` to the six stages of contracts §4.5.4, maps each to a `DocumentStage`, and widens `TransitionResultSchema` so the response can carry the `from`/`to`/`eventId` of the `document_event` row the triggers wrote without dropping any of 1A's six members. `DOCUMENT_STAGE_CODES` and the two gates are **verified** here, not written.

**Reconciliation with 2A (amendment A4) — read this before Step 1.** Two of the four things this task does, 2A has already done. Split the steps accordingly:

- **Already 2A's, and this task only verifies them — it defines none of them:** `DOCUMENT_STAGE_CODES` exists in `documents.ts` as **`export const DOCUMENT_STAGE_CODES: readonly PermissionCode[] = POLICY_RESOLVED_CODES;`**, initialised from the constant 2A's middleware exports (amendment A4: "The file also exports **`POLICY_RESOLVED_CODES`** … `DOCUMENT_STAGE_CODES` is initialised from it and every type-seeding slice appends to it"); both static gates are already `requireDocumentPermission("create")` / the per-`to` resolver; the create handler's `documentTypeCode === "JOURNAL"` restriction is already gone; and the module's `permissions` already reads `DOCUMENT_STAGE_CODES`. **Do not print a literal array over that initialiser** — replacing `= POLICY_RESOLVED_CODES` with `= [PERMISSION[…], PERMISSION[…]]` would leave `POLICY_RESOLVED_CODES` exported and unreferenced, which is exactly what the `permission-catalogue` lint (§3.6.3) was given that constant to prevent. Read the merged file; if `POLICY_RESOLVED_CODES` lists exactly the two `accounting.journal.*` codes, Step 2's last assertion passes as printed — if 2A seeded a third code, record 2A's actual list in that assertion and add nothing. **Both of the test-file edits an earlier draft of Step 2 planned are 2A's too:** its Task 9 Step 1 widens 1A's `drafter` grant to `accounting.journal.create, accounting.journal.post` — in this plan's own wording, which it quotes — and replaces 1A's "a drafter may create but not post" with `it("a drafter holding the code JOURNAL's policy names may create AND post it …")`. Step 2 verifies both and edits neither.
- **Genuinely this slice's, and unbuilt when the task starts:** the widened `TransitionBody` and the widened `TransitionResultSchema` (2A's Produces names `CreateDocumentBody`, `DocumentLineSchema` and `ReplaceLinesBody` — **neither of the two transition schemas**, so 1A's three-value enum and 1A's six-member result are both still in place), the `STAGE_FOR` map from `to` to `DocumentStage`, the handler's six-way body, the `lastEventId` helper, and the four new cases of Step 2's appended block.

**Files:**
- Modify: `packages/contracts/src/accounting/document.ts` (`TransitionBody` and `TransitionResultSchema` widened), `apps/api/src/routes/accounting/documents.ts`, `apps/api/test/routes/accounting/documents.test.ts`

**Interfaces:**
- Consumes: `requireDocumentPermission`, `stageCode`, `type DocumentStage` (2A; `stageCode` from Task 6); `POLICY_RESOLVED_CODES`, `DOCUMENT_STAGE_CODES` (2A — read, never redefined); `transitionDocument`, `type TransitionResult` (Task 3); `postDocument`, `voidDocument` from `@dulja/db` (1A); `DocumentSchema`, `CreateDocumentBody`, `ReplaceLinesBody` (1A); `type Sql` from `postgres`; `UuidSchema` (§4.2.8); `IdempotencyHeader`, `type RouteModule` (0B).
- Produces:
  - `TransitionBody` widened to `{ to: "draft" | "submitted" | "approved" | "issued" | "posted" | "void"; reason?: string; attributedTo?: string }` with two `.refine`s requiring `reason` on `to: "draft"` and on `to: "void"` — contracts §4.5.4 verbatim plus the recalculation rule (spec:2081).
  - `TransitionResultSchema` widened to a **superset** of 1A's six members: `from`, `to` and `eventId` are added, `status`, `number`, `series`, `fiscalPeriodId` and `ledgerEntryIds` all stay. **A contract addition to §4.2.8's `accounting/document.ts` row** (the name is 1A's; the shape changes). It is a superset and not the §4.3.1 `TransitionResult` shape on purpose: 1A's own `apps/api/test/routes/accounting/documents.test.ts` asserts `result.status`, `result.ledgerEntryIds` and `result.number` on this response, and `docs/ui/phase-1-api-surface.md` publishes all six members to 1B's screens, so dropping them would break a slice this one does not edit. The `.openapi("TransitionResult")` component name is unchanged.
  - The transitions route mounting `requireDocumentPermission` chosen per `to` through `STAGE_FOR`; the create and lines routes mounting `requireDocumentPermission("create")` (2A's, verified).

- [ ] **Step 1: Widen `TransitionBody` and `TransitionResultSchema` in `packages/contracts/src/accounting/document.ts`**

Replace 1A's three-value `TransitionBody` with:

```ts
/**
 * contracts §4.5.4. `posted` calls postDocument, `void` calls voidDocument, the rest transitionDocument.
 * A backward edge is a recalculation and needs a reason (spec:1188, 2081) — the trigger of migration 0022
 * refuses it either way with ERR_DOC_STATUS_ILLEGAL, but the caller deserves the field-level message.
 */
export const TransitionBody = z
  .object({
    to: z.enum(["draft", "submitted", "approved", "issued", "posted", "void"]),
    reason: z.string().min(1).max(2000).optional(),
    attributedTo: UuidSchema.optional(),
  })
  .refine((b) => b.to !== "draft" || (b.reason !== undefined && b.reason.length > 0), {
    path: ["reason"],
    message: "returning a document to draft is a recalculation and needs a reason (spec:2081)",
  })
  .refine((b) => b.to !== "void" || (b.reason !== undefined && b.reason.length > 0), {
    path: ["reason"],
    message: "a void records why the number will never post (spec:1745)",
  });
```

Then replace 1A's `TransitionResultSchema` — six members, all of which stay — with the superset the widened handler returns. `@hono/zod-openapi` types `c.json()` against the route's declared 200 schema, so this edit and Step 4's handler are one change and neither typechecks without the other:

```ts
/**
 * The outcome of one transition. 1A's six members are unchanged — `apps/api/test/routes/accounting/
 * documents.test.ts` asserts `status`, `number` and `ledgerEntryIds` on this response and
 * `docs/ui/phase-1-api-surface.md` publishes all six to 1B's screens — and 2B ADDS the three that
 * contracts §4.3.1's `TransitionResult` names: `from`, `to` and the `eventId` of the row the AFTER trigger
 * wrote (§4.5.2). A client that reads only 1A's members keeps working; the component name is unchanged.
 *
 * `from` and `to` are the two `app.document_status` values the `document_event` row carries, so a caller can
 * reconcile the response against `GET …/{documentId}/events` without a second read. `series` is not nullable:
 * `app.document.series` is `not null` (plan0A:1780). `fiscalPeriodId` and `number` are, because a document
 * before `issued` has neither.
 */
export const TransitionResultSchema = z.object({
  documentId: UuidSchema,
  from: z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]),
  to: z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]),
  eventId: UuidSchema,
  status: z.string(),
  number: z.string().nullable(),
  series: z.string(),
  fiscalPeriodId: UuidSchema.nullable(),
  ledgerEntryIds: z.array(UuidSchema),
}).openapi("TransitionResult");
```

`status` is retained as `z.string()` — 1A's own spelling — and always equals `to`; it is kept because 1A's test and 1B's screens read it, and narrowing it to the enum would be a second, unnecessary breaking change to a name this slice is already amending.

- [ ] **Step 2: Write the failing test — extend `apps/api/test/routes/accounting/documents.test.ts`**

**Two verifications and one new block — this step edits no existing case.** Both of the rewrites an earlier draft of this plan assigned here are 2A's: it made the first in this plan's own wording, and the second was never needed.

**Verification one — the `drafter` grant is already widened; do not widen it again.** 1A's `beforeAll` grants the `drafter` principal only `accounting.journal.create` (1a:4526), which stops being enough the moment the create gate is resolved from the policy: `JOURNAL_POLICY_V1` declares no `approval.create`, so `approval.create ?? approval.post` resolves to `accounting.journal.post` (contracts §4.4.1's round-2 correction; assumption 3). **2A Task 9 Step 1 "Edit one" already makes that change and says so** — "The wording is 2B Task 7 Step 2's own, so that slice finds the edit already made." Read `beforeAll` and confirm the line reads

```ts
    // 2A: the create gate is now resolved from the policy, and JOURNAL_POLICY_V1 declares no approval.create,
    // so `approval.create ?? approval.post` is accounting.journal.post (contracts §4.5.4, §4.4.1's round-2
    // correction). The wording is 2B Task 7 Step 2's own, so that slice finds the edit already made.
    await grant(a, drafter, "accounting.journal.create", "accounting.journal.post");
```

If it does — the expected state on a merged 2A — **change nothing.** If it still reads `await grant(a, drafter, "accounting.journal.create");`, 2A is not merged: stop and report, exactly as Step 4's closing paragraph requires for 2A's other three edits.

**Verification two — 2A's rewritten `drafter` case passes under this slice unchanged, and no assertion moves into 2B.** 2A did not only widen the grant. It replaced 1A's `it("a drafter may create but not post (spec:2158 — the clerk may not post)")` with `it("a drafter holding the code JOURNAL's policy names may create AND post it (2A: §4.4.1's correction)")`, which creates a JOURNAL as `drafter` and then asserts `posted.status === 200` on `{ to: "posted" }` **as the same principal, starting from `draft`**. Nothing this slice adds refuses that. The reason is worth writing down here, because this is the one place where maker ≠ checker looks like it should bite and deliberately does not:

- **The matrix never sees the pair `draft → posted`.** `body.to === "posted"` calls 1A's `postDocument` (Step 4's handler), which by contracts §4.3.2 step 2 issues an unissued document in the same transaction — so `app.document_status_before()` sees `draft → issued` and then `issued → posted`. Task 2's block 2a admits `old.status in ('draft','submitted') and new.status = 'issued'` whenever `approval.required` is false, and JOURNAL's block is `{ "required": false, "approve": null, "post": "accounting.journal.post" }` (contracts §4.3.7), so both pairs are legal. This is also why the handler reads the TRUE `from` rather than assuming one.
- **R1 does not engage.** Block 2b opens `if v_required and new.status in ('approved', 'posted')`, and `v_required` is false for JOURNAL, so neither `ERR_SOD_NO_SUBMISSION` nor `ERR_SOD_MAKER_IS_CHECKER` is evaluated. That is contracts §4.5.1 as written, not a gap: R1 is a property of a type that *requires approval*, and a type that admits `draft → issued` has no maker/checker split to enforce. The SoD statement spec:2158 wants is made instead on a type whose policy does require it — 2A's `POLICY_TEST` block, and this slice's `SOD_TEST` in Task 10.
- **R8 is not a transition rule at all.** It is Task 1's BEFORE INSERT guard on `app.document_event`, admitting an `override` row only for a second principal who is neither the document's `created_by` nor its `attributed_to`. It is reached through `recordOverride` / `POST …/overrides` and never by an UPDATE of `status`.
- **R2 passes on the grant 2A already made, and at the document's branch.** Block 2c sets `v_gate := approval.post`, which is `accounting.journal.post`, and the widened grant gives the `drafter` exactly that code. It also gives it **company-wide**, which is the half of R2 the code alone does not settle: block 2c calls `app.actor_has(v_gate, new.company_id, new.branch_id)` with a **non-null** `new.branch_id` — that file's `create` helper sends `branchId: a.hq` on every document — and 1A's local `grant` helper inserts a `role_assignment` carrying `company_id` and **no `app.role_assignment_branch` row at all** (1a:4499–4507). `app.actor_has` therefore takes its `not exists (select 1 from app.role_assignment_branch …)` disjunct (plan0A:1377–1378) and answers true for any branch, `a.hq` included. R2 would bite here only if that grant were branch-restricted to a branch other than the document's, and it is not; **do not "fix" this by adding a `role_assignment_branch` row to 1A's helper** — a branch-restricted grant would make `actor_has(code, company, null)` false and turn 1A's own company-wide cases red. The pre-flight agrees with the trigger rather than contradicting it, because `STAGE_FOR.posted = "post"` and `stageCode("post", …)` returns the same code, and **2A's** `requireDocumentPermission` — the middleware is 2A's under amendment A4; Task 6 adds only `stageCode` to it — resolves the same pair, calling `app.actor_has(code, companyId, resolved.branchId)` with `resolved.branchId` read as the document's own `branch_id` (2a Task 9's middleware body; `null` on the create route, which has no `:documentId`). Pre-flight and trigger therefore ask `actor_has` the identical question, and a company-wide grant satisfies both.

So that assertion stays where 2A wrote it: **do not move it into this file, weaken it, or add a 2B duplicate of it.** The only thing 2B changes about the response it reads is that it becomes a superset — `from: "draft"` and `eventId` appear beside `status: "posted"` — and 2A's `toMatchObject({ status: "posted" })` is unaffected by an added member.

**1A's other `to`-related case is correct as it stands and is not touched either.** `it("voids an issued document, and offers no reversal target (§4.5.4 gives 2B its own route)")` asserts `400 ERR_VALIDATION_FAILED` for `{ to: "reversed" }`; `reversed` is outside the widened six-value enum exactly as it was outside 1A's three-value one, and Task 8 puts reversal on `POST …/documents/{documentId}/reverse` under `accounting.document.reverse`, so the Zod rejection is still the right answer. Its `to: "void"` half already passes a `reason` and so satisfies Step 1's new `.refine` unchanged.

Append the new block at the end of the `describe`:

```ts
  it("walks the full state machine through one route (contracts §4.5.4)", async () => {
    const created = await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "40.0000" },
      { lineNo: 2, accountId: a.sales, credit: "40.0000" },
    ]);
    const { id } = (await created.json()) as { id: string };
    const move = (to: string, body: Record<string, unknown> = {}, as = a.human) =>
      api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as, body: { to, ...body } });

    expect((await move("submitted", { reason: "for review" })).status).toBe(200);
    const back = await move("draft", { reason: "figures changed" });
    expect(back.status).toBe(200);
    expect((await back.json()) as { from: string; to: string }).toMatchObject({ from: "submitted", to: "draft" });
    expect((await move("submitted", { reason: "again" })).status).toBe(200);

    const issued = await move("issued");
    expect(issued.status).toBe(200);
    // 1A's six members survive the widening (Step 1) and 2B's three are added beside them — this is the
    // assertion that keeps TransitionResultSchema a superset rather than a replacement.
    const issuedBody = (await issued.json()) as {
      from: string; to: string; eventId: string; status: string; number: string;
      series: string; fiscalPeriodId: string | null; ledgerEntryIds: string[];
    };
    expect(issuedBody).toMatchObject({ from: "submitted", to: "issued", status: "issued", series: "JV", ledgerEntryIds: [] });
    expect(BigInt(issuedBody.number)).toBeGreaterThan(0n);
    expect(issuedBody.fiscalPeriodId).not.toBeNull();
    expect(issuedBody.eventId).toMatch(/^[0-9a-f-]{36}$/);

    const postedRes = await move("posted");
    expect(postedRes.status).toBe(200);
    expect((await postedRes.json()) as { from: string; ledgerEntryIds: string[] }).toMatchObject({ from: "issued" });
    const [row] = await withTenant(api.db.rw, a.tenant, a.human, (tx) =>
      tx<{ status: string }[]>`select status::text as status from app.document where id = ${id}`);
    expect(row!.status).toBe("posted");
  });

  it("refuses `to: draft` and `to: void` without a reason with ERR_VALIDATION_FAILED naming the field", async () => {
    const created = await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "1.0000" },
      { lineNo: 2, accountId: a.sales, credit: "1.0000" },
    ]);
    const { id } = (await created.json()) as { id: string };
    await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: a.human, body: { to: "submitted" } });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: a.human, body: { to: "draft" },
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.[0]?.path).toBe("reason");
  });

  it("a void writes document_number_void and the event carries the reason (spec:1745)", async () => {
    const created = await create(a.human, [
      { lineNo: 1, accountId: a.cash, debit: "2.0000" },
      { lineNo: 2, accountId: a.sales, credit: "2.0000" },
    ]);
    const { id } = (await created.json()) as { id: string };
    await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: a.human, body: { to: "issued" } });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: a.human,
      body: { to: "void", reason: "printer jam; reissued" },
    });
    expect(res.status).toBe(200);
    const [voided] = await withTenant(api.db.rw, a.tenant, a.human, (tx) =>
      tx<{ reason: string }[]>`select v.reason from app.document_number_void v
                                 join app.document d on d.company_id = v.company_id and d.series = v.series
                                   and d.fiscal_period_id = v.fiscal_period_id and d.number = v.number
                                where d.id = ${id}`);
    expect(voided!.reason).toBe("printer jam; reissued");
  });

  it("DOCUMENT_STAGE_CODES lists every code a seeded policy may name at any stage", async () => {
    const { DOCUMENT_STAGE_CODES } = await import("@dulja/api/routes");
    expect([...DOCUMENT_STAGE_CODES].sort()).toEqual(["accounting.journal.create", "accounting.journal.post"]);
  });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run --cwd apps/api test -- test/routes/accounting/documents.test.ts`
Expected: FAIL — `to: "submitted"` is rejected with `ERR_VALIDATION_FAILED` by 1A's three-value enum until Step 1's schema is in place, and after it the route still returns 400 from the handler's `switch`, which knows only three values.

- [ ] **Step 4: Rewrite the transitions handler in `apps/api/src/routes/accounting/documents.ts`**

**`DOCUMENT_STAGE_CODES` is not written here.** It already reads

```ts
export const DOCUMENT_STAGE_CODES: readonly PermissionCode[] = POLICY_RESOLVED_CODES;
```

in the merged file (2A, amendment A4), and it stays exactly that: the constant it is initialised from is the middleware's `PERMISSION[…]` reference list, which is what keeps `scripts/lint/rules/permission-catalogue.ts` (§3.6.3) satisfied for codes resolved from **data** rather than named in source. Verify the line exists and move on. Its meaning is unchanged and worth restating for the slices that will append to it: *the union of every code any seeded type's policy may name at any stage*, and **every slice that seeds a document type adds its `approval.*` codes to `POLICY_RESOLVED_CODES` in the same PR as its policy file.** At 2B the only seeded type is JOURNAL (contracts §4.14); `accounting.journal.create` is in the list although no shipped policy resolves to it (JOURNAL declares no `approval.create` — assumption 3), because 2A's removal of 1A's static gate removed that code's only source reference and an unreferenced catalogue code fails the build.

Add the imports this task's handler needs — and **no `PERMISSION` / `PermissionCode` import**, which the merged file already has for the constant above:

```ts
import type { Sql } from "postgres";                  // if the file does not already import it — 1A types `tx`
import { transitionDocument, postDocument, voidDocument } from "@dulja/db";
import { requireDocumentPermission, type DocumentStage } from "../../middleware/require-document-permission";
```

and the `to` → stage map:

```ts
/**
 * `to` → the stage whose code the gate resolves (contracts §4.5.4): `draft` is "creating or editing the draft
 * itself", `submitted` is the submit stage, `approved` the approve stage, and the last three resolve
 * `approval.post`. `submitted → "submit"` rather than `"create"` even though `stageCode` returns the same code
 * for both (`approval.create ?? approval.post`): amendment A4 says 2B "uses the middleware for its
 * `submitted`/`approved` transitions", the six-member `DocumentStage` union exists so that a policy schema
 * that later separates the two has somewhere to land, and Task 6's test asserts `stageCode("submit", …)` as a
 * distinct branch — a map that never reaches it would make that assertion untestable through any route.
 */
const STAGE_FOR: Record<z.infer<typeof TransitionBody>["to"], DocumentStage> = {
  draft: "create",
  submitted: "submit",
  approved: "approve",
  issued: "issue",
  posted: "post",
  void: "void",
};
```

Replace the `middleware` array of the transitions `createRoute` — 1A's `[requirePermission(PERMISSION["accounting.journal.post"], { company: "path:companyId" })]` — with a resolver that reads the body before choosing the stage:

```ts
  middleware: [
    async (c, next) => {
      const body = (await c.req.json().catch(() => ({}))) as { to?: keyof typeof STAGE_FOR };
      const stage = body.to ? STAGE_FOR[body.to] : undefined;
      if (!stage) {
        // An unknown `to` is the Zod schema's business; let the validator produce the field-level message.
        return next();
      }
      return requireDocumentPermission(stage)(c, next);
    },
  ],
```

and replace the handler body with:

```ts
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await c.var.withTenant(async (tx) => {
      // ONE read, serving three purposes: it restores 1A's ownership check (the middleware matches on `id`
      // alone, so a document of a sibling company inside the same tenant must be refused here), it gives the
      // TRUE `from` status — contracts §4.3.2 step 2 lets postDocument accept a draft, submitted or approved
      // document and issue it in the same transaction, so `from` can be any of four values and hard-coding
      // "issued" would contradict the document_event rows the triggers wrote — and it locks the row for the
      // rest of the transaction, which is what postDocument's own `for update` would do a moment later.
      const [before] = await tx<{ status: DocumentStatus }[]>`
        select status::text as status from app.document
         where id = ${documentId} and company_id = ${companyId} for update`;
      if (!before) throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      const from = before.status;

      if (body.to === "posted") {
        const posted = await postDocument(tx, c.var.ctx, { documentId });
        return {
          documentId, from, to: "posted" as const, eventId: await lastEventId(tx, documentId),
          status: "posted", number: posted.number.toString(), series: posted.series,
          fiscalPeriodId: posted.fiscalPeriodId, ledgerEntryIds: posted.ledgerEntryIds,
        };
      }
      if (body.to === "void") {
        await voidDocument(tx, c.var.ctx, { documentId, reason: body.reason! });
        const head = await headerOf(tx, documentId);
        return {
          documentId, from, to: "void" as const, eventId: await lastEventId(tx, documentId),
          status: "void", number: head.number, series: head.series,
          fiscalPeriodId: head.fiscalPeriodId, ledgerEntryIds: [] as string[],
        };
      }
      const moved = await transitionDocument(tx, c.var.ctx, {
        documentId, to: body.to, ...(body.reason === undefined ? {} : { reason: body.reason }),
        ...(body.attributedTo === undefined ? {} : { attributedTo: body.attributedTo }),
      });
      const head = await headerOf(tx, documentId);
      return {
        documentId, from: moved.from, to: moved.to, eventId: moved.eventId,
        status: moved.to, number: head.number, series: head.series,
        fiscalPeriodId: head.fiscalPeriodId, ledgerEntryIds: [] as string[],
      };
    });
    return c.json(result, 200);
  },
```

with these two helpers beside it in the same file — the posting-service calls do not return the event id, and the API must not guess it:

```ts
/** The id of the transition event the AFTER trigger just wrote. uuidv7 is time-ordered, so `order by id desc`
 *  is insertion order — `occurred_at` cannot be, because now() is the transaction start (Task 3). */
async function lastEventId(tx: Sql, documentId: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.document_event where document_id = ${documentId} and event_kind = 'transition'
     order by id desc limit 1`;
  return row!.id;
}

/** The three numbering members of TransitionResultSchema, read AFTER the transition. `number` is a bigint
 *  column and JSON has no bigint, so it is cast in SQL rather than converted in TypeScript. */
async function headerOf(tx: Sql, documentId: string): Promise<{ number: string | null; series: string; fiscalPeriodId: string | null }> {
  const [row] = await tx<{ number: string | null; series: string; fiscal_period_id: string | null }[]>`
    select number::text as number, series, fiscal_period_id from app.document where id = ${documentId}`;
  return { number: row!.number, series: row!.series, fiscalPeriodId: row!.fiscal_period_id };
}
```

`DocumentStatus` comes from `@dulja/db` (contracts §4.3.1) — add it to that import if the file does not already have it — and `AppError` is already imported by 1A's version of this handler.

Finally, **verify** — do not re-apply — the three edits 2A already made: the **create** route and the **`PUT …/documents/{documentId}/lines`** route mount `requireDocumentPermission("create")` in place of 1A's `requirePermission(PERMISSION["accounting.journal.create"], …)`; the create handler's `documentTypeCode === "JOURNAL"` restriction is gone, so any type the company has is admissible (the sentence 2C proves end to end); and `apps/api/src/routes/index.ts` gives the documents module `permissions: DOCUMENT_STAGE_CODES`. If any of the three is missing, 2A is not merged — stop and report, rather than making the edit here.

- [ ] **Step 5: Run the tests**

Run: `bun run --cwd apps/api test -- test/routes/accounting/documents.test.ts test/middleware/require-document-permission.test.ts`
Expected: **PASS** — including the one case Task 6 left red (`422 ERR_POLICY_NOT_FOUND` on `to: "submitted"`, which was a 400 while `STAGE_OF` knew three values and is now resolved through `STAGE_FOR`). Two failures worth naming in advance: if the state-machine walk fails at `submitted → draft` with `ERR_DOC_STATUS_ILLEGAL` rather than succeeding, the route is not passing `reason` into `transitionDocument` and the trigger sees an empty `app.event_reason`; if the create case 403s for `a.human`, the seed's JOURNAL policy resolved to a code `a.human` lacks — check that `grant(a, a.human, …)` in that file's `beforeAll` includes `accounting.journal.post`.

Run: `bun run --cwd packages/contracts openapi:generate && git diff --exit-code packages/contracts/openapi.json`
Expected: a **non-empty** diff, which is the point — commit the regenerated document in Step 6. CI fails on an *unregenerated* one (spec:2055).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/accounting/document.ts packages/contracts/openapi.json \
        apps/api/src/routes/accounting/documents.ts apps/api/test/routes/accounting/documents.test.ts
git commit -m "$(cat <<'EOF'
feat(api): the transitions route walks the whole state machine [2B T7]

`to` widens to the six stages of contracts 4.5.4 and STAGE_FOR resolves each to
the stage whose code requireDocumentPermission reads from the policy effective
for the document's date. TransitionResultSchema gains from, to and eventId as a
SUPERSET of 1A's six members, so 1A's assertions and 1B's screens keep working,
and `from` is read from the row rather than assumed: postDocument may accept a
draft and issue it in the same transaction, so the response must say which
status the document actually left.

The gates themselves, DOCUMENT_STAGE_CODES and the dropped JOURNAL restriction
are 2A's (amendment A4) and are verified here, not rewritten.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The four remaining routes: reverse, overrides, draft delete, event log

The rest of contracts §4.5.4, in one task because the four handlers share one file, one route module and one probe key. `POST …/reverse` is the one route 2A deliberately did not ship — its amendment A7 reads "2A generalises `reverseDocument` (the service) and ships no reversal route and no reversal permission code; **2B ships both**" — so this task is where `accounting.document.reverse` gets the handler reference that turns Task 5's red `permission-catalogue` lint green. `POST …/overrides` is the back-office door of §4.5.3. `DELETE …/{documentId}` is the API face of Task 4's grant. `GET …/{documentId}/events` is the read `listDocumentEvents` was written for.

**Files:**
- Create: `apps/api/test/routes/accounting/document-lifecycle.test.ts`
- Modify: `packages/contracts/src/accounting/document.ts`, `packages/contracts/src/index.ts`, `apps/api/src/routes/accounting/documents.ts`, `apps/api/src/routes/index.ts` (the documents module's `permissions` array lives there, not in `documents.ts` — 2A set it to `DOCUMENT_STAGE_CODES` and Step 4 widens it)

**Interfaces:**
- Consumes: `reverseDocument`, `recordOverride`, `listDocumentEvents`, `type OverrideCode`, `type DocumentEventRow` from `@dulja/db` (1A, Task 3); `requirePermission` (§4.2.5 — with the `{ company: "path:companyId", branch: "document" }` scope §4.2.5 provides for exactly this case); `PERMISSION`, `AppError` (0B); `requireDocumentPermission` (2A, verified in Task 6); `DOCUMENT_STAGE_CODES` (2A, verified in Task 7); `IdempotencyHeader`, `type RouteModule` (§4.2.7); `UuidSchema`, `DateSchema`, `TimestampSchema`, `ProblemSchema`, `ListEnvelope` (§4.2.8 — **no `ListQuery` and no cursor codec**: a document's timeline is bounded by its own transitions, so the events route declares no query parameters and the envelope's `next_cursor` is always null); `startApi`, `problemOf` (0B); `grantCodes` (Task 2); `seedTenantV2` (1A).
- Produces (contracts, `packages/contracts/src/accounting/document.ts` — seven schemas; **a contract addition to §4.2.8's register for the `accounting/document.ts` row**):
  - `ReverseDocumentBody = z.object({ effectiveDate: DateSchema, reason: z.string().min(1).max(2000) })`
  - `ReverseDocumentResultSchema = z.object({ reversalDocumentId: UuidSchema, number: z.string() })`
  - `OverrideBody = z.object({ code: z.enum(["inventory.negative_stock.override", "accounting.credit_limit.override", "pos.ticket.override"]), reason: z.string().min(1).max(2000), attributedTo: UuidSchema.optional() })`
  - `OverrideResultSchema = z.object({ eventId: UuidSchema })`
  - `DeleteDocumentResultSchema = z.object({ documentId: UuidSchema, deleted: z.literal(true) })`
  - `DocumentEventSchema`, `DocumentEventList = ListEnvelope(DocumentEventSchema)` — **and deliberately no `DocumentEventQuery`**: see route decision 3.
- Produces (api): four `createRoute` registrations on the existing `documentRoutes` router, and the module's `permissions` widened to `[...DOCUMENT_STAGE_CODES, PERMISSION["accounting.document.reverse"], PERMISSION["accounting.ledger.read"]]`.

**Four route decisions, stated because none is the obvious one.**

1. **The overrides route cannot use `requirePermission`, and its pre-flight must ask about the *attributed* principal.** That middleware takes a compile-time `PermissionCode` (§4.2.5) and the override code is a *body value*; worse, **none of the three `OverrideCode` members is in the catalogue at 2B** — `inventory.negative_stock.override` is 3A's, `accounting.credit_limit.override` is 4A's, `pos.ticket.override` is 6A's (§3.6.2) — so `PERMISSION["accounting.credit_limit.override"]` does not typecheck here. The gate is therefore an inline pre-flight in the handler.

  **This departed from contracts §4.5.3, which fixed the gate as `requirePermission(code, { company: "path:companyId", branch: "document" })`, so it was never a silent choice: the round-2 amendment pass has since rewritten that sentence in the document — §4.5.3 now reads "The route's gate is an inline `app.principal_has` pre-flight, not `requirePermission`" — and Task 12 Step 1 verifies it, with the reasoning below as the justification on the record.** The scope §4.5.3 names is exactly what the pre-flight reproduces — the document's own company and branch — so only the *mechanism* changes, never the question asked.

  It calls **`app.principal_has(coalesce(attributedTo, actorId), code, …)`** and *not* `app.actor_has(code, …)`, because `document_event_override_guard` (Task 1) resolves the same `p := coalesce(new.attributed_to, new.actor_id)` — a pre-flight asking about a different principal than the control would produce a 403 naming the wrong one on any request that supplies `attributedTo`, which is the POS shape (the terminal acts, the supervisor is attributed — hazard 19). Asking `principal_has` about the identical principal makes the two answers agree by construction, and the control is still the guard, which additionally demands a *second* principal. That is why Task 1 built `principal_has` as a parameterised twin rather than leaving `actor_has` to serve both.

  The Zod `z.enum([…])` of literals is **not** a `permission-catalogue` finding: that rule collects `PERMISSION.<code>`, `requirePermission('<code>')` and `principalHas('<code>')` references only (§3.6.3), and a bare string in an enum matches none of the three. `override_code text references app.permission(code)` then refuses at the data layer any code whose slice has not seeded it — F-21 in SQL — which is what the last case of the test asserts.
2. **`DELETE …/{documentId}` is gated `requireDocumentPermission("create")`.** §4.5.4 assigns "creating or editing the draft itself" to the create stage, and deleting a draft is editing it to nothing. It carries `request.headers: IdempotencyHeader` like every other unsafe method (§4.2.7).

3. **`GET …/{documentId}/events` declares no query schema at all.** Every other list route in the system takes `ListQuery` and answers with a cursor, but a document's timeline is bounded by its own transitions — a handful of rows, never a page — and `listDocumentEvents(tx, documentId)` (Task 3) has no `limit`/`cursor` parameters to honour. Declaring `ListQuery` here and ignoring it would advertise `?limit=1` in the OpenAPI document and then return every row with `next_cursor: null`, which is worse than declaring nothing: a client cannot tell a truncated page from a complete one. So the route registers **no `query`**, `DocumentEventQuery` is **not created**, and the response still uses `ListEnvelope` because §4.2.8 admits no bare-array list response — its `next_cursor` is a constant `null` and the handler says why. If a later slice needs paging here (7B's `accounting.document_event_log` is the likely one), it adds the parameters to `listDocumentEvents` and the query schema in the same PR.

4. **`POST …/reverse` is gated `requirePermission(PERMISSION["accounting.document.reverse"], { company: "path:companyId", branch: "document" })` — with the branch, not without it.** `app.actor_has(code, company, null)` means *company-wide* authority and, by Plan 0A's definition, is "granted only by an unexpired assignment with NO branch rows" (plan0A:1361). A `branch_manager` or a branch accountant holds every code through a branch-restricted assignment (§4.2.1, R8), so a company-scoped gate would refuse them at **every** branch — the reverse of what branch scoping is for. `{ branch: "document" }` is the `ScopeSource` variant §4.2.5 provides for exactly this ("the branch of the document named by path `:documentId`"), and 0B's `resolveScope` resolves it to `null` when the document is invisible, so a cross-tenant call still reaches the handler and answers 404 from `reverseDocument` rather than leaking a 403. Step 2 asserts both halves: a branch-scoped reverser succeeds at their own branch, and the cross-tenant call is still 404.

- [ ] **Step 1: Add the seven schemas to `packages/contracts/src/accounting/document.ts`**

Append below Task 7's widened `TransitionBody`; export all six from `packages/contracts/src/index.ts` beside the existing `accounting/document` re-exports.

```ts
/** contracts §4.5.4. `effectiveDate` is the reversing document's own date — D13 never back-dates into a
 *  closed period, so the caller states it and `postDocument` refuses a closed one (ERR_PERIOD_NOT_OPEN). */
export const ReverseDocumentBody = z.object({
  effectiveDate: DateSchema,
  reason: z.string().min(1).max(2000),
});

/** `number` is the reversing document's number, serialised as a string: it is a `bigint` in `reverseDocument`'s
 *  return (contracts §4.3.1) and JSON has no bigint. */
export const ReverseDocumentResultSchema = z.object({
  reversalDocumentId: UuidSchema,
  number: z.string().regex(/^\d+$/),
});

/**
 * contracts §4.5.3. The three codes are `OverrideCode`'s members (contracts §4.3.1) spelled as literals,
 * because none of them is in the permission catalogue at 2B and `PermissionCode` therefore cannot express
 * them. The route resolves authority from this value at request time; the data-layer guard is the control.
 */
export const OverrideBody = z.object({
  code: z.enum([
    "inventory.negative_stock.override",
    "accounting.credit_limit.override",
    "pos.ticket.override",
  ]),
  reason: z.string().min(1).max(2000),
  attributedTo: UuidSchema.optional(),
});

export const OverrideResultSchema = z.object({ eventId: UuidSchema });

/** A draft, and only a draft (spec:2049). `deleted` is a literal so a client cannot read a 200 as a no-op. */
export const DeleteDocumentResultSchema = z.object({ documentId: UuidSchema, deleted: z.literal(true) });

/** contracts §4.5.2's columns as the wire sees them; `DocumentEventRow` (Task 3) is the row this mirrors. */
export const DocumentEventSchema = z.object({
  id: UuidSchema,
  eventKind: z.enum(["transition", "override"]),
  fromStatus: z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]),
  toStatus: z.enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"]),
  overrideCode: z.string().nullable(),
  actorId: UuidSchema,
  attributedTo: UuidSchema.nullable(),
  occurredAt: TimestampSchema,
  reason: z.string().nullable(),
});

/** No sibling `DocumentEventQuery`: the events route declares no query parameters (route decision 3). The
 *  envelope is still used because §4.2.8 admits no bare-array list response, and its `next_cursor` is always
 *  null — a document's timeline is bounded by its own transitions. */
export const DocumentEventList = ListEnvelope(DocumentEventSchema);
```

- [ ] **Step 2: Write the failing test `apps/api/test/routes/accounting/document-lifecycle.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Two helpers, one name: the PRODUCTION withTenant takes (sql, ctx, fn) and the TEST one takes
// (sql, tenantId, actorId, fn) — contracts §4.2.2, hazard 15. Both are needed here, so the test one is
// aliased at the import rather than shadowed.
import { withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7, withTenant as testWithTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
// apps/api/test/** already imports from tests/support/** through the named dependency-rule allowance 0B
// added for exactly this direction (contracts §4.17.1); no new allowance is needed here.
import { problemOf } from "../../../../../tests/support/api";

describe("reverse / overrides / delete / events — contracts §4.5.3, §4.5.4", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;
  let supervisor: string;

  const person = async (s: Seed, label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await testWithTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${s.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    await api.loadPrincipals();
    return id;
  };

  /** A posted JOURNAL through the public surface, so the test never writes app.document itself. */
  const posted = async (): Promise<string> => {
    const created = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: a.human,
      body: {
        documentTypeCode: "JOURNAL", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
        lines: [{ lineNo: 1, accountId: a.cash, debit: "9.0000" }, { lineNo: 2, accountId: a.sales, credit: "9.0000" }],
      },
    });
    const { id } = (await created.json()) as { id: string };
    await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: a.human, body: { to: "posted" } });
    return id;
  };

  const draft = async (): Promise<string> => {
    const created = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: a.human,
      body: {
        documentTypeCode: "JOURNAL", effectiveDate: "2026-01-15", currency: "MYR", branchId: a.hq,
        lines: [{ lineNo: 1, accountId: a.cash, debit: "4.0000" }, { lineNo: 2, accountId: a.sales, credit: "4.0000" }],
      },
    });
    return ((await created.json()) as { id: string }).id;
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    b = await seedTenantV2(api.db, "Beta");
    // a.human drafts, posts, reverses and reads the event log; the reverse route needs BOTH its own code and
    // the reversal type's approval.post, because reverseDocument posts the reversing document through the
    // Task 2 trigger (Task 5 Step 5 explains why the pair is deliberate).
    await grantCodes(api.db, a, {
      codes: ["accounting.journal.post", "accounting.document.reverse", "accounting.ledger.read"],
    });
    await grantCodes(api.db, b, { codes: ["accounting.journal.post", "accounting.document.reverse"] });
    supervisor = await person(a, "supervisor");
    // accounting.credit_limit.override is 4A's catalogue row and does not exist at 2B. app.permission is
    // global, has no RLS and is read-only for app_rw (plan0A:1254), so this container-local row proves the
    // mechanism without touching packages/contracts/permissions.ts — exactly as Tasks 1 and 3 do.
    await api.db.migrator`insert into app.permission (code, module, mutating, description)
      values ('accounting.credit_limit.override', 'accounting', true, 'test-local stand-in for 4A''s code')
      on conflict (code) do nothing`;
    await grantCodes(api.db, a, { principalId: supervisor, codes: ["accounting.credit_limit.override"] });
  });
  afterAll(async () => { await api.stop(); });

  it("POST …/reverse produces the reversing document and marks the original reversed (D13)", async () => {
    const id = await posted();
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${id}/reverse`, as: a.human,
      body: { effectiveDate: "2026-01-20", reason: "wrong account" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reversalDocumentId: string; number: string };
    expect(body.number).toMatch(/^\d+$/);
    const rows = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: a.human, requestId: "r" }, (tx) =>
      tx<{ status: string }[]>`select status::text as status from app.document
                                where id in (${id}, ${body.reversalDocumentId}) order by id = ${id} desc`);
    expect(rows.map((r) => r.status)).toEqual(["reversed", "posted"]);
  });

  it("POST …/reverse admits a BRANCH-SCOPED reverser at their own branch (route decision 4, spec:2166)", async () => {
    const id = await posted();                      // branch_id = a.hq
    const bm = await person(a, "branch-manager");
    // The shape R8 gives a branch manager: the codes come through an assignment WITH role_assignment_branch
    // rows, so app.actor_has(code, company, null) is FALSE for them (plan0A:1361). A company-scoped gate
    // would refuse this principal at every branch; `branch: "document"` asks about a.hq and admits them.
    // Both codes are needed for the same reason the case above states: the gate authorises the reversal, the
    // Task 2 trigger authorises the POSTING of the reversing document, whose branch is also a.hq.
    await grantCodes(api.db, a, {
      principalId: bm, codes: ["accounting.document.reverse", "accounting.journal.post"],
      branchIds: [a.hq], roleCode: "branch-reverse",
    });
    const [companyWide] = await withTenant(api.db.rw, { tenantId: a.tenant, actorId: bm, requestId: "bm" }, (tx) =>
      tx<{ ok: boolean }[]>`select app.actor_has('accounting.document.reverse', ${a.company}) as ok`);
    expect(companyWide!.ok).toBe(false);            // the gap a company-scoped gate would have opened
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${id}/reverse`, as: bm,
      body: { effectiveDate: "2026-01-20", reason: "wrong branch account" },
    });
    expect(res.status).toBe(200);
  });

  it("POST …/reverse is 403 for a principal without accounting.document.reverse", async () => {
    const id = await posted();
    const bystander = await person(a, "bystander");
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${id}/reverse`, as: bystander,
      body: { effectiveDate: "2026-01-20", reason: "not mine" },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("POST …/overrides admits a second principal who holds the code and refuses the creator (R8)", async () => {
    const id = await draft();
    const ok = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${id}/overrides`, as: supervisor,
      body: { code: "accounting.credit_limit.override", reason: "customer is good for it" },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { eventId: string }).toMatchObject({ eventId: expect.any(String) });

    await grantCodes(api.db, a, { codes: ["accounting.credit_limit.override"], roleCode: "self-override" });
    const refused = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${id}/overrides`, as: a.human,
      body: { code: "accounting.credit_limit.override", reason: "mine" },
    });
    expect(refused.status).toBe(409);
    expect((await problemOf(refused)).code).toBe("ERR_OVERRIDE_NOT_AUTHORISED");
  });

  it("POST …/overrides is 403 before the guard runs when the caller holds no such code", async () => {
    const id = await draft();
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${id}/overrides`, as: await person(a, "nobody"),
      body: { code: "accounting.credit_limit.override", reason: "passing by" },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).detail).toContain("accounting.credit_limit.override");
  });

  it("POST …/overrides names the ATTRIBUTED principal in its 403, not the caller", async () => {
    const id = await draft();
    const unauthorised = await person(a, "unauthorised-supervisor");
    // The POS shape: the caller acts and names the supervisor the override belongs to (hazard 19). The
    // supervisor is the one whose authority the guard checks, so the pre-flight must check the same principal
    // — a 403 naming the caller would send an operator to reset the wrong person's permissions.
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${id}/overrides`, as: supervisor,
      body: { code: "accounting.credit_limit.override", reason: "on their behalf", attributedTo: unauthorised },
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.detail).toContain(unauthorised);
    expect(problem.detail).not.toContain(supervisor);
  });

  it("POST …/overrides on a code no slice has seeded is refused by the data layer (F-21)", async () => {
    const id = await draft();
    await grantCodes(api.db, a, { principalId: supervisor, codes: [], roleCode: "no-codes" });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${id}/overrides`, as: supervisor,
      body: { code: "pos.ticket.override", reason: "6A's code, absent at 2B" },
    });
    // The pre-flight refuses first — nobody can hold a code app.permission does not contain — and the FK on
    // override_code is the second line of defence if a future route skips the pre-flight.
    expect([403, 409]).toContain(res.status);
    expect(["ERR_RBAC_FORBIDDEN", "ERR_CONFLICT_REFERENCE"]).toContain((await problemOf(res)).code);
  });

  it("DELETE …/{id} removes a draft and refuses an issued document (ERR_DOC_NOT_DRAFT)", async () => {
    const id = await draft();
    const gone = await api.request({ method: "DELETE", path: `/v1/companies/${a.company}/documents/${id}`, as: a.human });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ documentId: id, deleted: true });

    const issued = await draft();
    await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${issued}/transitions`, as: a.human, body: { to: "issued" } });
    const refused = await api.request({ method: "DELETE", path: `/v1/companies/${a.company}/documents/${issued}`, as: a.human });
    expect(refused.status).toBe(409);
    expect((await problemOf(refused)).code).toBe("ERR_DOC_NOT_DRAFT");
  });

  it("GET …/{id}/events returns the timeline oldest first, under accounting.ledger.read", async () => {
    const id = await draft();
    await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: a.human, body: { to: "submitted" } });
    await api.request({ method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: a.human, body: { to: "issued" } });
    const res = await api.request({ method: "GET", path: `/v1/companies/${a.company}/documents/${id}/events`, as: a.human });
    expect(res.status).toBe(200);
    const { items, next_cursor } = (await res.json()) as { items: { toStatus: string }[]; next_cursor: string | null };
    expect(items.map((e) => e.toStatus)).toEqual(["submitted", "issued"]);
    expect(next_cursor).toBeNull();

    const reader = await person(a, "no-ledger-read");
    const denied = await api.request({ method: "GET", path: `/v1/companies/${a.company}/documents/${id}/events`, as: reader });
    expect(denied.status).toBe(403);
  });

  it("all four routes 404 across tenants and reveal nothing (test 12; spec:106)", async () => {
    const bDoc = await api.request({
      method: "POST", path: `/v1/companies/${b.company}/documents`, as: b.human,
      body: {
        documentTypeCode: "JOURNAL", effectiveDate: "2026-01-15", currency: "MYR", branchId: b.hq,
        lines: [{ lineNo: 1, accountId: b.cash, debit: "1.0000" }, { lineNo: 2, accountId: b.sales, credit: "1.0000" }],
      },
    });
    const { id } = (await bDoc.json()) as { id: string };
    const attempts = [
      { method: "POST", path: `/v1/companies/${a.company}/documents/${id}/reverse`, body: { effectiveDate: "2026-01-20", reason: "x" } },
      { method: "POST", path: `/v1/companies/${a.company}/documents/${id}/overrides`, body: { code: "accounting.credit_limit.override", reason: "x" } },
      { method: "DELETE", path: `/v1/companies/${a.company}/documents/${id}` },
      { method: "GET", path: `/v1/companies/${a.company}/documents/${id}/events` },
    ] as const;
    for (const attempt of attempts) {
      const res = await api.request({ ...attempt, as: a.human });
      expect(res.status, attempt.path).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
    }
    const [survived] = await withTenant(api.db.rw, { tenantId: b.tenant, actorId: b.human, requestId: "r" }, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.document where id = ${id}`);
    expect(survived!.n).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run --cwd apps/api test -- test/routes/accounting/document-lifecycle.test.ts`
Expected: FAIL — every case 404s from the router, because none of the four paths is registered. The cross-tenant case is the one that passes for the wrong reason; Step 5 re-runs it once the routes exist.

- [ ] **Step 4: Register the four routes in `apps/api/src/routes/accounting/documents.ts`**

Add to the imports:

```ts
import { reverseDocument, recordOverride, listDocumentEvents, type OverrideCode } from "@dulja/db";
import {
  DeleteDocumentResultSchema, DocumentEventList, OverrideBody, OverrideResultSchema,
  ReverseDocumentBody, ReverseDocumentResultSchema,
} from "@dulja/contracts";
```

```ts
/** contracts §4.5.4. D13: the reversing document is created, posted and the original marked `reversed` in one
 *  transaction. The route's own gate is `accounting.document.reverse` **at the document's own branch** — a
 *  branch-restricted assignment must be able to reverse there, and `actor_has(code, company, null)` would
 *  refuse it (route decision 4, plan0A:1361). The *posting* of the reversing document is authorised
 *  separately by the Task 2 trigger against the reversal type's `approval.post` (Task 5). */
documentRoutes.openapi(
  createRoute({
    method: "post", path: "/{documentId}/reverse", tags: ["accounting"],
    middleware: [requirePermission(PERMISSION["accounting.document.reverse"], { company: "path:companyId", branch: "document" })],
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      body: { content: { "application/json": { schema: ReverseDocumentBody } } },
    },
    responses: {
      200: { description: "Reversed", content: { "application/json": { schema: ReverseDocumentResultSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await c.var.withTenant((tx) =>
      reverseDocument(tx, c.var.ctx, { documentId, effectiveDate: body.effectiveDate, reason: body.reason }));
    return c.json({ reversalDocumentId: result.reversalDocumentId, number: result.number.toString() }, 200);
  },
);

/**
 * contracts §4.5.3. The gate is inline and not `requirePermission`, for the two reasons the task states: the
 * code is a body value, and no `OverrideCode` member is in the catalogue at 2B. The control is
 * `document_event_override_guard` (migration 0021), which demands a SECOND principal — this pre-flight only
 * turns "you do not hold this code" into a 403 with a remedy instead of a 409 from a trigger.
 *
 * It asks `principal_has` about `attributedTo ?? actorId`, the identical principal the guard resolves, so the
 * two can never disagree about WHOSE authority was missing.
 */
documentRoutes.openapi(
  createRoute({
    method: "post", path: "/{documentId}/overrides", tags: ["accounting"],
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, documentId: UuidSchema }),
      body: { content: { "application/json": { schema: OverrideBody } } },
    },
    responses: {
      200: { description: "Recorded", content: { "application/json": { schema: OverrideResultSchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await c.var.withTenant(async (tx) => {
      const [doc] = await tx<{ company_id: string; branch_id: string }[]>`
        select company_id, branch_id from app.document where id = ${documentId} and company_id = ${companyId}`;
      if (!doc) throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      // The principal whose authority the GUARD will check (contracts §4.5.3): the attributed supervisor when
      // the caller names one, otherwise the acting principal. Asking about any other principal here would
      // produce a 403 naming the wrong one.
      const bearer = body.attributedTo ?? c.var.ctx.actorId;
      const [allowed] = await tx<{ ok: boolean }[]>`
        select app.principal_has(${bearer}, ${body.code}, ${doc.company_id}, ${doc.branch_id}) as ok`;
      if (!allowed?.ok) {
        throw new AppError("ERR_RBAC_FORBIDDEN",
          `principal ${bearer} does not hold ${body.code} at branch ${doc.branch_id}`);
      }
      return recordOverride(tx, c.var.ctx, {
        documentId, code: body.code as OverrideCode, reason: body.reason,
        ...(body.attributedTo === undefined ? {} : { attributedTo: body.attributedTo }),
      });
    });
    return c.json(result, 200);
  },
);

/** contracts §4.5.4, ADR 0030. Drafts only — `document_delete_draft_only` (migration 0023) is the control and
 *  raises ERR_DOC_NOT_DRAFT; the AFTER DELETE `audit_row` trigger keeps the before-image (spec:2049). */
documentRoutes.openapi(
  createRoute({
    method: "delete", path: "/{documentId}", tags: ["accounting"],
    middleware: [requireDocumentPermission("create")],
    request: { headers: IdempotencyHeader, params: z.object({ companyId: UuidSchema, documentId: UuidSchema }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: DeleteDocumentResultSchema } } },
      409: { description: "Not a draft", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    await c.var.withTenant(async (tx) => {
      const rows = await tx`delete from app.document where id = ${documentId} and company_id = ${companyId}`;
      if (rows.count === 0) throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
    });
    return c.json({ documentId, deleted: true as const }, 200);
  },
);

/**
 * contracts §4.5.4: "membership + the type's module read code". At 2B the only module a `document_type` can
 * carry is `accounting` (2A's migration 0018 defaults the column and no other module's read code exists), so
 * the map has one row and a default deny — the same shape 2C ships for attachments (§4.5.8), and deliberately
 * NOT a shared helper: 2C owns that map and two spellings of it would be a hazard-32 finding.
 */
const MODULE_READ_CODE = { accounting: PERMISSION["accounting.ledger.read"] } as const;

documentRoutes.openapi(
  createRoute({
    method: "get", path: "/{documentId}/events", tags: ["accounting"],
    // No `query`: route decision 3. A timeline is bounded by its own transitions, listDocumentEvents takes no
    // limit or cursor, and advertising ListQuery while ignoring it would let a caller believe ?limit=1 worked.
    request: { params: z.object({ companyId: UuidSchema, documentId: UuidSchema }) },
    responses: {
      200: { description: "The document's timeline", content: { "application/json": { schema: DocumentEventList } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, documentId } = c.req.valid("param");
    const events = await c.var.withTenant(async (tx) => {
      const [doc] = await tx<{ module: string; company_id: string; branch_id: string }[]>`
        select t.module, d.company_id, d.branch_id
          from app.document d join app.document_type t on t.id = d.document_type_id
         where d.id = ${documentId} and d.company_id = ${companyId}`;
      if (!doc) throw new AppError("ERR_NOT_FOUND", `no document ${documentId} in company ${companyId}`);
      const code = MODULE_READ_CODE[doc.module as keyof typeof MODULE_READ_CODE];
      if (code === undefined) {
        throw new AppError("ERR_RBAC_FORBIDDEN",
          `module ${doc.module} has no read code at this release; its slice adds the row (contracts §4.5.8)`);
      }
      const [allowed] = await tx<{ ok: boolean }[]>`
        select app.actor_has(${code}, ${doc.company_id}, ${doc.branch_id}) as ok`;
      if (!allowed?.ok) throw new AppError("ERR_RBAC_FORBIDDEN", `principal ${c.var.ctx.actorId} does not hold ${code}`);
      return listDocumentEvents(tx, documentId);
    });
    // The list is returned WHOLE and `next_cursor` is a constant null, which is honest because the route
    // declares no `limit` and no `cursor` to honour (route decision 3). `ListEnvelope` is still used, because
    // §4.2.8 admits no bare-array list response.
    return c.json({ items: events, next_cursor: null }, 200);
  },
);
```

In **`apps/api/src/routes/index.ts`** — not `documents.ts`; that is where `ROUTES` lists the module (§4.2.7) and where 2A set `permissions: DOCUMENT_STAGE_CODES`, which Task 7 Step 4 verified — widen the documents module's `permissions` to:

```ts
  permissions: [
    ...DOCUMENT_STAGE_CODES,
    PERMISSION["accounting.document.reverse"],   // the reverse route's gate — Task 5's catalogue row
    PERMISSION["accounting.ledger.read"],        // the events route's module read code
  ],
```

**`DOCUMENT_STAGE_CODES` itself is not touched** — Task 7's test pins it to the two `accounting.journal.*` codes, and it means "codes a seeded type's policy may name at a stage", which neither of these two is.

- [ ] **Step 5: Run the tests and regenerate the OpenAPI document**

Run: `bun run --cwd apps/api test -- test/routes/accounting/document-lifecycle.test.ts test/routes/accounting/documents.test.ts`
Expected: **PASS** (10 + Task 7's cases). Three failures worth naming in advance: if the first reverse case returns 409 `ERR_RBAC_FORBIDDEN` rather than 200, the `beforeAll` granted `accounting.document.reverse` but not `accounting.journal.post` — the trigger authorises the *posting* of the reversing document separately, which is Task 5 Step 5's deliberate pair; if the **branch-scoped** reverse case returns 403, the route's scope is `{ company: "path:companyId" }` without `branch: "document"` and `actor_has(code, company, null)` refused a principal who holds the code only at `a.hq` (route decision 4); if the events case returns the two rows in the wrong order, `listDocumentEvents` was changed to order by `occurred_at`, which is the transaction start and identical for every event of one transaction (Task 3).

Run: `bun run --cwd tests test -- invariants/tenant-isolation.test.ts`
Expected: PASS — the four routes mount on the existing `/v1/companies/:companyId/documents` module, so `PROBES` needs no new key (Task 7) and the harness's "every `ROUTES` entry has a `PROBES` entry" assertion is unchanged. The per-endpoint cross-tenant assertion spec:106 demands is the last case of Step 2.

Run: `bun run lint`
Expected: **PASS — the first green `bun run lint` since Task 5.** `permission-catalogue` now finds `PERMISSION["accounting.document.reverse"]` in `documents.ts`, which is the reference Task 5 Step 6 predicted would arrive here.

Run: `bun run --cwd packages/contracts openapi:generate && git diff --stat packages/contracts/openapi.json`
Expected: a non-empty diff (four paths, six schemas); commit it in Step 6.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/accounting/document.ts packages/contracts/src/index.ts \
        packages/contracts/openapi.json apps/api/src/routes/accounting/documents.ts \
        apps/api/src/routes/index.ts \
        apps/api/test/routes/accounting/document-lifecycle.test.ts
git commit -m "$(cat <<'EOF'
feat(api): reverse, overrides, draft delete and the document event log [2B T8]

The rest of contracts 4.5.4. POST .../reverse is the route 2A's amendment A7
left to this slice together with accounting.document.reverse, so handler and
catalogue row land in one PR and the permission-catalogue lint is green again;
its gate carries branch: "document", because a branch-restricted assignment is
how R8 shapes a branch manager and a company-scoped gate would refuse them
everywhere. POST .../overrides gates inline rather than through
requirePermission, because the override code is a body value and no OverrideCode
member is in the catalogue yet; the second-principal guard in migration 0021
remains the control, and 4.5.3's sentence is amended rather than quietly
ignored. DELETE serves Task 4's grant behind ERR_DOC_NOT_DRAFT, and GET
.../events reads the timeline under the owning module's read code with a default
deny and no query schema it could not honour.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Acceptance test 16, and the Phase 2 definition-of-done clause

spec:2434 gives test 16 four clauses — "Concurrent creation of the first document of a new type succeeds for both. Issued numbers are unique per (series, period). Deletion of an issued document is impossible. Voided numbers are recorded." — and spec:2288 adds the sentence this slice owns: **"issued numbers are unique and gapless-provable"**. This file is the gate for all five. Every clause is exercised on a *new* series so the counter row does not exist when the race starts, which is precisely SAH-051's failure ("`for update with lock` locks nothing when no row matches, so two transactions creating the first document of a new muniment both read NULL and both insert").

The "deletion is impossible" clause is proved on **three paths**, because spec:2224 says "at any privilege level": the HTTP `DELETE` route of Task 8, a transaction under the tenant's **system principal** — the identical context every pg-boss handler receives from `runJob` (§4.2.6), built with the production `systemContext`, which is the one principal for whom `app.actor_has` returns true unconditionally (spec:2179) — and a bare `delete` as `app_rw`.

**Files:**
- Create: `tests/invariants/numbering-gapless.test.ts`
- Modify: none.

**Interfaces:**
- Consumes: `withTenant`, `systemContext`, `type TenantContext` (§4.2.2); `transitionDocument`, `voidDocument`, `postDocument`, `runIntegrityCheck` from `@dulja/db` (Task 3, 1A, 1B); `seedDocumentType`, `seedTenantV2`, `uuidv7`, `withTenant as testWithTenant` from `@dulja/db/test` (2A, 1A, Plan 0A); `startApi`, `type StartedApi` from `apps/api/test/support/app.ts` (§4.2.12 — reached through the same allowance 0B's `tests/support/api.ts` uses, so no new `dependency-rule` entry is needed); `grantCodes` (Task 2); `postgres` for the two-connection cases (already a `tests` dependency — 1A Task 14 uses it).
- Produces: nothing importable. **This file is the deliverable** — 2B's share of the Phase 2 definition of done.

- [ ] **Step 1: Write the test `tests/invariants/numbering-gapless.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  postDocument, runIntegrityCheck, systemContext, transitionDocument, voidDocument, withTenant,
  type TenantContext,
} from "@dulja/db";
import { grantCodes, seedDocumentType, seedTenantV2, uuidv7, withTenant as testWithTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";

/**
 * Acceptance test 16 (spec:2434) and the Phase 2 DoD clause "issued numbers are unique and gapless-provable"
 * (spec:2288). SAH-051 is the defect: a race on the first document of a new series, no uniqueness constraint,
 * numbers assigned at insert rather than at issue, and no way to demonstrate the sequence is unbroken.
 *
 * The mechanism is spread across three slices and this file is where the sentence becomes a gate:
 *   the advisory lock and the counter — 1A (contracts §4.3.6);
 *   the unique constraint `(company_id, series, fiscal_period_id, number)` — Plan 0A migration 0001;
 *   `app.series_gaps`, the two draft-only DELETE guards and `SERIES_GAP_CHECK` — 2B Task 4.
 */
describe("acceptance test 16 — numbering is unique, gapless-provable and undeletable", () => {
  let api: StartedApi;
  let a: Seed;
  let ngType: string;                        // numbers into series "NG"
  let ngPeriod: string;                      // a period of its own, so every counter starts empty
  const ctx = (s: Seed): TenantContext => ({ tenantId: s.tenant, actorId: s.human, requestId: "test16" });

  /** A JOURNAL-shaped policy whose only difference is the series it numbers into. */
  const policyFor = (series: string) => ({
    version: 1, documentType: `NG_${series}`, direction: "internal", requires: [],
    lines: [
      { for: "each_line", side: "debit", account: { from: "line.account" }, amount: "line.debit", when: { "line.kind": "account" } },
      { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
    ],
    inventory: { effect: "none" }, tax: { applies: false },
    numbering: { series, assignAt: "issue" },
    reversal: { allowed: true, producesType: `NG_${series}` },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    dimensions: { required: [] },
  });

  const draft = async (typeId: string, series: string, periodId: string, on: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await testWithTenant(api.db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id, fiscal_period_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId}, ${series}, ${on}, 'MYR', ${a.hq}, ${periodId})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 7.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 7.0000)`;
    });
    return id;
  };

  const gaps = (series: string, periodId: string) =>
    withTenant(api.db.rw, ctx(a), (tx) => tx<{ number: string }[]>`
      select number::text as number from app.series_gaps(${a.company}, ${series}, ${periodId}) order by 1`);

  const counter = (series: string, periodId: string) =>
    withTenant(api.db.rw, ctx(a), (tx) => tx<{ next_number: string }[]>`
      select next_number::text as next_number from app.document_series
       where company_id = ${a.company} and series = ${series} and fiscal_period_id = ${periodId}`);

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await grantCodes(api.db, a, { codes: ["accounting.journal.post"] });
    ngPeriod = await uuidv7(api.db.admin);
    await testWithTenant(api.db.migrator, a.tenant, a.system, (tx) => tx`
      insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status)
      values (${ngPeriod}, ${a.tenant}, ${a.company}, '2029-01-01', '2029-01-31', 'open')`);
    ngType = await seedDocumentType(api.db, a, { code: "NG_NG", policy: policyFor("NG"), effectiveFrom: "2026-01-01" });
  });
  afterAll(async () => { await api.stop(); });

  it("clause 1 — two connections racing the FIRST document of a new series both succeed, with 1 and 2", async () => {
    const raceType = await seedDocumentType(api.db, a, { code: "NG_RC", policy: policyFor("RC"), effectiveFrom: "2026-01-01" });
    const left = await draft(raceType, "RC", ngPeriod, "2029-01-10");
    const right = await draft(raceType, "RC", ngPeriod, "2029-01-10");
    expect(await counter("RC", ngPeriod)).toEqual([]);           // the counter row does not exist yet — SAH-051

    // Two real connections, max: 1 each — the interleaving spec:2266 asks for, not two promises on one pool.
    const one = postgres(api.db.url("app_rw"), { max: 1, prepare: false });
    const two = postgres(api.db.url("app_rw"), { max: 1, prepare: false });
    try {
      const results = await Promise.all([
        withTenant(one, ctx(a), (tx) => transitionDocument(tx, ctx(a), { documentId: left, to: "issued" })),
        withTenant(two, ctx(a), (tx) => transitionDocument(tx, ctx(a), { documentId: right, to: "issued" })),
      ]);
      expect(results.map((r) => r.number).sort()).toEqual([1n, 2n]);
    } finally {
      await one.end();
      await two.end();
    }
    expect(await gaps("RC", ngPeriod)).toEqual([]);
  });

  it("clause 1 through the HTTP surface — two concurrent transitions on one API instance", async () => {
    const httpType = await seedDocumentType(api.db, a, { code: "NG_HT", policy: policyFor("HT"), effectiveFrom: "2026-01-01" });
    const left = await draft(httpType, "HT", ngPeriod, "2029-01-11");
    const right = await draft(httpType, "HT", ngPeriod, "2029-01-11");
    const move = (id: string) => api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${id}/transitions`, as: a.human, body: { to: "issued" },
    });
    const [l, r] = await Promise.all([move(left), move(right)]);
    expect([l.status, r.status]).toEqual([200, 200]);
    const numbers = await withTenant(api.db.rw, ctx(a), (tx) => tx<{ number: string }[]>`
      select number::text as number from app.document where id in (${left}, ${right}) order by number`);
    expect(numbers.map((n) => n.number)).toEqual(["1", "2"]);
  });

  it("clause 2 — a second document cannot take an issued number, at any privilege level", async () => {
    const first = await draft(ngType, "NG", ngPeriod, "2029-01-12");
    await withTenant(api.db.rw, ctx(a), (tx) => transitionDocument(tx, ctx(a), { documentId: first, to: "issued" }));
    const impostor = await draft(ngType, "NG", ngPeriod, "2029-01-12");
    // app_rw, writing the number by hand — the SAH-051 "a client supplying its own number" path.
    await expect(testWithTenant(api.db.rw, a.tenant, a.human, (tx) =>
      tx`update app.document set number = 1 where id = ${impostor}`),
    ).rejects.toThrow(/duplicate key value|document_company_id_series_fiscal_period_id_number_key/);
    // and the migrator, which owns the schema and still cannot do it — the constraint is not a privilege
    await expect(testWithTenant(api.db.migrator, a.tenant, a.system, (tx) =>
      tx`update app.document set number = 1 where id = ${impostor}`),
    ).rejects.toThrow(/duplicate key value/);
  });

  it("clause 3 — an issued document cannot be deleted through the API, a job, or app_rw SQL (spec:2224)", async () => {
    const doc = await draft(ngType, "NG", ngPeriod, "2029-01-13");
    await withTenant(api.db.rw, ctx(a), (tx) => transitionDocument(tx, ctx(a), { documentId: doc, to: "issued" }));

    // (a) the HTTP route of Task 8
    const res = await api.request({ method: "DELETE", path: `/v1/companies/${a.company}/documents/${doc}`, as: a.human });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "ERR_DOC_NOT_DRAFT" });

    // (b) the job path: the tenant's system principal, the context runJob hands every handler (§4.2.6). At 2B
    // no registered handler changes document status, so the context is built with the production
    // systemContext — the same function runJob calls — rather than simulated. actor_has returns true for this
    // principal unconditionally (spec:2179), so the trigger is the only thing standing in its way.
    const sys = await systemContext(api.db.rw, a.tenant, "test16-job");
    await expect(withTenant(api.db.rw, sys, (tx) => tx`delete from app.document where id = ${doc}`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT/);

    // (c) direct app_rw SQL, and its lines one row at a time
    await expect(withTenant(api.db.rw, ctx(a), (tx) => tx`delete from app.document where id = ${doc}`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    await expect(withTenant(api.db.rw, ctx(a), (tx) =>
      tx`delete from app.document_line where document_id = ${doc} and line_no = 1`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT/);

    const [alive] = await withTenant(api.db.rw, ctx(a), (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.document where id = ${doc}`);
    expect(alive!.n).toBe(1);
  });

  it("clause 4 — a voided number is recorded, and stays an explained number forever (spec:1745)", async () => {
    const doc = await draft(ngType, "NG", ngPeriod, "2029-01-14");
    const { number } = await withTenant(api.db.rw, ctx(a), (tx) =>
      transitionDocument(tx, ctx(a), { documentId: doc, to: "issued" }));
    await withTenant(api.db.rw, ctx(a), (tx) =>
      voidDocument(tx, ctx(a), { documentId: doc, reason: "printer jam; reissued" }));
    const [recorded] = await withTenant(api.db.rw, ctx(a), (tx) => tx<{ number: string; reason: string }[]>`
      select number::text as number, reason from app.document_number_void
       where company_id = ${a.company} and series = 'NG' and fiscal_period_id = ${ngPeriod}
         and number = ${String(number)}::bigint`);
    expect(recorded).toEqual({ number: String(number), reason: "printer jam; reissued" });
    // The clause "voided numbers are recorded" is the assertion above, not the one below: `voidDocument`
    // updates only `status` (1a:3657) and leaves `document.number` in place, so this number is still
    // excluded by series_gaps' document predicate and the line below would read empty with an empty
    // document_number_void. It says the series is still whole, which is worth asserting on its own. That the
    // void RECORD is what series_gaps consults is proved where it can be isolated — the `VOIDONLY` case of
    // packages/db/test/document-delete.test.ts, on a series with no document at all.
    expect(await gaps("NG", ngPeriod)).toEqual([]);
  });

  it("the DoD clause — every counter in the tenant has zero unexplained numbers", async () => {
    const posted = await draft(ngType, "NG", ngPeriod, "2029-01-15");
    await withTenant(api.db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: posted }));
    const counters = await withTenant(api.db.rw, ctx(a), (tx) => tx<
      { company_id: string; series: string; fiscal_period_id: string }[]
    >`select company_id, series, fiscal_period_id from app.document_series order by series`);
    expect(counters.length).toBeGreaterThan(2);                  // NG, RC, HT at least — not a vacuous pass
    for (const c of counters) {
      const rows = await withTenant(api.db.rw, ctx(a), (tx) => tx<{ number: string }[]>`
        select number::text as number from app.series_gaps(${c.company_id}, ${c.series}, ${c.fiscal_period_id})`);
      expect(rows, `series ${c.series}`).toEqual([]);
    }
  });

  it("a rolled-back issue leaves no gap, because it consumes no number (spec:1744)", async () => {
    const doomed = await draft(ngType, "NG", ngPeriod, "2029-01-16");
    const before = await counter("NG", ngPeriod);
    await expect(withTenant(api.db.rw, ctx(a), async (tx) => {
      await transitionDocument(tx, ctx(a), { documentId: doomed, to: "issued" });
      throw new Error("rolled back on purpose");
    })).rejects.toThrow(/rolled back on purpose/);
    expect(await counter("NG", ngPeriod)).toEqual(before);
    expect(await gaps("NG", ngPeriod)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, and read the result before going on**

Run: `bun run --cwd tests test -- invariants/numbering-gapless.test.ts`

**Expected: PASS, seven cases** — and that is the correct outcome, because an acceptance test is a *gate*, not a driver of production code: Tasks 1–8 built the mechanism and this file is what makes the Phase 2 sentence checkable in CI. Three specific failures are possible and each has a different response:

1. `function app.series_gaps(uuid, unknown, uuid) does not exist` — migration 0023 is not applied in this container. `startApi()` migrates on boot (§4.2.12); if it does not, the `tests` workspace is pointing at a stale database.
2. Clause 1 reports `[1n, 1n]` or a unique-violation — `issueDocument` is taking the advisory lock **after** reading the counter, or is not taking it at all. That is SAH-051 exactly, and it is 1A's `contracts §4.3.6` SQL, not this slice's; fix it there and re-run 1A's `posting/issue.test.ts` too.
3. Clause 3 (b) succeeds — the delete went through under the system principal. That means `document_delete_draft_only` was created as a `BEFORE DELETE … WHEN (…)` trigger or with a `security definer` function; Task 4's form is an unconditional row-level BEFORE DELETE, which no principal escapes.

- [ ] **Step 3: Prove the assertions can fail — the falsifiability pass**

A green acceptance test that cannot go red proves nothing, and two of the cases above could pass vacuously: `app.series_gaps` returns zero rows for a counter that does not exist, and a `for` loop over an empty counter list asserts nothing. Both are guarded in Step 1 (`expect(await counter("RC", ngPeriod)).toEqual([])` before the race, and `expect(counters.length).toBeGreaterThan(2)`), and this step demonstrates the guards work. Append to the same file:

```ts
  it("the proof itself bites: a counter advanced past an unexplained number is reported", async () => {
    // The only way to manufacture an unexplained number is to advance a counter without issuing — the shape a
    // bug in the posting service would produce, which is what the nightly job must catch (Task 4).
    const holePeriod = await uuidv7(api.db.admin);
    await testWithTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status)
               values (${holePeriod}, ${a.tenant}, ${a.company}, '2029-02-01', '2029-02-28', 'open')`;
      await tx`insert into app.document_series (tenant_id, company_id, series, fiscal_period_id, next_number)
               values (${a.tenant}, ${a.company}, 'HOLE', ${holePeriod}, 3)`;
    });
    expect((await gaps("HOLE", holePeriod)).map((r) => r.number)).toEqual(["1", "2"]);

    // and it reaches the nightly integrity run through SERIES_GAP_CHECK, under the job's own principal
    const sys = await systemContext(api.db.rw, a.tenant, "test16-integrity");
    const report = await withTenant(api.db.rw, sys, (tx) => runIntegrityCheck(tx, sys));
    expect(report.projections.checked).toContain("document_series");
    expect(report.projections.mismatches.map((m) => m.key.number)).toContain("1");
    expect(report.ok).toBe(false);
  });
```

- [ ] **Step 4: Run the whole tests tier**

Run: `bun run --cwd tests test`
Expected: **PASS** (eight cases here, plus every 0B/1A/1B invariant suite). One failure worth naming in advance: if 1B's `projection-rebuild.test.ts` now reports a `document_series` mismatch, a *previous* suite in the same container left a manufactured `HOLE` counter behind — this file creates its own period for that row precisely so it cannot bleed, and a bleed means the file was edited to reuse `a.period`.

- [ ] **Step 5: Commit**

```bash
git add tests/invariants/numbering-gapless.test.ts
git commit -m "$(cat <<'EOF'
test(invariants): acceptance test 16 and the gapless-numbering DoD clause [2B T9]

All four clauses of spec:2434 on a series whose counter row does not exist when
the race starts, which is SAH-051 exactly. "Deletion of an issued document is
impossible" is proved on three paths — the HTTP route, a transaction under the
tenant's system principal (the context runJob hands every handler, and the one
principal for which actor_has always returns true), and bare app_rw SQL. The
last case is the falsifiability pass: a manufactured counter advance is reported
by app.series_gaps and surfaces in runIntegrityCheck as a mismatch, so the green
above is a measurement and not a vacuous pass.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Acceptance tests 10 and 31: R1 and R2 through the API, a job, and `app_rw` SQL

Test 10 (spec:2428) is one sentence — "a user cannot set a document's approval state above their own authority **through any endpoint or side effect**" — and test 31 (spec:2449) adds "through any path — API, job, or direct SQL as `app_rw`". The two are the same claim at two altitudes, and both are SAH-032: the legacy trigger checked only the *old* approval level, never that the new one was within the actor's own authority, and a second door promoted a document when a boolean was flipped without checking the actor at all.

This file is the gate for the **mechanism**. Test 31's sentence names five document types that do not exist yet and two clauses that belong to other slices; the ownership split is stated in the file itself and re-checked here:

| Clause of test 31 | Proved by |
|---|---|
| the submitter cannot approve or post, on a type whose policy requires approval | **this file**, on the configured type `SOD_TEST` |
| the same on `STOCK_COUNT` · `PAYMENT` · `PAYROLL` · `PAYROLL_PAYMENT` / `EMPLOYEE_ADVANCE` | 3D · 4A · 8B · 8C, each re-running this file's shape on its own type (§6.1) |
| a principal cannot alter their own compensation, sensitive data or leave approval (R4) | 8A (`ERR_HR_SELF_PAY`), 8D for leave ⚠️ |
| a principal cannot change their own role assignments or a held role's permissions (R5) | Plan 0A's `forbid_self_grant`, re-run through the API by 0B — **re-asserted here** so this file reads as a complete statement of what SoD means today |

**Contracts §4.14 (document-type code register) already registers this task's code — verify, do not re-file (Task 12 Step 1):** **`SOD_TEST`** — module `accounting`, `direction: "internal"`, `inventory: { effect: "none" }`, `approval: { required: true, approve: "accounting.journal.create", post: "accounting.journal.post" }`, series `SD`, `reversal.producesType: "SOD_TEST"`, **test only, never seeded into a pack**. Contracts §5 item 32 makes an unregistered document-type code a review-blocking finding, and the two codes are deliberately *different* — that is what lets one principal hold `approve` and not `post`, which is the "above their own authority" half of test 10. Both are in the catalogue at 2B (1A, §3.6.2), which is what `validatePolicy` demands (F-21). This mirrors 2A's amendment A1 for `POLICY_TEST`.

**Files:**
- Create: `tests/invariants/segregation-of-duties.test.ts`
- Modify: none.

**Interfaces:**
- Consumes: `withTenant`, `systemContext`, `type TenantContext` (§4.2.2); `transitionDocument`, `recordOverride` from `@dulja/db` (Task 3); `seedDocumentType`, `seedTenantV2`, `uuidv7`, `grantCodes`, `withTenant as testWithTenant` from `@dulja/db/test` (2A, 1A, Task 2, Plan 0A); `startApi`, `type StartedApi` from `apps/api/test/support/app.ts` (§4.2.12 — the `tests` tier already reaches it through the allowance 0B's `tests/support/api.ts` relies on, so no new `dependency-rule` entry is needed).
- Produces: nothing importable. **This file is the deliverable** — the mechanism behind tests 10 and 31, and the §3.0.4 SoD clause of spec:1065.

- [ ] **Step 1: Write the test `tests/invariants/segregation-of-duties.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordOverride, systemContext, transitionDocument, withTenant, type TenantContext } from "@dulja/db";
import { grantCodes, seedDocumentType, seedTenantV2, uuidv7, withTenant as testWithTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";

/**
 * Acceptance tests 10 (spec:2428) and 31 (spec:2449). SAH-032: the legacy trigger checked only the OLD
 * approval level — `old."AdtSign" > "UserSign"` — and never that the new one was within the actor's own
 * authority, then stamped an approval date to make the forgery look genuine. A second door promoted a
 * document when a boolean was flipped, with no check of the actor at all.
 *
 * The fix is that both controls live in ONE place — the BEFORE UPDATE OF status trigger of migration 0022
 * (ADR 0029) — so there is no "other door" to find. This file proves that by asserting the identical
 * behaviour on three paths that share no application code:
 *   the HTTP route, where the Task 6 middleware pre-flights and returns 403 with a remedy;
 *   the job path, under the tenant's system principal — the context `runJob` hands every handler (§4.2.6),
 *     built with the production `systemContext` because at 2B no registered handler changes document status;
 *   a bare UPDATE as `app_rw`, which is what an admin at a psql prompt, the importer and a future handler
 *     that forgets the helper all reduce to.
 */
describe("acceptance tests 10 and 31 — approval authority and segregation of duties", () => {
  let api: StartedApi;
  let a: Seed;
  let sodType: string;
  let maker: string;                 // holds approve + post, and submits
  let checker: string;               // holds approve + post, and does not submit
  let approverOnly: string;          // holds approve and NOT post — test 10's "above their own authority"
  let outsider: string;              // holds nothing
  const ctx = (s: Seed, actorId: string): TenantContext => ({ tenantId: s.tenant, actorId, requestId: "sod" });

  const SOD_TEST = {
    version: 1, documentType: "SOD_TEST", direction: "internal", requires: [],
    lines: [
      { for: "each_line", side: "debit", account: { from: "line.account" }, amount: "line.debit", when: { "line.kind": "account" } },
      { for: "each_line", side: "credit", account: { from: "line.account" }, amount: "line.credit", when: { "line.kind": "account" } },
    ],
    inventory: { effect: "none" }, tax: { applies: false },
    numbering: { series: "SD", assignAt: "issue" },
    reversal: { allowed: true, producesType: "SOD_TEST" },
    // approve and post are DIFFERENT codes on purpose: that is what makes "above their own authority" testable.
    approval: { required: true, approve: "accounting.journal.create", post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    dimensions: { required: [] },
  };

  const person = async (label: string, codes: readonly string[]): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await testWithTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${a.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
    });
    if (codes.length > 0) await grantCodes(api.db, a, { principalId: id, codes, roleCode: `sod-${label}` });
    await api.loadPrincipals();
    return id;
  };

  /**
   * A SOD_TEST document with two balanced lines, INSERTED DIRECTLY at `status`. Both status triggers are
   * `... update of status` triggers, so an INSERT fires neither and the row carries no `document_event`
   * history: `draftAt("submitted")` is the only way to reach a submitted document with no submitted event,
   * which is the one state in which R1's first clause can speak. Reaching `submitted` by UPDATE would have
   * written that event, and starting from `draft` never reaches R1 at all — the matrix refuses
   * `draft → approved` as an illegal pair first (migration 0022, block 2a before block 2b).
   */
  const draftAt = async (status: string, on = "2026-01-15"): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await testWithTenant(api.db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, status, effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${sodType}, 'SD', ${status}::app.document_status, ${on}, 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 8.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 8.0000)`;
    });
    return id;
  };

  /** A draft of SOD_TEST — the ordinary starting point for every case but R1's first. */
  const draft = (on = "2026-01-15"): Promise<string> => draftAt("draft", on);

  /** One status change as `actor`, by bare app_rw UPDATE — the lowest path there is. */
  const bySql = (documentId: string, to: string, actor: string, reason: string | null = null) =>
    withTenant(api.db.rw, ctx(a, actor), async (tx) => {
      await tx`select set_config('app.event_reason', ${reason ?? ""}, true),
                      set_config('app.event_attributed_to', '', true)`;
      await tx`update app.document set status = ${to}::app.document_status where id = ${documentId}`;
    });

  /** The same change through the service seam, as a job would. */
  const byJob = async (documentId: string, to: "submitted" | "approved" | "draft") => {
    const sys = await systemContext(api.db.rw, a.tenant, "sod-job");
    return withTenant(api.db.rw, sys, (tx) => transitionDocument(tx, sys, { documentId, to, reason: "job" }));
  };

  /** And through HTTP. */
  const byApi = (documentId: string, to: string, actor: string, reason?: string) =>
    api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${documentId}/transitions`,
      as: actor, body: { to, ...(reason === undefined ? {} : { reason }) },
    });

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await grantCodes(api.db, a, { codes: ["accounting.journal.create", "accounting.journal.post"] });
    maker = a.human;
    checker = await person("checker", ["accounting.journal.create", "accounting.journal.post"]);
    approverOnly = await person("approver-only", ["accounting.journal.create"]);
    outsider = await person("outsider", []);
    // effectiveFrom is passed explicitly, for the reason Step 2's failure note 1 gives: seedDocumentType's
    // default is 2A's and app.effective_policy must pick this row for the 2026-01-15 documents below.
    sodType = await seedDocumentType(api.db, a, { code: "SOD_TEST", policy: SOD_TEST, effectiveFrom: "2026-01-01" });
  });
  afterAll(async () => { await api.stop(); });

  it("R1 — approving a submitted document with no submitted event is ERR_SOD_NO_SUBMISSION on all three paths", async () => {
    // Each row is INSERTED at `submitted` (see draftAt): a document moved there by any of the three paths
    // would carry the submitted event the AFTER trigger wrote, and a document still in `draft` never reaches
    // R1 at all — the matrix refuses `draft → approved` first. This is the state R1's first clause exists for.
    const [forApi, forJob, forSql] = [await draftAt("submitted"), await draftAt("submitted"), await draftAt("submitted")];

    const res = await byApi(forApi, "approved", checker);
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "ERR_SOD_NO_SUBMISSION" });

    await expect(byJob(forJob, "approved")).rejects.toThrow(/ERR_SOD_NO_SUBMISSION/);
    await expect(bySql(forSql, "approved", checker)).rejects.toThrow(/ERR_SOD_NO_SUBMISSION/);
  });

  // The job path is NOT in this loop: the acting principal there is the tenant's system principal, so
  // "submitter approves their own document" needs the job to have submitted it too — which is precisely the
  // next case, where byJob submits and byJob approves. Naming a third path here and then skipping its
  // maker-is-checker assertion would overstate what runs (a vacuous iteration).
  it("R1 — the submitter can neither approve nor post their own document, on the API and SQL paths", async () => {
    for (const path of ["api", "sql"] as const) {
      const doc = await draft();
      await bySql(doc, "submitted", maker, "mine");

      if (path === "api") {
        const res = await byApi(doc, "approved", maker);
        expect(res.status).toBe(409);
        expect((await res.json()) as { code: string; detail: string }).toMatchObject({ code: "ERR_SOD_MAKER_IS_CHECKER" });
      } else {
        await expect(bySql(doc, "approved", maker)).rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER: principal .* cannot approve it/);
      }

      // …and the same at the posting edge, once a genuine second principal has approved and issued it.
      await bySql(doc, "approved", checker, "checked");
      await bySql(doc, "issued", checker);
      await expect(bySql(doc, "posted", maker)).rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER: principal .* cannot post it/);
      await bySql(doc, "posted", checker);
    }
  });

  /** The job path's R1 binding, which the loop above deliberately leaves to this case. */
  it("R1 binds the system principal too: a job cannot approve what the same job submitted", async () => {
    const doc = await draft();
    await byJob(doc, "submitted");
    await expect(byJob(doc, "approved")).rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER/);
    // A human second principal can, because the submitted actor was the system principal and not this one.
    await bySql(doc, "approved", checker, "checked by a human");
    const [row] = await withTenant(api.db.rw, ctx(a, checker), (tx) =>
      tx<{ status: string }[]>`select status::text as status from app.document where id = ${doc}`);
    expect(row!.status).toBe("approved");
  });

  it("R2 — a principal without the policy's code is refused, and the API's 403 is not the control", async () => {
    const doc = await draft();
    await bySql(doc, "submitted", maker, "for review");

    // The HTTP path stops at the Task 6 pre-flight: 403, naming the code the policy resolved.
    const res = await byApi(doc, "approved", outsider);
    expect(res.status).toBe(403);
    const problem = (await res.json()) as { code: string; detail: string };
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("accounting.journal.create");     // approval.approve, not .post

    // Remove the pre-flight from the picture entirely and the answer is identical — 409 from the trigger.
    // This assertion is the whole point of ADR 0029: deleting the middleware would not weaken the control.
    await expect(bySql(doc, "approved", outsider)).rejects.toThrow(
      /ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.journal\.create/);
  });

  it("test 10 — a principal cannot act above their own authority: approve yes, post no", async () => {
    const doc = await draft();
    await bySql(doc, "submitted", maker, "for review");
    await bySql(doc, "approved", approverOnly, "within my authority");
    await bySql(doc, "issued", approverOnly);
    // `approverOnly` holds approval.approve and not approval.post. Issuing consumes a number and commits
    // nothing (ADR 0029), so it is admitted; posting is refused.
    await expect(bySql(doc, "posted", approverOnly)).rejects.toThrow(
      /ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.journal\.post/);
    const [row] = await withTenant(api.db.rw, ctx(a, checker), (tx) =>
      tx<{ status: string }[]>`select status::text as status from app.document where id = ${doc}`);
    expect(row!.status).toBe("issued");
  });

  it("test 10 — there is no side effect that raises the state: every illegal pair is refused", async () => {
    const doc = await draft();
    // draft → approved / posted / void / reversed, with a reason and a fully authorised actor. Each is
    // ERR_DOC_STATUS_ILLEGAL and nothing else: the matrix runs before R1 and R2, and it names no pair out of
    // `draft` but `submitted` and `issued`. (`ERR_SOD_NO_SUBMISSION` belongs to the first case in this file,
    // which starts from a row INSERTED at `submitted` — it is not reachable from a draft.)
    for (const to of ["approved", "posted", "void", "reversed"]) {
      await expect(bySql(doc, to, checker, "trying"), `draft → ${to}`).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL/);
    }
    // and no event was written for any of them, so nothing "looks like" an approval afterwards (SAH-032)
    const events = await withTenant(api.db.rw, ctx(a, checker), (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.document_event where document_id = ${doc}`);
    expect(events[0]!.n).toBe(0);
  });

  it("R2 does not bind the system principal — asserted, so nobody 'fixes' it by accident", async () => {
    // spec:2179: "the system principal holds no role, but app.actor_has() returns true for it so server-side
    // jobs can read RLS-gated rows — it is reachable only from jobs and the seed CLI, never from a request
    // path (RC-1)". The matrix and R1 still bind it (the two cases above); R2 deliberately does not. If this
    // assertion ever fails, every scheduled job in the system has stopped working, which is the intended
    // alarm — it is not a licence to weaken R1.
    const sys = await systemContext(api.db.rw, a.tenant, "sod-authority");
    const [row] = await withTenant(api.db.rw, sys, (tx) =>
      tx<{ ok: boolean }[]>`select app.actor_has('accounting.journal.post', ${a.company}, ${a.hq}) as ok`);
    expect(row!.ok).toBe(true);
  });

  it("the override door cannot launder authority: a job's blanket authority does not carry to the attributed principal", async () => {
    const doc = await draft();
    await api.db.migrator`insert into app.permission (code, module, mutating, description)
      values ('accounting.credit_limit.override', 'accounting', true, 'test-local stand-in for 4A''s code')
      on conflict (code) do nothing`;
    const sys = await systemContext(api.db.rw, a.tenant, "sod-override");
    // The guard checks principal_has(attributed_to ?? actor_id, …) — NOT actor_has — so attributing an
    // override to a principal who does not hold the code is refused even though the acting principal is the
    // system one, for which actor_has is unconditionally true. This is the assertion 6C's sync apply and 4A's
    // credit control both depend on (contracts §4.5.3, R8 spec:2179).
    await expect(withTenant(api.db.rw, sys, (tx) =>
      recordOverride(tx, sys, {
        documentId: doc, code: "accounting.credit_limit.override", reason: "job says so", attributedTo: outsider,
      })),
    ).rejects.toThrow(/ERR_OVERRIDE_NOT_AUTHORISED: principal .* does not hold accounting\.credit_limit\.override/);
  });

  it("test 31's R5 clause still holds: no self-grant, no self-escalation (Plan 0A, re-asserted)", async () => {
    // Plan 0A's forbid_self_grant proved this and 0B re-ran it through the API; it is re-asserted here so this
    // file is a complete statement of what segregation of duties means at this release.
    const roleId = await uuidv7(api.db.admin);
    await testWithTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'sod-self', 'Self')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${checker}, ${roleId}, ${a.company})`;
    });
    await expect(withTenant(api.db.rw, ctx(a, checker), (tx) => tx`
      insert into app.role_permission (tenant_id, role_id, permission_code)
      values (${a.tenant}, ${roleId}, 'accounting.period.close')`),
    ).rejects.toThrow(/ERR_RBAC_SELF_ESCALATION|ERR_RBAC_SELF_GRANT/);
  });
});
```

- [ ] **Step 2: Run it, and read the result before going on**

Run: `bun run --cwd tests test -- invariants/segregation-of-duties.test.ts`

**Expected: PASS, nine cases. This is a gate run, not a TDD red step** — like Task 9, this file measures a mechanism Tasks 1–8 already built, so a green first run is the intended outcome and there is deliberately no "run it to verify it fails" step before it. Four failures are possible and each has a different response:

1. `ERR_POLICY_INVALID … declares no approval.post` from the very first case — `seedDocumentType` inserted the policy at a `version`/`effectiveFrom` that `app.effective_policy` does not pick for `2026-01-15`. `seedDocumentType`'s default `effectiveFrom` is 2A's; pass `effectiveFrom: "2026-01-01"` explicitly rather than changing the helper (hazard 9).
2. The R2 case's HTTP half returns **409** instead of 403 — the transitions route is not mounting `requireDocumentPermission` for the `approved` stage. Check Task 7's `STAGE_FOR` map: `approved → "approve"`.
3. The R2 case's SQL half **succeeds** — the trigger resolved the gate as `approval.post` for the `approved` transition, or skipped the check because `approve` was null. `SOD_TEST` declares both, so this means Task 2's §2c wrote `v_gate := v_post` unconditionally instead of `coalesce(v_approve, v_post)`.
4. The first case reports `ERR_DOC_STATUS_ILLEGAL: draft → approved` on all three paths — the three rows were created with `draft()` instead of `draftAt("submitted")`. The matrix (block 2a) runs before R1 (block 2b), so `ERR_SOD_NO_SUBMISSION` is genuinely unreachable from a `draft` row; the fix is in this test file and **never** in the trigger, whose block order is contracts §4.5.1 verbatim.

- [ ] **Step 3: Confirm the coverage claim by grepping for the clauses this file does not own**

Run: `grep -rn "ERR_HR_SELF_PAY\|hr.leave.approve" tests/ packages/ apps/ || echo "not yet — 8A and 8D"`
Expected: no match, and the `echo` fires. Test 31's R4 clause and its leave half are 8A's and 8D's (§6.1); this file's ownership table says so, and the grep is what keeps that table honest — when 8A lands, its own file appends the clause and this grep stops being empty. **Do not add a stub or an `it.skip` for those clauses here**: a skipped test for another slice's work is a false coverage signal.

- [ ] **Step 4: Run the whole tests tier**

Run: `bun run --cwd tests test`
Expected: **PASS.** One failure worth naming in advance: if 0B's `tenant-isolation.test.ts` now fails on the documents module, this file's `SOD_TEST` type leaked into the shared container that `sharedApi()` memoises — it must not, because this file calls `startApi()` itself and owns its container.

- [ ] **Step 5: Commit**

```bash
git add tests/invariants/segregation-of-duties.test.ts
git commit -m "$(cat <<'EOF'
test(invariants): acceptance tests 10 and 31 — the SoD mechanism [2B T10]

R1 and R2 asserted identically through the HTTP route, a transaction under the
tenant's system principal (the context runJob hands every handler) and a bare
app_rw UPDATE. The pair of assertions in the R2 case is the point of ADR 0029:
the API returns 403 with a remedy, and removing the middleware entirely would
still leave the trigger's 409 — the control is in the data layer, which is what
SAH-032 lacked.

The type is the configured SOD_TEST (contracts 4.14 amendment, test-only) whose
approve and post codes differ, so "above their own authority" is testable: a
principal holding approve issues and cannot post. Test 31's R4 and leave clauses
belong to 8A and 8D and are named, not stubbed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The seven regression appends

spec:2059 requires one `tests/regression/sah-NNN.test.ts` per defect touched. All seven files this slice touches were **created by 0B** (§3.7.3's twenty-one thin files for Plan 0A-proven defects, plus `sah-023`), so every block below is an **append**: one new `describe("SAH-NNN <Part I heading> — 2B", …)` placed after the existing blocks, and **no earlier block is edited**. Suffixed file names are forbidden.

**Two mechanics, stated once and applied to all seven.**

- Each block opens with `const { db } = await sharedDb();` and seeds its own tenant with `seedTenantV2(db, "SAH0NN-2B")`. `sharedDb()` is 0B's, in `tests/support/regression.ts`, and returns `{ db, rw, a, b }` (contracts §4.17.1). Its own `a`/`b` are bare `seedTenant` seeds whose JOURNAL policy is Plan 0A's placeholder with **no `approval` block**, so a block that transitions past `issued` must seed its own V2 tenant — which is also what keeps the blocks independent of each other's rows.
- **A discrepancy to expect, not to resolve here (hazard 7).** 1A's regression blocks import `sharedDb` from `../invariants/probes` and use the result as a bare `Db` (`db.rw`, `db.admin`), while 0B — the owner per §4.17.1 — declares it in `tests/support/regression.ts` returning `{ db, rw, a, b }`. Write the blocks below against **0B's** shape; if the merged file exports 1A's, the change is one line per block (`const db = await sharedDb();`) and no assertion moves. The mismatch is reported upward as a question for the contracts document.

**Files:**
- Modify (append one `describe` block to each): `tests/regression/sah-023.test.ts`, `sah-032.test.ts`, `sah-040.test.ts`, `sah-041.test.ts`, `sah-042.test.ts`, `sah-051.test.ts`, `sah-072.test.ts`
- Create: none.

**Interfaces:**
- Consumes: `sharedDb` (0B, `tests/support/regression.ts`); `withTenant`, `postDocument`, `transitionDocument`, `voidDocument` from `@dulja/db`; `seedTenantV2`, `grantCodes`, `uuidv7`, `withTenant as testWithTenant` from `@dulja/db/test`.
- Produces: nothing importable.

- [ ] **Step 1: Append the seven blocks**

The imports below cover all seven blocks. In each file add only the names **that file's own block actually uses**, and only those it does not already import — an unused import fails `typecheck` under `noUnusedLocals`.

```ts
import { describe, expect, it } from "vitest";
import { postDocument, transitionDocument, voidDocument, withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7, withTenant as testWithTenant } from "@dulja/db/test";
import { sharedDb } from "../support/regression";
```

A helper each block repeats in full rather than sharing, because a shared helper in `tests/regression/` would be a file every slice edits (§3.7.3's whole point):

```ts
// tests/regression/sah-023.test.ts — append
describe("SAH-023 Audit sequence numbers are renumbered retroactively and collide across document classes — 2B", () => {
  it("document_event has no per-class counter to renumber: identity is a time-ordered uuidv7 and nothing else", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "SAH023-2B");
    // The legacy defect was two procedures (procVouAuditID, procBilAuditID) both restarting at 1 and both
    // feeding one column, so inserting a back-dated voucher shifted every later document's audit number.
    // Here there IS no number: the lifecycle record is keyed by uuidv7 and ordered by it.
    const numeric = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'document_event'
         and data_type in ('integer', 'bigint', 'smallint', 'numeric')`;
    expect(numeric).toEqual([]);
    const first = await uuidv7(db.admin);
    const second = await uuidv7(db.admin);
    expect(first < second).toBe(true);                       // lexicographic order is chronological order
    // and the ONE sequence the system does keep — app.audit_log.seq — is per tenant across every table,
    // never per document class (plan0A's audit_chain; 0B's own block above proves the chain).
    const [audit] = await db.admin<{ n: number }[]>`
      select count(distinct table_name)::int as n from app.audit_log where tenant_id = ${s.tenant}`;
    expect(audit!.n).toBeGreaterThan(0);
  });
});
```

```ts
// tests/regression/sah-032.test.ts — append
describe("SAH-032 A user can raise a document's approval level above their own — 2B", () => {
  it("the authority check is in the data layer, so there is no second door to find", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "SAH032-2B");
    const doc = await uuidv7(db.admin);
    await testWithTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 3.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${s.tenant}, ${s.company}, ${doc}, 2, ${s.sales}, 3.0000)`;
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah032" };
    // s.human holds nothing: seedTenant grants no permission (contracts §4.1). The legacy check looked only
    // at the OLD level, so a user at sign 1 could write sign 9. Here the NEW state is authorised.
    await withTenant(db.rw, ctx, (tx) => transitionDocument(tx, ctx, { documentId: doc, to: "issued" }));
    await expect(withTenant(db.rw, ctx, (tx) => tx`update app.document set status = 'posted' where id = ${doc}`))
      .rejects.toThrow(/ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.journal\.post/);
    // and the "side door" shape — flipping a column to promote the document — does not exist: status is the
    // only path to posted, and it is the column the trigger watches.
    await grantCodes(db, s, { codes: ["accounting.journal.post"], roleCode: "sah032-post" });
    await withTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId: doc }));
    const [row] = await withTenant(db.rw, ctx, (tx) =>
      tx<{ status: string; posted_by: string }[]>`select status::text as status, posted_by from app.document where id = ${doc}`);
    expect(row).toEqual({ status: "posted", posted_by: s.human });
  });
});
```

```ts
// tests/regression/sah-040.test.ts — append
describe("SAH-040 Deletions are logged less reliably than inserts, and can erase the document header — 2B", () => {
  it("deleting a draft audits the header and every line, with the before-image, and no flag suppresses it", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "SAH040-2B");
    const doc = await uuidv7(db.admin);
    await testWithTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 2.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${s.tenant}, ${s.company}, ${doc}, 2, ${s.sales}, 2.0000)`;
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah040" };
    await withTenant(db.rw, ctx, (tx) => tx`delete from app.document where id = ${doc}`);
    // The legacy put the tombstone inside a `Silent` gate, so a delete could leave a header pointing at a
    // vanished transaction — and the archive module deleted with no logging call at all.
    const rows = await db.admin<{ table_name: string; n: number }[]>`
      select table_name, count(*)::int as n from app.audit_log
       where operation = 'DELETE' and tenant_id = ${s.tenant}
         and (before ->> 'id' = ${doc} or before ->> 'document_id' = ${doc})
       group by table_name order by table_name`;
    expect(rows).toEqual([
      { table_name: "document", n: 1 },
      { table_name: "document_line", n: 2 },                  // the cascade is audited too, row by row
    ]);
    const [image] = await db.admin<{ series: string; status: string }[]>`
      select before ->> 'series' as series, before ->> 'status' as status from app.audit_log
       where table_name = 'document' and operation = 'DELETE' and before ->> 'id' = ${doc}`;
    expect(image).toEqual({ series: "JV", status: "draft" });
  });
});
```

```ts
// tests/regression/sah-041.test.ts — append
describe("SAH-041 Documents are hard-deleted and the anti-tampering controls are shipped disabled — 2B", () => {
  it("a posted document cannot be hard-deleted, and both guard triggers are ENABLED, not inactive", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "SAH041-2B");
    await grantCodes(db, s, { codes: ["accounting.journal.post"], roleCode: "sah041-post" });
    const doc = await uuidv7(db.admin);
    await testWithTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 5.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${s.tenant}, ${s.company}, ${doc}, 2, ${s.sales}, 5.0000)`;
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah041" };
    await withTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId: doc }));
    await expect(withTenant(db.rw, ctx, (tx) => tx`delete from app.document where id = ${doc}`))
      .rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    // The legacy shipped its only guards as `inactive`. 'O' = enabled for origin; 'D' would be disabled.
    const triggers = await db.admin<{ tgname: string; tgenabled: string }[]>`
      select tgname, tgenabled::text as tgenabled from pg_trigger
       where tgname in ('document_delete_draft_only', 'document_line_delete_draft_only',
                        'document_status_before', 'document_status_after', 'document_event_immutable')
       order by tgname`;
    expect(triggers).toHaveLength(5);
    expect(triggers.every((t) => t.tgenabled === "O")).toBe(true);
  });
});
```

```ts
// tests/regression/sah-042.test.ts — append
describe("SAH-042 Ownership and paid-record checks fail open when the user row is missing — 2B", () => {
  it("app.principal_has never fails open: an unknown, unassigned, expired or wrong-branch principal is false", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "SAH042-2B");
    const ghost = await uuidv7(db.admin);                     // a principal that does not exist at all
    const expired = await uuidv7(db.admin);
    const roleId = await uuidv7(db.admin);
    await testWithTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${expired}, 'human', ${`expired:${s.tenant}`}, 'expired')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${expired})`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${s.tenant}, 'sah042', 'Lapsed')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${s.tenant}, ${roleId}, 'accounting.journal.post')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id, expires_at)
               values (${s.tenant}, ${expired}, ${roleId}, ${s.company}, now() - interval '1 day')`;
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah042" };
    const [r] = await withTenant(db.rw, ctx, (tx) => tx<
      { ghost: boolean; expired_row: boolean; unassigned: boolean; null_branch_ghost: boolean }[]
    >`select app.principal_has(${ghost},   'accounting.journal.post', ${s.company}, ${s.hq}) as ghost,
             app.principal_has(${expired}, 'accounting.journal.post', ${s.company}, ${s.hq}) as expired_row,
             app.principal_has(${s.human}, 'accounting.journal.post', ${s.company}, ${s.hq}) as unassigned,
             app.principal_has(${ghost},   'accounting.journal.post', ${s.company})          as null_branch_ghost`);
    // The legacy check was DEFEATED by supplying an invalid user: NULL <> 0 is unknown, so the guard was
    // skipped. Every answer here is a hard false, and omitting the branch buys nothing.
    expect(r).toEqual({ ghost: false, expired_row: false, unassigned: false, null_branch_ghost: false });
  });
});
```

```ts
// tests/regression/sah-051.test.ts — append
describe("SAH-051 Document numbering races on first use, has no uniqueness constraint, and cannot be gapless — 2B", () => {
  it("a void is a recorded number, a client cannot supply one, and series_gaps proves the sequence", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "SAH051-2B");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah051" };
    const make = async (): Promise<string> => {
      const id = await uuidv7(db.admin);
      await testWithTenant(db.rw, s.tenant, s.human, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${s.tenant}, ${s.company}, ${id}, 1, ${s.cash}, 1.0000)`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${s.tenant}, ${s.company}, ${id}, 2, ${s.sales}, 1.0000)`;
      });
      return id;
    };
    const first = await make();
    const second = await make();
    await withTenant(db.rw, ctx, (tx) => transitionDocument(tx, ctx, { documentId: first, to: "issued" }));
    await withTenant(db.rw, ctx, (tx) => transitionDocument(tx, ctx, { documentId: second, to: "issued" }));
    await grantCodes(db, s, { codes: ["accounting.journal.post"], roleCode: "sah051-post" });
    await withTenant(db.rw, ctx, (tx) => voidDocument(tx, ctx, { documentId: second, reason: "misprint" }));
    // The legacy left an unrecoverable gap with no record of what occupied it. Here the record exists — that
    // is the `voided` assertion below, and it is what SAH-051 lacked — and the series is still whole, which
    // is the assertion immediately after. The second does not prove the first: `voidDocument` updates only
    // `status` and leaves `document.number` in place, so number 2 is still excluded by series_gaps' document
    // predicate. The void row's own effect on series_gaps is isolated in the `VOIDONLY` case of
    // packages/db/test/document-delete.test.ts.
    const gaps = await withTenant(db.rw, ctx, (tx) => tx<{ number: string }[]>`
      select number::text as number from app.series_gaps(${s.company}, 'JV', ${s.period})`);
    expect(gaps).toEqual([]);
    const [voided] = await withTenant(db.rw, ctx, (tx) => tx<{ number: string; reason: string }[]>`
      select number::text as number, reason from app.document_number_void
       where company_id = ${s.company} and series = 'JV' and fiscal_period_id = ${s.period}`);
    expect(voided).toEqual({ number: "2", reason: "misprint" });
    // and a client-supplied number cannot survive: the number is assigned at ISSUE and the pair is unique.
    const third = await make();
    await expect(testWithTenant(db.rw, s.tenant, s.human, (tx) =>
      tx`update app.document set number = 1 where id = ${third}`)).rejects.toThrow(/duplicate key value/);
  });
});
```

```ts
// tests/regression/sah-072.test.ts — append
describe("SAH-072 Zero CHECK constraints across 460 tables, and 544 boolean columns encoding mutually exclusive states — 2B", () => {
  it("document_event carries one discriminator and a CHECK that makes every incoherent row impossible", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "SAH072-2B");
    // No boolean column at all: `event_kind` is the one discriminator, with a CHECK tying override_code and
    // the status pair to it (contracts §4.5.2) — not `is_override` + `is_transition` + `is_deleted`.
    const bools = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'document_event' and data_type = 'boolean'`;
    expect(bools).toEqual([]);
    const checks = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_constraint
       where conrelid = 'app.document_event'::regclass and contype = 'c'`;
    expect(checks[0]!.n).toBeGreaterThanOrEqual(2);            // event_kind's IN list and the coherence CHECK
    const doc = await uuidv7(db.admin);
    await testWithTenant(db.rw, s.tenant, s.human, (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`);
    for (const row of [
      { kind: "transition", from: "draft", to: "draft", code: null },        // a transition that changes nothing
      { kind: "override", from: "draft", to: "submitted", code: null },      // an override that moves the status
      { kind: "wandering", from: "draft", to: "submitted", code: null },     // a kind outside the closed set
    ]) {
      await expect(testWithTenant(db.rw, s.tenant, s.human, (tx) => tx`
        insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, override_code)
        values (${s.tenant}, ${s.company}, ${doc}, ${row.kind}, ${row.from}::app.document_status,
                ${row.to}::app.document_status, ${row.code})`), JSON.stringify(row),
      ).rejects.toThrow(/document_event_check|document_event_event_kind_check|violates check constraint/);
    }
  });
});
```

- [ ] **Step 2: Run the regression tier**

Run: `bun run --cwd tests test -- regression/`
**This is a gate run, not a TDD red step:** each block re-states, on the defect's own terms, a rule Tasks 1–8 already built and already proved, so a green first run is the intended outcome and there is deliberately no failing-first step before it. Expected: **PASS**, with each of the seven files reporting its earlier blocks plus one new `— 2B` block. Two failures worth naming in advance: if `sah-040` reports `{ table_name: "document_line", n: 0 }`, `app_meta.attach_audit` is not attached to `document_line` (1A migration 0011) and the cascade is going unaudited — that is a 1A defect this block has just found, and it is worth more than the block; if `sah-023`'s `numeric` assertion fails naming a column, somebody added a counter to `document_event`, which is the exact defect SAH-023 describes.

- [ ] **Step 3: Commit**

```bash
git add tests/regression/sah-023.test.ts tests/regression/sah-032.test.ts tests/regression/sah-040.test.ts \
        tests/regression/sah-041.test.ts tests/regression/sah-042.test.ts tests/regression/sah-051.test.ts \
        tests/regression/sah-072.test.ts
git commit -m "$(cat <<'EOF'
test(regression): the seven Part I defects this slice closes [2B T11]

One appended describe block per file, none of the existing blocks edited
(contracts 3.7.3). SAH-023 has no counter left to renumber; SAH-032's authority
check is in the trigger, so there is no second door; SAH-040 audits a delete
header and every cascaded line with its before-image; SAH-041's guards are
asserted ENABLED, which the legacy's were not; SAH-042's principal_has answers
false for a ghost, an expired assignment and an omitted branch alike; SAH-051's
void is a record and series_gaps is empty; SAH-072's document_event has one
discriminator, no booleans, and a CHECK that refuses every incoherent row.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: The slice exit gate: the contracts check, the full CI run, and the handoff to 2C

Nothing new is designed here. This task verifies that the fourteen contracts rows the slice's invented names require are already in the frozen document, then runs every gate the slice's claims rest on, in the order in which a failure is cheapest to diagnose, and records what 2C and 3A inherit. **This task modifies no file at all** — Step 1 reads, Steps 2 to 5 run gates, Step 6 writes a PR description. **No `CLAUDE.md` edit:** §3.8 gives the "Current phase" rewrite to the slice that *completes* a phase, and Phase 2 is completed by **2C**, not by this slice.

**Files:**
- Modify: **none.** `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` is **read-only** to this slice: the round-2 amendment pass (contracts §4.18) has already landed all fourteen of Step 1's rows, and Step 1 greps for them rather than writing them.
- Create: none.

**Interfaces:**
- Consumes: every artefact of Tasks 1–11; `lintSchema`, `up`, `down`, `listApplied` from `@dulja/db`; `schemaFingerprint` from `packages/db/test/privileges.test.ts` (Plan 0A, extended by 0B).
- Produces: nothing importable.

- [ ] **Step 1: Verify the fourteen contracts rows are already in the frozen document**

contracts §1 says a plan that needs a name the document lacks "changes *this document* first (one PR, reviewed) and only then the plan". **That round has already run for this slice.** **Fourteen rows** were invented or changed across Tasks 1–11 — eleven name rows (one of which registers three document-type codes), one file name and two behaviour changes — each declared in its own task's Produces block or route-decision note, and the round-2 amendment pass audited in contracts §4.18 folded every one of them into the frozen document. So this step **verifies** them and files nothing: the table below is the consolidated list, and the check under it is a grep over the document that must succeed. Twelve rows are pure additions and change no existing name; **two change something the contracts document already stated, and are marked so** — the shape of `TransitionResultSchema` (§4.2.8, additively: 1A's six members all survive) and the gate mechanism of §4.5.3's overrides route. Both are in the document now, each recorded there as the change it is.

| § | Amendment | Task |
|---|---|---|
| 4.5.2 | `app.effective_policy(p_document_type_id uuid, p_on date) returns jsonb` — §4.5.2 asks for "`resolvePolicy` semantics in SQL" and names no function; this is that function. It is the **trigger's** resolver only: the API middleware keeps 2A's TypeScript `resolvePolicy` call (§4.3.1), so the two exist side by side on purpose and neither replaces the other | T2 |
| 4.17 | `grantCodes(db, s, opts?: { codes?; principalId?; roleCode?; branchIds? }): Promise<string>` — the fixture the R2 trigger makes every posting test need, in §4.17's uniform `(db, s, opts?)` shape, returning the role id | T2 |
| 4.3.1 | `setEventContext(tx, { reason?, attributedTo? })` — the writer of the two session settings §4.5.2 fixes, exported because `reverse.ts` calls it too | T3 |
| 4.3.1 | `listDocumentEvents(tx, documentId): Promise<DocumentEventRow[]>` and `DocumentEventRow` — the read `GET …/events` serves | T3 |
| 3.5.4, 4.5.1 | `app.forbid_line_delete_unless_draft()` + trigger `document_line_delete_draft_only` — §3.5.4 grants DELETE on `document_line` and names only the parent's guard; without the child's, `app_rw` could delete a posted document's lines one row at a time | T4 |
| 3.4.2 | The migration file name `0023_grant_document_draft_delete_and_add_series_gaps.sql` extends the card's expected `0023_grant_document_draft_delete.sql`, because the file also creates `app.series_gaps` and §3.4.2 requires the name to say what the file does — the precedent is 2A's `0018_alter_document_party_fk_and_document_type_module.sql` | T4 |
| 4.16.3 | `SERIES_GAP_CHECK: ProjectionCheck` joins the registry §4.16.3 said 3A and 8C would extend; it is a third extender, and ADR 0030 records the `IntegrityReport.numberingGaps` member that would read better. **Note the consequence for consumers:** `IntegrityReport.projections.checked` becomes `["account_balance", "document_series"]`, and the pinned assertion on that array is updated in the same PR (Task 4 Step 7). §4.16.3 says *two* such assertions exist; only **one** does — `tests/invariants/audit-chain.test.ts`. Grep before believing either sentence, and see question 4 below | T4 |
| 4.14 | Register `GAP_TEST` — module `accounting`, series **`GAP`**, `approval: { required: false, approve: null, post: "accounting.journal.post" }`, **test only, never seeded into a pack**. It exists because `issueDocument` writes `policy.numbering.series` back onto the header (§4.3.6), so a gapless-numbering assertion about a series can only be non-vacuous against a type whose *policy* names that series | T4 |
| 4.5.4 | `stageCode(stage: DocumentStage, approval: PostingPolicy["approval"]): string` — the pure half of §4.5.4's stage map, exported from 2A's middleware in place of its private `codeFor` so a test can assert the map without a request and so 6C's sync apply and 8B's payroll routes resolve it identically. Returns `string`, not `PermissionCode`: a policy may name a code whose slice has not seeded it | T6 |
| 4.2.8 | **A shape change, not an addition:** `TransitionResultSchema` gains `from`, `to` and `eventId` — the three members §4.3.1's `TransitionResult` names — as a **superset**. All six of 1A's members (`documentId`, `status`, `number`, `series`, `fiscalPeriodId`, `ledgerEntryIds`) survive, because 1A's own route test asserts three of them and `docs/ui/phase-1-api-surface.md` publishes all six; the `TransitionResult` OpenAPI component name is unchanged | T7 |
| 4.2.8 | The `accounting/document.ts` row gains `ReverseDocumentBody`, `ReverseDocumentResultSchema`, `OverrideBody`, `OverrideResultSchema`, `DeleteDocumentResultSchema`, `DocumentEventSchema`, `DocumentEventList` — seven names. **No `DocumentEventQuery`:** `GET …/events` declares no query parameters, because `listDocumentEvents` takes no `limit`/`cursor` and advertising `ListQuery` while ignoring it would let a caller read a whole list as a first page (Task 8, route decision 3) | T8 |
| 4.5.3 | **A behaviour change, not an addition:** §4.5.3's sentence "under `requirePermission(code, { company: "path:companyId", branch: "document" })`" becomes an **inline `app.principal_has(coalesce(attributedTo, actorId), code, company, branch)` pre-flight in the handler**. `requirePermission` takes a compile-time `PermissionCode` and the override code is a body value; worse, no `OverrideCode` member is in the catalogue at 2B (§3.6.2 assigns them to 3A, 4A and 6A), so `PERMISSION[…]` does not typecheck. And the question must be asked about the **attributed** principal, because `document_event_override_guard` resolves the same `coalesce` — a pre-flight asking about a different principal would 403 naming the wrong one on every POS-shaped request. The scope is unchanged (the document's own company and branch); only the mechanism moves, and the guard remains the control | T8 |
| 4.14 | Register `NG_NG`, `NG_RC` and `NG_HT` — module `accounting`, series `NG`/`RC`/`HT`, `approval: { required: false, approve: null, post: "accounting.journal.post" }`, **test only, never seeded into a pack**. Three codes rather than one because acceptance test 16 numbers three independent series and one type may name only one series | T9 |
| 4.14 | Register `SOD_TEST` — module `accounting`, series `SD`, `approval: { required: true, approve: "accounting.journal.create", post: "accounting.journal.post" }`, **test only, never seeded into a pack** | T10 |

**The check.** Run this from the repository root; it only reads.

```bash
DOC=docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
missing=0
for s in \
  'app.effective_policy(p_document_type_id uuid, p_on date) returns jsonb' \
  'grantCodes(db, s, opts?: { codes?; principalId?; roleCode?; branchIds? })' \
  'setEventContext' \
  'listDocumentEvents' \
  'DocumentEventRow' \
  'document_line_delete_draft_only' \
  '0023_grant_document_draft_delete_and_add_series_gaps.sql' \
  'SERIES_GAP_CHECK' \
  'stageCode(stage, approval): string' \
  'ReverseDocumentBody' \
  'OverrideResultSchema' \
  'DeleteDocumentResultSchema' \
  'DocumentEventList' \
  'GAP_TEST' 'NG_NG' 'NG_RC' 'NG_HT' 'SOD_TEST' \
  '`TransitionResultSchema` grows to nine members as a superset' \
  "The route's gate is an inline \`app.principal_has\` pre-flight, not \`requirePermission\`" \
; do
  grep -qF -- "$s" "$DOC" || { echo "MISSING from $DOC: $s"; missing=1; }
done
exit "$missing"
```

Expected: **exit 0, no output.** Twenty strings, covering all fourteen rows — the last two are the sentences §4.2.8 and §4.5.3 now carry for the two changes, so a document that merely *mentions* the names but still states the old shape fails the check.

**A `MISSING from …` line is a stale checkout, not a licence to edit the document.** Pull the current contracts document and re-run. Nothing in this slice writes to it: if `git status` shows it modified at the end of this task, Step 1 was executed as an edit and must be reverted. A row present with a *different* shape is the same stop as everywhere else in this plan — the other side wins and the difference is reported, never overwritten.

**Four items are reported as questions rather than changes** (hazard 7 — a plan reports, it does not re-decide). **The first three are already on the record in contracts §4.18 — verify, do not re-file; the fourth is new and is reported with this slice's merge PR:**

- Question 1 is folded in as a §4.18 *correction* row: "**JOURNAL declares no `approval.create`** — the frozen seed file and `JOURNAL_POLICY_V1` both omit it, so `create`/`submit` resolve to `accounting.journal.post`. The prose said otherwise." Assumption 3 already implements §4.5.4's map verbatim, so no step of this slice changes.
- Question 2 is §4.18's **open item 5** (`sharedDb()`'s return shape, declared one way in §4.17.1 and used another way in 1A's regression blocks), still open and still named as a plan-side correction in one direction or a §4.17.1 amendment in the other.
- Question 3 is §4.18's **open item 4** (`app.document_event`'s foreign key), filed with the same two candidate shapes and the same rule — "**the slice that applies the answer replaces 2B's pinning test**". Task 4's `document-delete.test.ts` is that pinning test and stays exactly as written.
- **Question 4 is new to this slice and is not in §4.18** — report it with the merge PR and edit neither the contracts document nor 1B's test. §4.16.3 says that when `SERIES_GAP_CHECK` joins the registry, "**1B's two assertions on that array** — in `tests/invariants/audit-chain.test.ts` and `apps/worker/test/handlers/integrity-check.test.ts` — are updated in the same PR". Only the first of the two pins the array: 1B's worker handler test asserts on the report's `ok`, `summary` and recorded incident and never reads `projections.checked` (Task 4 Step 7 prints the grep that shows it, and Step 10 runs that suite expecting it to pass unchanged). The §4.16.3 sentence should read **one** pinned assertion, in `tests/invariants/audit-chain.test.ts` alone. **Do not add an edit to the worker test to make the document true** — a pinned assertion invented to match a sentence is a fabricated coverage claim, and the next slice to extend the registry would then have two files to chase instead of one.

The four as this slice reports them:

1. **JOURNAL's absent `approval.create`** — §4.4.1's prose says it is `accounting.journal.create`, the frozen seed file of §4.3.7 and the frozen `JOURNAL_POLICY_V1` of §4.17 both omit the member. ADR 0029 records it; assumption 3 implements §4.5.4's map verbatim regardless.
2. **The `sharedDb()` return-shape split** between §4.17.1's declaration and 1A's use (Task 11).
3. **`app.document_event`'s foreign key blocks the deletion of a draft that carries events.** §4.5.2 declares `foreign key (tenant_id, document_id) references app.document(tenant_id, id)` with no on-delete action, and the table is immutable to `app_rw`. So a draft that was round-tripped (`draft → submitted → draft`, the recalculation edge of spec:2081) or that received an override cannot be deleted at all: the DELETE fails with SQLSTATE 23503, surfacing as `ERR_CONFLICT_REFERENCE` rather than success or `ERR_DOC_NOT_DRAFT`. That contradicts spec:2049's "deletion for drafts" for the common case. **2B does not change it**, because the FK is contracts-verbatim and the alternative touches audit semantics; Task 4's `document-delete.test.ts` pins the present behaviour so it is visible, and the two shapes worth deciding between are: (a) `on delete cascade` on `document_event(tenant_id, document_id)` with `document_event_immutable` narrowed to `before update` — the `audit_row` trigger still keeps every before-image, so the record is not lost; or (b) `document_delete_draft_only` additionally refusing a draft that has events, with a message that says the document has a history and must be voided instead. The slice that applies the answer replaces the pinning test.
4. **§4.16.3 names two pinned `projections.checked` assertions where the repository has one** — `tests/invariants/audit-chain.test.ts`. `apps/worker/test/handlers/integrity-check.test.ts` asserts on the report's `ok`, `summary` and recorded incident and never reads the field (Task 4 Step 7's grep shows it; Step 10 runs that suite and expects it unchanged). The sentence is what should be corrected, to **one** pinned assertion; the worker test must not gain one to make the sentence true.

- [ ] **Step 2: The migration gate — up, down, up, and the linter**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db db:lint`
Expected: `21 22 23 24` applied (or fewer, if a parallel phase's range landed first — no assertion is ever made on `max(version)`, hazard 14) and **zero** linter violations.

Run: `bun run --cwd packages/db test -- test/privileges.test.ts`
Expected: **PASS** — 0B's generalised reversibility case walks `up → down → up` across the whole range and compares `schemaFingerprint` before and after; it now covers `document_event`, both draft-delete guards, the two status triggers, `app.principal_has`, `app.effective_policy`, `app.series_gaps` and the two new DELETE grants. One failure worth naming in advance: a fingerprint difference naming `document_event_override_guard` means `0021.down.sql` dropped the function without `cascade` and the trigger survived into the second `up`.

- [ ] **Step 3: The build checks**

Run: `bun run lint`
Expected: **PASS.** The four rules this slice could break, and what each would report: `error-codes` — the four new `ERRORS` rows are each raised as a token in migrations 0021/0022/0023; `permission-catalogue` — `accounting.document.reverse` is referenced by Task 8's route and every code in `DOCUMENT_STAGE_CODES` still has a reference; `no-bare-db` — every statement this slice adds is a `tx` tagged template (`sql.unsafe` has three homes and none is here, hazard 21); `posting-only-tables` — this slice writes `document`, `document_line`, `document_event` and `document_number_void`, none of them on that rule's list, and `recordOverride` lives in `packages/db/src/posting/` regardless.

Run: `bun run --cwd packages/contracts openapi:generate && git diff --exit-code packages/contracts/openapi.json`
Expected: **no diff** — Task 8 Step 6 committed the regenerated document, so this run is the CI check reproducing it (spec:2055).

Run: `bun run typecheck` (every workspace)
Expected: PASS.

- [ ] **Step 4: The whole test suite, in the order a failure is cheapest to read**

```bash
bun run --cwd packages/db test        # the data layer: 0021–0024, the triggers, the guards, the fixtures
bun run --cwd apps/api test          # the middleware and the five document routes
bun run --cwd apps/worker test       # 1B's integrity handler, now reporting document_series
bun run --cwd tests test             # the invariants, the regression tier, the golden fixtures
```

Expected: **PASS** throughout. The suites this slice changed that belong to earlier slices, and why: `packages/db/test/posting/post.test.ts`, `posting/reverse.test.ts` (four seed objects, because 2A appended a nested `describe` and an in-test seed), `posting/branch-required.test.ts` (2A) and `tests/regression/sah-013.test.ts` (2A, two seeds) each gained a `grantCodes` call (Task 2 Step 7) because R2 made posting an authorised act; `tests/invariants/support/post-journal.ts` gained one memoised grant, which is the single choke point for the whole `tests/` tier; `tests/invariants/audit-chain.test.ts` gained `"document_series"` in its pinned `projections.checked` array (Task 4 Step 7) — **it is the only file that pins that array**, and `apps/worker/test/handlers/integrity-check.test.ts` is deliberately *not* edited: 1B's handler test asserts on the report's `ok`, `summary` and recorded incident and never reads the field, which is why Task 4 Step 10 runs it and expects it to pass unchanged (the "two pinned assertions" of contracts §4.16.3 is an overstatement, reported as question 4 of Step 1); `packages/db/test/privileges.test.ts` gained two rows in the pinned DELETE list (Task 4 Step 8); `apps/api/test/routes/accounting/documents.test.ts` gained the `drafter` grant and the widened transitions cases (Task 7 Step 2). **`packages/db/test/documents.test.ts` and `packages/db/test/posting/issue.test.ts` are not edited by this slice** — assumption 1 explains why the matrix admits their `→ issued` writes untouched, and an edit to either is a signal that the matrix evaluates a gate it should not.

- [ ] **Step 5: The coverage roll-up**

Tick each row against the run above; a row that cannot be ticked is a merge blocker, not a follow-up.

| Claim | Where it is proved | §6 row |
|---|---|---|
| Acceptance test 10 — approval authority | `tests/invariants/segregation-of-duties.test.ts` (T10) | §6.1 owned |
| Acceptance test 16 — numbering | `tests/invariants/numbering-gapless.test.ts` (T9) | §6.1 owned |
| Acceptance test 31 — segregation of duties (mechanism) | `tests/invariants/segregation-of-duties.test.ts` (T10), with the R4/leave clauses named as 8A's and 8D's | §6.1 owned |
| Test 12 re-run — four new routes | the cross-tenant case of `document-lifecycle.test.ts` (T8) and the harness's unchanged `PROBES` key | §6.1 re-run |
| Test 13 re-run — `document` status writes audited, `document_event` immutable to `app_rw` | `document-event.test.ts` (T1), `sah-040` (T11) | §6.1 re-run |
| Test 36 re-run — `accounting.document.reverse` in catalogue, handler and role seed | `permission-catalogue.test.ts` (T5), `bun run lint` (T8) | §6.1 re-run |
| Test 1 re-run — the ledger invariant through the trigger path | 1A's fuzz suite, green under R2 after T2 Step 7 | §6.1 re-run |
| §3.0.4 spec:1041 — numbering; the approval state machine in `document_event` | T1–T4, T9, T10 (2A contributed the policy engine) | §6.2 **owned** |
| §3.0.4 spec:1065 — the "segregation of duties" clause | T2, T10 (0B owns the row) | §6.2 contributed |
| Phase 2 DoD — "issued numbers are unique and gapless-provable" | T4 + T9 | Part V |

- [ ] **Step 6: Record the handoff**

Append to **this slice's merge-PR description** the three facts the next slices need, so neither has to read this plan to find them:

- **2C** inherits `document_event` (its `attachment` upload writes no event), the draft-only DELETE grant (an attachment on a deleted draft is orphaned — 2C's `attachment.document_id` FK decides that, not this slice), `requireDocumentPermission` for its document screens, and `MODULE_READ_CODE` in `documents.ts` as the *local* precedent for the shared attachment download map of §4.5.8 — **2C owns that map and must not import this one.**
- **3A** inherits the override door: `app.assert_stock_available` reads `document_event` for an `inventory.negative_stock.override` row exactly as §4.5.3 describes, and `recordOverride` is the only writer. 3A seeds the code, so `OverrideBody`'s enum member becomes reachable in that PR with no change here.
- **6C** inherits `app.principal_has`, which is what re-verifies a cashier's authority at sync apply, and the `attributed_to` column that carries the supervisor whose PIN authorised an override (hazard 19 — the terminal acts, the cashier is attributed).

**This task commits nothing.** Step 1 reads the contracts document, Steps 2 to 5 run gates, and this step writes prose into a pull-request description — no file in the repository changes, so there is no `git add` and no commit here. The handoff facts live in the slice's merge PR, beside the tasks that produced them.

Run: `git status --porcelain`
Expected: **no output.** A modified `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` means Step 1 was executed as an edit instead of as a check — revert it (`git checkout -- docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`) and re-read Step 1: the round-2 amendment pass already landed all fourteen rows, and a hand-written row is a fork of the authority.

---

## Self-Review

Run against the spec, the contracts document and the writing-plans skill with fresh eyes. Issues found are fixed inline above; what follows is the record.

### 1. Spec and contracts coverage

| Requirement | Task | Note |
|---|---|---|
| §0.2 Never/Always (spec:97–106) | all | quoted verbatim in Global Constraints; the "no temporarily disabled invariant" clause is why Task 9's falsifiability pass manufactures *state* rather than disabling a trigger |
| §3.3 state-machine lines (spec:1188, 1190, 1201) | 2 | the matrix, with `submitted|approved → draft` as the one backward edge and a mandatory reason |
| §3.8 numbering block (spec:1717–1745) | 4, 9 | the counter is 1A's; `series_gaps` and the void record are this slice's. Both slices' assertions are made against a type whose *policy* names the series, because `issueDocument` writes `policy.numbering.series` back onto the header (§4.3.6) — a header-only series would make every gap assertion vacuous |
| §3.8 `document` status/void (spec:1747–1780) | 2, 3, 8 | `voidDocument` writes the status and `document_number_void` in one transaction |
| §3.8 `document_event` forward declaration (spec:1782–1787) | 1 | contracts §4.5.2 verbatim, `event_kind` resolving C11 |
| §3.8 audit-exempt / immutable lists (spec:1370) | 1 | `document_event` is already in both sets (plan0A:2705–2711); Task 1 edits no linter set and asserts that |
| §3.9 Deletion (spec:2049) | 4, 8, 11 | drafts only, "and both write an audit row first" proved by the `sah-040` block on the header **and** the cascaded lines |
| §3.9 Error codes (spec:2051) | 3, 4 | four rows, each landing in the same commit as the migration that raises its token — three in Task 3 Step 5 (0021/0022), `ERR_DOC_NOT_DRAFT` in Task 4 Step 9 (0023) — so `error-codes` is green at **every** commit |
| §3.10.1 recalculation rule (spec:2081) | 2, 7 | the backward edge needs a reason; R3's `compensation_changed` is the 8B caller of the same edge |
| §4.2.1 branch scoping (spec:2166) | 1, 2 | a NULL branch never fails open — asserted for `actor_has` (T2) and `principal_has` (T1, T11) |
| §4.2.2 R1 (spec:2172) | 2, 10 | AFTER trigger writes the event; BEFORE trigger fails closed on a missing or matching submitter |
| §4.2.2 R2 (spec:2173) | 2, 6, 10 | the trigger is the control; the middleware is a pre-flight, and Task 10 asserts the two agree |
| §4.2.2 R3 (mechanism) (spec:2174) | 2 | the `approved → draft` edge with a reason; 8B supplies `compensation_changed` |
| §4.2.2 R8 overrides (spec:2179) | 1, 3, 8, 10 | a second principal, per document, recorded as an event — never a session flag |
| §4.7 numbering / no deletion (spec:2222–2224) | 4, 9 | "gapless-provable" is a function; "no deletion at any privilege level" is proved on three paths |
| §4.11 keyboard parity (spec:2254) | — | **this slice ships no screen**; every Phase 2 screen is 2C's, which is why OD-24 gates no task here |
| Part V Phase 2 DoD (spec:2288) | 4, 9 | this slice's clause, quoted verbatim and assigned |
| Part VI **10** | 10 | **owned** |
| Part VI **16** | 9 | **owned** |
| Part VI **31** | 10 | **owned** (mechanism); the R4 and leave clauses named against 8A and 8D, not stubbed |
| Part VI 1, 12, 13, 36 | 2, 8, 1, 5 | re-runs |
| §3.0.4 spec:1041 | 1–4, 9, 10 | **owned** |
| §3.0.4 spec:1065 SoD clause | 2, 10 | contributed (0B owns the row) |
| SAH-023, 032, 040, 041, 042, 051, 072 | 11 | appended; none created (all seven are 0B's, §3.7.3) |

### 2. Every name this slice invented, and why the contracts document lacked it

The consolidated ledger is Task 12 Step 1 — **fourteen rows** (twelve pure additions, plus §4.2.8's `TransitionResultSchema` shape change and §4.5.3's overrides-gate mechanism change, both marked as such) **plus four reported questions** (three already on the record in contracts §4.18; the fourth — §4.16.3's "two pinned assertions", where the repository has one — is new and travels with the merge PR). All fourteen rows landed in the round-2 amendment pass (contracts §4.18), so Task 12 Step 1 verifies them rather than filing them. Each is also declared in its own task's Produces block or route-decision note, so a worker who executes one task in isolation sees which already-landed row that task relies on.

### 3. Hazards (contracts §5) checked one by one

1 no statutory rate anywhere — none appears · 2 no MyInvois detail — none · 3 Firebird untouched · 4 reports ship per phase — **this slice ships none, and Phase 2 owes none** (the `document_event` reader is 7B's `accounting.document_event_log`) · 5/6 owner tasks — **none; the card's Owner gates cell reads *none*** · 7 D1–D27 untouched; the two contradictions found are reported, not resolved · 8 Plan 0A helpers cited by exact name, none renamed · 9 `fixtures.ts` extended additively with `grantCodes` only; `seedTenant` and `draftDocument` untouched · 10 no per-tenant row written by a migration — 0024 writes only global `app.permission` · 11 no enum label added; `event_kind` is `text + CHECK` · 12 relies on 0B's generalised reversibility test · 13 `lint-schema.ts` **not edited at all** (§3.5.3 pre-declares `document_event` in both sets) · 14 migrations 0021–0024 only; no assertion on `max(version)` · 15 both `withTenant`s used at their correct import paths, and Task 11 names which is which · 16 no `employee` · 17 negative stock is 3A's · 18 no projection multiset here · 19 the terminal acts and the cashier is attributed — `attributed_to` is data, `actor_id` is stamped · 20 jobs run as the system principal; Tasks 9 and 10 build that context with the production `systemContext` · 21 no `sql.unsafe` · 22 nothing writes a ledger, movement or projection table · 23 no money arithmetic in this slice · 24 `document_event` written only by triggers and `recordOverride` · 25 **the DELETE list is extended exactly once, here, and `privileges.test.ts` is updated in the same PR** · 26 one new permission code, from §3.6.2 · 27 no `service` kind · 28 not applicable · 29 no screen · 30 no PDF · 31 no new `PROBES` key needed, and the reason is stated · 32 every document-type code this slice configures is registered by amendment before use — `GAP_TEST` (T4), `NG_NG`/`NG_RC`/`NG_HT` (T9) and `SOD_TEST` (T10), all marked *test only* · 33 no policy this slice configures names an account **by code** — every one uses `{ from: "line.account" }` and the ids `seedTenant` returns — so there is no code to resolve and none is seeded · 34 no seed-pack document type shipped · 35 every task carries real code, a failing test and a commit.

### 4. Where this plan corrects itself against 2A

2A's **amendment A4** moves `requireDocumentPermission` and `DOCUMENT_STAGE_CODES` from 2B to 2A, and its **amendment A7** keeps `POST …/reverse` and `accounting.document.reverse` in 2B. Both are honoured: assumption 4 and the reconciliation notes in Tasks 6 and 7 state exactly which of their steps become verifications once 2A is merged, and Task 8 ships the reversal route and its code together, which is what keeps the bidirectional `permission-catalogue` check green on both slices.

Five specific things this plan does **not** do, each of which an earlier draft did and each of which would have broken a merged 2A file:

- **Task 6 prints no full-file listing.** It is a two-edit diff — export `stageCode` in place of the private `codeFor`, change its one call site — so 2A's `resolvePolicy` resolution, its `branchId = null` create branch, its `ERR_NOT_FOUND` for a missing type and its `POLICY_RESOLVED_CODES` export cannot be silently replaced by a later description of them. In particular the middleware keeps **1A's TypeScript `resolvePolicy`** and does *not* switch to `app.effective_policy`: that function is the trigger's resolver, it returns SQL NULL both for "no policy row" and for "policy without an approval block", and a pre-flight that conflated the two would answer `ERR_POLICY_NOT_FOUND` where the trigger answers `ERR_POLICY_INVALID` — the disagreement ADR 0029 forbids.
- **Task 7 does not redefine `DOCUMENT_STAGE_CODES`.** 2A initialises it from `POLICY_RESOLVED_CODES`, and a literal array over that line would leave the middleware's `PERMISSION[…]` references unreferenced — exactly the `permission-catalogue` finding the constant exists to prevent.
- **Task 7 widens `TransitionResultSchema` as a superset, not a replacement.** 1A's route test asserts `status`, `number` and `ledgerEntryIds` on that response and `docs/ui/phase-1-api-surface.md` publishes all six members; dropping them to match §4.3.1's `TransitionResult` would have broken a slice this one does not edit.
- **Task 2 Step 7 derives its grant list from the merged tree, not from 2A's task list.** The unit is the seed object: `posting/reverse.test.ts` alone carries four, because 2A appended a nested `describe` with its own `beforeAll` and one of its cases seeds a second tenant inline.
- **Task 7 Step 2 edits none of 1A's existing route cases.** An earlier draft widened the `drafter` grant and rewrote a `to`-enum case there. 2A Task 9 Step 1 makes the grant edit — in this plan's wording, which it quotes — and also replaces 1A's "a drafter may create but not post" with a case asserting `200` on `draft → posted` for the creating principal. That assertion is 2A's to hold and **is not moved here**: JOURNAL's `approval.required` is false, so R1 (block 2b) never evaluates; `postDocument` reaches `posted` through `draft → issued → posted`, both legal pairs of block 2a; R8 is the override door on `document_event` INSERT and never sees a transition; and block 2c's gate is `accounting.journal.post`, the code 2A granted — **company-wide**, so `app.actor_has(code, company, a.hq)` is true through the `not exists (… role_assignment_branch …)` disjunct (plan0A:1377) even though block 2c passes the document's non-null `branch_id`. 2A raised the branch half of that as the one thing it could not settle from its own file; Step 2's Verification two now carries the check in full. The second rewrite was never needed at all — 1A's `{ to: "reversed" }` rejection stays true, because `reversed` is outside the widened six-value enum too and Task 8 puts reversal on its own route. Step 2 is therefore two verifications and one appended block.

### 5. What was considered and deliberately not done

- **A `numberingGaps` member on `IntegrityReport`.** It would read better than a `ProjectionMismatch`. Changing 1B's interface is a contracts change, so ADR 0030 records it and Task 4 uses the shape that exists (hazard 7).
- **A shared module→read-code map.** `MODULE_READ_CODE` in `documents.ts` stays local; 2C owns the shared attachment map (§4.5.8) and two spellings of one map is hazard 32.
- **A `document_event` report or list route beyond `GET …/events`.** Phase 2 owes no report (hazard 4).
- **A `ListQuery` on `GET …/events`.** `listDocumentEvents` has no `limit`/`cursor` to honour, and a declared-but-ignored query parameter is worse than none: a caller cannot tell a truncated page from a complete list. The route declares no query, `next_cursor` is a constant null with a comment saying why, and 7B adds paging in the PR that needs it.
- **Changing `app.document_event`'s foreign key so a round-tripped draft can be deleted.** The FK is §4.5.2-verbatim; the gap is real, is pinned by a test in Task 4 rather than left latent, and is reported as question 3 of Task 12 Step 1 with two candidate shapes.
- **Editing `packages/db/test/documents.test.ts` or `posting/issue.test.ts`.** Assumption 1 is the reason, and an edit to either is a signal that the matrix gates `→ issued`, which it must not.
- **An `it.skip` for test 31's R4 clause.** A skipped test for another slice's work is a false coverage signal; Task 10 Step 3 greps for its absence instead.

### 6. Amendments this slice depends on, all of them already landed

The fourteen rows of Task 12 Step 1 **are in the frozen contracts document already** — the round-2 amendment pass audited in contracts §4.18 folded every one of them in. Nothing here is waiting on a reviewer's accept or reject, and this slice writes to the contracts document at no point. Task 12 Step 1 is the corresponding **verification gate**: it greps twenty strings covering all fourteen rows — eighteen names plus the two sentence-level strings that §4.2.8 and §4.5.3 now carry, so a document that mentions the names but still states the old shape fails — and expects exit 0. **A `MISSING from …` line means a stale checkout, not a licence to edit the document.** The gate is written at Task 12 only because that is where the slice's other exit checks live; it reads and nothing else, so a worker may run it **before Task 1** to confirm their checkout carries the rows this slice builds on.

Three rows are worth reading in the document before the task that consumes them, because each changes a value some earlier statement made rather than adding a fresh name: the `0023_…_and_add_series_gaps.sql` **file name**, which supersedes the shorter name the 2B card states (executing Task 4 against the card's name would leave a file whose name does not say what it does — §3.4.2); **§4.2.8's `TransitionResultSchema`**, whose superset shape Task 7 Step 1 and Step 4 both depend on; and **§4.5.3's overrides gate**, now an inline `app.principal_has` pre-flight, which is the mechanism Task 8 implements. Confirm each reads that way in your checkout before starting Task 4, 7 and 8 respectively. This plan may not amend the catalogue itself (§2.0), which is why these are verified rather than made here.

### 7. What an independent audit of this plan changed, and what it did not

An auditor read this plan against the contracts document, Plan 0A and the spec. **Seven findings were raised — one blocker and six minors — and every one was verified against the source it cites before anything moved; six are applied in full and the seventh in part.** None was rejected. The record, because each is a place a later reader might otherwise re-open the same question:

- **`ERR_SOD_NO_SUBMISSION` was unreachable by the transition its two tests used (blocker, applied).** `app.document_status_before()` evaluates the §4.5.1 matrix (block 2a) **before** R1 (block 2b), and the matrix admits only `submitted → approved`; a `draft → approved` update therefore falls to the final `else` and raises `ERR_DOC_STATUS_ILLEGAL`, so R1's first clause never speaks. Both tests created a draft and moved it to `approved`. **The trigger did not move** — its block order is contracts §4.5.1 verbatim and the whole slice rests on it. The tests did: Task 2 Step 2 and Task 10 Step 1 each gained a `draftAt(…)` helper that INSERTs the row at `submitted`, which fires neither status trigger (both are `update of status`) and so produces the one state R1's first clause exists for — a submitted document with an empty event log. Two loops that had hedged the same edge with `/ERR_DOC_STATUS_ILLEGAL|ERR_SOD_NO_SUBMISSION/` are now pinned to `ERR_DOC_STATUS_ILLEGAL` alone, which is what a `draft` row can raise and nothing else. Task 2 Step 8 and Task 10 Step 2 name the mistaken form as a predicted failure, so an engineer who hits it does not "fix" the trigger.
- **"Six seed objects" contradicted the plan's own list (applied).** Step 7 enumerates ten — 2 + 4 + 1 + 2 + 1 — and the Execution handoff's "four of the six" was arithmetically impossible. Every site now says **ten seed objects across five files**, with the sum printed. Contracts §4.17's `grantCodes` row carries the same "six sites" wording and is a contracts-side correction this slice reports rather than makes.
- **Task 12 Step 4 claimed an edit to a worker test that Task 4 correctly does not make (applied).** Its roll-up said `tests/invariants/audit-chain.test.ts` **and** `apps/worker/test/handlers/integrity-check.test.ts` gained `"document_series"` in a pinned `projections.checked` array. Task 4 Step 7 says the opposite and is right — verified against plan 1B, where the only `expect(report.projections.checked).toEqual(["account_balance"])` is at 1b:1325 inside `audit-chain.test.ts`, and the worker handler test asserts on `ok`, `summary` and the recorded incident alone. Step 4's sentence now names one file and says why the other is untouched, the §4.16.3 row of Step 1's amendment table is annotated, and the overstatement in contracts §4.16.3 ("1B's two assertions") is filed as **question 4** rather than papered over by inventing an assertion in 1B's test.
- **Task 3 was labelled as adding four `ERRORS` rows and adds three (applied).** Its Step 5 always added three and always deferred `ERR_DOC_NOT_DRAFT` to Task 4 Step 9, so that `scripts/lint/rules/error-codes.ts` never sees a catalogue row without a raiser; only the heading, the Files line, the Produces block and the File Structure row said four. All four now say three, and each names Task 4 Step 9 as the fourth row's home.
- **Task 2's branch case hand-rolled a `dimension_value` INSERT (applied).** Contracts §4.17 registers `seedBranch` (0D, merged since Phase 0) as the one way a test creates a second `BRANCH` value, and §4.17's preamble makes that register binding. The case now calls it.
- **The "a voided number stays explained" assertions were vacuous (applied).** `voidDocument` updates only `status` and leaves `document.number` on the row (1a:3657), and `app.series_gaps` excludes a number when *either* a document *or* a void row carries it — so a voided number is already excluded as a document, and the assertion would read empty with an empty `document_number_void`. The three comments that claimed otherwise (Task 4 Step 2, Task 9 clause 4, Task 11's `sah-051`) now say which assertion carries which fact, and Task 4 gained a case that isolates the void predicate: a series with no document at all, a counter advanced past 1 and 2, and only number 1 recorded as voided, so `series_gaps` must return exactly `["2"]`. Drop the void predicate from the function and that case goes red; nothing else in the slice would.
- **Two departures from the plan's own TDD ordering (applied in part).** Task 6 Step 4 commits one knowingly-red case and Task 7 Step 5 turns it green; that is deliberate, is explained where it happens, and is left alone — splitting the case into Task 7's file would separate the assertion from the export it exists to justify. Tasks 9, 10 and 11 write a test and expect it to pass: all three are gates over a mechanism Tasks 1–8 built, and all three now say **"gate run, not a TDD red step"** in the step itself rather than only in prose.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-2b-state-machine-sod-numbering.md`.**
Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**

### Order and dependencies inside this slice

Tasks 1 → 12 are **strictly sequential**, and more tightly than most slices: Task 2's triggers read Task 1's table, Task 3's seam sets the settings Task 2's AFTER trigger reads, Task 4's guards protect the numbers Task 3 issues, and Tasks 9–11 are gates over all of it. Four notes:

- **`bun run lint` is green at every commit of tasks 1–4.** The slice's fourth `ERR_*` row, `ERR_DOC_NOT_DRAFT`, deliberately lands in **Task 4 Step 9** — the same commit as migration 0023, its only raiser — rather than beside the other three in Task 3, so `scripts/lint/rules/error-codes.ts` never sees a catalogue row without a raiser. Tasks 3 and 4 may still travel together, but nothing forces it.
- **Tasks 5 and 8 travel in one pull request.** `accounting.document.reverse` joins the catalogue at Task 5 and gets its handler reference at Task 8; `permission-catalogue` is red between them, Task 5 Step 6 predicts it, and Task 8 Step 5 is where it goes green. This is the one window §3.6.3 genuinely forces, and it is the only red-lint window in the slice.
- **Tasks 6 and 7 begin with a diff, not with a `create`.** 2A's amendment A4 already shipped the middleware and `DOCUMENT_STAGE_CODES`. Read each task's reconciliation note first. **Task 6 is a two-edit diff** — export `stageCode` in place of the private `codeFor`, change its one call site — and prints no full-file listing on purpose. **Task 7 verifies `DOCUMENT_STAGE_CODES` rather than defining it** (2A initialises it from `POLICY_RESOLVED_CODES`). Wherever 2A's merged file and this plan disagree, 2A is the authority: report the difference in Task 12 Step 1 and leave 2A's behaviour alone.
- **No task waits on an owner.** The card's Owner gates cell reads *none*, this slice ships no screen, and OD-24 therefore gates nothing here. If a worker finds themselves blocked on an owner answer in this slice, they have taken on 2C's work.

**One thing to know before Task 2.** R2 arriving is the single most disruptive moment in this slice: from Task 2 onward every `issued → posted` update requires the acting principal to hold the effective policy's `approval.post`, and five existing files — 1A's, 1B's and **2A's** — post as a principal `seedTenant` deliberately grants nothing. Task 2 Steps 6 and 7 pay that cost once, at **ten seed objects**, through one new fixture helper, and Step 7 prints the two `grep` commands that re-derive the list against the merged tree rather than trusting the plan's list. **The unit is the seed object, not the file:** `posting/reverse.test.ts` alone carries four of the ten, because 2A appended a nested `describe` with its own `beforeAll` and one of its cases seeds a second tenant inline. A worker who instead grants inline in each failing test will produce a dozen call sites for later slices to trip over.

**What "done" means for this slice.** Task 12's five gates green, its fourteen contracts rows verified present, and the Phase 2 DoD clause *"issued numbers are unique and gapless-provable"* demonstrable from a clean checkout by one command: `bun run --cwd tests test -- invariants/numbering-gapless.test.ts`. The other Phase 2 clause — "a new document type is added with zero code" — is 2C's, and Phase 2 does not exit until both are green (spec:87).
