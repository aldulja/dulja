# Dulja Phase 2C — Templates and PDF, attachments, zero-code proof, expand/contract demonstration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 2 by proving its definition of done — *"a new document type is added with zero code"* — end to end: a tenant defines `CONSIGNMENT_RETURN` as configuration alone (type, policy, series, print template) and it numbers, posts, prints in both text directions, appears in the 1B ledger report and reverses; and ship the two tables the phase still owes (`app.attachment` with opaque server-generated object keys, `app.print_template` with text-defined versioned templates) plus the live-table expand/contract demonstration acceptance test 25 requires.

**Architecture:** Four seams on top of 2B's finished document lifecycle. **Storage** is an `ObjectStore` port in `packages/db/src/attachment/` with a `MemoryObjectStore` for tests and an R2 S3-compatible implementation for the container — the object key is always `<tenant_id>/<attachment id>`, derived from the server-minted `uuidv7`, never from anything the client sends (LEGACY-038). **Printing** splits pure from impure exactly as posting does: `packages/domain/src/print/` holds the template-source parser, a deterministic mustache-subset renderer and `buildPrintModel` (all pure, no I/O); `packages/db/src/print/` loads the template and the document snapshot under RLS; `apps/api/src/print/engines/` holds one adapter per ADR-0016 engine code and turns rendered template text into a PDF. **Configuration** reaches a tenant two ways that produce identical rows — the `templates` seed sub-pack (`bun run seed --only templates`) and `POST /v1/companies/{companyId}/print-templates` under `admin.company.manage` — because test 15 is about a tenant adding a type without a release, not about a seed file. **Expand/contract** is demonstrated on the live `document` table: `0027_expand_document_add_notes.sql` adds one nullable column while a request loop keeps serving, and the contract half is documented as a later slice's PR.

**Tech Stack:** Bun 1.4 (install, scripts, the API entrypoint) · Node 24 LTS (runs Vitest) · TypeScript strict · PostgreSQL 18 (Testcontainers `postgres:18`) · `postgres` (postgres.js) tagged templates · Drizzle ORM mirrors for reads · Hono + `@hono/zod-openapi` · Zod · `aws4fetch` (SigV4 against the R2 S3 endpoint) · Playwright Chromium and/or the `typst` binary as the ADR-0016 PDF engine · `pdfjs-dist` (test-side PDF text extraction) · Vitest + Testcontainers · oxlint + oxfmt · Turborepo.

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §0.2 (spec:97–108), §3.2.2 PDF and R2 rows (spec:1132, 1138), §3.3 Attachment (spec:1192), §3.5 report-designer sentence (spec:1240), §3.9 Migrations/expand-contract (spec:2057) and Deletion (spec:2049), §4.6 right-to-export (spec:2211), §4.8 zero-downtime (spec:2236), §4.10 RTL/LTR parity (spec:2253), §4.11 engineering practice (spec:2258–2266), Part V Phase 2 row (spec:2288), Part VI tests 13, 15, 23, 25 (spec:2431, 2433, 2441, 2443), Part I LEGACY-038 (spec:545), LEGACY-080 (spec:872), LEGACY-085 (spec:914).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 2C — Templates and PDF, attachments, zero-code proof, expand/contract demonstration. **Phase:** 2. **Phase gate:** this plan starts only when 2A and 2B are merged and Phase 1's definition of done is green in CI (spec:87). It additionally needs **0E** merged (ADR 0016 — the PDF engine) and **0C** merged (the `ATTACHMENTS` R2 bucket, `infra/wrangler.jsonc`, the seed CLI and its `PackLoader` seam).
- **Depends on (merged):** 0A helpers by exact name — `startDb`, `Db`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `Seed`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.current_tenant`. 0B — `createApp`, `AppDeps`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `requirePermission`, `assertRouteGates`, `AppError`, `ERRORS`, `Problem`, `fromDatabaseError`, `createLogger`, the production `withTenant(sql, ctx, fn)`, `startApi`, `TEST_ISSUER`, `PROBES`, `TENANT_FREE`, `sharedApi`, `grantAdmin`, `problemOf`, `fullRegression`, `sharedDb`, `thinRegression`, `repoFile`, `REPO_ROOT`, `sourceFiles`. 0D — `Money`, `currency`, `Quantity`, `round`, `MONEY_SCALE`, `JobClient`, `startWorker`. 0C — `assertPackShape`, `readPackFile`, `PHASE_0_SUB_PACK_DIRECTORIES`, `SubPack`, `SUB_PACKS`, `PackLoader`, `LoaderContext`, `SeedConfig`, `SeedError`, `containerSecrets`, the `ATTACHMENTS` R2 binding. 0E — `docs/adr/0016-pdf-engine.md`. 1A — `postDocument`, `loadSnapshot`, `resolvePolicy`, `issueDocument`, `reverseDocument`, `PostingError`, `seedTenantV2`, `seedJournalPolicy`, `JOURNAL_POLICY_V1`, `loadDocumentTypes`. 1B — `trialBalance`, `accountLedger`, `accountOpeningBalance`, `postJournal`, `registerProjectionCheck`. 2A — `evaluatePolicy`, `validatePolicy`, `parsePolicy`, `validateDocumentTypeSeed`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `seedParty`, `seedDocumentType`, `document_type.module`. 2B — `transitionDocument`, `voidDocument`, `recordOverride`, `requireDocumentPermission`, `DOCUMENT_STAGE_CODES`, `grantCodes`, `app.principal_has`, `app.series_gaps`, `app.document_event`.
- **Migration numbers:** **0025–0027** — `0025_create_attachment.sql`, `0026_create_print_template.sql`, `0027_expand_document_add_notes.sql`, each with its hand-written `NNNN.down.sql`. **No `0027_seed_permission_phase2c.sql` exists: this slice introduces no permission code** (§3.6.1 closes the vocabulary; §3.6.2 gives 2C no row), so the three numbers are exactly the three DDL files. **ADR numbers:** 0031–0033 — **0031** attachment storage, opaque keys and the `ObjectStore` port (written **as a proposal** — it touches security and the data model, spec:95); **0032** the print-template source format and the `print_template.engine` value set (consumes ADR 0016, never re-opens it); **0033** the expand/contract procedure for a live table and the zero-downtime check.
- **Interfaces consumed:** §4.1 (the Plan 0A surface), §4.2.2 (`withTenant`, `TenantContext`, `createDb`), §4.2.3 (`Logger`, `AppEnv`, `RequestContext`, `readConfig`), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`), §4.2.5 (`PERMISSION`, `PermissionCode`, `requirePermission`, `ScopeSource`, `assertRouteGates`), §4.2.7 (`RouteModule`, `buildRoutes`, `ROUTES`, `IdempotencyHeader`, `createApp`, `AppDeps`, `PROBES`), §4.2.8 (`ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `ProblemSchema`, `encodeCursor`, `decodeCursor`), §4.2.9 (`idempotency`, `RECLAIM_AFTER_SECONDS`), §4.2.12 (`startApi`, `ApiRequest`, `StartedApi`, `TEST_ISSUER`), §4.2.13 (`SubPack`, `SUB_PACKS`, `PackLoader`, `LoaderContext`, `readPackFile`, `assertPackShape`), §4.3.1 (`postDocument`, `loadSnapshot`, `resolvePolicy`, `reverseDocument`), §4.3.2 (the fixed posting algorithm), §4.3.4 (`document_line`, the `document` header additions), §4.3.7 (the document-type seed envelope), §4.4.1 (`posting-policy.schema.json`), §4.4.2 (`DocumentSnapshot`, `LineSnapshot`, `evaluatePolicy`, `validatePolicy`), §4.5.1 (legal transitions), §4.5.2 (`document_event`), §4.5.4 (`requireDocumentPermission`, `DOCUMENT_STAGE_CODES`), §4.5.8 (`app.attachment` DDL and the download gate), §4.5.9 (`app.print_template` DDL and the print endpoint), §4.14 (`CONSIGNMENT_RETURN`), §4.15 (account codes), §4.16.3 (`accountLedger`, `trialBalance`), §4.17 / §4.17.1 (the two helper registers).
- **Interfaces produced:** §4.5.8 `app.attachment` and its upload/download surface verbatim; §4.5.9 `app.print_template` and `POST …/documents/{documentId}/print` verbatim; the `templates` sub-pack loader §3.4.8 assigns 2C; migration 0027, the `document.notes` column §4.3.4 assigns 2C. Everything else this slice names is listed under *Contract additions* in the Self-Review and **must be carried into the contracts document before 3A consumes any of it** (3A adds `attachment.lot_id` in migration 0031 and the `inventory` row of the download map).
- **Owner decisions:** **OD-24** (screenshots + a two-minute operator description before any screen) → **Task 12**, isolated. Default: the screen task is blocked, the slice is not. No other OD item gates this slice; OD-18, OD-19, OD-20, OD-21 and OD-22 are 0C's and 0E's and are consumed here with the stated local equivalents (Testcontainers, `MemoryObjectStore`, `wrangler dev`), never re-gated.
- **Part VI tests owned / re-run:** **owns 15** (new document type, zero code — Task 10) and **25** (zero-downtime migration — Task 11). **Re-runs:** 13 (every upload audited — Tasks 3 and 13), 23 (PDF parity in both directions — Task 9), 12 and 36 (`attachment` and `print_template` under the isolation harness and the catalogue check — Tasks 1, 5 and 13). **§3.0.4 rows owned:** spec:1067 Attachments — "2 (service + document link)"; 3A adds the lot link and 7C the export. **Regression files created / appended:** **creates `tests/regression/legacy-038.test.ts`** (2C is the first slice in execution order to touch path traversal to a file write — §3.7.3); **appends** a `— 2C` block to `tests/regression/legacy-080.test.ts` (created by 0B) and to `tests/regression/legacy-085.test.ts` (created by 0E).
- **Shared namespaces this slice writes into:** document-type codes (§4.14) — **`CONSIGNMENT_RETURN`, module `accounting`, series `CR`, test-only and never seeded into `packages/db/seed/my/document-types/`**; the file lives at `tests/fixtures/document-types/CONSIGNMENT_RETURN.json` and is loaded through the API, which is the point of test 15. Account codes (§4.15) — **2C seeds none**; the `CONSIGNMENT_RETURN` policy resolves accounts through `line.account` exactly as `JOURNAL` does, so no `account: { code }` literal appears anywhere in this slice; the codes its tests use, `1000` and `4000`, are 0C's and are already present through `seedTenantV2`. Report codes (§4.16.1) and `DatasetId` members (§4.16.2) — **none**; Task 10 reads 1B's existing `accounting.ledger` route and adds no code. `fixtures.ts` helpers (§4.17) — **none: §4.17 assigns 2C no helper and hazard 9 forbids inventing one**; every row this slice's tests need is created by an existing helper (`seedTenantV2`, `grantCodes`, `seedDocumentType`, `draftDocument`, `postJournal`) or by a **file-local** function inside the one test file that needs it. Shared test helpers (§4.17.1) — **`pdfText` in `tests/support/pdf.ts` and nothing else** (Task 9; §4.17.1 already registers it, and Task 0's gate verifies that).
- **Two `Seed` facts every test in this plan depends on, stated once because getting either wrong is a silent failure.** (1) **`seedAccount` is never called in this slice.** `seedTenantV2` already creates `1000 Cash` (asset) and `4000 Sales` (income) — §4.1's pinned constants — and §4.15 gives 2C no account to seed, so every test that needs one of those ids **reads it** (`select id from app.account where company_id = … and code = …`). 1A's helper is also `{ code; nameEn; type }` with `type` in `('asset','liability','equity','income','expense')`, so a call written `{ code, name, type: "revenue" }` would not compile in any case. (2) **`Seed` has no `branch` member.** It is `{ tenant; system; human; company; period; closedPeriod; lockedPeriod; cash; sales; docType; policy; branchType; hq }` (§4.1) — the BRANCH dimension *value* is **`hq`**, and `app.document.branch_id` is `not null`, so every `branchId:` in this plan is `<seed>.hq`.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

## Global Constraints

Copied verbatim from the spec and the contracts document; every task's requirements implicitly include this section.

1. **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (LEGACY-036/037/069); issue DDL from application code (LEGACY-053); disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053); gate an audit write on any flag (LEGACY-030); hard-code a package version into a source file — the lockfile owns versions.
2. **Always**, for every new table (spec:106): `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge.
3. **Binding form of a new table** (§3.3): `tenant_id`; RLS enabled **and forced** through `app_meta.enable_tenant_rls`; the policy named exactly `tenant_isolation`; `id uuid primary key default uuidv7()`; `created_at timestamptz not null default now()`; an `audit_row` trigger through `app_meta.attach_audit`; `stamp_<col>` for every `*_by` column through `app_meta.attach_stamp`; composite `(tenant_id, <parent>_id)` FKs to every tenant-scoped parent; a hand-written down file; a two-tenant test. `lintSchema` must report **zero** violations after every migration.
4. **Money** is `numeric(19,4)` in Postgres and the opaque `Money` type in `@dulja/domain` in TypeScript; no `number` ever holds a monetary value (spec:2041, §3.7.5 `no-number-money`). This slice formats money for print through `Money.toString()` and never re-computes a stored base amount on read.
5. **Every query, reads included, runs inside `withTenant`** (spec:2053). `db.` is a lint violation; only a `tx` obtained from `withTenant` may tag SQL. `sql.unsafe` has exactly three homes and none of them is in this slice (§3.3).
6. **One migration per PR** (spec:2057); each file runs whole in one transaction; every statement carries a comment naming the LEGACY-/spec reference it serves; SQL keywords lowercase; section banners `-- ── N. title ───`.
7. **Expand/contract for any change touching a live table** (spec:2057, 2236): expand and contract are two PRs in two slices, never one file. Renaming a column is forbidden — add and backfill.
8. **Deletion** (spec:2049): financial rows never; master data `archived_at`; genuine deletion only for drafts and the erasure workflow, both writing an audit row first. **`app.print_template` is never deleted and never archived** — a new `version` supersedes; **`app.attachment` carries `archived_at`** and no DELETE grant. §3.5.4's pinned DELETE list is **unchanged** by this slice.
9. **Error codes** are `ERR_<DOMAIN>_<REASON>`, enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). This slice adds exactly one: `ERR_PRINT_ENGINE_UNSUPPORTED`.
10. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice introduces **no** permission code and seeds none.
11. **The PDF engine is decided once, in 0E (ADR 0016)** (hazard 30). 2C consumes that ADR's `Code` vocabulary and its Decision row and never re-evaluates engines.
12. **RTL and LTR parity on every screen and every generated PDF**, including numerals, Hijri and Gregorian dates and column order (spec:2253). Every PDF this slice renders is asserted in both directions.
13. **The UI is not specified** (spec:79, 108). Every screen task begins with OD-24 and targets keyboard parity (spec:2254); no workflow is invented.
14. **Localisation** (spec:2061): every user-facing string goes through i18next with an ICU message; `packages/i18n` catalogues are complete in both languages before merge. Print-template labels are **not** i18next keys — they are data inside the template source (ADR 0032), because `packages/domain` may import nothing internal (§3.1).
15. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [2C T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the root stay green after every task.

---

## This slice's share of the Phase 2 definition of done

The Phase 2 row of the phase table, verbatim (spec:2288) — **Definition of done:** "**A new document type is added with zero code**; issued numbers are unique and gapless-provable".

| Clause | Owner | Where it is green |
|---|---|---|
| "A new document type is added with zero code" | **2C** | Task 10 — `CONSIGNMENT_RETURN` defined through `POST /v1/companies/{companyId}/document-types`, `…/print-templates` and a policy version; it numbers, posts, prints, appears in 1B's `accounting.ledger` report and reverses, with zero lines of application code added in that PR |
| "issued numbers are unique and gapless-provable" | 2B | `app.series_gaps` returns zero rows; re-asserted here for the `CR` series in Task 10 |

**Phase 2 exit (Task 13).** Every clause above green in CI, plus tests **10, 15, 16, 25 and 31** passing and tests **12, 13, 23, 27 and 36** re-run over the two new tables and the three new route modules.

---

## File Structure

Every path is relative to the repository root. **NEW** means this slice creates it; **EDIT** means an existing file gains the stated additions and nothing else.

```
packages/db/
├─ migrations/
│  ├─ 0025_create_attachment.sql            NEW  app.attachment (§4.5.8)                         T1
│  ├─ 0025.down.sql                         NEW                                                  T1
│  ├─ 0026_create_print_template.sql        NEW  app.print_template (§4.5.9)                      T5
│  ├─ 0026.down.sql                         NEW                                                  T5
│  ├─ 0027_expand_document_add_notes.sql    NEW  document.notes — the EXPAND half (§4.3.4)        T11
│  └─ 0027.down.sql                         NEW  drops the column only, never the table (§3.4.5)  T11
├─ src/
│  ├─ schema/
│  │  ├─ attachment.ts                      NEW  Drizzle mirror (§3.4.9)                          T1
│  │  ├─ print-template.ts                  NEW  Drizzle mirror                                   T5
│  │  └─ document.ts                        EDIT `notes` column added to the 1A mirror            T11
│  ├─ attachment/
│  │  ├─ object-store.ts                    NEW  ObjectStore port, MemoryObjectStore, R2ObjectStore, objectKeyFor   T2
│  │  └─ index.ts                           NEW  createAttachment / getAttachment / listAttachments / readContent   T3
│  ├─ print/
│  │  ├─ template.ts                        NEW  resolvePrintTemplate, loadPrintContext           T8
│  │  └─ index.ts                           NEW  renderDocumentSource — the barrel                T8
│  ├─ seed/
│  │  ├─ templates.ts                       NEW  the `--only templates` PackLoader (§3.4.8)       T7
│  │  ├─ types.ts                           EDIT SubPack gains "document-types" | "templates"     T7
│  │  └─ packs.ts                           EDIT PHASE_0_SUB_PACK_DIRECTORIES + "templates"; assertPackShape's allowed set derives from SUB_PACKS; readPackText   T7
│  └─ index.ts                              EDIT re-exports the attachment and print surfaces     T2,T3,T8
├─ seed/my/templates/                       NEW  the `templates` sub-pack directory               T7
│  ├─ JOURNAL.standard.v1.json              NEW  the manifest (name, engine, paper, labels)       T7
│  └─ JOURNAL.standard.v1.html              NEW  the template body                                T7
└─ test/
   ├─ attachment.test.ts                    NEW  DDL, RLS, audit, stamp, two-tenant               T1
   ├─ object-store.test.ts                  NEW  key derivation, traversal refusal, round-trip    T2
   ├─ attachment-service.test.ts            NEW  createAttachment / read / list under RLS         T3
   ├─ print-template.test.ts                NEW  DDL, RLS, audit, two-tenant, version uniqueness  T5
   ├─ seed/templates.test.ts                NEW  the loader, idempotence, upsert on version       T7
   ├─ seed-packs.test.ts                    EDIT SUB_PACKS and assertPackShape expectations       T7
   ├─ print-render.test.ts                  NEW  resolvePrintTemplate + renderDocumentSource      T8
   ├─ expand-contract.test.ts               NEW  0027 applies online; document.notes round-trips  T11
   └─ privileges.test.ts                    EDIT unchanged DELETE list re-asserted after 0027     T11

packages/domain/
├─ src/print/
│  ├─ template-source.ts                    NEW  parseTemplateSource, composeTemplateSource            T6
│  ├─ mustache.ts                           NEW  renderTemplate — the deterministic subset         T6
│  ├─ escape.ts                             NEW  htmlEscape, typstEscape                           T6
│  ├─ model.ts                              NEW  PrintModel, PrintContext, buildPrintModel         T6
│  └─ index.ts                              NEW  the barrel                                        T6
├─ src/index.ts                             EDIT re-exports ./print                                T6
└─ test/print/
   ├─ template-source.test.ts               NEW                                                    T6
   ├─ mustache.test.ts                      NEW                                                    T6
   └─ model.test.ts                         NEW  golden PrintModel in en and ar                     T6

packages/contracts/src/
├─ accounting/attachment.ts                 NEW  AttachmentSchema, UploadAttachmentBody, …          T3
├─ accounting/print-template.ts             NEW  PrintTemplateSchema, CreatePrintTemplateBody, …    T7
├─ accounting/print.ts                      NEW  PrintDocumentBody, PrintLangSchema                 T9
├─ errors.ts                                EDIT + ERR_PRINT_ENGINE_UNSUPPORTED                     T8
└─ index.ts                                 EDIT re-exports the three new modules                   T3,T7,T9

apps/api/src/
├─ app.ts                                   EDIT AppDeps gains objectStore; buildRoutes call        T2
├─ config.ts                                EDIT ApiConfig gains the four R2 values                 T2
├─ object-store.ts                          NEW  objectStoreFromConfig(config)                      T2
├─ routes/index.ts                          EDIT buildRoutes deps + two module registrations        T3,T4,T7
├─ routes/accounting/attachments.ts         NEW  createAttachmentRoutes(objectStore)                 T3,T4
├─ routes/accounting/print-templates.ts     NEW  printTemplateRoutes                                 T7
├─ routes/accounting/documents.ts           EDIT + POST …/documents/{documentId}/print               T9
├─ middleware/require-attachment-read.ts    NEW  MODULE_READ_CODE, requireAttachmentRead()           T4
├─ middleware/idempotency.ts                EDIT multipart hashes its parsed PARTS (T3) + REPLAY_BY_RERUN (T9)  T3,T9
└─ print/engines/
   ├─ index.ts                              NEW  PrintEngineCode, PdfEngine, PDF_ENGINES, engineFor  T8
   ├─ chromium.ts                            NEW  Playwright print-to-PDF adapter                    T8
   └─ typst.ts                               NEW  typst-binary adapter                               T8
apps/api/package.json                       EDIT playwright (T8) and pdfjs-dist (T9) as dev deps     T8,T9

apps/api/test/
├─ support/app.ts                           EDIT startApi builds a MemoryObjectStore                 T2
├─ routes/accounting/attachments.test.ts    NEW  upload, download, gate, list                        T3,T4
├─ routes/accounting/print-templates.test.ts NEW the configuration API                               T7
├─ routes/accounting/print.test.ts          NEW  the print endpoint in both directions               T9
└─ print/engines.test.ts                    NEW  the adapters and engineFor                          T8

apps/backoffice/src/
├─ routes/documents/index.tsx               NEW  the document list screen (OD-24)                    T12
├─ routes/documents/$documentId.tsx         NEW  the document entry screen (OD-24)                   T12
├─ features/documents/DocumentTable.tsx     NEW                                                      T12
├─ features/documents/DocumentForm.tsx      NEW                                                      T12
├─ features/documents/AttachmentPanel.tsx   NEW                                                      T12
└─ features/documents/PrintButton.tsx       NEW                                                      T12
packages/i18n/src/catalogues/{en,ar}.json   EDIT the `documents.*` keys the screens use               T12

infra/
├─ src/secrets.ts                           EDIT containerSecrets adds the four R2 names             T2
└─ test/secrets.test.ts                     EDIT the pinned name list                                T2

tests/
├─ regression/legacy-038.test.ts               NEW  CREATED by this slice                               T2
├─ regression/legacy-080.test.ts               EDIT append the `— 2C` describe block                    T11
├─ regression/legacy-085.test.ts               EDIT append the `— 2C` describe block                    T9
├─ support/pdf.ts                           NEW  `pdfText`, the one test-side PDF reader (§4.17.1)   T9
├─ package.json                             EDIT pdfjs-dist as a dev dependency                      T9
├─ invariants/probes.ts                     EDIT two PROBES entries                                  T3,T4,T7
├─ invariants/zero-code-document-type.test.ts NEW test 15 end to end                                 T10
├─ fixtures/document-types/CONSIGNMENT_RETURN.json  NEW the envelope test 15 posts                   T10
└─ fixtures/templates/CONSIGNMENT_RETURN.standard.v1.{json,html}  NEW                                T10

docs/
├─ adr/0031-attachment-storage-opaque-keys.md   NEW  proposal (security, data model)                 T2
├─ adr/0032-print-template-format-and-engine.md NEW                                                  T8
├─ adr/0033-expand-contract-live-tables.md      NEW                                                  T11
└─ runbooks/expand-contract.md                  NEW  the contract half, for a later slice's PR       T11
CLAUDE.md                                       EDIT "Current phase" rewritten (§3.8)                T13

scripts/check/contracts-2c-amendments.sh        NEW  the eleven-entry grep gate Task 0 runs            T0
docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
                                                READ the round-2 names this slice needs; never edited  T0
```

---

### Task 0: Verify the contracts amendments this slice's interfaces depend on

**This task changes no code and no document, and must be green before Task 1 starts.** Eight of this slice's tasks build on an interface the contracts document *freezes*, and §3.10's rule is unambiguous: "every name in the contracts document is frozen — a needed change goes to that document first." **That round has already happened.** Every cross-slice name 2C needs was folded into the contracts document by the round-2 amendment pass audited in §4.18 — `AppDeps`' sixth member, the two `AppEnv` variables, `ERR_PRINT_ENGINE_UNSUPPORTED`, the four R2 names, `REPLAY_BY_RERUN`, `SubPack`'s `document-types` and `templates`, `pdfText`, and §4.5.9's two CHECKs with `paper`'s registered vocabulary. So this task **verifies** that the frozen text already says what 2C compiles against, instead of filing an amendment PR of its own.

Why it is still a task rather than an assumption: the frozen text keeps being read by later writers, and the failure this gate catches is a *stale checkout*. A 3A author reading a §4.2.7 that still said "**`AppDeps` is five members, not three**" would build a five-member object and 3A would not compile against the app 2C ships; an engineer starting 2C against that same stale copy would write Task 2 against the wrong `AppDeps`. One grep run at the head of the slice makes the version of the document being built against explicit.

**The contracts document is read-only to this slice.** A `MISSING` line means the working copy predates the round-2 pass — pull it and re-run. It is never a licence to add the row by hand: a hand-added row is a fork of the authority, which is the failure §3.10 exists to prevent. Names purely internal to 2C are **not** in this task; they go in the Self-Review's *Contract additions* list. What is here is exactly the set that **crosses a slice boundary**.

**Files:**
- Create: `scripts/check/contracts-2c-amendments.sh` (an eleven-entry grep gate, kept so the check is repeatable rather than a one-off paste)
- Modify: **none.** In particular not `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`.

**Interfaces:**
- Consumes: contracts §3.11, §4.2.3, §4.2.4, §4.2.7, §4.2.9, §4.2.12, §4.2.13, §4.5.9, §4.17 and §4.17.1 as the round-2 amendment pass (§4.18) left them.
- Produces: no code. `scripts/check/contracts-2c-amendments.sh`, exit 0 only when all eleven entries are present.

- [ ] **Step 1: Write the gate**

`scripts/check/contracts-2c-amendments.sh`:

```bash
#!/usr/bin/env bash
# Verifies that every cross-slice contracts name 2C's interfaces depend on is present in the frozen
# document. Task 0 of plan 2C; run by that task only — it is not wired into `bun run lint`, because the
# round-2 amendment pass has landed and it can never fail again on a current checkout. It only READS.
set -euo pipefail
DOC=docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
missing=0
need() {
  if ! grep -qF -- "$1" "$DOC"; then echo "MISSING from $DOC: $1"; missing=1; fi
}
need 'objectStore: ObjectStore'                 # §4.2.7 — AppDeps' sixth member
need 'attachment: { row: AttachmentRow; module: DocumentTypeModule }'   # §4.2.3 — AppEnv Variables
need 'documentModule: DocumentTypeModule'       # §4.2.3 — AppEnv Variables
need 'ERR_PRINT_ENGINE_UNSUPPORTED'             # §4.2.4 — the allocated code table
need 'R2_ATTACHMENTS_BUCKET'                    # §3.11 — the four R2 names
need 'REPLAY_BY_RERUN'                          # §4.2.9 — idempotency
need '"document-types" | "templates"'           # §4.2.13 — SubPack widening
need 'pdfText'                                  # §4.17.1 — the shared helper register
need 'version int not null check (version > 0)'                                  # §4.5.9
need "paper text not null default 'A4' check (paper in ('A4','A5','receipt'))"   # §4.5.9
need 'grantCodes(db, s, opts?: { codes?; principalId?; roleCode?; branchIds? })'  # §4.17 — 2B's fixture row
exit "$missing"
```

- [ ] **Step 2: Run it — it must pass**

Run: `bash scripts/check/contracts-2c-amendments.sh && echo ok`
Expected: **PASS** — no output but `ok`, exit 0. All eleven entries are in the document: the ten this slice depends on (counting §4.5.9 as its two CHECKs) plus 2B's `grantCodes` row, which five of this plan's test files call.

**Two stop-conditions, and neither of them is "amend the document":**

1. **A `MISSING from …` line.** The working copy of the contracts document predates the round-2 amendment pass. **Pull the current document and re-run the gate.** Do not add the entry by hand, and do not proceed to Task 1 on a stale copy — every interface Tasks 2, 3, 4, 7 and 9 build on is one of these names.
2. **An entry present with a different shape.** Another slice invented the name first, which is handoff stop-condition 4: stop and report it, rather than reconciling the two spellings inside this slice.

**One entry is not 2C's own name.** `grantCodes` is 2B's fixture (declared by 2B as a contract addition to §4.17, 2b:516) and this plan's test files consume it; §4.17 now carries it in 2B's implemented shape, with the parameter **optional** — `grantCodes(db, s, opts?: { codes?; principalId?; roleCode?; branchIds? })`, returning the created role's id. The gate greps that shape verbatim, `opts?:` included, so a later reader who writes the required form `opts:` is caught by the check rather than by a compile error in five test files.

- [ ] **Step 3: Commit the gate**

```bash
git add scripts/check/contracts-2c-amendments.sh
git commit -m "chore(check): verify the contracts names 2C's interfaces depend on [2C T0]

§3.10: every name in the contracts document is frozen, and the round-2 amendment pass
(§4.18) has already landed the eleven this slice builds on — AppDeps' sixth member
objectStore, AppEnv's attachment and documentModule, ERR_PRINT_ENGINE_UNSUPPORTED, the
four optional R2 names, REPLAY_BY_RERUN with parts-based multipart hashing, SubPack's
document-types (1A's) and templates (2C's), pdfText, §4.5.9's two CHECKs with paper as
A4|A5|receipt, and 2B's grantCodes row with its optional opts. This gate proves the
checkout being built against carries all eleven; it reads the document and never writes
it. No code and no contracts edit in this commit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Migration 0025 — `app.attachment`

`app.attachment` is the table spec:1067 calls "attachments — object storage (R2) addressed by opaque server-generated ids (LEGACY-038), SHA-256 recorded per file, linked to a document or a lot, download gated by the owning module's read permission, included in tenant data export". Its DDL is frozen in contracts §4.5.8 and is reproduced below **verbatim**, with the three `app_meta` calls §3.3 requires added beneath it. `lot_id` is 3A's addition in migration 0031 and is **not** written here.

**Files:**
- Create: `packages/db/migrations/0025_create_attachment.sql`, `packages/db/migrations/0025.down.sql`, `packages/db/src/schema/attachment.ts`, `packages/db/test/attachment.test.ts`
- Test: `packages/db/test/attachment.test.ts`

**Interfaces:**
- Consumes: `startDb`, `Db`, `withTenant(sql, tenantId, actorId, fn)`, `uuidv7(sql)`, `seedTenant(db, name)`, `Seed`, `draftDocument(db, s, opts?)`, `lintSchema(sql)`, `Violation` from `@dulja/db` and `@dulja/db/test` (§4.1); `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp` (§4.1); `seedTenantV2(db, name)` from 1A.
- Produces: table `app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256, uploaded_by, archived_at, created_at)`; the Drizzle mirror `attachment` in `packages/db/src/schema/attachment.ts` with columns `id, tenantId, companyId, documentId, objectKey, fileName, mimeType, byteSize, sha256, uploadedBy, archivedAt, createdAt`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/attachment.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { startDb, uuidv7, withTenant, type Db } from "./harness";
import { draftDocument, seedTenantV2, type Seed } from "./fixtures";

describe("app.attachment — contracts §4.5.8, spec:1067, LEGACY-038", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    b = await seedTenantV2(db, "Beta");
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("the schema linter reports zero violations after 0025", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.table === "attachment")).toEqual([]);
    expect(violations).toEqual([]);
  });

  it("stores a row whose object_key is derived from the id, and stamps uploaded_by", async () => {
    const docId = await draftDocument(db, a);
    const id = await uuidv7(db.admin);
    const row = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256, uploaded_by)
               values (${id}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'permit.pdf', 'application/pdf', 1024,
                       decode('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex'), ${a.system})`;
      const [r] = await tx<{ object_key: string; uploaded_by: string; byte_size: string }[]>`
        select object_key, uploaded_by, byte_size from app.attachment where id = ${id}`;
      return r!;
    });
    expect(row.object_key).toBe(`${a.tenant}/${id}`);
    // stamp_uploaded_by overwrites whatever the insert supplied with app.current_actor() (plan0A:2373)
    expect(row.uploaded_by).toBe(a.human);
    expect(row.byte_size).toBe("1024");
  });

  it("refuses a second row with the same object_key — the key is globally unique (LEGACY-038)", async () => {
    const docId = await draftDocument(db, a);
    const id = await uuidv7(db.admin);
    const other = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
               values (${id}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'a.pdf', 'application/pdf', 1, decode('00', 'hex'))`;
      await expect(
        tx`insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
           values (${other}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'b.pdf', 'application/pdf', 1, decode('00', 'hex'))`,
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  it("refuses a negative byte_size", async () => {
    const docId = await draftDocument(db, a);
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(
        tx`insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
           values (${id}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'a.pdf', 'application/pdf', -1, decode('00', 'hex'))`,
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("a second tenant cannot see it (spec:106)", async () => {
    const docId = await draftDocument(db, a);
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
      values (${id}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'permit.pdf', 'application/pdf', 4, decode('00', 'hex'))`);
    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.attachment`);
    expect(seen[0]!.n).toBe(0);
  });

  it("cannot be attached to another tenant's document — the composite FK refuses it", async () => {
    const foreignDoc = await draftDocument(db, b);
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(
        tx`insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
           values (${id}, ${a.tenant}, ${a.company}, ${foreignDoc}, ${`${a.tenant}/${id}`}, 'x.pdf', 'application/pdf', 1, decode('00', 'hex'))`,
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("every write produces an audit row with a server-supplied actor (test 13)", async () => {
    const docId = await draftDocument(db, a);
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
      values (${id}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'permit.pdf', 'application/pdf', 4, decode('00', 'hex'))`);
    const [audit] = await db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log where table_name = 'attachment' and row_id = ${id}`;
    expect(audit).toMatchObject({ action: "INSERT", actor_id: a.human });
  });

  it("archives rather than deletes — app_rw holds no DELETE on it (§3.5.4)", async () => {
    const [grant] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'attachment' and privilege_type = 'DELETE'`;
    expect(grant!.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- test/attachment.test.ts`
Expected: FAIL — every case errors with `relation "app.attachment" does not exist` (SQLSTATE 42P01).

- [ ] **Step 3: Write the migration**

`packages/db/migrations/0025_create_attachment.sql`:

```sql
-- ── 0025 · app.attachment ───────────────────────────────────────────────────────────────────────
-- spec:1067 (§3.0.4 Attachments row), spec:1138 (R2, opaque server-generated ids), spec:1192
-- (§3.3 Attachment under Document). Contracts §4.5.8 fixes these columns.
-- LEGACY-038: the object key is derived from the server-minted uuidv7 primary key and is NEVER built
-- from anything the client sends; the unique constraint makes a duplicate key impossible.

-- ── 1. the table ────────────────────────────────────────────────────────────────────────────────
create table app.attachment (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  document_id  uuid,                                                  -- lot_id uuid is added by 3A (migration 0031)
  object_key   text not null unique,                                  -- '<tenant_id>/<id>' — server-generated (LEGACY-038)
  file_name    text not null,
  mime_type    text not null,
  byte_size    bigint not null check (byte_size >= 0),
  sha256       bytea not null,                                        -- spec:1067 "SHA-256 recorded per file"
  uploaded_by  uuid not null default app.current_actor() references app.principal(id),
  archived_at  timestamptz,                                           -- spec:2049 master data is archived, never deleted
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, document_id) references app.document(tenant_id, id)
);

-- ── 2. lookups ──────────────────────────────────────────────────────────────────────────────────
-- the document panel lists a document's attachments; the export job (7C) walks a company's.
create index attachment_document_idx on app.attachment (document_id) where document_id is not null;
create index attachment_company_idx  on app.attachment (company_id, created_at);

-- ── 3. tenancy, audit, actor stamping (spec:106, spec:1370, §3.3) ───────────────────────────────
call app_meta.enable_tenant_rls('app.attachment');
call app_meta.attach_audit('app.attachment');                          -- test 13: every upload audited
call app_meta.attach_stamp('app.attachment', 'uploaded_by');           -- LEGACY-044: the server supplies the actor

-- app_rw receives select/insert/update through default privileges (plan0A:2564). No DELETE grant:
-- §3.5.4 pins the list and 2B is the only slice that extends it. Removal is `archived_at`.
```

`packages/db/migrations/0025.down.sql`:

```sql
-- reverse dependency order (§3.4.5). drop table removes its indexes, its policy, and the
-- audit_row / stamp_uploaded_by triggers with it; app_meta itself is never dropped.
drop table if exists app.attachment;
```

- [ ] **Step 4: Write the Drizzle mirror**

`packages/db/src/schema/attachment.ts` (§3.4.9 — the mirror is the diff source and is added in the same PR as the migration):

```ts
import { bigint, customType, index, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

/** `bytea` has no first-class Drizzle column; the driver hands back a Buffer either way. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const attachment = app.table(
  "attachment",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id"),
    objectKey: text("object_key").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: bytea("sha256").notNull(),
    uploadedBy: uuid("uploaded_by").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    objectKeyUnique: unique("attachment_object_key_key").on(t.objectKey),
    tenantRow: unique("attachment_tenant_id_id_key").on(t.tenantId, t.id),
    documentIdx: index("attachment_document_idx").on(t.documentId),
    companyIdx: index("attachment_company_idx").on(t.companyId, t.createdAt),
  }),
);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/attachment.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Prove the migration is reversible**

Run: `bun run --cwd packages/db test -- test/privileges.test.ts`
Expected: PASS — the generalised `up → down → up` test of §3.4.6 reproduces the schema fingerprint byte for byte, and the pinned `app_rw` DELETE list is unchanged (`idempotency_key`, `role_permission`, `role_assignment_branch`, `document`, `document_line`).

- [ ] **Step 7: Confirm `lint-schema.ts` is untouched**

Run: `git diff --stat packages/db/src/lint-schema.ts`
Expected: no output. §3.5.3 gives `attachment` no membership in `NO_ID_TABLES`, `NO_CREATED_AT_TABLES`, `AUDIT_EXEMPT` or `IMMUTABLE`, so this slice edits none of the six sets (hazard 13).

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0025_create_attachment.sql packages/db/migrations/0025.down.sql \
        packages/db/src/schema/attachment.ts packages/db/test/attachment.test.ts
git commit -m "feat(db): app.attachment with opaque object keys and stamped uploader [2C T1]

spec:1067, spec:1138, LEGACY-038. Contracts §4.5.8 verbatim plus the §3.3 app_meta calls
the registry snippet omits. No lint-schema set membership (§3.5.3); no DELETE grant (§3.5.4).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The object store — the port, the memory and R2 implementations, and ADR 0031

LEGACY-038 is a path-traversal defect: the legacy system concatenated a caller-supplied identifier into a filesystem path and handed it to a native file-writing UDF. The structural answer (spec:545) is "blobs in object storage … addressed by opaque server-generated identifiers. Never build a filesystem path from client input". This task makes that mechanical: **one** function derives a key, it takes the tenant id and the attachment id and nothing else, and it is the only producer of a key anywhere in the codebase.

The port lives in `packages/db` and not in `apps/api` because 7C's tenant-export job runs in `apps/worker`, and `apps/worker` may not import `apps/api` (§3.1).

**Files:**
- Create: `packages/db/src/attachment/object-store.ts`, `packages/db/test/object-store.test.ts`, `apps/api/src/object-store.ts`, `docs/adr/0031-attachment-storage-opaque-keys.md`, `tests/regression/legacy-038.test.ts`
- Modify: `packages/db/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/config.ts`, `apps/api/src/routes/index.ts`, `apps/api/test/support/app.ts`, `infra/src/secrets.ts`, `infra/test/secrets.test.ts`, `packages/db/package.json`

**Interfaces:**
- Consumes: `ApiConfig`, `readConfig`, `ConfigError` from `apps/api/src/config.ts` (§4.2.3); `AppDeps`, `createApp`, `buildRoutes` (§4.2.7); `startApi`, `StartedApi` (§4.2.12); `containerSecrets(env, entrypoint)` from `infra/` (§3.11); `sourceFiles`, `REPO_ROOT` from `tests/support/source.ts` and `thinRegression` from `tests/support/regression.ts` (§4.17.1).
- Produces:

```ts
// packages/db/src/attachment/object-store.ts
/** The ONE key derivation in the system (LEGACY-038). Both arguments are server-minted uuids; the
 *  function validates them and never accepts a file name, a folder or any other client string. */
export function objectKeyFor(tenantId: string, attachmentId: string): string;   // `${tenantId}/${attachmentId}`
export class ObjectKeyError extends Error { readonly code: "ERR_OBJECT_KEY_INVALID" }

export interface StoredObject { readonly bytes: Uint8Array; readonly contentType: string }
export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}
export class MemoryObjectStore implements ObjectStore {
  readonly objects: Map<string, StoredObject>;
}
export interface R2ObjectStoreOptions {
  readonly accountId: string; readonly bucket: string;
  readonly accessKeyId: string; readonly secretAccessKey: string;
  readonly fetchImpl?: typeof fetch;         // tests inject; production leaves it undefined
}
export class R2ObjectStore implements ObjectStore { constructor(opts: R2ObjectStoreOptions) }

// apps/api/src/object-store.ts
export function objectStoreFromConfig(config: ApiConfig): ObjectStore;   // MemoryObjectStore when appEnv === "dev" and no R2 values are set
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/object-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MemoryObjectStore, ObjectKeyError, R2ObjectStore, objectKeyFor,
} from "../src/attachment/object-store";

const TENANT = "01927f3a-0000-7000-8000-000000000001";
const ATTACHMENT = "01927f3a-0000-7000-8000-0000000000aa";

describe("objectKeyFor — LEGACY-038: the key is derived, never supplied", () => {
  it("is exactly '<tenant_id>/<attachment_id>'", () => {
    expect(objectKeyFor(TENANT, ATTACHMENT)).toBe(`${TENANT}/${ATTACHMENT}`);
  });

  it("refuses anything that is not a uuid — no traversal, no absolute path, no folder", () => {
    for (const bad of [
      "../../../windows/temp/evil.dll",
      "..",
      `${TENANT}/../${ATTACHMENT}`,
      "/etc/passwd",
      "C:\\Windows\\Temp\\evil.dll",
      "",
      `${ATTACHMENT} `,
    ]) {
      expect(() => objectKeyFor(bad, ATTACHMENT)).toThrow(ObjectKeyError);
      expect(() => objectKeyFor(TENANT, bad)).toThrow(ObjectKeyError);
    }
  });

  it("names the offending argument without echoing it back in full", () => {
    try { objectKeyFor(TENANT, "../evil"); }
    catch (e) {
      expect((e as ObjectKeyError).code).toBe("ERR_OBJECT_KEY_INVALID");
      expect((e as Error).message).toContain("attachmentId");
      expect((e as Error).message).not.toContain("../evil");
    }
  });
});

describe("MemoryObjectStore", () => {
  it("round-trips bytes and content type, and returns null for a miss", async () => {
    const store = new MemoryObjectStore();
    const key = objectKeyFor(TENANT, ATTACHMENT);
    await store.put(key, new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");
    const got = await store.get(key);
    expect(got).not.toBeNull();
    expect(Array.from(got!.bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(got!.contentType).toBe("application/pdf");
    expect(await store.get(objectKeyFor(TENANT, "01927f3a-0000-7000-8000-0000000000bb"))).toBeNull();
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });

  it("stores a copy, so a later mutation of the caller's buffer cannot change the object", async () => {
    const store = new MemoryObjectStore();
    const key = objectKeyFor(TENANT, ATTACHMENT);
    const bytes = new Uint8Array([1, 2, 3]);
    await store.put(key, bytes, "application/octet-stream");
    bytes[0] = 99;
    expect(Array.from((await store.get(key))!.bytes)).toEqual([1, 2, 3]);
  });
});

describe("R2ObjectStore — the S3-compatible surface, exercised through an injected fetch", () => {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, auth: req.headers.get("authorization") });
    if (req.method === "GET") {
      return new Response(new Uint8Array([9, 9]), { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const store = new R2ObjectStore({
    accountId: "acc", bucket: "dulja-attachments",
    accessKeyId: "AKIA", secretAccessKey: "secret", fetchImpl,
  });
  const key = objectKeyFor(TENANT, ATTACHMENT);

  it("addresses the object at <accountId>.r2.cloudflarestorage.com/<bucket>/<key> and signs the request", async () => {
    calls.length = 0;
    await store.put(key, new Uint8Array([1]), "application/pdf");
    expect(calls[0]!.url).toBe(`https://acc.r2.cloudflarestorage.com/dulja-attachments/${key}`);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\//);
  });

  it("returns null on a 404 rather than throwing", async () => {
    const missing = new R2ObjectStore({
      accountId: "acc", bucket: "b", accessKeyId: "A", secretAccessKey: "s",
      fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch,
    });
    expect(await missing.get(key)).toBeNull();
  });

  it("throws, naming the status, on any other failure — never a silent empty object", async () => {
    const broken = new R2ObjectStore({
      accountId: "acc", bucket: "b", accessKeyId: "A", secretAccessKey: "s",
      fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch,
    });
    await expect(broken.get(key)).rejects.toThrow(/object store GET failed: 503/);
  });
});
```

`tests/regression/legacy-038.test.ts` — **created by this slice** (§3.7.3: 2C is the first slice in execution order to touch LEGACY-038):

```ts
import { describe, expect, it } from "vitest";
import { objectKeyFor, ObjectKeyError } from "@dulja/db";
import { sourceFiles } from "../support/source";

describe("LEGACY-038 Path traversal to arbitrary file write on the database server — 2C", () => {
  it("the only key derivation takes two uuids and refuses everything else", () => {
    const tenant = "01927f3a-0000-7000-8000-000000000001";
    // the exact payload of spec:545 — `..\..\..\Windows\Temp\evil.dll`
    expect(() => objectKeyFor(tenant, "..\\..\\..\\Windows\\Temp\\evil.dll")).toThrow(ObjectKeyError);
    expect(() => objectKeyFor("..\\..\\..\\Windows\\Temp", tenant)).toThrow(ObjectKeyError);
  });

  it("no source file outside object-store.ts composes an object key", () => {
    const offenders = sourceFiles(["apps", "packages"])
      .filter((f) => !f.path.endsWith("packages/db/src/attachment/object-store.ts"))
      .flatMap((f) =>
        f.lines
          .map((line, i) => ({ line, n: i + 1, path: f.path }))
          .filter(({ line }) => /object_?[Kk]ey\s*[:=]\s*(`|['"]).*\$\{|object_?[Kk]ey\s*[:=].*\+/.test(line)),
      );
    expect(offenders.map((o) => `${o.path}:${o.n}`)).toEqual([]);
  });

  it("no source file passes a request-supplied name into a filesystem path", () => {
    const offenders = sourceFiles(["apps", "packages"]).flatMap((f) =>
      f.lines
        .map((line, i) => ({ line, n: i + 1, path: f.path }))
        .filter(({ line }) => /\b(join|resolve)\([^)]*\b(fileName|filename|file_name|req\.|body\.)/.test(line)),
    );
    expect(offenders.map((o) => `${o.path}:${o.n}`)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/db test -- test/object-store.test.ts && bun run --cwd tests test -- regression/legacy-038.test.ts`
Expected: FAIL — `Cannot find module '../src/attachment/object-store'` and, in the regression file, `objectKeyFor is not exported from '@dulja/db'`.

- [ ] **Step 3: Add the one dependency and write the implementation**

```bash
bun add --cwd packages/db aws4fetch
```

(No version is written into any source file — the lockfile owns it, spec:104.)

`packages/db/src/attachment/object-store.ts`:

```ts
import { AwsClient } from "aws4fetch";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ObjectKeyError extends Error {
  readonly code = "ERR_OBJECT_KEY_INVALID" as const;
  constructor(argument: "tenantId" | "attachmentId") {
    // The bad value is deliberately NOT echoed: it is attacker-controlled and this message reaches a log.
    super(`${argument} must be a uuid — an object key is derived from server-minted ids only (LEGACY-038)`);
  }
}

/**
 * The ONE object-key derivation in the system. Both arguments are server-minted `uuidv7` values:
 * `tenant_id` comes from the session (`app.current_tenant()`), `attachmentId` is the row's primary key.
 * Nothing a client sends — a file name, a folder, a document reference — ever reaches this function,
 * which is the structural answer to LEGACY-038 (spec:545).
 */
export function objectKeyFor(tenantId: string, attachmentId: string): string {
  if (!UUID.test(tenantId)) throw new ObjectKeyError("tenantId");
  if (!UUID.test(attachmentId)) throw new ObjectKeyError("attachmentId");
  return `${tenantId}/${attachmentId}`;
}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

/** Tests, `bun run dev` without R2 credentials, and `ROUTES`' stub construction (§4.2.7). */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
  }

  async get(key: string): Promise<StoredObject | null> {
    const found = this.objects.get(key);
    return found ? { bytes: Uint8Array.from(found.bytes), contentType: found.contentType } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export interface R2ObjectStoreOptions {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * R2 through its S3-compatible endpoint. The container has no Workers bindings — `ATTACHMENTS` is bound on
 * `apps/edge` (§3.11) — so the API signs SigV4 requests against `<accountId>.r2.cloudflarestorage.com`.
 * The four values arrive as environment variables (§3.11) and never as literals.
 */
export class R2ObjectStore implements ObjectStore {
  readonly #client: AwsClient;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(opts: R2ObjectStoreOptions) {
    this.#client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.#base = `https://${opts.accountId}.r2.cloudflarestorage.com/${opts.bucket}`;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async #send(key: string, init: RequestInit): Promise<Response> {
    const signed = await this.#client.sign(`${this.#base}/${key}`, init);
    return this.#fetch(signed);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const res = await this.#send(key, { method: "PUT", body: bytes, headers: { "content-type": contentType } });
    if (!res.ok) throw new Error(`object store PUT failed: ${res.status}`);
  }

  async get(key: string): Promise<StoredObject | null> {
    const res = await this.#send(key, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`object store GET failed: ${res.status}`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.#send(key, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`object store DELETE failed: ${res.status}`);
  }
}
```

Append to `packages/db/src/index.ts`:

```ts
export {
  MemoryObjectStore, ObjectKeyError, R2ObjectStore, objectKeyFor,
  type ObjectStore, type R2ObjectStoreOptions, type StoredObject,
} from "./attachment/object-store";
```

- [ ] **Step 4: Wire it into the API's dependency object**

In `apps/api/src/config.ts`, add four members to `ApiConfig` and read them in `readConfig` (they are optional in `dev`, required in `staging` and `production` — a missing value in a deployed environment is a `ConfigError` naming the variable, exactly as every other §3.11 value is):

**Append** the four `readonly` members below to `ApiConfig` after its last existing member; change no existing member's name, type or order.

```ts
export interface ApiConfig {
  // (0B's / 0C's existing members stay exactly as they are — append below the last one.)
  readonly r2AccountId: string | null;
  readonly r2AttachmentsBucket: string | null;
  readonly r2AccessKeyId: string | null;
  readonly r2SecretAccessKey: string | null;
}

// inside readConfig, after the existing reads:
const r2AccountId = env["R2_ACCOUNT_ID"] ?? null;
const r2AttachmentsBucket = env["R2_ATTACHMENTS_BUCKET"] ?? null;
const r2AccessKeyId = env["R2_ACCESS_KEY_ID"] ?? null;
const r2SecretAccessKey = env["R2_SECRET_ACCESS_KEY"] ?? null;
if (appEnv !== "dev") {
  for (const [name, value] of [
    ["R2_ACCOUNT_ID", r2AccountId], ["R2_ATTACHMENTS_BUCKET", r2AttachmentsBucket],
    ["R2_ACCESS_KEY_ID", r2AccessKeyId], ["R2_SECRET_ACCESS_KEY", r2SecretAccessKey],
  ] as const) {
    if (!value) throw new ConfigError(`${name} is required when APP_ENV=${appEnv} — attachments have nowhere to go (contracts §3.11)`);
  }
}
```

`apps/api/src/object-store.ts`:

```ts
import { MemoryObjectStore, R2ObjectStore, type ObjectStore } from "@dulja/db";
import type { ApiConfig } from "./config";

/**
 * `dev` without R2 credentials gets an in-process store so `bun run dev` works on a laptop; every other
 * environment gets R2. `readConfig` has already refused to start a staging or production process without
 * the four values, so the narrowing below cannot be reached with a null.
 */
export function objectStoreFromConfig(config: ApiConfig): ObjectStore {
  if (!config.r2AccountId || !config.r2AttachmentsBucket || !config.r2AccessKeyId || !config.r2SecretAccessKey) {
    return new MemoryObjectStore();
  }
  return new R2ObjectStore({
    accountId: config.r2AccountId,
    bucket: config.r2AttachmentsBucket,
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
  });
}
```

In `apps/api/src/app.ts`, add the sixth member to `AppDeps` and pass it to `buildRoutes`:

```ts
import type { ObjectStore } from "@dulja/db";

export interface AppDeps {
  db: Sql;
  jobs: JobClient;
  logger: Logger;
  authAdmin: AuthAdmin;
  verifier: JwtVerifier;
  objectStore: ObjectStore;      // 2C — attachment bytes; contracts §4.2.7 addition
}

// inside createApp, the ONE existing `buildRoutes({ authAdmin: deps.authAdmin })` call gains the second
// key; the mount loop around it and the middleware chain before it are untouched:
for (const module of buildRoutes({ authAdmin: deps.authAdmin, objectStore: deps.objectStore })) {
  app.route(module.path, module.router);
}
```

In `apps/api/src/routes/index.ts`, two edits and **no change to the array's existing contents**: add `objectStore: ObjectStore` to `buildRoutes`' one parameter object, and pass a `MemoryObjectStore` in the `ROUTES` call beside the `StubAuthAdmin` that is already there. The `return [ … ]` array keeps every module 0B, 1A and 1B registered, in the order they registered them; Tasks 3, 4 and 7 append to that same array and never reorder it.

```ts
import { MemoryObjectStore, type ObjectStore } from "@dulja/db";

// signature only — the body's module array is untouched by this step
export function buildRoutes(deps: { authAdmin: AuthAdmin; objectStore: ObjectStore }): readonly RouteModule[];

export const ROUTES: readonly RouteModule[] = buildRoutes({
  authAdmin: new StubAuthAdmin(),
  objectStore: new MemoryObjectStore(),
});
```

In `apps/api/test/support/app.ts` (§4.2.12), three edits, all additive: construct the store on the line **immediately before** the existing `createApp({ … })` call and add it to that call's object; **append** one member to the `StartedApi` interface after its last existing member; and add `objectStore` to the object the function already returns, leaving `db`, `app`, `tokenFor`, `signToken`, `loadPrincipals`, `request` and `stop` exactly as 0B wrote them.

```ts
import { MemoryObjectStore } from "@dulja/db";

// immediately before the existing createApp call:
const objectStore = new MemoryObjectStore();
const app = createApp({ db: rw, jobs, logger, authAdmin: new StubAuthAdmin(), verifier, objectStore });

// appended to the StartedApi interface, after its last existing member:
  objectStore: MemoryObjectStore;   // 2C — contracts §4.2.12's registered member, verified by Task 0

// and added to the returned object literal, which otherwise keeps all seven of 0B's members:
  objectStore,
```

In `infra/src/secrets.ts`, add the four names to the container's environment (§3.11 — "a slice that adds a name to this table adds it there in the same PR, or the container starts without it"), and update the pinned list in `infra/test/secrets.test.ts` to match:

```ts
// containerSecrets(env, entrypoint) — the api and worker classes both need attachments (7C exports them)
"R2_ACCOUNT_ID", "R2_ATTACHMENTS_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/object-store.test.ts && bun run --cwd tests test -- regression/legacy-038.test.ts && bun run --cwd apps/api test && bun run --cwd infra test`
Expected: PASS — 8 object-store tests (3 key derivation, 2 memory store, 3 R2), 3 LEGACY-038 tests, every existing `apps/api` and `infra` test still green.

- [ ] **Step 6: Write ADR 0031 as a proposal**

`docs/adr/0031-attachment-storage-opaque-keys.md` — spec:95 requires a **proposal** for anything touching security or the data model, and this is both:

```markdown
# 0031 — Attachment storage: opaque server-generated keys and an `ObjectStore` port

**Status:** Proposed (spec:95 — this touches security and the data model, so it is asked before it is relied on)
**Date:** 2026-09-05 · **Slice:** 2C · **Spec:** §3.2.2 R2 row (spec:1138), §3.3 Attachment (spec:1192),
§3.0.4 Attachments (spec:1067), Part I LEGACY-038 (spec:545)

## Context

LEGACY-038 is a path traversal to arbitrary file write: `ProcCopyExternalFile.sql` concatenated a caller-supplied
`vDstID` into a filesystem path and handed it to a native `BlobToFile` UDF running as the Firebird service
account. The prefix itself came from an unprotected `Options` table, so both halves of the path were
attacker-influenceable. The same shape reached file deletion.

## Decision

1. **The object key is derived, never supplied.** `objectKeyFor(tenantId, attachmentId)` in
   `packages/db/src/attachment/object-store.ts` is the only producer of a key. Both arguments are server-minted
   `uuidv7` values validated against a uuid pattern; anything else throws `ObjectKeyError`. The key is
   `<tenant_id>/<attachment id>` and `app.attachment.object_key` is `unique`, so a duplicate is impossible.
   `file_name` is stored as data and used only for the `Content-Disposition` header, never for addressing.
2. **A port, not a client.** `ObjectStore { put, get, delete }` lives in `packages/db` because both `apps/api`
   (upload and download) and `apps/worker` (7C's export job) need it, and `apps/worker` may not import
   `apps/api` (§3.1). `MemoryObjectStore` serves tests and a laptop; `R2ObjectStore` signs SigV4 requests
   against R2's S3-compatible endpoint.
3. **Not the Workers binding.** §3.11 binds `ATTACHMENTS` on `apps/edge`, but the ledger-bearing API is a
   Cloudflare **Container**, and containers receive no Workers bindings. Routing every upload through the edge
   Worker would put file bytes on a code path whose job is explicitly "a pre-filter, not a trust boundary"
   (spec §3.2.1). The container therefore talks to R2 directly with four secrets
   (`R2_ACCOUNT_ID`, `R2_ATTACHMENTS_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`), assembled by
   `containerSecrets()` like every other §3.11 name. The `ATTACHMENTS` binding stays for the edge's own future
   use and is untouched by this slice.
4. **Integrity is recorded, not assumed.** `sha256` is computed by the server over the received bytes and
   stored on the row; the download path re-computes it and refuses to serve a mismatch.

## Consequences

- A traversal payload cannot be expressed: the function's domain is two uuids.
- `tests/regression/legacy-038.test.ts` additionally scans `apps/**` and `packages/**` for any other line that
  composes an object key or joins a request-supplied name into a path, so a second spelling fails the build.
- The four R2 values are secrets and never enter the repository or a committed `.env` (spec:2273).
- **Asked:** is direct container-to-R2 access acceptable, or must attachment bytes traverse the edge Worker?
  This ADR assumes the former; the port makes the answer a one-file change either way.
```

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/attachment/object-store.ts packages/db/test/object-store.test.ts packages/db/src/index.ts \
        packages/db/package.json apps/api/src/object-store.ts apps/api/src/config.ts apps/api/src/app.ts \
        apps/api/src/routes/index.ts apps/api/test/support/app.ts infra/src/secrets.ts infra/test/secrets.test.ts \
        tests/regression/legacy-038.test.ts docs/adr/0031-attachment-storage-opaque-keys.md bun.lock
git commit -m "feat(db): ObjectStore port with derived opaque keys; ADR 0031 [2C T2]

LEGACY-038 (spec:545): objectKeyFor(tenantId, attachmentId) is the only key producer and takes
two uuids. MemoryObjectStore for tests, R2ObjectStore over the S3 endpoint for the container.
AppDeps and buildRoutes gain objectStore; containerSecrets gains the four R2 names (§3.11).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Upload — the attachment service, `POST …/attachments`, and binary bodies through idempotency

The upload endpoint is `POST /v1/companies/{companyId}/attachments` (§4.5.8), multipart, with the server computing `sha256` and the R2 key. **It cannot be gated by `requirePermission`**: §4.5.8's gate is the owning module's *read* code, `assertRouteGates` (R7, spec:2178) refuses an unsafe method gated by a `mutating: false` code, and boot would throw `ERR_ROUTE_GATE_READONLY`. **It cannot be gated by 2B's `requireDocumentPermission` either**, because that middleware loads the document named by a `:documentId` path segment and this path has none. So the pre-flight runs **in the handler**, after the multipart body is parsed: resolve the document's effective policy and evaluate `app.actor_has(policy.approval.create ?? policy.approval.post, company_id, branch_id)` — "you may attach a file to a document you may edit". The data layer remains the control (spec:2173); RLS has already hidden every other tenant's document.

`documentId` is **required** at 2C. The column is nullable because 3A adds `lot_id` and a lot attachment carries no document; until that slice ships, an attachment with no parent would have no gate at all, which is the one direction that must never be open.

**Files:**
- Create: `packages/db/src/attachment/index.ts`, `packages/db/test/attachment-service.test.ts`, `packages/contracts/src/accounting/attachment.ts`, `apps/api/src/routes/accounting/attachments.ts`, `apps/api/test/routes/accounting/attachments.test.ts`
- Modify: `packages/db/src/index.ts`, `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`, `apps/api/src/middleware/idempotency.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Consumes: `objectKeyFor`, `ObjectStore` (Task 2); `withTenant(sql, ctx, fn)`, `TenantContext` (§4.2.2); `resolvePolicy(tx, documentTypeId, effectiveDate)` and `PostingError` (§4.3.1); `AppError`, `ERRORS`, `fromDatabaseError` (§4.2.4); `PERMISSION`, `PermissionCode` (§4.2.5); `RouteModule`, `IdempotencyHeader`, `buildRoutes` (§4.2.7); `UuidSchema`, `TimestampSchema`, `ListEnvelope`, `ListQuery`, `ProblemSchema` (§4.2.8); `DOCUMENT_STAGE_CODES` (§4.5.4, 2B); `IsolationProbe`, `PROBES` (§4.2.7); `startApi`, `StartedApi` (§4.2.12); `seedTenantV2`, `draftDocument`, `grantAdmin` (§4.17, §4.17.1).
- Produces:

```ts
// packages/db/src/attachment/index.ts
export type DocumentTypeModule = "accounting" | "inventory" | "hr" | "pos";
export interface AttachmentRow {
  id: string; companyId: string; documentId: string | null; objectKey: string;
  fileName: string; mimeType: string; byteSize: number; sha256: string;      // lower-case hex
  uploadedBy: string; archivedAt: string | null; createdAt: string;
}
export interface NewAttachment { companyId: string; documentId: string; fileName: string; mimeType: string; bytes: Uint8Array }
/** Writes the object first, then the row, inside the caller's `tx`. A rollback leaves an orphan object,
 *  never an orphan row — the reverse would serve a 404 body for a row the UI lists. */
export async function createAttachment(tx: Sql, ctx: TenantContext, store: ObjectStore, input: NewAttachment): Promise<AttachmentRow>;
export async function getAttachment(tx: Sql, attachmentId: string): Promise<{ row: AttachmentRow; module: DocumentTypeModule } | null>;
/** `modules` is the set of `document_type.module` values the CALLER may read (§4.5.8's map, Task 4). It is a
 *  required parameter and not an option with a default: attachment *identity* — file name, size, sha256 — is
 *  itself a side channel (§4.14 test 32: an `hr` payslip must never be reachable through an `accounting`
 *  path), so a caller that forgets it gets a type error rather than an unfiltered list. */
export async function listAttachments(tx: Sql, params: { companyId: string; documentId?: string; limit: number; modules: readonly DocumentTypeModule[] }): Promise<AttachmentRow[]>;
/** Re-computes sha256 over the retrieved bytes and refuses a mismatch (ADR 0031). */
export async function readAttachmentContent(store: ObjectStore, row: AttachmentRow): Promise<Uint8Array>;
export class AttachmentIntegrityError extends Error { readonly code: "ERR_ATTACHMENT_INTEGRITY" }
export const MAX_ATTACHMENT_BYTES: 26_214_400;      // 25 MiB
```

- [ ] **Step 1: Write the failing service test**

`packages/db/test/attachment-service.test.ts`:

```ts
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore, objectKeyFor } from "../src/attachment/object-store";
import {
  AttachmentIntegrityError, createAttachment, getAttachment, listAttachments, readAttachmentContent,
} from "../src/attachment";
import { withTenant as prodWithTenant } from "../src/with-tenant";
import { startDb, uuidv7, type Db } from "./harness";
import { draftDocument, seedTenantV2, type Seed } from "./fixtures";

const ctx = (s: Seed, requestId: string) => ({ tenantId: s.tenant, actorId: s.human, requestId });

describe("the attachment service — contracts §4.5.8, ADR 0031", () => {
  let db: Db; let a: Seed; let b: Seed; let store: MemoryObjectStore;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    b = await seedTenantV2(db, "Beta");
    store = new MemoryObjectStore();
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("writes the object under the derived key and the row with its sha256", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);            // "%PDF-"
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company, documentId, fileName: "permit.pdf", mimeType: "application/pdf", bytes,
      }));

    expect(row.objectKey).toBe(objectKeyFor(a.tenant, row.id));
    expect(row.byteSize).toBe(5);
    // The digest is computed here from the same bytes, so the assertion pins a VALUE and not a shape:
    // ADR 0031's claim is that the server hashes what it received, and only this line proves it.
    expect(row.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.uploadedBy).toBe(a.human);
    expect(Array.from((await store.get(row.objectKey))!.bytes)).toEqual(Array.from(bytes));
  });

  it("reads the content back and refuses a tampered object", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company, documentId, fileName: "cert.pdf", mimeType: "application/pdf",
        bytes: new Uint8Array([1, 2, 3]),
      }));
    expect(Array.from(await readAttachmentContent(store, row))).toEqual([1, 2, 3]);

    await store.put(row.objectKey, new Uint8Array([9, 9, 9]), row.mimeType);
    await expect(readAttachmentContent(store, row)).rejects.toBeInstanceOf(AttachmentIntegrityError);
  });

  it("getAttachment returns the owning document type's module", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company, documentId, fileName: "n.txt", mimeType: "text/plain", bytes: new Uint8Array([65]),
      }));
    const found = await prodWithTenant(db.rw, ctx(a, requestId), (tx) => getAttachment(tx, row.id));
    expect(found?.module).toBe("accounting");                       // JOURNAL's document_type.module (§4.14)
    expect(found?.row.fileName).toBe("n.txt");
  });

  it("is invisible to another tenant through the service, not merely through the route", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company, documentId, fileName: "secret.pdf", mimeType: "application/pdf",
        bytes: new Uint8Array([7]),
      }));
    const seen = await prodWithTenant(db.rw, ctx(b, requestId), (tx) => getAttachment(tx, row.id));
    expect(seen).toBeNull();
    const listed = await prodWithTenant(db.rw, ctx(b, requestId), (tx) =>
      listAttachments(tx, { companyId: b.company, limit: 100, modules: ["accounting"] }));
    expect(listed).toEqual([]);
  });

  it("lists nothing when the caller may read no module — the module filter, not just RLS", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company, documentId, fileName: "gated.pdf", mimeType: "application/pdf",
        bytes: new Uint8Array([2]),
      }));
    const withAccounting = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      listAttachments(tx, { companyId: a.company, limit: 100, modules: ["accounting"] }));
    expect(withAccounting.length).toBeGreaterThan(0);
    const withNone = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      listAttachments(tx, { companyId: a.company, limit: 100, modules: [] }));
    expect(withNone).toEqual([]);
    const withOther = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      listAttachments(tx, { companyId: a.company, limit: 100, modules: ["hr"] }));
    expect(withOther).toEqual([]);
  });

  it("a draft document cannot be deleted while an attachment references it (2B's DELETE grant)", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company, documentId, fileName: "d.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]),
      }));
    // attachment.document_id has NO `on delete cascade` (§4.5.8), so the FK refuses the delete 2B granted.
    // Archiving does NOT unblock it — `archived_at` leaves the reference in place; the row must go, which
    // is a later slice's erasure workflow (spec:2049), not something this test offers a remedy for.
    await expect(
      prodWithTenant(db.rw, ctx(a, requestId), (tx) => tx`delete from app.document where id = ${documentId}`),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/attachment-service.test.ts`
Expected: FAIL — `Cannot find module '../src/attachment'`.

- [ ] **Step 3: Write the service**

`packages/db/src/attachment/index.ts`:

```ts
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { objectKeyFor, type ObjectStore } from "./object-store";

export { MemoryObjectStore, ObjectKeyError, R2ObjectStore, objectKeyFor } from "./object-store";
export type { ObjectStore, R2ObjectStoreOptions, StoredObject } from "./object-store";

/** `app.document_type.module` (§4.3.4, 2A) — the attachment download gate and nothing else (§4.14). */
export type DocumentTypeModule = "accounting" | "inventory" | "hr" | "pos";

/** 25 MiB. Named so the route, the screen and the OpenAPI description agree on one number. */
export const MAX_ATTACHMENT_BYTES = 26_214_400;

export class AttachmentIntegrityError extends Error {
  readonly code = "ERR_ATTACHMENT_INTEGRITY" as const;
}

export interface AttachmentRow {
  id: string;
  companyId: string;
  documentId: string | null;
  objectKey: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  uploadedBy: string;
  archivedAt: string | null;
  createdAt: string;
}

export interface NewAttachment {
  companyId: string;
  documentId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

interface DbAttachment {
  id: string; company_id: string; document_id: string | null; object_key: string;
  file_name: string; mime_type: string; byte_size: string; sha256: Buffer;
  uploaded_by: string; archived_at: Date | null; created_at: Date;
}

function toRow(r: DbAttachment): AttachmentRow {
  return {
    id: r.id, companyId: r.company_id, documentId: r.document_id, objectKey: r.object_key,
    fileName: r.file_name, mimeType: r.mime_type, byteSize: Number(r.byte_size),
    sha256: r.sha256.toString("hex"), uploadedBy: r.uploaded_by,
    archivedAt: r.archived_at ? r.archived_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Mints the id, derives the key from it (LEGACY-038), writes the object, then the row. Object first: a rollback
 * of `tx` leaves an unreferenced object that 7C's export never sees and a later sweep can remove, whereas a
 * row without an object would be a 404 in a list the user is looking at.
 */
export async function createAttachment(
  tx: Sql,
  ctx: TenantContext,
  store: ObjectStore,
  input: NewAttachment,
): Promise<AttachmentRow> {
  const [minted] = await tx<{ id: string }[]>`select uuidv7() as id`;
  const id = minted!.id;
  const objectKey = objectKeyFor(ctx.tenantId, id);
  const sha256 = createHash("sha256").update(input.bytes).digest();

  await store.put(objectKey, input.bytes, input.mimeType);

  const [row] = await tx<DbAttachment[]>`
    insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
    values (${id}, ${ctx.tenantId}, ${input.companyId}, ${input.documentId}, ${objectKey},
            ${input.fileName}, ${input.mimeType}, ${input.bytes.byteLength}, ${sha256})
    returning id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256,
              uploaded_by, archived_at, created_at`;
  return toRow(row!);
}

/** The row plus the module its gate needs, in one query. Null when RLS hides it or it does not exist. */
export async function getAttachment(
  tx: Sql,
  attachmentId: string,
): Promise<{ row: AttachmentRow; module: DocumentTypeModule } | null> {
  const [found] = await tx<(DbAttachment & { module: DocumentTypeModule | null })[]>`
    select a.id, a.company_id, a.document_id, a.object_key, a.file_name, a.mime_type, a.byte_size,
           a.sha256, a.uploaded_by, a.archived_at, a.created_at, dt.module
      from app.attachment a
      left join app.document      d  on d.id  = a.document_id
      left join app.document_type dt on dt.id = d.document_type_id
     where a.id = ${attachmentId} and a.archived_at is null`;
  if (!found) return null;
  // A document-less attachment cannot exist before 3A (the route requires documentId), and 3A's lot rule
  // supplies its own code; until then an absent module denies, which is the safe direction (§4.5.8).
  return { row: toRow(found), module: found.module ?? "accounting" };
}

/**
 * RLS reduces `app.attachment` to the caller's tenant, but not to the modules the caller may read, and
 * `companyId` arrives from the URL. `modules` therefore does the second half of the §4.5.8 gate at the row
 * level: an attachment is listed only when the module of its owning document type is one the caller holds a
 * read code for. At 2C that set is `["accounting"]` at most, and `document_type.module` defaults to
 * `'accounting'` (§4.3.4), so the join is exact rather than a placeholder.
 *
 * **3A changes the join when it adds `lot_id`.** The `join app.document` below is an INNER join, which is
 * correct while `document_id` is required (Task 3) and would silently drop a lot attachment once 3A makes it
 * optional. 3A owns that edit — a `left join` plus the lot rule's own read code — and its Delivers already
 * lists the `inventory` row of the §4.5.8 map; this comment is the pointer to the second half of it.
 */
export async function listAttachments(
  tx: Sql,
  params: { companyId: string; documentId?: string; limit: number; modules: readonly DocumentTypeModule[] },
): Promise<AttachmentRow[]> {
  if (params.modules.length === 0) return [];
  const modules = [...params.modules];
  const rows = params.documentId
    ? await tx<DbAttachment[]>`
        select a.id, a.company_id, a.document_id, a.object_key, a.file_name, a.mime_type, a.byte_size,
               a.sha256, a.uploaded_by, a.archived_at, a.created_at
          from app.attachment a
          join app.document      d  on d.id  = a.document_id
          join app.document_type dt on dt.id = d.document_type_id
         where a.company_id = ${params.companyId} and a.document_id = ${params.documentId}
           and a.archived_at is null and dt.module = any(${modules})
         order by a.created_at, a.id limit ${params.limit}`
    : await tx<DbAttachment[]>`
        select a.id, a.company_id, a.document_id, a.object_key, a.file_name, a.mime_type, a.byte_size,
               a.sha256, a.uploaded_by, a.archived_at, a.created_at
          from app.attachment a
          join app.document      d  on d.id  = a.document_id
          join app.document_type dt on dt.id = d.document_type_id
         where a.company_id = ${params.companyId} and a.archived_at is null and dt.module = any(${modules})
         order by a.created_at, a.id limit ${params.limit}`;
  return rows.map(toRow);
}

/** ADR 0031: the stored hash is re-computed on every read; a mismatch is refused, never served. */
export async function readAttachmentContent(store: ObjectStore, row: AttachmentRow): Promise<Uint8Array> {
  const object = await store.get(row.objectKey);
  if (!object) throw new AttachmentIntegrityError(`object ${row.objectKey} is missing from the store`);
  const actual = createHash("sha256").update(object.bytes).digest("hex");
  if (actual !== row.sha256) {
    throw new AttachmentIntegrityError(`object ${row.objectKey} does not match the recorded sha256`);
  }
  return object.bytes;
}
```

> **Every column list above is written out literally, and no statement in this slice calls `tx.unsafe`.** §3.3 gives `sql.unsafe` exactly three homes — the migration runner, the pg-boss enqueue adapter, the Firebird reader — and `tx.unsafe` *is* `sql.unsafe` on a transaction, so a fourth call site fails the `no-sql-concat` allow-list even when what it interpolates is a compile-time constant. Repeating the eleven names is the price; `DbAttachment` above is the single place their spelling is asserted, and a typo in either list is a `42703` on the first run of the test.

Append to `packages/db/src/index.ts`:

```ts
export {
  AttachmentIntegrityError, MAX_ATTACHMENT_BYTES, createAttachment, getAttachment,
  listAttachments, readAttachmentContent,
  type AttachmentRow, type DocumentTypeModule, type NewAttachment,
} from "./attachment";
```

- [ ] **Step 4: Run the service test to verify it passes**

Run: `bun run --cwd packages/db test -- test/attachment-service.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Write the failing route test, including the binary-body case**

`apps/api/test/routes/accounting/attachments.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { draftDocument, seedTenantV2, type Seed } from "@dulja/db/test";
import { grantAdmin } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const problemOf = async (res: Response) => (await res.json()) as Problem;

function upload(documentId: string, name: string, bytes: Uint8Array, type = "application/pdf"): FormData {
  const form = new FormData();
  form.set("documentId", documentId);
  form.set("file", new File([bytes], name, { type }));
  return form;
}

// MODULE SCOPE, deliberately — not inside the `describe` callback below. Task 4 appends a SECOND
// top-level `describe` to this same file and its cases read `api`, `a` and `b`; a `let` inside the first
// describe's callback is block-scoped to it, so the appended block would be a TypeScript
// "Cannot find name 'api'". Vitest runs file-level `beforeAll`/`afterAll` once around every suite in the
// file, which is exactly what both blocks want: one container, one API, two seeded tenants.
let api: StartedApi; let a: Seed; let b: Seed;

beforeAll(async () => {
  api = await startApi();
  a = await seedTenantV2(api.db, "Alpha");
  b = await seedTenantV2(api.db, "Beta");
  await grantAdmin(api, a);
  await grantAdmin(api, b);
}, 180_000);
afterAll(async () => { await api.stop(); });

describe("POST /v1/companies/{companyId}/attachments — contracts §4.5.8, spec:1067, test 13", () => {
  it("stores the bytes under a server-derived key and returns the row", async () => {
    const documentId = await draftDocument(api.db, a);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human,
      form: upload(documentId, "permit.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; objectKey: string; sha256: string; byteSize: number };
    expect(body.objectKey).toBe(`${a.tenant}/${body.id}`);
    expect(body.byteSize).toBe(4);
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(api.objectStore.objects.has(body.objectKey)).toBe(true);
  });

  it("stores non-UTF-8 bytes byte for byte — a multipart body is not text (LEGACY-038 sibling: silent corruption)", async () => {
    const documentId = await draftDocument(api.db, a);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x80, 0xff, 0x00, 0xfe]);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human,
      form: upload(documentId, "logo.png", bytes, "image/png"),
    });
    expect(res.status).toBe(201);
    const { objectKey } = await res.json() as { objectKey: string };
    expect(Array.from(api.objectStore.objects.get(objectKey)!.bytes)).toEqual(Array.from(bytes));
  });

  it("refuses an upload naming another tenant's document with 404, never 403 (no existence leak)", async () => {
    const foreign = await draftDocument(api.db, b);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human,
      form: upload(foreign, "x.pdf", new Uint8Array([1])),
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("refuses a principal who may not edit the document — the policy's approval.create ?? approval.post is the gate", async () => {
    const documentId = await draftDocument(api.db, a);
    const stranger = await api.db.admin<{ id: string }[]>`select uuidv7() as id`;
    const strangerId = stranger[0]!.id;
    await api.db.admin`
      insert into app.principal (id, kind, auth_subject, display_name)
      values (${strangerId}, 'human', ${`stranger:${strangerId}`}, 'Stranger')`;
    // `app.principal` carries NO tenant_id (plan0A:988–998) — tenancy is the `app.membership` row below.
    await api.db.admin`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${strangerId})`;
    await api.loadPrincipals();

    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: strangerId,
      form: upload(documentId, "x.pdf", new Uint8Array([1])),
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    // `JOURNAL_POLICY_V1` (1A) ships `approval: { required: false, approve: null, post: "accounting.journal.post" }`
    // and NO `create` member — §4.4.1 makes `create` optional with `post` as the documented default — so
    // `approval.create ?? approval.post` resolves to the post code. Asserting `…journal.create` here would
    // fail against the policy 1A actually seeds.
    expect(problem.detail).toContain("accounting.journal.post");
  });

  it("refuses a file over MAX_ATTACHMENT_BYTES with ERR_VALIDATION_FAILED", async () => {
    const documentId = await draftDocument(api.db, a);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human,
      form: upload(documentId, "big.bin", new Uint8Array(26_214_401), "application/octet-stream"),
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("requires Idempotency-Key and replays the same key with the same body", async () => {
    const documentId = await draftDocument(api.db, a);
    // Two SEPARATELY BUILT forms with identical parts. Their wire bytes differ — every FormData gets a fresh
    // random multipart boundary — so this case is exactly what Step 7's parts-based digest exists to make
    // work; a raw-byte hash would answer 409 ERR_IDEMPOTENCY_KEY_REUSED here.
    const form = () => upload(documentId, "once.pdf", new Uint8Array([5, 6, 7]));

    const missing = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human,
      form: form(), idempotencyKey: null,
    });
    expect((await problemOf(missing)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");

    const key = "attachment-replay-1";
    const first = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human, form: form(), idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    const again = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human, form: form(), idempotencyKey: key,
    });
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.json()).toEqual(await first.json());
  });

  it("writes an audit row for every upload (test 13)", async () => {
    const documentId = await draftDocument(api.db, a);
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human,
      form: upload(documentId, "audited.pdf", new Uint8Array([1, 2])),
    });
    const { id } = await res.json() as { id: string };
    const [audit] = await api.db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log where table_name = 'attachment' and row_id = ${id}`;
    expect(audit).toMatchObject({ action: "INSERT", actor_id: a.human });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun run --cwd apps/api test -- test/routes/accounting/attachments.test.ts`
Expected: FAIL — every case 404s with `ERR_NOT_FOUND` (`no route matches POST /v1/companies/…/attachments`), and the non-UTF-8 case would fail on bytes even once the route exists.

- [ ] **Step 7: Make the idempotency middleware hash the *parsed parts* of a multipart body**

0B's `canonical()` documents the intent — *"A non-JSON body hashes as its raw bytes"* — and `await c.req.text()` cannot deliver bytes for a binary body: it re-encodes the multipart payload as UTF-8 and corrupts every byte above 0x7f.

**The fix is not to hash the wire bytes either.** A `FormData` body is serialised with a **freshly generated random multipart boundary on every `Request`**, so two retries that build the same form produce different bytes and therefore different `request_hash` values. Per §4.2.9 that is `ERR_IDEMPOTENCY_KEY_REUSED` (409) — the replay test in Step 5 would fail, and the "different body" test would pass for the wrong reason. **A boundary must never enter the digest.** The digest is taken over the parsed parts instead; Hono caches the parsed form, so the handler's own `c.req.formData()` re-uses this parse rather than re-reading the stream.

In `apps/api/src/middleware/idempotency.ts`, replace the two lines that compute `raw` and `hash` with:

```ts
    const contentType = c.req.header("content-type") ?? "";
    // Hono caches BOTH `text()` and `formData()`, so exactly one of these runs and the handler re-uses it.
    const payload = contentType.includes("multipart/form-data")
      ? await canonicalForm(await c.req.formData())
      : canonical(await c.req.text());
    const hash = createHash("sha256").update(`${c.req.method}\n${path}\n${payload}`).digest();
```

and add this function beside `canonical()` at the bottom of the same file:

```ts
/**
 * The canonical form of a multipart body: every part reduced to `[name, fileName, contentType, sha256(value)]`
 * and the parts sorted, so two requests carrying the same parts hash identically whatever order they were
 * appended in. The multipart BOUNDARY is deliberately absent: `new Request(…, { body: formData })` generates a
 * fresh random boundary for every construction, so a boundary in the digest would make every honest retry of an
 * upload look like a different body and return ERR_IDEMPOTENCY_KEY_REUSED (§4.2.9). A file part hashes its
 * BYTES, never their UTF-8 re-encoding, which is what `c.req.text()` got wrong.
 */
async function canonicalForm(form: FormData): Promise<string> {
  const parts: [string, string, string, string][] = [];
  for (const [name, value] of form.entries()) {
    parts.push(
      typeof value === "string"
        ? [name, "", "", createHash("sha256").update(value, "utf8").digest("hex")]
        : [name, value.name, value.type,
           createHash("sha256").update(Buffer.from(await value.arrayBuffer())).digest("hex")],
    );
  }
  parts.sort((x, y) => (x[0] === y[0] ? x[3].localeCompare(y[3]) : x[0].localeCompare(y[0])));
  return JSON.stringify(parts);
}
```

**A body that is neither JSON nor multipart is unchanged:** `canonical()` still returns the raw text for it, exactly as 0B wrote it. No JSON route's hash changes, which is why every 0B/1A/1B/2A/2B route test stays green.

- [ ] **Step 8: Write the contracts module**

`packages/contracts/src/accounting/attachment.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { ListEnvelope, TimestampSchema, UuidSchema } from "../common";

export const AttachmentSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  documentId: UuidSchema.nullable(),
  objectKey: z.string(),                       // '<tenant_id>/<id>' — server-derived (LEGACY-038); returned so a
  fileName: z.string(),                        // support engineer can find the object without a second query
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploadedBy: UuidSchema,
  createdAt: TimestampSchema,
}).openapi("Attachment");

/** multipart/form-data. `file` is the binary part; `documentId` is required at 2C (3A relaxes it for lots). */
export const UploadAttachmentBody = z.object({
  documentId: UuidSchema,
  file: z.any().openapi({ type: "string", format: "binary" }),
}).openapi("UploadAttachment");

export const AttachmentQuery = z.object({ documentId: UuidSchema.optional(), limit: z.coerce.number().int().min(1).max(1000).default(100) });
export const AttachmentList = ListEnvelope(AttachmentSchema);
export type AttachmentDto = z.infer<typeof AttachmentSchema>;
```

and re-export it from `packages/contracts/src/index.ts`:

```ts
export * from "./accounting/attachment";
```

- [ ] **Step 9: Write the route module**

`apps/api/src/routes/accounting/attachments.ts`:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, AttachmentSchema, ProblemSchema, UploadAttachmentBody } from "@dulja/contracts";
import { MAX_ATTACHMENT_BYTES, createAttachment, type AttachmentRow, type ObjectStore } from "@dulja/db";
import { resolvePolicy } from "@dulja/db";
import type { AppEnv } from "../../context";
import { IdempotencyHeader } from "../index";

export const ATTACHMENTS_PATH = "/v1/companies/:companyId/attachments";

interface DocumentGate { companyId: string; branchId: string | null; documentTypeId: string; effectiveDate: string }

/**
 * Pre-flight only (spec:2173). The gate is the code that may create or edit a draft of this type —
 * `approval.create ?? approval.post` (§4.4.1) — because attaching a file to a document is editing it.
 * It runs in the handler rather than as middleware because §4.5.8 fixes a path with no `:documentId`
 * segment, and it is not a `requirePermission` gate because a read code on a POST is `ERR_ROUTE_GATE_READONLY`
 * at boot (R7, spec:2178).
 */
async function assertMayAttach(
  c: Parameters<Parameters<OpenAPIHono<AppEnv>["openapi"]>[1]>[0],
  companyId: string,
  documentId: string,
): Promise<void> {
  await c.var.withTenant(async (tx) => {
    const [doc] = await tx<DocumentGate[]>`
      select company_id as "companyId", branch_id as "branchId",
             document_type_id as "documentTypeId", effective_date::text as "effectiveDate"
        from app.document where id = ${documentId} and company_id = ${companyId}`;
    if (!doc) throw new AppError("ERR_NOT_FOUND", `document ${documentId} is not visible in company ${companyId}`);

    const { definition } = await resolvePolicy(tx, doc.documentTypeId, doc.effectiveDate);
    const code = definition.approval.create ?? definition.approval.post;
    const [allowed] = await tx<{ ok: boolean }[]>`
      select app.actor_has(${code}, ${doc.companyId}, ${doc.branchId}) as ok`;
    if (!allowed?.ok) {
      throw new AppError("ERR_RBAC_FORBIDDEN",
        `attaching a file to document ${documentId} requires ${code}`,
        { remedy: `Ask an administrator to grant ${code} in this company, or attach the file to a document you may edit.` });
    }
  });
}

export function createAttachmentRoutes(store: ObjectStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();

  routes.openapi(
    createRoute({
      method: "post", path: "/", tags: ["accounting"],
      summary: "Upload an attachment against a document",
      request: {
        headers: IdempotencyHeader,
        params: z.object({ companyId: z.string().uuid() }),
        body: { content: { "multipart/form-data": { schema: UploadAttachmentBody } }, required: true },
      },
      responses: {
        201: { description: "Stored", content: { "application/json": { schema: AttachmentSchema } } },
        400: { description: "Invalid", content: { "application/problem+json": { schema: ProblemSchema } } },
        403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
        404: { description: "No such document", content: { "application/problem+json": { schema: ProblemSchema } } },
      },
    }),
    async (c) => {
      const companyId = c.req.param("companyId")!;
      const form = await c.req.formData();
      const documentId = form.get("documentId");
      const file = form.get("file");

      if (typeof documentId !== "string" || !/^[0-9a-f-]{36}$/i.test(documentId)) {
        throw new AppError("ERR_VALIDATION_FAILED", "documentId must be a uuid",
          { errors: [{ path: "documentId", message: "expected a uuid" }] });
      }
      if (!(file instanceof File)) {
        throw new AppError("ERR_VALIDATION_FAILED", "file is required and must be a file part",
          { errors: [{ path: "file", message: "expected a binary part named `file`" }] });
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new AppError("ERR_VALIDATION_FAILED",
          `file is ${file.size} bytes; the maximum is ${MAX_ATTACHMENT_BYTES}`,
          { errors: [{ path: "file", message: `at most ${MAX_ATTACHMENT_BYTES} bytes` }] });
      }

      await assertMayAttach(c, companyId, documentId);

      // The name is data. It reaches Content-Disposition and nothing else; the object key is derived
      // from the row's uuid (LEGACY-038), so a traversal payload here addresses nothing.
      const fileName = (file.name || "attachment").split(/[/\\]/).pop()!.slice(0, 255);
      const bytes = new Uint8Array(await file.arrayBuffer());

      const row: AttachmentRow = await c.var.withTenant((tx) =>
        createAttachment(tx, c.var.ctx, store, {
          companyId, documentId, fileName,
          mimeType: file.type || "application/octet-stream",
          bytes,
        }));

      return c.json(
        {
          id: row.id, companyId: row.companyId, documentId: row.documentId, objectKey: row.objectKey,
          fileName: row.fileName, mimeType: row.mimeType, byteSize: row.byteSize, sha256: row.sha256,
          uploadedBy: row.uploadedBy, createdAt: row.createdAt,
        },
        201,
      );
    },
  );

  return routes;
}
```

Register it in `apps/api/src/routes/index.ts`, inside `buildRoutes`:

```ts
    {
      path: ATTACHMENTS_PATH,
      router: createAttachmentRoutes(deps.objectStore),
      // The upload's gate is resolved from the document's policy, so it cannot be derived from source;
      // DOCUMENT_STAGE_CODES is the explicit union §4.5.4 keeps for exactly this reason.
      permissions: DOCUMENT_STAGE_CODES,
      auth: "human",
    },
```

- [ ] **Step 10: Add the isolation probe**

In `tests/invariants/probes.ts` (hazard 31 — the harness fails the build when a `ROUTES` entry has no probe):

```ts
  "/v1/companies/:companyId/attachments": {
    // A GET, not the upload. `IsolationProbe.seed` returns `body?: unknown` (§4.2.7) and 0B's harness
    // dispatches it as `api.request({ …, body: req.body })`, which JSON-stringifies with
    // `Content-Type: application/json` (§4.2.12 — `form` is a separate, mutually exclusive field). A
    // `FormData` in `body` would arrive as `{}`, the handler would see no parts and answer 400
    // ERR_VALIDATION_FAILED, and the harness would fail for a reason unrelated to tenant isolation.
    //
    // The download sub-path is the sharper probe anyway: `requireAttachmentRead` resolves the row by
    // `:attachmentId` under the CALLER's RLS session, so B's row is simply absent for A and the answer is
    // 404 — never a 403 that would confirm the id exists.
    async seed(db, owner) {
      const documentId = await draftDocument(db, owner);
      const attachmentId = await uuidv7(db.admin);
      await db.migrator.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${owner.tenant}, true), set_config('app.actor_id', ${owner.system}, true)`;
        await tx`
          insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name,
                                      mime_type, byte_size, sha256)
          values (${attachmentId}, ${owner.tenant}, ${owner.company}, ${documentId},
                  ${`${owner.tenant}/${attachmentId}`}, 'probe.pdf', 'application/pdf', 1, decode('00', 'hex'))`;
      });
      // No object is written to any store: the 404 is raised by the middleware, before any read of content.
      return {
        path: `/v1/companies/${owner.company}/attachments/${attachmentId}/content`,
        method: "GET",
      };
    },
    expect: 404,
  },
```

`uuidv7` is already imported at the top of `probes.ts` by 0B; `draftDocument` is added to that import in this step.

- [ ] **Step 11: Run every affected suite**

Run: `bun run --cwd apps/api test && bun run --cwd tests test -- invariants/tenant-isolation.test.ts`
Expected: PASS — 7 new attachment route tests, every 0B/1A/1B route test still green (the idempotency change is transparent to a JSON body), and the isolation harness green with the new probe.

- [ ] **Step 12: Commit**

```bash
git add packages/db/src/attachment/index.ts packages/db/src/index.ts packages/db/test/attachment-service.test.ts \
        packages/contracts/src/accounting/attachment.ts packages/contracts/src/index.ts \
        apps/api/src/routes/accounting/attachments.ts apps/api/src/routes/index.ts \
        apps/api/src/middleware/idempotency.ts apps/api/test/routes/accounting/attachments.test.ts \
        tests/invariants/probes.ts
git commit -m "feat(api): attachment upload with a policy-resolved gate and byte-exact multipart [2C T3]

spec:1067, §4.5.8. The gate is approval.create ?? approval.post evaluated in the handler:
a read code on a POST is ERR_ROUTE_GATE_READONLY at boot (R7) and §4.5.8's path has no
:documentId for requireDocumentPermission. Idempotency now digests a multipart body as its
PARSED PARTS — each reduced to [name, fileName, contentType, sha256(value)] and the list
sorted — instead of as text. A file part hashes its BYTES, so the UTF-8 re-encoding that
c.req.text() performed above 0x7f is gone. The multipart boundary is deliberately excluded:
new Request(..., { body: formData }) mints a fresh random one per construction, so a boundary
in the digest would make every honest retry look like a different body and answer 409
ERR_IDEMPOTENCY_KEY_REUSED. A JSON body still hashes through 0B's canonical(), unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Download and list — the module read-code map with a default deny

§4.5.8 fixes the download gate as "the read code of the owning module: `document_type.module` → `accounting → accounting.ledger.read`, `inventory → inventory.stock.read`, `hr → hr.payroll.read`, `pos → pos.report.read`", and fixes how the map is built: **one module at a time, in the slice that introduces the code.** `PermissionCode` is derived from `PERMISSIONS`, so `PERMISSION["inventory.stock.read"]` is a **compile error** today and the `permission-catalogue` lint (§3.6.3) fails on a reference naming no catalogue code. **2C therefore ships exactly one row — `accounting` — plus a default deny**, and the one-line addition for each other module is owned by 3A, 6D and 8B. **Those three additions must cost one line each, so this task's own test never asserts the shape of the whole object.** Step 1 checks the `accounting` row by name, checks the deny-by-absence *property* over whichever modules have no row yet, and checks that every row present names a real catalogue code — three cases that all stay true as `inventory`, `pos` and `hr` arrive, in any order. A case pinning `Object.keys(MODULE_READ_CODE)` to `["accounting"]` would instead have to be rewritten by each of the three in turn, on a path where forgetting it leaves the new row behind a red suite.

The default deny is not a gap that needs closing later: `document_type.module` can only ever hold one of the four values (§4.3.4's CHECK), and every value without a row denies with `ERR_RBAC_FORBIDDEN`. No window fails open.

**The LIST is gated too, and it needs both halves of the gate.** §4.5.8 gates the *download* on the owning module's read code precisely because attachment identity is a side channel — the list returns `fileName`, `byteSize`, `sha256`, `uploadedBy` and `objectKey` — and §4.14 (test 32) spells out that an `hr` attachment carrying per-employee pay must never be reachable through an `accounting` path. `companyId` arrives from the URL and RLS is tenant-scoped, never company-scoped, so the list carries (1) `requirePermission(PERMISSION["accounting.ledger.read"], { company: "path:companyId" })`, the same `path:companyId` gate every other company-scoped module in §4.2.7's register carries — legal on a GET under R7 because the code is `mutating: false` — and (2) `readableModules()`, which reduces the rows to the modules the caller actually holds a code for. Without (1) any authenticated tenant member could enumerate any company's attachment metadata; without (2) one read code would enumerate every module's.

**Files:**
- Create: `apps/api/src/middleware/require-attachment-read.ts`, `apps/api/test/middleware/require-attachment-read.test.ts`
- Modify: `apps/api/src/routes/accounting/attachments.ts`, `apps/api/test/routes/accounting/attachments.test.ts`, `apps/api/src/routes/index.ts` (the module's `permissions` gains the download code)

**Interfaces:**
- Consumes: `getAttachment`, `readAttachmentContent`, `listAttachments` (whose `modules` parameter this task supplies), `AttachmentIntegrityError`, `DocumentTypeModule` (Task 3); `PERMISSION`, `PermissionCode`, `requirePermission` (§4.2.5); `AppError` (§4.2.4); `ProblemSchema` (§4.2.8); `AttachmentList`, `AttachmentQuery` (Task 3).
- Produces:

```ts
// apps/api/src/middleware/require-attachment-read.ts
/** The §4.5.8 download map. 2C ships the `accounting` row; 3A adds `inventory`, 6D `pos`, 8B `hr`. */
export const MODULE_READ_CODE: Readonly<Partial<Record<DocumentTypeModule, PermissionCode>>>;
/** Loads the attachment named by `:attachmentId`, resolves its module's read code, evaluates
 *  `app.actor_has(code, company_id)` and stores the row on the context under `attachment`. */
export function requireAttachmentRead(): MiddlewareHandler<AppEnv>;
/** Every `document_type.module` whose §4.5.8 read code the caller actually holds in this company — the row
 *  filter `listAttachments` takes. Empty is a legal answer and means "list nothing". */
export async function readableModules(c: Context<AppEnv>, companyId: string): Promise<DocumentTypeModule[]>;
```

and one member on `AppEnv["Variables"]`:

```ts
    attachment: { row: AttachmentRow; module: DocumentTypeModule };   // set by requireAttachmentRead
```

- [ ] **Step 1: Write the failing tests**

`apps/api/test/middleware/require-attachment-read.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PERMISSION } from "@dulja/contracts/permissions";
import { MODULE_READ_CODE } from "../../src/middleware/require-attachment-read";

describe("the §4.5.8 download map — one row per slice, default deny", () => {
  it("maps accounting to accounting.ledger.read — 2C's one row", () => {
    expect(MODULE_READ_CODE.accounting).toBe(PERMISSION["accounting.ledger.read"]);
  });

  it("denies a module by ABSENCE from the map, never by a fall-through default", () => {
    // Stated as a property, never as a key list. The rows arrive one per slice — 3A `inventory`,
    // 6D `pos`, 8B `hr` — and Phases 3, 6 and 8 may land in any order (spec:2301), so a case that
    // pinned `Object.keys(MODULE_READ_CODE)` to `["accounting"]` would have to be rewritten by
    // whichever of the three landed next, three times, in an order nobody can predict. At 2C all
    // three are absent; as each lands it drops out of `absent` and this case stays true untouched.
    const absent = (["accounting", "inventory", "pos", "hr"] as const)
      .filter((m) => !(m in MODULE_READ_CODE));
    for (const module of absent) expect(MODULE_READ_CODE[module]).toBeUndefined();
    // No row is ever an empty string either: `requireAttachmentRead`'s deny is `if (!code)`, so a
    // falsy row would read as a hit at the type level and as a deny at run time — the worst pair.
    expect(Object.values(MODULE_READ_CODE).every((c) => typeof c === "string" && c.length > 0)).toBe(true);
  });

  it("every row present names a module of the union and a code the catalogue carries", () => {
    // The check a later slice's row is caught by, written without this file naming that row's code:
    // at 2C `PERMISSION["inventory.stock.read"]` is a compile error (§3.6.3), so the assertion is
    // against `PERMISSION` itself rather than against a literal table this file would have to grow.
    // `Set<unknown>` because `Object.values` of a `Partial<Record<…>>` is `(PermissionCode | undefined)[]`.
    const catalogue = new Set<unknown>(Object.values(PERMISSION));
    for (const [module, code] of Object.entries(MODULE_READ_CODE)) {
      expect(["accounting", "inventory", "pos", "hr"]).toContain(module);   // `DocumentTypeModule`, §4.3.4
      expect(typeof code).toBe("string");
      expect(catalogue.has(code)).toBe(true);
    }
  });
});
```

**These three cases are the whole of this file, and no later slice edits them.** 3A, 6D and 8B each add one row to `MODULE_READ_CODE` and one positive case of their own (`expect(MODULE_READ_CODE.inventory).toBe(PERMISSION["inventory.stock.read"])` and its two siblings); none of the three above becomes false when a row appears. That is deliberate and it is the reason the first case names only `accounting`: an assertion over the whole object would put the same edit on three separate slices' critical paths, in whichever order Phases 3, 6 and 8 merge, and a slice that skipped it would leave its own new row hidden behind a red suite.

Append to `apps/api/test/routes/accounting/attachments.test.ts` — a **second top-level `describe`**, beside Task 3's, not nested inside it. `upload()`, `problemOf` and the `api` / `a` / `b` bindings with their `beforeAll`/`afterAll` are all at **module scope** in that file (Task 3 Step 5 put them there for this reason), so the new block sees them and the file still starts exactly one container:

```ts
describe("GET /v1/companies/{companyId}/attachments — list and content", () => {
  it("serves the bytes with the recorded content type and the stored file name", async () => {
    const documentId = await draftDocument(api.db, a);
    const created = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human,
      form: upload(documentId, "invoice ملف.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    });
    const { id } = await created.json() as { id: string };

    const res = await api.request({
      method: "GET", path: `/v1/companies/${a.company}/attachments/${id}/content`, as: a.human,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    // RFC 5987 — the Arabic name survives without ever reaching a path
    expect(res.headers.get("content-disposition")).toMatch(/filename\*=UTF-8''/);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("refuses a principal without the owning module's read code", async () => {
    const documentId = await draftDocument(api.db, a);
    const created = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human,
      form: upload(documentId, "gated.pdf", new Uint8Array([1])),
    });
    const { id } = await created.json() as { id: string };

    const stranger = (await api.db.admin<{ id: string }[]>`select uuidv7() as id`)[0]!.id;
    await api.db.admin`
      insert into app.principal (id, kind, auth_subject, display_name)
      values (${stranger}, 'human', ${`reader:${stranger}`}, 'Reader')`;
    // `app.principal` carries NO tenant_id (plan0A:988–998) — tenancy is the `app.membership` row below.
    await api.db.admin`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${stranger})`;
    await api.loadPrincipals();

    const res = await api.request({
      method: "GET", path: `/v1/companies/${a.company}/attachments/${id}/content`, as: stranger,
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("accounting.ledger.read");
  });

  it("answers 404, never 403, for another tenant's attachment", async () => {
    const foreignDoc = await draftDocument(api.db, b);
    const created = await api.request({
      method: "POST", path: `/v1/companies/${b.company}/attachments`, as: b.human,
      form: upload(foreignDoc, "theirs.pdf", new Uint8Array([1])),
    });
    const { id } = await created.json() as { id: string };

    const res = await api.request({
      method: "GET", path: `/v1/companies/${a.company}/attachments/${id}/content`, as: a.human,
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("lists a document's attachments in the ListEnvelope shape", async () => {
    const documentId = await draftDocument(api.db, a);
    for (const name of ["one.pdf", "two.pdf"]) {
      await api.request({
        method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human,
        form: upload(documentId, name, new Uint8Array([1])),
      });
    }
    const res = await api.request({
      method: "GET", path: `/v1/companies/${a.company}/attachments?documentId=${documentId}`, as: a.human,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: { fileName: string }[]; next_cursor: string | null };
    expect(body.items.map((i) => i.fileName).sort()).toEqual(["one.pdf", "two.pdf"]);
    expect(body.next_cursor).toBeNull();
  });

  it("refuses the LIST to a member who holds no read code — identity is a side channel too", async () => {
    const documentId = await draftDocument(api.db, a);
    await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human,
      form: upload(documentId, "listed.pdf", new Uint8Array([1])),
    });
    const nobodyId = (await api.db.admin<{ id: string }[]>`select uuidv7() as id`)[0]!.id;
    await api.db.admin`
      insert into app.principal (id, kind, auth_subject, display_name)
      values (${nobodyId}, 'human', ${`nobody:${nobodyId}`}, 'Nobody')`;
    await api.db.admin`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${nobodyId})`;
    await api.loadPrincipals();

    const res = await api.request({
      method: "GET", path: `/v1/companies/${a.company}/attachments`, as: nobodyId,
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("accounting.ledger.read");
  });

  it("refuses a companyId outside the caller's tenant with 403 at the gate, before any row is read", async () => {
    // `requirePermission({ company: "path:companyId" })` evaluates `app.actor_has(code, <B's company>)`
    // for A, which is false — so the answer is 403, the same answer every other company-scoped module in
    // §4.2.7's register gives, and no row is touched. The 404-not-403 rule applies to the *download*
    // sub-path, where the id names a row; here the path names a company the caller has no authority in.
    const res = await api.request({
      method: "GET", path: `/v1/companies/${b.company}/attachments`, as: a.human,
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("refuses to serve an object whose bytes no longer match the recorded sha256 (ADR 0031)", async () => {
    const documentId = await draftDocument(api.db, a);
    const created = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/attachments`, as: a.human,
      form: upload(documentId, "tamper.pdf", new Uint8Array([1, 2, 3])),
    });
    const { id, objectKey } = await created.json() as { id: string; objectKey: string };
    await api.objectStore.put(objectKey, new Uint8Array([9, 9, 9]), "application/pdf");

    const res = await api.request({
      method: "GET", path: `/v1/companies/${a.company}/attachments/${id}/content`, as: a.human,
    });
    expect(res.status).toBe(500);
    expect((await problemOf(res)).code).toBe("ERR_INTERNAL");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd apps/api test -- test/middleware/require-attachment-read.test.ts test/routes/accounting/attachments.test.ts`
Expected: FAIL — `Cannot find module '../../src/middleware/require-attachment-read'`, and every new route case 404s.

- [ ] **Step 3: Write the middleware**

`apps/api/src/middleware/require-attachment-read.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import { AppError } from "@dulja/contracts";
import { PERMISSION, type PermissionCode } from "@dulja/contracts/permissions";
import { getAttachment, type DocumentTypeModule } from "@dulja/db";
import type { AppEnv } from "../context";

/**
 * The §4.5.8 download map, built ONE MODULE AT A TIME by the slice that introduces the code.
 * At 2C only `accounting.ledger.read` exists in the catalogue: `PERMISSION["inventory.stock.read"]` is a
 * compile error until 3A seeds it and the `permission-catalogue` lint (§3.6.3) fails on a reference naming
 * no catalogue code. The one-line additions are owned by:
 *   3A  inventory → PERMISSION["inventory.stock.read"]   (and a lot attachment → PERMISSION["inventory.item.read"])
 *   6D  pos       → PERMISSION["pos.report.read"]
 *   8B  hr        → PERMISSION["hr.payroll.read"]
 * A module with no row DENIES. That is the safe direction and needs no compensating work: a `pos` or `hr`
 * document type cannot exist before those slices either.
 * Each of those three additions is ONE LINE: `require-attachment-read.test.ts` asserts deny-by-absence as a
 * property and never pins the key list, so adding a row falsifies nothing there. Add your row and your own
 * positive case; do not rewrite the three cases already in that file.
 */
export const MODULE_READ_CODE: Readonly<Partial<Record<DocumentTypeModule, PermissionCode>>> = {
  accounting: PERMISSION["accounting.ledger.read"],
};

export function requireAttachmentRead(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const companyId = c.req.param("companyId")!;
    const attachmentId = c.req.param("attachmentId")!;

    const found = await c.var.withTenant((tx) => getAttachment(tx, attachmentId));
    // RLS has already reduced app.attachment to the caller's tenant, so an invisible row and a missing row
    // are indistinguishable here — which is the point: 404 never reveals cross-tenant existence.
    if (!found || found.row.companyId !== companyId) {
      throw new AppError("ERR_NOT_FOUND", `attachment ${attachmentId} is not visible in company ${companyId}`);
    }

    const code = MODULE_READ_CODE[found.module];
    if (!code) {
      throw new AppError("ERR_RBAC_FORBIDDEN",
        `attachments of ${found.module} documents cannot be downloaded yet`,
        { remedy: `The ${found.module} read code is introduced by a later slice (contracts §4.5.8); no principal may download this file until then.` });
    }

    const [allowed] = await c.var.withTenant((tx) =>
      tx<{ ok: boolean }[]>`select app.actor_has(${code}, ${found.row.companyId}) as ok`);
    if (!allowed?.ok) {
      throw new AppError("ERR_RBAC_FORBIDDEN",
        `downloading attachment ${attachmentId} requires ${code}`,
        { remedy: `Ask an administrator to grant ${code} in this company.` });
    }

    c.set("attachment", found);
    return next();
  };
}

/**
 * The list route's row filter. `requirePermission` on that route establishes that the caller may read
 * *something* in this company; this establishes WHICH modules, so an `hr` payslip attachment can never be
 * enumerated through the `accounting` read code (§4.14, test 32). One `app.actor_has` per mapped module —
 * one row today, four when 3A, 6D and 8B have added theirs.
 */
export async function readableModules(c: Context<AppEnv>, companyId: string): Promise<DocumentTypeModule[]> {
  const entries = Object.entries(MODULE_READ_CODE) as [DocumentTypeModule, PermissionCode][];
  return c.var.withTenant(async (tx) => {
    const held: DocumentTypeModule[] = [];
    for (const [module, code] of entries) {
      const [row] = await tx<{ ok: boolean }[]>`select app.actor_has(${code}, ${companyId}) as ok`;
      if (row?.ok) held.push(module);
    }
    return held;
  });
}
```

`Context` comes from `hono`; add it to that file's type imports alongside `MiddlewareHandler`.


**Append** one member to `AppEnv["Variables"]` in `apps/api/src/context.ts`, after 0B's last existing variable; rename and reorder nothing. (Task 9 appends `documentModule` beside it. Both members are already registered in §4.2.3 — Task 0's gate verifies that.)

```ts
import type { AttachmentRow, DocumentTypeModule } from "@dulja/db";

// added as the last member of AppEnv["Variables"]:
    attachment: { row: AttachmentRow; module: DocumentTypeModule };   // 2C — set by requireAttachmentRead
```

- [ ] **Step 4: Add the two GET routes**

Append inside `createAttachmentRoutes` in `apps/api/src/routes/accounting/attachments.ts`:

```ts
  routes.openapi(
    createRoute({
      method: "get", path: "/", tags: ["accounting"],
      summary: "List a company's or a document's attachments",
      // TWO gates, because attachment IDENTITY is itself a side channel: `fileName`, `byteSize`, `sha256`
      // and `uploadedBy` are all returned here. `companyId` is caller-supplied and RLS is tenant-scoped,
      // never company-scoped, so without the first gate any authenticated tenant member could enumerate
      // any company's attachment metadata — which is why every other company-scoped module in §4.2.7's
      // register carries the same `path:companyId` gate. A read code on a GET is legal under R7.
      // The second gate is `readableModules` in the handler, at the row level (§4.5.8, §4.14 test 32).
      middleware: [requirePermission(PERMISSION["accounting.ledger.read"], { company: "path:companyId" })],
      request: { params: z.object({ companyId: z.string().uuid() }), query: AttachmentQuery },
      responses: {
        200: { description: "Attachments", content: { "application/json": { schema: AttachmentList } } },
        403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      },
    }),
    async (c) => {
      const companyId = c.req.param("companyId")!;
      const { documentId, limit } = c.req.valid("query");
      const modules = await readableModules(c, companyId);
      const rows = await c.var.withTenant((tx) => listAttachments(tx, { companyId, documentId, limit, modules }));
      return c.json({
        items: rows.map((r) => ({
          id: r.id, companyId: r.companyId, documentId: r.documentId, objectKey: r.objectKey,
          fileName: r.fileName, mimeType: r.mimeType, byteSize: r.byteSize, sha256: r.sha256,
          uploadedBy: r.uploadedBy, createdAt: r.createdAt,
        })),
        // The list is bounded by `limit` and ordered by (created_at, id); a document's attachment count is
        // small enough that 2C ships no cursor. A slice that needs one uses encodeCursor (§4.2.8).
        next_cursor: null,
      }, 200);
    },
  );

  routes.openapi(
    createRoute({
      method: "get", path: "/{attachmentId}/content", tags: ["accounting"],
      summary: "Download an attachment's bytes",
      middleware: [requireAttachmentRead()],
      request: { params: z.object({ companyId: z.string().uuid(), attachmentId: z.string().uuid() }) },
      responses: {
        200: { description: "The file", content: { "application/octet-stream": { schema: z.any() } } },
        403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
        404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
      },
    }),
    async (c) => {
      const { row } = c.var.attachment;
      let bytes: Uint8Array;
      try {
        bytes = await readAttachmentContent(store, row);
      } catch (e) {
        // The recorded hash did not match, or the object is gone. Never serve the bytes and never echo the
        // key to the client; the detail goes to the log with the request id (spec:2063).
        c.var.logger.error({ attachment_id: row.id, err: String(e) }, "attachment_integrity");
        throw new AppError("ERR_INTERNAL", `attachment ${row.id} could not be served`);
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": row.mimeType,
          "content-length": String(row.byteSize),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
          "x-request-id": c.var.requestId,
        },
      });
    },
  );
```

with the imports the two handlers need added at the top of the file:

```ts
// `AppError` and `ProblemSchema` are already imported by Task 3's version of this file; add only the
// names below to that existing `@dulja/contracts` import and the three new import lines.
import { AttachmentList, AttachmentQuery } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { listAttachments, readAttachmentContent } from "@dulja/db";
import { requirePermission } from "../../middleware/require-permission";
import { readableModules, requireAttachmentRead } from "../../middleware/require-attachment-read";
```

and the module's `permissions` in `buildRoutes` widened to declare the download code as well:

```ts
      permissions: [...DOCUMENT_STAGE_CODES, PERMISSION["accounting.ledger.read"]],
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test -- test/middleware/require-attachment-read.test.ts test/routes/accounting/attachments.test.ts`
Expected: PASS — 3 map tests, and 14 cases in `attachments.test.ts` (Task 3's 7 plus the 7 appended here).

- [ ] **Step 6: Re-generate and diff the OpenAPI document**

Run: `bun run --cwd packages/contracts openapi:generate && git diff --stat packages/contracts/openapi.json`
Expected: `packages/contracts/openapi.json` gains the three attachment operations; CI's generate-and-diff check (spec:2055) passes because the file is committed with them.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/middleware/require-attachment-read.ts apps/api/src/context.ts \
        apps/api/src/routes/accounting/attachments.ts apps/api/src/routes/index.ts \
        apps/api/test/middleware/require-attachment-read.test.ts \
        apps/api/test/routes/accounting/attachments.test.ts packages/contracts/openapi.json
git commit -m "feat(api): attachment download gated by the owning module's read code [2C T4]

§4.5.8: MODULE_READ_CODE ships the accounting row and denies every other module. 3A adds
inventory, 6D pos, 8B hr — one line each, in the slice that seeds the code, and the map's
own test asserts deny-by-absence as a property rather than pinning the key list, so none
of those three has to rewrite it. A hash mismatch is refused, never served (ADR 0031).
Cross-tenant is 404, never 403.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Migration 0026 — `app.print_template`

spec:1240 keeps one thing from the legacy system's report designer: templates that are "**text-defined, diffable, version-controlled**". `app.print_template` is that store. Its DDL is frozen in contracts §4.5.9 and is reproduced below **with every column, type and constraint of §4.5.9 unchanged, plus exactly four additions** — nothing is removed and nothing is renamed:

1. `call app_meta.enable_tenant_rls('app.print_template')` — §3.3 requires it and the §4.5.9 snippet omits it.
2. `call app_meta.attach_audit('app.print_template')` — likewise; §3.5.3 gives `print_template` no `AUDIT_EXEMPT` row.
3. `check (version > 0)` — §4.5.9 types `version` as a bare `int`, and a negative or zero version would make `order by version desc limit 1` (Task 8's resolver) pick a row that means nothing.
4. `check (paper in ('A4','A5','receipt'))` — §4.5.9 gives `paper` a `default 'A4'` and no value set at all. **These three values are a new closed vocabulary that this slice invents**, they become `PaperSchema` in `packages/contracts/src/accounting/print-template.ts`, and they constrain 7A's `layout.paper` (§4.11.1). Under §4.14/§4.16's registration rule an undeclared closed vocabulary is exactly what must not ship, so the set **is registered against §4.5.9 together with the two CHECKs above** (the round-2 pass landed both; Task 0's gate verifies them), cross-checked against §4.11.1's `layout.paper`.

`engine`'s value set is the `Code` column of **ADR 0016**'s Verdict table (0E Task 14): `typst`, `chromium`, `react-pdf`. That vocabulary is already frozen there, so it is consumed and never re-opened (hazard 30) and needs no registration.

**Files:**
- Create: `packages/db/migrations/0026_create_print_template.sql`, `packages/db/migrations/0026.down.sql`, `packages/db/src/schema/print-template.ts`, `packages/db/test/print-template.test.ts`
- Test: `packages/db/test/print-template.test.ts`

**Interfaces:**
- Consumes: `startDb`, `Db`, `withTenant` (test), `uuidv7`, `lintSchema`, `seedTenantV2`, `Seed` (§4.1, 1A); `app_meta.enable_tenant_rls`, `app_meta.attach_audit`.
- Produces: table `app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, name_ar, engine, source, paper, created_at)` with `unique (document_type_id, code, version)`; the Drizzle mirror `printTemplate`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/print-template.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { startDb, uuidv7, withTenant, type Db } from "./harness";
import { seedTenantV2, type Seed } from "./fixtures";

const SOURCE = "---dulja-template-v1\n{\"labels\":{\"en\":{},\"ar\":{}}}\n---\n<h1>{{ document.typeName }}</h1>\n";

describe("app.print_template — contracts §4.5.9, spec:1240", () => {
  let db: Db; let a: Seed; let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    b = await seedTenantV2(db, "Beta");
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("the schema linter reports zero violations after 0026", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("stores a versioned template against a document type", async () => {
    const id = await uuidv7(db.admin);
    const row = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, name_ar, engine, source)
               values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, 'standard', 1, 'Journal Voucher', 'قيد يومية', 'chromium', ${SOURCE})`;
      const [r] = await tx<{ code: string; version: number; engine: string; paper: string; source: string }[]>`
        select code, version, engine, paper, source from app.print_template where id = ${id}`;
      return r!;
    });
    expect(row).toMatchObject({ code: "standard", version: 1, engine: "chromium", paper: "A4" });
    expect(row.source).toBe(SOURCE);
  });

  it("refuses a second row with the same (document_type_id, code, version)", async () => {
    const first = await uuidv7(db.admin);
    const second = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
               values (${first}, ${a.tenant}, ${a.company}, ${a.docType}, 'dup', 1, 'Dup', 'chromium', ${SOURCE})`;
      await expect(
        tx`insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
           values (${second}, ${a.tenant}, ${a.company}, ${a.docType}, 'dup', 1, 'Dup again', 'chromium', ${SOURCE})`,
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  it("admits exactly the three ADR 0016 engine codes and refuses anything else", async () => {
    for (const engine of ["typst", "chromium", "react-pdf"]) {
      const id = await uuidv7(db.admin);
      await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
        insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
        values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, ${`e-${engine}`}, 1, 'E', ${engine}, ${SOURCE})`);
    }
    const bad = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(
        tx`insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
           values (${bad}, ${a.tenant}, ${a.company}, ${a.docType}, 'bad', 1, 'Bad', 'wkhtmltopdf', ${SOURCE})`,
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("a second tenant cannot see it (spec:106)", async () => {
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
      values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, 'isolated', 1, 'Isolated', 'chromium', ${SOURCE})`);
    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.print_template`);
    expect(seen[0]!.n).toBe(0);
  });

  it("cannot reference another tenant's document type — the composite FK refuses it", async () => {
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(
        tx`insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
           values (${id}, ${a.tenant}, ${a.company}, ${b.docType}, 'x', 1, 'X', 'chromium', ${SOURCE})`,
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("every write is audited and app_rw holds no DELETE — a version is superseded, never removed", async () => {
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
      values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, 'audited', 1, 'Audited', 'chromium', ${SOURCE})`);
    const [audit] = await db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log where table_name = 'print_template' and row_id = ${id}`;
    expect(audit).toMatchObject({ action: "INSERT", actor_id: a.human });

    const [grant] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'print_template' and privilege_type = 'DELETE'`;
    expect(grant!.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/db test -- test/print-template.test.ts`
Expected: FAIL — `relation "app.print_template" does not exist` (SQLSTATE 42P01).

- [ ] **Step 3: Write the migration**

`packages/db/migrations/0026_create_print_template.sql`:

```sql
-- ── 0026 · app.print_template ───────────────────────────────────────────────────────────────────
-- spec:1240 — the one thing kept from the legacy report designer: "text-defined, diffable,
-- version-controlled" templates. Contracts §4.5.9 fixes these columns.
-- `engine` holds a Code from ADR 0016's Verdict table (0E T14). The decision is made once, there;
-- this CHECK is its vocabulary, and no later slice re-evaluates engines (contracts hazard 30).

-- ── 1. the table ────────────────────────────────────────────────────────────────────────────────
create table app.print_template (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  document_type_id  uuid not null,
  code              text not null,
  version           int  not null check (version > 0),
  name_en           text not null,
  name_ar           text,
  engine            text not null check (engine in ('typst', 'chromium', 'react-pdf')),   -- ADR 0016
  source            text not null,                    -- the template text: front matter + body (ADR 0032)
  paper             text not null default 'A4' check (paper in ('A4', 'A5', 'receipt')),  -- matches §4.11.1 layout.paper
  created_at        timestamptz not null default now(),
  unique (document_type_id, code, version),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)       references app.company(tenant_id, id),
  foreign key (tenant_id, document_type_id) references app.document_type(tenant_id, id)
);

-- ── 2. resolution ───────────────────────────────────────────────────────────────────────────────
-- the print endpoint resolves "the highest version of <code> for this type in this company".
create index print_template_resolve_idx on app.print_template (company_id, document_type_id, code, version desc);

-- ── 3. tenancy and audit (spec:106, §3.3; the §4.5.9 snippet omits these two calls) ──────────────
call app_meta.enable_tenant_rls('app.print_template');
call app_meta.attach_audit('app.print_template');

-- No *_by column, so no attach_stamp. No DELETE grant and no archived_at: a template version is
-- superseded by a higher `version`, never removed (spec:2049; §3.5.4 is unchanged by this slice).
```

`packages/db/migrations/0026.down.sql`:

```sql
drop table if exists app.print_template;
```

- [ ] **Step 4: Write the Drizzle mirror**

`packages/db/src/schema/print-template.ts`:

```ts
import { index, integer, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

export const printTemplate = app.table(
  "print_template",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentTypeId: uuid("document_type_id").notNull(),
    code: text("code").notNull(),
    version: integer("version").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    engine: text("engine").notNull(),
    source: text("source").notNull(),
    paper: text("paper").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    versionUnique: unique("print_template_document_type_id_code_version_key").on(t.documentTypeId, t.code, t.version),
    tenantRow: unique("print_template_tenant_id_id_key").on(t.tenantId, t.id),
    resolveIdx: index("print_template_resolve_idx").on(t.companyId, t.documentTypeId, t.code, t.version),
  }),
);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- test/print-template.test.ts test/privileges.test.ts`
Expected: PASS — 7 print-template tests and the reversibility test of §3.4.6.

> **One consequence to know before Task 7 writes the resolver.** The uniqueness is `(document_type_id, code, version)` and `document_type` is tenant-scoped, not company-scoped — so within a tenant a given type + code + version exists exactly once, and `company_id` records which company owns it. The resolver therefore matches on `company_id` as well, and a second company that wants a different body for the same type uses its own `code` (for example `standard-hq`). This is the frozen §4.5.9 shape; changing it is an amendment to the contracts document, not a plan decision.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0026_create_print_template.sql packages/db/migrations/0026.down.sql \
        packages/db/src/schema/print-template.ts packages/db/test/print-template.test.ts
git commit -m "feat(db): app.print_template — text-defined, versioned, ADR 0016 engines [2C T5]

spec:1240, §4.5.9 verbatim plus the §3.3 app_meta calls the registry snippet omits.
engine's CHECK is ADR 0016's Code vocabulary; no DELETE grant — a version supersedes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `packages/domain/src/print/` — the template source format, the renderer and the print model

Everything in this task is **pure**: no I/O, no framework, no internal imports (§3.1 — `packages/domain` imports nothing from the other packages). That is what makes a rendered document byte-reproducible, which is the property test 15's "prints" clause and 0E's determinism criterion both rest on.

Three pieces. **`parseTemplateSource` / `composeTemplateSource`** split `print_template.source` into a JSON front-matter header and the body, because §4.5.9's frozen DDL has one `source` column and a bilingual template needs its label pairs to travel with its body. **`renderTemplate`** is a deterministic mustache subset — `{{ path }}`, `{{#if path}}…{{else}}…{{/if}}`, `{{#each path}}…{{/each}}` — with engine-aware escaping and **no** raw-output form, so a template can never emit unescaped model data. **`buildPrintModel`** turns a `DocumentSnapshot` (§4.4.2) into flat strings: every monetary value arrives as `Money.toString()` and leaves as a string, so no `number` ever holds money (§3.7.5) and nothing is re-computed on read (spec:2041).

**Files:**
- Create: `packages/domain/src/print/template-source.ts`, `mustache.ts`, `escape.ts`, `model.ts`, `index.ts`; `packages/domain/test/print/template-source.test.ts`, `mustache.test.ts`, `model.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `DocumentSnapshot`, `LineSnapshot` from `packages/domain/src/posting/evaluate.ts` (§4.4.2); `Money`, `Quantity` (§4.2.1).
- Produces:

```ts
// packages/domain/src/print/template-source.ts
export interface PrintTemplateMeta { labels: { en: Record<string, string>; ar: Record<string, string> } }
export const TEMPLATE_FRONT_MATTER = "---dulja-template-v1";
export function parseTemplateSource(source: string): { meta: PrintTemplateMeta; body: string };
export function composeTemplateSource(meta: PrintTemplateMeta, body: string): string;
export class TemplateSourceError extends Error { readonly code: "ERR_TEMPLATE_SOURCE_INVALID" }

// packages/domain/src/print/escape.ts
export function htmlEscape(value: string): string;
export function typstEscape(value: string): string;

// packages/domain/src/print/mustache.ts
export class TemplateError extends Error { readonly code: "ERR_TEMPLATE_INVALID" }
export function renderTemplate(body: string, model: unknown, escape: (value: string) => string): string;

// packages/domain/src/print/model.ts
export interface PrintModelLine { lineNo: number; description: string; account: string; debit: string; credit: string; quantity: string; unitPrice: string; amount: string }
export interface PrintModel {
  lang: "en" | "ar"; dir: "ltr" | "rtl"; rtl: boolean;
  labels: Record<string, string>;
  company: { name: string; baseCurrency: string };
  document: { typeCode: string; typeName: string; status: string; series: string; number: string; effectiveDate: string; effectiveDateHijri: string; currency: string; exchangeRate: string; partyName: string; notes: string };
  lines: PrintModelLine[];
  totals: { debit: string; credit: string; lineCount: number };
}
export interface PrintContext {
  lang: "en" | "ar";
  companyName: string;
  documentTypeNameEn: string; documentTypeNameAr: string | null;
  partyName: string | null;
  notes: string | null;
  accountLabels: Record<string, string>;    // account_id → "1000 · Cash"
  labels: PrintTemplateMeta["labels"];
}
export function buildPrintModel(snapshot: DocumentSnapshot, ctx: PrintContext): PrintModel;
```

- [ ] **Step 1: Write the failing tests**

`packages/domain/test/print/template-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  TEMPLATE_FRONT_MATTER, TemplateSourceError, composeTemplateSource, parseTemplateSource,
} from "../../src/print/template-source";

const META = { labels: { en: { total: "Total" }, ar: { total: "الإجمالي" } } };
const BODY = "<h1>{{ document.typeName }}</h1>\n<p>{{ labels.total }}</p>\n";

describe("print_template.source — front matter plus body (ADR 0032)", () => {
  it("round-trips", () => {
    const source = composeTemplateSource(META, BODY);
    expect(source.startsWith(`${TEMPLATE_FRONT_MATTER}\n`)).toBe(true);
    const parsed = parseTemplateSource(source);
    expect(parsed.meta).toEqual(META);
    expect(parsed.body).toBe(BODY);
  });

  it("keeps the body byte-exact, including a `---` line inside it", () => {
    const body = "a\n---\nb\n";
    expect(parseTemplateSource(composeTemplateSource(META, body)).body).toBe(body);
  });

  it("refuses a source with no front matter, naming what was expected", () => {
    expect(() => parseTemplateSource("<h1>hi</h1>")).toThrow(TemplateSourceError);
    expect(() => parseTemplateSource("<h1>hi</h1>")).toThrow(/---dulja-template-v1/);
  });

  it("refuses front matter that is not JSON, or that lacks both label catalogues", () => {
    expect(() => parseTemplateSource(`${TEMPLATE_FRONT_MATTER}\nnot json\n---\nx`)).toThrow(TemplateSourceError);
    expect(() => parseTemplateSource(`${TEMPLATE_FRONT_MATTER}\n{"labels":{"en":{}}}\n---\nx`))
      .toThrow(/labels\.ar/);
  });
});
```

`packages/domain/test/print/mustache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { htmlEscape, typstEscape } from "../../src/print/escape";
import { TemplateError, renderTemplate } from "../../src/print/mustache";

const model = {
  title: "Cash & <Bank>",
  rtl: false,
  empty: "",
  lines: [{ lineNo: 1, description: "One" }, { lineNo: 2, description: "Two" }],
  none: [] as unknown[],
  document: { number: "17", notes: null as string | null },
};

describe("renderTemplate — the deterministic mustache subset", () => {
  it("substitutes a path and escapes it", () => {
    expect(renderTemplate("<p>{{ title }}</p>", model, htmlEscape)).toBe("<p>Cash &amp; &lt;Bank&gt;</p>");
  });

  it("renders null and undefined as empty, never as the word 'null'", () => {
    expect(renderTemplate("[{{ document.notes }}]", model, htmlEscape)).toBe("[]");
  });

  it("iterates an array, resolving item paths first and root paths second", () => {
    expect(renderTemplate("{{#each lines}}{{ lineNo }}:{{ description }}/{{ document.number }};{{/each}}", model, htmlEscape))
      .toBe("1:One/17;2:Two/17;");
  });

  it("treats an empty array, an empty string and false as falsy in #if", () => {
    expect(renderTemplate("{{#if none}}y{{else}}n{{/if}}", model, htmlEscape)).toBe("n");
    expect(renderTemplate("{{#if empty}}y{{else}}n{{/if}}", model, htmlEscape)).toBe("n");
    expect(renderTemplate("{{#if rtl}}rtl{{else}}ltr{{/if}}", model, htmlEscape)).toBe("ltr");
    expect(renderTemplate("{{#if lines}}some{{else}}none{{/if}}", model, htmlEscape)).toBe("some");
  });

  it("throws on an unknown path rather than rendering a silent blank", () => {
    expect(() => renderTemplate("{{ nope }}", model, htmlEscape)).toThrow(TemplateError);
    expect(() => renderTemplate("{{ document.nope }}", model, htmlEscape)).toThrow(/document\.nope/);
  });

  it("throws on an unbalanced block and on an unknown tag", () => {
    expect(() => renderTemplate("{{#each lines}}x", model, htmlEscape)).toThrow(/unclosed #each/);
    expect(() => renderTemplate("{{#while lines}}x{{/while}}", model, htmlEscape)).toThrow(TemplateError);
    expect(() => renderTemplate("{{{ title }}}", model, htmlEscape)).toThrow(TemplateError);
  });

  it("is deterministic — the same body and model render byte-identically", () => {
    const body = "{{#each lines}}{{ description }}{{/each}}|{{ title }}";
    expect(renderTemplate(body, model, htmlEscape)).toBe(renderTemplate(body, model, htmlEscape));
  });

  it("escapes for typst as well as for html", () => {
    expect(typstEscape("a #b $c [d]")).toBe("a \\#b \\$c \\[d\\]");
    expect(htmlEscape(`a"b'c`)).toBe("a&quot;b&#39;c");
  });
});
```

`packages/domain/test/print/model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Money, currency } from "../../src/money/money";
import { UNIT_RATE } from "../../src/money/exchange-rate";
import type { DocumentSnapshot, LineSnapshot } from "../../src/posting/evaluate";
import { buildPrintModel, type PrintContext } from "../../src/print/model";

const MYR = currency("MYR");
const line = (lineNo: number, description: string, debit: string, credit: string): LineSnapshot => ({
  id: `line-${lineNo}`, lineNo, kind: "account", description,
  accountId: debit === "0.0000" ? "acc-sales" : "acc-cash",
  itemId: null, quantity: null, unitPrice: null, discount: Money.zero(MYR), amount: Money.zero(MYR),
  taxCodeId: null, taxAmount: Money.zero(MYR), totalInclTax: Money.zero(MYR),
  debit: Money.of(debit, MYR), credit: Money.of(credit, MYR), cost: null,
  warehouseId: null, toWarehouseId: null, lotId: null, unitId: null, unitQuantity: null,
  countedQuantity: null, expectedQuantity: null, tenderMethod: null,
  customFields: {}, dimensions: {}, payroll: null,
});

const snapshot: DocumentSnapshot = {
  header: {
    id: "doc-1", companyId: "co-1", documentTypeCode: "JOURNAL", status: "posted", series: "JV",
    fiscalPeriodId: "fp-1", number: 17n, effectiveDate: "2026-01-15", partyId: null, currency: MYR,
    exchangeRate: UNIT_RATE(MYR), branchId: "br-1", attributedTo: null, clientRef: null,
    warehouseId: null, toWarehouseId: null, taxInclusive: false, reversesDocumentId: null, customFields: {},
  },
  lines: [line(1, "Cash received", "150.0000", "0.0000"), line(2, "Sales", "0.0000", "150.0000")],
  company: { id: "co-1", baseCurrency: MYR, fxRoundingAccountId: "acc-fx", costingMethod: "avco" },
  party: null,
  refs: { accountsByCode: {}, items: {}, taxCodes: {}, components: {}, schemes: {}, dimensionTypesByCode: {} },
};

const base: Omit<PrintContext, "lang"> = {
  companyName: "HQ Sdn Bhd",
  documentTypeNameEn: "Journal Voucher", documentTypeNameAr: "قيد يومية",
  partyName: null, notes: "opening entry",
  accountLabels: { "acc-cash": "1000 · Cash", "acc-sales": "4000 · Sales" },
  labels: { en: { total: "Total" }, ar: { total: "الإجمالي" } },
};

describe("buildPrintModel — pure, string-only, bilingual (spec:2253)", () => {
  it("renders the English model with left-to-right direction and the English type name", () => {
    const m = buildPrintModel(snapshot, { ...base, lang: "en" });
    expect(m).toMatchObject({
      lang: "en", dir: "ltr", rtl: false,
      labels: { total: "Total" },
      company: { name: "HQ Sdn Bhd", baseCurrency: "MYR" },
      totals: { debit: "150.0000", credit: "150.0000", lineCount: 2 },
    });
    expect(m.document).toMatchObject({
      typeCode: "JOURNAL", typeName: "Journal Voucher", series: "JV", number: "17",
      effectiveDate: "2026-01-15", currency: "MYR", exchangeRate: "1.00000000", notes: "opening entry",
    });
    expect(m.lines[0]).toEqual({
      lineNo: 1, description: "Cash received", account: "1000 · Cash",
      debit: "150.0000", credit: "0.0000", quantity: "", unitPrice: "", amount: "0.0000",
    });
  });

  it("renders the Arabic model right-to-left with the Arabic type name and label catalogue", () => {
    const m = buildPrintModel(snapshot, { ...base, lang: "ar" });
    expect(m.dir).toBe("rtl");
    expect(m.rtl).toBe(true);
    expect(m.document.typeName).toBe("قيد يومية");
    expect(m.labels["total"]).toBe("الإجمالي");
  });

  it("falls back to the English type name when name_ar is null — never an empty heading", () => {
    const m = buildPrintModel(snapshot, { ...base, lang: "ar", documentTypeNameAr: null });
    expect(m.document.typeName).toBe("Journal Voucher");
  });

  it("carries a Hijri rendering of the effective date alongside the Gregorian one (spec:2039)", () => {
    const m = buildPrintModel(snapshot, { ...base, lang: "ar" });
    expect(m.document.effectiveDate).toBe("2026-01-15");
    expect(m.document.effectiveDateHijri).not.toBe("");
    expect(m.document.effectiveDateHijri).not.toBe(m.document.effectiveDate);
  });

  it("never emits a number where money belongs — every amount is a fixed-scale string", () => {
    const m = buildPrintModel(snapshot, { ...base, lang: "en" });
    for (const v of [m.totals.debit, m.totals.credit, ...m.lines.map((l) => l.debit)]) {
      expect(typeof v).toBe("string");
      expect(v).toMatch(/^-?\d+\.\d{4}$/);
    }
  });

  it("is deterministic — two builds are structurally identical", () => {
    expect(buildPrintModel(snapshot, { ...base, lang: "en" }))
      .toEqual(buildPrintModel(snapshot, { ...base, lang: "en" }));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run --cwd packages/domain test -- test/print`
Expected: FAIL — `Cannot find module '../../src/print/template-source'` for all three files.

- [ ] **Step 3: Write the source format**

`packages/domain/src/print/template-source.ts`:

```ts
export const TEMPLATE_FRONT_MATTER = "---dulja-template-v1";

export interface PrintTemplateMeta {
  labels: { en: Record<string, string>; ar: Record<string, string> };
}

export class TemplateSourceError extends Error {
  readonly code = "ERR_TEMPLATE_SOURCE_INVALID" as const;
}

/**
 * `app.print_template.source` is one column (§4.5.9) and a bilingual template needs its label pairs to
 * travel with its body, so the stored text is a JSON front-matter header followed by `---` and the body.
 * Labels are data, not i18next keys: `packages/domain` may import nothing internal (§3.1), and a template
 * a tenant authored through the API has no place in a shipped catalogue anyway.
 */
export function parseTemplateSource(source: string): { meta: PrintTemplateMeta; body: string } {
  if (!source.startsWith(`${TEMPLATE_FRONT_MATTER}\n`)) {
    throw new TemplateSourceError(`a template source must begin with ${TEMPLATE_FRONT_MATTER} on its own line`);
  }
  const afterHeader = source.slice(TEMPLATE_FRONT_MATTER.length + 1);
  const end = afterHeader.indexOf("\n---\n");
  if (end < 0) {
    throw new TemplateSourceError(`the front matter of a template source must be closed by a line containing exactly ---`);
  }
  let meta: unknown;
  try {
    meta = JSON.parse(afterHeader.slice(0, end));
  } catch (e) {
    throw new TemplateSourceError(`the front matter is not valid JSON: ${(e as Error).message}`);
  }
  const labels = (meta as { labels?: unknown }).labels as PrintTemplateMeta["labels"] | undefined;
  if (!labels || typeof labels !== "object") throw new TemplateSourceError("the front matter must carry `labels`");
  for (const lang of ["en", "ar"] as const) {
    if (!labels[lang] || typeof labels[lang] !== "object") {
      throw new TemplateSourceError(`the front matter must carry labels.${lang} (both catalogues, spec:2061)`);
    }
  }
  return { meta: { labels: { en: labels.en, ar: labels.ar } }, body: afterHeader.slice(end + "\n---\n".length) };
}

export function composeTemplateSource(meta: PrintTemplateMeta, body: string): string {
  return `${TEMPLATE_FRONT_MATTER}\n${JSON.stringify(meta)}\n---\n${body}`;
}
```

- [ ] **Step 4: Write the escapes and the renderer**

`packages/domain/src/print/escape.ts`:

```ts
const HTML: Readonly<Record<string, string>> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML[c]!);
}

/** Typst treats these as markup; a document number or a party name must never become syntax. */
const TYPST = new Set(["\\", "#", "$", "@", "*", "_", "`", "<", ">", '"', "[", "]"]);
export function typstEscape(value: string): string {
  let out = "";
  for (const c of value) out += TYPST.has(c) ? `\\${c}` : c;
  return out;
}
```

`packages/domain/src/print/mustache.ts`:

```ts
export class TemplateError extends Error {
  readonly code = "ERR_TEMPLATE_INVALID" as const;
}

type Node =
  | { kind: "text"; text: string }
  | { kind: "var"; path: string }
  | { kind: "each"; path: string; body: Node[] }
  | { kind: "if"; path: string; then: Node[]; otherwise: Node[] };

interface Tag { raw: string; start: number; end: number }

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function tokenise(body: string): (string | Tag)[] {
  const out: (string | Tag)[] = [];
  let i = 0;
  for (;;) {
    const open = body.indexOf("{{", i);
    if (open < 0) { if (i < body.length) out.push(body.slice(i)); return out; }
    if (open > i) out.push(body.slice(i, open));
    const close = body.indexOf("}}", open + 2);
    if (close < 0) throw new TemplateError(`unclosed {{ at offset ${open}`);
    const raw = body.slice(open + 2, close).trim();
    // `{{{ raw }}}` would begin with `{` — there is deliberately no unescaped form (ADR 0032).
    if (raw.startsWith("{")) throw new TemplateError("the triple-brace raw form is not supported: every value is escaped");
    out.push({ raw, start: open, end: close + 2 });
    i = close + 2;
  }
}

function parse(tokens: (string | Tag)[], at: number, stopper: string | null): { nodes: Node[]; next: number } {
  const nodes: Node[] = [];
  let i = at;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (typeof t === "string") { nodes.push({ kind: "text", text: t }); i += 1; continue; }
    const raw = t.raw;

    if (stopper && (raw === stopper || raw === "else")) return { nodes, next: i };

    if (raw.startsWith("#each ")) {
      const path = raw.slice(6).trim();
      if (!PATH.test(path)) throw new TemplateError(`#each expects a path, got ${JSON.stringify(path)}`);
      const inner = parse(tokens, i + 1, "/each");
      const closer = tokens[inner.next];
      if (typeof closer !== "object" || closer.raw !== "/each") throw new TemplateError(`unclosed #each ${path}`);
      nodes.push({ kind: "each", path, body: inner.nodes });
      i = inner.next + 1;
      continue;
    }

    if (raw.startsWith("#if ")) {
      const path = raw.slice(4).trim();
      if (!PATH.test(path)) throw new TemplateError(`#if expects a path, got ${JSON.stringify(path)}`);
      const thenPart = parse(tokens, i + 1, "/if");
      let otherwise: Node[] = [];
      let cursor = thenPart.next;
      const maybeElse = tokens[cursor];
      if (typeof maybeElse === "object" && maybeElse.raw === "else") {
        const elsePart = parse(tokens, cursor + 1, "/if");
        otherwise = elsePart.nodes;
        cursor = elsePart.next;
      }
      const closer = tokens[cursor];
      if (typeof closer !== "object" || closer.raw !== "/if") throw new TemplateError(`unclosed #if ${path}`);
      nodes.push({ kind: "if", path, then: thenPart.nodes, otherwise });
      i = cursor + 1;
      continue;
    }

    if (raw.startsWith("#") || raw.startsWith("/")) throw new TemplateError(`unknown block tag {{${raw}}}`);
    if (!PATH.test(raw)) throw new TemplateError(`{{${raw}}} is not a valid path`);
    nodes.push({ kind: "var", path: raw });
    i += 1;
  }
  if (stopper) throw new TemplateError(`unclosed ${stopper === "/each" ? "#each" : "#if"} block`);
  return { nodes, next: i };
}

function resolve(path: string, scopes: readonly unknown[]): unknown {
  const segments = path.split(".");
  for (let s = scopes.length - 1; s >= 0; s -= 1) {
    let current = scopes[s];
    let ok = true;
    for (const segment of segments) {
      if (current === null || typeof current !== "object" || !(segment in (current as object))) { ok = false; break; }
      current = (current as Record<string, unknown>)[segment];
    }
    if (ok) return current;
  }
  throw new TemplateError(`the model has no path ${path}`);
}

function stringify(value: unknown, path: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new TemplateError(`${path} is a ${Array.isArray(value) ? "list" : "object"} and cannot be printed directly`);
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false && value !== "" && value !== 0;
}

function emit(nodes: readonly Node[], scopes: readonly unknown[], escape: (v: string) => string): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text": out += node.text; break;
      case "var": out += escape(stringify(resolve(node.path, scopes), node.path)); break;
      case "if":
        out += emit(truthy(resolve(node.path, scopes)) ? node.then : node.otherwise, scopes, escape);
        break;
      case "each": {
        const list = resolve(node.path, scopes);
        if (!Array.isArray(list)) throw new TemplateError(`#each ${node.path} is not a list`);
        for (const item of list) out += emit(node.body, [...scopes, item], escape);
        break;
      }
    }
  }
  return out;
}

/**
 * The deterministic subset: `{{ path }}`, `{{#if path}}…{{else}}…{{/if}}`, `{{#each path}}…{{/each}}`.
 * There is no raw-output form and no expression language, so a template can neither emit unescaped model
 * data nor depend on anything but the model — which is what makes two renders byte-identical.
 */
export function renderTemplate(body: string, model: unknown, escape: (value: string) => string): string {
  const { nodes } = parse(tokenise(body), 0, null);
  return emit(nodes, [model], escape);
}
```

- [ ] **Step 5: Write the print model**

`packages/domain/src/print/model.ts`:

```ts
import type { DocumentSnapshot } from "../posting/evaluate";
import type { PrintTemplateMeta } from "./template-source";

export interface PrintModelLine {
  lineNo: number;
  description: string;
  account: string;
  debit: string;
  credit: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface PrintModel {
  lang: "en" | "ar";
  dir: "ltr" | "rtl";
  rtl: boolean;
  labels: Record<string, string>;
  company: { name: string; baseCurrency: string };
  document: {
    typeCode: string; typeName: string; status: string; series: string; number: string;
    effectiveDate: string; effectiveDateHijri: string;
    currency: string; exchangeRate: string; partyName: string; notes: string;
  };
  lines: PrintModelLine[];
  totals: { debit: string; credit: string; lineCount: number };
}

export interface PrintContext {
  lang: "en" | "ar";
  companyName: string;
  documentTypeNameEn: string;
  documentTypeNameAr: string | null;
  partyName: string | null;
  notes: string | null;
  accountLabels: Record<string, string>;
  labels: PrintTemplateMeta["labels"];
}

/** spec:2039 — "Hijri display is a presentation concern via `Intl`; storage is always Gregorian." */
function hijri(isoDate: string): string {
  return new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura-nu-latn", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

/**
 * Pure. Every monetary value leaves as `Money.toString()` — a fixed four-decimal string — so no `number`
 * ever holds money (§3.7.5) and nothing stored is recomputed on read (spec:2041). Sums are `Money.add`,
 * never JavaScript addition.
 */
export function buildPrintModel(snapshot: DocumentSnapshot, ctx: PrintContext): PrintModel {
  const { header, lines, company } = snapshot;
  const rtl = ctx.lang === "ar";

  let debitTotal = lines.length > 0 ? lines[0]!.debit.subtract(lines[0]!.debit) : null;
  let creditTotal = debitTotal;
  for (const line of lines) {
    debitTotal = debitTotal ? debitTotal.add(line.debit) : line.debit;
    creditTotal = creditTotal ? creditTotal.add(line.credit) : line.credit;
  }

  return {
    lang: ctx.lang,
    dir: rtl ? "rtl" : "ltr",
    rtl,
    labels: ctx.labels[ctx.lang],
    company: { name: ctx.companyName, baseCurrency: String(company.baseCurrency) },
    document: {
      typeCode: header.documentTypeCode,
      // An Arabic template with no name_ar prints the English name rather than an empty heading.
      typeName: rtl ? (ctx.documentTypeNameAr ?? ctx.documentTypeNameEn) : ctx.documentTypeNameEn,
      status: header.status,
      series: header.series ?? "",
      number: header.number === null ? "" : String(header.number),
      effectiveDate: header.effectiveDate,
      effectiveDateHijri: hijri(header.effectiveDate),
      currency: String(header.currency),
      exchangeRate: header.exchangeRate.rate,
      partyName: ctx.partyName ?? "",
      notes: ctx.notes ?? "",
    },
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      description: line.description ?? "",
      account: line.accountId ? (ctx.accountLabels[line.accountId] ?? line.accountId) : "",
      debit: line.debit.toString(),
      credit: line.credit.toString(),
      quantity: line.quantity ? line.quantity.toString() : "",
      unitPrice: line.unitPrice ? line.unitPrice.toString() : "",
      amount: line.amount.toString(),
    })),
    totals: {
      debit: debitTotal ? debitTotal.toString() : "0.0000",
      credit: creditTotal ? creditTotal.toString() : "0.0000",
      lineCount: lines.length,
    },
  };
}
```

`packages/domain/src/print/index.ts`:

```ts
export { htmlEscape, typstEscape } from "./escape";
export { TemplateError, renderTemplate } from "./mustache";
export { buildPrintModel, type PrintContext, type PrintModel, type PrintModelLine } from "./model";
export {
  TEMPLATE_FRONT_MATTER, TemplateSourceError, composeTemplateSource, parseTemplateSource,
  type PrintTemplateMeta,
} from "./template-source";
```

and add `export * from "./print";` to `packages/domain/src/index.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd packages/domain test -- test/print && bun run --cwd packages/domain typecheck`
Expected: PASS — 4 source-format tests, 8 renderer tests, 6 model tests.

- [ ] **Step 7: Confirm the dependency rule still holds**

Run: `bun run lint:rules`
Expected: PASS — `packages/domain/src/print/**` imports only from `packages/domain/src/**` (§3.1); nothing here reaches `@dulja/db`, `@dulja/contracts` or `@dulja/i18n`.

- [ ] **Step 8: Commit**

```bash
git add packages/domain/src/print packages/domain/src/index.ts packages/domain/test/print
git commit -m "feat(domain): print template source format, deterministic renderer, print model [2C T6]

spec:1240 text-defined templates; spec:2253 both directions from one template; spec:2039 Hijri
via Intl. Pure — no I/O, no internal imports. No raw-output form: every value is escaped.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The `templates` sub-pack loader and the print-template configuration API

§3.4.8 assigns 2C the `templates` sub-pack loader; §3.6.2 fixes "print templates … maintained under `admin.company.manage`". **Both are needed and they are not the same thing.** The loader ships the pack a new tenant is bootstrapped with; the API is how a tenant adds a template *without a release*, which is half of what test 15 means by "purely as configuration". They produce identical rows through one composer, so a seeded template and an API-authored one are indistinguishable.

Three edits to 0C's seed CLI come with the loader, and all three are **additive**: `SubPack` and `SUB_PACKS` already carry `"document-types"`, widened by 1A when it shipped its loader (1A Task 13 Step 4, and contracts §4.2.13 records the member), so this slice appends `"templates"` after it — application order, last, exactly as 1A appended — and does not touch the member 1A added; `PHASE_0_SUB_PACK_DIRECTORIES` gains `"templates"` the same way, because §4.2.13's round-2 amendment settles that list as the *required-presence* one, "widened additively by each loader-owning slice exactly as `SUB_PACKS` is" (0C shipped three, 1A appended `document-types`), so from this slice on a pack with no `templates/` is a shape violation and not merely a pack the loader will complain about later; and `assertPackShape` derives its **allowed**-directory set from `SUB_PACKS` instead of from `PHASE_0_SUB_PACK_DIRECTORIES` — the two lists stop being the same list here, which is the whole point of the amendment, and without it `bun run seed` exits **3** ("pack-shape violation") the moment a directory that is legal-but-not-required exists on disk. A **fourth** edit is subtractive and belongs with them: `OWNED_ELSEWHERE` **loses its `templates` entry** — 0C wrote the map with five, 1A took `document-types` out when it shipped that loader (1A Task 13 Step 4), and this task takes `templates` out for the same reason — leaving exactly **three**: `tax` (5A), `reports` (7A) and `statutory` (8A), whose loaders have not shipped and whose directories must still be refused by name. That is the state contracts §4.18 records for the map once both loaders have landed.

**A template is replaced by bumping its `version`, never by re-seeding the same one.** §3.4.8 reserves `on conflict … do update` for `posting_policy` and keeps `do nothing` for every other per-tenant row; `unique (document_type_id, code, version)` is exactly the mechanism that makes that rule work for templates — "version-controlled" (spec:1240) means a changed body is a new version, and Task 8's resolver picks the highest.

**Files:**
- Create: `packages/db/src/seed/templates.ts`, `packages/db/seed/my/templates/JOURNAL.standard.v1.json`, `packages/db/seed/my/templates/JOURNAL.standard.v1.html`, `packages/db/test/seed/templates.test.ts`, `packages/contracts/src/accounting/print-template.ts`, `apps/api/src/routes/accounting/print-templates.ts`, `apps/api/test/routes/accounting/print-templates.test.ts`
- Modify: `packages/db/src/seed/types.ts`, `packages/db/src/seed/packs.ts`, `packages/db/src/seed/index.ts`, `packages/db/test/seed-packs.test.ts`, `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Consumes: `SubPack`, `SUB_PACKS`, `PackLoader`, `LoaderContext`, `SeedError`, `readPackFile`, `assertPackShape`, `PHASE_0_SUB_PACK_DIRECTORIES` (§4.2.13, 0C); `composeTemplateSource`, `parseTemplateSource`, `PrintTemplateMeta` (Task 6); `requirePermission`, `PERMISSION` (§4.2.5); `RouteModule`, `IdempotencyHeader` (§4.2.7); `ListEnvelope`, `UuidSchema`, `TimestampSchema` (§4.2.8).
- Produces:

```ts
// packages/db/src/seed/templates.ts
export interface TemplateManifest {
  documentType: string; code: string; version: number;
  nameEn: string; nameAr?: string;
  engine: "typst" | "chromium" | "react-pdf";
  paper?: "A4" | "A5" | "receipt";
  labels: { en: Record<string, string>; ar: Record<string, string> };
}
export const TEMPLATE_BODY_EXTENSION: Readonly<Record<TemplateManifest["engine"], string>>;   // typst → "typ", the rest → "html"
export function templateFileNames(m: Pick<TemplateManifest, "documentType" | "code" | "version" | "engine">): { manifest: string; body: string };
export const templatesLoader: PackLoader;                       // name: "templates"

// packages/db/src/seed/packs.ts
export function readPackText(packRoot: string, subPack: SubPack, file: string): string;
export const SUB_PACK_DIRECTORIES: readonly string[];           // SUB_PACKS minus "roles" (which is TypeScript data)
export const PHASE_0_SUB_PACK_DIRECTORIES: readonly string[];   // 0C's const, widened with "templates" (§4.2.13)
```

- [ ] **Step 1: Write the failing loader test**

`packages/db/test/seed/templates.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTemplateSource } from "@dulja/domain";
import { templateFileNames, templatesLoader } from "../../src/seed/templates";
import { SUB_PACKS } from "../../src/seed";
import { assertPackShape } from "../../src/seed/packs";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";

const PACK_ROOT = fileURLToPath(new URL("../../seed/my", import.meta.url));

describe("the templates sub-pack loader — contracts §3.4.8, §4.2.13, §4.5.9", () => {
  let db: Db; let a: Seed;

  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  const ctx = () => ({
    config: {} as never, tenantId: a.tenant, companyId: a.company,
    systemPrincipalId: a.system, packRoot: PACK_ROOT,
  });

  it("SUB_PACKS carries document-types and templates in application order", () => {
    expect(SUB_PACKS).toEqual(["roles", "dimensions", "fiscal-periods", "chart-of-accounts", "document-types", "templates"]);
  });

  it("assertPackShape now accepts the shipped pack, which contains templates/", () => {
    expect(() => assertPackShape(PACK_ROOT)).not.toThrow();
  });

  it("derives both file names from the manifest fields", () => {
    expect(templateFileNames({ documentType: "JOURNAL", code: "standard", version: 1, engine: "chromium" }))
      .toEqual({ manifest: "JOURNAL.standard.v1.json", body: "JOURNAL.standard.v1.html" });
    expect(templateFileNames({ documentType: "JOURNAL", code: "standard", version: 1, engine: "typst" }).body)
      .toBe("JOURNAL.standard.v1.typ");
  });

  it("loads JOURNAL.standard.v1 into app.print_template with the front matter composed into source", async () => {
    const loaded = await withTenant(db.rw, a.tenant, a.system, (tx) => templatesLoader.load(tx, ctx()));
    expect(loaded).toBe(1);                       // ONE ROW INSERTED (§4.2.13), not one file seen

    const [row] = await withTenant(db.rw, a.tenant, a.system, (tx) => tx<{
      code: string; version: number; name_en: string; name_ar: string; engine: string; paper: string; source: string;
    }[]>`select code, version, name_en, name_ar, engine, paper, source from app.print_template
          where document_type_id = ${a.docType}`);
    expect(row).toMatchObject({ code: "standard", version: 1, name_en: "Journal Voucher", engine: "chromium", paper: "A4" });
    expect(row!.name_ar).not.toBeNull();

    const parsed = parseTemplateSource(row!.source);
    expect(Object.keys(parsed.meta.labels.en).length).toBeGreaterThan(0);
    expect(Object.keys(parsed.meta.labels.ar).length).toBe(Object.keys(parsed.meta.labels.en).length);
    expect(parsed.body).toContain("{{#each lines}}");
  });

  it("is idempotent — a second run inserts nothing and changes nothing (§3.4.8 `do nothing`)", async () => {
    const before = await withTenant(db.rw, a.tenant, a.system, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.print_template`);
    const loaded = await withTenant(db.rw, a.tenant, a.system, (tx) => templatesLoader.load(tx, ctx()));
    const after = await withTenant(db.rw, a.tenant, a.system, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.print_template`);
    // ZERO rows inserted on a re-run — `PackLoader.load` returns rows inserted, and that number is what
    // "changes nothing" means to the CLI's `SeedResult` (§4.2.13, 0C:2634).
    expect(loaded).toBe(0);
    expect(after[0]!.n).toBe(before[0]!.n);       // rows unchanged — a body change ships as a new version
  });

  it("raises SeedError, not a bare ENOENT, when the pack has no templates directory", async () => {
    const empty = fileURLToPath(new URL("./fixtures/no-templates", import.meta.url));
    await expect(
      withTenant(db.rw, a.tenant, a.system, (tx) => templatesLoader.load(tx, { ...ctx(), packRoot: empty })),
    ).rejects.toThrow(/no-templates[\\/]templates is not a readable directory/);
  });

  it("names the file when a manifest references a document type the tenant does not have", async () => {
    const badPack = fileURLToPath(new URL("./fixtures/bad-templates", import.meta.url));
    await expect(
      withTenant(db.rw, a.tenant, a.system, (tx) => templatesLoader.load(tx, { ...ctx(), packRoot: badPack })),
    ).rejects.toThrow(/NOSUCH\.standard\.v1\.json.*document type NOSUCH/s);
  });
});
```

with the fixture pack the last case needs:

`packages/db/test/seed/fixtures/bad-templates/templates/NOSUCH.standard.v1.json`

```json
{
  "documentType": "NOSUCH",
  "code": "standard",
  "version": 1,
  "nameEn": "Nothing",
  "engine": "chromium",
  "labels": { "en": { "title": "Nothing" }, "ar": { "title": "لا شيء" } }
}
```

`packages/db/test/seed/fixtures/bad-templates/templates/NOSUCH.standard.v1.html`

```html
<h1>{{ labels.title }}</h1>
```

and, for the missing-directory case, a pack root that exists but has no `templates/` in it:

`packages/db/test/seed/fixtures/no-templates/.gitkeep` — an empty file, so git carries the directory.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/seed/templates.test.ts`
Expected: FAIL — `Cannot find module '../../src/seed/templates'`. That is a module-resolution failure, so the file never loads and no case runs; once Step 3 and Step 4 land the module and the pack files, the `SUB_PACKS` case is the one that would still fail on the **five**-member array 1A left behind (ending at `document-types`), and `assertPackShape(PACK_ROOT)` the one that would still fail on 0C's `OWNED_ELSEWHERE` refusing `templates/` by name.

- [ ] **Step 3: Widen the sub-pack registry**

In `packages/db/src/seed/types.ts`:

```ts
/** Application order, never alphabetical: a later pack references rows an earlier one created.
 *  `document-types` is 1A's loader and `templates` is 2C's (§3.4.8); both directories exist on disk
 *  from those slices onward, so `assertPackShape` must admit them. */
export type SubPack =
  | "roles" | "dimensions" | "fiscal-periods" | "chart-of-accounts" | "document-types" | "templates";
export const SUB_PACKS: readonly SubPack[] =
  ["roles", "dimensions", "fiscal-periods", "chart-of-accounts", "document-types", "templates"];
```

In `packages/db/src/seed/packs.ts`, append `"templates"` to `PHASE_0_SUB_PACK_DIRECTORIES` (§4.2.13's amendment: it is the **required-presence** list, "widened additively by each loader-owning slice exactly as `SUB_PACKS` is" — 0C declared three, 1A appended `document-types` with its loader, this slice appends `templates` with its own), delete the `templates: "2C"` entry from `OWNED_ELSEWHERE` — it is now three entries, `tax`, `reports` and `statutory` — replace the allowed-directory half of `assertPackShape`, and add the text reader:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SeedError, SUB_PACKS, type SubPack } from "./types";

/** Every sub-pack that is a DIRECTORY under the pack root. `roles` is TypeScript data
 *  (`packages/db/seed/roles.ts`) and has no directory (§3.4.8). */
export const SUB_PACK_DIRECTORIES: readonly string[] = SUB_PACKS.filter((p) => p !== "roles");

/** The REQUIRED-presence list (§4.2.13's round-2 amendment keeps the spelling and amends the meaning):
 *  every directory a pack must CONTAIN. 0C shipped three; 1A appended `document-types` with its loader;
 *  2C appends `templates` with its own. The ALLOWED set is `SUB_PACK_DIRECTORIES` above, and from this
 *  slice onward the two are computed separately. */
export const PHASE_0_SUB_PACK_DIRECTORIES: readonly string[] =
  ["chart-of-accounts", "dimensions", "fiscal-periods", "document-types", "templates"];

/** 0C declared five; 1A removed `document-types` with its loader, this slice removes `templates` with
 *  its own. Three remain — the sub-packs whose loaders have not shipped, named so the refusal says
 *  whose they are (§3.4.8). */
const OWNED_ELSEWHERE: Readonly<Record<string, string>> = {
  tax: "5A", reports: "7A", statutory: "8A",
};

export function assertPackShape(packRoot: string): void {
  const present = readdirSync(packRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const required of PHASE_0_SUB_PACK_DIRECTORIES) {
    if (!present.includes(required)) throw new SeedError(`missing sub-pack: ${required} (in ${packRoot})`);
  }
  for (const found of present) {
    // A directory whose loader has SHIPPED is legal; one whose loader has not is the F-21 failure
    // 0C wrote this check for, and still names its owner.
    if (SUB_PACK_DIRECTORIES.includes(found)) continue;
    const owner = OWNED_ELSEWHERE[found];
    throw new SeedError(
      owner
        ? `unexpected sub-pack: ${found} — ${found}/ is slice ${owner}'s and its loader has not shipped (contracts §3.4.8)`
        : `unexpected sub-pack: ${found} — the known sub-packs are ${SUB_PACK_DIRECTORIES.join(", ")}`,
    );
  }
}

/** `readPackFile`'s twin for a body that is not JSON — a template source (§4.5.9). */
export function readPackText(packRoot: string, subPack: SubPack, file: string): string {
  try {
    return readFileSync(join(packRoot, subPack, file), "utf8");
  } catch {
    throw new SeedError(`seed pack file not found: ${subPack}/${file} (looked in ${packRoot})`);
  }
}
```

and update the `assertPackShape` expectations in `packages/db/test/seed-packs.test.ts`. 0C's pinned literal on the list itself gains the fifth member; the accept case stays `pack([...PHASE_0_SUB_PACK_DIRECTORIES])` and **must not** have `"templates"` spread in beside it, because the member is now *inside* the list and `pack()` would be asked to make the same directory twice; a new case proves the presence half of the amendment; and only the unshipped owners throw. 0C's other two cases are untouched and still pass — `pack(["chart-of-accounts", "dimensions"])` still reports `missing sub-pack: fiscal-periods` (the loop hits it first) and the `tax` case still names slice 5A:

```ts
    expect(PHASE_0_SUB_PACK_DIRECTORIES)
      .toEqual(["chart-of-accounts", "dimensions", "fiscal-periods", "document-types", "templates"]);
    // A pack holding exactly the required set is legal — both shipped loaders' directories are in it.
    expect(() => assertPackShape(pack([...PHASE_0_SUB_PACK_DIRECTORIES]))).not.toThrow();
    // REQUIRED-presence, not merely allowed (§4.2.13): a pack without `templates/` is a shape violation.
    expect(() => assertPackShape(pack(PHASE_0_SUB_PACK_DIRECTORIES.filter((d) => d !== "templates"))))
      .toThrow(/missing sub-pack: templates/);
    expect(() => assertPackShape(pack([...PHASE_0_SUB_PACK_DIRECTORIES, "tax"])))
      .toThrow(/tax\/ is slice 5A's and its loader has not shipped/);
```

- [ ] **Step 4: Write the loader and the seeded template**

`packages/db/src/seed/templates.ts`:

```ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { composeTemplateSource } from "@dulja/domain";
import { SeedError } from "./types";
// `LoaderContext` and `PackLoader` are declared in `./packs` (contracts §4.2.13; 0C's own loaders import
// them from there — 0C:3139, 3194). Importing them from `./index` would depend on a barrel re-export 0C
// does not promise, and would make this module import the seed barrel it is registered in.
import { readPackFile, readPackText, type LoaderContext, type PackLoader } from "./packs";

export interface TemplateManifest {
  documentType: string;
  code: string;
  version: number;
  nameEn: string;
  nameAr?: string;
  engine: "typst" | "chromium" | "react-pdf";
  paper?: "A4" | "A5" | "receipt";
  labels: { en: Record<string, string>; ar: Record<string, string> };
}

/** The body's extension follows the engine, so `<TYPE>.<code>.v<N>.<ext>` (§4.5.9) is mechanical. */
export const TEMPLATE_BODY_EXTENSION: Readonly<Record<TemplateManifest["engine"], string>> = {
  typst: "typ", chromium: "html", "react-pdf": "html",
};

export function templateFileNames(
  m: Pick<TemplateManifest, "documentType" | "code" | "version" | "engine">,
): { manifest: string; body: string } {
  const stem = `${m.documentType}.${m.code}.v${m.version}`;
  return { manifest: `${stem}.json`, body: `${stem}.${TEMPLATE_BODY_EXTENSION[m.engine]}` };
}

function assertManifest(file: string, m: TemplateManifest): void {
  const fail = (why: string): never => { throw new SeedError(`${file}: ${why}`); };
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(m.documentType ?? "")) fail("documentType must match ^[A-Z][A-Z0-9_]{1,63}$");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(m.code ?? "")) fail("code must match ^[a-z][a-z0-9-]{0,31}$");
  if (!Number.isInteger(m.version) || m.version < 1) fail("version must be a positive integer");
  if (!m.nameEn) fail("nameEn is required");
  if (!(m.engine in TEMPLATE_BODY_EXTENSION)) fail(`engine must be one of ${Object.keys(TEMPLATE_BODY_EXTENSION).join(", ")} (ADR 0016)`);
  for (const lang of ["en", "ar"] as const) {
    if (!m.labels?.[lang] || typeof m.labels[lang] !== "object") fail(`labels.${lang} is required (spec:2061 — both catalogues)`);
  }
  const expected = templateFileNames(m).manifest;
  if (file !== expected) fail(`file name must be ${expected} for this documentType/code/version/engine`);
}

/**
 * The `--only templates` loader (§3.4.8, §4.2.13). Reads every `*.json` manifest under
 * `<packRoot>/templates/`, reads its body beside it, composes the two into `print_template.source`
 * (ADR 0032) and inserts `on conflict … do nothing`: §3.4.8 reserves `do update` for `posting_policy`,
 * and a changed template body ships as a NEW `version`, which is what `unique (document_type_id, code,
 * version)` and spec:1240's "version-controlled" mean.
 *
 * **Returns the number of ROWS INSERTED**, which is `PackLoader.load`'s contract verbatim — "a loader
 * returns the number of rows it inserted — zero on a re-run, which is what 'changes nothing' means"
 * (§4.2.13, 0C:2634). `on conflict … do nothing` returns no row on a hit, so counting the `returning id`
 * results is exact. Returning the number of manifests *seen* would make the CLI's `SeedResult` useless as
 * §3.4.8's idempotence signal for this sub-pack, and any later loader copied from this one would inherit
 * the wrong semantics.
 */
export const templatesLoader: PackLoader = {
  name: "templates",
  async load(tx, ctx: LoaderContext): Promise<number> {
    const dir = join(ctx.packRoot, "templates");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    } catch (e) {
      // A pack root without the directory must exit 1 with a message naming it, like every other seed
      // failure (0C's exit codes) — never a bare ENOENT stack trace out of node:fs.
      throw new SeedError(`${dir} is not a readable directory — a templates pack needs it (§3.4.8): ${String(e)}`);
    }

    let inserted = 0;
    for (const file of files) {
      const manifest = readPackFile<TemplateManifest>(ctx.packRoot, "templates", file);
      assertManifest(file, manifest);
      const body = readPackText(ctx.packRoot, "templates", templateFileNames(manifest).body);
      const source = composeTemplateSource({ labels: manifest.labels }, body);

      const [type] = await tx<{ id: string }[]>`
        select id from app.document_type where code = ${manifest.documentType}`;
      if (!type) {
        throw new SeedError(`${file}: document type ${manifest.documentType} is not seeded for this tenant — seed --only document-types first (contracts §3.4.8)`);
      }

      const rows = await tx<{ id: string }[]>`
        insert into app.print_template (tenant_id, company_id, document_type_id, code, version, name_en, name_ar, engine, source, paper)
        values (${ctx.tenantId}, ${ctx.companyId}, ${type.id}, ${manifest.code}, ${manifest.version},
                ${manifest.nameEn}, ${manifest.nameAr ?? null}, ${manifest.engine}, ${source}, ${manifest.paper ?? "A4"})
        on conflict (document_type_id, code, version) do nothing
        returning id`;
      inserted += rows.length;
    }
    return inserted;
  },
};
```

Register it in `packages/db/src/seed/index.ts` beside 0C's four loaders and re-export the loader module.

`packages/db/seed/my/templates/JOURNAL.standard.v1.json`:

```json
{
  "documentType": "JOURNAL",
  "code": "standard",
  "version": 1,
  "nameEn": "Journal Voucher",
  "nameAr": "قيد يومية",
  "engine": "chromium",
  "paper": "A4",
  "labels": {
    "en": {
      "documentNo": "Document no.", "date": "Date", "dateHijri": "Hijri date", "currency": "Currency",
      "line": "#", "description": "Description", "account": "Account", "debit": "Debit", "credit": "Credit",
      "total": "Total", "notes": "Notes", "status": "Status"
    },
    "ar": {
      "documentNo": "رقم المستند", "date": "التاريخ", "dateHijri": "التاريخ الهجري", "currency": "العملة",
      "line": "#", "description": "البيان", "account": "الحساب", "debit": "مدين", "credit": "دائن",
      "total": "الإجمالي", "notes": "ملاحظات", "status": "الحالة"
    }
  }
}
```

`packages/db/seed/my/templates/JOURNAL.standard.v1.html` — logical properties only, so one template renders both directions (spec:2253, spec:1131):

```html
<!doctype html>
<html lang="{{ lang }}" dir="{{ dir }}">
<head>
<meta charset="utf-8">
<style>
  :root { font-family: "Noto Sans", "Noto Sans Arabic", system-ui, sans-serif; font-size: 11pt; }
  body { margin: 0; padding: 16mm; }
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-block-end: 8mm; }
  h1 { font-size: 16pt; margin: 0 0 2mm; }
  dl { display: grid; grid-template-columns: auto auto; gap: 1mm 4mm; margin: 0; }
  dt { color: #555; }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-block-end: 0.3mm solid #ccc; padding: 2mm 1mm; text-align: start; }
  th.num, td.num { text-align: end; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 600; border-block-end: none; border-block-start: 0.5mm solid #333; }
  footer { margin-block-start: 8mm; color: #555; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>{{ document.typeName }}</h1>
      <div>{{ company.name }}</div>
    </div>
    <dl>
      <dt>{{ labels.documentNo }}</dt><dd>{{ document.series }}-{{ document.number }}</dd>
      <dt>{{ labels.date }}</dt><dd>{{ document.effectiveDate }}</dd>
      <dt>{{ labels.dateHijri }}</dt><dd>{{ document.effectiveDateHijri }}</dd>
      <dt>{{ labels.currency }}</dt><dd>{{ document.currency }}</dd>
      <dt>{{ labels.status }}</dt><dd>{{ document.status }}</dd>
    </dl>
  </header>

  <table>
    <thead>
      <tr>
        <th>{{ labels.line }}</th>
        <th>{{ labels.description }}</th>
        <th>{{ labels.account }}</th>
        <th class="num">{{ labels.debit }}</th>
        <th class="num">{{ labels.credit }}</th>
      </tr>
    </thead>
    <tbody>
      {{#each lines}}
      <tr>
        <td>{{ lineNo }}</td>
        <td>{{ description }}</td>
        <td>{{ account }}</td>
        <td class="num">{{ debit }}</td>
        <td class="num">{{ credit }}</td>
      </tr>
      {{/each}}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3">{{ labels.total }}</td>
        <td class="num">{{ totals.debit }}</td>
        <td class="num">{{ totals.credit }}</td>
      </tr>
    </tfoot>
  </table>

  {{#if document.notes}}<footer>{{ labels.notes }}: {{ document.notes }}</footer>{{/if}}
</body>
</html>
```

> **`"engine": "chromium"` is the default this plan writes, not a choice it makes.** ADR 0016's **Decision** row (0E Task 14) names the engine; if it names `typst`, the change is two edits and nothing else: set `"engine": "typst"` in this manifest and rename the body to `JOURNAL.standard.v1.typ` with the Typst body of Task 8 Step 5's engine fixture as its starting point. Every test in this slice reads the engine from the row and passes either way.

- [ ] **Step 5: Run the loader test to verify it passes**

Run: `bun run --cwd packages/db test -- test/seed/templates.test.ts test/seed-packs.test.ts`
Expected: PASS — 7 loader tests and 0C's seed-pack tests with the two updated expectations.

- [ ] **Step 6: Write the failing API test**

`apps/api/test/routes/accounting/print-templates.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { parseTemplateSource } from "@dulja/domain";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { grantAdmin } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const body = {
  documentTypeCode: "JOURNAL", code: "compact", version: 1,
  nameEn: "Compact voucher", nameAr: "قيد مختصر",
  engine: "chromium" as const, paper: "A5" as const,
  labels: { en: { total: "Total" }, ar: { total: "الإجمالي" } },
  body: "<p>{{ labels.total }} {{ totals.debit }}</p>",
};

describe("/v1/companies/{companyId}/print-templates — configuration, not code (test 15)", () => {
  let api: StartedApi; let a: Seed; let b: Seed;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    b = await seedTenantV2(api.db, "Beta");
    await grantAdmin(api, a);
  }, 180_000);
  afterAll(async () => { await api.stop(); });

  it("creates a template and stores front matter plus body in one source column", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/print-templates`, as: a.human, body,
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; code: string; version: number; source: string; paper: string };
    expect(created).toMatchObject({ code: "compact", version: 1, paper: "A5" });
    const parsed = parseTemplateSource(created.source);
    expect(parsed.meta.labels.ar["total"]).toBe("الإجمالي");
    expect(parsed.body).toBe(body.body);
  });

  it("refuses a duplicate (type, code, version) with ERR_CONFLICT_UNIQUE", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/print-templates`, as: a.human, body,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("refuses an engine ADR 0016 does not name", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/print-templates`, as: a.human,
      body: { ...body, code: "bad", engine: "wkhtmltopdf" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("refuses a template body the renderer cannot parse — a broken template never reaches the table", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/print-templates`, as: a.human,
      body: { ...body, code: "broken", body: "{{#each lines}}oops" },
    });
    expect(res.status).toBe(400);
    const problem = await res.json() as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toContain("unclosed #each");
  });

  it("refuses an unknown document type with 404", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/print-templates`, as: a.human,
      body: { ...body, code: "orphan", documentTypeCode: "NOSUCH" },
    });
    expect(res.status).toBe(404);
  });

  it("requires admin.company.manage", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${b.company}/print-templates`, as: b.human, body: { ...body, code: "nope" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("lists a company's templates", async () => {
    const res = await api.request({
      method: "GET", path: `/v1/companies/${a.company}/print-templates`, as: a.human,
    });
    expect(res.status).toBe(200);
    const list = await res.json() as { items: { code: string }[]; next_cursor: string | null };
    expect(list.items.map((i) => i.code)).toContain("compact");
    expect(list.next_cursor).toBeNull();
  });
});
```

- [ ] **Step 7: Write the contracts module and the routes**

`packages/contracts/src/accounting/print-template.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/** The `Code` column of ADR 0016's Verdict table — the same closed set as `print_template.engine`'s CHECK. */
export const PrintEngineSchema = z.enum(["typst", "chromium", "react-pdf"]);
export const PaperSchema = z.enum(["A4", "A5", "receipt"]);
export const TemplateLabelsSchema = z.object({ en: z.record(z.string()), ar: z.record(z.string()) });

export const PrintTemplateSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  documentTypeId: UuidSchema,
  documentTypeCode: z.string(),
  code: z.string(),
  version: z.number().int().positive(),
  nameEn: z.string(),
  nameAr: z.string().nullable(),
  engine: PrintEngineSchema,
  paper: PaperSchema,
  source: z.string(),                    // front matter + body, exactly as stored (spec:1240 "diffable")
  createdAt: TimestampSchema,
}).openapi("PrintTemplate");

export const CreatePrintTemplateBody = z.object({
  documentTypeCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  code: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  version: z.number().int().positive(),
  nameEn: z.string().min(1),
  nameAr: z.string().nullable().optional(),
  engine: PrintEngineSchema,
  paper: PaperSchema.default("A4"),
  labels: TemplateLabelsSchema,
  body: z.string().min(1),
}).openapi("CreatePrintTemplate");

export const PrintTemplateList = ListEnvelope(PrintTemplateSchema);
```

`apps/api/src/routes/accounting/print-templates.ts`:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AppError, CreatePrintTemplateBody, PrintTemplateList, PrintTemplateSchema, ProblemSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { composeTemplateSource, renderTemplate, htmlEscape, TemplateError } from "@dulja/domain";
import { fromDatabaseError } from "@dulja/contracts";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../index";

export const PRINT_TEMPLATES_PATH = "/v1/companies/:companyId/print-templates";

/** `document_type_code` is not a column of `app.print_template`: the insert's `Row` gets it from the
 *  request (the caller already holds it) and the list's from the join. Nothing interpolates a column
 *  list — `tx.unsafe` has exactly three homes and none is here (§3.3, hazard 21). */

interface Row {
  id: string; company_id: string; document_type_id: string; code: string; version: number;
  name_en: string; name_ar: string | null; engine: string; paper: string; source: string; created_at: Date;
  document_type_code: string;
}

const toDto = (r: Row) => ({
  id: r.id, companyId: r.company_id, documentTypeId: r.document_type_id, documentTypeCode: r.document_type_code,
  code: r.code, version: r.version, nameEn: r.name_en, nameAr: r.name_ar, engine: r.engine as "chromium",
  paper: r.paper as "A4", source: r.source, createdAt: r.created_at.toISOString(),
});

export const printTemplateRoutes = new OpenAPIHono<AppEnv>();

printTemplateRoutes.openapi(
  createRoute({
    method: "post", path: "/", tags: ["accounting"],
    summary: "Add a print template version",
    middleware: [requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" })],
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: z.string().uuid() }),
      body: { content: { "application/json": { schema: CreatePrintTemplateBody } }, required: true },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: PrintTemplateSchema } } },
      400: { description: "Invalid", content: { "application/problem+json": { schema: ProblemSchema } } },
      404: { description: "No such document type", content: { "application/problem+json": { schema: ProblemSchema } } },
      409: { description: "Version exists", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const companyId = c.req.param("companyId")!;
    const input = c.req.valid("json");

    // Parse the body BEFORE it reaches the table: a template that cannot render is a 400 now, not a
    // 500 on the first print. The model is irrelevant here — only the grammar is being checked.
    try {
      renderTemplate(input.body, {}, htmlEscape);
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      // A path the empty model lacks is expected and fine; only a GRAMMAR error is rejected.
      if (!/the model has no path/.test(e.message)) {
        throw new AppError("ERR_VALIDATION_FAILED", e.message,
          { errors: [{ path: "body", message: e.message }] });
      }
    }

    const source = composeTemplateSource({ labels: input.labels }, input.body);

    const row = await c.var.withTenant(async (tx) => {
      const [type] = await tx<{ id: string }[]>`
        select id from app.document_type where code = ${input.documentTypeCode} and archived_at is null`;
      if (!type) throw new AppError("ERR_NOT_FOUND", `document type ${input.documentTypeCode} does not exist`);

      try {
        // A bare bind parameter in a RETURNING target list has no inferable type and raises
        // `42P18 could not determine data type of parameter`, so `document_type_code` is NOT
        // selected back — it is the code the caller sent, and it is attached here.
        const [inserted] = await tx<Omit<Row, "document_type_code">[]>`
          insert into app.print_template (tenant_id, company_id, document_type_id, code, version, name_en, name_ar, engine, source, paper)
          values (${c.var.ctx.tenantId}, ${companyId}, ${type.id}, ${input.code}, ${input.version},
                  ${input.nameEn}, ${input.nameAr ?? null}, ${input.engine}, ${source}, ${input.paper})
          returning id, company_id, document_type_id, code, version, name_en, name_ar, engine, paper,
                    source, created_at`;
        return { ...inserted!, document_type_code: input.documentTypeCode };
      } catch (e) {
        throw fromDatabaseError(e);
      }
    });

    return c.json(toDto(row), 201);
  },
);

printTemplateRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["accounting"],
    summary: "List a company's print templates",
    middleware: [requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" })],
    request: { params: z.object({ companyId: z.string().uuid() }) },
    responses: { 200: { description: "Templates", content: { "application/json": { schema: PrintTemplateList } } } },
  }),
  async (c) => {
    const companyId = c.req.param("companyId")!;
    const rows = await c.var.withTenant((tx) => tx<Row[]>`
      select t.id, t.company_id, t.document_type_id, t.code, t.version, t.name_en, t.name_ar,
             t.engine, t.paper, t.source, t.created_at, dt.code as document_type_code
        from app.print_template t
        join app.document_type dt on dt.id = t.document_type_id
       where t.company_id = ${companyId}
       order by dt.code, t.code, t.version`);
    return c.json({ items: rows.map(toDto), next_cursor: null }, 200);
  },
);
```

Register it in `buildRoutes`:

```ts
    { path: PRINT_TEMPLATES_PATH, router: printTemplateRoutes, permissions: [PERMISSION["admin.company.manage"]], auth: "human" },
```

and add its probe to `tests/invariants/probes.ts`:

```ts
  "/v1/companies/:companyId/print-templates": {
    async seed(_db, owner) {
      return {
        path: `/v1/companies/${owner.company}/print-templates`,
        method: "GET",
      };
    },
    expect: 403,
  },
```

- [ ] **Step 8: Run everything**

Run: `bun run --cwd apps/api test -- test/routes/accounting/print-templates.test.ts && bun run --cwd tests test -- invariants/tenant-isolation.test.ts && bun run --cwd packages/contracts openapi:generate`
Expected: PASS — 7 API tests, the isolation harness with the new probe, and `packages/contracts/openapi.json` gains the two operations.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/seed packages/db/seed/my/templates packages/db/test/seed \
        packages/db/test/seed-packs.test.ts packages/contracts/src/accounting/print-template.ts \
        packages/contracts/src/index.ts packages/contracts/openapi.json \
        apps/api/src/routes/accounting/print-templates.ts apps/api/src/routes/index.ts \
        apps/api/test/routes/accounting/print-templates.test.ts tests/invariants/probes.ts
git commit -m "feat(db): templates sub-pack loader and the print-template API [2C T7]

§3.4.8 assigns 2C the templates loader; §3.6.2 puts templates under admin.company.manage.
Both compose the same source. SubPack, SUB_PACKS and PHASE_0_SUB_PACK_DIRECTORIES each gain
templates (1A already added document-types), and assertPackShape now takes its ALLOWED set
from SUB_PACKS while PHASE_0_SUB_PACK_DIRECTORIES stays the REQUIRED one — §4.2.13's round-2
settlement. The two lists stop being one, so a shipped loader's directory stops exiting 3.
A changed body is a new version — §3.4.8 keeps `do nothing` for everything but posting_policy.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `packages/db/src/print/` — loading a template and a document, and the ADR-0016 engine adapters

Task 6 built the pure half: a parser, a renderer and a model builder that touch no database and no filesystem. This task builds the impure half in the two places the dependency rule allows. `packages/db/src/print/` reads the template row and the document under RLS and produces **rendered template text**; `apps/api/src/print/engines/` turns that text into PDF bytes. The seam between them is a string, which is what makes the renderer testable without a browser and the engines testable without a database.

**`engine` has three codes and this slice ships two adapters.** ADR 0016's Verdict table (0E Task 14) fixes the vocabulary `typst | chromium | react-pdf` and migration 0026's CHECK holds all three, because hazard 30 forbids re-opening that decision. But `react-pdf` renders a **React component**, not template text — it is not a text-defined, diffable template in the sense of spec:1240, so there is no way to feed it a `print_template.source` string. `engineFor("react-pdf")` therefore throws `ERR_PRINT_ENGINE_UNSUPPORTED`, and that is the entire reason this slice's one new error code exists. ADR 0032 records it: the code stays in the CHECK (the vocabulary is frozen) and stays out of `PDF_ENGINES` (no adapter can exist). If ADR 0016's Decision names `react-pdf`, this slice stops and raises it — that is the "no candidate passes" branch ADR 0016 already anticipates, and 2C cannot ship templates without a text-driven engine.

**`document.notes` is Task 11's column, so `loadPrintContext` returns `notes: null` here.** `PrintContext.notes` exists in Task 6's type because the print model needs the field, but migration 0027 is Task 11 — a `select notes from app.document` in this task fails against the test database. Task 11 adds the read and the assertion that notes print. The task numbers are cited in the header table and in Task 6's model, so they are not reordered.

**Files:**
- Create: `packages/db/src/print/template.ts`, `packages/db/src/print/index.ts`, `packages/db/test/print-render.test.ts`, `apps/api/src/print/engines/index.ts`, `apps/api/src/print/engines/chromium.ts`, `apps/api/src/print/engines/typst.ts`, `apps/api/test/print/engines.test.ts`, `docs/adr/0032-print-template-format-and-engine.md`
- Modify: `packages/db/src/index.ts`, `packages/contracts/src/errors.ts`, `apps/api/package.json`

**Interfaces:**
- Consumes: `loadSnapshot(tx, documentId)` and `PostingError` (§4.3.1, 1A); `DocumentSnapshot` (§4.4.2); `buildPrintModel`, `PrintContext`, `PrintModel`, `parseTemplateSource`, `renderTemplate`, `htmlEscape`, `typstEscape`, `TemplateError`, `TemplateSourceError` (Task 6); `TenantContext` (§4.2.2); `ERRORS`, `ErrorDef` (§4.2.4); `startDb`, `Db`, `uuidv7`, `seedTenantV2`, `grantCodes`, `draftDocument`, `Seed` (§4.1, §4.17); `postJournal` (§4.17.1, 1B).
- Produces:

```ts
// packages/db/src/print/template.ts
/** Declared in the leaf and re-exported from `./index`, so the import graph runs one way.
 *  `packages/db` cannot import `AppError` (§4.2.4's declared `PostingError` exception). */
export class PrintError extends Error {
  constructor(readonly code: "ERR_NOT_FOUND" | "ERR_VALIDATION_FAILED", readonly detail: string);
}
export interface PrintTemplateRow {
  id: string; companyId: string; documentTypeId: string; code: string; version: number;
  nameEn: string; nameAr: string | null; engine: string; paper: string; source: string;
}
/** The default template code when a print request names none. One literal, one place. */
export const DEFAULT_TEMPLATE_CODE = "standard";
/** The highest `version` of `(document_type_id, code)` — a new version supersedes (§3.9 Deletion, constraint 8). */
export async function resolvePrintTemplate(
  tx: Sql,
  params: { companyId: string; documentTypeId: string; templateCode?: string },
): Promise<PrintTemplateRow>;                                       // PrintError("ERR_NOT_FOUND")
/** Everything `buildPrintModel` needs that is NOT in the snapshot: the company name, the type's two
 *  names, the party name and the account labels the model prints instead of raw uuids. */
/** `lang` is a parameter because the party's and each account's display name are two COLUMNS in the
 *  database (`name_en` / `name_ar`), so the choice — and the `coalesce(name_ar, name_en)` fallback — has to
 *  be made in SQL. The document type's two names stay on `PrintContext` unresolved because `buildPrintModel`
 *  also picks `dir` from `lang` and a golden test must be able to see both. */
export async function loadPrintContext(
  tx: Sql,
  documentId: string,
  lang: "en" | "ar",
): Promise<Omit<PrintContext, "lang" | "labels">>;

// packages/db/src/print/index.ts
export interface RenderedDocument {
  rendered: string;                 // the template text with the model substituted — NOT a PDF
  engine: string;                   // the row's ADR-0016 code; the API maps it to an adapter
  paper: string;
  templateId: string; templateCode: string; templateVersion: number;
  fileStem: string;                 // "JV-000017-en" — the Content-Disposition stem, no extension
  model: PrintModel;                // returned so a test can assert the model without re-deriving it
}
export async function renderDocumentSource(
  tx: Sql,
  params: { documentId: string; templateCode?: string; lang: "en" | "ar" },
): Promise<RenderedDocument>;
export { PrintError } from "./template";          // re-exported, declared in the leaf

// apps/api/src/print/engines/index.ts
export type PrintEngineCode = "typst" | "chromium" | "react-pdf";
export interface PdfEngine {
  readonly code: PrintEngineCode;
  /** `paper` is `print_template.paper`; the adapter maps it to its own page-size vocabulary. */
  render(source: string, opts: { paper: string; dir: "ltr" | "rtl" }): Promise<Uint8Array>;
}
/** One entry per ADR-0016 code that can consume TEMPLATE TEXT. `react-pdf` is deliberately absent. */
export const PDF_ENGINES: Readonly<Partial<Record<PrintEngineCode, PdfEngine>>>;
export function engineFor(code: string): PdfEngine;                 // AppError ERR_PRINT_ENGINE_UNSUPPORTED
export const PDF_MAGIC: Uint8Array;                                 // %PDF- — what every adapter's output starts with
```

- [ ] **Step 1: Write the failing loader test**

`packages/db/test/print-render.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrintError, renderDocumentSource } from "../src/print";
import { DEFAULT_TEMPLATE_CODE, loadPrintContext, resolvePrintTemplate } from "../src/print/template";
import { composeTemplateSource } from "@dulja/domain";
import { postDocument } from "../src/posting";
import { withTenant as prodWithTenant } from "../src/with-tenant";
import { startDb, uuidv7, type Db } from "./harness";
import { draftDocument, grantCodes, seedTenantV2, type Seed } from "./fixtures";

const LABELS = {
  en: { total: "Total", account: "Account", debit: "Debit", credit: "Credit" },
  ar: { total: "الإجمالي", account: "الحساب", debit: "مدين", credit: "دائن" },
};
const BODY = [
  "<h1 dir=\"{{ dir }}\">{{ document.typeName }}</h1>",
  "<p>{{ company.name }} — {{ document.series }}-{{ document.number }}</p>",
  "<table>{{#each lines}}<tr><td>{{ account }}</td><td>{{ debit }}</td><td>{{ credit }}</td></tr>{{/each}}</table>",
  "<p>{{ labels.total }}: {{ totals.debit }}</p>",
  "{{#if document.notes}}<p class=\"notes\">{{ document.notes }}</p>{{/if}}",
].join("\n");

const ctx = (s: Seed, requestId: string) => ({ tenantId: s.tenant, actorId: s.human, requestId });

async function seedTemplate(db: Db, s: Seed, opts: { code?: string; version?: number; engine?: string }) {
  const requestId = await uuidv7(db.admin);
  return prodWithTenant(db.rw, ctx(s, requestId), async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into app.print_template
        (tenant_id, company_id, document_type_id, code, version, name_en, name_ar, engine, source, paper)
      values (${s.tenant}, ${s.company}, ${s.docType}, ${opts.code ?? DEFAULT_TEMPLATE_CODE},
              ${opts.version ?? 1}, 'Journal Voucher', 'قيد يومية', ${opts.engine ?? "chromium"},
              ${composeTemplateSource({ labels: LABELS }, BODY)}, 'A4')
      returning id`;
    return row!.id;
  });
}

/**
 * A posted JOURNAL, file-local. §4.17 assigns 2C no fixture helper and hazard 9 forbids inventing one,
 * and 1B's `postJournal` lives in `tests/invariants/support/` — the root test tier, which
 * `packages/db/test` cannot import (§3.1). So this is a local function in the one file that needs it,
 * shaped exactly like 1A's `packages/db/test/posting/post.test.ts`. The `grantCodes` call is not
 * optional: 2B's R2 runs `app.actor_has(policy.approval.post, …)` inside the posting transaction and
 * `seedTenant` grants `s.human` nothing (§4.1, pinned).
 */
async function postJournalLocal(
  db: Db,
  s: Seed,
  lines: readonly { accountId: string; debit?: string; credit?: string; description?: string }[],
): Promise<string> {
  await grantCodes(db, s, { principalId: s.human, codes: ["accounting.journal.post"] });
  const documentId = await draftDocument(db, s);
  const requestId = await uuidv7(db.admin);
  await prodWithTenant(db.rw, ctx(s, requestId), async (tx) => {
    let lineNo = 0;
    for (const l of lines) {
      lineNo += 1;
      await tx`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, description, account_id, debit, credit)
        values (${s.tenant}, ${s.company}, ${documentId}, ${lineNo}, 'account',
                ${l.description ?? null}, ${l.accountId},
                ${l.debit ?? "0.0000"}, ${l.credit ?? "0.0000"})`;
    }
    await postDocument(tx, ctx(s, requestId), { documentId });
  });
  return documentId;
}

/** `seedTenantV2` already created `1000 Cash` (asset) and `4000 Sales` (income) — §4.1's pinned seed
 *  constants — and §4.15 gives 2C no account to seed, so this reads the ids rather than creating rows. */
async function accountId(db: Db, s: Seed, code: string): Promise<string> {
  const [row] = await db.admin<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = ${code}`;
  return row!.id;
}

describe("resolvePrintTemplate — highest version wins, code defaults to standard", () => {
  let db: Db; let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await seedTemplate(db, a, { version: 1 });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("returns the only version", async () => {
    const requestId = await uuidv7(db.admin);
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      resolvePrintTemplate(tx, { companyId: a.company, documentTypeId: a.docType }));
    expect(row).toMatchObject({ code: "standard", version: 1, engine: "chromium", paper: "A4" });
  });

  it("prefers the highest version of the same code — a new version supersedes (constraint 8)", async () => {
    await seedTemplate(db, a, { version: 2 });
    const requestId = await uuidv7(db.admin);
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      resolvePrintTemplate(tx, { companyId: a.company, documentTypeId: a.docType }));
    expect(row.version).toBe(2);
  });

  it("raises ERR_NOT_FOUND naming the code it looked for", async () => {
    const requestId = await uuidv7(db.admin);
    await expect(prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      resolvePrintTemplate(tx, { companyId: a.company, documentTypeId: a.docType, templateCode: "receipt" })))
      .rejects.toThrow(/no print template 'receipt'/);
  });
});

describe("renderDocumentSource — the impure half of printing", () => {
  let db: Db; let a: Seed; let documentId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await seedTemplate(db, a, {});
    documentId = await postJournalLocal(db, a, [
      { accountId: await accountId(db, a, "1000"), debit: "150.0000", description: "Cash received" },
      { accountId: await accountId(db, a, "4000"), credit: "150.0000", description: "Sales" },
    ]);
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("substitutes the model into the body and reports the row's engine and paper", async () => {
    const requestId = await uuidv7(db.admin);
    const out = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      renderDocumentSource(tx, { documentId, lang: "en" }));

    expect(out.engine).toBe("chromium");
    expect(out.paper).toBe("A4");
    expect(out.templateCode).toBe("standard");
    expect(out.rendered).toContain("Journal Voucher");
    expect(out.rendered).toContain("dir=\"ltr\"");
    expect(out.rendered).toContain("Total: 150.0000");
    // Accounts print as "1000 · Cash", never as a uuid — that is loadPrintContext's whole job.
    expect(out.rendered).toContain("1000 · Cash");
    expect(out.rendered).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("renders the Arabic template text from the same row, with the ar labels and dir=rtl", async () => {
    const requestId = await uuidv7(db.admin);
    const out = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      renderDocumentSource(tx, { documentId, lang: "ar" }));
    expect(out.rendered).toContain("dir=\"rtl\"");
    expect(out.rendered).toContain("الإجمالي: 150.0000");
    expect(out.rendered).toContain("قيد يومية");
    // 0A's `1000 Cash` carries no `name_ar`, so `coalesce(name_ar, name_en)` shows the English name.
    // That is the decided fallback, not an oversight — it is asserted so nobody "fixes" it into a blank.
    expect(out.rendered).toContain("1000 · Cash");
  });

  it("names the file from the series, number and language", async () => {
    const requestId = await uuidv7(db.admin);
    const out = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      renderDocumentSource(tx, { documentId, lang: "en" }));
    expect(out.fileStem).toMatch(/^JV-\d{6}-en$/);
  });

  it("is deterministic — two renders of one document are the same string", async () => {
    const requestId = await uuidv7(db.admin);
    const [one, two] = await prodWithTenant(db.rw, ctx(a, requestId), async (tx) => [
      await renderDocumentSource(tx, { documentId, lang: "en" }),
      await renderDocumentSource(tx, { documentId, lang: "en" }),
    ]);
    expect(one!.rendered).toBe(two!.rendered);
  });

  it("raises PrintError ERR_NOT_FOUND for a document another tenant owns", async () => {
    const b = await seedTenantV2(db, "Beta");
    const requestId = await uuidv7(db.admin);
    await expect(prodWithTenant(db.rw, ctx(b, requestId), (tx) =>
      renderDocumentSource(tx, { documentId, lang: "en" })))
      .rejects.toBeInstanceOf(PrintError);
  });

  it("leaves `notes` empty until migration 0027 (Task 11) adds the column", async () => {
    const requestId = await uuidv7(db.admin);
    const out = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      renderDocumentSource(tx, { documentId, lang: "en" }));
    expect(out.model.document.notes).toBe("");
    expect(out.rendered).not.toContain("class=\"notes\"");
  });
});
```

`postJournalLocal` and `accountId` are **file-local by decision**, not by omission: §4.17 assigns 2C no `fixtures.ts` helper, hazard 9 forbids inventing one, and 1B's `postJournal` is a root-`tests/`-tier helper (`tests/invariants/support/post-journal.ts`) that `packages/db/test` cannot reach across the §3.1 boundary. `grantCodes` is 2B's addition to `fixtures.ts` and is imported, not redefined.

Run: `bun run --cwd packages/db test -- test/print-render.test.ts`
Expected: FAIL — `Cannot find module '../src/print'`.

- [ ] **Step 2: Write `packages/db/src/print/template.ts`**

```ts
import type { Sql } from "postgres";
import type { PrintContext } from "@dulja/domain";

/**
 * Declared HERE, in the leaf, and re-exported from `./index` — so `template.ts` needs no import from
 * `index.ts` and there is no cycle to work around. `packages/db` cannot import `AppError`: 0B's
 * `dependency-rule` lint pins this package to `['@dulja/domain']`, which is contracts §4.2.4's
 * declared `PostingError` exception applied to the same situation. The API translates:
 * `ERR_NOT_FOUND` → 404, `ERR_VALIDATION_FAILED` → 400 with the detail as the message.
 */
export class PrintError extends Error {
  constructor(readonly code: "ERR_NOT_FOUND" | "ERR_VALIDATION_FAILED", readonly detail: string) {
    super(detail);
    this.name = "PrintError";
  }
}

export interface PrintTemplateRow {
  id: string;
  companyId: string;
  documentTypeId: string;
  code: string;
  version: number;
  nameEn: string;
  nameAr: string | null;
  engine: string;
  paper: string;
  source: string;
}

/**
 * The default template code when a print request names none. It matches the seed file
 * `packages/db/seed/my/templates/<TYPE>.standard.v1.json` (Task 7), so a tenant that has only
 * seeded templates never has to send a code.
 */
export const DEFAULT_TEMPLATE_CODE = "standard";

/**
 * The highest `version` of `(document_type_id, code)`. `app.print_template` is never deleted and
 * never archived (Global Constraint 8) — a new version supersedes, so "latest" is `max(version)`.
 */
export async function resolvePrintTemplate(
  tx: Sql,
  params: { companyId: string; documentTypeId: string; templateCode?: string },
): Promise<PrintTemplateRow> {
  const code = params.templateCode ?? DEFAULT_TEMPLATE_CODE;
  const [row] = await tx<PrintTemplateRow[]>`
    select id, company_id as "companyId", document_type_id as "documentTypeId",
           code, version, name_en as "nameEn", name_ar as "nameAr", engine, paper, source
      from app.print_template
     where company_id = ${params.companyId}
       and document_type_id = ${params.documentTypeId}
       and code = ${code}
     order by version desc
     limit 1`;
  if (!row) {
    throw new PrintError("ERR_NOT_FOUND",
      `no print template '${code}' for document type ${params.documentTypeId} in company ${params.companyId}`);
  }
  return row;
}

/**
 * Everything `buildPrintModel` needs that the posting snapshot does not carry: the company's display
 * name, the document type's two names, the party's name and a label per account the document touches.
 * One query per concern, all under the caller's RLS session — a row another tenant owns is simply absent.
 *
 * `app.company` has a single `name` (plan0A), but `app.party` and `app.account` have `name_en` and a
 * NULLABLE `name_ar` (contracts §4.5.7; plan0A:1485–1501) — there is no `name` column on either, and
 * selecting one is a `42703`. So `lang` picks, with English as the explicit fallback when the Arabic name
 * was never entered: an Arabic print of a party that has only `name_en` shows `name_en`, deliberately,
 * rather than an empty cell.
 */
export async function loadPrintContext(
  tx: Sql,
  documentId: string,
  lang: "en" | "ar",
): Promise<Omit<PrintContext, "lang" | "labels">> {
  const ar = lang === "ar";
  const [head] = await tx<{
    companyName: string; typeNameEn: string; typeNameAr: string | null; partyName: string | null;
  }[]>`
    select c.name       as "companyName",
           dt.name_en   as "typeNameEn",
           dt.name_ar   as "typeNameAr",
           case when ${ar} then coalesce(p.name_ar, p.name_en) else p.name_en end as "partyName"
      from app.document d
      join app.company c       on c.id = d.company_id
      join app.document_type dt on dt.id = d.document_type_id
      left join app.party p     on p.id = d.party_id
     where d.id = ${documentId}`;
  if (!head) throw new PrintError("ERR_NOT_FOUND", `document ${documentId} not found`);

  const labelRows = await tx<{ id: string; label: string }[]>`
    select a.id,
           a.code || ' · ' || case when ${ar} then coalesce(a.name_ar, a.name_en) else a.name_en end as label
      from app.document_line l
      join app.account a on a.id = l.account_id
     where l.document_id = ${documentId}`;

  const accountLabels: Record<string, string> = {};
  for (const r of labelRows) accountLabels[r.id] = r.label;

  return {
    companyName: head.companyName,
    documentTypeNameEn: head.typeNameEn,
    documentTypeNameAr: head.typeNameAr,
    partyName: head.partyName,
    // `document.notes` is migration 0027 — Task 11. That task adds `d.notes` to the query above and
    // the assertion that a note prints. Reading it here would fail against a pre-0027 database.
    notes: null,
    accountLabels,
  };
}
```

- [ ] **Step 3: Write `packages/db/src/print/index.ts`**

```ts
import type { Sql } from "postgres";
import {
  buildPrintModel, htmlEscape, parseTemplateSource, renderTemplate, typstEscape,
  TemplateError, TemplateSourceError, type PrintModel,
} from "@dulja/domain";
import { loadSnapshot, PostingError } from "../posting";
import { PrintError, loadPrintContext, resolvePrintTemplate, type PrintTemplateRow } from "./template";

export interface RenderedDocument {
  rendered: string;
  engine: string;
  paper: string;
  templateId: string;
  templateCode: string;
  templateVersion: number;
  fileStem: string;
  model: PrintModel;
}

/** Typst escaping for a Typst body, HTML escaping for everything else. No raw-output form exists. */
function escapeFor(engine: string): (value: string) => string {
  return engine === "typst" ? typstEscape : htmlEscape;
}

/** `JV-000017-en`; an unissued document has no number, so its stem carries the id's last 12 characters. */
function fileStem(row: { series: string; number: string; id: string }, lang: string): string {
  const tail = row.number === "" ? row.id.slice(-12) : row.number.padStart(6, "0");
  return `${row.series === "" ? "DOC" : row.series}-${tail}-${lang}`;
}

/**
 * Loads the document, its context and its template, builds the print model and substitutes it into
 * the template body. Returns **template text**, not a PDF: the engine adapters live in `apps/api`
 * (a browser and a binary are not `packages/db`'s business) and take this string as their input.
 */
export async function renderDocumentSource(
  tx: Sql,
  params: { documentId: string; templateCode?: string; lang: "en" | "ar" },
): Promise<RenderedDocument> {
  // Narrow on purpose: only 1A's own "no such document" becomes a PrintError. A connection failure,
  // an RLS denial or a bug must keep its own identity and reach the API's 500 path, not be reported
  // to the operator as a missing document.
  const snapshot = await loadSnapshot(tx, params.documentId).catch((e: unknown) => {
    if (e instanceof PostingError && e.code === "ERR_NOT_FOUND") {
      throw new PrintError("ERR_NOT_FOUND", `document ${params.documentId} not found`);
    }
    throw e;
  });

  const [typeRow] = await tx<{ documentTypeId: string }[]>`
    select document_type_id as "documentTypeId" from app.document where id = ${params.documentId}`;
  if (!typeRow) throw new PrintError("ERR_NOT_FOUND", `document ${params.documentId} not found`);

  const template: PrintTemplateRow = await resolvePrintTemplate(tx, {
    companyId: snapshot.header.companyId,
    documentTypeId: typeRow.documentTypeId,
    ...(params.templateCode === undefined ? {} : { templateCode: params.templateCode }),
  });

  const context = await loadPrintContext(tx, params.documentId, params.lang);

  let meta: { labels: { en: Record<string, string>; ar: Record<string, string> } };
  let body: string;
  try {
    ({ meta, body } = parseTemplateSource(template.source));
  } catch (e) {
    if (!(e instanceof TemplateSourceError)) throw e;
    throw new PrintError("ERR_VALIDATION_FAILED",
      `print template ${template.code} v${template.version} has an unreadable source: ${e.message}`);
  }

  const model = buildPrintModel(snapshot, { ...context, lang: params.lang, labels: meta.labels });

  let rendered: string;
  try {
    rendered = renderTemplate(body, model, escapeFor(template.engine));
  } catch (e) {
    if (!(e instanceof TemplateError)) throw e;
    throw new PrintError("ERR_VALIDATION_FAILED",
      `print template ${template.code} v${template.version} failed to render: ${e.message}`);
  }

  return {
    rendered,
    engine: template.engine,
    paper: template.paper,
    templateId: template.id,
    templateCode: template.code,
    templateVersion: template.version,
    fileStem: fileStem(
      { series: model.document.series, number: model.document.number, id: params.documentId },
      params.lang,
    ),
    model,
  };
}

export {
  DEFAULT_TEMPLATE_CODE, PrintError, loadPrintContext, resolvePrintTemplate, type PrintTemplateRow,
} from "./template";
```

`PrintError` is declared in `template.ts` — the leaf — and re-exported here, so the import graph runs one way (`index.ts` → `template.ts`) with no cycle and no dynamic import. Add to `packages/db/src/index.ts`:

```ts
export * from "./print";
```

Run: `bun run --cwd packages/db test -- test/print-render.test.ts && bun run --cwd packages/db typecheck`
Expected: PASS — 3 resolver tests and 6 render tests.

- [ ] **Step 4: Add the one new error code**

In `packages/contracts/src/errors.ts`, add the row to `ERRORS`:

```ts
  ERR_PRINT_ENGINE_UNSUPPORTED: {
    status: 422,
    title: "Print engine unsupported",
    remedy: "Choose a print template whose engine renders template text (see ADR 0016 and ADR 0032).",
  },
```

This is the slice's **only** new registry code (Global Constraint 9). The four `code` literals on `ObjectKeyError`, `AttachmentIntegrityError`, `TemplateSourceError` and `TemplateError` (Tasks 2, 3, 6) are **not** registry codes — they are internal discriminants on classes in `packages/db` and `packages/domain`, which cannot import `AppError`, exactly as contracts §4.2.4 declares for `PostingError`. Each is translated at the API boundary and the translations are already written: `AttachmentIntegrityError` → `ERR_INTERNAL` (Task 4), `TemplateSourceError` and `TemplateError` → `ERR_VALIDATION_FAILED` (Task 7 and Step 3 above), and `ObjectKeyError` reaches the global handler's unmapped branch as `ERR_INTERNAL` because both of its arguments are server-minted uuids and a throw is a server bug, never client input.

- [ ] **Step 5: Write the failing engine test**

`apps/api/test/print/engines.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PDF_ENGINES, PDF_MAGIC, engineFor } from "../../src/print/engines";
// `AppError` only — every case here asserts on the thrown class and its `code`/`detail`, never on a
// serialised `Problem`, and an unused type import fails `bun run lint` (oxlint) under Global Constraint 15.
import { AppError } from "@dulja/contracts";

const HTML = [
  "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\"></head>",
  "<body><h1>فاتورة ضريبية</h1><p>Invoice INV-000001 · 150.0000 MYR</p></body></html>",
].join("");

// The Typst fixture referenced by Task 7's engine note: this is the starting point for
// `JOURNAL.standard.v1.typ` if ADR 0016's Decision names `typst` rather than `chromium`.
const TYPST = [
  '#set text(font: ("Noto Sans", "Noto Sans Arabic"), size: 11pt, dir: rtl)',
  '#set page(paper: "a4", margin: 16mm)',
  '= فاتورة ضريبية',
  'Invoice INV-000001 · 150.0000 MYR',
  '#table(columns: 3, [الحساب], [مدين], [دائن], [1000 · Cash], [150.0000], [0.0000])',
].join("\n");

describe("the ADR-0016 engine adapters", () => {
  it("holds an adapter for every ADR-0016 code that can consume template TEXT", () => {
    expect(Object.keys(PDF_ENGINES).sort()).toEqual(["chromium", "typst"]);
  });

  it("refuses react-pdf with ERR_PRINT_ENGINE_UNSUPPORTED, naming why (ADR 0032)", () => {
    let raised: AppError | null = null;
    try { engineFor("react-pdf"); } catch (e) { raised = e as AppError; }
    expect(raised).toBeInstanceOf(AppError);
    expect(raised!.code).toBe("ERR_PRINT_ENGINE_UNSUPPORTED");
    expect(raised!.detail).toMatch(/react-pdf renders a React component, not template text/);
  });

  it("refuses a code ADR 0016 does not name at all", () => {
    expect(() => engineFor("wkhtmltopdf")).toThrow(/wkhtmltopdf/);
  });

  it.each(["chromium", "typst"] as const)("%s renders both directions to real PDF bytes", async (code) => {
    const engine = engineFor(code);
    const source = code === "typst" ? TYPST : HTML;
    for (const dir of ["ltr", "rtl"] as const) {
      const bytes = await engine.render(source, { paper: "A4", dir });
      expect(bytes.byteLength).toBeGreaterThan(1_000);
      expect(bytes.slice(0, PDF_MAGIC.length)).toEqual(PDF_MAGIC);
    }
  }, 120_000);

  it("maps the three paper values without throwing", async () => {
    const engine = engineFor("chromium");
    for (const paper of ["A4", "A5", "receipt"]) {
      expect((await engine.render(HTML, { paper, dir: "ltr" })).byteLength).toBeGreaterThan(500);
    }
  }, 120_000);
});
```

Run: `bun run --cwd apps/api test -- test/print/engines.test.ts`
Expected: FAIL — `Cannot find module '../../src/print/engines'`.

- [ ] **Step 6: Write the two adapters and the registry**

`apps/api/src/print/engines/chromium.ts`:

```ts
import { chromium, type Browser } from "playwright";
import type { PdfEngine } from "./index";

/** `print_template.paper` → Playwright's page vocabulary. `receipt` is 80 mm continuous roll. */
const PAGE: Readonly<Record<string, { format?: "A4" | "A5"; width?: string; height?: string }>> = {
  A4: { format: "A4" },
  A5: { format: "A5" },
  receipt: { width: "80mm", height: "297mm" },
};

/**
 * One browser per process, launched on first use. `page.pdf()` and Electron's
 * `webContents.printToPDF` are the same engine (ADR 0016 criterion 5), so the desktop app prints
 * a single document without a second dependency (D18).
 */
let browser: Browser | null = null;
async function shared(): Promise<Browser> {
  browser ??= await chromium.launch({ args: ["--no-sandbox", "--font-render-hinting=none"] });
  return browser;
}

export async function closeChromium(): Promise<void> {
  await browser?.close();
  browser = null;
}

export const chromiumEngine: PdfEngine = {
  code: "chromium",
  async render(source, opts) {
    const page = await (await shared()).newPage();
    try {
      // `setContent` never navigates, so the renderer fetches nothing: a template that referenced an
      // external URL would silently produce a different PDF per run and break criterion 4.
      await page.setContent(source, { waitUntil: "load" });
      await page.emulateMedia({ media: "print" });
      const size = PAGE[opts.paper] ?? PAGE["A4"]!;
      // `dir` is already on the template's <html> element; passing it again would let a template and a
      // request disagree. The parameter stays in the interface because Typst needs it.
      return new Uint8Array(await page.pdf({ ...size, printBackground: true, preferCSSPageSize: false }));
    } finally {
      await page.close();
    }
  },
};
```

`apps/api/src/print/engines/typst.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppError } from "@dulja/contracts";
import type { PdfEngine } from "./index";

const run = promisify(execFile);

/** `typst` is a binary, not a package — the container image installs it and CI installs it in a step. */
export const TYPST_BIN = process.env["TYPST_BIN"] ?? "typst";

export const typstEngine: PdfEngine = {
  code: "typst",
  async render(source, opts) {
    const dir = await mkdtemp(join(tmpdir(), "dulja-print-"));
    const input = join(dir, "doc.typ");
    const output = join(dir, "doc.pdf");
    try {
      // The direction and paper reach the document as Typst inputs, so one body serves both
      // directions exactly as the HTML body does (spec:2253).
      await writeFile(input, source, "utf8");
      await run(TYPST_BIN, [
        "compile",
        "--input", `dir=${opts.dir}`,
        "--input", `paper=${opts.paper.toLowerCase()}`,
        input, output,
      ], { timeout: 60_000 });
      return new Uint8Array(await readFile(output));
    } catch (e) {
      throw new AppError("ERR_INTERNAL",
        `typst failed to compile the template: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
```

`apps/api/src/print/engines/index.ts`:

```ts
import { AppError } from "@dulja/contracts";
import { chromiumEngine } from "./chromium";
import { typstEngine } from "./typst";

/** ADR 0016's Verdict-table `Code` column — the same closed set as `print_template.engine`'s CHECK. */
export type PrintEngineCode = "typst" | "chromium" | "react-pdf";

export interface PdfEngine {
  readonly code: PrintEngineCode;
  render(source: string, opts: { paper: string; dir: "ltr" | "rtl" }): Promise<Uint8Array>;
}

/**
 * One entry per ADR-0016 code that can consume template TEXT. `react-pdf` is deliberately absent and
 * that absence is ADR 0032's decision, not an omission: it renders a React component, so there is no
 * `print_template.source` string it could accept. The code stays in migration 0026's CHECK because
 * ADR 0016's vocabulary is frozen (hazard 30) and it is what `ERR_PRINT_ENGINE_UNSUPPORTED` is for.
 */
export const PDF_ENGINES: Readonly<Partial<Record<PrintEngineCode, PdfEngine>>> = {
  chromium: chromiumEngine,
  typst: typstEngine,
};

export const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);   // "%PDF-"

export function engineFor(code: string): PdfEngine {
  const engine = PDF_ENGINES[code as PrintEngineCode];
  if (engine) return engine;
  const detail = code === "react-pdf"
    ? "react-pdf renders a React component, not template text; a text-defined print template cannot use it (ADR 0032)"
    : `'${code}' is not an ADR-0016 engine code; ADR 0016 names ${Object.keys(PDF_ENGINES).join(", ")}, react-pdf`;
  throw new AppError("ERR_PRINT_ENGINE_UNSUPPORTED", detail);
}

export { closeChromium } from "./chromium";
export { TYPST_BIN } from "./typst";
```

Add `playwright` to `apps/api`'s dependencies with **no version in any source file** (Global Constraint 1 — the lockfile owns versions):

```bash
bun add --cwd apps/api playwright
bunx playwright install --with-deps chromium
```

`typst` is a binary; the CI job that runs `apps/api`'s tests installs it the way 0E's spike job does, and `TYPST_BIN` overrides the path.

Run: `bun run --cwd apps/api test -- test/print/engines.test.ts`
Expected: PASS — 6 cases in all: 3 registry tests, 2 engine render cases (the `it.each` runs once per engine and asserts both directions inside), and 1 paper case covering `A4`, `A5` and `receipt`.

- [ ] **Step 7: Write ADR 0032**

`docs/adr/0032-print-template-format-and-engine.md`:

```markdown
# 0032 — Print-template source format and the engine value set

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 2C
**Spec:** §3.5 report designer — "text-defined, diffable, version-controlled" (spec:1240); §4.10 RTL/LTR
parity (spec:2253); §3.2.2 PDF row (spec:1132). **Consumes:** ADR 0016 (PDF engine, 0E) — **never
re-opened** (contracts hazard 30). **Consumed by:** 7A (`renderReport` adapters), 8D (payslips).

## Context
`app.print_template` (contracts §4.5.9) has one `source` column and one `engine` column. A bilingual
template needs its label pairs to travel with its body, and a template must be diffable in git and
reviewable in a pull request. Nothing in the spec fixes either the source format or how a template
reaches the engine ADR 0016 chose.

## Decision
**1. `source` is front matter plus body.** The first line is the sentinel `---dulja-template-v1`, then
one JSON object (`{ "labels": { "en": {…}, "ar": {…} } }`), then a line of three dashes, then the body
byte-exact to the end. The parser splits on the first three-dash line only, so a body containing `---`
survives. Labels are **data, not i18next keys**: `packages/domain` may import nothing internal
(contracts §3.1), and a template is tenant data that ships without a release.

**2. Templates are rendered by a deterministic mustache subset** — `{{ path }}`,
`{{#if path}}…{{else}}…{{/if}}`, `{{#each path}}…{{/each}}` — with **no raw-output form**. Every
substituted value is escaped for the engine (HTML or Typst). A template therefore cannot emit
unescaped model data, and a tenant-authored template is not an injection vector.

**3. One body serves both directions.** `dir` and `rtl` are model members and the body uses logical
CSS properties (`text-align: start`, `margin-block-end`); no template is duplicated per language
(spec:2253). Labels come from the front matter's `en`/`ar` pair, chosen by the request's `lang`.

**4. The `engine` value set is ADR 0016's Verdict table and nothing else** — `typst`, `chromium`,
`react-pdf` — and migration 0026's CHECK holds all three.

**5. `react-pdf` has no adapter, by decision.** It renders a React component, so there is no template
*text* it can consume, and a component is not "text-defined, diffable, version-controlled" in the sense
of spec:1240. `PDF_ENGINES` holds `chromium` and `typst`; `engineFor("react-pdf")` throws
`ERR_PRINT_ENGINE_UNSUPPORTED` (422). The code is **not** removed from the CHECK: ADR 0016 owns that
vocabulary and this ADR does not narrow it. If ADR 0016's Decision row names `react-pdf` as the chosen
engine, 2C stops and raises it to the owner — that is ADR 0016's own "no candidate passes" branch, and
templates cannot ship without a text-driven engine.

**6. Rendering a single document is synchronous** (contracts §4.5.9): `POST …/documents/{id}/print`
returns `200 application/pdf`. No job name is allocated, so `JOBS` stays closed and 2C needs no worker.
Batch and catalogue rendering is 7A's `reporting.render` job.

## Consequences
- A template is reviewed as a diff. Two identical rows arrive from the seed pack and from the API
  because both compose the same `source` through `composeTemplateSource`.
- Determinism is asserted on the **rendered template text**, not on PDF bytes: Chromium embeds a
  creation timestamp. Tests 26 and 29 pin their fixtures at the text layer for the same reason.
- A new label is a new template version, never an edit — `print_template` is never updated in place.
- `engine` is read from the row on every print, so switching engines is data, not code.
```

- [ ] **Step 8: Run everything**

Run: `bun run --cwd packages/db test -- test/print-render.test.ts && bun run --cwd apps/api test -- test/print/engines.test.ts && bun run lint:rules && bun run typecheck`
Expected: PASS — and `lint:rules` confirms `packages/db/src/print/**` imports only `@dulja/domain` and `postgres`, while `playwright` and `node:child_process` appear only under `apps/api/src/print/engines/**`.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/print packages/db/src/index.ts packages/db/test/print-render.test.ts \
        packages/contracts/src/errors.ts apps/api/src/print apps/api/test/print \
        apps/api/package.json docs/adr/0032-print-template-format-and-engine.md
git commit -m "feat(db,api): load and render a document template; the ADR-0016 engine adapters [2C T8]

The seam between packages/db and apps/api is a STRING: renderDocumentSource returns template
text, engineFor returns the adapter that makes it a PDF. react-pdf keeps its place in the 0026
CHECK (ADR 0016 owns that vocabulary) and has no adapter, which is what the one new error code
ERR_PRINT_ENGINE_UNSUPPORTED exists to say. notes stays null until 0027 (T11).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `POST …/documents/{documentId}/print` — a PDF in both directions (test 23 for PDFs)

Contracts §4.5.9 freezes the endpoint: `POST /v1/companies/{companyId}/documents/{documentId}/print { templateCode?, lang: "en" | "ar" }` → **synchronous** `200 application/pdf`. Three problems have to be solved to ship it, and each has exactly one right answer.

**The gate is the type's module read code, not a stage.** `requireDocumentPermission(stage)` (2B) maps the six *write* stages. Printing is a read, and §4.5.4 already states the rule for the one other document read it defines — `GET …/documents/{documentId}/events` is "membership + the type's module read code". Printing uses the same rule and the same map: `MODULE_READ_CODE` from Task 4. The map therefore gets one more consumer and stays in one file, which is the point of building it one module at a time.

**Idempotency cannot store a PDF.** 0B's middleware records `response_body` as `jsonb` by `JSON.parse`-ing the response text; a PDF parses as nothing, so a naive replay would return `null` with the wrong content type. But printing **writes nothing** — it is naturally idempotent — so a replay may simply re-execute. This task adds `REPLAY_BY_RERUN`: the reservation, the request-hash check and the in-flight refusal are all unchanged (a concurrent duplicate still gets `ERR_IDEMPOTENCY_IN_FLIGHT`), the recorded row holds a **descriptor** of the binary response instead of its bytes, and a later replay re-runs the handler. Printing is the only member at 2C; a route that writes may never join it.

**Determinism is asserted on text, not on bytes.** Chromium embeds `CreationDate`/`ModDate` in every PDF, so two renders of one document differ byte for byte. ADR 0032 already records that determinism is pinned at the rendered-template-text layer; the PDF assertions here are structural — real PDF bytes, extractable text, the Arabic labels present, the column order reversed — which is exactly what test 23 asks of a generated PDF (spec:2253).

**Files:**
- Create: `packages/contracts/src/accounting/print.ts`, `apps/api/test/routes/accounting/print.test.ts`, `tests/support/pdf.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/routes/accounting/documents.ts`, `apps/api/src/middleware/require-attachment-read.ts`, `apps/api/src/middleware/idempotency.ts`, `apps/api/package.json`, `tests/package.json`, `tests/regression/legacy-085.test.ts`

**Interfaces:**
- Consumes: `renderDocumentSource`, `RenderedDocument`, `PrintError` (Task 8); `engineFor`, `PdfEngine`, `PDF_MAGIC` (Task 8); `MODULE_READ_CODE`, `DocumentTypeModule` (Task 4); `documentRoutes` at `/v1/companies/:companyId/documents` (1A, §4.2.7); `AppError`, `ERRORS`, `Problem` (§4.2.4); `PERMISSION`, `PermissionCode` (§4.2.5); `IdempotencyHeader`, `RECLAIM_AFTER_SECONDS` (§4.2.9); `UuidSchema`, `ProblemSchema` (§4.2.8); `startApi`, `StartedApi`, `problemOf`, `grantAdmin` (§4.2.12, §4.17.1); `seedTenantV2`, `grantCodes` (§4.17); `postJournal` (§4.17.1).
- Produces:

```ts
// packages/contracts/src/accounting/print.ts
export const PrintLangSchema = z.enum(["en", "ar"]);
export const PrintDocumentBody = z.object({
  templateCode: z.string().min(1).max(64).optional(),
  lang: PrintLangSchema,
});
export type PrintLang = z.infer<typeof PrintLangSchema>;

// apps/api/src/middleware/require-attachment-read.ts (the same file — one map, one home)
/** Membership plus the read code of the module of the document's type (§4.5.4's rule for document
 *  reads). Loads the document named by `:documentId` and stores its module under `documentModule`. */
export function requireDocumentModuleRead(): MiddlewareHandler<AppEnv>;

// apps/api/src/middleware/idempotency.ts
/** Unsafe methods whose handler writes nothing, so a replay MAY re-execute rather than return a
 *  stored body. Matched on the CONCRETE request path, because this middleware is registered with
 *  `app.use` in `createApp` and `c.req.routePath` there is the middleware's own pattern, not the
 *  terminal handler's. Printing is the only member: a route that writes may never join it. */
export const REPLAY_BY_RERUN: readonly { method: string; path: RegExp }[];
export function isReplayByRerun(c: Context<AppEnv>): boolean;
```

and one more member on `AppEnv["Variables"]`:

```ts
    documentModule: DocumentTypeModule;      // set by requireDocumentModuleRead
```

- [ ] **Step 1: Write the shared PDF reader, then the failing route tests**

The reader is written **once, in the `tests` workspace**, and imported from both places that read a PDF — this file and `tests/regression/legacy-085.test.ts` (Step 6). §4.17.1 registers it as `pdfText` in `tests/support/pdf.ts` and calls it "the ONE test-side PDF reader", so it is never defined inline anywhere.

`tests/support/pdf.ts`:

```ts
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** The one test-side PDF reader (§4.17.1): every text item of page 1, in reading order, trimmed and
 *  with empties dropped. `useSystemFonts` lets the Arabic faces resolve so the text layer is real text
 *  rather than glyph ids — which is what test 23 and LEGACY-085 assert on. */
export async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const doc = await getDocument({ data: bytes, useSystemFonts: true }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  return content.items
    .map((i) => ("str" in i ? i.str : ""))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
```

`apps/api/test/routes/accounting/print.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDF_MAGIC } from "../../../src/print/engines";
import { composeTemplateSource } from "@dulja/domain";
import { startApi, type StartedApi } from "../../support/app";
// `grantAdmin` and `problemOf` live in `tests/support/api.ts` (0B, §4.17.1) — five levels up from
// `apps/api/test/routes/accounting/`, the same path 2A's own route test uses. There is no
// `apps/api/test/support/api.ts`.
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { pdfText } from "../../../../../tests/support/pdf";
import { grantCodes, seedTenantV2, type Seed } from "@dulja/db/test";

const LABELS = {
  en: { total: "Total", account: "Account", debit: "Debit", credit: "Credit" },
  ar: { total: "الإجمالي", account: "الحساب", debit: "مدين", credit: "دائن" },
};
const BODY = [
  "<!doctype html><html lang=\"{{ lang }}\" dir=\"{{ dir }}\"><head><meta charset=\"utf-8\"></head><body>",
  "<h1>{{ document.typeName }}</h1>",
  "<table><thead><tr><th>{{ labels.account }}</th><th>{{ labels.debit }}</th><th>{{ labels.credit }}</th></tr></thead>",
  "<tbody>{{#each lines}}<tr><td>{{ account }}</td><td>{{ debit }}</td><td>{{ credit }}</td></tr>{{/each}}</tbody></table>",
  "<p>{{ labels.total }}: {{ totals.debit }}</p>",
  "</body></html>",
].join("");

describe("POST …/documents/{documentId}/print — §4.5.9, test 23 for PDFs", () => {
  let api: StartedApi; let a: Seed; let documentId: string;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    // `grantAdmin(api: StartedApi, s: Seed)` — it takes the app, not the pool (0B:5649).
    await grantAdmin(api, a);
    // `1000 Cash` (asset) and `4000 Sales` (income) already exist — they are `seedTenant`'s pinned
    // constants (§4.1) — and §4.15 gives 2C no account to seed. The two lookups below read their ids.
    // Through the API, because this is an API test: 1A's CreateDocumentBody carries `lines` (min 1),
    // so a document is created with its lines in one call and `PUT …/lines` is only for replacement.
    const [cash] = await api.db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${a.company} and code = '1000'`;
    const [sales] = await api.db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${a.company} and code = '4000'`;
    const created = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents`, as: a.human,
      body: {
        documentTypeCode: "JOURNAL", effectiveDate: "2026-03-01", currency: "MYR", branchId: a.hq,
        lines: [
          { lineNo: 1, accountId: cash!.id, debit: "150.0000", description: "Cash received" },
          { lineNo: 2, accountId: sales!.id, credit: "150.0000", description: "Sales" },
        ],
      },
    });
    documentId = (await created.json() as { id: string }).id;
    await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${documentId}/transitions`,
      as: a.human, body: { to: "posted" },
    });
    await api.request({
      method: "POST", path: `/v1/companies/${a.company}/print-templates`, as: a.human,
      body: {
        documentTypeCode: "JOURNAL", code: "standard", version: 1,
        nameEn: "Journal Voucher", nameAr: "قيد يومية",
        engine: "chromium", paper: "A4", labels: LABELS, body: BODY,
      },
    });
  }, 240_000);
  afterAll(async () => { await api.stop(); });

  const print = (body: unknown, as = a.human) => api.request({
    method: "POST", path: `/v1/companies/${a.company}/documents/${documentId}/print`, as, body,
  });

  it("returns a real PDF with a Content-Disposition naming the series and language", async () => {
    const res = await print({ lang: "en" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="JV-\d{6}-en\.pdf"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.slice(0, PDF_MAGIC.length)).toEqual(PDF_MAGIC);
    expect(bytes.byteLength).toBeGreaterThan(1_000);
  }, 120_000);

  it("carries a real text layer — the amount round-trips out of the PDF (ADR 0016 criterion 3)", async () => {
    const items = await pdfText(new Uint8Array(await (await print({ lang: "en" })).arrayBuffer()));
    expect(items).toContain("150.0000");
    expect(items).toContain("1000 · Cash");
    expect(items.join(" ")).toContain("Journal Voucher");
  }, 120_000);

  it("renders the SAME document in Arabic from the SAME template row (spec:2253)", async () => {
    const items = await pdfText(new Uint8Array(await (await print({ lang: "ar" })).arrayBuffer()));
    const joined = items.join(" ");
    expect(joined).toContain("قيد يومية");
    expect(joined).toContain("الإجمالي");
    expect(joined).toContain("مدين");
    // The Latin amount is unchanged inside an RTL run — the bidi criterion, not a hope.
    expect(items).toContain("150.0000");
    // And no English label leaked into the Arabic render.
    expect(joined).not.toContain("Debit");
  }, 120_000);

  it("puts the columns in the opposite visual order in the two directions", async () => {
    const doc = await getDocument({
      data: new Uint8Array(await (await print({ lang: "ar" })).arrayBuffer()), useSystemFonts: true,
    }).promise;
    const content = await (await doc.getPage(1)).getTextContent();
    const xOf = (needle: string) => {
      const item = content.items.find((i) => "str" in i && i.str.trim() === needle);
      return item && "transform" in item ? (item.transform as number[])[4]! : NaN;
    };
    // In RTL the first header sits to the RIGHT of the last one; `text-align: start` did the work.
    expect(xOf("الحساب")).toBeGreaterThan(xOf("دائن"));
  }, 120_000);

  it("defaults templateCode to 'standard' and refuses an unknown one with 404", async () => {
    expect((await print({ lang: "en" })).status).toBe(200);
    const res = await print({ lang: "en", templateCode: "receipt" });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  }, 120_000);

  it("refuses a lang outside the pair with ERR_VALIDATION_FAILED", async () => {
    const res = await print({ lang: "fr" });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("refuses a principal who can post but cannot READ the module (§4.5.4's rule)", async () => {
    // A second tenant whose principal holds exactly the three codes needed to reach this point —
    // create and post a journal, manage the company's templates — and NOT accounting.ledger.read.
    // That isolates the gate: the 403 can only come from the module read code.
    const b = await seedTenantV2(api.db, "Beta");
    await grantCodes(api.db, b, {
      principalId: b.human,
      codes: ["accounting.journal.create", "accounting.journal.post", "admin.company.manage"],
    });
    // Beta's own `1000`/`4000` come from `seedTenantV2` above (§4.1); 2C seeds no account (§4.15).
    const [cash] = await api.db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${b.company} and code = '1000'`;
    const [sales] = await api.db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${b.company} and code = '4000'`;

    const created = await api.request({
      method: "POST", path: `/v1/companies/${b.company}/documents`, as: b.human,
      body: {
        documentTypeCode: "JOURNAL", effectiveDate: "2026-03-01", currency: "MYR", branchId: b.hq,
        lines: [
          { lineNo: 1, accountId: cash!.id, debit: "5.0000" },
          { lineNo: 2, accountId: sales!.id, credit: "5.0000" },
        ],
      },
    });
    expect(created.status).toBe(201);
    const other = (await created.json() as { id: string }).id;
    await api.request({
      method: "POST", path: `/v1/companies/${b.company}/documents/${other}/transitions`,
      as: b.human, body: { to: "posted" },
    });
    await api.request({
      method: "POST", path: `/v1/companies/${b.company}/print-templates`, as: b.human,
      body: {
        documentTypeCode: "JOURNAL", code: "standard", version: 1, nameEn: "JV",
        engine: "chromium", paper: "A4", labels: LABELS, body: BODY,
      },
    });

    const res = await api.request({
      method: "POST", path: `/v1/companies/${b.company}/documents/${other}/print`,
      as: b.human, body: { lang: "en" },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  }, 180_000);

  it("replays by re-running: the same key returns a PDF, not a null body", async () => {
    const key = crypto.randomUUID();
    const first = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${documentId}/print`,
      as: a.human, body: { lang: "en" }, idempotencyKey: key,
    });
    const second = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${documentId}/print`,
      as: a.human, body: { lang: "en" }, idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await second.arrayBuffer());
    expect(bytes.slice(0, PDF_MAGIC.length)).toEqual(PDF_MAGIC);
  }, 120_000);

  it("still refuses the same key with a DIFFERENT body — the reservation is unchanged", async () => {
    const key = crypto.randomUUID();
    await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${documentId}/print`,
      as: a.human, body: { lang: "en" }, idempotencyKey: key,
    });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${documentId}/print`,
      as: a.human, body: { lang: "ar" }, idempotencyKey: key,
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_REUSED");
  }, 120_000);

  it("records a descriptor, never the bytes, in app.idempotency_key", async () => {
    const key = crypto.randomUUID();
    await api.request({
      method: "POST", path: `/v1/companies/${a.company}/documents/${documentId}/print`,
      as: a.human, body: { lang: "en" }, idempotencyKey: key,
    });
    const [row] = await api.db.admin<{ response_body: { contentType: string; byteSize: number; sha256: string } }[]>`
      select response_body from app.idempotency_key where key = ${key}`;
    expect(row!.response_body.contentType).toBe("application/pdf");
    expect(row!.response_body.byteSize).toBeGreaterThan(1_000);
    expect(row!.response_body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row!.response_body).length).toBeLessThan(400);
  }, 120_000);

  it("refuses a template whose engine has no adapter with ERR_PRINT_ENGINE_UNSUPPORTED", async () => {
    // The engine is per row, so this needs a row `chromium` does not own. Written directly, because
    // the configuration API validates against the same PDF_ENGINES set the route reads.
    await api.db.admin`
      insert into app.print_template
        (tenant_id, company_id, document_type_id, code, version, name_en, engine, source, paper)
      values (${a.tenant}, ${a.company}, ${a.docType}, 'reactish', 1, 'R', 'react-pdf',
              ${composeTemplateSource({ labels: LABELS }, BODY)}, 'A4')`;
    const res = await print({ lang: "en", templateCode: "reactish" });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_PRINT_ENGINE_UNSUPPORTED");
  }, 120_000);
});
```

Add `pdfjs-dist` as a dev dependency of **both** workspaces that resolve it — a **test-side** reader, never shipped. `tests` is where `tests/support/pdf.ts` lives and so is where the specifier is resolved from; `apps/api` needs it too because its Vitest run type-checks and executes a file that imports across the boundary, and a workspace that resolves a package it does not declare is a phantom dependency:

```bash
bun add --cwd tests --dev pdfjs-dist
bun add --cwd apps/api --dev pdfjs-dist
```

Run: `bun run --cwd apps/api test -- test/routes/accounting/print.test.ts`
Expected: FAIL — `404` on every request; the route does not exist.

- [ ] **Step 2: Write the contracts module**

`packages/contracts/src/accounting/print.ts`:

```ts
import { z } from "@hono/zod-openapi";

/** Both directions are first-class; there is no default (spec:2253 — parity, not a fallback). */
export const PrintLangSchema = z.enum(["en", "ar"]).openapi({ example: "ar" });

export const PrintDocumentBody = z.object({
  /** Omitted means `standard` — `DEFAULT_TEMPLATE_CODE` in `@dulja/db` (Task 8). */
  templateCode: z.string().min(1).max(64).optional(),
  lang: PrintLangSchema,
}).openapi("PrintDocumentBody");

export type PrintLang = z.infer<typeof PrintLangSchema>;
```

and in `packages/contracts/src/index.ts`:

```ts
export { PrintDocumentBody, PrintLangSchema, type PrintLang } from "./accounting/print";
```

- [ ] **Step 3: Add `requireDocumentModuleRead()` beside the map**

In `apps/api/src/middleware/require-attachment-read.ts` — the same file, because `MODULE_READ_CODE` must have exactly one home and the next slice to widen it (3A) should find both consumers together:

```ts
/**
 * Membership plus the read code of the module of the document's type — contracts §4.5.4's stated rule
 * for a document read ("membership + the type's module read code"), applied to printing exactly as it
 * is to `GET …/events`. The map is §4.5.8's and is built one module at a time: at 2C only `accounting`
 * has a row, and every other module value is denied (`ERR_RBAC_FORBIDDEN`) rather than defaulted.
 */
export function requireDocumentModuleRead(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const documentId = c.req.param("documentId");
    if (!documentId) throw new AppError("ERR_NOT_FOUND", "documentId is required");

    const found = await c.var.withTenant(async (tx) => {
      const [row] = await tx<{ module: DocumentTypeModule; companyId: string; branchId: string }[]>`
        select dt.module, d.company_id as "companyId", d.branch_id as "branchId"
          from app.document d
          join app.document_type dt on dt.id = d.document_type_id
         where d.id = ${documentId}`;
      if (!row) return null;
      const code = MODULE_READ_CODE[row.module];
      if (!code) return { row, allowed: false as const };
      const [ok] = await tx<{ allowed: boolean }[]>`
        select app.actor_has(${code}, ${row.companyId}, ${row.branchId}) as allowed`;
      return { row, allowed: ok?.allowed === true };
    });

    // A document another tenant owns is invisible under RLS and answers 404 — never a 403, which
    // would confirm that it exists (§4.2.4's ERR_NOT_FOUND note).
    if (!found) throw new AppError("ERR_NOT_FOUND", `document ${documentId} not found`);
    if (!found.allowed) {
      throw new AppError("ERR_RBAC_FORBIDDEN",
        `printing a '${found.row.module}' document needs that module's read permission`);
    }
    c.set("documentModule", found.row.module);
    await next();
  };
}
```

Add `documentModule: DocumentTypeModule;` to `AppEnv["Variables"]` beside Task 4's `attachment` member.

- [ ] **Step 4: Teach the idempotency middleware about binary responses**

In `apps/api/src/middleware/idempotency.ts`, add the set and replace the store block:

```ts
/**
 * Unsafe methods whose handler writes nothing, so a replay may RE-EXECUTE rather than return a stored
 * body. Printing is the only member: `POST …/print` reads a document and a template and writes no row,
 * so re-running it is exactly as idempotent as returning a cached answer — and a PDF has no place in a
 * `jsonb` column. **A route that writes may never join this list.**
 *
 * Matched against the CONCRETE path, not a route pattern. This middleware is registered with
 * `app.use` in `createApp` (0B Task 3 Step 4), so `c.req.routePath` here is *this middleware's*
 * registered pattern — not the terminal handler's — and a pattern comparison would never match.
 */
export const REPLAY_BY_RERUN: readonly { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/v1\/companies\/[^/]+\/documents\/[^/]+\/print$/ },
];

export function isReplayByRerun(c: Context<AppEnv>): boolean {
  const path = new URL(c.req.url).pathname;
  return REPLAY_BY_RERUN.some((r) => r.method === c.req.method && r.path.test(path));
}
```

In the replay branch, before returning the stored body:

```ts
      if (existing.response_code !== null) {
        // A naturally idempotent unsafe method re-runs: the stored row is a descriptor, not a body.
        if (isReplayByRerun(c)) return { kind: "rerun" };
        return { kind: "replay", status: existing.response_code, body: existing.response_body };
      }
```

Add one case to 0B's own suite, `apps/api/test/middleware/idempotency.test.ts`, so the matcher cannot silently stop matching:

```ts
  it("matches the print path and nothing adjacent to it", () => {
    const at = (method: string, path: string) =>
      isReplayByRerun({ req: { method, url: `https://api.test${path}` } } as never);
    expect(at("POST", "/v1/companies/c1/documents/d1/print")).toBe(true);
    expect(at("POST", "/v1/companies/c1/documents/d1/transitions")).toBe(false);
    expect(at("POST", "/v1/companies/c1/documents/d1/print/extra")).toBe(false);
    expect(at("GET", "/v1/companies/c1/documents/d1/print")).toBe(false);
  });
```

and where the middleware acts on the reservation result, treat `rerun` exactly as a fresh reservation — fall through to `next()`. Then replace the recording block so a non-JSON response stores a descriptor:

```ts
    const contentType = res.headers.get("content-type") ?? "";
    let stored: unknown = null;
    if (contentType.includes("json") || contentType === "") {
      const text = await res.clone().text();
      try { stored = text.length > 0 ? JSON.parse(text) : null; } catch { stored = null; }
    } else {
      // A binary response is recorded as what an auditor needs and nothing more: what it was, how
      // big, and its digest. The bytes never enter the database.
      const bytes = Buffer.from(await res.clone().arrayBuffer());
      stored = {
        contentType: contentType.split(";")[0]!.trim(),
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
```

- [ ] **Step 5: Add the route to `documentRoutes`**

In `apps/api/src/routes/accounting/documents.ts`:

```ts
import { PrintDocumentBody } from "@dulja/contracts";
import { renderDocumentSource, PrintError } from "@dulja/db";
import { engineFor } from "../../print/engines";
import { requireDocumentModuleRead } from "../../middleware/require-attachment-read";

documentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentId}/print",
    tags: ["accounting"],
    summary: "Render a document as a PDF through its print template",
    description:
      "Synchronous single-document render (contracts §4.5.9). Batch and catalogue rendering is the " +
      "reporting.render job (Phase 7). The gate is the read code of the module of the document's type.",
    middleware: [requireDocumentModuleRead()],
    request: {
      params: z.object({ companyId: z.string().uuid(), documentId: z.string().uuid() }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: PrintDocumentBody } }, required: true },
    },
    responses: {
      200: {
        description: "The rendered document",
        content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
      },
      400: { description: "Invalid", content: { "application/problem+json": { schema: ProblemSchema } } },
      403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
      404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
      422: { description: "Unsupported engine", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const documentId = c.req.param("documentId")!;
    const input = c.req.valid("json");

    // Everything that touches the database happens inside one withTenant; the engine runs outside it,
    // because a browser render must never hold a transaction open (§4.2.2's one-retry contract).
    let source;
    try {
      source = await c.var.withTenant((tx) => renderDocumentSource(tx, {
        documentId,
        lang: input.lang,
        ...(input.templateCode === undefined ? {} : { templateCode: input.templateCode }),
      }));
    } catch (e) {
      if (e instanceof PrintError) throw new AppError(e.code, e.detail);
      throw e;
    }

    const pdf = await engineFor(source.engine)
      .render(source.rendered, { paper: source.paper, dir: source.model.dir });

    // `c.body` with a declared `application/pdf` response: `@hono/zod-openapi` types the handler's
    // return against the schema map, and a binary body does not narrow to it, so the assertion is
    // required and is the one in this file.
    return c.body(pdf as unknown as ArrayBufferLike, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${source.fileStem}.pdf"`,
      "Content-Length": String(pdf.byteLength),
      // The same document printed twice may differ (Chromium embeds a timestamp — ADR 0032), so no
      // cache validator is offered. Determinism is asserted on the template text, not the bytes.
      "Cache-Control": "no-store",
    });
  },
);
```

The module's `permissions` array stays `DOCUMENT_STAGE_CODES` (2B) — the print gate is resolved per request from the type's module, so it is not a static route gate, exactly as the transitions route's policy-resolved codes are not. **`assertRouteGates` needs no change**: the route is a POST, and `accounting.ledger.read` is a reading code, so listing it statically would raise `ERR_ROUTE_GATE_READONLY` at boot — this is precisely why the check is in a middleware.

**No new `PROBES` entry.** `PROBES` is keyed by `RouteModule.path` (§4.2.7) and this route is a sub-path of `/v1/companies/:companyId/documents`, which 1A already probes. Hazard 31 is satisfied by the existing entry.

Run: `bun run --cwd apps/api test -- test/routes/accounting/print.test.ts && bun run --cwd packages/contracts openapi:generate`
Expected: PASS — 11 tests, and `packages/contracts/openapi.json` gains the operation with an `application/pdf` response.

- [ ] **Step 6: Append the `— 2C` block to the LEGACY-085 regression file**

`tests/regression/legacy-085.test.ts` was created by 0E (screens). Append below the existing blocks, editing nothing above:

§4.17.1 fixes the shape: `fullRegression(legacyDefect, heading, cases)` is **declarative** — it takes a record of named cases, each receiving a `FullContext` of `{ api, a, b, expect }` from `sharedApi()`. It is not a per-test seeder, so the block below is written to that signature and not to a guess:

```ts
fullRegression("legacy-085", "Arabic renders correctly in every output, PDFs included — 2C", {
  "one template row renders both directions with the right labels and no leakage": async ({ api, a, expect }) => {
    await grantCodes(api.db, a, {
      principalId: a.human,
      codes: ["accounting.journal.create", "accounting.journal.post", "accounting.ledger.read", "admin.company.manage"],
    });
    const documentId = await postedJournalThroughApi(api, a, "42.0000");
    await seedStandardTemplate(api, a);

    const seen: Record<string, string> = {};
    for (const lang of ["en", "ar"] as const) {
      const res = await api.request({
        method: "POST", path: `/v1/companies/${a.company}/documents/${documentId}/print`,
        as: a.human, body: { lang },
      });
      expect(res.status).toBe(200);
      seen[lang] = (await pdfText(new Uint8Array(await res.arrayBuffer()))).join(" ");
    }

    // The Arabic render carries Arabic labels and no English ones; the English render, the reverse.
    expect(seen["ar"]).toContain("مدين");
    expect(seen["ar"]).not.toContain("Debit");
    expect(seen["en"]).toContain("Debit");
    expect(seen["en"]).not.toContain("مدين");
    // The amount is identical in both — Latin digits inside an RTL run are not reordered (LEGACY-085).
    expect(seen["ar"]).toContain("42.0000");
    expect(seen["en"]).toContain("42.0000");
  },
});
```

Two helpers this file needs, both **file-local** in `tests/regression/legacy-085.test.ts` (§4.17.1 assigns 2C no shared helper beyond `pdfText`):

```ts
/** Creates and posts a JOURNAL through the API. 1A's CreateDocumentBody carries `lines`, so one call. */
async function postedJournalThroughApi(api: StartedApi, s: Seed, amount: string): Promise<string> {
  const id = async (code: string) => {
    const [row] = await api.db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = ${code}`;
    return row!.id;
  };
  const created = await api.request({
    method: "POST", path: `/v1/companies/${s.company}/documents`, as: s.human,
    body: {
      documentTypeCode: "JOURNAL", effectiveDate: "2026-03-01", currency: "MYR", branchId: s.hq,
      lines: [
        { lineNo: 1, accountId: await id("1000"), debit: amount },
        { lineNo: 2, accountId: await id("4000"), credit: amount },
      ],
    },
  });
  const documentId = (created.status === 201 ? (await created.json() as { id: string }).id : "");
  await api.request({
    method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/transitions`,
    as: s.human, body: { to: "posted" },
  });
  return documentId;
}

/** The bilingual JOURNAL template, through the configuration API of Task 7. */
async function seedStandardTemplate(api: StartedApi, s: Seed): Promise<void> {
  await api.request({
    method: "POST", path: `/v1/companies/${s.company}/print-templates`, as: s.human,
    body: {
      documentTypeCode: "JOURNAL", code: "standard", version: 1, nameEn: "Journal Voucher",
      nameAr: "قيد يومية", engine: "chromium", paper: "A4",
      labels: {
        en: { total: "Total", account: "Account", debit: "Debit", credit: "Credit" },
        ar: { total: "الإجمالي", account: "الحساب", debit: "مدين", credit: "دائن" },
      },
      body: "<!doctype html><html lang=\"{{ lang }}\" dir=\"{{ dir }}\"><head><meta charset=\"utf-8\">"
          + "</head><body><h1>{{ document.typeName }}</h1><table><tr><th>{{ labels.account }}</th>"
          + "<th>{{ labels.debit }}</th><th>{{ labels.credit }}</th></tr>"
          + "{{#each lines}}<tr><td>{{ account }}</td><td>{{ debit }}</td><td>{{ credit }}</td></tr>{{/each}}"
          + "</table><p>{{ labels.total }}: {{ totals.debit }}</p></body></html>",
    },
  });
}
```

`pdfText` needs no move: Step 1 wrote it in `tests/support/pdf.ts` and this file imports it the same way the API suite does. Add the one line to this file's import block, beside the `startApi` and `sharedApi` imports 0B's block already carries:

```ts
import { pdfText } from "../support/pdf";
```

That is a **shared test helper**, recorded under *Contract additions* against §4.17.1 — the only one this slice adds, and the only one §4.17.1 assigns it.

- [ ] **Step 7: Run the regression tier and the whole API suite**

Run: `bun run --cwd tests test -- regression/legacy-085.test.ts && bun run --cwd apps/api test && bun run lint && bun run typecheck`
Expected: PASS — including 1A's and 2B's existing `documents.test.ts` and `document-lifecycle.test.ts`, untouched by the new sub-path.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/accounting/print.ts packages/contracts/src/index.ts \
        packages/contracts/openapi.json apps/api/src/routes/accounting/documents.ts \
        apps/api/src/middleware/require-attachment-read.ts apps/api/src/middleware/idempotency.ts \
        apps/api/test/routes/accounting/print.test.ts apps/api/package.json \
        tests/support/pdf.ts tests/package.json tests/regression/legacy-085.test.ts
git commit -m "feat(api): POST .../documents/{id}/print — synchronous PDF in both directions [2C T9]

§4.5.9 verbatim: synchronous 200 application/pdf, no job name, JOBS stays closed. The gate is
§4.5.4's stated rule for a document read — the type's module read code, from §4.5.8's map.
Printing writes nothing, so REPLAY_BY_RERUN re-runs a replayed key and app.idempotency_key
stores a descriptor (type, size, sha256), never the PDF. Test 23 asserted on the text layer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Acceptance test 15 — "Consignment return", defined purely as configuration

Part VI test 15, verbatim (spec:2433): *"**New document type, zero code.** Define 'Consignment return' purely as configuration; it numbers, posts, prints, reports and reverses correctly."* This is Phase 2's definition of done in one sentence, and this task is where it becomes a runnable assertion. Five clauses, five assertions, plus a sixth that no earlier slice could make: **that no application code mentions the type at all.**

**Why the fixture is inventory-free, and why that still proves the sentence.** §4.14 pins `CONSIGNMENT_RETURN` as `inbound / inventory: none / approval.post: accounting.journal.post`. The inventory-bearing shape a real consignment return would have needs `app.warehouse`, `app.item` and `app.cost_layer` — 3A and 3B — and the permission code `accounting.purchase.post`, which is 3C's; §4.4.1's `validatePolicy` fails with `ERR_POLICY_INVALID` on an `approval` code absent from the catalogue (F-21), so the inventory shape is not merely unbuilt, it is *unvalidatable* here. A purely accounting consignment return exercises every clause of test 15, and 3C re-runs the test on the inventory-bearing shape once those tables and that code exist.

**Where the fixture lives, and why not in the seed pack.** `tests/fixtures/document-types/CONSIGNMENT_RETURN.json`, **not** `packages/db/seed/my/document-types/`. Test 15 is about a *tenant* adding a type without a release; a seed file would prove the seeder works, which 1A already proved. The fixture is posted through the API, which is the point.

**Files:**
- Create: `tests/fixtures/document-types/CONSIGNMENT_RETURN.json`, `tests/fixtures/templates/CONSIGNMENT_RETURN.standard.v1.json`, `tests/fixtures/templates/CONSIGNMENT_RETURN.standard.v1.html`, `tests/invariants/zero-code-document-type.test.ts`
- Modify: none. **That is the deliverable.**

**Interfaces:**
- Consumes: `POST /v1/companies/{companyId}/document-types` and `POST …/document-types/{documentTypeId}/policies` (2A); `POST …/print-templates` (Task 7); `POST …/documents`, `PUT …/documents/{id}/lines`, `POST …/documents/{id}/transitions`, `POST …/documents/{id}/reverse` (1A, 2B); `POST …/documents/{id}/print` (Task 9); `GET …/reports/accounting.ledger` (1B); `app.series_gaps` (2B, §4.5.5); `DOCUMENT_STAGE_CODES` (2B); `sharedApi`, `fullRegression`, `grantAdmin`, `problemOf`, `sourceFiles`, `REPO_ROOT` (§4.17.1); `pdfText` (Task 9).
- Produces: no source interface. The three fixture files and the suite. **`CONSIGNMENT_RETURN` is registered in §4.14 already**, so this task writes into no namespace it has not been given.

- [ ] **Step 1: Write the configuration — three files, no TypeScript**

`tests/fixtures/document-types/CONSIGNMENT_RETURN.json` — the §4.3.7 envelope, exactly the shape a tenant would send:

```json
{
  "code": "CONSIGNMENT_RETURN",
  "nameEn": "Consignment Return",
  "nameAr": "مرتجع أمانة",
  "module": "accounting",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "CONSIGNMENT_RETURN",
    "direction": "inbound",
    "requires": [],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "CR", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "CONSIGNMENT_RETURN" },
    "approval": { "required": false, "approve": null, "post": "accounting.journal.post" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": [] }
  }
}
```

Every account is resolved through `line.account`, so **no `account: { code }` literal appears anywhere in this slice** and §4.15's register is untouched (the 2C card says so explicitly). `reversal.producesType` is the type itself: a reversed consignment return is another consignment return with the sides swapped, which is what D13 describes and what keeps the series meaningful.

`tests/fixtures/templates/CONSIGNMENT_RETURN.standard.v1.json`:

```json
{
  "documentType": "CONSIGNMENT_RETURN",
  "code": "standard",
  "version": 1,
  "nameEn": "Consignment Return",
  "nameAr": "مرتجع أمانة",
  "engine": "chromium",
  "paper": "A4",
  "labels": {
    "en": {
      "documentNo": "Document no.", "date": "Date", "dateHijri": "Hijri date", "currency": "Currency",
      "line": "#", "description": "Description", "account": "Account", "debit": "Debit", "credit": "Credit",
      "total": "Total", "status": "Status", "returnedTo": "Returned to"
    },
    "ar": {
      "documentNo": "رقم المستند", "date": "التاريخ", "dateHijri": "التاريخ الهجري", "currency": "العملة",
      "line": "#", "description": "البيان", "account": "الحساب", "debit": "مدين", "credit": "دائن",
      "total": "الإجمالي", "status": "الحالة", "returnedTo": "مرتجع إلى"
    }
  }
}
```

`tests/fixtures/templates/CONSIGNMENT_RETURN.standard.v1.html`:

```html
<!doctype html>
<html lang="{{ lang }}" dir="{{ dir }}">
<head>
<meta charset="utf-8">
<style>
  :root { font-family: "Noto Sans", "Noto Sans Arabic", system-ui, sans-serif; font-size: 11pt; }
  body { margin: 0; padding: 16mm; }
  h1 { font-size: 16pt; margin: 0 0 4mm; }
  dl { display: grid; grid-template-columns: auto auto; gap: 1mm 4mm; margin: 0 0 8mm; }
  dt { color: #555; }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-block-end: 0.3mm solid #ccc; padding: 2mm 1mm; text-align: start; }
  th.num, td.num { text-align: end; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 600; border-block-start: 0.5mm solid #333; border-block-end: none; }
</style>
</head>
<body>
  <h1>{{ document.typeName }}</h1>
  <dl>
    <dt>{{ labels.documentNo }}</dt><dd>{{ document.series }}-{{ document.number }}</dd>
    <dt>{{ labels.date }}</dt><dd>{{ document.effectiveDate }}</dd>
    <dt>{{ labels.dateHijri }}</dt><dd>{{ document.effectiveDateHijri }}</dd>
    <dt>{{ labels.currency }}</dt><dd>{{ document.currency }}</dd>
    <dt>{{ labels.status }}</dt><dd>{{ document.status }}</dd>
    {{#if document.partyName}}<dt>{{ labels.returnedTo }}</dt><dd>{{ document.partyName }}</dd>{{/if}}
  </dl>
  <table>
    <thead><tr>
      <th>{{ labels.line }}</th><th>{{ labels.description }}</th><th>{{ labels.account }}</th>
      <th class="num">{{ labels.debit }}</th><th class="num">{{ labels.credit }}</th>
    </tr></thead>
    <tbody>{{#each lines}}<tr>
      <td>{{ lineNo }}</td><td>{{ description }}</td><td>{{ account }}</td>
      <td class="num">{{ debit }}</td><td class="num">{{ credit }}</td>
    </tr>{{/each}}</tbody>
    <tfoot><tr>
      <td></td><td>{{ labels.total }}</td><td></td>
      <td class="num">{{ totals.debit }}</td><td class="num">{{ totals.credit }}</td>
    </tr></tfoot>
  </table>
</body>
</html>
```

- [ ] **Step 2: Write the failing suite**

**One `withTenant` shape for this file, stated once: it takes the *production* three-argument `withTenant(sql, ctx, fn)` from `@dulja/db`, and as written below it calls it zero times.** Contracts hazard 15 is explicit — "root `tests/` use the production one" — and §4.2.12 gives root `tests/` `@dulja/db/test` for `startDb`, `seedTenant`, `draftDocument`, `uuidv7`, `Seed` and `Db` but `withTenant` from `@dulja/db`. Every direct read in the suite is an assertion about a row the API has just written, so it goes through `api.db.admin`, the harness's admin connection, and needs no tenant session at all. The four-argument **test** helper of §4.1 is `packages/db/test/harness.ts`'s and does not appear in this file; a later slice appending a block that genuinely needs a tenant-scoped transaction uses the three-argument production form, and the two shapes are never mixed here.

`tests/invariants/zero-code-document-type.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, sourceFiles } from "../support/source";
import { pdfText } from "../support/pdf";
import { grantCodes, seedTenantV2, type Seed } from "@dulja/db/test";
// `startApi()` lives in `apps/api/test/support/app.ts` (§4.2.12). There is no `tests/support/app.ts`;
// 0B's own `tests/support/api.ts` and `tests/invariants/tenant-isolation.test.ts` import it by exactly
// this relative path (0B:5238, 5611), under the named `dependency-rule` allowance §4.17.1 describes,
// so this file adds no new crossing and no new allowance.
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
// No `withTenant` import, and that is deliberate: every direct read below is an assertion about a row
// the API has just written, so it uses `api.db.admin`. If a later slice appends a block that needs a
// tenant session, it imports the PRODUCTION three-argument `withTenant(sql, ctx, fn)` from `@dulja/db`
// (contracts §4.2.2; hazard 15 — "root `tests/` use the production one"), never the four-argument test
// helper of §4.1, which belongs to `packages/db/test/harness.ts`.

const FIXTURES = join(REPO_ROOT, "tests", "fixtures");
const envelope = JSON.parse(readFileSync(join(FIXTURES, "document-types/CONSIGNMENT_RETURN.json"), "utf8")) as {
  code: string; nameEn: string; nameAr: string; module: string;
  policyVersion: number; effectiveFrom: string; policy: unknown;
};
const manifest = JSON.parse(readFileSync(join(FIXTURES, "templates/CONSIGNMENT_RETURN.standard.v1.json"), "utf8")) as {
  code: string; version: number; nameEn: string; nameAr: string;
  engine: string; paper: string; labels: { en: Record<string, string>; ar: Record<string, string> };
};
const templateBody = readFileSync(join(FIXTURES, "templates/CONSIGNMENT_RETURN.standard.v1.html"), "utf8");

describe("Part VI test 15 — a new document type is added with ZERO CODE (spec:2433)", () => {
  let api: StartedApi;
  let s: Seed;
  let documentTypeId: string;
  let documentId: string;
  let accounts: { cash: string; sales: string };

  beforeAll(async () => {
    // Its own instance: this suite creates a document type and a series, and §4.17.1's `sharedApi`
    // is shared with every other file in the tier. `fullRegression` is declarative (a record of
    // cases) and is for `tests/regression/`, not for an ordered invariant sequence like this one.
    api = await startApi();
    s = await seedTenantV2(api.db, "Alpha");
    // The six codes the sequence below needs and no others. `1000` and `4000` were created by
    // `seedTenantV2` (§4.1's pinned constants); this slice seeds no account (§4.15: 2C seeds none),
    // so the ids are READ, never re-created.
    await grantCodes(api.db, s, {
      principalId: s.human,
      codes: [
        "admin.company.manage", "accounting.journal.create", "accounting.journal.post",
        "accounting.document.reverse", "accounting.report.read", "accounting.ledger.read",
      ],
    });
    const rows = await api.db.admin<{ code: string; id: string }[]>`
      select code, id from app.account where company_id = ${s.company} and code in ('1000', '4000')`;
    accounts = {
      cash: rows.find((r) => r.code === "1000")!.id,
      sales: rows.find((r) => r.code === "4000")!.id,
    };
  }, 240_000);
  afterAll(async () => { await api.stop(); });

  // ── 1. Define it. Three HTTP calls, three files of JSON and HTML, no release. ─────────────

  it("creates the document type from the envelope, through the API", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/document-types`, as: s.human,
      body: { code: envelope.code, nameEn: envelope.nameEn, nameAr: envelope.nameAr, module: envelope.module },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; code: string; module: string };
    expect(body.code).toBe("CONSIGNMENT_RETURN");
    // §4.5.8's download gate reads this column; the envelope sets it, never the default (hazard 34).
    expect(body.module).toBe("accounting");
    documentTypeId = body.id;
  });

  it("creates policy version 1 from the envelope's policy member", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/document-types/${documentTypeId}/policies`,
      as: s.human,
      body: { version: envelope.policyVersion, effectiveFrom: envelope.effectiveFrom, definition: envelope.policy },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { version: number; effectiveFrom: string };
    expect(body).toMatchObject({ version: 1, effectiveFrom: "2026-01-01" });
  });

  it("creates the print template from the manifest and the body", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/print-templates`, as: s.human,
      body: {
        documentTypeCode: envelope.code, code: manifest.code, version: manifest.version,
        nameEn: manifest.nameEn, nameAr: manifest.nameAr,
        engine: manifest.engine, paper: manifest.paper, labels: manifest.labels, body: templateBody,
      },
    });
    expect(res.status).toBe(201);
  });

  // ── 2. It numbers. ───────────────────────────────────────────────────────────────────────

  it("numbers: the first CONSIGNMENT_RETURN takes CR-1 on issue", async () => {
    // 1A's `CreateDocumentBody` carries `lines` (min 1) and `LineInput` takes `accountId`, never a
    // code — the code→id resolution belongs to the caller, and 2A dropped 1A's `JOURNAL`-only
    // literal on `documentTypeCode`, which is what lets this line name a type no release knows.
    const created = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents`, as: s.human,
      body: {
        documentTypeCode: "CONSIGNMENT_RETURN", effectiveDate: "2026-03-15",
        currency: "MYR", branchId: s.hq,
        lines: [
          { lineNo: 1, accountId: accounts.sales, description: "Goods returned to consignor", debit: "90.0000" },
          { lineNo: 2, accountId: accounts.cash, description: "Consignment clearing", credit: "90.0000" },
        ],
      },
    });
    expect(created.status).toBe(201);
    documentId = (await created.json() as { id: string }).id;

    const issued = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/transitions`,
      as: s.human, body: { to: "issued" },
    });
    expect(issued.status).toBe(200);
    // `TransitionResult.number` is a `bigint` in TypeScript, so it crosses the wire as a STRING —
    // 1B's `LedgerRowSchema.number` is `z.string().nullable()` for the same reason.
    const body = await issued.json() as { number: string };
    expect(body.number).toBe("1");

    const [row] = await api.db.admin<{ series: string; number: string }[]>`
      select series, number::text from app.document where id = ${documentId}`;
    expect(row!.series).toBe("CR");
    expect(row!.number).toBe("1");
  });

  // ── 3. It posts. ─────────────────────────────────────────────────────────────────────────

  it("posts: two balanced ledger entries, tagged with the policy that produced them", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/transitions`,
      as: s.human, body: { to: "posted" },
    });
    expect(res.status).toBe(200);

    const rows = await api.db.admin<{ debit: string; credit: string; policy: string }[]>`
      select debit::text, credit::text, posting_policy_id as policy
        from app.ledger_entry where document_id = ${documentId} order by line_no`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.debit)).toEqual(["90.0000", "0.0000"]);
    expect(rows.map((r) => r.credit)).toEqual(["0.0000", "90.0000"]);
    // Every entry is pinned to the policy version that produced it (LEGACY-013).
    expect(new Set(rows.map((r) => r.policy)).size).toBe(1);
  });

  // ── 4. It prints — both directions, from one template row. ───────────────────────────────

  it("prints: a PDF in each direction, with that direction's labels and nothing else", async () => {
    const seen: Record<string, string> = {};
    for (const lang of ["en", "ar"] as const) {
      const res = await api.request({
        method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/print`,
        as: s.human, body: { lang },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      seen[lang] = (await pdfText(new Uint8Array(await res.arrayBuffer()))).join(" ");
    }
    expect(seen["en"]).toContain("Consignment Return");
    expect(seen["en"]).toContain("CR-1");
    expect(seen["ar"]).toContain("مرتجع أمانة");
    expect(seen["ar"]).toContain("مدين");
    expect(seen["ar"]).not.toContain("Debit");
    for (const lang of ["en", "ar"] as const) expect(seen[lang]).toContain("90.0000");
  }, 180_000);

  // ── 5. It reports — in 1B's ledger, under 1B's code, with no report code added. ──────────

  it("reports: the entries appear in accounting.ledger with the type's own code", async () => {
    const [account] = await api.db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '4000'`;
    const res = await api.request({
      method: "GET", as: s.human,
      path: `/v1/companies/${s.company}/reports/accounting.ledger`
          + `?accountId=${account!.id}&fromDate=2026-01-01&toDate=2026-12-31&limit=50`,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      items: { documentTypeCode: string; series: string; number: string | null; debit: { amount: string } }[];
    };
    const mine = body.items.filter((i) => i.documentTypeCode === "CONSIGNMENT_RETURN");
    expect(mine).toHaveLength(1);
    // `number` is `z.string().nullable()` in 1B's `LedgerRowSchema` — a bigint on the wire is a string.
    expect(mine[0]).toMatchObject({ series: "CR", number: "1" });
    expect(mine[0]!.debit.amount).toBe("90.0000");
  });

  // ── 6. It reverses — producing its own type, and marking the original. ──────────────────

  it("reverses: a second CONSIGNMENT_RETURN with the sides swapped; the original becomes reversed", async () => {
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents/${documentId}/reverse`,
      as: s.human, body: { effectiveDate: "2026-03-20", reason: "Consignor rejected the return" },
    });
    expect(res.status).toBe(201);
    const { reversalDocumentId } = await res.json() as { reversalDocumentId: string; number: number };

    const [reversal] = await api.db.admin<{ code: string; series: string; number: string; status: string }[]>`
      select dt.code, d.series, d.number::text, d.status
        from app.document d join app.document_type dt on dt.id = d.document_type_id
       where d.id = ${reversalDocumentId}`;
    expect(reversal).toMatchObject({ code: "CONSIGNMENT_RETURN", series: "CR", number: "2", status: "posted" });

    const [original] = await api.db.admin<{ status: string }[]>`
      select status from app.document where id = ${documentId}`;
    expect(original!.status).toBe("reversed");

    // The two documents net to zero on every account — D13's whole point.
    const [net] = await api.db.admin<{ debit: string; credit: string }[]>`
      select coalesce(sum(debit),0)::text as debit, coalesce(sum(credit),0)::text as credit
        from app.ledger_entry where document_id in (${documentId}, ${reversalDocumentId})`;
    expect(net!.debit).toBe(net!.credit);
  });

  it("leaves the CR series gapless — app.series_gaps returns nothing (2B, §4.5.5)", async () => {
    const [doc] = await api.db.admin<{ period: string }[]>`
      select fiscal_period_id as period from app.document where id = ${documentId}`;
    const gaps = await api.db.admin<{ number: string }[]>`
      select number::text from app.series_gaps(${s.company}, 'CR', ${doc!.period})`;
    expect(gaps).toEqual([]);
  });

  // ── 7. ZERO CODE — the clause no earlier slice could assert. ────────────────────────────

  it("mentions the type in no application source file — the literal lives only under tests/", () => {
    // `sourceFiles(roots?)` returns `SourceFile[]` — `{ path, text, lines }`, path repo-relative with
    // forward slashes (0B, tests/support/source.ts) — so this reads `.text`, not the filesystem.
    //
    // Filtered to `**/src/**`: the claim is about APPLICATION code. A slice's own test fixtures may
    // legitimately name the type (Task 12's back-office fixture rows do), and `sourceFiles`' walk
    // does not exclude `test/` directories, so an unfiltered sweep would fail on a test double and
    // say nothing about whether a release was needed.
    const offenders = sourceFiles(["apps", "packages"])
      .filter((f) => /(^|\/)src\//.test(f.path))
      .filter((f) => f.text.includes("CONSIGNMENT_RETURN"))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  // There is deliberately NO assertion here about `DOCUMENT_STAGE_CODES`. §4.2.7 fixes `apps/api`'s
  // exports as `{ ".": "./src/app.ts", "./routes": "./src/routes/index.ts" }` and states that the `tests`
  // tier imports `@dulja/api` only through those, never a route file (§3.1) — so importing the constant
  // from `apps/api/src/routes/accounting/documents` would fail the `dependency-rule` lint. The claim it
  // was making ("the policy's `approval.post` names a catalogue code, and no new code was needed") is
  // already enforced at build time by the bidirectional `permission-catalogue` lint 2A ships (§3.6.3),
  // which is a stronger check than an assertion in one suite. Re-exporting the constant from
  // `apps/api/src/routes/index.ts` to get it back would be a 2A amendment for no added coverage.

  it("needed no new report code: the type appears under 1B's accounting.ledger, unchanged", () => {
    // 1B ships `ReportCodeSchema` in `packages/contracts/src/accounting/reports.ts` (1B Task 10).
    const reportCodes = readFileSync(
      join(REPO_ROOT, "packages/contracts/src/accounting/reports.ts"), "utf8");
    expect(reportCodes).not.toMatch(/consignment/i);
  });
});
```

Run: `bun run --cwd tests test -- invariants/zero-code-document-type.test.ts`
Expected: FAIL — the first assertion, `expect(res.status).toBe(201)` on the document-type create, is the only thing that can fail if 2A merged correctly; if it does not, the failure names which endpoint is missing.

- [ ] **Step 3: There is no implementation step**

**This is the deliverable.** Every endpoint the suite calls was shipped by 2A, 2B, 1A, 1B or Tasks 7 and 9 of this plan. If a clause fails, the fix belongs in the slice that owns that endpoint, not here — and that is what makes the sentence true rather than asserted. Run it and read the failure:

Run: `bun run --cwd tests test -- invariants/zero-code-document-type.test.ts`
Expected: PASS — 11 tests. A failure in clause 2, 3 or 6 is a 2A/2B defect; clause 4 is Task 9's; clause 5 is 1B's; clause 7 fails only if some slice hard-coded the type, which is exactly what the assertion exists to catch.

- [ ] **Step 4: Confirm the "zero code" claim against git, not only against the source tree**

The suite asserts that no source file *contains* the literal. The stronger claim — that this PR added no application code — is checked once, by hand, at review:

```bash
git diff --stat origin/main -- apps packages | tail -n 1
```

Expected: the only `apps/` or `packages/` paths in this task's commit are **none** — the diff is `tests/` only. Record the output in the PR body. (Tasks 7 and 9 added the endpoints; *this* task adds configuration and a test, which is the sentence.)

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/document-types/CONSIGNMENT_RETURN.json \
        tests/fixtures/templates/CONSIGNMENT_RETURN.standard.v1.json \
        tests/fixtures/templates/CONSIGNMENT_RETURN.standard.v1.html \
        tests/invariants/zero-code-document-type.test.ts
git commit -m "test(invariants): acceptance test 15 — a new document type with zero code [2C T10]

spec:2433. CONSIGNMENT_RETURN is three files of configuration posted through the API: it numbers
(CR-1), posts (two balanced entries pinned to its policy), prints (both directions from one
template row), reports (1B's accounting.ledger, no new report code) and reverses (its own type,
sides swapped, original reversed). The seventh test is the sentence itself: the literal appears
in no file under apps/ or packages/. Diff touches tests/ only.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Migration 0027 — the expand half on a live table, and acceptance test 25

Part VI test 25, verbatim (spec:2443): *"**Zero-downtime migration.** A schema change deploys with no maintenance window; duration is proportional to the change, not the data."* LEGACY-080 is the finding it answers — the legacy system's "schema upgrade is a full database dump-and-repump driven by 6,251 uncoordinated version integers" (spec:872). §3.9 states the rule: *"Expand/contract for any change touching a live table"* (spec:2057), and §4.8 promises *"zero-downtime deployments; expand/contract migrations so schema change never requires a maintenance window"* (spec:2236).

`app.document` is the busiest live table in the system by the end of Phase 2, so it is the honest subject. `document.notes` is the column §4.3.4 assigns 2C, and adding it is the **expand** half. The **contract** half — dropping something — is a separate PR in a later slice by construction, and this task writes the runbook that later slice follows.

**Two properties have to be proven, not asserted.** First, that a request loop keeps serving *through* the migration: the assertion is zero non-2xx responses while `up()` runs, not merely that `up()` returns. Second, that "duration is proportional to the change, not the data": a nullable `ADD COLUMN` with no default is a catalogue-only operation in PostgreSQL, so the assertion is a **ratio** across two row counts, not a wall-clock bound — a bound would pass on a fast machine and fail on a slow one while proving nothing about proportionality.

**The real hazard is the lock, and the migration file bounds it.** `ALTER TABLE … ADD COLUMN` takes `ACCESS EXCLUSIVE` for a moment. That is harmless unless it *queues behind* a long-running read, because every reader that arrives afterwards then waits behind the queued `ALTER` — the well-known way a "one-millisecond" migration takes a site down. `set local lock_timeout` at the top of the file bounds it: the `ALTER` either takes its lock promptly or fails, the transaction rolls back, and the deploy is retried. That statement is legal inside the transaction 0A's `up()` already opens (plan0A Task 4 wraps each file in `sql.begin`), so the runner is untouched and Plan 0A stays frozen.

**Files:**
- Create: `packages/db/migrations/0027_expand_document_add_notes.sql`, `packages/db/migrations/0027.down.sql`, `packages/db/test/expand-contract.test.ts`, `docs/adr/0033-expand-contract-live-tables.md`, `docs/runbooks/expand-contract.md`
- Modify: `packages/db/src/schema/document.ts`, `packages/db/src/print/template.ts`, `packages/db/test/print-render.test.ts`, `packages/db/test/privileges.test.ts`, `tests/regression/legacy-080.test.ts`

**Interfaces:**
- Consumes: `up`, `down`, `listApplied`, `discover`, `lintSchema`, `Violation` from `packages/db/src` (§4.1); `MIGRATIONS_DIR`, `startDb`, `Db` from `packages/db/test/harness.ts` and `seedTenantV2`, `grantCodes`, `draftDocument`, `Seed` from `packages/db/test/fixtures.ts` (§4.17) — both reachable as `@dulja/db/test` from another workspace; `loadPrintContext`, `renderDocumentSource` (Task 8); `startApi`, `StartedApi` from `apps/api/test/support/app` (§4.2.12); `thinRegression` (§4.17.1). **Not `sharedApi`/`fullRegression`** — see the box in Step 5.
- Produces: migration 0027 and its down file; `document.notes` on the Drizzle mirror; the runbook that governs every later contract PR. **No TypeScript interface.**

- [ ] **Step 1: Write the failing test**

`packages/db/test/expand-contract.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// `down`, `listApplied` and `up` are `packages/db/src/migrate.ts`'s (§4.1 lists its exports as exactly
// `discover, down, listApplied, up, Migration`). `MIGRATIONS_DIR` is NOT there — plan 0A declares it in
// `packages/db/test/harness.ts` (`export const MIGRATIONS_DIR = join(here, "..", "migrations")`), which is
// why it rides the `./harness` import below and reaches other workspaces as `@dulja/db/test`.
import { down, listApplied, up } from "../src/migrate";
import { lintSchema } from "../src/lint-schema";
import { withTenant as prodWithTenant } from "../src/with-tenant";
import { MIGRATIONS_DIR, startDb, uuidv7, type Db } from "./harness";
import { draftDocument, seedTenantV2, type Seed } from "./fixtures";

const VERSION = 27;
const ctx = (s: Seed, requestId: string) => ({ tenantId: s.tenant, actorId: s.human, requestId });

/** Rolls the database back to just before 0027 so this file owns the transition it measures. */
async function rewind(db: Db): Promise<void> {
  const applied = await listApplied(db.migrator);
  if (applied.includes(VERSION)) await down(db.migrator, MIGRATIONS_DIR, VERSION - 1);
}

describe("migration 0027 — the EXPAND half on a live table (spec:2057, test 25)", () => {
  let db: Db; let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("adds one nullable column and nothing else", async () => {
    await rewind(db);
    const before = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'document' order by column_name`;
    expect(before.map((r) => r.column_name)).not.toContain("notes");

    expect(await up(db.migrator, MIGRATIONS_DIR)).toContain(VERSION);

    const after = await db.admin<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, is_nullable, column_default from information_schema.columns
       where table_schema = 'app' and table_name = 'document' order by column_name`;
    const added = after.filter((r) => !before.some((b) => b.column_name === r.column_name));
    expect(added).toHaveLength(1);
    // Nullable and DEFAULT-less: that is what makes it catalogue-only rather than a table rewrite.
    expect(added[0]).toMatchObject({ column_name: "notes", is_nullable: "YES", column_default: null });
  });

  it("keeps the schema clean — lintSchema reports zero violations after 0027", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations).toEqual([]);
  });

  it("round-trips a note through the column", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    const note = "Returned to consignor on 2026-03-20 — سبب الإرجاع";
    const read = await prodWithTenant(db.rw, ctx(a, requestId), async (tx) => {
      await tx`update app.document set notes = ${note} where id = ${documentId}`;
      const [row] = await tx<{ notes: string }[]>`select notes from app.document where id = ${documentId}`;
      return row!.notes;
    });
    expect(read).toBe(note);
  });

  it("costs the same regardless of how many rows the table holds (spec:2443)", async () => {
    // Two measurements at a tenfold difference in row count. A nullable ADD COLUMN writes only the
    // catalogue, so the ratio must stay near 1 — this asserts PROPORTIONALITY, which no wall-clock
    // bound can, because a bound passes on a fast machine while proving nothing.
    const timings: number[] = [];
    for (const rows of [200, 2_000]) {
      await rewind(db);
      // `draftDocument` opens its own tenant session per call (§4.1); wrapping the loop in another
      // withTenant would nest one and raise ERR_TENANT_CONTEXT_NESTED (§4.2.2).
      for (let i = 0; i < rows; i += 1) await draftDocument(db, a);
      const started = performance.now();
      // After 3A merges, this `up()` applies 0027 AND 0028+ if they are unapplied on this instance.
      // The ratio assertion still holds for catalogue-only DDL and the point of the test is
      // unchanged; if a later slice adds a rewriting migration to the same unapplied set, `rewind`
      // grows a second call — it does not become a different test.
      await up(db.migrator, MIGRATIONS_DIR);
      timings.push(performance.now() - started);
    }
    const [small, large] = timings as [number, number];
    // Generous on purpose: the claim is "not proportional to the data", i.e. the tenfold row increase
    // does not produce anything like a tenfold increase in time.
    expect(large).toBeLessThan(small * 4 + 250);
  }, 240_000);

  it("bounds its lock: the file sets lock_timeout, so it fails fast instead of queuing", async () => {
    const sql = (await import("node:fs")).readFileSync(
      `${MIGRATIONS_DIR}/0027_expand_document_add_notes.sql`, "utf8");
    expect(sql).toMatch(/set local lock_timeout\s*=\s*'\d+s'/);
    expect(sql).toMatch(/set local statement_timeout\s*=\s*'\d+s'/);
  });

  it("is reversible: the down file drops the column and never the table", async () => {
    const text = (await import("node:fs")).readFileSync(`${MIGRATIONS_DIR}/0027.down.sql`, "utf8");
    expect(text).toMatch(/alter table app\.document drop column/);
    expect(text).not.toMatch(/drop table/);

    await down(db.migrator, MIGRATIONS_DIR, VERSION - 1);
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'document' and column_name = 'notes'`;
    expect(cols).toEqual([]);
    await up(db.migrator, MIGRATIONS_DIR);
  });
});
```

Run: `bun run --cwd packages/db test -- test/expand-contract.test.ts`
Expected: FAIL — `applied migration 27 has no file` from `down`, or `up` returns an array without 27.

- [ ] **Step 2: Write the migration**

`packages/db/migrations/0027_expand_document_add_notes.sql`:

```sql
-- 0027_expand_document_add_notes.sql
-- The EXPAND half of an expand/contract change on a LIVE table (spec:2057; §4.8 spec:2236).
-- Answers LEGACY-080 (spec:872): the legacy system's schema upgrade is a full dump-and-repump.
-- Contracts §4.3.4 assigns `document.notes` to 2C. The CONTRACT half is a later slice's PR —
-- the procedure is docs/runbooks/expand-contract.md and the reasoning is ADR 0033.
-- Acceptance test 25 (spec:2443) is asserted against this file.

-- ── 1. bound the lock ────────────────────────────────────────────────────────────────────────
-- ALTER TABLE takes ACCESS EXCLUSIVE for an instant. The danger is never the ALTER itself: it is
-- the ALTER QUEUING behind a long read, after which every arriving reader waits behind the queued
-- ALTER and the table is effectively offline. lock_timeout makes that outcome impossible — the
-- statement fails, this transaction rolls back, nothing is applied, and the deploy is retried.
-- `set local` is scoped to the transaction Plan 0A's `up()` already opens around each file
-- (plan0A:736–748), so the runner is untouched and Plan 0A stays frozen.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- ── 2. expand ────────────────────────────────────────────────────────────────────────────────
-- Nullable, and DEFAULT-less on purpose. PostgreSQL 11+ can add a column with a constant default
-- without a rewrite, but "nullable and no default" is unconditionally catalogue-only on every
-- version, which is what makes the duration proportional to the change rather than to the data.
-- The API keeps serving throughout: existing readers select an explicit column list, and a new
-- column is invisible to them until they ask for it (the expand/contract discipline itself).
alter table app.document add column notes text;

comment on column app.document.notes is
  'Free-text note printed on the document (contracts §4.3.4, slice 2C). Expand half of 0027.';

-- ── 3. what is deliberately NOT here ─────────────────────────────────────────────────────────
-- No NOT NULL, no default, no backfill, no index, no trigger change. `app.document` already carries
-- its audit trigger from migration 0001, and `audit_row` images the whole row with `to_jsonb(new)`
-- (plan0A), so a note change is audited from the moment this file lands — no trigger edit is needed
-- and adding one would be the "disable an invariant temporarily" move §0.2 forbids.
-- No per-tenant row is written: FORCE ROW LEVEL SECURITY binds app_migrator and a migration sees no
-- tenants (hazard 10).
```

`packages/db/migrations/0027.down.sql`:

```sql
-- 0027.down.sql — hand-written, per §3.9 (spec:2057): "reversible" means this file exists and passes.
-- CI applies it and re-applies up on a Testcontainers database; production is forward-only.
-- Drops the COLUMN and never the table: 0027 created no table, and a down file that dropped
-- app.document would destroy every document 1A and 2A wrote (§3.4.5).
set local lock_timeout = '3s';

alter table app.document drop column notes;
```

- [ ] **Step 3: Extend the Drizzle mirror and read the column where it is printed**

In `packages/db/src/schema/document.ts`, add to the existing `document` table (§3.4.9 — the mirror follows the migration, it never leads it):

```ts
  notes: text("notes"),
```

In `packages/db/src/print/template.ts`, Task 8 left `notes: null` with a comment naming this task. Add the column to the header query and return it — everything else in the statement, including the `${ar}` party-name choice Task 8 wrote, is unchanged:

```ts
  const [head] = await tx<{
    companyName: string; typeNameEn: string; typeNameAr: string | null; partyName: string | null;
    notes: string | null;
  }[]>`
    select c.name       as "companyName",
           dt.name_en   as "typeNameEn",
           dt.name_ar   as "typeNameAr",
           case when ${ar} then coalesce(p.name_ar, p.name_en) else p.name_en end as "partyName",
           d.notes      as "notes"
      from app.document d
      join app.company c       on c.id = d.company_id
      join app.document_type dt on dt.id = d.document_type_id
      left join app.party p     on p.id = d.party_id
     where d.id = ${documentId}`;
```

and replace the `notes: null` line with `notes: head.notes,`, deleting the comment that pointed here.

Replace Task 8's placeholder assertion in `packages/db/test/print-render.test.ts` — the test named *"leaves `notes` empty until migration 0027 (Task 11) adds the column"* — with the real one:

```ts
  it("prints a note once 0027 has added the column", async () => {
    const requestId = await uuidv7(db.admin);
    const out = await prodWithTenant(db.rw, ctx(a, requestId), async (tx) => {
      await tx`update app.document set notes = 'Consignor notified' where id = ${documentId}`;
      return renderDocumentSource(tx, { documentId, lang: "en" });
    });
    expect(out.model.document.notes).toBe("Consignor notified");
    expect(out.rendered).toContain("class=\"notes\"");
    expect(out.rendered).toContain("Consignor notified");
  });

  it("prints an empty note as nothing at all, not as the string 'null'", async () => {
    const requestId = await uuidv7(db.admin);
    const out = await prodWithTenant(db.rw, ctx(a, requestId), async (tx) => {
      await tx`update app.document set notes = null where id = ${documentId}`;
      return renderDocumentSource(tx, { documentId, lang: "en" });
    });
    expect(out.model.document.notes).toBe("");
    expect(out.rendered).not.toContain("null");
  });
```

- [ ] **Step 4: Re-assert the pinned DELETE list**

§3.5.4 pins the DELETE grants and hazard 25 makes **2B the only slice that extends it**. 0027 must not have moved it. Append one case to `packages/db/test/privileges.test.ts`:

```ts
  it("0027 changed no privilege — the pinned DELETE list is what 2B left (§3.5.4, hazard 25)", async () => {
    const rows = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and privilege_type = 'DELETE' and table_schema = 'app'
       order by table_name`;
    // §3.5.4's pinned list in full: Plan 0A's three (`idempotency_key`, `role_permission`,
    // `role_assignment_branch` — plan0A:2563) plus 2B's two (`document`, `document_line`, after 0023).
    // FIVE rows, in the `order by table_name` order. An ALTER TABLE grants nothing, and a plan that
    // quietly added a grant here would be caught by this list, not by review.
    expect(rows.map((r) => r.table_name)).toEqual([
      "document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission",
    ]);
  });
```

If the repository's list differs at execution time, **do not edit the expectation to match** — a difference means a slice granted DELETE outside hazard 25 and the finding belongs in that slice's review.

- [ ] **Step 5: Prove the zero-downtime claim end to end and append the LEGACY-080 block**

`tests/regression/legacy-080.test.ts` was created by 0B. Append below the existing blocks — as a plain `describe` with **its own API instance**, not through `fullRegression`/`sharedApi`:

> **This block must not use `sharedApi()`.** §4.17.1's `sharedApi` is one instance shared by the whole regression tier, and this test **rolls migrations back**. A `down(…, 26)` on the shared instance breaks every other file mid-run, and hazard 14 makes it worse: migration numbers are allocated per slice and applied in whatever order the parallel phases merge, so `down(…, 26)` also unwinds any 0028+ that happens to be applied. A test that mutates the schema owns its instance and stops it.

It therefore calls `startApi()` directly, and the import is the one 0B already uses from this tier — there is **no `tests/support/app.ts`**. Add to the head of `tests/regression/legacy-080.test.ts`, beside the imports 0B wrote:

```ts
import { down, up } from "@dulja/db";
import { grantCodes, MIGRATIONS_DIR, seedTenantV2, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
```

(`up` and `down` are `@dulja/db`'s migration runner (§4.1); `MIGRATIONS_DIR` is `packages/db/test/harness.ts`'s and so comes through the `./test` subpath. If 0B's existing blocks in this file already import any of the four, add to that import rather than writing a second line for the same module.)

```ts
describe("LEGACY-080 (schema upgrade is a dump-and-repump) — 2C", () => {
  let api: StartedApi; let s: Seed;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Legacy080");
    await grantCodes(api.db, s, {
      principalId: s.human, codes: ["accounting.journal.create", "accounting.ledger.read"],
    });
    // `1000` and `4000` came with `seedTenantV2` (§4.1); 2C seeds no account (§4.15).
  }, 240_000);
  afterAll(async () => { await api.stop(); });

  it("migration 0027 applies while the API keeps serving — zero failed requests (test 25)", async () => {
    // This instance is ours, so rolling 0027 back is safe. Then hammer a read path while up() runs.
    await down(api.db.migrator, MIGRATIONS_DIR, 26);

    let stop = false;
    const statuses: number[] = [];
    const loop = (async () => {
      while (!stop) {
        const res = await api.request({
          method: "GET", as: s.human,
          path: `/v1/companies/${s.company}/documents?limit=5`,
        });
        statuses.push(res.status);
        await res.arrayBuffer();
      }
    })();

    // Let the loop establish itself, migrate, then let it run a little longer.
    await new Promise((r) => setTimeout(r, 250));
    const applied = await up(api.db.migrator, MIGRATIONS_DIR);
    await new Promise((r) => setTimeout(r, 250));
    stop = true;
    await loop;

    expect(applied).toContain(27);
    // No maintenance window: every request served, before during and after.
    expect(statuses.length).toBeGreaterThan(10);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  }, 240_000);

  it("the write path is unaffected: a document created before 0027 reads back after it", async () => {
    await down(api.db.migrator, MIGRATIONS_DIR, 26);
    const [cash] = await api.db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '1000'`;
    const [sales] = await api.db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '4000'`;
    const before = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/documents`, as: s.human,
      body: {
        documentTypeCode: "JOURNAL", effectiveDate: "2026-03-01", currency: "MYR", branchId: s.hq,
        lines: [
          { lineNo: 1, accountId: cash!.id, debit: "7.0000" },
          { lineNo: 2, accountId: sales!.id, credit: "7.0000" },
        ],
      },
    });
    expect(before.status).toBe(201);
    await up(api.db.migrator, MIGRATIONS_DIR);
    const { id } = await before.json() as { id: string };

    const after = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/documents/${id}`, as: s.human,
    });
    expect(after.status).toBe(200);
    // The old row simply has a null note. No backfill, no migration of data — that is the point.
    const [row] = await api.db.admin<{ notes: string | null }[]>`
      select notes from app.document where id = ${id}`;
    expect(row!.notes).toBeNull();
  }, 180_000);
});
```

- [ ] **Step 6: Write ADR 0033 and the runbook the contract PR follows**

`docs/adr/0033-expand-contract-live-tables.md`:

```markdown
# 0033 — Expand/contract for a live table, and what "zero downtime" is asserted to mean

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 2C
**Spec:** §3.9 Migrations (spec:2057) "Expand/contract for any change touching a live table";
§4.8 (spec:2236) "zero-downtime deployments … so schema change never requires a maintenance window
(the direct answer to LEGACY-080)"; LEGACY-080 (spec:872); Part VI test 25 (spec:2443).
**Demonstrated by:** `0027_expand_document_add_notes.sql`, `packages/db/test/expand-contract.test.ts`,
`tests/regression/legacy-080.test.ts`. **Binds:** every later migration that touches a live table.

## Context
LEGACY-080 is a High finding: the legacy system upgrades its schema by dumping and re-pumping the whole
database, coordinated by 6,251 version integers. The rebuild's answer is expand/contract. The rule was
written in §3.9 and never demonstrated, so "zero downtime" had no operational definition and no test.

## Decision
**1. Expand and contract are two PRs in two slices, never one file.** The expand PR adds; the contract
PR removes, after every deployed reader has stopped needing the old shape. `app.document.notes` is the
worked example: 2C expands, a later slice contracts (the runbook says how).

**2. Renaming a column is forbidden.** Add, backfill, dual-write, then drop — four steps across two PRs.
A rename is atomic in the database and non-atomic in the fleet, so it is a maintenance window wearing
a different hat.

**3. Every migration touching a live table sets `lock_timeout` in the file.** `ALTER TABLE` takes
`ACCESS EXCLUSIVE`; the failure mode is not the lock's duration but the lock QUEUING behind a long
read, after which arriving readers queue behind the ALTER. Bounded at **3 s**, with
`statement_timeout` at **30 s**. A timeout rolls the transaction back — nothing is half-applied,
because Plan 0A's runner wraps each file in one transaction — and the deploy is retried. Plan 0A's
runner is not modified: `set local` inside the file is enough, and Plan 0A is frozen.

**4. "Duration proportional to the change, not the data" is asserted as a RATIO, not a bound.** The
test measures the same migration against two row counts a decade apart in scale and asserts the
timings stay comparable. A wall-clock bound would pass on a fast machine and prove nothing.

**5. "No maintenance window" is asserted as ZERO non-2xx responses in a request loop that spans the
migration** — not as "the migration finished quickly". `tests/regression/legacy-080.test.ts` holds that
loop.

**6. Adding a column requires no audit or RLS change.** `app.document` carries its `audit_row` trigger
from migration 0001 and the trigger images the whole row (`to_jsonb(new)`), so the new column is
audited from the moment it exists. RLS is on the table, not the column.

## Consequences
- Every later live-table migration is reviewed against this ADR and re-runs test 25 (§6.1).
- A migration that needs `NOT NULL` on a live table is three PRs: add nullable, backfill in batches
  under a job, then add the constraint with `NOT VALID` followed by `VALIDATE CONSTRAINT`. None of
  those takes `ACCESS EXCLUSIVE` for longer than a catalogue write.
- The contract half of 0027 is scheduled, not forgotten: the runbook is the checklist and names the
  precondition (no deployed reader selects the column).
```

`docs/runbooks/expand-contract.md`:

```markdown
# Runbook — expand/contract on a live table

Governed by ADR 0033. Applies to every migration that touches a table already carrying tenant rows.

## Expand (this PR)
1. The change is **additive and nullable**. No `NOT NULL`, no `DEFAULT`, no rename, no type change.
2. The file sets `set local lock_timeout = '3s'` and `set local statement_timeout = '30s'` first.
3. `NNNN.down.sql` drops exactly what the up added — a column, never a table.
4. The Drizzle mirror is updated in the same PR; readers that do not select the column are untouched.
5. CI: `up`, `down`, `up` on Testcontainers; `lintSchema` reports zero violations; the request-loop
   test in `tests/regression/legacy-080.test.ts` records zero non-2xx.

## Between the two PRs
6. Deploy. Both shapes are now valid: old readers ignore the column, new readers use it.
7. If the column replaces an old one, the writer **dual-writes** both for one full release, and a
   backfill job (never a migration — hazard 10) fills the history in bounded batches.
8. Wait until no deployed client selects the old shape. The evidence is the OpenAPI document of the
   oldest still-deployed API version plus the desktop app's minimum supported build.

## Contract (a later PR, a later slice)
9. Confirm step 8 in writing in the PR body. This is the only step with no automated check.
10. One migration, one drop, the same two `set local` lines, its own hand-written down file
    (which re-adds the column as nullable — it cannot restore data, and says so in a comment).
11. Re-run test 25. Update `packages/db/test/privileges.test.ts` only if a grant actually changed
    (hazard 25 — outside 2B, it should not).

## For `app.document.notes` specifically
The expand half is `0027_expand_document_add_notes.sql` (2C). **There is nothing to contract**: the
column replaced no earlier column, so no later PR is owed. It stands as the worked example, and this
runbook is what the first real contract PR follows.
```

- [ ] **Step 7: Run everything**

Run: `bun run --cwd packages/db test -- test/expand-contract.test.ts test/print-render.test.ts test/privileges.test.ts && bun run --cwd tests test -- regression/legacy-080.test.ts && bun run --cwd packages/db typecheck`
Expected: PASS — 6 expand/contract tests (including the reversibility round trip), the two new print assertions, the privilege list unchanged, and the two LEGACY-080 blocks.

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0027_expand_document_add_notes.sql packages/db/migrations/0027.down.sql \
        packages/db/src/schema/document.ts packages/db/src/print/template.ts \
        packages/db/test/expand-contract.test.ts packages/db/test/print-render.test.ts \
        packages/db/test/privileges.test.ts tests/regression/legacy-080.test.ts \
        docs/adr/0033-expand-contract-live-tables.md docs/runbooks/expand-contract.md
git commit -m "feat(db): 0027 expand document.notes — zero-downtime demonstrated, not claimed [2C T11]

Acceptance test 25 (spec:2443) against LEGACY-080 (spec:872). Nullable, DEFAULT-less, catalogue-only.
"No maintenance window" is asserted as zero non-2xx in a request loop spanning up(); "proportional
to the change, not the data" as a RATIO across two row counts, because a wall-clock bound proves
nothing. lock_timeout lives in the FILE, so Plan 0A's runner stays frozen. The contract half is a
later PR and docs/runbooks/expand-contract.md is its checklist.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: OD-24 — the document list and entry screens (isolated; blocked on the owner, not blocking the slice)

**Owner decision OD-24** (contracts §2.12; spec:79, 108, 2408): *screenshots of the legacy screens plus a two-minute operator description, before any screen is built.* spec:79 and spec:108 say the user interface is **not specified** and hazard 29 forbids a plan from inventing a workflow. This task is therefore **one isolated task**, and it is the only task in this plan that can be dropped.

**Owner provides:** screenshots of the legacy document list and document entry screens (any module), and a two-minute recorded or written description of how an operator actually works them — the order fields are filled, what is typed versus chosen, which keys are used, what is printed and when.
**Verify:** `ls docs/owner/od-24/` lists at least one image per screen and `docs/owner/od-24/document-entry.md` exists and is non-empty:

```bash
test -s docs/owner/od-24/document-entry.md && ls -1 docs/owner/od-24/*.png | wc -l
```

Expected: a count of at least 2, and the description printing non-empty.
**Until provided:** this task does not run. The components below are written to the shape the API already dictates — the list is the fields `GET …/documents` returns, the form is the fields `POST …/documents` and `PUT …/documents/{id}/lines` accept — so nothing here is an invented workflow, and nothing later in this plan imports it. **Tasks 0–11 and 13 are unaffected:** Task 13's exit gate lists this task's screens as *blocked on OD-24*, exactly as 0E's user screen did, and Phase 2's definition of done contains no screen clause (spec:2288).

**What changes if the owner's answer differs.** The field *set* comes from the API and will not change. The owner's answer changes the **order** of fields in `DocumentForm`, which of them get keyboard shortcuts, whether the line grid is entered row-first or column-first, and whether printing is a button on the form or an action on the list row. Each is a prop or a re-order inside these six files; no route, no schema and no permission changes.

**Files:**
- Create: `apps/backoffice/src/routes/documents/index.tsx`, `apps/backoffice/src/routes/documents/$documentId.tsx`, `apps/backoffice/src/features/documents/DocumentTable.tsx`, `DocumentForm.tsx`, `AttachmentPanel.tsx`, `PrintButton.tsx`, `apps/backoffice/test/documents.test.tsx`, `tests/e2e/documents.spec.ts`
- Modify: `packages/i18n/src/catalogues/en.json`, `packages/i18n/src/catalogues/ar.json`, `apps/backoffice/src/router.tsx` (the route tree gains the two routes), `apps/backoffice/src/lib/admin-api.ts` (the three binary members of Step 4)

**Interfaces:**
- Consumes: `DataGrid`, `Column`, `Button`, `TextField`, `Select`, `useDirection` from `@dulja/ui` (0E Task 4); `createAdminApi`, `useShell`, `useSession` (0E Tasks 5, 6); `formatTimestamp`, `formatMoney` from `@dulja/i18n` (0E Task 2); `DocumentSchema`, `DocumentList`, `TransitionBody` (1A, 2B); `AttachmentSchema`, `AttachmentList` (Task 3); `PrintDocumentBody` (Task 9).
- Produces: no exported interface — four components and two routes. **The `documents.*` i18next key namespace** is a contract addition.

- [ ] **Step 1: Confirm the gate before writing a line**

Run the verify command above. If it fails, stop: mark the task blocked in the PR, and proceed to Task 13. **Do not build a screen against a guess** (hazard 29).

- [ ] **Step 2: Write the failing component test**

`apps/backoffice/test/documents.test.tsx`:

```tsx
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DirectionProvider } from "@dulja/ui";
import { AppShell } from "../src/components/app-shell";
import { DocumentTable } from "../src/features/documents/DocumentTable";
import { DocumentForm } from "../src/features/documents/DocumentForm";

// Both fixture rows are JOURNAL on purpose. Task 10's zero-code assertion sweeps `**/src/**` only,
// but keeping a test-only document-type literal out of a UI fixture costs nothing and removes the
// one way a later widening of that sweep could turn a green invariant red for no real reason.
const ROWS = [
  { id: "0192aaaa-0000-7000-8000-000000000001", documentTypeCode: "JOURNAL", series: "JV", number: 3,
    status: "posted", effectiveDate: "2026-03-01", currency: "MYR", partyName: null, total: "150.0000" },
  { id: "0192aaaa-0000-7000-8000-000000000002", documentTypeCode: "JOURNAL", series: "JV", number: 4,
    status: "draft", effectiveDate: "2026-03-15", currency: "MYR", partyName: "Consignor A", total: "90.0000" },
];

/**
 * **The wrapper is `<AppShell>`, not a bare `DirectionProvider`.** 0E's back-office has no `react-i18next`
 * `I18nextProvider` and `apps/backoffice/test/setup.ts` is exactly `import "@testing-library/jest-dom/vitest";`
 * (0E:2260–2264) — no i18n init at all. 0E's translation seam is `useShell()` from `src/components/app-shell`
 * (`{ locale, setLocale, t }`), which `AppShell` fills from `await createI18n({ locale })`; that is what 0E's
 * own `UsersRoute` test wraps with (0E:3348–3356), and the components below use the same hook.
 *
 * Two consequences the assertions depend on: `AppShell` **renders `null` until `createI18n()` resolves**, so
 * every case awaits the shell before touching the DOM; and `AppShell` mounts its own
 * `DirectionProvider locale="en"`, so the Arabic case nests a second one — `DirectionProvider` is exported
 * from `@dulja/ui` (0E Task 4) and the inner value wins for the subtree under test. Labels stay English in
 * the `ar` case, which is fine: that case asserts DIRECTION, and the catalogue-completeness checker (0E
 * Task 1) is what proves the Arabic strings exist.
 */
const wrap = async (locale: "en" | "ar", node: React.ReactNode) => {
  const result = render(
    <AppShell>
      <DirectionProvider locale={locale}>{node}</DirectionProvider>
    </AppShell>,
  );
  await waitFor(() => expect(screen.getByRole("banner")).toBeInTheDocument());
  return result;
};

describe("DocumentTable — both directions, keyboard-first (spec:2253, spec:2254)", () => {
  it("renders one row per document with its series and number", async () => {
    await wrap("en", <DocumentTable rows={ROWS} onOpen={() => {}} />);
    expect(screen.getAllByRole("row")).toHaveLength(3);           // header + two
    expect(screen.getByText("JV-3")).toBeInTheDocument();
    expect(screen.getByText("JV-4")).toBeInTheDocument();
  });

  it("sets dir=rtl on the grid in Arabic and never a physical text-align", async () => {
    const { container } = await wrap("ar", <DocumentTable rows={ROWS} onOpen={() => {}} />);
    expect(container.querySelector("[dir='rtl']")).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/text-align:\s*(left|right)/);
  });

  it("opens a row with Enter — no pointer needed (spec:2254)", async () => {
    const onOpen = vi.fn();
    await wrap("en", <DocumentTable rows={ROWS} onOpen={onOpen} />);
    // AppShell's own chrome (the skip link, the locale Select, the nav link) is focusable and comes first,
    // so the grid is reached by focusing it directly rather than by counting Tab stops.
    screen.getAllByRole("row")[1]!.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith(ROWS[0]!.id);
  });

  it("shows the status as a translated word, never a raw enum label", async () => {
    await wrap("en", <DocumentTable rows={ROWS} onOpen={() => {}} />);
    expect(screen.queryByText("posted")).toBeNull();
    expect(screen.getByText("Posted")).toBeInTheDocument();
  });
});

describe("DocumentForm — the fields the API accepts, in the owner's order", () => {
  it("submits exactly the POST …/documents body", async () => {
    const onSubmit = vi.fn();
    await wrap("en", <DocumentForm documentTypes={[{ code: "JOURNAL", nameEn: "Journal Voucher" }]}
                             branches={[{ id: "b1", name: "HQ" }]} onSubmit={onSubmit} />);
    await userEvent.selectOptions(screen.getByLabelText("Document type"), "JOURNAL");
    await userEvent.type(screen.getByLabelText("Effective date"), "2026-03-15");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(onSubmit).toHaveBeenCalledWith({
      documentTypeCode: "JOURNAL", effectiveDate: "2026-03-15", currency: "MYR", branchId: "b1",
      notes: "",
    });
  });

  it("keeps every amount a string — no input value is ever parsed to a number", async () => {
    const onSubmit = vi.fn();
    await wrap("en", <DocumentForm documentTypes={[{ code: "JOURNAL", nameEn: "Journal Voucher" }]}
                             branches={[{ id: "b1", name: "HQ" }]} onSubmit={onSubmit}
                             lines={[{ lineNo: 1, kind: "account", accountCode: "1000", debit: "10.0000", credit: "0.0000" }]} />);
    const grid = screen.getByRole("table", { name: "Lines" });
    expect(within(grid).getByDisplayValue("10.0000")).toBeInTheDocument();
  });
});
```

Run: `bun run --cwd apps/backoffice test -- test/documents.test.tsx`
Expected: FAIL — the two component modules do not exist.

- [ ] **Step 3: Write the four components**

`apps/backoffice/src/features/documents/DocumentTable.tsx`:

```tsx
import { DataGrid, useDirection, type Column } from "@dulja/ui";
import { useShell } from "../../components/app-shell";

export interface DocumentRow {
  id: string; documentTypeCode: string; series: string; number: number | null;
  status: string; effectiveDate: string; currency: string; partyName: string | null; total: string;
}

export interface DocumentTableProps {
  rows: readonly DocumentRow[];
  onOpen: (id: string) => void;
}

export function DocumentTable({ rows, onOpen }: DocumentTableProps) {
  const { t } = useShell();
  const { dir } = useDirection();

  // Column ORDER is the one thing OD-24 decides here; the set is what the API returns.
  const columns: Column<DocumentRow>[] = [
    { key: "reference", header: t("documents.column.reference"),
      render: (r) => (r.number === null ? t("documents.unnumbered") : `${r.series}-${r.number}`) },
    { key: "type", header: t("documents.column.type"), render: (r) => t(`documentType.${r.documentTypeCode}`, { defaultValue: r.documentTypeCode }) },
    { key: "date", header: t("documents.column.date"), render: (r) => r.effectiveDate },
    { key: "party", header: t("documents.column.party"), render: (r) => r.partyName ?? "" },
    // The amount arrives as a string and is displayed as a string. Nothing here parses money.
    { key: "total", header: t("documents.column.total"), align: "end", render: (r) => `${r.total} ${r.currency}` },
    { key: "status", header: t("documents.column.status"), render: (r) => t(`documents.status.${r.status}`) },
  ];

  return (
    <div dir={dir}>
      <DataGrid
        aria-label={t("documents.list.label")}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onActivate={(r) => onOpen(r.id)}
      />
    </div>
  );
}
```

`apps/backoffice/src/features/documents/DocumentForm.tsx`:

```tsx
import { useState } from "react";
import { Button, Select, TextField } from "@dulja/ui";
import { useShell } from "../../components/app-shell";

/**
 * The DRAFT shape the operator edits, not the wire body. An operator types an account **code**
 * ("1000"), never a uuid, so the form holds `accountCode`; the route component resolves each code to
 * the `accountId` 1A's `LineInput` requires before it POSTs. Sending `accountCode` to the API is a
 * 400 — `LineInput` is `accountId: UuidSchema` and nothing else.
 */
export interface DocumentLineDraft {
  lineNo: number; kind: string; accountCode: string; description?: string;
  debit: string; credit: string;
}
export interface DocumentFormProps {
  documentTypes: readonly { code: string; nameEn: string }[];
  branches: readonly { id: string; name: string }[];
  lines?: readonly DocumentLineDraft[];
  onSubmit: (body: {
    documentTypeCode: string; effectiveDate: string; currency: string; branchId: string; notes: string;
  }) => void;
}

export function DocumentForm({ documentTypes, branches, lines = [], onSubmit }: DocumentFormProps) {
  const { t } = useShell();
  const [documentTypeCode, setType] = useState(documentTypes[0]?.code ?? "");
  const [effectiveDate, setDate] = useState("");
  const [branchId, setBranch] = useState(branches[0]?.id ?? "");
  const [notes, setNotes] = useState("");

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit({ documentTypeCode, effectiveDate, currency: "MYR", branchId, notes }); }}
    >
      {/* Field order is OD-24's answer. Every field below is one the API accepts and no other. */}
      <Select label={t("documents.field.type")} value={documentTypeCode} onChange={setType}
              options={documentTypes.map((d) => ({ value: d.code, label: t(`documentType.${d.code}`, { defaultValue: d.nameEn }) }))} />
      <TextField label={t("documents.field.effectiveDate")} type="date" value={effectiveDate} onChange={setDate} required />
      <Select label={t("documents.field.branch")} value={branchId} onChange={setBranch}
              options={branches.map((b) => ({ value: b.id, label: b.name }))} />
      {/* migration 0027's column (Task 11); it prints through the template's {{ document.notes }}. */}
      <TextField label={t("documents.field.notes")} value={notes} onChange={setNotes} />

      <table aria-label={t("documents.lines.label")}>
        <thead>
          <tr>
            <th scope="col">{t("documents.column.line")}</th>
            <th scope="col">{t("documents.column.account")}</th>
            <th scope="col">{t("documents.column.description")}</th>
            <th scope="col">{t("documents.column.debit")}</th>
            <th scope="col">{t("documents.column.credit")}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineNo}>
              <td>{l.lineNo}</td>
              <td><input defaultValue={l.accountCode} aria-label={t("documents.column.account")} /></td>
              <td><input defaultValue={l.description ?? ""} aria-label={t("documents.column.description")} /></td>
              {/* inputMode decimal, type text: a number input would coerce money to a float. */}
              <td><input type="text" inputMode="decimal" defaultValue={l.debit} aria-label={t("documents.column.debit")} /></td>
              <td><input type="text" inputMode="decimal" defaultValue={l.credit} aria-label={t("documents.column.credit")} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <Button type="submit" variant="primary">{t("documents.action.saveDraft")}</Button>
    </form>
  );
}
```

`apps/backoffice/src/features/documents/AttachmentPanel.tsx`:

```tsx
import { useRef } from "react";
import { Button } from "@dulja/ui";
import { useShell } from "../../components/app-shell";

export interface AttachmentPanelProps {
  attachments: readonly { id: string; fileName: string; byteSize: number; createdAt: string }[];
  onUpload: (file: File) => Promise<void>;
  onDownload: (id: string, fileName: string) => Promise<void>;
}

export function AttachmentPanel({ attachments, onUpload, onDownload }: AttachmentPanelProps) {
  const { t } = useShell();
  const input = useRef<HTMLInputElement>(null);

  return (
    <section aria-label={t("documents.attachments.label")}>
      <ul>
        {attachments.map((a) => (
          <li key={a.id}>
            {/* The file NAME is display only. The object is addressed by its opaque id — LEGACY-038. */}
            <Button onClick={() => void onDownload(a.id, a.fileName)}>{a.fileName}</Button>
            <span>{t("documents.attachments.size", { bytes: a.byteSize })}</span>
          </li>
        ))}
      </ul>
      <input ref={input} type="file" aria-label={t("documents.attachments.choose")}
             onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f); }} />
    </section>
  );
}
```

`apps/backoffice/src/features/documents/PrintButton.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@dulja/ui";
import { useShell } from "../../components/app-shell";

export interface PrintButtonProps {
  /** Resolves to the PDF bytes; the caller owns the POST …/print call and its idempotency key. */
  print: (lang: "en" | "ar") => Promise<Blob>;
}

export function PrintButton({ print }: PrintButtonProps) {
  const { t, locale } = useShell();
  const [busy, setBusy] = useState(false);

  // Both directions are offered explicitly, never inferred from the UI locale alone: an operator
  // working in English routinely prints the Arabic copy for the customer (spec:2253).
  const run = async (lang: "en" | "ar") => {
    setBusy(true);
    try {
      const blob = await print(lang);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally { setBusy(false); }
  };

  return (
    <>
      <Button disabled={busy} onClick={() => void run(locale === "ar" ? "ar" : "en")}>
        {t("documents.action.print")}
      </Button>
      <Button disabled={busy} onClick={() => void run(locale === "ar" ? "en" : "ar")}>
        {t("documents.action.printOther")}
      </Button>
    </>
  );
}
```

- [ ] **Step 4: Wire the two routes**

`apps/backoffice/src/routes/documents/index.tsx` — the list, following 0E's `UsersRoute` exactly (0E:3502–3510): the `AdminApiOptions` and the `companyId` are **props**, injected so the screen is testable without a network, and `useShell()` supplies only `{ locale, setLocale, t }` — it has no `companyId` member and `useSession()` has no `apiBaseUrl`. The route file 0E's `router.tsx` builds supplies the real ones.

```tsx
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { DocumentList } from "@dulja/contracts";
import { createAdminApi, type AdminApiOptions } from "../../lib/admin-api";
import { DocumentTable } from "../../features/documents/DocumentTable";

export interface DocumentsRouteProps { api: AdminApiOptions; companyId: string }

export function DocumentsRoute({ api, companyId }: DocumentsRouteProps) {
  const navigate = useNavigate();
  const client = useMemo(() => createAdminApi(api), [api]);
  const documents = useQuery({
    queryKey: ["documents", companyId],
    queryFn: () => client.get(`/v1/companies/${companyId}/documents?limit=50`, DocumentList),
  });

  return (
    <DocumentTable
      rows={documents.data?.items ?? []}
      onOpen={(id) => void navigate({ to: "/documents/$documentId", params: { documentId: id } })}
    />
  );
}
```

`apps/backoffice/src/routes/documents/$documentId.tsx` — the entry screen composing the other three components; it holds the `POST …/print` call so `PrintButton` stays presentational:

```tsx
import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AttachmentList, DocumentSchema } from "@dulja/contracts";
import { createAdminApi, type AdminApiOptions } from "../../lib/admin-api";
import { AttachmentPanel } from "../../features/documents/AttachmentPanel";
import { PrintButton } from "../../features/documents/PrintButton";

export interface DocumentRouteProps { api: AdminApiOptions; companyId: string }

export function DocumentRoute({ api, companyId }: DocumentRouteProps) {
  const { documentId } = useParams({ from: "/documents/$documentId" });
  const queryClient = useQueryClient();
  const client = useMemo(() => createAdminApi(api), [api]);

  const document = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => client.get(`/v1/companies/${companyId}/documents/${documentId}`, DocumentSchema),
  });
  const attachments = useQuery({
    queryKey: ["attachments", documentId],
    queryFn: () => client.get(`/v1/companies/${companyId}/attachments?documentId=${documentId}`, AttachmentList),
  });

  return (
    <>
      <h1>{document.data ? `${document.data.series ?? ""}-${document.data.number ?? ""}` : ""}</h1>
      <PrintButton
        print={(lang) => client.postForBlob(
          `/v1/companies/${companyId}/documents/${documentId}/print`, { lang })}
      />
      <AttachmentPanel
        attachments={attachments.data?.items ?? []}
        onUpload={async (file) => {
          const form = new FormData();
          form.set("documentId", documentId);
          form.set("file", file);
          await client.postForm(`/v1/companies/${companyId}/attachments`, form);
          await queryClient.invalidateQueries({ queryKey: ["attachments", documentId] });
        }}
        onDownload={async (id, fileName) => {
          const blob = await client.getBlob(`/v1/companies/${companyId}/attachments/${id}/content`);
          const url = URL.createObjectURL(blob);
          const a = window.document.createElement("a");
          a.href = url; a.download = fileName; a.click();
          URL.revokeObjectURL(url);
        }}
      />
    </>
  );
}
```

`createAdminApi` gains three binary-aware members — `postForBlob(path, body)`, `postForm(path, formData)` and `getBlob(path)` — because 0E's client only knows Zod-validated JSON and neither a PDF nor a multipart upload is JSON. All three are one-liners over `fetch` with the same `Authorization` header and the same problem-JSON error path as `get`; they are recorded under *Contract additions*.

Register both routes in `apps/backoffice/src/router.tsx` the way 0E registers `usersRoute` (0E Task 6 Step 5, 0E Task 8 Step 5): a `createRoute` per path whose `component` is a local screen wrapper that supplies the two props from `useSession()`, `readEnv()` and `useCompanyId()`. **`useCompanyId` already exists** in `apps/backoffice/src/lib/session.tsx` (0E Task 8) — reuse it; do not add a second way to obtain the company.

```tsx
import { createRoute } from "@tanstack/react-router";
import { readEnv } from "./lib/env";
import { useCompanyId, useSession } from "./lib/session";
import { DocumentRoute } from "./routes/documents/$documentId";
import { DocumentsRoute } from "./routes/documents/index";

function DocumentsScreen() {
  const { accessToken } = useSession();
  const env = readEnv();
  const companyId = useCompanyId();
  return <DocumentsRoute api={{ baseUrl: env.apiBaseUrl, accessToken: () => accessToken }} companyId={companyId} />;
}

function DocumentScreen() {
  const { accessToken } = useSession();
  const env = readEnv();
  const companyId = useCompanyId();
  return <DocumentRoute api={{ baseUrl: env.apiBaseUrl, accessToken: () => accessToken }} companyId={companyId} />;
}

export const documentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/documents", component: DocumentsScreen });
export const documentRoute = createRoute({ getParentRoute: () => rootRoute, path: "/documents/$documentId", component: DocumentScreen });
```

and add both to the existing `routeTree`, appending to the array 0E's `rootRoute.addChildren([…])` already holds:

```tsx
export const routeTree = rootRoute.addChildren([indexRoute, usersRoute, documentsRoute, documentRoute]);
```

- [ ] **Step 5: Complete both i18next catalogues**

Every key both screens use, in `packages/i18n/src/catalogues/en.json` and `ar.json` — **both files, complete, before merge** (Global Constraint 14; the catalogue-completeness checker of 0E Task 1 fails the build on a missing pair):

```json
  "documents": {
    "list": { "label": "Documents" },
    "lines": { "label": "Lines" },
    "unnumbered": "Draft",
    "column": {
      "reference": "Reference", "type": "Type", "date": "Date", "party": "Party", "total": "Total",
      "status": "Status", "line": "#", "account": "Account", "description": "Description",
      "debit": "Debit", "credit": "Credit"
    },
    "field": { "type": "Document type", "effectiveDate": "Effective date", "branch": "Branch", "notes": "Notes" },
    "status": {
      "draft": "Draft", "submitted": "Submitted", "approved": "Approved", "issued": "Issued",
      "posted": "Posted", "void": "Void", "reversed": "Reversed"
    },
    "action": { "saveDraft": "Save draft", "print": "Print", "printOther": "Print other language" },
    "attachments": {
      "label": "Attachments", "choose": "Choose a file",
      "size": "{bytes, number, ::compact-short} B"
    }
  }
```

and the Arabic pair:

```json
  "documents": {
    "list": { "label": "المستندات" },
    "lines": { "label": "السطور" },
    "unnumbered": "مسودة",
    "column": {
      "reference": "المرجع", "type": "النوع", "date": "التاريخ", "party": "الطرف", "total": "الإجمالي",
      "status": "الحالة", "line": "#", "account": "الحساب", "description": "البيان",
      "debit": "مدين", "credit": "دائن"
    },
    "field": { "type": "نوع المستند", "effectiveDate": "تاريخ السريان", "branch": "الفرع", "notes": "ملاحظات" },
    "status": {
      "draft": "مسودة", "submitted": "مُقدَّم", "approved": "معتمد", "issued": "مُصدر",
      "posted": "مُرحَّل", "void": "ملغى", "reversed": "معكوس"
    },
    "action": { "saveDraft": "حفظ المسودة", "print": "طباعة", "printOther": "طباعة باللغة الأخرى" },
    "attachments": {
      "label": "المرفقات", "choose": "اختر ملفًا",
      "size": "{bytes, number, ::compact-short} بايت"
    }
  }
```

- [ ] **Step 6: Verify both directions in the browser (test 23's screen half)**

`tests/e2e/documents.spec.ts`, in 0E's Playwright project:

```ts
import { expect, test } from "@playwright/test";

for (const locale of ["en", "ar"] as const) {
  test(`the document list and entry screens render in ${locale}`, async ({ page }) => {
    await page.goto(`/documents?lng=${locale}`);
    const grid = page.getByRole("table", { name: locale === "ar" ? "المستندات" : "Documents" });
    await expect(grid).toBeVisible();
    await expect(page.locator("[dir]").first()).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");

    // Keyboard only: Tab to the first row, Enter to open it (spec:2254).
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("button", { name: locale === "ar" ? "طباعة" : "Print" })).toBeVisible();

    // No physical property leaked through a component (0E's PHYSICAL_PROPERTY_PATTERNS rule, at runtime).
    const offending = await page.evaluate(() =>
      [...document.querySelectorAll("*")].filter((el) => {
        const s = getComputedStyle(el);
        return s.textAlign === "left" || s.textAlign === "right";
      }).length);
    expect(offending).toBe(0);
  });
}
```

Run: `bun run --cwd apps/backoffice test && bun run e2e -- documents.spec.ts && bun run --cwd packages/i18n test`
Expected: PASS — 6 component tests, 2 end-to-end runs, and the catalogue-completeness checker green.

- [ ] **Step 7: Commit**

```bash
git add apps/backoffice/src/routes/documents apps/backoffice/src/features/documents \
        apps/backoffice/src/router.tsx apps/backoffice/src/lib/admin-api.ts \
        apps/backoffice/test/documents.test.tsx tests/e2e/documents.spec.ts \
        packages/i18n/src/catalogues/en.json packages/i18n/src/catalogues/ar.json \
        docs/owner/od-24
git commit -m "feat(backoffice): document list and entry screens, both directions [2C T12]

OD-24: built only after the owner's screenshots and operator description landed in
docs/owner/od-24/. Field SET comes from the API; field ORDER and the keyboard map come from the
owner. Amounts are strings in every input — inputMode decimal, never type=number. Attachments are
addressed by opaque id and the file name is display only (LEGACY-038). Print offers both languages
because an English-working operator prints the Arabic copy. Both catalogues complete.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Phase 2 exit — run the gate, re-run the shared tests, rewrite `CLAUDE.md`

2C is the last Phase 2 slice in execution order (2A → 2B → 2C), so §3.8 puts the "Current phase" rewrite here and spec:110 puts the written phase report here.

**Files:**
- Create: `docs/review/2026-09-05-phase-2-exit.md`
- Modify: `CLAUDE.md`, `tests/invariants/tenant-isolation.test.ts` (the two-table sweep and the route-to-probe pin of Step 2)

**Interfaces:**
- Consumes: every Phase 2 slice's CI status; `schemaFingerprint` (§4.1); `assertRouteGates` (§4.2.5); `PROBES`, `ROUTES` (§4.2.7).
- Produces: the written Phase 2 report spec:110 requires — *"Report per phase, in writing, against the definition of done — what passes, what does not, what you decided under ADR, what you are asking. Short."*

- [ ] **Step 1: Run the exit gate**

```bash
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test && bun run e2e
```

Expected: green. Then confirm each named test by file:

| Test | File | Owner |
|---|---|---|
| 10 Approval authority | `tests/invariants/sod.test.ts` | 2B |
| 12 Tenant isolation | `tests/invariants/tenant-isolation.test.ts` (now covering `attachment` and `print_template`) | 0B, extended here |
| 13 Audit completeness | `packages/db/test/attachment.test.ts` (uploads) + the chain-walk job | 0B, extended here |
| **15 New document type, zero code** | `tests/invariants/zero-code-document-type.test.ts` | **2C — Task 10** |
| 16 Numbering | `tests/invariants/numbering.test.ts` | 2B |
| 23 RTL/LTR parity | `tests/e2e/documents.spec.ts` + `apps/api/test/routes/accounting/print.test.ts` + `tests/regression/legacy-085.test.ts` | 0E, extended here |
| **25 Zero-downtime migration** | `packages/db/test/expand-contract.test.ts` + `tests/regression/legacy-080.test.ts` | **2C — Task 11** |
| 27 No SQL text across the API | `scripts/lint/rules/no-sql-concat.ts`, `no-bare-db` | 0B (CI) |
| 31 Segregation of duties | `tests/invariants/sod.test.ts` | 2B |
| 36 Role catalogue integrity | `tests/invariants/role-catalogue.test.ts` | 0D |

- [ ] **Step 2: Assert the two new tables are inside the shared harness, not beside it**

Add two cases to `tests/invariants/tenant-isolation.test.ts`, so no future slice can add a table that skips the sweep. **Test 36 (role catalogue integrity, 0D) is not touched:** it checks that every `ROLES` entry names a catalogue code, and this slice adds no permission code and no role — it is re-run unchanged by the gate above, not extended.

```ts
  it("covers every app table that 2C added", async () => {
    for (const table of ["attachment", "print_template"]) {
      const [row] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relrowsecurity, relforcerowsecurity from pg_class
         where oid = ${`app.${table}`}::regclass`;
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      const [policy] = await db.admin<{ polname: string }[]>`
        select polname from pg_policy where polrelid = ${`app.${table}`}::regclass`;
      expect(policy!.polname).toBe("tenant_isolation");
    }
  });
```

And pin the route/probe counts so a route added without a probe cannot merge (hazard 31):

```ts
  it("every route module has a probe — including the two 2C added", () => {
    const paths = ROUTES.map((r) => r.path);
    expect(paths).toContain("/v1/companies/:companyId/attachments");
    expect(paths).toContain("/v1/companies/:companyId/print-templates");
    for (const p of paths) expect(Object.keys(PROBES)).toContain(p);
  });
```

- [ ] **Step 3: Confirm the schema fingerprint round-trips over 0025–0027**

**There is nothing to re-pin, and there is no `packages/db/test/schema-fingerprint.test.ts`.** `schemaFingerprint(sql)` is a function exported from **`packages/db/test/privileges.test.ts`** (plan0A:2445–2456, extended by 0B per §3.4.6), and §3.4.6's test compares the fingerprint **to itself across `up → down → up`** — it holds no expected constant, so a new migration cannot make it stale. What must be confirmed is that the three new down files are complete: a `down` that forgets a trigger, a policy, a grant or an enum label leaves a different fingerprint and fails there.

```bash
bun run --cwd packages/db test -- test/privileges.test.ts
```

Expected: PASS — the generalised `up → down → up` reproduces the fingerprint byte for byte with 0025, 0026 and 0027 applied, and the five-member DELETE list Task 11 Step 4 appended is unchanged. **Read the failure rather than editing anything if it is red:** a fingerprint difference here names the down file that is incomplete, which is exactly the signal §3.9's "reversible" clause exists to give. This step modifies no file.

- [ ] **Step 4: Rewrite the "Current phase" section of `CLAUDE.md`**

§3.8 assigns the rewrite to the last slice of a phase. Replace the section 2A/2B left with:

```markdown
## Current phase

**Phase 2 is complete** (slices 2A policy engine + parties, 2B state machine + numbering,
2C templates + attachments + zero-code proof). Definition of done, both clauses green:
*a new document type is added with zero code* (acceptance test 15 —
`tests/invariants/zero-code-document-type.test.ts`) and *issued numbers are unique and
gapless-provable* (`app.series_gaps` returns zero rows; test 16).

Migrations applied through **0027**. ADRs through **0033**. Acceptance tests passing:
10, 11, 12, 13, 14, 15, 16, 23, 25, 27, 31, 36.

**Next: Phase 3 (inventory), slice 3A** — item master, units, warehouses, lots, prices, movements,
stock on hand. Migrations 0028–0033, ADRs 0034–0036. 3A's first task in the attachment area adds the
`inventory` row of the §4.5.8 download map (`inventory → inventory.stock.read`, lot →
`inventory.item.read`); 2C shipped the `accounting` row and a default deny, so a `pos` or `hr`
attachment download refuses until 6D and 8B add their rows. That is the safe direction and needs no
compensating work.

**Blocked on the owner:** OD-24 (screenshots + operator description) gates every screen task,
including 2C's document screens. OD-05 through OD-08 gate Phase 3's conditional items.
```

- [ ] **Step 5: Write the phase report**

`docs/review/2026-09-05-phase-2-exit.md`:

```markdown
# Phase 2 exit report

**Definition of done** (spec:2288, verbatim): "A new document type is added with zero code; issued
numbers are unique and gapless-provable."

## What passes
- **"A new document type is added with zero code."** `CONSIGNMENT_RETURN` is three files of
  configuration — a §4.3.7 envelope, a template manifest, a template body — posted through
  `POST …/document-types`, `…/policies` and `…/print-templates`. It numbers (CR-1), posts (two
  balanced entries pinned to its policy version), prints (both directions from one template row),
  appears in 1B's `accounting.ledger` report under its own type code, and reverses into a second
  `CONSIGNMENT_RETURN` with the sides swapped. The seventh assertion is the sentence itself: the
  literal `CONSIGNMENT_RETURN` occurs in no file under `apps/` or `packages/`, and the task's git
  diff touches `tests/` only. Acceptance test 15.
- **"Issued numbers are unique and gapless-provable."** 2B's; re-asserted here for the `CR` series.
- **Acceptance test 25.** Migration 0027 adds `document.notes` while a request loop records zero
  non-2xx responses, and the same migration's duration is flat across a tenfold difference in row
  count. ADR 0033 fixes what "zero downtime" is asserted to mean; the runbook governs the contract
  half.
- **Two tables**, `app.attachment` and `app.print_template`, both under the isolation harness, the
  audit trigger and the catalogue check. Attachment object keys are `<tenant_id>/<id>` from a
  server-minted `uuidv7` and are never derived from client input (LEGACY-038, `tests/regression/legacy-038.test.ts`).
- **Re-runs green:** 13 (uploads audited), 23 (PDFs in both directions, at the text layer),
  12 and 36 for both new tables.

## What does not pass
- **Nothing in the definition of done.** One task is **blocked**, not failing: Task 12, the document
  list and entry screens, awaits **OD-24**. Phase 2's definition of done contains no screen clause
  (spec:2288), so the phase exits; the screens land in the PR that follows the owner's answer.

## Decided under ADR
- **0031** attachment storage: opaque server-generated keys and an `ObjectStore` port — written as a
  **proposal** (it touches security and the data model, spec:95).
- **0032** print-template source format and the engine value set. Notably: `react-pdf` keeps its place
  in migration 0026's CHECK, because ADR 0016 owns that vocabulary and hazard 30 forbids narrowing it,
  and has **no adapter**, because it renders a React component rather than template text. That is what
  `ERR_PRINT_ENGINE_UNSUPPORTED` — this slice's one new error code — exists to say.
- **0033** expand/contract on a live table, and the two operational definitions test 25 needs.

## What we are asking
1. **OD-24** — screenshots of the legacy document list and entry screens plus a two-minute operator
   description. It unblocks Task 12 and every later screen task.
2. **Confirm ADR 0016's Decision row is not `react-pdf`.** If it is, 2C's templates cannot ship: a
   React component is not a text-defined, diffable template (spec:1240). This is ADR 0016's own
   "no candidate passes" branch and needs an owner decision, not a plan change.
3. **Nothing else.** OD-05 through OD-08 are Phase 3's and are not asked here.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/review/2026-09-05-phase-2-exit.md \
        tests/invariants/tenant-isolation.test.ts
git commit -m "chore: Phase 2 exit — gate green, CLAUDE.md rewritten, report written [2C T13]

Both DoD clauses green: test 15 (zero-code document type) and gapless numbering. Test 25 green.
privileges.test.ts's up -> down -> up reproduces the fingerprint with 0025-0027 applied, so all
three down files are complete; the schema delta is exactly attachment, print_template and
document.notes. Task 12 (screens) is BLOCKED on OD-24, not failing — spec:2288 has no screen clause. Next: 3A,
which adds the inventory row of the §4.5.8 download map.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

### Against the contracts card (§2.3, 2C)

| Card line | Where it is delivered | Verdict |
|---|---|---|
| `app.attachment` (§4.5.8), opaque R2 key from the id, `sha256`, `byte_size`, `mime_type`, `document_id` | T1 (DDL verbatim), T2 (`objectKeyFor`, `MemoryObjectStore`, `R2ObjectStore`), T3 (service + upload) | ✅ |
| Download gated by the owning module's read code — **the `accounting` row and a default deny, no other row** | T4 (`MODULE_READ_CODE` holds exactly `accounting`; three tests assert the `accounting` row by name, deny-by-absence as a property over the unmapped modules, and that every row present names a real catalogue code — none of which a later slice's one-line addition falsifies) | ✅ |
| Every upload audited (test 13; spec:1067) | T1 (`attach_audit`), T3 (the audit assertion on upload), T13 (re-run) | ✅ |
| `app.print_template` (§4.5.9), text-defined, version-controlled, seeded from `packages/db/seed/my/templates/*.json` | T5 (DDL), T6 (source format), T7 (loader + files) | ✅ |
| Server-side PDF render through the ADR-0016 engine **in both text directions** (test 23) | T8 (adapters), T9 (the endpoint, asserted at the PDF text layer in `en` and `ar`) | ✅ |
| Test 15 end to end: `CONSIGNMENT_RETURN` as configuration — numbers, posts, prints, reports, reverses | T10 | ✅ |
| The fixture is `direction: inbound`, `inventory: { effect: "none" }`, `approval.post: accounting.journal.post` | T10 Step 1, and the paragraph explaining why the inventory shape is unvalidatable before 3C | ✅ |
| Expand/contract on the live `document` table with the zero-downtime check (test 25) | T11 (`0027`, the ratio test, the request-loop test) | ✅ |
| The contract step is a separate PR in a later slice (documented) | T11 (`docs/runbooks/expand-contract.md`) | ✅ |
| Back-office document list/entry screens, keyboard-first, both directions | T12, isolated on OD-24 | ✅ (blocked, by design) |
| Migrations 0025–0027, ADRs 0031–0033, owner gate OD-24 | T1, T5, T11; T2, T8, T11; T12 | ✅ |
| Owns tests **15** and **25**; re-runs 13, 23, 12/36 | T10, T11; T3/T13, T9/T12, T13 | ✅ |
| §3.0.4 row spec:1067 Attachments — "2 (service + document link)" | T3 (service), T1 (`document_id` link). 3A adds the lot link, 7C the export | ✅ |
| Creates `tests/regression/legacy-038.test.ts`; appends `— 2C` to `legacy-080` and `legacy-085` | T2, T11, T9 | ✅ |

### Against the skill

Fourteen tasks, Task 0 through Task 13, every heading at `### Task N:`. Each carries **Files**, **Interfaces** (Consumes / Produces with exact signatures), checkbox steps, a failing test **run before** the implementation with the expected failure text, the real implementation, a run-to-pass, and a commit ending in the required trailer. Task 0 is the contracts **verification** gate: its check is `scripts/check/contracts-2c-amendments.sh`, which exits 1 naming any of the eleven entries a stale checkout of the contracts document is missing. No task says "TBD", "TODO", "similar to Task N", "add appropriate error handling", and no task elides content it is responsible for producing; every migration is complete SQL with its down file, and every TypeScript block is the file's real content rather than a sketch. **No code block stands in for content with an ellipsis.** Where a step edits a file 0B, 0C or 0E owns — `ApiConfig`, `buildRoutes`, `startApi`'s return, `AppEnv["Variables"]`, `createApp`'s mount loop — the block shows only the lines being added and a sentence beside it names the insertion point and what must not be renamed or reordered, which is the boundary statement those edits need rather than a re-transcription of another slice's file. The header carries the *For agentic workers* line, Goal, Architecture, Tech Stack, Spec, the Assumptions block (§3.10) and Global Constraints; the File Structure names every path with the task that creates or edits it, and the Execution handoff follows this section.

### Things I checked because they are the usual way a plan of this shape goes wrong

1. **Task ordering versus migration 0027.** `PrintContext.notes` exists from T6, but `document.notes` only exists from T11. T8 therefore returns `notes: null` with a comment naming T11, and T11 replaces both the query and T8's placeholder assertion. Without that, T8's suite fails against a pre-0027 database and the plan would only work if executed out of order.
2. **The `engine` CHECK versus the adapter set.** Migration 0026 admits three ADR-0016 codes; this slice ships two adapters. That is a decision, recorded in ADR 0032 with its reason (`react-pdf` renders a component, not template text) and enforced by `engineFor` throwing the slice's one new error code — not an oversight. T13's phase report asks the owner to confirm ADR 0016's Decision row is not `react-pdf`, because if it is, templates cannot ship at all.
3. **PDF determinism.** Chromium embeds `CreationDate`, so no test asserts byte-identical PDFs. ADR 0032 pins determinism at the rendered-template-text layer and T9's assertions are structural (magic bytes, extracted text, label presence, column x-order). A plan that asserted byte equality here would fail on the first run and be "fixed" by deleting the assertion.
4. **Idempotency on a binary response.** 0B's middleware `JSON.parse`s the response body; a PDF parses as nothing, so a replay would have returned `null`. T9 adds `REPLAY_BY_RERUN` — the reservation, the request-hash check and `ERR_IDEMPOTENCY_IN_FLIGHT` are all unchanged, a replayed key re-runs the (write-free) handler, and the recorded row holds a descriptor rather than the bytes. The set's doc comment says a route that writes may never join it. **The other half of the same problem is the request hash on the way in.** `await c.req.text()` re-encodes a binary part as UTF-8 and corrupts every byte above 0x7f — but hashing the *wire bytes* instead is equally wrong and less obvious: `new Request(…, { body: formData })` generates a fresh random multipart boundary every time, so two retries that build the same form differ byte for byte and the second is refused as `ERR_IDEMPOTENCY_KEY_REUSED` (§4.2.9). T3 Step 7 therefore hashes the **parsed parts** — `[name, fileName, contentType, sha256(bytes)]`, sorted — and the middleware comment says in as many words that a boundary must never enter the digest. Hono caches the parsed form, so the handler's own `c.req.formData()` re-uses that parse and the bytes reach the store intact.
5. **The print gate.** `requireDocumentPermission(stage)` maps write stages only. §4.5.4 already states the rule for a document *read* — "membership + the type's module read code" — so printing reuses §4.5.8's `MODULE_READ_CODE` and lives in the same file, which keeps the map at one home for 3A to widen. Listing `accounting.ledger.read` statically on the POST route would trip `ERR_ROUTE_GATE_READONLY` at boot; that is noted in T9 Step 5. **The attachment LIST is gated on the same reasoning and needed two gates, not one.** §4.5.8 gates the download because attachment *identity* is a side channel, and the list returns `fileName`, `byteSize`, `sha256`, `uploadedBy` and `objectKey` for a caller-supplied `companyId` while RLS is only tenant-scoped — so T4 puts `requirePermission(PERMISSION["accounting.ledger.read"], { company: "path:companyId" })` on it (legal on a GET under R7) *and* filters rows through `readableModules()`, which is what keeps §4.14's test 32 true when 8B adds `hr → hr.payroll.read`. `listAttachments`' `modules` parameter is required rather than defaulted for exactly that reason: forgetting it is a type error, not a silent unfiltered list.
6. **Probes.** No new `PROBES` entry for the print route: `PROBES` is keyed by `RouteModule.path` and the route is a sub-path of 1A's `/v1/companies/:companyId/documents`. The two genuinely new modules (attachments, print-templates) got entries in T3/T4 and T7, and T13 pins the route-to-probe correspondence so a later slice cannot skip it (hazard 31).
7. **Plan 0A stays frozen.** T11's lock bounding is `set local lock_timeout` **inside the migration file**, legal in the transaction 0A's `up()` already opens. The alternative — teaching the runner about timeouts — would have meant editing a frozen plan.
8. **The `ERR_*` register.** The slice adds exactly one registry code, `ERR_PRINT_ENGINE_UNSUPPORTED`. The four `code` literals on `ObjectKeyError`, `AttachmentIntegrityError`, `TemplateSourceError` and `TemplateError` are internal discriminants — `packages/db` and `packages/domain` cannot import `AppError`, which is contracts §4.2.4's declared `PostingError` exception — and each is translated at the API boundary: `AttachmentIntegrityError` → `ERR_INTERNAL` (T4), `TemplateSourceError` and `TemplateError` → `ERR_VALIDATION_FAILED` (T7, T8), `ObjectKeyError` → the global handler's unmapped `ERR_INTERNAL` branch, since both its arguments are server-minted uuids and a throw is a server bug. T8 Step 4 states this in the file so a reviewer does not have to re-derive it.
9. **Shared namespaces.** Document-type codes: `CONSIGNMENT_RETURN` only, already in §4.14, test-only, never seeded. Account codes: **none** — every policy line resolves through `line.account`, so no `account: { code }` literal appears in this slice and §4.15 is untouched. Report codes and `DatasetId`: **none** — T10 reads 1B's existing route and T10's last test asserts `packages/contracts/src/accounting/reports.ts` gained nothing. `fixtures.ts` helpers: **none** — §4.17 assigns 2C none and hazard 9 forbids inventing one; every row the tests need comes from an existing helper or a file-local function.
10. **Every wire shape was read out of the plan that ships it, not assumed.** Five would have failed silently otherwise, and each is now written the way the owning plan actually defines it. 1A's `LineInput` takes **`accountId`**, never `accountCode`, and `CreateDocumentBody` carries `lines` (min 1) — so T9, T10 and the LEGACY-085 block create a document *with* its lines in one call and resolve codes to ids first; `PUT …/lines` is for replacement only. A `bigint` crosses the wire as a **string**, so T10 asserts `number: "1"` on both the transition result and 1B's `LedgerRowSchema.number` (`z.string().nullable()`). §4.17.1's `fullRegression(legacyDefect, heading, cases)` is **declarative** — a record of named cases receiving `{ api, a, b, expect }` — so the LEGACY-085 block is written to that signature and the two suites that must own a database (T10, and T11's rollback block) use `startApi()` instead. `sourceFiles(roots?)` returns **`SourceFile[]`** (`{ path, text, lines }`, path repo-relative) so T10 reads `.text` rather than the filesystem. `ReportCodeSchema` lives at **`packages/contracts/src/accounting/reports.ts`**, not at `src/reports.ts`.
11. **`postJournal` is not reachable from `packages/db/test`.** It is a root-tier helper (`tests/invariants/support/post-journal.ts`, 1B) and §3.1 forbids the crossing, while §4.17 assigns 2C no `fixtures.ts` helper and hazard 9 forbids inventing one. T8 therefore carries a **file-local** `postJournalLocal`, shaped like 1A's own `post.test.ts`, and it calls 2B's `grantCodes` — not optional, because 2B's R2 evaluates `approval.post` inside the posting transaction and `seedTenant` grants `s.human` nothing (§4.1, pinned).
12. **Two tests that could not fail were made deterministic.** T9's module-read refusal now uses a second tenant granted exactly `accounting.journal.create`, `accounting.journal.post` and `admin.company.manage` and **not** `accounting.ledger.read` — it can post and configure but not read, which isolates the gate to a single cause and pins the 403. And T11's LEGACY-080 block owns its instance rather than rolling migrations back on the tier-shared one, where a `down(…, 26)` would break every concurrently running file and, under hazard 14, unwind a parallel phase's 0028+ as well.
13. **`REPLAY_BY_RERUN` matches the concrete path, not a route pattern.** The idempotency middleware is registered with `app.use` in `createApp`, so `c.req.routePath` there is the middleware's own pattern and never the terminal handler's — a pattern comparison would have matched nothing, the replay would have returned the descriptor as a JSON body, and T9's replay test would have failed for a reason no executor could have diagnosed from the assertion. It is now a `{ method, path: RegExp }` list with `isReplayByRerun(c)` and four cases in 0B's own suite pinning what it does and does not match.
14. **T12's UI fixture uses `JOURNAL`, not `CONSIGNMENT_RETURN`.** `sourceFiles` does not exclude `test/` directories, so T10's zero-code sweep is scoped to `**/src/**` — the claim is about application code, and a UI test double naming a type says nothing about whether a release was needed. Scoping the sweep and keeping the literal out of the fixture are both done, so neither task can turn the other red.
15. **Two files are written by more than one task, and both were checked for scope, not just for content.** `apps/api/test/routes/accounting/attachments.test.ts` is created by T3 and *appended to* by T4, so T3 puts `upload()`, `problemOf`, the `api` / `a` / `b` bindings and the `beforeAll`/`afterAll` at **module scope** rather than inside its own `describe` callback — a `let` inside the first describe is block-scoped to it, and T4's sibling `describe` would be a TypeScript "Cannot find name 'api'" that no amount of re-reading T4 would explain. Vitest runs file-level hooks once around every suite in the file, so the two blocks still share one container and T4's fourteen-case count is what the file actually reports. `tests/support/pdf.ts` has the mirror-image risk: §4.17.1 calls `pdfText` "the ONE test-side PDF reader", so T9 Step 1 writes it there **first** and both readers — `apps/api`'s print suite and `tests/regression/legacy-085.test.ts` — import it, rather than one defining it inline and a later step promising to move it. `pdfjs-dist` is therefore a dev dependency of **both** workspaces that resolve the specifier, since a workspace resolving a package it does not declare is a phantom dependency that breaks the moment the hoist changes.
16. **Hazards.** No statutory rate, threshold or formula appears anywhere (1). No MyInvois or LHDN detail (2). Nothing assumes a Firebird version (3). The slice ships no report and defers none (4). OD-24 is one isolated task with a verify command and a stated local behaviour (5, 6, 29). No D1–D27 or §2.12 item is re-opened (7). Every 0A helper is cited by its exact name (8). No migration writes a per-tenant row — templates arrive through the seed pack or the API (10). No enum label is added; `engine`, `module` and `paper` are `text + CHECK` (11). `lint-schema.ts` set memberships are edited to exactly §3.5.3's declared state and nothing else (13). No number is renamed or borrowed and nothing asserts `max(version)` (14). `sql.unsafe` — and its transaction form `tx.unsafe`, which is the same function — appears nowhere in this slice: every column list in `packages/db/src/attachment/index.ts` and in the print-template routes is written out literally, and `document_type_code` is attached in TypeScript rather than bound into a `RETURNING` list (21). Nothing outside `packages/db/src/posting/` writes a ledger row — printing and attachments read (22). No handler inserts `document_event` (24). The DELETE grant list is re-asserted unchanged, and T11 says explicitly not to edit the expectation if it differs (25). No permission code is introduced or seeded (26). ADR 0016 is consumed and never re-evaluated (30). Every route has a probe (31). No literal enters a shared namespace unregistered (32). The slice seeds no policy naming an account code, so rule 33 does not engage. `CONSIGNMENT_RETURN`'s fixture is an envelope with `module` set explicitly, not a bare policy (34).

17. **The map's own test is widening-safe, because three separate slices widen the map.** `MODULE_READ_CODE` is built one row per slice and 8B raised the consequence: a case asserting `Object.keys(MODULE_READ_CODE)` equals `["accounting"]`, plus a loop asserting `inventory` / `pos` / `hr` are `undefined`, is falsified by **every** one of 3A's `inventory`, 6D's `pos` and 8B's `hr` — in whichever order Phases 3, 6 and 8 merge (spec:2301 allows any) — so the same edit would sit on three unrelated critical paths and a slice that skipped it would hide its new row behind a red `apps/api` suite. T4 Step 1 therefore asserts the `accounting` row **by name**, deny-by-absence as a **property** over whichever modules have no row yet, and that every row present names a code `PERMISSION` actually carries (checked against `PERMISSION` rather than a literal table, since `PERMISSION["inventory.stock.read"]` does not compile at 2C). All three stay true at every later state of the map, so the widening slices add a row and a positive case of their own and edit nothing here.

### Contract additions — every name this plan had to invent, for folding into the contracts document

**None of these is in the contracts document as of version 2026-09-07.** 3A consumes the first group (it adds `attachment.lot_id` and the `inventory` row of the download map), so that group must be folded in before 3A is written.

**The nine that cross a slice boundary are not left as a note: they are Task 0's gate**, which runs before Task 1 starts and refuses to pass until each is present in the contracts document — where the round-2 amendment pass (§4.18) has already landed them. The lists below are the *complete* inventory, including the names purely internal to 2C that Task 0 does not touch; the "Cross-slice edits" group at the end is exactly Task 0's scope, and each entry there names the section Task 0 greps.

**Attachments (T1–T4).** `objectKeyFor`, `ObjectKeyError`, `StoredObject`, `ObjectStore`, `MemoryObjectStore`, `R2ObjectStoreOptions`, `R2ObjectStore`, `objectStoreFromConfig`, `DocumentTypeModule`, `AttachmentRow`, `NewAttachment`, `createAttachment`, `getAttachment`, `listAttachments`, `readAttachmentContent`, `AttachmentIntegrityError`, `MAX_ATTACHMENT_BYTES`, `MODULE_READ_CODE`, `requireAttachmentRead`, `readableModules`, the contracts module `packages/contracts/src/accounting/attachment.ts` (`AttachmentSchema`, `UploadAttachmentBody`, `AttachmentQuery`, `AttachmentList`), and the route-module paths `/v1/companies/:companyId/attachments` and its `/{id}/content` sub-path.

**Printing (T6–T9).** `PrintTemplateMeta`, `TEMPLATE_FRONT_MATTER`, `parseTemplateSource`, `composeTemplateSource`, `TemplateSourceError`, `htmlEscape`, `typstEscape`, `TemplateError`, `renderTemplate`, `PrintModelLine`, `PrintModel`, `PrintContext`, `buildPrintModel`; `PrintTemplateRow`, `DEFAULT_TEMPLATE_CODE` (`"standard"`), `resolvePrintTemplate`, `loadPrintContext`, `RenderedDocument`, `renderDocumentSource`, `PrintError`; `PrintEngineCode`, `PdfEngine`, `PDF_ENGINES`, `PDF_MAGIC`, `engineFor`, `chromiumEngine`, `closeChromium`, `typstEngine`, `TYPST_BIN`; `requireDocumentModuleRead`; the contracts modules `accounting/print-template.ts` (`PrintEngineSchema`, `PaperSchema`, `PrintTemplateSchema`, `CreatePrintTemplateBody`, `PrintTemplateList`) and `accounting/print.ts` (`PrintLangSchema`, `PrintDocumentBody`, `PrintLang`); the route-module path `/v1/companies/:companyId/print-templates`.

**Seeding (T7).** `TemplateManifest`, `TEMPLATE_BODY_EXTENSION`, `templateFileNames`, `templatesLoader`, `readPackText`, `SUB_PACK_DIRECTORIES`, and **`SubPack`, `SUB_PACKS` and `PHASE_0_SUB_PACK_DIRECTORIES` each widened with `"templates"`** — `"document-types"` is already in all three, added by 1A with its own loader. Those edits are this plan's **half** of §4.18's **open item 1**, which §4.18 records as CLOSED in round 2 by both slices together: 1A ships `documentTypesLoader` as a `PackLoader`, registers it in `LOADERS` and widens `SubPack`/`SUB_PACKS`/`PHASE_0_SUB_PACK_DIRECTORIES`; T7 appends `templates` to the same three — §4.2.13's amendment settles that list as the required-presence one, "widened additively by each loader-owning slice" — and derives `assertPackShape`'s **allowed** set from `SUB_PACKS` rather than from that same list, so the required and allowed sets stop being one list and a shipped loader's directory stops exiting 3.

**Cross-slice edits to a 0B/0C/0E interface — these are Task 0's nine, and the round-2 amendment pass (§4.18) has already landed every one of them in the contracts document; Task 0 verifies and edits none.** Each bullet records the frozen text **as it stood when this plan was written**, which is what the amendment was needed against; the *item N* numbers are this list's own and match the gate's `need` entries.
- `AppDeps` gains a sixth member, `objectStore: ObjectStore` — §4.2.7 says in as many words "**`AppDeps` is five members, not three**", so a 3A writer reading the frozen text would build a five-member object. **Task 0 item 1**; T2 then makes the code edit.
- `startApi()` builds that sixth member and exposes it as `StartedApi.objectStore` — §4.2.12 says "builds the five-member `AppDeps`". **Task 0 item 2**; T2 makes the code edit.
- `AppEnv["Variables"]` gains `attachment` (T4) and `documentModule` (T9) — §4.2.3 registers `AppEnv`. **Task 0 item 3.**
- `ERR_PRINT_ENGINE_UNSUPPORTED` (422) is absent from §4.2.4's allocated table, which itself states "a slice that needs a code absent from this table amends this table first". **Task 0 item 4**; T8 then adds the `ERRORS` row in the same PR that raises it.
- `ApiConfig` and `containerSecrets` gain four R2 names (T2) — §3.11 registers the env/secret space. **Task 0 item 5.**
- `idempotency` gains `REPLAY_BY_RERUN`, `isReplayByRerun`, binary-descriptor recording and parts-based multipart hashing (§4.2.9). **Task 0 item 6**; T3 and T9 make the code edits.
- `SubPack`, `SUB_PACKS` and `PHASE_0_SUB_PACK_DIRECTORIES` each widen with `"templates"` (1A already added `"document-types"` to all three) and `assertPackShape` derives its **allowed** set from `SUB_PACKS` while keeping `PHASE_0_SUB_PACK_DIRECTORIES` as the **required** one (§4.2.13, and its round-2 settlement that keeps the const's spelling and amends its meaning) — the second half of what closes §4.18's open item 1, 1A's loader and union widening being the first. **Task 0 item 7**; T7 makes the code edit.
- §4.17.1's shared-helper register gains `pdfText` in `tests/support/pdf.ts` (T9). **Task 0 item 8.**
- §4.5.9 gains `check (version > 0)` and `check (paper in ('A4','A5','receipt'))`, and registers `A4 | A5 | receipt` as a closed vocabulary against §4.11.1's `layout.paper`. **Task 0 item 9**; T5 writes the migration.

**Two additions that do NOT cross a slice boundary and so are not in Task 0**, listed here so the catalogue can fold them in with the rest: `createAdminApi` gains `postForBlob`, `postForm` and `getBlob` (T12 — 0E's client is JSON-only, and §4 registers no front-end interface), and the `documents.*` i18next key namespace (T12). Both live inside `apps/backoffice`, which no other slice consumes, and both are in the OD-24-gated task.

### One observation the catalogue should hear

**This slice is over the line ceiling in substance, not in task count.** §2.0 prices a task at ~246 lines (Plan 0A's grain) and warns that "a plan whose draft passes ~3,700 lines while tasks remain unwritten is over the ceiling". This plan is 14 tasks and ~7,000 lines — roughly 500 lines a task, about double the reference grain (Task 0 is the contracts verification gate and carries no code, so the code tasks are heavier still). The cause is visible in the File Structure: the slice carries **two tables, four new route modules' worth of surface, a pure rendering package, a seed loader, two engine adapters, an acceptance test that drives eleven endpoints, a live-table migration with two operational proofs, and six React components** — the card's Delivers list is the longest of any Phase 2 slice against an 11–13 task bound. No task is padded and none contains a placeholder; the honest reading is that 2C is nearer 18 tasks of work at Plan 0A grain than 13. **The natural split point, if the catalogue wants one, is between Task 7 and Task 8: `2C` keeps Task 0's verification gate plus attachments and the print-template *data* (T0–T7, migrations 0025–0026, ADRs 0031–0032), and `2C′` takes rendering, the endpoint, test 15, the expand/contract demonstration, the screens and the phase exit (T8–T13, migration 0027, ADR 0033).** Task 0 stays with the first half whole and keeps all eleven `need` entries: the `pdfText`, `AppEnv["Variables"].documentModule` and `ERR_PRINT_ENGINE_UNSUPPORTED` entries verify names the second half compiles against, but the gate is one script over one frozen document and reads the same checkout for both halves — splitting it into two partial greps would let `2C′` start against a stale copy that `2C`'s run had already cleared. Both halves are independently mergeable, the seam is a string (`print_template.source`), and 3A depends on the attachment half only. This plan does **not** make that split — the catalogue owns slice boundaries (§2.0) — it records the measurement so the amendment can be made in one PR.

---

## Execution handoff

**Read first, in this order.** `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` §2.3's 2C card, all of §3, §4.1, §4.2, §4.5.8, §4.5.9, §4.3.4, §4.14, §5 and your rows in §6.1/§6.2. Then this plan's header and Global Constraints. Then, for whatever you are about to touch, the *Produces* block of the plan that shipped it — 0B (API core), 0C (seed CLI, R2), 0D (`Money`, jobs), 0E (ADR 0016, `packages/ui`, `packages/i18n`), 1A (posting service), 1B (reports), 2A (policy engine, document types), 2B (lifecycle, numbering). **Never redefine what one of those exports.**

**Before Task 0.** Confirm the phase gate: 2A and 2B merged, Phase 1's definition of done green in CI, **0E merged** (ADR 0016 exists and its Verdict table is filled — this plan cannot start against an empty table) and **0C merged** (the `ATTACHMENTS` R2 binding, `infra/wrangler.jsonc`, the seed CLI and its `PackLoader` seam).

**Before Task 1: Task 0's gate is green.** Nine registry entries this slice's interfaces depend on were absent from the frozen contracts document when this plan was written, and the round-2 amendment pass (§4.18) has since landed all nine — `AppDeps`' sixth member, `ERR_PRINT_ENGINE_UNSUPPORTED`, `SubPack`'s two new members and §4.5.9's `paper` value set among them. §3.10 requires the document to be the authority, so Task 0 **verifies** rather than amends: `bash scripts/check/contracts-2c-amendments.sh` must exit 0 before any code task starts, and a `MISSING` line means the checkout is stale, not that the document may be edited. Then:

```bash
git switch -c feat/phase-2c-templates-attachments
bun install && bun run --cwd packages/db migrate:up && bun run test
```

Expected: green before you change anything. If it is not, fix that first — a red baseline makes every "expected: FAIL" in this plan unreadable.

**Order.** Strictly 0 → 13. The dependencies that make the order non-negotiable:

- **T0 before everything** — it is the contracts verification gate, and eight later tasks build on the round-2 names it proves present.
- **T2 before T3** — the service takes an `ObjectStore`.
- **T3 before T4** — the download map gates rows the upload creates.
- **T6 before T7 and T8** — both compose and parse the same `source`.
- **T8 before T9** — the endpoint is a thin wrapper over `renderDocumentSource` plus `engineFor`.
- **T7 and T9 before T10** — test 15 posts a template through T7's API and prints through T9's route.
- **T8 before T11** — T11 *replaces* T8's `notes: null` and its placeholder assertion. Doing T11 first leaves T8 with a test that cannot fail for the stated reason.
- **T12 last but one**, and only if OD-24 has landed. If it has not, mark it blocked and go to T13.

**Skill.** Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Every task is one commit; the message is `<type>(<scope>): <summary> [2C T<n>]` and ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**After every task**, at the repository root:

```bash
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
```

**Stop and raise, do not improvise**, if any of these is true:
1. **ADR 0016's Decision row names `react-pdf`.** Templates cannot ship: a React component is not text-defined and diffable (spec:1240). This is ADR 0016's own "no candidate passes" branch — an owner decision, not a plan change. Raise it before Task 5.
2. **ADR 0016's Verdict table is empty or its `Code` column differs from `typst | chromium | react-pdf`.** Migration 0026's CHECK is written *from that table*; write the codes it actually marks, and amend contracts §4.5.9 in the same PR.
3. **`packages/db/test/privileges.test.ts`'s DELETE list differs from `["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]`** at T11 — §3.5.4's five pinned rows in `order by table_name` order: Plan 0A's three (plan0A:2563) plus 2B's two (after 0023). Some slice granted DELETE outside hazard 25. Do not edit the expectation — report it against that slice.
4. **A name in *Contract additions* already exists in the repository with a different shape.** The contracts document is the authority; a collision means another slice invented one first. Amend the contracts document, then this plan, then the code. If the collision is on one of Task 0's nine — each of which the round-2 pass has already landed — Task 0 stops there and reports rather than overwriting the other slice's shape.
5. **You find yourself needing a permission code.** §3.6.1 closes the vocabulary and §3.6.2 gives 2C no row. A capability with no code uses §3.6.2's mapping; a genuinely new code is a contracts amendment, not a task.
6. **Any task grows past its Files list.** That is the over-ceiling signal the Self-Review measured. Stop and amend the catalogue (the split point is named there), rather than growing the plan.

**When Task 13 is green,** the PR body carries: the phase report at `docs/review/2026-09-05-phase-2-exit.md`, the three ADRs, the `git diff --stat` from Task 10 Step 4 showing that the zero-code task touched `tests/` only, and the two questions Task 13 Step 5 asks the owner (OD-24, and the ADR-0016 confirmation).
